"""Encore worker — dial-home WS client: the full protocol loop.

The worker connects TO the core (never the reverse), so it scales to N and runs on any box / GPU
across NAT. It announces capacity (`worker:hello`), receives `job:assign`, accepts (or rejects on
no-capacity / unsupported type), streams `job:progress` per stage, and finishes with `job:complete`
(or `job:failed`). Crash recovery is the core's job (leases + reaper) — a dropped WS just means the
worker reconnects and re-announces.

The stem separation is behind the Processor seam (processor.py). See docs/ARCHITECTURE.md, §9.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import time
from typing import Any

from . import protocol
from .bootstrap import (
    _build_processor as _build_processor,  # noqa: F401 — re-export: tests and _run_forever build through here
)
from .bootstrap import (
    oversubscription_warnings,
)
from .host.config import WorkerConfig
from .host.mediastore import MediaStoreConfig, parse_media_store
from .processor import CompleteResult, JobSpec, Processor, ProgressEvent
from .retry_policy import is_retryable
from .runtime import scratch_for
from .scratch_reaper import (
    _SCRATCH_SWEEPS,
    _on_scratch_sweep_done,
    _scratch_sweep_loop,
)
from .scratch_reaper import (
    sweep_orphaned_scratch as sweep_orphaned_scratch,  # noqa: F401 — re-export: exercised by test_dial_home
)

# All environment reading lives in config.py, so there is ONE place to look for "what is this worker
# actually configured to do" — and so the perf knobs are testable without mutating os.environ.
# Host-derived values (capabilities, worker id, alignment device) are filled in by config.resolve()
# at startup, which is why this is the raw config and not the effective one.
CONFIG = WorkerConfig.from_env()

# No module-level snapshots of CONFIG fields here. The five that used to live at import
# (WORKER_ID / CONCURRENCY / CAPABILITIES / MEDIA_DIR / VERSION) were read on the client's
# __init__ defaults, which contradicted the "config read ON CALL" rule the rest of this
# module follows — CAPABILITIES in particular was frozen to [] at import (default caps are
# () until config.resolve() fills them on a NEW object). __init__ now reads CONFIG directly.
RECONNECT_BACKOFF_SEC = 3.0

# Drains detached from a dropped connection so the reconnect loop does not BLOCK on them.
# A drop while a run_blocking step is mid-pass (native torch, uninterruptible — runner.py awaits
# the thread) made the old inline `await client.drain(cancel=True)` hold the loop for up to a
# full align before redialling, so the worker was both absent AND still doing the duplicate work
# the drain is meant to stop. Detaching lets redial proceed immediately while the cancelled tasks
# settle in the background; the set pins the tasks so they are not GC'd mid-flight, and each
# self-removes on completion. The cancel itself is synchronous, so the GeneratorExit that kills a
# subprocess step still propagates the instant the socket drops.
_DETACHED_DRAINS: set[asyncio.Task] = set()

#: Pins the scratch-reaper task. `ensure_future` returns a task the event loop only weakly references, so
#: without a strong reference here the reaper could be garbage-collected mid-flight and the process would


def _on_detached_drain_done(task: asyncio.Task) -> None:
    """Discard the finished detached drain AND retrieve its exception, so a drain that raised is logged
    rather than surfacing only as asyncio's "Task exception was never retrieved" at GC (advisory;
    the earlier changes silent-failure family). CancelledError is expected and stays quiet."""
    _DETACHED_DRAINS.discard(task)
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        print(f"[worker] detached drain raised ({exc!r})", flush=True)


# Fallback heartbeat cadence if worker:welcome never carried one (older core, or a welcome that
# predates heartbeatIntervalSec). The real value is the core's progressLeaseMs/1000 handed over at
# handshake; this is only the floor so the leg is never fully silent. Kept below the 30s lease so a
# reconciling frame always lands before a lease can expire.
DEFAULT_HEARTBEAT_INTERVAL_SEC = 10.0


class WorkerClient:
    """Drives one worker session against a connected socket. Decoupled from the `websockets`
    library: it takes an async `send(dict)` and is fed inbound messages via `handle(msg)`, so the
    full flow unit-tests with an in-memory fake socket."""

    def __init__(
        self,
        send,
        processor: Processor,
        *,
        worker_id: str | None = None,
        capabilities: list[str] | None = None,
        concurrency: int | None = None,
        media_dir: str | None = None,
        version: str | None = None,
        can_publish_object: bool = False,
    ) -> None:
        # Read config ON CALL, not captured at import: default each kwarg to None and
        # resolve it against CONFIG here, so a test (or a future caller) that constructs a
        # client without an argument still gets the worker's configured value — and there is
        # no module-level snapshot to drift from CONFIG. Production passes all five explicitly.
        worker_id = worker_id if worker_id is not None else CONFIG.worker_id
        concurrency = concurrency if concurrency is not None else CONFIG.concurrency
        media_dir = media_dir if media_dir is not None else CONFIG.media_dir
        version = version if version is not None else CONFIG.version
        self._send = send
        self._processor = processor
        self._media_dir = media_dir
        self._version = version
        # MediaStore config arrives in worker:welcome; local until then.
        self.media_store = MediaStoreConfig(kind="local")
        # Whether this worker can actually PUT artifacts into an object store. The S3 upload path
        # (mediastore.make_publisher's object branch) exists as a seam but is not wired by
        # _build_processor, so the shipping worker cannot honour object mode: every step writes a
        # local path and reports it. This flag is the honest record of that gap. When the core hands
        # this worker object-mode config but this is False, _on_assign REFUSES the jobs it cannot
        # honour rather than completing them with local paths the core will try to serve from S3 —
        # turning a silent data-integrity trap into a job-scoped reject the operator can see.
        self._can_publish_object = can_publish_object
        self.state = protocol.WorkerState(
            worker_id=worker_id,
            capabilities=list(capabilities if capabilities is not None else CONFIG.capabilities),
            concurrency=concurrency,
        )
        # jobId -> its in-flight processing task, so a cancel can reach the RIGHT task (and through
        # it, with the subprocess_runner kill-on-GeneratorExit, the child process). A bare set could
        # only be drained, not cancelled by job.
        self._tasks: dict[str, asyncio.Task] = {}
        # Heartbeat cadence, handed over in worker:welcome (= core progressLeaseMs / 1000). Until the
        # handshake arrives we use the conservative default so the periodic sender in _run_forever has
        # a valid interval from the first tick. This is what makes worker:heartbeat actually leave the
        # worker in production: registry.heartbeat is the ONLY path that reconciles slotsFree from the
        # worker's own truth, and a reaped (lease-expired) job otherwise strands its slot forever.
        self.heartbeat_interval_sec: float = DEFAULT_HEARTBEAT_INTERVAL_SEC

    async def hello(self) -> None:
        await self._send(
            protocol.hello(
                self.state.worker_id,
                self.state.capabilities,
                self.state.concurrency,
                self._version,
                protocol.host_facts(),
            )
        )

    async def send_heartbeat(self) -> None:
        await self._send(
            protocol.heartbeat(self.state.worker_id, self.state.slots_free, list(self.state.running))
        )

    async def heartbeat_loop(self) -> None:
        """Periodically push a worker:heartbeat so the core can reconcile this worker's slotsFree.

        The core sends no `ping` (the PING arm above is a passive responder to a command production
        never emits), and it has no core-side liveness poll, so WITHOUT this loop worker:heartbeat is
        never sent and registry.heartbeat never runs. That path is the only one that gives a slot back
        after the reaper requeues a lease-expired job, so its absence lets one reaped job strand the
        worker's capacity permanently. Runs until cancelled (on disconnect, from
        _run_forever). The interval is refreshed live from self.heartbeat_interval_sec each tick, so a
        worker:welcome that lands after the loop starts still takes effect.
        """
        while True:
            await asyncio.sleep(max(0.1, self.heartbeat_interval_sec))
            try:
                await self.send_heartbeat()
            except asyncio.CancelledError:
                # The finally in _run_forever cancels this task on disconnect; let it stop the loop.
                raise
            except Exception as exc:  # noqa: BLE001
                # A send on a half-closed socket raises here. WITHOUT this guard the exception
                # ends the task body and — because _run_forever cancels but never retrieves it —
                # surfaces only as asyncio's "Task exception was never retrieved" at GC, on an
                # already-noisy reconnect. The pump side (`async for raw in ws`) sees the same
                # dead socket and drives the real reconnect + cancel; this leg just keeps ticking
                # (the interval floor bounds the retry) until that teardown cancels it.
                print(f"[worker] heartbeat send failed ({exc!r}); will retry next tick", flush=True)

    async def handle(self, msg: dict[str, Any]) -> None:
        """Dispatch one inbound core->worker command."""
        t = msg.get("type")
        if t == protocol.WELCOME:
            # config handshake: record where to read source / write stems (local volume vs S3/MinIO)
            self.media_store = parse_media_store(msg)
            # Adopt the core's heartbeat cadence (= progressLeaseMs / 1000). Storing it is what makes
            # the periodic heartbeat_loop tick at the interval the core actually leases at, rather than
            # the default floor. A malformed / missing value is ignored so a bad frame cannot silence
            # the leg. Sends nothing here — welcome requires no reply.
            interval = msg.get("heartbeatIntervalSec")
            if isinstance(interval, (int, float)) and interval > 0:
                self.heartbeat_interval_sec = float(interval)
            # Surface the object-mode gap at handshake time, not only when the first job is rejected:
            # an operator who set MEDIA_STORE=object on the core should learn immediately that this
            # worker cannot honour it (see _on_assign — every such job is refused, not silently
            # completed with a local path).
            if self.media_store.is_object and not self._can_publish_object:
                print(
                    f"[worker] WARNING: core announced object MediaStore (bucket="
                    f"{self.media_store.bucket!r}) but no S3 uploader is wired; this worker will "
                    "REJECT every job until it runs with MEDIA_STORE=local against a shared MEDIA_DIR "
                    "or a build with the object uploader wired",
                    flush=True,
                )
            return
        if t == protocol.PING:
            return await self.send_heartbeat()
        if t == protocol.ASSIGN:
            return await self._on_assign(msg)
        if t == protocol.CANCEL:
            return self._on_cancel(msg)
        # An unknown type used to fall through silently, so protocol drift (a core speaking a message
        # this worker predates) was invisible from the worker side. Log it — one line, no reply.
        print(f"[worker] ignoring unhandled message type {t!r}", flush=True)

    async def _on_assign(self, msg: dict[str, Any]) -> None:
        # Validate the required fields BEFORE touching state. A missing key used to raise KeyError,
        # which escaped the `async for` loop into the broad reconnect handler and tore down the socket
        # — killing EVERY in-flight job on it for one malformed frame. Fail just this one job instead.
        job_id = msg.get("jobId")
        job_type = msg.get("jobType")
        media_id = msg.get("mediaId")
        if not isinstance(job_id, str) or not job_id:
            # No usable job id: we cannot send a job-scoped reject, so log and drop this frame only.
            print(f"[worker] ignoring malformed job:assign (missing/invalid jobId): {msg!r}", flush=True)
            return
        if not isinstance(job_type, str) or not job_type or not isinstance(media_id, str) or not media_id:
            print(f"[worker] rejecting malformed job:assign {job_id!r} (missing jobType/mediaId)", flush=True)
            await self._send(
                protocol.reject(self.state.worker_id, job_id, "malformed assign: missing jobType/mediaId")
            )
            return
        # HONESTY over object mode. If the core told us stems live in an object store (worker:welcome
        # carried a usable bucket) but this worker has no uploader wired, every step would still write
        # a LOCAL path and report it — the core would then mark the song ready and try to serve it from
        # S3, where nothing was ever put. Refuse loudly instead of silently completing: a job-scoped
        # reject is visible to the operator, and it names the gap and the fix. This does NOT fall back
        # to local the way the core does for a MISSING bucket (README: "A missing bucket falls back to
        # local") — that fallback is safe because the core then serves from local too; here the core
        # has already committed to serving from S3, so falling back would be the trap, not the fix.
        if self.media_store.is_object and not self._can_publish_object:
            reason = (
                "object MediaStore requested but this worker has no S3 uploader wired "
                f"(bucket={self.media_store.bucket!r}); it can only write local paths. "
                "Run this worker against a shared MEDIA_DIR with MEDIA_STORE=local, or deploy a "
                "build with the object uploader wired"
            )
            print(f"[worker] rejecting {job_type} job {job_id!r}: {reason}", flush=True)
            await self._send(protocol.reject(self.state.worker_id, job_id, reason))
            return
        # `params` is the last required field with no parse layer, unlike jobId/jobType/mediaId above.
        # A non-dict here (a core bug, a malformed frame) reaches JobSpec.params: dict untyped and then
        # `**params`-style access downstream would raise mid-process, escaping into the reconnect handler.
        # Reject it job-scoped at the boundary — the same shape as the checks above — so the one check
        # here makes the two defensive `isinstance(job.params, dict)` re-guards downstream (runner.py,
        # ctx.py) dead. Absent `params` is fine: `.get` defaults to {} below.
        params = msg.get("params", {})
        if not isinstance(params, dict):
            print(f"[worker] rejecting malformed job:assign {job_id!r} (params not an object)", flush=True)
            await self._send(
                protocol.reject(self.state.worker_id, job_id, "malformed assign: params must be an object")
            )
            return
        ok, reason = self.state.can_accept(job_type)
        if not ok:
            await self._send(protocol.reject(self.state.worker_id, job_id, reason))
            return
        await self._send(protocol.accept(self.state.worker_id, job_id))
        self.state.start(job_id)
        job = JobSpec(
            job_id=job_id,
            media_id=media_id,
            job_type=job_type,
            source_uri=msg.get("sourceUri", ""),
            params=params,
            media_dir=self._media_dir,
            # Trace id for this process. Absent on a frame from a core that predates it -> "".
            processing_id=msg.get("processingId", ""),
        )
        # run processing concurrently so the loop keeps reading ping/cancel
        task = asyncio.ensure_future(self._run_job(job))
        self._tasks[job_id] = task

        def _pop_task(_t: Any, jid: Any = job_id) -> None:
            self._tasks.pop(jid, None)

        task.add_done_callback(_pop_task)

    async def _run_job(self, job: JobSpec) -> None:
        # Retry reuse: a core retry requeues the SAME jobId (JobRepository.requeue transitions
        # the job row in place — it does not mint a new id), so scratch_for(job) resolves to the SAME
        # work/<jobId> dir on the next attempt. Preserving it across a RETRYABLE failure lets the
        # steps' own "my output is already on disk" guards (AcquireAudio.find_downloaded,
        # Separate/ProbeSilence reading the raw stems, etc.) skip the work attempt 1 already finished,
        # instead of re-downloading, re-decoding and re-separating from step 1 — three 45-minute
        # roformer passes for one job in the worst case. Resumption stays a STEP property (issue's
        # scope note): the runner is untouched; only the cleanup decision moves off "always".
        preserve_scratch = False
        try:
            result: CompleteResult | None = None
            # Time each stage from the progress stream the processor already emits. Nothing inside the
            # processors changes, so this cannot drift when one of them is edited.
            timer = protocol.StageTimer(time.monotonic)
            async for ev in self._processor.process(job):
                if isinstance(ev, ProgressEvent):
                    timer.observe(ev.stage)
                    await self._send(
                        protocol.progress(self.state.worker_id, job.job_id, ev.stage, ev.pct, ev.eta_sec)
                    )
                else:  # CompleteResult
                    result = ev
            if result is None:
                raise RuntimeError("processor produced no result")
            await self._send(
                protocol.complete(
                    self.state.worker_id,
                    job.job_id,
                    result.media_uri,
                    result.artifacts,
                    facts=result.facts,
                    stages=timer.finish(),
                    selection=result.selection,
                )
            )
        except Exception as exc:  # noqa: BLE001 — report ANY failure to the core, which decides retry
            retryable = _is_retryable(exc)
            # A retryable failure MAY be re-dispatched by the core under the SAME jobId, so keep the
            # partial scratch for that attempt to reuse. A permanent (non-retryable) failure is
            # terminal — nothing will re-run — so it falls through to the cleanup like a success does.
            #
            # The one gap this cannot close from here: the LAST retryable attempt (retries exhausted)
            # is ALSO terminal, but the worker cannot tell it apart — JobSpec and the wire carry no
            # attempt/maxAttempts, that is core-side state. So an exhausted-retry job's
            # scratch is preserved here and would leak; sweep_orphaned_scratch() at worker startup is
            # what reclaims it (see _run_forever). preserve_scratch is thus "keep for a POSSIBLE retry",
            # and the startup sweep is the backstop for the attempts that turned out to be the last.
            preserve_scratch = retryable
            # LOG it too: reporting only over the wire made a retry loop invisible from both ends — a
            # job failing at 99% every attempt looked identical to one still processing.
            print(
                f"[worker] job {job.job_id} ({job.job_type}) FAILED retryable={retryable}: {exc!r}",
                flush=True,
            )
            await self._send(protocol.failed(self.state.worker_id, job.job_id, str(exc), retryable=retryable))
        finally:
            self.state.finish(job.job_id)
            # The worker OWNS its scratch, so the worker cleans it: work/<jobId> holds the decoded
            # source + both WAV stems (hundreds of MB per job), and leaving them is how 432 MB
            # accumulated. This cannot be done from the core — in a two-container deployment the core
            # runs as a DIFFERENT uid and a core-side rmtree gets EACCES on dirs the worker created at
            # its own umask. ignore_errors: tidying must never turn a completed job into a failed one.
            # Delete EXACTLY what the runner created — call scratch_for, don't rebuild its layout by
            # hand: a hand-rebuilt copy silently drifts from the producer and leaks every job's scratch.
            #
            # ...but NOT between attempts of the same job: on a retryable failure the scratch is
            # this attempt's completed work, and the next attempt reuses it in place. Cleaned on every
            # outcome the worker can SEE as terminal: success, permanent (non-retryable) failure, and a
            # cancel (CancelledError derives from BaseException, so `except Exception` above does not
            # catch it — preserve_scratch stays False and this rmtree runs, which is the intended
            # terminal-cleanup, made explicit here rather than left to that inheritance detail).
            #
            # The one terminal outcome it CANNOT see is a retryable failure that was the LAST attempt:
            # no retry follows, but the worker has no attempt count to know that, so that scratch is
            # kept here and reclaimed instead by sweep_orphaned_scratch() at the next worker startup.
            if not preserve_scratch:
                shutil.rmtree(scratch_for(job), ignore_errors=True)

    def _on_cancel(self, msg: dict[str, Any]) -> None:
        # Cancel the in-flight task for this job. With subprocess_runner's kill-on-GeneratorExit, the
        # cancellation propagates a GeneratorExit into the processor's async generator and kills the
        # child (demucs / roformer / yt-dlp) rather than orphaning it. The task's done-callback removes
        # it from self._tasks, and _run_job's finally frees the slot — so cancel leaves no dangling
        # task entry and reports no spurious failure to the core (CancelledError is not caught by the
        # `except Exception` that sends job:failed). If no task is tracked (already finished, or the
        # slot was held without one), just free the slot as before.
        job_id = msg.get("jobId", "")
        task = self._tasks.get(job_id)
        if task is not None and not task.done():
            task.cancel()
            return  # the task's finally frees the slot; do not double-finish
        self.state.finish(job_id)

    def cancel_now(self) -> None:
        """Synchronously cancel all in-flight job tasks WITHOUT awaiting them.

        The cancel propagates GeneratorExit into each processor immediately (subprocess_runner kills
        the child), so a dropped socket stops the duplicate work at once — but a run_blocking step
        awaits its uninterruptible thread, so the tasks are not DONE when this returns. Pair it with a
        detached `drain()` (see _run_forever's finally) to settle them off the reconnect path.
        """
        for task in list(self._tasks.values()):
            task.cancel()

    async def drain(self, *, cancel: bool = False) -> None:
        """Settle this client's in-flight job tasks so none outlive the client.

        `cancel=False` (default) just AWAITS the tasks — graceful shutdown, and the settle a test
        needs after `handle(assign())` so the concurrent job task actually runs.

        `cancel=True` first CANCELS them, which is what the reconnect path needs on a socket drop.
        A dropped socket abandons this client and its `_tasks`; without a cancel the orphaned process
        runs to completion against a closed socket, its `job:complete` is lost, and the core's reaper
        has meanwhile requeued the same job onto a fresh connection — duplicate GPU work for one song.
        Cancelling propagates GeneratorExit into the processor (subprocess_runner kills the child), so
        the abandoned process stops instead of racing its own retry. `return_exceptions=True` so the
        CancelledError each task raises is collected here rather than escaping the reconnect handler."""
        if not self._tasks:
            return
        tasks = list(self._tasks.values())
        if cancel:
            for task in tasks:
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def _is_retryable(exc: Exception) -> bool:
    # The retry decision lives in ONE place now: retry_policy.is_retryable. It prefers a
    # structured `.retryable` flag (ProcessError/ProcessTimeout, and the boundary errors that carry
    # retryable=False) and otherwise falls back to the canonical permanent-marker table — so this
    # module no longer keeps its own divergent four-substring copy that defaulted the four boundary
    # failures (unknown fetcher/ASR model/engine, no plan) to retryable and cost the room 3 attempts.
    #
    # SECOND CONSUMER: this now also decides SCRATCH LIFETIME in _run_job — a retryable failure
    # keeps its scratch for a possible retry, a permanent one cleans it. So widening the classifier
    # (more errors -> retryable) also keeps more scratch around until the startup sweep reclaims it,
    # and narrowing it cleans scratch for errors nobody was thinking of as a disk decision. Weigh both
    # effects when editing the marker table.
    return is_retryable(exc)


async def _run_forever() -> None:
    """Production entry: probe the box, connect, (re)announce, pump messages, reconnect on drop."""
    import websockets  # container-2 dependency; imported lazily so tests don't need it

    from .host import hardware
    from .host.config import capability_probe_lines, resolve

    # Probe the hardware FIRST: the report is both what the core is told and what the auto-sizers used,
    # so printing it makes "why is this box slow" answerable from the log alone rather than by guessing
    # at the compose file.
    report = hardware.probe()
    print(f"[worker] hardware: {report.describe()}", flush=True)

    # Then resolve what the box can prove it does. A device is resolved inside _build_processor; the
    # same value is derived here so alignment and the report agree with separation.
    from .host.backends import preferred_torch_device

    try:
        device, _why = preferred_torch_device(CONFIG.device)
    except ValueError as exc:
        # An explicit device that is not reachable is fatal ON PURPOSE — it means the operator asked
        # for an accelerator and would otherwise get a silent CPU process at a fraction of the speed.
        print(f"[worker] FATAL: {exc}", flush=True)
        raise

    cfg, resolve_warnings, cap_probes = resolve(CONFIG, device=device)
    print(f"[worker] config: {cfg.describe()}", flush=True)
    print("[worker] capabilities (probed):", flush=True)
    for line in capability_probe_lines(cfg, cap_probes):
        print(f"[worker]{line}", flush=True)
    for warning in (*cfg.warnings, *resolve_warnings):
        print(f"[worker] config warning: {warning}", flush=True)
    for warning in oversubscription_warnings(cfg, report.cpus, report.memory_bytes):
        print(f"[worker] config warning: {warning}", flush=True)

    # Probe the optional line-bounder ONCE and say which of absent / broken / available it resolved to
    # . Left silent, "not installed" and "installed but the shim broke" are one observation: the
    # deploy box installs karaoke-lyrics-processor --no-deps while the dev box has it absent, so a
    # regression on deploy would look exactly like the always-absent dev box. This line makes it legible.
    from .lyrics import klp_probe_line

    print(f"[worker] {klp_probe_line()}", flush=True)

    processor: Processor = _build_processor(cfg)

    # Reclaim AGED-OUT orphaned scratch for the whole process lifetime. A retryable failure on
    # the final attempt is terminal but the worker cannot see it, so _run_job preserves that scratch;
    # this periodic, age-bounded sweep is the only thing that reclaims it. It NEVER touches a live job:
    # the 6h age bound means a scratch being actively written cannot qualify, so it is safe even though
    # docker-compose mounts one media volume across several workers. `_active` gives each pass the
    # CURRENT worker's in-flight ids as a second guard (a legitimately-long process of THIS worker). The
    # task lives for the process, above the reconnect loop; the live-set closure reads whichever client
    # is connected right now, or an empty set between connections.
    _current: dict[str, WorkerClient | None] = {"client": None}

    def _active() -> frozenset[str]:
        c = _current["client"]
        return frozenset(c.state.running) if c is not None else frozenset()

    # Lives for the whole process — the reconnect loop below never exits, so there is no teardown path
    # to cancel it from, and a leaked reference would only pin it. Fire-and-forget on purpose.
    # Pinned and observed, not fired and forgotten: the bare `ensure_future` left the reaper weakly
    # referenced (collectable mid-flight) and its exceptions unretrieved, so the two ways it could stop
    # were both silent. See `_SCRATCH_SWEEPS` and `_on_scratch_sweep_done`.
    _sweep_task = asyncio.ensure_future(_scratch_sweep_loop(cfg.media_dir, _active))
    _SCRATCH_SWEEPS.add(_sweep_task)
    _sweep_task.add_done_callback(_on_scratch_sweep_done)

    while True:
        client: WorkerClient | None = None
        heartbeat_task: asyncio.Task | None = None
        try:
            # Attach the worker token (if configured) only to the CONNECT url — never to the log line
            # below, which prints the token-free cfg.core_ws so the secret never lands in the log.
            async with websockets.connect(cfg.authed_core_ws()) as ws:
                client = WorkerClient(
                    lambda m: ws.send(json.dumps(m)),
                    processor,
                    worker_id=cfg.worker_id,
                    capabilities=list(cfg.capabilities),
                    concurrency=cfg.concurrency,
                    media_dir=cfg.media_dir,
                    version=cfg.version,
                )
                await client.hello()
                _current["client"] = client  # the sweep loop's live-set reads THIS connected client
                print(
                    f"[worker] {cfg.worker_id} connected to {cfg.core_ws} (caps={client.state.capabilities})",
                    flush=True,
                )
                # The message pump below only ever REACTS to inbound frames (async for raw in ws), so a
                # periodic heartbeat has to run as its own task alongside it — otherwise worker:heartbeat
                # is never sent and the core can never reconcile this worker's slotsFree after a reaped
                # job. Cancelled in the finally, before the next reconnect builds a fresh
                # client, so it is bound to exactly this socket's lifetime.
                heartbeat_task = asyncio.create_task(client.heartbeat_loop())
                async for raw in ws:
                    # Per-frame guard: a single malformed frame (bad JSON, or an exception escaping a
                    # handler) must fail only that frame, not drop the connection and every in-flight
                    # job on it. Only a genuine socket error should reach the reconnect handler below.
                    try:
                        await client.handle(json.loads(raw))
                    except Exception as exc:  # noqa: BLE001 — contain a bad frame; keep the socket up
                        print(f"[worker] dropped a bad frame ({exc!r})", flush=True)
        except Exception as exc:  # noqa: BLE001 — connection dropped; back off and redial
            print(f"[worker] disconnected ({exc!r}); reconnecting in {RECONNECT_BACKOFF_SEC}s", flush=True)
            await asyncio.sleep(RECONNECT_BACKOFF_SEC)
        finally:
            # The client for this socket is going away; the sweep loop must fall back to an empty live
            # set between connections rather than read a stale client's `running`.
            _current["client"] = None
            # Stop the per-socket heartbeat first: it is bound to this connection and the next loop
            # starts a fresh one. Cancelling a never-started task (connect itself failed) is a no-op.
            if heartbeat_task is not None:
                heartbeat_task.cancel()
            # The next loop builds a BRAND NEW client, so this one's in-flight tasks are about to be
            # abandoned. Cancel them rather than let them run to completion against a socket that is
            # already closed: an orphaned process loses its result AND races the core's reaper, which has
            # requeued the same job — cancelling is what stops the duplicate GPU work for one song.
            #
            # Cancel SYNCHRONOUSLY here (the GeneratorExit that kills a subprocess step must propagate
            # the instant the socket drops), but settle the tasks in a DETACHED background task rather
            # than awaiting them inline: a run_blocking step awaits an uninterruptible native
            # thread, so an inline `await drain` would hold this loop — and thus block redial — for up
            # to a full align pass, leaving the worker both disconnected AND still running the duplicate
            # work. Detaching lets the `while True` redial immediately while the cancelled tasks settle.
            if client is not None:
                # NOTE (advisory): detaching the drain means the NEXT client announces a full,
                # fresh WorkerState while a cancelled run_blocking step may still hold the GPU on its
                # uninterruptible native thread — so on concurrency=1 the worker can briefly run two
                # passes for one song. The old inline await avoided that by blocking redial until the
                # settle finished; the reconnect-latency fix trades that for a short capacity overlap.
                client.cancel_now()
                settle = asyncio.ensure_future(client.drain(cancel=True))
                _DETACHED_DRAINS.add(settle)
                settle.add_done_callback(_on_detached_drain_done)


if __name__ == "__main__":
    asyncio.run(_run_forever())
