// GET /api/stats — the PUBLIC party stats: how big the library is, what gets sung, and the trend.
//
// Read-only and unauthenticated, matching /api/library and /api/search. Everything here is
// aggregate and non-identifying by construction: there is no singer column in the play log to
// expose, so no leaderboard is possible from this endpoint even by accident.
//
// `days` bounds the trend window. Totals are lifetime; the window only shapes the per-day series and
// the "recent favourites" ranking, so a quiet week cannot make the library look empty.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$server/app';
import { clampDays, songDisplay } from '@encore/shared';

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

export const GET: RequestHandler = async ({ url }) => {
	const app = getApp();
	const days = clampDays(url.searchParams.get('days'), { fallback: DEFAULT_DAYS, max: MAX_DAYS });
	const since = app.now() - days * DAY_MS;

	const ready = app.media.listReady();
	// Name the ranked songs here rather than making the client fetch the whole catalog to join: the
	// play log stores media ids only, and an id is not a song title anyone can read.
	const displayOf = new Map(app.media.all().map((m) => [m.id, songDisplay(m)]));
	const titleOf = new Map([...displayOf].map(([id, d]) => [id, d.title]));
	const artistOf = new Map([...displayOf].map(([id, d]) => [id, d.artist]));

	const topAllTime = app.playLog.topSongs(10);
	const topRecent = app.playLog.topSongs(10, since);

	return json({
		library: {
			// Songs you can actually sing, which is the number a guest means by "how many songs".
			ready: ready.length,
			// Every row ever materialised by a search, most of which are not processed. Reported alongside
			// rather than instead: on the live box this was 271 rows behind 7 singable songs, so quoting
			// it alone would badly overstate the library.
			catalog: app.media.all().length
		},
		sings: {
			total: app.playLog.total(),
			window: app.playLog.totalSince(since),
			distinctSongs: app.playLog.distinctSongs()
		},
		topSongs: topAllTime.map((s) => ({ ...s, title: titleOf.get(s.mediaId) ?? s.mediaId })),
		topRecent: topRecent.map((s) => ({ ...s, title: titleOf.get(s.mediaId) ?? s.mediaId })),
		// Artists are ranked from PLAYS, joined through the canonical name. Songs whose artist could
		// not be parsed confidently are grouped under a null key by the aggregator and dropped here —
		// see the comment in topArtists.
		topArtists: topArtists(topAllTime.length ? app.playLog.topSongs(500) : [], artistOf),
		perDay: app.playLog.perDay(since),
		window: { days, since }
	});
};

/**
 * Rank artists by total plays of their songs.
 *
 * Songs with NO canonical artist are EXCLUDED rather than bucketed as "Unknown". The normalizer
 * stores null instead of guessing on a low-confidence parse, and `media.artist` holds the YouTube
 * uploader ("7clouds"), not the artist — so an "Unknown" row would usually be the largest bar on the
 * chart and would say nothing. Excluding it makes the list short and true instead of long and wrong.
 */
function topArtists(
	plays: { mediaId: string; plays: number }[],
	artistOf: Map<string, string | null | undefined>
): { artist: string; plays: number }[] {
	const totals = new Map<string, number>();
	for (const p of plays) {
		const artist = artistOf.get(p.mediaId);
		if (!artist) continue;
		totals.set(artist, (totals.get(artist) ?? 0) + p.plays);
	}
	return [...totals.entries()]
		.map(([artist, plays]) => ({ artist, plays }))
		.sort((a, b) => b.plays - a.plays)
		.slice(0, 10);
}
