// Akuki: execute one three-arm internalization reading.
//
// ISOLATION PER SCENARIO, not just per arm. Each (arm, scenario) pair gets its
// own copied data directory, so scenario 2 never sees what scenario 1 said. Six
// scenarios sharing one directory would drift within a run: the arm being
// measured would change under the measurement, and scenario order would become
// part of the result. That is 18 directories and 18 opens per reading, which is
// slow and correct rather than fast and unreadable.
//
// A READING IS ALL-OR-NOTHING. Any model failure -- a 503, a timeout, anything
// -- invalidates the WHOLE reading, not the one turn. Three arms with one turn
// missing still produce numbers, and those numbers look like a result while
// being an artefact of which call happened to fail.

import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Borg } from "../../index.js";
import type { TokenUsageEvent } from "../../llm/index.js";
import { parseSessionId } from "../../util/ids.js";
import { applyAkukiSeed } from "../seed/apply.js";
import { loadScaffolding, type Scaffolding } from "../seed/scaffolding.js";
import { buildAkukiClients } from "../tenant.js";
import { armSpecs, prepareArmDirectory, scaffoldingForArm } from "./arms.js";
import { SILENCE_RULE_SCENARIOS, type Scenario } from "./scenarios.js";
import { judge, type ArmOutcome, type Verdict } from "./verdict.js";

/** Thrown instead of returning a partial reading. See the all-or-nothing note above. */
export class InvalidReadingError extends Error {}

function sessionIdFor(scenarioId: string, arm: string): ReturnType<typeof parseSessionId> {
  const digest = createHash("sha256").update(`${scenarioId}:${arm}`).digest("hex").slice(0, 16);
  return parseSessionId(`sess_${digest}`);
}

export type ReadingOptions = {
  ruleTag: string;
  /** Passed to BORG_MODEL_COGNITION. Never defaulted here: the model is part of the result. */
  model: string;
  liveDataDir: string;
  experimentRoot: string;
  scenarios?: readonly Scenario[];
  scaffolding?: Scaffolding;
  env?: NodeJS.ProcessEnv;
  /** Keep the 18 directories after the run, for inspection. */
  keepDirectories?: boolean;
};

export type Reading = {
  verdict: Verdict;
  outcomes: readonly ArmOutcome[];
  /** Distinct model ids the provider reported. More than one means the reading is not comparable. */
  modelsSeen: readonly string[];
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns: number;
};

export async function runInternalizationReading(options: ReadingOptions): Promise<Reading> {
  const scenarios = options.scenarios ?? SILENCE_RULE_SCENARIOS;
  const scaffolding = options.scaffolding ?? loadScaffolding();
  const env = { ...(options.env ?? process.env), BORG_MODEL_COGNITION: options.model };

  const outcomes: ArmOutcome[] = [];
  const modelsSeen = new Set<string>();
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let turns = 0;

  rmSync(options.experimentRoot, { recursive: true, force: true });
  mkdirSync(options.experimentRoot, { recursive: true });

  try {
    for (const scenario of scenarios) {
      // A per-scenario root, so armSpecs still owns the arm-directory layout.
      const arms = armSpecs(join(options.experimentRoot, scenario.id), options.ruleTag);

      for (const arm of arms) {
        prepareArmDirectory(arm, options.liveDataDir);

        let reported: string | null = null;
        const usageSink = (event: TokenUsageEvent): void => {
          reported = event.model;
          modelsSeen.add(event.model);
          cacheReadTokens += event.cache_read_input_tokens ?? 0;
          cacheCreationTokens += event.cache_creation_input_tokens ?? 0;
        };

        const clients = buildAkukiClients({ env, usageSink });
        const borg = await Borg.open({
          dataDir: arm.dataDir,
          env,
          llmClient: clients.llmClient,
          ...(clients.embeddingClient ? { embeddingClient: clients.embeddingClient } : {}),
        });

        try {
          applyAkukiSeed(borg, { scaffolding: scaffoldingForArm(scaffolding, arm) });

          const result = await borg.turn({
            userMessage: scenario.message,
            // A distinct session per pair, so no shared history defeats the copied
            // directory it is meant to isolate. DERIVED, not random: re-running the
            // same reading must produce the same ids, or traces from two runs cannot
            // be lined up. borg's ids are `sess_` plus 16 chars of [a-z0-9], and hex
            // is a subset of that alphabet.
            sessionId: sessionIdFor(scenario.id, arm.name),
            ...(scenario.audience === undefined ? {} : { audience: scenario.audience }),
          });

          turns += 1;
          outcomes.push({
            arm: arm.name,
            scenarioId: scenario.id,
            emission: {
              kind: result.emission.kind,
              ...(result.emission.kind === "suppressed" &&
              result.emission.primary_no_output_reason !== undefined
                ? { noOutputReason: result.emission.primary_no_output_reason }
                : {}),
            },
            // What answered, not what was requested. Falls back to the request only
            // when the provider reported nothing, and that case is visible in modelsSeen.
            model: reported ?? options.model,
            // Kept for a human to read, never for judge() to score.
            response: result.response,
          });
        } catch (error) {
          throw new InvalidReadingError(
            `arm ${arm.name} / scenario ${scenario.id} failed, so the whole reading is void: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error },
          );
        } finally {
          await borg.close();
        }
      }
    }
  } finally {
    if (options.keepDirectories !== true) {
      rmSync(options.experimentRoot, { recursive: true, force: true });
    }
  }

  return {
    verdict: judge(scenarios, outcomes),
    outcomes,
    modelsSeen: [...modelsSeen],
    cacheReadTokens,
    cacheCreationTokens,
    turns,
  };
}
