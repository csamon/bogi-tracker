// État central : boat (persisté), AIS (mémoire seule, fenêtre glissante)
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { makeLogger } from './logger.js';

const log = makeLogger('store');

export function createStore({ dataDir, boatSaveMs, aisWindowMs }) {
  const boatFile = path.join(dataDir, 'boat.json');
  const aisFile = path.join(dataDir, 'ais.json');

  const state = {
    boat: {
      track: [],                  // [{ lat, lon, at, id }]
      lastDetail: null,           // dernier détail GetPosition
      lastUpdateAt: 0,
      pointDetails: new Map(),    // id -> { speed, course, temp, datetime, altitude }
    },
    ais: new Map(),               // mmsi -> { static: {...}, track: [{lat,lon,course,speed,heading,at}] }
  };
  let boatDirty = false;
  let aisDirty = false;

  // Émetteur d'évènements pour orchestrer les scrapers AIS tiers (trigger sur newBoatPosition)
  const events = new EventEmitter();

  fs.mkdirSync(dataDir, { recursive: true });

  // Chargement initial
  try {
    const raw = fs.readFileSync(boatFile, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.track)) state.boat.track = data.track;
    if (data.lastDetail) state.boat.lastDetail = data.lastDetail;
    if (data.lastUpdateAt) state.boat.lastUpdateAt = data.lastUpdateAt;
    if (data.pointDetails && typeof data.pointDetails === 'object') {
      for (const [id, det] of Object.entries(data.pointDetails)) {
        state.boat.pointDetails.set(Number(id), det);
      }
    }
    log.info(`Trace bateau chargée : ${state.boat.track.length} points, ${state.boat.pointDetails.size} détails`);
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn('boat.json illisible, on repart à zéro', e.message);
  }

  // Chargement initial AIS (avec filtre fenêtre dès le load — points trop vieux ignorés)
  try {
    const raw = fs.readFileSync(aisFile, 'utf8');
    const data = JSON.parse(raw);
    if (data.ais && typeof data.ais === 'object') {
      const cutoff = Date.now() - aisWindowMs;
      let loadedMmsi = 0, loadedPts = 0;
      for (const [mmsi, v] of Object.entries(data.ais)) {
        if (!v || !Array.isArray(v.track)) continue;
        const filtered = v.track.filter(p => p && typeof p.at === 'number' && p.at >= cutoff);
        if (filtered.length === 0) continue;
        state.ais.set(Number(mmsi), { static: v.static || {}, track: filtered });
        loadedMmsi++;
        loadedPts += filtered.length;
      }
      log.info(`AIS chargé : ${loadedMmsi} MMSI, ${loadedPts} positions (fenêtre ${aisWindowMs / 60000} min)`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn('ais.json illisible, on repart à zéro AIS', e.message);
  }

  // Écriture atomique : tmp -> fsync -> rename
  function saveBoatSync() {
    if (!boatDirty) return;
    const tmp = boatFile + '.tmp';
    const payload = JSON.stringify({
      track: state.boat.track,
      lastDetail: state.boat.lastDetail,
      lastUpdateAt: state.boat.lastUpdateAt,
      pointDetails: Object.fromEntries(state.boat.pointDetails),
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
    log.debug(`Trace bateau sauvegardée (${state.boat.track.length} pts, ${state.boat.pointDetails.size} détails)`);
  }

  function appendBoatPosition(p) {
    const exists = state.boat.track.some(x => (p.id != null && x.id === p.id) || x.at === p.at);
    if (exists) return false;
    state.boat.track.push(p);
    state.boat.track.sort((a, b) => a.at - b.at);
    state.boat.lastUpdateAt = Math.max(state.boat.lastUpdateAt, p.at);
    boatDirty = true;
    events.emit('newBoatPosition', p);
    return true;
  }

  function setBoatDetail(detail) {
    state.boat.lastDetail = detail;
    if (detail?.id != null) {
      state.boat.pointDetails.set(detail.id, {
        speed: detail.speed,
        course: detail.course,
        temp: detail.temp,
        datetime: detail.datetime,
        altitude: detail.altitude,
      });
    }
    boatDirty = true;
  }

  function setPointDetail(id, detail) {
    state.boat.pointDetails.set(id, detail);
    boatDirty = true;
  }

  function getPointDetail(id) {
    return state.boat.pointDetails.get(id) || null;
  }

  // Renvoie le premier point de la trace qui n'a pas encore de détail. Utilisé par l'enricher.
  function getNextMissingDetailId() {
    for (const p of state.boat.track) {
      if (p.id != null && !state.boat.pointDetails.has(p.id)) return p.id;
    }
    return null;
  }

  // Tous les détails connus (pour transmettre au client)
  function getAllPointDetails() {
    return Object.fromEntries(state.boat.pointDetails);
  }

  function appendAisPosition(mmsi, p) {
    let v = state.ais.get(mmsi);
    if (!v) {
      v = { static: {}, track: [] };
      state.ais.set(mmsi, v);
    }
    v.track.push(p);
    const cutoff = Date.now() - aisWindowMs;
    v.track = v.track.filter(x => x.at >= cutoff);
    aisDirty = true;
  }

  function updateAisStatic(mmsi, s) {
    let v = state.ais.get(mmsi);
    if (!v) {
      v = { static: {}, track: [] };
      state.ais.set(mmsi, v);
    }
    v.static = { ...v.static, ...s };
    aisDirty = true;
  }

  function pruneAis() {
    const cutoff = Date.now() - aisWindowMs;
    let removed = 0;
    for (const [mmsi, v] of state.ais) {
      v.track = v.track.filter(p => p.at >= cutoff);
      if (v.track.length === 0) {
        state.ais.delete(mmsi);
        removed++;
      }
    }
    if (removed > 0) { log.debug(`AIS pruning : ${removed} MMSI retirés`); aisDirty = true; }
  }

  // Écriture atomique de l'état AIS
  function saveAisSync() {
    if (!aisDirty) return;
    const tmp = aisFile + '.tmp';
    const payload = JSON.stringify({
      ais: Object.fromEntries(state.ais),
    });
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, aisFile);
    aisDirty = false;
    log.debug(`AIS sauvegardé : ${state.ais.size} MMSI`);
  }

  function lastBoatPosition() {
    if (state.boat.track.length === 0) return null;
    return state.boat.track.at(-1);
  }

  // Accesseurs directs (pour modules qui itèrent — wind-backfill, polar, etc.)
  function getBoatTrack() { return state.boat.track; }

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
        source: v.static?.source || null,
        track: v.track,
      })),
    };
  }

  const saveTimer = setInterval(() => { saveBoatSync(); saveAisSync(); }, boatSaveMs);
  const pruneTimer = setInterval(pruneAis, Math.min(aisWindowMs, 60_000));

  return {
    events,
    appendBoatPosition,
    setBoatDetail,
    setPointDetail,
    getPointDetail,
    getBoatTrack,
    getNextMissingDetailId,
    getAllPointDetails,
    appendAisPosition,
    updateAisStatic,
    snapshot,
    lastBoatPosition,
    saveSync: () => { saveBoatSync(); saveAisSync(); },
    shutdown() {
      clearInterval(saveTimer);
      clearInterval(pruneTimer);
      saveBoatSync();
      saveAisSync();
    },
  };
}
