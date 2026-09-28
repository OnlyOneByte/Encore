// Done-when: the library page can be filtered, faceted and ordered without a DOM, and a facet can never strand you.
import { test, expect } from 'bun:test';
import {
	artistFacetsOf,
	browseLibrary,
	libraryShelf,
	LIBRARY_SHELF,
	libraryWindow,
	LIBRARY_PAGE,
	foldForMatch,
	libraryArtist,
	queryTerms,
	sortLibrary,
	tagFacetsOf
} from '$lib/library-browse';
import type { Media } from '$lib/contract';

/** Ids are ULID-SHAPED and ascending, because `newest` sorts on them: a random id would make that assertion luck. */
function song(id: string, title: string, artistCanonical?: string, artist?: string): Media {
	return {
		id,
		source: 'youtube',
		sourceRef: `ref-${id}`,
		title,
		...(artist ? { artist } : {}),
		...(artistCanonical ? { artistCanonical } : {}),
		durationSec: 200,
		stemStatus: 'ready'
	} as Media;
}

const LIB = [
	song('01H0000001', 'Bohemian Rhapsody', 'Queen'),
	song('01H0000002', 'Dancing Queen', 'ABBA'),
	song('01H0000003', 'Halo', 'Beyoncé'),
	song('01H0000004', 'Take On Me', undefined, 'a-ha VEVO'),
	song('01H0000005', 'Killer Queen', 'Queen')
];
const TAGS: Record<string, string[]> = {
	'01H0000001': ['rock', '70s'],
	'01H0000002': ['disco', '70s'],
	'01H0000005': ['rock']
};

const titles = (rows: Media[]) => rows.map((m) => m.title);

// ── the text filter ──────────────────────────────────────────────────────────

test('a term matches mid-word, because half-remembering a title is the normal case here', () => {
	expect(titles(browseLibrary({ library: LIB, tags: TAGS, query: 'hemian' }))).toEqual(['Bohemian Rhapsody']);
});

test('every term must match, and order between them does not matter', () => {
	expect(titles(browseLibrary({ library: LIB, tags: TAGS, query: 'queen killer' }))).toEqual(['Killer Queen']);
});

test('an accent is reachable from a keyboard that cannot type it', () => {
	expect(titles(browseLibrary({ library: LIB, tags: TAGS, query: 'beyonce' }))).toEqual(['Halo']);
});

test('the artist is searchable, not just the title', () => {
	expect(titles(browseLibrary({ library: LIB, tags: TAGS, query: 'abba' }))).toEqual(['Dancing Queen']);
});

test('tags are searchable, so "disco" finds a song whose title says nothing about disco', () => {
	expect(titles(browseLibrary({ library: LIB, tags: TAGS, query: 'disco' }))).toEqual(['Dancing Queen']);
});

test('an empty or punctuation-only query filters NOTHING rather than matching nothing', () => {
	for (const query of ['', '   ', '!!!', '()'])
		expect(browseLibrary({ library: LIB, tags: TAGS, query })).toHaveLength(LIB.length);
});

test('queryTerms folds and splits; no terms means no filter', () => {
	expect(queryTerms('  Dancing   QUEEN ')).toEqual(['dancing', 'queen']);
	expect(queryTerms('...')).toEqual([]);
});

test('foldForMatch collapses punctuation to a space rather than deleting it', () => {
	// Deleting would weld this to "acdc" and make the likelier query "dc" miss.
	expect(foldForMatch('AC/DC')).toBe('ac dc');
	expect(foldForMatch('Beyoncé — Halo')).toBe('beyonce halo');
});

// ── facets ───────────────────────────────────────────────────────────────────

test('artist facets count the canonical artist and rank by count', () => {
	expect(artistFacetsOf(LIB)).toEqual([
		{ artist: 'Queen', count: 2 },
		{ artist: 'ABBA', count: 1 },
		{ artist: 'Beyoncé', count: 1 }
	]);
});

test('an uploader is NOT an artist facet — a channel name must not pose as one', () => {
	// 'Take On Me' carries only `artist: 'a-ha VEVO'`, the uploader, and no confident canonical artist.
	expect(artistFacetsOf(LIB).map((f) => f.artist)).not.toContain('a-ha VEVO');
});

test('tag facets rank by count, and a song tagged twice cannot inflate one', () => {
	expect(tagFacetsOf(LIB, { ...TAGS, '01H0000001': ['rock', 'rock', '70s'] })).toEqual([
		{ tag: '70s', count: 2 },
		{ tag: 'rock', count: 2 },
		{ tag: 'disco', count: 1 }
	]);
});

test('THE STRANDING RULE: facets describe the whole library, so picking one still offers the others', () => {
	const picked = browseLibrary({ library: LIB, tags: TAGS, facet: { artist: 'Queen' } });
	expect(titles(picked)).toEqual(['Bohemian Rhapsody', 'Killer Queen']);
	// Facets are built from LIB, never from `picked` — collapsing them to {Queen: 2} is what strands a guest.
	expect(artistFacetsOf(LIB)).toHaveLength(3);
});

test('a facet and the text filter compose', () => {
	expect(titles(browseLibrary({ library: LIB, tags: TAGS, facet: { artist: 'Queen' }, query: 'killer' }))).toEqual([
		'Killer Queen'
	]);
});

test('tag facet selects by tag', () => {
	expect(titles(browseLibrary({ library: LIB, tags: TAGS, facet: { tag: '70s' }, sort: 'title' }))).toEqual([
		'Bohemian Rhapsody',
		'Dancing Queen'
	]);
});

test('artist WINS over tag, so the two can never intersect into an unexplained empty page', () => {
	// 'Beyoncé' carries no tags at all; were both applied this would be empty.
	expect(titles(browseLibrary({ library: LIB, tags: TAGS, facet: { artist: 'Beyoncé', tag: '70s' } }))).toEqual([
		'Halo'
	]);
});

// ── ordering ─────────────────────────────────────────────────────────────────

test('newest is id descending, which is ULID time descending', () => {
	expect(titles(sortLibrary(LIB, 'newest'))).toEqual([
		'Killer Queen',
		'Take On Me',
		'Halo',
		'Dancing Queen',
		'Bohemian Rhapsody'
	]);
});

test('title sort ignores case and accents', () => {
	expect(titles(sortLibrary(LIB, 'title'))).toEqual([
		'Bohemian Rhapsody',
		'Dancing Queen',
		'Halo',
		'Killer Queen',
		'Take On Me'
	]);
});

test('title sort is numeric, so 2 comes before 10', () => {
	const rows = [song('01H000000A', 'Song 10'), song('01H000000B', 'Song 2')];
	expect(titles(sortLibrary(rows, 'title'))).toEqual(['Song 2', 'Song 10']);
});

test('artist sort orders by the artist the row DISPLAYS, uploader included', () => {
	// 'Take On Me' has no canonical artist but does show its uploader, so it sorts under "a-ha VEVO" — the order
	// has to agree with the byline a guest is reading, not with the narrower field the facets count.
	// "a-ha VEVO" folds to "a ha vevo", and the collator weighs that space ahead of ABBA's "b" — deterministic
	// because the locale is pinned to 'en' rather than taken from the runtime.
	expect(titles(sortLibrary(LIB, 'artist'))).toEqual([
		'Take On Me',
		'Dancing Queen',
		'Halo',
		'Bohemian Rhapsody',
		'Killer Queen'
	]);
});

test('artist sort puts a row with NO artist at all last, not under an empty string', () => {
	// Its own fixture: every row in LIB shows an artist of some kind. A block of nameless rows above the As
	// reads as a rendering fault, so the truly unattributed sink.
	const rows = [song('01H000000C', 'Untitled Jam'), song('01H000000D', 'Zebra', 'Aardvark')];
	expect(titles(sortLibrary(rows, 'artist'))).toEqual(['Zebra', 'Untitled Jam']);
});

test('artist sort breaks ties on title, never on input order', () => {
	expect(libraryArtist(LIB[0]!)).toBe('Queen');
	const byArtist = sortLibrary(LIB, 'artist');
	const queens = byArtist.filter((m) => libraryArtist(m) === 'Queen');
	expect(titles(queens)).toEqual(['Bohemian Rhapsody', 'Killer Queen']);
});

test('libraryArtist prefers the canonical artist over the uploader', () => {
	expect(libraryArtist(song('01H1', 't', 'Real Artist', 'Some VEVO Channel'))).toBe('Real Artist');
	expect(libraryArtist(song('01H2', 't', undefined, 'Some VEVO Channel'))).toBe('Some VEVO Channel');
});

// ── the home shelf ───────────────────────────────────────────────────────────
// Covered HERE and not e2e on purpose: the Playwright fixture seeds exactly four demo tracks, so the cap can
// never truncate under it and a spec asserting the `See all` door would be permanently vacuous.

test('the shelf caps at four and reports what it hid', () => {
	const rows = Array.from({ length: 9 }, (_, i) => song(`01H00000${i}`, `Song ${i}`));
	const { shown, hidden } = libraryShelf(rows);
	expect(shown).toHaveLength(LIBRARY_SHELF);
	expect(titles(shown)).toEqual(['Song 0', 'Song 1', 'Song 2', 'Song 3']);
	expect(hidden).toBe(5);
});

test('the shelf keeps the order it was handed, so `newest first` survives it', () => {
	// The route passes `room.library`, which arrives orderBy(desc(media.id)). Re-sorting here would silently
	// turn the shelf alphabetical and stop showing the song you just made.
	const newestFirst = sortLibrary(LIB, 'newest');
	expect(titles(libraryShelf(newestFirst).shown)).toEqual(titles(newestFirst).slice(0, LIBRARY_SHELF));
});

test('hidden is 0 at and below the cap, which is what hides the door', () => {
	for (const n of [0, 1, 3, 4]) {
		const rows = Array.from({ length: n }, (_, i) => song(`01H0000${i}`, `S${i}`));
		expect(libraryShelf(rows)).toEqual({ shown: rows, hidden: 0 });
	}
});

// ── the /library window ──────────────────────────────────────────────────────
// The route holds only `revealed`; the arithmetic that decides whether the reveal control exists lives here, because
// a page that hides a song you own and offers no control is the one failure this window may never produce.

test('the window renders one page and reports the rest, which is what puts the control on screen', () => {
	const rows = Array.from({ length: LIBRARY_PAGE + 7 }, (_, i) => song(`01H${String(i).padStart(5, '0')}`, `S${i}`));
	const first = libraryWindow(rows, LIBRARY_PAGE);
	expect(first.shown).toHaveLength(LIBRARY_PAGE);
	expect(first.hidden).toBe(7);
	// One more tap exhausts it, and `hidden: 0` is what removes the control rather than leaving it promising nothing.
	expect(libraryWindow(rows, LIBRARY_PAGE * 2)).toEqual({ shown: rows, hidden: 0 });
});

test('the window never hides a row it cannot account for, at any revealed count', () => {
	const rows = Array.from({ length: 25 }, (_, i) => song(`01H${String(i).padStart(5, '0')}`, `S${i}`));
	// -1 INCLUDED: `slice(0, -1)` counts from the END, so an unclamped window would drop the last row and report
	// `hidden: 1` for a row it had actually rendered — the one arrangement that could strand a song silently.
	for (const revealed of [-1, 0, 1, 24, 25, 60]) {
		const { shown, hidden } = libraryWindow(rows, revealed);
		expect(shown).toEqual(rows.slice(0, shown.length));
		expect(shown.length + hidden).toBe(rows.length);
		expect(hidden).toBeGreaterThanOrEqual(0);
	}
});

test('sorting does not mutate the caller', () => {
	const before = titles(LIB);
	sortLibrary(LIB, 'title');
	expect(titles(LIB)).toEqual(before);
});
