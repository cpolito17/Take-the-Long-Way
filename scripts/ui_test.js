/* TTLW browser UI verification (puppeteer-core + system Edge/Chrome).
   Drives the real app: restore a saved session, run a search, check pins
   and cards render, select a place, finalize, and verify the Trip Overview
   modal shows stats and Google Maps links. Takes screenshots along the way.

   Usage: node ui_test.js [baseUrl] [screenshotDir]                       */

const fs = require("fs");
const path = require("path");

const BASE = process.argv[2] || "http://127.0.0.1:8000";
const SHOTS = process.argv[3] || path.join(process.env.TEMP || "/tmp", "ttlw_shots");

const EDGE_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${detail ? "  -- " + detail : ""}`);
  cond ? pass++ : fail++;
}

const SESSION = {
  waypoints: [
    { name: "Ann Arbor, MI", lat: 42.2808, lng: -83.743 },
    { name: "Chicago, IL", lat: 41.8781, lng: -87.6298 },
  ],
  radius: 25,
  keyword: "",
  sources: ["atlas_obscura", "roadside_america", "osm", "wikipedia", "wikidata", "hmdb"],
  results: [],
  selected: [],
  route: null,
  savedAt: Date.now(),
};

(async () => {
  const puppeteer = (await import("puppeteer-core")).default;
  fs.mkdirSync(SHOTS, { recursive: true });
  const exe = EDGE_PATHS.find((p) => fs.existsSync(p));
  if (!exe) { console.error("No Edge/Chrome found"); process.exit(2); }

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: "new",
    args: ["--window-size=1440,900", "--use-angle=swiftshader"],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  console.log(`\n=== TTLW UI test against ${BASE} ===\n`);

  // Seed the saved session before the app boots, then load.
  await page.evaluateOnNewDocument((s) => {
    localStorage.setItem("ttlw_session_v1", JSON.stringify(s));
  }, SESSION);
  await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });

  console.log("1. Boot + session banner");
  check("welcome-back banner shown", await page.$eval("#welcome-banner", (el) => !el.classList.contains("hidden")).catch(() => false));
  await page.click("#welcome-restore");
  await sleep(400);
  const wpValues = await page.$$eval("#waypoint-list input", (els) => els.map((e) => e.value));
  check("restored waypoints into form", wpValues[0].includes("Ann Arbor") && wpValues[1].includes("Chicago"), wpValues.join(" | "));
  await page.screenshot({ path: path.join(SHOTS, "1-restored.png") });

  console.log("\n2. Search");
  await page.click("#search-btn");
  await sleep(700);
  check("loading overlay visible", await page.$eval("#loading-overlay", (el) => !el.classList.contains("hidden")));
  await page.screenshot({ path: path.join(SHOTS, "2-loading.png") });
  try {
    await page.waitForFunction(
      () => !document.getElementById("results-panel").classList.contains("hidden") &&
            document.querySelectorAll(".poi-card").length > 0,
      { timeout: 120000 }
    );
    await page.waitForFunction(
      () => document.getElementById("loading-overlay").classList.contains("hidden"),
      { timeout: 30000 }
    );
  } catch (e) {
    const dump = await page.evaluate(() => ({
      overlayHidden: document.getElementById("loading-overlay").classList.contains("hidden"),
      resultsHidden: document.getElementById("results-panel").classList.contains("hidden"),
      cards: document.querySelectorAll(".poi-card").length,
      pins: document.querySelectorAll(".ttlw-pin").length,
      formError: document.getElementById("form-error").textContent,
    }));
    console.log("  STATE AT FAILURE:", JSON.stringify(dump));
    console.log("  PAGE ERRORS:", errors.slice(0, 6).join(" ;; ") || "(none)");
    await page.screenshot({ path: path.join(SHOTS, "fail-search.png") });
    throw e;
  }
  const nCards = (await page.$$(".poi-card")).length;
  const pinInfo = await page.evaluate(() => ({
    features: window.__ttlw.mapView.poiData.features.length,
    hasLayer: !!window.__ttlw.mapView.map.getLayer("pois"),
    hasIcons: window.__ttlw.mapView.map.hasImage("pin-Roadside-unsel") &&
              window.__ttlw.mapView.map.hasImage("pin-Roadside-sel"),
  }));
  check("result cards rendered", nCards >= 20, `${nCards} cards`);
  check("pins in symbol layer (locked to map)", pinInfo.hasLayer && pinInfo.features === nCards,
        `${pinInfo.features} features`);
  check("pin icons registered", pinInfo.hasIcons);
  check("route line on map", await page.evaluate(() => {
    const c = document.querySelector(".maplibregl-canvas");
    return !!c && c.width > 0;
  }));
  await sleep(1200); // let tiles + fitBounds settle
  await page.screenshot({ path: path.join(SHOTS, "3-results.png") });

  console.log("\n2b. Sort & category filter");
  await page.select("#sort-by", "detour");
  await sleep(300);
  const detours = await page.$$eval(".poi-card .badge-detour", (els) =>
    els.filter((e) => /\bmi\b/.test(e.textContent)).slice(0, 6)
       .map((e) => parseFloat(e.textContent.replace(/[^\d.]/g, "")))
  );
  check("sort by detour ascending",
        detours.length >= 2 && detours.every((d, i) => i === 0 || detours[i - 1] <= d),
        detours.join(", "));
  const filterResult = await page.evaluate(async () => {
    const chip = document.querySelector(".chip");
    const cat = chip.dataset.category;
    const before = document.querySelectorAll(".poi-card").length;
    chip.click();
    await new Promise((r) => setTimeout(r, 250));
    const after = document.querySelectorAll(".poi-card").length;
    const pinCount = window.__ttlw.mapView.poiData.features.length;
    const anyHiddenCat = [...document.querySelectorAll(".poi-card .badge-category")]
      .some((b) => b.textContent === cat);
    document.querySelector(".chip").click(); // restore
    await new Promise((r) => setTimeout(r, 250));
    return { cat, before, after, pinCount, anyHiddenCat,
             restored: document.querySelectorAll(".poi-card").length };
  });
  check("category chip hides its cards", filterResult.after < filterResult.before && !filterResult.anyHiddenCat,
        `${filterResult.cat}: ${filterResult.before} → ${filterResult.after}`);
  check("map pins follow the filter", filterResult.pinCount === filterResult.after,
        `${filterResult.pinCount} pins`);
  check("chip toggles back on", filterResult.restored === filterResult.before);
  await page.select("#sort-by", "top");
  await sleep(300);

  console.log("\n3. Selection sync");
  console.log("  hit-test:", JSON.stringify(await page.evaluate(() => {
    const cb = document.querySelector(".poi-card .poi-check");
    const r = cb.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { rect: { x: Math.round(r.x), y: Math.round(r.y), w: r.width, h: r.height },
             hit: el ? `${el.tagName}.${el.className}` : null };
  })));
  await page.click(".poi-card .poi-check");
  await sleep(300);
  console.log("  state:", JSON.stringify(await page.evaluate(() => ({
    selected: Object.keys(window.__ttlw.state.selected),
    checked: document.querySelector(".poi-card .poi-check").checked,
    firstId: document.querySelector(".poi-card").dataset.placeId,
  }))), "errors:", errors.slice(0, 3).join(" ;; ") || "(none)");
  const sel = await page.evaluate(() => {
    const card = document.querySelector(".poi-card");
    const id = card.dataset.placeId;
    const feature = window.__ttlw.mapView.poiData.features.find((f) => f.properties.id === id);
    return {
      cardSelected: card.classList.contains("selected"),
      pinSelected: feature ? feature.properties.selected === true : false,
      finalizeEnabled: !document.getElementById("finalize-btn").disabled,
      count: document.getElementById("selected-count").textContent,
    };
  });
  check("card marked selected", sel.cardSelected);
  check("matching pin switched to selected icon", sel.pinSelected);
  check("finalize enabled with count", sel.finalizeEnabled && sel.count.includes("1"), sel.count);
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem("ttlw_session_v1")).selected.length);
  check("selection persisted to localStorage", persisted === 1);

  console.log("\n4. Finalize + Trip Overview");
  await page.click("#finalize-btn");
  await page.waitForFunction(
    () => !document.getElementById("trip-modal").classList.contains("hidden") &&
          document.querySelectorAll("#trip-links a").length > 0,
    { timeout: 90000 }
  );
  await sleep(1500); // minimap tiles + entrance animation
  const trip = await page.evaluate(() => ({
    stats: document.getElementById("trip-stats").innerText,
    stops: document.querySelectorAll("#trip-stops li").length,
    links: [...document.querySelectorAll("#trip-links a")].map((a) => a.href),
    minimapCanvas: !!document.querySelector("#trip-minimap canvas"),
  }));
  check("trip stats show baseline/your route/added", /Baseline/i.test(trip.stats) && /adds/i.test(trip.stats), trip.stats.replace(/\n/g, " | ").slice(0, 110));
  check("numbered stop list", trip.stops === 1, `${trip.stops} stop`);
  check("google maps link present + valid", trip.links.length >= 1 && trip.links.every((u) => u.startsWith("https://www.google.com/maps/dir/?")), trip.links[0]?.slice(0, 80));
  check("mini-map rendered", trip.minimapCanvas);
  await page.screenshot({ path: path.join(SHOTS, "4-trip-modal.png") });

  await page.click("#edit-trip");
  await sleep(500);
  check("edit trip returns to main view", await page.$eval("#trip-modal", (el) => el.classList.contains("hidden")));
  check("selections preserved after edit", await page.evaluate(() => document.querySelectorAll(".poi-card.selected").length) === 1);

  console.log("\n5. Selection survives a new search");
  // Change the destination (Chicago → Detroit) and search again: the
  // selected Chicago-area place must carry over, with its detour
  // recomputed against the new route.
  const selectedId = await page.evaluate(() => Object.keys(window.__ttlw.state.selected)[0]);
  await page.evaluate(() => {
    window.__ttlw.state.waypoints[1] = { name: "Detroit, MI", lat: 42.3314, lng: -83.0458 };
  });
  await page.click("#search-btn");
  await page.waitForFunction(
    () => document.querySelectorAll(".poi-card").length > 0 &&
          document.getElementById("loading-overlay").classList.contains("hidden"),
    { timeout: 120000 }
  );
  await sleep(500);
  const cross = await page.evaluate((id) => {
    const sel = window.__ttlw.state.selected[id];
    const feature = window.__ttlw.mapView.poiData.features.find((f) => f.properties.id === id);
    const card = document.querySelector(`[data-place-id="${id.replace(/"/g, '\\"')}"]`);
    return {
      stillSelected: !!sel,
      detourMi: sel ? sel.detour_mi : null,
      carriedHeader: !!document.querySelector(".carried-header"),
      cardShown: !!card && card.classList.contains("selected"),
      pinSelected: feature ? feature.properties.selected === true : false,
      inResults: window.__ttlw.state.results.some((p) => p.id === id),
      finalizeEnabled: !document.getElementById("finalize-btn").disabled,
    };
  }, selectedId);
  check("selection kept after new search", cross.stillSelected && cross.finalizeEnabled);
  check("shown in 'from earlier searches' section", cross.carriedHeader && cross.cardShown && !cross.inResults);
  check("carried pin still on map (selected icon)", cross.pinSelected);
  check("detour recomputed against new route", cross.detourMi !== null && cross.detourMi > 100,
        `+${cross.detourMi} mi`);
  await page.screenshot({ path: path.join(SHOTS, "5-carried-over.png") });
  const afterUncheck = await page.evaluate(async (id) => {
    const card = document.querySelector(`[data-place-id="${id.replace(/"/g, '\\"')}"]`);
    card.querySelector(".poi-check").click();
    await new Promise((r) => setTimeout(r, 300));
    return {
      cardGone: !document.querySelector(`[data-place-id="${id.replace(/"/g, '\\"')}"]`),
      pinGone: !window.__ttlw.mapView.poiData.features.some((f) => f.properties.id === id),
      finalizeDisabled: document.getElementById("finalize-btn").disabled,
    };
  }, selectedId);
  check("unchecking carried stop removes card + pin",
        afterUncheck.cardGone && afterUncheck.pinGone && afterUncheck.finalizeDisabled);

  console.log("\n6. Mobile layout");
  // Changing isMobile reloads the page, so this is a fresh mobile session:
  // restore the seeded trip and search again at phone size.
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await sleep(800);
  await page.click("#welcome-restore");
  await sleep(300);
  await page.click("#search-btn");
  await page.waitForFunction(
    () => document.querySelectorAll(".poi-card").length > 0 &&
          document.getElementById("loading-overlay").classList.contains("hidden"),
    { timeout: 120000 }
  );
  await sleep(1200);
  const mobile = await page.evaluate(() => {
    const sheet = document.getElementById("results-panel");
    const r = sheet.getBoundingClientRect();
    return {
      sheetAtBottom: r.top > window.innerHeight * 0.5 && r.top < window.innerHeight,
      handleVisible: getComputedStyle(document.getElementById("sheet-handle")).display !== "none",
      formCollapsed: document.getElementById("search-panel").classList.contains("mobile-hidden"),
      pillVisible: !document.getElementById("mobile-pill").classList.contains("hidden"),
    };
  });
  check("bottom sheet peeks on mobile", mobile.sheetAtBottom);
  check("grab handle visible", mobile.handleVisible);
  check("form collapses into pill after search", mobile.formCollapsed && mobile.pillVisible);
  await page.screenshot({ path: path.join(SHOTS, "5-mobile.png") });

  const realErrors = errors.filter((e) => !/favicon|net::|tile|404/i.test(e));
  check("no JS page errors", realErrors.length === 0, realErrors.slice(0, 3).join(" ; "));

  await browser.close();
  console.log(`\n=== ${pass} passed, ${fail} failed ===  screenshots: ${SHOTS}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("UI test crashed:", e); process.exit(1); });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
