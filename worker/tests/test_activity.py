"""Fitting a lyrics sheet onto a recording's own vocal activity.

WHAT THIS REPLACES. A forced aligner crops the audio to each segment's provisional span and aligns inside
it, so an offset sheet is not refined back — the offset passes through with unity gain. Measured over a
0..5 s sweep (docs/benchmarks/forced-alignment): `bias = 1.005 x offset + 131 ms`, max residual 41 ms. The
cost starts early: lines within +/-250 ms of truth drop 74.7% -> 42.7% at a 150 ms sheet offset, and to
20.0% at 250 ms.

`place.estimate_shift` always wanted "a reference measured on this audio", and the only one available was
the previous alignment's output — which carries the error it is removing, so a FIRST attempt could not be
corrected at all. This is that independent reference.

Synthetic signals here, so the suite stays fast and hermetic. The real-audio calibration is in the benchmark
document; the numbers quoted in these docstrings came from it.
"""

from __future__ import annotations

import numpy as np
import pytest

from encore_worker.domain.audio import activity

RATE = 16000


def sung(spans: list[tuple[float, float]], total: float = 60.0, rate: int = RATE) -> np.ndarray:
    """Audio that is loud exactly where `spans` say and quiet elsewhere. A stand-in vocals stem."""
    signal = np.random.default_rng(0).normal(0.0, 0.002, int(total * rate))
    for start, end in spans:
        a, b = int(start * rate), int(end * rate)
        t = np.arange(b - a) / rate
        signal[a:b] += 0.3 * np.sin(2 * np.pi * 220.0 * t)
    return signal


#: A plausible verse: eight phrases with gaps, the shape the fit reads.
PHRASES = [
    (5.0, 7.0),
    (8.0, 10.0),
    (12.0, 14.5),
    (16.0, 18.0),
    (22.0, 24.0),
    (25.5, 27.5),
    (30.0, 33.0),
    (35.0, 37.0),
]


def shifted(spans: list[tuple[float, float]], by: float) -> list[tuple[float, float]]:
    return [(s + by, e + by) for s, e in spans]


# ── the envelope ─────────────────────────────────────────────────────────────────────────────────


def test_the_envelope_is_high_where_there_is_singing_and_low_between() -> None:
    env = activity.envelope(sung(PHRASES), RATE)
    hop = activity.HOP_SEC
    assert env[int(6.0 / hop)] > 0.5, "mid-phrase should be active"
    assert env[int(20.0 / hop)] < 0.2, "the gap between phrases should not be"


def test_the_envelope_is_level_independent() -> None:
    """Normalised against the track's OWN loud level, so a quietly mastered song and a loud one produce
    comparable envelopes — the fit reads shape, not absolute dBFS."""
    quiet = activity.envelope(sung(PHRASES) * 0.05, RATE)
    loud = activity.envelope(sung(PHRASES) * 4.0, RATE)
    assert np.allclose(quiet, loud, atol=0.05)


def test_one_clipped_frame_does_not_flatten_everything_else() -> None:
    """Why the loud reference is a percentile and not the max: a single peak would scale every real phrase
    toward zero and the fit would read a flat line."""
    signal = sung(PHRASES)
    signal[int(45.0 * RATE)] = 60.0
    env = activity.envelope(signal, RATE)
    assert env[int(6.0 / activity.HOP_SEC)] > 0.5


def test_an_empty_signal_yields_an_empty_envelope_rather_than_raising() -> None:
    assert len(activity.envelope(np.zeros(0), RATE)) == 0


# ── the sheet's side ─────────────────────────────────────────────────────────────────────────────


def test_the_expected_envelope_marks_whole_spans_not_just_starts() -> None:
    """A duration is information the sheet already carries, and the fit is sharper for it: a train of
    impulses correlates worse against a continuous signal than a train of blocks."""
    env = activity.expected_envelope([(1.0, 3.0)], frames=300)
    hop = activity.HOP_SEC
    assert env[int(2.0 / hop)] == 1.0, "mid-span must be marked, not only the start"
    assert env[int(5.0 / hop) if int(5.0 / hop) < 300 else 299] == 0.0


def test_a_span_past_the_end_is_clipped_rather_than_overflowing() -> None:
    env = activity.expected_envelope([(0.0, 999.0)], frames=50)
    assert len(env) == 50 and env.all()


def test_a_zero_length_span_still_marks_one_frame() -> None:
    """Otherwise a sheet with a degenerate line contributes nothing and silently weakens the fit."""
    assert activity.expected_envelope([(1.0, 1.0)], frames=200).sum() == 1.0


# ── the fit ──────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("offset", [0.0, 0.25, 0.5, -0.5, 1.0, -2.0, 3.0])
def test_it_recovers_an_injected_offset(offset: float) -> None:
    """THE POINT. On real audio this recovered every offset in a 0..5 s sweep to within 10-20 ms — the frame
    quantum — which is an order of magnitude finer than the error it corrects."""
    signal = sung(PHRASES)
    fit = activity.fit_sheet_to_audio(signal, RATE, shifted(PHRASES, offset))
    assert fit.usable, f"refused a fit it should trust (r={fit.correlation:.2f})"
    assert abs(fit.seconds + offset) <= 3 * activity.HOP_SEC, f"offset {offset} recovered as {fit.seconds}"


def test_a_correct_sheet_is_left_where_it_is() -> None:
    """Applying a needless correction was measured to cost ONE line out of 75 on real audio, which is why
    there is no minimum-shift floor here — but the fit should still be near zero."""
    fit = activity.fit_sheet_to_audio(sung(PHRASES), RATE, PHRASES)
    assert abs(fit.seconds) <= 2 * activity.HOP_SEC


def test_a_sheet_for_a_DIFFERENT_song_is_refused() -> None:
    """THE REFUSAL THE GATE EXISTS FOR, and the asymmetry that sets its threshold: declining a good fit
    costs the offset we already live with, while accepting a bad one MOVES A SHEET THAT WAS CORRECT.

    On real audio a different song's sheet scored r = -0.10 .. 0.31 against 0.48 .. 0.59 for the right one.
    """
    other = [(1.0, 1.5), (2.0, 2.4), (3.0, 3.6), (40.0, 44.0), (50.0, 55.0), (57.0, 59.0)]
    fit = activity.fit_sheet_to_audio(sung(PHRASES), RATE, other)
    assert not fit.usable, f"accepted a mismatched sheet (r={fit.correlation:.2f})"


def test_silence_is_refused_rather_than_fitted_to_noise() -> None:
    """A constant envelope carries no lag information, and `np.corrcoef` on one returns NaN — which would
    compare as False in every direction and could be mistaken for a decision."""
    fit = activity.fit_sheet_to_audio(np.zeros(RATE * 30), RATE, PHRASES)
    assert not fit.usable
    assert fit.correlation == 0.0, "must be a definite zero, never NaN"


def test_an_empty_sheet_is_refused() -> None:
    assert not activity.fit_sheet_to_audio(sung(PHRASES), RATE, []).usable


def test_the_search_is_bounded() -> None:
    """Beyond a few seconds a sheet is not offset, it is a different song — and searching wider costs
    accuracy by admitting a spurious peak."""
    fit = activity.fit_sheet_to_audio(sung(PHRASES), RATE, shifted(PHRASES, 1.0), max_shift=0.2)
    assert abs(fit.seconds) <= 0.2 + activity.HOP_SEC


def test_the_gate_is_a_correlation_and_not_a_shift_size() -> None:
    """`place.MIN_SHIFT_SEC = 0.35` refuses a small shift as noise, which excluded the 0-350 ms band that
    does the most damage (74.7% -> 20.0% within +/-250 ms at a 250 ms offset). This estimator is accurate
    enough that the size of the shift is not evidence about the shift being right.
    """
    fit = activity.fit_sheet_to_audio(sung(PHRASES), RATE, shifted(PHRASES, 0.1))
    assert fit.usable, "a small shift must not be refused for being small"
    assert abs(fit.seconds + 0.1) <= 3 * activity.HOP_SEC


def test_the_evidence_travels_with_the_verdict() -> None:
    """The correlation is carried so a surprising shift is diagnosable from the attempt trail rather than
    only visible as moved timings."""
    fit = activity.fit_sheet_to_audio(sung(PHRASES), RATE, shifted(PHRASES, 0.5))
    assert 0.0 <= fit.correlation <= 1.0
    assert fit.correlation >= activity.MIN_CORRELATION
