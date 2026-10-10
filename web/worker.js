// Runs one conversion in isolation. The page spawns a fresh worker per file so
// each job gets a clean WASM heap (freed on terminate) and can be cancelled.
import init, { RadConverter } from "./pkg/rad_wasm.js";

const ready = init();
let wasmExports = null;
ready.then((exports) => { wasmExports = exports; });

// WASM linear memory only grows, so its current size is the job's peak usage.
const memoryMB = () => (wasmExports ? wasmExports.memory.buffer.byteLength / 2 ** 20 : 0);
const MEMORY_LIMIT_MB = 4096;
// Measured peak MB per million input splats (SH0 scene), by precision/LoD.
const MB_PER_MILLION = {
  "standard/quality": 255, "standard/quick": 235,
  "compact/quality": 230, "compact/quick": 180,
};

const post = (msg, transfer) => self.postMessage(msg, transfer ?? []);

// Rust panics surface as an opaque "unreachable" trap; the panic hook writes
// the real message to console.error first, so keep the last one around.
let lastPanic = null;
const consoleError = console.error.bind(console);
console.error = (...args) => {
  lastPanic = args.map(String).join(" ");
  consoleError(...args);
};

self.onmessage = async (event) => {
  const { file, settings } = event.data;
  const t0 = performance.now();
  const timings = {};
  let stage = "load";
  try {
    await ready;

    stage = "decode";
    post({ type: "stage", stage, progress: 0 });
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
        post({ type: "stage", stage, progress: read / file.size });
      }
    }
    const input = conv.finish();
    timings.decode = performance.now() - t0;
    post({ type: "input", input });
    post({ type: "log", line: `Memory after decode: ${memoryMB().toFixed(0)} MB of ${MEMORY_LIMIT_MB} MB` });
    const perMillion = MB_PER_MILLION[`${settings.compact ? "compact" : "standard"}/${settings.process.lod}`];
    if (perMillion) {
      const estimate = (input.splatCount / 1e6) * perMillion + file.size / 2 ** 20;
      if (estimate > MEMORY_LIMIT_MB * 0.9) {
        post({
          type: "warning",
          message: `Large scene: ${(input.splatCount / 1e6).toFixed(1)}M splats needs roughly ${(estimate / 1024).toFixed(1)} GB with these settings, ` +
            `near or over the browser's 4 GB limit. It may run out of memory; Compact + Quick uses the least.`,
        });
      }
    }

    stage = "lod";
    post({ type: "stage", stage, progress: settings.process.lod === "none" ? 1 : 0 });
    const t1 = performance.now();
    const log = (line) => {
      post({ type: "log", line });
      // bhatt-lod / tiny-lod report "frontier: <done> / <total>" per level
      const m = /frontier: (\d+) \/ (\d+)/.exec(line);
      if (m) post({ type: "stage", stage, progress: Number(m[1]) / Number(m[2]) });
      if (line.startsWith("Ordering LoD tree")) post({ type: "stage", stage: "chunk", progress: null });
    };
    const processed = conv.process(settings.process, log);
    timings.lod = performance.now() - t1;
    post({ type: "processed", processed });
    post({ type: "log", line: `Memory after LoD: ${memoryMB().toFixed(0)} MB of ${MEMORY_LIMIT_MB} MB` });

    stage = "encode";
    post({ type: "stage", stage, progress: null });
    const t2 = performance.now();
    // Chunk files are referenced from the header by name, so they must be
    // named for the final output: <base>[-lod]-<n>.radc
    const outBase = `${settings.baseName}${processed.hasLod ? "-lod" : ""}`;
    const encodeOptions = { ...settings.encode, chunkPrefix: settings.chunked ? `${outBase}-` : undefined };
    const result = conv.encode(encodeOptions, log);
    conv.free();
    post({ type: "log", line: `Peak memory: ${memoryMB().toFixed(0)} MB of ${MEMORY_LIMIT_MB} MB` });
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
          `during ${stage === "lod" ? "LoD building" : stage}. Try Working precision: Compact and Level of detail: Quick, ` +
          `crop the scene (Advanced), or use Spark's native build-lod tool. Scenes much above ~15M splats ` +
          `usually don't fit in browser memory.`;
      } else {
        message = lastPanic;
      }
    }
    post({ type: "error", stage, message });
  }
};
