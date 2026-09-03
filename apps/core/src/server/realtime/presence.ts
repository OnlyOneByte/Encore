// Singer presence — who is actually in the room RIGHT NOW.
//
// Why this exists: the singer table is append-only and file-backed (H-5), so "everyone who ever
// joined" grows without bound across nights. The TV lobby roster and the join card's "N singing
// tonight" must show who is *connected*, not who once was, or the screen lies.
//
// Presence is transport-derived: one entry per live phone/TV socket that resolved to a singer.
// Ref-counted because a singer legitimately holds several sockets at once (two tabs, a phone that
// reconnected before the old socket's close fired) — going offline on the FIRST close would flicker
// them out of the roster while they are still there.
//
// Pure and socket-free so it unit-tests without a server; server.ts owns the wiring.

export class PresenceTracker {
	/** singerId -> number of live sockets. A singer is present iff their count is > 0. */
	#counts = new Map<string, number>();

	/**
	 * Register a live socket for a singer.
	 * @returns true if this made the singer newly present (worth broadcasting).
	 */
	connect(singerId: string): boolean {
		const n = this.#counts.get(singerId) ?? 0;
		this.#counts.set(singerId, n + 1);
		return n === 0;
	}

	/**
	 * Drop one live socket for a singer.
	 * @returns true if this made the singer absent (worth broadcasting).
	 */
	disconnect(singerId: string): boolean {
		const n = this.#counts.get(singerId) ?? 0;
		if (n <= 1) {
			// Deleting (rather than storing 0) keeps `online()` allocation-free and makes a
			// disconnect for an unknown singer a no-op instead of inventing a zero entry.
			const wasPresent = this.#counts.delete(singerId);
			return wasPresent;
		}
		this.#counts.set(singerId, n - 1);
		return false;
	}

	isOnline(singerId: string): boolean {
		return (this.#counts.get(singerId) ?? 0) > 0;
	}

	/** Ids of every present singer. Order is insertion (arrival) order. */
	online(): string[] {
		return [...this.#counts.keys()];
	}

	/** How many distinct singers are present (not how many sockets). */
	count(): number {
		return this.#counts.size;
	}

	/** Live socket count for one singer — exposed for the ref-count assertions in tests. */
	sockets(singerId: string): number {
		return this.#counts.get(singerId) ?? 0;
	}
}
