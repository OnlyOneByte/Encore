"""Issue #316 — ENCORE_YTDLP_BIN must reach the STEMS plan too, not only align and fetch.

#313 threaded the configured yt-dlp binary into `align_plan` and `fetch_plan`, and `dial_home` passed
`cfg.ytdlp_bin` to `align_runner`/`fetch_runner`. `stems_runner` was not part of that fix: `stems_plan`
built `AcquireAudio()` with the hardcoded default and neither `stems_plan` nor `stems_runner` had a
`ytdlp_bin` parameter at all, so `dial_home._build_processor` could not pass one. The step honours a bin
it is actually given (its `__init__` already stored one) — the plan was the only thing withholding it, so
a stems job that needed to acquire would silently regress to a bare "yt-dlp" from PATH.

Three tests:
  * the real `stems_runner` path — the download argv reaches the configured binary;
  * the composition-root wiring seam — `_build_processor` threads `cfg.ytdlp_bin` into the stems runner
    (driving the runner factory directly does NOT pin the cfg-reading call site, per #192);
  * the CLASS guard — for EVERY registered plan, every step carrying a `*_bin` attribute holds the
    configured value rather than the module default, so the next binary threaded into two-of-three plans
    is caught here rather than shipped.

`/opt/encore/bin/yt-dlp` and the other sentinels below are literal values the code never constructs, so a
test cannot pass by re-deriving the code's own defaults.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import plans  # noqa: E402
from src.processor import JobSpec  # noqa: E402
from src.steps.acquire import AcquireAudio  # noqa: E402


@pytest.mark.asyncio
async def test_configured_ytdlp_binary_reaches_the_stems_download_argv(tmp_path):
    """Drive the REAL `plans.stems_runner(ytdlp_bin=...)` and pull its stems plan's AcquireAudio step,
    then run that step through a recording runner and assert the configured binary lands at argv[0].

    Only the acquire step is driven (the later stems steps need real ffmpeg/demucs); that is the exact
    step the issue measured shelling out to a bare "yt-dlp". Before the fix `stems_plan` had no
    `ytdlp_bin` to pass, so `AcquireAudio()` carried the "yt-dlp" default and argv[0] was that literal.
    """
    from src.runtime import Ctx

    configured = "/opt/encore/bin/yt-dlp"
    runner = plans.stems_runner(runner=lambda argv: None, ytdlp_bin=configured)

    job = JobSpec(
        job_id="j1",
        media_id="m1",
        job_type="stems",
        source_uri="https://www.youtube.com/watch?v=abc",
        params={},
        media_dir=str(tmp_path),
    )
    engines = runner._resolve_engines(job.params)
    plan = runner._plan_for(job, engines)
    acquire_steps = [s for s in plan.steps() if isinstance(s, AcquireAudio)]
    assert acquire_steps, "the stems plan must acquire audio"

    seen: list[list[str]] = []

    async def spy(argv):
        seen.append(argv)
        # Land the file so the step completes rather than raising after a no-op download.
        out = Path(str(tmp_path)) / "audio" / "m1.m4a"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"OPUS")
        yield "[download] 100% of 1MiB"

    ctx = Ctx(job=job, work=str(tmp_path / "stems"), runner=spy)
    async for _ in acquire_steps[0].run(ctx):
        pass

    assert seen, "the stems acquire step must have invoked yt-dlp"
    assert seen[0][0] == configured, (
        f"ENCORE_YTDLP_BIN must reach the stems download argv[0], got {seen[0][0]!r}"
    )


@pytest.mark.asyncio
async def test_build_processor_threads_ENCORE_YTDLP_BIN_into_the_stems_plan(tmp_path):
    """The wiring seam. `_build_processor` builds the stems runner from a WorkerConfig; the configured
    `cfg.ytdlp_bin` must reach the AcquireAudio step the stems plan runs, not stop at the capability
    probe. Before the fix `_build_processor` passed no yt-dlp argument to `stems_runner` (it had no such
    parameter), so a stems acquire ran a bare "yt-dlp" from PATH regardless of what the operator
    configured. Driving `stems_runner` directly does NOT cover this cfg-reading call site (#192).
    """
    from src.config import WorkerConfig
    from src.dial_home import _build_processor

    configured = "/opt/encore/bin/yt-dlp"
    cfg = WorkerConfig(capabilities=("stems",), ytdlp_bin=configured)
    stems = _build_processor(cfg)._by_type["stems"]

    job = JobSpec(
        job_id="j1",
        media_id="m1",
        job_type="stems",
        source_uri="https://www.youtube.com/watch?v=abc",
        params={},
        media_dir=str(tmp_path),
    )
    engines = stems._resolve_engines(job.params)
    plan = stems._plan_for(job, engines)
    acquire_steps = [s for s in plan.steps() if isinstance(s, AcquireAudio)]
    assert acquire_steps, "the stems plan must acquire audio"
    assert acquire_steps[0].ytdlp_bin == configured, (
        f"_build_processor must thread cfg.ytdlp_bin into the stems plan's AcquireAudio, "
        f"got {acquire_steps[0].ytdlp_bin!r}"
    )


def test_every_plan_step_holds_the_configured_bin_not_the_default():
    """CLASS guard (issue #316's own fix direction). Build each registered plan with a DISTINCTIVE
    configured value for every `*_bin` it accepts, then assert no step in any plan still carries the
    module default. This catches the next binary threaded into two plans out of three — including the N1
    row (align's own AcquireAudio) that was silent before this issue — in one assertion.

    The sentinels are literal paths the code never constructs, so no step can satisfy this by deriving a
    default. Defaults it must never leave standing: "yt-dlp", "ffmpeg", "demucs".
    """
    sentinels = {
        "ytdlp_bin": "/opt/encore/bin/yt-dlp",
        "ffmpeg_bin": "/opt/encore/bin/ffmpeg",
        "demucs_bin": "/opt/encore/bin/demucs",
    }
    module_defaults = {"yt-dlp", "ffmpeg", "demucs"}

    # Each builder takes only the *_bin kwargs it actually declares.
    built = {
        "align": plans.align_plan(ytdlp_bin=sentinels["ytdlp_bin"]),
        "fetch": plans.fetch_plan(ytdlp_bin=sentinels["ytdlp_bin"]),
        "stems": plans.stems_plan(ytdlp_bin=sentinels["ytdlp_bin"], ffmpeg_bin=sentinels["ffmpeg_bin"]),
        "stems-upgrade": plans.stems_upgrade_plan(
            ytdlp_bin=sentinels["ytdlp_bin"], ffmpeg_bin=sentinels["ffmpeg_bin"]
        ),
    }

    offenders: list[str] = []
    bin_attrs_seen = 0
    for plan_name, plan in built.items():
        for step in plan.steps():
            for attr, sentinel in sentinels.items():
                if hasattr(step, attr):
                    bin_attrs_seen += 1
                    value = getattr(step, attr)
                    if value in module_defaults:
                        offenders.append(
                            f"{plan_name}/{type(step).__name__}.{attr} = {value!r} "
                            f"(module default, not the configured {sentinel!r})"
                        )

    # Not-vacuous: the plans genuinely carry *_bin-bearing steps. The stems plan alone has AcquireAudio
    # (ytdlp_bin) plus several ffmpeg_bin steps, so a broken walk cannot pass by finding nothing.
    assert bin_attrs_seen >= 4, f"expected several *_bin-bearing steps across plans, saw {bin_attrs_seen}"
    assert offenders == [], (
        "a plan withholds a configured binary from one of its steps, so it silently runs the PATH "
        "default — the exact #313/#316 shape:\n  " + "\n  ".join(offenders)
    )
