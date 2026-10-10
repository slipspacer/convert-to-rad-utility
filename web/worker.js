// Runs one conversion in isolation. The page spawns a fresh worker per file so
// each job gets a clean WASM heap (freed on terminate) and can be cancelled.
//
// Large or memory-hungry inputs take two workers: the first decodes and
// exports the splats as raw batches ("repack"), the page terminates it to
// release its heap, and a second worker imports them into fresh memory with
// the full LoD tree pre-allocated, then builds and encodes. WASM memory never
// shrinks, so this is the only way to shed a decoder's transient footprint
// (SOG holds the whole zip plus unpacked images and per-property arrays).
import init, { RadConverter } from "./pkg/rad_wasm.js";

const ready = init();
let wasmExports = null;
ready.then((exports) => { wasmExports = exports; });

// WASM linear memory only grows, so its current size is the job's peak usage.
const memoryMB = () => (wasmExports ? wasmExports.memory.buffer.byteLength / 2 ** 20 : 0);
const MEMORY_LIMIT_MB = 4096;
// Peak MB per million input splats (SH degree 0), measured on a 24M-splat
// scene: compact/quick peaked at 3.97 GB; the others ran out above 3.9-4.1 GB.
const MB_PER_MILLION = {
  "standard/quality": 190, "standard/quick": 180,
  "compact/quality": 175, "compact/quick": 165,
};
// Repack when decoding left this much more memory than the splats need, or
// for scenes big enough that a clean heap matters regardless of format.
const REPACK_BLOAT_MB = 512;
const REPACK_MIN_SPLATS = 4_000_000;
const RAW_BATCH = 1 << 20;

const post = (msg, transfer) => self.postMessage(msg, transfer ?? []);
const log = (line) => post({ type: "log", line });
const mem = () => `${memoryMB().toFixed(0)} MB of ${MEMORY_LIMIT_MB} MB`;

// Rust panics surface as an opaque "unreachable" trap; the panic hook writes
// the real message to console.error first, so keep the last one around.
let lastPanic = null;
const consoleError = console.error.bind(console);
console.error = (...args) => {
  lastPanic = args.map(String).join(" ");
  consoleError(...args);
};

async function decodeFile(file, settings) {
  post({ type: "stage", stage: "decode", progress: 0 });
  const conv = new RadConverter(file.name, settings.compact, settings.fileType || undefined);
  const reader = file.stream().getReader();
  let read = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    conv.push(value);
    read += value.byteLength;
    const now = performance.now();
    if (now - lastReport > 100) {
      lastReport = now;
      post({ type: "stage", stage: "decode", progress: read / file.size });
    }
  }
  const input = conv.finish();
  post({ type: "input", input });
  log(`Memory after decode: ${mem()}`);
  return { conv, input };
}

function shouldRepack(input, settings) {
  if (input.hasLod || settings.repack === "off") return false;
  if (settings.repack === "always") return true;
  const bloat = memoryMB() - input.rawBytes / 2 ** 20;
  return input.splatCount >= REPACK_MIN_SPLATS || bloat > REPACK_BLOAT_MB;
}

function exportRaw(conv, input, elapsedMs) {
  log("Moving decoded splats into fresh memory before building the LoD tree");
  const header = conv.rawHeader();
  const parts = [];
  for (let base = 0; base < input.splatCount; base += RAW_BATCH) {
    const count = Math.min(RAW_BATCH, input.splatCount - base);
    parts.push({ count, buffer: conv.exportRaw(base, count).buffer });
    post({ type: "stage", stage: "repack", progress: (0.5 * (base + count)) / input.splatCount });
  }
  conv.free();
  const raw = { header, parts, input, elapsedMs };
  post({ type: "repack", raw }, parts.map((p) => p.buffer));
}

function importRaw(raw, settings) {
  const conv = RadConverter.fromRaw(settings.compact, raw.header, settings.process.lod);
  log(`Reserved memory for the LoD tree: ${mem()}`);
  let base = 0;
  for (const part of raw.parts) {
    conv.pushRaw(base, part.count, new Uint8Array(part.buffer));
    part.buffer = null; // let the JS copy be collected
    base += part.count;
    post({ type: "stage", stage: "repack", progress: 0.5 + (0.5 * base) / raw.input.splatCount });
  }
  log(`Memory after moving splats: ${mem()}`);
  return conv;
}

function warnIfTooLarge(input, settings) {
  const perMillion = MB_PER_MILLION[`${settings.compact ? "compact" : "standard"}/${settings.process.lod}`];
  if (!perMillion) return;
  const estimate = (input.splatCount / 1e6) * perMillion * (1 + input.shDegree * 0.4);
  if (estimate > MEMORY_LIMIT_MB * 0.9) {
    post({
      type: "warning",
      message: `Large scene: ${(input.splatCount / 1e6).toFixed(1)}M splats needs roughly ${(estimate / 1024).toFixed(1)} GB with these settings, ` +
        `near or over the browser's 4 GB limit. It may run out of memory; Compact + Quick uses the least.`,
    });
  }
}

self.onmessage = async (event) => {
  const { file, raw, settings } = event.data;
  // A repacked job continues the clock from the first worker.
  const t0 = performance.now() - (raw?.elapsedMs ?? 0);
  const timings = {};
  let stage = "load";
  try {
    await ready;

    let conv, input;
    if (raw) {
      stage = "repack";
      input = raw.input;
      conv = importRaw(raw, settings);
    } else {
      stage = "decode";
      ({ conv, input } = await decodeFile(file, settings));
      if (shouldRepack(input, settings)) {
        stage = "repack";
        exportRaw(conv, input, performance.now() - t0);
        return; // the page continues in a fresh worker
      }
    }
    timings.decode = performance.now() - t0;
    warnIfTooLarge(input, settings);

    stage = "lod";
    post({ type: "stage", stage, progress: settings.process.lod === "none" ? 1 : 0 });
    const t1 = performance.now();
    const lodLog = (line) => {
      log(line);
      // bhatt-lod / tiny-lod report "frontier: <done> / <total>" per level
      const m = /frontier: (\d+) \/ (\d+)/.exec(line);
      if (m) post({ type: "stage", stage, progress: Number(m[1]) / Number(m[2]) });
      if (line.startsWith("Ordering LoD tree")) post({ type: "stage", stage: "chunk", progress: null });
    };
    const processed = conv.process(settings.process, lodLog);
    timings.lod = performance.now() - t1;
    post({ type: "processed", processed });
    log(`Memory after LoD: ${mem()}`);

    stage = "encode";
    post({ type: "stage", stage, progress: null });
    const t2 = performance.now();
    // Chunk files are referenced from the header by name, so they must be
    // named for the final output: <base>[-lod]-<n>.radc
    const outBase = `${settings.baseName}${processed.hasLod ? "-lod" : ""}`;
    const encodeOptions = { ...settings.encode, chunkPrefix: settings.chunked ? `${outBase}-` : undefined };
    const result = conv.encode(encodeOptions, lodLog);
    conv.free();
    log(`Peak memory: ${mem()}`);
    timings.encode = performance.now() - t2;
    timings.total = performance.now() - t0;

    const buffers = result.files.map((f) => f.buffer);
    post({ type: "done", files: result.files, names: result.names, encoding: result.encoding, timings }, buffers);
  } catch (err) {
    let message = err?.message ?? String(err);
    if (err instanceof WebAssembly.RuntimeError) {
      // A failed allocation aborts without a panic message (Rust's OOM report
      // goes to stderr, which doesn't exist here), leaving a bare "unreachable".
      const mb = memoryMB();
      if (lastPanic == null || /memory|alloc|capacity/i.test(lastPanic)) {
        message =
          `Out of memory: used ${mb.toFixed(0)} MB of the browser's ${MEMORY_LIMIT_MB} MB WebAssembly limit ` +
          `during ${{ lod: "LoD building", repack: "the move to fresh memory" }[stage] ?? stage}. ` +
          `Try Working precision: Compact and Level of detail: Quick, crop the scene (Advanced), ` +
          `or use Spark's native build-lod tool for scenes this large.`;
      } else {
        message = lastPanic;
      }
    }
    post({ type: "error", stage, message });
  }
};
