"""The DBOS wrapper: `run_stems`'s steps, made durable, as `dbos_align.py` does it for align.

Acquire, decode, separate and publish are recorded, so a requeue after a finished separation replays into the
same scratch WAVs and resumes at publish. The silence probe and the song profile are cheap reads of those
files and simply run again. See docs/arch/05-worker.md §8.1.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from encore_worker.steps.records import AudioRef, JobRef, PublishedStems
from encore_worker.steps.separate_steps import SeparateStepsImpl
from encore_worker.workflows import stage_clock
from encore_worker.workflows.dbos_align import _step


class DbosStemsSteps:
    """`SeparateSteps`, with the four steps worth a checkpoint wrapped as durable DBOS steps."""

    def __init__(self, impl: SeparateStepsImpl, dbos: Any, *, job_id: str | None = None) -> None:
        """`job_id` is whose `stage_clock` the steps' seconds go to; None times nothing."""
        self._impl = impl
        j = job_id
        self._acquire = _step(dbos, impl.acquire_audio, retries=3, name="acquire_audio", job_id=j)
        self._decode = _step(dbos, impl.decode_to_wav, retries=1, name="decode_to_wav", job_id=j)
        self._separate = _step(dbos, impl.separate, retries=1, name="separate", job_id=j)
        self._publish = _step(dbos, impl.publish_stems, retries=1, name="publish_stems", job_id=j)
        # Not checkpointed, so they run again on a resume, and are timed when they do.
        self._silence = stage_clock.timed(j, "probe_silence", impl.probe_silence)
        self._profile = stage_clock.timed(j, "measure_profile", impl.measure_profile)

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        result: AudioRef = await self._acquire(job)
        return result

    async def decode_to_wav(self, job: JobRef, audio: AudioRef) -> str:
        result: str = await self._decode(job, audio)
        return result

    async def separate(self, job: JobRef, input_wav: str) -> AudioRef:
        result: AudioRef = await self._separate(job, input_wav)
        return result

    async def probe_silence(self, job: JobRef, audio: AudioRef) -> float | None:
        result: float | None = await self._silence(job, audio)
        return result

    async def measure_profile(self, job: JobRef, audio: AudioRef) -> Mapping[str, object]:
        result: Mapping[str, object] = await self._profile(job, audio)
        return result

    async def publish_stems(self, job: JobRef, audio: AudioRef) -> PublishedStems:
        result: PublishedStems = await self._publish(job, audio)
        return result
