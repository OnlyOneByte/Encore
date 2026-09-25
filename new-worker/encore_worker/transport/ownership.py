"""Who owns which job, tracked locally so `publish` can be refused without a round trip.

THE PROBLEM. The core's reaper requeues a job whose lease expired, handing it to another worker. If this
worker is mid-alignment when that happens, both will finish and both will publish — different lyrics for
one song, last writer wins, no error anywhere.

THE GUARD IS TWO-SIDED, and both halves are needed:

  * `job:revoked` PUSHED by the core closes the window continuously. A poll cannot: the reassignment
    happens at a moment nobody chose.
  * `job:claim` / `job:claim-ack` PULLED by this worker covers what a push loses. A disconnect drops
    pushed frames, and a disconnect is precisely what causes a lease to expire and a job to be
    reassigned — so the one event that revokes a job is the same event that hides the revocation.

Either alone leaves a case where two workers publish. This ledger is where both land, and it is pure: no
sockets, no clock. `client.py` feeds it frames and `steps` ask it questions.

FAIL CLOSED. An unknown job is NOT ours. A worker that publishes for a job it cannot account for is
exactly the failure being prevented, and the cost of being wrong the other way is one redundant re-claim.
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
    """The local ledger of job standing.

    Deliberately NOT authoritative — the core is. This records what the core last told us, so a decision
    can be made without a round trip, and `pending_claims()` names the jobs whose standing is stale
    enough to be worth asking about again.
    """

    #: Does the CORE answer `job:claim` with `job:claim-ack`? When it does not, the pull half of the guard
    #: cannot run and requiring it would deadlock every job: `accepted()` would mark the job unconfirmed,
    #: nothing would ever clear it, and `may_publish` would refuse forever — after the full 40-minute cook.
    #:
    #: DEFAULT FALSE, because today's core implements neither frame and drops unknown ones silently
    #: (`core/server.ts:172`). False leaves the PUSH half (`job:revoked`) working, which is exactly the
    #: guard the old worker ships with — so this is parity, not a regression. Flip it on in the same change
    #: that teaches core the two frames, and the stronger guarantee arrives with its counterpart.
    require_confirmation: bool = False
    _ours: set[str] = field(default_factory=set)
    #: Why each lost job was lost. RETAINED past the job's end, deliberately — see `finished()`.
    #: Bounded, because this process is long-lived and a revoked job id would otherwise never leave.
    _lost: dict[str, Reason] = field(default_factory=dict)
    _lost_cap: int = 512
    #: Jobs accepted since the last successful claim round. Re-asked after every reconnect, because a
    #: reconnect is the event most likely to have hidden a revocation. Always EMPTY when
    #: `require_confirmation` is False — nothing populates it, so nothing waits on it.
    _unconfirmed: set[str] = field(default_factory=set)

    # ── what the transport tells it ──────────────────────────────────────────────────────────────

    def accepted(self, job_id: str) -> None:
        """We took an assignment. Ours until told otherwise, and unconfirmed until a claim round IF the
        core can answer one."""
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
            # Oldest out. dicts preserve insertion order, so this is FIFO without a second structure.
            self._lost.pop(next(iter(self._lost)))

    def claim_answered(
        self, *, owned: frozenset[str], revoked: frozenset[str], unknown: frozenset[str]
    ) -> None:
        """Apply a `job:claim-ack`.

        `unknown` is treated as LOST but recorded with its OWN reason. A job the core has never heard of
        is a real desync — this worker is running something the core has no row for — and folding it into
        an ordinary reassignment would hide that. It must not publish either way.
        """
        for job_id in owned:
            self._ours.add(job_id)
            self._lost.pop(job_id, None)
            self._unconfirmed.discard(job_id)
        for job_id in revoked:
            self.revoked(job_id, Reason.CLAIM_DENIED)
        for job_id in unknown:
            self.revoked(job_id, Reason.CORE_NEVER_HEARD_OF_IT)

    def disconnected(self) -> None:
        """A connection dropped. Everything we hold becomes unconfirmed again.

        Standing is NOT reset to LOST here — that would abandon healthy in-flight work on every blip, and
        a reconnect usually confirms the same jobs. But every one of them must be re-claimed before it
        can publish, which is what `pending_claims()` then reports.

        A no-op without `require_confirmation`: with no core to answer, marking jobs unconfirmed would
        strand them rather than protect them. The residual exposure is the honest one — a revocation pushed
        while the socket was down is never seen, which is the same window the old worker lives with.
        """
        if self.require_confirmation:
            self._unconfirmed |= set(self._ours)

    def finished(self, job_id: str) -> None:
        """Release a job's slot. Does NOT clear a recorded loss.

        The loss has to outlive the job, and that is the subtle part. A revoked job's driver runs its
        cleanup the moment it is cancelled, so clearing `_lost` here would erase the reason the job
        produced nothing — exactly when an operator asks why. A job that completed normally has no
        `_lost` entry to keep, so this costs nothing in the ordinary case.
        """
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
        """Is this job ours, confirmed, and not revoked?

        An UNCONFIRMED job cannot publish. That is the whole point of the pull half: after a reconnect we
        do not know whether the core reassigned this job while we were away, and publishing on a guess is
        the failure mode. The caller re-claims and asks again.
        """
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
