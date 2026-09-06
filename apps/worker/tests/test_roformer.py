"""Roformer engine pure helpers + engine routing. The real BSRoformerSession cook is
REAL-ML/NET and unverified in this environment (see roformer.py's module warning), so these cover the
argv-free logic: model-token→slug resolution, output-stem discovery, and engine selection.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.separation import roformer  # noqa: E402


def test_every_whitelist_token_resolves_to_a_real_registry_slug():
    """The assertion this replaces checked only that a slug STARTED WITH "roformer-model-", which a
    nonexistent slug satisfies — and one duly shipped (`mel-roformer-inst-v2` mapped to a slug absent
    from the registry). Check membership in the registry's actual slug set instead."""
    for token in roformer.ROFORMER_MODELS:
        slug = roformer.resolve_roformer_slug({"model": token})
        assert slug in roformer.ROFORMER_REGISTRY_SLUGS, f"{token} → {slug} is not a real slug"


def test_mel_band_tokens_are_not_offered():
    """bs_roformer's get_model_from_config implements only model_type == 'bs_roformer' and the package
    ships no mel_band module, so a mel-band token would be unrunnable however it were mapped."""
    assert not [t for t in roformer.ROFORMER_MODELS if "mel" in t]
    with pytest.raises(ValueError, match="unknown roformer model"):
        roformer.resolve_roformer_slug({"model": "mel-roformer-inst-v2"})


def test_every_whitelist_token_has_a_measured_cost():
    """A token without a cost entry silently loses its measured overlap/precision, which is how a
    checkpoint ends up running at a default nobody chose."""
    for token in roformer.ROFORMER_MODELS:
        cost = roformer.roformer_cost(token)
        assert cost is not None, f"{token} has no measured cost"
        assert cost["overlap"] >= 1
        assert cost["precision"] in ("fp32", "bf16")


def test_roformer_cost_is_none_for_unknown_token():
    assert roformer.roformer_cost("nope") is None


def test_resolve_roformer_slug_defaults_when_unset():
    assert roformer.resolve_roformer_slug({}) == roformer.ROFORMER_MODELS[roformer.DEFAULT_ROFORMER_MODEL]


def test_resolve_roformer_slug_rejects_unknown():
    with pytest.raises(ValueError, match="unknown roformer model"):
        roformer.resolve_roformer_slug({"model": "htdemucs"})  # a demucs token is unknown here


def test_find_roformer_stems_matches_case_insensitively(tmp_path):
    (tmp_path / "song_(Instrumental)_model.flac").write_text("x")
    (tmp_path / "song_(Vocals)_model.flac").write_text("x")
    assert roformer.find_roformer_instrumental(str(tmp_path)).endswith("_(Instrumental)_model.flac")
    assert roformer.find_roformer_vocals(str(tmp_path)).endswith("_(Vocals)_model.flac")


def test_find_roformer_instrumental_none_when_absent(tmp_path):
    assert roformer.find_roformer_instrumental(str(tmp_path)) is None
    assert roformer.find_roformer_instrumental(str(tmp_path / "nope")) is None


def test_roformer_argv_shape():
    argv = roformer.roformer_argv("/in", "/out", "roformer-model-x", device="cpu")
    assert argv[0] == "bs-roformer-infer"
    assert "--model" in argv and "roformer-model-x" in argv
    assert argv[argv.index("--input_folder") + 1] == "/in"
    assert argv[argv.index("--store_dir") + 1] == "/out"
    assert argv[argv.index("--device") + 1] == "cpu"


def test_roformer_argv_omits_device_when_unset():
    argv = roformer.roformer_argv("/in", "/out", "slug")
    assert "--device" not in argv  # let the CLI's own 'auto' default apply


# ── engine selection ──────────────────────────────────────────────────────────────
#
# Was EngineRouter, a second dispatch layer that picked a whole processor per engine. Choosing a separator
# is plan SELECTION now (docs/archive/specs/SPEC-worker-pipeline.md §5.2c): `engine_for` resolves it before the
# first step runs, and one Separate step asks whichever engine won the same four questions.


def test_engine_selection_reads_the_job_param_and_defaults_to_demucs():
    from src.plans import resolve_engines
    from src.runtime.ctx import ResolvedEngines
    from src.separation.engines import engine_for

    assert engine_for(resolve_engines({"engine": "roformer"}, ResolvedEngines()).separator).id == "roformer"
    assert engine_for(resolve_engines({"engine": "demucs"}, ResolvedEngines()).separator).id == "demucs"
    # a job from an older core with no engine param → demucs
    assert engine_for(resolve_engines({}, ResolvedEngines()).separator).id == "demucs"


def test_engine_selection_raises_for_an_engine_that_does_not_exist():
    """The CORE only routes a roformer cook to a worker advertising `stems:roformer`, so an unknown engine
    here is a routing bug rather than a user choice — it should be loud."""
    from src.separation.engines import engine_for

    with pytest.raises(RuntimeError, match="no separator engine"):
        engine_for("spleeter")


def test_a_None_config_value_does_not_override_an_engine_default():
    """`stems_runner` passes every separator knob through, and a worker with no opinion passes None.
    Forwarding it would replace the engine's own default with nothing — and for the model that means
    resolve_*_model() gets None as its fallback and fails on a job that carried no model."""
    from src.separation.engines import engine_for

    from src.separation.demucs import DEFAULT_MODEL

    eng = engine_for("demucs", demucs_model=None, jobs=None, device=None)
    assert eng.resolve_model({}) == DEFAULT_MODEL


def test_the_demucs_default_cannot_reach_the_roformer_engine():
    """Issue #84 regression. `plans.stems_runner` forwards this worker's `demucs_model` (default
    "htdemucs") into `engine_for` on EVERY cook, roformer included (plans.py: the lone production caller).
    While the model slot was ONE engine-agnostic `default_model`, that demucs checkpoint reached
    `RoformerEngine` and replaced `DEFAULT_ROFORMER_MODEL` — a roformer cook carrying no `model` then
    raised `unknown roformer model 'htdemucs'` (a demucs name on a roformer engine) and the engine's
    declared default was unreachable.

    Model defaults are now per engine: `demucs_model` maps ONLY to demucs and `roformer_model` ONLY to
    roformer. This test drives the pre-fix production seam — a demucs checkpoint offered to the roformer
    engine — and asserts it does NOT become that engine's default.

    Fails on base: base's roformer branch admits a shared `default_model` AND accepts the demucs
    `demucs_model` is a no-op there, but the SHARED name that production actually forwarded
    (`default_model="htdemucs"`) is what stranded the default. So the load-bearing assertion is that the
    roformer engine, offered a demucs checkpoint through the model slot, still resolves its OWN default."""
    from src.separation.engines import engine_for
    from src.separation.roformer import DEFAULT_ROFORMER_MODEL, resolve_roformer_slug

    roformer_default_slug = resolve_roformer_slug({}, DEFAULT_ROFORMER_MODEL)

    # The pre-fix production seam: the demucs default was forwarded to EVERY engine via `default_model`.
    # After the fix that shared name no longer exists; a demucs checkpoint can only be offered as
    # `demucs_model`, which the roformer branch ignores. Either way the roformer engine must keep its own
    # default — never the demucs value.
    eng = engine_for("roformer", default_model="htdemucs", demucs_model="htdemucs", roformer_bin="bs-roformer-infer")
    assert eng.id == "roformer"
    assert eng.resolve_model({}) == roformer_default_slug, (
        "a demucs checkpoint reached the roformer engine and stranded DEFAULT_ROFORMER_MODEL (issue #84)"
    )

    # The roformer engine can still be given its OWN default explicitly.
    eng2 = engine_for("roformer", roformer_model=DEFAULT_ROFORMER_MODEL)
    assert eng2.resolve_model({}) == roformer_default_slug
