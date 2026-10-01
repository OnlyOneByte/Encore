"""The language is an INPUT now (review M8 / §3 item 9, W7): script, detector, routing, and the NFKD fold.

WHAT EACH BLOCK PINS, because the four halves of M8 fail in different directions:

  * `script_of` / `script_histogram` / `dominant_script` — the PRIMARY signal, from the stdlib's own Unicode
    database. A script read wrongly routes a song to a bundle whose vocabulary maps none of its characters,
    which is review M8's s12 (a Japanese sheet, 0 alignable characters, `no lyrics`).
  * `detect` — the ORDER the three signals are trusted in. A non-Latin script must outrank both whisper and
    the job's declared language; Latin script must fall back to English when nothing answers, because that is
    the configuration every row under `docs/benchmarks/forced-alignment/results/` was measured on.
  * `model_language` — the ROUTING POLICY, and the one thing in this wave that could move a published number.
    Latin script on either target stays on the default bundle unless the arm is set.
  * `fold_to_base` + `generate.char_ids` — the fold, and that it is a NO-OP for a vocabulary that already has
    the character (so the English corpus's targets are byte-identical).

The detector is a lambda in every test but one: lingua is an optional 170 MB extra, and a suite that needed it
would stop running on `uv sync --only-group dev` (`tests/test_layers.py`'s whole point).
"""

from __future__ import annotations

import importlib.util

import pytest

from encore_worker.domain.lyrics import language as lang
from encore_worker.domain.lyrics import lexical
from encore_worker.domain.lyrics.generate import alignable_chars, char_ids

# ── the script histogram ──────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("character", "script"),
    [
        ("a", lang.LATIN),
        ("é", lang.LATIN),
        ("ß", lang.LATIN),
        ("ø", lang.LATIN),
        ("я", lang.CYRILLIC),
        ("α", lang.GREEK),
        ("中", lang.HAN),
        ("あ", lang.KANA),
        ("ア", lang.KANA),
        ("한", lang.HANGUL),
        ("ا", lang.ARABIC),
        ("א", lang.HEBREW),
        ("क", "Devanagari"),
        ("ก", "Thai"),
        ("ა", "Georgian"),
        ("அ", "Tamil"),
        # Compatibility forms are the script they are a form OF: a fullwidth Latin letter is Latin.
        ("ａ", lang.LATIN),
    ],
)
def test_every_writing_system_is_read_off_the_characters_own_unicode_name(
    character: str, script: str
) -> None:
    """One `str.split` over the UCD name, not a range table — so a Unicode release cannot silently add a
    script this reads as "not a letter", which is the quiet half of review M8."""
    assert lang.script_of(character) == script


@pytest.mark.parametrize("character", ["'", "’", "-", "1", "♪", " ", "ʼ"])
def test_nothing_that_is_not_a_letter_has_a_script(character: str) -> None:
    """Punctuation, digits and `♪` belong to no language: a histogram that counted them would call a sheet of
    `[Chorus]` headers Latin at 100%. `ʼ` is the trap — a MODIFIER LETTER, so `str.isalpha` is True and its
    UCD name names no script."""
    assert lang.script_of(character) is None


def test_the_histogram_counts_letters_and_the_share_is_of_letters_only() -> None:
    counts = lang.script_histogram(["don't stop — 123 ♪", "한국어"])
    assert counts == {lang.LATIN: 8, lang.HANGUL: 3}, "the apostrophe, the dash, the digits and ♪ are not"
    script, share = lang.dominant_script(["don't stop — 123 ♪", "한국어"])
    assert (script, round(share, 3)) == (lang.LATIN, 0.727), "8 of 11 LETTERS, not 8 of 21 characters"


def test_a_text_with_no_letter_has_no_script_at_all() -> None:
    assert lang.dominant_script(["♪", "(123)", ""]) == ("", 0.0)


def test_a_tie_breaks_on_the_script_name_so_two_replays_load_one_bundle() -> None:
    """A DBOS step may be replayed. A language that depended on dict ordering would make two replays of one
    attempt load two bundles and key two emission matrices."""
    script, share = lang.dominant_script(["ab", "яб"])
    assert (script, share) == (lang.CYRILLIC, 0.5), "Cyrillic sorts before Latin"


# ── `detect`: the order the signals are trusted in ────────────────────────────────────────────────


def test_a_non_latin_script_outranks_both_whisper_and_the_job() -> None:
    """The asymmetry review M8 asks for: the script is a FACT about characters that must be in the model's
    vocabulary, where whisper's language is an acoustic guess and the job's is a room-wide default."""
    got = lang.detect(["사랑해 사랑해", "나는 바람"], declared="en", heard="en")
    assert (got.language, got.script, got.source) == ("ko", lang.HANGUL, "script")


def test_han_plus_any_kana_is_japanese_and_han_alone_is_chinese() -> None:
    """Japanese mixes the two and Chinese does not, so the DOMINANT script alone calls every Japanese sheet
    Chinese — the kana are a minority of the characters."""
    assert lang.detect(["私は風です", "夜に吹く"]).language == "ja"
    assert lang.detect(["我是风", "在夜里吹"]).language == "zh"


def test_an_ambiguous_script_takes_the_measured_signal_over_the_tuples_first_entry() -> None:
    """Cyrillic is ru/uk and Arabic is ar/fa/ur; whisper measured the AUDIO, so it tells them apart where the
    glyphs cannot. With no signal the first entry stands, because the alternative — the English bundle — maps
    zero characters of either script."""
    assert lang.detect(["Я ветер"], heard="uk").language == "uk"
    assert lang.detect(["Я ветер"]).language == "ru"
    assert lang.detect(["انا الريح"], declared="fa").language == "fa"
    assert lang.detect(["انا الريح"]).language == "ar"


def test_a_script_no_bundle_exists_for_says_so_rather_than_claiming_a_language() -> None:
    """Cherokee has no whisperx model, so this is a decline whatever we answer — but the trail must carry the
    script that was read, not a confident `en`."""
    got = lang.detect(["ᏣᎳᎩ ᎦᏬᏂᎯᏍᏗ"])
    assert (got.language, got.script, got.source) == (lang.ENGLISH, "Cherokee", "default")


def test_latin_script_asks_the_detector_then_what_was_heard_then_what_was_declared() -> None:
    texts = ["je suis le vent", "qui souffle dans la nuit"]
    assert lang.detect(texts, detector=lambda _t: "fr").source == "detector"
    assert lang.detect(texts, detector=lambda _t: None, heard="fr").source == "heard"
    assert lang.detect(texts, declared="fr").source == "declared"
    got = lang.detect(texts, detector=lambda _t: "fr", heard="de", declared="es")
    assert got.language == "fr", "the detector read the words that are about to be aligned"


def test_latin_script_with_nothing_answering_is_english_which_is_what_results_were_measured_on() -> None:
    got = lang.detect(["i am the wind"])
    assert (got.language, got.script, got.source) == (lang.ENGLISH, lang.LATIN, "default")


def test_a_detector_naming_a_language_no_bundle_exists_for_is_refused() -> None:
    """Answering `sw` would make the attempt decline on a missing alignment model, where the default bundle
    decodes every one of its Latin letters. `LATIN_LANGUAGES` is the closed set, and `detect` filters even
    though `lingua_detector` already restricts the builder."""
    got = lang.detect(["nipepo upepo"], detector=lambda _t: "sw", heard="de")
    assert got.language == "de", "the next signal in the order, not the unroutable answer"
    assert lang.detect(["nipepo upepo"], detector=lambda _t: "sw").language == lang.ENGLISH


def test_a_declared_language_survives_a_sheet_with_no_letters_in_it() -> None:
    """A sheet of `♪` rows says nothing, and a detector asked about it answers confidently and wrongly — but
    an operator who declared `ja` must not have it silently replaced by English."""
    assert lang.detect(["♪", "♪ ♪"], declared="ja").language == "ja"
    assert lang.detect(["♪", "♪ ♪"], declared="ko").source == "declared"
    assert lang.detect(["♪"], declared="klingon").language == lang.ENGLISH
    assert lang.detect(["♪"]).source == "default"


def test_the_detected_sentence_names_the_signal_that_won() -> None:
    why = lang.detect(["사랑해"], declared="en").why()
    assert "'ko'" in why and "script" in why and "Hangul" in why


# ── `model_language`: the routing policy ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("on_mix", [False, True])
@pytest.mark.parametrize("code", ["fr", "de", "es", "it", "nl", "sv", lang.ENGLISH])
def test_latin_script_stays_on_the_default_bundle_by_default_on_either_target(
    code: str, on_mix: bool
) -> None:
    """THE ONE RULE THAT PROTECTS EVERY PUBLISHED NUMBER. The review measured fr/de/es stems at 91.8% of words
    within ±300 ms under the English model — the same as English Jamendo's 91.1% — and routed bundles winning
    only on the MIX. Routing by default would take Latin songs away from the bundle that was measured."""
    assert lang.model_language(code, on_mix=on_mix) == lang.ENGLISH


@pytest.mark.parametrize("code", ["fr", "de", "es"])
def test_the_arm_routes_latin_script_on_the_mix_and_never_on_the_stem(code: str) -> None:
    """`lang-route-mix` (`host.config.ALIGN_EXPERIMENTS`): the mix is where routing was measured to win, and
    the stem is where it was measured to lose, so the arm cannot move the stem."""
    assert lang.model_language(code, on_mix=True, route_latin=True) == code
    assert lang.model_language(code, on_mix=False, route_latin=True) == lang.ENGLISH
    assert lang.model_language(lang.ENGLISH, on_mix=True, route_latin=True) == lang.ENGLISH


@pytest.mark.parametrize("on_mix", [False, True])
@pytest.mark.parametrize("route", [False, True])
@pytest.mark.parametrize("code", ["ja", "zh", "ko", "ru", "ar", "he", "hi"])
def test_a_non_latin_script_always_routes_whatever_the_target_and_the_arm(
    code: str, on_mix: bool, route: bool
) -> None:
    """There is nothing to trade off: the English vocabulary maps ZERO characters of these scripts, so the
    alternative to routing is `generate` producing no line and the ladder publishing `no lyrics` (s12)."""
    assert lang.model_language(code, on_mix=on_mix, route_latin=route) == code


def test_an_empty_language_is_english_rather_than_a_bundle_nobody_names() -> None:
    assert lang.model_language("", on_mix=False) == lang.ENGLISH


def test_the_routing_note_is_silent_when_the_bundle_is_the_texts_own() -> None:
    """A note on every job would bury the one case that matters: an uncalibrated routed bundle cannot gate a
    wrong text, so the substitution has to be visible — and only when it happened."""
    assert lang.routing_note("fr", "fr", on_mix=False) is None
    note = lang.routing_note("fr", lang.ENGLISH, on_mix=False)
    assert note is not None and "'fr'" in note and "stem" in note and "lang-route-mix" in note


# ── the NFKD fold ─────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("character", "folded"),
    [("é", "e"), ("ü", "u"), ("ñ", "n"), ("å", "a"), ("ﬁ", "fi"), ("Ö", "O")],
)
def test_a_composed_letter_folds_to_its_base_letters(character: str, folded: str) -> None:
    assert lang.fold_to_base(character) == folded


@pytest.mark.parametrize("character", ["ø", "æ", "œ", "ß", "đ", "ł", "ı"])
def test_an_atomic_letter_comes_back_unchanged_which_is_the_residue_the_docstring_names(
    character: str,
) -> None:
    """NFKD has no decomposition for these, so they are still dropped by a vocabulary that lacks them. Mapping
    them needs a hand table (`ß` -> `ss` changes the character COUNT too), which is a measured change of its
    own rather than a line in `fold_to_base`."""
    assert lang.fold_to_base(character) == character


@pytest.mark.parametrize("character", ["’", "—", "1"])
def test_something_with_no_usable_fold_comes_back_so_the_callers_drop_branch_is_reached(
    character: str,
) -> None:
    assert lang.fold_to_base(character) == character


# ── the fold inside the target filter (`generate.char_ids`) ───────────────────────────────────────

#: A 26-letter Latin vocabulary with CTC's blank at 0, i.e. the shape every English bundle has.
EN = {"-": 0, "|": 1, **{ch: index + 2 for index, ch in enumerate("abcdefghijklmnopqrstuvwxyz")}}


def test_the_filter_is_byte_identical_on_a_text_whose_letters_the_vocabulary_has() -> None:
    """THE GATE ON THE WHOLE CHANGE: the corpus's 50 516 cleaned-truth characters hold no non-ASCII letter
    (`scripts/lang_gate.py --folds`), so every recorded row's target sequence is unmoved."""
    assert char_ids("stop", EN, {0}) == [(0, EN["s"]), (1, EN["t"]), (2, EN["o"]), (3, EN["p"])]


def test_an_accented_letter_is_folded_rather_than_dropped() -> None:
    """Review M8's own words: "accents are silently skipped". `cafés` decoded as `cafs`, so every later
    character of the word was timed on the frames of the one before it."""
    assert [token for _index, token in char_ids("cafés", EN, {0})] == [
        EN["c"], EN["a"], EN["f"], EN["e"], EN["s"],
    ]  # fmt: skip


def test_a_folded_character_keeps_its_own_index_even_when_it_yields_two_targets() -> None:
    """`char_of` is an index into the INPUT word, which is what `generate` slices syllable fragments with —
    so a ligature's two targets must both point at the one character they came from."""
    assert char_ids("ﬁn", EN, {0}) == [(0, EN["f"]), (0, EN["i"]), (1, EN["n"])]


def test_a_vocabulary_that_has_the_composed_letter_aligns_it_and_does_not_fold() -> None:
    """Checked before the fold, so a French bundle still targets its own `é` column rather than an `e`."""
    french = {**EN, "é": 40}
    assert char_ids("café", french, {0}) == [(0, 4), (1, 2), (2, 7), (3, 40)]


def test_an_excluded_column_is_never_a_target_folded_or_not() -> None:
    """The kernel refuses a target list holding the blank, and a lyric's literal `|` forced a word separator
    into the middle of a word (`generate.excluded_of`)."""
    assert char_ids("a|b", EN, {0, 1}) == [(0, EN["a"]), (2, EN["b"])]


def test_a_character_no_fold_reaches_is_still_dropped() -> None:
    assert char_ids("1ß한", EN, {0}) == []


class _Matrix:
    """`Emissions`' duck type, for the two counting readers."""

    def __init__(self, dictionary: dict[str, int]) -> None:
        self.dictionary = dictionary
        self.blank_id = 0
        self.specials = {"-": 0, "|": 1}
        self.frame_sec = 0.02


def test_both_floors_count_the_folded_characters() -> None:
    """`alignable_chars` is the input to `regenerate`'s window floor and to `align_steps.needs`, and both are
    floors on TARGETS: a folded `ﬁ` costs two frames, not one."""
    assert alignable_chars("cafés ﬁn", _Matrix(EN)) == 5 + 3


def test_the_lift_is_measured_on_the_targets_the_decode_publishes() -> None:
    """`lexical.letters_of` IS `generate.char_ids` now. A copy that kept dropping accents would measure the
    lift of a different text — and the bands are nats per LETTER, so the denominator would move too."""
    assert lexical.letters_of(["cafés"], EN, {0}) == [EN["c"], EN["a"], EN["f"], EN["e"], EN["s"]]


# ── the seams that must agree with the rest of the worker ─────────────────────────────────────────


def test_the_english_code_is_the_one_the_adapter_overrides_its_bundle_for() -> None:
    """`domain/` may not import `adapters/`, so the string is spelled twice; a disagreement would leave the
    English bundle override dormant exactly as review M8 left it."""
    from encore_worker.adapters.ml import ENGLISH

    assert lang.ENGLISH == ENGLISH


@pytest.mark.skipif(importlib.util.find_spec("whisperx") is None, reason="whisperx is in the ml extra")
def test_the_latin_language_set_is_whisperxs_own_tables() -> None:
    """The hand-copy in `LATIN_LANGUAGES` cannot drift silently: a language in whisperx's tables that this set
    omits is one `detect` will never route to, and one it holds that whisperx dropped is an attempt that
    declines on a missing model."""
    from whisperx.alignment import DEFAULT_ALIGN_MODELS_HF, DEFAULT_ALIGN_MODELS_TORCH

    tabled = set(DEFAULT_ALIGN_MODELS_TORCH) | set(DEFAULT_ALIGN_MODELS_HF)
    non_latin = {code for codes in lang.SCRIPT_LANGUAGES.values() for code in codes}
    assert lang.LATIN_LANGUAGES <= tabled, sorted(lang.LATIN_LANGUAGES - tabled)
    assert lang.LATIN_LANGUAGES == tabled - non_latin, sorted((tabled - non_latin) ^ lang.LATIN_LANGUAGES)


@pytest.mark.skipif(importlib.util.find_spec("whisperx") is None, reason="whisperx is in the ml extra")
def test_every_language_a_script_routes_to_has_a_bundle() -> None:
    """A script that routed to a language whisperx tables nothing for would decline the attempt where the
    default bundle at least decodes the Latin letters — so there would be no reason to route at all."""
    from whisperx.alignment import DEFAULT_ALIGN_MODELS_HF, DEFAULT_ALIGN_MODELS_TORCH

    tabled = set(DEFAULT_ALIGN_MODELS_TORCH) | set(DEFAULT_ALIGN_MODELS_HF)
    missing = {code for codes in lang.SCRIPT_LANGUAGES.values() for code in codes if code not in tabled}
    assert not missing, f"no whisperx alignment model for {sorted(missing)}"


@pytest.mark.skipif(importlib.util.find_spec("lingua") is None, reason="lingua is in the text extra")
def test_the_real_detector_tells_the_four_languages_this_corpus_holds_apart() -> None:
    """The one test that loads lingua. Four stanzas of the same sentence, which is the hard case: short,
    repetitive, cognate-heavy text is exactly where a trigram detector is weakest."""
    detector = lang.lingua_detector()
    assert detector is not None
    samples = {
        "fr": ["je suis le vent qui souffle dans la nuit", "et tu me vois danser encore"],
        "de": ["ich bin der wind der durch die nacht weht", "und du siehst mich wieder tanzen"],
        "es": ["soy el viento que sopla en la noche", "y me ves bailar otra vez"],
        "en": ["i am the wind that blows into the night", "and you see me dancing again"],
    }
    for want, texts in samples.items():
        got = lang.detect(texts, detector=detector)
        assert got.language == want, f"{want}: read {got.why()}"
        assert got.source == "detector"


@pytest.mark.skipif(importlib.util.find_spec("lingua") is None, reason="lingua is in the text extra")
def test_the_real_detector_cannot_answer_outside_the_set_a_bundle_exists_for() -> None:
    """It is built `from_iso_codes_639_1(*LATIN_LANGUAGES)`, so its full 75-language set — most of which this
    worker could not align — is not reachable. Accuracy as much as speed: lingua is materially better over a
    closed set."""
    detector = lang.lingua_detector()
    assert detector is not None
    for text in ("nipepo upepo unavuma usiku", "ek is die wind wat waai"):
        assert detector(text) in lang.LATIN_LANGUAGES
