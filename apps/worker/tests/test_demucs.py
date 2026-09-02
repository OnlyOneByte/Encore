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
    # both stem paths match the flattened --filename template
    assert demucs.demucs_no_vocals_path("/w/sep", "htdemucs") == "/w/sep/htdemucs/no_vocals.wav"
    assert demucs.demucs_vocals_path("/w/sep", "htdemucs") == "/w/sep/htdemucs/vocals.wav"


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
def fake_runner(scripted: dict[str, list[str]], *, fail_on: str | None = None, exit_text: str = "",
                write_vocals: bool = True):
    """Build a runner that emits canned lines keyed by the binary name (argv[0]), optionally raising
    a ProcessError for one binary. It also CREATES the files the real CLIs would, so the processor's
    existence checks + move succeed. `--two-stems=vocals` writes BOTH stems; `write_vocals=False`
    simulates a run that produced the instrumental but not the vocals (best-effort path)."""

    async def run(argv):
        binary = argv[0]
        if binary == "yt-dlp":
            # mimic yt-dlp writing the NATIVE audio stream. The -o target is a %(ext)s template
            # (B-7: we no longer transcode to wav), so pick a concrete extension the way yt-dlp would.
            out = argv[argv.index("-o") + 1].replace("%(ext)s", "webm")
            os.makedirs(os.path.dirname(out), exist_ok=True)
            Path(out).write_bytes(b"FAKE_NATIVE_AUDIO")
        elif binary == "ffmpeg":
            # mimic ffmpeg writing its output (last argv element) — the decode-to-wav and the
            # stem AAC encodes both go through here.
            out = argv[-1]
            os.makedirs(os.path.dirname(out), exist_ok=True)
            Path(out).write_bytes(b"FAKE_ENCODED")
        elif binary == "demucs":
            out_dir = argv[argv.index("-o") + 1]
            model = argv[argv.index("-n") + 1]
            inst = demucs.demucs_no_vocals_path(out_dir, model)
            os.makedirs(os.path.dirname(inst), exist_ok=True)
            Path(inst).write_bytes(b"FAKE_INSTRUMENTAL")
            if write_vocals:
                Path(demucs.demucs_vocals_path(out_dir, model)).write_bytes(b"FAKE_VOCALS")
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
    assert final.endswith("m1-instrumental.m4a")
    assert Path(final).exists()
    assert completes[0].artifacts["stems"]["instrumental"] == final
    # M8-C0: the isolated vocals stem is ALSO published (was previously discarded)
    vocals = completes[0].artifacts["stems"]["vocals"]
    assert vocals.endswith("m1-vocals.m4a")
    assert Path(vocals).exists()


@pytest.mark.asyncio
async def test_missing_vocals_is_best_effort_still_publishes_instrumental(tmp_path):
    # demucs wrote the instrumental but not vocals.wav → the job still completes with the
    # instrumental; the vocals key is simply absent (never fails the load-bearing output).
    runner = fake_runner({
        "yt-dlp": ["[download] 100% of 4MiB"],
        "demucs": ["100%|██| 2/2"],
    }, write_vocals=False)
    proc = demucs.DemucsProcessor(runner=runner)
    events = await drain(proc, spec(tmp_path))
    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    stems = completes[0].artifacts["stems"]
    assert stems["instrumental"].endswith("m1-instrumental.m4a")
    assert "vocals" not in stems


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


# ── B-7 audio format policy ────────────────────────────────────────────────────────
# Measured on a real 5:20 song: YouTube's best audio is ~5 MB (Opus 135k / AAC 129k), which the old
# `-x --audio-format wav` inflated to 58.7 MB -- 12x the bytes for zero fidelity, since you cannot
# restore what YouTube already discarded. These tests pin the policy so it cannot silently regress.

def test_download_keeps_the_native_stream_and_never_transcodes_to_wav():
    argv = demucs.download_argv("https://youtu.be/x", "/m/audio/id1.%(ext)s")
    assert "-f" in argv and "bestaudio" in argv
    # the regression that cost ~12x: no extract-audio transcode, and no wav anywhere
    assert "--audio-format" not in argv
    assert "wav" not in " ".join(argv)
    # the extension must stay a template -- YouTube decides whether it is m4a or webm
    assert "%(ext)s" in " ".join(argv)


def test_decode_normalizes_to_stereo_44k_wav_for_demucs():
    argv = demucs.decode_argv("/m/audio/id1.webm", "/w/input.wav")
    joined = " ".join(argv)
    assert "-ac 2" in joined and "-ar 44100" in joined
    assert "pcm_s16le" in joined  # a WORKING format, written into scratch


def test_stems_are_encoded_to_stereo_aac_not_moved_as_wav():
    argv = demucs.encode_stem_argv("/w/no_vocals.wav", "/m/derived/stems/id1-instrumental.m4a")
    joined = " ".join(argv)
    assert "-c:a aac" in joined      # AAC, not Opus: the instrumental must play in Safari
    assert "-b:a 192k" in joined     # headroom over a ~130k lossy source
    assert "-ac 2" in joined         # stereo is the ceiling; YouTube serves stereo
    assert "+faststart" in joined    # browser can start playing before the full download


def test_find_downloaded_ignores_partial_downloads():
    import tempfile, os as _os
    with tempfile.TemporaryDirectory() as d:
        assert demucs.find_downloaded(d, "id1") is None
        open(_os.path.join(d, "id1.webm.part"), "w").close()
        assert demucs.find_downloaded(d, "id1") is None  # an interrupted download is not a result
        open(_os.path.join(d, "id1.webm"), "w").close()
        assert demucs.find_downloaded(d, "id1").endswith("id1.webm")
