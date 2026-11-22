"""A job the core took back really stops, and a hung tool fails fast — through the real `__main__._run`,
`_stop` and `cli.run`, with only the step faked. Real `sh` children, so this file runs no models but does
spawn processes; each test is bounded in seconds.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import replace
from pathlib import Path

import pytest

from encore_worker import __main__ as wm
from encore_worker.__main__ import _ReporterFor
from encore_worker.adapters import cli
from encore_worker.adapters.separate import Stems
from encore_worker.artifacts.local import LocalArtifactStore, Roots
from encore_worker.host.config import Config
from encore_worker.protocol import frames as f
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.records import JobRef
from encore_worker.steps.separate_steps import SeparateStepsImpl
from encore_worker.transport.client import Client
from encore_worker.workflows import durable
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


def _separate_steps(c: Client, separator: object, root: Path) -> SeparateStepsImpl:
    """The real stems steps around `separator`, reporting through `c` as the composition root wires them."""
    reporter = _ReporterFor(c)
    return SeparateStepsImpl(
        config=CFG,
        audio=AlignStepsImpl(config=CFG, adapters=Adapters(), reporter=reporter),
        reporter=reporter,
        store=LocalArtifactStore(Roots.under(str(root / "media"))),
        separator=separator,  # type: ignore[arg-type]
    )


def _real_run(c: Client, monkeypatch: pytest.MonkeyPatch, step: object, config: Config = CFG) -> None:
    """Wire the client to the composition root's own `_run` and `_stop`; only `_dispatch` is `step`."""
    monkeypatch.setattr(wm, "_dispatch", step)
    c.run_job = lambda a: wm._run(a, config, None, None, c, None)  # type: ignore[arg-type]
    c.stop_job = wm._stop


async def test_a_cancel_kills_the_childs_group_and_holds_the_slot_until_it_is_gone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A live probe, kept: `_stop` must cancel the token, wait for the children, and find the token
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
    assert "j1" not in cli.tokens, "the token went with the job"


async def test_a_cancelled_in_process_separation_keeps_its_slot_until_it_returns(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The zoo runs in the worker's own process: there is nothing to kill, so the slot must wait for it. A
    freed slot let the requeued job start a second separation on top of the first."""
    finished: list[float] = []

    class Zoo:
        """An in-process separator: no `cli.run` child, only the worker's own thread."""

        name = "audiosep:test"

        def separate(self, input_wav: str, out_dir: str, *, on_progress: object = None) -> Stems:
            time.sleep(2.0)
            finished.append(time.monotonic())
            return Stems(instrumental_path=f"{out_dir}/no_vocals.wav", engine=self.name)

    sock = LiveSocket([assign("j1", "stems")])
    c = client(sock)

    async def step(a: f.Assign, job: JobRef, *_: object) -> f.Complete:
        # The REAL step, so the line that counts the separation on the token is what is under test.
        await _separate_steps(c, Zoo(), tmp_path).separate(replace(job, media_dir=str(tmp_path)), "/dev/null")
        return f.Complete(worker_id="w1", job_id=a.job_id, media_uri="x")

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


async def test_the_keepalive_lets_the_lease_lapse_at_the_configured_ceiling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ceiling as `_run` wires it: past `job_ceiling_sec` (6 h in production; 0.3 s here, with a 0.05 s
    beat) the keepalive goes quiet while the job runs on, so core's reaper can take what nothing can kill."""
    release = asyncio.Event()

    async def step(a: f.Assign, *_: object) -> f.Complete:
        await release.wait()
        return f.Complete(worker_id="w1", job_id=a.job_id, media_uri="x")

    sock = LiveSocket([assign("j1", "stems")])
    c = client(sock)
    _real_run(c, monkeypatch, step, replace(CFG, keepalive_sec=0.05, job_ceiling_sec=0.3))

    def beats() -> int:
        return sum(1 for s in sock.sent if s.get("type") == "job:progress")

    async with Session(c, sock):
        await asyncio.sleep(0.6)
        at_ceiling = beats()
        await asyncio.sleep(0.4)
        after = beats()
        release.set()
        await c.drain(timeout_sec=5.0)
        await sock.later.put(None)

    assert 1 <= at_ceiling <= 6, at_ceiling
    assert after == at_ceiling, "the keepalive went on past its ceiling"


def test_the_ceiling_is_a_six_hour_backstop_the_operator_can_move() -> None:
    assert Config().job_ceiling_sec == 6 * 3600.0
    assert Config.from_env({"ENCORE_JOB_CEILING_SEC": "900"}).job_ceiling_sec == 900.0


async def test_a_stop_kills_the_children_even_when_the_workflow_cannot_be_cancelled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A DBOS that refuses the cancel (gone, or unreachable) must not leave the job's children running: found
    when a test that left real DBOS registered made `_stop` raise before it reached the token."""

    async def refuse(job_id: str) -> None:
        raise RuntimeError("DBOS is not launched")

    monkeypatch.setattr(durable, "cancel", refuse)
    token = cli.CancelToken()
    monkeypatch.setitem(cli.tokens, "j1", token)
    child = asyncio.create_task(asyncio.to_thread(cli.run, ["sh", "-c", "sleep 30"], cancel=token))
    await asyncio.sleep(0.3)
    started = time.monotonic()
    await asyncio.wait_for(wm._stop("j1"), 5.0)
    with pytest.raises(cli.ToolFailed, match="cancelled"):
        await asyncio.wait_for(child, 5.0)
    assert time.monotonic() - started < 3.0
