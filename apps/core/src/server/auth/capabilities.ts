// Capabilities — the ONE place that answers "is this actor allowed to do that?".
//
// Encore has no host, no admin identity and no hooks.server.ts. The socket's `singerId` was resolved at
// upgrade and then used only to drive presence, so nothing was ever authorized against it: any socket —
// including one that had never joined — could pause, skip or seek the room's music.
//
// Today every joined singer is a host. That is Angelo's call, first made 2026-09-04 and CONFIRMED
// 2026-09-09 across all five authority questions. It is the honest state of a self-hosted
// box on someone's living-room LAN: there is no operator to be, and inventing an admin password for a
// party is worse than the exposure. What this module buys is that the DECISION lives in one function
// instead of being spread across call sites as an implicit assumption, so gating it later — a host
// role, an ENCORE_HOST_TOKEN, a first-joiner-is-host rule — is an edit HERE and nowhere else.
//
// The five rulings (2026-09-09), all "any joined singer" — the published, non-source
// statement of record is docs/ux/05-concurrency.md § "Owner rulings", which this comment must stay
// consistent with:
//   - player:control       — skip (Q1) and the live guide/pitch/range controls (Q2) stay open to anyone.
//   - queue:reorder-any     — cross-singer reorder (Q4) stays open to everyone; pinning is being removed
//                             entirely by #856, so this capability effectively resolves to "anyone".
//   - settings:write-global — deployment-scoped settings (Q3) stay open to any joined singer, accepted.
//   - settings:write-room   — room-scoped settings stay open (safe for anyone by construction).
//   - queue:remove-any      — removing someone else's entry stays open.
// Q5 (queue-depth cap) ruled A: no per-singer depth cap; validateCommand's add arm stays uncapped. The
// unrelated cook cap MAX_CONCURRENT_COOKS_PER_SINGER = 3 is kept.
//
// The one thing it does enforce now: you must be a person in the room. That is not a host gate, it is
// the difference between a guest and a stranger's script.

export type Capability =
	/** Pause, resume, skip, restart, seek, key-shift the current song. */
	| 'player:control'
	/** Remove someone else's queue entry. */
	| 'queue:remove-any'
	/** Reorder someone else's queue entry. */
	| 'queue:reorder-any'
	/** Change this room's own policy (pacing, quality ceiling, grace window). */
	| 'settings:write-room'
	/** Change deployment-wide separator and cook policy. */
	| 'settings:write-global';

export interface Actor {
	/** Resolved from the session cookie at WS upgrade, or from the cookie on an HTTP request. */
	singerId?: string;
}

/**
 * Whether `actor` may do `capability`.
 *
 * Deliberately ignores `capability` today — every joined singer holds all of them. It is a parameter
 * because the call sites should already be asking the specific question they mean, so narrowing one
 * capability later does not require finding and rewriting them.
 */
export function can(actor: Actor | null | undefined, _capability: Capability): boolean {
	return Boolean(actor?.singerId);
}
