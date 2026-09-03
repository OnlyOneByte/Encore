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

import shutil
import asyncio
import json
import os
from typing import Any

from . import protocol
from .mediastore import MediaStoreConfig, parse_media_store
from .config import WorkerConfig
from .processor import CompleteResult, JobSpec, Processor, ProgressEvent, StubProcessor

# All environment reading lives in config.py, so there is ONE place to look for "what is this worker
# actually configured to do" — and so the perf knobs are testable without mutating os.environ.
CONFIG = WorkerConfig.from_env()

CORE_URL = CONFIG.core_ws
WORKER_ID = CONFIG.worker_id or "worker-1"
CONCURRENCY = CONFIG.concurrency
CAPABILITIES = list(CONFIG.capabilities)
MEDIA_DIR = CONFIG.media_dir
VERSION = CONFIG.version
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
        # MediaStore config arrives in worker:welcome (M7-C10); local until then.
        self.media_store = MediaStoreConfig(kind="local")
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
            # config handshake: record where to read source / write stems (local volume vs S3/MinIO)
            self.media_store = parse_media_store(msg)
            return
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
            retryable = _is_retryable(exc)
            # LOG it too. Reporting only over the wire made a retry loop invisible from both ends: a
            # job that failed at 99% every attempt looked identical to one still cooking, because the
            # worker printed nothing and the core just requeued. Same lesson as B-7-C5.
            print(f"[worker] job {job.job_id} ({job.job_type}) FAILED "
                  f"retryable={retryable}: {exc!r}", flush=True)
            await self._send(protocol.failed(self.state.worker_id, job.job_id, str(exc), retryable=retryable))
        finally:
            self.state.finish(job.job_id)
            # B-7: the worker OWNS its scratch, so the worker cleans it. work/<jobId> holds the
            # decoded source plus both separated WAV stems — hundreds of MB per job, and nothing reads
            # them once the encoded artifacts are published. Leaving them is how 432 MB accumulated
            # under the old layout.
            #
            # This cannot be done from the core: in a two-container deployment the core runs as a
            # DIFFERENT uid, and these dirs are created by the worker at its own umask, so a
            # core-side rmtree gets EACCES. Cleanup has to live with whoever created the files.
            # ignore_errors: tidying must never turn a completed job into a failed one.
            shutil.rmtree(os.path.join(job.media_dir, "work", job.job_id), ignore_errors=True)

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


def oversubscription_warnings(cfg: WorkerConfig, cores: int | None) -> list[str]:
    """Warn when concurrency x jobs asks for more parallel work than the box can run.

    PURE (cores is passed in) so it unit-tests without touching the machine. This is its own check
    rather than part of WorkerConfig.from_env because core count is a property of the HOST, not the
    environment, and from_env is deliberately pure over env alone.

    Worth warning about because the two knobs MULTIPLY: `concurrency=4, jobs=4` is 16 concurrent
    demucs chunk workers, each holding its own model copy. Uncapped they also each default to all
    cores, so the box thrashes and every song gets slower — the opposite of what raising them looks
    like it should do. Never fatal: a GPU box or a deliberate over-commit is the operator's call.
    """
    out: list[str] = []
    if not cores:
        return out
    parallel = max(1, cfg.concurrency) * max(1, cfg.demucs_jobs)
    if parallel > cores:
        out.append(
            f"concurrency={cfg.concurrency} x demucs_jobs={cfg.demucs_jobs} = {parallel} parallel "
            f"separations on {cores} cores; songs will contend"
        )
    if parallel > 1 and cfg.torch_threads is None:
        out.append(
            f"{parallel} parallel separations with no ENCORE_TORCH_THREADS cap — each defaults to all "
            f"cores and they will fight; try ENCORE_TORCH_THREADS={max(1, cores // parallel)}"
        )
    return out


def _build_processor(cfg: WorkerConfig | None = None) -> Processor:
    """Build the processor from this worker's capabilities. ENCORE_PROCESSOR=stub forces the no-ML
    StubProcessor (path test / torch-less box). Otherwise a RoutingProcessor dispatches by job type:
    stems→DemucsProcessor (M7-C5), align→WhisperXProcessor (M7-C8). Imports are lazy so torch only
    loads for the capabilities this worker actually advertises.

    Config is read ON CALL, not captured at import: a module-level default would silently ignore any
    environment set after import, which is both surprising and untestable.
    """
    cfg = cfg or WorkerConfig.from_env()
    if cfg.processor == "stub":
        return StubProcessor()

    from .processor import RoutingProcessor

    # Cap intra-op threads BEFORE any model loads. Matters when demucs_jobs > 1: N jobs each
    # defaulting to all cores oversubscribes the box and they fight instead of scaling.
    #
    # The os.environ half is the part that actually bites for stems: demucs runs as a separate CLI
    # SUBPROCESS (see demucs.py subprocess_runner), so torch.set_num_threads() in THIS process cannot
    # reach it — the knob read as a no-op for the very case its docstring described. The child
    # inherits os.environ, so OMP/MKL are how a thread cap crosses the process boundary. Measured on a
    # 10-core box: `-j 1` already ran ~3.9 cores wide via torch threading, so `-j 4` uncapped just
    # oversubscribes (86s vs 99s); the cap is what lets jobs scale instead of fight.
    # torch.set_num_threads() is still called for the IN-PROCESS consumers (pitch/score extraction).
    if cfg.torch_threads is not None:
        os.environ["OMP_NUM_THREADS"] = str(cfg.torch_threads)
        os.environ["MKL_NUM_THREADS"] = str(cfg.torch_threads)
        try:
            import torch

            torch.set_num_threads(cfg.torch_threads)
        except Exception as exc:  # noqa: BLE001 — a tuning hint must never stop the worker
            print(f"[worker] could not set torch threads: {exc}", flush=True)

    by_type: dict[str, Processor] = {}
    if "stems" in cfg.capabilities or "score" in cfg.capabilities:
        from .demucs import DemucsProcessor  # lazy: torch off the import path until selected

        demucs = DemucsProcessor(
            model=cfg.demucs_model,
            ytdlp_bin=cfg.ytdlp_bin,
            demucs_bin=cfg.demucs_bin,
            ffmpeg_bin=cfg.ffmpeg_bin,
            bitrate=cfg.stem_bitrate,
            flac_level=cfg.flac_level,
            device=cfg.demucs_device,
            jobs=cfg.demucs_jobs,
            overlap=cfg.demucs_overlap,
            segment=cfg.demucs_segment,
            shifts=cfg.demucs_shifts,
        )
        by_type["stems"] = demucs
        if "score" in cfg.capabilities:
            from .score import PitchTrackProcessor  # separate → extract reference pitch track (M8-C3)

            by_type["score"] = PitchTrackProcessor(separator=demucs)
    if "align" in cfg.capabilities:
        from .whisperx import WhisperXProcessor

        # Hybrid forced-alignment (M7-C8): LRCLIB known text + WhisperX wav2vec2 align().
        # device cpu by default; a GPU worker sets ENCORE_WHISPERX_DEVICE=cuda.
        by_type["align"] = WhisperXProcessor(device=cfg.whisperx_device, ytdlp_bin=cfg.ytdlp_bin)
    return RoutingProcessor(by_type)


async def _run_forever() -> None:
    """Production entry: connect, (re)announce, pump messages, reconnect with backoff on drop."""
    import websockets  # container-2 dependency; imported lazily so tests don't need it

    # Say what this worker is actually configured to do. On a heterogeneous fleet (one GPU box, one
    # CPU box) "why is this one slow" is answered by this line, not by guessing at the compose file.
    print(f"[worker] config: {CONFIG.describe()}", flush=True)
    for warning in CONFIG.warnings:
        print(f"[worker] config warning: {warning}", flush=True)
    for warning in oversubscription_warnings(CONFIG, os.cpu_count()):
        print(f"[worker] config warning: {warning}", flush=True)

    processor: Processor = _build_processor(CONFIG)
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
