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

**Windows:** double-click **`Start RAD Converter.bat`**. Same behavior as the macOS launcher below;
it needs Python 3 from [python.org](https://www.python.org/downloads/). If Windows SmartScreen warns
on first launch, choose **More info** → **Run anyway**.

**macOS:** double-click **`Start RAD Converter.command`** in Finder. It starts a local server (on
port 8090, or the next free one) and opens the converter in Chrome or Edge if installed, otherwise
your default browser. Keep the Terminal window open while you use it; close it to stop. If you
downloaded the repo as a ZIP instead of cloning it, macOS may block the first launch: right-click
the file → **Open** → **Open**.

**Manually:** `web/pkg` ships prebuilt. Run the local server (module workers don't run from
`file://`):

```bash
# Windows
py serve.py
# macOS / Linux
python3 serve.py
```

Then open http://localhost:8090. Any static host (GitHub Pages, Netlify, S3…) or
`python -m http.server -d web` also works. Without `serve.py`, the native engine falls back to
one-click converters (see below).

## Native engine (scenes too big for the browser)

Browser WebAssembly is limited to 4 GB of memory. For bigger scenes, set **Engine: Native**, or
click **Switch to native engine** or **Retry with native engine** on a job. The same conversion
then runs in Spark's native `build-lod` tool, which has no memory limit.

- **Opened with the launcher (or `serve.py`):** the app runs `build-lod` for you. On first use,
  `serve.py` downloads the tool for your platform (Windows x64, or macOS universal for Apple Silicon
  and Intel) from this repo's releases and checks it against the SHA-256 in
  `web/native/manifest.json`. The file is sent to the local server only, never off your computer.
  Progress, the log and saving work just as for browser jobs.
- **Opened any other way:** the job offers a **one-click converter**. On Windows this is a `.bat`;
  on Mac, a zipped `.command`. It's preset with your settings and the file name. Put it next to
  the splat file and double-click it. It downloads and verifies the tool on first use, converts,
  and then shows the `.rad`. The dialog also shows the exact command for terminal users.

| App setting | `build-lod` flag |
|---|---|
| Level of detail: Quality / Quick | `--quality` / `--quick` |
| LoD base | `--bhatt-lod=<b>` / `--tiny-lod=<b>` |
| Working precision: Compact | `--csplat` |
| Spherical harmonics limit | `--max-sh=N` |
| Output: Single / Chunked | `--rad` / `--rad-chunked` |
| Crop min / max / sphere | `--min-box=x,y,z` / `--max-box=x,y,z` / `--within-dist=x,y,z,r` |
| Inflate | `--inflate` |

`build-lod` always builds an LoD tree. It can't do "None", per-property encodings, or a forced
input format, and it rejects files containing NaN splats (the browser engine drops those).

The binaries are built by `.github/workflows/build-lod.yml` from the same pinned Spark commit as
`rad-wasm`. To use your own build instead, set `RAD_BUILD_LOD=/path/to/build-lod` before starting
`serve.py`.

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

- **Browser engine memory is capped at 4 GB** (a WebAssembly limit). Spark's LoD build is the
  bottleneck. Results for 23–24M-splat scenes with SH degree 0:

  | Settings | Browser engine | Native engine |
  |---|---|---|
  | Compact + Quick | ✅ fits (peak ~3.97 GB, about 2.5 minutes) | ✅ |
  | Standard + Quick | ❌ runs out of memory in the final reorder | ✅ |
  | Standard + Quality | ❌ finishes merging but runs out of memory while pruning | ✅ 8–22 minutes, ~4 GB RAM |

  As a rule of thumb, the browser engine handles roughly 24M splats with Compact + Quick, and
  noticeably fewer with Standard or Quality. Higher SH degrees need proportionally more memory.
  After decoding, the converter warns if a scene looks too big and offers **Switch to native
  engine**. Out-of-memory failures offer **Retry with native engine**.
- **The native engine has no memory cap**, only your computer's RAM. Real example: `trogir.ply`
  (23.1M splats, Standard + Quality) took 8.4 minutes and peaked at about 4 GB of RAM. It produced
  33.7M splats with the LoD tree, a 595 MB `.rad`. Plan on roughly 2× the input file size in free
  RAM for Quality builds.
  - **One-click needs the launcher.** The native engine needs **Start RAD Converter** (or
    `serve.py`) for in-app conversion. Otherwise it falls back to one-click converters, which need
    an internet connection on first use to download `build-lod`.
  - **Not every setting carries over.** It can't do LoD "None", per-property encodings or a
    forced input format. RAD inputs that already have an LoD tree stay in the browser engine.
  - **It refuses invalid splats.** Spark's `build-lod` rejects files with NaN splats, which the
    browser engine silently drops. Convert those in the browser, or clean the file first.
  - **Output can differ very slightly.** The native and browser engines produce the same format
    and encodings, but floating-point rounding differs between builds, so the LoD tree can vary by
    a few hundredths of a percent in splat count.
  - **Mac is unverified on real hardware.** The Mac launcher, native binary and one-click converter
    are built and tested on Windows. Report anything odd.
- **Large or compressed inputs are moved to fresh memory before the LoD build.** WebAssembly
  memory never shrinks, and some decoders use a lot of temporary space. Reading a SOG uses about
  3× the memory of the same scene as a PLY. So after decoding, the converter copies the splats
  exactly into a new worker, with the whole LoD tree's storage reserved up front. The output is
  byte-identical either way. This is controlled by **Advanced → Low-memory mode**.
- The in-page preview only works for single-file output. Chunked headers point to `.radc` files by
  relative name, and those names can't be resolved from in-memory bytes.
