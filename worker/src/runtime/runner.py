"""The runner: the ONE thing that executes a plan.

What lives here and nowhere else:

  * the scratch directory for a job
  * `run_stage`, the subprocess-with-progress wrapper
  * `run_blocking`, the keepalive that keeps in-process ML from killing the websocket
  * per-step timing, recorded on the `job:complete` payload for the worker's own log —
    the core drops it at its fact allowlist, so `/metrics` gets no per-step resolution from it
  * turning a context into a CompleteResult

It knows nothing about audio, lyrics or separation — only about plans, steps and contexts. That is the
dependency rule from the spec's §3, and it is what makes every domain testable without an event loop.
"""

from __future__ import annotations

import asyncio
import dataclasses
import os
import time
from collections.abc import AsyncIterator, Callable
from typing import Any

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
        # registry mutation that would leak between tests.
        self._plan_for = plans or plan_for

    async def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        ctx = Ctx(
            job=job,
            work=scratch_for(job),
            # params is validated to be a dict at the inbound boundary (dial_home._on_assign).
            engines=self._resolve_engines(job.params),
        )
        os.makedirs(ctx.work, exist_ok=True)
        ctx.runner = self._runner  # steps run subprocesses through this

        plan = self._plan_for(job, ctx.engines)
        validate_plan(plan)  # cheap, and a malformed plan must never reach a real process

        # The notes buffer is the worker's own diagnosis of a job. A step raising is how it signals
        # FAILURE, and that is exactly when the notes are the explanation the operator needs — so the
        # flush lives in `finally`, running once whether the loop exits normally or a step raises.
        def _flush_notes() -> None:
            for line in ctx.out.notes:
                print(f"[worker] {job.job_type} {job.media_id}: {line}", flush=True)

        try:
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
        finally:
            _flush_notes()

        ctx.out.facts.setdefault("stepTimingsSec", dict(ctx.out.timings_sec))
        yield CompleteResult(
            media_uri=ctx.out.media_uri,
            artifacts=ctx.out.artifacts,
            facts=ctx.out.facts,
            selection=ctx.out.selection,
        )


async def run_stage(runner: Any, stage: Any, argv: list[str], parse: Any) -> AsyncIterator[ProgressEvent]:
    """Run a CLI, translating its output into progress for one stage.

    A free function, not a PlanRunner method: the only thing it needs is the runner callable, and a
    `Step.run(ctx)` is handed `ctx` alone, never the PlanRunner driving it.

    A stage whose child emits no NEW percentage for a long stretch (e.g. roformer's `parse_progress`
    returns None unconditionally, so a 45-minute separation parses nothing at all) would otherwise go
    silent between its opening 0 and closing 100 — long past the core's 30s progressLeaseMs, so the
    reaper requeues a HEALTHY process and each retry re-runs the whole pass. So each line races against
    `LEASE_KEEPALIVE_SEC`, and when the child is quiet a TIME-BASED keepalive fires at the last-known
    pct (same convention `run_blocking` uses). The keepalive never moves the bar backward or above 100.
    """
    yield ProgressEvent(stage=stage, pct=0)
    last = -1
    lines = runner(argv).__aiter__()
    pending: asyncio.Task[str] | None = None
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(lines.__anext__())
            # asyncio.wait — NOT wait_for — because a timeout must NOT cancel the in-flight __anext__:
            # cancelling it mid-await would throw CancelledError into the child generator and kill it.
            # We keep the SAME pending task alive across quiet intervals and only consume it once it
            # actually resolves, so the child runs to completion regardless of how many keepalives fire.
            done, _ = await asyncio.wait({pending}, timeout=LEASE_KEEPALIVE_SEC)
            if pending not in done:
                # Alive but quiet: renew the lease with a heartbeat at the last pct reported (0 until
                # the first real percentage). Holds the bar; never moves it backward.
                yield ProgressEvent(stage=stage, pct=max(last, 0))
                continue
            try:
                line = pending.result()
            except StopAsyncIteration:
                pending = None
                break
            pending = None
            pct = parse(line)
            if pct is not None and pct != last:
                last = pct
                yield ProgressEvent(stage=stage, pct=pct)
    finally:
        # If we unwind (caller aclose/cancel) with a line request still in flight, close the child
        # generator's in-flight __anext__ cleanly rather than leaking a pending task.
        if pending is not None and not pending.done():
            pending.cancel()
    if last < 100:
        yield ProgressEvent(stage=stage, pct=100)


async def run_quiet(runner: Runner, argv: list[str]) -> None:
    """Run a subprocess and DISCARD its output.

    Those calls run ffmpeg with `-loglevel error`, so there is nothing to read on success and a
    non-zero exit raises inside the runner regardless — draining is the whole interaction. One name
    for it means a step never forgets to consume the generator, which would leave the child unwaited.
    """
    async for _line in runner(argv):
        pass


async def run_capture(runner: Runner, argv: list[str]) -> str:
    """Run a subprocess and return its full output as one newline-joined string.

    The counterpart to `run_quiet` for a MEASURING call — today only ProbeSilence's volumedetect, which
    needs ffmpeg's `max_volume:` summary back to parse. Same collect-then-join the step did inline.
    """
    lines: list[str] = []
    async for line in runner(argv):
        lines.append(line)
    return "\n".join(lines)


async def run_blocking(fn: Callable[[], Any], stage: Any, pct: int) -> AsyncIterator[tuple[str, Any]]:
    """Run a BLOCKING call in a thread, yielding ("progress", ev) keepalives until it finishes, then
    ("result", value) exactly once.

    Two real failures observed on a live process, not defensive coding:

      1. torch/whisper calls are synchronous. Awaiting them inline freezes the asyncio event loop for
         the whole ML pass, so the worker cannot answer the websocket keepalive ping and the server
         closes the connection mid-job.
      2. With the loop frozen, no job:progress can be sent either, so the core's 30s PROGRESS LEASE
         expires and the reaper requeues a job that was running fine — each retry then costs a full
         ASR + align pass, so with maxAttempts=3 a slightly slower song fails permanently.

    Demucs never hits this because it is a subprocess awaited through asyncio; in-process ML is not.

    ON UNWIND we do NOT abandon the thread. A thread executing native torch code CANNOT be forcibly
    killed — cancelling the to_thread future does not stop it, only detaches our handle so the work
    keeps running unobserved. So we AWAIT the still-running future on the way out, shielded from the
    very cancellation that is unwinding us, so the caller's slot (freed only when run_blocking
    returns) stays held for exactly as long as real work is in flight — a cancelled ML process frees
    its slot when the current pass ends, not instantly, which is the truthful behaviour.
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
        # Reached on the normal `return` (task already done, cheap no-op) and on the cancel/exception
        # unwind (thread may still be running). shield() because the unwinding CancelledError would
        # otherwise cut this await short and re-detach the thread we are waiting on.
        while not task.done():
            try:
                await asyncio.shield(asyncio.wait({task}))
            except asyncio.CancelledError:
                # A second cancellation reached us through the shield; the inner wait keeps running
                # concurrently, so loop and await again instead of returning with the thread still live.
                pass
        # Retrieve any exception the abandoned run raised so it is not reported as "exception never
        # retrieved" — we are unwinding an already-decided outcome and its value is not wanted here.
        if task.done() and not task.cancelled():
            _ = task.exception()


def scratch_for(job: JobSpec) -> str:
    """Per-job scratch. Under the media volume so a remote worker's temp lives with its outputs."""
    return os.path.join(job.media_dir, "work", job.job_id)


def _snapshot(ctx: Ctx, step: Any) -> dict[str, Any]:
    """Every namespace a step did NOT declare, so an undeclared write can be detected.

    `ctx.out` is watched at FIELD granularity, not as a whole: `notes` (appended via `ctx.note()`) and
    `timings_sec` (filled by the runner itself) are legitimate undeclared writes and stay exempt.
    EVERY OTHER `Outputs` field is wire-shaped, becoming part of the CompleteResult, so the guard must
    cover it. The set is derived from the dataclass fields minus the exempt pair rather than
    hardcoded, so a wire-shaped field added later is watched automatically.
    """
    watched = {"audio", "lyrics", "stems", "engines"}
    declared_roots = {w.split(".", 1)[0] for w in step.writes}
    snap = {root: repr(getattr(ctx, root)) for root in watched - declared_roots}
    if "out" not in declared_roots:
        exempt = {"notes", "timings_sec"}
        watched_out = tuple(
            getattr(ctx.out, f.name) for f in dataclasses.fields(ctx.out) if f.name not in exempt
        )
        snap["out"] = repr(watched_out)
    return snap


def _assert_declared_writes(ctx: Ctx, step: Any, before: dict[str, Any]) -> None:
    """Fail loudly when a step wrote somewhere it did not declare.

    Keeps `Ctx` from decaying into a god-object where any step writes anything. Compares the per-root
    reprs `_snapshot` captured before the step ran: coarse, but needs no bookkeeping in the steps
    themselves, and the failure names the step and the namespace.
    """
    after = _snapshot(ctx, step)
    for root, was in before.items():
        if after.get(root) != was:
            raise AssertionError(
                f"step '{step.name}' wrote to ctx.{root} without declaring it in `writes` "
                f"(declared: {sorted(step.writes)})"
            )
