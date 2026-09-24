// The candidate model and the presentation ranking. PURE: no I/O, no ML. All three tiers touch it, so the
// worker emits this exact shape as JSON. Rules: docs/SERVER.md#lyrics-candidates-and-grading.

/** Where a candidate's TEXT came from. Timing provenance is tracked separately (`timing`). */
export type LyricsTextSource = 'lrclib' | 'captions' | 'asr' | 'manual';

/** Timing fidelity. `line` is the FLOOR (stanza scroll); `word` is the karaoke ideal. */
export type LyricsTiming = 'word' | 'line' | 'none';

export type LyricsConfidence = 'high' | 'medium' | 'low';

export interface LyricsCandidate {
	ref: string;
	textSource: LyricsTextSource;
	timing: LyricsTiming;
	/** Load-bearing beyond display: auto captions are recorded `low` because they are ASR wearing a
	 *  caption's clothes, which is what stops them ranking as authoritative. */
	textConfidence: LyricsConfidence;
	/** Confidence in the TIMINGS (an aligner can return word timings it isn't sure of). */
	timingConfidence?: LyricsConfidence;
	language?: string | null;
	createdAt: number;
	/** 0..1 agreement against a transcript of the same audio; `undefined` = not comparable. A RANKING axis ONLY,
	 *  with no threshold applied to it: a baseline that heard only part of the song scores a correct text low,
	 *  so the wrong-song question reads `coverage`. See docs/SERVER.md#lyrics-candidates-and-grading. */
	agreement?: number;
	/** 0..1 BASELINE COVERAGE — how much of what the baselines heard this text contains. THE ONE axis the
	 *  absolute wrong-song judgement may threshold (`isLikelyWrongSong`), because it is immune to the size
	 *  asymmetry a partial transcript creates. See docs/SERVER.md#lyrics-candidates-and-grading. */
	coverage?: number;
}

/** THE ONE definition, shared by every surface: a second copy is how one screen says "Captions" where
 *  another says "Auto captions". */
export function lyricsSourceLabel(c: Pick<LyricsCandidate, 'textSource' | 'textConfidence'>): string {
	if (c.textSource === 'lrclib') return 'Synced lyrics';
	if (c.textSource === 'captions') return c.textConfidence === 'low' ? 'Auto captions' : 'Captions';
	if (c.textSource === 'asr') return 'Auto-transcribed';
	if (c.textSource === 'manual') return 'Your lyrics';
	return c.textSource;
}

/** ASR never is; anything else is unless its confidence is `low`, which demotes an auto-caption track to
 *  ASR's standing. */
export function isAuthoritativeText(c: Pick<LyricsCandidate, 'textSource' | 'textConfidence'>): boolean {
	return c.textSource !== 'asr' && c.textConfidence !== 'low';
}

/** Does this candidate carry timings good enough to sync anything at all? */
export function hasUsableTiming(c: LyricsCandidate): boolean {
	return c.timing === 'word' || c.timing === 'line';
}

/**
 * HIGHER IS BETTER, 0 means "do not show this". 5 = authoritative + word, 4 = authoritative + line,
 * 3 = unauthoritative + word, 2 = unauthoritative + line, 1 = identified as ANOTHER SONG, 0 = no usable
 * timing. 4 outranks 3 because wrong words are a FAILURE you cannot sing.
 *
 * TIER 1 reads `coverage` and NOT `agreement` — thresholding the ranking axis convicts a CORRECT text
 * graded against a partial baseline — and needs a dedicated bottom rung rather than a confidence
 * demotion. `agreement` keeps its legitimate use in `breaksTie`.
 */
export function lyricsRank(c: LyricsCandidate): number {
	if (!hasUsableTiming(c)) return 0;
	if (isLikelyWrongSong(c.coverage)) return 1;
	const authoritative = isAuthoritativeText(c);
	const word = c.timing === 'word';
	if (authoritative) return word ? 5 : 4;
	return word ? 3 : 2;
}

/** Null when nothing is showable — a REAL outcome, not an unhandled case. */
export function pickBestLyrics(candidates: readonly LyricsCandidate[]): LyricsCandidate | null {
	let best: LyricsCandidate | null = null;
	let bestRank = 0;
	for (const c of candidates) {
		const rank = lyricsRank(c);
		if (rank === 0) continue;
		if (!best || rank > bestRank || (rank === bestRank && breaksTie(c, best))) {
			best = c;
			bestRank = rank;
		}
	}
	return best;
}

const CONF_ORDER: Record<LyricsConfidence, number> = { low: 0, medium: 1, high: 2 };

/** Confidence, then agreement, then RECENCY: a re-run at equal rank is presumed an improvement, so
 *  preferring the older one would make re-alignment pointless. */
function breaksTie(c: LyricsCandidate, incumbent: LyricsCandidate): boolean {
	const conf = CONF_ORDER[c.timingConfidence ?? 'medium'] - CONF_ORDER[incumbent.timingConfidence ?? 'medium'];
	if (conf !== 0) return conf > 0;
	const agree = (c.agreement ?? -1) - (incumbent.agreement ?? -1);
	if (agree !== 0) return agree > 0;
	return c.createdAt > incumbent.createdAt;
}

/** Keyed by `ref`, so a re-run overwrites its own artifact rather than stacking duplicates. NEVER-REGRESS
 *  is a property of keeping everything and of NO check here — see docs/SERVER.md#lyrics-candidates-and-grading. */
export function mergeLyricsCandidate(
	existing: readonly LyricsCandidate[],
	incoming: LyricsCandidate
): LyricsCandidate[] {
	const out = existing.filter((c) => c.ref !== incoming.ref);
	out.push(incoming);
	return out;
}

// A provider's dangerous failure is a confident MISMATCH, not a miss, and a transcript of what is actually
// sung is the only same-song signal — which is most of why ASR runs on every process, not just as a fallback.

/** Words, lowercased, punctuation stripped. Deliberately crude — this compares CONTENT, not form. */
export function lyricsTokens(text: string): string[] {
	return text
		.normalize('NFKC') // fold form-variants so they tokenise alike; MUST mirror the Python side
		.toLowerCase()
		.replace(/\[[^\]]*\]/g, ' ') // LRC timestamps / [Chorus] markers
		.replace(/[^\p{L}\p{N}\s']/gu, ' ')
		.split(/\s+/)
		.filter(Boolean);
}

/** Fewer distinct tokens than this on either side and a comparison says nothing useful either way. */
export const MIN_TOKENS_TO_COMPARE = 12;

/** Re-pointing this name at a different metric is a trap — rename the constant instead.
 *  See docs/SERVER.md#lyrics-candidates-and-grading. */
export const SUSPECT_COVERAGE = 0.4;

/** EQUAL with the count-aware term, because any other split is a coefficient nobody has measured. */
export const SEQUENCE_WEIGHT = 0.5;

/** Σ min(count in a, count in b) — the shared token count WITH multiplicity. */
function multisetOverlap(a: readonly string[], b: readonly string[]): number {
	const counts = new Map<string, number>();
	for (const t of b) counts.set(t, (counts.get(t) ?? 0) + 1);
	const seen = new Map<string, number>();
	for (const t of a) seen.set(t, (seen.get(t) ?? 0) + 1);
	let shared = 0;
	for (const [t, n] of seen) shared += Math.min(n, counts.get(t) ?? 0);
	return shared;
}

/** Adjacent pairs rather than a whole-sequence alignment, which is quadratic and not reproducible across
 *  languages. `\u0000` joins them because `lyricsTokens` keeps only letters, digits and `'`. */
function adjacentPairs(tokens: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 1; i < tokens.length; i++) out.push(`${tokens[i - 1]}\u0000${tokens[i]}`);
	return out;
}

/** THREE numbers rather than an average — see docs/SERVER.md#lyrics-candidates-and-grading. */
export interface Agreement {
	/** |C ∩ B| / |B|, multiset — how much of what IS audible the candidate carries. The JUDGE axis. */
	coverage: number;
	/** |C ∩ B| / |C|, multiset — how much of the candidate is actually audible. */
	fidelity: number;
	/** The same overlap over ADJACENT PAIRS, weaker direction — word ORDER, not just counts. */
	sequence: number;
	/** The single number selection ranks by. Not a threshold axis — see `SUSPECT_COVERAGE`. */
	rankScore: number;
}

/**
 * ARGUMENT ORDER IS LOAD-BEARING — swapping it swaps coverage and fidelity — and `null` rather than 0 below
 * the token floor is what keeps "I cannot tell" distinct from "these differ".
 */
export function agreement(candidate: string, baseline: string): Agreement | null {
	const tokensC = lyricsTokens(candidate);
	const tokensB = lyricsTokens(baseline);
	if (new Set(tokensC).size < MIN_TOKENS_TO_COMPARE || new Set(tokensB).size < MIN_TOKENS_TO_COMPARE) return null;
	const shared = multisetOverlap(tokensC, tokensB);
	const pairsC = adjacentPairs(tokensC);
	const pairsB = adjacentPairs(tokensB);
	const sharedPairs = multisetOverlap(pairsC, pairsB);
	const sequence =
		pairsC.length > 0 && pairsB.length > 0 ? Math.min(sharedPairs / pairsB.length, sharedPairs / pairsC.length) : 0;
	const coverage = shared / tokensB.length;
	const fidelity = shared / tokensC.length;
	// The expression AND operand order MUST match the worker's `rank_score`, so both languages produce
	// bit-identical doubles.
	const rankScore = (1 - SEQUENCE_WEIGHT) * Math.min(coverage, fidelity) + SEQUENCE_WEIGHT * sequence;
	return { coverage, fidelity, sequence, rankScore };
}

/** `null` when not comparable. Selection RANKS by this and thresholds it never. */
export function agreementScore(candidate: string, baseline: string): number | null {
	return agreement(candidate, baseline)?.rankScore ?? null;
}

/** Does the baseline suggest this authoritative text is for a DIFFERENT song? `false` when the comparison
 *  could not be made, since an unknown must never read as a detected mismatch. Takes BASELINE COVERAGE and
 *  never the ranking score; its carriers are `LyricsCandidate.coverage` and `SelectionRecord.winnerCoverage`,
 *  both real fields. See docs/SERVER.md#lyrics-candidates-and-grading. */
export function isLikelyWrongSong(coverage: number | null | undefined): boolean {
	return typeof coverage === 'number' && coverage < SUSPECT_COVERAGE;
}
