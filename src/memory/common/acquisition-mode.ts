import { z } from "zod";

import { entityIdHelpers, type EntityId } from "../../util/ids.js";

// M4: HOW something was acquired, which is a different axis from where it came
// from in the pipeline (provenance_kind). Hearsay, something watched in someone
// else's behaviour, something reasoned out, and something the entity tested for
// itself are four different standings for the same content, and only the last
// one is properly the entity's own.
//
// The axis is shared by two memory bands on purpose. Beliefs were first
// (semantic_nodes, M4). Skills followed (skills, TASK-028), because a procedure
// copied from a stronger peer and a procedure found alone are the same
// mimicry-versus-differentiation distinction, and one vocabulary keeps the two
// bands comparable instead of drifting apart.
export const ACQUISITION_MODES = [
  "told_by",
  "observed_from",
  "inferred",
  "tested_independently",
] as const;

export type AcquisitionMode = (typeof ACQUISITION_MODES)[number];

export const acquisitionModeSchema = z.enum(ACQUISITION_MODES);

/**
 * Who the content was acquired from, when the mode implies someone: a repository
 * entity id, so it joins to that person's per-domain trust rather than to a name
 * string. Null when the source is not a known entity.
 */
export const acquiredFromEntityIdSchema = z
  .string()
  .refine((value) => entityIdHelpers.is(value), {
    message: "Invalid entity id",
  })
  .transform((value) => value as EntityId);

/** The two modes that name another party as the source of the content. */
export function acquisitionModeImpliesSource(mode: AcquisitionMode): boolean {
  return mode === "told_by" || mode === "observed_from";
}
