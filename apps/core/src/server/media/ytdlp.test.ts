// Done-when: resolve memoizes; cache hit on repeat id. Plus parser + graceful degrade.
import { test, expect } from 'bun:test';
import { parseSearchJson, cacheMeta, getCachedMeta, ytDlpSearch, ytThumbnailUrl } from './ytdlp';

test('parseSearchJson parses one-json-object-per-line into SearchResults', () => {
	const lines = [
		JSON.stringify({ id: 'abc', title: 'Mr. Brightside', uploader: 'The Killers', duration: 222.6, view_count: 12345 }),
		JSON.stringify({ id: 'def', title: 'Dancing Queen', channel: 'ABBA', duration: 231 }),
		'', // blank line skipped
		'{ not json' // malformed skipped
	].join('\n');
	const r = parseSearchJson(lines);
	expect(r).toHaveLength(2);
	expect(r[0]).toEqual({
		source: 'youtube',
		sourceRef: 'abc',
		title: 'Mr. Brightside',
		artist: 'The Killers',
		durationSec: 223,
		thumbnail: 'https://i.ytimg.com/vi/abc/mqdefault.jpg',
		viewCount: 12345
	});
	expect(r[1]!.artist).toBe('ABBA');
	expect(r[1]!.durationSec).toBe(231);
	// no view_count in the payload → undefined, NOT 0. The row omits the chip rather than claiming zero.
	expect(r[1]!.viewCount).toBeUndefined();
});

/*
 * The thumbnail is DERIVED from the id and deliberately ignores what yt-dlp reported. This test pins
 * that decision because it looks like discarding data: `thumbnails[].at(-1)` is inconsistent in aspect
 * (measured: `hq720.jpg` 16:9 from a ytsearch3, letterboxed 4:3 `hqdefault.jpg` from a ytsearch1 for
 * the same video), oversized for an 84px slot, and signed with `?sqp=…&rs=…` — which the proxy's
 * URL-keyed disk cache would store as a separate file per signature. See ytThumbnailUrl.
 */
test('thumbnail is derived from the video id, ignoring the reported URLs', () => {
	const line = JSON.stringify({
		id: 'x',
		title: 'X',
		thumbnail: 'https://i.ytimg.com/vi/x/hqdefault.jpg?sqp=SIGNED',
		thumbnails: [{ url: 'low' }, { url: 'high' }]
	});
	expect(parseSearchJson(line)[0]!.thumbnail).toBe('https://i.ytimg.com/vi/x/mqdefault.jpg');
});

test('a result with no reported thumbnail still gets one', () => {
	const line = JSON.stringify({ id: 'noThumb', title: 'X' });
	expect(parseSearchJson(line)[0]!.thumbnail).toBe('https://i.ytimg.com/vi/noThumb/mqdefault.jpg');
});

test('ytThumbnailUrl escapes the id, so it cannot smuggle a path or a query', () => {
	expect(ytThumbnailUrl('../../etc/passwd')).toBe('https://i.ytimg.com/vi/..%2F..%2Fetc%2Fpasswd/mqdefault.jpg');
	expect(ytThumbnailUrl('a&b=c')).toBe('https://i.ytimg.com/vi/a%26b%3Dc/mqdefault.jpg');
});

test('a non-numeric view_count is dropped rather than rendered as NaN', () => {
	const line = JSON.stringify({ id: 'y', title: 'Y', view_count: 'lots' });
	expect(parseSearchJson(line)[0]!.viewCount).toBeUndefined();
});

test('objects without id are skipped', () => {
	expect(parseSearchJson(JSON.stringify({ title: 'no id' }))).toEqual([]);
});

test('per-id metadata cache memoizes', () => {
	const r = { source: 'youtube' as const, sourceRef: 'vid123', title: 'Song', durationSec: 100 };
	expect(getCachedMeta('vid123')).toBeUndefined();
	cacheMeta(r);
	expect(getCachedMeta('vid123')).toEqual(r);
});

test('GRACEFUL DEGRADE: search returns [] when yt-dlp is unavailable (no throw)', async () => {
	// in this dev env yt-dlp is not installed; the call must resolve to [] not reject
	const r = await ytDlpSearch('anything', 5);
	expect(Array.isArray(r)).toBe(true); // [] in dev; live results where yt-dlp exists
});
