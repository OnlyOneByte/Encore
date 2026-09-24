// What the phone's polite live region says when the queue changes UNDER the guest — the only queue news they did
// not cause themselves. Pure, so the anti-spam rules below are decidable by calling it rather than by reading the
// route's effect: the guard for "a guest joining a busy room does not have the whole queue read aloud" is a call
// with no baseline, not a regex for a latch variable. See docs/FRONTEND.md#the-home-column.
import type { QueueEntry } from '$lib/contract';

/** Only the fields the sentence needs, so a catalog or playback change cannot reach this. */
export type AnnouncedTurn = Pick<QueueEntry, 'id' | 'singerId' | 'mediaId'>;

export interface QueueAnnouncementInput {
	/** The ids seen on the previous pass, or NULL before the first sync — which is a baseline, not news. */
	previousIds: readonly string[] | null;
	queued: readonly AnnouncedTurn[];
	meId: string | null | undefined;
	/** Resolves a singer id to a name, with the caller's own fallback for a singer not yet in the roster. */
	singerName: (singerId: string) => string;
	songTitle: (mediaId: string) => string;
}

/**
 * The line to announce, or NULL for "say nothing" — which is most passes. THE ANTI-SPAM GUARD IS THE DIFF, not a
 * timer: position telemetry moves through the room every second without changing the id list, so it is silent by
 * construction rather than by throttling.
 */
export function queueAnnouncement(input: QueueAnnouncementInput): string | null {
	const { previousIds, queued, meId, singerName, songTitle } = input;
	if (previousIds === null) return null;

	const before = new Set(previousIds);
	const added = queued.filter((turn) => !before.has(turn.id));
	if (added.length > 0) {
		// My own adds stay silent: I just tapped the button, and the row appearing is its own confirmation.
		const others = added.filter((turn) => turn.singerId !== meId);
		if (others.length === 0) return null;
		// ONE line even when several land at once (a resync catch-up), naming the count rather than reading every
		// title out — a reader cannot skip ahead of a live region.
		if (others.length === 1) {
			const turn = others[0]!;
			return `${singerName(turn.singerId)} queued ${songTitle(turn.mediaId)}`;
		}
		return `${others.length} songs added to the queue`;
	}

	// Same membership in a different order: the rows moved under the guest, which a reader has no other way to know.
	const ids = queued.map((turn) => turn.id);
	if (ids.length === previousIds.length && ids.some((id, index) => id !== previousIds[index])) {
		return 'Queue reordered';
	}
	return null;
}
