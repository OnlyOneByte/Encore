// An ANNOTATOR ONLY: audio is never fetched from Spotify. Credentials live in ENV VARS only — this app has
// no secret storage and must not become the first to add one. Unset creds degrade to [] rather than
// throwing, and each failure path below names its reason, so only a clean no-match stays silent.

import type { SearchResult } from './resolver';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SEARCH_URL = 'https://api.spotify.com/v1/search';
const TOKEN_SKEW_MS = 30_000; // refresh a little early so a request never rides an about-to-expire token
const SEARCH_TIMEOUT_MS = 10_000; // a hung upstream must not hold the request open (mirrors ytdlp)

interface SpotifyEnv {
	clientId: string;
	clientSecret: string;
}

/** Null when either is unset — the graceful-degrade signal. */
export function spotifyEnv(env: Record<string, string | undefined> = process.env): SpotifyEnv | null {
	const clientId = env.SPOTIFY_CLIENT_ID?.trim();
	const clientSecret = env.SPOTIFY_CLIENT_SECRET?.trim();
	if (!clientId || !clientSecret) return null;
	return { clientId, clientSecret };
}

/**
 * `sourceRef` is the Spotify track id and is NEVER fetched: `isProcessableSource` is the sole authority that
 * refuses processing it, and `fetcherFor` does NOT refuse a spotify source — it returns the default
 * downloader as a floor. `duration_ms` rounds to whole seconds; artist billing is joined in full.
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
		// Images are listed largest-first, so the last is the cheapest thumbnail.
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

// One cached app token per process: a credential property, not a per-request one.
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
		if (!res.ok) {
			// Logged, so a bad-creds 401 stays distinguishable from a throttle or outage.
			console.warn(`[spotify] token endpoint refused with ${res.status}; search will degrade to empty`);
			return null;
		}
		const j = (await res.json()) as { access_token?: string; expires_in?: number };
		if (!j.access_token) {
			// A 200 with no access_token is a malformed token response, not a miss.
			console.warn('[spotify] token endpoint returned 200 but no access_token; search will degrade to empty');
			return null;
		}
		_token = { value: j.access_token, expiresAt: now() + (j.expires_in ?? 3600) * 1000 };
		return _token.value;
	} catch (err) {
		// Logged too, or a thrown fetch is invisible next to the []-degrade.
		console.warn('[spotify] token fetch failed (network/DNS/TLS); search will degrade to empty:', err);
		return null;
	}
}

/** Test-only: drops the cached token so a test controls issuance deterministically. */
export function _resetSpotifyToken(): void {
	_token = null;
}

/** Never throws: [] on missing creds, token refusal, upstream error or timeout. */
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
		if (!res.ok) {
			// Logged, or a throttle reads identically to a clean no-match.
			console.warn(`[spotify] search refused with ${res.status}; degrading to empty`);
			return [];
		}
		return parseSpotifySearchJson(await res.json());
	} catch (err) {
		// Logged, or a timeout-abort and a network fault collapse indistinguishably into [].
		console.warn('[spotify] search failed (timeout/network); degrading to empty:', err);
		return [];
	} finally {
		clearTimeout(killer);
	}
}
