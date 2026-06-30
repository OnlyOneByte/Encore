"""Pure dial-home protocol layer — message builders, parsing, and the per-job-type stage plan.

No sockets, no torch, no asyncio: this is the unit-tested core (mirrors the TS pure-vs-I/O split,
e.g. dispatch.ts vs worker-hub.ts). The I/O shell is dial_home.py. See
docs/job-lifecycle-and-worker-protocol.md §5 for the wire contract.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# ── message type strings (must match packages/shared/src/events.ts) ──────────────
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

# media:status stage vocabulary the core rebroadcasts to phones (events.ts MediaStatus).
STAGE_DOWNLOADING = "downloading"
STAGE_SEPARATING = "separating"
STAGE_ALIGNING = "aligning"

# The stage sequence a job of each type passes through (drives the live phone progress bar).
# `stems` = download the source then separate vocals; `align` = download then word-align lyrics.
STAGE_PLANS: dict[str, list[str]] = {
    "stems": [STAGE_DOWNLOADING, STAGE_SEPARATING],
    "align": [STAGE_DOWNLOADING, STAGE_ALIGNING],
    "score": [STAGE_DOWNLOADING, STAGE_SEPARATING],
}


# ── worker -> core message builders ──────────────────────────────────────────────
def hello(worker_id: str, capabilities: list[str], concurrency: int, version: str) -> dict[str, Any]:
    return {
        "type": HELLO,
        "workerId": worker_id,
        "capabilities": capabilities,
        "concurrency": concurrency,
        "version": version,
    }


def heartbeat(worker_id: str, slots_free: int, running_job_ids: list[str]) -> dict[str, Any]:
    return {"type": HEARTBEAT, "workerId": worker_id, "slotsFree": slots_free, "runningJobIds": running_job_ids}


def accept(worker_id: str, job_id: str) -> dict[str, Any]:
    return {"type": ACCEPT, "workerId": worker_id, "jobId": job_id}


def reject(worker_id: str, job_id: str, reason: str) -> dict[str, Any]:
    return {"type": REJECT, "workerId": worker_id, "jobId": job_id, "reason": reason}


def progress(worker_id: str, job_id: str, stage: str, pct: int, eta_sec: int | None = None) -> dict[str, Any]:
    msg: dict[str, Any] = {"type": PROGRESS, "workerId": worker_id, "jobId": job_id, "stage": stage, "pct": pct}
    if eta_sec is not None:
        msg["etaSec"] = eta_sec
    return msg


def complete(worker_id: str, job_id: str, media_uri: str, artifacts: dict[str, Any] | None = None) -> dict[str, Any]:
    msg: dict[str, Any] = {"type": COMPLETE, "workerId": worker_id, "jobId": job_id, "mediaUri": media_uri}
    if artifacts is not None:
        msg["artifacts"] = artifacts
    return msg


def failed(worker_id: str, job_id: str, error: str, retryable: bool) -> dict[str, Any]:
    return {"type": FAILED, "workerId": worker_id, "jobId": job_id, "error": error, "retryable": retryable}


# ── worker-side state (capacity + capability gating — the accept/reject decision) ──
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

    def can_accept(self, job_type: str) -> tuple[bool, str]:
        """(ok, reason) — reject if the worker lacks the capability or has no free slot."""
        if job_type not in self.capabilities:
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
