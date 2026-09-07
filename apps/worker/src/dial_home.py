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
import os
import shutil
import time
from collections.abc import Callable
from typing import Any

from . import protocol
from .config import WorkerConfig
from .mediastore import MediaStoreConfig, parse_media_store
from .processor import CompleteResult, JobSpec, Processor, ProgressEvent, StubProcessor
from .retry_policy import is_retryable
from .runtime import scratch_for

# All environment reading lives in config.py, so there is ONE place to look for "what is this worker
# actually configured to do" — and so the perf knobs are testable without mutating os.environ.
# Host-derived values (capabilities, worker id, alignment device) are filled in by config.resolve()
# at startup, which is why this is the raw config and not the effective one.
CONFIG = WorkerConfig.from_env()

WORKER_ID = CONFIG.worker_id
CONCURRENCY = CONFIG.concurrency
CAPABILITIES = list(CONFIG.capabilities)
MEDIA_DIR = CONFIG.media_dir
VERSION = CONFIG.version
RECONNECT_BACKOFF_SEC = 3.0
# Fallback heartbeat cadence if worker:welcome never carried one (older core, or a welcome that
# predates heartbeatIntervalSec). The real value is the core's progressLeaseMs/1000 handed over at
# handshake; this is only the floor so the leg is never fully silent. Kept below the 30s lease so a
# reconciling frame always lands before a lease can expire.
DEFAULT_HEARTBEAT_INTERVAL_SEC = 10.0
# Orphaned-scratch reclaim (#469). A retryable failure on the LAST attempt is terminal but the worker
# cannot see it (no attempt count on the wire), so _run_job preserves that scratch and this sweep is
# the only thing that reclaims it. Two knobs make the sweep SAFE on a media volume shared by several
# workers: it runs PERIODICALLY (so a long-lived worker reclaims without a restart) and it only
# removes a dir whose newest file is older than SCRATCH_MIN_AGE_SEC — a live job writes continuously,
# so its scratch is always fresher than the threshold and can never be swept, even by another worker.
SCRATCH_SWEEP_INTERVAL_SEC = 1800.0  # every 30 min
SCRATCH_MIN_AGE_SEC = 6 * 3600.0  # only reclaim scratch untouched for 6h — far longer than any cook


class WorkerClient:
    """Drives one worker session against a connected socket. Decoupled from the `websockets`
    library: it takes an async `send(dict)` and is fed inbound messages via `handle(msg)`, so the
    full flow unit-tests with an in-memory fake socket."""

    def __init__(
        self,
        send,
        processor: Processor,
        *,
        worker_id: str = WORKER_ID,
        capabilities: list[str] | None = None,
        concurrency: int = CONCURRENCY,
        media_dir: str = MEDIA_DIR,
        version: str = VERSION,
        can_publish_object: bool = False,
    ) -> None:
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
            capabilities=list(capabilities or CAPABILITIES),
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
        worker's capacity permanently (issue #132). Runs until cancelled (on disconnect, from
        _run_forever). The interval is refreshed live from self.heartbeat_interval_sec each tick, so a
        worker:welcome that lands after the loop starts still takes effect.
        """
        while True:
            await asyncio.sleep(max(0.1, self.heartbeat_interval_sec))
            await self.send_heartbeat()

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
            params=msg.get("params", {}),
            media_dir=self._media_dir,
        )
        # run processing concurrently so the loop keeps reading ping/cancel
        task = asyncio.ensure_future(self._run_job(job))
        self._tasks[job_id] = task

        def _pop_task(_t: Any, jid: Any = job_id) -> None:
            self._tasks.pop(jid, None)

        task.add_done_callback(_pop_task)

    async def _run_job(self, job: JobSpec) -> None:
        # Retry reuse (#469): a core retry requeues the SAME jobId (JobRepository.requeue transitions
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
            # attempt/maxAttempts, that is core-side state (#469 review). So an exhausted-retry job's
            # scratch is preserved here and would leak; sweep_orphaned_scratch() at worker startup is
            # what reclaims it (see _run_forever). preserve_scratch is thus "keep for a POSSIBLE retry",
            # and the startup sweep is the backstop for the attempts that turned out to be the last.
            preserve_scratch = retryable
            # LOG it too: reporting only over the wire made a retry loop invisible from both ends — a
            # job failing at 99% every attempt looked identical to one still cooking.
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
            # ...but NOT between attempts of the same job (#469): on a retryable failure the scratch is
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

    async def drain(self, *, cancel: bool = False) -> None:
        """Settle this client's in-flight job tasks so none outlive the client.

        `cancel=False` (default) just AWAITS the tasks — graceful shutdown, and the settle a test
        needs after `handle(assign())` so the concurrent job task actually runs.

        `cancel=True` first CANCELS them, which is what the reconnect path needs on a socket drop.
        A dropped socket abandons this client and its `_tasks`; without a cancel the orphaned cook
        runs to completion against a closed socket, its `job:complete` is lost, and the core's reaper
        has meanwhile requeued the same job onto a fresh connection — duplicate GPU work for one song.
        Cancelling propagates GeneratorExit into the processor (subprocess_runner kills the child), so
        the abandoned cook stops instead of racing its own retry. `return_exceptions=True` so the
        CancelledError each task raises is collected here rather than escaping the reconnect handler."""
        if not self._tasks:
            return
        tasks = list(self._tasks.values())
        if cancel:
            for task in tasks:
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


def _newest_mtime(path: str) -> float:
    """The most-recent mtime anywhere under `path` (the dir itself and every descendant).

    A separation writes ONE large file deep inside work/<jobId> over many minutes; that does not bump
    the top dir's own mtime, so testing only os.path.getmtime(path) would call an actively-written
    scratch "old" and sweep it. Walking for the newest mtime is what makes the age bound actually
    track liveness. Best-effort: a file that vanishes mid-walk (a cook cleaning up) is skipped."""
    newest = 0.0
    try:
        newest = os.stat(path).st_mtime
    except OSError:
        return newest
    for root, dirs, files in os.walk(path):
        for name in (*dirs, *files):
            try:
                m = os.stat(os.path.join(root, name)).st_mtime
            except OSError:
                continue  # raced with a delete — ignore
            if m > newest:
                newest = m
    return newest


def sweep_orphaned_scratch(
    media_dir: str,
    live_job_ids: frozenset[str],
    *,
    min_age_sec: float = SCRATCH_MIN_AGE_SEC,
    now: float | None = None,
) -> list[str]:
    """Reclaim work/<jobId> scratch dirs that no longer belong to a job, returning what was removed.

    The worker's per-job finally (_run_job) cleans scratch on every TERMINAL outcome it can see, but
    it cannot see one: a retryable failure that was the LAST attempt (retries exhausted) is terminal,
    yet the worker has no attempt count on the wire to know that, so it preserves that scratch for a
    retry that never comes. Nothing else reclaims it — the runner's makedirs(exist_ok=True) is what
    makes resume work so it must NOT rmtree, a re-request mints a fresh jobId (a new work/<jobId>),
    and core retention bounds only derived/, never work/. So without this, one exhausted-retry job
    leaks its decoded WAV + separated stems — the pipeline's biggest intermediates — forever (#469).

    TWO guards keep it safe on a media volume SHARED by several workers (docker-compose mounts the
    same volume into core and every worker), where "orphan for THIS worker" is not "orphan for the
    fleet" — an early version passed frozenset() and would delete another worker's in-flight scratch:

      * AGE. Only a dir whose NEWEST file is older than `min_age_sec` (default 6h, far longer than any
        cook) is removed. A live job writes its scratch continuously, so it is always fresher than the
        threshold and can never be swept — by this worker OR another one. This is the load-bearing
        guard on a shared volume, because it needs no cross-worker knowledge.
      * LIVE SET. A jobId in `live_job_ids` is skipped outright. THIS worker's own in-flight jobs, so
        a job that legitimately runs longer than the age bound is still never swept from under itself.

    Runs in the worker, which owns the uid that created these dirs — a core-side sweep would get
    EACCES in a two-container deploy (see _run_job's finally)."""
    work_root = os.path.join(media_dir, "work")
    removed: list[str] = []
    try:
        entries = os.listdir(work_root)
    except FileNotFoundError:
        return removed  # no work/ yet — nothing to reclaim
    cutoff = (time.time() if now is None else now) - min_age_sec
    for name in entries:
        if name in live_job_ids:
            continue  # THIS worker's in-flight job — never touch a live scratch
        path = os.path.join(work_root, name)
        if not os.path.isdir(path):
            continue
        if _newest_mtime(path) > cutoff:
            continue  # touched recently — could be ANOTHER worker's live job on a shared volume
        shutil.rmtree(path, ignore_errors=True)  # tidying must never crash the worker
        removed.append(name)
    return removed


async def _scratch_sweep_loop(media_dir: str, live_job_ids: Callable[[], frozenset[str]]) -> None:
    """Periodically reclaim aged-out orphaned scratch for the process's whole lifetime (#469).

    A one-shot startup sweep left a long-lived worker (restart: unless-stopped can mean weeks of
    uptime) accumulating one orphaned scratch dir per exhausted-retry job until it restarted. Running
    on an interval closes that. `live_job_ids` is a callable so each pass reads the CURRENT in-flight
    set rather than a snapshot taken when the loop started."""
    while True:
        await asyncio.sleep(SCRATCH_SWEEP_INTERVAL_SEC)
        reclaimed = sweep_orphaned_scratch(media_dir, live_job_ids())
        if reclaimed:
            print(f"[worker] reclaimed {len(reclaimed)} aged scratch dir(s): {reclaimed}", flush=True)


def _is_retryable(exc: Exception) -> bool:
    # The retry decision lives in ONE place now: retry_policy.is_retryable (#443). It prefers a
    # structured `.retryable` flag (ProcessError/ProcessTimeout, and the boundary errors that carry
    # retryable=False) and otherwise falls back to the canonical permanent-marker table — so this
    # module no longer keeps its own divergent four-substring copy that defaulted the four boundary
    # failures (unknown fetcher/ASR model/engine, no plan) to retryable and cost the room 3 attempts.
    #
    # SECOND CONSUMER (#469): this now also decides SCRATCH LIFETIME in _run_job — a retryable failure
    # keeps its scratch for a possible retry, a permanent one cleans it. So widening the classifier
    # (more errors -> retryable) also keeps more scratch around until the startup sweep reclaims it,
    # and narrowing it cleans scratch for errors nobody was thinking of as a disk decision. Weigh both
    # effects when editing the marker table.
    return is_retryable(exc)


def oversubscription_warnings(
    cfg: WorkerConfig, cores: int | None, memory_bytes: int | None = None
) -> list[str]:
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
    StubProcessor. Otherwise a RoutingProcessor dispatches by job type onto a PlanRunner per action —
    fetch, stems, stems-upgrade and align — each running the declared plan for that action. Imports are
    lazy so torch only loads for advertised capabilities.

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
    # jobs scale instead of fight. torch.set_num_threads() still applies to the IN-PROCESS consumers.
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
    if any(c in cfg.capabilities for c in ("stems", "stems:roformer", "stems:ensemble", "align")):
        from .backends import resolve_backend
        from .vocabulary import Engine

        choice = resolve_backend(cfg.separator_backend, engine=Engine.DEMUCS, device=cfg.device)
        device = choice.device
        print(f"[worker] separator backend: {choice.backend.value} — {choice.reason}", flush=True)

    if any(c.startswith("fetch:") for c in cfg.capabilities):
        from .plans import fetch_runner
        from .separation.demucs import subprocess_runner

        # Acquisition needs no ML, so it is built whenever a fetch capability is advertised — including
        # on a box that cannot separate at all. That asymmetry is the point of routing fetch separately.
        annotator = None
        if cfg.annotate:
            from .metadata.annotate import MusicBrainzClient

            annotator = MusicBrainzClient()
        by_type["fetch"] = fetch_runner(
            runner=subprocess_runner, annotator=annotator, ytdlp_bin=cfg.ytdlp_bin
        )
    if "stems" in cfg.capabilities or "stems:roformer" in cfg.capabilities:
        from .plans import stems_runner
        from .separation.demucs import subprocess_runner

        # ONE runner for both separation actions. The engine is resolved from job params into ctx.engines
        # before the first step runs (plan SELECTION, not branching — see the spec's §5.2c), so there is no
        # second dispatch layer: EngineRouter's job is now `engine_for` inside the Separate step.
        #
        # Roformer's ~700MB checkpoint machinery is still only reachable when the capability was granted:
        # engine_for imports it lazily, and the CORE only routes a roformer cook to a worker advertising
        # stems:roformer.
        # Segment: an explicit ENCORE_DEMUCS_SEGMENT always wins; otherwise size it to the memory the
        # card actually has FREE right now. Measured here rather than in `WorkerConfig.from_env` on
        # purpose — reading free VRAM imports torch, and config is built at module import, so deriving
        # it there would pull the ML stack into every worker process including one that only fetches.
        segment = cfg.demucs_segment
        if segment is None:
            from .config import auto_demucs_segment
            from .hardware import free_vram_bytes

            free = free_vram_bytes()
            segment = auto_demucs_segment(free)
            if segment is not None and free is not None:
                print(
                    f"[worker] demucs segment: {segment}s — derived from "
                    f"{free / (1024**3):.1f}GiB free accelerator memory "
                    f"(set ENCORE_DEMUCS_SEGMENT to override)",
                    flush=True,
                )

        runner = stems_runner(
            runner=subprocess_runner,
            demucs_model=cfg.demucs_model,
            demucs_bin=cfg.demucs_bin,
            ffmpeg_bin=cfg.ffmpeg_bin,
            ytdlp_bin=cfg.ytdlp_bin,
            bitrate=cfg.stem_bitrate,
            flac_level=cfg.flac_level,
            device=device,
            jobs=cfg.demucs_jobs,
            overlap=cfg.demucs_overlap,
            segment=segment,
            shifts=cfg.demucs_shifts,
        )
        by_type["stems"] = runner
        by_type["stems-upgrade"] = runner  # an upgrade is a separation job like any other
    if "align" in cfg.capabilities:
        from .config import whisperx_device_for
        from .lyrics import LrclibClient
        from .plans import align_runner
        from .separation.demucs import subprocess_runner

        # Follows the same device decision as separation, mapped through whisperx_device_for because
        # CTranslate2 has only cuda and cpu backends — an xpu or mps box separates on its accelerator
        # and still aligns on the CPU, which is a real constraint rather than a missed optimisation.
        #
        # A PlanRunner over the declared align plan, not a bespoke processor: eight named steps rather
        # than one 257-line method, and engines resolved per JOB rather than mutated on this instance.
        # See docs/ARCHITECTURE.md §7.1 (the align plan).
        by_type["align"] = align_runner(
            runner=subprocess_runner,
            lyrics_client=LrclibClient(base_url=cfg.lrclib_base),
            device=cfg.whisperx_device or whisperx_device_for(device),
            model=cfg.asr_model,
            sync_mode=cfg.sync_mode,
            ytdlp_bin=cfg.ytdlp_bin,
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

    # Reclaim AGED-OUT orphaned scratch for the whole process lifetime (#469). A retryable failure on
    # the final attempt is terminal but the worker cannot see it, so _run_job preserves that scratch;
    # this periodic, age-bounded sweep is the only thing that reclaims it. It NEVER touches a live job:
    # the 6h age bound means a scratch being actively written cannot qualify, so it is safe even though
    # docker-compose mounts one media volume across several workers. `_active` gives each pass the
    # CURRENT worker's in-flight ids as a second guard (a legitimately-long cook of THIS worker). The
    # task lives for the process, above the reconnect loop; the live-set closure reads whichever client
    # is connected right now, or an empty set between connections.
    _current: dict[str, WorkerClient | None] = {"client": None}

    def _active() -> frozenset[str]:
        c = _current["client"]
        return frozenset(c.state.running) if c is not None else frozenset()

    # Lives for the whole process — the reconnect loop below never exits, so there is no teardown path
    # to cancel it from, and a leaked reference would only pin it. Fire-and-forget on purpose.
    asyncio.ensure_future(_scratch_sweep_loop(cfg.media_dir, _active))

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
                # job (issue #132). Cancelled in the finally, before the next reconnect builds a fresh
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
            # already closed: an orphaned cook loses its result AND races the core's reaper, which has
            # requeued the same job — cancelling is what stops the duplicate GPU work for one song.
            if client is not None:
                await client.drain(cancel=True)


if __name__ == "__main__":
    asyncio.run(_run_forever())
