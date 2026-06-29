// In-memory authoritative state — the source of truth on the hot path. Reads never touch disk;
// a queue:patch broadcast is computed from RAM (sub-ms). Writes update memory, bump `rev`, and
// schedule a write-behind flush to SQLite. Hydrated once on boot. See MASTER-DESIGN §7 (Tier 1 #2).

import { applyOp, assignSeqs, type QueueOp, type QueueEntry, type PlaybackState } from '@encore/shared';

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
		this.#entries = assignSeqs(entries); // normalize fairness order on load
		if (playback) this.#playback = { ...playback };
	}

	/**
	 * Apply a queue op authoritatively. Re-derives rotationSeq for the whole queue (round-robin
	 * is server-owned), bumps rev, schedules write-behind. Returns the canonical ops to broadcast
	 * (with server-assigned seqs) + the new rev.
	 */
	applyQueueOp(op: QueueOp): { rev: number; canonicalOps: QueueOp[]; entries: QueueEntry[] } {
		let applied: QueueEntry[];
		if (op.op === 'move') {
			// Reorder WITHIN the moving entry's singer group. assignSeqs derives rotationSeq from
			// per-singer addedAt order, so we permute addedAt among that singer's picks (same
			// timestamp set → the singer's round-robin slot is stable; only which song sits where
			// changes). op.toSeq is the target index among that singer's own picks.
			applied = this.#reorderWithinSinger(op.id, op.toSeq);
		} else {
			applied = applyOp(this.#entries, op);
		}
		// server owns rotationSeq: re-assign fair order across the whole queue after every mutation
		this.#entries = assignSeqs(applied);
		this.#rev++;
		this.#scheduleFlush();
		// canonical ops: emit a full reconciled set as one add/whole-queue is overkill; for MVP we
		// broadcast the op plus the authoritative seqs by re-emitting moved entries. Simplest correct
		// form: echo the op, and let clients adopt seqs from the entries snapshot in the patch.
		return { rev: this.#rev, canonicalOps: [op], entries: this.entries };
	}

	/**
	 * Reorder one entry within its own singer's pick list to target index `toIdx`, by reassigning
	 * the singer's existing addedAt timestamps in the new order. Returns a new entries array.
	 */
	#reorderWithinSinger(id: string, toIdx: number): QueueEntry[] {
		const moving = this.#entries.find((e) => e.id === id);
		if (!moving) return this.#entries.slice();
		const mine = this.#entries
			.filter((e) => e.singerId === moving.singerId)
			.sort((a, b) => a.addedAt - b.addedAt);
		const stamps = mine.map((e) => e.addedAt); // the stable timestamp slots for this singer
		const from = mine.findIndex((e) => e.id === id);
		const clamped = Math.max(0, Math.min(toIdx, mine.length - 1));
		mine.splice(clamped, 0, mine.splice(from, 1)[0]!); // reorder the list
		const reStamp = new Map(mine.map((e, i) => [e.id, stamps[i]!])); // assign stamps by new position
		return this.#entries.map((e) => (reStamp.has(e.id) ? { ...e, addedAt: reStamp.get(e.id)! } : e));
	}

	setPlayback(patch: Partial<PlaybackState>): { rev: number; playback: PlaybackState } {
		this.#playback = { ...this.#playback, ...patch };
		this.#rev++;
		this.#scheduleFlush();
		return { rev: this.#rev, playback: this.playback };
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
