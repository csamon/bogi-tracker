// Point d'entrée : Express + Basic Auth + montage des pollers
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './lib/config.js';
import { makeLogger } from './lib/logger.js';
import { basicAuth } from './lib/auth.js';
import { createStore } from './lib/store.js';
import { startYbPoller } from './lib/yb.js';
import { startAisClient } from './lib/ais.js';

const log = makeLogger('server');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const store = createStore({
  dataDir: config.data.dir,
  boatSaveMs: config.data.boatSaveMs,
  aisWindowMs: config.ais.windowMs,
});

const app = express();
app.disable('x-powered-by');
app.set('etag', false);

// Healthz sans auth (Cloudflare + monitoring local)
app.get('/healthz', (req, res) => {
  const last = store.lastBoatPosition();
  res.json({
    ok: true,
    lastBoatAt: last?.at || null,
    ageMs: last ? Date.now() - last.at : null,
  });
});

// Tout le reste passe par Basic Auth
app.use(basicAuth(config.auth));

app.get('/api/state', (req, res) => {
  res.json(store.snapshot());
});

// Clé Windy renvoyée séparément pour ne pas l'écrire en dur dans le HTML
app.get('/api/windy-key', (req, res) => {
  res.json({ key: config.windy.key });
});

// Statiques (page Leaflet)
app.use(express.static(path.join(__dirname, 'public'), { etag: false }));

const stopYb = startYbPoller({
  keyword: config.yb.keyword,
  event: config.yb.event,
  pollMs: config.yb.pollMs,
  store,
});

const stopAis = startAisClient({
  key: config.ais.key,
  radiusNm: config.ais.radiusNm,
  store,
});

const server = app.listen(config.port, config.bind, () => {
  log.info(`bogi-tracker à l'écoute sur http://${config.bind}:${config.port}`);
});

function shutdown(signal) {
  log.info(`Reçu ${signal}, arrêt propre…`);
  stopYb();
  stopAis();
  store.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
