"""Every heavy seam, as a Protocol. The ONLY thing `steps/` may depend on.

WHY PROTOCOLS AND NOT BASE CLASSES. A step takes the port it needs as an argument, so a test hands in a
fake and the whole align path runs with no torch, no whisperx, no network and no yt-dlp. The old worker
proved this pattern works — its 19k-line suite fakes every heavy seam — and it is the reason
`uv sync --only-group dev` installs twelve packages instead of several gigabytes.

Structural typing specifically: a fake in a test file does not import anything from here, it just has
the right methods. That keeps the test tree independent of this module's inheritance graph.

EVERY PORT RETURNS PLAIN DATA. A `@DBOS.step` checkpoints its return value into SQLite, so a port that
handed back a tensor, an open file or a model handle would make the step unserializable. Ports return
paths, refs and records; bytes stay on disk under the media directory.
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
    """The MACHINERY failed, not the text: a model that would not download or load, a kernel the installed
    library no longer ships, an accelerator that raised, the job's own audio that ffmpeg would not decode.

    THE PORT'S HALF OF A CONTRACT. An adapter raises this for the failure modes only it can recognise, and
    every step lets it through, so the JOB fails (`transport.Client` sends `retryable` from the class). A
    step still catches everything else an attempt can raise, because a decoder refusing THIS text (more
    characters than frames) or a language with no alignment model is one attempt failing, and the ladder
    has other texts and knobs to try.

    WHY IT HAD TO EXIST (review M7). Every raise inside an attempt used to be a decline, so a fault that
    fails every attempt identically walked the whole ladder and ended as a lyric outcome. Measured through
    the real `AlignStepsImpl` + `run_align` with an aligner whose model download answers HTTP 503: untimed
    authored captions, a machine track and a transcriber that hears every word gave 7 declines, the machine
    track tried twice (review s11), whisper run, and a published `noLyrics`; with TIMED captions the same
    503 published a line-synced document, word timing lost behind one trail note.

    `retryable = True`: the honest default for machinery, where a download, a device error or an ffmpeg
    read are all worth another attempt. The deterministic ones say so by subclass (`ml.ModelUnavailable`,
    `cli.OutOfMemory`), as the codebase's other terminal failures do.
    """

    retryable = True


@dataclass(frozen=True, slots=True)
class Transcribed:
    """What a transcriber heard: the segments, AND the language it heard them in (review M8, W7).

    THE LANGUAGE IS HALF THE RETURN VALUE because whisper measures it from the recording and nothing else
    on this worker can. It used to be read off whisper's own result dict and dropped on the floor
    (`ml.WhisperTranscriber.transcribe` kept only `result["segments"]`), which is a third of review M8: the
    one signal that is an acoustic MEASUREMENT rather than a guess from the glyphs was the one discarded, so
    a Japanese upload with no lyrics sheet had whisper's `ja` in hand and still aligned as `en`.

    PLAIN DATA, like every port's return: a `@DBOS.step` checkpoints it into SQLite.

    `language` is None when the transcriber cannot say (a fake, a backend that reports none) — never `"en"`
    as a stand-in, because `domain.lyrics.language.detect` treats None as "no signal" and a wrong signal as
    evidence.
    """

    segments: tuple[Segment, ...]
    language: str | None = None

    def __bool__(self) -> bool:
        """Truthy exactly when something was heard, so `if not heard:` reads as it did when this was a
        list."""
        return bool(self.segments)


@runtime_checkable
class Transcriber(Protocol):
    """Speech-to-text over an audio file. Whisper, in practice.

    The measurement that makes `Tier.ASR` the mandatory fallback: its output is derived from THIS
    recording, so it can be neither the wrong song nor misplaced in time.
    """

    def transcribe(self, audio_path: str, *, language: str | None = None) -> Transcribed:
        """Segments with `start`, `end` and `text`, plus the language heard. Empty when nothing intelligible.

        Returning empty is a RESULT, not an error — an instrumental has nothing to transcribe. Raise
        only when transcription could not be attempted (no model, unreadable audio).

        `language` ASKS for a language and is still forwarded: an operator who declared one gets whisper's
        constrained decode, and `Transcribed.language` then echoes it. Left unset, whisper detects, and that
        detection is the point of the return type (review M8).
        """
        ...


@runtime_checkable
class Aligner(Protocol):
    """Forced alignment: put a known text onto this recording's clock. whisperX, in practice.

    The component both reported defects run through. `search` carries the spans the aligner may look
    within, which is what `Knob.DROP_WINDOWS` widens.
    """

    def align(self, search: Sequence[Segment], audio_path: str, language: str) -> Sequence[Segment]:
        """Word-timed segments. Raise when alignment could not produce word timings at all.

        EVERY SEARCH SEGMENT MUST CARRY `start` AND `end`. whisperx crops the audio per segment, so an
        untimed one is not merely unhelpful — it raises inside the aligner. A caller holding untimed text
        (a plain lyrics sheet has no timings by definition) must give it provisional spans first; see
        `domain.lyrics.place.spread_over`.

        Raising is correct rather than returning empty: the caller's fallback is a DIFFERENT strategy
        (line sync, or the next text), and "no words" from an aligner handed real text is a failure of
        the aligner, not a fact about the song.
        """
        ...


@runtime_checkable
class Separator(Protocol):
    """Source separation into an instrumental and a vocals stem. demucs / demucs-mlx / roformer.

    `separate` is the long one — tens of minutes on a real song — so it takes a progress callback
    rather than returning only at the end. The callback is how the lease stays alive; see
    `transport/` for why a quiet long step is what the old worker's reaper mistook for a dead job.
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

        Empty and RAISING mean different things and both are load-bearing: empty is "this provider does
        not have this song", raising is "this provider could not be reached". The old worker learned
        this the hard way — a provider failing for a month was indistinguishable from a library of
        instrumentals, because both produced no text.
        """
        ...


@runtime_checkable
class CaptionSource(Protocol):
    """The upload's own caption tracks. yt-dlp, in practice."""

    def fetch(self, source_uri: str, out_dir: str, *, automatic: bool) -> Sequence[Segment]:
        """Cues from the authored (`automatic=False`) or machine (`automatic=True`) track.

        Never raises for a missing track: an upload with no captions is the common case, not an error.
        """
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
        """Loudest sample in dBFS, or None when it could not be measured.

        None must NOT be collapsed to a number by any implementation. 0.0 dBFS is a legitimate reading
        (full scale), so using it for "unmeasured" makes a failed measurement read as the loudest
        possible signal — which is how a silence guard comes to pass everything.
        """
        ...


class ProgressSink(Protocol):
    """Called with 0..100 while a long port runs. Synchronous and cheap by contract.

    A plain callable, not an async one: a port implementation runs inside `asyncio.to_thread` (torch is
    synchronous and blocks the event loop otherwise), and awaiting from that thread is not available.
    The step bridges these onto the durable stream the transport reads.
    """

    def __call__(self, pct: int) -> None: ...


class SeparationResult(Protocol):
    """Where a separator put its output. A Protocol so each engine can return its own record type."""

    @property
    def instrumental_path(self) -> str: ...

    @property
    def vocals_path(self) -> str | None:
        """None when the engine produced no isolated vocals. Alignment then falls back to the mix,
        which `Knob.ALIGN_ON_MIX` makes an explicit retry rather than a silent degradation."""
        ...
