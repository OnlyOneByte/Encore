/**
 * The cross-language parity corpus for `agreement`.
 *
 * WHY IT EXISTS. `agreement` / `agreementScore` / `SUSPECT_COVERAGE` are implemented TWICE — here in
 * TypeScript (the authority) and in `worker/src/lyrics/chain.py` (a hand-kept mirror). Duplicated
 * vocabulary with no parity guard is the defect class this repo keeps filing, and the two suites cannot
 * import each other. So both read THIS table: the TS suite in `lyrics.test.ts`, the Python suite in
 * `worker/tests/test_lyrics_agreement_542.py`, which source-scans this file rather than importing
 * it. A drift on EITHER side reds that side's suite against the same numbers.
 *
 * WHY THE EXPECTATIONS ARE INTEGER PAIRS. Every field is `[numerator, denominator]` — the raw counts,
 * worked out BY HAND from the token sequences below, not produced by running either implementation.
 * That is the point: an expectation computed by the code under test cannot detect that the code is
 * wrong, only that it is consistent with itself. Each side divides the pair itself, so both compare
 * against the same exact double without a transcribed decimal literal to get wrong.
 *
 * A `null` field means the comparison is not made at all (below `MIN_TOKENS_TO_COMPARE`).
 *
 * The token vocabulary is the NATO alphabet — no real lyrics, and every token is plain lowercase ASCII,
 * so `lyricsTokens`' NFKC fold and punctuation strip are identities here and cannot muddy the counts.
 */

/** `[numerator, denominator]` of a hand-computed expectation, or `null` when not comparable. */
export type CountRatio = readonly [number, number] | null;

export interface AgreementParityCase {
	/** What the pair is a case OF — quoted verbatim in both suites' failure messages. */
	readonly name: string;
	readonly candidate: string;
	readonly baseline: string;
	/** shared tokens (multiset) / baseline tokens. */
	readonly coverage: CountRatio;
	/** shared tokens (multiset) / candidate tokens. */
	readonly fidelity: CountRatio;
	/** shared adjacent pairs (multiset) / adjacent pairs of the LONGER side. */
	readonly sequence: CountRatio;
	/** What symmetric set Jaccard — the metric an earlier change replaced — scored this pair. For contrast only. */
	readonly oldSetJaccard: CountRatio;
}

const TWELVE = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima';
/**
 * A single repeated token, kept as its OWN const rather than written inline as `` `alpha ${TWELVE}` ``.
 * The Python side does not evaluate TypeScript: its parser resolves a template literal by collecting the
 * `${NAME}` interpolations and joining them with a space, so bare text inside the backticks is dropped.
 * Written inline, the mirror would compare a 12-token string against a 13-token expectation — and because
 * every ratio in the repeated-token case below is exactly 1, it would pass anyway while guarding nothing.
 */
const ALPHA = 'alpha';
const ELEVEN = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo';
const TWELVE_REVERSED = 'lima kilo juliett india hotel golf foxtrot echo delta charlie bravo alpha';
const TWELVE_LAST_SWAPPED = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo mike';

export const AGREEMENT_PARITY_CORPUS: readonly AgreementParityCase[] = [
	{
		// 12 tokens each, 11 shared; 11 adjacent pairs each, 10 shared (only the final pair differs).
		name: 'one token swapped at the end',
		candidate: TWELVE,
		baseline: TWELVE_LAST_SWAPPED,
		coverage: [11, 12],
		fidelity: [11, 12],
		sequence: [10, 11],
		oldSetJaccard: [11, 13] // 11 shared of a 13-token union
	},
	{
		// THE CASE SET JACCARD COULD NOT SEE. The candidate says the chorus twice, the audio has it once.
		// Same token SET, so old Jaccard scored a perfect 1.0. Counting multiplicity: 12 shared of 12
		// baseline tokens (coverage 1) but of 24 candidate tokens (fidelity 1/2). Pairs: the candidate
		// has 23 (11 forward pairs twice, plus the lima→alpha seam), the baseline 11, 11 shared.
		name: 'candidate repeats the chorus, the audio has it once',
		candidate: `${TWELVE} ${TWELVE}`,
		baseline: TWELVE,
		coverage: [12, 12],
		fidelity: [12, 24],
		sequence: [11, 23],
		oldSetJaccard: [12, 12]
	},
	{
		// THE OTHER CASE SET JACCARD COULD NOT SEE. Identical words, reversed order: every count agrees
		// and not one adjacent pair survives. Coverage stays 1 — the same words ARE the same song, so
		// the absolute judgement must not fire — while the ranking score loses the whole position term.
		name: 'identical words in reversed order',
		candidate: TWELVE,
		baseline: TWELVE_REVERSED,
		coverage: [12, 12],
		fidelity: [12, 12],
		sequence: [0, 11],
		oldSetJaccard: [12, 12]
	},
	{
		// THE CASE THAT TELLS A MULTISET FROM A SET. Every other row is blind to the difference: the
		// doubling in "repeats the chorus" is ONE-SIDED, so `min(2, 1)` per token equals distinct
		// counting and a set-based overlap scores it identically. Distinguishing the two needs a token
		// repeated on BOTH sides. Here each side is `alpha` followed by the twelve — 13 tokens, `alpha`
		// twice, 12 distinct — so multiset overlap is 13 (min(2,2) for `alpha`, plus 11 singletons) and
		// coverage is 13/13 = 1, while a set-based overlap can only ever reach the 12 DISTINCT tokens and
		// scores 12/13. The pairs are all distinct, so the position term stays 12/12 either way.
		name: 'a token repeated on both sides, which only multiplicity can count',
		candidate: `${ALPHA} ${TWELVE}`,
		baseline: `${ALPHA} ${TWELVE}`,
		coverage: [13, 13],
		fidelity: [13, 13],
		sequence: [12, 12],
		oldSetJaccard: [12, 12] // the old metric saw 12 distinct of a 12-token union, and still scored 1
	},
	{
		// 11 distinct tokens is below MIN_TOKENS_TO_COMPARE, so the answer is "cannot tell", not "differ".
		name: 'too few distinct tokens to judge with',
		candidate: ELEVEN,
		baseline: TWELVE,
		coverage: null,
		fidelity: null,
		sequence: null,
		oldSetJaccard: null
	}
];
