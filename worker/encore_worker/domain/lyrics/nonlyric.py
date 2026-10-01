"""Which lines of a text are NOT LYRICS — decided by the track's own evidence, never by a word list.

WHY THIS IS A SEPARATE MODULE FROM `clean.py`. `clean_line` removes FORMAT and says so: "Nothing here
judges whether a line is a lyric." That line is still drawn — this module is where the judgement lives,
and it is kept apart because every rule here is ANCHORED (a closed allowlist, a bracket, a colon, the
author's own marking) while `clean.py`'s rejected-ideas list is a list of UNANCHORED rules that each
destroyed real lyrics. Three rules, each with its own counter-example, and one deliberate non-rule.

WHY IT EXISTS AT ALL, and the reason is a CORRECTNESS one before it is an accuracy one (review §3.8 +
PLAN W5). A caption track carries non-lyric cues — `(fabric rustling)`, `(Adele inhaling) (soft piano
music)`, `(somber music)` — and until this module existed nothing on the text side dropped them. They
became CTC targets, were published as words to sing, and were then removed (or not) by the ACOUSTIC
never-sung rule in `steps/align_steps.py`, which measures that nothing was sung in a line's span. That
rule drops DIFFERENT cues under different acoustic models: HuBERT-Large drops `hello`'s `(fabric
rustling)` and `(Adele inhaling)…` and times `(somber music)`; the base bundle does the opposite. So a
song's SCORED LINE COUNT moved with the model (hello 73 -> 72, tfr-chosen 34 -> 33) and no per-song
±500 ms row was comparable across bundles — 2 of hello's 6 'lost' lines at W5's flip were this and not
timing at all. A text-side judgement is model-independent by construction, which is the whole point.

THE RULES.

  R1  WHOLE-LINE SECTION HEADER, from an ALLOWLIST, and only bracketed or with a colon (review M11).
      `[Chorus]`, `(Verse 2)`, `[Verse 1: Eminem]` (Genius names the performer inside the bracket),
      `Verse 2:` as a bare line. Measured on Numb, whose authored captions label 17 of 35 lines: 17 fake
      words, onsets pulled up to ~2.5 s early, bias-corrected ±250 ms 34.3% against 65.7% once cleaned,
      verdict COARSE -> STRUCTURAL. PREVALENCE IS LOW — labels appear in 1 of the 12 authored caption
      tracks — so this is deliberately not elaborate.

  R2  A LEADING `CHORUS:` / `Verse 2:` PREFIX is stripped and THE REST OF THE LINE KEPT (review M11).
      The allowlist is the entire answer to `clean.py`'s rejection of unanchored label stripping: `Baby:
      I love you` and `Mama: don't cry` keep every word, because `baby` and `mama` are not section
      labels and no rule here looks at "a capitalised token before a colon".

  R3  THE AUTHOR'S OWN MARKING, which is the rule that answers the cues. A caption author who writes
      `♪ Hello from the other side ♪` is MARKING THAT LINE AS SUNG; the same author writes `(fabric
      rustling)` with no note. So in a track that notes its sung lines, a line with NO note is not sung
      — and that is the track's own evidence rather than a vocabulary. THE SHARE IS READ OFF THE LINES
      THAT HAVE WORDS, which is `noted_track`'s own docstring (W5 review r1-correctness-1): a bare `♪`
      filler line marks no sung line, so it is evidence about nothing and counts in neither half of the
      ratio. Three of the eight counts below are a line or two smaller read that way (believer 73/73 ->
      72/72, shape-of-you 89/92 -> 88/91, tfr-chosen 36/37 -> 34/35) and THE BAND IS THE SAME, 0.851-1.000,
      because hello sets its floor and hello has no wordless noted line. THE POPULATIONS DO NOT OVERLAP ON
      THE BENCH CORPUS: of 32 songs, 24 note exactly 0.000 of their lines (every Jamendo sheet, numb,
      never-be-alone, tfr-flyaway, tfr-mayday) and 8 note 0.851–1.000 (hello 63/74, feel-my-heart 32/37,
      bohemian-rhapsody 65/74, bad-guy 75/79, shape-of-you 89/92, tfr-chosen 36/37, rap-god 216/217,
      believer 73/73). `NOTED_SHARE` IS THE BOTTOM OF THAT POPULATION (0.8) AND NOT THE MIDDLE OF THE
      EMPTY BAND (0.5, which is what it was until W5 review r2-correctness-1 + r2-spec-7 reproduced two
      real authoring shapes inside 0.5–0.85 that the rule then deleted real sung lines out of — see
      `NOTED_SHARE`, which carries both and the numbers).
      The 34 lines that leave those 8 tracks are 34 for 34 NOT SUNG: all 7 of hello's cues and its
      4 spoken phone-call lines, bohemian-rhapsody's 9 solo annotations, feel-my-heart's 5 music cues,
      shape-of-you's `[RINGING SOUND]` / `[COSTUME RUSTLES]` / `[HE GROANS]`, bad-guy's 3 spoken intro
      lines and `(LAUGHTER)`, rap-god's `("Rap God" by Eminem)` title card, and tfr-chosen's uploader
      credit. 33 of the 34 are THIS rule's: bad-guy's `(LAUGHTER)` is unnoted too, but R4 matches it
      first, which is the only reason it is counted there instead. Over the whole corpus `clean_segments`
      takes the truth texts 1760 -> 1712 — 14 wordless rows as before, and these 34.
      AND IT SPARES WHAT A WORD LIST EATS: shape-of-you's `♪ (Oh-I-oh-I-oh-I-oh-I) ♪` and
      rap-god's `♪ With a straight face, lookin' boy (Ha!) ♪` are noted, so they are lyrics here.

  R4  A YOUTUBE ASR NON-SPEECH MARKER (`[Music]`, `[Applause]`, `[Laughter]`), whole-line and bracketed.
      This is a CLOSED set of MACHINE output, not a human sound-effect vocabulary: an auto-caption track
      has no music notes at all, so R3 cannot reach it, and dQw4w9WgXcQ's rolling track writes `[Music]`
      10 times. Every other bracketed cue in an auto track is left alone.

THE NON-RULE, kept out on purpose: a SOUND-EFFECT VOCABULARY. `clean.py` measured it and it destroys
lyrics — any list that catches `(slow quiet electric guitar)` also catches `(Beat it, beat it)`, `(Play
that funky music)`, `(Drop the beat)`, `(the beat goes on)` and `(bells ringing)`, all sung — and
`(bells ringing)` against `(fabric rustling)` is the same two words in the same shape. R3 separates them
without reading either one. A track that is neither noted nor machine-generated therefore keeps its
parentheticals, and the acoustic never-sung rule remains its only filter; that is a known gap, not an
oversight.

CREDIT LINES ARE NOT A RULE HERE either. The one real credit in the corpus (tfr-chosen's "TheFatRat is
the chosen one, thanks for your awesome work!") is unnoted in a noted track, so R3 already has it, and
`Lyrics by …` on a plain provider sheet has no anchor that a lyric could not also satisfy.

NOT EXPANDED, and deliberately: `[Chorus x2]` is recognised as a header and dropped, but the REPEAT it
asks for is not materialised. The critics found that item's measurement plan circular (PLAN W5), so it
stays deferred — and dropping the label is still strictly better than publishing `Chorus x2` as words.
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

#: R3's floor: the share of a track's WORDED lines that must carry a music note before an UNNOTED line
#: reads as not sung. Measured on the 32-song bench corpus, 24 songs at 0.000 and 8 at 0.8514–1.0000.
#:
#: AT THE BOTTOM OF THE MEASURED POPULATION AND NOT IN THE MIDDLE OF THE EMPTY BAND (W5 review
#: r2-correctness-1 + r2-spec-7). It was 0.5 — the midpoint of a band nothing sits in — and the cost either
#: side of that midpoint is not symmetric: above the population the rule stops firing on tracks it was
#: measured to be right about, below it the rule fires on a shape nobody measured and DELETES real sung
#: lines. Two such shapes were reproduced on the shipped tree and both sit in 0.5–0.85: an author who wraps
#: only the hook/chorus lines and writes the verses plain (11 noted of 20 worded = 0.550, and all 9 verse
#: lines left the text), and the SDH convention of ONE note opening a sung passage and one closing it with
#: the middles bare (8 of 12 = 0.667, and the 4 middle lines left). At 0.8 both are refused, every one of
#: the 8 noted corpus tracks still fires (hello sets the floor at 63/74 = 0.8514, so the head-room is
#: 0.0514), and the unmeasured region is OFF rather than guessed at. Same shape as
#: `claimmap.MIN_INLIER_SHARE`'s derivation; re-measured by `tests/test_nonlyric.py`'s corpus-shape tests.
#:
#: A SEPARATE "REFUSE IF R3 WOULD DROP TOO MUCH" CAP WOULD BE THIS SAME KNOB, which is why there is only
#: one number here. R3 drops exactly the worded lines that carry no note, so its drop share is `1 - the
#: noted share` by construction: a floor of 0.8 IS a cap of 0.200 on the share of worded lines R3 may
#: remove. The corpus's worst case is hello at 11/74 = 0.1486 (7 cues and its 4 spoken phone-call lines),
#: so the cap the floor implies clears the measured maximum by 0.0514 and refuses both shapes above (0.450
#: and 0.333 of their worded lines).
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
    """R1: this whole CLEANED line is a section label from the allowlist.

    Read on the cleaned text, not the raw one, so `♪ [Chorus] ♪` is recognised after `clean_line` has
    taken the notes off.
    """
    stripped = text.strip()
    if not stripped:
        return False
    return bool(_BRACKETED_HEADER.match(stripped) or _COLON_HEADER.match(stripped))


def is_asr_marker(text: str) -> bool:
    """R4: this whole CLEANED line is one of YouTube's ASR non-speech markers."""
    return bool(_BRACKETED_MARKER.match(text.strip()))


def without_section_label(text: str) -> str:
    """R2: `CHORUS: I'm tired of being what you want` -> `I'm tired of being what you want`.

    Identity for every line that is not an allowlisted label followed by a colon — including the cases
    `clean.py` names, `Baby: I love you` and `Mama: don't cry`. Only ONE prefix is stripped: a sheet that
    wrote two is not a shape worth guessing at, and the second would read as the line's first word.
    """
    return _LABEL_PREFIX.sub("", text, count=1)


def noted_track(raw_texts: Sequence[str], cleaned_texts: Sequence[str]) -> bool:
    """R3's precondition: this track marks its SUNG lines with music notes.

    Reads the RAW lines, because `clean_line` removes the very marking this is evidence about — and reads
    only the lines that have WORDS, which is the parallel `cleaned_texts` list's whole job here.

    THE POPULATION IS WORDED LINES AND IT HAS TO BE (W5 review r1-correctness-1). Counting every non-empty
    RAW line let a bare `♪` / `♪♪` decoration line stand as evidence that the track marks its sung lines,
    which is a claim about a line that has no words to sing: the LRC/caption shape that stamps an intro
    and each instrumental break with bare notes and writes its lyrics plain —
    `['♪', '♪♪', <three worded lines>, '♪', '♪', …]` — read as 5 noted of 8, fired R3 on every real lyric
    line, and `clean_segments` returned NOTHING for a text that was entirely sung. A note-only line is
    filler, not a marking.
    THE CORPUS'S READING DOES NOT MOVE, measured rather than argued: dropping a wordless noted line takes it
    out of the numerator and the denominator together, so the 8 noted tracks stay at **0.851–1.000** (the four
    wordless noted lines in the whole corpus are tfr-chosen's two, believer's one and shape-of-you's one:
    36/37 -> 34/35, 73/73 -> 72/72, 89/92 -> 88/91; hello still sets the floor at 63/74) and the 24 unnoted
    ones stay at 0.000. `NOTED_SHARE`'s empty band is therefore still 0.851 wide, and `clean_segments` takes
    the corpus's 32 truth texts 1760 -> **1712** exactly as before — not one served line moves.

    AND A LINE R1/R4 ALREADY ANSWERED IS NOT IN THE POPULATION EITHER, for the same reason a wordless one is
    not (found while raising `NOTED_SHARE`, W5 review r2-correctness-1). A `[Chorus]` label or a `[Music]`
    marker is not a sung line and carries no note, so counting it DILUTES the author's marking with lines
    nobody would mark: a sheet that labels its sections and notes its sung lines reads as less marked than the
    same sheet without labels. Measured on the bench's own `headers` mode, which injects exactly that
    (Genius-style labels, one per section): hello's share falls 0.8514 -> 0.7500, bohemian-rhapsody's 0.8784
    -> 0.7927, feel-my-heart's 0.8649 -> 0.7111 and rap-god's 0.9954 -> 0.9153 — three of the four would stop
    firing at a floor set to the measured population, on a text whose SUNG lines are marked exactly as before.
    Excluding the anchored lines returns every one of those shares to its unlabelled value to the digit, and
    changes nothing on the 32 truth texts (the one anchored-and-unnoted line in the corpus is bad-guy's
    `(LAUGHTER)`, R4's: 65/69 -> 65/68).
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

    `raw_texts` and `cleaned_texts` are parallel and the same length — R3 needs the notes that
    `clean_line` removed, R1/R4 need the line with its format already off. An index whose cleaned text is
    empty is NOT reported: that line carried no words at all and the caller drops it anyway, and counting
    it here would make a note-only track (`♪` lines alone) look unnoted.

    `author_marking=False` LEAVES R3 OUT, and the one caller that asks for it is a person's own PASTE
    (`align_steps.fetch_pinned_text`, W5 review r1-correctness-8). R3 is the only rule here that is not
    per-line: its precondition is read off the WHOLE text, so on a transcript someone copied off a video —
    sung lines wrapped in `♪`, spoken or simply unmarked ones not — it deletes the unmarked lines of a text
    that person TYPED, with no per-line anchor to point at. R1/R2/R4 are anchored and stay: a pasted
    `[Chorus]` is a header wherever it came from.
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
