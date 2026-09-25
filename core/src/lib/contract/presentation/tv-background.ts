// THIS MUST STAY ITS OWN LEAF MODULE, importing nothing but the registry helper. `TvBackgroundStyle` is
// referenced from both sides of a layer boundary — `PlaybackState` in types.ts carries a per-song override
// and `RoomSettings` in settings.ts the room default — so holding the registry in settings.ts makes types.ts
// import UP and closes a real cycle. Its sibling registries (`TV_VISUALIZERS`) stay in settings.ts, because
// nothing in the base layer references them.

import { makeRegistry } from '../core/registry';

/**
 * For a processed song this is the ENTIRE visual field: a separated instrumental has no video track, so it
 * sits directly behind the lyric reel. ONE axis, not two — these do not compose, since "one colour" and
 * "the singer's colour" answer the same question and a second axis would manufacture invalid combinations.
 */
export const TV_BACKGROUND_STYLES = [
	{ id: 'off', label: 'Black', note: 'Plain black behind the song. What the TV has always done.' },
	{
		id: 'gradient',
		label: 'Room glow',
		note: 'The same glow the join and lobby screens use, kept up while a song plays.'
	},
	{
		id: 'singer',
		label: "Singer's colour",
		note: 'The stage takes the colour of whoever is up, and changes with each turn.'
	},
	{ id: 'solid', label: 'One colour', note: 'A single colour you pick below. Stays put all night.' },
	{
		id: 'visualizer',
		label: 'Audio visualizer',
		note: 'Moving light behind the words, like an old media player. Pick which one below.'
	}
] as const;

export type TvBackgroundStyle = (typeof TV_BACKGROUND_STYLES)[number]['id'];

const tvBackgroundRegistry = makeRegistry(TV_BACKGROUND_STYLES);

/** @knipignore The registry's `get` half, shipped with its registry rather than when a caller appears;
 *  pinned as public surface by `tests/unit/contract/barrel-surface.test.ts`. */
export function getTvBackgroundStyle(id: string): (typeof TV_BACKGROUND_STYLES)[number] | undefined {
	return tvBackgroundRegistry.get(id);
}

export function isTvBackgroundStyle(v: unknown): v is TvBackgroundStyle {
	return tvBackgroundRegistry.isValid(v);
}
