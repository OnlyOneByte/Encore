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


def test_a_word_whose_targets_are_only_PARTLY_attributable_publishes_no_syllables() -> None:
    """`WHOLE_WORD`'s rule is `all`, which is what makes the guard load-bearing (review r2-tests-15).

    A `Rules.chars` answering a MIXED list — one fragment read on its own, the rest only as the whole word —
    would otherwise publish one real span and a zero-width tail at the word's end, which is the defect
    `WHOLE_WORD` exists for. `units._transliterated` answers homogeneous lists today, so this is the guard's
    own test rather than a shipped path's (XA-20).
    """
    latin = han_dictionary(["abcdefghijklmnopqrstuvwxyz"])
    emissions = FakeEmissions(log_probs=[0] * 600, frame_sec=0.02, dictionary=latin)
    mixed = units.Rules(
        name="mixed",
        words=lambda text: [text],
        syllables=lambda word, _language: list(word),
        chars=lambda _word: [(0, "a"), (units.WHOLE_WORD, "b"), (units.WHOLE_WORD, "c")],
    )
    attributable = units.Rules(
        name="attributable",
        words=mixed.words,
        syllables=mixed.syllables,
        chars=lambda _word: [(0, "a"), (1, "b"), (1, "c")],
    )
    for rules, expected in ((mixed, 0), (attributable, 2)):
        flat = char_targets([ZH[:2]], emissions, units=rules)
        decoder = scripted_decoder(evenly(len(flat.targets)), 600)
        got = generate([ZH[:2]], emissions, decoder=decoder, language="zh", units=rules)
        (word,) = [word for line in got.lines for word in line.words]
        assert word.word == ZH[:2] and word.start < word.end, "the word is timed either way"
        assert len(word.syllables) == expected, "a target that names no grapheme publishes no syllable"


# ── the per-language stage-2 table (W10) ──────────────────────────────────────────────────────────


def test_every_routed_row_is_keyed_by_its_own_language_and_names_its_bundle() -> None:
    """`ROUTED` is the ONE table, so a row filed under the wrong key would route one language on another's
    measurement — and MMS_FA is the only bundle a row may name, being the only one the arms replace
    whisperx's table with (XA-21; docs/arch/04-alignment.md §9.2)."""
    assert units.ROUTED, "a build routing no language has no stage 2"
    for code, row in units.ROUTED.items():
        assert row.language == code, f"{code} is filed under another language's name"
        assert row.arms, "a row with no arm is not a route"
        assert row.arms <= {units.SCRIPT_UNITS, units.SIMPLIFY, units.TRANSLITERATE}
        assert 0.0 < row.syllable_pco300 <= 100.0, "the number the row was chosen on is a percentage"
        wants_mms = units.TRANSLITERATE in row.arms
        assert row.bundle == (units.MMS_BUNDLE if wants_mms else units.OWN_BUNDLE)


def test_the_mms_bundle_name_is_the_adapters_own_spelling() -> None:
    """`domain/` may not import `adapters/`, so the bundle name is restated here — and a restatement that
    drifts would route a language to a bundle no aligner loads."""
    from encore_worker.adapters.ml import MMS_ALIGN_MODEL

    assert units.MMS_BUNDLE == MMS_ALIGN_MODEL


def test_japanese_is_routed_OFF_mms_and_the_rejection_is_the_shipped_rule() -> None:
    """The licence clearing was not "turn MMS on": it reads 70.98 against `nonlatin-units`' 81.95 on ja, so
    a blanket default would cost Japanese 11 points. The rejection is a ROW and not a default-off knob."""
    assert units.ROUTED["ja"].arms == frozenset({units.SCRIPT_UNITS})
    assert units.ROUTED["ja"].bundle == units.OWN_BUNDLE
    assert units.stage2_bundle("ja", frozenset()) == units.OWN_BUNDLE
    assert units.TRANSLITERATE not in units.arms_for("ja", frozenset())


def test_an_unrouted_script_keeps_the_whitespace_rule_and_borrows_no_neighbours_row() -> None:
    """A language no row names is NOT routed — the decline being the point: `SCRIPT_LANGUAGES` names 13
    scripts no bundle exists for, and a neighbour's arms on them would be an assumption, not a reading."""
    for code in ("th", "hi", "ta", "zz"):
        assert code not in units.ROUTED
        assert units.route(code, frozenset()) is None
        assert units.arms_for(code, frozenset()) == frozenset()
        assert units.stage2_bundle(code, frozenset()) == units.OWN_BUNDLE
        assert units.rules_for(code, frozenset()).name == "plain"


def test_an_operators_named_arm_still_reaches_a_language_no_row_names() -> None:
    """The table is the measured DEFAULT and not a ceiling: a named arm has to reach an unrouted language,
    which is how the next language's row gets measured in the first place."""
    asked = frozenset({units.SCRIPT_UNITS})
    assert units.arms_for("th", asked) == asked
    assert units.arms_for("ja", asked) == asked, "ja's own row names the same arm"
    assert units.arms_for("zh", asked) == frozenset({units.SCRIPT_UNITS, units.TRANSLITERATE}), (
        "a named arm is added to the row's, never swapped for them"
    )


def test_the_unrouted_control_stands_every_row_down() -> None:
    """The control that puts the whole lane back on whisperx's tables and the whitespace rule — the
    configuration every row recorded before W10 was measured on, so a re-read of one is reproducible."""
    control = frozenset({units.UNROUTED})
    for code in units.ROUTED:
        assert units.route(code, control) is None
        assert units.arms_for(code, control) == frozenset()
        assert units.stage2_bundle(code, control) == units.OWN_BUNDLE
        assert units.rules_for(code, control).name == "plain"
    assert units.arms_for("zh", control | {units.SCRIPT_UNITS}) == frozenset({units.SCRIPT_UNITS}), (
        "the control stands the TABLE down, not an operator's own arm"
    )


@pytest.mark.skipif(pypinyin_installed, reason="this box CAN romanise zh, so the gap cannot be observed")
def test_a_box_that_cannot_romanise_is_not_routed_to_mms() -> None:
    """The bundle and the target sequence can never disagree: MMS_FA's 26 Latin letters aimed at raw Han is
    a worse reading than whisperx's own table, so a missing transliterator un-routes rather than half-
    applying (docs/arch/04-alignment.md §9.1)."""
    assert units.unhonoured("zh", frozenset()) == frozenset({units.TRANSLITERATE})
    assert units.stage2_bundle("zh", frozenset()) == units.OWN_BUNDLE


def test_the_bundle_follows_the_resolved_arm_and_not_the_asked_one() -> None:
    """`stage2_bundle` reads `unhonoured`, so whatever this box can do, the bundle it names and the target
    sequence `rules_for` builds are the same decision read twice."""
    for code in (*units.ROUTED, "th", "en", ""):
        for asked in (frozenset(), frozenset({units.TRANSLITERATE}), frozenset({units.UNROUTED})):
            romanised = "roman" in units.rules_for(code, asked).name
            assert (units.stage2_bundle(code, asked) == units.MMS_BUNDLE) == romanised, (
                f"{code!r} under {sorted(asked)}: the bundle and the target sequence disagree"
            )


def test_every_arm_name_this_module_spells_is_a_declared_experiment() -> None:
    """W6 review r2-tests-15's defect, one wave over: every test and bench caller of the table builds
    `Config(align_experiments=...)` DIRECTLY, so a name missing from `host.config.ALIGN_EXPERIMENTS` left
    the suite green while `ENCORE_ALIGN_EXPERIMENTS=nonlatin-unrouted` — the command docs/arch/04-alignment.md
    §9.2 prescribes for reproducing a pre-W10 row — made the worker refuse to START. An off switch has to be
    settable from the environment to be one, and `nonlatin-unrouted` was not until this test existed."""
    from encore_worker.host.config import ALIGN_EXPERIMENTS, Config

    spelled = {units.SCRIPT_UNITS, units.SIMPLIFY, units.TRANSLITERATE, units.UNROUTED}
    assert spelled <= set(ALIGN_EXPERIMENTS)
    read = Config.from_env({"ENCORE_ALIGN_EXPERIMENTS": units.UNROUTED})
    assert read.align_experiments == frozenset({units.UNROUTED})
    assert units.route("zh", read.align_experiments) is None, "and it reaches the table it stands down"
