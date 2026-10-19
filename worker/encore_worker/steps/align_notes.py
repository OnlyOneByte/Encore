"""Every sentence the audit trail prints, as a function of what was read.

One builder per decision, so a note cannot disagree with the branch that produced it and the trail reads the
same in a test as in production. The trail's contract: docs/arch/05-worker.md §9.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from enum import StrEnum
from statistics import median
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from encore_worker.domain.lyrics.generate import Generated
    from encore_worker.domain.lyrics.reconcile import AsClaimed, OffSheet
    from encore_worker.domain.lyrics.viterbi import Graph

from encore_worker.domain.lyrics import (
    measure,
    units,
)
from encore_worker.steps.align_claims import _MarginSilence, _Placement


class _Source(StrEnum):
    """Where a line's published timing came from: the repair ladder's per-line provenance (XA-02), carried
    because the stages are NOT equally independent of the claims and the timings alone cannot say."""

    #: The global decode's own line: no claim chose where it was decoded (the never-sung rule only picks
    #: which lines are decoded at all).
    BLIND = "blind"
    #: R3: re-decoded jointly between the unique lines around a repeated block. No claim is used, so where it
    #: lands is independent of them: `high` where that is on its claim, on the blind verdict's clock.
    ANCHORED = "anchored"
    #: R1 / R2: re-decoded inside its padded claim window, on the target.
    WINDOW = "window"
    #: R4: re-decoded inside its padded claim window, on the MIX.
    MIX = "mix"
    #: The claim's own span, adopted because no window decode heard the line.
    ADOPTED = "adopted"
    #: The primed re-decode of the review's roadmap item 14: one global Viterbi in which the clock-mapped
    #: claims are a BONUS at each line's first state. A claim chose nothing, but it tipped the path.
    PRIMED = "primed"


#: How many lines of one source the trail names by index before it only counts the rest: R1 re-decodes
#: every claimed line, and a 90-line index list would bury the rest of the verdict note.
_SOURCES_NAMED = 12


def _sheet_why(reading: AsClaimed | None, off: OffSheet | None, *, demoted: bool) -> str:
    """The trail's line for the coherence check: how far the published document sits from the sheet a viewer
    holds, whether both witnesses convicted it, and whether that was allowed to demote it.

    Printed on every claimed job, because "we checked and it is close" and "nobody checked" must not read
    alike — that silence is what let a document 0.86 s off its captions publish `high` for eight waves. The
    reading is AS CLAIMED: no offset removed, so this is the error a room would see. `demoted` is false
    whenever `band-off-sheet` is off, which is the default: the conviction is still reported."""
    from encore_worker.domain.lyrics import reconcile as rc  # noqa: PLC0415

    if reading is None:
        return f"against the sheet as served: fewer than {rc.MIN_PAIRS} paired lines, not read"
    if off is not None:
        verdict = "every line graded low" if demoted else "not demoted (band-off-sheet is off)"
        return f"against the sheet as served: {off.why()} — {verdict}"
    return (
        f"against the sheet as served: {reading.near:.0%} of {reading.pairs} lines within "
        f"{reading.tolerance_sec:.2f} s of their own claim (median lag {reading.offset_sec:+.2f} s, spread "
        f"{reading.spread_sec:.2f} s, {reading.together:.0%} of them carrying that lag), no coherent "
        "displacement both witnesses confirm"
    )


def _ends_why(
    before: Generated, after: Generated, experiments: frozenset[str], *, on_stem: bool = True
) -> str:
    """The trail's line for the word-end post-pass: how many ends moved, and by how much — a display change
    no metric on the report can show. It states the ARM and the TARGET, the two reasons ends look raw."""
    if "ends-raw" in experiments:
        return "word ends: the raw decode's (ends-raw)"
    if not on_stem:
        return "word ends: the raw decode's (no vocals stem: the envelope's silence level is a stem's)"
    moved = sorted(
        after_word.end - before_word.end
        for before_line, after_line in zip(before.lines, after.lines, strict=True)
        for before_word, after_word in zip(before_line.words, after_line.words, strict=True)
        if after_word.end > before_word.end
    )
    words = sum(len(line.words) for line in before.lines)
    # The arm is named in BOTH branches: "nothing moved" under `ends-tile` is a different claim about the
    # decode than the same sentence on the default.
    arm = " tiling within each line (ends-tile)" if "ends-tile" in experiments else ""
    if not moved:
        return f"word ends: none of {words} extended{arm} (the envelope stops where the decode does)"
    return (
        f"word ends: held {len(moved)} of {words} through the singing{arm}, median "
        f"+{moved[len(moved) // 2] * 1000:.0f} ms, worst +{moved[-1]:.2f}s"
    )


def _pulls_why(pulls: Mapping[int, float]) -> str:
    """The trail's clause for the ends `_clamped_v2` pulled back onto a repair: how many, which, how far.

    THE ONE PUBLISHED TIMING THIS WORKER CHANGES ON A LINE NO STAGE REPAIRED, and nothing else says so —
    `provenance` is right not to move, so such a line still reports as the blind decode's. BY INDEX and capped
    at `_SOURCES_NAMED`, the measured pull count per pass being around a hundred.
    """
    if not pulls:
        return ""
    ordered = sorted(pulls)
    shown = " ".join(f"[{i}]" for i in ordered[:_SOURCES_NAMED])
    more = f" +{len(ordered) - _SOURCES_NAMED} more" if len(ordered) > _SOURCES_NAMED else ""
    return (
        f"pulled {len(ordered)} line end(s) back onto the repair that followed them, median "
        f"{median(pulls.values()):.2f}s of overrun removed (starts, order and grades unmoved): {shown}{more}"
    )


def _bundle_why(emissions: object) -> str:
    """The trail's clause naming the ALIGNMENT BUNDLE a document's word timings came off.

    NOTHING ELSE ON THE PRODUCTION RECORD NAMED IT, and two failures had no evidence without it: a bundle
    flipped between a job's attempts, and a "the timings got worse" report from a box nobody recorded one for.
    "unnamed" is not production — only an aligner older than the field, or a test's fake.
    """
    named = str(getattr(emissions, "model", "") or "")
    return f"bundle {named or 'unnamed'}"


def _units_why(rules: units.Rules, language_code: str, asked: Collection[str] = ()) -> str:
    """One trail sentence naming the W8 unit arms this attempt decoded under, and on which language.

    `asked` is the experiments set, so an arm whose backend this box lacks is reported as NOT APPLIED rather
    than read off a name that silently omits it (review r2-spec-11).
    """
    unhonoured = sorted(units.unhonoured(language_code, asked))
    return (
        f"units {rules.name} for {language_code!r} "
        f"(domain.lyrics.units: words, syllables and vocabulary spelling are this script's, "
        f"not the whitespace rule every recorded row was measured on)"
        + (
            f", and {', '.join(unhonoured)} did NOT apply: no backend for it on this box"
            if unhonoured
            else ""
        )
    )


def _linesep_why(separator: int | None, *, named: int | None) -> str:
    """The trail's clause for the line separator, printed only under the `linesep` arm.

    IT SAYS WHETHER THE ARM ACTUALLY DID ANYTHING, and WHICH OF THE TWO INERT CASES it was — they lead to
    opposite next steps (docs/arch/04-alignment.md §14.1). `named` is the unfiltered reading, so a collision
    names the column it collided with.
    """
    if separator is None and named is not None:
        return (
            "line separator: requested (linesep) but this vocabulary's `|` IS its blank column "
            f"(id {named}), so the arm is inert and the targets are the default's"
        )
    if separator is None:
        return (
            "line separator: requested (linesep) but this vocabulary names none, so the targets are the "
            "default's"
        )
    return f"line separator: `|` (id {separator}) between lines, its frames blank (linesep)"


def _star_why(star: int | None) -> str:
    """The trail's clause for the star column, printed only under the `star` arm: whether it did anything,
    for `_linesep_why`'s reason. One inert case rather than two, no blank collision being possible."""
    if star is None:
        return "star: requested (star) but this matrix carries no star column, so the targets are default"
    from encore_worker.adapters.ml import STAR_PENALTY_NATS  # noqa: PLC0415 - the arm's own constant

    return f"star: one per line, id {star} = frame max − {STAR_PENALTY_NATS:g} nats, its frames blank (star)"


def _built_why(graph: Graph) -> str:
    """What a non-empty `viterbi.Graph` holds, for `_graph_why`'s decode note: the arcs, and their price."""
    held: list[str] = []
    if graph.stars:
        held.append(f"{len(graph.stars)} star state(s) bypassable at {graph.star_penalty:g} nats")
    if graph.bonus:
        held.append(f"an onset prior on {len(graph.bonus)} first-character state(s)")
    return "decoded through a graph of " + " and ".join(held)


def _graph_why(notes: Sequence[str], *, vendored: bool) -> str:
    """The trail's clause for W9's decode arms: what the graph did, or what the fusion did (XA-18).

    `vendored` names the DECODER, which `claim-fusion` alone does not change — it changes the evidence —
    so the clause has to say which of the two the reader is looking at. Under the bare `vendored` control
    there is nothing to report, and saying so is the control's whole claim: the graph was empty, so the
    kernel's own path is what published.
    """
    what = "vendored decoder" if vendored else "claim fusion"
    if notes:
        return f"{what}: " + "; ".join(notes)
    if vendored:
        return "vendored decoder: an empty graph, so this is torchaudio's own path (vendored)"
    return "claim fusion: no claim to fuse inside (claim-fusion)"


def _sources_why(provenance: Mapping[int, _Source], indexes: Sequence[int]) -> str:
    """The trail's per-line provenance for the published lines: how many each source timed, and which.

    Blind lines are only counted; every other source names its lines by input index.
    """
    by_source: dict[_Source, list[int]] = {}
    for index in indexes:
        by_source.setdefault(provenance.get(index, _Source.BLIND), []).append(index)
    parts: list[str] = []
    for source in _Source:
        named = by_source.get(source, [])
        if not named:
            continue
        if source == _Source.BLIND:
            parts.append(f"{len(named)} blind")
            continue
        shown = " ".join(f"[{i}]" for i in named[:_SOURCES_NAMED])
        more = f" +{len(named) - _SOURCES_NAMED} more" if len(named) > _SOURCES_NAMED else ""
        parts.append(f"{len(named)} {source.value} {shown}{more}")
    return f"timing sources: {', '.join(parts)}"


def _margin_why(placement: _Placement, doubted: Collection[int], lines: int, *, floor: float | None) -> str:
    """The placement-margin clause of the trail note: the signal, its threshold, and what it doubts.

    `doubted` is what the RULE flags and not what published `low`, which is why the wording says "doubts".
    ONE SENTENCE PER SILENCE, because the reasons lead to different next steps and two used to be
    byte-identical; the `fault` one is a BUG REPORT, so it names the exception type. `floor` comes off this
    bundle's own calibration row. The trail names the RULE rather than a section number, an operator having no
    document to resolve a citation against (docs/arch/04-alignment.md §6).
    """
    silent = {
        "arm": (
            "placement margins: not read, `conf-legacy` asked for the grading that preceded the "
            "placement-margin rule"
        ),
        "uncalibrated": (
            "placement margins: not read, this alignment bundle has no calibrated margin floor "
            "(`lexical.Bands.margin_floor_nats`), so grading is as it was before the placement-margin rule"
        ),
        "graph": (
            "placement margins: not read, `star-b` decoded through a graph whose stars are bypassable and "
            "the margin rule knows only the plain topology, so grading is as it was before the rule"
        ),
        "already-low": (
            "placement margins: not read, every line of this document is graded low before the rule is "
            "reached, so no margin could change a grade"
        ),
        "fault": (
            f"placement margins: not measured, `{placement.fault}` inside the two Viterbi passes, so "
            "grading is as it was before the placement-margin rule"
        ),
        "unreadable": (
            "placement margins: not measured, these frames and targets carry no path to compare, so "
            "grading is as it was before the placement-margin rule"
        ),
    }
    margins = placement.margins
    if floor is None:
        # Narrowed for the numbers below, and the one silence that can be read off the floor alone.
        return silent["uncalibrated"]
    if not margins:
        return silent[placement.silence or "unreadable"]
    ordered = sorted(margins.values())
    tight = sum(1 for gap in ordered if gap < floor)
    return (
        f"placement margins over {len(ordered)} of {lines} lines: median "
        f"{median(ordered):.0f} nats, min {ordered[0]:.0f}, {tight} under "
        f"{floor:.0f} — {len(doubted)} doubted on ambiguity or a low score"
    )


def _repeats_why(repeats: Collection[int], *, applied: bool, silence: _MarginSilence | None) -> str:
    """The `conf-fuzzy-repeats` clause: whether the arm acted, and when it did not, why not — a run recorded
    under an arm's name having measured the DEFAULT path being worse than one that refused to start."""
    if applied:
        return f"near-repeat demotion (conf-fuzzy-repeats): {len(repeats)} line(s) flagged"
    because = {
        "arm": (
            "`conf-legacy` asked for the grading that preceded the placement-margin rule, which has no "
            "demotion to widen"
        ),
        "already-low": "every line of this document is graded low already",
    }.get(silence or "", "the placement-margin rule stood down")
    return f"near-repeat demotion (conf-fuzzy-repeats): requested, not applied — {because}"


def _backwards_why(
    doc: dict[str, object], *, index_of: Sequence[int] | None = None, repaired: Collection[int] = ()
) -> str:
    """The trail's account of an out-of-order word document: how many starts run backwards, and where.

    Lines are named `[i]` like the never-sung note, by INPUT index when `index_of` maps document positions to
    it (the global decode drops unalignable lines, so position and input row differ), and marked when a repair
    produced them — the first question an inversion raises.
    """
    positions = measure.backwards_lines(doc)
    named = sorted({index_of[p] if index_of is not None else p for p in positions})
    where = ", ".join(f"[{i}]{' (repaired)' if i in repaired else ''}" for i in named)
    return f"{len(positions)} word starts run backwards, in lines {where}"
