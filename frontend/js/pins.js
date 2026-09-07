// Custom SVG markers styled like little vintage road signs (spec §6.2):
// a shield-shaped enamel sign on a post, colored by category. Selected pins
// are larger and carry a checkmark.
import { CATEGORY_COLORS, ICON_CAR, ICON_CLOCK } from "./constants.js";

// `scale` renders the SVG at a multiple of its display size — pass 2 when
// rasterizing for map icons (added with pixelRatio: 2) so pins stay crisp.
export function pinSvg(category, selected, scale = 1) {
  const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.Other;
  const size = (selected ? 44 : 30) * scale;
  const inner = selected
    ? `<path d="M12.5 19.5l4 4 7.5-8" stroke="#fff" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<circle cx="18" cy="17" r="4.2" fill="rgba(255,255,255,.85)"/>`;
  return `
  <svg width="${size}" height="${(size * 48) / 36}" viewBox="0 0 36 48" xmlns="http://www.w3.org/2000/svg">
    <rect x="16.4" y="30" width="3.2" height="16" rx="1.4" fill="#8B4A2B"/>
    <rect x="14.2" y="44.4" width="7.6" height="2.6" rx="1.3" fill="#6e3a21"/>
    <path d="M18 1.5 L32.5 7.5 V19.5 C32.5 28.6 26.6 34.4 18 36.8 C9.4 34.4 3.5 28.6 3.5 19.5 V7.5 Z"
          fill="${color}" stroke="#1A1A2E" stroke-width="1.6"/>
    <path d="M18 5 L29.4 9.7 V19.3 C29.4 26.5 24.8 31.2 18 33.4 C11.2 31.2 6.6 26.5 6.6 19.3 V9.7 Z"
          fill="none" stroke="rgba(255,255,255,.7)" stroke-width="1.4"/>
    ${inner}
  </svg>`;
}

export function detourBadges(place) {
  if (place.detour_mi == null) return "";
  return `
    <span class="badge badge-detour">${ICON_CAR}+${fmtMi(place.detour_mi)} mi</span>
    <span class="badge badge-detour">${ICON_CLOCK}+${Math.round(place.detour_min)} min</span>`;
}

export function categoryBadge(category) {
  const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.Other;
  return `<span class="badge badge-category" style="background:${color}">${escapeHtml(category || "Other")}</span>`;
}

export function placeholderArt(category) {
  const color = CATEGORY_COLORS[category] || CATEGORY_COLORS.Other;
  // Simple postcard-ish placeholder: sun + road motif in the category color.
  return `
  <svg class="poi-placeholder" width="84" height="64" viewBox="0 0 84 64" xmlns="http://www.w3.org/2000/svg">
    <rect x="1.5" y="1.5" width="81" height="61" rx="6" fill="#F5EFE0" stroke="${color}" stroke-width="3"/>
    <circle cx="60" cy="20" r="9" fill="${color}" opacity=".75"/>
    <path d="M10 52 C28 40 38 44 50 36 S70 28 76 24" stroke="${color}" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-dasharray="7 6"/>
  </svg>`;
}

export function fmtMi(mi) {
  return mi >= 10 ? Math.round(mi) : mi.toFixed(1);
}

function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
