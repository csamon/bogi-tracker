// POC v4 : navigation sur la zone Mapei + capture des response bodies vessel data
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
chromium.use(stealth());

// Mapei aire (golfe Gascogne / NW Espagne approche)
const URL = 'https://www.marinetraffic.com/en/ais/home/centerx:-7.5/centery:46.3/zoom:8';

const browser = await chromium.launch({
  executablePath: '/usr/bin/chromium',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
});
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  viewport: { width: 1400, height: 900 },
  locale: 'en-US',
  timezoneId: 'Europe/Paris',
});
const page = await ctx.newPage();

const vesselTiles = [];
page.on('response', async (resp) => {
  const url = resp.url();
  if (!url.includes('get_data_json_4')) return;
  try {
    const json = await resp.json();
    vesselTiles.push({ url, status: resp.status(), json });
  } catch (e) {
    vesselTiles.push({ url, status: resp.status(), err: e.message });
  }
});

console.log('Loading', URL);
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
console.log('Attente 30s (Cloudflare challenge + map render + vessel fetches)...');
await page.waitForTimeout(30000);

await browser.close();

console.log(`\n=== ${vesselTiles.length} tuiles vessel data capturées ===`);
let totalVessels = 0;
for (const t of vesselTiles.slice(0, 3)) {
  console.log(`--- ${t.url}`);
  if (t.err) { console.log('  ERR:', t.err); continue; }
  // Inspect structure
  const j = t.json;
  if (Array.isArray(j)) {
    console.log(`  Array de ${j.length} éléments`);
    if (j.length) console.log('  Premier:', JSON.stringify(j[0]).slice(0, 300));
    totalVessels += j.length;
  } else if (j && typeof j === 'object') {
    console.log('  Object keys:', Object.keys(j).slice(0, 10).join(','));
    console.log('  Sample:', JSON.stringify(j).slice(0, 500));
  } else {
    console.log('  Raw:', JSON.stringify(j).slice(0, 300));
  }
}
// Total vessels sur toutes tuiles
let grandTotal = 0;
for (const t of vesselTiles) {
  if (Array.isArray(t.json)) grandTotal += t.json.length;
}
console.log(`\nTotal vessels sur toutes tuiles : ${grandTotal}`);
