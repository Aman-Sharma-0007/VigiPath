/* --- Global Variables --- */
let map; // Leaflet map instance (OpenStreetMap tiles)
let rendererArray = [], currentRoutes = [], lastDirectionsResult = null;
let userMarker = null, crimeMarkers = [], feedbackMarkers = [];
let hospitalMarkers = [], policeMarkers = []; // Markers for hospitals and police stations
let allFeedbacks = [];
let heatmapLayer = null, heatmapActive = false;
const socket = io(window.BACKEND_URL);

/* --- Free & keyless map services (replaced Google Maps Platform) --- */
// OSRM demo server — driving routes with alternatives, CORS enabled, no API key
const OSRM_BASE_URL = 'https://router.project-osrm.org';
// Nominatim — OpenStreetMap geocoding / reverse geocoding, no API key
const NOMINATIM_BASE_URL = 'https://nominatim.openstreetmap.org';
// Photon — OpenStreetMap-powered autocomplete service (by Komoot), no API key
const PHOTON_BASE_URL = 'https://photon.komoot.io/api';

// Session cache for geocoded locations (respects Nominatim's fair-use policy)
const geocodeCache = new Map();

/* --- Encoded polyline decoder (Google/OSRM-compatible, precision 5) --- */
function decodePolyline(str, precision = 5) {
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

// Resolves a free-text location (or "lat,lng" pair) to {lat, lng}
async function geocodeLocation(query) {
  const q = (query || '').trim();
  if (!q) return null;

  const coordMatch = q.match(COORDINATE_PATTERN);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]), lng = parseFloat(coordMatch[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
  }

  if (geocodeCache.has(q)) return geocodeCache.get(q);

  const response = await fetch(`${NOMINATIM_BASE_URL}/search?q=${encodeURIComponent(q)}&format=json&limit=1`);
  if (!response.ok) throw new Error(`Geocoding failed (HTTP ${response.status})`);
  const results = await response.json();
  const location = (Array.isArray(results) && results.length > 0)
    ? { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon), name: results[0].display_name }
    : null;

  geocodeCache.set(q, location);
  return location;
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
    geocodeCache.set(key, address);
    return address;
  } catch (err) {
    console.warn('⚠️ Reverse geocoding failed:', err);
    return null;
  }
}


/* --- Location autocomplete while typing (Photon / OpenStreetMap) --- */
const selectedLocationCoords = {}; // input id -> {lat, lng, label} picked from suggestions

function getSelectedCoords(inputId, currentValue) {
  const sel = selectedLocationCoords[inputId];
  if (sel && sel.label === (currentValue || '').trim()) return { lat: sel.lat, lng: sel.lng };
  return null;
}

function formatPhotonLabel(p) {
  const parts = [p.name, p.street, p.city || p.district || p.county, p.state, p.country].filter(Boolean);
  return [...new Set(parts)].slice(0, 4).join(', ');
}

async function fetchLocationSuggestions(query) {
  const params = new URLSearchParams({ q: query, limit: '6', lang: 'en' });
  if (map) { // bias results toward the current map view
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
  }

  function renderDropdown(list) {
    closeDropdown();
    if (!list.length) return;
    dropdown = document.createElement('div');
    dropdown.className = 'autocomplete-dropdown';
    list.forEach((s, i) => {
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
    // Editing the text invalidates a previously picked suggestion
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
    if (!dropdown) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(items.length - 1, activeIndex + 1); markActive(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(0, activeIndex - 1); markActive(); }
    else if (e.key === 'Enter' && activeIndex >= 0 && suggestions[activeIndex]) {
      e.preventDefault();
      selectSuggestion(suggestions[activeIndex]);
    }
    else if (e.key === 'Escape') { closeDropdown(); }
  });

  input.addEventListener('blur', () => setTimeout(closeDropdown, 150));
}

/* --- Distance / duration formatting (OSRM returns raw meters/seconds) --- */
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

/* --- Route planning via OSRM (replaces google.maps.DirectionsService) --- */
function computeViaPoint(points, fraction, offsetMeters) {
  // A point near the route at `fraction` along it, offset perpendicular by offsetMeters
  if (!points || points.length < 3) return null;
  const idx = Math.min(points.length - 2, Math.max(1, Math.round(fraction * (points.length - 1))));
  const a = points[idx - 1], b = points[idx + 1];
  const latRad = ((a[0] + b[0]) / 2) * Math.PI / 180;
  let dx = (b[1] - a[1]) * Math.cos(latRad);
  let dy = b[0] - a[0];
  const len = Math.hypot(dx, dy);
  if (!len) return null;
  const px = -dy / len, py = dx / len; // unit perpendicular
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
  // Use exact coordinates picked from autocomplete suggestions when available
  // (skips re-geocoding entirely — faster and more reliable)
  const originPicked = getSelectedCoords('source', source);
  const destPicked = getSelectedCoords('destination', destination);

  let origin = originPicked, dest = destPicked;
  if (!origin) origin = await geocodeLocation(source);
  if (!origin) throw new Error(`Could not find "${source}" on the map. Try a different spelling or use lat,lng.`);

  if (!dest) {
    if (!originPicked) await new Promise(r => setTimeout(r, 1100)); // Nominatim fair-use spacing
    dest = await geocodeLocation(destination);
  }
  if (!dest) throw new Error(`Could not find "${destination}" on the map. Try a different spelling or use lat,lng.`);

  console.log(`🗺️ OSRM route request: ${source} → ${destination}`);
  const firstRoutes = await fetchOSRMRoute(origin, dest, null, true);
  if (!firstRoutes) throw new Error('No driving route found between these locations. Try different locations.');

  const osrmRoutes = [...firstRoutes];

  // OSRM's demo server often returns only ONE route. Build genuinely different
  // alternatives by routing through a via-point offset from the main path, so
  // each route card corresponds to a different road (not the same polyline 3x).
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
        if (osrmRoutes.some(existing => existing.geometry === candidate.geometry || routesTooSimilar(existing, candidate))) continue; // same road — skip
        console.log(`🔀 Added alternative route via offset point (${v.fraction * 100}% along the route)`);
        osrmRoutes.push(candidate);
      } catch (err) {
        console.warn('⚠️ Alternative route fetch failed:', err.message);
      }
    }
  }

  return osrmRoutes.map((r, i) => ({
    index: i,
    polyline: r.geometry,                 // encoded polyline (precision 5, same as before)
    distance_text: formatDistanceMeters(r.distance),
    distance_meters: Math.round(r.distance),
    duration_text: formatDurationSeconds(r.duration),
    duration_seconds: Math.round(r.duration),
    summary: (r.legs && r.legs[0] && r.legs[0].summary) || ''
  }));
}

// Ping backend on load so Render free-tier wakes up before the user needs AI features
function warmUpBackend() {
  fetch(`${window.BACKEND_URL}/health`, { method: 'GET' })
    .then(() => console.log('✅ Backend is warm'))
    .catch(() => console.log('⏳ Backend waking up...'));
}

// Initialize the map and location autocomplete when the page loads
document.addEventListener('DOMContentLoaded', () => {
  warmUpBackend();
  initMap();
  attachLocationAutocomplete(document.getElementById('source'));
  attachLocationAutocomplete(document.getElementById('destination'));
});

/* --- ✅ NEW: Safety-Based Color System --- */
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

/* --- Config --- */
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

/* --- 1. Map Initialization --- */
window.initMap = function () {
  try {
    console.log("🗺️ Map Starting...");
    console.log('🎨 Safety Color System:');
    console.log('   ✅ Green: Score >= 75 (SAFE)');
    console.log('   ⚠️ Yellow: Score 60-74 (MODERATE)');
    console.log('   ❌ Red: Score < 60 (UNSAFE)');
    
    const mapElement = document.getElementById("map");
    if (!mapElement) {
      console.error("❌ Map element not found!");
      alert("Map container not found. Please refresh the page.");
      return;
    }
    
    if (typeof L === 'undefined') {
      console.error("❌ Leaflet library not loaded!");
      alert("Failed to load the map library (Leaflet). Please check your internet connection and refresh the page.");
      return;
    }

    // Leaflet map with free OpenStreetMap tiles (no API key required)
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
    alert("Failed to initialize map. Please check the console for details.");
  }
};

function initializeSocketIO() {
  socket.on("connect", () => {
    console.log("🔌 Connected to Server");
    console.log("🆔 Socket ID:", socket.id);
  });
  socket.on("disconnect", () => {
    console.log("🔌 Disconnected from Server");
  });
  socket.on("connect_error", (error) => {
    console.error("❌ Socket connection error:", error);
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
    clearHospitalsAndPolice(); // Clear hospital and police markers
    updateFeedbackListUI();
    
    // Clear displayed routes
    clearRouteRenderers();
    currentRoutes = [];
    
    // Clear route cards
    const container = document.getElementById("routes-list");
    if (container) container.innerHTML = "";
    
    console.log('✅ Local data cleared successfully');
    
    if (data && data.sos_deleted !== undefined && data.feedback_deleted !== undefined) {
      alert(`🗑️ Data cleared: ${data.sos_deleted} alerts & ${data.feedback_deleted} reports deleted`);
    } else {
      alert("🗑️ System data cleared.");
    }
  });
}

/* --- 2. Route Logic --- */
window.findRoutes = async function () {
  const source = document.getElementById("source").value;
  const destination = document.getElementById("destination").value;

  if (!source || !destination) return alert("Please enter locations");

  startLoadingAnimation();

  try {
    // Get alternative driving routes from OSRM (free, keyless routing service)
    const routes = await fetchRoutesFromOSRM(source, destination);

    if (!routes || routes.length === 0) {
      stopLoadingAnimation();
      alert("Routes not found. Please try different locations.");
      return;
    }

    lastDirectionsResult = { routes };
    sendToBackendForAnalysis(source, destination);
  } catch (error) {
    console.error("❌ Route search failed:", error);
    stopLoadingAnimation();
    alert(`Could not find routes: ${error.message}\n\nPlease check:\n1. Both locations are spelled correctly (or use lat,lng)\n2. Internet connection\n3. A road route exists between them`);
  }
};

function sendToBackendForAnalysis(source, destination) {
  console.log(`🔍 Sending route request to backend: ${source} → ${destination}`);

  // Pass the exact routes OSRM returned to the frontend so the backend
  // analyses the same polylines — no separate routing call, no index mismatch.
  const frontendRoutes = (lastDirectionsResult && lastDirectionsResult.routes || []).map((r, i) => ({
    index: i,
    polyline: r.polyline,
    distance_text: r.distance_text,
    distance_meters: r.distance_meters,
    duration_text: r.duration_text,
    duration_seconds: r.duration_seconds,
    summary: r.summary || ''
  }));

  const postRoutes = () => fetch(`${window.BACKEND_URL}/get-routes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, destination, frontend_routes: frontendRoutes })
  });

  postRoutes()
    // One automatic retry — the backend may still be booting / waking from sleep
    .catch(() => new Promise((resolve, reject) =>
      setTimeout(() => postRoutes().then(resolve, reject), 2500)))
    .then((res) => res.json())
    .then((data) => {
      stopLoadingAnimation();

      if (data.error) {
        console.error("Backend Error:", data.error);
        alert("Server Error: " + data.error);
        return;
      }

      console.log(`📊 Backend returned ${data.length} routes:`);
      data.forEach((route, index) => {
        console.log(`   Route ${index + 1}: ${route.summary || 'Unknown'} - Safety: ${route.safety_score}`);
      });

      if (Array.isArray(data) && data.length > 0) {
        currentRoutes = data;
        displayRouteCards(data);
        selectRoute(0);
        refreshHeatmapIfActive();
      } else {
        alert("No route analysis data returned.");
      }
    })
    .catch((err) => {
      stopLoadingAnimation();
      console.error(err);
      alert(`Cannot reach the backend at ${window.BACKEND_URL}.\n\nThis usually means it is still starting up (or waking from sleep on the free hosting tier).\n\n→ Wait a few seconds and click "Analyze Route Safety" again.`);
    });
}

/* --- 3. ✅ UPDATED: UI Display with Safety Colors --- */
function displayRouteCards(routes) {
  const container = document.getElementById("routes-list");
  if (!container) return;
  container.innerHTML = "";

  console.log(`📊 Displaying ${routes.length} route cards with safety colors:`);

  routes.forEach((route, index) => {
    const score = route.safety_score || 0;
    
    // ✅ Get safety-based color and label
    const safetyInfo = getSafetyLabel(score);
    const scoreColor = safetyInfo.color;
    const scoreText = safetyInfo.text;
    
    console.log(`📊 Route ${index + 1}: Score ${score} → ${scoreText} (${scoreColor})`);

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
          <span><i class="fa-regular fa-clock"></i> ${route.duration}</span>
          <span><i class="fa-solid fa-ruler"></i> ${route.distance}</span>
        </div>
        <div class="route-badges">
          <span class="badge"><i class="fa-solid fa-hospital"></i> ${route.hospital_count || 0} Hospitals</span>
          <span class="badge"><i class="fa-solid fa-user-shield"></i> ${route.police_count || 0} Police Stn</span>
          <span class="badge"><i class="fa-solid fa-lightbulb"></i> ${route.street_light_score || 0}% Lights</span>
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
          <div class="ai-header"><i class="fa-solid fa-robot"></i> SafeRoute AI</div>
          <div id="ai-text-${index}"></div>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
  
  console.log(`✅ All ${routes.length} route cards displayed with safety colors`);
  // Auto-load predictive forecast for each card
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
    // Show hospitals and police stations for selected route
    showHospitalsAndPolice(currentRoutes[index]);
  }
  
  // Auto-close sidebar on mobile after route selection
  if (window.innerWidth <= 768) {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.querySelector('.sidebar-overlay');
    if (sidebar.classList.contains('active')) {
      sidebar.classList.remove('active');
      overlay.classList.remove('active');
      document.body.style.overflow = '';
    }
  }
};

/* --- AI Safety Explainer --- */
window.explainRoute = async function(event, index) {
  event.stopPropagation(); // Don't trigger route selection

  const btn = event.currentTarget;
  const panel = document.getElementById(`ai-panel-${index}`);
  const textEl = document.getElementById(`ai-text-${index}`);
  const route = currentRoutes[index];

  if (!route) return;

  // Toggle off if already visible
  if (panel.classList.contains('visible')) {
    panel.classList.remove('visible');
    btn.innerHTML = '<i class="fa-solid fa-robot"></i> Ask AI Why';
    return;
  }

  // Show loading state
  btn.classList.add('loading');
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Analyzing...';
  panel.classList.add('visible');
  textEl.textContent = 'SafeRoute AI is analyzing this route...';

  const attemptExplain = async (attempt) => {
    const res = await fetch(`${window.BACKEND_URL}/explain-route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route_index: index, route: route })
    });

    if (res.status === 503) {
      if (attempt < 3) {
        const waitSec = attempt * 20;
        textEl.textContent = `AI service is starting up... retrying in ${waitSec}s (attempt ${attempt}/3)`;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Waking up...`;
        await new Promise(r => setTimeout(r, waitSec * 1000));
        return attemptExplain(attempt + 1);
      }
      throw new Error('service_unavailable');
    }

    const data = await res.json();
    return data;
  };

  try {
    const data = await attemptExplain(1);

    if (data.explanation) {
      textEl.textContent = data.explanation;
      btn.innerHTML = '<i class="fa-solid fa-robot"></i> Hide AI Insight';
    } else {
      textEl.textContent = 'Unable to generate explanation. Please try again.';
      btn.innerHTML = '<i class="fa-solid fa-robot"></i> Ask AI Why';
    }
  } catch (err) {
    if (err.message === 'service_unavailable') {
      textEl.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> The AI backend is temporarily unavailable (Render free tier sleeping). Please wait ~30s and try again.';
    } else {
      textEl.textContent = 'Could not reach SafeRoute AI. Check your connection.';
    }
    btn.innerHTML = '<i class="fa-solid fa-robot"></i> Ask AI Why';
    console.error('AI Explain Error:', err);
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

  try {
    const res  = await fetch(`${window.BACKEND_URL}/predict-safety`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route_index: index, route, client_hour: new Date().getHours() })
    });
    const data = await res.json();
    if (!data.slots) throw new Error('no data');

    const currentHour = data.current_hour;
    const nowScore    = data.current_score;

    const slotsHTML = data.slots.map(slot => {
      const isNow   = Math.abs(slot.hour - currentHour) <= 2;
      const color   = getSafetyColorHex(slot.score);
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

  } catch {
    // Fallback: compute client-side without backend
    const route   = currentRoutes[index];
    const base    = route.safety_score || 50;
    const lights  = route.street_light_score || 50;
    const police  = route.police_count || 0;
    const now     = new Date().getHours();

    const localAdjust = h => {
      let adj = 0;
      if (h >= 23 || h < 5)  { adj -= 18; if (lights < 40) adj -= 10; if (!police) adj -= 8; }
      else if (h >= 20)      { adj -= 10; if (lights < 55) adj -= 5; }
      else if (h >= 18)      { adj -= 5; }
      else if ((h>=7&&h<10)||(h>=17&&h<20)) { adj -= 4; }
      else if (h >= 9)       { adj += 6; }
      return Math.max(5, Math.min(100, Math.round(base + adj)));
    };

    const slots = [{label:'7 AM',hour:7},{label:'2 PM',hour:14},{label:'8 PM',hour:20},{label:'11 PM',hour:23}];
    const slotsHTML = slots.map(s => {
      const sc = localAdjust(s.hour);
      const isNow = Math.abs(s.hour - now) <= 2;
      const color = getSafetyColorHex(sc);
      return `<div class="fc-slot ${isNow?'fc-slot-now':''}">
        ${isNow?'<span class="fc-now-badge">NOW</span>':''}
        <span class="fc-time">${s.label}</span>
        <div class="fc-bar-wrap"><div class="fc-bar" style="width:${sc}%;background:${color}"></div></div>
        <span class="fc-score" style="color:${color}">${sc}</span>
      </div>`;
    }).join('');

    panel.innerHTML = `<div class="fc-header"><i class="fa-solid fa-chart-line"></i> Safety Forecast</div>${slotsHTML}`;
  }
}

/* --- AI Route Narrator --- */
let narratingIndex = null;

// Fallback: build narration text locally from route data (no Groq needed)
function buildLocalNarration(route, routeNum) {
  const score     = route.safety_score || 0;
  const hospitals = route.hospital_count || 0;
  const police    = route.police_count   || 0;
  const lights    = route.street_light_score || 0;
  const distance  = route.distance || '';
  const duration  = route.duration || '';
  const incidents = route.crime_incidents || [];

  const toWords = n => ['zero','one','two','three','four','five','six','seven','eight','nine','ten'][n] ?? String(n);

  const verdict = score >= 75 ? 'your safest option'
                : score >= 60 ? 'a moderately safe route'
                : 'a high-risk route — use caution';

  const hospText   = hospitals === 0 ? 'no hospitals' : `${toWords(hospitals)} hospital${hospitals > 1 ? 's' : ''}`;
  const policeText = police    === 0 ? 'no police stations' : `${toWords(police)} police station${police > 1 ? 's' : ''}`;

  const lightDesc  = lights >= 70 ? 'well lit' : lights >= 45 ? 'moderately lit' : 'poorly lit';

  const incidentTypes = [...new Set(incidents.map(i => i.type))].slice(0, 2);
  const incidentText  = incidentTypes.length
    ? `Watch out for reported ${incidentTypes.join(' and ')} incidents along the way.`
    : 'No major incidents have been reported on this route.';

  const hour = new Date().getHours();
  const timeTip = hour >= 21 || hour < 6
    ? 'It is late at night — stay on main roads and share your location with someone you trust.'
    : hour >= 18
    ? 'It is evening — prefer well-lit stretches and stay aware of your surroundings.'
    : 'Travel conditions are good for this time of day.';

  return `Route ${routeNum} is ${verdict}, with a safety score of ${score} out of 100. `
       + `The route is ${distance} and takes approximately ${duration}. `
       + `You will pass ${hospText} and ${policeText}, and the streets are ${lightDesc}. `
       + `${incidentText} `
       + `${timeTip} Stay safe and have a good journey.`;
}

// Load voices reliably (getVoices() is async on first call)
function getEnglishVoice() {
  return new Promise(resolve => {
    const pick = list => list.find(v =>
      v.lang.startsWith('en') && (v.name.includes('Google') || v.name.includes('Zira') || v.name.includes('David') || v.name.includes('Natural'))
    ) || list.find(v => v.lang.startsWith('en')) || null;

    const voices = window.speechSynthesis.getVoices();
    if (voices.length) { resolve(pick(voices)); return; }
    window.speechSynthesis.onvoiceschanged = () => resolve(pick(window.speechSynthesis.getVoices()));
    setTimeout(() => resolve(null), 2000); // safety timeout
  });
}

function resetNarrateBtn(index) {
  const btn = document.getElementById(`narrate-btn-${index}`);
  if (btn) { btn.innerHTML = '<i class="fa-solid fa-volume-high"></i> Narrate'; btn.classList.remove('speaking'); }
  narratingIndex = null;
}

function speakText(text, index) {
  const btn = document.getElementById(`narrate-btn-${index}`);
  getEnglishVoice().then(voice => {
    const utter    = new SpeechSynthesisUtterance(text);
    utter.rate     = 0.93;
    utter.pitch    = 1.0;
    utter.volume   = 1.0;
    if (voice) utter.voice = voice;
    utter.onend    = () => resetNarrateBtn(index);
    utter.onerror  = () => resetNarrateBtn(index);
    if (btn) btn.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
    window.speechSynthesis.speak(utter);
  });
}

window.narrateRoute = async function(event, index) {
  event.stopPropagation();

  const btn   = document.getElementById(`narrate-btn-${index}`);
  const route = currentRoutes[index];
  if (!route || !btn) return;

  // Toggle off if already speaking this route
  if (narratingIndex === index && window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    resetNarrateBtn(index);
    return;
  }

  // Stop any other narration
  window.speechSynthesis.cancel();
  document.querySelectorAll('.ai-narrate-btn').forEach(b => {
    b.innerHTML = '<i class="fa-solid fa-volume-high"></i> Narrate';
    b.classList.remove('speaking');
  });

  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Loading...';
  btn.classList.add('speaking');
  narratingIndex = index;

  const attemptNarrate = async (attempt) => {
    const res = await fetch(`${window.BACKEND_URL}/narrate-route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ route_index: index, route, client_hour: new Date().getHours() })
    });

    if (res.status === 503) {
      if (attempt < 3) {
        const waitSec = attempt * 20;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Waking up (${waitSec}s)...`;
        await new Promise(r => setTimeout(r, waitSec * 1000));
        return attemptNarrate(attempt + 1);
      }
      return null; // exhausted retries — fall back to local
    }

    const data = await res.json();
    return data.narration || null;
  };

  try {
    const narration = await attemptNarrate(1);
    if (narration) {
      speakText(narration, index);
    } else {
      console.log('🔊 AI unavailable, using local narration');
      speakText(buildLocalNarration(route, index + 1), index);
    }
  } catch {
    console.log('🔊 Backend unreachable, using local narration');
    speakText(buildLocalNarration(route, index + 1), index);
  }
};

/* --- ✅ UPDATED: Route Rendering with Safety Colors (Leaflet) --- */
function clearRouteRenderers() {
  rendererArray.forEach((layer) => { if (map) map.removeLayer(layer); });
  rendererArray = [];
}

function renderAllRoutes(selectedIndex) {
  clearRouteRenderers();

  // Clear hospital and police markers when switching routes
  clearHospitalsAndPolice();

  if (!lastDirectionsResult) return;

  // Handle both real OSRM routes and synthetic routes
  const totalRoutes = Math.max(lastDirectionsResult.routes.length, currentRoutes.length);
  const combinedBounds = L.latLngBounds([]);

  for (let index = 0; index < totalRoutes; index++) {
    const isSelected = index === selectedIndex;
    const hasRouteData = index < currentRoutes.length;
    // Use the original route index stored during backend sorting,
    // so the correct polyline is drawn for each safety-ranked card.
    const originalRouteIndex = (hasRouteData && currentRoutes[index].index !== undefined)
      ? currentRoutes[index].index
      : index;
    const hasPlannedRoute = originalRouteIndex < lastDirectionsResult.routes.length;

    // ✅ Get safety-based color for ALL routes (not just selected)
    let routeColor = "#94a3b8"; // Default gray fallback

    if (hasRouteData && currentRoutes[index]) {
      const safetyScore = currentRoutes[index].safety_score || 0;
      routeColor = getSafetyColor(safetyScore);

      console.log(`🎨 Rendering Route ${index + 1}:`);
      console.log(`   Safety Score: ${safetyScore}`);
      console.log(`   Route Color: ${routeColor}`);
      console.log(`   Selected: ${isSelected ? 'YES' : 'NO'}`);
      console.log(`   Has Planned Route: ${hasPlannedRoute ? 'YES' : 'NO (Synthetic)'}`);
      console.log(`   Status: ${safetyScore >= 75 ? 'SAFE ✅' : safetyScore >= 60 ? 'MODERATE ⚠️' : 'UNSAFE ❌'}`);
    } else {
      console.log(`⚠️ Route ${index + 1}: No safety data available, using gray`);
    }

    // Pick the polyline: the planned OSRM route first, synthetic route as fallback
    let polylineStr = null;
    if (hasPlannedRoute && lastDirectionsResult.routes[originalRouteIndex] && lastDirectionsResult.routes[originalRouteIndex].polyline) {
      polylineStr = lastDirectionsResult.routes[originalRouteIndex].polyline;
    } else if (hasRouteData && currentRoutes[index] && currentRoutes[index].polyline) {
      console.log(`🔄 Using synthetic polyline for Route ${index + 1}`);
      polylineStr = currentRoutes[index].polyline;
    }

    if (!polylineStr) continue;

    try {
      // Decode the encoded polyline to [[lat, lng], ...] points for Leaflet
      const routePoints = decodePolyline(polylineStr);

      const routeLine = L.polyline(routePoints, {
        color: routeColor,
        opacity: isSelected ? 1.0 : 0.65,
        weight: isSelected ? 8 : 5,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(map);

      // Click a route on the map to select its card
      routeLine.on('click', () => selectRoute(index));

      rendererArray.push(routeLine);
      combinedBounds.extend(routeLine.getBounds());

      if (isSelected) routeLine.bringToFront();

      console.log(`✅ Route ${index + 1} polyline rendered with ${routePoints.length} points`);
    } catch (error) {
      console.error(`❌ Error rendering polyline for Route ${index + 1}:`, error);
    }
  }

  // Frame the map around all displayed routes
  if (!combinedBounds.isEmpty()) {
    map.fitBounds(combinedBounds, { padding: [40, 40] });
  }
}

/* --- 4. Helpers --- */
window.getCurrentLocationForInput = async function () {
  if (!navigator.geolocation) return alert("Geolocation not supported.");

  const btn = document.querySelector(".locate-me-btn");
  btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i>';

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const crd = { lat: pos.coords.latitude, lng: pos.coords.longitude };

      // Reverse geocode via Nominatim (OpenStreetMap, free & keyless)
      const address = await reverseGeocodeLocation(crd.lat, crd.lng);
      btn.innerHTML = '<i class="fa-solid fa-crosshairs"></i>';

      document.getElementById("source").value = address
        ? address
        : `${crd.lat.toFixed(5)}, ${crd.lng.toFixed(5)}`;

      map.setView([crd.lat, crd.lng], 16);

      // Place / move the "You are here" marker (animated blue dot)
      if (userMarker) map.removeLayer(userMarker);
      const dotIcon = L.divIcon({
        className: 'user-location-pin',
        html: `<div style="width:22px;height:22px;border-radius:50%;background:#0ea5e9;border:3px solid #ffffff;
                      box-shadow:0 0 0 6px rgba(14,165,233,0.25), 0 3px 8px rgba(0,0,0,0.35);"></div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });
      userMarker = L.marker([crd.lat, crd.lng], { icon: dotIcon, title: "Your Location", zIndexOffset: 1000 }).addTo(map);

      // Info bubble showing address
      const label = address ? address : `${crd.lat.toFixed(5)}, ${crd.lng.toFixed(5)}`;
      userMarker.bindPopup(`<div style="font-size:13px;font-weight:600;padding:2px 4px">
                      <i style="color:#0ea5e9">📍</i> <b>You are here</b><br>
                      <span style="font-weight:400;color:#555">${label}</span>
                    </div>`).openPopup();
    },
    (err) => {
      btn.innerHTML = '<i class="fa-solid fa-crosshairs"></i>';
      alert("Location access denied.");
    },
    { enableHighAccuracy: true }
  );
};

/* --- 5. SOS Emergency Alert --- */
window.sendEmergencyAlert = function() {
    if(!confirm("⚠️ Send SOS Alert? Your location will be broadcast to emergency responders.")) {
        return;
    }
    
    const modal = document.getElementById('sos-modal');
    const originalContent = modal.querySelector('.modal-body').innerHTML;
    modal.querySelector('.modal-body').innerHTML = `
        <div style="text-align:center; padding:40px;">
            <i class="fa-solid fa-circle-notch fa-spin" style="font-size:3rem; color:var(--danger);"></i>
            <h3 style="margin-top:20px;">Getting Your Location...</h3>
            <p style="color:#666;">AI is preparing emergency assistance...</p>
        </div>
    `;
    
    if (!navigator.geolocation) {
        alert("❌ Geolocation is not supported by your browser.");
        modal.querySelector('.modal-body').innerHTML = originalContent;
        return;
    }
    
    console.log("🚨 SOS: Requesting location...");
    
    navigator.geolocation.getCurrentPosition(
        async (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            const accuracy = position.coords.accuracy;
            
            console.log("✅ Location obtained:", {lat, lng, accuracy});
            
            if (!lat || !lng || isNaN(lat) || isNaN(lng)) {
                throw new Error('Invalid coordinates received');
            }
            
            modal.querySelector('.modal-body').innerHTML = `
                <div style="text-align:center; padding:40px;">
                    <i class="fa-solid fa-robot fa-spin" style="font-size:3rem; color:var(--primary);"></i>
                    <h3 style="margin-top:20px;">AI Analyzing Emergency Services...</h3>
                    <p style="color:#666;">Finding nearby hospitals, police, and safe places...</p>
                </div>
            `;
            
            try {
                console.log('📡 Sending SOS to backend...');
                console.log('📍 Coordinates:', { lat, lng, accuracy });
                console.log('👤 User Name:', getUserName());
                console.log('🌐 Backend URL:', `${window.BACKEND_URL}/send-alert`);
                console.log('🌐 Current page URL:', window.location.href);
                
                // Add timeout and better error handling
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
                
                const response = await fetch(`${window.BACKEND_URL}/send-alert`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ 
                        lat: lat, 
                        lng: lng, 
                        accuracy: accuracy,
                        user_name: getUserName() // Include user name
                    }),
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                console.log('📨 Response status:', response.status);
                console.log('📨 Response ok:', response.ok);
                
                if (!response.ok) {
                    const errorText = await response.text();
                    console.error('❌ HTTP Error Response:', errorText);
                    throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`);
                }
                
                const data = await response.json();
                console.log('📦 Full response from backend:', data);
                
                if (response.ok) {
                    console.log("✅ SOS Alert sent successfully:", data);
                    
                    // Show simple success alert
                    alert(`🚨 SOS Alert Sent!\nAlert ID: ${data.alert_id}\nEmergency services notified`);
                    
                    // Enhanced check for emergency suggestions
                    if (!data.emergency_suggestions) {
                        console.error('⚠️ WARNING: No emergency_suggestions in response!');
                        console.error('📦 Full response structure:', Object.keys(data));
                        
                        modal.querySelector('.modal-body').innerHTML = `
                            <div style="text-align:center; padding:20px;">
                                <div style="background:#d4edda; color:#155724; padding:15px; border-radius:8px; margin-bottom:20px;">
                                    <h3>🚨 SOS ALERT SENT!</h3>
                                    <p>Alert ID: ${data.alert_id}<br>Time: ${data.timestamp}</p>
                                </div>
                                <div style="background:#fff3cd; color:#856404; padding:15px; border-radius:6px; margin-bottom:15px;">
                                    <p><strong>⚠️ Emergency services data not available</strong></p>
                                    <p>Your alert has been sent to emergency responders.</p>
                                    <p><strong>Call 112 for immediate assistance</strong></p>
                                </div>
                                <button onclick="closeModal(null, 'sos-modal')" class="primary-btn">Close</button>
                            </div>
                        `;
                        return;
                    }
                    
                    console.log("📋 About to call displayEmergencySuggestions...");
                    console.log("📊 Emergency suggestions structure:", Object.keys(data.emergency_suggestions));
                    console.log("📊 Hospitals count:", data.emergency_suggestions.hospitals?.length || 0);
                    console.log("📊 Police count:", data.emergency_suggestions.police_stations?.length || 0);
                    
                    try {
                        displayEmergencySuggestions(data.emergency_suggestions, data.alert_id, lat, lng, data.timestamp);
                        console.log("✅ displayEmergencySuggestions called successfully");
                    } catch (displayError) {
                        console.error("❌ Error in displayEmergencySuggestions:", displayError);
                        console.error("❌ Error stack:", displayError.stack);
                        alert(`❌ Error displaying emergency services: ${displayError.message}`);
                    }
                } else {
                    throw new Error(data.error || 'Failed to send SOS');
                }
                
            } catch (error) {
                console.error("❌ Error sending SOS:", error);
                console.error("❌ Error type:", error.name);
                console.error("❌ Error message:", error.message);
                modal.querySelector('.modal-body').innerHTML = originalContent;
                
                let errorMessage = `❌ Error sending SOS alert: ${error.message}`;
                
                // Provide specific error messages based on error type
                if (error.name === 'AbortError') {
                    errorMessage += `\\n\\n⏱️ Request timed out after 30 seconds.\\n\\nPlease check:\\n- Internet connection\\n- Backend server is running\\n- No firewall blocking the connection`;
                } else if (error.message.includes('Failed to fetch') || error.message.includes('fetch')) {
                    errorMessage = `❌ Connection failed to backend server.\\n\\n🔗 This usually means:\\n- Backend server is not running\\n- CORS policy blocking the request\\n- Network connectivity issues\\n\\n🛠️ Solutions:\\n1. Make sure backend is running\\n2. Check if ${window.BACKEND_URL} is accessible\\n3. Try refreshing the page\\n4. Check browser console for more details`;
                } else if (error.message.includes('NetworkError')) {
                    errorMessage += `\\n\\n🌐 Network error occurred.\\n\\nPlease check your internet connection and try again.`;
                } else {
                    errorMessage += `\\n\\nPlease check:\\n- Internet connection\\n- Backend server is running\\n- Backend is accessible at ${window.BACKEND_URL}`;
                }
                
                alert(errorMessage);
            }
        },
        (error) => {
            console.error("❌ Geolocation error:", error);
            modal.querySelector('.modal-body').innerHTML = originalContent;
            
            let errorMessage = "Unable to get your location.";
            switch(error.code) {
                case error.PERMISSION_DENIED:
                    errorMessage += " Location permission denied.";
                    break;
                case error.POSITION_UNAVAILABLE:
                    errorMessage += " Location information unavailable.";
                    break;
                case error.TIMEOUT:
                    errorMessage += " Location request timed out.";
                    break;
                default:
                    errorMessage += " Error: " + error.message;
            }
            alert(errorMessage);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
};

function displayEmergencySuggestions(suggestions, alertId, lat, lng, timestamp) {
    console.log('🚀 displayEmergencySuggestions CALLED');
    console.log('📦 Suggestions:', suggestions);
    console.log('📋 Alert ID:', alertId);
    console.log('📍 Location:', lat, lng);
    console.log('⏰ Timestamp:', timestamp);
    
    try {
        // Close the original SOS modal
        const sosModal = document.getElementById('sos-modal');
        if (sosModal) {
            sosModal.classList.remove('active');
            console.log('✅ Original SOS modal closed');
        }
        
        // Open the emergency suggestions modal
        const emergencyModal = document.getElementById('emergency-suggestions-modal');
        const emergencyBody = document.getElementById('emergency-suggestions-body');
        
        console.log('🔍 Emergency modal element:', emergencyModal);
        console.log('🔍 Emergency body element:', emergencyBody);
        console.log('🔍 Modal computed style:', window.getComputedStyle(emergencyModal));
        
        if (!emergencyModal || !emergencyBody) {
            console.error('❌ Emergency modal elements not found!');
            console.error('Available elements with emergency in ID:', 
                Array.from(document.querySelectorAll('[id*="emergency"]')).map(el => el.id));
            alert('❌ ERROR: Emergency modal not found in DOM!');
            return;
        }
        
        // Validate suggestions
        if (!suggestions || typeof suggestions !== 'object') {
            console.warn('⚠️ Invalid suggestions data:', suggestions);
            emergencyBody.innerHTML = `
                <div style="padding:20px; text-align:center;">
                    <h3>🚨 SOS ALERT SENT!</h3>
                    <p>Alert ID: ${alertId}</p>
                    <p>Emergency services have been notified.</p>
                    <button onclick="closeEmergencySuggestionsModal()" class="primary-btn">Close</button>
                </div>
            `;
            emergencyModal.classList.add('active');
            emergencyModal.style.display = 'flex';
            return;
        }
        
        console.log('🔨 Building emergency suggestions HTML...');
        console.log('📊 Data breakdown:', {
            hospitals: suggestions.hospitals?.length || 0,
            police: suggestions.police_stations?.length || 0,
            mechanics: suggestions.mechanics?.length || 0,
            safePlace: suggestions.hotels_restrooms?.length || 0,
            tips: suggestions.emergency_tips?.length || 0
        });
        
        let suggestionsHTML = `
            <div style="max-height:70vh; overflow-y:auto; padding:20px;">
                <div style="background:#d4edda; color:#155724; padding:15px; border-radius:8px; margin-bottom:15px; text-align:center;">
                    <h3>✅ SOS ALERT SENT SUCCESSFULLY!</h3>
                    <p>Alert ID: ${alertId} | Time: ${timestamp}</p>
                    <p>📍 ${lat.toFixed(6)}, ${lng.toFixed(6)}</p>
                </div>
                
                <div style="background:#fff3cd; color:#856404; padding:15px; border-radius:6px; margin-bottom:20px;">
                    <h4><i class="fa-solid fa-robot"></i> AI Emergency Assistance</h4>
                    <p>Click <strong>"Call"</strong> or <strong>"Navigate"</strong> buttons below for immediate assistance.</p>
                </div>
        `;
        
        // Add hospitals
        if (suggestions.hospitals && suggestions.hospitals.length > 0) {
            suggestionsHTML += `<h4 style="color:#dc3545; margin:20px 0 10px 0;"><i class="fa-solid fa-hospital"></i> Nearby Hospitals (${suggestions.hospitals.length})</h4>`;
            suggestions.hospitals.forEach(hospital => {
                suggestionsHTML += `
                    <div style="border:1px solid #ddd; padding:15px; margin:10px 0; border-radius:8px; background:#fff;">
                        <div style="font-weight:600; color:#dc3545; font-size:16px;">${hospital.name}</div>
                        <div style="font-size:13px; color:#666; margin:5px 0;">${hospital.address}</div>
                        <div style="font-size:13px; margin:8px 0;">
                            <span style="color:#28a745; font-weight:600;">📞 ${hospital.phone}</span>
                            <span style="margin-left:15px; color:#6c757d;">📍 ${hospital.distance}</span>
                        </div>
                        ${hospital.specialties ? `<div style="font-size:12px; color:#007bff; margin:5px 0;">🏥 ${hospital.specialties.join(', ')}</div>` : ''}
                        <div style="margin-top:12px; display:flex; gap:10px;">
                            <button onclick="callEmergencyService('${hospital.phone.replace(/'/g, "\\'")}');" 
                                    style="background:#28a745; color:white; border:none; padding:8px 15px; border-radius:5px; font-size:12px; cursor:pointer; font-weight:600;">
                                <i class="fa-solid fa-phone"></i> Call Now
                            </button>
                            <button onclick="navigateToEmergencyService('${hospital.name.replace(/'/g, "\\'")}', ${hospital.lat || lat}, ${hospital.lng || lng}, ${lat}, ${lng});" 
                                    style="background:#007bff; color:white; border:none; padding:8px 15px; border-radius:5px; font-size:12px; cursor:pointer; font-weight:600;">
                                <i class="fa-solid fa-route"></i> Navigate
                            </button>
                        </div>
                    </div>
                `;
            });
        }
        
        // Add police stations
        if (suggestions.police_stations && suggestions.police_stations.length > 0) {
            suggestionsHTML += `<h4 style="color:#007bff; margin:20px 0 10px 0;"><i class="fa-solid fa-shield-halved"></i> Police Stations (${suggestions.police_stations.length})</h4>`;
            suggestions.police_stations.forEach(police => {
                suggestionsHTML += `
                    <div style="border:1px solid #ddd; padding:15px; margin:10px 0; border-radius:8px; background:#fff;">
                        <div style="font-weight:600; color:#007bff; font-size:16px;">${police.name}</div>
                        <div style="font-size:13px; color:#666; margin:5px 0;">${police.address}</div>
                        <div style="font-size:13px; margin:8px 0;">
                            <span style="color:#28a745; font-weight:600;">📞 ${police.phone}</span>
                            <span style="margin-left:15px; color:#6c757d;">📍 ${police.distance}</span>
                        </div>
                        <div style="font-size:12px; color:#007bff; margin:5px 0;">👮 ${police.type}</div>
                        <div style="margin-top:12px; display:flex; gap:10px;">
                            <button onclick="callEmergencyService('${police.phone.replace(/'/g, "\\'")}');" 
                                    style="background:#28a745; color:white; border:none; padding:8px 15px; border-radius:5px; font-size:12px; cursor:pointer; font-weight:600;">
                                <i class="fa-solid fa-phone"></i> Call Now
                            </button>
                            <button onclick="navigateToEmergencyService('${police.name.replace(/'/g, "\\'")}', ${police.lat || lat}, ${police.lng || lng}, ${lat}, ${lng});" 
                                    style="background:#007bff; color:white; border:none; padding:8px 15px; border-radius:5px; font-size:12px; cursor:pointer; font-weight:600;">
                                <i class="fa-solid fa-route"></i> Navigate
                            </button>
                        </div>
                    </div>
                `;
            });
        }
        
        // Add mechanics
        if (suggestions.mechanics && suggestions.mechanics.length > 0) {
            suggestionsHTML += `<h4 style="color:#fd7e14; margin:20px 0 10px 0;"><i class="fa-solid fa-wrench"></i> Emergency Mechanics (${suggestions.mechanics.length})</h4>`;
            suggestions.mechanics.forEach(mechanic => {
                suggestionsHTML += `
                    <div style="border:1px solid #ddd; padding:15px; margin:10px 0; border-radius:8px; background:#fff;">
                        <div style="font-weight:600; color:#fd7e14; font-size:16px;">${mechanic.name}</div>
                        <div style="font-size:13px; color:#666; margin:5px 0;">${mechanic.address}</div>
                        <div style="font-size:13px; margin:8px 0;">
                            <span style="color:#28a745; font-weight:600;">📞 ${mechanic.phone}</span>
                            <span style="margin-left:15px; color:#6c757d;">📍 ${mechanic.distance}</span>
                        </div>
                        ${mechanic.services ? `<div style="font-size:12px; color:#fd7e14; margin:5px 0;">🔧 ${mechanic.services.join(', ')}</div>` : ''}
                        <div style="margin-top:12px; display:flex; gap:10px;">
                            <button onclick="callEmergencyService('${mechanic.phone.replace(/'/g, "\\'")}');" 
                                    style="background:#28a745; color:white; border:none; padding:8px 15px; border-radius:5px; font-size:12px; cursor:pointer; font-weight:600;">
                                <i class="fa-solid fa-phone"></i> Call Now
                            </button>
                            <button onclick="navigateToEmergencyService('${mechanic.name.replace(/'/g, "\\'")}', ${mechanic.lat || lat}, ${mechanic.lng || lng}, ${lat}, ${lng});" 
                                    style="background:#007bff; color:white; border:none; padding:8px 15px; border-radius:5px; font-size:12px; cursor:pointer; font-weight:600;">
                                <i class="fa-solid fa-route"></i> Navigate
                            </button>
                        </div>
                    </div>
                `;
            });
        }
        
        // Add safe places
        if (suggestions.hotels_restrooms && suggestions.hotels_restrooms.length > 0) {
            suggestionsHTML += `<h4 style="color:#6f42c1; margin:20px 0 10px 0;"><i class="fa-solid fa-bed"></i> Safe Places (${suggestions.hotels_restrooms.length})</h4>`;
            suggestions.hotels_restrooms.forEach(place => {
                suggestionsHTML += `
                    <div style="border:1px solid #ddd; padding:15px; margin:10px 0; border-radius:8px; background:#fff;">
                        <div style="font-weight:600; color:#6f42c1; font-size:16px;">${place.name}</div>
                        <div style="font-size:13px; color:#666; margin:5px 0;">${place.address}</div>
                        <div style="font-size:13px; margin:8px 0;">
                            <span style="color:#28a745; font-weight:600;">📞 ${place.phone}</span>
                            <span style="margin-left:15px; color:#6c757d;">📍 ${place.distance}</span>
                        </div>
                        ${place.amenities ? `<div style="font-size:12px; color:#6f42c1; margin:5px 0;">🏨 ${place.amenities.join(', ')}</div>` : ''}
                        <div style="margin-top:12px; display:flex; gap:10px;">
                            <button onclick="callEmergencyService('${place.phone.replace(/'/g, "\\'")}');" 
                                    style="background:#28a745; color:white; border:none; padding:8px 15px; border-radius:5px; font-size:12px; cursor:pointer; font-weight:600;">
                                <i class="fa-solid fa-phone"></i> Call Now
                            </button>
                            <button onclick="navigateToEmergencyService('${place.name.replace(/'/g, "\\'")}', ${place.lat || lat}, ${place.lng || lng}, ${lat}, ${lng});" 
                                    style="background:#007bff; color:white; border:none; padding:8px 15px; border-radius:5px; font-size:12px; cursor:pointer; font-weight:600;">
                                <i class="fa-solid fa-route"></i> Navigate
                            </button>
                        </div>
                    </div>
                `;
            });
        }
        
        // Add emergency tips
        if (suggestions.emergency_tips && suggestions.emergency_tips.length > 0) {
            suggestionsHTML += `
                <h4 style="color:#20c997; margin:20px 0 10px 0;"><i class="fa-solid fa-lightbulb"></i> Emergency Safety Tips</h4>
                <div style="background:#e8f5e8; padding:15px; border-radius:8px; border-left:4px solid #20c997;">
                    <ul style="margin:0; padding-left:20px; font-size:14px; color:#495057; line-height:1.6;">
            `;
            suggestions.emergency_tips.forEach(tip => {
                suggestionsHTML += `<li style="margin-bottom:8px;">${tip}</li>`;
            });
            suggestionsHTML += `</ul></div>`;
        }
        
        suggestionsHTML += `
                <div style="text-align:center; margin-top:25px; padding:20px; border-top:2px solid #dee2e6; background:#f8f9fa;">
                    <p style="margin:0 0 15px 0; font-size:14px; color:#666; font-weight:600;">
                        📋 Emergency services found and ready to assist
                    </p>
                    <button onclick="closeEmergencySuggestionsModal()" class="primary-btn" style="padding:12px 25px; font-size:16px; font-weight:600;">
                        <i class="fa-solid fa-check"></i> Close Emergency Assistance
                    </button>
                </div>
            </div>
        `;
        
        console.log('📝 Setting modal content...');
        emergencyBody.innerHTML = suggestionsHTML;
        
        // Show the modal with enhanced visibility
        console.log('👁️ Showing emergency modal...');
        emergencyModal.classList.add('active');
        emergencyModal.style.display = 'flex';
        emergencyModal.style.zIndex = '99999';
        emergencyModal.style.position = 'fixed';
        emergencyModal.style.top = '0';
        emergencyModal.style.left = '0';
        emergencyModal.style.width = '100%';
        emergencyModal.style.height = '100%';
        
        // Add click handler to close modal when clicking outside
        emergencyModal.onclick = function(event) {
            if (event.target === emergencyModal) {
                closeEmergencySuggestionsModal();
            }
        };
        
        // Force scroll to top
        emergencyBody.scrollTop = 0;
        
        console.log('✅ Emergency suggestions displayed successfully');
        console.log('📊 Modal state:', {
            isActive: emergencyModal.classList.contains('active'),
            display: emergencyModal.style.display,
            zIndex: emergencyModal.style.zIndex
        });
        
    } catch (error) {
        console.error('❌ Error in displayEmergencySuggestions:', error);
        console.error('❌ Error stack:', error.stack);
        alert(`❌ Error displaying emergency services: ${error.message}\\n\\nPlease check the browser console for details.`);
    }
}

window.closeEmergencySuggestionsModal = function() {
    console.log('🚪 Closing emergency suggestions modal');
    const emergencyModal = document.getElementById('emergency-suggestions-modal');
    emergencyModal.classList.remove('active');
    emergencyModal.style.display = 'none';
    console.log('✅ Emergency suggestions modal closed');
};

window.callEmergencyService = function(phoneNumber) {
    console.log(`📞 Calling emergency service: ${phoneNumber}`);
    const confirmed = confirm(`📞 Call Emergency Service?\\n\\nNumber: ${phoneNumber}\\n\\nThis will open your phone's dialer.`);
    if (confirmed) {
        try {
            window.open(`tel:${phoneNumber}`, '_self');
            console.log(`✅ Call initiated to: ${phoneNumber}`);
        } catch (error) {
            console.error('❌ Error initiating call:', error);
            alert(`📞 Could not open dialer. Please dial: ${phoneNumber}`);
        }
    }
};

window.navigateToEmergencyService = async function(serviceName, serviceLat, serviceLng, userLat, userLng) {
    console.log(`🗺️ Navigating to: ${serviceName}`);
    console.log(`📍 Service GPS: ${serviceLat}, ${serviceLng}`);
    console.log(`📍 User GPS: ${userLat}, ${userLng}`);
    
    const confirmed = confirm(`🗺️ Navigate to Emergency Service?\\n\\n${serviceName}\\n\\nThis will show directions on the map using exact GPS coordinates.`);
    
    if (confirmed) {
        try {
            closeEmergencySuggestionsModal();
            
            // ✅ Use exact GPS coordinates with OSRM (free, keyless routing)
            const coords = `${userLng},${userLat};${serviceLng},${serviceLat}`;
            const url = `${OSRM_BASE_URL}/route/v1/driving/${coords}?overview=full&geometries=polyline`;
            console.log(`🗺️ OSRM emergency navigation request: ${url}`);

            const response = await fetch(url);
            const data = await response.json();

            if (response.ok && data.code === 'Ok' && data.routes && data.routes.length > 0) {
                clearRouteRenderers();

                const routePoints = decodePolyline(data.routes[0].geometry);
                const emergencyLine = L.polyline(routePoints, {
                    color: '#dc3545',
                    opacity: 1.0,
                    weight: 7,
                    lineCap: 'round',
                    lineJoin: 'round'
                }).addTo(map);

                rendererArray = [emergencyLine];
                map.fitBounds(emergencyLine.getBounds(), { padding: [40, 40] });

                const route = data.routes[0];
                console.log(`✅ Navigation set up for ${serviceName}`);
                console.log(`📏 Distance: ${formatDistanceMeters(route.distance)}`);
                console.log(`⏱️ Duration: ${formatDurationSeconds(route.duration)}`);
            } else {
                console.error('❌ OSRM routing failed:', data.code || response.status);
                // Fallback: Open in Google Maps app with GPS coordinates (free deep link, no API key needed)
                const googleMapsUrl = `https://maps.google.com/maps?saddr=${userLat},${userLng}&daddr=${serviceLat},${serviceLng}`;
                alert(`⚠️ Unable to show route in map.\nOpening Google Maps...`);
                window.open(googleMapsUrl, '_blank');
            }

            
        } catch (error) {
            console.error('❌ Navigation error:', error);
            alert(`❌ Navigation Error: ${error.message}`);
        }
    }
};

/* --- 6. Community Feedback --- */
window.submitFeedback = async function() {
    const type = document.getElementById('feedback-type').value;
    const desc = document.getElementById('feedback-desc').value.trim();
   
    if (!desc) {
        alert('⚠️ Please add a description for your report.');
        return;
    }
   
    if (!navigator.geolocation) {
        alert('❌ GPS is required for location reporting.');
        return;
    }
   
    try {
        const position = await getPosition();
        const coords = {
            lat: position.coords.latitude,
            lng: position.coords.longitude
        };
       
        const response = await fetch(`${window.BACKEND_URL}/post-feedback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                lat: coords.lat,
                lng: coords.lng,
                type: type,
                description: desc,
                user_name: getUserName() // Include user name
            })
        });
        
        console.log('📡 Feedback sent with user name:', getUserName());
       
        if (response.ok) {
            const data = await response.json();
            closeModal(null, 'community-modal');
            document.getElementById('feedback-desc').value = '';
            alert(`✅ Feedback #${data.id} submitted successfully!`);
        } else {
            throw new Error('Failed to submit feedback');
        }
       
    } catch (error) {
        console.error('Feedback Submit Error:', error);
        alert('❌ Could not submit feedback. Please try again.');
    }
};

function getPosition() {
    return new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: true,
            timeout: 10000,
            maximumAge: 0
        });
    });
}

/* --- 7. Visual Helpers --- */
function updateFeedbackListUI() {
    const list = document.getElementById("feedback-list");
   
    if (!allFeedbacks || allFeedbacks.length === 0) {
        list.innerHTML = `
            <div style="padding: 40px 20px; text-align: center; color: #999;">
                <h3>No Recent Reports</h3>
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
                        <div style="font-size: 13px; color: #666;">${fb.description || 'Issue reported'}</div>
                        <div style="font-size: 11px; color: #999;"><i class="fa-solid fa-location-dot"></i> ${fb.lat.toFixed(4)}, ${fb.lng.toFixed(4)}</div>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function showCrimeIncidents(incidents) {
  clearCrimeVisualization();
  if (!incidents) return;

  incidents.forEach((inc) => {
    const config = crimeConfig[inc.type] || crimeConfig.default;
    const marker = L.circleMarker([inc.lat, inc.lng], {
      radius: 8,
      fillColor: config.color,
      fillOpacity: 0.9,
      color: "white",
      weight: 1
    }).addTo(map);

    marker.bindPopup(`<div><b>${inc.type.toUpperCase()}</b><br>${inc.description}</div>`, { minWidth: 200 });
    marker.on("mouseover", (e) => e.target.openPopup());

    crimeMarkers.push(marker);
  });
}

function clearCrimeVisualization() {
  crimeMarkers.forEach((m) => map.removeLayer(m));
  crimeMarkers = [];
}

/* --- Danger Heatmap --- */
const HEATMAP_WEIGHTS = {
  assault: 3, robbery: 3,
  theft: 2, harassment: 2, burglary: 2,
  vandalism: 1, accident: 1
};

function buildHeatmapPoints() {
  // leaflet.heat data format: [lat, lng, intensity]
  const points = [];

  // Crime incidents from all loaded routes
  currentRoutes.forEach(route => {
    (route.crime_incidents || []).forEach(inc => {
      if (inc.lat && inc.lng) {
        const weight = HEATMAP_WEIGHTS[inc.type] || 1;
        points.push([inc.lat, inc.lng, weight]);
      }
    });
  });

  // Community feedback markers
  allFeedbacks.forEach(fb => {
    if (fb.lat && fb.lng) {
      points.push([fb.lat, fb.lng, 2]);
    }
  });

  return points;
}

window.toggleHeatmap = function() {
  const btn = document.getElementById('heatmap-toggle-btn');
  const legend = document.getElementById('heatmap-legend');

  if (heatmapActive) {
    // Turn off
    if (heatmapLayer) map.removeLayer(heatmapLayer);
    heatmapActive = false;
    btn.classList.remove('active');
    btn.innerHTML = '<i class="fa-solid fa-fire"></i><span>Heatmap</span>';
    legend.classList.add('hidden');
    return;
  }

  // Build points
  const points = buildHeatmapPoints();
  if (points.length === 0) {
    alert('Search for a route first to load danger data onto the heatmap.');
    return;
  }

  // Create or update heatmap layer (leaflet.heat plugin)
  if (!heatmapLayer) {
    heatmapLayer = L.heatLayer(points, {
      radius: 50,
      blur: 55,
      minOpacity: 0.55,
      max: 3,
      gradient: {
        0.2: 'rgba(255,220,0,0.85)',
        0.4: 'rgba(255,140,0,1)',
        0.6: 'rgba(255,60,0,1)',
        0.8: 'rgba(220,0,0,1)',
        1.0: 'rgba(160,0,0,1)'
      }
    }).addTo(map);
  } else {
    heatmapLayer.setLatLngs(points);
    if (!map.hasLayer(heatmapLayer)) heatmapLayer.addTo(map);
  }

  heatmapActive = true;
  btn.classList.add('active');
  btn.innerHTML = '<i class="fa-solid fa-fire"></i><span>Hide Map</span>';
  legend.classList.remove('hidden');
  console.log(`🔥 Heatmap active with ${points.length} data points`);
};

// Refresh heatmap data whenever new routes load (if it's already active)
function refreshHeatmapIfActive() {
  if (!heatmapActive || !heatmapLayer) return;
  const points = buildHeatmapPoints();
  heatmapLayer.setLatLngs(points);
  console.log(`🔥 Heatmap refreshed: ${points.length} points`);
}

function clearHospitalsAndPolice() {
  // Removing a Leaflet marker automatically closes its bound popup
  hospitalMarkers.forEach((m) => map.removeLayer(m));
  policeMarkers.forEach((m) => map.removeLayer(m));
  hospitalMarkers = [];
  policeMarkers = [];
}

/* --- Custom SVG Pin Icon Generator --- */
function createPinIcon(bgColor, emoji) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="38" viewBox="0 0 42 54">
    <defs>
      <filter id="s" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#00000055"/>
      </filter>
    </defs>
    <path d="M21 2 C10.5 2 2 10.5 2 21 C2 34 21 52 21 52 C21 52 40 34 40 21 C40 10.5 31.5 2 21 2Z"
          fill="${bgColor}" filter="url(#s)"/>
    <circle cx="21" cy="21" r="14" fill="white" opacity="0.22"/>
    <text x="21" y="27" text-anchor="middle" font-size="17" font-family="Segoe UI Emoji,Apple Color Emoji,sans-serif">${emoji}</text>
  </svg>`;
  return L.icon({
    iconUrl: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    iconSize: [30, 38],
    iconAnchor: [15, 36],
    popupAnchor: [0, -34]
  });
}

function makePOIPopupHtml(color, titleHtml, place, defaultPhone) {
  const name = (place.name || '').replace(/'/g, "\\'");
  const center = map.getCenter();
  return `
      <div style="padding:14px;max-width:260px;font-family:'Inter',sans-serif">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <div style="width:4px;height:36px;background:${color};border-radius:2px;flex-shrink:0"></div>
          <h4 style="margin:0;color:${color};font-size:14px;font-weight:700;line-height:1.3">${titleHtml}</h4>
        </div>
        <p style="margin:4px 0;font-size:12px;color:#555;line-height:1.4">${place.address || 'Address not available'}</p>
        <p style="margin:6px 0;font-size:13px;color:#16a34a;font-weight:700">
          📞 ${place.phone || defaultPhone}
        </p>
        ${place.distance ? `<p style="margin:4px 0;font-size:11px;color:#999">📍 ${place.distance} from route</p>` : ''}
        <button onclick="navigateToEmergencyService('${name}',${place.lat},${place.lng},${center.lat},${center.lng})"
          style="margin-top:10px;background:${color};color:white;border:none;padding:7px 14px;border-radius:6px;font-size:12px;cursor:pointer;font-weight:700;width:100%">
          🗺 Navigate Here
        </button>
      </div>`;
}

function showHospitalsAndPolice(routeData) {
  clearHospitalsAndPolice();
  if (!routeData) return;

  const POI_CONFIG = [
    {
      key: 'hospital_locations',
      store: hospitalMarkers,
      icon: createPinIcon('#ef4444', '🏥'),
      color: '#ef4444',
      defaultTitle: 'Hospital',
      phone: 'Emergency: 112',
      label: 'Hospital'
    },
    {
      key: 'police_locations',
      store: policeMarkers,
      icon: createPinIcon('#1d4ed8', '👮'),
      color: '#1d4ed8',
      defaultTitle: 'Police Station',
      phone: 'Emergency: 100',
      label: 'Police Station'
    },
    {
      key: 'gas_locations',
      store: hospitalMarkers,   // reuse array — cleared together
      icon: createPinIcon('#d97706', '⛽'),
      color: '#d97706',
      defaultTitle: 'Petrol Pump',
      phone: 'N/A',
      label: 'Petrol Pump'
    },
    {
      key: 'hotel_locations',
      store: policeMarkers,     // reuse array — cleared together
      icon: createPinIcon('#7c3aed', '🏨'),
      color: '#7c3aed',
      defaultTitle: 'Hotel / Safe Place',
      phone: 'N/A',
      label: 'Hotel'
    }
  ];

  POI_CONFIG.forEach(({ key, store, icon, color, defaultTitle, phone }) => {
    const places = routeData[key];
    if (!places || places.length === 0) return;
    console.log(`📍 Displaying ${places.length} ${defaultTitle}s`);

    places.forEach(place => {
      const marker = L.marker([place.lat, place.lng], {
        title: place.name || defaultTitle,
        icon,
        zIndexOffset: 200,
        riseOnHover: true
      }).addTo(map);

      const title = `${place.name || defaultTitle}`;
      const popupHtml = makePOIPopupHtml(color, title, place, phone);
      marker.bindPopup(popupHtml);
      store.push(marker);
    });
  });

  console.log(`✅ POI markers: ${hospitalMarkers.length} hospitals/petrol, ${policeMarkers.length} police/hotels`);
}

function clearFeedback() {
    feedbackMarkers.forEach((m) => map.removeLayer(m));
    feedbackMarkers = [];
}

function addFeedbackMarker(fb) {
    const config = feedbackConfig[fb.type] || feedbackConfig.other;

    const marker = L.circleMarker([fb.lat, fb.lng], {
        radius: 9,
        fillColor: config.color,
        fillOpacity: 0.8,
        color: "white",
        weight: 2
    }).addTo(map);

    marker.bindPopup(`
            <div style="padding: 10px;">
                <h4><i class="${config.icon}" style="color: ${config.color};"></i> ${config.label}</h4>
                <p>${fb.description || 'No description'}</p>
                <small><i class="fa-solid fa-location-dot"></i> ${fb.lat.toFixed(6)}, ${fb.lng.toFixed(6)}</small>
            </div>
        `);

    feedbackMarkers.push(marker);
}

window.focusOnFeedback = function(lat, lng) {
    map.setView([lat, lng], 16);
};

/* --- 8. Loading Animation --- */
function startLoadingAnimation() {
  document.getElementById("loading").style.display = "block";
}

function stopLoadingAnimation() {
  document.getElementById("loading").style.display = "none";
}

/* --- 9. Modal Logic --- */
window.openModal = function (id) {
  const modal = document.getElementById(id);
  modal.classList.add("active");
  
  modal.onclick = function(e) {
    if (e.target === modal) {
      closeModal(e, id);
    }
  };
  
  if (id === "community-modal") updateFeedbackListUI();
};

window.closeModal = function (e, id) {
  const modal = document.getElementById(id);
  
  if (!e || e.target.id === id || e.target.classList.contains("close-btn")) {
    modal.classList.remove("active");
  }
};

/* --- 10. Utility Functions --- */
window.fetchFeedbackForRoute = function () {
  fetch(`${window.BACKEND_URL}/get-feedback`)
    .then((r) => r.json())
    .then((d) => {
      allFeedbacks = d;
      clearFeedback();
      d.forEach(fb => addFeedbackMarker(fb));
      updateFeedbackListUI();
    })
    .catch((e) => console.log(e));
};

window.clearAllData = async function () {
    const confirmed = confirm("🗑️ Permanently delete all SOS alerts and community feedback? This cannot be undone.");
    
    if (confirmed) {
        try {
            console.log('🗑️ Clearing all data...');
            console.log('📡 Sending POST to /clear-all-data endpoint');
            
            const response = await fetch(`${window.BACKEND_URL}/clear-all-data`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ confirmation: "DELETE_ALL_DATA" })  // ✅ FIX: Use 'confirmation'
            });
            
            console.log('📨 Response status:', response.status);
            console.log('📨 Response ok:', response.ok);
            
            if (response.ok) {
                const result = await response.json();
                console.log('✅ Data cleared successfully:', result);
                
                // Clear local data immediately (don't wait for socket event)
                allFeedbacks = [];
                clearFeedback();
                clearCrimeVisualization();
                clearHospitalsAndPolice(); // Clear hospital and police markers
                updateFeedbackListUI();
                
                // Clear displayed routes
                clearRouteRenderers();
                currentRoutes = [];
                
                // Clear route cards
                const container = document.getElementById("routes-list");
                if (container) container.innerHTML = "";
                
                alert(`✅ All data cleared successfully!\n${result.sos_deleted} alerts & ${result.feedback_deleted} reports deleted`);
                
                console.log('✅ Local UI cleared successfully');
                
            } else {
                const error = await response.json();
                console.error('❌ Clear data failed:', error);
                alert(`❌ Failed to clear data: ${error.error || 'Unknown error'}`);
            }
            
        } catch (error) {
            console.error('❌ Clear data error:', error);
            alert(`❌ Error clearing data: ${error.message}\\n\\nPlease check if the backend server is running.`);
        }
    }
};

window.toggleNightMode = function () {
  document.body.classList.toggle("night-mode");
};

window.toggleMobileSidebar = function () {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.querySelector('.sidebar-overlay');
  
  sidebar.classList.toggle('active');
  overlay.classList.toggle('active');
  
  // Prevent body scroll when sidebar is open
  if (sidebar.classList.contains('active')) {
    document.body.style.overflow = 'hidden';
  } else {
    document.body.style.overflow = '';
  }
};

window.testBackendConnection = async function() {
    console.log('🧪 Testing backend connection...');
    
    try {
        console.log('🌐 Current page URL:', window.location.href);
        console.log('🌐 Testing connection to:', `${window.BACKEND_URL}/ai-status`);
        
        const response = await fetch(`${window.BACKEND_URL}/ai-status`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        
        console.log('📨 Response status:', response.status);
        console.log('📨 Response ok:', response.ok);
        
        if (response.ok) {
            const data = await response.json();
            console.log('✅ Backend connection successful!', data);
            alert(`✅ Backend Connection Test Successful!\n\nGroq AI: ${data.groq_configured ? 'Available' : 'Not Available'}\n\nPOI Service: ${data.poi_provider || 'OpenStreetMap (Overpass API)'}\n\nPrimary AI: ${data.primary_ai}`);
        } else {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
    } catch (error) {
        console.error('❌ Backend connection test failed:', error);
        
        let errorMessage = `❌ Backend Connection Test Failed:\\n\\n${error.message}`;
        
        if (error.message.includes('Failed to fetch')) {
            errorMessage += `\\n\\n🔗 This means the backend server is not accessible.\\n\\n🛠️ Solutions:\\n1. Make sure backend is running\\n2. Check if ${window.BACKEND_URL} is accessible in browser\\n3. Check for CORS or firewall issues\\n4. Try restarting the backend server`;
        }
        
        alert(errorMessage);
    }
};

console.log("✅ SafeRoute JavaScript with Safety-Based Route Colors loaded successfully");

/* --- User Management --- */
let currentUserName = null;

// Check if user has a saved name, if not show welcome modal
window.addEventListener('DOMContentLoaded', function() {
    console.log('🚀 SafeRoute: Page loaded, checking user name...');
    
    // Check for saved user name
    const savedName = localStorage.getItem('saferoute_user_name');
    
    if (savedName && savedName.trim()) {
        currentUserName = savedName.trim();
        console.log(`👤 Welcome back, ${currentUserName}!`);
        
        // Update navbar to show user name
        updateNavbarWithUserName();
    } else {
        console.log('👤 New user detected, showing welcome modal...');
        // Show welcome modal after a short delay
        setTimeout(() => {
            showWelcomeModal();
        }, 500);
    }
});

function showWelcomeModal() {
    const modal = document.getElementById('welcome-modal');
    modal.classList.add('active');
    modal.style.display = 'flex';
    
    // Focus on input field
    const input = document.getElementById('user-name-input');
    setTimeout(() => input.focus(), 300);
    
    // Handle Enter key
    input.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            saveUserName();
        }
    });
    
    // Prevent closing by clicking outside
    modal.onclick = function(e) {
        e.stopPropagation();
    };
}

window.saveUserName = function() {
    const input = document.getElementById('user-name-input');
    const name = input.value.trim();
    
    if (!name) {
        alert('Please enter your name to continue');
        input.focus();
        return;
    }
    
    if (name.length < 2) {
        alert('Please enter a valid name (at least 2 characters)');
        input.focus();
        return;
    }
    
    // Save name locally
    localStorage.setItem('saferoute_user_name', name);
    currentUserName = name;
    
    console.log(`✅ User name saved: ${currentUserName}`);
    
    // Close welcome modal
    const modal = document.getElementById('welcome-modal');
    modal.classList.remove('active');
    modal.style.display = 'none';
    
    // Update navbar
    updateNavbarWithUserName();
    
    // Show success message
    setTimeout(() => {
        alert(`Welcome to SafeRoute, ${currentUserName}! 🛡️\n\nYour safety is our priority. In case of emergency, your name will help responders assist you better.`);
    }, 500);
};

function updateNavbarWithUserName() {
    if (!currentUserName) return;
    
    // Add user name to navbar
    const navActions = document.querySelector('.nav-actions');
    
    // Remove existing user button if any
    const existingUserBtn = document.querySelector('.user-name-btn');
    if (existingUserBtn) {
        existingUserBtn.remove();
    }
    
    // Create user name button
    const userBtn = document.createElement('button');
    userBtn.className = 'nav-btn user-name-btn';
    userBtn.style.background = 'var(--accent)';
    userBtn.style.color = 'white';
    userBtn.title = 'Change Name';
    userBtn.onclick = changeUserName;
    
    userBtn.innerHTML = `<i class="fa-solid fa-user"></i> <span class="user-name-text">${currentUserName}</span>`;
    
    // Insert before the last button (theme toggle)
    const themeBtn = navActions.querySelector('.icon-only');
    navActions.insertBefore(userBtn, themeBtn);
}

window.changeUserName = function() {
    const newName = prompt(`Change your name:\n\nCurrent: ${currentUserName}`, currentUserName);
    
    if (newName && newName.trim() && newName.trim() !== currentUserName) {
        const trimmedName = newName.trim();
        
        if (trimmedName.length < 2) {
            alert('Please enter a valid name (at least 2 characters)');
            return;
        }
        
        localStorage.setItem('saferoute_user_name', trimmedName);
        currentUserName = trimmedName;
        
        updateNavbarWithUserName();
        alert(`✅ Name updated to: ${currentUserName}`);
        
        console.log(`👤 User name changed to: ${currentUserName}`);
    }
};

function getUserName() {
    return currentUserName || 'Anonymous User';
}