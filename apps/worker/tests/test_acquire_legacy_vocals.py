"""AcquireAudio must find a pre-change legacy vocals stem.

#480 switched VOCALS_EXT from `m4a` to `flac` for NEW cooks, but the worker never receives the stored
vocals ref — it re-derives the path from the CURRENT VOCALS_EXT on every align job. Every song cooked in
the interim era has its vocals stem on disk as `<id>-vocals.m4a`, so a lookup that only tries the current
extension loses it and align silently degrades to aligning against the mix.

These drive the AcquireAudio STEP (not the private helper) and assert on ctx.audio.vocals_path, which is
the seam the ASR baseline actually reads.
"""

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.processor import VOCALS_EXT, JobSpec, vocals_path  # noqa: E402
from src.runtime.ctx import Ctx  # noqa: E402
from src.steps.acquire import AcquireAudio  # noqa: E402


def _write(path: str) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"\x00" * 16)
    return path


def _drive_acquire(tmp_path) -> Ctx:
    """Run AcquireAudio as a LOCAL job so no yt-dlp shells out; only the vocals-stem lookup matters here.

    _existing_vocals runs at the top of run() before the local/download branch, so the local declaration
    keeps the test off the network while still exercising the real step.
    """
    ctx = Ctx(
        job=JobSpec(
            job_id="j",
            media_id="m1",
            job_type="align",
            source_uri="lib/m1.flac",
            params={"fetcher": "local"},
            media_dir=str(tmp_path),
        ),
        work=str(tmp_path),
    )

    async def _run():
        async for _ in AcquireAudio().run(ctx):
            pass

    asyncio.run(_run())
    return ctx


def _legacy_m4a_path(tmp_path) -> str:
    # The pre-change name for the same key: <media_dir>/derived/stems/<id>-vocals.m4a
    canonical = vocals_path(str(tmp_path), "m1")
    return canonical[: -(len(VOCALS_EXT) + 1)] + ".m4a"


def test_acquire_finds_legacy_m4a_vocals_stem(tmp_path):
    """A song with ONLY a legacy -vocals.m4a on disk still resolves its stem.

    Red on base: _existing_vocals only builds the current-VOCALS_EXT path (.flac), which does not exist,
    so ctx.audio.vocals_path is None and align degrades to the mix.
    """
    legacy = _write(_legacy_m4a_path(tmp_path))
    ctx = _drive_acquire(tmp_path)
    assert ctx.audio.vocals_path == legacy


def test_acquire_prefers_current_flac_over_legacy_m4a(tmp_path):
    """When BOTH extensions are present, the current VOCALS_EXT (.flac) wins.

    Pins the preference so a fresh re-cook's stem is chosen over a stale legacy sibling, rather than the
    choice being incidental to glob/sort ordering.
    """
    _write(_legacy_m4a_path(tmp_path))
    current = _write(vocals_path(str(tmp_path), "m1"))
    ctx = _drive_acquire(tmp_path)
    assert ctx.audio.vocals_path == current


def test_acquire_returns_none_when_no_stem_on_disk(tmp_path):
    """No stem of any extension -> None (a declining baseline, not a broken worker)."""
    ctx = _drive_acquire(tmp_path)
    assert ctx.audio.vocals_path is None
