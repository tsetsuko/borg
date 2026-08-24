// Thin entry point: all logic lives in src/akuki/ so it is typechecked
// (tsconfig.json excludes "scripts").
import { runAkukiTurn } from "../src/akuki/turn.js";

const dataDir = process.env.AKUKI_DATA_DIR ?? "/home/zosia/projects/ai/akuki/data/akuki";
const sessionId = process.env.AKUKI_SESSION ?? "default";
const message = process.argv.slice(2).join(" ").trim() || "cześć";

const result = await runAkukiTurn({
  dataDir,
  message,
  sessionId,
  audience: process.env.AKUKI_AUDIENCE ?? "Zosia",
  embeddings: process.env.AKUKI_EMBEDDINGS === "fake" ? "fake" : "endpoint",
});

console.log("--- turn ---");
console.log("said           :", message);
console.log("emitted        :", result.emitted);
console.log("emission kind  :", result.emissionKind);
console.log("response       :", result.emitted ? result.response : "(silent)");
console.log("identity_events:", result.identityEventsBefore, "->", result.identityEventsAfter);
if (result.plumbingOnly) {
  console.log("WARNING        : fake embeddings -- plumbing only, not a measurement");
}
