"""Display-only romanisation (W8 stage 0): a second script BESIDE the line, never instead of it.

Two halves. The RULE — which languages have a backend, when a line gets a romanisation at all, and that
nothing raises — runs with a lambda, so it holds on a box that never installed the `romanize` extra. The
REAL backends then prove the rule is wired to something: those tests SKIP where the package is absent, the
honest reading on a box without it, because asserting around them would leave the wiring untested.
Invariant XA-19; docs/arch/04-alignment.md §11.2.
"""

from __future__ import annotations

from importlib.util import find_spec

import pytest

from encore_worker.domain.lyrics import language, romanize

#: One SYNTHETIC line per backend, in the script that backend is for — never a sheet's words
#: (docs/benchmarks/forced-alignment/README.md, "Why no fixture holds a lyric").
LINES = {
    "zh": "山水风云雨雪",
    "ja": "山の上に雲が流れる",
    "ko": "바다 하늘 구름들",
    "ru": "Привет мир",
    "ar": "مرحبا بالعالم",
}


def shouting(text: str) -> str:
    """A romaniser with no package behind it: the rule under test is never the backend's accuracy."""
    return text.upper()


# ── which language has a backend ──────────────────────────────────────────────────────────────────────


def test_every_non_latin_language_the_router_can_name_has_a_backend() -> None:
    """`language.SCRIPT_LANGUAGES` is what routes a script to a bundle, so it is also the population that
    reaches the TV in a script a Latin reader cannot read. A new entry there with no backend here would
    publish an unreadable line silently; this is the test that fails instead."""
    routed = sorted({code for codes in language.SCRIPT_LANGUAGES.values() for code in codes})
    assert sorted(romanize.BACKENDS) == routed
    assert romanize.BACKENDS["zh"] == "pypinyin" and romanize.BACKENDS["ja"] == "cutlet"
    assert all(romanize.BACKENDS[code] == "uroman" for code in romanize.UROMAN_CODES)
    assert "pykakasi" not in set(romanize.BACKENDS.values()), "GPL-3.0; the licences are in pyproject.toml"


def test_a_latin_language_gets_no_romaniser_at_all() -> None:
    for code in sorted(language.LATIN_LANGUAGES):
        assert romanize.build_romanizer(code) is None, code


def test_an_unknown_language_code_is_not_an_error() -> None:
    assert romanize.build_romanizer("qqq") is None


# ── when a line gets one ──────────────────────────────────────────────────────────────────────────────


def test_a_latin_only_line_is_never_romanised() -> None:
    """A mixed-script sheet's English lines would otherwise each print a shouted copy of themselves."""
    assert not romanize.needs_romanization("oh my friend")
    assert romanize.romanization_of("oh my friend", shouting) is None


def test_a_line_with_one_non_latin_letter_is_romanised() -> None:
    assert romanize.needs_romanization("山水风云 a latin chorus")
    assert romanize.romanization_of("山水风云 a latin chorus", shouting) == "山水风云 A LATIN CHORUS"


def test_punctuation_and_digits_are_not_a_script() -> None:
    """`♪`, `[Chorus]`-style brackets and numbers belong to no writing system, so a decorative row gets
    no second script — the same reading `language.script_histogram` takes."""
    for text in ("♪♪♪", "1 2 3 4", "[ ... ]", ""):
        assert not romanize.needs_romanization(text), text
        assert romanize.romanization_of(text, shouting) is None, text


def test_no_backend_means_no_field() -> None:
    assert romanize.romanization_of(LINES["zh"], None) is None


def test_an_answer_that_only_repeats_the_line_is_dropped() -> None:
    """A backend that cannot read a script tends to hand the text straight back; printing it under itself
    is noise, and the TV's `romanization` field is meant to be absent in that case."""
    assert romanize.romanization_of(LINES["zh"], lambda text: text) is None
    assert romanize.romanization_of(LINES["zh"], lambda text: " " * len(text)) is None


def test_whitespace_is_collapsed() -> None:
    """pypinyin returns a Latin run as one element, so the naive join doubles the space beside it."""

    def padded(text: str) -> str:
        return "  cheng   shi\n" if text else ""

    assert romanize.romanization_of("城市", padded) == "cheng shi"


def test_a_backend_that_raises_costs_that_line_its_romanisation_and_nothing_else() -> None:
    def explode(text: str) -> str:
        raise RuntimeError(f"no dictionary for {text!r}")

    assert romanize.romanization_of(LINES["zh"], explode) is None


def test_the_factory_builds_each_language_once() -> None:
    """uroman spends ~2 s loading its tables, so a per-line build would cost more than the alignment."""
    assert romanize.build_romanizer("fr") is romanize.build_romanizer("fr")
    assert romanize.build_romanizer("zh") is romanize.build_romanizer("zh")


# ── the real backends ─────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("code", "package", "expected"),
    [
        ("zh", "pypinyin", "shān shuǐ fēng yún yǔ xuě"),
        ("ja", "cutlet", "Yama no ue ni kumo ga nagareru"),
        ("ko", "uroman", "bada haneul gureumdeul"),
    ],
)
def test_the_shipped_backend_reads_its_own_script(code: str, package: str, expected: str) -> None:
    if find_spec(package) is None:
        pytest.skip(f"{package} is not installed: the `romanize` extra is optional by design")
    assert romanize.romanization_of(LINES[code], romanize.build_romanizer(code)) == expected


def test_uroman_covers_the_scripts_no_dedicated_backend_does() -> None:
    """Cyrillic and Arabic reach the TV through the same routing CJK does, and uroman is why they are
    readable at all — no measurement claims the transliteration is the one a speaker would write."""
    if find_spec("uroman") is None:
        pytest.skip("uroman is not installed: the `romanize` extra is optional by design")
    assert romanize.romanization_of(LINES["ru"], romanize.build_romanizer("ru")) == "Privet mir"
    said = romanize.romanization_of(LINES["ar"], romanize.build_romanizer("ar"))
    assert said is not None and said.isascii() and "mrhba" in said


def test_a_shipped_backend_leaves_a_latin_line_alone() -> None:
    """The gate is `needs_romanization`, but the backends agree with it, which is what makes a mixed sheet
    safe if a later wave moves that gate."""
    if find_spec("pypinyin") is None:
        pytest.skip("pypinyin is not installed: the `romanize` extra is optional by design")
    assert romanize.romanization_of("oh my friend", romanize.build_romanizer("zh")) is None
