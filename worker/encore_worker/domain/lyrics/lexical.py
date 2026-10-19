"""Are THESE WORDS what is sung here — the only gate on this worker that reads WHAT rather than WHERE.

A self-normalised goodness-of-pronunciation: the text's forced-path log-probability against the same text with
its WORDS SHUFFLED, per letter. Every threshold here is an EMISSION SCALE's (XA-06), the shuffles are seeded
from the text and the decoder is injected. The recipe and the hole it does not cover:
`docs/arch/04-alignment.md` §5.1, §5.3, §5.4; README, "The lexical calibration rows, exhibit by exhibit".
"""

from __future__ import annotations

import random
import zlib
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from encore_worker.domain.lyrics.generate import Decoder as _Decoder
from encore_worker.domain.lyrics.generate import blank_of, char_ids, excluded_of
from encore_worker.domain.lyrics.language import ENGLISH
from encore_worker.domain.lyrics.units import Rules

#: The decoder contract, imported rather than restated, so the lift measures on the decode that publishes.
Decoder = _Decoder

#: How many shuffles the text is contrasted with, the BEST of them being the reference. Noisy at the bands'
#: scale, so it moves with `CALIBRATED` or not at all.
SHUFFLES = 3

#: Fewer alignable letters than this and the contrast is noise, a handful of words having few distinct orders.
MIN_LETTERS = 40


@dataclass(frozen=True, slots=True)
class Lift:
    """How much better the text explains the audio than shuffles of its own words, in nats per letter."""

    value: float
    letters: int
    #: The text's own forced-path log-probability per letter, for the trail (not what the gate reads).
    per_letter: float

    def why(self) -> str:
        # Three decimals on the lift: at two, a text at +0.195 read "lift +0.20 ..., below the gate (0.2)".
        return (
            f"lexical lift {self.value:+.3f} nats/letter over {self.letters} letters "
            f"(the text {self.per_letter:.2f}/letter against the best of {SHUFFLES} shuffles of its words)"
        )


def letters_of(
    line_texts: Sequence[str],
    dictionary: Mapping[str, int],
    exclude: Collection[int] = (0,),
    units: Rules | None = None,
) -> list[int]:
    """The targets `generate` decodes `line_texts` as, by calling its own `char_ids`, so the lift is measured
    on the exact sequence the decode publishes; `exclude` is the MATRIX's (XA-10)."""
    return [
        token
        for text in line_texts
        for word in (units.words(text) if units is not None else text.split())
        for _index, token in char_ids(word, dictionary, exclude, units)
    ]


def shuffles_of(
    line_texts: Sequence[str], count: int = SHUFFLES, units: Rules | None = None
) -> list[list[str]]:
    """`count` copies of `line_texts` with the WORDS shuffled across the whole text, each line keeping its
    own word count — so every copy holds exactly the text's letters, on the text's own lines.

    THE SHUFFLE IS THE UNIT RULE'S: with the whitespace rule a Chinese line is one word, so a "shuffle"
    only permutes whole LINES, and the contrast is far weaker than any Latin text's (XA-21).
    """
    words_of: Callable[[str], Sequence[str]] = units.words if units is not None else str.split
    words = [word for text in line_texts for word in words_of(text)]
    rng = random.Random(zlib.crc32("\n".join(line_texts).encode("utf-8")))
    out: list[list[str]] = []
    for _ in range(count):
        drawn = list(words)
        rng.shuffle(drawn)
        lines: list[str] = []
        taken = 0
        for text in line_texts:
            n = len(words_of(text))
            lines.append(" ".join(drawn[taken : taken + n]))
            taken += n
        out.append(lines)
    return out


def lift(
    line_texts: Sequence[str], emissions: Any, *, decoder: Decoder, units: Rules | None = None
) -> Lift | None:
    """The text's lexical lift on `emissions` (duck-typed), or None when it cannot say: too few letters, an
    empty matrix, or a text whose every shuffle decodes as itself. The decoder's raises propagate."""
    # `blank_of` / `excluded_of` rather than a second `getattr` with its own default: one literal per idea, or
    # the gate measures a different text from the one about to publish.
    blank = blank_of(emissions)
    excluded = excluded_of(emissions)
    targets = letters_of(line_texts, emissions.dictionary, excluded, units)
    if len(targets) < MIN_LETTERS or emissions.frames == 0:
        return None
    # A contrast is a different TARGET SEQUENCE and not a different line string: a shuffle whose letters do
    # not change is the text itself, scoring a lift of 0.0 that `band` would read as REFUSE. Reachable, so
    # such a text has no contrast left and `lift` says None instead of convicting it.
    shuffled = [
        lines
        for lines in shuffles_of(line_texts, units=units)
        if letters_of(lines, emissions.dictionary, excluded, units) != targets
    ]
    if not shuffled:
        return None

    def path(lines: Sequence[str]) -> float:
        targets_of = letters_of(lines, emissions.dictionary, excluded, units)
        _labels, scores = decoder(emissions.log_probs, targets_of, blank)
        return float(sum(scores))

    own = path(line_texts)
    best = max(path(lines) for lines in shuffled)
    return Lift(value=(own - best) / len(targets), letters=len(targets), per_letter=own / len(targets))


class Band(StrEnum):
    """What a GLOBAL word document's lift says about its text (`band`). The MEASUREMENT, not the outcome: what
    the step does with each band is its own (`align_steps._time_text_global`)."""

    #: The words are not what is sung: on a stem the text is refused, on the mix it publishes unvouched.
    REFUSE = "refuse"
    #: Every line `low` and the document `medium`; on a stem its words are also UNVOUCHED, and on the mix this
    #: band reads audibility rather than wrongness (docs/arch/04-alignment.md §5.1).
    DOUBT = "doubt"
    #: The words are sung: normal grading.
    OK = "ok"


@dataclass(frozen=True, slots=True)
class Bands:
    """ONE (emission model, language) pair's calibrated thresholds: the lift's bands in nats per letter plus
    the two other emission-scale numbers here. The table is `CALIBRATED` and every fit is in the README."""

    #: The model they were calibrated on (`adapters.ml.Emissions.model`), half of this row's key.
    model: str
    #: On a stem: under it, REFUSE. ALSO the LINE_SYNC rung's lexical floor, so one recalibration moves both.
    refuse_below: float
    #: On a stem: from `refuse_below` up to it, DOUBT; from it, OK.
    ok_from: float
    #: On the mix: under it, REFUSE — DOUBT only under `h3-mix-envelope` (README, "The stemless mode").
    mix_floor: float
    #: From `mix_floor` up to it, DOUBT; from it, OK. A GRADING threshold, never the words' standing.
    mix_ok_from: float
    #: The LINE_SYNC rung's timing gate: the share of a text's DECODED lines that must start near their mapped
    #: claim (docs/arch/04-alignment.md §5.3; `line_gate.py --model <bundle>` fits it).
    line_sync_min_agreement: float

    #: The PLACEMENT-MARGIN floor in nats, None where the rule ABSTAINS. Here because it is a raw SUM of
    #: log-probabilities (docs/arch/04-alignment.md §6; README, "The confidence rule").
    margin_floor_nats: float | None

    #: The BUNDLE's language, the other half of this row's key: MMS_FA serves zh and ko, and their lifts
    #: are not each other's (XA-21).
    language: str = ENGLISH


#: THE ROW KEY: a bundle alone cannot name a calibration, MMS_FA serving more than one language.
Key = tuple[str, str]


#: EVERY CALIBRATED (MODEL, LANGUAGE): the ONE source of truth for every emission-scale threshold here, and
#: a pair absent from it is not gated (XA-06, XA-21). README, "Per-model calibration" and "W10: the first
#: non-Latin calibration rows".
CALIBRATED: dict[Key, Bands] = {
    ("WAV2VEC2_ASR_BASE_960H", ENGLISH): Bands(
        model="WAV2VEC2_ASR_BASE_960H",
        refuse_below=0.2,
        ok_from=0.3,
        mix_floor=0.15,
        mix_ok_from=0.6,
        line_sync_min_agreement=0.5,
        margin_floor_nats=10.0,
    ),
    ("HUBERT_ASR_LARGE", ENGLISH): Bands(
        model="HUBERT_ASR_LARGE",
        refuse_below=0.45,
        ok_from=0.8,
        mix_floor=0.15,
        mix_ok_from=0.4,
        line_sync_min_agreement=0.5,
        margin_floor_nats=10.0,
    ),
    #: THE FIRST NON-LATIN ROWS (W10), fitted on the AMLL corpus rather than the English 32: zh on MMS_FA
    #: under `mms-roman`, ja on whisperx's own bundle under `nonlatin-units`, each its own route's (XA-21).
    #: ko has no row — one song, so no wrong-text population to separate.
    ("MMS_FA", "zh"): Bands(
        model="MMS_FA",
        language="zh",
        refuse_below=0.35,
        ok_from=0.70,
        mix_floor=0.05,
        mix_ok_from=0.25,
        line_sync_min_agreement=0.5,
        #: Nobody has read one of MMS_FA's trellises, so the placement-ambiguity rule abstains.
        margin_floor_nats=None,
    ),
    ("jonatasgrosman/wav2vec2-large-xlsr-53-japanese", "ja"): Bands(
        model="jonatasgrosman/wav2vec2-large-xlsr-53-japanese",
        language="ja",
        refuse_below=0.35,
        ok_from=0.70,
        mix_floor=0.05,
        mix_ok_from=0.15,
        line_sync_min_agreement=0.5,
        margin_floor_nats=None,
    ),
    ("HUBERT_ASR_XLARGE", ENGLISH): Bands(
        model="HUBERT_ASR_XLARGE",
        refuse_below=0.35,
        ok_from=0.5,
        mix_floor=0.15,
        mix_ok_from=0.3,
        line_sync_min_agreement=0.5,
        #: NOT MEASURED, and that is the point of the field being optional: nobody has read one of this
        #: bundle's trellises, so the placement-ambiguity rule abstains rather than read another's nats.
        margin_floor_nats=None,
    ),
}

#: WHISPERX'S `en` TABLE DEFAULT, AND NO LONGER THIS WORKER'S. A reader that means "the model these frames
#: came from" must go through `calibration(emissions, language)`.
BANDS = CALIBRATED[("WAV2VEC2_ASR_BASE_960H", ENGLISH)]

#: THE LINE_SYNC RUNG'S SHARE FOR A MATRIX WITH NO ROW, and the ONE threshold a missing calibration does not
#: switch off, being a count of lines. The three ENGLISH rows each fit it; the two non-Latin rows TAKE it
#: (README, "`line_sync_min_agreement` is 0.5, and the sweep says why"; docs/arch/04-alignment.md §5.4).
LINE_SYNC_SHARE_UNCALIBRATED = 0.5


def line_sync_share(bands: Bands | None) -> float:
    """The LINE_SYNC rung's decode-agreement share for a matrix whose calibration is `bands`: that model's
    own, else `LINE_SYNC_SHARE_UNCALIBRATED` — a missing row meaning "do not judge this matrix's
    LOG-PROBABILITIES by another model's", not "publish a sheet no witness read"."""
    return bands.line_sync_min_agreement if bands is not None else LINE_SYNC_SHARE_UNCALIBRATED


#: Wrong texts the v2 ENVELOPE gate let through — an uncalibrated bundle's only other gate.
ENVELOPE_WRONG_TEXT_PASSES = "189 of 380"


def may_time_words(bands: Bands | None, *, heard_on_this_audio: bool, nonlatin_script: str = "") -> bool:
    """Whether a WORD document may publish off a matrix whose calibration row is `bands`: only where a
    witness read THESE WORDS — that row's lift, or a transcript of this recording.

    A NON-LATIN text timed by an ENGLISH row found a FALLBACK and not this lane's witness, so it is declined
    even though the row exists; a non-Latin text on its OWN calibrated pair is not (XA-06, XA-21;
    docs/arch/04-alignment.md §5.4). The row's LANGUAGE is read off the row, a second argument for it being
    able to disagree with the row it describes.
    """
    if heard_on_this_audio:
        return True
    if bands is None:
        return False
    return not (nonlatin_script and bands.language == ENGLISH)


def words_ungated(why: str) -> str:
    """Why words are declined for want of a gate, in the one sentence every engine prints."""
    return (
        f"no wrong-text gate can read this text: {why} — and the envelope gate it would fall back to "
        f"passed {ENVELOPE_WRONG_TEXT_PASSES} of the bench's wrong texts, so this bundle may time LINES "
        f"but not WORDS"
    )


def unnamed_script(script: str, bundle: str) -> str:
    """Why `bundle`'s calibration row cannot read a text in `script`: `language.SCRIPT_LANGUAGES` names no
    language for it, so the text routes to English by FALLBACK (docs/arch/04-alignment.md §5.4)."""
    return (
        f"this text is written in {script}, which no alignment bundle here is for, so {bundle} timed it — "
        f"and that row's bands were fitted on text this bundle's vocabulary can spell"
    )


def margin_floor(bands: Bands | None) -> float | None:
    """The placement-margin floor in nats for a matrix whose calibration is `bands`, else None — which is
    ABSTAIN. The mirror image of `line_sync_share`: a share counts lines, a margin sums log-probabilities."""
    return bands.margin_floor_nats if bands is not None else None


def calibrated_pairs() -> list[str]:
    """Every calibrated `(model, language)` as `MODEL/language`, for the one sentence a refusal prints."""
    return sorted(f"{model}/{code}" for model, code in CALIBRATED)


def is_calibrated(model: str, language: str = ENGLISH) -> bool:
    """Whether `(model, language)` has a calibration row — what an operator knob that NAMES a model must
    check before a worker starts on it, so the refusal is loud rather than a job whose gates stop gating."""
    return (model, language) in CALIBRATED


def calibration(emissions: Any, language: str = ENGLISH) -> Bands | None:
    """The calibrated row for the matrix `emissions` came from while serving `language`, or None when that
    pair has none — never "use the default", and never a NEIGHBOUR's row on the same bundle (XA-06, XA-21).

    `language` is the BUNDLE's, so every Latin text on the English bundle keeps the English row.
    """
    named = str(getattr(emissions, "model", "") or "")
    if not named and language == ENGLISH:
        return BANDS
    return CALIBRATED.get((named or BANDS.model, language))


def uncalibrated(model: str, language: str = ENGLISH) -> str:
    """Why a matrix from `model` serving `language` cannot be judged here — the one sentence every reader
    prints, so the trail says the same thing wherever the refusal to gate happened."""
    return (
        f"no lexical calibration for {model} on {language!r} (a row is one bundle's AND one language's, and "
        f"these thresholds are {', '.join(calibrated_pairs())}'s): recalibrate with scripts/lift_gate.py "
        f"--model {model} --language {language} before reading it as a verdict"
    )


def band(value: float, *, on_stem: bool, bands: Bands) -> Band:
    """The band a lift of `value` falls in, on a stem or on the mix, READ OFF `bands` and never a default.

    `bands` IS REQUIRED on purpose: with a fallback, one forgotten keyword answered DOUBT where the running
    bundle's own row answers REFUSE. Required, "no row" is a type error at the call site (XA-06).
    """
    floor, ok = (bands.refuse_below, bands.ok_from) if on_stem else (bands.mix_floor, bands.mix_ok_from)
    if value < floor:
        return Band.REFUSE
    return Band.DOUBT if value < ok else Band.OK
