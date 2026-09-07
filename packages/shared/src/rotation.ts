// Rotation — the differentiator. Pure functions so the client can PREDICT the exact order the
// server will assign. See docs/ARCHITECTURE.md.
//
// WHICH ordering is a ROOM SETTING and lives in queue-order.ts (fair rotation, first-come-first-
// served, shuffle, longest-ago). This module is the part that does not vary: turning an ordering
// into contiguous `rotationSeq` values, and being the single reducer both sides run.
//
// The `Ordering` argument is optional everywhere and defaults to fair rotation, so a caller that has
// no room settings to hand (a test, a boot path before settings are read) gets exactly the behaviour
// that existed before the setting did.

import type { QueueEntry } from './types';
import { applyOp, type QueueOp } from './ops';
import { orderQueue, type Ordering } from './queue-order';

/**
 * Given queued entries, return them in the room's order (fair rotation unless told otherwise).
 * Does NOT mutate; returns a new array. Caller assigns rotationSeq from the index.
 */
export function rotate(entries: QueueEntry[], ordering: Ordering = {}): QueueEntry[] {
	return orderQueue(entries, ordering);
}

/** Assign contiguous rotationSeq values (0-based) from rotate() order. */
export function assignSeqs(entries: QueueEntry[], ordering: Ordering = {}): QueueEntry[] {
	return rotate(entries, ordering).map((e, i) => ({ ...e, rotationSeq: i }));
}

/** Terminal entries no longer participate in the rotation (played to completion). */
export function isTerminal(e: QueueEntry): boolean {
	return e.status === 'done';
}

/**
 * THE shared mutation: apply an op, drop terminal entries, then re-derive the room's ordering as
 * contiguous `rotationSeq`. Imported by BOTH the client optimistic store and the authoritative
 * server so the client predicts the EXACT order the server will commit — no post-broadcast
 * re-sort/flicker. Pure: returns a new array, never mutates.
 *
 * `ordering` must be the SAME on both sides. The client gets it from the room settings and singer
 * roster it already receives; a client whose snapshot is stale mispredicts one op and then adopts the
 * server's snapshot from the patch.
 *
 * `move` is special: rotationSeq is server-owned and derived from per-singer addedAt order, so a raw
 * move-op (which only rewrites rotationSeq) wouldn't survive reseq. Instead we permute the moving
 * singer's addedAt stamps to the target index within their OWN picks — the timestamp set is stable,
 * so their slots are unchanged; only which song sits where moves. That works under every ordering
 * that reads addedAt, and is why a drag can never jump another singer under any of them. Under
 * `shuffle`, which ranks by entry id, a move is a legal no-op (see `respectsAddedAt`).
 */
export function applyAndReseq(entries: QueueEntry[], op: QueueOp, ordering: Ordering = {}): QueueEntry[] {
	const applied = op.op === 'move' ? reorderWithinSinger(entries, op.id, op.toSeq) : applyOp(entries, op);
	return assignSeqs(
		applied.filter((e) => !isTerminal(e)),
		ordering
	);
}

/** Reorder one entry to index `toIdx` within its own singer's picks by permuting addedAt stamps. */
export function reorderWithinSinger(entries: QueueEntry[], id: string, toIdx: number): QueueEntry[] {
	const moving = entries.find((e) => e.id === id);
	if (!moving) return entries.slice();
	const mine = entries.filter((e) => e.singerId === moving.singerId).sort((a, b) => a.addedAt - b.addedAt);
	const stamps = mine.map((e) => e.addedAt); // stable timestamp slots for this singer
	const from = mine.findIndex((e) => e.id === id);
	const clamped = Math.max(0, Math.min(toIdx, mine.length - 1));
	mine.splice(clamped, 0, mine.splice(from, 1)[0]!);
	const reStamp = new Map(mine.map((e, i) => [e.id, stamps[i]!]));
	return entries.map((e) => (reStamp.has(e.id) ? { ...e, addedAt: reStamp.get(e.id)! } : e));
}
