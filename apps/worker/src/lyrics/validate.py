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

  small residuals            -> same recording; the fitted offset is a measured display offset, which
                                is a principled replacement for a hand-tuned lead constant
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
    return rep


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

    @property
    def trust_lrc_timing(self) -> bool:
        return self.verdict == "same_version"


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
