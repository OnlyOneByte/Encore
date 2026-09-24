/**
 * The cross-language parity corpus for `agreement`. The two suites cannot import each other, so both read
 * this table and a drift on either side reds that side.
 *
 * EVERY EXPECTATION IS AN INTEGER `[numerator, denominator]` PAIR worked out BY HAND, never produced by
 * running either implementation, which could only prove that code self-consistent. Each side divides the pair
 * itself, so neither compares against a transcribed decimal. The vocabulary is plain lowercase ASCII, so
 * `lyricsTokens`' NFKC fold and punctuation strip are identities here and cannot muddy the counts.
 */

/** `[numerator, denominator]` of a hand-computed expectation, or `null` when not comparable. */
export type CountRatio = readonly [number, number] | null;

export interface AgreementParityCase {
	/** Quoted verbatim in both suites' failure messages. */
	readonly name: string;
	readonly candidate: string;
	readonly baseline: string;
	/** shared tokens (multiset) / baseline tokens. */
	readonly coverage: CountRatio;
	/** shared tokens (multiset) / candidate tokens. */
	readonly fidelity: CountRatio;
	/** shared adjacent pairs (multiset) / pairs of the LONGER side. */
	readonly sequence: CountRatio;
	/** Symmetric set Jaccard, for contrast with the directional metric. */
	readonly oldSetJaccard: CountRatio;
}

const TWELVE = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima';
/**
 * EVERY TOKEN MUST BE A NAMED CONST, never bare text in a template literal: the Python mirror resolves a
 * literal by joining its `${NAME}` interpolations and SILENTLY DROPS bare text, so inline it would compare a
 * 12-token string against a 13-token expectation and still pass, guarding nothing.
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
		// Same token SET, so set Jaccard scores a perfect 1; with multiplicity, 12 shared of 12 baseline
		// tokens but of 24 candidate ones. Pairs: 23 on the candidate, 11 on the baseline, 11 shared.
		name: 'candidate repeats the chorus, the audio has it once',
		candidate: `${TWELVE} ${TWELVE}`,
		baseline: TWELVE,
		coverage: [12, 12],
		fidelity: [12, 24],
		sequence: [11, 23],
		oldSetJaccard: [12, 12]
	},
	{
		// Every count agrees and not one adjacent pair survives. Coverage stays 1, because the same words ARE
		// the same song, while the ranking score loses the whole position term.
		name: 'identical words in reversed order',
		candidate: TWELVE,
		baseline: TWELVE_REVERSED,
		coverage: [12, 12],
		fidelity: [12, 12],
		sequence: [0, 11],
		oldSetJaccard: [12, 12]
	},
	{
		// THE CASE THAT TELLS A MULTISET FROM A SET, and the only one that can: the doubling above is
		// ONE-SIDED, so `min(2, 1)` equals distinct counting. Here BOTH sides repeat a token (13 tokens, 12
		// distinct), so multiset overlap reaches 13 where a set-based one caps at 12.
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
