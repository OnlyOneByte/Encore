// guard: four doc sites documented which axis the absolute wrong-song judgement is decided on, and named the
// wrong one. `agreement` is a RANKING score with no threshold applied to it; `coverage` is BASELINE COVERAGE
// and the only axis `isLikelyWrongSong` thresholds, so documenting it the other way round convicts a CORRECT
// candidate graded against a partial baseline as ANOTHER SONG. Each assertion is anchored on the doc block
// of the symbol it documents, so the same words elsewhere in the file cannot satisfy it.
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import { flattenDoc } from '@encore/test-support/scan';
import { isLikelyWrongSong, lyricsRank, SUSPECT_COVERAGE } from '$lib/contract';

// `read` supplies the repo root and throws if a site moves, so a renamed file is a path failure rather
// than a silently empty prose scan.
const SITES = {
	lyrics: 'src/lib/contract/lyrics/lyrics.ts',
	types: 'src/lib/contract/core/types.ts'
} as const;

const sources = new Map<string, string>(Object.values(SITES).map((rel) => [rel, read(rel)] as const));
const src = (rel: string): string => sources.get(rel)!;

/** The block immediately above `anchor`. Scanning the block that DOCUMENTS the symbol, rather than the
 *  whole file, is what makes each assertion discriminating. */
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
	// Flattened, so every assertion below matches the SENTENCE rather than one line-wrapping of it: without
	// this, re-flowing a paragraph turns `size asymmetry` into `size\n *  asymmetry` and the guard reports a
	// live claim as missing.
	return flattenDoc(before.slice(open, close + 2));
}

test('non-vacuous: both documented files exist, are non-trivial, and still discuss the axis split', () => {
	for (const rel of Object.values(SITES)) {
		expect(src(rel).length).toBeGreaterThan(2000);
		expect(src(rel)).toContain('coverage');
	}
	// The prose is only worth pinning while the code it describes still behaves this way, so the whole guard
	// is anchored on the live functions rather than on text alone.
	expect(isLikelyWrongSong(SUSPECT_COVERAGE - 0.01)).toBe(true);
	expect(isLikelyWrongSong(SUSPECT_COVERAGE + 0.01)).toBe(false);
	const base = {
		ref: 'lyrics/a.json',
		textSource: 'lrclib',
		timing: 'word',
		textConfidence: 'high',
		createdAt: 0
	} as const;
	expect(lyricsRank({ ...base, coverage: 0.2 })).toBe(1);
	expect(lyricsRank({ ...base, agreement: 0.2 })).toBe(5);
});

test('LyricsCandidate.agreement is documented as a RANKING axis that answers no wrong-song question', () => {
	const doc = docAbove(src(SITES.lyrics), 'agreement?: number;');
	expect(doc).toMatch(/RANKING axis/i);
	// The reason a low value here is not evidence of a wrong song, which is the whole defect.
	expect(doc).toMatch(/heard only part of the song/i);
	expect(doc).toMatch(/reads `coverage`/i);
});

test('LyricsCandidate.coverage is documented as the one axis the wrong-song judgement may threshold', () => {
	const doc = docAbove(src(SITES.lyrics), 'coverage?: number;');
	expect(doc).toMatch(/BASELINE COVERAGE/i);
	expect(doc).toMatch(/wrong-song judgement may threshold/i);
	// Why it is a separate field rather than a second use of `agreement`.
	expect(doc).toMatch(/size asymmetry/i);
	expect(doc).toMatch(/isLikelyWrongSong/);
});

test('lyricsRank documents tier 1 as reading coverage, NOT the ranking score', () => {
	const doc = docAbove(src(SITES.lyrics), 'export function lyricsRank(');
	// Wording-independent: the CLAIM is "tier 1 reads coverage, not agreement", not one phrasing of it.
	expect(doc).toMatch(/reads `coverage`[^.]{0,16}NOT `agreement`/i);
	// The consequence of getting it wrong, named so a future reader does not re-swap it.
	expect(doc).toMatch(/convicts a CORRECT/i);
	// …and `agreement`'s remaining legitimate use is stated, so this is not read as "drop it".
	expect(doc).toMatch(/breaksTie/);
});

test('isLikelyWrongSong names carriers of the coverage axis that actually exist', () => {
	const doc = docAbove(src(SITES.lyrics), 'export function isLikelyWrongSong(');
	expect(doc).toMatch(/BASELINE COVERAGE/i);
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
	expect(suspect).toMatch(/BASELINE COVERAGE/i);
	// The old wording — "scored below the wrong-song threshold" — pointed at the ranking axis.
	expect(suspect).not.toMatch(/winner scored below/i);

	const score = docAbove(types, 'winnerScore: number | null;');
	expect(score).toMatch(/RANKING/i);
	expect(score).toMatch(/NOT the axis/i);

	const coverage = docAbove(types, 'winnerCoverage?: number | null;');
	expect(coverage).toMatch(/thresholded/i);
	// Why the field is optional: an older attempt row has no key, which must read as "not recorded". The source
	// states that schema boundary in words, so the guard pins the words rather than a version number.
	expect(coverage).toMatch(/before the coverage axis landed/i);
});
