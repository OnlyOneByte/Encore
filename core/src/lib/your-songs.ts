// "Your songs" under the empty Sing box: the wire shape, the row's sub-line, and a per-tab cache so coming back to Sing
// paints the list at once. The rules are server-side; see docs/SERVER.md#your-songs and docs/FRONTEND.md#your-songs.

import { GUIDE_PRESETS, guidePresetOf } from '$lib/guide-preset';
import type { Media } from '$lib/contract';

export interface YourSong {
	mediaId: string | null;
	title: string;
	artist: string | null;
	sung: number;
	lastSungAt: number | null;
	keyShift: number;
	guideLevel: number | null;
	saved: { id: string; savedAt: number } | null;
	media: Media | null;
}

export interface YourSongs {
	songs: YourSong[];
	/** A guest who could tap Keep me: the list is on this phone only until they do. */
	canKeep: boolean;
}

/** How many rows sit under the box. The rest wait for the You tab's full list (proposal 36, PR 3). */
export const YOUR_SONGS_SHOWN = 12;

/** "2 keys down · guide low · sung 3 times", or "saved". Only what is not zero, in guest words. */
export function yourSongLine(s: Pick<YourSong, 'keyShift' | 'guideLevel' | 'sung' | 'saved'>): string {
	const n = Math.abs(s.keyShift);
	const key = s.keyShift ? `${n} ${n === 1 ? 'key' : 'keys'} ${s.keyShift < 0 ? 'down' : 'up'}` : '';
	const preset = guidePresetOf(s.guideLevel);
	const guide =
		s.guideLevel && preset !== 'off'
			? `guide ${GUIDE_PRESETS.find((p) => p.id === preset)?.label.toLowerCase() ?? 'on'}`
			: '';
	const sung = s.sung > 1 ? `sung ${s.sung} times` : s.sung === 1 ? 'sung once' : 'saved';
	return [key, guide, sung].filter(Boolean).join(' · ');
}

let cached: YourSongs | null = null;

/** The last answer this tab saw, for an instant repaint; `load` refreshes it. */
export const cachedYourSongs = (): YourSongs | null => cached;

/** Null when the phone has not joined or the request failed: the box then stays as it is with no list. */
export async function loadYourSongs(): Promise<YourSongs | null> {
	try {
		const res = await fetch('/api/me/songs');
		if (!res.ok) return null;
		cached = (await res.json()) as YourSongs;
		return cached;
	} catch {
		return null;
	}
}
