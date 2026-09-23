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
from src.separation.tuning import SeparationTuning  # noqa: E402
from src.vocabulary import StemFormat  # noqa: E402
from tests.cli_fakes import fake_cli_runner  # noqa: E402
from tests.conftest import drain  # noqa: E402


def test_acquisition_is_DECLARED_not_inferred_from_the_uri_shape():
    """Acquisition (which fetcher runs) is a DECLARED job field, never guessed from the URI shape —
    a non-http scheme must not be silently treated as local."""
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
    # FLAC is the default stem format, so the argv carries the flag that makes demucs' own
    # `{ext}` template resolve to `flac`, and both stem paths agree with it.
    assert "--flac" in argv
    assert demucs.demucs_no_vocals_path("/w/sep", "htdemucs") == "/w/sep/htdemucs/no_vocals.flac"
    assert demucs.demucs_vocals_path("/w/sep", "htdemucs") == "/w/sep/htdemucs/vocals.flac"


def test_demucs_argv_and_paths_agree_on_the_declared_format():
    """The argv's format flag and the derived paths must never disagree, or `find_outputs` probes a
    path that cannot exist and the job looks like "the separator produced nothing"."""
    for fmt, flag_present, ext in ((StemFormat.FLAC, True, ".flac"), (StemFormat.WAV, False, ".wav")):
        argv = demucs.demucs_argv("/w/in.wav", "/w/sep", model="htdemucs", stem_format=fmt)
        assert ("--flac" in argv) is flag_present, f"{fmt} argv flag wrong"
        assert demucs.demucs_no_vocals_path("/w/sep", "htdemucs", fmt).endswith(f"no_vocals{ext}")
        assert demucs.demucs_vocals_path("/w/sep", "htdemucs", fmt).endswith(f"vocals{ext}")
        assert fmt.ext == ext


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


def fake_runner(
    scripted: dict[str, list[str]],
    *,
    fail_on: str | None = None,
    exit_text: str = "",
    write_vocals: bool = True,
):
    """Build a runner that emits canned lines keyed by the binary name (argv[0]), optionally raising
    a ProcessError for one binary. Also CREATES the files the real CLIs would, so the processor's
    existence checks + move succeed. `write_vocals=False` simulates a run that produced the
    instrumental but not the vocals (best-effort path). Shared acquisition/volumedetect/encode
    branches live in `fake_cli_runner`; only demucs-specific writes are here."""

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
        scripted=scripted, fail_on=fail_on, exit_text=exit_text, handlers={"demucs": demucs_handler}
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
    vocals = completes[0].artifacts["stems"]["vocals"]
    assert vocals.endswith("m1-vocals.flac")  # vocals stem is lossless FLAC
    assert Path(vocals).exists()


@pytest.mark.asyncio
async def test_separating_reaches_100_exactly_once_when_the_parser_already_did(tmp_path):
    """run_stage guards the tail with `if last < 100`, so a separator whose last progress line is
    already `100%` must not also get an unconditional final pct=100 appended (which would double-fire)."""
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
    # A missing vocals stem never fails the load-bearing instrumental: the vocals key is just absent.
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
    # fetcher=local is a DECLARED job field; the path shape (not being an http URL) is not what
    # makes a source local.
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


def test_download_keeps_the_native_stream_and_never_transcodes_to_wav():
    argv = fetch_mod.download_argv("https://youtu.be/x", "/m/audio/id1.%(ext)s")
    # A codec-ranked selector whose final fallback is `best`, not `bestaudio`: a muxed-only video has
    # no audio-only stream, so a `bestaudio` final fallback would fail the process.
    assert "-f" in argv
    selector = argv[argv.index("-f") + 1]
    assert selector.split("/")[-1] == "best", selector
    assert "bestaudio[acodec=opus]" in selector, selector
    assert "bestvideo" not in selector
    assert "--audio-format" not in argv
    assert "wav" not in " ".join(argv)
    # the extension must stay a template -- YouTube decides whether it is m4a or webm
    assert "%(ext)s" in " ".join(argv)


def test_decode_forces_stereo_but_NEVER_resamples():
    # YouTube serves 48 kHz Opus; forcing 44100 here would throw away information for nothing, since
    # FLAC/AAC/Opus all handle 48 kHz natively.
    argv = demucs.decode_argv("/m/audio/id1.webm", "/w/input.wav")
    joined = " ".join(argv)
    assert "-ac 2" in joined
    assert "-ar" not in argv, "must not force a sample rate -- keep the source's"
    assert "44100" not in joined
    assert "pcm_s16le" in joined  # a WORKING format, written into scratch


def test_both_stems_are_encoded_LOSSLESS_flac():
    # Sharing the FLAC codec on both stems removes the AAC-in-m4a priming-sample start offset that
    # would otherwise desync the played-aloud vocals guide track from the instrumental.
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
        # `.info.json` (from --write-info-json) sorts BEFORE `.webm`/`.m4a` alphabetically, so it must
        # be skipped explicitly or it would be returned as the audio path.
        open(_os.path.join(d, "id1.info.json"), "w").close()
        assert fetch_mod.find_downloaded(d, "id1") is None  # the info sidecar alone is not a result
        open(_os.path.join(d, "id1.webm"), "w").close()
        assert fetch_mod.find_downloaded(d, "id1").endswith("id1.webm")


def test_find_downloaded_ignores_interrupted_fragmented_download():
    """A killed fragmented (HLS/DASH/premiere) download leaves `id1.m4a.part`,
    `id1.m4a.part-Frag0`, `id1.m4a.part-Frag1`, `id1.m4a.ytdl` — none of which end with `.part`, so a
    naive `endswith(".part")` check would adopt a fragment as a valid standalone segment and decode it
    as a poisoned few-seconds "original". None of these is a finished download.
    """
    import os as _os
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        for leftover in ("id1.m4a.part", "id1.m4a.part-Frag0", "id1.m4a.part-Frag1", "id1.m4a.ytdl"):
            open(_os.path.join(d, leftover), "w").close()
        assert fetch_mod.find_downloaded(d, "id1") is None
        # the postprocessor temp <id>.temp.<ext> is also in-progress, not a result
        open(_os.path.join(d, "id1.temp.m4a"), "w").close()
        assert fetch_mod.find_downloaded(d, "id1") is None
        # once fragments concatenate into the real output, it is adopted
        open(_os.path.join(d, "id1.m4a"), "w").close()
        assert fetch_mod.find_downloaded(d, "id1").endswith("id1.m4a")


def test_resolve_demucs_model_defaults_when_unset():
    assert demucs.resolve_demucs_model({}) == demucs.DEFAULT_MODEL
    assert demucs.resolve_demucs_model({"model": None}) == demucs.DEFAULT_MODEL
    assert demucs.resolve_demucs_model({"model": ""}) == demucs.DEFAULT_MODEL


def test_resolve_demucs_model_accepts_whitelisted_variants():
    assert demucs.resolve_demucs_model({"model": "htdemucs_ft"}) == "htdemucs_ft"
    assert demucs.resolve_demucs_model({"model": "htdemucs_6s"}) == "htdemucs_6s"


def test_resolve_demucs_model_rejects_unknown_rather_than_silently_falling_back():
    # A silent fallback would ship a DIFFERENT instrumental than the room asked for.
    import pytest as _pytest

    with _pytest.raises(ValueError, match="unknown demucs model"):
        demucs.resolve_demucs_model({"model": "bs-roformer-1297"})
    with _pytest.raises(ValueError, match="unknown demucs model"):
        demucs.resolve_demucs_model({"model": "../etc/passwd"})


@pytest.mark.asyncio
async def test_subprocess_runner_streams_lines_and_reaps_on_normal_exit():
    argv = [sys.executable, "-c", "print('one'); print('two')"]
    lines = [ln async for ln in demucs.subprocess_runner(argv)]
    assert lines == ["one", "two"]


@pytest.mark.asyncio
async def test_subprocess_runner_raises_ProcessError_on_nonzero_exit():
    # emit a line, then exit 3: the tail must be carried into the ProcessError.
    argv = [sys.executable, "-c", "import sys; print('boom-line'); sys.exit(3)"]
    with pytest.raises(demucs.ProcessError) as ei:
        async for _ in demucs.subprocess_runner(argv):
            pass
    assert ei.value.returncode == 3
    assert "boom-line" in ei.value.output_tail


# A parent that forks a long-lived child, prints the CHILD's pid, then sleeps — mirrors demucs -j,
# where the pid launched is not the pid holding the memory. The grandchild survives a bare
# proc.kill() and only dies if the whole process group is signalled+reaped, so its liveness is
# downstream of the actual kill+reap guarantee.
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
    # Cancel mid-stream (as _run_job's unwind does via GeneratorExit) and assert the forked
    # grandchild was actually killed+reaped (test_subprocess_group_kill covers the `break` path).
    started = _asyncio.Event()
    captured: dict[str, int] = {}

    async def consume():
        gen = demucs.subprocess_runner([sys.executable, "-c", _CANCEL_REAP_PARENT])
        async for line in gen:
            captured["pid"] = int(line.strip())
            started.set()
            await _asyncio.sleep(300)  # hold the generator open (as _run_job does) until cancelled

    task = _asyncio.ensure_future(consume())
    await _asyncio.wait_for(started.wait(), timeout=10)
    child_pid = captured["pid"]
    assert child_pid is not None, "the parent never reported its forked child"

    task.cancel()
    with pytest.raises(_asyncio.CancelledError):
        await task

    # Give the group kill a moment to land, then assert the grandchild is gone — proof the kill
    # reached the whole tree, not just the launched CLI.
    for _ in range(60):
        if not _alive(child_pid):
            break
        await _asyncio.sleep(0.05)
    assert not _alive(child_pid), (
        f"grandchild {child_pid} survived cancellation — the cancel-path unwind did not kill+reap "
        "the process tree, so a cancelled process would leak its demucs -j workers"
    )


@pytest.mark.asyncio
async def test_subprocess_runner_times_out_a_silent_child_and_raises_retryable(monkeypatch):
    # Shrink the idle timeout so a silent child trips it fast; the raised error must be the
    # retryable ProcessTimeout so the core's existing retry path handles it.
    monkeypatch.setattr(demucs, "SUBPROCESS_IDLE_TIMEOUT_SEC", 0.3)
    argv = [sys.executable, "-c", "import time; time.sleep(30)"]
    with pytest.raises(demucs.ProcessTimeout) as ei:
        async for _ in demucs.subprocess_runner(argv):
            pass
    assert ei.value.retryable is True


@pytest.mark.asyncio
async def test_subprocess_runner_idle_timer_resets_on_each_line(monkeypatch):
    # A child that keeps printing under the idle window must NOT be killed even though its TOTAL
    # runtime exceeds the idle timeout: this is an idle-output timeout, not a wall-clock cap.
    monkeypatch.setattr(demucs, "SUBPROCESS_IDLE_TIMEOUT_SEC", 0.5)
    argv = [
        sys.executable,
        "-c",
        "import time,sys\nfor i in range(6):\n    print(i, flush=True); time.sleep(0.2)\n",
    ]
    lines = [ln async for ln in demucs.subprocess_runner(argv)]
    assert lines == ["0", "1", "2", "3", "4", "5"]  # ~1.2s total, over the 0.5s idle cap, uninterrupted


def test_classify_retryable_flows_through_the_shared_retry_policy_table():
    """demucs.classify_retryable must CONSUME retry_policy's one canonical PERMANENT_MARKERS table,
    not keep a divergent copy: demucs raises ProcessError for ffmpeg and bs-roformer-infer too, so a
    deterministic separator/encoder failure whose stderr hits a canonical marker must classify
    NON-retryable.
    """
    from src import retry_policy

    assert demucs.classify_retryable("ffmpeg: Codec is unsupported") is False
    assert demucs.classify_retryable("state_dict load failed: corrupt checkpoint") is False

    # The table is genuinely SHARED, not re-declared: no private _PERMANENT_MARKERS tuple to drift.
    assert not hasattr(demucs, "_PERMANENT_MARKERS")
    for marker in retry_policy.PERMANENT_MARKERS:
        assert demucs.classify_retryable(f"some prefix {marker} some suffix") is False

    # A ProcessError raised by a non-download CLI carries the shared non-retryable verdict too.
    err = demucs.ProcessError(["bs-roformer-infer", "run"], 1, "RuntimeError: corrupt state_dict")
    assert err.retryable is False


def test_resolve_demucs_model_unknown_is_structurally_non_retryable():
    """The unknown-model ValueError routes through retry_policy.BoundaryError, so it stays a
    ValueError drop-in but carries the shared structured retryable=False — an unknown model fails
    fast instead of burning three attempts."""
    from src import retry_policy

    with pytest.raises(ValueError, match="unknown demucs model") as excinfo:
        demucs.resolve_demucs_model({"model": "bs-roformer-1297"})
    assert isinstance(excinfo.value, retry_policy.BoundaryError)
    assert excinfo.value.retryable is False
    assert retry_policy.is_retryable(excinfo.value) is False


# The resolved backend must DRIVE the run, not just reach a log line: `facts.backend` has to record
# the backend that actually RAN, never a hardcoded constant that could disagree with the startup log.
def test_demucs_engine_backend_is_the_resolved_value_not_a_hardcoded_constant():
    """The engine reports the backend it was CONSTRUCTED with, so facts.backend follows resolution."""
    from src.separation.engines import DemucsEngine

    assert DemucsEngine().backend == "torch"  # the portable default, unchanged
    # A distinct sentinel proves the value is THREADED from the arg, not read from a constant.
    assert DemucsEngine(backend="a-resolved-backend").backend == "a-resolved-backend"


def test_engine_for_mlx_backend_builds_the_mlx_engine_not_torch():
    """`engine_for('demucs', backend='mlx')` builds the MLX engine (backend 'mlx') — it NEVER returns
    a torch DemucsEngine under an mlx label: an mlx resolution must not silently produce a torch process."""
    from src.separation.engines import DemucsEngine, MlxDemucsEngine, engine_for

    mlx = engine_for("demucs", backend="mlx")
    assert isinstance(mlx, MlxDemucsEngine)
    assert mlx.backend == "mlx"
    assert not isinstance(mlx, DemucsEngine)
    # torch (and the None default) still build the real engine: the portable path is untouched.
    assert engine_for("demucs", backend="torch").backend == "torch"
    assert engine_for("demucs").backend == "torch"


@pytest.mark.asyncio
async def test_a_torch_stems_process_records_torch_because_torch_ran(tmp_path):
    """End-to-end: a stems process resolved to the torch backend records `facts.backend == 'torch'`, and
    the value came from the backend threaded through stems_runner, not a constant."""
    runner = fake_runner({"yt-dlp": ["[download] 100% of 4MiB"], "demucs": ["100%|██| 2/2"]})
    proc = plans.stems_runner(runner=runner, tuning=SeparationTuning(backend="torch"))
    events = await drain(proc, spec(tmp_path))
    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    assert completes[0].facts["backend"] == "torch"
    assert completes[0].facts["engine"] == "demucs"


@pytest.mark.asyncio
async def test_an_mlx_resolved_stems_process_runs_demucs_mlx_and_derives_the_instrumental(tmp_path):
    """End-to-end: stems_runner(backend='mlx') runs the `demucs-mlx` CLI (never the torch `demucs`
    CLI), derives the instrumental with an ffmpeg mix-minus pass over the non-vocal stems, publishes
    it, and records facts.backend == 'mlx' because MLX actually RAN.
    """
    ran: list[str] = []

    async def mlx_handler(argv):
        # demucs-mlx emits four source stems in the nested <out>/<input-stem>/<source>.wav layout.
        out_dir = argv[argv.index("-o") + 1]
        input_wav = argv[-1]
        for source in ("vocals", "drums", "bass", "other"):
            p = mlx_mod.mlx_stem_path(out_dir, input_wav, source)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            Path(p).write_bytes(b"FAKE_STEM")
        yield "100%|██| 2/2"

    inner = fake_cli_runner(
        scripted={"yt-dlp": ["[download] 100% of 4MiB"]}, handlers={"demucs-mlx": mlx_handler}
    )

    async def tracking_runner(argv):
        ran.append(argv[0])
        async for line in inner(argv):
            yield line

    proc = plans.stems_runner(runner=tracking_runner, tuning=SeparationTuning(backend="mlx"))
    events = await drain(proc, spec(tmp_path))

    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    assert completes[0].facts["backend"] == "mlx"
    assert completes[0].facts["engine"] == "demucs"
    # demucs-mlx ran; the torch demucs CLI never did.
    assert "demucs-mlx" in ran
    assert "demucs" not in ran, "the torch demucs CLI must never run for an mlx-resolved process"
    # the mix-minus ffmpeg pass ran (an ffmpeg invocation whose non-vocal inputs feed amix normalize=0)
    ffmpeg_calls = [a for a in ran if a == "ffmpeg"]
    assert ffmpeg_calls, "the mix-minus ffmpeg derivation must run for an mlx process"
