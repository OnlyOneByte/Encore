// What to SHOW for a song, as opposed to what search matched or what the source reported.
//
// WHY THIS EXISTS. `Media.title` is the RAW upload title ("Britney Spears - Baby One More Time
// (Lyrics)") and `Media.artist` is the UPLOADER ("7clouds") — neither is the song's real name or
// artist. `feat/search-row-metadata` added `titleCanonical`/`artistCanonical`, produced by
// `parseTrackTitle` and only populated when the parse was CONFIDENT, but the TV card was never
// migrated to read them. So the lower-third and the song-intro still rendered the raw title, and the
// intro additionally showed the uploader as if it were the artist.
//
// This helper is the single migration point: it prefers the canonical fields and NEVER falls back to
// the uploader. It does no parsing of its own — the canonical fields are the parser's already-stored
// output — so it stays pure and dependency-light, beside `playbackRef`'s spirit of "one place decides
// what the surface uses".

import type { Media } from '../core/types';

/** Title and artist as the TV should display them. `artist` is null when there is nothing to trust. */
export interface SongDisplay {
	title: string;
	/**
	 * The canonical artist, or null. NEVER the uploader: `Media.artist` is a YouTube channel, so
	 * showing it as the artist is the very bug this replaces. When the parse was not confident enough
	 * to set `artistCanonical`, the honest answer is "no artist line", not a wrong one.
	 */
	artist: string | null;
}

/**
 * Resolve a song's display fields. `titleCanonical ?? title` because the raw title is a safe last
 * resort for a NAME (it still names the song, just noisily); `artistCanonical ?? null` because the
 * only other candidate is the uploader, which is worse than showing nothing.
 */
export function songDisplay(
	m: Pick<Media, 'title' | 'titleCanonical' | 'artistCanonical'> | null | undefined
): SongDisplay {
	if (!m) return { title: '', artist: null };
	return {
		title: m.titleCanonical ?? m.title,
		artist: m.artistCanonical ?? null
	};
}
