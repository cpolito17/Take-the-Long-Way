// Loading overlay (spec §6.4, simplified): a compact card with a scrolling
// road, a bobbing car, cycling progress copy, and an indeterminate bar.
import { LOADING_LINES } from "./constants.js";

export class LoadingOverlay {
  constructor() {
    this.el = document.getElementById("loading-overlay");
    this.textEl = document.getElementById("loading-text");
    this.copyTimer = null;
    this.shownAt = 0;
  }

  show() {
    this.el.classList.remove("hidden");
    this.shownAt = performance.now();
    if (typeof gsap !== "undefined") {
      gsap.fromTo(this.el, { opacity: 0 }, { opacity: 1, duration: 0.25 });
      gsap.fromTo(
        ".loading-scene",
        { scale: 0.88, y: 14 },
        { scale: 1, y: 0, duration: 0.45, ease: "back.out(1.6)" }
      );
    }
    let i = 0;
    this.textEl.textContent = LOADING_LINES[0];
    this.copyTimer = setInterval(() => {
      i = (i + 1) % LOADING_LINES.length;
      if (typeof gsap !== "undefined") {
        gsap.to(this.textEl, {
          opacity: 0, y: -6, duration: 0.22, onComplete: () => {
            this.textEl.textContent = LOADING_LINES[i];
            gsap.fromTo(this.textEl, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.25 });
          },
        });
      } else {
        this.textEl.textContent = LOADING_LINES[i];
      }
    }, 1900);
  }

  async hide() {
    // Let the scene breathe for a beat even on fast responses.
    const minShow = 1400;
    const elapsed = performance.now() - this.shownAt;
    if (elapsed < minShow) await sleep(minShow - elapsed);
    clearInterval(this.copyTimer);
    // Plain CSS fade — the dismiss path must never depend on animation
    // library timing.
    this.el.style.transition = "opacity 0.35s ease";
    this.el.style.opacity = "0";
    await sleep(370);
    this.el.classList.add("hidden");
    this.el.style.opacity = "";
    this.el.style.transition = "";
  }
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
