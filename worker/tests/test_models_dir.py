"""`ENCORE_MODELS_DIR`: one setting, reaching two CLIs that spell it differently.

`roformer_argv` and `audiosep_argv` have always ACCEPTED a checkpoint-cache directory. Nothing ever
passed one. The roformer path was dead at two levels — `RoformerEngine.__init__` had no such parameter and
`engine_for`'s allowlist did not carry it — and audiosep's was dead at one: the allowlist permitted
`model_file_dir` but no caller supplied it.

The cost is operational, not a crash. Both CLIs auto-download their checkpoint on FIRST USE (roughly
700 MB for roformer, hundreds of MB for audiosep) and each takes a flag saying where to keep it. Unset,
each uses its own default location — which inside a container is the container filesystem unless that path
happens to be a mounted volume, so the download repeats on every fresh container.

These tests pin the whole path, because every link in it was individually plausible and collectively
useless.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.host.config import WorkerConfig, separation_tuning  # noqa: E402
from src.separation.engines import engine_for  # noqa: E402
from src.separation.tuning import SeparationTuning  # noqa: E402

#: (engine id, the flag THAT CLI uses, the input path shape its argv builder expects)
CLIS = (
    ("roformer", "--models_dir", "/w/roformer_in/input.wav"),
    ("audiosep", "--model_file_dir", "/w/input.wav"),
)


def _argv(name: str, tune: SeparationTuning, input_wav: str) -> list[str]:
    eng = engine_for(name, **tune.engine_kwargs())
    return eng.separate_argv(input_wav, "/o", eng.resolve_model({}))


def test_one_setting_reaches_both_cli_spellings() -> None:
    """The point. audio-separator wants `--model_file_dir`, bs-roformer-infer wants `--models_dir`; that
    is the CLIs' disagreement, not the operator's, so one value emits both keys and `engine_for`'s
    per-engine allowlist keeps whichever applies."""
    tune = SeparationTuning(models_dir="/mnt/models")
    for name, flag, path in CLIS:
        argv = _argv(name, tune, path)
        assert flag in argv, f"{name} never receives its checkpoint cache dir — the download repeats"
        assert argv[argv.index(flag) + 1] == "/mnt/models"


def test_unset_invents_no_directory() -> None:
    """Absent means "let the CLI use its own default", not a path this worker made up."""
    tune = SeparationTuning()
    for name, flag, path in CLIS:
        assert flag not in _argv(name, tune, path), f"{name} got a fabricated {flag}"


def test_engine_kwargs_emits_both_keys_so_the_allowlist_can_choose() -> None:
    kw = SeparationTuning(models_dir="/d").engine_kwargs()
    assert kw["models_dir"] == "/d" and kw["model_file_dir"] == "/d"


def test_the_env_var_reaches_the_tuning() -> None:
    cfg = WorkerConfig.from_env(
        {"ENCORE_CORE_WS": "ws://x", "MEDIA_DIR": "/m", "ENCORE_MODELS_DIR": "/mnt/ckpt"}
    )
    assert cfg.models_dir == "/mnt/ckpt"
    tune = separation_tuning(cfg, device="cpu", backend="torch", segment=None)
    assert tune.models_dir == "/mnt/ckpt"


def test_it_is_not_defaulted_under_the_media_volume() -> None:
    """Deliberate: defaulting it under MEDIA_DIR would write hundreds of MB of weights into a volume
    whose eviction cap (ENCORE_MEDIA_MAX_GB) knows nothing about model files, on a box whose operator
    never asked for it."""
    cfg = WorkerConfig.from_env({"ENCORE_CORE_WS": "ws://x", "MEDIA_DIR": "/m"})
    assert cfg.models_dir is None


def test_a_blank_env_value_is_treated_as_unset() -> None:
    for blank in ("", "   "):
        cfg = WorkerConfig.from_env(
            {"ENCORE_CORE_WS": "ws://x", "MEDIA_DIR": "/m", "ENCORE_MODELS_DIR": blank}
        )
        assert cfg.models_dir is None, f"{blank!r} became a directory"


def test_demucs_does_not_receive_a_flag_it_has_no_use_for() -> None:
    """demucs caches through torch.hub, not a CLI flag, so the allowlist must drop these keys for it."""
    eng = engine_for("demucs", **SeparationTuning(models_dir="/d").engine_kwargs())
    argv = eng.separate_argv("/w/input.wav", "/o", eng.resolve_model({}))
    assert "--models_dir" not in argv and "--model_file_dir" not in argv
