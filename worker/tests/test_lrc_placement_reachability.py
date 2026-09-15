"""Is the LRC-placement path reachable on a HEALTHY run?

`TimeTexts` can place a synced LRC onto this recording before aligning it: `estimate_lrc_shift` compares
the LRC's own line starts against a baseline line series measured by Whisper on THIS audio, and
`shift_segments` moves the LRC onto it. That mechanism, plus the ~90 lines of rationale behind it in
`lyrics/validate.py`, exists for the case where a provider's record belongs to a master that starts
earlier or later than the upload.

The baseline series it needs is gathered in `TimeTexts` as:

    for b in baselines_of(ctx.lyrics.texts): baseline_lines.extend(b.segments)

and its comment reads "Empty when no baseline spoke, which makes every shift a no-op" — i.e. the author
expected it to be empty only when ASR produced nothing. But `GradeAndSelect` assigns
`ctx.lyrics.texts = sel.publish` one step earlier, and `select_by_baselines` sets `sel.publish = [best]`,
appending a baseline ONLY when the winner is suspect (`winner_suspect`) or when nothing could be claimed
at all (`baseline_fallback`). So on an ordinary run — a confident winner, which is the common case —
`ctx.lyrics.texts` holds exactly one CANDIDATE, `baselines_of` returns nothing, and the placement is
inert.

These tests characterise that. They are written to describe REALITY first (so they pass before any fix and
document the reachability), and the reachability assertion is the one that changes meaning once the
baselines are carried forward for their own sake.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.lyrics.grading import (  # noqa: E402
    ROLE_BASELINE,
    ROLE_CANDIDATE,
    SOURCE_ASR,
    SOURCE_LRCLIB,
    TIMING_LINE,
    LyricsText,
    baselines_of,
    select_by_baselines,
)

# Enough shared words that the LRCLIB candidate grades as a confident winner rather than a suspect one.
_WORDS = (
    "hello hello baby you called i cant hear a thing i have got no service in the club you say say say "
    "again can you hear me i am kind of busy"
)


def _text(source: str, body: str, *, role: str, timing: str = TIMING_LINE, start: float = 0.0) -> LyricsText:
    """A line-timed text whose segments begin at `start`, so a placement shift would be measurable."""
    words = body.split(" ")
    segs = [{"start": start + i * 2.0, "end": start + i * 2.0 + 1.8, "text": w} for i, w in enumerate(words)]
    t = LyricsText(
        text_source=source,
        segments=segs,
        timing=timing,
        text_confidence="high",
        role=role,
    )
    if role == ROLE_BASELINE:
        t.baseline_rank = 0
        t.text_confidence = "low"
    return t


def _healthy_pool() -> list[LyricsText]:
    """A confident LRCLIB candidate plus the ASR baseline that graded it — the ordinary align job."""
    return [
        _text(SOURCE_LRCLIB, _WORDS, role=ROLE_CANDIDATE, start=2.5),
        _text(SOURCE_ASR, _WORDS, role=ROLE_BASELINE, start=0.0),
    ]


def test_a_healthy_selection_publishes_the_winner_alone():
    """Precondition: on a confident win, `publish` carries the candidate and NOT the baseline."""
    sel = select_by_baselines(_healthy_pool(), 300.0)
    assert sel.publish, "nothing was published at all"
    assert not sel.winner_suspect, "this fixture was meant to be a CONFIDENT win"
    assert not sel.baseline_fallback
    assert len(sel.publish) == 1
    assert sel.publish[0].text_source == SOURCE_LRCLIB


def test_the_baseline_series_timetexts_needs_is_empty_after_a_healthy_selection():
    """THE REACHABILITY FINDING.

    `GradeAndSelect` assigns `ctx.lyrics.texts = sel.publish`, and `TimeTexts` then derives its baseline
    line series with `baselines_of(ctx.lyrics.texts)`. After a healthy selection that list holds one
    candidate, so the series is empty and `_shift_for` abstains for every text — the LRC placement cannot
    run, regardless of how badly the LRC needs placing.
    """
    sel = select_by_baselines(_healthy_pool(), 300.0)
    published = sel.publish  # exactly what lands in ctx.lyrics.texts
    assert baselines_of(published) == [], (
        "a baseline survived selection — if this now passes baselines through, the placement path is "
        "reachable and this characterisation is stale"
    )

    baseline_lines: list[dict] = []
    for b in baselines_of(published):
        baseline_lines.extend(b.segments)
    assert baseline_lines == [], "TimeTexts would have a baseline series to place against"


def test_the_baseline_series_is_only_populated_on_the_suspect_path():
    """The placement DOES work — but only on the two paths that happen to keep a baseline around.

    This is what makes the gap a reachability defect rather than a broken algorithm: the mechanism is
    fine, it is simply never handed its input on the healthy path.
    """
    # A candidate that shares almost nothing with what was heard: the winner is suspect, so
    # select_by_baselines publishes the heard baseline ALONGSIDE it. It has to be LONG enough for coverage
    # to be computable at all (MIN_TOKENS_TO_COMPARE) — a short mismatch scores coverage None, which is
    # "unjudgeable" rather than "suspect", and takes neither branch.
    other_song = (
        "completely different words about another song entirely nothing here matches what the singer "
        "actually sang on this recording because it belongs to a different track with its own verses "
        "and its own chorus and none of those words appear anywhere in the audible baseline at all"
    )
    pool = [
        _text(SOURCE_LRCLIB, other_song, role=ROLE_CANDIDATE),
        _text(SOURCE_ASR, _WORDS, role=ROLE_BASELINE),
    ]
    sel = select_by_baselines(pool, 300.0)
    assert sel.winner_suspect or sel.baseline_fallback, "fixture did not reach the suspect/fallback path"
    assert baselines_of(sel.publish), "the suspect path is supposed to publish the baseline too"


# ── THE FIX: baselines are carried forward for their own sake ──────────────────────────────────
#
# `LyricsCtx.baselines` is written by GradeAndSelect from the PRE-selection pool and read by TimeTexts, so
# the placement input no longer depends on a baseline happening to survive into `publish`. These are the
# tests that go red if that slot stops being populated.


def _ctx_with(texts):
    from src.processor import JobSpec
    from src.runtime.ctx import AudioCtx, Ctx, LyricsCtx

    return Ctx(
        job=JobSpec(
            job_id="j",
            media_id="m",
            job_type="align",
            source_uri="/x.wav",
            params={},
            media_dir="/tmp",
        ),
        work="/tmp",
        audio=AudioCtx(path="/x.wav", vocals_path=None, duration_sec=300.0),
        lyrics=LyricsCtx(texts=texts),
    )


def _run_grade_and_select(ctx):
    import asyncio

    from src.steps.lyrics import GradeAndSelect

    async def _drain():
        async for _ in GradeAndSelect().run(ctx):
            pass

    asyncio.run(_drain())


def test_grade_and_select_preserves_the_baselines_past_the_narrowing():
    """A healthy job still narrows `texts` to the winner, but the baselines survive alongside it."""
    ctx = _ctx_with(_healthy_pool())
    _run_grade_and_select(ctx)

    # `texts` is still narrowed — publish semantics are unchanged, which is the point.
    assert len(ctx.lyrics.texts) == 1
    assert ctx.lyrics.texts[0].text_source == SOURCE_LRCLIB
    # …and the evidence that graded it is now reachable, which it was not before.
    assert ctx.lyrics.baselines, (
        "lyrics.baselines is empty after a healthy selection — TimeTexts has no line series again and the "
        "LRC placement is back to being unreachable"
    )
    assert [b.text_source for b in ctx.lyrics.baselines] == [SOURCE_ASR]


def test_timetexts_would_now_have_a_baseline_line_series_on_a_healthy_job():
    """The consequence that matters: the series TimeTexts places against is non-empty on an ordinary job."""
    ctx = _ctx_with(_healthy_pool())
    _run_grade_and_select(ctx)

    baseline_lines: list[dict] = []
    for b in ctx.lyrics.baselines or baselines_of(ctx.lyrics.texts):
        baseline_lines.extend(b.segments)
    assert baseline_lines, "no baseline line series, so `_shift_for` would abstain for every text"


def test_the_steps_declare_the_new_key_so_plan_validation_stays_honest():
    """`runtime/plan.py` fails a plan whose step reads a key nothing produces, so both ends must declare."""
    from src.steps.lyrics import GradeAndSelect, TimeTexts

    assert "lyrics.baselines" in GradeAndSelect.writes
    assert "lyrics.baselines" in TimeTexts.reads
