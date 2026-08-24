// Diagnostic: find out WHY runSimulation never settles, instead of guessing.
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { PersonaSession } from "../simulator/persona.js";
import { tomPersona } from "../simulator/personas/tom.js";
import { runSimulation } from "../simulator/runner.js";

process.on("unhandledRejection", (r) => console.error("!! unhandledRejection:", r));
process.on("uncaughtException", (e) => console.error("!! uncaughtException:", e));
process.on("beforeExit", () => {
  const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles();
  const reqs = (process as unknown as { _getActiveRequests(): unknown[] })._getActiveRequests();
  console.error(`!! beforeExit: activeHandles=${handles.length} activeRequests=${reqs.length}`);
  for (const h of handles.slice(0, 8)) console.error("   handle:", h?.constructor?.name);
});

const live = "/home/zosia/projects/ai/akuki/data/akuki";
const runDir = join("/home/zosia/projects/ai/akuki/data/experiments", `diag-${Date.now()}`);
const copyDir = join(runDir, "akuki");
mkdirSync(runDir, { recursive: true });
cpSync(live, copyDir, { recursive: true, dereference: true });

let done = false;
const ticker = setInterval(() => {
  if (!done) console.error("   ...still inside runSimulation");
}, 5000);

try {
  console.error(">> calling runSimulation");
  const report = await runSimulation({
    runId: "diag",
    persona: tomPersona,
    totalTurns: 2,
    metricsPath: join(runDir, "metrics.jsonl"),
    checkEvery: 99,
    maintenanceEvery: 99,
    maxSessions: 2,
    dataDir: copyDir,
    keep: true,
    mock: false,
    env: process.env,
    personaSession: new PersonaSession({
      persona: tomPersona, mock: false, env: process.env,
      model: "claude-haiku-4-5-20251001",
    }),
  });
  done = true;
  console.error(">> runSimulation RETURNED, turnsRun =", report.turnsRun);
} catch (e) {
  done = true;
  console.error(">> runSimulation THREW:", e);
} finally {
  clearInterval(ticker);
}
