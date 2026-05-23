// Bogi Tracker — frontend Windy Plugin API + marker Mapei + AIS + points YB cliquables
(() => {
  const REFRESH_MS = 60_000;
  const ALERT_AGE_MS = 45 * 60 * 1000;
  const LS_AIS_TRACKS = 'bogi.aisTracks';
  const LS_POINTS = 'bogi.points';

  // État UI
  let showAisTracks = localStorage.getItem(LS_AIS_TRACKS) !== '0';
  let showPoints = localStorage.getItem(LS_POINTS) !== '0';

  // Bootstrap : on récupère la clé Windy + un premier snapshot, puis on initialise Windy
  (async () => {
    let key, initialState;
    try {
      const [r1, r2] = await Promise.all([fetch('/api/windy-key'), fetch('/api/state')]);
      if (!r1.ok || !r2.ok) throw new Error('boot fetch a échoué');
      key = (await r1.json()).key;
      initialState = await r2.json();
    } catch (e) {
      document.getElementById('status-boat').textContent = '⚠ Erreur de chargement initial';
      console.error(e);
      return;
    }

    const last = initialState.boat?.track?.at(-1);
    const lat = last?.lat ?? 47;
    const lon = last?.lon ?? -3;

    // Vérifie que libBoot.js a exposé windyInit (sinon erreur réseau Windy)
    // eslint-disable-next-line no-undef
    if (typeof windyInit !== 'function') {
      document.getElementById('status-boat').textContent = '⚠ Windy non chargé';
      return;
    }

    // Init Windy : on évite overlay/level dans les options initiales
    // (à set via api.store.set() une fois l'API prête, sinon plante sur certaines versions)
    // eslint-disable-next-line no-undef
    windyInit({
      key,
      verbose: false,
      lat,
      lon,
      zoom: 7,
    }, (windyAPI) => bootMap(windyAPI, initialState));
  })();

  function bootMap(windyAPI, initialState) {
    const map = windyAPI.map; // L.Map instance Leaflet 1.4.0
    // Active l'overlay vent (set après init pour compat versions Windy)
    try { windyAPI.store.set('overlay', 'wind'); } catch (e) { console.warn('overlay set failed', e); }

    // === Helpers d'icônes ===
    function boatIcon(course) {
      return L.divIcon({
        className: '',
        html: `<div class="boat-marker" style="transform: rotate(${course || 0}deg);"></div>`,
        iconSize: [28, 28], iconAnchor: [14, 14],
      });
    }
    function aisIcon(course) {
      return L.divIcon({
        className: '',
        html: `<div class="ais-marker" style="transform: rotate(${course || 0}deg);"></div>`,
        iconSize: [14, 14], iconAnchor: [7, 7],
      });
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
      try {
        return new Date(at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
      } catch {
        return '—';
      }
    }
    function fmtNum(v, suffix, digits = 1) {
      if (v == null || Number.isNaN(v)) return '—';
      return `${Number(v).toFixed(digits)} ${suffix}`;
    }
    function fmtCourse(v) {
      if (v == null || Number.isNaN(v)) return '—';
      return `${Math.round(v)}°`;
    }
    function fmtCoords(lat, lon) {
      return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    }

    // === Popup YB ===
    function pointPopupHtml(point, detail, loading = false) {
      const when = detail?.datetime ? detail.datetime : fmtDateFromAt(point.at);
      const rows = loading
        ? `<div class="yb-loading">Chargement…</div>`
        : `
          <div class="yb-row"><span>Vitesse</span><span>${fmtNum(detail?.speed, 'kn')}</span></div>
          <div class="yb-row"><span>Cap</span><span>${fmtCourse(detail?.course)}</span></div>
          <div class="yb-row"><span>Temp eau</span><span>${fmtNum(detail?.temp, '°C')}</span></div>
          <div class="yb-row"><span>Position</span><span>${fmtCoords(point.lat, point.lon)}</span></div>
        `;
      return `<div class="yb-popup"><div class="yb-time">${when}</div>${rows}</div>`;
    }

    // === État des couches ===
    let boatMarker = null;
    let boatTrack = null;
    const pointMarkers = new Map();   // id -> L.circleMarker
    const aisMarkers = new Map();     // mmsi -> L.marker
    const aisTracks = new Map();      // mmsi -> L.polyline
    const detailCache = new Map();    // id -> detail (côté client, pour éviter de re-fetcher)

    // Lance le fetch de détail d'un point, met à jour le popup quand ça arrive
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

    // === Couches YB ===
    function renderBoat(boat, now) {
      const detail = boat.lastDetail;
      const track = boat.track || [];
      const last = track.at(-1);
      if (!last) {
        document.getElementById('status-boat').textContent = '— en attente de position —';
        return;
      }

      // Marker arrow rouge du dernier point
      const course = detail?.course ?? 0;
      if (!boatMarker) {
        boatMarker = L.marker([last.lat, last.lon], { icon: boatIcon(course), zIndexOffset: 1000 }).addTo(map);
      } else {
        boatMarker.setLatLng([last.lat, last.lon]);
        boatMarker.setIcon(boatIcon(course));
      }

      // Polyline complète
      const latlngs = track.map(p => [p.lat, p.lon]);
      if (!boatTrack) {
        boatTrack = L.polyline(latlngs, { color: '#d62828', weight: 3, opacity: 0.85 }).addTo(map);
      } else {
        boatTrack.setLatLngs(latlngs);
      }

      // Points cliquables — un par position (sauf le dernier qui est le boatMarker)
      if (showPoints) {
        for (const p of track) {
          if (p === last) continue;
          if (pointMarkers.has(p.id)) continue;
          const cm = L.circleMarker([p.lat, p.lon], {
            radius: 3,
            color: '#d62828',
            fillColor: '#d62828',
            fillOpacity: 0.8,
            weight: 1,
          }).addTo(map);
          cm.on('click', () => fetchAndShowDetail(cm, p));
          pointMarkers.set(p.id, cm);
        }
      }

      // Popup du marker bateau (détail du dernier point déjà connu)
      const speed = fmtNum(detail?.speed, 'kn');
      const heading = fmtCourse(detail?.course);
      const temp = fmtNum(detail?.temp, '°C');
      const age = now - last.at;
      boatMarker.bindPopup(`
        <div class="yb-popup">
          <div class="yb-time">${detail?.datetime || fmtDateFromAt(last.at)}</div>
          <div class="yb-row"><span>Vitesse</span><span>${speed}</span></div>
          <div class="yb-row"><span>Cap</span><span>${heading}</span></div>
          <div class="yb-row"><span>Temp eau</span><span>${temp}</span></div>
          <div class="yb-row"><span>Position</span><span>${fmtCoords(last.lat, last.lon)}</span></div>
          <div class="yb-row"><span>—</span><span><i>${ageString(age)}</i></span></div>
        </div>
      `);

      // Bandeau d'état
      document.getElementById('status-boat').innerHTML =
        `<b>Mapei</b> — ${speed} • cap ${heading} • ${temp}<br/>` +
        `<small>${ageString(age)} · ${track.length} pts</small>`;
      document.getElementById('status-alert').classList.toggle('hidden', age <= ALERT_AGE_MS);
    }

    // === Couches AIS ===
    function renderAis(ais, now) {
      const seen = new Set();
      for (const v of ais) {
        const mmsi = v.mmsi;
        seen.add(mmsi);
        const last = v.track.at(-1);
        if (!last) continue;
        let m = aisMarkers.get(mmsi);
        if (!m) {
          m = L.marker([last.lat, last.lon], { icon: aisIcon(last.course) }).addTo(map);
          aisMarkers.set(mmsi, m);
        } else {
          m.setLatLng([last.lat, last.lon]);
          m.setIcon(aisIcon(last.course));
        }
        m.bindPopup(`
          <div class="yb-popup">
            <div class="yb-time">${v.name || 'MMSI ' + mmsi}</div>
            ${v.callsign ? `<div class="yb-row"><span>Indicatif</span><span>${v.callsign}</span></div>` : ''}
            <div class="yb-row"><span>MMSI</span><span>${mmsi}</span></div>
            <div class="yb-row"><span>Vitesse</span><span>${fmtNum(last.speed, 'kn')}</span></div>
            <div class="yb-row"><span>Cap</span><span>${fmtCourse(last.course)}</span></div>
            <div class="yb-row"><span>Position</span><span>${fmtCoords(last.lat, last.lon)}</span></div>
            <div class="yb-row"><span>—</span><span><i>${ageString(now - last.at)}</i></span></div>
          </div>
        `);

        if (showAisTracks && v.track.length > 1) {
          const latlngs = v.track.map(p => [p.lat, p.lon]);
          let t = aisTracks.get(mmsi);
          if (!t) {
            t = L.polyline(latlngs, { color: '#006d77', weight: 2, opacity: 0.6 }).addTo(map);
            aisTracks.set(mmsi, t);
          } else {
            t.setLatLngs(latlngs);
          }
        }
      }
      // Cleanup des MMSI disparus
      for (const [mmsi, m] of aisMarkers) {
        if (!seen.has(mmsi)) { map.removeLayer(m); aisMarkers.delete(mmsi); }
      }
      for (const [mmsi, t] of aisTracks) {
        if (!seen.has(mmsi)) { map.removeLayer(t); aisTracks.delete(mmsi); }
      }
      document.getElementById('status-ais').textContent =
        `AIS : ${ais.length} cible${ais.length > 1 ? 's' : ''}`;
    }

    // === Refresh loop ===
    let refreshFailures = 0;
    async function refresh() {
      let s;
      try {
        const r = await fetch('/api/state');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        s = await r.json();
        refreshFailures = 0;
      } catch (e) {
        refreshFailures++;
        document.getElementById('status-boat').textContent =
          `⚠ Serveur injoignable (${refreshFailures} essais)`;
        return;
      }
      renderBoat(s.boat, s.now);
      renderAis(s.ais, s.now);
    }

    // === Contrôles UI ===
    const aisTracksToggle = document.getElementById('toggle-ais-tracks');
    aisTracksToggle.checked = showAisTracks;
    aisTracksToggle.addEventListener('change', e => {
      showAisTracks = e.target.checked;
      localStorage.setItem(LS_AIS_TRACKS, showAisTracks ? '1' : '0');
      if (!showAisTracks) {
        for (const t of aisTracks.values()) map.removeLayer(t);
        aisTracks.clear();
      }
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
        // Redéclenche un refresh pour repeupler
        refresh();
      }
    });

    document.getElementById('center-boat').addEventListener('click', () => {
      if (boatMarker) map.setView(boatMarker.getLatLng(), 9);
    });

    // === Lancement ===
    renderBoat(initialState.boat, initialState.now);
    renderAis(initialState.ais, initialState.now);
    setInterval(refresh, REFRESH_MS);
  }
})();
