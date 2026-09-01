// Akuki: apply the seed to the tenant, without running a turn.
//
// Deliberately separate from akuki-turn.ts: seeding needs no model call, so it
// costs nothing and can be re-run freely. applyAkukiSeed compares before it
// writes, so running this twice is a no-op the second time.

import { Borg } from "../src/index.js";
import { applyAkukiSeed } from "../src/akuki/seed/apply.js";
import { requireAkukiDataDir } from "../src/akuki/smoke-config.js";

const dataDir = requireAkukiDataDir(process.env);

const borg = await Borg.open({ dataDir, env: process.env });

try {
  const before = borg.prompts.list().filter((b) => b.overridden).length;
  const result = applyAkukiSeed(borg);
  const after = borg.prompts.list().filter((b) => b.overridden).length;

  console.log(`katalog: ${dataDir}`);
  console.log(`prompt_overrides: ${before} -> ${after}`);
  console.log(`  zapisane:      ${result.promptKeysWritten.join(", ") || "(nic)"}`);
  console.log(`  bez zmian:     ${result.promptKeysUnchanged.join(", ") || "(nic)"}`);
  console.log(
    `tworca: ${result.creatorName}${result.creatorAlreadySet ? " (juz byl ustawiony)" : " (nadany teraz)"}`,
  );
} finally {
  await borg.close();
}
