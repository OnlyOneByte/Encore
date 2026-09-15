"""The pyannote pipeline LOAD path — the one part of diarization no test reached.

WHY THIS FILE EXISTS. `PyannoteDiarizer._load()` called
`Pipeline.from_pretrained(..., use_auth_token=...)`, and `requirements.txt` pins
`pyannote.audio==4.0.0`, which REMOVED that argument (Hugging Face deprecated the name and pyannote
followed). So every align job raised

    TypeError: Pipeline.from_pretrained() got an unexpected keyword argument 'use_auth_token'

the step caught it, and the song degraded to a single colour. Diarization had never once succeeded on the
pinned version — while `capabilities.probe_all` kept advertising `diarize`, because its probe only proves
that `pyannote.audio` imports, which it does.

A green 948-test suite said nothing, because every diarization test injects a FAKE diarizer and none of
them constructed the real one. The heavy seam being faked is the right call for the algorithm tests; the
consequence is that the seam's own wiring needs a test that pokes it deliberately, which is this file.

`pyannote.audio` and `torch` are not installed on the box that runs this suite, so both are injected into
`sys.modules`. That is the point rather than a limitation: the test asserts what the worker PASSES to the
library, which is exactly the half that broke, and it does so without a multi-GB download.
"""

from __future__ import annotations

import os
import sys
import types
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from src.diarize.diarizer import HF_TOKEN_ENV, PyannoteDiarizer  # noqa: E402


class _FakePipelineObj:
    """Stands in for a loaded pyannote pipeline. `.to(device)` returns itself, as the real one does."""

    def __init__(self) -> None:
        self.moved_to: Any = None

    def to(self, device: Any) -> _FakePipelineObj:
        self.moved_to = device
        return self


def _install_fakes(monkeypatch: pytest.MonkeyPatch, *, returns: Any = None) -> dict[str, Any]:
    """Inject fake `pyannote.audio` + `torch`, and capture the kwargs `from_pretrained` receives.

    `returns` is what the fake `from_pretrained` hands back — `None` models the gated-model-with-no-token
    case the loader turns into a named RuntimeError.
    """
    seen: dict[str, Any] = {}

    class FakePipeline:
        @staticmethod
        def from_pretrained(pipeline_id: str, **kwargs: Any) -> Any:
            seen["pipeline_id"] = pipeline_id
            seen["kwargs"] = kwargs
            return _FakePipelineObj() if returns is None else returns

    pyannote = types.ModuleType("pyannote")
    audio = types.ModuleType("pyannote.audio")
    audio.Pipeline = FakePipeline  # type: ignore[attr-defined]
    pyannote.audio = audio  # type: ignore[attr-defined]

    torch = types.ModuleType("torch")
    torch.device = lambda spec: f"device:{spec}"  # type: ignore[attr-defined]

    monkeypatch.setitem(sys.modules, "pyannote", pyannote)
    monkeypatch.setitem(sys.modules, "pyannote.audio", audio)
    monkeypatch.setitem(sys.modules, "torch", torch)
    return seen


def test_the_auth_token_is_passed_as_token_not_use_auth_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """THE regression. `use_auth_token` is a TypeError on the pinned pyannote 4.0.0."""
    seen = _install_fakes(monkeypatch)
    monkeypatch.setenv(HF_TOKEN_ENV, "hf_secret")

    PyannoteDiarizer(device="cpu")._load()

    assert "token" in seen["kwargs"], "the HF token must be passed as `token=` on pyannote 4.x"
    assert "use_auth_token" not in seen["kwargs"], (
        "`use_auth_token=` was REMOVED in pyannote.audio 4.x — passing it raises TypeError on every "
        "align job, and the step degrades to a single colour with the reason buried in a note"
    )
    assert seen["kwargs"]["token"] == "hf_secret"


def test_an_absent_token_is_passed_as_None_rather_than_an_empty_string(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A box with no token still loads an ungated pipeline; `''` would be sent as a credential."""
    seen = _install_fakes(monkeypatch)
    monkeypatch.delenv(HF_TOKEN_ENV, raising=False)

    PyannoteDiarizer(device="cpu")._load()

    assert seen["kwargs"]["token"] is None


def test_the_pipeline_is_moved_to_the_requested_device(monkeypatch: pytest.MonkeyPatch) -> None:
    """The device is a constructor argument and must actually reach the loaded pipeline."""
    _install_fakes(monkeypatch)
    monkeypatch.setenv(HF_TOKEN_ENV, "hf_secret")

    loaded = PyannoteDiarizer(device="cuda")._load()

    assert loaded.moved_to == "device:cuda"


def test_a_gated_model_returning_None_raises_a_named_error(monkeypatch: pytest.MonkeyPatch) -> None:
    """pyannote returns None for a gated model with a bad/absent token instead of raising.

    Left alone that becomes `None.to(...)`, an AttributeError whose message says nothing about terms of
    use. The loader turns it into a message that names the env var to set.
    """
    _install_fakes(monkeypatch, returns=None)

    class FakePipelineNone:
        @staticmethod
        def from_pretrained(_pipeline_id: str, **_kwargs: Any) -> Any:
            return None

    monkeypatch.setattr(sys.modules["pyannote.audio"], "Pipeline", FakePipelineNone)
    monkeypatch.setenv(HF_TOKEN_ENV, "hf_bad")

    with pytest.raises(RuntimeError) as err:
        PyannoteDiarizer(device="cpu")._load()
    assert HF_TOKEN_ENV in str(err.value), "the error must name the env var an operator has to set"


def test_the_pipeline_is_loaded_once_and_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    """Loading is multi-GB and ML_LOCK-guarded; a second align job must reuse the resident pipeline."""
    calls = {"n": 0}
    seen = _install_fakes(monkeypatch)
    audio = sys.modules["pyannote.audio"]
    real_from_pretrained = audio.Pipeline.from_pretrained

    class CountingPipeline:
        @staticmethod
        def from_pretrained(pipeline_id: str, **kwargs: Any) -> Any:
            calls["n"] += 1
            return real_from_pretrained(pipeline_id, **kwargs)

    monkeypatch.setattr(audio, "Pipeline", CountingPipeline)
    monkeypatch.setenv(HF_TOKEN_ENV, "hf_secret")

    d = PyannoteDiarizer(device="cpu")
    first, second = d._load(), d._load()

    assert calls["n"] == 1, "the pipeline was re-loaded; the module cache is not holding"
    assert first is second
    assert seen["kwargs"]["token"] == "hf_secret"
