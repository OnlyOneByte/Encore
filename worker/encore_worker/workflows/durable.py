"""The `@DBOS.workflow` layer: where a step's checkpoint actually happens.

A DBOS step only checkpoints inside a workflow CONTEXT, so `dbos_align.py`'s step decorators alone recorded
nothing — this is the wrapper that gives them one. Only `JobRef` crosses the boundary, because workflow
arguments are serialised into the system database and a steps object holds loaded models, a socket and
subprocess handles; the steps are resolved INSIDE the workflow from a provider registered at startup (XW-11).

See docs/arch/05-worker.md §8.
"""

from __future__ import annotations

import itertools
from collections.abc import Awaitable, Callable
from typing import Any

from encore_worker.steps.api import AlignSteps, SeparateSteps
from encore_worker.steps.cancel import bind_cancel_token
from encore_worker.steps.records import AlignOutcome, JobRef
from encore_worker.workflows.align import run_align
from encore_worker.workflows.stems import ABANDONED, StemsOutcome, run_stems

#: Builds the steps for one job. A closure over process-level state (adapters, config, the transport), so
#: nothing job-specific has to survive serialisation.
AlignStepsFor = Callable[[JobRef], AlignSteps]
SeparateStepsFor = Callable[[JobRef], SeparateSteps]

_align_flow: Callable[[JobRef], Awaitable[AlignOutcome]] | None = None
_stems_flow: Callable[[JobRef], Awaitable[StemsOutcome]] | None = None
#: Kept so a direct (non-durable) call can still build steps when DBOS is absent.
_align_steps_for: AlignStepsFor | None = None
_stems_steps_for: SeparateStepsFor | None = None


def register(
    dbos: Any,
    *,
    align_steps_for: AlignStepsFor,
    stems_steps_for: SeparateStepsFor,
) -> None:
    """Register both workflows against a launched DBOS, or record the providers and run direct without one.

    Called ONCE from the composition root, before the first job: `DBOS.workflow` mutates a global registry, so
    registering on first use would put that mutation in a job's critical path and surface a name collision as
    a failed job. `dbos=None` is a supported state; `bind_cancel_token` is docs/arch/05-worker.md §8.1.
    """
    global _align_flow, _stems_flow, _align_steps_for, _stems_steps_for
    _align_steps_for = align_steps_for
    _stems_steps_for = stems_steps_for

    if dbos is None:
        # Explicitly CLEARED: a stale workflow would send jobs down a path whose DBOS instance is gone.
        _align_flow = None
        _stems_flow = None
        return

    # Imported here so this module is importable with no DBOS installed.
    from dbos import DBOS  # noqa: PLC0415

    @DBOS.workflow(name="encore-align")
    async def align_flow(job: JobRef) -> AlignOutcome:
        assert _align_steps_for is not None
        bind_cancel_token(job)
        return await run_align(job, _align_steps_for(job))

    @DBOS.workflow(name="encore-stems")
    async def stems_flow(job: JobRef) -> StemsOutcome:
        assert _stems_steps_for is not None
        bind_cancel_token(job)
        return await run_stems(job, _stems_steps_for(job))

    _align_flow = align_flow
    _stems_flow = stems_flow


async def align(job: JobRef) -> AlignOutcome:
    """Run the align state machine, durably when DBOS is available.

    The workflow id is the JOB id, which is what makes a requeue idempotent: the core reuses the job id when
    a lease expires, so DBOS recognises the second attempt as the same workflow and RESUMES it. A requeue
    after the workflow FAILED runs a deterministic fork of it instead (`_run_id`).
    """
    if _align_flow is None:
        assert _align_steps_for is not None, "register() must run before any job"
        return await run_align(job, _align_steps_for(job))
    outcome: AlignOutcome = await _start(_align_flow, job)
    return outcome


async def stems(job: JobRef) -> StemsOutcome:
    """As `align`, for separation. It records no steps, so a crash or a requeue separates again from the
    start (docs/arch/05-worker.md §8)."""
    if _stems_flow is None:
        assert _stems_steps_for is not None, "register() must run before any job"
        return await run_stems(job, _stems_steps_for(job))
    outcome: StemsOutcome = await _start(_stems_flow, job)
    return outcome


#: Joins a job id to the number of the requeue a FORK of it runs (`_run_id`): `{job}~requeue-{n}`. A
#: character core never puts in a job id, so no fork id can collide with a real job's.
_REQUEUE = "~requeue-"


async def _start(flow: Any, job: JobRef) -> Any:
    """Start the workflow under the job's own id and await it.

    `SetWorkflowID` rather than a keyword argument: that context manager is DBOS's documented way to pin the
    id, and pinning it is what makes the id a DEDUPLICATION key rather than a label.
    """
    from dbos import DBOS, SetWorkflowID  # noqa: PLC0415

    workflow_id = await _run_id(job.job_id)
    with SetWorkflowID(workflow_id):
        handle = await DBOS.start_workflow_async(flow, job)
    try:
        return await handle.get_result()
    except Exception as failed:
        cause = _unwrapped(failed)
        if cause is failed:
            raise
        raise cause from failed


def _unwrapped(failed: Exception) -> Exception:
    """The fault a job failed on, as the step raised it — not DBOS's wrapper around its retries.

    `DBOSMaxStepRetriesExceeded` carries neither the attempts' `retryable` nor their message, so the LAST
    attempt's exception is returned instead. Anything else is itself. See docs/arch/05-worker.md §8.
    """
    from dbos._error import DBOSMaxStepRetriesExceeded  # noqa: PLC0415

    if isinstance(failed, DBOSMaxStepRetriesExceeded) and failed.errors:
        last = failed.errors[-1]
        return last if isinstance(last, Exception) else failed
    return failed


async def _run_id(job_id: str) -> str:
    """The workflow id this run of job `job_id` is: the job's own, or a FORK of its last failed run.

    A workflow that raised is ERROR in the system database and DBOS answers a start under an ERROR id with
    the RECORDED exception, so without a fork a requeue replays the same error in an instant until the core's
    attempt ceiling. The chain is walked from the job id: an ERROR run whose fork exists moves on to it, and
    the first run that is not ERROR is this run's id. It forks from the first step that recorded an error,
    else the step after the last recorded one. See docs/arch/05-worker.md §8.
    """
    from dbos import DBOS, SetWorkflowID  # noqa: PLC0415

    current = job_id
    for requeue in itertools.count(1):
        status = await DBOS.get_workflow_status_async(current)
        if status is None or not _ended_without_result(status):
            return current
        forked = f"{job_id}{_REQUEUE}{requeue}"
        if await DBOS.get_workflow_status_async(forked) is None:
            steps = await DBOS.list_workflow_steps_async(current)
            failed = [step["function_id"] for step in steps if step["error"] is not None]
            start = min(failed) if failed else max((step["function_id"] for step in steps), default=0) + 1
            with SetWorkflowID(forked):
                await DBOS.fork_workflow_async(current, start)
            return forked
        current = forked
    raise AssertionError("unreachable: itertools.count never ends")  # pragma: no cover


def _ended_without_result(status: Any) -> bool:
    """ERROR, CANCELLED or an ABANDONED publication: docs/arch/05-worker.md §8.1."""
    if status.status in ("ERROR", "CANCELLED"):
        return True
    output = getattr(status, "output", None)
    if isinstance(output, AlignOutcome):
        return bool(getattr(output, "abandoned", False))
    return isinstance(output, StemsOutcome) and output.published is None and output.why.startswith(ABANDONED)


async def cancel(job_id: str) -> None:
    """Cancel job `job_id`'s live run, so DBOS starts none of its remaining steps."""
    if _align_flow is None and _stems_flow is None:
        return
    from dbos import DBOS  # noqa: PLC0415

    current = job_id
    for requeue in itertools.count(1):
        forked = f"{job_id}{_REQUEUE}{requeue}"
        if await DBOS.get_workflow_status_async(forked) is None:
            break
        current = forked
    status = await DBOS.get_workflow_status_async(current)
    if status is not None and status.status in ("PENDING", "ENQUEUED"):
        await DBOS.cancel_workflow_async(current)
