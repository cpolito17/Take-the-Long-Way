// Finalize flow & Trip Overview (spec §6.5): zoom-to-fit + route-draw
// transition, then a centered modal with mini-map, numbered stops, trip
// stats and the Google Maps handoff (spec §7).
import { finalize as apiFinalize } from "./api.js";
import { MAP_STYLE } from "./constants.js";
import { categoryBadge, fmtMi, pinSvg } from "./pins.js";

export class FinalizeFlow {
  constructor(state, mapView, onEdit) {
    this.state = state;
    this.mapView = mapView;
    this.onEdit = onEdit;
    this.modal = document.getElementById("trip-modal");
    this.card = document.getElementById("trip-modal-card");
    this.minimapEl = document.getElementById("trip-minimap");
    this.minimap = null;
    document.getElementById("edit-trip").addEventListener("click", () => this.close());
    document.getElementById("trip-modal-backdrop").addEventListener("click", () => this.close());
  }

  selectedStops() {
    return Object.values(this.state.selected).map((p) => ({
      id: p.id,
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      category: p.category,
      detour_mi: p.detour_mi,
      detour_min: p.detour_min,
    }));
  }

  async run() {
    const data = await apiFinalize({
      waypoints: this.state.waypoints,
      stops: this.selectedStops(),
    });
    this.state.finalized = data;

    // Transition: fit the full route, draw it forward, then scale the modal in.
    this.mapView.hidePopup();
    this.mapView.fitToRoute(data.route.coordinates, { top: 70, bottom: 70, left: 70, right: 70 });
    await sleep(950);
    await this.mapView.drawRoute(data.route.coordinates, { animate: true });
    this.open(data);
  }

  open(data) {
    this.renderStats(data);
    this.renderStops(data);
    this.renderLinks(data);
    this.modal.classList.remove("hidden");
    if (typeof gsap !== "undefined") {
      gsap.fromTo("#trip-modal-backdrop", { opacity: 0 }, { opacity: 1, duration: 0.3 });
      gsap.fromTo(
        this.card,
        { scale: 0.78, opacity: 0, y: 26 },
        { scale: 1, opacity: 1, y: 0, duration: 0.5, ease: "back.out(1.5)" }
      );
    }
    // The mini-map needs its container visible before it can size itself.
    requestAnimationFrame(() => this.renderMinimap(data));
  }

  close() {
    this.modal.classList.add("hidden");
    if (this.minimap) {
      this.minimap.remove();
      this.minimap = null;
    }
    this.onEdit();
  }

  renderMinimap(data) {
    if (this.minimap) this.minimap.remove();
    this.minimap = new maplibregl.Map({
      container: this.minimapEl,
      style: MAP_STYLE,
      interactive: false,
      attributionControl: false,
    });
    this.minimap.on("load", () => {
      this.minimap.addSource("route", {
        type: "geojson",
        data: { type: "Feature", geometry: { type: "LineString", coordinates: data.route.coordinates } },
      });
      this.minimap.addLayer({
        id: "route",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#D4760E", "line-width": 3.2 },
      });
      data.ordered_stops.forEach((s) => {
        const el = document.createElement("div");
        el.innerHTML = pinSvg(s.category, true);
        el.firstElementChild.setAttribute("width", "20");
        el.firstElementChild.setAttribute("height", "27");
        new maplibregl.Marker({ element: el, anchor: "bottom" })
          .setLngLat([s.lng, s.lat])
          .addTo(this.minimap);
      });
      const coords = data.route.coordinates;
      const bounds = coords.reduce(
        (b, c) => b.extend(c),
        new maplibregl.LngLatBounds(coords[0], coords[0])
      );
      this.minimap.fitBounds(bounds, { padding: 30, duration: 0 });
    });
  }

  renderStats(data) {
    const el = document.getElementById("trip-stats");
    el.innerHTML = `
      <div class="stat-block">
        <div class="stat-label">Baseline</div>
        <div class="stat-value">${fmtMi(data.baseline.distance_mi)} mi
          <small>${fmtDur(data.baseline.duration_min)}</small></div>
      </div>
      <div class="stat-block">
        <div class="stat-label">Your route</div>
        <div class="stat-value">${fmtMi(data.trip.distance_mi)} mi
          <small>${fmtDur(data.trip.duration_min)}</small></div>
      </div>
      <div class="stat-block stat-added">
        <div class="stat-label">The long way adds</div>
        <div class="stat-value">+${fmtMi(Math.max(0, data.added_mi))} mi
          <small>+${fmtDur(Math.max(0, data.added_min))}</small></div>
      </div>`;
  }

  renderStops(data) {
    const ol = document.getElementById("trip-stops");
    ol.innerHTML = data.ordered_stops
      .map(
        (s) => `<li>${escapeHtml(s.name)} ${categoryBadge(s.category)}
          ${s.detour_mi != null ? `<span class="stop-meta">+${fmtMi(s.detour_mi)} mi · +${Math.round(s.detour_min)} min</span>` : ""}
        </li>`
      )
      .join("");
  }

  renderLinks(data) {
    const el = document.getElementById("trip-links");
    el.innerHTML = data.maps_links
      .map(
        (l) => `<a class="btn btn-primary" href="${escapeAttrUrl(l.url)}" target="_blank" rel="noopener noreferrer">
          ${escapeHtml(l.label)} ↗</a>`
      )
      .join("");
  }
}

function fmtDur(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

function escapeHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttrUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "#";
    return url.href.replace(/"/g, "%22").replace(/'/g, "%27").replace(/</g, "%3C");
  } catch {
    return "#";
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
