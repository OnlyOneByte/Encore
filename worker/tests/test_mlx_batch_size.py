"""`ENCORE_MLX_BATCH_SIZE`: reachable at last, and deliberately without a default.

`MlxDemucsEngine` accepted a `batch_size` and `mlx_argv` emitted `-b`, but `engine_for`'s mlx allowlist
never carried it, so no caller could supply one — the flag was unreachable in production.

The interesting assertions here are the NEGATIVE ones. Unset must emit no flag, junk and sub-minimum
values must warn and behave as unset, and the three engines whose CLIs have no such flag must never see
it. That last one is what the per-engine allowlist is for, and it is the property a shared tuning object
puts at risk.

There is no test asserting a particular default, because there is deliberately no default: see
`docs/benchmarks/SUMMARY.md` §7. The repo's only batching measurement is §2 (BS-RoFormer on the Graviton
box, 1.02x, "32 cores already saturate at batch 1") and its own reasoning says it does not transfer to
Metal. `docs/benchmarks/scripts/mlx_batch_bench.sh` is what would justify a value.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.host.config import WorkerConfig, separation_tuning  # noqa: E402
from src.separation.engines import engine_for  # noqa: E402
from src.separation.tuning import SeparationTuning  # noqa: E402


def _cfg(**env: str) -> WorkerConfig:
    return WorkerConfig.from_env({"ENCORE_CORE_WS": "ws://x", "MEDIA_DIR": "/m", **env})


def _mlx_argv(tune: SeparationTuning) -> list[str]:
    eng = engine_for("demucs", **tune.engine_kwargs())
    return eng.separate_argv("/w/input.wav", "/o", eng.resolve_model({}))


def test_a_set_batch_size_reaches_the_mlx_argv() -> None:
    argv = _mlx_argv(SeparationTuning(backend="mlx", mlx_batch_size=4))
    assert "-b" in argv, "demucs-mlx never receives -b; the knob is unreachable again"
    assert argv[argv.index("-b") + 1] == "4"


def test_unset_emits_no_flag_at_all() -> None:
    """Unset means demucs-mlx's own default, not a value this worker invented."""
    assert "-b" not in _mlx_argv(SeparationTuning(backend="mlx"))


def test_there_is_no_default_batch_size() -> None:
    """Pinned on purpose. A default needs a measurement, and SUMMARY.md §7 records that there is none."""
    assert SeparationTuning().mlx_batch_size is None
    assert _cfg().mlx_batch_size is None


def test_junk_and_sub_minimum_values_warn_and_behave_as_unset() -> None:
    """A batch size below 1 is meaningless; neither case may silently become a flag."""
    for raw in ("0", "-2", "junk", "2.5"):
        cfg = _cfg(ENCORE_MLX_BATCH_SIZE=raw)
        assert cfg.mlx_batch_size is None, f"{raw!r} became a batch size"
        assert any("ENCORE_MLX_BATCH_SIZE" in w for w in cfg.warnings), (
            f"{raw!r} was dropped SILENTLY — an operator who set it deserves to be told it did nothing"
        )


def test_a_blank_value_is_unset_and_does_not_warn() -> None:
    """Empty is not a mistake, it is absence — warning about it would be noise at every boot."""
    cfg = _cfg(ENCORE_MLX_BATCH_SIZE="  ")
    assert cfg.mlx_batch_size is None
    assert not any("ENCORE_MLX_BATCH_SIZE" in w for w in cfg.warnings)


def test_the_env_var_reaches_the_tuning() -> None:
    cfg = _cfg(ENCORE_MLX_BATCH_SIZE="8")
    tune = separation_tuning(cfg, device=None, backend="mlx", segment=None)
    assert tune.mlx_batch_size == 8
    assert tune.engine_kwargs()["batch_size"] == 8


def test_it_never_leaks_to_an_engine_whose_CLI_has_no_such_flag() -> None:
    """THE risk a shared tuning object creates, and what `engine_for`'s per-engine allowlist is for.

    Only demucs-mlx takes `-b`. torch demucs, bs-roformer-infer and audio-separator do not, and handing
    one an unknown flag is a non-retryable argv failure at separation time.
    """
    cfg = _cfg(ENCORE_MLX_BATCH_SIZE="4")
    torch_kw = separation_tuning(cfg, device="cpu", backend="torch", segment=None).engine_kwargs()

    torch_eng = engine_for("demucs", **torch_kw)
    assert "-b" not in torch_eng.separate_argv("/w/input.wav", "/o", torch_eng.resolve_model({}))

    for name in ("roformer", "audiosep"):
        eng = engine_for(name, **torch_kw)
        argv = eng.separate_argv("/w/roformer_in/input.wav", "/o", eng.resolve_model({}))
        assert "-b" not in argv, f"{name} received demucs-mlx's batch flag"


def test_the_field_is_named_for_its_engine() -> None:
    """`mlx_batch_size`, not `batch_size` — the name should not imply four engines honour it."""
    assert hasattr(SeparationTuning(), "mlx_batch_size")
    assert not hasattr(SeparationTuning(), "batch_size"), (
        "a bare `batch_size` field reads as a knob every engine takes; only demucs-mlx does"
    )


def test_the_benchmark_script_exists_and_refuses_non_apple_silicon() -> None:
    """The script is the thing that would justify a default, so it is part of this change, not a TODO."""
    from pathlib import Path

    script = Path(__file__).resolve().parents[2] / "docs" / "benchmarks" / "scripts" / "mlx_batch_bench.sh"
    assert script.exists(), "the benchmark that would justify a default is missing"
    body = script.read_text(encoding="utf-8")
    assert "Darwin" in body and "arm64" in body, "it must refuse a box demucs-mlx cannot run on"
    assert "maximum resident set size" in body, "peak memory is half the result — batching trades for it"
