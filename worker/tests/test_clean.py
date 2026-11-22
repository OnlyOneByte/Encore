"""Caption/LRC text cleanup: the format it removes, and the lyrics it must never touch.

THE SECOND HALF IS THE POINT. Every rule here was pushed back on by an adversarial pass over real
corpora, and the rules that got deleted were deleted because they destroyed real sung words. So the
`must_not_change` tests below are not padding — each one is a counterexample that killed a proposed
rule, and re-adding that rule turns the test red.

Real-audio evidence lives in the caption corpora (`$ENCORE_BENCH_ROOT`, not committed); these tests
are hermetic and pin the behaviour those corpora measured.
"""

from __future__ import annotations

import pytest

from encore_worker.domain.lyrics.clean import clean_line, clean_segments

#: The line the television actually drew, byte for byte, from the `--write-auto-subs` track for
#: The Black Eyed Peas — "Boom Boom Pow". The whole module exists because of this string.
SCREENSHOT = "- ♪♪ Gotta get that ♪♪ <i>- ♪♪ Boom boom boom ♪♪</i>"


# ── the bug ──────────────────────────────────────────────────────────────────────────────────────


def test_the_screenshot_line_becomes_singable_words() -> None:
    """Tags, doubled notes and the leading speaker dash all go; the interior dash STAYS, because it
    separates the two simultaneous vocal parts the cue welded together and dropping it would run two
    singers' words into one sentence."""
    assert clean_line(SCREENSHOT) == "Gotta get that - Boom boom boom"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("<i>♪♪ Gotta get that ♪♪</i>", "Gotta get that"),
        ("<i>♪♪ Boom boom boom ♪♪♪</i>", "Boom boom boom"),
        # The closer glued to the last word — why notes become a space rather than nothing.
        ("♪♪ Gotta get that-- that♪♪", "Gotta get that-- that"),
        ("♪ Is this the real life ♪", "Is this the real life"),
        # A cue that is ONLY decoration carries no words at all.
        ("[♪♪♪]", ""),
        ("♪♪", ""),
        ("- ♪ -", ""),
    ],
)
def test_markup_and_note_decoration_is_removed(raw: str, expected: str) -> None:
    assert clean_line(raw) == expected


def test_escaped_markup_is_decoded_before_it_is_stripped() -> None:
    """MEASURED ORDER BUG. One authored track (Despacito's English captions) is 89% ESCAPED markup, so a
    tag strip that runs before the entity decode leaves `<i>` visible on the television."""
    assert clean_line("&lt;i&gt;Ooh, oh, no, oh, no, oh&lt;/i&gt;") == "Ooh, oh, no, oh, no, oh"
    assert clean_line("&lt;i&gt;the metal,&lt;/i&gt;") == "the metal,"


def test_an_asr_roll_up_cue_loses_its_per_word_timestamp_spans() -> None:
    """The automatic caption tier times every word inline; unstripped, a whole line reads as digits."""
    raw = "The club isn't the best place,<00:00:18.320><c> so</c><00:00:18.480><c> the</c>"
    assert clean_line(raw) == "The club isn't the best place, so the"


def test_ruby_annotations_are_excised_not_unwrapped() -> None:
    """Ruby markup is base text PLUS a pronunciation guide. Unwrapping keeps both, so the karaoke ball
    sings every kanji twice ('君 きみ の 名 な は'). And markup becomes nothing rather than a space, or
    CJK would be broken apart into '君 の 名 は'."""
    assert clean_line("<ruby>君<rt>きみ</rt></ruby>の<ruby>名<rt>な</rt></ruby>は") == "君の名は"


def test_cleaning_is_idempotent() -> None:
    """The cheap property that catches an ordering mistake with no corpus at all — it is what failed
    first when the speaker-dash rule was anchored at `^-` instead of `^\\s*-`."""
    for raw in [SCREENSHOT, "<i>- ♪♪ Boom ♪♪</i>", "&lt;i&gt;x&lt;/i&gt;", "♪ a ♪", "- b", "[♪♪♪]"]:
        once = clean_line(raw)
        assert clean_line(once) == once, raw


# ── what must survive: each entry killed a proposed rule ─────────────────────────────────────────


@pytest.mark.parametrize(
    "lyric",
    [
        # Whole-line parentheses are FREQUENTLY the backing vocal itself (Shape of You sings both).
        "(Oh-I-oh-I-oh-I-oh-I)",
        "(I'm in love with your body)",
        # A sound-effect VOCABULARY cannot be written without catching these — all sung.
        "(Beat it, beat it)",
        "(Play that funky music)",
        "(Drop the beat)",
        "(the beat goes on)",
        "(bells ringing)",
        "(London Bridge is falling down)",
        # ...so the genuinely-not-sung ones stay too. The ALIGN step drops these by measuring the audio
        # (the never-sung rule), which is strictly better evidence than any word list.
        "(gentle piano solo)",
        "[RINGING SOUND]",
        "(somber music)",
        # "No lowercase" is an ASCII test, so it deletes every caseless script.
        "[Люблю тебя]",
        "[私の心は燃えている]",
        "[사랑해요]",
        # Bracketed ad-libs go the same way.
        "[GO!]",
        "[HEY!]",
        "[OH YEAH]",
        # A capitalised token before a colon is often a real first word, not a speaker label.
        "Baby: I love you",
        "Mama: don't cry",
        "CHORUS: I've become so numb",
        # A tag-name allowlist without an ATTRIBUTE restriction eats these.
        "a<b and c>d",
        "<u and me> forever",
        "<b my baby> hold on",
        "<c u later> alligator",
        # Punctuation that looks like markup or a censor bar.
        "--- censored ---",
        "I <3 you",
        "Oh-I-oh-I",
        "9 to 5",
        # Non-Latin scripts pass through untouched.
        "こんにちは世界",
        "Привет мир",
        "Σ' αγαπώ",
    ],
)
def test_real_lyrics_are_never_changed(lyric: str) -> None:
    assert clean_line(lyric) == lyric


def test_a_bidi_mark_survives_because_an_rtl_lyric_needs_it_to_render() -> None:
    """Zero-width characters are stripped, but NOT the bidi marks or ZWNJ/ZWJ: those are orthography in
    Arabic, Hebrew and Indic scripts, and removing them mis-renders the line."""
    assert clean_line("‏שלום") == "‏שלום"
    assert clean_line("‌زبان") == "‌زبان"
    # A genuine zero-width space carries nothing and goes.
    assert clean_line("he​llo") == "hello"


# ── segments, and the word list that must move with them ─────────────────────────────────────────


def test_the_word_list_is_cleaned_IN_LOCKSTEP_with_the_line() -> None:
    """THE lrcmux CASE. It is the only provider that supplies per-word timings, and `measure.timed_words`
    reads `word["word"]` first — so cleaning only the line text would light a `♪` token on the ball while
    the screen read the sentence. Worse than not cleaning at all."""
    got = clean_segments(
        [
            {
                "text": "<i>♪♪ Gotta get that ♪♪</i>",
                "start": 7.7,
                "words": (
                    {"word": "♪♪", "start": 7.7, "end": 7.8},
                    {"word": "<i>Gotta", "start": 7.9, "end": 8.1},
                    {"word": "get", "start": 8.2, "end": 8.4},
                    {"word": "that</i>", "start": 8.5, "end": 9.4},
                ),
            }
        ]
    )
    assert len(got) == 1
    assert got[0]["text"] == "Gotta get that"
    words = got[0]["words"]
    assert isinstance(words, tuple)
    assert [w["word"] for w in words] == ["Gotta", "get", "that"]
    # Timings are untouched — this module removes text, never moves a clock.
    assert [w["start"] for w in words] == [7.9, 8.2, 8.5]


def test_the_section_label_leaves_the_word_list_with_the_line() -> None:
    """R2 strips the label off the TEXT; `clean_line` has no label rule, so the
    word rows kept it — three words on screen over a four-word stream, offset by one, with the ball's first
    row spelling a word the published line does not contain. The exact state this module calls worse than
    not cleaning at all."""
    got = clean_segments(
        [
            {
                "text": "CHORUS: aaa bbb ccc",
                "start": 10.0,
                "words": (
                    {"word": "CHORUS:", "start": 10.0, "end": 10.3},
                    {"word": "aaa", "start": 10.3, "end": 10.6},
                    {"word": "bbb", "start": 10.6, "end": 10.9},
                    {"word": "ccc", "start": 10.9, "end": 11.4},
                ),
            }
        ]
    )
    assert got[0]["text"] == "aaa bbb ccc"
    words = got[0]["words"]
    assert isinstance(words, tuple)
    assert [w["word"] for w in words] == ["aaa", "bbb", "ccc"]
    assert [w["start"] for w in words] == [10.3, 10.6, 10.9], "the kept words keep their own timings"


def test_a_label_split_over_two_word_rows_goes_whole() -> None:
    """A provider that times its words does not promise a tokenisation, so the match is on the SPELLING."""
    got = clean_segments(
        [
            {
                "text": "Verse 2: aaa bbb",
                "words": (
                    {"word": "Verse", "start": 1.0},
                    {"word": "2:", "start": 1.2},
                    {"word": "aaa", "start": 1.4},
                    {"word": "bbb", "start": 1.6},
                ),
            }
        ]
    )
    assert got[0]["text"] == "aaa bbb"
    words = got[0]["words"]
    assert isinstance(words, tuple)
    assert [w["word"] for w in words] == ["aaa", "bbb"]


def test_word_rows_that_do_not_spell_the_removed_label_are_left_whole() -> None:
    """Dropping by COUNT would delete a sung word here. Nothing is dropped instead, which is the behaviour
    this had before the label strip existed at all."""
    got = clean_segments(
        [
            {
                "text": "CHORUS: aaa bbb",
                "words": ({"word": "aaa", "start": 1.0}, {"word": "bbb", "start": 1.2}),
            }
        ]
    )
    assert got[0]["text"] == "aaa bbb"
    words = got[0]["words"]
    assert isinstance(words, tuple)
    assert [w["word"] for w in words] == ["aaa", "bbb"]


def test_a_word_list_of_pure_decoration_is_removed_rather_than_left_disagreeing() -> None:
    got = clean_segments([{"text": "♪ real words ♪", "words": ({"word": "♪", "start": 1.0},)}])
    assert got[0]["text"] == "real words"
    assert "words" not in got[0], "a word list that survived nothing must not claim to time the line"


def test_a_wordless_segment_is_dropped_and_the_rest_keep_their_order() -> None:
    got = clean_segments(
        [
            {"text": "♪ first line ♪", "start": 1.0},
            {"text": "[♪♪♪]", "start": 2.0},
            {"text": "<i>second line</i>", "start": 3.0},
        ]
    )
    assert [s["text"] for s in got] == ["first line", "second line"]
    assert [s["start"] for s in got] == [1.0, 3.0]


def test_every_other_field_on_a_segment_is_carried_through_untouched() -> None:
    got = clean_segments([{"text": "♪ hi ♪", "start": 1.0, "end": 2.0, "part": "b"}])
    assert got[0] == {"text": "hi", "start": 1.0, "end": 2.0, "part": "b"}


def test_an_empty_input_yields_an_empty_result_rather_than_raising() -> None:
    assert clean_segments([]) == ()
    assert clean_segments([{"text": ""}, {"text": "♪"}, {}]) == ()
    assert clean_line("") == ""
