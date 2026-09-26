"""Which of two separated stems is the BACKING TRACK, decided from the audio rather than from a filename.

WHY THIS EXISTS. Publishing the vocals as the karaoke master is the worst failure this worker has, and it
is SILENT: the silence probe passes it (the vocals stem is loud), the guide mix builds (both files are the
right length), and the first person to find out is someone standing in a room singing along to their own
voice. Until now the defence was a hand-filled table — `Stems(instrumental_suffix=..., measured=True)` —
which works for three models and cannot work for a hundred and sixty-nine.

So the role is MEASURED at job time. That scales to any checkpoint, including one added tomorrow by
someone who never read this file, and it is strictly more trustworthy than a declaration: it inspects the
bytes that are about to be published rather than a note about what they should contain.

THE DISCRIMINATOR: the fraction of spectral energy below 250 Hz.

A backing track carries the kick drum and the bass line; an isolated vocal has almost nothing down there,
because even a bass singer's fundamental sits around 80-100 Hz and carries little of the voice's total
energy. Measured on three songs' ARTIST-SUPPLIED ground-truth stems:

    song          instrumental   vocals    ratio
    tfr-flyaway        79.36%     3.44%    23.1x
    tfr-mayday         85.96%     5.35%    16.1x
    tfr-chosen         76.43%     6.61%    11.6x

Instrumentals land at 76-86% and vocals at 3-7% with no overlap and an order of magnitude of margin. The
same measurement independently reproduces the bs-roformer filename inversion that originally took a
synthetic control to find: its `_other` file scores 79.98% and its `_instrumental` file 3.25%, so `_other`
is the backing track — which is what the registry records.

WHY NOT ACTIVITY (how much of the time a stem is making sound), which is the intuitive choice: vocals are
intermittent and backing tracks continuous, but measured the gap is 97.8% against 81% — a 1.2x margin
against the bass fraction's 12x. It is a real signal and far too weak to bet on. It is not used.

THE HONEST LIMITATION: all three validation songs are electronic, which is the genre most likely to
flatter this measurement. A sparse acoustic recording — solo piano and voice, no drums or bass — would
narrow the gap. That is why this returns None rather than a guess when the margin is thin: a refused job
is recoverable and a mislabelled master is not.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

#: Below this, a backing track's kick and bass live and a voice does not. Not tuned — 250 Hz is roughly the
#: top of the bass register, and the measured margin is wide enough that the exact value does not matter.
BASS_CUTOFF_HZ = 250.0

#: How much more low-frequency energy the instrumental must carry, as a ratio, before the answer is trusted.
#:
#: The smallest margin measured on real ground truth is 11.6x, so 3.0 keeps almost a factor of four in
#: reserve for material sparser than anything tested. Raising it makes the worker refuse more jobs; lowering
#: it makes it guess on material it should decline. Refusing is the recoverable direction.
MIN_RATIO = 3.0

#: FFT size for the spectral estimate: 32768 samples is ~0.74 s at 44.1 kHz, long enough that a 40 Hz bin is
#: resolved rather than smeared into DC.
_WINDOW = 1 << 15


@dataclass(frozen=True, slots=True)
class Roles:
    """Which path holds which stem, and how confidently."""

    instrumental_path: str
    vocals_path: str
    #: The two bass fractions, instrumental first. Carried so a caller can log the evidence rather than just
    #: the verdict — this is what makes a surprising answer diagnosable.
    instrumental_bass: float
    vocals_bass: float

    @property
    def ratio(self) -> float:
        return self.instrumental_bass / max(self.vocals_bass, 1e-9)


def bass_fraction(signal: np.ndarray, rate: int, cutoff: float = BASS_CUTOFF_HZ) -> float:
    """Share of this signal's spectral energy below `cutoff`, in 0..1.

    Averaged over windows spaced far apart rather than computed on one FFT of the whole file: a song's
    arrangement changes, and a single window landing on an intro or a breakdown would describe that bar
    instead of the track. Energy (amplitude squared) rather than amplitude, so the result is a power share.

    Returns 0.0 for silence, which is the safe answer — a silent stem carries no evidence either way and
    will fail the ratio gate rather than be declared the backing track.
    """
    mono = signal.mean(axis=1) if signal.ndim > 1 else signal
    if len(mono) < _WINDOW:
        # Short input: one window over what there is, zero-padded. Still better than refusing to measure.
        mono = np.pad(mono, (0, _WINDOW - len(mono)))
    window = np.hanning(_WINDOW)
    freqs = np.fft.rfftfreq(_WINDOW, 1.0 / rate)
    low = freqs < cutoff

    bass = 0.0
    total = 0.0
    # Stride two windows at a time: this is a statistic about the whole track, not a spectrogram, so
    # overlapping windows would only cost time.
    for start in range(0, max(1, len(mono) - _WINDOW), _WINDOW * 2):
        segment = mono[start : start + _WINDOW]
        if len(segment) < _WINDOW:
            break
        power = np.abs(np.fft.rfft(segment * window)) ** 2
        bass += float(power[low].sum())
        total += float(power.sum())
    return bass / total if total > 0 else 0.0


def classify(
    first: tuple[str, np.ndarray, int],
    second: tuple[str, np.ndarray, int],
    *,
    min_ratio: float = MIN_RATIO,
) -> Roles | None:
    """Decide which of two stems is the backing track. `None` means "cannot tell" — never a coin flip.

    Each argument is `(path, signal, rate)`. Returns None when the two stems' low-frequency content is too
    similar to separate them, which happens for material with no bass at all and for a model that returned
    the mixture twice.
    """
    a_path, a_signal, a_rate = first
    b_path, b_signal, b_rate = second
    a = bass_fraction(a_signal, a_rate)
    b = bass_fraction(b_signal, b_rate)

    higher, lower = (a, b) if a >= b else (b, a)
    if lower <= 0.0:
        # One stem has no low-frequency energy whatsoever. That is not ambiguity — it is as clear as this
        # measurement gets — but only if the other one does.
        if higher <= 0.0:
            return None
    elif higher / lower < min_ratio:
        return None

    if a >= b:
        return Roles(instrumental_path=a_path, vocals_path=b_path, instrumental_bass=a, vocals_bass=b)
    return Roles(instrumental_path=b_path, vocals_path=a_path, instrumental_bass=b, vocals_bass=a)
