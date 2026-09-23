"""Unit tests for the demucs-mlx pure helpers (src/separation/mlx.py).

These pin the MEASURED demucs-mlx CLI contract: its argv has no --two-stems / --filename, its
output lands in the demucs-native <out>/<input-stem>/<source>.wav layout, and the instrumental is
DERIVED by summing the non-vocal stems with amix normalize=0 (a true sum, not the level-halving
default). The engine adapter and the end-to-end wire live in test_demucs.py; this file is the argv/path
contract in isolation, with no runner and no subprocess.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.retry_policy import BoundaryError  # noqa: E402
from src.separation import mlx  # noqa: E402


def test_resolve_mlx_model_default_and_whitelist():
    assert mlx.resolve_mlx_model({}) == "htdemucs"
    assert mlx.resolve_mlx_model({"model": ""}) == "htdemucs"
    assert mlx.resolve_mlx_model({"model": "htdemucs_ft"}) == "htdemucs_ft"
    assert mlx.resolve_mlx_model({"model": "htdemucs_6s"}) == "htdemucs_6s"


def test_resolve_mlx_model_unknown_is_non_retryable():
    """An explicit-but-unknown model raises BoundaryError (retryable=False), never shells an arbitrary
    name — same fail-fast contract as resolve_demucs_model."""
    with pytest.raises(ValueError, match="unknown demucs-mlx model") as excinfo:
        mlx.resolve_mlx_model({"model": "bs-roformer-1297"})
    assert isinstance(excinfo.value, BoundaryError)
    assert excinfo.value.retryable is False
def test_mlx_argv_has_no_two_stems_or_filename_flags():
    argv = mlx.mlx_argv("/w/input.wav", "/w/sep", model="htdemucs", mlx_bin="demucs-mlx")
    assert argv[:3] == ["demucs-mlx", "-n", "htdemucs"]
    assert "-o" in argv and "/w/sep" in argv
    # the two flags the torch engine relies on do NOT exist on demucs-mlx
    assert "--two-stems" not in argv
    assert "--filename" not in argv
    # the input file is the final positional (matches the CLI's `tracks` nargs)
    assert argv[-1] == "/w/input.wav"
    # no torch device / jobs flags — mlx takes neither
    assert "-d" not in argv and "-j" not in argv


def test_mlx_argv_optional_perf_flags_omitted_when_unset_and_present_when_set():
    bare = mlx.mlx_argv("/w/input.wav", "/w/sep")
    assert "--overlap" not in bare and "--shifts" not in bare and "--segment" not in bare and "-b" not in bare

    tuned = mlx.mlx_argv("/w/input.wav", "/w/sep", overlap=0.1, shifts=2, segment=7, batch_size=4)
    assert "--overlap" in tuned and tuned[tuned.index("--overlap") + 1] == "0.1"
    assert "--shifts" in tuned and tuned[tuned.index("--shifts") + 1] == "2"
    assert "--segment" in tuned and tuned[tuned.index("--segment") + 1] == "7"
    assert "-b" in tuned and tuned[tuned.index("-b") + 1] == "4"
def test_mlx_output_layout_is_keyed_on_the_input_filename_not_the_model():
    # demucs-mlx writes <out>/<input-stem>/<source>.wav — the folder is the input filename, not the model
    assert mlx.mlx_track_dir("/w/sep", "/w/input.wav") == "/w/sep/input"
    assert mlx.mlx_vocals_path("/w/sep", "/w/input.wav") == "/w/sep/input/vocals.wav"
    assert mlx.mlx_instrumental_path("/w/sep", "/w/input.wav") == "/w/sep/input/no_vocals.wav"
    assert mlx.mlx_stem_path("/w/sep", "/w/input.wav", "drums") == "/w/sep/input/drums.wav"
    # a differently-named input proves the folder tracks the input stem, not a constant
    assert mlx.mlx_track_dir("/w/sep", "/tmp/song.wav") == "/w/sep/song"
def test_instrumental_sources_are_every_non_vocal_stem_including_6s_extras():
    assert mlx.mlx_instrumental_sources("htdemucs") == ("drums", "bass", "other")
    assert mlx.mlx_instrumental_sources("htdemucs_ft") == ("drums", "bass", "other")
    # 6-source model adds piano + guitar — dropping them would leave those out of the backing track
    assert mlx.mlx_instrumental_sources("htdemucs_6s") == ("drums", "bass", "other", "piano", "guitar")
    assert "vocals" not in mlx.mlx_instrumental_sources("htdemucs_6s")
def test_mix_minus_argv_sums_non_vocal_stems_with_normalize_off():
    argv = mlx.mix_minus_instrumental_argv("/w/sep", "/w/input.wav", model="htdemucs", ffmpeg_bin="ffmpeg")
    # three non-vocal stem inputs, and NOT the vocals stem
    inputs = [argv[i + 1] for i, tok in enumerate(argv) if tok == "-i"]
    assert inputs == ["/w/sep/input/drums.wav", "/w/sep/input/bass.wav", "/w/sep/input/other.wav"]
    assert "/w/sep/input/vocals.wav" not in inputs
    # amix over exactly those inputs, with normalize=0 (a true sum — the default averages and would emit
    # the instrumental at 1/N level, the ship-a-quiet-instrumental trap)
    fc = argv[argv.index("-filter_complex") + 1]
    assert fc == "amix=inputs=3:normalize=0"
    # output is the derived no_vocals.wav in raw 16-bit stereo PCM, same as the torch engine's stem
    assert argv[-1] == "/w/sep/input/no_vocals.wav"
    assert "pcm_s16le" in argv


def test_mix_minus_argv_for_6s_sums_all_five_non_vocal_stems():
    argv = mlx.mix_minus_instrumental_argv("/w/sep", "/w/input.wav", model="htdemucs_6s")
    inputs = [argv[i + 1] for i, tok in enumerate(argv) if tok == "-i"]
    assert len(inputs) == 5  # drums, bass, other, piano, guitar
    assert argv[argv.index("-filter_complex") + 1] == "amix=inputs=5:normalize=0"
