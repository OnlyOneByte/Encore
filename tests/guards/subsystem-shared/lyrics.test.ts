// The candidate model + presentation ranking. The whole point of storing MANY lyrics sets
// per song is that text quality and timing fidelity are independent, so these pin the ranking that
// resolves them — especially the two non-obvious calls the owner made:
//   • authoritative+line OUTRANKS asr+word (correct words beat a bouncing ball over invented ones)
//   • a low-confidence CAPTION is demoted to ASR standing despite arriving as "captions"
import { test, expect } from 'bun:test';
import { read } from '@encore/test-support';
import {
	type LyricsCandidate,
	type LyricsTextSource,
	type LyricsTiming,
	type LyricsConfidence,
	isAuthoritativeText,
	hasUsableTiming,
	lyricsRank,
	pickBestLyrics,
	mergeLyricsCandidate,
	lyricsTokens,
	agreement,
	agreementScore,
	isLikelyWrongSong,
	SUSPECT_COVERAGE,
	SEQUENCE_WEIGHT
} from '@encore/shared';
// Was `'./lyrics-agreement-corpus'`, a sibling of this test in packages/shared/src/lyrics. Unlike the
// symbols above it is NOT re-exported from `packages/shared/src/index.ts`, so `@encore/shared` cannot
// reach it and a repo-relative import is the only route — same shape as
// tests/guards/design-system/colour-tokens.test.ts reaching its own registry JSON.
import { AGREEMENT_PARITY_CORPUS } from '../../../packages/shared/src/lyrics/lyrics-agreement-corpus';

let _t = 0;
const cand = (
	textSource: LyricsTextSource,
	timing: LyricsTiming,
	over: Partial<LyricsCandidate> = {}
): LyricsCandidate => ({
	ref: `${textSource}-${timing}-${++_t}`,
	textSource,
	timing,
	textConfidence: (over.textConfidence ?? 'high') as LyricsConfidence,
	createdAt: _t,
	...over
});

// ── isAuthoritativeText ─────────────────────────────────────────────────────
test('ASR is never authoritative, no matter its confidence', () => {
	expect(isAuthoritativeText(cand('asr', 'word', { textConfidence: 'high' }))).toBe(false);
});

test('a LOW-confidence caption is demoted to non-authoritative (ASR wearing a caption hat)', () => {
	expect(isAuthoritativeText(cand('captions', 'word', { textConfidence: 'low' }))).toBe(false);
	expect(isAuthoritativeText(cand('captions', 'word', { textConfidence: 'high' }))).toBe(true);
});

test('LRCLIB and manual text are authoritative', () => {
	expect(isAuthoritativeText(cand('lrclib', 'line'))).toBe(true);
	expect(isAuthoritativeText(cand('manual', 'none'))).toBe(true);
});

// ── rank ────────────────────────────────────────────────────────────────────
test('rank orders the tiers, and none-timing is 0 (unshowable)', () => {
	expect(lyricsRank(cand('lrclib', 'word'))).toBe(5);
	expect(lyricsRank(cand('lrclib', 'line'))).toBe(4);
	expect(lyricsRank(cand('asr', 'word'))).toBe(3);
	expect(lyricsRank(cand('asr', 'line'))).toBe(2);
	expect(lyricsRank(cand('lrclib', 'none'))).toBe(0);
});

test('THE OWNER CALL: authoritative+line outranks a baseline+word', () => {
	expect(lyricsRank(cand('lrclib', 'line'))).toBeGreaterThan(lyricsRank(cand('asr', 'word')));
});

test('a text identified as ANOTHER SONG ranks below every honest guess', () => {
	// Measured against transcripts of this actual audio and found to be a different song. Demoting
	// textConfidence alone left it TIED with the baseline that convicted it, and breaksTie then
	// preferred it — it has a numeric agreement, a baseline has none. So the room kept seeing words
	// already proven wrong while the words actually heard sat unshown beside them.
	//
	// The convicting axis is `coverage`, not `agreement`. A genuinely different song is low on
	// BOTH (measured: coverage 0.2745, rank score 0.1521), so both are set here — but only coverage is
	// thresholded, which the guard below proves by moving them apart.
	const suspect = {
		...cand('lrclib', 'word'),
		textConfidence: 'low' as const,
		agreement: 0.1521,
		coverage: 0.2745
	};
	const baseline = cand('asr', 'word'); // a baseline is the ruler, so it carries no score
	expect(lyricsRank(suspect)).toBe(1);
	expect(lyricsRank(suspect)).toBeLessThan(lyricsRank(baseline));
	expect(pickBestLyrics([suspect, baseline])).toBe(baseline);
});

test('a LOW RANK SCORE with high coverage is NOT another song — it is a partial baseline', () => {
	// THE REGRESSION. YouTube's ASR suppresses sung vocals, so a baseline that heard only part of the
	// song is the normal case here, and a correct authored lookup graded against one scores low on the
	// RANKING axis by construction. Measured through the real align plan: agreement 0.1857 while the
	// coverage that actually decided it was 0.6970 — so the worker correctly declined to demote
	// (winner_suspect false, textConfidence still high) while lyricsRank convicted the same text.
	//
	// Consequence, measured: rank 1 instead of 5, so pickBestLyrics handed the room the ASR transcript
	// over the correct words, and make-karaoke's candidate merge meant a later correct align could
	// never displace it.
	const correct = { ...cand('lrclib', 'word'), agreement: 0.1857, coverage: 0.697 };
	const asrBaseline = { ...cand('asr', 'word'), textConfidence: 'low' as const };
	expect(lyricsRank(correct)).toBe(5);
	expect(lyricsRank(correct)).toBeGreaterThan(lyricsRank(asrBaseline));
	expect(pickBestLyrics([correct, asrBaseline])).toBe(correct);

	// SENTINEL — so the guard above cannot be satisfied by deleting the tier. A genuinely different
	// song has LOW coverage and is still convicted, even though its rank score is the same order of
	// magnitude as the correct candidate's above (0.1521 vs 0.1857 — 0.03 apart, which is why no
	// threshold on the ranking score can separate them).
	const differentSong = { ...cand('lrclib', 'word'), agreement: 0.1521, coverage: 0.2745 };
	expect(lyricsRank(differentSong)).toBe(1);
});

test('a suspect text is still shown when it is the only thing there', () => {
	// Rank 1, not 0. Wrong words beat a blank screen when there is no alternative, and the TV labels it.
	const suspect = {
		...cand('lrclib', 'word'),
		textConfidence: 'low' as const,
		agreement: 0.05,
		coverage: 0.05
	};
	expect(pickBestLyrics([suspect])).toBe(suspect);
});

test('a high coverage does not trip the suspect tier', () => {
	const good = { ...cand('lrclib', 'word'), agreement: 0.94, coverage: 0.94 };
	expect(lyricsRank(good)).toBe(5);
});

test('an UNJUDGED candidate is not treated as suspect', () => {
	// No baseline could compare it (an instrumental, or text too short). "Cannot tell" must not demote.
	expect(lyricsRank(cand('lrclib', 'word'))).toBe(5);
	expect(lyricsRank({ ...cand('lrclib', 'word'), coverage: undefined })).toBe(5);
	// A candidate carrying only the ranking axis (an older worker, or a baseline) is also UNJUDGED for
	// this purpose: `agreement` alone must never reach the wrong-song threshold.
	expect(lyricsRank({ ...cand('lrclib', 'word'), agreement: 0.08 })).toBe(5);
});

// ── pickBestLyrics ────────────────────────────────────────────────────────────
test('picks the ideal when present', () => {
	const set = [cand('asr', 'word'), cand('lrclib', 'word'), cand('lrclib', 'line')];
	expect(pickBestLyrics(set)!.textSource).toBe('lrclib');
	expect(pickBestLyrics(set)!.timing).toBe('word');
});

test('LRCLIB unreachable → falls to ASR word timings (the done-when floor for this box)', () => {
	const asr = cand('asr', 'word');
	expect(pickBestLyrics([asr])).toBe(asr);
});

test('authoritative line beats ASR word even though the ball would look nicer', () => {
	const line = cand('lrclib', 'line');
	const asrWord = cand('asr', 'word');
	expect(pickBestLyrics([asrWord, line])).toBe(line);
});

test('nothing showable → null (honest "no lyrics", not a blank overlay)', () => {
	expect(pickBestLyrics([cand('lrclib', 'none'), cand('asr', 'none')])).toBeNull();
	expect(pickBestLyrics([])).toBeNull();
});

test('at equal rank, higher timing confidence wins; else newer', () => {
	const lo = cand('lrclib', 'word', { timingConfidence: 'low', createdAt: 100 });
	const hi = cand('lrclib', 'word', { timingConfidence: 'high', createdAt: 1 });
	expect(pickBestLyrics([lo, hi])).toBe(hi); // confidence beats recency
	const oldC = cand('lrclib', 'word', { timingConfidence: 'medium', createdAt: 1 });
	const newC = cand('lrclib', 'word', { timingConfidence: 'medium', createdAt: 999 });
	expect(pickBestLyrics([oldC, newC])).toBe(newC); // recency breaks a true tie
});

// ── mergeLyricsCandidate: the never-regress guarantee ─────────────────────────
test('merging a NEW candidate never worsens the pick (upgrade path)', () => {
	let set: LyricsCandidate[] = [cand('asr', 'word')];
	const bestBefore = lyricsRank(pickBestLyrics(set)!);
	set = mergeLyricsCandidate(set, cand('lrclib', 'word')); // LRCLIB arrives later
	expect(lyricsRank(pickBestLyrics(set)!)).toBeGreaterThanOrEqual(bestBefore);
	expect(pickBestLyrics(set)!.textSource).toBe('lrclib');
});

test('a later LINE-level source cannot displace existing WORD timings', () => {
	let set: LyricsCandidate[] = [cand('lrclib', 'word', { ref: 'keep' })];
	set = mergeLyricsCandidate(set, cand('lrclib', 'line')); // coarser, arrives after
	expect(pickBestLyrics(set)!.ref).toBe('keep');
	expect(set).toHaveLength(2); // both retained — nothing thrown away
});

test('re-running a job overwrites its OWN artifact rather than stacking duplicates', () => {
	let set: LyricsCandidate[] = [cand('asr', 'word', { ref: 'asr.json', createdAt: 1 })];
	set = mergeLyricsCandidate(set, cand('asr', 'word', { ref: 'asr.json', createdAt: 2 }));
	expect(set).toHaveLength(1);
	expect(set[0]!.createdAt).toBe(2);
});

// ── agreement: catching a confidently wrong lookup ────────────────────────────
test('tokenizer strips LRC stamps, markers, and punctuation', () => {
	expect(lyricsTokens('[00:12.50]Hello, world! [Chorus]')).toEqual(['hello', 'world']);
});

test('tokenizer NFKC-folds so Unicode form-variants tokenise alike (mirrors the Python side)', () => {
	// composed vs decomposed: "Beyonce\u0301" (e + combining acute) vs "Beyonc\u00e9" (single codepoint)
	expect(lyricsTokens('Beyonce\u0301')).toEqual(lyricsTokens('Beyonc\u00e9'));
	// full-width Latin folds to ASCII, and a ligature (U+FB01 fi) expands
	expect(lyricsTokens('\uFF28\uFF45\uFF4C\uFF4C\uFF4F')).toEqual(['hello']);
	expect(lyricsTokens('\uFB01nd')).toEqual(['find']);
	// ASCII path unchanged
	expect(lyricsTokens("Hello, World! don't stop")).toEqual(['hello', 'world', "don't", 'stop']);
});

test('the same lyrics score high; a different song scores low', () => {
	// each side has >= MIN_TOKENS_TO_COMPARE (12) UNIQUE tokens after dedup
	const a = 'we could be heroes just for one day standing by the wall guns above our heads and we kissed';
	const b = 'we could be heroes just for one day standing near the wall guns above their heads and we kissed';
	expect(agreementScore(a, b)!).toBeGreaterThanOrEqual(0.7); // near-identical, a couple of word swaps
	const other = 'never gonna give you up let down run around desert cry say goodbye tell lie hurt';
	const score = agreementScore(a, other);
	expect(score).not.toBeNull();
	expect(score!).toBeLessThan(0.25); // shares almost nothing, ranks near the floor
});

test('agreement is count- and position-aware (repeats and reorders cost the score)', () => {
	// The two cases symmetric set Jaccard scored a perfect 1.0. The words are all present either way,
	// so coverage stays 1 — it IS the same song and the wrong-song judgement must not fire — while the
	// ranking score drops on both.
	const twelve = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima';

	const twice = agreement(`${twelve} ${twelve}`, twelve)!;
	expect(twice.coverage).toBe(1); // every audible word is in the candidate
	expect(twice.fidelity).toBe(0.5); // but half the candidate is not audible
	expect(twice.rankScore).toBeLessThan(0.5); // saying the chorus twice costs rank

	const reversed = twelve.split(' ').reverse().join(' ');
	const backwards = agreement(twelve, reversed)!;
	expect(backwards.coverage).toBe(1);
	expect(backwards.sequence).toBe(0); // not one adjacent pair survives a full reversal
	expect(backwards.rankScore).toBe(0.5); // position is worth exactly SEQUENCE_WEIGHT of the score
	expect(SEQUENCE_WEIGHT).toBe(0.5);
});

test('agreement matches the shared cross-language corpus (parity with the Python mirror)', () => {
	// The Python suite (apps/worker/tests/test_lyrics_agreement_542.py) asserts this SAME table, so a
	// drift on either implementation reds one of the two suites. Expectations are integer [num, den]
	// pairs worked out by hand — not by running this code — so a bug cannot agree with itself.
	for (const c of AGREEMENT_PARITY_CORPUS) {
		const got = agreement(c.candidate, c.baseline);
		if (c.coverage === null || c.fidelity === null || c.sequence === null) {
			// A not-comparable case is all-null by construction; assert that, then that agreement abstains.
			expect(c.coverage).toBeNull();
			expect(c.fidelity).toBeNull();
			expect(c.sequence).toBeNull();
			expect(got).toBeNull(); // below MIN_TOKENS_TO_COMPARE: "cannot tell", not "differ"
			continue;
		}
		expect(got).not.toBeNull();
		expect(got!.coverage).toBe(c.coverage[0] / c.coverage[1]);
		expect(got!.fidelity).toBe(c.fidelity[0] / c.fidelity[1]);
		expect(got!.sequence).toBe(c.sequence[0] / c.sequence[1]);
	}
});

test('the parity corpus keeps a case only MULTIPLICITY can score', () => {
	// WHY THIS GUARD EXISTS. The row above pins what `agreement` COMPUTES; this pins that the table still
	// contains a row capable of telling a multiset intersection from a set one. Without it, deleting that
	// row leaves every remaining case scoring identically under either overlap, so replacing
	// `multisetOverlap` — the metric that replaced set Jaccard — with a set-based overlap keeps the whole TS suite
	// green. Measured on base: that mutation was invisible at 26 pass / 0 fail.
	//
	// The discriminator is computed here as the DISTINCT shared count — deliberately NOT with the
	// production overlap, so this cannot agree with a broken implementation. A case discriminates when the
	// corpus's own hand-computed multiset numerator EXCEEDS what counting distinct tokens can reach.
	const distinctShared = (candidate: string, baseline: string): number => {
		const inBaseline = new Set(lyricsTokens(baseline));
		return [...new Set(lyricsTokens(candidate))].filter((t) => inBaseline.has(t)).length;
	};
	const discriminating = AGREEMENT_PARITY_CORPUS.filter(
		(c) => c.coverage !== null && c.coverage[0] > distinctShared(c.candidate, c.baseline)
	);
	expect(discriminating.map((c) => c.name)).not.toEqual([]);
	for (const c of discriminating) {
		// A repeated token on BOTH sides is the only shape that produces this, so assert the row really is
		// that shape rather than a miscounted expectation: more tokens than distinct tokens, on each side.
		expect(lyricsTokens(c.candidate).length).toBeGreaterThan(new Set(lyricsTokens(c.candidate)).size);
		expect(lyricsTokens(c.baseline).length).toBeGreaterThan(new Set(lyricsTokens(c.baseline)).size);
	}
});

test('too-short text returns null, NOT 0 — an instrumental must not fail a correct lookup', () => {
	expect(agreementScore('la la la', 'the full authoritative lyrics of some long song here now')).toBeNull();
	expect(isLikelyWrongSong(null)).toBe(false); // unknown is never a detected mismatch
	expect(isLikelyWrongSong(undefined)).toBe(false);
});

test('isLikelyWrongSong reads coverage and fires only below the suspect threshold', () => {
	expect(SUSPECT_COVERAGE).toBe(0.4);
	expect(isLikelyWrongSong(0.1)).toBe(true);
	expect(isLikelyWrongSong(0.9)).toBe(false);
});

// ── hasUsableTiming ───────────────────────────────────────────────────────────
test('hasUsableTiming is true for word/line, false for none', () => {
	expect(hasUsableTiming(cand('lrclib', 'word'))).toBe(true);
	expect(hasUsableTiming(cand('lrclib', 'line'))).toBe(true);
	expect(hasUsableTiming(cand('lrclib', 'none'))).toBe(false);
});

// ── the retired threshold stays retired ───────────────────────────────────────
// SUSPECT_AGREEMENT = 0.25 was replaced with SUSPECT_COVERAGE = 0.40 on a DIFFERENT axis, so the old
// name was deleted rather than re-valued. Deleting a symbol nothing imports is invisible to a
// behavioural test by construction — re-adding the constant reds nothing — so this is a source-scan
// guard: it reads the real production module as TEXT and asserts the declaration is gone.
//
// The Python mirror asserts the same thing (tests/test_lyrics_agreement_542.py), but that suite is not
// the one a change to lyrics.ts runs, so the guard has to exist on BOTH sides to actually bite here.
//
// Matched as a DECLARATION, not as a substring: the surviving constant's own doc comment names
// SUSPECT_AGREEMENT on purpose, to tell a reader still carrying 0.25 in their head that the axis moved.
// A bare substring scan would fire on that prose and make the guard unfalsifiable.
test('lyrics.ts no longer declares the retired SUSPECT_AGREEMENT', () => {
	// Was `at('packages/shared/src/lyrics/lyrics.ts')` — the module under test was this guard's own SIBLING in
	// packages/shared/src/lyrics, so it is now named from the repo root.
	const source = read('packages/shared/src/lyrics/lyrics.ts');
	expect(source).toMatch(/export const SUSPECT_COVERAGE\s*=/);
	expect(source).not.toMatch(/export const SUSPECT_AGREEMENT\s*=/);
});
