import { z } from "zod";

import {
  entityIdHelpers,
  episodeIdHelpers,
  isSessionId,
  predictionEventIdHelpers,
  streamEntryIdHelpers,
  type EntityId,
  type EpisodeId,
  type PredictionEventId,
  type SessionId,
  type StreamEntryId,
} from "../../util/ids.js";

export const PREDICTION_EVENT_KINDS = ["expectation", "reconciliation"] as const;
export type PredictionEventKind = (typeof PREDICTION_EVENT_KINDS)[number];

export const predictionEventIdSchema = z
  .string()
  .refine((value) => predictionEventIdHelpers.is(value), { message: "Invalid prediction event id" })
  .transform((value) => value as PredictionEventId);

export const predictionSessionIdSchema = z
  .string()
  .refine((value) => isSessionId(value), { message: "Invalid prediction session id" })
  .transform((value) => value as SessionId);

export const predictionEntityIdSchema = z
  .string()
  .refine((value) => entityIdHelpers.is(value), { message: "Invalid prediction entity id" })
  .transform((value) => value as EntityId);

export const predictionEpisodeIdSchema = z
  .string()
  .refine((value) => episodeIdHelpers.is(value), { message: "Invalid prediction episode id" })
  .transform((value) => value as EpisodeId);

export const predictionStreamEntryIdSchema = z
  .string()
  .refine((value) => streamEntryIdHelpers.is(value), {
    message: "Invalid prediction stream entry id",
  })
  .transform((value) => value as StreamEntryId);

export const predictionEventKindSchema = z.enum(PREDICTION_EVENT_KINDS);

// error_magnitude is the MODEL's own surprise appraisal (0 = exactly as expected,
// 1 = fully surprised), carried verbatim. The harness only stores and later scales
// it; it never derives it from a text diff. Present only on reconciliation rows.
export const predictionEventSchema = z
  .object({
    id: predictionEventIdSchema,
    prediction_id: predictionEventIdSchema,
    kind: predictionEventKindSchema,
    created_ts: z.number().int().finite(),
    session_id: predictionSessionIdSchema,
    turn_id: z.string().min(1),
    content: z.string().min(1),
    about: z.string().min(1).nullable(),
    about_entity_id: predictionEntityIdSchema.nullable(),
    origin_audience: z.string().min(1).nullable(),
    error_magnitude: z.number().min(0).max(1).nullable(),
    episode_ids: z.array(predictionEpisodeIdSchema),
    source_stream_ids: z.array(predictionStreamEntryIdSchema),
    created_at: z.number().int().finite(),
  })
  .strict();

export type PredictionEvent = z.infer<typeof predictionEventSchema>;
