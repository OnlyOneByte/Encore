"""One download per song (proposal 27): fetch keeps the audio and both caption kinds, later stages read them.

Before this, stems and align each downloaded the song again and align made two more caption calls: five yt-dlp
runs per song, four of them after fetch, on the critical path, and each a chance of a 429.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from pathlib import Path

import pytest

from encore_worker.adapters import cli
from encore_worker.adapters.ports import ProgressSink
from encore_worker.artifacts.local import LocalArtifactStore, Roots
from encore_worker.domain.document import Segment
from encore_worker.domain.identity import Identified
from encore_worker.host.config import Config
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.records import AudioRef, JobRef
from encore_worker.steps.separate_steps import FetchStepsImpl

CFG = Config(worker_id="w1")
WATCH = "https://www.youtube.com/watch?v=abc"

AUTHORED = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nwritten by a person\n"
MACHINE = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nheard by a machine\n"


class Reporter:
    async def progress(self, job_id: str, stage: object, pct: int) -> None:
        pass

    async def state(
        self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        pass

    async def confirm_ownership(self, job_id: str, *, timeout_sec: float = 10.0) -> bool:
        return True

    def explain_ownership(self, job_id: str) -> str:
        return "ours"


class NoCaptionCalls:
    """A caption source that must not be asked: reading a kept track runs no subprocess."""

    def __init__(self) -> None:
        self.asked: list[str] = []

    def fetch(self, source_uri: str, out_dir: str, *, automatic: bool) -> Sequence[Segment]:
        self.asked.append(source_uri)
        return ({"start": 1.0, "end": 2.0, "text": "from youtube"},)


class RecordingFetcher:
    def __init__(self) -> None:
        self.asked: list[str] = []

    def fetch(
        self,
        source_uri: str,
        out_dir: str,
        *,
        on_progress: ProgressSink | None = None,
        with_captions: bool = False,
    ) -> str:
        self.asked.append(source_uri)
        path = Path(out_dir) / "original.webm"
        path.write_bytes(b"audio")
        return str(path)


def _scratch(tmp: Path, info: dict[str, object] | None, tracks: dict[str, str]) -> Path:
    out = tmp / "scratch"
    out.mkdir(parents=True, exist_ok=True)
    (out / "original.webm").write_bytes(b"audio")
    for name, body in tracks.items():
        (out / name).write_text(body)
    if info is not None:
        (out / "original.info.json").write_text(json.dumps(info))
    return out


def _info(authored: Sequence[str], machine: Sequence[str]) -> dict[str, object]:
    """The info JSON as yt-dlp writes it: what exists, and NO `requested_subtitles` (it drops that)."""
    return {
        "subtitles": {lang: [{"ext": "vtt"}] for lang in authored},
        "automatic_captions": {lang: [{"ext": "vtt"}] for lang in machine},
    }


def test_fetch_asks_for_audio_both_caption_kinds_and_the_info_json_in_one_call() -> None:
    argv = cli.fetch_argv(WATCH, "/out")
    assert {"--write-subs", "--write-auto-subs", "--write-info-json", "--ignore-errors"} <= set(argv)
    assert argv[argv.index("-f") + 1] == "bestaudio/best"
    assert "--skip-download" not in argv


def test_one_list_asks_for_every_authored_english_track_named_or_regional() -> None:
    """yt-dlp matches each `--sub-langs` entry with `re.compile(entry, re.I).fullmatch`, across both kinds."""
    argv = cli.fetch_argv(WATCH, "/out")
    entries = argv[argv.index("--sub-langs") + 1].split(",")

    def asked(lang: str) -> bool:
        return any(re.compile(entry, re.I).fullmatch(lang) for entry in entries)

    named = ("en-nP7-2PuUl7o", "en-US-njLgzgtehjs", "en-eEY6OEpapPo")  # Despacito's authored tracks
    assert all(asked(lang) for lang in ("en", "en-orig", "en-AU", "en-CA", "en-IN", *named))
    assert not asked("fr") and not asked("es-orig")


def test_en_and_en_orig_are_downloaded_before_any_translation() -> None:
    """yt-dlp downloads tracks in the order its selector (used here) returns, so once YouTube starts answering
    429 on the translations, the two tracks `fetched_captions` keeps are already on disk."""
    from yt_dlp.utils import orderedSet_from_options  # type: ignore[import-untyped]  # noqa: PLC0415

    argv = cli.fetch_argv(WATCH, "/out")
    entries = argv[argv.index("--sub-langs") + 1].split(",")
    available = ["en-ar", "en-es", "en-nP7-2PuUl7o", "en-orig", "en", "en-US"]  # translations listed first
    order = orderedSet_from_options(entries, {"all": available}, use_regex=True)
    assert order[:2] == ["en", "en-orig"]
    assert set(order) == set(available)


#: Despacito (`kJQP7kiw5Fk`): Spanish audio, three NAMED authored English tracks, and machine `en`, `en-US`, …
#: that are all translations from Spanish (no `en-orig`).
DESPACITO_AUTHORED = ["es", "en-US-njLgzgtehjs", "en-eEY6OEpapPo", "en-nP7-2PuUl7o"]
DESPACITO_MACHINE = ["es", "es-orig", "en", "en-US", "en-en-nP7-2PuUl7o", "en-es", "en-ja"]


def test_despacito_keeps_a_named_authored_track_and_no_translation(tmp_path: Path) -> None:
    written = [*DESPACITO_AUTHORED[1:], "en", "en-US", "en-en-nP7-2PuUl7o", "en-es"]
    tracks = {f"original.{lang}.vtt": AUTHORED if lang in DESPACITO_AUTHORED else MACHINE for lang in written}
    out = _scratch(tmp_path, _info(authored=DESPACITO_AUTHORED, machine=DESPACITO_MACHINE), tracks)
    found = cli.fetched_captions(str(out))
    assert found == {"authored": str(out / "original.en-US-njLgzgtehjs.vtt")}, "no machine: all translations"


def test_a_machine_en_on_non_english_audio_is_a_translation_and_never_kept(tmp_path: Path) -> None:
    """Machine `en` is English audio only when `en-orig` exists; otherwise YouTube translated it."""
    info = _info(authored=[], machine=["ar", "ar-orig", "en", "en-ar"])
    out = _scratch(tmp_path, info, {"original.en.vtt": MACHINE})
    assert cli.fetched_captions(str(out)) == {}


def test_machine_prefers_en_orig_over_en(tmp_path: Path) -> None:
    tracks = {"original.en.vtt": MACHINE, "original.en-orig.vtt": MACHINE + "\n"}
    out = _scratch(tmp_path, _info(authored=[], machine=["en", "en-orig"]), tracks)
    assert cli.fetched_captions(str(out)) == {"machine": str(out / "original.en-orig.vtt")}


def test_authored_prefers_en_over_a_regional_track(tmp_path: Path) -> None:
    tracks = {"original.en.vtt": AUTHORED, "original.en-GB.vtt": AUTHORED + "\n"}
    out = _scratch(tmp_path, _info(authored=["en", "en-GB"], machine=["en-orig"]), tracks)
    assert cli.fetched_captions(str(out)) == {"authored": str(out / "original.en.vtt")}


def test_the_kind_comes_from_the_info_json_not_the_filename(tmp_path: Path) -> None:
    out = _scratch(
        tmp_path,
        _info(authored=["en", "fr"], machine=["en", "en-orig", "en-ar"]),
        {"original.en.vtt": AUTHORED, "original.en-orig.vtt": MACHINE},
    )
    found = cli.fetched_captions(str(out))
    assert found == {"authored": str(out / "original.en.vtt"), "machine": str(out / "original.en-orig.vtt")}


def test_an_en_track_only_youtube_generated_is_machine(tmp_path: Path) -> None:
    """Both kinds land as `original.en.vtt`; only the info JSON says this one is not a person's."""
    info = _info(authored=["fr"], machine=["en", "en-orig"])
    out = _scratch(tmp_path, info, {"original.en.vtt": MACHINE})
    assert cli.fetched_captions(str(out)) == {"machine": str(out / "original.en.vtt")}


def test_an_en_au_only_authored_track_is_kept_as_authored(tmp_path: Path) -> None:
    """Authored keeps `en.*`; with no authored `en`, yt-dlp also writes the machine `en` beside it."""
    info = _info(authored=["en-AU"], machine=["en", "en-orig", "en-en"])
    tracks = {"original.en-AU.vtt": AUTHORED, "original.en.vtt": MACHINE}
    out = _scratch(tmp_path, info, tracks)
    found = cli.fetched_captions(str(out))
    assert found == {"authored": str(out / "original.en-AU.vtt"), "machine": str(out / "original.en.vtt")}


def test_no_info_json_keeps_no_track_rather_than_guess_its_kind(tmp_path: Path) -> None:
    out = _scratch(tmp_path, None, {"original.en.vtt": AUTHORED})
    assert cli.fetched_captions(str(out)) == {}


def test_a_listed_track_that_failed_to_download_is_skipped(tmp_path: Path) -> None:
    out = _scratch(tmp_path, _info(authored=["en"], machine=["en-orig"]), {})
    assert cli.fetched_captions(str(out)) == {}


def test_a_file_no_list_names_is_not_kept(tmp_path: Path) -> None:
    """A language in neither list has no kind to trust it at."""
    out = _scratch(tmp_path, _info(authored=[], machine=[]), {"original.en.vtt": AUTHORED})
    assert cli.fetched_captions(str(out)) == {}


def test_the_audio_is_never_a_caption_or_the_info_json(tmp_path: Path) -> None:
    out = _scratch(tmp_path, {}, {"original.en-orig.vtt": MACHINE, "original.en.vtt": AUTHORED})
    assert cli.original_audio(str(out)) == str(out / "original.webm")


def _fake_ytdlp(tmp: Path, *, writes_audio: bool) -> str:
    """A yt-dlp that writes a caption (and maybe the audio), then fails on another track with a 429."""
    script = tmp / "yt-dlp"
    audio = 'printf audio > "$dir/original.webm"' if writes_audio else ":"
    script.write_text(
        "#!/bin/sh\n"
        'while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\n'
        'dir="$(dirname "$out")"\n'
        'printf "WEBVTT\\n" > "$dir/original.en.vtt"\n'
        f"{audio}\n"
        "echo \"ERROR: Unable to download video subtitles for 'en-orig': HTTP Error 429\"\n"
        "exit 1\n"
    )
    script.chmod(0o755)
    return str(script)


def test_a_caption_429_after_the_audio_keeps_the_download(tmp_path: Path) -> None:
    out = tmp_path / "out"
    out.mkdir()
    got = cli.YtDlpAudio(_fake_ytdlp(tmp_path, writes_audio=True)).fetch(WATCH, str(out), with_captions=True)
    assert got == str(out / "original.webm")
    assert (out / "original.en.vtt").is_file(), "the track written before the 429 is still there to keep"


def test_a_failed_call_with_no_audio_is_the_downloads_own_failure(tmp_path: Path) -> None:
    out = tmp_path / "out"
    out.mkdir()
    with pytest.raises(cli.ToolFailed):
        cli.YtDlpAudio(_fake_ytdlp(tmp_path, writes_audio=False)).fetch(WATCH, str(out), with_captions=True)


def _job(media: Path, **params: object) -> JobRef:
    return JobRef(job_id="j1", media_id="m1", media_dir=str(media), source_uri=WATCH, params=params)


async def test_fetch_publishes_the_audio_and_each_kind_into_the_store(tmp_path: Path) -> None:
    media = tmp_path / "media"
    out = _scratch(
        tmp_path,
        _info(authored=["en"], machine=["en-orig"]),
        {"original.en.vtt": AUTHORED, "original.en-orig.vtt": MACHINE},
    )
    steps = FetchStepsImpl(
        config=CFG,
        audio=AlignStepsImpl(config=CFG, adapters=Adapters(), reporter=Reporter()),
        reporter=Reporter(),
        store=LocalArtifactStore(Roots.under(str(media))),
    )
    audio = AudioRef(path=str(out / "original.webm"), duration_sec=200.0)
    ref = await steps.publish_original(_job(media), audio, Identified(source="none"))
    assert ref == "audio/m1.webm"
    assert (media / "audio" / "m1.webm").read_bytes() == b"audio"
    assert (media / "derived/captions/captions/m1.captions.vtt").read_text() == AUTHORED
    assert (media / "derived/captions/auto-captions/m1.captions.vtt").read_text() == MACHINE


def test_a_fetch_completion_reports_the_kept_files_size(tmp_path: Path) -> None:
    from encore_worker.__main__ import _fetch_completion  # noqa: PLC0415
    from encore_worker.protocol import frames as f  # noqa: PLC0415
    from encore_worker.workflows.fetch import FetchOutcome  # noqa: PLC0415

    _kept(tmp_path, authored=None, audio=b"x" * 1234)
    done = FetchOutcome(published="audio/m1.webm", identified=Identified(), why="ok")
    frame = _fetch_completion(_job(tmp_path), CFG, done)
    assert isinstance(frame, f.Complete) and frame.artifacts == {"original": {"bytes": 1234}}


def _kept(media: Path, *, authored: str | None, audio: bytes = b"audio") -> None:
    (media / "audio").mkdir(parents=True)
    (media / "audio" / "m1.webm").write_bytes(audio)
    if authored is not None:
        track = media / "derived/captions/captions/m1.captions.vtt"
        track.parent.mkdir(parents=True)
        track.write_text(authored)


#: The params core sends for a kept original: its ref is the source, its size as fetched (5 = len(b"audio")).
KEPT = {"fetcher": "local", "remoteUri": WATCH, "originalBytes": 5}


async def test_align_reads_a_kept_track_and_runs_no_caption_call(tmp_path: Path) -> None:
    media = tmp_path / "media"
    _kept(media, authored=AUTHORED)
    captions = NoCaptionCalls()
    steps = AlignStepsImpl(config=CFG, adapters=Adapters(captions=captions), reporter=Reporter())
    job = JobRef("j1", "m1", str(media), "audio/m1.webm", KEPT)
    got = await steps.fetch_captions(job, automatic=False)
    assert got is not None and [s["text"] for s in got.segments] == ["written by a person"]
    machine = await steps.fetch_captions(job, automatic=True)
    assert machine is None, "no kept machine track: the upload has none"
    assert captions.asked == []


async def test_a_worker_without_the_volume_falls_back_to_the_watch_url(tmp_path: Path) -> None:
    """A second machine cannot see core's media volume: it downloads, as every worker did before."""
    media = tmp_path / "elsewhere"
    media.mkdir()
    captions, fetcher = NoCaptionCalls(), RecordingFetcher()
    adapters = Adapters(captions=captions, fetcher=fetcher)
    steps = AlignStepsImpl(config=CFG, adapters=adapters, reporter=Reporter())
    job = JobRef("j1", "m1", str(media), "audio/m1.webm", KEPT)
    audio = await steps.acquire_audio(job)
    assert fetcher.asked == [WATCH] and audio.path.endswith("original.webm")
    assert await steps.fetch_captions(job, automatic=False) is not None
    assert captions.asked == [WATCH]


async def test_a_kept_original_is_read_from_the_volume_without_a_download(tmp_path: Path) -> None:
    media = tmp_path / "media"
    _kept(media, authored=None)
    fetcher = RecordingFetcher()
    steps = AlignStepsImpl(config=CFG, adapters=Adapters(fetcher=fetcher), reporter=Reporter())
    job = JobRef("j1", "m1", str(media), "audio/m1.webm", KEPT)
    audio = await steps.acquire_audio(job)
    assert audio.path == str(media / "audio" / "m1.webm")
    assert fetcher.asked == []


@pytest.mark.parametrize("kept_bytes", [b"", b"aud"], ids=["empty", "truncated"])
async def test_a_kept_file_of_another_size_is_never_used(tmp_path: Path, kept_bytes: bytes) -> None:
    """A restore or a copy that hit a full disk can leave a short file; the watch URL is used instead."""
    media = tmp_path / "media"
    _kept(media, authored=AUTHORED, audio=kept_bytes)
    captions, fetcher = NoCaptionCalls(), RecordingFetcher()
    adapters = Adapters(captions=captions, fetcher=fetcher)
    steps = AlignStepsImpl(config=CFG, adapters=adapters, reporter=Reporter())
    job = JobRef("j1", "m1", str(media), "audio/m1.webm", KEPT)
    audio = await steps.acquire_audio(job)
    assert fetcher.asked == [WATCH] and audio.path != str(media / "audio" / "m1.webm")
    await steps.fetch_captions(job, automatic=False)
    assert captions.asked == [WATCH], "its kept tracks are not trusted either"


async def test_a_kept_file_with_no_recorded_size_is_never_used(tmp_path: Path) -> None:
    media = tmp_path / "media"
    _kept(media, authored=None)
    fetcher = RecordingFetcher()
    steps = AlignStepsImpl(config=CFG, adapters=Adapters(fetcher=fetcher), reporter=Reporter())
    job = JobRef("j1", "m1", str(media), "audio/m1.webm", {"fetcher": "local", "remoteUri": WATCH})
    await steps.acquire_audio(job)
    assert fetcher.asked == [WATCH]


@pytest.mark.parametrize("automatic", [False, True], ids=["authored", "machine"])
async def test_a_library_song_makes_no_caption_call(tmp_path: Path, automatic: bool) -> None:
    """Local with no `remoteUri` is a library file: with no upload, neither track is asked for (#1160)."""
    media = tmp_path / "media"
    (media / "library").mkdir(parents=True)
    (media / "library" / "song.flac").write_bytes(b"flac")
    captions = NoCaptionCalls()
    steps = AlignStepsImpl(config=CFG, adapters=Adapters(captions=captions), reporter=Reporter())
    job = JobRef("j1", "m1", str(media), "library/song.flac", {"fetcher": "local"})
    assert await steps.fetch_captions(job, automatic=automatic) is None
    assert captions.asked == []
