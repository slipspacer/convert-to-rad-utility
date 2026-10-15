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
   - Without a folder, click **Save to folder…** on a finished result to pick where it goes.
   - **Every save includes a log**, e.g. `trogir-lod.log.txt` next to `trogir-lod.rad`, also inside
     chunked folders and zips. Its header records the input file and type, the output, the engine
     (and exact `build-lod` command for native jobs) and every setting. The full conversion log
     follows, for later evaluation.
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

The default output, a single `.rad`, is all you need: the header and every chunk are in one file,
with no separate metadata file. Stream it:

```js
const splats = new SplatMesh({ url: "scene-lod.rad", paged: true });
scene.add(splats);
```

With `paged: true`, Spark reads the header, then fetches only the 64K-splat chunks the current view
needs, coarsest first. A rough version appears almost immediately and detail fills in as you move.
Without `paged`, `new SplatMesh({ url })` downloads the whole file before showing anything.

### Viewer

`viewer.html`, the **Open the Viewer** button on the converter, is a standalone Spark viewer for
checking results:

- **Open or drop files:** `.rad` (with its LoD tree), `.spz`, `.ply`, `.splat`, `.ksplat` or
  `.sog`. Several files can share one scene, mixing formats, exactly as a site using Spark would
  load them. Each object can be hidden, flipped (many captures are Y-down) or framed. **LoD for
  non-RAD files** builds a Quick LoD tree in the browser for the others, so they join the shared
  splat budget.
- **Stream from a URL:** paste a `.rad` URL and press **Stream**. The file loads with
  `paged: true`, using the same Range requests a production page makes, which makes this a quick
  way to check a host (see the hosting requirements below). Linking to
  `viewer.html?url=https://host/scene-lod.rad` streams that file on open.
- **Fast opening:** a `.rad` with an LoD tree is shown the way a website streams it. Coarse
  detail appears first and only the chunks in view are decoded, instead of decoding the whole
  file before the first frame. That applies to local files (read from memory), URLs, and the
  converter's **Preview**, which streams native-engine results from the launcher's local server.
- **Controls:** **Orbit** (drag, right-drag to pan, scroll to zoom) or **Fly** (WASD to move, R/F
  up and down, Q/E to turn left and right, drag to look, Shift faster, Ctrl slower, `-` / `=`
  speed). Pressing any of those keys while orbiting switches to Fly. Fly speed scales with the
  scene: 1× is 5% of the scene's size per second, and the **Speed** slider sets 1/16× to 8×. The converter's Preview has the same controls. **Detail** sets
  the LoD splat budget from 0.25× to 4× (`SparkRenderer.lodSplatScale`).
- **Limits:** local files are still read whole into the page's memory (only decoding is on
  demand), so very large files use a lot of browser memory. For those, stream from a URL.

### Performance evaluation

There are two checks, available both after converting and when loading in the Viewer.

**File check (instant).** It reads the header plus up to 24 chunks spread through the file, from
memory or via Range requests. It reports:
- **Splat counts:** scene splats versus the LoD tree's merged parent splats.
- **LoD:** whether the file has an LoD tree.
- **SH degree.**
- **Nearly invisible splats:** the share under 5% opacity.
- **Large splats:** the share bigger than 1% of the scene.

Findings come with plain-language fixes. In the converter it appears on the job card and in the
saved `.log.txt`. In the Viewer it's the **File check** button on each object.

**Measure (about 20 seconds, on your device).** This is in the Viewer's Performance panel and in
the converter's Preview. It times a fixed camera tour: 6 views from outside the scene and 6
looking around from its centre. It reports average fps, typical dips and splats drawn, and
compares them with your display's refresh rate. It then re-times the slowest view at half
resolution to find the bottleneck:
- **Pixels (overdraw):** splats are large on screen and stack up. Lower **Resolution** (75% or 50%)
  helps most.
- **Splat count:** lower **Detail** (the LoD splat budget) helps most.

What actually drives speed, measured on the test set at 1920×1080: with LoD, Spark draws about
2.5M splats per frame regardless of file size. The difference between scenes is how much screen
those splats cover from the camera.

| Scene | Outside | Inside | Note |
|---|---|---|---|
| trogir (SH 0, 33.7M splats) | 215 fps | 179 fps | Tiny on-screen splats |
| LostPlace (SH 3, 7.2M splats) | 76 fps | 92 fps | Overdraw-bound: 72 → 180 fps at half resolution |

**SH degree 3 didn't change LostPlace's frame rate** (76/92 with SH off as well). SH mainly costs
file size and memory. Results depend on window size and GPU, so always measure on the target
device and window size.

Full measurements, per-file analysis and next steps: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

### Scenes with several splat files (including mixed SOG + RAD)

A scene can hold any number of splat files, and formats can be mixed. Each file is its own
`SplatMesh`, and Spark sorts and blends all the splats together whatever format they came from.
Combining many RAD files into one world is one of Spark 2's headline features. Its `multi-lod`
example streams 100 separate `.rad` files, each with `paged: true`, in one scene.

How the formats behave side by side:

- **RAD meshes (with LoD) share one splat budget.** Spark spends a fixed number of splats per
  frame across *all* LoD meshes, about 2.5M on desktop and fewer on mobile
  (`SparkRenderer.lodSplatCount` / `lodSplatScale`). Detail goes to whatever is close and in view.
  Paged RADs also share one streaming pool (`SparkRenderer.maxPagedSplats`).
- **SOG (or PLY, SPZ…) meshes without LoD render every splat, every frame,** outside that budget.
  A small SOG prop is fine. A large one costs its full splat count on top of the budget, and
  that's where frame rates drop.
- **A SOG can join the shared budget** if you load it with `lod: true`. Spark then builds a Quick
  LoD tree in the browser at load time (about 1–3 s per million splats):
  `new SplatMesh({ url: "prop.sog", lod: true })`.
- **To weight detail per object,** set `lodScale` on a mesh. For example, `2.0` gives it twice the
  detail and `0.5` half.

```js
// Large environment pieces: pre-built LoD, streamed
scene.add(new SplatMesh({ url: "terrain-lod.rad", paged: true }));
scene.add(new SplatMesh({ url: "town-lod.rad", paged: true }));

// Small prop kept as SOG: rendered in full
scene.add(new SplatMesh({ url: "statue.sog" }));

// Mid-size SOG brought into the LoD budget at load time
scene.add(new SplatMesh({ url: "market.sog", lod: true }));
```

**Recommendation:** convert the large pieces to `.rad` and load them with `paged: true`. Small
props can stay SOG. This guidance comes from Spark's documentation, source and `multi-lod` example.
A mixed SOG + RAD scene hasn't yet been tested with this converter's output.

## Hosting RAD files (server requirements)

Serving `.rad` files needs only static file hosting. There's no server-side code, database or
conversion step: the converter (including `serve.py` and the native engine) runs on the author's
own computer. What follows applies to whichever host or CDN serves the `.rad` files to viewers.

### Single `.rad` + `paged: true` (default)

**Required:**
- **HTTP Range requests.** Spark fetches the file in pieces, each with a header like
  `Range: bytes=1234567-2456789`, and the server must answer `206 Partial Content` with just those
  bytes. This is a hard requirement. Spark doesn't check for 206, so a server that ignores Range
  and answers `200` with the whole file makes every chunk request download the entire file (595 MB
  for the trogir example), and decoding fails.
- **No on-the-fly compression for `.rad`.** The chunk data is already compressed. Gzip or brotli
  `Content-Encoding` changes byte offsets and breaks or defeats Range requests on many servers and
  CDNs. Serve `.rad` as `application/octet-stream` with compression disabled.
- **CORS, if the viewer page is on a different origin from the files:**
  `Access-Control-Allow-Origin: <viewer origin>` (or `*`);
  `Access-Control-Allow-Headers: Range`;
  `Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges`.
  Answer `OPTIONS` preflights if you add custom auth headers.

**Request pattern** (useful for capacity and CDN planning):
- **Header:** a request for the first 64 KB, retried with 256 KB, then 1 MB, if the header is
  larger.
- **Chunks:** one Range request per 64K-splat chunk, about 1–3 MB each for SH degree 0, more with
  higher SH degrees. Trogir (33.7M splats, 595 MB) is 514 chunks of about 1.2 MB.
- **Concurrency:** 3 chunk requests in flight per viewer by default (`SparkRenderer.numLodFetchers`).
  HTTP/2 or HTTP/3 helps.
- **What a viewer downloads:** at most 16.7M splats are resident at once on desktop (fewer on
  mobile), so a large scene is never downloaded all at once. Moving around fetches new chunks
  and can re-fetch evicted ones. A typical session therefore transfers a fraction of the file;
  the worst case is roughly the whole file plus some re-fetches.

**Recommended:**
- **A CDN that caches byte ranges.** CloudFront, Cloudflare, Fastly and Google Cloud CDN all do.
  Check your plan's maximum cacheable object size, since large `.rad` files can be hundreds of MB.
  Some CDN plans won't cache objects of that size and pass every request through to the origin.
- **Long cache lifetimes with versioned file names**, e.g. `scene-lod.v3.rad` with
  `Cache-Control: public, max-age=31536000, immutable`.
- **`Accept-Ranges: bytes`** and a correct `Content-Length` on full responses.

**Access control:** `SplatMesh` accepts `requestHeader` (e.g. an `Authorization` bearer token) and
`withCredentials` (cookies) for protected files. Pre-signed URLs (e.g. S3) also work, because every
request uses the same URL.

**Check a host** (expect `206` and a `Content-Range` header):

```bash
curl -s -o /dev/null -D - -H "Range: bytes=0-65535" https://your-host/path/scene-lod.rad
```

The converter's local server (`serve.py`) and `python -m http.server` don't support Range requests
(they answer `200`), so don't use them to test paged streaming. Use a real static server such as
nginx or Caddy, or your actual host.

### Chunked output (`.rad` header + `.radc` files)

Use this only when the host or CDN can't serve Range requests, or caches small whole files much
better. Each chunk is a separate plain `GET`, so no Range support is needed. Upload the `.rad`
and all of its `.radc` files to the same folder: the header refers to them by relative name
(`scene-lod-0.radc`, `scene-lod-1.radc`, …). CORS needs are the same, minus the Range headers.
Pre-signed URLs don't work, because each chunk needs its own signed URL.

### Not needed on the server
- **The converter itself.** `serve.py`, the native `build-lod` tool and this web app are authoring
  tools that run on the author's computer.
- **Any special MIME type or server module** beyond normal static hosting.

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
