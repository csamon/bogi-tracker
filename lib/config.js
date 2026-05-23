// Chargement et validation de la configuration depuis .env
import 'dotenv/config';
import path from 'node:path';

function required(name) {
  const v = process.env[name];
  if (!v || v === 'replace_me') throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}
function intOr(name, def) {
  const v = process.env[name];
  return v ? Number.parseInt(v, 10) : def;
}
function strOr(name, def) {
  return process.env[name] || def;
}

export const config = Object.freeze({
  port: intOr('PORT', 3000),
  bind: strOr('BIND', '127.0.0.1'),
  auth: {
    password: required('LOGIN_PASSWORD'),
  },
  yb: {
    keyword: strOr('YB_KEYWORD', 'allagrandemapei'),
    event: strOr('YB_EVENT', '16860'),
    pollMs: intOr('YB_POLL_MS', 10 * 60 * 1000),
  },
  ais: {
    key: required('AISSTREAM_KEY'),
    radiusNm: intOr('AIS_RADIUS_NM', 50),
    windowMs: intOr('AIS_TRACK_WINDOW_MS', 30 * 60 * 1000),
  },
  windy: {
    key: required('WINDY_KEY'),
  },
  data: {
    dir: path.resolve(strOr('DATA_DIR', './data')),
    boatSaveMs: intOr('BOAT_SAVE_MS', 60 * 1000),
  },
});
