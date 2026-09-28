/*
 * THE LIBRARY PAGE'S LOGIC, out of the route so it is testable without a DOM. See docs/FRONTEND.md#the-library-page.
 *
 * WHAT "YOUR LIBRARY" IS: the READY catalog — `MediaRepository.listReady()`, served by /api/library and mirrored whole
 * in `room.library`. It is NOT the `local` resolver, which searches audio FILES in the media directory: a processed
 * YouTube song is in the library and absent from that list, so `/api/search?source=local` answers a different question
 * and must not back this page.
 *
 * FILTERING IS CLIENT-SIDE, DELIBERATELY. The whole ready list is already in memory — the home column renders every
 * row of it — so narrowing costs no request. That is also the one thing keeping this field distinguishable from the
 * home column's: home's search FETCHES from three resolvers and needs a spinner, this one only hides rows and is
 * instant. Two fields that look alike and do opposite things would be worse than the reachability problem this page
 * fixes, so the difference has to be felt, not just labelled.
 */
import type { Media } from '$lib/contract';

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
 * Rows the HOME column shows under `Your library`. It is a shelf, not the library: the whole list used to render
 * there, under an unbounded queue, so a busy rotation put the songs you own metres down the scroll.
 *
 * FOUR, measured rather than chosen: a row is ~72px, so four plus the heading is ~320px, which still leaves the next
 * group's heading above the fold on an 844px phone once the topbar, the field and one queue row are spent. Five pushes
 * it under. They are the newest four because `room.library` arrives `orderBy(desc(media.id))` and a media id is a
 * time-sortable ULID — the song you just made is overwhelmingly the one you want a tap away.
 *
 * Lives here rather than inline in the route because the e2e fixture seeds exactly four demo tracks, so the cap can
 * never truncate under test; this keeps the number and its gate provable in the unit suite instead of unexercised.
 */
export const LIBRARY_SHELF = 4;

/** `hidden` is what the `See all` door announces, and 0 is what hides the door entirely — with three songs there is
 *  nothing behind it, and a control promising more than it has is worse than no control. */
export function libraryShelf<T>(rows: T[]): { shown: T[]; hidden: number } {
	return { shown: rows.slice(0, LIBRARY_SHELF), hidden: Math.max(0, rows.length - LIBRARY_SHELF) };
}

/**
 * Rows `/library` renders per reveal. NOT a cap — `/library` IS the `See all` the shelf's door leads to, so a row it
 * refuses to show is a song you own with nowhere left to reach it. The window GROWS by this much per tap instead.
 *
 * SIXTY, measured rather than chosen, on a 390x844 phone at a 4x CPU throttle with 2000 ready songs: the whole list
 * took 4.6s and 40,125 DOM nodes before the first row was usable, and the backspace that widened the filter again
 * blocked the main thread for 3.4s. One page of sixty is 1,328 nodes and 0.9s. Sixty rows is also ~4300px — five
 * screens of scrolling to reach the control, so the reveal is not friction anyone meets on a party-sized library.
 */
export const LIBRARY_PAGE = 60;

/** The window and what is still behind the reveal control, in `libraryShelf`'s shape and here for the same reason:
 *  the arithmetic stays provable in the unit suite. The clamp is what keeps a negative `revealed` from making `slice`
 *  count from the END and silently drop the top of the list. */
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
export function matchesQuery(haystack: string, terms: string[]): boolean {
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
