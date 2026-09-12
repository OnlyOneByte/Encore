"""Integrated loudness measurement — the `songProfile` level half, per EBU R128 / ITU-R BS.1770-4.

WHY it lives here and not in the core. The core already parses a loudness reading
(`server/media/loudness.ts` shells `ffmpeg -af volumedetect` and pulls `mean_volume`/`max_volume`),
but that primitive is (a) a crude peak/mean dBFS number, not perceptual LUFS, and (b) wired only into
a boot-time backfill over the VOCALS stem — while the thing that plays in the room is the
INSTRUMENTAL. The instrument level is what a room-wide normalization has to equalize, and the
guide-vocal knob is a fraction of it, so the guide only means the same thing all night once the
instrumental is levelled. Measuring here, in the analysis domain, puts the number next to the WAV
that step already decodes.

WHY BS.1770 and not the mean dBFS the core already has. The issue offered "mean level (crude)" vs
"true LUFS (correct)"; the owner ruled to use a real package rather than hand-roll K-weighting, so
this measures integrated LUFS with `pyloudnorm` (a small, standard MIT implementation of the R128
K-weighting + gating). It runs over the mono float64 array `read_wav_mono` already produces — numpy
in, a number out, NO ffmpeg subprocess — which is exactly the `analysis/__init__.py` contract.

TRI-STATE, like every analysis half: a level that cannot be trusted is `None`, never a fabricated
default. A stem too short for BS.1770's 400 ms gating block, or digital silence (which happens on
this box), or any reader/measurement error, degrades to `None`. `None` is a real answer — "we could
not measure this song's level" — and the caller stores it as null, never as 0 LUFS (which would read
as a deafeningly loud track and attenuate it into inaudibility).

numpy + pyloudnorm ONLY. No torch, no soundfile, no subprocess.
"""

from __future__ import annotations

import numpy as np

from .wav import read_wav_mono

# BS.1770 integrates over 400 ms gating blocks; a signal shorter than one block cannot be gated and
# pyloudnorm raises. Guard it explicitly so we return None rather than letting the exception decide.
_MIN_GATING_BLOCK_SEC = 0.4

# Digital silence on this box sits at the 16-bit floor (see the silence-probe work): a stem whose
# peak sample is at or below this magnitude carries no measurable programme level, so BS.1770 would
# either raise (all blocks gated out) or report an absurd -70+ LUFS. Treat it as unmeasurable.
_SILENCE_PEAK = 1.0 / 32768.0  # one 16-bit LSB


def measure_lufs(wav_path: str | None) -> float | None:
    """Integrated loudness of a PCM WAV in LUFS (BS.1770-4), or `None` when it cannot be measured.

    Returns `None` — never a default number — when the path is missing, the stem is shorter than one
    400 ms gating block, the stem is digital silence, or the reader/meter raises for any reason. A
    real measurement is a negative float (typical mastered music sits around -8 to -20 LUFS).
    """
    if not wav_path:
        return None
    try:
        import pyloudnorm as pyln

        samples, sample_rate = read_wav_mono(wav_path)
        if samples.size < int(_MIN_GATING_BLOCK_SEC * sample_rate):
            return None
        if float(np.max(np.abs(samples))) <= _SILENCE_PEAK:
            return None

        meter = pyln.Meter(sample_rate)  # BS.1770-4 meter at the stem's own rate
        loudness = float(meter.integrated_loudness(samples))
        # A gated measurement over near-silence can come back as -inf/nan; that is unmeasurable, not
        # a level. Only a finite number is a real answer.
        if not np.isfinite(loudness):
            return None
        return loudness
    except Exception:  # noqa: BLE001 — analysis must never fail the cook; unmeasurable → None
        return None
