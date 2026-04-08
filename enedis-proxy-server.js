const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
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

    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,eot}', r => r.abort());

    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });

    // Attendre que le JS ait fini de traiter :
    // - soit le modal "non couvert" est VISIBLE (display:flex) et reste visible → vraiment non couvert
    // - soit il était présent dans le HTML mais le JS l'a masqué → la commune EST couverte
    // → attendre que display:flex disparaisse OU qu'un résultat apparaisse, max 10s
    await page.waitForFunction(() => {
      const modal = document.querySelector('.js-modal-resultPanne');
      if (!modal) return true; // pas de modal du tout → OK
      const style = window.getComputedStyle(modal);
      // Modal masqué par JS → la commune est couverte, les vrais résultats sont là
      return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
    }, { timeout: 10000 }).catch(() => {
      // Timeout : le modal est resté visible → vraiment non couvert
      console.log(`[INFO] Modal resté visible pour ${insee}`);
    });

    // Attendre un peu plus pour les résultats réels
    await page.waitForTimeout(2000);

    const result = await page.evaluate(() => {
      const modal = document.querySelector('.js-modal-resultPanne');
      const modalVisible = modal && window.getComputedStyle(modal).display !== 'none';

      if (modalVisible) {
        return { nonCouvert: true, incident: false, travaux: false, count: 0 };
      }

      const body  = document.body.innerText || '';
      const bodyL = body.toLowerCase();

      const travaux =
        bodyL.includes('travaux en cours') ||
        bodyL.includes('travaux programm') ||
        bodyL.includes('travaux préventifs');

      const incident =
        bodyL.includes('incident en cours') ||
        bodyL.includes('panne en cours') ||
        bodyL.includes('interruption non programm') ||
        bodyL.includes('coupure en cours');

      const m = body.match(/(\d[\d\s]*)\s*client/i);
      const count = m ? parseInt(m[1].replace(/\s/g, ''), 10) : 0;

      return { nonCouvert: false, incident, travaux, count };
    });

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
app.listen(PORT, '0.0.0.0', () => console.log(`Proxy Enedis -> http://0.0.0.0:${PORT}`));

process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });
process.on('SIGINT',  async () => { if (browser) await browser.close(); process.exit(0); });
