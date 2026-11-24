/*
 * THE LIBRARY PAGE'S LOGIC, out of the route so it is testable without a DOM. See docs/FRONTEND.md#the-library-page.
 *
 * ONE EXPORT IS SHARED WITH THE SING TAB, and the file's name no longer covers it: `LIBRARY_PAGE` and
 * `libraryWindow` are imported by `/` as well, which windows its three search-result groups the same way. Nothing
 * else here is — the filtering, facets and sort are /library's alone, because /library narrows a list it already
 * holds in memory while `/` fetches from three resolvers. Keep that split: a `/`-shaped concern added below would
 * be reachable from a module every surface treats as the library page's.
 *
 * WHAT "YOUR LIBRARY" IS: the READY catalog — `MediaRepository.listReady()`, served by /api/library and mirrored whole
 * in `room.library`. It is NOT the `local` resolver, which searches audio FILES in the media directory: a processed
 * YouTube song is in the library and absent from that list, so `/api/search?source=local` answers a different question
 * and must not back this page.
 *
 * FILTERING IS CLIENT-SIDE, DELIBERATELY. The whole ready list is already in memory — `room.library` mirrors it for
 * every surface — so narrowing costs no request. That is also the one thing keeping this field distinguishable from
 * the home column's: home's search FETCHES from three resolvers and needs a spinner, this one only hides rows and is
 * instant. Two fields that look alike and do opposite things would be worse than the reachability problem this page
 * fixes, so the difference has to be felt, not just labelled.
 *
 * THE SHELF IS RETIRED (2026-10-03), and it is named here because its constants lived in this file. `LIBRARY_SHELF`
 * (4), `LIBRARY_SHELF_WIDE` (8) and `libraryShelf()` capped a `Your library` shelf on the HOME column, picking
 * between the two numbers off a `matchMedia` read. The phone-first rebuild made browsing the Library TAB's whole
 * job — on screen at every width — so the shelf, its door and that width read are gone from the Sing tab, and the
 * three exports went with them rather than surviving as a module no surface imports with tests that only proved
 * arithmetic. `libraryWindow` below is the survivor and is a DOOR rather than a cap; see its note.
 */
import type { LibrarySizes, Media } from '$lib/contract';

/** How rows are ordered. `newest` is the order the server already returns; see {@link sortLibrary}. */
export type LibrarySort = 'newest' | 'title' | 'artist';

/** A facet may be picked one at a time, never both — the same mutual exclusion /api/library imposes on ?artist/?tag. */
export interface LibraryFacet {
	artist?: string | null;
	tag?: string | null;
}

/**
 * Chips per facet row. A cap rather than a scroller: a horizontally scrolling row hides its own overflow, and past a
 * dozen the chips stop being a glance and become a second list to read. Everything below the cap is still reachable by
 * typing, which is what the filter field is for.
 */
export const FACET_CHIP_LIMIT = 12;

/**
 * Rows a reveal renders, on BOTH surfaces that window: `/library`'s match list, and each of `/`'s three
 * search-result groups. NOT a cap on either — `/library` is the only place every ready song is reachable, and `/`
 * hands back every row /api/search returned — so a row either surface refuses to show is a song with nowhere left to
 * reach it. The window GROWS by this much per tap.
 *
 * SIXTY, measured rather than chosen, on a 390x844 phone at a 4x CPU throttle with 2000 ready songs: the whole list
 * took 4.6s and 40,125 DOM nodes before the first row was usable, and the backspace that widened the filter again
 * blocked the main thread for 3.4s. One page of sixty is 1,328 nodes and 0.9s. Sixty rows is also ~4300px — five
 * screens of scrolling to reach the control, so the reveal is not friction anyone meets on a party-sized library.
 *
 * THE SING TAB'S COLUMN IS ITS OWN MEASUREMENT, not those figures re-quoted: those were taken on /library at a 4x
 * throttle, and `/` was measured un-throttled on a real search. A row there costs ~16-17 DOM nodes and 85-95px, and
 * the spread in the second figure is which deltas you take. TWO CROSS-QUERY deltas off the same server — 3,344 rows
 * (3,412 rows / 56,260 nodes / 320,120px against 68 / 1,230 / 7,280) reading 16.5 nodes and 93.6px, and 226 rows
 * (294 / 5,054 / 28,967 against the same 68-row query) reading 16.9 and 96.0 — carry each group's heading, door and
 * widen along with the rows. TWO SAME-QUERY deltas, one `Needs karaoke` reveal each on `q=a` at 390x844, isolate the
 * rows: 120 / 2,033 / 12,493px to 180 / 3,007 / 17,716 reads 16.23 nodes and 87.05px, and 180 to 240 / 3,969 / 22,726
 * reads 16.03 and 83.50. So sixty rows is ~5,000-5,700px there depending on which you ask for, and the worst query
 * that copy has — two groups at the cap, 120 rows — measures ~12,500px against 320,120 un-windowed (12,493 on the
 * last re-measurement), which is what keeps the `Not it? Search everything` control's own
 * "low in the column" reasoning true. It is REUSED rather than re-chosen because two surfaces windowing the same way
 * is one rule a guest learns once; a Sing-tab-specific page size is a real option if that column's widen hatch
 * proves too deep, and nothing here assumes it never will.
 */
export const LIBRARY_PAGE = 60;

/** The window and what is still behind the reveal control. `hidden` is what the `Show N more` control announces, and
 *  0 is what hides that control entirely — a control promising more than it has is worse than no control. It lives
 *  out of the route so the arithmetic stays provable in the unit suite. The clamp is what keeps a negative `revealed`
 *  from making `slice` count from the END and silently drop the top of the list. */
export function libraryWindow<T>(rows: T[], revealed: number): { shown: T[]; hidden: number } {
	const shown = rows.slice(0, Math.max(0, revealed));
	return { shown, hidden: rows.length - shown.length };
}

/**
 * Locale-aware and EXPLICITLY 'en' rather than the runtime default, so a test and a browser in another locale cannot
 * disagree about order. `numeric` puts "Song 2" before "Song 10"; `sensitivity: 'base'` because {@link foldForMatch}
 * has already removed the case and accents this would otherwise weigh.
 */
const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * One comparable form for matching AND ordering. NFD then strip combining marks, so "Beyoncé" is reachable by typing
 * "beyonce" on a keyboard that cannot produce the accent. Punctuation collapses to a single space rather than being
 * deleted: deleting it would weld "AC/DC" into "acdc" and make the far more likely query "dc" miss.
 */
export function foldForMatch(s: string): string {
	return s
		.normalize('NFD')
		.replace(/\p{M}+/gu, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

/** The artist a ready row SHOWS — `artistCanonical` first, matching SongRow's byline for a ready song. */
export function libraryArtist(m: Media): string | undefined {
	return m.artistCanonical ?? m.artist;
}

/**
 * Every term must appear SOMEWHERE in the row, and as a substring rather than a prefix: this narrows a shelf you
 * already own, where half-remembering a word in the middle of a title ("hemian") is the normal case. Matching is
 * generous on purpose — the cost of an extra row on screen is nothing, and the cost of hiding a song you own is the
 * whole point of the page.
 */
function matchesQuery(haystack: string, terms: string[]): boolean {
	return terms.every((t) => haystack.includes(t));
}

/** Title, artist and tags, folded once per row so a multi-term query does not re-fold it per term. */
function haystackFor(m: Media, tags: string[] | undefined): string {
	return foldForMatch([m.title, libraryArtist(m) ?? '', ...(tags ?? [])].join(' '));
}

/** The query's terms, folded and split. Empty (no terms) means "no filter", NOT "match nothing". */
export function queryTerms(query: string): string[] {
	const folded = foldForMatch(query);
	return folded ? folded.split(' ') : [];
}

/**
 * Order the rows. `newest` is `id` DESCENDING, which is genuinely newest-first and not a guess: a media id is a ULID
 * whose first ten characters are a base32 millisecond clock, so it sorts by time. It is the time the row was
 * MATERIALISED by a search, though, not the time its stems finished — "when this entered the catalog", which is what a
 * guest means by recently added. Sorted explicitly rather than trusting the incoming order, even though
 * `listReady()` already applies `orderBy(desc(media.id))`: relying on that would make this page's order an undocumented
 * side effect of a server query someone could reasonably re-order.
 */
export function sortLibrary(rows: Media[], sort: LibrarySort): Media[] {
	const out = [...rows];
	if (sort === 'newest') return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
	if (sort === 'title') return out.sort((a, b) => COLLATOR.compare(foldForMatch(a.title), foldForMatch(b.title)));
	// Artist, with the unattributed rows LAST rather than sorted under an empty string, which would park them first —
	// a block of nameless rows above the As reads as a rendering fault. Ties fall back to title, never to input order.
	return out.sort((a, b) => {
		const [x, y] = [libraryArtist(a), libraryArtist(b)];
		if (!x !== !y) return x ? -1 : 1;
		const byArtist = COLLATOR.compare(foldForMatch(x ?? ''), foldForMatch(y ?? ''));
		return byArtist !== 0 ? byArtist : COLLATOR.compare(foldForMatch(a.title), foldForMatch(b.title));
	});
}

/**
 * The rows the page shows: facet first, then the text filter, then the sort. `artist` wins if both facets are somehow
 * set, matching /api/library's own precedence, so the two can never silently intersect into an empty page.
 */
export function browseLibrary(input: {
	library: Media[];
	tags: Record<string, string[]>;
	query?: string;
	facet?: LibraryFacet;
	sort?: LibrarySort;
}): Media[] {
	const { library, tags, query = '', facet, sort = 'title' } = input;
	const artist = facet?.artist?.trim() || null;
	const tag = artist ? null : facet?.tag?.trim() || null;

	let rows = library;
	if (artist) rows = rows.filter((m) => libraryArtist(m) === artist);
	else if (tag) rows = rows.filter((m) => (tags[m.id] ?? []).includes(tag));

	const terms = queryTerms(query);
	if (terms.length) rows = rows.filter((m) => matchesQuery(haystackFor(m, tags[m.id]), terms));

	return sortLibrary(rows, sort);
}

/** The host's two clean-up sorts in Manage, over GET /api/library/sizes. */
export type ManageSort = 'biggest' | 'least-sung';

/** Ties fall back to title, so the order never depends on what the server returned first. */
export function sortManaged(rows: Media[], sort: ManageSort, songs: LibrarySizes['songs']): Media[] {
	const key = (m: Media) => (sort === 'biggest' ? -(songs[m.id]?.bytes ?? 0) : (songs[m.id]?.plays ?? 0));
	return [...rows].sort((a, b) => key(a) - key(b) || COLLATOR.compare(foldForMatch(a.title), foldForMatch(b.title)));
}

/** "96 MB" under a gigabyte, "12.4 GB" from there, decimal like the cap. */
export function formatBytes(bytes: number): string {
	if (bytes < 1e9) return `${bytes > 0 ? Math.max(1, Math.round(bytes / 1e6)) : 0} MB`;
	return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** Count descending then name ascending, so the chips lead with the artists you actually have most of. */
function rank<T extends { count: number }>(rows: T[], name: (r: T) => string): T[] {
	return rows.sort((a, b) => b.count - a.count || COLLATOR.compare(name(a), name(b)));
}

/**
 * BOTH facet builders take the WHOLE ready library and never the filtered rows — the rule /api/library states for its
 * own `facets`, because facets derived from the current filter collapse to the one value you picked and strand you
 * there with no way back.
 *
 * Only `artistCanonical` counts, as on the server: `artist` is the uploader a source reported, so a YouTube channel
 * name would appear here as an artist. A row with no confident artist simply has no chip.
 */
export function artistFacetsOf(library: Media[]): Array<{ artist: string; count: number }> {
	const counts = new Map<string, number>();
	for (const m of library) {
		const a = m.artistCanonical;
		if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
	}
	return rank(
		[...counts].map(([artist, count]) => ({ artist, count })),
		(r) => r.artist
	);
}

export function tagFacetsOf(library: Media[], tags: Record<string, string[]>): Array<{ tag: string; count: number }> {
	const counts = new Map<string, number>();
	for (const m of library) {
		// De-duplicated per song, so a row tagged the same thing twice cannot inflate a count past the list it opens.
		for (const t of new Set(tags[m.id] ?? [])) counts.set(t, (counts.get(t) ?? 0) + 1);
	}
	return rank(
		[...counts].map(([tag, count]) => ({ tag, count })),
		(r) => r.tag
	);
}
