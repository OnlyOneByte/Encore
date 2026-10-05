"""Who owns which job, tracked locally so `publish` can be refused without a round trip.

Where the pushed and the pulled half of the ownership guard both land: pure, no sockets and no clock, fed
frames by `client.py` and asked questions by `steps`. It FAILS CLOSED — an unknown job is not ours. Why both
halves are needed and what each of the rules below closes: XW-09, docs/arch/05-worker.md §7 and §7.1.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum, auto


class Standing(StrEnum):
    """What this worker believes about one job."""

    #: Assigned to us and not revoked. The only standing that permits a publish.
    OURS = "ours"
    #: The core said it is not ours any more, or told us it never heard of it.
    LOST = "lost"
    #: Never seen, or dropped from the ledger. Treated as LOST for every decision.
    UNKNOWN = "unknown"


class Reason(StrEnum):
    """Why a job was lost, for the operator note and for telling races apart."""

    REVOKED = auto()
    CLAIM_DENIED = auto()
    CORE_NEVER_HEARD_OF_IT = auto()
    CANCELLED = auto()


@dataclass
class Ownership:
    """The local ledger of job standing, deliberately NOT authoritative — the core is.

    Records what the core last told us so a decision needs no round trip; `pending_claims()` names the
    standings stale enough to be worth asking about again.
    """

    #: Does the CORE answer `job:claim` with `job:claim-ack`? Default TRUE because it does; set it FALSE
    #: only to run a new worker against an OLD core, which drops the claim silently
    #: (docs/arch/05-worker.md §7.1).
    require_confirmation: bool = True
    _ours: set[str] = field(default_factory=set)
    #: Why each lost job was lost. Retained past the job's end and bounded (docs/arch/05-worker.md §7.1).
    _lost: dict[str, Reason] = field(default_factory=dict)
    _lost_cap: int = 512
    #: Jobs accepted since the last successful claim round, re-asked after every reconnect. Always EMPTY
    #: when `require_confirmation` is False, so nothing waits on it.
    _unconfirmed: set[str] = field(default_factory=set)

    # ── what the transport tells it ──────────────────────────────────────────────────────────────

    def accepted(self, job_id: str) -> None:
        """We took an assignment: ours until told otherwise, unconfirmed until a claim round."""
        self._ours.add(job_id)
        self._lost.pop(job_id, None)
        if self.require_confirmation:
            self._unconfirmed.add(job_id)

    def revoked(self, job_id: str, reason: Reason = Reason.REVOKED) -> None:
        """The core reassigned it, or cancelled it. Idempotent: a duplicate frame changes nothing."""
        self._ours.discard(job_id)
        self._unconfirmed.discard(job_id)
        self._lost[job_id] = reason
        while len(self._lost) > self._lost_cap:
            # Oldest out; dicts preserve insertion order, so this is FIFO with no second structure.
            self._lost.pop(next(iter(self._lost)))

    def claim_answered(
        self, *, owned: frozenset[str], revoked: frozenset[str], unknown: frozenset[str]
    ) -> None:
        """Apply a `job:claim-ack`. `unknown` is LOST but keeps its OWN reason, being a real desync
        rather than an ordinary reassignment (docs/arch/05-worker.md §7.1)."""
        for job_id in owned:
            self._ours.add(job_id)
            self._lost.pop(job_id, None)
            self._unconfirmed.discard(job_id)
        for job_id in revoked:
            self.revoked(job_id, Reason.CLAIM_DENIED)
        for job_id in unknown:
            self.revoked(job_id, Reason.CORE_NEVER_HEARD_OF_IT)

    def disconnected(self) -> None:
        """A connection dropped. Everything we hold becomes unconfirmed again, and NOT lost.

        A no-op without `require_confirmation`, exposure included: docs/arch/05-worker.md §7.1.
        """
        if self.require_confirmation:
            self._unconfirmed |= set(self._ours)

    def finished(self, job_id: str) -> None:
        """Release a job's slot. Does NOT clear a recorded loss, which has to outlive the job
        (docs/arch/05-worker.md §7.1)."""
        self._ours.discard(job_id)
        self._unconfirmed.discard(job_id)

    # ── what the steps ask it ────────────────────────────────────────────────────────────────────

    def standing(self, job_id: str) -> Standing:
        if job_id in self._lost:
            return Standing.LOST
        if job_id in self._ours:
            return Standing.OURS
        return Standing.UNKNOWN

    def may_publish(self, job_id: str) -> bool:
        """Is this job ours, confirmed, and not revoked? An UNCONFIRMED job cannot publish, which is the
        whole point of the pull half; the caller re-claims and asks again."""
        return job_id in self._ours and job_id not in self._unconfirmed

    def lost_reason(self, job_id: str) -> Reason | None:
        return self._lost.get(job_id)

    def pending_claims(self) -> frozenset[str]:
        """Jobs whose standing needs confirming before they may publish."""
        return frozenset(self._unconfirmed)

    def running(self) -> frozenset[str]:
        """Every job we believe is ours, for the heartbeat frame."""
        return frozenset(self._ours)

    def explain(self, job_id: str) -> str:
        """One line for the `NotOurJob` message, so the abandoned reason reaches the decision trail."""
        match self.standing(job_id):
            case Standing.OURS:
                if job_id in self._unconfirmed:
                    return (
                        f"job {job_id} is unconfirmed since the last reconnect — ownership not re-established"
                    )
                return f"job {job_id} is ours"
            case Standing.LOST:
                return f"job {job_id} was taken from us ({self._lost[job_id].value})"
            case Standing.UNKNOWN:
                return f"job {job_id} is not in this worker's ledger at all"
