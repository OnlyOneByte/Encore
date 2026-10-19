// Readiness — the axis the search UI is organised around. Users do not care which source a song
// came from; they care whether they can sing it right now without vocals. So a search returns ONE
// deduped set of songs partitioned by readiness, not one list per source.
//  Pure: no DB, no network, no clock. The route supplies the catalog + resolver results.

import { type Media } from '../../contract';

// `readinessOf` lives in the contract so client and server share one classification; re-exported
// here so callers reaching for `media/readiness` keep one import.
import { readinessOf } from '../../contract/process/readiness';

export { readinessOf };

/** Case-insensitive substring match over the fields a human would search by. */
export function matchesQuery(m: Media, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return false;
	return m.title.toLowerCase().includes(q) || (m.artist ?? '').toLowerCase().includes(q);
}

export interface SearchPartition {
	ready: Media[];
	processing: Media[];
	unacquired: Media[];
	/** True when any group was cut by the cap, so a caller can say "there are more" honestly. */
	clipped: boolean;
}

/* THE PER-GROUP CAP, and the reason it belongs here rather than at the route. Every resolver was already
   capped — `PER_SOURCE_LIMIT` is 12, and `LocalLibrary.search` honours its `limit` in SQL — so the uncapped
   path was never a SEARCH, it was this partition: the route hands it `[...app.mediaById.values()]`, the whole
   durable catalog, and `matchesQuery` keeps every row that matches. Measured on the owner's copy: one query
   returned 3,284 rows, which the phone rendered as 54,000 DOM nodes and 914ms before a tap registered.
   SIXTY, to match what the phone actually draws. `LIBRARY_PAGE` in `$lib/library-browse` is 60 and the Sing
   tab reveals in pages of that size, so a 61st row could not be seen without a tap anyway — sending 3,284 of
   them was work nobody could use. The two constants are deliberately NOT shared: this one is a server wire
   bound and that one is a client paint bound, and tying them would make a client paint change a protocol
   change. If they drift, the cost is a reveal door that stops one page early, which is why the client's door
   is driven by what it received rather than by a count it was told. */
export const SEARCH_GROUP_LIMIT = 60;

/**
 * Merge the durable catalog with fresh resolver results into one deduped, readiness-partitioned
 * set. Catalog entries come FIRST so an already-processed song is never missed because the resolver
 * ranked it low or is unreachable. Dedupe is by media id (exact, via origin identity), so one song
 * can't appear in two groups; raw results keep the resolver's relevance order, catalog-only after.
 */
export function partitionSearch(query: string, catalog: Media[], results: Media[]): SearchPartition {
	const byId = new Map<string, Media>();
	for (const m of catalog) if (matchesQuery(m, query)) byId.set(m.id, m);
	for (const m of results) if (!byId.has(m.id)) byId.set(m.id, m);

	const all = [...byId.values()];
	const resultRank = new Map(results.map((m, i) => [m.id, i]));
	const rank = (m: Media) => resultRank.get(m.id) ?? Number.MAX_SAFE_INTEGER;

	const ready = all.filter((m) => readinessOf(m) === 'ready');
	const processing = all.filter((m) => readinessOf(m) === 'processing');
	const unacquired = all.filter((m) => readinessOf(m) === 'unacquired').sort((a, b) => rank(a) - rank(b));

	/* CAPPED AFTER THE SORT, never before: `unacquired` carries the resolver's relevance order, so slicing a
	   pre-sort list would keep an arbitrary 60 rather than the best 60. `ready` and `processing` have no
	   relevance order to preserve — they are catalog scans — so for them the slice is simply the first 60
	   matches, which is what the phone would have painted. */
	return {
		ready: ready.slice(0, SEARCH_GROUP_LIMIT),
		processing: processing.slice(0, SEARCH_GROUP_LIMIT),
		unacquired: unacquired.slice(0, SEARCH_GROUP_LIMIT),
		clipped:
			ready.length > SEARCH_GROUP_LIMIT ||
			processing.length > SEARCH_GROUP_LIMIT ||
			unacquired.length > SEARCH_GROUP_LIMIT
	};
}
