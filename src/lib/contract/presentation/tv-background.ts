// THIS MUST STAY ITS OWN LEAF MODULE, importing nothing but the registry helper.
//
// `TvBackgroundStyle` is referenced from both sides of a layer boundary: `PlaybackState` in types.ts
// carries a per-song override and `RoomSettings` in settings.ts carries the room default. Holding the
// registry in settings.ts makes types.ts import UP into the config layer and closes a real cycle
// (types → settings → queue-order → types). A leaf both can depend DOWNWARD on has no cycle.
//
// Its sibling TV registries (`TV_PROGRESS_STYLES`, `TV_VISUALIZERS`) stay in settings.ts on purpose:
// nothing in the base layer references them, so only the type that crosses the boundary moved.

import { makeRegistry } from '../core/registry';

/**
 * What the TV paints BEHIND the video — and for a processed song that is the ENTIRE visual field, because a
 * separated instrumental has no video track, so this sits directly behind the word-timed lyric reel rather
 * than decorating letterbox bars.
 *
 * ONE axis, not two: these do not compose, since "one colour" and "the singer's colour" are two answers to
 * the same question and a second axis would only manufacture invalid combinations.
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

export function getTvBackgroundStyle(id: string): (typeof TV_BACKGROUND_STYLES)[number] | undefined {
	return tvBackgroundRegistry.get(id);
}

export function isTvBackgroundStyle(v: unknown): v is TvBackgroundStyle {
	return tvBackgroundRegistry.isValid(v);
}
