"""Lyrics ACQUISITION, separated from TIMING.

This module owns "where does text come from". A `LyricsSource` yields text plus its provenance; the
timing layer then force-aligns whatever arrived. Sources run INDEPENDENTLY, not first-hit — text
quality and timing fidelity are independent axes, and ASR runs on every process regardless because it
is also the only signal that catches a confidently WRONG lookup (see agreementScore in
src/lib/contract/lyrics/lyrics.ts).

PURE of network/ML by construction: every source is injectable, so the whole chain tests with fakes.
Candidate metadata mirrors `LyricsCandidate` in src/lib/contract/lyrics/lyrics.ts — that TS module is
the authority on RANKING; this side only reports what it produced and how trustworthy it is.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field, replace
from typing import Literal, NamedTuple

# Several names below are UNUSED in this module by design: kept importable from here for existing
# callers. Each `noqa: F401` marks a deliberate re-export, not a missed use.
from ..vocabulary import (
    ROLE_BASELINE,
    ROLE_CANDIDATE,
    ROLE_UNSPECIFIED,  # noqa: F401 — re-export
)
from .artifact import (
    candidate_key as candidate_key,  # noqa: F401 — re-export: moved to artifact.py, kept importable from chain
)
from .lrclib import LyricsFetchError
from .model import (
    SOURCE_ASR,
    SOURCE_CAPTIONS,  # noqa: F401 — re-export
    SOURCE_LRCLIB,  # noqa: F401 — re-export
    SOURCE_MANUAL,  # noqa: F401 — re-export
    TIMING_LINE,  # noqa: F401 — re-export
    TIMING_NONE,  # noqa: F401 — re-export
    TIMING_WORD,  # noqa: F401 — re-export
    LyricsRequest,
    LyricsText,
    lyrics_tokens,
)
from .sources import (
    AsrSource,  # noqa: F401 — re-export
    AutoCaptionsSource,  # noqa: F401 — re-export
    CaptionsSource,  # noqa: F401 — re-export
    LrclibSource,  # noqa: F401 — re-export
    LyricsSource,
    _CaptionsSource,  # noqa: F401 — re-export
    _source_name,
)

# ROLES are orthogonal to source: a BASELINE is the ruler and is never scored, a CANDIDATE is scored
# against the unweighted MEAN of every baseline that can speak. ROLE_UNSPECIFIED is the fail-closed
# default for a hand-built text.

#: ONLY for picking a fallback to SHOW when no candidate is trustworthy — never to weight the grading,
#: where every speaking baseline gets one equal vote. Ordered by measured cleanliness.
BASELINE_ASR_VOCALS = 0
BASELINE_ASR_MIX = 1
BASELINE_CAPTIONS_AUTO = 2


def is_authoritative_text(text_source: str, text_confidence: str) -> bool:
    """Is this text trustworthy enough to be the song's real words? Mirror of `isAuthoritativeText`
    in src/lib/contract/lyrics/lyrics.ts — keep the two in step. Load-bearing on both sides: the TV
    uses it to caption the overlay "auto-transcribed", and the worker uses it to decide whether text
    arrived as human-authored LINES or an ASR blob needing re-lineation (lyrics/presplit.py). A
    second, drifting definition would silently split the wrong tier.
    """
    return text_source != SOURCE_ASR and text_confidence != "low"


def acquire_with_notes(sources: list[LyricsSource], req: LyricsRequest) -> tuple[list[LyricsText], list[str]]:
    """Run EVERY source; return everything that yielded usable text PLUS an operator note per source
    that ran and did not.

    Not first-hit: an authoritative source and ASR are complements, not alternatives, since text
    quality and timing fidelity are independent. A source that raises is skipped — one broken tier
    must never cost the others.

    The notes distinguish a source that RAISED (a provider transport/5xx failure — a provider-down
    signal, loud note) from one that RAN and returned nothing (a genuine per-song miss, quiet note).
    Collapsing both into a bare miss would make a provider outage indistinguishable from a run of
    songs that simply have no lyrics.
    """
    out: list[LyricsText] = []
    notes: list[str] = []
    for s in sources:
        name = _source_name(s)
        try:
            got = s.fetch(req)
        except LyricsFetchError as exc:
            notes.append(f"{name}: ran but FAILED — {exc}. Provider down, not a song without lyrics.")
            continue
        except Exception as exc:  # noqa: BLE001 — a misbehaving source is a miss, never a job failure
            notes.append(f"{name}: ran but errored — {exc}")
            continue
        if got is not None and got.is_usable():
            out.append(got)
        else:
            notes.append(f"{name}: ran and found nothing")
    return out, notes


def acquire(sources: list[LyricsSource], req: LyricsRequest) -> list[LyricsText]:
    """Texts-only view of :func:`acquire_with_notes`. NO production caller — the step layer always
    surfaces the notes; this is the shape the acquisition tests drive."""
    texts, _notes = acquire_with_notes(sources, req)
    return texts


# These four MIRROR src/lib/contract/lyrics/lyrics.ts, the authority; test_lyrics_agreement.py holds the
# two equal. Computed here because this is the only place both texts are in memory at once.

MIN_TOKENS_TO_COMPARE = 12

#: Below this BASELINE COVERAGE the winner is probably a different song entirely. Coverage and NOT the
#: ranking score, which mixes both directions and so cannot tell "different song" from "the baseline
#: heard only part of it" — the normal case for ASR on sung vocals. A SYNTHETIC-corpus calibration:
#: re-derive it once a real corpus exists, and rename rather than re-point this name.
SUSPECT_COVERAGE = 0.40

#: EQUAL with the count-aware term, because any other split is a coefficient nobody has measured.
#: Ranking is threshold-free, so this steers a comparison and never accepts or rejects on its own.
SEQUENCE_WEIGHT = 0.5

#: A FRACTION of duration and never raw seconds, or it is lenient on a clip and harsh on a long track.
#: 10% clears the observed wrong-version overshoots while leaving room for a short trailing cue.
OVERSHOOT_FRACTION_MAX = 0.10


def _adjacent_pairs(tokens: list[str]) -> list[tuple[str, str]]:
    """Every neighbouring token pair, in order — the position-aware view of a token sequence.

    Not whole-sequence alignment: LCS/difflib is O(n·m) on texts of thousands of tokens re-run per
    candidate × baseline pair, and difflib's ratio is not reproducible in TypeScript (its autojunk
    heuristic silently drops tokens appearing in >1% of a long sequence). Pairs are O(n) and still
    catch a reordered bridge or swapped verse, which breaks the pairs at the seams.
    """
    return list(zip(tokens, tokens[1:], strict=False))


class Agreement(NamedTuple):
    """One candidate compared against one baseline, kept as THREE numbers instead of an average.

    The directional split is the point: averaging the two directions into one number destroys the
    fingerprint of "right song, WRONG version" — near-complete coverage of the audible words while a
    large part of the candidate is not audible at all (a real mis-pick measured coverage 0.857,
    fidelity 0.485; one number cannot say that).

    coverage  |C ∩ B| / |B|, multiset — how much of what IS audible the candidate carries.
              The absolute judgement (`SUSPECT_COVERAGE`) reads THIS, because it is the only one of the
              three that a partial baseline does not depress: a baseline that heard a third of the song
              still has all of its own words inside a correct candidate.
    fidelity  |C ∩ B| / |C|, multiset — how much of the candidate is actually audible. Low fidelity
              with high coverage IS the wrong-version fingerprint. It steers the COMPARISON only.
    sequence  the same overlap over ADJACENT PAIRS, weaker direction — word ORDER, not just counts.
    """

    coverage: float
    fidelity: float
    sequence: float

    @property
    def rank_score(self) -> float:
        """The single 0..1 number `select_by_baselines` ranks candidates by. NOT a threshold axis:
        argmax needs a difference, not a level, which is why this can afford to be the harsh,
        discriminating number while `coverage` stays the lenient, judgeable one. The weaker of the
        two count directions, blended with the position-aware term, so padding a candidate with
        words nobody sings cannot buy rank."""
        counts = min(self.coverage, self.fidelity)
        return (1.0 - SEQUENCE_WEIGHT) * counts + SEQUENCE_WEIGHT * self.sequence


def agreement(candidate: str, baseline: str) -> Agreement | None:
    """Compare a CANDIDATE against a BASELINE, or None when the comparison says nothing.

    ARGUMENT ORDER IS LOAD-BEARING: `coverage` and `fidelity` are the two directions of the same
    overlap, so swapping the arguments swaps them. Candidate first, baseline second — same order as
    `composite_score(candidate, baselines)`.

    Returns None — not 0 — when either side has fewer than MIN_TOKENS_TO_COMPARE distinct tokens: an
    instrumental transcribes to almost nothing, and scoring that as total disagreement would condemn a
    perfectly correct lookup. "Cannot tell" and "these differ" must not be the same answer.
    """
    tokens_c, tokens_b = lyrics_tokens(candidate), lyrics_tokens(baseline)
    if len(set(tokens_c)) < MIN_TOKENS_TO_COMPARE or len(set(tokens_b)) < MIN_TOKENS_TO_COMPARE:
        return None
    # ONE implementation: the hot path builds views once and calls agreement_of directly.
    return agreement_of(TokenView.of(candidate), TokenView.of(baseline))


@dataclass(frozen=True)
class TokenView:
    """One text, tokenized ONCE, with everything `agreement` needs precomputed.

    Deriving this once per TEXT and reusing it across (candidate, baseline) pairs makes the grading
    cost O(C + B) instead of O(C × B) tokenizations over texts that run to thousands of tokens. The
    numbers are unchanged — this is the same arithmetic reading precomputed operands.

    Deliberately NOT a module-level cache keyed on the text: that would retain a job's lyrics in a
    global for the worker's lifetime. The sharing that matters is within one selection, which the
    caller expresses by building the views once.
    """

    tokens: tuple[str, ...]
    counts: Counter[str]
    pair_counts: Counter[tuple[str, str]]
    distinct: int
    pair_total: int

    @classmethod
    def of(cls, text: str) -> TokenView:
        tokens = lyrics_tokens(text)
        pairs = _adjacent_pairs(tokens)
        return cls(
            tokens=tuple(tokens),
            counts=Counter(tokens),
            pair_counts=Counter(pairs),
            distinct=len(set(tokens)),
            pair_total=len(pairs),
        )


def _counter_overlap(a: Counter, b: Counter) -> int:
    """How many tokens the two texts share COUNTING MULTIPLICITY: Σ min(count_a, count_b), over
    precomputed counters so neither side is rebuilt. A candidate that repeats a chorus four times where
    the audio has it twice agrees on the words but disagrees on how many, and "how many" is half of what
    tells versions of a recording apart."""
    return sum(min(n, b.get(token, 0)) for token, n in a.items())


def agreement_of(candidate: TokenView, baseline: TokenView) -> Agreement | None:
    """`agreement` over precomputed views. The string form delegates here, so there is one implementation.

    Returns None when either side is below MIN_TOKENS_TO_COMPARE distinct tokens — the comparability floor,
    unchanged.
    """
    if candidate.distinct < MIN_TOKENS_TO_COMPARE or baseline.distinct < MIN_TOKENS_TO_COMPARE:
        return None
    shared = _counter_overlap(candidate.counts, baseline.counts)
    shared_pairs = _counter_overlap(candidate.pair_counts, baseline.pair_counts)
    sequence = (
        min(shared_pairs / baseline.pair_total, shared_pairs / candidate.pair_total)
        if candidate.pair_total and baseline.pair_total
        else 0.0
    )
    return Agreement(
        coverage=shared / len(baseline.tokens),
        fidelity=shared / len(candidate.tokens),
        sequence=sequence,
    )


def agreement_score(candidate: str, baseline: str) -> float | None:
    """The 0..1 ranking score for one candidate against one baseline, or None when not comparable.
    Count- and position-aware (see `Agreement` for why the three numbers are kept apart, and
    `SUSPECT_COVERAGE` for which of them the absolute judgement reads)."""
    got = agreement(candidate, baseline)
    return None if got is None else got.rank_score


def baselines_of(texts: list[LyricsText]) -> list[LyricsText]:
    """The texts that are EVIDENCE, best-evidence first. See BASELINE_* for the ordering rationale."""
    got = [t for t in texts if t.role == ROLE_BASELINE]
    got.sort(key=lambda t: t.baseline_rank if t.baseline_rank is not None else 99)
    return got


def candidates_of(texts: list[LyricsText]) -> list[LyricsText]:
    """The texts that are CLAIMS, in acquisition order."""
    return [t for t in texts if t.role == ROLE_CANDIDATE]


class Composite(NamedTuple):
    """One candidate graded against every baseline that could speak.

    Two means, not one, because the two mechanisms below read different axes: `score` is what
    selection ranks by, `coverage` is what the absolute wrong-song judgement thresholds. `votes` is the
    per-baseline ranking scores that formed the mean, so `len(votes)` is how many baselines spoke.

    Index 0 stays `score`, so `composite_score(...)[0]` keeps meaning the ranking score.
    """

    score: float | None
    coverage: float | None
    votes: list[float]


def composite_score(
    candidate: LyricsText,
    baselines: list[LyricsText],
    *,
    baseline_views: list[TokenView] | None = None,
) -> Composite:
    """Mean agreement of one candidate against every baseline that can speak, plus the votes cast.

    Returns (None, None, []) when NO baseline is comparable — a real outcome for an instrumental,
    which must not be reported as disagreement.

    ABSTENTION, not zero, is what makes it safe to include a weak baseline: `agreement` yields None
    below MIN_TOKENS_TO_COMPARE (a silent vocals stem, or captions collapsed into [Music] markers), so
    that baseline simply does not vote. Scoring it as total disagreement would let the weakest
    evidence veto the strongest, and would turn a correct lookup into a confidently wrong reject.

    EQUAL WEIGHT is deliberate: a per-baseline coefficient is unmeasured, and BASELINE_* orders which
    evidence to SHOW, not how much to trust its vote. The two means are taken over the SAME set of
    speaking baselines, so `coverage` cannot be formed from a different quorum than `score`.

    `baseline_views` lets the caller tokenize baselines ONCE for a whole candidate pool — see
    `TokenView`. Omitting it is correct and self-contained, just O(C × B) again.
    """
    candidate_view = TokenView.of(candidate.plain_text)
    spoke = [
        got
        for got in (
            agreement_of(candidate_view, bv)
            for bv in (
                baseline_views
                if baseline_views is not None
                else [TokenView.of(b.plain_text) for b in baselines]
            )
        )
        if got is not None
    ]
    if not spoke:
        return Composite(None, None, [])
    votes = [got.rank_score for got in spoke]
    return Composite(
        score=sum(votes) / len(votes), coverage=sum(got.coverage for got in spoke) / len(spoke), votes=votes
    )


def candidate_last_end(candidate: LyricsText) -> float | None:
    """Latest word/line end time the candidate's OWN timings carry, or None when it is not timed.

    A timed source (any TIMING_WORD/TIMING_LINE tier) fills `start`/`end` on its `segments`; a
    text-only source does not. Overshoot is only defined for the former — a text without its own
    timings cannot be "timed past the audio" until it is force-aligned, which happens after
    selection. Reads `end` off segments directly (not the flattened word list): at SELECTION time the
    line timing is what a wrong-version LRC carries.
    """
    ends = [float(seg["end"]) for seg in candidate.segments if isinstance(seg.get("end"), (int, float))]
    return max(ends) if ends else None


def overshoot_fraction(last_end: float | None, duration_sec: float | None) -> float | None:
    """How far past the end of the audio a text's own timings run, as a FRACTION of duration, or None
    when the question cannot be asked (untimed text, or unknown/zero duration).

    A fraction and never raw seconds, or the same absolute overshoot is lenient on a long track and
    harsh on a clip. Clamped at 0, so a text ending early reads as no overshoot rather than a negative one.
    """
    if last_end is None or not duration_sec or duration_sec <= 0:
        return None
    return max(0.0, last_end - duration_sec) / duration_sec


def fits_audio(last_end: float | None, duration_sec: float | None) -> bool:
    """Do this text's OWN timings stay inside the audio (or does it carry none at all)?

    THE one definition of the overshoot boundary, so the demotion in `overshoot_penalized` and the
    operator notes in `steps/lyrics/grade.py` cannot drift onto different thresholds — they are the same
    judgement read for two purposes. An unanswerable question (untimed text, unknown duration) counts as
    fitting: a text-only source is force-aligned to THIS recording after selection.
    """
    fraction = overshoot_fraction(last_end, duration_sec)
    return fraction is None or fraction <= OVERSHOOT_FRACTION_MAX


def overshoot_penalized(score: float, candidate: LyricsText, duration_sec: float | None) -> float:
    """The candidate's composite score after DEMOTING it for running past the end of the audio.

    A candidate timed well past audio-end is a wrong-version pick — its lyrics belong to a longer
    master, so part of them can never be sung — and must lose to a rival that fits, without a
    threshold masquerading as a similarity judgement. The penalty is COMPARATIVE, applied to the same
    composite score argmax already ranks by, so a clean rival wins on the same axis.

    Below OVERSHOOT_FRACTION_MAX the score is untouched (absorbing a same-recording LRC with a short
    trailing artefact cue). Above it, subtract the overshoot fraction from the score, which is enough
    to flip a real measured wrong-version pick (0.94) against a clean rival (0.55). `duration_sec`
    unknown, or the candidate untimed, means no judgement is possible — return the score unchanged.
    """
    fraction = overshoot_fraction(candidate_last_end(candidate), duration_sec)
    if fraction is None or fraction <= OVERSHOOT_FRACTION_MAX:
        return score
    # FLOORED AT ZERO because `select_by_baselines` uses -1.0 as the UNJUDGEABLE sentinel and relies on
    # it sitting beneath every judged score: an unclamped subtraction could push a catastrophic overshoot
    # below -1.0 and hand the comparison to the ungradeable rival.
    return max(0.0, score - fraction)


# THRESHOLDS CANNOT SEPARATE VERSIONS of the same song: two versions share most of their words, so the
# wrong one still scores far above `SUSPECT_COVERAGE`. What separates versions is a COMPARISON, and
# argmax needs only a difference. So two mechanisms read DIFFERENT AXES of the same comparison —
# SELECT is comparative and threshold-free on `Composite.score`, JUDGE is absolute and thresholded on
# `Composite.coverage`. Selection runs BEFORE the expensive force-align, so only the winner pays it.


DecidedBy = Literal["agreement", "metadata"]


@dataclass
class VariantChoice:
    """What happened when one source offered several versions. Purely a report — for logs and tests."""

    text_source: str
    considered: int
    chosen: str | None
    chosen_score: float | None
    #: (label, score) of everything not chosen, in the order considered.
    rejected: list[tuple[str | None, float | None]] = field(default_factory=list)
    #: Which arm fired: the baselines decided it, or they could not and cheap ranking stood. A
    #: `Literal` so the audit trail's `decidedBy` cannot gain a third spelling nothing reads.
    decided_by: DecidedBy = "metadata"
    #: How many baselines actually voted on the winner. 0 means the mean could not be formed.
    votes: int = 0

    def summary(self) -> str:
        head = f"{self.text_source}: {self.considered} versions, kept {self.chosen or '?'}"
        if self.chosen_score is not None:
            head += f" (composite {self.chosen_score:.2f} from {self.votes} baseline(s))"
        if self.decided_by == "metadata":
            return head + " — chosen on metadata; no baseline could judge"
        losers = ", ".join(
            f"{label or '?'}" + (f" {score:.2f}" if score is not None else " —")
            for label, score in self.rejected
        )
        return head + (f", over {losers}" if losers else "")

    def to_record(self) -> dict[str, object]:
        """The durable, wire-safe form of this pick — the same facts as `summary()`, as data.

        `summary()` renders these for the process log, which rotates and is per-container; this
        crosses the wire and lands in the job_attempts audit trail so a mis-pick is diagnosable from
        state weeks later. Deliberately NOT the lyric bodies: label + composite score is enough to
        say which arm fired (metadata fallback vs a real disagreement), and storing full rejected
        texts per song would multiply the lyrics footprint for triage-only data.
        """
        return {
            "textSource": self.text_source,
            "considered": self.considered,
            "chosen": self.chosen,
            "chosenScore": self.chosen_score,
            "decidedBy": self.decided_by,
            "votes": self.votes,
            "rejected": [{"label": label, "score": score} for label, score in self.rejected],
        }


@dataclass
class Selection:
    """The outcome of one align job's text selection."""

    #: What to publish, in rank order. The winning candidate first when there is one.
    publish: list[LyricsText] = field(default_factory=list)
    #: None when nothing could judge it. NOT the axis `winner_suspect` reads.
    winner_score: float | None = None
    #: The number the wrong-song judgement thresholds. None when no baseline could speak.
    winner_coverage: float | None = None
    #: True when there was no candidate at all, so a baseline is being shown as the answer.
    baseline_fallback: bool = False
    #: True when the winner's coverage fell below SUSPECT_COVERAGE — probably a different song entirely.
    winner_suspect: bool = False
    choices: list[VariantChoice] = field(default_factory=list)
    #: One line per baseline, for the log: which spoke, which abstained.
    baseline_notes: list[str] = field(default_factory=list)

    def to_record(self) -> dict[str, object] | None:
        """Durable provenance for the whole selection, or None when there was nothing to decide
        (`choices` empty) — nothing persisted rather than an empty shell that reads as a lost record.
        """
        if not self.choices:
            return None
        return {
            "baselineFallback": self.baseline_fallback,
            "winnerSuspect": self.winner_suspect,
            "winnerScore": self.winner_score,
            # Coverage is persisted too, or the record reads as a missed detection on its own numbers.
            "winnerCoverage": self.winner_coverage,
            "choices": [c.to_record() for c in self.choices],
        }


#: The sentinel rank for a candidate NO baseline could grade. Beneath every judged score, so an
#: ungradeable rival never wins a comparison — which is why `overshoot_penalized` floors at 0.0.
_UNJUDGEABLE_RANK = -1.0


class _VariantPick(NamedTuple):
    """One source's chosen version, plus what the cross-source comparison needs to rank it."""

    winner: LyricsText
    #: The RAW agreement, for provenance — deliberately not the penalised number.
    graded: Composite
    #: The PENALISED key the comparison orders on. None when no baseline could grade the winner.
    rank: float | None
    #: Set only when there was more than one version to choose between.
    choice: VariantChoice | None


def _pick_variant(
    candidate: LyricsText,
    baselines: list[LyricsText],
    baseline_views: list[TokenView],
    duration_sec: float | None,
) -> _VariantPick:
    """Choose among ONE source's versions: the candidate and its cheap-ranked alternates.

    Grade every version against the baselines, DEMOTE any whose own timings run well past the end of
    the audio, then argmax. `(rank, -index)` so an exact tie keeps the earlier, better-metadata match.
    With no baseline able to grade anything, the pick falls back to index 0 — the cheap metadata
    ranking — and says so via `VariantChoice.decided_by`.
    """
    pool = [candidate, *candidate.alternates]
    scored = [composite_score(c, baselines, baseline_views=baseline_views) for c in pool]
    # The RANKING key demotes overshoot; `scored` keeps the raw agreement for provenance.
    ranked = [
        (overshoot_penalized(got.score, c, duration_sec) if got.score is not None else None)
        for c, got in zip(pool, scored, strict=True)
    ]
    decided_by: DecidedBy
    if any(rank is not None for rank in ranked):
        pick = max(
            range(len(pool)), key=lambda i: (ranked[i] if ranked[i] is not None else _UNJUDGEABLE_RANK, -i)
        )
        decided_by = "agreement"
    else:
        pick = 0
        decided_by = "metadata"

    # replace(), not in-place mutation: `candidate` is caller-owned data from the step layer.
    winner = replace(pool[pick], alternates=[])
    graded = scored[pick]
    choice = None
    if len(pool) > 1:
        choice = VariantChoice(
            text_source=winner.text_source,
            considered=len(pool),
            chosen=winner.variant,
            chosen_score=graded.score,
            rejected=[
                (c.variant, got.score)
                for i, (c, got) in enumerate(zip(pool, scored, strict=True))
                if i != pick
            ],
            decided_by=decided_by,
            votes=len(graded.votes),
        )
    return _VariantPick(winner=winner, graded=graded, rank=ranked[pick], choice=choice)


def select_by_baselines(texts: list[LyricsText], duration_sec: float | None = None) -> Selection:
    """Pick the song's words: grade every candidate against the baselines, then publish.

      1. Split by role. Baselines are evidence of what is audible; candidates are claims about the words.
      2. Score each candidate — and each alternate version — as the MEAN agreement across every
         baseline that can speak (`composite_score`), then DEMOTE any whose own timings run well past
         the end of the audio (`overshoot_penalized`). Argmax over the penalised score wins; ties keep
         the better metadata match. The reported score stays the raw agreement.
      3. Publish the winner. Also publish the best baseline when the winner cannot be trusted, so
         there is always something honest to fall back to: either no candidate existed, or the winner
         scored below SUSPECT_COVERAGE and is probably a different song.

    A baseline publishes only then, never always: everything published gets force-aligned, so
    publishing one for its own sake costs a full alignment pass to produce words nobody shows. A
    baseline also never displaces a trustworthy candidate — the structural reason YouTube's automatic
    captions are safe to include here though not safe as a source of record.
    """
    baselines = baselines_of(texts)
    candidates = candidates_of(texts)
    sel = Selection()

    # ONCE per selection: O(candidates + baselines) instead of O(candidates x baselines).
    baseline_views = [TokenView.of(b.plain_text) for b in baselines]

    for b, bv in zip(baselines, baseline_views, strict=False):
        tokens = bv.distinct
        sel.baseline_notes.append(
            f"{b.variant or b.text_source}: {tokens} distinct words"
            + ("" if tokens >= MIN_TOKENS_TO_COMPARE else " — too few to judge with, ABSTAINS")
        )

    best: LyricsText | None = None
    best_score: float | None = None
    #: Tracked separately so it is never borrowed from a candidate that lost.
    best_coverage: float | None = None
    #: The PENALISED rank key, kept apart from `best_score`, which reports the raw agreement.
    best_rank: float | None = None
    for cand in candidates:
        pick = _pick_variant(cand, baselines, baseline_views, duration_sec)
        if pick.choice is not None:
            sel.choices.append(pick.choice)
        # The same PENALISED rank decides across sources, so an overshooting source loses to one that fits.
        rank = pick.rank if pick.rank is not None else _UNJUDGEABLE_RANK
        if best is None or rank > (best_rank if best_rank is not None else _UNJUDGEABLE_RANK):
            best = pick.winner
            best_score, best_coverage, best_rank = pick.graded.score, pick.graded.coverage, pick.rank

    if best is None:
        # No claim at all: fall back to the best baseline.
        sel.baseline_fallback = True
        sel.publish = baselines[:1]
        return sel

    sel.publish = [best]
    sel.winner_score = best_score
    sel.winner_coverage = best_coverage
    # JUDGE on coverage, never the ranking score: a correct candidate graded against a partial baseline
    # scores low by construction, so thresholding that demotes correct lyrics for a defect in the evidence.
    sel.winner_suspect = best_coverage is not None and best_coverage < SUSPECT_COVERAGE
    if sel.winner_suspect and baselines:
        # Probably a different song: publish what was actually HEARD, not just a warning label.
        sel.publish.append(baselines[0])
    return sel
