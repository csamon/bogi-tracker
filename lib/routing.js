// Routing simple basé sur la polaire Mapei + forecast vent Open-Meteo.
// Hypothèses : TWA constant (l'angle au vent reste celui du dernier point YB connu),
// pas/manœuvres/courants ignorés, polaire approximative. Précision indicative.
import { makeLogger } from './logger.js';
import { buildPolar } from './polar.js';

const log = makeLogger('route');
const OM_FORECAST = 'https://api.open-meteo.com/v1/forecast';
const UA = 'bogi-tracker/1.0 (interne Allagrande Mapei; contact c.samon@protonmail.com)';
const FORECAST_CACHE_TTL_MS = 60 * 60_000;

// Cache GFS/ECMWF par cellule 0.25° (clé "latQ_lonQ")
const forecastCache = new Map();

async function fetchForecastNear(lat, lon) {
  const latQ = Math.round(lat * 4) / 4;
  const lonQ = Math.round(lon * 4) / 4;
  const key = `${latQ}_${lonQ}`;
  const c = forecastCache.get(key);
  if (c && Date.now() - c.fetchedAt < FORECAST_CACHE_TTL_MS) return c.hourly;
  const url = `${OM_FORECAST}?latitude=${latQ}&longitude=${lonQ}`
    + `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&forecast_days=2&timezone=UTC`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j?.hourly) return null;
  forecastCache.set(key, { fetchedAt: Date.now(), hourly: j.hourly });
  return j.hourly;
}

function windAt(hourly, timeMs) {
  if (!hourly?.time) return null;
  const t = new Date(timeMs);
  t.setUTCMinutes(0, 0, 0);
  const iso = t.toISOString().slice(0, 13);
  const idx = hourly.time.findIndex(x => x.startsWith(iso));
  if (idx < 0) return null;
  const s = hourly.wind_speed_10m[idx];
  const d = hourly.wind_direction_10m[idx];
  if (s == null || d == null) return null;
  return { speed: Number(s), direction: Number(d) };
}

function destinationPoint(lat, lon, courseDeg, distanceNm) {
  const R = 3440.065;
  const δ = distanceNm / R;
  const θ = courseDeg * Math.PI / 180;
  const φ1 = lat * Math.PI / 180;
  const λ1 = lon * Math.PI / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
  );
  return { lat: φ2 * 180 / Math.PI, lon: ((λ2 * 180 / Math.PI + 540) % 360) - 180 };
}

// Polar lookup : bin le plus proche de (TWA, TWS), médiane de boatSpeed
function polarLookup(polar, absTwa, tws) {
  if (!polar.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const b of polar) {
    const da = Math.abs(Math.abs(b.twa) - absTwa);   // distance en TWA (deg)
    const dw = Math.abs(b.tws - tws);                 // distance en TWS (kn)
    const dist = da + dw * 5;                         // pondère TWS
    if (dist < bestDist) { bestDist = dist; best = b; }
  }
  return best ? best.boatSpeed : null;
}

export async function computeRoute({ store, totalHours = 10, stepMin = 10 }) {
  const last = store.lastBoatPosition();
  if (!last) return null;
  const detail = store.getPointDetail(last.id);
  if (!detail || detail.course == null) return null;

  // Vent initial : depuis l'enrichissement Open-Meteo (wind-backfill), sinon fetch fresh
  let currentWind = (detail.wind && !detail.wind.unavailable && detail.wind.speed != null)
    ? detail.wind : null;
  if (!currentWind) {
    try {
      const hourly = await fetchForecastNear(last.lat, last.lon);
      currentWind = windAt(hourly, last.at);
    } catch (e) { log.warn(`Vent initial échec : ${e.message}`); return null; }
  }
  if (!currentWind) { log.warn('Pas de vent initial dispo pour le routing'); return null; }

  // TWA signé (-180, 180]. Sign = côté bâbord/tribord du vent.
  const twa = ((currentWind.direction - detail.course + 540) % 360) - 180;
  const absTwa = Math.abs(twa);

  const polarData = buildPolar(store);
  if (!polarData.polar.length) { log.warn('Polaire vide, routing impossible'); return null; }

  const points = [{
    at: last.at,
    lat: last.lat, lon: last.lon,
    course: detail.course,
    speed: detail.speed,
    twa,
    tws: currentWind.speed,
  }];

  let lat = last.lat, lon = last.lon;
  let t = last.at;
  const stepMs = stepMin * 60_000;
  const endT = last.at + totalHours * 3_600_000;

  while (t < endT) {
    t += stepMs;
    let wind;
    try {
      const hourly = await fetchForecastNear(lat, lon);
      wind = windAt(hourly, t);
    } catch (e) {
      log.warn(`Vent t+${Math.round((t - last.at) / 60000)} min échec : ${e.message}`);
      break;
    }
    if (!wind) break;
    // Cap = direction du vent - TWA signé. Convention : TWA = (windDir - course).
    const newCourse = ((wind.direction - twa) + 360) % 360;
    const boatSpeed = polarLookup(polarData.polar, absTwa, wind.speed);
    if (boatSpeed == null) break;
    const dist = boatSpeed * (stepMin / 60);
    const next = destinationPoint(lat, lon, newCourse, dist);
    lat = next.lat; lon = next.lon;
    points.push({ at: t, lat, lon, course: newCourse, speed: boatSpeed, twa, tws: wind.speed });
  }

  return {
    points,
    initialTwa: twa,
    initialWind: currentWind,
    initialDetail: { course: detail.course, speed: detail.speed, at: last.at },
    polarBins: polarData.polar.length,
    polarUsedPoints: polarData.stats.usedPoints,
    computedAt: Date.now(),
  };
}
