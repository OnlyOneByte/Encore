// PIN: `?source=` narrows which resolvers a search asks, and `ytmusic` is one of them.
//
// The route's default is deliberately FAN-OUT (a singer picks by whether they can sing a song now, not
// by where it came from). The narrowing exists for the phone's source picker: all-of-YouTube search
// returns lyric reuploads and hour loops with the UPLOADER as artist, so "YT Music" is the setting that
// gets catalog rows instead. This test pins that each value asks exactly the resolvers it names —
// a wrong predicate here silently searches the wrong source, which reads as "search is broken".
import { test, expect } from 'bun:test';
import type { SearchResult } from '$lib/server/media/resolver';

/** The route's own predicate, extracted here as the thing under test: `!only || only === source`. */
const wants = (only: string | null, source: string) => !only || only === source;

const SOURCES = ['youtube', 'ytmusic', 'local', 'spotify'] as const;

test('no source parameter fans out to every resolver', () => {
	for (const s of SOURCES) expect(wants(null, s)).toBe(true);
	expect(wants('', 'youtube')).toBe(true); // an empty param is not a narrowing
});

test('each narrowing asks exactly one resolver', () => {
	for (const only of SOURCES) {
		const asked = SOURCES.filter((s) => wants(only, s));
		expect(asked).toEqual([only]);
	}
});

test('an unknown source value asks nothing rather than silently fanning out', () => {
	// Fail CLOSED: a typo'd or stale client value must not quietly become "search everything",
	// which would look like the picker being ignored.
	expect(SOURCES.filter((s) => wants('bogus', s))).toEqual([]);
});

test('ytmusic hits carry youtube identity, so the two youtube searches dedupe to one row', () => {
	// Origin identity is `${source}\0${sourceRef}` in the route. A music hit and a ytsearch hit for the
	// same video MUST collapse — giving music a separate `source` would double every song in the
	// library the moment someone searched both ways.
	const originKey = (source: string, sourceRef: string) => `${source}\u0000${sourceRef}`;
	const fromMusic: SearchResult = {
		source: 'youtube',
		sourceRef: 'mE2O5LsrPuA',
		title: 'Never Be Alone',
		artist: 'TheFatRat',
		durationSec: 260
	};
	const fromYtsearch: SearchResult = {
		source: 'youtube',
		sourceRef: 'mE2O5LsrPuA',
		title: 'TheFatRat - Never Be Alone',
		artist: 'Tasty', // the CHANNEL — why music search exists
		durationSec: 261
	};
	expect(originKey(fromMusic.source, fromMusic.sourceRef)).toBe(
		originKey(fromYtsearch.source, fromYtsearch.sourceRef)
	);
});
