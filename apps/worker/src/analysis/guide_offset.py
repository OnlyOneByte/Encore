"""Measure the guiding track's offset against the instrumental — the guide-alignment half of the guide
feature, made OBSERVABLE at process time instead of assumed in the room (#766).

WHY THIS EXISTS. `guide-sync.ts` on the TV is blind by construction to any offset baked into the DECODED
audio: it only ever compares the two media elements' reported `currentTime`, so a vocals stem that is
time-shifted in its SAMPLES — container priming (the ~1024-sample / ~21 ms AAC-in-m4a asymmetry #480
moved both stems to FLAC to kill), an mp4 edit list, a genuinely misaligned separation — leaves both
playheads reading the same number while the ears hear the guide early or late. Nothing in the product can
see that today; it is diagnosed by ear on the party box, one report at a time. This measures it once, from
the two raw stems the separation step already has in scratch, and hands the core a single signed number.

WHY CROSS-CORRELATION, not a codec/priming lookup. The issue offered either. Correlation is engine- and
container-agnostic: it catches the priming case AND a genuinely shifted separation AND any future decode
path that delays one stem, without a table of per-codec priming constants to keep in step with ffmpeg. The
two stems came from ONE mix, so at the true offset their loud moments line up — a normalized correlation
peak whose lag IS the offset.

PURE by construction, like the rest of `analysis/`: it reads the two WAVs `read_wav_mono` already knows how
to read (numpy + stdlib `wave`), does numpy arithmetic, and returns a number. No subprocess, no torch.

TRI-STATE, like every analysis half (`measure_lufs`, the song profile): a value that cannot be TRUSTED is
`None`, never a fabricated 0. `None` means "we could not measure this song's guide offset"; the core stores
that as null and the client holds the guide exactly as today. A confident measurement is a signed int of
milliseconds — POSITIVE when the vocals LAG the instrumental (its content arrives late, so the client seeks
it earlier to line up), negative when it leads.
"""

from __future__ import annotations

import numpy as np

from .wav import read_wav_mono

# The window we search for the offset, each side of zero. A guide/instrumental misalignment worth
# correcting is a container/priming/edit-list artifact or a separation slip — tens of milliseconds, not
# seconds. Searching wider would let a spurious late peak (a repeated musical phrase) win a lag no real
# decode path produces, so the search is BOUNDED and a peak that wants to sit outside it is reported as
# "no confident offset" (None) rather than a wild number.
_MAX_LAG_SEC = 0.5

# Both stems must carry enough programme to correlate. A fraction-of-a-second clip has no structure to
# line up, so a peak in it is noise; below this we decline to measure. The window is also what bounds the
# cost — we correlate a leading slice, not the whole four minutes.
_MIN_ANALYSIS_SEC = 2.0
_ANALYSIS_WINDOW_SEC = 30.0

# Digital silence on this box sits at the 16-bit floor (see the silence-probe work). A stem whose peak is
# at or below one LSB carries nothing to correlate; treat it as unmeasurable rather than correlating noise.
_SILENCE_PEAK = 1.0 / 32768.0  # one 16-bit LSB

# How decisively the best lag must beat the field before we trust it. The normalized cross-correlation at
# the winning lag is compared to the correlation at zero lag: a real offset makes the peak meaningfully
# stronger than "leave it where it is", while two already-aligned stems (the common FLAC case) peak AT zero
# and this ratio is ~1, which we report as offset 0 — a measured 0, distinct from an unmeasurable None.
_PEAK_MARGIN = 1.05


def measure_guide_offset_ms(vocals_wav: str | None, instrumental_wav: str | None) -> int | None:
    """Signed millisecond offset of the vocals stem against the instrumental, or `None` when it cannot be
    measured confidently.

    Positive → the vocals LAG the instrumental (seek the guide earlier to align); negative → they lead.
    `None` — never a default 0 — when either path is missing, either stem is too short or digital silence,
    the two rates disagree, or no lag inside ±_MAX_LAG_SEC beats zero-lag by _PEAK_MARGIN. A confident
    result is a rounded whole millisecond, which is all the client's second-level alignment needs.
    """
    if not vocals_wav or not instrumental_wav:
        return None
    try:
        vox, vox_rate = read_wav_mono(vocals_wav)
        inst, inst_rate = read_wav_mono(instrumental_wav)
    except Exception:  # noqa: BLE001 — an unreadable stem is "cannot measure", never fatal to the process
        return None

    # Different sample rates would make a lag-in-samples ambiguous. The two stems come from one separation
    # pass and always share a rate; a mismatch means something upstream we should not paper over — decline.
    if vox_rate != inst_rate or vox_rate <= 0:
        return None
    rate = vox_rate

    min_samples = int(_MIN_ANALYSIS_SEC * rate)
    if vox.size < min_samples or inst.size < min_samples:
        return None
    if float(np.max(np.abs(vox))) <= _SILENCE_PEAK or float(np.max(np.abs(inst))) <= _SILENCE_PEAK:
        return None

    # Correlate a leading window of both stems — enough structure to line up, bounded cost. Both are
    # sliced to the same length so a lag is measured over the same span.
    window = min(int(_ANALYSIS_WINDOW_SEC * rate), vox.size, inst.size)
    a = _normalize(vox[:window])
    b = _normalize(inst[:window])
    if a is None or b is None:
        return None

    max_lag = int(_MAX_LAG_SEC * rate)
    lag = _best_lag(a, b, max_lag)
    if lag is None:
        return None

    # Convention: a POSITIVE lag from _best_lag means `a` (vocals) must shift LATER to match `b`
    # (instrumental) — i.e. the vocals currently arrive EARLY relative to the instrumental. The field's
    # sign is "how late the vocals are", so a vocals-early stem is a negative offset. Negate to match.
    offset_ms = round(-lag / rate * 1000.0)
    return int(offset_ms)


def _normalize(x: np.ndarray) -> np.ndarray | None:
    """Zero-mean, unit-norm the signal so the cross-correlation is a bounded similarity independent of each
    stem's absolute level (the instrumental and an isolated vocal are nowhere near the same loudness).
    Returns None for a degenerate all-flat window that cannot be normalized."""
    x = x - x.mean()
    norm = float(np.sqrt(np.dot(x, x)))
    if norm <= 0.0:
        return None
    return x / norm


def _best_lag(a: np.ndarray, b: np.ndarray, max_lag: int) -> int | None:
    """The lag (in samples, within ±max_lag) at which `a` best matches `b`, or None when no lag decisively
    beats leaving the two where they are.

    Both inputs are already zero-mean/unit-norm, so a dot product at a lag is a normalized correlation in
    [-1, 1]. We compare the strongest lag to the zero-lag correlation: a real offset makes some non-zero
    lag beat zero by at least _PEAK_MARGIN, while two aligned stems peak at zero and fall through to a
    measured 0.
    """
    n = min(a.size, b.size)
    zero_corr = abs(float(np.dot(a[:n], b[:n])))

    best_lag = 0
    best_corr = zero_corr
    for lag in range(-max_lag, max_lag + 1):
        if lag == 0:
            continue
        if lag > 0:
            # Shift a later: compare a[0:] against b[lag:].
            m = n - lag
            if m <= 0:
                break
            corr = abs(float(np.dot(a[:m], b[lag : lag + m])))
        else:
            m = n + lag  # lag negative
            if m <= 0:
                break
            corr = abs(float(np.dot(a[-lag : -lag + m], b[:m])))
        if corr > best_corr:
            best_corr = corr
            best_lag = lag

    if best_lag == 0:
        return 0  # aligned — a measured zero, not an unmeasurable None
    if zero_corr <= 0.0 or best_corr < zero_corr * _PEAK_MARGIN:
        return None  # nothing beat zero-lag decisively — decline rather than invent an offset
    return best_lag
