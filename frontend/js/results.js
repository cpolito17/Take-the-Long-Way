// Results list (spec §6.3): polaroid cards with sort + category filter
// controls, selection checkboxes, sticky Finalize button. On mobile it
// becomes a draggable bottom sheet with a grab handle (spec §8).
import { CATEGORY_COLORS, SOURCE_LABELS } from "./constants.js";
import { categoryBadge, detourBadges, placeholderArt } from "./pins.js";

const SORTS = {
  top: (a, b) => (b.rank ?? b.score) - (a.rank ?? a.score),
  detour: (a, b) => (a.detour_mi ?? 1e9) - (b.detour_mi ?? 1e9),
  score: (a, b) => b.score - a.score,
  name: (a, b) => a.name.localeCompare(b.name),
};

export class ResultsPanel {
  constructor(state, handlers) {
    this.state = state;
    this.handlers = handlers; // { onToggle(id), onCardClick(id), onFinalize(), onViewChange() }
    this.panel = document.getElementById("results-panel");
    this.list = document.getElementById("results-list");
    this.countEl = document.getElementById("results-count");
    this.sortEl = document.getElementById("sort-by");
    this.chipsEl = document.getElementById("category-chips");
    this.finalizeBtn = document.getElementById("finalize-btn");
    this.selectedCountEl = document.getElementById("selected-count");
    this.finalizeBtn.addEventListener("click", () => this.handlers.onFinalize());
    this.sortEl.addEventListener("change", () => {
      this.state.view.sort = this.sortEl.value;
      this.render();
      this.handlers.onViewChange();
    });
    this.initSheet();
  }

  show() {
    this.panel.classList.remove("hidden");
    if (this.isMobile()) this.snapSheet("peek", false);
  }

  hide() {
    this.panel.classList.add("hidden");
  }

  isMobile() {
    return window.innerWidth <= 768;
  }

  // The filtered + sorted view of the results. The map shows the same set.
  visible() {
    const hidden = new Set(this.state.view.hiddenCats || []);
    const sort = SORTS[this.state.view.sort] || SORTS.top;
    return this.state.results.filter((p) => !hidden.has(p.category)).sort(sort);
  }

  // Selected places kept from earlier searches (not in current results).
  carriedOver() {
    const ids = new Set(this.state.results.map((p) => p.id));
    return Object.values(this.state.selected).filter((p) => !ids.has(p.id));
  }

  render() {
    this.sortEl.value = this.state.view.sort || "top";
    this.renderChips();
    this.list.innerHTML = "";

    const carried = this.carriedOver();
    if (carried.length) {
      const head = document.createElement("p");
      head.className = "carried-header";
      head.textContent = `In your trip from earlier searches (${carried.length})`;
      this.list.appendChild(head);
      carried.forEach((p) => this.list.appendChild(this.buildCard(p)));
      const divider = document.createElement("hr");
      divider.className = "carried-divider";
      this.list.appendChild(divider);
    }

    const places = this.visible();
    const total = this.state.results.length;
    this.countEl.textContent = total
      ? places.length === total ? `${total} finds` : `${places.length} of ${total}`
      : "";
    if (!places.length && !carried.length) {
      this.list.innerHTML = `<p style="font-size:13.5px;color:#6b6878;padding:8px 4px;">
        ${total ? "Everything is filtered out — turn some categories back on." :
        "Nothing unusual in this corridor — try widening the search radius or clearing the keyword."}</p>`;
    }
    places.forEach((p) => this.list.appendChild(this.buildCard(p)));
    this.updateFinalize();
  }

  buildCard(p) {
    const card = document.createElement("article");
    card.className = "poi-card" + (this.state.selected[p.id] ? " selected" : "");
    card.dataset.placeId = p.id;
    const photo = p.image_url
      ? `<div class="poi-photo"><img class="poi-img" loading="lazy" alt="" src="${escapeAttrUrl(p.image_url)}"></div>`
      : `<div class="poi-photo">${placeholderArt(p.category)}</div>`;
    card.innerHTML = `
      ${photo}
      <div class="poi-body">
        <div class="poi-title-row">
          <h3 class="poi-name">${escapeHtml(p.name)}</h3>
          <input type="checkbox" class="poi-check" ${this.state.selected[p.id] ? "checked" : ""}
                 aria-label="Add ${escapeAttrText(p.name)} to trip" />
        </div>
        <p class="poi-teaser">${escapeHtml(teaser(p.description))}</p>
        <div class="poi-badges">
          ${categoryBadge(p.category)}
          <span class="badge badge-source">${sourceLabel(p)}</span>
          ${detourBadges(p)}
        </div>
      </div>`;
    const img = card.querySelector(".poi-img");
    if (img) {
      // Broken thumbnails (Commons 429s, deleted files) fall back to the
      // category placeholder instead of an empty gray box.
      img.addEventListener("error", () => {
        img.parentElement.innerHTML = placeholderArt(p.category);
      });
    }
    card.querySelector(".poi-check").addEventListener("click", (e) => {
      e.stopPropagation();
      this.handlers.onToggle(p.id);
    });
    card.addEventListener("click", () => this.handlers.onCardClick(p.id));
    return card;
  }

  renderChips() {
    const counts = new Map();
    this.state.results.forEach((p) => counts.set(p.category, (counts.get(p.category) || 0) + 1));
    const hidden = new Set(this.state.view.hiddenCats || []);
    this.chipsEl.innerHTML = "";
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, n]) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip" + (hidden.has(cat) ? " chip-off" : "");
        chip.dataset.category = cat;
        chip.innerHTML = `<span class="chip-dot" style="background:${CATEGORY_COLORS[cat] || CATEGORY_COLORS.Other}"></span>${cat} <span class="chip-count">${n}</span>`;
        chip.addEventListener("click", () => {
          const set = new Set(this.state.view.hiddenCats || []);
          set.has(cat) ? set.delete(cat) : set.add(cat);
          this.state.view.hiddenCats = [...set];
          this.render();
          this.handlers.onViewChange();
        });
        this.chipsEl.appendChild(chip);
      });
  }

  refreshCard(id) {
    const card = this.list.querySelector(`[data-place-id="${cssEscape(id)}"]`);
    if (!card) return;
    const selected = !!this.state.selected[id];
    card.classList.toggle("selected", selected);
    card.querySelector(".poi-check").checked = selected;
    this.updateFinalize();
  }

  highlightCard(id) {
    const card = this.list.querySelector(`[data-place-id="${cssEscape(id)}"]`);
    if (!card) return;
    if (this.isMobile()) this.snapSheet("open");
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    card.classList.remove("highlight");
    void card.offsetWidth; // restart the flash animation
    card.classList.add("highlight");
  }

  updateFinalize() {
    const n = Object.keys(this.state.selected).length;
    this.finalizeBtn.disabled = n === 0;
    this.selectedCountEl.textContent = n ? `(${n} stop${n > 1 ? "s" : ""})` : "";
  }

  /* ---- mobile bottom sheet ---- */
  initSheet() {
    const handle = document.getElementById("sheet-handle");
    let startY = 0;
    let startT = 0;
    const onStart = (e) => {
      if (!this.isMobile()) return;
      startY = (e.touches ? e.touches[0] : e).clientY;
      startT = this.currentTranslate();
      const move = (ev) => {
        const y = (ev.touches ? ev.touches[0] : ev).clientY;
        const t = Math.max(0, Math.min(this.peekTranslate(), startT + (y - startY)));
        gsap.set(this.panel, { y: t });
      };
      const end = (ev) => {
        document.removeEventListener("touchmove", move);
        document.removeEventListener("touchend", end);
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", end);
        const y = (ev.changedTouches ? ev.changedTouches[0] : ev).clientY;
        this.snapSheet(y < startY ? "open" : "peek");
      };
      document.addEventListener("touchmove", move, { passive: true });
      document.addEventListener("touchend", end);
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", end);
    };
    handle.addEventListener("touchstart", onStart, { passive: true });
    handle.addEventListener("mousedown", onStart);
  }

  peekTranslate() {
    return this.panel.offsetHeight - 215;
  }

  currentTranslate() {
    const m = new DOMMatrixReadOnly(getComputedStyle(this.panel).transform);
    return m.m42;
  }

  snapSheet(pos, animate = true) {
    if (!this.isMobile()) return;
    const y = pos === "open" ? 0 : this.peekTranslate();
    if (animate && typeof gsap !== "undefined") {
      gsap.to(this.panel, { y, duration: 0.55, ease: "elastic.out(0.9, 0.75)" });
    } else {
      gsap.set(this.panel, { y });
    }
  }
}

function teaser(text) {
  if (!text) return "No write-up — that's half the fun. Go see what it is.";
  return text.length > 150 ? text.slice(0, 147) + "…" : text;
}

function sourceLabel(p) {
  const all = (p.sources || []).filter((s) => SOURCE_LABELS[s]);
  if (all.length > 1) return escapeHtml(`${SOURCE_LABELS[p.source]} +${all.length - 1}`);
  return escapeHtml(SOURCE_LABELS[p.source] || p.source || "Unknown");
}

function escapeHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttrUrl(s) {
  try {
    const url = new URL(s);
    if (url.protocol !== "https:") return "";
    return url.href.replace(/"/g, "%22").replace(/'/g, "%27").replace(/</g, "%3C");
  } catch {
    return "";
  }
}
function escapeAttrText(s) {
  return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function cssEscape(s) {
  return s.replace(/["\\]/g, "\\$&");
}
