"""Claims as served, and the placement-ambiguity rule's reading of a document.

The claim window's own constants (adoption edge, repair pad, reopen reach, default end) and the margin read
that decides whether a placement was ambiguous enough to grade down. Design: docs/arch/04-alignment.md §6,
§7.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from encore_worker.adapters.ports import InfraFault
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics import units

#: WHY the placement-ambiguity rule said nothing, one name per reason, because the reasons lead to DIFFERENT
#: next steps and all of them used to print one sentence: `arm`, `uncalibrated`, `already-low`, `fault` and
#: `unreadable`, each spelled out in `_margin_why`.
_MarginSilence = Literal["arm", "uncalibrated", "graph", "already-low", "fault", "unreadable"]


@dataclass(frozen=True, slots=True)
class _Placement:
    """What the placement-ambiguity rule read on this document — and when it read NOTHING, WHICH silence.

    `margins is None` IFF `silence is not None`: one answer in two halves, travelling together because a
    swallowed fault and the `conf-legacy` arm used to be byte-identical on the trail. `fault` names the
    exception TYPE for that reason.
    """

    #: Per-line max-marginal margins in nats, keyed by line index; None is NOT MEASURED (never "ambiguous").
    margins: dict[int, float] | None = None
    #: Which silence, when `margins` is None.
    silence: _MarginSilence | None = None
    #: The exception type's name when `silence` is `fault`, so the trail can name it without holding the
    #: exception alive beside a matrix and a Viterbi (the memory note in `_placement_margins`).
    fault: str | None = None


def _placement_margins(
    matrix: Any,
    line_texts: Sequence[str],
    *,
    separate_lines: bool = False,
    stars: bool = False,
    units: units.Rules | None = None,
) -> _Placement:
    """How ambiguous each line's placement was on `matrix`, in nats (`domain.lyrics.margin`).

    THE SAME TARGETS AND TOPOLOGY THE DECODE RAN ON: the texts must be the BLIND decode's, `matrix` the
    STARRED one under that arm (XA-12), and the graph PLAIN — hence the caller's abstention under `star-b`.
    NO MARGINS ON ANY FAULT, and every fault: a wrong guess at numpy's exception reinstates the bug, and `{}`
    would still apply the rule's SCORE half. `InfraFault` is re-raised; numpy is converted here because
    `domain/` may not import torch (XA-15; docs/arch/04-alignment.md §6).
    """
    import numpy as np  # noqa: PLC0415 - the steps layer's lazy numpy, as `_time_text_global` reads it

    from encore_worker.domain.lyrics import margin  # noqa: PLC0415
    from encore_worker.domain.lyrics.generate import blank_of, char_targets  # noqa: PLC0415

    flat = char_targets(line_texts, matrix, separate_lines=separate_lines, stars=stars, units=units)
    if not flat.targets:
        return _Placement(silence="unreadable")
    try:
        got = margin.placement_margins(
            np.asarray(matrix.log_probs, dtype=np.float64),
            flat.targets,
            flat.first_char_target,
            blank=blank_of(matrix),
            frame_sec=float(matrix.frame_sec),
        )
    except InfraFault:
        raise
    except Exception as failed:  # noqa: BLE001 - every fault means "not measured"; see the docstring
        # MEMORY IS THE REAL ONE, the caller holding the whole matrix and a Viterbi beside these arrays. The
        # TYPE's name is kept and the exception is not, so no traceback holds that matrix alive.
        return _Placement(silence="fault", fault=type(failed).__name__)
    # `placement_margins` answers `{}` for a matrix it could not read at all, which is the same GRADE as a
    # fault — nothing measured, nothing to grade on — and a different REPORT: this matrix cannot be read,
    # rather than this run could not read it.
    return _Placement(margins=got) if got else _Placement(silence="unreadable")


#: A repaired line whose decode landed within this of the window's LEFT EDGE "heard nothing": a forced path
#: through flat emissions collapses leftward. Fitted where the errors clustered at exactly the pad width.
_ADOPT_EDGE_SEC = 0.08


#: How far below the song's own median line score a repaired line must sit to be called unheard. Scores
#: compare WITHIN a song only; the measured good/gross medians were -0.95 against -1.76.
_ADOPT_SCORE_GAP = 0.5


#: Seconds of slack added around a repair window before re-decoding inside it, a window cut exactly to the
#: claim clipping a note it started late on. Also the reach of `claim_run`'s hold-open: this close to the
#: claim span is the same line measured twice, further away is a second hypothesis.
_REPAIR_PAD_SEC = 1.0


#: The widest BACKWARD move a re-opening may make, seconds. The rule exists for the 0.5-2 s band, and 2 s is
#: where a gross line begins (the bench's own `GROSS_SEC`); `skipped_opening`'s other bound is the re-decode's
#: own duration, which a merged cue outruns without ever biting (review r2-correctness-3).
_REOPEN_MAX_SEC = 2.0


#: Window a cue with no end of its own is given, seconds: enough to ANCHOR a re-decode, never a reading.
_CLAIM_DEFAULT_END_SEC = 1.0


@dataclass(frozen=True, slots=True)
class _Claims:
    """The sheet AS SERVED, read off the segments by position: before any clock maps it onto ours."""

    starts: dict[int, float]
    #: One window per claimed line. A cue whose end is missing gets `_CLAIM_DEFAULT_END_SEC`; one whose end is
    #: at or before its start keeps its own zero length, which is what `ClaimMap.windows` preserves too.
    windows: dict[int, tuple[float, float]]
    #: Lines whose cue wrote a USABLE end of its own — after its start, so neither a defaulted end nor a
    #: zero-length or reversed one. Only such an end may be READ (`skipped_opening`, `end_bias`): README,
    #: "Caption cues: the two populations a duration floor separates"; review r2-correctness-4.
    ends_given: set[int]


def _claims_as_served(segments: Sequence[Segment]) -> _Claims:
    """The claimed onsets, windows and written ends of `segments`. Untimed or malformed rows are skipped."""
    starts: dict[int, float] = {}
    windows: dict[int, tuple[float, float]] = {}
    ends_given: set[int] = set()
    for index, segment in enumerate(segments):
        start, end = segment.get("start"), segment.get("end")
        if not isinstance(start, (int, float)) or isinstance(start, bool):
            continue
        first = float(start)
        written = float(end) if isinstance(end, (int, float)) and not isinstance(end, bool) else None
        starts[index] = first
        windows[index] = (first, max(first + _CLAIM_DEFAULT_END_SEC if written is None else written, first))
        if written is not None and written > first:
            ends_given.add(index)
    return _Claims(starts=starts, windows=windows, ends_given=ends_given)
