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
	// A HOST reorder that can cross singers: `toSeq` is an index into the WHOLE queued list, not the
	// singer's own picks (that is `move` above). `move` cannot express this — it permutes one singer's
	// addedAt stamps, which by construction can never jump another singer under any ordering (see
	// rotation.ts). So a global drag pins the entry to a durable slot (`pinnedSeq`) that the ordering
	// layer honours AFTER a policy runs, which is what makes it survive re-derivation and the next add.
	// The gate lives in hub.ts validateCommand (queue:reorder-any). Crosses the wire contract: client
	// and server ship together, and both stamp the pin identically through applyOp so their optimistic
	// and authoritative states cannot diverge.
	| { op: 'move-global'; id: string; toSeq: number } // toSeq = target index into the whole QUEUED list (placePins indexes queued entries only; a playing/terminal entry keeps its policy slot and never occupies one)
	| { op: 'unpin'; id: string } // clear a durable global pin, returning the entry to the room's policy
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
		case 'move-global':
			// Stamp the durable pin. Placement itself is the ordering layer's job (applyAndReseq → the pin
			// pass in rotation.ts), not this reducer's: rotationSeq is re-derived on every mutation, so a
			// raw rotationSeq write here would not survive the next add. Recording `pinnedSeq` on the entry
			// is what does survive — it is a field the policy-independent placement pass reads.
			next = entries.map((e) => (e.id === op.id ? { ...e, pinnedSeq: op.toSeq } : e));
			break;
		case 'unpin':
			// Release the entry back to the room's ordering policy. A pin persists until a host clears it
			// (owner ruling: never auto-cleared on play or re-sort), so this is the ONLY way it goes away.
			next = entries.map((e) => (e.id === op.id ? { ...e, pinnedSeq: null } : e));
			break;
		case 'status':
			next = entries.map((e) => (e.id === op.id ? { ...e, status: op.status } : e));
			break;
	}
	return next.sort((a, b) => a.rotationSeq - b.rotationSeq);
}
