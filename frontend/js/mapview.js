// Map (spec §6.2): MapLibre + Positron tiles, amber route line with glow,
// vintage road-sign pins colored by category, hover/tap info cards,
// pin ↔ list selection sync.
//
// Pins are a symbol layer (rendered in the map's own WebGL pass), not DOM
// markers — DOM markers visibly lag behind the basemap while panning.
import { CATEGORY_COLORS, MAP_STYLE } from "./constants.js";
import { categoryBadge, detourBadges, pinSvg } from "./pins.js";

const US_CENTER = [-96.5, 39.5];

export class MapView {
  constructor(state, handlers) {
    this.state = state;
    this.handlers = handlers; // { onPinClick(id), onPopupSelect(id) }
    this.popup = null;
    this.popupPlaceId = null;
    this.placesById = new Map();
    this.poiData = { type: "FeatureCollection", features: [] };
    this.map = new maplibregl.Map({
      container: "map",
      style: MAP_STYLE,
      center: US_CENTER,
      zoom: 4,
      attributionControl: { compact: true },
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-left");
    this.loaded = new Promise((res) => this.map.on("load", res));
    this.iconsReady = this.loaded.then(() => this.addPinIcons());
    this.isTouch = window.matchMedia("(pointer: coarse)").matches;
  }

  /* ---------- pin icons (one per category × selected state) ---------- */

  addPinIcons() {
    return Promise.all(
      Object.keys(CATEGORY_COLORS).flatMap((cat) => [
        this.addIcon(`pin-${cat}-unsel`, pinSvg(cat, false, 2)),
        this.addIcon(`pin-${cat}-sel`, pinSvg(cat, true, 2)),
      ])
    );
  }

  addIcon(name, svg) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        if (!this.map.hasImage(name)) this.map.addImage(name, img, { pixelRatio: 2 });
        resolve();
      };
      img.onerror = reject;
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
  }

  /* ---------- route ---------- */

  async drawRoute(coordinates, { animate = false } = {}) {
    await this.loaded;
    const geojson = {
      type: "Feature",
      geometry: { type: "LineString", coordinates },
    };
    if (!this.map.getSource("route")) {
      this.map.addSource("route", { type: "geojson", data: geojson });
      // Soft glow under the warm amber line.
      this.map.addLayer({
        id: "route-glow",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#E8923B", "line-width": 13, "line-opacity": 0.28, "line-blur": 5 },
      });
      this.map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#D4760E", "line-width": 4.5, "line-opacity": 0.95 },
      });
    } else if (animate) {
      await this.animateRouteDraw(coordinates);
      return;
    } else {
      this.map.getSource("route").setData(geojson);
    }
  }

  // Finalize transition: the route draws itself forward along the path.
  animateRouteDraw(coordinates) {
    return new Promise((resolve) => {
      const src = this.map.getSource("route");
      const total = coordinates.length;
      const dur = 1400;
      const t0 = performance.now();
      const tick = (now) => {
        const f = Math.min(1, (now - t0) / dur);
        const eased = 1 - Math.pow(1 - f, 3);
        const n = Math.max(2, Math.floor(total * eased));
        src.setData({ type: "Feature", geometry: { type: "LineString", coordinates: coordinates.slice(0, n) } });
        if (f < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  fitToRoute(coordinates, padding) {
    const bounds = coordinates.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(coordinates[0], coordinates[0])
    );
    this.map.fitBounds(bounds, { padding: padding || this.defaultPadding(), duration: 900 });
  }

  defaultPadding() {
    const mobile = window.innerWidth <= 768;
    return mobile
      ? { top: 90, bottom: 240, left: 36, right: 36 }
      : { top: 60, bottom: 60, left: 400, right: 410 };
  }

  /* ---------- pins ---------- */

  _feature(p) {
    const category = CATEGORY_COLORS[p.category] ? p.category : "Other";
    return {
      type: "Feature",
      properties: {
        id: p.id,
        category,
        selected: !!this.state.selected[p.id],
        rank: p.rank ?? p.score,
      },
      geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    };
  }

  async renderPins(places) {
    await this.iconsReady;
    this.placesById = new Map(places.map((p) => [p.id, p]));
    // Source order = render order: highest-ranked last so it draws on top.
    const sorted = [...places].sort((a, b) => (a.rank ?? a.score) - (b.rank ?? b.score));
    this.poiData = { type: "FeatureCollection", features: sorted.map((p) => this._feature(p)) };
    if (!this.map.getSource("pois")) {
      this.map.addSource("pois", { type: "geojson", data: this.poiData });
      this.map.addLayer({
        id: "pois",
        type: "symbol",
        source: "pois",
        layout: {
          "icon-image": [
            "concat", "pin-", ["get", "category"],
            ["case", ["get", "selected"], "-sel", "-unsel"],
          ],
          "icon-anchor": "bottom",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
          "symbol-z-order": "source",
        },
      });
      this.wirePinEvents();
    } else {
      this.map.getSource("pois").setData(this.poiData);
    }
    if (this.popupPlaceId && !this.placesById.has(this.popupPlaceId)) this.hidePopup();
  }

  wirePinEvents() {
    this.map.on("click", "pois", (e) => {
      const place = this.placesById.get(e.features[0].properties.id);
      if (!place) return;
      this.handlers.onPinClick(place.id);
      this.showPopup(place);
    });
    this.map.on("mouseenter", "pois", () => {
      this.map.getCanvas().style.cursor = "pointer";
    });
    this.map.on("mouseleave", "pois", () => {
      this.map.getCanvas().style.cursor = "";
      if (!this.isTouch) this.scheduleHidePopup();
    });
    if (!this.isTouch) {
      this.map.on("mousemove", "pois", (e) => {
        const id = e.features[0].properties.id;
        if (id !== this.popupPlaceId) {
          const place = this.placesById.get(id);
          if (place) this.showPopup(place);
        }
      });
    }
  }

  clearPins() {
    this.placesById.clear();
    this.poiData = { type: "FeatureCollection", features: [] };
    if (this.map.getSource("pois")) this.map.getSource("pois").setData(this.poiData);
    this.hidePopup();
  }

  refreshPin(place) {
    const f = this.poiData.features.find((x) => x.properties.id === place.id);
    if (!f) return;
    f.properties.selected = !!this.state.selected[place.id];
    const src = this.map.getSource("pois");
    if (src) src.setData(this.poiData);
  }

  /* ---------- popups ---------- */

  showPopup(place) {
    clearTimeout(this._hideTimer);
    this.hidePopup();
    this.popupPlaceId = place.id;
    const selected = !!this.state.selected[place.id];
    const photo = place.image_url
      ? `<div class="pin-popup-photo"><img loading="lazy" alt="" src="${escapeAttr(place.image_url)}"></div>`
      : "";
    const html = `
      ${photo}
      <div class="pin-popup-body">
        <p class="pin-popup-name">${escapeHtml(place.name)}</p>
        <p class="pin-popup-desc">${escapeHtml(firstSentence(place.description))}</p>
        <div class="pin-popup-badges">${categoryBadge(place.category)}${detourBadges(place)}</div>
        <button class="btn btn-small pin-popup-select ${selected ? "" : "btn-primary"}" data-id="${place.id}">
          ${selected ? "✓ Added — tap to remove" : "Add to trip"}
        </button>
      </div>`;
    this.popup = new maplibregl.Popup({
      closeButton: this.isTouch,
      closeOnClick: true,
      offset: [0, -44],
      maxWidth: "270px",
    })
      .setLngLat([place.lng, place.lat])
      .setHTML(html)
      .addTo(this.map);
    const el = this.popup.getElement();
    el.addEventListener("mouseenter", () => clearTimeout(this._hideTimer));
    el.addEventListener("mouseleave", () => this.scheduleHidePopup());
    const img = el.querySelector(".pin-popup-photo img");
    if (img) img.addEventListener("error", () => img.parentElement.remove());
    el.querySelector(".pin-popup-select").addEventListener("click", () => {
      this.handlers.onPopupSelect(place.id);
      this.hidePopup();
    });
  }

  scheduleHidePopup() {
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this.hidePopup(), 250);
  }

  hidePopup() {
    if (this.popup) {
      this.popup.remove();
      this.popup = null;
    }
    this.popupPlaceId = null;
  }

  clearRoute() {
    if (this.map.getSource("route")) {
      this.map.getSource("route").setData({ type: "Feature", geometry: { type: "LineString", coordinates: [] } });
    }
  }
}

function firstSentence(text) {
  if (!text) return "A curious stop worth a look.";
  const m = text.match(/^.*?[.!?](\s|$)/);
  const s = m ? m[0].trim() : text;
  return s.length > 140 ? s.slice(0, 137) + "…" : s;
}

function escapeHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return (s || "").replace(/"/g, "%22").replace(/'/g, "%27");
}
