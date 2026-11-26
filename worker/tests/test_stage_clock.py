"""Every attempt reports its seconds per stage (#1357): the step wrappers time the steps they run."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from encore_worker.host.config import Config
from encore_worker.protocol import frames as f
from encore_worker.steps.records import AudioRef, JobRef
from encore_worker.transport import client as transport_client
from encore_worker.workflows import stage_clock
from encore_worker.workflows.dbos_stems import DbosStemsSteps


class Steps:
    """The stems steps, each taking a little time."""

    async def _nap(self, *_: Any) -> Any:
        await asyncio.sleep(0.01)

    acquire_audio = decode_to_wav = separate = probe_silence = measure_profile = publish_stems = _nap


async def test_each_step_a_job_runs_is_one_stage_with_its_seconds() -> None:
    steps = DbosStemsSteps(Steps(), None, job_id="j1")  # type: ignore[arg-type]
    job = JobRef(job_id="j1", media_id="m1", media_dir="/m", source_uri=None, params={})
    audio = AudioRef(path="/a.wav", duration_sec=1.0)
    await steps.acquire_audio(job)
    await steps.separate(job, "/a.wav")
    await steps.separate(job, "/a.wav")  # a step run twice is one stage, summed
    await steps.probe_silence(job, audio)
    got = stage_clock.take("j1")
    assert [s["stage"] for s in got] == ["acquire_audio", "separate", "probe_silence"]
    assert all(isinstance(s["ms"], int) and s["ms"] >= 10 for s in got)
    assert got[1]["ms"] >= 20
    assert stage_clock.take("j1") == (), "taken once, then forgotten"


async def test_the_completion_frame_carries_the_jobs_stages(monkeypatch: pytest.MonkeyPatch) -> None:
    from encore_worker import __main__ as entry

    async def idle(*_: Any, **__: Any) -> None:
        await asyncio.Event().wait()

    async def done(assign: Any, job: JobRef, *_: Any) -> f.Complete:
        stage_clock.record(job.job_id, "separate", 1.5)
        return f.Complete(worker_id="w1", job_id=job.job_id, media_uri="x")

    async def fetched(assign: Any, job: JobRef, *_: Any) -> f.Complete:
        return f.Complete(worker_id="w1", job_id=job.job_id, media_uri="x")

    monkeypatch.setattr(transport_client, "keepalive", idle)
    monkeypatch.setattr(entry, "_dispatch", done)
    assign = f.Assign(job_id="j3", media_id="m1", action="stems")
    frame = await entry._run(assign, Config(), None, None, None, None)  # type: ignore[arg-type]
    assert isinstance(frame, f.Complete) and frame.stages == ({"stage": "separate", "ms": 1500},)
    # A fetch times no steps: its one stage is the whole job.
    monkeypatch.setattr(entry, "_dispatch", fetched)
    assign = f.Assign(job_id="j4", media_id="m1", action="fetch")
    frame = await entry._run(assign, Config(), None, None, None, None)  # type: ignore[arg-type]
    assert isinstance(frame, f.Complete) and frame.stages is not None and frame.stages[0]["stage"] == "fetch"


async def test_a_failed_step_still_counts_and_no_job_id_times_nothing() -> None:
    async def boom() -> None:
        raise RuntimeError("x")

    timed = stage_clock.timed("j2", "publish", boom)
    try:
        await timed()
    except RuntimeError:
        pass
    assert [s["stage"] for s in stage_clock.take("j2")] == ["publish"]
    assert stage_clock.timed(None, "publish", boom) is boom
