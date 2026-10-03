"""Per-job scratch: where it lives, and the TWO mechanisms that reclaim it.

SCRATCH IS BIG: every job decodes its source to WAV and every separation writes raw stems beside it, hundreds
of megabytes a song, and nothing used to delete any of it. TWO MECHANISMS, because neither alone is
sufficient: `release()` at the END OF A RUN, when the outcome is known, and `sweep()` PERIODICALLY, for the
outcomes no run-end hook can see — a crash, and retries exhausting. Releasing on every run is the obvious
design and silently breaks resumption, every checkpointed step returning PATHS INTO SCRATCH rather than bytes
(XW-08).

The outcome table, and why the sweep is safe on a shared volume (`MIN_AGE_SEC` against a directory's NEWEST
file, rather than a registry of "my" job ids): `docs/arch/05-worker.md` §4.
"""

from __future__ import annotations

import os
import shutil
import time
from dataclasses import dataclass

#: Seconds a job directory must sit untouched before `sweep` may remove it. Generous on purpose: too early
#: destroys a live job's work, too late costs some disk for an hour.
MIN_AGE_SEC = 3600.0

#: The one storage class this touches, deliberately not env-overridable (docs/arch/05-worker.md §4).
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

    Called ONLY for an outcome that cannot resume (docs/arch/05-worker.md §4), and never raises: the sweep
    gets later whatever this could not remove.
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

    Idempotent and safe to run on a timer. `now` is injectable so a test does not have to wait an hour. Age
    is the directory's NEWEST file's mtime, not its own — see `_newest_mtime`.
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

    Walks rather than stat-ing the directory, whose own mtime changes only when an entry is added or removed:
    a job writing steadily into an existing file would look untouched and be swept out from under itself.
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
    """A file vanishing mid-walk is NORMAL here — another sweep or a job's own cleanup races this one — and
    skipping the entry beats a measurement crashing a reclaim."""

    def __enter__(self) -> None:
        return None

    def __exit__(self, exc_type: object, exc: object, tb: object) -> bool:
        return isinstance(exc, OSError)
