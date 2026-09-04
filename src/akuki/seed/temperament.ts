// Akuki: reader for seed/temperament.yaml.
//
// borg has NO YAML dependency -- package.json carries zod and nothing else that
// could parse this. Adding one would put a permanent diff in package.json and
// package-lock.json, the two files most likely to conflict on every merge from
// upstream/dev. The seed file is a fixed two-level shape that we control, so this
// reads exactly that shape and THROWS on anything it does not recognise.
//
// This is NOT a YAML implementation and must never be used as one. It supports:
// full-line and trailing `#` comments, one level of nesting, and three value
// kinds (number, bare string, inline array of numbers). Anything else is an error
// rather than a guess -- a seed file silently mis-parsed would corrupt every
// downstream measurement without leaving a trace.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export class TemperamentParseError extends Error {}

type Scalar = number | string | readonly number[];

const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;
const KEY_RE = /^[a-z][a-z0-9_]*$/;

function parseScalar(raw: string, line: number): Scalar {
  const value = raw.trim();

  if (value === "") {
    throw new TemperamentParseError(`line ${line}: empty value`);
  }

  if (value.startsWith("[")) {
    if (!value.endsWith("]")) {
      throw new TemperamentParseError(`line ${line}: unterminated array`);
    }

    const inner = value.slice(1, -1).trim();
    const parts = inner === "" ? [] : inner.split(",").map((part) => part.trim());

    return parts.map((part) => {
      if (!NUMBER_RE.test(part)) {
        throw new TemperamentParseError(`line ${line}: array holds a non-number (${part})`);
      }
      return Number(part);
    });
  }

  if (NUMBER_RE.test(value)) {
    return Number(value);
  }

  // Quoting is not supported on purpose: the seed file has exactly one string
  // value and adding quote handling would be the first step toward pretending
  // this is a YAML parser.
  if (value.includes('"') || value.includes("'")) {
    throw new TemperamentParseError(`line ${line}: quoted strings are not supported`);
  }

  return value;
}

// A `#` inside a value would be a comment here, which is wrong for real YAML but
// correct for this file -- no value in it contains one, and the guard above turns
// any future one into a parse error rather than silent truncation.
function stripComment(line: string): string {
  const index = line.indexOf("#");
  return index === -1 ? line : line.slice(0, index);
}

export function parseTemperamentYaml(source: string): Record<string, Record<string, Scalar>> {
  const result: Record<string, Record<string, Scalar>> = {};
  let group: string | null = null;

  source.split("\n").forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = stripComment(rawLine);

    if (line.trim() === "") {
      return;
    }

    const indented = /^\s/.test(line);
    const separator = line.indexOf(":");

    if (separator === -1) {
      throw new TemperamentParseError(`line ${lineNumber}: no key (expected "key: value")`);
    }

    const key = line.slice(0, separator).trim();

    if (!KEY_RE.test(key)) {
      throw new TemperamentParseError(`line ${lineNumber}: bad key name (${key})`);
    }

    const rest = line.slice(separator + 1).trim();

    if (!indented) {
      if (rest !== "") {
        throw new TemperamentParseError(
          `line ${lineNumber}: top-level keys carry no value; every parameter lives in a group`,
        );
      }
      if (result[key] !== undefined) {
        throw new TemperamentParseError(`line ${lineNumber}: duplicate group (${key})`);
      }
      result[key] = {};
      group = key;
      return;
    }

    if (group === null) {
      throw new TemperamentParseError(`line ${lineNumber}: indented key before any group`);
    }

    const bucket = result[group];

    if (bucket === undefined) {
      throw new TemperamentParseError(`line ${lineNumber}: group ${group} vanished`);
    }

    if (bucket[key] !== undefined) {
      throw new TemperamentParseError(`line ${lineNumber}: duplicate key ${group}.${key}`);
    }

    bucket[key] = parseScalar(rest, lineNumber);
  });

  return result;
}

const probability = z.number().min(0).max(1);

// .strict() throughout: an unknown key is an error, so this schema -- not the
// YAML file -- is the single answer to "what parameters exist".
export const temperamentSchema = z
  .object({
    inhibition: z
      .object({ base_threshold: probability, uncertainty_weight: z.number() })
      .strict(),
    curiosity: z
      .object({ gain: z.number(), target_error_band: z.tuple([probability, probability]) })
      .strict(),
    attachment: z.object({ figure: z.string().min(1), memory_weight: z.number() }).strict(),
    memory: z.object({ surprise_weight: z.number() }).strict(),
    agency: z
      .object({ contingency_floor: probability, contingency_confidence: probability })
      .strict(),
    differentiation: z.object({ imitation_retention_threshold: probability }).strict(),
  })
  .strict();

export type Temperament = z.infer<typeof temperamentSchema>;

export type Milestone = "M0" | "M1" | "M2" | "M3" | "M4" | "M5";

/**
 * Which milestone's mechanism is supposed to read each parameter.
 *
 * A key nobody reads is decoration -- exactly what "does it exist in the database
 * when nobody is looking?" is meant to catch. temperament.test.ts turns an orphan
 * into a build failure once its milestone has landed.
 */
export const TEMPERAMENT_CONSUMERS: Readonly<Record<string, Milestone>> = {
  "inhibition.base_threshold": "M3",
  "inhibition.uncertainty_weight": "M3",
  "curiosity.gain": "M2",
  "curiosity.target_error_band": "M2",
  "attachment.figure": "M0",
  "attachment.memory_weight": "M2",
  "memory.surprise_weight": "M2",
  "agency.contingency_floor": "M5",
  "agency.contingency_confidence": "M5",
  "differentiation.imitation_retention_threshold": "M4",
};

/**
 * Bump by hand as milestones land. Deliberately manual: deriving "has M3 shipped?"
 * from the code would let a half-built mechanism mark itself done.
 */
export const LANDED_MILESTONES: readonly Milestone[] = ["M0", "M1", "M2", "M3", "M4"];

/**
 * Parameters whose consumer milestone has landed and which nothing reads.
 *
 * Matching is on the full `group.leaf` accessor, never the bare leaf: a leaf like
 * `figure` or `gain` occurs as a substring of ordinary English ("figures", "again")
 * all over the codebase, so a bare-leaf search reports every key as read and the
 * guard silently stops guarding.
 *
 * Exported so the guard itself can be tested against a synthetic orphan. A test
 * that cannot be shown to fail is worse than no test.
 */
export function findOrphanParameters(
  sources: readonly string[],
  consumers: Readonly<Record<string, Milestone>> = TEMPERAMENT_CONSUMERS,
  landed: readonly Milestone[] = LANDED_MILESTONES,
): readonly string[] {
  const orphans: string[] = [];

  for (const [key, milestone] of Object.entries(consumers)) {
    if (!landed.includes(milestone)) {
      continue;
    }

    if (!sources.some((source) => source.includes(key))) {
      orphans.push(`${key} (consumer ${milestone} has landed)`);
    }
  }

  return orphans;
}

// import.meta.url, not a path relative to dist/: tsc does not copy .yaml, and
// Akuki's entry points run through tsx against src/ directly. If this code is ever
// bundled, the seed files must be copied alongside it.
export const TEMPERAMENT_PATH = fileURLToPath(new URL("./temperament.yaml", import.meta.url));

export function loadTemperament(path: string = TEMPERAMENT_PATH): Temperament {
  return temperamentSchema.parse(parseTemperamentYaml(readFileSync(path, "utf8")));
}
