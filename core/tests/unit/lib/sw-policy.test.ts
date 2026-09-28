// PIN: the service worker never touches a stream, and never caches something `cache.put` would reject.
//
// THE DEFECT THESE PIN was invisible to every test in the tree, because the whole fetch handler lives in a
// module importing `$service-worker` (a build-only virtual module). The catch-all treated a streaming
// instrumental like a document: `res.clone()` teed the body in the television's memory, `cache.put`
// rejected UNHANDLED on the 206 that `media/[...path]` returns by design, and a full 200 was written whole
// to the SD card beside the app shell.
import { test, expect } from 'bun:test';
import { isCacheable, isPassThrough, isStream, type RequestFacts } from '$lib/sw-policy';

const req = (over: Partial<RequestFacts> = {}): RequestFacts => ({
	method: 'GET',
	pathname: '/',
	destination: '',
	hasRange: false,
	...over
});

// ── pass-through ─────────────────────────────────────────────────────────────────────────────────

test('the socket and the API are never intercepted', () => {
	expect(isPassThrough(req({ pathname: '/ws' }))).toBe(true);
	expect(isPassThrough(req({ pathname: '/api/search' }))).toBe(true);
	expect(isPassThrough(req({ pathname: '/' }))).toBe(false);
	expect(isPassThrough(req({ pathname: '/tv' }))).toBe(false);
});

test('a mutation is never intercepted whatever its path', () => {
	// A queue add is a POST. Serving one from a cache is not a degraded answer, it is a wrong one.
	expect(isPassThrough(req({ method: 'POST', pathname: '/' }))).toBe(true);
	expect(isPassThrough(req({ method: 'DELETE', pathname: '/media/x.flac' }))).toBe(true);
});

// ── streams ──────────────────────────────────────────────────────────────────────────────────────

test("THE BUG: the television's audio and video are streams, not documents", () => {
	// `TvPlayer` sets these as an element src, so the destination is the element's own.
	expect(isStream(req({ pathname: '/media/abc/instrumental.flac', destination: 'audio' }))).toBe(true);
	expect(isStream(req({ pathname: '/media/abc/backing.mp4', destination: 'video' }))).toBe(true);
});

test('a range-bearing request is a stream whatever its destination', () => {
	// WebKit probes a media resource with `Range: bytes=0-1` and abandons it silently on a 200, which is
	// why the server implements real range support — so these arrive constantly, and a 206 cannot be cached.
	expect(isStream(req({ pathname: '/media/abc/instrumental.flac', hasRange: true }))).toBe(true);
	expect(isStream(req({ pathname: '/anything', destination: '', hasRange: true }))).toBe(true);
});

test('THE SAME PREFIX still caches the lyrics document, which is why this is not a path rule', () => {
	// `LyricsOverlay` fetches `/media/<lyricsRef>` — small JSON, destination '' — and a path-based skip on
	// `/media` would have thrown away the one thing under it worth keeping for an offline reload.
	const lyrics = req({ pathname: '/media/abc/lyrics.json', destination: '' });
	expect(isStream(lyrics)).toBe(false);
	expect(isPassThrough(lyrics)).toBe(false);
});

test('ordinary documents and assets are not streams', () => {
	for (const d of ['document', 'script', 'style', 'image', 'font', '']) {
		expect(isStream(req({ destination: d }))).toBe(false);
	}
});

// ── cacheability ─────────────────────────────────────────────────────────────────────────────────

test('only a complete success is cached', () => {
	expect(isCacheable({ ok: true, status: 200 })).toBe(true);
});

test('a 206 is NOT cached — `cache.put` rejects on one, and that rejection was unhandled', () => {
	// `ok` is true for a 206, so an `res.ok` test alone was not enough and is what let this through.
	expect(isCacheable({ ok: true, status: 206 })).toBe(false);
});

test('an error response is not cached, or it would be served back as though it were the page', () => {
	expect(isCacheable({ ok: false, status: 404 })).toBe(false);
	expect(isCacheable({ ok: false, status: 500 })).toBe(false);
	expect(isCacheable({ ok: false, status: 0 })).toBe(false); // opaque cross-origin
});
