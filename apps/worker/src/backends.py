"""Backend selection: how a separator engine executes on THIS worker's hardware.

Engine and backend are different axes. The room picks the ENGINE (an audible choice — demucs vs
roformer vs ensemble). The BACKEND is a property of the box the worker runs on and is never
user-visible: the same `demucs` engine runs through PyTorch on a Linux/CUDA box and through MLX on
Apple Silicon, producing the same stems either way.

Two rules make this safe to deploy on hardware nobody has tested yet:

  * AUTO probes. `resolve_backend(None, ...)` picks the best backend that is genuinely importable and
    whose device is genuinely present, falling back to TORCH/cpu which works everywhere.
  * EXPLICIT never downgrades. An operator who asks for MLX on a box without MLX gets a raise, not a
    silent CPU cook that looks fine and takes 50x longer. A misconfiguration should be loud.

Availability is probed, never assumed from the platform string: an aarch64 Linux box and an Apple
Silicon Mac both report `arm64`-ish machines, and an x86_64 box may or may not have an Intel GPU.
"""
from __future__ import annotations

import importlib.util
import platform
from dataclasses import dataclass

from .vocabulary import Backend, Engine


def _module_available(name: str) -> bool:
    """True when `name` can be imported without importing it (no torch load, no model download)."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def torch_device_available(device: str) -> bool:
    """Whether a torch device string is actually usable here. Importing torch is unavoidable to ask.

    `xpu` is Intel's device (Arc / Iris Xe) and needs intel-extension-for-pytorch loaded before torch
    exposes it, so IPEX is imported first when present. That import is what registers the backend;
    without it a perfectly good Arc card reports as absent.
    """
    if device in ("", "cpu"):
        return True
    try:
        if device.startswith("xpu") and _module_available("intel_extension_for_pytorch"):
            import intel_extension_for_pytorch  # noqa: F401 — import registers the xpu backend
        import torch
    except Exception:
        return False
    try:
        if device.startswith("cuda"):
            return bool(torch.cuda.is_available())
        if device.startswith("xpu"):
            return bool(getattr(torch, "xpu", None) and torch.xpu.is_available())
        if device == "mps":
            return bool(torch.backends.mps.is_available())
    except Exception:
        return False
    return False


def is_apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine() in ("arm64", "aarch64")


def backend_available(backend: Backend, engine: Engine = Engine.DEMUCS) -> bool:
    """Whether this worker can actually run `engine` through `backend` right now."""
    if backend is Backend.TORCH:
        # The portable path: demucs/roformer CLIs ride torch, which is a pinned dependency.
        return True
    if backend is Backend.MLX:
        # demucs-mlx is a distinct implementation and only covers the demucs family. Its own docs
        # describe Metal-free fallbacks off Apple hardware, but the speedup that justifies it is
        # Metal, so it is only advertised where MLX imports AND the machine is Apple Silicon.
        return engine is Engine.DEMUCS and _module_available("demucs_mlx") and is_apple_silicon()
    if backend is Backend.OPENVINO:
        # Intel publishes IR weights with STFT/iSTFT stripped for a C++ pipeline; there is no Python
        # inference path to call. Registered so configuration and routing can name it, but it never
        # reports available until that pipeline is ported.
        return False
    return False


#: Preference order for AUTO selection: fastest first, portable last.
_AUTO_ORDER: tuple[Backend, ...] = (Backend.MLX, Backend.TORCH)


@dataclass(frozen=True)
class BackendChoice:
    """The resolved execution plan for a separation job on this worker."""

    backend: Backend
    device: str | None  # torch device string; None lets the underlying CLI choose
    reason: str  # why this was chosen — printed at startup so a slow box explains itself


def preferred_torch_device(configured: str | None) -> tuple[str | None, str]:
    """Resolve the torch device, honouring an explicit setting and otherwise probing accelerators.

    Returns (device, reason). An explicit device is validated, not trusted: asking for `xpu` on a box
    with no Intel GPU raises rather than quietly running on CPU, because the whole point of setting it
    was to get the accelerator.
    """
    if configured:
        if not torch_device_available(configured):
            raise ValueError(
                f"torch device {configured!r} is not available on this worker; "
                "leave ENCORE_DEMUCS_DEVICE unset to auto-select, or install the matching runtime"
            )
        return configured, f"explicitly configured device {configured}"
    for device in ("cuda", "xpu", "mps"):
        if torch_device_available(device):
            return device, f"auto-detected {device}"
    return None, "no accelerator detected; letting the separator default to CPU"


def resolve_backend(
    configured: str | None,
    *,
    engine: Engine = Engine.DEMUCS,
    device: str | None = None,
) -> BackendChoice:
    """Pick the backend for `engine` on this worker.

    `configured` None/empty means AUTO. An explicit backend that is unavailable raises, so a
    deployment misconfiguration surfaces at worker startup rather than as mysteriously slow cooks.
    """
    if configured:
        backend = Backend(configured) if configured in {b.value for b in Backend} else None
        if backend is None:
            raise ValueError(
                f"unknown backend {configured!r}; expected one of {[b.value for b in Backend]}"
            )
        if not backend_available(backend, engine):
            raise ValueError(
                f"backend {backend.value!r} is not available for engine {engine.value!r} on this "
                "worker; leave ENCORE_SEPARATOR_BACKEND unset to auto-select"
            )
        if backend is Backend.MLX:
            return BackendChoice(backend, None, "explicitly configured mlx")
        dev, why = preferred_torch_device(device)
        return BackendChoice(backend, dev, f"explicitly configured torch ({why})")

    for candidate in _AUTO_ORDER:
        if not backend_available(candidate, engine):
            continue
        if candidate is Backend.MLX:
            return BackendChoice(candidate, None, "auto-selected mlx (Apple Silicon)")
        dev, why = preferred_torch_device(device)
        return BackendChoice(candidate, dev, f"auto-selected torch ({why})")

    # TORCH is always available, so this is unreachable in practice; kept so the function is total.
    return BackendChoice(Backend.TORCH, None, "fallback to torch")
