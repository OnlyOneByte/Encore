"""A vendored CTC Viterbi: the plain topology bit for bit, plus the arcs a fixed kernel cannot express.

Pure numpy with int8 backpointers, in the style of NeMo's `aligner_utils` (Apache-2.0). On an empty `Graph`
it is `torchaudio.functional.forced_align` frame for frame (XA-18), which is what makes it swappable; a
non-empty one adds penalised SKIP arcs over a run of targets, OPTIONAL
frame-relative STAR states (phase B) and a per-frame onset BONUS at a chosen state.

docs/arch/04-alignment.md §3.2 for the graph and why each arc exists; LOG.md,
"W9: a vendored decoder, and the three arms it unblocks" for what each one measured.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from encore_worker.domain.lyrics.generate import Decoder

#: Nats charged for bypassing one line: a fixed cost plus one per alignable character
#: (`SKIP_LINE_NATS + SKIP_CHAR_NATS * chars`). The refined pair, measured
#: as a COMPLEMENT to the never-sung rule at +1 gross and 0 false drops.
SKIP_LINE_NATS = 30.0
SKIP_CHAR_NATS = 6.0

#: Backpointer codes 0/1/2 are CTC's own stay / one state back / skip the blank, as the kernel writes them.
#: Anything from here up names one of `_Arcs`' extra arcs by its slot at the state it lands on.
_FIRST_ARC_CODE = 3

#: Extra arcs one state may receive: a line skip lands on a blank, and a star's two bypasses share one
#: character state. Fixed, so `back` stays int8 and the traceback needs no search.
_MAX_ARCS_PER_STATE = 2


@dataclass(frozen=True, slots=True)
class Skip:
    """A penalised arc bypassing `targets[first:last]` — one line the path may leave unsung."""

    first: int
    last: int
    penalty: float


@dataclass(frozen=True, slots=True)
class Graph:
    """What this decoder adds to CTC's plain topology. Empty means the plain topology exactly (XA-18)."""

    skips: tuple[Skip, ...] = ()
    #: Target positions whose state emits `frame max − star_penalty` and may be bypassed for free: phase B's
    #: frame-relative star, which needs no column in the matrix and no mandatory visit.
    stars: tuple[int, ...] = ()
    star_penalty: float = 0.0
    #: Target position -> per-frame nats added to that state's emission only (roadmap item 14's onset prior).
    #: Never added to a reported score: a prior is not evidence.
    bonus: Mapping[int, Any] = field(default_factory=dict)

    @property
    def plain(self) -> bool:
        return not self.skips and not self.stars and not self.bonus


PLAIN = Graph()


@dataclass(frozen=True, slots=True)
class Alignment:
    """One decode: the kernel's own two outputs, plus which optional runs the best path bypassed."""

    labels: tuple[int, ...]
    scores: tuple[float, ...]
    #: Indexes into `Graph.skips` whose arc the best path took.
    skipped: frozenset[int]


@dataclass(frozen=True, slots=True)
class _Arcs:
    """`Graph`'s extra arcs compiled onto trellis states, grouped by slot so each group's targets are unique.

    One `np.maximum`-style pass per group, in slot order, is a sequential maximum over the arcs — which a
    single fancy-index assignment would not be, duplicate destinations keeping the LAST write.
    """

    groups: tuple[tuple[np.ndarray, np.ndarray, np.ndarray], ...]
    #: `(state, slot) -> source state`, the traceback's only lookup.
    source: np.ndarray
    #: `(state, slot) -> the `Graph.skips` index this arc is, or -1 for a star bypass.
    tag: np.ndarray
    #: `(destination state, slot, penalty)` for every arc leaving the LEADING BLANK, which is the one state
    #: a path may occupy without spending a frame — so these are the arcs frame 0 can take (`align`).
    entry: tuple[tuple[int, int, float], ...]


def align(log_probs: Any, targets: Sequence[int], blank: int = 0, *, graph: Graph = PLAIN) -> Alignment:
    """The best path of `targets` through `log_probs`, as `adapters.ml.forced_align_decoder` returns it.

    Ties break as torchaudio's CPU kernel breaks them — a skip or a step only when strictly best, an end in
    the trailing blank only when strictly better — and the accumulation keeps the matrix's own float32, so
    flat evidence takes production's path. Raises `ValueError` on a blank target, and on frames too few for
    `_frames_needed`, which is the kernel's own count on a plain graph and a bypass-aware bound under one.
    """
    matrix = np.asarray(log_probs)
    matrix = matrix.astype(np.float32 if matrix.dtype == np.float32 else np.float64, copy=False)
    if matrix.ndim != 2:
        raise ValueError(f"log_probs must be (frames, vocab), got shape {matrix.shape}")
    frames = int(matrix.shape[0])
    if not targets:
        column = [float(v) for v in matrix[:, blank]]
        return Alignment(labels=(blank,) * frames, scores=tuple(column), skipped=frozenset())
    ids = np.asarray(targets, dtype=np.int64)
    if (ids == blank).any():
        raise ValueError("a target equals the blank id")
    need = _frames_needed(ids, graph)
    if frames < need:
        raise ValueError(f"{frames} frames cannot hold {len(ids)} targets ({need} needed)")

    labels = np.full(2 * len(ids) + 1, blank, dtype=np.int64)
    labels[1::2] = ids
    states = len(labels)
    # A skip over the blank between two labels is allowed only when the labels differ.
    skip_into = np.zeros(states, dtype=bool)
    skip_into[3::2] = labels[3::2] != labels[1:-2:2]
    arcs = None if graph.plain else _compile(graph, ids, states)
    emit = _Emitter(matrix, labels, graph)
    entry = _EntryBonus(graph, states, matrix.dtype)

    neg = np.array(-np.inf, dtype=matrix.dtype)
    first = emit.at(0)
    alpha = np.full(states, neg, dtype=matrix.dtype)
    alpha[0], alpha[1] = first[0], first[1]
    back = np.zeros((frames, states), dtype=np.int8)
    if arcs is not None:
        # FRAME 0 TAKES THE ARCS OUT OF THE LEADING BLANK TOO, or the starred graph would not contain the
        # plain path that emits the first character at frame 0 (`_compile`'s superset claim).
        for lands_on, entry_slot, toll in arcs.entry:
            seeded = first[lands_on] - toll
            if seeded > alpha[lands_on]:
                alpha[lands_on] = seeded
                back[0, lands_on] = _FIRST_ARC_CODE + entry_slot
    pad = np.full(2, neg, dtype=matrix.dtype)
    for frame in range(1, frames):
        stay = alpha
        one = np.concatenate((pad[:1], alpha[:-1]))
        two = np.where(skip_into, np.concatenate((pad, alpha[:-2])), neg)
        bonus = entry.at(frame)
        if bonus is not None:
            one += bonus
            two += bonus
        choice = np.where((two > one) & (two > stay), 2, np.where((one > stay) & (one > two), 1, 0))
        best = np.choose(choice, (stay, one, two))
        if arcs is not None:
            for slot, (source, into, penalty) in enumerate(arcs.groups):
                offered = alpha[source] - penalty
                if bonus is not None:
                    offered = offered + bonus[into]
                better = offered > best[into]
                if better.any():
                    taken = into[better]
                    best[taken] = offered[better]
                    choice[taken] = _FIRST_ARC_CODE + slot
        alpha = best + emit.at(frame)
        back[frame] = choice

    state = states - 1 if alpha[-1] > alpha[-2] else states - 2
    if not np.isfinite(alpha[state]):
        raise ValueError("no CTC path fits these targets in these frames")
    path, skipped = _traceback(back, state, arcs)
    chosen = labels[path]
    scores = matrix[np.arange(frames), chosen]
    return Alignment(
        labels=tuple(int(v) for v in chosen),
        scores=tuple(float(v) for v in scores),
        skipped=skipped,
    )


def _traceback(back: np.ndarray, last: int, arcs: _Arcs | None) -> tuple[np.ndarray, frozenset[int]]:
    """The trellis state per frame of the best path ending at `last`, and which `Graph.skips` it took.

    A code at or above `_FIRST_ARC_CODE` is only ever written under `arcs`, so one read here without them is
    a corrupt `back` and is REFUSED: read as "no arc" instead, the traceback would park on one state for the
    rest of the song and return a wrong path as a good one.
    """
    frames = int(back.shape[0])
    path = np.empty(frames, dtype=np.int64)
    skipped: set[int] = set()
    state = last
    for frame in range(frames - 1, -1, -1):
        path[frame] = state
        code = int(back[frame, state])
        if code < _FIRST_ARC_CODE:
            state -= code
            continue
        slot = code - _FIRST_ARC_CODE
        if arcs is None:
            raise ValueError(f"frame {frame} took arc slot {slot} on a graph that compiled no arcs")
        tag = int(arcs.tag[state, slot])
        if tag >= 0:
            skipped.add(tag)
        state = int(arcs.source[state, slot])
    return path, frozenset(skipped)


def decoder(graph: Graph = PLAIN) -> Decoder:
    """`generate.Decoder` over `graph` — the vendored alternative to `adapters.ml.forced_align_decoder`."""

    def decode(log_probs: Any, targets: Sequence[int], blank: int = 0, /) -> tuple[list[int], list[float]]:
        got = align(log_probs, targets, blank, graph=graph)
        return list(got.labels), list(got.scores)

    return decode


def line_skips(
    blocks: Mapping[int, tuple[int, int]],
    exempt: frozenset[int] = frozenset(),
    *,
    line_nats: float = SKIP_LINE_NATS,
    char_nats: float = SKIP_CHAR_NATS,
) -> tuple[tuple[int, ...], tuple[Skip, ...]]:
    """`(line index per arc, the arcs)` for every line of `blocks` not in `exempt`.

    `blocks` is `generate.line_blocks`'; the parallel index tuple is what turns `Alignment.skipped` back into
    line indexes. A repeated line is exempted by the CALLER, which is also
    why this takes a set rather than the texts: whose definition of "a repeat" is the caller's business.
    """
    indexes: list[int] = []
    arcs: list[Skip] = []
    for index in sorted(blocks):
        first, last = blocks[index]
        if index in exempt or last <= first:
            continue
        indexes.append(index)
        arcs.append(Skip(first=first, last=last, penalty=line_nats + char_nats * (last - first)))
    return tuple(indexes), tuple(arcs)


class _Emitter:
    """Each frame's per-state emission: the matrix's own column, with the star states overridden.

    Per frame rather than one `(frames, states)` gather, which is 192 MB on a four-minute song.
    """

    def __init__(self, matrix: np.ndarray, labels: np.ndarray, graph: Graph) -> None:
        self._matrix = matrix
        self._labels = labels
        self._stars = 2 * np.asarray(sorted(graph.stars), dtype=np.intp) + 1 if graph.stars else None
        self._penalty = matrix.dtype.type(graph.star_penalty)
        self._top = matrix.max(axis=1) if graph.stars else None

    def at(self, frame: int) -> np.ndarray:
        out: np.ndarray = self._matrix[frame, self._labels]
        if self._stars is not None and self._top is not None:
            out[self._stars] = self._top[frame] - self._penalty
        return out


class _EntryBonus:
    """`Graph.bonus` as nats on the TRANSITION INTO a state, paid once at the frame the path enters it.

    On the emission instead it would reward DWELLING: a 20-nat peak parked the first character of a line on
    the prior's own peak and paid 600 nats of evidence for it (README section in the module docstring).
    """

    def __init__(self, graph: Graph, states: int, dtype: np.dtype[Any]) -> None:
        rows = sorted(graph.bonus)
        self._states = 2 * np.asarray(rows, dtype=np.intp) + 1 if rows else None
        self._curves = (
            np.asarray([np.asarray(graph.bonus[row], dtype=dtype) for row in rows]) if rows else None
        )
        self._buffer = np.zeros(states, dtype=dtype) if rows else None

    def at(self, frame: int) -> np.ndarray | None:
        if self._states is None or self._curves is None or self._buffer is None:
            return None
        self._buffer[self._states] = self._curves[:, frame]
        return self._buffer


def _frames_needed(ids: np.ndarray, graph: Graph) -> int:
    """Frames below which `ids` cannot fit: the kernel's exact count on a plain graph, a BOUND under one.

    A bound rather than the graph's exact shortest path, because all this has to do is stop refusing input a
    bypass arc could have fitted; anything still infeasible dies on the trellis's own finite check below.
    """
    count = len(ids)
    if graph.plain:
        return count + int((ids[1:] == ids[:-1]).sum())
    bypassable = set(graph.stars)
    for arc in graph.skips:
        bypassable.update(range(arc.first, arc.last))
    return count - len(bypassable & set(range(count)))


def _compile(graph: Graph, ids: np.ndarray, states: int) -> _Arcs:
    """`graph`'s arcs as trellis state pairs (see `_Arcs`).

    A line skip runs blank-to-blank, so the bypassed run's neighbours stay separated by a blank frame and no
    two character runs can merge. A star gets TWO bypasses — from the blank before it and from the character
    before that — which together make the starred graph a strict SUPERSET of the plain one: every plain path
    exists in it at the same score, so a large `star_penalty` reproduces the plain decode. The superset holds
    at frame 0 only because `align` seeds `_Arcs.entry` there as well.
    """
    source: list[int] = []
    into: list[int] = []
    penalty: list[float] = []
    tag: list[int] = []
    for index, arc in enumerate(graph.skips):
        if not 0 <= arc.first < arc.last <= len(ids):
            raise ValueError(f"skip {index} is not a run of these targets: {arc}")
        source.append(2 * arc.first)
        into.append(2 * arc.last)
        penalty.append(arc.penalty)
        tag.append(index)
    for position in graph.stars:
        if not 0 <= position < len(ids) - 1:
            raise ValueError(f"a star at target {position} has no line after it to bypass to")
        source.append(2 * position)
        into.append(2 * position + 3)
        penalty.append(0.0)
        tag.append(-1)
        if position and ids[position - 1] != ids[position + 1]:
            source.append(2 * position - 1)
            into.append(2 * position + 3)
            penalty.append(0.0)
            tag.append(-1)
    slot_of: dict[int, int] = {}
    slots: list[int] = []
    for state in into:
        slots.append(slot_of.get(state, 0))
        slot_of[state] = slots[-1] + 1
    if slots and max(slots) >= _MAX_ARCS_PER_STATE:
        raise ValueError(f"a trellis state received more than {_MAX_ARCS_PER_STATE} extra arcs")
    at_slot = np.asarray(slots, dtype=np.intp)
    sources = np.asarray(source, dtype=np.intp)
    targets = np.asarray(into, dtype=np.intp)
    penalties = np.asarray(penalty, dtype=np.float64)
    tags = np.asarray(tag, dtype=np.int64)
    by_slot = np.full((states, _MAX_ARCS_PER_STATE), -1, dtype=np.intp)
    by_tag = np.full((states, _MAX_ARCS_PER_STATE), -1, dtype=np.int64)
    by_slot[targets, at_slot] = sources
    by_tag[targets, at_slot] = tags
    groups = tuple(
        (sources[at_slot == slot], targets[at_slot == slot], penalties[at_slot == slot])
        for slot in range(int(at_slot.max()) + 1 if at_slot.size else 0)
    )
    entry = tuple(
        (int(targets[at]), int(at_slot[at]), float(penalties[at]))
        for at in range(int(targets.size))
        if sources[at] == 0
    )
    return _Arcs(groups=groups, source=by_slot, tag=by_tag, entry=entry)
