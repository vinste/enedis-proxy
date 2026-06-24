const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');

const app = express();
app.use(cors());

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }
  return browser;
}

const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000;

function buildEnedisUrl(cp, street, city, insee, lat, lon, forceType) {
  const dept = String(insee || '').substring(0, 2);
  const cv = encodeURIComponent(`${city || ''} ${cp || ''}`.trim());
  const cityEnc = encodeURIComponent(city || '');
  const type = forceType || (street ? 'street' : 'municipality');
  const lonFixed = Number.parseFloat(lon).toFixed(6);
  const latFixed = Number.parseFloat(lat).toFixed(6);

  if (type === 'street' && street) {
    const a = encodeURIComponent(`${street} ${cp || ''} ${city || ''}`.trim());
    const s = encodeURIComponent(street);
    return `https://www.enedis.fr/resultat-panne-interruption?adresse=${a}&insee=${insee}&long=${lonFixed}&lat=${latFixed}&type=street&CPVille=${cv}&street=${s}&name=${s}&departement=${dept}&district=&city=${cityEnc}`;
  }

  const a = encodeURIComponent(city || '');
  return `https://www.enedis.fr/resultat-panne-interruption?adresse=${a}&insee=${insee}&long=${lonFixed}&lat=${latFixed}&type=municipality&CPVille=${cv}&street=&name=${cityEnc}&departement=${dept}&district=&city=${cityEnc}`;
}

function blankResult(bloc = 'indetermine') {
  return {
    nonCouvert: false,
    incident: false,
    travaux: false,
    vigilance: false,
    delestage: false,
    count: 0,
    dateRetablissement: null,
    bloc
  };
}

function rankResult(r) {
  if (!r) return 0;
  if (r.incident) return 60;
  if (r.travaux) return 50;
  if (r.vigilance) return 40;
  if (r.delestage) return 35;
  if (r.bloc === 'courant-retabli') return 20;
  if (r.bloc === 'aucune-coupure') return 10;
  if (r.nonCouvert) return 5;
  return 0;
}

function pickBestResult(a, b) {
  const ra = rankResult(a);
  const rb = rankResult(b);

  if (ra > rb) return a;
  if (rb > ra) return b;

  const aCount = a?.count || 0;
  const bCount = b?.count || 0;
  if (aCount > bCount) return a;
  if (bCount > aCount) return b;

  if (a?.dateRetablissement && !b?.dateRetablissement) return a;
  if (b?.dateRetablissement && !a?.dateRetablissement) return b;

  return a || b || blankResult();
}

function mergeResults(street, commune) {
  const s = street || blankResult('n/a');
  const c = commune || blankResult('n/a');

  const hasOperationalStatus =
    s.incident || s.travaux || s.vigilance || s.delestage ||
    c.incident || c.travaux || c.vigilance || c.delestage ||
    s.bloc === 'courant-retabli' || c.bloc === 'courant-retabli' ||
    s.bloc === 'aucune-coupure' || c.bloc === 'aucune-coupure';

  if (c.nonCouvert && !hasOperationalStatus) {
    return {
      ...c,
      scope: 'commune',
      blocStreet: s.bloc,
      blocCommune: c.bloc
    };
  }

  const best = pickBestResult(s, c);

  return {
    nonCouvert: false,
    incident: !!(s.incident || c.incident),
    travaux: !!(s.travaux || c.travaux),
    vigilance: !!(s.vigilance || c.vigilance),
    delestage: !!(s.delestage || c.delestage),
    count: best.count || s.count || c.count || 0,
    dateRetablissement: best.dateRetablissement || s.dateRetablissement || c.dateRetablissement || null,
    bloc: best.bloc || 'indetermine',
    blocStreet: s.bloc,
    blocCommune: c.bloc,
    scope: s.bloc && s.bloc !== 'n/a' ? 'street' : 'commune'
  };
}

async function scrapePage(page, url) {
  console.log(`[FETCH] ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });

  const RESULT_SELECTORS = [
    '[class*="bloc-incident"]',
    '[class*="bloc-travaux"]',
    '[class*="bloc-vigilance"]',
    '[class*="bloc-courant-retabli"]',
    '[class*="bloc-aucune-coupure"]',
    '[class*="bloc-de"]',
    '.js-modal-resultPanne'
  ];

  try {
    await page.waitForFunction((selectors) => {
      const isVisible = (el) => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none'
          && s.visibility !== 'hidden'
          && s.opacity !== '0'
          && !el.classList.contains('template-hidden')
          && !el.classList.contains('hidden');
      };

      return selectors.some((sel) => {
        const nodes = [...document.querySelectorAll(sel)];
        return nodes.some(isVisible);
      });
    }, RESULT_SELECTORS, { timeout: 12000 });
  } catch (e) {
    console.log(`[WARN] Timeout pour ${url.substring(0, 80)}`);
  }

  return await page.evaluate(() => {
    function isVisible(el) {
      if (!el) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none'
        && s.visibility !== 'hidden'
        && s.opacity !== '0'
        && !el.classList.contains('template-hidden')
        && !el.classList.contains('hidden');
    }

    function getText(el) {
      return (el?.innerText || el?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function pickVisible(sel) {
      const nodes = [...document.querySelectorAll(sel)];
      return nodes.find(isVisible) || null;
    }

    function getDate(bloc) {
      if (!bloc) return null;

      const dateNode = bloc.querySelector('.js-CoupureDate');
      const dateText = getText(dateNode);
      if (dateText) return dateText;

      const txt = getText(bloc);
      const patterns = [
        /rétablissement[^:]*:?\s*([^\n]{3,80})/i,
        /quand le courant sera-t-il rétabli\s*([^\n]{3,80})/i,
        /estimons un rétablissement le\s*([^\n]{3,80})/i
      ];

      for (const p of patterns) {
        const m = txt.match(p);
        if (m) return m[1].trim();
      }

      return null;
    }

    function getCount(bloc) {
      const txt = getText(bloc);
      const m = txt.match(/(\d[\d\s]*)\s*client/i);
      return m ? parseInt(m[1].replace(/\s/g, ''), 10) : 0;
    }

    function result(bloc, extra = {}) {
      return {
        nonCouvert: false,
        incident: false,
        travaux: false,
        vigilance: false,
        delestage: false,
        count: 0,
        dateRetablissement: null,
        bloc,
        ...extra
      };
    }

    const blocIncident = pickVisible('[class*="bloc-incident"]');
    if (blocIncident) {
      return result('incident', {
        incident: true,
        count: getCount(blocIncident),
        dateRetablissement: getDate(blocIncident)
      });
    }

    const blocTravaux = pickVisible('[class*="bloc-travaux"]');
    if (blocTravaux) {
      return result('travaux', {
        travaux: true,
        count: getCount(blocTravaux),
        dateRetablissement: getDate(blocTravaux)
      });
    }

    const blocVigilance = pickVisible('[class*="bloc-vigilance"]');
    if (blocVigilance) {
      return result('vigilance', {
        vigilance: true,
        count: getCount(blocVigilance),
        dateRetablissement: getDate(blocVigilance)
      });
    }

    const blocDelestage = [...document.querySelectorAll('[class*="bloc-de"]')]
      .find((el) => isVisible(el) && /d[ée]lestage/i.test(getText(el)));
    if (blocDelestage) {
      return result('delestage', {
        delestage: true,
        count: getCount(blocDelestage),
        dateRetablissement: getDate(blocDelestage)
      });
    }

    const blocRetabli = pickVisible('[class*="bloc-courant-retabli"]');
    if (blocRetabli) {
      return result('courant-retabli');
    }

    const blocAucune = pickVisible('[class*="bloc-aucune-coupure"]');
    if (blocAucune) {
      return result('aucune-coupure');
    }

    const modal = pickVisible('.js-modal-resultPanne');
    const modalText = getText(modal);

    if (/n[’']est pas g[ée]r[ée]e? par enedis|n['’]intervenons pas sur cette commune|zone g[ée]ographique n[’']est pas g[ée]r[ée]e? par enedis/i.test(modalText)) {
      return {
        nonCouvert: true,
        incident: false,
        travaux: false,
        vigilance: false,
        delestage: false,
        count: 0,
        dateRetablissement: null,
        bloc: 'non-couvert'
      };
    }

    return result('indetermine');
  });
}

app.get('/health', (_, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get('/enedis', async (req, res) => {
  const { cp = '', street = '', city = '', insee, lat, lon } = req.query;

  if (!insee || !lat || !lon) {
    return res.status(400).json({ error: 'insee, lat, lon requis' });
  }

  const cacheKey = `${insee}_${street}_${Math.floor(Date.now() / CACHE_TTL)}`;
  if (cache.has(cacheKey)) {
    console.log(`[CACHE] ${insee}`);
    return res.json(cache.get(cacheKey));
  }

  const urlStreet = street
    ? buildEnedisUrl(cp, street, city, insee, lat, lon, 'street')
    : null;
  const urlCommune = buildEnedisUrl(cp, street, city, insee, lat, lon, 'municipality');

  let page = null;

  try {
    const b = await getBrowser();
    page = await b.newPage();

    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Accept-Language': 'fr-FR,fr;q=0.9'
    });

    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,eot}', r => r.abort());

    let resultStreet = blankResult('n/a');
    if (urlStreet) {
      resultStreet = await scrapePage(page, urlStreet);
      console.log(`[STREET] ${insee} →`, JSON.stringify(resultStreet));
    }

    const resultCommune = await scrapePage(page, urlCommune);
    console.log(`[COMMUNE] ${insee} →`, JSON.stringify(resultCommune));

    const result = mergeResults(resultStreet, resultCommune);
    result.urlStreet = urlStreet;
    result.urlCommune = urlCommune;
    result.cachedAt = new Date().toISOString();

    console.log(`[MERGED] ${insee} →`, JSON.stringify(result));

    cache.set(cacheKey, result);
    return res.json(result);
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    return res.status(500).json({ error: err.message });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Proxy Enedis → http://0.0.0.0:${PORT}`);
});

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
