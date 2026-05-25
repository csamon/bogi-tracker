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
import { buildPolar } from './lib/polar.js';
import { computeRoute } from './lib/routing.js';

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

// Headers de sécurité appliqués à TOUTES les réponses.
// On reste minimaliste pour ne pas casser Windy/Leaflet : juste anti-clickjacking,
// anti-MIME-sniff, no-referrer, HSTS (Cloudflare fait toujours du HTTPS), perms-policy.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// Rate limit /login : max 10 essais par IP par 15 min puis 429. Stockage in-memory,
// nettoyé en arrière-plan. Bypass impossible derrière Cloudflare car on lit CF-Connecting-IP
// (entrant uniquement via le tunnel sur loopback, pas spoofable de l'extérieur).
const loginAttempts = new Map();
const LOGIN_MAX = 3;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
function loginRateLimit(req, res, next) {
  const ip = (req.headers['cf-connecting-ip']
    || (req.headers['x-forwarded-for'] || '').split(',')[0]
    || req.ip
    || '').trim();
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec || rec.resetAt < now) rec = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  rec.count++;
  loginAttempts.set(ip, rec);
  if (rec.count > LOGIN_MAX) {
    const retry = Math.ceil((rec.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retry));
    return res.status(429).send(`Trop de tentatives. Réessaie dans ${Math.ceil(retry / 60)} min.`);
  }
  return next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginAttempts) if (rec.resetAt < now) loginAttempts.delete(ip);
}, 60_000).unref();

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
app.post('/login', loginRateLimit, express.urlencoded({ extended: false }), auth.loginPost);
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

// Détails de tous les points YB connus : { id: {speed, course, temp, datetime, altitude, wind?} }
// Utilisé par le client pour colorer les segments selon la vitesse
app.get('/api/track-details', auth.requireAuth, (req, res) => {
  res.json({ details: store.getAllPointDetails() });
});

// Polaire de vitesse Mapei : agrégée à partir des points YB enrichis (boat + wind)
app.get('/api/polar', auth.requireAuth, (req, res) => {
  res.json(buildPolar(store));
});

// Routing prévisionnel : route 10h calculée avec polaire + forecast Open-Meteo, TWA constant.
// Recalculé en arrière-plan à chaque nouveau point YB. Si un compute est en cours quand un
// nouveau YB arrive, on queue un autre compute (chain), pour que la route soit TOUJOURS basée
// sur le dernier YB connu une fois le compute en cours terminé.
let cachedRoute = null;
let cachedRouteFor = null;
let routeComputeInFlight = false;
let routeRecomputePending = false;
async function refreshRoute() {
  if (routeComputeInFlight) {
    routeRecomputePending = true;
    return;
  }
  const last = store.lastBoatPosition();
  if (!last) return;
  if (last.id === cachedRouteFor) return;
  routeComputeInFlight = true;
  try {
    const route = await computeRoute({ store, totalHours: 10, stepMin: 10 });
    if (route) {
      cachedRoute = route;
      cachedRouteFor = last.id;
      log.info(`Route recalculée : ${route.points.length} pts sur 10h, TWA=${Math.round(route.initialTwa)}°, TWS=${route.initialWind.speed.toFixed(1)} kn`);
    }
  } catch (e) {
    log.warn(`Route compute échec : ${e.message}`);
  } finally {
    routeComputeInFlight = false;
    // Si un newBoatPosition est arrivé pendant le compute, on enchaîne
    if (routeRecomputePending) {
      routeRecomputePending = false;
      setImmediate(refreshRoute);
    }
  }
}
store.events.on('newBoatPosition', refreshRoute);
setTimeout(refreshRoute, 3000);

app.get('/api/route', auth.requireAuth, (req, res) => {
  if (!cachedRoute) return res.status(503).json({ error: 'Route pas encore calculée' });
  res.json(cachedRoute);
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
