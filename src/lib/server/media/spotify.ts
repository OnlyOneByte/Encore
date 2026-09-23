// Spotify Search is an ANNOTATOR ONLY — audio is never fetched from Spotify, only from YouTube.
// Credentials (SPOTIFY_CLIENT_ID/SECRET, Client-Credentials flow) live in env vars only; this app
// has no secret storage and must not become the first to add one. Creds unset degrades to []
// instead of throwing; each failure path below names its reason so only that case stays silent.

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
 * Turns a Spotify /v1/search payload into SearchResults. `source: 'spotify'` marks provenance;
 * `sourceRef` (the Spotify track id) is NEVER fetched — `isProcessableSource` is the sole authority
 * that refuses processing it (`fetcherFor` does NOT refuse a spotify source; it returns the default
 * downloader as a floor). `duration_ms` is rounded to whole seconds; artist billing is joined in full.
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
		// Spotify lists images largest-first; the last is the smallest — cheapest thumbnail bytes.
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

// Module-scoped: one cached app token per process (a credential property, not a per-request one).
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
			// Log the status so a bad-creds 401 is distinguishable from a throttle or outage; the []-degrade is unchanged.
			console.warn(`[spotify] token endpoint refused with ${res.status}; search will degrade to empty`);
			return null;
		}
		const j = (await res.json()) as { access_token?: string; expires_in?: number };
		if (!j.access_token) {
			// a 200 with no access_token is a malformed/unexpected token response, not a miss.
			console.warn('[spotify] token endpoint returned 200 but no access_token; search will degrade to empty');
			return null;
		}
		_token = { value: j.access_token, expiresAt: now() + (j.expires_in ?? 3600) * 1000 };
		return _token.value;
	} catch (err) {
		// Log network/DNS/TLS failures too, or a thrown fetch is invisible next to the []-degrade.
		console.warn('[spotify] token fetch failed (network/DNS/TLS); search will degrade to empty:', err);
		return null;
	}
}

/** test-only: drop the cached token so a test controls token issuance deterministically. */
export function _resetSpotifyToken(): void {
	_token = null;
}

/**
 * Wired into SpotifyResolver in prod; `fetch`/`now`/`env` are injectable for tests. Never throws —
 * returns [] on any failure (missing creds, token refusal, upstream error, timeout).
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
		if (!res.ok) {
			// Log res.status, or a throttle (429) reads identically to a clean no-match.
			console.warn(`[spotify] search refused with ${res.status}; degrading to empty`);
			return [];
		}
		return parseSpotifySearchJson(await res.json());
	} catch (err) {
		// Log timeout-abort vs network fault too, or both collapse indistinguishably into [].
		console.warn('[spotify] search failed (timeout/network); degrading to empty:', err);
		return [];
	} finally {
		clearTimeout(killer);
	}
}
