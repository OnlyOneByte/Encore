"""The runtime: how a job's plan gets executed, and nothing about what the work IS.

    ctx.py     the per-job context every step reads and writes
    step.py    the Step contract and the outcome a step can return
    plan.py    plans, plan selection, and the validation that makes a plan checkable
    runner.py  the single executor, plus the subprocess and keepalive machinery

This layer knows about plans, steps and contexts. It knows nothing about audio, lyrics or separation, and
it must never import from a domain package — the dependency rule in
`docs/specs/SPEC-worker-pipeline.md` §3. `PLANS` is populated by `src/plans.py`, which is the one module
allowed to import both the runtime and the steps, precisely so that rule holds mechanically rather than
by good intentions.
"""
from __future__ import annotations

from .ctx import AudioCtx, Ctx, LyricsCtx, Outputs, ResolvedEngines, StemsCtx
from .plan import PLANS, LinearPlan, Plan, PlanError, plan_for, stages_of, validate_plan
from .runner import LEASE_KEEPALIVE_SEC, PlanRunner, run_blocking, scratch_for
from .step import Outcome, Step, StepResult

__all__ = [
    "AudioCtx",
    "Ctx",
    "LyricsCtx",
    "Outputs",
    "ResolvedEngines",
    "StemsCtx",
    "LEASE_KEEPALIVE_SEC",
    "LinearPlan",
    "Outcome",
    "PLANS",
    "Plan",
    "PlanError",
    "PlanRunner",
    "Step",
    "StepResult",
    "plan_for",
    "run_blocking",
    "scratch_for",
    "stages_of",
    "validate_plan",
]
