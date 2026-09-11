"""The worker-side silence gate: a separation can succeed and still write digital silence, and a
SILENT guiding track is worse than none because it looks like it works. Pure parser + verdict."""

from src.processor import (
    SILENCE_FLOOR_DB,
    is_silent,
    parse_max_volume_db,
    volumedetect_argv,
)

# Real ffmpeg volumedetect output, trimmed to the summary block.
HEALTHY = """
[Parsed_volumedetect_0 @ 0x55d1] n_samples: 15925248
[Parsed_volumedetect_0 @ 0x55d1] mean_volume: -21.4 dB
[Parsed_volumedetect_0 @ 0x55d1] max_volume: -1.2 dB
[Parsed_volumedetect_0 @ 0x55d1] histogram_1db: 24
"""

# The known defect: both values pinned at the 16-bit floor.
SILENT = """
[Parsed_volumedetect_0 @ 0x55d1] mean_volume: -91.0 dB
[Parsed_volumedetect_0 @ 0x55d1] max_volume: -91.0 dB
"""


def test_volumedetect_argv_measures_and_writes_nothing():
    argv = volumedetect_argv("/media/derived/stems/x-vocals.m4a", "ffmpeg")
    assert argv[0] == "ffmpeg"
    assert "volumedetect" in argv
    # -f null - : decode the whole file, write no output
    assert argv[-2:] == ["null", "-"]
    assert "/media/derived/stems/x-vocals.m4a" in argv


def test_parses_max_volume_from_real_output():
    assert parse_max_volume_db(HEALTHY) == -1.2
    assert parse_max_volume_db(SILENT) == -91.0


def test_parses_a_zero_peak():
    assert parse_max_volume_db("max_volume: 0.0 dB") == 0.0


def test_missing_line_is_unmeasurable_not_silent():
    assert parse_max_volume_db("") is None
    assert parse_max_volume_db("ffmpeg: No such file or directory") is None
    # mean alone is not enough — the verdict is on peak
    assert parse_max_volume_db("mean_volume: -20 dB") is None


def test_garbage_value_is_unmeasurable():
    assert parse_max_volume_db("max_volume: loud dB") is None


def test_silence_is_flagged():
    assert is_silent(-91.0) is True
    assert is_silent(SILENCE_FLOOR_DB) is True


def test_real_audio_is_never_flagged_however_quiet():
    assert is_silent(-1.2) is False
    assert is_silent(-34.0) is False
    assert is_silent(SILENCE_FLOOR_DB + 1) is False


def test_unmeasurable_is_treated_as_audible():
    # a missing ffmpeg must not strip the guiding track off every song the worker processes
    assert is_silent(None) is False
