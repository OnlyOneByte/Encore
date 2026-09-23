// Singer membership — who is in the room RIGHT NOW, and who has actually gone. The singer table is
// append-only, so "everyone who ever joined" grows unbounded; the roster must show who's here now.
//
// Ref-counted because a singer legitimately holds several sockets at once (two tabs, a reconnect
// before the old socket's close fires); dropping on the FIRST close would flicker them out while
// still present. A dropped socket alone is ambiguous (locked phone vs. walked away), so departure
// goes through a grace clock rather than firing on socket-close — see
// src/lib/contract/queue/membership.ts for the three-state policy and why the clock starts on an
// empty queue, not on the drop. Socket-free so it unit-tests without a server; server.ts drives the sweep.

import { memberState, shouldStartClock, shouldClearClock, type MemberFacts, type MemberState } from '../../contract';

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

	/** Register a live socket for a singer. @returns true if this made them newly here (worth broadcasting). */
	connect(singerId: string): boolean {
		const r = this.#get(singerId);
		const was = r.sockets;
		r.sockets = was + 1;
		// Cancels the clock outright rather than pausing it: someone who returns hasn't half-left, and
		// a stale start time would expire them early on their next drop.
		r.awaySince = undefined;
		r.clockStartedAt = undefined;
		return was === 0;
	}

	/** Drop one live socket for a singer. @returns true if this took them from here to away. */
	disconnect(singerId: string, now: number): boolean {
		const r = this.#rec.get(singerId);
		if (!r || r.sockets === 0) return false; // unknown singer, or already away — no-op, not a zero entry
		r.sockets -= 1;
		if (r.sockets > 0) return false;
		r.awaySince = now;
		// NOT started here — starts on the first sweep finding them with no pending songs, since a
		// queued song means they're still in the room.
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

	/** Drop a singer outright, without waiting for any clock — what an EXPLICIT leave uses, since
	 *  telling us removes the ambiguity the grace window exists for. Name returns to the pool immediately. */
	forget(singerId: string): boolean {
		return this.#rec.delete(singerId);
	}

	/**
	 * Advance membership and report it — the only thing that starts/clears a grace clock or moves a
	 * singer to `gone` (a property of elapsed time, not a socket event). Run on a timer AND after
	 * anything that changes the queue. A gone singer is FORGOTTEN, not kept as a tombstone, so the
	 * map stays bounded across a long night.
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
