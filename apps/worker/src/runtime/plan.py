"""Plans: what each action does, and the one seam that decides iteration order.

A plan is a list of steps. Execution is linear. Divergence is resolved by `plan_for` BEFORE the first
step runs, never mid-plan — see `docs/ARCHITECTURE.md` §7.1, which tabulates every
divergence candidate in this codebase and on the roadmap and shows each one is answerable from job
params, settings or the resolved engine up front.

    static plan EXECUTION, dynamic plan SELECTION

THE SEAM. `Plan.after()` is the only place iteration order is decided. `LinearPlan` returns the next
entry; a future `GraphPlan` would return a transition. Steps, `Ctx`, the reads/writes declarations, the
enforcement tests and the doc generator are identical either way, so choosing a state machine later
costs one class rather than a rewrite. The revisit trigger is written down in the spec: the first
divergence `plan_for` cannot resolve up front, where moving it to the core would be wrong rather than
merely inconvenient.
"""
from __future__ import annotations

from typing import Iterable, Protocol

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


# ── validation ────────────────────────────────────────────────────────────────────
#
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
        "engines.separator_model",
        "engines.device",
        "audio.is_local",
        "audio.duration_sec",
    }
)


class PlanError(RuntimeError):
    """A plan that cannot be executed correctly. Raised at validation time, not at run time."""


def validate_plan(plan: Plan) -> None:
    """Assert every step's `reads` are satisfied by an earlier `writes` or by the seed.

    This is what a declared plan buys. A reordered step, or one dropped into the wrong slot, is a
    mistake that otherwise shows up as a confusing `None` several steps later — on the deploy box, in
    the middle of a cook. Here it is a test failure with the step and the key named.

    Deliberately ignores `applies()`: a plan must be well-formed for the case where every step runs.
    A step whose input is only *sometimes* produced should declare it in `reads` and handle absence, which
    is the honest shape — a plan that is only valid on some paths is one nobody can reason about.
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

    `vocabulary.STAGE_PLANS` is DERIVED from this rather than hand-maintained, so the wire contract and
    what the worker actually does cannot drift. They already had: the table said align was two stages
    while the real action emitted DOWNLOADING three times and covered acquisition, grading and wav2vec2
    under one ALIGNING span.
    """
    out: list[Stage] = []
    for step in plan.steps():
        if not out or out[-1] is not step.stage:
            if step.stage not in out:
                out.append(step.stage)
    return out


# ── the plans ─────────────────────────────────────────────────────────────────────
# Populated by src/plans.py, which imports the steps. Kept separate so the runtime never imports a step
# and the dependency rule in the spec's §3 ("dependencies point down only") holds mechanically.
PLANS: dict[Action, Plan] = {}


def plan_for(job: JobSpec, engines: ResolvedEngines) -> Plan:
    """The plan this job will run.

    DIVERGENCE LIVES HERE. Everything that selects different work — which separator engine, a
    lead-vs-backing split producing four stems instead of two, a scoring tier — is knowable from job
    params, settings or the resolved engine before any step executes, so it is a lookup rather than a
    branch. `engines` is accepted (unused today) because that is the input a future plan choice would
    read, and leaving it out is what would make adding one a signature change across the runner.
    """
    action = parse_action(job.job_type)
    plan = PLANS.get(action)
    if plan is None:
        raise PlanError(f"no plan for action: {job.job_type}")
    return plan
