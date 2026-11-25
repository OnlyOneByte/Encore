// "You're up": the phone's half of the handoff moment. Pure, so a bun test can decide it. See routes/+layout.svelte.

import { DEFAULT_ROOM_SETTINGS, effectiveSongIntroMs, type QueueEntry, type RoomSettings } from '$lib/contract';
import { chromaOfColor, contrastRatio, hueToHex } from '$lib/contract/presentation/colors';
import { nearestPaletteStop } from '$lib/contract/presentation/player-palette';

export interface YoureUpInput {
	/** The current entry on the previous pass. */
	previousId: string | null;
	currentId: string | null;
	/** The room's playhead as of the frame that made `currentId` current. */
	positionSec: number;
	/** Whether the room is playing. A song held behind the TV's Skipped notice starts PAUSED, and the sheet waits for
	 *  it to play, so it rises with the TV's card instead of ending before it. */
	isPlaying: boolean;
	entries: readonly QueueEntry[];
	meId: string | null;
}

/**
 * The entry to announce, or null. Only a CHANGE of current that lands on one of MY entries AT ITS START: a phone
 * reloaded in the middle of its own song is already singing, and must not be told so again. A song START is the
 * only frame whose playhead is 0 (`songStart` resets it), so the playhead is what tells the two apart.
 */
export function youreUpTurn(input: YoureUpInput): QueueEntry | null {
	const { previousId, currentId, positionSec, isPlaying, entries, meId } = input;
	if (!meId || !currentId || currentId === previousId || positionSec >= 1 || !isPlaying) return null;
	const entry = entries.find((e) => e.id === currentId);
	return entry && entry.singerId === meId ? entry : null;
}

/** The flood's lightness as a share of the singer stop's: a step darker than the fill, so a whole lit phone in a dark
 *  room glares less (redesign step 6, #1156). */
export const FLOOD_LIGHTNESS = 0.85;
const FLOOD_INKS = ['#0b0b12', '#ffffff'] as const;

/** The You're up flood in this singer's colour, and the ink that reads best on it. The ink is also the focus ring. */
export function floodColors(singerColor: string): { bg: string; ink: string } {
	const stop = nearestPaletteStop(singerColor);
	const bg = hueToHex(stop.hue, stop.L * FLOOD_LIGHTNESS, chromaOfColor(stop.fill));
	const [dark, light] = FLOOD_INKS;
	return { bg, ink: contrastRatio(bg, dark) >= contrastRatio(bg, light) ? dark : light };
}

/** The TV's hold for its "Now singing" card when the card is on, or the default hold when it is off: with no card the
 *  sheet is the only handoff the singer gets, so it still shows. */
export function youreUpMs(room: Pick<RoomSettings, 'songIntroEnabled' | 'songIntroMs'>): number {
	return effectiveSongIntroMs(room) || DEFAULT_ROOM_SETTINGS.songIntroMs;
}
