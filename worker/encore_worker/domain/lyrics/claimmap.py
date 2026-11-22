"""Putting a sheet's CLAIMED timings on OUR clock, ONCE, before anything reads them.

The claims are mapped here, before the first `reconcile`, and only the CLAIMS move (XA-04). The estimator is a
VOTE, not a fit, under three floors, and PURE and DETERMINISTIC so a DBOS replay and a bench re-run map
identically. The candidate table, the floors and why piecewise is an arm: `docs/arch/04-alignment.md` §7 and
§14; LOG.md, "The claim clock", "The rung's own claim clock" and "The claim clock's own exhibits".
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from statistics import median

from encore_worker.domain.lyrics.reconcile import AGREE_TOLERANCE_SEC, MIN_FITTED_PAIRS, theil_sen

#: Minimum paired lines before this module will map anything: `reconcile`'s FITTED floor itself, not a second
#: literal that happens to agree. That floor is how many pairs a FIT may be believed on, and a fit that ACTS
#: cannot need fewer — so raising it raises this, which a copy would silently have left behind.
MIN_PAIRS = MIN_FITTED_PAIRS

#: The winner must explain this many more paired lines than no-shift — or this share of them, whichever is
#: larger. `int()` and not a ceiling, which is the rule the measured numbers came from. Which term binds, and
#: how many cases the share alone refuses, is in LOG.md, "The claim clock's own exhibits".
MIN_GAIN_LINES = 2
MIN_GAIN_SHARE = 0.05

#: ...and the winner must explain at least this SHARE of the paired lines outright, the margin above being a
#: DIFFERENCE, so four candidates explaining almost nothing can still leave one two lines ahead. In an EMPTY
#: band (LOG.md, "The claim clock's own exhibits").
MIN_INLIER_SHARE = 0.2

#: A map that moves no paired claim by at least this much is not applied, whatever it explains. One frame
#: of the activity envelope (`activity.HOP_SEC`), which is the quantisation floor of the envelope
#: candidate and finer than the decode median's own jitter.
MOVE_FLOOR_SEC = 0.02

#: How far the envelope candidate's correlation may sit below `activity.MIN_CORRELATION` and still be OFFERED.
#: Deliberately weaker than that gate: a correlation here only buys a candidate a place in the vote, and the
#: vote decides. The step applies it, since the fit is measured on numpy-side data.
MIN_ENVELOPE_CORRELATION = 0.25

#: The piecewise arm's shape: at most this many legs, each fitted on at least this many paired lines. A leg
#: is a map, so its floor is `MIN_PAIRS` (one literal, as above); four legs is an inserted section plus its
#: neighbours, which is the shape the arm exists for.
MAX_PIECES = 4
MIN_PIECE_PAIRS = MIN_PAIRS

#: Which candidate a `ClaimMap` came from, for the trail.
NO_SHIFT = "no-shift"
ENVELOPE_LAG = "envelope-lag"
DECODE_MEDIAN = "decode-median"
DECODE_MODE = "decode-mode"
TEMPO = "tempo"
TEMPO_MODE = "tempo-mode"
PIECEWISE = "piecewise"


@dataclass(frozen=True, slots=True)
class Piece:
    """One affine leg of a map: a claim at `t` lands at `t * scale + offset_sec`.

    `at` is NOT clamped — `ClaimMap.at` clamps the result at zero, once, where the whole map is applied.
    """

    #: The first CLAIMED second this leg covers; the first leg's is 0.0, so an earlier claim maps on it too.
    from_sec: float
    offset_sec: float
    scale: float = 1.0
    #: Paired lines this leg explains within the tolerance, out of the `pairs` it covers.
    inliers: int = 0
    pairs: int = 0

    def at(self, claimed: float) -> float:
        return claimed * self.scale + self.offset_sec

    def why(self) -> str:
        scale = "" if self.scale == 1.0 else f" scale {self.scale:.4f}"
        return f"{self.offset_sec:+.2f}s{scale} ({self.inliers}/{self.pairs})"


@dataclass(frozen=True, slots=True)
class ClaimMap:
    """The map from a sheet's claimed clock onto ours, plus the vote that chose it. The identity has no legs,
    so "we could not tell" and "it was already on our clock" read the same downstream — neither moves
    anything."""

    #: In claim-time order. Empty for the identity.
    pieces: tuple[Piece, ...] = ()
    applied: bool = False
    #: Which candidate won the vote, applied or not (`NO_SHIFT` .. `PIECEWISE`).
    candidate: str = NO_SHIFT
    #: Paired lines the winner explains, and the same count for no-shift: the margin, audited.
    inliers: int = 0
    baseline: int = 0
    pairs: int = 0
    margin: int = 0
    #: NO `declined_sec` HERE, deliberately: the size of a REFUSED candidate looks like the number a reader
    #: wants and is not, a candidate being seconds wide precisely when OUR DECODE is scattered.
    #: `align_steps`' `off_clock` asks the AUDIO instead.
    why: str = "no claims to map"

    def at(self, claimed: float) -> float:
        """`claimed` on our clock. Clamped at zero, as `place.apply_shift` clamps: a negative timestamp is
        not representable on a playhead, and a repair window that starts before the file cannot be read."""
        if not self.applied or not self.pieces:
            return claimed
        leg = self.pieces[0]
        for nxt in self.pieces[1:]:
            if claimed < nxt.from_sec:
                break
            leg = nxt
        return max(0.0, leg.at(claimed))

    def starts(self, claimed: Mapping[int, float]) -> dict[int, float]:
        """Every claimed line start on our clock, keyed as it came in (`Line.index`)."""
        return {index: self.at(start) for index, start in claimed.items()}

    def windows(self, windows: Mapping[int, tuple[float, float]]) -> dict[int, tuple[float, float]]:
        """Every claim window on our clock. The end is held at or after the start, as the caller builds
        them: a zero-length window is a claim with no duration, a backwards one is not representable."""
        out: dict[int, tuple[float, float]] = {}
        for index, (start, end) in windows.items():
            at = self.at(start)
            out[index] = (at, max(self.at(end), at))
        return out


#: The map that moves nothing. What a caller with no claims, too few pairs or no winning candidate uses.
IDENTITY = ClaimMap()


def consensus(
    ours: Mapping[int, float],
    claimed: Mapping[int, float],
    *,
    envelope_lag: float | None = None,
    tolerance_sec: float = AGREE_TOLERANCE_SEC,
    piecewise: bool = False,
) -> ClaimMap:
    """The map to put `claimed` on the clock `ours` is measured in, by consensus over candidate maps.

    Both are keyed by the text's ORIGINAL line index and paired by index, never by order; lines only one side
    has are ignored. `envelope_lag` is the claims' own lag on the AUDIO, in seconds to ADD to a claim,
    and `piecewise` admits the change-point arm.
    """
    pairs = sorted((float(claimed[i]), float(ours[i])) for i in claimed if i in ours)
    if len(pairs) < MIN_PAIRS:
        return ClaimMap(
            pairs=len(pairs),
            why=f"claims left on their own clock: {len(pairs)} paired line(s), {MIN_PAIRS} needed to map",
        )

    def leg(offset: float, scale: float = 1.0) -> Piece:
        return Piece(
            from_sec=0.0,
            offset_sec=offset,
            scale=scale,
            inliers=_inliers(pairs, offset, scale, tolerance_sec),
            pairs=len(pairs),
        )

    # THE MARGIN FIRST, because the mode candidates are offered against it (`_densest_offset`): a window that
    # is not separated from the rest of the differences by more than the vote's own margin is not a mode.
    margin = max(MIN_GAIN_LINES, int(MIN_GAIN_SHARE * len(pairs)))
    # IN PREFERENCE ORDER: `max` keeps the FIRST maximal element, so a tie goes to no-shift, then to the
    # lag measured on the audio, ahead of the four fitted against our own decode (see the docstring), and
    # within those to the estimator that does not shop around for its offset.
    candidates: list[tuple[str, Piece]] = [(NO_SHIFT, leg(0.0))]
    if envelope_lag is not None:
        candidates.append((ENVELOPE_LAG, leg(float(envelope_lag))))
    candidates.append((DECODE_MEDIAN, leg(_offset_for(pairs, 1.0))))
    mode = _densest_offset(pairs, tolerance_sec, margin)
    if mode is not None:
        candidates.append((DECODE_MODE, leg(mode)))
    scale = theil_sen(pairs)
    if scale is not None:
        candidates.append((TEMPO, leg(_offset_for(pairs, scale), scale)))
        tempo_mode = _densest_offset(pairs, tolerance_sec, margin, scale)
        if tempo_mode is not None:
            candidates.append((TEMPO_MODE, leg(tempo_mode, scale)))

    baseline = candidates[0][1].inliers
    name, best = max(candidates, key=lambda got: got[1].inliers)
    legs: tuple[Piece, ...] = (best,)

    if piecewise:
        split = _split(pairs, 0.0, tolerance_sec, MAX_PIECES)
        explained = sum(piece.inliers for piece in split)
        if len(split) > 1 and explained >= best.inliers + margin and _monotonic(split):
            name, legs = PIECEWISE, split

    explained = sum(piece.inliers for piece in legs)
    floor = MIN_INLIER_SHARE * len(pairs)
    # THE THREE GUARDS, each with its own sentence on the trail: a map refused for its gain, one refused for
    # its absolute quality and one that would have moved nothing are different facts about a sheet, and a
    # single "under the margin" note for all three sent an operator looking for the wrong thing.
    gained = explained >= baseline + margin
    good = explained >= floor
    moves = _moves(legs, pairs)
    applied = gained and good and moves
    shape = " | ".join(piece.why() for piece in legs)
    if applied:
        why = (
            f"claims mapped onto our clock by {name} {shape}: {explained} of {len(pairs)} paired lines "
            f"explained within {tolerance_sec:.2f}s against no-shift's {baseline} (margin {margin})"
        )
    elif gained and not good:
        why = (
            f"claims left on their own clock: the best of {len(candidates)} candidate maps ({name} "
            f"{shape}) beats no-shift's {baseline} but explains only {explained} of {len(pairs)} paired "
            f"lines within {tolerance_sec:.2f}s — under the {MIN_INLIER_SHARE:.0%} floor, so it is the best "
            "of several poor candidates rather than this sheet's clock"
        )
    elif gained and good:
        why = (
            f"claims left on their own clock: the winning map ({name} {shape}) moves no paired claim by "
            f"{MOVE_FLOOR_SEC:.2f}s, so there is nothing to rebind"
        )
    else:
        why = (
            f"claims left on their own clock: the best of {len(candidates)} candidate maps ({name} "
            f"{shape}) explains {explained} of {len(pairs)} paired lines against no-shift's {baseline}, "
            f"under the {margin}-line margin"
        )
    return ClaimMap(
        pieces=legs if applied else (),
        applied=applied,
        candidate=name if applied else NO_SHIFT,
        inliers=explained,
        baseline=baseline,
        pairs=len(pairs),
        margin=margin,
        why=why,
    )


def _inliers(pairs: Sequence[tuple[float, float]], offset: float, scale: float, tolerance_sec: float) -> int:
    """Paired lines a leg explains: |ours - mapped claim| within tolerance, on the CLAMPED value the caller
    will apply, so a map that pushes early claims below zero is scored as it will behave — which a sheet
    opening at `[00:00.00]` over a song that sings immediately really reaches."""
    return sum(1 for theirs, ours in pairs if abs(ours - max(0.0, theirs * scale + offset)) <= tolerance_sec)


def _offset_for(pairs: Sequence[tuple[float, float]], scale: float) -> float:
    """median(ours - scale x claimed): the offset that goes with a scale. The MEDIAN for `place`'s reason —
    an LRC commonly carries one or two wildly wrong lines and a mean follows them."""
    return float(median(ours - scale * theirs for theirs, ours in pairs))


def _densest_offset(
    pairs: Sequence[tuple[float, float]], tolerance_sec: float, margin: int, scale: float = 1.0
) -> float | None:
    """The offset the MOST paired lines agree on AT `scale`: the median of the densest `2 x tolerance` window
    of `ours - scale x claimed` — a MODE, not a location fit.

    None on two refusals, both load-bearing: NOT A FIT, and NOT A MODE, this being the one candidate CHOSEN by
    maximising a count (docs/arch/04-alignment.md §7).
    """
    deltas = sorted(ours - scale * theirs for theirs, ours in pairs)
    width = 2.0 * tolerance_sec
    best: tuple[int, int, int] = (0, 0, 0)  # count, left, right — the count decides, ties below
    best_offset = 0.0
    right = 0
    for left in range(len(deltas)):
        right = max(right, left)
        while right < len(deltas) and deltas[right] <= deltas[left] + width:
            right += 1
        count = right - left
        if count < best[0]:
            continue
        offset = float(median(deltas[left:right]))
        if count > best[0] or abs(offset) < abs(best_offset):
            best, best_offset = (count, left, right), offset
    count, left, right = best
    if count < MIN_PAIRS:
        return None
    widened = sum(
        1 for delta in deltas if deltas[left] - tolerance_sec <= delta <= deltas[right - 1] + tolerance_sec
    )
    return None if widened - count >= margin else best_offset


def _moves(pieces: Sequence[Piece], pairs: Sequence[tuple[float, float]]) -> bool:
    """Does the map move any paired claim by at least `MOVE_FLOOR_SEC`? A scale is not "small" just because
    it is near 1.0 — 0.2% over a 200 s song is 0.4 s at the end — so the test is on the claims, not the
    coefficients."""
    mapped = ClaimMap(pieces=tuple(pieces), applied=True)
    return any(abs(mapped.at(theirs) - theirs) >= MOVE_FLOOR_SEC for theirs, _ours in pairs)


def _monotonic(pieces: Sequence[Piece]) -> bool:
    """Does the map keep EVERY claim in the order the sheet has them — not just the paired ones?

    A piecewise map with a step DOWN can swap two claims across a leg boundary, so this only ever refuses a
    split. TESTED ON THE BOUNDARIES rather than on the pairs, which passed whenever no paired claim sat in a
    step's shadow: a leg is increasing within its own span, so comparing two legs there is exact.
    """
    for previous, nxt in zip(pieces, pieces[1:], strict=False):
        if nxt.at(nxt.from_sec) < previous.at(nxt.from_sec):
            return False
    return all(piece.scale > 0.0 for piece in pieces)


def _split(
    pairs: Sequence[tuple[float, float]], from_sec: float, tolerance_sec: float, budget: int
) -> tuple[Piece, ...]:
    """The piecewise arm: recursive change-point split of one claim-ordered run into offset legs.

    One offset per leg and no per-leg scale: the shapes this arm exists for are STEPS, and a slope over
    `MIN_PIECE_PAIRS` lines is a fit through noise.
    """
    offset = _offset_for(pairs, 1.0)
    whole = Piece(
        from_sec=from_sec,
        offset_sec=offset,
        inliers=_inliers(pairs, offset, 1.0, tolerance_sec),
        pairs=len(pairs),
    )
    if budget < 2 or len(pairs) < 2 * MIN_PIECE_PAIRS:
        return (whole,)

    best: tuple[int, int] | None = None  # (lines the split explains, where it cuts)
    for cut in range(MIN_PIECE_PAIRS, len(pairs) - MIN_PIECE_PAIRS + 1):
        left, right = pairs[:cut], pairs[cut:]
        explained = _inliers(left, _offset_for(left, 1.0), 1.0, tolerance_sec) + _inliers(
            right, _offset_for(right, 1.0), 1.0, tolerance_sec
        )
        if best is None or explained > best[0]:
            best = (explained, cut)
    # The same margin the whole map faces, per run: a change point must earn its leg.
    if best is None or best[0] - whole.inliers < max(MIN_GAIN_LINES, int(MIN_GAIN_SHARE * len(pairs))):
        return (whole,)
    cut = best[1]
    return _split(pairs[:cut], from_sec, tolerance_sec, budget // 2) + _split(
        pairs[cut:], pairs[cut][0], tolerance_sec, budget // 2
    )
