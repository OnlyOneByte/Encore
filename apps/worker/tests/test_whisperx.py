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
from src.lyrics_source import LrclibResult  # noqa: E402


def test_lyrics_key():
    assert whisperx.lyrics_key("m1") == "lyrics/m1.json"


def test_lrclib_to_segments_prefers_synced_then_plain_then_empty():
    synced = LrclibResult(id=1, instrumental=False, synced_lyrics="[00:01.00]a\n[00:03.00]b", plain_lyrics="a\nb")
    segs = whisperx.lrclib_to_segments(synced, total_duration=5.0)
    assert [s["text"] for s in segs] == ["a", "b"]
    assert segs[0] == {"start": 1.0, "end": 3.0, "text": "a"}  # line end = next line start

    plain = LrclibResult(id=2, instrumental=False, synced_lyrics=None, plain_lyrics="one\ntwo")
    psegs = whisperx.lrclib_to_segments(plain, total_duration=4.0)
    assert [s["text"] for s in psegs] == ["one", "two"]  # evenly distributed

    # instrumental / None / no-lyrics → empty
    assert whisperx.lrclib_to_segments(LrclibResult(3, True, None, None), 5.0) == []
    assert whisperx.lrclib_to_segments(None, 5.0) == []


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


# ── I/O forced-alignment flow: fake LRCLIB client + fake aligner (NO network, NO torch) ─────
from src.lyrics_source import LrclibClient  # noqa: E402


def fake_ytdlp_runner(*, progress=("[download]  50.0% of 1MiB", "[download] 100% of 1MiB")):
    """yt-dlp stand-in: writes the extracted wav so the download stage 'produces' its output."""
    async def run(argv):
        out = argv[argv.index("-o") + 1]
        os.makedirs(os.path.dirname(out), exist_ok=True)
        Path(out).write_bytes(b"FAKE_SOURCE_WAV")
        for line in progress:
            yield line

    return run


def fake_client(*, synced="[00:01.00]Is this the real life\n[00:03.00]Is this just fantasy", instrumental=False, found=True):
    """LrclibClient with an injected fetcher returning canned JSON (or a 404 when found=False)."""
    def fetch(url, headers):
        if not found:
            return 404, ""
        body = {"id": 1, "instrumental": instrumental, "syncedLyrics": None if instrumental else synced, "plainLyrics": None if instrumental else "Is this the real life\nIs this just fantasy"}
        return 200, json.dumps(body)

    return LrclibClient(fetcher=fetch)


class FakeAligner:
    """Force-aligner stand-in: turns known-text segments into per-word timings by evenly spacing
    words across each segment's [start,end] — the shape whisperx.align returns, minus the ML."""

    def __init__(self, fail=False):
        self.fail = fail
        self.calls = []

    def align(self, segments, audio_path, language):
        self.calls.append((len(segments), audio_path, language))
        if self.fail:
            raise RuntimeError("aligner unavailable (simulated)")
        out_segs = []
        for s in segments:
            toks = s["text"].split()
            span = (s["end"] - s["start"]) / max(1, len(toks))
            words = [{"word": t, "start": round(s["start"] + i * span, 3), "end": round(s["start"] + (i + 1) * span, 3)} for i, t in enumerate(toks)]
            out_segs.append({"start": s["start"], "end": s["end"], "text": s["text"], "words": words})
        return {"language": language, "segments": out_segs}


def spec(tmp_path, source_uri="https://yt/x", media_id="m1", **params):
    p = {"artist": "Queen", "track": "Bohemian Rhapsody", "language": "en", "durationSec": 6.0}
    p.update(params)
    return JobSpec(job_id="j1", media_id=media_id, job_type="align", source_uri=source_uri, params=p, media_dir=str(tmp_path))


async def drain(proc, job):
    return [ev async for ev in proc.process(job)]


@pytest.mark.asyncio
async def test_hybrid_flow_download_lrclib_forcealign_writes_word_timed_lyrics(tmp_path):
    aligner = FakeAligner()
    proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=aligner)
    events = await drain(proc, spec(tmp_path))

    stages = [(e.stage, e.pct) for e in events if isinstance(e, ProgressEvent)]
    assert ("downloading", 0) in stages and ("aligning", 100) in stages
    # the aligner was fed the KNOWN LRCLIB text (2 lines), not asked to transcribe
    assert aligner.calls and aligner.calls[0][0] == 2 and aligner.calls[0][2] == "en"

    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    uri = completes[0].media_uri
    assert uri.endswith("lyrics/m1.json")
    doc = json.loads(Path(uri).read_text())
    # WORD-timed on the correct text (the whole hybrid point)
    assert whisperx.is_valid_lyrics(doc)
    assert [l["text"] for l in doc["lines"]] == ["Is this the real life", "Is this just fantasy"]
    # line "Is this the real life" (5 words) spans [1.0,3.0] → span 0.4 → first word [1.0,1.4]
    assert doc["words"][0] == {"word": "Is", "start": 1.0, "end": 1.4}
    assert all({"word", "start", "end"} == set(w) for w in doc["words"])


@pytest.mark.asyncio
async def test_local_source_skips_download(tmp_path):
    local = tmp_path / "lib" / "song.wav"
    local.parent.mkdir(parents=True)
    local.write_bytes(b"x")
    proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=FakeAligner())
    stages = {e.stage for e in await drain(proc, spec(tmp_path, source_uri=str(local))) if isinstance(e, ProgressEvent)}
    assert "downloading" not in stages  # local file → no fetch
    assert "aligning" in stages


@pytest.mark.asyncio
async def test_aligner_failure_falls_back_to_line_sync(tmp_path):
    # the aligner blows up → we DON'T fail; ship LRCLIB's line-level sync (whole-line highlight)
    proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=FakeAligner(fail=True))
    events = await drain(proc, spec(tmp_path))
    doc = json.loads(Path([e for e in events if isinstance(e, CompleteResult)][0].media_uri).read_text())
    # line-synced fallback: lines with bounds + text, but NO word timings
    assert [l["text"] for l in doc["lines"]] == ["Is this the real life", "Is this just fantasy"]
    assert doc["lines"][0]["start"] == 1.0
    assert all(l["words"] == [] for l in doc["lines"])
    assert whisperx.is_valid_lyrics(doc) is False  # no word timings — but still shipped line-sync


@pytest.mark.asyncio
async def test_no_lyrics_found_raises(tmp_path):
    proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), lyrics_client=fake_client(found=False), aligner=FakeAligner())
    with pytest.raises(RuntimeError, match="no lyrics found"):
        await drain(proc, spec(tmp_path))


@pytest.mark.asyncio
async def test_instrumental_track_raises(tmp_path):
    proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), lyrics_client=fake_client(instrumental=True), aligner=FakeAligner())
    with pytest.raises(RuntimeError, match="no lyrics found"):
        await drain(proc, spec(tmp_path))


@pytest.mark.asyncio
async def test_missing_artist_track_params_raises(tmp_path):
    proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=FakeAligner())
    job = JobSpec(job_id="j", media_id="m1", job_type="align", source_uri="/tmp/a.wav", params={}, media_dir=str(tmp_path))
    with pytest.raises(RuntimeError, match="artist"):
        await drain(proc, job)
