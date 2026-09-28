"""What is wrong with one aligned document, measured — and the thresholds that judge it.

Every number here was already computed by the old worker and then thrown away: its `TimingReport`
carried coverage, overshoot, out-of-order counts, gaps, smears and flashes, noted them to a log, and
acted on exactly one (`out_of_order`, to degrade word timing to line timing). Nothing re-aligned.

This module is the measurement only. `policy.py` decides what to DO about it, and keeping those apart is
what makes the decision a table-driven unit test instead of an integration test.
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

    ON THE REPORT because `policy.decide` sees only the report, and the H2 regression (review
    2026-09) was a knob offered to an engine that does not read it. `thin_coverage -> ALIGN_ON_MIX` was
    written for the windowed aligner, whose search is confined to the text's own spans; under the global
    decode it became the ONLY live re-decode retry, fired on nothing more than a long instrumental outro
    (last word end / duration < 0.80), and the mix document overwrote the stem one unseen. Measured on
    the 32-song bench at `--level run_align`: Pure_Mids' 0-gross stem document replaced by a 13-gross mix
    one in 12 of 15 claim modes, and Kinematic (stem coverage 71%, 0 gross) lost to NO LYRICS in 9 —
    truth claims included — because its mix retry was then refused by the envelope gate.
    """

    #: `generate` over one emission matrix of the whole song. Reads no knob but LINE_SYNC: it never
    #: places the text (RESHIFT), never searches presplit windows (DROP_WINDOWS), and already consults
    #: the mix per line where the stem is silent (R4) — so re-running it on the whole mix answers a
    #: question R4 asked line by line, with the band smearing every OTHER line's boundaries.
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
    #: Why a GATE judged this text not to describe this audio, or None. Set only by a step that measured
    #: it — never by a missing or failed measurement, which is `NOTHING_TIMED`'s job. A refusal is
    #: TERMINAL FOR THE TEXT: `policy.decide` answers it with NextText, never LINE_SYNC, because line
    #: sync would publish the same wrong words on their own clock with no gate at all (W0 measured the
    #: hazard: 168 of 320 wrong texts refused by the envelope gate were retrying LINE_SYNC, and only M1's
    #: bug kept them off the TV).
    refused: str | None = None

    def __setstate__(self, state: Sequence[object]) -> None:
        restore_appended(self, state)

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

        A LINE_SYNC document is judged on its LINES — the same floor one level up: at least one timed
        line, and no line starting before the previous one (a row that jumps backwards is as incoherent
        as a word that does).
        """
        if self.refused is not None:
            return False
        if self.engine is Engine.LINE_SYNC:
            return self.out_of_order == 0 and self.lines > 0
        return self.out_of_order == 0 and self.words > 0

    @property
    def thin_coverage(self) -> bool:
        """Timing stops well before the song does. A prompt to look, not a diagnosis.

        Acted on only for the WINDOWED engine (`policy._READS`). For the global decode it is telemetry: a
        long instrumental outro reads exactly like an inaudible stem here (review H2).
        """
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

    WHY (review W1 r2). A frozen, slotted dataclass pickles its field values as a list in field order and
    restores them with `zip(fields, state)`, so a field added after a checkpoint was written is left UNSET:
    reading it raises `AttributeError`. DBOS checkpoints every step's record with pickle, and it replays
    them: a job in flight at an upgrade resumes on its old `TimedDoc`s and `TimingReport`s, and a requeue of
    an old failed job forks from its old checkpoints (`workflows.durable._run_id`). W1 appended
    `TimingReport.engine` / `lines` / `refused`, `TimedDoc.tier` and `AlignOutcome.sync_mode`, and a v2
    report then failed the job on `usable`'s first line, fork after fork, until core's `maxAttempts`.

    A missing field takes `derived[name](the fields restored before it)` when given (what an old record
    implies: a v2 document's tier from its label), else its default. Fields are only ever APPENDED to a
    checkpointed record (the records' rule), so the state is a prefix of the fields; a missing field with
    neither raises, naming it, rather than leaving a record that fails later where nothing says why.
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
