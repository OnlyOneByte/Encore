"""END-TO-END version selection through the real WhisperXProcessor.

test_lyrics_versions.py pins the decision in isolation; this file proves the whole align job wires it
together — that a search returning two recordings of one song, plus a transcript of the audio actually
downloaded, results in the RIGHT version's words being written to disk and published as the candidate.

Driven through `process()` with fakes for the three external things (yt-dlp, LRCLIB, the aligner and the
transcriber), so nothing here touches a network or a model.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import plans  # noqa: E402
from src.lyrics.source import LrclibClient  # noqa: E402
from src.processor import CompleteResult, JobSpec, vocals_path  # noqa: E402

# Two recordings of one song. The SOLO record is deliberately returned FIRST by the fake provider, so a
# pass-through implementation would pick it — the test only passes if selection actually reorders.
SHARED = "hello hello baby you called i cant hear a thing i have got no service in the club you say"
GUEST = "boy the way you blowing up my phone wont make me leave no faster put my coat on faster"

SOLO_LRC = "\n".join(f"[00:{i:02d}.00]{w}" for i, w in enumerate(SHARED.split()))
FEAT_LRC = "\n".join(f"[00:{i:02d}.00]{w}" for i, w in enumerate((SHARED + " " + GUEST).split()))

#: What Whisper hears off the vocals stem — the FEAT recording, imperfectly.
ASR_TEXT = SHARED + " boy the way you blowing up my fone wont make me leave no faster put my coat on"


def fake_ytdlp_runner():
    async def run(argv):
        out = argv[argv.index("-o") + 1]
        os.makedirs(os.path.dirname(out), exist_ok=True)
        # A caption fetch uses the same runner; neither kind may masquerade as the audio download.
        if "--write-subs" in argv:
            yield "[info] no authored subtitles"
            return
        if "--write-auto-subs" in argv:
            yield "[info] no automatic captions"
            return
        Path(out).write_bytes(b"FAKE_SOURCE_WAV")
        yield "[download] 100% of 1MiB"

    return run


def two_version_client(order=("solo", "feat")):
    """LRCLIB whose /api/search returns both recordings, in the given order."""
    bodies = {
        "solo": {"id": 11, "instrumental": False, "syncedLyrics": SOLO_LRC, "plainLyrics": SHARED,
                 "trackName": "Telephone", "artistName": "Lady Gaga", "duration": 218},
        "feat": {"id": 12, "instrumental": False, "syncedLyrics": FEAT_LRC, "plainLyrics": SHARED + " " + GUEST,
                 "trackName": "Telephone", "artistName": "Lady Gaga feat. Beyonce", "duration": 243},
    }

    def fetch(url, headers):
        if "/api/search?" in url:
            return 200, json.dumps([bodies[k] for k in order])
        return 200, json.dumps(bodies[order[0]])  # /api/get — the old single-record behaviour

    return LrclibClient(fetcher=fetch)


class FakeAligner:
    def align(self, segments, audio_path, language):
        out = []
        for s in segments:
            toks = s["text"].split()
            span = (s["end"] - s["start"]) / max(1, len(toks))
            out.append({
                "start": s["start"], "end": s["end"], "text": s["text"],
                "words": [{"word": t, "start": round(s["start"] + i * span, 3), "end": round(s["start"] + (i + 1) * span, 3)}
                          for i, t in enumerate(toks)],
            })
        return {"language": language, "segments": out}


class FakeTranscriber:
    """ASR stand-in returning a transcript of the FEAT recording, with no word timings — which is what a
    real whisper transcribe() returns (measured; word timings come only from the aligner)."""

    def transcribe(self, audio_path, language=None):
        words = ASR_TEXT.split()
        return {"language": "en", "segments": [{"start": float(i), "end": float(i + 1), "text": w} for i, w in enumerate(words)]}


def proc(client):
    return plans.align_runner(
        runner=fake_ytdlp_runner(), lyrics_client=client, aligner=FakeAligner(), transcriber=FakeTranscriber()
    )


def spec(tmp_path, **params):
    """A job for a song whose stems are already cooked.

    The vocals stem is written deliberately: version selection runs on the ASR TRANSCRIPT, the ASR tier
    reads the isolated vocals stem and declines without one, and the core therefore chains `align` after
    `stems` so it exists by the time this job runs (followUps in dispatch.ts). A fixture with no stem
    silently tests the degraded path — selection falling back to duration alone — which is what an
    earlier draft of this file did.
    """
    stem = vocals_path(str(tmp_path), "m1")
    os.makedirs(os.path.dirname(stem), exist_ok=True)
    Path(stem).write_bytes(b"FAKE_VOCALS_STEM")
    p = {"artist": "Lady Gaga", "track": "Telephone", "language": "en", "durationSec": 243.0,
         "artistCredit": "Lady Gaga feat. Beyonce"}
    p.update(params)
    return JobSpec(job_id="j1", media_id="m1", job_type="align", source_uri="https://yt/x", params=p, media_dir=str(tmp_path))


async def run(p, job):
    return [ev async for ev in p.process(job)]


def published_lyrics(events, tmp_path):
    """The LRCLIB candidate's artifact, read back off disk."""
    done = next(e for e in events if isinstance(e, CompleteResult))
    cand = next(c for c in done.artifacts["lyrics"]["candidates"] if c["textSource"] == "lrclib")
    with open(os.path.join(str(tmp_path), cand["ref"]), encoding="utf-8") as f:
        return json.load(f), cand


@pytest.mark.asyncio
async def test_THE_BUG_the_published_lyrics_are_the_version_that_matches_the_audio(tmp_path):
    """The end-to-end fix. The provider lists the guest-less recording first and /api/get would return
    it; the transcript of the audio contains the guest verse, so the other record must win and its words
    must be what lands on disk."""
    events = await run(proc(two_version_client(order=("solo", "feat"))), spec(tmp_path))
    doc, cand = published_lyrics(events, tmp_path)

    body = " ".join(l["text"] for l in doc["lines"]).lower()
    assert "coat" in body  # a guest-verse word — present only in the correct recording
    assert cand["textConfidence"] == "high"  # the winner agreed, so it was NOT demoted


@pytest.mark.asyncio
async def test_the_choice_does_not_depend_on_the_order_the_provider_happened_to_return(tmp_path):
    """Same outcome with the records listed the other way round. A test that passed only in one order
    would be measuring the fake, not the selection."""
    for order in [("solo", "feat"), ("feat", "solo")]:
        events = await run(proc(two_version_client(order=order)), spec(tmp_path / f"d-{order[0]}"))
        doc, _ = published_lyrics(events, tmp_path / f"d-{order[0]}")
        assert "coat" in " ".join(l["text"] for l in doc["lines"]).lower(), order


@pytest.mark.asyncio
async def test_the_winner_is_still_judged_against_the_absolute_threshold(tmp_path):
    """Selection and demotion are complementary, not alternatives. When EVERY candidate is a different
    song, choosing the best of them must not launder it into looking trustworthy.

    The decoy needs MORE than MIN_TOKENS_TO_COMPARE (12) distinct words, or `agreement_score` returns
    None and the text is treated as INCOMPARABLE rather than wrong — "cannot tell" and "these differ"
    are deliberately different answers, and a shorter decoy silently tests the former.
    """
    other_song = (
        "never gonna give you up never gonna let you down never gonna run around and desert you "
        "we have known each other for so long your hearts been aching but youre too shy to say it"
    )

    def wrong_song(url, headers):
        body = {"id": 1, "instrumental": False,
                "syncedLyrics": "\n".join(f"[00:{i:02d}.00]{w}" for i, w in enumerate(other_song.split())),
                "plainLyrics": other_song, "trackName": "Telephone", "artistName": "Lady Gaga",
                "duration": 243}
        return 200, json.dumps([body] if "/api/search?" in url else body)

    events = await run(proc(LrclibClient(fetcher=wrong_song)), spec(tmp_path))
    _, cand = published_lyrics(events, tmp_path)
    assert cand["textConfidence"] == "low"  # demoted: below ASR, and the TV will label it


@pytest.mark.asyncio
async def test_the_agreement_score_is_published_so_the_core_can_rank_across_sources(tmp_path):
    """Cross-source ranking (pickBestLyrics/breaksTie in shared/lyrics.ts) breaks an equal-rank tie on
    `agreement`, so the worker has to actually emit it."""
    events = await run(proc(two_version_client()), spec(tmp_path))
    _, cand = published_lyrics(events, tmp_path)
    assert isinstance(cand.get("agreement"), float)
    assert cand["agreement"] > 0.5


@pytest.mark.asyncio
async def test_BOTH_local_baselines_run_and_a_silent_stem_does_not_lose_the_vote(tmp_path):
    """Why there are two local transcriptions rather than one.

    Separation demonstrably fails on this library — 2 of 9 vocals stems were digital silence and shipped
    as `ready`. When that happens the stem baseline transcribes to nothing and abstains, and the MIX
    baseline is the only evidence left. Here the stem yields nothing and the correct version is still
    chosen, which is exactly the failure the mix baseline exists to cover.
    """
    class PerAudioTranscriber:
        """Silence from the stem, real words from the mix — the silent-stem failure, reproduced."""

        def transcribe(self, audio_path, language=None):
            words = [] if "vocals" in audio_path else ASR_TEXT.split()
            return {
                "language": "en",
                "segments": [{"start": float(i), "end": float(i + 1), "text": w} for i, w in enumerate(words)],
            }

    p = plans.align_runner(
        runner=fake_ytdlp_runner(),
        lyrics_client=two_version_client(order=("solo", "feat")),
        aligner=FakeAligner(),
        transcriber=PerAudioTranscriber(),
    )
    doc, cand = published_lyrics(await run(p, spec(tmp_path)), tmp_path)
    assert "coat" in " ".join(l["text"] for l in doc["lines"]).lower()  # a guest-verse word
    assert cand["textConfidence"] == "high"


@pytest.mark.asyncio
async def test_youtube_AUTOMATIC_captions_grade_a_candidate_but_never_become_one(tmp_path):
    """The third baseline, end to end. The machine track is fetched separately from any authored one, used
    as evidence, and cannot itself be published while a candidate is trustworthy."""
    def runner_with_auto_captions():
        async def run_(argv):
            out = argv[argv.index("-o") + 1]
            os.makedirs(os.path.dirname(out), exist_ok=True)
            if "--write-subs" in argv:  # no authored track on this upload
                yield "[info] no authored subtitles"
                return
            if "--write-auto-subs" in argv:  # a MACHINE track that heard the guest verse
                vtt = "WEBVTT\n\n" + "\n\n".join(
                    f"00:00:{i:02d}.000 --> 00:00:{i + 1:02d}.000\n{w}" for i, w in enumerate(ASR_TEXT.split()[:45])
                )
                Path(out.replace("%(ext)s", "en.vtt")).write_text(vtt, encoding="utf-8")
                yield "[info] writing automatic captions"
                return
            Path(out).write_bytes(b"FAKE_SOURCE_WAV")
            yield "[download] 100% of 1MiB"

        return run_

    p = plans.align_runner(
        runner=runner_with_auto_captions(),
        lyrics_client=two_version_client(order=("solo", "feat")),
        aligner=FakeAligner(),
        transcriber=FakeTranscriber(),
    )
    done = next(e for e in await run(p, spec(tmp_path)) if isinstance(e, CompleteResult))
    sources = {c["textSource"] for c in done.artifacts["lyrics"]["candidates"]}
    assert sources == {"lrclib"}  # the machine track graded the lookup; it did not become the answer
    doc, _ = published_lyrics(await run(p, spec(tmp_path / "again")), tmp_path / "again")
    assert "coat" in " ".join(l["text"] for l in doc["lines"]).lower()


@pytest.mark.asyncio
async def test_with_no_candidate_at_all_a_baseline_is_published_as_the_answer(tmp_path):
    """A song nobody has written lyrics for. The tiering system picks the best available evidence, and the
    `low` confidence rides along so the TV says the words are auto-transcribed."""
    def no_lyrics(url, headers):
        return 404, ""

    p = plans.align_runner(
        runner=fake_ytdlp_runner(),
        lyrics_client=LrclibClient(fetcher=no_lyrics),
        aligner=FakeAligner(),
        transcriber=FakeTranscriber(),
    )
    done = next(e for e in await run(p, spec(tmp_path)) if isinstance(e, CompleteResult))
    cands = done.artifacts["lyrics"]["candidates"]
    assert [c["textSource"] for c in cands] == ["asr"]
    assert cands[0]["textConfidence"] == "low"
    assert "agreement" not in cands[0]  # a baseline is the ruler; scoring it against itself is meaningless


@pytest.mark.asyncio
async def test_a_missing_caption_track_is_not_a_failure(tmp_path):
    """The fake runner reports no subtitles of either kind, which is the common real case. The job must
    still complete and still publish the LRCLIB tier."""
    events = await run(proc(two_version_client()), spec(tmp_path))
    done = next(e for e in events if isinstance(e, CompleteResult))
    sources = {c["textSource"] for c in done.artifacts["lyrics"]["candidates"]}
    assert "lrclib" in sources
    assert "captions" not in sources  # nothing was written, so nothing is claimed


@pytest.mark.asyncio
async def test_authored_captions_can_WIN_over_a_lookup_when_they_match_the_audio_better(tmp_path):
    """Both are CANDIDATES and the same ruler judges them, so the authored caption track is not
    privileged — it wins here only because its words are what the baselines heard.

    That is the point of grading across sources rather than ranking sources: captions are attached to the
    exact upload, so they cannot be about a different recording, but "attached to this upload" is not the
    same as "correct" and they still have to earn it.
    """
    def runner_writing_captions():
        async def run_(argv):
            out = argv[argv.index("-o") + 1]
            os.makedirs(os.path.dirname(out), exist_ok=True)
            if "--write-subs" in argv:  # AUTHORED track — the candidate
                vtt = "WEBVTT\n\n" + "\n\n".join(
                    f"00:00:{i:02d}.000 --> 00:00:{i + 1:02d}.000\n{w}" for i, w in enumerate(ASR_TEXT.split()[:45])
                )
                Path(out.replace("%(ext)s", "en.vtt")).write_text(vtt, encoding="utf-8")
                yield "[info] writing subtitles"
                return
            if "--write-auto-subs" in argv:  # no machine track on this upload
                yield "[info] no automatic captions"
                return
            Path(out).write_bytes(b"FAKE_SOURCE_WAV")
            yield "[download] 100% of 1MiB"

        return run_

    # the lookup is the SOLO recording; the audio (and so the captions) carry the guest verse
    p = plans.align_runner(
        runner=runner_writing_captions(),
        lyrics_client=two_version_client(order=("solo",)),
        aligner=FakeAligner(),
        transcriber=FakeTranscriber(),
    )
    done = next(e for e in await run(p, spec(tmp_path)) if isinstance(e, CompleteResult))
    sources = {c["textSource"] for c in done.artifacts["lyrics"]["candidates"]}
    assert sources == {"captions"}  # it won outright; the losing lookup is not published
    caps = next(c for c in done.artifacts["lyrics"]["candidates"] if c["textSource"] == "captions")
    assert caps["textConfidence"] == "high"  # authored text, never machine-made — see lyrics/captions.py
