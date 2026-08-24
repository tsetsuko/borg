import { describe, expect, it } from "vitest";
import { PROMPT_BLOCKS } from "../../cognition/prompts/registry.js";
import {
  ScaffoldingParseError,
  compileScaffolding,
  loadScaffolding,
  parseScaffolding,
} from "./scaffolding.js";

const scaffolding = loadScaffolding();

describe("scaffolding.md", () => {
  // AC #5
  it("tags every rule", () => {
    for (const rule of scaffolding.rules) {
      expect(rule.tag).toMatch(/^[a-z0-9-]+$/);
      expect(rule.text.length).toBeGreaterThan(0);
    }

    expect(scaffolding.rules.length).toBeGreaterThan(0);
  });

  // AC #6
  it("holds exactly three PERMANENT rules, and they are the three that were agreed", () => {
    const permanent = scaffolding.rules.filter((rule) => rule.permanent).map((rule) => rule.tag);

    expect(permanent.slice().sort()).toEqual([
      "appraisals-are-evidence",
      "honesty-boundary",
      "no-self-narration",
    ]);
  });

  it("leaves facts untagged -- they are initial conditions, not regulation", () => {
    expect(scaffolding.facts.length).toBeGreaterThan(0);

    for (const fact of scaffolding.facts) {
      expect(fact.text).not.toMatch(/^\[(PERMANENT|removable):/);
    }
  });

  it("addresses only keys borg can actually override", () => {
    const registered = new Set(PROMPT_BLOCKS.map((spec) => spec.key));

    for (const entry of [...scaffolding.facts, ...scaffolding.rules]) {
      expect(registered.has(entry.key)).toBe(true);
    }
  });

  // AC #7. The triage removed roughly 84% of persona/akuki.md; these are the classes
  // of content that must not creep back in. Asserted against the PARSED content, not
  // the raw file: the file's own preamble discusses <silent> in order to explain why
  // it is absent, and that discussion never reaches the prompt.
  it("carries no example utterance, no bot name, and no dead <silent> sentinel", () => {
    const prose = [...scaffolding.facts, ...scaffolding.rules].map((e) => e.text).join("\n");

    // Silence in borg is a tool call (EmitNoOutput / EmitObserve). The sentinel exists
    // nowhere in src/ -- instructing him to write it would emit it as a visible message.
    expect(prose).not.toContain("<silent>");

    // Relationship conclusions are what M4 has to earn. Seeded, they make M4 unmeasurable.
    for (const name of ["Lunaria", "Sol", "Fishy"]) {
      expect(prose).not.toMatch(new RegExp(`\\b${name}\\b`));
    }

    // A quoted line is a line he can say; an echoed few-shot is indistinguishable from
    // learned behaviour and leaves no trace anywhere.
    expect(prose).not.toMatch(/^\s*>/m);
  });
});

describe("compiling to prompt overrides", () => {
  const compiled = compileScaffolding(scaffolding);

  it("appends to borg's default block instead of replacing it", () => {
    // Replacing epistemic_posture would delete "name the unresolved question so my
    // reflection loop catches it afterward" -- the mechanism that produces open
    // questions, and therefore the thing M1 exists to observe.
    for (const [key, text] of compiled) {
      const spec = PROMPT_BLOCKS.find((candidate) => candidate.key === key);
      expect(spec).toBeDefined();
      expect(text.startsWith(spec?.default ?? "")).toBe(true);
      expect(text.length).toBeGreaterThan((spec?.default ?? "").length);
    }
  });

  it("merges a key that appears in both sections into one entry", () => {
    // identity_posture carries a FAKT (name, label) and a RULE (no-self-narration).
    // Two set() calls would leave only the second.
    const identity = compiled.get("identity_posture");
    expect(identity).toBeDefined();
    expect(identity).toContain("Akuki");
    expect(identity).toContain("nie mowisz wprost");
  });

  it("writes four keys", () => {
    expect([...compiled.keys()].sort()).toEqual([
      "epistemic_posture",
      "identity_posture",
      "participation_posture",
      "voice_and_posture",
    ]);
  });

  it("can omit the defaults, for diffing what is ours", () => {
    const own = compileScaffolding(scaffolding, { omitDefaults: true });
    const spec = PROMPT_BLOCKS.find((candidate) => candidate.key === "epistemic_posture");
    expect(own.get("epistemic_posture")?.startsWith(spec?.default ?? "")).toBe(false);
  });
});

describe("the parser refuses to guess", () => {
  it("rejects an untagged rule", () => {
    expect(() =>
      parseScaffolding("## REGULY\n\n### epistemic_posture\n\n- bez taga\n"),
    ).toThrow(ScaffoldingParseError);
  });

  it("rejects a tagged fact", () => {
    expect(() =>
      parseScaffolding("## FAKTY\n\n### identity_posture\n\n- [PERMANENT: x] cos\n"),
    ).toThrow(ScaffoldingParseError);
  });

  it("rejects a duplicate rule tag", () => {
    expect(() =>
      parseScaffolding(
        "## REGULY\n\n### epistemic_posture\n\n- [removable: dup] a\n\n- [removable: dup] b\n",
      ),
    ).toThrow(ScaffoldingParseError);
  });

  it("rejects a prompt key borg does not know", () => {
    expect(() => parseScaffolding("## REGULY\n\n### invented_posture\n\n- [removable: x] a\n")).toThrow(
      ScaffoldingParseError,
    );
  });

  it("joins a bullet that continues on indented lines", () => {
    const parsed = parseScaffolding(
      "## REGULY\n\n### epistemic_posture\n\n- [removable: x]\n  pierwsza\n  druga\n",
    );
    expect(parsed.rules[0]?.text).toBe("pierwsza druga");
  });
});
