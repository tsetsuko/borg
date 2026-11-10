import {
  MEMORY_DISCLOSURE_INTERNAL_USE_NOTE,
  SEMANTIC_SOURCE_DISCLOSURE_INTERNAL_USE_NOTE,
  memoryDisclosureLabelFromMetadata,
  renderMemoryDisclosureLabelFieldsForModel,
} from "../../memory/common/disclosure-label.js";
import { renderFrameAnomalyAnnotations } from "../../stream/frame-anomaly.js";
import type { EvidenceLedgerEntry, EvidenceLedgerSection } from "./types.js";

// The internal-use sentences, said once for the whole ledger instead of on every labelled row.
// Builders attach a row's disclosure label twice -- rendered into `state` and as a
// `disclosure_label` object in `state_metadata` -- and each copy carries one of these sentences.
// The row keeps one copy of the label's fields; the sentence lives here. The object stays on the
// entry for code that reads it (the compact finalizer layout); only the printed row drops it.
export const LEDGER_DISCLOSURE_GUIDANCE = [
  `Rows with a disclosure_class other than public: ${MEMORY_DISCLOSURE_INTERNAL_USE_NOTE}.`,
  `Rows marked source_details=private are ${SEMANTIC_SOURCE_DISCLOSURE_INTERNAL_USE_NOTE}.`,
].join("\n");

const PRINTED_DISCLOSURE_METADATA_KEYS = new Set(["disclosure_label", "disclosure_note"]);

function rowDisclosure(entry: EvidenceLedgerEntry): {
  state: string | undefined;
  stateMetadata: Record<string, unknown> | undefined;
} {
  const metadata = entry.state_metadata;
  const semanticSource =
    metadata?.["disclosure_note"] === SEMANTIC_SOURCE_DISCLOSURE_INTERNAL_USE_NOTE ||
    entry.state?.includes(SEMANTIC_SOURCE_DISCLOSURE_INTERNAL_USE_NOTE) === true;
  let state = entry.state
    ?.replace(`; ${SEMANTIC_SOURCE_DISCLOSURE_INTERNAL_USE_NOTE}`, "")
    .replace(`; ${MEMORY_DISCLOSURE_INTERNAL_USE_NOTE}`, "");
  const label =
    metadata === undefined ? null : memoryDisclosureLabelFromMetadata(metadata["disclosure_label"]);

  // A row whose label sits only in the metadata object still prints it once.
  if (
    label !== null &&
    label.disclosureClass !== "public" &&
    state?.includes("disclosure_class=") !== true
  ) {
    const fields = renderMemoryDisclosureLabelFieldsForModel(label);
    state = state === undefined || state.length === 0 ? fields : `${state} ${fields}`;
  }

  if (semanticSource) {
    state =
      state === undefined || state.length === 0
        ? "source_details=private"
        : `${state} source_details=private`;
  }

  const rest =
    metadata === undefined
      ? {}
      : Object.fromEntries(
          Object.entries(metadata).filter(([key]) => !PRINTED_DISCLOSURE_METADATA_KEYS.has(key)),
        );

  return { state, stateMetadata: Object.keys(rest).length === 0 ? undefined : rest };
}

// Printed for the model only; code reads the entry object, never this text. What a row
// prints is who and where it comes from, its source handles, its state and disclosure label,
// and taint or self-report class when they carry information. Ranking and bookkeeping fields
// (trust_rank, citation_type, stream_index, salience_class, via_retrieval, taint=none) stay on
// the entry and are not printed: section order already ranks sources, and the hierarchy
// guidance says it in words.
export function renderEntry(entry: EvidenceLedgerEntry): string {
  const disclosure = rowDisclosure(entry);
  const stateMetadata =
    disclosure.stateMetadata === undefined ? undefined : JSON.stringify(disclosure.stateMetadata);
  const metadata = [
    `id=${entry.id}`,
    `source_type=${entry.source_type}`,
    `scope=${entry.session_scope}`,
    `actor=${entry.actor}`,
    entry.citations === undefined || entry.citations.length === 0
      ? null
      : `[citation: ${entry.citations.join(", ")}]`,
    disclosure.state === undefined || disclosure.state.length === 0
      ? null
      : `state=${disclosure.state}`,
    stateMetadata === undefined ? null : `state_metadata=${stateMetadata}`,
    entry.taint === undefined || entry.taint === "none" ? null : `taint=${entry.taint}`,
    entry.persistence_class === undefined ? null : `persistence_class=${entry.persistence_class}`,
  ].filter((part): part is string => part !== null);
  const body = [
    renderFrameAnomalyAnnotations(entry.frame_anomalies) || null,
    entry.value === undefined ? null : `  value: ${entry.value}`,
    entry.text === undefined ? null : `  text:\n${entry.text}`,
  ].filter((part): part is string => part !== null);

  return [`- ${metadata.join(" ")}`, ...body].join("\n");
}

export function renderSection(section: EvidenceLedgerSection): string {
  // framing.counts (rows assembled, folded out, omitted) is pipeline bookkeeping for the trace;
  // it is not printed for the model.
  const framingLines = section.framing === undefined ? [] : [`framing: ${section.framing.text}`];

  if (section.entries.length === 0) {
    return [`## ${section.label}`, ...framingLines, "No entries."].join("\n");
  }

  const sourceTypes = [...new Set(section.entries.map((entry) => entry.source_type))].join(", ");
  const scopes = [...new Set(section.entries.map((entry) => entry.session_scope))].join(", ");

  return [
    `## ${section.label}`,
    ...framingLines,
    `source_types: ${sourceTypes}`,
    `scopes: ${scopes}`,
    ...section.entries.map((entry) => renderEntry(entry)),
  ].join("\n");
}
