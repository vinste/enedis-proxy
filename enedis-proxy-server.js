const express = require('express');
const chromium = require('playwright');
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
const CACHETTL = 2 * 60 * 1000;

function buildEnedisUrl(cp, street, city, insee, lat, lon, forceType) {
  const dept = String(insee || '').substring(0, 2);
  const cv = encodeURIComponent(`${city} ${cp}`.trim());
  const cityEnc = encodeURIComponent(city || '');
  const type = forceType || (street ? 'street' : 'municipality');

  if (type === 'street' && street) {
    const a = encodeURIComponent(`${street} ${cp} ${city}`.trim());
    const s = encodeURIComponent(street);
    return `https://www.enedis.fr/resultat-panne-interruption?adresse=${a}&insee=${insee}&long=${parseFloat(Number(lon).toFixed(6))}&lat=${parseFloat(Number(lat).toFixed(6))}&type=street&CPVille=${cv}&street=${s}&name=&departement=${dept}&district=&city=${cityEnc}`;
  }

  const a = encodeURIComponent(city || '');
  return `https://www.enedis.fr/resultat-panne-interruption?adresse=${a}&insee=${insee}&long=${parseFloat(Number(lon).toFixed(6))}&lat=${parseFloat(Number(lat).toFixed(6))}&type=municipality&CPVille=${cv}&street=&name=${cityEnc}&departement=${dept}&district=&city=${cityEnc}`;
}

async function oreCheck(insee) {
  if (!insee) return { covered: true, grd: '?' };
  try {
    const where = encodeURIComponent(`codeinseecommune="${insee}"`);
    const url = `https://opendata.agenceore.fr/api/explore/v2.1/catalog/datasets/distributeurs-denergie-par-commune/records?where=${where}&limit=1`;
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`ORE HTTP ${r.status}`);
    const d = await r.json();
    const rec = d.results?.[0];
    if (!rec) return { covered: true, grd: '?' };
    const codes = Array.isArray(rec.codegrdelec) ? rec.codegrdelec : [];
    const grds = Array.isArray(rec.grdelec) ? rec.grdelec : [];
    const covered = codes.includes('ENED');
    return { covered, grd: grds.join(',') || '?' };
  } catch (e) {
    console.warn('ORE check failed:', e.message);
    return { covered: true, grd: '?' };
  }
}

function nonCoveredPayload({ source, grd = '?', scope = 'commune', urlStreet = null, urlCommune = null, note = null }) {
  return {
    nonCouvert: true,
    incident: false,
    travaux: false,
    vigilance: false,
    delestage: false,
    count: 0,
    dateRetablissement: null,
    bloc: 'non-couvert',
    blocStreet: null,
    blocCommune: 'non-couvert',
    scope,
    source,
    grd,
    note,
    urlStreet,
    urlCommune
  };
}

async function scrapePage(page, url) {
  console.log('FETCH', url);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });

  const RESULT_SELECTORS = [
    '.classbloc-incident',
    '.classbloc-travaux',
    '.classbloc-aucune-coupure',
    '.classbloc-courant-retabli',
    '.classbloc-vigilance',
    '.js-modal-resultPanne[style*="flex"]'
  ];

  try {
    await page.waitForFunction(
      (selectors) => selectors.some((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && !el.classList.contains('template-hidden') && !el.classList.contains('hidden');
      }),
      RESULT_SELECTORS,
      { timeout: 12000 }
    );
  } catch (e) {
    console.log('WARN Timeout pour', url.substring(0, 80));
  }

  return await page.evaluate(() => {
    function isVisible(el) {
      if (!el) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && !el.classList.contains('template-hidden') && !el.classList.contains('hidden');
    }

    function norm(txt) {
      return (txt || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    }

    function getDate(bloc) {
      if (!bloc) return null;
      const el = bloc.querySelector('.js-CoupureDate');
      if (el && el.innerText.trim()) return el.innerText.trim();
      const m = bloc.innerText.match(/rétablissement(.{3,40})/i);
      return m ? m[1].trim() : null;
    }

    function getCount(bloc) {
      const m = bloc?.innerText?.match(/([\d\s]+) client/i);
      return m ? parseInt(m[1].replace(/\s/g, ''), 10) : 0;
    }

    function modalText(modal) {
      const h5 = modal?.querySelector('h5')?.innerText || '';
      const p = modal?.querySelector('p')?.innerText || '';
      return { title: h5.trim(), body: p.trim(), all: `${h5} ${p}`.trim() };
    }

    const modal = document.querySelector('.js-modal-resultPanne');
    if (modal && isVisible(modal)) {
      const txt = modalText(modal);
      const t = norm(txt.all);
      const isNonCovered =
        t.includes("cette zone geographique n'est pas geree par enedis") ||
        t.includes('cette zone geographique nest pas geree par enedis') ||
        t.includes("nous n'intervenons pas sur cette commune") ||
        t.includes('nous nintervenons pas sur cette commune');

      if (isNonCovered) {
        return {
          nonCouvert: true,
          incident: false,
          travaux: false,
          vigilance: false,
          delestage: false,
          count: 0,
          dateRetablissement: null,
          bloc: 'non-couvert',
          modalTitle: txt.title,
          modalBody: txt.body
        };
      }
    }

    const blocTravaux = document.querySelector('.classbloc-travaux');
    if (blocTravaux && isVisible(blocTravaux)) {
      return { nonCouvert: false, incident: false, travaux: true, vigilance: false, delestage: false, count: getCount(blocTravaux), dateRetablissement: getDate(blocTravaux), bloc: 'travaux' };
    }

    const blocIncident = document.querySelector('.classbloc-incident');
    if (blocIncident && isVisible(blocIncident)) {
      return { nonCouvert: false, incident: true, travaux: false, vigilance: false, delestage: false, count: getCount(blocIncident), dateRetablissement: getDate(blocIncident), bloc: 'incident' };
    }

    const blocVigilance = document.querySelector('.classbloc-vigilance');
    if (blocVigilance && isVisible(blocVigilance)) {
      return { nonCouvert: false, incident: false, travaux: false, vigilance: true, delestage: false, count: getCount(blocVigilance), dateRetablissement: getDate(blocVigilance), bloc: 'vigilance' };
    }

    const blocRetabli = document.querySelector('.classbloc-courant-retabli');
    if (blocRetabli && isVisible(blocRetabli)) {
      return { nonCouvert: false, incident: false, travaux: false, vigilance: false, delestage: false, count: 0, dateRetablissement: null, bloc: 'courant-retabli' };
    }

    return { nonCouvert: false, incident: false, travaux: false, vigilance: false, delestage: false, count: 0, dateRetablissement: null, bloc: 'aucune-coupure' };
  });
}

function mergeResults(street, commune) {
  if (commune.nonCouvert) {
    return {
      ...commune,
      scope: 'commune',
      blocStreet: street?.bloc || null,
      blocCommune: commune?.bloc || 'non-couvert'
    };
  }

  return {
    nonCouvert: false,
    incident: !!(street?.incident || commune?.incident),
    travaux: !!(street?.travaux || commune?.travaux),
    vigilance: !!(street?.vigilance || commune?.vigilance),
    delestage: !!(street?.delestage || commune?.delestage),
    count: street?.count || commune?.count || 0,
    dateRetablissement: street?.dateRetablissement || commune?.dateRetablissement || null,
    bloc: street?.bloc || commune?.bloc || 'aucune-coupure',
    blocStreet: street?.bloc || null,
    blocCommune: commune?.bloc || null,
    modalTitle: commune?.modalTitle || street?.modalTitle || null,
    modalBody: commune?.modalBody || street?.modalBody || null
  };
}

app.get('/health', (_, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get('/enedis', async (req, res) => {
  const { cp = '', street = '', city = '', insee, lat, lon } = req.query;
  if (!insee || !lat || !lon) return res.status(400).json({ error: 'insee, lat, lon requis' });

  const cacheKey = `${insee}|${street}|${Math.floor(Date.now() / CACHETTL)}`;
  if (cache.has(cacheKey)) {
    console.log('CACHE', insee);
    return res.json(cache.get(cacheKey));
  }

  const ore = await oreCheck(insee);
  if (!ore.covered) {
    const early = {
      ...nonCoveredPayload({ source: 'ore', grd: ore.grd, scope: 'commune', note: 'GRD hors Enedis — aucune requête Enedis effectuée' }),
      cachedAt: new Date().toISOString()
    };
    cache.set(cacheKey, early);
    return res.json(early);
  }

  const urlStreet = street ? buildEnedisUrl(cp, street, city, insee, lat, lon, 'street') : null;
  const urlCommune = buildEnedisUrl(cp, '', city, insee, lat, lon, 'municipality');

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Accept-Language': 'fr-FR,fr;q=0.9'
    });
    await page.route(/\.(png|jpg|jpeg|gif|webp|svg|woff|woff2|ttf|eot)$/i, r => r.abort());

    let resultStreet = { nonCouvert: false, incident: false, travaux: false, vigilance: false, delestage: false, count: 0, dateRetablissement: null, bloc: 'n/a' };
    if (urlStreet) {
      resultStreet = await scrapePage(page, urlStreet);
      console.log('STREET', insee, JSON.stringify(resultStreet));
    }

    const resultCommune = await scrapePage(page, urlCommune);
    console.log('COMMUNE', insee, JSON.stringify(resultCommune));

    const result = resultCommune.nonCouvert
      ? {
          ...nonCoveredPayload({
            source: 'enedis',
            grd: ore.grd,
            scope: 'commune',
            urlStreet,
            urlCommune,
            note: resultCommune.modalTitle || 'Cette zone géographique n\'est pas gérée par Enedis'
          }),
          modalTitle: resultCommune.modalTitle || null,
          modalBody: resultCommune.modalBody || null
        }
      : mergeResults(resultStreet, resultCommune);

    result.urlStreet = urlStreet;
    result.urlCommune = urlCommune;
    result.grd = ore.grd;
    result.oreCovered = ore.covered;
    result.cachedAt = new Date().toISOString();

    console.log('MERGED', insee, JSON.stringify(result));
    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('ERROR', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`Proxy Enedis http://0.0.0.0:${PORT}`));

process.on('SIGTERM', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit(0);
});
