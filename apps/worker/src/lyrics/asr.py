"""ASR: guessing a song's words from its audio.

The `Transcriber` seam and the real faster-whisper implementation behind it. Distinct from
`timing.py` on purpose, and the distinction is the one this whole domain turns on: alignment places
timings on text we already trust, while ASR INVENTS the text. Its output is never authoritative
however confident the model sounds — which is why a transcript is a BASELINE (evidence of what is
audible) and never a candidate for the song's words. See `chain.py`.

MEASURED (2026-09-02, real stem, `base` on CPU): `transcribe()` returns segment bounds and NO word
timings. Word timings come only from the separate `align()` pass, so the aligner is the single source
of word timing for every tier, looked-up or transcribed.

torch is imported LAZILY inside the loader, so a worker that never runs an align job never pays the
multi-GB import.
"""

from __future__ import annotations

from typing import Any, Protocol, cast

from .timing import ML_LOCK

DEFAULT_MODEL = "base"


class Transcriber(Protocol):
    """ASR: invent the text from audio. Injectable; raising means "this tier missed", not "the job
    failed".

    Distinct from the aligner on purpose. Alignment places timings on text we already trust; ASR
    GUESSES the words, so its output is never authoritative however confident the model sounds. It
    earns its place because it needs nothing external and comparing its transcript against an
    authoritative lookup is the only signal that catches a confidently wrong LRCLIB match (see
    agreementScore in shared/lyrics.ts).
    """

    def transcribe(self, audio_path: str, language: str | None = None) -> dict[str, Any]: ...


class WhisperxTranscriber:
    """Real ASR via faster-whisper through whisperx.load_model().transcribe().

    Runs on the VOCALS STEM, not the mix (see AsrSource). `language=None` lets whisper DETECT the
    language: nothing populates the sidecar's language field today, so the alternative is a
    hardcoded 'en'.
    """

    def __init__(
        self, device: str = "cpu", model: str = DEFAULT_MODEL, compute_type: str | None = None
    ) -> None:
        self._device = device
        self._model_name = model
        # int8 on CPU: float16 is a GPU format and faster-whisper refuses it on CPU.
        self._compute_type = compute_type or ("float16" if device.startswith("cuda") else "int8")
        self._model: Any = None

    def _load(self) -> Any:
        with ML_LOCK:
            if self._model is None:
                import whisperx  # lazy: multi-GB torch stays off the import path until this tier runs

                self._model = whisperx.load_model(
                    self._model_name, self._device, compute_type=self._compute_type
                )
            return self._model

    def transcribe(self, audio_path: str, language: str | None = None) -> dict[str, Any]:
        import whisperx

        audio = whisperx.load_audio(audio_path)
        with ML_LOCK:  # one model, possibly two concurrent align jobs — see ML_LOCK
            out = self._load().transcribe(audio, language=language)
        if language and not out.get("language"):
            out["language"] = language
        return cast(dict[str, Any], out)


# ── the model cache ────────────────────────────────────────────────────────────────
#
# Keyed by (device, model) at MODULE level, not held on a processor instance.
#
# The old design cached one loaded model on the single WhisperXProcessor and nulled it whenever a job
# asked for a different checkpoint. That is what made engine adoption mutate shared state, and with
# ENCORE_WORKER_CONCURRENCY > 1 two jobs could invalidate each other's cache mid-run. Dropping the cache
# entirely would be worse than the race: every align job would re-read multi-GB weights.
#
# Keying by configuration gets both. Two concurrent jobs on the same checkpoint SHARE the loaded model,
# two on different checkpoints each keep theirs, and no job can evict another's. Loading is under ML_LOCK
# because the lazy loader had a check-then-set race that could load the same model twice and double the
# memory.
_TRANSCRIBERS: dict[tuple[str, str], WhisperxTranscriber] = {}


def transcriber_for(device: str, model: str) -> WhisperxTranscriber:
    """The transcriber for this (device, model), loading its weights at most once per worker."""
    key = (device, model)
    with ML_LOCK:
        got = _TRANSCRIBERS.get(key)
        if got is None:
            got = _TRANSCRIBERS[key] = WhisperxTranscriber(device=device, model=model)
        return got
