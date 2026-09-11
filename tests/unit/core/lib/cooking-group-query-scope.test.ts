// — a COOKING song must obey the search-match filter. The Cooking group used to be re-derived
// from the whole live status map and the whole catalog with no reference to the query, so a song
// someone else was cooking appeared under an UNRELATED search ("I want it that way" under "never
// gonna give you up"). The server already returns a query-scoped `cooking` group; the group's
// id-selection now lives in the pure `cookingGroupIds` helper, scoped to the query when searching.
import { test, expect } from 'bun:test';
import { cookingGroupIds, displayReadiness } from '$lib/readiness';
import type { Media, MediaStatus } from '@encore/shared';

const media = (id: string, over: Partial<Media> = {}): Media => ({
	id,
	source: 'youtube',
	sourceRef: `ref-${id}`,
	title: id,
	durationSec: 200,
	stemStatus: 'queued', // in flight → catalog classifies it as cooking
	...over
});

// The "I want it that way" trap: it is genuinely cooking (someone else kicked it off), so it lives
// in the live status map and the catalog — but it does NOT match the current query, so the server's
// query-matched cooking group (`cookingResults`) does not contain it.
const rickroll = media('rickroll', { title: 'Never Gonna Give You Up' });
const bsb = media('bsb', { title: 'I Want It That Way' });

const catalog = new Map<string, Media>([
	[rickroll.id, rickroll],
	[bsb.id, bsb]
]);
const status = new Map<string, { status: MediaStatus }>([
	[rickroll.id, { status: 'queued' }],
	[bsb.id, { status: 'queued' }]
]);

// The catalog classifier the page passes in (displayReadiness with the live status).
const readiness = (m: Media) => displayReadiness(m, status.get(m.id));

test('THE BUG: with a search active, a cooking song that does NOT match the query is absent', () => {
	// The wire returned ONLY the query-matching cooking song (rickroll); bsb was cooking but did not
	// match "never gonna give you up", so partitionSearch excluded it.
	const ids = cookingGroupIds({
		searchActive: true,
		cookingResults: [rickroll],
		mediaStatus: status,
		mediaCatalog: catalog,
		readiness
	});
	expect(ids.has('bsb')).toBe(false); // ← RED on base: the old union pulled bsb in from the catalog
	expect(ids.has('rickroll')).toBe(true); // the matching cook still shows — no over-correction
	expect(ids.size).toBe(1);
});

test("don't over-correct: a cooking song that DOES match the query is present", () => {
	const ids = cookingGroupIds({
		searchActive: true,
		cookingResults: [bsb], // now searching "that way" — the server matched bsb
		mediaStatus: status,
		mediaCatalog: catalog,
		readiness
	});
	expect(ids.has('bsb')).toBe(true);
	expect(ids.has('rickroll')).toBe(false);
});

test('empty query preserves the guaranteed-visible union of every in-flight cook', () => {
	// No search box → the escape-hatch requirement holds: a cook you started stays visible from both
	// the live status map and the catalog, regardless of `cookingResults`.
	const ids = cookingGroupIds({
		searchActive: false,
		cookingResults: [],
		mediaStatus: status,
		mediaCatalog: catalog,
		readiness
	});
	expect(ids.has('rickroll')).toBe(true);
	expect(ids.has('bsb')).toBe(true);
	expect(ids.size).toBe(2);
});

test('the union includes a failed cook and excludes ready/canceled', () => {
	const failed = media('failed', { stemStatus: 'none' });
	const ready = media('ready', { stemStatus: 'ready' });
	const canceled = media('canceled', { stemStatus: 'none' });
	const cat = new Map<string, Media>([
		[failed.id, failed],
		[ready.id, ready],
		[canceled.id, canceled]
	]);
	const st = new Map<string, { status: MediaStatus }>([
		[failed.id, { status: 'failed' }],
		[ready.id, { status: 'ready' }],
		[canceled.id, { status: 'canceled' }]
	]);
	const ids = cookingGroupIds({
		searchActive: false,
		cookingResults: [],
		mediaStatus: st,
		mediaCatalog: cat,
		readiness: (m) => displayReadiness(m, st.get(m.id))
	});
	expect(ids.has('failed')).toBe(true);
	expect(ids.has('ready')).toBe(false);
	expect(ids.has('canceled')).toBe(false);
});
