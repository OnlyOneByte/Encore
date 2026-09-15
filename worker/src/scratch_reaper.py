"""Reclaiming orphaned separation scratch, on its own so it can be read in one sitting.

WHY THIS IS RECLAIMED AT ALL. A retryable failure on the LAST attempt is terminal, but the worker cannot
see that it was the last one — there is no attempt count on the wire. So `_run_job` deliberately PRESERVES
the scratch of a retryable failure in case a retry follows, and for the terminal case this sweep is the
only thing that ever removes it. Without it an exhausted-retry job leaks its work dir until the worker
restarts.

WHY IT IS SAFE ON A SHARED VOLUME. Two knobs, and both matter. It runs PERIODICALLY, so a long-lived
worker reclaims without needing a restart. And it only removes a directory whose NEWEST file is older
than `SCRATCH_MIN_AGE_SEC` — a live job writes continuously, so its scratch is always fresher than the
threshold and cannot be swept even by a different worker sharing the media volume.

EXTRACTED FROM `dial_home.py`, which was 884 lines doing six jobs: the WS protocol loop, this reaper,
retry classification, oversubscription warnings, processor construction and the entrypoint. Nothing here
touches the socket or the protocol, and the split is what lets that be obvious rather than asserted.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import time
from collections.abc import Callable

#: Pin the periodic sweep task. Without a strong reference the event loop may garbage-collect a bare
#: `create_task`, and the worker would stop reclaiming orphaned scratch with nothing in the log.
_SCRATCH_SWEEPS: set[asyncio.Task] = set()

SCRATCH_SWEEP_INTERVAL_SEC = 1800.0  # every 30 min
SCRATCH_MIN_AGE_SEC = 6 * 3600.0  # only reclaim scratch untouched for 6h — far longer than any process


def _newest_mtime(path: str) -> float:
    """The most-recent mtime anywhere under `path` (the dir itself and every descendant).

    A separation writes ONE large file deep inside work/<jobId> over many minutes; that does not bump
    the top dir's own mtime, so testing only os.path.getmtime(path) would call an actively-written
    scratch "old" and sweep it. Walking for the newest mtime is what makes the age bound actually
    track liveness. Best-effort: a file that vanishes mid-walk (a process cleaning up) is skipped."""
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
    leaks its decoded WAV + separated stems — the pipeline's biggest intermediates — forever.

    TWO guards keep it safe on a media volume SHARED by several workers (docker-compose mounts the
    same volume into core and every worker), where "orphan for THIS worker" is not "orphan for the
    fleet" — an early version passed frozenset() and would delete another worker's in-flight scratch:

      * AGE. Only a dir whose NEWEST file is older than `min_age_sec` (default 6h, far longer than any
        process) is removed. A live job writes its scratch continuously, so it is always fresher than the
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
    """Periodically reclaim aged-out orphaned scratch for the process's whole lifetime.

    A one-shot startup sweep left a long-lived worker (restart: unless-stopped can mean weeks of
    uptime) accumulating one orphaned scratch dir per exhausted-retry job until it restarted. Running
    on an interval closes that. `live_job_ids` is a callable so each pass reads the CURRENT in-flight
    set rather than a snapshot taken when the loop started.

    SWEEPS BEFORE IT SLEEPS. The interval used to come first, which quietly removed the startup sweep
    that three separate comments in this module still promised: a worker restarted to clear a stuck box
    reclaimed nothing for the first `SCRATCH_SWEEP_INTERVAL_SEC`, and a worker restarted again inside
    that window reclaimed nothing at all — the exact leak the reaper exists to stop, at exactly the
    moment an operator is trying to fix it. Doing the pass first makes "runs at startup" true again while
    keeping the interval behaviour for the rest of the process's life.

    ONE PASS CANNOT KILL THE LOOP. The body is guarded because it is filesystem work on a volume this
    worker may share: `sweep_orphaned_scratch` only tolerates a missing `work/`, so a PermissionError or
    an ENOSPC-adjacent error on one entry used to escape, end the task, and leave the process with no
    reaper and nothing in the log saying so — the silent-failure shape `_on_detached_drain_done` was
    written to close. A failed pass is logged and the next one still runs.
    """
    while True:
        try:
            reclaimed = sweep_orphaned_scratch(media_dir, live_job_ids())
            if reclaimed:
                print(f"[worker] reclaimed {len(reclaimed)} aged scratch dir(s): {reclaimed}", flush=True)
        except Exception as exc:  # noqa: BLE001 — tidying must never end the reaper or the worker
            print(f"[worker] scratch sweep failed ({exc!r}) — retrying next interval", flush=True)
        await asyncio.sleep(SCRATCH_SWEEP_INTERVAL_SEC)


def _on_scratch_sweep_done(task: asyncio.Task) -> None:
    """Log a reaper that ended, for the same reason `_on_detached_drain_done` exists.

    `_scratch_sweep_loop` is meant to outlive every job, so its task finishing at all is news: without
    this the only trace would be asyncio's "Task exception was never retrieved" at GC, and a worker
    silently accumulating scratch for the rest of its uptime. CancelledError is expected at shutdown and
    stays quiet.
    """
    _SCRATCH_SWEEPS.discard(task)
    if task.cancelled():
        return
    exc = task.exception()
    print(
        f"[worker] scratch sweep loop ENDED unexpectedly ({exc!r}) — orphaned scratch will accumulate",
        flush=True,
    )
