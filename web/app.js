const $ = (sel, root = document) => root.querySelector(sel);
const form = $(".settings");
const SETTINGS_KEY = "rad-converter.settings.v1";

const HINTS = {
  lod: {
    quality: "bhatt-lod: best-looking downsampled levels, slower to build. Recommended for streaming.",
    quick: "tiny-lod: builds several times faster, slightly coarser LoD levels.",
    none: "No LoD tree: plain RAD of the original splats (keeps an existing tree if the input has one).",
  },
  output: {
    single: "One self-contained .rad file. Load it with new SplatMesh({ url }).",
    chunked: "Small .rad header + 64K-splat .radc chunk files, zipped. Host them together and load with paged: true.",
  },
  precision: {
    standard: "Full float precision while building the LoD tree (Spark's gsplat; default).",
    compact: "Compact in-memory splats (Spark's csplat): less RAM for very large scenes, slightly lossy.",
  },
};

// ---------- settings ----------

function readSettings() {
  const s = {};
  for (const el of form.querySelectorAll("input[name], select[name]")) {
    if (el.type === "radio") { if (el.checked) s[el.name] = el.value; }
    else if (el.type === "checkbox") s[el.name] = el.checked;
    else s[el.name] = el.value;
  }
  return s;
}

function applySettings(s) {
  for (const el of form.querySelectorAll("input[name], select[name]")) {
    if (!(el.name in s)) continue;
    if (el.type === "radio") el.checked = el.value === s[el.name];
    else if (el.type === "checkbox") el.checked = !!s[el.name];
    else el.value = s[el.name];
  }
}

const defaults = readSettings();
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
  if (saved) applySettings(saved);
} catch {}

function updateHints() {
  const s = readSettings();
  for (const p of form.querySelectorAll("[data-hint-for]")) {
    const key = p.dataset.hintFor;
    p.textContent = HINTS[key]?.[s[key]] ?? "";
  }
}

form.addEventListener("change", () => {
  updateHints();
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(readSettings())); } catch {}
});
$("#reset-settings").addEventListener("click", () => {
  applySettings(defaults);
  try { localStorage.removeItem(SETTINGS_KEY); } catch {}
  updateHints();
});
updateHints();

function parseVec(str, n, label) {
  if (!str.trim()) return undefined;
  const v = str.split(/[\s,]+/).filter(Boolean).map(Number);
  if (v.length !== n || v.some((x) => !Number.isFinite(x))) {
    throw new Error(`${label} needs ${n} comma-separated numbers`);
  }
  return v;
}

function buildJobSettings(s) {
  const lodBase = s.lodBase.trim() === "" ? undefined : Number(s.lodBase);
  if (lodBase !== undefined && !(lodBase >= 1.1 && lodBase <= 16)) throw new Error("LoD base must be between 1.1 and 16");
  return {
    compact: s.precision === "compact",
    fileType: s.fileType,
    chunked: s.output === "chunked",
    process: {
      lod: s.lod,
      lodBase,
      maxSh: s.maxSh === "" ? undefined : Number(s.maxSh),
      minBox: parseVec(s.minBox, 3, "Min corner"),
      maxBox: parseVec(s.maxBox, 3, "Max corner"),
      withinDist: parseVec(s.withinDist, 4, "Sphere"),
      inflate: s.inflate,
    },
    encode: {
      center: s["enc.center"],
      alpha: s["enc.alpha"],
      rgb: s["enc.rgb"],
      scales: s["enc.scales"],
      orientation: s["enc.orientation"],
      sh: s["enc.sh"],
    },
  };
}

// ---------- helpers ----------

const fmtBytes = (b) => {
  if (b < 1024) return `${b} B`;
  const u = ["KB", "MB", "GB"];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return `${b.toFixed(b < 10 ? 2 : b < 100 ? 1 : 0)} ${u[i]}`;
};
const fmtCount = (n) => n.toLocaleString();
const fmtTime = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);

function baseName(name) {
  let n = name.replace(/\.(compressed\.ply|ply|spz|splat|ksplat|sog|zip|rad)$/i, "");
  return n.replace(/-lod$/i, "");
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const STAGE_LABEL = {
  decode: "Reading & decoding",
  lod: "Building LoD tree",
  chunk: "Ordering LoD chunks",
  encode: "Encoding RAD",
};

// ---------- job queue ----------

const queueEl = $("#queue");
const jobs = [];
let running = null;

function addFiles(files) {
  let settings;
  try {
    settings = buildJobSettings(readSettings());
  } catch (err) {
    alert(err.message);
    return;
  }
  for (const file of files) {
    const job = createJob(file, settings);
    jobs.push(job);
  }
  $("#queue-head").hidden = jobs.length === 0;
  pump();
}

function createJob(file, settings) {
  const el = $("#job-tpl").content.firstElementChild.cloneNode(true);
  queueEl.append(el);
  const job = {
    file, settings, el, state: "queued", worker: null, result: null, log: [],
    ui: {
      name: $(".name", el), meta: $(".meta", el), chip: $(".chip", el), bar: $(".bar", el), fill: $(".fill", el),
      stage: $(".stage", el), stats: $(".stats", el), error: $(".error", el), log: $(".log", el),
      save: $(".save", el), saved: $(".saved", el), download: $(".download", el), preview: $(".preview", el), cancel: $(".cancel", el), logToggle: $(".log-toggle", el),
    },
  };
  const { ui } = job;
  ui.name.textContent = file.name;
  const lodLabel = { quality: "quality LoD", quick: "quick LoD", none: "no LoD" }[settings.process.lod];
  ui.meta.textContent = `${fmtBytes(file.size)} · ${lodLabel}${settings.chunked ? " · chunked" : ""}${settings.compact ? " · compact" : ""}`;
  setState(job, "queued");
  ui.stage.textContent = "Waiting…";

  ui.cancel.addEventListener("click", () => cancelJob(job));
  ui.logToggle.addEventListener("click", () => {
    ui.log.hidden = !ui.log.hidden;
    if (!ui.log.hidden) { ui.log.textContent = job.log.join("\n"); ui.log.scrollTop = ui.log.scrollHeight; }
  });
  ui.download.addEventListener("click", () => downloadJob(job));
  ui.save.addEventListener("click", () => saveJobAs(job));
  ui.preview.addEventListener("click", () => openPreview(job));
  return job;
}

function setState(job, state) {
  job.state = state;
  job.el.dataset.state = state;
  job.ui.chip.textContent = { queued: "Queued", running: "Converting", done: "Done", error: "Failed", cancelled: "Cancelled" }[state];
  job.ui.cancel.hidden = !(state === "queued" || state === "running");
}

function setProgress(job, stage, progress) {
  const { ui } = job;
  ui.stage.textContent = STAGE_LABEL[stage] ?? stage;
  // Map stages onto one bar: decode 0–20%, lod 20–85%, encode 85–100%
  const span = { decode: [0, 0.2], lod: [0.2, 0.85], chunk: [0.85, 0.88], encode: [0.88, 1] }[stage] ?? [0, 1];
  if (progress == null) {
    ui.bar.classList.add("indet");
  } else {
    ui.bar.classList.remove("indet");
    ui.fill.style.width = `${(span[0] + (span[1] - span[0]) * Math.min(1, progress)) * 100}%`;
    if (stage !== "decode" && progress < 1) ui.stage.textContent += ` · ${Math.round(progress * 100)}%`;
  }
}

function appendLog(job, line) {
  job.log.push(line);
  if (!job.ui.log.hidden) {
    job.ui.log.textContent += (job.ui.log.textContent ? "\n" : "") + line;
    job.ui.log.scrollTop = job.ui.log.scrollHeight;
  }
}

function pump() {
  if (running) return;
  const job = jobs.find((j) => j.state === "queued");
  if (!job) return;
  running = job;
  runJob(job).finally(() => {
    running = null;
    pump();
  });
}

function runJob(job) {
  return new Promise((resolve) => {
    setState(job, "running");
    const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
    job.worker = worker;
    job.resolve = resolve;
    const finish = () => { worker.terminate(); job.worker = null; resolve(); };
    worker.onerror = (e) => {
      fail(job, e.message || "Worker failed to start (is the page served over http://, not file://?)");
      finish();
    };
    worker.onmessage = ({ data }) => {
      switch (data.type) {
        case "stage": setProgress(job, data.stage, data.progress); break;
        case "log": appendLog(job, data.line); break;
        case "input": {
          job.input = data.input;
          appendLog(job, `Decoded ${data.input.fileType}: ${fmtCount(data.input.splatCount)} splats, SH degree ${data.input.shDegree}${data.input.hasLod ? ", has LoD tree" : ""}`);
          break;
        }
        case "processed": job.processed = data.processed; break;
        case "done": complete(job, data); finish(); break;
        case "error": fail(job, data.message); finish(); break;
      }
    };
    worker.postMessage({ file: job.file, settings: { ...job.settings, baseName: baseName(job.file.name) } });
  });
}

function fail(job, message) {
  setState(job, "error");
  job.ui.bar.classList.remove("indet");
  job.ui.fill.style.width = "100%";
  job.ui.stage.textContent = "";
  job.ui.error.hidden = false;
  job.ui.error.textContent = message;
  appendLog(job, `ERROR: ${message}`);
}

function cancelJob(job) {
  if (job.state === "running" && job.worker) {
    job.worker.terminate();
    job.worker = null;
    job.resolve?.();
  }
  if (job.state === "queued" || job.state === "running") {
    setState(job, "cancelled");
    job.ui.bar.classList.remove("indet");
    job.ui.stage.textContent = "";
  }
}

function complete(job, data) {
  const { ui } = job;
  const base = baseName(job.file.name);
  const suffix = job.processed?.hasLod ? "-lod" : "";
  const radName = `${base}${suffix}.rad`;
  const files = data.files.map((bytes, i) => ({ name: i === 0 ? radName : data.names[i], bytes }));
  job.result = { files, radName, base: `${base}${suffix}`, encoding: data.encoding, timings: data.timings };
  const outBytes = files.reduce((n, f) => n + f.bytes.byteLength, 0);

  setState(job, "done");
  ui.bar.classList.remove("indet");
  ui.fill.style.width = "100%";
  ui.stage.textContent = `${files.length > 1 ? `${radName} + ${files.length - 1} chunk files` : radName}`;

  const p = job.processed, inp = job.input;
  const ratio = outBytes / job.file.size;
  const rows = [
    ["Input", `${inp.fileType.toUpperCase()} · ${fmtCount(inp.splatCount)}`],
    ["Output splats", `${fmtCount(p.splatCount)}${p.hasLod ? " (incl. LoD)" : ""}`],
    ["SH degree", `${p.shDegree}`],
    ["Size", `${fmtBytes(job.file.size)} → ${fmtBytes(outBytes)}`],
    ["Ratio", `${(ratio * 100).toFixed(ratio < 0.1 ? 1 : 0)}%`],
    ["Time", fmtTime(data.timings.total)],
  ];
  ui.stats.replaceChildren(...rows.map(([k, v]) => {
    const d = document.createElement("div");
    d.innerHTML = "<dt></dt><dd></dd>";
    d.firstChild.textContent = k;
    d.lastChild.textContent = v;
    return d;
  }));
  ui.stats.hidden = false;
  ui.save.hidden = !FS;
  ui.download.hidden = FS;
  ui.download.textContent = files.length > 1 ? "Download .zip" : "Download .rad";
  ui.download.classList.toggle("primary", !FS);
  if (FS && outDir) autoSave(job);
  // Chunked headers reference .radc files by relative name, which can't be
  // resolved from in-memory bytes, so only single-file output is previewable.
  ui.preview.hidden = files.length > 1;
  appendLog(job, `Resolved encoding: ${JSON.stringify(data.encoding)}`);
  appendLog(job, `Timings: decode ${fmtTime(data.timings.decode)}, LoD ${fmtTime(data.timings.lod)}, encode ${fmtTime(data.timings.encode)}`);
}

async function downloadJob(job) {
  const { files, radName, base } = job.result;
  if (files.length === 1) {
    download(new Blob([files[0].bytes], { type: "application/octet-stream" }), radName);
    return;
  }
  job.ui.download.disabled = true;
  try {
    const { zipSync } = await import("fflate");
    const entries = {};
    // Chunks are already deflate-compressed per property; store without recompressing.
    for (const f of files) entries[f.name] = [f.bytes, { level: 0 }];
    download(new Blob([zipSync(entries)], { type: "application/zip" }), `${base}-rad.zip`);
  } finally {
    job.ui.download.disabled = false;
  }
}

$("#clear-done").addEventListener("click", () => {
  for (const job of [...jobs]) {
    if (job.state === "done" || job.state === "error" || job.state === "cancelled") {
      job.el.remove();
      jobs.splice(jobs.indexOf(job), 1);
    }
  }
  $("#queue-head").hidden = jobs.length === 0;
});

// ---------- save location ----------

// File System Access API (Chromium browsers): real save dialogs and a
// persistent output folder. Elsewhere we fall back to plain downloads.
const FS = "showSaveFilePicker" in window && "showDirectoryPicker" in window;
let outDir = null; // FileSystemDirectoryHandle with readwrite access
let pendingDir = null; // remembered from a previous visit, needs re-approval

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("rad-converter", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("handles");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction("handles", mode);
      const req = fn(tx.objectStore("handles"));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const rememberDir = (h) => idb("readwrite", (s) => (h ? s.put(h, "outDir") : s.delete("outDir"))).catch(() => {});

function renderFolder() {
  const name = $("#folder-name");
  if (!FS) {
    name.textContent = "Your Downloads folder";
    $("#pick-folder").hidden = true;
    $("#save-hint").textContent = "Choosing a save location needs Chrome, Edge or another Chromium browser. In this browser, results download normally.";
    return;
  }
  const dir = outDir ?? pendingDir;
  name.parentElement.classList.toggle("set", !!outDir);
  name.textContent = outDir ? outDir.name : pendingDir ? `${pendingDir.name} (needs permission)` : "Ask where to save each file";
  $("#pick-folder").textContent = dir ? "Change folder…" : "Choose output folder…";
  $("#reconnect-folder").hidden = !pendingDir || !!outDir;
  $("#clear-folder").hidden = !dir;
}

async function restoreFolder() {
  if (FS) {
    try {
      const h = await idb("readonly", (s) => s.get("outDir"));
      if (h) {
        if ((await h.queryPermission({ mode: "readwrite" })) === "granted") outDir = h;
        else pendingDir = h;
      }
    } catch {}
  }
  renderFolder();
}

$("#pick-folder").addEventListener("click", async () => {
  try {
    const h = await window.showDirectoryPicker({ id: "rad-output", mode: "readwrite", startIn: outDir ?? "downloads" });
    outDir = h;
    pendingDir = null;
    rememberDir(h);
    renderFolder();
    // Save anything that finished before a folder was chosen
    for (const job of jobs) if (job.state === "done" && !job.savedTo) autoSave(job);
  } catch (err) {
    if (err.name !== "AbortError") alert(`Couldn't use that folder: ${err.message}`);
  }
});
$("#reconnect-folder").addEventListener("click", async () => {
  if (pendingDir && (await pendingDir.requestPermission({ mode: "readwrite" })) === "granted") {
    outDir = pendingDir;
    pendingDir = null;
    for (const job of jobs) if (job.state === "done" && !job.savedTo) autoSave(job);
  }
  renderFolder();
});
$("#clear-folder").addEventListener("click", () => {
  outDir = pendingDir = null;
  rememberDir(null);
  renderFolder();
});
restoreFolder();

async function exists(dir, name, kind) {
  try {
    await (kind === "dir" ? dir.getDirectoryHandle(name) : dir.getFileHandle(name));
    return true;
  } catch (err) {
    if (err.name === "NotFoundError") return false;
    if (err.name === "TypeMismatchError") return true; // taken by the other kind
    throw err;
  }
}

// "scene-lod.rad" -> "scene-lod (2).rad" if taken, so auto-saves never overwrite.
async function freeName(dir, name, kind) {
  const dot = kind === "dir" ? -1 : name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? name : `${stem} (${i})${ext}`;
    if (!(await exists(dir, candidate, kind))) return candidate;
  }
}

async function writeFile(dir, name, bytes) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(bytes);
  await w.close();
}

// Chunked output is a .rad header plus .radc chunks it references by name;
// keep them together in their own subfolder.
async function writeChunked(dir, job) {
  const { files, base } = job.result;
  const sub = await dir.getDirectoryHandle(await freeName(dir, base, "dir"), { create: true });
  for (const f of files) await writeFile(sub, f.name, f.bytes);
  return `${dir.name}/${sub.name}/ (${files.length} files)`;
}

function showSaved(job, text, isError = false) {
  const el = job.ui.saved;
  el.hidden = false;
  el.style.color = isError ? "var(--err)" : "";
  el.textContent = text;
}

async function autoSave(job) {
  try {
    if (job.result.files.length > 1) {
      job.savedTo = await writeChunked(outDir, job);
    } else {
      const name = await freeName(outDir, job.result.radName, "file");
      await writeFile(outDir, name, job.result.files[0].bytes);
      job.savedTo = `${outDir.name}/${name}`;
    }
    showSaved(job, `Saved to ${job.savedTo}`);
  } catch (err) {
    showSaved(job, `Couldn't save to ${outDir.name}: ${err.message}. Use “Save as…” instead.`, true);
  }
}

async function saveJobAs(job) {
  const { files, radName } = job.result;
  try {
    if (files.length > 1) {
      const dir = await window.showDirectoryPicker({ id: "rad-output", mode: "readwrite", startIn: outDir ?? "downloads" });
      job.savedTo = await writeChunked(dir, job);
    } else {
      const fh = await window.showSaveFilePicker({
        id: "rad-save",
        suggestedName: radName,
        startIn: outDir ?? "downloads",
        types: [{ description: "Spark RAD splats", accept: { "application/octet-stream": [".rad"] } }],
      });
      const w = await fh.createWritable();
      await w.write(files[0].bytes);
      await w.close();
      job.savedTo = fh.name;
    }
    showSaved(job, `Saved to ${job.savedTo}`);
  } catch (err) {
    if (err.name !== "AbortError") showSaved(job, `Save failed: ${err.message}`, true);
  }
}

// ---------- drop zone ----------

const drop = $("#drop");
const input = $("#file-input");
input.addEventListener("change", () => {
  addFiles([...input.files]);
  input.value = "";
});
for (const ev of ["dragenter", "dragover"]) {
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
}
for (const ev of ["dragleave", "drop"]) {
  drop.addEventListener(ev, () => drop.classList.remove("over"));
}
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length) addFiles(files);
});
// Dropping anywhere else on the page shouldn't navigate away to the file.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

// ---------- preview ----------

const dialog = $("#viewer");
let viewer = null;

async function getViewer() {
  if (viewer) return viewer;
  const THREE = await import("three");
  const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
  const { SparkRenderer, SplatMesh } = await import("@sparkjsdev/spark");
  const host = $("#viewer-canvas");
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0d0c);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 5000);
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = host;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(host);
  viewer = { THREE, SplatMesh, renderer, scene, camera, controls, resize, mesh: null, flipped: true };
  return viewer;
}

async function openPreview(job) {
  const status = $("#viewer-status");
  $("#viewer-title").textContent = job.result.radName;
  status.textContent = "Loading viewer…";
  dialog.showModal();
  try {
    const v = await getViewer();
    v.resize();
    if (v.mesh) { v.scene.remove(v.mesh); v.mesh.dispose?.(); v.mesh = null; }
    status.textContent = "Loading splats…";

    const bytes = job.result.files[0].bytes;
    const mesh = new v.SplatMesh({ fileBytes: bytes.slice(), fileName: job.result.radName });
    v.mesh = mesh;
    mesh.quaternion.set(v.flipped ? 1 : 0, 0, 0, v.flipped ? 0 : 1);
    v.scene.add(mesh);
    await mesh.initialized;

    // Frame the camera on the robust (2–98th percentile) bounds computed during conversion.
    const b = job.processed.bounds;
    const min = new v.THREE.Vector3(...b.min), max = new v.THREE.Vector3(...b.max);
    const center = min.clone().add(max).multiplyScalar(0.5).applyQuaternion(mesh.quaternion);
    const radius = Math.max(1e-3, min.distanceTo(max) / 2);
    v.controls.target.copy(center);
    v.camera.near = radius / 1000;
    v.camera.far = radius * 100;
    v.camera.position.copy(center).add(new v.THREE.Vector3(0, radius * 0.35, radius * 1.6));
    v.camera.updateProjectionMatrix();
    v.controls.update();
    status.textContent = `${fmtCount(job.processed.splatCount)} splats${job.processed.hasLod ? " · LoD active" : ""}`;

    v.renderer.setAnimationLoop(() => {
      v.controls.update();
      v.renderer.render(v.scene, v.camera);
    });
  } catch (err) {
    status.textContent = `Preview failed: ${err.message ?? err}`;
    console.error(err);
  }
}

$("#viewer-flip").addEventListener("click", () => {
  if (!viewer?.mesh) return;
  viewer.flipped = !viewer.flipped;
  viewer.mesh.quaternion.set(viewer.flipped ? 1 : 0, 0, 0, viewer.flipped ? 0 : 1);
  // Mirror the orbit target through the X axis to keep the scene in view.
  viewer.controls.target.y *= -1;
  viewer.controls.target.z *= -1;
  viewer.camera.position.y *= -1;
  viewer.camera.position.z *= -1;
});
$("#viewer-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  if (!viewer) return;
  viewer.renderer.setAnimationLoop(null);
  if (viewer.mesh) { viewer.scene.remove(viewer.mesh); viewer.mesh.dispose?.(); viewer.mesh = null; }
});
