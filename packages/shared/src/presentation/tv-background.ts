// The TV background style — a domain type that straddles the base and config layers.
//
// WHY ITS OWN MODULE. `TvBackgroundStyle` is referenced from BOTH sides of a boundary: the base
// playback state (`PlaybackState.background` in types.ts) carries a per-song override of it, and the
// room config (`RoomSettings.tvBackgroundStyle` in settings.ts) carries the room default. When the
// registry lived in settings.ts, types.ts had to `import type { TvBackgroundStyle } from '../core/settings'`
// — a base module reaching UP into the config layer. That closed a dependency cycle
// types -> settings -> queue-order -> types: settings imports the queue-order VALUES it validates
// against, and queue-order imports the `QueueEntry` type from types. Two edges were type-only and so
// erased at runtime, but it was a real graph cycle and one value-import away from a runtime one.
//
// Extracting the style here — a leaf that imports only the registry helper — lets types.ts and
// settings.ts BOTH depend downward on it, and the cycle is gone. Its two sibling TV registries
// (`TV_PROGRESS_STYLES`, `TV_VISUALIZERS`) stay in settings.ts on purpose: nothing in the base layer
// references them, so only the one type that actually crosses the boundary is moved.
//
// The public surface of @encore/shared is unchanged: index.ts re-exports this module, and settings.ts
// re-exports these same names, so a consumer importing `TvBackgroundStyle` / `TV_BACKGROUND_STYLES`
// from either `@encore/shared` or `./settings` sees exactly what it always did.

import { makeRegistry } from '../core/registry';

/**
 * What the TV paints BEHIND the video.
 *
 * Worth knowing why this matters more than it sounds: a make-karaoke song plays a separated
 * instrumental, which has no video track, so the `<video>` renders nothing and this background is
 * the ENTIRE visual field for the song — sitting directly behind the word-timed lyric reel. It is
 * not decoration around letterbox bars.
 *
 * A registry rather than a bare union, for the same reason as TV_PROGRESS_STYLES: the phone renders
 * the picker from one source and a new style cannot be added without a label.
 *
 * ONE axis, not two. These do not compose — "one colour" and "the singer's colour" are two answers
 * to the same question, so a second axis would only manufacture invalid combinations.
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
