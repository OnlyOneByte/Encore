"""The lyrics artifact's SHAPE, stated once.

A word-timed lyrics artifact is a plain dict — `{"language", "lines": [...], "words": [...]}` — because
that is what gets written to `derived/lyrics/*.json` and what the core reads. This module does not change
that. `LyricsDoc` is a read-only VIEW over the same dict, so the artifact keeps its representation and
the readers stop each re-deriving what it looks like.

WHAT WAS WRONG WITH THE DICT. Nothing, as a format. The problem was that four readers each sniffed the
shape independently:

  * `validate._words_of` walked `doc["lines"] or doc["segments"]`, then each line's `words`, keeping only
    words with numeric bounds.
  * `validate.line_starts` re-derived the same `lines`-or-`segments` read for line starts.
  * `artifact.is_valid_lyrics` read `doc["lines"]` alone and asked whether any line had words.
  * `source.is_line_synced` read `doc["lines"]` alone and asked whether any line had a start and text.

Two of them tolerated the alternate `segments` key and two did not, and nothing said which was right —
so the answer to "what counts as a line here" depended on which function you happened to call.

THAT DISAGREEMENT TURNED OUT TO BE LOAD-BEARING, which is the interesting part. Unifying it looks like
the obvious cleanup and is a behaviour change: handing the two predicates the tolerant read flips 107
outcomes for `has_timed_words` and 25 for `is_line_synced` across a 256-doc corpus, because a raw
`segments` doc starts reading as a publishable artifact. So both reads are kept and NAMED — `lines` for
the artifact's own key, `lines_or_segments` for the boundary where a doc may still be either — instead of
one read that quietly picks a winner.

WHY `segments` IS TOLERATED AT ALL. `normalize_lyrics` always emits `lines` and every current production
caller passes a normalized doc, so the fallback looks dead from the call sites alone. It is kept because
artifacts also arrive from DISK: the boot-time lyrics backfill (`ENCORE_LYRICS_BACKFILL`) reads whatever
`derived/lyrics/` already holds, including files an older build wrote.

NOT A VALIDATOR, and not a parser. It answers questions about a doc; it never raises on a malformed one,
because every one of these readers is a PREDICATE whose job is to return False for junk rather than to
reject it. `validate.py` owns the judgements about timing QUALITY; this module owns only the shape.

This is also the intended home for the other types the lyrics domain shares between `grading.py` and
`sources.py`, which currently reach each other through a bottom-of-file import block.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from ..vocabulary import ROLE_UNSPECIFIED, TextSource, Timing


def _is_num(value: Any) -> bool:
    """A real number, and not a bool.

    `isinstance(True, int)` is True in Python, so a `start` of `True` would otherwise read as time 1.0.
    Every site that sniffed a timestamp used the bare `isinstance(x, (int, float))` form, so this is the
    one behavioural TIGHTENING here — stated rather than smuggled in.
    """
    return isinstance(value, (int, float)) and not isinstance(value, bool)


@dataclass(frozen=True)
class LyricsDoc:
    """A read-only view over a lyrics artifact dict.

    Frozen, and it does not copy: `raw` is the caller's own dict, so wrapping one in a hot path costs
    nothing and a caller that still needs the dict (to write it, to hand it to the core) keeps using it
    directly. Wrap for the questions, not for the data.
    """

    raw: Mapping[str, Any]

    @property
    def language(self) -> str | None:
        lang = self.raw.get("language")
        return lang if isinstance(lang, str) and lang else None

    @property
    def lines(self) -> list[dict[str, Any]]:
        """The line records under the artifact's OWN key, `lines`, with non-dict entries dropped.

        Strict on purpose. `normalize_lyrics` is what produces a lyrics artifact and it always writes
        `lines`, so a doc without that key is not an artifact — it is raw aligner output that has not been
        normalized yet, and the two predicates below are meant to say False for it.
        """
        return self._records("lines")

    @property
    def lines_or_segments(self) -> list[dict[str, Any]]:
        """The same records, falling back to the older `segments` key.

        THE TWO READS ARE DIFFERENT ON PURPOSE, and flattening them into one is a behaviour change — this
        was measured, not assumed. Giving the predicates this tolerant read flips 107 outcomes for
        `has_timed_words` and 25 for `is_line_synced` over a 256-doc corpus, because a raw `segments` doc
        starts reading as a publishable artifact.

        So the tolerance lives only where it always lived: the timing reader, which runs at the boundary
        where a doc may still be either. Artifacts also arrive from DISK — the boot-time lyrics backfill
        (`ENCORE_LYRICS_BACKFILL`) reads whatever `derived/lyrics/` already holds, including files an
        older build wrote — which is why the fallback is kept rather than deleted as unreachable.
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

        Words missing either bound are skipped rather than defaulted: a word with no end cannot be given
        one without inventing a duration, and the timing report downstream measures exactly the defects
        that invention would hide.
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

        Deliberately the WEAKER test — it asks whether `words` is non-empty, not whether those words have
        timestamps. That is the historical meaning of `is_valid_lyrics`, and tightening it here would
        change which artifacts get published. `validate_timing` is the thing that judges whether the
        timings are any good, and it exists because six real artifacts cleared this bar while containing
        a 63-second hole.
        """
        return any(line.get("words") for line in self.lines)

    def is_line_synced(self) -> bool:
        """A usable line-synced artifact: some line with a numeric start and non-empty text.

        Word timings NOT required — that is the whole distinction from `has_timed_words`. This is what
        lets a source with only LRC line timings still publish something the TV can highlight per line.
        """
        return any(_is_num(line.get("start")) and bool(line.get("text")) for line in self.lines)


# ── the shared lyrics vocabulary ──────────────────────────────────────────────────────────────────
#
# These lived in `grading.py`, which is what made the domain's import graph a cycle: `sources.py` needs
# `LyricsRequest`/`LyricsText` to declare what a source consumes and returns, `grading.py` needs the source
# classes to run them — so `grading.py` imported `.sources` from the FOOT of its own file, after the two
# dataclasses were defined, carrying `# noqa: E402` to silence the lint that exists to catch exactly that.
# It worked, and it meant the two modules could not be read or imported independently.
#
# Nothing here depends on anything else in the package, so both sides can import it and the cycle has no
# edge left to close. `grading.py` re-exports every name below, so `from .grading import LyricsText` — which
# nine test modules and three source modules do — keeps resolving.

# Text-source ids and timing tiers. Promoted to enums in src/vocabulary.py (TextSource, Timing) so the
# TS↔Python guard in src/lib/server/jobs/vocabulary-parity.test.ts covers them — a comment saying
# "must match LyricsTextSource" cannot fail a build; the enum can. Re-exported under the original names
# so every importer of grading.py is unchanged, and `.value` keeps them plain strings for JSON/argv/keys.
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

    NFKC-normalised first so text differing only in Unicode FORM tokenises the same: full-width vs
    half-width digits/letters, composed vs decomposed accents, ligatures. Without it "Beyonc\u00e9" (one
    codepoint) and "Beyonce\u0301" (e + combining acute) are distinct tokens on both the intersection
    and the union of `agreement_score`, counting a correct candidate as disagreeing twice. Idempotent
    on ASCII (unicodedata.normalize("NFKC", ascii) == ascii), so it cannot move an all-ASCII score.
    Mirrors src/lib/contract/lyrics/lyrics.ts:lyricsTokens (kept in one commit) and the established fold in
    metadata/annotate.py:normalize_for_match.
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
    #: The FULL billing as the upload wrote it ("Lady Gaga feat. Beyoncé") when one was parsed, versus
    #: `artist` which is only the primary. Not a lookup key — LRCLIB is queried on the primary, because
    #: querying the full credit misses every record filed under the primary alone. It is a RANKING
    #: signal: among records that all match "Lady Gaga / Telephone", the one whose own artist string
    #: also mentions Beyoncé is the better metadata match.
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
    #: BASELINE (evidence of what is heard) or CANDIDATE (authored text to be judged). See the role
    #: constants above — this is what decides whether a text is scored or does the scoring.
    #:
    #: ASSIGNED BY THE REGISTRY, not by the source that fetched the text: `lyrics/registry.py` stamps it
    #: from the fetching source's `SourceSpec`. The sources used to set it themselves, which made the
    #: registry's `role`/`baseline_rank` fields a second declaration of the same fact that nothing read —
    #: so the two could disagree and every test would stay green. The default below therefore applies
    #: only to a text built by hand (a test, or one rehydrated from disk by `split_blob_text`) — and it is
    #: fail-CLOSED: ROLE_UNSPECIFIED is in neither `candidates_of` nor `baselines_of`, so an
    #: unspecified text is NOT published as the song's words (and is not used as grading evidence) until a
    #: role is stamped. The registry stamps a fetched text AND its `alternates`, because
    #: `select_by_baselines` grades `[cand, *cand.alternates]` and may publish an alternate — so an
    #: alternate left unspecified could win and publish as unspecified, the very hole this default guards.
    #: The old default was ROLE_CANDIDATE — the PUBLISHABLE tier — which silently let an
    #: unspecified construction publish, exactly the fail-open the `presplit.py` replace() note guards
    #: against (a dropped role once turned a baseline into a candidate).
    role: str = ROLE_UNSPECIFIED
    #: Preference among baselines when one must be SHOWN. None for candidates. Registry-assigned, as above.
    baseline_rank: int | None = None
    #: A short stable id for this text WITHIN its source, so two baselines from the same source can
    #: coexist on disk ('vocals' and 'mix' are both `asr`). Part of the artifact key; see candidate_key.
    tag: str | None = None
    #: Which VERSION of the song this text is, for logs. None when the source has no notion of one.
    variant: str | None = None
    #: Other versions of this song the same source offered, best-first by cheap metadata ranking.
    #:
    #: Held on the winner rather than returned alongside it because only ONE of them may ever be
    #: published: the artifact key is (media, source, timing), so two LRCLIB candidates would collide
    #: on disk and in the candidate set. These are the losers of a choice that has not been made yet —
    #: `select_by_baselines` makes it once the ASR transcript exists to decide with.
    alternates: list[LyricsText] = field(default_factory=list)
    #: Length-bounded search WINDOWS for the forced aligner, when `segments` are the source's OWN
    #: (human) lines and must stay un-subdivided so the line-sync fallback publishes them verbatim.
    #: `presplit` sets this on authoritative text whose lines overflow a row: the aligner gets tight
    #: per-row windows to search, but `segments` keeps the true human line timings for the line-sync
    #: publish path (which would otherwise ship a character-count-derived boundary as `high`). None
    #: means "the aligner searches `segments` as-is" — the ASR tier, where line structure is invented
    #: anyway, subdivides `segments` directly and leaves this None.
    align_windows: list[dict[str, Any]] | None = None
    #: Index into ``align_windows`` of the OPENING window of each human segment — the one window
    #: per line that carries the source's own timestamp (its ``start`` equals the segment start
    #: exactly). Emitted by ``bound_blob_text`` when it builds the windows, because that is where
    #: the segment->window mapping is KNOWN; re-deriving it later by float-equality strands every
    #: line after the first start that fails to match to 1e-6. ``len`` equals the
    #: number of segments, and index ``i`` opens segment ``i``. None whenever ``align_windows`` is.
    align_window_opens: list[int] | None = None

    @property
    def plain_text(self) -> str:
        """Flattened text, for ASR-vs-authoritative agreement scoring."""
        return "\n".join(str(s.get("text") or "") for s in self.segments).strip()

    def is_usable(self) -> bool:
        return any(str(s.get("text") or "").strip() for s in self.segments)
