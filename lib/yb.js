// Poller Yellow Brick : récupère positions récentes + détail du dernier point
import { makeLogger } from './logger.js';

const log = makeLogger('yb');
const BASE = 'https://app.yb.tl/APIX/Blog';
const UA = 'bogi-tracker/1.0 (interne Allagrande Mapei; contact c.samon@protonmail.com)';
const NUM_RX = /(-?[\d.]+)/;

async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} sur ${url}`);
  return r.json();
}

// "19.9 knots" -> 19.9
function parseSpeed(s) {
  if (typeof s === 'number') return s;
  if (typeof s !== 'string') return null;
  const m = NUM_RX.exec(s);
  return m ? Number.parseFloat(m[1]) : null;
}
function parseNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return null;
  const m = NUM_RX.exec(v);
  return m ? Number.parseFloat(m[1]) : null;
}

// Fetch + normalise le détail d'un point donné par son id
export async function fetchPointDetail({ keyword, id }) {
  const url = `${BASE}/GetPosition?keyword=${encodeURIComponent(keyword)}&id=${encodeURIComponent(id)}&_=${Date.now()}`;
  const json = await fetchJson(url);
  const d = json?.position;
  if (!d) return null;
  return {
    speed: parseSpeed(d.speed),
    course: parseNum(d.course),
    temp: parseNum(d.temp),
    datetime: d.datetime || null,
    altitude: parseNum(d.altitude),
  };
}

export function startYbPoller({ keyword, event, pollMs, store }) {
  let stopped = false;

  async function tick() {
    try {
      const url1 = `${BASE}/GetPositions?keyword=${encodeURIComponent(keyword)}&event=${encodeURIComponent(event)}&_=${Date.now()}`;
      const data = await fetchJson(url1);
      const positions = Array.isArray(data.positions) ? data.positions : [];
      let added = 0;
      for (const p of positions) {
        if (typeof p.at !== 'number' || typeof p.t !== 'number' || typeof p.g !== 'number') continue;
        const ok = store.appendBoatPosition({ lat: p.t, lon: p.g, at: p.at, id: p.id });
        if (ok) added++;
      }
      log.info(`GetPositions : ${positions.length} reçus, ${added} nouveaux`);

      const last = store.lastBoatPosition();
      if (last?.id != null) {
        const detail = await fetchPointDetail({ keyword, id: last.id });
        if (detail) {
          store.setBoatDetail({
            id: last.id,
            at: last.at,
            lat: last.lat,
            lon: last.lon,
            ...detail,
          });
          log.debug('GetPosition détail', { speed: detail.speed, course: detail.course, temp: detail.temp });
        }
      }
    } catch (e) {
      log.warn('Échec du tick YB', e.message);
    }
    if (!stopped) setTimeout(tick, pollMs);
  }

  tick();
  return () => { stopped = true; };
}
