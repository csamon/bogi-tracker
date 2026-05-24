// Scraper AIS MarineTraffic via headless Chromium (Playwright + stealth pour Cloudflare).
// Stratégie organique :
//  - Contexte persistant (cf_clearance et autres cookies réutilisés d'un run à l'autre)
//  - UA, viewport, zoom, légère dérive du centre, délais : tout est tiré aléatoirement
//  - Interactions souris (move, scroll, pan parfois) pour ne pas être détecté comme bot
// Déclenché par scraper-trigger sur newBoatPosition (~4 runs/h en course, 0 hors course).
// Coût : ~25-40 s + ~300 MB RAM par run. Pi 5 (16 GB) gère sans problème.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { makeLogger } from './logger.js';

chromium.use(stealth());
const log = makeLogger('mt');

const EXECUTABLE = '/usr/bin/chromium';
const PROFILE_DIR = path.join(os.homedir(), '.cache', 'bogi-mt-profile');

// Pool d'User-Agents Chrome récents Linux x86 / Ubuntu
const UAS = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
];

// Helpers aléatoires
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 0.999));
const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Convertit une row MT en objet AIS interne pour le store
function rowToAisPosition(row, capturedAt) {
  const lat = Number.parseFloat(row.LAT);
  const lon = Number.parseFloat(row.LON);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const speed = row.SPEED != null ? Number.parseFloat(row.SPEED) / 10 : null;
  const course = row.COURSE != null ? Number.parseFloat(row.COURSE) : null;
  const heading = row.HEADING != null && Number.parseFloat(row.HEADING) < 360 ? Number.parseFloat(row.HEADING) : null;
  const elapsedMin = row.ELAPSED != null ? Number.parseFloat(row.ELAPSED) : 0;
  const at = capturedAt - elapsedMin * 60_000;
  return { lat, lon, speed, course, heading, at };
}

export function createMarineTrafficScraper({ store }) {
  // S'assure que le dossier profil existe
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  return {
    name: 'marinetraffic',
    async runOnce() {
      const last = store.lastBoatPosition();
      if (!last) { log.warn('Pas de position Mapei, skip MT scrape'); return 0; }

      // Légère dérive du centre + zoom variable → URL différente à chaque run
      const lon = last.lon + rand(-0.3, 0.3);
      const lat = last.lat + rand(-0.3, 0.3);
      const zoom = choice([7, 8, 8, 8, 8, 9]); // surtout 8 mais on varie
      const url = `https://www.marinetraffic.com/en/ais/home/centerx:${lon.toFixed(2)}/centery:${lat.toFixed(2)}/zoom:${zoom}`;

      const ua = choice(UAS);
      const viewport = { width: randInt(1280, 1600), height: randInt(800, 1000) };
      log.info(`Lancement Chromium (UA Chrome ${ua.match(/Chrome\/(\d+)/)?.[1]}, ${viewport.width}x${viewport.height}, zoom ${zoom}) → ${url}`);

      // launchPersistentContext : on garde le profil entre runs.
      // Le cf_clearance cookie de Cloudflare reste valide ~30 min → runs suivants beaucoup plus rapides
      const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath: EXECUTABLE,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
        userAgent: ua,
        viewport,
        locale: 'en-US',
        timezoneId: 'Europe/Paris',
      });

      let added = 0;
      try {
        const page = await ctx.newPage();

        // Capture vessels tiles JSON
        const capturedTiles = [];
        page.on('response', async (resp) => {
          if (!resp.url().includes('get_data_json_4')) return;
          try { capturedTiles.push(await resp.json()); } catch { /* ignore */ }
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

        // Première attente : Cloudflare challenge (court si cookies valides) + bundles + map render
        await page.waitForTimeout(rand(8_000, 14_000));

        // Mouvements de souris pour simuler activité humaine
        const vw = viewport.width, vh = viewport.height;
        await page.mouse.move(randInt(vw * 0.3, vw * 0.7), randInt(vh * 0.3, vh * 0.7));
        await page.waitForTimeout(rand(500, 1500));

        // Petit scroll/zoom pour forcer le rechargement de quelques tuiles
        await page.mouse.wheel(0, choice([-150, -100, 100, 150]));
        await page.waitForTimeout(rand(2_000, 4_000));

        // Parfois (50%), un petit drag-pan
        if (Math.random() > 0.5) {
          const x0 = randInt(vw * 0.4, vw * 0.6), y0 = randInt(vh * 0.4, vh * 0.6);
          await page.mouse.move(x0, y0);
          await page.mouse.down();
          await page.mouse.move(x0 + randInt(-80, 80), y0 + randInt(-50, 50), { steps: randInt(8, 16) });
          await page.mouse.up();
          await page.waitForTimeout(rand(2_000, 4_000));
        }

        // Attente finale variable pour que toutes les tuiles arrivent
        await page.waitForTimeout(rand(6_000, 12_000));

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
        log.info(`${capturedTiles.length} tuiles, ${totalRows} rows brutes, ${added} cibles uniques pushées`);
      } finally {
        await ctx.close();
      }
      return added;
    },
  };
}
