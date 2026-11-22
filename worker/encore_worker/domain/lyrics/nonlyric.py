"""Which lines of a text are NOT LYRICS — decided by the track's own evidence, never by a word list.

A separate module from `clean.py`, which removes FORMAT and judges nothing. Four rules, every one ANCHORED to
a closed allowlist, a bracket, a colon or the author's own marking: a whole-line section header (R1), a
leading label prefix with the rest of the line KEPT (R2), an unnoted line in a track that notes its sung ones
(R3), and a YouTube ASR non-speech marker (R4). Why this is a correctness fix rather than an accuracy one, and
the three deliberate NON-rules: `docs/arch/04-alignment.md` §8; LOG.md, "The non-lyric floor, as arithmetic".
"""

from __future__ import annotations

import re
from collections.abc import Sequence

#: Section labels R1/R2 recognise. Lowercase; the patterns are case-insensitive. Kept SHORT on purpose:
#: prevalence is low (1 of 12 authored caption tracks), every addition is a word a lyric could contain,
#: and the anchors (a bracket, or a colon) are what make even `break` and `tag` safe here.
SECTION_LABELS: tuple[str, ...] = (
    "intro",
    "verse",
    "pre-chorus",
    "prechorus",
    "chorus",
    "post-chorus",
    "postchorus",
    "hook",
    "refrain",
    "bridge",
    "breakdown",
    "interlude",
    "instrumental",
    "solo",
    "outro",
    "coda",
    "vamp",
    "tag",
    "break",
    "middle eight",
)

#: Non-speech markers YouTube's ASR emits. A CLOSED machine vocabulary (R4), which is why it may be a
#: vocabulary at all — the three strings an auto-caption track writes, and nothing a human chose.
ASR_MARKERS: tuple[str, ...] = ("music", "applause", "laughter")

#: R3's floor: the share of a track's WORDED lines that must carry a music note before an UNNOTED line reads
#: as not sung. At the BOTTOM of the measured population, the cost either side being asymmetric — below it the
#: rule DELETES real sung lines (LOG.md, "The non-lyric floor, as arithmetic").
NOTED_SHARE = 0.8

#: …and R3 needs enough of a track to read a convention off. Four noted lines is a chorus; a two-line
#: snippet where one line happens to carry a note is not evidence about the other.
NOTED_MIN_LINES = 4

#: The notes `clean.py` strips, matched here BEFORE it strips them — R3 reads the RAW line for exactly
#: this reason. Kept in step with `clean._NOTES` (a test pins the two together).
_NOTE = re.compile(r"[♪♫♬♩\U0001d15e]")

_LABEL = "|".join(label.replace(" ", r"\s+").replace("-", "-?") for label in SECTION_LABELS)

#: `Verse 2`, `Verse II`. Arabic numerals and roman numerals only: a trailing LETTER (`Verse A`) is not a
#: shape real sheets use often enough to pay for, and `[Chorus a]` would be the only thing it bought.
_ORDINAL = r"(?:\s*(?:\d{1,2}|[ivx]{1,4}))?"

#: `Chorus x2`, `Chorus 2x` — recognised so the LABEL goes, not so the repeat is expanded (see the
#: module docstring: expansion is the deferred item).
_REPEAT = r"(?:\s*(?:[x×]\s*\d{1,2}|\d{1,2}\s*[x×]))?"

#: Genius writes the performer inside the bracket: `[Verse 1: Eminem]`, `[Chorus: Rihanna]`. Anything
#: after a colon INSIDE the bracket is part of the header, so it goes with it.
_PERFORMER = r"(?:\s*:[^\]\)\}]*)?"

_HEAD = rf"(?:{_LABEL}){_ORDINAL}{_REPEAT}"

#: R1a: a header wrapped in its own brackets and nothing else on the line.
_BRACKETED_HEADER = re.compile(rf"^[\[({{]\s*{_HEAD}{_PERFORMER}\s*[\])}}]$", re.IGNORECASE)

#: R1b: an unbracketed header, WHICH MUST CARRY THE COLON. Without that requirement a line whose only
#: word is `Hook` or `Break` — a word a lyric can be — would be deleted, which is the measured failure
#: `clean.py` refuses in the unanchored form.
_COLON_HEADER = re.compile(rf"^{_HEAD}\s*:$", re.IGNORECASE)

#: R2: the prefix form, `CHORUS: <first line of the section>`. The colon is required for the same reason,
#: and the allowlist is what keeps `Baby: I love you` whole.
_LABEL_PREFIX = re.compile(rf"^{_HEAD}\s*:\s*(?=\S)", re.IGNORECASE)

#: R4: one pair of enclosing brackets around a single marker word.
_BRACKETED_MARKER = re.compile(rf"^[\[({{]\s*(?:{'|'.join(ASR_MARKERS)})\s*[\])}}]$", re.IGNORECASE)


def is_section_header(text: str) -> bool:
    """R1: this whole CLEANED line is a section label from the allowlist, read on the cleaned text so
    `♪ [Chorus] ♪` is recognised after the notes come off."""
    stripped = text.strip()
    if not stripped:
        return False
    return bool(_BRACKETED_HEADER.match(stripped) or _COLON_HEADER.match(stripped))


def is_asr_marker(text: str) -> bool:
    """R4: this whole CLEANED line is one of YouTube's ASR non-speech markers."""
    return bool(_BRACKETED_MARKER.match(text.strip()))


def without_section_label(text: str) -> str:
    """R2: `CHORUS: I'm tired of being what you want` -> `I'm tired of being what you want`.

    Identity for every line that is not an allowlisted label with a colon, `Baby: I love you` included. Only
    ONE prefix is stripped, a sheet that wrote two not being a shape worth guessing at.
    """
    return _LABEL_PREFIX.sub("", text, count=1)


def noted_track(raw_texts: Sequence[str], cleaned_texts: Sequence[str]) -> bool:
    """R3's precondition: this track marks its SUNG lines with music notes.

    Reads the RAW lines, `clean_line` removing the very marking this is evidence about, and counts only the
    lines that have WORDS and that R1/R4 have not already answered. Both exclusions are measured: counting a
    bare `♪` line fired R3 on every real lyric of one shape, and counting a `[Chorus]` label made a labelled
    sheet read as LESS marked than the same sheet unlabelled (LOG.md, "The non-lyric floor, as arithmetic").
    """
    if len(raw_texts) != len(cleaned_texts):  # pragma: no cover - a caller bug, not an input
        raise ValueError("raw_texts and cleaned_texts must be parallel")
    lines = [
        raw
        for raw, cleaned in zip(raw_texts, cleaned_texts, strict=True)
        if raw and raw.strip() and cleaned and cleaned.strip()
        if not (is_section_header(cleaned) or is_asr_marker(cleaned))
    ]
    noted = sum(1 for text in lines if _NOTE.search(text))
    if noted < NOTED_MIN_LINES:
        return False
    return noted >= NOTED_SHARE * len(lines)


def nonlyric_indexes(
    raw_texts: Sequence[str], cleaned_texts: Sequence[str], *, author_marking: bool = True
) -> frozenset[int]:
    """Indexes of the lines this text's own evidence says are not sung.

    `raw_texts` and `cleaned_texts` are parallel and the same length, R3 needing the notes `clean_line`
    removed. An index whose cleaned text is empty is NOT reported, or a note-only track would look unnoted.
    `author_marking=False` LEAVES R3 OUT, for a person's own PASTE: R3 is the only rule here read off the
    WHOLE text, so it has no per-line anchor to point at.
    """
    if len(raw_texts) != len(cleaned_texts):  # pragma: no cover - a caller bug, not an input
        raise ValueError("raw_texts and cleaned_texts must be parallel")
    notes_mark_the_sung = author_marking and noted_track(raw_texts, cleaned_texts)
    out: set[int] = set()
    for index, (raw, cleaned) in enumerate(zip(raw_texts, cleaned_texts, strict=True)):
        if not cleaned:
            continue
        if is_section_header(cleaned) or is_asr_marker(cleaned):
            out.add(index)
        elif notes_mark_the_sung and not _NOTE.search(raw):
            out.add(index)
    return frozenset(out)
