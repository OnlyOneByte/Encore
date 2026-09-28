"""The DBOS wrapper: `run_align`'s steps, made durable.

CONTAINS NO DECISIONS. Every method below delegates straight to `AlignStepsImpl` and exists only to carry
a `@DBOS.step` decorator. That is the whole reason the split exists — the behaviour is testable by calling
`AlignStepsImpl` directly with no DBOS launched, and this file is the part that cannot be.

WHY THE DECORATORS ARE APPLIED HERE AND NOT ON THE IMPL. A decorator registers with a global DBOS
registry at import time. Putting them on the implementation would make importing the behaviour a
side-effecting act, so a unit test could not import the class without booting the framework.

RETRY POLICY PER STEP, and the values differ for reasons:

  * acquisition is worth retrying — a transient network failure is the common case — but never a fault
    that says it is NOT (`retryable = False`: `_Permanent`, `ModelUnavailable`, `OutOfMemory`; `_retries`)
  * a model step is NOT. `time_text` declines what a TEXT causes (the search has a better answer than
    a retry: the next knob, the next text) and raises only an `InfraFault` (review M7), a missing
    package or an OOM among them, which fails the job with its own `retryable` rather than the step
  * `publish` is not retried either, since a refused publish means another worker owns the job
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


class DbosAlignSteps:
    """`AlignSteps`, with each method wrapped as a durable DBOS step.

    Built once at startup around a live `AlignStepsImpl`. The wrappers are installed in `__init__`
    rather than as class-level decorators because the DBOS instance does not exist at class-definition
    time — a module-level decorator would bind to whatever registry happened to be current at import.
    """

    def __init__(self, impl: AlignStepsImpl, dbos: Any) -> None:
        self._impl = impl
        # `max_attempts=1` means "do not retry", not "do not checkpoint" — a completed step is still
        # recorded, so a resumed workflow skips it rather than re-running it.
        self._acquire = _step(dbos, impl.acquire_audio, retries=3, name="acquire_audio")
        self._captions = _step(dbos, impl.fetch_captions, retries=1, name="fetch_captions")
        self._provider = _step(dbos, impl.fetch_provider_lyrics, retries=2, name="fetch_provider_lyrics")
        # A local read of the stored candidate (or the paste, already in the params): nothing transient.
        self._pinned = _step(dbos, impl.fetch_pinned_text, retries=1, name="fetch_pinned_text")
        self._transcribe = _step(dbos, impl.transcribe, retries=1, name="transcribe")
        self._time = _step(dbos, impl.time_text, retries=1, name="time_text")
        self._diarize = _step(dbos, impl.diarize, retries=1, name="diarize")
        self._publish = _step(dbos, impl.publish, retries=1, name="publish")
        self._note = _step(dbos, impl.note, retries=1, name="note")

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        result: AudioRef = await self._acquire(job)
        return result

    async def fetch_captions(self, job: JobRef, *, automatic: bool) -> TextRef | None:
        result: TextRef | None = await self._captions(job, automatic=automatic)
        return result

    async def fetch_provider_lyrics(self, job: JobRef, audio: AudioRef) -> TextRef | None:
        result: TextRef | None = await self._provider(job, audio)
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


def _step(dbos: Any, fn: Any, *, retries: int, name: str) -> Any:
    """Wrap one bound method as a DBOS step.

    THE INDIRECTION IS REQUIRED, not stylistic. `DBOS.step` attaches `dbos_func_decorator_info` to the
    function it decorates, and a BOUND METHOD does not accept attribute assignment — handing it one
    raises `AttributeError: 'method' object has no attribute 'dbos_func_decorator_info'`. So the method is
    closed over by a plain async function, which does accept it. Nothing but a live DBOS finds this: every
    fake-driven test passes `dbos=None` and never reaches the decorator at all.

    `dbos=None` returns the method unwrapped and runs without durability, which degrades to exactly the
    behaviour `AlignStepsImpl` already has — and is what lets the composition root start on a box where
    DBOS could not launch.
    """
    if dbos is None:
        return fn

    async def call(*args: Any, **kwargs: Any) -> Any:
        return await fn(*args, **kwargs)

    # DBOS reads the function name for its own bookkeeping when `name` is not decisive; keeping them in
    # step means a recorded step is identifiable in `list_workflow_steps` rather than a row of `call`.
    call.__name__ = name
    call.__qualname__ = f"AlignSteps.{name}"
    return dbos.step(
        name=name, retries_allowed=retries > 1, max_attempts=retries, should_retry=_worth_retrying
    )(call)


def _worth_retrying(failed: BaseException) -> bool:
    """May DBOS retry the step that raised `failed`? Not when the fault itself says no.

    WHY IT IS ASKED (review W1 r2). DBOS retried EVERY exception a step with `max_attempts > 1` raised, then
    raised `DBOSMaxStepRetriesExceeded` in its place, which carries no `retryable`. So `acquire_audio`'s
    `_Permanent` (a local source that is not a file, a box with no fetcher) was retried three times with
    backoff to prove what it had already said, and reached core as a RETRYABLE failure (the transport reads
    `getattr(exc, "retryable", True)`), whose requeue then re-ran it through `durable._run_id`'s fork until
    `maxAttempts` (measured on dbos 3.1.0). Declined here, the fault is raised as itself, so the transport
    sends its own flag. An exception that does not say (a network error) is retried as before; one that
    exhausts its retries is unwrapped by `durable` (`_unwrapped`).
    """
    return bool(getattr(failed, "retryable", True))
