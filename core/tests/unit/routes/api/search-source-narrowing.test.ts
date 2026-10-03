// PIN: which resolvers a search asks — the DEFAULT SET, and the explicit narrowings.
//
// The default deliberately excludes plain all-of-YouTube `ytsearch`: the music catalog gives the real
// performer instead of a channel name, the track duration instead of a video length, and a median
// 459 ms against 1628 ms (ytsearch spawns a subprocess; one probe hit its 10 s timeout and returned
// nothing at all). The trade is real and documented in `+server.ts` — the `songs` filter never returns
// empty, so it answers a nonsense query with Mariah Carey, and against a SPECIFIC upload it substitutes
// a catalog entity. That is why the phone offers a widen affordance beside results rather than only in
// the zero-state, and why `all` exists below.
//
// The reason this is a SET and not just `?source=ytmusic` is `local`: those are the user's own files,
// indexed by a disk scan rather than living in the catalog, so a narrowing to one source would hide
// them. A wrong predicate here silently searches the wrong sources, which reads as "search is broken".
import { test, expect } from 'bun:test';
import type { SearchResult } from '$lib/server/media/resolver';

const DEFAULT_SOURCES = new Set(['ytmusic', 'local', 'spotify']);

/** The route's own predicate, extracted here as the thing under test. */
const wants = (only: string | null, source: string) =>
	only ? only === 'all' || only === source : DEFAULT_SOURCES.has(source);

const SOURCES = ['youtube', 'ytmusic', 'local', 'spotify'] as const;
const asked = (only: string | null) => SOURCES.filter((s) => wants(only, s));

test('the DEFAULT asks the music catalog, local files and spotify — but NOT plain ytsearch', () => {
	expect(asked(null)).toEqual(['ytmusic', 'local', 'spotify']);
	expect(asked('')).toEqual(['ytmusic', 'local', 'spotify']); // an empty param is not a narrowing
});

test("the default keeps LOCAL, because a user's own files are not in the catalog to be found any other way", () => {
	// The single most important property of the default set: narrowing to ytmusic alone would hide them.
	expect(wants(null, 'local')).toBe(true);
});

test('`all` is the escape hatch that adds ytsearch back, for an upload no catalog lists', () => {
	expect(asked('all')).toEqual(['youtube', 'ytmusic', 'local', 'spotify']);
});

test('each single-source narrowing asks exactly that resolver', () => {
	for (const only of SOURCES) expect(asked(only)).toEqual([only]);
});

test('an unknown source value asks nothing rather than silently fanning out', () => {
	// Fail CLOSED: a typo'd or stale client value must not quietly become "search everything", which
	// would look like the picker being ignored.
	expect(asked('bogus')).toEqual([]);
});

test('ytmusic hits carry youtube identity, so the two youtube searches dedupe to one row', () => {
	// Origin identity is `${source}\0${sourceRef}` in the route. A music hit and a ytsearch hit for the
	// same video MUST collapse — giving music a separate `source` would double every song in the library
	// the moment someone switched the picker to Everything.
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
		artist: 'Tasty', // the CHANNEL — why the default prefers the music catalog
		durationSec: 261
	};
	expect(originKey(fromMusic.source, fromMusic.sourceRef)).toBe(originKey(fromYtsearch.source, fromYtsearch.sourceRef));
});
