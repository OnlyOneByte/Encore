// guard: the failed-process scar is WIRED into the ROOM LINK on all three seams it needs.
//
// THE DEFECT. A failed process is a live-only signal — the catalog Media records no failure (a dead
// process settles back to un-processed via settleStemsGate), and the in-memory `mediaStatus` map that carries
// the live `failed` status is lost on reload. So a guest who reloads sees the song as plain un-processed,
// with no trace it broke. The fix persists a per-device scar (the owner's ruling over a server column
// or leaving it as-is). The scar STORE (process-scars.ts) is unit-tested directly; but the three lines
// that WIRE it into routes/+page.svelte — record on failure, clear on success, and re-surface on mount
// — live in a Svelte component that bun test never imports (Encore has no jsdom; every UI invariant is
// a source-scan guard). Without this guard, deleting any of the three wiring lines ships green: the
// store keeps its own tests while the feature is dead. This is the repo's most-repeated defect class.
//
// THE SUBJECT MOVED (the room-link hoist). All three seams used to live in routes/+page.svelte's
// onMount closure and ws handler. They now live in src/lib/stores/room.ts, because the socket and the
// room's truth are app-wide and a route cannot own them — see that file's header. The seams themselves
// are unchanged; only their address is. This guard followed them, which is the behaviour its last
// paragraph promised.
//
// WHY A SOURCE SCAN — AND WHY THAT IS NOW A WEAKER ANSWER THAN IT WAS. It was unanswerable before: the
// wiring sat inside a Svelte component's onMount, which bun test never runs (Encore has no jsdom). It is
// now inside a PLAIN CLASS with an injectable-free public surface, so most of this file could become a
// real behavioural test that drives RoomLink and asserts the scar store was written. That conversion is
// OWED WORK, deliberately not done in the hoist commit: doing it there would have mixed a refactor with
// a new test suite and made a regression in either one hard to attribute. Until then this scan holds the
// line — it is the same assertions at the same strength, reading a different file.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

// Blank comments before scanning so a seam cannot be satisfied by text in a comment while the live
// code has lost it. Blanks rather than deletes so offsets still line up. Matches the repo convention
// (session-cookie-attributes.test.ts, icon-centring.test.ts).
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// The link, not the page: the three seams moved there with the socket. Named from the repo root.
const LINK = stripComments(read('src/lib/stores/room.ts'));
// The page must NOT still carry a copy of the wiring — two owners of one scar list is the drift this
// guard exists to prevent, and a stale duplicate would keep every assertion below green.
const PAGE = stripComments(read('src/routes/+page.svelte'));

test('the link imports the scar helpers it wires, and the page no longer does', () => {
	// All three must be imported — a partial import would fail typecheck, but pinning it here means the
	// guard reds first and names the feature rather than surfacing as an opaque undefined-symbol build error.
	expect(LINK).toMatch(/import\s*\{[^}]*\bactiveScars\b[^}]*\}\s*from\s*'\$lib\/stores\/process-scars'/);
	expect(LINK).toMatch(/import\s*\{[^}]*\brecordScar\b[^}]*\}\s*from\s*'\$lib\/stores\/process-scars'/);
	expect(LINK).toMatch(/import\s*\{[^}]*\bclearScar\b[^}]*\}\s*from\s*'\$lib\/stores\/process-scars'/);
	// One owner. The page reads the room's state and renders it; it does not maintain the scar list.
	expect(PAGE).not.toContain('process-scars');
});

test('a failed media:status records a scar', () => {
	// The scar is written from the failure branch of the ws handler, snapshotting the catalog media.
	// Without this, a reload after a failure shows the song back as plain un-processed (the reported bug).
	expect(LINK).toMatch(/status === 'failed'/);
	expect(LINK).toMatch(/recordScar\(\s*failedMedia\s*\)/);
});

test('a successful re-process clears the scar', () => {
	// The owner's second ruling: a later `ready` for the same media clears its scar immediately, so a
	// row cannot read `failed` while the song is sitting there ready.
	expect(LINK).toMatch(/clearScar\(\s*mediaId\s*\)/);
	// and it must be in the `ready` branch, not somewhere unrelated
	expect(LINK).toMatch(/status === 'ready'\)\s*\{[\s\S]{0,120}clearScar\(/);
});

test('mount re-surfaces active scars into the live status map', () => {
	// The heart of the fix: on load, seed the persisted failures back. `mergeMedia` puts the scar's
	// snapshot into the catalog (GET /api/library omits a failed song, so it would otherwise not render),
	// then each scarred id is marked `failed` in the live map — flowing through the SAME liveOf ->
	// displayReadiness -> processingRows path a live failure uses, with no extra render code.
	expect(LINK).toMatch(/activeScars\(\)/);
	// The captured-scars holder must OUTLIVE the connect() call, so the queue:sync branch can re-apply
	// it long afterwards; a local inside connect() would be out of scope there. Pin its declaration as
	// a field on the link.
	expect(LINK).toMatch(/#scarred\s*:\s*Media\[\]\s*=\s*\[\]/);
	expect(LINK).toMatch(/this\.#scarred\s*=\s*activeScars\(\)/);
	expect(LINK).toMatch(/mergeMissingMedia\(\s*this\.#scarred\s*\)/);
	// the synthetic failed status, guarded so a fresher live broadcast is never overwritten
	expect(LINK).toMatch(/if\s*\(!withScars\.has\(m\.id\)\)\s*withScars\.set\(\s*m\.id\s*,\s*\{\s*status:\s*'failed'/);
});

test('the held scar list tracks failures that happen AFTER connect, not just the ones on disk', () => {
	// A seam the page version never had, and the hoist made load-bearing. The held list used to be a
	// snapshot taken once at mount, which was survivable only because the page remounted on every
	// navigation. The link does not remount — it lives for the document — so a failure arriving at
	// 22:10 must join the held list, or the NEXT queue:sync wipes that row and re-applying the stale
	// snapshot puts back only the failures that predate the connection.
	expect(LINK).toMatch(/this\.#scarred\s*=\s*\[\s*\.\.\.this\.#scarred\s*,\s*failedMedia\s*\]/);
	// …and a re-process that succeeds must drop it again, or the row keeps being re-surfaced as failed
	// on every sync after it is demonstrably ready.
	expect(LINK).toMatch(/this\.#scarred\s*=\s*this\.#scarred\.filter\(/);
});

test('a queue:sync re-applies the scars it would otherwise wipe', () => {
	// The ordering trap: queue:sync REPLACES mediaCatalog wholesale, and a failed song is not in the
	// room's media (it settled to un-processed server-side), so the room's first sync wipes the scarred
	// row — on the very reload the scar exists to survive. The handler must re-apply the captured
	// scars after rebuilding the catalog. Proven live: without this line the row renders once then
	// vanishes on sync; with it the row persists.
	expect(LINK).toMatch(/queue:sync/);
	expect(LINK).toMatch(/if\s*\(this\.#scarred\.length\)\s*this\.mergeMissingMedia\(\s*this\.#scarred\s*\)/);
	// and mergeMissingMedia must be gap-fill only (never overwrite a fresher server copy of an id)
	expect(LINK).toMatch(/mergeMissingMedia\(list: Media\[\]\)[\s\S]{0,260}if\s*\(!next\.has\(m\.id\)\)/);
});
