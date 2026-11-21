// Rotation. PURE, so the client predicts the exact list the server will commit. The queue is ONE stored ordered
// list and nothing re-derives its order. The policy input `Ordering` in queue-order.ts is optional everywhere
// and defaults to fair, so a caller with no settings to hand still inserts sensibly.
// Rules: docs/SERVER.md#queue-ordering-and-rotation. Narrative: docs/ARCHITECTURE.md §4.

import type { QueueEntry } from '../core/types';
import { applyOp, type QueueOp } from '../core/ops';
import { insertIndexFor, type Ordering } from './queue-order';

/** The stored list, in stored order. The tie-breaks make the order TOTAL even for a row the server has not
 *  numbered yet, or a hand-edited database with duplicates. */
export function storedOrder(entries: QueueEntry[]): QueueEntry[] {
	return [...entries].sort((a, b) => a.rotationSeq - b.rotationSeq || a.addedAt - b.addedAt || (a.id < b.id ? -1 : 1));
}

/** Renumber the stored list to contiguous 0-based `rotationSeq`. NO policy runs here and nothing may ever
 *  re-seat an entry. See docs/SERVER.md#queue-ordering-and-rotation. */
export function assignSeqs(entries: QueueEntry[], _ordering: Ordering = {}): QueueEntry[] {
	return storedOrder(entries).map((e, i) => ({ ...e, rotationSeq: i }));
}

/** Insert a NEW entry at the position the room's policy picks, then renumber. The policy is consulted EXACTLY
 *  here and nowhere else, against the stored QUEUED list, and its answer is clamped to just after a held On deck
 *  entry (`ordering.heldId`) so no policy can put a new song in front of it. See docs/SERVER.md#queue-ordering-and-rotation. */
export function insertEntry(entries: QueueEntry[], entry: QueueEntry, ordering: Ordering = {}): QueueEntry[] {
	const stored = storedOrder(entries.filter((e) => e.id !== entry.id));
	const { slots, queued } = splitQueued(stored);
	const held = ordering.heldId ? queued.findIndex((e) => e.id === ordering.heldId) : -1;
	const at = Math.max(insertIndexFor(queued, entry, ordering), held + 1);
	const nextQueued = queued.slice();
	nextQueued.splice(at, 0, entry);
	return renumber(weave(stored, slots, nextQueued));
}

/** Terminal entries no longer participate in the rotation (played to completion). */
export function isTerminal(e: QueueEntry): boolean {
	return e.status === 'done';
}

/** THE shared mutation: apply an op, drop terminal entries, renumber. Imported by BOTH sides, so the client
 *  predicts the EXACT list the server commits. `ordering` MUST match on both sides and matters for `add`
 *  alone. See docs/SERVER.md#queue-ordering-and-rotation. */
export function applyAndReseq(entries: QueueEntry[], op: QueueOp, ordering: Ordering = {}): QueueEntry[] {
	if (op.op === 'add') {
		return insertEntry(entries, op.entry, ordering).filter((e) => !isTerminal(e));
	}
	const applied =
		op.op === 'move'
			? reorderWithinSinger(entries, op.id, op.toSeq)
			: op.op === 'move-to-index'
				? moveToIndex(entries, op.id, op.toIdx)
				: op.op === 'not-yet'
					? letThroughTo(
							entries.map((e) => (e.id === op.id ? { ...e, deferred: true } : e)),
							op.id,
							op.toIdx
						)
					: applyOp(entries, op);
	return assignSeqs(
		applied.filter((e) => !isTerminal(e)),
		ordering
	);
}

/** Move one entry within its OWN singer's queued picks. It permutes the singer's songs among the slots that
 *  singer already holds, so no singer can jump another. See docs/SERVER.md#queue-ordering-and-rotation. */
export function reorderWithinSinger(entries: QueueEntry[], id: string, toIdx: number): QueueEntry[] {
	const stored = storedOrder(entries);
	const { slots, queued } = splitQueued(stored);
	const moving = queued.find((e) => e.id === id);
	if (!moving) return entries.slice(); // unknown, or not reorderable (e.g. playing) — no-op
	// The queued positions this singer's picks occupy — permuted among EXACTLY these.
	const myPositions: number[] = [];
	queued.forEach((e, i) => {
		if (e.singerId === moving.singerId) myPositions.push(i);
	});
	const mine = myPositions.map((i) => queued[i]!);
	const from = mine.findIndex((e) => e.id === id);
	if (from === -1) return entries.slice();
	const clamped = Math.max(0, Math.min(toIdx, mine.length - 1));
	if (clamped === from) return entries.slice(); // already there
	mine.splice(clamped, 0, mine.splice(from, 1)[0]!);
	const nextQueued = queued.slice();
	myPositions.forEach((pos, k) => {
		nextQueued[pos] = mine[k]!;
	});
	return renumber(weave(stored, slots, nextQueued));
}

/** Move one entry in the WHOLE queued list — the cross-singer reorder. `toIdx` is CLAMPED so the rule stays
 *  total. See docs/SERVER.md#queue-ordering-and-rotation. */
export function moveToIndex(entries: QueueEntry[], id: string, toIdx: number): QueueEntry[] {
	const stored = storedOrder(entries);
	const { slots, queued } = splitQueued(stored);
	const from = queued.findIndex((e) => e.id === id);
	if (from === -1) return entries.slice(); // unknown, or not queued (e.g. playing) — no-op
	const clamped = Math.max(0, Math.min(toIdx, queued.length - 1));
	if (clamped === from) return entries.slice(); // already there
	const nextQueued = queued.slice();
	nextQueued.splice(clamped, 0, nextQueued.splice(from, 1)[0]!);
	return renumber(weave(stored, slots, nextQueued));
}

/** "Not yet": every one of the singer's picks from `id` up to the queued entry at `toIdx` steps behind that entry,
 *  in their own order. Moving `id` alone would let the singer's NEXT pick slide into the turn, so the singer the
 *  button names would still not go first. Nobody else's relative order changes. */
function letThroughTo(entries: QueueEntry[], id: string, toIdx: number): QueueEntry[] {
	const stored = storedOrder(entries);
	const { slots, queued } = splitQueued(stored);
	const from = queued.findIndex((e) => e.id === id);
	if (from === -1 || toIdx <= from || toIdx >= queued.length) return entries.slice();
	const singerId = queued[from]!.singerId;
	const span = queued.slice(from, toIdx + 1);
	const nextQueued = [
		...queued.slice(0, from),
		...span.filter((e) => e.singerId !== singerId),
		...span.filter((e) => e.singerId === singerId),
		...queued.slice(toIdx + 1)
	];
	return renumber(weave(stored, slots, nextQueued));
}

/** The queued rows and the slots they occupy in the stored list. Everything else holds its slot. */
function splitQueued(stored: QueueEntry[]): { slots: number[]; queued: QueueEntry[] } {
	const slots: number[] = [];
	const queued: QueueEntry[] = [];
	stored.forEach((e, i) => {
		if (e.status === 'queued') {
			slots.push(i);
			queued.push(e);
		}
	});
	return { slots, queued };
}

/** Write a new queued sequence back into the stored queued slots, leaving every non-queued row where it was. A
 *  sequence longer than its slots appends the surplus. */
function weave(stored: QueueEntry[], slots: number[], nextQueued: QueueEntry[]): QueueEntry[] {
	const out: QueueEntry[] = [];
	let q = 0;
	for (let i = 0; i < stored.length; i++) {
		if (slots.includes(i)) {
			if (q < nextQueued.length) out.push(nextQueued[q++]!);
			// a shrunk queued sequence just leaves the slot unfilled
		} else {
			out.push(stored[i]!);
		}
	}
	while (q < nextQueued.length) out.push(nextQueued[q++]!); // surplus from an insert
	return out;
}

/** Contiguous 0-based positions over a list already in its final order. */
function renumber(list: QueueEntry[]): QueueEntry[] {
	return list.map((e, i) => ({ ...e, rotationSeq: i }));
}
