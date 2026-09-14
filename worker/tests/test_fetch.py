"""The `fetch` action: acquisition as its own job.

WHY THESE TESTS. Two behaviours matter and neither is exercised by the separation tests. First, that a
DECLARED fetcher decides how audio is obtained -- the URI's shape must no longer decide anything, which
is the defect this module replaced. Second, that a fetch reuses audio already retained on the volume,
because that reuse is what makes acquisition worth splitting out instead of repeating inside every
consumer.

No network and no yt-dlp: the runner is injected, exactly as it is for the separation processors.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import plans  # noqa: E402
from src.acquisition import fetch as fetch_mod  # noqa: E402
from src.processor import CompleteResult, JobSpec, ProgressEvent  # noqa: E402
from src.vocabulary import Fetcher  # noqa: E402
from tests.conftest import drain  # noqa: E402


def spec(tmp_path, source_uri="https://www.youtube.com/watch?v=abc", media_id="m1", **params):
    return JobSpec(
        job_id="j1",
        media_id=media_id,
        job_type="fetch",
        source_uri=source_uri,
        params=params,
        media_dir=str(tmp_path),
    )


def fake_runner(lines, *, writes: tuple[str, str] | None = None):
    """A runner that emits progress lines and optionally lands a file, standing in for yt-dlp."""

    async def run(argv):
        if writes:
            path, body = writes
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w") as fh:
                fh.write(body)
        for ln in lines:
            yield ln

    return run


def test_fetcher_is_declared_never_inferred_from_the_uri():
    # A non-http scheme is NOT local just because it lacks an http prefix -- the old shape test made
    # exactly this mistake and failed later inside ffmpeg instead of here.
    odd = spec("/m", source_uri="spotify:track:4cOdK2wGLETKBW3PvgPWqT", fetcher="ytdlp")
    assert fetch_mod.job_fetcher(odd) is Fetcher.YTDLP
    assert fetch_mod.job_fetcher(spec("/m", fetcher="local")) is Fetcher.LOCAL
    assert fetch_mod.job_fetcher(spec("/m")) is Fetcher.YTDLP  # absent => default, so an older core works


def test_an_unknown_fetcher_fails_before_any_work():
    with pytest.raises(ValueError, match="unknown fetcher"):
        fetch_mod.job_fetcher(spec("/m", fetcher="librespot"))


def test_local_paths_resolve_against_the_media_volume(tmp_path):
    rel = spec(tmp_path, source_uri="library/song.wav", fetcher="local")
    assert fetch_mod.local_source_path(rel) == os.path.join(str(tmp_path), "library/song.wav")
    # an absolute path is honoured as-is, so a library mounted outside MEDIA_DIR still works
    absolute = spec(tmp_path, source_uri="/mnt/music/song.wav", fetcher="local")
    assert fetch_mod.local_source_path(absolute) == "/mnt/music/song.wav"


@pytest.mark.asyncio
async def test_the_download_TEMPLATE_carries_ext_so_the_file_is_not_mislabelled(tmp_path):
    """The bug this unification fixed, pinned at the boundary.

    `download_argv`'s docstring is explicit: the template "must carry `%(ext)s` — the extension is
    whatever YouTube served (m4a or webm), so the caller discovers the real filename with
    `find_downloaded` rather than assuming one." Two of the four call sites passed a literal
    `audio/<id>.wav` instead, so yt-dlp wrote m4a or webm bytes into a file named `.wav`.

    Nothing broke, because ffmpeg sniffs content and ignores the extension — which is exactly why it went
    unnoticed, and why it needs a test rather than a reader's attention.
    """
    seen: list[list[str]] = []

    async def spy_download(argv):
        seen.append(argv)
        out = Path(str(tmp_path) + "/audio/m1.m4a")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"OPUS")
        yield "[download] 100% of 1MiB"

    job = JobSpec(
        job_id="j",
        media_id="m1",
        job_type="fetch",
        source_uri="https://yt/x",
        params={"fetcher": "ytdlp"},
        media_dir=str(tmp_path),
    )

    events = await drain(plans.fetch_runner(runner=spy_download), job)
    got = [e.artifacts["source"]["audio"] for e in events if isinstance(e, CompleteResult)]
    template = next(a[i + 1] for a in seen for i, tok in enumerate(a) if tok == "-o")
    assert template.endswith("m1.%(ext)s"), f"template must carry %(ext)s, got {template}"
    # ...and the path yielded is the file that ACTUALLY landed, not the one that was assumed.
    assert str(got[-1]).endswith("m1.m4a")


async def test_a_legacy_mislabelled_wav_is_still_found(tmp_path):
    """Backward compatibility, and the reason `find_downloaded` semantics were the right choice rather
    than simply correcting the extension. A live volume already holds `audio/<id>.wav` files containing
    m4a bytes; they must keep being reused rather than re-downloaded."""
    audio = tmp_path / "audio"
    audio.mkdir()
    (audio / "m1.wav").write_bytes(b"actually m4a")

    async def never_download(argv):  # pragma: no cover - must not be reached
        raise AssertionError("re-downloaded a file that was already on the volume")
        yield

    job = JobSpec(
        job_id="j",
        media_id="m1",
        job_type="fetch",
        source_uri="https://yt/x",
        params={"fetcher": "ytdlp"},
        media_dir=str(tmp_path),
    )

    events = await drain(plans.fetch_runner(runner=never_download), job)
    got = [e.artifacts["source"]["audio"] for e in events if isinstance(e, CompleteResult)]
    assert str(got[-1]).endswith("m1.wav")


@pytest.mark.asyncio
async def test_fetch_downloads_and_reports_the_retained_original(tmp_path):
    audio = os.path.join(str(tmp_path), "audio", "m1.wav")
    proc = plans.fetch_runner(runner=fake_runner(["[download]  50.0% of 3MiB"], writes=(audio, "AUDIO")))
    events = await drain(proc, spec(tmp_path, fetcher="ytdlp"))

    stages = {e.stage for e in events if isinstance(e, ProgressEvent)}
    assert stages == {"downloading"}, "a fetch separates nothing -- downloading is its only stage"
    done = [e for e in events if isinstance(e, CompleteResult)]
    assert len(done) == 1
    assert done[0].media_uri == audio
    assert done[0].artifacts["source"]["audio"] == audio


@pytest.mark.asyncio
async def test_fetch_reuses_audio_already_on_the_volume_and_never_re_downloads(tmp_path):
    # The raw original is the one asset that cannot be regenerated, so a second fetch for the same
    # media must cost no network at all.
    audio = tmp_path / "audio" / "m1.wav"
    audio.parent.mkdir(parents=True)
    audio.write_text("ALREADY HERE")

    calls: list[list[str]] = []

    async def runner(argv):
        calls.append(argv)
        yield ""

    proc = plans.fetch_runner(runner=runner)
    events = await drain(proc, spec(tmp_path, fetcher="ytdlp"))

    assert calls == [], "audio was already retained -- yt-dlp must not run"
    assert any(isinstance(e, ProgressEvent) and e.pct == 100 for e in events)
    assert audio.read_text() == "ALREADY HERE", "the retained original must not be overwritten"


@pytest.mark.asyncio
async def test_a_local_job_never_downloads(tmp_path):
    local = tmp_path / "library" / "song.wav"
    local.parent.mkdir(parents=True)
    local.write_text("LOCAL")

    async def runner(argv):  # pragma: no cover - must never run
        raise AssertionError("a local job must not invoke a downloader")
        yield ""

    proc = plans.fetch_runner(runner=runner)
    events = await drain(proc, spec(tmp_path, source_uri=str(local), fetcher="local"))
    done = [e for e in events if isinstance(e, CompleteResult)]
    assert done[0].media_uri == str(local)


@pytest.mark.asyncio
async def test_a_download_that_lands_nothing_FAILS_rather_than_reporting_success(tmp_path):
    # Reporting success for a file that is not there would have the core chain a separation against
    # missing input, which surfaces as a confusing decode error one stage later.
    #
    # The check now lives in AcquireAudio rather than at the end of the fetch action, so it protects
    # stems and align too — and it names the directory, because the usual cause is yt-dlp resolving no
    # audio-only format at all (a missing JavaScript runtime for YouTube's player challenge).
    proc = plans.fetch_runner(runner=fake_runner(["[download] 100%"]))
    with pytest.raises(RuntimeError, match="produced no file"):
        await drain(proc, spec(tmp_path, fetcher="ytdlp"))


class FakeAnnotator:
    """Stands in for MusicBrainzClient: returns whatever recordings the test wants."""

    def __init__(self, recordings=None, boom=False):
        self._recs = recordings or []
        self._boom = boom
        self.search_calls: list[tuple] = []

    def search(self, artist, track, limit=10):
        self.search_calls.append((artist, track))
        if self._boom:
            raise RuntimeError("musicbrainz is down")
        from src.metadata.annotate import parse_recordings

        return parse_recordings({"recordings": self._recs})


MB_HIT = [
    {
        "id": "mb-take-on-me",
        "score": 100,
        "title": "Take On Me",
        "length": 225000,
        "artist-credit": [{"name": "a\u2010ha"}],
        "releases": [{"title": "Hunting High and Low", "date": "1985-06-01"}],
    }
]


@pytest.mark.asyncio
async def test_a_fetch_reports_the_identification_it_made(tmp_path):
    audio = os.path.join(str(tmp_path), "audio", "m1.wav")
    proc = plans.fetch_runner(
        runner=fake_runner(["[download] 100%"], writes=(audio, "AUDIO")),
        annotator=FakeAnnotator(MB_HIT),
    )
    events = await drain(
        proc, spec(tmp_path, fetcher="ytdlp", artist="a-ha", track="Take On Me", durationSec=225.0)
    )
    done = [e for e in events if isinstance(e, CompleteResult)][0]
    note = done.artifacts["annotation"]
    assert note["source"] == "musicbrainz"
    assert note["mbid"] == "mb-take-on-me"
    assert note["confidence"] == "high"
    # the unicode-hyphen artist came back normalised for MATCHING but is reported as MusicBrainz spells it
    assert note["artist"] == "a\u2010ha"


@pytest.mark.asyncio
async def test_no_lookup_keys_means_no_annotation_attempted(tmp_path):
    # An unconfident parse sends no artist/track, which is the signal to decline rather than guess.
    audio = os.path.join(str(tmp_path), "audio", "m1.wav")
    annotator = FakeAnnotator(MB_HIT)
    proc = plans.fetch_runner(
        runner=fake_runner(["[download] 100%"], writes=(audio, "AUDIO")), annotator=annotator
    )
    done = [e for e in await drain(proc, spec(tmp_path, fetcher="ytdlp")) if isinstance(e, CompleteResult)][0]
    # OBSERVE the attempt, not just the outcome: with no artist/track the lookup must be DECLINED
    # BEFORE any query is built, so search() is never reached. Asserting only the absent artifact is
    # blind -- a query built from (None, None) blows up in escape_lucene and is swallowed by the
    # blanket except, producing the same empty-artifact outcome. This pins the DECLINE.
    assert annotator.search_calls == [], f"expected no lookup attempt, saw {annotator.search_calls}"
    assert "annotation" not in done.artifacts


@pytest.mark.asyncio
async def test_a_DEAD_metadata_service_still_completes_the_fetch(tmp_path):
    # The whole point of annotation being a step rather than a job: a karaoke night must not stop
    # because MusicBrainz is unreachable. The audio is what matters and it is already on disk.
    audio = os.path.join(str(tmp_path), "audio", "m1.wav")
    proc = plans.fetch_runner(
        runner=fake_runner(["[download] 100%"], writes=(audio, "AUDIO")), annotator=FakeAnnotator(boom=True)
    )
    done = [
        e
        for e in await drain(
            proc, spec(tmp_path, fetcher="ytdlp", artist="a-ha", track="Take On Me", durationSec=225.0)
        )
        if isinstance(e, CompleteResult)
    ][0]
    assert done.media_uri == audio
    assert "annotation" not in done.artifacts


@pytest.mark.asyncio
async def test_annotation_can_be_switched_off_entirely(tmp_path):
    audio = os.path.join(str(tmp_path), "audio", "m1.wav")
    proc = plans.fetch_runner(
        runner=fake_runner(["[download] 100%"], writes=(audio, "AUDIO")), annotator=None
    )
    done = [
        e
        for e in await drain(
            proc, spec(tmp_path, fetcher="ytdlp", artist="a-ha", track="Take On Me", durationSec=225.0)
        )
        if isinstance(e, CompleteResult)
    ][0]
    assert "annotation" not in done.artifacts


@pytest.mark.asyncio
async def test_configured_ytdlp_binary_reaches_the_download_argv(tmp_path):
    """The fetch path. ENCORE_YTDLP_BIN was probed and logged but never reached the
    subprocess: `fetch_runner` accepted a `ytdlp_bin` and dropped it, because `fetch_plan` built
    `AcquireAudio()` with the hardcoded default and the only surviving reader was a `ytdlpBin` job
    param the core never sends. So argv[0] was the literal "yt-dlp" in every reachable configuration,
    and a worker configured with an off-PATH binary probed one yt-dlp and ran another.

    Drives the REAL `plans.fetch_runner(ytdlp_bin=...)` end to end and pins that the binary the worker
    was configured with is the one that lands at argv[0]. The expected value is a literal standalone
    path the code never constructs, so this cannot pass by re-deriving the code's own default.
    """
    configured = "/opt/encore/bin/yt-dlp"
    seen: list[list[str]] = []

    async def spy_download(argv):
        seen.append(argv)
        out = Path(str(tmp_path)) / "audio" / "m1.m4a"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"OPUS")
        yield "[download] 100% of 1MiB"

    job = JobSpec(
        job_id="j",
        media_id="m1",
        job_type="fetch",
        source_uri="https://yt/x",
        params={"fetcher": "ytdlp"},
        media_dir=str(tmp_path),
    )

    await drain(plans.fetch_runner(runner=spy_download, ytdlp_bin=configured), job)

    assert seen, "yt-dlp must have been invoked"
    assert seen[0][0] == configured, f"argv[0] must be the configured ENCORE_YTDLP_BIN, got {seen[0][0]!r}"


# ── capture YouTube's OWN declared credit at download time ───────────────────────────────────


def test_download_argv_writes_the_info_json():
    # yt-dlp already does a full extraction to evaluate the format selector, so --write-info-json
    # captures track/artist/album with NO extra network round trip. Pinned at the argv boundary.
    argv = fetch_mod.download_argv("https://yt/x", "/tmp/audio/m1.%(ext)s")
    assert "--write-info-json" in argv


def test_youtube_credit_reads_the_declared_track_and_artist():
    # The music-panel metadata yt-dlp exposes — a citation, not a re-parse of the title. Emits the same
    # artifact shape MusicBrainz does, with source "youtube" and no mbid.
    got = fetch_mod.youtube_credit({"track": "Take On Me", "artist": "a-ha", "album": "Hunting High and Low"})
    assert got == {"source": "youtube", "artist": "a-ha", "title": "Take On Me", "confidence": "high"}


def test_youtube_credit_takes_the_primary_when_artist_is_a_list():
    # Some extractors return `artist` as a list; the primary (first) is the artist key.
    got = fetch_mod.youtube_credit({"track": "Telephone", "artist": ["Lady Gaga", "Beyoncé"]})
    assert got is not None and got["artist"] == "Lady Gaga"


def test_youtube_credit_declines_without_both_fields():
    # A lone artist with no track is not an identification (the title parser owns the title), and an
    # empty/absent/non-string value declines rather than inventing a credit.
    assert fetch_mod.youtube_credit({"artist": "a-ha"}) is None
    assert fetch_mod.youtube_credit({"track": "Take On Me"}) is None
    assert fetch_mod.youtube_credit({"track": "  ", "artist": "a-ha"}) is None
    assert fetch_mod.youtube_credit({"track": 5, "artist": "a-ha"}) is None
    assert fetch_mod.youtube_credit({}) is None


def test_read_info_json_degrades_to_none_on_absence_or_garbage(tmp_path):
    assert fetch_mod.read_info_json(str(tmp_path / "nope.info.json")) is None
    bad = tmp_path / "bad.info.json"
    bad.write_text("{not json")
    assert fetch_mod.read_info_json(str(bad)) is None
    good = tmp_path / "m1.info.json"
    good.write_text('{"track": "T", "artist": "A"}')
    assert fetch_mod.read_info_json(str(good)) == {"track": "T", "artist": "A"}


@pytest.mark.asyncio
async def test_a_fetch_captures_the_youtube_credit_and_publishes_it_as_the_annotation(tmp_path):
    # The whole point of the declared-credit path: when the upload declares track/artist, that citation is
    # published as the
    # annotation — with NO MusicBrainz query needed to reach it.
    audio = tmp_path / "audio" / "m1.m4a"
    info = tmp_path / "audio" / "m1.info.json"

    async def download(argv):
        audio.parent.mkdir(parents=True, exist_ok=True)
        audio.write_bytes(b"OPUS")
        info.write_text('{"track": "Take On Me", "artist": "a-ha"}')
        yield "[download] 100% of 1MiB"

    # No artist/track params and no annotator: the credit must still be published from the info json.
    proc = plans.fetch_runner(runner=download, annotator=None)
    done = [e for e in await drain(proc, spec(tmp_path, fetcher="ytdlp")) if isinstance(e, CompleteResult)][0]
    note = done.artifacts["annotation"]
    assert note == {"source": "youtube", "artist": "a-ha", "title": "Take On Me", "confidence": "high"}


@pytest.mark.asyncio
async def test_the_youtube_credit_becomes_the_musicbrainz_query_key(tmp_path):
    # The reversed-parse defect is that a wrong artist parse ("No Vocal") defeats the MusicBrainz
    # lookup. Querying with the YouTube CITATION instead of the parse is what lets the lookup succeed —
    # and a MusicBrainz match then upgrades the youtube floor to a musicbrainz citation with an MBID.
    audio = tmp_path / "audio" / "m1.m4a"
    info = tmp_path / "audio" / "m1.info.json"

    async def download(argv):
        audio.parent.mkdir(parents=True, exist_ok=True)
        audio.write_bytes(b"OPUS")
        info.write_text('{"track": "Take On Me", "artist": "a-ha"}')
        yield "[download] 100% of 1MiB"

    annotator = FakeAnnotator(MB_HIT)
    proc = plans.fetch_runner(runner=download, annotator=annotator)
    # The dispatched params carry the WRONG parse (what defeats the lookup today); the credit overrides.
    done = [
        e
        for e in await drain(
            proc, spec(tmp_path, fetcher="ytdlp", artist="No Vocal", track="Wrong", durationSec=225.0)
        )
        if isinstance(e, CompleteResult)
    ][0]
    # MusicBrainz was queried with the CITATION, not the bad parse.
    assert annotator.search_calls == [("a-ha", "Take On Me")]
    # ...and its match (with an MBID) upgraded the youtube floor.
    note = done.artifacts["annotation"]
    assert note["source"] == "musicbrainz"
    assert note["mbid"] == "mb-take-on-me"


@pytest.mark.asyncio
async def test_a_youtube_credit_survives_a_musicbrainz_decline(tmp_path):
    # When MusicBrainz declines, the YouTube citation must remain the published annotation — it is a
    # citation in its own right, not a guess that a miss should erase.
    audio = tmp_path / "audio" / "m1.m4a"
    info = tmp_path / "audio" / "m1.info.json"

    async def download(argv):
        audio.parent.mkdir(parents=True, exist_ok=True)
        audio.write_bytes(b"OPUS")
        info.write_text('{"track": "Take On Me", "artist": "a-ha"}')
        yield "[download] 100% of 1MiB"

    proc = plans.fetch_runner(runner=download, annotator=FakeAnnotator([]))  # empty => no match
    done = [e for e in await drain(proc, spec(tmp_path, fetcher="ytdlp")) if isinstance(e, CompleteResult)][0]
    note = done.artifacts["annotation"]
    assert note["source"] == "youtube"
    assert note["artist"] == "a-ha"


@pytest.mark.asyncio
async def test_a_retained_original_still_captures_the_youtube_credit_without_re_downloading(tmp_path):
    # The self-corrects-one-song-at-a-time promise: a re-process of an already-downloaded song reads the
    # credit from the info.json ALREADY on disk, on the `found is not None` early-return branch — no
    # fetch. Drives AcquireAudio directly because the branch is the retained-original path.
    from src.runtime.ctx import Ctx
    from src.steps.acquire import AcquireAudio

    audio_dir = tmp_path / "audio"
    audio_dir.mkdir(parents=True)
    (audio_dir / "m1.m4a").write_bytes(b"OPUS")  # the retained original, already on disk
    (audio_dir / "m1.info.json").write_text('{"track": "Take On Me", "artist": "a-ha"}')

    ctx = Ctx(job=spec(tmp_path, fetcher="ytdlp"), work=str(tmp_path))

    async def never(argv):  # pragma: no cover - must not run: the audio is already retained
        raise AssertionError("re-downloaded a song whose audio was already on disk")
        yield ""

    ctx.runner = never
    events = [e async for e in AcquireAudio().run(ctx)]

    # audio resolved from disk, no fetch, and the credit captured off the retained info.json
    assert str(ctx.audio.path).endswith("m1.m4a")
    assert any(isinstance(e, ProgressEvent) and e.pct == 100 for e in events)
    assert ctx.audio.youtube_credit == {
        "source": "youtube",
        "artist": "a-ha",
        "title": "Take On Me",
        "confidence": "high",
    }
