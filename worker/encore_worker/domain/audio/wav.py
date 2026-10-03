"""Raw-stem audio reading for the analysis domain — WAV *or* FLAC, whichever the separator declared.

WAV stays on stdlib `wave` and `soundfile` is imported LAZILY, so this module is importable on a box carrying
nothing but numpy — which is what the unit suite runs on. Why the container is PROBED rather than read off the
extension, and what the frame-length probe is for: `docs/arch/05-worker.md` §3.1.
"""

from __future__ import annotations

import wave

import numpy as np

#: Suffixes the stdlib reader may be TRIED on; anything else goes straight to `soundfile`.
_STDLIB_SUFFIXES = (".wav", ".wave")


def _read_via_wave(path: str) -> tuple[np.ndarray, int]:
    """PCM WAV to mono float64 in [-1, 1], plus the sample rate."""
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
        # 8-bit WAV is UNSIGNED (0..255, centre 128), the one PCM width that is not.
        data = (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    else:
        raise ValueError(f"unsupported WAV sample width {sampwidth} bytes")

    if n_channels > 1:
        data = data.reshape(-1, n_channels).mean(axis=1)
    return data, sample_rate


def _read_via_soundfile(path: str) -> tuple[np.ndarray, int]:
    """The FLAC (and anything-else) reader, imported lazily and asked for float64 directly."""
    try:
        import soundfile as sf
    except ImportError as exc:  # pragma: no cover — depends on the box, not the logic
        raise RuntimeError(
            f"cannot read {path!r}: reading a non-WAV stem needs the `soundfile` package "
            "(pinned in worker/pyproject.toml's `ml` extra). A worker separating to FLAC "
            "must have it installed."
        ) from exc

    data, sample_rate = sf.read(path, dtype="float64")
    # soundfile returns (frames,) for mono and (frames, channels) for multi-channel.
    if data.ndim > 1:
        data = data.mean(axis=1)
    return data, int(sample_rate)


def _is_stdlib_readable(path: str) -> bool:
    """Can stdlib `wave` open this? A `.wav` extension is NOT enough to say yes — bs-roformer writes
    float32 WAV, which it refuses (`docs/arch/05-worker.md` §3.1)."""
    if not path.lower().endswith(_STDLIB_SUFFIXES):
        return False
    try:
        with wave.open(path, "rb"):
            return True
    except Exception:  # noqa: BLE001 - any refusal means "not this reader's job"; soundfile gets it
        return False


def read_wav_mono(path: str) -> tuple[np.ndarray, int]:
    """Read a raw stem to a mono float64 signal in [-1, 1] and its sample rate, downmixed by averaging."""
    # Probed, not inferred: a float32 `.wav` is still a `.wav`.
    reader = _read_via_wave if _is_stdlib_readable(path) else _read_via_soundfile
    return reader(path)


def wav_frame_length(path: str) -> tuple[int, int] | None:
    """`(frames, sample_rate)` for a raw stem, or `None` when it cannot be read.

    Exists for ONE caller, the guide mix's length check, and reads the header only (`docs/arch/05-worker.md`
    §3.1). `None` rather than a raise: a reason to skip the mix, not to fail a job.
    """
    try:
        if _is_stdlib_readable(path):
            with wave.open(path, "rb") as w:
                return w.getnframes(), w.getframerate()
        import soundfile as sf

        info = sf.info(path)
        return int(info.frames), int(info.samplerate)
    except Exception:  # noqa: BLE001 — an unreadable header must not fail the load-bearing instrumental
        return None
