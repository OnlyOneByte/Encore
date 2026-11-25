"""#1221: an offline worker without its whisper checkpoint says so, and completes align once, lyricless."""

from __future__ import annotations

import sys
import types
from dataclasses import replace
from pathlib import Path

import pytest

from encore_worker import __main__ as main
from encore_worker.adapters import ml
from encore_worker.host.config import Config
from encore_worker.steps.records import AlignOutcome, JobRef

OFFLINE = Config(offline=True)
JOB = JobRef(job_id="j1", media_id="m1", media_dir="/media", params={"asrModel": "base"})


class LocalEntryNotFoundError(Exception):
    """Stands in for huggingface_hub's cache-miss error."""


def fake_faster_whisper(
    monkeypatch: pytest.MonkeyPatch, *, cached: bool, fails: Exception | None = None
) -> list[tuple[str, bool]]:
    calls: list[tuple[str, bool]] = []

    def download_model(checkpoint: str, *, local_files_only: bool = False) -> str:
        calls.append((checkpoint, local_files_only))
        if fails is not None:
            raise fails
        if not cached:
            raise LocalEntryNotFoundError("cannot find the requested files in the local cache")
        return f"/cache/{checkpoint}"

    utils = types.ModuleType("faster_whisper.utils")
    utils.download_model = download_model  # type: ignore[attr-defined]
    errors = types.ModuleType("huggingface_hub.errors")
    errors.LocalEntryNotFoundError = LocalEntryNotFoundError  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "faster_whisper", types.ModuleType("faster_whisper"))
    monkeypatch.setitem(sys.modules, "faster_whisper.utils", utils)
    monkeypatch.setitem(sys.modules, "huggingface_hub", types.ModuleType("huggingface_hub"))
    monkeypatch.setitem(sys.modules, "huggingface_hub.errors", errors)
    return calls


def test_any_other_lookup_error_surfaces_instead_of_reading_uncached(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_faster_whisper(monkeypatch, cached=False, fails=ValueError("Invalid model size 'bsae'"))
    with pytest.raises(ValueError, match="Invalid model size"):
        ml.asr_offline_gap("bsae")


def test_a_local_model_directory_is_never_a_gap(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls = fake_faster_whisper(monkeypatch, cached=False)
    assert ml.asr_offline_gap(str(tmp_path)) is None
    assert calls == [], "a directory is the model itself: nothing to look up"


def test_an_uncached_checkpoint_is_found_without_the_network(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = fake_faster_whisper(monkeypatch, cached=False)
    assert ml.asr_offline_gap("base") == "whisper base isn't cached and this worker is offline"
    assert calls == [("base", True)], "asked of the local cache only"
    fake_faster_whisper(monkeypatch, cached=True)
    assert ml.asr_offline_gap("base") is None


def test_no_faster_whisper_is_not_an_offline_gap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "faster_whisper.utils", None)  # makes the import raise ImportError
    assert ml.asr_offline_gap("base") is None


def test_only_an_offline_worker_checks_the_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = fake_faster_whisper(monkeypatch, cached=False)
    assert main.asr_off(Config(), "base") is None
    assert calls == [], "online, the Hub is reachable: nothing to check"
    assert main.asr_off(OFFLINE, "base") == "whisper base isn't cached and this worker is offline"


def test_offline_and_uncached_builds_no_transcriber_at_all(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_faster_whisper(monkeypatch, cached=False)
    built = record_builds(monkeypatch)
    adapters = main.build_adapters(OFFLINE, device="cpu")
    assert adapters.transcriber is None
    assert adapters.transcriber_for is not None and adapters.transcriber_for("small") is None
    assert built == [], "no transcriber: the ASR tier yields nothing, so the job completes instead of failing"


def test_online_or_cached_still_builds_the_transcriber(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_faster_whisper(monkeypatch, cached=True)
    built = record_builds(monkeypatch)
    assert main.build_adapters(OFFLINE, device="cpu").transcriber is not None
    assert main.build_adapters(replace(OFFLINE, offline=False), device="cpu").transcriber is not None
    assert built == ["base", "base"]


def record_builds(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    built: list[str] = []

    def build(*, device: str, checkpoint: str, compute: str | None = None) -> object:
        built.append(checkpoint)
        return object()

    monkeypatch.setattr(ml, "build_transcriber", build)
    return built


def test_the_align_facts_carry_the_reason_only_when_asr_was_off_and_nothing_was_published(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_faster_whisper(monkeypatch, cached=False)
    none = AlignOutcome(published=None, why="")
    assert main._align_facts(JOB, OFFLINE, none)["lyricsNote"] == "asr-offline"
    assert "lyricsNote" not in main._align_facts(JOB, Config(), none), "online: no lyrics is a real result"
    fake_faster_whisper(monkeypatch, cached=True)
    assert "lyricsNote" not in main._align_facts(JOB, OFFLINE, none), "cached: ASR ran and heard nothing"
