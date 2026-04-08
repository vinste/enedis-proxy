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

function buildEnedisUrl(cp, street, city, insee, lat, lon) {
  const dept = insee.substring(0, 2);
  const cv = encodeURIComponent(`${city} ${cp}`.trim());
  const cityEnc = encodeURIComponent(city || '');
  if (street) {
    const a = encodeURIComponent(`${street} ${cp} ${city}`.trim());
    const s = encodeURIComponent(street);
    return `https://www.enedis.fr/resultat-panne-interruption?adresse=${a}&insee=${insee}&long=${parseFloat(lon).toFixed(6)}&lat=${parseFloat(lat).toFixed(6)}&type=street&CPVille=${cv}&street=${s}&name=${s}&departement=${dept}&district=&city=${cityEnc}`;
  } else {
    const a = encodeURIComponent(city || '');
    return `https://www.enedis.fr/resultat-panne-interruption?adresse=${a}&insee=${insee}&long=${parseFloat(lon).toFixed(6)}&lat=${parseFloat(lat).toFixed(6)}&type=municipality&CPVille=${cv}&street=&name=${cityEnc}&departement=${dept}&district=&city=${cityEnc}`;
  }
}

app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.get('/enedis', async (req, res) => {
  const { cp = '', street = '', city = '', insee, lat, lon } = req.query;
  if (!insee || !lat || !lon) return res.status(400).json({ error: 'insee, lat, lon requis' });

  const cacheKey = `${insee}_${Math.floor(Date.now() / CACHE_TTL)}`;
  if (cache.has(cacheKey)) {
    console.log(`[CACHE] ${insee}`);
    return res.json(cache.get(cacheKey));
  }

  const url = buildEnedisUrl(cp, street, city, insee, lat, lon);
  console.log(`[FETCH] ${url}`);

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();

    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
      'Accept-Language': 'fr-FR,fr;q=0.9'
    });

    // Bloquer images/fonts
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,eot}', r => r.abort());

    // ✅ Intercepter les requêtes JSON S3 Enedis
    const intercepted = [];
    page.on('response', async (response) => {
      const rUrl = response.url();
      if (rUrl.includes('/sites/default/files/json') && rUrl.includes('.json')) {
        try {
          const body = await response.json();
          intercepted.push({ url: rUrl, body });
          console.log(`[JSON] ${rUrl} →`, JSON.stringify(body).substring(0, 200));
        } catch(e) {
          console.log(`[JSON-ERR] ${rUrl}: ${e.message}`);
        }
      }
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });

    // Attendre un peu plus pour les appels asynchrones tardifs
    await page.waitForTimeout(3000);

    console.log(`[INTERCEPT] ${intercepted.length} fichiers JSON capturés pour ${insee}`);
    intercepted.forEach(i => console.log(`  → ${i.url}`));

    let result;

    if (intercepted.length > 0) {
      // Analyser les JSON interceptés
      let incident = false, travaux = false, nonCouvert = false, count = 0;

      for (const { url: jUrl, body } of intercepted) {
        const raw = JSON.stringify(body).toLowerCase();
        console.log(`[ANALYZE] ${jUrl}: ${raw.substring(0, 300)}`);

        // Détecter non couvert
        if (raw.includes('non couvert') || raw.includes('non_couvert') || raw.includes('not_covered')) {
          nonCouvert = true;
        }
        // Détecter travaux
        if (raw.includes('travaux') || raw.includes('work') || raw.includes('planned')) {
          travaux = true;
        }
        // Détecter incident
        if (raw.includes('incident') || raw.includes('panne') || raw.includes('unplanned') || raw.includes('coupure')) {
          incident = true;
        }
        // Nombre clients
        const mClient = raw.match(/"(?:nb_clients?|clients?|nombre_clients?|nbclient)"\s*:\s*(\d+)/i);
        if (mClient) count = Math.max(count, parseInt(mClient[1]));
      }

      result = { nonCouvert, incident, travaux, count, interceptedUrls: intercepted.map(i => i.url) };

    } else {
      // Fallback : lire le DOM rendu
      console.log(`[FALLBACK DOM] Aucun JSON intercepté pour ${insee}`);
      result = await page.evaluate(() => {
        const modal = document.querySelector('.js-modal-resultPanne');
        const modalVisible = modal && window.getComputedStyle(modal).display !== 'none'
                             && window.getComputedStyle(modal).display !== '';

        if (modalVisible) return { nonCouvert: true, incident: false, travaux: false, count: 0 };

        const body  = document.body.innerText || '';
        const bodyL = body.toLowerCase();
        const travaux  = bodyL.includes('travaux en cours') || bodyL.includes('travaux programm');
        const incident = bodyL.includes('incident en cours') || bodyL.includes('panne en cours') || bodyL.includes('interruption non programm');
        const m = body.match(/(\d[\d\s]*)\s*client/i);
        const count = m ? parseInt(m[1].replace(/\s/g, ''), 10) : 0;
        return { nonCouvert: false, incident, travaux, count };
      });
    }

    console.log(`[RESULT] ${insee} →`, result);
    result.url = url;
    result.cachedAt = new Date().toISOString();

    cache.set(cacheKey, result);
    for (const k of cache.keys()) {
      if (k !== cacheKey && k.startsWith(insee + '_')) cache.delete(k);
    }

    res.json(result);

  } catch (err) {
    console.error(`[ERROR] ${err.message}`);
    res.status(500).json({ error: err.message, url });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Proxy Enedis → http://0.0.0.0:${PORT}`));

process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
process.on('SIGINT',  async () => { if (browser) await browser.close(); process.exit(0); });
