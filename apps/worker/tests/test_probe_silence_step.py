"""ProbeSilence driven as a STEP, not just its parser.

test_silence_gate.py covers the pure parts — argv, parse, verdict — and they were always correct. What
was missing is exactly this file: the step itself, deciding WHICH stem to measure and what to do about
the answer. The probe measured only the vocals, so a separation that emitted a floor-level INSTRUMENTAL
published clean: markMediaReady fired, the song entered the rotation, the TV loaded a valid file and
reported advancing telemetry, and the room played four minutes of nothing with no signal on any surface.
The parser tests passed throughout, because the file it was pointed at was never the file that plays.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import AsyncIterator

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.processor import JobSpec  # noqa: E402
from src.runtime import Ctx  # noqa: E402
from src.steps.separate import ProbeSilence  # noqa: E402

HEALTHY = "[Parsed_volumedetect_0 @ 0x1] max_volume: -1.2 dB"
SILENT = "[Parsed_volumedetect_0 @ 0x1] max_volume: -91.0 dB"


def ctx_with(raw: dict[str, str], readings: dict[str, str]) -> Ctx:
    """A Ctx whose runner answers per-path, so one probe can be silent and the other healthy."""

    async def runner(argv) -> AsyncIterator[str]:
        path = next((a for a in argv if a in readings), None)
        yield readings[path] if path else HEALTHY

    job = JobSpec(job_id="j1", media_id="m1", job_type="stems", source_uri="u", params={}, media_dir="/tmp")
    ctx = Ctx(job=job, work="/tmp/work", runner=runner)
    ctx.stems.raw = dict(raw)
    return ctx


async def drive(ctx: Ctx) -> None:
    async for _ in ProbeSilence().run(ctx):
        pass


async def test_a_silent_INSTRUMENTAL_fails_the_job_rather_than_publishing_silence():
    """The one that matters. The instrumental is the file that plays at volume, so there is no honest
    way to serve it — failing puts the song in the operator's ledger and leaves it re-cookable."""
    ctx = ctx_with(
        {"instrumental": "/w/inst.wav", "vocals": "/w/vox.wav"},
        {"/w/inst.wav": SILENT, "/w/vox.wav": HEALTHY},
    )
    with pytest.raises(RuntimeError, match="instrumental stem is digital silence"):
        await drive(ctx)


async def test_a_healthy_instrumental_passes_and_records_the_vocals_verdict():
    ctx = ctx_with(
        {"instrumental": "/w/inst.wav", "vocals": "/w/vox.wav"},
        {"/w/inst.wav": HEALTHY, "/w/vox.wav": SILENT},
    )
    await drive(ctx)
    assert ctx.stems.vocals_silent is True
    assert any("vocals stem is digital silence" in n for n in ctx.out.notes)


async def test_both_healthy_is_a_clean_cook():
    ctx = ctx_with(
        {"instrumental": "/w/inst.wav", "vocals": "/w/vox.wav"},
        {"/w/inst.wav": HEALTHY, "/w/vox.wav": HEALTHY},
    )
    await drive(ctx)
    assert ctx.stems.vocals_silent is False


async def test_the_step_applies_when_only_an_instrumental_was_produced():
    """Gating `applies` on the vocals key skipped the whole step for a vocals-less cook — which meant
    skipping the only check whose failure is fatal."""
    inst_only = ctx_with({"instrumental": "/w/inst.wav"}, {"/w/inst.wav": SILENT})
    assert ProbeSilence().applies(inst_only) is True
    with pytest.raises(RuntimeError, match="instrumental stem is digital silence"):
        await drive(inst_only)


async def test_a_vocals_less_cook_with_a_good_instrumental_still_succeeds():
    ctx = ctx_with({"instrumental": "/w/inst.wav"}, {"/w/inst.wav": HEALTHY})
    await drive(ctx)
    assert ctx.stems.vocals_silent is False


async def test_nothing_separated_means_nothing_to_probe():
    assert ProbeSilence().applies(ctx_with({}, {})) is False


async def test_an_UNMEASURABLE_instrumental_is_not_treated_as_silent():
    """ffmpeg absent or output unparseable means unknown, not silent. Failing every cook because the
    probe could not run would be worse than the bug it guards."""
    ctx = ctx_with({"instrumental": "/w/inst.wav"}, {"/w/inst.wav": "ffmpeg: No such file or directory"})
    await drive(ctx)  # does not raise


async def test_a_failed_vocals_probe_never_costs_the_room_a_working_guide():
    """The vocals probe swallows errors by design; the instrumental probe deliberately does not."""

    async def boom(argv) -> AsyncIterator[str]:
        raise OSError("ffmpeg died")
        yield ""  # pragma: no cover

    job = JobSpec(job_id="j1", media_id="m1", job_type="stems", source_uri="u", params={}, media_dir="/tmp")
    ctx = Ctx(job=job, work="/tmp/work", runner=boom)
    ctx.stems.raw = {"vocals": "/w/vox.wav"}
    await drive(ctx)
    assert ctx.stems.vocals_silent is False
