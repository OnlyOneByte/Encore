"""Every heavy seam, as a Protocol. The ONLY thing `steps/` may depend on.

PROTOCOLS AND NOT BASE CLASSES, structurally typed, so a fake imports nothing from here and the whole align
path runs with no torch, no whisperx, no network and no yt-dlp. EVERY PORT RETURNS PLAIN DATA — paths, refs
and records — because a `@DBOS.step` checkpoints its return value into SQLite. `docs/arch/05-worker.md` §1.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from encore_worker.domain.document import Segment

__all__ = [
    "Aligner",
    "AudioFetcher",
    "AudioProbe",
    "CaptionSource",
    "Diarizer",
    "InfraFault",
    "LyricsProvider",
    "ProgressSink",
    "Segment",
    "SeparationResult",
    "Separator",
    "Transcribed",
    "Transcriber",
]


class InfraFault(RuntimeError):
    """The MACHINERY failed, not the text: a model that would not load, a kernel the library no longer
    ships, an accelerator that raised, audio ffmpeg would not decode.

    THE PORT'S HALF OF A CONTRACT: an adapter raises it for the failure modes only it can recognise and every
    step lets it through, so the JOB fails rather than the ladder declining text after text
    (`docs/arch/05-worker.md` §8). Retryable by default; the deterministic ones say so by subclass.
    """

    retryable = True


@dataclass(frozen=True, slots=True)
class Transcribed:
    """What a transcriber heard: the segments, AND the language it heard them in.

    THE LANGUAGE IS HALF THE RETURN VALUE because whisper measures it from the recording and nothing else on
    this worker can (docs/arch/04-alignment.md §9). `language` is None when the transcriber cannot say, never
    `"en"` as a stand-in: `detect` treats None as "no signal" and a wrong signal as evidence.
    """

    segments: tuple[Segment, ...]
    language: str | None = None

    def __bool__(self) -> bool:
        """Truthy exactly when something was heard, so `if not heard:` reads as it did for a list."""
        return bool(self.segments)


@runtime_checkable
class Transcriber(Protocol):
    """Speech-to-text over an audio file. Whisper, in practice, and the mandatory fallback tier: its output
    is derived from THIS recording (docs/arch/04-alignment.md §3)."""

    def transcribe(self, audio_path: str, *, language: str | None = None) -> Transcribed:
        """Segments with `start`, `end` and `text`, plus the language heard. Empty when nothing intelligible.

        Returning empty is a RESULT, not an error; raise only where transcription could not be ATTEMPTED.
        `language` ASKS for one and is forwarded, so an operator who declared one gets a constrained decode.
        """
        ...


@runtime_checkable
class Aligner(Protocol):
    """Forced alignment: put a known text onto this recording's clock. whisperX, in practice, and `search`
    carries the spans it may look within — what `Knob.DROP_WINDOWS` widens."""

    def align(self, search: Sequence[Segment], audio_path: str, language: str) -> Sequence[Segment]:
        """Word-timed segments. Raise when alignment could not produce word timings at all.

        EVERY SEARCH SEGMENT MUST CARRY `start` AND `end`, whisperx cropping the audio per segment, so
        untimed text needs provisional spans from `domain.lyrics.place.spread_over` first. Raising beats
        returning empty: "no words" from an aligner handed real text is the aligner's failure.
        """
        ...


@runtime_checkable
class Separator(Protocol):
    """Source separation into an instrumental and a vocals stem. demucs / demucs-mlx / roformer.

    `separate` takes a progress callback rather than returning only at the end, because it runs for tens of
    minutes and that callback is how the lease stays alive (docs/arch/05-worker.md §7).
    """

    @property
    def name(self) -> str:
        """The engine's identity, recorded on the completion facts. What RAN, never what was asked."""
        ...

    def separate(
        self, input_wav: str, out_dir: str, *, on_progress: ProgressSink | None = None
    ) -> SeparationResult: ...


@runtime_checkable
class Diarizer(Protocol):
    """Who sang which line. pyannote, in practice. Optional: a failure degrades, never fails a job."""

    def diarize(self, audio_path: str) -> Sequence[Segment]:
        """Speaker-attributed spans, or empty when the question could not be answered."""
        ...


@runtime_checkable
class LyricsProvider(Protocol):
    """A lookup for a song's words by metadata. LRCLIB, in practice."""

    @property
    def name(self) -> str: ...

    def fetch(self, *, artist: str, track: str, duration_sec: float | None) -> Sequence[Segment]:
        """Segments for this song, or empty when the provider has nothing.

        Empty and RAISING mean different things and both are load-bearing: "does not have this song" against
        "could not be reached", which a provider down for a month made indistinguishable.
        """
        ...


@runtime_checkable
class CaptionSource(Protocol):
    """The upload's own caption tracks. yt-dlp, in practice."""

    def fetch(self, source_uri: str, out_dir: str, *, automatic: bool) -> Sequence[Segment]:
        """Cues from the authored (`automatic=False`) or machine (`automatic=True`) track. Never raises for a
        missing one: an upload with no captions is the common case."""
        ...


@runtime_checkable
class AudioFetcher(Protocol):
    """Getting the bytes. yt-dlp for a remote source; a declared-local source is already on disk."""

    def fetch(self, source_uri: str, out_dir: str, *, on_progress: ProgressSink | None = None) -> str:
        """The path of the downloaded audio. Raises when the source is unreachable or refused."""
        ...


@runtime_checkable
class AudioProbe(Protocol):
    """Measuring audio without decoding it into memory. ffprobe / ffmpeg, in practice."""

    def duration_sec(self, audio_path: str) -> float: ...

    def peak_dbfs(self, audio_path: str) -> float | None:
        """Loudest sample in dBFS, or None when it could not be measured — and None must NOT be collapsed
        to a number: 0.0 dBFS is full scale, so a silence guard would then pass everything."""
        ...


class ProgressSink(Protocol):
    """Called with 0..100 while a long port runs. Synchronous and cheap by contract, and a plain callable
    rather than an async one: a port runs inside `asyncio.to_thread`, where awaiting is not available."""

    def __call__(self, pct: int) -> None: ...


class SeparationResult(Protocol):
    """Where a separator put its output. A Protocol so each engine can return its own record type."""

    @property
    def instrumental_path(self) -> str: ...

    @property
    def vocals_path(self) -> str | None:
        """None when the engine produced no isolated vocals; alignment then falls back to the mix through
        `Knob.ALIGN_ON_MIX`, an explicit retry rather than a silent degradation."""
        ...
