// Performance-relevant analysis of a Spark .rad file, from its header plus a
// sample of up to MAX_CHUNKS chunks spread evenly through the file. Works on
// in-memory bytes or a URL (Range requests), so it's quick even for huge files.
//
// What drives rendering cost in Spark:
// - LoD: with a tree, Spark draws a capped number of splats per frame (about
//   2.5M on desktop); without one it draws every splat, every frame.
// - SH degree: degree 3 carries 48 colour values per splat instead of 3.
// - Nearly invisible splats cost as much to draw as visible ones.
// - Large splats cover lots of screen (overdraw), worst with the camera inside.

const MAX_CHUNKS = 24;

let F16 = null;
function f16Table() {
  if (F16) return F16;
  F16 = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
    F16[h] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
  }
  return F16;
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Decode one property into dims planar Float32Arrays of length count.
function decodeProp(prop, raw, count, dims) {
  const out = Array.from({ length: dims }, () => new Float32Array(count));
  const { encoding: enc, min: lo, max: hi } = prop;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (enc === "f32" || enc === "f16" || enc === "u16") {
    const t = f16Table();
    for (let d = 0; d < dims; d++) {
      for (let i = 0; i < count; i++) {
        const k = d * count + i;
        out[d][i] = enc === "f32" ? dv.getFloat32(k * 4, true) : enc === "u16" ? dv.getUint16(k * 2, true) : t[dv.getUint16(k * 2, true)];
      }
    }
  } else if (enc === "f32_lebytes" || enc === "f16_lebytes") {
    const nb = enc === "f32_lebytes" ? 4 : 2;
    const t = f16Table();
    const tmp = new DataView(new ArrayBuffer(4));
    for (let d = 0; d < dims; d++) {
      for (let i = 0; i < count; i++) {
        for (let b = 0; b < nb; b++) tmp.setUint8(b, raw[(b * dims + d) * count + i]);
        out[d][i] = nb === 4 ? tmp.getFloat32(0, true) : t[tmp.getUint16(0, true)];
      }
    }
  } else if (enc === "r8") {
    for (let d = 0; d < dims; d++) for (let i = 0; i < count; i++) out[d][i] = (raw[d * count + i] / 255) * (hi - lo) + lo;
  } else if (enc === "ln_0r8") {
    const step = (hi - lo) / 254;
    for (let d = 0; d < dims; d++) {
      for (let i = 0; i < count; i++) {
        const v = raw[d * count + i];
        out[d][i] = v === 0 ? 0 : Math.exp(lo + (v - 1) * step);
      }
    }
  } else if (enc === "ln_f16") {
    const t = f16Table();
    for (let d = 0; d < dims; d++) for (let i = 0; i < count; i++) out[d][i] = Math.exp(t[dv.getUint16((d * count + i) * 2, true)]);
  } else {
    throw new Error(`Unsupported ${prop.property} encoding: ${enc}`);
  }
  return out;
}

async function decodeChunk(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x43444152) throw new Error("Bad RAD chunk");
  const n = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + n)));
  const base = 8 + n + ((8 - (n % 8)) % 8) + 8; // + payload size (u64)
  const props = {};
  for (const prop of meta.properties) {
    if (!["center", "alpha", "scales", "child_count"].includes(prop.property)) continue;
    let raw = buf.subarray(base + prop.offset, base + prop.offset + prop.bytes);
    if (prop.compression === "gz") raw = await inflateRaw(raw);
    props[prop.property] = decodeProp(prop, raw, meta.count, prop.property === "center" || prop.property === "scales" ? 3 : 1);
  }
  return { count: meta.count, props };
}

function percentile(values, p) {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * Analyze a .rad. source: { bytes: Uint8Array } or { url, requestHeader? }.
 * Returns { stats, findings: [{ level: "high"|"medium"|"info", title, detail }], level }.
 */
export async function radReport(source) {
  let whole = null; // set if the server ignores Range and sends the whole file
  const read = source.bytes
    ? async (offset, length) => source.bytes.subarray(offset, offset + length)
    : async (offset, length, url = source.url) => {
        if (whole && url === source.url) return whole.subarray(offset, offset + length);
        const res = await fetch(url, { headers: { ...source.requestHeader, Range: `bytes=${offset}-${offset + length - 1}` } });
        if (!res.ok) throw new Error(`Couldn't read the file (${res.status})`);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (res.status === 206) return buf;
        // No Range support: keep the full file and slice it instead of re-downloading per chunk.
        if (url === source.url) whole = buf;
        return buf.subarray(offset, offset + length);
      };

  let head = await read(0, 65536);
  let dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (dv.getUint32(0, true) !== 0x30444152) throw new Error("Not a RAD file");
  const metaLen = dv.getUint32(4, true);
  if (8 + metaLen > head.length) head = await read(0, 8 + metaLen);
  const meta = JSON.parse(new TextDecoder().decode(head.subarray(8, 8 + metaLen)));
  const chunksStart = 8 + metaLen + ((8 - (metaLen % 8)) % 8);
  const fileBytes = source.bytes?.length ?? chunksStart + (meta.allChunkBytes ?? 0);

  const chunks = meta.chunks ?? [];
  const picks = [...new Set(Array.from({ length: Math.min(MAX_CHUNKS, chunks.length) }, (_, k) =>
    Math.round((k * (chunks.length - 1)) / Math.max(1, Math.min(MAX_CHUNKS, chunks.length) - 1))))];

  const cx = [], cy = [], cz = [], alpha = [], smax = [];
  let sampled = 0, leaves = 0;
  for (const i of picks) {
    const c = chunks[i];
    const buf = c.filename
      ? (source.bytes ? null : await read(0, c.bytes, new URL(c.filename, source.url).toString()))
      : await read(chunksStart + c.offset, c.bytes);
    if (!buf) continue;
    const { count, props } = await decodeChunk(buf);
    const childCount = props.child_count?.[0];
    for (let j = 0; j < count; j++) {
      sampled++;
      if (childCount && childCount[j] !== 0) continue; // LoD parent, not part of the scene itself
      leaves++;
      cx.push(props.center[0][j]); cy.push(props.center[1][j]); cz.push(props.center[2][j]);
      alpha.push(props.alpha[0][j]);
      smax.push(Math.max(props.scales[0][j], props.scales[1][j], props.scales[2][j]));
    }
  }
  if (!leaves) throw new Error("No splats could be sampled from this file");

  const ext = [cx, cy, cz].map((a) => percentile(a, 0.98) - percentile(a, 0.02));
  const diag = Math.hypot(...ext) || 1;
  const total = meta.count;
  const leafCount = Math.round(total * (leaves / sampled));
  const frac = (pred) => alpha.reduce((n, a, i) => n + (pred(a, smax[i]) ? 1 : 0), 0) / leaves;
  const stats = {
    splats: total,
    leaves: leafCount,
    lod: Boolean(meta.lodTree),
    sh: meta.maxSh ?? 0,
    chunks: chunks.length,
    bytes: fileBytes,
    bytesPerSplat: fileBytes / total,
    extent: ext,
    nearlyInvisible: frac((a) => a < 0.05),
    faint: frac((a) => a < 0.2),
    largeSplats: frac((_, s) => s / diag > 0.01),
    medianSize: percentile(smax, 0.5) / diag,
    sampledSplats: sampled,
  };

  const M = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`);
  const pct = (x) => `${Math.round(x * 100)}%`;
  const findings = [];
  if (!stats.lod) {
    findings.push({ level: "high", title: "No LoD tree", detail: `Spark draws all ${M(total)} splats every frame. Convert it with Level of detail: Quality or Quick so Spark can cap what it draws.` });
  }
  if (stats.sh >= 2) {
    findings.push({
      level: "info",
      title: `Spherical harmonics degree ${stats.sh}`,
      detail: `Each splat stores ${stats.sh === 3 ? 48 : 27} colour values instead of 3 (view-dependent shine), so the file and GPU memory are several times larger than at degree 0. In testing it didn't change frame rate on a desktop GPU; converting with “Up to degree 1” or “None” mainly shrinks the download.`,
    });
  }
  if (stats.nearlyInvisible >= 0.25) {
    findings.push({
      level: "medium",
      title: `${pct(stats.nearlyInvisible)} of splats are nearly invisible`,
      detail: "They're under 5% opacity, add almost nothing to the picture, but cost as much to draw as visible splats. Cleaning or cropping the capture removes them.",
    });
  }
  if (stats.largeSplats >= 0.02) {
    findings.push({
      level: "medium",
      title: `${pct(stats.largeSplats)} of splats are large`,
      detail: "Each is bigger than 1% of the scene. Large splats cover a lot of screen and stack up (overdraw), which slows rendering most when the camera is close or inside the scene.",
    });
  }
  if (stats.lod) {
    findings.push({
      level: "info",
      title: `${M(leafCount)} splats, LoD tree included (${M(total)} total)`,
      detail: "With LoD, Spark draws a capped number of splats per frame (about 2.5M on desktop), so the total mostly affects download size and memory, not frame rate.",
    });
  }
  findings.push({
    level: "info",
    title: "Speed depends on the view",
    detail: "How fast a scene renders depends mostly on how much screen its splats cover from where you look (overdraw), which a file can't show. Use Measure in the Viewer to time it on your device.",
  });
  const level = findings.some((f) => f.level === "high") ? "high" : findings.some((f) => f.level === "medium") ? "medium" : "good";
  return { stats, findings, level };
}

/** Plain-text version for logs. */
export function reportText(report) {
  const s = report.stats;
  const pct = (x) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    `File check:          ${{ high: "Will be slow to render", medium: "Heavier than it needs to be", good: "Nothing heavy found" }[report.level]}`,
    `Splats:              ${s.splats.toLocaleString()} (${s.leaves.toLocaleString()} scene splats + LoD tree: ${s.lod ? "yes" : "no"})`,
    `SH degree:           ${s.sh}`,
    `Nearly invisible:    ${pct(s.nearlyInvisible)} (opacity < 5%), faint: ${pct(s.faint)} (< 20%)`,
    `Large splats:        ${pct(s.largeSplats)} (> 1% of scene), median size ${(s.medianSize * 100).toFixed(3)}% of scene`,
    `Scene extent:        ${s.extent.map((v) => v.toFixed(2)).join(" x ")} (2nd-98th percentile)`,
    `Size:                ${(s.bytes / 2 ** 20).toFixed(1)} MB, ${s.bytesPerSplat.toFixed(1)} bytes/splat, ${s.chunks} chunks`,
    ...report.findings.filter((f) => f.level !== "info").map((f) => `- ${f.title}: ${f.detail}`),
    `(Sampled ${s.sampledSplats.toLocaleString()} splats from up to 24 chunks.)`,
  ];
  return lines;
}
