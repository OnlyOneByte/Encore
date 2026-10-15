"""Display-only romanisation: a second script BESIDE the original line, never instead of it.

Routed by the TEXT's language, because the script has already decided that (`language.detect`) and a kanji
has to be read as Japanese rather than as Chinese. Every backend is an OPTIONAL package, so a box without
one publishes exactly the document it published before — the same degradation lingua's absence gets. A
romanisation is never an alignment target and never replaces the original text: invariant XA-19,
docs/arch/04-alignment.md §11.2.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from functools import cache
from typing import Protocol

from encore_worker.domain.lyrics import language

#: ISO-639-1 -> uroman's own ISO-639-3 code, which selects that language's rules. Every non-Latin language
#: `language.SCRIPT_LANGUAGES` can name except zh and ja, each of which has a better backend below; a test
#: pins the two tables equal, so a new script's language cannot be added there and silently go unromanised.
UROMAN_CODES: Mapping[str, str] = {
    "ko": "kor",
    "ru": "rus",
    "uk": "ukr",
    "el": "ell",
    "ar": "ara",
    "fa": "fas",
    "ur": "urd",
    "he": "heb",
    "hi": "hin",
    "te": "tel",
    "ml": "mal",
    "ka": "kat",
}

#: Which package romanises each language. LICENCES ARE THE CHOICE HERE, not accuracy: ja is cutlet (MIT)
#: and never pykakasi, which is GPL-3.0 and could not ship in this tree. The licence of each, and why
#: uroman is the fallback rather than a per-script library: docs/arch/04-alignment.md §11.2.
BACKENDS: Mapping[str, str] = {
    "zh": "pypinyin",
    "ja": "cutlet",
    **{code: "uroman" for code in UROMAN_CODES},
}

_WHITESPACE = re.compile(r"\s+")


class Romanizer(Protocol):
    """A line of text -> the same line in Latin letters. A Protocol, so the real backends stay optional
    packages and a test can hand in a lambda."""

    def __call__(self, text: str) -> str: ...


def needs_romanization(text: str) -> bool:
    """Does `text` hold a letter a Latin reader cannot read?

    A Latin-only line must get NO second script: on a mixed-script sheet it would print a copy of itself
    under every English line.
    """
    return any(
        script is not None and script != language.LATIN for script in (language.script_of(ch) for ch in text)
    )


def romanization_of(text: str, romanizer: Romanizer | None) -> str | None:
    """`text`'s romanisation for display, or None when there is nothing worth showing: no backend, no
    non-Latin letter, or an answer that only repeats the line.

    NEVER RAISES. A second script is an extra on top of a published document, so a backend that chokes on
    one line costs that line its romanisation and nothing else.
    """
    if romanizer is None or not needs_romanization(text):
        return None
    try:
        said = _WHITESPACE.sub(" ", romanizer(text)).strip()
    except Exception:
        return None  # a display extra may not fail a publish
    return said if said and said != text.strip() else None


@cache
def build_romanizer(language_code: str) -> Romanizer | None:
    """The backend for `language_code`, built ONCE per process, or None when its package is absent.

    Built once because uroman spends ~2 s loading its tables and cutlet loads a MeCab dictionary, against
    microseconds a line afterwards. Pure: the same code answers the same backend on a replay.
    """
    match BACKENDS.get(language_code):
        case "pypinyin":
            return _pypinyin()
        case "cutlet":
            return _cutlet()
        case "uroman":
            return _uroman(UROMAN_CODES[language_code])
        case _:
            return None


@cache
def build_transliterator(language_code: str) -> Romanizer | None:
    """`build_romanizer`'s TARGET-side twin: the same backends, but plain ASCII with no tone marks.

    For the romanised target sequence MMS_FA reads (XA-20, `units._transliterated`), whose vocabulary is 26
    letters and an apostrophe. The published `romanization` field never comes from here (XA-19).
    """
    if BACKENDS.get(language_code) == "pypinyin":
        return _pypinyin(toned=False)
    return build_romanizer(language_code)


def _pypinyin(*, toned: bool = True) -> Romanizer | None:
    """Mandarin pinyin: `我来到` -> `wǒ lái dào`, or `wo lai dao` untoned. MIT, pure Python, no download."""
    try:
        from pypinyin import Style, lazy_pinyin  # noqa: PLC0415
    except ImportError:
        return None
    style = Style.TONE if toned else Style.NORMAL

    def romanize(text: str) -> str:
        return " ".join(lazy_pinyin(text, style=style))

    return romanize


def _cutlet() -> Romanizer | None:
    """Japanese, as Hepburn romaji: `夜に駆ける` -> `Yoru ni kakeru`. MIT, over fugashi + unidic-lite."""
    try:
        import cutlet  # noqa: PLC0415
    except ImportError:
        return None
    try:
        katsu = cutlet.Cutlet()
    except Exception:
        return None  # cutlet without a MeCab dictionary installed

    def romanize(text: str) -> str:
        return str(katsu.romaji(text))

    return romanize


def _uroman(code: str) -> Romanizer | None:
    """Every other non-Latin script, through uroman's universal tables. Apache-2.0."""
    try:
        import uroman  # noqa: PLC0415
    except ImportError:
        return None
    try:
        engine = uroman.Uroman()
    except Exception:
        return None  # its data tables are a package resource; a broken install is not a failed publish

    def romanize(text: str) -> str:
        return str(engine.romanize_string(text, lcode=code))

    return romanize
