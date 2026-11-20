"""The conversation with the core: dial home, accept work, forward progress, reconcile ownership.

The I/O shell: it owns the socket and the ledger and knows nothing about audio. The socket factory is
injected, so every test here runs against a fake duplex channel with no network. Its three
responsibilities, and why the third needs two guard points: docs/arch/05-worker.md §7 and §7.1.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import random
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Protocol, assert_never

from encore_worker.host.config import Config
from encore_worker.protocol import frames as f
from encore_worker.protocol.vocabulary import Action, Stage, serves
from encore_worker.transport.ownership import Ownership, Reason


class Socket(Protocol):
    """A duplex text channel. `websockets`' client satisfies this; a test hands in a list-backed fake."""

    async def send(self, message: str) -> None: ...
    def __aiter__(self) -> AsyncIterator[str]: ...
    async def close(self) -> None: ...


#: Opens a connection, or raises. Injected so a test never touches a network.
Connect = Callable[[str], Awaitable[Socket]]

#: Runs one assigned job to completion. Injected so the transport never imports a workflow.
RunJob = Callable[[f.Assign], Awaitable[f.Complete | f.Failed]]

#: Backoff between reconnect attempts, in seconds, then repeating the last. Jittered at use.
BACKOFF_SEC = (1.0, 2.0, 5.0, 10.0, 30.0)

#: (attempt) -> seconds to wait. A field rather than a method so a test supplies a zero-delay schedule
#: instead of overwriting a private attribute — and so an operator could flatten it without a subclass.
Backoff = Callable[[int], float]

#: Enumerates the selectable models this box can run: `(extra capability tokens, offers to show a picker)`.
#: SYNCHRONOUS and slow by design — the client runs it in a worker thread.
Catalogue = Callable[[], tuple[frozenset[str], tuple[f.SeparatorOffer, ...]]]

#: (seconds) -> None. Injected for the same reason: a keepalive test drives it directly rather than
#: sleeping and hoping, which is what makes the test deterministic instead of a race.
Sleep = Callable[[float], Awaitable[None]]


@dataclass
class Client:
    """One worker's connection to one core."""

    config: Config
    connect: Connect
    run_job: RunJob
    capabilities: frozenset[str]
    backend: str | None = None
    #: `Hello.host`, what `hardware.probe()` measured. Diagnostic only, so None simply omits it.
    host: dict[str, object] | None = None

    #: Builds the selectable-model catalogue, or None on a box that offers none. Called OFF the event loop
    #: (docs/arch/05-worker.md §7.1) and injected, so a test can supply one without the extra installed.
    catalogue: Catalogue | None = None

    ownership: Ownership = field(default_factory=Ownership)
    #: How long to wait between reconnect attempts. Default is the jittered schedule above.
    backoff: Backoff | None = None
    #: The live published-stem container, overwritten by what core announces in `worker:welcome` — core
    #: owns the storage layout. Mutable because a reconnect may reach a differently-configured core.
    publish_stem_format: str = ""
    #: `(job_id, resumable)` — called once per job when its run ends. Injected because scratch layout is
    #: `artifacts`' business while only this layer knows the outcome (docs/arch/05-worker.md §4).
    on_settled: Callable[[str, bool], None] | None = None
    #: The heartbeat timer's sleep. Injected for the same reason as `keepalive`'s: a test drives the beat.
    sleep: Sleep | None = None
    _socket: Socket | None = field(default=None, init=False)
    _running: dict[str, asyncio.Task[None]] = field(default_factory=dict, init=False)
    #: Set once a claim round has been answered, so a publish can wait rather than guess. Replaced on
    #: every disconnect, the previous round's answer being stale.
    _confirmed: asyncio.Event = field(default_factory=asyncio.Event, init=False)
    #: The periodic heartbeat, started by `worker:welcome` and ended with the session.
    _beat: asyncio.Task[None] | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        # Seeded from config so a core that announces nothing — an older one — still publishes at a valid
        # extension rather than at an empty one.
        if not self.publish_stem_format:
            self.publish_stem_format = self.config.publish_stem_format

    # ── the connection loop ──────────────────────────────────────────────────────────────────────

    async def serve_forever(self, *, max_attempts: int | None = None) -> None:
        """Dial, serve, reconnect. `max_attempts` bounds the loop for tests; None runs until cancelled."""
        attempt = 0
        while max_attempts is None or attempt < max_attempts:
            attempt += 1
            try:
                await self._session()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - any transport fault is a reconnect, not a crash
                self._note(f"connection lost ({type(exc).__name__}: {exc})")
            self.ownership.disconnected()
            self._confirmed.clear()
            if max_attempts is not None and attempt >= max_attempts:
                return
            await asyncio.sleep(self._backoff(attempt))

    def _backoff(self, attempt: int) -> float:
        """How long before the next dial. Delegates to the injected schedule when there is one."""
        if self.backoff is not None:
            return self.backoff(attempt)
        return jittered_backoff(attempt)

    async def _session(self) -> None:
        """One connection: handshake, then read frames until the socket ends."""
        socket = await self.connect(self.config.core_url)
        self._socket = socket
        # Bound BEFORE the try, because `finally` cancels it: an exception from the hello send would
        # otherwise leave the name unset and turn a connection error into a NameError that hides it.
        catalogue_task: asyncio.Task[None] | None = None
        try:
            await self._send(self._hello())
            # Re-claim BEFORE serving anything. A job held across the drop may have been reassigned,
            # and until the core answers, `may_publish` refuses — so a workflow that finishes in this
            # window waits rather than racing another worker to the same artifact.
            await self._claim_pending()
            # Core resets this worker's free slots to `concurrency` on every hello, so a reconnect mid-job
            # would be offered work it must refuse. One heartbeat says what is really running.
            await self.heartbeat()
            # AFTER the claim, and not awaited: the catalogue is a UI nicety, so it must not sit in front of
            # either registration or re-claiming ownership of in-flight work.
            catalogue_task = asyncio.create_task(self._announce_catalogue())
            async for raw in socket:
                await self._on_frame(raw)
        finally:
            # Cancelled rather than awaited: on a socket that just dropped there is nothing to send it to,
            # and a pending 4.8 s enumeration would hold the reconnect open for no benefit.
            if catalogue_task is not None:
                catalogue_task.cancel()
            if self._beat is not None:
                self._beat.cancel()
                self._beat = None
            self._socket = None
            with contextlib.suppress(Exception):
                await socket.close()

    async def _announce_catalogue(self) -> None:
        """Enumerate the selectable models and tell the core, or do nothing at all.

        Run IN A THREAD, and its failure is silent by design: docs/arch/05-worker.md §7.1.
        """
        if self.catalogue is None:
            return
        try:
            extra, offers = await asyncio.to_thread(self.catalogue)
        except Exception as exc:  # noqa: BLE001 - see the docstring: a picker must not fail a connection
            print(f"[worker] model catalogue unavailable ({type(exc).__name__}: {exc})", flush=True)
            return
        if not extra and not offers:
            return
        # The FULL set, base tokens included, never a delta — see `frames.Catalogue`.
        await self._send(
            f.Catalogue(
                worker_id=self.config.worker_id,
                capabilities=tuple(sorted(self.capabilities | extra)),
                separators=offers,
            )
        )
        print(f"[worker] offered {len(offers)} selectable separation models", flush=True)

    def _hello(self) -> f.Hello:
        return f.Hello(
            worker_id=self.config.worker_id,
            capabilities=tuple(sorted(self.capabilities)),
            concurrency=self.config.concurrency,
            version=self.config.version,
            backend=self.backend,
            device=self.config.device,
            host=self.host,
        )

    # ── inbound ──────────────────────────────────────────────────────────────────────────────────

    async def _on_frame(self, raw: str) -> None:
        """Dispatch one inbound frame. A malformed frame is logged and skipped, never fatal.

        Skipping is right here even though `parse` refuses to guess: one bad frame on a long-lived
        socket must not drop the connection and abandon every running job with it.
        """
        try:
            frame = f.parse(json.loads(raw))
        except (ValueError, TypeError) as bad:
            self._note(f"ignoring unparseable frame: {bad}")
            return

        match frame:
            case f.Assign():
                await self._on_assign(frame)
            case f.Cancel():
                self.ownership.revoked(frame.job_id, Reason.CANCELLED)
                self._cancel_running(frame.job_id)
            case f.Revoked():
                self.ownership.revoked(frame.job_id, Reason.REVOKED)
                self._cancel_running(frame.job_id)
                self._note(f"job {frame.job_id} revoked by the core: {frame.reason or 'no reason given'}")
            case f.ClaimAck():
                self.ownership.claim_answered(
                    owned=frozenset(frame.owned),
                    revoked=frozenset(frame.revoked),
                    unknown=frozenset(frame.unknown),
                )
                self._confirmed.set()
                for job_id in frame.unknown:
                    self._note(f"DESYNC: the core has no row for job {job_id}, which we are running")
            case f.Welcome() as welcome:
                # The one thing the handshake CARRIES that changes behaviour: core names the published stem
                # format, because core owns the storage layout. Recorded on the client rather than mutating
                # the frozen Config, so a reconnect to a differently-configured core takes effect and the
                # configured value stays visible as what it is — a fallback.
                if welcome.publish_stem_format:
                    if welcome.publish_stem_format != self.publish_stem_format:
                        self._note(
                            f"core publishes stems as {welcome.publish_stem_format!r} "
                            f"(was {self.publish_stem_format!r})"
                        )
                    self.publish_stem_format = welcome.publish_stem_format
                if welcome.heartbeat_interval_sec is not None:
                    if self._beat is not None:
                        self._beat.cancel()
                    self._beat = asyncio.create_task(self._heartbeat_every(welcome.heartbeat_interval_sec))
            case f.Ping():
                pass  # liveness needs no local state
            case _ as unreachable:
                assert_never(unreachable)

    async def _on_assign(self, assign: f.Assign) -> None:
        """Accept or refuse, then run it. The refusal reasons are the two a worker can know locally."""
        ok, why = self._can_accept(assign)
        if not ok:
            await self._send(f.Reject(self.config.worker_id, assign.job_id, why))
            # Core holds a rejecting worker at zero free slots until it hears the real count, so say it now.
            await self.heartbeat()
            return
        self.ownership.accepted(assign.job_id)
        await self._send(f.Accept(self.config.worker_id, assign.job_id))
        # A claim round confirms it: the core just assigned it, but `accepted` marks it unconfirmed, and
        # publishing on an unconfirmed job is what the guard exists to prevent.
        await self._claim_pending()
        self._running[assign.job_id] = asyncio.create_task(self._drive(assign))

    def _can_accept(self, assign: f.Assign) -> tuple[bool, str]:
        try:
            action = Action(assign.action)
        except ValueError:
            return False, f"unknown action: {assign.action}"
        if not serves(self.capabilities, action):
            return False, f"this worker does not serve {action.value}"
        if len(self._running) >= self.config.concurrency:
            return False, "no free slots"
        return True, ""

    async def _drive(self, assign: f.Assign) -> None:
        """Run one job and report the terminal frame. Never raises into the read loop."""
        # Assume the worst until the outcome is known: if this task is cancelled between here and the
        # assignment below, the scratch is PRESERVED rather than deleted under a job that may resume.
        resumable = True
        try:
            terminal = await self.run_job(assign)
            await self._send(terminal)
            # A terminal frame either way. `Failed` with retryable=True is the one outcome whose scratch must
            # survive: the core requeues the same job id, and DBOS resumes from a checkpoint holding paths
            # into it.
            resumable = isinstance(terminal, f.Failed) and terminal.retryable
        except asyncio.CancelledError:
            self._note(f"job {assign.job_id} cancelled")
            raise
        except Exception as exc:  # noqa: BLE001 - a job fault is reported, not crashed on
            retryable = bool(getattr(exc, "retryable", True))
            resumable = retryable
            await self._send(f.Failed(self.config.worker_id, assign.job_id, str(exc), retryable))
        finally:
            self.ownership.finished(assign.job_id)
            self._running.pop(assign.job_id, None)
            if self.on_settled is not None:
                # Diagnostics must never turn a finished job into a failed one.
                with contextlib.suppress(Exception):
                    self.on_settled(assign.job_id, resumable)

    async def drain(self, *, timeout_sec: float = 60.0) -> None:
        """Wait for every in-flight job to finish.

        Real behaviour, not a test affordance: a worker shutting down should let its jobs complete and
        report rather than dropping them, since a dropped job costs the core a lease expiry and the
        singer a wait. It is also what a test awaits instead of sleeping and hoping.
        """
        running = [task for task in self._running.values() if not task.done()]
        if running:
            await asyncio.wait(running, timeout=timeout_sec)

    def running_jobs(self) -> frozenset[str]:
        """Job ids with a live task. Distinct from `ownership.running()`, which is what the CORE thinks:
        a job can be ours and not yet started, or finished and not yet forgotten."""
        return frozenset(job_id for job_id, task in self._running.items() if not task.done())

    def _cancel_running(self, job_id: str) -> None:
        task = self._running.get(job_id)
        if task is not None and not task.done():
            task.cancel()

    # ── outbound ─────────────────────────────────────────────────────────────────────────────────

    async def _send(self, frame: f.ToCore) -> None:
        """Serialize and send. A send failure is swallowed: the read loop will notice the drop.

        Raising here would propagate out of `_drive` and be reported as a JOB failure, which is wrong —
        the job is fine, the socket is not, and the core will requeue it on lease expiry anyway.
        """
        socket = self._socket
        if socket is None:
            return
        with contextlib.suppress(Exception):
            await socket.send(json.dumps(frame.to_wire()))

    async def progress(self, job_id: str, stage: Stage, pct: int) -> None:
        await self._send(f.Progress(self.config.worker_id, job_id, stage, pct))

    async def state(
        self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        await self._send(
            f.State(
                worker_id=self.config.worker_id,
                job_id=job_id,
                state=state,
                attempt=attempt,
                knob=knob,
                verdict=verdict,
                why=why,
            )
        )

    async def heartbeat(self) -> None:
        await self._send(
            f.Heartbeat(
                worker_id=self.config.worker_id,
                slots_free=max(0, self.config.concurrency - len(self._running)),
                running_job_ids=tuple(sorted(self.ownership.running())),
            )
        )

    async def _heartbeat_every(self, every_sec: float) -> None:
        wait = self.sleep if self.sleep is not None else asyncio.sleep
        while True:
            await wait(every_sec)
            await self.heartbeat()

    async def _claim_pending(self) -> None:
        pending = self.ownership.pending_claims()
        if not pending:
            self._confirmed.set()
            return
        self._confirmed.clear()
        await self._send(f.Claim(self.config.worker_id, tuple(sorted(pending))))

    # ── what the publish step asks ───────────────────────────────────────────────────────────────

    async def confirm_ownership(self, job_id: str, *, timeout_sec: float = 10.0) -> bool:
        """May this job publish? Re-claims and WAITS for the answer if the standing is stale, and a
        TIMEOUT is a refusal (docs/arch/05-worker.md §7.1)."""
        if self.ownership.may_publish(job_id):
            return True
        if self.ownership.lost_reason(job_id) is not None:
            return False
        await self._claim_pending()
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(timeout_sec):
                await self._confirmed.wait()
        return self.ownership.may_publish(job_id)

    def _note(self, line: str) -> None:
        print(f"[transport] {line}", flush=True)


def jittered_backoff(attempt: int) -> float:
    """The default reconnect schedule.

    Jitter matters with several workers: they all lost the same core at the same instant, and an
    unjittered schedule makes them reconnect in lockstep forever, hammering the core each time it returns.
    """
    base = BACKOFF_SEC[min(attempt, len(BACKOFF_SEC)) - 1]
    return base * (0.5 + random.random())  # noqa: S311 - jitter, not cryptography


async def keepalive(
    client: Client,
    job_id: str,
    stage: Stage,
    *,
    pct: int = 0,
    every_sec: float = 10.0,
    sleep: Sleep | None = None,
) -> None:
    """Emit progress on a timer until cancelled. Wrap a long step in this.

    A TIME-based keepalive, not an output-parsing one, and that distinction is load-bearing. The old
    worker parsed a child's stdout for a percentage and went silent whenever the child did — roformer's
    parser returns None unconditionally, so a 45-minute separation emitted nothing between its opening 0
    and closing 100, long past the core's 30s lease. A timer cannot go quiet.
    """
    wait = sleep if sleep is not None else asyncio.sleep
    while True:
        await wait(every_sec)
        await client.progress(job_id, stage, pct)
