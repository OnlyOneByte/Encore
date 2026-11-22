"""Which run a requeue gets, and how a run the core took back is cancelled — against a fake DBOS.

Hermetic on purpose: `test_e2e_dbos.py` drives the real thing but needs a DBOS that can migrate its SQLite
file, and the rules here are about which id `durable` picks, not about DBOS.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import threading
import time
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest

from encore_worker.adapters import cli
from encore_worker.steps.records import AlignOutcome, AudioRef, JobRef, PublishedStems
from encore_worker.workflows import durable
from encore_worker.workflows.stems import ABANDONED, StemsOutcome


class FakeDbos:
    """The four calls `durable` makes, over an in-memory status table."""

    def __init__(self, runs: dict[str, tuple[str, object]]) -> None:
        self.runs = dict(runs)
        self.forks: list[tuple[str, str, int]] = []
        self.cancelled: list[str] = []
        self._pinned: str | None = None

    async def get_workflow_status_async(self, workflow_id: str) -> Any:
        if workflow_id not in self.runs:
            return None
        status, output = self.runs[workflow_id]
        return SimpleNamespace(status=status, output=output)

    async def list_workflow_steps_async(self, workflow_id: str) -> list[dict[str, Any]]:
        return []

    async def fork_workflow_async(self, workflow_id: str, start: int) -> None:
        assert self._pinned is not None
        self.forks.append((workflow_id, self._pinned, start))
        self.runs[self._pinned] = ("PENDING", None)

    async def cancel_workflow_async(self, workflow_id: str) -> None:
        self.cancelled.append(workflow_id)
        self.runs[workflow_id] = ("CANCELLED", None)

    @contextlib.contextmanager
    def pin(self, workflow_id: str) -> Iterator[None]:
        self._pinned = workflow_id
        yield
        self._pinned = None

    def workflow(self, *, name: str) -> Any:
        return lambda fn: fn

    async def start_workflow_async(self, flow: Any, job: Any) -> Any:
        """Run the workflow as DBOS runs a fork or a recovered run: on ITS OWN loop, in another thread, in a
        context that never saw the caller's — a plain thread starts with an empty one."""
        done: concurrent.futures.Future[Any] = concurrent.futures.Future()

        def body() -> None:
            try:
                result = asyncio.run(flow(job))
            except BaseException as failed:  # noqa: BLE001 - handed back to the awaiting handle
                if not done.cancelled():
                    done.set_exception(failed)
            else:
                if not done.cancelled():  # the awaiting test gave up: nobody is left to hand it to
                    done.set_result(result)

        threading.Thread(target=body, daemon=True).start()
        return SimpleNamespace(get_result=lambda: asyncio.wrap_future(done))


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeDbos]:
    dbos = pytest.importorskip("dbos", reason="dbos is not installed")
    box = FakeDbos({})
    monkeypatch.setattr(dbos, "DBOS", box)
    monkeypatch.setattr(dbos, "SetWorkflowID", box.pin)
    # `cancel` is a no-op on a box without durable state; these tests are about the box with it.
    monkeypatch.setattr(durable, "_stems_flow", object())
    yield box


def _abandoned() -> StemsOutcome:
    return StemsOutcome(published=None, why=f"{ABANDONED}: revoked", audio=None, profile=None)


async def test_a_requeue_after_a_cancelled_run_forks_it(fake: FakeDbos) -> None:
    """DBOS answers a start under a CANCELLED id with the cancellation, so without a fork a job the core
    took back and then gave to this box again would fail in an instant, every attempt."""
    fake.runs["j1"] = ("CANCELLED", None)
    assert await durable._run_id("j1") == "j1~requeue-1"
    assert [(source, fork) for source, fork, _ in fake.forks] == [("j1", "j1~requeue-1")]


async def test_a_requeue_after_an_abandoned_publication_forks_it(fake: FakeDbos) -> None:
    """The burn: a run that lost ownership at publication finished SUCCESS, and a requeue
    onto this box replayed that refusal until the attempts ran out."""
    fake.runs["j1"] = ("SUCCESS", _abandoned())
    assert await durable._run_id("j1") == "j1~requeue-1"


async def test_a_published_run_is_replayed_not_forked(fake: FakeDbos) -> None:
    published = PublishedStems(instrumental="derived/stems/m1-instrumental.flac")
    fake.runs["j1"] = ("SUCCESS", StemsOutcome(published=published, why="separated", audio=None))
    assert await durable._run_id("j1") == "j1"
    assert fake.forks == []


async def test_cancel_cancels_the_newest_live_run_of_the_job(fake: FakeDbos) -> None:
    fake.runs.update({"j1": ("ERROR", None), "j1~requeue-1": ("PENDING", None)})
    await durable.cancel("j1")
    assert fake.cancelled == ["j1~requeue-1"]


async def test_cancel_leaves_a_settled_run_alone(fake: FakeDbos) -> None:
    fake.runs["j1"] = ("SUCCESS", None)
    await durable.cancel("j1")
    await durable.cancel("never-ran")
    assert fake.cancelled == []


async def test_a_requeue_after_an_abandoned_align_forks_it(fake: FakeDbos) -> None:
    """The same burn as stems', for align (which marks its lost publication `abandoned`). Align's publish is a
    recorded step, so the fork resumes there."""
    fake.runs["j1"] = (
        "SUCCESS",
        AlignOutcome(published=None, why="abandoned before publishing: x", abandoned=True),
    )
    assert await durable._run_id("j1") == "j1~requeue-1"


async def test_a_finished_align_is_replayed_not_forked(fake: FakeDbos) -> None:
    fake.runs["j1"] = ("SUCCESS", AlignOutcome(published=None, why="no lyrics found"))
    assert await durable._run_id("j1") == "j1"


class HangingSteps:
    """Steps whose work is a child that never ends on its own: align's first step, and stems' separation."""

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        if job.job_id.endswith("align"):
            await asyncio.to_thread(cli.run, ["sh", "-c", "sleep 30"])
        return AudioRef(path="/dev/null", duration_sec=1.0)

    async def decode_to_wav(self, job: JobRef, audio: AudioRef) -> str:
        return "/dev/null"

    async def separate(self, job: JobRef, input_wav: str) -> AudioRef:
        await asyncio.to_thread(cli.run, ["sh", "-c", "sleep 30"])
        raise AssertionError("unreachable: the child only ends by being killed")


@pytest.mark.parametrize("flow", ["stems", "align"])
async def test_a_run_dbos_executes_on_its_own_loop_still_carries_the_jobs_token(
    fake: FakeDbos, monkeypatch: pytest.MonkeyPatch, flow: str
) -> None:
    """A fork or a recovered run executes on DBOS's loop, whose context never
    saw `_run` set the token, so a cancel stopped the DBOS row and left the child running. Each workflow body
    binds the job's token itself (`steps.cancel.bind_cancel_token`), with no registration wiring to forget."""
    for name in ("_align_flow", "_stems_flow", "_align_steps_for", "_stems_steps_for"):
        monkeypatch.setattr(durable, name, getattr(durable, name))
    durable.register(
        fake,
        align_steps_for=lambda _job: HangingSteps(),  # type: ignore[arg-type,return-value]
        stems_steps_for=lambda _job: HangingSteps(),  # type: ignore[arg-type,return-value]
    )
    job = JobRef(job_id=f"j-fork-{flow}", media_id="m1", media_dir="/tmp", source_uri="")
    token = cli.CancelToken()
    monkeypatch.setitem(cli.tokens, job.job_id, token)
    asyncio.get_running_loop().call_later(0.5, token.cancel)
    started = time.monotonic()
    with pytest.raises(cli.ToolFailed, match="cancelled"):
        await asyncio.wait_for(durable.stems(job) if flow == "stems" else durable.align(job), 10.0)
    assert time.monotonic() - started < 3.0, "the child was killed by the token, not left to run"
