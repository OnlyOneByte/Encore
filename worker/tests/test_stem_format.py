"""The declared raw-stem format (`SeparatorEngine.stem_format`, see src/vocabulary.py:StemFormat):
every engine answers it, and the answer must drive argv, derived paths, and config together — a reader
that assumes the wrong container cannot open the other and reads as "stems do not match" with no
missing-container reported. These tests pin: every engine answers the question, the answer drives argv
and paths in lockstep, and an engine whose CLI cannot honour a request does not pretend it can.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from src.host.config import WorkerConfig  # noqa: E402
from src.retry_policy import BoundaryError  # noqa: E402
from src.separation import demucs as d  # noqa: E402
from src.separation.engines import (  # noqa: E402
    AudioSepEngine,
    DemucsEngine,
    MlxDemucsEngine,
    RoformerEngine,
    engine_for,
)
from src.vocabulary import StemFormat, parse_stem_format  # noqa: E402

_ENV = {"ENCORE_CORE_WS": "ws://core/ws?role=worker", "MEDIA_DIR": "/media"}

#: Every engine the factory can build, as (name, extra kwargs).
_ALL_ENGINES = [("demucs", {}), ("demucs", {"backend": "mlx"}), ("roformer", {}), ("audiosep", {})]

#: The engines whose CLI actually takes an output-format flag, so the declaration is CONFIGURABLE.
_FORMAT_CAPABLE = [("demucs", {}), ("audiosep", {})]

#: The engines whose CLI has no such flag, so their declaration is FIXED and a request cannot change it.
_FORMAT_FIXED = [("demucs", {"backend": "mlx"}), ("roformer", {})]


def test_every_engine_declares_a_stem_format():
    """The seam's whole point: no engine may leave the container unanswered.

    A fifth engine added without a `stem_format` fails here rather than shipping and quietly losing its
    guide mix the way audiosep did.
    """
    for name, kw in _ALL_ENGINES:
        eng = engine_for(name, **kw)
        assert isinstance(eng.stem_format, StemFormat), f"{name}{kw} does not declare a StemFormat"


def test_the_four_engine_classes_declare_it_too():
    """Pinned on the CLASSES as well, so the attribute cannot be an accident of one factory path."""
    assert DemucsEngine().stem_format is StemFormat.FLAC
    assert AudioSepEngine().stem_format is StemFormat.FLAC
    assert MlxDemucsEngine.stem_format is StemFormat.WAV
    assert RoformerEngine.stem_format is StemFormat.WAV


@pytest.mark.parametrize("fmt", [StemFormat.FLAC, StemFormat.WAV])
def test_the_declaration_drives_demucs_argv_and_paths_together(fmt):
    """argv and derived paths must never disagree — the disagreement IS the bug.

    `find_outputs` probing a path the argv could not have written reads downstream as "the separator
    produced nothing", which is indistinguishable from a genuine separation failure.
    """
    eng = engine_for("demucs", stem_format=fmt)
    argv = eng.separate_argv("/w/input.wav", "/w/sep", "htdemucs")
    assert ("--flac" in argv) is (fmt is StemFormat.FLAC)
    # The paths the engine will look for carry the same extension the argv just asked demucs to write.
    for path in (
        d.demucs_no_vocals_path("/w/sep", "htdemucs", fmt),
        d.demucs_vocals_path("/w/sep", "htdemucs", fmt),
    ):
        assert path.endswith(fmt.ext), f"{path} does not match the declared {fmt}"


@pytest.mark.parametrize("fmt", [StemFormat.FLAC, StemFormat.WAV])
def test_the_declaration_drives_audiosep_output_format(fmt):
    """audio-separator's `--output_format` comes from the declaration, not a hardcoded literal — a
    literal here is what let this engine claim FLAC while readers assumed WAV."""
    argv = engine_for("audiosep", stem_format=fmt).separate_argv("/w/input.wav", "/w/sep", "ckpt")
    assert argv[argv.index("--output_format") + 1] == fmt.value.upper()


@pytest.mark.parametrize(("name", "kw"), _FORMAT_FIXED)
def test_an_engine_whose_cli_cannot_honour_a_format_does_not_pretend_to(name, kw):
    """demucs-mlx and bs-roformer-infer take no format flag, so asking must not change the declaration.
    Accepting the kwarg and silently dropping it would be worse than not offering it: the caller
    believes it selected a container while the CLI writes a different one."""
    eng = engine_for(name, stem_format=StemFormat.FLAC, **kw)
    assert eng.stem_format is StemFormat.WAV, f"{name}{kw} claimed a format its CLI cannot produce"


def test_config_resolves_the_format_at_the_boundary_and_defaults_to_flac():
    """FLAC by default (one lossless codec end to end), WAV selectable, unknown REJECTED here."""
    assert WorkerConfig.from_env(_ENV).stem_format is StemFormat.FLAC
    assert WorkerConfig.from_env({**_ENV, "ENCORE_STEM_FORMAT": "wav"}).stem_format is StemFormat.WAV
    assert WorkerConfig.from_env({**_ENV, "ENCORE_STEM_FORMAT": "FLAC"}).stem_format is StemFormat.FLAC
    with pytest.raises(BoundaryError):
        WorkerConfig.from_env({**_ENV, "ENCORE_STEM_FORMAT": "mp3"})


def test_an_unknown_format_fails_at_the_parser_rather_than_defaulting():
    """Silently defaulting is what makes a format typo unreadable-by-construction instead of loud."""
    assert parse_stem_format(None) is StemFormat.FLAC
    assert parse_stem_format("") is StemFormat.FLAC
    with pytest.raises(BoundaryError):
        parse_stem_format("ogg")


def test_ext_and_codec_agree_with_the_member():
    """The two derived properties every caller uses instead of hand-writing an extension."""
    assert StemFormat.FLAC.ext == ".flac"
    assert StemFormat.WAV.ext == ".wav"
    assert StemFormat.FLAC.ffmpeg_codec == "flac"
    # pcm_s16le, not "wav": ffmpeg names the CODEC, and this is what the separators consume.
    assert StemFormat.WAV.ffmpeg_codec == "pcm_s16le"


def test_stems_runner_threads_the_configured_format_into_the_engine():
    """The wiring itself: the runner takes the format, and the factory it calls honours it.

    Without this the declaration would be correct in isolation and unreachable in production — the class
    of defect where a fix is real but only ever runs on data nobody has.
    """
    from src import plans
    from src.separation.tuning import SeparationTuning

    # The format rides on `SeparationTuning` rather than being its own parameter (it was one of nine
    # separator kwargs enumerated at four sites). Assert the value survives the trip into engine kwargs,
    # which is what carries cfg.stem_format from dial_home.
    assert "tuning" in plans.stems_runner.__code__.co_varnames
    assert SeparationTuning(stem_format=StemFormat.WAV).engine_kwargs()["stem_format"] is StemFormat.WAV
    # And the factory it calls must turn that value into an engine that declares it.
    assert [engine_for("demucs", stem_format=f).stem_format for f in (StemFormat.FLAC, StemFormat.WAV)] == [
        StemFormat.FLAC,
        StemFormat.WAV,
    ]
