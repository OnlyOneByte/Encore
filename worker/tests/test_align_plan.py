"""The ALIGN plan, end to end (docs/ARCHITECTURE.md §7.1).

Every seam stays injectable: the real WhisperX, LRCLIB, and yt-dlp only run on a worker box, so the
whole flow must be exercisable without any of them.
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import lyrics as lyrics_pkg  # noqa: E402
from src import plans  # noqa: E402
from src.lyrics.lrclib import LrclibResult  # noqa: E402
from src.processor import CompleteResult, JobSpec, ProgressEvent  # noqa: E402
from src.runtime import runner as runner_mod  # noqa: E402
from tests.conftest import drain  # noqa: E402


def test_lyrics_key():
    assert lyrics_pkg.candidate_key("m1", "lrclib", "line") == "derived/lyrics/m1-lrclib-line.json"


def test_lrclib_to_segments_prefers_synced_then_plain_then_empty():
    synced = LrclibResult(
        id=1, instrumental=False, synced_lyrics="[00:01.00]a\n[00:03.00]b", plain_lyrics="a\nb"
    )
    segs = lyrics_pkg.lrclib_to_segments(synced, total_duration=5.0)
    assert [s["text"] for s in segs] == ["a", "b"]
    assert segs[0] == {"start": 1.0, "end": 3.0, "text": "a"}  # line end = next line start

    plain = LrclibResult(id=2, instrumental=False, synced_lyrics=None, plain_lyrics="one\ntwo")
    psegs = lyrics_pkg.lrclib_to_segments(plain, total_duration=4.0)
    assert [s["text"] for s in psegs] == ["one", "two"]  # evenly distributed

    assert lyrics_pkg.lrclib_to_segments(LrclibResult(3, True, None, None), 5.0) == []
    assert lyrics_pkg.lrclib_to_segments(None, 5.0) == []


RAW = {
    "language": "en",
    "segments": [
        {
            "start": 0.5,
            "end": 2.0,
            "text": "Is this the real life",
            "words": [
                {"word": "Is", "start": 0.5, "end": 0.7, "score": 0.9},
                {"word": "this", "start": 0.7, "end": 0.95, "score": 0.9},
                {"word": "the", "start": 0.95, "end": 1.1, "score": 0.8},
                {"word": "real", "start": 1.1, "end": 1.5, "score": 0.9},
                {"word": "life", "start": 1.5, "end": 2.0, "score": 0.9},
            ],
        },
        {
            "start": 2.2,
            "end": 4.0,
            "text": "Is this just fantasy",
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
    assert len(doc["words"]) == 9
    assert doc["words"][0] == {"word": "Is", "start": 0.5, "end": 0.7}


def test_normalize_drops_untimed_words_and_derives_line_bounds():
    raw = {
        "segments": [
            {
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
    raw = {
        "segments": [
            {"text": "", "words": []},
            "not-a-dict",
            {"words": [{"word": "x", "start": 0, "end": 0.5}]},
        ]
    }
    doc = lyrics_pkg.normalize_lyrics(raw)
    # empty-text seg with no words → skipped; garbage → skipped; the last derives text from its word
    assert len(doc["lines"]) == 1
    assert doc["lines"][0]["text"] == "x"


def test_normalize_rejects_nan_inf_timestamps():
    raw = {
        "segments": [
            {
                "text": "a b",
                "words": [
                    {"word": "a", "start": float("nan"), "end": 1.0},
                    {"word": "b", "start": 1.0, "end": float("inf")},
                ],
            }
        ]
    }
    doc = lyrics_pkg.normalize_lyrics(raw)
    assert doc["lines"] == []  # both words un-timed (NaN/inf) → no usable line


def test_is_valid_lyrics():
    assert lyrics_pkg.is_valid_lyrics(lyrics_pkg.normalize_lyrics(RAW)) is True
    assert lyrics_pkg.is_valid_lyrics({"lines": []}) is False
    assert lyrics_pkg.is_valid_lyrics({"lines": [{"text": "x", "words": []}]}) is False  # no timed words
    assert lyrics_pkg.is_valid_lyrics({}) is False


from src.lyrics.lrclib import LrclibClient  # noqa: E402


def fake_ytdlp_runner(*, progress=("[download]  50.0% of 1MiB", "[download] 100% of 1MiB")):
    """yt-dlp stand-in: writes the extracted wav so the download stage 'produces' its output."""

    async def run(argv):
        out = argv[argv.index("-o") + 1]
        os.makedirs(os.path.dirname(out), exist_ok=True)
        Path(out).write_bytes(b"FAKE_SOURCE_WAV")
        for line in progress:
            yield line

    return run


def fake_client(
    *,
    synced="[00:01.00]Is this the real life\n[00:03.00]Is this just fantasy",
    instrumental=False,
    found=True,
):
    """LrclibClient with an injected fetcher returning canned JSON (or a 404 when found=False)."""

    def fetch(url, headers):
        if not found:
            return 404, ""
        body = {
            "id": 1,
            "instrumental": instrumental,
            "syncedLyrics": None if instrumental else synced,
            "plainLyrics": None if instrumental else "Is this the real life\nIs this just fantasy",
        }
        return 200, json.dumps(body)

    return LrclibClient(fetcher=fetch)


class FakeAligner:
    """Force-aligner stand-in: turns known-text segments into per-word timings by evenly spacing
    words across each segment's [start,end] — the shape whisperx.align returns, minus the ML."""

    def __init__(self, fail=False):
        self.fail = fail
        self.calls = []
        # also records the exact segments searched, so a test can pin WHICH windows the aligner saw.
        self.searched = []

    def align(self, segments, audio_path, language):
        self.calls.append((len(segments), audio_path, language))
        self.searched.append([(s["start"], s["end"], s["text"]) for s in segments])
        if self.fail:
            raise RuntimeError("aligner unavailable (simulated)")
        out_segs = []
        for s in segments:
            toks = s["text"].split()
            span = (s["end"] - s["start"]) / max(1, len(toks))
            words = [
                {
                    "word": t,
                    "start": round(s["start"] + i * span, 3),
                    "end": round(s["start"] + (i + 1) * span, 3),
                }
                for i, t in enumerate(toks)
            ]
            out_segs.append({"start": s["start"], "end": s["end"], "text": s["text"], "words": words})
        return {"language": language, "segments": out_segs}


def spec(tmp_path, source_uri="https://yt/x", media_id="m1", **params):
    p = {"artist": "Queen", "track": "Bohemian Rhapsody", "language": "en", "durationSec": 6.0}
    p.update(params)
    return JobSpec(
        job_id="j1",
        media_id=media_id,
        job_type="align",
        source_uri=source_uri,
        params=p,
        media_dir=str(tmp_path),
    )


@pytest.mark.asyncio
async def test_hybrid_flow_download_lrclib_forcealign_writes_word_timed_lyrics(tmp_path):
    aligner = FakeAligner()
    proc = plans.align_runner(runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=aligner)
    events = await drain(proc, spec(tmp_path))

    stages = [(e.stage, e.pct) for e in events if isinstance(e, ProgressEvent)]
    assert ("downloading", 0) in stages and ("aligning", 100) in stages
    assert aligner.calls and aligner.calls[0][0] == 2 and aligner.calls[0][2] == "en"

    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    uri = completes[0].media_uri
    assert uri.endswith("lyrics/m1-lrclib-word.json")  # per (source, timing) key — candidates coexist
    doc = json.loads(Path(uri).read_text())
    assert lyrics_pkg.is_valid_lyrics(doc)
    assert [ln["text"] for ln in doc["lines"]] == ["Is this the real life", "Is this just fantasy"]
    # line "Is this the real life" (5 words) spans [1.0,3.0] → span 0.4 → first word [1.0,1.4]
    assert doc["words"][0] == {"word": "Is", "start": 1.0, "end": 1.4}
    assert all({"word", "start", "end"} == set(w) for w in doc["words"])


@pytest.mark.asyncio
async def test_local_source_skips_download(tmp_path):
    local = tmp_path / "lib" / "song.wav"
    local.parent.mkdir(parents=True)
    local.write_bytes(b"x")
    proc = plans.align_runner(runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=FakeAligner())
    stages = {
        e.stage
        for e in await drain(proc, spec(tmp_path, source_uri=str(local), fetcher="local"))
        if isinstance(e, ProgressEvent)
    }
    assert "downloading" not in stages  # DECLARED local → no fetch, regardless of the uri shape
    assert "aligning" in stages


@pytest.mark.asyncio
async def test_aligner_failure_falls_back_to_line_sync(tmp_path):
    proc = plans.align_runner(
        runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=FakeAligner(fail=True)
    )
    events = await drain(proc, spec(tmp_path))
    doc = json.loads(Path([e for e in events if isinstance(e, CompleteResult)][0].media_uri).read_text())
    assert [ln["text"] for ln in doc["lines"]] == ["Is this the real life", "Is this just fantasy"]
    assert doc["lines"][0]["start"] == 1.0
    assert all(ln["words"] == [] for ln in doc["lines"])
    assert lyrics_pkg.is_valid_lyrics(doc) is False  # no word timings — but still shipped line-sync


# A song with no words COMPLETES rather than raising: raising would leave a genuine instrumental
# stuck forever behind the readiness gate that waits on this step.


async def _completes_with_no_lyrics(proc, job) -> None:
    events = await drain(proc, job)
    done = [e for e in events if isinstance(e, CompleteResult)]
    assert len(done) == 1, "expected exactly one CompleteResult, not a raise"
    assert not done[0].artifacts.get("lyrics"), "no words found → no lyrics artifact to publish"


@pytest.mark.asyncio
async def test_no_lyrics_found_COMPLETES_with_no_lyrics(tmp_path):
    proc = plans.align_runner(
        runner=fake_ytdlp_runner(), lyrics_client=fake_client(found=False), aligner=FakeAligner()
    )
    await _completes_with_no_lyrics(proc, spec(tmp_path))


@pytest.mark.asyncio
async def test_an_instrumental_COMPLETES_rather_than_being_stuck_forever(tmp_path):
    proc = plans.align_runner(
        runner=fake_ytdlp_runner(), lyrics_client=fake_client(instrumental=True), aligner=FakeAligner()
    )
    await _completes_with_no_lyrics(proc, spec(tmp_path))


@pytest.mark.asyncio
async def test_missing_params_declines_the_lookup_instead_of_erroring_on_params(tmp_path):
    """Without confident metadata, LrclibSource DECLINES rather than querying on a guessed title; the
    job then completes with nothing to time."""
    client = fake_client()
    proc = plans.align_runner(runner=fake_ytdlp_runner(), lyrics_client=client, aligner=FakeAligner())
    job = JobSpec(
        job_id="j",
        media_id="m1",
        job_type="align",
        source_uri="/tmp/a.wav",
        params={},
        media_dir=str(tmp_path),
    )
    await _completes_with_no_lyrics(proc, job)


# Acquisition (fetching all sources) is separate from timing: an unreachable LRCLIB must mean "no
# AUTHORITATIVE lyrics", not "no lyrics" — other sources still run.
from src.lyrics.grading import (  # noqa: E402
    ROLE_CANDIDATE,
    SOURCE_ASR,
    SOURCE_LRCLIB,
    TIMING_LINE,
    TIMING_NONE,
    TIMING_WORD,
    LrclibSource,
    LyricsRequest,
    LyricsText,
    acquire,
    acquire_with_notes,
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


def _text(source, timing, lines=("line one here", "line two here"), conf="high", role=ROLE_CANDIDATE):
    segs = [{"start": i * 2.0, "end": i * 2.0 + 1.5, "text": t} for i, t in enumerate(lines)]
    if timing == TIMING_WORD:
        for s in segs:
            # Sequence words within the line, as a real aligner would — giving every word the line's
            # own start/end would look out-of-order and the timing validator would refuse it.
            toks = s["text"].split()
            span = (s["end"] - s["start"]) / max(1, len(toks))
            s["words"] = [
                {
                    "word": w,
                    "start": round(s["start"] + i * span, 3),
                    "end": round(s["start"] + (i + 1) * span, 3),
                }
                for i, w in enumerate(toks)
            ]
    # role is explicit: LyricsText defaults fail-closed (ROLE_UNSPECIFIED), so a fake bypassing the
    # registry must set it or nothing publishes.
    return LyricsText(text_source=source, segments=segs, timing=timing, text_confidence=conf, role=role)


def test_acquire_runs_every_source_not_just_the_first():
    a = FakeSource("a", _text(SOURCE_LRCLIB, TIMING_LINE))
    b = FakeSource("b", _text(SOURCE_ASR, TIMING_WORD))
    got = acquire([a, b], LyricsRequest(media_id="m1"))
    assert len(got) == 2 and a.calls == 1 and b.calls == 1  # complements, not alternatives


def test_acquire_skips_a_source_that_raises_without_losing_the_others():
    got = acquire(
        [FakeSource("boom", boom=True), FakeSource("ok", _text(SOURCE_ASR, TIMING_WORD))],
        LyricsRequest(media_id="m1"),
    )
    assert len(got) == 1 and got[0].text_source == SOURCE_ASR


def test_acquire_drops_empty_text():
    empty = LyricsText(text_source=SOURCE_LRCLIB, segments=[{"text": "   "}], timing=TIMING_NONE)
    assert acquire([FakeSource("e", empty)], LyricsRequest(media_id="m1")) == []


class RaisingSource:
    """A source whose fetch RAISES the transport class — the shape a DNS-sinkholed LRCLIB now takes
    once _urllib_fetch converts URLError → LyricsFetchError."""

    def __init__(self, name, exc):
        self.name = name
        self._exc = exc

    def fetch(self, req):
        raise self._exc


def test_acquire_with_notes_surfaces_a_provider_transport_failure_as_a_loud_note():
    """a source that RAN and RAISED a transport failure (the sinkhole) must produce a visible
    note, not a silent drop that looks like a song with no lyrics. The surviving tier is unaffected."""
    from src.lyrics.lrclib import LyricsFetchError

    lrclib = RaisingSource(
        "lrclib", LyricsFetchError("lrclib unreachable: [Errno -2] Name or service not known")
    )
    asr = FakeSource("asr", _text(SOURCE_ASR, TIMING_WORD))
    texts, notes = acquire_with_notes([lrclib, asr], LyricsRequest(media_id="m1"))

    assert len(texts) == 1 and texts[0].text_source == SOURCE_ASR
    joined = " ".join(notes)
    assert "lrclib" in joined and "unreachable" in joined
    assert "FAILED" in joined and "not a song without lyrics" in joined


def test_acquire_with_notes_notes_a_genuine_per_song_miss_quietly():
    """A source that ran and simply found nothing is a real miss — still noted, but plainly, so it
    reads differently from a provider being down."""
    miss = FakeSource("lrclib", None)
    texts, notes = acquire_with_notes([miss], LyricsRequest(media_id="m1"))
    assert texts == []
    assert any("found nothing" in n for n in notes)
    assert not any("FAILED" in n for n in notes)


def test_acquire_wrapper_still_returns_texts_only_no_regression():
    """The texts-only acquire() shim must keep the old contract for its existing callers/tests."""
    a = FakeSource("a", _text(SOURCE_LRCLIB, TIMING_LINE))
    b = FakeSource("b", _text(SOURCE_ASR, TIMING_WORD))
    got = acquire([a, b], LyricsRequest(media_id="m1"))
    assert isinstance(got, list) and len(got) == 2


class _FakeLrclibClient:
    """A client whose search()/get() outcomes are set independently, so a test can bite EXACTLY one
    branch of LrclibSource.fetch (search vs the get() fallback) rather than both at once."""

    def __init__(self, *, search=None, get=None):
        self._search = search
        self._get = get

    def search(self, artist, track):
        if isinstance(self._search, Exception):
            raise self._search
        return self._search or []

    def get(self, artist, track, duration=None, album=None):
        if isinstance(self._get, Exception):
            raise self._get
        return self._get


def test_lrclib_source_propagates_a_transport_failure_from_SEARCH():
    """A LyricsFetchError from search() (provider down) must escape fetch() so it can be noted, not
    fall through to a None miss — get() here would also MISS (None)."""
    from src.lyrics.lrclib import LyricsFetchError

    client = _FakeLrclibClient(
        search=LyricsFetchError("lrclib unreachable: Name or service not known"), get=None
    )
    src = LrclibSource(client=client, to_segments=lambda *_a, **_k: [])
    with pytest.raises(LyricsFetchError):
        src.fetch(LyricsRequest(media_id="m1", artist="a-ha", track="Take On Me"))


def test_lrclib_source_propagates_a_transport_failure_from_GET_fallback():
    """When search() legitimately finds nothing ([]), the get() fallback runs; a LyricsFetchError there
    must also escape rather than becoming a None miss."""
    from src.lyrics.lrclib import LyricsFetchError

    client = _FakeLrclibClient(search=[], get=LyricsFetchError("lrclib unreachable: connection refused"))
    src = LrclibSource(client=client, to_segments=lambda *_a, **_k: [])
    with pytest.raises(LyricsFetchError):
        src.fetch(LyricsRequest(media_id="m1", artist="a-ha", track="Take On Me"))


def test_lyrics_package_reexports_acquire_with_notes():
    """The step imports acquire_with_notes from the ..lyrics package facade; keep it in __all__ so a
    `from ..lyrics import *` (and the package's own export contract) does not silently drop it."""
    import src.lyrics as lyrics_pkg

    assert "acquire_with_notes" in lyrics_pkg.__all__
    assert hasattr(lyrics_pkg, "acquire_with_notes")


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
    timings."""
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
    cands = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0].artifacts[
        "lyrics"
    ]["candidates"]
    refs = {c["textSource"]: c["ref"] for c in cands}
    assert set(refs) == {SOURCE_LRCLIB, SOURCE_ASR}
    assert refs[SOURCE_LRCLIB] != refs[SOURCE_ASR]
    for c in cands:
        assert (tmp_path / c["ref"]).exists()


@pytest.mark.asyncio
async def test_the_worker_chooses_the_TEXT_but_does_not_implement_the_presentation_TIERING(tmp_path):
    """The worker chooses which text IS the song's words (two-tier grading against baselines) because
    only here do the candidate and baselines exist in memory together. It does NOT rank what it
    published for display — `media_uri` is just the first artifact; `pickBestLyrics` in
    src/lib/contract/lyrics/lyrics.ts re-picks on every write and restore."""
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
    proc = plans.align_runner(
        runner=fake_ytdlp_runner(), aligner=Broken(), sources=[FakeSource(SOURCE_LRCLIB, untimed)]
    )
    with pytest.raises(RuntimeError, match="nothing could be timed"):
        await drain(proc, spec(tmp_path))


@pytest.mark.asyncio
async def test_aligner_that_PLACES_NO_WORD_degrades_via_the_FAILURE_path_not_validate(tmp_path):
    """whisperx signals "nothing to place" by returning cleanly with every token un-timed, not by
    raising. That must take the SAME line-sync fallback a raise takes — line timings at (line, HIGH)
    with no note — rather than falling into the validate path, which would wrongly degrade to
    (line, LOW) and emit a false "REFUSING word timing" note blaming word ordering for an empty result.
    """

    class EmptyAligner:
        """whisperx placed no word: segments come back, every token un-timed. Does NOT raise."""

        def align(self, segments, audio_path, language):
            return {
                "language": language,
                "segments": [
                    {"start": s["start"], "end": s["end"], "text": s["text"], "words": []} for s in segments
                ],
            }

    text = _text(SOURCE_LRCLIB, TIMING_LINE)
    ctx = await _drive_time_texts(EmptyAligner(), text, tmp_path)
    cands = ctx.out.artifacts["lyrics"]["candidates"]

    # degraded via the FAILURE path: source's own line sync at HIGH, not (line, low) via validate.
    assert (cands[0]["timing"], cands[0]["timingConfidence"]) == (TIMING_LINE, "high"), cands[0]
    # absence of a REFUSING note is what distinguishes the failure path from the validate path.
    assert not any("REFUSING word timing" in n for n in ctx.out.notes), ctx.out.notes

    doc = json.loads(Path(os.path.join(str(tmp_path), cands[0]["ref"])).read_text())
    assert lyrics_pkg.is_valid_lyrics(doc) is False
    assert doc["words"] == []
    assert [ln["text"] for ln in doc["lines"]] == ["line one here", "line two here"]
    assert all(ln["words"] == [] for ln in doc["lines"])


from src.lyrics.grading import AsrSource  # noqa: E402


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


# Real whisper transcribe() output: segments with start/end/text and NO words. Word timings come
# from the separate align() pass, never from transcription.
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


def test_asr_source_declines_when_the_vocals_stem_is_not_processed_yet():
    """It does NOT fall back to the mixed audio: quietly producing worse words would be
    indistinguishable from producing good ones."""
    t = FakeTranscriber(ASR_RAW)
    assert (
        AsrSource(t, lyrics_pkg.normalize_lyrics).fetch(
            LyricsRequest(media_id="m1", audio_path="/mix.wav", vocals_path=None)
        )
        is None
    )
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
    """The done-when, at the unit level: with LRCLIB declining, a processed song still gets WORD-timed
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
    assert done.media_uri.endswith(cands[0]["ref"])


def test_asr_KEEPS_word_timings_if_a_transcriber_ever_supplies_them():
    """Defensive: real whisper transcribe() has no words, but a different backend might. Then the
    timing layer should keep them rather than re-aligning."""
    raw = {
        "language": "en",
        "segments": [
            {
                "start": 0.0,
                "end": 1.0,
                "text": "hello there",
                "words": [
                    {"word": "hello", "start": 0.0, "end": 0.5},
                    {"word": "there", "start": 0.5, "end": 1.0},
                ],
            }
        ],
    }
    got = AsrSource(FakeTranscriber(raw), lyrics_pkg.normalize_lyrics).fetch(
        LyricsRequest(media_id="m1", vocals_path="/v.m4a")
    )
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

    proc = plans.align_runner(
        runner=fake_ytdlp_runner(),
        lyrics_client=DeadLrclib(),
        aligner=aligner,
        transcriber=FakeTranscriber(ASR_RAW),
    )
    done = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0]
    assert aligner.calls, "the ASR text must be handed to the aligner"
    assert done.artifacts["lyrics"]["candidates"][0]["timing"] == TIMING_WORD


@pytest.mark.asyncio
async def test_blocking_ML_does_not_freeze_the_event_loop(tmp_path, monkeypatch):
    """A blocking ML call inline would freeze the event loop: the worker would miss the websocket
    keepalive and stop sending job:progress, so the core's progress lease expires and the reaper
    requeues a healthy job. Proves other tasks still run during the ML call."""
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
            return {
                "language": language,
                "segments": [
                    {
                        "start": 0.0,
                        "end": 1.0,
                        "text": "x",
                        "words": [{"word": "x", "start": 0.0, "end": 1.0}],
                    }
                ],
            }

    beat = asyncio.ensure_future(heartbeat())
    try:
        proc = plans.align_runner(
            runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=SlowAligner()
        )
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
            return {
                "language": language,
                "segments": [
                    {
                        "start": 0.0,
                        "end": 1.0,
                        "text": "x",
                        "words": [{"word": "x", "start": 0.0, "end": 1.0}],
                    }
                ],
            }

    proc = plans.align_runner(runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=SlowAligner())
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


def _stub_whisperx(monkeypatch, *, on_call=None):
    """Install a fake `whisperx` in sys.modules so the real WhisperxTranscriber / WhisperxForcedAligner
    lazy-import succeeds and their production `with ML_LOCK:` bodies actually run. `on_call` (if given)
    is invoked inside the model call so a test can observe concurrency THROUGH the production lock."""
    import types

    wx = types.ModuleType("whisperx")

    def load_audio(path):
        return f"audio::{path}"

    class _Model:
        def transcribe(self, audio, language=None):
            if on_call is not None:
                on_call()
            return {"language": language or "en", "segments": []}

    def load_model(name, device, compute_type=None):
        return _Model()

    def load_align_model(language_code, device):
        return ("align_model", {"lang": language_code})

    def align(segments, model, meta, audio, device, return_char_alignments=False):
        if on_call is not None:
            on_call()
        return {"segments": segments}

    wx.load_audio = load_audio
    wx.load_model = load_model
    wx.load_align_model = load_align_model
    wx.align = align
    monkeypatch.setitem(sys.modules, "whisperx", wx)
    return wx


def test_concurrent_ML_calls_are_serialized_on_the_shared_model(monkeypatch, tmp_path):
    """Two threads enter the REAL transcribe()/align() on shared model objects at once. faster-whisper
    and whisperx are not thread-safe, so production `with ML_LOCK:` must serialize them; this drives
    the production code rather than a lock re-implemented in the test body."""
    import threading

    from src.lyrics.aligner import ML_LOCK, WhisperxForcedAligner
    from src.lyrics.asr import WhisperxTranscriber

    # Fail fast on a non-reentrant lock: the nested transcribe()->_load() / align()->_model()
    # acquisition below would otherwise DEADLOCK the drive with no verdict.
    with ML_LOCK:
        got = ML_LOCK.acquire(timeout=1.0)
        if got:
            ML_LOCK.release()
    assert got, "ML_LOCK is not reentrant — transcribe()/align() would deadlock on the lazy loader"

    inside = []
    overlaps = []
    gate = threading.Lock()

    def on_call():
        with gate:
            inside.append(1)
            overlaps.append(len(inside))
        time.sleep(0.05)
        with gate:
            inside.pop()

    _stub_whisperx(monkeypatch, on_call=on_call)
    audio = str(tmp_path / "vocals.wav")

    tr = WhisperxTranscriber(device="cpu")
    al = WhisperxForcedAligner(device="cpu")
    segs = [{"start": 0.0, "end": 1.0, "text": "x"}]

    targets = [lambda: tr.transcribe(audio) for _ in range(2)] + [
        lambda: al.align(segs, audio, "en") for _ in range(2)
    ]
    threads = [threading.Thread(target=t) for t in targets]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert overlaps, "no ML call ran — production path never executed"
    assert max(overlaps) == 1, f"ML section was entered concurrently ({max(overlaps)} at once)"
    # all four threads must have run the production ML path.
    assert len(overlaps) == 4, f"expected 4 ML entries (2 transcribe + 2 align), got {len(overlaps)}"


def test_the_ml_lock_is_reentrant_so_a_public_call_can_use_the_lazy_loader(monkeypatch, tmp_path):
    """transcribe() takes ML_LOCK and then calls _load(), which takes it again; align() takes it and
    calls _model(), which takes it again. A plain Lock would deadlock the worker on the first real
    call, so ML_LOCK must be an RLock."""
    from src.lyrics.aligner import ML_LOCK, WhisperxForcedAligner
    from src.lyrics.asr import WhisperxTranscriber

    _stub_whisperx(monkeypatch)
    audio = str(tmp_path / "vocals.wav")

    # Fail fast on a non-reentrant lock instead of deadlocking the suite: hold ML_LOCK once, then try
    # a bounded second acquire. An RLock re-grants it; a plain Lock blocks and acquire() times out.
    with ML_LOCK:
        got = ML_LOCK.acquire(timeout=1.0)
        if got:
            ML_LOCK.release()
    assert got, "ML_LOCK is not reentrant — transcribe()/align() would deadlock on the lazy loader"

    # transcribe() -> _load(): both acquire ML_LOCK; a non-reentrant lock never returns here.
    out = WhisperxTranscriber(device="cpu").transcribe(audio)
    assert out["segments"] == []

    # align() -> _model(): same nested acquisition on the aligner side.
    aligned = WhisperxForcedAligner(device="cpu").align(
        [{"start": 0.0, "end": 1.0, "text": "x"}], audio, "en"
    )
    assert aligned["segments"] == [{"start": 0.0, "end": 1.0, "text": "x"}]


from src.lyrics.grading import (  # noqa: E402
    ROLE_BASELINE,
    ROLE_CANDIDATE,
    SUSPECT_COVERAGE,
    agreement,
    agreement_score,
    composite_score,
    lyrics_tokens,
    select_by_baselines,
)

_SUNG = "we could be heroes just for one day standing by the wall guns above our heads and we kissed"


def _baseline(body, rank=0, variant="whisper/vocals"):
    """A BASELINE text — evidence of what is audible. Roles are explicit now: a fake that forgot to
    declare itself a baseline would be graded as a claim about the words instead of grading them."""
    return LyricsText(
        text_source=SOURCE_ASR,
        timing=TIMING_LINE,
        text_confidence="low",
        role=ROLE_BASELINE,
        baseline_rank=rank,
        variant=variant,
        segments=[{"start": 0.0, "end": 4.0, "text": body}],
    )


def _candidate(body, source=SOURCE_LRCLIB):
    """A CANDIDATE text — an authored claim about the words, scored against the baselines and, if it
    wins, published as the song's words. LyricsText defaults fail-closed (ROLE_UNSPECIFIED), so a
    hand-built fake must set role explicitly or nothing publishes."""
    return LyricsText(
        text_source=source,
        timing=TIMING_LINE,
        text_confidence="high",
        role=ROLE_CANDIDATE,
        segments=[{"start": 0.0, "end": 4.0, "text": body}],
    )


def test_agreement_score_matches_the_TS_semantics():
    # agreement_score/agreement take (candidate, baseline) order. Full parity contract against the
    # shared corpus lives in test_lyrics_agreement.py; this pins the same shapes at the align seam.
    near = "we could be heroes just for one day standing near the wall guns above their heads and we kissed"
    assert agreement_score(_SUNG, near) > 0.7
    other = "never gonna give you up let down run around desert cry say goodbye tell lie hurt"
    # judgement axis is coverage, not the ranking score — assert both are low for a different song.
    assert agreement(_SUNG, other) is not None
    assert agreement(_SUNG, other).coverage < SUSPECT_COVERAGE
    assert agreement_score(_SUNG, other) < 0.25
    # too short to judge → None, not 0: an instrumental must not condemn a correct lookup.
    assert agreement_score("la la la", _SUNG) is None


def test_lyrics_tokens_fold_unicode_form_so_form_variants_match():
    """NFKC folding: text differing only in Unicode FORM must tokenise identically, and the
    all-ASCII path must be byte-for-byte unchanged so the metric's ASCII behaviour is preserved."""
    # composed vs decomposed: "Beyoncé" (e + U+0301 combining acute) vs "Beyoncé" (U+00E9)
    assert lyrics_tokens("Beyonce\u0301") == lyrics_tokens("Beyonc\u00e9")
    # full-width vs half-width Latin: "Ｈｅｌｌｏ" (H e l l o) folds to "hello"
    assert lyrics_tokens("\uff28\uff45\uff4c\uff4c\uff4f") == ["hello"]
    # ligature: "ﬁ" (U+FB01 fi) folds to "fi", so "ﬁnd" == "find"
    assert lyrics_tokens("\ufb01nd") == ["find"]

    # BEHAVIOR-PRESERVING on ASCII: identical output to the plain lowercase+strip on ASCII lyrics.
    ascii_text = "[00:12.50]Hello, World! [Chorus] don't stop the music"
    assert lyrics_tokens(ascii_text) == ["hello", "world", "don't", "stop", "the", "music"]

    # The whole corpus here is ASCII, so a real same-song comparison is unchanged and still scores far
    # above any wrong-song band — proving the fold did not disturb the metric's ASCII behaviour.
    near = "we could be heroes just for one day standing near the wall guns above their heads and we kissed"
    assert agreement_score(_SUNG, near) > 0.7


def test_composite_is_the_MEAN_over_baselines_that_can_speak():
    """One baseline is one opinion; the composite averages independent ones."""
    near = "we could be heroes just for one day standing near the wall guns above their heads and we kissed"
    got = composite_score(_candidate(_SUNG), [_baseline(_SUNG), _baseline(near, rank=1)])
    assert len(got.votes) == 2
    assert got.score == pytest.approx(sum(got.votes) / 2)
    # the composite now also carries the mean baseline COVERAGE — the axis the wrong-song
    # judgement reads — over the same two speaking baselines.
    assert got.coverage is not None


def test_a_baseline_too_thin_to_judge_ABSTAINS_rather_than_voting_zero():
    """The property that makes a weak baseline (YouTube auto-captions on music) safe to include: it
    drops out of the mean instead of dragging it down."""
    got = composite_score(_candidate(_SUNG), [_baseline(_SUNG), _baseline("la la la", rank=2)])
    assert len(got.votes) == 1  # the thin one abstained
    assert got.score == 1.0  # ...and did not dilute the one that spoke
    assert got.coverage == 1.0  # coverage is taken over the same single speaking baseline


def test_no_baseline_at_all_means_UNJUDGED_rather_than_a_zero():
    assert composite_score(_candidate(_SUNG), []) == (None, None, [])


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
    assert bysrc[SOURCE_LRCLIB]["textConfidence"] == "low"  # demoted: no longer authoritative
    # The recorded `agreement` field is the composite RANKING score (winner_score). The DEMOTION itself
    # is judged on baseline coverage now, but a genuinely different song scores near zero on both
    # axes, so the recorded score is well below any wrong-song band.
    assert bysrc[SOURCE_LRCLIB]["agreement"] < SUSPECT_COVERAGE
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


#: Long enough that a THIRD of it still clears MIN_TOKENS_TO_COMPARE; `_SUNG` alone does not. Distinct
#: lines, so coverage is not inflated by a repeated chorus.
_LONG_SUNG = " ".join(
    [
        "we could be heroes just for one day standing by the wall",
        "guns above our heads and we kissed as though nothing could fall",
        "though nothing will keep us together we can beat them for ever",
        "and shame was on the other side oh we can be heroes",
    ]
)


@pytest.mark.asyncio
async def test_the_published_candidate_carries_COVERAGE_beside_the_ranking_score_806(tmp_path):
    """The artifact must publish the axis the wrong-song judgement is DECIDED on (baseline coverage),
    not only `agreement` (the ranking score) — `lyricsRank` thresholds whichever field it finds. The
    two axes are asserted to STRADDLE the threshold: a correct lookup graded against a baseline that
    only heard part of the song (YouTube's ASR suppresses sung vocals) must stay authoritative even
    though its ranking score alone would look like a mismatch.
    """
    third = " ".join(_LONG_SUNG.split()[: len(_LONG_SUNG.split()) // 3])
    lrc = FakeSource(SOURCE_LRCLIB, _candidate(_LONG_SUNG))
    asr = FakeSource(SOURCE_ASR, _baseline(third))
    proc = plans.align_runner(runner=fake_ytdlp_runner(), aligner=FakeAligner(), sources=[lrc, asr])
    done = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0]
    won = {c["textSource"]: c for c in done.artifacts["lyrics"]["candidates"]}[SOURCE_LRCLIB]

    # The worker's own verdict: correct text, kept authoritative.
    assert won["textConfidence"] == "high"
    # RANKING axis, below the threshold by construction — a full text graded against a partial baseline.
    assert won["agreement"] < SUSPECT_COVERAGE
    # COVERAGE axis, the one that decided it, above the threshold.
    assert won["coverage"] > SUSPECT_COVERAGE
    # ...and it is the SAME number the judgement used, not a re-derivation.
    sel = select_by_baselines([_candidate(_LONG_SUNG), _baseline(third)])
    assert sel.winner_suspect is False
    assert won["coverage"] == sel.winner_coverage
    assert won["agreement"] == sel.winner_score


@pytest.mark.asyncio
async def test_a_genuinely_different_song_is_still_condemned_on_coverage_806(tmp_path):
    """SENTINEL for the guard above — so publishing `coverage` cannot be mistaken for defanging the
    wrong-song check. A real mismatch is low on BOTH axes, so it stays condemned and the baseline is
    still published beside it."""
    wrong = "never gonna give you up let down run around desert cry say goodbye tell lie hurt"
    lrc = FakeSource(SOURCE_LRCLIB, _candidate(wrong))
    asr = FakeSource(SOURCE_ASR, _baseline(_LONG_SUNG))
    proc = plans.align_runner(runner=fake_ytdlp_runner(), aligner=FakeAligner(), sources=[lrc, asr])
    done = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0]
    bysrc = {c["textSource"]: c for c in done.artifacts["lyrics"]["candidates"]}
    assert bysrc[SOURCE_LRCLIB]["textConfidence"] == "low"  # demoted
    assert bysrc[SOURCE_LRCLIB]["coverage"] < SUSPECT_COVERAGE  # ...on the coverage axis
    assert SOURCE_ASR in bysrc  # what was actually heard is offered as a real alternative


#: A synced LRC long enough for the fit to MEAN anything: with two or three lines almost any series
#: fits and the verdict is `inconclusive`. Sixteen lines is where a structural difference stops being
#: absorbable by scale alone.
LRC_STARTS = [2 * i + 1 for i in range(16)]
SIXTEEN_LINE_LRC = "\n".join(f"[00:{s:02d}.00]line {i} of the song here" for i, s in enumerate(LRC_STARTS))


class ExtraBridgeAligner:
    """An aligner reporting a recording with TWELVE SECONDS this LRC does not know about.

    A wrong-version LRC is not merely offset or stretched — the fit absorbs both (a legitimate
    remaster). What it cannot absorb is a structural difference: an added instrumental bridge
    displaces every line after it while leaving earlier ones alone, so no single scale+offset fits
    both halves. The shift is monotonic (not alternating), matching a real different-master alignment
    rather than tripping the out-of-order-word guard first.
    """

    def __init__(self, insert_after=8, seconds=12.0):
        self.insert_after = insert_after
        self.seconds = seconds
        self.calls = []

    def align(self, segments, audio_path, language):
        self.calls.append((len(segments), audio_path, language))
        out = []
        for i, s in enumerate(segments):
            shift = self.seconds if i >= self.insert_after else 0.0
            start, end = s["start"] + shift, s["end"] + shift
            toks = s["text"].split()
            span = (end - start) / max(1, len(toks))
            words = [
                {"word": tok, "start": round(start + j * span, 3), "end": round(start + (j + 1) * span, 3)}
                for j, tok in enumerate(toks)
            ]
            out.append({"start": start, "end": end, "text": s["text"], "words": words})
        return {"language": language, "segments": out}


@pytest.mark.asyncio
async def test_an_LRC_whose_timings_do_not_fit_this_recording_is_REPORTED(tmp_path, capsys):
    """An LRC written for another upload of the song is confidently wrong. Published timings still
    come from the aligner, so they are correct for THIS audio; the note warns about the WORDS, since
    an LRC that cannot be fitted to this recording is evidence they belong to another release."""
    proc = plans.align_runner(
        runner=fake_ytdlp_runner(),
        lyrics_client=fake_client(synced=SIXTEEN_LINE_LRC),
        aligner=ExtraBridgeAligner(),
    )
    events = await drain(proc, spec(tmp_path, durationSec=60.0))
    assert [e for e in events if isinstance(e, CompleteResult)], "the process must still COMPLETE"

    out = capsys.readouterr().out
    assert "do NOT fit this recording" in out, out
    assert "may belong to another version" in out


@pytest.mark.asyncio
async def test_a_legitimate_REMASTER_is_not_mistaken_for_the_wrong_version(tmp_path, capsys):
    """A re-release with a longer intro and a slightly different tempo is the SAME words; the fit
    absorbs both (offset and scale) by design. If this warned, every correctly-timed song would carry
    a scary note and the one that matters would get ignored."""

    class RemasterAligner(ExtraBridgeAligner):
        def align(self, segments, audio_path, language):
            stretched = [
                {**s, "start": 1.12 * s["start"] + 4.0, "end": 1.12 * s["end"] + 4.0} for s in segments
            ]
            return ExtraBridgeAligner(insert_after=99).align(stretched, audio_path, language)

    proc = plans.align_runner(
        runner=fake_ytdlp_runner(),
        lyrics_client=fake_client(synced=SIXTEEN_LINE_LRC),
        aligner=RemasterAligner(),
    )
    await drain(proc, spec(tmp_path, durationSec=60.0))
    out = capsys.readouterr().out
    assert "do NOT fit this recording" not in out, out


def _ctx_forced(monkeypatch, mode=None):
    """Minimal ctx stub for _time_one.

    Defaults to forced sync mode (so the aligner branch runs); pass ``mode=SyncMode.LINES``
    to drive the lines-only branch instead.
    """
    from types import SimpleNamespace

    from src.vocabulary import SyncMode

    return SimpleNamespace(engines=SimpleNamespace(sync_mode=mode or SyncMode.FORCED))


def test_time_one_feeds_align_windows_to_the_aligner_and_line_sync_keeps_source_timings(monkeypatch):
    from src.lyrics.grading import SOURCE_LRCLIB, TIMING_LINE, LyricsText
    from src.steps import lyrics as steps_lyrics

    # An authoritative line-timed text with ONE human line at [10, 34] plus bounded windows the
    # presplit step would have produced for the aligner to search.
    text = LyricsText(
        text_source=SOURCE_LRCLIB,
        segments=[
            {"start": 10.0, "end": 34.0, "text": "a very long human authored karaoke lyric line", "words": []}
        ],
        timing=TIMING_LINE,
        text_confidence="high",
        align_windows=[
            {"start": 10.0, "end": 22.0, "text": "a very long human", "words": []},
            {"start": 22.0, "end": 34.0, "text": "authored karaoke lyric line", "words": []},
        ],
    )

    # 1. On a successful align, the aligner is handed the WINDOWS (2), not the single source segment.
    ok = FakeAligner()
    doc, timing, conf = steps_lyrics._time_one(
        ok, _ctx_forced(monkeypatch), text, audio="/x.wav", language="en"
    )
    assert ok.calls and ok.calls[0][0] == 2  # searched the two bounded windows, not one whole line
    # pin WHICH windows by value (not just the count), or a mutated timestamp could ship a
    # 24-second line crushed into one second while calls[0][0] == 2 stays green.
    assert ok.searched[0] == [
        (10.0, 22.0, "a very long human"),
        (22.0, 34.0, "authored karaoke lyric line"),
    ]
    assert timing == TIMING_WORD

    # On aligner FAILURE, line-sync fallback publishes the SOURCE's own segments, not the windows.
    fail = FakeAligner(fail=True)
    doc2, timing2, conf2 = steps_lyrics._time_one(
        fail, _ctx_forced(monkeypatch), text, audio="/x.wav", language="en"
    )
    assert timing2 == TIMING_LINE and conf2 == "high"
    assert [ln["start"] for ln in doc2["lines"]] == [10.0]
    assert [ln["end"] for ln in doc2["lines"]] == [34.0]


def test_time_one_lines_mode_publishes_source_timings_not_the_aligner_windows(monkeypatch):
    """The LINES sync-mode publish site must ship the source's OWN line timings, never the presplit
    windows: `align_windows` is already populated by the time this branch runs (PresplitTexts runs
    before TimeTexts), so publishing them would leak `_subdivide`'s character-count-derived interior
    boundary as a "high" confidence line timestamp — on the one mode whose whole promise is the
    source's own timings."""
    from src.lyrics.grading import SOURCE_LRCLIB, TIMING_LINE, LyricsText
    from src.steps import lyrics as steps_lyrics
    from src.vocabulary import SyncMode

    # Same authoritative line-timed text: ONE human line at [10, 34], with two bounded windows the
    # presplit step would have produced. The interior 22.0 boundary is a character count, not a real
    # LRC timestamp, so it must NOT reach the published doc.
    text = LyricsText(
        text_source=SOURCE_LRCLIB,
        segments=[
            {"start": 10.0, "end": 34.0, "text": "a very long human authored karaoke lyric line", "words": []}
        ],
        timing=TIMING_LINE,
        text_confidence="high",
        align_windows=[
            {"start": 10.0, "end": 22.0, "text": "a very long human", "words": []},
            {"start": 22.0, "end": 34.0, "text": "authored karaoke lyric line", "words": []},
        ],
    )

    # In LINES mode the aligner is never called; if it is handed anything, this fails loudly.
    never = FakeAligner()
    ctx = _ctx_forced(monkeypatch, mode=SyncMode.LINES)
    doc, timing, conf = steps_lyrics._time_one(never, ctx, text, audio="/x.wav", language="en")

    assert not never.calls  # lines mode skips forced alignment entirely
    assert timing == TIMING_LINE and conf == "high"
    # The published doc carries the source's ONE line at [10, 34] — never the windows' [10, 22,...].
    assert [ln["start"] for ln in doc["lines"]] == [10.0]
    assert [ln["end"] for ln in doc["lines"]] == [34.0]


def test_time_one_forced_path_keeps_dual_script_romanization(monkeypatch):
    """The default forced-align path must carry an LRCLIB record's second script to the doc. The
    aligner re-times the ORIGINAL script and drops the per-line `romanization` the source shipped;
    `_attach_romanizations` (the single call at the end of that branch in steps/lyrics.py) is the
    ONLY thing that puts it back on this path — dual-script survival here is structural, not
    incidental. Uses `FakeAligner`, which emits only start/end/text/words and does not pass the input
    segment through, so this reds if the re-attachment is removed or reordered."""
    from src.lyrics.grading import SOURCE_LRCLIB, TIMING_LINE, LyricsText
    from src.steps import lyrics as steps_lyrics

    # A folded bilingual LRCLIB text: two lines, each the non-Latin script as ``text`` and its Latin
    # romanization twin as ``romanization`` — exactly what ``fold_romanization_entries`` produces.
    text = LyricsText(
        text_source=SOURCE_LRCLIB,
        segments=[
            {
                "start": 10.0,
                "end": 20.0,
                "text": "真情像草原广茂",
                "romanization": "zhen qing xiang cao yuan guang mao",
            },
            {
                "start": 20.0,
                "end": 30.0,
                "text": "雪花飘飘北风萧萧",
                "romanization": "xue hua piao piao bei feng xiao xiao",
            },
        ],
        timing=TIMING_LINE,
        text_confidence="high",
    )

    # Default sync mode is forced, so the aligner branch runs and returns a WORD-timed doc.
    ok = FakeAligner()
    doc, timing, conf = steps_lyrics._time_one(
        ok, _ctx_forced(monkeypatch), text, audio="/x.wav", language="zh"
    )
    assert ok.calls  # the force-align branch actually ran (not a fallback)
    assert timing == TIMING_WORD and conf == "high"

    # THE PIN, by value: both source lines' romanization rode through to the word-timed doc. Deleting
    # or reordering ``_attach_romanizations`` in ``steps/lyrics.py`` makes this ``[None, None]``.
    assert [ln.get("romanization") for ln in doc["lines"]] == [
        "zhen qing xiang cao yuan guang mao",
        "xue hua piao piao bei feng xiao xiao",
    ]


# The romanization pass-through at artifact.py is defensive depth: no TIMING_WORD producer emits a
# segment carrying `romanization`, so the copy never fires in production. Two guards, each pinning
# one half: A) the copy exists at all; B) AsrSource never emits a 5th key that would make it live.
def test_normalize_lyrics_copies_a_segment_romanization_through():
    """Guard A: normalize_lyrics copies a `romanization` off a segment that carries one — a
    word-timed segment with a second script must surface it on the produced line."""
    raw = {
        "language": "zh",
        "segments": [
            {
                "start": 0.0,
                "end": 2.0,
                "text": "雪花飄飄",
                "romanization": "xue hua piao piao",
                "words": [{"word": "雪花飄飄", "start": 0.0, "end": 2.0}],
            }
        ],
    }
    doc = lyrics_pkg.normalize_lyrics(raw)
    assert [ln.get("romanization") for ln in doc["lines"]] == ["xue hua piao piao"]


def test_asr_source_segment_keys_are_exactly_start_end_text_words():
    """Guard B: the ASR (TIMING_WORD) source emits segments with EXACTLY start/end/text/words —
    adding a 5th `romanization` key would make the artifact.py pass-through live for this path."""
    from src.lyrics.grading import LyricsRequest as _LyricsRequest

    t = FakeTranscriber(ASR_RAW)
    got = AsrSource(t, lyrics_pkg.normalize_lyrics).fetch(
        _LyricsRequest(media_id="m1", audio_path="/mix.wav", vocals_path="/vocals.m4a")
    )
    assert got is not None and got.segments
    for seg in got.segments:
        assert set(seg.keys()) == {"start", "end", "text", "words"}


# The aligner at steps/lyrics.py searches `align_windows` (per-row bounded windows) instead of
# `segments` when presplit set them, so `doc` has one aligned line per WINDOW — MORE lines than
# `segments`. The wrong-version fit must be paired against `align_windows` too, or
# `fit_lrc_to_aligned` sees a line-count mismatch and goes `inconclusive`, silently disabling the
# detector on exactly the long-line authoritative LRCs presplit produces windows for.


def _mismatched_windows_text(n_lines=16, bridge_after=8):
    """A synced LRCLIB text whose 16 human lines each split into TWO aligner windows.

    That is the production state presplit leaves on a worker box for an authoritative LRC whose lines
    overflow a TV row: `segments` keeps the human lines, `align_windows` carries the per-row search
    hints (twice as many). Injected directly because the real bounder (KaraokeLyricsProcessor) is
    Dockerfile-only and returns the lines unchanged locally (align_windows would be None).
    """
    segs, windows = [], []
    for i in range(n_lines):
        start = 2.0 * i + 1.0
        end = start + 1.8
        mid = round((start + end) / 2, 3)
        segs.append(
            {"start": start, "end": end, "text": f"human authored karaoke lyric line {i} here", "words": []}
        )
        windows.append({"start": start, "end": mid, "text": f"human authored karaoke {i}", "words": []})
        windows.append({"start": mid, "end": end, "text": f"lyric line here {i}", "words": []})
    return LyricsText(
        text_source=SOURCE_LRCLIB,
        segments=segs,
        timing=TIMING_LINE,
        text_confidence="high",
        align_windows=windows,
    )


class _WindowBridgeAligner:
    """Re-times every WINDOW it is handed, applying a monotonic +12s bridge to the back half.

    Keyed off the source-line index embedded in each window's text (`... {i}`), so both windows of a
    source line move together — the structural (non-linear) difference a scale+offset fit cannot
    absorb, which is what a genuinely different master looks like. Independent of how `line_starts` /
    `fit_lrc_to_aligned` compute, so the test cannot derive its expectation the code's way.
    """

    def __init__(self, seconds=12.0, bridge_after=8):
        self.seconds = seconds
        self.bridge_after = bridge_after
        self.calls = []

    def align(self, segments, audio_path, language):
        self.calls.append((len(segments), audio_path, language))
        out = []
        for s in segments:
            idx = int(s["text"].strip().split()[-1])
            shift = self.seconds if idx >= self.bridge_after else 0.0
            start, end = s["start"] + shift, s["end"] + shift
            toks = s["text"].split()
            span = (end - start) / max(1, len(toks))
            words = [
                {"word": t, "start": round(start + j * span, 3), "end": round(start + (j + 1) * span, 3)}
                for j, t in enumerate(toks)
            ]
            out.append({"start": start, "end": end, "text": s["text"], "words": words})
        return {"language": language, "segments": out}


async def _drive_time_texts(aligner, text, tmp_path):
    from src.runtime.ctx import AudioCtx, Ctx, LyricsCtx
    from src.steps.lyrics import TimeTexts

    ctx = Ctx(
        job=JobSpec(
            job_id="j",
            media_id="m1",
            job_type="align",
            source_uri="/x.wav",
            params={"language": "en"},
            media_dir=str(tmp_path),
        ),
        work=str(tmp_path),
        audio=AudioCtx(path="/x.wav", vocals_path="/vocals.wav", duration_sec=60.0),
        lyrics=LyricsCtx(texts=[text]),
    )
    async for _ in TimeTexts(aligner=aligner).run(ctx):
        pass
    return ctx


@pytest.mark.asyncio
async def test_217_wrong_version_check_still_runs_when_align_windows_split_the_lines(tmp_path):
    """With `align_windows` set (more lines than `segments`), the aligned `doc` has one line per
    window; the fit must be paired against `align_windows`, not `segments`, or the unequal counts
    make it `inconclusive` and the "do NOT fit" note never fires."""
    text = _mismatched_windows_text()
    # what the aligner searched (windows) outnumbers the human lines.
    assert len(text.align_windows) != len(text.segments)

    aligner = _WindowBridgeAligner()
    ctx = await _drive_time_texts(aligner, text, tmp_path)

    assert aligner.calls and aligner.calls[0][0] == len(text.align_windows)
    assert any("do NOT fit this recording" in n for n in ctx.out.notes), ctx.out.notes
    assert any("may belong to another version" in n for n in ctx.out.notes)


@pytest.mark.asyncio
async def test_217_a_matching_recording_with_split_windows_is_NOT_flagged(tmp_path):
    """The false positive that would matter more than the miss: when `align_windows` are set but the
    recording MATCHES (no bridge), the fit runs and stays `same_version`, so no wrong-version note. This
    also proves the fix did not turn the detector into an indiscriminate warner on the windows path.
    """
    text = _mismatched_windows_text()
    aligner = _WindowBridgeAligner(bridge_after=999)  # never shifts → same recording
    ctx = await _drive_time_texts(aligner, text, tmp_path)
    assert not any("do NOT fit this recording" in n for n in ctx.out.notes), ctx.out.notes
    # A same_version fit that ran surfaces its diagnostic (offset, scale) in a note; published
    # timings stay the aligner's — the note is diagnostic only.
    assert any(
        "matches this recording" in n and "fitted offset" in n and "diagnostic only" in n
        for n in ctx.out.notes
    ), ctx.out.notes


# When validate_timing reports an out-of-order word (usable == False), the worker must NOT publish
# word timing: it degrades to line sync at (line, low) with a REFUSING note. A word-only ASR source
# (no line timings to fall back to) must be DROPPED instead of line-synced.


class _OneBackwardsWordAligner:
    """Force-aligner stand-in that re-times every line normally, then makes EXACTLY ONE word start
    before the previous word ended — a single order violation across a line boundary, well past
    validate.py's 1e-6 threshold. Every other word stays in order."""

    def __init__(self):
        self.calls = []

    def align(self, segments, audio_path, language):
        self.calls.append((len(segments), audio_path, language))
        out = []
        for s in segments:
            toks = s["text"].split()
            span = (s["end"] - s["start"]) / max(1, len(toks))
            words = [
                {
                    "word": t,
                    "start": round(s["start"] + i * span, 3),
                    "end": round(s["start"] + (i + 1) * span, 3),
                }
                for i, t in enumerate(toks)
            ]
            out.append({"start": s["start"], "end": s["end"], "text": s["text"], "words": words})
        # Inject a single backward jump across the boundary between the first two aligned lines.
        if len(out) >= 2 and out[0]["words"] and out[1]["words"]:
            overlap_end = out[0]["words"][-1]["end"] + 1.0
            out[0]["words"][-1]["end"] = round(overlap_end, 3)
            out[1]["words"][0]["start"] = round(overlap_end - 1.0, 3)  # < previous end by 1.0s
        return {"language": language, "segments": out}


def _six_line_synced_text():
    """A synced LRCLIB text (its OWN line timings) with six lines — the branch that CAN degrade to line
    sync, because `text.timing == TIMING_LINE`. Six lines gives the aligner two lines to overlap and
    keeps the doc large enough that a single out-of-order word is the only defect."""
    lines = [
        "we could be heroes just for one day",
        "standing by the wall over our heads",
        "and the guns shot above our heads",
        "and we kissed as though nothing could fall",
        "and the shame was on the other side",
        "we could beat them just for one day",
    ]
    segs = [
        {"start": 4.0 * i + 1.0, "end": 4.0 * i + 3.5, "text": t, "words": []} for i, t in enumerate(lines)
    ]
    return LyricsText(text_source=SOURCE_LRCLIB, segments=segs, timing=TIMING_LINE, text_confidence="high")


def _asr_word_source():
    """A word-timed ASR source (`timing == TIMING_WORD`). This is the M4 branch: it has no line timings
    of its own, so when its word timing is refused there is `nothing honest left to publish` and it must
    be DROPPED, not line-synced."""
    segs = [
        {"start": 4.0 * i + 1.0, "end": 4.0 * i + 3.5, "text": t, "words": []}
        for i, t in enumerate(["oh baby baby how was i", "supposed to know that something"])
    ]
    return LyricsText(text_source=SOURCE_ASR, segments=segs, timing=TIMING_WORD, text_confidence="low")


@pytest.mark.asyncio
async def test_326_unusable_word_timing_is_REFUSED_and_degraded_to_line_low(tmp_path):
    """An LRCLIB source force-aligned to a doc with one out-of-order word is UNUSABLE: it must degrade
    to the source's own line sync at (line, low) — LOW so breaksTie in src/lib/contract/lyrics/lyrics.ts
    cannot let a refused alignment outrank a genuinely good line-sync candidate."""
    text = _six_line_synced_text()
    aligner = _OneBackwardsWordAligner()
    ctx = await _drive_time_texts(aligner, text, tmp_path)

    cands = ctx.out.artifacts["lyrics"]["candidates"]
    assert len(cands) == 1, cands
    cand = cands[0]
    assert (cand["timing"], cand["timingConfidence"]) == (TIMING_LINE, "low")
    ref = tmp_path / cand["ref"]
    doc = json.loads(ref.read_text())
    assert [w for ln in doc["lines"] for w in (ln.get("words") or [])] == [], doc
    assert any("REFUSING word timing" in n for n in ctx.out.notes), ctx.out.notes


@pytest.mark.asyncio
async def test_326_a_word_only_ASR_source_with_unusable_timing_is_DROPPED_not_line_synced(tmp_path):
    """An ASR source has no line timings of its own, so when its word timing is refused there is
    nothing honest to fall back to: it must be DROPPED, not line-synced over text that never had line
    timings. With this the only source, the step raises "nothing could be timed"."""
    text = _asr_word_source()
    aligner = _OneBackwardsWordAligner()
    with pytest.raises(RuntimeError, match="nothing could be timed"):
        await _drive_time_texts(aligner, text, tmp_path)


# Only the OPENING window of each human line carries the source's own timestamp; `_subdivide`
# (presplit.py) spreads every interior window start PROPORTIONALLY TO CHARACTER COUNT across a span
# ending at the next line's start, which can land deep in an instrumental rest while a faithful
# aligner re-times words where they are actually SUNG (early). Pairing the wrong-version fit against
# those interior guesses reads that gap as a residual and misreports "alignment slipped" on a
# correctly aligned song, so the fit must pair against OPENING windows only (real human starts).
#
# Every test here injects an aligner that RE-TIMES words inside each window rather than echoing the
# window bounds — an echoing aligner makes interior residuals zero by construction and cannot see
# this defect. Windows are built by the real `bound_blob_text` / `_subdivide`.

_CHARS_PER_SEC_336 = 12.0


def _bound_only_336(lines, max_chars):
    """Length-only bounder stand-in for the Dockerfile-only KaraokeLyricsProcessor (see
    tests/test_lyrics_presplit.py:bound_only): bisect any over-long line at a word boundary, greedily.
    Feeding it to the real `bound_blob_text` yields production `align_windows` via the real
    `_subdivide` on a dev box where the real bounder returns lines unchanged."""
    out = []
    for line in lines:
        while len(line) > max_chars:
            cut = line.rfind(" ", 0, max_chars + 1)
            if cut <= 0:
                break
            out.append(line[:cut])
            line = line[cut + 1 :]
        out.append(line)
    return out


def _instrumental_break_text_336(n_lines=10):
    """A synced LRCLIB record with alternating short/overflowing lines; every OVERFLOWING line is
    followed by an 18s rest (an instrumental break) because `lrclib.py` sets each line's end to the
    NEXT line's start. Built through the REAL `bound_blob_text` + `_subdivide`, so `align_windows`
    carries production-computed interior guesses (a char-count fraction of the whole 18s span, which
    lands deep inside the rest — not where the words are sung)."""
    from src.lyrics.presplit import bound_blob_text

    segs, t = [], 0.0
    for i in range(n_lines):
        overflow = i % 2 == 1
        if overflow:
            txt = f"a very long human authored karaoke lyric line that overflows a tv row number {i} here"
            span = 18.0  # words sung early, then a long instrumental rest to the next line
        else:
            txt = f"short line {i}"
            span = 3.0
        segs.append({"start": round(t, 3), "end": round(t + span, 3), "text": txt, "words": []})
        t += span
    text = LyricsText(text_source=SOURCE_LRCLIB, segments=segs, timing=TIMING_LINE, text_confidence="high")
    bt = bound_blob_text(text, max_chars=42, bounder=_bound_only_336)
    assert bt.align_windows is not None and len(bt.align_windows) > len(bt.segments), (
        "fixture must produce interior windows (more windows than human lines)"
    )
    return bt


class _SungWordsAligner:
    """A FAITHFUL aligner: it re-times every window's words to where they are actually SUNG, ignoring
    the window's own `_subdivide`-guessed start. An OPENING window's re-timed start equals the human
    line start; an INTERIOR window's re-timed start is right after the opening's words, far EARLIER
    than `_subdivide`'s guess when a rest follows. `bridge` shifts the back half to simulate a
    different master."""

    def __init__(self, human_starts, bridge=0.0, bridge_after=10**9):
        self.human_starts = list(human_starts)
        self.bridge = bridge
        self.bridge_after = bridge_after
        self.calls = []

    def align(self, segments, audio_path, language):
        self.calls.append((len(segments), audio_path, language))
        out = []
        li = -1
        cursor = 0.0
        for w in segments:
            ws = w["start"]
            # An opening window's start matches the next human line start; reset the sung cursor there.
            if li + 1 < len(self.human_starts) and abs(ws - self.human_starts[li + 1]) < 1e-6:
                li += 1
                cursor = self.human_starts[li]
            shift = self.bridge if li >= self.bridge_after else 0.0
            dur = len(w["text"]) / _CHARS_PER_SEC_336
            st = cursor + shift
            cursor += dur
            out.append(
                {
                    "start": round(st, 3),
                    "end": round(st + dur, 3),
                    "text": w["text"],
                    "words": [{"word": "w", "start": round(st, 3), "end": round(st + dur, 3)}],
                }
            )
        return {"language": language, "segments": out}


@pytest.mark.asyncio
async def test_336_correctly_aligned_song_with_instrumental_breaks_is_NOT_flagged(tmp_path):
    """A same-version, perfectly aligned recording with instrumental breaks must NOT report that
    alignment slipped, even though interior `_subdivide` guesses sit deep in each break while the
    words are sung early."""
    text = _instrumental_break_text_336()
    human_starts = [s["start"] for s in text.segments]

    aligner = _SungWordsAligner(human_starts, bridge=0.0)  # perfect same-version alignment
    ctx = await _drive_time_texts(aligner, text, tmp_path)

    assert aligner.calls and aligner.calls[0][0] == len(text.align_windows)
    # interior windows exist whose _subdivide start differs from where the words are sung.
    assert len(text.align_windows) > len(text.segments)
    assert not any("alignment slipped" in n for n in ctx.out.notes), ctx.out.notes
    assert not any("do NOT fit this recording" in n for n in ctx.out.notes), ctx.out.notes


@pytest.mark.asyncio
async def test_336_wrong_version_is_still_detected_after_openings_only_pairing(tmp_path):
    """The property the openings-only pairing must PRESERVE: a genuinely different master (every line
    in the back half shifted) is still reported as the wrong version. Pairing only the opening windows
    removes the false positive without blinding the detector — the openings are real, independent
    timestamps over the human lines, which is all the version test ever needed."""
    text = _instrumental_break_text_336()
    human_starts = [s["start"] for s in text.segments]

    # Shift the whole back half by 15s: a structural, non-linear difference a scale+offset fit cannot
    # absorb — what a different release looks like.
    aligner = _SungWordsAligner(human_starts, bridge=15.0, bridge_after=len(human_starts) // 2)
    ctx = await _drive_time_texts(aligner, text, tmp_path)

    assert any("do NOT fit this recording" in n for n in ctx.out.notes), ctx.out.notes
    assert any("may belong to another version" in n for n in ctx.out.notes)


# normalize_lyrics DROPS a segment with neither timed words nor bounds (artifact.py); pairing the fit
# by align-window INDEX into normalize_lyrics(doc) does not survive that drop — every later
# positional pairing shifts. The fit must pair by the line's own TEXT (a stable key both _subdivide
# and normalize_lyrics keep verbatim) so a dropped line is left out of both series together.


class _DroppingAligner:
    """Faithful re-timing (delegates to _SungWordsAligner) that then blanks chosen OPENING windows into
    the normalize_lyrics-drop shape (no start/end, a NaN-timed word). `drop_openings` is a set of
    0-based OPENING-line ordinals (0 = first human line's opening window, etc.)."""

    def __init__(self, human_starts, drop_openings, bridge=0.0, bridge_after=10**9):
        self._inner = _SungWordsAligner(human_starts, bridge=bridge, bridge_after=bridge_after)
        self.human_starts = list(human_starts)
        self.drop_openings = set(drop_openings)
        self.calls = self._inner.calls

    def align(self, segments, audio_path, language):
        res = self._inner.align(segments, audio_path, language)
        # Walk the INPUT windows to find opening entries (start == a human start), in order; blank
        # the requested opening ordinals into the drop shape.
        opening_ordinal = -1
        for i, w in enumerate(segments):
            ws = w.get("start")
            is_opening = (
                any(abs(float(ws) - hs) < 1e-6 for hs in self.human_starts)
                if isinstance(ws, (int, float))
                else False
            )
            if not is_opening:
                continue
            opening_ordinal += 1
            if opening_ordinal in self.drop_openings:
                res["segments"][i] = {
                    "start": None,
                    "end": None,
                    "text": w["text"],
                    "words": [{"word": "w", "start": float("nan"), "end": 1.0}],
                }
        return res


@pytest.mark.asyncio
async def test_410_one_dropped_aligned_line_does_NOT_make_a_correct_song_read_as_slipped(tmp_path):
    """Same fixture as above, correctly aligned, but the aligner drops ONE opening window into the
    normalize_lyrics-drop shape — one fewer line than `align_windows`. Text-keyed pairing leaves the
    dropped line out of both series and the survivors still pair correctly, so no slippage note."""
    text = _instrumental_break_text_336()
    human_starts = [s["start"] for s in text.segments]

    # Drop the SECOND opening line (ordinal 1) — a mid-song drop, so it shifts the tail of the pairing.
    aligner = _DroppingAligner(human_starts, drop_openings={1}, bridge=0.0)
    ctx = await _drive_time_texts(aligner, text, tmp_path)

    assert aligner.calls and aligner.calls[0][0] == len(text.align_windows)
    assert len(text.align_windows) > len(text.segments)
    assert not any("alignment slipped" in n for n in ctx.out.notes), ctx.out.notes
    assert not any("do NOT fit this recording" in n for n in ctx.out.notes), ctx.out.notes


@pytest.mark.asyncio
async def test_410_wrong_master_is_still_detected_when_two_lines_drop(tmp_path):
    """With TWO opening lines dropped, an index-based pairing would go count-unequal ->
    `inconclusive`, silently missing a genuinely different master. Text-keyed pairing keeps the
    surviving openings paired correctly, so the +15s back-half master is still reported."""
    text = _instrumental_break_text_336()
    human_starts = [s["start"] for s in text.segments]

    aligner = _DroppingAligner(
        human_starts, drop_openings={0, 2}, bridge=15.0, bridge_after=len(human_starts) // 2
    )
    ctx = await _drive_time_texts(aligner, text, tmp_path)

    assert any("do NOT fit this recording" in n for n in ctx.out.notes), ctx.out.notes
    assert any("may belong to another version" in n for n in ctx.out.notes)


def _plain_synced_text(n_lines=16, spacing=2.0):
    """A synced LRCLIB text with NO align_windows: segments are the human lines; presplit set no
    windows. This is the common production shape the no-windows fit branch runs for."""
    segs = [
        {
            "start": spacing * i + 1.0,
            "end": spacing * i + 2.6,
            "text": f"line {i} of the song here",
            "words": [],
        }
        for i in range(n_lines)
    ]
    return LyricsText(
        text_source=SOURCE_LRCLIB,
        segments=segs,
        timing=TIMING_LINE,
        text_confidence="high",
        align_windows=None,
    )


class _PlainDroppingAligner:
    """One aligned line per input segment (the no-windows shape), keyed off each segment index in its
    trailing text so it is independent of line_starts / fit_lrc_to_aligned. bridge shifts every line at
    or after bridge_after (a different master). Segments whose index is in drop are emitted in the
    normalize_lyrics-DROP shape (no start/end, a NaN word), which normalize_lyrics then removes."""

    def __init__(self, drop=frozenset(), bridge=0.0, bridge_after=10**9):
        self.drop = set(drop)
        self.bridge = bridge
        self.bridge_after = bridge_after
        self.calls = []

    def align(self, segments, audio_path, language):
        self.calls.append((len(segments), audio_path, language))
        out = []
        for i, s in enumerate(segments):
            if i in self.drop:
                out.append(
                    {
                        "start": None,
                        "end": None,
                        "text": s["text"],
                        "words": [{"word": "w", "start": float("nan"), "end": 1.0}],
                    }
                )
                continue
            shift = self.bridge if i >= self.bridge_after else 0.0
            start, end = s["start"] + shift, s["end"] + shift
            toks = s["text"].split()
            span = (end - start) / max(1, len(toks))
            words = [
                {"word": t, "start": round(start + j * span, 3), "end": round(start + (j + 1) * span, 3)}
                for j, t in enumerate(toks)
            ]
            out.append({"start": start, "end": end, "text": s["text"], "words": words})
        return {"language": language, "segments": out}


@pytest.mark.asyncio
async def test_534_F2_wrong_master_still_detected_on_the_no_align_windows_path_after_a_drop(tmp_path):
    """align_windows absent (the common branch), master structurally different (+15s back half),
    aligner DROPS one mid-song line into the normalize_lyrics-drop shape. Pairing on raw line counts
    would go unequal -> inconclusive and miss the wrong master; text-keyed pairing tolerates the drop
    and still reports it."""
    text = _plain_synced_text()
    assert text.align_windows is None
    aligner = _PlainDroppingAligner(drop={4}, bridge=15.0, bridge_after=8)
    ctx = await _drive_time_texts(aligner, text, tmp_path)

    assert aligner.calls and aligner.calls[0][0] == len(text.segments)
    assert any("do NOT fit this recording" in n for n in ctx.out.notes), ctx.out.notes
    assert any("may belong to another version" in n for n in ctx.out.notes)
    assert not any("matches this recording" in n for n in ctx.out.notes), ctx.out.notes


@pytest.mark.asyncio
async def test_534_F1_an_inconclusive_fit_does_NOT_report_a_match(tmp_path):
    """A TWO-line synced LRC: fit_lrc_to_aligned needs >= 3 lines, so it returns early with verdict
    `inconclusive` and defaults (offset 0.0, scale 1.0). The affirmative note must gate on
    `fit.verdict == same_version`, not merely on `fit.pairs`, or an inconclusive fit fabricates a
    positive match."""
    text = _plain_synced_text(n_lines=2)
    assert text.align_windows is None
    aligner = _PlainDroppingAligner()
    ctx = await _drive_time_texts(aligner, text, tmp_path)

    assert aligner.calls and aligner.calls[0][0] == 2
    assert not any("matches this recording" in n for n in ctx.out.notes), ctx.out.notes
    assert not any("do NOT fit this recording" in n for n in ctx.out.notes), ctx.out.notes


# Re-deriving opening-window indices by float-equality (_opening_window_indices) strands every line
# after one start that fails to match to 1e-6 — a latent trap the moment a producer stops rounding to
# 3 dp. presplit emits the exact segment->window map as `align_window_opens`; `_opens_for` must prefer
# it and fall back to re-derivation only when the map is absent.


def test_459_opens_for_prefers_the_emitted_map_and_is_immune_to_a_perturbed_start():
    from src.steps.lyrics import _opening_window_indices, _opens_for

    text = _instrumental_break_text_336()
    assert text.align_window_opens is not None and len(text.align_window_opens) == len(text.segments)

    # Perturb the SECOND line's opening-window start by 2e-6 — invisible to the emitted map, but enough
    # to defeat the float-equality re-derivation.
    windows = [dict(w) for w in text.align_windows]
    op1 = text.align_window_opens[1]
    windows[op1] = {**windows[op1], "start": windows[op1]["start"] + 2e-6}
    from dataclasses import replace as _dc_replace

    perturbed = _dc_replace(text, align_windows=windows)

    # Ground truth: float-equality re-derivation strands (fewer than one index per segment) under
    # this perturbation.
    stranded = _opening_window_indices(perturbed.align_windows, perturbed.segments)
    assert len(stranded) < len(perturbed.segments), (
        "the re-derivation must strand under a 2e-6 perturbation for this test to bite"
    )

    # The consumer must return the EMITTED map, one exact index per human segment, unaffected by the
    # perturbed start.
    got = _opens_for(perturbed)
    assert got == perturbed.align_window_opens == list(text.align_window_opens)
    assert len(got) == len(perturbed.segments)


def test_459_opens_for_falls_back_to_rederivation_for_a_hand_built_text_without_the_map():
    # A hand-built LyricsText may set align_windows without the emitted opens map; the consumer must
    # still work by re-deriving.
    from src.steps.lyrics import _opening_window_indices, _opens_for

    text = _instrumental_break_text_336()
    from dataclasses import replace as _dc_replace

    no_map = _dc_replace(text, align_window_opens=None)
    assert _opens_for(no_map) == _opening_window_indices(no_map.align_windows, no_map.segments)


def test_459_TimeTexts_run_uses_opens_for_at_the_call_site_not_inline_rederivation():
    # TimeTexts.run must CALL _opens_for and must NOT call _opening_window_indices directly — that
    # bypass would silently put the version fit back on the float-equality path that strands lines.
    import ast
    from pathlib import Path

    # TimeTexts and its phase helpers live in the `align` submodule, not the lyrics package __init__.
    from src.steps.lyrics import align as _lyr

    tree = ast.parse(Path(_lyr.__file__).read_text(encoding="utf-8"))
    run_fn = None
    for cls in ast.walk(tree):
        if isinstance(cls, ast.ClassDef) and cls.name == "TimeTexts":
            for n in ast.walk(cls):
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == "run":
                    run_fn = n
                    break
    assert run_fn is not None, "TimeTexts.run not found"

    # Follow the delegation from `run` rather than pinning one function body: the invariant is that
    # the STEP layer makes this choice, not the lyrics domain, so helpers `run` calls count too but
    # the whole module does not (that would pass on a call from anywhere).
    module_fns = {n.name: n for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    # Do NOT descend into `_opens_for` — it legitimately calls _opening_window_indices as its own
    # fallback, which would falsely fail the second assertion below on correct code.
    opaque = {"_opens_for"}
    reachable = [run_fn]
    seen: set[str] = set()
    frontier = [run_fn]
    while frontier:
        fn = frontier.pop()
        for n in ast.walk(fn):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in module_fns:
                if n.func.id not in seen and n.func.id not in opaque:
                    seen.add(n.func.id)
                    reachable.append(module_fns[n.func.id])
                    frontier.append(module_fns[n.func.id])

    names: set[str] = set()
    for fn in reachable:
        for n in ast.walk(fn):
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name):
                names.add(n.func.id)

    assert "_opens_for" in names, (
        "TimeTexts does not call _opens_for — the consumer is not using the emitted "
        "align_window_opens map; the version fit would re-derive by float-equality and strand lines"
    )
    assert "_opening_window_indices" not in names, (
        "TimeTexts calls _opening_window_indices DIRECTLY — that is the base behaviour that ignores "
        "the emitted opens map. The re-derivation must live behind _opens_for's fallback only"
    )


@pytest.mark.asyncio
async def test_the_variant_pick_provenance_reaches_ctx_out_selection_and_the_CompleteResult_669(tmp_path):
    """The align job must carry WHY the lyric won, not just which one, all the way to the
    CompleteResult, so the core can persist it to the durable audit trail: TimeTexts writes
    ctx.out.selection from the Selection report, and the runner carries it onto the CompleteResult."""
    from dataclasses import replace as _replace

    from src.lyrics.grading import LyricsText

    right = _candidate(_SUNG)
    wrong_body = "never gonna give you up let down run around desert cry say goodbye tell lie hurt now"
    worse = LyricsText(
        text_source=SOURCE_LRCLIB,
        timing=TIMING_LINE,
        text_confidence="high",
        role=ROLE_CANDIDATE,
        variant="lrclib-alt",
        segments=[{"start": 0.0, "end": 4.0, "text": wrong_body}],
    )
    cand = _replace(right, variant="lrclib-main", alternates=[worse])
    asr = FakeSource(SOURCE_ASR, _baseline(_SUNG))
    proc = plans.align_runner(
        runner=fake_ytdlp_runner(), aligner=FakeAligner(), sources=[FakeSource(SOURCE_LRCLIB, cand), asr]
    )
    done = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)][0]

    assert done.selection is not None, "the CompleteResult must carry the selection provenance"
    choices = done.selection["choices"]
    assert len(choices) >= 1
    lrc_choice = next(c for c in choices if c["textSource"] == SOURCE_LRCLIB)
    assert lrc_choice["considered"] == 2  # two versions were weighed
    # The two facts that make a mis-pick diagnosable: what basis decided it, and how many baselines voted.
    assert lrc_choice["decidedBy"] == "agreement"
    assert lrc_choice["votes"] >= 1
    # Every rejected version is retained with its score — the evidence gone today. NOT the bodies.
    assert len(lrc_choice["rejected"]) == 1
    label, sc = lrc_choice["rejected"][0]["label"], lrc_choice["rejected"][0]["score"]
    assert label == "lrclib-alt"
    assert sc is None or isinstance(sc, float)


def test_Selection_to_record_carries_every_rejected_label_and_score_669():
    """The durable record VariantChoice/Selection produce is the same facts summary() logs, as data —
    including the unjudgeable (None) score."""
    from src.lyrics.grading import Selection, VariantChoice

    vc = VariantChoice(
        text_source="lrclib",
        considered=3,
        chosen="lrclib-synced",
        chosen_score=0.94,
        rejected=[("lrclib-plain", 0.61), ("captions-stub", None)],
        decided_by="agreement",
        votes=2,
    )
    rec = Selection(choices=[vc], winner_score=0.94).to_record()
    assert rec is not None
    c = rec["choices"][0]
    assert c["textSource"] == "lrclib" and c["chosen"] == "lrclib-synced"
    assert c["decidedBy"] == "agreement" and c["votes"] == 2
    assert c["rejected"] == [
        {"label": "lrclib-plain", "score": 0.61},
        {"label": "captions-stub", "score": None},
    ]
    # No choices → nothing to explain → None, not an empty shell.
    assert Selection().to_record() is None


def test_Selection_to_record_persists_the_coverage_winnerSuspect_was_decided_on_806():
    """— the record must carry the number the arm actually fired on.

    `winnerSuspect` is thresholded against baseline COVERAGE, so the record must persist COVERAGE
    alongside the RANKING score — persisting only the ranking score would make `/metrics/<mediaId>`
    read as a missed detection on its own numbers, with the value that actually decided it absent.
    """
    from src.lyrics.grading import Selection, VariantChoice

    vc = VariantChoice(
        text_source="lrclib",
        considered=2,
        chosen="lrclib-synced",
        chosen_score=0.2906,
        rejected=[("lrclib-plain", None)],
        decided_by="agreement",
        votes=1,
    )
    sel = Selection(choices=[vc], winner_score=0.2906, winner_coverage=0.9394, winner_suspect=False)
    rec = sel.to_record()
    assert rec is not None
    assert rec["winnerScore"] == sel.winner_score
    assert rec["winnerCoverage"] == sel.winner_coverage
    assert rec["winnerScore"] < SUSPECT_COVERAGE and rec["winnerCoverage"] > SUSPECT_COVERAGE
    assert rec["winnerSuspect"] is False  # consistent with the coverage now shown beside it
    # UNJUDGED stays distinguishable from a decision made on zero.
    assert Selection(choices=[vc]).to_record()["winnerCoverage"] is None


# `keep_raw` threads config -> dial_home -> align_runner -> align_plan -> FetchCaptions. These pin
# each seam of that chain: reverting any hunk stops a FetchCaptions step from carrying the flag.
from src.host.config import WorkerConfig  # noqa: E402
from src.steps.lyrics import FetchCaptions as _FetchCaptions  # noqa: E402


def _fetch_caption_steps(plan):
    return [s for s in plan.steps() if isinstance(s, _FetchCaptions)]


def test_align_plan_threads_keep_raw_into_both_fetch_caption_steps():
    """align_plan(keep_raw=...) sets it on BOTH tiers; default is off. Pins the align_plan body hunk."""
    on = _fetch_caption_steps(plans.align_plan(keep_raw=True))
    assert len(on) == 2, "align plan must have an authored and a machine FetchCaptions step"
    assert all(s.keep_raw is True for s in on), "keep_raw=True must reach both FetchCaptions steps"

    off = _fetch_caption_steps(plans.align_plan())
    assert off and all(s.keep_raw is False for s in off), "default (no keep_raw) must be OFF on both"


def _plan_from_runner(runner):
    # The production align_runner injects plans=lambda job, engines: plan, so _plan_for returns that
    # captured plan for any job. A minimal align job is enough to pull the steps out.
    job = JobSpec(
        job_id="j-kr",
        media_id="m-kr",
        job_type="align",
        source_uri="https://youtube.com/watch?v=kr",
        params={},
        media_dir="/tmp/kr",
    )
    return runner._plan_for(job, runner._resolve_engines(job.params))


def test_align_runner_threads_keep_raw_into_the_plan():
    """align_runner(keep_raw=...) reaches the FetchCaptions steps."""
    on = _fetch_caption_steps(
        _plan_from_runner(plans.align_runner(runner=fake_ytdlp_runner(), keep_raw=True))
    )
    assert on and all(s.keep_raw is True for s in on)

    off = _fetch_caption_steps(_plan_from_runner(plans.align_runner(runner=fake_ytdlp_runner())))
    assert off and all(s.keep_raw is False for s in off)


def test_build_processor_wires_config_keep_raw_captions_to_the_align_steps():
    """_build_processor hands cfg.keep_raw_captions to align_runner: the operator's
    ENCORE_KEEP_RAW_CAPTIONS setting must survive the whole build, not just the step ctor."""
    import dataclasses

    from src.dial_home import _build_processor

    for flag in (True, False):
        base = WorkerConfig.from_env({"ENCORE_KEEP_RAW_CAPTIONS": "1" if flag else "0"})
        assert base.keep_raw_captions is flag
        # align is only registered when the worker advertises the capability; force it (this is a
        # wiring test, not a capability test).
        cfg = dataclasses.replace(base, capabilities=("align",))
        proc = _build_processor(cfg)
        align = proc._by_type["align"]
        steps = _fetch_caption_steps(_plan_from_runner(align))
        assert steps and all(s.keep_raw is flag for s in steps), (
            f"config keep_raw_captions={flag} must reach the steps"
        )


class _SmearingAligner:
    """Force-aligner stand-in that produces exactly one smeared word and NOTHING else wrong: the
    first word is held for 5.0s (> validate.MAX_WORD_SEC 3.0), but the 6.0s stride between words means
    it still ends before the next word begins, so the doc stays in order (`usable`) and the smear is
    the only defect."""

    STRIDE = 6.0

    def align(self, segments, audio_path, language):
        out = []
        t = 0.0
        first = True
        for s in segments:
            toks = s["text"].split()
            words = []
            for tok in toks:
                start = round(t, 3)
                end = round(start + (5.0 if first else 0.4), 3)
                words.append({"word": tok, "start": start, "end": end})
                first = False
                t += self.STRIDE
            out.append(
                {"start": words[0]["start"], "end": words[-1]["end"], "text": s["text"], "words": words}
            )
        return {"language": language, "segments": out}


@pytest.mark.asyncio
async def test_629_a_smeared_word_is_REPAIRED_on_the_publish_path(tmp_path):
    """A word smeared to 5.0s force-aligns cleanly (in order, so usable), and the PUBLISHED doc must
    carry it clamped to start + MAX_WORD_SEC (3.0) — proving repair_word_spans is reached on the real
    publish path, not only in a unit test of the function."""
    text = _six_line_synced_text()
    ctx = await _drive_time_texts(_SmearingAligner(), text, tmp_path)

    cands = ctx.out.artifacts["lyrics"]["candidates"]
    assert len(cands) == 1, cands
    cand = cands[0]
    assert cand["timing"] == TIMING_WORD  # a usable word doc, not degraded to line sync
    doc = json.loads((tmp_path / cand["ref"]).read_text())
    words = [w for ln in doc["lines"] for w in (ln.get("words") or [])]
    assert words, doc
    first = words[0]
    assert first["end"] == round(first["start"] + 3.0, 3), first
    assert all(w["end"] - w["start"] <= 3.0 + 1e-6 for w in words), words
    assert any("timing repaired" in n for n in ctx.out.notes), ctx.out.notes


class _PackedFlashAligner:
    """Force-aligner stand-in whose ONLY defect is a flash the repair cannot fix. Every word is emitted
    back to back (`word[i].end == word[i+1].start`), which is whisperx's ordinary output shape, and one
    word is held for 20ms (< validate.MIN_WORD_SEC 30ms). Because the next word starts at the flash's
    end, extending it to `start + 0.03` would cross that start, so `repair_word_spans` LEAVES it and
    files it under `flashed_uncorrectable` — it changes nothing at all in the doc. No word exceeds
    MAX_WORD_SEC, so there is no smear anywhere and nothing for the repair to clamp, and starts are
    non-decreasing so the doc is `usable`.
    """

    FLASH_SEC = 0.02
    NORMAL_SEC = 0.4

    def align(self, segments, audio_path, language):
        out = []
        t = 0.0
        flashed = False
        for s in segments:
            words = []
            for tok in s["text"].split():
                dur = self.NORMAL_SEC
                if not flashed:
                    dur, flashed = self.FLASH_SEC, True
                start = round(t, 3)
                end = round(start + dur, 3)
                words.append({"word": tok, "start": start, "end": end})
                t = end  # packed: the next word starts exactly where this one ended
            out.append(
                {"start": words[0]["start"], "end": words[-1]["end"], "text": s["text"], "words": words}
            )
        return {"language": language, "segments": out}


@pytest.mark.asyncio
async def test_773_a_flash_only_doc_is_NOT_logged_as_repaired_but_is_still_reported(tmp_path):
    """`repair_word_spans` declines a flash with no room before the next word, so on a doc whose only
    defect is such a flash the published artifact is byte-identical to what the aligner produced. The
    `timing repaired` note must NOT fire on an untouched doc, but the operator must still be told why
    nothing was fixed."""
    text = _six_line_synced_text()
    aligner = _PackedFlashAligner()
    given: dict[str, list[tuple[str, float, float]]] = {}

    inner = aligner.align

    def _record(segments, audio_path, language):
        res = inner(segments, audio_path, language)
        # snapshot BEFORE the step runs: repair_word_spans mutates the word dicts in place, so a
        # live reference would compare the published doc against itself.
        given["words"] = [(w["word"], w["start"], w["end"]) for seg in res["segments"] for w in seg["words"]]
        return res

    aligner.align = _record
    ctx = await _drive_time_texts(aligner, text, tmp_path)

    cands = ctx.out.artifacts["lyrics"]["candidates"]
    assert len(cands) == 1, cands
    cand = cands[0]
    assert cand["timing"] == TIMING_WORD  # usable: in order, so the repair branch is reached at all
    doc = json.loads((tmp_path / cand["ref"]).read_text())
    published = [(w["word"], w["start"], w["end"]) for ln in doc["lines"] for w in (ln.get("words") or [])]
    assert published, doc
    assert published == given["words"]  # the repair genuinely changed nothing
    assert any(round(e - s, 3) == 0.02 for _, s, e in published), published  # the flash survived
    assert not any(n.startswith("timing repaired") for n in ctx.out.notes), ctx.out.notes
    assert any("NOT repairable" in n for n in ctx.out.notes), ctx.out.notes


@pytest.mark.asyncio
async def test_773_a_repaired_doc_still_logs_timing_repaired(tmp_path):
    """The other direction, so the fix is not "never claim a repair". The smear control is repaired, so
    the past-tense line must still be emitted and the NOT-repairable line must not be."""
    ctx = await _drive_time_texts(_SmearingAligner(), _six_line_synced_text(), tmp_path)
    assert any(n.startswith("timing repaired") for n in ctx.out.notes), ctx.out.notes
    assert not any("NOT repairable" in n for n in ctx.out.notes), ctx.out.notes


async def _drive_time_texts_with_baselines(aligner, texts, tmp_path, duration=60.0, sync_mode=None):
    """Like _drive_time_texts, but seeds the whole texts list (candidate + baselines) so the shift
    estimator has a baseline series to measure against. `sync_mode` overrides the engine's sync mode
    (e.g. SyncMode.LINES to drive the lines-only publish branch through the full run)."""
    from src.runtime.ctx import AudioCtx, Ctx, LyricsCtx, ResolvedEngines
    from src.steps.lyrics import TimeTexts

    engines = ResolvedEngines(sync_mode=sync_mode) if sync_mode is not None else ResolvedEngines()
    ctx = Ctx(
        job=JobSpec(
            job_id="j",
            media_id="m1",
            job_type="align",
            source_uri="/x.wav",
            params={"language": "en"},
            media_dir=str(tmp_path),
        ),
        work=str(tmp_path),
        engines=engines,
        audio=AudioCtx(path="/x.wav", vocals_path="/vocals.wav", duration_sec=duration),
        lyrics=LyricsCtx(texts=texts),
    )
    async for _ in TimeTexts(aligner=aligner).run(ctx):
        pass
    return ctx


_L794 = [
    "white shirt now red my bloody nose",
    "sleeping you're on your tippy toes",
    "creeping around like no one knows",
    "think you're so criminal",
]


def _lrc_candidate_794(base=1.0):
    """A synced LRCLIB candidate whose line starts belong to a master that begins `base`s in."""
    segs = [{"start": base + 3.0 * i, "end": base + 3.0 * i + 2.5, "text": t} for i, t in enumerate(_L794)]
    return LyricsText(
        text_source=SOURCE_LRCLIB,
        segments=segs,
        timing=TIMING_LINE,
        text_confidence="high",
        role=ROLE_CANDIDATE,
    )


def _late_baseline_794(late=2.5):
    """A Whisper baseline that heard the same four lines `late`s LATER than the LRC master says —
    i.e. this upload has a `late`-second quiet/speech pre-section before the vocal."""
    segs = [
        {"start": 1.0 + 3.0 * i + late, "end": 1.0 + 3.0 * i + late + 2.0, "text": t}
        for i, t in enumerate(_L794)
    ]
    return LyricsText(
        text_source=SOURCE_ASR,
        segments=segs,
        timing=TIMING_LINE,
        text_confidence="low",
        role=ROLE_BASELINE,
        baseline_rank=0,
        variant="whisper/vocals",
    )


@pytest.mark.asyncio
async def test_794_lrc_windows_are_placed_onto_this_audio_before_aligning(tmp_path):
    """When the LRC master begins before this upload's vocal (a quiet pre-section) but a baseline
    measured the real lines later, the search window must be shifted onto this audio BEFORE aligning
    — the aligner searches whatever window it is handed, so an unshifted window publishes the first
    word at the LRC's early start and highlighting runs ahead of the song."""
    aligner = FakeAligner()
    ctx = await _drive_time_texts_with_baselines(
        aligner, [_lrc_candidate_794(base=1.0), _late_baseline_794(late=2.5)], tmp_path
    )
    cands = ctx.out.artifacts["lyrics"]["candidates"]
    lrc = [c for c in cands if c["textSource"] == SOURCE_LRCLIB][0]
    assert lrc["timing"] == TIMING_WORD, lrc
    doc = json.loads((tmp_path / lrc["ref"]).read_text())
    first_word_start = doc["lines"][0]["words"][0]["start"]
    assert first_word_start > 3.0, first_word_start
    assert aligner.searched[0][0][0] > 3.0, aligner.searched[0]  # aligner got the SHIFTED window
    assert any("placed onto this audio" in n for n in ctx.out.notes), ctx.out.notes


@pytest.mark.asyncio
async def test_794_placed_lrc_still_reads_as_the_SAME_recording_afterwards(tmp_path):
    """After placing the LRC and aligning on the correct span, the wrong-version check must compare
    the aligner output against the PLACED windows, not the LRC's unshifted starts — otherwise a
    correct placement reads as a +2.50s offset instead of the true ~0.00s agreement."""
    aligner = FakeAligner()
    ctx = await _drive_time_texts_with_baselines(
        aligner, [_lrc_candidate_794(base=1.0), _late_baseline_794(late=2.5)], tmp_path
    )
    # The recording matches (only the intro length differed), so no wrong-version note may fire.
    assert not any("do NOT fit this recording" in n for n in ctx.out.notes), ctx.out.notes
    match_notes = [n for n in ctx.out.notes if "matches this recording" in n and n.startswith("lrclib")]
    assert match_notes, ctx.out.notes
    assert "fitted offset +0.00s" in match_notes[0], match_notes[0]


@pytest.mark.asyncio
async def test_794_a_correctly_placed_song_is_left_untouched(tmp_path):
    """The no-op guard. When the LRC already sits on this audio's timeline (baseline agrees to within
    noise), no shift is applied: the first word publishes at the LRC's own start and no placement note
    fires. This is what keeps the fix from perturbing every LRCLIB song that was already fine."""
    aligner = FakeAligner()
    ctx = await _drive_time_texts_with_baselines(
        aligner, [_lrc_candidate_794(base=1.0), _late_baseline_794(late=0.05)], tmp_path
    )
    cands = ctx.out.artifacts["lyrics"]["candidates"]
    lrc = [c for c in cands if c["textSource"] == SOURCE_LRCLIB][0]
    doc = json.loads((tmp_path / lrc["ref"]).read_text())
    first_word_start = doc["lines"][0]["words"][0]["start"]
    assert abs(first_word_start - 1.0) < 0.3, first_word_start  # unshifted
    assert not any("placed onto this audio" in n for n in ctx.out.notes), ctx.out.notes


@pytest.mark.asyncio
async def test_794_no_baseline_means_no_shift(tmp_path):
    """With no baseline to measure against, the shift estimator abstains: the LRC publishes at its
    own (possibly early) start rather than fabricating a shift."""
    aligner = FakeAligner()
    ctx = await _drive_time_texts_with_baselines(aligner, [_lrc_candidate_794(base=1.0)], tmp_path)
    cands = ctx.out.artifacts["lyrics"]["candidates"]
    lrc = [c for c in cands if c["textSource"] == SOURCE_LRCLIB][0]
    doc = json.loads((tmp_path / lrc["ref"]).read_text())
    assert abs(doc["lines"][0]["words"][0]["start"] - 1.0) < 0.3
    assert not any("placed onto this audio" in n for n in ctx.out.notes), ctx.out.notes


@pytest.mark.asyncio
async def test_794_the_word_timing_REFUSED_degrade_path_also_publishes_placed_starts(tmp_path):
    """When the aligner returns word timings that validate_timing REJECTS (out-of-order word), the
    step degrades to the source's own line sync at (line, low) — that path must also publish PLACED
    starts, or it re-introduces early highlighting even though the aligner itself was placed."""
    aligner = _OneBackwardsWordAligner()
    ctx = await _drive_time_texts_with_baselines(
        aligner, [_lrc_candidate_794(base=1.0), _late_baseline_794(late=2.5)], tmp_path
    )
    cands = ctx.out.artifacts["lyrics"]["candidates"]
    lrc = [c for c in cands if c["textSource"] == SOURCE_LRCLIB][0]
    # It degraded, exactly as the refuse path intends: line sync at the low tier, never word/high.
    assert (lrc["timing"], lrc["timingConfidence"]) == (TIMING_LINE, "low"), lrc
    doc = json.loads((tmp_path / lrc["ref"]).read_text())
    first_line_start = doc["lines"][0]["start"]
    assert first_line_start > 3.0, first_line_start


@pytest.mark.asyncio
async def test_794_LINES_mode_publishes_placed_line_starts(tmp_path):
    """In LINES mode the aligner never runs and the source's own line timings publish directly, so
    they must be placed first or an early-starting master highlights ahead of the vocal."""
    from src.vocabulary import SyncMode

    aligner = FakeAligner()  # never called in LINES mode
    ctx = await _drive_time_texts_with_baselines(
        aligner,
        [_lrc_candidate_794(base=1.0), _late_baseline_794(late=2.5)],
        tmp_path,
        sync_mode=SyncMode.LINES,
    )
    assert not aligner.calls  # lines mode skips forced alignment entirely
    cands = ctx.out.artifacts["lyrics"]["candidates"]
    lrc = [c for c in cands if c["textSource"] == SOURCE_LRCLIB][0]
    assert lrc["timing"] == TIMING_LINE, lrc
    doc = json.loads((tmp_path / lrc["ref"]).read_text())
    assert doc["lines"][0]["start"] > 3.0, doc["lines"][0]["start"]


@pytest.mark.asyncio
async def test_794_aligner_failure_fallback_publishes_placed_line_starts(tmp_path):
    """When forced alignment raises, the code degrades to the source's own line timings — that
    fallback must also publish PLACED starts, or it re-introduces early highlighting."""

    class _Broken:
        def align(self, *a, **k):
            raise RuntimeError("no wav2vec2 model (simulated)")

    ctx = await _drive_time_texts_with_baselines(
        _Broken(), [_lrc_candidate_794(base=1.0), _late_baseline_794(late=2.5)], tmp_path
    )
    cands = ctx.out.artifacts["lyrics"]["candidates"]
    lrc = [c for c in cands if c["textSource"] == SOURCE_LRCLIB][0]
    assert lrc["timing"] == TIMING_LINE, lrc  # degraded to the line-sync floor
    doc = json.loads((tmp_path / lrc["ref"]).read_text())
    assert doc["lines"][0]["start"] > 3.0, doc["lines"][0]["start"]
