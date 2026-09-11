// Rotation — the differentiator. Pure functions so the client can PREDICT the exact list the server
// will commit. See docs/ARCHITECTURE.md.
//
// THE MODEL (#856): the queue is a single STORED ordered list and that list is the source of truth.
// `rotationSeq` is each entry's durable position in it. Nothing re-derives the order from entry
// fields: this module keeps the stored list, mutates it in place, and renumbers it so the positions
// stay contiguous.
//
// WHICH ordering is a ROOM SETTING and lives in queue-order.ts. Under this model a policy is not a
// sort — it is an INSERT-POSITION rule consulted ONCE, when a song is added, to pick the index the
// new song takes in the current stored list. After that the song holds its place until somebody moves
// it. That is what makes a drag durable by construction: there is no re-derivation for it to fight.
//
// The `Ordering` argument is optional everywhere and defaults to fair rotation, so a caller that has
// no room settings to hand (a test, a boot path before settings are read) gets fair insertion.

import type { QueueEntry } from '../core/types';
import { applyOp, type QueueOp } from '../core/ops';
import { insertIndexFor, type Ordering } from './queue-order';

/**
 * The stored list, in stored order. Sorts by the durable `rotationSeq` position; `addedAt` then `id`
 * break a tie so the order is TOTAL and stable even for rows the server has not numbered yet (a
 * just-minted optimistic add carries a placeholder seq) or a hand-edited database with duplicates.
 * Does NOT mutate; returns a new array.
 */
export function storedOrder(entries: QueueEntry[]): QueueEntry[] {
	return [...entries].sort((a, b) => a.rotationSeq - b.rotationSeq || a.addedAt - b.addedAt || (a.id < b.id ? -1 : 1));
}

/**
 * Renumber the stored list to contiguous 0-based `rotationSeq`.
 *
 * This is the whole of it now: NO policy runs here. The list arrives in the order it is stored in and
 * leaves in the same order with tidy positions, so calling this on an unchanged queue is a no-op and
 * switching the room's algorithm does not re-sort anything already queued (the algorithm only decides
 * where the NEXT add lands). The stored order is the sole authority — nothing re-seats an entry after
 * the list is stored, which is why a drag is durable by construction (#856 step 3 deleted the pin pass
 * that used to sit here).
 */
export function assignSeqs(entries: QueueEntry[], _ordering: Ordering = {}): QueueEntry[] {
	return storedOrder(entries).map((e, i) => ({ ...e, rotationSeq: i }));
}

/**
 * Insert a NEW entry into the stored list at the position the room's policy picks, then renumber.
 *
 * The policy is consulted exactly here and nowhere else. `insertIndexFor` is given the current stored
 * QUEUED list (not including the new entry, and not including a playing/terminal row) because that is
 * the list the index counts — the same base `reorderWithinSinger` and the reorder UI use, so a target
 * index means one thing everywhere. A playing entry keeps its slot: the queued rows are permuted among
 * the slots they already occupy, so an insert can never displace the song on stage.
 */
export function insertEntry(entries: QueueEntry[], entry: QueueEntry, ordering: Ordering = {}): QueueEntry[] {
	const stored = storedOrder(entries.filter((e) => e.id !== entry.id));
	const { slots, queued } = splitQueued(stored);
	const at = insertIndexFor(queued, entry, ordering);
	const nextQueued = queued.slice();
	nextQueued.splice(at, 0, entry);
	// The new row needs a slot of its own: rebuild by walking the stored list and emitting the queued
	// sequence in its new order, then appending anything left over (the inserted row grew the list).
	return renumber(weave(stored, slots, nextQueued));
}

/** Terminal entries no longer participate in the rotation (played to completion). */
export function isTerminal(e: QueueEntry): boolean {
	return e.status === 'done';
}

/**
 * THE shared mutation: apply an op to the stored list, drop terminal entries, renumber. Imported by
 * BOTH the client optimistic store and the authoritative server so the client predicts the EXACT list
 * the server will commit — no post-broadcast re-sort/flicker. Pure: returns a new array.
 *
 * `ordering` must be the SAME on both sides, and matters for ONE op: `add`, where it picks the insert
 * index. Every other op rewrites or trims the stored list, which needs no policy at all.
 *
 * `add`, `move` and `move-to-index` are the arms that do not go through `applyOp`: an add has to be
 * PLACED by the policy rather than appended, and both moves rewrite the stored list rather than set a
 * raw seq that the next renumber would overwrite.
 */
export function applyAndReseq(entries: QueueEntry[], op: QueueOp, ordering: Ordering = {}): QueueEntry[] {
	if (op.op === 'add') {
		return insertEntry(entries, op.entry, ordering).filter((e) => !isTerminal(e));
	}
	const applied =
		op.op === 'move'
			? reorderWithinSinger(entries, op.id, op.toSeq)
			: op.op === 'move-to-index'
				? moveToIndex(entries, op.id, op.toIdx)
				: applyOp(entries, op);
	return assignSeqs(
		applied.filter((e) => !isTerminal(e)),
		ordering
	);
}

/**
 * Move one entry to index `toIdx` within its OWN singer's queued picks, by rewriting the stored list.
 *
 * Under the stored-list model a reorder IS a list rewrite. (It used to permute the singer's `addedAt`
 * stamps, because the order was re-derived from them; nothing reads `addedAt` for position now, so a
 * stamp permutation would be an invisible no-op.) The index space is unchanged and is the singer's own
 * QUEUED picks in stored order — the client derives `toSeq` from exactly that list (#637), so counting
 * a playing entry here would make every index one short.
 *
 * The move permutes the singer's songs among the stored slots THAT SINGER ALREADY HOLDS, so the two
 * songs swap places and nobody else's row shifts. That is the stored-list form of what the stamp
 * permutation did before. A global "move to any index" is the sibling `moveToIndex` (#856 step 4);
 * this one stays own-picks only.
 */
export function reorderWithinSinger(entries: QueueEntry[], id: string, toIdx: number): QueueEntry[] {
	const stored = storedOrder(entries);
	const { slots, queued } = splitQueued(stored);
	const moving = queued.find((e) => e.id === id);
	if (!moving) return entries.slice(); // unknown, or not reorderable (e.g. playing) — no-op
	// The positions within the queued list that this singer's picks occupy. The singer's songs are
	// permuted among EXACTLY these positions, so no other singer's row moves — the stored-list
	// equivalent of the old "the timestamp set is stable, only which song sits where moves".
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

// ── stored-list plumbing ─────────────────────────────────────────────────────

/**
 * Move one entry to index `toIdx` in the WHOLE queued list, by rewriting the stored list. This is the
 * cross-singer reorder: unlike `reorderWithinSinger`, the target index counts EVERY queued entry, so a
 * host can move any song to any global slot (#856 step 4, #828 Q4-A). No pin — the stored list is the
 * source of truth, so the move sticks by construction and re-derivation reproduces it.
 *
 * Only the queued rows move; a playing/terminal entry keeps its slot (it never occupies a queued
 * index). `toIdx` is clamped into the queued range so the rule is TOTAL — an out-of-range index lands
 * at the nearest end rather than dropping the entry. PURE and DETERMINISTIC: reads only the stored
 * order and the id, so the phone's optimistic prediction and the server's commit are identical.
 */
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

/**
 * Write a new queued sequence back into the stored list's queued slots, leaving every non-queued row
 * (a playing entry) exactly where it was. When the sequence is LONGER than the slots it had (an
 * insert), the surplus is appended after the last slot, which is where a grown list continues.
 */
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
