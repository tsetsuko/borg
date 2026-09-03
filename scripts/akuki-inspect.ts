// Thin entry point: logic lives in src/akuki/inspect.ts so it is typechecked.
// Read-only view of what M2/M3 recorded. Runs no turn, no model calls.

import { runAkukiInspect, formatAkukiInspectReport } from "../src/akuki/inspect.js";
import { requireAkukiDataDir } from "../src/akuki/smoke-config.js";

const dataDir = requireAkukiDataDir(process.env);

const report = await runAkukiInspect({
  dataDir,
  env: process.env,
  sessionId: process.env.AKUKI_SESSION ?? "default",
  audience: process.env.AKUKI_AUDIENCE ?? "Zosia",
});

console.log(`=== katalog: ${dataDir} | sesja: ${report.sessionId} ===`);
console.log(formatAkukiInspectReport(report));
