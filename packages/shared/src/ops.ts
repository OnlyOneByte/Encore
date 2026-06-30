// The queue op envelope + apply logic — THE contract made physical.
// This module is imported by BOTH the SvelteKit client (optimistic apply) and the
// Bun server (authoritative apply). Same code on both ends => the client's optimistic
// prediction cannot diverge from what the server commits.
// See docs/reconciliation-contract.md.

import type { QueueEntry, EntryStatus, Media } from './types';

export type QueueOp =
  | { op: 'add'; entry: QueueEntry } // entry.id is the client-minted ULID
  | { op: 'remove'; id: string }
  | { op: 'move'; id: string; toSeq: number } // toSeq = target rotationSeq
  | { op: 'status'; id: string; status: EntryStatus };

export interface ClientCommand {
  clientOpId: string; // ULID — idempotency + reject routing
  baseRev: number; // client's rev when it made the change (optimistic concurrency)
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
    case 'status':
      next = entries.map((e) => (e.id === op.id ? { ...e, status: op.status } : e));
      break;
  }
  return next.sort((a, b) => a.rotationSeq - b.rotationSeq);
}

/** Inverse of an op against a prior-state snapshot — used for optimistic rollback on reject. */
export function inverseOp(entries: QueueEntry[], op: QueueOp): QueueOp | null {
  switch (op.op) {
    case 'add':
      return { op: 'remove', id: op.entry.id };
    case 'remove': {
      const gone = entries.find((e) => e.id === op.id);
      return gone ? { op: 'add', entry: gone } : null;
    }
    case 'move': {
      const cur = entries.find((e) => e.id === op.id);
      return cur ? { op: 'move', id: op.id, toSeq: cur.rotationSeq } : null;
    }
    case 'status': {
      const cur = entries.find((e) => e.id === op.id);
      return cur ? { op: 'status', id: op.id, status: cur.status } : null;
    }
  }
}
