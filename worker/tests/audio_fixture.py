"""Real audio, synthesised locally with macOS `say`, for the tests that drive real models.

A committed recording is a licence problem and a permanent large binary, and `ffmpeg`'s sine wave has no
words for a model to transcribe at all; synthesised speech has a KNOWN transcript, so an assertion can be
about accuracy. Skips rather than fails when the tools are absent: a box with no `say` has discovered
nothing about the code.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

#: Deliberately plain, clearly-articulated words. A tongue-twister would make a transcription failure
#: ambiguous between "the adapter is broken" and "the model mis-heard", and only the first is our bug.
SPOKEN_LINES = (
    "The morning light is breaking over the hill",
    "I can hear the river running far below",
    "Nothing in this valley ever stays the same",
)


@dataclass(frozen=True, slots=True)
class Spoken:
    """A synthesised utterance and what was said, so a test can assert on accuracy."""

    path: str
    lines: tuple[str, ...]
    duration_sec: float

    @property
    def text(self) -> str:
        return " ".join(self.lines)


def have_tools() -> bool:
    return bool(shutil.which("say") and shutil.which("ffmpeg"))


def require_tools() -> None:
    if not have_tools():
        pytest.skip("needs macOS `say` and `ffmpeg` to synthesise real audio")


def speak(into: Path, *, lines: tuple[str, ...] = SPOKEN_LINES, rate: int = 150) -> Spoken:
    """Synthesise `lines` into a 16 kHz mono WAV and report what was said.

    16 kHz mono is what whisper and wav2vec2 resample to internally, so a failure is about the model and
    not about a resample this fixture introduced. `rate=150` is slower than the default because at the
    default the words run together enough to make a word-boundary assertion ambiguous.
    """
    require_tools()
    aiff = into.with_suffix(".aiff")
    wav = into.with_suffix(".wav")
    subprocess.run(  # noqa: S603 - fixed argv, no shell
        ["say", "-r", str(rate), "-o", str(aiff), " ... ".join(lines)],
        check=True,
        capture_output=True,
        timeout=120,
    )
    subprocess.run(  # noqa: S603
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(aiff),
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(wav),
        ],
        check=True,
        capture_output=True,
        timeout=120,
    )
    aiff.unlink(missing_ok=True)
    return Spoken(path=str(wav), lines=lines, duration_sec=_duration_of(wav))


def _duration_of(wav: Path) -> float:
    """Read the duration back from the file rather than predicting it from the text.

    Predicting would embed an assumption about the voice's speaking rate, which differs per machine and
    per macOS version — and a wrong duration would make coverage assertions fail for the wrong reason.
    """
    from encore_worker.adapters.cli import FfmpegProbe

    return FfmpegProbe().duration_sec(str(wav))


def line_segments(spoken: Spoken) -> tuple[dict[str, object], ...]:
    """The spoken lines as untimed segments — the shape a plain lyrics sheet arrives in.

    Untimed on purpose: this is the input a forced aligner is supposed to place onto audio, so handing it
    timings would test nothing. The aligner has to find them.
    """
    return tuple({"text": line} for line in spoken.lines)
