"""Importing the worker turns onnxruntime's telemetry off before anything loads it (#1307)."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import encore_worker

_CHILD = """
import importlib.util, os
import encore_worker
print(os.environ.get("ORT_DISABLE_TELEMETRY"))
if importlib.util.find_spec("onnxruntime") is not None:
    import onnxruntime  # noqa: F401
    print("ort")
"""


def _run(tmp_path: Path, **extra: str) -> list[str]:
    root = str(Path(encore_worker.__file__).resolve().parents[1])
    env = {k: v for k, v in os.environ.items() if k != "ORT_DISABLE_TELEMETRY"}
    env.update(PYTHONPATH=os.pathsep.join(filter(None, [root, env.get("PYTHONPATH")])), **extra)
    done = subprocess.run(
        [sys.executable, "-c", _CHILD], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=120
    )
    assert done.returncode == 0, done.stderr
    return done.stdout.split()


def test_importing_the_worker_turns_telemetry_off_and_leaves_no_session_file(tmp_path: Path) -> None:
    out = _run(tmp_path)
    assert out[0] == "1"
    assert not list(tmp_path.glob("*.ses")), "onnxruntime wrote its telemetry session file"


def test_an_operator_can_still_turn_it_back_on(tmp_path: Path) -> None:
    assert _run(tmp_path, ORT_DISABLE_TELEMETRY="0")[0] == "0"
