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
}

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

	return {
		ready: all.filter((m) => readinessOf(m) === 'ready'),
		processing: all.filter((m) => readinessOf(m) === 'processing'),
		unacquired: all.filter((m) => readinessOf(m) === 'unacquired').sort((a, b) => rank(a) - rank(b))
	};
}
