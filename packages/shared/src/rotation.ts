// Round-robin rotation — the differentiator. Pure function so the client can PREDICT
// the exact order the server will assign. See docs/MASTER-DESIGN.md §4.
//
// Rule: everyone's Nth pick plays before anyone's (N+1)th. Interleave each singer's
// entries by their per-singer pick index, breaking ties by addedAt (join/queue order).

import type { QueueEntry } from './types';
import { applyOp, type QueueOp } from './ops';

/**
 * Given queued entries, return them in fair round-robin order.
 * Does NOT mutate; returns a new array. Caller assigns rotationSeq from the index.
 */
export function rotate(entries: QueueEntry[]): QueueEntry[] {
  // group by singer, preserve each singer's internal add-order
  const bySinger = new Map<string, QueueEntry[]>();
  for (const e of [...entries].sort((a, b) => a.addedAt - b.addedAt)) {
    const arr = bySinger.get(e.singerId) ?? [];
    arr.push(e);
    bySinger.set(e.singerId, arr);
  }
  // singers ordered by when each first appears (their earliest addedAt)
  const singers = [...bySinger.keys()].sort(
    (a, b) => bySinger.get(a)![0].addedAt - bySinger.get(b)![0].addedAt,
  );

  const out: QueueEntry[] = [];
  let round = 0;
  let added = true;
  while (added) {
    added = false;
    for (const s of singers) {
      const picks = bySinger.get(s)!;
      if (round < picks.length) {
        out.push(picks[round]);
        added = true;
      }
    }
    round++;
  }
  return out;
}

/** Assign contiguous rotationSeq values (0-based) from rotate() order. */
export function assignSeqs(entries: QueueEntry[]): QueueEntry[] {
  return rotate(entries).map((e, i) => ({ ...e, rotationSeq: i }));
}

/** Terminal entries no longer participate in the rotation (played or skipped). */
export function isTerminal(e: QueueEntry): boolean {
  return e.status === 'done' || e.status === 'skipped';
}

/**
 * THE shared mutation: apply an op, drop terminal entries, then re-derive fair round-robin
 * rotationSeq across the whole queue. Imported by BOTH the client optimistic store and the
 * authoritative server so the client predicts the EXACT order the server will commit — no
 * post-broadcast re-sort/flicker. Pure: returns a new array, never mutates.
 *
 * `move` is special: rotationSeq is server-owned and derived from per-singer addedAt order, so a
 * raw move-op (which only rewrites rotationSeq) wouldn't survive reseq. Instead we permute the
 * moving singer's addedAt stamps to the target index within their OWN picks (stable timestamp set
 * → the singer's round-robin slot is unchanged; only which song sits where moves).
 */
export function applyAndReseq(entries: QueueEntry[], op: QueueOp): QueueEntry[] {
  const applied = op.op === 'move' ? reorderWithinSinger(entries, op.id, op.toSeq) : applyOp(entries, op);
  return assignSeqs(applied.filter((e) => !isTerminal(e)));
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
