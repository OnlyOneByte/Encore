"""What language a text is in, and which model's bundle should therefore time it (review M8, §3 item 9).

WHY THIS MODULE EXISTS. Until W7 the alignment language was the literal `"en"` on every job: core sends no
`language`, no adapter set `TextRef.language`, and whisper's own `result['language']` was read off its result
dict and thrown away (`adapters.ml.WhisperTranscriber.transcribe`). Two measured consequences, both review
M8: a Japanese sheet has ZERO characters the English vocabulary maps (`generate.alignable_chars`), so every
attempt declined and the job published `no lyrics` (review repro s12); and an accented Latin letter was
silently skipped out of the target sequence, so `cafés` decoded as `cafs`. The second half of the same
finding is review M9, the hard-coded CTC blank: it is DORMANT only while the language is always `en`, because
torchaudio's English bundles put their blank at 0 and 23 of whisperx's 36 HF align models do not. So carrying
the language is also what ARMS M9, which is why the two were built together and why this module's tests and
W7's measurements both lead with a non-zero-pad model.

THE PRIMARY SIGNAL IS THE SCRIPT, NOT VOCABULARY COVERAGE (review §3 item 9, and the critics' objection the
review recorded). "Route to the model whose vocabulary covers the most characters" sounds safer and is worse:
every wav2vec2 Latin vocabulary covers English text, and the fr/de/es XLSR fine-tunes cover it MORE fully
than the English bundle covers French — so coverage would take Latin songs away from the bundle that times
them best (see `model_language` for the numbers). A Unicode SCRIPT histogram answers the question that
actually decides the bundle — "can this model's alphabet express this text at all" — and answers it from the
text alone, with no model loaded and no audio read.

THE THREE SIGNALS, in the order they are trusted (`detect`):
  1. the script histogram of the TEXT (here, stdlib `unicodedata` only — no data files, no dependency);
  2. for a script that is effectively one language among the models whisperx tables, that language;
  3. for LATIN script, which is 24 of whisperx's 42 languages and every song in this project's corpus:
     lingua-py (optional, lazily imported — see `Detector`), corroborated by what whisper HEARD and by
     whatever the job DECLARED. With no detector installed, Latin script stays `en`, which is exactly the
     behaviour every measured row in `docs/benchmarks/forced-alignment/results/` was recorded on.

PURE, and that is load-bearing twice over: `domain/` may not import adapters or torch
(`tests/test_layers.py`), and a language decision that reached for a model would have to run inside the
emission pass it is supposed to choose.
The detector is INJECTED (`detect(..., detector=...)`); `lingua_detector()` is the one factory that
touches the optional package, and it answers None rather than raising when it is absent.
"""

from __future__ import annotations

import unicodedata
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

#: The language the shipped English bundles are FOR, and this module's fallback everywhere a signal is
#: missing. Spelled here as well as in `adapters.ml.ENGLISH` on purpose: `domain/` may not import
#: `adapters/`, and the two sides must agree on the string (`tests/test_language.py` pins them equal).
ENGLISH = "en"

#: Script names this module uses, as `script_of` reports them. Canonical ISO-15924-ish spellings rather than
#: the UCD's own first word, because the UCD splits Japanese across three (`HIRAGANA`, `KATAKANA`, `CJK`)
#: and a histogram that did too could never see "this text is Japanese".
LATIN = "Latin"
HAN = "Han"
KANA = "Kana"
HANGUL = "Hangul"
CYRILLIC = "Cyrillic"
GREEK = "Greek"
ARABIC = "Arabic"
HEBREW = "Hebrew"

#: UCD-first-word -> script name, for the words that are not already the script. Everything else is read
#: from the character name's FIRST WORD and title-cased (`CYRILLIC SMALL LETTER YA` -> `Cyrillic`,
#: `DEVANAGARI LETTER KA` -> `Devanagari`), which is how one 12-entry table covers every writing system the
#: UCD names instead of a per-range table that would go stale with each Unicode release.
_SCRIPT_ALIASES: Mapping[str, str] = {
    "CJK": HAN,
    "IDEOGRAPHIC": HAN,
    "HIRAGANA": KANA,
    "KATAKANA": KANA,
}

#: First words that QUALIFY a script rather than naming one: `FULLWIDTH LATIN SMALL LETTER A` is Latin, and
#: `MODIFIER LETTER APOSTROPHE` is a letter by `str.isalpha` with no script at all. The next word is read
#: instead, which for the modifiers yields `LETTER` -> no script, i.e. the character is not counted.
_QUALIFIERS = frozenset({"FULLWIDTH", "HALFWIDTH", "MODIFIER", "SMALL", "COMBINING"})

#: Words that name no writing system, so a character whose name reduces to one is NOT counted in the
#: histogram. `LETTER` is what the modifier letters reduce to; the rest are the UCD's generic buckets.
_NOT_SCRIPTS = frozenset({"LETTER", "LETTERLIKE", "DIGIT", "VULGAR", "SUPERSCRIPT", "SUBSCRIPT"})

#: Script -> the languages it could be, MOST LIKELY FIRST, restricted to languages whisperx tables an
#: alignment model for (`adapters.ml._has_default_align_model`): a script that routed to a language with no
#: model would decline the attempt where staying on the default bundle at least decodes the Latin letters.
#: A one-entry tuple is an unambiguous script; a longer one is resolved by what whisper heard or the job
#: declared, and falls back to the first.
#:
#: WHY THE AMBIGUOUS ONES ARE ORDERED AND NOT REFUSED. Arabic script is ar/fa/ur and Cyrillic is ru/uk, and
#: whisperx tables a model for each — so "refuse to choose" would mean the English bundle, which maps ZERO
#: characters of either script (review M8's s12, the Japanese case). The first entry is the larger-corpus
#: model, and whisper's heard language (which is measured from the audio, not guessed from the glyphs) wins
#: over it whenever it is in the tuple.
#:
#: HAN IS `zh` AND KANA MAKES IT `ja`, which is the one script rule that reads two scripts at once: Japanese
#: text is Han + Kana mixed, and Chinese text is Han alone, so `detect` promotes Han to `ja` when ANY kana is
#: present. Hangul is `ko` outright. All three are W8's lane (non-Latin stages 0-2) and are routed here only
#: so that W8 inherits a language rather than a literal.
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

#: Languages whisperx tables a LATIN-script alignment model for (`DEFAULT_ALIGN_MODELS_TORCH` +
#: `_HF`, read once by hand rather than imported: `domain/` may not import `adapters/`, and whisperx is in the
#: `ml` extra). This is the set `detect` lets a Latin-script detector choose from — a detector that answered
#: `sw` or `af` would name a language no bundle exists for, and the attempt would decline where the default
#: bundle would have decoded every letter.
#:
#: `tests/test_language.py` asserts this set against whisperx's own tables when the `ml` extra is installed,
#: so the hand-copy cannot drift silently.
LATIN_LANGUAGES: frozenset[str] = frozenset(
    {
        "en", "fr", "de", "es", "it", "nl", "pt", "cs", "pl", "hu", "fi", "tr", "da", "vi", "ca",
        "no", "nn", "sk", "sl", "hr", "ro", "eu", "gl", "lv", "tl", "sv", "id",
    }
)  # fmt: skip

#: Share of a text's SCRIPTED characters one script must hold to be called the text's script. Below it the
#: text is mixed and `detect` reports the dominant script anyway but at that share, which `model_language`
#: does not read — the share exists for the trail and for W8, where a romanised Japanese sheet with CJK
#: parentheticals is a real shape. 0.5 is a majority and nothing finer is measured.
DOMINANT_SHARE = 0.5


class Detector(Protocol):
    """A LATIN-SCRIPT language detector: text -> an ISO-639-1 code, or None for "no opinion".

    A Protocol because the real one is a 90 MB optional package and every test here hands in a lambda (the
    same reason `generate.Decoder` is injected). `lingua_detector` builds the real one; `detect` treats None
    exactly as "not installed", so a box without it keeps the shipped `en` behaviour rather than failing.
    """

    def __call__(self, text: str) -> str | None: ...


@dataclass(frozen=True, slots=True)
class Detected:
    """The language a text is in, the script that decided it, and the sentence the trail prints.

    `source` names WHICH signal won, because the three disagree in ways an operator has to be able to read:
    `script` (a non-Latin script that is one language), `detector` (lingua over Latin script), `heard`
    (whisper's own `result['language']`), `declared` (the job's `language` param), `default` (nothing
    answered, so English — the behaviour every recorded bench row was measured on).
    """

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

    READ OFF THE CHARACTER'S UCD NAME rather than from a range table, which is the whole reason this is six
    lines and needs no data file: every letter the UCD names begins its name with its script
    (`LATIN SMALL LETTER E WITH ACUTE`, `HANGUL SYLLABLE HAN`, `TAMIL LETTER KA`), so one `str.split` plus a
    12-entry alias table covers every writing system Python's own Unicode database knows — including ones
    added after this was written. A range table would have to be revised on each Unicode release, and a
    missing range reads as "not a letter", which is the silent half of review M8.

    Only `str.isalpha` characters are considered: punctuation, digits and `♪` belong to no language, and a
    histogram that counted them would call a sheet of `[Chorus]` headers Latin at 100%.
    """
    if not ch.isalpha():
        return None
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
    """How many characters of each writing system `texts` hold — the PRIMARY language signal (§3 item 9).

    Counted over characters and not words, because the question it answers is the model's: a target sequence
    is characters, and a bundle whose vocabulary is Cyrillic maps none of a Latin text's (review M8's s12,
    the Japanese sheet with 0 alignable characters). The counts, not the shares, so a caller can see how
    LITTLE evidence a short text gave.
    """
    counts: Counter[str] = Counter()
    for text in texts:
        for ch in text:
            script = script_of(ch)
            if script is not None:
                counts[script] += 1
    return counts


def dominant_script(texts: Iterable[str]) -> tuple[str, float]:
    """The script holding the most of `texts`' letters, and its share. `("", 0.0)` for no letters at all.

    Ties break on the script NAME so the answer is deterministic — a DBOS step may be replayed, and a
    language that depended on dict ordering would make two replays of one attempt load two bundles.
    """
    counts = script_histogram(texts)
    total = sum(counts.values())
    if not total:
        return "", 0.0
    best = max(sorted(counts), key=lambda name: counts[name])
    return best, counts[best] / total


def detect(
    texts: Sequence[str],
    *,
    declared: str | None = None,
    heard: str | None = None,
    detector: Detector | None = None,
) -> Detected:
    """What language `texts` is in: the script first, then the detector / what was heard / what was declared.

    `declared` is the job's `language` param (an operator's room-wide setting — see `steps.api.language_of`),
    `heard` is whisper's `result['language']` where ASR ran on THIS recording, `detector` is lingua-py over
    Latin script (`lingua_detector`).

    THE ORDER, and why each step is where it is:

      * NO LETTERS AT ALL -> `declared` or English. A sheet of `♪` rows or digits says nothing, and a
        detector asked about it answers confidently and wrongly.
      * A NON-LATIN SCRIPT WINS OUTRIGHT, over `heard` and over `declared` both, whenever the script names
        exactly one language. This is the asymmetry the review asked for: the script is a FACT about the
        characters that must be in the model's vocabulary, where `heard` is an acoustic guess and `declared`
        is a room-wide default nobody set per song. A Hangul sheet is `ko` even on a job declaring `en`,
        because the English bundle maps none of its characters.
      * A SCRIPT WITH SEVERAL LANGUAGES (Arabic, Cyrillic) takes `heard` or `declared` when either names one
        of them — whisper measured the audio, so it tells fa from ar where the glyphs cannot — else the
        tuple's first entry (`SCRIPT_LANGUAGES`).
      * HAN PLUS ANY KANA IS `ja`. Japanese mixes the two; Chinese does not.
      * LATIN SCRIPT asks the detector, then `heard`, then `declared`, and accepts an answer only when it is
        a language whisperx tables a Latin bundle for (`LATIN_LANGUAGES`) — otherwise the attempt would
        decline on a missing model where the default bundle decodes every letter of it. Nothing left:
        English, which is what every measured row in `results/` was recorded on.

    DETERMINISTIC AND PURE: a DBOS step may be replayed, so a language that moved between two runs of one
    attempt would load two bundles and key two emission matrices.
    """
    counts = script_histogram(texts)
    total = sum(counts.values())
    if not total:
        language = declared if declared in LATIN_LANGUAGES or declared in _nonlatin_languages() else None
        return Detected(language or ENGLISH, "", 0.0, "declared" if language else "default")
    script, share = dominant_script(texts)
    if script == HAN and counts[KANA]:
        # Japanese is Han + Kana; the kana are the tell, and they are a minority of the characters, so the
        # dominant script alone would call every Japanese sheet Chinese.
        return Detected("ja", KANA, counts[KANA] / total, "script")
    if script != LATIN:
        candidates = SCRIPT_LANGUAGES.get(script, ())
        for signal, name in ((heard, "heard"), (declared, "declared")):
            if signal is not None and signal in candidates:
                return Detected(signal, script, share, name)
        if candidates:
            return Detected(candidates[0], script, share, "script")
        # A script no bundle exists for (Cherokee, Canadian Syllabics). The default bundle maps none of it
        # either, so this is a decline whatever we answer; say the truth and let the trail carry it.
        return Detected(ENGLISH, script, share, "default")
    guessed = detector("\n".join(texts)) if detector is not None else None
    for signal, name in ((guessed, "detector"), (heard, "heard"), (declared, "declared")):
        if signal is not None and signal in LATIN_LANGUAGES:
            return Detected(signal, LATIN, share, name)
    return Detected(ENGLISH, LATIN, share, "default")


def _nonlatin_languages() -> frozenset[str]:
    """Every language `SCRIPT_LANGUAGES` can answer — so a DECLARED non-Latin language on a wordless sheet is
    still honoured rather than silently becoming English."""
    return frozenset(code for codes in SCRIPT_LANGUAGES.values() for code in codes)


def model_language(language: str, *, on_mix: bool, route_latin: bool = False) -> str:
    """The language whose alignment BUNDLE should produce the frames — which is not always the text's.

    THE ONE PLACE THE ROUTING POLICY LIVES, and the policy is a measurement rather than a preference.

    LATIN SCRIPT STAYS ON THE DEFAULT (ENGLISH) BUNDLE, on a stem AND on the mix, unless `route_latin`.

    THE REVIEW'S READING, which this rule comes from: fr/de/es STEMS score 91.8% of words within +-300 ms
    under the English model — the same as English Jamendo's 91.1% — while routing to whisperx's per-language
    VoxPopuli fine-tunes won only on the MIX (de 50.1 -> 85.9, es 47.9 -> 62.6, fr 66.0 -> 72.2). Both halves
    were n=7 songs (2 fr, 3 de, 2 es) on the BASE bundle, which has not been the default since W5's flip, and
    the critics' objection was exactly that: "the stem result rests on n=7".

    W7's WIDENED READING, all 59 fr/de/es JamendoLyrics songs under the bundle that ships
    (`scripts/lang_gate.py --target stem`, `_runs/w7-lang/stem.json`, 2 515 measured lines / 15 887 measured
    word onsets, blind, no claims and no repair ladder). THE STEM HALF IS CONFIRMED AND WIDER THAN THE REVIEW
    FOUND IT:
      * pooled word +-300 **94.78% on the default against 92.97% routed**, +-250 94.06 against 92.13, AAE
        **236 ms against 540**, and words more than 2 s off **188 against 485** — i.e. routing more than
        doubles the catastrophic tail;
      * per song, routed WINS 20, LOSES 32 and ties 7 at +-300 (0.5 pt dead band), with the losses far deeper
        than the wins (es `Intentando_Destacar` -23.7 pt, de `Intro_[Pulsschlag]` -28.0, es `Baila` -12.8
        against fr `CHRISTMAS_AVEC_TOI` +16.0, de `Die_Revolution` +15.4);
      * per language the default wins de (+-300 96.68 against 96.39) and es (96.36 against **91.19**) and
        TIES fr (91.45 = 91.45, where routed is better at +-100, 82.53 against 77.15, and worse in the tail,
        153 words over 2 s against 85);
      * the ONE column routing wins on the stem is LINE starts — +-500 92.29% against 90.78%, and German gross
        lines 19 against 30 — which is a real effect and not the one the karaoke ball is scored on
        (`README.md`, "The language reading", carries it in full).
    The default bundle also reads 94.78% here against the review's 91.8%, so W5's flip repaid non-English
    Latin songs as well: it is now BETTER on fr/de/es stems than the base bundle was on them.

    AND THE MIX HALF DOES NOT REPRODUCE, which is the reading that decided the arm (`--target mix`,
    `results/w7-lang-mix.json`, the same 59 songs and the same texts). Pooled, routing still wins — word +-300
    80.08% against 77.47%, gross lines 372 against 415 — but the win is ONE LANGUAGE's and the per-song tally
    is against it (routed WINS 26, LOSES 32, ties 1):
      * **de reproduces the review exactly in direction**: +-300 76.73 -> **86.52**, gross 155 -> 87, words
        over 2 s off 788 -> 361 (the review's de 50.1 -> 85.9 on n=3);
      * **es is a WASH**: 78.23 -> 78.74, +0.51 pt, gross 142 -> 135, words over 2 s 742 -> 718 (the review's
        es 47.9 -> 62.6 on n=2 does not survive widening);
      * **fr REVERSES**: 77.44 -> **75.28**, gross 118 -> **150**, words over 2 s 581 -> **861** (the review's
        fr 66.0 -> 72.2 on n=2 was the wrong sign).
    So "routed models win on the mix" is true of German and of nothing else measurable here, and a default
    that routed every Latin song's mix would pay French for German.

    THE SECOND REASON, which holds whatever the mix numbers say: a routed bundle has no `lexical.CALIBRATED`
    row, so every emission-scale threshold stands down on it — the wrong-text lift cannot refuse, the doubt
    band cannot grade, the placement margin abstains. Turning it on by default would trade measured accuracy
    for an ungated wrong-text path on every non-English Latin song. The wave that fits five numbers per
    language (`lift_gate.py --model VOXPOPULI_ASR_BASE_10K_{FR,DE,ES}`, `line_gate.py --model …`) is the wave
    that may flip it — and on this reading only `de` has a case to make.

    WHAT ROUTING A NON-LATIN SCRIPT IS WORTH, measured on the one bundle whose `[PAD]` is not at 0
    (`--blank`, `results/w7-blank-nynorsk.json`, 3 songs x 143 measured lines / 1 050 measured word onsets on
    NbAiLab/nb-wav2vec2-1b-nynorsk, pad 31, id 0 the WORD SEPARATOR): the shipped chain reads word +-250
    **95.81%**, AAE 232 ms, 15 words over 2 s off, 0 lines dropped; the pre-W4 chain, with review M9's five
    hard-coded zeros back, reads **74.48%**, AAE 1 541 ms and **133** words over 2 s off on the same frames.
    That is the review's Danish regression (+-250 90.5 -> 73.2, words over 2 s 141 -> 584) reproduced on a
    REAL model rather than on permuted English columns — and it is why the language and the blank had to land
    in one wave.

    A NON-LATIN SCRIPT ALWAYS ROUTES, whatever `on_mix` and whatever the arm says, because there is nothing
    to trade off: the English vocabulary maps ZERO characters of Hangul, Han, Cyrillic or Arabic, so the
    alternative is `generate` producing no line and the ladder publishing `no lyrics` (review M8, repro s12).
    That the routed bundle is uncalibrated is handled where it matters and not by refusing to route:
    `lexical.calibration` answers None, `steps.align_steps._measured_lift` reports it on the trail, the
    envelope gate keeps the verdict and `TimedDoc.vouched` is False.

    `language` is the TEXT's language (`TextRef.language`), never this function's own answer: the document
    publishes the text's (core reads `language` off it) and the syllabifier splits on it
    (`domain.lyrics.syllabify`), so the two must not be conflated. Only the emission pass and the windowed
    aligner read this.
    """
    if not language:
        return ENGLISH
    if language in LATIN_LANGUAGES:
        return language if (route_latin and on_mix and language != ENGLISH) else ENGLISH
    return language


def routing_note(language: str, bundle_language: str, *, on_mix: bool) -> str | None:
    """One trail sentence when the bundle's language is not the text's, else None.

    EXISTS BECAUSE THE SUBSTITUTION IS INVISIBLE OTHERWISE. A French sheet timed by the English bundle and a
    French sheet timed by `VOXPOPULI_ASR_BASE_10K_FR` produce the same document shape, and only one of them
    was gated by a calibrated wrong-text floor — so an operator reading a bad report has to be able to see
    which happened without re-running the job.
    """
    if language == bundle_language:
        return None
    where = "mix" if on_mix else "stem"
    return (
        f"text language {language!r} timed by the {bundle_language!r} bundle on the {where} "
        f"(domain.lyrics.language.model_language: Latin script stays on the measured default; "
        f"set ENCORE_ALIGN_EXPERIMENTS=lang-route-mix to route it on the mix)"
    )


def fold_to_base(ch: str) -> str:
    """`ch` with its diacritics removed, for a vocabulary that lacks the composed letter (review §3 item 9).

    NFKD AND NOTHING ELSE, which is what the review specified and is also the only fold with no judgement in
    it: decompose canonically, drop every combining mark, keep the base letters. `é` -> `e`, `ü` -> `u`,
    `ñ` -> `n`, `å` -> `a`, `ﬁ` -> `fi`.

    WHAT IT DOES NOT FOLD, named because the residue is the honest limit and not an oversight: a letter that
    is ATOMIC in Unicode has no decomposition, so `ø`, `æ`, `œ`, `ß`, `đ`, `ł` and `ı` come back unchanged
    and are still dropped from the targets by whatever vocabulary lacks them. Mapping those needs a
    hand-written table (`ß` -> `ss` also changes the character COUNT, which `generate.char_targets` uses to
    place syllables), so it is a measured change of its own rather than a line here. Measured on this
    project's corpus: `scripts/lang_gate.py --folds` counts the characters each case reaches.

    RETURNS `ch` UNCHANGED when the fold yields nothing usable (`’` -> `’`, `½` -> `1⁄2`), so the caller's
    "the dictionary does not have it" branch is reached exactly as before.
    """
    folded = "".join(c for c in unicodedata.normalize("NFKD", ch) if not unicodedata.combining(c))
    return folded or ch


def lingua_detector(languages: Iterable[str] = LATIN_LANGUAGES) -> Detector | None:
    """A `Detector` over lingua-py restricted to `languages`, or None when the package is absent.

    OPTIONAL BY DESIGN (the `text` extra). lingua ships ~90 MB of n-gram models, and its absence must not
    change a verdict a worker could still reach: with no detector, Latin script stays English — which is the
    configuration every row under `docs/benchmarks/forced-alignment/results/` was measured on, so a box
    without it reproduces the published numbers exactly.

    RESTRICTED TO THE LANGUAGES A BUNDLE EXISTS FOR, which is accuracy and not only speed: lingua is far more
    reliable over a closed set, and its full set holds 75 languages this worker could not align if it named
    one (`LATIN_LANGUAGES`, and `detect` filters the answer anyway).

    `LOW_ACCURACY_MODE` deliberately NOT used: it halves the memory and loses most of its edge on the short
    texts a lyric line is. A whole sheet is handed in at once (`detect` joins the lines), which is the long
    input lingua is good at.

    WHAT IT COSTS A JOB, measured on this box rather than assumed from the wheel's 170 MB: building the
    detector is 0.05 s (the models load lazily), the FIRST detection 0.11 s, every one after it 3 ms, and the
    resident set 34 MB. Against ~5-9 s of model time per emission pass that is free — which is why the
    detector is built once at the composition root and the language is read per TEXT rather than per job.
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
