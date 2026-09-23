"""Plans: what each action does, and the one seam that decides iteration order.

A plan is a list of steps, executed linearly. Divergence is resolved by `plan_for` BEFORE the first
step runs, never mid-plan — see docs/ARCHITECTURE.md §7.1 (static plan EXECUTION, dynamic plan
SELECTION).

`Plan.after()` is the only place iteration order is decided (`LinearPlan` returns the next entry; a
future `GraphPlan` would return a transition), so choosing a state machine later costs one class
rather than a rewrite.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol

from ..processor import JobSpec
from ..vocabulary import Action, Stage, parse_action
from .ctx import Ctx, ResolvedEngines
from .step import Outcome, Step, StepResult


class Plan(Protocol):
    """How the runner walks a set of steps."""

    name: str

    def steps(self) -> list[Step]: ...
    def first(self) -> Step | None: ...
    def after(self, step: Step, result: StepResult, ctx: Ctx) -> Step | None: ...


class LinearPlan:
    """The next entry, unless a step said STOP.

    Deliberately the whole implementation. A plan you can read top to bottom is most of why a list beats
    a transition table, and nothing in this worker needs more.
    """

    def __init__(self, name: str, steps: Iterable[Step]) -> None:
        self.name = name
        self._steps = list(steps)

    def steps(self) -> list[Step]:
        return list(self._steps)

    def first(self) -> Step | None:
        return self._steps[0] if self._steps else None

    def after(self, step: Step, result: StepResult, ctx: Ctx) -> Step | None:
        if result.outcome is Outcome.STOP:
            return None
        i = self._steps.index(step)
        return self._steps[i + 1] if i + 1 < len(self._steps) else None


# The keys the runner itself guarantees before any step runs. A step may read these without an earlier
# step writing them.
SEEDED_KEYS = frozenset(
    {
        "job",
        "work",
        "runner",
        "engines",
        "engines.asr_model",
        "engines.sync_mode",
        "engines.separator",
        "engines.device",
        "audio.is_local",
        "audio.duration_sec",
    }
)


class PlanError(RuntimeError):
    """A plan that cannot be executed correctly. Raised at validation time, not at run time.

    `retryable = False`: a job whose action has no plan, or a malformed plan, is a
    permanent boundary failure — retrying re-selects the same (missing) plan. The structured
    flag lets `retry_policy.is_retryable` fail it fast instead of spending three attempts.
    """

    retryable = False


def validate_plan(plan: Plan) -> None:
    """Assert every step's `reads` are satisfied by an earlier `writes` or by the seed.

    A reordered step, or one dropped into the wrong slot, otherwise shows up as a confusing `None`
    several steps later mid-process; here it is a test failure naming the step and key. Deliberately
    ignores `applies()`: a plan must be well-formed for the case where every step runs.
    """
    produced = set(SEEDED_KEYS)
    seen: set[str] = set()
    for step in plan.steps():
        if not step.name:
            raise PlanError(f"{type(step).__name__} in plan '{plan.name}' has no name")
        if step.name in seen:
            raise PlanError(f"plan '{plan.name}' has two steps named '{step.name}'")
        seen.add(step.name)
        missing = {k for k in step.reads if k not in produced and _parent(k) not in produced}
        if missing:
            raise PlanError(
                f"plan '{plan.name}' step '{step.name}' reads {sorted(missing)}, which no earlier step "
                f"writes and the runner does not seed"
            )
        produced |= set(step.writes)


def _parent(dotted: str) -> str:
    """'audio.path' -> 'audio'. A step that declares a whole namespace satisfies reads inside it."""
    return dotted.rsplit(".", 1)[0] if "." in dotted else dotted


def stages_of(plan: Plan) -> list[Stage]:
    """The coarse stages a plan emits, in order, deduped.

    `vocabulary.STAGE_PLANS` is a HAND-WRITTEN literal that MUST agree with what this returns (it
    sits below the plans in the import graph, so it cannot be computed from them). Agreement is
    ENFORCED by a test instead, to prevent silent drift between the two.
    """
    out: list[Stage] = []
    for step in plan.steps():
        if not out or out[-1] is not step.stage:
            if step.stage not in out:
                out.append(step.stage)
    return out


# Populated by src/plans.py, which imports the steps: kept separate so the runtime never imports a
# step (dependencies point down only).
PLANS: dict[Action, Plan] = {}


def plan_for(job: JobSpec, engines: ResolvedEngines) -> Plan:
    """The plan this job will run.

    DIVERGENCE LIVES HERE: anything that selects different work is knowable from job params, settings
    or the resolved engine before any step executes, so this is a lookup, not a branch.
    """
    action = parse_action(job.job_type)
    plan = PLANS.get(action)
    if plan is None:
        raise PlanError(f"no plan for action: {job.job_type}")
    return plan
