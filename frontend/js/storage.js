// Session persistence (spec §6.6): the working trip lives in localStorage.
import { STORAGE_KEY } from "./constants.js";

export function saveSession(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      waypoints: state.waypoints,
      radius: state.radius,
      keyword: state.keyword,
      sources: state.sources,
      view: state.view,
      results: state.results,
      // Full place objects, not ids: selections survive searches whose
      // results no longer contain them, so they must survive reloads too.
      selected: Object.values(state.selected),
      route: state.route,
      savedAt: Date.now(),
    }));
  } catch (_) { /* storage full/blocked — not fatal */ }
}

export function loadSession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

export function clearSession() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ }
}
