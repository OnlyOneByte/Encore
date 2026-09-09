// The queue op envelope + apply logic — THE contract made physical.
// This module is imported by BOTH the SvelteKit client (optimistic apply) and the
// Bun server (authoritative apply). Same code on both ends => the client's optimistic
// prediction cannot diverge from what the server commits.
// See docs/ARCHITECTURE.md.

import type { QueueEntry, EntryStatus, Media } from './types';

export type QueueOp =
	| { op: 'add'; entry: QueueEntry } // entry.id is the client-minted ULID
	| { op: 'remove'; id: string }
	| { op: 'move'; id: string; toSeq: number } // toSeq = target index into the singer's own QUEUED picks (reorderWithinSinger indexes queued entries only; a playing/terminal entry never occupies a slot), NOT a rotationSeq
	// A HOST reorder that can cross singers: `toIdx` is a position in the WHOLE queued list, not the
	// singer's own picks (that is `move` above). `move` cannot express this — it permutes one singer's
	// picks among the slots that singer already holds, so it can never jump another singer. `move-to-index`
	// splices the entry to any queued index and rewrites the stored list, which the stored-list model
	// makes durable by construction (#856 step 4). No pin: the list IS the truth. Gated in hub.ts
	// validateCommand on `queue:reorder-any` for an entry the actor does not own. Crosses the wire
	// contract: client and server ship together and both rewrite the list identically through
	// `moveToIndex` in applyAndReseq, so optimistic and authoritative states cannot diverge.
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
	// The authoritative (pruned, reseq'd) queue AFTER the op. Carried inline so clients adopt
	// server rotationSeq + terminal-pruning in ONE message — no second queue:sync per mutation.
	// Omitted on a pure re-ack (dedup), where there was no state change.
	entries?: QueueEntry[];
	// Any media referenced by `entries` that the client may not have yet (e.g. someone else's add).
	media?: Media[];
}

/**
 * Pure reducer: apply one op to a queue, returning a NEW array (sorted by rotationSeq).
 * Identical behavior on client and server. Unknown ids are no-ops (idempotent).
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
			// Like `move`, this arm is a raw-seq fallback: the REAL path is applyAndReseq → moveToIndex
			// (rotation.ts), which rewrites the stored list. A direct applyOp caller (there is none for
			// this op) gets the same shape `move` gives — a raw index that the next renumber overwrites.
			next = entries.map((e) => (e.id === op.id ? { ...e, rotationSeq: op.toIdx } : e));
			break;
		case 'status':
			next = entries.map((e) => (e.id === op.id ? { ...e, status: op.status } : e));
			break;
	}
	return next.sort((a, b) => a.rotationSeq - b.rotationSeq);
}
