"""The diarization domain: label who sings each stretch of the vocals stem, and turn that into an
abstract `part` on each lyric line. See `diarizer.py` (the ML seam) and `attribution.py` (the
pure mapping)."""

from __future__ import annotations

from .attribution import attribute_parts
from .diarizer import DEFAULT_PIPELINE, HF_TOKEN_ENV, Diarizer, PyannoteDiarizer, diarizer_for

__all__ = [
    "attribute_parts",
    "Diarizer",
    "PyannoteDiarizer",
    "diarizer_for",
    "DEFAULT_PIPELINE",
    "HF_TOKEN_ENV",
]
