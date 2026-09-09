"""Diarization: labelling WHICH voice sings each stretch of the vocals stem (#691).

The `Diarizer` seam and the real pyannote-backed implementation behind it. This is the SOURCE of duet
part attribution the owner ruled for on #632 ("A — diarize in the worker", 2026-09-07 17:08Z); the
pure mapping from its output to a `part` label on each lyric line lives next door in `attribution.py`,
and the two are separate for the same reason ASR and alignment are: one INVENTS speaker turns from
audio, the other is pure arithmetic over the result and must be testable with no model.

Runs on the ISOLATED VOCALS STEM (`ctx.audio.vocals_path`), the same input the aligner and ASR prefer
— a full mix diarizes even worse, and the stem is already separated and retained. Diarization on
*overlapping sung* vocals is materially harder than on speech (the cost #632 named), which is why the
attribution layer is conservative and the whole feature falls back to one colour when unsure.

torch/pyannote are imported LAZILY inside the loader, exactly like `lyrics/asr.py`: a worker that
never runs an align job — or a box without the model — never pays the multi-GB import, and the
capability probe uses `find_spec` so building the advertised set stays import-free.
"""

from __future__ import annotations

import os
from typing import Any, Protocol

from ..lyrics.timing import ML_LOCK

#: The pyannote pipeline id. Gated on Hugging Face, so it only loads on a box whose operator accepted
#: the model terms and set a token — probed for below, and absent by default (this box has nowhere for
#: a secret, per the #632 duet research), which is why `diarize` is an OPT-IN capability that narrows
#: to unavailable rather than failing a cook.
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

                pipeline = Pipeline.from_pretrained(
                    self._pipeline_id, use_auth_token=os.environ.get(HF_TOKEN_ENV) or None
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
            annotation = pipeline(vocals_path)
        out: list[dict[str, Any]] = []
        # `itertracks(yield_label=True)` yields (segment, track_id, speaker_label).
        for segment, _track, speaker in annotation.itertracks(yield_label=True):
            out.append({"start": float(segment.start), "end": float(segment.end), "speaker": str(speaker)})
        return out


# ── the pipeline cache ───────────────────────────────────────────────────────────────
#
# Keyed by (device, pipeline) at MODULE level, exactly like the transcriber cache in lyrics/asr.py and
# for the same reasons: two concurrent align jobs on the same pipeline SHARE the loaded weights, two on
# different pipelines each keep theirs, and no job can evict another's. Loading is under ML_LOCK because
# a lazy check-then-set would otherwise load the same multi-GB pipeline twice.
_DIARIZERS: dict[tuple[str, str], PyannoteDiarizer] = {}


def diarizer_for(device: str, pipeline: str = DEFAULT_PIPELINE) -> PyannoteDiarizer:
    """The diarizer for this (device, pipeline), loading its weights at most once per worker."""
    key = (device, pipeline)
    with ML_LOCK:
        got = _DIARIZERS.get(key)
        if got is None:
            got = _DIARIZERS[key] = PyannoteDiarizer(device=device, pipeline=pipeline)
        return got
