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
  const dept = insee.substring(0, 2);
  const cv = encodeURIComponent(`${city} ${cp}`.trim());
  const cityEnc = encodeURIComponent(city || '');
  const type = forceType || (street ? 'street' : 'municipality');

  if (type === 'street' && street) {
    const a = encodeURIComponent(`${street} ${cp} ${city}`.trim());
    const s = encodeURIComponent(street);
    return `https://www.enedis.fr/resultat-panne-interruption?adresse=${a}&insee=${insee}&long=${parseFloat(lon).toFixed(6)}&lat=${parseFloat(lat).toFixed(6)}&type=street&CPVille=${cv}&street=${s}&name=${s}&departement=${dept}&district=&city=${cityEnc}`;
  } else {
    const a = encodeURIComponent(city || '');
    return `https://www.enedis.fr/resultat-panne-interruption?adresse=${a}&insee=${insee}&long=${parseFloat(lon).toFixed(6)}&lat=${parseFloat(lat).toFixed(6)}&type=municipality&CPVille=${cv}&street=&name=${cityEnc}&departement=${dept}&district=&city=${cityEnc}`;
  }
}

async function scrapePage(page, url) {
  console.log(`[FETCH] ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });

  const RESULT_SELECTORS = [
    '[class*="bloc-incident"]',
    '[class*="bloc-travaux"]',
    '[class*="bloc-aucune-coupure"]',
    '[class*="bloc-courant-retabli"]',
    '[class*="bloc-vigilance"]',
    '.js-modal-resultPanne[style*="flex"]',
  ];

  try {
    await page.waitForFunction((selectors) => {
      return selectors.some(sel => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden'
          && !el.classList.contains('template-hidden')
          && !el.classList.contains('hidden');
      });
    }, RESULT_SELECTORS, { timeout: 12000 });
  } catch(e) {
    console.log(`[WARN] Timeout waitForFunction pour ${url.substring(0, 80)}`);
  }

  return await page.evaluate(() => {

    // ── MÉTHODE DE DÉTECTION CORRECTE ──────────────────────────────────────────
    // Enedis place TOUS les blocs dans le DOM en permanence.
    // Le bloc actif est celui dont le .tagStatus interne N'A PAS la classe
    // 'template-hidden'. Les blocs inactifs ont toujours 'template-hidden'.
    // getComputedStyle() ne suffit pas car les blocs parents sont tous visibles.
    // ──────────────────────────────────────────────────────────────────────────

    function isActive(blocEl) {
      if (!blocEl) return false;
      // Le tagStatus est l'indicateur d'état réel
      const tag = blocEl.querySelector('.tagStatus');
      if (tag) return !tag.classList.contains('template-hidden');
      // Fallback : le bloc lui-même ne doit pas avoir template-hidden
      return !blocEl.classList.contains('template-hidden');
    }

    function getDate(bloc) {
      if (!bloc) return null;
      const el = bloc.querySelector('.js-CoupureDate');
      if (el && el.innerText.trim()) return el.innerText.trim();
      const m = (bloc.innerText || '').match(/rétablissement[^:]*:\s*([^\n]{3,40})/i);
      return m ? m[1].trim() : null;
    }

    function getCount(bloc) {
      const m = (bloc && bloc.innerText || '').match(/(\d[\d\s]*)\s*client/i);
      return m ? parseInt(m[1].replace(/\s/g, ''), 10) : 0;
    }

    // non-couvert (modal spéciale — conserve l'ancienne détection)
    const modal = document.querySelector('.js-modal-resultPanne');
    if (modal && !modal.classList.contains('template-hidden') && !modal.classList.contains('hidden'))
      return { nonCouvert: true, incident: false, travaux: false, vigilance: false, delestage: false, count: 0, dateRetablissement: null, bloc: 'non-couvert' };

    // Ordre de priorité : incident > travaux > vigilance > délestage > courant-rétabli > aucune-coupure
    const blocIncident = document.querySelector('[class*="bloc-incident"]');
    if (blocIncident && isActive(blocIncident))
      return { nonCouvert: false, incident: true, travaux: false, vigilance: false, delestage: false, count: getCount(blocIncident), dateRetablissement: getDate(blocIncident), bloc: 'incident' };

    const blocTravaux = document.querySelector('[class*="bloc-travaux"]');
    if (blocTravaux && isActive(blocTravaux))
      return { nonCouvert: false, incident: false, travaux: true, vigilance: false, delestage: false, count: getCount(blocTravaux), dateRetablissement: getDate(blocTravaux), bloc: 'travaux' };

    // vigilance = alerte météo préventive, PAS des travaux
    const blocVigilance = document.querySelector('[class*="bloc-vigilance"]');
    if (blocVigilance && isActive(blocVigilance))
      return { nonCouvert: false, incident: false, travaux: false, vigilance: true, delestage: false, count: 0, dateRetablissement: getDate(blocVigilance), bloc: 'vigilance' };

    // délestage (bloc-de)
    const blocDe = document.querySelector('[class*="bloc-de"]');
    if (blocDe && isActive(blocDe))
      return { nonCouvert: false, incident: false, travaux: false, vigilance: false, delestage: true, count: getCount(blocDe), dateRetablissement: getDate(blocDe), bloc: 'delestage' };

    // courant rétabli
    const blocRetabli = document.querySelector('[class*="bloc-courant-retabli"]');
    if (blocRetabli && isActive(blocRetabli))
      return { nonCouvert: false, incident: false, travaux: false, vigilance: false, delestage: false, count: 0, dateRetablissement: null, bloc: 'courant-retabli' };

    return { nonCouvert: false, incident: false, travaux: false, vigilance: false, delestage: false, count: 0, dateRetablissement: null, bloc: 'aucune-coupure' };
  });
}

// FIX BUG 1 — priorité absolue à l'adresse précise (street) sur la commune
// La commune ne sert que de fallback si aucune rue n'a pu être scrapée
function mergeResults(streetResult, communeResult, hasStreetUrl) {
  // Si la commune est non couverte par Enedis, c'est définitif
  if (communeResult.nonCouvert) return { ...communeResult, scope: 'commune' };

  // Si on avait une URL street ET qu'elle a retourné un résultat exploitable,
  // on lui fait confiance entièrement — pas de OR avec la commune
  if (hasStreetUrl && streetResult.bloc !== 'n/a') {
    return { ...streetResult, scope: 'street', blocCommune: communeResult.bloc };
  }

  // Pas de street disponible : on utilise la commune seule
  return { ...communeResult, scope: 'commune', blocStreet: 'n/a' };
}

app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.get('/enedis', async (req, res) => {
  const { cp = '', street = '', city = '', insee, lat, lon } = req.query;
  if (!insee || !lat || !lon) return res.status(400).json({ error: 'insee, lat, lon requis' });

  // FIX BUG 3 — clé de cache incluant lat/lon arrondis pour éviter collisions intra-commune
  const latR = parseFloat(lat).toFixed(3);
  const lonR = parseFloat(lon).toFixed(3);
  const cacheKey = `${insee}_${street}_${latR}_${lonR}_${Math.floor(Date.now() / CACHE_TTL)}`;

  if (cache.has(cacheKey)) {
    console.log(`[CACHE] ${cacheKey}`);
    return res.json(cache.get(cacheKey));
  }

  const urlStreet  = street ? buildEnedisUrl(cp, street, city, insee, lat, lon, 'street') : null;
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

    let resultStreet = { nonCouvert: false, incident: false, travaux: false, vigilance: false, count: 0, dateRetablissement: null, bloc: 'n/a' };
    if (urlStreet) {
      resultStreet = await scrapePage(page, urlStreet);
      console.log(`[STREET]  ${insee} →`, JSON.stringify(resultStreet));
    }

    const resultCommune = await scrapePage(page, urlCommune);
    console.log(`[COMMUNE] ${insee} →`, JSON.stringify(resultCommune));

    const result = mergeResults(resultStreet, resultCommune, !!urlStreet);
    result.urlStreet  = urlStreet;
    result.urlCommune = urlCommune;
    result.cachedAt   = new Date().toISOString();

    console.log(`[MERGED]  ${insee} →`, JSON.stringify(result));

    cache.set(cacheKey, result);
    res.json(result);

  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Proxy Enedis → http://0.0.0.0:${PORT}`));
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
process.on('SIGINT',  async () => { if (browser) await browser.close(); process.exit(0); });
