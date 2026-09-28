"""The `@DBOS.workflow` layer — the piece production was missing entirely.

WHY THIS FILE HAD TO EXIST. `dbos_align.py` wraps every STEP with `DBOS.step`, and that was mistaken for
durability. It is not: a DBOS step only checkpoints inside a workflow context, so steps invoked from a plain
`async def` run as ordinary functions and record nothing. The live process proved it — after a complete
align job, `workflow_status` in the system database held ZERO rows.

The `-m dbos` tests did not catch it because each one declares its own `@DBOS.workflow` inside the test, so
they proved DBOS *can* run the flow durably while production never asked it to. The test supplied the
missing production wiring itself, which is the sharpest form of a test proving the design instead of the
system.

WHAT DURABILITY BUYS, concretely: a crash 40 minutes into a separation resumes at the next step instead of
re-running the separation. Without it every fault is a full restart — the old worker's behaviour, and the
reason this rewrite chose DBOS over hand-rolling a state machine.

ONLY `JobRef` CROSSES THE WORKFLOW BOUNDARY, and that is a hard DBOS constraint rather than taste: workflow
arguments are SERIALISED into the system database so a recovering process can replay the call. The steps
object holds loaded models, a websocket and subprocess handles — passing it raises `PicklingError`, which is
how this was found. So the steps are resolved INSIDE the workflow from a provider registered at startup, and
the argument is the one thing that is both small and serialisable.
"""

from __future__ import annotations

import itertools
from collections.abc import Awaitable, Callable
from typing import Any

from encore_worker.steps.api import AlignSteps, SeparateSteps
from encore_worker.steps.records import AlignOutcome, JobRef
from encore_worker.workflows.align import run_align
from encore_worker.workflows.stems import StemsOutcome, run_stems

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

    Called ONCE from the composition root, before the first job. Deliberately not lazy: `DBOS.workflow`
    mutates a global registry, so registering on first use would put that mutation in a job's critical path
    and a name collision would surface as a failed job rather than a failed startup.

    `dbos=None` is a supported state, not an error — a box without durable state is degraded, not broken, and
    must still process songs.
    """
    global _align_flow, _stems_flow, _align_steps_for, _stems_steps_for
    _align_steps_for = align_steps_for
    _stems_steps_for = stems_steps_for

    if dbos is None:
        # Explicitly CLEARED rather than left alone: a later `register(None)` means "this box has no DBOS",
        # and leaving a stale workflow registered would send jobs down a path whose instance is gone.
        _align_flow = None
        _stems_flow = None
        return

    # Imported here so this module is importable with no DBOS installed — the same laziness every adapter
    # uses, for the same reason.
    from dbos import DBOS  # noqa: PLC0415

    @DBOS.workflow(name="encore-align")
    async def align_flow(job: JobRef) -> AlignOutcome:
        assert _align_steps_for is not None
        return await run_align(job, _align_steps_for(job))

    @DBOS.workflow(name="encore-stems")
    async def stems_flow(job: JobRef) -> StemsOutcome:
        assert _stems_steps_for is not None
        return await run_stems(job, _stems_steps_for(job))

    _align_flow = align_flow
    _stems_flow = stems_flow


async def align(job: JobRef) -> AlignOutcome:
    """Run the align state machine, durably when DBOS is available.

    The workflow ID is the JOB ID, which is what makes a requeue idempotent: the core reuses the same job id
    when a lease expires, so DBOS recognises the second attempt as the same workflow and RESUMES it. With a
    generated id, a requeue after a 45-minute separation would start a parallel workflow and redo the work.
    A requeue after the workflow FAILED runs a deterministic fork of it from the failed step (`_run_id`).
    """
    if _align_flow is None:
        assert _align_steps_for is not None, "register() must run before any job"
        return await run_align(job, _align_steps_for(job))
    outcome: AlignOutcome = await _start(_align_flow, job)
    return outcome


async def stems(job: JobRef) -> StemsOutcome:
    """As `align`, for separation — which earns durability the most: a crash after a 45-minute pass resumes
    at publication instead of separating again."""
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

    A requeue of a job whose workflow FAILED runs a fork of it (`_run_id`), not the recorded failure. A step
    that failed every retry DBOS allowed it fails the job as ITS fault, not as DBOS's wrapper (`_unwrapped`).
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

    A step allowed retries (`dbos_align._step`) that fails every one ends in `DBOSMaxStepRetriesExceeded`,
    which holds the attempts' own exceptions and carries neither their `retryable` nor their message: the
    transport sent every exhausted acquisition as retryable, with "Step acquire_audio has exceeded its
    maximum of 3 retries" as the reason (review W1 r2). The LAST attempt's exception is what the job failed
    on, so that is what reaches the transport, `retryable` and all. Anything else is itself.
    """
    from dbos._error import DBOSMaxStepRetriesExceeded  # noqa: PLC0415

    if isinstance(failed, DBOSMaxStepRetriesExceeded) and failed.errors:
        last = failed.errors[-1]
        return last if isinstance(last, Exception) else failed
    return failed


async def _run_id(job_id: str) -> str:
    """The workflow id this run of job `job_id` is: the job's own, or a FORK of its last failed run.

    WHY A FORK (review W1 r1, M7). A workflow that raised is ERROR in the system database, and DBOS answers
    a start under an ERROR id with the RECORDED exception: no step runs again. So the core's requeue of a
    retryable `Failed` (a Hub 503 while loading the align model; a transient ffmpeg fault) replayed the
    same error in an instant, attempt after attempt, until `maxAttempts` failed the job terminally — with
    the cause long gone (measured on dbos 3.1.0: 1 `time_text` across 3 requeues). `retryable` meant
    nothing under DBOS. A fork is DBOS's own restart: a NEW workflow id whose steps before `start_step` are
    copied from the failed run, so every step that completed (the audio acquired, the texts fetched, the
    attempts already timed) replays from its checkpoint, and the step that failed runs again.

    DETERMINISTIC IDS, so a requeue is still idempotent: the n-th fork of job J is `J~requeue-n`. The chain
    is walked from the job id: an ERROR run whose fork exists moves on to it; the first run that is not
    ERROR (none yet, running, or done) is this run's id — a resumed fork or a finished one is started under
    it like any other, and returns what it holds. Every failure the core requeues forks once more, so a
    job's forks number its requeues; it is the core's `maxAttempts`, not this, that bounds them. The core
    decides whether a failure is worth requeueing (`retryable`); this only makes a requeue re-run.

    WHERE IT FORKS FROM: the first step that recorded an error (the one the failure came out of), else the
    step after the last recorded one (a workflow body that raised between steps replays deterministically
    and raises again, which is correct).
    """
    from dbos import DBOS, SetWorkflowID  # noqa: PLC0415

    current = job_id
    for requeue in itertools.count(1):
        status = await DBOS.get_workflow_status_async(current)
        if status is None or status.status != "ERROR":
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
