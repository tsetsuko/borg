// Akuki: run the simulator against a COPY of the tenant, and show what moved.
//
// THE FOOTGUN THIS AVOIDS: runSimulation deletes its dataDir on close unless
// keep:true (assessor/borg-transport.ts:948, rmSync recursive force). Pointing it at
// the live tenant without keep would destroy Akuki. We therefore (a) copy first and
// (b) pass keep:true, belt and braces.
//
// Also note the simulator CLI has no --data-dir flag and the transport OVERRIDES
// BORG_DATA_DIR in the child env (borg-transport.ts:695), so exporting it in the shell
// does nothing. It has to be driven programmatically, as here.

import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { PersonaSession } from "../simulator/persona.js";
import { tomPersona } from "../simulator/personas/tom.js";
import { runSimulation } from "../simulator/runner.js";
import { captureAkukiSnapshot } from "../src/akuki/snapshot-capture.js";

const liveDir = process.env.AKUKI_DATA_DIR ?? "/home/zosia/projects/ai/akuki/data/akuki";
const expRoot = process.env.AKUKI_EXPERIMENT_DIR ?? "/home/zosia/projects/ai/akuki/data/experiments";
const turns = Number(process.env.AKUKI_SIM_TURNS ?? 6);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(expRoot, `sim-${stamp}`);
const copyDir = join(runDir, "akuki");
mkdirSync(runDir, { recursive: true });
cpSync(liveDir, copyDir, { recursive: true, dereference: true });
console.log("live tenant :", liveDir, "(untouched)");
console.log("copy        :", copyDir);

// Keep the event loop alive for the whole run. Without this the process exited with
// code 13 ("unsettled top-level await") long before the first turn finished -- the run
// was never hung, Node just had nothing holding the loop open and gave up. The interval
// doubles as a progress heartbeat, since a real turn takes minutes through the proxy.
const heartbeat = setInterval(() => process.stderr.write("  ...simulating\n"), 15_000);

const before = (await captureAkukiSnapshot({ dataDir: copyDir, capturedAtMs: Date.now() })).snapshot;

let simError: unknown = null;
let turnsRun: number | undefined;
try {
  const report = await runSimulation({
  runId: `akuki-${stamp}`,
  persona: tomPersona,
  totalTurns: turns,
  metricsPath: join(runDir, "metrics.jsonl"),
  checkEvery: turns + 1, // no overseer checkpoint: this run is about state movement
  dataDir: copyDir,
  keep: true, // WITHOUT THIS THE COPY IS DELETED
  // NOT mock. In mock mode the transport builds its config from DEFAULT_CONFIG and never
  // reads the copy's config.json (borg-transport.ts:700-731), so it asks LanceDB for
  // default-width vectors against our 1024-wide tables and dies with
  // LANCEDB_SCHEMA_MISMATCH. Real mode goes through createRealConfig -> loadConfig(dataDir),
  // which does read the copy's config, so the widths agree.
  mock: false,
  env: process.env,
  maintenanceEvery: turns + 1,
  maxSessions: 2,
  // simulator/persona.ts:23 hardcodes PERSONA_MODEL = "claude-opus-5" for the simulated
  // human, and it is NOT driven by BORG_MODEL_*. Tomek's proxy has no opus tokens, so the
  // persona could never speak and runSimulation hung on an await that never settled.
  // PersonaSession takes a model override, so pin it to the one model the pool serves.
  personaSession: new PersonaSession({
    persona: tomPersona,
    mock: false,
    env: process.env,
    model: process.env.AKUKI_PERSONA_MODEL ?? "claude-haiku-4-5-20251001",
  }),
  // No llmClient injected: that is exactly what simulator/cli.ts does in real mode
  // (cli.ts:275-292). borg then builds its own AnthropicLLMClient from env, which is
  // already pointed at the proxy, and the persona gets one the same way (runner.ts:748).
});
  turnsRun = report.turnsRun;
} catch (error) {
  // The turns themselves can complete and a LATER call still blow up -- borg guards
  // streaming with a 180s inter-event stall check (LLM_STREAM_EVENT_STALLED,
  // src/llm/index.ts:941) and the proxy does sometimes go quiet. Losing the whole
  // measurement to a post-run stall would be wrong: the memory writes already happened.
  simError = error;
}

clearInterval(heartbeat);

const after = (await captureAkukiSnapshot({ dataDir: copyDir, capturedAtMs: Date.now() })).snapshot;

console.log("\nturns run   :", turnsRun ?? "(unknown -- see error below)");
console.log("\nstate vector movement on the COPY:");
let moved = 0;
for (const key of Object.keys(after.counts).sort()) {
  const a = before.counts[key] ?? 0;
  const b = after.counts[key] ?? 0;
  if (a !== b) {
    moved += 1;
    console.log(`  ${key.padEnd(18)} ${String(a).padStart(4)} -> ${String(b).padStart(4)}  (${b - a >= 0 ? "+" : ""}${b - a})`);
  }
}
if (moved === 0) {
  console.log("  (nothing moved)");
}
console.log(`\nAC #7: ${moved > 0 ? "PASS" : "FAIL"} -- ${moved} number(s) moved`);

if (simError !== null) {
  console.log("\nNOTE: the run ended with an error AFTER the turns above were written:");
  console.log(" ", simError instanceof Error ? simError.message : String(simError));
  console.log("  The state movement reported above is still real -- the memory writes happened.");
}
