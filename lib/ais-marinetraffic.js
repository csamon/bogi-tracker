// Scraper AIS MarineTraffic via headless Chromium (Playwright + stealth pour Cloudflare).
// Stratégie : à chaque runOnce, on lance un browser, navigate sur la zone Mapei,
// capture les XHR `/getData/get_data_json_4/...` (vessel tiles JSON), parse et push au store.
// Ce scraper est déclenché par scraper-trigger sur newBoatPosition (~toutes les 15 min en course).
// Coût : ~30 s + ~300 MB RAM par run. Largement supporté par Pi 5 (16 GB).
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { makeLogger } from './logger.js';

chromium.use(stealth());
const log = makeLogger('mt');

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
const EXECUTABLE = '/usr/bin/chromium';
const ZOOM = 8; // bbox ~200-300 NM autour du centre, le filtre 100 NM côté snapshot affine

// Convertit une row MT en objet AIS interne pour le store
function rowToAisPosition(row, capturedAt) {
  const lat = Number.parseFloat(row.LAT);
  const lon = Number.parseFloat(row.LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const speed = row.SPEED != null ? Number.parseFloat(row.SPEED) / 10 : null;
  const course = row.COURSE != null ? Number.parseFloat(row.COURSE) : null;
  const heading = row.HEADING != null && Number.parseFloat(row.HEADING) < 360 ? Number.parseFloat(row.HEADING) : null;
  // ELAPSED : minutes depuis dernière émission AIS, on recule le timestamp en conséquence
  const elapsedMin = row.ELAPSED != null ? Number.parseFloat(row.ELAPSED) : 0;
  const at = capturedAt - elapsedMin * 60_000;
  return { lat, lon, speed, course, heading, at };
}

export function createMarineTrafficScraper({ store }) {
  return {
    name: 'marinetraffic',
    async runOnce() {
      const last = store.lastBoatPosition();
      if (!last) { log.warn('Pas de position Mapei, skip MT scrape'); return 0; }

      const url = `https://www.marinetraffic.com/en/ais/home/centerx:${last.lon.toFixed(2)}/centery:${last.lat.toFixed(2)}/zoom:${ZOOM}`;
      log.info(`Lancement Chromium pour ${url}`);

      const browser = await chromium.launch({
        executablePath: EXECUTABLE,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
      });

      let added = 0;
      try {
        const ctx = await browser.newContext({
          userAgent: UA,
          viewport: { width: 1400, height: 900 },
          locale: 'en-US',
          timezoneId: 'Europe/Paris',
        });
        const page = await ctx.newPage();

        // On capture tous les vessel tiles JSON au passage
        const capturedTiles = [];
        page.on('response', async (resp) => {
          if (!resp.url().includes('get_data_json_4')) return;
          try { capturedTiles.push(await resp.json()); }
          catch { /* tile parse fail, on ignore */ }
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        // Attente : Cloudflare challenge + bundles + map render + tiles fetched
        await page.waitForTimeout(25_000);

        // Parse les rows
        const now = Date.now();
        let totalRows = 0;
        const seenIds = new Set();
        for (const tile of capturedTiles) {
          const rows = tile?.data?.rows;
          if (!Array.isArray(rows)) continue;
          for (const row of rows) {
            totalRows++;
            const shipId = row.SHIP_ID;
            if (!shipId) continue;
            // Dédupe : MT peut renvoyer le même bateau dans plusieurs tuiles
            const key = `mt_${shipId}`;
            if (seenIds.has(key)) continue;
            seenIds.add(key);

            const pos = rowToAisPosition(row, now);
            if (!pos) continue;
            store.appendAisPosition(key, pos);
            if (row.SHIPNAME) {
              store.updateAisStatic(key, {
                name: String(row.SHIPNAME).trim(),
                flag: row.FLAG || null,
                length: row.LENGTH ? Number.parseFloat(row.LENGTH) : null,
                shipType: row.SHIPTYPE || null,
                destination: row.DESTINATION || null,
                source: 'marinetraffic',
              });
            }
            added++;
          }
        }
        log.info(`${capturedTiles.length} tuiles capturées, ${totalRows} rows brutes, ${added} cibles uniques pushées`);
      } finally {
        await browser.close();
      }
      return added;
    },
  };
}
