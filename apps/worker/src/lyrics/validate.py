"""Validate ALIGNED lyrics before they reach a TV, and use an LRC's line timing as a GUIDE.

Two jobs, one module, because they answer the same question from opposite ends: is this timing good
enough to put a bouncing ball on?

WHY VALIDATION AT ALL. `is_valid_lyrics` only asks whether SOME word carries a timestamp. Six real
artifacts on the reference box passed that check while containing a 63-second hole mid-song, a single
word smeared across 5.7 seconds, and function words collapsed to 20ms. All three are visible on screen
and none of them was detectable downstream.

WHY THE LRC IS A GUIDE AND NOT AN ANCHOR. Ruled 2026-09-04. LRCLIB matches on artist/track/duration
with tolerance, and this library holds many uploads of the same song at different lengths (five "Take
On Me (Lyrics)" rows at 226-227s; two "Zombie Song" rows at 172s and 254s). A live cut, a remaster or a
lyric video has a different intro length and sometimes a different master tempo, so an LRC's ABSOLUTE
timestamps may belong to a recording we did not separate. Constraining word search to those line
windows would place words confidently wrong, and would fail worst on exactly the live/remaster uploads
people pick out of search.

What survives a version difference is the RELATIVE structure: line order always, the ratio of gaps
between lines under a constant offset, and where the long instrumental breaks sit. So the LRC is fitted
to the aligner's output as a two-parameter (offset, scale) model and the RESIDUALS are read:

  small residuals            -> same recording; keep the aligner's timing (it is what gets published,
                                and it is right for THIS audio). The fitted offset only quantifies how
                                far the LRC was shifted from that timing; it is reported as a
                                diagnostic, NOT applied as a display lead. It cannot be: the offset is
                                only measurable when alignment succeeded, and that is exactly the case
                                whose published timings come from the aligner, not the LRC.
  large systematic residual  -> different version; keep the aligner's timing and DISCARD the LRC's
  fine except one region     -> that region is where alignment failed
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

# ── validation thresholds ────────────────────────────────────────────────────────────────────────
# Each is a shape a real artifact exhibited, not a guess.

#: A gap this long between consecutive words is either an instrumental break (fine) or a region the
#: aligner lost (not fine). Flagged for a human/log, never fatal — a real song has real breaks.
LONG_GAP_SEC = 12.0

#: One word cannot plausibly hold this long. Measured worst case on the mix was 5.7s.
MAX_WORD_SEC = 3.0

#: Below this a word cannot be seen — it flashes. Measured: "a" at 20ms.
MIN_WORD_SEC = 0.03

#: Coverage below this is worth a look. NOT a fault threshold: instrumental breaks and outros legitimately
#: carry no words, and measured artifacts sit at 87-96% for that reason alone. Tuned to pass those and
#: still surface the 64% case, which turned out to be a media/duration mismatch rather than bad timing.
MIN_COVERAGE = 0.80

#: Residual above this means the LRC is timed against a different recording.
SUSPECT_RESIDUAL_SEC = 2.0


@dataclass
class TimingReport:
    """What is wrong with one aligned document, in the vocabulary of the defects that occur."""

    words: int = 0
    coverage: float = 0.0
    long_gaps: list[tuple[float, float]] = field(default_factory=list)
    smeared: list[tuple[str, float]] = field(default_factory=list)
    flashed: list[tuple[str, float]] = field(default_factory=list)
    out_of_order: int = 0
    #: Seconds the lyrics run PAST the end of the audio. A one-sided metric coverage cannot carry: the
    #: `min(1.0, …)` clamp below makes coverage report a candidate timed for a longer master (a
    #: wrong-version pick) as a flawless 1.0. This is that discarded signal, kept as its own number so
    #: coverage's thin/MIN_COVERAGE meaning is untouched — they answer different questions (#667).
    overshoot_sec: float = 0.0

    @property
    def usable(self) -> bool:
        """Is this publishable as WORD timing?

        Only ORDER violations disqualify, because they are the one defect with no better alternative:
        a highlight that jumps backwards is incoherent, and line sync is strictly better than that.

        Thin coverage does NOT disqualify, and an earlier version of this that refused on coverage was
        wrong — it dropped the ASR candidate entirely and published nothing, which is worse than what it
        prevented. If ASR only transcribed the first third of a song, the timing for that third is still
        correct, and the alternative (line sync over the same partial text) freezes in exactly the same
        place. Coverage is reported loudly instead, because it diagnoses a TRANSCRIPTION gap, not an
        alignment fault.

        Smears and flashes are likewise defects, not disqualifications: the rest of the song is timed
        correctly and a handful of bad words beats losing per-word timing everywhere.
        """
        return self.out_of_order == 0 and self.words > 0

    @property
    def thin_coverage(self) -> bool:
        """Timing stops well before the song does. A PROMPT TO LOOK, not a fault.

        Measured on real songs, a shortfall is usually correct: an instrumental break or a long outro
        genuinely contains no words. Take On Me's synth break has its vocals stem 18-28 dB below the
        instrumental, and two independent Whisper models given only that clip both transcribe nothing.
        The coarse reading that called this an "ASR gap" was wrong, and was reached by averaging energy
        across a window that mixed a sung passage with a break.

        It stays reported because the one genuinely broken case looks identical from here: an artifact
        aligned against a DIFFERENT upload than the duration on record (observed: timings ending at
        164s against a row claiming 254s — 64% coverage).
        """
        return 0.0 < self.coverage < MIN_COVERAGE

    def summary(self) -> str:
        bits = [f"{self.words} words", f"coverage {self.coverage:.0%}"]
        if self.overshoot_sec > 0:
            bits.append(f"OVERSHOOT +{self.overshoot_sec:.0f}s past audio-end")
        if self.out_of_order:
            bits.append(f"{self.out_of_order} OUT OF ORDER")
        if self.long_gaps:
            worst = max(g[1] - g[0] for g in self.long_gaps)
            bits.append(f"{len(self.long_gaps)} gap(s) >{LONG_GAP_SEC:g}s (worst {worst:.0f}s)")
        if self.smeared:
            bits.append(
                f"{len(self.smeared)} smeared (worst '{self.smeared[0][0]}' {self.smeared[0][1]:.1f}s)"
            )
        if self.flashed:
            bits.append(f"{len(self.flashed)} flashed <{MIN_WORD_SEC * 1000:.0f}ms")
        return " · ".join(bits)


def _words_of(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """Every timed word in document order. Tolerates both the doc shapes in play."""
    out: list[dict[str, Any]] = []
    for line in doc.get("lines") or doc.get("segments") or []:
        for w in line.get("words") or []:
            if isinstance(w.get("start"), (int, float)) and isinstance(w.get("end"), (int, float)):
                out.append(w)
    return out


def validate_timing(doc: dict[str, Any], duration_sec: float | None) -> TimingReport:
    """Measure the defects that actually occur in aligner output.

    `duration_sec` is the song length; without it coverage cannot be judged and is reported as 1.0
    rather than failing the document — a missing duration is our gap, not the alignment's.
    """
    words = _words_of(doc)
    rep = TimingReport(words=len(words))
    if not words:
        return rep

    prev_end = None
    for w in words:
        start, end = float(w["start"]), float(w["end"])
        dur = end - start
        if prev_end is not None:
            if start < prev_end - 1e-6:
                rep.out_of_order += 1
            elif start - prev_end > LONG_GAP_SEC:
                rep.long_gaps.append((prev_end, start))
        if dur > MAX_WORD_SEC:
            rep.smeared.append((str(w.get("word", "?")).strip(), dur))
        elif dur < MIN_WORD_SEC:
            rep.flashed.append((str(w.get("word", "?")).strip(), dur))
        prev_end = max(prev_end or 0.0, end)

    rep.smeared.sort(key=lambda t: -t[1])
    last_end = max(float(w["end"]) for w in words)
    rep.coverage = 1.0 if not duration_sec or duration_sec <= 0 else min(1.0, last_end / duration_sec)
    # Coverage is clamped and one-sided; overshoot is the OTHER side, kept separate. When the song
    # length is unknown we cannot judge it, so it stays 0.0 (same policy coverage uses).
    rep.overshoot_sec = 0.0 if not duration_sec or duration_sec <= 0 else max(0.0, last_end - duration_sec)
    return rep


@dataclass
class RepairReport:
    """What repair_word_spans actually changed, so the caller can note it honestly."""

    #: (word, original_dur) for each smeared word whose end was clamped down to MAX_WORD_SEC.
    smeared_clamped: list[tuple[str, float]] = field(default_factory=list)
    #: (word, original_dur) for each flashed word whose end was extended up toward MIN_WORD_SEC.
    flashed_extended: list[tuple[str, float]] = field(default_factory=list)
    #: (word, original_dur) for flashed words left alone because extending them would have collided
    #: with the next word's start — a flash beats an out-of-order jump, so those are reported, not fixed.
    flashed_uncorrectable: list[tuple[str, float]] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.smeared_clamped or self.flashed_extended)

    def summary(self) -> str:
        bits: list[str] = []
        if self.smeared_clamped:
            worst = self.smeared_clamped[0]
            bits.append(
                f"{len(self.smeared_clamped)} smear(s) clamped to {MAX_WORD_SEC:g}s "
                f"(worst '{worst[0]}' was {worst[1]:.1f}s)"
            )
        if self.flashed_extended:
            bits.append(f"{len(self.flashed_extended)} flash(es) extended to {MIN_WORD_SEC * 1000:.0f}ms")
        if self.flashed_uncorrectable:
            bits.append(
                f"{len(self.flashed_uncorrectable)} flash(es) left — no room before the next word"
            )
        return " · ".join(bits)


def repair_word_spans(doc: dict[str, Any]) -> RepairReport:
    """ACT on the smears and flashes validate_timing only reports (issue #629, item #2).

    validate_timing DIAGNOSES; this REPAIRS, and the split is deliberate — the note stays honest about
    what the aligner produced, and this records what was done about it. Two transforms, both provably
    order-preserving so a repair can never manufacture the one defect that is genuinely disqualifying
    (an out-of-order word → backwards highlight):

      SMEAR (dur > MAX_WORD_SEC): a word cannot plausibly be held 3+ seconds; the measured worst was one
        word smeared across 5.7s. Clamp its `end` DOWN to `start + MAX_WORD_SEC`. This only ever SHRINKS
        the span, so it cannot reach into the next word (whose start already sat at or after the smear's
        original, longer end); the reclaimed time becomes a dark gap, which reads far better than a word
        lit wrongly for seconds. Non-smeared words are untouched.

      FLASH (dur < MIN_WORD_SEC): a ~20ms word is invisible. Extend its `end` UP toward
        `start + MIN_WORD_SEC`, but ONLY when the extended end does not reach the next word's start
        (`new_end <= next_start`). When there is no room, the flash is LEFT and reported: a flash beats a
        backwards jump. Extending never moves `start`, so it cannot reorder either.

    Mutates the word dicts in place and returns what it changed. Operates on the same word list
    validate_timing walks (`_words_of`), in document order, so `next_start` is well defined.
    """
    report = RepairReport()
    words = _words_of(doc)
    for i, w in enumerate(words):
        start, end = float(w["start"]), float(w["end"])
        dur = end - start
        name = str(w.get("word", "?")).strip()
        if dur > MAX_WORD_SEC:
            w["end"] = start + MAX_WORD_SEC
            report.smeared_clamped.append((name, dur))
        elif dur < MIN_WORD_SEC:
            next_start = float(words[i + 1]["start"]) if i + 1 < len(words) else None
            target = start + MIN_WORD_SEC
            if next_start is None or target <= next_start + 1e-9:
                w["end"] = target
                report.flashed_extended.append((name, dur))
            else:
                report.flashed_uncorrectable.append((name, dur))
    report.smeared_clamped.sort(key=lambda t: -t[1])
    return report


# ── the LRC as a guide ───────────────────────────────────────────────────────────────────────────


@dataclass
class LrcFit:
    """A two-parameter fit of an LRC's line starts onto the aligner's, plus what the residuals say."""

    offset_sec: float = 0.0
    scale: float = 1.0
    residual_sec: float = 0.0
    pairs: int = 0
    #: same_version | different_version | inconclusive
    verdict: str = "inconclusive"
    #: Aligned line indices whose residual is an outlier while the rest fit — where alignment failed.
    outlier_lines: list[int] = field(default_factory=list)


def fit_lrc_to_aligned(lrc_starts: Iterable[float], aligned_starts: Iterable[float]) -> LrcFit:
    """Fit `aligned ≈ scale * lrc + offset` ROBUSTLY, then read the residuals.

    Pairs positionally, which is what makes this version-safe: line ORDER survives a different
    recording even when absolute timestamps do not. Requires equal counts — a differing line count
    means the two texts are not the same lyrics and no fit is meaningful.

    Scale absorbs a tempo difference between masters; offset absorbs a different intro length. What is
    left over is either alignment error or a genuinely different arrangement, and the caller decides
    which by looking at whether the residual is spread out (error) or concentrated (one bad region).

    THE ESTIMATOR IS THEIL-SEN, NOT LEAST SQUARES, and that is load-bearing. Least squares was tried
    first and failed its own test: a single line landing 55s late (one alignment failure in an
    otherwise perfect song) dragged the fitted offset to 7.9s, which inflated EVERY residual past the
    threshold and reported a matching recording as the wrong version — the exact misdiagnosis this
    module exists to prevent. Theil-Sen takes the median of pairwise slopes, so a minority of outliers
    cannot move the line they are outliers from. O(n²) in line count (~50-70 lines, a few thousand
    pairs) which is nothing next to the alignment that produced the input.
    """
    xs = [float(x) for x in lrc_starts]
    ys = [float(y) for y in aligned_starts]
    fit = LrcFit(pairs=min(len(xs), len(ys)))
    if len(xs) != len(ys) or len(xs) < 3:
        return fit  # inconclusive: not the same lyrics, or too few lines to fit two parameters

    slopes = [
        (ys[j] - ys[i]) / (xs[j] - xs[i])
        for i in range(len(xs))
        for j in range(i + 1, len(xs))
        if abs(xs[j] - xs[i]) > 1e-9
    ]
    if not slopes:
        return fit  # every LRC line at the same timestamp — degenerate, cannot fit
    fit.scale = _median(slopes)
    fit.offset_sec = _median([y - fit.scale * x for x, y in zip(xs, ys, strict=False)])

    resid = [y - (fit.scale * x + fit.offset_sec) for x, y in zip(xs, ys, strict=False)]
    # MEDIAN, not mean: one badly-aligned region must not decide the verdict for the whole song. That
    # is the difference between "this LRC is the wrong version" and "alignment failed in the bridge".
    fit.residual_sec = _median([abs(r) for r in resid])
    fit.verdict = "same_version" if fit.residual_sec <= SUSPECT_RESIDUAL_SEC else "different_version"
    if fit.verdict == "same_version":
        fit.outlier_lines = [
            i for i, r in enumerate(resid) if abs(r) > max(SUSPECT_RESIDUAL_SEC, 3 * fit.residual_sec)
        ]
    return fit


def _median(values: list[float]) -> float:
    s = sorted(values)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2.0


def line_starts(doc: dict[str, Any]) -> list[float]:
    """Line start times from either doc shape, for feeding the fit."""
    lines = doc.get("lines") or doc.get("segments") or []
    return [float(ln["start"]) for ln in lines if isinstance(ln.get("start"), (int, float))]


# ── placing the LRC on THIS audio's timeline, BEFORE it is aligned (#794) ───────────────────────────
#
# The wrong-version check above (`lrc_fit_notes`) runs AFTER alignment, and #794 showed why that is not
# enough on its own: the aligner is confined to the LRC's own line windows (`steps/lyrics.py` hands it
# `align_windows`/`segments`, and `whisperx.align` crops the audio per segment), so an upload whose
# vocal starts LATER than the LRC's master — an added intro, a talk-over, `bad guy`'s quiet whispered
# pre-section — is aligned against the wrong span and publishes confident, EARLY word times. The
# post-align fit cannot see it, because it compares the aligner's output against the very windows that
# bounded that aligner: a self-comparison that manufactures the agreement it reports.
#
# Owner ruling 2026 (issue #794, Q1-A): estimate the LRC→audio offset from a series the LRC did NOT
# bound — the Whisper baselines `AcquireTexts` measured on THIS audio (the vocals stem and the mix) —
# and shift the LRC's line windows onto this recording BEFORE handing them to the aligner. Then the
# aligner searches the right span, and the post-align fit stops being a self-comparison.
#
# The estimator reuses the Theil-Sen `fit_lrc_to_aligned` (offset absorbs the intro difference, scale a
# tempo difference, and a minority of mis-paired lines cannot drag the fit). What it CANNOT reuse is the
# positional/exact-text pairing the post-align fit uses: a baseline is Whisper's own segmentation of
# GUESSED words on this audio, so it neither has the LRC's line count nor echoes its text. So a fuzzy
# token-overlap pairing runs first, matching each LRC line to the baseline line it best overlaps.


@dataclass
class LrcShift:
    """The estimated placement of an LRC onto THIS audio's timeline, from a baseline the LRC did not bound.

    `applied` is the gate the step reads: only a confident, non-trivial shift is worth moving the
    aligner's search windows for. A shift the estimator could not measure (too few paired lines, a
    degenerate baseline) leaves `offset_sec == 0.0`, `applied == False` and the windows untouched, so
    the fix can only ever HELP the mis-placed case and is a no-op on every song that was already placed.
    """

    offset_sec: float = 0.0
    scale: float = 1.0
    pairs: int = 0
    applied: bool = False


#: A |offset| below this is noise, not a real intro difference — do not perturb windows that were fine.
#: `bad guy`'s reported pre-section is "a couple of seconds", well above this.
MIN_SHIFT_SEC = 0.35

#: The fuzzy pairing keeps an LRC↔baseline line pair only when their token overlap (Jaccard) clears
#: this. High enough that a chorus line does not pair with an unrelated verse; low enough to survive
#: Whisper mishearing a few words in a line it did roughly transcribe.
_MIN_PAIR_JACCARD = 0.5

#: Fewer surviving pairs than this cannot fit two parameters robustly — abstain (`applied == False`).
_MIN_SHIFT_PAIRS = 3


def _pair_lrc_to_baseline(
    lrc_lines: list[dict[str, Any]], baseline_lines: list[dict[str, Any]]
) -> tuple[list[float], list[float]]:
    """Pair each LRC line's start against the baseline line it best overlaps, by TOKEN content.

    A baseline is Whisper's guess at what is audible, so exact-text and positional pairing (what the
    post-align fit uses) both miss it. This walks the LRC lines in order, and for each takes the
    forward-most baseline line whose token-set Jaccard is the best AND clears `_MIN_PAIR_JACCARD`.
    Matching is monotonic — the baseline cursor only advances — so line order is preserved and a
    repeated chorus line cannot pair backwards onto an earlier occurrence. Lines with no confident
    baseline match contribute nothing (they are just not in the returned series), which is correct:
    the fit needs agreement, not coverage.

    Returns (lrc_starts, baseline_starts), equal length, in LRC order — the two time series the fit
    consumes. Imported lazily so the layering guard sees `validate` depend on its sibling `chain`, not
    the reverse.
    """
    from .chain import lyrics_tokens

    base_tokens = [set(lyrics_tokens(str(bl.get("text") or ""))) for bl in baseline_lines]
    base_starts = [bl.get("start") for bl in baseline_lines]

    lrc_out: list[float] = []
    base_out: list[float] = []
    bi = 0  # monotonic baseline cursor: preserves order, blocks a backward chorus match
    for ln in lrc_lines:
        ls = ln.get("start")
        if not isinstance(ls, (int, float)):
            continue
        lt = set(lyrics_tokens(str(ln.get("text") or "")))
        if not lt:
            continue
        best_j, best_score = -1, 0.0
        for j in range(bi, len(baseline_lines)):
            bt = base_tokens[j]
            if not bt:
                continue
            inter = len(lt & bt)
            if not inter:
                continue
            score = inter / len(lt | bt)  # Jaccard over token SETS
            if score > best_score:
                best_j, best_score = j, score
        if best_j >= 0 and best_score >= _MIN_PAIR_JACCARD:
            bstart = base_starts[best_j]
            if isinstance(bstart, (int, float)):
                lrc_out.append(float(ls))
                base_out.append(float(bstart))
                bi = best_j + 1
    return lrc_out, base_out


def estimate_lrc_shift(
    lrc_lines: list[dict[str, Any]], baseline_lines: list[dict[str, Any]]
) -> LrcShift:
    """Estimate how far the LRC sits from THIS audio, from a baseline measured on this audio (#794).

    `lrc_lines` are the source's own timed lines ({start, text, ...}); `baseline_lines` are a Whisper
    baseline's segments ({start, text, ...}) measured on the real audio. Fuzzy-pair them by content,
    fit `baseline ≈ scale * lrc + offset` with the same robust Theil-Sen estimator the post-align check
    uses, and return the shift to apply to the LRC's windows before alignment.

    `applied` is True only when the fit is trustworthy (≥ `_MIN_SHIFT_PAIRS` paired lines) AND the
    offset is worth acting on (|offset| ≥ `MIN_SHIFT_SEC`). Otherwise it is a no-op shift — no baseline,
    a degenerate baseline, or a song already correctly placed all leave the windows untouched.
    """
    lrc_starts, base_starts = _pair_lrc_to_baseline(lrc_lines, baseline_lines)
    if len(lrc_starts) < _MIN_SHIFT_PAIRS:
        return LrcShift(pairs=len(lrc_starts))
    fit = fit_lrc_to_aligned(lrc_starts, base_starts)
    applied = fit.pairs >= _MIN_SHIFT_PAIRS and abs(fit.offset_sec) >= MIN_SHIFT_SEC
    return LrcShift(offset_sec=fit.offset_sec, scale=fit.scale, pairs=fit.pairs, applied=applied)


def shift_segments(segments: list[dict[str, Any]], shift: LrcShift) -> list[dict[str, Any]]:
    """Apply an LrcShift to a list of {start, end, ...} windows, returning NEW dicts (the source's own
    `segments` must stay un-shifted for the line-sync fallback that publishes them, so this never
    mutates in place). A window's start/end map as `scale * t + offset` — the exact model the fit
    solved — so a stretched master is corrected as well as a shifted one. Non-numeric bounds pass
    through untouched. A no-op shift (`applied == False`) returns copies with identical numbers, so the
    caller can shift unconditionally and let `applied` decide whether it mattered."""
    if not shift.applied:
        return [dict(s) for s in segments]
    out: list[dict[str, Any]] = []
    for s in segments:
        moved = dict(s)
        for key in ("start", "end"):
            v = s.get(key)
            if isinstance(v, (int, float)):
                moved[key] = round(shift.scale * float(v) + shift.offset_sec, 3)
        out.append(moved)
    return out


# ── the LRC-fit decision, moved out of steps/lyrics.py (#456) ──────────────────────────────────────
#
# `TimeTexts.run` used to hold ~45 lines deciding one domain question — does a source's OWN line
# timing fit THIS recording — even though its two other halves (`fit_lrc_to_aligned`, `line_starts`)
# already live here. The audit (#456) moved the decision and its two pure pairing helpers into the
# domain package so the whole thing is reachable from `tests/test_lyrics_*` and sits under the
# layering guard, leaving `TimeTexts.run` as align → validate → note → write. Behaviour is unchanged:
# `lrc_fit_notes` returns exactly the note strings the step used to build inline, and the step still
# owns computing `windows`/`opens` (via `_opens_for`, whose emitted-map preference is pinned in the
# step layer by #459) and emitting the notes through `ctx.note`.
def _opening_window_indices(windows: list[dict], segments: list[dict]) -> list[int]:
    """Indices into `windows` of the window that OPENS each human line.

    `align_windows` is a flat list where each human `segment` contributes one or more windows: the
    first (opening) window of a line keeps the line's own `start` (`_subdivide` sets its first piece's
    `lo` to the segment start exactly), while every interior window start is a char-count guess. Walk
    the segments in order and take, for each, the next window whose `start` equals that segment's
    start — that is the one window per line carrying a real source timestamp. Returns one index per
    matched segment. Matching is strict-in-order: `si` advances only on a match, so if a segment's
    opening window is ever absent, the search for it consumes the rest of the windows and every later
    segment is dropped from the result too. That degenerate path is currently UNREACHABLE — every
    producer of a segment/window start rounds to 3 decimals (`presplit._subdivide`, `source._stamp_to_sec`
    / `entries_to_segments` / `plain_lyrics_to_segments`, `captions._cue_seconds`) so the opening window
    of each line is always present and matches exactly — hence it is left as-is. The drop-tolerance that
    matters for the version fit lives in `_pair_openings_to_aligned`, which re-derives the surviving
    pairs by TEXT rather than trusting this index.
    """
    opens: list[int] = []
    si = 0
    for k, win in enumerate(windows):
        if si >= len(segments):
            break
        ss = segments[si].get("start")
        ws = win.get("start")
        if (
            isinstance(ss, (int, float))
            and isinstance(ws, (int, float))
            and abs(float(ws) - float(ss)) < 1e-6
        ):
            opens.append(k)
            si += 1
    return opens


def _pair_openings_to_aligned(
    windows: list[dict], opens: list[int], doc: dict
) -> tuple[list[float], list[float]]:
    """Pair each opening window's source start against the aligned line it produced, drop-tolerant.

    The wrong-version fit needs two time series over the SAME human lines: the source's own line
    starts (the opening windows) and where the aligner placed those lines. The obvious pairing —
    `line_starts(doc)[k]` for each opening index `k` — is WRONG, because `doc` is `normalize_lyrics`
    output and that function DROPS a segment with neither timed words nor bounds (`artifact.py`), so
    `doc["lines"][k]` is not guaranteed to be the aligned result of `windows[k]`. One dropped line
    shifts every later positional pairing: a correctly aligned song then reads as slipped (#336) or,
    once counts diverge, the check goes silently inert on a genuinely different master (#217).

    So recover which window each SURVIVING aligned line came from, rather than trusting position. The
    aligner emits one line per window it was given, in order, and `normalize_lyrics` preserves that
    order — it only DROPS. So walk the full window stream and the aligned lines in LOCKSTEP, matching
    on stripped text, and advance both together. This assigns each surviving aligned line to its
    window even when several openings share the same text ("a very long line…" repeated), because the
    distinct interior windows between them keep the two cursors in sync — text alone is not unique, but
    text-in-order over the whole stream is. A window whose aligned line was dropped simply has no match
    at its turn and is left unpaired. Then keep only the OPENING windows (the ones carrying a real
    source timestamp): their source start and their recovered aligned start, one entry each, both
    series built together so they can never diverge in length.
    """
    aligned = [
        (str(ln.get("text", "")).strip(), float(ln["start"]))
        for ln in (doc.get("lines") or [])
        if isinstance(ln, dict) and isinstance(ln.get("start"), (int, float))
    ]
    opens_set = set(opens)
    lrc_starts: list[float] = []
    aligned_starts: list[float] = []
    ai = 0
    for k, win in enumerate(windows):
        if ai >= len(aligned):
            break
        wtext = str(win.get("text", "")).strip()
        if aligned[ai][0] != wtext:
            continue  # this window's aligned line was dropped by normalize_lyrics — skip, don't consume
        wstart = win.get("start")
        if k in opens_set and isinstance(wstart, (int, float)):
            lrc_starts.append(float(wstart))
            aligned_starts.append(aligned[ai][1])
        ai += 1
    return lrc_starts, aligned_starts


def lrc_fit_notes(text_source: str, windows: list[dict], opens: list[int], doc: dict[str, Any]) -> list[str]:
    """Decide whether a source's own line timing fits this recording, and return the operator note(s).

    Only meaningful for a source that brought its OWN line timings (a synced LRCLIB record) and was
    then force-aligned: that gives two independent time series over the same lines, which is exactly
    what the fit needs. The caller (``TimeTexts.run``) guards that condition and computes ``windows`` /
    ``opens`` — the OPENING window index of each human line — so this function stays pure of ``ctx``,
    the step layer, and the ``_opens_for`` emitted-map preference (pinned in the step layer by #459).

    Returns a list of note strings (0 or 1 today) rather than calling ``ctx.note`` itself, so the
    layering direction is preserved: the domain package never reaches into ``steps/``.

    The pairing is drop-tolerant and keyed by text, not position — see ``_pair_openings_to_aligned``
    for why (a dropped ``normalize_lyrics`` line would otherwise shift every later positional pair,
    re-opening #336 and #217).
    """
    lrc_starts, aligned_starts = _pair_openings_to_aligned(windows, opens, doc)
    fit = fit_lrc_to_aligned(lrc_starts, aligned_starts)
    if fit.verdict == "different_version":
        return [
            f"{text_source}: its own line timings do NOT fit this recording "
            f"(median residual {fit.residual_sec:.1f}s over {fit.pairs} lines) — likely a "
            "different release. Published timings come from the aligner, so they are right "
            "for this audio; the WORDS may belong to another version."
        ]
    if fit.verdict == "same_version":
        # same_version, so the LRC does match. Report the fitted (offset, scale): the offset
        # is how far the LRC sits from the aligner timing we actually publish, and the scale
        # is the master-tempo ratio. Both are DIAGNOSTIC only — the published timings are the
        # aligner's and are not shifted by these — but they were computed here and are worth
        # seeing in the log rather than discarded. Outliers, when present, are the lines where
        # ALIGNMENT slipped: a different and much more actionable fault than a wrong LRC.
        fit_note = (
            f"{text_source}: matches this recording "
            f"(fitted offset {fit.offset_sec:+.2f}s, scale {fit.scale:.3f} over {fit.pairs} "
            "lines; diagnostic only — published timings are the aligner's)"
        )
        if fit.outlier_lines:
            fit_note += (
                f". Alignment slipped on {len(fit.outlier_lines)} line(s) (index {fit.outlier_lines[:5]})"
            )
        return [fit_note]
    return []
