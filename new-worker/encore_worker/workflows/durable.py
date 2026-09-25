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


async def _start(flow: Any, job: JobRef) -> Any:
    """Start the workflow under the job's own id and await it.

    `SetWorkflowID` rather than a keyword argument: that context manager is DBOS's documented way to pin the
    id, and pinning it is what makes the id a DEDUPLICATION key rather than a label.
    """
    from dbos import DBOS, SetWorkflowID  # noqa: PLC0415

    with SetWorkflowID(job.job_id):
        handle = await DBOS.start_workflow_async(flow, job)
    return await handle.get_result()
