// Server-side rotation policy. Wraps the pure shared round-robin (`assignSeqs`) and adds the
// server-only concerns: which entry plays NEXT, with the held-slot rule (skip an entry that
// isn't ready yet — e.g. a make-karaoke song still being processed — without burning its fair
// position). See docs/MASTER-DESIGN.md §4 and docs/tv-preload-state-machine.md §4.

import { assignSeqs, type QueueEntry, type Media } from '@encore/shared';

/** Re-derive fair round-robin order + contiguous rotationSeq. Server owns this value. */
export function reseq(entries: QueueEntry[]): QueueEntry[] {
	return assignSeqs(entries);
}

/** A queue entry is "ready to play" when its media needs no processing or is already done. */
export function isEntryReady(entry: QueueEntry, mediaById: Map<string, Media>): boolean {
	const m = mediaById.get(entry.mediaId);
	if (!m) return false;
	// iframe (YouTube) plays immediately; file plays once stems are ready (or never needed them)
	return m.playMode === 'iframe' || m.stemStatus === 'ready' || m.stemStatus === 'none';
}

/**
 * Pick the next entry to play from a fair-ordered queue, honoring the held-slot rule:
 * walk in rotationSeq order, return the first `queued` entry whose media is ready. An entry
 * that's not ready is SKIPPED for now but keeps its rotationSeq, so it slots back in at the
 * same fair position on a later call once it becomes ready.
 */
export function nextPlayable(
	entries: QueueEntry[],
	mediaById: Map<string, Media>
): { next: QueueEntry | null; held: QueueEntry[] } {
	const ordered = reseq(entries).filter((e) => e.status === 'queued');
	const held: QueueEntry[] = [];
	for (const e of ordered) {
		if (isEntryReady(e, mediaById)) return { next: e, held };
		held.push(e); // cooking — hold its slot, try the next singer
	}
	return { next: null, held };
}

/** The entry shown as "up next" on the TV (for gapless preload) — the soonest ready entry. */
export function upNextAfter(
	currentId: string | null,
	entries: QueueEntry[],
	mediaById: Map<string, Media>
): QueueEntry | null {
	const ordered = reseq(entries).filter((e) => e.status === 'queued' && e.id !== currentId);
	return ordered.find((e) => isEntryReady(e, mediaById)) ?? null;
}
