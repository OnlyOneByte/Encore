"""A job's requested DEVICE must reach separation, not just alignment.

`resolve_engines` folds `params['device']` over the worker's configured default into
`ResolvedEngines.device`, and three consumers read that folded value: the transcriber and the aligner
(`steps/lyrics.py`) and the diarizer (`steps/diarize.py`). Separation did not — `plans.pick()` built its
engine from the closure variable instead, i.e. the worker default only.

The consequence was a job that could transcribe on the device it asked for and separate on a different
one, with `facts.device` reporting whatever the engine happened to be constructed with. Nothing failed;
the numbers were just quietly about two different pieces of hardware.

These pin the folded value all the way into the engine. They drive `stems_runner`'s real plan-selection
closure rather than asserting on `resolve_engines` alone, because the defect was entirely in the handoff
BETWEEN the two — a test of either half in isolation passes on the broken code.
"""

from __future__ import annotations

import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import plans  # noqa: E402
from src.processor import JobSpec  # noqa: E402
from src.runtime.ctx import ResolvedEngines  # noqa: E402
from src.separation.tuning import SeparationTuning  # noqa: E402


def _job(params: dict[str, Any]) -> JobSpec:
    return JobSpec(
        job_id="j",
        media_id="m",
        job_type="stems",
        source_uri="/x.webm",
        params=params,
        media_dir="/media",
    )


def _engine_for_job(params: dict[str, Any], *, worker_device: str | None) -> Any:
    """Build the runner exactly as dial_home does, then run its OWN resolve + pick for one job.

    Reaching into `_resolve_engines` / `_plan_for` is deliberate: those are the two closures the
    production path uses, and the bug lived in what one handed the other.
    """
    runner = plans.stems_runner(runner=lambda _argv: iter(()), tuning=SeparationTuning(device=worker_device))
    job = _job(params)
    engines = runner._resolve_engines(job.params)
    plan = runner._plan_for(job, engines)
    # Every separation plan carries Separate, and Separate holds the engine the pick built.
    for step in plan.steps():
        eng = getattr(step, "_engine", None)
        if eng is not None:
            return eng
    raise AssertionError("no step on the plan carries an engine")


def test_the_jobs_device_reaches_the_separator_engine() -> None:
    """THE regression: `params['device']` must win over the worker's configured default."""
    eng = _engine_for_job({"device": "cuda:1"}, worker_device="cpu")
    assert eng._device == "cuda:1", (
        "separation built its engine from the worker default, so a job asking for one device would "
        "transcribe on it and separate somewhere else"
    )


def test_the_worker_default_still_applies_when_the_job_asks_for_nothing() -> None:
    """The fold's other half — an absent param keeps the box's own resolved device."""
    eng = _engine_for_job({}, worker_device="cuda")
    assert eng._device == "cuda"


def test_resolve_engines_folds_the_device_the_same_way_pick_now_reads_it() -> None:
    """Belt and braces: the two halves agree, so neither can drift without a red test."""
    folded = plans.resolve_engines({"device": "mps"}, ResolvedEngines(device="cpu"))
    assert folded.device == "mps"
    assert plans.resolve_engines({}, ResolvedEngines(device="cpu")).device == "cpu"


def test_resolved_engines_no_longer_carries_a_separator_model() -> None:
    """The dead field is gone, and must not come back as a second owner of the checkpoint.

    `Separate` resolves the model with `engine.resolve_model(ctx.params)`, which validates the request
    against THAT engine's allowlist. A shared `separator_model` string could only ever hold a token
    nobody checked, and it was read by nothing.
    """
    assert not hasattr(ResolvedEngines(), "separator_model")


# ── SeparationTuning: one value for the nine knobs ────────────────────────────────────────────────


def test_tuning_is_frozen_so_a_plan_closure_cannot_retune_the_box() -> None:
    """It is threaded through several layers; a mutable one would let one job change every later job."""
    import dataclasses

    import pytest

    with pytest.raises(dataclasses.FrozenInstanceError):
        SeparationTuning().device = "cuda"  # type: ignore[misc]


def test_engine_kwargs_covers_every_knob_engine_for_can_honour() -> None:
    """The whole point: adding a knob is ONE edit, and this is what proves the kwarg reaches the factory.

    Nine parameters at four sites is how `model_file_dir`, `models_dir` and `batch_size` came to exist on
    the engines while being reachable from nowhere.
    """
    kw = SeparationTuning(
        model="htdemucs_ft",
        demucs_bin="/opt/demucs",
        device="cuda:2",
        backend="torch",
        jobs=4,
        overlap=0.1,
        segment=7,
        shifts=2,
    ).engine_kwargs()
    assert kw["demucs_model"] == "htdemucs_ft"
    assert kw["demucs_bin"] == "/opt/demucs"
    assert kw["device"] == "cuda:2"
    assert kw["backend"] == "torch"
    assert (kw["jobs"], kw["overlap"], kw["segment"], kw["shifts"]) == (4, 0.1, 7, 2)


def test_a_per_job_device_overrides_the_workers_own() -> None:
    """`resolve_engines` folds params['device'] over the box's; this is where that answer lands."""
    tune = SeparationTuning(device="cpu")
    assert tune.engine_kwargs(device="mps")["device"] == "mps"
    assert tune.engine_kwargs(device=None)["device"] == "cpu", "None must KEEP the worker's device"


def test_config_builds_the_tuning_from_one_place() -> None:
    """`config.separation_tuning` is the single owner of these values."""
    from src.host.config import WorkerConfig, separation_tuning

    cfg = WorkerConfig.from_env({"ENCORE_CORE_WS": "ws://x", "MEDIA_DIR": "/m", "ENCORE_DEMUCS_JOBS": "3"})
    tune = separation_tuning(cfg, device="cuda", backend="torch", segment=11)
    assert (tune.jobs, tune.device, tune.backend, tune.segment) == (3, "cuda", "torch", 11)
    assert tune.model == cfg.demucs_model and tune.stem_format is cfg.stem_format
