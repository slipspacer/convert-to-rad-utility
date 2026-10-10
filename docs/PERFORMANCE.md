# RAD rendering performance: findings

Measured 2026-10-11 on the Windows dev machine: 240 Hz display, page at 1920×1080 with a device
pixel ratio of 1.5, so 2460×1531 px rendered. The test files are in the Google Drive test folder
(`…/TESTING ASSETS/Gaussian Splats/RAD single file`). Numbers come from the Viewer's **Measure**,
the file check, and a standalone analysis of every file.

## Why LostPlace is sluggish and trogir isn't

**Overdraw, not file size, splat count or SH.**

| 1920×1080 viewport | Outside | Inside | Splats drawn/frame |
|---|---|---|---|
| trogir (SH 0, 33.7M splats) | 215 fps | 179 fps | 2.5M |
| LostPlace (SH 3, 7.2M splats) | 76 fps (dips 35) | 92 fps (dips 45) | 2.5M |
| LostPlace, SH switched off at render time | 76 fps | 93 fps | 2.5M |
| LostPlace, Detail 0.5× (half the splats) | 95 fps | 106 fps | 1.25M |
| LostPlace, pixel ratio 1 (2.25× fewer pixels) | 139 fps | 158 fps | 2.4M |

- **Same splat count, different cost.** With an LoD tree, Spark draws a capped number of splats
  per frame (about 2.5M on desktop) whatever the file size, so both scenes draw the same amount.
- **Fewer pixels helps; fewer splats barely does.** Rendering 2.25× fewer pixels nearly doubled
  LostPlace's frame rate, while halving the splats gained only about 25%. LostPlace's splats are
  large on screen and stack up, so each pixel gets painted many times. Trogir's splats are tiny on
  screen.
- **It's resolution-sensitive.** On a small canvas (660×811) LostPlace ran at about 215–229 fps,
  as fast as trogir. It only becomes sluggish at large, high-DPI window sizes.
- **SH degree 3 didn't change the frame rate.** It costs file size and GPU memory (about 47 bytes
  per splat for LostPlace versus about 18 for trogir), not speed, at least on this desktop GPU.

**Fixes, best first:**
1. Lower the render resolution: the Viewer's Resolution 75% or 50%. In production, cap
   `renderer.setPixelRatio()`, e.g. at 1.
2. Lower the LoD Detail (`SparkRenderer.lodSplatScale`): a smaller gain for overdraw-bound scenes.
3. Re-convert with a lower SH degree. This shrinks the download but doesn't speed up rendering.

## File analysis of the test set

Sampled about 80 chunks per file. "Scene splats" means the LoD tree's leaves, the real splats.
Size is the median splat size as a share of the scene.

| File | Size | Splats (scene) | SH | Nearly invisible (<5% opacity) | Faint (<20%) | Splat size (median) | Large (>1% of scene) |
|---|---|---|---|---|---|---|---|
| insect_beetle2 | 5 MB | 103K (74K) | 3 | 1.3% | 23% | 0.31% | 13.5% |
| insect_beetle | 16 MB | 307K (248K) | 3 | 5.6% | 37% | 0.24% | 4.5% |
| insect_fly | 66 MB | 1.3M (963K) | 3 | 0.9% | 22% | 0.16% | 0.2% |
| insect_centipede | 165 MB | 3.1M (2.5M) | 3 | **80%** | 99% | 0.16% | 1.7% |
| insect_grasshopper | 209 MB | 4.1M (3.2M) | 3 | **91%** | 100% | 0.21% | 4.0% |
| LostPlace_R2_5M | 324 MB | 7.2M (5.4M) | 3 | 0.6% | 30% | 0.035% | 1.0% |
| apartment | 279 MB | 6.1M (4.4M) | 3 | 8.7% | 33% | 0.044% | 0.2% |
| canada_mall | 363 MB | 19.7M (13.7M) | 0 | 4.8% | 26% | 0.028% | 0.0% |
| Hobbiton_25M | 514 MB | 35.0M (24.4M) | 0 | 8.8% | 33% | 0.020% | 0.2% |
| trogir | 595 MB | 33.7M (22.8M) | 0 | 3.5% | 33% | 0.013% | 0.3% |
| Artist Journey | 763 MB | 53.2M (36.5M) | 0 | 7.2% | 34% | 0.015% | 0.0% |

- **Insects render fast:** they're small objects viewed from outside, so they cover little screen.
- **The centipede and grasshopper are 80–91% nearly invisible splats.** That's wasted data,
  probably from the capture or training. It's harmless at their size but would hurt in a large
  scene. Cleaning or cropping removes them.
- **Every large scene except LostPlace and apartment is SH 0.** Those two (both SH 3) are also
  the interior-style scenes, where the camera sits among nearby surfaces, which raises overdraw.

## Tools in the app

- **File check:** on the converter's job card, in the saved `.log.txt`, and on each object in the
  Viewer (`web/rad-report.js`). It samples the header plus 24 chunks and reports counts, LoD, SH,
  nearly invisible splats and large splats. It can't see view-dependent cost such as overdraw.
- **Measure:** the Viewer's Performance panel and the converter's Preview (`benchmark()` in
  `web/splat-view.js`). It runs 6 outside and 6 inside views and reports fps, typical dips (the
  median over the views of the 1-in-20 slowest frame) and splats drawn. A half-resolution re-run of
  the slowest view classifies the bottleneck: **pixels** if it's more than 1.4× faster, otherwise
  **splat count**, or **none** if it already runs at the display's refresh rate. "Smooth" requires
  an average of at least 90% of 60 fps and dips of at least 75% of 60 fps.
- **Resolution control** (Viewer): render scale of 100, 75 or 50% of the device pixel ratio.
- **Debug handle:** `radViewer.objects` / `radViewer.view` in the Viewer's console. For example,
  `radViewer.objects[0].mesh.maxSh = 0; radViewer.objects[0].mesh.updateGenerator()` reproduces
  the SH-off test.

## Open questions / next steps

- **Measure doesn't test motion.** It times a still camera at each view, so delays while Spark
  loads new detail as you move aren't captured. If a scene stays sluggish while moving even at
  75% Resolution, add a moving-camera test that measures fps and LoD/streaming catch-up.
- **The results need the target device.** The numbers above are from one desktop GPU. Re-measure
  on the user's actual monitor size and on mobile and VR targets, where the LoD budget is smaller
  (about 0.5–1.5M) and SH may matter more.
- **Production pixel ratio.** For overdraw-bound scenes, consider a default pixel-ratio cap or an
  adaptive resolution that drops when the frame rate does.
