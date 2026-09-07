"""The ALIGN plan, end to end.

Was test_whisperx.py, when align was one 257-line method on a WhisperXProcessor. The subject is now eight
declared steps over a typed context (docs/ARCHITECTURE.md §7.1), so the file is named for the
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

from src import lyrics as lyrics_pkg  # noqa: E402
from src import plans  # noqa: E402
from src.lyrics.source import LrclibResult  # noqa: E402
from src.processor import CompleteResult, JobSpec, ProgressEvent  # noqa: E402
from src.runtime import runner as runner_mod  # noqa: E402
from tests.conftest import drain  # noqa: E402


def test_lyrics_key():
    # lyrics_key (the dead single-file key) was removed in #456; candidate_key is the live
    # per-(source,timing,tag) key builder, moved from chain.py to artifact.py in the same change.
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

    # instrumental / None / no-lyrics → empty
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
        # #296: also record the segment VALUES searched, so a test can pin WHICH windows the
        # aligner was handed — not just how many. `calls` keeps its two existing readers (:205, the
        # #92 guard) intact.
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
    # the aligner was fed the KNOWN LRCLIB text (2 lines), not asked to transcribe
    assert aligner.calls and aligner.calls[0][0] == 2 and aligner.calls[0][2] == "en"

    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    uri = completes[0].media_uri
    assert uri.endswith("lyrics/m1-lrclib-word.json")  # per (source, timing) key — candidates coexist
    doc = json.loads(Path(uri).read_text())
    # WORD-timed on the correct text (the whole hybrid point)
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
    # the aligner blows up → we DON'T fail; ship LRCLIB's line-level sync (whole-line highlight)
    proc = plans.align_runner(
        runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=FakeAligner(fail=True)
    )
    events = await drain(proc, spec(tmp_path))
    doc = json.loads(Path([e for e in events if isinstance(e, CompleteResult)][0].media_uri).read_text())
    # line-synced fallback: lines with bounds + text, but NO word timings
    assert [ln["text"] for ln in doc["lines"]] == ["Is this the real life", "Is this just fantasy"]
    assert doc["lines"][0]["start"] == 1.0
    assert all(ln["words"] == [] for ln in doc["lines"])
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
    proc = plans.align_runner(
        runner=fake_ytdlp_runner(), lyrics_client=fake_client(found=False), aligner=FakeAligner()
    )
    await _completes_with_no_lyrics(proc, spec(tmp_path))


@pytest.mark.asyncio
async def test_an_instrumental_COMPLETES_rather_than_being_stuck_forever(tmp_path):
    # The load-bearing case: an instrumental has no lyrics BY NATURE. Failing it would make the song
    # permanently unsingable via the readiness gate.
    proc = plans.align_runner(
        runner=fake_ytdlp_runner(), lyrics_client=fake_client(instrumental=True), aligner=FakeAligner()
    )
    await _completes_with_no_lyrics(proc, spec(tmp_path))


@pytest.mark.asyncio
async def test_missing_params_declines_the_lookup_instead_of_erroring_on_params(tmp_path):
    """Acquisition and timing are separate concerns. Without confident metadata the LRCLIB source
    DECLINES (it never asks for a guessed title); the job then completes with nothing to time. It is not
    an assertion about params, which is what let "no LRCLIB" mean "no lyrics"."""
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


# ── acquisition is SEPARATE from timing ────────────────────────────────
# The bug this closes: stage 2 was hardwired to LrclibClient.get() and raised when it returned
# nothing, so an unreachable LRCLIB meant "no lyrics" rather than "no AUTHORITATIVE lyrics".
from src.lyrics.chain import (  # noqa: E402
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
            # SEQUENCE the words across the line, the way a real aligner does. This used to give every
            # word the LINE's own start/end, which meant word 2 appeared to begin before word 1 had
            # finished — output no real aligner produces (zero order violations across six real
            # artifacts) and which the timing validator correctly refuses as an incoherent highlight.
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
    # role is EXPLICIT (#605): _text models an authored candidate whose role the registry would
    # stamp in production. The LyricsText default is now fail-closed (ROLE_UNSPECIFIED), which a
    # hand-built fake bypassing the registry must override, or it is published by nothing.
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
    once _urllib_fetch converts URLError → LyricsFetchError (#444)."""

    def __init__(self, name, exc):
        self.name = name
        self._exc = exc

    def fetch(self, req):
        raise self._exc


def test_acquire_with_notes_surfaces_a_provider_transport_failure_as_a_loud_note():
    """#444: a source that RAN and RAISED a transport failure (the sinkhole) must produce a visible
    note, not a silent drop that looks like a song with no lyrics. The surviving tier is unaffected."""
    from src.lyrics.source import LyricsFetchError

    lrclib = RaisingSource(
        "lrclib", LyricsFetchError("lrclib unreachable: [Errno -2] Name or service not known")
    )
    asr = FakeSource("asr", _text(SOURCE_ASR, TIMING_WORD))
    texts, notes = acquire_with_notes([lrclib, asr], LyricsRequest(media_id="m1"))

    # the working tier still delivered
    assert len(texts) == 1 and texts[0].text_source == SOURCE_ASR
    # and the dead provider is now legible — not silent
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
    """#444, search branch: a LyricsFetchError from search() (provider down) must escape fetch() so it
    can be noted — not fall through to a None miss. get() here would MISS (None), so if the search
    narrowing were absent this would silently return None instead of raising."""
    from src.lyrics.source import LyricsFetchError

    client = _FakeLrclibClient(
        search=LyricsFetchError("lrclib unreachable: Name or service not known"), get=None
    )
    src = LrclibSource(client=client, to_segments=lambda *_a, **_k: [])
    with pytest.raises(LyricsFetchError):
        src.fetch(LyricsRequest(media_id="m1", artist="a-ha", track="Take On Me"))


def test_lrclib_source_propagates_a_transport_failure_from_GET_fallback():
    """#444, get() branch: when search() legitimately finds nothing ([]), the get() fallback runs; a
    LyricsFetchError there (provider down) must ALSO escape rather than becoming a None miss. Bites the
    get-branch narrowing specifically — search does not raise here."""
    from src.lyrics.source import LyricsFetchError

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
    proc = plans.align_runner(
        runner=fake_ytdlp_runner(), aligner=Broken(), sources=[FakeSource(SOURCE_LRCLIB, untimed)]
    )
    with pytest.raises(RuntimeError, match="nothing could be timed"):
        await drain(proc, spec(tmp_path))


@pytest.mark.asyncio
async def test_aligner_that_PLACES_NO_WORD_degrades_via_the_FAILURE_path_not_validate(tmp_path):
    """#355: the real aligner's second failure shape, which no double in this file models. Every
    aligner double here signals failure by RAISING; whisperx does not — its own docstring at
    lyrics/timing.py:31 names a raise as THE failure signal, while normalize_lyrics' docstring at
    artifact.py:47 says whisperx "leaves some tokens un-timed". When every token is un-timed the
    aligner has returned cleanly yet placed no word, so `is_valid_lyrics(doc)` is False.

    The guard at steps/lyrics.py:497 exists for exactly this: it re-raises so the SAME line-sync
    fallback a real raise takes fires — publishing the source's own line timings at (line, HIGH),
    the tier that says "these are the source's unmodified timings", and emitting NO note (nothing
    went wrong; the aligner just found nothing to place).

    Deleting the guard (`if False:`) does NOT ship a word-tagged wordless doc — the #326 validate
    block below backstops it — but it degrades through the WRONG path: `_time_one` returns
    (word, high), validate finds 0 words and unusable, and degrades to (line, LOW) while emitting a
    "REFUSING word timing (0 out-of-order word(s))" note that is FALSE — there are no out-of-order
    words, the aligner simply placed nothing. So the observable delta the guard owns is (a) the
    confidence tier high→low and (b) a spurious REFUSING note blaming ordering for an empty result.
    Both reproduce with `if False:`; the whole worker suite otherwise stays byte-identical green.

    Drives the honest counterpart of FakeAligner: echoes the caller's segments with empty `words`
    arrays and does NOT raise.
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

    # DEGRADED via the aligner-FAILURE path: the source's own line sync at the HIGH tier, not (line, low).
    assert (cands[0]["timing"], cands[0]["timingConfidence"]) == (TIMING_LINE, "high"), cands[0]

    # No word ever placed, so no note fired: nothing went wrong, the aligner found nothing to time.
    # A REFUSING-for-out-of-order note here would be the wrong-path symptom (0 words, not an ordering
    # fault), so its ABSENCE is what distinguishes the failure path from the validate path.
    assert not any("REFUSING word timing" in n for n in ctx.out.notes), ctx.out.notes

    # The published doc carries the source's own line bounds and ZERO word timings — nothing to
    # highlight, which is exactly why it must not claim the word tier.
    doc = json.loads(Path(os.path.join(str(tmp_path), cands[0]["ref"])).read_text())
    assert lyrics_pkg.is_valid_lyrics(doc) is False
    assert doc["words"] == []
    assert [ln["text"] for ln in doc["lines"]] == ["line one here", "line two here"]
    assert all(ln["words"] == [] for ln in doc["lines"])


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
    and whisperx are not thread-safe, so the production `with ML_LOCK:` must serialize them. Drives the
    production code (not a re-implemented lock in the test body), so it raises NameError on the pre-fix
    tree where the call sites reference the undefined `_ML_LOCK`."""
    import threading

    from src.lyrics.asr import WhisperxTranscriber
    from src.lyrics.timing import ML_LOCK, WhisperxForcedAligner

    # Fail FAST on a non-reentrant lock before the threaded drive: this test also runs the real
    # transcribe()->_load() / align()->_model() nested acquisition, so a plain Lock would DEADLOCK
    # the drive below with no verdict — and this test sits before the dedicated reentrancy test in
    # the file, so without this probe a non-reentrant ML_LOCK wedges the whole suite HERE, one test
    # earlier than that guard (see #180). The bounded nested acquire returns instead of blocking.
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
    # all four threads must have run the production ML path; an aligner-side NameError
    # would kill the two align() threads, leaving only 2 transcribe() entries (see pr-bot #155).
    assert len(overlaps) == 4, f"expected 4 ML entries (2 transcribe + 2 align), got {len(overlaps)}"


def test_the_ml_lock_is_reentrant_so_a_public_call_can_use_the_lazy_loader(monkeypatch, tmp_path):
    """transcribe() takes ML_LOCK and then calls _load(), which takes it again; align() takes it and
    calls _model(), which takes it again. A plain Lock would deadlock the worker on the first real
    call. Drives the production methods so it exercises the real nested acquisition, and raises
    NameError on the pre-fix tree."""
    from src.lyrics.asr import WhisperxTranscriber
    from src.lyrics.timing import ML_LOCK, WhisperxForcedAligner

    _stub_whisperx(monkeypatch)
    audio = str(tmp_path / "vocals.wav")

    # Fail FAST on a non-reentrant lock instead of deadlocking the whole suite: hold ML_LOCK once,
    # then try a bounded second acquire. An RLock re-grants it (got=True); a plain Lock blocks and
    # acquire() returns False at the timeout — so this asserts reentrancy in ~0s rather than wedging
    # the production drive below (which would hang with no failing name, taking every later test
    # file with it — see #180). Runs before the drive so the drive is only reached once proven safe.
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


# ── the wrong-song guard, now graded against BASELINES ─────────────────────────
from src.lyrics.chain import (  # noqa: E402
    ROLE_BASELINE,
    ROLE_CANDIDATE,
    SUSPECT_AGREEMENT,
    agreement_score,
    composite_score,
    lyrics_tokens,
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
    wins, published as the song's words. Role is EXPLICIT (#605): the registry's _Classified.fetch
    stamps it in production; a hand-built fake must declare it too, now that the LyricsText default is
    fail-closed (ROLE_UNSPECIFIED) and an unspecified text is published by nothing."""
    return LyricsText(
        text_source=source,
        timing=TIMING_LINE,
        text_confidence="high",
        role=ROLE_CANDIDATE,
        segments=[{"start": 0.0, "end": 4.0, "text": body}],
    )


def test_agreement_score_matches_the_TS_semantics():
    near = "we could be heroes just for one day standing near the wall guns above their heads and we kissed"
    assert agreement_score(_SUNG, near) > 0.7
    other = "never gonna give you up let down run around desert cry say goodbye tell lie hurt"
    assert agreement_score(_SUNG, other) < SUSPECT_AGREEMENT
    # too short to judge → None, NOT 0: an instrumental must not condemn a correct lookup
    assert agreement_score("la la la", _SUNG) is None


def test_lyrics_tokens_fold_unicode_form_so_form_variants_match():
    """NFKC folding (#540): text differing only in Unicode FORM must tokenise identically, and the
    all-ASCII path must be byte-for-byte unchanged so the calibrated 0.25 threshold is preserved.

    RED ON BASE: before the fold, .lower() left the two forms as distinct codepoints, so these pairs
    produced disjoint token sets. Each assertion below fails on origin/main and passes with the fold.
    """
    # composed vs decomposed: "Beyoncé" (e + U+0301 combining acute) vs "Beyoncé" (U+00E9)
    assert lyrics_tokens("Beyonce\u0301") == lyrics_tokens("Beyonc\u00e9")
    # full-width vs half-width Latin: "Ｈｅｌｌｏ" (H e l l o) folds to "hello"
    assert lyrics_tokens("\uff28\uff45\uff4c\uff4c\uff4f") == ["hello"]
    # ligature: "ﬁ" (U+FB01 fi) folds to "fi", so "ﬁnd" == "find"
    assert lyrics_tokens("\ufb01nd") == ["find"]

    # BEHAVIOR-PRESERVING on ASCII: identical output to the plain lowercase+strip on ASCII lyrics.
    ascii_text = "[00:12.50]Hello, World! [Chorus] don't stop the music"
    assert lyrics_tokens(ascii_text) == ["hello", "world", "don't", "stop", "the", "music"]

    # The whole calibration corpus is ASCII, so a real same-song comparison is unchanged and still
    # scores far above SUSPECT_AGREEMENT (0.25) — proving the fold did not disturb the threshold.
    near = "we could be heroes just for one day standing near the wall guns above their heads and we kissed"
    assert agreement_score(_SUNG, near) > 0.7


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
    assert bysrc[SOURCE_LRCLIB]["textConfidence"] == "low"  # demoted: no longer authoritative
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


# ── is this LRC even for this recording? ──────────────────────────────────────────

#: A synced LRC long enough for the fit to MEAN anything. The fit solves for scale and offset, so with
#: two or three lines almost any series can be fitted and the verdict is `inconclusive` -- which is what
#: the first draft of these tests hit, passing while the detector never ran. Sixteen lines is a normal
#: verse-chorus LRC and is where a structural difference stops being absorbable by scale alone.
LRC_STARTS = [2 * i + 1 for i in range(16)]
SIXTEEN_LINE_LRC = "\n".join(f"[00:{s:02d}.00]line {i} of the song here" for i, s in enumerate(LRC_STARTS))


class ExtraBridgeAligner:
    """An aligner reporting a recording that has TWELVE SECONDS this LRC does not know about.

    A wrong-version LRC is not merely offset or stretched -- the fit absorbs both deliberately, because a
    longer intro and a different tempo are what a legitimate remaster looks like (both asserted below).
    What it cannot absorb is a structural difference: an added instrumental bridge displaces every line
    after it while leaving the ones before it alone, and no single scale+offset fits both halves.

    Monotonic, which matters: the first version of this fake used ALTERNATING shifts, and the resulting
    out-of-order words made `validate_timing` refuse the word timing and degrade to line sync before the
    detector was ever consulted. A real different-master alignment is monotonic -- it is simply not
    LINEAR in the LRC's own clock.
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
    """The detector this wires up -- a Theil-Sen fit that had zero callers until now.

    `_time_one`'s own docstring names the failure it addresses: "an LRC written for another upload of the
    song is confidently wrong". Nothing looked. Published timings still come from the aligner, so they
    are correct for THIS audio; what the note warns about is the WORDS, since an LRC that cannot be
    fitted to this recording is evidence they belong to another release.
    """
    proc = plans.align_runner(
        runner=fake_ytdlp_runner(),
        lyrics_client=fake_client(synced=SIXTEEN_LINE_LRC),
        aligner=ExtraBridgeAligner(),
    )
    events = await drain(proc, spec(tmp_path, durationSec=60.0))
    assert [e for e in events if isinstance(e, CompleteResult)], "the cook must still COMPLETE"

    out = capsys.readouterr().out
    assert "do NOT fit this recording" in out, out
    assert "may belong to another version" in out


@pytest.mark.asyncio
async def test_a_legitimate_REMASTER_is_not_mistaken_for_the_wrong_version(tmp_path, capsys):
    """The false positive that would matter more than the miss.

    A re-release with a longer intro and a slightly different tempo is the SAME words, and the fit
    absorbs both by design (offset and scale). If this warned, every correctly-timed song would carry a
    scary note and an operator would learn to ignore the one that matters.
    """

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


# ── #92: the aligner searches align_windows; the line-sync fallback keeps the source's own timings ──
def _ctx_forced(monkeypatch, mode=None):
    """Minimal ctx stub for _time_one.

    Defaults to forced sync mode (so the aligner branch runs); pass ``mode=SyncMode.LINES``
    to drive the lines-only branch instead.
    """
    from types import SimpleNamespace

    from src.vocabulary import SyncMode

    return SimpleNamespace(engines=SimpleNamespace(sync_mode=mode or SyncMode.FORCED))


def test_time_one_feeds_align_windows_to_the_aligner_and_line_sync_keeps_source_timings(monkeypatch):
    from src.lyrics.chain import SOURCE_LRCLIB, TIMING_LINE, LyricsText
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
    # #296: pin WHICH windows, by value, from the fixture above (NOT the aligner's own output) —
    # the [10,22]/[22,34] split is the only correct search set. A production mutation that keeps the
    # count (two windows) but corrupts the timestamps (e.g. zeroing every window's [start,end])
    # leaves ``calls[0][0] == 2`` green while shipping a 24-second line crushed into one second.
    assert ok.searched[0] == [
        (10.0, 22.0, "a very long human"),
        (22.0, 34.0, "authored karaoke lyric line"),
    ]
    assert timing == TIMING_WORD

    # 2. On aligner FAILURE the line-sync fallback publishes the SOURCE's own segments — one line at
    #    [10, 34] — NOT the windows, so no character-count-derived interior boundary ships as "high".
    fail = FakeAligner(fail=True)
    doc2, timing2, conf2 = steps_lyrics._time_one(
        fail, _ctx_forced(monkeypatch), text, audio="/x.wav", language="en"
    )
    assert timing2 == TIMING_LINE and conf2 == "high"
    assert [ln["start"] for ln in doc2["lines"]] == [10.0]
    assert [ln["end"] for ln in doc2["lines"]] == [34.0]


def test_time_one_lines_mode_publishes_source_timings_not_the_aligner_windows(monkeypatch):
    """#223: the LINES sync-mode publish site must ship the source's OWN line timings, never the
    presplit windows.

    `lines` mode skips forced alignment and line-syncs the source directly (`steps/lyrics.py`, the
    `if ctx.engines.sync_mode is SyncMode.LINES:` branch). `PresplitTexts` runs unconditionally before
    `TimeTexts`, so `align_windows` is already populated when this branch is reached. Publishing those
    windows would leak `_subdivide`'s character-count-derived interior boundary (22.0 here) as a "high"
    confidence line timestamp — issue #92 verbatim, on the one mode whose whole promise is the source's
    own timings. The forced-fallback site is pinned by the test above; this pins the lines-only site.
    """
    from src.lyrics.chain import SOURCE_LRCLIB, TIMING_LINE, LyricsText
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
    # The published doc carries the source's ONE line at [10, 34] — never the windows' [10, 22, ...].
    assert [ln["start"] for ln in doc["lines"]] == [10.0]
    assert [ln["end"] for ln in doc["lines"]] == [34.0]


# ── #217: the wrong-version fit must be paired with what the aligner SEARCHED ─────────────────────
# #92 routed the aligner at `steps/lyrics.py` to search `align_windows` (the per-row bounded windows)
# instead of `segments` when presplit set them. `doc` then carries one aligned line per WINDOW, so it
# has MORE lines than `segments`. The wrong-version fit was still fed `segments`, and
# `fit_lrc_to_aligned` returns `inconclusive` on a line-count mismatch (`len(xs) != len(ys)`) — so the
# detector went silently inert on exactly the long-line authoritative LRCs presplit produces windows
# for. The regression drives the real `TimeTexts.run` with `align_windows` injected the way the
# Dockerfile-only bounder would have set them on a worker box, and proves the "do NOT fit" note fires.


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
    """The regression. With `align_windows` set (more lines than `segments`), the aligned `doc` has one
    line per window. Feeding the fit `segments` (the pre-#217 behaviour) makes the counts unequal so
    the fit is `inconclusive` and the "do NOT fit" note never fires — reverting the fix reds exactly
    here on the assertion below. The fix pairs the fit with `align_windows`, the lineation the aligner
    actually searched, so equal counts feed a real fit that reports the structural difference.
    """
    text = _mismatched_windows_text()
    # The precondition that made the detector inert: what the aligner searched (windows) outnumbers
    # the human lines, so a fit against `segments` could never have equal counts.
    assert len(text.align_windows) != len(text.segments)

    aligner = _WindowBridgeAligner()
    ctx = await _drive_time_texts(aligner, text, tmp_path)

    # the aligner was handed the WINDOWS (32), confirming this is the #92 search path
    assert aligner.calls and aligner.calls[0][0] == len(text.align_windows)
    # FAILING ASSERTION ON BASE: the operator-facing wrong-version note must be present.
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
    # #93: a same_version fit that RAN now surfaces its diagnostic (offset, scale) in a note, so the
    # measurement is visible in the log rather than discarded. It is diagnostic only: published timings
    # stay the aligner's. Reverting the steps/lyrics.py note hunk reds exactly here.
    assert any(
        "matches this recording" in n and "fitted offset" in n and "diagnostic only" in n
        for n in ctx.out.notes
    ), ctx.out.notes


# ── #326: the refusal to publish UNUSABLE word timings must be pinned ──────────────────────────────
# steps/lyrics.py:292-297 is the one place the worker decides NOT to publish word timings: when
# `validate_timing` reports an out-of-order word (`usable == False`), it degrades to line sync at
# `(line, low)` and emits a REFUSING note. Five independent mutations of that block each left the whole
# worker suite byte-identical green — the string `REFUSING` appears in no test — because nothing drove a
# text carrying an out-of-order word through the publish path. These tests close M1/M2/M3 together (an
# unusable word-timed source publishes as line/low with NO words and a note) and M4 (a word-only ASR
# source with the same defect is DROPPED, not line-synced). The reachable state is exactly one
# out-of-order word (validate.py:83 `usable = out_of_order == 0 and words > 0`), and `_words_of`
# flattens across line boundaries, so a boundary overlap counts.


class _OneBackwardsWordAligner:
    """Force-aligner stand-in that re-times every line normally, then makes EXACTLY ONE word start
    before the previous word ended — a single order violation across a line boundary.

    A real different-master or window-boundary overlap is monotonic everywhere except one seam; this
    reproduces that seam deterministically. The first line's last word is stretched to end at
    `overlap_end`, and the second line's first word is pulled to start at `overlap_end - 1.0` — one word
    whose `start` is a full second below the previous `end`, well past validate.py's 1e-6 threshold.
    Every OTHER word is in order, so `validate_timing` reports `out_of_order == 1` and nothing else,
    which is the reachable `usable == False` state the block exists for.
    """

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
        # Inject a single backward jump across the boundary between the first two aligned lines: the
        # first line's LAST word runs long, and the second line's FIRST word starts a second earlier.
        # Chosen from the produced timeline, not from any threshold in validate.py.
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
    """M1/M2/M3 in one assertion. An LRCLIB source force-aligned to a doc with one out-of-order word is
    UNUSABLE, so the worker must NOT publish it as word timing. It degrades to the source's own line
    sync stamped `(line, low)` — `line` (not `word`, M2) so the TV does not run a backwards ball, and
    `low` (not `high`, M3) so breaksTie in packages/shared/src/lyrics.ts cannot let a refused alignment
    outrank a genuinely good line-sync candidate. A REFUSING note is emitted (M1). Deleting the block
    (`if not rep.usable:` -> `if False:`) publishes 30+ word timings at `(word, high)` and reds every
    line here.
    """
    text = _six_line_synced_text()
    aligner = _OneBackwardsWordAligner()
    ctx = await _drive_time_texts(aligner, text, tmp_path)

    cands = ctx.out.artifacts["lyrics"]["candidates"]
    assert len(cands) == 1, cands
    cand = cands[0]
    # M2 + M3: degraded to line sync at the LOW tier, never advertised as word or high.
    assert (cand["timing"], cand["timingConfidence"]) == (TIMING_LINE, "low")
    # M1: the published document carries NO word timings — a refused alignment publishes zero words.
    ref = tmp_path / cand["ref"]
    doc = json.loads(ref.read_text())
    assert [w for ln in doc["lines"] for w in (ln.get("words") or [])] == [], doc
    # M1: the operator gets the refusal note (its absence is how a silent deletion escapes notice).
    assert any("REFUSING word timing" in n for n in ctx.out.notes), ctx.out.notes


@pytest.mark.asyncio
async def test_326_a_word_only_ASR_source_with_unusable_timing_is_DROPPED_not_line_synced(tmp_path):
    """M4. An ASR source has no line timings of its own (`text.timing == TIMING_WORD`), so when its word
    timing is refused there is nothing honest to fall back to and the source must be DROPPED — not
    line-synced over text that never had line timings. With this the ONLY source, dropping it means the
    step raises `nothing could be timed` rather than publishing a bogus line-sync. Mutating
    `if text.timing != TIMING_LINE: continue` -> `if False:` would instead publish a line-synced doc and
    stop this raising.
    """
    text = _asr_word_source()
    aligner = _OneBackwardsWordAligner()
    with pytest.raises(RuntimeError, match="nothing could be timed"):
        await _drive_time_texts(aligner, text, tmp_path)


# ── #336: the wrong-version fit must NOT pair against _subdivide's char-count guesses ──────────────
# #319 (the fix for #217) paired the fit with `align_windows`. But only the OPENING window of each
# human line carries the source's own timestamp; `_subdivide` (presplit.py) spreads every interior
# window start PROPORTIONALLY TO CHARACTER COUNT across a span that `source.py` defines as ending at
# the NEXT line's start — so an overflowing line followed by a rest (an instrumental break, a
# verse→chorus gap) gets interior guesses that sit late in the rest, while a faithful aligner re-times
# the words where they are SUNG (early, right after the opening). The fit then reads that gap as a
# residual and the same_version arm reports "alignment slipped" on a correctly aligned song. #92
# ratified these interior guesses as "throwaway search hints, not published timing" — unusable as a
# time series exactly here. The fix pairs the fit against the OPENING windows only (real human starts)
# and the aligned lines at those same indices.
#
# Every test here injects an aligner that RE-TIMES the words inside each window (words sung at a
# constant rate from the human line's real start), NOT one that echoes the window bounds — an echoing
# aligner makes the interior residuals exactly zero by construction and cannot see this defect (that
# is why test_217_a_matching_recording_with_split_windows_is_NOT_flagged, whose _WindowBridgeAligner
# echoes bounds, stayed green through this bug). Windows are built by the REAL `bound_blob_text` /
# `_subdivide`, so the interior timestamps under test are production-computed, not hand-written.

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
    followed by an 18s rest (an instrumental break) because `source.py` sets each line's end to the
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
    the window's own (`_subdivide`-guessed) start. Words of a human line are sung contiguously from
    that line's REAL start at a constant rate, so the rest of the line's span is silence — the exact
    shape the issue measured. `bridge` shifts the back half to simulate a different master.

    Sung positions are derived from the human line starts and character counts — a source completely
    independent of `line_starts` / `fit_lrc_to_aligned` — so no test can derive its expectation the
    code's way. An OPENING window's re-timed start equals the human line start (a real aligner finds
    the first word there); an INTERIOR window's re-timed start is right after the opening's words, far
    EARLIER than `_subdivide`'s guess when a rest follows.
    """

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
    """THE regression. A same-version, perfectly aligned recording with instrumental breaks must NOT
    report that alignment slipped. On BASE the fit pairs against `align_windows` including the interior
    `_subdivide` guesses, which sit deep in each break while the words are sung early — so the
    same_version arm fires a spurious "alignment slipped" note. Reverting the fix reds exactly on the
    assertion below. The expectation (a correct alignment produces NO slippage note) is derived from
    the fixture's construction, not from the fit's arithmetic.
    """
    text = _instrumental_break_text_336()
    human_starts = [s["start"] for s in text.segments]

    aligner = _SungWordsAligner(human_starts, bridge=0.0)  # perfect same-version alignment
    ctx = await _drive_time_texts(aligner, text, tmp_path)

    # The aligner searched the WINDOWS (this is the #92 windows path, where the defect lives).
    assert aligner.calls and aligner.calls[0][0] == len(text.align_windows)
    # There ARE interior windows whose _subdivide start differs from where the words are sung — i.e.
    # the fixture actually exercises the guess/sung divergence, not a degenerate all-openings case.
    assert len(text.align_windows) > len(text.segments)
    # FAILING ON BASE: a correctly aligned song must not be told its alignment slipped.
    assert not any("alignment slipped" in n for n in ctx.out.notes), ctx.out.notes
    # And it must not be mislabelled a different version either.
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


# ── #410: the fit paired by align-window INDEX into normalize_lyrics(doc), an index that function does
# NOT preserve — it DROPS a segment with neither timed words nor bounds (artifact.py), shifting every
# later positional pairing. One dropped aligned line makes a correctly aligned song read as slipped
# (#336) and two make a genuinely wrong master go silently inert (#217). The fix pairs by the line's
# own TEXT — the stable key both _subdivide and normalize_lyrics keep verbatim — so a dropped line is
# left out of BOTH series together instead of shifting the survivors.
#
# The drop shape is the one artifact.py:80 exists for and test_normalize_rejects_nan_inf_timestamps
# pins: a segment with no start/end whose words carry NaN — normalize_lyrics drops it. The aligner
# below re-times faithfully (via _SungWordsAligner) and THEN rewrites chosen OPENING windows into that
# drop shape, so the surviving lines are correctly aligned and only the pairing is under test.


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
        # Walk the INPUT windows to identify which output entries are openings (start == a human start),
        # in order; blank the requested opening ordinals into the drop shape.
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
    """RED ON BASE. Same fixture as the #336 test, correctly aligned, but the aligner's output for ONE
    opening window is the normalize_lyrics-drop shape — so `doc` has one fewer line than `align_windows`
    and every positional pairing after that index is off by one. On base the openings-only pairing still
    indexes `line_starts(doc)[k]` positionally, so a correctly aligned song is told alignment slipped.
    The fix keys the pairing on text, so the dropped line is left out of both series and the survivors
    still pair correctly → no slippage note. The expectation (a correct alignment yields NO note) comes
    from the fixture's construction, never from the fit's own arithmetic.
    """
    text = _instrumental_break_text_336()
    human_starts = [s["start"] for s in text.segments]

    # Drop the SECOND opening line (ordinal 1) — a mid-song drop, so it shifts the tail of the pairing.
    aligner = _DroppingAligner(human_starts, drop_openings={1}, bridge=0.0)
    ctx = await _drive_time_texts(aligner, text, tmp_path)

    assert aligner.calls and aligner.calls[0][0] == len(text.align_windows)
    assert len(text.align_windows) > len(text.segments)
    # FAILING ON BASE: one dropped line must not make a correctly aligned song report slippage.
    assert not any("alignment slipped" in n for n in ctx.out.notes), ctx.out.notes
    # And it must not be mislabelled a different version either.
    assert not any("do NOT fit this recording" in n for n in ctx.out.notes), ctx.out.notes


@pytest.mark.asyncio
async def test_410_wrong_master_is_still_detected_when_two_lines_drop(tmp_path):
    """The #217 half: with TWO opening lines dropped, base goes count-unequal → `inconclusive` → the
    wrong-version note never fires on a genuinely different master (silently inert). Text-keyed pairing
    keeps the surviving openings paired correctly, so the +15s back-half master is still reported."""
    text = _instrumental_break_text_336()
    human_starts = [s["start"] for s in text.segments]

    aligner = _DroppingAligner(
        human_starts, drop_openings={0, 2}, bridge=15.0, bridge_after=len(human_starts) // 2
    )
    ctx = await _drive_time_texts(aligner, text, tmp_path)

    assert any("do NOT fit this recording" in n for n in ctx.out.notes), ctx.out.notes
    assert any("may belong to another version" in n for n in ctx.out.notes)


# -- #534: wrong-version check on the no-align_windows path + an inconclusive fit reporting a match
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
    """RED ON BASE. align_windows absent (the common branch), master structurally different (+15s back
    half), aligner DROPS one mid-song line into the normalize_lyrics-drop shape. On base the else branch
    pairs line_starts(segments) (16) against line_starts(doc) (15) -- unequal counts -> inconclusive ->
    the wrong-version note never fires (#217, live on this branch). The fix routes this branch through
    the same drop-tolerant text-keyed pairing, so survivors still fit and the +15s master is reported.
    Expectation comes from the fixture (a genuinely different master), not the fit arithmetic."""
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
    """RED ON BASE. A TWO-line synced LRC with a matching aligner: fit_lrc_to_aligned needs >= 3 lines,
    so it returns early with pairs == min(2, 2) == 2, verdict inconclusive, and the dataclass defaults
    offset 0.0 / scale 1.0. On base the caller gates the affirmative note on fit.pairs, so it prints
    matches this recording (fitted offset +0.00s, scale 1.000 over 2 lines) -- a fabricated positive
    match from a fit that never ran. The fix gates on fit.verdict == same_version, so an inconclusive
    fit produces no affirmative note. Pins F1 independently of the drop shape."""
    text = _plain_synced_text(n_lines=2)
    assert text.align_windows is None
    aligner = _PlainDroppingAligner()
    ctx = await _drive_time_texts(aligner, text, tmp_path)

    assert aligner.calls and aligner.calls[0][0] == 2
    assert not any("matches this recording" in n for n in ctx.out.notes), ctx.out.notes
    assert not any("do NOT fit this recording" in n for n in ctx.out.notes), ctx.out.notes


# ── #459: the version fit selected its opening-window indices by re-deriving them from window starts
# via float-equality (_opening_window_indices), which strands every line after one start that fails to
# match to 1e-6 — a latent trap the moment a producer stops rounding to 3 dp. presplit now EMITS the
# exact segment->window map as `align_window_opens`, and the consumer prefers it (see _opens_for). ──


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

    # Ground truth: on the perturbed windows the OLD re-derivation strands (returns fewer than one
    # index per segment) — this is the base defect made concrete.
    stranded = _opening_window_indices(perturbed.align_windows, perturbed.segments)
    assert len(stranded) < len(perturbed.segments), (
        "the re-derivation must strand under a 2e-6 perturbation for this test to bite"
    )

    # FAILING ON BASE (base has no _opens_for / always re-derives): the consumer must return the EMITTED
    # map, one exact index per human segment, unaffected by the perturbed start.
    got = _opens_for(perturbed)
    assert got == perturbed.align_window_opens == list(text.align_window_opens)
    assert len(got) == len(perturbed.segments)


def test_459_opens_for_falls_back_to_rederivation_for_a_hand_built_text_without_the_map():
    # A hand-built LyricsText (a test, or one rehydrated from disk) may set align_windows without the
    # emitted opens map; the consumer must still work by re-deriving. The windows here match segment
    # starts exactly (no perturbation), so the re-derivation is correct.
    from src.steps.lyrics import _opening_window_indices, _opens_for

    text = _instrumental_break_text_336()
    from dataclasses import replace as _dc_replace

    no_map = _dc_replace(text, align_window_opens=None)
    assert _opens_for(no_map) == _opening_window_indices(no_map.align_windows, no_map.segments)


def test_459_TimeTexts_run_uses_opens_for_at_the_call_site_not_inline_rederivation():
    # #459 blocking: the fix for #12 is the CALL SITE — `opens = _opens_for(text)` in TimeTexts.run.
    # _opens_for + the emitter both have direct tests, but nothing pinned that the consumer USES the
    # emitted map: reverting the call site to `_opening_window_indices(text.align_windows, text.segments)`
    # left every #12 test green while the version fit was back on the float-equality path that strands
    # a line after one start misses by 1e-6 — the fix present, tested, and not in use. Source-level pin:
    # TimeTexts.run must CALL _opens_for and must NOT call _opening_window_indices directly.
    import ast
    from pathlib import Path

    from src.steps import lyrics as _lyr

    tree = ast.parse(Path(_lyr.__file__).read_text(encoding="utf-8"))
    run_fn = None
    for cls in ast.walk(tree):
        if isinstance(cls, ast.ClassDef) and cls.name == "TimeTexts":
            for n in ast.walk(cls):
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == "run":
                    run_fn = n
                    break
    assert run_fn is not None, "TimeTexts.run not found"
    calls = [n for n in ast.walk(run_fn) if isinstance(n, ast.Call)]
    names = {n.func.id for n in calls if isinstance(n.func, ast.Name)}
    assert "_opens_for" in names, (
        "TimeTexts.run does not call _opens_for — the consumer is not using the emitted "
        "align_window_opens map; the version fit would re-derive by float-equality and strand lines (#459)"
    )
    assert "_opening_window_indices" not in names, (
        "TimeTexts.run calls _opening_window_indices DIRECTLY — that is the base behaviour that ignores "
        "the emitted opens map. The re-derivation must live behind _opens_for's fallback only (#459)"
    )


@pytest.mark.asyncio
async def test_the_variant_pick_provenance_reaches_ctx_out_selection_and_the_CompleteResult_669(tmp_path):
    """#669 — the align job must carry WHY the lyric won, not just which one, all the way to the
    CompleteResult, so the core can persist it to the durable audit trail. This pins the worker emit
    chain: TimeTexts writes ctx.out.selection from the Selection report, and the runner carries it onto
    the CompleteResult. RED on base: neither ctx.out.selection nor the runner passthrough exists, so
    done.selection is absent even when a real choice among versions was made.

    The candidate carries an ALTERNATE version, so grading actually chooses between two — which is the
    only case that produces a VariantChoice, and exactly the case a mis-pick needs explaining.
    """
    from dataclasses import replace as _replace

    from src.lyrics.chain import LyricsText

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
    # Every rejected version is retained with its score — the evidence gone today (#669). NOT the bodies.
    assert len(lrc_choice["rejected"]) == 1
    label, sc = lrc_choice["rejected"][0]["label"], lrc_choice["rejected"][0]["score"]
    assert label == "lrclib-alt"
    assert sc is None or isinstance(sc, float)


def test_Selection_to_record_carries_every_rejected_label_and_score_669():
    """#669 — the durable record VariantChoice/Selection produce is the same facts summary() logs, as
    data. Pins the shape the wire and the audit trail depend on, including the unjudgeable (None) score."""
    from src.lyrics.chain import Selection, VariantChoice

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
