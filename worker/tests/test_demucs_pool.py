"""`demucs_pool` against demucs's own `apply_model` (#1130). MARKED `ml`: it needs torch and demucs.

A tiny built-in torch model stands in for htdemucs, so this checks OUR part: that chunks computed in worker
processes, each with its own model, blend to exactly what demucs computes serially, shifts included.
"""

from __future__ import annotations

import random

import pytest

pytestmark = pytest.mark.ml

torch = pytest.importorskip("torch")
apply = pytest.importorskip("demucs.apply")

from encore_worker.adapters.demucs_pool import ModelProcessPool  # noqa: E402


def tiny_model() -> object:
    """Two sources from a stereo mix, as a model demucs can run: built-in layers, so it pickles anywhere."""
    torch.manual_seed(0)
    model = torch.nn.Sequential(torch.nn.Conv1d(2, 4, 5, padding=2), torch.nn.Unflatten(1, (2, 2)))
    model.samplerate, model.segment, model.sources = 100, 1.0, ["vocals", "other"]
    return model


@pytest.mark.parametrize("shifts", [0, 1])
def test_chunks_in_processes_blend_to_the_serial_answer(shifts: int) -> None:
    model = tiny_model()
    mix = torch.randn(1, 2, 950)
    random.seed(0)
    serial = apply.apply_model(model, mix, shifts=shifts, split=True, overlap=0.25, device="cpu")
    pool = ModelProcessPool(2)
    try:
        random.seed(0)
        pooled = apply.apply_model(model, mix, shifts=shifts, split=True, overlap=0.25, pool=pool)
    finally:
        pool.shutdown()
    assert pooled.shape == serial.shape
    assert torch.allclose(pooled, serial, atol=1e-6)
