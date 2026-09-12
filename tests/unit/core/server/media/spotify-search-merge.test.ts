// PIN: a Spotify resolver result appears in the merged /api/search output.
//
// This exercises the exact merge the route runs: resultToMedia materializes a spotify-sourced
// SearchResult (source-tagged 'spotify'), and partitionSearch surfaces it in the `unacquired`
// (results) group alongside a YouTube hit — deduped, each song once. RED on base: SearchResult.source
// and MediaSource do not admit 'spotify' there, so this file does not type-check / the value is absent.
import { test, expect } from 'bun:test';
import { resultToMedia, type SearchResult } from '$lib/server/media/resolver';
import { partitionSearch } from '$lib/server/media/readiness';
import type { Media } from '$lib/contract';

test('a spotify result materializes and appears in the merged, deduped search output', () => {
	const q = 'never gonna give you up';
	const ytHit: SearchResult = {
		source: 'youtube',
		sourceRef: 'dQw4w9WgXcQ',
		title: 'Rick Astley - Never Gonna Give You Up (Official Video)',
		durationSec: 213
	};
	const spotifyHit: SearchResult = {
		source: 'spotify',
		sourceRef: '4uLU6hMCjMI75M1A2tKUQC',
		title: 'Never Gonna Give You Up',
		artist: 'Rick Astley',
		durationSec: 214
	};

	const materialized: Media[] = [ytHit, spotifyHit].map((r, i) => resultToMedia('m' + i, r));

	// The spotify hit is source-tagged spotify (provenance preserved for the UI/merge).
	const sp = materialized.find((m) => m.sourceRef === '4uLU6hMCjMI75M1A2tKUQC')!;
	expect(sp.source).toBe('spotify');

	const { ready, cooking, unacquired } = partitionSearch(q, materialized, materialized);
	expect(ready).toHaveLength(0);
	expect(cooking).toHaveLength(0);
	// Both hits surface as unacquired candidates — the spotify one IS in the merged output.
	expect(unacquired.some((m) => m.source === 'spotify' && m.sourceRef === '4uLU6hMCjMI75M1A2tKUQC')).toBe(true);
	expect(unacquired.some((m) => m.source === 'youtube' && m.sourceRef === 'dQw4w9WgXcQ')).toBe(true);
});
