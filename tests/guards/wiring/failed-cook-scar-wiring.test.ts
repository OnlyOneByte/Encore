// guard: the failed-cook scar is WIRED into the phone page on all three seams it needs.
//
// THE DEFECT. A failed cook is a live-only signal — the catalog Media records no failure (a dead
// cook settles back to un-cooked via settleStemsGate), and the in-memory `mediaStatus` map that carries
// the live `failed` status is lost on reload. So a guest who reloads sees the song as plain un-cooked,
// with no trace it broke. The fix persists a per-device scar (the owner's ruling over a server column
// or leaving it as-is). The scar STORE (cook-scars.ts) is unit-tested directly; but the three lines
// that WIRE it into routes/+page.svelte — record on failure, clear on success, and re-surface on mount
// — live in a Svelte component that bun test never imports (Encore has no jsdom; every UI invariant is
// a source-scan guard). Without this guard, deleting any of the three wiring lines ships green: the
// store keeps its own tests while the feature is dead. This is the repo's most-repeated defect class.
//
// WHY A SOURCE SCAN. There is no pure function to unit-test here: the wiring is inside the onMount async
// closure and the ws message handler, both of which only run in a live browser page. The presence of
// each seam is a decidable property of the component source, so this reads +page.svelte and requires
// each one. Move or delete a seam and this guard moves with it.
import { test, expect } from 'bun:test';
import { read, at } from '@encore/test-support';

// Blank comments before scanning so a seam cannot be satisfied by text in a comment while the live
// code has lost it. Blanks rather than deletes so offsets still line up. Matches the repo convention
// (session-cookie-attributes.test.ts, icon-centring.test.ts).
function stripComments(src: string): string {
	const blank = (m: string) => m.replace(/[^\n]/g, ' ');
	return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

// Was `at('apps/core/src/routes/+page.svelte')` — the subject was the page this guard SAT BESIDE in
// apps/core/src/routes, so it is now named from the repo root.
const PAGE = stripComments(read('apps/core/src/routes/+page.svelte'));

test('the page imports the scar helpers it wires', () => {
	// All three must be imported — a partial import would fail typecheck, but pinning it here means the
	// guard reds first and names the feature rather than surfacing as an opaque undefined-symbol build error.
	expect(PAGE).toMatch(/import\s*\{[^}]*\bactiveScars\b[^}]*\}\s*from\s*'\$lib\/stores\/cook-scars'/);
	expect(PAGE).toMatch(/import\s*\{[^}]*\brecordScar\b[^}]*\}\s*from\s*'\$lib\/stores\/cook-scars'/);
	expect(PAGE).toMatch(/import\s*\{[^}]*\bclearScar\b[^}]*\}\s*from\s*'\$lib\/stores\/cook-scars'/);
});

test('a failed media:status records a scar', () => {
	// The scar is written from the failure branch of the ws handler, snapshotting the catalog media.
	// Without this, a reload after a failure shows the song back as plain un-cooked (the reported bug).
	expect(PAGE).toMatch(/status === 'failed'/);
	expect(PAGE).toMatch(/recordScar\(\s*failedMedia\s*\)/);
});

test('a successful re-cook clears the scar', () => {
	// The owner's second ruling: a later `ready` for the same media clears its scar immediately, so a
	// row cannot read `failed` while the song is sitting there ready.
	expect(PAGE).toMatch(/clearScar\(\s*e\.mediaId\s*\)/);
	// and it must be in the `ready` branch, not somewhere unrelated
	expect(PAGE).toMatch(/status === 'ready'\)\s*\{[\s\S]{0,120}clearScar\(/);
});

test('mount re-surfaces active scars into the live status map', () => {
	// The heart of the fix: on load, seed the persisted failures back. `mergeMedia` puts the scar's
	// snapshot into the catalog (GET /api/library omits a failed song, so it would otherwise not render),
	// then each scarred id is marked `failed` in the live map — flowing through the SAME liveOf ->
	// displayReadiness -> cookingRows path a live failure uses, with no extra render code.
	expect(PAGE).toMatch(/activeScars\(\)/);
	// The captured-scars holder must be a module-level binding so the ws handler's queue:sync branch
	// can re-apply it; a local inside onMount would be out of scope there. Pin its declaration.
	expect(PAGE).toMatch(/let\s+scarredMedia\s*:\s*Media\[\]\s*=\s*\[\]/);
	expect(PAGE).toMatch(/scarredMedia\s*=\s*activeScars\(\)/);
	expect(PAGE).toMatch(/mergeMissingMedia\(\s*scarredMedia\s*\)/);
	// the synthetic failed status, guarded so a fresher live broadcast is never overwritten
	expect(PAGE).toMatch(/if\s*\(!withScars\.has\(m\.id\)\)\s*withScars\.set\(\s*m\.id\s*,\s*\{\s*status:\s*'failed'/);
});

test('a queue:sync re-applies the scars it would otherwise wipe', () => {
	// The ordering trap: queue:sync REPLACES mediaCatalog wholesale, and a failed song is not in the
	// room's media (it settled to un-cooked server-side), so the room's first sync wipes the scarred
	// row — on the very reload the scar exists to survive. The handler must re-apply the captured
	// scars after rebuilding the catalog. Proven live: without this line the row renders once then
	// vanishes on sync; with it the row persists.
	expect(PAGE).toMatch(/queue:sync/);
	expect(PAGE).toMatch(/if\s*\(scarredMedia\.length\)\s*mergeMissingMedia\(\s*scarredMedia\s*\)/);
	// and mergeMissingMedia must be gap-fill only (never overwrite a fresher server copy of an id)
	expect(PAGE).toMatch(/function mergeMissingMedia[\s\S]{0,220}if\s*\(!next\.has\(m\.id\)\)/);
});
