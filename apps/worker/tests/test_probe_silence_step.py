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
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.processor import JobSpec  # noqa: E402
from src.runtime import Ctx  # noqa: E402
from src.steps.separate import ProbeSilence  # noqa: E402

# Real ffmpeg volumedetect output, trimmed to the summary block (mirrors test_silence_gate.py).
# max_volume: is the 3rd of 4 lines in both blocks, so a step that keeps only
# the first (or last) line of the stream never sees it and reads unmeasurable-not-silent. The
# runner below yields these ONE LINE AT A TIME, which is how subprocess_runner streams on a real
# box; a single-line fake could not exercise the join at separate.py:141.
HEALTHY = [
    "[Parsed_volumedetect_0 @ 0x1] n_samples: 15925248",
    "[Parsed_volumedetect_0 @ 0x1] mean_volume: -21.4 dB",
    "[Parsed_volumedetect_0 @ 0x1] max_volume: -1.2 dB",
    "[Parsed_volumedetect_0 @ 0x1] histogram_1db: 24",
]
SILENT = [
    "[Parsed_volumedetect_0 @ 0x1] n_samples: 15925248",
    "[Parsed_volumedetect_0 @ 0x1] mean_volume: -91.0 dB",
    "[Parsed_volumedetect_0 @ 0x1] max_volume: -91.0 dB",
    "[Parsed_volumedetect_0 @ 0x1] histogram_1db: 0",
]


def ctx_with(raw: dict[str, str], readings: dict[str, str]) -> Ctx:
    """A Ctx whose runner answers per-path, so one probe can be silent and the other healthy."""

    async def runner(argv) -> AsyncIterator[str]:
        path = next((a for a in argv if a in readings), None)
        for line in readings[path] if path else HEALTHY:
            yield line

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
    """ffmpeg RAN but produced no `max_volume:` line (wrong filter, truncated output, an error
    printed on a successful exit). parse_max_volume_db returns None, is_silent(None) is False, so
    this is unknown, not silent — failing every such cook would be worse than the bug it guards.

    This is the ONLY shape that reaches this branch without raising. ffmpeg *absent* is a different
    case: the real runner (subprocess_runner) raises FileNotFoundError before yielding any line, and
    that raising path is pinned by test_a_raising_instrumental_probe_fails_the_job below — it is NOT
    tolerated here, contrary to what this docstring used to claim.
    """
    unparseable = ["[Parsed_volumedetect_0 @ 0x1] n_samples: 0"]  # ffmpeg exit 0, no max_volume: line
    ctx = ctx_with({"instrumental": "/w/inst.wav"}, {"/w/inst.wav": unparseable})
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


async def test_a_raising_instrumental_probe_fails_the_job():
    """The real ffmpeg-absent path. subprocess_runner raises FileNotFoundError before yielding any
    line when ffmpeg is not on PATH; the instrumental branch has NO try/except, so that raise must
    propagate and fail the cook — a box without ffmpeg cannot silently publish unchecked stems.

    This is the mutation guard for the "No try/except" property at separate.py: wrapping the
    instrumental probe the way the vocals probe is wrapped would swallow this raise and turn it back
    into a green cook, re-shipping the silent-instrumental bug the step exists to catch. With this
    test present, that wrapping goes RED.
    """

    async def boom(argv) -> AsyncIterator[str]:
        raise FileNotFoundError(2, "No such file or directory", "ffmpeg")
        yield ""  # pragma: no cover

    job = JobSpec(job_id="j1", media_id="m1", job_type="stems", source_uri="u", params={}, media_dir="/tmp")
    ctx = Ctx(job=job, work="/tmp/work", runner=boom)
    ctx.stems.raw = {"instrumental": "/w/inst.wav"}
    with pytest.raises(FileNotFoundError):
        await drive(ctx)
