// État central : boat (persisté), AIS (mémoire seule, fenêtre glissante)
import fs from 'node:fs';
import path from 'node:path';
import { makeLogger } from './logger.js';

const log = makeLogger('store');

export function createStore({ dataDir, boatSaveMs, aisWindowMs }) {
  const boatFile = path.join(dataDir, 'boat.json');

  const state = {
    boat: {
      track: [],          // [{ lat, lon, at, id }]
      lastDetail: null,   // dernier détail GetPosition (speed, course, temp...)
      lastUpdateAt: 0,
    },
    ais: new Map(),       // mmsi -> { static: {...}, track: [{lat,lon,course,speed,heading,at}] }
  };
  let boatDirty = false;

  fs.mkdirSync(dataDir, { recursive: true });

  // Chargement initial de la trace bateau
  try {
    const raw = fs.readFileSync(boatFile, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.track)) state.boat.track = data.track;
    if (data.lastDetail) state.boat.lastDetail = data.lastDetail;
    if (data.lastUpdateAt) state.boat.lastUpdateAt = data.lastUpdateAt;
    log.info(`Trace bateau chargée : ${state.boat.track.length} points`);
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn('boat.json illisible, on repart à zéro', e.message);
  }

  // Écriture atomique : tmp -> fsync -> rename
  function saveBoatSync() {
    if (!boatDirty) return;
    const tmp = boatFile + '.tmp';
    const payload = JSON.stringify({
      track: state.boat.track,
      lastDetail: state.boat.lastDetail,
      lastUpdateAt: state.boat.lastUpdateAt,
    });
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, payload);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, boatFile);
    boatDirty = false;
    log.debug(`Trace bateau sauvegardée (${state.boat.track.length} points)`);
  }

  function appendBoatPosition(p) {
    // Déduplication par id ET par timestamp
    const exists = state.boat.track.some(x => (p.id != null && x.id === p.id) || x.at === p.at);
    if (exists) return false;
    state.boat.track.push(p);
    state.boat.track.sort((a, b) => a.at - b.at);
    state.boat.lastUpdateAt = Math.max(state.boat.lastUpdateAt, p.at);
    boatDirty = true;
    return true;
  }

  function setBoatDetail(detail) {
    state.boat.lastDetail = detail;
    boatDirty = true;
  }

  function appendAisPosition(mmsi, p) {
    let v = state.ais.get(mmsi);
    if (!v) {
      v = { static: {}, track: [] };
      state.ais.set(mmsi, v);
    }
    v.track.push(p);
    // Fenêtre glissante
    const cutoff = Date.now() - aisWindowMs;
    v.track = v.track.filter(x => x.at >= cutoff);
  }

  function updateAisStatic(mmsi, s) {
    let v = state.ais.get(mmsi);
    if (!v) {
      v = { static: {}, track: [] };
      state.ais.set(mmsi, v);
    }
    v.static = { ...v.static, ...s };
  }

  function pruneAis() {
    // On retire les MMSI qui n'ont plus aucun point dans la fenêtre
    const cutoff = Date.now() - aisWindowMs;
    let removed = 0;
    for (const [mmsi, v] of state.ais) {
      v.track = v.track.filter(p => p.at >= cutoff);
      if (v.track.length === 0) {
        state.ais.delete(mmsi);
        removed++;
      }
    }
    if (removed > 0) log.debug(`AIS pruning : ${removed} MMSI retirés`);
  }

  function lastBoatPosition() {
    if (state.boat.track.length === 0) return null;
    return state.boat.track[state.boat.track.length - 1];
  }

  function snapshot() {
    return {
      now: Date.now(),
      boat: {
        track: state.boat.track,
        lastDetail: state.boat.lastDetail,
        lastUpdateAt: state.boat.lastUpdateAt,
      },
      ais: Array.from(state.ais.entries()).map(([mmsi, v]) => ({
        mmsi,
        name: v.static?.name || null,
        callsign: v.static?.callsign || null,
        type: v.static?.type || null,
        track: v.track,
      })),
    };
  }

  const saveTimer = setInterval(saveBoatSync, boatSaveMs);
  const pruneTimer = setInterval(pruneAis, Math.min(aisWindowMs, 60_000));

  return {
    appendBoatPosition,
    setBoatDetail,
    appendAisPosition,
    updateAisStatic,
    snapshot,
    lastBoatPosition,
    saveSync: saveBoatSync,
    shutdown() {
      clearInterval(saveTimer);
      clearInterval(pruneTimer);
      saveBoatSync();
    },
  };
}
