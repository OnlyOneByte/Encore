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
import contextlib
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from encore_worker.host.config import Config
from encore_worker.protocol import frames as f
from encore_worker.protocol.vocabulary import Stage
from encore_worker.transport import client as transport
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


async def test_dials_with_the_worker_token_core_requires() -> None:
    """WK-01: core 401s a `role=worker` upgrade without a matching `token` once ENCORE_WORKER_TOKEN is set,
    so a worker that never sends it reconnect-loops forever and every job sits unserved."""
    dialled: list[str] = []

    for env in ({"ENCORE_WORKER_TOKEN": "s3 cr&t=/"}, {}):
        sock = FakeSocket()

        async def connect(url: str, sock: FakeSocket = sock) -> FakeSocket:
            dialled.append(url)
            return sock

        cfg = Config.from_env({"ENCORE_CORE_URL": "ws://core.test/ws?role=worker", **env})
        c = Client(config=cfg, connect=connect, run_job=_never, capabilities=CAPS, backoff=no_backoff)
        async with Session(c, sock):
            pass
        assert "s3 cr&t" not in repr(cfg), "the secret must never reach a log line"

    with_token, without = (parse_qs(urlsplit(u).query) for u in dialled)
    assert with_token == {"role": ["worker"], "token": ["s3 cr&t=/"]}, "URL-encoded, role kept"
    assert without == {"role": ["worker"]}, "unset leaves the URL exactly as configured"


def test_reads_the_token_core_wrote_at_every_dial_and_the_env_wins(tmp_path: Path) -> None:
    """#1196: with ENCORE_WORKER_TOKEN unset core writes one to a file, maybe after this worker started."""
    file = tmp_path / "worker-token"
    base = {"ENCORE_CORE_URL": "ws://core.test/ws?role=worker", "ENCORE_WORKER_TOKEN_FILE": str(file)}
    cfg = Config.from_env(base)
    assert "token" not in parse_qs(urlsplit(transport.dial_url(cfg)).query), "no file yet: dial without one"
    # A BOM and a zero-width space, as a hand edit can leave: read through clean_token, as core reads it.
    file.write_text(f"{chr(0xFEFF)}from-the-file{chr(0x200B)}\n")
    assert parse_qs(urlsplit(transport.dial_url(cfg)).query)["token"] == ["from-the-file"]
    explicit = Config.from_env({**base, "ENCORE_WORKER_TOKEN": "from-env"})
    assert parse_qs(urlsplit(transport.dial_url(explicit)).query)["token"] == ["from-env"]


async def test_closes_the_socket_when_the_session_ends() -> None:
    sock = FakeSocket()
    async with Session(client(sock), sock):
        pass
    assert sock.closed


async def test_hello_carries_the_host_report() -> None:
    """Core logs "hardware unreported" on every join when `host` is missing, though the probe ran."""
    sock = FakeSocket()
    c = client(sock)
    c.host = {"platform": "Linux", "accelerator": "cpu"}
    async with Session(c, sock):
        pass
    assert sock.first("worker:hello")["host"] == {"platform": "Linux", "accelerator": "cpu"}


async def test_a_heartbeat_follows_the_hello() -> None:
    """Core resets free slots to `concurrency` on every hello, so a reconnect mid-job must say at once what it
    is really running, or core offers a second job it has to refuse."""
    sock = FakeSocket()
    async with Session(client(sock), sock):
        pass
    types = sock.types()
    assert "worker:heartbeat" in types
    assert types.index("worker:hello") < types.index("worker:heartbeat")
    assert sock.first("worker:heartbeat")["slotsFree"] == 1


async def test_heartbeats_on_the_interval_the_welcome_names() -> None:
    """A heartbeat with the live job in it, every `heartbeatIntervalSec`. An injected sleep drives it."""
    asked: list[float] = []
    beat_sent = asyncio.Event()

    async def sleep(sec: float) -> None:
        asked.append(sec)
        if len(asked) > 1:
            # The first beat after the first sleep is on the wire; park here until the session ends.
            beat_sent.set()
            await asyncio.Event().wait()

    gate = Gate()
    sock = FakeSocket([assign(), {"type": "worker:welcome", "workerId": "w1", "heartbeatIntervalSec": 15}])
    c = client(sock, run_job=gate)
    c.sleep = sleep
    async with Session(c, sock):
        await asyncio.wait_for(beat_sent.wait(), 5.0)
        last = [s for s in sock.sent if s.get("type") == "worker:heartbeat"][-1]
        assert last["runningJobIds"] == ["j1"]
        assert last["slotsFree"] == 0
        gate.release.set()
    assert asked[0] == 15.0


async def test_a_reject_is_followed_by_a_heartbeat() -> None:
    """Core holds a rejecting worker at zero free slots until it hears the real count."""
    sock = FakeSocket([assign(action="stems")])
    async with Session(client(sock, caps=frozenset({"align"})), sock):
        pass
    types = sock.types()
    assert types.index("job:reject") < len(types) - 1 - types[::-1].index("worker:heartbeat")


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


# ── the push-only guard: the OLD-CORE compatibility mode ──────────────────────────────────────────


async def test_with_confirmation_off_it_does_not_claim_at_all() -> None:
    """The mode for running a NEW worker against an OLD core — one that implements neither claim frame and
    drops unknown ones silently, so asking is a wasted frame sent into the void.

    No longer the default: core now answers claims, so `require_confirmation` is True and the full two-sided
    guard runs. This stays covered because the compatibility mode is a real supported configuration, and
    because it is what makes the deadlock impossible if core is ever rolled back.
    """
    sock = FakeSocket([assign()])
    async with Session(client(sock), sock):
        pass
    assert "job:claim" not in sock.types()


async def test_with_confirmation_off_a_job_may_publish_without_a_claim_round() -> None:
    """THE reason this mode exists: with confirmation required and no core able to answer, every job ran to
    completion — download, separation, alignment — and `may_publish` then refused it forever.

    Fail-closed is right only when the counterpart exists; without it, it is a total outage. The residual
    exposure is deliberate and equals the OLD worker's: a `job:revoked` pushed while the socket is down is
    never seen. Asserted WHILE THE JOB IS LIVE, behind the gate, because `finished()` releases the slot the
    moment the job ends and a check after the session drains reads an empty ledger."""
    gate = Gate()
    sock = FakeSocket([assign()])
    c = client(sock, run_job=gate)
    async with Session(c, sock):
        await asyncio.wait_for(gate.entered.wait(), 5.0)
        assert c.ownership.may_publish("j1") is True
        assert c.ownership.pending_claims() == frozenset(), "nothing may wait on an ack that cannot come"
        gate.release.set()


async def test_the_push_half_still_revokes_with_confirmation_off() -> None:
    """What is NOT given up in the compatibility mode. `job:revoked` is core-initiated, so it needs no
    support an older core lacks — the strong half of the guard works either way."""
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


async def test_a_refused_token_is_named_not_reported_as_a_lost_connection(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A 401 loops forever with nothing in the queue to explain it, so it gets its own line."""

    class Refused(Exception):
        response = type("Response", (), {"status_code": 401})()

    async def refuses(_url: str) -> FakeSocket:
        raise Refused("server rejected WebSocket connection: HTTP 401")

    c = Client(config=CFG, connect=refuses, run_job=_never, capabilities=CAPS, backoff=no_backoff)
    await asyncio.wait_for(c.serve_forever(max_attempts=1), 5.0)
    out = capsys.readouterr().out
    assert "ENCORE_WORKER_TOKEN" in out and "connection lost" not in out


async def test_a_transport_error_that_echoes_the_url_never_prints_the_token(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """websockets' InvalidURI repeats the whole dialled URL; the reconnect loop prints it every attempt."""

    class InvalidURI(Exception):
        pass

    async def echoes(url: str) -> FakeSocket:
        raise InvalidURI(f"{url} isn't a valid URI: scheme isn't ws or wss")

    cfg = Config(core_url="ws://core.test/ws?role=worker", worker_token="s3 cr&t=/SECRET")
    c = Client(config=cfg, connect=echoes, run_job=_never, capabilities=CAPS, backoff=no_backoff)
    await asyncio.wait_for(c.serve_forever(max_attempts=2), 5.0)
    out = capsys.readouterr().out
    assert out.count("token=<redacted>") == 2, out
    assert "SECRET" not in out, out


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
        beat = [s for s in sock.sent if s.get("type") == "worker:heartbeat"][-1]  # the first follows hello
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


async def test_keepalive_repeats_the_steps_last_real_figure() -> None:
    """The keepalive used to send pct=0 every 10 s between the real rises, so core saw
    [10, 0, 20, 0, …] and the phone bar ran back to the stage floor each time."""
    sock = FakeSocket()
    c = client(sock)

    async def once(_seconds: float) -> None:
        if sock.types().count("job:progress") >= 2:
            raise asyncio.CancelledError

    async with Session(c, sock):
        await c.progress("j1", Stage.SEPARATING, 40)
        with pytest.raises(asyncio.CancelledError):
            await keepalive(c, "j1", Stage.SEPARATING, sleep=once)

    frames = [s for s in sock.sent if s.get("type") == "job:progress"]
    assert [(s["stage"], s["pct"]) for s in frames] == [("separating", 40), ("separating", 40)]


async def test_progress_interleaved_with_keepalives_never_goes_backwards() -> None:
    """The real sink and the real keepalive, racing, as the reviewer's live probe ran them."""
    from encore_worker.__main__ import _ReporterFor  # noqa: PLC0415 - the composition root, as wired
    from encore_worker.steps.align_steps import progress_sink  # noqa: PLC0415 - steps above transport

    sock = LiveSocket()
    c = client(sock)
    async with Session(c, sock):
        sink = progress_sink(_ReporterFor(c), "j1", Stage.SEPARATING)
        keeper = asyncio.create_task(keepalive(c, "j1", Stage.SEPARATING, every_sec=0.05))
        for pct in range(10, 70, 10):
            await asyncio.to_thread(sink, pct)
            await asyncio.sleep(0.12)
        keeper.cancel()
        await sock.later.put(None)
    seq = [int(str(s["pct"])) for s in sock.sent if s.get("type") == "job:progress"]
    assert len(seq) > 6 and seq == sorted(seq), seq


async def test_a_new_stage_starts_from_its_own_figure() -> None:
    sock = FakeSocket()
    c = client(sock)
    async with Session(c, sock):
        await c.progress("j1", Stage.DOWNLOADING, 100)
        await c.progress("j1", Stage.SEPARATING, 5)
    assert [s["pct"] for s in sock.sent if s.get("type") == "job:progress"] == [100, 5]


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


async def test_the_full_guard_is_on_by_default() -> None:
    """The DEFAULT is now the two-sided guard, because core implements both halves: `#onClaim` answers every
    claim three ways, and the reaper pushes `job:revoked` before a requeue clears the row.

    Pinned as a test because the value is a one-word edit whose consequences are invisible locally: True
    against an old core deadlocks every publish, and False against a new one silently gives up the pull half
    that exists for the disconnect case — the event that both expires a lease AND hides the revocation.
    """
    assert Ownership().require_confirmation is True


async def test_a_default_client_claims_what_it_accepted() -> None:
    """End to end through the default construction, not a hand-set flag: an accepted job must be re-asked
    about before it may publish."""
    sock = FakeSocket([assign()])
    c = Client(
        config=CFG,
        connect=lambda _url: _resolved(sock),
        run_job=Gate(),
        capabilities=CAPS,
        backoff=no_backoff,
    )
    async with Session(c, sock):
        pass
    assert "job:claim" in sock.types()


async def _resolved(sock: FakeSocket) -> FakeSocket:
    return sock


# ── the settled hook: which outcomes may reclaim scratch ───────────────────────────────────────────


def settling(sock: FakeSocket, run_job: object) -> tuple[Client, list[tuple[str, bool]]]:
    seen: list[tuple[str, bool]] = []

    async def connect(_url: str) -> FakeSocket:
        return sock

    c = Client(
        config=CFG,
        connect=connect,
        run_job=run_job,  # type: ignore[arg-type]
        capabilities=CAPS,
        backoff=no_backoff,
        ownership=Ownership(require_confirmation=False),
        on_settled=lambda job_id, resumable: seen.append((job_id, resumable)),
    )
    return c, seen


async def test_a_published_job_may_reclaim_its_scratch() -> None:
    """Nothing will resume a completed job, and its artifacts are already in the store."""

    async def completes(a: f.Assign) -> f.Complete:
        return f.Complete(worker_id="w1", job_id=a.job_id, media_uri="derived/x.flac")

    sock = FakeSocket([assign()])
    c, seen = settling(sock, completes)
    async with Session(c, sock):
        pass
    assert seen == [("j1", False)], "published ⇒ not resumable ⇒ scratch may go"


async def test_a_retryable_failure_must_keep_its_scratch() -> None:
    """THE case that makes "delete at the end of every run" wrong. The core requeues the same job id, DBOS
    resumes from the last checkpoint, and that checkpoint holds an `AudioRef` pointing INTO this scratch — so
    deleting it breaks the one case durability exists for, and it is the 45-minute one."""

    async def flaky(a: f.Assign) -> f.Failed:
        raise _Retryable("disk hiccup")

    sock = FakeSocket([assign()])
    c, seen = settling(sock, flaky)
    async with Session(c, sock):
        pass
    assert seen == [("j1", True)], "retryable ⇒ resumable ⇒ scratch must survive"


async def test_a_non_retryable_failure_may_reclaim_its_scratch() -> None:
    """No retry is coming by definition, so the scratch is dead weight."""

    async def permanent(a: f.Assign) -> f.Failed:
        raise _Permanent("this box has no separator")

    sock = FakeSocket([assign()])
    c, seen = settling(sock, permanent)
    async with Session(c, sock):
        pass
    assert seen == [("j1", False)]


async def test_a_reported_retryable_failure_frame_also_keeps_scratch() -> None:
    """A workflow may RETURN a Failed frame rather than raising — the refused-silent-instrumental path does.
    Reading only the exception would treat that as terminal and delete resumable scratch."""

    async def reports(a: f.Assign) -> f.Failed:
        return f.Failed(worker_id="w1", job_id=a.job_id, error="measure again", retryable=True)

    sock = FakeSocket([assign()])
    c, seen = settling(sock, reports)
    async with Session(c, sock):
        pass
    assert seen == [("j1", True)]


async def test_a_settled_hook_that_raises_cannot_fail_the_job() -> None:
    """It runs in a `finally`. Reclaiming disk is maintenance; a job that reported success must not be
    retracted because a directory was busy."""

    async def completes(a: f.Assign) -> f.Complete:
        return f.Complete(worker_id="w1", job_id=a.job_id, media_uri="derived/x.flac")

    sock = FakeSocket([assign()])

    async def connect(_url: str) -> FakeSocket:
        return sock

    c = Client(
        config=CFG,
        connect=connect,
        run_job=completes,
        capabilities=CAPS,
        backoff=no_backoff,
        ownership=Ownership(require_confirmation=False),
        on_settled=lambda _j, _r: (_ for _ in ()).throw(OSError("busy")),
    )
    async with Session(c, sock):
        pass
    assert "job:complete" in sock.types(), "the completion must still have been reported"


class _Retryable(RuntimeError):
    retryable = True


class _Permanent(RuntimeError):
    retryable = False


# ── worker:catalogue — announced after the handshake, never inside it ─────────────────────────────


def _offer(token: str) -> f.SeparatorOffer:
    return f.SeparatorOffer(token=token, label=token, architecture="MDXC")


async def test_the_catalogue_is_sent_after_hello_and_the_claim() -> None:
    """ORDER IS THE POINT. Registration and re-claiming ownership of in-flight work must not queue behind a
    4.8 s model enumeration — a job held across a reconnect waits on the claim, and `may_publish` refuses
    until the core answers it."""
    socket = FakeSocket()
    c = client(socket)
    c.catalogue = lambda: (frozenset({"stems:model:a-model"}), (_offer("a-model"),))

    async with Session(c, socket):
        await _until(lambda: any(s["type"] == "worker:catalogue" for s in socket.sent))

    kinds = [s["type"] for s in socket.sent]
    assert kinds.index("worker:hello") < kinds.index("worker:catalogue")


async def test_the_catalogue_repeats_the_base_capabilities_alongside_the_models() -> None:
    """A FULL SET, not a delta: the core REPLACES on receipt, so omitting the base tokens would make a worker
    that can align appear unable to."""
    socket = FakeSocket()
    c = client(socket, caps=frozenset({"stems", "align"}))
    c.catalogue = lambda: (frozenset({"stems:model:a-model"}), (_offer("a-model"),))

    async with Session(c, socket):
        await _until(lambda: any(s["type"] == "worker:catalogue" for s in socket.sent))

    frame = next(s for s in socket.sent if s["type"] == "worker:catalogue")
    capabilities = frame["capabilities"]
    assert isinstance(capabilities, list)
    assert set(capabilities) == {"stems", "align", "stems:model:a-model"}


async def test_a_box_with_no_catalogue_sends_no_frame() -> None:
    """`catalogue` is None without the `audiosep` extra. An empty frame would tell the core to replace a
    worker's capabilities with nothing."""
    socket = FakeSocket()
    c = client(socket)
    assert c.catalogue is None

    async with Session(c, socket):
        pass

    assert not any(s["type"] == "worker:catalogue" for s in socket.sent)


async def test_an_empty_enumeration_sends_no_frame() -> None:
    """Same reasoning one step later: a box where the enumeration legitimately finds nothing must not
    announce an empty capability set."""
    socket = FakeSocket()
    c = client(socket)
    c.catalogue = lambda: (frozenset(), ())

    async with Session(c, socket):
        pass

    assert not any(s["type"] == "worker:catalogue" for s in socket.sent)


async def test_a_failing_enumeration_does_not_take_down_the_connection() -> None:
    """A picker's contents must never fail a worker. The box keeps serving with the capabilities it already
    announced in `hello`, which is exactly what it could do before this frame existed."""
    socket = FakeSocket()
    c = client(socket)

    def explode() -> tuple[frozenset[str], tuple[f.SeparatorOffer, ...]]:
        raise RuntimeError("audio_separator is broken here")

    c.catalogue = explode

    async with Session(c, socket):
        pass

    assert any(s["type"] == "worker:hello" for s in socket.sent)
    assert not any(s["type"] == "worker:catalogue" for s in socket.sent)


async def _until(predicate: Callable[[], bool], timeout_sec: float = 5.0) -> None:
    """Wait for a condition the SESSION does not gate on.

    `Session.__aenter__` returns once inbound frames are drained, but the catalogue is an outbound frame
    produced by a background task — so there is nothing inbound to wait for. Polling beats a fixed sleep:
    the enumeration runs in a thread and its completion is not observable from here.
    """
    deadline = asyncio.get_running_loop().time() + timeout_sec
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition never became true")
        await asyncio.sleep(0.01)


# ── the progress keepalive, whose ABSENCE was a real outage ───────────────────────────────────────


async def test_the_keepalive_emits_progress_on_a_timer() -> None:
    """`job:progress` doubles as the core's LEASE refresh (`leases.ts`: progressLeaseMs is 30 s), so a step
    that reports nothing for 30 s is revoked as `progress-lease-expired` however healthy it is.

    MEASURED against a live core: a 195 s song fetched in 2.1 s and separated in 22.3 s, then its align job
    was revoked at 32.9 s and requeued. `keepalive()` was fully written, documented — and had NO CALLER, with
    every `on_progress` passed as None. Under 30 s of work per step the bug is invisible, which is why
    earlier runs on short clips passed.
    """
    socket = FakeSocket()
    c = client(socket)
    ticks: list[float] = []

    async def fake_sleep(sec: float) -> None:
        ticks.append(sec)
        if len(ticks) >= 3:
            raise asyncio.CancelledError

    async with Session(c, socket):
        with contextlib.suppress(asyncio.CancelledError):
            await transport.keepalive(c, "j1", Stage.ALIGNING, sleep=fake_sleep)

    sent = [s for s in socket.sent if s["type"] == "job:progress"]
    assert len(sent) >= 2, "a long quiet step must keep refreshing the lease"
    assert all(s["stage"] == "aligning" for s in sent)


async def test_the_keepalive_interval_leaves_room_for_a_dropped_frame() -> None:
    """Its default must be comfortably inside the core's 30 s lease: at the full value one dropped tick
    breaches it, which is the same reasoning behind core's `heartbeatIntervalSec` being HALF the lease."""
    socket = FakeSocket()
    c = client(socket)
    intervals: list[float] = []

    async def capture(sec: float) -> None:
        intervals.append(sec)
        raise asyncio.CancelledError

    async with Session(c, socket):
        with contextlib.suppress(asyncio.CancelledError):
            await transport.keepalive(c, "j1", Stage.SEPARATING, sleep=capture)

    assert intervals and intervals[0] <= 15.0, (
        f"keepalive every {intervals[0]}s against a 30s lease leaves no room for a dropped frame"
    )


def test_every_action_has_a_keepalive_stage() -> None:
    """The mapping is what decides which word the phone shows during a long step. A missing entry falls back
    to `separating`, which would be wrong — and silently so — for an align or a fetch."""
    from encore_worker.__main__ import _STAGE_FOR

    assert set(_STAGE_FOR) == {"fetch", "stems", "stems-upgrade", "align"}
    assert _STAGE_FOR["align"] is Stage.ALIGNING
    assert _STAGE_FOR["fetch"] is Stage.DOWNLOADING


async def test_a_step_reporter_called_from_dbos_s_loop_runs_on_the_clients() -> None:
    """DBOS runs a workflow IT resumes (recovery at launch; the fork a requeued failure runs)
    on its own background loop, in another thread. The socket, the ownership event and every future the
    client awaits belong to the loop it serves on, so a step's report must be handed across: awaited from
    the other loop, a send failed silently and a stale-standing ownership check raised."""
    import threading
    from typing import cast

    from encore_worker.__main__ import _ReporterFor

    main_loop = asyncio.get_running_loop()
    seen: list[asyncio.AbstractEventLoop] = []

    class OnLoop:
        """The three `Client` calls a reporter forwards, recording the loop each ran on."""

        async def state(self, *_args: object) -> None:
            seen.append(asyncio.get_running_loop())

        async def progress(self, *_args: object) -> None:
            seen.append(asyncio.get_running_loop())

        async def confirm_ownership(self, _job_id: str, *, timeout_sec: float = 10.0) -> bool:
            seen.append(asyncio.get_running_loop())
            return True

    reporter = _ReporterFor(cast(Client, OnLoop()), main_loop)

    async def as_a_resumed_workflow() -> bool:
        await reporter.state("j1", "align-global", 0, "agree", "why", None)
        await reporter.progress("j1", Stage.ALIGNING, 50)
        return await reporter.confirm_ownership("j1")

    result: list[bool] = []
    other = threading.Thread(target=lambda: result.append(asyncio.run(as_a_resumed_workflow())))
    other.start()
    while other.is_alive():  # keep the client's loop turning, as `serve_forever` does
        await asyncio.sleep(0.01)
    other.join()
    assert result == [True]
    assert seen == [main_loop] * 3, "every call ran on the client's loop, not the workflow's"

    await reporter.state("j1", "align-global", 0, "agree", "why", None)  # from the client's own loop
    assert seen[-1] is main_loop and len(seen) == 4


# ── stopping a job the core took back (WK-02) and the keepalive ceiling (WK-03) ──────────────────


class LiveSocket(FakeSocket):
    """A `FakeSocket` the test feeds WHILE the session runs, so a frame can land after a job has started."""

    def __init__(self, inbound: list[dict[str, object]] | None = None) -> None:
        super().__init__(inbound)
        self.later: asyncio.Queue[dict[str, object] | None] = asyncio.Queue()

    async def __aiter__(self) -> AsyncIterator[str]:
        for frame in self.inbound:
            yield json.dumps(frame)
        self.drained.set()
        while (late := await self.later.get()) is not None:
            yield json.dumps(late)
        await self.release.wait()

    async def feed(self, frame: dict[str, object]) -> None:
        """Hand one frame to the client and wait until it has been dispatched."""
        await self.later.put(frame)
        while not self.later.empty():
            await asyncio.sleep(0)
        for _ in range(5):  # the dispatch itself, and the task wake-ups it schedules
            await asyncio.sleep(0)


class Stopper:
    """A `stop_job` that holds until released, as `__main__._stop` holds until the killed child is reaped."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def __call__(self, job_id: str) -> None:
        self.calls.append(job_id)
        self.entered.set()
        await self.release.wait()


async def test_a_cancelled_job_keeps_its_slot_until_its_work_has_stopped() -> None:
    """The sweep's WK-02: the slot was freed the instant the coroutine was cancelled, while the separator
    child kept running, so the box took the next job on top of it."""
    gate, stopper = Gate(), Stopper()
    sock = LiveSocket([assign("j1")])
    c = client(sock, run_job=gate)
    c.stop_job = stopper
    async with Session(c, sock):
        await asyncio.wait_for(gate.entered.wait(), 5.0)
        await sock.feed({"type": "job:cancel", "jobId": "j1"})
        await asyncio.wait_for(stopper.entered.wait(), 5.0)
        await sock.feed(assign("j2"))
        rejected = [s for s in sock.sent if s.get("type") == "job:reject"]
        assert [r["jobId"] for r in rejected] == ["j2"], "still busy: j1's work has not stopped yet"
        stopper.release.set()
        await c.drain(timeout_sec=5.0)
        assert c.running_jobs() == frozenset()
        await sock.feed(assign("j3"))
        gate.release.set()
        await sock.later.put(None)
    assert stopper.calls == ["j1"]
    assert "j3" in [s["jobId"] for s in sock.sent if s.get("type") == "job:accept"], "the slot came back"


async def test_a_job_revoked_in_a_claim_answer_is_stopped() -> None:
    """Revoked while the connection was down: the core gave it to someone else, so the work here is waste."""
    gate, stopper = Gate(), Stopper()
    stopper.release.set()
    sock = LiveSocket([assign("j1")])
    c = client(sock, run_job=gate)
    c.stop_job = stopper
    async with Session(c, sock):
        await asyncio.wait_for(gate.entered.wait(), 5.0)
        await sock.feed({"type": "job:claim-ack", "revoked": ["j1"]})
        await c.drain(timeout_sec=5.0)
        await sock.later.put(None)
    assert stopper.calls == ["j1"]
    assert "job:complete" not in sock.types()


async def test_a_job_still_ours_is_not_stopped_when_its_task_is_cancelled() -> None:
    """A shutdown cancels every task too. Its workflows must stay resumable, so nothing is stopped."""
    gate, stopper = Gate(), Stopper()
    sock = LiveSocket([assign("j1")])
    c = client(sock, run_job=gate)
    c.stop_job = stopper
    async with Session(c, sock):
        await asyncio.wait_for(gate.entered.wait(), 5.0)
        c._running["j1"].cancel()
        await c.drain(timeout_sec=5.0)
        await sock.later.put(None)
    assert stopper.calls == []


async def test_keepalive_goes_quiet_past_its_ceiling() -> None:
    """A timer cannot tell slow from hung, so a job stuck where nothing can kill it refreshed core's lease
    forever. Past the ceiling the keepalive returns, and core's reaper takes the job."""
    sock = FakeSocket()
    c = client(sock)

    async def no_sleep(seconds: float) -> None:
        pass

    async with Session(c, sock):
        await asyncio.wait_for(
            keepalive(c, "j1", Stage.SEPARATING, every_sec=10.0, ceiling_sec=35.0, sleep=no_sleep), 1.0
        )

    assert sock.types().count("job:progress") == 3, "ticks at 10, 20 and 30 s, none past the 35 s ceiling"
