// Akuki: compile the seed into the tenant's database.
//
// TWO CORRECTIONS to the plan recorded in TASK-009, both forced by the code:
//
// 1. This is a plain function, not a BorgPool `initializeBeing` callback. Akuki's
//    turn path (src/akuki/turn.ts) calls Borg.open directly, so the pool hook never
//    fires there. initializeBeing may call this; it is not the only caller.
//
// 2. It APPENDS to borg's default prompt blocks instead of replacing them.
//    borg.prompts.set overwrites a whole block, and those blocks carry working
//    machinery -- notably "name the unresolved question so my reflection loop
//    catches it afterward" in epistemic_posture, the mechanism that produces open
//    questions. Replacing it would switch off the thing M1 exists to observe.
//
// Idempotent by construction: prompt text is compared before writing, and the
// creator role is only set when it is not already held by the right entity. Running
// this at every start must not churn updated_at or the identity changelog, or the
// developmental record would fill with events that mean nothing.

import type { EntityId } from "../../util/ids.js";
import type { PromptKey } from "../../cognition/prompts/registry.js";
import { loadTemperament, type Temperament } from "./temperament.js";
import { compileScaffolding, loadScaffolding, type Scaffolding } from "./scaffolding.js";

/**
 * Exactly the surface this applier touches. Narrower than Borg on purpose: the type
 * is the honest statement of what a seed application can reach, and it lets the
 * idempotency test run without opening a database. A real Borg satisfies it
 * structurally.
 */
export type AkukiSeedTarget = {
  prompts: {
    list: () => readonly { readonly key: PromptKey; readonly current_text: string }[];
    set: (key: PromptKey, text: string) => unknown;
  };
  entities: {
    getCreator: () => { readonly canonical_name: string } | null;
    resolve: (
      name: string,
      options: { provenance: "user_declared"; kind: "person" },
    ) => EntityId;
    setBorgRole: (id: EntityId, role: "creator") => unknown;
  };
};

export type ApplyAkukiSeedResult = {
  promptKeysWritten: readonly PromptKey[];
  promptKeysUnchanged: readonly PromptKey[];
  creatorName: string;
  creatorAlreadySet: boolean;
};

export type ApplyAkukiSeedOptions = {
  temperament?: Temperament;
  scaffolding?: Scaffolding;
};

export function applyAkukiSeed(
  borg: AkukiSeedTarget,
  options: ApplyAkukiSeedOptions = {},
): ApplyAkukiSeedResult {
  const temperament = options.temperament ?? loadTemperament();
  const scaffolding = options.scaffolding ?? loadScaffolding();
  const compiled = compileScaffolding(scaffolding);

  const current = new Map(borg.prompts.list().map((block) => [block.key, block.current_text]));

  const written: PromptKey[] = [];
  const unchanged: PromptKey[] = [];

  for (const [key, text] of compiled) {
    if (current.get(key) === text) {
      unchanged.push(key);
      continue;
    }

    borg.prompts.set(key, text);
    written.push(key);
  }

  // The ONE temperament key with a consumer on day one. Everything else in
  // temperament.yaml waits for M2-M5; see TEMPERAMENT_CONSUMERS.
  //
  // The creator is a row, not prose, on purpose: research par. 7 says being an
  // identity agent must not mean write access to the self-concept. A database role
  // gives Zosia structural standing without putting a sentence about her in the
  // prompt. borg enforces a single holder in SQL
  // (src/memory/commitments/repository.ts:385-388, :695-701).
  const creatorName = temperament.attachment.figure;
  const existing = borg.entities.getCreator();
  const creatorAlreadySet = existing !== null && existing.canonical_name === creatorName;

  if (!creatorAlreadySet) {
    const entityId = borg.entities.resolve(creatorName, {
      provenance: "user_declared",
      kind: "person",
    });
    borg.entities.setBorgRole(entityId, "creator");
  }

  return {
    promptKeysWritten: written,
    promptKeysUnchanged: unchanged,
    creatorName,
    creatorAlreadySet,
  };
}
