"""Scratch reclamation: the run-end release, the periodic sweep, and the case that must NOT be reclaimed.

THE CENTRAL PROPERTY, and the one an "always delete at the end" design gets wrong: a RETRYABLE failure's
scratch must survive. Every checkpointed step returns paths into scratch, so a requeue resumes from a
checkpoint holding them — and it is the expensive case, a 45-minute separation whose output would be gone.
Several tests below exist only to pin that asymmetry.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from encore_worker.artifacts import scratch


def a_job(media: Path, job_id: str, *, files: int = 2, size: int = 1024) -> Path:
    """A scratch directory that looks like a real one: nested, with bytes in it."""
    path = media / "work" / job_id
    (path / "demucs" / "htdemucs").mkdir(parents=True, exist_ok=True)
    for i in range(files):
        (path / "demucs" / "htdemucs" / f"stem{i}.wav").write_bytes(b"x" * size)
    (path / "input.wav").write_bytes(b"y" * size)
    return path


def age(path: Path, seconds: float) -> None:
    """Backdate every file so the directory reads as quiet. Applied to FILES, because that is what the sweep
    measures — see `test_a_directory_is_aged_by_its_newest_file`."""
    old = time.time() - seconds
    for root, _dirs, files in os.walk(path):
        for name in files:
            os.utime(os.path.join(root, name), (old, old))


# ── paths ────────────────────────────────────────────────────────────────────────────────────────


def test_scratch_lives_under_the_work_class(tmp_path: Path) -> None:
    """`work/` and not `derived/`, because scratch is transient: core's retention sweeps `derived/` by ref and
    would never enumerate these, so a ref pointing here is a file nothing can clean up."""
    assert scratch.job_dir(str(tmp_path), "j1") == str(tmp_path / "work" / "j1")


# ── release: the run-end hook ─────────────────────────────────────────────────────────────────────


def test_release_removes_one_jobs_scratch(tmp_path: Path) -> None:
    path = a_job(tmp_path, "j1")
    freed = scratch.release(str(tmp_path), "j1")
    assert not path.exists()
    assert freed > 0


def test_release_leaves_other_jobs_alone(tmp_path: Path) -> None:
    """Concurrency > 1 means a sibling job is mid-separation while this one ends."""
    a_job(tmp_path, "j1")
    other = a_job(tmp_path, "j2")
    scratch.release(str(tmp_path), "j1")
    assert other.exists()


def test_release_is_a_noop_for_a_job_with_no_scratch(tmp_path: Path) -> None:
    """A job that failed before writing anything, or one already released. Must not raise — it runs in a
    `finally`, where an exception would turn a finished job into a failed one."""
    assert scratch.release(str(tmp_path), "never-ran") == 0


def test_release_does_not_raise_when_the_directory_cannot_be_removed(tmp_path: Path) -> None:
    """A file held open by a lingering subprocess, or a permission problem on a shared volume. Deferring to
    the sweep is right; failing the job is not."""
    a_job(tmp_path, "j1")
    import unittest.mock

    with unittest.mock.patch("shutil.rmtree", side_effect=OSError("busy")):
        assert scratch.release(str(tmp_path), "j1") == 0
    assert (tmp_path / "work" / "j1").exists(), "left for the sweep rather than half-removed"


# ── sweep: the periodic reclaim ───────────────────────────────────────────────────────────────────


def test_sweep_removes_a_quiet_directory(tmp_path: Path) -> None:
    """The crash case: no code ran to release it, so this is the only thing that ever will."""
    path = a_job(tmp_path, "orphan")
    age(path, scratch.MIN_AGE_SEC * 2)
    got = scratch.sweep(str(tmp_path))
    assert got.removed == ("orphan",)
    assert not path.exists()
    assert got.bytes_freed > 0


def test_sweep_never_touches_a_live_directory(tmp_path: Path) -> None:
    """THE property that makes this safe on a volume shared with another worker. A live job writes
    continuously, so its scratch is always fresher than the threshold — which is why an age check is the right
    test rather than a registry of "my" job ids, blind to the other worker's orphans."""
    live = a_job(tmp_path, "running-right-now")
    got = scratch.sweep(str(tmp_path))
    assert got.removed == ()
    assert got.kept_live == 1
    assert live.exists()


def test_a_directory_is_aged_by_its_newest_file(tmp_path: Path) -> None:
    """NOT by the directory's own mtime, which only changes when an entry is added or removed. A job writing
    steadily into an existing file would look untouched and be swept out from under itself.
    """
    path = a_job(tmp_path, "j1")
    age(path, scratch.MIN_AGE_SEC * 2)
    # One fresh write, deep inside — exactly what a long separation looks like.
    (path / "demucs" / "htdemucs" / "stem0.wav").write_bytes(b"new bytes")

    got = scratch.sweep(str(tmp_path))
    assert got.removed == (), "a directory with one fresh file is still live"
    assert path.exists()


def test_sweep_removes_an_empty_directory(tmp_path: Path) -> None:
    """Litter with nothing to lose. It has no files, so it has no age — and that must not read as
    "live forever"."""
    (tmp_path / "work" / "empty").mkdir(parents=True)
    got = scratch.sweep(str(tmp_path))
    assert got.removed == ("empty",)


def test_sweep_is_a_noop_with_no_work_directory(tmp_path: Path) -> None:
    """A worker that has never run a job, or a fresh volume."""
    assert scratch.sweep(str(tmp_path)) == scratch.Reclaimed()


def test_sweep_ignores_stray_files_at_the_work_root(tmp_path: Path) -> None:
    """Only directories are job scratch. Deleting an unexpected file would be destroying something this module
    does not understand."""
    (tmp_path / "work").mkdir()
    stray = tmp_path / "work" / "notes.txt"
    stray.write_text("something an operator left")
    scratch.sweep(str(tmp_path))
    assert stray.exists()


def test_sweep_is_idempotent(tmp_path: Path) -> None:
    path = a_job(tmp_path, "j1")
    age(path, scratch.MIN_AGE_SEC * 2)
    first = scratch.sweep(str(tmp_path))
    second = scratch.sweep(str(tmp_path))
    assert first.removed == ("j1",)
    assert second.removed == ()


def test_the_threshold_is_injectable(tmp_path: Path) -> None:
    """So a test does not have to wait an hour, and so an operator could tighten it on a small disk."""
    path = a_job(tmp_path, "j1")
    age(path, 10.0)
    assert scratch.sweep(str(tmp_path), min_age_sec=3600.0).removed == ()
    assert scratch.sweep(str(tmp_path), min_age_sec=5.0).removed == ("j1",)
    assert not path.exists()


def test_a_busy_directory_is_retried_next_sweep(tmp_path: Path) -> None:
    """Held open now does not mean held open forever. Skipping and retrying beats reporting a failure nobody
    can act on."""
    path = a_job(tmp_path, "j1")
    age(path, scratch.MIN_AGE_SEC * 2)
    import unittest.mock

    with unittest.mock.patch("shutil.rmtree", side_effect=OSError("busy")):
        assert scratch.sweep(str(tmp_path)).removed == ()
    assert path.exists()
    assert scratch.sweep(str(tmp_path)).removed == ("j1",), "the next sweep gets it"


def test_sweep_reports_what_it_did(tmp_path: Path) -> None:
    """Returned rather than logged, so the caller decides whether it is worth saying — a sweep that removed
    nothing should be silent, and one that freed gigabytes should not be."""
    old = a_job(tmp_path, "old", size=4096)
    age(old, scratch.MIN_AGE_SEC * 2)
    a_job(tmp_path, "live")

    got = scratch.sweep(str(tmp_path))
    assert got.any_removed
    assert got.removed == ("old",)
    assert got.kept_live == 1
    assert got.bytes_freed >= 4096 * 3


# ── the asymmetry the transport enforces ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("resumable", "should_survive"),
    [
        (True, True),  # retryable failure: a requeue RESUMES from a checkpoint holding these paths
        (False, False),  # published, or a terminal failure: nothing will resume
    ],
)
def test_the_settled_hook_keeps_scratch_only_when_a_retry_could_resume(
    tmp_path: Path, resumable: bool, should_survive: bool
) -> None:
    """The decision table, exercised through the shape `__main__` wires in.

    This is the asymmetry an "always delete at the end of a run" design gets wrong. Durability made it
    stricter, not looser: the old worker preserved scratch in case a retry re-ran from the top, and this one
    needs it because a retry deliberately does NOT re-run — it replays a checkpoint whose `AudioRef` points
    straight into this directory.
    """
    path = a_job(tmp_path, "j1")

    def settled(job_id: str, is_resumable: bool) -> None:
        if not is_resumable:
            scratch.release(str(tmp_path), job_id)

    settled("j1", resumable)
    assert path.exists() is should_survive
