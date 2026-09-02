// Readiness — the axis the search UI is organised around. Users do not care which source a song
// came from; they care whether they can sing it right now without vocals. So a search returns ONE
// deduped set of songs partitioned by readiness, not one list per source.
//
// Pure: no DB, no network, no clock. The route supplies the catalog + resolver results.

import type { Media } from '@encore/shared';

/** Where a song sits on the readiness axis. */
export type Readiness =
	| 'ready' // stems separated and on disk — queue it and sing with no vocals, no wait
	| 'cooking' // a stems job is in flight; rotation HOLDS its slot, so it is still queueable
	| 'raw'; // playable as-is, but with the original vocals (youtube embed / plain local file)

export function readinessOf(m: Media): Readiness {
	if (m.playMode === 'file' && m.stemStatus === 'ready') return 'ready';
	if (m.playMode === 'file' && m.stemStatus === 'queued') return 'cooking';
	return 'raw';
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
	raw: Media[];
}

/**
 * Merge the durable catalog with fresh resolver results into one deduped, readiness-partitioned set.
 *
 * Catalog entries are considered FIRST so a song we already cooked is never missed just because the
 * resolver ranked it low, titled it differently, or is unreachable (yt-dlp down / no network). Then
 * resolver results fill in everything new. Dedupe is by media id, which is exact: the route
 * materializes a result onto the EXISTING catalog media when it recognises the song by origin
 * identity (`source` + `sourceRef`), so the same song cannot appear in two groups.
 *
 * Raw results keep the resolver's relevance order, with catalog-only raw songs after them.
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
		raw: all.filter((m) => readinessOf(m) === 'raw').sort((a, b) => rank(a) - rank(b))
	};
}
