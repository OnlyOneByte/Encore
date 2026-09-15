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

This is also the intended home for the other types the lyrics domain shares between `chain.py` and
`sources.py`, which currently reach each other through a bottom-of-file import block.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any


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
