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
from encore_worker.workflows.dbos_align import _step


class DbosStemsSteps:
    """`SeparateSteps`, with the four steps worth a checkpoint wrapped as durable DBOS steps."""

    def __init__(self, impl: SeparateStepsImpl, dbos: Any) -> None:
        self._impl = impl
        self._acquire = _step(dbos, impl.acquire_audio, retries=3, name="acquire_audio")
        self._decode = _step(dbos, impl.decode_to_wav, retries=1, name="decode_to_wav")
        self._separate = _step(dbos, impl.separate, retries=1, name="separate")
        self._publish = _step(dbos, impl.publish_stems, retries=1, name="publish_stems")

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
        return await self._impl.probe_silence(job, audio)

    async def measure_profile(self, job: JobRef, audio: AudioRef) -> Mapping[str, object]:
        return await self._impl.measure_profile(job, audio)

    async def publish_stems(self, job: JobRef, audio: AudioRef) -> PublishedStems:
        result: PublishedStems = await self._publish(job, audio)
        return result
