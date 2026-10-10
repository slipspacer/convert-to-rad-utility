// Shared Spark viewer used by the converter's Preview and the standalone
// Viewer page: renderer, scene, orbit/fly controls, and camera framing that
// works for every way a SplatMesh can hold its splats (plain, LoD tree from
// bytes, or streamed with paged: true).

export async function createSplatView(host) {
  const THREE = await import("three");
  const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
  const spark = await import("@sparkjsdev/spark");

  const renderer = new THREE.WebGLRenderer({ antialias: false });
  let renderScale = 1;
  const applyPixelRatio = () => renderer.setPixelRatio(Math.min(devicePixelRatio, 2) * renderScale);
  applyPixelRatio();
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d0d0c);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 5000);
  const sparkRenderer = new spark.SparkRenderer({ renderer });
  scene.add(sparkRenderer);

  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true;
  let fly = null;
  let mode = "orbit";
  let controlsEnabled = true;
  let sceneRadius = 1;
  // Fly speed: 5% of the framed scene's radius per second, times a user
  // multiplier (Shift x5 and Ctrl slow-down come from Spark's FpsMovement).
  let flySpeed = 1;
  const applyFlySpeed = () => {
    if (fly) fly.fpsMovement.moveSpeed = Math.max(1e-3, sceneRadius * 0.05 * flySpeed);
  };

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = host;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(host);
  resize();

  const view = {
    THREE, spark, renderer, scene, camera, sparkRenderer, orbit,
    get mode() { return mode; },

    /** "orbit" (drag to orbit) or "fly" (WASD + mouse, Spark's SparkControls). */
    setMode(next) {
      if (next === mode) return;
      mode = next;
      if (mode === "fly") {
        fly ??= new spark.SparkControls({ canvas: renderer.domElement });
        applyFlySpeed();
        fly.lastTime = 0;
        orbit.enabled = false;
      } else {
        // Orbit around a point ahead of where the fly camera is looking.
        const dir = new THREE.Vector3();
        camera.getWorldDirection(dir);
        orbit.target.copy(camera.position).addScaledVector(dir, sceneRadius);
        orbit.enabled = true;
        orbit.update();
      }
    },

    /** Point the camera at a world-space THREE.Box3. */
    frame(box) {
      if (!box || box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      sceneRadius = Math.max(1e-3, box.getSize(new THREE.Vector3()).length() / 2);
      camera.near = sceneRadius / 1000;
      camera.far = sceneRadius * 200;
      camera.position.copy(center).add(new THREE.Vector3(0, sceneRadius * 0.35, sceneRadius * 1.6));
      camera.lookAt(center);
      camera.updateProjectionMatrix();
      orbit.target.copy(center);
      orbit.update();
      applyFlySpeed();
    },

    /** Multiplier on the default fly speed (1 = 5% of the scene radius per second). */
    setFlySpeed(multiplier) {
      flySpeed = multiplier;
      applyFlySpeed();
    },

    start(onFrame) {
      renderer.setAnimationLoop((time) => {
        if (!controlsEnabled) { /* benchmark is steering the camera */ }
        else if (mode === "fly") fly.update(camera);
        else orbit.update();
        onFrame?.(time);
        renderer.render(scene, camera);
      });
    },

    stop() {
      renderer.setAnimationLoop(null);
    },

    /** Fraction of the device's pixel density to render at (1, 0.75, 0.5…). */
    setRenderScale(scale) {
      renderScale = scale;
      applyPixelRatio();
      resize();
    },
    get renderScale() { return renderScale; },
    get pixels() { return renderer.domElement.width * renderer.domElement.height; },

    setControlsEnabled(enabled) {
      controlsEnabled = enabled;
      if (fly) fly.lastTime = 0;
    },
  };
  return view;
}

const PERCENTILE = 0.02;
const MAX_SAMPLES = 200000;

// Robust bounds from n splats: 2nd..98th percentile of up to 200K evenly
// spaced centers, so stray floaters don't throw off the framing.
function sampledBox(THREE, n, centerOf) {
  if (!n) return null;
  const samples = Math.min(n, MAX_SAMPLES);
  const step = n / samples;
  const axes = [new Float32Array(samples), new Float32Array(samples), new Float32Array(samples)];
  for (let k = 0; k < samples; k++) {
    const c = centerOf(Math.floor(k * step));
    axes[0][k] = c.x;
    axes[1][k] = c.y;
    axes[2][k] = c.z;
  }
  const lo = [], hi = [];
  for (const a of axes) {
    a.sort();
    lo.push(a[Math.floor(samples * PERCENTILE)]);
    hi.push(a[Math.min(samples - 1, Math.floor(samples * (1 - PERCENTILE)))]);
  }
  return new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(...hi));
}

/**
 * Local-space bounds of an initialized SplatMesh, or null.
 * - LoD trees loaded from bytes live in packedSplats/extSplats.lodSplats, which
 *   SplatMesh.getBoundingBox() doesn't see, so sample them directly.
 * - Streamed (paged) meshes: decode chunk 0, the coarsest 64K splats, which
 *   span the whole scene.
 */
export async function meshBounds(view, mesh) {
  const { THREE, spark } = view;
  if (mesh.paged) {
    for (let i = 0; i < 100 && !mesh.paged.pager; i++) await new Promise((r) => setTimeout(r, 100));
    if (!mesh.paged.pager) return null;
    const chunk = await mesh.paged.fetchDecodeChunk(0);
    if (!chunk?.packedArray) return null;
    return sampledBox(THREE, chunk.numSplats, (i) => spark.unpackSplat(chunk.packedArray, i, chunk.splatEncoding).center);
  }
  const src = mesh.packedSplats?.lodSplats ?? mesh.extSplats?.lodSplats ?? mesh.packedSplats ?? mesh.extSplats;
  return sampledBox(THREE, src?.numSplats ?? 0, (i) => src.getSplat(i).center);
}

/** Total splats an initialized SplatMesh holds (LoD tree included). */
export async function meshSplatCount(mesh) {
  if (mesh.paged) {
    try {
      return (await mesh.paged.getRadMeta()).meta.count;
    } catch {
      return 0;
    }
  }
  const src = mesh.packedSplats?.lodSplats ?? mesh.extSplats?.lodSplats ?? mesh.packedSplats ?? mesh.extSplats;
  return src?.numSplats ?? mesh.numSplats ?? 0;
}

/** Transform a local Box3 by an object's world matrix (all 8 corners). */
export function worldBox(view, mesh, localBox) {
  if (!localBox) return null;
  mesh.updateMatrixWorld(true);
  return localBox.clone().applyMatrix4(mesh.matrixWorld);
}

// Many captures (COLMAP-style) are Y-down; rotating 180° about X shows them upright.
export function setFlipped(mesh, flipped) {
  mesh.quaternion.set(flipped ? 1 : 0, 0, 0, flipped ? 0 : 1);
}

// ---------- benchmark ----------

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function measureFrames(view, ms) {
  const dts = [];
  let splats = 0;
  let last = await nextFrame();
  const end = last + ms;
  while (last < end) {
    const now = await nextFrame();
    dts.push(now - last);
    splats += view.sparkRenderer.activeSplats ?? 0;
    last = now;
  }
  const hitches = dts.filter((dt) => dt > 100).length; // pauses over 0.1 s
  dts.sort((a, b) => a - b);
  const avg = dts.reduce((a, b) => a + b, 0) / dts.length;
  return { fps: 1000 / avg, low: 1000 / dts[Math.floor(dts.length * 0.95)], splats: splats / dts.length, hitches };
}

/**
 * Time rendering on this device: the display's refresh rate (splats hidden),
 * then 6 views from outside the scene and 6 looking around from its centre.
 * box: world-space Box3 of the scene. Restores the camera afterwards.
 */
export async function benchmark(view, box, { meshes, onStep, settleMs = 900, firstSettleMs = 2500, measureMs = 1000 } = {}) {
  const { THREE, camera, orbit } = view;
  const saved = { pos: camera.position.clone(), quat: camera.quaternion.clone(), target: orbit.target.clone() };
  view.setControlsEnabled(false);
  try {
    // Refresh-rate ceiling: nothing to draw.
    const visible = meshes.map((m) => m.visible);
    meshes.forEach((m) => (m.visible = false));
    onStep?.("Measuring display refresh rate");
    await sleep(200);
    const refresh = (await measureFrames(view, 600)).fps;
    meshes.forEach((m, i) => (m.visible = visible[i]));

    const center = box.getCenter(new THREE.Vector3());
    const r = Math.max(1e-3, box.getSize(new THREE.Vector3()).length() / 2);
    const shots = [];
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      shots.push({ group: "outside", pos: center.clone().add(new THREE.Vector3(Math.cos(a) * 1.6 * r, 0.35 * r, Math.sin(a) * 1.6 * r)), look: center });
    }
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      shots.push({ group: "inside", pos: center.clone(), look: center.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)) });
    }

    const results = [];
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      camera.position.copy(s.pos);
      camera.lookAt(s.look);
      camera.updateMatrixWorld();
      onStep?.(`${s.group === "outside" ? "Outside" : "Inside"} view ${(i % 6) + 1} of 6`, (i + 1) / shots.length);
      await sleep(i === 0 || i === 6 ? firstSettleMs : settleMs); // let LoD (and streaming) settle
      results.push({ ...s, ...(await measureFrames(view, measureMs)) });
    }
    // Fill-rate probe: re-time the slowest view at half resolution. A big
    // speed-up means the cost is pixels (overdraw), not the number of splats.
    const slowest = results.reduce((a, b) => (a.fps < b.fps ? a : b));
    camera.position.copy(slowest.pos);
    camera.lookAt(slowest.look);
    camera.updateMatrixWorld();
    const scale0 = view.renderScale;
    onStep?.("Checking whether pixels or splats are the bottleneck", 1);
    view.setRenderScale(scale0 * 0.5);
    await sleep(settleMs);
    const half = await measureFrames(view, measureMs);
    view.setRenderScale(scale0);
    await sleep(300);
    const full = await measureFrames(view, measureMs);
    // At the display's refresh rate there's nothing to diagnose: frames are capped.
    const capped = full.fps >= refresh * 0.9;
    const probe = { full: full.fps, half: half.fps, capped, fillBound: !capped && half.fps > full.fps * 1.4 };

    const summarize = (group) => {
      const g = results.filter((x) => x.group === group);
      const lows = g.map((x) => x.low).sort((a, b) => a - b);
      return {
        fps: g.reduce((a, x) => a + x.fps, 0) / g.length,
        // Typical dips: median over the views of each view's 1-in-20 slowest frame,
        // so one stray pause (an LoD rebuild after the camera jumps) doesn't decide it.
        worst: lows[Math.floor(lows.length / 2)],
        splats: g.reduce((a, x) => a + x.splats, 0) / g.length,
        hitches: g.reduce((a, x) => a + x.hitches, 0),
      };
    };
    return { refresh, outside: summarize("outside"), inside: summarize("inside"), probe, pixels: view.pixels };
  } finally {
    camera.position.copy(saved.pos);
    camera.quaternion.copy(saved.quat);
    orbit.target.copy(saved.target);
    view.setControlsEnabled(true);
  }
}
