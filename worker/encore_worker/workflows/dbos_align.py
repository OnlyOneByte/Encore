"""The DBOS wrapper: `run_align`'s steps, made durable.

No decisions — every method delegates to `AlignStepsImpl` and exists only to carry a `@DBOS.step`
decorator, which is what keeps the behaviour importable with no DBOS launched. Only two steps are retried,
both network reads: acquisition (3 attempts) and the provider fetch (2). A model step has the search's better
answer than a retry, and a refused `publish` means another worker owns the job. See docs/arch/05-worker.md §8.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from encore_worker.steps.align_steps import AlignStepsImpl
from encore_worker.steps.records import (
    AudioRef,
    JobRef,
    Refused,
    TextRef,
    TimedDoc,
    TimeRequest,
)
from encore_worker.workflows import stage_clock


class DbosAlignSteps:
    """`AlignSteps`, with each method wrapped as a durable DBOS step.

    Built once at startup around a live `AlignStepsImpl`. The wrappers are installed in `__init__` rather than
    as class-level decorators because the DBOS instance does not exist at class-definition time.
    """

    def __init__(self, impl: AlignStepsImpl, dbos: Any, *, job_id: str | None = None) -> None:
        """`job_id` is whose `stage_clock` the steps' seconds go to; None times nothing."""
        self._impl = impl
        j = job_id
        # `max_attempts=1` means "do not retry", not "do not checkpoint" — a completed step is still
        # recorded, so a resumed workflow skips it rather than re-running it.
        self._acquire = _step(dbos, impl.acquire_audio, retries=3, name="acquire_audio", job_id=j)
        self._captions = _step(dbos, impl.fetch_captions, retries=1, name="fetch_captions", job_id=j)
        self._provider = _step(
            dbos, impl.fetch_provider_lyrics, retries=2, name="fetch_provider_lyrics", job_id=j
        )
        # A local read of the stored candidate (or the paste, already in the params): nothing transient.
        self._pinned = _step(dbos, impl.fetch_pinned_text, retries=1, name="fetch_pinned_text", job_id=j)
        self._transcribe = _step(dbos, impl.transcribe, retries=1, name="transcribe", job_id=j)
        self._time = _step(dbos, impl.time_text, retries=1, name="time_text", job_id=j)
        self._diarize = _step(dbos, impl.diarize, retries=1, name="diarize", job_id=j)
        self._publish = _step(dbos, impl.publish, retries=1, name="publish", job_id=j)
        # Bookkeeping, not work: untimed.
        self._note = _step(dbos, impl.note, retries=1, name="note")

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        result: AudioRef = await self._acquire(job)
        return result

    async def fetch_captions(self, job: JobRef, *, automatic: bool) -> TextRef | None:
        result: TextRef | None = await self._captions(job, automatic=automatic)
        return result

    async def fetch_provider_lyrics(self, job: JobRef, audio: AudioRef) -> list[TextRef]:
        # A CHECKPOINT WRITTEN BEFORE THIS STEP RETURNED A LIST holds `TextRef | None`, and a workflow
        # resumed or forked across that upgrade REPLAYS the recorded value instead of calling the impl —
        # where `_acquire_texts` splats it and `*TextRef(...)` / `*None` raise `TypeError` in the workflow
        # BODY, past every retry. Normalised here, the one place a replay enters the process, which is where
        # `records.restore_appended` puts the same rule for a record that gained a field.
        result: list[TextRef] | TextRef | None = await self._provider(job, audio)
        if result is None:
            return []
        if isinstance(result, TextRef):
            return [result]
        return result

    async def fetch_pinned_text(self, job: JobRef) -> TextRef | None:
        result: TextRef | None = await self._pinned(job)
        return result

    async def transcribe(self, job: JobRef, audio: AudioRef, *, on_vocals: bool) -> TextRef | None:
        result: TextRef | None = await self._transcribe(job, audio, on_vocals=on_vocals)
        return result

    async def time_text(self, req: TimeRequest) -> TimedDoc | Refused | None:
        result: TimedDoc | Refused | None = await self._time(req)
        return result

    async def diarize(self, job: JobRef, audio: AudioRef, doc: TimedDoc) -> TimedDoc:
        result: TimedDoc = await self._diarize(job, audio, doc)
        return result

    async def publish(self, job: JobRef, doc: TimedDoc | None, *, placing: Sequence[TimedDoc] = ()) -> str:
        result: str = await self._publish(job, doc, placing=tuple(placing))
        return result

    async def note(
        self, job: JobRef, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        await self._note(job, state, attempt, verdict, why, knob)


def _step(dbos: Any, fn: Any, *, retries: int, name: str, job_id: str | None = None) -> Any:
    """Wrap one bound method as a DBOS step; `dbos=None` returns it unwrapped and runs without durability.

    The closure is REQUIRED, not stylistic: `DBOS.step` attaches `dbos_func_decorator_info` to what it
    decorates and a BOUND METHOD does not accept attribute assignment, so the method is closed over by a
    plain async function, which does. Timed INSIDE the step (`stage_clock`): a replayed one reports nothing.
    """
    fn = stage_clock.timed(job_id, name, fn)
    if dbos is None:
        return fn

    async def call(*args: Any, **kwargs: Any) -> Any:
        return await fn(*args, **kwargs)

    # So a recorded step is identifiable in `list_workflow_steps` rather than appearing as a row of `call`.
    call.__name__ = name
    call.__qualname__ = f"AlignSteps.{name}"
    return dbos.step(
        name=name, retries_allowed=retries > 1, max_attempts=retries, should_retry=_worth_retrying
    )(call)


def _worth_retrying(failed: BaseException) -> bool:
    """May DBOS retry the step that raised `failed`? Not when the fault itself says no.

    DBOS otherwise retries EVERY exception a step with `max_attempts > 1` raises and then substitutes
    `DBOSMaxStepRetriesExceeded`, which carries no `retryable` — so a permanent acquisition fault was retried
    with backoff to prove what it had already said and then reached core as RETRYABLE. An exception that does
    not say (a network error) is retried as before. See docs/arch/05-worker.md §8.
    """
    return bool(getattr(failed, "retryable", True))
