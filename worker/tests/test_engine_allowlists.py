"""`engine_for`'s allowlists are DERIVED from each constructor, not hand-listed.

The four allowlists were literal sets maintained beside the constructors they mirrored. Every one was a
place to forget a parameter, and forgetting one is silent: the engine accepts the knob, the argv builder
uses it, and nothing supplies it. That is exactly how `model_file_dir`, `models_dir` and `batch_size` came
to be unreachable — and how `MlxDemucsEngine.ffmpeg_bin` stayed unreachable after those three were fixed.

The important tests here are the REACHABILITY ones: for every engine, every parameter its constructor
accepts must arrive when passed through `engine_for`. A branch that stopped deriving would go red.
"""

from __future__ import annotations

import inspect
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.config import WorkerConfig, separation_tuning  # noqa: E402
from src.separation.engines import (  # noqa: E402
    _FACTORY_OWNED,
    AudioSepEngine,
    DemucsEngine,
    MlxDemucsEngine,
    RoformerEngine,
    _settable,
    engine_for,
)

#: (class, the `engine_for` name, the backend that selects it)
ENGINES = (
    (DemucsEngine, "demucs", "torch"),
    (MlxDemucsEngine, "demucs", "mlx"),
    (RoformerEngine, "roformer", None),
    (AudioSepEngine, "audiosep", None),
)

#: What the four literal sets carried before this change. Kept so the derivation is PROVEN not to have
#: widened three of them, rather than asserted to have left them alone.
HISTORICAL = {
    "DemucsEngine": {"demucs_bin", "device", "jobs", "overlap", "segment", "shifts", "stem_format"},
    "MlxDemucsEngine": {"overlap", "segment", "shifts", "batch_size"},
    "RoformerEngine": {"roformer_bin", "device", "models_dir"},
    "AudioSepEngine": {"audiosep_bin", "model_file_dir", "stem_format"},
}


def test_the_derivation_did_not_widen_three_of_the_four() -> None:
    """Parity with the hand-written sets, so this is a refactor everywhere it claims to be."""
    for cls in (DemucsEngine, RoformerEngine, AudioSepEngine):
        assert _settable(cls) == HISTORICAL[cls.__name__], (
            f"{cls.__name__}'s settable set changed; the derivation was meant to reproduce it exactly"
        )


def test_the_derivation_widened_mlx_by_exactly_the_two_it_had_been_missing() -> None:
    """The intended change, named. `ffmpeg_bin` is a live bug fix; `mlx_bin` is latent (no caller yet)."""
    gained = _settable(MlxDemucsEngine) - HISTORICAL["MlxDemucsEngine"]
    assert gained == {"ffmpeg_bin", "mlx_bin"}, f"unexpected widening: {gained}"


def test_every_constructor_parameter_is_reachable_through_engine_for() -> None:
    """THE anti-regression test, and not a tautology: it constructs through the factory and reads back.

    A branch that reverted to a literal set would drop whatever the set forgot, and this fails naming it.
    """
    sentinels: dict[str, object] = {
        "demucs_bin": "/s/demucs",
        "mlx_bin": "/s/demucs-mlx",
        "roformer_bin": "/s/bs-roformer-infer",
        "audiosep_bin": "/s/audio-separator",
        "ffmpeg_bin": "/s/ffmpeg",
        "device": "cuda:7",
        "jobs": 3,
        "overlap": 0.11,
        "segment": 9,
        "shifts": 2,
        "batch_size": 5,
        "models_dir": "/s/models",
        "model_file_dir": "/s/models",
    }
    for cls, name, backend in ENGINES:
        params = _settable(cls)
        missing_sentinel = sorted(p for p in params if p not in sentinels and p != "stem_format")
        assert not missing_sentinel, f"add a sentinel for {cls.__name__}'s {missing_sentinel}"
        kwargs = {p: sentinels[p] for p in params if p in sentinels}
        eng = engine_for(name, backend=backend, **kwargs)
        assert type(eng) is cls, f"{name}/{backend} built {type(eng).__name__}"
        # Every sentinel must be findable on the instance. The engines store them under private names
        # (`_bin`, `_ffmpeg`, …), so compare VALUES rather than guessing the attribute for each.
        stored = {v for v in vars(eng).values()}
        for param, value in kwargs.items():
            assert value in stored, f"{cls.__name__} dropped {param}={value!r} — it is unreachable again"


def test_the_factory_never_forwards_what_it_owns() -> None:
    """`default_model` and `backend` must stay out of every derived set.

    `default_model` is the engine's own fallback; the model is a per-job decision resolved against that
    engine's own allowlist, so a second owner could set an unvalidated checkpoint. `backend` is
    `engine_for`'s own named argument — admitting it from kwargs would let a caller override the RESOLVED
    backend, which is what `facts.backend` reports.
    """
    assert {"default_model", "backend"} <= set(_FACTORY_OWNED)
    for cls, _, _ in ENGINES:
        assert "default_model" not in _settable(cls)
        assert "backend" not in _settable(cls)
        # And the parameter really does exist on the constructor, so the exclusion is doing work.
        assert "default_model" in inspect.signature(cls).parameters


def test_a_configured_ffmpeg_reaches_the_mlx_mix_minus_pass() -> None:
    """THE BUG. demucs-mlx has no `--two-stems`, so an ffmpeg mix-minus pass DERIVES the instrumental.

    That pass is the only thing producing `no_vocals.wav` for an mlx separation. It ran bare `ffmpeg`
    regardless of `ENCORE_FFMPEG_BIN`, so on a box where ffmpeg is not on PATH — the reason the override
    exists — every mlx separation failed at the derive step.
    """
    cfg = WorkerConfig.from_env(
        {"ENCORE_CORE_WS": "ws://x", "MEDIA_DIR": "/m", "ENCORE_FFMPEG_BIN": "/opt/homebrew/bin/ffmpeg"}
    )
    kw = separation_tuning(cfg, device=None, backend="mlx", segment=None).engine_kwargs()
    eng = engine_for("demucs", ffmpeg_bin=cfg.ffmpeg_bin, **kw)
    argv = eng.derive_argvs("/w/input.wav", "/o", eng.resolve_model({}))[0]
    assert argv[0] == "/opt/homebrew/bin/ffmpeg", (
        "the mlx instrumental is derived with bare `ffmpeg`, ignoring ENCORE_FFMPEG_BIN"
    )


def test_the_plan_is_what_passes_it_so_the_wiring_is_covered_end_to_end() -> None:
    """Reaching the engine only matters if the real plan does the passing."""
    from src import plans

    cfg = WorkerConfig.from_env(
        {"ENCORE_CORE_WS": "ws://x", "MEDIA_DIR": "/m", "ENCORE_FFMPEG_BIN": "/opt/homebrew/bin/ffmpeg"}
    )
    tune = separation_tuning(cfg, device=None, backend="mlx", segment=None)
    runner = plans.stems_runner(runner=lambda _a: iter(()), ffmpeg_bin=cfg.ffmpeg_bin, tuning=tune)

    from src.processor import JobSpec

    job = JobSpec(
        job_id="j", media_id="m", job_type="stems", source_uri="/x.webm", params={}, media_dir="/media"
    )
    plan = runner._plan_for(job, runner._resolve_engines(job.params))
    eng = next(e for e in (getattr(s, "_engine", None) for s in plan.steps()) if e is not None)
    argv = eng.derive_argvs("/w/input.wav", "/o", eng.resolve_model({}))[0]
    assert argv[0] == "/opt/homebrew/bin/ffmpeg", "stems_runner does not pass ffmpeg_bin into engine_for"


def test_an_unknown_kwarg_is_still_dropped_rather_than_crashing_the_constructor() -> None:
    """The filter's other job: `engine_kwargs()` emits keys for every engine, so each must drop the rest."""
    noise = {"models_dir": "/d", "model_file_dir": "/d", "batch_size": 4, "jobs": 2, "demucs_bin": "/d"}
    for cls, name, backend in ENGINES:
        eng = engine_for(name, backend=backend, **noise)  # must not raise TypeError
        assert type(eng) is cls
