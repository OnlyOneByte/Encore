// In-memory authoritative state — the source of truth on the hot path. Reads never touch disk;
// a queue:patch broadcast is computed from RAM (sub-ms). Writes update memory, bump `rev`, and
// schedule a write-behind flush to SQLite. Hydrated once on boot. See ARCHITECTURE §9.

import {
	applyAndReseq,
	assignSeqs,
	isTerminal,
	type Ordering,
	type QueueOp,
	type QueueEntry,
	type PlaybackState
} from '@encore/shared';

export interface StatePersistence {
	/** Write-behind sink. Called (debounced) after mutations; must be side-effect-only. */
	persist(snapshot: { entries: QueueEntry[]; playback: PlaybackState }): void;
}

const NOOP_PERSIST: StatePersistence = { persist() {} };

/**
 * The #128 resolution predicate: does `currentEntryId` name a live entry? This is the SINGLE
 * production statement of it. It was stated twice before (#803 removed server.ts's copy but left
 * this store boot-heal and player.ts's runtime recovery as two byte-identical copies modulo the
 * receiver, #848), and a developer narrowing one and not the other left boot and runtime disagreeing
 * about whether the room is idle. Both askers — `hydrate`'s boot self-heal and
 * `reconcileOnReady`'s runtime recovery (player.ts) — now call this, so "what resolves" has one
 * answer. Lives here because store owns both `entries` and `PlaybackState`; `realtime` already
 * imports from `state`.
 */
export function entryResolves(entries: readonly QueueEntry[], currentEntryId: string | null): boolean {
	return entries.some((e) => e.id === currentEntryId);
}

export class AuthoritativeState {
	#entries: QueueEntry[] = [];
	// Both per-song overrides start null = "defer to the room default", NOT a concrete value.
	// setPlayback filters only `undefined`, so an explicit null still writes through — which is what
	// lets either one be cleared back to inheriting.
	#playback: PlaybackState = {
		currentEntryId: null,
		positionSec: 0,
		isPlaying: false,
		keyShift: 0,
		background: null,
		guideLevel: null
	};
	#rev = 0;
	#persistence: StatePersistence;
	#flushTimer: ReturnType<typeof setTimeout> | null = null;
	#flushDelayMs: number;
	#orderingOf: () => Ordering;
	// Monotonic source of the server-owned `addedAt` stamp. Every add op is re-stamped from this
	// at the hub seam (see nextAddedAt), so the ordering input a room ranks singers by is never
	// client-minted (issue #345). Seeded on hydrate from the max persisted stamp so a restart
	// followed by an add in the same millisecond still mints a value strictly above every
	// persisted entry — the monotonic guarantee has to hold across the reboot, not just within one
	// process lifetime.
	#lastAddedAt = 0;

	/**
	 * `orderingOf` is a GETTER, not a value: the room's ordering algorithm is a setting that can change
	 * mid-party, and the sing-history it may read changes every time a song starts. Reading it per
	 * mutation means nothing has to be re-wired when either moves. Defaults to `{}` — fair rotation —
	 * so a caller with no settings to hand (tests, a boot path) gets the pre-setting behaviour.
	 */
	constructor(
		persistence: StatePersistence = NOOP_PERSIST,
		flushDelayMs = 250,
		orderingOf: () => Ordering = () => ({})
	) {
		this.#persistence = persistence;
		this.#flushDelayMs = flushDelayMs;
		this.#orderingOf = orderingOf;
	}

	get rev(): number {
		return this.#rev;
	}
	/** Defensive copy — callers must not mutate authoritative arrays. */
	get entries(): QueueEntry[] {
		return this.#entries.map((e) => ({ ...e }));
	}
	get playback(): PlaybackState {
		return { ...this.#playback };
	}

	/** Seed from durable storage on boot (does NOT bump rev or schedule a flush). */
	hydrate(entries: QueueEntry[], playback: PlaybackState | null): void {
		// drop terminal (done) rows and normalize the room's ordering on load
		this.#entries = assignSeqs(
			entries.filter((e) => !isTerminal(e)),
			this.#orderingOf()
		);
		// Seed the monotonic addedAt counter above every stamp we just loaded (terminal rows filtered
		// above are still counted here — a later add must not collide with a done entry's stamp either).
		for (const e of entries) {
			if (Number.isFinite(e.addedAt) && e.addedAt > this.#lastAddedAt) this.#lastAddedAt = e.addedAt;
		}
		if (playback) {
			this.#playback = { ...playback };
			// Self-heal a persisted DANGLING currentEntryId (issue #128): persist() snapshots entries and
			// playback independently, so a room saved while the playing entry was already pruned stores an
			// id that names no live entry. Left as-is it survives the reboot and keeps the `!currentEntryId`
			// auto-start gates jammed. Drop it here to UNJAM those gates — there is no boot resync or boot
			// reconcile, so nothing starts a singer at hydrate time. The room is left genuinely idle with a
			// ready queue, and recovery happens on the next real event that runs reconcileOnReady: the next
			// queue:command (apps/core/server.ts, on a dangling/absent current), a process completing
			// (reconcileOnReady in onMediaReady, apps/core/src/server/app.ts), or a manual play — the play
			// control stays enabled because a non-empty queue satisfies its gate (routes/+page.svelte).
			if (this.#playback.currentEntryId !== null && !entryResolves(this.#entries, this.#playback.currentEntryId)) {
				this.#playback = { ...this.#playback, currentEntryId: null, isPlaying: false };
			}
		}
	}

	/**
	 * Re-derive the ordering WITHOUT a queue op — for when the ordering itself changed rather than the
	 * queue: the room switched algorithm, or a singer started a song and the sing-history the
	 * `least-recently-sung` policy reads moved.
	 *
	 * Returns null when the resulting order is IDENTICAL, and in that case touches nothing: no rev
	 * bump, no flush. That is what makes it safe to call unconditionally from the playback path and the
	 * settings endpoint — under an ordering that ignores sing history this is a cheap no-op, and
	 * republishing an unchanged snapshot would make every client re-adopt state and re-apply its
	 * pending ops for nothing.
	 */
	reorder(): { rev: number; entries: QueueEntry[] } | null {
		const next = assignSeqs(this.#entries, this.#orderingOf());
		const same = next.length === this.#entries.length && next.every((e, i) => e.id === this.#entries[i]!.id);
		if (same) return null;
		this.#entries = next;
		this.#rev++;
		this.#scheduleFlush();
		return { rev: this.#rev, entries: this.entries };
	}

	/**
	 * Apply a queue op authoritatively via the SHARED `applyAndReseq` (the same function the client
	 * optimistic store runs), which handles move-as-addedAt-permute, prunes terminal entries, and
	 * re-derives the room's ordering as contiguous rotationSeq. Bumps rev, schedules write-behind.
	 * Returns the canonical op + the authoritative (pruned, reseq'd) entries snapshot for the broadcast.
	 */
	applyQueueOp(op: QueueOp): { rev: number; canonicalOps: QueueOp[]; entries: QueueEntry[] } {
		this.#entries = applyAndReseq(this.#entries, op, this.#orderingOf());
		this.#rev++;
		this.#scheduleFlush();
		return { rev: this.#rev, canonicalOps: [op], entries: this.entries };
	}

	/**
	 * Mint the next server-owned `addedAt` for an add op. MONOTONIC: `Math.max(Date.now(), last + 1)`
	 * so two adds in the same millisecond still get distinct, strictly increasing stamps — the
	 * ordering ranks singers by this value and the move-as-addedAt-permute reorder needs it total
	 * (issue #345, and the original Finding #4 the client store records at stores/queue.ts). Owned
	 * here rather than as a module global so it is per-room and seeded from persisted state on hydrate.
	 */
	nextAddedAt(): number {
		this.#lastAddedAt = Math.max(Date.now(), this.#lastAddedAt + 1);
		return this.#lastAddedAt;
	}

	setPlayback(patch: Partial<PlaybackState>): { rev: number; playback: PlaybackState } {
		// Drop undefined keys instead of spreading them in. A partial carrying `positionSec: undefined`
		// used to overwrite a good value with undefined, which the write-behind flush then persisted as
		// NULL against a NOT NULL column — throwing a SQLiteError out of the flush timer and KILLING THE
		// PROCESS, asynchronously, long after the request that caused it. Absent means "leave it alone".
		//
		// A NON-FINITE numeric (NaN/Infinity, e.g. from `Math.max(0, NaN)` on an unvalidated wire seek)
		// is the SAME crash by a different door: SQLite stores NaN as NULL and violates the same NOT NULL
		// column from inside the flush timer. So drop non-finite numbers here too — this is the last-line
		// guard behind player.ts, so no future caller can reintroduce the process-kill.
		const defined = Object.fromEntries(
			Object.entries(patch).filter(([, v]) => v !== undefined && !(typeof v === 'number' && !Number.isFinite(v)))
		) as Partial<PlaybackState>;
		this.#playback = { ...this.#playback, ...defined };
		this.#rev++;
		this.#scheduleFlush();
		return { rev: this.#rev, playback: this.playback };
	}

	/**
	 * Update ONLY the playback position WITHOUT bumping rev (Finding #1). TV `ontimeupdate` fires
	 * ~4×/sec; routing it through setPlayback would advance rev with no broadcast, freezing every
	 * client's localRev and triggering a full resync on the next real patch (gap detector fires).
	 * Position is ephemeral telemetry, not authoritative queue state — never gates reconciliation.
	 */
	setPosition(positionSec: number): void {
		// A non-finite position is IGNORED, not floored. `Math.floor(undefined)` is NaN, and SQLite
		// stores NaN as NULL — so one telemetry frame with a missing positionSec violated
		// `NOT NULL playback_state.position_sec` and took the process down from inside the flush timer.
		// Telemetry is ephemeral: dropping a bad sample costs nothing, crashing the room costs the party.
		if (!Number.isFinite(positionSec)) return;
		// Keep SUB-SECOND precision in the broadcast/in-memory position (#718). Flooring HERE made the
		// first ~1.25s of every song (and every restart) broadcast an exact `positionSec: 0`, which
		// `guide-sync.ts`'s `restartToZero` clause reads as an unambiguous rewind — so any command in
		// that window (key/guide/pause) re-seeked the master and guide back to 0. The `integer`
		// `position_sec` column still needs a whole number, so the floor moves to the persistence
		// boundary (persistence.ts); the negative clamp stays here (a negative playhead is nonsense).
		this.#playback = { ...this.#playback, positionSec: Math.max(0, positionSec) };
		this.#scheduleFlush(); // still persisted (write-behind) so a resumed session is roughly correct
	}

	#scheduleFlush(): void {
		if (this.#flushTimer) return; // coalesce bursts into one write
		this.#flushTimer = setTimeout(() => {
			this.#flushTimer = null;
			this.#persistence.persist({ entries: this.entries, playback: this.playback });
		}, this.#flushDelayMs);
	}

	/** Force a synchronous flush (e.g. on graceful shutdown / in tests). */
	flushNow(): void {
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = null;
		}
		this.#persistence.persist({ entries: this.entries, playback: this.playback });
	}
}
