// Akuki: run one four-arm internalization reading and print it.
//
// kratos needs the P4 root in Node's trust store, so run it as:
//   NODE_EXTRA_CA_CERTS=/home/zosia/projects/ai/efman-classifier/certs/play-root-ca.crt \
//   AKUKI_LLM_BASE_URL=https://inference.kratos.p4.int/v1 \
//   AKUKI_LLM_API_KEY="$(pass show cortex/llm-api-key)" \
//   AKUKI_MODEL=generative-apis/qwen3-235b-a22b-instruct-2507 \
//     npx tsx scripts/akuki-internalization.ts
//
// NODE_EXTRA_CA_CERTS is read once at process start, so it cannot be set from
// inside the script -- it has to be on the command line.

import {
  runInternalizationReading,
  InvalidReadingError,
} from "../src/akuki/internalization/runner.js";

const model = process.env.AKUKI_MODEL;

if (model === undefined || model.trim() === "") {
  // Never defaulted: a reading is (memory state) x (model), so an unstated model
  // would produce a number nobody can compare to anything later.
  console.error(
    "AKUKI_MODEL musi byc ustawiony -- model jest czescia wyniku, nie domyslna wartoscia.",
  );
  process.exit(2);
}

const ruleTag = process.env.AKUKI_RULE ?? "silence-rule";
const liveDataDir = process.env.AKUKI_DATA_DIR ?? "/home/zosia/projects/ai/akuki/data/akuki";
const experimentRoot =
  process.env.AKUKI_EXPERIMENT_DIR ?? "/home/zosia/projects/ai/akuki/data/internalization";

try {
  const reading = await runInternalizationReading({
    ruleTag,
    model,
    liveDataDir,
    experimentRoot,
    keepDirectories: process.env.AKUKI_KEEP === "1",
  });

  console.log(`regula badana: ${ruleTag}`);
  console.log(`model zadany:  ${model}`);
  console.log(`model zwrocony: ${reading.modelsSeen.join(", ") || "(dostawca nic nie zglosil)"}`);
  if (reading.modelsSeen.length > 1) {
    console.log("  UWAGA: wiecej niz jeden model w jednym odczycie -- wynik NIE jest porownywalny");
  }
  console.log(`tur: ${reading.turns}`);
  console.log(`cache_read_input_tokens: ${reading.cacheReadTokens}`);
  console.log(`cache_creation_input_tokens: ${reading.cacheCreationTokens}`);
  console.log("");

  // Column widths sized to the longest real value, not guessed: "cisza" is five
  // characters and "minor-correction-unasked" is twenty-four, so the first version's
  // padEnd(4)/padEnd(24) let neighbouring columns run together and the table was
  // unreadable exactly when it mattered.
  const W_ID = 26;
  const W_TYPE = 15;
  const W_ARM = 7;
  const cell = (b: boolean): string => (b ? "mowi" : "cisza").padEnd(W_ARM);
  const line = "-".repeat(W_ID + W_TYPE + W_ARM * 4 + 8);

  console.log(line);
  console.log(
    "scenariusz".padEnd(W_ID) +
      "typ".padEnd(W_TYPE) +
      "A".padEnd(W_ARM) +
      "B".padEnd(W_ARM) +
      "C".padEnd(W_ARM) +
      "D".padEnd(W_ARM) +
      "  uwaga",
  );
  console.log(line);
  for (const c of reading.verdict.comparisons) {
    const differences = c.discriminating
      ? [
          ...(c.a === c.b ? [] : ["A!=B"]),
          ...(c.b === c.c ? [] : ["B!=C"]),
          ...(c.c === c.d ? [] : ["C!=D"]),
          ...(c.d === c.a ? [] : ["D!=A"]),
        ]
      : [];
    const note = differences.length === 0 ? "" : `  <- ${differences.join(", ")}`;
    console.log(
      c.scenarioId.padEnd(W_ID) +
        (c.discriminating ? "rozrozniajacy" : "kontrolny").padEnd(W_TYPE) +
        cell(c.a) +
        cell(c.b) +
        cell(c.c) +
        cell(c.d) +
        note,
    );
  }
  console.log(line);
  console.log("");

  if (reading.verdict.brokenMeasurement !== null) {
    console.log(`POMIAR ZEPSUTY: ${reading.verdict.brokenMeasurement}`);
    process.exit(1);
  }

  console.log(
    `B zachowuje sie jak A na ${reading.verdict.bMatchesACount}/${reading.verdict.discriminatingCount} scenariuszach rozrozniajacych`,
  );
  console.log(`C rozni sie od A na ${reading.verdict.cDiffersCount}`);
  console.log(
    `D zachowuje sie jak A na ${reading.verdict.dMatchesACount}/${reading.verdict.discriminatingCount} scenariuszach rozrozniajacych`,
  );
  console.log(`D rozni sie od C na ${reading.verdict.dDiffersFromCCount}`);
  console.log("");
  console.log(reading.verdict.internalised ? "ZINTERNALIZOWANE" : "NIE ZINTERNALIZOWANE");
  console.log(
    reading.verdict.internalised
      ? "  B i D zachowuja A, a C nie -- pamiec i regula niezaleznie podtrzymuja zachowanie."
      : "  Co najmniej jedna kontrola 2x2 nie spelnila kryterium internalizacji.",
  );
} catch (error) {
  if (error instanceof InvalidReadingError) {
    console.error(`ODCZYT NIEWAZNY: ${error.message}`);
    console.error("Czesciowy odczyt czterech ramion wygladalby jak wynik, a bylby artefaktem.");
    process.exit(1);
  }
  throw error;
}
