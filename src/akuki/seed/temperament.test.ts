import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LANDED_MILESTONES,
  TEMPERAMENT_CONSUMERS,
  TEMPERAMENT_PATH,
  TemperamentParseError,
  findOrphanParameters,
  loadTemperament,
  parseTemperamentYaml,
  temperamentSchema,
} from "./temperament.js";

const SRC_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SEED_DIR = fileURLToPath(new URL(".", import.meta.url));

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      collectSources(full, out);
      continue;
    }

    if (!full.endsWith(".ts") || full.endsWith(".test.ts")) {
      continue;
    }

    // Only the files that DECLARE the parameters are excluded. apply.ts lives in
    // the same directory but is a genuine consumer -- it is the one that reads
    // attachment.figure to give the creator its role.
    if (full === join(SEED_DIR, "temperament.ts")) {
      continue;
    }

    out.push(full);
  }

  return out;
}

describe("temperament.yaml", () => {
  const temperament = loadTemperament();

  it("parses and satisfies the schema", () => {
    expect(() => temperamentSchema.parse(temperament)).not.toThrow();
  });

  it("carries no secure_base_discount", () => {
    // research par. 16 :954 -- attachment "remains a research direction rather than
    // a supported implementation recommendation at this stage". Modulating exploration
    // by the presence of the attachment figure is exactly the unlicensed part.
    const raw = readFileSync(TEMPERAMENT_PATH, "utf8");
    const uncommented = raw
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    expect(uncommented).not.toContain("secure_base_discount");
  });

  it("expresses agency as a floor AND a confidence, not one number", () => {
    // A Beta posterior is a curve, so "confidence above 0.8" names no quantity.
    // Read together: P(true rate > floor) > confidence.
    expect(typeof temperament.agency.contingency_floor).toBe("number");
    expect(typeof temperament.agency.contingency_confidence).toBe("number");
  });

  it("keeps the interesting prediction error intermediate, not maximal", () => {
    const [low, high] = temperament.curiosity.target_error_band;
    expect(low).toBeLessThan(high);
    expect(high).toBeLessThan(1);
  });

  it("annotates every parameter with a consumer", () => {
    const keys: string[] = [];

    for (const [group, params] of Object.entries(temperament)) {
      for (const name of Object.keys(params as Record<string, unknown>)) {
        keys.push(`${group}.${name}`);
      }
    }

    expect(keys.slice().sort()).toEqual(Object.keys(TEMPERAMENT_CONSUMERS).slice().sort());
  });

  // AC #4. A key nobody reads is decoration -- precisely what "does it exist in the
  // database when nobody is looking?" is meant to catch. Green while a milestone is
  // unbuilt; red the moment one lands without wiring its parameters.
  it("fails for a parameter whose milestone has landed and which nothing reads", () => {
    const sources = collectSources(SRC_ROOT).map((path) => readFileSync(path, "utf8"));
    expect(findOrphanParameters(sources)).toEqual([]);
  });

  it("actually detects an orphan -- the guard is shown to fail, not assumed to work", () => {
    expect(findOrphanParameters([], { "invented.parameter": "M0" }, ["M0"])).toEqual([
      "invented.parameter (consumer M0 has landed)",
    ]);
  });

  it("stays quiet about a parameter whose milestone has not landed", () => {
    expect(findOrphanParameters([], { "invented.parameter": "M5" }, ["M0"])).toEqual([]);
  });

  it("does not accept a bare-leaf substring as a read", () => {
    // "figures, dates, names" in borg's epistemic_posture must NOT count as a read
    // of attachment.figure.
    expect(
      findOrphanParameters(["figures, dates, names"], { "attachment.figure": "M0" }, ["M0"]),
    ).toEqual(["attachment.figure (consumer M0 has landed)"]);
  });

});

describe("the parser refuses to guess", () => {
  it("rejects an unknown value shape", () => {
    expect(() => parseTemperamentYaml("group:\n  key: 'quoted'\n")).toThrow(TemperamentParseError);
  });

  it("rejects a duplicate key", () => {
    expect(() => parseTemperamentYaml("group:\n  key: 1\n  key: 2\n")).toThrow(
      TemperamentParseError,
    );
  });

  it("rejects a value on a top-level key", () => {
    expect(() => parseTemperamentYaml("group: 1\n")).toThrow(TemperamentParseError);
  });

  it("rejects an unknown parameter through the schema", () => {
    const parsed = parseTemperamentYaml("memory:\n  surprise_weight: 2.0\n  invented: 1\n");
    expect(() => temperamentSchema.parse(parsed)).toThrow();
  });
});
