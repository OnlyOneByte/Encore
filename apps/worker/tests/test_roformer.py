"""Roformer engine pure helpers + engine routing. The real BSRoformerSession cook is
REAL-ML/NET and unverified in this environment (see roformer.py's module warning), so these cover the
argv-free logic: model-token→slug resolution, output-stem discovery, and the EngineRouter dispatch.
"""
import asyncio
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import roformer  # noqa: E402
from src.processor import EngineRouter, JobSpec, ProgressEvent, CompleteResult  # noqa: E402


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


# ── EngineRouter ──────────────────────────────────────────────────────────────────
class _StubEngine:
    def __init__(self, tag):
        self.tag = tag

    async def process(self, job):
        yield ProgressEvent(stage=self.tag, pct=100)
        yield CompleteResult(media_uri=self.tag, artifacts={})


def _job(engine=None):
    params = {} if engine is None else {"engine": engine}
    return JobSpec(job_id="j", media_id="m", job_type="stems", source_uri="u", params=params, media_dir="/tmp")


async def _first_stage(proc, job):
    async for ev in proc.process(job):
        return ev.stage if isinstance(ev, ProgressEvent) else None


def test_engine_router_selects_by_param_and_defaults_to_demucs():
    router = EngineRouter({"demucs": _StubEngine("demucs"), "roformer": _StubEngine("roformer")})
    assert asyncio.run(_first_stage(router, _job("roformer"))) == "roformer"
    assert asyncio.run(_first_stage(router, _job("demucs"))) == "demucs"
    # a job from an older core with no engine param → demucs
    assert asyncio.run(_first_stage(router, _job(None))) == "demucs"


def test_engine_router_raises_for_an_engine_this_worker_lacks():
    router = EngineRouter({"demucs": _StubEngine("demucs")})  # no roformer installed
    with pytest.raises(RuntimeError, match="no processor for separator engine"):
        asyncio.run(_first_stage(router, _job("roformer")))
