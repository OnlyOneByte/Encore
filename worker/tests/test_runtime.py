"""The runtime: plan validation, the STOP short-circuit, and the write guard.

These are the spec's §7 enforcement tests for the runtime layer (E1 and E2). They test the machinery, not
any action — a plan of toy steps is the right subject, because the point is that the RUNTIME is correct
regardless of what the steps do.
"""

from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.processor import CompleteResult, JobSpec, ProgressEvent  # noqa: E402
from src.runtime import (  # noqa: E402
    Ctx,
    LinearPlan,
    Outcome,
    PlanError,
    PlanRunner,
    Step,
    StepResult,
    scratch_for,
    stages_of,
    validate_plan)
from src.runtime import runner as runner_mod  # noqa: E402
from src.vocabulary import Stage  # noqa: E402
from tests.conftest import drain  # noqa: E402


def job(tmp_path, job_type="align") -> JobSpec:
    return JobSpec(
        job_id="j1",
        media_id="m1",
        job_type=job_type,
        source_uri="https://yt/x",
        params={},
        media_dir=str(tmp_path))


async def noop_runner(argv):  # pragma: no cover - most toy steps never shell out
    if False:
        yield ""


class Writes(Step):
    """A step that writes one key and yields one progress event."""

    stage = Stage.DOWNLOADING

    def __init__(self, name: str, writes: set[str], reads: set[str] | None = None) -> None:
        self.name = name
        self.writes = frozenset(writes)
        self.reads = frozenset(reads or set())

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        for key in self.writes:
            root, _, leaf = key.partition(".")
            if leaf:
                setattr(getattr(ctx, root), leaf, "written")
        yield ProgressEvent(stage=self.stage, pct=100)


# ── E1: a plan is well-formed, or it fails at validation ─────────────────────────


def test_a_step_reading_what_no_earlier_step_writes_is_REFUSED():
    """The whole point of declaring reads and writes.

    A reordered step, or one dropped into the wrong slot, otherwise surfaces as a confusing `None` several
    steps later — on the deploy box, mid-process. Here it is a validation error naming the step and the key.
    """
    plan = LinearPlan("broken", [Writes("second", writes=set(), reads={"lyrics.texts"})])
    with pytest.raises(PlanError, match="lyrics.texts"):
        validate_plan(plan)


def test_the_same_plan_in_the_RIGHT_order_validates():
    plan = LinearPlan(
        "ok",
        [
            Writes("first", writes={"lyrics.texts"}),
            Writes("second", writes=set(), reads={"lyrics.texts"}),
        ])
    validate_plan(plan)  # must not raise


def test_the_runner_seeds_what_it_guarantees():
    """A step may read `job`, `work`, `runner` and the resolved engines without an earlier step writing
    them — the runner builds those before the first step runs."""
    validate_plan(
        LinearPlan("seeded", [Writes("s", writes=set(), reads={"job", "work", "runner", "engines"})])
    )


def test_a_plan_with_two_identically_named_steps_is_REFUSED():
    """Names key the per-step timings the metrics page reads, so a duplicate would silently overwrite one
    measurement with another."""
    plan = LinearPlan("dupes", [Writes("same", writes=set()), Writes("same", writes=set())])
    with pytest.raises(PlanError, match="two steps named"):
        validate_plan(plan)


def test_an_unnamed_step_is_REFUSED():
    plan = LinearPlan("anon", [Writes("", writes=set())])
    with pytest.raises(PlanError, match="no name"):
        validate_plan(plan)


class _RecordsIfRun(Step):
    """A step that flips a flag the moment its body runs, so a test can prove it never got that far."""

    stage = Stage.DOWNLOADING

    def __init__(self, name: str, reads: set[str]) -> None:
        self.name = name
        self.writes = frozenset()
        self.reads = frozenset(reads)
        self.ran = False

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        self.ran = True
        yield ProgressEvent(stage=self.stage, pct=100)


@pytest.mark.asyncio
async def test_the_RUNNER_refuses_a_malformed_plan_before_any_step_runs(tmp_path):
    """The pipeline guarantee, not just the function.

    `validate_plan` is exercised directly above, but the promise `plan.py`'s docstring makes — a
    reordered step is a validation error naming the step and the key, NOT a confusing `None` several
    steps later on the deploy box mid-process — is only kept because `PlanRunner.process` calls it before
    the first step. Drive a malformed plan (a step reading a key nothing earlier writes) through the
    runner via the `plans=` injection seam and assert it is refused BEFORE execution: the step's `ran`
    flag must stay False. Deleting the runner's `validate_plan` call reds this — the step runs, reads an
    empty namespace, and the job reports a bogus success.
    """
    step = _RecordsIfRun("reader", reads={"lyrics.texts"})
    malformed = LinearPlan("malformed", [step])
    proc = PlanRunner(runner=noop_runner, plans=lambda spec, engines: malformed)
    with pytest.raises(PlanError, match="lyrics.texts"):
        await drain(proc, job(tmp_path))
    assert step.ran is False, "the step ran despite a malformed plan — validation did not gate execution"


def test_stages_are_DERIVED_from_the_plan():
    """`vocabulary.STAGE_PLANS` is generated from this rather than hand-maintained, so the wire contract
    and what the worker actually does cannot drift. They already had."""
    plan = LinearPlan(
        "two-stage",
        [
            Writes("a", writes=set()),
            Writes("b", writes=set()),
            _Aligning("c"),
        ])
    assert stages_of(plan) == [Stage.DOWNLOADING, Stage.ALIGNING]


class _Aligning(Writes):
    stage = Stage.ALIGNING

    def __init__(self, name: str) -> None:
        super().__init__(name, writes=set())


# ── the STOP short-circuit ───────────────────────────────────────────────────────


class Stops(Step):
    name = "stops"
    stage = Stage.ALIGNING

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        yield StepResult(outcome=Outcome.STOP, reason="nothing to do")


class Marks(Step):
    stage = Stage.ALIGNING
    writes = frozenset({"out"})

    def __init__(self, name: str) -> None:
        self.name = name

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        ctx.out.artifacts[self.name] = True
        yield ProgressEvent(stage=self.stage, pct=100)


@pytest.mark.asyncio
async def test_STOP_ends_the_plan_and_still_COMPLETES(tmp_path):
    """STOP means the job is DONE, not failed. The one real case is an instrumental: no source produced
    any text, so the remaining lyrics steps have nothing to operate on. Raising instead would leave that
    song stuck processing forever on a step that is working correctly, because readiness waits on align."""
    plan = LinearPlan("stopping", [Stops(), Marks("after")])
    proc = PlanRunner(runner=noop_runner, plans=lambda j, e: plan)
    events = await drain(proc, job(tmp_path))
    done = [e for e in events if isinstance(e, CompleteResult)]
    assert len(done) == 1, "a STOP must still produce exactly one CompleteResult"
    assert "after" not in done[0].artifacts, "steps after a STOP must not run"


@pytest.mark.asyncio
async def test_a_STOP_is_never_silent(tmp_path, capsys):
    """A completion nobody can explain is the failure class this worker keeps digging out of."""
    plan = LinearPlan("stopping", [Stops()])
    await drain(PlanRunner(runner=noop_runner, plans=lambda j, e: plan), job(tmp_path))
    assert "nothing to do" in capsys.readouterr().out


@pytest.mark.asyncio
async def test_a_step_that_does_not_apply_is_skipped_and_says_so(tmp_path, capsys):
    class Never(Marks):
        def applies(self, ctx: Ctx) -> bool:
            return False

    plan = LinearPlan("skipping", [Never("nope"), Marks("yes")])
    events = await drain(PlanRunner(runner=noop_runner, plans=lambda j, e: plan), job(tmp_path))
    done = [e for e in events if isinstance(e, CompleteResult)][0]
    assert "nope" not in done.artifacts and "yes" in done.artifacts
    assert "nope: skipped" in capsys.readouterr().out


@pytest.mark.asyncio
async def test_a_raising_step_FAILS_the_job_rather_than_stopping_it(tmp_path):
    """STOP and failure are different outcomes and must not blur: the core retries a failure and settles
    a completion."""

    class Boom(Step):
        name = "boom"
        stage = Stage.ALIGNING

        async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
            raise RuntimeError("real failure")
            yield  # pragma: no cover

    plan = LinearPlan("boom", [Boom()])
    with pytest.raises(RuntimeError, match="real failure"):
        await drain(PlanRunner(runner=noop_runner, plans=lambda j, e: plan), job(tmp_path))


@pytest.mark.asyncio
async def test_a_raising_step_still_FLUSHES_the_notes_before_it_propagates(tmp_path, capsys):
    """The worker's own diagnosis must survive a failure — that is the one moment it is needed.

    A step raising is how it signals FAILURE (step.py). Earlier steps deliberately accumulate notes
    (baseline scores, the "aligning against the MIX" warning, caption-fetch misses) that ARE the
    explanation for that failure. The runner buffers notes rather than printing them directly so they
    can be asserted; the cost is that the buffer must be flushed on the failure path too. Before this
    fix the flush sat after the step loop, so a raise skipped it entirely and the operator got a bare
    exception with no trace of why. Here a note-writing step runs, then a step raises, and the note
    must still reach the log.
    """

    class Note(Step):
        name = "note"
        stage = Stage.ALIGNING

        async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
            ctx.note("aligning against the MIX — no vocals stem")
            yield ProgressEvent(stage=self.stage, pct=100)

    class Boom(Step):
        name = "boom"
        stage = Stage.ALIGNING

        async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
            raise RuntimeError("text was acquired but nothing could be timed")
            yield  # pragma: no cover

    plan = LinearPlan("note-then-boom", [Note(), Boom()])
    with pytest.raises(RuntimeError, match="nothing could be timed"):
        await drain(PlanRunner(runner=noop_runner, plans=lambda j, e: plan), job(tmp_path))
    assert "aligning against the MIX — no vocals stem" in capsys.readouterr().out, (
        "a note recorded before the failing step must reach the log on the raise path"
    )


# ── per-step timing ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_every_step_that_ran_is_TIMED(tmp_path):
    """What the internal metrics page could not see before. StageTimer ends a stage when a different one
    begins, so an align job's three DOWNLOADING emissions collapsed into one span and ALIGNING covered
    acquisition, grading and wav2vec2 as a single blob."""
    plan = LinearPlan("timed", [Marks("one"), Marks("two")])
    events = await drain(PlanRunner(runner=noop_runner, plans=lambda j, e: plan), job(tmp_path))
    done = [e for e in events if isinstance(e, CompleteResult)][0]
    assert set(done.facts["stepTimingsSec"]) == {"one", "two"}


# ── E2: the write guard (test mode) ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_step_writing_where_it_did_NOT_declare_is_caught(tmp_path, monkeypatch):
    """Keeps Ctx from decaying into a god-object where any step writes anything — the standing objection
    to a shared mutable context, and the reason the declarations are enforced rather than merely written.

    Test-mode only, so production pays nothing for it.
    """
    monkeypatch.setattr(runner_mod, "STRICT_WRITES", True)

    class Sneaky(Step):
        name = "sneaky"
        stage = Stage.ALIGNING
        writes = frozenset({"out"})  # declares out, writes audio

        async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
            ctx.audio.path = "/somewhere/undeclared"
            yield ProgressEvent(stage=self.stage, pct=100)

    plan = LinearPlan("sneaky", [Sneaky()])
    with pytest.raises(AssertionError, match="without declaring it"):
        await drain(PlanRunner(runner=noop_runner, plans=lambda j, e: plan), job(tmp_path))


@pytest.mark.asyncio
async def test_a_step_writing_what_it_DID_declare_is_fine(tmp_path, monkeypatch):
    monkeypatch.setattr(runner_mod, "STRICT_WRITES", True)
    plan = LinearPlan("honest", [Writes("honest", writes={"audio.path"})])
    await drain(PlanRunner(runner=noop_runner, plans=lambda j, e: plan), job(tmp_path))


@pytest.mark.asyncio
async def test_a_step_publishing_to_ctx_out_without_declaring_it_is_caught(tmp_path, monkeypatch):
    """`ctx.out` is the one namespace whose shape goes on the wire — `artifacts`, `facts`, `media_uri`
    are what the CompleteResult carries. A step that publishes one of them without declaring `out` used
    to slip through because `_snapshot` never watched `out`, so the generated pipeline doc would then
    claim the step produces nothing. This is the mirror of the undeclared-`audio` case for `out`.
    """
    monkeypatch.setattr(runner_mod, "STRICT_WRITES", True)

    class Publishes(Step):
        name = "publishes"
        stage = Stage.ALIGNING
        writes = frozenset({"audio.path"})  # declares audio, publishes to out

        async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
            ctx.out.artifacts["lyrics"] = {"candidates": []}
            yield ProgressEvent(stage=self.stage, pct=100)

    plan = LinearPlan("publishes", [Publishes()])
    with pytest.raises(AssertionError, match="wrote to ctx.out without declaring it"):
        await drain(PlanRunner(runner=noop_runner, plans=lambda j, e: plan), job(tmp_path))


@pytest.mark.asyncio
async def test_a_step_publishing_ctx_out_facts_without_declaring_it_is_caught(tmp_path, monkeypatch):
    """`facts` is watched with the same field granularity as `artifacts`. A step that resolves an
    engine/model/device onto `ctx.out.facts` without declaring `out` must be caught: `facts` is what
    the per-attempt audit page shows, and letting it slip is the exact undeclared-publisher defect an earlier change was filed for. Companion to the `artifacts` case; every wire-shaped `Outputs` field has one such pin.
    """
    monkeypatch.setattr(runner_mod, "STRICT_WRITES", True)

    class PublishesFacts(Step):
        name = "publishes-facts"
        stage = Stage.ALIGNING
        writes = frozenset({"audio.path"})  # declares audio, publishes to out.facts

        async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
            ctx.out.facts["engine"] = "demucs"
            yield ProgressEvent(stage=self.stage, pct=100)

    plan = LinearPlan("publishes-facts", [PublishesFacts()])
    with pytest.raises(AssertionError, match="wrote to ctx.out without declaring it"):
        await drain(PlanRunner(runner=noop_runner, plans=lambda j, e: plan), job(tmp_path))


@pytest.mark.asyncio
async def test_a_step_publishing_ctx_out_media_uri_without_declaring_it_is_caught(tmp_path, monkeypatch):
    """`media_uri` is watched with the same field granularity as `artifacts`. This is the field with
    the sharpest failure mode: `ctx.py` documents "First published wins; ranking is the core's job",
    so an undeclared second writer of `media_uri` silently decides which artifact the CompleteResult
    points at. It must be caught the same way an undeclared `artifacts` or `facts` write is.
    """
    monkeypatch.setattr(runner_mod, "STRICT_WRITES", True)

    class PublishesMediaUri(Step):
        name = "publishes-media-uri"
        stage = Stage.ALIGNING
        writes = frozenset({"audio.path"})  # declares audio, publishes to out.media_uri

        async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
            ctx.out.media_uri = "/media/x.flac"
            yield ProgressEvent(stage=self.stage, pct=100)

    plan = LinearPlan("publishes-media-uri", [PublishesMediaUri()])
    with pytest.raises(AssertionError, match="wrote to ctx.out without declaring it"):
        await drain(PlanRunner(runner=noop_runner, plans=lambda j, e: plan), job(tmp_path))


@pytest.mark.asyncio
async def test_a_step_publishing_ctx_out_selection_without_declaring_it_is_caught(tmp_path, monkeypatch):
    """`selection` is the fourth wire-shaped field (earlier changes): it crosses to the `job_attempts` audit
    trail as the durable account of WHY a lyric variant won. It was added to `Outputs` after `_snapshot`
    was written, and the guard's `out` snapshot listed `artifacts`, `facts`, `media_uri` explicitly, so
    `selection` was outside the watch — an undeclared second writer could silently decide what
    the per-attempt audit page reports about the variant pick, the same failure mode two earlier changes hit
    on the earlier fields. It must be caught like any other wire-shaped publish; the guard now derives
    the watched set from the dataclass fields so this cannot recur when a fifth field lands.
    """
    monkeypatch.setattr(runner_mod, "STRICT_WRITES", True)

    class PublishesSelection(Step):
        name = "publishes-selection"
        stage = Stage.ALIGNING
        writes = frozenset({"audio.path"})  # declares audio, publishes to out.selection

        async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
            ctx.out.selection = {"winner": "lrclib"}
            yield ProgressEvent(stage=self.stage, pct=100)

    plan = LinearPlan("publishes-selection", [PublishesSelection()])
    with pytest.raises(AssertionError, match="wrote to ctx.out without declaring it"):
        await drain(PlanRunner(runner=noop_runner, plans=lambda j, e: plan), job(tmp_path))


@pytest.mark.asyncio
async def test_a_step_appending_a_note_without_declaring_out_is_fine(tmp_path, monkeypatch):
    """`notes` and `timings_sec` are exempt: every step appends to `ctx.out.notes` via `ctx.note()`
    without declaring `out`, and the runner fills `timings_sec` itself. Watching `out` at field
    granularity must not turn either of those into a false positive.
    """
    monkeypatch.setattr(runner_mod, "STRICT_WRITES", True)

    class Notes(Step):
        name = "notes"
        stage = Stage.ALIGNING
        writes = frozenset({"audio.path"})

        async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
            ctx.note("a step said something")
            yield ProgressEvent(stage=self.stage, pct=100)

    plan = LinearPlan("notes", [Notes()])
    await drain(PlanRunner(runner=noop_runner, plans=lambda j, e: plan), job(tmp_path))


def test_an_unknown_wire_action_is_rejected_by_parse_action(tmp_path):
    """An unrecognised wire job_type fails in `parse_action`, BEFORE plan lookup.

    Named for the branch it actually reaches. `parse_action` raises `ValueError` naming the
    offending value; `plan_for`'s `plan is None` guard is never reached on this path (a real plan is
    never looked up), which is exactly why the no-plan branch needs its own sibling test below.
    """
    from src.runtime.plan import plan_for

    with pytest.raises(ValueError, match="unknown action") as exc:
        plan_for(job(tmp_path, job_type="not-an-action"), None)  # type: ignore[arg-type]
    # It is `parse_action` that raised, not the no-plan guard: the message names the value and does
    # NOT carry the no-plan phrasing.
    assert "not-an-action" in str(exc.value)
    assert "no plan for action" not in str(exc.value)


def test_a_valid_action_with_no_registered_plan_raises_plan_error(tmp_path, monkeypatch):
    """`plan_for`'s `if plan is None` guard (plan.py) fired directly.

    This is the branch `test_an_unknown_wire_action_is_rejected_by_parse_action` names in spirit but
    never reaches: a VALID action (so `parse_action` succeeds) for which `PLANS` holds no plan — the
    "a PlanRunner was built in a process that never registered plans" hazard. Emptying `PLANS` drives
    a valid `align` job past `parse_action` into the guard, which must raise `PlanError`. A permissive
    regression there (returning an empty plan) would let the job complete as a zero-step success; this
    test reds if that guard is loosened.
    """
    from src.runtime import plan as plan_mod
    from src.runtime.plan import PlanError, plan_for

    monkeypatch.setattr(plan_mod, "PLANS", {})
    with pytest.raises(PlanError, match="no plan for action") as exc:
        plan_for(job(tmp_path, job_type="align"), None)  # type: ignore[arg-type]
    # `align` is a real Action, so parse_action did NOT raise — the message proves the no-plan guard
    # is what fired, and it carries the valid action name.
    assert "align" in str(exc.value)


# ── run_blocking: cancellation must not abandon the in-flight thread ──────────────


@pytest.mark.asyncio
async def test_run_blocking_awaits_its_thread_before_the_generator_finishes(tmp_path, monkeypatch):
    """A cancelled ML process must not free its concurrency slot while the thread is still running.

    run_blocking offloads a synchronous ML call to a thread and yields keepalives. When the job is
    cancelled, dial_home cancels the consuming task, which throws GeneratorExit into this generator's
    suspended `yield`. The slot is freed the instant run_blocking returns (_run_job's finally). If the
    generator returned while the thread was still executing, the worker would advertise capacity it did
    not have and a cancelled process would keep burning CPU/VRAM off the books.

    The thread here cannot be killed — it sleeps a fixed span and sets `finished` only when it truly
    ends. We consume one keepalive, then `aclose()` the generator (the GeneratorExit path). With the
    fix, aclose() must not return until `finished` is set. On the pre-fix code (the `to_thread` future
    dropped on unwind) aclose() returns with `finished` still False.
    """
    import threading
    import time as _time

    # A keepalive interval far shorter than the work, so the first __anext__ yields a keepalive while
    # the thread is still running rather than the final result.
    monkeypatch.setattr(runner_mod, "LEASE_KEEPALIVE_SEC", 0.02)

    finished = threading.Event()

    def slow_ml() -> str:
        _time.sleep(0.4)
        finished.set()
        return "done"

    gen = runner_mod.run_blocking(slow_ml, Stage.ALIGNING, 0)
    kind, _val = await gen.__anext__()
    assert kind == "progress", "expected a keepalive while the thread is still running"
    assert not finished.is_set(), "thread should not have finished yet — test setup is wrong"
    await gen.aclose()  # throws GeneratorExit at the suspended yield
    assert finished.is_set(), (
        "run_blocking returned before its thread finished — the slot would be freed while native ML "
        "work is still in flight"
    )


@pytest.mark.asyncio
async def test_run_blocking_survives_a_second_cancel_during_the_shielded_await(monkeypatch):
    """A SECOND cancel arriving while run_blocking is shielding its still-running thread must not free
    the slot early.

    The sibling test above cancels ONCE: the finally awaits the shield and the inner wait is driven to
    completion, so the single-cancel path holds even under the bug. The reachable defect is a SECOND
    cancel (dial_home._on_cancel then drain(cancel=True) on any socket drop, both hitting the same task)
    landing on the shield await mid-ML-pass. asyncio.shield raises CancelledError to its awaiter
    immediately while the inner wait keeps running, so a finally that checks the thread only ONCE
    (`if not task.done()`) swallows that error and returns with the native thread still live. _run_job's
    finally then frees the concurrency slot for capacity that does not exist and rmtrees inputs the
    abandoned thread is still reading.

    We open the generator, consume one keepalive (proving the thread is running), then run `aclose()`
    inside a task: aclose throws GeneratorExit, which unwinds into the finally and suspends on the
    shielded `await`. Cancelling THAT task delivers the second cancel straight onto the shield await.
    With the fix (`while`) aclose does not settle until the thread genuinely finishes; with the bug
    (`if`) aclose returns immediately with the thread still running.
    """
    import threading
    import time as _time

    monkeypatch.setattr(runner_mod, "LEASE_KEEPALIVE_SEC", 0.02)

    finished = threading.Event()

    def slow_ml() -> str:
        _time.sleep(0.4)
        finished.set()
        return "done"

    gen = runner_mod.run_blocking(slow_ml, Stage.ALIGNING, 0)
    kind, _val = await gen.__anext__()
    assert kind == "progress", "expected a keepalive while the thread is still running"
    assert not finished.is_set(), "thread should not have finished yet — test setup is wrong"

    # aclose() -> GeneratorExit -> finally -> suspends on `await asyncio.shield(asyncio.wait({task}))`.
    close_task = asyncio.ensure_future(gen.aclose())
    await asyncio.sleep(0.05)  # let the unwind reach the shielded await
    assert not finished.is_set(), "thread finished too soon — the shield window closed before cancel an earlier change"
    assert not close_task.done(), "aclose settled before the second cancel — cannot exercise the path"

    # Second cancel lands on the shielded await inside the finally.
    close_task.cancel()

    # BOUNDED probe first (deadlock-hazard class): never wedge the whole worker suite. A bound
    # comfortably longer than the 0.4s thread but far short of a hang.
    try:
        await asyncio.wait_for(asyncio.shield(close_task), timeout=2.0)
    except (asyncio.CancelledError, asyncio.TimeoutError):
        pass

    # The generator itself must have SETTLED, not merely the thread. `finished` is set by the worker
    # thread (slow_ml), so it goes True after 0.4s whether or not run_blocking ever returned — a
    # cleanup that hangs forever (e.g. the 2nd-cancel handler failing to fall back into the loop) leaves
    # the thread to finish on its own while the generator never unwinds. Assert the generator actually
    # returned so a never-returning cleanup reds this test instead of passing on the thread's coattails:
    # if aclose never settles, _run_job's finally never frees the slot and drain(cancel=True) hangs the
    # reconnect. The bounded wait_for above already gave it 2.0s (>> the 0.4s thread), so on the fix
    # close_task is done here; under a non-settling regression it is still pending.
    assert close_task.done(), (
        "run_blocking never returned at all on a SECOND cancel — the cleanup did not settle, so "
        "_run_job's finally never frees the slot and drain(cancel=True) hangs the reconnect loop"
    )
    assert finished.is_set(), (
        "run_blocking returned on a SECOND cancel while its thread was still running — the swallowed "
        "CancelledError freed the slot for capacity that does not exist (double-run / slot leak)"
    )


# ── scratch_for: the cleanup must delete EXACTLY what the runner created ──────────


def test_scratch_for_produces_the_documented_media_volume_layout(tmp_path):
    """`scratch_for` is the SOLE producer of a job's scratch directory (runner.py builds `ctx.work`
    from it) and is the only thing that reclaims it — dial_home's finally rmtrees the same path, and
    in a two-container deploy a core-side rmtree gets EACCES, so the worker's own delete is the ONLY
    reclaim path. It had zero test callers, so a producer edit that changed the path shape — grouping
    scratch under the media id, a per-attempt subdir, moving off the media volume — sailed past the
    whole suite (579 green) while every processed song leaked its decoded source + both WAV stems until
    the volume filled, silently (`ignore_errors=True`).

    Pin the producer's contract HERE, independent of any hand-rebuilt copy: the expectation is written
    against `job.media_dir`/`work`/`job.job_id` directly, so drifting `scratch_for` reds this test the
    moment the shape changes rather than leaking in production. This is the one side of the two-copy
    duplication that nothing pinned.
    """
    j = job(tmp_path)
    assert scratch_for(j) == os.path.join(str(tmp_path), "work", j.job_id)
    # Not vacuous: the media_dir and job_id both participate, so a shape that drops either (e.g. a
    # media-id grouping level, or a fixed dir) diverges.
    assert scratch_for(j).startswith(str(tmp_path) + os.sep), "scratch must live under the job's media_dir"
    assert scratch_for(j).endswith(os.sep + j.job_id), "scratch must be keyed by the job id"


def test_the_cleanup_derives_its_delete_target_FROM_scratch_for_not_a_hand_rebuild(tmp_path):
    """The consumer (dial_home's finally-block rmtree) must call `scratch_for(job)`, not rebuild the
    `media_dir/work/job_id` layout by hand.

    A hand-rebuilt copy is a SECOND spelling of the producer's layout that drifts silently: change
    `scratch_for` and the cleanup keeps deleting the old path, orphaning the new one. The two
    `test_dial_home.py` cleanup tests hardcode the literal a THIRD time, so they pin the consumer and
    are blind to producer drift — the asymmetry is the whole finding. The durable fix is to
    delete the duplication: have the consumer consume the producer. This guard reads dial_home's source
    and fails if the finally-block rmtree reverts to a hand-built `os.path.join(..., "work",...)`
    instead of `scratch_for(job)`.
    """
    src = Path(__file__).resolve().parents[1] / "src" / "dial_home.py"
    text = src.read_text()
    # Locate the finally-block cleanup rmtree by its distinctive call.
    assert "shutil.rmtree(scratch_for(job)" in text, (
        "dial_home's scratch cleanup must delete scratch_for(job) — deleting a hand-rebuilt "
        'os.path.join(job.media_dir, "work", job.job_id) drifts silently from the producer'
    )
    # And it must NOT re-introduce the hand-rebuilt duplicate as the rmtree target.
    assert 'shutil.rmtree(os.path.join(job.media_dir, "work"' not in text, (
        "dial_home's cleanup rebuilt the scratch layout by hand — a copy that drifts from scratch_for"
    )
    # Not vacuous: prove the file was actually read and is the module under test.
    assert "def _run_job" in text and "scratch_for" in text


# ── run_stage: a slow-but-alive subprocess must keep its lease ─────────────


@pytest.mark.asyncio
async def test_run_stage_emits_a_time_based_keepalive_while_the_child_is_quiet(monkeypatch):
    """A subprocess stage whose child makes no NEW percentage for longer than the progress lease must
    still renew the lease with a TIME-BASED keepalive, or the core's 30 s progressLeaseMs expires and a
    HEALTHY process is reaped and retried as a fresh pass.

    This is the roformer shape exactly: `parse` returns None unconditionally (roformer's
    parse_progress does), so NOT ONE line parses to a percentage, and the child stays quiet for a long
    stretch (a 45-minute separation). Pre-fix, `run_stage` awaited the next line with no timeout, so it
    emitted ONLY its opening 0 and closing 100 — nothing in between — and the reaper killed it at 30 s.

    We shrink LEASE_KEEPALIVE_SEC to 0.02 and make the fake child sleep ~0.25 s (~12 intervals) between
    its one line and finishing, so the fix must emit several keepalives during that quiet window. On the
    pre-fix code the quiet window emits zero events and this reds with `got 0 keepalives`.
    """
    monkeypatch.setattr(runner_mod, "LEASE_KEEPALIVE_SEC", 0.02)

    async def quiet_child(_argv):
        # One line up front (which parses to None, so emits nothing), then a long silent stretch that
        # spans many keepalive intervals before the child exits — a slow-but-alive roformer pass.
        yield "loading model weights"
        await asyncio.sleep(0.25)  # ~12 intervals of 0.02s: alive, but making no parseable progress

    def parse_none(_line):
        return None  # roformer's parse_progress returns None unconditionally

    events = [
        ev
        async for ev in runner_mod.run_stage(quiet_child, Stage.SEPARATING, ["bs-roformer-infer"], parse_none)
    ]
    pcts = [ev.pct for ev in events if isinstance(ev, ProgressEvent) and ev.stage == Stage.SEPARATING]

    # Opening 0 and closing 100 bookend the stage as before.
    assert pcts[0] == 0, f"first event must be the opening 0, got {pcts}"
    assert pcts[-1] == 100, f"last event must be the closing 100, got {pcts}"

    # THE LOAD-BEARING ASSERTION: keepalives fired DURING the quiet stretch. A run of ~12 intervals must
    # produce several; pre-fix there are zero between the 0 and the 100. Require >= 3 so a single stray
    # tick cannot pass it, mirroring the run_blocking keepalive test's margin.
    keepalives = [p for p in pcts if p == 0][1:]  # every 0 AFTER the opening 0 is a held-at-last keepalive
    assert len(keepalives) >= 3, (
        f"run_stage emitted no time-based keepalive while the child ran quietly for ~12 lease intervals "
        f"— a slow roformer pass would breach the 30s lease and be reaped. pcts={pcts}"
    )

    # Anti-vacuity: the keepalive holds the bar at the last-known pct (0 here, since nothing parsed) and
    # NEVER leaks an intermediate value — the bar must not move off 0 until the closing 100.
    assert not any(0 < p < 100 for p in pcts), f"keepalive must hold the bar, never move it, got {pcts}"
