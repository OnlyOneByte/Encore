"""Importing the worker turns onnxruntime's telemetry off before anything loads it (#1307)."""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

import encore_worker

_CHILD = """
import importlib.util, os
import encore_worker
print(os.environ.get("ORT_DISABLE_TELEMETRY"))
if importlib.util.find_spec("onnxruntime") is not None:
    import onnxruntime  # noqa: F401
"""

needs_ort = pytest.mark.skipif(importlib.util.find_spec("onnxruntime") is None, reason="needs onnxruntime")


def _run(tmp_path: Path, **extra: str) -> str:
    """The child's flag. Its cwd, HOME and cache sit under `tmp_path`, where telemetry would write."""
    root = str(Path(encore_worker.__file__).resolve().parents[1])
    env = {k: v for k, v in os.environ.items() if k != "ORT_DISABLE_TELEMETRY"}
    env.update(
        PYTHONPATH=os.pathsep.join(filter(None, [root, env.get("PYTHONPATH")])),
        HOME=str(tmp_path / "home"),
        XDG_CACHE_HOME=str(tmp_path / "cache"),
        **extra,
    )
    cwd = tmp_path / "cwd"
    for d in (cwd, tmp_path / "home", tmp_path / "cache"):
        d.mkdir()
    done = subprocess.run(
        [sys.executable, "-c", _CHILD], cwd=cwd, env=env, capture_output=True, text=True, timeout=120
    )
    assert done.returncode == 0, done.stderr
    return done.stdout.split()[0]


def _telemetry_files(tmp_path: Path) -> list[Path]:
    return [*tmp_path.rglob(".onnxruntime"), *tmp_path.rglob("*.ses")]


def test_importing_the_worker_turns_telemetry_off_and_writes_nothing(tmp_path: Path) -> None:
    assert _run(tmp_path) == "1"
    assert not _telemetry_files(tmp_path), "onnxruntime's telemetry wrote its files"


def test_an_operator_can_still_turn_it_back_on(tmp_path: Path) -> None:
    assert _run(tmp_path, ORT_DISABLE_TELEMETRY="0") == "0"


@needs_ort
def test_with_telemetry_on_the_files_appear(tmp_path: Path) -> None:
    """The check above can see what it guards against: with the flag off, onnxruntime writes them."""
    _run(tmp_path, ORT_DISABLE_TELEMETRY="0")
    assert _telemetry_files(tmp_path)
