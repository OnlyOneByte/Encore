"""The fallback ladder, driven end to end with no audio, no model and no DBOS.

The arms that matter most are the ones about `GiveUp`: it must be reachable from exactly one situation —
the pool is spent AND ASR has had its turn — because "no lyrics" is the absolute worst case and the old
worker reached it far too easily.
"""

from __future__ import annotations

import pytest

from encore_worker.domain.lyrics.policy import Knob, Tier
from encore_worker.domain.lyrics.report import Engine, TimingReport
from encore_worker.domain.lyrics.search import (
    Candidate,
    Commit,
    GiveUp,
    RunAsr,
    Search,
    Try,
)

CLEAN = TimingReport(words=200, coverage=1.0, duration_sec=200.0)
INCOHERENT = TimingReport(words=200, coverage=1.0, duration_sec=200.0, out_of_order=5)
#: WINDOWED, the engine that reads ALIGN_ON_MIX: the global one accepts thin coverage (review H2).
THIN = TimingReport(words=50, coverage=0.3, duration_sec=200.0, engine=Engine.WINDOWED)
NOTHING = TimingReport(words=0, coverage=0.0)
#: What a LINE_SYNC attempt measures when it commits: lines, no words (review M1).
LINE_SYNCED = TimingReport(coverage=0.9, duration_sec=200.0, engine=Engine.LINE_SYNC, lines=30)
REFUSED = TimingReport(duration_sec=200.0, refused="envelope gate refused: blind r=0.11 @ +4.20s")


def lrc(label: str = "lrclib") -> Candidate:
    """A provider text: its own line timings, presplit windows, placement applies."""
    return Candidate(
        tier=Tier.CANDIDATE,
        label=label,
        has_windows=True,
        has_line_timings=True,
        has_own_line_timings=True,
    )


def asr(label: str = "asr:vocals") -> Candidate:
    """A transcription: measured on this audio, so no placement and no line-sync fallback."""
    return Candidate(tier=Tier.ASR, label=label)


# ── the happy path ───────────────────────────────────────────────────────────────────────────────


def test_first_candidate_that_aligns_cleanly_is_committed() -> None:
    search = Search(pool=[lrc(), asr()])
    step = search.begin()
    assert isinstance(step, Try)
    assert step.index == 0, "candidates are tried before the ASR tier"
    assert isinstance(search.record(CLEAN), Commit)


def test_candidates_are_tried_before_asr() -> None:
    """Pool order is by AUTHORITY, so a candidate listed second still precedes an ASR text."""
    search = Search(pool=[asr(), lrc()])
    step = search.begin()
    assert isinstance(step, Try)
    assert search.pool[step.index].tier is Tier.CANDIDATE


# ── retrying the same text with a different knob ──────────────────────────────────────────────────


def test_a_defect_retries_the_same_text_with_a_knob() -> None:
    search = Search(pool=[lrc()])
    search.begin()
    step = search.record(THIN)
    assert isinstance(step, Try)
    assert step.index == 0, "a retime stays on the same text"
    assert Knob.ALIGN_ON_MIX in step.attempt.tried


def test_knobs_are_spent_not_repeated() -> None:
    """Each retime records its knob, so the same defect cannot be answered the same way twice."""
    search = Search(pool=[lrc()])
    search.begin()
    seen: list[Knob] = []
    report = THIN
    for _ in range(6):
        step = search.record(report)
        if not isinstance(step, Try):
            break
        new = step.attempt.tried - set(seen)
        assert new, "a retime must spend a knob that was not already spent"
        seen.extend(new)
    assert len(seen) == len(set(seen))


def test_no_vocals_stem_means_align_on_mix_is_never_offered() -> None:
    """Already on the mix, so the knob would spend a pass to produce the identical result."""
    search = Search(pool=[lrc()], aligned_on_stem=False)
    step = search.begin()
    assert isinstance(step, Try)
    assert step.attempt.aligned_on_stem is False
    nxt = search.record(THIN)
    if isinstance(nxt, Try):
        assert Knob.ALIGN_ON_MIX not in nxt.attempt.tried


def test_thin_coverage_on_the_global_engine_commits_the_first_attempt() -> None:
    """H2: no mix re-decode can replace a global stem document — it is committed as it stands."""
    search = Search(pool=[lrc()])
    first = search.begin()
    assert isinstance(first, Try) and first.serial == 1
    step = search.record(TimingReport(words=50, coverage=0.3, duration_sec=200.0))
    assert isinstance(step, Commit) and (step.index, step.serial) == (first.index, 1)


# ── line sync commits (review M1) ────────────────────────────────────────────────────────────────


def test_line_sync_commits() -> None:
    """THE M1 test at Search level: an incoherent word document degrades to LINE_SYNC, and the line
    document that attempt produced is COMMITTED — it used to measure `usable=False` (no words), so the
    search moved on and every out-of-order document dropped its whole text."""
    search = Search(pool=[lrc(), asr()])
    search.begin()
    step = search.record(INCOHERENT)
    assert isinstance(step, Try) and step.attempt.tried == {Knob.LINE_SYNC} and step.serial == 2
    committed = search.record(LINE_SYNCED)
    assert isinstance(committed, Commit), "a usable line-synced document must publish"
    assert (committed.index, committed.serial) == (0, 2)
    assert search.pool[committed.index].label == "lrclib"
    assert [e["verdict"] for e in search.trail] == ["retime", "accept"]


def test_a_line_sync_that_produced_nothing_moves_on_with_an_honest_reason() -> None:
    search = Search(pool=[lrc(), asr()])
    search.begin()
    search.record(INCOHERENT)
    step = search.record(NOTHING)
    assert isinstance(step, Try) and search.pool[step.index].tier is Tier.ASR
    reason = search.trail[-1]["why"]
    assert isinstance(reason, str) and "carries no line timings" not in reason


# ── a refusal ends the text ──────────────────────────────────────────────────────────────────────


def test_a_refused_text_moves_on_without_line_sync() -> None:
    """The wrong-text hole: a gate refusal used to read as NOTHING_TIMED, and a timed text then retried
    LINE_SYNC — which, once M1 lets it commit, would publish the refused words."""
    search = Search(pool=[lrc(), asr()])
    search.begin()
    step = search.record(REFUSED)
    assert isinstance(step, Try), "the next text is tried"
    assert search.pool[step.index].tier is Tier.ASR and Knob.LINE_SYNC not in step.attempt.tried
    assert search.trail[-1]["verdict"] == "next" and "r=0.11" in str(search.trail[-1]["why"])


# ── best-so-far ──────────────────────────────────────────────────────────────────────────────────


def test_a_worse_retry_recommits_the_attempt_it_retried() -> None:
    """H2's other half: the last attempt no longer wins by default. A mix retry covering LESS than the
    stem attempt it retried loses to it, and the Commit names the stem attempt's serial."""
    search = Search(pool=[lrc()])
    search.begin()
    retry = search.record(THIN)
    assert isinstance(retry, Try) and retry.serial == 2
    worse = TimingReport(words=40, coverage=0.25, duration_sec=200.0, engine=Engine.WINDOWED)
    step = search.record(worse)
    assert isinstance(step, Commit) and step.serial == 1, "the stem attempt must be re-committed"
    assert "keeping attempt 1" in step.why and "align-on-mix" in step.why
    assert search.trail[-1]["kept"] == 1


@pytest.mark.parametrize("empty", [NOTHING, INCOHERENT, REFUSED], ids=["nothing", "incoherent", "refused"])
def test_a_retry_that_fails_recommits_the_usable_attempt_it_retried(empty: TimingReport) -> None:
    """A usable document with a defect beats losing it to the text's line timings or the next text."""
    search = Search(pool=[lrc(), asr()])
    search.begin()
    search.record(THIN)
    step = search.record(empty)
    assert isinstance(step, Commit) and (step.index, step.serial) == (0, 1)


def test_a_better_retry_is_the_one_committed() -> None:
    search = Search(pool=[lrc()])
    search.begin()
    search.record(THIN)
    step = search.record(TimingReport(words=190, coverage=0.95, duration_sec=200.0, engine=Engine.WINDOWED))
    assert isinstance(step, Commit) and step.serial == 2


#: A windowed attempt with TWO defects a knob addresses: a +5 s residual (RESHIFT) and 50% coverage
#: (ALIGN_ON_MIX). `decide` answers the residual first.
MISPLACED_AND_THIN = TimingReport(
    words=100, coverage=0.5, duration_sec=200.0, residual_sec=5.0, engine=Engine.WINDOWED
)


def test_a_retry_that_does_not_improve_goes_back_and_tries_the_next_knob_from_the_kept_attempt() -> None:
    """Best-so-far must not END the ladder (review W1 r1). The RESHIFT retry leaves the residual where it
    was, so it loses to attempt 1 — and attempt 1 still has thin coverage, which the mix may fix. That
    retry is offered FROM attempt 1: the lost RESHIFT is spent (never re-offered) but not applied, so the
    mix attempt changes one thing relative to the attempt it must beat. It used to commit attempt 1 at
    once, and the mix was never tried."""
    search = Search(pool=[lrc()])
    search.begin()
    reshift = search.record(MISPLACED_AND_THIN)
    assert isinstance(reshift, Try) and reshift.attempt.tried == {Knob.RESHIFT} and reshift.base == 1
    mix = search.record(MISPLACED_AND_THIN)  # the residual did not move: RESHIFT lost
    assert isinstance(mix, Try), "the ladder goes on: ALIGN_ON_MIX still applies to attempt 1"
    assert (mix.serial, mix.base) == (3, 1), "extends the KEPT attempt, not the one that lost"
    assert mix.attempt.tried == {Knob.ALIGN_ON_MIX}, "the lost RESHIFT is not applied"
    assert mix.attempt.lost == {Knob.RESHIFT} and not mix.attempt.can(Knob.RESHIFT)
    retime = search.trail[-1]
    assert retime["verdict"] == "retime" and retime["knob"] == Knob.ALIGN_ON_MIX.value and retime["kept"] == 1
    assert str(retime["why"]).startswith("back to attempt 1 (the reshift retry did not improve on it")

    better = TimingReport(
        words=190, coverage=0.95, duration_sec=200.0, residual_sec=5.0, engine=Engine.WINDOWED
    )
    step = search.record(better)
    assert isinstance(step, Commit) and step.serial == 3, "the mix beat attempt 1 on its own defect"
    assert "accepted DESPITE residual +5.00s" in step.why and "(spent: align-on-mix, reshift)" in step.why


def test_when_every_knob_loses_the_kept_attempt_is_committed() -> None:
    """Lost knobs accumulate: after RESHIFT and then the mix both lose, neither comes back, and attempt 1
    (the stem, the text's own placement) is what publishes."""
    search = Search(pool=[lrc()])
    search.begin()
    search.record(MISPLACED_AND_THIN)
    search.record(MISPLACED_AND_THIN)
    worse = TimingReport(words=60, coverage=0.3, duration_sec=200.0, residual_sec=5.0, engine=Engine.WINDOWED)
    step = search.record(worse)
    assert isinstance(step, Commit) and step.serial == 1
    assert "keeping attempt 1: the align-on-mix retry did not improve on it" in step.why


def test_an_overshoot_whose_drop_windows_retry_lost_is_re_placed_from_the_kept_attempt() -> None:
    """The other shape: DROP_WINDOWS leaves the overshoot as it was, so RESHIFT, the overshoot's second
    answer, is tried from attempt 1 (it used to be committed with the overshoot)."""
    over = TimingReport(
        words=150, coverage=1.0, duration_sec=200.0, overshoot_sec=40.0, engine=Engine.WINDOWED
    )
    search = Search(pool=[lrc()])
    search.begin()
    dropped = search.record(over)
    assert isinstance(dropped, Try) and dropped.attempt.tried == {Knob.DROP_WINDOWS}
    step = search.record(over)
    assert isinstance(step, Try) and step.attempt.tried == {Knob.RESHIFT} and step.base == 1
    assert step.attempt.lost == {Knob.DROP_WINDOWS}


def test_best_so_far_does_not_cross_texts() -> None:
    """Another text's document is not a fallback for this one: the next text starts with no best."""
    search = Search(pool=[Candidate(tier=Tier.CANDIDATE, label="plain"), asr()])
    search.begin()
    moved = search.record(INCOHERENT)  # plain has no line timings: next text
    assert isinstance(moved, Try) and moved.serial == 2
    assert isinstance(search.record(NOTHING), GiveUp)


# ── advancing through the pool ───────────────────────────────────────────────────────────────────


def test_an_unpublishable_text_advances_to_the_next() -> None:
    """Incoherent word order with no line timings is the one verdict that abandons a text."""
    search = Search(pool=[Candidate(tier=Tier.CANDIDATE, label="plain"), asr()])
    first = search.begin()
    assert isinstance(first, Try)
    step = search.record(INCOHERENT)
    assert isinstance(step, Try)
    assert step.index != first.index
    assert search.pool[step.index].tier is Tier.ASR


def test_asr_in_the_pool_is_reached_and_can_be_committed() -> None:
    """The headline fix: a candidate that cannot be timed falls through to ASR, which then publishes."""
    search = Search(pool=[Candidate(tier=Tier.CANDIDATE, label="plain"), asr()])
    search.begin()
    step = search.record(INCOHERENT)
    assert isinstance(step, Try)
    committed = search.record(CLEAN)
    assert isinstance(committed, Commit)
    assert search.pool[committed.index].tier is Tier.ASR


# ── the mandatory ASR tier ───────────────────────────────────────────────────────────────────────


def test_an_empty_pool_runs_asr_before_giving_up() -> None:
    """No text at all is NOT evidence the song is instrumental until ASR has been tried."""
    search = Search(pool=[])
    step = search.begin()
    assert isinstance(step, RunAsr)
    assert "before concluding" in step.why


def test_a_spent_candidate_only_pool_runs_asr() -> None:
    search = Search(pool=[Candidate(tier=Tier.CANDIDATE, label="plain")])
    search.begin()
    step = search.record(INCOHERENT)
    assert isinstance(step, RunAsr), "the pool held no ASR tier, so it must be requested"


def test_asr_on_demand_is_tried_and_can_publish() -> None:
    search = Search(pool=[])
    assert isinstance(search.begin(), RunAsr)
    step = search.extend(asr("asr:mix"))
    assert isinstance(step, Try)
    assert search.pool[step.index].tier is Tier.ASR
    assert isinstance(search.record(CLEAN), Commit)


def test_asr_is_requested_at_most_once() -> None:
    """Without this the search loops between an empty pool and a failing transcriber forever."""
    search = Search(pool=[])
    assert isinstance(search.begin(), RunAsr)
    # ASR ran, produced a text, and that text turned out to be unpublishable.
    step = search.extend(Candidate(tier=Tier.ASR, label="asr:mix"))
    assert isinstance(step, Try)
    final = search.record(INCOHERENT)
    assert isinstance(final, GiveUp), "ASR has had its turn, so now the song may be called instrumental"


def test_the_on_demand_asr_text_is_the_last_one_tried_and_nothing_is_tried_twice() -> None:
    """Review s11: `extend` re-sorted the pool by tier, which put the ASR text BEFORE the machine captions
    it ran after; when it declined, the cursor walked onto both machine attempts again. Every Try below
    reports nothing, the worst case, so each text spends its line-sync rung and moves on exactly once."""
    pool = [
        lrc("captions:authored"),
        Candidate(tier=Tier.MACHINE, label="captions:machine", has_line_timings=True),
    ]
    search = Search(pool=pool)
    step = search.begin()
    tried: list[str] = []
    for _ in range(16):
        match step:
            case Try(index=index):
                tried.append(search.pool[index].label)
                step = search.record(NOTHING)
            case RunAsr():
                step = search.extend(asr())
            case Commit() | GiveUp():
                break
    assert tried == [
        "captions:authored",
        "captions:authored",
        "captions:machine",
        "captions:machine",
        "asr:vocals",
    ]
    assert isinstance(step, GiveUp)


def test_give_up_only_after_asr_was_attempted() -> None:
    """THE invariant: every route to GiveUp passes through ASR first."""
    # (a) ASR was in the pool and failed.
    a = Search(pool=[asr()])
    a.begin()
    spent_asr = a.record(INCOHERENT)
    assert isinstance(spent_asr, GiveUp)
    assert "including the ASR" in spent_asr.why

    # (b) ASR was absent, requested, and produced nothing.
    b = Search(pool=[])
    assert isinstance(b.begin(), RunAsr)
    gave_up = b.asr_produced_nothing()
    assert isinstance(gave_up, GiveUp)
    assert "produced no text" in gave_up.why


def test_asr_produced_nothing_says_so_distinctly() -> None:
    """A transcriber that heard nothing and a pool that was exhausted are different diagnoses."""
    heard_nothing = Search(pool=[]).asr_produced_nothing()
    exhausted = Search(pool=[asr()])
    exhausted.begin()
    spent = exhausted.record(INCOHERENT)
    assert isinstance(heard_nothing, GiveUp) and isinstance(spent, GiveUp)
    assert heard_nothing.why != spent.why


# ── the decision trail ───────────────────────────────────────────────────────────────────────────


def test_trail_records_every_decision_with_the_text_it_was_about() -> None:
    search = Search(pool=[lrc("lrclib"), asr("asr:vocals")])
    search.begin()
    search.record(THIN)  # retime
    search.record(INCOHERENT)  # ... eventually abandons or retimes
    verdicts = [e["verdict"] for e in search.trail]
    assert verdicts, "the trail must not be empty after two decisions"
    assert all("why" in e for e in search.trail), "every entry explains itself"
    assert any(e.get("text") == "lrclib" for e in search.trail)


def test_trail_names_the_knob_on_a_retime() -> None:
    search = Search(pool=[lrc()])
    search.begin()
    search.record(THIN)
    retimes = [e for e in search.trail if e["verdict"] == "retime"]
    assert retimes and retimes[0]["knob"] == Knob.ALIGN_ON_MIX.value


# ── termination ──────────────────────────────────────────────────────────────────────────────────


def test_search_always_terminates() -> None:
    """Structural, not capped: each Try spends a knob or advances, and RunAsr fires once.

    Driven with the WORST report — one that provokes a retime whenever any knob is available — over a
    pool of every tier. A regression that re-offers a spent knob shows up here as a hang, so the bound
    is asserted rather than trusted.
    """
    search = Search(pool=[lrc("a"), lrc("b"), asr(), Candidate(tier=Tier.MACHINE, label="yt")])
    step = search.begin()
    for _ in range(64):
        match step:
            case Try():
                step = search.record(THIN)
            case RunAsr():
                step = search.extend(asr("on-demand"))
            case Commit() | GiveUp():
                return
    pytest.fail("search did not terminate within 64 transitions")


def test_record_before_begin_is_a_programming_error() -> None:
    with pytest.raises(RuntimeError, match="no outstanding Try"):
        Search(pool=[lrc()]).record(CLEAN)
