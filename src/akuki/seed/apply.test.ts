import { describe, expect, it } from "vitest";
import { PROMPT_BLOCKS, type PromptKey } from "../../cognition/prompts/registry.js";
import { createEntityId, type EntityId } from "../../util/ids.js";
import { applyAkukiSeed, type AkukiSeedTarget } from "./apply.js";
import { loadScaffolding } from "./scaffolding.js";
import { loadTemperament } from "./temperament.js";

/**
 * A fresh tenant, modelled at exactly the surface applyAkukiSeed touches.
 *
 * Faithful on the point that matters: with no override row, borg reports the
 * built-in default as current_text. So the first run must see a difference and
 * write; the second must see its own output and stay silent.
 */
function fakeTarget(): AkukiSeedTarget & {
  readonly writes: { key: PromptKey; text: string }[];
  readonly roleSets: EntityId[];
  readonly resolved: string[];
} {
  const overrides = new Map<PromptKey, string>();
  const writes: { key: PromptKey; text: string }[] = [];
  const roleSets: EntityId[] = [];
  const resolved: string[] = [];
  let creator: { canonical_name: string } | null = null;

  return {
    writes,
    roleSets,
    resolved,
    prompts: {
      list: () =>
        PROMPT_BLOCKS.map((spec) => ({
          key: spec.key,
          current_text: overrides.get(spec.key) ?? spec.default,
        })),
      set: (key, text) => {
        overrides.set(key, text);
        writes.push({ key, text });
      },
    },
    entities: {
      getCreator: () => creator,
      resolve: (name) => {
        resolved.push(name);
        creator = { canonical_name: name };
        return createEntityId();
      },
      setBorgRole: (id) => {
        roleSets.push(id);
      },
    },
  };
}

const temperament = loadTemperament();
const scaffolding = loadScaffolding();

describe("applyAkukiSeed", () => {
  it("writes four prompt keys on a fresh tenant", () => {
    const target = fakeTarget();
    const result = applyAkukiSeed(target, { temperament, scaffolding });

    expect(result.promptKeysWritten.slice().sort()).toEqual([
      "epistemic_posture",
      "identity_posture",
      "participation_posture",
      "voice_and_posture",
    ]);
    expect(result.promptKeysUnchanged).toEqual([]);
  });

  it("appends to the default rather than replacing it", () => {
    const target = fakeTarget();
    applyAkukiSeed(target, { temperament, scaffolding });

    for (const write of target.writes) {
      const spec = PROMPT_BLOCKS.find((candidate) => candidate.key === write.key);
      expect(write.text.startsWith(spec?.default ?? "")).toBe(true);
    }
  });

  it("keeps borg's open-question instruction alive in epistemic_posture", () => {
    // The specific regression this guards: replacing the block would delete the
    // sentence that tells the being to name an unresolved question, which is the
    // mechanism that produced the open question observed on the live tenant.
    const target = fakeTarget();
    applyAkukiSeed(target, { temperament, scaffolding });

    const epistemic = target.writes.find((write) => write.key === "epistemic_posture");
    expect(epistemic?.text).toContain("name the unresolved question");
  });

  it("writes nothing on a second run", () => {
    const target = fakeTarget();
    applyAkukiSeed(target, { temperament, scaffolding });
    const before = target.writes.length;

    const second = applyAkukiSeed(target, { temperament, scaffolding });

    expect(target.writes.length).toBe(before);
    expect(second.promptKeysWritten).toEqual([]);
    expect(second.promptKeysUnchanged).toHaveLength(4);
  });

  it("gives the creator role to the attachment figure, once", () => {
    const target = fakeTarget();
    const first = applyAkukiSeed(target, { temperament, scaffolding });

    expect(first.creatorName).toBe(temperament.attachment.figure);
    expect(first.creatorAlreadySet).toBe(false);
    expect(target.resolved).toEqual([temperament.attachment.figure]);
    expect(target.roleSets).toHaveLength(1);

    const second = applyAkukiSeed(target, { temperament, scaffolding });

    expect(second.creatorAlreadySet).toBe(true);
    expect(target.resolved).toHaveLength(1);
    expect(target.roleSets).toHaveLength(1);
  });

  it("re-seats the creator when a different entity holds the role", () => {
    const target = fakeTarget();
    applyAkukiSeed(target, {
      temperament: { ...temperament, attachment: { ...temperament.attachment, figure: "Ktos" } },
      scaffolding,
    });

    const result = applyAkukiSeed(target, { temperament, scaffolding });

    expect(result.creatorAlreadySet).toBe(false);
    expect(target.resolved).toEqual(["Ktos", temperament.attachment.figure]);
  });

  it("puts no temperament number into the prompt", () => {
    // Parameters drive mechanisms; they are never described to him in words.
    const target = fakeTarget();
    applyAkukiSeed(target, { temperament, scaffolding });
    const prose = target.writes.map((write) => write.text).join("\n");

    for (const name of ["base_threshold", "surprise_weight", "contingency_floor", "0.75"]) {
      expect(prose).not.toContain(name);
    }
  });
});
