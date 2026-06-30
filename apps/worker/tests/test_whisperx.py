"""WhisperX align pipeline — PURE shape transform (raw WhisperX → normalized word-timed lyrics,
the M7-C8 done-when "lyrics JSON with word timestamps; unit test on shape") + the I/O processor
flow driven by a fake runner (canned transcript, no torch). Real ML alignment defers to a GPU box."""
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import whisperx  # noqa: E402
from src.processor import CompleteResult, JobSpec, ProgressEvent  # noqa: E402


# ── pure helpers ──────────────────────────────────────────────────────────────────
def test_align_argv_shape():
    argv = whisperx.align_argv("/w/source.wav", "/w/out", model="base", lang="en", whisperx_bin="whisperx")
    assert argv[0] == "whisperx"
    assert argv[1] == "/w/source.wav"
    assert "--model" in argv and "base" in argv
    assert "--output_format" in argv and "json" in argv
    assert "--language" in argv and "en" in argv  # pinned language
    # CPU-safe compute defaults (float16 default would crash on a CPU backend)
    assert "--device" in argv and "cpu" in argv
    assert "--compute_type" in argv and "int8" in argv
    # GPU override path
    gpu = whisperx.align_argv("/w/s.wav", "/w/out", device="cuda", compute_type="float16")
    assert "cuda" in gpu and "float16" in gpu
    # no --language when not provided
    assert "--language" not in whisperx.align_argv("/w/s.wav", "/w/out")


def test_whisperx_json_path_and_lyrics_key():
    assert whisperx.whisperx_json_path("/w/out", "/w/foo/source.wav") == "/w/out/source.json"
    assert whisperx.lyrics_key("m1") == "lyrics/m1.json"


RAW = {
    "language": "en",
    "segments": [
        {
            "start": 0.5, "end": 2.0, "text": "Is this the real life",
            "words": [
                {"word": "Is", "start": 0.5, "end": 0.7, "score": 0.9},
                {"word": "this", "start": 0.7, "end": 0.95, "score": 0.9},
                {"word": "the", "start": 0.95, "end": 1.1, "score": 0.8},
                {"word": "real", "start": 1.1, "end": 1.5, "score": 0.9},
                {"word": "life", "start": 1.5, "end": 2.0, "score": 0.9},
            ],
        },
        {
            "start": 2.2, "end": 4.0, "text": "Is this just fantasy",
            "words": [
                {"word": "Is", "start": 2.2, "end": 2.4},
                {"word": "this", "start": 2.4, "end": 2.6},
                {"word": "just", "start": 2.6, "end": 3.0},
                {"word": "fantasy", "start": 3.0, "end": 4.0},
            ],
        },
    ],
}


def test_normalize_lyrics_shape_has_lines_and_flat_words_with_timestamps():
    doc = whisperx.normalize_lyrics(RAW)
    assert doc["language"] == "en"
    assert len(doc["lines"]) == 2
    first = doc["lines"][0]
    assert first["text"] == "Is this the real life"
    assert first["start"] == 0.5 and first["end"] == 2.0
    # every word carries word/start/end (the bouncing-ball contract)
    for w in first["words"]:
        assert set(w.keys()) == {"word", "start", "end"}
        assert isinstance(w["start"], float) and isinstance(w["end"], float)
        assert w["end"] >= w["start"]
    # flattened words span both lines (5 + 4)
    assert len(doc["words"]) == 9
    assert doc["words"][0] == {"word": "Is", "start": 0.5, "end": 0.7}


def test_normalize_drops_untimed_words_and_derives_line_bounds():
    raw = {
        "segments": [
            {
                # segment-level start/end MISSING → derived from words; one word has null timings
                "text": "hello world",
                "words": [
                    {"word": "hello", "start": 1.0, "end": 1.4},
                    {"word": "world", "start": None, "end": None},  # un-timed → dropped
                    {"word": "  ", "start": 1.5, "end": 1.7},  # blank → dropped
                ],
            }
        ]
    }
    doc = whisperx.normalize_lyrics(raw)
    assert len(doc["lines"]) == 1
    line = doc["lines"][0]
    assert [w["word"] for w in line["words"]] == ["hello"]  # only the timed, non-blank word
    assert line["start"] == 1.0 and line["end"] == 1.4  # derived from the surviving words
    assert doc["language"] is None  # absent → null


def test_normalize_skips_empty_segments_and_handles_garbage():
    raw = {"segments": [{"text": "", "words": []}, "not-a-dict", {"words": [{"word": "x", "start": 0, "end": 0.5}]}]}
    doc = whisperx.normalize_lyrics(raw)
    # empty-text seg with no words → skipped; garbage → skipped; the last derives text from its word
    assert len(doc["lines"]) == 1
    assert doc["lines"][0]["text"] == "x"


def test_normalize_rejects_nan_inf_timestamps():
    raw = {"segments": [{"text": "a b", "words": [
        {"word": "a", "start": float("nan"), "end": 1.0},
        {"word": "b", "start": 1.0, "end": float("inf")},
    ]}]}
    doc = whisperx.normalize_lyrics(raw)
    assert doc["lines"] == []  # both words un-timed (NaN/inf) → no usable line


def test_is_valid_lyrics():
    assert whisperx.is_valid_lyrics(whisperx.normalize_lyrics(RAW)) is True
    assert whisperx.is_valid_lyrics({"lines": []}) is False
    assert whisperx.is_valid_lyrics({"lines": [{"text": "x", "words": []}]}) is False  # no timed words
    assert whisperx.is_valid_lyrics({}) is False


# ── I/O processor flow with a fake runner ───────────────────────────────────────────
def fake_runner(*, transcript=RAW, progress=("Progress: 50.0%", "Progress: 100.0%"), fail=False):
    async def run(argv):
        binary = argv[0]
        if binary == "yt-dlp":
            out = argv[argv.index("-o") + 1]
            os.makedirs(os.path.dirname(out), exist_ok=True)
            Path(out).write_bytes(b"FAKE_SOURCE")
        elif binary == "whisperx":
            out_dir = argv[argv.index("--output_dir") + 1]
            audio = argv[1]
            os.makedirs(out_dir, exist_ok=True)
            if transcript is not None:
                Path(whisperx.whisperx_json_path(out_dir, audio)).write_text(json.dumps(transcript))
        for line in progress:
            yield line
        if fail:
            from src.demucs import ProcessError
            raise ProcessError(argv, 1, "boom")

    return run


def spec(tmp_path, source_uri="https://yt/x", media_id="m1"):
    return JobSpec(job_id="j1", media_id=media_id, job_type="align", source_uri=source_uri, params={}, media_dir=str(tmp_path))


async def drain(proc, job):
    out = []
    async for ev in proc.process(job):
        out.append(ev)
    return out


@pytest.mark.asyncio
async def test_align_flow_downloads_aligns_and_writes_lyrics(tmp_path):
    proc = whisperx.WhisperXProcessor(runner=fake_runner())
    events = await drain(proc, spec(tmp_path))

    stages = [(e.stage, e.pct) for e in events if isinstance(e, ProgressEvent)]
    assert ("downloading", 0) in stages
    assert ("aligning", 50) in stages and ("aligning", 100) in stages

    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    uri = completes[0].media_uri
    assert uri.endswith("lyrics/m1.json")
    assert completes[0].artifacts["lyrics"]["uri"] == uri
    # the written artifact is the normalized, word-timed shape
    doc = json.loads(Path(uri).read_text())
    assert doc["language"] == "en"
    assert len(doc["words"]) == 9
    assert all({"word", "start", "end"} == set(w) for w in doc["words"])


@pytest.mark.asyncio
async def test_local_source_skips_download(tmp_path):
    local = tmp_path / "lib" / "song.wav"
    local.parent.mkdir(parents=True)
    local.write_bytes(b"x")
    proc = whisperx.WhisperXProcessor(runner=fake_runner())
    stages = {e.stage for e in await drain(proc, spec(tmp_path, source_uri=str(local))) if isinstance(e, ProgressEvent)}
    assert "downloading" not in stages
    assert "aligning" in stages


@pytest.mark.asyncio
async def test_missing_transcript_raises(tmp_path):
    proc = whisperx.WhisperXProcessor(runner=fake_runner(transcript=None))
    with pytest.raises(RuntimeError, match="no transcript"):
        await drain(proc, spec(tmp_path))


@pytest.mark.asyncio
async def test_instrumental_track_with_no_words_raises(tmp_path):
    # WhisperX ran but found no timed words (e.g. an instrumental) → not a usable lyrics artifact
    proc = whisperx.WhisperXProcessor(runner=fake_runner(transcript={"segments": []}))
    with pytest.raises(RuntimeError, match="no word-timed lyrics"):
        await drain(proc, spec(tmp_path))
