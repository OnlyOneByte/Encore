// Done-when: a Spotify result flows through the resolver, is served from cache on a repeat, and the
// resolver is a no-op when its injected backend returns [] (creds unset) — RED on base: no
// SpotifyResolver exists there.
import { test, expect } from 'bun:test';
import { SpotifyResolver } from './spotify-resolver';
import type { SearchResult } from './resolver';

const fakeResult = (id: string): SearchResult => ({
	source: 'spotify',
	sourceRef: id,
	title: 'T-' + id,
	artist: 'A-' + id,
	durationSec: 200
});

test('a spotify result flows through and is source-tagged spotify', async () => {
	const r = new SpotifyResolver(async () => [fakeResult('track1')]);
	const out = await r.search('mr brightside', 5);
	expect(out).toHaveLength(1);
	expect(out[0].source).toBe('spotify');
	expect(out[0].sourceRef).toBe('track1');
});

test('second identical query is served from cache (backend called once)', async () => {
	let calls = 0;
	const r = new SpotifyResolver(async () => {
		calls++;
		return [fakeResult('t1')];
	});
	await r.search('abba', 5);
	await r.search('abba', 5);
	expect(calls).toBe(1);
	expect(r.cacheSize).toBe(1);
});

test('concurrent identical queries dedupe to one backend call', async () => {
	let calls = 0;
	const r = new SpotifyResolver(async () => {
		calls++;
		await new Promise((res) => setTimeout(res, 20));
		return [fakeResult('t1')];
	});
	await Promise.all([r.search('queen', 5), r.search('queen', 5), r.search('queen', 5)]);
	expect(calls).toBe(1);
});

test('a no-op backend (creds unset) yields no results', async () => {
	const r = new SpotifyResolver(async () => []);
	expect(await r.search('anything', 5)).toEqual([]);
});

test('the resolver kind is spotify', () => {
	const r = new SpotifyResolver(async () => []);
	expect(r.kind).toBe('spotify');
});
