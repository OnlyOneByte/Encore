"""GradeAndSelect threads `audio.duration_sec` into selection.

`select_by_baselines` cannot see the song length on its own — its only caller is this step. Overshoot
needs the duration, so the step must (1) DECLARE the read (runtime/plan.py fails a plan for a step
reading an undeclared key) and (2) actually PASS it through, so an over-covered candidate is demoted
and the overshoot is reported in the process log.
"""

from __future__ import annotations

from src.lyrics.grading import (
    ROLE_BASELINE,
    ROLE_CANDIDATE,
    SOURCE_ASR,
    SOURCE_CAPTIONS,
    SOURCE_LRCLIB,
    TIMING_LINE,
    LyricsText,
    candidate_last_end,
    composite_score,
    overshoot_penalized,
    select_by_baselines,
)
from src.processor import JobSpec
from src.steps.lyrics import GradeAndSelect

SHARED = "hello hello baby you called i cant hear a thing i have got no service in the club you say"
GUEST = "boy the way you blowing up my phone wont make me leave no faster put my coat on faster"


def _timed(
    source: str, body: str, variant: str, per_word_end: float, role: str = ROLE_CANDIDATE
) -> LyricsText:
    segs = [{"start": 0.0, "end": float(per_word_end), "text": w} for w in body.split(" ")]
    t = LyricsText(
        text_source=source,
        segments=segs,
        timing=TIMING_LINE,
        text_confidence="high",
        role=role,
        variant=variant,
    )
    if role == ROLE_BASELINE:
        t.baseline_rank = 0
        t.text_confidence = "low"
    return t


def test_reads_declares_audio_duration_sec():
    """The plan-validation contract: the step must declare the key it now consumes."""
    assert "audio.duration_sec" in GradeAndSelect.reads
    assert "lyrics.texts" in GradeAndSelect.reads


def _run_step(texts, duration_sec, tmp_path):
    import asyncio

    from src.runtime.ctx import AudioCtx, Ctx, LyricsCtx

    notes: list[str] = []
    ctx = Ctx(
        job=JobSpec(
            job_id="j",
            media_id="m",
            job_type="align",
            source_uri="/x.wav",
            params={},
            media_dir=str(tmp_path),
        ),
        work=str(tmp_path),
        audio=AudioCtx(path="/x.wav", vocals_path=None, duration_sec=duration_sec),
        lyrics=LyricsCtx(texts=texts),
    )
    ctx.note = notes.append  # type: ignore[method-assign]

    async def _drive():
        async for _ in GradeAndSelect().run(ctx):
            pass

    asyncio.run(_drive())
    return ctx, notes


def test_step_passes_duration_through_so_overcovered_candidate_is_demoted(tmp_path):
    """A rival exists whose RAW agreement is LOWER than the over-covered candidate's, so ONLY the
    overshoot penalty can flip the pick to it: the overshooter is timed to 330s (+23% of 268s, past
    OVERSHOOT_FRACTION_MAX) and its raw lead (0.646 vs 0.506) is what the penalty must overturn."""
    over = _timed(SOURCE_LRCLIB, LONGER_MASTER_300, "longer-master", per_word_end=330.0)
    fits = _timed(SOURCE_CAPTIONS, FITS_THIS_RECORDING_265, "fits-the-audio", per_word_end=241.0)
    baseline = _timed(SOURCE_ASR, AUDIBLE_268, "whisper/vocals", per_word_end=241.0, role=ROLE_BASELINE)

    # Non-vacuity floor: the over-covered candidate MUST out-score the fitting one on RAW agreement,
    # otherwise the fitting one wins with or without the penalty and this test proves nothing. This
    # fires if the two fixtures are ever swapped back to a byte-identical-to-baseline rival (the exact
    # way the old fixture went vacuous).
    assert composite_score(over, [baseline]).score > composite_score(fits, [baseline]).score, (
        "fixture is vacuous: the fitting rival already out-scores the overshooter on raw agreement"
    )

    ctx, _ = _run_step([over, fits, baseline], 268.0, tmp_path)

    assert ctx.lyrics.selection.publish[0].variant == "fits-the-audio"


def test_step_reports_overshoot_in_the_process_log_when_the_published_pick_overshoots(tmp_path):
    """No rival: the over-covered candidate is the only claim, so it still publishes — but the
    overshoot MUST be surfaced in the process log, proving the duration reached the step."""
    over = _timed(SOURCE_LRCLIB, f"{SHARED} {GUEST}", "wrong-longer-master", per_word_end=180.0)
    baseline = _timed(SOURCE_ASR, SHARED, "whisper/vocals", per_word_end=90.0, role=ROLE_BASELINE)

    ctx, notes = _run_step([over, baseline], 100.0, tmp_path)

    assert ctx.lyrics.selection.publish[0].variant == "wrong-longer-master"
    assert any("overshoot" in n.lower() and "+80s" in n for n in notes), notes


# The overshoot NOTE must not be silent when the demotion actually fires, and must not claim
# "demoted" for a pick that published: a demoted candidate is not a survivor of sel.publish, so
# reporting must walk the pre-selection pool, not just the winners.


def test_a_demoted_overshooting_candidate_still_gets_an_overshoot_note_naming_the_demotion(tmp_path):
    """Across-source, `longer-master` out-scores the fitting rival on RAW agreement, so ONLY the
    penalty demotes it below `fits-the-audio`. Must emit a note that names the overshooting LOSER,
    says it was NOT published, and names the winner."""
    over = _timed(SOURCE_LRCLIB, LONGER_MASTER_300, "longer-master", per_word_end=330.0)
    fits = _timed(SOURCE_CAPTIONS, FITS_THIS_RECORDING_265, "fits-the-audio", per_word_end=241.0)
    baseline = _timed(SOURCE_ASR, AUDIBLE_268, "whisper/vocals", per_word_end=241.0, role=ROLE_BASELINE)

    ctx, notes = _run_step([over, fits, baseline], 268.0, tmp_path)

    # the demotion worked: the fitting rival is what publishes, and the penalty is why (see the
    # non-vacuity floor above, which proves the overshooter led on raw agreement)
    assert ctx.lyrics.selection.publish[0].variant == "fits-the-audio"
    overshoot_notes = [n for n in notes if "overshoot" in n.lower()]
    assert overshoot_notes, notes
    demoted = [n for n in overshoot_notes if "longer-master" in n and "+62s" in n]
    assert demoted, overshoot_notes
    assert "NOT published" in demoted[0], demoted[0]
    assert "fits-the-audio" in demoted[0], demoted[0]


def test_an_overshooting_published_pick_is_not_reported_as_demoted(tmp_path):
    """No rival, so the over-covered candidate is the only claim and still publishes. Must NOT claim
    the published pick was demoted, and must say it published anyway."""
    over = _timed(SOURCE_LRCLIB, f"{SHARED} {GUEST}", "wrong-longer-master", per_word_end=180.0)
    baseline = _timed(SOURCE_ASR, SHARED, "whisper/vocals", per_word_end=90.0, role=ROLE_BASELINE)

    ctx, notes = _run_step([over, baseline], 100.0, tmp_path)

    assert ctx.lyrics.selection.publish[0].variant == "wrong-longer-master"
    overshoot_notes = [n for n in notes if "overshoot" in n.lower() and "+80s" in n]
    assert overshoot_notes, notes
    note = overshoot_notes[0]
    assert "demoted" not in note.lower(), note
    assert "PUBLISHED anyway" in note, note


# A wrong-song candidate loses on AGREEMENT by a margin the comparative overshoot penalty never comes
# near — switching the penalty off still yields the same winner — so the note must NOT claim the
# penalty caused the pick from `is_published` alone.

#: A genuinely DIFFERENT song, and a LONGER one (its own timings run to 180s against 100s of audio).
#: Low agreement with the audible words, so it loses on the metric — the penalty is not why.
WRONG_SONG_LONGER = (
    "humpty dumpty sat on a wall humpty dumpty had a great fall all the kings horses and "
    "all the kings men couldnt put humpty together again not once not ever no how no way"
)


def test_a_demoted_wrong_song_pick_is_not_reported_as_caused_by_the_overshoot_penalty(tmp_path):
    """A wrong-song candidate overshoots AND scores near-zero agreement, so it loses on the metric,
    not the penalty. The CONTROL — `select_by_baselines(texts, None)`, penalty switched off entirely
    — publishes the SAME winner, proving the demotion decided nothing. Must NOT claim it was
    demoted, must say it was NOT published, and must name the winner it lost to."""
    wrong = _timed(SOURCE_LRCLIB, WRONG_SONG_LONGER, "wrong-song-longer", per_word_end=180.0)
    fits = _timed(SOURCE_CAPTIONS, AUDIBLE_268, "fits-the-audio", per_word_end=90.0)
    baseline = _timed(SOURCE_ASR, AUDIBLE_268, "whisper/vocals", per_word_end=90.0, role=ROLE_BASELINE)

    # control: with the penalty OFF, the same candidate still wins — the demotion is not what rejected it
    control = select_by_baselines([wrong, fits, baseline], None)
    ctx, notes = _run_step([wrong, fits, baseline], 100.0, tmp_path)
    assert [p.variant for p in control.publish] == [p.variant for p in ctx.lyrics.selection.publish], (
        "control invalid: the penalty DID flip this pick, so it is not an F2 case"
    )
    assert ctx.lyrics.selection.publish[0].variant == "fits-the-audio"

    overshoot_notes = [n for n in notes if "overshoot" in n.lower() and "wrong-song-longer" in n]
    assert overshoot_notes, notes
    note = overshoot_notes[0]
    assert "DEMOTED" not in note, note
    assert "demoted" not in note.lower(), note
    assert "NOT published" in note, note
    assert "fits-the-audio" in note, note


# The verdict must not claim "no candidate that fits the audio" from `is_published` alone, which is
# false whenever the COMPARATIVE overshoot penalty is smaller than the overshooter's score lead, and
# must not drop `is_published` entirely, or a tolerated overshoot on a REJECTED rival reads as one on
# the lyrics that shipped.

#: The audible words — what the ASR baseline heard off this recording.
AUDIBLE_268 = (
    "once upon a time i was falling in love but now im only falling apart "
    "theres nothing i can do a total eclipse of the heart"
)
#: A LONGER MASTER: every audible word plus a tail this recording does not contain. High agreement,
#: and its own timings run to 300s against 268s of audio — +12%, just past OVERSHOOT_FRACTION_MAX.
LONGER_MASTER_300 = AUDIBLE_268 + " turn around bright eyes turn around bright eyes every now and then i know"
#: A poorer transcription of THIS recording: lower agreement, but its timings stop at 265s, inside
#: the audio. Chosen so the +12% penalty (0.646 -> 0.526) does NOT close the gap to its 0.506, which
#: is the whole reachable trigger — the overshooter publishes with a fitting rival in the pool.
FITS_THIS_RECORDING_265 = (
    "once upon a day i was drifting in love yet now im merely falling away "
    "theres little else i can do a partial eclipse of my heart"
)


def test_a_published_overshoot_does_not_claim_nothing_fit_when_a_fitting_rival_was_in_the_pool(
    tmp_path,
):
    """A NON-FLIPPING overshoot: `overshoot_penalized` at +12% takes 0.646 to 0.526, and the
    overshooter still beats the 0.506 rival whose timings fit the audio. Must not claim "no candidate
    that fits the audio" (false: `fits-this-recording` was fetched, graded, and never published), and
    must name the candidate that did fit."""
    over = _timed(SOURCE_LRCLIB, LONGER_MASTER_300, "longer-master", per_word_end=300.0)
    fits = _timed(SOURCE_CAPTIONS, FITS_THIS_RECORDING_265, "fits-this-recording", per_word_end=265.0)
    baseline = _timed(SOURCE_ASR, AUDIBLE_268, "whisper/vocals", per_word_end=265.0, role=ROLE_BASELINE)

    ctx, notes = _run_step([over, fits, baseline], 268.0, tmp_path)

    # the trigger: the penalty did NOT flip the pick, and the rival that fits stayed unpublished
    assert [p.variant for p in ctx.lyrics.selection.publish] == ["longer-master"]
    assert candidate_last_end(fits) is not None and candidate_last_end(fits) <= 268.0
    overshoot_notes = [n for n in notes if "overshoot" in n.lower() and "longer-master" in n]
    assert overshoot_notes, notes
    note = overshoot_notes[0]
    assert "PUBLISHED anyway" in note, note
    assert "no candidate that fits the audio" not in note, note
    assert "fits-this-recording" in note, note


def test_a_tolerated_overshoot_on_a_rejected_candidate_says_it_was_not_published(tmp_path):
    """The published pick does not overshoot at all (last_end 90s of 100s), and the only overshoot
    line in the log is about a REJECTED rival 5s long — inside the tolerance band, so no demotion
    fires. Must say it was not published, and which variant was."""
    fits = _timed(SOURCE_CAPTIONS, AUDIBLE_268, "fits-the-audio", per_word_end=90.0)
    mildly_long = _timed(SOURCE_LRCLIB, FITS_THIS_RECORDING_265, "mildly-long", per_word_end=105.0)
    baseline = _timed(SOURCE_ASR, AUDIBLE_268, "whisper/vocals", per_word_end=90.0, role=ROLE_BASELINE)

    ctx, notes = _run_step([fits, mildly_long, baseline], 100.0, tmp_path)

    # the trigger: what shipped fits the audio; the overshooting candidate is the one that lost
    assert [p.variant for p in ctx.lyrics.selection.publish] == ["fits-the-audio"]
    tolerance_notes = [n for n in notes if "within tolerance" in n]
    assert tolerance_notes, notes
    note = tolerance_notes[0]
    assert "mildly-long" in note and "+5s" in note, note
    assert "NOT published" in note, note
    assert "fits-the-audio" in note, note


# `select_by_baselines` ranks an unjudgeable version (score None) as the constant -1.0 and never lets
# it be displaced by a judged one. The overshoot penalty subtraction must be CLAMPED, or an overshoot
# fraction above ~1.0 (a candidate timed to more than double the audio, a full-album/wrong-master LRC)
# drives a real score below -1.0 and hands the win to the unjudgeable rival.


def test_overshoot_penalty_never_ranks_a_judged_candidate_below_the_unjudgeable_sentinel():
    """A judged score, however badly it overshoots, must stay above the -1.0 unjudgeable sentinel."""
    # 60 s of audio against a candidate timed to 300 s — +400%, the wrong-master shape.
    huge = _timed(SOURCE_LRCLIB, SHARED, "album-master", per_word_end=300.0)
    penalised = overshoot_penalized(0.40, huge, 60.0)
    assert penalised > -1.0, (
        f"a judged candidate ranked {penalised}, below the -1.0 unjudgeable sentinel — an ungradeable "
        "version would displace a real one, which select_by_baselines documents as impossible"
    )


def test_overshoot_penalty_floors_at_zero_so_a_score_stays_a_score():
    """The penalty keeps the composite in [0, 1]: a demotion cannot make a score negative."""
    huge = _timed(SOURCE_LRCLIB, SHARED, "album-master", per_word_end=300.0)
    assert overshoot_penalized(0.40, huge, 60.0) == 0.0
    # A tolerated overshoot (inside OVERSHOOT_FRACTION_MAX) is still untouched, and a real demotion
    # inside the clamp still lands where the docstring says it does (+39% on 0.45 → ~0.06).
    mild = _timed(SOURCE_LRCLIB, SHARED, "trailing-cue", per_word_end=64.0)  # +6.7%, tolerated
    assert overshoot_penalized(0.45, mild, 60.0) == 0.45
    demoted = _timed(SOURCE_LRCLIB, SHARED, "wrong-version", per_word_end=83.4)  # +39%
    assert 0.0 < overshoot_penalized(0.45, demoted, 60.0) < 0.10


def test_a_wildly_overshooting_judged_pick_still_loses_to_a_fitting_rival():
    """The clamp must not cost the penalty its job: a fitting rival still wins the comparison."""
    fits = _timed(SOURCE_CAPTIONS, SHARED, "fits", per_word_end=58.0)
    overshoots = _timed(SOURCE_LRCLIB, SHARED, "album-master", per_word_end=300.0)
    assert overshoot_penalized(0.90, overshoots, 60.0) < overshoot_penalized(0.50, fits, 60.0)
