"""Putting a sheet's CLAIMED timings on OUR clock, ONCE, before anything reads them.

WHY THIS EXISTS (review H1, §3 item 2; W2). Stage 3 grades the claims and never moves them — that is the
role reversal `reconcile` describes, and it is right for GRADING. But stage 4 does not only grade: it
REPAIRS inside claim windows (R1, R2, R4), it ADOPTS a claim span outright where the window decode heard
nothing, and it reads a claim's position back when it decides whether a repaired line may be graded
`high`. Every one of those ran in the claim's RAW clock, while the one number that could have fixed it was
computed and discarded three times over: `reconcile` fits `offset_sec` and uses it only to pick which
COARSE lines to repair, fits `scale` and never applies it, and R1 measures the claims' own envelope lag
(`claim_fit.seconds`) and keeps only its correlation. The measured consequence, on the review's harness:
claims 1.5 s late publish every line 1.5 s late AND pass the envelope gate at lag -1.50 s (repro s8), a
+1.3 s LRC gets a line adopted 1.3 s late (s3), and +3 s claims produce 440 gross lines.

So the claims are mapped here, once, before the first `reconcile` — and only the CLAIMS move. Our own
timings are never touched by this module: an offset sheet is still a fact about the sheet (`Reconciliation`
OFFSET / DRIFT), and what the map buys is that every repair window, every adopted span and every
corroboration test afterwards is asking about the same instant the audio does.

THE ESTIMATOR IS A VOTE, NOT A FIT (RANSAC's inlier count, Fischler & Bolles 1981). Three candidate maps
are already computed elsewhere in the step, so consensus costs no model time and no second decode:

    no-shift        identity. The null hypothesis, and the one the margin below protects.
    envelope-lag    `activity.fit_shift` of the audio's own vocal activity against
                    `activity.expected_envelope(claim spans)` — the claims' lag measured on the AUDIO, the
                    only candidate independent of our decode. PLAN fact 7 puts its residual at 10-20 ms on
                    a vocals stem (140-150 ms on a mix, where an instrumental bed fills the silences).
    decode-median   median(ours - claimed) over the paired lines, the estimator `reconcile` and
                    `place.estimate_shift` already use, robust to a few wild lines.
    tempo           a BOUNDED Theil-Sen slope (`reconcile.theil_sen`, Sen 1968) with its own median offset:
                    the DRIFT case, a master cut at another tempo. DALI fits karaoke timings onto other
                    audio the same way (offset x frame rate:
                    https://transactions.ismir.net/articles/10.5334/tismir.30).

Each is scored by how many paired lines it explains within `AGREE_TOLERANCE_SEC` — reconcile's own
corroboration band, imported rather than copied, because "explained" here means exactly "a line
`reconcile` will call corroborated". The slope estimator is imported from there too, and its band
(`reconcile.MAX_SCALE_DRIFT`, 5%) is the one measured here: reconcile classifies DRIFT with the same fit
(review M4's "ONE implementation"), so a scale this module would move windows by is a scale that module
would call a drift. Ties go to the EARLIER candidate in that list: no-shift first (the
conservative answer), then the lag measured on the audio ahead of the two fitted against our own decode.
That order is also the review's strongest objection made harmless — "the gain is measured on a pure
constant offset, which the median undoes almost by construction" — since where the audio and the median
agree on the lines they explain, the audio's estimate is the one applied.

THE MARGIN, because a map MOVES claims that may already be right: the winner is applied only if it
explains at least `max(MIN_GAIN_LINES, MIN_GAIN_SHARE x pairs)` MORE lines than no-shift, and only if it
actually moves a paired claim by `MOVE_FLOOR_SEC` or more. Same asymmetry `place.MIN_SHIFT_SEC` and
`activity.MIN_CORRELATION` are set from: refusing a good map costs the raw clock we have today, while
accepting a bad one moves a sheet that was correct.

AND THE FLOOR, because a margin only grades the GAIN (W2 review r1). Both terms above are differences and
distances; neither asks how good the winner actually is, so "the best of four noisy candidates" could move a
sheet on two explained lines out of fifty as long as no-shift explained none of them — which is the shape a
poor blind decode against a CORRECT sheet takes. `MIN_INLIER_SHARE` is the absolute quality gate the vote was
missing: below a fifth of the paired lines explained, the winner is not a clock, and abstaining leaves the
claims where the human put them.

MEASURED (review §3.2, the scratch harness `_review-scratch/pe-acc/e2e2.py` on the base model, whose patch
`patch_claimclock2.py` is this module's prototype):

    gain    +19.0 pt within +/-500 ms at +1.5 s, +11.0 at -1 s, +19.8 at +3 s; gross lines at +3 s
            440 -> 25 (HuBERT-L 370 -> 6); no `high` gross line left in any claim mode.
    cost    truth mode 89.3 -> 88.5 within +/-500 ms, carried by two songs, on both of which the map sides
            with a MEASUREMENT against the metric's ruler — and on the 12 YouTube songs that ruler is the
            caption track the map is correcting, so the loss is partly the metric's.

W2's OWN targeted probes confirm both halves on the shipped path (`--level time_text`, per song against
`results/w3-time_text.json`; the tables and the runs are in `docs/benchmarks/forced-alignment/README.md`,
section "The claim clock", and the corpus row is the wave's bench run):

    Jamendo, measured word onsets, 4 songs x 5 modes: truth UNCHANGED (+0.00 pt within +/-500 ms and
    +/-300 ms on all four), no song gains a gross line in any mode, off3 -4/-4/-6/-15 gross with +5.0 to
    +50.0 pt within +/-500 ms, tempo102 -4/-14/-24/-31 gross with +75.0 to +95.7 pt (what the bounded scale
    buys: a 2% sheet used to leave 4-31 lines over 2 s out).
    YouTube, caption truth, believer and bad-guy: truth -4.16 pt (50 -> 47 lines) and -10.14 pt
    (13 -> 6 lines, the review's number exactly), against +8.7 to +23.6 pt at off15/off3 and 48 gross lines
    removed at off3. believer's SDH captions lead by ~0.5 s (the map reads `tempo +0.50s scale 0.9987`, 52
    of 72 lines explained against no-shift's 12); bad-guy's decode sits 0.86 s later than its captions
    (`decode-median +0.86s`, 52 of 69 against 1).

DIFFERENCES FROM THE PROTOTYPE, each because the prototype was a 20-line patch and this is the shipped
path: `MIN_PAIRS` is 5, not `reconcile.MIN_PAIRS` (a map that moves the claims is a fit, and review M4's
floor for a fitted verdict — `reconcile.MIN_FITTED_PAIRS`, the same number — applies at least as hard to one
that ACTS; the bench corpus's smallest paired series is 7 lines, Kinematic under `drop50`, so nothing
measured moves); the tempo candidate is new (the review moved the scale fit to §3.11 because the measured
patch did not carry one); and the map is a sequence of legs rather than one offset, so the PIECEWISE arm
below is the same object with more than one.

PIECEWISE IS AN ARM, NOT THE DEFAULT (`Config.align_experiments`, `claimmap-piecewise`). Inserted
sections, a live rendition and a re-lineated sheet are STEPS, not one offset — but the critics measured a
change-point version WORSE on the unperturbed control, and a misbound repeat (failure F2) looks exactly
like a step to it, so it ships off until its own gates pass. Split only where a change point explains the
same margin more lines than the single best map, at most `MAX_PIECES` legs, at least `MIN_PIECE_PAIRS`
paired lines per leg, and never where the legs would map two claims out of order. MEASURED AGAIN IN W2 over
the 6 probe songs x their modes, arm and default on the same tree: every mode identical except `jit`, where
it moves two documents and both get worse (believer -1.39 pt within +/-500 ms; Avercage -2.42 pt and
-1.19 pt on words within +/-300 ms) — a jitter-disputed run is exactly the shape it mistakes for a step.

BOTH CONSUMERS TAKE THE SAME VOTE, with the reader's own band (W2). The global engine calls `consensus` once
before its first `reconcile`, scoring candidates in `AGREE_TOLERANCE_SEC` because `reconcile` is what reads
the map. The LINE_SYNC rung calls it too (`align_steps._line_sync_clock`), with its own blind decode as the
`ours` series and `align_steps._LINE_SYNC_NEAR_SEC` as the tolerance, because there the reader is that rung's
gate — and there the claims do not steer a repair, they ARE the published document. That rung placed them
with `_placed_by`'s unconditional activity shift until W2 (`ShiftFit.usable`, r >= 0.40, moved the sheet
whatever a vote would say), which is both of the things W3 measured on it: 23 published song-modes with no
line within +/-500 ms of truth and every line within 1 s (bad-guy shifted +0.72 s, numb +0.62 s — the decode
then reads the shifted claims as near, so both witnesses agree on one misplacement), and 12 right texts
refused for claims that were merely 1.5-3 s off or 2% fast. A wider band is also a stricter map: no-shift is
harder to beat at 1.0 s than at 0.25 s, which is what a map that MOVES WHAT PUBLISHES should want.

The PIECEWISE arm stays the global engine's alone: a leg boundary there moves a repair window, on the rung it
would move published timings, so it would owe its own `--sync-mode lines` corpus run before being an arm at
all.

WHAT STAYS RAW. The claims as the sheet gave them are kept by the caller for the trail and the report: the
offset we publish describes THE CLAIM (`place.residual_against`, `TimingReport.residual_sec`), and the
global engine deliberately reports no residual at all, so that `policy.decide` cannot offer RESHIFT for a
series this engine never searched. The map's own offset reaches the trail through `ClaimMap.why`.

PURE and DETERMINISTIC: floats, medians and comparisons only — no numpy, no wall clock, no random, so a
DBOS replay and a bench re-run map identically. The audio-side candidate is computed by the step (numpy
lives in `domain/audio/activity.py`) and passed in as one number.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from statistics import median

from encore_worker.domain.lyrics.reconcile import AGREE_TOLERANCE_SEC, MIN_FITTED_PAIRS, theil_sen

#: Minimum paired lines before this module will map anything. Higher than `reconcile.MIN_PAIRS`
#: deliberately (see the docstring's DIFFERENCES): reconcile only LABELS a series it cannot move, while a
#: map applied here moves every claim window and every adoptable span with it. IT IS `reconcile`'s FITTED
#: floor, not a second 5 that happens to agree (W2): review M4 set `MIN_FITTED_PAIRS` as the number of pairs
#: a FIT may be believed on, and a fit that ACTS cannot need fewer — so raising that floor raises this one,
#: which a duplicated literal would have silently left behind.
MIN_PAIRS = MIN_FITTED_PAIRS

#: The winner must explain this many more paired lines than no-shift — or this share of them, whichever is
#: larger (review §3.2: "max(2 lines, 5% of pairs)"). `int()`, not a ceiling, is the prototype's rule and
#: the one the measured numbers came from. WHICH TERM BINDS, measured on the committed rows
#: (`results/w2-line-gate.json`, 1056 cases, 7-236 paired lines — the corpus is not a 20-100 line population):
#: `int(0.05 x pairs)` passes 2 at exactly 60 pairs, so the 2-line floor binds below that and the share above
#: it, reaching 11 lines at 236 pairs (the largest margin any applied map faced is 10). The share is not
#: decoration — 23 of the 1056 cases are refused by it specifically, their gain clearing 2 and not the share
#: (Lower_Loveday at 217 pairs: gain 5, margin 10).
MIN_GAIN_LINES = 2
MIN_GAIN_SHARE = 0.05

#: ...and the winner must explain at least this SHARE of the paired lines outright, whatever its gain over
#: no-shift (W2 review r1). The margin above is a difference, so on a sheet our decode barely agrees with
#: anywhere, four candidates all explaining almost nothing still leave one of them 2 lines ahead — and that
#: one moves every claim window and every adoptable span. MEASURED on the rows taken BEFORE this floor existed
#: (`_runs/w2r-time_text/rows.jsonl`, 1088 cases — `results/w2-time_text.*` is the row WITH it, so the four
#: maps below are no longer in it), which is where 0.2 comes from: of the 245 maps applied there,
#: exactly four sit under a fifth of their pairs, and all four are the failure this floor exists for —
#: hello tempo102 `envelope-lag` 4/74 = 0.054 (25 gross lines), hello tempo098 `decode-median` 6/74 = 0.081
#: (31 gross), numb drop50 `envelope-lag` 2/17 = 0.118 (1 line of 17 within ±500 ms), one wrong-text sheet
#: 2/35 = 0.057. The lowest map worth keeping is well clear of it: never-be-alone's tempo098/102 at 11/45 =
#: 0.244 with 0 gross lines and 40 of 45 lines within ±500 ms — so 0.2 sits in an EMPTY band, 0.118 to 0.244,
#: and the corpus row with the floor on confirms it (241 maps applied, lowest share 0.244, none refused for
#: quality that any measurement wanted kept). At the LINE_SYNC rung (band `_LINE_SYNC_NEAR_SEC`, so shares run
#: higher) the floor is inert on every right text — the lowest applied right-text share over the 1056 gate
#: cases is 0.243, and re-measuring them with the floor on leaves all 188 applied right-text maps in place and
#: changes no right-text row — and it refuses 293 of the 402 maps it applied to WRONG texts, which only makes
#: that gate stricter.
MIN_INLIER_SHARE = 0.2

#: A map that moves no paired claim by at least this much is not applied, whatever it explains. One frame
#: of the activity envelope (`activity.HOP_SEC`), which is the quantisation floor of the envelope
#: candidate and finer than the decode median's own jitter.
MOVE_FLOOR_SEC = 0.02

#: How far the envelope candidate's correlation may sit below `activity.MIN_CORRELATION` (0.40) and still
#: be OFFERED. Deliberately weaker than that gate, and it is the prototype's number: a correlation there
#: only buys a candidate a place in the vote, and the vote — lines explained, against the margin — is what
#: decides. The step applies it, since the fit is measured on numpy-side data.
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
TEMPO = "tempo"
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
    """The map from a sheet's claimed clock onto ours, plus the vote that chose it.

    The identity (`IDENTITY`, and every abstention) has no legs and `applied` False, so `at` is exactly the
    claim: "we could not tell" and "it was already on our clock" read the same downstream, deliberately,
    because neither justifies moving anything.
    """

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

    `ours` is our own decode's line starts and `claimed` the sheet's, both keyed by the text's ORIGINAL
    line index (`Line.index`) — paired by index, never by order, for `reconcile`'s reason: one dropped
    decorative line would otherwise shear every comparison after it. Lines only one side has are ignored.

    `envelope_lag` is the claims' own lag measured on the AUDIO (`activity.fit_shift` of the audio's
    envelope against `activity.expected_envelope` of the claim spans), in seconds to ADD to a claim, or
    None when the caller could not measure it or its correlation sits under `MIN_ENVELOPE_CORRELATION`.

    `piecewise` admits the change-point arm (`Config.align_experiments`, `claimmap-piecewise`).
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

    # IN PREFERENCE ORDER: `max` keeps the FIRST maximal element, so a tie goes to no-shift, then to the
    # lag measured on the audio, ahead of the two fitted against our own decode (see the docstring).
    candidates: list[tuple[str, Piece]] = [(NO_SHIFT, leg(0.0))]
    if envelope_lag is not None:
        candidates.append((ENVELOPE_LAG, leg(float(envelope_lag))))
    candidates.append((DECODE_MEDIAN, leg(_offset_for(pairs, 1.0))))
    scale = theil_sen(pairs)
    if scale is not None:
        candidates.append((TEMPO, leg(_offset_for(pairs, scale), scale)))

    baseline = candidates[0][1].inliers
    margin = max(MIN_GAIN_LINES, int(MIN_GAIN_SHARE * len(pairs)))
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
    will apply, so a map that pushes early claims below zero is scored as it will behave.

    WHICH PAIR REACHES THE CLAMP (W2 review r2 — deleting it left the suite green, and the neighbouring case
    said "a paired claim never reaches the clamp", which is true of `at` but not of this). It needs a claim
    the leg sends below -tolerance whose line OUR decode put within tolerance of zero, and that is one real
    shape: a sheet otherwise late whose FIRST cue is stamped at 0.00 — the `[00:00.00]` an LRC commonly opens
    with — over a song that starts singing immediately. Measured on a 45-line sheet 5 s late with that opening
    stamp and a first line decoded at 0.1 s: the leg alone maps the cue to -5.0 s and the clamp makes it 0.0,
    which is where it will actually publish, so the score is 45 of 45 rather than 44."""
    return sum(1 for theirs, ours in pairs if abs(ours - max(0.0, theirs * scale + offset)) <= tolerance_sec)


def _offset_for(pairs: Sequence[tuple[float, float]], scale: float) -> float:
    """median(ours - scale x claimed): the offset that goes with a scale. The MEDIAN for `place`'s reason —
    an LRC commonly carries one or two wildly wrong lines and a mean follows them."""
    return float(median(ours - scale * theirs for theirs, ours in pairs))


def _moves(pieces: Sequence[Piece], pairs: Sequence[tuple[float, float]]) -> bool:
    """Does the map move any paired claim by at least `MOVE_FLOOR_SEC`? A scale is not "small" just because
    it is near 1.0 — 0.2% over a 200 s song is 0.4 s at the end — so the test is on the claims, not the
    coefficients."""
    mapped = ClaimMap(pieces=tuple(pieces), applied=True)
    return any(abs(mapped.at(theirs) - theirs) >= MOVE_FLOOR_SEC for theirs, _ours in pairs)


def _monotonic(pieces: Sequence[Piece]) -> bool:
    """Does the map keep EVERY claim in the order the sheet has them — not just the paired ones? A piecewise
    map with a step DOWN can swap two claims across a leg boundary, which would hand two repair windows to the
    wrong lines. A single leg with a positive scale cannot, so this only ever refuses a split.

    TESTED ON THE BOUNDARIES, not on a sample of the pairs (W2 review r1). This used to map the PAIRED claims
    and check the result was non-decreasing, but `ClaimMap.at` is applied to every claim — `starts` and
    `windows` map the unpaired ones too, which is the whole point of `test_a_partial_sheet_maps_every_claim`.
    A step down therefore passed whenever no PAIRED claim happened to sit in the step's own shadow (the last
    `offset_gap` seconds before the boundary), while an unpaired claim there — a decorative line our decode
    dropped, one under `lexical`'s floor, a non-Latin one — was still swapped past its neighbour: legs
    `[(from 0.0, +5.0s), (from 30.0, 0.0s)]` passed on pairs at 10/30/60 while mapping an unpaired claim at
    29.0 to 34.0, ahead of the paired 30.0 that stayed at 30.0.

    A leg owns `[from_sec, next.from_sec)` and is increasing there (positive scale), so its supremum is its
    value AT the next boundary: comparing the two legs there is exact, needs no epsilon and holds for every
    claim in between. The zero clamp `at` applies is non-decreasing, so it cannot reorder what this admits.
    """
    for previous, nxt in zip(pieces, pieces[1:], strict=False):
        if nxt.at(nxt.from_sec) < previous.at(nxt.from_sec):
            return False
    return all(piece.scale > 0.0 for piece in pieces)


def _split(
    pairs: Sequence[tuple[float, float]], from_sec: float, tolerance_sec: float, budget: int
) -> tuple[Piece, ...]:
    """The piecewise arm: recursive change-point split of one claim-ordered run into offset legs.

    One offset per leg and no per-leg scale: a leg is fitted on as few as `MIN_PIECE_PAIRS` lines, where a
    slope is a fit through noise, and the shapes this arm exists for (an inserted section, a sheet
    re-lineated mid-song, a live rendition that drops a verse) are STEPS.
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
