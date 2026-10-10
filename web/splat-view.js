// Shared Spark viewer used by the converter's Preview and the standalone
// Viewer page: renderer, scene, orbit/fly controls, and camera framing that
// works for every way a SplatMesh can hold its splats (plain, LoD tree from
// bytes, or streamed with paged: true).

export async function createSplatView(host) {
  const THREE = await import("three");
  const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
  const spark = await import("@sparkjsdev/spark");

  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
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
  let sceneRadius = 1;

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
        fly.fpsMovement.moveSpeed = Math.max(0.1, sceneRadius * 0.4);
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
      if (fly) fly.fpsMovement.moveSpeed = Math.max(0.1, sceneRadius * 0.4);
    },

    start(onFrame) {
      renderer.setAnimationLoop((time) => {
        if (mode === "fly") fly.update(camera);
        else orbit.update();
        onFrame?.(time);
        renderer.render(scene, camera);
      });
    },

    stop() {
      renderer.setAnimationLoop(null);
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
