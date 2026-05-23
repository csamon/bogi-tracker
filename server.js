// Point d'entrée : Express + auth mot de passe + montage des pollers
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './lib/config.js';
import { makeLogger } from './lib/logger.js';
import { createPasswordAuth } from './lib/auth.js';
import { createStore } from './lib/store.js';
import { startYbPoller, fetchPointDetail } from './lib/yb.js';
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

// Statiques (CSS, JS) — publics car ne révèlent que la structure UI, pas de données
app.use(express.static(publicDir, { etag: false, index: false }));

// API authentifiée
app.get('/api/state', auth.requireAuth, (req, res) => {
  res.json(store.snapshot());
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
