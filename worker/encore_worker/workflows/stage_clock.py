"""Seconds per stage of each running job, for `job:complete`'s `stages` (#1357).

Core stores them on the attempt and the host speed page shows them (`perStage`, the song's history). The step
wrappers (`dbos_align`, `dbos_stems`) time each step they actually run, so a step a resumed workflow replays
from its checkpoint costs nothing and reports nothing. A step that runs more than once in a job (the timing
ladder's `time_text`) is one stage, its runs summed. Timed in the step layer, never in a workflow body, which
must stay deterministic. Thread-safe: a resumed workflow's steps run on DBOS's own loop.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Awaitable, Callable
from typing import Any

_lock = threading.Lock()
#: job id -> stage -> seconds, in the order the stages first ran.
_stages: dict[str, dict[str, float]] = {}


def record(job_id: str, stage: str, seconds: float) -> None:
    with _lock:
        spent = _stages.setdefault(job_id, {})
        spent[stage] = spent.get(stage, 0.0) + seconds


def take(job_id: str) -> tuple[dict[str, Any], ...]:
    """The job's stages as `StageTiming`s (`{"stage", "ms"}`), forgotten as they are read."""
    with _lock:
        spent = _stages.pop(job_id, {})
    return tuple({"stage": stage, "ms": round(seconds * 1000)} for stage, seconds in spent.items())


def timed(job_id: str | None, stage: str, fn: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
    """`fn`, recording its wall time as `stage` of job `job_id` (as is, with no job to record against)."""
    if job_id is None:
        return fn
    owner = job_id

    async def call(*args: Any, **kwargs: Any) -> Any:
        start = time.monotonic()
        try:
            return await fn(*args, **kwargs)
        finally:
            record(owner, stage, time.monotonic() - start)

    return call
