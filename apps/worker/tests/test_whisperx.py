"""WhisperX align pipeline — PURE shape transform (raw WhisperX → normalized word-timed lyrics,
the M7-C8 done-when "lyrics JSON with word timestamps; unit test on shape") + the I/O processor
flow driven by a fake runner (canned transcript, no torch). Real ML alignment defers to a GPU box."""
import asyncio
import json
import os
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import whisperx  # noqa: E402
from src.processor import CompleteResult, JobSpec, ProgressEvent  # noqa: E402


# ── pure helpers ──────────────────────────────────────────────────────────────────
from src.lyrics_source import LrclibResult  # noqa: E402


def test_lyrics_key():
    # B-7: lyrics live under the `derived/` storage class (regenerable from `audio/`).
    assert whisperx.lyrics_key("m1") == "derived/lyrics/m1.json"


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
    assert uri.endswith("lyrics/m1-lrclib.json")  # per-source key, so candidates coexist
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
    with pytest.raises(RuntimeError, match="no lyrics text from any source"):
        await drain(proc, spec(tmp_path))


@pytest.mark.asyncio
async def test_instrumental_track_raises(tmp_path):
    proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), lyrics_client=fake_client(instrumental=True), aligner=FakeAligner())
    with pytest.raises(RuntimeError, match="no lyrics text from any source"):
        await drain(proc, spec(tmp_path))


@pytest.mark.asyncio
async def test_missing_params_declines_the_lookup_instead_of_erroring_on_params(tmp_path):
    """B-3-C3: acquisition and timing are separate concerns now. Without confident metadata the LRCLIB
    source DECLINES (it never asks for a guessed title); the job then fails only because nothing else
    supplied text. It is no longer an assertion about params, which is what let "no LRCLIB" mean "no
    lyrics" — see the next test for the whole point of the split."""
    client = fake_client()
    proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), lyrics_client=client, aligner=FakeAligner())
    job = JobSpec(job_id="j", media_id="m1", job_type="align", source_uri="/tmp/a.wav", params={}, media_dir=str(tmp_path))
    with pytest.raises(RuntimeError, match="no lyrics text from any source"):
        await drain(proc, job)


# ── B-3-C3: acquisition is SEPARATE from timing ────────────────────────────────
# The bug this closes: stage 2 was hardwired to LrclibClient.get() and raised when it returned
# nothing, so an unreachable LRCLIB meant "no lyrics" rather than "no AUTHORITATIVE lyrics".
from src.lyrics_chain import (  # noqa: E402
    SOURCE_ASR,
    SOURCE_LRCLIB,
    TIMING_LINE,
    TIMING_NONE,
    TIMING_WORD,
    LrclibSource,
    LyricsRequest,
    LyricsText,
    acquire,
    candidate_key,
)


class FakeSource:
    """A source that returns canned text (or declines, or explodes)."""

    def __init__(self, name, text=None, boom=False):
        self.name = name
        self._text = text
        self._boom = boom
        self.calls = 0

    def fetch(self, req):
        self.calls += 1
        if self._boom:
            raise RuntimeError("source is broken")
        return self._text


def _text(source, timing, lines=("line one here", "line two here"), conf="high"):
    segs = [{"start": i * 2.0, "end": i * 2.0 + 1.5, "text": t} for i, t in enumerate(lines)]
    if timing == TIMING_WORD:
        for s in segs:
            s["words"] = [{"word": w, "start": s["start"], "end": s["end"]} for w in s["text"].split()]
    return LyricsText(text_source=source, segments=segs, timing=timing, text_confidence=conf)


def test_acquire_runs_every_source_not_just_the_first():
    a = FakeSource("a", _text(SOURCE_LRCLIB, TIMING_LINE))
    b = FakeSource("b", _text(SOURCE_ASR, TIMING_WORD))
    got = acquire([a, b], LyricsRequest(media_id="m1"))
    assert len(got) == 2 and a.calls == 1 and b.calls == 1  # complements, not alternatives


def test_acquire_skips_a_source_that_raises_without_losing_the_others():
    got = acquire([FakeSource("boom", boom=True), FakeSource("ok", _text(SOURCE_ASR, TIMING_WORD))],
                  LyricsRequest(media_id="m1"))
    assert len(got) == 1 and got[0].text_source == SOURCE_ASR


def test_acquire_drops_empty_text():
    empty = LyricsText(text_source=SOURCE_LRCLIB, segments=[{"text": "   "}], timing=TIMING_NONE)
    assert acquire([FakeSource("e", empty)], LyricsRequest(media_id="m1")) == []


def test_lrclib_source_declines_without_confident_metadata_and_never_queries():
    client = fake_client()
    src = LrclibSource(client, whisperx.lrclib_to_segments)
    assert src.fetch(LyricsRequest(media_id="m1", artist=None, track="x")) is None
    assert src.fetch(LyricsRequest(media_id="m1", artist="x", track=None)) is None


def test_lrclib_source_declines_when_the_network_is_dead_rather_than_raising():
    class Dead:
        def get(self, *a, **k):
            raise RuntimeError("DNS sinkhole / CERTIFICATE_VERIFY_FAILED")

    src = LrclibSource(Dead(), whisperx.lrclib_to_segments)
    assert src.fetch(LyricsRequest(media_id="m1", artist="a", track="b")) is None


def test_plain_lyrics_are_NOT_reported_as_line_timed():
    """plainLyrics get evenly-spaced synthetic bounds. That is not sync and must not be presented as
    the line-level floor — otherwise the TV would scroll confidently at the wrong times."""
    src = LrclibSource(fake_client(synced=False), whisperx.lrclib_to_segments)
    got = src.fetch(LyricsRequest(media_id="m1", artist="a", track="b", duration=100.0))
    assert got is not None and got.timing == TIMING_NONE


@pytest.mark.asyncio
async def test_THE_POINT_a_dead_lrclib_still_produces_lyrics_from_another_source(tmp_path):
    """With LRCLIB declining and only an ASR-shaped source available, the job SUCCEEDS with word
    timings. Under the old hardwired stage 2 this raised."""
    dead = FakeSource(SOURCE_LRCLIB, None)
    asr = FakeSource(SOURCE_ASR, _text(SOURCE_ASR, TIMING_WORD, conf="low"))
    proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), aligner=FakeAligner(), sources=[dead, asr])
    events = await drain(proc, spec(tmp_path))
    done = [e for e in events if isinstance(e, CompleteResult)][0]
    cands = done.artifacts["lyrics"]["candidates"]
    assert [c["textSource"] for c in cands] == [SOURCE_ASR]
    assert cands[0]["timing"] == TIMING_WORD
    assert cands[0]["textConfidence"] == "low"  # honest: the TV must label this
    assert Path(done.media_uri).exists()


@pytest.mark.asyncio
async def test_multiple_sources_each_get_their_own_artifact_file(tmp_path):
    lrc = FakeSource(SOURCE_LRCLIB, _text(SOURCE_LRCLIB, TIMING_LINE))
    asr = FakeSource(SOURCE_ASR, _text(SOURCE_ASR, TIMING_WORD, conf="low"))
    proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), aligner=FakeAligner(), sources=[lrc, asr])
    events = await drain(proc, spec(tmp_path))
    cands = [e for e in events if isinstance(e, CompleteResult)][0].artifacts["lyrics"]["candidates"]
    refs = {c["textSource"]: c["ref"] for c in cands}
    assert refs[SOURCE_LRCLIB] == candidate_key("m1", SOURCE_LRCLIB)
    assert refs[SOURCE_ASR] == candidate_key("m1", SOURCE_ASR)
    assert refs[SOURCE_LRCLIB] != refs[SOURCE_ASR]  # no overwrite — the upgrade path depends on this
    for c in cands:
        assert (tmp_path / c["ref"]).exists()


@pytest.mark.asyncio
async def test_uri_points_at_the_authoritative_candidate_not_the_asr_one(tmp_path):
    """Back-compat pointer: authoritative+aligned outranks asr+word (wrong words cannot be sung)."""
    lrc = FakeSource(SOURCE_LRCLIB, _text(SOURCE_LRCLIB, TIMING_LINE))
    asr = FakeSource(SOURCE_ASR, _text(SOURCE_ASR, TIMING_WORD, conf="low"))
    proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), aligner=FakeAligner(), sources=[asr, lrc])
    done = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0]
    assert done.media_uri.endswith(candidate_key("m1", SOURCE_LRCLIB))


@pytest.mark.asyncio
async def test_aligner_failure_degrades_that_candidate_to_LINE_sync(tmp_path):
    class Broken:
        def align(self, *a, **k):
            raise RuntimeError("no wav2vec2 model")

    lrc = FakeSource(SOURCE_LRCLIB, _text(SOURCE_LRCLIB, TIMING_LINE))
    proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), aligner=Broken(), sources=[lrc])
    done = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0]
    cands = done.artifacts["lyrics"]["candidates"]
    assert cands[0]["timing"] == TIMING_LINE  # the floor, not a failure


@pytest.mark.asyncio
async def test_untimed_text_with_a_broken_aligner_is_DROPPED_not_shipped_unsynced(tmp_path):
    """No word timings and no line timings = nothing to sync against. Shipping it would put a static
    wall of text on the TV, which is below the owner's floor."""
    class Broken:
        def align(self, *a, **k):
            raise RuntimeError("no model")

    untimed = LyricsText(text_source=SOURCE_LRCLIB, segments=[{"text": "some words"}], timing=TIMING_NONE)
    proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), aligner=Broken(),
                                      sources=[FakeSource(SOURCE_LRCLIB, untimed)])
    with pytest.raises(RuntimeError, match="nothing could be timed"):
        await drain(proc, spec(tmp_path))


# ── B-3-C4: the ASR tier ───────────────────────────────────────────────────────
from src.lyrics_chain import AsrSource  # noqa: E402


class FakeTranscriber:
    def __init__(self, out=None, boom=False):
        self._out = out
        self._boom = boom
        self.calls: list[tuple[str, str | None]] = []

    def transcribe(self, audio_path, language=None):
        self.calls.append((audio_path, language))
        if self._boom:
            raise RuntimeError("no model / weights unavailable")
        return self._out


# REAL whisper `transcribe()` output shape: segments with start/end/text and NO words. Word timings
# come from the separate align() pass, never from transcription — measured 2026-09-02 on a real stem.
ASR_RAW = {
    "language": "en",
    "segments": [
        {"start": 0.0, "end": 4.0, "text": "oh baby baby how was i supposed to know"},
        {"start": 4.0, "end": 8.0, "text": "that something wasn't right here"},
    ],
}


def test_asr_source_reads_the_VOCALS_stem_and_lets_whisper_detect_language():
    t = FakeTranscriber(ASR_RAW)
    got = AsrSource(t, whisperx.normalize_lyrics).fetch(
        LyricsRequest(media_id="m1", audio_path="/mix.wav", vocals_path="/vocals.m4a")
    )
    assert t.calls == [("/vocals.m4a", None)]  # the STEM, not the mix; language auto-detected
    assert got is not None and got.text_source == "asr"
    # LINE, not word: transcription gives segment bounds only. The timing layer force-aligns this text
    # to get word timings, exactly as it does for an LRCLIB lookup.
    assert got.timing == TIMING_LINE
    assert got.text_confidence == "low"  # never authoritative — the TV must label it
    assert got.language == "en"


def test_asr_source_declines_when_the_vocals_stem_is_not_cooked_yet():
    """It does NOT fall back to the mixed audio: quietly producing worse words would be
    indistinguishable from producing good ones."""
    t = FakeTranscriber(ASR_RAW)
    assert AsrSource(t, whisperx.normalize_lyrics).fetch(
        LyricsRequest(media_id="m1", audio_path="/mix.wav", vocals_path=None)
    ) is None
    assert t.calls == []  # never even attempted


def test_asr_source_declines_when_the_model_is_unavailable():
    got = AsrSource(FakeTranscriber(boom=True), whisperx.normalize_lyrics).fetch(
        LyricsRequest(media_id="m1", vocals_path="/vocals.m4a")
    )
    assert got is None  # a miss, not a job failure


def test_asr_source_declines_on_an_empty_transcript_an_instrumental():
    got = AsrSource(FakeTranscriber({"language": "en", "segments": []}), whisperx.normalize_lyrics).fetch(
        LyricsRequest(media_id="m1", vocals_path="/vocals.m4a")
    )
    assert got is None


@pytest.mark.asyncio
async def test_DONE_WHEN_lrclib_dead_asr_still_yields_word_timed_lyrics(tmp_path):
    """B-3's done-when, at the unit level: with LRCLIB declining, a cooked song still gets WORD-timed
    lyrics on the TV — and they are marked low-confidence so the overlay can be honest."""
    vocals = tmp_path / "derived" / "stems"
    vocals.mkdir(parents=True)
    (vocals / "m1-vocals.m4a").write_bytes(b"fake stem")

    class DeadLrclib:
        def get(self, *a, **k):
            raise RuntimeError("DNS sinkhole")

    proc = whisperx.WhisperXProcessor(
        runner=fake_ytdlp_runner(),
        lyrics_client=DeadLrclib(),
        aligner=FakeAligner(),
        transcriber=FakeTranscriber(ASR_RAW),
    )
    done = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0]
    cands = done.artifacts["lyrics"]["candidates"]
    assert [c["textSource"] for c in cands] == ["asr"]
    # word timings come from force-aligning the ASR TEXT, not from transcription itself
    assert cands[0]["timing"] == TIMING_WORD and cands[0]["textConfidence"] == "low"


@pytest.mark.asyncio
async def test_both_tiers_produce_candidates_when_lrclib_also_answers(tmp_path):
    vocals = tmp_path / "derived" / "stems"
    vocals.mkdir(parents=True)
    (vocals / "m1-vocals.m4a").write_bytes(b"fake stem")
    proc = whisperx.WhisperXProcessor(
        runner=fake_ytdlp_runner(),
        lyrics_client=fake_client(),
        aligner=FakeAligner(),
        transcriber=FakeTranscriber(ASR_RAW),
    )
    done = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0]
    cands = done.artifacts["lyrics"]["candidates"]
    assert {c["textSource"] for c in cands} == {"lrclib", "asr"}
    # the back-compat pointer prefers the AUTHORITATIVE one, not the ASR guess
    assert done.media_uri.endswith("m1-lrclib.json")


def test_asr_KEEPS_word_timings_if_a_transcriber_ever_supplies_them():
    """Defensive: real whisper transcribe() has no words, but a different backend might. Then the
    timing layer should keep them rather than re-aligning."""
    raw = {"language": "en", "segments": [
        {"start": 0.0, "end": 1.0, "text": "hello there",
         "words": [{"word": "hello", "start": 0.0, "end": 0.5}, {"word": "there", "start": 0.5, "end": 1.0}]}]}
    got = AsrSource(FakeTranscriber(raw), whisperx.normalize_lyrics).fetch(
        LyricsRequest(media_id="m1", vocals_path="/v.m4a"))
    assert got is not None and got.timing == TIMING_WORD


@pytest.mark.asyncio
async def test_asr_text_is_FORCE_ALIGNED_to_get_word_timings(tmp_path):
    """The whole reason the aligner is not ASR-specific: it upgrades ANY text — looked-up or
    transcribed — from line to word timings."""
    vocals = tmp_path / "derived" / "stems"
    vocals.mkdir(parents=True)
    (vocals / "m1-vocals.m4a").write_bytes(b"stem")
    aligner = FakeAligner()

    class DeadLrclib:
        def get(self, *a, **k):
            raise RuntimeError("dead")

    proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), lyrics_client=DeadLrclib(),
                                      aligner=aligner, transcriber=FakeTranscriber(ASR_RAW))
    done = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0]
    assert aligner.calls, "the ASR text must be handed to the aligner"
    assert done.artifacts["lyrics"]["candidates"][0]["timing"] == TIMING_WORD


# ── the event loop must stay free during ML (found on a live cook) ─────────────
@pytest.mark.asyncio
async def test_blocking_ML_does_not_freeze_the_event_loop(tmp_path, monkeypatch):
    """Observed live: sync torch calls inline froze the loop, so the worker missed the websocket
    keepalive ping (disconnect) AND could not send job:progress, so the core's 30s progress lease
    expired and the reaper requeued a healthy job (attempts=1). This proves other tasks still run."""
    monkeypatch.setattr(whisperx, "LEASE_KEEPALIVE_SEC", 0.02)
    ticks = 0

    async def heartbeat():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    class SlowAligner:
        def align(self, segments, audio_path, language):
            time.sleep(0.2)  # a stand-in for a 60s wav2vec2 pass
            return {"language": language, "segments": [
                {"start": 0.0, "end": 1.0, "text": "x", "words": [{"word": "x", "start": 0.0, "end": 1.0}]}]}

    beat = asyncio.ensure_future(heartbeat())
    try:
        proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), lyrics_client=fake_client(),
                                         aligner=SlowAligner())
        await drain(proc, spec(tmp_path))
    finally:
        beat.cancel()
    assert ticks > 3, f"event loop was starved during the ML call (only {ticks} ticks)"


@pytest.mark.asyncio
async def test_keepalive_progress_is_emitted_while_ML_runs(tmp_path, monkeypatch):
    """Each keepalive refreshes the core's progress lease, which is what stops the reaper from
    requeueing a job that is running fine."""
    monkeypatch.setattr(whisperx, "LEASE_KEEPALIVE_SEC", 0.02)

    class SlowAligner:
        def align(self, segments, audio_path, language):
            time.sleep(0.25)
            return {"language": language, "segments": [
                {"start": 0.0, "end": 1.0, "text": "x", "words": [{"word": "x", "start": 0.0, "end": 1.0}]}]}

    proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), lyrics_client=fake_client(),
                                      aligner=SlowAligner())
    events = await drain(proc, spec(tmp_path))
    aligning = [e for e in events if isinstance(e, ProgressEvent) and e.stage == "aligning"]
    assert len(aligning) >= 3, f"expected repeated aligning keepalives, got {len(aligning)}"


@pytest.mark.asyncio
async def test_a_raising_aligner_still_propagates_through_the_thread_wrapper(tmp_path):
    """_run_blocking must not swallow failures — the line-sync degrade depends on the raise."""
    class Broken:
        def align(self, *a, **k):
            raise RuntimeError("no model")

    proc = whisperx.WhisperXProcessor(runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=Broken())
    done = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0]
    assert done.artifacts["lyrics"]["candidates"][0]["timing"] == TIMING_LINE
