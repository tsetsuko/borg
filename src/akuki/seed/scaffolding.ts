// Akuki: reader for seed/scaffolding.md.
//
// The markdown file is the source of truth in git; this turns it into per-prompt-key
// text. Everything before the first `## FAKTY` heading is documentation for humans
// and is ignored, so the reasoning can live next to the rules without leaking into
// Akuki's prompt.
//
// Shape:
//   ## FAKTY              -- initial conditions, untagged (they are not regulation)
//   ### <prompt_key>
//   - text, continued on indented lines
//
//   ## REGULY             -- every rule tagged
//   ### <prompt_key>
//   - [PERMANENT: tag] text
//   - [removable: tag] text

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROMPT_BLOCKS, PROMPT_KEYS, type PromptKey } from "../../cognition/prompts/registry.js";

export class ScaffoldingParseError extends Error {}

export type ScaffoldingFact = { key: PromptKey; text: string };
export type ScaffoldingRule = {
  key: PromptKey;
  tag: string;
  permanent: boolean;
  text: string;
};

export type Scaffolding = {
  facts: readonly ScaffoldingFact[];
  rules: readonly ScaffoldingRule[];
};

const TAG_RE = /^\[(PERMANENT|removable):\s*([a-z0-9-]+)\]\s*(.*)$/;

function assertPromptKey(candidate: string, line: number): PromptKey {
  const match = PROMPT_KEYS.find((key) => key === candidate);

  if (match === undefined) {
    throw new ScaffoldingParseError(
      `line ${line}: "${candidate}" is not one of borg's overridable prompt keys (${PROMPT_KEYS.join(", ")})`,
    );
  }

  return match;
}

export function parseScaffolding(source: string): Scaffolding {
  const facts: ScaffoldingFact[] = [];
  const rules: ScaffoldingRule[] = [];

  let section: "facts" | "rules" | null = null;
  let key: PromptKey | null = null;
  let pending: string[] | null = null;
  let pendingLine = 0;

  const flush = (): void => {
    if (pending === null) {
      return;
    }

    const text = pending.join(" ").replace(/\s+/g, " ").trim();
    pending = null;

    if (text === "") {
      throw new ScaffoldingParseError(`line ${pendingLine}: empty bullet`);
    }

    if (key === null) {
      throw new ScaffoldingParseError(`line ${pendingLine}: bullet before any ### prompt key`);
    }

    if (section === "facts") {
      if (TAG_RE.test(text)) {
        throw new ScaffoldingParseError(
          `line ${pendingLine}: a FAKT must not be tagged -- facts are initial conditions, not regulation`,
        );
      }
      facts.push({ key, text });
      return;
    }

    const tagged = TAG_RE.exec(text);

    if (tagged === null) {
      throw new ScaffoldingParseError(
        `line ${pendingLine}: every rule needs [PERMANENT: tag] or [removable: tag]`,
      );
    }

    const [, kind, tag, body] = tagged;

    if (body === undefined || body.trim() === "") {
      throw new ScaffoldingParseError(`line ${pendingLine}: rule ${tag ?? "?"} has a tag but no text`);
    }

    rules.push({
      key,
      tag: tag as string,
      permanent: kind === "PERMANENT",
      text: body.trim(),
    });
  };

  source.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trimEnd();
    const lineNumber = index + 1;

    if (line.startsWith("## ")) {
      flush();
      const heading = line.slice(3).trim();
      section = heading === "FAKTY" ? "facts" : heading === "REGULY" ? "rules" : null;
      key = null;
      return;
    }

    if (line.startsWith("### ")) {
      flush();
      if (section === null) {
        // A ### inside the documentation preamble; not a prompt key.
        key = null;
        return;
      }
      key = assertPromptKey(line.slice(4).trim(), lineNumber);
      return;
    }

    if (section === null) {
      return;
    }

    if (line.startsWith("- ")) {
      flush();
      pending = [line.slice(2).trim()];
      pendingLine = lineNumber;
      return;
    }

    if (pending !== null && /^\s+\S/.test(line)) {
      pending.push(line.trim());
      return;
    }

    flush();
  });

  flush();

  const seen = new Set<string>();

  for (const rule of rules) {
    if (seen.has(rule.tag)) {
      throw new ScaffoldingParseError(`duplicate rule tag: ${rule.tag}`);
    }
    seen.add(rule.tag);
  }

  return { facts, rules };
}

/**
 * Facts and rules for one prompt key, appended AFTER borg's own default text.
 *
 * Appending rather than replacing is not a style choice. borg's defaults carry
 * working machinery -- epistemic_posture is where "name the unresolved question so
 * my reflection loop catches it afterward" lives, which is the mechanism that
 * produces open questions at all. Replacing that block would silently switch off
 * the thing this milestone exists to observe. Appending also keeps borg's text as
 * a stable cache prefix with Akuki's prose at the end.
 */
export function compileScaffolding(
  scaffolding: Scaffolding,
  options: { omitDefaults?: boolean } = {},
): ReadonlyMap<PromptKey, string> {
  const byKey = new Map<PromptKey, string[]>();

  const push = (key: PromptKey, text: string): void => {
    const bucket = byKey.get(key);
    if (bucket === undefined) {
      byKey.set(key, [text]);
      return;
    }
    bucket.push(text);
  };

  for (const fact of scaffolding.facts) {
    push(fact.key, fact.text);
  }

  for (const rule of scaffolding.rules) {
    push(rule.key, rule.text);
  }

  const compiled = new Map<PromptKey, string>();

  for (const [key, parts] of byKey) {
    const own = parts.join("\n");

    if (options.omitDefaults === true) {
      compiled.set(key, own);
      continue;
    }

    const spec = PROMPT_BLOCKS.find((candidate) => candidate.key === key);

    if (spec === undefined) {
      throw new ScaffoldingParseError(`no default block registered for ${key}`);
    }

    compiled.set(key, `${spec.default}\n${own}`);
  }

  return compiled;
}

export const SCAFFOLDING_PATH = fileURLToPath(new URL("./scaffolding.md", import.meta.url));

export function loadScaffolding(path: string = SCAFFOLDING_PATH): Scaffolding {
  return parseScaffolding(readFileSync(path, "utf8"));
}
