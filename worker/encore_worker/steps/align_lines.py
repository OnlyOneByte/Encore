"""The LINE_SYNC lane's reads: documents, the claim clock, the envelope gates and the lexical lift.

Everything the gated line rung needs that is not itself a decision (docs/arch/04-alignment.md §5, §7).
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from functools import partial
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from encore_worker.domain.audio.activity import ShiftFit
    from encore_worker.domain.lyrics.generate import Generated
    from encore_worker.domain.lyrics.reconcile import AsClaimed

from encore_worker.adapters.ports import InfraFault
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics import (
    claimmap,
    language,
    lexical,
    measure,
    romanize,
    units,
)
from encore_worker.steps.align_geometry import _REPAIRED_MIN_SEC
from encore_worker.steps.records import (
    TextRef,
)


def _word_doc(aligned: Sequence[Segment], language: str) -> dict[str, object]:
    """The aligner's output in the core's document shape."""
    return {"language": language, "lines": [dict(line) for line in aligned]}


def _grade_every_line_low(doc: dict[str, object]) -> None:
    """Stamp `confidence: "low"` on every line of `doc`, in place — what "every line graded low" means on
    the wire, the global engine's `line_confidence` doing it per line (XA-14)."""
    lines = doc.get("lines")
    if isinstance(lines, list):
        for line in lines:
            if isinstance(line, dict):
                line["confidence"] = "low"


def _nonlatin_script(text: TextRef) -> str:
    """This text's own dominant non-Latin script, or `""` — the lane's question asked of the TEXT.

    `TextRef.language` cannot answer it: a script `language.SCRIPT_LANGUAGES` can name no language for
    reaches here as `en` (docs/arch/04-alignment.md §5.4, §11.2).
    """
    return language.nonlatin_script([str(segment.get("text") or "") for segment in text.segments])


def _envelope_passes(fit: ShiftFit) -> bool:
    """The envelope gate's three tiers: r >= 0.40 within ±0.5 s, r >= 0.25 within ±0.1 s, or r >= 0.60 at any
    lag, where the shape agrees and the lag is an offset. The reasoning is at the global engine's gate."""
    return (
        (fit.usable and abs(fit.seconds) <= 0.5)
        or (fit.correlation >= 0.25 and abs(fit.seconds) <= 0.1)
        or (fit.correlation >= 0.60)
    )


def _sheet_passes(fit: ShiftFit) -> bool:
    """The envelope gate for a SHEET's own claimed spans: tiers 1 and 3 of `_envelope_passes`, NOT tier 2 —
    zero lag is evidence only for timings MEASURED ON this audio (docs/arch/04-alignment.md §5.2)."""
    return (fit.usable and abs(fit.seconds) <= 0.5) or fit.correlation >= 0.60


def _timed_spans(segments: Sequence[Segment]) -> list[tuple[float, float]]:
    """The (start, end) of every segment with a positive-length claimed span — what an envelope fits."""
    return [(start, end) for start, end in measure.line_spans(list(segments)) if end > start]


#: Seconds within which a line of the text's own blind decode counts as agreeing with its MAPPED claim. TWO
#: BANDS IN ONE — the gate's and `_line_sync_clock`'s — so `line_gate.py --near` moves both. In SECONDS, which
#: no model makes mean something else, so it is not a per-model row (README, "The LINE_SYNC rung").
_LINE_SYNC_NEAR_SEC = 1.0


#: Share of a sheet's claimed lines that must DECODE before the decode may speak for it — one bar for both
#: readers of that decode, so a mixed-script track's Latin fragment cannot decide for forty Korean lines.
#: What this gate cannot see, and why the lag term that would was rejected: README, "The LINE_SYNC rung".
_LINE_SYNC_MIN_DECODED_SHARE = 0.5


@dataclass(frozen=True, slots=True)
class _LineEvidence:
    """What the stem's emission matrix says about a line-sync text (`AlignStepsImpl._line_sync_evidence`)."""

    #: The text's lexical lift, or None — and why (`unlifted`).
    lift: lexical.Lift | None
    unlifted: str
    #: The calibration row the matrix's model has, or None. NONE MEANS DIFFERENT THINGS to the rung's two
    #: thresholds: the nats-per-letter ones stand down while the SECONDS-based share is still gated, at
    #: `lexical.LINE_SYNC_SHARE_UNCALIBRATED` (XA-06).
    bands: lexical.Bands | None
    #: The matrix the lift was read on, for the DECODE check the caller runs only once the lexical verdict has
    #: passed: a text about to be refused must not pay for a decode. None when there was no matrix to read,
    #: and then `unlifted` says why nothing decoded either.
    emissions: Any
    #: The unit rules the lift was measured under, carried so the rung's DECODE check reads the same
    #: tokenisation and spelling rather than building a second set (docs/arch/04-alignment.md §9.1).
    units: units.Rules | None = None


async def _line_sync_decode(
    texts: Sequence[str], emissions: Any, language: str, unit_rules: units.Rules | None = None
) -> tuple[Generated | None, str]:
    """`texts`' BLIND decode on `emissions`, off the event loop, or None and why it could not be read.

    A machinery fault raises (XA-17); anything else is an unanswered question whose reason starts `it raised`,
    which the bench scores as an ERROR row. The rung's SECOND witness, answering two questions off one decode
    and on the tokenisation its lift was measured with (docs/arch/04-alignment.md §9.1).
    """
    from encore_worker.adapters.ml import forced_align_decoder  # noqa: PLC0415
    from encore_worker.domain.lyrics.generate import generate  # noqa: PLC0415

    try:
        return (
            await asyncio.to_thread(
                partial(generate, decoder=forced_align_decoder, language=language, units=unit_rules),
                texts,
                emissions,
            ),
            "",
        )
    except InfraFault:
        raise  # the machinery, not this text: fails the job (XA-17)
    except Exception as exc:  # noqa: BLE001 - an unanswered question, not a verdict on the text
        return None, f"it raised {type(exc).__name__}: {exc}"


def _agreement_of(decoded: Generated, placed: Sequence[Segment]) -> tuple[AsClaimed | None, str]:
    """`reconcile.as_claimed` of `placed`'s starts against `decoded`, or None and why it could not be read.

    `placed` is the sheet AS IT WILL PUBLISH, so the gate reads the timings the room would see.
    """
    from encore_worker.domain.lyrics import reconcile as rc  # noqa: PLC0415

    claims = _claimed_starts(placed)
    got = rc.as_claimed(decoded.lines, claims, tolerance_sec=_LINE_SYNC_NEAR_SEC)
    if got is None:
        return None, f"fewer than {rc.MIN_PAIRS} lines both decoded and claimed"
    # THE SHARE IS ONLY OF THE LINES THAT DECODED, so the denominator has to be most of the sheet before it
    # may speak for it. Below the share the sheet gate decides instead, reading the WHOLE sheet's spans
    # against the envelope. Inert on every case the bench has measured.
    if got.pairs < (bar := _enough_decoded(len(claims))):
        # WHICH OF `_enough_decoded`'s TWO BOUNDS BIT, because they refuse different sheets and a bare
        # "under 50%" on a decode that read every line of its sheet reads as a broken counter.
        rule = (
            f"{_LINE_SYNC_MIN_DECODED_SHARE:.0%} of it"
            if bar > claimmap.MIN_PAIRS
            else "the floor a placement may be read on"
        )
        return None, (
            f"only {got.pairs} of {len(claims)} claimed lines decoded, under the {bar} this check needs "
            f"to speak for the sheet ({rule})"
        )
    return got, ""


def _enough_decoded(claims: int) -> int:
    """How many of a sheet's `claims` lines must DECODE before the decode may speak for the sheet: at least
    `claimmap.MIN_PAIRS` lines, and at least `_LINE_SYNC_MIN_DECODED_SHARE` of it — ONE bar for both readers
    of that decode, and `claimmap`'s floor rather than `reconcile`'s because this reader ACTS
    (docs/arch/04-alignment.md §5.3)."""
    return max(claimmap.MIN_PAIRS, math.ceil(_LINE_SYNC_MIN_DECODED_SHARE * claims))


def _claimed_starts(segments: Sequence[Segment]) -> dict[int, float]:
    """Every segment's claimed start, keyed by its POSITION in the text — which is the key `generate` gives a
    line (`Line.index`) and `reconcile` pairs on, so the decode, the vote and the gate all pair the same way
    and one dropped decorative line cannot shear the comparison after it."""
    return {
        index: float(start)
        for index, segment in enumerate(segments)
        if isinstance(start := segment.get("start"), (int, float)) and not isinstance(start, bool)
    }


def _line_sync_clock(
    fit: ShiftFit | None, claimed: Mapping[int, float], decoded: Generated | None
) -> claimmap.ClaimMap | None:
    """THE LINE_SYNC RUNG'S CLAIM CLOCK: which clock this sheet is on, by the same vote the global engine
    takes — or None when there is no decode to vote with.

    Its own call because the rung PUBLISHES the claims, so THE TOLERANCE IS THIS RUNG'S and NOT PIECEWISE.
    None rather than `IDENTITY` with no vote to take, and the bar is LITERALLY the gate's own
    `_enough_decoded` call (docs/arch/04-alignment.md §7).
    """
    if decoded is None:
        return None
    pairs = sum(1 for line in decoded.lines if line.index in claimed)
    if pairs < _enough_decoded(len(claimed)):
        return None
    return claimmap.consensus(
        {line.index: line.start for line in decoded.lines},
        claimed,
        envelope_lag=(
            fit.seconds if fit is not None and fit.correlation >= claimmap.MIN_ENVELOPE_CORRELATION else None
        ),
        tolerance_sec=_LINE_SYNC_NEAR_SEC,
    )


def _mapped(segments: Sequence[Segment], clock: claimmap.ClaimMap) -> tuple[Segment, ...]:
    """`segments` with every claimed timestamp on our clock (`ClaimMap.at`), so a claim that PUBLISHES and a
    repair window built from the same map move identically.

    Copies, never in place, and each end held at or after its start (docs/arch/04-alignment.md §7).
    """
    if not clock.applied:
        return tuple(segments)
    moved: list[Segment] = []
    for segment in segments:
        copy = dict(segment)
        start = segment.get("start")
        at: float | None = None
        if isinstance(start, (int, float)) and not isinstance(start, bool):
            at = clock.at(float(start))
            copy["start"] = at
        end = segment.get("end")
        if isinstance(end, (int, float)) and not isinstance(end, bool):
            mapped_end = clock.at(float(end))
            copy["end"] = mapped_end if at is None else max(mapped_end, at)
        moved.append(copy)
    return tuple(moved)


#: The most claimed starts `_in_claim_order` will hold before it leaves the sheet alone, as a share of its
#: timed lines and never fewer than one. Many of them is a sheet whose order nobody can reconstruct
#: (README, "A STRAY STAMP ONLY").
_MAX_HELD_SHARE = 0.05


def _in_claim_order(segments: Sequence[Segment]) -> tuple[tuple[Segment, ...], int, int]:
    """`segments` with a stray backwards claimed start held at the one before it: the segments, how many were
    held, and how many were left alone because holding them would have made things worse.

    HELD, NOT SORTED — a claim is evidence about ITS line. ONE STRAY STAMP ONLY, AND ONLY WHERE THE SHEET
    RECOVERS; otherwise `measure.out_of_order` reaches `decide` as before. IDEMPOTENT either way, and
    docs/arch/04-alignment.md §5.3 has why the end is held PAST the predecessor's.
    """
    starts: dict[int, float] = {}
    for position, segment in enumerate(segments):
        start = segment.get("start")
        if isinstance(start, (int, float)) and not isinstance(start, bool):
            starts[position] = float(start)

    order = list(starts)
    #: The claimed start of the line after each claimed line, by position: the ceiling a held line's stretch
    #: may not cross. A stray's successor is always a KEPT line, so this is the next line's own stamp.
    next_claimed = {position: starts[later] for position, later in zip(order, order[1:], strict=False)}
    inversions: list[int] = []
    strays: set[int] = set()
    previous: float | None = None
    for rank, position in enumerate(order):
        if previous is None or starts[position] >= previous:
            previous = starts[position]
            continue
        inversions.append(position)
        # The next claimed start decides WHICH stamp is the outlier: if the sheet comes back above the last
        # kept start, this one line is; if it stays below, the EARLIER stamp was, and nothing here can tell
        # where the lines after it belong. A trailing inversion has nothing left to drag.
        recovers = starts[order[rank + 1]] if rank + 1 < len(order) else previous
        if recovers >= previous:
            strays.add(position)
    if len(strays) != len(inversions) or len(inversions) > max(1, int(_MAX_HELD_SHARE * len(order))):
        return tuple(segments), 0, len(inversions)

    out: list[Segment] = []
    held = 0
    previous = None
    previous_end: float | None = None
    for position, segment in enumerate(segments):
        if position not in starts:
            out.append(segment)
            continue
        end = segment.get("end")
        numeric_end = float(end) if isinstance(end, (int, float)) and not isinstance(end, bool) else None
        if position in strays and previous is not None:
            copy = dict(segment)
            copy["start"] = previous
            floor = previous if previous_end is None else max(previous, previous_end)
            if numeric_end is not None and numeric_end <= floor:
                #: A STRETCH, not the floor itself: equalling it publishes a span byte-identical to the
                #: predecessor's, which core's `activeLineIndex` never returns.
                room = next_claimed.get(position)
                stretched = floor + _REPAIRED_MIN_SEC
                numeric_end = stretched if room is None else min(stretched, max(floor, room))
                copy["end"] = numeric_end
            out.append(copy)
            held += 1
        else:
            previous = starts[position]
            out.append(segment)
        previous_end = numeric_end if numeric_end is not None else previous
    return tuple(out), held, 0


async def _measured_lift(
    texts: Sequence[str],
    emissions: Any,
    rules: units.Rules | None = None,
    bundle_language: str = language.ENGLISH,
) -> tuple[lexical.Lift | None, lexical.Bands | None, str]:
    """`lexical.lift` of `texts` on `emissions`, off the event loop, THE ROW it must be judged against, and
    why it could not be measured.

    `bundle_language` is the language whose BUNDLE produced `emissions`, a row being one pair's (XA-21).
    Shared by both lexical gates so they read the same number the same way. THE ROW TRAVELS WITH THE LIFT, a
    second lookup being able to answer differently (XA-06, XA-17; docs/arch/04-alignment.md §5.1, §5.4).
    """
    from encore_worker.adapters.ml import forced_align_decoder  # noqa: PLC0415

    bands = lexical.calibration(emissions, bundle_language)
    if bands is None:
        return None, None, lexical.uncalibrated(str(getattr(emissions, "model", "") or ""), bundle_language)
    try:
        got = await asyncio.to_thread(
            partial(lexical.lift, decoder=forced_align_decoder, units=rules), texts, emissions
        )
    except InfraFault:
        raise  # the machinery, not this text: fails the job (XA-17)
    except Exception as exc:  # noqa: BLE001 - an unanswered question, not a verdict on the text
        return None, bands, f"it raised {type(exc).__name__}: {exc}"
    if got is None:
        return None, bands, f"under {lexical.MIN_LETTERS} alignable letters, or no word order to contrast"
    return got, bands, ""


#: Seconds a sheet line may claim to be sung when its END is only the next line's START. Uncapped, an LRC's
#: spans tile the whole song and the expected envelope degenerates to one block any text can match.
_SHEET_SPAN_CAP_SEC = 5.0


def _sheet_spans(segments: Sequence[Segment]) -> list[tuple[float, float]]:
    """A sheet's claimed singing, in time order, for the LINE_SYNC gate's envelope fit.

    An end that coincides with the next line's start is capped at `_SHEET_SPAN_CAP_SEC`, being an onset of
    the NEXT line rather than a measurement of this one; a span with an end of its own keeps it.
    """
    every = sorted(measure.line_spans(list(segments)))
    out: list[tuple[float, float]] = []
    for position, (start, end) in enumerate(every):
        if end <= start:
            continue
        following = every[position + 1][0] if position + 1 < len(every) else None
        if following is not None and abs(end - following) <= 1e-3:
            end = min(end, start + _SHEET_SPAN_CAP_SEC)
        out.append((start, end))
    return out


def _line_doc(
    segments: Sequence[Segment], language: str, romanizer: romanize.Romanizer | None = None
) -> dict[str, object]:
    """A line-synced document: each segment becomes a line with no per-word spans.

    One implementation for both the `LINE_SYNC` knob and any other line fallback, the ORDER of the starts
    included, so no caller can publish a stray backwards claim by forgetting to normalise. Idempotent, and a
    sheet `_in_claim_order` REFUSES to normalise keeps its inversions on purpose. `romanization` is an
    OPTIONAL extra field, written only where there is a second script to show (XA-19,
    docs/arch/04-alignment.md §11.2).
    """
    ordered, _held, _unheld = _in_claim_order(segments)
    lines: list[dict[str, object]] = []
    for s in ordered:
        text = str(s.get("text") or "")
        line: dict[str, object] = {"text": text, "start": s.get("start"), "end": s.get("end")}
        said = romanize.romanization_of(text, romanizer)
        if said is not None:
            line["romanization"] = said
        lines.append(line)
    return {"language": language, "lines": lines}
