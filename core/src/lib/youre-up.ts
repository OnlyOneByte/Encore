// "You're up": the phone's half of the handoff moment. Pure, so a bun test can decide it. See routes/+layout.svelte.

import { DEFAULT_ROOM_SETTINGS, effectiveSongIntroMs, type QueueEntry, type RoomSettings } from '$lib/contract';

export interface YoureUpInput {
	/** The current entry on the previous pass. */
	previousId: string | null;
	currentId: string | null;
	/** The room's playhead as of the frame that made `currentId` current. */
	positionSec: number;
	entries: readonly QueueEntry[];
	meId: string | null;
}

/**
 * The entry to announce, or null. Only a CHANGE of current that lands on one of MY entries AT ITS START: a phone
 * reloaded in the middle of its own song is already singing, and must not be told so again. A song START is the
 * only frame whose playhead is 0 (`songStart` resets it), so the playhead is what tells the two apart.
 */
export function youreUpTurn(input: YoureUpInput): QueueEntry | null {
	const { previousId, currentId, positionSec, entries, meId } = input;
	if (!meId || !currentId || currentId === previousId || positionSec >= 1) return null;
	const entry = entries.find((e) => e.id === currentId);
	return entry && entry.singerId === meId ? entry : null;
}

/** The TV's hold for its "Now singing" card when the card is on, or the default hold when it is off: with no card the
 *  sheet is the only handoff the singer gets, so it still shows. */
export function youreUpMs(room: Pick<RoomSettings, 'songIntroEnabled' | 'songIntroMs'>): number {
	return effectiveSongIntroMs(room) || DEFAULT_ROOM_SETTINGS.songIntroMs;
}
