import type { Episode, EpisodeStats } from "../memory/episodic/index.js";
import type { StreamEntryKind } from "../stream/index.js";

import type { OfflineContext } from "./types.js";

// Entry kinds that are the being's own acts: something it said, or a tool it used.
const OWN_ACTION_KINDS: ReadonlySet<StreamEntryKind> = new Set(["agent_msg", "tool_call"]);

// Kept below SQLite's bound-parameter limit on older builds.
const LOOKUP_CHUNK_SIZE = 500;

// Whether the being engaged with an episode: it was recalled into a later turn,
// or the episode was built from the being's own utterance or tool call. This is
// read from the being's own state, never from who else was speaking.
export function isEpisodeEngaged(
  episode: Pick<Episode, "source_stream_ids">,
  stats: Pick<EpisodeStats, "retrieval_count"> | null,
  ownActionEntryIds: ReadonlySet<string>,
): boolean {
  if (stats !== null && stats.retrieval_count > 0) {
    return true;
  }

  return episode.source_stream_ids.some((entryId) => ownActionEntryIds.has(entryId));
}

// The source entries of these episodes that are the being's own acts.
export function ownActionEntryIds(
  ctx: Pick<OfflineContext, "entryIndex">,
  episodes: readonly Pick<Episode, "source_stream_ids">[],
): Set<string> {
  const entryIds = [...new Set(episodes.flatMap((episode) => episode.source_stream_ids))];
  const own = new Set<string>();

  for (let start = 0; start < entryIds.length; start += LOOKUP_CHUNK_SIZE) {
    const records = ctx.entryIndex.lookupMany(entryIds.slice(start, start + LOOKUP_CHUNK_SIZE));

    for (const [entryId, record] of records) {
      if (record.kind !== null && OWN_ACTION_KINDS.has(record.kind)) {
        own.add(entryId);
      }
    }
  }

  return own;
}
