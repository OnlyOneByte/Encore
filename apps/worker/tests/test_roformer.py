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


def test_resolve_roformer_slug_maps_whitelisted_tokens():
    assert roformer.resolve_roformer_slug({"model": "bs-roformer-1297"}).startswith("roformer-model-")
    assert roformer.resolve_roformer_slug({"model": "mel-roformer-inst-v2"}).startswith("roformer-model-")


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
