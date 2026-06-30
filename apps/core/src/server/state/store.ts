// In-memory authoritative state — the source of truth on the hot path. Reads never touch disk;
// a queue:patch broadcast is computed from RAM (sub-ms). Writes update memory, bump `rev`, and
// schedule a write-behind flush to SQLite. Hydrated once on boot. See MASTER-DESIGN §7 (Tier 1 #2).

import { applyAndReseq, assignSeqs, isTerminal, type QueueOp, type QueueEntry, type PlaybackState } from '@encore/shared';

export interface StatePersistence {
	/** Write-behind sink. Called (debounced) after mutations; must be side-effect-only. */
	persist(snapshot: { entries: QueueEntry[]; playback: PlaybackState }): void;
}

const NOOP_PERSIST: StatePersistence = { persist() {} };

export class AuthoritativeState {
	#entries: QueueEntry[] = [];
	#playback: PlaybackState = { currentEntryId: null, positionSec: 0, isPlaying: false };
	#rev = 0;
	#persistence: StatePersistence;
	#flushTimer: ReturnType<typeof setTimeout> | null = null;
	#flushDelayMs: number;

	constructor(persistence: StatePersistence = NOOP_PERSIST, flushDelayMs = 250) {
		this.#persistence = persistence;
		this.#flushDelayMs = flushDelayMs;
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
		// drop terminal (done/skipped) rows and normalize fairness order on load
		this.#entries = assignSeqs(entries.filter((e) => !isTerminal(e)));
		if (playback) this.#playback = { ...playback };
	}

	/**
	 * Apply a queue op authoritatively via the SHARED `applyAndReseq` (the same function the client
	 * optimistic store runs), which handles move-as-addedAt-permute, prunes terminal entries, and
	 * re-derives fair round-robin rotationSeq. Bumps rev, schedules write-behind. Returns the
	 * canonical op + the authoritative (pruned, reseq'd) entries snapshot for the broadcast.
	 */
	applyQueueOp(op: QueueOp): { rev: number; canonicalOps: QueueOp[]; entries: QueueEntry[] } {
		this.#entries = applyAndReseq(this.#entries, op);
		this.#rev++;
		this.#scheduleFlush();
		return { rev: this.#rev, canonicalOps: [op], entries: this.entries };
	}

	setPlayback(patch: Partial<PlaybackState>): { rev: number; playback: PlaybackState } {
		this.#playback = { ...this.#playback, ...patch };
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
		this.#playback = { ...this.#playback, positionSec: Math.max(0, Math.floor(positionSec)) };
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
