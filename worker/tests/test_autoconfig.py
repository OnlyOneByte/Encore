"""Settings the worker picks for itself, and the env override that beats each pick.

Demucs `-j` from the cores, the engines run from THIS install rather than PATH, and the two publish encodes
at once.
"""

from __future__ import annotations

import asyncio
import os
import sys
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from encore_worker.adapters import separate as sep
from encore_worker.artifacts.local import LocalArtifactStore, Roots
from encore_worker.host import hardware
from encore_worker.host.config import Config, ConfigError
from encore_worker.steps.records import AudioRef, JobRef
from encore_worker.steps.separate_steps import SeparateStepsImpl
from encore_worker.workflows import durable

# ── AC-01: demucs -j ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(("cores", "expected"), [(32, 8), (64, 8), (16, 4), (8, 2), (4, 1), (2, 1), (1, 1)])
def test_cpu_demucs_jobs_scale_with_cores_up_to_the_cap(cores: int, expected: int) -> None:
    picked = hardware.resolve_demucs_jobs(None, device="cpu", cores=cores, avail_gb=123.0)
    assert picked.count == expected
    assert f"{cores} cores" in picked.why, "the startup line says what it picked from"


@pytest.mark.parametrize(
    ("cores", "avail_gb", "expected", "bound"),
    [
        (32, 123.0, 8, "capped"),  # this host: the speedup is unchanged
        (32, 6.1, 2, "RAM-bound"),  # an 8 GB box, about 6 GB of it free
        (32, 3.5, 1, "RAM-bound"),  # a 4 GB container: below the reserve still runs one job
        (8, 123.0, 2, "core-bound"),
    ],
)
def test_cpu_demucs_jobs_never_outgrow_free_ram(
    cores: int, avail_gb: float, expected: int, bound: str
) -> None:
    """`-j 8` peaks at about 6 GB; picked in a 4 GB container, the separation is OOM-killed every retry."""
    picked = hardware.resolve_demucs_jobs(None, device="cpu", cores=cores, avail_gb=avail_gb)
    assert picked.count == expected
    assert bound in picked.why, "the startup line names the limit that bound the pick"
    assert f"{avail_gb:.1f} GB free" in picked.why


def _cgroup(root: Path, files: dict[str, str]) -> str:
    for name, body in files.items():
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(body + "\n")
    return str(root)


def test_a_cgroup_cpu_quota_caps_the_cores(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`docker --cpus 4` on a 32-core host: the affinity mask still shows 32."""
    monkeypatch.setattr(os, "sched_getaffinity", lambda pid: set(range(32)), raising=False)
    assert hardware.cpu_count(root=_cgroup(tmp_path / "v2", {"cpu.max": "400000 100000"})) == 4
    assert hardware.cpu_count(root=_cgroup(tmp_path / "none", {"cpu.max": "max 100000"})) == 32
    v1 = {"cpu/cpu.cfs_quota_us": "200000", "cpu/cpu.cfs_period_us": "100000"}
    assert hardware.cpu_count(root=_cgroup(tmp_path / "v1", v1)) == 2
    assert hardware.cpu_count(root=str(tmp_path / "absent")) == 32


def test_a_cgroup_memory_limit_bounds_the_free_ram(tmp_path: Path) -> None:
    """A 4 GB container on a 123 GB host has about 3.5 GB to give, not 120."""
    meminfo = tmp_path / "meminfo"
    meminfo.write_text(f"MemTotal: {128 << 20} kB\nMemAvailable: {123 << 20} kB\n")
    v2 = _cgroup(tmp_path / "v2", {"memory.max": str(4 << 30), "memory.current": str(512 << 20)})
    assert hardware.memory_available_gb(root=v2, meminfo=str(meminfo)) == pytest.approx(3.5)
    v1 = {"memory/memory.limit_in_bytes": str(4 << 30), "memory/memory.usage_in_bytes": str(1 << 30)}
    assert hardware.memory_available_gb(root=_cgroup(tmp_path / "v1", v1), meminfo=str(meminfo)) == 3.0
    unlimited = _cgroup(tmp_path / "max", {"memory.max": "max", "memory.current": "1"})
    assert hardware.memory_available_gb(root=unlimited, meminfo=str(meminfo)) == pytest.approx(123.0)
    v1_none = _cgroup(tmp_path / "v1n", {"memory/memory.limit_in_bytes": "9223372036854771712"})
    assert hardware.memory_available_gb(root=v1_none, meminfo=str(meminfo)) == pytest.approx(123.0)


def test_the_auto_jobs_read_the_cgroup_when_not_told(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The `--cpus 4 --memory 4g` container the review measured: one job, not the host's eight."""
    root = _cgroup(tmp_path, {"cpu.max": "400000 100000", "memory.max": str(4 << 30), "memory.current": "0"})
    monkeypatch.setattr(hardware, "CGROUP_ROOT", root)
    monkeypatch.setattr(os, "sched_getaffinity", lambda pid: set(range(32)), raising=False)
    picked = hardware.resolve_demucs_jobs(None, device="cpu")
    assert picked.count == 1
    assert "4 cores" in picked.why


@pytest.mark.parametrize("device", ["cuda", "mps"])
def test_an_accelerator_keeps_one_demucs_job(device: str) -> None:
    """demucs only pools `-j` on CPU, so more on a GPU would be a number that changes nothing."""
    assert hardware.resolve_demucs_jobs(None, device=device, cores=32).count == 1


@pytest.mark.parametrize("device", ["cpu", "cuda"])
def test_an_explicit_demucs_jobs_wins_on_every_device(device: str) -> None:
    picked = hardware.resolve_demucs_jobs(3, device=device, cores=32)
    assert picked.count == 3
    assert "ENCORE_DEMUCS_JOBS" in picked.why


def test_the_env_override_is_parsed_and_unset_means_auto() -> None:
    assert Config.from_env({"ENCORE_DEMUCS_JOBS": "3"}).demucs_jobs == 3
    assert Config.from_env({}).demucs_jobs is None
    with pytest.raises(ConfigError, match="ENCORE_DEMUCS_JOBS"):
        Config.from_env({"ENCORE_DEMUCS_JOBS": "0"})


def test_the_torch_separator_runs_the_jobs_it_was_built_with(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(hardware, "module_available", lambda name: True)
    ran: list[list[str]] = []
    monkeypatch.setattr(sep, "run", lambda argv, **_: ran.append(argv))

    built = sep.build_separator("torch", device="cpu", mlx_bin="x", ffmpeg_bin="ffmpeg", demucs_jobs=6)
    assert isinstance(built, sep.TorchDemucs)
    built.separate("/w/input.wav", "/w/out")
    assert ran[0][ran[0].index("-j") + 1] == "6"


class _Client:
    """Stands in for `transport.client.Client`: takes what `main` wires and serves nothing."""

    publish_stem_format = "flac"

    def __init__(self, **wired: Any) -> None:
        self.wired = wired

    async def serve_forever(self) -> None:
        return None


def boot(monkeypatch: pytest.MonkeyPatch, config: Config) -> dict[str, Any]:
    """Run `__main__.main` with no socket, no DBOS and no models, and return what it registered."""
    from encore_worker import __main__ as entry

    got: dict[str, Any] = {"separators": []}
    real_build = sep.build_separator
    real_caps = hardware.capabilities
    monkeypatch.setattr(hardware, "capabilities", lambda **k: got.update(caps=k) or real_caps(**k))
    monkeypatch.setattr(Config, "from_env", staticmethod(lambda: config))
    monkeypatch.setattr(hardware, "probe", lambda: hardware.Report(machine="m", python="3", platform="p"))
    monkeypatch.setattr(hardware, "module_available", lambda name: name == "demucs")
    monkeypatch.setattr(entry, "_launch_dbos", lambda cfg: None)
    monkeypatch.setattr(entry, "build_adapters", lambda cfg, *, device: SimpleNamespace(probe=None))
    monkeypatch.setattr(entry, "Client", _Client)
    monkeypatch.setattr(durable, "register", lambda dbos, **providers: got.update(providers))
    monkeypatch.setattr(
        sep, "build_separator", lambda *a, **k: got["separators"].append(k) or real_build(*a, **k)
    )
    asyncio.run(entry.main())
    return got


def test_both_separators_main_builds_use_the_resolved_jobs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The startup fallback AND the per-job separator: either one left on `-j 1` is the 2x lost again."""
    got = boot(monkeypatch, Config(demucs_jobs=5, media_dir=str(tmp_path)))
    got["stems_steps_for"](JobRef(job_id="j", media_id="m", media_dir=str(tmp_path)))
    assert [k.get("demucs_jobs") for k in got["separators"]] == [5, 5]


def test_main_gates_mlx_stems_on_the_bin_it_will_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    got = boot(monkeypatch, Config(mlx_bin="/venv/bin/demucs-mlx", media_dir=str(tmp_path)))
    assert got["caps"]["mlx_bin"] == "/venv/bin/demucs-mlx"


# ── AC-10: this install's engines ────────────────────────────────────────────────────────────────


def test_torch_demucs_runs_in_the_workers_own_interpreter() -> None:
    """`capabilities` probes demucs in THIS interpreter; a bare `python` is whatever PATH has, or nothing."""
    assert sep.demucs_argv("/w/i.wav", "/w/o")[0] == sys.executable


def test_mlx_stems_needs_the_binary_not_just_the_module(monkeypatch: pytest.MonkeyPatch) -> None:
    """`build_separator` returns None without the CLI, so advertising stems on the module alone accepted
    jobs it then refused."""
    monkeypatch.setattr(hardware, "module_available", lambda name: True)
    monkeypatch.setattr(hardware, "binary_available", lambda name: name != "/nowhere/demucs-mlx")

    without = hardware.capabilities(backend="mlx", mlx_bin="/nowhere/demucs-mlx")
    assert "stems" not in without
    assert "stems" in hardware.capabilities(backend="mlx", mlx_bin="/venv/bin/demucs-mlx")


def test_auto_falls_back_to_torch_when_the_mlx_cli_is_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """The module without its CLI used to pick mlx and then advertise no stems, with torch on MPS right there.
    An explicit mlx still means mlx."""
    mac = hardware.Report(machine="arm64", python="3", platform="macOS", apple_silicon=True)
    monkeypatch.setattr(hardware, "module_available", lambda name: True)
    monkeypatch.setattr(hardware, "binary_available", lambda name: name != "/nowhere/demucs-mlx")

    missing = hardware.resolve_backend(None, report=mac, mlx_bin="/nowhere/demucs-mlx")
    assert (missing.name, "demucs-mlx not found" in missing.why) == ("torch", True)
    assert hardware.resolve_backend(None, report=mac, mlx_bin="/venv/bin/demucs-mlx").name == "mlx"
    assert hardware.resolve_backend("mlx", report=mac, mlx_bin="/nowhere/demucs-mlx").name == "mlx"


def test_the_default_mlx_bin_is_the_one_beside_the_interpreter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    beside = tmp_path / "demucs-mlx"
    beside.write_text("#!/bin/sh\n")
    beside.chmod(0o755)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "python"))
    assert Config.from_env({}).mlx_bin == str(beside)
    assert Config.from_env({"ENCORE_MLX_BIN": "/opt/mlx"}).mlx_bin == "/opt/mlx", "the env still wins"

    os.remove(beside)
    assert Config.from_env({}).mlx_bin == "demucs-mlx", "nothing installed there: PATH, as before"


# ── AC-17: publish encodes at once ───────────────────────────────────────────────────────────────


class _Reporter:
    async def progress(self, job_id: str, stage: Any, pct: int) -> None:
        return None

    async def state(self, *args: Any) -> None:
        return None

    async def confirm_ownership(self, job_id: str, *, timeout_sec: float = 10.0) -> bool:
        return True

    def explain_ownership(self, job_id: str) -> str:
        return ""


class _MeetingEncoder:
    """Each stem encode waits for the other: run one after the other, the first waits alone and times out."""

    def __init__(self) -> None:
        self.met = threading.Barrier(2, timeout=5)

    def stem(self, source: str, out_path: str) -> str:
        self.met.wait()
        Path(out_path).write_bytes(b"x")
        return out_path

    def guide_mix(self, instrumental: str, vocals: str, out_path: str) -> str:
        Path(out_path).write_bytes(b"x")
        return out_path


async def test_the_two_stem_encodes_run_at_once(tmp_path: Path) -> None:
    media = tmp_path / "media"
    steps = SeparateStepsImpl(
        config=Config(media_dir=str(media)),
        audio=None,  # type: ignore[arg-type]  # publication never acquires audio
        reporter=_Reporter(),
        store=LocalArtifactStore(Roots.under(str(media))),
        encoder=_MeetingEncoder(),  # type: ignore[arg-type]
    )
    job = JobRef(job_id="j1", media_id="m-1", media_dir=str(media))
    published = await asyncio.wait_for(
        steps.publish_stems(job, AudioRef(path="/w/no_vocals.wav", duration_sec=1.0, vocals_path="/w/v.wav")),
        timeout=20,
    )
    assert published.instrumental and published.vocals and published.guide_mix
