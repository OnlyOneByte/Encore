"""The fallback ladder, driven end to end with no audio, no model and no DBOS.

The arms that matter most are the ones about `GiveUp`: it must be reachable from exactly one situation —
the pool is spent AND ASR has had its turn — because "no lyrics" is the absolute worst case and the old
worker reached it far too easily.
"""

from __future__ import annotations

import pytest

from encore_worker.domain.lyrics.policy import Knob, Tier
from encore_worker.domain.lyrics.report import TimingReport
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
THIN = TimingReport(words=50, coverage=0.3, duration_sec=200.0)


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
