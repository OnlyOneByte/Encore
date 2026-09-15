"""Lyrics: where a song's words come from, and how much they can be trusted.

This package owns the whole two-tier model and nothing else owns any of it:

  * `source` — LRCLIB: the client, the version-ranking, the LRC parser.
  * `captions` — YouTube caption tracks, authored and machine-made, kept apart by construction.
  * `chain` — the roles (baseline vs candidate), the sources, the grading, the selection.
  * `presplit` — re-lineating an auto-transcribed blob into singable lines.
  * `validate` — refusing word timings that would visibly misbehave on the TV.

WHY A PACKAGE. These five were flat modules beside separation, acquisition and the transport, so
nothing prevented a caller reaching past them or a lyrics concern leaking outward. They are a domain:
the words a song has, judged against evidence of what is audible. Everything here is PURE of the
network and of ML by construction — every I/O boundary is injected — which is what lets the whole
domain be unit-tested with no subprocess, no model weights and no event loop.

The names re-exported below are the intended surface. Reaching into a submodule is fine for something
this package genuinely owns and a test genuinely needs to poke at; reaching in for one of these names
means the surface is being bypassed.

See `docs/ARCHITECTURE.md` §7.1 and §8 for where this goes next: `chain` is the union of five
concerns and splits into `model` / `grade` / `sources/*` in a later stage. This stage only moved files.
"""

from __future__ import annotations

from .artifact import candidate_key, is_valid_lyrics, lrclib_to_segments, normalize_lyrics
from .asr import DEFAULT_MODEL, Transcriber, WhisperxTranscriber, transcriber_for
from .captions import caption_argv, is_translated_track, parse_vtt, read_captions
from .chain import (
    MIN_TOKENS_TO_COMPARE,
    OVERSHOOT_FRACTION_MAX,
    ROLE_BASELINE,
    ROLE_CANDIDATE,
    ROLE_UNSPECIFIED,
    SOURCE_ASR,
    SOURCE_CAPTIONS,
    SOURCE_LRCLIB,
    SOURCE_MANUAL,
    SUSPECT_COVERAGE,
    TIMING_LINE,
    TIMING_NONE,
    TIMING_WORD,
    Agreement,
    AsrSource,
    AutoCaptionsSource,
    CaptionsSource,
    Composite,
    LrclibSource,
    LyricsRequest,
    LyricsSource,
    LyricsText,
    Selection,
    VariantChoice,
    acquire,
    acquire_with_notes,
    agreement,
    agreement_score,
    baselines_of,
    candidate_last_end,
    candidates_of,
    composite_score,
    is_authoritative_text,
    lyrics_tokens,
    select_by_baselines,
)
from .presplit import klp_probe_line, klp_status, presplit_texts
from .registry import SPECS, SourceSpec, build_sources, unmet
from .source import (
    LRCLIB_BASE,
    LrclibClient,
    LrclibResult,
    LyricsFetchError,
    entries_to_segments,
    is_line_synced,
    line_synced_lyrics,
    parse_lrc,
    plain_lyrics_to_segments,
    rank_lrclib_candidates,
)
from .timing import ML_LOCK, Aligner, WhisperxForcedAligner, aligner_for
from .validate import (
    LrcFit,
    fit_lrc_to_aligned,
    lrc_fit_notes,
    repair_word_spans,
    validate_timing,
)

__all__ = [
    "LrcFit",
    "fit_lrc_to_aligned",
    "lrc_fit_notes",
    # roles + vocabulary
    "ROLE_BASELINE",
    "ROLE_CANDIDATE",
    "ROLE_UNSPECIFIED",
    "SOURCE_ASR",
    "SOURCE_CAPTIONS",
    "SOURCE_LRCLIB",
    "SOURCE_MANUAL",
    "TIMING_LINE",
    "TIMING_NONE",
    "TIMING_WORD",
    # model
    "LyricsRequest",
    "LyricsSource",
    "LyricsText",
    "Selection",
    "VariantChoice",
    "is_authoritative_text",
    # sources
    "AsrSource",
    "AutoCaptionsSource",
    "CaptionsSource",
    "LrclibSource",
    "LRCLIB_BASE",
    "LrclibClient",
    "LrclibResult",
    "LyricsFetchError",
    "acquire",
    "acquire_with_notes",
    "build_sources",
    "rank_lrclib_candidates",
    "SPECS",
    "SourceSpec",
    "unmet",
    # grading + selection
    "MIN_TOKENS_TO_COMPARE",
    "OVERSHOOT_FRACTION_MAX",
    "SUSPECT_COVERAGE",
    "Agreement",
    "Composite",
    "agreement",
    "agreement_score",
    "baselines_of",
    "candidate_last_end",
    "candidates_of",
    "composite_score",
    "lyrics_tokens",
    "select_by_baselines",
    # artifacts + shaping
    "candidate_key",
    "entries_to_segments",
    "is_line_synced",
    "is_valid_lyrics",
    "line_synced_lyrics",
    "lrclib_to_segments",
    "normalize_lyrics",
    "parse_lrc",
    "plain_lyrics_to_segments",
    "presplit_texts",
    "klp_probe_line",
    "klp_status",
    "repair_word_spans",
    "validate_timing",
    # transcription + timing (the two ML seams)
    "DEFAULT_MODEL",
    "ML_LOCK",
    "Aligner",
    "Transcriber",
    "WhisperxForcedAligner",
    "WhisperxTranscriber",
    "aligner_for",
    "transcriber_for",
    # captions
    "caption_argv",
    "is_translated_track",
    "parse_vtt",
    "read_captions",
]
