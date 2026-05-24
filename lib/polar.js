// Construction de la polaire de vitesse Mapei à partir des points YB enrichis.
// Pour chaque point on a (boatSpeed, boatCourse) depuis YB et (windSpeed, windDirection) depuis
// Open-Meteo (cf. wind-backfill.js). On en dérive TWA = (windDir - boatCourse) normalisé à
// (-180, 180], on bin sur (TWA, TWS), et on agrège boatSpeed (médiane par bin).
import { makeLogger } from './logger.js';

const log = makeLogger('polar');

const TWA_BIN_DEG = 10;
const TWS_BIN_KN = 2;
const TWS_MAX_KN = 40;
const MIN_BOAT_SPEED_KN = 1; // on ignore les points où Mapei est à quai/dérive (pas représentatif)

function normalizeTWA(twa) {
  return ((twa % 360) + 540) % 360 - 180;
}

function computeTWA(boatCourse, windDirection) {
  return normalizeTWA(windDirection - boatCourse);
}

export function buildPolar(store) {
  const raw = []; // triplets bruts (TWA, TWS, boatSpeed) pour le scatter
  let usedPoints = 0, skippedNoWind = 0, skippedNoBoatData = 0, skippedTooSlow = 0;

  for (const p of store.getBoatTrack()) {
    if (p.id == null) continue;
    const d = store.getPointDetail(p.id);
    if (!d) { skippedNoBoatData++; continue; }
    if (d.speed == null || d.course == null) { skippedNoBoatData++; continue; }
    if (!d.wind || d.wind.unavailable || d.wind.speed == null || d.wind.direction == null) {
      skippedNoWind++;
      continue;
    }
    if (d.speed < MIN_BOAT_SPEED_KN) { skippedTooSlow++; continue; }
    const twa = computeTWA(d.course, d.wind.direction);
    raw.push({ twa, tws: d.wind.speed, boatSpeed: d.speed, at: p.at });
    usedPoints++;
  }

  // Agrégation par bin (twaB, twsB) → médiane des boatSpeeds
  const bins = new Map();
  for (const pt of raw) {
    const twaB = Math.round(pt.twa / TWA_BIN_DEG) * TWA_BIN_DEG;
    const twsB = Math.round(pt.tws / TWS_BIN_KN) * TWS_BIN_KN;
    if (twsB > TWS_MAX_KN) continue;
    const k = `${twaB}_${twsB}`;
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(pt.boatSpeed);
  }

  const polar = [];
  for (const [k, speeds] of bins) {
    speeds.sort((a, b) => a - b);
    const median = speeds[Math.floor(speeds.length / 2)];
    const [twaB, twsB] = k.split('_').map(Number);
    polar.push({ twa: twaB, tws: twsB, boatSpeed: median, count: speeds.length });
  }

  log.debug(`Polaire : ${raw.length} points utilisés, ${bins.size} bins (skipped : ${skippedNoWind} no-wind, ${skippedNoBoatData} no-boatdata, ${skippedTooSlow} trop lent)`);

  return {
    raw,
    polar,
    bins: { twa: TWA_BIN_DEG, tws: TWS_BIN_KN, twsMax: TWS_MAX_KN },
    stats: { usedPoints, skippedNoWind, skippedNoBoatData, skippedTooSlow, binCount: bins.size },
  };
}
