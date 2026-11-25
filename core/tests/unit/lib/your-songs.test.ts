// The Your songs row's sub-line, only what is not zero, in guest words; and the tab's cache, one singer's alone.
import { test, expect, afterEach } from 'bun:test';
import { cachedYourSongs, forgetYourSongs, loadYourSongs, yourSongLine, type YourSongs } from '$lib/your-songs';

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	forgetYourSongs();
});
const answer = (songs: YourSongs) => {
	globalThis.fetch = (async () => new Response(JSON.stringify(songs))) as unknown as typeof fetch;
};
const alices: YourSongs = {
	songs: [
		{
			mediaId: 'm1',
			title: "Alice's song",
			artist: null,
			sung: 3,
			lastSungAt: 1,
			keyShift: -2,
			guideLevel: null,
			saved: null,
			media: null
		}
	],
	canKeep: false
};

test("Alice, then Leave, then Bob on the same phone: Bob's cache holds nothing of Alice's", async () => {
	answer(alices);
	expect(await loadYourSongs('alice')).toEqual(alices);
	expect(cachedYourSongs('alice')).toEqual(alices);
	// Another singer never reads it, left or not.
	expect(cachedYourSongs('bob')).toBeNull();
	// Leave: no one joined, so the page forgets it.
	forgetYourSongs();
	expect(cachedYourSongs('alice')).toBeNull();
	expect(cachedYourSongs('bob')).toBeNull();
	expect(cachedYourSongs(undefined)).toBeNull();
});

test('no singer, no request', async () => {
	let asked = 0;
	globalThis.fetch = (async () => (asked++, new Response('{}'))) as unknown as typeof fetch;
	expect(await loadYourSongs(undefined)).toBeNull();
	expect(asked).toBe(0);
});

const row = (o: Partial<Parameters<typeof yourSongLine>[0]> = {}) =>
	yourSongLine({ keyShift: null, guideLevel: null, sung: 0, saved: null, ...o });

test('a saved song you never sang says so and nothing else', () => {
	expect(row({ saved: { id: 's', savedAt: 1 } })).toBe('saved');
});

test('the key reads in keys up or down, one key singular', () => {
	expect(row({ keyShift: -2, sung: 3 })).toBe('2 keys down · sung 3 times');
	expect(row({ keyShift: 1, sung: 1 })).toBe('1 key up · sung once');
});

test('the guide shows only when it is on, by its preset name', () => {
	expect(row({ guideLevel: 0.3, sung: 1 })).toBe('guide low · sung once');
	expect(row({ guideLevel: 1, sung: 1 })).toBe('guide full · sung once');
	expect(row({ guideLevel: 0, sung: 1 })).toBe('sung once');
	// A level the song page's slider set between presets still says the guide is on.
	expect(row({ guideLevel: 0.6, sung: 1 })).toBe('guide on · sung once');
});
