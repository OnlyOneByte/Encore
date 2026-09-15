"""`pipeline(path)` returns two different shapes depending on pyannote's version. Read both.

pyannote.audio 4.0 changed what calling a pipeline gives back. Its release notes show the new form:

    output = pipeline("/path/to/conversation.wav")
    print(output.speaker_diarization)            # regular
    print(output.exclusive_speaker_diarization)  # exclusive

Older versions returned the `Annotation` directly, which is where `itertracks` lives. Calling
`itertracks` on the wrapper raises `AttributeError`, `steps/diarize.py` catches every exception, and the
song publishes single-colour lyrics — the feature reads as "not a duet" rather than as broken. That is the
same silent shape the `use_auth_token` → `token` break had.

These tests run with fake pipelines because that is the ONLY way this seam can be covered here: no torch
and no pyannote on this machine. They pin the shape handling, not the model.
"""

from __future__ import annotations

import os
import sys
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from src.diarize.diarizer import PyannoteDiarizer, _speaker_annotation  # noqa: E402


class FakeAnnotation:
    """Stands in for `pyannote.core.Annotation` — the only method this worker uses."""

    def __init__(self, turns: list[tuple[float, float, str]]) -> None:
        self._turns = turns

    def itertracks(self, yield_label: bool = False) -> Any:
        for start, end, speaker in self._turns:
            seg = type("Seg", (), {"start": start, "end": end})()
            yield (seg, "_", speaker) if yield_label else (seg, "_")


class FakeWrapper:
    """Stands in for pyannote 4.x's return: the regular annotation plus the exclusive variant."""

    def __init__(self, regular: FakeAnnotation, exclusive: FakeAnnotation | None = None) -> None:
        self.speaker_diarization = regular
        self.exclusive_speaker_diarization = exclusive


TURNS = [(0.0, 1.5, "SPEAKER_00"), (1.5, 3.0, "SPEAKER_01")]


def _diarize_with(output: Any) -> list[dict[str, Any]]:
    """Drive the real `PyannoteDiarizer.diarize` with a fake pipeline returning `output`."""
    d = PyannoteDiarizer(device="cpu")
    d._pipeline = lambda _path: output  # bypass _load; the loader is covered elsewhere
    return d.diarize("/vocals.flac")


# ── the two shapes ───────────────────────────────────────────────────────────────────────────────


def test_a_bare_annotation_still_works() -> None:
    """The pre-4.0 shape. A version bump must not be the thing that breaks the old one."""
    assert _diarize_with(FakeAnnotation(TURNS)) == [
        {"start": 0.0, "end": 1.5, "speaker": "SPEAKER_00"},
        {"start": 1.5, "end": 3.0, "speaker": "SPEAKER_01"},
    ]


def test_the_4x_wrapper_is_unwrapped() -> None:
    """THE regression. `itertracks` on the wrapper raises, and the song silently loses its colours."""
    assert _diarize_with(FakeWrapper(FakeAnnotation(TURNS))) == [
        {"start": 0.0, "end": 1.5, "speaker": "SPEAKER_00"},
        {"start": 1.5, "end": 3.0, "speaker": "SPEAKER_01"},
    ]


def test_both_shapes_produce_byte_identical_output() -> None:
    """The unwrapping must be invisible downstream — `attribution.py` cannot tell which arrived."""
    assert _diarize_with(FakeAnnotation(TURNS)) == _diarize_with(FakeWrapper(FakeAnnotation(TURNS)))


# ── which attribute wins ─────────────────────────────────────────────────────────────────────────


def test_the_regular_diarization_is_preferred_over_the_exclusive_one() -> None:
    """`exclusive_speaker_diarization` is a different answer, not a fallback, so it is never read."""
    exclusive = FakeAnnotation([(0.0, 9.9, "SPEAKER_EXCLUSIVE")])
    got = _diarize_with(FakeWrapper(FakeAnnotation(TURNS), exclusive=exclusive))
    assert [r["speaker"] for r in got] == ["SPEAKER_00", "SPEAKER_01"]


def test_a_wrapper_that_also_proxies_itertracks_uses_the_named_attribute() -> None:
    """Order matters: the named attribute is unambiguous, a compat shim may be deprecated or exclusive."""

    class Hybrid(FakeWrapper):
        def itertracks(self, yield_label: bool = False) -> Any:
            yield (type("Seg", (), {"start": 0.0, "end": 9.9})(), "_", "SPEAKER_FROM_SHIM")

    got = _diarize_with(Hybrid(FakeAnnotation(TURNS)))
    assert [r["speaker"] for r in got] == ["SPEAKER_00", "SPEAKER_01"], "the shim was read, not the field"


# ── the third shape ──────────────────────────────────────────────────────────────────────────────


def test_an_unknown_shape_raises_an_error_naming_the_type() -> None:
    """The step logs `type(exc).__name__: exc`, so the next break must say what it returned.

    A bare AttributeError names the attribute, not the object — 'DiarizeOutput has no itertracks' is
    already better than what we had, but naming the received type is what makes a third shape a one-line
    diagnosis instead of an investigation.
    """
    with pytest.raises(RuntimeError) as err:
        _speaker_annotation(object())
    msg = str(err.value)
    assert "object" in msg
    assert "itertracks" in msg and "speaker_diarization" in msg


def test_a_wrapper_whose_inner_annotation_is_None_is_reported_as_such() -> None:
    """Distinguishable from 'unknown object' — it says the field was there and empty."""
    with pytest.raises(RuntimeError) as err:
        _speaker_annotation(FakeWrapper(None))  # type: ignore[arg-type]
    assert "that was None" in str(err.value)


def test_the_failure_still_degrades_rather_than_crashing_the_job() -> None:
    """`steps/diarize.py` catches Exception, so a RuntimeError here is a single-colour song, not a fail.

    Asserted as a property of the exception TYPE: a BaseException subclass outside Exception (a
    KeyboardInterrupt-like) would escape that handler and fail the align job.
    """
    with pytest.raises(RuntimeError) as err:
        _speaker_annotation(object())
    assert isinstance(err.value, Exception)


# ── the helper in isolation ──────────────────────────────────────────────────────────────────────


def test_the_helper_returns_the_annotation_unchanged_when_given_one() -> None:
    ann = FakeAnnotation(TURNS)
    assert _speaker_annotation(ann) is ann


def test_the_helper_returns_the_inner_annotation_from_a_wrapper() -> None:
    ann = FakeAnnotation(TURNS)
    assert _speaker_annotation(FakeWrapper(ann)) is ann
