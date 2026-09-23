"""Validate ALIGNED lyrics before they reach a TV, and use an LRC's line timing as a GUIDE.

Two jobs, one module, because they answer the same question from opposite ends: is this timing good
enough to put a bouncing ball on?

`is_valid_lyrics` only asks whether SOME word carries a timestamp — real artifacts have passed that
check while containing a multi-second hole mid-song, a word smeared across seconds, or function words
collapsed to milliseconds, none of it detectable downstream without this module's checks.

THE LRC IS A GUIDE, NOT AN ANCHOR: LRCLIB matches on artist/track/duration with tolerance, and one
song can have several uploads at different lengths (a live cut, remaster, or lyric video with a
different intro or tempo), so an LRC's ABSOLUTE timestamps may belong to a recording that was not
separated. Constraining word search to those line windows would place words confidently wrong.

What survives a version difference is the RELATIVE structure: line order, the ratio of gaps between
lines under a constant offset, and where long instrumental breaks sit. So the LRC is fitted to the
aligner's output as a two-parameter (offset, scale) model and the RESIDUALS are read:

  small residuals            -> same recording; keep the aligner's timing (it is what gets published
                                and is right for THIS audio). The fitted offset is reported only as a
                                diagnostic, never applied as a display lead.
  large systematic residual  -> different version; keep the aligner's timing and DISCARD the LRC's
  fine except one region     -> that region is where alignment failed
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from .model import LyricsDoc, lyrics_tokens

# Each threshold below is a shape a real artifact exhibited, not a guess.

#: A gap this long between consecutive words is either an instrumental break (fine) or a region the
#: aligner lost (not fine). Flagged for a human/log, never fatal — a real song has real breaks.
LONG_GAP_SEC = 12.0

#: One word cannot plausibly hold this long. Measured worst case on the mix was 5.7s.
MAX_WORD_SEC = 3.0

#: Below this a word cannot be seen — it flashes. Measured: "a" at 20ms.
MIN_WORD_SEC = 0.03

#: Coverage below this is worth a look. NOT a fault threshold: instrumental breaks and outros
#: legitimately carry no words, and measured artifacts sit at 87-96% coverage for that reason alone.
#: Tuned to pass those while still surfacing a genuine media/duration mismatch (measured at 64%).
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
    #: Seconds the lyrics run PAST the end of the audio. Coverage's `min(1.0, …)` clamp would report a
    #: candidate timed for a longer master (a wrong-version pick) as a flawless 1.0; this carries that
    #: discarded signal as its own number, so coverage's thin/MIN_COVERAGE meaning stays untouched.
    overshoot_sec: float = 0.0

    @property
    def usable(self) -> bool:
        """Is this publishable as WORD timing?

        Only ORDER violations disqualify: a highlight that jumps backwards is incoherent, and line
        sync is strictly better than that.

        Thin coverage does NOT disqualify: if ASR only transcribed the first third of a song, the
        timing for that third is still correct, and refusing would publish nothing, worse than what
        it prevents (the line-sync alternative over the same partial text freezes in the same place).
        Coverage is reported loudly instead, since it diagnoses a TRANSCRIPTION gap, not an alignment
        fault.

        Smears and flashes are likewise defects, not disqualifications: a handful of bad words beats
        losing per-word timing everywhere.
        """
        return self.out_of_order == 0 and self.words > 0

    @property
    def thin_coverage(self) -> bool:
        """Timing stops well before the song does. A PROMPT TO LOOK, not a fault: a shortfall is
        usually correct (an instrumental break or long outro genuinely has no words). It stays
        reported because the one genuinely broken case looks identical from here: an artifact aligned
        against a DIFFERENT upload than the duration on record.
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
    """Every timed word in document order.

    The doc's SHAPE is `model.LyricsDoc`'s business, not this module's: `validate.py` owns
    judgements about timing QUALITY only.
    """
    return LyricsDoc(doc).timed_words()


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
            bits.append(f"{len(self.flashed_uncorrectable)} flash(es) left — no room before the next word")
        return " · ".join(bits)


def repair_word_spans(doc: dict[str, Any]) -> RepairReport:
    """ACT on the smears and flashes validate_timing only reports.

    Two transforms, both provably order-preserving so a repair can never manufacture the one
    genuinely disqualifying defect (an out-of-order word -> backwards highlight):

      SMEAR (dur > MAX_WORD_SEC): clamp `end` DOWN to `start + MAX_WORD_SEC`. This only SHRINKS the
        span, so it cannot reach into the next word; the reclaimed time becomes a dark gap, which
        reads far better than a word lit wrongly for seconds.

      FLASH (dur < MIN_WORD_SEC): extend `end` UP toward `start + MIN_WORD_SEC`, but ONLY when the
        extended end does not reach the next word's start. When there is no room, the flash is LEFT
        and reported: a flash beats a backwards jump. Extending never moves `start`.

    Mutates the word dicts in place and returns what it changed.
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

    Scale absorbs a tempo difference between masters; offset absorbs a different intro length. What
    is left over is either alignment error or a genuinely different arrangement, decided by whether
    the residual is spread out (error) or concentrated (one bad region).

    THE ESTIMATOR IS THEIL-SEN, NOT LEAST SQUARES, and that is load-bearing: least squares lets a
    single badly-aligned line drag the fitted offset far enough to inflate EVERY residual past the
    threshold and misreport a matching recording as the wrong version. Theil-Sen takes the median of
    pairwise slopes, so a minority of outliers cannot move the line they are outliers from.
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


# The wrong-version check above (`lrc_fit_notes`) runs AFTER alignment, which is not enough on its
# own: the aligner is confined to the LRC's own line windows, so an upload whose vocal starts LATER
# than the LRC's master (an added intro, a talk-over) is aligned against the wrong span and publishes
# confident, EARLY word times. The post-align fit cannot see it either — it would compare the
# aligner's output against the very windows that bounded that aligner, a self-comparison that
# manufactures the agreement it reports.
#
# The fix: estimate the LRC->audio offset from a series the LRC did NOT bound — the Whisper baselines
# `AcquireTexts` measured on THIS audio — and shift the LRC's line windows onto this recording BEFORE
# handing them to the aligner. Reuses the Theil-Sen `fit_lrc_to_aligned`, but pairs lines by fuzzy
# token overlap first (not position/exact-text), since a Whisper baseline neither has the LRC's line
# count nor echoes its text exactly.


@dataclass
class LrcShift:
    """The estimated placement of an LRC onto THIS audio's timeline, from a baseline the LRC did not bound.

    `applied` is the gate the step reads: only a confident, non-trivial shift is worth moving the
    aligner's search windows for. An unmeasurable shift (too few paired lines, a degenerate baseline)
    leaves `offset_sec == 0.0`, `applied == False`, so the fix is a no-op on a song already placed.
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

    A baseline is Whisper's guess at what is audible, so exact-text and positional pairing both miss
    it. Walks the LRC lines in order, taking the forward-most baseline line whose token-set Jaccard is
    best AND clears `_MIN_PAIR_JACCARD`. Matching is monotonic — the baseline cursor only advances —
    so a repeated chorus line cannot pair backwards onto an earlier occurrence. Lines with no
    confident match contribute nothing: the fit needs agreement, not coverage.

    Returns (lrc_starts, baseline_starts), equal length, in LRC order.
    """
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


def estimate_lrc_shift(lrc_lines: list[dict[str, Any]], baseline_lines: list[dict[str, Any]]) -> LrcShift:
    """Estimate how far the LRC sits from THIS audio, from a baseline measured on this audio.

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
    mutates in place). A no-op shift (`applied == False`) returns copies with identical numbers, so the
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


# `TimeTexts.run` delegates the LRC-fit decision here so it stays reachable from `tests/test_lyrics_*`
# and under the layering guard, leaving the step as align -> validate -> note -> write.
def _opening_window_indices(windows: list[dict], segments: list[dict]) -> list[int]:
    """Indices into `windows` of the window that OPENS each human line.

    `align_windows` is a flat list where each human `segment` contributes one or more windows: the
    opening window of a line keeps the line's own `start` exactly, while every interior window start
    is a char-count guess. Walk the segments in order and take, for each, the next window whose
    `start` equals that segment's start. Matching is strict-in-order: `si` advances only on a match,
    so if a segment's opening window is ever absent, every later segment is dropped from the result
    too — currently UNREACHABLE since every producer of a segment/window start rounds to 3 decimals,
    so the opening window always matches exactly. The drop-tolerance that matters for the version fit
    lives in `_pair_openings_to_aligned`, which re-derives the surviving pairs by TEXT instead.
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

    The wrong-version fit needs two time series over the SAME human lines. The obvious pairing —
    `line_starts(doc)[k]` for each opening index `k` — is WRONG: `normalize_lyrics` DROPS a segment
    with neither timed words nor bounds, so `doc["lines"][k]` is not guaranteed to be the aligned
    result of `windows[k]`, and one dropped line shifts every later positional pairing.

    So recover which window each SURVIVING aligned line came from, rather than trusting position: the
    aligner emits one line per window in order, and `normalize_lyrics` only DROPS, never reorders. Walk
    the full window stream and the aligned lines in LOCKSTEP, matching on stripped text and advancing
    both together — this correctly assigns even repeated-text openings, since the distinct interior
    windows between them keep the two cursors in sync. A window whose aligned line was dropped simply
    has no match at its turn and is left unpaired. Then keep only the OPENING windows, both series
    built together so they can never diverge in length.
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

    Only meaningful for a source that brought its OWN line timings and was then force-aligned: that
    gives two independent time series over the same lines. The caller (``TimeTexts.run``) guards that
    condition and computes ``windows``/``opens``, so this function stays pure of ``ctx`` and the step
    layer. Returns note strings rather than calling ``ctx.note`` itself, preserving the layering
    direction: the domain package never reaches into ``steps/``.
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
        # Report the fitted (offset, scale) as DIAGNOSTIC only — published timings are the
        # aligner's, not shifted by these. Outliers, when present, are lines where ALIGNMENT
        # slipped: a different and much more actionable fault than a wrong LRC.
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
