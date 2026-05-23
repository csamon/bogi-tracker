// Point d'entrée : Express + auth mot de passe + montage des pollers
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './lib/config.js';
import { makeLogger } from './lib/logger.js';
import { createPasswordAuth } from './lib/auth.js';
import { createStore } from './lib/store.js';
import { startYbPoller } from './lib/yb.js';
import { startAisClient } from './lib/ais.js';

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

// Healthz : pas d'auth (Cloudflare + monitoring local)
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
// L'index par défaut est désactivé pour ne pas court-circuiter le middleware d'auth.
app.use(express.static(publicDir, { etag: false, index: false }));

// API authentifiée
app.get('/api/state', auth.requireAuth, (req, res) => {
  res.json(store.snapshot());
});
app.get('/api/windy-key', auth.requireAuth, (req, res) => {
  res.json({ key: config.windy.key });
});

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
