"""What the worker checks and picks at boot, before and just after it dials core.

The torch wheel dev.sh installs, the diarizer checked once instead of per job, the YouTube warning, and the
non-Latin routes line moved off the path to the first dial.
"""

from __future__ import annotations

import asyncio
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

from encore_worker.adapters import ml
from encore_worker.host import hardware
from encore_worker.host.config import Config
from encore_worker.workflows import durable

REPO = Path(__file__).resolve().parents[2]

# ── dev.sh: the torch wheel ──────────────────────────────────────────────────────────────────────


def torch_extra(tmp_path: Path, *, system: str, machine: str, gpu: bool, env: str = "") -> str:
    """Run dev.sh's own `torch_extra` with a faked `uname` and `nvidia-smi` first on PATH."""
    body = re.search(r"^torch_extra\(\) \{\n.*?^\}\n", (REPO / "dev.sh").read_text(), re.M | re.S)
    assert body, "dev.sh has no torch_extra()"
    fake = tmp_path / "bin"
    fake.mkdir(exist_ok=True)
    (fake / "uname").write_text(f'#!/bin/sh\n[ "$1" = -s ] && echo {system} || echo {machine}\n')
    (fake / "nvidia-smi").write_text(f"#!/bin/sh\nexit {0 if gpu else 9}\n")
    for tool in ("uname", "nvidia-smi"):
        (fake / tool).chmod(0o755)
    run = subprocess.run(
        ["bash", "-c", body.group(0) + "torch_extra"],
        env={"PATH": f"{fake}:/usr/bin:/bin", **({"ENCORE_TORCH_EXTRA": env} if env else {})},
        capture_output=True,
        text=True,
        check=True,
    )
    return run.stdout.strip()


@pytest.mark.parametrize(
    ("system", "machine", "gpu", "expected"),
    [
        ("Linux", "x86_64", True, "cu128"),
        ("Linux", "x86_64", False, "cpu"),
        ("Linux", "aarch64", True, "cpu"),  # no cu128 wheels for linux-aarch64 in the lock
        ("Darwin", "arm64", False, "cpu"),
    ],
)
def test_dev_sh_picks_cuda_wheels_only_where_a_gpu_answers(
    tmp_path: Path, system: str, machine: str, gpu: bool, expected: str
) -> None:
    assert torch_extra(tmp_path, system=system, machine=machine, gpu=gpu) == expected


@pytest.mark.parametrize("pinned", ["cpu", "cu128"])
def test_encore_torch_extra_wins_over_the_pick(tmp_path: Path, pinned: str) -> None:
    assert torch_extra(tmp_path, system="Linux", machine="x86_64", gpu=True, env=pinned) == pinned


def test_an_unknown_torch_extra_is_refused_by_name(tmp_path: Path) -> None:
    """Otherwise it dies deep inside `uv sync` with "Extra `x` is not defined"."""
    with pytest.raises(subprocess.CalledProcessError) as failed:
        torch_extra(tmp_path, system="Linux", machine="x86_64", gpu=True, env="cuda")
    assert "ENCORE_TORCH_EXTRA=cuda: expected cpu or cu128" in failed.value.stderr


def test_the_gpu_probe_cannot_hang_dev_sh() -> None:
    """A wedged driver can hang `nvidia-smi` for minutes, and dev.sh with it."""
    assert "timeout 10 nvidia-smi -L" in (REPO / "dev.sh").read_text()


def test_dev_sh_installs_the_picked_wheel_not_a_hardcoded_cpu() -> None:
    extras = re.search(r'^\s*WORKER_EXTRAS="(.*)"$', (REPO / "dev.sh").read_text(), re.M)
    assert extras
    assert "--extra $TORCH_EXTRA" in extras.group(1)
    assert "--extra cpu" not in extras.group(1)


def test_core_only_probes_no_gpu() -> None:
    """--core-only and --ui run no worker, so the wheel pick (and its nvidia-smi) sits inside their gate."""
    text = (REPO / "dev.sh").read_text()
    gate = text.index('if [ "$CORE_ONLY" != 1 ] && [ "$UI_MODE" != 1 ]; then\n\tTORCH_EXTRA="$(torch_extra)"')
    assert text.count('TORCH_EXTRA="$(torch_extra)"') == 1 and gate > text.index("torch_extra() {")


#: What `docker info --format '{{json .Runtimes}}'` prints, with and without the NVIDIA Container Toolkit.
WITH_NVIDIA = (
    '{"io.containerd.runc.v2":{"path":"runc"},'
    '"nvidia":{"path":"nvidia-container-runtime"},"runc":{"path":"runc"}}'
)
RUNC_ONLY = '{"io.containerd.runc.v2":{"path":"runc"},"runc":{"path":"runc"}}'
#: `nvidia-smi -L` on a box with a GPU, and on one whose driver is missing or broken (exit 9).
GPU_LISTED = "GPU 0: NVIDIA GeForce RTX 4070 (UUID: GPU-2f3c1d9e-5b7a-4e21-9c0d-8a6b4f1e2d3c)"
NO_DRIVER = "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver."


def compose_run(
    tmp_path: Path,
    *,
    runtimes: str,
    gpu: bool,
    machine: str = "x86_64",
    env: str = "",
    args: tuple[str, ...] = (),
) -> subprocess.CompletedProcess[str]:
    """`./dev.sh compose [args] --stems up` with faked docker, uname and nvidia-smi: the argv it execs on
    stdout, its picked-and-why line on stderr."""
    fake = tmp_path / "bin"
    fake.mkdir(exist_ok=True)
    (fake / "uname").write_text(f'#!/bin/sh\n[ "$1" = -s ] && echo Linux || echo {machine}\n')
    (fake / "nvidia-smi").write_text(
        f"#!/bin/sh\necho '{GPU_LISTED}'\n" if gpu else f"#!/bin/sh\necho '{NO_DRIVER}'\nexit 9\n"
    )
    (fake / "docker").write_text(f'#!/bin/sh\n[ "$1" = info ] && echo \'{runtimes}\' || echo "$@"\n')
    for tool in ("uname", "nvidia-smi", "docker"):
        (fake / tool).chmod(0o755)
    return subprocess.run(
        ["bash", str(REPO / "dev.sh"), "compose", *args, "--stems", "up"],
        cwd=REPO,  # dev.sh resolves docker/ from its cwd; the faked docker only echoes, so nothing is written
        env={"PATH": f"{fake}:/usr/bin:/bin", **({"ENCORE_TORCH_EXTRA": env} if env else {})},
        capture_output=True,
        text=True,
        check=True,
    )


@pytest.mark.parametrize(
    ("runtimes", "gpu", "machine", "env", "cuda", "why"),
    [
        (WITH_NVIDIA, True, "x86_64", "", True, "an NVIDIA GPU and Docker's nvidia runtime"),
        # No nvidia runtime: the override would fail to start.
        (RUNC_ONLY, True, "x86_64", "", False, "Docker has no nvidia runtime"),
        (WITH_NVIDIA, False, "x86_64", "", False, "nvidia-smi sees no GPU"),
        # No cu128 wheels for linux-aarch64.
        (WITH_NVIDIA, True, "aarch64", "", False, "no CUDA build for Linux/aarch64"),
        (WITH_NVIDIA, True, "x86_64", "cpu", False, "ENCORE_TORCH_EXTRA=cpu"),
        # Forced: the operator knows better than the probe, e.g. a runtime registered under another name.
        (RUNC_ONLY, False, "x86_64", "cu128", True, "ENCORE_TORCH_EXTRA=cu128"),
    ],
)
def test_dev_sh_compose_picks_the_worker_image_by_itself_and_says_why(
    tmp_path: Path, runtimes: str, gpu: bool, machine: str, env: str, cuda: bool, why: str
) -> None:
    run = compose_run(tmp_path, runtimes=runtimes, gpu=gpu, machine=machine, env=env)
    assert ("docker/compose.cuda.yaml" in run.stdout) == cuda
    assert "--profile stems up" in run.stdout
    assert f"dev.sh compose: {'cuda' if cuda else 'cpu'} worker image ({why};" in run.stderr


def test_dev_sh_compose_cuda_flag_forces_the_override_without_probing(tmp_path: Path) -> None:
    run = compose_run(tmp_path, runtimes=RUNC_ONLY, gpu=False, args=("--cuda",))
    assert "docker/compose.cuda.yaml" in run.stdout
    assert "dev.sh compose: cuda worker image (--cuda;" in run.stderr


# ── the diarizer, once at boot ───────────────────────────────────────────────────────────────────


def fake_hub(monkeypatch: pytest.MonkeyPatch, *, token: str | None, cached: object) -> None:
    hub = ModuleType("huggingface_hub")
    hub.get_token = lambda: token  # type: ignore[attr-defined]
    hub.try_to_load_from_cache = lambda repo, name: cached  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)


def test_a_gated_checkpoint_with_no_token_and_no_cache_is_blocked(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_hub(monkeypatch, token=None, cached=None)
    assert "HF_TOKEN" in (ml.diarizer_blocked() or "")


@pytest.mark.parametrize(("token", "cached"), [("hf_x", None), (None, "/cache/config.yaml")])
def test_a_token_or_a_cached_copy_lets_the_diarizer_try(
    monkeypatch: pytest.MonkeyPatch, token: str | None, cached: object
) -> None:
    fake_hub(monkeypatch, token=token, cached=cached)
    assert ml.diarizer_blocked() is None


# ── YouTube needs deno and the remote-components line ────────────────────────────────────────────


def test_youtube_gap_names_what_is_missing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    conf = tmp_path / "config"
    conf.write_text("--remote-components ejs:github\n")
    monkeypatch.setattr(hardware, "binary_available", lambda name: name == "deno")
    assert hardware.youtube_gap((str(conf),)) is None
    assert "remote-components" in (hardware.youtube_gap((str(tmp_path / "none"),)) or "")
    commented = tmp_path / "commented"
    commented.write_text("# --remote-components ejs:github\n")
    assert "remote-components" in (hardware.youtube_gap((str(commented),)) or ""), "a comment sets nothing"

    monkeypatch.setattr(hardware, "binary_available", lambda name: False)
    assert "deno" in (hardware.youtube_gap((str(conf),)) or "")


def test_the_config_paths_follow_xdg_and_home() -> None:
    paths = Config.from_env({"XDG_CONFIG_HOME": "/x", "HOME": "/h"}).ytdlp_config_paths
    assert "/x/yt-dlp/config" in paths, "where dev.sh writes its config"
    assert "/etc/yt-dlp.conf" in paths, "where the image writes its config"
    assert "/h/yt-dlp.conf" in paths


# ── main ─────────────────────────────────────────────────────────────────────────────────────────


class _Client:
    """Stands in for `transport.client.Client`: records the dial, serves nothing."""

    publish_stem_format = "flac"
    dialled = threading.Event()
    order: list[str] = []
    last: _Client

    def __init__(self, **wired: Any) -> None:
        self.wired = wired
        _Client.last = self

    async def serve_forever(self) -> None:
        _Client.order.append("dial")
        _Client.dialled.set()


def boot(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    modules: set[str],
    binaries: set[str],
    routes: Any = None,
) -> tuple[_Client, SimpleNamespace]:
    """Run `__main__.main` with no socket, no DBOS and no models."""
    from encore_worker import __main__ as entry

    adapters = SimpleNamespace(probe=None, diarizer="built")
    _Client.dialled = threading.Event()
    _Client.order = []
    # No warm-up (it would load real models) and no thread pinning (it writes this process's env): both are
    # test_autoconfig's.
    cfg = Config(media_dir=str(tmp_path), warmup=False)
    monkeypatch.setattr(Config, "from_env", staticmethod(lambda: cfg))
    monkeypatch.setattr(hardware, "apply_threads", lambda n: n or None)
    monkeypatch.setattr(hardware, "probe", lambda: hardware.Report(machine="m", python="3", platform="p"))
    monkeypatch.setattr(hardware, "module_available", lambda name: name in modules)
    monkeypatch.setattr(hardware, "binary_available", lambda name: name in binaries)
    monkeypatch.setattr(entry, "_launch_dbos", lambda cfg: None)
    monkeypatch.setattr(entry, "build_adapters", lambda cfg, *, device: adapters)
    monkeypatch.setattr(entry, "Client", _Client)
    monkeypatch.setattr(durable, "register", lambda dbos, **providers: None)
    if routes is not None:
        monkeypatch.setattr(entry, "_routes_described", routes)
    asyncio.run(entry.main())
    return _Client.last, adapters


def test_a_blocked_diarizer_is_off_for_the_process_and_not_advertised(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(ml, "diarizer_blocked", lambda: "gated: set HF_TOKEN")
    client, adapters = boot(monkeypatch, tmp_path, modules={"pyannote.audio"}, binaries=set())
    assert "diarize" not in client.wired["capabilities"]
    assert adapters.diarizer is None
    assert "diarize off: gated: set HF_TOKEN" in capsys.readouterr().out


def test_a_loadable_diarizer_is_kept(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ml, "diarizer_blocked", lambda: None)
    client, adapters = boot(monkeypatch, tmp_path, modules={"pyannote.audio"}, binaries=set())
    assert "diarize" in client.wired["capabilities"]
    assert adapters.diarizer == "built"


def test_boot_warns_when_youtube_cannot_work(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    boot(monkeypatch, tmp_path, modules=set(), binaries={"yt-dlp"})
    assert "WARNING: YouTube downloads will fail without deno on PATH" in capsys.readouterr().out


def test_the_first_dial_does_not_wait_for_the_routes_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The routes line imports torch, transformers and whisperx: 5.5 s that sat in front of every dial."""

    def slow_routes(config: Config) -> str:
        _Client.dialled.wait(timeout=2)
        _Client.order.append("routes")
        return "ja=..."

    boot(monkeypatch, tmp_path, modules=set(), binaries=set(), routes=slow_routes)
    deadline = time.monotonic() + 5
    while len(_Client.order) < 2 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert _Client.order == ["dial", "routes"]
