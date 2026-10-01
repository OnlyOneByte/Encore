"""Stripping what a caption FORMAT put in a lyric line, and nothing else.

WHY THIS EXISTS. Caption tracks are display artefacts, not lyric sheets. A WebVTT cue carries italic
tags, per-word ASR timestamp spans, music-note decorations and speaker dashes — and until this module
existed every one of them was published and drawn on the television as words to sing. Measured on the
real track for The Black Eyed Peas' "Boom Boom Pow" (`--write-auto-subs`), the TV rendered:

    - ♪♪ Gotta get that ♪♪ <i>- ♪♪ Boom boom boom ♪♪</i>

THE LINE THIS DRAWS. `clean_line` removes only FORMAT: markup the caption pipeline inserted, and
decorations that mark a line as sung rather than being sung. It judges nothing about whether a line is a
lyric, and every rejected idea below is a rule that tried to and destroyed real lyrics doing it.

WHAT CHANGED IN W5, and it is one layer out rather than in here: `clean_segments` now also drops the
lines `domain/lyrics/nonlyric.py` judges NOT SUNG, by rules that are ANCHORED (a closed allowlist of
section labels, with a bracket or a colon; YouTube's three ASR markers; and the caption author's OWN
music-note marking, read off the raw line before the notes come off). Read that module's docstring for
the measurement — the short version is that the ACOUSTIC never-sung rule in `steps/align_steps.py` drops
different cues under different models, so a song's scored line count moved with the acoustic bundle and
no per-song accuracy row was comparable across models. What is still NOT judged here is a parenthetical
in a track that neither notes its lyrics nor came from a machine: `(gentle piano solo)` on such a track
is left for the audio, for the reason immediately below.

WHAT WAS MEASURED AND REJECTED, because each one destroys real lyrics (verified against real corpora):

  * Dropping whole-line parentheticals by a sound-effect vocabulary. Any word list that catches
    `(slow quiet electric guitar)` also catches `(Beat it, beat it)`, `(Play that funky music)`,
    `(Drop the beat)`, `(the beat goes on)` and `(bells ringing)` — all sung.
  * Dropping bracketed lines that "have no lowercase". `[a-z]` is ASCII, so every caseless script
    satisfies it: `[Люблю тебя]`, `[私の心は燃えている]`, `[사랑해요]` all deleted. Bracketed ad-libs
    (`[GO!]`, `[HEY!]`, `[OH YEAH]`) go with them.
  * Stripping a capitalised token before a colon as a speaker label. With no allowlist it eats real
    first words: `Baby: I love you` -> `I love you`, `Mama: don't cry` -> `don't cry`.

Whole-line parentheses stay for a second reason: they are frequently the backing vocal itself. Shape of
You's caption track sings `♪ (Oh-I-oh-I-oh-I-oh-I) ♪` and `(I'm in love with your body)`.

ORDER IS LOAD-BEARING, and two orderings were measured wrong before this one:

  1. Entities are decoded FIRST. One authored track (Despacito's English captions) is 89% ESCAPED
     markup — `&lt;i&gt;` rather than `<i>` — so a tag strip that runs first leaves `<i>` on screen.
  2. The speaker dash is matched with a LEADING-WHITESPACE anchor, and runs AFTER the notes became
     spaces. `<i>- ♪♪ Boom boom boom ♪♪</i>` reaches the dash rule as `- Boom boom boom`, but a note
     that opens the line leaves a space in front of the dash — and a rule anchored at `^-` silently
     misses the only cue shape the whole exercise was about.

IDEMPOTENCE IS A TEST, not a hope: `clean_line(clean_line(x)) == clean_line(x)` for every line in the
corpus. It is the cheap property that catches an ordering mistake with no corpus at all — it was what
failed first when the dash anchor was wrong.
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

#: ATTRIBUTES ARE MATCHED BY EACH TAG'S REAL SYNTAX, not by "tag name then anything". The loose form
#: eats real lyrics — `<b my baby> hold on`, `<u and me> forever`, `<c u later> alligator` all lose
#: words — so each attributed tag gets only the shape it actually takes:
#:   `<c.yellow.bg_blue>`  WebVTT classes are DOT-separated; a SPACE after `c` is not valid VTT, which
#:                         is exactly what saves `<c u later> alligator` (found by its own test).
#:   `<v Speaker>`         a voice span names a speaker after a space.
#:   `<lang en-GB>`        a language span takes a BCP-47-shaped tag, letters/digits/hyphens only.
#:   `<font color="red">`  HTML, so require an `=`; without it `<font of knowledge>` would be eaten.
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
    """One caption/LRC line with its FORMAT removed. Empty when nothing but format was there.

    Pure and idempotent. An empty return is the caller's signal that the line carried no words — a
    music-note-only cue (`[♪♪♪]`, `♪♪`) is the common case.
    """
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
    """`clean_segments`, each kept segment paired with its index in the INPUT.

    The pair is what a caller needs when it holds a parallel list of its own — the bench's
    `served_claims` pairs each served line back to the claim it came from, and used to re-derive the kept
    set by calling `clean_line` itself, which was only correct while every rule here was per-line. W5's
    non-lyric rules are not (`nonlyric.noted_track` reads the WHOLE track), so the mapping is published
    rather than reconstructible.

    `author_marking=False` is `nonlyric`'s R3 left out, for a text a PERSON typed; see `clean_segments`.
    """
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
        # A `CHORUS:` prefix loses the LABEL and keeps the line (review M11): the section's first line is
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
            # IN LOCKSTEP WITH THE TEXT, THE LABEL INCLUDED (W5 review r1-correctness-7). `clean_line` has
            # no label rule — only R2 does, above, on the line — so a word-timed segment whose text read
            # `CHORUS: <first line>` published three words on screen over a four-word stream, offset by
            # one, which is the exact state this function's docstring calls worse than not cleaning at all.
            # Dropped by SPELLING rather than by counting tokens: when the rows do not spell the removed
            # prefix the list is left whole, which is what it was before.
            kept = list(_without_label_words(kept, labelled[: len(labelled) - len(text)]))
            # An all-decoration word list would leave the line with no timings at all; better to publish
            # the line with none than with a list that disagrees with the words on screen.
            # A TUPLE, matching every other segment producer in the worker: these records are DBOS
            # checkpoint payloads, and the suite asserts immutability at each provider boundary.
            if kept:
                cleaned["words"] = tuple(kept)
            else:
                cleaned.pop("words", None)
        out.append((index, cleaned))
    return tuple(out)


def _without_label_words(words: Sequence[Segment], removed: str) -> tuple[Segment, ...]:
    """`words` with the leading rows that spell `removed` dropped — R2's strip, on the word list.

    Matched on the SPELLING with whitespace and case taken out, because a label can be one row (`CHORUS:`)
    or several (`Verse`, `2:`), and a provider that times its words does not promise a tokenisation. A run
    that diverges from the removed prefix means these rows are not that label, and then nothing is dropped:
    an over-eager match would delete a sung word, which is the failure the whole module is built against.
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

    THE WORD LIST IS WHY THIS EXISTS AS WELL AS `clean_line`. A provider that supplies per-word timings
    (`lrcmux`) puts the same decorations inside `segment["words"]`, and `measure.timed_words` reads
    `word["word"]` in preference to anything else. Cleaning only the line text there would publish a
    clean sentence over a dirty word stream — the screen would read "Gotta get that" while the ball
    walked a `♪` token, which is worse than not cleaning at all.

    DROPPING RENUMBERS NOTHING, which is why it is safe: every consumer of a text's segments enumerates
    the one post-clean sequence (`align_steps` builds `line_texts`, `claimed` and `claim_windows` from
    the same `enumerate(req.text.segments)`), so a removed row cannot shear the pairing the way an
    index taken from a different list would (the F1 lesson in `generate.Line.index`). A caller that does
    hold a parallel list wants `clean_indexed`, which hands back the index each kept row came from.

    `author_marking=False` DROPS NO LINE FOR BEING UNMARKED — `nonlyric`'s R3 left out — and exists for the
    ONE text a person typed themselves (`align_steps.fetch_pinned_text`, W5 review r1-correctness-8). Every
    other caller is a provider's or an upload's track, where the marking is the author's own evidence.
    """
    return tuple(segment for _index, segment in clean_indexed(segments, author_marking=author_marking))
