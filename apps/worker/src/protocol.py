"""Pure dial-home protocol layer — message builders, parsing, and the per-job-type stage plan.

No sockets, no torch, no asyncio: this is the unit-tested core (mirrors the TS pure-vs-I/O split,
e.g. dispatch.ts vs worker-hub.ts). The I/O shell is dial_home.py. See
docs/ARCHITECTURE.md for the wire contract.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .vocabulary import STAGE_PLANS as _STAGE_PLANS
from .vocabulary import Action, Stage

# ── message type strings (must match packages/shared/src/core/events.ts) ──────────────
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
# Aliased to the Stage enum in vocabulary.py so there is one definition; these names stay for the
# existing call sites and remain plain-string comparable.
STAGE_DOWNLOADING = Stage.DOWNLOADING.value
STAGE_SEPARATING = Stage.SEPARATING.value

# The stage sequence a job of each type passes through (drives the live phone progress bar).
# `stems` = download the source then separate vocals; `align` = download then word-align lyrics.
# Derived from the enum plan so adding an action cannot leave this table stale.
STAGE_PLANS: dict[str, list[str]] = {
    action.value: [s.value for s in stages] for action, stages in _STAGE_PLANS.items()
}


# ── worker -> core message builders ──────────────────────────────────────────────
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
    # What this box actually is. The worker already resolves all of it at startup and PRINTS it, so a
    # log line was the only record — an operator reading "stems took 43 minutes" on the dashboard had
    # no way to know whether that was a GPU or 4 shared cores. Optional so an older core ignores it.
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
    # WHAT ACTUALLY RAN. The core only ever knew what it ASKED for: it resolves engine/model from
    # global settings at dispatch and the worker can legitimately resolve something else (a model
    # alias, a backend this host cannot load, a device fallback to CPU). Without this the per-model
    # dashboard would be reporting requests as if they were facts.
    if facts:
        msg["facts"] = facts
    # PER-STAGE wall clock. The core can already derive TOTAL processing time from its own
    # accept→complete timestamps; what it cannot see is the split — whether 40 of those 43 minutes
    # were the download or the separation. Measured here because only the worker knows when a stage
    # actually changed.
    if stages:
        msg["stages"] = stages
    # WHY THIS LYRIC WON. `summary()` renders these facts to the cook log, which rotates and is
    # per-container; this is the same facts as durable data so a mis-pick is answerable from the
    # audit trail weeks later, not from a log line that is already gone (#669).
    if selection:
        msg["selection"] = selection
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

    def supports(self, job_type: str) -> bool:
        """Does this worker advertise a capability that can serve this ACTION?

        A capability is not always the bare job type. Both axes namespace theirs — a separator engine
        advertises `stems:roformer`, a downloader advertises `fetch:ytdlp` — so matching the job type
        as a literal string rejects a job this worker can genuinely run. That is what made every
        `fetch` job fail with "unsupported job type: fetch" against a worker advertising `fetch:ytdlp`,
        and it would equally reject a plain `stems` job on a roformer-only worker.

        A prefix match on the job type covers `fetch`/`stems`/`align`, whose serving capability is
        namespaced UNDER their own name (`fetch:ytdlp`, `stems:roformer`). It does NOT cover
        `stems-upgrade`, whose capability is a `stems`/`stems:*` token — a separator engine, chosen
        core-side by `upgradeEngine`, exactly like a plain `stems` job (`dial_home.py` binds one
        runner to both). The core's `requiredCapability` already maps the upgrade action onto a
        stems-family capability; deriving the token textually from `stems-upgrade` here disagreed
        with that for the one action of the four whose capability lives under a different name.

        So resolve the ACTION to the capability family that serves it — any separation action is
        served by a `stems`/`stems:*` token — then match. Unknown/unnamespaced actions keep the
        plain prefix behaviour, so an action the worker cannot run is still refused.
        """
        served_by = self._serving_action(job_type)
        return served_by in self.capabilities or any(c.startswith(f"{served_by}:") for c in self.capabilities)

    @staticmethod
    def _serving_action(job_type: str) -> str:
        """The action name whose capability family serves this job type.

        `stems-upgrade` is a separation action served by the same `stems`/`stems:*` engine tokens as
        a plain `stems` job, so it resolves to `stems`. Every other action serves itself. Keyed off
        the `Action` vocabulary's own `is_separation` rather than a second hand-maintained table, so
        a new separation action is covered here without a further edit.
        """
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
    """Measure how long each stage of one job took, from the progress stream it already emits.

    WHY HERE AND NOT IN EACH PROCESSOR. Every processor already yields a ProgressEvent whenever it
    moves to a new stage, so the transitions are all observable from outside — which means timing them
    needs no change to demucs.py, roformer.py or whisperx.py at all, and cannot drift when one of them
    is edited. A stage ENDS when a different stage begins, or when the job finishes.

    Injected clock (`monotonic`) so this is a pure unit under test: no sleeping, no asyncio. Monotonic
    rather than wall time because a duration must not go negative if the host's clock steps.
    """

    def __init__(self, monotonic) -> None:
        self._now = monotonic
        self._current: str | None = None
        self._started: float = 0.0
        self._done: list[dict[str, Any]] = []

    def observe(self, stage: str) -> None:
        """A progress event arrived. Closes the previous stage when the name actually changed."""
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
    """Describe the box this worker runs on, for the metrics dashboard.

    Delegates to hardware.probe() rather than re-deriving the fields, because a second copy of
    "what is this machine" drifts from the first: the auto-sizers already have to know the EFFECTIVE
    core count (the tightest of cpu_count, scheduler affinity and the cgroup quota), and a dashboard
    reporting `os.cpu_count()` beside a worker that sized itself for 2 of those 32 cores is worse than
    reporting nothing — the two numbers disagree and neither is labelled.

    Best-effort by construction: torch may be absent entirely (the stub processor needs no ML), and a
    probe that raised here would take down a worker over a diagnostic. Every field is therefore
    optional and a failed probe is omitted rather than guessed.
    """
    import platform

    from .hardware import probe

    try:
        report = probe()
    except Exception:
        # Never fail a handshake over a diagnostic.
        return {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "python": platform.python_version(),
        }

    facts: dict[str, Any] = {
        "platform": platform.platform(),
        "machine": report.machine,
        "python": platform.python_version(),
        # EFFECTIVE, not the host's total — see WorkerHost.cpuCount in events.ts.
        "cpuCount": report.cpus,
        "accelerator": report.accelerator,
        # Kept so readers already branching on `cuda` keep working. Derived from the same probe as
        # `accelerator` so the two cannot disagree, and false for ROCm — which reports through torch's
        # cuda API but is not CUDA, and was previously indistinguishable from it.
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
