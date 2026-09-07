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

/**
 * Assign contiguous rotationSeq values (0-based) from rotate() order, AFTER honouring any host pins.
 *
 * The pin pass sits HERE — between the policy's order and the numbering — so it is the one place every
 * caller (client optimistic store and authoritative server both reach assignSeqs) applies it, and so a
 * pin overrides whichever policy the room chose rather than being an input to one of them. See placePins.
 */
export function assignSeqs(entries: QueueEntry[], ordering: Ordering = {}): QueueEntry[] {
	return placePins(rotate(entries, ordering)).map((e, i) => ({ ...e, rotationSeq: i }));
}

/**
 * THE PIN MECHANISM. Given entries already in the room's policy order, move each host-pinned entry to
 * its recorded global index, leaving the unpinned entries in the policy order around them.
 *
 * WHY A POST-PASS rather than a policy input. Every ordering (fair/fcfs/least-recently-sung/shuffle) is
 * pure over entries + Ordering and must agree byte-for-byte between phone and server; teaching each of
 * the four to read a pin would be four chances to diverge and would make "pinned" mean something
 * different per policy. Placing pins AFTER any policy has run makes a global drag mean the same thing
 * under all four, and is why the pin survives assignSeqs re-derivation and the next add: `pinnedSeq`
 * lives on the entry (a durable column), so it is present on every re-derivation until an `unpin` op
 * clears it. `move`'s per-singer reorder is untouched — it still permutes addedAt and flows through the
 * policy, so the two mechanisms compose (a singer reorders their own picks; a host overrides globally).
 *
 * Pure and deterministic: reads only `pinnedSeq` off the entries, so both sides compute the identical
 * result. Pins are applied lowest-target-first (ties broken by id) so the placement of one pin does not
 * depend on hidden iteration order, and each target is clamped into range against the list as it grows.
 */
export function placePins(ordered: QueueEntry[]): QueueEntry[] {
	const pinned = ordered
		.filter((e) => typeof e.pinnedSeq === 'number' && Number.isFinite(e.pinnedSeq))
		.sort((a, b) => a.pinnedSeq! - b.pinnedSeq! || (a.id < b.id ? -1 : 1));
	if (pinned.length === 0) return ordered.slice();
	const pinnedIds = new Set(pinned.map((e) => e.id));
	// Start from the policy order with the pinned entries removed, then splice each back at its target.
	const out = ordered.filter((e) => !pinnedIds.has(e.id));
	for (const e of pinned) {
		const at = Math.max(0, Math.min(e.pinnedSeq!, out.length));
		out.splice(at, 0, e);
	}
	return out;
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
	// Index over the singer's REORDERABLE (queued) picks only. A playing/terminal entry is not a
	// reorder target and must not occupy a slot: the client (+page.svelte) derives its toSeq from
	// queued picks only, so if the server counted a playing entry too, every index would be off by
	// one and the singer's first queued pick would resolve onto its own slot (a no-op — issue #637).
	const mine = entries
		.filter((e) => e.singerId === moving.singerId && e.status === 'queued')
		.sort((a, b) => a.addedAt - b.addedAt);
	const from = mine.findIndex((e) => e.id === id);
	if (from === -1) return entries.slice(); // moving entry isn't reorderable (e.g. playing) — no-op
	const stamps = mine.map((e) => e.addedAt); // stable timestamp slots for this singer's picks
	const clamped = Math.max(0, Math.min(toIdx, mine.length - 1));
	mine.splice(clamped, 0, mine.splice(from, 1)[0]!);
	const reStamp = new Map(mine.map((e, i) => [e.id, stamps[i]!]));
	return entries.map((e) => (reStamp.has(e.id) ? { ...e, addedAt: reStamp.get(e.id)! } : e));
}
