"""The ML adapter's PURE parts, in the fast suite — no models, no torch, no downloads.

WHY THIS IS SEPARATE FROM `test_ml_real.py`. Those tests are marked `ml` and deselected by default, so
leaving the device policy covered only there would mean the suite that runs on every edit could not catch
a regression in the very code written to fix a bug. The policy is a pure function over strings; there is
no reason for it to need a model.

It also pins the property that makes this file possible: `adapters/ml.py` has NO heavy imports at module
level. Every `torch`/`whisperx`/`pyannote` import is inside a function, which is what lets a box with no ML
installed import the module, resolve capabilities, and decline the work rather than crashing at startup.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from encore_worker.adapters.ml import (
    CTRANSLATE2_DEVICES,
    ModelUnavailable,
    clear_cache,
    transcriber_device,
)

#: Packages that cost seconds and hundreds of megabytes to import.
HEAVY = frozenset({"torch", "torchaudio", "torchvision", "whisperx", "pyannote", "demucs", "mlx"})


# ── the device policy ────────────────────────────────────────────────────────────────────────────


def test_mps_is_resolved_to_cpu_for_the_transcriber() -> None:
    """THE bug. torch reports MPS available on every Apple Silicon box, so a single globally-resolved
    device hands whisperx's CTranslate2 transcriber `mps` — and it raises `ValueError: unsupported device
    mps`. That raise comes out of the MANDATORY ASR fallback, the one path that must never fail, so it
    would have broken lyrics for every song on every Mac.
    """
    assert transcriber_device("mps") == "cpu"


@pytest.mark.parametrize("device", ["cpu", "cuda"])
def test_a_supported_device_passes_through(device: str) -> None:
    assert transcriber_device(device) == device
    assert device in CTRANSLATE2_DEVICES


@pytest.mark.parametrize("device", ["mps", "xpu", "rocm", "vulkan", "", "MPS", "CUDA"])
def test_anything_ctranslate2_does_not_know_falls_back_to_cpu(device: str) -> None:
    """Fail-safe rather than fail-closed, deliberately: a device the transcriber cannot use should cost
    speed, not the whole ASR tier. Note the case sensitivity — `CUDA` is not `cuda` to CTranslate2, so it
    resolves to cpu rather than being silently normalised into something that might not work.
    """
    assert transcriber_device(device) == "cpu"


def test_the_supported_set_excludes_mps_explicitly() -> None:
    """Pinned as data, so a future edit that adds `mps` to the tuple has to confront this test rather than
    quietly reintroduce the failure."""
    assert "mps" not in CTRANSLATE2_DEVICES
    assert set(CTRANSLATE2_DEVICES) == {"cpu", "cuda"}


def test_the_aligner_is_deliberately_not_restricted_to_those_devices() -> None:
    """The asymmetry that made a per-component policy necessary rather than one global device: the aligner
    is plain torch wav2vec2 and runs on Metal; only the transcriber is CTranslate2. `build_aligner` takes
    the device unchanged, which `test_ml_real` proves works on mps against a real model.
    """
    import inspect

    from encore_worker.adapters import ml

    source = inspect.getsource(ml.build_aligner)
    assert "transcriber_device" not in source, (
        "the aligner must not be narrowed by the transcriber's device policy — it supports mps"
    )


# ── laziness, which is what makes a no-ML box work at all ────────────────────────────────────────


def test_no_heavy_import_happens_at_module_level() -> None:
    """`import torch` costs seconds and several hundred megabytes of resident memory, paid at process start
    on a box that may only ever serve fetch jobs. It is also what lets this whole suite import the module
    with no ML installed — including this file.

    Checked by reading the AST rather than by importing, because an import-based check would itself pay the
    cost it is asserting against.
    """
    tree = ast.parse(Path(__file__).parent.parent.joinpath("encore_worker/adapters/ml.py").read_text())
    offenders: list[str] = []
    for node in tree.body:  # module level only; a nested import is the point of the design
        if isinstance(node, ast.Import):
            offenders += [a.name for a in node.names if a.name.split(".")[0] in HEAVY]
        elif isinstance(node, ast.ImportFrom) and node.module:
            if node.module.split(".")[0] in HEAVY:
                offenders.append(node.module)
    assert not offenders, f"these must be imported lazily inside a function: {offenders}"


def test_the_separator_adapter_is_lazy_too() -> None:
    """Same reasoning: a box serving only align jobs should not pay for demucs at startup."""
    tree = ast.parse(Path(__file__).parent.parent.joinpath("encore_worker/adapters/separate.py").read_text())
    offenders = [
        a.name
        for node in tree.body
        if isinstance(node, ast.Import)
        for a in node.names
        if a.name.split(".")[0] in HEAVY
    ]
    assert not offenders, f"these must be imported lazily: {offenders}"


# ── the cache and the failure type ───────────────────────────────────────────────────────────────


def test_clearing_the_cache_needs_no_models() -> None:
    """An operator reclaiming VRAM should not have to restart the worker, and the call must be safe on a
    box that never loaded anything."""
    clear_cache()
    clear_cache()


def test_a_missing_model_is_not_retryable() -> None:
    """A missing package or an absent checkpoint is not fixed by trying again, and spending three attempts
    proving it delays the fallback that would have worked."""
    assert ModelUnavailable.retryable is False


def test_builders_return_none_rather_than_raising_when_ml_is_absent() -> None:
    """`host.capabilities` already declines to advertise `align` on such a box; a builder that raised would
    turn a capability question into a crash at startup.

    Skipped when ML IS installed, because then there is no absence to observe — and a test that quietly
    asserts nothing is worse than one that says why it did not run.
    """
    from encore_worker.adapters.ml import build_aligner, build_transcriber
    from encore_worker.host.hardware import module_available

    if module_available("whisperx"):
        pytest.skip("whisperx is installed, so the absent-ML path cannot be observed here")
    assert build_transcriber(device="cpu", checkpoint="base") is None
    assert build_aligner(device="cpu") is None
