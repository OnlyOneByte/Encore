// What to SHOW for a song, which is neither what search matched nor what the source reported: `Media.title`
// is the raw upload title and `Media.artist` is the UPLOADER. THE single place that decides, so no surface
// re-derives it. It parses nothing — the canonical fields are the parser's stored output.

import type { Media } from '../core/types';

/** Title and artist as the TV should display them. */
export interface SongDisplay {
	title: string;
	/**
	 * The canonical artist, or null — NEVER the uploader, which is a channel name and not an artist. When the
	 * parse was not confident enough to set `artistCanonical`, the honest answer is no artist line.
	 */
	artist: string | null;
}

/**
 * Resolve a song's display fields. The raw title is a safe last resort for a NAME, since it still names the
 * song; the uploader is NOT a last resort for an artist, since it is worse than showing nothing.
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
