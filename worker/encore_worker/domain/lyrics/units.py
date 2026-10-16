"""Script-aware units: what a WORD and a SYLLABLE are in a script the whitespace rule cannot read.

A Chinese line carries no spaces, so `text.split()` makes the whole line one word with one syllable. Here a
word is one hanzi, one fugashi token or one spaced Korean token, and a syllable is one hanzi, one mora or one
Hangul block. ROUTED BY SCRIPT and never by vocabulary coverage. Two arms that only ever touch a non-Latin
text live here too: the Traditional->Simplified fold the simplified-only zh-cn vocabulary needs, and the
romanised target sequence MMS_FA reads (XA-20). PURE; every backend is an optional package.
docs/arch/04-alignment.md §9.1; docs/benchmarks/forced-alignment/README.md, "W8 stages 1-2".
"""

from __future__ import annotations

from collections.abc import Callable, Collection, Sequence
from dataclasses import dataclass
from functools import cache

from encore_worker.domain.lyrics import language, romanize

#: Scripts written WITHOUT spaces between their words, so every letter of one may open a unit. Korean is not
#: here: Hangul is dense typographically and spaced grammatically (docs/arch/04-alignment.md §11.2).
DENSE_SCRIPTS: dict[str, frozenset[str]] = {
    "zh": frozenset({language.HAN}),
    "ja": frozenset({language.HAN, language.KANA}),
    "ko": frozenset(),
}

#: Per language, the scripts a SYLLABLE is one character of — the review's "mora, hanzi or Hangul block".
SYLLABLE_SCRIPTS: dict[str, frozenset[str]] = {
    "zh": frozenset({language.HAN}),
    "ja": frozenset({language.HAN, language.KANA}),
    "ko": frozenset({language.HANGUL}),
}

#: Characters that never START a unit, so they attach to the one before them: the small kana of a digraph
#: (`きょ` is one mora), the prolonged sound mark and the voicing marks, which have no onset of their own.
_TAILS = frozenset("ゃゅょぁぃぅぇぉゎゕゖャュョァィゥェォヮヵヶーゝゞヽヾ゛゜゙゚")

#: Languages whose romanisation is only sound for a WHOLE word: a Japanese kanji is read by the token it
#: sits in, so romanising one grapheme of it answers a different reading.
_READ_PER_WORD = frozenset({"ja"})

#: `Rules.chars` index for a target that belongs to the whole word and to no one grapheme of it, which is
#: what a `_READ_PER_WORD` language's word answers when its fragments do not read as it does. The word is
#: still timed; it publishes no syllables (XA-20, docs/arch/04-alignment.md §9.1).
WHOLE_WORD = -1


@dataclass(frozen=True, slots=True)
class Rules:
    """How one language's text becomes words, syllable fragments and vocabulary lookups.

    One object so every reader of a trellis — the decode, the lift, the margin — groups the same text the
    same way. `chars` answers `(index within the word, character to look up)`, which is how a romanised
    target still names the grapheme it came from (XA-20).
    """

    name: str
    words: Callable[[str], Sequence[str]]
    syllables: Callable[[str, str], list[str]]
    chars: Callable[[str], Sequence[tuple[int, str]]] | None = None
    #: A character the vocabulary lacks -> one it may have, tried before the NFKD fold. None = no fold.
    fold: Callable[[str], str] | None = None


def opens_unit(ch: str, previous: str, *, dense: frozenset[str]) -> bool:
    """Does `ch` start a new unit after `previous`?

    A character of a `dense` script always does. A letter of any other script does only where the script
    CHANGES, so a Latin run inside a Chinese line stays one word. Punctuation and digits never do.
    """
    if ch in _TAILS:
        return False
    here = language.script_of(ch)
    if here is None:
        return False
    if here in dense:
        return True
    return here != language.script_of(previous)


def grouped(token: str, dense: frozenset[str]) -> list[str]:
    """`token` split into units by `opens_unit`; the pieces concatenate to exactly `token`."""
    out: list[str] = []
    for ch in token:
        if out and not opens_unit(ch, out[-1][-1], dense=dense):
            out[-1] += ch
        else:
            out.append(ch)
    return out


def words(text: str, language_code: str) -> list[str]:
    """`text`'s words under `language_code`'s script rule, whitespace always separating.

    Japanese goes through fugashi where it is installed, a morphological token being a word in a way a
    character is not; without it a Japanese word is its mora, which publishes the same text either way.
    """
    dense = DENSE_SCRIPTS.get(language_code)
    if dense is None:
        return text.split()
    tokenize = _fugashi() if language_code == "ja" else None
    out: list[str] = []
    for token in text.split():
        out.extend(tokenize(token) if tokenize is not None else grouped(token, dense))
    return out


def syllables(word: str, language_code: str) -> list[str]:
    """`word`'s syllable fragments: one per hanzi, mora or Hangul block, else the Latin syllabifier's.

    Contiguous fragments concatenating to exactly `word`, which is `syllabify.syllables`' contract and what
    `generate` regroups character spans by.
    """
    dense = SYLLABLE_SCRIPTS.get(language_code)
    if dense is None or not any(language.script_of(ch) in dense for ch in word):
        return _latin_syllables()(word, language_code)
    return grouped(word, dense)


def plain() -> Rules:
    """The whitespace rule every recorded row was measured on: `text.split()` and the Latin syllabifier."""
    return Rules(name="plain", words=str.split, syllables=_latin_syllables())


def rules(language_code: str, *, script_units: bool, simplify: bool, transliterate: bool) -> Rules:
    """The unit rules for `language_code` under the three W8 arms; `plain` where none of them applies.

    `transliterate` IMPLIES `script_units`: a romanised target is built per syllable fragment, and the
    fragments of a whole unsplit line would hand one span back for the line.
    """
    script_units = script_units or transliterate
    if language_code not in DENSE_SCRIPTS:
        script_units = False
    fold = simplified if simplify and language_code == "zh" else None
    chars = _transliterated(language_code) if transliterate else None
    if not script_units and fold is None and chars is None:
        return plain()
    named = ",".join(
        name
        for name, on in (("units", script_units), ("t2s", fold is not None), ("roman", chars is not None))
        if on
    )
    return Rules(
        name=named,
        words=(lambda text: words(text, language_code)) if script_units else str.split,
        syllables=syllables if script_units else _latin_syllables(),
        chars=chars,
        fold=fold,
    )


def rules_for(language_code: str, experiments: Collection[str]) -> Rules:
    """`rules` read off an `ALIGN_EXPERIMENTS` set — THE one place the three W8 arm names are spelled, so
    the step layer and the bench harness cannot name them differently."""
    return rules(
        language_code,
        script_units="nonlatin-units" in experiments,
        simplify="zh-simplify" in experiments,
        transliterate="mms-roman" in experiments,
    )


def _latin_syllables() -> Callable[[str, str], list[str]]:
    """`syllabify.syllables`, imported lazily so this module is free to import before its Moby table."""
    from encore_worker.domain.lyrics.syllabify import syllables as latin  # noqa: PLC0415

    return latin


@cache
def _fugashi() -> Callable[[str], list[str]] | None:
    """Japanese morphological tokens, or None without fugashi (MIT, `nonlatin` extra).

    Built once: a MeCab dictionary load is ~0.2 s against microseconds a line afterwards. Surface forms
    only, so the tokens still concatenate to the input.
    """
    try:
        import fugashi  # noqa: PLC0415
    except ImportError:
        return None
    try:
        tagger = fugashi.Tagger()
    except Exception:
        return None  # fugashi without a dictionary installed

    def tokenize(token: str) -> list[str]:
        try:
            out = [str(word.surface) for word in tagger(token)]
        except Exception:
            return [token]
        return out if "".join(out) == token else [token]

    return tokenize


@cache
def _opencc() -> Callable[[str], str] | None:
    """OpenCC's Traditional->Simplified conversion, or None without the package (Apache-2.0)."""
    try:
        from opencc import OpenCC  # noqa: PLC0415
    except ImportError:
        return None
    try:
        converter = OpenCC("t2s")
    except Exception:
        return None  # its conversion tables are package data; a broken install is not a failed decode

    def convert(text: str) -> str:
        return str(converter.convert(text))

    return convert


def simplified(ch: str) -> str:
    """`ch` in Simplified Chinese, or `ch` unchanged where nothing converts it.

    Reached only for a character the vocabulary does NOT hold, so a Simplified sheet never pays for it and
    a one-to-many conversion cannot overrule a character the model already knows.
    """
    convert = _opencc()
    if convert is None:
        return ch
    try:
        return convert(ch) or ch
    except Exception:
        return ch


def _transliterated(language_code: str) -> Callable[[str], Sequence[tuple[int, str]]] | None:
    """`word` -> the LATIN characters to align it as, each tagged with the index in `word` it came from.

    Per syllable fragment, so every target belongs to one grapheme run and a span maps straight back
    (XA-20) — except for a `_READ_PER_WORD` language whose fragments do not rebuild the word's own reading,
    where the word's reading is the target sequence and `WHOLE_WORD` says no fragment owns it. None without
    a backend, which leaves the original characters as the targets.
    """
    say = romanize.build_transliterator(language_code)
    if say is None:
        return None

    def read(text: str) -> str:
        # `or text`: an ALREADY-LATIN fragment gets no romanisation, and dropping it would decode a Chinese
        # sheet's English chorus as nothing at all.
        said = romanize.romanization_of(text, say) or text
        return "".join(ch for ch in said.lower() if ch.isalpha() or ch == "'")

    def chars(word: str) -> Sequence[tuple[int, str]]:
        fragments = syllables(word, language_code)
        per_fragment = [read(fragment) for fragment in fragments]
        if language_code in _READ_PER_WORD and (whole := read(word)) != "".join(per_fragment):
            return [(WHOLE_WORD, ch) for ch in whole]
        out: list[tuple[int, str]] = []
        at = 0
        for fragment, said in zip(fragments, per_fragment, strict=True):
            out.extend((at, ch) for ch in said)
            at += len(fragment)
        return out

    return chars
