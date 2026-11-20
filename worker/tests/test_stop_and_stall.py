"""A job the core took back really stops, and a hung tool fails fast — through the real `__main__._run`,
`_stop` and `cli.run`, with only the step faked. Real `sh` children, so this file runs no models but does
spawn processes; each test is bounded in seconds.
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

import pytest

from encore_worker import __main__ as wm
from encore_worker.adapters import cli
from encore_worker.protocol import frames as f
from encore_worker.steps.records import JobRef
from encore_worker.transport.client import Client
from tests.test_client import CFG, LiveSocket, Session, assign, client


def _alive(pid: int) -> bool:
    """Running, as opposed to gone or a zombie (an orphan killed under a PID 1 that never reaps stays one)."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    status = Path(f"/proc/{pid}/status")
    return not (status.exists() and "\nState:\tZ" in status.read_text())


def _pids(pidfile: Path) -> list[int]:
    return [int(x) for x in pidfile.read_text().split()] if pidfile.exists() else []


def _real_run(c: Client, monkeypatch: pytest.MonkeyPatch, step: object) -> None:
    """Wire the client to the composition root's own `_run` and `_stop`; only `_dispatch` is `step`."""
    monkeypatch.setattr(wm, "_dispatch", step)
    c.run_job = lambda a: wm._run(a, CFG, None, None, c, None)  # type: ignore[arg-type]
    c.stop_job = wm._stop


async def test_a_cancel_kills_the_childs_group_and_holds_the_slot_until_it_is_gone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The review's live probe, kept: `_stop` must cancel the token, wait for the children, and find the token
    `_run` left for it. Each of those, removed, frees the slot while a child still runs."""
    pidfile = tmp_path / "pids"
    # A child and two grandchildren in its group, one of which ignores SIGTERM.
    hang = (
        f"echo $$ >> {pidfile}; sleep 300 & echo $! >> {pidfile}; "
        f"(trap '' TERM; sleep 300) & echo $! >> {pidfile}; wait"
    )

    async def step(a: f.Assign, *_: object) -> f.Complete:
        await asyncio.to_thread(cli.run, ["sh", "-c", hang if a.job_id == "j1" else "true"], timeout_sec=600)
        return f.Complete(worker_id="w1", job_id=a.job_id, media_uri="x")

    sock = LiveSocket([assign("j1", "stems")])
    c = client(sock)
    _real_run(c, monkeypatch, step)
    async with Session(c, sock):
        for _ in range(250):
            if len(_pids(pidfile)) == 3:
                break
            await asyncio.sleep(0.02)
        kids = _pids(pidfile)
        assert len(kids) == 3 and all(_alive(p) for p in kids)
        await sock.feed({"type": "job:cancel", "jobId": "j1"})
        await sock.feed(assign("j2", "stems"))  # refused: j1's children are still alive
        freed_with_children: list[int] | None = None
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if "j1" not in c._running:
                freed_with_children = [p for p in kids if _alive(p)]
                break
            await asyncio.sleep(0.005)
        await sock.feed(assign("j3", "stems"))  # the slot is back
        await c.drain(timeout_sec=5.0)
        await sock.later.put(None)

    assert freed_with_children == [], "the slot was freed while a child of the cancelled job ran"
    assert [s["jobId"] for s in sock.sent if s.get("type") == "job:reject"] == ["j2"]
    assert "j3" in [s["jobId"] for s in sock.sent if s.get("type") == "job:accept"]
    assert "j1" not in wm._tokens, "the token went with the job"


async def test_a_cancelled_in_process_separation_keeps_its_slot_until_it_returns(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The zoo runs in the worker's own process: there is nothing to kill, so the slot must wait for it. A
    freed slot let the requeued job start a second separation on top of the first."""
    finished: list[float] = []

    def zoo_separation() -> None:
        time.sleep(2.0)
        finished.append(time.monotonic())

    async def step(a: f.Assign, *_: object) -> f.Complete:
        await asyncio.to_thread(cli.in_job, zoo_separation)
        return f.Complete(worker_id="w1", job_id=a.job_id, media_uri="x")

    sock = LiveSocket([assign("j1", "stems")])
    c = client(sock)
    _real_run(c, monkeypatch, step)
    async with Session(c, sock):
        await asyncio.sleep(0.3)
        cancelled = time.monotonic()
        await sock.feed({"type": "job:cancel", "jobId": "j1"})
        await asyncio.sleep(1.0)
        assert "j1" in c._running, "freed at once, with the separation still running"
        await c.drain(timeout_sec=5.0)
        freed = time.monotonic()
        await sock.later.put(None)

    assert finished and freed >= finished[0] >= cancelled


async def test_a_hung_download_fails_the_job_within_a_minute_not_three_hours(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The proposal's promise, end to end through the transport. A fake yt-dlp prints its banner and hangs
    with its output open. With the idle allowance shrunk to 1 s (60 s in production), the job is reported
    failed, NOT retryable, in seconds — so core tells the room at once instead of after two more hangs."""
    fake = tmp_path / "yt-dlp"
    fake.write_text("#!/bin/sh\necho '[youtube] Extracting URL'\nsleep 300\n")
    fake.chmod(0o755)
    monkeypatch.setattr(cli, "YTDLP_IDLE_SEC", 1.0)

    async def step(a: f.Assign, job: JobRef, *_: object) -> f.Complete:
        path = await asyncio.to_thread(cli.YtDlpAudio(str(fake)).fetch, "https://x.test/v", str(tmp_path))
        return f.Complete(worker_id="w1", job_id=a.job_id, media_uri=path)

    sock = LiveSocket([assign("j1", "fetch")])
    c = client(sock, caps=frozenset({"fetch"}))
    _real_run(c, monkeypatch, step)
    started = time.monotonic()
    async with Session(c, sock):
        await c.drain(timeout_sec=10.0)
        took = time.monotonic() - started
        await sock.later.put(None)

    failed = [s for s in sock.sent if s.get("type") == "job:failed"]
    assert len(failed) == 1 and failed[0]["retryable"] is False, sock.sent
    assert "stalled" in str(failed[0]["error"])
    assert took < 4.0, f"{took:.1f}s"
