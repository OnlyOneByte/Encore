// The fetcher axis: WHERE a song's audio comes from, declared rather than inferred.
//
// The bug this whole module exists to kill: acquisition used to be recovered from a URI's shape on
// both sides of the wire — the core emitted a watch URL or a bare file key, the worker tested for an
// `http(s)` prefix. Any other scheme was classified as a local path and died several stages later
// inside ffmpeg. These tests pin the declaration, not the shape.
import { test, expect } from 'bun:test';
import {
	FETCHERS,
	DEFAULT_FETCHER,
	getFetcher,
	isValidFetcher,
	fetcherFor,
	needsFetch,
	sourceUriFor
} from '$shared';
import { normalizeGlobalSettings, DEFAULT_GLOBAL_SETTINGS } from '$shared';

test('every fetcher carries a label, and only real downloaders carry a capability', () => {
	for (const f of FETCHERS) {
		expect(f.label.length).toBeGreaterThan(0);
		expect(f.note.length).toBeGreaterThan(0);
	}
	// `local` is not a downloader — there is nothing to route to a worker, so it has no capability.
	expect(getFetcher('local')!.capability).toBeNull();
	expect(getFetcher('ytdlp')!.capability).toBe('fetch:ytdlp');
});

test('a capability is namespaced so it cannot collide with a separator capability', () => {
	// `stems`/`stems:roformer` and `fetch:ytdlp` are different axes; a worker advertising one must not
	// accidentally satisfy the other.
	for (const f of FETCHERS) {
		if (f.capability) expect(f.capability.startsWith('fetch:')).toBe(true);
	}
});

test('an unknown fetcher is not valid', () => {
	expect(isValidFetcher('ytdlp')).toBe(true);
	expect(isValidFetcher('librespot')).toBe(false); // not implemented yet — must not validate
});

test('a local media is `local` regardless of the configured default', () => {
	// Its bytes are already on the volume, so no downloader is involved and none can be substituted.
	expect(fetcherFor('local', 'ytdlp')).toBe('local');
	expect(needsFetch('local')).toBe(false);
	// everything else acquires via the deployment's default
	expect(fetcherFor('youtube', 'ytdlp')).toBe('ytdlp');
	expect(needsFetch('youtube')).toBe(true);
});

test('a garbage or `local` default degrades to the real default instead of disabling downloads', () => {
	expect(fetcherFor('youtube', 'nonsense')).toBe(DEFAULT_FETCHER);
	// accepting `local` as the DEFAULT would mean "never download anything, ever"
	expect(fetcherFor('youtube', 'local')).toBe(DEFAULT_FETCHER);
	expect(normalizeGlobalSettings({ defaultFetcher: 'local' as never }).defaultFetcher).toBe(DEFAULT_FETCHER);
	expect(normalizeGlobalSettings({ defaultFetcher: 'nope' as never }).defaultFetcher).toBe(DEFAULT_FETCHER);
	expect(normalizeGlobalSettings(null).defaultFetcher).toBe(DEFAULT_GLOBAL_SETTINGS.defaultFetcher);
});

test('sourceUriFor replaces the core-side source conditional', () => {
	// This is the exact behaviour the deleted `sourceUri()` had, now derived from the registry so a
	// third fetcher does not need another branch in worker-hub.
	expect(sourceUriFor({ source: 'youtube', sourceRef: 'djV11Xbc914' })).toBe(
		'https://www.youtube.com/watch?v=djV11Xbc914'
	);
	expect(sourceUriFor({ source: 'local', sourceRef: 'library/sweet-caroline.mp4' })).toBe('library/sweet-caroline.mp4');
});

test('spotify is a SEARCH-only source: no fetch:spotify capability, and fetcherFor never yields it', () => {
	// The librespot ACQUISITION half stays parked — there is deliberately no spotify
	// fetcher, so its bytes are never pulled. A spotify-sourced media falls back to the default
	// downloader here as a defensive floor, but in practice a spotify result is never queued.
	expect(FETCHERS.some((f) => f.capability === 'fetch:spotify')).toBe(false);
	expect(getFetcher('spotify')).toBeUndefined();
	// Crucially, fetcherFor('spotify') must NOT invent a spotify fetcher — it resolves to the default.
	expect(fetcherFor('spotify')).toBe(DEFAULT_FETCHER);
});
