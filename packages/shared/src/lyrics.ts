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
// In @encore/shared because all three tiers touch it: the worker emits candidates (mirroring this
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
   */
  agreement?: number;
}

/**
 * Is this text trustworthy enough to show as the song's real words?
 *
 * ASR is never authoritative — it is a guess at sung words. Anything else is, UNLESS its text
 * confidence is `low`, which is how an auto-generated caption track gets correctly demoted to the
 * same standing as ASR despite arriving through the "captions" door.
 */
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
 *   4  authoritative text + word timings   ← the ideal
 *   3  authoritative text + line timings   ← the floor, and still preferred over 2
 *   2  unauthoritative text + word timings (ASR: label it)
 *   1  unauthoritative text + line timings
 *   0  no usable timing — nothing to sync against
 *
 * 3 OUTRANKS 2 deliberately. Wrong words are a FAILURE — you cannot sing them — whereas correct
 * words with coarse highlighting is the accepted minimum. A bouncing ball over invented lyrics looks
 * more finished and is worth less.
 */
export function lyricsRank(c: LyricsCandidate): number {
  if (!hasUsableTiming(c)) return 0;
  const authoritative = isAuthoritativeText(c);
  const word = c.timing === 'word';
  if (authoritative) return word ? 4 : 3;
  return word ? 2 : 1;
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
// runs on every cook, not only as a fallback.

/** Words, lowercased, punctuation stripped. Deliberately crude — this compares CONTENT, not form. */
export function lyricsTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ') // LRC timestamps / [Chorus] markers
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Fewer shared tokens than this and a comparison says nothing useful either way. */
export const MIN_TOKENS_TO_COMPARE = 12;

/** Below this, treat an authoritative lookup as probably the WRONG SONG. */
export const SUSPECT_AGREEMENT = 0.25;

/**
 * 0..1 similarity between two lyrics texts, or `null` when not comparable.
 *
 * Jaccard over token SETS, so order-insensitive on purpose: a repeated chorus, missing verse, or
 * reordered bridge should not read as disagreement, whereas a different song shares few words at all.
 *
 * Returns null — not 0 — when either side is too short (`MIN_TOKENS_TO_COMPARE`). An instrumental
 * transcribes to almost nothing, and scoring that as total disagreement would condemn a correct
 * lookup. "I cannot tell" and "these differ" must not be the same answer.
 */
export function agreementScore(a: string, b: string): number | null {
  const setA = new Set(lyricsTokens(a));
  const setB = new Set(lyricsTokens(b));
  if (setA.size < MIN_TOKENS_TO_COMPARE || setB.size < MIN_TOKENS_TO_COMPARE) return null;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  const union = setA.size + setB.size - shared;
  return union === 0 ? null : shared / union;
}

/**
 * Does the ASR transcript suggest this authoritative text is for a DIFFERENT song? `false` when the
 * comparison could not be made — an unknown must never be reported as a detected mismatch.
 */
export function isLikelyWrongSong(agreement: number | null | undefined): boolean {
  return typeof agreement === 'number' && agreement < SUSPECT_AGREEMENT;
}
