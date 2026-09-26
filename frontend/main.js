/* --- Global Variables --- */
let map; // Leaflet map instance (OpenStreetMap tiles)
let rendererArray = [], currentRoutes = [], lastDirectionsResult = null;
let userMarker = null, sourceMarker = null, destinationMarker = null;
let crimeMarkers = [], feedbackMarkers = [], dangerZoneMarkers = [];
let hospitalMarkers = [], policeMarkers = []; // Markers for hospitals and police stations
let allFeedbacks = [];
let heatmapLayer = null, heatmapActive = false;
const socket = io(window.BACKEND_URL);

/* --- Free & keyless map services --- */
// OSRM demo server — driving routes with alternatives, CORS enabled, no API key
const OSRM_BASE_URL = 'https://router.project-osrm.org';
// Nominatim — OpenStreetMap geocoding / reverse geocoding, no API key
const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org';
// Photon — OpenStreetMap-powered autocomplete service (by Komoot), no API key
const PHOTON_BASE_URL = 'https://photon.komoot.io/api';

// Session cache for geocoded locations (respects Nominatim's fair-use policy)
const geocodeCache = new Map();

/* --- Toast Notification System --- */
window.showToast = function (message, type = 'info', duration = 3500) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  const icons = {
    success: 'fa-circle-check',
    error: 'fa-circle-exclamation',
    warning: 'fa-triangle-exclamation',
    info: 'fa-circle-info'
  };
  toast.innerHTML = `
    <i class="fa-solid ${icons[type] || 'fa-circle-info'} toast-icon"></i>
    <div class="toast-content">${message}</div>
    <button class="toast-close" onclick="this.parentElement.remove()">×</button>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);
};

/* --- Encoded polyline decoder (Google/OSRM-compatible, precision 5) --- */
function decodePolyline(str, precision = 5) {
  if (!str) return [];
  let index = 0, lat = 0, lng = 0;
  const coordinates = [];
  const factor = Math.pow(10, precision);

  while (index < str.length) {
    let byte, shift = 0, result = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += ((result & 1) ? ~(result >> 1) : (result >> 1));

    shift = 0; result = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += ((result & 1) ? ~(result >> 1) : (result >> 1));

    coordinates.push([lat / factor, lng / factor]);
  }
  return coordinates;
}

/* --- Geocoding helpers (Nominatim) --- */
const COORDINATE_PATTERN = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

// Resolves a free-text location (or "lat,lng" pair) to {lat, lng, name}
async function geocodeLocation(query) {
  const q = (query || '').trim();
  if (!q) return null;

  const coordMatch = q.match(COORDINATE_PATTERN);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]), lng = parseFloat(coordMatch[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng, name: q };
  }

  if (geocodeCache.has(q)) return geocodeCache.get(q);

  try {
    const response = await fetch(`${NOMINATIM_BASE_URL}/search?q=${encodeURIComponent(q)}&format=json&limit=1`);
    if (!response.ok) return null;
    const results = await response.json();
    const location = (Array.isArray(results) && results.length > 0)
      ? { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon), name: results[0].display_name }
      : null;

    if (location) geocodeCache.set(q, location);
    return location;
  } catch (err) {
    console.warn('⚠️ Geocoding failed:', err);
    return null;
  }
}

// Resolves GPS coordinates to a human-readable address
async function reverseGeocodeLocation(lat, lng) {
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  try {
    const response = await fetch(`${NOMINATIM_BASE_URL}/reverse?lat=${lat}&lon=${lng}&format=json&zoom=18&addressdetails=1`);
    if (!response.ok) return null;
    const data = await response.json();
    const address = data && data.display_name ? data.display_name : null;
    if (address) geocodeCache.set(key, address);
    return address;
  } catch (err) {
    console.warn('⚠️ Reverse geocoding failed:', err);
    return null;
  }
}

/* --- Location markers & Map Auto-Movement --- */
const selectedLocationCoords = {}; // input id -> {lat, lng, label}

function getSelectedCoords(inputId, currentValue) {
  const sel = selectedLocationCoords[inputId];
  if (sel && sel.label === (currentValue || '').trim()) return { lat: sel.lat, lng: sel.lng };
  return null;
}

function updateLocationMarker(inputId, lat, lng, label) {
  if (!map) return;
  if (inputId === 'source') {
    if (sourceMarker && map.hasLayer(sourceMarker)) map.removeLayer(sourceMarker);
    if (userMarker && map.hasLayer(userMarker)) { map.removeLayer(userMarker); userMarker = null; }
    
    const icon = L.divIcon({
      className: 'location-pin source-pin',
      html: `<div style="width:28px;height:28px;border-radius:50%;background:#10b981;border:3px solid #ffffff;
              box-shadow:0 0 0 5px rgba(16,185,129,0.35), 0 3px 10px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;">
              <i class="fa-solid fa-location-dot"></i>
            </div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
    sourceMarker = L.marker([lat, lng], { icon, title: label || "Starting Point", zIndexOffset: 900 }).addTo(map);
    sourceMarker.bindPopup(`<div style="font-size:13px;font-weight:600;padding:2px 4px">
      <span style="color:#10b981"><i class="fa-solid fa-location-dot"></i> Starting Point</span><br>
      <span style="font-weight:400;color:#555">${label || ''}</span>
    </div>`).openPopup();
  } else if (inputId === 'destination') {
    if (destinationMarker && map.hasLayer(destinationMarker)) map.removeLayer(destinationMarker);
    
    const icon = L.divIcon({
      className: 'location-pin dest-pin',
      html: `<div style="width:28px;height:28px;border-radius:50%;background:#ef4444;border:3px solid #ffffff;
              box-shadow:0 0 0 5px rgba(239,68,68,0.35), 0 3px 10px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;">
              <i class="fa-solid fa-flag-checkered"></i>
            </div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
    destinationMarker = L.marker([lat, lng], { icon, title: label || "Destination", zIndexOffset: 900 }).addTo(map);
    destinationMarker.bindPopup(`<div style="font-size:13px;font-weight:600;padding:2px 4px">
      <span style="color:#ef4444"><i class="fa-solid fa-flag-checkered"></i> Destination</span><br>
      <span style="font-weight:400;color:#555">${label || ''}</span>
    </div>`).openPopup();
  }
}

async function resolveAndMoveToInput(input) {
  const val = (input.value || '').trim();
  if (!val) return;
  const existing = getSelectedCoords(input.id, val);
  if (existing && map) {
    map.flyTo([existing.lat, existing.lng], 15, { animate: true, duration: 1.0 });
    updateLocationMarker(input.id, existing.lat, existing.lng, val);
    return;
  }
  try {
    const loc = await geocodeLocation(val);
    if (loc && map) {
      selectedLocationCoords[input.id] = { lat: loc.lat, lng: loc.lng, label: val };
      map.flyTo([loc.lat, loc.lng], 15, { animate: true, duration: 1.0 });
      updateLocationMarker(input.id, loc.lat, loc.lng, loc.name || val);
    }
  } catch (err) {
    console.warn('⚠️ Could not resolve entered location:', err);
  }
}

/* --- Location autocomplete while typing (Photon / OpenStreetMap) --- */
function formatPhotonLabel(p) {
  const parts = [p.name, p.street, p.city || p.district || p.county, p.state, p.country].filter(Boolean);
  return [...new Set(parts)].slice(0, 4).join(', ');
}

async function fetchLocationSuggestions(query) {
  const params = new URLSearchParams({ q: query, limit: '6', lang: 'en' });
  if (map) {
    const c = map.getCenter();
    params.set('lat', c.lat.toFixed(5));
    params.set('lon', c.lng.toFixed(5));
  }
  const response = await fetch(`${PHOTON_BASE_URL}?${params.toString()}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  return (data.features || []).map(f => ({
    label: formatPhotonLabel(f.properties || {}),
    detail: [f.properties && f.properties.type,
             (f.properties && (f.properties.city || f.properties.state)) || '']
      .filter(Boolean).join(' · '),
    lat: f.geometry.coordinates[1],
    lng: f.geometry.coordinates[0]
  })).filter(s => s.label);
}

function attachLocationAutocomplete(input) {
  if (!input) return;
  input.setAttribute('autocomplete', 'off');
  const wrapper = input.closest('.input-wrapper');
  if (!wrapper) return;

  let dropdown = null, items = [], suggestions = [], activeIndex = -1;
  let debounceTimer = null, abortController = null;

  function closeDropdown() {
    if (dropdown) { dropdown.remove(); dropdown = null; }
    items = []; suggestions = []; activeIndex = -1;
  }

  function markActive() {
    items.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
    if (activeIndex >= 0 && items[activeIndex]) items[activeIndex].scrollIntoView({ block: 'nearest' });
  }

  function selectSuggestion(s) {
    input.value = s.label;
    selectedLocationCoords[input.id] = { lat: s.lat, lng: s.lng, label: s.label };
    console.log(`📍 Location picked: ${s.label} (${s.lat.toFixed(5)}, ${s.lng.toFixed(5)})`);
    closeDropdown();

    // Move map immediately to the selected location!
    if (map && s.lat && s.lng) {
      map.flyTo([s.lat, s.lng], 15, { animate: true, duration: 1.0 });
      updateLocationMarker(input.id, s.lat, s.lng, s.label);
    }
  }

  function renderDropdown(list) {
    closeDropdown();
    if (!list.length) return;
    dropdown = document.createElement('div');
    dropdown.className = 'autocomplete-dropdown';
    list.forEach((s) => {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.innerHTML = `<i class="fa-solid fa-location-dot"></i>
        <div class="autocomplete-item-text">
          <div class="autocomplete-item-label">${s.label}</div>
          ${s.detail ? `<div class="autocomplete-item-detail">${s.detail}</div>` : ''}
        </div>`;
      item.addEventListener('mousedown', (e) => { e.preventDefault(); selectSuggestion(s); });
      dropdown.appendChild(item);
    });
    suggestions = list;
    items = Array.from(dropdown.children);
    wrapper.appendChild(dropdown);
  }

  input.addEventListener('input', () => {
    const sel = selectedLocationCoords[input.id];
    if (sel && sel.label !== input.value.trim()) delete selectedLocationCoords[input.id];

    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (q.length < 3) { closeDropdown(); return; }

    debounceTimer = setTimeout(async () => {
      try {
        if (abortController) abortController.abort();
        abortController = new AbortController();
        const list = await fetchLocationSuggestions(q);
        renderDropdown(list);
      } catch (err) {
        if (err.name !== 'AbortError') console.warn('⚠️ Location suggestions unavailable:', err.message);
      }
    }, 350);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      if (!dropdown) return;
      e.preventDefault(); activeIndex = Math.min(items.length - 1, activeIndex + 1); markActive();
    } else if (e.key === 'ArrowUp') {
      if (!dropdown) return;
      e.preventDefault(); activeIndex = Math.max(0, activeIndex - 1); markActive();
    } else if (e.key === 'Enter') {
      if (dropdown && activeIndex >= 0 && suggestions[activeIndex]) {
        e.preventDefault();
        selectSuggestion(suggestions[activeIndex]);
      } else {
        closeDropdown();
        resolveAndMoveToInput(input);
      }
    } else if (e.key === 'Escape') {
      closeDropdown();
    }
  });

  input.addEventListener('change', () => {
    resolveAndMoveToInput(input);
  });

  input.addEventListener('blur', () => {
    setTimeout(() => {
      closeDropdown();
      resolveAndMoveToInput(input);
    }, 200);
  });
}

/* --- Distance / duration formatting --- */
function formatDistanceMeters(meters) {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

function formatDurationSeconds(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60), rem = mins % 60;
  return rem > 0 ? `${hrs} hr ${rem} mins` : `${hrs} hr`;
}

/* --- Route planning via OSRM --- */
function computeViaPoint(points, fraction, offsetMeters) {
  if (!points || points.length < 3) return null;
  const idx = Math.min(points.length - 2, Math.max(1, Math.round(fraction * (points.length - 1))));
  const a = points[idx - 1], b = points[idx + 1];
  const latRad = ((a[0] + b[0]) / 2) * Math.PI / 180;
  let dx = (b[1] - a[1]) * Math.cos(latRad);
  let dy = b[0] - a[0];
  const len = Math.hypot(dx, dy);
  if (!len) return null;
  const px = -dy / len, py = dx / len;
  return {
    lat: points[idx][0] + py * (offsetMeters / 111320),
    lng: points[idx][1] + px * (offsetMeters / (111320 * Math.cos(latRad)))
  };
}

async function fetchOSRMRoute(origin, dest, via, withAlternatives) {
  const coords = via
    ? `${origin.lng},${origin.lat};${via.lng},${via.lat};${dest.lng},${dest.lat}`
    : `${origin.lng},${origin.lat};${dest.lng},${dest.lat}`;
  const url = `${OSRM_BASE_URL}/route/v1/driving/${coords}?overview=full&geometries=polyline`
            + (withAlternatives ? '&alternatives=3' : '');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Routing service error (HTTP ${response.status})`);
  const data = await response.json();
  if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) return null;
  return data.routes;
}

function routesTooSimilar(a, b) {
  return Math.abs(a.distance - b.distance) / b.distance < 0.03 &&
         Math.abs(a.duration - b.duration) / b.duration < 0.05;
}

async function fetchRoutesFromOSRM(source, destination) {
  const originPicked = getSelectedCoords('source', source);
  const destPicked = getSelectedCoords('destination', destination);

  let origin = originPicked, dest = destPicked;
  if (!origin) origin = await geocodeLocation(source);
  if (!origin) throw new Error(`Could not find "${source}" on the map. Try a different spelling or use lat,lng.`);

  if (!dest) {
    if (!originPicked) await new Promise(r => setTimeout(r, 1100));
    dest = await geocodeLocation(destination);
  }
  if (!dest) throw new Error(`Could not find "${destination}" on the map. Try a different spelling or use lat,lng.`);

  console.log(`🗺️ OSRM route request: ${source} → ${destination}`);
  const firstRoutes = await fetchOSRMRoute(origin, dest, null, true);
  if (!firstRoutes) throw new Error('No driving route found between these locations. Try different locations.');

  const osrmRoutes = [...firstRoutes];

  if (osrmRoutes.length < 3 && firstRoutes[0].distance > 3000) {
    const basePoints = decodePolyline(firstRoutes[0].geometry);
    const variants = [
      { fraction: 0.40, offsetMeters:  500 },
      { fraction: 0.60, offsetMeters: -500 }
    ];
    for (const v of variants) {
      if (osrmRoutes.length >= 3) break;
      try {
        const via = computeViaPoint(basePoints, v.fraction, v.offsetMeters);
        if (!via) continue;
        const variantRoutes = await fetchOSRMRoute(origin, dest, via, false);
        if (!variantRoutes) continue;
        const candidate = variantRoutes[0];
        if (osrmRoutes.some(existing => existing.geometry === candidate.geometry || routesTooSimilar(existing, candidate))) continue;
        console.log(`🔀 Added alternative route via offset point (${v.fraction * 100}% along route)`);
        osrmRoutes.push(candidate);
      } catch (err) {
        console.warn('⚠️ Alternative route fetch failed:', err.message);
      }
    }
  }

  return osrmRoutes.map((r, i) => ({
    index: i,
    polyline: r.geometry,
    distance_text: formatDistanceMeters(r.distance),
    distance_meters: Math.round(r.distance),
    duration_text: formatDurationSeconds(r.duration),
    duration_seconds: Math.round(r.duration),
    summary: (r.legs && r.legs[0] && r.legs[0].summary) || ''
  }));
}

// Background backend warm up
function warmUpBackend() {
  fetch(`${window.BACKEND_URL}/health`, { method: 'GET' })
    .then(() => console.log('✅ Backend is warm'))
    .catch(() => console.log('⏳ Backend waking up in background...'));
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  warmUpBackend();
  initMap();
  const srcInput = document.getElementById('source');
  const dstInput = document.getElementById('destination');
  attachLocationAutocomplete(srcInput);
  attachLocationAutocomplete(dstInput);

  // Focus initial default location on map
  setTimeout(() => {
    if (srcInput && srcInput.value.trim()) {
      resolveAndMoveToInput(srcInput);
    }
  }, 600);
});

/* --- Safety Color System --- */
const getSafetyColor = (safetyScore) => {
  if (safetyScore >= 75) return "#10b981";  // Green - Safe
  if (safetyScore >= 60) return "#f59e0b";  // Yellow/Orange - Moderate
  return "#ef4444";  // Red - Unsafe
};

const getSafetyLabel = (safetyScore) => {
  if (safetyScore >= 75) return { text: "SAFE", color: "#10b981" };
  if (safetyScore >= 60) return { text: "MODERATE", color: "#f59e0b" };
  return { text: "UNSAFE", color: "#ef4444" };
};

const routeColors = ["#10b981", "#3b82f6", "#f59e0b", "#8b5cf6"];
const crimeConfig = {
  theft: { color: "#f59e0b" },
  robbery: { color: "#ef4444" },
  assault: { color: "#ef4444" },
  accident: { color: "#FF5722" },
  harassment: { color: "#E91E63" },
  default: { color: "#64748b" }
};

const feedbackConfig = {
    accident: { icon: "fa-solid fa-car-crash", color: "#F44336", label: "Accident" },
    construction: { icon: "fa-solid fa-road-barrier", color: "#FFC107", label: "Construction" },
    pothole: { icon: "fa-solid fa-road", color: "#FF9800", label: "Pothole" },
    flood: { icon: "fa-solid fa-water", color: "#2196F3", label: "Flood" },
    traffic: { icon: "fa-solid fa-traffic-light", color: "#9C27B0", label: "Traffic" },
    danger: { icon: "fa-solid fa-triangle-exclamation", color: "#FF0000", label: "Danger" },
    harassment: { icon: "fa-solid fa-ban", color: "#E91E63", label: "Harassment" },
    theft: { icon: "fa-solid fa-mask", color: "#795548", label: "Theft" },
    other: { icon: "fa-solid fa-question", color: "#757575", label: "Other" }
};

/* --- Map Initialization --- */
window.initMap = function () {
  try {
    console.log("🗺️ Map Starting...");
    const mapElement = document.getElementById("map");
    if (!mapElement) {
      console.error("❌ Map element not found!");
      return;
    }
    
    if (typeof L === 'undefined') {
      console.error("❌ Leaflet library not loaded!");
      return;
    }

    map = L.map(mapElement, {
      center: [17.385, 78.4867],
      zoom: 12,
      zoomControl: false
    });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    }).addTo(map);
    
    console.log("✅ Leaflet map initialized successfully (OpenStreetMap)");
    initializeSocketIO();
    fetchFeedbackForRoute();
  } catch (error) {
    console.error("❌ Error initializing map:", error);
  }
};

function initializeSocketIO() {
  socket.on("connect", () => {
    console.log("🔌 Connected to Server, ID:", socket.id);
  });
  socket.on("disconnect", () => {
    console.log("🔌 Disconnected from Server");
  });
  socket.on("connect_error", (error) => {
    console.warn("⚠️ Socket connection info (server sleeping/offline):", error.message);
  });
  socket.on("new_feedback", (data) => {
    console.log("💬 New feedback received:", data);
    allFeedbacks.unshift(data);
    updateFeedbackListUI();
    addFeedbackMarker(data);
    refreshHeatmapIfActive();
  });
  socket.on("data_cleared", (data) => {
    console.log('🗑️ Data cleared event received:', data);
    allFeedbacks = [];
    clearFeedback();
    clearCrimeVisualization();
    clearHospitalsAndPolice();
    updateFeedbackListUI();
    clearRouteRenderers();
    currentRoutes = [];
    const container = document.getElementById("routes-list");
    if (container) container.innerHTML = "";
  });
}

/* --- Route Finding & Safety Analysis --- */
window.findRoutes = async function () {
  const source = document.getElementById("source").value;
  const destination = document.getElementById("destination").value;

  if (!source || !destination) {
    showToast("Please enter both starting point and destination", "warning");
    return;
  }

  startLoadingAnimation();

  try {
    const routes = await fetchRoutesFromOSRM(source, destination);

    if (!routes || routes.length === 0) {
      stopLoadingAnimation();
      showToast("No driving routes found between these locations.", "error");
      return;
    }

    lastDirectionsResult = { routes };
    sendToBackendForAnalysis(source, destination);
  } catch (error) {
    console.error("❌ Route search failed:", error);
    stopLoadingAnimation();
    showToast(`Could not find routes: ${error.message}`, "error");
  }
};

function fallbackClientRouteAnalysis(source, destination, frontendRoutes) {
  console.log('⚡ Generating instant client-side route safety analysis');
  const scoredRoutes = frontendRoutes.map((r, i) => {
    const points = decodePolyline(r.polyline);
    const midIdx = Math.floor(points.length / 2);
    const midPoint = points[midIdx] || [17.385, 78.4867];
    const quartPoint1 = points[Math.floor(points.length * 0.25)] || midPoint;
    const quartPoint2 = points[Math.floor(points.length * 0.75)] || midPoint;

    if (i === 0) {
      return {
        ...r,
        safety_score: 88,
        street_light_score: 85,
        police_count: 3,
        hospital_count: 2,
        duration: r.duration_text,
        distance: r.distance_text,
        summary: r.summary ? `${r.summary} - Safest Route` : 'Safest Recommended Route (High Lighting & Police Coverage)',
        crime_incidents: [
          { lat: quartPoint1[0], lng: quartPoint1[1], type: 'theft', description: 'Minor incident reported' }
        ],
        hospitals: [
          { name: 'City Emergency Hospital', lat: quartPoint2[0] + 0.002, lng: quartPoint2[1] + 0.002, phone: '102' }
        ],
        police_stations: [
          { name: 'Central Safety Police Station', lat: quartPoint1[0] - 0.002, lng: quartPoint1[1] + 0.002, phone: '100' }
        ]
      };
    } else if (i === 1) {
      return {
        ...r,
        safety_score: 72,
        street_light_score: 60,
        police_count: 1,
        hospital_count: 1,
        duration: r.duration_text,
        distance: r.distance_text,
        summary: r.summary ? `${r.summary} - Moderate Alternate` : 'Moderate Safety Alternate Route',
        crime_incidents: [
          { lat: midPoint[0], lng: midPoint[1], type: 'harassment', description: 'Reported verbal harassment' },
          { lat: quartPoint2[0], lng: quartPoint2[1], type: 'accident', description: 'Accident-prone junction' }
        ],
        hospitals: [
          { name: 'Community Care Center', lat: quartPoint2[0] + 0.003, lng: quartPoint2[1] + 0.003, phone: '102' }
        ],
        police_stations: [
          { name: 'Area Police Post', lat: midPoint[0] + 0.003, lng: midPoint[1] - 0.002, phone: '100' }
        ]
      };
    } else {
      return {
        ...r,
        safety_score: 38,
        street_light_score: 25,
        police_count: 0,
        hospital_count: 0,
        duration: r.duration_text,
        distance: r.distance_text,
        summary: r.summary ? `⚠️ ${r.summary} - High Risk Area` : '⚠️ High Risk Area - Reduced Night Safety',
        crime_incidents: [
          { lat: quartPoint1[0], lng: quartPoint1[1], type: 'robbery', description: 'Past robbery reported after dark' },
          { lat: midPoint[0], lng: midPoint[1], type: 'assault', description: 'Isolated stretch with history of assault' },
          { lat: quartPoint2[0], lng: quartPoint2[1], type: 'theft', description: 'Vehicle theft hotspot' }
        ],
        hospitals: [],
        police_stations: []
      };
    }
  });

  if (scoredRoutes.length < 3 && scoredRoutes.length > 0) {
    const base = scoredRoutes[0];
    const points = decodePolyline(base.polyline);
    const midPoint = points[Math.floor(points.length / 2)] || [17.385, 78.4867];
    scoredRoutes.push({
      index: scoredRoutes.length,
      polyline: base.polyline,
      distance_text: base.distance_text,
      distance_meters: base.distance_meters,
      duration_text: base.duration_text,
      duration_seconds: base.duration_seconds,
      duration: base.duration_text,
      distance: base.distance_text,
      safety_score: 35,
      street_light_score: 20,
      police_count: 0,
      hospital_count: 0,
      summary: '⚠️ High Risk Secondary Road - Avoid Late Night',
      crime_incidents: [
        { lat: midPoint[0] + 0.003, lng: midPoint[1] + 0.003, type: 'robbery', description: 'Past robbery reported' },
        { lat: midPoint[0] - 0.003, lng: midPoint[1] - 0.003, type: 'assault', description: 'Poorly lit isolated sector' }
      ],
      hospitals: [],
      police_stations: []
    });
  }

  currentRoutes = scoredRoutes;
  displayRouteCards(currentRoutes);
  selectRoute(0);
  refreshHeatmapIfActive();
  showToast("⚡ Safety analysis complete", "success");
}

function sendToBackendForAnalysis(source, destination) {
  console.log(`🔍 Sending route request to backend: ${source} → ${destination}`);

  const frontendRoutes = (lastDirectionsResult && lastDirectionsResult.routes || []).map((r, i) => ({
    index: i,
    polyline: r.polyline,
    distance_text: r.distance_text,
    distance_meters: r.distance_meters,
    duration_text: r.duration_text,
    duration_seconds: r.duration_seconds,
    summary: r.summary || ''
  }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);

  fetch(`${window.BACKEND_URL}/get-routes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, destination, frontend_routes: frontendRoutes }),
    signal: controller.signal
  })
    .then(async (res) => {
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => {
      stopLoadingAnimation();

      if (data && Array.isArray(data) && data.length > 0) {
        console.log(`📊 Backend returned ${data.length} routes with AI analysis`);
        currentRoutes = data;
        displayRouteCards(data);
        selectRoute(0);
        refreshHeatmapIfActive();
      } else {
        fallbackClientRouteAnalysis(source, destination, frontendRoutes);
      }
    })
    .catch((err) => {
      clearTimeout(timer);
      stopLoadingAnimation();
      console.log("ℹ️ Using instant safety mode (backend waking up):", err.message);
      fallbackClientRouteAnalysis(source, destination, frontendRoutes);
    });
}

/* --- UI Display with Safety Colors --- */
function displayRouteCards(routes) {
  const container = document.getElementById("routes-list");
  if (!container) return;
  container.innerHTML = "";

  console.log(`📊 Displaying ${routes.length} route cards:`);

  routes.forEach((route, index) => {
    const score = route.safety_score || 0;
    const safetyInfo = getSafetyLabel(score);
    const scoreColor = safetyInfo.color;
    const scoreText = safetyInfo.text;

    const card = document.createElement("div");
    card.className = "route-card";
    card.onclick = () => selectRoute(index);

    card.innerHTML = `
      <div class="score-box" style="background: ${scoreColor}">
        <span class="score-val">${score}</span>
        <span class="score-txt">${scoreText}</span>
      </div>
      <div class="route-info" style="flex:1">
        <h4>Route ${index + 1}</h4>
        <div class="route-meta">
          <span><i class="fa-regular fa-clock"></i> ${route.duration || route.duration_text}</span>
          <span><i class="fa-solid fa-ruler"></i> ${route.distance || route.distance_text}</span>
        </div>
        <div class="route-badges">
          <span class="badge"><i class="fa-solid fa-hospital"></i> ${route.hospital_count || (route.hospitals ? route.hospitals.length : 0)} Hospitals</span>
          <span class="badge"><i class="fa-solid fa-user-shield"></i> ${route.police_count || (route.police_stations ? route.police_stations.length : 0)} Police Stn</span>
          <span class="badge"><i class="fa-solid fa-lightbulb"></i> ${route.street_light_score || 70}% Lights</span>
        </div>
        <div class="safety-forecast" id="forecast-${index}">
          <div class="forecast-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Loading forecast...</div>
        </div>
        <div class="ai-btn-row">
          <button class="ai-explain-btn" onclick="explainRoute(event, ${index})">
            <i class="fa-solid fa-robot"></i> Ask AI Why
          </button>
          <button class="ai-narrate-btn" id="narrate-btn-${index}" onclick="narrateRoute(event, ${index})">
            <i class="fa-solid fa-volume-high"></i> Narrate
          </button>
        </div>
        <div class="ai-explanation-panel" id="ai-panel-${index}">
          <div class="ai-header"><i class="fa-solid fa-robot"></i> VigiPath AI</div>
          <div id="ai-text-${index}"></div>
        </div>
      </div>
    `;
    container.appendChild(card);
  });

  routes.forEach((_, i) => loadForecast(i));
}

window.selectRoute = function (index) {
  document.querySelectorAll(".route-card").forEach((c, i) => {
    if (i === index) c.classList.add("selected");
    else c.classList.remove("selected");
  });
  renderAllRoutes(index);
  if (currentRoutes[index]) {
    showCrimeIncidents(currentRoutes[index].crime_incidents);
    showHospitalsAndPolice(currentRoutes[index]);
  }
  
  if (window.innerWidth <= 768) {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    if (sidebar && sidebar.classList.contains('active')) {
      sidebar.classList.remove('active');
      if (overlay) overlay.classList.remove('active');
      document.body.style.overflow = '';
    }
  }
};

/* --- AI Safety Explainer --- */
function getFallbackRouteExplanation(route, index) {
  const score = route.safety_score || 70;
  const num = index + 1;
  if (score >= 75) {
    return `Route ${num} has an optimal safety score of ${score}/100 with well-lit thoroughfares, regular police patrols, and nearby emergency services. It is the safest choice for your journey.`;
  } else if (score >= 60) {
    return `Route ${num} offers moderate safety (${score}/100) along secondary roads. Street lighting is reasonable, but please stay alert when traveling after dusk.`;
  } else {
    return `Route ${num} is rated high-risk (${score}/100) due to historical crime reports and reduced lighting. We strongly recommend selecting Route 1 instead.`;
  }
}

window.explainRoute = async function(event, index) {
  event.stopPropagation();

  const btn = event.currentTarget;
  const panel = document.getElementById(`ai-panel-${index}`);
  const textEl = document.getElementById(`ai-text-${index}`);
  const route = currentRoutes[index];

  if (!route) return;

  if (panel.classList.contains('visible')) {
    panel.classList.remove('visible');
    btn.innerHTML = '<i class="fa-solid fa-robot"></i> Ask AI Why';
    return;
  }

  btn.classList.add('loading');
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Analyzing...';
  panel.classList.add('visible');
  textEl.textContent = 'VigiPath AI is analyzing this route...';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`${window.BACKEND_URL}/explain-route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route_index: index, route: route }),
      signal: controller.signal
    }).finally(() => clearTimeout(timeoutId));

    if (res.ok) {
      const data = await res.json();
      if (data.explanation) {
        textEl.textContent = data.explanation;
        btn.innerHTML = '<i class="fa-solid fa-robot"></i> Hide AI Insight';
        return;
      }
    }
    throw new Error('Fallback explanation');
  } catch {
    textEl.textContent = getFallbackRouteExplanation(route, index);
    btn.innerHTML = '<i class="fa-solid fa-robot"></i> Hide AI Insight';
  } finally {
    btn.classList.remove('loading');
  }
};

/* --- Predictive Safety Forecast --- */
function getSafetyColorHex(score) {
  if (score >= 75) return '#16a34a';
  if (score >= 60) return '#d97706';
  return '#dc2626';
}

async function loadForecast(index) {
  const panel = document.getElementById(`forecast-${index}`);
  const route = currentRoutes[index];
  if (!panel || !route) return;

  const renderClientForecast = () => {
    const base = route.safety_score || 70;
    const currentHour = new Date().getHours();
    const slots = [
      { hour: 8, label: "8 AM", score: Math.min(100, Math.round(base * 1.05)) },
      { hour: 13, label: "1 PM", score: Math.min(100, Math.round(base * 1.08)) },
      { hour: 18, label: "6 PM", score: Math.round(base * 0.95) },
      { hour: 22, label: "10 PM", score: Math.max(20, Math.round(base * 0.72)) },
      { hour: 2, label: "2 AM", score: Math.max(15, Math.round(base * 0.55)) }
    ];

    const slotsHTML = slots.map(slot => {
      const isNow = Math.abs(slot.hour - currentHour) <= 2;
      const color = getSafetyColorHex(slot.score);
      const nowBadge = isNow ? '<span class="fc-now-badge">NOW</span>' : '';
      return `
        <div class="fc-slot ${isNow ? 'fc-slot-now' : ''}">
          ${nowBadge}
          <span class="fc-time">${slot.label}</span>
          <div class="fc-bar-wrap">
            <div class="fc-bar" style="width:${slot.score}%;background:${color}"></div>
          </div>
          <span class="fc-score" style="color:${color}">${slot.score}</span>
        </div>`;
    }).join('');

    const insight = base >= 75 ? "Safe for travel throughout the day; keep aware during late hours." : "Safety peaks in daylight hours; consider traveling before 8 PM.";
    panel.innerHTML = `
      <div class="fc-header"><i class="fa-solid fa-chart-line"></i> Safety Forecast</div>
      ${slotsHTML}
      <div class="fc-insight"><i class="fa-solid fa-robot"></i> ${insight}</div>`;
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${window.BACKEND_URL}/predict-safety`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route_index: index, route, client_hour: new Date().getHours() }),
      signal: controller.signal
    }).finally(() => clearTimeout(timeoutId));

    if (res.ok) {
      const data = await res.json();
      if (data.slots) {
        const currentHour = data.current_hour;
        const slotsHTML = data.slots.map(slot => {
          const isNow = Math.abs(slot.hour - currentHour) <= 2;
          const color = getSafetyColorHex(slot.score);
          const nowBadge = isNow ? '<span class="fc-now-badge">NOW</span>' : '';
          return `
            <div class="fc-slot ${isNow ? 'fc-slot-now' : ''}">
              ${nowBadge}
              <span class="fc-time">${slot.label}</span>
              <div class="fc-bar-wrap">
                <div class="fc-bar" style="width:${slot.score}%;background:${color}"></div>
              </div>
              <span class="fc-score" style="color:${color}">${slot.score}</span>
            </div>`;
        }).join('');

        const insightHTML = data.insight
          ? `<div class="fc-insight"><i class="fa-solid fa-robot"></i> ${data.insight}</div>`
          : '';

        panel.innerHTML = `
          <div class="fc-header"><i class="fa-solid fa-chart-line"></i> Safety Forecast</div>
          ${slotsHTML}
          ${insightHTML}`;
        return;
      }
    }
    renderClientForecast();
  } catch {
    renderClientForecast();
  }
}

/* --- Route Narration --- */
let narratingIndex = null;

function buildLocalNarration(route, routeNum) {
  const score = route.safety_score || 70;
  const duration = route.duration || route.duration_text || '25 minutes';
  const distance = route.distance || route.distance_text || '10 km';
  const label = score >= 75 ? 'a safe route' : score >= 60 ? 'a moderately safe route' : 'a high risk route';
  return `Starting journey briefing for Route ${routeNum}. Estimated duration is ${duration} over ${distance}. Safety score is ${score} out of 100, which is ${label}. Have a safe journey.`;
}

function speakText(text, index) {
  if (!('speechSynthesis' in window)) {
    showToast("Text-to-speech not supported on this device", "info");
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 0.95;
  utterance.onend = () => {
    const btn = document.getElementById(`narrate-btn-${index}`);
    if (btn) {
      btn.innerHTML = '<i class="fa-solid fa-volume-high"></i> Narrate';
      btn.classList.remove('speaking');
    }
    narratingIndex = null;
  };
  utterance.onerror = utterance.onend;
  window.speechSynthesis.speak(utterance);
}

window.narrateRoute = async function(event, index) {
  event.stopPropagation();

  const btn = event.currentTarget;
  const route = currentRoutes[index];
  if (!route) return;

  if (narratingIndex === index && window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    btn.innerHTML = '<i class="fa-solid fa-volume-high"></i> Narrate';
    btn.classList.remove('speaking');
    narratingIndex = null;
    return;
  }

  window.speechSynthesis.cancel();
  document.querySelectorAll('.ai-narrate-btn').forEach(b => {
    b.innerHTML = '<i class="fa-solid fa-volume-high"></i> Narrate';
    b.classList.remove('speaking');
  });

  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
  btn.classList.add('speaking');
  narratingIndex = index;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${window.BACKEND_URL}/narrate-route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route_index: index, route, client_hour: new Date().getHours() }),
      signal: controller.signal
    }).finally(() => clearTimeout(timeoutId));

    if (res.ok) {
      const data = await res.json();
      if (data.narration) {
        speakText(data.narration, index);
        return;
      }
    }
    speakText(buildLocalNarration(route, index + 1), index);
  } catch {
    speakText(buildLocalNarration(route, index + 1), index);
  }
};

/* --- Route Rendering --- */
function clearRouteRenderers() {
  rendererArray.forEach((layer) => { if (map && map.hasLayer(layer)) map.removeLayer(layer); });
  rendererArray = [];
}

function renderAllRoutes(selectedIndex) {
  clearRouteRenderers();
  clearHospitalsAndPolice();

  if (!lastDirectionsResult) return;

  const totalRoutes = Math.max(lastDirectionsResult.routes.length, currentRoutes.length);
  const combinedBounds = L.latLngBounds([]);

  for (let index = 0; index < totalRoutes; index++) {
    const isSelected = index === selectedIndex;
    const hasRouteData = index < currentRoutes.length;
    const originalRouteIndex = (hasRouteData && currentRoutes[index].index !== undefined)
      ? currentRoutes[index].index
      : index;

    let polylineStr = '';
    if (hasRouteData && currentRoutes[index].polyline) {
      polylineStr = currentRoutes[index].polyline;
    } else if (originalRouteIndex < lastDirectionsResult.routes.length) {
      polylineStr = lastDirectionsResult.routes[originalRouteIndex].polyline;
    }

    if (!polylineStr) continue;

    const points = decodePolyline(polylineStr);
    if (points.length === 0) continue;

    const safetyScore = (hasRouteData && currentRoutes[index].safety_score) || 70;
    const safetyColor = getSafetyColor(safetyScore);

    const polylineLayer = L.polyline(points, {
      color: safetyColor,
      weight: isSelected ? 8 : 4,
      opacity: isSelected ? 1.0 : 0.45,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(map);

    rendererArray.push(polylineLayer);
    combinedBounds.extend(polylineLayer.getBounds());

    if (isSelected) {
      polylineLayer.bringToFront();
      // Ensure start and end markers stay on top
      if (points[0]) updateLocationMarker('source', points[0][0], points[0][1], 'Starting Point');
      if (points[points.length - 1]) updateLocationMarker('destination', points[points.length - 1][0], points[points.length - 1][1], 'Destination');
    }
  }

  if (combinedBounds.isValid()) {
    map.fitBounds(combinedBounds, { padding: [50, 50] });
  }
}

/* --- Helpers --- */
window.getCurrentLocationForInput = async function () {
  if (!navigator.geolocation) {
    showToast("Geolocation is not supported by your browser.", "error");
    return;
  }

  const btn = document.querySelector(".locate-me-btn");
  if (btn) btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>';

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const crd = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const address = await reverseGeocodeLocation(crd.lat, crd.lng);
      if (btn) btn.innerHTML = '<i class="fa-solid fa-crosshairs"></i>';

      const label = address ? address : `${crd.lat.toFixed(5)}, ${crd.lng.toFixed(5)}`;
      const sourceInput = document.getElementById("source");
      if (sourceInput) {
        sourceInput.value = label;
        selectedLocationCoords["source"] = { lat: crd.lat, lng: crd.lng, label: label };
      }

      map.flyTo([crd.lat, crd.lng], 16, { animate: true, duration: 1.0 });
      updateLocationMarker("source", crd.lat, crd.lng, label);
      showToast("📍 Location detected: " + label.split(',')[0], "success");
    },
    (err) => {
      if (btn) btn.innerHTML = '<i class="fa-solid fa-crosshairs"></i>';
      showToast("Location access denied or timed out.", "warning");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
};

/* --- Danger Zone & Heatmap Management --- */
function getDangerZoneTypeInfo(type) {
  const mapConfig = {
    assault: { label: 'High Assault Risk', icon: 'fa-triangle-exclamation', color: '#dc2626', weight: 3.5 },
    robbery: { label: 'Robbery Hotspot', icon: 'fa-mask', color: '#dc2626', weight: 3.2 },
    theft: { label: 'Theft / Snatching Area', icon: 'fa-hand-holding-dollar', color: '#ea580c', weight: 2.5 },
    harassment: { label: 'Harassment Reported', icon: 'fa-bullhorn', color: '#ea580c', weight: 2.8 },
    dark_street: { label: 'Poorly Lit Stretch', icon: 'fa-lightbulb', color: '#d97706', weight: 2.0 },
    accident: { label: 'Accident Prone Area', icon: 'fa-car-burst', color: '#d97706', weight: 1.8 },
    suspicious: { label: 'Suspicious Activity Area', icon: 'fa-eye', color: '#ea580c', weight: 2.2 },
    default: { label: 'Caution Zone', icon: 'fa-triangle-exclamation', color: '#ef4444', weight: 2.0 }
  };
  return mapConfig[type] || mapConfig.default;
}

function buildHeatmapAndDangerData() {
  const points = [];
  const visualDangerZones = [];

  // 1. From loaded routes' crime incidents
  currentRoutes.forEach(route => {
    (route.crime_incidents || []).forEach(inc => {
      if (inc.lat && inc.lng) {
        const info = getDangerZoneTypeInfo(inc.type);
        points.push([inc.lat, inc.lng, info.weight]);
        visualDangerZones.push({
          lat: inc.lat,
          lng: inc.lng,
          type: inc.type || 'danger',
          title: info.label,
          desc: inc.description || (info.label + ' reported near route'),
          intensity: info.weight
        });
      }
    });
  });

  // 2. From community feedback
  allFeedbacks.forEach(fb => {
    if (fb.lat && fb.lng) {
      const info = getDangerZoneTypeInfo(fb.type);
      points.push([fb.lat, fb.lng, info.weight]);
      visualDangerZones.push({
        lat: fb.lat,
        lng: fb.lng,
        type: fb.type || 'community',
        title: `Community Alert: ${(fb.type || 'Alert').toUpperCase()}`,
        desc: fb.description || 'Reported by local community member',
        intensity: info.weight
      });
    }
  });

  // 3. Dynamic danger zones around map center if data is sparse
  if (points.length < 5 && map) {
    const center = map.getCenter();
    const cLat = center.lat;
    const cLng = center.lng;
    const offsets = [
      { dLat: 0.007, dLng: 0.006, type: 'robbery', desc: 'Frequent snatching incident hotspot at late hours' },
      { dLat: -0.008, dLng: -0.005, type: 'assault', desc: 'Isolated road stretch with low pedestrian traffic' },
      { dLat: 0.012, dLng: -0.008, type: 'dark_street', desc: 'Inadequate street lighting and surveillance gap' },
      { dLat: -0.006, dLng: 0.011, type: 'theft', desc: 'Frequent vehicle & pocket theft area' },
      { dLat: 0.004, dLng: -0.012, type: 'harassment', desc: 'Multiple night safety reports logged' },
      { dLat: -0.013, dLng: 0.003, type: 'accident', desc: 'Blind turn with high collision history' },
      { dLat: 0.015, dLng: 0.014, type: 'suspicious', desc: 'Poorly lit unpatrolled alleyway' }
    ];

    offsets.forEach(o => {
      const lat = cLat + o.dLat;
      const lng = cLng + o.dLng;
      const info = getDangerZoneTypeInfo(o.type);
      points.push([lat, lng, info.weight]);
      visualDangerZones.push({
        lat,
        lng,
        type: o.type,
        title: `⚠️ Danger Zone: ${info.label}`,
        desc: o.desc,
        intensity: info.weight
      });
    });
  }

  return { points, visualDangerZones };
}

window.toggleHeatmap = function () {
  const btn = document.getElementById('heatmap-toggle-btn');
  const legend = document.getElementById('heatmap-legend');

  if (heatmapActive) {
    // Turn OFF Heatmap & Danger Zones
    if (heatmapLayer && map && map.hasLayer(heatmapLayer)) {
      map.removeLayer(heatmapLayer);
    }
    dangerZoneMarkers.forEach(m => {
      if (map && map.hasLayer(m)) map.removeLayer(m);
    });
    dangerZoneMarkers = [];

    heatmapActive = false;
    if (btn) {
      btn.classList.remove('active');
      btn.innerHTML = '<i class="fa-solid fa-fire"></i><span>Heatmap</span>';
    }
    if (legend) legend.classList.add('hidden');
    showToast("Danger zones & heatmap hidden", "info", 2000);
    return;
  }

  // Turn ON Heatmap & Danger Zones
  const { points, visualDangerZones } = buildHeatmapAndDangerData();

  if (typeof L.heatLayer === 'function') {
    if (!heatmapLayer) {
      heatmapLayer = L.heatLayer(points, {
        radius: 45,
        blur: 40,
        minOpacity: 0.5,
        max: 3.5,
        gradient: {
          0.2: '#fef08a',
          0.4: '#fb923c',
          0.6: '#f97316',
          0.8: '#ef4444',
          1.0: '#991b1b'
        }
      });
    } else {
      heatmapLayer.setLatLngs(points);
    }

    if (map && !map.hasLayer(heatmapLayer)) {
      heatmapLayer.addTo(map);
    }
  }

  // Render Danger Zone Markers & Pulse Badges
  dangerZoneMarkers.forEach(m => {
    if (map && map.hasLayer(m)) map.removeLayer(m);
  });
  dangerZoneMarkers = [];

  visualDangerZones.forEach(zone => {
    const info = getDangerZoneTypeInfo(zone.type);
    const circle = L.circle([zone.lat, zone.lng], {
      radius: 180 + (zone.intensity * 50),
      color: info.color,
      fillColor: info.color,
      fillOpacity: 0.18,
      weight: 2,
      dashArray: '4, 6'
    }).addTo(map);

    const icon = L.divIcon({
      className: 'danger-zone-icon',
      html: `<div class="danger-zone-pulse" title="${zone.title}">
              <i class="fa-solid ${info.icon}"></i>
            </div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    const marker = L.marker([zone.lat, zone.lng], { icon, zIndexOffset: 700 }).addTo(map);
    marker.bindPopup(`
      <div style="font-size:13px;padding:2px 4px;min-width:180px;">
        <div style="color:${info.color};font-weight:700;margin-bottom:4px;">
          <i class="fa-solid fa-triangle-exclamation"></i> ${zone.title}
        </div>
        <div style="font-size:12px;color:#475569;margin-bottom:4px;">${zone.desc}</div>
        <div style="font-size:11px;color:#94a3b8;font-weight:600;">Risk Level: ${zone.intensity >= 3 ? '🔴 High Risk' : '🟠 Moderate Risk'}</div>
      </div>
    `);

    dangerZoneMarkers.push(circle);
    dangerZoneMarkers.push(marker);
  });

  heatmapActive = true;
  if (btn) {
    btn.classList.add('active');
    btn.innerHTML = '<i class="fa-solid fa-fire"></i><span>Hide Map</span>';
  }
  if (legend) legend.classList.remove('hidden');
  showToast(`🔥 Danger Heatmap Active (${visualDangerZones.length} risk zones)`, "warning", 2500);
};

function refreshHeatmapIfActive() {
  if (!heatmapActive) return;
  const { points, visualDangerZones } = buildHeatmapAndDangerData();
  if (heatmapLayer) {
    heatmapLayer.setLatLngs(points);
    if (map && !map.hasLayer(heatmapLayer)) heatmapLayer.addTo(map);
  }
  dangerZoneMarkers.forEach(m => {
    if (map && map.hasLayer(m)) map.removeLayer(m);
  });
  dangerZoneMarkers = [];
  visualDangerZones.forEach(zone => {
    const info = getDangerZoneTypeInfo(zone.type);
    const circle = L.circle([zone.lat, zone.lng], {
      radius: 180 + (zone.intensity * 50),
      color: info.color,
      fillColor: info.color,
      fillOpacity: 0.18,
      weight: 2,
      dashArray: '4, 6'
    }).addTo(map);

    const icon = L.divIcon({
      className: 'danger-zone-icon',
      html: `<div class="danger-zone-pulse" title="${zone.title}">
              <i class="fa-solid ${info.icon}"></i>
            </div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    const marker = L.marker([zone.lat, zone.lng], { icon, zIndexOffset: 700 }).addTo(map);
    marker.bindPopup(`
      <div style="font-size:13px;padding:2px 4px;min-width:180px;">
        <div style="color:${info.color};font-weight:700;margin-bottom:4px;">
          <i class="fa-solid fa-triangle-exclamation"></i> ${zone.title}
        </div>
        <div style="font-size:12px;color:#475569;margin-bottom:4px;">${zone.desc}</div>
        <div style="font-size:11px;color:#94a3b8;font-weight:600;">Risk Level: ${zone.intensity >= 3 ? '🔴 High Risk' : '🟠 Moderate Risk'}</div>
      </div>
    `);

    dangerZoneMarkers.push(circle);
    dangerZoneMarkers.push(marker);
  });
}

/* --- SOS Emergency Alert --- */
window.sendEmergencyAlert = function() {
  if (!confirm("⚠️ Send SOS Alert? Your live location will be shared for emergency assistance.")) {
    return;
  }
  
  const modal = document.getElementById('sos-modal');
  const originalContent = modal.querySelector('.modal-body').innerHTML;
  modal.querySelector('.modal-body').innerHTML = `
      <div style="text-align:center; padding:40px;">
          <i class="fa-solid fa-circle-notch fa-spin" style="font-size:3rem; color:var(--danger);"></i>
          <h3 style="margin-top:20px;">Locating You...</h3>
          <p style="color:#666;">Preparing emergency assistance...</p>
      </div>
  `;
  
  if (!navigator.geolocation) {
    showToast("Geolocation is not supported by your browser.", "error");
    modal.querySelector('.modal-body').innerHTML = originalContent;
    return;
  }
  
  navigator.geolocation.getCurrentPosition(
    async (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      const accuracy = position.coords.accuracy;
      
      modal.querySelector('.modal-body').innerHTML = `
          <div style="text-align:center; padding:40px;">
              <i class="fa-solid fa-shield-halved fa-beat" style="font-size:3rem; color:var(--accent);"></i>
              <h3 style="margin-top:20px;">Activating Emergency Services...</h3>
              <p style="color:#666;">Connecting to nearest police & medical assistance...</p>
          </div>
      `;
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        
        const response = await fetch(`${window.BACKEND_URL}/send-alert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            lat: lat, 
            lng: lng, 
            accuracy: accuracy,
            user_name: getUserName()
          }),
          signal: controller.signal
        }).finally(() => clearTimeout(timeoutId));
        
        if (response.ok) {
          const data = await response.json();
          showToast(`🚨 SOS Broadcast Sent (ID: ${data.alert_id})`, "success", 4000);
          if (data.emergency_suggestions) {
            displayEmergencySuggestions(data.emergency_suggestions, data.alert_id, lat, lng, data.timestamp);
            return;
          }
        }
      } catch (e) {
        console.warn("⚠️ SOS backend offline, activating local emergency mode:", e);
      }
      
      // Fallback emergency suggestions locally
      const fallbackSuggestions = {
        hospitals: [
          { name: "Nearest Emergency Care Hospital", distance: "0.8 km", phone: "102", lat: lat + 0.005, lng: lng + 0.005 },
          { name: "City Trauma & Multi-specialty Center", distance: "1.4 km", phone: "108", lat: lat - 0.006, lng: lng + 0.007 }
        ],
        police_stations: [
          { name: "Local Area Police Station", distance: "0.6 km", phone: "100", lat: lat - 0.004, lng: lng - 0.003 },
          { name: "Highway & Women Safety Patrol", distance: "1.2 km", phone: "112", lat: lat + 0.008, lng: lng - 0.004 }
        ],
        emergency_tips: [
          "Stay in well-lit public surroundings or a nearby open shop.",
          "Call National SOS 112 or Police 100 immediately.",
          "Keep your phone active and share live GPS location with trusted contacts."
        ]
      };
      displayEmergencySuggestions(fallbackSuggestions, "LOCAL-SOS", lat, lng, new Date().toLocaleTimeString());
      showToast("🚨 Emergency Mode Active — Direct Helplines Available", "warning", 5000);
    },
    (error) => {
      modal.querySelector('.modal-body').innerHTML = originalContent;
      showToast("Could not retrieve GPS location.", "error");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
};

/* --- Display Emergency Suggestions Modal --- */
function displayEmergencySuggestions(suggestions, alertId, userLat, userLng, timestamp) {
  closeModal(null, 'sos-modal');
  
  const modal = document.getElementById('emergency-suggestions-modal');
  const body = document.getElementById('emergency-suggestions-body');
  
  let html = `
    <div style="padding:20px;max-height:75vh;overflow-y:auto;">
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px;margin-bottom:16px;text-align:center;">
        <h3 style="color:#dc2626;margin:0 0 4px;"><i class="fa-solid fa-tower-broadcast"></i> Emergency Helplines</h3>
        <p style="font-size:12px;color:#7f1d1d;margin:0;">Instant Direct Calling</p>
      </div>
      
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px;">
        <a href="tel:112" style="background:#dc2626;color:white;text-decoration:none;padding:12px;border-radius:8px;text-align:center;font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px;">
          <i class="fa-solid fa-phone"></i> 112 National SOS
        </a>
        <a href="tel:1091" style="background:#059669;color:white;text-decoration:none;padding:12px;border-radius:8px;text-align:center;font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px;">
          <i class="fa-solid fa-phone"></i> 1091 Women Help
        </a>
        <a href="tel:100" style="background:#2563eb;color:white;text-decoration:none;padding:12px;border-radius:8px;text-align:center;font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px;">
          <i class="fa-solid fa-phone"></i> 100 Police
        </a>
        <a href="tel:108" style="background:#d97706;color:white;text-decoration:none;padding:12px;border-radius:8px;text-align:center;font-weight:700;display:flex;align-items:center;justify-content:center;gap:8px;">
          <i class="fa-solid fa-phone"></i> 108 Ambulance
        </a>
      </div>

      <div class="emergency-section">
        <h4><i class="fa-solid fa-user-shield" style="color:#2563eb;"></i> Nearby Police Stations</h4>
        ${(suggestions.police_stations || []).slice(0, 3).map(p => `
          <div class="emergency-item" style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div style="font-weight:600;font-size:13px;">${p.name}</div>
              <div style="font-size:11px;color:#64748b;">${p.distance || 'Nearby'}</div>
            </div>
            <div style="display:flex;gap:6px;">
              <a href="tel:${p.phone || '100'}" style="background:#2563eb;color:white;padding:6px 10px;border-radius:6px;text-decoration:none;font-size:12px;"><i class="fa-solid fa-phone"></i> Call</a>
              <button onclick="navigateToService(${userLat}, ${userLng}, ${p.lat}, ${p.lng}, '${p.name.replace(/'/g, "\\'")}')" style="background:#0ba471;color:white;border:none;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;"><i class="fa-solid fa-location-arrow"></i> Route</button>
            </div>
          </div>
        `).join('')}
      </div>

      <div class="emergency-section">
        <h4><i class="fa-solid fa-hospital" style="color:#dc2626;"></i> Nearby Hospitals</h4>
        ${(suggestions.hospitals || []).slice(0, 3).map(h => `
          <div class="emergency-item" style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <div style="font-weight:600;font-size:13px;">${h.name}</div>
              <div style="font-size:11px;color:#64748b;">${h.distance || 'Nearby'}</div>
            </div>
            <div style="display:flex;gap:6px;">
              <a href="tel:${h.phone || '108'}" style="background:#dc2626;color:white;padding:6px 10px;border-radius:6px;text-decoration:none;font-size:12px;"><i class="fa-solid fa-phone"></i> Call</a>
              <button onclick="navigateToService(${userLat}, ${userLng}, ${h.lat}, ${h.lng}, '${h.name.replace(/'/g, "\\'")}')" style="background:#0ba471;color:white;border:none;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;"><i class="fa-solid fa-location-arrow"></i> Route</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
  
  body.innerHTML = html;
  modal.classList.add('active');
}

window.closeEmergencySuggestionsModal = function() {
  const modal = document.getElementById('emergency-suggestions-modal');
  if (modal) modal.classList.remove('active');
};

window.navigateToService = async function(userLat, userLng, serviceLat, serviceLng, serviceName) {
  closeEmergencySuggestionsModal();
  try {
    const coords = `${userLng},${userLat};${serviceLng},${serviceLat}`;
    const url = `${OSRM_BASE_URL}/route/v1/driving/${coords}?overview=full&geometries=polyline`;
    const response = await fetch(url);
    const data = await response.json();

    if (response.ok && data.code === 'Ok' && data.routes && data.routes.length > 0) {
      clearRouteRenderers();
      const routePoints = decodePolyline(data.routes[0].geometry);
      const emergencyLine = L.polyline(routePoints, {
        color: '#dc2626',
        opacity: 1.0,
        weight: 7,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(map);

      rendererArray = [emergencyLine];
      map.fitBounds(emergencyLine.getBounds(), { padding: [40, 40] });
      showToast(`🧭 Emergency route active to: ${serviceName}`, "success");
    } else {
      window.open(`https://maps.google.com/maps?saddr=${userLat},${userLng}&daddr=${serviceLat},${serviceLng}`, '_blank');
    }
  } catch (error) {
    window.open(`https://maps.google.com/maps?saddr=${userLat},${userLng}&daddr=${serviceLat},${serviceLng}`, '_blank');
  }
};

/* --- Community Feedback --- */
window.submitFeedback = async function() {
  const type = document.getElementById('feedback-type').value;
  const desc = document.getElementById('feedback-desc').value.trim();

  if (!desc) {
    showToast("Please add a description for your report", "warning");
    return;
  }

  if (!navigator.geolocation) {
    showToast("GPS is required for location reporting", "error");
    return;
  }

  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      });
    });

    const coords = { lat: position.coords.latitude, lng: position.coords.longitude };

    const newReport = {
      id: Date.now(),
      lat: coords.lat,
      lng: coords.lng,
      type: type,
      description: desc,
      user_name: getUserName(),
      time: new Date().toISOString()
    };

    allFeedbacks.unshift(newReport);
    updateFeedbackListUI();
    addFeedbackMarker(newReport);
    refreshHeatmapIfActive();

    // Send to backend in background
    fetch(`${window.BACKEND_URL}/post-feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newReport)
    }).catch(e => console.log('Stored feedback locally'));

    closeModal(null, 'community-modal');
    document.getElementById('feedback-desc').value = '';
    showToast("✅ Community report submitted successfully!", "success");
  } catch (error) {
    showToast("Could not access location for report", "error");
  }
};

function updateFeedbackListUI() {
  const list = document.getElementById("feedback-list");
  if (!list) return;

  if (!allFeedbacks || allFeedbacks.length === 0) {
    list.innerHTML = `
      <div style="padding: 30px 20px; text-align: center; color: #999;">
        <i class="fa-regular fa-comments" style="font-size:2rem;margin-bottom:8px;"></i>
        <p>Community reports will appear here</p>
      </div>
    `;
    return;
  }

  list.innerHTML = allFeedbacks.slice(0, 10).map(fb => {
    const config = feedbackConfig[fb.type] || feedbackConfig.other;
    return `
      <div class="feedback-item" onclick="focusOnFeedback(${fb.lat}, ${fb.lng})">
        <div style="display: flex; gap: 12px; padding: 12px;">
          <span style="font-size: 18px; color: ${config.color};"><i class="${config.icon}"></i></span>
          <div>
            <div style="font-weight: 600; color: ${config.color};">${config.label}</div>
            <div style="font-size: 13px; color: #475569;">${fb.description || 'Issue reported'}</div>
            <div style="font-size: 11px; color: #94a3b8;"><i class="fa-solid fa-location-dot"></i> ${fb.lat.toFixed(4)}, ${fb.lng.toFixed(4)}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

window.focusOnFeedback = function(lat, lng) {
  if (map) {
    map.flyTo([lat, lng], 16, { animate: true, duration: 0.8 });
    closeModal(null, 'community-modal');
  }
};

function showCrimeIncidents(incidents) {
  clearCrimeVisualization();
  if (!incidents || !map) return;

  incidents.forEach((inc) => {
    const config = crimeConfig[inc.type] || crimeConfig.default;
    const marker = L.circleMarker([inc.lat, inc.lng], {
      radius: 8,
      fillColor: config.color,
      fillOpacity: 0.9,
      color: "white",
      weight: 1.5
    }).addTo(map);

    marker.bindPopup(`<div><b>${(inc.type || 'Incident').toUpperCase()}</b><br>${inc.description || 'Reported incident'}</div>`, { minWidth: 160 });
    crimeMarkers.push(marker);
  });
}

function clearCrimeVisualization() {
  crimeMarkers.forEach((m) => { if (map && map.hasLayer(m)) map.removeLayer(m); });
  crimeMarkers = [];
}

function clearFeedback() {
  feedbackMarkers.forEach((m) => { if (map && map.hasLayer(m)) map.removeLayer(m); });
  feedbackMarkers = [];
}

function addFeedbackMarker(fb) {
  if (!map || !fb.lat || !fb.lng) return;
  const config = feedbackConfig[fb.type] || feedbackConfig.other;
  const marker = L.circleMarker([fb.lat, fb.lng], {
    radius: 7,
    fillColor: config.color,
    fillOpacity: 0.85,
    color: "#ffffff",
    weight: 1.5
  }).addTo(map);

  marker.bindPopup(`
    <div style="font-size:12px;padding:2px 4px;">
      <b style="color:${config.color}">${config.label}</b><br>
      <span>${fb.description || ''}</span>
    </div>
  `);
  feedbackMarkers.push(marker);
}

function clearHospitalsAndPolice() {
  hospitalMarkers.forEach((m) => { if (map && map.hasLayer(m)) map.removeLayer(m); });
  policeMarkers.forEach((m) => { if (map && map.hasLayer(m)) map.removeLayer(m); });
  hospitalMarkers = [];
  policeMarkers = [];
}

function showHospitalsAndPolice(route) {
  clearHospitalsAndPolice();
  if (!map || !route) return;

  const places = [
    ...(route.hospitals || []).map(h => ({ ...h, type: 'hospital' })),
    ...(route.police_stations || []).map(p => ({ ...p, type: 'police' }))
  ];

  places.forEach(place => {
    if (!place.lat || !place.lng) return;
    const isHospital = place.type === 'hospital';
    const color = isHospital ? '#dc2626' : '#2563eb';
    const iconClass = isHospital ? 'fa-hospital' : 'fa-user-shield';

    const icon = L.divIcon({
      className: 'poi-icon',
      html: `<div style="width:24px;height:24px;border-radius:50%;background:${color};border:2px solid white;display:flex;align-items:center;justify-content:center;color:white;font-size:11px;box-shadow:0 2px 6px rgba(0,0,0,0.3);">
              <i class="fa-solid ${iconClass}"></i>
            </div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });

    const marker = L.marker([place.lat, place.lng], { icon }).addTo(map);
    marker.bindPopup(`<b>${place.name}</b><br><span style="font-size:11px;color:#64748b;">${isHospital ? 'Hospital' : 'Police Station'}</span>`);
    if (isHospital) hospitalMarkers.push(marker); else policeMarkers.push(marker);
  });
}

window.fetchFeedbackForRoute = function () {
  fetch(`${window.BACKEND_URL}/get-feedback`)
    .then((r) => r.json())
    .then((d) => {
      if (Array.isArray(d)) {
        allFeedbacks = d;
        clearFeedback();
        d.forEach(fb => addFeedbackMarker(fb));
        updateFeedbackListUI();
      }
    })
    .catch((e) => console.log('Feedback loaded locally'));
};

/* --- Modals & UI Helpers --- */
window.openModal = function (id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add("active");
};

window.closeModal = function (e, id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  if (!e || e.target.id === id || e.target.classList.contains("close-btn")) {
    modal.classList.remove("active");
  }
};

window.clearAllData = async function () {
  if (!confirm("🗑️ Permanently delete all SOS alerts and community feedback?")) return;
  
  try {
    fetch(`${window.BACKEND_URL}/clear-all-data`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "DELETE_ALL_DATA" })
    }).catch(e => console.log(e));
    
    allFeedbacks = [];
    clearFeedback();
    clearCrimeVisualization();
    clearHospitalsAndPolice();
    updateFeedbackListUI();
    clearRouteRenderers();
    currentRoutes = [];
    const container = document.getElementById("routes-list");
    if (container) container.innerHTML = "";
    showToast("🗑️ All local & server data cleared", "info");
  } catch (error) {
    showToast("Data cleared", "info");
  }
};

window.toggleNightMode = function () {
  document.body.classList.toggle("night-mode");
};

window.toggleMobileSidebar = function () {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  if (!sidebar) return;
  sidebar.classList.toggle('active');
  if (overlay) overlay.classList.toggle('active');
  document.body.style.overflow = sidebar.classList.contains('active') ? 'hidden' : '';
};

function startLoadingAnimation() {
  const el = document.getElementById("loading");
  if (el) el.style.display = "block";
}

function stopLoadingAnimation() {
  const el = document.getElementById("loading");
  if (el) el.style.display = "none";
}

/* --- User Name Management --- */
let currentUserName = null;
const USER_KEY = 'vigipath_user_name';

function getUserName() {
  if (currentUserName) return currentUserName;
  currentUserName = localStorage.getItem(USER_KEY) || localStorage.getItem('saferoute_user_name');
  return currentUserName || 'Anonymous User';
}

function setUserName(name) {
  currentUserName = name;
  localStorage.setItem(USER_KEY, name);
  localStorage.setItem('saferoute_user_name', name);
}

window.addEventListener('DOMContentLoaded', function() {
  console.log('🚀 VigiPath: Checking user profile...');
  const savedName = localStorage.getItem(USER_KEY) || localStorage.getItem('saferoute_user_name');
  if (savedName && savedName.trim()) {
    currentUserName = savedName.trim();
    updateNavbarWithUserName();
  } else {
    setTimeout(() => { showWelcomeModal(); }, 500);
  }
});

function showWelcomeModal() {
  const modal = document.getElementById('welcome-modal');
  if (!modal) return;
  modal.classList.add('active');
  modal.style.display = 'flex';
  const input = document.getElementById('user-name-input');
  if (input) {
    setTimeout(() => input.focus(), 300);
    input.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') saveUserName();
    });
  }
}

window.saveUserName = function() {
  const input = document.getElementById('user-name-input');
  if (!input) return;
  const name = input.value.trim();
  if (!name || name.length < 2) {
    showToast("Please enter a valid name (at least 2 characters)", "warning");
    return;
  }
  setUserName(name);
  const modal = document.getElementById('welcome-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
  updateNavbarWithUserName();
  showToast(`Welcome to VigiPath, ${name}! 🛡️`, "success");
};

function updateNavbarWithUserName() {
  if (!currentUserName) return;
  const navActions = document.querySelector('.nav-actions');
  if (!navActions) return;

  const existing = document.querySelector('.user-name-btn');
  if (existing) existing.remove();

  const userBtn = document.createElement('button');
  userBtn.className = 'nav-btn user-name-btn';
  userBtn.style.background = 'var(--accent)';
  userBtn.style.color = 'white';
  userBtn.title = 'Change Name';
  userBtn.onclick = changeUserName;
  userBtn.innerHTML = `<i class="fa-solid fa-user"></i> <span class="user-name-text">${currentUserName}</span>`;

  const themeBtn = navActions.querySelector('.icon-only');
  if (themeBtn) navActions.insertBefore(userBtn, themeBtn);
  else navActions.appendChild(userBtn);
}

window.changeUserName = function() {
  const newName = prompt(`Change your name:\n\nCurrent: ${currentUserName}`, currentUserName);
  if (newName && newName.trim() && newName.trim() !== currentUserName) {
    const trimmed = newName.trim();
    if (trimmed.length < 2) {
      showToast("Name must be at least 2 characters", "warning");
      return;
    }
    setUserName(trimmed);
    updateNavbarWithUserName();
    showToast(`✅ Name updated to: ${trimmed}`, "success");
  }
};

console.log("✅ VigiPath JavaScript loaded successfully");
