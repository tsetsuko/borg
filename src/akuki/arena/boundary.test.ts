// AC #4 as a test rather than a promise.
//
// The whole value of splitting transport from cognition is that each half can be
// reviewed without the other. That only holds if the transport half genuinely
// cannot see borg -- and a boundary nobody checks drifts the first time someone
// needs "just one type" from the other side. So this reads the source files and
// fails the build on the import itself.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/** Files that must stay independent of borg, and what each may import. */
const TRANSPORT_FILES = [
  "contract.ts",
  "state.ts",
  "botarena-client.ts",
  "directory.ts",
  "adapter.ts",
  "config.ts",
] as const;

const IMPORT_PATTERN = /^\s*import\s[^;]*?from\s+["']([^"']+)["']/gmu;

/**
 * True when a specifier can only reach a Node built-in or a sibling in this
 * directory. Anything else -- a parent path, or the bare "borg" alias
 * vitest.config.ts maps to src/index.ts -- is a way into borg.
 */
function isLocalOnly(specifier: string): boolean {
  return (
    specifier.startsWith("node:") ||
    (specifier.startsWith("./") && !specifier.includes("/../"))
  );
}

function importsOf(file: string): string[] {
  const source = readFileSync(join(here, file), "utf8");
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1] ?? "");
}

describe("transport/cognition boundary", () => {
  it.each(TRANSPORT_FILES)("%s imports nothing from borg", (file) => {
    for (const specifier of importsOf(file)) {
      expect(
        isLocalOnly(specifier),
        `${file} imports ${specifier}; the transport half must not reach into borg`,
      ).toBe(true);
    }
  });

  it("keeps the contract free of even sibling imports", () => {
    // contract.ts is the seam itself: if it imports anything, both halves inherit
    // that dependency and the split stops meaning anything.
    expect(importsOf("contract.ts")).toEqual([]);
  });

  it("checks the files that actually exist, so a rename cannot silently opt out", () => {
    for (const file of TRANSPORT_FILES) {
      expect(() => readFileSync(join(here, file), "utf8")).not.toThrow();
    }
  });

  it("keeps borg reachable from only the two files that are supposed to reach it", () => {
    // The list above can be forgotten when a file is added. This checks the
    // complement: whatever files exist, only the runner and the composition root
    // may see borg. A new transport file therefore fails here by default rather
    // than quietly joining the wrong side.
    const allowedToImportBorg = new Set(["runner.ts", "service.ts"]);
    const sources = readdirSync(here).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
    );

    expect(sources.length).toBeGreaterThan(TRANSPORT_FILES.length);

    for (const file of sources) {
      const reachesBorg = importsOf(file).some((specifier) => !isLocalOnly(specifier));
      expect(
        !reachesBorg || allowedToImportBorg.has(file),
        `${file} reaches into borg but is not one of ${[...allowedToImportBorg].join(", ")}`,
      ).toBe(true);
    }
  });
});
