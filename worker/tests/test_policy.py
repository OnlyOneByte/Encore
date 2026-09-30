"""The retry/accept decision, table-driven.

Every test here runs with no audio, no model, no event loop and no DBOS — which is the property that
makes this the right place for the logic. The old worker could only exercise equivalent reasoning by
running a real alignment.

The arm that matters most is `test_accepts_when_no_knob_applies`: a policy that rejects every
imperfection produces songs with no lyrics, which is the defect this rewrite exists to fix.

`ok()` builds a WINDOWED report, the engine that reads every knob, so the ladder's arms are exercised as
written; the global engine's narrower reading (review H2) has its own section below.
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
    improves,
    offers,
    order_pool,
)
from encore_worker.domain.lyrics.report import Engine, TimingReport


def ok(**over: object) -> TimingReport:
    """A clean WINDOWED report: 200 words, full coverage, no defects. Override one field per test."""
    base: dict[str, object] = {
        "words": 200,
        "coverage": 1.0,
        "duration_sec": 200.0,
        "engine": Engine.WINDOWED,
        "lines": 20,
    }
    base.update(over)
    return TimingReport(**base)  # type: ignore[arg-type]


def lined(**over: object) -> TimingReport:
    """A clean LINE_SYNC report: 20 timed lines, no words — the shape a line-synced document measures."""
    return ok(**{"words": 0, "engine": Engine.LINE_SYNC, **over})


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
    assert "no untried knob the windowed engine reads" in verdict.why
    assert "none applicable" in verdict.why, "an empty `tried` set must say so, not read as blank"


# ── unusable word timing ─────────────────────────────────────────────────────────────────────────


def test_out_of_order_degrades_to_line_sync() -> None:
    verdict = decide(ok(out_of_order=3), FULL)
    assert verdict == Retime(
        Knob.LINE_SYNC,
        "word timing is incoherent (3 out of order) — degrading to the text's own line timings",
    )


def test_out_of_order_with_no_line_timings_moves_on() -> None:
    """Incoherent word order and nothing to fall back to."""
    verdict = decide(ok(out_of_order=3), Attempt(has_line_timings=False))
    assert isinstance(verdict, NextText)
    assert "no line timings" in verdict.why


def test_an_attempt_that_timed_nothing_says_so() -> None:
    """NOTHING_TIMED is not "0 out of order": the trail must not call an empty attempt incoherent."""
    retime = decide(TimingReport(words=0, coverage=0.0), FULL)
    assert isinstance(retime, Retime) and retime.knob is Knob.LINE_SYNC
    assert "timed no word" in retime.why and "out of order" not in retime.why


def test_zero_words_is_not_usable() -> None:
    """`usable` requires words > 0, so an empty doc must not be accepted as flawless."""
    verdict = decide(ok(words=0, coverage=0.0), FULL)
    assert isinstance(verdict, Retime | NextText)


# ── a gate refusal ends the text ─────────────────────────────────────────────────────────────────


def test_a_gate_refusal_is_terminal_for_the_text_even_with_line_timings() -> None:
    """THE wrong-text hazard W0 measured: 168 of 320 bench wrong texts were refused by the envelope gate
    and then retried LINE_SYNC, which publishes the same words on their own clock. Refusal ends the text."""
    refused = TimingReport(engine=Engine.GLOBAL, refused="envelope gate refused: blind r=0.12 @ +3.10s")
    verdict = decide(refused, FULL)
    assert isinstance(verdict, NextText), "a refused text must not degrade to line sync"
    assert "r=0.12" in verdict.why and "terminal" in verdict.why


def test_a_refused_line_sync_names_the_rung() -> None:
    verdict = decide(lined(lines=0, refused="sheet-span envelope r=0.08"), FULL.with_tried(Knob.LINE_SYNC))
    assert isinstance(verdict, NextText)
    assert verdict.why.startswith("line sync refused: sheet-span envelope r=0.08")


def test_a_refused_report_is_never_usable() -> None:
    assert not TimingReport(words=200, coverage=1.0, refused="x").usable


# ── line sync (review M1) ────────────────────────────────────────────────────────────────────────


def test_a_line_synced_document_is_judged_on_its_lines_and_commits() -> None:
    """M1: judged on words, a line document (which has none) was `usable=False` by construction, so the
    LINE_SYNC knob could never commit and every out-of-order doc dropped its whole text."""
    report = lined()
    assert report.usable
    verdict = decide(report, FULL.with_tried(Knob.LINE_SYNC))
    assert isinstance(verdict, Accept)
    assert "20 lines, line-synced" in verdict.why


def test_line_sync_is_the_terminal_rung() -> None:
    """A defect on a line document offers no knob: every one would re-publish the same line timings."""
    after = FULL.with_tried(Knob.LINE_SYNC)
    for defect in (lined(overshoot_sec=40.0), lined(coverage=0.3), lined(residual_sec=-6.0)):
        assert isinstance(decide(defect, after), Accept), defect


def test_backwards_lines_are_not_usable() -> None:
    assert not lined(out_of_order=2).usable
    assert not lined(lines=0).usable


def test_a_failed_line_sync_does_not_claim_the_text_has_no_line_timings() -> None:
    """The message W0 flagged: after LINE_SYNC failed, NextText said the text 'carries no line timings'
    — when it has them and they were just tried."""
    after = FULL.with_tried(Knob.LINE_SYNC)
    for report in (TimingReport(words=0, coverage=0.0), lined(out_of_order=3), lined(lines=0)):
        verdict = decide(report, after)
        assert isinstance(verdict, NextText)
        assert "carries no line timings" not in verdict.why
        assert "line sync, already spent" in verdict.why
    assert "3 lines start before the previous one" in decide(lined(out_of_order=3), after).why
    assert decide(TimingReport(), after).why.startswith("the line-sync attempt produced no document")


# ── engine-aware knobs (review H2) ───────────────────────────────────────────────────────────────


def test_the_global_engine_is_never_offered_align_on_mix() -> None:
    """H2: under the global decode, thin coverage is a long instrumental outro far more often than an
    inaudible stem, and R4 already asks the mix per stem-silent line. Coverage stays telemetry."""
    thin = ok(coverage=0.4, engine=Engine.GLOBAL)
    verdict = decide(thin, FULL)
    assert isinstance(verdict, Accept)
    assert "DESPITE" not in verdict.why, "for the global engine, coverage is telemetry, not a defect"
    assert "coverage 40%" in verdict.why, "... but it is still reported"


def test_the_windowed_engine_still_retries_thin_coverage_on_the_mix() -> None:
    verdict = decide(ok(coverage=0.4), FULL)
    assert isinstance(verdict, Retime) and verdict.knob is Knob.ALIGN_ON_MIX


@pytest.mark.parametrize(
    "report",
    [
        TimingReport(words=200, coverage=1.0, duration_sec=200.0, residual_sec=-6.0),
        TimingReport(words=200, coverage=1.0, duration_sec=200.0, overshoot_sec=60.0),
        TimingReport(words=200, coverage=0.3, duration_sec=200.0),
    ],
)
def test_the_global_engine_reads_no_retime_knob_but_line_sync(report: TimingReport) -> None:
    """RESHIFT re-places input timings it never used, DROP_WINDOWS widens windows it never searched,
    ALIGN_ON_MIX (above): each would re-run the same or a worse decode."""
    assert report.engine is Engine.GLOBAL, "the default engine is THE path"
    assert isinstance(decide(report, FULL), Accept)


def test_the_global_engine_still_degrades_incoherent_order_to_line_sync() -> None:
    assert decide(TimingReport(words=200, coverage=1.0, out_of_order=1), FULL) == Retime(
        Knob.LINE_SYNC,
        "word timing is incoherent (1 out of order) — degrading to the text's own line timings",
    )


# ── the cross-kind comparison (W4): claims nothing relates to these timings ───────────────────────


def test_a_word_document_nothing_relates_to_its_claims_asks_the_text_s_own_timings() -> None:
    """W4: `reconcile` fitted no map between our timings and the sheet's, so both witnesses cannot be
    right and ours is the one with no second opinion behind it. Measured: those documents carry 84% of the
    corpus's gross lines at `run_align`."""
    verdict = decide(ok(engine=Engine.GLOBAL, claims_related=False), FULL)
    assert isinstance(verdict, Retime) and verdict.knob is Knob.LINE_SYNC
    assert "nothing relates these timings to the text's own claimed line starts" in verdict.why
    assert "beat this document" in verdict.why, "the rung has to win, not merely run"


@pytest.mark.parametrize("related", [True, None], ids=["related", "unanswered"])
def test_a_word_document_its_claims_corroborate_keeps_its_words(related: bool | None) -> None:
    """The other 95%: a related verdict — or none at all (an untimed text, three disagreeing pairs) — is
    not a reason to spend the terminal rung. 107 743 word timings ride on this branch."""
    verdict = decide(ok(engine=Engine.GLOBAL, claims_related=related), FULL)
    assert isinstance(verdict, Accept)


def test_an_unrelated_sheet_is_not_asked_before_a_knob_that_could_repair_the_words() -> None:
    """LINE_SYNC abandons word timing, so it goes LAST: a windowed document that is both misplaced and
    unrelated re-places first, and only a document with no knob left falls to the rung."""
    both = ok(residual_sec=-6.0, claims_related=False)
    assert decide(both, FULL) == Retime(
        Knob.RESHIFT,
        "residual -6.00s after placement — the text was probably written for a different master; "
        "re-placing against the aligned output",
    )
    spent = FULL.with_tried(Knob.RESHIFT).with_tried(Knob.DROP_WINDOWS).with_tried(Knob.ALIGN_ON_MIX)
    assert isinstance(decide(both, spent), Retime), "the rung is still there when nothing else is"


def test_a_refusal_stays_terminal_even_where_the_claims_are_unrelated() -> None:
    """W1's rule outranks the new one: a gate that measured these words not to be this audio's ends the
    TEXT, and line sync would publish the same words on their own clock past no gate at all."""
    refused = ok(refused="lexical gate refused: lexical lift +0.03", claims_related=False)
    assert isinstance(decide(refused, FULL), NextText)


def test_a_document_accepted_over_an_unrelated_sheet_says_so() -> None:
    """The rung ran and lost (its gate refused the sheet): the trail must say the document published on an
    unresolved disagreement, which is the shape to investigate when the lyrics scroll wrong."""
    verdict = decide(ok(engine=Engine.GLOBAL, claims_related=False), FULL.with_lost(Knob.LINE_SYNC))
    assert isinstance(verdict, Accept)
    assert "accepted DESPITE claims unrelated to these timings" in verdict.why
    assert "(spent: line-sync)" in verdict.why


def test_a_line_document_reports_nothing_about_its_claims() -> None:
    """A line document IS the claims, so there is no second measurement to relate them to — and the rung
    is terminal, so no knob reads the field there either."""
    assert lined().claims_related is None
    assert isinstance(decide(lined(claims_related=False), FULL.with_tried(Knob.LINE_SYNC)), Accept)


def test_offers_needs_the_engine_to_read_the_knob() -> None:
    assert offers(ok(), FULL, Knob.ALIGN_ON_MIX)
    assert not offers(ok(engine=Engine.GLOBAL), FULL, Knob.ALIGN_ON_MIX)
    assert offers(ok(engine=Engine.GLOBAL), FULL, Knob.LINE_SYNC)
    assert not any(offers(lined(), FULL, knob) for knob in Knob)


# ── best-so-far: must a retry beat what it retried? ──────────────────────────────────────────────


@pytest.mark.parametrize(
    ("knob", "before", "after", "better"),
    [
        (Knob.ALIGN_ON_MIX, ok(coverage=0.6), ok(coverage=0.9), True),
        (Knob.ALIGN_ON_MIX, ok(coverage=0.6), ok(coverage=0.6), False),  # a tie keeps the stem
        (Knob.ALIGN_ON_MIX, ok(coverage=0.6), ok(coverage=0.5), False),
        (Knob.RESHIFT, ok(residual_sec=-4.0), ok(residual_sec=0.3), True),
        (Knob.RESHIFT, ok(residual_sec=-4.0), ok(residual_sec=5.0), False),
        (Knob.RESHIFT, ok(residual_sec=-4.0), ok(), False),  # an unanswerable residual proves nothing
        (Knob.RESHIFT, ok(overshoot_sec=40.0), ok(overshoot_sec=0.0), True),  # the overshoot branch
        (Knob.DROP_WINDOWS, ok(overshoot_sec=40.0), ok(overshoot_sec=10.0), True),
        (Knob.DROP_WINDOWS, ok(overshoot_sec=40.0), ok(overshoot_sec=40.0), False),
        (Knob.LINE_SYNC, ok(out_of_order=0), lined(), False),  # word timing with a defect beats none
        # ACROSS KINDS (W4): the line document wins only where nothing related the words to the claims...
        (Knob.LINE_SYNC, ok(claims_related=False), lined(), True),
        (Knob.LINE_SYNC, ok(claims_related=True), lined(), False),
        # ... and only if it times as many lines (a sheet stamped on 3 lines of 20 is a downgrade).
        (Knob.LINE_SYNC, ok(claims_related=False), lined(lines=3), False),
        (Knob.LINE_SYNC, ok(claims_related=False), lined(lines=21), True),
        # Its own gate refusing the sheet is not a verdict on the text: the words are what is kept.
        (Knob.LINE_SYNC, ok(claims_related=False), lined(refused="decode agreement 0.31"), False),
    ],
)
def test_improves_judges_the_defect_the_knob_was_spent_on(
    knob: Knob, before: TimingReport, after: TimingReport, better: bool
) -> None:
    assert improves(before, after, knob) is better


def test_an_unusable_or_refused_retry_never_improves() -> None:
    for after in (ok(out_of_order=2), TimingReport(), ok(coverage=0.99, refused="gate")):
        assert not improves(ok(coverage=0.5), after, Knob.ALIGN_ON_MIX)


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

    Note LINE_SYNC is reached from the not-usable branch, which is why the probe reports differ. The
    probes are WINDOWED: that engine reads every knob, and the global one only LINE_SYNC (above).
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
