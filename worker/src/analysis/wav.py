"""PCM WAV reading for the analysis domain.

`read_wav_mono` lived in `vocal_range.py` and `song_profile.py` reached into that module for it, coupling
the key/range builder to the range module for a helper that is neither. Its own module makes the
dependency honest — both `vocal_range` (the range summary) and `song_profile` (the key path) now read WAVs
from here — while the function's behaviour is UNCHANGED (a straight move: same float64 signal, same
downmix, same supported widths, same raise on an unsupported one).

numpy + stdlib only (`wave` is stdlib); no torch, no soundfile — the stems are plain PCM WAV in scratch at
this point in the process.
"""

from __future__ import annotations

import wave

import numpy as np


def read_wav_mono(path: str) -> tuple[np.ndarray, int]:
    """Read a PCM WAV to a mono float64 signal in [-1, 1] and its sample rate. Downmixes multi-channel
    by averaging. stdlib `wave` only — the vocals stem at this process stage is uncompressed PCM. Supports
    8/16/32-bit integer PCM (what ffmpeg's pcm_s16le decode produces); an unsupported width raises."""
    with wave.open(path, "rb") as wf:
        n_channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sample_rate = wf.getframerate()
        raw = wf.readframes(wf.getnframes())

    if sampwidth == 2:
        data = np.frombuffer(raw, dtype=np.int16).astype(np.float64) / 32768.0
    elif sampwidth == 4:
        data = np.frombuffer(raw, dtype=np.int32).astype(np.float64) / 2147483648.0
    elif sampwidth == 1:
        # 8-bit WAV is UNSIGNED (0..255, centre 128) — the one PCM width that is not signed.
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    else:
        raise ValueError(f"unsupported WAV sample width {sampwidth} bytes")

    if n_channels > 1:
        data = data.reshape(-1, n_channels).mean(axis=1)
    return data, sample_rate
