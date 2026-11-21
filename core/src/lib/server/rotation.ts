// Server-side rotation policy. Wraps the shared ordering registry (`assignSeqs` → queue-order.ts) and adds the server-only concern: which entry plays NEXT, with the held-slot rule (skip an entry that isn't ready yet without burning its fair position). See docs/ARCHITECTURE.md. WHICH ordering applies is the room's `queueOrder` setting, passed in as `Ordering` — optional, defaulting to fair rotation, but a caller on the live path must pass the room's or it will pick a different "next" than the queue the clients are looking at.

import {
	applyAndReseq,
	assignSeqs,
	readyToSing,
	type Ordering,
	type QueueEntry,
	type QueueOp,
	type Media
} from '../contract';

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

/** THE HELD ENTRY (proposal 14): while a song plays, the room's next playable entry keeps its turn against anyone but its
 *  owner, because that is when its singer's phone shows the On deck card and they set their key. Null in an idle room,
 *  where the server starts a ready song at once, and while its singer is away: a guest who left must not stall the room. */
export function heldOnDeck(
	entries: QueueEntry[],
	mediaById: Map<string, Media>,
	ordering: Ordering,
	away: readonly string[]
): QueueEntry | null {
	if (!entries.some((e) => e.status === 'playing')) return null;
	const { next } = nextPlayable(entries, mediaById, ordering);
	return next && !away.includes(next.singerId) ? next : null;
}

/** Would `op` move the held entry, or put an entry in front of it that was not there before? Judged on the list the op
 *  would COMMIT, so `move` and `move-to-index` answer through the one shared arithmetic. Moving a row from in front of
 *  it to behind it, or among the rows behind it, steals nothing. */
export function stealsHeld(entries: QueueEntry[], op: QueueOp, held: QueueEntry, ordering: Ordering): boolean {
	if ('id' in op && op.id === held.id) return true;
	const ahead = (list: QueueEntry[]) => {
		const queued = reseq(list, ordering).filter((e) => e.status === 'queued');
		const at = queued.findIndex((e) => e.id === held.id);
		return new Set(queued.slice(0, Math.max(0, at)).map((e) => e.id));
	};
	const before = ahead(entries);
	return [...ahead(applyAndReseq(entries, op, ordering))].some((id) => !before.has(id));
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
