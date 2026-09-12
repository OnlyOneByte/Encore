// Readiness — the axis the search UI is organised around. Users do not care which source a song
// came from; they care whether they can sing it right now without vocals. So a search returns ONE
// deduped set of songs partitioned by readiness, not one list per source.
//
// Pure: no DB, no network, no clock. The route supplies the catalog + resolver results.

import { isCooking, readyToSing, type Media } from '$shared';

/** Where a song sits on the readiness axis. */
export type Readiness =
	| 'ready' // stems separated and on disk — queue it and sing with no vocals, no wait
	| 'cooking' // a stems job is in flight; rotation HOLDS its slot, so it is still queueable
	| 'unacquired'; // no instrumental yet, so nothing to play — a candidate to cook, not a song to sing

export function readinessOf(m: Media): Readiness {
	// Gate-driven, and this FUNCTION must agree with the client's copy (apps/core/src/lib/readiness.ts)
	// for every catalog media — asserted by the parity test there. The client's Readiness union carries
	// one extra member, 'failed', which is deliberately absent here: nothing in the catalog records a
	// failure (a dead cook settles back to un-cooked via settleStemsGate), so 'failed' arrives only from
	// a live media:status event and lives in the client's displayReadiness. Adding it here would create
	// a value this function can never return.
	// `isCooking` reads the cook gates rather than a single `stemStatus === 'queued'` check, so a song
	// mid-align (stems ready, lyrics queued) reads as cooking instead of falling through to unacquired.
	if (readyToSing(m)) return 'ready';
	if (isCooking(m)) return 'cooking';
	return 'unacquired';
}

/** Case-insensitive substring match over the fields a human would search by. */
export function matchesQuery(m: Media, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return false;
	return m.title.toLowerCase().includes(q) || (m.artist ?? '').toLowerCase().includes(q);
}

export interface SearchPartition {
	ready: Media[];
	cooking: Media[];
	unacquired: Media[];
}

/**
 * Merge the durable catalog with fresh resolver results into one deduped, readiness-partitioned set.
 *
 * Catalog entries come FIRST so a song we already cooked is never missed because the resolver ranked
 * it low, titled it differently, or is unreachable (yt-dlp down). Resolver results fill in the rest.
 * Dedupe is by media id, which is exact: the route materializes a result onto the EXISTING catalog
 * media when it recognises the song by origin identity (`source` + `sourceRef`), so one song can't
 * appear in two groups. Raw results keep the resolver's relevance order, catalog-only raw songs after.
 */
export function partitionSearch(query: string, catalog: Media[], results: Media[]): SearchPartition {
	const byId = new Map<string, Media>();
	for (const m of catalog) if (matchesQuery(m, query)) byId.set(m.id, m);
	for (const m of results) if (!byId.has(m.id)) byId.set(m.id, m);

	const all = [...byId.values()];
	const resultRank = new Map(results.map((m, i) => [m.id, i]));
	const rank = (m: Media) => resultRank.get(m.id) ?? Number.MAX_SAFE_INTEGER;

	return {
		ready: all.filter((m) => readinessOf(m) === 'ready'),
		cooking: all.filter((m) => readinessOf(m) === 'cooking'),
		unacquired: all.filter((m) => readinessOf(m) === 'unacquired').sort((a, b) => rank(a) - rank(b))
	};
}
