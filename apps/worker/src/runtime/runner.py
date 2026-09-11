"""The runner: the ONE thing that executes a plan.

Every processor used to own its own copy of this — the scratch dir, the subprocess stage wrapper, the
keepalive, the CompleteResult assembly. `demucs.py` and `whisperx.py` each had a `_run_stage`;
`roformer.py` imported demucs to borrow one. One implementation, four actions.

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
        # registry mutation that would leak between tests. Every production runner in `plans.py`
        # (align_runner / stems_runner / fetch_runner) injects `plans=`, so the `plan_for` fallback
        # below is the test/default path, not the one production takes.
        self._plan_for = plans or plan_for

    async def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        ctx = Ctx(
            job=job,
            work=scratch_for(job),
            # params is validated to be a dict at the inbound boundary (dial_home._on_assign, #459).
            engines=self._resolve_engines(job.params),
        )
        os.makedirs(ctx.work, exist_ok=True)
        ctx.runner = self._runner  # steps run subprocesses through this

        plan = self._plan_for(job, ctx.engines)
        validate_plan(plan)  # cheap, and a malformed plan must never reach a real process

        # The notes buffer is the worker's own diagnosis of a job (baseline scores, caption-fetch
        # misses, the "aligning against the MIX" warning, the silent-instrumental refusal). A step
        # raising is the documented way it signals FAILURE (step.py) — and that is exactly when those
        # notes are the explanation the operator needs. So the flush lives in `finally`, not after the
        # loop: it runs once, on the normal exit AND before a step's exception propagates. The single
        # call site is the `finally` below, so there is no double-flush path to guard against.
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

    A free function, not a PlanRunner method, because the only thing it needs is the runner callable —
    and a `Step.run(ctx)` is handed `ctx` alone, never the PlanRunner driving it. As a method, the three
    steps that wanted it had to construct a throwaway `PlanRunner(runner=ctx.runner)` to borrow it.

    Was duplicated in demucs.py and whisperx.py, with roformer.py importing demucs to borrow it. The
    S0-S6 refactor left this with no callers and the copies drifted apart again — one step emitted an
    UNCONDITIONAL final 100, double-firing the stage's completion event. The `last < 100` guard below is
    the behaviour that divergence lost.

    A stage whose child emits no NEW percentage for a long stretch (roformer's `parse_progress` returns
    None unconditionally, so a 45-minute separation parses nothing at all) used to go silent between its
    opening 0 and closing 100 — long past the core's 30 s progressLeaseMs, so the reaper requeued a
    HEALTHY process and each retry re-ran the whole pass. So we race each line against `LEASE_KEEPALIVE_SEC`
    and, when the child is quiet, emit a TIME-BASED keepalive at the last-known pct (the same cadence and
    hold-the-bar convention `run_blocking` uses for in-process ML). The keepalive never moves the bar
    backward and never above 100.
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
                # The child produced no new line within one keepalive interval. It is alive but quiet —
                # a long roformer/ffmpeg pass that parses no percentage — so renew the lease with a
                # heartbeat at the last pct we reported (0 until the first real percentage). Holds the
                # bar; never moves it backward, never above 100.
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

    The drain loop `async for _line in ctx.runner(argv): pass`, written three times in steps/separate.py
    (decode, and both FLAC encodes). Those calls run ffmpeg with `-loglevel error`, so there is nothing
    to read on success and a non-zero exit raises inside the runner regardless — draining is the whole
    interaction. One name for it means a step never re-writes the loop (and never accidentally forgets
    to consume the generator, which would leave the child unwaited).
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

    MOVED INTACT from whisperx.py. Both halves matter, and both were real failures observed on a live
    process — this is not defensive coding:

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
    had a capacity it did not — a cancelled process went on burning CPU/VRAM and a concurrency>1 worker
    over-committed.

    A thread executing native torch code CANNOT be forcibly killed — Python has no such primitive, and
    cancelling the to_thread future does NOT stop the thread, it only detaches our handle so the work
    keeps running unobserved (worse, not better). So the honest fix is not to pretend we killed it: we
    AWAIT the still-running future on the way out, shielded from the very cancellation that is unwinding
    us, so this generator does not finish until the thread genuinely has. The caller frees its slot only
    when run_blocking returns, so the slot now stays held for exactly as long as real work is in flight.
    The cost is that a cancelled ML process does not free its slot instantly — it frees it when the current
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
        while not task.done():
            try:
                await asyncio.shield(asyncio.wait({task}))
            except asyncio.CancelledError:
                # A SECOND cancellation reached us through the shield. shield() raises to its awaiter
                # immediately while the inner wait keeps running concurrently, so the thread is NOT
                # finished here — loop and await it again instead of returning with the thread live.
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
    """Every namespace a step did NOT declare, so an undeclared write can be detected.

    `ctx.out` is watched at FIELD granularity, not as a whole: `notes` is appended by every step via
    `ctx.note()` and `timings_sec` is filled by the runner itself, so neither is a declared write and
    both must stay exempt. EVERY OTHER `Outputs` field is wire-shaped — it becomes part of the
    CompleteResult — so the guard has to cover it, and a step that writes one without declaring `out`
    is caught the same way an undeclared `ctx.audio` write is. The set is derived from the dataclass
    fields minus the exempt pair rather than hardcoded, so a wire-shaped field added later (as
    `media_uri`, then `selection`, each were — #75, #197, #708 are the same defect landing three times
    on a hardcoded list) is watched automatically instead of silently slipping through.
    """
    watched = {"audio", "lyrics", "stems", "engines"}
    declared_roots = {w.split(".", 1)[0] for w in step.writes}
    snap = {root: repr(getattr(ctx, root)) for root in watched - declared_roots}
    if "out" not in declared_roots:
        # Mechanical exemptions only: the runner fills `timings_sec` after the step returns, and every
        # step appends `notes` via `ctx.note()` — both are legitimate undeclared writes. Anything else
        # `Outputs` grows is wire-shaped and watched with no code change.
        exempt = {"notes", "timings_sec"}
        watched_out = tuple(
            getattr(ctx.out, f.name)
            for f in dataclasses.fields(ctx.out)
            if f.name not in exempt
        )
        snap["out"] = repr(watched_out)
    return snap


def _assert_declared_writes(ctx: Ctx, step: Any, before: dict[str, Any]) -> None:
    """Fail loudly when a step wrote somewhere it did not declare.

    Keeps `Ctx` from decaying into a god-object where any step writes anything — which is the standing
    objection to a shared mutable context, and the reason the declarations have to be enforced rather
    than merely written. Compares the per-root reprs `_snapshot` captured before the step ran: coarse
    (whole namespaces, or `ctx.out`'s wire-shaped fields), but it needs no bookkeeping in the steps
    themselves, and the failure names the step and the namespace.
    """
    after = _snapshot(ctx, step)
    for root, was in before.items():
        if after.get(root) != was:
            raise AssertionError(
                f"step '{step.name}' wrote to ctx.{root} without declaring it in `writes` "
                f"(declared: {sorted(step.writes)})"
            )
