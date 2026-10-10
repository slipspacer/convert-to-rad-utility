// RAD Viewer: drop local splat files (or stream a .rad from a URL) into one
// Spark scene, the way a site using Spark would load them.
import { createSplatView, meshBounds, meshSplatCount, worldBox, setFlipped } from "./splat-view.js";

const $ = (sel, root = document) => root.querySelector(sel);
const STORE = "rad-viewer.prefs.v1";
const fmtCount = (n) => Number(n).toLocaleString();
const fmtBytes = (b) => (b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`);

const prefs = (() => {
  try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch { return {}; }
})();
const savePrefs = () => { try { localStorage.setItem(STORE, JSON.stringify(prefs)); } catch {} };

const objects = []; // { id, name, mesh, box, flipped, visible, el, splats, source }
let view = null;
let nextId = 1;

async function getView() {
  if (view) return view;
  view = await createSplatView($("#v-canvas"));
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
    updateStats();
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
    setMeta(obj, buildLod ? "Decoding and building LoD…" : "Decoding…");
    const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "?").toUpperCase();
    await addMesh(obj, { fileBytes: bytes, fileName: file.name, ...(buildLod ? { lod: true } : {}) }, (mesh) => {
      const lod = mesh.packedSplats?.lodSplats || mesh.extSplats?.lodSplats;
      return `${ext} · ${fmtCount(obj.splats)} splats · ${fmtBytes(file.size)}${lod ? " · LoD" : " · no LoD (renders every splat)"}`;
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
  await addMesh(obj, { url, ...(isRad ? { paged: true } : {}) }, () =>
    isRad ? `Streaming (paged) · ${fmtCount(obj.splats)} splats · LoD` : `${fmtCount(obj.splats)} splats (full download)`,
  );
  if (isRad && obj.mesh && !obj.box && $(".vmeta", obj.el).classList.contains("err") === false) {
    setMeta(obj, `${$(".vmeta", obj.el).textContent} · couldn't measure bounds, use Fly or Frame`);
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
$("#v-detail").addEventListener("input", applyDetail);
$("#v-speed").value = prefs.speed ?? 0;
$("#v-speed").addEventListener("input", applySpeed);
// "-" / "=" step the fly speed while flying (Spark's FpsMovement ignores these keys).
window.addEventListener("keydown", (e) => {
  if (view?.mode !== "fly" || e.target.closest?.("input, textarea")) return;
  if (e.key !== "-" && e.key !== "=" && e.key !== "+") return;
  const s = $("#v-speed");
  s.value = Math.min(Number(s.max), Math.max(Number(s.min), Number(s.value) + (e.key === "-" ? -0.5 : 0.5)));
  applySpeed();
});
for (const r of document.querySelectorAll("input[name=v-mode]")) {
  r.addEventListener("change", async () => {
    const v = await getView();
    v.setMode(r.value);
    $("#v-speed-wrap").hidden = r.value !== "fly";
    $("#v-hint").textContent = r.value === "fly"
      ? "WASD to move · E/Q up/down · drag to look · Shift faster · Ctrl slower · - / = speed"
      : "Drag to orbit · right-drag to pan · scroll to zoom";
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
