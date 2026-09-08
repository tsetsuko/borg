import { captureAkukiSnapshot } from "../src/akuki/snapshot-capture.js";
import { requireAkukiDataDir } from "../src/akuki/smoke-config.js";

// See akuki-simulate.ts: no default, because the live tenant is no longer local and
// a script that silently creates one would be a second writer.
const dataDir = requireAkukiDataDir(process.env);
const outDir = process.env.AKUKI_SNAPSHOT_DIR ?? "/home/zosia/projects/ai/akuki/data/snapshots";

const { snapshot, path } = await captureAkukiSnapshot({
  dataDir,
  capturedAtMs: Date.now(),
  outDir,
});

console.log("wrote:", path);
console.log("counts:", JSON.stringify(snapshot.counts));
