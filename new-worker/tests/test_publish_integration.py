"""`publish_stems` for real: real ffmpeg, real filesystem, files landing at core's keys.

WHAT THIS CATCHES THAT NOTHING ELSE DOES. Every other stems test fakes `publish_stems` entirely, so the
whole publication path — encode, place, report — was covered by a fake returning a plausible string. That
is exactly how the original bug survived: `publish_stems` was
`os.path.relpath(audio.path, job.media_dir)`, which returns a ref-SHAPED string pointing into `work/`
scratch, and every test that asserted "it looks like a ref" passed.

So the assertions here are about the FILESYSTEM, not the return value: does a file exist at the key core
computes, is it in the published format, and does the guide mix actually carry four channels. A returned
ref that no file backs is the failure mode.

Needs ffmpeg, not models — so it stays in the fast suite on any box with ffmpeg, and skips loudly elsewhere.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from encore_worker.artifacts import keys
from encore_worker.artifacts.local import LocalArtifactStore, Roots
from encore_worker.host.config import Config
from encore_worker.protocol.vocabulary import Stage
from encore_worker.steps.api import NotOurJob
from encore_worker.steps.records import AudioRef, JobRef
from encore_worker.steps.separate_steps import SeparateStepsImpl

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not on PATH")

MEDIA_ID = "m-abc123"


class Reporter:
    """Records what the steps told the core, and answers the ownership question."""

    def __init__(self, *, owns: bool = True) -> None:
        self.owns = owns
        self.states: list[tuple[str, str, str]] = []

    async def progress(self, job_id: str, stage: Stage, pct: int) -> None:
        return None

    async def state(
        self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        self.states.append((state, verdict, why))

    async def confirm_ownership(self, job_id: str, *, timeout_sec: float = 10.0) -> bool:
        return self.owns

    def explain_ownership(self, job_id: str) -> str:
        return "not ours (test)"


def tone(path: Path, freq: int, seconds: float = 1.0) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={freq}:duration={seconds}",
            "-ar",
            "44100",
            "-ac",
            "2",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return str(path)


def probe(path: str, entry: str) -> str:
    out = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            f"stream={entry}",
            "-of",
            "csv=p=0",
            path,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return out.stdout.strip()


@pytest.fixture
def media(tmp_path: Path) -> Path:
    return tmp_path / "media"


def steps_for(media: Path, reporter: Reporter) -> SeparateStepsImpl:
    """A real `SeparateStepsImpl` with only the parts publication needs.

    `audio` and `separator` are None-ish because nothing here calls them: the point is the publish step,
    reached with a hand-built `AudioRef` standing in for what a separator produced.
    """
    return SeparateStepsImpl(
        config=Config(media_dir=str(media)),
        audio=None,  # type: ignore[arg-type]  # unused on this path; publication never calls it
        reporter=reporter,
        store=LocalArtifactStore(Roots.under(str(media))),
    )


def separated(media: Path, *, with_vocals: bool = True) -> AudioRef:
    """What a separator leaves in job scratch: raw WAV under `work/`, NOT in the published format."""
    work = media / "work" / "j1"
    return AudioRef(
        path=tone(work / "no_vocals.wav", 220),
        duration_sec=1.0,
        vocals_path=tone(work / "vocals.wav", 880) if with_vocals else None,
    )


def job(media: Path) -> JobRef:
    return JobRef(job_id="j1", media_id=MEDIA_ID, media_dir=str(media))


# ── the happy path ───────────────────────────────────────────────────────────────────────────────


async def test_all_three_stems_land_at_cores_keys(media: Path) -> None:
    """THE test the original bug would have failed. Asserts files on disk at the keys core COMPUTES, not
    that the returned strings look plausible."""
    published = await steps_for(media, Reporter()).publish_stems(job(media), separated(media))

    assert published.instrumental == keys.instrumental_key(MEDIA_ID)
    assert published.vocals == keys.vocals_key(MEDIA_ID)
    assert published.guide_mix == keys.guide_mix_key(MEDIA_ID)

    for ref in (published.instrumental, published.vocals, published.guide_mix):
        assert ref is not None
        on_disk = media / ref
        assert on_disk.is_file(), f"reported {ref} but no file is there"
        assert on_disk.stat().st_size > 0


async def test_nothing_is_published_into_job_scratch(media: Path) -> None:
    """The ORIGINAL BUG, asserted directly. `work/` is transient — retention evicts it — so a ref pointing
    there is a row that looks healthy and a song that stops working later."""
    published = await steps_for(media, Reporter()).publish_stems(job(media), separated(media))
    for ref in (published.instrumental, published.vocals, published.guide_mix):
        assert ref is not None
        assert not ref.startswith("work/"), f"{ref} points into job scratch"
        assert ref.startswith("derived/stems/"), f"{ref} is not under the derived storage class"


async def test_the_published_stems_are_flac_not_the_scratch_wav(media: Path) -> None:
    """Core's ext is recorded forever and the player resolves `/media/${ref}`. Publishing the scratch WAV
    under a `.flac` key gives a file that exists and a decode that fails."""
    published = await steps_for(media, Reporter()).publish_stems(job(media), separated(media))
    assert published.instrumental.endswith(".flac")
    assert probe(str(media / published.instrumental), "codec_name") == "flac"


async def test_the_guide_mix_carries_both_stems_as_four_channels(media: Path) -> None:
    """Verified through ffprobe rather than asserted from argv: four channels is what the TV's
    `ChannelSplitter` relies on, and a collapsed layout is inaudible in review."""
    published = await steps_for(media, Reporter()).publish_stems(job(media), separated(media))
    assert published.guide_mix is not None
    assert probe(str(media / published.guide_mix), "channels") == "4"


async def test_published_stems_are_stereo(media: Path) -> None:
    published = await steps_for(media, Reporter()).publish_stems(job(media), separated(media))
    assert probe(str(media / published.instrumental), "channels") == "2"
    assert published.vocals is not None
    assert probe(str(media / published.vocals), "channels") == "2"


async def test_the_scratch_stems_are_left_out_of_the_store(media: Path) -> None:
    """Only `derived/stems/` should hold published bytes. A stray copy elsewhere is unreferenced, so
    retention never evicts it."""
    await steps_for(media, Reporter()).publish_stems(job(media), separated(media))
    published_dir = media / "derived" / "stems"
    assert sorted(p.name for p in published_dir.iterdir()) == [
        f"{MEDIA_ID}-guidemix.flac",
        f"{MEDIA_ID}-instrumental.flac",
        f"{MEDIA_ID}-vocals.flac",
    ]


async def test_no_staging_litter_survives(media: Path) -> None:
    """The store stages inside the destination directory, so a leftover `.publishing-*` would sit in a real
    media directory that nothing knows to clean."""
    await steps_for(media, Reporter()).publish_stems(job(media), separated(media))
    assert list((media / "derived" / "stems").glob(".publishing-*")) == []


# ── degraded and refused ─────────────────────────────────────────────────────────────────────────


async def test_a_separation_with_no_vocals_still_publishes_the_instrumental(media: Path) -> None:
    """Some engines emit only the instrumental. That is a usable karaoke track, so refusing the whole
    publication would throw away a completed separation over a missing extra."""
    published = await steps_for(media, Reporter()).publish_stems(
        job(media), separated(media, with_vocals=False)
    )
    assert (media / published.instrumental).is_file()
    assert published.vocals is None
    assert published.guide_mix is None, "no vocals means no 4-channel join is possible"


async def test_a_failed_guide_mix_does_not_lose_the_stems(media: Path) -> None:
    """The guide mix is built FROM the stems, so its failure must not discard them — the TV falls back to
    the two-element guide. The degradation is recorded on the job row rather than only in a process log."""
    reporter = Reporter()
    steps = steps_for(media, reporter)
    import unittest.mock

    from encore_worker.adapters.encode import EncodeFailed

    with unittest.mock.patch.object(steps._encoder, "guide_mix", side_effect=EncodeFailed("no quad for you")):
        published = await steps.publish_stems(job(media), separated(media))

    assert (media / published.instrumental).is_file()
    assert published.vocals is not None and (media / published.vocals).is_file()
    assert published.guide_mix is None
    assert any("guide mix unavailable" in why for _s, _v, why in reporter.states), (
        "a degraded publish must be explainable from the job row"
    )


async def test_a_lost_lease_publishes_nothing_at_all(media: Path) -> None:
    """Separation takes tens of minutes, so a lease valid at the start routinely is not at the end. The
    check is BEFORE any bytes are placed — two workers publishing different stems for one song is the whole
    failure being prevented."""
    steps = steps_for(media, Reporter(owns=False))
    with pytest.raises(NotOurJob):
        await steps.publish_stems(job(media), separated(media))
    assert not (media / "derived").exists(), "nothing may be visible after a refused publish"


# ── the format is a parameter, because core names it ─────────────────────────────────────────────


async def test_the_published_ext_follows_the_configured_format(media: Path) -> None:
    """Core owns the storage layout and announces the format. A worker that hardcoded `flac` would write a
    file core's recorded ref does not name."""
    steps = SeparateStepsImpl(
        config=Config(media_dir=str(media), publish_stem_format="wav"),
        audio=None,  # type: ignore[arg-type]
        reporter=Reporter(),
        store=LocalArtifactStore(Roots.under(str(media))),
    )
    published = await steps.publish_stems(job(media), separated(media))
    assert published.instrumental == keys.instrumental_key(MEDIA_ID, "wav")
    assert published.instrumental.endswith(".wav")
    assert (media / published.instrumental).is_file()


async def test_publishing_twice_is_idempotent(media: Path) -> None:
    """A durable step can be retried after its bytes landed. The second run must win cleanly rather than
    leaving a job that can never complete once it partially succeeded."""
    steps = steps_for(media, Reporter())
    first = await steps.publish_stems(job(media), separated(media))
    second = await steps.publish_stems(job(media), separated(media))
    assert first == second
    assert os.path.getsize(media / second.instrumental) > 0
