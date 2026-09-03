"""Lyrics ACQUISITION, separated from TIMING.

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

import re
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
    #: Confidence-gated canonicals from the core. None when the parse was not confident —
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


class AsrSource:
    """Transcribe what is ACTUALLY SUNG. The floor tier: needs nothing external and always applies.

    Reads the isolated VOCALS STEM, never the mix — drums and guitar over a voice transcribe badly,
    and the stem is already retained (~6 MB/song) for pitch extraction. That makes this tier depend on
    a completed stems job, which is exactly why an align job is CHAINED after stems rather than
    enqueued alongside it (see followUps in the core's dispatch.ts). If the stem is missing this tier
    declines rather than falling back to the mix: quietly producing worse words would be
    indistinguishable from producing good ones, and the whole point of provenance is that the
    difference is visible.

    Text confidence is always `low` — this is a guess at sung words, and `isAuthoritativeText` in
    shared/lyrics.ts uses exactly that to keep it below any real lookup and to make the TV label it.

    MEASURED, not assumed (2026-09-02, real stem, `base` on CPU): whisper's `transcribe()` returns
    segment bounds and NO word timings, so this tier reports `line`. Word timings come from the SAME
    forced aligner an LRCLIB lookup goes through — the aligner is not text-source-specific, it upgrades
    any text from line to word. An earlier draft of this design claimed ASR yielded word timings for
    free; it does not, and the tier is still worth having for the text and the agreement signal.
    """

    name = SOURCE_ASR

    def __init__(self, transcriber: Any, normalize: Any) -> None:
        self._transcriber = transcriber
        self._normalize = normalize  # whisperx.normalize_lyrics, injected to avoid an import cycle

    def fetch(self, req: LyricsRequest) -> LyricsText | None:
        if not req.vocals_path:
            return None  # stems not cooked yet — a later align run picks this up
        try:
            raw = self._transcriber.transcribe(req.vocals_path, None)
        except Exception:  # noqa: BLE001 — no model / no network for the weights: a miss, not a failure
            return None
        doc = self._normalize(raw)
        lines = doc.get("lines") or []
        if not lines:
            return None
        # normalize_lyrics already produced the artifact shape; hand back its lines as segments so the
        # timing layer sees word timings that are ALREADY there and keeps them.
        return LyricsText(
            text_source=SOURCE_ASR,
            segments=[
                {"start": l.get("start"), "end": l.get("end"), "text": l.get("text"), "words": l.get("words") or []}
                for l in lines
            ],
            timing=TIMING_WORD if any(l.get("words") for l in lines) else TIMING_LINE,
            text_confidence="low",
            language=doc.get("language"),
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


def candidate_key(media_id: str, text_source: str, timing: str = TIMING_WORD) -> str:
    """Artifact key per (text source, TIMING TIER), so candidates coexist instead of overwriting.

    The single `derived/lyrics/<id>.json` key could hold exactly one answer, which is what forced the
    old "pick one winner" design. One file per source is what makes the upgrade path possible: ASR
    lands first, LRCLIB is re-tried later, neither clobbers the other.

    The TIMING tier is in the key too, because source alone still allowed a regression WITHIN a source:
    a re-run whose aligner failed would write line-level output over the same key and replace perfectly
    good word timings — the never-regress guarantee held across sources but not within one. Separate
    keys mean the word-level artifact survives on disk and in the candidate set, and `pickBestLyrics`
    keeps choosing it.
    """
    return f"derived/lyrics/{media_id}-{text_source}-{timing}.json"


# ── ASR agreement: catching a confidently WRONG lookup ────────────────────────────
#
# Mirrors agreementScore / SUSPECT_AGREEMENT / MIN_TOKENS_TO_COMPARE in packages/shared/src/lyrics.ts.
# Computed HERE, in the worker, because this is the only place both texts exist in memory at once — the
# core holds refs, and reading two artifacts back off disk inside the realtime hub to compare them would
# be I/O on the wrong side of the seam.
#
# This is what makes "ASR on every cook" pay for itself beyond being a fallback: LRCLIB's dangerous
# failure is not a miss but a confident MISMATCH (fuzzy metadata returns another song's words), and
# comparing the lookup against a transcript of what is actually being sung is the only signal we have.

MIN_TOKENS_TO_COMPARE = 12
SUSPECT_AGREEMENT = 0.25

_TOKEN_STRIP = re.compile(r"\[[^\]]*\]")
_TOKEN_KEEP = re.compile(r"[^\w\s']", re.UNICODE)


def lyrics_tokens(text: str) -> list[str]:
    """Words, lowercased, punctuation and [bracket] markers stripped. Compares CONTENT, not form."""
    cleaned = _TOKEN_KEEP.sub(" ", _TOKEN_STRIP.sub(" ", text.lower()))
    return [t for t in cleaned.split() if t]


def agreement_score(a: str, b: str) -> float | None:
    """0..1 Jaccard over token SETS, or None when not comparable.

    Order-insensitive on purpose: a repeated chorus or a reordered bridge is not disagreement, whereas a
    different song shares few words in any order. Returns None — not 0 — when either side is too short:
    an instrumental transcribes to almost nothing, and scoring that as total disagreement would condemn
    a perfectly correct lookup. "Cannot tell" and "these differ" must not be the same answer.
    """
    set_a, set_b = set(lyrics_tokens(a)), set(lyrics_tokens(b))
    if len(set_a) < MIN_TOKENS_TO_COMPARE or len(set_b) < MIN_TOKENS_TO_COMPARE:
        return None
    shared = len(set_a & set_b)
    union = len(set_a | set_b)
    return None if union == 0 else shared / union


def score_against_asr(texts: list[LyricsText]) -> dict[str, float]:
    """Agreement of each AUTHORITATIVE text against the ASR transcript, keyed by text source.

    Empty when there is no ASR text to compare against, or nothing comparable — an unknown must never
    be reported as a detected mismatch.
    """
    asr = next((t for t in texts if t.text_source == SOURCE_ASR), None)
    if asr is None:
        return {}
    out: dict[str, float] = {}
    for t in texts:
        if t.text_source == SOURCE_ASR:
            continue
        score = agreement_score(t.plain_text, asr.plain_text)
        if score is not None:
            out[t.text_source] = score
    return out
