// RAD Viewer: drop local splat files (or stream a .rad from a URL) into one
// Spark scene, the way a site using Spark would load them.
import { createSplatView, meshBounds, meshSplatCount, worldBox, setFlipped, benchmark, radStreamOptions } from "./splat-view.js";
import { radReport } from "./rad-report.js";

const $ = (sel, root = document) => root.querySelector(sel);
const STORE = "rad-viewer.prefs.v1";
const fmtCount = (n) => Number(n).toLocaleString();
const fmtBytes = (b) => (b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);

const prefs = (() => {
  try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch { return {}; }
})();
const savePrefs = () => { try { localStorage.setItem(STORE, JSON.stringify(prefs)); } catch {} };

const objects = []; // { id, name, mesh, box, flipped, visible, el, splats, report }
// Handle for debugging from the browser console: radViewer.view, radViewer.objects
window.radViewer = { objects, get view() { return view; } };
let view = null;
let nextId = 1;

async function getView() {
  if (view) return view;
  view = await createSplatView($("#v-canvas"));
  view.onModeChange = showMode;
  let frames = 0;
  let last = performance.now();
  view.start(() => {
    frames++;
    const now = performance.now();
    if (now - last > 1000) {
      updateStats(Math.round((frames * 1000) / (now - last)));
      frames = 0;
      last = now;
    }
  });
  applyDetail();
  applySpeed();
  view.setRenderScale(Number($("#v-res").value));
  return view;
}

function updateStats(fps) {
  const shown = objects.filter((o) => o.visible);
  const total = shown.reduce((n, o) => n + (o.splats || 0), 0);
  $("#v-stats").textContent = objects.length
    ? `${shown.length}/${objects.length} visible · ${fmtCount(total)} splats in files${fps != null ? ` · ${fps} fps` : ""}`
    : "";
}

function renderList() {
  $("#v-measure").disabled = !objects.some((o) => o.box);
  $("#v-list-empty").hidden = objects.length > 0;
  $("#v-empty").hidden = objects.length > 0;
  updateStats();
}

function setMeta(obj, text, isError = false) {
  const m = $(".vmeta", obj.el);
  m.textContent = text;
  m.classList.toggle("err", isError);
}

function addItem(name) {
  const el = $("#v-item-tpl").content.firstElementChild.cloneNode(true);
  $(".vname", el).textContent = name;
  $("#v-list").append(el);
  const obj = { id: nextId++, name, el, mesh: null, box: null, flipped: prefs.flip ?? true, visible: true, splats: 0 };
  $(".vx", el).addEventListener("click", () => removeObject(obj));
  $(".vvis", el).addEventListener("click", () => {
    obj.visible = !obj.visible;
    if (obj.mesh) obj.mesh.visible = obj.visible;
    $(".vvis", el).textContent = obj.visible ? "Hide" : "Show";
    el.classList.toggle("hidden-obj", !obj.visible);
    updateStats();
  });
  $(".vflip", el).addEventListener("click", () => {
    if (!obj.mesh) return;
    obj.flipped = !obj.flipped;
    prefs.flip = obj.flipped;
    savePrefs();
    setFlipped(obj.mesh, obj.flipped);
    focus([obj]);
  });
  $(".vfocus", el).addEventListener("click", () => focus([obj]));
  $(".vrep", el).addEventListener("click", () => {
    const box = $(".vreport", el);
    box.hidden = !box.hidden;
  });
  objects.push(obj);
  renderList();
  return obj;
}

function removeObject(obj) {
  if (obj.mesh) {
    view.scene.remove(obj.mesh);
    obj.mesh.dispose?.();
  }
  obj.el.remove();
  objects.splice(objects.indexOf(obj), 1);
  renderList();
}

function focus(list) {
  const { THREE } = view;
  const box = new THREE.Box3();
  for (const o of list) {
    if (o.mesh && o.box && o.visible) box.union(worldBox(view, o.mesh, o.box));
  }
  if (!box.isEmpty()) view.frame(box);
}

async function addMesh(obj, options, describe) {
  const v = await getView();
  try {
    const mesh = new v.spark.SplatMesh(options);
    obj.mesh = mesh;
    setFlipped(mesh, obj.flipped);
    v.scene.add(mesh);
    await mesh.initialized;
    if (!objects.includes(obj)) return; // removed while loading
    obj.splats = await meshSplatCount(mesh);
    setMeta(obj, describe(mesh));
    obj.box = await meshBounds(v, mesh);
    // Frame the first object automatically; later ones join the scene as-is.
    if (objects.filter((o) => o.box).length === 1) focus([obj]);
    renderList();
  } catch (err) {
    console.error(err);
    setMeta(obj, `Couldn't load: ${err.message ?? err}`, true);
  }
}

async function openFiles(files) {
  for (const file of files) {
    const obj = addItem(file.name);
    const isRad = /\.rad$/i.test(file.name);
    const buildLod = !isRad && $("#v-lod").checked;
    setMeta(obj, `Reading ${fmtBytes(file.size)}…`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "?").toUpperCase();
    if (isRad) showReport(obj, radReport({ bytes }));
    // A .rad with an LoD tree streams from memory (only the chunks in view
    // are decoded); anything else is decoded in full.
    const stream = isRad ? radStreamOptions((await getView()).spark, { bytes }) : null;
    setMeta(obj, stream ? "Streaming…" : buildLod ? "Decoding and building LoD…" : "Decoding…");
    await addMesh(obj, stream ?? { fileBytes: bytes, fileName: file.name, ...(buildLod ? { lod: true } : {}) }, (mesh) => {
      const lod = mesh.paged || mesh.packedSplats?.lodSplats || mesh.extSplats?.lodSplats;
      return `${ext} · ${fmtCount(obj.splats)} splats · ${fmtBytes(file.size)}${lod ? " · LoD" : " · no LoD (renders every splat)"}${mesh.paged ? " · streaming" : ""}`;
    });
  }
}

async function openUrl(raw) {
  let url;
  try {
    url = new URL(raw, location.href).toString();
  } catch {
    return alert("That doesn't look like a valid URL.");
  }
  prefs.lastUrl = raw;
  savePrefs();
  const name = decodeURIComponent(url.split("/").pop().split("?")[0] || url);
  const obj = addItem(name);
  const isRad = /\.rad(\?|#|$)/i.test(url);
  setMeta(obj, isRad ? "Fetching header…" : "Downloading…");
  if (isRad) showReport(obj, radReport({ url }));
  await addMesh(obj, { url, ...(isRad ? { paged: true } : {}) }, () =>
    isRad ? `Streaming (paged) · ${fmtCount(obj.splats)} splats · LoD` : `${fmtCount(obj.splats)} splats (full download)`,
  );
  if (isRad && obj.mesh && !obj.box && $(".vmeta", obj.el).classList.contains("err") === false) {
    setMeta(obj, `${$(".vmeta", obj.el).textContent} · couldn't measure bounds, use Fly or Frame`);
  }
}

// ---------- file check (static) ----------

const LEVEL_LABEL = { high: "Will be slow", medium: "Heavier than needed", good: "Nothing heavy found" };

async function showReport(obj, promise) {
  const btn = $(".vrep", obj.el);
  const box = $(".vreport", obj.el);
  try {
    const report = await promise;
    obj.report = report;
    btn.hidden = false;
    btn.textContent = `File check: ${LEVEL_LABEL[report.level]}`;
    btn.dataset.level = report.level;
    box.replaceChildren(...report.findings.map((f) => {
      const p = document.createElement("p");
      p.className = `finding ${f.level}`;
      p.innerHTML = "<strong></strong> <span></span>";
      p.firstChild.textContent = f.title;
      p.lastChild.textContent = f.detail;
      return p;
    }));
  } catch (err) {
    console.warn("File check failed", err);
  }
}

// ---------- benchmark (runtime) ----------

// Smooth needs a good average AND steady frames: "worst" is the 1-in-20
// slowest frame, and dips are what make navigation feel sluggish.
function rate(g, target) {
  if (g.fps >= target * 0.9 && g.worst >= target * 0.75) return { level: "good", label: "Smooth" };
  if (g.fps >= 30 && g.worst >= 20) return { level: "medium", label: "Some stutter" };
  return { level: "high", label: "Sluggish" };
}

async function runBenchmark() {
  const shown = objects.filter((o) => o.visible && o.mesh && o.box);
  if (!shown.length) return;
  const btn = $("#v-measure");
  const out = $("#v-perf-out");
  btn.disabled = true;
  const box = new view.THREE.Box3();
  for (const o of shown) box.union(worldBox(view, o.mesh, o.box));
  const detail = view.sparkRenderer.lodSplatScale;
  try {
    const r = await benchmark(view, box, {
      meshes: objects.filter((o) => o.mesh).map((o) => o.mesh),
      onStep: (text, p) => { out.textContent = `${text}${p ? ` · ${Math.round(p * 100)}%` : ""}…`; },
    });
    const target = Math.min(60, r.refresh);
    const rows = [["Outside", r.outside], ["Inside", r.inside]].map(([name, g]) => ({ name, g, rating: rate(g, target) }));
    const worst = rows.reduce((a, b) => (a.g.fps < b.g.fps ? a : b));
    const lines = [];
    lines.push(`<table class="perf-table"><thead><tr><th></th><th>fps</th><th>dips</th><th>splats drawn</th><th></th></tr></thead><tbody>${
      rows.map(({ name, g, rating }) => `<tr><td>${name}</td><td>${g.fps.toFixed(0)}</td><td>${g.worst.toFixed(0)}</td><td>${(g.splats / 1e6).toFixed(2)}M</td><td><span class="pill ${rating.level}">${rating.label}</span></td></tr>`).join("")
    }</tbody></table>`);
    const canvas = view.renderer.domElement;
    lines.push(`<p class="hint">Rendered ${canvas.width}×${canvas.height} px (Resolution ${Math.round(view.renderScale * 100)}%) · display ${r.refresh.toFixed(0)} Hz · target ${target.toFixed(0)} fps · Detail ${Number(detail.toFixed(2))}× · ${shown.length} object${shown.length > 1 ? "s" : ""}. Results change with window size.</p>`);
    const p = r.probe;
    const bottleneck = p.capped
      ? `<p class="finding info"><strong>No bottleneck.</strong> <span>Even the slowest view runs at your display's refresh rate (${r.refresh.toFixed(0)} Hz), so there's headroom to spare.</span></p>`
      : p.fillBound
      ? `<p class="finding info"><strong>Bottleneck: pixels (overdraw).</strong> <span>The slowest view ran ${p.full.toFixed(0)} fps at this resolution and ${p.half.toFixed(0)} fps at half: splats here are large on screen and stack up. Resolution 75% or 50% helps far more than lowering Detail.</span></p>`
      : `<p class="finding info"><strong>Bottleneck: splat count.</strong> <span>Halving the resolution barely helped (${p.full.toFixed(0)} → ${p.half.toFixed(0)} fps), so the cost is the number of splats drawn. Lowering Detail helps most.</span></p>`;
    if (worst.rating.level !== "good") {
      const suggest = Math.max(0.25, Math.min(1, detail * (worst.g.fps / target)));
      const fix = p.fillBound
        ? `Set Resolution to ${p.half >= target * 1.2 ? "75%" : "50%"} (about ${p.half.toFixed(0)} fps at 50% in the slowest view).`
        : `Try Detail ≈ ${Number(suggest.toFixed(2))}× (fewer splats per frame, slightly softer image).`;
      lines.push(`<p class="finding medium"><strong>${worst.name} views aren't smooth on this device.</strong> <span>${fix}</span></p>`);
    }
    lines.push(bottleneck);
    const hitches = r.outside.hitches + r.inside.hitches;
    if (hitches) lines.push(`<p class="hint">${hitches} pause${hitches > 1 ? "s" : ""} over 0.1 s during the tour, usually Spark updating the LoD selection or streaming after a big camera jump. These matter less than steady frame rate.</p>`);
    out.innerHTML = lines.join("");
  } catch (err) {
    out.textContent = `Measurement failed: ${err.message ?? err}`;
  } finally {
    btn.disabled = false;
  }
}

function applySpeed() {
  const v = Number($("#v-speed").value);
  const mult = 2 ** v;
  $("#v-speed-out").textContent = `${Number(mult.toFixed(2))}×`;
  prefs.speed = v;
  savePrefs();
  view?.setFlySpeed(mult);
}

function applyDetail() {
  const v = Number($("#v-detail").value);
  const scale = 2 ** v;
  $("#v-detail-out").textContent = `${Number(scale.toFixed(2))}×`;
  if (view) view.sparkRenderer.lodSplatScale = scale;
}

// ---------- wiring ----------

$("#v-files").addEventListener("change", (e) => {
  openFiles([...e.target.files]);
  e.target.value = "";
});
$("#v-url-form").addEventListener("submit", (e) => {
  e.preventDefault();
  openUrl($("#v-url").value.trim());
});
$("#v-frame").addEventListener("click", () => view && focus(objects));
$("#v-measure").addEventListener("click", runBenchmark);
$("#v-res").value = String(prefs.res ?? 1);
$("#v-res").addEventListener("change", (e) => {
  prefs.res = Number(e.target.value);
  savePrefs();
  view?.setRenderScale(prefs.res);
});
$("#v-detail").addEventListener("input", applyDetail);
$("#v-speed").value = prefs.speed ?? 0;
$("#v-speed").addEventListener("input", applySpeed);
// "-" / "=" step the fly speed (Spark's FpsMovement ignores these keys).
window.addEventListener("keydown", (e) => {
  if (!view || e.target.closest?.("input:not([type=radio]):not([type=range]), textarea")) return;
  if (e.key !== "-" && e.key !== "=" && e.key !== "+") return;
  const s = $("#v-speed");
  s.value = Math.min(Number(s.max), Math.max(Number(s.min), Number(s.value) + (e.key === "-" ? -0.5 : 0.5)));
  applySpeed();
});
function showMode(mode) {
  for (const r of document.querySelectorAll("input[name=v-mode]")) r.checked = r.value === mode;
  $("#v-hint").textContent = mode === "fly"
    ? "WASD to move · R/F up/down · Q/E turn · drag to look · Shift faster · Ctrl slower · - / = speed"
    : "Drag to orbit · right-drag to pan · scroll to zoom · WASD to fly";
}
for (const r of document.querySelectorAll("input[name=v-mode]")) {
  r.addEventListener("change", async () => {
    const v = await getView();
    v.setMode(r.value);
    showMode(r.value);
  });
}
$("#v-lod").checked = Boolean(prefs.lod);
$("#v-lod").addEventListener("change", (e) => { prefs.lod = e.target.checked; savePrefs(); });
if (prefs.lastUrl) $("#v-url").value = prefs.lastUrl;

const stage = $("#v-stage");
let dragDepth = 0;
stage.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; $("#v-drop").hidden = false; });
stage.addEventListener("dragover", (e) => e.preventDefault());
stage.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#v-drop").hidden = true; } });
stage.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  $("#v-drop").hidden = true;
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) openFiles(files);
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// viewer.html?url=https://host/scene-lod.rad streams that file on load.
const initial = new URLSearchParams(location.search).get("url");
if (initial) {
  $("#v-url").value = initial;
  openUrl(initial);
}
renderList();
