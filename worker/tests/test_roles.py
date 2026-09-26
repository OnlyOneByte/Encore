"""Stem role detection: the measurement that replaces a hand-filled table of 169 rows.

WHAT IS BEING PROTECTED. Publishing the vocals as the karaoke master is this worker's worst failure and it
is silent — the loudness probe passes it, the guide mix builds, and the person who finds out is singing
along to their own voice. The old defence was `Stems(instrumental_suffix=..., measured=True)`, one row per
model, hand-verified. That does not scale past a handful, so the role is measured from the audio instead.

Synthetic signals here, so the suite stays fast and hermetic; the real-audio validation lives at the bottom
and skips when the benchmark songs are absent.
"""

from __future__ import annotations

import os

import numpy as np
import pytest

from encore_worker.domain.audio import roles

RATE = 44100


def tone(freq: float, seconds: float = 3.0, gain: float = 0.3, rate: int = RATE) -> np.ndarray:
    t = np.arange(int(seconds * rate)) / rate
    return (gain * np.sin(2 * np.pi * freq * t)).reshape(-1, 1)


def band(freqs: tuple[float, ...], seconds: float = 3.0, gain: float = 0.3) -> np.ndarray:
    return sum(tone(f, seconds, gain) for f in freqs)  # type: ignore[return-value]


#: A stand-in backing track: kick fundamental plus a bass line, all below the cutoff.
BACKING = (55.0, 80.0, 110.0)
#: A stand-in vocal: a sung fundamental and its harmonics, all above it.
VOICE = (330.0, 660.0, 990.0, 1320.0)


# ── the measurement itself ───────────────────────────────────────────────────────────────────────


def test_bass_fraction_is_near_one_for_content_entirely_below_the_cutoff() -> None:
    assert roles.bass_fraction(band(BACKING), RATE) > 0.95


def test_bass_fraction_is_near_zero_for_content_entirely_above_it() -> None:
    assert roles.bass_fraction(band(VOICE), RATE) < 0.05


def test_silence_measures_zero_rather_than_dividing_by_zero() -> None:
    """The safe answer: a silent stem carries no evidence, so it must fail the ratio gate rather than be
    declared the backing track by accident."""
    assert roles.bass_fraction(np.zeros((RATE * 3, 1)), RATE) == 0.0


def test_a_signal_shorter_than_one_window_is_still_measured() -> None:
    """A 0.1 s input is shorter than the 32768-sample window. Padding and measuring beats refusing — the
    guide-mix length check already rejects absurd stems, and this must not be the thing that crashes."""
    assert roles.bass_fraction(band(BACKING, seconds=0.1), RATE) > 0.9


def test_it_is_a_whole_track_statistic_not_one_window() -> None:
    """A song whose first second is a quiet intro must not be characterised by that intro. Built as bass
    for 1 s then voice for 6 s: a single leading window would call this 100% bass."""
    signal = np.concatenate([band(BACKING, 1.0), band(VOICE, 6.0)])
    assert roles.bass_fraction(signal, RATE) < 0.5


# ── the verdict ──────────────────────────────────────────────────────────────────────────────────


def test_it_names_the_bass_heavy_stem_as_the_instrumental() -> None:
    got = roles.classify(("inst.wav", band(BACKING), RATE), ("voc.wav", band(VOICE), RATE))
    assert got is not None
    assert got.instrumental_path == "inst.wav"
    assert got.vocals_path == "voc.wav"


def test_the_answer_does_not_depend_on_argument_order() -> None:
    """THE PROPERTY THAT MAKES THIS USABLE. Callers discover files by globbing a directory, and the order a
    filesystem returns them in is not defined — so an order-sensitive answer would be a coin flip that
    looked deterministic in testing."""
    forward = roles.classify(("inst.wav", band(BACKING), RATE), ("voc.wav", band(VOICE), RATE))
    backward = roles.classify(("voc.wav", band(VOICE), RATE), ("inst.wav", band(BACKING), RATE))
    assert forward is not None and backward is not None
    assert forward.instrumental_path == backward.instrumental_path == "inst.wav"


def test_the_same_signal_twice_is_refused_rather_than_split() -> None:
    """A model that returned its input twice — or a passthrough, which this project has already shipped
    once — must be refused. There is no right answer to pick between two identical files."""
    same = band(BACKING + VOICE)
    assert roles.classify(("a.wav", same, RATE), ("b.wav", same, RATE)) is None


def test_two_silent_stems_are_refused() -> None:
    silence = np.zeros((RATE * 3, 1))
    assert roles.classify(("a.wav", silence, RATE), ("b.wav", silence, RATE)) is None


def test_a_thin_margin_is_refused_rather_than_guessed() -> None:
    """The refusal that makes the whole approach safe on untested material. Two stems that both carry some
    bass, within the ratio gate, produce no answer — because a refused job is recoverable and a mislabelled
    karaoke master is not."""
    mostly = band(BACKING, gain=0.30) + band(VOICE, gain=0.30)
    nearly = band(BACKING, gain=0.28) + band(VOICE, gain=0.30)
    assert roles.classify(("a.wav", mostly, RATE), ("b.wav", nearly, RATE)) is None


def test_one_silent_stem_against_a_real_one_is_still_decided() -> None:
    """Asymmetric silence is the clearest case this measurement has, not an ambiguous one: a model that
    emitted the backing track and an empty vocals file should still publish the backing track."""
    got = roles.classify(("inst.wav", band(BACKING), RATE), ("voc.wav", np.zeros((RATE * 3, 1)), RATE))
    assert got is not None and got.instrumental_path == "inst.wav"


def test_the_evidence_travels_with_the_verdict() -> None:
    """Both measurements are carried so a surprising answer is diagnosable from a log line. A verdict with
    no numbers behind it is the same debugging problem as the hand-filled table it replaced."""
    got = roles.classify(("inst.wav", band(BACKING), RATE), ("voc.wav", band(VOICE), RATE))
    assert got is not None
    assert got.instrumental_bass > got.vocals_bass
    assert got.ratio > roles.MIN_RATIO


def test_the_gate_is_adjustable_per_call() -> None:
    """So a caller with its own evidence — a model whose stems are already known — can demand more or less.
    Asserted because the threshold being a module constant should not make it a global policy."""
    a, b = band(BACKING, gain=0.3), band(BACKING, gain=0.1) + band(VOICE, gain=0.02)
    assert roles.classify(("a", a, RATE), ("b", b, RATE), min_ratio=1000.0) is None


# ── against real music, where the thresholds came from ───────────────────────────────────────────

SONGS = os.path.join(os.path.dirname(__file__), "..", "..", "docs", "benchmarks", "benchmark-songs")


@pytest.mark.parametrize("song", ["tfr-flyaway", "tfr-mayday", "tfr-chosen"])
def test_it_agrees_with_the_artists_own_stems(song: str) -> None:
    """The ground truth this was calibrated against: stems published by the artist, so the correct answer is
    known rather than inferred. Measured margins were 23.1x / 16.1x / 11.6x — the 11.6x is why `MIN_RATIO`
    is 3.0 and not 10.

    Skipped rather than faked when the audio is absent: it is gitignored and rebuilt by `prepare.py`.
    """
    import soundfile as sf

    inst = os.path.join(SONGS, song, "reference-instrumental.wav")
    voc = os.path.join(SONGS, song, "reference-vocals.wav")
    if not (os.path.isfile(inst) and os.path.isfile(voc)):
        pytest.skip(f"{song} is not prepared here; run scripts/prepare.py {song}")

    def load(path: str) -> tuple[str, np.ndarray, int]:
        data, rate = sf.read(path, dtype="float64", always_2d=True)
        return path, data, int(rate)

    got = roles.classify(load(inst), load(voc))
    assert got is not None, "refused a case with a known answer"
    assert got.instrumental_path == inst
    assert got.ratio > 10.0, (
        f"margin collapsed to {got.ratio:.1f}x; MIN_RATIO's headroom was calibrated on this"
    )
