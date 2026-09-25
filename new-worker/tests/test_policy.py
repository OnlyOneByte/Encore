"""The retry/accept decision, table-driven.

Every test here runs with no audio, no model, no event loop and no DBOS — which is the property that
makes this the right place for the logic. The old worker could only exercise equivalent reasoning by
running a real alignment.

The arm that matters most is `test_accepts_when_no_knob_applies`: a policy that rejects every
imperfection produces songs with no lyrics, which is the defect this rewrite exists to fix.
"""

from __future__ import annotations

import pytest

from encore_worker.domain.lyrics.policy import (
    Accept,
    Attempt,
    Knob,
    NextText,
    Retime,
    Tier,
    asr_is_mandatory,
    decide,
    order_pool,
)
from encore_worker.domain.lyrics.report import TimingReport


def ok(**over: object) -> TimingReport:
    """A clean report: 200 words, full coverage, no defects. Override one field per test."""
    base: dict[str, object] = {"words": 200, "coverage": 1.0, "duration_sec": 200.0}
    base.update(over)
    return TimingReport(**base)  # type: ignore[arg-type]


FULL = Attempt(has_windows=True, has_line_timings=True, has_own_line_timings=True)


# ── acceptance ───────────────────────────────────────────────────────────────────────────────────


def test_accepts_a_clean_alignment() -> None:
    verdict = decide(ok(), FULL)
    assert isinstance(verdict, Accept)
    assert "200 words" in verdict.why


def test_accepts_when_no_knob_applies() -> None:
    """THE load-bearing arm. A defect with nothing left to try must ACCEPT, never reject.

    If a transcription covered only the first third of a song, the timing for that third is still
    correct. Refusing publishes nothing, which is strictly worse than publishing partial lyrics — and
    "publishes nothing" is the bug this rewrite exists to fix.
    """
    thin = ok(coverage=0.35)
    spent = Attempt(tried=frozenset(Knob), aligned_on_stem=False, has_line_timings=True)
    verdict = decide(thin, spent)
    assert isinstance(verdict, Accept), "a defect with no remaining knob must be accepted"
    assert "DESPITE" in verdict.why and "coverage 35%" in verdict.why


def test_accept_reason_names_the_defect_and_what_was_spent() -> None:
    """An accept-with-nothing-better must be distinguishable in a log from a clean accept."""
    verdict = decide(ok(coverage=0.5), Attempt(aligned_on_stem=False))
    assert isinstance(verdict, Accept)
    assert "no untried knob" in verdict.why
    assert "none applicable" in verdict.why, "an empty `tried` set must say so, not read as blank"


# ── unusable word timing ─────────────────────────────────────────────────────────────────────────


def test_out_of_order_degrades_to_line_sync() -> None:
    verdict = decide(ok(out_of_order=3), FULL)
    assert verdict == Retime(
        Knob.LINE_SYNC,
        "word timing is incoherent (3 out of order) — degrading to the text's own line timings",
    )


def test_out_of_order_with_no_line_timings_moves_on() -> None:
    """The ONE branch that rejects a text: incoherent word order and nothing to fall back to."""
    verdict = decide(ok(out_of_order=3), Attempt(has_line_timings=False))
    assert isinstance(verdict, NextText)
    assert "no line timings" in verdict.why


def test_zero_words_is_not_usable() -> None:
    """`usable` requires words > 0, so an empty doc must not be accepted as flawless."""
    verdict = decide(ok(words=0, coverage=0.0), FULL)
    assert isinstance(verdict, Retime | NextText)


# ── out of sync ──────────────────────────────────────────────────────────────────────────────────


def test_residual_triggers_a_reshift_first() -> None:
    """The cheapest knob, and the most direct answer to "the lyrics are out of sync"."""
    verdict = decide(ok(residual_sec=-3.4), FULL)
    assert isinstance(verdict, Retime)
    assert verdict.knob is Knob.RESHIFT
    assert "-3.40s" in verdict.why and "different master" in verdict.why


def test_residual_within_tolerance_is_not_a_defect() -> None:
    assert isinstance(decide(ok(residual_sec=1.2), FULL), Accept)


def test_reshift_is_not_offered_to_a_text_with_no_timings_of_its_own() -> None:
    """An ASR text is already measured on this audio; re-placing it is meaningless."""
    asr = Attempt(has_own_line_timings=False)
    assert isinstance(decide(ok(residual_sec=9.0), asr), Accept)


# ── overshoot: "the song ends in the middle of the lyrics" ────────────────────────────────────────


def test_overshoot_widens_the_search_before_re_placing() -> None:
    """Window first: a narrow window from a bad placement is the usual cause of the overshoot."""
    verdict = decide(ok(overshoot_sec=40.0), FULL)
    assert isinstance(verdict, Retime)
    assert verdict.knob is Knob.DROP_WINDOWS


def test_overshoot_falls_back_to_reshift_once_windows_are_dropped() -> None:
    after = FULL.with_tried(Knob.DROP_WINDOWS)
    verdict = decide(ok(overshoot_sec=40.0), after)
    assert isinstance(verdict, Retime)
    assert verdict.knob is Knob.RESHIFT


def test_overshoot_is_fractional_not_absolute() -> None:
    """3s over a 10-minute recording is within tolerance; 3s over a 20-second clip is not."""
    assert isinstance(decide(ok(overshoot_sec=3.0, duration_sec=600.0), FULL), Accept)
    short = decide(ok(overshoot_sec=3.0, duration_sec=20.0), FULL)
    assert isinstance(short, Retime)


# ── thin coverage ────────────────────────────────────────────────────────────────────────────────


def test_thin_coverage_retries_on_the_mix() -> None:
    verdict = decide(ok(coverage=0.4), FULL)
    assert isinstance(verdict, Retime)
    assert verdict.knob is Knob.ALIGN_ON_MIX
    assert "over-suppressed stem" in verdict.why


def test_thin_coverage_on_the_mix_already_is_accepted() -> None:
    """Nothing left to try, so the partial timing ships rather than nothing shipping."""
    verdict = decide(ok(coverage=0.4), Attempt(aligned_on_stem=False))
    assert isinstance(verdict, Accept)


# ── knob applicability ───────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("knob", "attempt", "expected"),
    [
        (Knob.RESHIFT, Attempt(has_own_line_timings=True), True),
        (Knob.RESHIFT, Attempt(has_own_line_timings=False), False),
        (Knob.ALIGN_ON_MIX, Attempt(aligned_on_stem=True), True),
        (Knob.ALIGN_ON_MIX, Attempt(aligned_on_stem=False), False),
        (Knob.DROP_WINDOWS, Attempt(has_windows=True), True),
        (Knob.DROP_WINDOWS, Attempt(has_windows=False), False),
        (Knob.LINE_SYNC, Attempt(has_line_timings=True), True),
        (Knob.LINE_SYNC, Attempt(has_line_timings=False), False),
    ],
)
def test_knob_applicability(knob: Knob, attempt: Attempt, expected: bool) -> None:
    assert attempt.can(knob) is expected


def test_a_spent_knob_is_never_offered_again() -> None:
    """Without this the machine loops forever on the same defect."""
    for knob in Knob:
        assert not FULL.with_tried(knob).can(knob)


def test_with_tried_closes_the_knob_it_spent() -> None:
    """Taking ALIGN_ON_MIX means we are no longer on the stem, so it cannot be offered twice."""
    after = FULL.with_tried(Knob.ALIGN_ON_MIX)
    assert after.aligned_on_stem is False
    assert FULL.with_tried(Knob.DROP_WINDOWS).has_windows is False
    # The text's own properties are facts about the TEXT and must survive a knob change.
    assert after.has_line_timings is True
    assert after.has_own_line_timings is True


def test_attempts_are_immutable() -> None:
    with pytest.raises(AttributeError):
        FULL.tried = frozenset()  # type: ignore[misc]


def test_every_knob_is_reachable_from_some_defect() -> None:
    """A knob no report can trigger is dead configuration. This is the non-vacuity floor.

    Note LINE_SYNC is reached from the not-usable branch, which is why the probe reports differ.
    """
    reachable: set[Knob] = set()
    probes = [
        (ok(out_of_order=2), FULL),
        (ok(residual_sec=-9.0), FULL),
        (ok(overshoot_sec=99.0), FULL),
        (ok(coverage=0.2), FULL.with_tried(Knob.RESHIFT).with_tried(Knob.DROP_WINDOWS)),
    ]
    for report, attempt in probes:
        verdict = decide(report, attempt)
        if isinstance(verdict, Retime):
            reachable.add(verdict.knob)
    assert reachable == set(Knob), f"unreachable knob(s): {sorted(set(Knob) - reachable)}"


# ── pool ordering and the ASR tier ───────────────────────────────────────────────────────────────


def test_pool_order_is_candidates_then_asr_then_machine() -> None:
    tiers = [Tier.MACHINE, Tier.ASR, Tier.CANDIDATE, Tier.CANDIDATE]
    assert order_pool(tiers) == [2, 3, 1, 0]


def test_pool_order_is_stable_within_a_tier() -> None:
    """Grading's argmax over candidates must survive; ordering only groups by authority."""
    assert order_pool([Tier.CANDIDATE] * 4) == [0, 1, 2, 3]


def test_asr_ranks_above_machine_captions() -> None:
    """Both are measurements of this audio, but YouTube's automatic track is the worse one."""
    assert order_pool([Tier.MACHINE, Tier.ASR]) == [1, 0]


def test_asr_is_mandatory_before_concluding_no_lyrics() -> None:
    """A pool with no ASR entry has not earned the right to say the song has no words.

    ASR-on-the-mix needs only the audio, which every job past acquisition has — so an absent ASR tier
    means the transcriber failed or was never built. That is a defect to recover from, not evidence.
    """
    assert asr_is_mandatory([Tier.ASR])
    assert asr_is_mandatory([Tier.CANDIDATE, Tier.ASR])
    assert not asr_is_mandatory([Tier.CANDIDATE])
    assert not asr_is_mandatory([Tier.CANDIDATE, Tier.MACHINE])
    assert not asr_is_mandatory([])
