"""`demucs_pool` against demucs's own `apply_model` (#1130). MARKED `ml`: it needs torch and demucs.

A tiny built-in torch model stands in for htdemucs, so this checks OUR part: that chunks computed in worker
processes, each with its own model, blend to exactly what demucs computes serially, shifts included.
"""

from __future__ import annotations

import functools
import random

import pytest

pytestmark = pytest.mark.ml

torch = pytest.importorskip("torch")
apply = pytest.importorskip("demucs.apply")

from encore_worker.adapters.demucs_pool import ModelProcessPool  # noqa: E402


def tiny_model(*, pads_to_segment: bool = False) -> object:
    """Two sources from a stereo mix, as a model demucs can run: built-in layers, so it pickles anywhere.

    `pads_to_segment` gives it HTDemucs's `valid_length`: a chunk shorter than a segment is padded out to one
    with the song around it, which is what a short final chunk needs from the pool.
    """
    torch.manual_seed(0)
    # A 61-sample kernel, so an output sample hears 30 samples either side: context the pool must ship.
    model = torch.nn.Sequential(torch.nn.Conv1d(2, 4, 61, padding=30), torch.nn.Unflatten(1, (2, 2)))
    model.samplerate, model.segment, model.sources = 100, 1.0, ["vocals", "other"]
    if pads_to_segment:
        model.valid_length = functools.partial(max, 100)
    return model


@pytest.mark.parametrize(
    ("shifts", "pads_to_segment", "length"),
    [(0, False, 950), (1, False, 950), (0, True, 905), (1, True, 905)],
)
def test_chunks_in_processes_blend_to_the_serial_answer(
    shifts: int, pads_to_segment: bool, length: int
) -> None:
    """905 samples leaves a 5-sample final chunk, padded HTDemucs-style from a segment of song around it."""
    model = tiny_model(pads_to_segment=pads_to_segment)
    mix = torch.randn(1, 2, length)
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
