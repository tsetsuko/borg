// Akuki: read-only inspection of what M2/M3 recorded, for a human watching a
// conversation. Opens the tenant, reads the ledgers, recomputes the M3 inhibition
// signal for the current partner, and returns a plain report. Runs no turn and makes
// no model or embedding calls.

import { openBorgDependencies } from "../borg/open.js";
import { closeBorgDependencies } from "../borg/lifecycle.js";
import {
  computeCautionBump,
  computeInhibitionSignal,
  computePartnerPredictability,
} from "../cognition/inhibition/index.js";
import type { SessionId } from "../util/ids.js";
import { applyAkukiPredictionEnv } from "./prediction-config.js";
import { buildAkukiClients } from "./tenant.js";

export type AkukiInspectOptions = {
  dataDir: string;
  env?: NodeJS.ProcessEnv;
  sessionId?: string;
  /** Partner name to compute the M3 inhibition signal against (default: Zosia). */
  audience?: string;
};

export type AkukiInspectReport = {
  sessionId: string;
  identityEvents: {
    id: number;
    recordType: string;
    action: string;
    reason: string | null;
    provenanceKind: string;
    newValue: unknown;
  }[];
  predictions: {
    openExpectations: { content: string; about: string | null; turnId: string }[];
    reconciliations: {
      content: string;
      errorMagnitude: number | null;
      aboutEntityId: string | null;
      turnId: string;
    }[];
  };
  inhibition:
    | {
        partner: string;
        partnerResolved: boolean;
        interactionCount: number;
        recentPartnerErrors: number[];
        partnerPredictability: number;
        currentValence: number;
        cautionBump: number;
        attachmentFigurePresent: boolean;
        signal: number;
      }
    | null;
};

function currentValenceFor(
  moodRepository: { current: (sessionId: SessionId) => { valence: number } },
  sessionId: SessionId,
): number {
  try {
    return moodRepository.current(sessionId).valence;
  } catch {
    return 0;
  }
}

export async function runAkukiInspect(options: AkukiInspectOptions): Promise<AkukiInspectReport> {
  const env = options.env ?? process.env;
  const sessionId = (options.sessionId ?? "default") as SessionId;
  const audience = options.audience ?? "Zosia";

  applyAkukiPredictionEnv(env);
  const clients = buildAkukiClients({ env });
  const deps = await openBorgDependencies({
    dataDir: options.dataDir,
    env,
    llmClient: clients.llmClient,
    ...(clients.embeddingClient ? { embeddingClient: clients.embeddingClient } : {}),
  });

  try {
    const identityEvents = deps.identityEventRepository.list({ limit: 5 }).map((event) => ({
      id: event.id,
      recordType: event.record_type,
      action: event.action,
      reason: event.reason,
      provenanceKind: event.provenance.kind,
      newValue: event.new_value,
    }));

    const openExpectations = deps.predictionRepository.listOpen({ limit: 10 }).map((row) => ({
      content: row.content,
      about: row.about,
      turnId: row.turn_id,
    }));
    const reconciliations = deps.predictionRepository
      .listReconciliationsSince({ sinceMs: 0, limit: 10 })
      .map((row) => ({
        content: row.content,
        errorMagnitude: row.error_magnitude,
        aboutEntityId: row.about_entity_id,
        turnId: row.turn_id,
      }));

    const inhibitionConfig = deps.config.inhibition;
    const partnerId = deps.entityRepository.findByName(audience);

    let inhibition: AkukiInspectReport["inhibition"] = null;
    if (partnerId !== null) {
      const interactionCount = deps.socialRepository.getProfile(partnerId)?.interaction_count ?? 0;
      const recentPartnerErrors = deps.predictionRepository
        .listReconciliationsForEntity({
          aboutEntityId: partnerId,
          limit: inhibitionConfig.recentErrorWindow,
        })
        .flatMap((row) => (row.error_magnitude === null ? [] : [row.error_magnitude]));
      const partnerPredictability = computePartnerPredictability({
        interactionCount,
        recentErrorMagnitudes: recentPartnerErrors,
        familiarityScale: inhibitionConfig.familiarityScale,
      });
      const figureName = deps.config.prediction.attachmentFigureName;
      const figureId = figureName === null ? null : deps.entityRepository.findByName(figureName);
      const currentValence = currentValenceFor(deps.moodRepository, sessionId);
      const cautionBump = computeCautionBump({
        currentValence,
        cautionWeight: inhibitionConfig.cautionWeight,
      });
      const attachmentFigurePresent = figureId !== null && partnerId === figureId;
      const signal = computeInhibitionSignal({
        baseThreshold: inhibitionConfig.baseThreshold,
        uncertaintyWeight: inhibitionConfig.uncertaintyWeight,
        partnerPredictability,
        attachmentFigurePresent,
        presenceRelief: inhibitionConfig.presenceRelief,
        cautionBump,
      });
      inhibition = {
        partner: audience,
        partnerResolved: true,
        interactionCount,
        recentPartnerErrors,
        partnerPredictability,
        currentValence,
        cautionBump,
        attachmentFigurePresent,
        signal,
      };
    } else {
      inhibition = {
        partner: audience,
        partnerResolved: false,
        interactionCount: 0,
        recentPartnerErrors: [],
        partnerPredictability: 0,
        currentValence: 0,
        cautionBump: 0,
        attachmentFigurePresent: false,
        signal: inhibitionConfig.baseThreshold,
      };
    }

    return { sessionId, identityEvents, predictions: { openExpectations, reconciliations }, inhibition };
  } finally {
    await closeBorgDependencies(deps);
  }
}
