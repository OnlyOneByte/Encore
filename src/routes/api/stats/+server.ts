// GET /api/stats — the PUBLIC party stats: how big the library is, what gets sung, and the trend.
// Read-only, unauthenticated, aggregate-only — see docs/ARCHITECTURE.md §10. `days` bounds the trend
// window only; totals stay lifetime, so a quiet week can't make the library look empty.
import type { RequestHandler } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { getApp } from '$lib/server/app';
import { clampDays } from '$lib/contract';
import { songDisplay } from '$lib/contract';

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

export const GET: RequestHandler = async ({ url }) => {
	const app = getApp();
	const days = clampDays(url.searchParams.get('days'), { fallback: DEFAULT_DAYS, max: MAX_DAYS });
	const since = app.now() - days * DAY_MS;

	const ready = app.media.listReady();
	// Name the ranked songs here rather than making the client fetch the whole catalog to join: the play log stores media ids only, and an id is not a song title anyone can read. ONE map read for both axes — per-field copies of it would be two more full-catalog allocations for the same lookups.
	const displayOf = new Map(app.media.all().map((m) => [m.id, songDisplay(m)]));
	const titleOf = (mediaId: string) => displayOf.get(mediaId)?.title ?? mediaId;

	const topAllTime = app.playLog.topSongs(10);
	const topRecent = app.playLog.topSongs(10, since);

	return json({
		library: {
			ready: ready.length, // songs you can actually sing — what a guest means by "how many songs"
			// Every row ever materialised by a search, most of which are not processed; reported alongside rather than instead, since quoting it alone would badly overstate the singable library.
			catalog: app.media.all().length
		},
		sings: {
			total: app.playLog.total(),
			window: app.playLog.totalSince(since),
			distinctSongs: app.playLog.distinctSongs()
		},
		topSongs: topAllTime.map((s) => ({ ...s, title: titleOf(s.mediaId) })),
		topRecent: topRecent.map((s) => ({ ...s, title: titleOf(s.mediaId) })),
		// Artists are ranked from PLAYS, joined through the canonical name; songs with an unparseable artist are dropped by the aggregator (see topArtists) rather than bucketed as "Unknown".
		topArtists: topArtists(topAllTime.length ? app.playLog.topSongs(500) : [], displayOf),
		perDay: app.playLog.perDay(since),
		window: { days, since }
	});
};

/** Rank artists by total plays of their songs. Songs with NO canonical artist are EXCLUDED rather than
 *  bucketed as "Unknown": the normalizer stores null instead of guessing on a low-confidence parse,
 *  and `media.artist` holds the YouTube uploader ("7clouds"), not the artist, so an "Unknown" row would
 *  usually be the largest bar on the chart and say nothing. Excluding it keeps the list short and true. */
function topArtists(
	plays: { mediaId: string; plays: number }[],
	displayOf: Map<string, { artist: string | null }>
): { artist: string; plays: number }[] {
	const totals = new Map<string, number>();
	for (const p of plays) {
		const artist = displayOf.get(p.mediaId)?.artist;
		if (!artist) continue;
		totals.set(artist, (totals.get(artist) ?? 0) + p.plays);
	}
	return [...totals.entries()]
		.map(([artist, plays]) => ({ artist, plays }))
		.sort((a, b) => b.plays - a.plays)
		.slice(0, 10);
}
