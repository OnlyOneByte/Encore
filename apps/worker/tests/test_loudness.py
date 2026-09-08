"""Integrated-loudness measurement (issue #462, PR1) + its wiring into build_song_profile.

The measure is BS.1770-4 via pyloudnorm; these tests pin the TRI-STATE contract (a real negative
float for a real signal, None for silence / too-short / missing / unreadable) and prove the value is
measured on every cook by asserting build_song_profile logs it. Expected values are asserted against
INDEPENDENTLY-REASONED bands, never by re-running the meter the code under test uses (section 3)."""

import os
import sys
import wave
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.analysis import loudness, song_profile  # noqa: E402


def _write_wav(path, samples, sr=44100):
    path = str(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())


def _tone(sr, seconds, hz, amp):
    t = np.arange(int(sr * seconds)) / sr
    return amp * np.sin(2 * np.pi * hz * t)


# -- the measurement, tri-state --
def test_real_tone_measures_a_finite_negative_lufs(tmp_path):
    _write_wav(tmp_path / "inst.wav", _tone(44100, 3.0, 1000.0, 0.5))
    lufs = loudness.measure_lufs(str(tmp_path / "inst.wav"))
    assert lufs is not None
    assert np.isfinite(lufs)
    assert -40.0 < lufs < 0.0, f"a half-scale 1kHz tone should sit well inside (-40, 0) LUFS, got {lufs}"


def test_louder_tone_measures_higher_than_quieter_tone(tmp_path):
    _write_wav(tmp_path / "loud.wav", _tone(44100, 3.0, 1000.0, 0.8))
    _write_wav(tmp_path / "quiet.wav", _tone(44100, 3.0, 1000.0, 0.1))
    loud = loudness.measure_lufs(str(tmp_path / "loud.wav"))
    quiet = loudness.measure_lufs(str(tmp_path / "quiet.wav"))
    assert loud is not None and quiet is not None
    assert loud > quiet


def test_digital_silence_is_unmeasurable_none(tmp_path):
    _write_wav(tmp_path / "sil.wav", np.zeros(44100 * 2))
    assert loudness.measure_lufs(str(tmp_path / "sil.wav")) is None


def test_stem_shorter_than_a_gating_block_is_none(tmp_path):
    _write_wav(tmp_path / "short.wav", _tone(44100, 0.1, 1000.0, 0.5))
    assert loudness.measure_lufs(str(tmp_path / "short.wav")) is None


def test_missing_path_is_none():
    assert loudness.measure_lufs(None) is None
    assert loudness.measure_lufs("") is None


def test_unreadable_file_degrades_to_none_never_raises(tmp_path):
    bad = tmp_path / "not_audio.wav"
    bad.write_bytes(b"NOT_A_WAV")
    assert loudness.measure_lufs(str(bad)) is None


# -- wiring: build_song_profile measures and reports the instrumental loudness on every cook --
def test_build_song_profile_logs_the_measured_lufs(tmp_path):
    _write_wav(tmp_path / "inst.wav", _tone(44100, 3.0, 1000.0, 0.5))
    logs = []
    song_profile.build_song_profile(
        str(tmp_path / "inst.wav"), None, "m1", log=lambda *a, **k: logs.append(a[0] if a else "")
    )
    joined = "\n".join(str(x) for x in logs)
    assert "instrumental loudness for m1" in joined, "loudness must be measured+logged for the instrumental"
    assert "LUFS" in joined, "a real instrumental must report a LUFS value, not 'unmeasurable'"


def test_build_song_profile_logs_null_for_silent_instrumental(tmp_path):
    _write_wav(tmp_path / "sil.wav", np.zeros(44100 * 2))
    logs = []
    song_profile.build_song_profile(
        str(tmp_path / "sil.wav"), None, "m1", log=lambda *a, **k: logs.append(a[0] if a else "")
    )
    joined = "\n".join(str(x) for x in logs)
    assert "instrumental loudness for m1" in joined
    assert "unmeasurable (null)" in joined, "a silent instrumental must report null, never a level"


def test_loudness_measured_does_not_alter_the_profile_wire_shape(tmp_path):
    _write_wav(tmp_path / "inst.wav", _tone(44100, 3.0, 1000.0, 0.5))
    prof = song_profile.build_song_profile(str(tmp_path / "inst.wav"), None, "m1")
    assert set(prof) == {
        "keyTonic", "keyMode", "keyConfidence",
        "lowMidi", "highMidi", "p05Midi", "p95Midi", "histogram",
    }


# -- package re-export: measure_lufs is part of the analysis domain's public surface --
def test_measure_lufs_is_reexported_from_the_analysis_package():
    # __init__.py must import measure_lufs AND list it in __all__ so `from src.analysis import
    # measure_lufs` works and the symbol is a declared part of the domain (matches detect_key /
    # summarize_range). Reverting either __init__ hunk reds one of these.
    import src.analysis as analysis

    from src.analysis import measure_lufs as reexported  # noqa: F401 -- import itself is the assertion

    assert "measure_lufs" in analysis.__all__
    assert analysis.measure_lufs is loudness.measure_lufs
