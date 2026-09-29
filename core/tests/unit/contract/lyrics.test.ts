// Text quality and timing fidelity are independent, which is why a song stores MANY lyrics sets. Two
// non-obvious calls in the ranking that resolves them: authoritative+line OUTRANKS asr+word (correct words
// beat a bouncing ball over invented ones), and a low-confidence CAPTION is demoted to ASR standing.
import { test, expect } from 'bun:test';
import { read } from '$test';
import {
	type LyricsCandidate,
	type LyricsTextSource,
	type LyricsTiming,
	type LyricsConfidence,
	isAuthoritativeText,
	hasUsableTiming,
	lyricsRank,
	lyricsSourceLabel,
	parseLyricsCandidates,
	pickBestLyrics,
	mergeLyricsCandidate,
	lyricsTokens,
	agreement,
	agreementScore,
	isLikelyWrongSong,
	SUSPECT_COVERAGE,
	SEQUENCE_WEIGHT
} from '$lib/contract';
// Not re-exported from the contract barrel, so a repo-relative import is the only route to it.
import { AGREEMENT_PARITY_CORPUS } from '$lib/contract/lyrics/lyrics-agreement-corpus';

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
	// Demoting textConfidence alone leaves it TIED with the baseline that convicted it, and breaksTie then
	// prefers it (it has a numeric agreement, a baseline has none). The convicting axis is `coverage`, NOT
	// `agreement`: a different song is low on both, but only coverage is thresholded.
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
	// YouTube's ASR suppresses sung vocals, so a partial baseline is NORMAL and a correct authored lookup
	// graded against one scores low on the RANKING axis by construction (agreement 0.1857, coverage 0.6970).
	// Convicting on rank score showed the ASR transcript, and the merge let no later align displace it.
	const correct = { ...cand('lrclib', 'word'), agreement: 0.1857, coverage: 0.697 };
	const asrBaseline = { ...cand('asr', 'word'), textConfidence: 'low' as const };
	expect(lyricsRank(correct)).toBe(5);
	expect(lyricsRank(correct)).toBeGreaterThan(lyricsRank(asrBaseline));
	expect(pickBestLyrics([correct, asrBaseline])).toBe(correct);

	// SENTINEL, so the guard above cannot be satisfied by deleting the tier: a different song has LOW coverage
	// and is still convicted, though its rank score is 0.03 from the correct candidate's above.
	const differentSong = { ...cand('lrclib', 'word'), agreement: 0.1521, coverage: 0.2745 };
	expect(lyricsRank(differentSong)).toBe(1);
});

test('a suspect text is still shown when it is the only thing there', () => {
	// Rank 1, not 0: wrong words beat a blank screen when there is no alternative, and the TV labels it.
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
	// No baseline could compare it (an instrumental, or text too short), and "cannot tell" must not demote.
	expect(lyricsRank(cand('lrclib', 'word'))).toBe(5);
	expect(lyricsRank({ ...cand('lrclib', 'word'), coverage: undefined })).toBe(5);
	// A candidate carrying only the ranking axis is also UNJUDGED: `agreement` alone never convicts.
	expect(lyricsRank({ ...cand('lrclib', 'word'), agreement: 0.08 })).toBe(5);
});

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

test('an attempt its worker REJECTED is never auto-selected, however it would rank (review M3)', () => {
	// The ladder retried it or moved past it; as a peer, authoritative + word beat the line doc it published.
	const rejected = cand('lrclib', 'word', { selectable: false });
	const published = cand('lrclib', 'line', { selectable: true });
	expect(lyricsRank(rejected)).toBe(0);
	expect(pickBestLyrics([rejected, published])).toBe(published);
	// Not "the least bad thing there": a job that published nothing has nothing to show.
	expect(pickBestLyrics([rejected])).toBeNull();
	// Absent is selectable, so every candidate stored before the flag existed ranks as it did.
	expect(lyricsRank(cand('lrclib', 'word'))).toBe(5);
});

test('at equal rank, higher timing confidence wins; else newer', () => {
	const lo = cand('lrclib', 'word', { timingConfidence: 'low', createdAt: 100 });
	const hi = cand('lrclib', 'word', { timingConfidence: 'high', createdAt: 1 });
	expect(pickBestLyrics([lo, hi])).toBe(hi); // confidence beats recency
	const oldC = cand('lrclib', 'word', { timingConfidence: 'medium', createdAt: 1 });
	const newC = cand('lrclib', 'word', { timingConfidence: 'medium', createdAt: 999 });
	expect(pickBestLyrics([oldC, newC])).toBe(newC); // recency breaks a true tie
});

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

test('tokenizer strips LRC stamps, markers, and punctuation', () => {
	expect(lyricsTokens('[00:12.50]Hello, world! [Chorus]')).toEqual(['hello', 'world']);
});

test('tokenizer NFKC-folds so Unicode form-variants tokenise alike (mirrors the Python side)', () => {
	// composed vs decomposed: "Beyonce\u0301" (e + combining acute) vs "Beyonc\u00e9" (single codepoint)
	expect(lyricsTokens('Beyonce\u0301')).toEqual(lyricsTokens('Beyonc\u00e9'));
	// full-width Latin folds to ASCII, and a ligature (U+FB01 fi) expands
	expect(lyricsTokens('\uFF28\uFF45\uFF4C\uFF4C\uFF4F')).toEqual(['hello']);
	expect(lyricsTokens('\uFB01nd')).toEqual(['find']);
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
	// Symmetric set Jaccard scored both a perfect 1.0. Coverage stays 1 (it IS the same song, so the wrong-song
	// judgement must not fire) while the ranking score drops on both.
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
	// worker/tests/test_lyrics_agreement.py asserts this SAME table, so drift on either side reds one of the two
	// suites; the expectations are integer [num, den] pairs worked out BY HAND, not by running this code.
	for (const c of AGREEMENT_PARITY_CORPUS) {
		const got = agreement(c.candidate, c.baseline);
		if (c.coverage === null || c.fidelity === null || c.sequence === null) {
			// A not-comparable case is all-null by construction; then agreement must abstain.
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
	// The table must keep a row that tells a multiset intersection from a set one: without one, every case
	// scores identically under either and swapping `multisetOverlap` for a set overlap keeps the suite green.
	// The discriminator is the DISTINCT shared count, NOT the production overlap, so it cannot agree with it.
	const distinctShared = (candidate: string, baseline: string): number => {
		const inBaseline = new Set(lyricsTokens(baseline));
		return [...new Set(lyricsTokens(candidate))].filter((t) => inBaseline.has(t)).length;
	};
	const discriminating = AGREEMENT_PARITY_CORPUS.filter(
		(c) => c.coverage !== null && c.coverage[0] > distinctShared(c.candidate, c.baseline)
	);
	expect(discriminating.map((c) => c.name)).not.toEqual([]);
	for (const c of discriminating) {
		// A repeated token on BOTH sides is the only shape producing this, so prove the row really is it.
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

test('hasUsableTiming is true for word/line, false for none', () => {
	expect(hasUsableTiming(cand('lrclib', 'word'))).toBe(true);
	expect(hasUsableTiming(cand('lrclib', 'line'))).toBe(true);
	expect(hasUsableTiming(cand('lrclib', 'none'))).toBe(false);
});

// SUSPECT_AGREEMENT = 0.25 was replaced by SUSPECT_COVERAGE = 0.40 on a DIFFERENT axis, so it was deleted
// rather than re-valued, and re-adding a constant nothing imports reds no behavioural test. Matched as a
// DECLARATION: the surviving constant's own doc names SUSPECT_AGREEMENT, so a substring scan fires on prose.
test('lyrics.ts no longer declares the retired SUSPECT_AGREEMENT', () => {
	const source = read('src/lib/contract/lyrics/lyrics.ts');
	expect(source).toMatch(/export const SUSPECT_COVERAGE\s*=/);
	expect(source).not.toMatch(/export const SUSPECT_AGREEMENT\s*=/);
});

// A WRONG-TEXT gate's verdict on the WORDS, sent by the worker only to withhold (W3 review r2). Its own
// field because `textConfidence` already answers a different question — where the text came from — and
// `lyricsSourceLabel` reads `captions` + `low` as "Auto captions", so carrying the doubt there mislabelled
// an uploader's hand-authored track as machine-generated.
test('vouched:false costs a candidate its authority without touching its provenance', () => {
	const doubted = cand('captions', 'word', { vouched: false });
	expect(isAuthoritativeText(doubted)).toBe(false);
	expect(lyricsRank(doubted)).toBe(3);
	expect(lyricsSourceLabel(doubted)).toBe('Captions');
	expect(isAuthoritativeText(cand('captions', 'word', { vouched: true }))).toBe(true);
	expect(isAuthoritativeText(cand('captions', 'word'))).toBe(true); // absent = vouched
});

test('parse: an absent vouched stays absent, an unreadable one fails safe to false', () => {
	const base = { ref: 'r', textSource: 'lrclib', timing: 'word', textConfidence: 'high', createdAt: 1 };
	const [old] = parseLyricsCandidates([base]);
	expect(old!.vouched).toBeUndefined();
	expect(isAuthoritativeText(old!)).toBe(true);
	const [withheld] = parseLyricsCandidates([{ ...base, vouched: false }]);
	expect(withheld!.vouched).toBe(false);
	const [nonsense] = parseLyricsCandidates([{ ...base, vouched: 'yes' }]);
	expect(nonsense!.vouched).toBe(false);
	const [kept] = parseLyricsCandidates([{ ...base, vouched: true }]);
	expect(kept!.vouched).toBe(true);
});
