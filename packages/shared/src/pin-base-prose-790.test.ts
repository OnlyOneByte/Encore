// Guard for #790 F3 — four sites documented the base a host pin counts, and two of them named the
// wrong one.
//
// `ops.ts:21` said `move-global`'s toSeq was "target index into the whole queued list" and
// `+page.svelte`'s `globalIdx` said it returned "the index in the WHOLE queued list (what a host pin's
// toSeq counts)". Neither was what `placePins` counted — it counted the whole NON-TERMINAL list, the
// playing entry included. Both sides could therefore be read as agreeing while they did not, which is
// how the off-by-one shipped: the phone sent an index into one list and the pin was applied to a
// longer one. Note `ops.ts:12` for the sibling `move` op was corrected by #637's fix to spell the base
// out; `move-global` one line below kept the loose wording.
//
// A comment-STRIPPED scan is the wrong shape here, because the subject IS the comments — same reason
// `spotify-enforcement-prose-742.test.ts` asserts prose. Each assertion is anchored on the symbol it
// documents and is discriminating: reverting the corresponding hunk restores wording that fails it.
//
// This is also what pins the four comment-only hunks of #790's fix, which by construction cannot red a
// behavioural test. `docs/loop/CODING-BOT.md` §3 sanctions exactly this shape for a hunk with no
// runtime observable, and requires the guard read the REAL production file — it does.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { placePins } from './rotation';
import type { QueueEntry } from './types';

// import.meta.dir === packages/shared/src; the repo root is three levels up.
const REPO = join(import.meta.dir, '..', '..', '..');

/** The four sites that document the pin's base, each read from the real tree. */
const SITES = {
	ops: 'packages/shared/src/ops.ts',
	rotation: 'packages/shared/src/rotation.ts',
	page: 'apps/core/src/routes/+page.svelte',
	store: 'apps/core/src/lib/stores/queue.ts'
} as const;

const sources = new Map<string, string>(
	Object.values(SITES).map((rel) => [rel, readFileSync(join(REPO, rel), 'utf8')] as const)
);
const src = (rel: string): string => sources.get(rel)!;

/**
 * The comment block immediately above `anchor`. Scanning the doc that DOCUMENTS the symbol — rather
 * than the whole file — is what makes each assertion below discriminating: the same words appearing
 * somewhere else in the file cannot satisfy it.
 */
function docAbove(source: string, anchor: string): string {
	const at = source.indexOf(anchor);
	expect(at).toBeGreaterThan(-1); // sentinel: a renamed symbol fails loudly, never silently passes
	const before = source.slice(0, at);
	const open = before.lastIndexOf('/**');
	const close = before.lastIndexOf('*/');
	// The block must be the one attached to the anchor: opened, closed, and nothing but whitespace
	// between its close and the anchor.
	expect(open).toBeGreaterThan(-1);
	expect(close).toBeGreaterThan(open);
	expect(before.slice(close + 2).trim()).toBe('');
	return before.slice(open, close + 2);
}

test('#790 F3 non-vacuous: all four documented sites exist, are non-empty, and still discuss the pin', () => {
	// Without this sentinel a moved or renamed file passes every scan below on an empty read, and the
	// guard silently stops guarding.
	for (const rel of Object.values(SITES)) {
		expect(src(rel).length).toBeGreaterThan(200);
		expect(src(rel)).toMatch(/pinnedSeq|pinEntry|move-global/);
	}
});

test("#790 F3 — ops.ts states the base `move-global`'s toSeq counts, the way the sibling `move` op does", () => {
	const line = src(SITES.ops)
		.split('\n')
		.find((l) => l.includes("op: 'move-global'"));
	expect(line).toBeDefined();
	// The discredited wording named the queued list and stopped there, which reads as agreeing with
	// placePins' old whole-non-terminal base. Saying what does NOT occupy a slot is what disambiguates.
	expect(line!).toMatch(/queued/i);
	expect(line!).toMatch(/playing|terminal/i);
	// and the sibling `move` op keeps the base #637 gave it, so the two lines cannot drift apart again
	const moveLine = src(SITES.ops)
		.split('\n')
		.find((l) => l.includes("op: 'move'"));
	expect(moveLine!).toMatch(/queued/i);
});

test('#790 F3 — placePins documents that a pin indexes the queued entries only', () => {
	const doc = docAbove(src(SITES.rotation), 'export function placePins(');
	expect(doc).toMatch(/queued/i);
	expect(doc).toMatch(/#790/); // the finding this base was settled by, for the next reader
	// The old docstring said "its recorded global index", the wording that made the whole non-terminal
	// list sound intended. Ban it under the discredited meaning rather than banning the two words.
	expect(doc).not.toMatch(/recorded global index/i);
});

test("#790 F3 — globalIdx's doc no longer claims a pin counts the playing entry", () => {
	const doc = docAbove(src(SITES.page), 'function globalIdx(');
	// It must say what `queued` excludes. The old one-liner named the "WHOLE queued list" without
	// saying the playing entry is not in it, which is precisely the ambiguity that let the two sides
	// disagree while both looked right.
	expect(doc).toMatch(/playing/i);
	expect(doc).toMatch(/#790|not counted|excluded|not in it/i);
});

test('#790 F3 — unpinEntry records why it has no non-test caller', () => {
	const doc = docAbove(src(SITES.store), 'unpinEntry(id: string)');
	// A durable override reachable from no surface is either a gap or a decision; the file has to say
	// which, or the next reader cannot tell F1's silent pin from an intended host override.
	expect(doc).toMatch(/no non-test caller/i);
	expect(doc).toMatch(/#790/);
});

test('#790 F3 — the documented base is the one placePins actually implements (prose vs behaviour)', () => {
	// The whole point of F3 is prose that disagreed with code, so assert the two AGREE rather than
	// trusting either alone. A pin of 1 on the first queued row, with one entry playing: under the
	// documented queued-only base it lands second among the queued rows and the playing entry keeps
	// its slot. Expected order is hard-coded, not recomputed by the same splice placePins performs.
	const q = (id: string, pinnedSeq?: number): QueueEntry => ({
		id,
		mediaId: 'm-' + id,
		singerId: 's',
		status: 'queued',
		rotationSeq: -1,
		addedAt: 1,
		...(pinnedSeq === undefined ? {} : { pinnedSeq })
	});
	const ordered: QueueEntry[] = [{ ...q('p1'), status: 'playing' }, q('a1', 1), q('a2')];
	expect(placePins(ordered).map((x) => x.id)).toEqual(['p1', 'a2', 'a1']);
});
