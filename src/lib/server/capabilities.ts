// Capabilities — the ONE place that answers "is this actor allowed to do that?". Every joined singer
// holds every capability today: there is no operator identity, so the only real auth axis is anonymous
// vs. holding a session cookie. See docs/ARCHITECTURE.md §10. Centralising the decision here means
// gating it later — a host role, a token, a first-joiner rule — is an edit HERE and nowhere else.

export type Capability =
	/** Pause, resume, skip, restart, seek, key-shift the current song. */
	| 'player:control'
	/** Remove someone else's queue entry. */
	| 'queue:remove-any'
	/** Reorder someone else's queue entry. */
	| 'queue:reorder-any'
	/** Change this room's own policy (pacing, quality ceiling, grace window). */
	| 'settings:write-room'
	/** Change deployment-wide separator and process policy. */
	| 'settings:write-global';

export interface Actor {
	/** Resolved from the session cookie at WS upgrade, or from the cookie on an HTTP request. */
	singerId?: string;
}

/** Whether `actor` may do `capability`. Deliberately ignores `capability` today — every joined singer
 *  holds all of them; kept as a parameter so call sites already ask the specific question they mean,
 *  and narrowing one later needs no find-and-rewrite. */
export function can(actor: Actor | null | undefined, _capability: Capability): boolean {
	return Boolean(actor?.singerId);
}
