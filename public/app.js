// Bogi Tracker — frontend Windy Plugin API
// Marker bateau + segments YB colorés selon la vitesse + AIS (cibles + traces) toggleable
(() => {
  const REFRESH_MS = 15_000;
  const ALERT_AGE_MS = 45 * 60 * 1000;
  const LS_AIS = 'bogi.ais';
  const LS_POINTS = 'bogi.points';
  const LS_EXTRAP = 'bogi.extrap';
  // Heures d'extrapolation à projeter depuis la dernière position connue
  const EXTRAP_HOURS = [1, 5, 10];

  // Échelle de vitesse pour la coloration des segments
  const SPEED_MIN_KN = 0;
  const SPEED_MAX_KN = 35;

  let showAis = localStorage.getItem(LS_AIS) !== '0';
  let showPoints = localStorage.getItem(LS_POINTS) !== '0';
  let showExtrap = localStorage.getItem(LS_EXTRAP) !== '0';

  // Bootstrap : on récupère la clé Windy + un premier snapshot, puis on initialise Windy
  (async () => {
    let key, initialState, initialDetails;
    try {
      const [r1, r2, r3] = await Promise.all([
        fetch('/api/windy-key'),
        fetch('/api/state'),
        fetch('/api/track-details'),
      ]);
      if (!r1.ok || !r2.ok) throw new Error('boot fetch a échoué');
      key = (await r1.json()).key;
      initialState = await r2.json();
      initialDetails = r3.ok ? (await r3.json()).details : {};
    } catch (e) {
      document.getElementById('status-boat').textContent = '⚠ Erreur de chargement initial';
      console.error(e);
      return;
    }

    const last = initialState.boat?.track?.at(-1);
    const lat = last?.lat ?? 47;
    const lon = last?.lon ?? -3;

    // eslint-disable-next-line no-undef
    if (typeof windyInit !== 'function') {
      document.getElementById('status-boat').textContent = '⚠ Windy non chargé';
      return;
    }

    // eslint-disable-next-line no-undef
    windyInit({
      key,
      verbose: false,
      lat,
      lon,
      zoom: 7,
    }, (windyAPI) => bootMap(windyAPI, initialState, initialDetails));
  })();

  function bootMap(windyAPI, initialState, initialDetails) {
    const map = windyAPI.map;
    try { windyAPI.store.set('overlay', 'wind'); } catch (e) { console.warn('overlay set failed', e); }

    // === Helpers d'icônes ===
    function boatIcon(course) {
      return L.divIcon({
        className: '',
        html: `<div class="boat-marker" style="transform: rotate(${course || 0}deg);"></div>`,
        iconSize: [28, 28], iconAnchor: [14, 14],
      });
    }
    // Opacité décroissante selon âge du dernier report : indication visuelle de fraîcheur
    function ageOpacity(ageMs) {
      if (ageMs == null) return 1;
      if (ageMs > 30 * 60_000) return 0.3;
      if (ageMs > 10 * 60_000) return 0.55;
      if (ageMs > 5 * 60_000) return 0.8;
      return 1;
    }
    function aisIcon(course, ageMs) {
      const op = ageOpacity(ageMs);
      return L.divIcon({
        className: '',
        html: `<div class="ais-marker" style="transform: rotate(${course || 0}deg); opacity: ${op};"></div>`,
        iconSize: [14, 14], iconAnchor: [7, 7],
      });
    }

    // === Destination grand-cercle (depuis lat/lon, cap°, distance NM) ===
    function destinationPoint(lat, lon, courseDeg, distanceNm) {
      const R = 3440.065; // rayon Terre en NM
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

    // === Coloration vitesse : gradient type Turbo (perceptuellement uniforme) ===
    // Stops resserrés dans la plage opérationnelle IMOCA (15-30 kn) pour mieux distinguer
    // les petites variations de vitesse.
    const SPEED_STOPS = [
      { v: 0,  c: [48, 18, 90] },     // violet sombre
      { v: 4,  c: [70, 60, 160] },    // bleu-violet
      { v: 8,  c: [50, 110, 215] },   // bleu
      { v: 12, c: [40, 175, 220] },   // bleu-cyan
      { v: 16, c: [50, 210, 180] },   // cyan-vert
      { v: 19, c: [120, 225, 100] },  // vert lime
      { v: 22, c: [200, 230, 50] },   // vert-jaune
      { v: 25, c: [250, 200, 40] },   // jaune
      { v: 28, c: [250, 145, 30] },   // orange
      { v: 31, c: [235, 80, 35] },    // rouge-orange
      { v: 35, c: [165, 25, 30] },    // rouge sombre
    ];
    function speedColor(speed) {
      if (speed == null || Number.isNaN(speed)) return '#808080';
      const s = Math.max(SPEED_MIN_KN, Math.min(SPEED_MAX_KN, speed));
      for (let i = 1; i < SPEED_STOPS.length; i++) {
        if (s <= SPEED_STOPS[i].v) {
          const a = SPEED_STOPS[i - 1];
          const b = SPEED_STOPS[i];
          const t = (s - a.v) / (b.v - a.v);
          const r = Math.round(a.c[0] + t * (b.c[0] - a.c[0]));
          const g = Math.round(a.c[1] + t * (b.c[1] - a.c[1]));
          const bl = Math.round(a.c[2] + t * (b.c[2] - a.c[2]));
          return `rgb(${r},${g},${bl})`;
        }
      }
      return 'rgb(165,25,30)';
    }

    // === Helpers formatage ===
    function ageString(ms) {
      if (ms < 0) return "à l'instant";
      if (ms < 60_000) return `il y a ${Math.round(ms / 1000)} s`;
      if (ms < 3600_000) return `il y a ${Math.round(ms / 60_000)} min`;
      if (ms < 86_400_000) return `il y a ${(ms / 3600_000).toFixed(1)} h`;
      return `il y a ${Math.round(ms / 86_400_000)} j`;
    }
    function fmtDateFromAt(at) {
      try { return new Date(at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }); }
      catch { return '—'; }
    }
    function fmtNum(v, suffix, digits = 1) {
      if (v == null || Number.isNaN(v)) return '—';
      return `${Number(v).toFixed(digits)} ${suffix}`;
    }
    function fmtCourse(v) {
      if (v == null || Number.isNaN(v)) return '—';
      return `${Math.round(v)}°`;
    }
    function fmtCoords(lat, lon) { return `${lat.toFixed(4)}, ${lon.toFixed(4)}`; }

    function pointPopupHtml(point, detail, loading = false) {
      const when = detail?.datetime ? detail.datetime : fmtDateFromAt(point.at);
      const rows = loading ? `<div class="yb-loading">Chargement…</div>` : `
        <div class="yb-row"><span>Vitesse</span><span>${fmtNum(detail?.speed, 'kn')}</span></div>
        <div class="yb-row"><span>Cap</span><span>${fmtCourse(detail?.course)}</span></div>
        <div class="yb-row"><span>Position</span><span>${fmtCoords(point.lat, point.lon)}</span></div>
      `;
      return `<div class="yb-popup"><div class="yb-time">${when}</div>${rows}</div>`;
    }

    // === État des couches ===
    let boatMarker = null;
    let segments = [];                  // L.polyline par paire de points consécutifs
    let extrapMarkers = [];             // markers +1h/+5h/+10h
    let extrapLine = null;              // pointillé reliant la position au +10h
    let timelineMarker = null;          // suit la timeline Windy (orange, position projetée OU historique)
    let currentLast = null;             // dernière position connue (pour re-render au changement timestamp)
    let currentDetail = null;
    let currentTrack = null;            // trace YB complète, pour le rewind dans le passé
    let scrubbedToPast = false;         // si vrai, on a déplacé le boat marker à un point historique → renderBoat ne doit pas le re-snap au présent
    let currentRoute = null;            // route prévisionnelle polaire+Windy (10h, pas 10min) — null si mode classic ou pas encore calculée
    const pointMarkers = new Map();     // id -> L.circleMarker
    const aisMarkers = new Map();       // mmsi -> L.marker
    const aisTracks = new Map();        // mmsi -> L.polyline
    const detailCache = new Map(Object.entries(initialDetails).map(([k, v]) => [Number(k), v]));

    async function fetchAndShowDetail(cm, point) {
      cm.bindPopup(pointPopupHtml(point, null, true)).openPopup();
      if (detailCache.has(point.id)) {
        cm.setPopupContent(pointPopupHtml(point, detailCache.get(point.id)));
        return;
      }
      try {
        const r = await fetch(`/api/yb-point/${point.id}`);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const detail = await r.json();
        detailCache.set(point.id, detail);
        cm.setPopupContent(pointPopupHtml(point, detail));
      } catch (e) {
        cm.setPopupContent(pointPopupHtml(point, { datetime: '— erreur fetch —' }));
        console.error(e);
      }
    }

    // === Rendu de l'extrapolation +1h / +5h / +10h ===
    let extrapPolarLine = null;        // route polaire (courbée, bleue)
    function clearExtrap() {
      for (const m of extrapMarkers) map.removeLayer(m);
      extrapMarkers = [];
      if (extrapLine) { map.removeLayer(extrapLine); extrapLine = null; }
      if (extrapPolarLine) { map.removeLayer(extrapPolarLine); extrapPolarLine = null; }
    }
    function clearTimelineMarker() {
      if (timelineMarker) { map.removeLayer(timelineMarker); timelineMarker = null; }
    }

    // Trouve le point YB de la trace dont le timestamp est le plus proche d'une date donnée
    function findClosestHistorical(track, timestamp) {
      if (!track || !track.length) return null;
      let best = track[0];
      let bestDiff = Math.abs(best.at - timestamp);
      for (const p of track) {
        const d = Math.abs(p.at - timestamp);
        if (d < bestDiff) { bestDiff = d; best = p; }
      }
      return best;
    }

    function setBoatTo(lat, lon, course) {
      if (!boatMarker) return;
      boatMarker.setLatLng([lat, lon]);
      boatMarker.setIcon(boatIcon(course || 0));
    }

    function updateTimelineBadge(lat, lon, html) {
      const tStr = new Date(html.timestamp).toLocaleString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const icon = L.divIcon({
        className: '',
        html: `<div class="timeline-badge">@${tStr}</div>`,
        iconSize: [44, 15], iconAnchor: [22, 7],
      });
      if (!timelineMarker) {
        timelineMarker = L.marker([lat, lon], { icon }).addTo(map);
      } else {
        timelineMarker.setLatLng([lat, lon]);
        timelineMarker.setIcon(icon);
      }
      timelineMarker.bindPopup(html.popup);
    }

    // === Curseur dynamique synchronisé à la timeline Windy ===
    // Trois modes selon la position du curseur Windy par rapport au dernier point YB connu :
    //   • futur (> +15 min) : projection cap+vitesse constants (extrapolation)
    //   • présent (±15 min) : bateau à sa position actuelle, pas de badge
    //   • passé (< −15 min) : rewind du bateau au point YB historique le plus proche
    function renderTimelineProjection(last, detail, timestamp) {
      if (!showExtrap || !last) {
        scrubbedToPast = false;
        clearTimelineMarker();
        if (last) setBoatTo(last.lat, last.lon, detail?.course);
        return;
      }
      const deltaMs = timestamp - last.at;
      const PRESENT_TOL_MS = 15 * 60_000;

      // === Mode PASSÉ : on recule le bateau au point YB historique le plus proche ===
      if (deltaMs < -PRESENT_TOL_MS) {
        const hist = findClosestHistorical(currentTrack, timestamp);
        if (!hist) { clearTimelineMarker(); return; }
        const histDetail = detailCache.get(hist.id);
        scrubbedToPast = true;
        setBoatTo(hist.lat, hist.lon, histDetail?.course);
        const histAgeMin = Math.round((Date.now() - hist.at) / 60_000);
        const popup = `
          <div class="yb-popup">
            <div class="yb-time">Mapei @ ${new Date(hist.at).toLocaleString('fr-FR')}</div>
            <div class="yb-row"><span>Delta</span><span>−${(Math.abs(deltaMs) / 3_600_000).toFixed(1)} h</span></div>
            <div class="yb-row"><span>Type</span><span>relevé YB historique</span></div>
            <div class="yb-row"><span>Vitesse</span><span>${histDetail?.speed != null ? histDetail.speed.toFixed(1) + ' kn' : '—'}</span></div>
            <div class="yb-row"><span>Cap</span><span>${histDetail?.course != null ? Math.round(histDetail.course) + '°' : '—'}</span></div>
            <div class="yb-row"><span>Position</span><span>${fmtCoords(hist.lat, hist.lon)}</span></div>
            <div class="yb-row"><span>Âge</span><span>il y a ${histAgeMin} min</span></div>
          </div>`;
        updateTimelineBadge(hist.lat, hist.lon, { timestamp: hist.at, popup });
        return;
      }

      // Reset : on n'est plus en mode passé, on remet le bateau au présent
      scrubbedToPast = false;
      setBoatTo(last.lat, last.lon, detail?.course);

      // === Mode FUTUR : projection ===
      if (deltaMs > PRESENT_TOL_MS) {
        const deltaH = deltaMs / 3_600_000;

        // On préfère la route polaire si dispo (plus précise car suit le vent prévu)
        if (currentRoute?.points?.length > 1) {
          const p = routePointAt(currentRoute, timestamp);
          if (p) {
            const popup = `
              <div class="yb-popup">
                <div class="yb-time">Projection @ ${new Date(timestamp).toLocaleString('fr-FR')}</div>
                <div class="yb-row"><span>Delta</span><span>+${deltaH.toFixed(1)} h</span></div>
                <div class="yb-row"><span>Source</span><span>polaire + Windy</span></div>
                <div class="yb-row"><span>TWA</span><span>${Math.round(p.twa)}°</span></div>
                <div class="yb-row"><span>TWS prévu</span><span>${p.tws.toFixed(1)} kn</span></div>
                <div class="yb-row"><span>Vitesse estimée</span><span>${p.speed.toFixed(1)} kn</span></div>
                <div class="yb-row"><span>Cap calculé</span><span>${Math.round(p.course)}°</span></div>
                <div class="yb-row"><span>Position</span><span>${fmtCoords(p.lat, p.lon)}</span></div>
              </div>`;
            updateTimelineBadge(p.lat, p.lon, { timestamp, popup });
            return;
          }
          // Si la route s'arrête avant le timestamp demandé (au-delà 10h), on tombe en mode classique
        }

        // Mode classique (fallback) : cap+vitesse constants
        if (!detail || detail.speed == null || detail.course == null || detail.speed <= 0) {
          clearTimelineMarker();
          return;
        }
        const distNm = detail.speed * deltaH;
        const dest = destinationPoint(last.lat, last.lon, detail.course, distNm);
        const popup = `
          <div class="yb-popup">
            <div class="yb-time">Projection @ ${new Date(timestamp).toLocaleString('fr-FR')}</div>
            <div class="yb-row"><span>Delta</span><span>+${deltaH.toFixed(1)} h</span></div>
            <div class="yb-row"><span>Hypothèse</span><span>cap+vitesse constants</span></div>
            <div class="yb-row"><span>Vitesse</span><span>${detail.speed.toFixed(1)} kn</span></div>
            <div class="yb-row"><span>Cap</span><span>${Math.round(detail.course)}°</span></div>
            <div class="yb-row"><span>Distance</span><span>${distNm.toFixed(0)} NM</span></div>
            <div class="yb-row"><span>Position</span><span>${fmtCoords(dest.lat, dest.lon)}</span></div>
          </div>`;
        updateTimelineBadge(dest.lat, dest.lon, { timestamp, popup });
        return;
      }

      // === Mode PRÉSENT : pas de badge, bateau au présent (déjà fait au-dessus) ===
      clearTimelineMarker();
    }

    // Abonnement à la timeline Windy (une seule fois)
    try {
      windyAPI.store.on('timestamp', (ts) => renderTimelineProjection(currentLast, currentDetail, ts));
    } catch (e) {
      console.warn('Windy timestamp subscription failed', e);
    }
    // Renvoie le point route le plus proche d'un timestamp cible
    function routePointAt(route, targetT) {
      if (!route?.points?.length) return null;
      let best = route.points[0];
      let bestDiff = Math.abs(best.at - targetT);
      for (const p of route.points) {
        const d = Math.abs(p.at - targetT);
        if (d < bestDiff) { bestDiff = d; best = p; }
      }
      return best;
    }

    function renderExtrap(last, detail) {
      clearExtrap();
      if (!showExtrap || !last || !detail) return;
      const speed = detail.speed;
      const course = detail.course;
      if (speed == null || course == null || speed <= 0) return;

      // ====== Ligne droite cap+vitesse constants (rouge dashed, classique) ======
      const straightPts = [[last.lat, last.lon]];
      EXTRAP_HOURS.forEach(h => {
        const distNm = speed * h;
        const dest = destinationPoint(last.lat, last.lon, course, distNm);
        straightPts.push([dest.lat, dest.lon]);
        const icon = L.divIcon({
          className: '',
          html: `<div class="extrap-badge extrap-straight">+${h}h</div>`,
          iconSize: [28, 15], iconAnchor: [14, 7],
        });
        const m = L.marker([dest.lat, dest.lon], { icon, interactive: true }).addTo(map);
        m.bindPopup(`
          <div class="yb-popup">
            <div class="yb-time">Projection +${h}h — ligne droite</div>
            <div class="yb-row"><span>Hypothèse</span><span>cap+vitesse constants</span></div>
            <div class="yb-row"><span>Vitesse</span><span>${speed.toFixed(1)} kn</span></div>
            <div class="yb-row"><span>Cap</span><span>${Math.round(course)}°</span></div>
            <div class="yb-row"><span>Distance</span><span>${distNm.toFixed(0)} NM</span></div>
            <div class="yb-row"><span>Position</span><span>${fmtCoords(dest.lat, dest.lon)}</span></div>
          </div>
        `);
        extrapMarkers.push(m);
      });
      extrapLine = L.polyline(straightPts, {
        color: '#d62828', weight: 1.5, opacity: 0.7, dashArray: '6, 6',
      }).addTo(map);

      // ====== Route polaire + Windy (bleu, TWA constant, courbée) ======
      if (currentRoute?.points?.length > 1) {
        // Translation : on ancre visuellement la route au boat marker actuel pour gommer
        // le léger lag de cache (cas où Mapei a émis un nouveau point YB depuis le compute)
        const start = currentRoute.points[0];
        const dLat = last.lat - start.lat;
        const dLon = last.lon - start.lon;
        const routePts = currentRoute.points.map(p => [p.lat + dLat, p.lon + dLon]);
        extrapPolarLine = L.polyline(routePts, {
          color: '#2563eb', weight: 2, opacity: 0.85, dashArray: '4, 6',
        }).addTo(map);

        EXTRAP_HOURS.forEach(h => {
          const targetT = last.at + h * 3_600_000;
          const p = routePointAt(currentRoute, targetT);
          if (!p) return;
          const badgeLat = p.lat + dLat;
          const badgeLon = p.lon + dLon;
          const icon = L.divIcon({
            className: '',
            html: `<div class="extrap-badge extrap-polar">${h}h</div>`,
            iconSize: [24, 15], iconAnchor: [12, 7],
          });
          const m = L.marker([badgeLat, badgeLon], { icon, interactive: true }).addTo(map);
          m.bindPopup(`
            <div class="yb-popup">
              <div class="yb-time">Projection +${h}h — routage TWA constant</div>
              <div class="yb-row"><span>Hypothèse</span><span>polaire + Windy forecast</span></div>
              <div class="yb-row"><span>TWA</span><span>${Math.round(p.twa)}°</span></div>
              <div class="yb-row"><span>TWS prévu</span><span>${p.tws.toFixed(1)} kn</span></div>
              <div class="yb-row"><span>Vitesse estimée</span><span>${p.speed.toFixed(1)} kn</span></div>
              <div class="yb-row"><span>Cap calculé</span><span>${Math.round(p.course)}°</span></div>
              <div class="yb-row"><span>Position</span><span>${fmtCoords(badgeLat, badgeLon)}</span></div>
              <div class="yb-row"><span>Note</span><span><i>indicatif</i></span></div>
            </div>
          `);
          extrapMarkers.push(m);
        });
      }
    }

    // === Rendu des segments colorés (vitesse) ===
    // Recrée tous les segments à chaque appel (simple et robuste pour ~500 segments)
    function renderSegments(track) {
      for (const s of segments) map.removeLayer(s);
      segments = [];
      for (let i = 1; i < track.length; i++) {
        const a = track[i - 1];
        const b = track[i];
        const sA = detailCache.get(a.id)?.speed;
        const sB = detailCache.get(b.id)?.speed;
        let avg = null;
        if (sA != null && sB != null) avg = (sA + sB) / 2;
        else if (sA != null) avg = sA;
        else if (sB != null) avg = sB;
        const color = speedColor(avg);
        const seg = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
          color, weight: 3, opacity: avg == null ? 0.4 : 0.85,
        }).addTo(map);
        segments.push(seg);
      }
    }

    function renderBoat(boat, now) {
      const detail = boat.lastDetail;
      const track = boat.track || [];
      const last = track.at(-1);
      if (!last) {
        document.getElementById('status-boat').textContent = '— en attente de position —';
        return;
      }
      currentTrack = track; // référence pour le rewind timeline

      const course = detail?.course ?? 0;
      if (!boatMarker) {
        boatMarker = L.marker([last.lat, last.lon], { icon: boatIcon(course), zIndexOffset: 1000 }).addTo(map);
      } else if (!scrubbedToPast) {
        // Si l'utilisateur a scrubbed la timeline Windy dans le passé, on ne touche pas au boat marker
        // (sinon il sauterait au présent à chaque refresh 15s)
        boatMarker.setLatLng([last.lat, last.lon]);
        boatMarker.setIcon(boatIcon(course));
      }

      renderSegments(track);

      // Points cliquables
      if (showPoints) {
        for (const p of track) {
          if (p === last) continue;
          if (pointMarkers.has(p.id)) continue;
          const cm = L.circleMarker([p.lat, p.lon], {
            radius: 3, color: '#222', fillColor: '#fff',
            fillOpacity: 0.9, weight: 1,
          }).addTo(map);
          cm.on('click', () => fetchAndShowDetail(cm, p));
          pointMarkers.set(p.id, cm);
        }
      }

      // Popup marker bateau
      const speed = fmtNum(detail?.speed, 'kn');
      const heading = fmtCourse(detail?.course);
      const age = now - last.at;
      boatMarker.bindPopup(`
        <div class="yb-popup">
          <div class="yb-time">${detail?.datetime || fmtDateFromAt(last.at)}</div>
          <div class="yb-row"><span>Vitesse</span><span>${speed}</span></div>
          <div class="yb-row"><span>Cap</span><span>${heading}</span></div>
          <div class="yb-row"><span>Position</span><span>${fmtCoords(last.lat, last.lon)}</span></div>
          <div class="yb-row"><span>—</span><span><i>${ageString(age)}</i></span></div>
        </div>
      `);

      document.getElementById('status-boat').innerHTML =
        `<b>Mapei</b> — ${speed} • cap ${heading}<br/>` +
        `<small>${ageString(age)}</small>`;
      document.getElementById('status-alert').classList.toggle('hidden', age <= ALERT_AGE_MS);

      // Extrapolation depuis le dernier point connu
      currentLast = last;
      currentDetail = detail;
      renderExtrap(last, detail);
      // Et le curseur dynamique synchronisé à la timeline Windy
      try { renderTimelineProjection(last, detail, windyAPI.store.get('timestamp')); } catch (e) { /* timestamp pas encore prêt */ }
    }

    function renderAis(ais, now) {
      if (!showAis) return;
      const seen = new Set();
      for (const v of ais) {
        const mmsi = v.mmsi;
        seen.add(mmsi);
        const last = v.track.at(-1);
        if (!last) continue;
        const ageMs = now - last.at;
        let m = aisMarkers.get(mmsi);
        if (!m) {
          m = L.marker([last.lat, last.lon], { icon: aisIcon(last.course, ageMs) }).addTo(map);
          aisMarkers.set(mmsi, m);
        } else {
          m.setLatLng([last.lat, last.lon]);
          m.setIcon(aisIcon(last.course, ageMs));
        }
        // Couleur du dernier report selon âge : vert (frais) → orange → rouge (vieux)
        const ageColor = ageMs > 30 * 60_000 ? '#b40000' : ageMs > 10 * 60_000 ? '#d97706' : '#16a34a';
        // Source et libellé d'identifiant adaptés
        const isMT = v.source === 'marinetraffic' || String(mmsi).startsWith('mt_');
        const sourceLabel = isMT ? 'MarineTraffic' : (v.source === 'aisstream' ? 'aisstream.io' : '—');
        const idLabel = isMT ? 'ID MT' : 'MMSI';
        const idValue = isMT ? String(mmsi).replace(/^mt_/, '') : mmsi;
        m.bindPopup(`
          <div class="yb-popup">
            <div class="yb-time">${v.name || (isMT ? 'Sans nom' : 'MMSI ' + mmsi)}</div>
            <div class="yb-row"><span>Dernier report</span><span style="color:${ageColor};font-weight:600">${ageString(ageMs)}</span></div>
            ${v.callsign ? `<div class="yb-row"><span>Indicatif</span><span>${v.callsign}</span></div>` : ''}
            <div class="yb-row"><span>${idLabel}</span><span>${idValue}</span></div>
            <div class="yb-row"><span>Vitesse</span><span>${fmtNum(last.speed, 'kn')}</span></div>
            <div class="yb-row"><span>Cap</span><span>${fmtCourse(last.course)}</span></div>
            <div class="yb-row"><span>Position</span><span>${fmtCoords(last.lat, last.lon)}</span></div>
            <div class="yb-row"><span>Source</span><span>${sourceLabel}</span></div>
          </div>
        `);

        if (v.track.length > 1) {
          const latlngs = v.track.map(p => [p.lat, p.lon]);
          let t = aisTracks.get(mmsi);
          if (!t) {
            // Trace cyan vif avec halo blanc derrière pour contraster sur le fond vent
            const halo = L.polyline(latlngs, { color: '#ffffff', weight: 3, opacity: 0.55 }).addTo(map);
            const line = L.polyline(latlngs, { color: '#22d3ee', weight: 1.5, opacity: 0.95 }).addTo(map);
            t = { halo, line };
            aisTracks.set(mmsi, t);
          } else {
            t.halo.setLatLngs(latlngs);
            t.line.setLatLngs(latlngs);
          }
        }
      }
      // Retire MMSI disparus
      for (const [mmsi, m] of aisMarkers) {
        if (!seen.has(mmsi)) { map.removeLayer(m); aisMarkers.delete(mmsi); }
      }
      for (const [mmsi, t] of aisTracks) {
        if (!seen.has(mmsi)) {
          map.removeLayer(t.halo); map.removeLayer(t.line);
          aisTracks.delete(mmsi);
        }
      }
    }

    function clearAis() {
      for (const m of aisMarkers.values()) map.removeLayer(m);
      aisMarkers.clear();
      for (const t of aisTracks.values()) { map.removeLayer(t.halo); map.removeLayer(t.line); }
      aisTracks.clear();
    }

    // === Refresh loop ===
    let refreshFailures = 0;
    async function refresh() {
      let s, d;
      try {
        const [rState, rDetails, rRoute] = await Promise.all([
          fetch('/api/state'),
          fetch('/api/track-details'),
          fetch('/api/route').then(r => r.ok ? r.json() : null).catch(() => null),
        ]);
        if (!rState.ok) throw new Error('HTTP state ' + rState.status);
        s = await rState.json();
        d = rDetails.ok ? (await rDetails.json()).details : {};
        currentRoute = rRoute;
        refreshFailures = 0;
      } catch (e) {
        refreshFailures++;
        document.getElementById('status-boat').textContent =
          `⚠ Serveur injoignable (${refreshFailures} essais)`;
        return;
      }
      for (const [k, v] of Object.entries(d)) detailCache.set(Number(k), v);
      renderBoat(s.boat, s.now);
      renderAis(s.ais, s.now);
    }

    // === Contrôles UI ===
    const aisToggle = document.getElementById('toggle-ais');
    aisToggle.checked = showAis;
    aisToggle.addEventListener('change', e => {
      showAis = e.target.checked;
      localStorage.setItem(LS_AIS, showAis ? '1' : '0');
      if (!showAis) clearAis();
      else refresh();
    });

    const pointsToggle = document.getElementById('toggle-points');
    pointsToggle.checked = showPoints;
    pointsToggle.addEventListener('change', e => {
      showPoints = e.target.checked;
      localStorage.setItem(LS_POINTS, showPoints ? '1' : '0');
      if (!showPoints) {
        for (const cm of pointMarkers.values()) map.removeLayer(cm);
        pointMarkers.clear();
      } else {
        refresh();
      }
    });

    const extrapToggle = document.getElementById('toggle-extrap');
    extrapToggle.checked = showExtrap;
    extrapToggle.addEventListener('change', e => {
      showExtrap = e.target.checked;
      localStorage.setItem(LS_EXTRAP, showExtrap ? '1' : '0');
      if (!showExtrap) {
        clearExtrap();
        clearTimelineMarker();
      } else {
        refresh();
      }
    });

    document.getElementById('center-boat').addEventListener('click', () => {
      if (boatMarker) map.setView(boatMarker.getLatLng(), 9);
    });

    // Toggle pliage des contrôles (desktop ET mobile). Panel toujours replié par défaut.
    const controlsEl = document.getElementById('controls');
    const controlsToggle = document.getElementById('controls-toggle');
    controlsToggle.addEventListener('click', () => controlsEl.classList.toggle('collapsed'));
    controlsEl.classList.add('collapsed');

    // Bulle d'aide
    const helpBtn = document.getElementById('help-btn');
    const helpModal = document.getElementById('help-modal');
    const helpClose = document.getElementById('help-close');
    helpBtn.addEventListener('click', () => helpModal.classList.remove('hidden'));
    helpClose.addEventListener('click', () => helpModal.classList.add('hidden'));
    helpModal.addEventListener('click', (e) => {
      if (e.target === helpModal) helpModal.classList.add('hidden');
    });

    // === Lancement ===
    renderBoat(initialState.boat, initialState.now);
    renderAis(initialState.ais, initialState.now);
    setInterval(refresh, REFRESH_MS);
  }
})();
