// Guard for the wrong-song-axis COMMENT-ONLY hunks — four doc sites that documented which axis the absolute
// wrong-song judgement is decided on, and named the wrong one.
//
// An earlier change split lyrics agreement into a RANKING score and BASELINE COVERAGE and moved that judgement onto
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
// fails it. This is what pins those four comment-only hunks, which by construction cannot red a
// behavioural test.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { isLikelyWrongSong, lyricsRank, SUSPECT_COVERAGE } from '$lib/contract';

// The two documented files were already named repo-relative here; what was derived from this test's own
// location was the ROOT they were joined to (`at('.')`, four levels
// up from src/lib/contract/lyrics). `read` supplies that root and throws if a site moves, so a renamed
// file is a path failure rather than a silently empty prose scan.
const SITES = {
	lyrics: 'src/lib/contract/lyrics/lyrics.ts',
	types: 'src/lib/contract/core/types.ts'
} as const;

const sources = new Map<string, string>(Object.values(SITES).map((rel) => [rel, read(rel)] as const));
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

test('non-vacuous: both documented files exist, are non-trivial, and still discuss the axis split', () => {
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

test('LyricsCandidate.agreement is documented as a RANKING axis that answers no wrong-song question', () => {
	const doc = docAbove(src(SITES.lyrics), 'agreement?: number;');
	expect(doc).toMatch(/RANKING axis/);
	// The reason a low value here is not evidence of a wrong song, which is the whole defect.
	expect(doc).toMatch(/heard only part of the song/);
	expect(doc).toMatch(/reads `coverage`/);
});

test('LyricsCandidate.coverage is documented as the one axis the wrong-song judgement may threshold', () => {
	const doc = docAbove(src(SITES.lyrics), 'coverage?: number;');
	expect(doc).toMatch(/BASELINE COVERAGE/);
	expect(doc).toMatch(/wrong-song judgement may threshold/);
	// Why it is a separate field rather than a second use of `agreement`.
	expect(doc).toMatch(/size asymmetry/);
	expect(doc).toMatch(/isLikelyWrongSong/);
});

test('lyricsRank documents tier 1 as reading coverage, NOT the ranking score', () => {
	const doc = docAbove(src(SITES.lyrics), 'export function lyricsRank(');
	expect(doc).toMatch(/reads `coverage`, NOT `agreement`/);
	// The consequence of getting it wrong, named so a future reader does not re-swap it.
	expect(doc).toMatch(/convicts a CORRECT/);
	// The issue label that used to sit here was removed with every other reference in production source.
	// Nothing is lost: the claim, its consequence and `agreement`'s surviving use are each pinned by name
	// above and below, so the label was measuring itself.
	// ...and `agreement`'s remaining legitimate use is stated, so this is not read as "drop it".
	expect(doc).toMatch(/breaksTie/);
});

test('isLikelyWrongSong names carriers of the coverage axis that actually exist', () => {
	const doc = docAbove(src(SITES.lyrics), 'export function isLikelyWrongSong(');
	expect(doc).toMatch(/BASELINE COVERAGE/);
	// Each named carrier must be a real member, not the phantom the old doc pointed at: before the fix
	// `winnerCoverage` appeared nowhere in the repository except that comment.
	expect(doc).toMatch(/LyricsCandidate\.coverage/);
	expect(doc).toMatch(/SelectionRecord\.winnerCoverage/);
	expect(src(SITES.lyrics)).toMatch(/\n\tcoverage\?: number;/);
	expect(src(SITES.types)).toMatch(/\n\twinnerCoverage\?: number \| null;/);
});

test('SelectionRecord documents winnerSuspect on coverage and winnerScore as ranking only', () => {
	const types = src(SITES.types);
	const suspect = docAbove(types, 'winnerSuspect: boolean;');
	expect(suspect).toMatch(/BASELINE COVERAGE/);
	// The old wording — "scored below the wrong-song threshold" — pointed at the ranking axis.
	expect(suspect).not.toMatch(/winner scored below/);

	const score = docAbove(types, 'winnerScore: number | null;');
	expect(score).toMatch(/RANKING/);
	expect(score).toMatch(/NOT the axis/);

	const coverage = docAbove(types, 'winnerCoverage?: number | null;');
	expect(coverage).toMatch(/thresholded/);
	// Why the field is optional: an older attempt row has no key, which must read as "not recorded".
	// This one was NOT a bare label — the number dated the schema change ("written before #806"), which is
	// real information. The source now states it in words, so the guard pins the words instead of the
	// number, and the fact still cannot be deleted unnoticed.
	expect(coverage).toMatch(/before the coverage axis landed/);
});
