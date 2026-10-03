// YouTube Music resolver backend — keyless search against music.youtube.com's own InnerTube API.
//
// WHY A SECOND YOUTUBE SEARCH EXISTS. `ytsearch` (ytdlp.ts) searches ALL of YouTube: official videos,
// lyric-video reuploads, hour loops, live cuts — the uploader is the `artist`, so a hit reads
// "Never Be Alone — Tasty" (the channel), not the artist. YouTube Music's `songs` filter returns the
// MUSIC CATALOG entity: the real artist, the album, the track duration — the row a singer actually
// wants to pick from. Measured on the same query, yt-dlp's flat music-search output carries only
// id+title (its extractor does not enrich stub entries), while one InnerTube POST returns everything —
// and in one HTTP round-trip instead of a subprocess.
//
// IDENTITY: results are `source: 'youtube'`. A music hit IS a YouTube video id — the fetcher, the
// thumbnail derivation, retention and origin-dedupe all already speak that identity, and giving it a
// new `source` would split the same video into two library rows. WHERE a hit was found is not part of
// WHAT it is.
//
// INNERTUBE IS UNOFFICIAL and the response shape can move. Every read below is defensive: a row that
// does not parse is dropped, an empty page returns [], and the resolver wrapping this backend
// (`YouTubeResolver`) already tolerates a dead source. The `WEB_REMIX` client context and the `params`
// filter blob ("songs only") are the same constants ytmusicapi has shipped for years.

import type { SearchResult } from './resolver';
import { ytThumbnailUrl } from './ytdlp';

const SEARCH_URL = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false';

//: The InnerTube "songs" filter. Base64 of a protobuf the web client sends when you click the Songs
//: chip; without it the response mixes albums, playlists, artists and videos.
const SONGS_FILTER = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';

const CLIENT_CONTEXT = {
	client: { clientName: 'WEB_REMIX', clientVersion: '1.20250219.01.00', hl: 'en' }
};

/** "4:20" | "1:02:03" -> seconds; anything else -> undefined. */
export function parseDuration(text: string): number | undefined {
	const parts = text.trim().split(':');
	if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+$/.test(p))) return undefined;
	return parts.reduce((total, p) => total * 60 + Number(p), 0);
}

/** "827K plays" | "1.2M plays" | "263 plays" -> a number; anything else -> undefined. Display-only. */
export function parsePlays(text: string): number | undefined {
	const m = /^([\d.,]+)\s*([KMB])?\s*plays?$/i.exec(text.trim());
	if (!m) return undefined;
	const scale = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? '').toUpperCase() as 'K' | 'M' | 'B'] ?? 1;
	const n = Number((m[1] ?? '').replace(/,/g, ''));
	return Number.isFinite(n) ? Math.round(n * scale) : undefined;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- InnerTube JSON has no schema to type against;
   every access below is guarded and a failure drops one row, never the page. */

/** Every `key`-valued object anywhere under `node`, depth-first. InnerTube nests renderers many levels
 * deep and moves them between releases; searching by key is what survives reshuffles. */
function collect(node: any, key: string, out: any[] = []): any[] {
	if (Array.isArray(node)) for (const v of node) collect(v, key, out);
	else if (node && typeof node === 'object') {
		if (key in node) out.push(node[key]);
		for (const v of Object.values(node)) collect(v, key, out);
	}
	return out;
}

const runsText = (col: any): string[] =>
	(col?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? []).map((r: any) => String(r?.text ?? ''));

/** Split a flex column's runs on the " • " separator runs the web client renders between fields. */
function segments(runs: string[]): string[][] {
	const out: string[][] = [[]];
	for (const run of runs) {
		if (/^\s*•\s*$/.test(run)) out.push([]);
		else out[out.length - 1]?.push(run);
	}
	return out.filter((s) => s.length > 0);
}

/** The parse half, pure and hermetically testable: an InnerTube search response -> SearchResults. */
export function parseMusicSearch(doc: unknown, limit: number): SearchResult[] {
	const out: SearchResult[] = [];
	for (const row of collect(doc, 'musicResponsiveListItemRenderer')) {
		if (out.length >= limit) break;
		const videoId = collect(row, 'videoId')[0];
		if (typeof videoId !== 'string' || !videoId) continue;
		const cols = (row?.flexColumns ?? []).map(runsText);
		const title = (cols[0] ?? []).join('').trim();
		if (!title) continue;

		// Column 1 is "artist(s) • album • duration"; artists can span several runs ("A, B & C").
		const meta = segments(cols[1] ?? []);
		const artist = meta[0]?.join('').trim() || undefined;
		const last = meta[meta.length - 1]?.join('').trim() ?? '';
		const durationSec = parseDuration(last);
		const plays = (cols[2] ?? ([] as string[]))
			.map((t: string) => parsePlays(t))
			.find((n: number | undefined) => n !== undefined);

		out.push({
			source: 'youtube',
			sourceRef: videoId,
			title,
			artist,
			// A row with no parseable duration still lists — duration is display + probe-verified later.
			durationSec: durationSec ?? 0,
			thumbnail: ytThumbnailUrl(videoId),
			viewCount: plays
		});
	}
	return out;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

export type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** The fetch half — a `YtSearchBackend` for `YouTubeResolver`, so music search gets the same
 * per-query cache and in-flight dedupe the ytsearch backend has. */
export function innerTubeMusicSearch(fetchImpl: FetchLike = fetch) {
	return async (query: string, limit: number): Promise<SearchResult[]> => {
		const res = await fetchImpl(SEARCH_URL, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				// InnerTube 403s requests without a plausible web origin.
				origin: 'https://music.youtube.com',
				'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
			},
			body: JSON.stringify({ context: CLIENT_CONTEXT, query, params: SONGS_FILTER })
		});
		if (!res.ok) return [];
		return parseMusicSearch(await res.json(), limit);
	};
}
