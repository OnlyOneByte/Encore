"""The lyrics artifact's SHAPE, stated once.

A word-timed lyrics artifact is a plain dict — `{"language", "lines": [...], "words": [...]}` —
because that is what gets written to `derived/lyrics/*.json` and what the core reads. `LyricsDoc` is
a read-only VIEW over that same dict, so readers ask it questions instead of each re-deriving the shape.

TWO DELIBERATELY DIFFERENT READS: `lines` (the artifact's own key) and `lines_or_segments` (tolerates
the older `segments` key too). Unifying them is a BEHAVIOUR CHANGE, not a cleanup — measured on a
256-doc corpus, the tolerant read flips 107 outcomes for `has_timed_words` and 25 for `is_line_synced`,
because a raw `segments` doc starts reading as a publishable artifact. `segments` tolerance stays
because artifacts also arrive from DISK: the boot-time lyrics backfill (`ENCORE_LYRICS_BACKFILL`)
reads whatever `derived/lyrics/` already holds, including files an older build wrote.

NOT A VALIDATOR: every reader here is a PREDICATE that returns False for junk rather than raising.
`validate.py` owns judgements about timing QUALITY; this module owns only the shape.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from ..vocabulary import ROLE_UNSPECIFIED, TextSource, Timing


def _is_num(value: Any) -> bool:
    """A real number, and not a bool: `isinstance(True, int)` is True in Python, so a `start` of
    `True` would otherwise read as time 1.0."""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


@dataclass(frozen=True)
class LyricsDoc:
    """A read-only view over a lyrics artifact dict.

    Frozen, and does not copy: `raw` is the caller's own dict, so wrapping one costs nothing and a
    caller that still needs the dict keeps using it directly. Wrap for the questions, not the data.
    """

    raw: Mapping[str, Any]

    @property
    def language(self) -> str | None:
        lang = self.raw.get("language")
        return lang if isinstance(lang, str) and lang else None

    @property
    def lines(self) -> list[dict[str, Any]]:
        """The line records under the artifact's OWN key, `lines`, with non-dict entries dropped.

        Strict on purpose: `normalize_lyrics` always writes `lines`, so a doc without that key is raw
        aligner output that has not been normalized yet, and the predicates below say False for it.
        """
        return self._records("lines")

    @property
    def lines_or_segments(self) -> list[dict[str, Any]]:
        """The same records, falling back to the older `segments` key.

        See the module docstring: this tolerant read is measured to change 107/25 outcomes over a
        256-doc corpus versus the strict `lines` read, so it is kept only here, at the timing-reader
        boundary where a doc may still be either.
        """
        if self.raw.get("lines"):
            return self._records("lines")
        return self._records("segments")

    def _records(self, key: str) -> list[dict[str, Any]]:
        raw = self.raw.get(key)
        if not isinstance(raw, list):
            return []
        return [rec for rec in raw if isinstance(rec, dict)]

    def timed_words(self) -> list[dict[str, Any]]:
        """Every word carrying BOTH a numeric start and end, in document order.

        Words missing either bound are skipped rather than defaulted: inventing a duration would hide
        exactly the defects the downstream timing report measures.
        """
        out: list[dict[str, Any]] = []
        for line in self.lines_or_segments:
            words = line.get("words") or []
            if not isinstance(words, list):
                continue
            for word in words:
                if isinstance(word, dict) and _is_num(word.get("start")) and _is_num(word.get("end")):
                    out.append(word)
        return out

    def has_timed_words(self) -> bool:
        """The forced-alignment success bar: at least one line carrying at least one word.

        Deliberately the WEAKER test — asks whether `words` is non-empty, not whether those words
        have timestamps. Tightening it would change which artifacts get published; `validate_timing`
        is what judges whether the timings are any good.
        """
        return any(line.get("words") for line in self.lines)

    def is_line_synced(self) -> bool:
        """A usable line-synced artifact: some line with a numeric start and non-empty text.

        Word timings NOT required — that is the whole distinction from `has_timed_words`. This is what
        lets a source with only LRC line timings still publish something the TV can highlight per line.
        """
        return any(_is_num(line.get("start")) and bool(line.get("text")) for line in self.lines)


# LyricsRequest/LyricsText live here, not in grading.py, so both grading.py and sources.py can import
# them without an import cycle (sources.py needs them to declare what a source consumes/returns;
# grading.py needs the source classes to run them). grading.py re-exports every name below.

# Text-source ids and timing tiers: enums in src/vocabulary.py (TextSource, Timing) so the TS<->Python
# guard in src/lib/server/jobs/vocabulary-parity.test.ts can enforce them — a comment cannot fail a
# build. Re-exported under the original names, and `.value` keeps them plain strings for JSON/argv/keys.
SOURCE_LRCLIB = TextSource.LRCLIB.value
SOURCE_CAPTIONS = TextSource.CAPTIONS.value
SOURCE_ASR = TextSource.ASR.value
SOURCE_MANUAL = TextSource.MANUAL.value

TIMING_WORD = Timing.WORD.value
TIMING_LINE = Timing.LINE.value
TIMING_NONE = Timing.NONE.value


_TOKEN_STRIP = re.compile(r"\[[^\]]*\]")
_TOKEN_KEEP = re.compile(r"[^\w\s']", re.UNICODE)


def lyrics_tokens(text: str) -> list[str]:
    """Words, lowercased, punctuation and [bracket] markers stripped. Compares CONTENT, not form.

    NFKC-normalised first so text differing only in Unicode FORM tokenises the same (full-width vs
    half-width, composed vs decomposed accents, ligatures) \u2014 without it, two visually identical
    strings can be distinct tokens on both sides of `agreement_score`, counting a correct candidate
    as disagreeing. Idempotent on ASCII, so it cannot move an all-ASCII score. Mirrors
    src/lib/contract/lyrics/lyrics.ts:lyricsTokens.
    """
    folded = unicodedata.normalize("NFKC", text).lower()
    cleaned = _TOKEN_KEEP.sub(" ", _TOKEN_STRIP.sub(" ", folded))
    return [t for t in cleaned.split() if t]


@dataclass
class LyricsRequest:
    """Everything a source might need to find text for one song."""

    media_id: str
    #: Confidence-gated canonicals from the core. None when the parse was not confident —
    #: a source that needs them must decline rather than look up a guess.
    artist: str | None = None
    track: str | None = None
    duration: float | None = None
    #: The FULL billing as the upload wrote it, vs `artist` (primary only). Not a lookup key — LRCLIB
    #: is queried on the primary, since the full credit misses records filed under the primary alone.
    #: It is a RANKING signal: among records matching the same artist/track, the one whose own artist
    #: string also mentions the featured performer is the better metadata match.
    artist_credit: str | None = None
    #: The raw mixed audio (retained original). Fine for forced alignment.
    audio_path: str = ""
    #: The isolated vocals stem, when a stems job has already produced it. ASR wants THIS — a full mix
    #: transcribes badly — so it may be absent for a song whose stems have not been processed.
    vocals_path: str | None = None
    #: Cues from the upload's own human-authored caption track, already fetched and parsed by the
    #: processor's async stage. None/[] means the upload has no manual track. Passed in rather than
    #: fetched by the tier so this module performs no I/O.
    caption_segments: list[dict[str, Any]] | None = None
    #: Cues from YouTube's AUTOMATIC caption track, fetched into a separate directory so the two can
    #: never be confused for one another. A BASELINE input — see AutoCaptionsSource.
    auto_caption_segments: list[dict[str, Any]] | None = None


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
    #: BASELINE (evidence of what is heard) or CANDIDATE (authored text to be judged) — decides
    #: whether a text is scored or does the scoring.
    #:
    #: ASSIGNED BY THE REGISTRY, not by the source that fetched the text (`lyrics/registry.py` stamps
    #: it, and its `alternates`, from the fetching source's `SourceSpec`). The default below applies
    #: only to a text built by hand (a test, or one rehydrated from disk). It is fail-CLOSED:
    #: ROLE_UNSPECIFIED is in neither `candidates_of` nor `baselines_of`, so an unspecified text is
    #: NOT published or used as grading evidence until a role is stamped — a fail-OPEN default (e.g.
    #: ROLE_CANDIDATE) would let an unspecified construction silently publish.
    role: str = ROLE_UNSPECIFIED
    #: Preference among baselines when one must be SHOWN. None for candidates. Registry-assigned, as above.
    baseline_rank: int | None = None
    #: A short stable id for this text WITHIN its source, so two baselines from the same source can
    #: coexist on disk ('vocals' and 'mix' are both `asr`). Part of the artifact key; see candidate_key.
    tag: str | None = None
    #: Which VERSION of the song this text is, for logs. None when the source has no notion of one.
    variant: str | None = None
    #: Other versions of this song the same source offered, best-first by cheap metadata ranking.
    #: Held on the winner rather than returned alongside it: only ONE may ever be published (the
    #: artifact key is (media, source, timing)), so these are the losers of a choice not yet made —
    #: `select_by_baselines` makes it once the ASR transcript exists to decide with.
    alternates: list[LyricsText] = field(default_factory=list)
    #: Length-bounded search WINDOWS for the forced aligner, when `segments` are the source's OWN
    #: human lines and must stay un-subdivided so the line-sync fallback publishes them verbatim.
    #: `presplit` sets this on authoritative text whose lines overflow a row, giving the aligner
    #: tight per-row windows while `segments` keeps the true human line timings. None means the
    #: aligner searches `segments` as-is (the ASR tier, which invents line structure anyway).
    align_windows: list[dict[str, Any]] | None = None
    #: Index into ``align_windows`` of the OPENING window of each human segment (the one whose
    #: ``start`` equals the segment start exactly). Emitted by ``bound_blob_text`` when it builds the
    #: windows, since that is where the segment->window mapping is KNOWN; re-deriving it later by
    #: float-equality strands every line after the first start that misses by more than 1e-6.
    align_window_opens: list[int] | None = None

    @property
    def plain_text(self) -> str:
        """Flattened text, for ASR-vs-authoritative agreement scoring."""
        return "\n".join(str(s.get("text") or "") for s in self.segments).strip()

    def is_usable(self) -> bool:
        return any(str(s.get("text") or "").strip() for s in self.segments)


def is_line_synced(doc: dict[str, Any]) -> bool:
    """A usable line-synced artifact: a line with a numeric start and text.

    Word timings NOT required — the whole distinction from `is_valid_lyrics`, which demands words.

    A free function beside the class because its callers hold a plain dict (e.g. `_time_one` asking
    of a doc it just built), and lives here rather than in `lrc.py` because it judges the ARTIFACT's
    shape, this module's subject — an LRC file is one thing that can produce such a doc, not the only one.
    """
    return LyricsDoc(doc).is_line_synced()
