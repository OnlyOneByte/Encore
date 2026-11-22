"""Which lines are NOT lyrics: the four anchored rules, and every line each one must not touch.

THE SECOND HALF IS AGAIN THE POINT (see `test_clean.py`). `clean.py` rejected three unanchored rules
because each destroyed real sung words, and this module's rules exist only because they are anchored —
an allowlist, a bracket, a colon, the caption author's own music note. So the counter-example tests here
are the whole safety argument: they are the lines a sound-effect vocabulary would have eaten, and the
exact strings `clean.py`'s docstring names as having killed the unanchored forms.

THE CORPUS NUMBERS these pin come from the 32 bench songs' truth files (the caption tracks the YouTube
and tfr halves are scored against) and are stated in `nonlyric`'s docstring; the fixtures below are the
real strings, copied out, so a rule change shows up here without the corpus being present.
"""

from __future__ import annotations

import pytest

from encore_worker.domain.lyrics import clean, nonlyric
from encore_worker.domain.lyrics.clean import clean_indexed, clean_segments
from encore_worker.domain.lyrics.nonlyric import (
    is_asr_marker,
    is_section_header,
    nonlyric_indexes,
    noted_track,
    without_section_label,
)

#: Hello's caption track, lines 0–10 and 73 — the 11 unnoted lines of a 63/74-noted track. Four are the
#: spoken phone-call intro and seven are non-speech cues; none is sung, and the acoustic never-sung rule
#: dropped a DIFFERENT subset of them under each model, which is the denominator artefact.
HELLO_UNNOTED = (
    "- I just got here, and I think I'm loosing signal already.",
    "Hello? Can you hear me now?",
    "(wind buffeting)",
    "Sorry, sorry, I'll call you later.",
    "Yeah, yeah, sorry.",
    "(wind buffeting) (phone clacking)",
    "(lock clicking) (door creaking)",
    "(footsteps echoing)",
    "(fabric rustling)",
    "(Adele inhaling) (soft piano music)",
    "(somber music)",
)

#: Shape of You's two NOTED parentheticals. A sound-effect vocabulary cannot tell these from the cues
#: above — `(Oh-I-oh-I-oh-I-oh-I)` is a whole-line parenthetical in a caption track — and the author can.
SUNG_PARENTHETICALS = (
    "♪ (Oh-I-oh-I-oh-I-oh-I) ♪",
    "♪ Come on, be my baby - (I'm in love with your body) ♪",
    "♪ With a straight face, lookin' boy (Ha!) ♪",
)


# ── R1 + R2: section headers, from an allowlist, anchored ─────────────────────────────────────────


@pytest.mark.parametrize(
    "line",
    [
        "[Chorus]",
        "[chorus]",
        "(Verse 2)",
        "[Verse 2]",
        "[Verse II]",
        "[Pre-Chorus]",
        "[Prechorus]",
        "[Instrumental]",
        "[Outro]",
        "{Bridge}",
        "[Verse 1: Eminem]",
        "[Chorus: Rihanna]",
        "[Chorus x2]",
        "[Chorus 2x]",
        "Verse 2:",
        "CHORUS:",
        "Bridge:",
        "Middle eight:",
    ],
)
def test_a_whole_line_section_label_is_a_header(line: str) -> None:
    assert is_section_header(line)


@pytest.mark.parametrize(
    "line",
    [
        # NOT bracketed and NOT followed by a colon — a word a lyric can be. This is the anchor.
        "Chorus",
        "Hook",
        "Break",
        "Solo",
        "Bridge",
        # Not in the allowlist. The two strings `clean.py` names as killing unanchored label stripping.
        "Baby: I love you",
        "Mama: don't cry",
        "[Люблю тебя]",
        "[GO!]",
        "[OH YEAH]",
        # A label with real words after it inside the bracket is not a whole-line header.
        "[Chorus] I've become so numb",
        # A sentence that merely contains a label word.
        "(Drop the beat)",
        "(the beat goes on)",
        "Sing the chorus with me:",
        "",
        "   ",
    ],
)
def test_what_is_not_a_header(line: str) -> None:
    assert not is_section_header(line)


def test_the_label_prefix_is_stripped_and_the_lyric_kept() -> None:
    """The measured case: Numb's authored captions label 17 of 35 lines `CHORUS: `, which became
    17 fake words with onsets up to ~2.5 s early (bias-corrected ±250 ms 34.3% against 65.7% cleaned)."""
    assert without_section_label("CHORUS: I've become so numb") == "I've become so numb"
    assert without_section_label("CHORUS:  Become so tired") == "Become so tired"
    assert without_section_label("Verse 2: Tired of being what you want") == "Tired of being what you want"


@pytest.mark.parametrize(
    "line",
    [
        "Baby: I love you",
        "Mama: don't cry",
        "Tired of being what you want me to be",
        "Hello? Can you hear me now?",
        "Chorus of angels sing",
    ],
)
def test_a_line_that_is_not_an_allowlisted_label_keeps_every_word(line: str) -> None:
    """The allowlist IS the answer to `clean.py`'s rejection of "a capitalised token before a colon"."""
    assert without_section_label(line) == line


def test_only_one_prefix_is_stripped() -> None:
    """A sheet that wrote two is not a shape worth guessing at, and the second reads as a first word."""
    assert without_section_label("CHORUS: Verse 2: words") == "Verse 2: words"


# ── R3: the author's own music-note marking ──────────────────────────────────────────────────────


def noted(lines: list[str]) -> bool:
    """`noted_track` with the parallel cleaned population it reads the convention off."""
    return noted_track(lines, [clean.clean_line(line) for line in lines])


def test_a_track_that_notes_its_sung_lines_is_recognised_as_one() -> None:
    assert noted(["♪ one ♪", "♪ two ♪", "♪ three ♪", "♪ four ♪", "(somber music)"])


@pytest.mark.parametrize(
    "lines",
    [
        # Every Jamendo sheet, numb, never-be-alone, tfr-flyaway and tfr-mayday: 0.000 noted.
        ["plain", "lyric", "sheet", "with", "no", "notes"],
        # Under NOTED_MIN_LINES: one note in a three-line snippet is not a convention.
        ["♪ one ♪", "two", "three"],
        # Under NOTED_SHARE even with enough noted lines.
        ["♪ a ♪", "♪ b ♪", "♪ c ♪", "♪ d ♪", "e", "f", "g", "h", "i"],
        # 0.750, just under the floor: the shape a track one unnoted line away from firing has.
        ["♪ a ♪", "♪ b ♪", "♪ c ♪", "♪ d ♪", "♪ e ♪", "♪ f ♪", "g", "h"],
        [],
    ],
)
def test_a_track_that_does_not_mark_its_lyrics_is_not_one(lines: list[str]) -> None:
    assert not noted(lines)


# ── the convention is read off the lines that have WORDS ──────────────────────────────────────────

#: The LRC/caption shape that stamps its intro and each instrumental break with bare notes and writes its
#: lyrics plain. Three sung lines, five decorations — a very common provider-sheet convention.
NOTE_FILLED = ["♪", "♪♪", "aaa bbb ccc", "ddd eee fff", "♪", "♪", "ggg hhh iii", "♪♪♪"]


def test_a_track_whose_only_notes_are_wordless_filler_is_not_a_noted_track() -> None:
    """Counting every non-empty RAW line read 5 noted of 8 — so R3 fired, and `clean_segments` returned
    NOTHING for a text that was entirely sung. A bare `♪` marks no sung line, so it is evidence about
    nothing and counts in neither half of the ratio."""
    assert not noted(NOTE_FILLED)


def test_every_lyric_line_of_such_a_track_survives() -> None:
    """The harm, end to end: all three lyric lines were judged not-sung and the whole text disappeared."""
    cleaned = [clean.clean_line(line) for line in NOTE_FILLED]
    assert nonlyric_indexes(NOTE_FILLED, cleaned) == frozenset()
    assert [str(segment["text"]) for segment in clean.clean_segments([{"text": t} for t in NOTE_FILLED])] == [
        "aaa bbb ccc",
        "ddd eee fff",
        "ggg hhh iii",
    ]


def test_removing_a_wordless_noted_line_does_not_unmake_a_noted_track() -> None:
    """tfr-chosen is the only corpus track with bare-`♪` lines at all: 36/37 noted becomes 34/35, which is
    still far above `NOTED_SHARE`, because the line leaves the numerator and the denominator together."""
    raw = ["♪", *[f"♪ sung line {n} ♪" for n in range(34)], "♪", "an uploader credit"]
    assert noted(raw)
    assert nonlyric_indexes(raw, [clean.clean_line(line) for line in raw]) == frozenset({len(raw) - 1})


def test_r3_can_be_left_out_for_a_text_a_person_typed() -> None:
    """`author_marking=False`: the pin path's paste keeps its unmarked lines, and the
    ANCHORED rules still apply to it. Nine noted lines of eleven worded ones (0.818) so the track is over
    `NOTED_SHARE` and R3 really is the rule being switched off here."""
    raw = ["[Chorus]", *[f"♪ sung line {n} ♪" for n in range(9)], "a spoken aside"]
    cleaned = [clean.clean_line(line) for line in raw]
    assert nonlyric_indexes(raw, cleaned) == frozenset({0, 10}), "R3 drops the unmarked line by default"
    assert nonlyric_indexes(raw, cleaned, author_marking=False) == frozenset({0})


def test_the_floor_sits_at_the_bottom_of_the_measured_population() -> None:
    """24 of the 32 bench songs note 0.000 of their lines and 8 note 0.8514–1.0000, so the floor has a whole
    empty band to sit in — and it sits at the BOTTOM of the population rather than in the middle of the band
    (the two tests below). Tightening it past 0.8514 stops the rule
    firing on hello (63/74) and the denominator artefact comes back; loosening it below 0.8 re-admits the
    partially-marked shapes, where the rule deletes real sung lines."""
    assert 0.8 <= nonlyric.NOTED_SHARE < 0.8514


# ── the shapes that live in the unmeasured 0.5–0.85 region ──────────────────────────────────────────────


def test_a_track_that_marks_only_its_hook_keeps_its_unmarked_verses() -> None:
    """The hook-only reproduction: an author who wraps the 11 hook lines in notes and writes the 9
    verse lines plain. 11/20 = 0.550 — over the old 0.5 floor, so R3 fired and `clean_segments` returned 11
    segments for a 20-line text, every one of the 9 real sung verse lines gone with no per-line anchor."""
    raw = [*[f"♪ hook line {n} ♪" for n in range(11)], *[f"verse line {n}" for n in range(9)]]
    cleaned = [clean.clean_line(line) for line in raw]
    assert not noted(raw), "11/20 = 0.550 is inside the region nobody measured"
    assert nonlyric_indexes(raw, cleaned) == frozenset()
    assert len(clean.clean_segments([{"text": text} for text in raw])) == 20


def test_a_note_bracketing_a_passage_keeps_the_middle_lines() -> None:
    """The bracketing reproduction: the SDH convention of one note OPENING a sung passage and one CLOSING it,
    middles bare — 4 passages x 3 lines, 8 noted of 12 = 0.667, and R3 dropped the 4 middle lines (12
    served in, 8 out). The loss is text-side, so no acoustic rule can put those lines back."""
    raw = [line for group in range(4) for line in (f"♪ open {group}", f"middle {group}", f"close {group} ♪")]
    cleaned = [clean.clean_line(line) for line in raw]
    assert not noted(raw), "8/12 = 0.667 is inside the region nobody measured"
    assert nonlyric_indexes(raw, cleaned) == frozenset()
    assert len(clean.clean_segments([{"text": text} for text in raw])) == 12


def test_a_noted_tracks_own_section_labels_do_not_dilute_its_marking() -> None:
    """Found while raising the floor: a `[Chorus]` label is not a sung line and
    carries no note, so counting it in R3's population made a LABELLED sheet read as less marked than the same
    sheet without labels. Measured on the bench's `headers` mode, which injects one label per section: hello's
    share fell 0.8514 -> 0.7500, bohemian-rhapsody's 0.8784 -> 0.7927, feel-my-heart's 0.8649 -> 0.7111 — the
    author's marking unchanged in every case. R1's and R4's lines leave the ratio, like a wordless one."""
    sung = [f"♪ sung line {n} ♪" for n in range(9)]
    labelled = ["[Chorus]", *sung[:4], "[Verse 2]", *sung[4:], "[Music]", "a spoken aside"]

    assert noted(labelled), "9 noted of 10 lines that could be marked — the labels are not in the ratio"
    assert noted([*sung, "a spoken aside"]), "and the same sheet without the labels reads the same way"
    cleaned = [clean.clean_line(line) for line in labelled]
    dropped = nonlyric_indexes(labelled, cleaned)
    assert dropped == frozenset({0, 5, 11, 12}), "both labels, the ASR marker and the unnoted aside"


def test_the_eight_noted_corpus_tracks_still_fire_at_the_new_floor() -> None:
    """The other half of the raise, as the shape of each measured track rather than as a comment: the 8
    noted bench songs read 0.8514 (hello 63/74), 0.8649, 0.8784, 0.9420, 0.9670, 0.9714, 0.9954 and 1.0000
    on `clean_line`'s worded population, and every one of them is still a noted track at 0.8."""
    for noted_lines, worded in (
        (63, 74),
        (32, 37),
        (65, 74),
        (65, 69),
        (88, 91),
        (34, 35),
        (216, 217),
        (72, 72),
    ):
        raw = [
            *[f"♪ sung line {n} ♪" for n in range(noted_lines)],
            *[f"unnoted line {n}" for n in range(worded - noted_lines)],
        ]
        assert noted(raw), f"{noted_lines}/{worded} is a measured corpus track and must still fire"


def test_an_unnoted_line_in_a_noted_track_is_not_sung() -> None:
    """Hello: all 11 of its unnoted lines, which are its 7 non-speech cues and its 4 spoken intro lines."""
    raw = [*HELLO_UNNOTED, *[f"♪ sung line {n} ♪" for n in range(63)]]
    cleaned = [clean.clean_line(line) for line in raw]
    dropped = nonlyric_indexes(raw, cleaned)
    assert dropped == frozenset(range(len(HELLO_UNNOTED)))


@pytest.mark.parametrize("line", SUNG_PARENTHETICALS)
def test_a_noted_parenthetical_is_a_lyric(line: str) -> None:
    """The exhibit for why the rule reads the AUTHOR and not the words: these are whole-line and mid-line
    parentheticals in caption tracks, indistinguishable from `(fabric rustling)` to any vocabulary."""
    raw = [line, *[f"♪ sung line {n} ♪" for n in range(8)]]
    cleaned = [clean.clean_line(text) for text in raw]
    assert nonlyric_indexes(raw, cleaned) == frozenset()


@pytest.mark.parametrize(
    "line",
    [
        "(Beat it, beat it)",
        "(Play that funky music)",
        "(Drop the beat)",
        "(the beat goes on)",
        "(bells ringing)",
        "(gentle piano solo)",
        "[RINGING SOUND]",
    ],
)
def test_an_unnoted_track_keeps_its_parentheticals_including_the_ones_a_vocabulary_would_eat(
    line: str,
) -> None:
    """`(bells ringing)` and `(fabric rustling)` are the same two words in the same shape, and the first is
    sung. With no note convention to read, this module says nothing and the AUDIO decides (the never-sung
    rule in `steps/align_steps.py`) — a known gap, stated in the module docstring, not an oversight."""
    raw = [line, *[f"plain line {n}" for n in range(8)]]
    cleaned = [clean.clean_line(text) for text in raw]
    assert nonlyric_indexes(raw, cleaned) == frozenset()


def test_a_note_only_line_does_not_make_a_track_look_unnoted() -> None:
    """tfr-chosen's lines 0 and 14 are a bare `♪`. They clean to nothing and are dropped for carrying no
    word; counting them as unnoted LYRICS would be counting them twice."""
    raw = ["♪", "♪ Greetings Chosen ♪", "♪ sung ♪", "♪ more ♪", "♪ and more ♪", "a credit line"]
    cleaned = [clean.clean_line(text) for text in raw]
    assert nonlyric_indexes(raw, cleaned) == frozenset({5})


# ── R4: YouTube's ASR non-speech markers ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("line", ["[Music]", "[music]", "[Applause]", "[Laughter]", "(Music)"])
def test_the_asr_markers_are_recognised(line: str) -> None:
    assert is_asr_marker(line)


@pytest.mark.parametrize(
    "line",
    ["[Music of the night]", "Music", "[somber music]", "(soft piano music)", "[Laughter and tears]"],
)
def test_nothing_but_the_closed_machine_set_is_an_asr_marker(line: str) -> None:
    """A CLOSED set of machine output is the only reason a vocabulary is allowed here at all. The moment it
    grows a human's sound-effect words it becomes the rule `clean.py` measured and refused."""
    assert not is_asr_marker(line)


def test_an_auto_caption_track_loses_its_music_markers_with_no_note_convention_to_read() -> None:
    """dQw4w9WgXcQ's rolling track writes `[Music]` 10 times and carries no music note at all, so R3
    cannot reach it — which is exactly why R4 exists."""
    got = clean_segments(
        [
            {"text": "[Music]", "start": 0.3, "end": 18.8},
            {"text": "We're no strangers to", "start": 18.8, "end": 21.8},
        ]
    )
    assert [s["text"] for s in got] == ["We're no strangers to"]


# ── through `clean_segments`, which is what every text adapter returns ────────────────────────────


def test_the_kept_index_is_published_rather_than_reconstructible() -> None:
    """`clean_indexed` exists because the rules are not all per-line: `noted_track` reads the whole track,
    so a caller re-deriving the kept set with `clean_line` alone (which the bench's `served_claims` did)
    would disagree with what the adapters serve."""
    segments = [
        {"text": "♪ first ♪", "start": 1.0},
        {"text": "(wind buffeting)", "start": 2.0},
        {"text": "♪ [Chorus] ♪", "start": 3.0},
        {"text": "♪ CHORUS: second ♪", "start": 4.0},
        {"text": "♪", "start": 5.0},
        {"text": "♪ third ♪", "start": 6.0},
        {"text": "♪ fourth ♪", "start": 7.0},
    ]
    indexed = clean_indexed(segments)
    assert [index for index, _segment in indexed] == [0, 3, 5, 6]
    assert [segment["text"] for _index, segment in indexed] == ["first", "second", "third", "fourth"]
    assert tuple(segment for _index, segment in indexed) == clean_segments(segments)


def test_dropping_renumbers_nothing_and_every_other_field_survives() -> None:
    got = clean_segments(
        [
            {"text": "♪ a ♪", "start": 1.0, "end": 2.0, "part": "lead"},
            {"text": "(somber music)", "start": 2.0, "end": 3.0},
            {"text": "♪ b ♪", "start": 3.0, "end": 4.0},
            {"text": "♪ c ♪", "start": 4.0, "end": 5.0},
            {"text": "♪ d ♪", "start": 5.0, "end": 6.0},
        ]
    )
    assert [s["text"] for s in got] == ["a", "b", "c", "d"]
    assert got[0] == {"text": "a", "start": 1.0, "end": 2.0, "part": "lead"}
