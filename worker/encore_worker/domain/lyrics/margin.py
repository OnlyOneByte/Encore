"""How AMBIGUOUS a line's placement was, and the grading rule that reads it (review §3.7, W6).

THE PROBLEM THIS EXISTS FOR. Grading used to fall back, on a line the claims could not corroborate, to
"is this line's text repeated in the sheet?" — and that rule is AT CHANCE. The review measured 12.3% of the
lines it graded `high` more than 0.5 s off against 12.6% of the ones it graded `low`, over 29 songs; through
the shipped `time_text` over the 20 Jamendo songs' untimed-text path it reads 11.88% against 12.86% on 866
published lines. It flags half a repeat-heavy sheet and tells you nothing about either half, so the TV could
not caveat a line and the ladder could not trust one.

WHAT THE MARGIN IS. Take the forced alignment's own trellis and ask a second question of it: how much
WORSE is the best path that puts this line's first character at least `WINDOW_SEC` away from where the
chosen path put it? That number — the max-marginal margin, in nats — is the score the decode would have
had to give up to place the line somewhere else. It is near zero exactly when the audio contains another
place the line fits as well, which is failure F2's signature (a chorus bound to the wrong occurrence), and
it is large when the decode had no choice.

AT THE SHIPPED REACH IT IS THE BROADER STATISTIC, and `WINDOW_SEC`'s own docstring is where that was
measured: at 3 s the competing placement is necessarily a different OCCURRENCE, which is review §3.7's
reading and the one that predicts gross lines best (AUROC 0.941); at 1 s it also catches the line whose
onset is merely a second adrift, and that is what the rule is judged on.

WHAT IS NEW AGAINST F3 AND F4, stated because both were measured and REJECTED before this:

  * F3 rejected the per-line PATH SCORE (`Line.score`, the mean per-frame log-probability). The margin is
    not a path score. A path score asks "how well do these frames match these letters" — loud, clear
    singing of the wrong occurrence scores well — while the margin asks "could these letters have gone
    somewhere else", which is a property of the whole song's competing placements and not of the frames
    the line landed on. Measured on gross lines, the review's numbers: margin AUROC 0.934 (Jamendo) /
    0.898 (YouTube) against the path score's 0.78 / 0.87, and F3's rejection of the score came from ONE
    song. RE-MEASURED HERE through the shipped `time_text` over the same 20 Jamendo songs, 866 published
    lines: the margin reads 0.941 at review §3.7's 3 s reach and 0.904 at the shipped 1 s, the score 0.719.
    That 0.941 against the review's 0.934, from an independent implementation of the same statistic, is the
    check that this trellis is CTC's. So the score is kept as a WEAK second signal (it wins on hello where
    the margin does not, and loses on bad-guy where the margin wins) and never as the rule.
  * F4 rejected chars-per-second. Also a property of where the line landed, not of what else it could
    have matched.

THE RULE IS ONE THRESHOLD PER SIGNAL, deliberately (the critics rejected a fitted logistic: its
normalisation, fitted on training songs only, failed its own reject gates). `low_lines` demotes a line
when `margin < MIN_MARGIN_NATS` OR its raw score sits more than `SCORE_DROP_NATS` below the song's median
score. The review measured that pair flagging 94% of gross lines at 17% of good ones on Jamendo (71% / 21%
on YouTube). End to end here, on top of the grading it joins: `high` lines more than 2 s off 23 -> 0 and
more than 0.5 s off 11.88% -> 2.80%, for coverage 51.5% -> 33.0% (20 Jamendo songs, blind claims, base
model, leave-one-song-out; `MIN_MARGIN_NATS` carries the fit). THE TWO HALVES EARN DIFFERENT PARTS OF IT:
the score half alone takes the 23 gross `high` lines to 11 and coverage to 44.5%, and the margin takes the
remaining 11 to zero. Neither is redundant.

WITHIN ONE SONG ONLY, like every other score in this package — see `MIN_MARGIN_NATS` for why a threshold on
a log-probability gap is nonetheless portable, and `SCORE_DROP_NATS` for the half that is explicitly
relative to the song's own median.

COST. Two Viterbi passes over the same trellis the decode already built — one forward, one backward —
with only the queried columns kept, so the memory is O(states + frames x lines) rather than the
O(frames x states) a full trellis would need (a 5-minute song with 2000 characters would be 240 MB of
that). Pure numpy, vectorised over STATES with a Python loop over frames: 0.43 s median and 0.81 s max per
song over the 20 Jamendo songs (measured here through `AlignStepsImpl.time_text`, 20 ms frames, 8.5-12k
frames a song), and 1.16 s on `hello` at 18.3k frames, the longest song measured. The review's numba
prototype read 0.09-0.13 s median / ~1 s max, so this is ~4x its median and the same order at the tail.
No numba: the critics rejected the decoder swap, and this is a second read of a matrix the model pass
already paid ~4 s for. `conf-legacy` is the off switch for a box that cannot pay it.
"""

from __future__ import annotations

import difflib
import math
from collections.abc import Mapping, Sequence
from statistics import median

import numpy as np

#: How far a competing placement must be from the chosen one to count as a DIFFERENT placement, seconds.
#:
#: MEASURED, and it decided the whole rule. Four reaches over the 20 Jamendo songs' blind decode, 866
#: published lines, base model, through the shipped `time_text` (`_review-scratch/w6-conf/window.py`):
#:
#:     W        AUROC gross(>2 s)   AUROC bad(>0.5 s)   median margin   LOSO bad at 51.5% coverage
#:     1.0 s          0.904               0.821               27 nats        3.59%, 0 gross   <- shipped
#:     1.5 s          0.935               0.787               56             4.48%, 0
#:     3.0 s          0.941               0.771              126             5.38%, 0
#:     6.0 s          0.851               0.711              257             6.73%, 6
#:
#: (51.5% is the coverage of the rule this joined, so the last column is §3.7's "at equal coverage"
#: reject-if, whose bound on this corpus is 5.94% — half of 11.88%.)
#:
#: 3.0 s IS THE REVIEW'S READING AND IT REPRODUCES: its gross AUROC of 0.941 here is the 0.934 review §3.7
#: measured with a numba prototype, which is the independent check that this kernel decodes the same
#: trellis. It is not what ships, because the rule is judged on `bad` (>0.5 s) and there the WIDE window
#: loses: at 3 s a competing placement is necessarily another OCCURRENCE, so the statistic goes blind to the
#: failure where a line's onset is merely a second out. At 1 s it measures how far the start could move AT
#: ALL before the trellis objected — occurrence ambiguity included, since a wrong occurrence is an enormous
#: move — and it is a third better on the reject-if's own number (3.59% against 5.38%) for four points of
#: gross AUROC. 6 s is past the point where any alternative exists for a line near either end of a song, and
#: it is worse on every column.
#: THE COST IS COVERAGE: at 1 s the shipped rule grades 33.0% of blind lines `high` against 38.8% at 3 s.
#: Fewer word wipes, and the ones left are twice as likely to be right (2.80% bad against 5.65%).
WINDOW_SEC = 1.0

#: Nats of path score a line must have to spare before its placement is called unambiguous. Below it, the
#: decode could have put this line somewhere else for nearly the same score, and nothing here can say which
#: placement was sung.
#:
#: FITTED LEAVE-ONE-SONG-OUT on the 20 Jamendo songs' blind decode, and the objective is review §3.7's own
#: reject-if rather than the number the gate then reports: the SMALLEST M whose training `high` set holds no
#: line more than 2 s off. All 20 folds chose 10 — the same figure §3.7 arrived at independently — so there
#: is nothing to average. Held out, the rule reads 33.0% coverage, 2.80% of `high` lines more than 0.5 s off
#: and ZERO more than 2 s off, against the rule it joined reading 51.5% / 11.88% / 23 on the same lines
#: (`docs/benchmarks/forced-alignment/README.md`, "The confidence rule", carries the sweep and the two
#: halves' separate contributions). The sweep is flat from 10 to 40 nats (bad 2.6-3.1%, gross 0 throughout),
#: so the constant is not on a cliff; below it the gross lines come back (M=5 leaves 2, M=2 leaves 4).
#:
#: WITHIN ONE SONG, LIKE EVERY SCORE HERE, and this is the one place that needs an argument: a margin is a
#: sum of log-probabilities, so its SCALE moves with the bundle and the song, while a THRESHOLD on it is
#: read as if it did not. What makes 10 nats portable is that it is a floor on a GAP — the evidence the
#: decode would forfeit to move one line — and the corpus's spread is wide relative to it (median 27 nats,
#: p10 4), so the songs do not stack up against the threshold from one side.
#: MEASURED ON A SECOND BUNDLE, which is the only way to test that, and it is the bundle this wave is
#: flipping on: on HUBERT_ASR_LARGE over the same 20 songs the margins read median 33 nats and p10 5 — the
#: SAME scale — and the rule at the same M reads 34.7% coverage / 2.66% bad-among-high / ZERO gross against
#: that bundle's own control at 51.4% / 8.97% / 20 (whose 8.97% against 9.26% bad-among-LOW is the at-chance
#: reading again). Nothing was re-fitted per bundle, and nothing needed to be.
MIN_MARGIN_NATS = 10.0

#: How far below the song's own MEDIAN line score a line's raw score must sit to be doubted, nats per
#: frame. The review's second signal, unchanged at 1.0: it is the same shape as the never-sung rule's
#: `_NEVER_SUNG_SCORE_GAP` and the adoption test's `_ADOPT_SCORE_GAP` in `steps/align_steps.py` (both
#: relative to the same median) and it catches the case the margin cannot — a line the model heard badly
#: everywhere, so no placement is good and the gap between the best two is small in absolute terms.
SCORE_DROP_NATS = 1.0

#: Two lines whose texts are this similar are "the same line" to `fuzzy_repeats`. `difflib`'s ratio, on the
#: normalised text: 0.8 is the review's figure.
REPEAT_RATIO = 0.8

#: Score difference below which two frames of a max-marginal curve are the SAME placement. The curve is a
#: max over paths, so the chosen character's whole span sits at the maximum (CTC is peaky — 90.9% of char
#: spans are one frame — but a held vowel's is not), and a "competing" placement one frame to the right of
#: the chosen one is the same path holding the character a frame longer. Exact arithmetic would make the
#: plateau exactly equal; this is float64 slack over a sum of ~10^4 log-probabilities.
_TIE_NATS = 1e-6


def placement_margins(
    log_probs: np.ndarray,
    targets: Sequence[int],
    first_targets: Mapping[int, int],
    *,
    blank: int = 0,
    frame_sec: float,
    window_sec: float = WINDOW_SEC,
) -> dict[int, float]:
    """`{line index: nats the best path gives up to move that line at least `window_sec`}`.

    `log_probs` is the emission matrix the decode ran on (frames x vocab), `targets` the character targets
    it was given — `generate.char_targets().targets`, separators included, because the trellis is over that
    exact sequence — and `first_targets` maps a line index to the position in `targets` of its first
    character (`generate.CharTargets.first_char_target`).

    THE TRELLIS IS CTC's OWN, and it must be, or the margin would describe a different decode than the one
    that produced the timings: states are the extended sequence `blank t1 blank t2 ... blank`, a path may
    stay, advance one, or skip a blank between two DIFFERENT targets, and it starts at the first blank or
    the first target and ends at the last of each. That is exactly `torchaudio.functional.forced_align`'s
    contract (`adapters.ml.forced_align_decoder`), so the maximum over this trellis IS the score of the
    path the decode chose.

    EMPTY `{}` when there is nothing to measure — no targets, no frames, a non-2D matrix, a blank column
    the matrix does not have, a `frame_sec` at or below zero, or a target sequence too long for the frames
    (the decode would have raised). The caller must treat an absent line as "not measured" and grade it as
    it did before: a margin that could not be computed is not evidence of ambiguity.

    `math.inf` for a line that HAS no competing placement — every alternative path is impossible, which
    happens when the line sits so close to an end that moving it `window_sec` leaves no room for the rest
    of the sequence. Infinite margin, and the rule reads it as unambiguous, which is what it is.
    """
    matrix = np.asarray(log_probs, dtype=np.float64)
    count = len(targets)
    if matrix.ndim != 2 or count == 0 or matrix.shape[0] == 0 or frame_sec <= 0:
        return {}
    frames, vocab = matrix.shape
    if not 0 <= blank < vocab:
        return {}
    encoded = np.asarray(targets, dtype=np.intp)
    if encoded.min() < 0 or encoded.max() >= vocab:
        return {}
    queried = {index: position for index, position in first_targets.items() if 0 <= position < count}
    if not queried:
        return {}

    states = 2 * count + 1
    #: Which vocabulary column each trellis state emits (even = blank, odd = that target).
    labels = np.empty(states, dtype=np.intp)
    labels[0::2] = blank
    labels[1::2] = encoded
    #: May a path reach state s from s-2, skipping the blank between two targets? Only between DIFFERENT
    #: targets: CTC needs a blank to separate a repeat, or the two would merge into one span.
    skip_into = np.zeros(states, dtype=bool)
    if count > 1:
        skip_into[3::2] = encoded[1:] != encoded[:-1]
    #: The mirror for the backward pass: may a path leave s for s+2?
    skip_from = np.zeros(states, dtype=bool)
    skip_from[: states - 2] = skip_into[2:]

    columns = np.array([2 * queried[index] + 1 for index in sorted(queried)], dtype=np.intp)
    ahead = np.empty((frames, len(columns)), dtype=np.float64)
    behind = np.empty((frames, len(columns)), dtype=np.float64)
    #: One scratch buffer, `-inf` at both ends, so a shift by one or two states is a SLICE rather than a
    #: per-frame concatenate: `window[2:]` is `previous[s]`, `window[1:-1]` is `previous[s-1]`.
    window = np.full(states + 2, -np.inf, dtype=np.float64)

    # ── forward: the best score of any path over frames 0..f that has state s at frame f ──
    alpha = np.full(states, -np.inf, dtype=np.float64)
    alpha[0] = matrix[0, blank]
    alpha[1] = matrix[0, labels[1]]
    ahead[0] = alpha[columns]
    for frame in range(1, frames):
        window[2:] = alpha
        best = np.maximum(window[2:], window[1:-1])
        np.maximum(best, window[:-2], out=best, where=skip_into)
        alpha = best + matrix[frame, labels]
        ahead[frame] = alpha[columns]
    if not math.isfinite(max(alpha[states - 1], alpha[states - 2])):
        return {}  # the targets do not fit these frames: there is no chosen path to compare against

    # ── backward: the best score of any path over frames f..F-1 that has state s at frame f ──
    # The buffer is re-floored first: the forward pass wrote its last two states where the backward pass
    # reads `-inf` for "there is no state s+1 / s+2", and a stale alpha there would let every path leave
    # the sequence's end.
    window.fill(-np.inf)
    beta = np.full(states, -np.inf, dtype=np.float64)
    beta[states - 1] = matrix[frames - 1, labels[states - 1]]
    beta[states - 2] = matrix[frames - 1, labels[states - 2]]
    behind[frames - 1] = beta[columns]
    for frame in range(frames - 2, -1, -1):
        window[:states] = beta
        best = np.maximum(window[:-2], window[1:-1])
        np.maximum(best, window[2:], out=best, where=skip_from)
        beta = best + matrix[frame, labels]
        behind[frame] = beta[columns]

    # The max-marginal: alpha and beta both charge frame f's emission, so one copy comes back off.
    curves = ahead + behind - matrix[:, labels[columns]]
    reach = max(1, round(window_sec / frame_sec))
    out: dict[int, float] = {}
    for position, index in enumerate(sorted(queried)):
        out[index] = _gap(curves[:, position], reach)
    return out


def _gap(curve: np.ndarray, reach: int) -> float:
    """`peak - (the best value at least `reach` frames outside the peak's own plateau)`, in nats.

    THE PLATEAU, not the single argmax frame: every frame the chosen character occupies scores the peak,
    and masking one of them would score "the same path, holding the character one frame longer" as a
    competing placement — which would read a held vowel as ambiguous. The run is taken around the argmax,
    so a SECOND plateau elsewhere (a perfectly ambiguous repeat, two placements scoring alike) is outside
    the mask and yields a margin of zero, which is the honest answer.
    """
    peak = float(curve.max())
    if not math.isfinite(peak):
        return math.inf
    near = curve >= peak - _TIE_NATS
    top = int(np.argmax(curve))
    before = np.flatnonzero(~near[:top])
    after = np.flatnonzero(~near[top + 1 :])
    first = int(before[-1]) + 1 if before.size else 0
    last = int(after[0]) + top if after.size else len(curve) - 1
    low = max(0, first - reach)
    high = min(len(curve) - 1, last + reach)
    outside = [curve[:low], curve[high + 1 :]]
    best = max((float(part.max()) for part in outside if part.size), default=-math.inf)
    return math.inf if not math.isfinite(best) else peak - best


def low_lines(
    margins: Mapping[int, float],
    scores: Mapping[int, float],
    *,
    min_margin_nats: float = MIN_MARGIN_NATS,
    score_drop_nats: float = SCORE_DROP_NATS,
) -> frozenset[int]:
    """The line indexes THIS rule doubts: `margin < min_margin_nats` OR the raw score more than
    `score_drop_nats` below the song's median score (review §3.7's two-signal rule).

    `scores` is every published line's `Line.score` — the median is taken over ALL of them, so the
    reference is the song's own level and not the level of the lines that happen to have a margin.

    A LINE WITH NO MARGIN IS NOT DOUBTED BY THE MARGIN HALF. `placement_margins` returns nothing at all
    when it cannot measure the matrix, and one line can be missing on its own (a line the decode dropped
    for having no alignable character). Treating "not measured" as "ambiguous" would demote every line of
    every song on a matrix this could not read, which is a silent failure mode dressed as caution.

    FEWER THAN 4 LINES AND THE SCORE HALF ABSTAINS, as the never-sung rule does with the same median:
    a median over two or three lines describes nothing. The margin half still applies — it is a per-line
    statistic and needs no population.
    """
    if not margins and not scores:
        return frozenset()
    doubted = {index for index, gap in margins.items() if gap < min_margin_nats}
    if len(scores) >= 4:
        floor = median(scores.values()) - score_drop_nats
        doubted |= {index for index, score in scores.items() if score < floor}
    return frozenset(doubted)


def fuzzy_repeats(line_texts: Mapping[int, str], *, ratio: float = REPEAT_RATIO) -> frozenset[int]:
    """Line indexes whose text nearly repeats another line's (`difflib` ratio >= `ratio`).

    A FEATURE, NOT A DEFAULT (review §3.7's optional half, measured and left off — the
    `conf-fuzzy-repeats` arm in `host.config.ALIGN_EXPERIMENTS` carries the numbers). Exact repetition
    misses "and I never wanna hear you say" against "'cause I never wanna hear you say", which is the same
    chorus line and the same occurrence ambiguity; the review measured near-matching finding 50 more such
    lines, 8 of them blind-gross lines graded `high` today, against 42 correct lines it would demote.

    QUADRATIC in the line count and deliberately so: `difflib.SequenceMatcher`'s `real_quick_ratio` bound
    makes each pair cheap, a sheet is under 200 lines, and an index over shingles would be a second
    definition of "nearly the same line" to keep in step with this one.
    """
    normalized = {index: " ".join(text.lower().split()) for index, text in line_texts.items()}
    order = [index for index in sorted(normalized) if normalized[index]]
    out: set[int] = set()
    for position, index in enumerate(order):
        for other in order[position + 1 :]:
            matcher = difflib.SequenceMatcher(None, normalized[index], normalized[other])
            if (
                matcher.real_quick_ratio() >= ratio
                and matcher.quick_ratio() >= ratio
                and matcher.ratio() >= ratio
            ):
                out.add(index)
                out.add(other)
    return frozenset(out)
