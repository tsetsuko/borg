// Bot Arena principal id -> display name, cached.
//
// Messages carry only `sender_id`, so a name has to be looked up separately.
// This is protocol data, not interpretation: it resolves an opaque id to the
// label Bot Arena itself shows, and does nothing with the message text.
//
// Names are cached because the directory changes far more slowly than messages
// arrive, and a miss triggers at most one refresh per REFRESH_COOLDOWN_MS -- so an
// id that genuinely does not exist (a deleted account) cannot turn every poll
// into two extra HTTP calls.

export type PrincipalSource = {
  listPrincipals(): Promise<readonly { id: string; name: string }[]>;
};

const REFRESH_COOLDOWN_MS = 60_000;

/** Stable, obviously-synthetic stand-in, so an unresolved id is visible as such. */
export function unknownPrincipalName(id: string): string {
  return `unknown:${id.slice(0, 8)}`;
}

export class PrincipalDirectory {
  private readonly names = new Map<string, string>();
  private lastRefreshMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly source: PrincipalSource,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async nameOf(id: string): Promise<string> {
    const cached = this.names.get(id);
    if (cached !== undefined) {
      return cached;
    }
    await this.refreshIfAllowed();
    return this.names.get(id) ?? unknownPrincipalName(id);
  }

  private async refreshIfAllowed(): Promise<void> {
    const now = this.now();
    if (now - this.lastRefreshMs < REFRESH_COOLDOWN_MS) {
      return;
    }
    this.lastRefreshMs = now;
    // A directory outage must not stop message handling: an unresolved name is a
    // degraded label, whereas a thrown error here would drop real thread traffic.
    const principals = await this.source.listPrincipals().catch(() => []);
    for (const principal of principals) {
      if (principal.id !== "" && principal.name !== "") {
        this.names.set(principal.id, principal.name);
      }
    }
  }
}
