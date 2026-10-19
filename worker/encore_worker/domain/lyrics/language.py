"""What language a text is in, and which model's bundle should therefore time it.

The signals, in the order `detect` trusts them: the Unicode SCRIPT histogram, then what whisper HEARD, then
lingua-py, then what the job DECLARED. PURE, and the order's argument is docs/arch/04-alignment.md §9.
"""

from __future__ import annotations

import unicodedata
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

#: The language the shipped English bundles are FOR, and this module's fallback everywhere a signal is
#: missing. Spelled here as well as in `adapters.ml.ENGLISH` because `domain/` may not import `adapters/`; a
#: test pins the two equal.
ENGLISH = "en"

#: Script names this module uses, as `script_of` reports them: canonical ISO-15924-ish spellings rather than
#: the UCD's own first word, which splits Japanese across three and could never see "this text is Japanese".
LATIN = "Latin"
HAN = "Han"
KANA = "Kana"
HANGUL = "Hangul"
CYRILLIC = "Cyrillic"
GREEK = "Greek"
ARABIC = "Arabic"
HEBREW = "Hebrew"

#: UCD-first-word -> script name, for the words that are not already the script. `KATAKANA-HIRAGANA` is the
#: prolonged sound mark, which belongs to both kana.
_SCRIPT_ALIASES: Mapping[str, str] = {
    "CJK": HAN,
    "IDEOGRAPHIC": HAN,
    "HIRAGANA": KANA,
    "KATAKANA": KANA,
    "KATAKANA-HIRAGANA": KANA,
}

#: First words that QUALIFY a script rather than naming one: `FULLWIDTH LATIN SMALL LETTER A` is Latin, and
#: `MODIFIER LETTER APOSTROPHE` is alpha with no script at all. The next word is read instead.
_QUALIFIERS = frozenset({"FULLWIDTH", "HALFWIDTH", "MODIFIER", "SMALL", "COMBINING"})

#: Words that name no writing system, so a character whose name reduces to one is NOT counted. `LETTER` is
#: what the modifier letters reduce to; the rest are the UCD's generic buckets.
_NOT_SCRIPTS = frozenset({"LETTER", "LETTERLIKE", "DIGIT", "VULGAR", "SUPERSCRIPT", "SUBSCRIPT"})

#: Script -> the languages it could be, MOST LIKELY FIRST, restricted to ones whisperx tables a model for.
#: "Refuse to choose" would mean the English bundle, which maps ZERO characters of Arabic or Cyrillic.
SCRIPT_LANGUAGES: Mapping[str, tuple[str, ...]] = {
    HAN: ("zh",),
    KANA: ("ja",),
    HANGUL: ("ko",),
    CYRILLIC: ("ru", "uk"),
    GREEK: ("el",),
    ARABIC: ("ar", "fa", "ur"),
    HEBREW: ("he",),
    "Devanagari": ("hi",),
    "Telugu": ("te",),
    "Malayalam": ("ml",),
    "Georgian": ("ka",),
}

#: Languages whisperx tables a LATIN-script alignment model for, hand-copied because `domain/` may not import
#: `adapters/`; a test asserts the copy. A detector may choose only from here.
LATIN_LANGUAGES: frozenset[str] = frozenset(
    {
        "en", "fr", "de", "es", "it", "nl", "pt", "cs", "pl", "hu", "fi", "tr", "da", "vi", "ca",
        "no", "nn", "sk", "sl", "hr", "ro", "eu", "gl", "lv", "tl", "sv", "id",
    }
)  # fmt: skip


class Detector(Protocol):
    """A LATIN-SCRIPT language detector: text -> an ISO-639-1 code, or None for "no opinion". A Protocol
    because the real one is a large optional package and every test here hands in a lambda."""

    def __call__(self, text: str) -> str | None: ...


@dataclass(frozen=True, slots=True)
class Detected:
    """The language a text is in, the script that decided it, and the sentence the trail prints. `source`
    names WHICH signal won, the signals disagreeing in ways an operator has to be able to read."""

    language: str
    script: str
    #: Share of the text's scripted characters that are `script`. 0.0 for a text with no scripted character
    #: at all (a sheet of `♪` rows), which is `default`.
    share: float
    source: str

    def why(self) -> str:
        return (
            f"language {self.language!r} from {self.source} "
            f"({self.script or 'no'} script, {self.share:.0%} of letters)"
        )


def script_of(ch: str) -> str | None:
    """The writing system `ch` belongs to, or None when it is not a scripted character.

    READ OFF THE CHARACTER'S UCD NAME rather than a range table, and A DECOMPOSABLE CHARACTER THROUGH ITS BASE
    LETTER (README, "Language: the detector's cost, and three censuses").
    """
    if not ch.isalpha():
        return None
    if unicodedata.decomposition(ch):
        # Canonical decompositions as well as compatibility ones: `U+2126 OHM SIGN` is canonical, and a
        # canonical decomposition never leaves its own script, so folding one can only turn `é` into `e`.
        folded = fold_to_base(ch)
        ch = folded[0] if folded else ch
    try:
        name = unicodedata.name(ch)
    except ValueError:
        return None  # an unnamed (private-use, unassigned) character has no script to report
    words = [word for word in name.split() if word not in _QUALIFIERS]
    first = words[0] if words else ""
    if not first or first in _NOT_SCRIPTS:
        return None
    return _SCRIPT_ALIASES.get(first, first.title())


def script_histogram(texts: Iterable[str]) -> Counter[str]:
    """How many characters of each writing system `texts` hold — the PRIMARY language signal, counted over
    characters because a target sequence is characters, and as counts so a caller sees how thin they are."""
    counts: Counter[str] = Counter()
    for text in texts:
        for ch in text:
            script = script_of(ch)
            if script is not None:
                counts[script] += 1
    return counts


def dominant_of(counts: Mapping[str, int]) -> tuple[str, float]:
    """The script holding the most of a `script_histogram`'s letters, and its share; `("", 0.0)` for none.

    THE SHARE IS NOT A THRESHOLD and nothing compares it to one — the dominant script wins at ANY share, and
    it is reported so an operator can see how thin the evidence was. Ties break on the script NAME, a replayed
    DBOS step having to reach the same bundle.
    """
    total = sum(counts.values())
    if not total:
        return "", 0.0
    best = max(sorted(counts), key=lambda name: counts[name])
    return best, counts[best] / total


def nonlatin_script(texts: Sequence[str]) -> str:
    """The NON-LATIN writing system `texts` is mostly written in, or `""` — a fact about the TEXT, asked
    where `detect`'s LANGUAGE cannot carry it: a script `SCRIPT_LANGUAGES` cannot name falls back to
    `ENGLISH`, whose bundle maps none of it (docs/arch/04-alignment.md §5.4, §11.2)."""
    script, _share = dominant_of(script_histogram(texts))
    return script if script and script != LATIN else ""


def detect(
    texts: Sequence[str],
    *,
    declared: str | None = None,
    heard: str | None = None,
    detector: Detector | None = None,
) -> Detected:
    """What language `texts` is in: the script first, then what was heard / detected / declared.

    `declared` is the job's param, `heard` is whisper's own where ASR ran on THIS recording, `detector` is
    lingua-py over Latin script. THE ORDER, and the argument for each step, is docs/arch/04-alignment.md §9.
    DETERMINISTIC AND PURE, a replayed DBOS step having to reach the same bundle.
    """
    # One histogram for the whole decision: `dominant_of` reads the counts already in hand.
    counts = script_histogram(texts)
    total = sum(counts.values())
    if not total:
        language = declared if declared in LATIN_LANGUAGES or declared in _nonlatin_languages() else None
        return Detected(language or ENGLISH, "", 0.0, "declared" if language else "default")
    script, share = dominant_of(counts)
    if script == HAN and counts[KANA]:
        # Japanese is Han + Kana; the kana are the tell, and they are a minority of the characters, so the
        # dominant script alone would call every Japanese sheet Chinese.
        return Detected("ja", KANA, counts[KANA] / total, "script")
    if script != LATIN:
        candidates = SCRIPT_LANGUAGES.get(script, ())
        for signal, name in ((heard, "heard"), (declared, "declared")):
            if signal is not None and signal in candidates:
                return Detected(signal, script, share, name)
        marked = _marked_language(texts, script, candidates, scripted=counts[script])
        if marked is not None:
            return Detected(marked, script, share, "letters")
        if candidates:
            return Detected(candidates[0], script, share, "script")
        # A script no bundle exists for (Cherokee, Canadian Syllabics). The default bundle maps none of it
        # either, so this is a decline whatever we answer; say the truth and let the trail carry it.
        return Detected(ENGLISH, script, share, "default")
    guessed = detector("\n".join(texts)) if detector is not None else None
    for signal, name in ((heard, "heard"), (guessed, "detector"), (declared, "declared")):
        if signal is not None and signal in LATIN_LANGUAGES:
            return Detected(signal, LATIN, share, name)
    return Detected(ENGLISH, LATIN, share, "default")


#: Script -> ordered (language, the letters that are EVIDENCE for it), for the scripts `SCRIPT_LANGUAGES`
#: cannot resolve alone. An ALPHABET FACT, ordered MOST SPECIFIC FIRST (Urdu contains the Persian four).
_SCRIPT_MARKERS: Mapping[str, tuple[tuple[str, str], ...]] = {
    CYRILLIC: (("uk", "іїєґІЇЄҐ"),),
    ARABIC: (("ur", "ٹڈڑںھےۓ"), ("fa", "پچژگ")),
}

#: How many of a language's exclusive letters a text must hold before they CAN decide an ambiguous script's
#: language: one is a quotation, two is the start of an alphabet.
_MIN_MARKERS = 2

#: And what SHARE of the script's letters they must be, a bare count not scaling with the sheet. Two orders
#: under what a sheet WRITTEN in the language carries (README, "Language: the detector's cost").
_MARKER_SHARE = 0.005


def _marked_language(
    texts: Iterable[str], script: str, candidates: Sequence[str], *, scripted: int
) -> str | None:
    """The candidate whose OWN letters `texts` is actually written in, or None when the letters do not say.

    `scripted` is how many letters of `script` the sheet holds: the denominator the share is OF.
    """
    joined = "\n".join(texts)
    for language, letters in _SCRIPT_MARKERS.get(script, ()):
        if language not in candidates:
            continue
        marked = sum(1 for ch in joined if ch in letters)
        if marked >= _MIN_MARKERS and marked >= _MARKER_SHARE * max(scripted, 1):
            return language
    return None


def _nonlatin_languages() -> frozenset[str]:
    """Every language `SCRIPT_LANGUAGES` can answer — so a DECLARED non-Latin language on a wordless sheet is
    still honoured rather than silently becoming English."""
    return frozenset(code for codes in SCRIPT_LANGUAGES.values() for code in codes)


def model_language(language: str, *, on_mix: bool, route_latin: bool = False) -> str:
    """The language whose alignment BUNDLE should produce the frames — which is not always the text's.

    THE ONE PLACE THE ROUTING POLICY LIVES, and it is a measurement rather than a preference: LATIN SCRIPT
    STAYS ON THE DEFAULT (ENGLISH) BUNDLE, on a stem AND on the mix, unless `route_latin`, while A NON-LATIN
    SCRIPT ALWAYS ROUTES. `language` is the TEXT's (`TextRef.language`), never this function's own answer, so
    only the emission pass and the windowed aligner read this. Both reasons each way:
    docs/arch/04-alignment.md §9 and §5.4; README, "The language reading, widened from n=7 to n=59".
    """
    if not language:
        return ENGLISH
    if language in LATIN_LANGUAGES:
        return language if (route_latin and on_mix and language != ENGLISH) else ENGLISH
    return language


def routing_note(language: str, bundle_language: str, *, on_mix: bool) -> str | None:
    """One trail sentence when the bundle's language is not the text's, else None — the substitution being
    invisible otherwise, though only one of the two bundles has a calibrated wrong-text floor."""
    if language == bundle_language:
        return None
    where = "mix" if on_mix else "stem"
    return (
        f"text language {language!r} timed by the {bundle_language!r} bundle on the {where} "
        f"(domain.lyrics.language.model_language: Latin script stays on the measured default; "
        f"set ENCORE_ALIGN_EXPERIMENTS=lang-route-mix to route it on the mix)"
    )


def fold_to_base(ch: str) -> str:
    """`ch` with its diacritics removed, for a vocabulary that lacks the composed letter.

    NFKD and nothing else, the only fold with no judgement in it; an ATOMIC letter comes back unchanged and
    is still dropped (mapping those is a measured change of its own). `ch` UNCHANGED when the fold yields
    nothing usable."""
    folded = "".join(c for c in unicodedata.normalize("NFKD", ch) if not unicodedata.combining(c))
    return folded or ch


def lingua_detector(languages: Iterable[str] = LATIN_LANGUAGES) -> Detector | None:
    """A `Detector` over lingua-py restricted to `languages`, or None when the package is absent.

    OPTIONAL BY DESIGN, so with no detector Latin script stays English — the configuration every recorded row
    was measured on. RESTRICTED TO THE LANGUAGES A BUNDLE EXISTS FOR, which is accuracy and not only speed
    (README, "Language: the detector's cost, and three censuses").
    """
    try:
        from lingua import IsoCode639_1, LanguageDetectorBuilder  # noqa: PLC0415
    except ImportError:
        return None
    codes = []
    for code in sorted(languages):
        iso = getattr(IsoCode639_1, code.upper(), None)
        if iso is not None:
            codes.append(iso)
    if len(codes) < 2:  # pragma: no cover - lingua needs two languages to choose between
        return None
    built = LanguageDetectorBuilder.from_iso_codes_639_1(*codes).build()

    def detect_one(text: str) -> str | None:
        got: Any = built.detect_language_of(text)
        if got is None:
            return None
        return str(got.iso_code_639_1.name).lower()

    return detect_one
