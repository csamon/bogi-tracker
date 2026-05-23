// Logique carte : pull /api/state toutes les 60s, met à jour marqueurs et traces
(() => {
  const MAP_REFRESH_MS = 60_000;
  const ALERT_AGE_MS = 45 * 60 * 1000;
  const LS_BASEMAP = 'bogi.basemap';
  const LS_WIND = 'bogi.wind';
  const LS_AISTRACKS = 'bogi.aisTracks';

  // Définition des fonds de carte. seamap est un overlay nautique posé sur OSM.
  const TILES = {
    osm: {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      opts: { attribution: '© OpenStreetMap', maxZoom: 19 },
    },
    esri: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      opts: { attribution: 'Tiles © Esri', maxZoom: 19 },
    },
    seamap: {
      url: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
      opts: { attribution: '© OpenSeaMap', maxZoom: 18, base: 'osm' },
    },
  };

  const map = L.map('map', { zoomControl: true }).setView([47.7, -3.4], 7);

  // Couche de base + overlay nautique éventuel
  let baseLayer = null;
  let overlayLayer = null;
  function setBasemap(name) {
    if (baseLayer) { map.removeLayer(baseLayer); baseLayer = null; }
    if (overlayLayer) { map.removeLayer(overlayLayer); overlayLayer = null; }
    const t = TILES[name] || TILES.osm;
    if (t.opts.base) {
      const base = TILES[t.opts.base];
      baseLayer = L.tileLayer(base.url, base.opts).addTo(map);
      overlayLayer = L.tileLayer(t.url, t.opts).addTo(map);
    } else {
      baseLayer = L.tileLayer(t.url, t.opts).addTo(map);
    }
    localStorage.setItem(LS_BASEMAP, name);
  }
  const basemapSelect = document.getElementById('basemap');
  basemapSelect.value = localStorage.getItem(LS_BASEMAP) || 'osm';
  setBasemap(basemapSelect.value);
  basemapSelect.addEventListener('change', e => setBasemap(e.target.value));

  // Overlay Windy en iframe semi-transparent (purement visuel, non interactif).
  // Pour une vraie intégration on basculera en mode "Windy Map API" en v2.
  let windFrame = null;
  async function setWind(on) {
    if (on && !windFrame) {
      try {
        const r = await fetch('/api/windy-key');
        const { key } = await r.json();
        const c = map.getCenter();
        const z = map.getZoom();
        const url = `https://embed.windy.com/embed2.html?lat=${c.lat}&lon=${c.lng}&zoom=${z}&level=surface&overlay=wind&menu=&message=&marker=&calendar=&pressure=&type=map&location=coordinates&detail=&metricWind=knots&metricTemp=%C2%B0C&radarRange=-1&key=${key}`;
        windFrame = document.createElement('iframe');
        windFrame.id = 'wind-frame';
        windFrame.src = url;
        document.body.appendChild(windFrame);
      } catch (e) {
        console.error('Impossible de charger Windy', e);
      }
    } else if (!on && windFrame) {
      windFrame.remove();
      windFrame = null;
    }
    localStorage.setItem(LS_WIND, on ? '1' : '0');
  }
  const windToggle = document.getElementById('toggle-wind');
  windToggle.checked = localStorage.getItem(LS_WIND) === '1';
  if (windToggle.checked) setWind(true);
  windToggle.addEventListener('change', e => setWind(e.target.checked));

  // Toggle affichage des traces AIS
  let showAisTracks = localStorage.getItem(LS_AISTRACKS) !== '0';
  const aisTracksToggle = document.getElementById('toggle-ais-tracks');
  aisTracksToggle.checked = showAisTracks;
  aisTracksToggle.addEventListener('change', e => {
    showAisTracks = e.target.checked;
    localStorage.setItem(LS_AISTRACKS, showAisTracks ? '1' : '0');
    if (!showAisTracks) {
      for (const t of aisTracks.values()) map.removeLayer(t);
      aisTracks.clear();
    }
  });

  // Bouton recentrage sur Mapei
  document.getElementById('center-boat').addEventListener('click', () => {
    if (boatMarker) map.setView(boatMarker.getLatLng(), 9);
  });

  // Marqueurs et traces
  let boatMarker = null;
  let boatTrack = null;
  const aisMarkers = new Map();
  const aisTracks = new Map();

  function boatIcon(course) {
    return L.divIcon({
      className: '',
      html: `<div class="boat-marker" style="transform: rotate(${course || 0}deg);"></div>`,
      iconSize: [24, 24], iconAnchor: [12, 12],
    });
  }
  function aisIcon(course) {
    return L.divIcon({
      className: '',
      html: `<div class="ais-marker" style="transform: rotate(${course || 0}deg);"></div>`,
      iconSize: [14, 14], iconAnchor: [7, 7],
    });
  }

  function ageString(ms) {
    if (ms < 0) return 'à l\'instant';
    if (ms < 60_000) return `il y a ${Math.round(ms / 1000)} s`;
    if (ms < 3600_000) return `il y a ${Math.round(ms / 60_000)} min`;
    return `il y a ${(ms / 3600_000).toFixed(1)} h`;
  }

  let firstFit = true;
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
    updateBoat(s.boat, s.now);
    updateAis(s.ais, s.now);
  }

  function updateBoat(boat, now) {
    const detail = boat.lastDetail;
    const track = boat.track || [];
    const last = track[track.length - 1];
    if (!last) {
      document.getElementById('status-boat').textContent = '— en attente de position —';
      return;
    }
    const course = detail?.course ?? 0;
    if (!boatMarker) {
      boatMarker = L.marker([last.lat, last.lon], { icon: boatIcon(course), zIndexOffset: 1000 }).addTo(map);
    } else {
      boatMarker.setLatLng([last.lat, last.lon]);
      boatMarker.setIcon(boatIcon(course));
    }

    const latlngs = track.map(p => [p.lat, p.lon]);
    if (!boatTrack) {
      boatTrack = L.polyline(latlngs, { color: '#d62828', weight: 3, opacity: 0.85 }).addTo(map);
    } else {
      boatTrack.setLatLngs(latlngs);
    }

    if (firstFit) {
      map.setView([last.lat, last.lon], 9);
      firstFit = false;
    }

    const age = now - last.at;
    const speed = detail?.speed != null ? `${detail.speed.toFixed(1)} kn` : '—';
    const heading = detail?.course != null ? `${Math.round(detail.course)}°` : '—';
    const temp = detail?.temp != null ? `${detail.temp.toFixed(1)} °C` : '—';

    document.getElementById('status-boat').innerHTML =
      `<b>Mapei</b> — ${speed} • cap ${heading} • ${temp}<br/>` +
      `<small>${ageString(age)} · ${track.length} pts</small>`;
    document.getElementById('status-alert').classList.toggle('hidden', age <= ALERT_AGE_MS);

    boatMarker.bindPopup(
      `<b>Allagrande Mapei</b><br/>` +
      `Vitesse : ${speed}<br/>Cap : ${heading}<br/>Temp eau : ${temp}<br/>` +
      `Position : ${last.lat.toFixed(4)}, ${last.lon.toFixed(4)}<br/>` +
      `<small>${ageString(age)}</small>`
    );
  }

  function updateAis(ais, now) {
    const seen = new Set();
    for (const v of ais) {
      const mmsi = v.mmsi;
      seen.add(mmsi);
      const last = v.track[v.track.length - 1];
      if (!last) continue;
      let m = aisMarkers.get(mmsi);
      if (!m) {
        m = L.marker([last.lat, last.lon], { icon: aisIcon(last.course) }).addTo(map);
        aisMarkers.set(mmsi, m);
      } else {
        m.setLatLng([last.lat, last.lon]);
        m.setIcon(aisIcon(last.course));
      }
      m.bindPopup(
        `<b>${v.name || 'MMSI ' + mmsi}</b><br/>` +
        (v.callsign ? `Indicatif : ${v.callsign}<br/>` : '') +
        `MMSI : ${mmsi}<br/>` +
        (last.speed != null ? `Vitesse : ${last.speed.toFixed(1)} kn<br/>` : '') +
        (last.course != null ? `Cap : ${Math.round(last.course)}°<br/>` : '') +
        `Position : ${last.lat.toFixed(4)}, ${last.lon.toFixed(4)}<br/>` +
        `<small>${ageString(now - last.at)}</small>`
      );

      if (showAisTracks && v.track.length > 1) {
        const latlngs = v.track.map(p => [p.lat, p.lon]);
        let t = aisTracks.get(mmsi);
        if (!t) {
          t = L.polyline(latlngs, { color: '#006d77', weight: 2, opacity: 0.55 }).addTo(map);
          aisTracks.set(mmsi, t);
        } else {
          t.setLatLngs(latlngs);
        }
      }
    }
    // Retirer les MMSI disparus (sortis de la fenêtre 30 min ou de la bbox)
    for (const [mmsi, m] of aisMarkers) {
      if (!seen.has(mmsi)) { map.removeLayer(m); aisMarkers.delete(mmsi); }
    }
    for (const [mmsi, t] of aisTracks) {
      if (!seen.has(mmsi)) { map.removeLayer(t); aisTracks.delete(mmsi); }
    }
    document.getElementById('status-ais').textContent =
      `AIS : ${ais.length} cible${ais.length > 1 ? 's' : ''}`;
  }

  refresh();
  setInterval(refresh, MAP_REFRESH_MS);
})();
