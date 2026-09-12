"""Cancelling a cook must kill the CLI's children too, not just the CLI.

Every subprocess the worker shells out to — yt-dlp, ffmpeg, demucs — goes through
`subprocess_runner`. Demucs with `-j N` forks N worker processes each holding a model (~2 GiB), so a
`proc.kill()` that signals only the parent left all of them alive and unreachable: a cancelled cook
kept its memory forever, and a box with ENCORE_WORKER_CONCURRENCY>1 OOMed after a few cancels.

This drives a real process tree rather than a fake runner, because the defect is entirely in how the
process is spawned and signalled — a mock cannot express it.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.separation.demucs import subprocess_runner  # noqa: E402

# A parent that forks a long-lived child and prints the child's pid, then sleeps. Mirrors demucs -j:
# the pid we launch is not the pid holding the memory.
PARENT = (
    "import os,sys,time\n"
    "pid=os.fork()\n"
    "if pid==0:\n"
    "    time.sleep(300)\n"
    "    os._exit(0)\n"
    "print(pid, flush=True)\n"
    "time.sleep(300)\n"
)


def alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@pytest.mark.skipif(not hasattr(os, "fork"), reason="needs POSIX fork/process groups")
async def test_cancelling_the_runner_kills_the_grandchild_too():
    child_pid: int | None = None

    async def drive() -> None:
        nonlocal child_pid
        async for line in subprocess_runner([sys.executable, "-c", PARENT]):
            child_pid = int(line.strip())
            break  # abandon the generator mid-stream — this is what a cancelled cook does

    task = asyncio.create_task(drive())
    await task

    assert child_pid is not None, "the parent never reported its forked child"
    # Give the group kill a moment to land.
    for _ in range(50):
        if not alive(child_pid):
            break
        await asyncio.sleep(0.05)

    assert not alive(child_pid), (
        f"grandchild {child_pid} survived cancellation — the kill signalled only the direct child, "
        "so demucs -j workers would leak at ~2 GiB each"
    )
