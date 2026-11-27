"""#1176: a download has a slot of its own beside the separations, so it never waits behind one."""

from __future__ import annotations

import asyncio
import dataclasses

from encore_worker.protocol import frames as f
from tests.test_client import CFG, FakeSocket, Gate, Session, assign, client

CAPS = frozenset({"fetch:ytdlp", "align", "stems"})
TWO = dataclasses.replace(CFG, concurrency=2)


async def test_hello_names_a_fetch_lane_beside_the_compute_lane() -> None:
    sock = FakeSocket()
    async with Session(client(sock, caps=CAPS, cfg=TWO), sock):
        pass
    hello = sock.first("worker:hello")
    assert hello["lanes"] == {"fetch": 1, "compute": 2}
    assert hello["concurrency"] == 2, "an older core still reads the compute count from here"


async def test_a_fetch_is_taken_while_every_compute_slot_is_busy_and_a_second_is_not() -> None:
    gate = Gate()
    sock = FakeSocket([assign("s1", "align"), assign("f1", "fetch")])
    c = client(sock, run_job=gate, caps=CAPS)
    async with Session(c, sock):
        await asyncio.wait_for(gate.entered.wait(), 5.0)
        assert [s["jobId"] for s in sock.sent if s.get("type") == "job:accept"] == ["s1", "f1"]
        assert c._can_accept(f.Assign(job_id="s2", media_id="m2", action="align")) == (False, "no free slots")
        second = f.Assign(job_id="f2", media_id="m2", action="fetch")
        assert c._can_accept(second) == (False, "no free slots"), "both lanes are full"
        await c.heartbeat()
        beat = [s for s in sock.sent if s.get("type") == "worker:heartbeat"][-1]
        assert beat["lanesFree"] == {"fetch": 0, "compute": 0}
        assert beat["slotsFree"] == 0, "the compute lane, for a core that reads only this"
        # The download does not share the separation's cores, so it is not counted when they are split.
        assert c.running_jobs() == frozenset({"s1"})
        gate.release.set()


async def test_an_older_cores_second_fetch_takes_a_free_compute_slot_and_counts_there() -> None:
    """An older core counts every job against `concurrency`, so at 2 it sends two downloads at once. Refusing
    the second had it re-offered every dispatch tick until the first ended (#1396 review); it runs instead."""
    gate = Gate()
    sock = FakeSocket([assign("f1", "fetch"), assign("f2", "fetch")])
    c = client(sock, run_job=gate, caps=CAPS, cfg=TWO)
    async with Session(c, sock):
        await asyncio.wait_for(gate.entered.wait(), 5.0)
        assert [s["jobId"] for s in sock.sent if s.get("type") == "job:accept"] == ["f1", "f2"]
        assert not [s for s in sock.sent if s.get("type") == "job:reject"]
        await c.heartbeat()
        beat = [s for s in sock.sent if s.get("type") == "worker:heartbeat"][-1]
        assert beat["lanesFree"] == {"fetch": 0, "compute": 1}
        assert beat["slotsFree"] == 1, "the old core sees one slot left of its two, as before lanes"
        assert c.running_jobs() == frozenset({"f2"}), "a download in a compute slot counts there"
        gate.release.set()


async def test_a_free_fetch_slot_is_not_offered_as_a_compute_slot() -> None:
    gate = Gate()
    sock = FakeSocket([assign("s1", "align")])
    c = client(sock, run_job=gate, caps=CAPS)
    async with Session(c, sock):
        await asyncio.wait_for(gate.entered.wait(), 5.0)
        await c.heartbeat()
        beat = [s for s in sock.sent if s.get("type") == "worker:heartbeat"][-1]
        assert (beat["slotsFree"], beat["lanesFree"]) == (0, {"fetch": 1, "compute": 0})
        gate.release.set()
