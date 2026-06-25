// Take the Long Way — app orchestration: owns the state, wires the form,
// map, results panel, loading overlay and finalize flow together.
import { search as apiSearch } from "./api.js";
import { SearchForm } from "./form.js";
import { MapView } from "./mapview.js";
import { ResultsPanel } from "./results.js";
import { LoadingOverlay } from "./loading.js";
import { FinalizeFlow } from "./finalize.js";
import { saveSession, loadSession, clearSession } from "./storage.js";

const state = {
  waypoints: [
    { name: "", lat: null, lng: null },
    { name: "", lat: null, lng: null },
  ],
  radius: 25,
  keyword: "",
  sources: ["atlas_obscura", "roadside_america", "osm", "wikipedia", "wikidata", "hmdb"],
  view: { sort: "top", hiddenCats: [] }, // client-side sort + category filter
  results: [],
  selected: {}, // id -> place
  route: null,
  finalized: null,
};

const persist = debounce(() => saveSession(state), 400);

const loading = new LoadingOverlay();

const mapView = new MapView(state, {
  onPinClick: (id) => {
    results.highlightCard(id);
  },
  onPopupSelect: (id) => toggleSelect(id),
});

const results = new ResultsPanel(state, {
  onToggle: (id) => toggleSelect(id),
  onCardClick: (id) => {
    const p = state.results.find((x) => x.id === id) || state.selected[id];
    if (!p) return;
    mapView.map.easeTo({ center: [p.lng, p.lat], duration: 600 });
    mapView.showPopup(p);
  },
  onFinalize: () => runFinalize(),
  // Sort/filter changed: the map shows the same filtered set as the list
  // (plus carried-over trip stops, which always stay visible).
  onViewChange: () => {
    mapView.renderPins(pinPlaces());
    persist();
  },
});

const form = new SearchForm(state, persist);
form.render();
form.syncControls();

const finalizeFlow = new FinalizeFlow(state, mapView, () => {
  // Edit Trip: back to the main view, selections preserved (spec §6.5).
  if (state.route) mapView.drawRoute(state.route.coordinates);
});

/* ---------- search ---------- */
document.getElementById("search-btn").addEventListener("click", runSearch);

async function runSearch() {
  if (!form.validate()) return;
  loading.show();
  try {
    const data = await apiSearch({
      waypoints: state.waypoints,
      radius_mi: state.radius,
      keyword: state.keyword,
      sources: state.sources,
    });
    state.route = data.route;
    state.results = data.places;
    // Selections persist across searches — the trip is built up over
    // multiple searches. Items still in the new results get their fresh
    // per-query fields; carried-over ones get detours recomputed against
    // the new route.
    const ids = new Set(data.places.map((p) => p.id));
    for (const [id, p] of Object.entries(state.selected)) {
      if (ids.has(id)) {
        state.selected[id] = data.places.find((x) => x.id === id);
      } else {
        recomputeDetour(p, data.route.coordinates);
      }
    }
    await mapView.drawRoute(data.route.coordinates);
    mapView.fitToRoute(data.route.coordinates);
    results.show();
    results.render();
    mapView.renderPins(pinPlaces());
    onSearchActive();
    saveSession(state);
  } catch (err) {
    form.showError(err.message || "Search failed — give it another go.");
  } finally {
    loading.hide();
  }
}

// Selected places kept from earlier searches that aren't in the current
// result set — still part of the trip, still shown on map and list.
function carriedOver() {
  const ids = new Set(state.results.map((p) => p.id));
  return Object.values(state.selected).filter((p) => !ids.has(p.id));
}

// Everything the map should show: the filtered current results plus any
// carried-over selections.
function pinPlaces() {
  return [...results.visible(), ...carriedOver()];
}

function toggleSelect(id) {
  const place = state.results.find((p) => p.id === id) || state.selected[id];
  if (!place) return;
  const wasCarried = !state.results.some((p) => p.id === id);
  if (state.selected[id]) delete state.selected[id];
  else state.selected[id] = place;
  if (wasCarried) {
    // Carried-over items live only in the trip: unchecking removes their
    // card and pin entirely, so re-render both.
    results.render();
    mapView.renderPins(pinPlaces());
  } else {
    mapView.refreshPin(place);
    results.refreshCard(id);
  }
  saveSession(state);
}

// Cheap client-side mirror of the backend's detour approximation
// (geo.py: nearest point on route, ROAD_CIRCUITY=1.35, 35 mph), against
// the dense ORS polyline (~200 m between vertices).
function recomputeDetour(p, coords) {
  const MI_PER_DEG = 69.0;
  const cosLat = Math.cos((p.lat * Math.PI) / 180);
  let best = Infinity;
  for (const [lng, lat] of coords) {
    const dx = (lng - p.lng) * cosLat * MI_PER_DEG;
    const dy = (lat - p.lat) * MI_PER_DEG;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  const offset = Math.sqrt(best);
  p.offset_mi = Math.round(offset * 10) / 10;
  p.detour_mi = Math.round(2 * offset * 1.35 * 10) / 10;
  p.detour_min = Math.round((2 * offset * 1.35 * 60) / 35);
}

async function runFinalize() {
  const btn = document.getElementById("finalize-btn");
  btn.disabled = true;
  try {
    await finalizeFlow.run();
    saveSession(state);
  } catch (err) {
    form.showError(err.message || "Could not finalize the trip.");
  } finally {
    btn.disabled = Object.keys(state.selected).length === 0;
  }
}

/* ---------- panel collapse + mobile pill ---------- */
const searchPanel = document.getElementById("search-panel");
document.getElementById("panel-collapse").addEventListener("click", () => {
  searchPanel.classList.toggle("collapsed");
});

const mobilePill = document.getElementById("mobile-pill");
mobilePill.addEventListener("click", () => {
  searchPanel.classList.remove("mobile-hidden");
  mobilePill.classList.add("hidden");
});

function onSearchActive() {
  if (window.innerWidth <= 768) {
    // The form collapses into a compact pill once a search is active (spec §8).
    searchPanel.classList.add("mobile-hidden");
    const [a, b] = [state.waypoints[0], state.waypoints[state.waypoints.length - 1]];
    document.getElementById("mobile-pill-text").textContent =
      `${firstWord(a.name)} → ${firstWord(b.name)} · edit`;
    mobilePill.classList.remove("hidden");
  }
}

/* ---------- session restore (spec §6.6) ---------- */
const banner = document.getElementById("welcome-banner");
const saved = loadSession();
if (saved && (saved.waypoints || []).some((w) => w.name)) {
  banner.classList.remove("hidden");
  document.getElementById("welcome-restore").addEventListener("click", async () => {
    banner.classList.add("hidden");
    restoreSession(saved);
  });
  document.getElementById("welcome-fresh").addEventListener("click", () => {
    banner.classList.add("hidden");
    clearSession();
  });
}

async function restoreSession(s) {
  state.waypoints = s.waypoints && s.waypoints.length >= 2 ? s.waypoints : state.waypoints;
  state.radius = s.radius || 25;
  state.keyword = s.keyword || "";
  state.sources = s.sources && s.sources.length ? s.sources : state.sources;
  state.view = s.view && s.view.sort ? s.view : { sort: "top", hiddenCats: [] };
  state.results = s.results || [];
  state.route = s.route || null;
  state.selected = {};
  (s.selected || []).forEach((sel) => {
    if (typeof sel === "string") {
      // Older sessions stored ids only — those can only be restored if
      // still present in the saved results.
      const p = state.results.find((x) => x.id === sel);
      if (p) state.selected[sel] = p;
    } else if (sel && sel.id) {
      state.selected[sel.id] = sel;
    }
  });
  form.render();
  form.syncControls();
  if (state.route && (state.results.length || Object.keys(state.selected).length)) {
    await mapView.drawRoute(state.route.coordinates);
    mapView.fitToRoute(state.route.coordinates);
    results.show();
    results.render();
    mapView.renderPins(pinPlaces());
    onSearchActive();
  }
}

function firstWord(name) {
  return (name || "").split(",")[0].trim() || "…";
}

// Dev/verification hook (read-only use).
window.__ttlw = { state, mapView, results };

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
