"""Encore worker — dial-home WS client: the full protocol loop.

The worker connects TO the core (never the reverse), so it scales to N and runs on any box / GPU
across NAT. It announces capacity (`worker:hello`), receives `job:assign`, accepts (or rejects on
no-capacity / unsupported type), streams `job:progress` per stage, and finishes with `job:complete`
(or `job:failed`). Crash recovery is the core's job (leases + reaper) — a dropped WS just means the
worker reconnects and re-announces.

The stem separation is behind the Processor seam (processor.py). See docs/ARCHITECTURE.md, §9.
"""
from __future__ import annotations

import shutil
import asyncio
import json
import os
import time
from typing import Any

from . import protocol
from .mediastore import MediaStoreConfig, parse_media_store
from .config import WorkerConfig
from .processor import CompleteResult, JobSpec, Processor, ProgressEvent, StubProcessor

# All environment reading lives in config.py, so there is ONE place to look for "what is this worker
# actually configured to do" — and so the perf knobs are testable without mutating os.environ.
# Host-derived values (capabilities, worker id, alignment device) are filled in by config.resolve()
# at startup, which is why this is the raw config and not the effective one.
CONFIG = WorkerConfig.from_env()

CORE_URL = CONFIG.core_ws
WORKER_ID = CONFIG.worker_id
CONCURRENCY = CONFIG.concurrency
CAPABILITIES = list(CONFIG.capabilities)
MEDIA_DIR = CONFIG.media_dir
VERSION = CONFIG.version
RECONNECT_BACKOFF_SEC = 3.0


class WorkerClient:
    """Drives one worker session against a connected socket. Decoupled from the `websockets`
    library: it takes an async `send(dict)` and is fed inbound messages via `handle(msg)`, so the
    full flow unit-tests with an in-memory fake socket."""

    def __init__(self, send, processor: Processor, *, worker_id: str = WORKER_ID,
                 capabilities: list[str] | None = None, concurrency: int = CONCURRENCY,
                 media_dir: str = MEDIA_DIR, version: str = VERSION) -> None:
        self._send = send
        self._processor = processor
        self._media_dir = media_dir
        self._version = version
        # MediaStore config arrives in worker:welcome; local until then.
        self.media_store = MediaStoreConfig(kind="local")
        self.state = protocol.WorkerState(
            worker_id=worker_id,
            capabilities=list(capabilities or CAPABILITIES),
            concurrency=concurrency,
        )
        self._tasks: set[asyncio.Task] = set()

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
        # run processing concurrently so the loop keeps reading ping/cancel
        task = asyncio.ensure_future(self._run_job(job))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _run_job(self, job: JobSpec) -> None:
        try:
            result: CompleteResult | None = None
            # Time each stage from the progress stream the processor already emits. Nothing inside the
            # processors changes, so this cannot drift when one of them is edited.
            timer = protocol.StageTimer(time.monotonic)
            async for ev in self._processor.process(job):
                if isinstance(ev, ProgressEvent):
                    timer.observe(ev.stage)
                    await self._send(protocol.progress(self.state.worker_id, job.job_id, ev.stage, ev.pct, ev.eta_sec))
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
                )
            )
        except Exception as exc:  # noqa: BLE001 — report ANY failure to the core, which decides retry
            retryable = _is_retryable(exc)
            # LOG it too: reporting only over the wire made a retry loop invisible from both ends — a
            # job failing at 99% every attempt looked identical to one still cooking.
            print(f"[worker] job {job.job_id} ({job.job_type}) FAILED "
                  f"retryable={retryable}: {exc!r}", flush=True)
            await self._send(protocol.failed(self.state.worker_id, job.job_id, str(exc), retryable=retryable))
        finally:
            self.state.finish(job.job_id)
            # The worker OWNS its scratch, so the worker cleans it: work/<jobId> holds the decoded
            # source + both WAV stems (hundreds of MB per job), and leaving them is how 432 MB
            # accumulated. This cannot be done from the core — in a two-container deployment the core
            # runs as a DIFFERENT uid and a core-side rmtree gets EACCES on dirs the worker created at
            # its own umask. ignore_errors: tidying must never turn a completed job into a failed one.
            shutil.rmtree(os.path.join(job.media_dir, "work", job.job_id), ignore_errors=True)

    def _on_cancel(self, msg: dict[str, Any]) -> None:
        # cooperative cancel: drop the slot now; the core already moved the job to canceled.
        # (Real Demucs subprocess termination wires in where there is a process to kill.)
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
    permanent = ("not found", "404", "unsupported", "corrupt")
    msg = str(exc).lower()
    return not any(p in msg for p in permanent)


def oversubscription_warnings(cfg: WorkerConfig, cores: int | None,
                              memory_bytes: int | None = None) -> list[str]:
    """Warn when concurrency x jobs asks for more parallel work than the box can run.

    PURE (cores and memory are passed in) so it unit-tests without touching the machine. This is its
    own check rather than part of WorkerConfig.from_env because core count is a property of the HOST,
    not the environment, and from_env is deliberately pure over env alone.

    Worth warning about because the two knobs MULTIPLY: `concurrency=4, jobs=4` is 16 concurrent
    demucs chunk workers, each holding its own model copy, so the box thrashes and every song gets
    slower — the opposite of what raising them looks like it should do. Never fatal: a GPU box or a
    deliberate over-commit is the operator's call.

    `cores` should be the EFFECTIVE count (hardware.effective_cpus), not os.cpu_count(): inside a
    throttled container the host figure hides exactly the contention this is looking for.

    Only MEMORY-and-scheduling contention is reported here. There is deliberately no "you forgot to
    cap threads" warning any more: `from_env` derives `torch_threads` from concurrency x jobs whenever
    it is unset, so the condition that warning described cannot arise, and a warning naming a fix that
    has already been applied is worse than none. What remains is the case config cannot fix for you —
    asking for more parallel separations than the host has cores, or than its RAM can hold.
    """
    out: list[str] = []
    parallel = max(1, cfg.concurrency) * max(1, cfg.demucs_jobs)
    if cores and parallel > cores:
        out.append(
            f"concurrency={cfg.concurrency} x demucs_jobs={cfg.demucs_jobs} = {parallel} parallel "
            f"separations on {cores} usable cores; songs will contend"
        )
    if memory_bytes:
        # Each parallel separation holds its own model copy plus the decoded audio it is working on.
        # ~2 GiB is the conservative figure for htdemucs; roformer is heavier, so this under-warns
        # rather than crying wolf.
        need = parallel * 2 * 1024**3
        if need > memory_bytes:
            out.append(
                f"{parallel} parallel separations need roughly {need // 1024**3} GiB but only "
                f"{memory_bytes // 1024**3} GiB is available; expect the OOM killer rather than "
                "slow cooks — lower ENCORE_WORKER_CONCURRENCY or ENCORE_DEMUCS_JOBS"
            )
    return out


def _build_processor(cfg: WorkerConfig | None = None) -> Processor:
    """Build the processor from this worker's capabilities. ENCORE_PROCESSOR=stub forces the no-ML
    StubProcessor. Otherwise a RoutingProcessor dispatches by job type: stems→DemucsProcessor,
    align→WhisperXProcessor. Imports are lazy so torch only loads for advertised capabilities.

    Config is read ON CALL, not captured at import: a module-level default would silently ignore an
    environment set after import, and be untestable.
    """
    cfg = cfg or WorkerConfig.from_env()
    if cfg.processor == "stub":
        return StubProcessor()

    from .processor import RoutingProcessor

    # Cap intra-op threads BEFORE any model loads. Matters when demucs_jobs > 1: N jobs each
    # defaulting to all cores oversubscribe the box and fight instead of scaling.
    #
    # demucs runs as a separate CLI SUBPROCESS (see demucs.py subprocess_runner), so
    # torch.set_num_threads() in THIS process cannot reach it — the child inherits os.environ, so
    # OMP/MKL are how the cap crosses the process boundary. Measured on a 10-core box: `-j 1` already
    # ran ~3.9 cores wide, so `-j 4` uncapped just oversubscribes (86s vs 99s); the cap is what lets
    # jobs scale instead of fight. torch.set_num_threads() still applies to the IN-PROCESS consumers
    # (pitch/score extraction).
    if cfg.torch_threads is not None:
        os.environ["OMP_NUM_THREADS"] = str(cfg.torch_threads)
        os.environ["MKL_NUM_THREADS"] = str(cfg.torch_threads)
        try:
            import torch

            torch.set_num_threads(cfg.torch_threads)
        except Exception as exc:  # noqa: BLE001 — a tuning hint must never stop the worker
            print(f"[worker] could not set torch threads: {exc}", flush=True)

    by_type: dict[str, Processor] = {}
    # Resolve the device ONCE for the whole worker. Separation and alignment used to answer this
    # question independently — and alignment's answer was a hardcoded "cpu" — so a CUDA box separated
    # on the GPU and then transcribed on the CPU unless a human set a second env var. One resolution
    # means the two cannot disagree.
    device: str | None = None
    if any(c in cfg.capabilities for c in ("stems", "score", "stems:roformer", "stems:ensemble", "align")):
        from .backends import resolve_backend
        from .vocabulary import Engine

        choice = resolve_backend(cfg.separator_backend, engine=Engine.DEMUCS, device=cfg.device)
        device = choice.device
        print(f"[worker] separator backend: {choice.backend.value} — {choice.reason}", flush=True)

    if any(c.startswith("fetch:") for c in cfg.capabilities):
        from .fetch import FetchProcessor

        # Acquisition needs no ML, so it is built whenever a fetch capability is advertised — including
        # on a box that cannot separate at all. That asymmetry is the point of routing fetch separately.
        annotator = None
        if cfg.annotate:
            from .annotate import MusicBrainzClient

            annotator = MusicBrainzClient()
        by_type["fetch"] = FetchProcessor(ytdlp_bin=cfg.ytdlp_bin, annotator=annotator)
    if "stems" in cfg.capabilities or "score" in cfg.capabilities or "stems:roformer" in cfg.capabilities:
        from .demucs import DemucsProcessor  # lazy: torch off the import path until selected
        from .processor import EngineRouter

        demucs = DemucsProcessor(
            model=cfg.demucs_model,
            ytdlp_bin=cfg.ytdlp_bin,
            demucs_bin=cfg.demucs_bin,
            ffmpeg_bin=cfg.ffmpeg_bin,
            bitrate=cfg.stem_bitrate,
            flac_level=cfg.flac_level,
            device=device,
            jobs=cfg.demucs_jobs,
            overlap=cfg.demucs_overlap,
            segment=cfg.demucs_segment,
            shifts=cfg.demucs_shifts,
        )
        by_engine: dict[str, Processor] = {"demucs": demucs}
        # Only load the roformer engine (and its ~700MB checkpoint machinery) when this worker
        # was given the stems:roformer capability — a demucs-only worker never imports bs_roformer.
        if "stems:roformer" in cfg.capabilities:
            from .roformer import RoformerProcessor

            by_engine["roformer"] = RoformerProcessor(device=device, flac_level=cfg.flac_level)

        router = EngineRouter(by_engine)
        by_type["stems"] = router
        by_type["stems-upgrade"] = router  # an upgrade is a separation job like any other
        if "score" in cfg.capabilities:
            from .score import PitchTrackProcessor  # separate → extract reference pitch track

            by_type["score"] = PitchTrackProcessor(separator=demucs)
    if "align" in cfg.capabilities:
        from .config import whisperx_device_for
        from .whisperx import WhisperXProcessor

        # Follows the same device decision as separation, mapped through whisperx_device_for because
        # CTranslate2 has only cuda and cpu backends — an xpu or mps box separates on its accelerator
        # and still aligns on the CPU, which is a real constraint rather than a missed optimisation.
        by_type["align"] = WhisperXProcessor(
            device=cfg.whisperx_device or whisperx_device_for(device),
            ytdlp_bin=cfg.ytdlp_bin,
            lrclib_base=cfg.lrclib_base,
            model=cfg.asr_model,
            sync_mode=cfg.sync_mode,
        )
    return RoutingProcessor(by_type)


async def _run_forever() -> None:
    """Production entry: probe the box, connect, (re)announce, pump messages, reconnect on drop."""
    import websockets  # container-2 dependency; imported lazily so tests don't need it

    from . import hardware
    from .config import capability_probe_lines, resolve

    # Probe the hardware FIRST: the report is both what the core is told and what the auto-sizers used,
    # so printing it makes "why is this box slow" answerable from the log alone rather than by guessing
    # at the compose file.
    report = hardware.probe()
    print(f"[worker] hardware: {report.describe()}", flush=True)

    # Then resolve what the box can prove it does. A device is resolved inside _build_processor; the
    # same value is derived here so alignment and the report agree with separation.
    from .backends import preferred_torch_device

    try:
        device, _why = preferred_torch_device(CONFIG.device)
    except ValueError as exc:
        # An explicit device that is not reachable is fatal ON PURPOSE — it means the operator asked
        # for an accelerator and would otherwise get a silent CPU cook at a fraction of the speed.
        print(f"[worker] FATAL: {exc}", flush=True)
        raise

    cfg, resolve_warnings = resolve(CONFIG, device=device)
    print(f"[worker] config: {cfg.describe()}", flush=True)
    print("[worker] capabilities (probed):", flush=True)
    for line in capability_probe_lines(cfg):
        print(f"[worker]{line}", flush=True)
    for warning in (*cfg.warnings, *resolve_warnings):
        print(f"[worker] config warning: {warning}", flush=True)
    for warning in oversubscription_warnings(cfg, report.cpus, report.memory_bytes):
        print(f"[worker] config warning: {warning}", flush=True)

    processor: Processor = _build_processor(cfg)
    while True:
        try:
            async with websockets.connect(cfg.core_ws) as ws:
                client = WorkerClient(
                    lambda m: ws.send(json.dumps(m)), processor,
                    worker_id=cfg.worker_id,
                    capabilities=list(cfg.capabilities),
                    concurrency=cfg.concurrency,
                    media_dir=cfg.media_dir,
                    version=cfg.version,
                )
                await client.hello()
                print(f"[worker] {cfg.worker_id} connected to {cfg.core_ws} (caps={client.state.capabilities})")
                async for raw in ws:
                    await client.handle(json.loads(raw))
        except Exception as exc:  # noqa: BLE001 — connection dropped; back off and redial
            print(f"[worker] disconnected ({exc!r}); reconnecting in {RECONNECT_BACKOFF_SEC}s")
            await asyncio.sleep(RECONNECT_BACKOFF_SEC)


if __name__ == "__main__":
    asyncio.run(_run_forever())
