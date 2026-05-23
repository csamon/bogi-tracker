// Client WebSocket aisstream.io : positions des bateaux autour de Mapei (bbox dynamique)
import WebSocket from 'ws';
import { makeLogger } from './logger.js';

const log = makeLogger('ais');
const URL = 'wss://stream.aisstream.io/v0/stream';

// Convertit rayon NM -> bbox [[lat1,lon1],[lat2,lon2]]
function radiusToBbox(lat, lon, radiusNm) {
  const dLat = radiusNm / 60; // 1 NM ≈ 1/60 degré de latitude
  const dLon = radiusNm / (60 * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
  return [[lat - dLat, lon - dLon], [lat + dLat, lon + dLon]];
}

// Distance Haversine en NM
function distanceNm(a, b) {
  const R = 3440.065;
  const φ1 = a.lat * Math.PI / 180;
  const φ2 = b.lat * Math.PI / 180;
  const Δφ = (b.lat - a.lat) * Math.PI / 180;
  const Δλ = (b.lon - a.lon) * Math.PI / 180;
  const x = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function startAisClient({ key, radiusNm, store }) {
  let ws = null;
  let backoff = 1000;
  let stopped = false;
  let subscribedCenter = null;
  const RESUB_THRESHOLD_NM = radiusNm / 5; // resub si Mapei a dérivé > 1/5 du rayon

  // Diagnostic : compteurs de messages reçus
  let msgTotal = 0;
  let msgPosition = 0;
  let msgStatic = 0;
  let msgOther = 0;
  let msgLastMinute = 0;
  setInterval(() => {
    log.info(`AIS stats (60s) : ${msgLastMinute} msgs reçus | total : ${msgTotal} (pos ${msgPosition}, static ${msgStatic}, autre ${msgOther})`);
    msgLastMinute = 0;
  }, 60_000);

  function subscribe(lat, lon) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const bbox = radiusToBbox(lat, lon, radiusNm);
    const msg = {
      APIKey: key,
      Apikey: key,
      BoundingBoxes: [bbox],
      FilterMessageTypes: ['PositionReport', 'StaticDataReport'],
    };
    const json = JSON.stringify(msg);
    ws.send(json);
    subscribedCenter = { lat, lon };
    log.info(`Abonnement AIS bbox ${radiusNm} NM autour de`, { lat: lat.toFixed(4), lon: lon.toFixed(4) });
    log.debug('Subscription payload', json);
  }

  function maybeResubscribe() {
    const last = store.lastBoatPosition();
    if (!last) return;
    if (!subscribedCenter) {
      subscribe(last.lat, last.lon);
      return;
    }
    const d = distanceNm(subscribedCenter, last);
    if (d >= RESUB_THRESHOLD_NM) {
      log.info(`Resub AIS (dérive ${d.toFixed(1)} NM)`);
      subscribe(last.lat, last.lon);
    }
  }

  function handle(raw) {
    msgTotal++; msgLastMinute++;
    let m;
    try { m = JSON.parse(raw); } catch { msgOther++; return; }
    if (m.error) { log.warn('Erreur aisstream', m.error); msgOther++; return; }
    const type = m.MessageType;
    const meta = m.MetaData || {};
    const mmsi = meta.MMSI;
    // Log brut au niveau debug — utile pour diagnostiquer le format de message
    log.debug('AIS raw', { type, mmsi, hasMeta: !!m.MetaData, sample: JSON.stringify(m).slice(0, 200) });
    if (!mmsi) { msgOther++; return; }

    if (type === 'PositionReport') {
      msgPosition++;
      const pr = m.Message?.PositionReport;
      if (!pr) return;
      const lat = pr.Latitude;
      const lon = pr.Longitude;
      if (typeof lat !== 'number' || typeof lon !== 'number') return;
      store.appendAisPosition(mmsi, {
        lat, lon,
        course: typeof pr.Cog === 'number' ? pr.Cog : null,
        speed: typeof pr.Sog === 'number' ? pr.Sog : null,
        heading: typeof pr.TrueHeading === 'number' && pr.TrueHeading < 360 ? pr.TrueHeading : null,
        at: Date.now(),
      });
      if (meta.ShipName) {
        const n = String(meta.ShipName).trim();
        if (n) store.updateAisStatic(mmsi, { name: n });
      }
    } else if (type === 'StaticDataReport') {
      msgStatic++;
      const sdr = m.Message?.StaticDataReport;
      const partA = sdr?.ReportA;
      const partB = sdr?.ReportB;
      const s = {};
      if (partA?.Name) s.name = String(partA.Name).trim();
      if (partB?.CallSign) s.callsign = String(partB.CallSign).trim();
      if (typeof partB?.ShipType === 'number') s.type = partB.ShipType;
      if (Object.keys(s).length) store.updateAisStatic(mmsi, s);
    }
  }

  function connect() {
    if (stopped) return;
    log.info('Connexion WebSocket aisstream.io');
    ws = new WebSocket(URL);

    ws.on('open', () => {
      backoff = 1000;
      const last = store.lastBoatPosition();
      if (last) subscribe(last.lat, last.lon);
      else log.warn('Pas encore de position bateau — abonnement repoussé');
    });

    ws.on('message', (data) => handle(data.toString()));

    ws.on('close', (code, reason) => {
      log.warn(`WebSocket fermé (code ${code})`, reason?.toString() || '');
      ws = null;
      subscribedCenter = null;
      if (!stopped) {
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    });

    ws.on('error', (e) => {
      log.error('Erreur WebSocket', e.message);
      // close se chargera de la reconnexion
    });
  }

  const resubTimer = setInterval(maybeResubscribe, 60_000);
  connect();

  return () => {
    stopped = true;
    clearInterval(resubTimer);
    if (ws) ws.close();
  };
}
