// Point d'entrée : Express + auth mot de passe + montage des pollers
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './lib/config.js';
import { makeLogger } from './lib/logger.js';
import { createPasswordAuth } from './lib/auth.js';
import { createStore } from './lib/store.js';
import { startYbPoller, startTrackEnricher, fetchPointDetail } from './lib/yb.js';
import { startAisClient, distanceNm } from './lib/ais.js';
import { startScraperTrigger } from './lib/scraper-trigger.js';
import { createMarineTrafficScraper } from './lib/ais-marinetraffic.js';
import { startWindBackfill } from './lib/wind-backfill.js';

const log = makeLogger('server');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const viewsDir = path.join(__dirname, 'views');

const store = createStore({
  dataDir: config.data.dir,
  boatSaveMs: config.data.boatSaveMs,
  aisWindowMs: config.ais.windowMs,
});

const auth = createPasswordAuth({ password: config.auth.password });

const app = express();
app.disable('x-powered-by');
app.set('etag', false);

// Healthz : pas d'auth
app.get('/healthz', (req, res) => {
  const last = store.lastBoatPosition();
  res.json({
    ok: true,
    lastBoatAt: last?.at || null,
    ageMs: last ? Date.now() - last.at : null,
  });
});

// Login : page et soumission, sans auth
app.get('/login', auth.loginGet(viewsDir));
app.post('/login', express.urlencoded({ extended: false }), auth.loginPost);
app.post('/logout', auth.logout);

// Page principale (authentifiée)
app.get('/', auth.requireAuth, (req, res) => {
  res.sendFile(path.join(viewsDir, 'app.html'));
});

// Statiques (CSS, JS) — publics car ne révèlent que la structure UI, pas de données.
// no-cache : force la revalidation à chaque visite (sinon Cloudflare/navigateur peuvent servir une vieille version)
app.use(express.static(publicDir, {
  etag: false,
  index: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));

// API authentifiée
app.get('/api/state', auth.requireAuth, (req, res) => {
  const snap = store.snapshot();
  // Filtrage AIS : on ne renvoie au client que les cibles dans `radiusNm` de Mapei.
  // L'abonnement WS est plus large (cf. lib/ais.js) car aisstream ne pousse rien sur les petits bbox.
  const boatLast = snap.boat.track.at(-1);
  if (boatLast) {
    const center = { lat: boatLast.lat, lon: boatLast.lon };
    const totalCount = snap.ais.length;
    snap.ais = snap.ais.filter(v => {
      const last = v.track.at(-1);
      return last && distanceNm(center, last) <= config.ais.radiusNm;
    });
    log.debug(`AIS filter: ${snap.ais.length}/${totalCount} cibles dans ${config.ais.radiusNm} NM`);
  }
  res.json(snap);
});

// Détails de tous les points YB connus : { id: {speed, course, temp, datetime, altitude} }
// Utilisé par le client pour colorer les segments selon la vitesse
app.get('/api/track-details', auth.requireAuth, (req, res) => {
  res.json({ details: store.getAllPointDetails() });
});

// Endpoint de diag : tous les AIS reçus sans filtre, avec distance à Mapei
app.get('/api/ais-debug', auth.requireAuth, (req, res) => {
  const snap = store.snapshot();
  const boatLast = snap.boat.track.at(-1);
  const center = boatLast ? { lat: boatLast.lat, lon: boatLast.lon } : null;
  const data = snap.ais.map(v => {
    const last = v.track.at(-1);
    const dist = (center && last) ? distanceNm(center, last) : null;
    return { mmsi: v.mmsi, name: v.name, distanceNm: dist != null ? Math.round(dist * 10) / 10 : null, lat: last?.lat, lon: last?.lon };
  }).sort((a, b) => (a.distanceNm ?? 9999) - (b.distanceNm ?? 9999));
  res.json({ count: data.length, mapei: center, ais: data });
});
app.get('/api/windy-key', auth.requireAuth, (req, res) => {
  res.json({ key: config.windy.key });
});

// Détail d'un point YB par son id (cache puis fetch à la demande)
app.get('/api/yb-point/:id', auth.requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id invalide' });
  const cached = store.getPointDetail(id);
  if (cached) return res.json({ id, cached: true, ...cached });
  try {
    const detail = await fetchPointDetail({ keyword: config.yb.keyword, id });
    if (!detail) return res.status(404).json({ error: 'Détail introuvable' });
    store.setPointDetail(id, detail);
    res.json({ id, cached: false, ...detail });
  } catch (e) {
    log.warn(`Fetch détail YB ${id} échec`, e.message);
    res.status(502).json({ error: 'Yellow Brick injoignable' });
  }
});

const stopYb = startYbPoller({
  keyword: config.yb.keyword,
  event: config.yb.event,
  pollMs: config.yb.pollMs,
  store,
});

// Enricher en arrière-plan : remplit pointDetails pour tous les points YB qui n'en ont pas,
// permet ensuite l'affichage des segments colorés selon la vitesse
const stopEnricher = startTrackEnricher({
  keyword: config.yb.keyword,
  store,
});

// Backfill météo : à chaque point YB on associe TWS/TWD historiques via Open-Meteo
// (utilisé ensuite pour construire la polaire Mapei : lib/polar.js)
const stopWindBackfill = startWindBackfill({ store });

const stopAis = startAisClient({
  key: config.ais.key,
  radiusNm: config.ais.radiusNm,
  store,
});

// Trigger AIS scrapers tiers : déclenché à chaque nouvelle position YB de Mapei,
// délai aléatoire 30-120s pour éviter tout pattern régulier. Hors course = pas de scrape.
// Les scrapers headless (Playwright/Chromium) ne sont actifs que si chromium est installé,
// pour que les machines plus modestes (Pi Zero) ne tentent pas de lancer un browser absent.
const HAS_CHROMIUM = (() => {
  try { return fs.existsSync('/usr/bin/chromium'); } catch { return false; }
})();
const scrapers = HAS_CHROMIUM ? [createMarineTrafficScraper({ store })] : [];
if (!HAS_CHROMIUM) log.info('Chromium absent, scrapers AIS headless désactivés');
const stopScraperTrigger = startScraperTrigger({ store, scrapers });

const server = app.listen(config.port, config.bind, () => {
  log.info(`bogi-tracker à l'écoute sur http://${config.bind}:${config.port}`);
});

function shutdown(signal) {
  log.info(`Reçu ${signal}, arrêt propre…`);
  stopYb();
  stopEnricher();
  stopWindBackfill();
  stopAis();
  stopScraperTrigger();
  store.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
