"""The ALIGN plan, end to end.

Was test_whisperx.py, when align was one 257-line method on a WhisperXProcessor. The subject is now eight
declared steps over a typed context (docs/archive/specs/SPEC-worker-pipeline.md S2), so the file is named for the
plan rather than for a module that no longer exists.

Every seam stays injectable for the reason it always was: the real WhisperX, the real LRCLIB and the real
yt-dlp only run on a worker box, so the whole flow has to be exercisable without any of them.
"""
import asyncio
import json
import os
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import plans  # noqa: E402
from src.runtime import runner as runner_mod  # noqa: E402
from src import lyrics as lyrics_pkg  # noqa: E402
from src.processor import CompleteResult, JobSpec, ProgressEvent  # noqa: E402


from src.lyrics.source import LrclibResult  # noqa: E402


def test_lyrics_key():
    assert lyrics_pkg.lyrics_key("m1") == "derived/lyrics/m1.json"


def test_lrclib_to_segments_prefers_synced_then_plain_then_empty():
    synced = LrclibResult(id=1, instrumental=False, synced_lyrics="[00:01.00]a\n[00:03.00]b", plain_lyrics="a\nb")
    segs = lyrics_pkg.lrclib_to_segments(synced, total_duration=5.0)
    assert [s["text"] for s in segs] == ["a", "b"]
    assert segs[0] == {"start": 1.0, "end": 3.0, "text": "a"}  # line end = next line start

    plain = LrclibResult(id=2, instrumental=False, synced_lyrics=None, plain_lyrics="one\ntwo")
    psegs = lyrics_pkg.lrclib_to_segments(plain, total_duration=4.0)
    assert [s["text"] for s in psegs] == ["one", "two"]  # evenly distributed

    # instrumental / None / no-lyrics → empty
    assert lyrics_pkg.lrclib_to_segments(LrclibResult(3, True, None, None), 5.0) == []
    assert lyrics_pkg.lrclib_to_segments(None, 5.0) == []


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
    doc = lyrics_pkg.normalize_lyrics(RAW)
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
    doc = lyrics_pkg.normalize_lyrics(raw)
    assert len(doc["lines"]) == 1
    line = doc["lines"][0]
    assert [w["word"] for w in line["words"]] == ["hello"]  # only the timed, non-blank word
    assert line["start"] == 1.0 and line["end"] == 1.4  # derived from the surviving words
    assert doc["language"] is None  # absent → null


def test_normalize_skips_empty_segments_and_handles_garbage():
    raw = {"segments": [{"text": "", "words": []}, "not-a-dict", {"words": [{"word": "x", "start": 0, "end": 0.5}]}]}
    doc = lyrics_pkg.normalize_lyrics(raw)
    # empty-text seg with no words → skipped; garbage → skipped; the last derives text from its word
    assert len(doc["lines"]) == 1
    assert doc["lines"][0]["text"] == "x"


def test_normalize_rejects_nan_inf_timestamps():
    raw = {"segments": [{"text": "a b", "words": [
        {"word": "a", "start": float("nan"), "end": 1.0},
        {"word": "b", "start": 1.0, "end": float("inf")},
    ]}]}
    doc = lyrics_pkg.normalize_lyrics(raw)
    assert doc["lines"] == []  # both words un-timed (NaN/inf) → no usable line


def test_is_valid_lyrics():
    assert lyrics_pkg.is_valid_lyrics(lyrics_pkg.normalize_lyrics(RAW)) is True
    assert lyrics_pkg.is_valid_lyrics({"lines": []}) is False
    assert lyrics_pkg.is_valid_lyrics({"lines": [{"text": "x", "words": []}]}) is False  # no timed words
    assert lyrics_pkg.is_valid_lyrics({}) is False


# ── I/O forced-alignment flow: fake LRCLIB client + fake aligner (NO network, NO torch) ─────
from src.lyrics.source import LrclibClient  # noqa: E402


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
    proc = plans.align_runner(runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=aligner)
    events = await drain(proc, spec(tmp_path))

    stages = [(e.stage, e.pct) for e in events if isinstance(e, ProgressEvent)]
    assert ("downloading", 0) in stages and ("aligning", 100) in stages
    # the aligner was fed the KNOWN LRCLIB text (2 lines), not asked to transcribe
    assert aligner.calls and aligner.calls[0][0] == 2 and aligner.calls[0][2] == "en"

    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    uri = completes[0].media_uri
    assert uri.endswith("lyrics/m1-lrclib-word.json")  # per (source, timing) key — candidates coexist
    doc = json.loads(Path(uri).read_text())
    # WORD-timed on the correct text (the whole hybrid point)
    assert lyrics_pkg.is_valid_lyrics(doc)
    assert [l["text"] for l in doc["lines"]] == ["Is this the real life", "Is this just fantasy"]
    # line "Is this the real life" (5 words) spans [1.0,3.0] → span 0.4 → first word [1.0,1.4]
    assert doc["words"][0] == {"word": "Is", "start": 1.0, "end": 1.4}
    assert all({"word", "start", "end"} == set(w) for w in doc["words"])


@pytest.mark.asyncio
async def test_local_source_skips_download(tmp_path):
    local = tmp_path / "lib" / "song.wav"
    local.parent.mkdir(parents=True)
    local.write_bytes(b"x")
    proc = plans.align_runner(runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=FakeAligner())
    stages = {e.stage for e in await drain(proc, spec(tmp_path, source_uri=str(local), fetcher="local")) if isinstance(e, ProgressEvent)}
    assert "downloading" not in stages  # DECLARED local → no fetch, regardless of the uri shape
    assert "aligning" in stages


@pytest.mark.asyncio
async def test_aligner_failure_falls_back_to_line_sync(tmp_path):
    # the aligner blows up → we DON'T fail; ship LRCLIB's line-level sync (whole-line highlight)
    proc = plans.align_runner(runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=FakeAligner(fail=True))
    events = await drain(proc, spec(tmp_path))
    doc = json.loads(Path([e for e in events if isinstance(e, CompleteResult)][0].media_uri).read_text())
    # line-synced fallback: lines with bounds + text, but NO word timings
    assert [l["text"] for l in doc["lines"]] == ["Is this the real life", "Is this just fantasy"]
    assert doc["lines"][0]["start"] == 1.0
    assert all(l["words"] == [] for l in doc["lines"])
    assert lyrics_pkg.is_valid_lyrics(doc) is False  # no word timings — but still shipped line-sync


# "This song has no words" is a RESULT, not an error. These three used to assert a raise, which was
# defensible while lyrics were a garnish — a red job on a song that played fine. It stopped being
# defensible once readiness waits for the lyrics gate: a raise would leave a genuine instrumental stuck
# cooking forever on a step that worked correctly. The job now COMPLETES with no lyrics artifact.


async def _completes_with_no_lyrics(proc, job) -> None:
    events = await drain(proc, job)
    done = [e for e in events if isinstance(e, CompleteResult)]
    assert len(done) == 1, "expected exactly one CompleteResult, not a raise"
    assert not done[0].artifacts.get("lyrics"), "no words found → no lyrics artifact to publish"


@pytest.mark.asyncio
async def test_no_lyrics_found_COMPLETES_with_no_lyrics(tmp_path):
    proc = plans.align_runner(runner=fake_ytdlp_runner(), lyrics_client=fake_client(found=False), aligner=FakeAligner())
    await _completes_with_no_lyrics(proc, spec(tmp_path))


@pytest.mark.asyncio
async def test_an_instrumental_COMPLETES_rather_than_being_stuck_forever(tmp_path):
    # The load-bearing case: an instrumental has no lyrics BY NATURE. Failing it would make the song
    # permanently unsingable via the readiness gate.
    proc = plans.align_runner(runner=fake_ytdlp_runner(), lyrics_client=fake_client(instrumental=True), aligner=FakeAligner())
    await _completes_with_no_lyrics(proc, spec(tmp_path))


@pytest.mark.asyncio
async def test_missing_params_declines_the_lookup_instead_of_erroring_on_params(tmp_path):
    """Acquisition and timing are separate concerns. Without confident metadata the LRCLIB source
    DECLINES (it never asks for a guessed title); the job then completes with nothing to time. It is not
    an assertion about params, which is what let "no LRCLIB" mean "no lyrics"."""
    client = fake_client()
    proc = plans.align_runner(runner=fake_ytdlp_runner(), lyrics_client=client, aligner=FakeAligner())
    job = JobSpec(job_id="j", media_id="m1", job_type="align", source_uri="/tmp/a.wav", params={}, media_dir=str(tmp_path))
    await _completes_with_no_lyrics(proc, job)


# ── acquisition is SEPARATE from timing ────────────────────────────────
# The bug this closes: stage 2 was hardwired to LrclibClient.get() and raised when it returned
# nothing, so an unreachable LRCLIB meant "no lyrics" rather than "no AUTHORITATIVE lyrics".
from src.lyrics.chain import (  # noqa: E402
    SOURCE_ASR,
    SOURCE_LRCLIB,
    TIMING_LINE,
    TIMING_NONE,
    TIMING_WORD,
    LrclibSource,
    LyricsRequest,
    LyricsText,
    acquire,
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
            # SEQUENCE the words across the line, the way a real aligner does. This used to give every
            # word the LINE's own start/end, which meant word 2 appeared to begin before word 1 had
            # finished — output no real aligner produces (zero order violations across six real
            # artifacts) and which the timing validator correctly refuses as an incoherent highlight.
            toks = s["text"].split()
            span = (s["end"] - s["start"]) / max(1, len(toks))
            s["words"] = [
                {"word": w, "start": round(s["start"] + i * span, 3), "end": round(s["start"] + (i + 1) * span, 3)}
                for i, w in enumerate(toks)
            ]
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
    src = LrclibSource(client, lyrics_pkg.lrclib_to_segments)
    assert src.fetch(LyricsRequest(media_id="m1", artist=None, track="x")) is None
    assert src.fetch(LyricsRequest(media_id="m1", artist="x", track=None)) is None


def test_lrclib_source_declines_when_the_network_is_dead_rather_than_raising():
    class Dead:
        def get(self, *a, **k):
            raise RuntimeError("DNS sinkhole / CERTIFICATE_VERIFY_FAILED")

    src = LrclibSource(Dead(), lyrics_pkg.lrclib_to_segments)
    assert src.fetch(LyricsRequest(media_id="m1", artist="a", track="b")) is None


def test_plain_lyrics_are_NOT_reported_as_line_timed():
    """plainLyrics get evenly-spaced synthetic bounds. That is not sync and must not be presented as
    the line-level floor — otherwise the TV would scroll confidently at the wrong times."""
    src = LrclibSource(fake_client(synced=False), lyrics_pkg.lrclib_to_segments)
    got = src.fetch(LyricsRequest(media_id="m1", artist="a", track="b", duration=100.0))
    assert got is not None and got.timing == TIMING_NONE


@pytest.mark.asyncio
async def test_THE_POINT_a_dead_lrclib_still_produces_lyrics_from_another_source(tmp_path):
    """With LRCLIB declining and only an ASR-shaped source available, the job SUCCEEDS with word
    timings. Under the old hardwired stage 2 this raised."""
    dead = FakeSource(SOURCE_LRCLIB, None)
    asr = FakeSource(SOURCE_ASR, _text(SOURCE_ASR, TIMING_WORD, conf="low"))
    proc = plans.align_runner(runner=fake_ytdlp_runner(), aligner=FakeAligner(), sources=[dead, asr])
    events = await drain(proc, spec(tmp_path))
    done = [e for e in events if isinstance(e, CompleteResult)][0]
    cands = done.artifacts["lyrics"]["candidates"]
    assert [c["textSource"] for c in cands] == [SOURCE_ASR]
    assert cands[0]["timing"] == TIMING_WORD
    assert cands[0]["textConfidence"] == "low"  # honest: the TV must label this
    assert Path(done.media_uri).exists()


@pytest.mark.asyncio
async def test_a_suspect_winner_and_its_baseline_get_SEPARATE_artifact_files(tmp_path):
    """No overwrite — the upgrade path depends on it. Two texts published in one run must land on
    distinct keys, or the second write destroys the first and the room is left with only the words that
    were already judged wrong."""
    wrong = "never gonna give you up let down run around desert cry say goodbye tell lie hurt"
    lrc = FakeSource(SOURCE_LRCLIB, _candidate(wrong))
    asr = FakeSource(SOURCE_ASR, _baseline(_SUNG))
    proc = plans.align_runner(runner=fake_ytdlp_runner(), aligner=FakeAligner(), sources=[lrc, asr])
    cands = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0].artifacts["lyrics"][
        "candidates"
    ]
    refs = {c["textSource"]: c["ref"] for c in cands}
    assert set(refs) == {SOURCE_LRCLIB, SOURCE_ASR}
    assert refs[SOURCE_LRCLIB] != refs[SOURCE_ASR]
    for c in cands:
        assert (tmp_path / c["ref"]).exists()


@pytest.mark.asyncio
async def test_the_worker_chooses_the_TEXT_but_does_not_implement_the_presentation_TIERING(tmp_path):
    """Two different decisions, in two different places, and this pins the seam.

    The worker DOES choose which text is the song's words — that is the two-tier grading, and it has to
    happen here because this is the only place the candidate and the baselines exist in memory together.
    What it does not do is rank what it published for display: `uri` is merely the first artifact, and
    pickBestLyrics in packages/shared/src/lyrics.ts re-picks on every write and restore. So there is no
    second copy of the presentation tier logic here to drift out of step with the TS one.
    """
    wrong = "never gonna give you up let down run around desert cry say goodbye tell lie hurt"
    lrc = FakeSource(SOURCE_LRCLIB, _candidate(wrong))
    asr = FakeSource(SOURCE_ASR, _baseline(_SUNG))
    proc = plans.align_runner(runner=fake_ytdlp_runner(), aligner=FakeAligner(), sources=[asr, lrc])
    done = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0]
    cands = done.artifacts["lyrics"]["candidates"]
    # uri is the FIRST published artifact, not a ranked winner
    assert done.media_uri.endswith(cands[0]["ref"])
    # and both are reported, which is what lets the core choose what to show
    assert {c["textSource"] for c in cands} == {SOURCE_LRCLIB, SOURCE_ASR}


@pytest.mark.asyncio
async def test_aligner_failure_degrades_that_candidate_to_LINE_sync(tmp_path):
    class Broken:
        def align(self, *a, **k):
            raise RuntimeError("no wav2vec2 model")

    lrc = FakeSource(SOURCE_LRCLIB, _text(SOURCE_LRCLIB, TIMING_LINE))
    proc = plans.align_runner(runner=fake_ytdlp_runner(), aligner=Broken(), sources=[lrc])
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
    proc = plans.align_runner(runner=fake_ytdlp_runner(), aligner=Broken(),
                                      sources=[FakeSource(SOURCE_LRCLIB, untimed)])
    with pytest.raises(RuntimeError, match="nothing could be timed"):
        await drain(proc, spec(tmp_path))


# ── the ASR tier ───────────────────────────────────────────────────────
from src.lyrics.chain import AsrSource  # noqa: E402


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
    got = AsrSource(t, lyrics_pkg.normalize_lyrics).fetch(
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
    assert AsrSource(t, lyrics_pkg.normalize_lyrics).fetch(
        LyricsRequest(media_id="m1", audio_path="/mix.wav", vocals_path=None)
    ) is None
    assert t.calls == []  # never even attempted


def test_asr_source_declines_when_the_model_is_unavailable():
    got = AsrSource(FakeTranscriber(boom=True), lyrics_pkg.normalize_lyrics).fetch(
        LyricsRequest(media_id="m1", vocals_path="/vocals.m4a")
    )
    assert got is None  # a miss, not a job failure


def test_asr_source_declines_on_an_empty_transcript_an_instrumental():
    got = AsrSource(FakeTranscriber({"language": "en", "segments": []}), lyrics_pkg.normalize_lyrics).fetch(
        LyricsRequest(media_id="m1", vocals_path="/vocals.m4a")
    )
    assert got is None


@pytest.mark.asyncio
async def test_DONE_WHEN_lrclib_dead_asr_still_yields_word_timed_lyrics(tmp_path):
    """The done-when, at the unit level: with LRCLIB declining, a cooked song still gets WORD-timed
    lyrics on the TV — and they are marked low-confidence so the overlay can be honest."""
    vocals = tmp_path / "derived" / "stems"
    vocals.mkdir(parents=True)
    (vocals / "m1-vocals.m4a").write_bytes(b"fake stem")

    class DeadLrclib:
        def get(self, *a, **k):
            raise RuntimeError("DNS sinkhole")

    proc = plans.align_runner(
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
async def test_a_lookup_TOO_SHORT_to_judge_is_published_unjudged_not_condemned(tmp_path):
    """The real chain end to end: LRCLIB answers, both local baselines transcribe, grading runs.

    The canned lookup here carries only seven distinct words — under MIN_TOKENS_TO_COMPARE — so no
    baseline can form an opinion about it. "Cannot tell" must not resolve to "wrong": the candidate is
    published as the song's words with no score attached, and no baseline is published alongside, because
    nothing was actually judged suspect.
    """
    vocals = tmp_path / "derived" / "stems"
    vocals.mkdir(parents=True)
    (vocals / "m1-vocals.m4a").write_bytes(b"fake stem")
    proc = plans.align_runner(
        runner=fake_ytdlp_runner(),
        lyrics_client=fake_client(),
        aligner=FakeAligner(),
        transcriber=FakeTranscriber(ASR_RAW),
    )
    done = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0]
    cands = done.artifacts["lyrics"]["candidates"]
    assert {c["textSource"] for c in cands} == {"lrclib"}
    assert "agreement" not in cands[0]  # unjudged carries no score rather than a misleading zero
    # uri is simply the first published artifact; the core ranks (see the seam test above)
    assert done.media_uri.endswith(cands[0]["ref"])


def test_asr_KEEPS_word_timings_if_a_transcriber_ever_supplies_them():
    """Defensive: real whisper transcribe() has no words, but a different backend might. Then the
    timing layer should keep them rather than re-aligning."""
    raw = {"language": "en", "segments": [
        {"start": 0.0, "end": 1.0, "text": "hello there",
         "words": [{"word": "hello", "start": 0.0, "end": 0.5}, {"word": "there", "start": 0.5, "end": 1.0}]}]}
    got = AsrSource(FakeTranscriber(raw), lyrics_pkg.normalize_lyrics).fetch(
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

    proc = plans.align_runner(runner=fake_ytdlp_runner(), lyrics_client=DeadLrclib(),
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
    monkeypatch.setattr(runner_mod, "LEASE_KEEPALIVE_SEC", 0.02)
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
        proc = plans.align_runner(runner=fake_ytdlp_runner(), lyrics_client=fake_client(),
                                         aligner=SlowAligner())
        await drain(proc, spec(tmp_path))
    finally:
        beat.cancel()
    assert ticks > 3, f"event loop was starved during the ML call (only {ticks} ticks)"


@pytest.mark.asyncio
async def test_keepalive_progress_is_emitted_while_ML_runs(tmp_path, monkeypatch):
    """Each keepalive refreshes the core's progress lease, which is what stops the reaper from
    requeueing a job that is running fine."""
    monkeypatch.setattr(runner_mod, "LEASE_KEEPALIVE_SEC", 0.02)

    class SlowAligner:
        def align(self, segments, audio_path, language):
            time.sleep(0.25)
            return {"language": language, "segments": [
                {"start": 0.0, "end": 1.0, "text": "x", "words": [{"word": "x", "start": 0.0, "end": 1.0}]}]}

    proc = plans.align_runner(runner=fake_ytdlp_runner(), lyrics_client=fake_client(),
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

    proc = plans.align_runner(runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=Broken())
    done = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0]
    assert done.artifacts["lyrics"]["candidates"][0]["timing"] == TIMING_LINE


def test_concurrent_ML_calls_are_serialized_on_the_shared_model():
    """One WhisperXProcessor serves every align job and caches ONE model, so with concurrency>1 two
    threads would otherwise enter transcribe()/align() on it at once. faster-whisper is not
    thread-safe; before the thread offload the blocked event loop hid this."""
    import threading

    overlaps = []
    inside = []

    def body():
        with lyrics_pkg.ML_LOCK:
            inside.append(1)
            overlaps.append(len(inside))
            time.sleep(0.05)
            inside.pop()

    threads = [threading.Thread(target=body) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert max(overlaps) == 1, f"ML section was entered concurrently ({max(overlaps)} at once)"


def test_the_ml_lock_is_reentrant_so_a_public_call_can_use_the_lazy_loader():
    """transcribe() takes the lock and then calls _load(), which takes it again — a plain Lock would
    deadlock the worker on the first real transcription."""
    with lyrics_pkg.ML_LOCK:
        with lyrics_pkg.ML_LOCK:
            pass  # a non-reentrant lock never reaches here


# ── the wrong-song guard, now graded against BASELINES ─────────────────────────
from src.lyrics.chain import (  # noqa: E402
    ROLE_BASELINE,
    SUSPECT_AGREEMENT,
    agreement_score,
    composite_score,
)

_SUNG = "we could be heroes just for one day standing by the wall guns above our heads and we kissed"


def _baseline(body, rank=0, variant="whisper/vocals"):
    """A BASELINE text — evidence of what is audible. Roles are explicit now: a fake that forgot to
    declare itself a baseline would be graded as a claim about the words instead of grading them."""
    return LyricsText(text_source=SOURCE_ASR, timing=TIMING_LINE, text_confidence="low",
                      role=ROLE_BASELINE, baseline_rank=rank, variant=variant,
                      segments=[{"start": 0.0, "end": 4.0, "text": body}])


def _candidate(body, source=SOURCE_LRCLIB):
    return LyricsText(text_source=source, timing=TIMING_LINE, text_confidence="high",
                      segments=[{"start": 0.0, "end": 4.0, "text": body}])


def test_agreement_score_matches_the_TS_semantics():
    near = "we could be heroes just for one day standing near the wall guns above their heads and we kissed"
    assert agreement_score(_SUNG, near) > 0.7
    other = "never gonna give you up let down run around desert cry say goodbye tell lie hurt"
    assert agreement_score(_SUNG, other) < SUSPECT_AGREEMENT
    # too short to judge → None, NOT 0: an instrumental must not condemn a correct lookup
    assert agreement_score("la la la", _SUNG) is None


def test_composite_is_the_MEAN_over_baselines_that_can_speak():
    """One baseline is one opinion; the composite averages independent ones."""
    near = "we could be heroes just for one day standing near the wall guns above their heads and we kissed"
    score, votes = composite_score(_candidate(_SUNG), [_baseline(_SUNG), _baseline(near, rank=1)])
    assert len(votes) == 2
    assert score == pytest.approx(sum(votes) / 2)


def test_a_baseline_too_thin_to_judge_ABSTAINS_rather_than_voting_zero():
    """The property that makes a weak baseline (YouTube auto-captions on music) safe to include: it
    drops out of the mean instead of dragging it down."""
    score, votes = composite_score(_candidate(_SUNG), [_baseline(_SUNG), _baseline("la la la", rank=2)])
    assert len(votes) == 1  # the thin one abstained
    assert score == 1.0  # ...and did not dilute the one that spoke


def test_no_baseline_at_all_means_UNJUDGED_rather_than_a_zero():
    assert composite_score(_candidate(_SUNG), []) == (None, [])


@pytest.mark.asyncio
async def test_A_WRONG_SONG_LOOKUP_IS_DEMOTED_not_shown_as_authoritative(tmp_path):
    """A lookup's dangerous failure is a confident MISMATCH. When the chosen text disagrees with every
    baseline, it must lose its authority — which makes the TV label it — and what was actually HEARD is
    published alongside, so the room gets real alternative words instead of only a warning."""
    wrong = "never gonna give you up let down run around desert cry say goodbye tell lie hurt"
    lrc = FakeSource(SOURCE_LRCLIB, _candidate(wrong))
    asr = FakeSource(SOURCE_ASR, _baseline(_SUNG))
    proc = plans.align_runner(runner=fake_ytdlp_runner(), aligner=FakeAligner(), sources=[lrc, asr])
    done = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0]
    cands = done.artifacts["lyrics"]["candidates"]
    bysrc = {c["textSource"]: c for c in cands}
    assert bysrc[SOURCE_LRCLIB]["textConfidence"] == "low"        # demoted: no longer authoritative
    assert bysrc[SOURCE_LRCLIB]["agreement"] < SUSPECT_AGREEMENT  # and the evidence is recorded
    assert SOURCE_ASR in bysrc  # the baseline was published as a real alternative


@pytest.mark.asyncio
async def test_an_AGREEING_lookup_keeps_its_authority_and_records_the_score(tmp_path):
    lrc = FakeSource(SOURCE_LRCLIB, _candidate(_SUNG))
    asr = FakeSource(SOURCE_ASR, _baseline(_SUNG))
    proc = plans.align_runner(runner=fake_ytdlp_runner(), aligner=FakeAligner(), sources=[lrc, asr])
    done = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0]
    bysrc = {c["textSource"]: c for c in done.artifacts["lyrics"]["candidates"]}
    assert bysrc[SOURCE_LRCLIB]["textConfidence"] == "high"
    assert bysrc[SOURCE_LRCLIB]["agreement"] == 1.0
    # A trustworthy winner means the baselines have done their job by grading it — publishing one for its
    # own sake would cost a whole extra alignment pass to produce words nobody shows.
    assert SOURCE_ASR not in bysrc
