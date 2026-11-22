"""Stripping what a caption FORMAT put in a lyric line, and nothing else.

`clean_line` removes only FORMAT and judges NOTHING about whether a line is a lyric, which is
`nonlyric.py`'s. ORDER IS LOAD-BEARING and IDEMPOTENCE IS A TEST — the cheap property that catches an ordering
mistake with no corpus at all. The order's two reasons and the three rules REJECTED here:
`docs/arch/04-alignment.md` §8.
"""

from __future__ import annotations

import html
import re
from collections.abc import Mapping, Sequence

from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics.nonlyric import nonlyric_indexes, without_section_label

#: Tags whose CONTENT is lyric and whose markup is not: unwrap them, keep the words. Restricted to the
#: WebVTT/HTML set that actually appears in caption tracks.
_UNWRAP_TAGS = "i|b|u|em|strong|ruby|rtc?"

#: ATTRIBUTES ARE MATCHED BY EACH TAG'S REAL SYNTAX, not by "tag name then anything": the loose form eats
#: real lyrics (`<c u later> alligator`), so each attributed tag gets only the shape it actually takes —
#: dot-separated VTT classes, a voice's speaker, a BCP-47 language tag, and HTML's `=`.
_ATTRIBUTED = (
    r"</?c(?:\.[\w-]+)*>"
    r"|</?v(?:\s+[^<>]*)?>"
    r"|</?lang(?:\s+[\w-]+)?>"
    r"|</?font(?:\s+[^<>]*=[^<>]*)?>"
)

_TAG = re.compile(
    rf"</?(?:{_UNWRAP_TAGS})>|{_ATTRIBUTED}",
    re.IGNORECASE,
)

#: Ruby ANNOTATION content is a pronunciation guide, not a lyric: `<ruby>君<rt>きみ</rt></ruby>` unwrapped
#: yields "君 きみ", which makes the karaoke ball sing every kanji twice. Excise body and all.
_RUBY_TEXT = re.compile(r"<rt\b[^<>]*>.*?</rt>|<rtc\b[^<>]*>.*?</rtc>", re.IGNORECASE | re.DOTALL)

#: An ASR roll-up track times every word inline: `<00:00:18.320><c> so</c>`. The timestamps are machine
#: output; without this a whole cue reads as a wall of digits.
_INLINE_TIMESTAMP = re.compile(r"<\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}>|<\d{1,2}:\d{2}[.,]\d{1,3}>")

#: Music notes marking "this line is sung". Any run, any count — tracks use `♪`, `♪♪` and `♪♪♪`
#: interchangeably, and one track glues the closer to the last word (`that♪♪`).
_NOTES = re.compile(r"[♪♫♬♩\U0001d15e]+")

#: A leading dash separates SPEAKERS in a caption, so it is format rather than lyric. Anchored on
#: optional leading whitespace (see the module docstring) and refusing `--`, which is a censor bar or an
#: em-dash the author typed inside the words.
_SPEAKER_DASH = re.compile(r"^\s*[-–—](?=\s|[^\s\-–—])\s*")

#: Zero-width characters that carry no orthography. DELIBERATELY EXCLUDES U+200C ZWNJ and U+200D ZWJ,
#: which are letters' business in Indic and Arabic scripts, and U+200E/U+200F, the bidi marks an RTL
#: lyric needs to render in the right direction at all.
_INVISIBLE = re.compile("[​﻿⁠]")

_WHITESPACE = re.compile(r"\s+")


def clean_line(text: str) -> str:
    """One caption/LRC line with its FORMAT removed, pure and idempotent. Empty when nothing but format was
    there, which is the caller's signal that the line carried no words."""
    if not text:
        return ""
    # Entities first: one real track writes its markup escaped, and a tag strip before this sees none.
    out = html.unescape(text)
    # MARKUP BECOMES NOTHING, not a space: a space would break CJK, where `<ruby>君<rt>きみ</rt></ruby>の`
    # must close up to `君の` rather than `君 の`. Measured safe on the caption corpus — cue lines are
    # already space-joined by `_cue_of`, so no real word pair depends on a tag to separate it.
    out = _RUBY_TEXT.sub("", out)
    out = _INLINE_TIMESTAMP.sub("", out)
    out = _TAG.sub("", out)
    # Notes DO become a space, because one track glues the closer to the last word (`that♪♪`) and another
    # opens a line with it; collapsing whitespace afterwards makes the space free where it was not needed.
    out = _NOTES.sub(" ", out)
    out = _INVISIBLE.sub("", out)
    # AFTER the notes became spaces, so a note-then-dash line still presents the dash; see above.
    out = _SPEAKER_DASH.sub("", out)
    out = _WHITESPACE.sub(" ", out).strip()
    # A line reduced to punctuation is decoration, not a lyric: `[♪♪♪]` leaves `[]`, `- ♪♪ -` leaves `-`.
    if not any(ch.isalnum() for ch in out):
        return ""
    return out


def clean_indexed(
    segments: Sequence[Mapping[str, object]], *, author_marking: bool = True
) -> tuple[tuple[int, Segment], ...]:
    """`clean_segments`, each kept segment paired with its index in the INPUT — what a caller holding a
    parallel list of its own needs, the kept set no longer being reconstructible from `clean_line` alone
    since `nonlyric.noted_track` reads the WHOLE track. `author_marking=False` leaves R3 out."""
    raw = [str(segment.get("text") or "") for segment in segments]
    cleaned_texts = [clean_line(text) for text in raw]
    # TEXT HYGIENE RUNS ON THE CLEANED LINE, FORMAT ALREADY OFF, EXCEPT where it cannot: `noted_track`
    # reads the raw line, because the music note it is evidence about is one of the things `clean_line`
    # removes. See `nonlyric`'s docstring for all four rules and the corpus they were measured on.
    dropped = nonlyric_indexes(raw, cleaned_texts, author_marking=author_marking)
    out: list[tuple[int, Segment]] = []
    for index, segment in enumerate(segments):
        text = cleaned_texts[index]
        if not text or index in dropped:
            continue
        # A `CHORUS:` prefix loses the LABEL and keeps the line: the section's first line is
        # a real lyric, and Numb's authored captions label 17 of its 35 lines that way.
        labelled, text = text, without_section_label(text)
        if not text:  # pragma: no cover - the prefix pattern requires a non-space after the colon
            continue
        cleaned: dict[str, object] = {**segment, "text": text}
        words = segment.get("words")
        if isinstance(words, (list, tuple)):
            kept: list[Segment] = []
            for word in words:
                if not isinstance(word, Mapping):
                    continue
                spelled = clean_line(str(word.get("word") or ""))
                if spelled:
                    kept.append({**word, "word": spelled})
            # IN LOCKSTEP WITH THE TEXT, THE LABEL INCLUDED: `clean_line` has no label rule, so a word-timed
            # segment whose text read `CHORUS: <first line>` published a word stream offset by one. Dropped by
            # SPELLING rather than by counting tokens.
            kept = list(_without_label_words(kept, labelled[: len(labelled) - len(text)]))
            # An all-decoration word list leaves the line with no timings, which beats a list that disagrees
            # with the screen. A TUPLE, these records being DBOS checkpoint payloads (XA-16).
            if kept:
                cleaned["words"] = tuple(kept)
            else:
                cleaned.pop("words", None)
        out.append((index, cleaned))
    return tuple(out)


def _without_label_words(words: Sequence[Segment], removed: str) -> tuple[Segment, ...]:
    """`words` with the leading rows that spell `removed` dropped — R2's strip, on the word list.

    Matched on the SPELLING with whitespace and case out, a label being one row or several and a provider
    promising no tokenisation. A run that diverges drops nothing: an over-eager match deletes a sung word.
    """
    target = "".join(removed.split()).casefold()
    if not target:
        return tuple(words)
    seen = ""
    for index, word in enumerate(words):
        seen += "".join(str(word.get("word") or "").split()).casefold()
        if seen == target:
            return tuple(words[index + 1 :])
        if not target.startswith(seen):
            break
    return tuple(words)


def clean_segments(
    segments: Sequence[Mapping[str, object]], *, author_marking: bool = True
) -> tuple[Segment, ...]:
    """Every segment's text cleaned, its word list cleaned IN LOCKSTEP, wordless and NON-LYRIC rows gone.

    THE WORD LIST IS WHY THIS EXISTS AS WELL AS `clean_line`: a provider's per-word timings carry the same
    decorations, and cleaning only the line text publishes a clean sentence over a dirty word stream.
    DROPPING RENUMBERS NOTHING, every consumer enumerating the one post-clean sequence; a caller holding a
    parallel list wants `clean_indexed`. `author_marking=False` leaves R3 out, for a text a person typed.
    """
    return tuple(segment for _index, segment in clean_indexed(segments, author_marking=author_marking))
