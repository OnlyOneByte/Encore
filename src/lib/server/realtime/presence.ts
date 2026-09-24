// Who is in the room RIGHT NOW. The singer table is append-only, so "everyone who ever joined" grows
// unbounded and the roster must show who is here.
//
// REF-COUNTED, because a singer legitimately holds several sockets at once and dropping on the FIRST close
// would flicker them out while still present. A dropped socket alone is ambiguous, so departure goes through
// a GRACE CLOCK — see contract/queue/membership.ts for why the clock starts on an empty queue, not the drop.

import { memberState, shouldStartClock, shouldClearClock, type MemberFacts, type MemberState } from '../../contract';

/** One singer's socket count plus the timestamps `memberState` derives membership from. */
interface SingerPresence {
	sockets: number;
	awaySince?: number;
	clockStartedAt?: number;
}

export interface MembershipSnapshot {
	/** Live socket. Insertion (arrival) order. */
	here: string[];
	/** In the room but unreachable. */
	away: string[];
	/** Newly expired, so a caller can release their names. */
	gone: string[];
}

export class PresenceTracker {
	#rec = new Map<string, SingerPresence>();

	#get(singerId: string): SingerPresence {
		let r = this.#rec.get(singerId);
		if (!r) {
			r = { sockets: 0 };
			this.#rec.set(singerId, r);
		}
		return r;
	}

	/** @returns true when this made them newly here, i.e. worth broadcasting. */
	connect(singerId: string): boolean {
		const r = this.#get(singerId);
		const was = r.sockets;
		r.sockets = was + 1;
		// CANCELS the clock rather than pausing it: a stale start would expire them early on the next drop.
		r.awaySince = undefined;
		r.clockStartedAt = undefined;
		return was === 0;
	}

	/** @returns true when this took them from here to away. */
	disconnect(singerId: string, now: number): boolean {
		const r = this.#rec.get(singerId);
		if (!r || r.sockets === 0) return false; // unknown singer, or already away — no-op, not a zero entry
		r.sockets -= 1;
		if (r.sockets > 0) return false;
		r.awaySince = now;
		// NOT started here: it starts on the first sweep finding them with no pending songs.
		return true;
	}

	/** In arrival order. */
	online(): string[] {
		return [...this.#rec.entries()].filter(([, r]) => r.sockets > 0).map(([id]) => id);
	}

	/** Exposed for the ref-count assertions in tests. */
	sockets(singerId: string): number {
		return this.#rec.get(singerId)?.sockets ?? 0;
	}

	/** One singer's membership, without advancing any clock. */
	stateOf(singerId: string, now: number, graceMs: number, hasPendingSongs: boolean): MemberState {
		const r = this.#rec.get(singerId);
		if (!r) return 'gone';
		return memberState({ ...r, hasPendingSongs }, now, graceMs);
	}

	/** What an EXPLICIT leave uses: telling us removes the ambiguity the grace window exists for, so the
	 *  name returns to the pool immediately. */
	forget(singerId: string): boolean {
		return this.#rec.delete(singerId);
	}

	/** The ONLY thing that starts or clears a grace clock, or moves a singer to `gone`, which is a property
	 *  of elapsed time rather than a socket event. A gone singer is FORGOTTEN, not kept as a tombstone. */
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
