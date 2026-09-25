"""Per-job scratch: where it lives, and the TWO mechanisms that reclaim it.

WHY SCRATCH IS BIG. Every job decodes its source to WAV and every separation writes raw stems beside it —
hundreds of megabytes per song, under `work/{job_id}/`. Nothing in the worker deleted any of it, so a library
import filled the media volume and the failure arrived as "no space left on device" in an unrelated job.

TWO MECHANISMS, because neither alone is sufficient:

  1. `release()` at the END OF A RUN, when the outcome is known. Immediate, and covers the common case.
  2. `sweep()` PERIODICALLY, for the outcomes no run-end hook can see.

WHY NOT JUST DELETE AT THE END OF EVERY RUN — the obvious design, and it silently breaks resumption.

Every checkpointed step returns PATHS INTO SCRATCH, never bytes: `separate()` checkpoints an `AudioRef`
pointing at `work/{job_id}/…/no_vocals.wav`. When the core requeues a job, DBOS resumes that workflow from
its last checkpoint and hands the next step that path. Delete the scratch and resumption replays into missing
files — and it is the EXPENSIVE case, a 45-minute separation whose output no longer exists. Durability made
this stricter rather than looser: the old worker preserved scratch in case a retry re-ran from the top; this
one needs it because a retry deliberately does NOT re-run.

So the outcome decides:

  * published            -> RELEASE. The artifacts are in the store; nothing will resume.
  * non-retryable failure-> RELEASE. No retry is coming, by definition.
  * retryable failure    -> KEEP. A requeue resumes from a checkpoint holding these paths.
  * lost lease           -> KEEP. The job may come back to this worker under the same workflow id.
  * crash mid-job        -> nothing runs to decide; `sweep()` is the only thing that ever reclaims it.

WHY THE SWEEP IS STILL NEEDED even with `release()`. Two leaks it cannot reach. A crash leaves no code to run
the hook. And retries EXHAUSTING is terminal, but the worker cannot see that it was the last attempt — there
is no attempt count on the wire — so a retryable failure's scratch is preserved by a worker that will never
be asked again.

WHY THE SWEEP IS SAFE ON A SHARED VOLUME. It only removes a directory whose NEWEST file is older than
`MIN_AGE_SEC`. A live job writes continuously, so its scratch is always fresher than the threshold and cannot
be swept — even by a DIFFERENT worker sharing the media volume, which is the case that makes an age check the
right test rather than a registry of "my" job ids.
"""

from __future__ import annotations

import os
import shutil
import time
from dataclasses import dataclass

#: A directory untouched for this long is not in use. Generous on purpose: the cost of sweeping too early is
#: destroying a live job's work, and the cost of sweeping too late is some disk for an hour.
MIN_AGE_SEC = 3600.0

#: `work` is the only class this touches, and it is deliberately NOT env-overridable — mirroring core, which
#: keeps scratch next to the work rather than on whichever disk a class was pointed at.
WORK = "work"


@dataclass(frozen=True, slots=True)
class Reclaimed:
    """What one sweep did. Returned rather than logged so a caller decides whether it is worth saying."""

    removed: tuple[str, ...] = ()
    kept_live: int = 0
    bytes_freed: int = 0

    @property
    def any_removed(self) -> bool:
        return bool(self.removed)


def work_root(media_dir: str) -> str:
    return os.path.join(media_dir, WORK)


def job_dir(media_dir: str, job_id: str) -> str:
    return os.path.join(work_root(media_dir), job_id)


def release(media_dir: str, job_id: str) -> int:
    """Delete one job's scratch now. Returns the bytes freed, 0 when there was nothing.

    Called ONLY for an outcome that cannot resume — see the module docstring for the table. Never raises: a
    job that finished successfully must not be reported as failed because a directory could not be removed,
    and the sweep will get it later anyway.
    """
    path = job_dir(media_dir, job_id)
    if not os.path.isdir(path):
        return 0
    size = _size_of(path)
    try:
        shutil.rmtree(path)
    except OSError:
        # A file held open by a lingering subprocess, or a permission problem on a shared volume. The sweep
        # retries it once the directory goes quiet, so this is a deferral rather than a loss.
        return 0
    return size


def sweep(media_dir: str, *, min_age_sec: float = MIN_AGE_SEC, now: float | None = None) -> Reclaimed:
    """Reclaim every job directory that has been quiet for `min_age_sec`.

    Idempotent and safe to run on a timer. `now` is injectable so a test does not have to wait an hour.

    A directory's age is its NEWEST file's mtime, not the directory's own: a directory's mtime only changes
    when an entry is added or removed, so a job writing steadily into an existing file would look untouched
    and be swept out from under itself.
    """
    root = work_root(media_dir)
    if not os.path.isdir(root):
        return Reclaimed()

    at = time.time() if now is None else now
    removed: list[str] = []
    freed = 0
    live = 0
    for name in sorted(os.listdir(root)):
        path = os.path.join(root, name)
        if not os.path.isdir(path):
            continue
        touched = _newest_mtime(path)
        if touched is None:
            # An empty directory: nothing to lose, and it is still litter.
            with _ignoring_oserror():
                os.rmdir(path)
                removed.append(name)
            continue
        if at - touched < min_age_sec:
            live += 1
            continue
        size = _size_of(path)
        try:
            shutil.rmtree(path)
        except OSError:
            continue  # still held; try again next sweep
        removed.append(name)
        freed += size
    return Reclaimed(removed=tuple(removed), kept_live=live, bytes_freed=freed)


def _newest_mtime(path: str) -> float | None:
    """The most recent mtime anywhere under `path`, or None when it holds no files.

    Walks rather than stat-ing the directory: see `sweep` for why the directory's own mtime is the wrong
    signal.
    """
    newest: float | None = None
    for root, _dirs, files in os.walk(path):
        for name in files:
            with _ignoring_oserror():
                seen = os.stat(os.path.join(root, name)).st_mtime
                newest = seen if newest is None else max(newest, seen)
    return newest


def _size_of(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            with _ignoring_oserror():
                total += os.stat(os.path.join(root, name)).st_size
    return total


class _ignoring_oserror:
    """A file vanishing mid-walk is NORMAL here: another worker's sweep, or a job's own cleanup, races this
    one. Skipping the entry is right — the alternative is a measurement crashing a reclaim."""

    def __enter__(self) -> None:
        return None

    def __exit__(self, exc_type: object, exc: object, tb: object) -> bool:
        return isinstance(exc, OSError)
