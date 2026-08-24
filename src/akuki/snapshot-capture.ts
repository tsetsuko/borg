// Akuki: capture a snapshot from a tenant directory WITHOUT opening the live one.
//
// The copy-then-open-read-only shape is taken from scripts/snapshot-kept-data.ts:42-63.
// It matters for two reasons: borg is single-writer (opening the live dir while a
// connector holds it risks lock contention or corruption), and a snapshot must never
// mutate the thing it measures.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { Borg, FakeEmbeddingClient } from "../index.js";
import { FakeLLMClient } from "../llm/test-support/fake-client.js";
import { buildAkukiSnapshot, type AkukiSnapshot } from "./snapshot.js";

const DEFAULT_DIMS = 1024;

// The copy's LanceDB tables were written at the real model's width, so the fake
// embedding client must be built at that same width or the vector store is rejected.
function readEmbeddingDims(dataDir: string): number {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
    const dims = (raw as { embedding?: { dims?: unknown } })?.embedding?.dims;
    return typeof dims === "number" && Number.isInteger(dims) && dims > 0 ? dims : DEFAULT_DIMS;
  } catch {
    return DEFAULT_DIMS;
  }
}

export type CaptureAkukiSnapshotOptions = {
  dataDir: string;
  tenant?: string;
  capturedAtMs: number;
  outDir?: string;
};

export type CaptureAkukiSnapshotResult = {
  snapshot: AkukiSnapshot;
  path: string | null;
};

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
}

export async function captureAkukiSnapshot(
  options: CaptureAkukiSnapshotOptions,
): Promise<CaptureAkukiSnapshotResult> {
  const tenant = options.tenant ?? basename(options.dataDir);
  const dims = readEmbeddingDims(options.dataDir);

  const tempRoot = mkdtempSync(join(tmpdir(), "akuki-snapshot-"));
  const copiedDir = join(tempRoot, tenant);
  let borg: Borg | null = null;

  try {
    cpSync(options.dataDir, copiedDir, { recursive: true, dereference: true });

    // Fakes on purpose: a snapshot must not make a single provider call. Fake
    // embeddings carry no semantic signal, which is irrelevant here because nothing
    // is being embedded or retrieved -- we only read rows.
    borg = await Borg.open({
      dataDir: copiedDir,
      embeddingDimensions: dims,
      embeddingClient: new FakeEmbeddingClient(dims),
      llmClient: new FakeLLMClient(),
      liveExtraction: false,
    });

    const snapshot = await buildAkukiSnapshot({
      borg,
      tenant,
      capturedAtMs: options.capturedAtMs,
    });

    let path: string | null = null;
    if (options.outDir !== undefined) {
      mkdirSync(options.outDir, { recursive: true });
      path = join(options.outDir, `${tenant}-${stamp(options.capturedAtMs)}.json`);
      writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    }

    return { snapshot, path };
  } finally {
    if (borg !== null) {
      await borg.close();
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
