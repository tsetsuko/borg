// The cognition side of the seam: a normalized Arena message in, Akuki's reply
// or his silence out.
//
// This is the ONLY file in this directory that knows borg exists. It takes an
// already-open Borg and never opens or closes one: opening per message would mean
// the maintenance scheduler is never started (Borg.open does not start it -- only
// a runtime does, see src/config/index.ts:684), and then the consolidator,
// reflector and the rest of the dream cycle would never run. Akuki's memory would
// grow and never consolidate, which is the architecture not working rather than a
// deployment detail.
//
// WHY IT PASSES senderEntityId, and what breaks without it. An Arena thread has
// several speakers. borg derives M4's trust partner from
// `actionSpeaker.entityId ?? audienceEntityId`
// (src/cognition/lifecycle/turn-phase/extraction-phase.ts:337) and drops trust
// evidence entirely when the partner is null
// (src/cognition/social-trust/domain-trust-turn-service.ts:45). The speaker only
// becomes available when the resolved audience entity is a GROUP: the coordinator
// falls back to `turnInput.senderEntityId` for the social exchange precisely in
// that case (src/cognition/lifecycle/turn-phase-coordinator.ts:977-983). So the
// thread's audience entity is ensured with kind "group" BEFORE the turn, and the
// author is passed as the sender. Skip either and a whole thread collapses into
// one partner -- the channel -- and per-person trust (M4) and per-partner
// predictability (M3) measure the wrong thing.
//
// WHY IT DOES NOT BUILD AN ENVELOPE. borg already renders the speaker to the
// model as a `sender_display_name` attribute on the message
// (src/cognition/turn-input.ts:219). Prefixing "Zosia: ..." here would duplicate
// that attribution and push transport formatting into content the model then has
// to interpret. The raw text is passed through unchanged.

import type { Borg } from "../../index.js";
import { createSessionId, parseSessionId } from "../../util/ids.js";
import type { AkukiReply, AkukiRunner, IncomingArenaMessage } from "./contract.js";
import type { ArenaLog } from "./adapter.js";
import type { ArenaStateStore } from "./state.js";

/**
 * Routing/label key for this transport. `source_type` is an open lowercase slug
 * that borg never branches on (src/sessions/types.ts:15-22), so registering a new
 * one needs no change inside borg.
 */
export const BOTARENA_SOURCE_TYPE = "botarena";

/** Namespace for external principal ids, so a Bot Arena id cannot collide with another transport's. */
const BOTARENA_ENTITY_SOURCE = "botarena";

/**
 * Audience label for a thread, derived from the thread's immutable id rather than
 * its name: it survives a rename, and it cannot collide with a person or group who
 * happens to share the thread's display name.
 */
export function arenaAudienceLabel(threadId: string): string {
  return `botarena_thread:${threadId}`;
}

export type ArenaAkukiRunnerOptions = {
  borg: Borg;
  state: Pick<ArenaStateStore, "getSessionId" | "putSessionId">;
  log?: ArenaLog;
};

export class ArenaAkukiRunner implements AkukiRunner {
  private readonly log: ArenaLog;

  constructor(private readonly options: ArenaAkukiRunnerOptions) {
    this.log = options.log ?? (() => {});
  }

  async handleMessage(message: IncomingArenaMessage): Promise<AkukiReply> {
    const sessionId = this.sessionIdFor(message.threadId);
    const audienceLabel = arenaAudienceLabel(message.threadId);
    const audienceEntityId = this.ensureThreadGroup(message, audienceLabel);
    const senderEntityId = this.resolveAuthor(message);

    this.options.borg.sessions.ensure({
      session_id: sessionId,
      source_type: BOTARENA_SOURCE_TYPE,
      source_external_id: message.threadId,
      // The display name may follow renames; the audience label above may not.
      label: message.threadName === "" ? `botarena thread ${message.threadId}` : message.threadName,
      audience_label: audienceLabel,
      audience_entity_id: audienceEntityId,
      conversation_kind: "thread",
      last_activity_at: message.createdAtMs,
    });

    const result = await this.options.borg.turn({
      userMessage: message.text,
      sessionId,
      senderEntityId,
      audience: audienceLabel,
    });

    this.log(
      "info",
      `turn ${message.threadId}/${message.messageId}: emitted=${result.emitted} ` +
        `kind=${result.emission.kind} path=${result.path} ` +
        `cache_read=${result.usage.cache_read_input_tokens ?? 0} ` +
        `cache_creation=${result.usage.cache_creation_input_tokens ?? 0}`,
    );

    // Silence is a decision, not a failure: M3's gate and borg's emission machinery
    // own it, so an unemitted turn returns null rather than an empty string, which
    // the transport would otherwise try to post.
    return { text: result.emitted ? result.response : null };
  }

  /**
   * One Bot Arena thread is one conversation for Akuki's whole life, so the session
   * id is stored and reused. Minting a new one per process would split a single
   * conversation into many and break the continuity every memory band reads.
   */
  private sessionIdFor(threadId: string) {
    const existing = this.options.state.getSessionId(threadId);
    if (existing !== undefined) {
      return parseSessionId(existing);
    }
    const created = createSessionId();
    this.options.state.putSessionId(threadId, String(created));
    return created;
  }

  private ensureThreadGroup(message: IncomingArenaMessage, audienceLabel: string) {
    // resolve is idempotent on the label. Passing kind explicitly is what makes the
    // coordinator treat the thread as a group and attribute the exchange to the
    // speaker -- see the header.
    return this.options.borg.entities.resolve(audienceLabel, {
      kind: "group",
      provenance: "transport_audience_label",
    });
  }

  private resolveAuthor(message: IncomingArenaMessage) {
    // Keyed on the Bot Arena principal id, not the display name, so renaming a
    // person on the Arena does not create a second entity and split their history.
    // `kind: "person"` for bots too: borg's kinds are person/group/self/abstract,
    // and another bot is a named agent Akuki forms trust about, which "abstract"
    // would not capture. authorType is kept out of the entity on purpose -- it is a
    // transport fact, and inventing an entity kind for it would leak the transport
    // into the memory model.
    return this.options.borg.entities.resolveExternal({
      source: BOTARENA_ENTITY_SOURCE,
      externalId: message.authorId,
      canonicalName: message.authorName,
      kind: "person",
      provenance: "transport_sender",
    });
  }
}
