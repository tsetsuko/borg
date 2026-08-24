import { captureAkukiSnapshot } from "../src/akuki/snapshot-capture.js";

const dataDir = process.env.AKUKI_DATA_DIR ?? "/home/zosia/projects/ai/akuki/data/akuki";
const outDir = process.env.AKUKI_SNAPSHOT_DIR ?? "/home/zosia/projects/ai/akuki/data/snapshots";

const { snapshot, path } = await captureAkukiSnapshot({
  dataDir,
  capturedAtMs: Date.now(),
  outDir,
});

console.log("wrote:", path);
console.log("counts:", JSON.stringify(snapshot.counts));
