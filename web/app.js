import {
  native, probeNative, buildLodFlags, nativeBlocker, nativeIgnored, runNativeJob, discardNativeJob,
  detectOS, terminalCommands, oneClickScript, binariesPublished, nativeOutputName,
} from "./native.js";
import { createSplatView, meshBounds, worldBox, setFlipped, benchmark } from "./splat-view.js";
import { radReport, reportText } from "./rad-report.js";

const $ = (sel, root = document) => root.querySelector(sel);
// Started at load; native jobs wait for it so they know whether serve.py is there.
const nativeReady = probeNative();
const form = $(".settings");
const SETTINGS_KEY = "rad-converter.settings.v1";

const HINTS = {
  lod: {
    quality: "bhatt-lod: best-looking downsampled levels, slower to build. Recommended for streaming.",
    quick: "tiny-lod: builds several times faster, slightly coarser LoD levels.",
    none: "No LoD tree: plain RAD of the original splats (keeps an existing tree if the input has one).",
  },
  output: {
    single: "One self-contained .rad (recommended). Stream it with new SplatMesh({ url, paged: true }) from any host that supports HTTP Range requests.",
    chunked: "A small .rad header plus 64K-splat .radc files, for hosts or CDNs that can't serve Range requests. Upload them together and load the .rad with paged: true.",
  },
  precision: {
    standard: "Full float precision while building the LoD tree (Spark's gsplat; default).",
    compact: "Compact in-memory splats (Spark's csplat): less RAM for very large scenes, slightly lossy.",
  },
  engine: {
    browser: "Runs inside this page. Handles scenes up to roughly 15–24M splats, depending on settings.",
    get native() {
      if (native.mode === "server") return "Runs Spark's native build-lod on this computer, with no memory limit. The first use downloads it (about 15 MB).";
      if (native.mode === "unsupported") return "The native tool is available for Windows and macOS only.";
      return "Runs Spark's native build-lod on this computer, with no memory limit. Each file gets a one-click converter to run. Open this page with the Start RAD Converter launcher to have it run automatically.";
    },
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
    engine: s.engine,
    repack: s.repack,
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

const FORMAT_NAMES = { ply: "PLY", spz: "SPZ", splat: "SPLAT", ksplat: "KSPLAT", pcsogszip: "SOG", rad: "RAD" };
const formatName = (type) => FORMAT_NAMES[type] ?? String(type ?? "?").toUpperCase();

function logFileName(radName) {
  return `${radName.replace(/\.rad$/i, "")}.log.txt`;
}

function describeSettings(s) {
  const p = s.process;
  const crop = [
    p.minBox && `min corner ${p.minBox.join(", ")}`,
    p.maxBox && `max corner ${p.maxBox.join(", ")}`,
    p.withinDist && `sphere center ${p.withinDist.slice(0, 3).join(", ")}, radius ${p.withinDist[3]}`,
  ].filter(Boolean);
  const encodings = Object.entries(s.encode).map(([k, v]) => `${k} ${v || "Auto"}`).join(", ");
  return [
    ["Level of detail", { quality: "Quality (bhatt-lod)", quick: "Quick (tiny-lod)", none: "None" }[p.lod]],
    ["LoD base", p.lod === "none" ? "n/a" : p.lodBase != null ? String(p.lodBase) : `default (${p.lod === "quick" ? 1.5 : 1.75})`],
    ["Output", s.chunked ? "Chunked (.rad header + .radc chunks)" : "Single .rad"],
    ["Working precision", s.compact ? "Compact (csplat)" : "Standard (gsplat)"],
    ["Spherical harmonics", p.maxSh == null ? "Keep all" : `Up to degree ${p.maxSh}`],
    ["Engine", s.engine === "native" ? "Native" : "Browser"],
    ["Low-memory mode", s.engine === "native" ? "n/a (native engine)" : s.repack || "auto"],
    ["Input format", s.fileType ? `Forced: ${s.fileType}` : "Auto-detect"],
    ["Property encodings", s.engine === "native" ? "Auto (native engine)" : encodings],
    ["Crop", crop.length ? crop.join("; ") : "none"],
    ["Inflate", p.inflate ? "on" : "off"],
  ];
}

// Plain-text record of a conversion: what went in, how, and what came out,
// followed by the full log. Saved next to the .rad for later evaluation.
function buildLogText(job, savedRadName) {
  const { settings, input = {}, processed = {}, result } = job;
  const sparkRev = (native.manifest?.sparkRev ?? "c57ebb936a5d").slice(0, 7);
  const outBytes = result.files.reduce((n, f) => n + f.size, 0);
  const when = job.finishedAt ?? new Date();
  const native_ = settings.engine === "native";
  const row = ([k, v]) => `${(k + ":").padEnd(21)}${v}`;
  const header = [
    ["Output", `${savedRadName}${result.files.length > 1 ? ` + ${result.files.length - 1} .radc chunk files` : ""} · ${fmtBytes(outBytes)}`],
    ["Converted", `${when.toLocaleString()} (${when.toISOString()})`],
    ["Input file", `${job.file.name} · ${fmtBytes(job.file.size)}`],
    ["Input type", `${formatName(input.fileType)} · ${fmtCount(input.splatCount ?? 0)} splats · SH degree ${input.shDegree ?? "?"}`],
    ["Output splats", `${fmtCount(processed.splatCount ?? 0)}${processed.hasLod ? " (incl. LoD tree)" : ""} · SH degree ${processed.shDegree ?? "?"}`],
    ["Engine", native_
      ? `Native: Spark build-lod ${native.manifest?.tag ?? ""} (sparkjsdev/spark@${sparkRev})`.replace("  ", " ")
      : `Browser: spark-lib WebAssembly (sparkjsdev/spark@${sparkRev})`],
    ...(native_ ? [["Command", `build-lod ${buildLodFlags(settings).join(" ")} "${job.file.name}"`]] : []),
    ["Duration", fmtTime(result.timings.total)],
  ];
  const title = "RAD Converter conversion log";
  return [
    title,
    "=".repeat(title.length),
    ...header.map(row),
    "",
    "Settings",
    "--------",
    ...describeSettings(settings).map(row),
    ...(result.encoding ? [row(["Resolved encoding", JSON.stringify(result.encoding)])] : []),
    "",
    "File check",
    "----------",
    ...(job.report ? reportText(job.report) : ["(not available for this output)"]),
    ...(job.benchmark ? ["", "Measured on this device", "-----------------------", ...job.benchmark] : []),
    "",
    "Log",
    "---",
    ...job.log,
    "",
  ].join("\n");
}

function logFile(job, savedRadName) {
  const name = logFileName(savedRadName);
  const bytes = new TextEncoder().encode(buildLogText(job, savedRadName).replace(/\n/g, "\r\n"));
  return { name, size: bytes.byteLength, bytes };
}

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
  install: "Installing the native engine (first use only)",
  upload: "Sending the file to the native engine",
  decode: "Reading & decoding",
  repack: "Moving splats to fresh memory",
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
      native: $(".native-switch", el),
      filecheck: $(".filecheck", el),
    },
  };
  const { ui } = job;
  ui.name.textContent = file.name;
  const lodLabel = { quality: "quality LoD", quick: "quick LoD", none: "no LoD" }[settings.process.lod];
  ui.meta.textContent = metaText(file, settings);
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
  ui.native.addEventListener("click", () => switchToNative(job));
  return job;
}

function metaText(file, settings) {
  const lodLabel = { quality: "quality LoD", quick: "quick LoD", none: "no LoD" }[settings.process.lod];
  return `${fmtBytes(file.size)} · ${lodLabel}${settings.chunked ? " · chunked" : ""}${settings.compact ? " · compact" : ""}` +
    `${settings.engine === "native" ? " · native engine" : ""}`;
}

function showNativeButton(job, label) {
  if (nativeBlocker(job.settings, job.file.name) || native.mode === "unsupported") return;
  job.ui.native.textContent = label;
  job.ui.native.hidden = false;
}

// Re-run a job (running in the browser, failed, or flagged too large) natively.
function switchToNative(job) {
  const blocker = nativeBlocker(job.settings, job.file.name);
  if (blocker) return alert(blocker);
  if (native.mode !== "server") return openHandoff(job);
  if (job.state === "running") {
    job.worker?.terminate();
    job.worker = null;
    job.resolve?.();
  }
  job.settings = { ...job.settings, engine: "native" };
  job.ui.meta.textContent = metaText(job.file, job.settings);
  resetJobUi(job);
  appendLog(job, "--- Switching to the native engine ---");
  setState(job, "queued");
  job.ui.stage.textContent = "Waiting…";
  pump();
}

function resetJobUi(job) {
  const { ui } = job;
  for (const el of [ui.error, ui.stats, ui.saved, ui.save, ui.download, ui.preview, ui.native, ui.filecheck]) el.hidden = true;
  ui.bar.classList.remove("indet");
  ui.fill.style.width = "0";
  job.result = job.processed = job.input = job.report = job.benchmark = null;
}

function setState(job, state) {
  job.state = state;
  job.el.dataset.state = state;
  job.ui.chip.textContent = { queued: "Queued", running: "Converting", done: "Done", error: "Failed", cancelled: "Cancelled", handoff: "Use native tool" }[state];
  job.ui.cancel.hidden = !(state === "queued" || state === "running");
}

function setProgress(job, stage, progress) {
  const { ui } = job;
  ui.stage.textContent = STAGE_LABEL[stage] ?? stage;
  // Map stages onto one bar: decode 0–20%, repack 20–25%, lod 25–85%, encode 85–100%.
  // Native jobs install/upload first and decode inside build-lod.
  const spans = job.settings.engine === "native"
    ? { install: [0, 0.05], upload: [0.05, 0.2], decode: [0.2, 0.25], lod: [0.25, 0.88], encode: [0.88, 1] }
    : { decode: [0, 0.2], repack: [0.2, 0.25], lod: [0.25, 0.85], chunk: [0.85, 0.88], encode: [0.88, 1] };
  const span = spans[stage] ?? [0, 1];
  if (progress == null) {
    ui.bar.classList.add("indet");
  } else {
    ui.bar.classList.remove("indet");
    ui.fill.style.width = `${(span[0] + (span[1] - span[0]) * Math.min(1, progress)) * 100}%`;
    if (stage !== "decode" && progress < 1) ui.stage.textContent += ` · ${Math.round(progress * 100)}%`;
    if (stage === "decode" && job.settings.engine === "native") ui.bar.classList.add("indet");
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
    job.resolve = resolve;
    const settings = { ...job.settings, baseName: baseName(job.file.name) };
    if (settings.engine === "native") runNative(job, settings, resolve);
    else startWorker(job, { file: job.file, settings }, resolve);
  });
}

async function runNative(job, settings, resolve) {
  await nativeReady; // a file dropped right after page load must not race the server probe
  const blocker = nativeBlocker(settings, job.file.name);
  if (blocker) {
    fail(job, blocker);
    return resolve();
  }
  if (native.mode === "unsupported") {
    fail(job, "The native tool is available for Windows and macOS only. Switch Engine to Browser.");
    return resolve();
  }
  if (native.mode !== "server") {
    // No local server to run it: hand the job to a one-click converter.
    setState(job, "handoff");
    job.ui.stage.textContent = "Too big for the browser? Run it with the native tool on this computer.";
    showNativeButton(job, "Get the one-click converter…");
    job.ui.native.hidden = false;
    resolve();
    if (!handoff.open) openHandoff(job);
    return;
  }
  const ignored = nativeIgnored(settings);
  appendLog(job, `$ build-lod ${buildLodFlags(settings).join(" ")} "${job.file.name}"`);
  if (ignored.length) appendLog(job, `Note: the native tool ignores ${ignored.join(" and ")}.`);
  const t0 = performance.now();
  const run = runNativeJob(job.file, settings, {
    stage: (stage, progress) => job.state === "running" && setProgress(job, stage, progress),
    log: (line) => appendLog(job, line),
    input: (input) => { job.input = input; },
  });
  job.nativeRun = run;
  try {
    const result = await run.promise;
    if (!result || job.state !== "running") return;
    job.nativeId = result.id;
    const meta = result.meta ?? {};
    job.input ??= { fileType: "input", splatCount: 0, shDegree: meta.maxSh ?? 0 };
    job.processed = { splatCount: meta.count ?? 0, shDegree: meta.maxSh ?? 0, hasLod: Boolean(meta.lodTree) };
    complete(job, {
      files: result.files.map((f) => ({ name: f.name, size: f.size, url: f.url })),
      timings: { total: performance.now() - t0, native: result.seconds * 1000 },
      encoding: meta.splatEncoding ?? null,
    });
  } catch (err) {
    if (err?.name !== "AbortError" && job.state === "running") fail(job, err.message ?? String(err));
  } finally {
    job.nativeRun = null;
    resolve();
  }
}

// Each worker owns one WASM instance. A job may hop to a second, fresh worker
// after decoding ("repack") so the LoD build starts with an unfragmented heap.
function startWorker(job, payload, resolve, transfer = []) {
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  job.worker = worker;
  const finish = () => { worker.terminate(); job.worker = null; resolve(); };
  worker.onerror = (e) => {
    fail(job, e.message || "Worker failed to start (is the page served over http://, not file://?)");
    finish();
  };
  worker.onmessage = ({ data }) => {
    switch (data.type) {
      case "repack": {
        // The old instance's memory is released when its worker terminates.
        worker.terminate();
        const buffers = data.raw.parts.map((p) => p.buffer);
        startWorker(job, { raw: data.raw, settings: payload.settings }, resolve, buffers);
        return;
      }
      case "stage": setProgress(job, data.stage, data.progress); break;
      case "log": appendLog(job, data.line); break;
      case "input": {
        job.input = data.input;
        appendLog(job, `Decoded ${data.input.fileType}: ${fmtCount(data.input.splatCount)} splats, SH degree ${data.input.shDegree}${data.input.hasLod ? ", has LoD tree" : ""}`);
        break;
      }
      case "processed": job.processed = data.processed; break;
      case "warning":
        appendLog(job, `WARNING: ${data.message}`);
        job.ui.error.hidden = false;
        job.ui.error.style.color = "var(--accent)";
        job.ui.error.textContent = data.message;
        showNativeButton(job, "Switch to native engine");
        break;
      case "done": {
        const radName = `${baseName(job.file.name)}${job.processed?.hasLod ? "-lod" : ""}.rad`;
        const files = data.files.map((bytes, i) => ({ name: i === 0 ? radName : data.names[i], size: bytes.byteLength, bytes }));
        complete(job, { files, timings: data.timings, encoding: data.encoding });
        finish();
        break;
      }
      case "error": fail(job, data.message); finish(); break;
    }
  };
  worker.postMessage(payload, transfer);
}

function fail(job, message) {
  setState(job, "error");
  job.ui.bar.classList.remove("indet");
  job.ui.fill.style.width = "100%";
  job.ui.stage.textContent = "";
  job.ui.error.hidden = false;
  job.ui.error.style.color = "";
  job.ui.error.textContent = message;
  appendLog(job, `ERROR: ${message}`);
  if (/^Out of memory/.test(message) && job.settings.engine !== "native") showNativeButton(job, "Retry with native engine");
}

function cancelJob(job) {
  if (job.state === "running" && job.nativeRun) {
    job.nativeRun.cancel();
    job.nativeRun = null;
  }
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

// files: [{ name, size, bytes? , url? }] - browser results carry bytes; native
// results stay on the local server until saved (streamed, never fully in memory).
function complete(job, data) {
  const { ui } = job;
  const files = data.files;
  const radName = files[0].name;
  job.result = { files, radName, base: radName.replace(/\.rad$/i, ""), encoding: data.encoding, timings: data.timings };
  job.finishedAt = new Date();
  const outBytes = files.reduce((n, f) => n + f.size, 0);

  setState(job, "done");
  ui.error.hidden = true; // clear any large-scene warning
  ui.bar.classList.remove("indet");
  ui.fill.style.width = "100%";
  ui.stage.textContent = `${files.length > 1 ? `${radName} + ${files.length - 1} chunk files` : radName}`;

  const p = job.processed, inp = job.input;
  const ratio = outBytes / job.file.size;
  const rows = [
    ["Input", `${formatName(inp.fileType)} · ${fmtCount(inp.splatCount)}`],
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
  ui.native.hidden = true;
  ui.download.hidden = false;
  ui.download.textContent = files.length > 1 ? "Download .zip" : "Download .rad";
  updateSaveButtons(job);
  job.reportPromise = runFileCheck(job);
  if (canPick() && outDir) autoSave(job);
  // Chunked headers reference .radc files by relative name, which can't be
  // resolved from in-memory bytes, so only single-file output is previewable.
  ui.preview.hidden = files.length > 1;
  if (data.encoding) appendLog(job, `Resolved encoding: ${JSON.stringify(data.encoding)}`);
  const t = data.timings;
  appendLog(job, t.native != null
    ? `Timings: native build-lod ${fmtTime(t.native)}, total ${fmtTime(t.total)}`
    : `Timings: decode ${fmtTime(t.decode)}, LoD ${fmtTime(t.lod)}, encode ${fmtTime(t.encode)}`);
}

// Static file check of the result (sampled chunks; native results via Range
// requests to the local server). Shown on the card and written to the log.
async function runFileCheck(job) {
  const { ui } = job;
  const files = job.result.files;
  if (files.length > 1) return; // chunked: chunks referenced by name, checked in the Viewer instead
  try {
    const report = files[0].url ? await radReport({ url: files[0].url }) : await radReport({ bytes: files[0].bytes });
    job.report = report;
    const label = { high: "Will be slow to render", medium: "Heavier than it needs to be", good: "Nothing heavy found" }[report.level];
    $("summary", ui.filecheck).textContent = `File check: ${label}`;
    ui.filecheck.dataset.level = report.level;
    $(".filecheck-body", ui.filecheck).replaceChildren(...report.findings.map((f) => {
      const p = document.createElement("p");
      p.className = `finding ${f.level}`;
      p.innerHTML = "<strong></strong> <span></span>";
      p.firstChild.textContent = f.title;
      p.lastChild.textContent = f.detail;
      return p;
    }));
    ui.filecheck.hidden = false;
    appendLog(job, `File check: ${label}`);
  } catch (err) {
    console.warn("File check failed", err);
  }
}

async function fileBytes(file) {
  if (file.bytes) return file.bytes;
  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`Couldn't read ${file.name} from the native engine (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

// Write a result file through a FileSystemWritableFileStream, streaming
// native results straight from the local server.
async function writeResult(writable, file) {
  if (file.bytes) {
    await writable.write(file.bytes);
    await writable.close();
    return;
  }
  const res = await fetch(file.url);
  if (!res.ok) {
    await writable.abort();
    throw new Error(`Couldn't read ${file.name} from the native engine (${res.status})`);
  }
  await res.body.pipeTo(writable); // closes the writable when done
}

async function downloadJob(job) {
  const { files, radName, base } = job.result;
  if (files.length === 1) {
    if (files[0].url) {
      // Served with Content-Disposition, so the browser saves it without loading it into the page.
      const a = Object.assign(document.createElement("a"), { href: files[0].url, download: radName });
      document.body.append(a);
      a.click();
      a.remove();
    } else {
      download(new Blob([files[0].bytes], { type: "application/octet-stream" }), radName);
    }
    const log = logFile(job, radName);
    setTimeout(() => download(new Blob([log.bytes], { type: "text/plain" }), log.name), 400);
    return;
  }
  job.ui.download.disabled = true;
  try {
    const { zipSync } = await import("fflate");
    const entries = {};
    // Chunks are already deflate-compressed per property; store without recompressing.
    for (const f of files) entries[f.name] = [await fileBytes(f), { level: 0 }];
    const log = logFile(job, radName);
    entries[log.name] = log.bytes;
    download(new Blob([zipSync(entries)], { type: "application/zip" }), `${base}-rad.zip`);
  } finally {
    job.ui.download.disabled = false;
  }
}

$("#clear-done").addEventListener("click", () => {
  for (const job of [...jobs]) {
    if (["done", "error", "cancelled", "handoff"].includes(job.state)) {
      discardNativeJob(job.nativeId);
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
// Some browsers expose the pickers but refuse to write to disk (embedded
// browsers, Brave, enterprise policy). Once that happens, use downloads.
let fsBlocked = false;
const canPick = () => FS && !fsBlocked;
const isBlocked = (err) => err?.name === "NotAllowedError" || err?.name === "SecurityError";

function updateSaveButtons(job) {
  if (!job.result) return;
  job.ui.save.hidden = !canPick();
  job.ui.download.classList.toggle("primary", !canPick());
}

// Make sure we may write through a handle, asking the user if needed.
async function ensureWritable(handle) {
  const opts = { mode: "readwrite" };
  if (!handle.queryPermission || (await handle.queryPermission(opts)) === "granted") return;
  if ((await handle.requestPermission(opts)) !== "granted") {
    throw new DOMException("Permission to write there was not granted", "NotAllowedError");
  }
}

// Writing was refused: remember that, switch the UI to downloads, and
// download this result so the conversion isn't lost.
function fallBackToDownload(job, err) {
  fsBlocked = true;
  outDir = pendingDir = null;
  renderFolder();
  for (const j of jobs) updateSaveButtons(j);
  downloadJob(job);
  showSaved(
    job,
    `This browser wouldn't let the page write to the location you picked (${err.message}), so the file was downloaded to your Downloads folder instead. Desktop Chrome or Edge can save straight to a folder you choose.`,
    true,
  );
}

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
  if (!canPick()) {
    name.parentElement.classList.remove("set");
    name.textContent = "Your Downloads folder";
    for (const id of ["#pick-folder", "#reconnect-folder", "#clear-folder"]) $(id).hidden = true;
    $("#save-hint").textContent = fsBlocked
      ? "This browser blocked saving to a chosen location, so results download normally. Open the page in desktop Chrome or Edge to pick a folder."
      : "Choosing a save location needs Chrome, Edge or another Chromium browser. In this browser, results download normally.";
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

async function writeFile(dir, name, file) {
  const fh = await dir.getFileHandle(name, { create: true });
  await writeResult(await fh.createWritable(), file);
}

// Chunked output is a .rad header plus .radc chunks it references by name;
// keep them together in their own subfolder.
async function writeChunked(dir, job) {
  const { files, base } = job.result;
  const sub = await dir.getDirectoryHandle(await freeName(dir, base, "dir"), { create: true });
  for (const f of files) await writeFile(sub, f.name, f);
  const log = logFile(job, job.result.radName);
  await writeFile(sub, log.name, log);
  return `${dir.name}/${sub.name}/ (${files.length} files + log)`;
}

// Single .rad plus its log, never overwriting existing files.
async function writeSingle(dir, job) {
  const name = await freeName(dir, job.result.radName, "file");
  await writeFile(dir, name, job.result.files[0]);
  const log = logFile(job, name);
  await writeFile(dir, await freeName(dir, log.name, "file"), log);
  return `${dir.name}/${name} (+ ${log.name})`;
}

function showSaved(job, text, isError = false) {
  const el = job.ui.saved;
  el.hidden = false;
  el.style.color = isError ? "var(--err)" : "";
  el.textContent = text;
}

async function autoSave(job) {
  try {
    await job.reportPromise; // so the saved log includes the file check
    await ensureWritable(outDir);
    job.savedTo = job.result.files.length > 1 ? await writeChunked(outDir, job) : await writeSingle(outDir, job);
    showSaved(job, `Saved to ${job.savedTo}`);
  } catch (err) {
    if (isBlocked(err)) fallBackToDownload(job, err);
    else showSaved(job, `Couldn't save to ${outDir?.name}: ${err.message}. Use “Save to folder…” or Download instead.`, true);
  }
}

// "Save to folder…": a folder dialog rather than a save-file dialog, because a
// file dialog only grants access to that one file and the log goes next to it.
async function saveJobAs(job) {
  try {
    const dir = await window.showDirectoryPicker({ id: "rad-output", mode: "readwrite", startIn: outDir ?? "downloads" });
    await ensureWritable(dir);
    job.savedTo = job.result.files.length > 1 ? await writeChunked(dir, job) : await writeSingle(dir, job);
    showSaved(job, `Saved to ${job.savedTo}`);
  } catch (err) {
    if (err.name === "AbortError") return; // user closed the dialog
    if (isBlocked(err)) fallBackToDownload(job, err);
    else showSaved(job, `Save failed: ${err.message}`, true);
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
let viewer = null; // { view, mesh, box, flipped, job }

async function openPreview(job) {
  const status = $("#viewer-status");
  $("#viewer-title").textContent = job.result.radName;
  status.textContent = "Loading viewer…";
  dialog.showModal();
  try {
    viewer ??= { view: await createSplatView($("#viewer-canvas")), mesh: null, box: null, flipped: true };
    const { view } = viewer;
    if (viewer.mesh) { view.scene.remove(viewer.mesh); viewer.mesh.dispose?.(); viewer.mesh = null; }
    status.textContent = "Loading splats…";

    const bytes = await fileBytes(job.result.files[0]);
    const mesh = new view.spark.SplatMesh({ fileBytes: bytes.slice(), fileName: job.result.radName });
    viewer.mesh = mesh;
    setFlipped(mesh, viewer.flipped);
    view.scene.add(mesh);
    await mesh.initialized;

    // Browser results carry robust bounds from the converter; native results
    // are sampled from the file's own (LoD) splats.
    const b = job.processed.bounds;
    viewer.job = job;
    viewer.box = b
      ? new view.THREE.Box3(new view.THREE.Vector3(...b.min), new view.THREE.Vector3(...b.max))
      : await meshBounds(view, mesh);
    if (!viewer.box) throw new Error("The file contains no splats to show");
    view.frame(worldBox(view, mesh, viewer.box));
    status.textContent = `${fmtCount(job.processed.splatCount)} splats${job.processed.hasLod ? " · LoD active" : ""}`;
    view.start();
  } catch (err) {
    status.textContent = `Preview failed: ${err.message ?? err}`;
    console.error(err);
  }
}

$("#viewer-flip").addEventListener("click", () => {
  if (!viewer?.mesh) return;
  viewer.flipped = !viewer.flipped;
  setFlipped(viewer.mesh, viewer.flipped);
  viewer.view.frame(worldBox(viewer.view, viewer.mesh, viewer.box));
});
$("#viewer-measure").addEventListener("click", async () => {
  if (!viewer?.mesh || !viewer.box) return;
  const btn = $("#viewer-measure");
  const status = $("#viewer-status");
  const before = status.textContent;
  btn.disabled = true;
  try {
    const r = await benchmark(viewer.view, worldBox(viewer.view, viewer.mesh, viewer.box), {
      meshes: [viewer.mesh],
      onStep: (text, p) => { status.textContent = `${text}${p ? ` · ${Math.round(p * 100)}%` : ""}…`; },
    });
    const c = viewer.view.renderer.domElement;
    const fmt = (g) => `${g.fps.toFixed(0)} fps (dips ${g.worst.toFixed(0)})`;
    const where = r.probe.capped
      ? `none, it runs at the display's ${r.refresh.toFixed(0)} Hz refresh rate`
      : r.probe.fillBound ? "pixels (overdraw): a lower render resolution helps most" : "splat count: a lower LoD detail helps most";
    const summary = `Outside ${fmt(r.outside)} · inside ${fmt(r.inside)} at ${c.width}×${c.height} px · bottleneck: ${where}`;
    status.textContent = summary;
    if (viewer.job) {
      viewer.job.benchmark = [
        `Canvas:              ${c.width}x${c.height} px, display ${r.refresh.toFixed(0)} Hz`,
        `Outside views:       ${r.outside.fps.toFixed(0)} fps, dips ${r.outside.worst.toFixed(0)} fps, ${(r.outside.splats / 1e6).toFixed(2)}M splats drawn`,
        `Inside views:        ${r.inside.fps.toFixed(0)} fps, dips ${r.inside.worst.toFixed(0)} fps, ${(r.inside.splats / 1e6).toFixed(2)}M splats drawn`,
        `Bottleneck:          ${where} (slowest view ${r.probe.full.toFixed(0)} fps, ${r.probe.half.toFixed(0)} fps at half resolution)`,
      ];
      appendLog(viewer.job, `Measured: ${summary}`);
    }
  } catch (err) {
    status.textContent = `Measurement failed: ${err.message ?? err}`;
    console.error(err);
    setTimeout(() => (status.textContent = before), 4000);
  } finally {
    btn.disabled = false;
  }
});
$("#viewer-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  if (!viewer) return;
  viewer.view.stop();
  if (viewer.mesh) { viewer.view.scene.remove(viewer.mesh); viewer.mesh.dispose?.(); viewer.mesh = null; }
});

// ---------- native hand-off (page not opened through the launcher) ----------

const handoff = $("#handoff");

async function openHandoff(job) {
  const settings = job.settings;
  const os = detectOS() === "mac" ? "mac" : "windows";
  const fileName = job.file.name;
  $("#handoff-file").textContent = fileName;
  $("#handoff-output").textContent = nativeOutputName(fileName);
  const published = binariesPublished();
  $("#handoff-unpublished").hidden = published;
  $("#handoff-steps").hidden = !published;

  const render = (target) => {
    for (const tab of handoff.querySelectorAll("[data-os]")) tab.setAttribute("aria-selected", String(tab.dataset.os === target));
    $("#handoff-win").hidden = target !== "windows";
    $("#handoff-mac").hidden = target !== "mac";
    const cmd = terminalCommands(target, settings, fileName);
    $("#handoff-shell").textContent = cmd.shell;
    $("#handoff-install").textContent = cmd.install;
    $("#handoff-run").textContent = cmd.run;
    const btn = $("#handoff-download");
    btn.textContent = target === "windows" ? "Download converter for Windows" : "Download converter for Mac";
    btn.onclick = async () => {
      const script = await oneClickScript(target, settings, fileName);
      download(script.blob, script.name);
    };
  };
  for (const tab of handoff.querySelectorAll("[data-os]")) tab.onclick = () => render(tab.dataset.os);
  render(os);

  const ignored = nativeIgnored(settings);
  $("#handoff-ignored").hidden = !ignored.length;
  $("#handoff-ignored").textContent = ignored.length ? `Note: the native tool ignores ${ignored.join(" and ")}.` : "";
  handoff.showModal();
}

for (const btn of document.querySelectorAll("#handoff [data-copy]")) {
  btn.addEventListener("click", async () => {
    const text = $(btn.dataset.copy).textContent;
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy"), 1500);
    } catch {
      alert(text);
    }
  });
}
$("#handoff-close").addEventListener("click", () => handoff.close());

nativeReady.then(() => {
  document.body.dataset.native = native.mode;
  updateHints();
});
