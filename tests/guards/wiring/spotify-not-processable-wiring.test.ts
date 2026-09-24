// guard: the Spotify not-processable hunks whose revert a runtime suite cannot see — four TYPE-ONLY or
// PROSE hunks plus one relocated predicate, each scanned against the REAL production file so a revert
// fails a named test instead of only a typecheck. The `ProcessState` member is the sharpest: there is no
// `Record<ProcessState, …>` and no exhaustive `switch` anywhere, so deleting it typechecks clean while
// every consumer keeps falling through its `if (state === …)` chain. Behaviour lives in the siblings.
import { readFileSync } from 'node:fs';
import { test, expect } from 'bun:test';
import { at, read } from '@encore/test-support';
import { flattenDoc, stripComments } from '@encore/test-support/scan';

const processRaw = readFileSync(at('src/lib/server/jobs/process.ts'), 'utf8');
const processCode = stripComments(processRaw, { drop: true });
const readinessRaw = read('src/lib/readiness.ts');
const songRowRaw = read('src/lib/components/SongRow.svelte');

test('non-vacuous: the three production files were really read', () => {
	// A rename or a move must fail loudly here rather than letting every scan below pass on an empty read.
	expect(processRaw.length).toBeGreaterThan(4000);
	expect(readinessRaw.length).toBeGreaterThan(2000);
	expect(songRowRaw.length).toBeGreaterThan(4000);
	// and each still holds the symbol whose wiring is asserted below
	expect(processCode).toMatch(/export function processState\(/);
	expect(readinessRaw).toMatch(/export function canProcess\(/);
	expect(songRowRaw).toMatch(/\{#if onmake\}/);
});

test('ProcessState DECLARES not-processable (the member the compiler does not force)', () => {
	// Type-only hunk; its runtime effect is proven in spotify-not-processable.test.ts. Reverting it makes
	// processState return a value outside its own union — a typecheck failure and nothing `bun test` sees.
	const union = processCode.match(/export type ProcessState =[\s\S]*?;/);
	expect(union).not.toBeNull();
	expect(union![0]).toMatch(/\|\s*'not-processable'/);
	// the members it must NOT have displaced: replacing an existing state rather than adding one changes how
	// the route answers for a song that is merely playing or already processed.
	for (const member of ['unknown', 'playing', 'ready', 'processing', 'over-limit', 'processable']) {
		expect(union![0]).toContain(`'${member}'`);
	}
});

test('the standalone source check is GONE from requestProcess', () => {
	// The relocated predicate. Reverting only the second of its two hunks re-adds the old
	// `const state = processState(…)` beside the one the first hunk moved up, so the revert breaks the build
	// instead of reddening a test — and a build break is not a proof. ARM 1: the literal is gone.
	expect(processCode).not.toMatch(/media\.source\s*===\s*'spotify'/);
	// ARM 2: the discredited SHAPE is banned under any name. The finding was not "this check is unused" but
	// "this check is in the WRONG PLACE" — a local source comparison anywhere in this file re-creates the
	// defect, because a rule enforced beside the code that acts on it is invisible to the deciding layer.
	expect(processCode).not.toMatch(/\.source\s*===\s*'spotify'/);
	expect(processCode).not.toMatch(/'spotify'\s*===/);
	// …and the refusal is off the STATE, so every caller that asks processState first sees it coming.
	expect(processCode).toMatch(/if\s*\(state === 'not-processable'\)\s*return null;/);
	expect(processCode).toMatch(/if\s*\(!isProcessableSource\(media\.source\)\)\s*return 'not-processable';/);
});

test('ARM 2 DISCRIMINATES — the ban catches a renamed copy of the old check', () => {
	// Proving the ban is not vacuous: a literal-name scan that cannot see a renamed reintroduction is a guard
	// in name only. These are the shapes a future author would most plausibly write.
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
	expect(/\.source\s*===\s*'spotify'/.test('if (!isProcessableSource(media.source)) return null;')).toBe(false);
});

/**
 * The docstring IMMEDIATELY above a declaration. Anchoring matters: a lazy `[\s\S]*?` from the first block
 * in the file spans several unrelated comment blocks to reach the declaration, so an assertion about "the
 * docstring" silently becomes one about half the file. This takes the LAST block ending before it.
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

/**
 * A docstring with its ` * ` markers stripped and whitespace collapsed, so an arm matches the SENTENCE
 * rather than one line-wrapping of it. Without this, re-flowing the paragraph moved "Returns the job," and
 * "or null" onto separate lines and the reason-list anchor stopped matching a docstring that still said it.
 */
function flatten(doc: string): string {
	return flattenDoc(doc.replace(/^\s*\/\*\*|\*\/\s*$/g, ' ')).trim();
}

test("requestProcess's docstring no longer makes a promise it breaks", () => {
	// Prose hunk. The docstring told callers to ask `processState` to tell its refusals apart, and for THIS
	// refusal that was false — which is what let every caller act as though a process were about to start.
	const doc = docFor(processRaw, 'export function requestProcess');
	expect(doc).not.toBeNull();
	expect(doc!).toMatch(/processState/);
	// It must NAME the metadata-only refusal in its own LIST of the reasons it returns null: that list is what
	// misled a caller, enumerating four reasons where there were five. Matched on the FLATTENED docstring and
	// with the lead-in loosened to `null when there is no work`, so a reword or a re-wrap cannot pass as a
	// deleted list — the claim being banned is a reason list with the metadata-only refusal missing from it.
	const reasons = flatten(doc!).match(/null when there is no work[\s\S]*?\./);
	expect(reasons).not.toBeNull();
	expect(reasons![0]).toMatch(/metadata-only|not-processable/i);
});

test("canProcess's docstring SUMMARY states that it reads the media, not readiness alone", () => {
	// Prose hunk on the client gate. The signature change is pinned by behaviour and by the four template call
	// sites, so this pins the REASON, because the next author to add a fifth row reads the docstring. Asserted
	// on the SUMMARY specifically — the first sentence, which is what an editor tooltip shows at a call site —
	// since a summary still saying "neither done nor in flight" describes the predicate this replaced.
	const doc = docFor(readinessRaw, 'export function canProcess');
	expect(doc).not.toBeNull();
	expect(summaryOf(doc!)).toMatch(/acquir/i);
	// and the signature really does take both
	expect(readinessRaw).toMatch(/export function canProcess\(m: Media, r: Readiness\): boolean/);
});

test('SongRow DECLARES the processable prop (type-only, so nothing else pins it)', () => {
	// Type-only hunk in the Props interface; reverting the declaration alone breaks only the typecheck.
	expect(songRowRaw).toMatch(/processable\?\s*:\s*boolean;/);
	// declared optional AND defaulted true, which together make this safe for callers that pass nothing.
	expect(songRowRaw).toMatch(/processable\s*=\s*true/);
});
