"""The worker reports the profile it RESOLVED (device, backend, threads) in hello, so core can stamp it on
every attempt. Before, hello carried `ENCORE_DEVICE` (unset on an auto-detected box) and the completion
facts carried `ENCORE_SEPARATOR_BACKEND` (also usually unset), so `job_attempts.device` and `backend` were
empty on every row.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

from encore_worker.host import hardware
from encore_worker.host.config import Config
from encore_worker.protocol import frames as f
from encore_worker.steps.records import AlignOutcome, JobRef, PublishedStems
from encore_worker.transport.client import Client
from encore_worker.workflows import durable
from encore_worker.workflows.stems import StemsOutcome

JOB = JobRef(job_id="j1", media_id="m1", media_dir="/media")


def test_hello_carries_the_resolved_device_and_threads_not_the_env_pin() -> None:
    async def never(a: f.Assign) -> f.Complete:
        raise AssertionError

    client = Client(
        config=Config(device=None),
        connect=None,  # type: ignore[arg-type]  # _hello never dials
        run_job=never,
        capabilities=frozenset({"stems"}),
        backend="torch",
        device="cuda",
        threads=12,
    )
    wire = client._hello().to_wire()
    assert (wire["backend"], wire["device"], wire["threads"]) == ("torch", "cuda", 12)


def test_an_unknown_thread_count_is_omitted_not_sent_as_null() -> None:
    assert "threads" not in f.Hello(worker_id="w", capabilities=(), concurrency=1, version="1").to_wire()


def test_the_probe_reads_torchs_thread_count(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = ModuleType("torch")
    fake.__version__ = "2.8.0"  # type: ignore[attr-defined]
    fake.get_num_threads = lambda: 12  # type: ignore[attr-defined]
    fake.cuda = SimpleNamespace(is_available=lambda: False)  # type: ignore[attr-defined]
    fake.backends = SimpleNamespace(mps=None)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", fake)
    monkeypatch.setattr(hardware, "module_available", lambda name: name == "torch")
    assert hardware.probe().threads == 12


def test_completion_facts_send_no_null_backend() -> None:
    """The backend is the process's and goes in hello; a `null` here used to overwrite what core recorded."""
    from encore_worker.__main__ import _align_facts, _stems_completion
    from encore_worker.adapters.separate import TorchDemucs

    assert "backend" not in _align_facts(JOB, Config(), AlignOutcome(published=None, why=""))
    stems = StemsOutcome(published=PublishedStems(instrumental="derived/x.flac"), why="ok", profile={})
    frame = _stems_completion(JOB, Config(), stems, TorchDemucs())
    assert isinstance(frame, f.Complete) and frame.facts is not None
    assert "backend" not in frame.facts


@pytest.mark.parametrize(("torch_device", "ran_on"), [("mps", "cpu"), ("cuda", "cuda"), ("cpu", "cpu")])
def test_an_align_job_reports_the_device_its_transcriber_ran_on(torch_device: str, ran_on: str) -> None:
    """On a Mac the process is `mps` but whisperx runs on `cpu`; the align row must say `cpu`."""
    from encore_worker import __main__ as entry

    async def aligned(job: JobRef) -> AlignOutcome:
        return AlignOutcome(published=None, why="")

    async def dispatch() -> f.Complete | f.Failed:
        assign = SimpleNamespace(action="align")
        client = SimpleNamespace(device=torch_device)
        return await entry._dispatch(assign, JOB, Config(), None, None, client, None)  # type: ignore[arg-type]

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(durable, "align", aligned)
        frame = asyncio.run(dispatch())
    assert isinstance(frame, f.Complete) and frame.facts is not None
    assert frame.facts["device"] == ran_on


class _Client:
    wired: dict[str, Any] = {}

    def __init__(self, **wired: Any) -> None:
        _Client.wired = wired
        self.publish_stem_format = "flac"

    async def serve_forever(self) -> None:
        return None


def test_main_hands_the_client_its_resolved_device_and_threads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from encore_worker import __main__ as entry

    report = hardware.Report(machine="m", python="3", platform="p", accelerator="mps", threads=10)
    # No warm-up: it would load real models (test_autoconfig covers it). An accelerator pins no threads.
    cfg = Config(media_dir=str(tmp_path), warmup=False)
    monkeypatch.setattr(Config, "from_env", staticmethod(lambda: cfg))
    monkeypatch.setattr(hardware, "probe", lambda: report)
    monkeypatch.setattr(hardware, "module_available", lambda name: False)
    monkeypatch.setattr(entry, "_launch_dbos", lambda cfg: None)
    monkeypatch.setattr(entry, "build_adapters", lambda cfg, *, device: SimpleNamespace(probe=None))
    monkeypatch.setattr(entry, "Client", _Client)
    monkeypatch.setattr(durable, "register", lambda dbos, **providers: None)
    asyncio.run(entry.main())
    assert (_Client.wired["device"], _Client.wired["threads"]) == ("mps", 10)
