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
