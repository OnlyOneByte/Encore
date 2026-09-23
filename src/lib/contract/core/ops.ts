// The queue op envelope and apply logic, imported by BOTH the client (optimistic apply) and the server
// (authoritative apply). Same code on both ends is what makes the client's prediction unable to diverge from
// what the server commits. See docs/ARCHITECTURE.md §3.

import type { QueueEntry, EntryStatus, Media } from './types';

export type QueueOp =
	| { op: 'add'; entry: QueueEntry } // entry.id is the client-minted ULID
	| { op: 'remove'; id: string }
	| { op: 'move'; id: string; toSeq: number } // toSeq = target index into the singer's own QUEUED picks (reorderWithinSinger indexes queued entries only; a playing/terminal entry never occupies a slot), NOT a rotationSeq
	// A reorder that can CROSS SINGERS: `toIdx` is a position in the WHOLE queued list, which `move` cannot
	// express, since it permutes one singer's picks among the slots that singer already holds and so can
	// never jump another singer. Gated on the `queue:reorder-any` capability for an entry the actor does not
	// own. Client and server both rewrite the stored list through `moveToIndex`, so the two cannot diverge.
	| { op: 'move-to-index'; id: string; toIdx: number } // toIdx = target index into the whole QUEUED list (a playing/terminal entry keeps its slot and never occupies one)
	| { op: 'status'; id: string; status: EntryStatus };

export interface ClientCommand {
	clientOpId: string; // ULID — idempotency + reject routing
	op: QueueOp;
}

export interface ServerPatch {
	rev: number; // new authoritative rev AFTER applying ops
	ops: QueueOp[]; // canonical ops (server may rewrite, e.g. assign rotationSeq)
	causedBy?: string; // echoes clientOpId so the originator can clear 'pending'
	// The authoritative (pruned, reseq'd) queue AFTER the op, carried inline so a client adopts server
	// `rotationSeq` and terminal-pruning in ONE message rather than a second sync per mutation. Omitted on a
	// pure re-ack, where there was no state change.
	entries?: QueueEntry[];
	// Any media `entries` references that the client may not hold yet (someone else's add).
	media?: Media[];
}

/**
 * Pure reducer: apply one op, returning a NEW array sorted by `rotationSeq`. Identical on client and server.
 * An unknown id is a no-op, which is what makes replay idempotent.
 */
export function applyOp(entries: QueueEntry[], op: QueueOp): QueueEntry[] {
	let next: QueueEntry[];
	switch (op.op) {
		case 'add':
			// match by id => update in place (originator already had the optimistic row); else insert
			next = entries.some((e) => e.id === op.entry.id)
				? entries.map((e) => (e.id === op.entry.id ? op.entry : e))
				: [...entries, op.entry];
			break;
		case 'remove':
			next = entries.filter((e) => e.id !== op.id);
			break;
		case 'move':
			next = entries.map((e) => (e.id === op.id ? { ...e, rotationSeq: op.toSeq } : e));
			break;
		case 'move-to-index':
			// A raw-seq fallback, like `move`: the real path is `applyAndReseq` → `moveToIndex`, which rewrites
			// the stored list. A direct caller here gets a raw index the next renumber overwrites.
			next = entries.map((e) => (e.id === op.id ? { ...e, rotationSeq: op.toIdx } : e));
			break;
		case 'status':
			next = entries.map((e) => (e.id === op.id ? { ...e, status: op.status } : e));
			break;
	}
	return next.sort((a, b) => a.rotationSeq - b.rotationSeq);
}
