// Done-when: the pure Spotify /v1/search parser produces spotify-sourced SearchResults with seconds
// (not ms) duration and joined artist billing, AND spotifySearch degrades to [] when creds are unset.
// RED on base: no spotify backend exists there.
import { test, expect } from 'bun:test';
import { parseSpotifySearchJson, spotifyEnv, spotifySearch, _resetSpotifyToken } from './spotify';

test('parses tracks.items into spotify-sourced results (ms -> seconds, joined artists)', () => {
	const payload = {
		tracks: {
			items: [
				{
					id: '4uLU6hMCjMI75M1A2tKUQC',
					name: 'Never Gonna Give You Up',
					duration_ms: 213573,
					artists: [{ name: 'Rick Astley' }],
					album: {
						images: [
							{ url: 'https://big', width: 640 },
							{ url: 'https://small', width: 64 }
						]
					}
				},
				{
					id: 'collabId',
					name: 'Duet',
					duration_ms: 180000,
					artists: [{ name: 'Lady Gaga' }, { name: 'Beyoncé' }]
				}
			]
		}
	};
	const out = parseSpotifySearchJson(payload);
	expect(out).toHaveLength(2);
	expect(out[0].source).toBe('spotify');
	expect(out[0].sourceRef).toBe('4uLU6hMCjMI75M1A2tKUQC');
	expect(out[0].durationSec).toBe(214); // 213573ms rounded
	expect(out[0].artist).toBe('Rick Astley');
	expect(out[0].thumbnail).toBe('https://small'); // smallest image chosen
	expect(out[1].artist).toBe('Lady Gaga, Beyoncé'); // joined billing
});

test('parser tolerates a malformed / empty payload', () => {
	expect(parseSpotifySearchJson(null)).toEqual([]);
	expect(parseSpotifySearchJson({})).toEqual([]);
	expect(parseSpotifySearchJson({ tracks: { items: [{ name: 'no id' }, { id: 'x' }] } })).toHaveLength(0);
});

test('spotifyEnv returns null when either credential is unset', () => {
	expect(spotifyEnv({})).toBeNull();
	expect(spotifyEnv({ SPOTIFY_CLIENT_ID: 'a' })).toBeNull();
	expect(spotifyEnv({ SPOTIFY_CLIENT_ID: 'a', SPOTIFY_CLIENT_SECRET: 'b' })).toEqual({
		clientId: 'a',
		clientSecret: 'b'
	});
});

test('spotifySearch degrades to [] when creds are unset (no network)', async () => {
	_resetSpotifyToken();
	const out = await spotifySearch('anything', 5, { env: null });
	expect(out).toEqual([]);
});

test('spotifySearch tokenizes then searches with an injected fetch', async () => {
	_resetSpotifyToken();
	const now = 1_000_000;
	const calls: string[] = [];
	const fetchImpl = (async (url: string, _init?: unknown) => {
		calls.push(String(url));
		if (String(url).includes('accounts.spotify.com')) {
			return { ok: true, json: async () => ({ access_token: 'tok', expires_in: 3600 }) } as unknown as Response;
		}
		return {
			ok: true,
			json: async () => ({
				tracks: { items: [{ id: 'z', name: 'Song', duration_ms: 200000, artists: [{ name: 'X' }] }] }
			})
		} as unknown as Response;
	}) as unknown as typeof fetch;
	const out = await spotifySearch('song', 3, {
		env: { clientId: 'a', clientSecret: 'b' },
		fetchImpl,
		now: () => now
	});
	expect(out).toHaveLength(1);
	expect(out[0].source).toBe('spotify');
	expect(calls[0]).toContain('accounts.spotify.com'); // token first
	expect(calls[1]).toContain('api.spotify.com/v1/search'); // then search
});

test('spotifySearch returns [] on a token refusal', async () => {
	_resetSpotifyToken();
	const fetchImpl = (async () =>
		({ ok: false, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
	const out = await spotifySearch('song', 3, { env: { clientId: 'a', clientSecret: 'b' }, fetchImpl });
	expect(out).toEqual([]);
});
