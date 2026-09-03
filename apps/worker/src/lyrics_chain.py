"""Lyrics ACQUISITION, separated from TIMING (B-3-C3).

whisperx.py used to conflate the two: stage 2 was hardwired to `LrclibClient.get()` and raised when
it returned nothing, so "LRCLIB unreachable" meant "no lyrics" instead of "no AUTHORITATIVE lyrics".
Since WhisperX supplies the timing, all a source has to deliver is accurate TEXT — which makes plain
text first-class and pre-timed `.lrc` a bonus rather than a requirement.

This module owns "where does text come from". A `LyricsSource` yields text plus its provenance; the
timing layer in whisperx.py then force-aligns whatever arrived. Sources are collected into a list and
run INDEPENDENTLY — not first-hit — because text quality and timing fidelity are independent axes and
ASR runs on every cook regardless (it is also the only signal that catches a confidently WRONG
LRCLIB match; see agreementScore in packages/shared/src/lyrics.ts).

New module rather than an addition to lyrics_source.py: the LRCLIB adapter needs
`whisperx.lrclib_to_segments`, and whisperx.py already imports lyrics_source — putting the adapter
there would close an import cycle.

PURE of network/ML by construction: every source is injectable, so the whole chain tests with fakes.
Candidate metadata mirrors `LyricsCandidate` in packages/shared/src/lyrics.ts — that TS module is the
authority on RANKING; this side only reports what it produced and how trustworthy it is.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

# Text-source ids — must match LyricsTextSource in packages/shared/src/lyrics.ts.
SOURCE_LRCLIB = "lrclib"
SOURCE_CAPTIONS = "captions"
SOURCE_ASR = "asr"
SOURCE_MANUAL = "manual"

# Timing fidelity a source supplies UNAIDED — must match LyricsTiming in the same TS module.
TIMING_WORD = "word"
TIMING_LINE = "line"
TIMING_NONE = "none"


@dataclass
class LyricsRequest:
    """Everything a source might need to find text for one song."""

    media_id: str
    #: Confidence-gated canonicals from the core (B-3-C1). None when the parse was not confident —
    #: a source that needs them must decline rather than look up a guess.
    artist: str | None = None
    track: str | None = None
    duration: float | None = None
    #: The raw mixed audio (retained original). Fine for forced alignment.
    audio_path: str = ""
    #: The isolated vocals stem, when a stems job has already produced it. ASR wants THIS — a full mix
    #: transcribes badly — so it may be absent for a song whose stems have not been cooked.
    vocals_path: str | None = None


@dataclass
class LyricsText:
    """Text from one source, with the provenance the TV needs to be honest about it."""

    text_source: str
    #: [{start?, end?, text}] lines. `start`/`end` present only when the source itself is timed.
    segments: list[dict[str, Any]] = field(default_factory=list)
    #: What this source supplies on its own, BEFORE the timing layer runs.
    timing: str = TIMING_NONE
    text_confidence: str = "medium"
    language: str | None = None

    @property
    def plain_text(self) -> str:
        """Flattened text, for ASR-vs-authoritative agreement scoring."""
        return "\n".join(str(s.get("text") or "") for s in self.segments).strip()

    def is_usable(self) -> bool:
        return any(str(s.get("text") or "").strip() for s in self.segments)


class LyricsSource(Protocol):
    """One place text can come from. MUST NOT raise for an ordinary miss — return None."""

    name: str

    def fetch(self, req: LyricsRequest) -> LyricsText | None: ...


class LrclibSource:
    """Authoritative human-authored lyrics, line-timed when LRCLIB has an LRC for the track.

    Declines (None) rather than raising on: no confident metadata, a 404, an instrumental, or a
    network failure. A dead LRCLIB must degrade the RESULT, not fail the job — that conflation is the
    bug this whole commit exists to fix.
    """

    name = SOURCE_LRCLIB

    def __init__(self, client: Any, to_segments: Any) -> None:
        self._client = client
        self._to_segments = to_segments  # whisperx.lrclib_to_segments, injected to avoid a cycle

    def fetch(self, req: LyricsRequest) -> LyricsText | None:
        if not req.artist or not req.track:
            return None  # no confident metadata → an authoritative lookup is not possible
        try:
            res = self._client.get(req.artist, req.track, duration=req.duration)
        except Exception:  # noqa: BLE001 — unreachable/5xx/TLS: a miss, not a job failure
            return None
        if res is None:
            return None
        segments = self._to_segments(res, req.duration)
        if not segments:
            return None  # instrumental, or no usable lyrics body
        synced = bool(getattr(res, "has_synced", False))
        return LyricsText(
            text_source=SOURCE_LRCLIB,
            segments=segments,
            # An LRC gives real line timings; plainLyrics segments carry only synthetic even spacing,
            # which is NOT sync and must not be presented as the line-level floor.
            timing=TIMING_LINE if synced else TIMING_NONE,
            text_confidence="high",
            language=None,
        )


def acquire(sources: list[LyricsSource], req: LyricsRequest) -> list[LyricsText]:
    """Run EVERY source and return everything that yielded usable text.

    Not first-hit: the ideal artifact is authoritative text force-aligned to the audio, so an
    authoritative source and ASR are complements, not alternatives. A source that raises is skipped —
    one broken tier must never cost the others.
    """
    out: list[LyricsText] = []
    for s in sources:
        try:
            got = s.fetch(req)
        except Exception:  # noqa: BLE001 — a misbehaving source is a miss, never a job failure
            continue
        if got is not None and got.is_usable():
            out.append(got)
    return out


def candidate_key(media_id: str, text_source: str) -> str:
    """Per-source artifact key, so candidates coexist instead of overwriting one another.

    The single `derived/lyrics/<id>.json` key could hold exactly one answer, which is what forced the
    old "pick one winner" design. One file per text source is what makes the upgrade path possible:
    ASR lands first, LRCLIB is re-tried later, and neither clobbers the other.
    """
    return f"derived/lyrics/{media_id}-{text_source}.json"
