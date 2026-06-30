"""Encore worker — dial-home WS client (M7-C4: full protocol loop).

The worker connects TO the core (never the reverse), so it scales to N and runs on any box / GPU
across NAT. It announces capacity (`worker:hello`), receives `job:assign`, accepts (or rejects on
no-capacity / unsupported type), streams `job:progress` per stage, and finishes with `job:complete`
(or `job:failed`). Crash recovery is the core's job (leases + reaper, M7-C2) — a dropped WS just
means the worker reconnects and re-announces.

The actual stem separation is behind the Processor seam (processor.py). M7-C4 ships StubProcessor;
M7-C5 swaps in real Demucs `htdemucs` with NO change to this loop. See
docs/job-lifecycle-and-worker-protocol.md §5, §9.

Run:  python -m src.dial_home   (or as a module inside the container)
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from . import protocol
from .processor import CompleteResult, JobSpec, Processor, ProgressEvent, StubProcessor

CORE_URL = os.environ.get("ENCORE_CORE_WS", "ws://localhost:3000/ws?role=worker")
WORKER_ID = os.environ.get("ENCORE_WORKER_ID", "worker-1")
CONCURRENCY = int(os.environ.get("ENCORE_WORKER_CONCURRENCY", "1"))
CAPABILITIES = [c.strip() for c in os.environ.get("ENCORE_WORKER_CAPABILITIES", "stems").split(",") if c.strip()]
MEDIA_DIR = os.environ.get("MEDIA_DIR", "/app/media")
VERSION = os.environ.get("ENCORE_WORKER_VERSION", "0.2.0")
RECONNECT_BACKOFF_SEC = 3.0


class WorkerClient:
    """Drives one worker session against a connected socket. Decoupled from the `websockets`
    library: it takes an async `send(dict)` and is fed inbound messages via `handle(msg)`, so the
    full assign->complete flow unit-tests with an in-memory fake socket (no network)."""

    def __init__(self, send, processor: Processor, *, worker_id: str = WORKER_ID,
                 capabilities: list[str] | None = None, concurrency: int = CONCURRENCY,
                 media_dir: str = MEDIA_DIR, version: str = VERSION) -> None:
        self._send = send
        self._processor = processor
        self._media_dir = media_dir
        self._version = version
        self.state = protocol.WorkerState(
            worker_id=worker_id,
            capabilities=list(capabilities or CAPABILITIES),
            concurrency=concurrency,
        )
        self._tasks: set[asyncio.Task] = set()

    async def hello(self) -> None:
        await self._send(protocol.hello(self.state.worker_id, self.state.capabilities, self.state.concurrency, self._version))

    async def send_heartbeat(self) -> None:
        await self._send(protocol.heartbeat(self.state.worker_id, self.state.slots_free, list(self.state.running)))

    async def handle(self, msg: dict[str, Any]) -> None:
        """Dispatch one inbound core->worker command."""
        t = msg.get("type")
        if t == protocol.WELCOME:
            return  # config handshake; nothing required from the worker
        if t == protocol.PING:
            return await self.send_heartbeat()
        if t == protocol.ASSIGN:
            return await self._on_assign(msg)
        if t == protocol.CANCEL:
            return self._on_cancel(msg)

    async def _on_assign(self, msg: dict[str, Any]) -> None:
        job_id = msg["jobId"]
        job_type = msg["jobType"]
        ok, reason = self.state.can_accept(job_type)
        if not ok:
            await self._send(protocol.reject(self.state.worker_id, job_id, reason))
            return
        await self._send(protocol.accept(self.state.worker_id, job_id))
        self.state.start(job_id)
        job = JobSpec(
            job_id=job_id,
            media_id=msg["mediaId"],
            job_type=job_type,
            source_uri=msg.get("sourceUri", ""),
            params=msg.get("params", {}),
            media_dir=self._media_dir,
        )
        # run the (possibly long) processing concurrently so the loop keeps reading ping/cancel
        task = asyncio.ensure_future(self._run_job(job))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _run_job(self, job: JobSpec) -> None:
        try:
            result: CompleteResult | None = None
            async for ev in self._processor.process(job):
                if isinstance(ev, ProgressEvent):
                    await self._send(protocol.progress(self.state.worker_id, job.job_id, ev.stage, ev.pct, ev.eta_sec))
                else:  # CompleteResult
                    result = ev
            if result is None:
                raise RuntimeError("processor produced no result")
            await self._send(protocol.complete(self.state.worker_id, job.job_id, result.media_uri, result.artifacts))
        except Exception as exc:  # noqa: BLE001 — report ANY failure to the core, which decides retry
            # retryable=True for transient errors; a corrupt/unsupported source is non-retryable.
            await self._send(protocol.failed(self.state.worker_id, job.job_id, str(exc), retryable=_is_retryable(exc)))
        finally:
            self.state.finish(job.job_id)

    def _on_cancel(self, msg: dict[str, Any]) -> None:
        # cooperative cancel: drop the slot now; the core already moved the job to canceled.
        # (Real Demucs subprocess termination wires in at M7-C5 where there's a process to kill.)
        self.state.finish(msg.get("jobId", ""))

    async def drain(self) -> None:
        """Await any in-flight job tasks (graceful shutdown / test settling)."""
        if self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)


def _is_retryable(exc: Exception) -> bool:
    # Prefer a structured flag if the processor raised one (e.g. demucs.ProcessError classifies the
    # CLI's stderr); otherwise fall back to a substring heuristic on the message.
    structured = getattr(exc, "retryable", None)
    if isinstance(structured, bool):
        return structured
    # Source-gone / unsupported-format style failures are permanent; everything else may be transient.
    permanent = ("not found", "404", "unsupported", "corrupt")
    msg = str(exc).lower()
    return not any(p in msg for p in permanent)


def _build_processor() -> Processor:
    """Build the processor from this worker's CAPABILITIES. ENCORE_PROCESSOR=stub forces the no-ML
    StubProcessor (path test / torch-less box). Otherwise a RoutingProcessor dispatches by job type:
    stems→DemucsProcessor (M7-C5), align→WhisperXProcessor (M7-C8). Imports are lazy so torch only
    loads for the capabilities this worker actually advertises."""
    if os.environ.get("ENCORE_PROCESSOR", "real").lower() == "stub":
        return StubProcessor()

    from .processor import RoutingProcessor

    by_type: dict[str, Processor] = {}
    if "stems" in CAPABILITIES or "score" in CAPABILITIES:
        from .demucs import DemucsProcessor  # lazy: torch off the import path until selected

        demucs = DemucsProcessor(model=os.environ.get("ENCORE_DEMUCS_MODEL", "htdemucs"))
        by_type["stems"] = demucs
        by_type["score"] = demucs  # scoring (M8) reuses the stems separation
    if "align" in CAPABILITIES:
        from .whisperx import WhisperXProcessor

        by_type["align"] = WhisperXProcessor(model=os.environ.get("ENCORE_WHISPERX_MODEL", "base"))
    return RoutingProcessor(by_type)


async def _run_forever() -> None:
    """Production entry: connect, (re)announce, pump messages, reconnect with backoff on drop."""
    import websockets  # container-2 dependency; imported lazily so tests don't need it

    processor: Processor = _build_processor()
    while True:
        try:
            async with websockets.connect(CORE_URL) as ws:
                client = WorkerClient(lambda m: ws.send(json.dumps(m)), processor)
                await client.hello()
                print(f"[worker] {WORKER_ID} connected to {CORE_URL} (caps={client.state.capabilities})")
                async for raw in ws:
                    await client.handle(json.loads(raw))
        except Exception as exc:  # noqa: BLE001 — connection dropped; back off and redial
            print(f"[worker] disconnected ({exc!r}); reconnecting in {RECONNECT_BACKOFF_SEC}s")
            await asyncio.sleep(RECONNECT_BACKOFF_SEC)


if __name__ == "__main__":
    asyncio.run(_run_forever())
