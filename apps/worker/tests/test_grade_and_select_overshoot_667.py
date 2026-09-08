"""#667 pin (c): GradeAndSelect threads `audio.duration_sec` into selection.

`select_by_baselines` cannot see the song length on its own — its only caller is this step, which used
to declare `reads = {"lyrics.texts"}`. Overshoot needs the duration, so the step must (1) DECLARE the
new read (runtime/plan.py fails a plan for a step reading a key nothing produced, and it must not read a
key it did not declare either) and (2) actually PASS it through, so an over-covered candidate is demoted
and the overshoot is reported in the cook log.

MECHANISM: on base the step neither declares nor reads the duration, so this whole file fails — the
import of the note wording is moot because the over-covered candidate wins and no overshoot note exists.
On head the duration reaches selection, the fitting rival wins, and the note names the demotion.
"""

from __future__ import annotations

from src.lyrics.chain import (
    ROLE_BASELINE,
    ROLE_CANDIDATE,
    SOURCE_ASR,
    SOURCE_CAPTIONS,
    SOURCE_LRCLIB,
    TIMING_LINE,
    LyricsText,
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
    """A rival exists: duration must reach selection so the fitting candidate wins over the higher-
    agreement over-covered one. On base the step never passes a duration, so the over-covered candidate
    wins and this reds on the variant assertion."""
    over = _timed(SOURCE_LRCLIB, f"{SHARED} {GUEST}", "wrong-longer-master", per_word_end=180.0)
    fits = _timed(SOURCE_CAPTIONS, SHARED, "fits-the-audio", per_word_end=90.0)
    baseline = _timed(SOURCE_ASR, SHARED, "whisper/vocals", per_word_end=90.0, role=ROLE_BASELINE)

    ctx, _ = _run_step([over, fits, baseline], 100.0, tmp_path)

    assert ctx.lyrics.selection.publish[0].variant == "fits-the-audio"


def test_step_reports_overshoot_in_the_cook_log_when_the_published_pick_overshoots(tmp_path):
    """No rival: the over-covered candidate is the only claim, so it still publishes (B fixes some cases,
    not all — owner's stated cost) — but the overshoot MUST be surfaced in the cook log. This is piece 2
    (report it), and it proves the duration reached the step: on base there is no overshoot note at all."""
    over = _timed(SOURCE_LRCLIB, f"{SHARED} {GUEST}", "wrong-longer-master", per_word_end=180.0)
    baseline = _timed(SOURCE_ASR, SHARED, "whisper/vocals", per_word_end=90.0, role=ROLE_BASELINE)

    ctx, notes = _run_step([over, baseline], 100.0, tmp_path)

    assert ctx.lyrics.selection.publish[0].variant == "wrong-longer-master"
    assert any("overshoot" in n.lower() and "+80s" in n for n in notes), notes


# --- #731: the overshoot NOTE was silent when the demotion actually fired, and claimed "demoted"
# for a pick it published. The report iterated sel.publish (survivors); a candidate demoted for
# overshoot is not a survivor, so no note fired for it, and the winner's note hardcoded "demoted".


def test_a_demoted_overshooting_candidate_still_gets_an_overshoot_note_naming_the_demotion(tmp_path):
    """F1: across-source, the wrong-longer-master demotes to a fitting rival, so it is NOT published.
    On base the note loop only visited sel.publish, so the demoted loser produced ZERO overshoot notes
    — the exact case #667 piece 2 exists for. Head must emit a note that names the overshooting LOSER
    and says it was demoted."""
    over = _timed(SOURCE_LRCLIB, f"{SHARED} {GUEST}", "wrong-longer-master", per_word_end=180.0)
    fits = _timed(SOURCE_CAPTIONS, SHARED, "fits-the-audio", per_word_end=90.0)
    baseline = _timed(SOURCE_ASR, SHARED, "whisper/vocals", per_word_end=90.0, role=ROLE_BASELINE)

    ctx, notes = _run_step([over, fits, baseline], 100.0, tmp_path)

    # the demotion worked: the fitting rival is what publishes
    assert ctx.lyrics.selection.publish[0].variant == "fits-the-audio"
    overshoot_notes = [n for n in notes if "overshoot" in n.lower()]
    assert overshoot_notes, notes  # RED ON BASE: base emits zero overshoot notes here
    demoted = [n for n in overshoot_notes if "wrong-longer-master" in n and "+80s" in n]
    assert demoted, overshoot_notes
    assert "DEMOTED" in demoted[0], demoted[0]
    assert "fits-the-audio" in demoted[0], demoted[0]


def test_an_overshooting_published_pick_is_not_reported_as_demoted(tmp_path):
    """F2: no rival, so the over-covered candidate is the only claim and still publishes (#667's stated
    cost). On base its note said "demoted in selection" for a pick that WON and is shown on the TV —
    false safety in the operator log. Head must NOT claim the published pick was demoted, and must say
    it published anyway."""
    over = _timed(SOURCE_LRCLIB, f"{SHARED} {GUEST}", "wrong-longer-master", per_word_end=180.0)
    baseline = _timed(SOURCE_ASR, SHARED, "whisper/vocals", per_word_end=90.0, role=ROLE_BASELINE)

    ctx, notes = _run_step([over, baseline], 100.0, tmp_path)

    assert ctx.lyrics.selection.publish[0].variant == "wrong-longer-master"
    overshoot_notes = [n for n in notes if "overshoot" in n.lower() and "+80s" in n]
    assert overshoot_notes, notes
    note = overshoot_notes[0]
    assert "demoted" not in note.lower(), note  # RED ON BASE: base note says "demoted in selection"
    assert "PUBLISHED anyway" in note, note
