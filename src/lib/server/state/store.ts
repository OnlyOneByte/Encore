// In-memory authoritative state — the source of truth on the hot path. Reads never touch disk; a queue:patch broadcast is computed from RAM (sub-ms). Writes update memory, bump `rev`, and schedule a write-behind flush to SQLite. Hydrated once on boot. See ARCHITECTURE §9.

import {
	applyAndReseq,
	assignSeqs,
	isTerminal,
	type Ordering,
	type QueueOp,
	type QueueEntry,
	type PlaybackState
} from '../../contract';

export interface StatePersistence {
	/** Write-behind sink. Called (debounced) after mutations; must be side-effect-only. */
	persist(snapshot: { entries: QueueEntry[]; playback: PlaybackState }): void;
}

const NOOP_PERSIST: StatePersistence = { persist() {} };

/** The resolution predicate: does `currentEntryId` name a live entry? The SINGLE production statement of it — both `hydrate`'s boot self-heal (below) and `reconcileOnReady`'s runtime recovery (player.ts) call this, so "what resolves" has one answer instead of two copies that could drift. Lives here because store owns both `entries` and `PlaybackState`; `realtime` already imports from `state`. */
export function entryResolves(entries: readonly QueueEntry[], currentEntryId: string | null): boolean {
	return entries.some((e) => e.id === currentEntryId);
}

export class AuthoritativeState {
	#entries: QueueEntry[] = [];
	// Both per-song overrides start null = "defer to the room default", NOT a concrete value. setPlayback filters only `undefined`, so an explicit null still writes through — clearing back to inheriting.
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
	// Monotonic source of the server-owned `addedAt` stamp, re-stamped on every add at the hub seam (nextAddedAt) so the ordering input a room ranks singers by is never client-minted. Seeded on hydrate from the max persisted stamp so the monotonic guarantee holds across a reboot, not just within one process lifetime.
	#lastAddedAt = 0;

	/** `orderingOf` is a GETTER, not a value: the room's ordering algorithm is a setting that can change mid-party, and the sing-history it may read changes every time a song starts. Reading it per mutation means nothing has to be re-wired when either moves. Defaults to `{}` — fair rotation — so a caller with no settings to hand (tests, a boot path) gets the pre-setting behaviour. */
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
		// Seed the monotonic addedAt counter above every stamp just loaded (terminal rows filtered above still count — a later add must not collide with a done entry's stamp either).
		for (const e of entries) {
			if (Number.isFinite(e.addedAt) && e.addedAt > this.#lastAddedAt) this.#lastAddedAt = e.addedAt;
		}
		if (playback) {
			this.#playback = { ...playback };
			// Self-heal a persisted DANGLING currentEntryId: persist() snapshots entries and playback independently, so a room saved while the playing entry was already pruned stores an id naming no live entry, which would otherwise survive the reboot and jam the `!currentEntryId` auto-start gates. Drop it here to unjam them — there is no boot resync or boot reconcile. The room is left genuinely idle with a ready queue; recovery happens on the next real event that runs reconcileOnReady: a queue:command (server.ts), onMediaReady (app.ts), or a manual play.
			if (this.#playback.currentEntryId !== null && !entryResolves(this.#entries, this.#playback.currentEntryId)) {
				this.#playback = { ...this.#playback, currentEntryId: null, isPlaying: false };
			}
		}
	}

	/** Re-derive the ordering WITHOUT a queue op — for when the ordering itself changed rather than the queue (the room switched algorithm, or a singer's sing-history moved). Returns null when the resulting order is IDENTICAL and touches nothing (no rev bump, no flush) — what makes it safe to call unconditionally from the playback path and the settings endpoint, since republishing an unchanged snapshot would make every client re-adopt state and re-apply pending ops for nothing. */
	reorder(): { rev: number; entries: QueueEntry[] } | null {
		const next = assignSeqs(this.#entries, this.#orderingOf());
		const same = next.length === this.#entries.length && next.every((e, i) => e.id === this.#entries[i]!.id);
		if (same) return null;
		this.#entries = next;
		this.#rev++;
		this.#scheduleFlush();
		return { rev: this.#rev, entries: this.entries };
	}

	/** Apply a queue op authoritatively via the SHARED `applyAndReseq` (the same function the client optimistic store runs), which handles move-as-addedAt-permute, prunes terminal entries, and re-derives the room's ordering as contiguous rotationSeq. Bumps rev, schedules write-behind, and returns the canonical op + the authoritative (pruned, reseq'd) entries snapshot for the broadcast. */
	applyQueueOp(op: QueueOp): { rev: number; canonicalOps: QueueOp[]; entries: QueueEntry[] } {
		this.#entries = applyAndReseq(this.#entries, op, this.#orderingOf());
		this.#rev++;
		this.#scheduleFlush();
		return { rev: this.#rev, canonicalOps: [op], entries: this.entries };
	}

	/** Mint the next server-owned `addedAt` for an add op. MONOTONIC: `Math.max(Date.now(), last + 1)` so two adds in the same millisecond still get distinct, strictly increasing stamps — the ordering ranks singers by this value, and the client store's move-as-addedAt-permute needs it total. Per-room state (not a module global), seeded from persisted state on hydrate. */
	nextAddedAt(): number {
		this.#lastAddedAt = Math.max(Date.now(), this.#lastAddedAt + 1);
		return this.#lastAddedAt;
	}

	setPlayback(patch: Partial<PlaybackState>): { rev: number; playback: PlaybackState } {
		// Drop undefined keys instead of spreading them in — a patch carrying `positionSec: undefined` would overwrite a good value with undefined, which the write-behind flush then persists as NULL against a NOT NULL column, throwing a SQLiteError out of the flush timer and KILLING THE PROCESS asynchronously. A NON-FINITE number (NaN/Infinity, e.g. from an unvalidated wire seek) is the same crash by a different door — SQLite stores NaN as NULL too — so drop those here too, as the last-line guard behind player.ts.
		const defined = Object.fromEntries(
			Object.entries(patch).filter(([, v]) => v !== undefined && !(typeof v === 'number' && !Number.isFinite(v)))
		) as Partial<PlaybackState>;
		this.#playback = { ...this.#playback, ...defined };
		this.#rev++;
		this.#scheduleFlush();
		return { rev: this.#rev, playback: this.playback };
	}

	/** Update ONLY the playback position WITHOUT bumping rev: TV `ontimeupdate` fires ~4×/sec, and routing it through setPlayback would advance rev with no broadcast, freezing every client's localRev and forcing a full resync on the next real patch. Position is ephemeral telemetry, not authoritative queue state — it never gates reconciliation. */
	setPosition(positionSec: number): void {
		// A non-finite position is IGNORED, not floored: `Math.floor(undefined)` is NaN, and SQLite stores NaN as NULL, which would violate `NOT NULL playback_state.position_sec` from inside the flush timer. Dropping a bad telemetry sample costs nothing; crashing the room costs the party.
		if (!Number.isFinite(positionSec)) return;
		// Keep SUB-SECOND precision in the broadcast/in-memory position — flooring here made the first ~1.25s of every song (and every restart) broadcast an exact `positionSec: 0`, which guide-sync.ts's `restartToZero` clause reads as an unambiguous rewind, so any command in that window re-seeked the master and guide back to 0. The floor for the `integer` DB column moves to the persistence boundary instead; the negative clamp stays here (a negative playhead is nonsense).
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
