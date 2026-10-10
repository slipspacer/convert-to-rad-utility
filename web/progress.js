// spark-lib's LoD builders (in the browser and in the native build-lod tool)
// log "frontier: <done> / <total>" once per level; turn that into 0..1.
export function lodProgress(line) {
  const m = /frontier: (\d+) \/ (\d+)/.exec(line);
  return m ? Number(m[1]) / Number(m[2]) : null;
}
