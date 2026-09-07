// Singer membership — who is in the room RIGHT NOW, and who has actually gone.
//
// Why this exists: the singer table is append-only and file-backed (H-5), so "everyone who ever
// joined" grows without bound across nights. The TV lobby roster and the join card's count must show
// who is in the room, not who once was, or the screen lies.
//
// This started as a pure socket ref-count, and that was the bug: a singer was "present" iff their live
// socket count was > 0, so locking a phone removed its owner from the party in ~30 seconds (Bun's
// `idleTimeout` is the only liveness signal in the WS path). Sockets are still the input, but they are
// no longer the answer — see packages/shared/src/membership.ts for the three-state policy and why the
// grace clock starts on an empty song queue rather than on the socket drop.
//
// Ref-counted because a singer legitimately holds several sockets at once (two tabs, a phone that
// reconnected before the old socket's close fired) — going away on the FIRST close would flicker them
// out of the roster while they are still there.
//
// Socket-free so it unit-tests without a server; server.ts owns the wiring and drives the sweep.

import { memberState, shouldStartClock, shouldClearClock, type MemberFacts, type MemberState } from '@encore/shared';

interface Record_ {
	sockets: number;
	awaySince?: number;
	clockStartedAt?: number;
}

export interface MembershipSnapshot {
	/** Live socket. Insertion (arrival) order. */
	here: string[];
	/** In the room but unreachable — a locked phone, a pocket, a walk to the kitchen. */
	away: string[];
	/** Newly expired this sweep. Reported so a caller can release their names. */
	gone: string[];
}

export class PresenceTracker {
	/** singerId -> sockets + the timestamps membership is derived from. */
	#rec = new Map<string, Record_>();

	#get(singerId: string): Record_ {
		let r = this.#rec.get(singerId);
		if (!r) {
			r = { sockets: 0 };
			this.#rec.set(singerId, r);
		}
		return r;
	}

	/**
	 * Register a live socket for a singer.
	 * @returns true if this made the singer newly here (worth broadcasting).
	 */
	connect(singerId: string): boolean {
		const r = this.#get(singerId);
		const was = r.sockets;
		r.sockets = was + 1;
		// Coming back cancels the clock outright rather than pausing it: someone who returns has not
		// half-left, and carrying a stale start time would expire them early on their next drop.
		r.awaySince = undefined;
		r.clockStartedAt = undefined;
		return was === 0;
	}

	/**
	 * Drop one live socket for a singer.
	 * @returns true if this took them from here to away (worth broadcasting).
	 */
	disconnect(singerId: string, now: number): boolean {
		const r = this.#rec.get(singerId);
		if (!r || r.sockets === 0) return false; // unknown singer, or already away — no-op, not a zero entry
		r.sockets -= 1;
		if (r.sockets > 0) return false;
		r.awaySince = now;
		// The clock is NOT started here. It starts on the first sweep that finds them holding no pending
		// songs, which is the whole point: a queued song means they are still in the room.
		return true;
	}

	/** Ids of every singer with a live socket. Order is insertion (arrival) order. */
	online(): string[] {
		return [...this.#rec.entries()].filter(([, r]) => r.sockets > 0).map(([id]) => id);
	}

	/** Live socket count for one singer — exposed for the ref-count assertions in tests. */
	sockets(singerId: string): number {
		return this.#rec.get(singerId)?.sockets ?? 0;
	}

	/** One singer's membership, without advancing any clock. */
	stateOf(singerId: string, now: number, graceMs: number, hasPendingSongs: boolean): MemberState {
		const r = this.#rec.get(singerId);
		if (!r) return 'gone';
		return memberState({ ...r, hasPendingSongs }, now, graceMs);
	}

	/**
	 * Drop a singer outright, without waiting for any clock.
	 *
	 * This is what an EXPLICIT leave uses. The grace window exists because a dropped socket is ambiguous
	 * — a locked phone looks exactly like a walk to the car — and that ambiguity is gone the moment
	 * someone tells us they are leaving. Their name returns to the pool immediately.
	 */
	forget(singerId: string): boolean {
		return this.#rec.delete(singerId);
	}

	/**
	 * Advance membership and report it.
	 *
	 * This is the only thing that starts or clears a grace clock, and the only thing that can move a
	 * singer to `gone` — which no socket event can do, since expiry is a property of elapsed time. The
	 * caller runs it on a timer AND after anything that changes the queue.
	 *
	 * A gone singer is FORGOTTEN, not remembered as gone: the map stays bounded across a long night,
	 * and `memberState` already answers `gone` for anyone it has never seen.
	 */
	evaluate(opts: { now: number; graceMs: number; hasPendingSongs: (singerId: string) => boolean }): MembershipSnapshot {
		const { now, graceMs, hasPendingSongs } = opts;
		const here: string[] = [];
		const away: string[] = [];
		const gone: string[] = [];

		for (const [id, r] of [...this.#rec]) {
			const facts: MemberFacts = { ...r, hasPendingSongs: hasPendingSongs(id) };
			if (shouldClearClock(facts)) {
				r.clockStartedAt = undefined;
				facts.clockStartedAt = undefined;
			} else if (shouldStartClock(facts)) {
				r.clockStartedAt = now;
				facts.clockStartedAt = now;
			}
			switch (memberState(facts, now, graceMs)) {
				case 'here':
					here.push(id);
					break;
				case 'away':
					away.push(id);
					break;
				case 'gone':
					gone.push(id);
					this.#rec.delete(id);
					break;
			}
		}
		return { here, away, gone };
	}
}
