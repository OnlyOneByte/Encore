"""Raw-stem audio reading for the analysis domain — WAV *or* FLAC, whichever the separator declared.

`read_wav_mono` lived in `vocal_range.py` and `song_profile.py` reached into that module for it, coupling
the key/range builder to the range module for a helper that is neither. Its own module makes the
dependency honest — both `vocal_range` (the range summary) and `song_profile` (the key path) read raw
stems from here.

WHY THIS IS NO LONGER `wave`-ONLY. This module used to be numpy + stdlib, on the stated grounds that
"the stems are plain PCM WAV in scratch at this point in the process". That was true of demucs and
demucs-mlx and false of audio-separator, which writes FLAC — and stdlib `wave` cannot open a FLAC. So on
an audiosep job both readers below failed, and the guide mix was refused with "stems do not match" when
the real cause was a container the reader could not parse. A missing container is not a length mismatch,
but nothing could tell the two apart. The format is now DECLARED by the engine
(`vocabulary.StemFormat`, `SeparatorEngine.stem_format`) rather than assumed here, and these readers
accept either container so that declaration is all a caller needs.

WAV STAYS ON STDLIB, DELIBERATELY. The `wave` path below is unchanged — same float64 signal, same
downmix, same supported widths, same raise on an unsupported one — because it is proven, it is what every
existing measurement was calibrated against, and it needs no dependency at all. `soundfile` is imported
LAZILY and only for a container `wave` cannot open. That ordering is what keeps this module importable on
a box carrying nothing but numpy: the worker's own unit suite runs on exactly such a box (no torch, no
ffmpeg, no soundfile — every heavy seam is faked), so a module-level `import soundfile` would break the
suite everywhere to serve a path most jobs never take.
"""

from __future__ import annotations

import wave

import numpy as np

#: Containers stdlib `wave` handles. Anything else goes to the lazy `soundfile` path.
_STDLIB_SUFFIXES = (".wav", ".wave")


def _read_via_wave(path: str) -> tuple[np.ndarray, int]:
    """The original stdlib reader: PCM WAV to mono float64 in [-1, 1], plus the sample rate.

    Byte-for-byte the behaviour this module shipped before FLAC support existed, including 8-bit WAV's
    unsigned centre-128 encoding — the one PCM width that is not signed.
    """
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


def _read_via_soundfile(path: str) -> tuple[np.ndarray, int]:
    """The FLAC (and anything-else) reader. Imported lazily — see the module docstring.

    Asks `soundfile` for float64 in [-1, 1] directly rather than scaling by hand, so per-width integer
    normalisation is the library's problem rather than a table this module has to keep correct.
    """
    try:
        import soundfile as sf
    except ImportError as exc:  # pragma: no cover — depends on the box, not the logic
        raise RuntimeError(
            f"cannot read {path!r}: reading a non-WAV stem needs the `soundfile` package "
            "(pinned in worker/requirements.txt). A worker separating to FLAC must have it installed."
        ) from exc

    data, sample_rate = sf.read(path, dtype="float64")
    # soundfile returns (frames,) for mono and (frames, channels) for multi-channel.
    if data.ndim > 1:
        data = data.mean(axis=1)
    return data, int(sample_rate)


def read_wav_mono(path: str) -> tuple[np.ndarray, int]:
    """Read a raw stem to a mono float64 signal in [-1, 1] and its sample rate.

    Accepts either container the separators emit: WAV goes through stdlib `wave`, anything else (FLAC)
    through `soundfile`. Downmixes multi-channel by averaging, which is what every caller here wants —
    key detection, pitch tracking and loudness are all defined on a mono signal.
    """
    reader = _read_via_wave if path.lower().endswith(_STDLIB_SUFFIXES) else _read_via_soundfile
    return reader(path)


def wav_frame_length(path: str) -> tuple[int, int] | None:
    """`(frames, sample_rate)` for a raw stem, or `None` when it cannot be read.

    Exists for ONE caller: the guide mix has to know whether its two source stems are the same length
    before it folds them together. `join` TRUNCATES to the shorter input and exits 0 — measured: a 3 s
    instrumental against a 1 s vocals stem yields a 1 s output — and because the mix is what the TV plays
    as MASTER it owns `duration`, so a short one cuts the song off with nothing in any log. It also
    silently resamples a rate mismatch, so the rate is returned too.

    Header only — neither backend decodes frames to answer this — so it is cheap enough to run
    unconditionally. `None` rather than a raise: an unreadable header is a reason to skip the mix, not a
    reason to fail a job whose instrumental is fine. Now that the format is declared rather than assumed,
    a `None` means genuinely unreadable rather than merely "not the container I expected".
    """
    try:
        if path.lower().endswith(_STDLIB_SUFFIXES):
            with wave.open(path, "rb") as w:
                return w.getnframes(), w.getframerate()
        import soundfile as sf

        info = sf.info(path)
        return int(info.frames), int(info.samplerate)
    except Exception:  # noqa: BLE001 — an unreadable header must not fail the load-bearing instrumental
        return None
