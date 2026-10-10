# RAD Converter (web)

A browser utility that converts Gaussian splat files into [Spark](https://github.com/sparkjsdev/spark)'s
streamable **RAD** format, with a prebuilt level-of-detail (LoD) tree. Conversion runs locally in a
Web Worker via WebAssembly, so files are never uploaded.

**Inputs:** `.ply` (standard 3DGS and PlayCanvas compressed), `.spz`, `.splat`, `.ksplat`,
`.sog` / SOGS `.zip`, `.rad` (rebuilds the LoD tree).
**Outputs:** a single `.rad` file, or chunked output (`.rad` header + `.radc` chunks) for
`paged: true` streaming.

## Workflow

1. **Open** one or more splat files by clicking the drop zone or dragging files onto it.
2. **Change settings:** level of detail (Quality / Quick / None), single or chunked output, working
   precision, and SH degree. Advanced adds per-property encodings, cropping and the LoD base.
3. **Choose where results are saved:**
   - **Choose output folder…** saves every converted file there automatically and never overwrites
     an existing file (a second copy becomes `scene-lod (2).rad`). The folder is remembered between
     visits; after a reload the browser may ask you to **Allow access** again.
   - Without a folder, click **Save as…** on a finished result to pick the location and file name
     in the system dialog.
   - Chunked results are written as a subfolder, `scene-lod/`, holding the `.rad` header and its
     `.radc` chunks.

Picking a save location uses the File System Access API (Chrome, Edge and other Chromium
browsers). Firefox and Safari fall back to normal downloads, with chunked output zipped.

## Run

`web/pkg` ships prebuilt, so you only need a static server (module workers don't run from `file://`):

```bash
py -m http.server 8090 -d web
```

Then open http://localhost:8090. Any static host works (GitHub Pages, Netlify, S3…).

## How it works

`rad-wasm/` is a small Rust crate around Spark's own `spark-lib` (pinned to commit `c57ebb9`). It
runs the same steps as Spark's `build-lod` CLI:

1. Decode the input (format is auto-detected).
2. Drop non-finite and empty splats, then apply the optional SH clamp and crop.
3. Build the LoD tree: `bhatt-lod` (Quality, base 1.75) or `tiny-lod` (Quick, base 1.5), or skip it.
4. Run `chunk_tree` ordering and LoD opacity encoding.
5. Run `RadEncoder` with auto-resolved property encodings, or your overrides under Advanced.

**Parity:** compiled natively, this wrapper's output is byte-identical to `build-lod --quick` and
`--quality`. You can check this with the ignored `parity` test in `rad-wasm/src/lib.rs`.

The WebAssembly build can differ slightly from native, by about 0.002% in LoD splat count.
WebAssembly's float math functions round slightly differently from native x86, and the greedy LoD
merge is sensitive to near-ties. Spark loads and renders both versions the same way.

**Not included vs. the CLI:** `--cluster-sh` (SH codebook clustering). Its timing code uses
`std::time::Instant`, which panics on `wasm32-unknown-unknown`.

## Using the output

```js
const splats = new SplatMesh({ url: "scene-lod.rad" });              // single file
const streamed = new SplatMesh({ url: "scene-lod.rad", paged: true }); // chunked: host .rad + .radc together
```

## Rebuilding the WASM

You need [rustup](https://rustup.rs). The scripts add the `wasm32-unknown-unknown` target and
install `wasm-bindgen-cli` 0.2.117 if they are missing.

```powershell
./build.ps1
```

```bash
./build.sh
```

## Limits

- The browser WASM heap tops out at 4 GB. Scenes up to a few million splats are fine. For larger
  ones, use **Compact** precision or a lower SH degree, or the native `build-lod` CLI.
- The in-page preview only works for single-file output. Chunked headers point to `.radc` files by
  relative name, and those names can't be resolved from in-memory bytes.
