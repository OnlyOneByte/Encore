"""Timing: placing word timestamps on text that is already trusted.

The `Aligner` seam and the real WhisperX/wav2vec2 implementation behind it, plus the one process-wide
ML lock both this and `asr.py` take.

WHY THE LOCK LIVES HERE AND IS SHARED. One processor instance serves every align job and caches one
whisper model and one align model. With ENCORE_WORKER_CONCURRENCY>1 two jobs run at once on threads
sharing those models, and neither faster-whisper nor whisperx is thread-safe; the lazy loaders also
had a check-then-set race that could load a model twice and double the memory. It is ONE lock rather
than one per model deliberately: both passes are CPU-bound on the same cores, so serialising them
costs no throughput and stops two ML passes oversubscribing the box. RLock because the public methods
call the lazy loader while already holding it.

The aligner is not text-source-specific. It upgrades ANY text — a database lookup, an uploader's
captions, a local transcript — from line timing to word timing, which is why there is exactly one of
these and every tier goes through it.
"""
from __future__ import annotations

import threading
from typing import Any, Protocol

#: See the module docstring. Public because asr.py takes the same lock.
ML_LOCK = threading.RLock()


class Aligner(Protocol):
    """Force-align KNOWN text to audio. Given [{start,end,text}] segments + an audio path, return a
    WhisperX-shaped {language?, segments:[{start,end,text,words:[{word,start,end}]}]} with word
    timings. The real impl (WhisperxForcedAligner) wraps whisperx.load_align_model + whisperx.align;
    tests pass a fake. Raising signals the caller to fall back to line-sync."""

    def align(self, segments: list[dict[str, Any]], audio_path: str, language: str) -> dict[str, Any]: ...


class WhisperxForcedAligner:
    """Real forced aligner: loads the wav2vec2 align model for `language` and runs whisperx.align on
    the provided (known-text) segments. Lazy-imports whisperx so torch never loads unless used."""

    def __init__(self, device: str = "cpu") -> None:
        self._device = device
        self._cache: dict[str, tuple[Any, Any]] = {}

    def _model(self, language: str) -> tuple[Any, Any]:
        with _ML_LOCK:
            if language not in self._cache:
                import whisperx  # lazy: multi-GB torch

                self._cache[language] = whisperx.load_align_model(language_code=language, device=self._device)
            return self._cache[language]

    def align(self, segments: list[dict[str, Any]], audio_path: str, language: str) -> dict[str, Any]:
        import whisperx

        audio = whisperx.load_audio(audio_path)
        with _ML_LOCK:  # shared model across concurrent align jobs — see _ML_LOCK
            model, meta = self._model(language)
            # return_char_alignments=False → word-level only (what the overlay needs)
            out = whisperx.align(segments, model, meta, audio, self._device, return_char_alignments=False)
        out.setdefault("language", language)
        return out


# ── the aligner cache ──────────────────────────────────────────────────────────────
#
# Same reasoning as the transcriber cache in asr.py: keyed by device at module level so concurrent jobs
# share one loaded wav2vec2 model instead of one evicting the other's, and so no job pays to re-read it.
_ALIGNERS: dict[str, "WhisperxForcedAligner"] = {}


def aligner_for(device: str) -> "WhisperxForcedAligner":
    """The aligner for this device, loading its weights at most once per worker."""
    with ML_LOCK:
        got = _ALIGNERS.get(device)
        if got is None:
            got = _ALIGNERS[device] = WhisperxForcedAligner(device=device)
        return got
