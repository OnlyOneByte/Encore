"""Dial-home WS client: the worker's full protocol loop against the core.

See docs/SERVER.md#worker-runtime and docs/SERVER.md#what-the-worker-is-told; docs/ARCHITECTURE.md §9.
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

# RAW env config; host-derived values are filled in later by config.resolve(). Read ON CALL, never
# snapshotted at import. See docs/SERVER.md#worker-runtime.
CONFIG = WorkerConfig.from_env()

RECONNECT_BACKOFF_SEC = 3.0

# Detached from the dropped connection so reconnect never blocks on them; pinned here so they are not
# GC'd mid-flight. See docs/SERVER.md#worker-runtime.
_DETACHED_DRAINS: set[asyncio.Task] = set()


def _on_detached_drain_done(task: asyncio.Task) -> None:
    """Discard the finished drain and surface its exception rather than losing it at GC."""
    _DETACHED_DRAINS.discard(task)
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        print(f"[worker] detached drain raised ({exc!r})", flush=True)


# Fallback cadence if worker:welcome never carries one; stays below the 30s progress lease.
DEFAULT_HEARTBEAT_INTERVAL_SEC = 10.0


class WorkerClient:
    """Drives one worker session against a connected socket, decoupled from `websockets` so it
    unit-tests with an in-memory fake."""

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
        # Each kwarg defaults to None and resolves against CONFIG here, read on call.
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
        # Whether this worker can PUT into an object store; the S3 uploader seam is unwired, so
        # _on_assign refuses object-mode jobs rather than completing with a local path. See
        # docs/SERVER.md#what-the-worker-is-told.
        self._can_publish_object = can_publish_object
        self.state = protocol.WorkerState(
            worker_id=worker_id,
            capabilities=list(capabilities if capabilities is not None else CONFIG.capabilities),
            concurrency=concurrency,
        )
        # jobId -> its in-flight task, so a cancel reaches the right one (and, via subprocess_runner,
        # the child process); a bare set could only be drained, not cancelled by job.
        self._tasks: dict[str, asyncio.Task] = {}
        # Heartbeat cadence, handed over in worker:welcome; the default holds until then.
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
        """Push worker:heartbeat on a loop, since the core has no liveness poll of its own; the
        interval is re-read live each tick so a late worker:welcome still takes effect."""
        while True:
            await asyncio.sleep(max(0.1, self.heartbeat_interval_sec))
            try:
                await self.send_heartbeat()
            except asyncio.CancelledError:
                raise  # _run_forever's finally cancels this task on disconnect
            except Exception as exc:  # noqa: BLE001
                # A dead socket surfaces here too; the pump side drives the real reconnect.
                print(f"[worker] heartbeat send failed ({exc!r}); will retry next tick", flush=True)

    async def handle(self, msg: dict[str, Any]) -> None:
        """Dispatch one inbound core->worker command."""
        t = msg.get("type")
        if t == protocol.WELCOME:
            self.media_store = parse_media_store(msg)
            # A malformed/missing interval is ignored rather than silencing the heartbeat leg.
            interval = msg.get("heartbeatIntervalSec")
            if isinstance(interval, (int, float)) and interval > 0:
                self.heartbeat_interval_sec = float(interval)
            # Surface the object-mode gap at handshake time too, not only on the first job reject.
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
        # Unknown frame type: logged, not dropped silently. See docs/SERVER.md#worker-runtime.
        print(f"[worker] ignoring unhandled message type {t!r}", flush=True)

    async def _on_assign(self, msg: dict[str, Any]) -> None:
        # Validate required fields before touching state, or one malformed frame kills every
        # in-flight job on this socket. See docs/SERVER.md#worker-runtime.
        job_id = msg.get("jobId")
        job_type = msg.get("jobType")
        media_id = msg.get("mediaId")
        if not isinstance(job_id, str) or not job_id:
            # No usable job id, so no job-scoped reject is possible: log and drop the frame alone.
            print(f"[worker] ignoring malformed job:assign (missing/invalid jobId): {msg!r}", flush=True)
            return
        if not isinstance(job_type, str) or not job_type or not isinstance(media_id, str) or not media_id:
            print(f"[worker] rejecting malformed job:assign {job_id!r} (missing jobType/mediaId)", flush=True)
            await self._send(
                protocol.reject(self.state.worker_id, job_id, "malformed assign: missing jobType/mediaId")
            )
            return
        # Refuse rather than complete dishonestly on an object-mode gap. See docs/SERVER.md#worker-runtime.
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
        # A non-dict `params` (a core bug, a malformed frame) would reach JobSpec.params: dict
        # untyped and raise mid-process downstream, escaping into the reconnect handler. Reject it
        # job-scoped at the boundary instead. Absent `params` is fine: `.get` defaults to {} below.
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
            # Trace id for this process; absent on a frame from a core that predates it -> "".
            processing_id=msg.get("processingId", ""),
        )
        # Run concurrently so the loop keeps reading ping/cancel.
        task = asyncio.ensure_future(self._run_job(job))
        self._tasks[job_id] = task

        def _pop_task(_t: Any, jid: Any = job_id) -> None:
            self._tasks.pop(jid, None)

        task.add_done_callback(_pop_task)

    async def _run_job(self, job: JobSpec) -> None:
        # Scratch survives a retryable failure so a core retry (same jobId) can resume from disk. See
        # docs/SERVER.md#worker-runtime.
        preserve_scratch = False
        try:
            result: CompleteResult | None = None
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
            # An exhausted-retry job looks identical to a genuinely retryable one here, so its scratch
            # leaks and is reclaimed by sweep_orphaned_scratch() at the next startup instead.
            preserve_scratch = retryable
            print(
                f"[worker] job {job.job_id} ({job.job_type}) FAILED retryable={retryable}: {exc!r}",
                flush=True,
            )
            await self._send(protocol.failed(self.state.worker_id, job.job_id, str(exc), retryable=retryable))
        finally:
            self.state.finish(job.job_id)
            # The worker owns and deletes its scratch via scratch_for(job) — never a hand-rebuilt
            # path — skipped only on a retryable failure. See docs/SERVER.md#worker-runtime.
            if not preserve_scratch:
                shutil.rmtree(scratch_for(job), ignore_errors=True)

    def _on_cancel(self, msg: dict[str, Any]) -> None:
        # Cancel propagates GeneratorExit into the processor generator (subprocess_runner kills the
        # child); the task's own done-callback and _run_job's finally free the slot without a spurious
        # job:failed. No tracked task -> just free the slot.
        job_id = msg.get("jobId", "")
        task = self._tasks.get(job_id)
        if task is not None and not task.done():
            task.cancel()
            return  # the task's finally frees the slot; do not double-finish
        self.state.finish(job_id)

    def cancel_now(self) -> None:
        """Synchronously cancel all in-flight tasks without awaiting them; pair with a detached
        `drain()` to settle a run_blocking step's uninterruptible thread off the reconnect path."""
        for task in list(self._tasks.values()):
            task.cancel()

    async def drain(self, *, cancel: bool = False) -> None:
        """Settle in-flight tasks so none outlive the client. `cancel=True` (the reconnect path)
        cancels first, else an orphaned process races the core's reaper's requeue onto a fresh
        connection."""
        if not self._tasks:
            return
        tasks = list(self._tasks.values())
        if cancel:
            for task in tasks:
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def _is_retryable(exc: Exception) -> bool:
    # The one retry decision point; also governs _run_job's scratch lifetime. See docs/SERVER.md#worker-runtime.
    return is_retryable(exc)


async def _run_forever() -> None:
    """Production entry: probe the box, connect, (re)announce, pump messages, reconnect on drop."""
    import websockets  # container-2 dependency; imported lazily so tests don't need it

    from .host import hardware
    from .host.config import capability_probe_lines, resolve

    report = hardware.probe()
    print(f"[worker] hardware: {report.describe()}", flush=True)

    from .host.backends import preferred_torch_device

    try:
        device, _why = preferred_torch_device(CONFIG.device)
    except ValueError as exc:
        # An unreachable explicit device is fatal on purpose rather than silently falling back to CPU.
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

    # Logged rather than silent, so "not installed" and "installed but broken" stay distinguishable.
    from .lyrics import klp_probe_line

    print(f"[worker] {klp_probe_line()}", flush=True)

    processor: Processor = _build_processor(cfg)

    # Backstop for a retryable failure on the exhausted final attempt, which the worker cannot tell
    # apart from a genuinely retryable one; `_active` excludes this worker's own live jobs.
    _current: dict[str, WorkerClient | None] = {"client": None}

    def _active() -> frozenset[str]:
        c = _current["client"]
        return frozenset(c.state.running) if c is not None else frozenset()

    # Pinned in _SCRATCH_SWEEPS so it is not GC'd mid-flight; lives for the whole process.
    _sweep_task = asyncio.ensure_future(_scratch_sweep_loop(cfg.media_dir, _active))
    _SCRATCH_SWEEPS.add(_sweep_task)
    _sweep_task.add_done_callback(_on_scratch_sweep_done)

    while True:
        client: WorkerClient | None = None
        heartbeat_task: asyncio.Task | None = None
        try:
            # The worker token, if configured, is attached only here, never logged.
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
                _current["client"] = client  # the sweep loop's live-set reads this connected client
                print(
                    f"[worker] {cfg.worker_id} connected to {cfg.core_ws} (caps={client.state.capabilities})",
                    flush=True,
                )
                # The pump only reacts to inbound frames, so heartbeat needs its own task.
                heartbeat_task = asyncio.create_task(client.heartbeat_loop())
                async for raw in ws:
                    try:
                        await client.handle(json.loads(raw))
                    except Exception as exc:  # noqa: BLE001 — contain a bad frame; keep the socket up
                        print(f"[worker] dropped a bad frame ({exc!r})", flush=True)
        except Exception as exc:  # noqa: BLE001 — connection dropped; back off and redial
            print(f"[worker] disconnected ({exc!r}); reconnecting in {RECONNECT_BACKOFF_SEC}s", flush=True)
            await asyncio.sleep(RECONNECT_BACKOFF_SEC)
        finally:
            _current["client"] = None
            if heartbeat_task is not None:
                heartbeat_task.cancel()
            # This client's in-flight tasks would otherwise race the core's reaper's requeue; cancel
            # synchronously but settle detached so redial is not blocked. See docs/SERVER.md#worker-runtime.
            if client is not None:
                client.cancel_now()
                settle = asyncio.ensure_future(client.drain(cancel=True))
                _DETACHED_DRAINS.add(settle)
                settle.add_done_callback(_on_detached_drain_done)


if __name__ == "__main__":
    asyncio.run(_run_forever())
