"""Demucs pipeline — pure helpers (argv/parse/paths/retryability) + the DemucsProcessor flow driven
by a FAKE runner (canned CLI output), so the full path tests with no torch, no yt-dlp, no network.
The real-ML run defers to a GPU box."""

import asyncio as _asyncio
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import plans  # noqa: E402
from src.acquisition import fetch as fetch_mod  # noqa: E402
from src.processor import CompleteResult, JobSpec, ProgressEvent  # noqa: E402
from src.separation import demucs  # noqa: E402
from src.separation import mlx as mlx_mod  # noqa: E402
from tests.cli_fakes import fake_cli_runner  # noqa: E402
from tests.conftest import drain  # noqa: E402


# ── pure helpers ──────────────────────────────────────────────────────────────────
def test_acquisition_is_DECLARED_not_inferred_from_the_uri_shape():
    """The bug this replaces: acquisition was guessed from an http(s) prefix, so any other scheme was
    silently treated as a local path and failed later inside ffmpeg. A declared value fails at the
    boundary instead, and the URI's shape no longer decides anything."""
    from src.acquisition.fetch import job_fetcher
    from src.vocabulary import Fetcher

    def spec(params):
        return JobSpec(
            job_id="j",
            media_id="m",
            job_type="stems",
            source_uri="spotify:track:4cOdK2wGLETKBW3PvgPWqT",
            params=params,
            media_dir="/m",
        )

    # a non-http scheme is NOT local just because it lacks an http prefix
    assert job_fetcher(spec({"fetcher": "ytdlp"})) is Fetcher.YTDLP
    assert job_fetcher(spec({"fetcher": "local"})) is Fetcher.LOCAL
    # absent means the default, so an older core keeps working
    assert job_fetcher(spec({})) is Fetcher.YTDLP
    # and an unknown fetcher is refused before any byte moves
    with pytest.raises(ValueError, match="unknown fetcher"):
        job_fetcher(spec({"fetcher": "librespot-typo"}))


def test_download_argv_shape():
    argv = fetch_mod.download_argv("https://yt/x", "/w/source.wav", ytdlp_bin="yt-dlp")
    assert argv[0] == "yt-dlp"
    assert "--no-playlist" in argv and "--newline" in argv
    assert argv[-1] == "https://yt/x"  # url is the final positional
    assert "/w/source.wav" in argv


def test_demucs_argv_and_output_path():
    argv = demucs.demucs_argv("/w/in.wav", "/w/sep", model="htdemucs", demucs_bin="demucs")
    assert argv[:3] == ["demucs", "-n", "htdemucs"]
    assert "--two-stems" in argv and "vocals" in argv
    assert "/w/in.wav" == argv[-1]
    # both stem paths match the flattened --filename template
    assert demucs.demucs_no_vocals_path("/w/sep", "htdemucs") == "/w/sep/htdemucs/no_vocals.wav"
    assert demucs.demucs_vocals_path("/w/sep", "htdemucs") == "/w/sep/htdemucs/vocals.wav"


def test_parse_ytdlp_progress():
    assert fetch_mod.parse_ytdlp_progress("[download]  45.2% of 4.30MiB at 1.2MiB/s") == 45
    assert fetch_mod.parse_ytdlp_progress("[download] 100% of 4.30MiB") == 100
    assert fetch_mod.parse_ytdlp_progress("[info] some other line") is None


def test_parse_demucs_progress():
    assert demucs.parse_demucs_progress("  56%|████▏     | 123/220 [00:10<00:08]") == 56
    assert demucs.parse_demucs_progress("Selected model is a bag of 4 models.") is None


def test_classify_retryable():
    assert demucs.classify_retryable("HTTP Error 503: temporary") is True
    assert demucs.classify_retryable("ERROR: Video unavailable") is False
    assert demucs.classify_retryable("ERROR: Private video") is False
    assert demucs.classify_retryable("This video is members-only") is False
    assert demucs.classify_retryable("some transient torch CUDA hiccup") is True


def test_process_error_carries_retryable():
    err = demucs.ProcessError(["yt-dlp", "x"], 1, "ERROR: Video unavailable")
    assert err.retryable is False
    assert err.returncode == 1
    transient = demucs.ProcessError(["demucs"], 1, "RuntimeError: CUDA out of memory")
    assert transient.retryable is True


# ── DemucsProcessor flow with a fake runner ─────────────────────────────────────────
def fake_runner(
    scripted: dict[str, list[str]],
    *,
    fail_on: str | None = None,
    exit_text: str = "",
    write_vocals: bool = True,
):
    """Build a runner that emits canned lines keyed by the binary name (argv[0]), optionally raising
    a ProcessError for one binary. It also CREATES the files the real CLIs would, so the processor's
    existence checks + move succeed. `--two-stems=vocals` writes BOTH stems; `write_vocals=False`
    simulates a run that produced the instrumental but not the vocals (best-effort path).

    The acquisition / volumedetect / encode branches (and the volumedetect branch that makes the silence
    probe real) live in the shared `fake_cli_runner`; only the demucs-specific writes are
    here."""

    async def demucs_handler(argv):
        out_dir = argv[argv.index("-o") + 1]
        model = argv[argv.index("-n") + 1]
        inst = demucs.demucs_no_vocals_path(out_dir, model)
        os.makedirs(os.path.dirname(inst), exist_ok=True)
        Path(inst).write_bytes(b"FAKE_INSTRUMENTAL")
        if write_vocals:
            Path(demucs.demucs_vocals_path(out_dir, model)).write_bytes(b"FAKE_VOCALS")
        return
        yield  # pragma: no cover — makes this an async generator; the return above wins

    return fake_cli_runner(
        scripted=scripted,
        fail_on=fail_on,
        exit_text=exit_text,
        handlers={"demucs": demucs_handler},
    )


def spec(tmp_path, source_uri="https://www.youtube.com/watch?v=abc", media_id="m1", **params):
    return JobSpec(
        job_id="j1",
        media_id=media_id,
        job_type="stems",
        source_uri=source_uri,
        params=params,
        media_dir=str(tmp_path),
    )


@pytest.mark.asyncio
async def test_youtube_job_downloads_then_separates_then_publishes(tmp_path):
    runner = fake_runner(
        {
            "yt-dlp": ["[download]  10.0% of 4MiB", "[download] 100% of 4MiB"],
            "demucs": ["Selected model is a bag of 4 models.", " 50%|███   | 1/2", "100%|██████| 2/2"],
        }
    )
    proc = plans.stems_runner(runner=runner)
    events = await drain(proc, spec(tmp_path))

    stages = [(e.stage, e.pct) for e in events if isinstance(e, ProgressEvent)]
    assert ("downloading", 0) in stages and ("downloading", 10) in stages and ("downloading", 100) in stages
    assert ("separating", 50) in stages and ("separating", 100) in stages
    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    final = completes[0].media_uri
    assert final.endswith("m1-instrumental.flac")
    assert Path(final).exists()
    assert completes[0].artifacts["stems"]["instrumental"] == final
    # the isolated vocals stem is ALSO published (was previously discarded)
    vocals = completes[0].artifacts["stems"]["vocals"]
    assert vocals.endswith("m1-vocals.flac")  # vocals stem is lossless FLAC
    assert Path(vocals).exists()


@pytest.mark.asyncio
async def test_separating_reaches_100_exactly_once_when_the_parser_already_did(tmp_path):
    """The Separate step used to emit an UNCONDITIONAL final pct=100 on top of whatever the parser
    yielded, so a separator whose last progress line was `100%` produced TWO ('separating', 100) events.
    Routing the step through the runner's run_stage — the single loop, which guards the tail with
    `if last < 100` — collapses that to one. Non-vacuous: on the old inline loop this asserts 2.
    """
    runner = fake_runner(
        {
            "yt-dlp": ["[download] 100% of 4MiB"],
            "demucs": [" 50%|███   | 1/2", "100%|██████| 2/2"],  # parser reaches 100 on the last line
        }
    )
    proc = plans.stems_runner(runner=runner)
    events = await drain(proc, spec(tmp_path))
    separating_hundreds = [
        e for e in events if isinstance(e, ProgressEvent) and e.stage == "separating" and e.pct == 100
    ]
    assert len(separating_hundreds) == 1


@pytest.mark.asyncio
async def test_missing_vocals_is_best_effort_still_publishes_instrumental(tmp_path):
    # demucs wrote the instrumental but not vocals.wav → the job still completes with the
    # instrumental; the vocals key is simply absent (never fails the load-bearing output).
    runner = fake_runner(
        {
            "yt-dlp": ["[download] 100% of 4MiB"],
            "demucs": ["100%|██| 2/2"],
        },
        write_vocals=False,
    )
    proc = plans.stems_runner(runner=runner)
    events = await drain(proc, spec(tmp_path))
    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    stems = completes[0].artifacts["stems"]
    assert stems["instrumental"].endswith("m1-instrumental.flac")
    assert "vocals" not in stems


@pytest.mark.asyncio
async def test_local_source_skips_download_stage(tmp_path):
    # A pre-existing local file: no yt-dlp stage should run. The job DECLARES fetcher=local — the path
    # no longer being an http URL is not what makes it local, which is the whole point of the change.
    local = tmp_path / "library" / "song.wav"
    local.parent.mkdir(parents=True)
    local.write_bytes(b"LOCAL")
    runner = fake_runner({"demucs": ["100%|██| 2/2"]})
    proc = plans.stems_runner(runner=runner)
    events = await drain(proc, spec(tmp_path, source_uri=str(local), fetcher="local"))
    stages = {e.stage for e in events if isinstance(e, ProgressEvent)}
    assert "downloading" not in stages  # local source → no download
    assert "separating" in stages
    assert any(isinstance(e, CompleteResult) for e in events)


@pytest.mark.asyncio
async def test_download_failure_propagates_as_retryable_process_error(tmp_path):
    runner = fake_runner(
        {"yt-dlp": ["[download]   5.0% of 4MiB"]}, fail_on="yt-dlp", exit_text="HTTP Error 503"
    )
    proc = plans.stems_runner(runner=runner)
    with pytest.raises(demucs.ProcessError) as ei:
        await drain(proc, spec(tmp_path))
    assert ei.value.retryable is True


@pytest.mark.asyncio
async def test_unavailable_video_is_non_retryable(tmp_path):
    runner = fake_runner({"yt-dlp": []}, fail_on="yt-dlp", exit_text="ERROR: Video unavailable")
    proc = plans.stems_runner(runner=runner)
    with pytest.raises(demucs.ProcessError) as ei:
        await drain(proc, spec(tmp_path))
    assert ei.value.retryable is False


@pytest.mark.asyncio
async def test_missing_instrumental_output_raises(tmp_path):
    # demucs "succeeds" (no error) but writes nothing → the processor must catch the missing file
    async def empty_runner(argv):
        if argv[0] == "yt-dlp":
            out = argv[argv.index("-o") + 1]
            os.makedirs(os.path.dirname(out), exist_ok=True)
            Path(out).write_bytes(b"x")
        return
        yield  # make it an async generator

    proc = plans.stems_runner(runner=empty_runner)
    with pytest.raises(RuntimeError, match="no instrumental"):
        await drain(proc, spec(tmp_path))


# ── audio format policy ────────────────────────────────────────────────────────
# Measured on a real 5:20 song: YouTube's best audio is ~5 MB (Opus 135k / AAC 129k), which the old
# `-x --audio-format wav` inflated to 58.7 MB -- 12x the bytes for zero fidelity, since you cannot
# restore what YouTube already discarded. These tests pin the policy so it cannot silently regress.


def test_download_keeps_the_native_stream_and_never_transcodes_to_wav():
    argv = fetch_mod.download_argv("https://youtu.be/x", "/m/audio/id1.%(ext)s")
    # Assert the POLICY (a codec-ranked selector whose final fallback can always download something)
    # rather than one literal token. The last branch is `best`, not `bestaudio`: a `bestaudio` branch
    # needs an audio-only stream to exist, and a muxed-only video would otherwise fail the cook.
    assert "-f" in argv
    selector = argv[argv.index("-f") + 1]
    assert selector.split("/")[-1] == "best", selector
    assert "bestaudio[acodec=opus]" in selector, selector
    assert "bestvideo" not in selector
    # the regression that cost ~12x: no extract-audio transcode, and no wav anywhere
    assert "--audio-format" not in argv
    assert "wav" not in " ".join(argv)
    # the extension must stay a template -- YouTube decides whether it is m4a or webm
    assert "%(ext)s" in " ".join(argv)


def test_decode_forces_stereo_but_NEVER_resamples():
    # The resample was a real quality bug: YouTube serves 48 kHz Opus, so forcing 44100 here threw away
    # information for nothing -- FLAC, AAC and Opus all handle 48 kHz natively.
    argv = demucs.decode_argv("/m/audio/id1.webm", "/w/input.wav")
    joined = " ".join(argv)
    assert "-ac 2" in joined
    assert "-ar" not in argv, "must not force a sample rate -- keep the source's"
    assert "44100" not in joined
    assert "pcm_s16le" in joined  # a WORKING format, written into scratch


def test_both_stems_are_encoded_LOSSLESS_flac():
    # both stems go through encode_flac_argv. The instrumental plays at volume (a second lossy
    # generation is audible on crash cymbals); the vocals stem is the guiding track (a played second
    # <audio>) and sharing the FLAC codec removes the AAC-in-m4a priming-sample start offset.
    for out in ("/m/derived/stems/id1-instrumental.flac", "/m/derived/stems/id1-vocals.flac"):
        argv = " ".join(demucs.encode_flac_argv("/w/stem.wav", out))
        assert "-c:a flac" in argv
        assert "-sample_fmt s16" in argv  # transparent for a lossy-sourced signal
        assert "-ac 2" in argv  # stereo is the ceiling; YouTube serves stereo
        assert "-b:a" not in argv  # lossless has no bitrate


def test_find_downloaded_ignores_partial_downloads():
    import os as _os
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        assert fetch_mod.find_downloaded(d, "id1") is None
        open(_os.path.join(d, "id1.webm.part"), "w").close()
        assert fetch_mod.find_downloaded(d, "id1") is None  # an interrupted download is not a result
        # --write-info-json drops `<id>.info.json` beside the audio. `.info.json` sorts BEFORE
        # `.webm`/`.m4a` in the `sorted(os.listdir(...))` scan, so without the skip it would be
        # returned as ctx.audio.path on every fresh download (and the retained-original early-return
        # would then point at the JSON). It is metadata, never the audio.
        open(_os.path.join(d, "id1.info.json"), "w").close()
        assert fetch_mod.find_downloaded(d, "id1") is None  # the info sidecar alone is not a result
        open(_os.path.join(d, "id1.webm"), "w").close()
        # `.info.json` sorts first, but the real audio must still be the one returned.
        assert fetch_mod.find_downloaded(d, "id1").endswith("id1.webm")


def test_find_downloaded_ignores_interrupted_fragmented_download():
    """A killed fragmented (HLS/DASH/premiere) download leaves `<id>.<ext>.part-Frag<N>` fragment
    payloads plus the `.part` stream file and the `.ytdl` fragment index. yt-dlp writes fragments as
    `%(tmpfilename)s-Frag%(index)d` where tmpfilename is the `.part` name, so the leftovers are
    `id1.m4a.part`, `id1.m4a.part-Frag0`, `id1.m4a.part-Frag1`, `id1.m4a.ytdl` -- NONE of which END
    with `.part`, which is why the old `endswith` predicate adopted `id1.m4a.part-Frag0` (a valid
    standalone segment, so it decoded silently as a few-seconds original that poisoned the media id
    forever). None of these is a finished download.
    """
    import os as _os
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        for leftover in ("id1.m4a.part", "id1.m4a.part-Frag0", "id1.m4a.part-Frag1", "id1.m4a.ytdl"):
            open(_os.path.join(d, leftover), "w").close()
        assert fetch_mod.find_downloaded(d, "id1") is None
        # the postprocessor temp `<id>.temp.<ext>` is also in-progress, not a result
        open(_os.path.join(d, "id1.temp.m4a"), "w").close()
        assert fetch_mod.find_downloaded(d, "id1") is None
        # once fragments concatenate into the real output, it is adopted
        open(_os.path.join(d, "id1.m4a"), "w").close()
        assert fetch_mod.find_downloaded(d, "id1").endswith("id1.m4a")


# ── per-job demucs model selection ──────────────────────────────────────────
def test_resolve_demucs_model_defaults_when_unset():
    assert demucs.resolve_demucs_model({}) == demucs.DEFAULT_MODEL
    assert demucs.resolve_demucs_model({"model": None}) == demucs.DEFAULT_MODEL
    assert demucs.resolve_demucs_model({"model": ""}) == demucs.DEFAULT_MODEL


def test_resolve_demucs_model_accepts_whitelisted_variants():
    assert demucs.resolve_demucs_model({"model": "htdemucs_ft"}) == "htdemucs_ft"
    assert demucs.resolve_demucs_model({"model": "htdemucs_6s"}) == "htdemucs_6s"


def test_resolve_demucs_model_rejects_unknown_rather_than_silently_falling_back():
    # A silent fallback would ship a DIFFERENT instrumental than the room asked for — worse than a
    # loud failure the ledger can surface. Every roformer/ensemble model id is unknown to demucs.
    import pytest as _pytest

    with _pytest.raises(ValueError, match="unknown demucs model"):
        demucs.resolve_demucs_model({"model": "bs-roformer-1297"})
    with _pytest.raises(ValueError, match="unknown demucs model"):
        demucs.resolve_demucs_model({"model": "../etc/passwd"})


# ── the REAL subprocess_runner (FIX 2 kill+reap, FIX 3 idle timeout) ────────────────
# The rest of the suite injects fake runners, so subprocess_runner itself — the code that was
# broken — had ZERO coverage. These drive a REAL trivial child (python, always on PATH here).


@pytest.mark.asyncio
async def test_subprocess_runner_streams_lines_and_reaps_on_normal_exit():
    argv = [sys.executable, "-c", "print('one'); print('two')"]
    lines = [ln async for ln in demucs.subprocess_runner(argv)]
    assert lines == ["one", "two"]


@pytest.mark.asyncio
async def test_subprocess_runner_raises_ProcessError_on_nonzero_exit():
    # emit a line, then exit 3 — the tail must be carried into the ProcessError.
    argv = [sys.executable, "-c", "import sys; print('boom-line'); sys.exit(3)"]
    with pytest.raises(demucs.ProcessError) as ei:
        async for _ in demucs.subprocess_runner(argv):
            pass
    assert ei.value.returncode == 3
    assert "boom-line" in ei.value.output_tail


# A parent that forks a long-lived child, prints the CHILD's pid, then sleeps — mirrors demucs -j,
# where the pid we launch is not the pid holding the memory. The grandchild survives a bare
# proc.kill() and only dies if the whole process group is signalled + reaped, so asserting on its
# liveness is downstream of the actual kill+reap guarantee (a plain sleep in the direct child would
# die on any kill and could not tell the invariant apart from its absence).
_CANCEL_REAP_PARENT = (
    "import os,sys,time\n"
    "pid=os.fork()\n"
    "if pid==0:\n"
    "    time.sleep(300)\n"
    "    os._exit(0)\n"
    "print(pid, flush=True)\n"
    "time.sleep(300)\n"
)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@pytest.mark.asyncio
@pytest.mark.skipif(not hasattr(os, "fork"), reason="needs POSIX fork/process groups")
async def test_subprocess_runner_kills_and_reaps_the_child_when_the_generator_is_cancelled():
    # Consume the runner inside a task, cancel the task mid-stream (as _run_job's unwind does via
    # GeneratorExit), and assert the forked grandchild was actually killed+reaped — the FIX 2
    # guarantee. This exercises the task-CANCELLATION unwind path; test_subprocess_group_kill covers
    # the mid-stream `break` path. Without subprocess_runner's finally: _terminate the grandchild
    # outlives the cancelled task, and the assert below goes red.
    started = _asyncio.Event()
    captured: dict[str, int] = {}

    async def consume():
        gen = demucs.subprocess_runner([sys.executable, "-c", _CANCEL_REAP_PARENT])
        async for line in gen:
            captured["pid"] = int(line.strip())
            started.set()
            # hold the generator open (as _run_job does mid-stream) until cancelled
            await _asyncio.sleep(300)

    task = _asyncio.ensure_future(consume())
    await _asyncio.wait_for(started.wait(), timeout=10)
    child_pid = captured["pid"]
    assert child_pid is not None, "the parent never reported its forked child"

    task.cancel()
    with pytest.raises(_asyncio.CancelledError):
        await task

    # Give the group kill a moment to land, then assert the grandchild is gone — the observable proof
    # the kill reached the whole tree, not just the CLI we launched.
    for _ in range(60):
        if not _alive(child_pid):
            break
        await _asyncio.sleep(0.05)
    assert not _alive(child_pid), (
        f"grandchild {child_pid} survived cancellation — the cancel-path unwind did not kill+reap "
        "the process tree, so a cancelled cook would leak its demucs -j workers"
    )


@pytest.mark.asyncio
async def test_subprocess_runner_times_out_a_silent_child_and_raises_retryable(monkeypatch):
    # Shrink the idle timeout so a child that prints nothing and sleeps trips it fast. The raised
    # error must be the retryable ProcessTimeout so the core's existing retry path handles it.
    monkeypatch.setattr(demucs, "SUBPROCESS_IDLE_TIMEOUT_SEC", 0.3)
    argv = [sys.executable, "-c", "import time; time.sleep(30)"]
    with pytest.raises(demucs.ProcessTimeout) as ei:
        async for _ in demucs.subprocess_runner(argv):
            pass
    assert ei.value.retryable is True


@pytest.mark.asyncio
async def test_subprocess_runner_idle_timer_resets_on_each_line(monkeypatch):
    # A child that keeps printing under the idle window must NOT be killed, even though its TOTAL
    # runtime exceeds the idle timeout — proving this is an idle-output timeout, not a wall-clock cap.
    monkeypatch.setattr(demucs, "SUBPROCESS_IDLE_TIMEOUT_SEC", 0.5)
    argv = [
        sys.executable,
        "-c",
        "import time,sys\nfor i in range(6):\n    print(i, flush=True); time.sleep(0.2)\n",
    ]
    lines = [ln async for ln in demucs.subprocess_runner(argv)]
    assert lines == ["0", "1", "2", "3", "4", "5"]  # ran ~1.2s total, over the 0.5s idle cap, uninterrupted


def test_classify_retryable_flows_through_the_shared_retry_policy_table():
    """demucs.classify_retryable must CONSUME retry_policy's one canonical
    PERMANENT_MARKERS table, not keep a divergent copy. demucs raises ProcessError for ffmpeg and
    bs-roformer-infer too, so a deterministic separator/encoder failure whose stderr hits a canonical
    marker must classify NON-retryable — reds on base, whose download-only list omitted these markers.
    """
    from src import retry_policy

    # The two markers the old divergent demucs list lacked but the canonical union carries.
    # On base these classified retryable (retried to maxAttempts); now they are permanent.
    assert demucs.classify_retryable("ffmpeg: Codec is unsupported") is False
    assert demucs.classify_retryable("state_dict load failed: corrupt checkpoint") is False

    # The table is genuinely SHARED, not re-declared: demucs must agree with retry_policy on every
    # canonical marker, and there is no private _PERMANENT_MARKERS tuple left to drift.
    assert not hasattr(demucs, "_PERMANENT_MARKERS")
    for marker in retry_policy.PERMANENT_MARKERS:
        assert demucs.classify_retryable(f"some prefix {marker} some suffix") is False

    # A ProcessError raised by a non-download CLI now carries the shared non-retryable verdict.
    err = demucs.ProcessError(["bs-roformer-infer", "run"], 1, "RuntimeError: corrupt state_dict")
    assert err.retryable is False


def test_resolve_demucs_model_unknown_is_structurally_non_retryable():
    """The unknown-model ValueError now routes through retry_policy.BoundaryError (the shared
    boundary type), so it stays a ValueError drop-in but carries the shared structured retryable = False —
    an unknown model fails fast instead of burning three attempts. Reds on base (plain ValueError,
    no .retryable, so is_retryable would default it retryable off the heuristic)."""
    from src import retry_policy

    with pytest.raises(ValueError, match="unknown demucs model") as excinfo:
        demucs.resolve_demucs_model({"model": "bs-roformer-1297"})
    assert isinstance(excinfo.value, retry_policy.BoundaryError)
    assert excinfo.value.retryable is False
    assert retry_policy.is_retryable(excinfo.value) is False


# ── the resolved backend must DRIVE the run, not just reach a log line ───────
# Before this fix, backends.resolve_backend picked a backend (mlx on an Apple-Silicon box) that
# reached nothing but a startup print: stems_runner had no backend parameter, engine_for always built
# the torch DemucsEngine, and facts.backend was the hardcoded class attribute "torch". So a Mac
# announced "separator backend: mlx" at startup and then recorded "torch" for every cook — the log
# lied. These pin the two halves of the wire: torch is recorded because it RAN, and an mlx resolution
# builds the (unimplemented) MLX engine that refuses loudly rather than a torch cook wearing an mlx label.
def test_demucs_engine_backend_is_the_resolved_value_not_a_hardcoded_constant():
    """The engine reports the backend it was CONSTRUCTED with, so facts.backend follows the resolution.

    Red on base: `DemucsEngine.backend` was a class attribute `= "torch"` and `__init__` took no
    `backend`, so this constructor call raised TypeError and the attribute could never be anything but
    "torch" regardless of what backends.resolve_backend chose.
    """
    from src.separation.engines import DemucsEngine

    assert DemucsEngine().backend == "torch"  # the portable default, unchanged
    # A distinct sentinel proves the value is THREADED from the arg, not read from a constant.
    assert DemucsEngine(backend="a-resolved-backend").backend == "a-resolved-backend"


def test_engine_for_mlx_backend_builds_the_mlx_engine_not_torch():
    """`engine_for('demucs', backend='mlx')` builds the MLX engine (backend 'mlx') — it NEVER returns a
    torch DemucsEngine under an mlx label.

    This is the machine-checkable form of the log-lies-to-you bug: an mlx resolution must not
    silently produce a torch cook. The MLX engine is now implemented, so it builds and runs rather than
    refusing — but it is still a distinct engine reporting backend 'mlx', never the torch DemucsEngine.
    """
    from src.separation.engines import DemucsEngine, MlxDemucsEngine, engine_for

    mlx = engine_for("demucs", backend="mlx")
    assert isinstance(mlx, MlxDemucsEngine)
    assert mlx.backend == "mlx"
    assert not isinstance(mlx, DemucsEngine)
    # torch (and the None default) still build the real engine, so the portable path is untouched.
    assert engine_for("demucs", backend="torch").backend == "torch"
    assert engine_for("demucs").backend == "torch"


@pytest.mark.asyncio
async def test_a_torch_stems_cook_records_torch_because_torch_ran(tmp_path):
    """End-to-end: a stems cook resolved to the torch backend records `facts.backend == 'torch'`, and
    the value came from the backend threaded through stems_runner, not a constant."""
    runner = fake_runner({"yt-dlp": ["[download] 100% of 4MiB"], "demucs": ["100%|██| 2/2"]})
    proc = plans.stems_runner(runner=runner, backend="torch")
    events = await drain(proc, spec(tmp_path))
    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    assert completes[0].facts["backend"] == "torch"
    assert completes[0].facts["engine"] == "demucs"


@pytest.mark.asyncio
async def test_an_mlx_resolved_stems_cook_runs_demucs_mlx_and_derives_the_instrumental(tmp_path):
    """The wire, end-to-end: stems_runner(backend='mlx') runs the `demucs-mlx` CLI (never the
    torch `demucs` CLI), derives the instrumental with an ffmpeg mix-minus pass over the non-vocal
    stems, publishes it, and records facts.backend == 'mlx' because MLX actually RAN.

    Before the MLX runtime existed this cook failed loudly at construction ('demucs-mlx engine is not implemented'); the
    MLX runtime is now implemented, so it completes. The torch demucs CLI must still never run for an
    mlx cook — that is the honesty contract above preserved.
    """
    ran: list[str] = []

    async def mlx_handler(argv):
        # demucs-mlx: emit four source stems in the nested <out>/<input-stem>/<source>.wav layout.
        out_dir = argv[argv.index("-o") + 1]
        input_wav = argv[-1]
        for source in ("vocals", "drums", "bass", "other"):
            p = mlx_mod.mlx_stem_path(out_dir, input_wav, source)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            Path(p).write_bytes(b"FAKE_STEM")
        yield "100%|██| 2/2"

    inner = fake_cli_runner(
        scripted={"yt-dlp": ["[download] 100% of 4MiB"]},
        handlers={"demucs-mlx": mlx_handler},
    )

    async def tracking_runner(argv):
        ran.append(argv[0])
        async for line in inner(argv):
            yield line

    proc = plans.stems_runner(runner=tracking_runner, backend="mlx")
    events = await drain(proc, spec(tmp_path))

    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    assert completes[0].facts["backend"] == "mlx"
    assert completes[0].facts["engine"] == "demucs"
    # demucs-mlx ran; the torch demucs CLI never did.
    assert "demucs-mlx" in ran
    assert "demucs" not in ran, "the torch demucs CLI must never run for an mlx-resolved cook"
    # the mix-minus ffmpeg pass ran (an ffmpeg invocation whose non-vocal inputs feed amix normalize=0)
    ffmpeg_calls = [a for a in ran if a == "ffmpeg"]
    assert ffmpeg_calls, "the mix-minus ffmpeg derivation must run for an mlx cook"
