"""The one step every workflow body takes first: making its job's cancel token current.

A step rather than a registration hook, so there is no wiring to forget: DBOS runs a fork or a recovered run
on its own loop, whose context never saw the transport set the token (docs/arch/05-worker.md §8.1).
"""

from __future__ import annotations

from encore_worker.adapters import cli
from encore_worker.steps.records import JobRef


def bind_cancel_token(job: JobRef) -> None:
    """Make job `job`'s cancel token the current one, on whichever loop and context this runs."""
    cli.bind(job.job_id)
