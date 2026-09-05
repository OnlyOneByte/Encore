"""The runner: the ONE thing that executes a plan.

Every processor used to own its own copy of this — the scratch dir, the subprocess stage wrapper, the
keepalive, the CompleteResult assembly. `demucs.py` and `whisperx.py` each had a `_run_stage`;
`roformer.py` imported demucs to borrow one. One implementation, four actions.

What lives here and nowhere else:

  * the scratch directory for a job
  * `run_stage`, the subprocess-with-progress wrapper
  * `run_blocking`, the keepalive that keeps in-process ML from killing the websocket
  * per-step timing, which is what finally gives the internal metrics page real resolution
  * turning a context into a CompleteResult

It knows nothing about audio, lyrics or separation — only about plans, steps and contexts. That is the
dependency rule from the spec's §3, and it is what makes every domain testable without an event loop.
"""
from __future__ import annotations

import asyncio
import os
import time
from typing import Any, AsyncIterator, Callable

from ..processor import CompleteResult, JobSpec, ProgressEvent
from .ctx import Ctx, ResolvedEngines
from .plan import Plan, plan_for, validate_plan
from .step import Outcome, StepResult

#: How often to emit a keepalive ProgressEvent while a blocking ML call runs. MUST stay comfortably
#: under the core's progressLeaseMs (30 s, leases.ts) or the reaper requeues a healthy job.
LEASE_KEEPALIVE_SEC = 10.0

#: (argv) -> async iterator of output lines. Injected, so every step tests with a fake subprocess.
Runner = Callable[[list[str]], AsyncIterator[str]]

#: When True, the runner asserts each step only wrote what it declared. Test-mode only — see
#: `_assert_declared_writes`. Production pays nothing.
STRICT_WRITES = bool(os.environ.get("ENCORE_STRICT_STEP_WRITES"))


class PlanRunner:
    """Execute one job's plan, yielding progress and finally a CompleteResult.

    Satisfies the same `Processor` protocol the old per-action processors did, so `RoutingProcessor`
    dispatches to it unchanged and this can be adopted one action at a time.
    """

    def __init__(
        self,
        *,
        runner: Runner,
        resolve_engines: Callable[[dict[str, Any]], ResolvedEngines] | None = None,
        plans: Callable[[JobSpec, ResolvedEngines], Plan] | None = None,
    ) -> None:
        self._runner = runner
        self._resolve_engines = resolve_engines or (lambda params: ResolvedEngines())
        # Plan LOOKUP is injectable so a test can hand in a plan carrying fake seams, without a global
        # registry mutation that would leak between tests. Production passes nothing and gets `plan_for`.
        self._plan_for = plans or plan_for

    async def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        ctx = Ctx(
            job=job,
            work=scratch_for(job),
            engines=self._resolve_engines(job.params if isinstance(job.params, dict) else {}),
        )
        os.makedirs(ctx.work, exist_ok=True)
        ctx.runner = self._runner  # steps run subprocesses through this

        plan = self._plan_for(job, ctx.engines)
        validate_plan(plan)  # cheap, and a malformed plan must never reach a real cook

        step = plan.first()
        while step is not None:
            if not step.applies(ctx):
                ctx.note(f"{step.name}: skipped")
                step = plan.after(step, StepResult(), ctx)
                continue

            result = StepResult()
            before = _snapshot(ctx, step) if STRICT_WRITES else None
            started = time.monotonic()
            async for item in step.run(ctx):
                if isinstance(item, StepResult):
                    result = item
                else:
                    yield item
            ctx.out.timings_sec[step.name] = round(time.monotonic() - started, 3)
            if before is not None:
                _assert_declared_writes(ctx, step, before)

            if result.outcome is Outcome.STOP:
                ctx.note(f"{step.name}: stopping — {result.reason or 'no reason given'}")

            step = plan.after(step, result, ctx)

        for line in ctx.out.notes:
            print(f"[worker] {job.job_type} {job.media_id}: {line}", flush=True)

        ctx.out.facts.setdefault("stepTimingsSec", dict(ctx.out.timings_sec))
        yield CompleteResult(media_uri=ctx.out.media_uri, artifacts=ctx.out.artifacts, facts=ctx.out.facts)

    # ── the two things a step cannot do for itself ─────────────────────────────────

    async def run_stage(self, ctx: Ctx, stage: Any, argv: list[str], parse: Any) -> AsyncIterator[ProgressEvent]:
        """Deprecated shim: delegates to the module-level `run_stage`. Kept so an existing caller that
        already holds a PlanRunner needs no change; a Step should call the free function instead, since
        it is handed only a `ctx` and never the runner that drives it."""
        async for ev in run_stage(self._runner, stage, argv, parse):
            yield ev


async def run_stage(runner: Any, stage: Any, argv: list[str], parse: Any) -> AsyncIterator[ProgressEvent]:
    """Run a CLI, translating its output into progress for one stage.

    A free function, not a PlanRunner method, because the only thing it needs is the runner callable —
    and a `Step.run(ctx)` is handed `ctx` alone, never the PlanRunner driving it. As a method, the three
    steps that wanted it had to construct a throwaway `PlanRunner(runner=ctx.runner)` to borrow it.

    Was duplicated in demucs.py and whisperx.py, with roformer.py importing demucs to borrow it. The
    S0-S6 refactor left this with no callers and the copies drifted apart again — one step emitted an
    UNCONDITIONAL final 100, double-firing the stage's completion event. The `last < 100` guard below is
    the behaviour that divergence lost.
    """
    yield ProgressEvent(stage=stage, pct=0)
    last = -1
    async for line in runner(argv):
        pct = parse(line)
        if pct is not None and pct != last:
            last = pct
            yield ProgressEvent(stage=stage, pct=pct)
    if last < 100:
        yield ProgressEvent(stage=stage, pct=100)


async def run_blocking(fn: Callable[[], Any], stage: Any, pct: int) -> AsyncIterator[tuple[str, Any]]:
    """Run a BLOCKING call in a thread, yielding ("progress", ev) keepalives until it finishes, then
    ("result", value) exactly once.

    MOVED INTACT from whisperx.py. Both halves matter, and both were real failures observed on a live
    cook — this is not defensive coding:

      1. torch/whisper calls are synchronous. Awaiting them inline froze the asyncio event loop for the
         whole ML pass, so the worker could not answer the websocket keepalive ping and the server closed
         the connection mid-job ("keepalive ping timeout").
      2. With the loop frozen, no job:progress could be sent either, so the core's 30 s PROGRESS LEASE
         expired and the reaper requeued a job that was running fine — observed as attempts=1 on a job
         that never actually failed. Each retry costs a full ASR + align pass, so with maxAttempts=3 a
         slightly slower song fails permanently after minutes of CPU.

    Demucs never hit this because it is a subprocess awaited through asyncio; in-process ML is not.

    ON UNWIND we do NOT abandon the thread. When the consuming job is cancelled (dial_home._on_cancel
    calls task.cancel()), a GeneratorExit / CancelledError is thrown into the `yield` below and this
    generator unwinds. Without the `finally` the `to_thread` future was simply dropped: the worker's
    slot was freed by _run_job's finally while the native ML call kept running, so the box believed it
    had a capacity it did not — a cancelled cook went on burning CPU/VRAM and a concurrency>1 worker
    over-committed.

    A thread executing native torch code CANNOT be forcibly killed — Python has no such primitive, and
    cancelling the to_thread future does NOT stop the thread, it only detaches our handle so the work
    keeps running unobserved (worse, not better). So the honest fix is not to pretend we killed it: we
    AWAIT the still-running future on the way out, shielded from the very cancellation that is unwinding
    us, so this generator does not finish until the thread genuinely has. The caller frees its slot only
    when run_blocking returns, so the slot now stays held for exactly as long as real work is in flight.
    The cost is that a cancelled ML cook does not free its slot instantly — it frees it when the current
    pass ends — which is the truthful behaviour, not the lie that capacity is already back.
    """
    task = asyncio.ensure_future(asyncio.to_thread(fn))
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=LEASE_KEEPALIVE_SEC)
            if task in done:
                yield ("result", task.result())  # raises here if fn raised — same as a direct call
                return
            yield ("progress", ProgressEvent(stage=stage, pct=pct))
    finally:
        # Reached on the normal `return` (task already done — cheap no-op) and on the cancel/exception
        # unwind (thread may still be running). Block until it truly finishes so the slot the caller is
        # about to free is not still occupied by a live thread. shield() because the unwinding
        # CancelledError would otherwise cut this await short and re-detach the thread we are waiting on.
        if not task.done():
            try:
                await asyncio.shield(asyncio.wait({task}))
            except asyncio.CancelledError:
                # The unwinding cancellation reached us through the shield. The inner wait was still
                # driven to completion, so by here the thread has finished and is no longer unaccounted.
                pass
        # Retrieve any exception the abandoned run raised so it is not reported as "exception never
        # retrieved"; we are unwinding an already-decided outcome and its value is not wanted here.
        if task.done() and not task.cancelled():
            _ = task.exception()


def scratch_for(job: JobSpec) -> str:
    """Per-job scratch. Under the media volume so a remote worker's temp lives with its outputs."""
    return os.path.join(job.media_dir, "work", job.job_id)


# ── the write guard (test mode) ────────────────────────────────────────────────────


def _snapshot(ctx: Ctx, step: Any) -> dict[str, Any]:
    """Every namespace a step did NOT declare, so an undeclared write can be detected."""
    watched = {"audio", "lyrics", "stems", "engines"}
    declared_roots = {w.split(".", 1)[0] for w in step.writes}
    return {root: repr(getattr(ctx, root)) for root in watched - declared_roots}


def _assert_declared_writes(ctx: Ctx, step: Any, before: dict[str, Any]) -> None:
    """Fail loudly when a step wrote somewhere it did not declare.

    Keeps `Ctx` from decaying into a god-object where any step writes anything — which is the standing
    objection to a shared mutable context, and the reason the declarations have to be enforced rather
    than merely written. Compares reprs of whole namespaces: coarse, but it needs no bookkeeping in the
    steps themselves, and the failure names the step and the namespace.
    """
    for root, was in before.items():
        now = repr(getattr(ctx, root))
        if now != was:
            raise AssertionError(
                f"step '{step.name}' wrote to ctx.{root} without declaring it in `writes` "
                f"(declared: {sorted(step.writes)})"
            )
