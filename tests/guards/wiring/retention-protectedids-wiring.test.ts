// `planEviction`'s protectedIds parameter is only real once app.ts WIRES it. Caught: the only production
// caller passed two arguments, so the default `new Set()` protected nothing, and since `hydrate()` restores
// the queue and playback BEFORE the pass, a restart mid-party with a media cap set could evict the playing
// or queued song. `getApp()` stands the whole app up inside an async `.then` with no unit harness.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

const APP = stripComments(read('src/lib/server/app.ts'));

test('app.ts passes a third protectedIds argument to planEviction', () => {
	expect(APP).toMatch(/planEviction\(\s*candidates\s*,\s*cap\s*,\s*protectedIds\s*\)/);
});

test('app.ts builds protectedIds from the hydrated queue plus the currently-playing media', () => {
	// Window-scoped so a match cannot come from unrelated code. The set must be every QUEUED media id
	// plus the PLAYING entry's, resolved through playback.currentEntryId — either half alone leaves a
	// live song evictable.
	const start = APP.indexOf('const protectedIds');
	expect(start).toBeGreaterThanOrEqual(0);
	const window = APP.slice(start, start + 500);
	expect(window).toMatch(
		/const\s+protectedIds\s*=\s*new\s+Set<string>\(\s*entries\.map\(\s*\(e\)\s*=>\s*e\.mediaId\s*\)\s*\)/
	);
	expect(window).toMatch(/entries\.find\(\s*\(e\)\s*=>\s*e\.id\s*===\s*playback\.currentEntryId\s*\)\?\.mediaId/);
	expect(window).toMatch(/protectedIds\.add\(\s*currentMediaId\s*\)/);
	// The set is what actually feeds planEviction, backstopping the isolated first arm.
	expect(window).toMatch(/planEviction\([^)]*protectedIds\s*\)/);
});

test('app.ts imports clearArtifacts and calls it in the eviction loop so eviction STICKS', () => {
	// `sidecarFromMedia ?? prev` resurrects an evicted song unless the authoritative record is nulled
	// directly, and `clearArtifacts` is that null.
	expect(APP).toMatch(/import\s*\{[^}]*\bclearArtifacts\b[^}]*\}\s*from\s*'\.\/media\/sidecar'/);
	const start = APP.indexOf('const doomed');
	expect(start).toBeGreaterThanOrEqual(0);
	const loop = APP.slice(start, start + 1000);
	// ALL derived refs go, including the vocals stem and the lyrics candidates.
	expect(loop).toMatch(/live\.vocalsRef\s*=\s*undefined/);
	expect(loop).toMatch(/live\.lyricsCandidates\s*=\s*\[\]/);
	expect(loop).toMatch(/await\s+clearArtifacts\(\s*id\s*\)/);
	// ORDERING: clearArtifacts must run AFTER the upsert, whose sink would otherwise restore the refs.
	const upsertIdx = loop.indexOf('mediaRepo.upsert(live)');
	const clearIdx = loop.indexOf('clearArtifacts(id)');
	expect(upsertIdx).toBeGreaterThanOrEqual(0);
	expect(clearIdx).toBeGreaterThan(upsertIdx);
});
