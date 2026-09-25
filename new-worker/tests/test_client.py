"""The transport, against a fake duplex channel. No network, no core, no models, and NO SLEEPS.

DETERMINISM IS THE POINT OF THE SHAPE HERE. An earlier version of this file drove the session with
`asyncio.sleep(0.05)` and hoped the spawned job task had finished — which passes on an idle laptop and
flakes on a loaded CI box, and flakes toward a FALSE PASS: the assertion runs before the thing it checks
has happened. Every wait below is on an explicit `Event` or on `Client.drain()`, so these tests are as
fast as the machine and as reliable as the logic.

The scenarios that matter are the ones around a dropped connection, because that is the event that both
expires a lease AND hides the revocation it causes — so it is where two workers can end up publishing
different lyrics for one song.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Awaitable, Callable

import pytest

from encore_worker.host.config import Config
from encore_worker.protocol import frames as f
from encore_worker.protocol.vocabulary import Stage
from encore_worker.transport.client import Client, jittered_backoff, keepalive
from encore_worker.transport.ownership import Ownership, Reason

CFG = Config(core_url="ws://core.test/w", worker_id="w1", concurrency=1, version="9")
CAPS = frozenset({"align", "stems"})


def no_backoff(_attempt: int) -> float:
    """Zero delay, so no reconnect test ever actually waits."""
    return 0.0


class FakeSocket:
    """A scripted duplex channel whose lifetime the TEST controls.

    Yields `inbound`, sets `drained`, then blocks on `release` until the test says the session may end.
    That handshake removes the timing races: a test can assert on mid-session state knowing every frame
    has been dispatched, and end the session knowing nothing is still in flight.
    """

    def __init__(self, inbound: list[dict[str, object]] | None = None) -> None:
        self.inbound = list(inbound or [])
        self.sent: list[dict[str, object]] = []
        self.closed = False
        #: Set once every inbound frame has been handed to the client.
        self.drained = asyncio.Event()
        #: The test sets this to let the session finish.
        self.release = asyncio.Event()

    async def send(self, message: str) -> None:
        self.sent.append(json.loads(message))

    async def __aiter__(self) -> AsyncIterator[str]:
        for frame in self.inbound:
            yield json.dumps(frame)
        self.drained.set()
        await self.release.wait()

    async def close(self) -> None:
        self.closed = True

    def types(self) -> list[str]:
        return [str(s.get("type")) for s in self.sent]

    def first(self, kind: str) -> dict[str, object]:
        for frame in self.sent:
            if frame.get("type") == kind:
                return frame
        raise AssertionError(f"no {kind} frame was sent; got {self.types()}")


def assign(job_id: str = "j1", action: str = "align") -> dict[str, object]:
    return {
        "type": "job:assign",
        "jobId": job_id,
        "mediaId": "m1",
        "jobType": action,
        "mediaDir": "/media/m1",
    }


def client(
    socket: FakeSocket,
    *,
    run_job: Callable[[f.Assign], Awaitable[f.Complete]] | None = None,
    caps: frozenset[str] = CAPS,
    cfg: Config = CFG,
    strict: bool = False,
) -> Client:
    async def ok(a: f.Assign) -> f.Complete:
        return f.Complete(worker_id=cfg.worker_id, job_id=a.job_id, media_uri="media/m1.mp3")

    async def connect(url: str) -> FakeSocket:
        return socket

    return Client(
        config=cfg,
        connect=connect,
        run_job=run_job or ok,
        capabilities=caps,
        backend="mlx",
        backoff=no_backoff,
        # Opt-in, because the default is now the PUSH-ONLY guard: today's core answers no `job:claim`, and
        # requiring a confirmation it cannot send would refuse every publish after the full cook.
        ownership=Ownership(require_confirmation=strict),
    )


class Session:
    """One session, driven deterministically.

    Entering runs a session and waits until every inbound frame has been dispatched, so the body can
    assert on live state. Exiting drains in-flight jobs and then releases the socket, so the session ends
    only once there is nothing left running — which is what a sleep was previously guessing at.
    """

    def __init__(self, c: Client, socket: FakeSocket) -> None:
        self.client = c
        self.socket = socket
        self._task: asyncio.Task[None] | None = None

    async def __aenter__(self) -> Session:
        self._task = asyncio.create_task(self.client.serve_forever(max_attempts=1))
        await asyncio.wait_for(self.socket.drained.wait(), 5.0)
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.client.drain(timeout_sec=5.0)
        self.socket.release.set()
        if self._task is not None:
            await asyncio.wait_for(self._task, 5.0)


class Gate:
    """A `run_job` that blocks until released, so a test can assert on state while a job is live."""

    def __init__(self, worker_id: str = "w1") -> None:
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.worker_id = worker_id

    async def __call__(self, a: f.Assign) -> f.Complete:
        self.entered.set()
        await self.release.wait()
        return f.Complete(worker_id=self.worker_id, job_id=a.job_id, media_uri="media/m1.mp3")


# ── handshake ────────────────────────────────────────────────────────────────────────────────────


async def test_announces_itself_on_connect() -> None:
    sock = FakeSocket()
    async with Session(client(sock), sock):
        pass

    hello = sock.first("worker:hello")
    assert hello["workerId"] == "w1"
    caps = hello["capabilities"]
    assert isinstance(caps, list)
    assert sorted(caps) == ["align", "stems"]
    assert hello["backend"] == "mlx", "a Mac announcing mlx must not be believed to run torch"
    assert hello["concurrency"] == 1


async def test_closes_the_socket_when_the_session_ends() -> None:
    sock = FakeSocket()
    async with Session(client(sock), sock):
        pass
    assert sock.closed


# ── accepting work ───────────────────────────────────────────────────────────────────────────────


async def test_accepts_a_job_it_serves_and_reports_completion() -> None:
    sock = FakeSocket([assign()])
    async with Session(client(sock), sock):
        pass

    assert "job:accept" in sock.types()
    assert "job:complete" in sock.types()


async def test_refuses_an_action_it_does_not_serve() -> None:
    sock = FakeSocket([assign(action="stems")])
    async with Session(client(sock, caps=frozenset({"align"})), sock):
        pass

    assert "does not serve" in str(sock.first("job:reject")["reason"])
    assert "job:accept" not in sock.types()


async def test_refuses_an_unknown_action() -> None:
    sock = FakeSocket([assign(action="transmogrify")])
    async with Session(client(sock), sock):
        pass
    assert "unknown action" in str(sock.first("job:reject")["reason"])


async def test_refuses_when_every_slot_is_busy() -> None:
    """Concurrency is 1, so a second assignment while the first is live must be rejected, not queued."""
    gate = Gate()
    sock = FakeSocket([assign("j1"), assign("j2")])
    c = client(sock, run_job=gate)
    async with Session(c, sock):
        await asyncio.wait_for(gate.entered.wait(), 5.0)
        gate.release.set()

    assert "no free slots" in str(sock.first("job:reject")["reason"])


async def test_a_job_failure_is_reported_not_crashed_on() -> None:
    async def boom(a: f.Assign) -> f.Complete:
        raise RuntimeError("demucs blew up")

    sock = FakeSocket([assign()])
    async with Session(client(sock, run_job=boom), sock):
        pass

    failed = sock.first("job:failed")
    assert failed["error"] == "demucs blew up"
    assert failed["retryable"] is True


async def test_a_non_retryable_failure_says_so() -> None:
    class Permanent(RuntimeError):
        retryable = False

    async def boom(a: f.Assign) -> f.Complete:
        raise Permanent("video unavailable")

    sock = FakeSocket([assign()])
    async with Session(client(sock, run_job=boom), sock):
        pass
    assert sock.first("job:failed")["retryable"] is False


# ── the ownership guard ──────────────────────────────────────────────────────────────────────────


async def test_claims_a_job_it_just_accepted() -> None:
    """The core assigned it, but `accepted` marks it unconfirmed — publishing on that is the failure."""
    sock = FakeSocket([assign()])
    async with Session(client(sock, strict=True), sock):
        pass
    assert sock.first("job:claim")["jobIds"] == ["j1"]


# ── the push-only guard: what actually runs against today's core ──────────────────────────────────


async def test_by_default_it_does_not_claim_at_all() -> None:
    """Today's core implements neither claim frame and DROPS unknown ones silently
    (`core/server.ts:172` returns without closing or erroring). Asking a question nothing can answer is a
    wasted frame, so the claim is suppressed rather than sent into the void.

    When core learns the two frames, `require_confirmation=True` turns this back on — that is the whole
    switch, and this test is what pins the two halves together.
    """
    sock = FakeSocket([assign()])
    async with Session(client(sock), sock):
        pass
    assert "job:claim" not in sock.types()


async def test_by_default_an_accepted_job_may_publish_without_a_claim_round() -> None:
    """THE reason the default flipped. With confirmation required and no core able to answer, every job ran
    to completion — a full download, separation and alignment — and then `may_publish` refused it forever.
    Fail-closed is right, but only when the counterpart exists; without it, it is a total outage.

    The residual exposure is deliberate and equals the OLD worker's: a `job:revoked` pushed while the
    socket is down is never seen. Parity, not a regression.

    Asserted WHILE THE JOB IS LIVE, behind the gate: `finished()` releases the slot the moment the job
    ends, so a check after the session drains reads an empty ledger and passes for the wrong reason.
    """
    gate = Gate()
    sock = FakeSocket([assign()])
    c = client(sock, run_job=gate)
    async with Session(c, sock):
        await asyncio.wait_for(gate.entered.wait(), 5.0)
        assert c.ownership.may_publish("j1") is True
        assert c.ownership.pending_claims() == frozenset(), "nothing may wait on an ack that cannot come"
        gate.release.set()


async def test_the_push_half_still_revokes_by_default() -> None:
    """What is NOT given up. `job:revoked` is core-initiated, so it needs no support the core lacks — the
    strong half of the guard is the one that already works."""
    sock = FakeSocket([assign(), {"type": "job:revoked", "jobId": "j1", "reason": "lease expired"}])
    c = client(sock)
    async with Session(c, sock):
        pass
    assert c.ownership.may_publish("j1") is False
    assert c.ownership.lost_reason("j1") is Reason.REVOKED


async def test_a_revoked_frame_stops_the_job_and_forbids_publishing() -> None:
    """The revocation arrives before the spawned task even runs, and the REASON must outlive the job —
    otherwise an operator asking why it produced nothing finds nothing."""
    sock = FakeSocket([assign(), {"type": "job:revoked", "jobId": "j1", "reason": "lease expired"}])
    c = client(sock)
    async with Session(c, sock):
        pass

    assert c.ownership.lost_reason("j1") is Reason.REVOKED
    assert c.ownership.may_publish("j1") is False
    assert "job:complete" not in sock.types(), "a revoked job must not report success"


async def test_a_cancel_is_recorded_distinctly_from_a_revocation() -> None:
    """An operator cancelling and the reaper reassigning both stop the work, for different reasons."""
    sock = FakeSocket([assign(), {"type": "job:cancel", "jobId": "j1"}])
    c = client(sock)
    async with Session(c, sock):
        pass
    assert c.ownership.lost_reason("j1") is Reason.CANCELLED


async def test_a_claim_ack_confirms_and_permits_publishing() -> None:
    """Asserted while the job is live: `finished()` releases the slot the moment it ends."""
    gate = Gate()
    sock = FakeSocket([assign(), {"type": "job:claim-ack", "owned": ["j1"]}])
    c = client(sock, run_job=gate, strict=True)
    async with Session(c, sock):
        await asyncio.wait_for(gate.entered.wait(), 5.0)
        assert c.ownership.may_publish("j1") is True
        gate.release.set()


async def test_confirm_ownership_refuses_a_job_already_known_lost() -> None:
    """No round trip needed: the push half already told us."""
    c = client(FakeSocket())
    c.ownership.accepted("j1")
    c.ownership.revoked("j1")
    assert await c.confirm_ownership("j1", timeout_sec=0.01) is False


async def test_confirm_ownership_permits_a_confirmed_job_immediately() -> None:
    c = client(FakeSocket())
    c.ownership.accepted("j1")
    c.ownership.claim_answered(owned=frozenset({"j1"}), revoked=frozenset(), unknown=frozenset())
    assert await c.confirm_ownership("j1", timeout_sec=0.01) is True


async def test_an_unanswered_claim_is_a_refusal() -> None:
    """A timeout means ownership could not be ESTABLISHED, and publishing without establishing it is
    exactly what the guard prevents. Waiting forever would hang the job instead.

    STRICT: this is the pull half, so it only means anything against a core that answers claims. With the
    default push-only guard there is no claim to go unanswered — see the pair of tests below."""
    c = client(FakeSocket(), strict=True)
    c.ownership.accepted("j1")
    assert await c.confirm_ownership("j1", timeout_sec=0.01) is False


async def test_an_unknown_job_is_refused() -> None:
    c = client(FakeSocket())
    assert await c.confirm_ownership("never-seen", timeout_sec=0.01) is False


async def test_a_desync_is_surfaced_not_folded_into_a_reassignment() -> None:
    sock = FakeSocket([assign(), {"type": "job:claim-ack", "unknown": ["j1"]}])
    c = client(sock)
    async with Session(c, sock):
        pass
    assert c.ownership.lost_reason("j1") is Reason.CORE_NEVER_HEARD_OF_IT


# ── reconnect ────────────────────────────────────────────────────────────────────────────────────


async def test_a_disconnect_leaves_held_jobs_unconfirmed() -> None:
    """A blip must not abandon healthy work, but nothing may publish until re-claimed."""
    sock = FakeSocket()
    c = client(sock, strict=True)
    c.ownership.accepted("j1")
    c.ownership.claim_answered(owned=frozenset({"j1"}), revoked=frozenset(), unknown=frozenset())
    async with Session(c, sock):
        pass

    assert c.ownership.may_publish("j1") is False
    assert "j1" in c.ownership.pending_claims()


async def test_reconnects_after_a_connect_failure() -> None:
    attempts: list[str] = []

    async def flaky(url: str) -> FakeSocket:
        attempts.append(url)
        raise OSError("connection refused")

    c = Client(config=CFG, connect=flaky, run_job=_never, capabilities=CAPS, backoff=no_backoff)
    await asyncio.wait_for(c.serve_forever(max_attempts=3), 5.0)
    assert len(attempts) == 3, "a dropped core must be retried, not fatal"


def test_the_default_backoff_is_jittered() -> None:
    """Several workers lost the same core at the same instant; an unjittered schedule keeps them in
    lockstep forever, hammering the core each time it returns."""
    assert len({jittered_backoff(2) for _ in range(20)}) > 1, "backoff must not be a constant"


def test_the_default_backoff_grows_then_plateaus() -> None:
    """Unbounded growth would leave a worker asleep for hours after a long outage."""
    schedule = [jittered_backoff(n) for n in range(1, 9)]
    assert min(schedule[:2]) < max(schedule[-2:]), "it must back off as attempts accumulate"
    assert max(schedule) < 60.0, "the plateau must stay short enough to recover promptly"


# ── malformed input ──────────────────────────────────────────────────────────────────────────────


async def test_an_unparseable_frame_is_skipped_not_fatal() -> None:
    """One bad frame must not drop a long-lived socket and abandon every running job with it."""
    sock = FakeSocket([{"type": "nonsense"}, assign()])
    async with Session(client(sock), sock):
        pass
    assert "job:accept" in sock.types(), "the good frame after the bad one must still be served"


async def test_outbound_frames_are_json() -> None:
    sock = FakeSocket([assign()])
    async with Session(client(sock), sock):
        pass
    assert all(isinstance(s, dict) and "type" in s for s in sock.sent)


# ── progress and state ───────────────────────────────────────────────────────────────────────────


async def test_progress_and_state_are_separate_frames() -> None:
    """A stage and a percentage cannot express "retrying on the mix, attempt 2"."""
    sock = FakeSocket()
    c = client(sock)
    async with Session(c, sock):
        await c.progress("j1", Stage.ALIGNING, 40)
        await c.state("j1", "verify", 2, "retime", "coverage 0.42", "align-on-mix")

    assert sock.first("job:progress")["pct"] == 40
    state = sock.first("job:state")
    assert (state["attempt"], state["knob"], state["verdict"]) == (2, "align-on-mix", "retime")


async def test_heartbeat_reports_free_slots_and_running_jobs() -> None:
    gate = Gate()
    sock = FakeSocket([assign()])
    c = client(sock, run_job=gate)
    async with Session(c, sock):
        await asyncio.wait_for(gate.entered.wait(), 5.0)
        await c.heartbeat()
        beat = sock.first("worker:heartbeat")
        assert beat["runningJobIds"] == ["j1"]
        assert beat["slotsFree"] == 0, "the only slot is taken by the live job"
        assert c.running_jobs() == frozenset({"j1"})
        gate.release.set()


async def test_a_send_on_a_dead_socket_does_not_raise() -> None:
    """Raising would propagate out of the job driver and be reported as a JOB failure, which is wrong:
    the job is fine, the socket is not, and the core requeues on lease expiry anyway."""
    c = client(FakeSocket())  # never connected, so there is no socket to send on
    await c.progress("j1", Stage.ALIGNING, 10)


# ── keepalive ────────────────────────────────────────────────────────────────────────────────────


async def test_keepalive_emits_once_per_tick_with_time_injected() -> None:
    """The old worker parsed a child's stdout for progress and went silent whenever the child did — a
    45-minute roformer pass emitted nothing between its opening 0 and closing 100.

    Time is INJECTED, so this asserts the loop's behaviour rather than racing a clock. The previous
    version slept 50ms and hoped for two ticks, which is a false-pass shape: the assertion could run
    before the ticks happened.
    """
    sock = FakeSocket()
    c = client(sock)
    ticks = 0

    async def fake_sleep(seconds: float) -> None:
        nonlocal ticks
        assert seconds == 10.0, "the configured interval must be what is actually waited on"
        ticks += 1
        if ticks >= 3:
            raise asyncio.CancelledError  # end the loop deterministically

    async with Session(c, sock):
        with pytest.raises(asyncio.CancelledError):
            await keepalive(c, "j1", Stage.SEPARATING, every_sec=10.0, sleep=fake_sleep)

    assert sock.types().count("job:progress") == 2, "one frame per completed tick, no more"


async def test_keepalive_reports_the_stage_and_percentage_it_was_given() -> None:
    sock = FakeSocket()
    c = client(sock)

    async def once(_seconds: float) -> None:
        if sock.types().count("job:progress") >= 1:
            raise asyncio.CancelledError

    async with Session(c, sock):
        with pytest.raises(asyncio.CancelledError):
            await keepalive(c, "j1", Stage.SEPARATING, pct=40, sleep=once)

    frame = sock.first("job:progress")
    assert frame["stage"] == "separating"
    assert frame["pct"] == 40


# ── draining ─────────────────────────────────────────────────────────────────────────────────────


async def test_drain_waits_for_in_flight_work() -> None:
    """Real shutdown behaviour: dropping a job costs the core a lease expiry and the singer a wait."""
    gate = Gate()
    sock = FakeSocket([assign()])
    c = client(sock, run_job=gate)
    async with Session(c, sock):
        await asyncio.wait_for(gate.entered.wait(), 5.0)
        assert c.running_jobs() == frozenset({"j1"})
        gate.release.set()
        await c.drain(timeout_sec=5.0)
        assert c.running_jobs() == frozenset(), "drain must not return while a job is live"


async def test_drain_on_an_idle_worker_returns_immediately() -> None:
    c = client(FakeSocket())
    await asyncio.wait_for(c.drain(timeout_sec=5.0), 1.0)


async def _never(assign: f.Assign) -> f.Complete:  # pragma: no cover - never invoked
    raise AssertionError("run_job should not be called")


# ── the published stem format is negotiated, not configured ───────────────────────────────────────


async def test_the_core_announcement_overrides_the_local_setting() -> None:
    """Core owns the storage layout: it records the ref forever and serves it. A worker that preferred its
    own env would write files whose recorded refs 404 — silently, per core's own note."""
    sock = FakeSocket([{"type": "worker:welcome", "publishStemFormat": "wav"}])
    c = client(sock)
    assert c.publish_stem_format == "flac", "seeded from config before the handshake"
    async with Session(c, sock):
        pass
    assert c.publish_stem_format == "wav"


async def test_an_older_core_leaves_the_configured_fallback_in_place() -> None:
    """A core that announces nothing must not blank the format — publishing at an empty extension would
    write `m1-instrumental.` and record a ref naming no file."""
    sock = FakeSocket([{"type": "worker:welcome"}])
    c = client(sock)
    async with Session(c, sock):
        pass
    assert c.publish_stem_format == "flac"


async def test_a_reconnect_picks_up_a_changed_format() -> None:
    """Mutable on the client rather than on the frozen Config precisely so this works: an operator changing
    core's format and restarting it should not need to restart every worker."""
    sock = FakeSocket([{"type": "worker:welcome", "publishStemFormat": "m4a"}])
    c = client(sock)
    async with Session(c, sock):
        pass
    assert c.publish_stem_format == "m4a"
