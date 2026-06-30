// M4-C3 done-when: resolve memoizes; cache hit on repeat id. Plus parser + graceful degrade.
import { test, expect } from 'bun:test';
import { parseSearchJson, cacheMeta, getCachedMeta, ytDlpSearch } from './ytdlp';

test('parseSearchJson parses one-json-object-per-line into SearchResults', () => {
	const lines = [
		JSON.stringify({ id: 'abc', title: 'Mr. Brightside', uploader: 'The Killers', duration: 222.6, thumbnail: 'http://t/1.jpg' }),
		JSON.stringify({ id: 'def', title: 'Dancing Queen', channel: 'ABBA', duration: 231 }),
		'', // blank line skipped
		'{ not json' // malformed skipped
	].join('\n');
	const r = parseSearchJson(lines);
	expect(r).toHaveLength(2);
	expect(r[0]).toEqual({ source: 'youtube', sourceRef: 'abc', title: 'Mr. Brightside', artist: 'The Killers', durationSec: 223, thumbnail: 'http://t/1.jpg' });
	expect(r[1]!.artist).toBe('ABBA');
	expect(r[1]!.durationSec).toBe(231);
});

test('thumbnail falls back to last of thumbnails[] when top-level absent', () => {
	const line = JSON.stringify({ id: 'x', title: 'X', thumbnails: [{ url: 'low' }, { url: 'high' }] });
	expect(parseSearchJson(line)[0]!.thumbnail).toBe('high');
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
