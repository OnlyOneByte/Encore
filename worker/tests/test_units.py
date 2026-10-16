"""Script-aware units (W8 stage 1) and the romanised target sequence (stage 2), hermetic.

Four properties carry this module: the units CONCATENATE to the text, a Latin text is untouched by every
arm, the unit arm changes how spans are GROUPED and not which targets are decoded, and a romanised or
t2s-folded target still names the GRAPHEME it came from (XA-20). The numbers are in
docs/benchmarks/forced-alignment/README.md, "W8 stages 1-2".
"""

from __future__ import annotations

from collections.abc import Sequence

import pytest

from encore_worker.domain.lyrics import romanize, syllabify, units
from encore_worker.domain.lyrics.generate import char_targets, generate
from tests.test_generate import FakeEmissions, evenly, scripted_decoder

#: SYNTHETIC lines, never a sheet's: the corpus is commercial music and no lyric text is committed to this
#: tree (docs/benchmarks/forced-alignment/README.md, "Why no fixture holds a lyric").
ZH = "山水风云雨雪"
JA = "山の上に雲が流れる"
#: An ALL-KANA line, whose tokens read mora by mora where `JA`'s kanji token does not.
JA_KANA = "ひらがなのれんしゅう"
KO = "바다 하늘 구름들"
EN = "the quick brown fox isn't jumping"

#: A Traditional line whose characters the simplified-only zh-cn vocabulary does not hold — the review's
#: 69%-covered case, which `zh-simplify` exists for.
TRADITIONAL = "學習愛情與時間"

fugashi_installed = units._fugashi() is not None
opencc_installed = units._opencc() is not None
pypinyin_installed = romanize.build_transliterator("zh") is not None
cutlet_installed = romanize.build_transliterator("ja") is not None


def han_dictionary(texts: Sequence[str]) -> dict[str, int]:
    """A toy vocabulary holding every character of `texts`, 0 left as CTC's blank."""
    seen = sorted({ch for text in texts for ch in text if ch.strip()})
    return {ch: index + 1 for index, ch in enumerate(seen)}


# ── the units themselves ──────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("language_code", "text", "expected"),
    [
        ("zh", ZH, list(ZH)),
        ("zh", "我爱you 好", ["我", "爱", "you", "好"]),
        ("ko", KO, KO.split()),
        ("en", EN, EN.split()),
        ("fr", "allez viens", ["allez", "viens"]),
    ],
)
def test_words_are_the_scripts_own(language_code: str, text: str, expected: list[str]) -> None:
    """One word per hanzi; a Latin RUN inside a Chinese line stays one word; Korean keeps its spaces.

    Korean is the one deviation from the review's "one word per Hangul block": the TV joins Hangul words
    with a space (docs/arch/04-alignment.md §11.2), so per-block words would publish `오 빤` where the
    sheet wrote `오빤`.
    """
    assert units.words(text, language_code) == expected


def test_japanese_words_are_morphological_or_mora() -> None:
    """fugashi's surface forms where it is installed, the mora rule where it is not — same text either."""
    got = units.words(JA, "ja")
    assert "".join(got) == JA
    if fugashi_installed:
        assert got == ["山", "の", "上", "に", "雲", "が", "流れる"]
    else:
        assert got[:3] == ["山", "の", "上"]


@pytest.mark.parametrize(
    ("language_code", "word", "expected"),
    [
        ("zh", "故事", ["故", "事"]),
        ("ja", "きょうっと", ["きょ", "う", "っ", "と"]),
        ("ja", "沈む", ["沈", "む"]),
        ("ko", "스타일", ["스", "타", "일"]),
    ],
)
def test_syllables_are_hanzi_mora_or_hangul_block(language_code: str, word: str, expected: list[str]) -> None:
    """A small kana and a prolonged mark attach to the mora before them, having no onset of their own."""
    assert units.syllables(word, language_code) == expected


def test_a_latin_word_in_a_cjk_line_keeps_the_latin_syllabifier() -> None:
    """The script rule abstains on a word of nobody's dense script rather than answering one fragment.

    `syllabify`'s own LANGUAGE ladder then applies, which off English is pyphen or vowel groups — so this
    is `som|eth|ing` and not CMUdict's `some|thing`.
    """
    assert units.syllables("something", "zh") == syllabify.syllables("something", "zh")
    assert len(units.syllables("something", "zh")) > 1


@pytest.mark.parametrize("language_code", ["zh", "ja", "ko"])
@pytest.mark.parametrize("text", [ZH, JA, KO, EN, "♪", "（间奏）", "我爱you 好", TRADITIONAL])
def test_units_concatenate_to_the_text(language_code: str, text: str) -> None:
    """The invariant the TV's rebuild rests on: the units are the text's own characters, in order, with its
    whitespace taken out — so `wordGap` can put the spacing back (docs/arch/04-alignment.md §11.2)."""
    got = units.words(text, language_code)
    assert "".join(got) == "".join(text.split())
    assert all(got) and not any(word.strip() != word for word in got)
    for word in got:
        assert "".join(units.syllables(word, language_code)) == word


# ── the arms, and what they may not move ──────────────────────────────────────────────────────────


def test_a_latin_language_gets_the_plain_rule_under_every_arm() -> None:
    """ENGLISH CANNOT MOVE, by construction and not by measurement: no arm has a rule for a Latin
    language, so `rules` hands back the whitespace rule every recorded row was measured on."""
    for language_code in ("en", "fr", "nn"):
        rules = units.rules(language_code, script_units=True, simplify=True, transliterate=True)
        assert rules.name == "plain"
        assert rules.words is str.split
        assert rules.chars is None and rules.fold is None


def test_the_unit_arm_regroups_spans_and_decodes_the_same_targets() -> None:
    """Stage 1 is a GROUPING change: one hanzi per word gives the same target sequence as one word per
    line, so no onset can move — only which word each span belongs to."""
    emissions = FakeEmissions(log_probs=[0] * 60, frame_sec=0.02, dictionary=han_dictionary([ZH]))
    rules = units.rules("zh", script_units=True, simplify=False, transliterate=False)
    plain = char_targets([ZH], emissions)
    armed = char_targets([ZH], emissions, units=rules)
    assert armed.targets == plain.targets
    assert plain.words_by_line == ((ZH,),), "the whitespace rule reads a Chinese line as ONE word"
    assert armed.words_by_line == ((*ZH,),)
    assert [owner[1] for owner in armed.owners] == list(range(len(ZH)))
    assert [owner[1] for owner in plain.owners] == [0] * len(ZH)


def test_the_unit_arm_publishes_one_word_per_hanzi() -> None:
    """What the capability IS: a Chinese line reaches the TV with a span per character rather than one span
    for the whole line."""
    emissions = FakeEmissions(log_probs=[0] * 60, frame_sec=0.02, dictionary=han_dictionary([ZH]))
    decoder = scripted_decoder(evenly(len(ZH)), 60)
    rules = units.rules("zh", script_units=True, simplify=False, transliterate=False)
    got = generate([ZH], emissions, decoder=decoder, language="zh", units=rules)
    plain = generate([ZH], emissions, decoder=decoder, language="zh")
    assert [word.word for word in got.lines[0].words] == list(ZH)
    assert [word.word for word in plain.lines[0].words] == [ZH]
    assert got.lines[0].start == plain.lines[0].start, "the same spans, grouped differently"
    assert got.lines[0].end == plain.lines[0].end
    assert all(word.start <= word.end for word in got.lines[0].words)
    assert [word.start for word in got.lines[0].words] == sorted(word.start for word in got.lines[0].words)


@pytest.mark.skipif(not opencc_installed, reason="the `nonlatin` extra is not installed")
def test_the_t2s_fold_reaches_a_simplified_only_vocabulary() -> None:
    """A Traditional character the zh-cn vocabulary lacks becomes a target through its Simplified form, and
    a character the vocabulary HOLDS is never folded."""
    simplified_only = han_dictionary(["学习爱情与时间"])
    emissions = FakeEmissions(log_probs=[0] * 80, frame_sec=0.02, dictionary=simplified_only)
    rules = units.rules("zh", script_units=True, simplify=True, transliterate=False)
    unfolded = char_targets([TRADITIONAL], emissions)
    assert len(unfolded.targets) == 1, "only 情, which Traditional and Simplified spell alike"
    folded = char_targets([TRADITIONAL], emissions, units=rules)
    assert len(folded.targets) == len(TRADITIONAL)
    assert [owner[1] for owner in folded.owners] == list(range(len(TRADITIONAL)))
    assert units.simplified("爱") == "爱", "a Simplified character is its own fold"


def test_the_t2s_fold_degrades_rather_than_raising() -> None:
    """Without the extra the fold is the identity, which is the configuration every recorded row was
    measured on — and `simplified` may not raise inside a pure decode either way."""
    assert units.simplified("x") == "x"
    assert units.simplified("") == ""


@pytest.mark.skipif(not pypinyin_installed, reason="the `romanize` extra is not installed")
def test_a_romanised_target_still_names_its_grapheme() -> None:
    """Stage 2's mapping back (XA-20): each pinyin letter carries the index of the hanzi it came from, so a
    span groups into that character's syllable and the published text is never romanised."""
    roman = units.rules("zh", script_units=True, simplify=False, transliterate=True)
    assert roman.chars is not None
    spelled = list(roman.chars("花"))
    assert [ch for _at, ch in spelled] == list("hua")
    assert {at for at, _ch in spelled} == {0}

    latin = han_dictionary(["abcdefghijklmnopqrstuvwxyz"])
    emissions = FakeEmissions(log_probs=[0] * 400, frame_sec=0.02, dictionary=latin)
    flat = char_targets([ZH], emissions, units=roman)
    assert len(flat.targets) > len(ZH), "every hanzi became several Latin targets"
    assert flat.words_by_line == ((*ZH,),)
    decoder = scripted_decoder(evenly(len(flat.targets)), 400)
    got = generate([ZH], emissions, decoder=decoder, language="zh", units=roman)
    assert [word.word for word in got.lines[0].words] == list(ZH), "the TEXT is never romanised"
    assert all(word.start < word.end for word in got.lines[0].words)


@pytest.mark.skipif(not pypinyin_installed, reason="the `romanize` extra is not installed")
def test_transliteration_implies_the_unit_rule() -> None:
    """A romanisation is built per syllable fragment, so an unsplit line would hand back one span for the
    whole line — `rules` turns the unit half on rather than measuring that."""
    rules = units.rules("zh", script_units=False, simplify=False, transliterate=True)
    assert rules.words(ZH) == list(ZH)
    assert "units" in rules.name and "roman" in rules.name


@pytest.mark.skipif(not pypinyin_installed, reason="the `romanize` extra is not installed")
def test_an_already_latin_fragment_is_not_dropped_from_the_targets() -> None:
    """A Chinese sheet's English chorus has no romanisation; passing nothing through would decode it as
    silence, so the fragment itself is the target."""
    rules = units.rules("zh", script_units=True, simplify=False, transliterate=True)
    assert rules.chars is not None
    assert [ch for _at, ch in rules.chars("you")] == list("you")


@pytest.mark.skipif(not (cutlet_installed and fugashi_installed), reason="the ja extras are not installed")
def test_a_japanese_mora_owns_its_letters_where_the_token_reads_as_its_morae() -> None:
    """A kana token reads mora by mora, so each mora carries its own index and gets a span of its own."""
    rules = units.rules("ja", script_units=True, simplify=False, transliterate=True)
    assert rules.chars is not None
    spelled = list(rules.chars("ひらがな"))
    assert "".join(ch for _at, ch in spelled) == "hiragana"
    assert sorted({at for at, _ch in spelled}) == [0, 1, 2, 3]


@pytest.mark.skipif(not (cutlet_installed and fugashi_installed), reason="the ja extras are not installed")
def test_a_kanji_token_reads_as_a_WORD_and_so_no_mora_owns_its_letters() -> None:
    """A kanji is read by the token it sits in — `流れる` is `nagareru` where its first grapheme ALONE is
    `ryuu` — so the token's own reading is the target sequence and `WHOLE_WORD` says no mora owns it."""
    rules = units.rules("ja", script_units=True, simplify=False, transliterate=True)
    assert rules.chars is not None
    spelled = list(rules.chars("流れる"))
    assert "".join(ch for _at, ch in spelled) == "nagareru"
    assert {at for at, _ch in spelled} == {units.WHOLE_WORD}


@pytest.mark.skipif(not (cutlet_installed and fugashi_installed), reason="the ja extras are not installed")
def test_no_japanese_syllable_is_published_zero_width_at_its_words_end() -> None:
    """The defect `WHOLE_WORD` exists for (review r1-tests-15): with every target tagged grapheme 0, the
    first mora absorbed the whole token and every later one was published zero-width at the token's END —
    511 of this corpus's 1229 ja truth morae. The word is still timed either way.
    """
    latin = han_dictionary(["abcdefghijklmnopqrstuvwxyz"])
    emissions = FakeEmissions(log_probs=[0] * 600, frame_sec=0.02, dictionary=latin)
    roman = units.rules("ja", script_units=True, simplify=False, transliterate=True)
    flat = char_targets([JA, JA_KANA], emissions, units=roman)
    decoder = scripted_decoder(evenly(len(flat.targets)), 600)
    got = generate([JA, JA_KANA], emissions, decoder=decoder, language="ja", units=roman)
    words = [word for line in got.lines for word in line.words]
    assert [word.word for word in words] == units.words(JA, "ja") + units.words(JA_KANA, "ja")
    assert all(word.start < word.end for word in words)
    assert all(syllable.start < syllable.end for word in words for syllable in word.syllables)
    multi_mora = [word for word in words if len(units.syllables(word.word, "ja")) > 1]
    assert [word.word for word in multi_mora if not word.syllables] == ["流れる"]
    assert [len(word.syllables) for word in multi_mora if word.syllables] == [4, 4]


def test_the_target_romaniser_strips_tones_and_the_display_one_keeps_them() -> None:
    """MMS_FA's vocabulary is 26 letters and an apostrophe, so a target may carry no tone mark; the
    published `romanization` field still does (XA-19)."""
    display = romanize.build_romanizer("zh")
    target = romanize.build_transliterator("zh")
    if display is None or target is None:
        pytest.skip("the `romanize` extra is not installed")
    assert display("花") == "huā"
    assert target("花") == "hua"
