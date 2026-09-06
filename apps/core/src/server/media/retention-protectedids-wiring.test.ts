// guard: planEviction's protectedIds parameter is only real once app.ts WIRES it. #442 §2.
//
// planEviction(candidates, cap, protectedIds) enforces "never strip a cook out from under a live or
// queued entry" HERE, in the pure function — retention.test.ts covers the parameter. But the ONLY
// production caller, app.ts's boot maintenance pass, passed just two arguments, so the default
// `new Set()` protected nothing: hydrate() restores the queue and playback BEFORE the pass, so a
// restart mid-party with ENCORE_MEDIA_MAX_GB set could evict the playing or queued song. getApp()
// stands up the whole app inside an async .then and has no unit harness (readSidecar, ffmpeg, DB),
// so a behavioural test cannot reach this branch — the wiring is pinned by source scan, the same
// class of "built but not wired" defect this guard family exists to catch.
//
// Comments are blanked so a commented-out wiring cannot satisfy any match.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// import.meta.dir === apps/core/src/server/media → one level up to app.ts.
const APP = stripComments(readFileSync(join(import.meta.dir, '..', 'app.ts'), 'utf8'));

test('app.ts passes a third protectedIds argument to planEviction (#442 §2)', () => {
	// The two-argument call `planEviction(candidates, cap)` defaults protectedIds to an empty Set —
	// the exact unwired state this closes. Require a THIRD argument to the call.
	expect(APP).toMatch(/planEviction\(\s*candidates\s*,\s*cap\s*,\s*protectedIds\s*\)/);
});

test('app.ts builds protectedIds from the hydrated queue plus the currently-playing media (#442 §2)', () => {
	// Isolate the eviction branch so a match cannot be satisfied by unrelated code, then pin that the
	// protected set is the queued media ids plus the playing entry's media id.
	const start = APP.indexOf('const protectedIds');
	expect(start).toBeGreaterThanOrEqual(0);
	const window = APP.slice(start, start + 500);
	// Every queued entry's media id.
	expect(window).toMatch(/const\s+protectedIds\s*=\s*new\s+Set<string>\(\s*entries\.map\(\s*\(e\)\s*=>\s*e\.mediaId\s*\)\s*\)/);
	// The currently-playing entry's media id, resolved from playback.currentEntryId, added to the set.
	expect(window).toMatch(/entries\.find\(\s*\(e\)\s*=>\s*e\.id\s*===\s*playback\.currentEntryId\s*\)\?\.mediaId/);
	expect(window).toMatch(/protectedIds\.add\(\s*currentMediaId\s*\)/);
	// And the set is what feeds planEviction (backstops the isolated first test).
	expect(window).toMatch(/planEviction\([^)]*protectedIds\s*\)/);
});

test('app.ts imports clearArtifacts and calls it in the eviction loop so eviction STICKS (#442 §1)', () => {
	// The sidecar restore bug (sidecarFromMedia `?? prev`) resurrects an evicted song unless the
	// authoritative record is nulled directly. clearArtifacts is that null; app.ts must import it and
	// call it per evicted id. Reverting the call (or the import) would otherwise only break the build,
	// not red a named test, because the eviction loop lives in getApp()'s un-harnessed boot pass.
	expect(APP).toMatch(/import\s*\{[^}]*\bclearArtifacts\b[^}]*\}\s*from\s*'\.\/media\/sidecar'/);
	const start = APP.indexOf('const doomed');
	expect(start).toBeGreaterThanOrEqual(0);
	const loop = APP.slice(start, start + 1000);
	// The runtime Media is stripped of ALL derived refs (evictDerived deletes the vocals stem too, and
	// the lyrics candidates), then upserted, then the authoritative record is nulled.
	expect(loop).toMatch(/live\.vocalsRef\s*=\s*undefined/);
	expect(loop).toMatch(/live\.lyricsCandidates\s*=\s*\[\]/);
	expect(loop).toMatch(/await\s+clearArtifacts\(\s*id\s*\)/);
	// Ordering: clearArtifacts must run AFTER the upsert whose sink would otherwise restore the refs.
	const upsertIdx = loop.indexOf('mediaRepo.upsert(live)');
	const clearIdx = loop.indexOf('clearArtifacts(id)');
	expect(upsertIdx).toBeGreaterThanOrEqual(0);
	expect(clearIdx).toBeGreaterThan(upsertIdx);
});
