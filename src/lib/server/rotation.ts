// Server-side rotation policy. Wraps the shared ordering registry (`assignSeqs` → queue-order.ts) and adds the server-only concern: which entry plays NEXT, with the held-slot rule (skip an entry that isn't ready yet without burning its fair position). See docs/ARCHITECTURE.md. WHICH ordering applies is the room's `queueOrder` setting, passed in as `Ordering` — optional, defaulting to fair rotation, but a caller on the live path must pass the room's or it will pick a different "next" than the queue the clients are looking at.

import { assignSeqs, readyToSing, type Ordering, type QueueEntry, type Media } from '../contract';

/** Re-derive the room's ordering + contiguous rotationSeq. Server owns this value. */
export function reseq(entries: QueueEntry[], ordering: Ordering = {}): QueueEntry[] {
	return assignSeqs(entries, ordering);
}

/** A queue entry is "ready to play" when its media has a separated instrumental on disk — nothing plays unprocessed, so this is the whole rule; a not-ready entry keeps its rotationSeq and slots back in at the same fair position later. */
export function isEntryReady(entry: QueueEntry, mediaById: Map<string, Media>): boolean {
	const m = mediaById.get(entry.mediaId);
	if (!m) return false;
	return readyToSing(m);
}

/** Pick the next entry to play from an ordered queue, honoring the held-slot rule: walk in rotationSeq order, return the first `queued` entry whose media is ready. A not-ready entry is SKIPPED for now but keeps its rotationSeq, so it slots back in at the same position once ready. */
export function nextPlayable(
	entries: QueueEntry[],
	mediaById: Map<string, Media>,
	ordering: Ordering = {}
): { next: QueueEntry | null; held: QueueEntry[] } {
	const ordered = reseq(entries, ordering).filter((e) => e.status === 'queued');
	const held: QueueEntry[] = [];
	for (const e of ordered) {
		if (isEntryReady(e, mediaById)) return { next: e, held };
		held.push(e); // processing — hold its slot, try the next singer
	}
	return { next: null, held };
}

/** The entry shown as "up next" on the TV (for gapless preload) — the soonest ready entry. */
export function upNextAfter(
	currentId: string | null,
	entries: QueueEntry[],
	mediaById: Map<string, Media>,
	ordering: Ordering = {}
): QueueEntry | null {
	const ordered = reseq(entries, ordering).filter((e) => e.status === 'queued' && e.id !== currentId);
	return ordered.find((e) => isEntryReady(e, mediaById)) ?? null;
}
