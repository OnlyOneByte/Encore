"""Pure dial-home protocol layer: message builders, parsing, the per-job-type stage plan.

No sockets, no torch, no asyncio — the I/O shell is dial_home.py. See docs/ARCHITECTURE.md §9.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .vocabulary import STAGE_PLANS as _STAGE_PLANS
from .vocabulary import Action, Stage, serves_family

# Message type strings (must match src/lib/contract/core/events.ts).
# worker -> core
HELLO = "worker:hello"
HEARTBEAT = "worker:heartbeat"
ACCEPT = "job:accept"
REJECT = "job:reject"
PROGRESS = "job:progress"
COMPLETE = "job:complete"
FAILED = "job:failed"
# core -> worker
WELCOME = "worker:welcome"
ASSIGN = "job:assign"
CANCEL = "job:cancel"
PING = "ping"

# media:status stage vocabulary the core rebroadcasts to phones; aliased to Stage so there is one
# definition and these names stay plain-string comparable.
STAGE_DOWNLOADING = Stage.DOWNLOADING.value
STAGE_SEPARATING = Stage.SEPARATING.value

# Per-job-type stage sequence (drives the phone progress bar), derived from the enum plan so adding
# an action cannot leave this table stale.
STAGE_PLANS: dict[str, list[str]] = {
    action.value: [s.value for s in stages] for action, stages in _STAGE_PLANS.items()
}


def hello(
    worker_id: str,
    capabilities: list[str],
    concurrency: int,
    version: str,
    host: dict[str, Any] | None = None,
) -> dict[str, Any]:
    msg: dict[str, Any] = {
        "type": HELLO,
        "workerId": worker_id,
        "capabilities": capabilities,
        "concurrency": concurrency,
        "version": version,
    }
    # For the dashboard; optional so an older core ignores it.
    if host:
        msg["host"] = host
    return msg


def heartbeat(worker_id: str, slots_free: int, running_job_ids: list[str]) -> dict[str, Any]:
    return {
        "type": HEARTBEAT,
        "workerId": worker_id,
        "slotsFree": slots_free,
        "runningJobIds": running_job_ids,
    }


def accept(worker_id: str, job_id: str) -> dict[str, Any]:
    return {"type": ACCEPT, "workerId": worker_id, "jobId": job_id}


def reject(worker_id: str, job_id: str, reason: str) -> dict[str, Any]:
    return {"type": REJECT, "workerId": worker_id, "jobId": job_id, "reason": reason}


def progress(worker_id: str, job_id: str, stage: str, pct: int, eta_sec: int | None = None) -> dict[str, Any]:
    msg: dict[str, Any] = {
        "type": PROGRESS,
        "workerId": worker_id,
        "jobId": job_id,
        "stage": stage,
        "pct": pct,
    }
    if eta_sec is not None:
        msg["etaSec"] = eta_sec
    return msg


def complete(
    worker_id: str,
    job_id: str,
    media_uri: str,
    artifacts: dict[str, Any] | None = None,
    facts: dict[str, Any] | None = None,
    stages: list[dict[str, Any]] | None = None,
    selection: dict[str, Any] | None = None,
) -> dict[str, Any]:
    msg: dict[str, Any] = {"type": COMPLETE, "workerId": worker_id, "jobId": job_id, "mediaUri": media_uri}
    if artifacts is not None:
        msg["artifacts"] = artifacts
    # ResolvedFacts: what actually ran, not what was asked. See docs/SERVER.md#what-the-worker-is-told.
    if facts:
        msg["facts"] = facts
    # StageTiming: only the worker sees this split. See docs/SERVER.md#what-the-worker-is-told.
    if stages:
        msg["stages"] = stages
    # Durable so a mis-pick is answerable weeks after the per-container process log rotates.
    if selection:
        msg["selection"] = selection
    return msg


def failed(worker_id: str, job_id: str, error: str, retryable: bool) -> dict[str, Any]:
    return {"type": FAILED, "workerId": worker_id, "jobId": job_id, "error": error, "retryable": retryable}


@dataclass
class WorkerState:
    """Local mirror of this worker's capacity. The CORE registry is authoritative for dispatch;
    this guards the worker from over-committing and decides accept vs reject on an assign."""

    worker_id: str
    capabilities: list[str]
    concurrency: int
    running: set[str] = field(default_factory=set)

    @property
    def slots_free(self) -> int:
        return max(0, self.concurrency - len(self.running))

    def supports(self, job_type: str) -> bool:
        """Namespaced capability-prefix match, not a literal job-type match. See
        docs/SERVER.md#what-the-worker-is-told."""
        return serves_family(self.capabilities, self._serving_action(job_type))

    @staticmethod
    def _serving_action(job_type: str) -> str:
        """The action whose capability family serves this job type; keyed off `Action.is_separation`
        so a new separation action needs no further table."""
        try:
            action = Action(job_type)
        except ValueError:
            return job_type
        return Action.STEMS.value if action.is_separation else job_type

    def can_accept(self, job_type: str) -> tuple[bool, str]:
        """(ok, reason) — reject if the worker lacks the capability or has no free slot."""
        if not self.supports(job_type):
            return False, f"unsupported job type: {job_type}"
        if self.slots_free <= 0:
            return False, "no free slots"
        return True, ""

    def start(self, job_id: str) -> None:
        self.running.add(job_id)

    def finish(self, job_id: str) -> None:
        self.running.discard(job_id)


def stages_for(job_type: str) -> list[str]:
    """The ordered stages a job of this type emits (falls back to a download+separate plan)."""
    return STAGE_PLANS.get(job_type, [STAGE_DOWNLOADING, STAGE_SEPARATING])


class StageTimer:
    """Times each stage from the progress stream, so no processor contains timing code. See
    docs/SERVER.md#what-the-worker-is-told. Clock is injected for a pure unit under test and so a
    stepped wall clock cannot produce a negative duration."""

    def __init__(self, monotonic) -> None:
        self._now = monotonic
        self._current: str | None = None
        self._started: float = 0.0
        self._done: list[dict[str, Any]] = []

    def observe(self, stage: str) -> None:
        """Closes the previous stage when the name actually changed."""
        if stage == self._current:
            return  # same stage ticking pct — not a transition
        self._close()
        self._current = stage
        self._started = self._now()

    def finish(self) -> list[dict[str, Any]]:
        """Close the final stage and return [{stage, ms}] in the order they ran."""
        self._close()
        self._current = None
        return list(self._done)

    def _close(self) -> None:
        if self._current is None:
            return
        ms = int(round((self._now() - self._started) * 1000))
        self._done.append({"stage": self._current, "ms": max(0, ms)})


def host_facts() -> dict[str, Any]:
    """Best-effort box description for the metrics dashboard; delegates to hardware.probe() so this
    cannot drift from the auto-sizers' own count, and a failed probe is omitted, never guessed."""
    import platform

    from .host.hardware import probe

    try:
        report = probe()
    except Exception:
        return {  # never fail a handshake over a diagnostic
            "platform": platform.platform(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        }

    facts: dict[str, Any] = {
        "platform": platform.platform(),
        "machine": report.machine,
        "python": platform.python_version(),
        "cpuCount": report.cpus,  # EFFECTIVE count. See docs/SERVER.md#what-the-worker-is-told.
        "accelerator": report.accelerator,
        # Derived from accelerator so it cannot disagree; false for ROCm, which masquerades as cuda.
        "cuda": report.accelerator == "cuda",
        "contained": report.contained,
    }
    if report.torch_version:
        facts["torch"] = report.torch_version
    if report.device_name:
        facts["deviceName"] = report.device_name
    if report.device_count:
        facts["deviceCount"] = report.device_count
    if report.memory_bytes:
        facts["memoryBytes"] = report.memory_bytes
    if report.vram_bytes:
        facts["vramBytes"] = report.vram_bytes
    return facts
