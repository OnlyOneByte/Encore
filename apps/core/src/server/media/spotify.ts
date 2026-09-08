// Spotify backend — catalog SEARCH / metadata via Spotify's Web API (Search endpoint), used as an
// ANNOTATOR only. Spotify has clean canonical artist/title/duration where a YouTube upload title has
// to be reverse-engineered by parseTrackTitle; a Spotify hit sharpens the query, but its bytes are
// NEVER pulled from Spotify — the audio is still acquired from YouTube (docs/DECISIONS.md, the
// annotator pattern). So there is no fetch:spotify capability and no librespot acquisition here.
//
// CREDENTIALS live in ENV VARS, matching LRCLIB and every existing deployment knob (there is no
// secret storage in this app, and this must not become the first): SPOTIFY_CLIENT_ID and
// SPOTIFY_CLIENT_SECRET, a Client Credentials app registered at developer.spotify.com. The
// Client-Credentials flow needs no user login and is the sanctioned path for catalog search.
//
// GRACEFUL DEGRADATION mirrors ytDlpSearch: with the env vars unset (the default deployment), this
// returns [] rather than throwing, so the search fan-out simply has one fewer source — safeSearch in
// the route already tolerates a dead source by design.
//
// The pure parser (parseSpotifySearchJson) is separated so it unit-tests without the network or a
// token, exactly like parseSearchJson for yt-dlp.

import type { SearchResult } from './resolver';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';
const TOKEN_SKEW_MS = 30_000; // refresh a little early so a request never rides an about-to-expire token
const SEARCH_TIMEOUT_MS = 10_000; // a hung upstream must not hold the request open (mirrors ytdlp)

interface SpotifyEnv {
	clientId: string;
	clientSecret: string;
}

/** Read creds from the environment. Returns null when either is unset — the graceful-degrade signal. */
export function spotifyEnv(env: Record<string, string | undefined> = process.env): SpotifyEnv | null {
	const clientId = env.SPOTIFY_CLIENT_ID?.trim();
	const clientSecret = env.SPOTIFY_CLIENT_SECRET?.trim();
	if (!clientId || !clientSecret) return null;
	return { clientId, clientSecret };
}

/**
 * Pure: turn a Spotify /v1/search `tracks.items[]` payload into SearchResults.
 *
 * `source: 'spotify'` MARKS the provenance so the merge/UI can tell where the clean metadata came
 * from; `sourceRef` is the Spotify track id, which is NEVER fetched — `isCookableSource` (fetchers.ts)
 * is the one authority that refuses it, and every layer that decides whether a cook is possible asks
 * that. (`fetcherFor` does NOT refuse a spotify source; it returns the default downloader as a floor.)
 * `duration_ms` is milliseconds (Spotify), so it is rounded to whole seconds like the rest
 * of the codebase stores. The primary artist is `artists[0].name`; the full billing is joined so a
 * collab reads as the upload wrote it.
 */
export function parseSpotifySearchJson(json: unknown): SearchResult[] {
	const out: SearchResult[] = [];
	const items = (json as { tracks?: { items?: unknown[] } })?.tracks?.items;
	if (!Array.isArray(items)) return out;
	for (const raw of items) {
		const t = raw as {
			id?: string;
			name?: string;
			duration_ms?: number;
			artists?: { name?: string }[];
			album?: { images?: { url?: string; width?: number }[] };
		};
		if (!t.id || !t.name) continue;
		const names = Array.isArray(t.artists) ? t.artists.map((a) => a?.name).filter((n): n is string => !!n) : [];
		// Smallest album image that still exists — a search row thumbnail is tiny, and Spotify lists
		// images largest-first, so the last is the cheapest bytes for the phone's wifi.
		const images = t.album?.images ?? [];
		const thumb = images.length ? images[images.length - 1]?.url : undefined;
		out.push({
			source: 'spotify',
			sourceRef: t.id,
			title: t.name,
			artist: names.length ? names.join(', ') : undefined,
			durationSec: typeof t.duration_ms === 'number' ? Math.round(t.duration_ms / 1000) : 0,
			thumbnail: thumb
		});
	}
	return out;
}

// One cached app token, refreshed on expiry. Module-scoped because the token is a property of the
// process's credentials, not of any one request (same reasoning as the yt-dlp availability probe).
let _token: { value: string; expiresAt: number } | null = null;

async function appToken(env: SpotifyEnv, now: () => number, fetchImpl: typeof fetch): Promise<string | null> {
	if (_token && now() < _token.expiresAt - TOKEN_SKEW_MS) return _token.value;
	const basic = Buffer.from(`${env.clientId}:${env.clientSecret}`).toString('base64');
	try {
		const res = await fetchImpl(TOKEN_URL, {
			method: 'POST',
			headers: {
				Authorization: `Basic ${basic}`,
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: 'grant_type=client_credentials'
		});
		if (!res.ok) return null;
		const j = (await res.json()) as { access_token?: string; expires_in?: number };
		if (!j.access_token) return null;
		_token = { value: j.access_token, expiresAt: now() + (j.expires_in ?? 3600) * 1000 };
		return _token.value;
	} catch {
		return null;
	}
}

/** test-only: drop the cached token so a test controls token issuance deterministically. */
export function _resetSpotifyToken(): void {
	_token = null;
}

/**
 * The SpotifySearchBackend wired into SpotifyResolver in prod. Injectable `fetch`/`now`/`env` so it
 * unit-tests without the network. Returns [] (never throws) on any failure — missing creds, a token
 * refusal, an upstream error, or a timeout — so the search fan-out degrades gracefully.
 */
export async function spotifySearch(
	query: string,
	limit: number,
	opts: { env?: SpotifyEnv | null; fetchImpl?: typeof fetch; now?: () => number } = {}
): Promise<SearchResult[]> {
	const env = opts.env === undefined ? spotifyEnv() : opts.env;
	if (!env) return []; // creds unset — graceful degrade, exactly like yt-dlp absent
	const fetchImpl = opts.fetchImpl ?? fetch;
	const now = opts.now ?? Date.now;
	const token = await appToken(env, now, fetchImpl);
	if (!token) return [];
	const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&type=track&limit=${Math.max(1, Math.min(50, limit))}`;
	const controller = new AbortController();
	const killer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
	try {
		const res = await fetchImpl(url, {
			headers: { Authorization: `Bearer ${token}` },
			signal: controller.signal
		});
		if (!res.ok) return [];
		return parseSpotifySearchJson(await res.json());
	} catch {
		return [];
	} finally {
		clearTimeout(killer);
	}
}
