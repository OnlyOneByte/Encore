"""The runtime: plan validation, the STOP short-circuit, and the write guard.

These are the spec's §7 enforcement tests for the runtime layer (E1 and E2). They test the machinery, not
any action — a plan of toy steps is the right subject, because the point is that the RUNTIME is correct
regardless of what the steps do.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import AsyncIterator

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
    stages_of,
    validate_plan,
)
from src.runtime import runner as runner_mod  # noqa: E402
from src.vocabulary import Stage  # noqa: E402


def job(tmp_path, job_type="align") -> JobSpec:
    return JobSpec(
        job_id="j1", media_id="m1", job_type=job_type, source_uri="https://yt/x", params={}, media_dir=str(tmp_path)
    )


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


async def drain(proc, spec):
    return [ev async for ev in proc.process(spec)]


# ── E1: a plan is well-formed, or it fails at validation ─────────────────────────


def test_a_step_reading_what_no_earlier_step_writes_is_REFUSED():
    """The whole point of declaring reads and writes.

    A reordered step, or one dropped into the wrong slot, otherwise surfaces as a confusing `None` several
    steps later — on the deploy box, mid-cook. Here it is a validation error naming the step and the key.
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
        ],
    )
    validate_plan(plan)  # must not raise


def test_the_runner_seeds_what_it_guarantees():
    """A step may read `job`, `work`, `runner` and the resolved engines without an earlier step writing
    them — the runner builds those before the first step runs."""
    validate_plan(LinearPlan("seeded", [Writes("s", writes=set(), reads={"job", "work", "runner", "engines"})]))


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


def test_stages_are_DERIVED_from_the_plan():
    """`vocabulary.STAGE_PLANS` is generated from this rather than hand-maintained, so the wire contract
    and what the worker actually does cannot drift. They already had."""
    plan = LinearPlan(
        "two-stage",
        [
            Writes("a", writes=set()),
            Writes("b", writes=set()),
            _Aligning("c"),
        ],
    )
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
    song stuck cooking forever on a step that is working correctly, because readiness waits on align."""
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


def test_an_unknown_action_has_no_plan_and_says_which(tmp_path):
    from src.runtime.plan import plan_for

    with pytest.raises(Exception) as exc:
        plan_for(job(tmp_path, job_type="not-an-action"), None)  # type: ignore[arg-type]
    assert "not-an-action" in str(exc.value)
