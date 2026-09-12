// Wiring guards for the Spotify not-cookable ruling — the hunks whose revert a runtime suite cannot see.
//
// The behavioural halves live in spotify-not-cookable-742.test.ts (cookState's verdict, the rotation
// consequence), not-cookable-arm-742.test.ts (the route arm) and spotify-affordance-742.test.ts (the
// markup). What is left is four hunks that are TYPE-ONLY or PROSE, plus one relocated predicate — none
// of which can red a runtime assertion, so `prove_per_hunk.py` reports them green-when-reverted. Each
// gets a scan against the REAL production file here, so reverting it fails a named test instead of only
// a typecheck.
//
// The CookState member is the sharpest of them, and the issue said so in advance: adding it forces
// NOTHING. There is no `Record<CookState, …>` and no exhaustive `switch` anywhere in the repo, so the
// union member type-checks clean while every consumer keeps falling through its `if (state === …)`
// chain. Without the scan below, deleting that member is invisible to `bun test`.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';

function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// make-karaoke.ts was `at('apps/core/src/lib/server/jobs/make-karaoke.ts')` — this guard's own SIBLING in
// apps/core/src/lib/server/jobs. The other two came off `CORE = at('apps/core/src')`, which
// from that directory meant apps/core/src. All three are named from the repo root now, and `read` throws
// on a miss, which is what keeps the length floors below from passing on an empty read.
const makeKaraokeRaw = read('apps/core/src/lib/server/jobs/make-karaoke.ts');
const makeKaraokeCode = stripComments(makeKaraokeRaw);
const readinessRaw = read('apps/core/src/lib/readiness.ts');
const songRowRaw = read('apps/core/src/lib/components/SongRow.svelte');

test('non-vacuous: the three production files were really read', () => {
	// A rename or a move must fail loudly here rather than letting every scan below pass on an empty read.
	expect(makeKaraokeRaw.length).toBeGreaterThan(4000);
	expect(readinessRaw.length).toBeGreaterThan(2000);
	expect(songRowRaw.length).toBeGreaterThan(4000);
	// and each still holds the symbol whose wiring is asserted below
	expect(makeKaraokeCode).toMatch(/export function cookState\(/);
	expect(readinessRaw).toMatch(/export function canCook\(/);
	expect(songRowRaw).toMatch(/\{#if onmake\}/);
});

test('CookState DECLARES not-cookable (the member the compiler does not force)', () => {
	// Type-only hunk. Its runtime effect is proven in spotify-not-cookable-742.test.ts; this pins the
	// declaration itself. Reverting it makes cookState return a value outside its own union — a
	// typecheck failure and nothing else, which `bun test` would sail straight past.
	const union = makeKaraokeCode.match(/export type CookState =[\s\S]*?;/);
	expect(union).not.toBeNull();
	expect(union![0]).toMatch(/\|\s*'not-cookable'/);
	// the members it must NOT have displaced — a fix that replaced an existing state rather than adding
	// one would change how the route answers for a song that is merely playing or already cooked.
	for (const member of ['unknown', 'playing', 'ready', 'cooking', 'over-limit', 'cookable']) {
		expect(union![0]).toContain(`'${member}'`);
	}
});

test('the standalone source check is GONE from requestMakeKaraoke', () => {
	// The relocated predicate. `prove_per_hunk.py` reports this hunk WEAK rather than PINNED because the
	// replacement is split across two hunks: reverting only the second re-adds the old
	// `const state = cookState(…)` beside the one the first hunk moved up, so the revert breaks the build
	// instead of reddening a test — and a build break is not a proof (§3).
	//
	// ARM 1: the literal is gone.
	expect(makeKaraokeCode).not.toMatch(/media\.source\s*===\s*'spotify'/);
	// ARM 2: and the discredited SHAPE is banned under any name. The finding was not "this check is
	// unused", it was "this check is in the WRONG PLACE" — a local source comparison anywhere in this
	// file re-creates exactly the defect, because a rule enforced beside the code that acts on it is
	// invisible to the layer that decides whether to act. The one authority is `isCookableSource`.
	expect(makeKaraokeCode).not.toMatch(/\.source\s*===\s*'spotify'/);
	expect(makeKaraokeCode).not.toMatch(/'spotify'\s*===/);
	// …and the refusal is off the STATE, so every caller that asks cookState first sees it coming.
	expect(makeKaraokeCode).toMatch(/if\s*\(state === 'not-cookable'\)\s*return null;/);
	expect(makeKaraokeCode).toMatch(/if\s*\(!isCookableSource\(media\.source\)\)\s*return 'not-cookable';/);
});

test('ARM 2 DISCRIMINATES — the ban catches a renamed copy of the old check', () => {
	// Proving the ban is not vacuous, per §3: a literal-name scan that cannot see a renamed
	// reintroduction is a guard in name only. These are the shapes a future author would most plausibly
	// write, and each must be caught by the same expressions asserted above.
	const renamed = [
		"if (m.source === 'spotify') return null;",
		"if (theMedia.source === 'spotify') return null;",
		"if ('spotify' === media.source) return null;"
	];
	for (const sample of renamed) {
		const caught = /\.source\s*===\s*'spotify'/.test(sample) || /'spotify'\s*===/.test(sample);
		expect(caught).toBe(true);
	}
	// and the sanctioned form is NOT caught, or the ban would forbid the fix itself
	expect(/\.source\s*===\s*'spotify'/.test('if (!isCookableSource(media.source)) return null;')).toBe(false);
});

/**
 * The docstring IMMEDIATELY above a declaration.
 *
 * Anchoring matters: a lazy `[\s\S]*?` from the first `/**` in the file will happily span several
 * unrelated comment blocks to reach the declaration, so an assertion about "the docstring" silently
 * becomes an assertion about half the file — and passes on prose that lives somewhere else entirely.
 * This takes the LAST comment block that ends immediately before the declaration.
 */
function docFor(src: string, declaration: string): string | null {
	const at = src.indexOf(declaration);
	if (at < 0) return null;
	const before = src.slice(0, at);
	const open = before.lastIndexOf('/**');
	const close = before.lastIndexOf('*/');
	if (open < 0 || close < open) return null;
	// nothing but whitespace may sit between the block and the declaration
	if (before.slice(close + 2).trim() !== '') return null;
	return before.slice(open, close + 2);
}

/** The SUMMARY line(s) of a docstring — everything before its first blank ` *` line. */
function summaryOf(doc: string): string {
	return doc.split(/\n\s*\*\s*\n/)[0] ?? doc;
}

test("requestMakeKaraoke's docstring no longer makes a promise it breaks", () => {
	// Prose hunk. The docstring told callers to ask `cookState` to tell its refusals apart, and for THIS
	// refusal that was false — which is what let every caller act as though a cook were about to start.
	// The sentence is load-bearing documentation of an invariant, so it is pinned like one.
	const doc = docFor(makeKaraokeRaw, 'export function requestMakeKaraoke');
	expect(doc).not.toBeNull();
	expect(doc!).toMatch(/cookState/);
	// It must NAME the metadata-only refusal in its own LIST of the reasons it returns null. The list is
	// the thing that misled a caller: it enumerated four reasons and there were five.
	const reasons = doc!.match(/Returns the job, or null when there is no work[\s\S]*?\./);
	expect(reasons).not.toBeNull();
	expect(reasons![0]).toMatch(/metadata-only|not-cookable/i);
});

test("canCook's docstring SUMMARY states that it reads the media, not readiness alone", () => {
	// Prose hunk on the client gate. The signature change is pinned by behaviour
	// (spotify-not-cookable-742.test.ts) and by the four template call sites
	// (spotify-affordance-742.test.ts); this pins the reason, because the next author to add a fifth row
	// reads the docstring, not the issue.
	//
	// Asserted on the SUMMARY specifically — the first sentence, which is what an editor tooltip shows
	// at a call site. The long explanation further down is a different hunk and cannot stand in for it:
	// a summary that still says "only for a song that is neither done nor in flight" describes the
	// predicate this fix replaced.
	const doc = docFor(readinessRaw, 'export function canCook');
	expect(doc).not.toBeNull();
	expect(summaryOf(doc!)).toMatch(/acquir/i);
	// and the signature really does take both
	expect(readinessRaw).toMatch(/export function canCook\(m: Media, r: Readiness\): boolean/);
});

test('SongRow DECLARES the cookable prop (type-only, so nothing else pins it)', () => {
	// Type-only hunk in the Props interface. Its rendered effect is pinned in
	// spotify-affordance-742.test.ts; reverting the declaration alone breaks only the typecheck.
	expect(songRowRaw).toMatch(/cookable\?\s*:\s*boolean;/);
	// declared optional AND defaulted true, which together are what make this change safe for the
	// existing callers that pass nothing.
	expect(songRowRaw).toMatch(/cookable\s*=\s*true/);
});
