// Route & search form (spec §6.1): waypoints with Nominatim autocomplete,
// add/remove/reorder (SortableJS drag handles), keyword, advanced options.
import { geocode } from "./api.js";
import { MAX_WAYPOINTS } from "./constants.js";

const DRAG_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="9" cy="6" r="1.7"/><circle cx="15" cy="6" r="1.7"/><circle cx="9" cy="12" r="1.7"/><circle cx="15" cy="12" r="1.7"/><circle cx="9" cy="18" r="1.7"/><circle cx="15" cy="18" r="1.7"/></svg>`;

export class SearchForm {
  constructor(state, onChange) {
    this.state = state;
    this.onChange = onChange;
    this.listEl = document.getElementById("waypoint-list");
    this.addBtn = document.getElementById("add-stop");
    this.keywordEl = document.getElementById("keyword");
    this.radiusEl = document.getElementById("radius");
    this.radiusValueEl = document.getElementById("radius-value");
    this.errorEl = document.getElementById("form-error");
    this.activeDropdown = null;

    this.addBtn.addEventListener("click", () => {
      if (this.state.waypoints.length >= MAX_WAYPOINTS) return;
      // New stop goes just before the destination.
      this.state.waypoints.splice(this.state.waypoints.length - 1, 0, { name: "", lat: null, lng: null });
      this.render();
      this.onChange();
    });

    this.keywordEl.addEventListener("input", () => {
      this.state.keyword = this.keywordEl.value;
      this.onChange();
    });
    this.radiusEl.addEventListener("input", () => {
      this.state.radius = Number(this.radiusEl.value);
      this.radiusValueEl.textContent = `${this.state.radius} mi`;
      this.onChange();
    });
    document.querySelectorAll(".source-toggles input").forEach((cb) => {
      cb.addEventListener("change", () => {
        this.state.sources = this.enabledSources();
        this.onChange();
      });
    });

    document.addEventListener("click", (e) => {
      if (this.activeDropdown && !this.listEl.contains(e.target)) this.closeDropdown();
    });

    this.sortable = Sortable.create(this.listEl, {
      handle: ".wp-drag",
      animation: 160,
      onEnd: (evt) => {
        const moved = this.state.waypoints.splice(evt.oldIndex, 1)[0];
        this.state.waypoints.splice(evt.newIndex, 0, moved);
        this.render();
        this.onChange();
      },
    });
  }

  enabledSources() {
    return [...document.querySelectorAll(".source-toggles input:checked")].map(
      (cb) => cb.dataset.source
    );
  }

  syncControls() {
    this.keywordEl.value = this.state.keyword || "";
    this.radiusEl.value = this.state.radius;
    this.radiusValueEl.textContent = `${this.state.radius} mi`;
    document.querySelectorAll(".source-toggles input").forEach((cb) => {
      cb.checked = this.state.sources.includes(cb.dataset.source);
    });
  }

  markerFor(i) {
    if (i === 0) return "A";
    if (i === this.state.waypoints.length - 1) return "B";
    return String(i);
  }

  placeholderFor(i) {
    if (i === 0) return "Starting from…";
    if (i === this.state.waypoints.length - 1) return "Heading to…";
    return "Stop along the way…";
  }

  render() {
    this.closeDropdown();
    this.listEl.innerHTML = "";
    this.state.waypoints.forEach((wp, i) => {
      const row = document.createElement("div");
      row.className = "waypoint-row";
      const removable = this.state.waypoints.length > 2;
      row.innerHTML = `
        <span class="wp-drag" title="Drag to reorder">${DRAG_ICON}</span>
        <span class="wp-marker">${this.markerFor(i)}</span>
        <input class="text-input" type="text" placeholder="${this.placeholderFor(i)}"
               value="${escapeAttr(wp.name || "")}" autocomplete="off" />
        <button class="wp-remove ${removable ? "" : "wp-remove-disabled"}" title="Remove" type="button">✕</button>`;
      const input = row.querySelector("input");
      let debounce = null;
      input.addEventListener("input", () => {
        wp.name = input.value;
        wp.lat = wp.lng = null; // typed text invalidates the old geocode
        clearTimeout(debounce);
        if (input.value.trim().length < 3) { this.closeDropdown(); return; }
        debounce = setTimeout(() => this.autocomplete(input, wp, row), 350);
      });
      row.querySelector(".wp-remove").addEventListener("click", () => {
        if (!removable) return;
        this.state.waypoints.splice(i, 1);
        this.render();
        this.onChange();
      });
      this.listEl.appendChild(row);
    });
    this.addBtn.disabled = this.state.waypoints.length >= MAX_WAYPOINTS;
  }

  async autocomplete(input, wp, row) {
    let items;
    try {
      items = await geocode(input.value.trim());
    } catch (_) {
      return;
    }
    if (document.activeElement !== input || !items.length) return;
    this.closeDropdown();
    const dd = document.createElement("div");
    dd.className = "autocomplete";
    items.forEach((item) => {
      const div = document.createElement("div");
      div.className = "autocomplete-item";
      div.textContent = item.name;
      div.addEventListener("mousedown", (e) => {
        e.preventDefault();
        wp.name = shortName(item.name);
        wp.lat = item.lat;
        wp.lng = item.lng;
        input.value = wp.name;
        this.closeDropdown();
        this.onChange();
      });
      dd.appendChild(div);
    });
    row.appendChild(dd);
    this.activeDropdown = dd;
  }

  closeDropdown() {
    if (this.activeDropdown) {
      this.activeDropdown.remove();
      this.activeDropdown = null;
    }
  }

  validate() {
    const missing = this.state.waypoints.filter((w) => w.lat == null || !w.name);
    if (this.state.waypoints.length < 2 || missing.length) {
      this.showError("Pick each waypoint from the suggestions so we know where it is.");
      return false;
    }
    this.hideError();
    return true;
  }

  showError(msg) {
    this.errorEl.textContent = msg;
    this.errorEl.classList.remove("hidden");
  }

  hideError() {
    this.errorEl.classList.add("hidden");
  }
}

function shortName(displayName) {
  // Nominatim display names are long; keep the first three comma parts.
  return displayName.split(",").slice(0, 3).map((s) => s.trim()).join(", ");
}

function escapeAttr(s) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
