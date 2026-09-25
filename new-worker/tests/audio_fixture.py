"""Real audio, synthesised locally, for tests that drive real models.

WHY SYNTHESISE RATHER THAN COMMIT A FIXTURE. A checked-in audio file of a song is a licensing problem, and
a checked-in recording of a voice is a large binary in a git history that will never be deleted. macOS
ships `say`, so a test can generate speech with KNOWN WORDS at a known length — which is better than a
real recording anyway: the expected transcript is exactly what we asked to be spoken, so an assertion can
be about accuracy rather than about whatever the fixture happened to contain.

A TONE WOULD NOT DO. The obvious cheap fixture — `ffmpeg -f lavfi -i sine` — produces audio with no words,
so whisper transcribes nothing and every assertion passes vacuously. That is the shape of a test that
proves the plumbing and nothing about the model.

Skips rather than fails when the tools are absent: a Linux CI box has no `say`, and a test that cannot get
its input has not discovered anything about the code.
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

    16 kHz mono because that is what whisper and wav2vec2 resample to internally; handing them that
    directly means a failure is about the model rather than about a resample this test introduced.

    `rate=150` is a little slower than the default. Not cosmetic: at the default rate the words run
    together enough that word-level alignment boundaries become genuinely ambiguous, which would make an
    assertion about word timing flaky for a reason that has nothing to do with the adapter.
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
