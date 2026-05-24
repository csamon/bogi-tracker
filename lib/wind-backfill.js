// Backfill wind : pour chaque point YB, récupère la météo historique via Open-Meteo
// (archive API gratuite sans clé) et la stocke dans pointDetails[id].wind = { speed, direction }.
// Tourne en arrière-plan en continu, 1 fetch / 500ms. Pas de bot detection à craindre, on est
// dans les nominations rate-limits d'Open-Meteo (10000 req/jour free).
// Sert ensuite à construire la polaire de vitesse Mapei (lib/polar.js).
import { makeLogger } from './logger.js';

const log = makeLogger('wind');
const OPEN_METEO_BASE = 'https://archive-api.open-meteo.com/v1/archive';
const UA = 'bogi-tracker/1.0 (interne Allagrande Mapei; contact c.samon@protonmail.com)';

// Fetch + parse météo historique à un (lat, lon, timestamp). Renvoie {speed kn, direction °} ou null.
async function fetchWindForPoint(point) {
  const date = new Date(point.at).toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const url = `${OPEN_METEO_BASE}?latitude=${point.lat.toFixed(4)}&longitude=${point.lon.toFixed(4)}`
    + `&start_date=${date}&end_date=${date}`
    + `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&timezone=UTC`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j?.hourly?.time?.length) return null;
  // On cherche l'heure exacte (Open-Meteo donne UTC hourly)
  const target = new Date(point.at);
  target.setUTCMinutes(0, 0, 0);
  const targetISO = target.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const idx = j.hourly.time.findIndex(t => t.startsWith(targetISO));
  if (idx < 0) return null;
  const speed = j.hourly.wind_speed_10m[idx];
  const direction = j.hourly.wind_direction_10m[idx];
  if (speed == null || direction == null) return null;
  return { speed: Number(speed), direction: Number(direction) };
}

function findNextPointWithoutWind(store) {
  for (const p of store.getBoatTrack()) {
    if (p.id == null) continue;
    const d = store.getPointDetail(p.id);
    if (!d?.wind) return p;
  }
  return null;
}

export function startWindBackfill({ store, intervalMs = 500 }) {
  let stopped = false;

  async function tick() {
    if (stopped) return;
    const p = findNextPointWithoutWind(store);
    if (p == null) {
      // Tout est enrichi, on attend (un nouveau point YB peut arriver toutes les 15 min)
      if (!stopped) setTimeout(tick, 30_000);
      return;
    }
    try {
      const wind = await fetchWindForPoint(p);
      if (wind) {
        const existing = store.getPointDetail(p.id) || {};
        store.setPointDetail(p.id, { ...existing, wind });
        log.debug(`id=${p.id} TWS=${wind.speed.toFixed(1)} kn TWD=${Math.round(wind.direction)}°`);
      } else {
        // Marqueur "tenté mais pas de donnée" pour ne pas retenter en boucle
        const existing = store.getPointDetail(p.id) || {};
        store.setPointDetail(p.id, { ...existing, wind: { unavailable: true } });
        log.debug(`id=${p.id} : pas de wind data Open-Meteo (marquage unavailable)`);
      }
    } catch (e) {
      log.warn(`fetch id=${p.id} : ${e.message}`);
    }
    if (!stopped) setTimeout(tick, intervalMs);
  }

  tick();
  return () => { stopped = true; };
}
