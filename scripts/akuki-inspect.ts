// Thin entry point: logic lives in src/akuki/inspect.ts so it is typechecked.
// Read-only view of what M2/M3 recorded. Runs no turn, no model calls.

import { runAkukiInspect } from "../src/akuki/inspect.js";
import { requireAkukiDataDir } from "../src/akuki/smoke-config.js";

const dataDir = requireAkukiDataDir(process.env);

const report = await runAkukiInspect({
  dataDir,
  env: process.env,
  sessionId: process.env.AKUKI_SESSION ?? "default",
  audience: process.env.AKUKI_AUDIENCE ?? "Zosia",
});

console.log(`=== katalog: ${dataDir} | sesja: ${report.sessionId} ===`);

console.log("\n--- M3: sygnal inhibicji (nizej = smielej) ---");
if (report.inhibition === null) {
  console.log("(brak)");
} else {
  const i = report.inhibition;
  console.log(`partner        : ${i.partner}${i.partnerResolved ? "" : " (NIEROZPOZNANY -> pelny prog)"}`);
  console.log(`sygnal         : ${i.signal.toFixed(3)}`);
  console.log(`  przewidywalnosc partnera : ${i.partnerPredictability.toFixed(3)} (interakcji: ${i.interactionCount}, swieze bledy: [${i.recentPartnerErrors.map((e) => e.toFixed(2)).join(", ")}])`);
  console.log(`  figura przywiazania obecna: ${i.attachmentFigurePresent}`);
  console.log(`  nastroj (valence)        : ${i.currentValence.toFixed(2)} -> caution_bump ${i.cautionBump.toFixed(3)}`);
}

console.log("\n--- M2: otwarte oczekiwania ---");
if (report.predictions.openExpectations.length === 0) {
  console.log("(brak)");
} else {
  for (const e of report.predictions.openExpectations) {
    console.log(`- [${e.turnId}] ${e.content}${e.about ? `  (o: ${e.about})` : ""}`);
  }
}

console.log("\n--- M2: rozliczenia (z error_magnitude) ---");
if (report.predictions.reconciliations.length === 0) {
  console.log("(brak)");
} else {
  for (const r of report.predictions.reconciliations) {
    const err = r.errorMagnitude === null ? "?" : r.errorMagnitude.toFixed(2);
    console.log(`- [${r.turnId}] blad=${err}  ${r.content}`);
  }
}

console.log("\n--- ostatnie zdarzenia tozsamosci ---");
if (report.identityEvents.length === 0) {
  console.log("(brak)");
} else {
  for (const ev of report.identityEvents) {
    console.log(`#${ev.id} ${ev.recordType}/${ev.action} (${ev.provenanceKind})${ev.reason ? ` -- ${ev.reason}` : ""}`);
    console.log(`     ${JSON.stringify(ev.newValue)}`);
  }
}
