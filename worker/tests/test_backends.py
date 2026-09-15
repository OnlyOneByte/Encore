"""Backend selection: auto-probing, explicit refusal, and device resolution.

Hardware-independent by construction. The accelerated paths (MLX on Apple Silicon, torch on Intel Arc
via IPEX) cannot run on this aarch64 Linux CPU box, so availability probes are monkeypatched to assert
the DECISION logic rather than the hardware. What is genuinely verified here: torch/cpu is always
reachable, an explicit unavailable backend RAISES instead of silently downgrading, and an unknown
value is rejected at the boundary.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.host import backends  # noqa: E402
from src.host.backends import BackendChoice, resolve_backend  # noqa: E402
from src.vocabulary import Backend, Engine  # noqa: E402


# ── this box: torch/cpu, nothing accelerated ─────────────────────────────────────
def test_torch_is_always_available():
    assert backends.backend_available(Backend.TORCH) is True


def test_openvino_never_reports_available_without_a_ported_pipeline():
    # Intel ships IR weights with STFT/iSTFT stripped for a C++ pipeline; there is no Python path.
    assert backends.backend_available(Backend.OPENVINO) is False


def test_auto_selects_torch_on_this_box():
    choice = resolve_backend(None)
    assert isinstance(choice, BackendChoice)
    assert choice.backend is Backend.TORCH
    assert "torch" in choice.reason


def test_cpu_and_empty_devices_are_always_available():
    assert backends.torch_device_available("cpu") is True
    assert backends.torch_device_available("") is True


# ── explicit requests never silently downgrade ────────────────────────────────────
def test_explicit_unavailable_backend_raises_rather_than_falling_back(monkeypatch):
    monkeypatch.setattr(backends, "backend_available", lambda b, e=Engine.DEMUCS: b is Backend.TORCH)
    with pytest.raises(ValueError, match="not available for engine"):
        resolve_backend("mlx")


def test_unknown_backend_is_rejected_at_the_boundary():
    with pytest.raises(ValueError, match="unknown backend"):
        resolve_backend("cuda")  # a DEVICE, not a backend


def test_explicit_unavailable_device_raises(monkeypatch):
    monkeypatch.setattr(backends, "torch_device_available", lambda d: d in ("", "cpu"))
    with pytest.raises(ValueError, match="not available on this worker"):
        backends.preferred_torch_device("xpu")


# ── auto device probing ───────────────────────────────────────────────────────────
def test_auto_device_prefers_accelerators_in_order(monkeypatch):
    monkeypatch.setattr(backends, "torch_device_available", lambda d: d in ("xpu", "cpu", ""))
    device, reason = backends.preferred_torch_device(None)
    assert device == "xpu"  # Arc picked up when cuda is absent
    assert "auto-detected" in reason


def test_auto_device_falls_back_to_none_when_no_accelerator(monkeypatch):
    monkeypatch.setattr(backends, "torch_device_available", lambda d: d in ("", "cpu"))
    device, reason = backends.preferred_torch_device(None)
    assert device is None  # let the separator CLI choose its own default
    assert "no accelerator" in reason


def test_explicit_available_device_is_honoured(monkeypatch):
    monkeypatch.setattr(backends, "torch_device_available", lambda d: True)
    device, reason = backends.preferred_torch_device("xpu")
    assert device == "xpu"
    assert "explicitly configured" in reason


# ── MLX is engine-scoped and platform-gated ───────────────────────────────────────
def test_mlx_is_only_offered_for_demucs_and_only_on_apple_silicon(monkeypatch):
    monkeypatch.setattr(backends, "_module_available", lambda name: True)
    monkeypatch.setattr(backends, "is_apple_silicon", lambda: True)
    assert backends.backend_available(Backend.MLX, Engine.DEMUCS) is True
    # demucs-mlx does not implement roformer, so it must not be advertised for it
    assert backends.backend_available(Backend.MLX, Engine.ROFORMER) is False
    # and off Apple hardware the Metal speedup that justifies it does not exist
    monkeypatch.setattr(backends, "is_apple_silicon", lambda: False)
    assert backends.backend_available(Backend.MLX, Engine.DEMUCS) is False


def test_auto_prefers_mlx_when_genuinely_available(monkeypatch):
    monkeypatch.setattr(
        backends, "backend_available", lambda b, e=Engine.DEMUCS: b in (Backend.MLX, Backend.TORCH)
    )
    choice = resolve_backend(None)
    assert choice.backend is Backend.MLX
    assert choice.device is None  # MLX owns its own execution; no torch device applies
