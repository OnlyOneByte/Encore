"""Proposal 28: two jobs share a GPU safely, and a stems requeue after separation resumes at publish."""

from __future__ import annotations

import asyncio
import os
import sqlite3
import sys
import threading
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from encore_worker.adapters import cli
from encore_worker.adapters import separate as sep
from encore_worker.artifacts.local import LocalArtifactStore, Roots
from encore_worker.host.config import Config
from encore_worker.steps.api import NotOurJob
from encore_worker.steps.records import AudioRef, JobRef, PublishedStems
from encore_worker.steps.separate_steps import SeparateStepsImpl
from encore_worker.workflows.stems import ABANDONED


def test_a_separator_child_gets_its_share_of_threads_and_this_process_keeps_its_own(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OMP_NUM_THREADS", "32")
    child = cli.run(["sh", "-c", "echo $OMP_NUM_THREADS $MKL_NUM_THREADS"], env=sep.thread_env(16))
    assert child.split() == ["16", "16"]
    assert cli.run(["sh", "-c", "echo $OMP_NUM_THREADS"], env=sep.thread_env(0)).strip() == "32"
    assert os.environ["OMP_NUM_THREADS"] == "32"


class _Reporter:
    async def progress(self, job_id: str, stage: Any, pct: int) -> None:
        return None

    async def state(self, *args: Any) -> None:
        return None

    async def confirm_ownership(self, job_id: str, *, timeout_sec: float = 10.0) -> bool:
        return True

    def explain_ownership(self, job_id: str) -> str:
        return "another worker owns it"


class _Separator:
    """Counts calls and the most that ran at once. `meet` makes two calls wait for each other."""

    name = "fake"
    model = "fake"

    def __init__(self, meet: threading.Barrier | None = None) -> None:
        self.calls = 0
        self.running = 0
        self.most = 0
        self._meet = meet
        self._guard = threading.Lock()

    def separate(self, input_wav: str, out_dir: str, *, on_progress: object = None) -> sep.Stems:
        with self._guard:
            self.calls += 1
            self.running += 1
            self.most = max(self.most, self.running)
        if self._meet is not None:
            self._meet.wait()
        else:
            time.sleep(0.2)
        with self._guard:
            self.running -= 1
        Path(out_dir, "no_vocals.wav").write_bytes(b"x")
        return sep.Stems(instrumental_path=str(Path(out_dir, "no_vocals.wav")))


def _steps(media: Path, separator: _Separator, device: str) -> SeparateStepsImpl:
    return SeparateStepsImpl(
        config=Config(media_dir=str(media)),
        audio=None,  # type: ignore[arg-type]  # separation never acquires audio
        reporter=_Reporter(),
        store=LocalArtifactStore(Roots.under(str(media))),
        separator=separator,
        device=device,
    )


async def test_two_separations_on_a_gpu_never_share_the_card(tmp_path: Path) -> None:
    separator = _Separator()
    steps = _steps(tmp_path, separator, "cuda")
    jobs = [JobRef(job_id=f"j{i}", media_id=f"m{i}", media_dir=str(tmp_path)) for i in (1, 2)]
    await asyncio.gather(*(steps.separate(job, "in.wav") for job in jobs))
    assert (separator.calls, separator.most) == (2, 1)


async def test_two_separations_on_cpu_run_side_by_side(tmp_path: Path) -> None:
    # Each call waits for the other, so run one after the other the first times out.
    separator = _Separator(meet=threading.Barrier(2, timeout=5))
    steps = _steps(tmp_path, separator, "cpu")
    jobs = [JobRef(job_id=f"j{i}", media_id=f"m{i}", media_dir=str(tmp_path)) for i in (1, 2)]
    await asyncio.wait_for(asyncio.gather(*(steps.separate(job, "in.wav") for job in jobs)), timeout=20)
    assert (separator.calls, separator.most) == (2, 2)


# ── a dropped stems job resumes at publish ───────────────────────────────────────────────────────


class _ResumableSteps(SeparateStepsImpl):
    """The real `separate`, with fakes around it: the first publish loses ownership, the next one works."""

    def __init__(self, media: Path, separator: _Separator) -> None:
        super().__init__(
            config=Config(media_dir=str(media)),
            audio=None,  # type: ignore[arg-type]
            reporter=_Reporter(),
            store=LocalArtifactStore(Roots.under(str(media))),
            separator=separator,
        )
        self.acquired = 0
        self.published = 0

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        self.acquired += 1
        return AudioRef(path=str(Path(job.media_dir, "song.flac")), duration_sec=1.0)

    async def decode_to_wav(self, job: JobRef, audio: AudioRef) -> str:
        return audio.path

    async def probe_silence(self, job: JobRef, audio: AudioRef) -> float | None:
        return -6.0

    async def measure_profile(self, job: JobRef, audio: AudioRef) -> Mapping[str, object]:
        return {}

    async def publish_stems(self, job: JobRef, audio: AudioRef) -> PublishedStems:
        self.published += 1
        if self.published == 1:
            raise NotOurJob("lost the lease during a reconnect")
        return PublishedStems(instrumental=f"stems/{job.media_id}/instrumental.flac")


@pytest.mark.dbos
@pytest.mark.skipif(
    sys.version_info >= (3, 12) and sqlite3.sqlite_version_info < (3, 42),
    reason=f"DBOS needs SQLite >= 3.42 for unixepoch('subsec'); this one is {sqlite3.sqlite_version}",
)
async def test_a_requeue_after_separation_resumes_at_publish(tmp_path: Path) -> None:
    dbos_mod = pytest.importorskip("dbos", reason="dbos is not installed")
    from encore_worker.workflows import durable
    from encore_worker.workflows.dbos_stems import DbosStemsSteps

    db = f"sqlite:///{tmp_path}/d.db"
    instance = dbos_mod.DBOS(config=dbos_mod.DBOSConfig(name="encore-worker-test", system_database_url=db))
    dbos_mod.DBOS.launch()
    try:
        separator = _Separator()
        impl = _ResumableSteps(tmp_path, separator)
        durable.register(
            instance,
            align_steps_for=lambda _job: None,  # type: ignore[arg-type,return-value]  # unused here
            stems_steps_for=lambda _job: DbosStemsSteps(impl, instance),
        )
        job = JobRef(job_id="s-1", media_id="m1", media_dir=str(tmp_path))

        first = await durable.stems(job)
        assert first.published is None and first.why.startswith(ABANDONED)
        again = await durable.stems(job)  # the core's requeue: same job id

        assert again.published is not None, again.why
        assert (separator.calls, impl.acquired, impl.published) == (1, 1, 2), "only publish ran again"
    finally:
        dbos_mod.DBOS.destroy()


def test_the_worker_declares_its_workflows_before_dbos_launches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Launch recovers in-flight runs, and recovery racing a later declaration is what hung them (#1177)."""
    dbos_mod = pytest.importorskip("dbos", reason="dbos is not installed")
    from encore_worker import __main__ as entry
    from encore_worker.workflows import durable

    calls: list[str] = []

    class Recorder:
        def __init__(self, *, config: object) -> None:
            calls.append("init")

        @staticmethod
        def launch() -> None:
            calls.append("launch")

    monkeypatch.setattr(dbos_mod, "DBOS", Recorder)
    monkeypatch.setattr(durable, "declare", lambda dbos: calls.append("declare"))
    entry._launch_dbos(Config(dbos_db=str(tmp_path / "d.sqlite")))
    assert calls == ["init", "declare", "launch"]


#: A worker that separates, then dies mid-publish, leaving a PENDING stems workflow on disk.
_CRASHING_WORKER = """
import asyncio, os, sys
from dbos import DBOS, DBOSConfig
from encore_worker.steps.records import AudioRef, JobRef
from encore_worker.workflows import durable
from encore_worker.workflows.dbos_stems import DbosStemsSteps

class Steps:
    async def acquire_audio(self, job): return AudioRef(path=job.media_dir + "/song.flac", duration_sec=1.0)
    async def decode_to_wav(self, job, audio): return audio.path
    async def separate(self, job, wav): return AudioRef(path=job.media_dir + "/no_vocals.wav", duration_sec=0)
    async def probe_silence(self, job, audio): return -6.0
    async def measure_profile(self, job, audio): return {}
    async def publish_stems(self, job, audio): os._exit(17)

url = "sqlite:///" + sys.argv[1]
dbos = DBOS(config=DBOSConfig(name="encore-worker", system_database_url=url, application_version="build-1"))
durable.declare(dbos)
DBOS.launch()
steps = DbosStemsSteps(Steps(), dbos)
durable.register(dbos, align_steps_for=lambda j: None, stems_steps_for=lambda j: steps)
asyncio.run(durable.stems(JobRef(job_id="s-crash", media_id="m1", media_dir=sys.argv[2])))
"""


@pytest.mark.dbos
@pytest.mark.skipif(
    sys.version_info >= (3, 12) and sqlite3.sqlite_version_info < (3, 42),
    reason=f"DBOS needs SQLite >= 3.42 for unixepoch('subsec'); this one is {sqlite3.sqlite_version}",
)
@pytest.mark.parametrize("build", ["build-1", "build-2"], ids=["same-build-recovers", "new-build-forks"])
async def test_a_crash_mid_publish_resumes_at_publish_after_a_restart(tmp_path: Path, build: str) -> None:
    """Launch recovers the dead worker's run, so the workflows must be declared before it (#1177): declared
    after, recovery failed with "not a registered workflow function" and the requeued job hung for hours.
    A new build does not recover an old build's run, so the requeue forks it instead of waiting on it."""
    dbos_mod = pytest.importorskip("dbos", reason="dbos is not installed")
    from encore_worker.workflows import durable
    from encore_worker.workflows.dbos_stems import DbosStemsSteps

    db = tmp_path / "worker.sqlite"
    script = tmp_path / "crash.py"
    script.write_text(_CRASHING_WORKER)
    crashed = await asyncio.create_subprocess_exec(sys.executable, str(script), str(db), str(tmp_path))
    assert await asyncio.wait_for(crashed.wait(), timeout=120) == 17, "the worker died in publish"

    url = f"sqlite:///{db}"
    config = dbos_mod.DBOSConfig(name="encore-worker", system_database_url=url, application_version=build)
    instance = dbos_mod.DBOS(config=config)
    durable.declare(instance)
    dbos_mod.DBOS.launch()  # recovers s-crash, which waits for the providers below
    try:
        await asyncio.sleep(2)  # the real worker's gap between launch and `register`
        separator = _Separator()
        impl = _ResumableSteps(tmp_path, separator)
        impl.published = 1  # this publish succeeds
        durable.register(
            instance,
            align_steps_for=lambda _job: None,  # type: ignore[arg-type,return-value]  # unused here
            stems_steps_for=lambda _job: DbosStemsSteps(impl, instance),
        )
        job = JobRef(job_id="s-crash", media_id="m1", media_dir=str(tmp_path))
        outcome = await asyncio.wait_for(durable.stems(job), timeout=60)  # the core's requeue

        assert outcome.published is not None, outcome.why
        assert (separator.calls, impl.acquired, impl.published) == (0, 0, 2), "only publish ran again"
    finally:
        dbos_mod.DBOS.destroy()
