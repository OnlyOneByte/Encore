"""Pitch-shift helper — semitone math, ffmpeg argv, keyed paths, variant set. Pure; the real
ffmpeg render runs only on a worker box with a full ffmpeg build (this sandbox's is stripped)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import pitch  # noqa: E402


def test_clamp_semitones():
    assert pitch.clamp_semitones(0) == 0
    assert pitch.clamp_semitones(3) == 3
    assert pitch.clamp_semitones(99) == pitch.MAX_KEY_SHIFT
    assert pitch.clamp_semitones(-99) == -pitch.MAX_KEY_SHIFT


def test_pitch_ratio_is_equal_tempered():
    assert pitch.pitch_ratio(0) == 1.0
    # ratio = 2**(n/12); within the supported ±MAX_KEY_SHIFT range
    assert abs(pitch.pitch_ratio(7) - 2 ** (7 / 12)) < 1e-9  # perfect fifth up (the max)
    assert abs(pitch.pitch_ratio(-7) - 2 ** (-7 / 12)) < 1e-9  # perfect fifth down
    assert abs(pitch.pitch_ratio(2) - 2 ** (2 / 12)) < 1e-9  # whole step
    # out-of-range is clamped to ±MAX_KEY_SHIFT BEFORE the ratio (not a full octave)
    assert pitch.pitch_ratio(12) == pitch.pitch_ratio(pitch.MAX_KEY_SHIFT)


def test_keyed_filename_matches_shared_contract():
    # mirrors @encore/shared keyedMediaRef so the TV resolves the same name
    assert pitch.keyed_filename("stems/m1-instrumental.wav", 0) == "stems/m1-instrumental.wav"
    assert pitch.keyed_filename("stems/m1-instrumental.wav", 2) == "stems/m1-instrumental.+2.wav"
    assert pitch.keyed_filename("stems/m1-instrumental.wav", -3) == "stems/m1-instrumental.-3.wav"


def test_shift_argv_chain_for_positive_and_negative():
    argv = pitch.shift_argv("/m/in.wav", "/m/out.+2.wav", 2, sample_rate=44100)
    assert argv[0] == "ffmpeg" and "-i" in argv and "/m/in.wav" in argv
    af = argv[argv.index("-af") + 1]
    # asetrate scales up by ratio, atempo undoes it by 1/ratio (tempo preserved)
    assert "asetrate=44100*" in af and "aresample=44100" in af and "atempo=" in af
    assert argv[-1] == "/m/out.+2.wav"


def test_shift_argv_rubberband_variant():
    argv = pitch.shift_argv("/m/in.wav", "/m/out.wav", 3, use_rubberband=True)
    af = argv[argv.index("-af") + 1]
    assert af.startswith("rubberband=pitch=")


def test_variants_to_render_covers_full_range_excluding_zero():
    variants = pitch.variants_to_render("stems/m1-instrumental.wav", max_shift=2)
    shifts = sorted(n for n, _ in variants)
    assert shifts == [-2, -1, 1, 2]  # 0 is the base file, not re-rendered
    # each variant path is the signed keyed filename
    by_shift = dict(variants)
    assert by_shift[2] == "stems/m1-instrumental.+2.wav"
    assert by_shift[-1] == "stems/m1-instrumental.-1.wav"
