"""Diarization: labelling WHICH voice sings each stretch of the vocals stem.

The `Diarizer` seam and the real pyannote-backed implementation behind it. This is the SOURCE of duet
part attribution; the pure mapping from its output to a `part` label on each lyric line lives next
door in `attribution.py`, separate for the same reason ASR and alignment are: one INVENTS speaker
turns from audio, the other is pure arithmetic over the result and must be testable with no model.

Runs on the ISOLATED VOCALS STEM (`ctx.audio.vocals_path`), the same input the aligner and ASR
prefer, since a full mix diarizes even worse. Diarization on *overlapping sung* vocals is materially
harder than on speech, which is why the attribution layer is conservative and the whole feature falls
back to one colour when unsure.

torch/pyannote are imported LAZILY inside the loader, exactly like `lyrics/asr.py`: a worker that
never runs an align job — or a box without the model — never pays the multi-GB import, and the
capability probe uses `find_spec` so building the advertised set stays import-free.
"""

from __future__ import annotations

import os
from typing import Any, Protocol

from ..mlrt import ML_LOCK

#: The pyannote pipeline id. Gated on Hugging Face, so it only loads on a box whose operator accepted
#: the model terms and set a token, which is why `diarize` is an OPT-IN capability that narrows to
#: unavailable rather than failing a process.
DEFAULT_PIPELINE = "pyannote/speaker-diarization-3.1"

#: The env var an operator sets to the HF access token the gated pipeline needs. Named alongside the
#: worker's other `ENCORE_*` config; read here rather than in config.py because it is meaningful only
#: to this one seam and only when the model is actually loaded.
HF_TOKEN_ENV = "ENCORE_HF_TOKEN"


class Diarizer(Protocol):
    """Label the speaker turns in a vocals stem. Injectable; returning [] means "could not diarize",
    which the attribution layer reads as the single-colour fallback — never a job failure.

    Output is `[{start: float, end: float, speaker: str}]`. The speaker strings are the diarizer's own
    opaque labels (`SPEAKER_00`, …); `attribution.attribute_parts` maps them to abstract `part`
    letters, so nothing downstream depends on their spelling."""

    def diarize(self, vocals_path: str) -> list[dict[str, Any]]: ...


def _speaker_annotation(output: Any) -> Any:
    """The `Annotation` carrying speaker turns, from EITHER shape a pyannote pipeline returns.

    `pyannote.audio` 4.0 changed what calling a pipeline gives back: older versions returned the
    `Annotation` itself (what `itertracks` lives on); 4.0 wraps it, exposing `speaker_diarization`
    (regular) and `exclusive_speaker_diarization`. Calling `itertracks` on the unwrapped 4.0 object
    raises `AttributeError`, and `steps/diarize.py` catches every exception and degrades to
    single-colour lyrics — so a shape mismatch silently reads as "not a duet" rather than broken.

    `speaker_diarization` is checked FIRST since a pre-4.0 `Annotation` does not have it, and an
    object with both is a compatibility wrapper whose named (non-exclusive) attribute is unambiguous.
    `exclusive_speaker_diarization` is deliberately NOT used — it is a reconciliation aid for
    imprecise transcription timestamps, a behaviour change to weigh deliberately, not smuggle in here.

    A third shape raises a RuntimeError NAMING the type received, so an incompatible pyannote release
    says what it returned instead of presenting as one more silently mono-coloured song.
    """
    inner = getattr(output, "speaker_diarization", None)
    if inner is not None:
        output = inner
    if not hasattr(output, "itertracks"):
        had_wrapper_key = hasattr(output, "speaker_diarization")
        detail = (
            " (it exposes `speaker_diarization`, but that was None)"
            if had_wrapper_key
            else " (no `itertracks`, and no `speaker_diarization` to unwrap)"
        )
        raise RuntimeError(
            f"pyannote returned {type(output).__name__}, a shape this worker does not know how to "
            f"read{detail}. Diarization is degrading to single-colour lyrics; see diarize/diarizer.py"
        )
    return output


class PyannoteDiarizer:
    """Real diarization via a pyannote speaker-diarization pipeline.

    Loaded lazily and at most once per worker (see the cache below). The HF token is read from the
    environment at LOAD time, not construction, so a box that never runs the model never needs one.
    """

    def __init__(self, device: str = "cpu", pipeline: str = DEFAULT_PIPELINE) -> None:
        self._device = device
        self._pipeline_id = pipeline
        self._pipeline: Any = None

    def _load(self) -> Any:
        with ML_LOCK:
            if self._pipeline is None:
                import torch  # lazy: keep the multi-GB import off the dial-home path
                from pyannote.audio import Pipeline

                # `token=`, NOT `use_auth_token=`: pyannote.audio 4.x REMOVED the older name, and
                # requirements.txt pins `pyannote.audio==4.0.0`, so the old spelling raises a
                # TypeError on every align job while the caller silently degrades to one colour.
                pipeline = Pipeline.from_pretrained(
                    self._pipeline_id, token=os.environ.get(HF_TOKEN_ENV) or None
                )
                # A gated model with no/!bad token returns None rather than raising — surface it as the
                # miss it is so the caller degrades to one colour instead of crashing on None.pipeline.
                if pipeline is None:
                    raise RuntimeError(
                        f"pyannote pipeline {self._pipeline_id!r} did not load — set {HF_TOKEN_ENV} to a "
                        "Hugging Face token that has accepted the model's terms"
                    )
                self._pipeline = pipeline.to(torch.device(self._device))
            return self._pipeline

    def diarize(self, vocals_path: str) -> list[dict[str, Any]]:
        pipeline = self._load()
        with ML_LOCK:  # one pipeline, possibly two concurrent align jobs — see ML_LOCK
            annotation = _speaker_annotation(pipeline(vocals_path))
        out: list[dict[str, Any]] = []
        # `itertracks(yield_label=True)` yields (segment, track_id, speaker_label).
        for segment, _track, speaker in annotation.itertracks(yield_label=True):
            out.append({"start": float(segment.start), "end": float(segment.end), "speaker": str(speaker)})
        return out


# Keyed by (device, pipeline) at MODULE level, like the transcriber cache in lyrics/asr.py: two
# concurrent align jobs on the same pipeline SHARE the loaded weights, and no job can evict another's.
# Loading is under ML_LOCK so a lazy check-then-set cannot load the same multi-GB pipeline twice.
_DIARIZERS: dict[tuple[str, str], PyannoteDiarizer] = {}


def diarizer_for(device: str, pipeline: str = DEFAULT_PIPELINE) -> PyannoteDiarizer:
    """The diarizer for this (device, pipeline), loading its weights at most once per worker."""
    key = (device, pipeline)
    with ML_LOCK:
        got = _DIARIZERS.get(key)
        if got is None:
            got = _DIARIZERS[key] = PyannoteDiarizer(device=device, pipeline=pipeline)
        return got
