"""The Step contract, and the outcome a step can return.

A step is the smallest unit of work the worker names. It declares four things about itself so the plan
it sits in can be checked and documented without running it:

    name    stable id, used in logs and in the per-step timings the metrics page reads
    stage   the coarse Stage this reports as, because the phone's progress bar is on the wire
    reads   context keys it needs
    writes  context keys it may set

WHY DECLARE READS AND WRITES. It turns a plan from a list into something checkable: `validate_plan` can
assert no step reads a key nothing earlier produced, so a reordered or misplaced step fails at test time
instead of surfacing as a confusing `None` on the deploy box. It is also what makes the pipeline doc
generated rather than hand-written — which matters in this repo specifically, where a module docstring
claiming "both separation and alignment call it" was false for three of four callers.

CLASSES, NOT FUNCTIONS, so one class can fill two plan slots with different construction —
`FetchCaptions(AUTHORED)` and `FetchCaptions(MACHINE)` are the same code and different steps.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum, auto
from typing import AsyncIterator

from ..processor import ProgressEvent
from ..vocabulary import Stage
from .ctx import Ctx


class Outcome(Enum):
    CONTINUE = auto()
    STOP = auto()


@dataclass
class StepResult:
    """What a step says about what should happen next.

    `STOP` means the job is DONE, not failed: complete with whatever the context holds. There is exactly
    one real case today — no source produced any text, because the song is an instrumental, so the four
    remaining lyrics steps have nothing to operate on. It was an early `return` inside the old 257-line
    method, which a flat plan otherwise could not express.

    A short-circuit, not a transition table: there is one exit and it is always "finish". `reason` is
    required in spirit — a STOP with no reason is a silent completion, which is the failure class this
    worker keeps having to dig itself out of.
    """

    outcome: Outcome = Outcome.CONTINUE
    reason: str = ""


class Step(ABC):
    """One named unit of work. Subclasses set the four class attributes and implement `run`."""

    name: str = ""
    stage: Stage = Stage.DOWNLOADING
    reads: frozenset[str] = frozenset()
    writes: frozenset[str] = frozenset()

    def applies(self, ctx: Ctx) -> bool:
        """Should this step run for this job?

        The home for every guard that used to be an `if` buried mid-method — "skip the download when the
        source is declared local", "skip the caption fetch when there is no upload to ask". Declaring it
        makes the skip visible in the log and in the generated doc, and testable without a processor.

        NOT a branch: the sequence is unchanged, one entry is inert.
        """
        return True

    @abstractmethod
    def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        """Do the work, yielding progress and at most one StepResult.

        Yielding no StepResult means CONTINUE, so only the one step that can end a job early has to think
        about it. Raising signals a job FAILURE to the runner, which is a different thing from STOP.
        """
        ...

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<{type(self).__name__} {self.name}>"
