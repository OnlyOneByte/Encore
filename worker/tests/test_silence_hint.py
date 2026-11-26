"""#1131: a silent instrumental from demucs at `-j` above 1 is refused with the setting named, so the
operator knows the one knob to try. The stem here is a real all-zero WAV, separated through the real
`SeparateStepsImpl` and measured by the worker's own `FfmpegProbe` where ffmpeg is on PATH (else a stdlib
reader of the same file).
"""

from __future__ import annotations

import array
import math
import shutil
import wave
from pathlib import Path
from typing import Any

import pytest

from encore_worker.adapters.cli import FfmpegProbe
from encore_worker.adapters.separate import Stems
from encore_worker.host.config import Config
from encore_worker.steps.records import AudioRef, JobRef, PublishedStems
from encore_worker.steps.separate_steps import SeparateStepsImpl
from encore_worker.workflows.stems import SilentInstrumental, run_stems


def _zeros(path: Path, seconds: float = 1.0, rate: int = 44_100) -> None:
    """A stereo 16-bit WAV of digital silence: what a NaN-zeroed demucs chunk saves as (#1125)."""
    with wave.open(str(path), "wb") as out:
        out.setnchannels(2)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(bytes(4 * int(seconds * rate)))


class ZeroStemDemucs:
    """A torch-demucs stand-in that "succeeds" with all-zero stems, at a chosen `-j`."""

    name = "demucs"
    model = "htdemucs"

    def __init__(self, jobs: int) -> None:
        self.jobs = jobs
        self.threads = 0

    def separate(self, input_wav: str, out_dir: str, *, on_progress: Any = None) -> Stems:
        base = Path(out_dir) / "htdemucs" / "input"
        base.mkdir(parents=True)
        _zeros(base / "no_vocals.wav")
        _zeros(base / "vocals.wav")
        return Stems(str(base / "no_vocals.wav"), str(base / "vocals.wav"), engine="demucs")


class WavPeak:
    """Peak dBFS of a 16-bit WAV, read with the standard library, for a box without ffmpeg."""

    def peak_dbfs(self, audio_path: str) -> float | None:
        with wave.open(audio_path, "rb") as got:
            samples = array.array("h", got.readframes(got.getnframes()))
        peak = max((abs(s) for s in samples), default=0)
        return -math.inf if peak == 0 else 20 * math.log10(peak / 32768)


class Reporter:
    async def progress(self, job_id: str, stage: Any, pct: int) -> None:
        return None

    async def state(self, *args: Any) -> None:
        return None


class Steps:
    """The stems flow with the real separate and probe steps; the rest are not what this tests."""

    def __init__(self, impl: SeparateStepsImpl) -> None:
        self.impl = impl
        self.published = False

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        return AudioRef(path="/media/m1/original.mp3", duration_sec=1.0)

    async def decode_to_wav(self, job: JobRef, audio: AudioRef) -> str:
        return "/media/m1/input.wav"

    async def separate(self, job: JobRef, input_wav: str) -> AudioRef:
        return await self.impl.separate(job, input_wav)

    async def probe_silence(self, job: JobRef, audio: AudioRef) -> float | None:
        return await self.impl.probe_silence(job, audio)

    async def measure_profile(self, job: JobRef, audio: AudioRef) -> dict[str, object]:
        return {}

    async def publish_stems(self, job: JobRef, audio: AudioRef) -> PublishedStems:
        self.published = True
        return PublishedStems(instrumental="derived/stems/m1-instrumental.flac")


PROBES = [pytest.param(WavPeak(), id="stdlib")]
if shutil.which("ffmpeg"):
    PROBES.append(pytest.param(FfmpegProbe(), id="ffmpeg"))


def _steps(tmp_path: Path, jobs: int, probe: Any) -> Steps:
    media = tmp_path / "media"
    impl = SeparateStepsImpl(
        config=Config(media_dir=str(media)),
        audio=None,  # type: ignore[arg-type]  # acquisition is the wrapper's, above
        reporter=Reporter(),  # type: ignore[arg-type]
        store=None,  # type: ignore[arg-type]  # nothing is published
        separator=ZeroStemDemucs(jobs),
        probe=probe,
    )
    return Steps(impl)


@pytest.mark.parametrize("probe", PROBES)
async def test_an_all_zero_stem_at_j4_is_refused_naming_the_setting(tmp_path: Path, probe: Any) -> None:
    steps = _steps(tmp_path, jobs=4, probe=probe)
    job = JobRef(job_id="j1", media_id="m1", media_dir=str(tmp_path / "media"))
    with pytest.raises(SilentInstrumental) as refused:
        await run_stems(job, steps)
    assert "(demucs -j 4; try ENCORE_DEMUCS_JOBS=1)" in str(refused.value)
    assert not steps.published, "a silent instrumental is never published"


@pytest.mark.parametrize("probe", PROBES)
async def test_at_j1_the_refusal_names_no_setting(tmp_path: Path, probe: Any) -> None:
    """At -j 1 there is no pool to blame, so the message stays as it was."""
    steps = _steps(tmp_path, jobs=1, probe=probe)
    job = JobRef(job_id="j1", media_id="m1", media_dir=str(tmp_path / "media"))
    with pytest.raises(SilentInstrumental) as refused:
        await run_stems(job, steps)
    assert "silence floor" in str(refused.value) and "ENCORE_DEMUCS_JOBS" not in str(refused.value)


def test_a_separation_checkpointed_before_the_field_existed_still_reads() -> None:
    """DBOS unpickles an `AudioRef` written by an older worker without `demucs_jobs`; it reads as None."""
    old = object.__new__(AudioRef)
    old.__setstate__(("/w/no_vocals.wav", 200.0, "/w/vocals.wav"))
    assert old.demucs_jobs is None and old.vocals_path == "/w/vocals.wav"
