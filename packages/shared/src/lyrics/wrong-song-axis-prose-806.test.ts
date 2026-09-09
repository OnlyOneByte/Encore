// Guard for #806's COMMENT-ONLY hunks — four doc sites that documented which axis the absolute
// wrong-song judgement is decided on, and named the wrong one.
//
// #800 split lyrics agreement into a RANKING score and BASELINE COVERAGE and moved that judgement onto
// coverage, but `lyricsRank`'s doc still described tier 1 without saying which field it reads,
// `isLikelyWrongSong`'s doc named a `winnerCoverage` carrier that no producer emitted, and
// `SelectionRecord.winnerSuspect` still said the winner "scored below the wrong-song threshold" — the
// ranking axis, which stopped being how it is decided. Every side could therefore be read as agreeing
// while they did not, which is exactly how the swap shipped: a correct candidate graded against a
// partial baseline was convicted as ANOTHER SONG on a number that decided nothing.
//
// A comment-STRIPPED scan is the wrong shape here because the subject IS the comments — same reason
// `pin-base-prose-790.test.ts` and `spotify-enforcement-prose-742.test.ts` assert prose. Each assertion
// is anchored on the doc block of the symbol it documents, so the same words elsewhere in the file
// cannot satisfy it, and each is discriminating: reverting the corresponding hunk restores wording that
// fails it. This is what pins #806's four comment-only hunks, which by construction cannot red a
// behavioural test.
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLikelyWrongSong, lyricsRank, SUSPECT_COVERAGE } from './lyrics';

// import.meta.dir === packages/shared/src/lyrics; the repo root is four levels up.
const REPO = join(import.meta.dir, '..', '..', '..', '..');

const SITES = {
	lyrics: 'packages/shared/src/lyrics/lyrics.ts',
	types: 'packages/shared/src/core/types.ts'
} as const;

const sources = new Map<string, string>(
	Object.values(SITES).map((rel) => [rel, readFileSync(join(REPO, rel), 'utf8')] as const)
);
const src = (rel: string): string => sources.get(rel)!;

/**
 * The `/** ... *\/` block immediately above `anchor`. Scanning the block that DOCUMENTS the symbol —
 * rather than the whole file — is what makes each assertion discriminating.
 */
function docAbove(source: string, anchor: string): string {
	const at = source.indexOf(anchor);
	expect(at).toBeGreaterThan(-1); // sentinel: a renamed symbol fails loudly, never silently passes
	const before = source.slice(0, at);
	const open = before.lastIndexOf('/**');
	const close = before.lastIndexOf('*/');
	expect(open).toBeGreaterThan(-1);
	expect(close).toBeGreaterThan(open);
	// The block must be the one attached to the anchor: nothing but whitespace between them.
	expect(before.slice(close + 2).trim()).toBe('');
	return before.slice(open, close + 2);
}

test('#806 non-vacuous: both documented files exist, are non-trivial, and still discuss the axis split', () => {
	for (const rel of Object.values(SITES)) {
		expect(src(rel).length).toBeGreaterThan(2000);
		expect(src(rel)).toContain('coverage');
	}
	// The prose is only worth pinning while the code it describes still behaves this way, so anchor the
	// whole guard on the live functions rather than on text alone.
	expect(isLikelyWrongSong(SUSPECT_COVERAGE - 0.01)).toBe(true);
	expect(isLikelyWrongSong(SUSPECT_COVERAGE + 0.01)).toBe(false);
	const base = { ref: 'lyrics/a.json', textSource: 'lrclib', timing: 'word', textConfidence: 'high', createdAt: 0 } as const;
	expect(lyricsRank({ ...base, coverage: 0.2 })).toBe(1);
	expect(lyricsRank({ ...base, agreement: 0.2 })).toBe(5);
});

test('#806 LyricsCandidate.agreement is documented as a RANKING axis that answers no wrong-song question', () => {
	const doc = docAbove(src(SITES.lyrics), 'agreement?: number;');
	expect(doc).toMatch(/RANKING axis/);
	// The reason a low value here is not evidence of a wrong song, which is the whole defect.
	expect(doc).toMatch(/heard only part of the song/);
	expect(doc).toMatch(/reads `coverage`/);
});

test('#806 LyricsCandidate.coverage is documented as the one axis the wrong-song judgement may threshold', () => {
	const doc = docAbove(src(SITES.lyrics), 'coverage?: number;');
	expect(doc).toMatch(/BASELINE COVERAGE/);
	expect(doc).toMatch(/wrong-song judgement may threshold/);
	// Why it is a separate field rather than a second use of `agreement`.
	expect(doc).toMatch(/size asymmetry/);
	expect(doc).toMatch(/isLikelyWrongSong/);
});

test('#806 lyricsRank documents tier 1 as reading coverage, NOT the ranking score', () => {
	const doc = docAbove(src(SITES.lyrics), 'export function lyricsRank(');
	expect(doc).toMatch(/reads `coverage`, NOT `agreement`/);
	// The consequence of getting it wrong, named so a future reader does not re-swap it.
	expect(doc).toMatch(/convicts a CORRECT/);
	expect(doc).toMatch(/#806/);
	// ...and `agreement`'s remaining legitimate use is stated, so this is not read as "drop it".
	expect(doc).toMatch(/breaksTie/);
});

test('#806 isLikelyWrongSong names carriers of the coverage axis that actually exist', () => {
	const doc = docAbove(src(SITES.lyrics), 'export function isLikelyWrongSong(');
	expect(doc).toMatch(/BASELINE COVERAGE/);
	// Each named carrier must be a real member, not the phantom the old doc pointed at: before #806
	// `winnerCoverage` appeared nowhere in the repository except that comment.
	expect(doc).toMatch(/LyricsCandidate\.coverage/);
	expect(doc).toMatch(/SelectionRecord\.winnerCoverage/);
	expect(src(SITES.lyrics)).toMatch(/\n\tcoverage\?: number;/);
	expect(src(SITES.types)).toMatch(/\n\twinnerCoverage\?: number \| null;/);
});

test('#806 SelectionRecord documents winnerSuspect on coverage and winnerScore as ranking only', () => {
	const types = src(SITES.types);
	const suspect = docAbove(types, 'winnerSuspect: boolean;');
	expect(suspect).toMatch(/BASELINE COVERAGE/);
	// The pre-#806 wording — "scored below the wrong-song threshold" — pointed at the ranking axis.
	expect(suspect).not.toMatch(/winner scored below/);

	const score = docAbove(types, 'winnerScore: number | null;');
	expect(score).toMatch(/RANKING/);
	expect(score).toMatch(/NOT the axis/);

	const coverage = docAbove(types, 'winnerCoverage?: number | null;');
	expect(coverage).toMatch(/thresholded/);
	// Why the field is optional: an older attempt row has no key, which must read as "not recorded".
	expect(coverage).toMatch(/#806/);
});
