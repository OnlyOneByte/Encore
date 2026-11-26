"""Settings the worker picks for itself, and the env override that beats each pick.

Demucs `-j` (a worker process per 8 cores: threads returned silent stems), the engines run from THIS
install rather than PATH, and the two publish encodes at once.
"""

from __future__ import annotations

import asyncio
import os
import sys
import threading
from dataclasses import replace
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


@pytest.mark.parametrize(("cores", "jobs"), [(4, 1), (8, 1), (16, 2), (32, 4), (64, 4)])
def test_a_cpu_box_runs_a_demucs_worker_per_eight_cores(cores: int, jobs: int) -> None:
    """Measured on 32 cores (#1130); a smaller box keeps 1, and 4 is as fast as 8 at half the memory."""
    picked = hardware.resolve_demucs_jobs(None, device="cpu", cores=cores)
    assert picked.count == jobs
    assert (hardware.DEMUCS_POOL in picked.why) == (jobs > 1), "the startup line says how -j runs"


def test_two_jobs_at_once_split_the_demucs_workers() -> None:
    """The separator's share of the box decides `-j`, not the whole box: two songs at once halve it."""

    def jobs(concurrency: int | None) -> int:
        return hardware.resolve_profile(
            concurrency=concurrency,
            threads=None,
            demucs_jobs=None,
            asr_compute=None,
            warmup=False,
            device="cpu",
            cores=32,
        ).demucs_jobs.count

    assert (jobs(None), jobs(2)) == (4, 2)


def test_an_explicit_cpu_demucs_jobs_says_it_runs_in_processes() -> None:
    assert hardware.DEMUCS_POOL in hardware.resolve_demucs_jobs(8, device="cpu").why
    assert hardware.DEMUCS_POOL not in hardware.resolve_demucs_jobs(1, device="cpu").why


@pytest.mark.parametrize("device", ["cuda", "mps"])
def test_an_accelerator_keeps_one_demucs_job(device: str) -> None:
    """demucs only pools `-j` on CPU, so more on a GPU would be a number that changes nothing."""
    assert hardware.resolve_demucs_jobs(None, device=device).count == 1


@pytest.mark.parametrize("device", ["cpu", "cuda"])
def test_an_explicit_demucs_jobs_wins_on_every_device(device: str) -> None:
    picked = hardware.resolve_demucs_jobs(3, device=device)
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
        #: The jobs running when a separator is built; the job building it is one of them.
        self.running: frozenset[str] = frozenset({"j"})

    async def serve_forever(self) -> None:
        return None

    def running_jobs(self) -> frozenset[str]:
        return self.running


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
    # A roomy box, so the auto picks do not follow the RAM and disk of whatever machine runs the suite.
    monkeypatch.setattr(hardware, "memory_gb", lambda **_: (64.0, 32.0))
    monkeypatch.setattr(hardware, "free_disk_gb", lambda path: 100.0)
    monkeypatch.setattr(entry, "_launch_dbos", lambda cfg: None)
    monkeypatch.setattr(
        entry,
        "build_adapters",
        lambda cfg, *, device: SimpleNamespace(probe=None, aligner=None, transcriber=None),
    )
    # No real thread pinning (it writes this process's env) and no real downloads.
    monkeypatch.setattr(hardware, "apply_threads", lambda n: got.update(applied=n) or (n or None))
    real_steps = entry.warm_steps

    def steps(*args: Any, **kwargs: Any) -> Any:
        planned = real_steps(*args, **kwargs)
        got["warmed"] = [name for name, _ in planned]
        return []

    monkeypatch.setattr(entry, "warm_steps", steps)
    monkeypatch.setattr(entry, "Client", lambda **wired: got.setdefault("client", _Client(**wired)))
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


# ── proposal 26: the boot profile ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("device", "cores", "ram", "jobs"),
    [
        ("cpu", 32, 64.0, 2),
        ("cpu", 16, 24.0, 2),
        ("cpu", 8, 64.0, 1),  # too few cores to split
        ("cpu", 32, 16.0, 1),  # two at once peaked at 8.5 GB, before the models
        ("cpu", 32, None, 1),  # RAM unknown: not a pick to make blind
        ("cuda", 32, 64.0, 1),  # the separators take turns on the card
    ],
)
def test_auto_concurrency_is_two_only_with_the_cores_and_ram_for_it(
    device: str, cores: int, ram: float | None, jobs: int
) -> None:
    """2 made 3 queued songs 18-70% sooner (#1177); a smaller box keeps 1."""
    picked = hardware.resolve_concurrency(None, device=device, cores=cores, ram_gb=ram)
    assert picked.count == jobs
    assert picked.why.startswith(f"auto {jobs}")


def test_an_explicit_concurrency_wins_on_any_box() -> None:
    told = hardware.resolve_concurrency(3, device="cpu", cores=4, ram_gb=2.0)
    assert (told.count, "ENCORE_WORKER_CONCURRENCY" in told.why) == (3, True)
    assert hardware.resolve_concurrency(1, device="cpu", cores=64, ram_gb=256.0).count == 1


def test_a_song_alone_keeps_every_core_on_a_two_job_box() -> None:
    """A lone pick at 2 was slower when each separator was held to half the cores (#1177)."""
    two = hardware.resolve_profile(
        concurrency=None,
        threads=None,
        demucs_jobs=None,
        asr_compute=None,
        warmup=None,
        device="cpu",
        cores=32,
        ram_gb=64.0,
    )
    assert two.concurrency.count == 2
    assert (two.separator_share(1), two.separator_share(2)) == (32, 16)
    pinned = hardware.resolve_profile(
        concurrency=2, threads=6, demucs_jobs=None, asr_compute=None, warmup=None, device="cpu", cores=32
    )
    assert (pinned.separator_share(1), pinned.separator_share(2)) == (6, 6), "ENCORE_THREADS is never split"


@pytest.mark.parametrize(
    ("configured", "ram", "disk", "on"),
    [
        (None, 32.0, 100.0, True),
        (None, 3.0, 100.0, False),
        (None, 32.0, 2.0, False),
        (None, None, None, True),  # the OS would not say: as before, on
        (True, 1.0, 1.0, True),  # set by hand wins
        (False, 64.0, 500.0, False),
    ],
)
def test_the_warmup_is_auto_off_when_ram_or_disk_is_tight(
    configured: bool | None, ram: float | None, disk: float | None, on: bool
) -> None:
    picked = hardware.resolve_warmup(configured, free_ram_gb=ram, disk_gb=disk)
    assert bool(picked.count) == on
    assert ("ENCORE_WARMUP" in picked.why) is True


def test_memory_reads_a_cgroup_limit(tmp_path: Path) -> None:
    (tmp_path / "memory.max").write_text(str(8 * 1024**3))
    (tmp_path / "memory.current").write_text(str(6 * 1024**3))
    total, available = hardware.memory_gb(root=str(tmp_path))
    assert total is not None and total <= 8.0
    assert available is not None and available <= 2.0
    (tmp_path / "memory.max").write_text("max")
    assert hardware.memory_gb(root=str(tmp_path))[0] != 8.0, "no limit means the machine's RAM"


def test_the_models_keep_every_core_and_two_jobs_split_only_the_separators() -> None:
    """The in-process models take turns behind ML_LOCK, so halving their threads was pure loss (#1177)."""
    auto = dict(threads=None, demucs_jobs=None, asr_compute=None, warmup=True, device="cpu")
    one = hardware.resolve_profile(concurrency=None, cores=32, **auto)  # type: ignore[arg-type]
    assert (one.concurrency.count, one.threads.count, one.separator_threads.count) == (1, 32, 32)
    two = hardware.resolve_profile(concurrency=2, cores=32, **auto)  # type: ignore[arg-type]
    assert (two.concurrency.count, two.threads.count, two.separator_threads.count) == (2, 32, 16)
    assert "separators 16" in two.lines()[1]


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


def test_the_profile_reads_the_cgroup_when_not_told(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A `--cpus 4` container on a 32-core host: four threads, not 32."""
    monkeypatch.setattr(hardware, "CGROUP_ROOT", _cgroup(tmp_path, {"cpu.max": "400000 100000"}))
    monkeypatch.setattr(os, "sched_getaffinity", lambda pid: set(range(32)), raising=False)
    picked = hardware.resolve_profile(
        concurrency=None, threads=None, demucs_jobs=None, asr_compute=None, warmup=True, device="cpu"
    )
    assert (picked.concurrency.count, picked.threads.count) == (1, 4)
    assert "4 cores" in picked.threads.why


@pytest.mark.parametrize(("device", "compute"), [("cpu", "float32"), ("cuda", "float16"), ("mps", "float32")])
def test_an_accelerator_keeps_torchs_threads_and_cuda_alone_gets_float16(device: str, compute: str) -> None:
    got = hardware.resolve_profile(
        concurrency=None, threads=None, demucs_jobs=None, asr_compute=None, warmup=True, device=device,
        cores=32,
    )  # fmt: skip
    assert got.asr_compute == compute, "int8 is never the auto pick: unmeasured against the corpus"
    assert (got.threads.count == 0) == (device != "cpu")


def test_every_override_wins_and_unset_is_auto() -> None:
    told = Config.from_env(
        {
            "ENCORE_WORKER_CONCURRENCY": "3",
            "ENCORE_THREADS": "6",
            "ENCORE_DEMUCS_JOBS": "5",
            "ENCORE_ASR_COMPUTE": "int8",
            "ENCORE_WARMUP": "0",
        }
    )
    picked = hardware.resolve_profile(
        concurrency=None if told.auto_concurrency else told.concurrency,
        threads=told.threads,
        demucs_jobs=told.demucs_jobs,
        asr_compute=told.asr_compute,
        warmup=told.warmup,
        device="cpu",
        cores=32,
    )
    assert (picked.concurrency.count, picked.threads.count, picked.demucs_jobs.count) == (3, 6, 5)
    assert (picked.asr_compute, picked.warmup.count) == ("int8", 0)
    assert "ENCORE_THREADS" in picked.threads.why and "ENCORE_ASR_COMPUTE" in picked.asr_compute_why
    assert len(picked.lines()) == 5, "five startup lines say what it picked and why"

    unset = Config.from_env({})
    assert (unset.auto_concurrency, unset.concurrency, unset.threads) == (True, 1, None)
    assert unset.asr_compute is None
    assert unset.warmup is None, "unset, the box decides (`hardware.resolve_warmup`)"
    assert Config.from_env({"ENCORE_WARMUP": "1"}).warmup is True


@pytest.mark.parametrize(("key", "value"), [("ENCORE_ASR_COMPUTE", "int4"), ("ENCORE_THREADS", "0")])
def test_a_bad_override_is_refused_at_the_boundary(key: str, value: str) -> None:
    with pytest.raises(ConfigError, match=key):
        Config.from_env({key: value})


def test_apply_threads_pins_the_children_too(monkeypatch: pytest.MonkeyPatch) -> None:
    """demucs runs as a child process, so torch.set_num_threads alone would leave it on every core."""
    for key in ("OMP_NUM_THREADS", "MKL_NUM_THREADS"):
        monkeypatch.setenv(key, "1")  # set first, so the undo removes what apply_threads writes
    monkeypatch.setattr(hardware, "module_available", lambda name: False)
    assert hardware.apply_threads(12) == 12
    assert (os.environ["OMP_NUM_THREADS"], os.environ["MKL_NUM_THREADS"]) == ("12", "12")
    monkeypatch.setenv("OMP_NUM_THREADS", "7")
    assert hardware.apply_threads(0) is None, "0 is torch's own default: nothing pinned"
    assert os.environ["OMP_NUM_THREADS"] == "7"


def test_main_hands_the_client_and_the_config_the_resolved_profile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The hello's threads are what was PINNED (the probe ran before), and the slots are the picked count.
    At two jobs the models keep every core and each separator child gets half, so two demucs workers."""
    monkeypatch.setattr(hardware, "cpu_count", lambda **_: 32)
    got = boot(monkeypatch, Config(media_dir=str(tmp_path), concurrency=2))
    wired = got["client"].wired
    assert (wired["device"], wired["threads"], wired["demucs_jobs"], got["applied"]) == ("cpu", 32, 2, 32)
    cfg = wired["config"]
    assert (cfg.concurrency, cfg.threads, cfg.demucs_jobs, cfg.asr_compute) == (2, 32, 2, "float32")
    got["stems_steps_for"](JobRef(job_id="j", media_id="m", media_dir=str(tmp_path)))
    # The startup fallback is built for two at once; the job's own sees it is running alone.
    assert [k.get("threads") for k in got["separators"]] == [16, 32], "a lone job's separator gets every core"
    assert [k.get("demucs_jobs") for k in got["separators"]] == [2, 4], "and the demucs workers they hold"
    got["client"].running = frozenset({"j", "k"})
    got["stems_steps_for"](JobRef(job_id="k", media_id="m", media_dir=str(tmp_path)))
    assert (got["separators"][-1]["threads"], got["separators"][-1]["demucs_jobs"]) == (16, 2)


@pytest.mark.parametrize(
    ("ram", "at_once", "jobs"),
    [(None, 1, 4), (64.0, 1, 4), (8.0, 1, 4), (6.0, 1, 2), (4.5, 1, 1), (8.0, 2, 2)],
)
def test_auto_demucs_jobs_is_capped_by_ram(ram: float | None, at_once: int, jobs: int) -> None:
    """About 1 GB per pool worker on top of about 4 GB for the worker (#1284 review)."""
    picked = hardware.resolve_demucs_jobs(None, device="cpu", cores=32, ram_gb=ram, jobs_at_once=at_once)
    assert picked.count == jobs
    assert ("GB RAM" in picked.why) == (ram is not None and jobs < 4)
    told = hardware.resolve_demucs_jobs(6, device="cpu", cores=32, ram_gb=2.0)
    assert told.count == 6, "ENCORE_DEMUCS_JOBS wins over the RAM cap"


def test_a_song_alone_gets_the_demucs_workers_its_cores_hold_within_the_ram_cap() -> None:
    def profile(ram: float | None, demucs_jobs: int | None = None) -> hardware.Profile:
        return hardware.resolve_profile(
            concurrency=2,
            threads=None,
            demucs_jobs=demucs_jobs,
            asr_compute=None,
            warmup=None,
            device="cpu",
            cores=32,
            ram_gb=ram,
        )

    assert (profile(64.0).demucs_share(1), profile(64.0).demucs_share(2)) == (4, 2)
    assert profile(7.0).demucs_share(1) == 1, "7 GB at two jobs holds one worker each"
    assert profile(64.0, demucs_jobs=3).demucs_share(1) == 3, "ENCORE_DEMUCS_JOBS is never re-picked"
    assert "4 for a song alone" in profile(64.0).lines()[1]


def test_warmup_off_loads_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    on = boot(monkeypatch, Config(media_dir=str(tmp_path)))
    assert on["warmed"] == ["demucs htdemucs checkpoint"], "the torch separator's checkpoint is prefetched"
    off = boot(monkeypatch, Config(media_dir=str(tmp_path), warmup=False))
    assert "warmed" not in off


def test_the_warmup_names_each_model_and_survives_a_failure(capsys: pytest.CaptureFixture[str]) -> None:
    from encore_worker import __main__ as entry

    calls: list[str] = []

    def broken() -> None:
        raise OSError("no network")

    adapters = SimpleNamespace(
        aligner=SimpleNamespace(warm=broken), transcriber=SimpleNamespace(warm=lambda: calls.append("asr"))
    )
    cfg = Config(asr_compute="float32")
    steps = entry.warm_steps(cfg, adapters, None, device="cpu")  # type: ignore[arg-type]
    assert [name for name, _ in steps] == ["HUBERT_ASR_LARGE", "whisper base float32"]
    entry._warm_up(steps)
    out = capsys.readouterr().out
    assert "warm: HUBERT_ASR_LARGE failed (OSError: no network); the first job loads it" in out
    assert calls == ["asr"], "a failed step does not stop the next one"
    assert "warm: whisper base float32" in out and "warm-up done in" in out


def test_the_hello_carries_the_demucs_jobs_core_stamps() -> None:
    """Core's `WorkerProfile` takes `demucsJobs`; the hello must send it."""
    from encore_worker.transport.client import Client

    client = Client(
        config=Config(concurrency=2),
        connect=None,  # type: ignore[arg-type]
        run_job=None,  # type: ignore[arg-type]
        capabilities=frozenset(),
        device="cpu",
        threads=16,
        demucs_jobs=4,
    )
    wire = client._hello().to_wire()
    assert (wire["device"], wire["threads"], wire["demucsJobs"], wire["concurrency"]) == ("cpu", 16, 4, 2)


def test_the_hello_says_which_settings_were_set_by_hand() -> None:
    """Core shows each profile value as picked or set by hand, so the hello names the hand-set ones."""
    from encore_worker.transport.client import Client

    told = Config.from_env({"ENCORE_THREADS": "6", "ENCORE_WARMUP": "0", "ENCORE_DEVICE": "cpu"})
    assert told.hand_set() == ("device", "threads", "warmup")
    assert Config.from_env({}).hand_set() == (), "nothing set means every setting was picked"
    client = Client(
        config=replace(told, asr_compute="float32"),
        connect=None,  # type: ignore[arg-type]
        run_job=None,  # type: ignore[arg-type]
        capabilities=frozenset(),
        hand_set=told.hand_set(),
    )
    wire = client._hello().to_wire()
    assert (wire["handSet"], wire["asrCompute"], wire["warmup"]) == (
        ["device", "threads", "warmup"],
        "float32",
        False,
    )


def test_the_asr_compute_reaches_whisper(monkeypatch: pytest.MonkeyPatch) -> None:
    from encore_worker.adapters import ml

    loaded: list[tuple[str, str, str]] = []

    def load_model(ckpt: str, dev: str, compute_type: str) -> None:
        loaded.append((ckpt, dev, compute_type))

    monkeypatch.setitem(sys.modules, "whisperx", SimpleNamespace(load_model=load_model))
    monkeypatch.setattr(ml, "_allow_pyannote_checkpoints", lambda: None)
    monkeypatch.setattr(ml, "_MODELS", {})
    ml.WhisperTranscriber(device="cpu", checkpoint="base", compute="int8")._model()
    ml.WhisperTranscriber(device="cuda", checkpoint="tiny")._model()
    assert loaded == [("base", "cpu", "int8"), ("tiny", "cuda", "float16")]


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
