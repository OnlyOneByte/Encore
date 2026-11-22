"""What is wrong with one aligned document, measured — and the thresholds that judge it.

The measurement only: `policy.py` decides what to DO about it, and keeping those apart is what makes the
decision a table-driven unit test instead of an integration test (docs/arch/04-alignment.md §3).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import MISSING, dataclass, field, fields
from enum import StrEnum
from typing import Any

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


class Engine(StrEnum):
    """What produced a document's timings — and therefore which knobs could change them.

    ON THE REPORT because `policy.decide` sees only the report, and the regression it exists for was a knob
    offered to an engine that does not read it (docs/arch/04-alignment.md §3).
    """

    #: `generate` over one emission matrix of the whole song, reading no knob but LINE_SYNC
    #: (`policy._READS`; docs/arch/04-alignment.md §3).
    GLOBAL = "global"
    #: whisperx's windowed aligner, cropped to the text's (placed) spans. The capability path, for an
    #: aligner with no emission matrix; every knob applies to it.
    WINDOWED = "windowed"
    #: No engine ran: the text's OWN line timings, placed onto this recording's clock (`Knob.LINE_SYNC`).
    #: Judged on its line spans, because it has no words to judge (review M1).
    LINE_SYNC = "line-sync"


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
    #: What produced the timings. GLOBAL by default because it is THE path; the windowed aligner and
    #: line sync declare themselves (`measure.measure(..., engine=)`).
    engine: Engine = Engine.GLOBAL
    #: Lines carrying a usable timing — a timed word (word engines) or a line start (LINE_SYNC). What a
    #: line-synced document is judged on, since it has no words (review M1: judged on `words`, a
    #: LINE_SYNC document was `usable=False` by construction, so the knob could never commit).
    lines: int = 0
    #: Why a GATE judged this text not to describe this audio, or None. Set only by a step that MEASURED it,
    #: never by a failed measurement, and TERMINAL FOR THE TEXT (XA-05; docs/arch/04-alignment.md §5.3 for
    #: the hazard it closes).
    refused: str | None = None
    #: Did `reconcile` RELATE this document's timings to the text's OWN claimed line starts? False is
    #: `reconcile.UNRELATED` and nothing else; None is "the question was not answered"
    #: (docs/arch/04-alignment.md §3; LOG.md, "`claims_related`").
    claims_related: bool | None = None

    def __setstate__(self, state: Sequence[object]) -> None:
        restore_appended(self, state)

    @property
    def usable(self) -> bool:
        """Is this publishable as WORD timing at all?

        ONLY order violations disqualify: a highlight that jumps backwards is incoherent, and line sync is
        strictly better than incoherent, while every other defect is still better than publishing nothing. So
        this is a FLOOR and not a quality bar, which `policy.decide` is what asks. A LINE_SYNC document is
        judged on its LINES, the same floor one level up (docs/arch/04-alignment.md §3).
        """
        if self.refused is not None:
            return False
        if self.engine is Engine.LINE_SYNC:
            return self.out_of_order == 0 and self.lines > 0
        return self.out_of_order == 0 and self.words > 0

    @property
    def thin_coverage(self) -> bool:
        """Timing stops well before the song does — a prompt to look and not a diagnosis, acted on only for
        the WINDOWED engine: a long outro reads exactly like an inaudible stem here."""
        return 0.0 < self.coverage < MIN_COVERAGE

    @property
    def overshoots(self) -> bool:
        """Do this text's own timings run materially past the end of the audio? Fractional and not absolute:
        three seconds over on a 90-second clip is a different claim than on a ten-minute one."""
        if self.duration_sec <= 0 or self.overshoot_sec <= 0:
            return False
        return (self.overshoot_sec / self.duration_sec) > OVERSHOOT_FRACTION_MAX

    @property
    def misplaced(self) -> bool:
        """Does the text look like it was written for a different master of this song?"""
        return self.residual_sec is not None and abs(self.residual_sec) > SUSPECT_RESIDUAL_SEC

    def summary(self) -> str:
        """One line for the operator, and for the `job:state` frame's `why`."""
        if self.engine is Engine.LINE_SYNC:
            bits = [f"{self.lines} lines, line-synced", f"coverage {self.coverage:.0%}"]
        else:
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


def restore_appended(
    record: Any, state: Sequence[object], **derived: Callable[[Mapping[str, object]], object]
) -> None:
    """Unpickle a slotted dataclass `record` from `state`, filling each field APPENDED since it was pickled.

    A slotted dataclass restores its fields positionally, so one added after a checkpoint was written is left
    UNSET and reading it raises — which failed a job in flight at an upgrade, fork after fork, until core's
    attempt ceiling (XA-16; docs/arch/05-worker.md §8). A missing field takes `derived[name]` of the fields
    before it when given, else its default, else raises naming itself.
    """
    restored: dict[str, object] = {}
    for position, spec in enumerate(fields(record)):
        if position < len(state):
            value = state[position]
        elif spec.name in derived:
            value = derived[spec.name](restored)
        elif spec.default is not MISSING:
            value = spec.default
        elif spec.default_factory is not MISSING:
            value = spec.default_factory()
        else:
            raise TypeError(
                f"a checkpointed {type(record).__name__} predates its field {spec.name!r}, "
                "which has no default"
            )
        object.__setattr__(record, spec.name, value)
        restored[spec.name] = value
