"""Which run a requeue gets, and how a run the core took back is cancelled — against a fake DBOS.

Hermetic on purpose: `test_e2e_dbos.py` drives the real thing but needs a DBOS that can migrate its SQLite
file, and the rules here are about which id `durable` picks, not about DBOS.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest

from encore_worker.steps.records import PublishedStems
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
    """The #968 review's open High: a run that lost ownership at publication finished SUCCESS, and a requeue
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
