"""Lyrics SOURCES: the four places a song's text can come from.

Extracted from lyrics/chain.py. chain.py was the union of five concerns; this is the
``sources/*`` seam of the declared split (see lyrics/__init__.py). Each source is a small,
independently testable adapter that yields a ``LyricsText`` plus its provenance; the roles, the
request/text model and the grading all stay in chain.py for now.

The classes are re-exported from chain.py so every existing importer -- lyrics/registry.py, the
package surface in lyrics/__init__.py, and tests importing ``from src.lyrics.chain import AsrSource``
-- is unchanged; this move is behaviour-preserving. The model types these depend on
(``LyricsRequest``, ``LyricsText``) and the source/timing vocabulary still live in chain.py and are
imported from there. chain.py in turn imports these classes back at its foot, AFTER those definitions
exist, so there is no import cycle regardless of which module is imported first.
"""

from __future__ import annotations

from typing import Any, Protocol

from ..vocabulary import TextSource, Timing
from .model import LyricsRequest, LyricsText
from .source import MAX_VARIANTS, LyricsFetchError, rank_lrclib_candidates

# Derived from ..vocabulary directly — the same origin chain.py uses — rather than from chain.py, so
# the SOURCE_*/TIMING_* constants do not travel back through the chain<->sources import (which mypy
# cannot type through the cycle: `Cannot determine type of "SOURCE_LRCLIB"`). Only LyricsRequest /
# LyricsText, defined in chain.py before its foot-import of this module runs, come from chain.
SOURCE_LRCLIB = TextSource.LRCLIB.value
SOURCE_CAPTIONS = TextSource.CAPTIONS.value
SOURCE_ASR = TextSource.ASR.value

TIMING_WORD = Timing.WORD.value
TIMING_LINE = Timing.LINE.value
TIMING_NONE = Timing.NONE.value


class LyricsSource(Protocol):
    """One place text can come from. MUST NOT raise for an ordinary miss — return None."""

    @property
    def name(self) -> str: ...

    def fetch(self, req: LyricsRequest) -> LyricsText | None: ...


class LrclibSource:
    """Authoritative human-authored lyrics, line-timed when LRCLIB has an LRC for the track.

    Declines (None) rather than raising on: no confident metadata, a 404, an instrumental, or a
    network failure. A dead LRCLIB must degrade the RESULT, not fail the job — that conflation is the
    bug this whole commit exists to fix.

    SEARCHES rather than gets, because a popular song has SEVERAL records and /api/get returns one of
    them by fiat. Asking for a single record is how "Telephone (feat. Beyoncé)" ends up singing the
    lyrics of "Telephone": both records match artist+track, /api/get picks whichever satisfies its ±2s
    duration filter first, and nothing downstream ever learns there was a choice. This tier therefore
    returns the metadata-best record with the rest attached as `alternates`, and defers the real
    decision to `select_by_baselines`, which has the ASR transcript to settle it with.

    Falls back to `get()` when the search finds nothing: a record reachable by exact match but absent
    from search results is unlikely but costs one request to rule out, and a regression from
    "lyrics" to "no lyrics" is not an acceptable price for adding version selection.
    """

    name = SOURCE_LRCLIB

    def __init__(self, client: Any, to_segments: Any, max_variants: int = MAX_VARIANTS) -> None:
        self._client = client
        self._to_segments = to_segments  # whisperx.lrclib_to_segments, injected to avoid a cycle
        self._max_variants = max_variants

    def _to_text(self, res: Any, req: LyricsRequest) -> LyricsText | None:
        segments = self._to_segments(res, req.duration)
        if not segments:
            return None  # instrumental, or no usable lyrics body
        return LyricsText(
            text_source=SOURCE_LRCLIB,
            segments=segments,
            # An LRC gives real line timings; plainLyrics segments carry only synthetic even spacing,
            # which is NOT sync and must not be presented as the line-level floor.
            timing=TIMING_LINE if bool(getattr(res, "has_synced", False)) else TIMING_NONE,
            text_confidence="high",
            language=None,
            variant=getattr(res, "label", None),
        )

    def fetch(self, req: LyricsRequest) -> LyricsText | None:
        if not req.artist or not req.track:
            return None  # no confident metadata → an authoritative lookup is not possible

        # The credit we can compare a record's artist string against. `artist_credit` carries the full
        # billing ("Lady Gaga feat. Beyoncé") when the upload named one; `artist` alone is the primary.
        credit = req.artist_credit or req.artist

        pool: list[Any] = []
        try:
            found = self._client.search(req.artist, req.track)
        except LyricsFetchError:
            # The provider was reachable-and-refusing or unreachable (incl. the DNS sinkhole). That is
            # NOT this song's miss — it is the whole tier being down — so let it out to be noted rather
            # than swallowing it as an empty result indistinguishable from "no record for this song".
            raise
        except Exception:  # noqa: BLE001 — a genuinely unexpected source bug: contain it as a miss
            found = []
        if found:
            pool = rank_lrclib_candidates(found, req.duration, credit, self._max_variants)

        if not pool:
            try:
                one = self._client.get(req.artist, req.track, duration=req.duration)
            except LyricsFetchError:
                raise  # provider down, not this song's miss — surface it (see search branch above)
            except Exception:  # noqa: BLE001 — a genuinely unexpected source bug: contain it as a miss
                return None
            if one is None:
                return None
            pool = [one]

        texts = [t for t in (self._to_text(r, req) for r in pool) if t is not None]
        if not texts:
            return None
        best, rest = texts[0], texts[1:]
        best.alternates = rest
        return best


class _CaptionsSource:
    """Shared body for the two caption tiers, parameterized by the four literals that differ.

    Both read a list of cue dicts off the request, decline (None) when it is absent, and otherwise build a
    LINE-timed LyricsText tagged SOURCE_CAPTIONS. They diverged only in WHICH request field they read and
    in three literals (text_confidence / tag / variant) — the same shape `AsrSource(audio=...)` already
    uses. Held as class attributes so the two public subclasses below stay ZERO-ARG (registry SPECS and
    the tests build them with no arguments) while the one `fetch` cannot drift between them.
    """

    name = SOURCE_CAPTIONS

    #: The LyricsRequest attribute this tier's cues arrive on.
    _segments_attr: str
    #: text_confidence stamped on the produced LyricsText.
    _confidence: str
    #: A short stable id within the source (part of the artifact key).
    _tag: str
    #: Human label for logs.
    _variant: str

    def fetch(self, req: LyricsRequest) -> LyricsText | None:
        segments = getattr(req, self._segments_attr)
        if not segments:
            return None  # no track of this kind on this upload — the common case, and not an error
        return LyricsText(
            text_source=SOURCE_CAPTIONS,
            segments=list(segments),
            timing=TIMING_LINE,
            text_confidence=self._confidence,
            language=None,
            tag=self._tag,
            variant=self._variant,
        )


class CaptionsSource(_CaptionsSource):
    """Lyrics from the upload's own HUMAN-AUTHORED caption track — a CANDIDATE.

    Uniquely version-proof among candidates. Every other authored tier is indexed by artist+track and can
    only return a record for *some* recording of the song; these are attached to the exact upload being
    sung over, so they cannot be about a different version. That makes this the candidate least able to
    be wrong about which recording it is — and it still gets graded, because "attached to this upload"
    does not mean "correct" (a captioner mistypes, or captions a different language).

    Distinct from AutoCaptionsSource, which is a BASELINE. The two arrive from separate yt-dlp fetches
    into separate directories precisely so that this distinction cannot blur: the guarantee that no
    machine-generated track reaches this tier is structural, not a filter. See lyrics/captions.py.

    Timing is LINE and stays line: a caption cue bounds a whole line, and any word timing comes from the
    same forced aligner every other tier goes through.

    PURE — the yt-dlp call happens in the align processor's async stage, through the same injected runner
    the audio download uses, and the parsed cues arrive on the request. This tier owns no subprocess of
    its own: an earlier draft did, and it made every existing processor test shell out to the network,
    because the harness's injected fake runner had no way to reach a second private path to yt-dlp.
    """

    _segments_attr = "caption_segments"
    _confidence = "high"
    _tag = "manual"
    _variant = "uploader captions"


class AsrSource:
    """Transcribe what is ACTUALLY SUNG — a BASELINE, not an answer.

    Two instances of this run per align job, one on the isolated vocals stem and one on the raw mix, and
    that is deliberate rather than wasteful. The stem gives better words when separation worked; the mix
    is the only baseline that still speaks when it did not, and on this library separation demonstrably
    fails (2 of 9 vocals stems were digital silence and shipped as `ready`). Their errors are also
    largely independent, which is the property that makes averaging them a steadier ruler than either
    alone. `audio` selects which one this instance reads.

    Text confidence is always `low` — this is a guess at sung words, and `isAuthoritativeText` in
    shared/lyrics.ts uses exactly that to keep it below any real lookup and to make the TV label it. That
    is not in tension with its role: a baseline is untrustworthy about WORDS and trustworthy about WHICH
    RECORDING, which is the opposite of a candidate and precisely why it grades one.

    MEASURED, not assumed (2026-09-02, real stem, `base` on CPU): whisper's `transcribe()` returns
    segment bounds and NO word timings, so this tier reports `line`. Word timings come from the SAME
    forced aligner an LRCLIB lookup goes through — the aligner is not text-source-specific, it upgrades
    any text from line to word.
    """

    name = SOURCE_ASR

    #: Which audio this instance transcribes. 'vocals' needs a processed stems job; 'mix' never does.
    AUDIO_VOCALS = "vocals"
    AUDIO_MIX = "mix"

    def __init__(self, transcriber: Any, normalize: Any, audio: str = AUDIO_VOCALS) -> None:
        self._transcriber = transcriber
        self._normalize = normalize  # whisperx.normalize_lyrics, injected to avoid an import cycle
        self._audio = audio

    def _audio_path(self, req: LyricsRequest) -> str | None:
        if self._audio == self.AUDIO_MIX:
            return req.audio_path or None
        return req.vocals_path

    def fetch(self, req: LyricsRequest) -> LyricsText | None:
        path = self._audio_path(req)
        if not path:
            # No stem yet (a later align run picks it up), or no retained original. Declining is right:
            # silently transcribing the OTHER audio would make two baselines into one opinion counted
            # twice, which is worse than one honest vote.
            return None
        try:
            raw = self._transcriber.transcribe(path, None)
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
                {
                    "start": ln.get("start"),
                    "end": ln.get("end"),
                    "text": ln.get("text"),
                    "words": ln.get("words") or [],
                }
                for ln in lines
            ],
            timing=TIMING_WORD if any(ln.get("words") for ln in lines) else TIMING_LINE,
            text_confidence="low",
            language=doc.get("language"),
            tag=self._audio,
            variant=f"whisper/{self._audio}",
        )


class AutoCaptionsSource(_CaptionsSource):
    """YouTube's OWN automatic captions — a BASELINE, never a candidate.

    This is the reversal that the two-tier split earns. Treated as authored text these are actively
    dangerous: they are ASR wearing a caption's clothes, made from the MIXED audio, and accepted as
    "captions" they would be ranked as authoritative and could outrank a correct database lookup. As a
    BASELINE the same text is simply a third opinion on what is audible — which is all it ever was — and
    it is structurally barred from being chosen as the song's words while any candidate exists.

    Weak but real, measured across five uploads: YouTube's ASR suppresses sung vocals into [Music]
    marker cues, so it was absent or near-useless on three of the five (a-ha "Take On Me": 8 words plus
    15 music markers). A baseline that thin cannot reach MIN_TOKENS_TO_COMPARE and therefore ABSTAINS
    rather than dragging the mean down — see `composite_score`. That abstention is what makes including
    a weak baseline safe.

    `low` text_confidence is load-bearing, not decorative: it is what makes isAuthoritativeText() false,
    so even when this is the only text left to show, the TV labels it as auto-transcribed.
    """

    _segments_attr = "auto_caption_segments"
    _confidence = "low"
    _tag = "auto"
    _variant = "youtube auto-captions"


def _source_name(s: LyricsSource) -> str:
    """Best label for a source in an operator note — its declared `name`, else the class name."""
    return str(getattr(s, "name", None) or type(s).__name__)
