"""The real `SeparateSteps`, and the fetch flow's steps. Thin shells, same as `align_steps`.

Shares `acquire_audio` with the align implementation by DELEGATION rather than inheritance: a stems job
and an align job acquire audio identically, and a subclass would make that identity a structural claim
that a later divergence would silently break.
"""

from __future__ import annotations

import asyncio
import os

from encore_worker.adapters import separate as sep
from encore_worker.adapters.ports import AudioProbe, Separator
from encore_worker.domain.identity import Identified, identify_from_title
from encore_worker.host.config import Config
from encore_worker.steps.align_steps import AlignStepsImpl, Reporter
from encore_worker.steps.api import NotOurJob
from encore_worker.steps.records import AudioRef, JobRef


class SeparateStepsImpl:
    """`SeparateSteps`, for real."""

    def __init__(
        self,
        *,
        config: Config,
        audio: AlignStepsImpl,
        reporter: Reporter,
        separator: Separator | None = None,
        probe: AudioProbe | None = None,
    ) -> None:
        self._cfg = config
        self._audio = audio
        self._out = reporter
        self._sep = separator
        self._probe = probe

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        """Identical to align's, by delegation. See the module docstring for why not inheritance."""
        return await self._audio.acquire_audio(job)

    async def decode_to_wav(self, job: JobRef, audio: AudioRef) -> str:
        """Normalise to the one format both separators expect.

        Done here rather than inside each engine so a variable-bitrate mp3 or an opus stream cannot
        produce a subtly different stem layout depending on which engine ran.
        """
        out = os.path.join(self._work(job), "input.wav")
        await asyncio.to_thread(sep.run, sep.decode_argv(audio.path, out, self._cfg.ffmpeg_bin))
        return out

    async def separate(self, job: JobRef, input_wav: str) -> AudioRef:
        """Run the engine. The long one — tens of minutes on a real song.

        `to_thread` because `run` is a blocking subprocess drain: awaiting it inline would freeze the
        event loop, stop the socket keepalive, and let the core's lease expire on a healthy job.
        """
        if self._sep is None:
            raise _Permanent("this worker has no separator engine, so it cannot serve a stems job")
        stems = await asyncio.to_thread(self._sep.separate, input_wav, self._work(job), on_progress=None)
        return AudioRef(
            path=stems.instrumental_path,
            duration_sec=0.0,  # measured after publication; the separator does not report it
            vocals_path=stems.vocals_path,
        )

    async def probe_silence(self, job: JobRef, audio: AudioRef) -> float | None:
        """Peak dBFS of the instrumental, or None when it could not be measured.

        The earlier version returned 0.0 here — the loudest possible reading — so a box that could not
        measure published unverified. That made "unmeasured" and "definitely fine" the same value, which
        is the failure this whole guard exists to prevent.

        None now reaches the workflow, which refuses. That is safe to do because `host.capabilities` no
        longer advertises `stems` without ffmpeg, so a box running this HAS a probe — meaning None is
        ffmpeg failing on THIS file, which is a real fault rather than a missing capability.
        """
        if self._probe is None:
            return None
        return await asyncio.to_thread(self._probe.peak_dbfs, audio.path)

    async def publish_stems(self, job: JobRef, audio: AudioRef) -> str:
        """Guarded, exactly as align's publish is: the lease may have expired during separation."""
        if not await self._out.confirm_ownership(job.job_id):
            raise NotOurJob(self._out.explain_ownership(job.job_id))
        return os.path.relpath(audio.path, job.media_dir)

    def _work(self, job: JobRef) -> str:
        path = os.path.join(job.media_dir, "work", job.job_id)
        os.makedirs(path, exist_ok=True)
        return path


class _Permanent(RuntimeError):
    """A capability this box does not have. No retry can supply it."""

    retryable = False


class FetchStepsImpl:
    """`FetchSteps`, for real. The shortest implementation, and the only one producing METADATA.

    `annotate` reads the file's own tags first and falls back to parsing the upload title, because a tag
    written by whoever encoded the file is evidence where a title is a guess. Both are recorded in
    `Identified.source`, so a later wrong-lyrics report is traceable to how the song was named.
    """

    def __init__(self, *, config: Config, audio: AlignStepsImpl, reporter: Reporter) -> None:
        self._cfg = config
        self._audio = audio
        self._out = reporter

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        return await self._audio.acquire_audio(job)

    async def annotate(self, job: JobRef, audio: AudioRef) -> Identified:
        """Identify the song. Never raises — not knowing is a real answer, not a failure."""
        artist, track = job.param_str("artist"), job.param_str("track")
        if artist and track:
            # The core already knows: an operator typed it, or a previous fetch recorded it.
            return Identified(artist=artist, track=track, source="job-params")
        title = job.param_str("title")
        if title:
            return identify_from_title(title)
        return Identified(source="none")

    async def publish_original(self, job: JobRef, audio: AudioRef, found: Identified) -> str:
        """Guarded, like every other publish."""
        if not await self._out.confirm_ownership(job.job_id):
            raise NotOurJob(self._out.explain_ownership(job.job_id))
        return os.path.relpath(audio.path, job.media_dir)

    async def note(
        self, job: JobRef, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        await self._audio.note(job, state, attempt, verdict, why, knob)
