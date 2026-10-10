// Runs one conversion in isolation. The page spawns a fresh worker per file so
// each job gets a clean WASM heap (freed on terminate) and can be cancelled.
import init, { RadConverter } from "./pkg/rad_wasm.js";

const ready = init();

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

    stage = "encode";
    post({ type: "stage", stage, progress: null });
    const t2 = performance.now();
    // Chunk files are referenced from the header by name, so they must be
    // named for the final output: <base>[-lod]-<n>.radc
    const outBase = `${settings.baseName}${processed.hasLod ? "-lod" : ""}`;
    const encodeOptions = { ...settings.encode, chunkPrefix: settings.chunked ? `${outBase}-` : undefined };
    const result = conv.encode(encodeOptions, log);
    conv.free();
    timings.encode = performance.now() - t2;
    timings.total = performance.now() - t0;

    const buffers = result.files.map((f) => f.buffer);
    post({ type: "done", files: result.files, names: result.names, encoding: result.encoding, timings }, buffers);
  } catch (err) {
    let message = err?.message ?? String(err);
    if (err instanceof WebAssembly.RuntimeError) {
      message = lastPanic ?? message;
      if (/memory|alloc/i.test(message)) message += " (the scene may be too large for browser memory; try Compact precision or a lower SH degree)";
    }
    post({ type: "error", stage, message });
  }
};
