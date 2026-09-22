// Lyrics candidates — the model and the presentation ranking. PURE: no I/O, no ML.
//
// WHY A SET AND NOT ONE DOC. Text quality and timing fidelity are INDEPENDENT axes:
//
//   source                      text            timing it yields unaided
//   LRCLIB syncedLyrics (LRC)   authoritative   line-level (no ML, no audio at all)
//   LRCLIB plain / captions     good            none — needs forced alignment
//   ASR on the vocals stem      dubious         line-level (segment bounds only)
//
// MEASURED: whisper's transcribe() returns NO word timings — those come solely from the separate
// align() pass, so the aligner is the one source of word timings and upgrades any text (looked-up
// or transcribed) from line to word.
//
// The ideal artifact is authoritative text FORCE-ALIGNED to the audio, which needs both halves — so
// "pick the first source that hits" throws away most of the value. Keeping every candidate buys an
// upgrade path with no recompute: ASR lands first, and if LRCLIB later becomes reachable (or a human
// pastes text in) we re-align from the RETAINED audio — no re-download, no re-separation.
//
// In $lib/contract because all three tiers touch it: the worker emits candidates (mirroring this
// shape in JSON), the core stores them and picks `chosen`, the TV reads provenance to be honest
// about auto-transcribed words.

/** Where a candidate's TEXT came from. Timing provenance is tracked separately (`timing`). */
export type LyricsTextSource = 'lrclib' | 'captions' | 'asr' | 'manual';

/** Timing fidelity. `line` is the FLOOR (stanza scroll); `word` is the karaoke ideal. */
export type LyricsTiming = 'word' | 'line' | 'none';

export type LyricsConfidence = 'high' | 'medium' | 'low';

export interface LyricsCandidate {
	/** MediaStore key of this candidate's lyrics JSON. */
	ref: string;
	textSource: LyricsTextSource;
	timing: LyricsTiming;
	/**
	 * Confidence in the TEXT. Load-bearing beyond display: auto-generated YouTube captions are
	 * recorded `low` precisely because they are ASR wearing a caption's clothes, and that is what stops
	 * them being treated as authoritative (see `isAuthoritativeText`).
	 */
	textConfidence: LyricsConfidence;
	/** Confidence in the TIMINGS (an aligner can return word timings it isn't sure of). */
	timingConfidence?: LyricsConfidence;
	language?: string | null;
	createdAt: number;
	/**
	 * 0..1 agreement between this candidate's text and an ASR transcript of the same audio, when both
	 * exist. `undefined` = never compared or not comparable. See `agreementScore`.
	 *
	 * A RANKING axis only — it orders candidates against each other (`breaksTie`) and no threshold is
	 * applied to it. A correct candidate graded against a baseline that heard only part of the song
	 * scores low here by construction, so this number cannot answer "is this a different song?".
	 * That question reads `coverage`.
	 */
	agreement?: number;
	/**
	 * 0..1 BASELINE COVERAGE of the published winner — how much of what the baselines actually heard
	 * this text contains. `undefined` = never compared or not comparable. The worker emits it beside
	 * `agreement` for the graded candidate only (`Selection.winner_coverage`).
	 *
	 * The one axis the absolute wrong-song judgement may threshold, and the reason it is a separate
	 * field rather than a second use of `agreement`: coverage is immune to the size asymmetry between a
	 * full text and a partial transcript, so it separates "a different song" from "the baseline only
	 * heard a third of this one" where the ranking score cannot. See `isLikelyWrongSong`.
	 */
	coverage?: number;
}

/**
 * Is this text trustworthy enough to show as the song's real words?
 *
 * ASR is never authoritative — it is a guess at sung words. Anything else is, UNLESS its text
 * confidence is `low`, which is how an auto-generated caption track gets correctly demoted to the
 * same standing as ASR despite arriving through the "captions" door.
 */
/**
 * A short, honest provenance label for a candidate's TEXT — "the same distinction the TV overlay draws
 * (authored words vs an auto-transcribed guess), so a singer picks with the same information".
 *
 * MOVED HERE FROM `LyricsReselect` (2026-09-21), where it was a private function, because it now has two
 * readers: that component's option list, and the now-playing sheet, which shows the CHOSEN candidate's
 * label as a pill instead of carrying a whole re-selection disclosure. Two copies of a provenance string
 * is how the sheet ends up calling something "Captions" that the song page calls "Auto captions".
 *
 * Pure, in the contract, for the reason the rest of this file is: all three tiers touch lyrics provenance.
 */
export function lyricsSourceLabel(c: Pick<LyricsCandidate, 'textSource' | 'textConfidence'>): string {
	if (c.textSource === 'lrclib') return 'Synced lyrics';
	if (c.textSource === 'captions') return c.textConfidence === 'low' ? 'Auto captions' : 'Captions';
	if (c.textSource === 'asr') return 'Auto-transcribed';
	if (c.textSource === 'manual') return 'Your lyrics';
	return c.textSource;
}

export function isAuthoritativeText(c: Pick<LyricsCandidate, 'textSource' | 'textConfidence'>): boolean {
	return c.textSource !== 'asr' && c.textConfidence !== 'low';
}

/** Does this candidate carry timings good enough to sync anything at all? */
export function hasUsableTiming(c: LyricsCandidate): boolean {
	return c.timing === 'word' || c.timing === 'line';
}

/**
 * Presentation rank — HIGHER IS BETTER, 0 means "do not show this".
 *
 *   5  authoritative text + word timings   ← the ideal
 *   4  authoritative text + line timings   ← the floor for real words, still preferred over 3
 *   3  unauthoritative text + word timings (a baseline: label it)
 *   2  unauthoritative text + line timings
 *   1  text positively identified as ANOTHER SONG, whatever its timings
 *   0  no usable timing — nothing to sync against
 *
 * 4 OUTRANKS 3 deliberately. Wrong words are a FAILURE — you cannot sing them — whereas correct
 * words with coarse highlighting is the accepted minimum. A bouncing ball over invented lyrics looks
 * more finished and is worth less.
 *
 * TIER 1 IS THE ONE THAT IS EASY TO GET WRONG. A candidate whose BASELINE COVERAGE is below
 * SUSPECT_COVERAGE has been measured against transcripts of this actual audio and found to be missing
 * most of what was sung — a different song.
 * It reads `coverage`, NOT `agreement`. Thresholding the ranking score instead convicts a CORRECT
 * candidate whose baseline heard only part of the song — the repo's normal case, since YouTube's ASR
 * suppresses sung vocals — and then the ASR baseline wins `pickBestLyrics` while the correct words sit
 * unshown beside it. `agreement` stays a preference axis inside `breaksTie`, which is ranking
 * and is its correct use.
 * Demoting its `textConfidence` alone is NOT enough: that only drops it to the same rank as the
 * baseline it was measured against, and `breaksTie` then PREFERS it, because it carries a numeric
 * agreement while a baseline carries none (a baseline is the ruler, so it has no score). The room
 * would keep seeing words already proven wrong while the words actually heard sat unshown beside
 * them. Ranking a suspect text below every honest guess is what makes publishing that baseline
 * alongside it worth anything.
 */
export function lyricsRank(c: LyricsCandidate): number {
	if (!hasUsableTiming(c)) return 0;
	if (isLikelyWrongSong(c.coverage)) return 1;
	const authoritative = isAuthoritativeText(c);
	const word = c.timing === 'word';
	if (authoritative) return word ? 5 : 4;
	return word ? 3 : 2;
}

/**
 * The candidate the TV should show, or null when nothing is showable.
 *
 * Returning null is a real outcome, not a failure to handle: with no usable timing the honest screen
 * says so rather than rendering a blank overlay or a wall of unsynced text. Ties break via `breaksTie`.
 */
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

/** Is `c` preferable to `incumbent` at EQUAL rank? Confidence, then agreement, then recency —
 *  a re-run at equal rank is presumed an improvement (better model, corrected text), so preferring
 *  the older one would make re-alignment pointless. */
function breaksTie(c: LyricsCandidate, incumbent: LyricsCandidate): boolean {
	const conf = CONF_ORDER[c.timingConfidence ?? 'medium'] - CONF_ORDER[incumbent.timingConfidence ?? 'medium'];
	if (conf !== 0) return conf > 0;
	const agree = (c.agreement ?? -1) - (incumbent.agreement ?? -1);
	if (agree !== 0) return agree > 0;
	return c.createdAt > incumbent.createdAt;
}

/**
 * Merge a new candidate into a stored set, keyed by `ref` (re-running a job overwrites its own
 * artifact rather than stacking duplicates).
 *
 * NEVER-REGRESS: a property of keeping everything, not of any check here. Adding a candidate can only
 * improve or preserve what `pickBestLyrics` returns, because nothing is ever removed — so a
 * line-level source arriving late cannot displace existing word timings, which a naive "latest wins"
 * write would have done.
 */
export function mergeLyricsCandidate(
	existing: readonly LyricsCandidate[],
	incoming: LyricsCandidate
): LyricsCandidate[] {
	const out = existing.filter((c) => c.ref !== incoming.ref);
	out.push(incoming);
	return out;
}

// ── ASR agreement: catching a confidently WRONG lookup ────────────────────────────
//
// LRCLIB's dangerous failure is not a miss but a confident MISMATCH: fuzzy metadata returns another
// song's lyrics and nothing downstream would notice. Comparing authoritative text against an ASR
// transcript of what is actually being sung is our only same-song signal — a large part of why ASR
// runs on every process, not only as a fallback.

/** Words, lowercased, punctuation stripped. Deliberately crude — this compares CONTENT, not form. */
export function lyricsTokens(text: string): string[] {
	return text
		.normalize('NFKC') // fold form-variants (full/half-width, composed/decomposed) so they tokenise alike; mirrors the Python side
		.toLowerCase()
		.replace(/\[[^\]]*\]/g, ' ') // LRC timestamps / [Chorus] markers
		.replace(/[^\p{L}\p{N}\s']/gu, ' ')
		.split(/\s+/)
		.filter(Boolean);
}

/** Fewer distinct tokens than this on either side and a comparison says nothing useful either way. */
export const MIN_TOKENS_TO_COMPARE = 12;

/**
 * Below this BASELINE COVERAGE, treat an authoritative lookup as probably the WRONG SONG.
 *
 * Replaces `SUSPECT_AGREEMENT = 0.25`. Both the metric and the axis changed, so the constant is
 * renamed rather than re-valued — a same-named threshold on a different scale is a trap.
 *
 * Coverage, not the ranking score, because only coverage is immune to the size asymmetry a partial
 * baseline creates, and a partial baseline is the normal case: ASR suppresses sung vocals. Measured
 * band (synthetic corpus, reproducible from `worker/tests/test_lyrics_agreement_542.py`):
 * different song tops out at 0.300, a correct candidate bottoms out at 0.468 against an already-unusable
 * 50%-word-error baseline, and 0.485 against a baseline that heard only a third of the song. 0.40 sits
 * in that gap. Not a corpus calibration — a real corpus from the prod snapshot is still open.
 */
export const SUSPECT_COVERAGE = 0.4;

/**
 * Weight of the POSITION-aware term in the ranking score. Equal weight with the count-aware
 * term; any other split would be a coefficient nobody has measured. Ranking is threshold-free, so this
 * steers a comparison and cannot by itself accept or reject anything.
 */
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

/**
 * Every neighbouring token pair, in order — the position-aware view of a token sequence.
 *
 * Adjacent pairs rather than a whole-sequence alignment: LCS/difflib is O(n·m) on texts of thousands of
 * tokens, re-run per candidate × baseline inside selection, and difflib's ratio is not reproducible
 * across languages (its autojunk heuristic silently drops frequent tokens in long sequences). `\u0000`
 * joins the pair because no token can contain it — `lyricsTokens` keeps only letters, digits and `'`.
 */
function adjacentPairs(tokens: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 1; i < tokens.length; i++) out.push(`${tokens[i - 1]}\u0000${tokens[i]}`);
	return out;
}

/** One candidate compared against one baseline, kept as THREE numbers instead of an average. */
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
 * Compare a CANDIDATE against a BASELINE, or `null` when the comparison says nothing.
 *
 * The directional split is the point. Symmetric Jaccard averaged the two directions into one
 * number and destroyed the fingerprint of "right song, WRONG version" — near-complete coverage of the
 * audible words while a large part of the candidate is not audible at all (measured on the real reported
 * mis-pick: coverage 0.857, fidelity 0.485, and a symmetric 0.448 that sailed past the old 0.25).
 *
 * ARGUMENT ORDER IS LOAD-BEARING and was not before: swapping the arguments swaps coverage and fidelity.
 *
 * `null` — not 0 — when either side has fewer than `MIN_TOKENS_TO_COMPARE` distinct tokens. An
 * instrumental transcribes to almost nothing, and scoring that as total disagreement would condemn a
 * correct lookup. "I cannot tell" and "these differ" must not be the same answer.
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
	// Same expression, same order as chain.py's Agreement.rank_score: every intermediate is an integer
	// count, so both languages produce bit-identical doubles for identical input.
	const rankScore = (1 - SEQUENCE_WEIGHT) * Math.min(coverage, fidelity) + SEQUENCE_WEIGHT * sequence;
	return { coverage, fidelity, sequence, rankScore };
}

/**
 * The 0..1 ranking score for one candidate against one baseline, or `null` when not comparable.
 *
 * Count- and position-aware; it was symmetric Jaccard over token SETS. Selection ranks by
 * this and applies no threshold to it; the absolute wrong-song judgement reads `coverage` instead.
 */
export function agreementScore(candidate: string, baseline: string): number | null {
	return agreement(candidate, baseline)?.rankScore ?? null;
}

/**
 * Does the baseline suggest this authoritative text is for a DIFFERENT song? `false` when the
 * comparison could not be made — an unknown must never be reported as a detected mismatch.
 *
 * Takes BASELINE COVERAGE (`Agreement.coverage`, the wire's `LyricsCandidate.coverage`, or the
 * persisted `SelectionRecord.winnerCoverage` — all three are `Selection.winner_coverage`), not the
 * ranking score: a correct candidate graded against a baseline that heard only part of the song has a
 * low rank score by construction, and thresholding that demotes correct lyrics for a defect in the
 * evidence.
 */
export function isLikelyWrongSong(coverage: number | null | undefined): boolean {
	return typeof coverage === 'number' && coverage < SUSPECT_COVERAGE;
}
