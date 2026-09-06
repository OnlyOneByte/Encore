"""Vocal-range summary — percentiles, histogram, and the load-bearing empty case, driven by canned
PitchFrame lists (no audio needed). A couple of tests also exercise the pure-numpy tracker on a
synthesized tone, since the `pitch_track.py` the task described does not exist and the tracker had to
live in this module."""
import ast
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.analysis import vocal_range  # noqa: E402
from src.analysis.vocal_range import PitchFrame  # noqa: E402


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


# ── the autocorrelation is the FFT one, and still means the naive thing ──────────
#
# `_detect_f0` used `np.correlate(..., mode="full")` under a comment claiming it was an FFT. It is
# numpy's DIRECT O(n^2) convolution, and at frame 2048 / hop 512 it cost 18.5s of single-threaded CPU
# for a 3-minute song — about a third of htdemucs separation time, inside what reads like a cheap
# metadata step. Neither existing suite caught it because both test correctness, and the answers were
# right; only the cost was wrong.
#
# These two guard the fix from both directions: the fast path must keep meaning the naive definition,
# and the naive definition must not come back as the implementation.


def _naive_autocorr_f0(frame: np.ndarray, sample_rate: int) -> tuple[float, float]:
    """The O(n^2) reference: `_detect_f0` written the slow, obvious way.

    Kept HERE rather than in `src` on purpose. It is the definition the fast path has to satisfy, so it
    belongs with the test that checks that — and a reader comparing the two can see the FFT is only an
    optimisation, not a different algorithm.
    """
    n = frame.size
    min_lag = max(1, int(sample_rate / vocal_range._FMAX_HZ))
    max_lag = min(n - 1, int(sample_rate / vocal_range._FMIN_HZ))
    if max_lag <= min_lag:
        return 0.0, 0.0
    frame = frame - frame.mean()
    energy = float(np.dot(frame, frame))
    if energy <= 0:
        return 0.0, 0.0
    corr = np.correlate(frame, frame, mode="full")[n - 1 :] / energy
    window = corr[min_lag : max_lag + 1]
    if window.size == 0:
        return 0.0, 0.0
    peak_idx = int(np.argmax(window))
    lag = min_lag + peak_idx
    clarity = float(window[peak_idx])
    if 0 < lag < corr.size - 1:
        a, b, c = corr[lag - 1], corr[lag], corr[lag + 1]
        denom = a - 2.0 * b + c
        if denom != 0:
            lag = lag + 0.5 * (a - c) / denom
    if lag <= 0:
        return 0.0, 0.0
    return sample_rate / lag, clarity


def test_the_rfft_autocorrelation_agrees_with_the_naive_definition():
    """Same algorithm, same answers — across the cases that actually occur in a vocals stem.

    The zero-padding is the part that could silently be wrong: an FFT computes a CIRCULAR correlation,
    so without padding to >= 2n-1 the value at lag k wraps and picks up energy from the frame's opposite
    end. That failure would look like plausible-but-wrong pitches rather than an error, which is exactly
    what a reference comparison catches and a smoke test does not.
    """
    sr, frame_n, hop = 44100, 2048, 512
    rng = np.random.default_rng(0)
    t = np.arange(int(sr * 0.5)) / sr
    cases = {
        "sung chord": sum(np.sin(2 * np.pi * f * t) for f in (220.0, 277.2, 329.6)) / 3.0
        + 0.01 * rng.standard_normal(t.size),
        "low note at the male floor": np.sin(2 * np.pi * 82.4 * t) + 0.02 * rng.standard_normal(t.size),
        "high note": np.sin(2 * np.pi * 900.0 * t) + 0.02 * rng.standard_normal(t.size),
        "unvoiced noise": rng.standard_normal(t.size),
        "digital silence": np.zeros(t.size),
        "DC offset plus tone": 0.5 + np.sin(2 * np.pi * 220.0 * t),
    }
    for name, sig in cases.items():
        for start in range(0, sig.size - frame_n + 1, hop):
            chunk = sig[start : start + frame_n]
            want_f0, want_clarity = _naive_autocorr_f0(chunk, sr)
            got_f0, got_clarity = vocal_range._detect_f0(chunk, sr)
            # 1e-3 Hz, not exact equality: the parabolic interpolation sits on a flatter peak for a low
            # note, so float noise in the FFT round-trip shows up amplified there (measured worst case
            # 7.6e-05 Hz at 82Hz — about a millionth of a semitone).
            assert abs(got_f0 - want_f0) < 1e-3, f"{name} @ {start}: f0 {got_f0} != {want_f0}"
            assert abs(got_clarity - want_clarity) < 1e-9, f"{name} @ {start}: clarity differs"


def test_the_hot_loop_does_not_regress_to_the_O_n2_form():
    """A structural guard, because the regression is invisible to every correctness test.

    `np.correlate` gives the right answers 17x too slowly. Nothing about the output distinguishes the two
    implementations, so the only thing that can stop a well-meaning "simplification" from putting the
    O(n^2) form back is a test that inspects the code. If a future change genuinely needs `np.correlate`
    here, delete this test deliberately and say why in the commit.

    Reads the AST rather than the text: a substring scan also matches the comment that EXPLAINS why
    np.correlate was removed, so it would fail on the very prose that keeps the fix understood. Only real
    call expressions count.
    """
    tree = ast.parse(Path(vocal_range.__file__).read_text(encoding="utf-8"))
    called = {ast.unparse(node.func) for node in ast.walk(tree) if isinstance(node, ast.Call)}
    assert "np.correlate" not in called, (
        "vocal_range calls np.correlate again — that is numpy's DIRECT O(n^2) convolution, not an FFT, "
        "and it costs ~18.5s per 3-minute song instead of ~1.1s"
    )
    assert "np.fft.rfft" in called, "the autocorrelation should go through rfft"


# ── summarize_wav: the ONLY production path (song_profile.py:76), and it had zero coverage ──
#
# summarize_wav is what actually runs in a cook: read the vocals WAV, track pitch, summarize. Every
# existing summary test injects hop_sec EXPLICITLY (summarize_range(..., hop_sec=...)), which is the
# one thing production does NOT do — summarize_wav must derive hop_sec itself and keep it in step with
# the hop extract_pitch_track actually advanced by. So a change to extract_pitch_track's default hop
# (the ordinary shape of tuning time resolution) could halve or double every published histogram
# second while all other tests stayed green. These pin the whole path end-to-end.


def _write_pcm16_wav(path, samples, sr):
    """Minimal 16-bit mono PCM WAV writer — the exact shape read_wav_mono reads and the cook produces."""
    import wave

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(pcm.tobytes())


def test_summarize_wav_histogram_seconds_track_real_duration(tmp_path):
    """The load-bearing pin: total histogram SECONDS must equal the real sung DURATION.

    The expectation is derived from PHYSICS, not from the code's hop. A steady, clearly-voiced tone
    makes every analysis frame voiced, so the histogram accumulates one hop_sec per frame across the
    whole signal — and the sum of those must equal the wall-clock span the frames cover, which for a
    tone filling the signal is ~= the signal's own duration (last frame start + one hop). If summarize_wav
    ever uses a hop_sec that disagrees with the hop extract_pitch_track actually stepped by, this sum is
    scaled by exactly that ratio (halved when the real hop doubles) and this assertion reds — while
    lowMidi/highMidi/percentiles stay correct, which is exactly the invisible failure mode.
    """
    sr = 22050
    duration_sec = 2.0  # a KNOWN duration chosen here, never read back from the code
    n = int(sr * duration_sec)
    sig = np.sin(2 * np.pi * 220.0 * np.arange(n) / sr)  # A3, sustained → every frame voiced
    wav = tmp_path / "voc.wav"
    _write_pcm16_wav(wav, sig, sr)

    out = vocal_range.summarize_wav(str(wav))
    assert out["histogram"] is not None, "a clean sustained tone must produce voiced frames"
    total_seconds = sum(out["histogram"])

    # The frames span from t=0 to the last frame's start; the sum of per-frame hops covers that span.
    # A steady tone fills the whole signal, so total voiced seconds must be within ONE frame (2048/sr ≈
    # 0.093s) of the real 2.0s duration. The halving mutation lands at ~0.96s — an order of magnitude
    # outside this tolerance, so the test is decisive, not fuzzy.
    frame_sec = 2048 / sr
    assert abs(total_seconds - duration_sec) < frame_sec + 0.02, (
        f"summarize_wav histogram totals {total_seconds:.4f}s for a {duration_sec}s tone; "
        f"the seconds axis is desynced from the real frame hop"
    )


def test_summarize_wav_derives_hop_from_the_same_constant_extract_pitch_track_defaults_to(tmp_path):
    """Structural pin on the coupling itself: summarize_wav's hop_sec and extract_pitch_track's default
    hop must be the SAME value, so tuning one cannot silently leave the other stale.

    Independent of the code: probe extract_pitch_track's ACTUAL default hop by reading the frame spacing
    it produces (two consecutive frame start times), then confirm summarize_wav's own histogram second
    count equals (voiced frame count) x (that measured hop / sample_rate). The measured hop is taken from
    the frame timeline, never from summarize_wav's arithmetic, so a desync between the two hop sites reds
    this even though every summarize_range(hop_sec=...) test would stay green.
    """
    sr = 22050
    n = int(sr * 2.0)
    sig = np.sin(2 * np.pi * 220.0 * np.arange(n) / sr)
    wav = tmp_path / "voc.wav"
    _write_pcm16_wav(wav, sig, sr)

    frames = vocal_range.extract_pitch_track(sig, sr)  # default hop — the production call
    assert len(frames) >= 2
    measured_hop_samples = round((frames[1].time_sec - frames[0].time_sec) * sr)
    measured_hop_sec = measured_hop_samples / sr
    n_voiced = sum(1 for f in frames if f.voiced)

    out = vocal_range.summarize_wav(str(wav))
    total_seconds = sum(out["histogram"])
    expected = n_voiced * measured_hop_sec
    assert abs(total_seconds - expected) < 1e-9, (
        f"summarize_wav totals {total_seconds:.6f}s but the tracker stepped {measured_hop_samples} "
        f"samples/frame over {n_voiced} voiced frames = {expected:.6f}s — the hop constants disagree"
    )
