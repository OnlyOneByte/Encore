"""Vocal-range summary — percentiles, histogram, and the load-bearing empty case, driven by canned
PitchFrame lists (no audio needed). A couple of tests also exercise the pure-numpy tracker on a
synthesized tone, since the `pitch_track.py` the task described does not exist and the tracker had to
live in this module."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import vocal_range  # noqa: E402
from src.vocal_range import PitchFrame  # noqa: E402


def _frame(t, midi, voiced=True):
    """A canned frame at MIDI `midi`; f0 is derived so the frame is self-consistent."""
    f0 = 440.0 * 2 ** ((midi - 69) / 12.0) if midi else 0.0
    return PitchFrame(time_sec=t, f0_hz=f0, midi=float(midi), voiced=voiced, clarity=0.9 if voiced else 0.0)


# ── the empty case (the contract that keeps a silent-vocals song from being stranded) ──
def test_no_voiced_frames_is_all_none():
    out = vocal_range.summarize_range([_frame(0.0, 60, voiced=False), _frame(0.1, 62, voiced=False)])
    assert out == {"lowMidi": None, "highMidi": None, "p05Midi": None, "p95Midi": None, "histogram": None}


def test_empty_frame_list_is_all_none():
    out = vocal_range.summarize_range([])
    assert out["lowMidi"] is None and out["histogram"] is None


# ── extremes vs lived-in range ──────────────────────────────────────────────────────
def test_absolute_extremes_use_all_voiced_frames():
    # A run mostly in the middle with ONE low outlier and ONE high outlier. low/high are the absolute
    # extremes; the outliers are exactly what the percentiles should discount.
    frames = [_frame(i * 0.1, 60) for i in range(98)]
    frames.append(_frame(9.8, 48))   # one very low note
    frames.append(_frame(9.9, 84))   # one very high note
    out = vocal_range.summarize_range(frames, hop_sec=0.1)
    assert out["lowMidi"] == 48.0
    assert out["highMidi"] == 84.0
    # p05/p95 trim the single outliers → both sit on the bulk at 60
    assert out["p05Midi"] == 60.0
    assert out["p95Midi"] == 60.0


def test_percentiles_track_the_distribution():
    # A linear spread from 50..69 (20 frames). p05 ≈ near the bottom, p95 ≈ near the top, both inside
    # [low, high]; assert ordering + bounds rather than exact interpolation constants.
    frames = [_frame(i * 0.1, 50 + i) for i in range(20)]
    out = vocal_range.summarize_range(frames, hop_sec=0.1)
    assert out["lowMidi"] == 50.0
    assert out["highMidi"] == 69.0
    assert out["lowMidi"] <= out["p05Midi"] <= out["p95Midi"] <= out["highMidi"]
    assert out["p05Midi"] < out["p95Midi"]


# ── histogram ───────────────────────────────────────────────────────────────────────
def test_histogram_is_seconds_per_semitone_indexed_from_low():
    # 3 frames at C4(60), 2 at D4(62), each frame 0.5s. Bins run 60,61,62 → index 0 = lowMidi(60).
    frames = [_frame(0.0, 60), _frame(0.5, 60), _frame(1.0, 60), _frame(1.5, 62), _frame(2.0, 62)]
    out = vocal_range.summarize_range(frames, hop_sec=0.5)
    assert out["lowMidi"] == 60.0
    assert out["histogram"] == [1.5, 0.0, 1.0]  # 3*0.5s at 60, nothing at 61, 2*0.5s at 62


def test_histogram_only_counts_voiced_frames():
    frames = [_frame(0.0, 60), _frame(0.5, 60, voiced=False), _frame(1.0, 62)]
    out = vocal_range.summarize_range(frames, hop_sec=0.5)
    # the unvoiced 60 frame is dropped → 0.5s at 60, 0.5s at 62
    assert out["lowMidi"] == 60.0 and out["highMidi"] == 62.0
    assert out["histogram"] == [0.5, 0.0, 0.5]


def test_hop_sec_inferred_from_timestamps_when_omitted():
    frames = [_frame(0.0, 60), _frame(0.25, 60)]  # 0.25s apart
    out = vocal_range.summarize_range(frames)  # no hop_sec → inferred
    assert out["histogram"][0] == 0.5  # two frames × 0.25s at bin 60


def test_single_voiced_frame_degenerate_case():
    out = vocal_range.summarize_range([_frame(0.0, 60)], hop_sec=0.1)
    assert out["lowMidi"] == out["highMidi"] == out["p05Midi"] == out["p95Midi"] == 60.0
    assert out["histogram"] == [0.1]


# ── hz_to_midi ────────────────────────────────────────────────────────────────────
def test_hz_to_midi_reference_pitches():
    assert abs(vocal_range.hz_to_midi(440.0) - 69.0) < 1e-9  # A4
    assert abs(vocal_range.hz_to_midi(261.6255653) - 60.0) < 1e-4  # middle C
    assert abs(vocal_range.hz_to_midi(880.0) - 81.0) < 1e-9  # A5, one octave up


# ── the pure-numpy tracker on a synthesized tone (the pitch_track.py stand-in) ──
def test_extract_pitch_track_finds_a_steady_tone():
    sr = 22050
    freq = 220.0  # A3, MIDI 57
    t = np.arange(sr * 1) / sr
    sig = np.sin(2 * np.pi * freq * t)
    frames = vocal_range.extract_pitch_track(sig, sr)
    voiced = [f for f in frames if f.voiced]
    assert voiced, "a clean 220Hz tone must produce voiced frames"
    med_midi = np.median([f.midi for f in voiced])
    assert abs(med_midi - 57.0) < 0.5  # tracks A3 within half a semitone


def test_tracker_then_summary_of_a_tone_is_a_narrow_range():
    sr = 22050
    sig = np.sin(2 * np.pi * 220.0 * np.arange(sr) / sr)
    frames = vocal_range.extract_pitch_track(sig, sr)
    out = vocal_range.summarize_range(frames, hop_sec=512 / sr)
    assert out["lowMidi"] is not None
    assert abs(out["highMidi"] - out["lowMidi"]) <= 1.0  # a single pitch → a one/two-semitone spread


def test_tracker_on_silence_has_no_voiced_frames():
    sr = 22050
    frames = vocal_range.extract_pitch_track(np.zeros(sr), sr)
    assert all(not f.voiced for f in frames)
    assert vocal_range.summarize_range(frames)["lowMidi"] is None
