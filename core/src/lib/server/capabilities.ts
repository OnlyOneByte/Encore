// Capabilities — the ONE place that answers "is this actor allowed to do that?". A joined singer runs the party;
// the host, holding an `encore_host` session, runs the machine. See docs/SERVER.md#the-host-key.

export type Capability =
	/** Pause, resume, skip, restart, seek the current song. Not its key or guide: those are its singer's alone, an
	 *  ownership rule like On deck's rather than a capability (realtime/player.ts). */
	| 'player:control'
	/** Remove someone else's queue entry. */
	| 'queue:remove-any'
	/** Reorder someone else's queue entry. */
	| 'queue:reorder-any'
	/** Change this room's own policy (pacing, quality ceiling, grace window). */
	| 'settings:write-room'
	/** Change deployment-wide separator and process policy, and the join address. */
	| 'settings:write-global'
	/** Read /metrics, /api/metrics, a song's history on /api/audit/*, and /admin. */
	| 'operator:read'
	/** Delete a song from the library entirely. */
	| 'media:delete'
	/** Change a library song for every room, such as re-picking its lyrics. */
	| 'media:edit';

const HOST_ONLY: ReadonlySet<Capability> = new Set([
	'settings:write-room',
	'settings:write-global',
	'operator:read',
	'media:delete',
	'media:edit'
]);

export interface Actor {
	/** Resolved from the session cookie at WS upgrade, or from the cookie on an HTTP request. */
	singerId?: string;
	/** True only when the request carries a live `encore_host` session. Never set on a socket. */
	host?: boolean;
}

/** Whether `actor` may do `capability`. Host-only capabilities need the host session and nothing else, so an unjoined host phone can still open the operator pages. */
export function can(actor: Actor | null | undefined, capability: Capability): boolean {
	if (HOST_ONLY.has(capability)) return actor?.host === true;
	return Boolean(actor?.singerId);
}
