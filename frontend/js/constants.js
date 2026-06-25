// Central category-color constant (spec §6.2): one distinct color per category.
export const CATEGORY_COLORS = {
  Roadside: "#D4760E",
  Historical: "#8B4A2B",
  Event: "#4A5899",
  Natural: "#2D6A4F",
  Art: "#7A4E8C",
  Weird: "#B23A48",
  Ruins: "#5C5552",
  Community: "#2E6E8E",
  Other: "#6B705C",
};

export const SOURCE_LABELS = {
  atlas_obscura: "Atlas Obscura",
  roadside_america: "Roadside America",
  osm: "OpenStreetMap",
  wikipedia: "Wikipedia",
  wikidata: "Wikidata",
  hmdb: "Historical Markers",
};

export const LOADING_LINES = [
  "Plotting your route…",
  "Unfolding the paper map…",
  "Digging through the archives…",
  "Finding the weird stuff…",
  "Asking locals about that one statue…",
  "Checking under the floorboards…",
  "Taking the long way…",
  "Almost there…",
];

// Little vintage-gauge icons for the detour badges (spec §8).
export const ICON_CAR = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16l1.5-5h11L19 16"/><rect x="3.5" y="15" width="17" height="4" rx="1.6"/><circle cx="7.5" cy="19" r="1.4" fill="currentColor"/><circle cx="16.5" cy="19" r="1.4" fill="currentColor"/></svg>`;
export const ICON_CLOCK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>`;

// Map style: CartoDB Positron (free, attribution-only — spec §3).
export const MAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

export const STORAGE_KEY = "ttlw_session_v1";
export const MAX_WAYPOINTS = 8;
