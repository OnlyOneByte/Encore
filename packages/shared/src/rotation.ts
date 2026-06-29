// Round-robin rotation — the differentiator. Pure function so the client can PREDICT
// the exact order the server will assign. See docs/MASTER-DESIGN.md §4.
//
// Rule: everyone's Nth pick plays before anyone's (N+1)th. Interleave each singer's
// entries by their per-singer pick index, breaking ties by addedAt (join/queue order).

import type { QueueEntry } from './types';

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
