"""Are THESE WORDS what is sung here — not merely something sung in the right places?

WHY THIS EXISTS. Every other gate on this worker reads WHERE the singing is: the envelope gates fit a
text's spans, claimed or decoded, to the audio's vocal activity. None reads WHAT is sung, and two holes
followed. A same-video caption track (an uploader's translation, YouTube's machine-translated `en` track) fits
the singing by construction whatever its words, so the LINE_SYNC rung's sheet-span gate passed it (W1 review
r2). And the global engine's envelope gate scores OUR OWN forced decode, which the audio pulls onto the voiced
frames whatever the text is (review H3): at W1 it passed 152/320 bench wrong texts and 280/320 same-video
wrong words (`wrongtext+ownclock`), every one published with word timings.

THE TEST (review §3 item 4's self-normalised GOP, Witt & Young 2000): the text's forced-path log-probability
on the emission matrix against the same text with its WORDS SHUFFLED, per letter. A shuffle has the same
letters, the same length and the same alphabet, so the model's scale, the song's difficulty and the language
cancel out, and so does the text-free best path the review's Δ subtracts (an identical term on both sides,
since the letter count and the frames are the same): what is left is how much better THIS ORDER of these
words explains the audio than an arbitrary order of them. Sung words in their sung order explain it far
better; words that are not sung explain it no better in any order. The best of `SHUFFLES` draws is the
reference, so one lucky shuffle cannot flatter a wrong text.

THE BANDS (`BANDS`, read by `band`; W3). CALIBRATED ON THE SHIPPED DECODE (`adapters.ml.forced_align_decoder`,
no `|`, torchaudio's kernel — the review's prototype numbers were on its `|` + numba "lsep" decode) with
whisperx's `en` default, WAV2VEC2_ASR_BASE_960H, by `docs/benchmarks/forced-alignment/scripts/lift_gate.py`
(`--target stem`, `--target mix`; rows in `results/w3-lift-{stem,mix}.json`): 32 songs x (6 right texts —
truth, which every timing-only mode also serves, headers, credit, extraverse, drop20, drop50 — + 10 wrong
texts + 10 same-video wrong words) = 832 texts per target, served as the text adapters serve them
(`clean_segments`). None is under `MIN_LETTERS` (the shortest holds 201 letters).

  STEM (a vocals stem is the target; the lift is THE wrong-text gate):
    right texts   Jamendo min +0.359 (Avercage headers; drop50 +0.255), YouTube + tfr min +0.378
                  (never-be-alone extraverse; drop50 +0.281); truth +0.47..+4.34, median +2.27
    wrong texts   Jamendo max +0.189, YouTube + tfr max +0.113 (wrongtext -0.21..+0.19, median -0.02;
                  same-video wrong words -0.23..+0.14)
    held out      tau fitted on Jamendo (the midpoint of its gap, +0.274) refuses 0/60 protected right texts
                  and 0/12 drop50 on YouTube + tfr and passes 0/240 wrong; fitted on YouTube + tfr (+0.245),
                  0/100, 0/20 and 0/400 on Jamendo.
    `refuse_below` 0.2: the pooled gap's midpoint (+0.22) rounded down to the 0.05 grid, so the margin is
                  the right texts' (the lowest, a drop50, keeps +0.055) and the highest wrong text sits
                  0.011 below — which is what the doubt band above it is for. The LINE_SYNC rung's
                  `_LINE_SYNC_MIN_LIFT` is the same number over the same populations (W1 review r2).
    `ok_from`     0.3: at or above it neither split's own fit would refuse the text. The band [0.2, 0.3)
                  holds 2 right texts (Avercage and numb drop50, 0 `high` lines at W1) and no wrong one.
                  Wider costs right documents their grades and buys nothing: at 0.6 (the review's) it held
                  29 W1 right cases whose 192 `high` lines were 96% within 0.5 s — better than the 7.1% bad
                  rate of every `high` line — because low-lift stems (Avercage +0.47, never-be-alone +0.53)
                  are graded down by the claims already.
    WHY THE LIFT REPLACES THE ENVELOPE GATE ON A STEM, measured case by case over the W1 time_text bench
    (1088 cases; their outcome IS the envelope gate's), at tau 0.2:
      envelope alone   right refused 8/448 (2 protected: rap-god drop20, never-be-alone credit; 6 drop50),
                       wrong passed 152/320 + 280/320
      lift alone       right refused 0/448, wrong passed 0/320 + 0/320
      both required    right refused 8/448 (the envelope's), wrong passed 0 + 0
      either enough    right refused 0/448, wrong passed 152 + 280
    Only "lift alone" meets review §3.4's reject-if (no right text on a stem refused, including <= 20%
    missing lines; <= 1% of wrong texts passed), so on a stem the envelope fit is reported, not gated,
    wherever the lift measured the text.

  MIX (no stem; the lift gates BESIDE the envelope gate, review §3.4):
    the populations OVERLAP: right texts -0.063..+2.92 (truth median +0.75; 24/192 below 0), wrong texts
    max +0.132 (Jamendo) / +0.106 (YouTube + tfr). A right text lifting little on the mix is one the mix's
    matrix barely hears: truth texts under 0.15 — numb, Pure_Mids, Avercage, The_Rinn, feel-my-heart,
    Kinematic, Moon_I_Mean — decode blind with 0-70% of lines within 1 s (median 24%; 172/237 lines over
    2 s off), and 0 wrong text lifts that far, so no midpoint exists and the floor sits above both splits'
    wrong maxima.
    `mix_floor`   0.15 (review: ~0.1): the smallest 0.05 step above +0.132 and +0.106. Jamendo's own maximum
                  passes 0/240 wrong texts held out on YouTube + tfr; YouTube's (+0.106) would pass 2/400 on
                  Jamendo. At 0.10 the gate (blind envelope AND floor) passes 1/320 wrongtext (shape-of-you;
                  the floor alone 3 + 1).
    `mix_ok_from` 0.6 (the review's band top): on the mix the lift reads how well the words are HEARD. The
                  8 truth texts in [0.15, 0.6) decode blind with a median 55% of lines within 1 s and
                  140/343 lines over 2 s off (never-be-alone 11% within 1 s, Lower_Loveday 27%), the 17 at
                  or above it 81% and 149/1166 (`lift_gate.py`'s per-band table), so their lines are
                  `low`. (On a stem the same reading does not hold: the doubt band's right texts are
                  graded down by their claims already, see `ok_from`.)
    THE ENVELOPE GATE STAYS ON THE MIX (default), though measured there it SORTS BADLY: its blind half
    passes 122/320 wrongtext and 135/320 same-video wrong words, and on truth texts it passes decodes the
    matrix never heard (numb: lift -0.03, 0/35 lines within 1 s, r 0.47 at +0.00 s) and refuses ones it
    did (Rxbyn +1.08, 92% within 1 s; HILA 83%; Tom_Orlando 85%). With the floor, blind envelope AND lift
    refuses 114/192 right texts, the floor alone 48/192, both passing 0/640 wrong texts. Kept because that
    is the blind half only (the shipped gate also passes a REPAIRED fit, which only claims can move) and
    the bench has no stemless mode to measure the whole gate on; the default-off arm `h3-mix-lift-alone`
    drops it (`Config.align_experiments`).

EXEMPT (the step decides, `AlignStepsImpl._word_lift`): the ASR tier, whose words were heard on this audio,
a text the lift cannot measure (`lift` returns None), and a lift whose decode raised (the trail says so; the
bench scores it an ERROR row). Each keeps the envelope gate. A pin is measured but never refused: refused
words publish with every line `low` (a person chose them).

PER MODEL. Every number above is the base model's. W4's model change (HuBERT, review §3 item 6b) re-runs
`lift_gate.py --model <bundle>` for both targets and replaces `BANDS` by the same procedure, on the 0.05
grid: `refuse_below` at the pooled gap's midpoint (protected right texts and drop50 against both wrong
populations), rounded down, with each split's own fit scored on the other; `ok_from` the higher split fit,
rounded up; `mix_floor` the smallest step above both splits' wrong maxima; `mix_ok_from` where the truth
texts' blind decodes stop being poor in the per-band table. If the stem populations overlap on a model, no
threshold meets the reject-if, and the wave says so rather than picking one.

DETERMINISTIC: the shuffles are drawn from a generator seeded by the text itself (crc32, never the salted
`hash()`), so a replayed step and a bench re-run measure the same thing.

PURE. The decoder is injected (production: `adapters.ml.forced_align_decoder`), and whatever it raises
propagates: this module cannot tell a kernel that refused these targets from one that is gone, and the step
that calls it can (`adapters.ports.InfraFault`).
"""

from __future__ import annotations

import random
import zlib
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

#: `generate.Decoder`'s shape: `(log_probs, targets) -> (frame_labels, frame_scores)`.
Decoder = Callable[[Any, Sequence[int]], tuple[list[int], list[float]]]

#: How many shuffles the text is contrasted with; the BEST of them is the reference.
SHUFFLES = 3

#: Fewer alignable letters than this and the contrast is noise: a handful of words has few distinct
#: orders, and one of them sits wherever the decode puts it. The review's bands skip texts under ~40.
MIN_LETTERS = 40


@dataclass(frozen=True, slots=True)
class Lift:
    """How much better the text explains the audio than shuffles of its own words, in nats per letter."""

    value: float
    letters: int
    #: The text's own forced-path log-probability per letter, for the trail (not what the gate reads).
    per_letter: float

    def why(self) -> str:
        return (
            f"lexical lift {self.value:+.2f} nats/letter over {self.letters} letters "
            f"(the text {self.per_letter:.2f}/letter against the best of {SHUFFLES} shuffles of its words)"
        )


def letters_of(line_texts: Sequence[str], dictionary: Mapping[str, int]) -> list[int]:
    """The targets `generate` decodes `line_texts` as: every character the dictionary maps to a non-blank id,
    lowercased, word by word. The SAME rule, so a lift is measured on the decode that publishes."""
    return [
        token
        for text in line_texts
        for word in text.split()
        for ch in word.lower()
        if (token := dictionary.get(ch)) is not None and token != 0
    ]


def shuffles_of(line_texts: Sequence[str], count: int = SHUFFLES) -> list[list[str]]:
    """`count` copies of `line_texts` with the WORDS shuffled across the whole text, each line keeping its
    own word count — so every copy holds exactly the text's letters, on the text's own lines."""
    words = [word for text in line_texts for word in text.split()]
    rng = random.Random(zlib.crc32("\n".join(line_texts).encode("utf-8")))
    out: list[list[str]] = []
    for _ in range(count):
        drawn = list(words)
        rng.shuffle(drawn)
        lines: list[str] = []
        taken = 0
        for text in line_texts:
            n = len(text.split())
            lines.append(" ".join(drawn[taken : taken + n]))
            taken += n
        out.append(lines)
    return out


def lift(line_texts: Sequence[str], emissions: Any, *, decoder: Decoder) -> Lift | None:
    """The text's lexical lift on `emissions` (duck-typed: `log_probs`, `frames`, `dictionary`), or None when
    it cannot say: under `MIN_LETTERS` alignable letters, an empty matrix, or a text no shuffle changes (one
    word, repeated). Whatever the decoder raises propagates (see the module docstring)."""
    targets = letters_of(line_texts, emissions.dictionary)
    if len(targets) < MIN_LETTERS or emissions.frames == 0:
        return None
    shuffled = [lines for lines in shuffles_of(line_texts) if list(lines) != list(line_texts)]
    if not shuffled:
        return None

    def path(lines: Sequence[str]) -> float:
        _labels, scores = decoder(emissions.log_probs, letters_of(lines, emissions.dictionary))
        return float(sum(scores))

    own = path(line_texts)
    best = max(path(lines) for lines in shuffled)
    return Lift(value=(own - best) / len(targets), letters=len(targets), per_letter=own / len(targets))


class Band(StrEnum):
    """What a GLOBAL word document's lift says about its text (`band`)."""

    #: The words are not what is sung: the text is refused (`steps.records.Refused` ends it).
    REFUSE = "refuse"
    #: Published, but nothing vouches for its words: every line `low`, the document `medium`.
    DOUBT = "doubt"
    #: The words are sung: normal grading.
    OK = "ok"


@dataclass(frozen=True, slots=True)
class Bands:
    """The lift thresholds of one emission model, in nats per letter (the calibration is the module
    docstring's)."""

    #: The model they were calibrated on.
    model: str
    #: On a stem: under it, REFUSE.
    refuse_below: float
    #: On a stem: from `refuse_below` up to it, DOUBT; from it, OK.
    ok_from: float
    #: On the mix: under it, REFUSE (beside the envelope gate).
    mix_floor: float
    #: On the mix: from `mix_floor` up to it, DOUBT; from it, OK.
    mix_ok_from: float


#: The shipped bands: whisperx's `en` default model (see the module docstring for every number).
BANDS = Bands(
    model="WAV2VEC2_ASR_BASE_960H",
    refuse_below=0.2,
    ok_from=0.3,
    mix_floor=0.15,
    mix_ok_from=0.6,
)


def band(value: float, *, on_stem: bool, bands: Bands | None = None) -> Band:
    """The band a lift of `value` falls in, on a stem or on the mix (`BANDS` unless `bands` is given; read
    at call time, so a test can move them)."""
    got = bands if bands is not None else BANDS
    floor, ok = (got.refuse_below, got.ok_from) if on_stem else (got.mix_floor, got.mix_ok_from)
    if value < floor:
        return Band.REFUSE
    return Band.DOUBT if value < ok else Band.OK
