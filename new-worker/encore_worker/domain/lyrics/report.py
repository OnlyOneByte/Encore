"""What is wrong with one aligned document, measured — and the thresholds that judge it.

Every number here was already computed by the old worker and then thrown away: its `TimingReport`
carried coverage, overshoot, out-of-order counts, gaps, smears and flashes, noted them to a log, and
acted on exactly one (`out_of_order`, to degrade word timing to line timing). Nothing re-aligned.

This module is the measurement only. `policy.py` decides what to DO about it, and keeping those apart is
what makes the decision a table-driven unit test instead of an integration test.
"""

from __future__ import annotations

from dataclasses import dataclass, field

#: A silence longer than this between consecutive words is a gap worth reporting. Not a fault on its
#: own: instrumental breaks are real, and a karaoke screen showing nothing during one is correct.
LONG_GAP_SEC = 12.0

#: A single word held longer than this is SMEARED — the aligner spread one token over a phrase.
MAX_WORD_SEC = 3.0

#: A word shorter than this FLASHES: on screen too briefly to read.
MIN_WORD_SEC = 0.03

#: Timing should cover at least this much of the audio. Below it, something is probably wrong — but see
#: `thin_coverage`, which is deliberately not a disqualification.
MIN_COVERAGE = 0.80

#: Residual offset, after placement, above which an LRC looks like it was written for a DIFFERENT master
#: of this song. This is the signal that most directly explains "the lyrics are out of sync".
SUSPECT_RESIDUAL_SEC = 2.0

#: How far past the end of the audio a text's own timings may run, as a fraction of duration. Past this
#: the text is describing a longer recording than the one in hand — the "song ends mid-lyrics" case.
OVERSHOOT_FRACTION_MAX = 0.10


@dataclass(frozen=True, slots=True)
class TimingReport:
    """One aligned document, measured against the audio it claims to describe."""

    words: int = 0
    #: Fraction of the audio's duration the timed words span, clamped to 1.0.
    coverage: float = 0.0
    #: Seconds by which the last word runs PAST the end of the audio. Carried separately because
    #: `coverage`'s clamp reports a text timed for a longer master as a flawless 1.0 and discards this.
    overshoot_sec: float = 0.0
    #: Words whose start precedes the previous word's start. The one defect that makes word timing
    #: unpublishable rather than merely poor.
    out_of_order: int = 0
    #: Residual offset after placement, when the text brought its own line timings. `None` when the
    #: question does not apply (an ASR text is already measured on this audio) or no baseline could speak.
    residual_sec: float | None = None
    long_gaps: tuple[tuple[float, float], ...] = ()
    smeared: tuple[tuple[str, float], ...] = ()
    flashed: tuple[tuple[str, float], ...] = ()
    #: The audio's duration, so every fraction above is interpretable without the caller's context.
    duration_sec: float = 0.0
    notes: tuple[str, ...] = field(default=())

    @property
    def usable(self) -> bool:
        """Is this publishable as WORD timing at all?

        ONLY order violations disqualify, and the reasoning is worth keeping: a highlight that jumps
        backwards is incoherent, and line sync is strictly better than incoherent. Everything else is a
        defect rather than a disqualification —

          * thin coverage is usually CORRECT (an instrumental break genuinely has no words), and if a
            transcription only covered the first third, the timing for that third is still right;
            refusing would publish nothing, which is worse than what it prevents.
          * a handful of smeared or flashed words beats losing per-word timing everywhere.

        So `usable` is a floor, not a quality bar. `policy.decide` is what asks whether a usable doc is
        nevertheless worth one more attempt with a different parameter.
        """
        return self.out_of_order == 0 and self.words > 0

    @property
    def thin_coverage(self) -> bool:
        """Timing stops well before the song does. A prompt to look, not a diagnosis."""
        return 0.0 < self.coverage < MIN_COVERAGE

    @property
    def overshoots(self) -> bool:
        """Do this text's own timings run materially past the end of the audio?

        Fractional, not absolute: three seconds over on a 90-second clip is a different claim than
        three seconds over on a ten-minute one.
        """
        if self.duration_sec <= 0 or self.overshoot_sec <= 0:
            return False
        return (self.overshoot_sec / self.duration_sec) > OVERSHOOT_FRACTION_MAX

    @property
    def misplaced(self) -> bool:
        """Does the text look like it was written for a different master of this song?"""
        return self.residual_sec is not None and abs(self.residual_sec) > SUSPECT_RESIDUAL_SEC

    def summary(self) -> str:
        """One line for the operator, and for the `job:state` frame's `why`."""
        bits = [f"{self.words} words", f"coverage {self.coverage:.0%}"]
        if self.overshoot_sec > 0:
            bits.append(f"OVERSHOOT +{self.overshoot_sec:.0f}s past audio-end")
        if self.out_of_order:
            bits.append(f"{self.out_of_order} OUT OF ORDER")
        if self.residual_sec is not None and abs(self.residual_sec) > 0.01:
            bits.append(f"residual {self.residual_sec:+.2f}s")
        if self.long_gaps:
            worst = max(end - start for start, end in self.long_gaps)
            bits.append(f"{len(self.long_gaps)} gap(s) >{LONG_GAP_SEC:g}s (worst {worst:.0f}s)")
        if self.smeared:
            word, held = self.smeared[0]
            bits.append(f"{len(self.smeared)} smeared (worst {word!r} {held:.1f}s)")
        if self.flashed:
            bits.append(f"{len(self.flashed)} flashed <{MIN_WORD_SEC * 1000:.0f}ms")
        return " · ".join(bits)
