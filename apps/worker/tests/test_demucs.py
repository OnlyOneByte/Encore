"""Demucs pipeline — pure helpers (argv/parse/paths/retryability) + the DemucsProcessor flow driven
by a FAKE runner (canned CLI output), so the full download→separate→publish path tests with no
torch, no yt-dlp, no network. The real-ML run ("real song → real instrumental") defers to a GPU box."""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import demucs  # noqa: E402
from src.processor import CompleteResult, JobSpec, ProgressEvent  # noqa: E402


# ── pure helpers ──────────────────────────────────────────────────────────────────
def test_is_local_source():
    assert demucs.is_local_source("library/song.mp4") is True
    assert demucs.is_local_source("/abs/path.wav") is True
    assert demucs.is_local_source("https://www.youtube.com/watch?v=abc") is False
    assert demucs.is_local_source("http://x/y") is False


def test_download_argv_shape():
    argv = demucs.download_argv("https://yt/x", "/w/source.wav", ytdlp_bin="yt-dlp")
    assert argv[0] == "yt-dlp"
    assert "--no-playlist" in argv and "--newline" in argv
    assert argv[-1] == "https://yt/x"  # url is the final positional
    assert "/w/source.wav" in argv


def test_demucs_argv_and_output_path():
    argv = demucs.demucs_argv("/w/in.wav", "/w/sep", model="htdemucs", demucs_bin="demucs")
    assert argv[:3] == ["demucs", "-n", "htdemucs"]
    assert "--two-stems" in argv and "vocals" in argv
    assert "/w/in.wav" == argv[-1]
    # the instrumental path matches the flattened --filename template
    assert demucs.demucs_no_vocals_path("/w/sep", "htdemucs") == "/w/sep/htdemucs/no_vocals.wav"


def test_parse_ytdlp_progress():
    assert demucs.parse_ytdlp_progress("[download]  45.2% of 4.30MiB at 1.2MiB/s") == 45
    assert demucs.parse_ytdlp_progress("[download] 100% of 4.30MiB") == 100
    assert demucs.parse_ytdlp_progress("[info] some other line") is None


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
def fake_runner(scripted: dict[str, list[str]], *, fail_on: str | None = None, exit_text: str = ""):
    """Build a runner that emits canned lines keyed by the binary name (argv[0]), optionally raising
    a ProcessError for one binary. It also CREATES the files the real CLIs would, so the processor's
    existence checks + move succeed."""

    async def run(argv):
        binary = argv[0]
        if binary == "yt-dlp":
            # mimic yt-dlp writing the extracted wav (-o target is the arg after "-o")
            out = argv[argv.index("-o") + 1]
            os.makedirs(os.path.dirname(out), exist_ok=True)
            Path(out).write_bytes(b"FAKE_SOURCE_WAV")
        elif binary == "demucs":
            out_dir = argv[argv.index("-o") + 1]
            model = argv[argv.index("-n") + 1]
            inst = demucs.demucs_no_vocals_path(out_dir, model)
            os.makedirs(os.path.dirname(inst), exist_ok=True)
            Path(inst).write_bytes(b"FAKE_INSTRUMENTAL")
        for line in scripted.get(binary, []):
            yield line
        if fail_on == binary:
            raise demucs.ProcessError(argv, 1, exit_text)

    return run


def spec(tmp_path, source_uri="https://www.youtube.com/watch?v=abc", media_id="m1"):
    return JobSpec(job_id="j1", media_id=media_id, job_type="stems", source_uri=source_uri, params={}, media_dir=str(tmp_path))


async def drain(processor, job):
    events = []
    async for ev in processor.process(job):
        events.append(ev)
    return events


@pytest.mark.asyncio
async def test_youtube_job_downloads_then_separates_then_publishes(tmp_path):
    runner = fake_runner({
        "yt-dlp": ["[download]  10.0% of 4MiB", "[download] 100% of 4MiB"],
        "demucs": ["Selected model is a bag of 4 models.", " 50%|███   | 1/2", "100%|██████| 2/2"],
    })
    proc = demucs.DemucsProcessor(runner=runner)
    events = await drain(proc, spec(tmp_path))

    stages = [(e.stage, e.pct) for e in events if isinstance(e, ProgressEvent)]
    # both stages appear, ramped, and end at 100
    assert ("downloading", 0) in stages and ("downloading", 10) in stages and ("downloading", 100) in stages
    assert ("separating", 50) in stages and ("separating", 100) in stages
    # exactly one CompleteResult, pointing at the published instrumental which now exists
    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    final = completes[0].media_uri
    assert final.endswith("m1-instrumental.wav")
    assert Path(final).exists()
    assert completes[0].artifacts["stems"]["instrumental"] == final


@pytest.mark.asyncio
async def test_local_source_skips_download_stage(tmp_path):
    # a pre-existing local file: no yt-dlp stage should run
    local = tmp_path / "library" / "song.wav"
    local.parent.mkdir(parents=True)
    local.write_bytes(b"LOCAL")
    runner = fake_runner({"demucs": ["100%|██| 2/2"]})
    proc = demucs.DemucsProcessor(runner=runner)
    events = await drain(proc, spec(tmp_path, source_uri=str(local)))
    stages = {e.stage for e in events if isinstance(e, ProgressEvent)}
    assert "downloading" not in stages  # local source → no download
    assert "separating" in stages
    assert any(isinstance(e, CompleteResult) for e in events)


@pytest.mark.asyncio
async def test_download_failure_propagates_as_retryable_process_error(tmp_path):
    runner = fake_runner({"yt-dlp": ["[download]   5.0% of 4MiB"]}, fail_on="yt-dlp", exit_text="HTTP Error 503")
    proc = demucs.DemucsProcessor(runner=runner)
    with pytest.raises(demucs.ProcessError) as ei:
        await drain(proc, spec(tmp_path))
    assert ei.value.retryable is True


@pytest.mark.asyncio
async def test_unavailable_video_is_non_retryable(tmp_path):
    runner = fake_runner({"yt-dlp": []}, fail_on="yt-dlp", exit_text="ERROR: Video unavailable")
    proc = demucs.DemucsProcessor(runner=runner)
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

    proc = demucs.DemucsProcessor(runner=empty_runner)
    with pytest.raises(RuntimeError, match="no instrumental"):
        await drain(proc, spec(tmp_path))
