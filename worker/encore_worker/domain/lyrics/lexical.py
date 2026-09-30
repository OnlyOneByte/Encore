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
better; words that are not sung explain it no better in any order — EXCEPT words whose LETTERS are the sung
ones in the sung order, the hole this test does not close (NOT COVERED below: a cognate translation). The
best of `SHUFFLES` draws is the reference, so one lucky shuffle cannot flatter a wrong text.

THE BANDS (`BANDS`, read by `band`; W3). CALIBRATED ON THE SHIPPED DECODE (`adapters.ml.forced_align_decoder`,
no `|`, torchaudio's kernel — the review's prototype numbers were on its `|` + numba "lsep" decode) with
whisperx's `en` default, WAV2VEC2_ASR_BASE_960H, by `docs/benchmarks/forced-alignment/scripts/lift_gate.py`
(`--target stem`, `--target mix`; rows in `results/w3-lift-{stem,mix}.json`, each naming the bundle it was
measured on — `BANDS.model`, held to it by a test — so a later model's rows cannot be read as these):
32 songs x (6 right texts —
truth, which every timing-only mode also serves, headers, credit, extraverse, drop20, drop50 — + 10 wrong
texts + 10 same-video wrong words) = 832 texts per target, served as the text adapters serve them
(`clean_segments`). None is under `MIN_LETTERS` (the shortest holds 201 letters).

RE-READ ON W4's EXACT 20 ms CLOCK (W4 review r1). Every lift is measured on an emission matrix, and 6a
changed every matrix, so the whole recipe was re-run on the shipped tree and these are ITS rows
(`results/w4-lift-{stem,mix}.json`, replayable with `lift_gate.py --from`; W3's are kept beside them as
`w3-lift-*`). The bands did not have to move — each stayed the same multiple of 0.05 — but the MARGINS did,
and the stem floor's head-room below the wrong population is now 0.0082 rather than 0.011, so the sentence
that calls it "a hair" is if anything more true. Both facts are named at each threshold below.

  STEM (a vocals stem is the target; the lift is THE wrong-text gate):
    right texts   Jamendo min +0.350 (Avercage headers; drop50 +0.264), YouTube + tfr min +0.348
                  (never-be-alone extraverse; drop50 +0.368); truth +0.45..+4.33, median +2.27
    wrong texts   Jamendo max +0.192 (Lower_Loveday x tfr-mayday; Cortez x The.madpix.project +0.187 behind
                  it), YouTube + tfr max +0.124 (wrongtext -0.18..+0.19, median -0.02; same-video wrong
                  words -0.24..+0.18, median -0.02)
    held out      tau fitted on Jamendo (the midpoint of its gap, +0.271) refuses 0/60 protected right texts
                  and 0/12 drop50 on YouTube + tfr and passes 0/240 wrong; fitted on YouTube + tfr (+0.236),
                  0/100, 0/20 and 0/400 on Jamendo.
    `refuse_below` 0.2: the pooled gap's midpoint (+0.228) rounded down to the 0.05 grid, so the margin is
                  the right texts' (the lowest, a drop50, keeps +0.064) while the highest wrong text sits
                  0.0082 BELOW the floor — a hair, and on the scale REDRAW NOISE (below) moves a text by.
                  The doubt band above the floor is NOT that margin: a doubt-band text publishes. What the
                  band withholds is the text's STANDING — every line `low`, the document `medium` and
                  `vouched: false` on the wire, so core's `isAuthoritativeText` is false and a document
                  a gate passed outranks it (W3 review r1) — which is what a wrong text landing just over
                  the floor costs. WHOSE document that rival is, exactly (W3 review r2): a doubted word
                  document is
                  `usable`, so `policy.decide` ACCEPTS it, the search commits and `workflows.align`
                  publishes and returns — the candidate texts still unturned are never timed, so this
                  wave's ladder produces no rival row to lose to. The demotion bites ACROSS JOBS, which is
                  where the threat lives: an earlier align's stored candidate, or the re-run a person
                  triggers after seeing wrong words, outranks it, and core's never-regress keeps the
                  doubted text from displacing what is already shown. On a song's FIRST align it is the
                  only candidate, so it is shown — `low` everywhere, with the trail's reason.
                  The LINE_SYNC rung reads THIS number over the same populations (W1 review r2):
                  `align_steps._time_line_sync` calls `band`, so one recalibration moves both gates.
    `ok_from`     0.3: at or above it neither split's own fit would refuse the text. The band [0.2, 0.3)
                  holds 2 right texts (Avercage and numb drop50, 0 `high` lines at W1) and no wrong one.
                  Wider costs right documents their grades and buys nothing: at 0.6 (the review's) it held
                  29 W1 right cases whose 192 `high` lines were 96% within 0.5 s — better than the 7.1% bad
                  rate of every `high` line — because low-lift stems (Avercage +0.47, never-be-alone +0.53)
                  are graded down by the claims already.
    WHY THE LIFT REPLACES THE ENVELOPE GATE ON A STEM, measured case by case over the W1 time_text bench
    (1088 cases; their outcome IS the envelope gate's), at tau 0.2, on `lift_gate.py`'s lifts — i.e. on the
    CLEANED texts production serves (`clean_segments`), which is also what the bench's `run_align` level
    serves:
      envelope alone   right refused 8/448 (2 protected: rap-god drop20, never-be-alone credit; 6 drop50),
                       wrong passed 152/320 + 280/320
      lift alone       right refused 0/448, wrong passed 0/320 + 0/320
      both required    right refused 8/448 (the envelope's), wrong passed 0 + 0
      either enough    right refused 0/448, wrong passed 152 + 280
    Only "lift alone" meets review §3.4's reject-if (no right text on a stem refused, including <= 20%
    missing lines; <= 1% of wrong texts passed), so on a stem the envelope fit is reported, not gated,
    wherever the lift measured the text.
    THE TABLE'S POPULATION IS THE CLEANED ONE, and `letters_of` counts every letter it is handed: on the
    bench's `time_text` level, which serves a provider's RAW claims (`♪`, credit lines, the lines
    `clean_segments` drops), 230 of the 832 texts move by up to +-0.15 (`_runs/w3-rejudge/raw_lifts.py`), and
    ONE wrong text crosses the floor — LUNABLIND #2 at +0.217 raw against +0.189 cleaned. So the shipped
    `time_text` level publishes 1/320 `wrongtext` (a doubt-band document: every line `low`, ranked under a
    vouched document) where `run_align` publishes 0/320. EACH LEVEL'S COUNT IS CAPPED AT THE LEVEL IT WAS
    MEASURED ON (W3 review r2): `gates/w3.yaml` holds the shared 1/320 (its literal is `time_text`'s, so at
    `run_align` a regression from 0 to 1 would have cleared it), and `gates/w3-run_align.yaml` holds
    `run_align`'s own 0 absolutely. So a second wrong text cannot start publishing unnamed at either level.

  MIX (no stem): the lift's FLOOR is the wrong-text gate here too, as it is on a stem (W4 review r1 flipped
  it; W3 shipped the envelope gate in this role and the stemless bench mode measured both).
    the populations OVERLAP: right texts -0.045..+2.85 (truth median +0.66; 24/192 below 0), wrong texts
    max +0.102 (Jamendo: Tom_Orlando x Lower_Loveday) / +0.115 (YouTube + tfr: shape-of-you x numb). A right
    text lifting little on the mix is USUALLY one the mix's matrix barely hears: truth texts under 0.15 —
    numb, Pure_Mids, Avercage, The_Rinn, feel-my-heart, Kinematic, Moon_I_Mean — decode blind with 0-70% of
    lines within 1 s (median 24%; 172/237 lines over 2 s off), and 0 wrong text lifts that far, so no midpoint
    exists and the floor sits above both splits' wrong maxima.
    `mix_floor`   0.15 (review: ~0.1): the smallest 0.05 step above +0.102 and +0.115, with 0.035 of
                  head-room over the higher of them. Jamendo's own maximum passes 1/120 wrong texts held out
                  on YouTube + tfr; YouTube's (+0.115) would pass 0/400 on Jamendo. At 0.10 the floor alone
                  passes 2/320 wrongtext and 0/320 same-video wrong words.
                  AND IT IS A VERDICT (W4 review r1). W3 left it grading only, because its cost lands on the
                  only songs it can reach — no vocals stem, so every text of that song faces this matrix, and
                  a refusal there is terminal (`policy.decide` rule 0 answers `Refused` with NextText, and
                  the LINE_SYNC rung declines a stemless song). That cost is real and is confirmed on the
                  corpus: 48 of the 192 right texts lift below the floor — 37 of the 160 protected ones and
                  7 of the 32 TRUTH texts (numb -0.045, Avercage -0.012, The_Rinn -0.010, Pure_Mids +0.027,
                  feel-my-heart +0.038, Color_Out +0.117, Moon_I_Mean +0.127) — and "the matrix barely hears
                  it" does not hold case by case (Moon_I_Mean's truth text lifts +0.127 with 69.8% of its
                  blind lines within 1 s).
                  WHAT DECIDED IT is that the alternative costs MORE of the same thing, measured end to end
                  by W4's stemless bench mode (`e2e.py --no-stem`, 32 songs x truth/blind/drop20/drop50 + 2
                  wrong donors per song, 192 cases per arm; `gates/w4-stemless.yaml`, README's "The stemless
                  mode"). The envelope gate refuses 51 of the 128 right-text cases against the floor's 37,
                  10 of the 32 truth texts against 7, and 9 of its refusals lift at or above the floor
                  (Tom_Orlando +1.465, Rxbyn +1.081, Ridgway +1.061, tfr-mayday +0.943, HILA +0.872 ...) —
                  and IT ADMITS 27 OF 64 WRONG TEXTS, 42.2% where review §3.4 allows 1% — THIS MODULE OWNS
                  THAT FIGURE and every other site defers to it, because it was re-measured in place: the
                  pre-r1 recording of the same configuration admitted 26 (40.6%), and the re-record under the
                  post-flip name added `Kinematic_-_Peyote` under The.madpix.project's sheet (lift -0.0056,
                  a text the floor refuses and whose envelope fit clears the gate). Meanwhile it publishes
                  the four worst right-text documents it has (The_Rinn at lift -0.010: 2 of 46 lines within
                  ±500 ms with 44 gross). The floor publishes 91 of the 128 to its 77, 53.5% of their line
                  starts within ±500 ms to 42.3%, the same gross count (851 vs 853) and 0 of 64 wrong texts.
                  So it is not a choice between a strict gate and a lenient one — the envelope gate is both
                  stricter on right texts and looser on wrong ones — and the mix now follows the stem's rule.
                  THE OLD BEHAVIOUR IS THE CONTROL ARM `h3-mix-envelope` (`Config.align_experiments`): the
                  envelope gate is the mix's only verdict and this floor merely grades, and THE ROW IT WAS
                  RECORDED ON IS `results/w4-stemless-envelope-time_text.json` (the shipped default's own row
                  is `results/w4-stemless-time_text.json`; both on code `8c576cc6200b02a0`, W4 rebench r2).
                  `h3-mix-floor` still means BOTH gates — W3's first shipping, and what setting both arm
                  names means — and it publishes 54 of the 128, the two costs paid together.
    `mix_ok_from` 0.6 (the review's band top): on the mix the lift reads how well the words are HEARD. The
                  8 truth texts in [0.15, 0.6) decode blind with a median 55% of lines within 1 s and
                  140/343 lines over 2 s off (never-be-alone 11% within 1 s, Lower_Loveday 27%), the 17 at
                  or above it 81% and 149/1166 (`lift_gate.py`'s per-band table), so their lines are
                  `low`. (On a stem the same reading does not hold: the doubt band's right texts are
                  graded down by their claims already, see `ok_from`.)
                  A GRADING THRESHOLD ONLY: this band does NOT withhold the text's standing (W3 review r2).
                  It was fitted to how audible the words are, not to whether they are the right ones, and
                  on the mix it holds most of the RIGHT texts — 104 of the 192 lift under 0.6 (48 under
                  `mix_floor`, 56 in [0.15, 0.6)), and 15 of the 32 TRUTH texts (7 and 8). Sending
                  `vouched=False`
                  with it would withhold the standing of over half the correct provider sheets of every
                  stemless song, so `isAuthoritativeText` would be false and `lyricsRank` 3 — and
                  any authoritative LINE document of an earlier job (rank 4) would displace a correct
                  word-timed sheet. What the WORDS' axis reads on the mix is the floor decision only
                  (`mix_floor`: above every wrong text's lift on both splits), so a sub-floor mix text
                  publishes UNVOUCHED and a doubt-band one publishes vouched with its lines `low`
                  (`align_steps._time_text_global`).
    WHY THE ENVELOPE GATE IS NO LONGER THE MIX'S VERDICT, on the same rows: its blind half passes 122/320
    wrongtext and 135/320 same-video wrong words, and on truth texts it passes decodes the matrix never heard
    (numb: lift -0.03, 0/35 lines within 1 s, r 0.47 at +0.00 s) and refuses ones it did (Rxbyn +1.08, 92%
    within 1 s; HILA 83%; Tom_Orlando 85%) — it is ANTI-CORRELATED with the document, not merely weak. With
    the floor, blind envelope AND lift refuses 114/192 right texts, the floor alone 48/192, both passing
    0/640 wrong texts. W3 kept it anyway because that was the blind half only (the shipped gate also passes a
    REPAIRED fit, which only claims can move) and the bench had no stemless mode to measure either gate whole.
    It has one now and the whole gate sorts no better (51 of 128 right texts refused, 27 of 64 wrong passed,
    with truth claims to repair the fit), so it is reported and not gated here — exactly as on a stem —
    wherever the lift measured the text. It is still the ONLY gate where the lift could not measure one at
    all (`align_steps._word_lift`: the ASR tier, a text under `MIN_LETTERS`, a decode that raised, a matrix
    from another model), because "none doubted it" must not read as "one passed it".

NOT COVERED (measured, and the reason this gate is a floor and not a proof): A TRANSLATION WHOSE WORDS SHARE
THE SUNG ONES' LETTERS IN ORDER. The test contrasts an order of THESE letters with other orders of the same
letters, so a cognate-heavy translation of the sung line keeps much of the sung letter sequence and lifts
like a right text: on the CTC fixture a German cognate text lifts +1.98 where a French text of the same
lines reads -0.12 and the sung words read +15.2 (`tests/test_lexical.py`, `tests/test_lexical_gate.py`). No
band separates that, on either target. It matters MOST on the global path, which this module's `BANDS` gate:
a cognate translation landing in `OK` publishes a WORD document with `high` lines, where the same text
through the LINE_SYNC rung publishes lines graded `low` (`align_steps._time_line_sync`). The corpus holds no
real translation to measure it on (every caption track is `en`, and JamendoLyrics MultiLang gives each song
ONE language), so `wrongtext+ownclock` — another song's words on this song's own clock — stands in for a
translation's arbitrary word order only, never for its letters. A defence is unbuilt; the fixture texts are
the tests to turn around when one lands.

REDRAW NOISE (measured, `_runs/w3-rejudge/seed_probe.py`: the 16 near-floor stem texts x 60 random shuffles,
best-of-3 resampled). `lift` reads ONE crc32-seeded draw, and a redraw moves a text by an SD of 0.03-0.07
nats/letter — the scale of the 0.0082 the floor clears the wrong population by, against a pooled right/wrong
gap of 0.072. Per redraw ~0.6 of the 640 wrong texts would pass (P: LUNABLIND #2 44%, Cortez #1 7%, Cortez
ownclock #4 9%, every other <= 2%), i.e. ~0.1% — inside review §3.4's 1%, but not the 0 this one draw reads;
a drop50 right text would be refused with P 31% (Color_Out), 15% (numb), 5% (Avercage), and a PROTECTED
right text never (p05 >= +0.268). So the floor's guarantee is the reject-if's 1%, not zero, and what a wrong
text just over the floor costs is the doubt band's demotion (see `refuse_below`). Narrowing the estimator is
cheap and unbuilt: more `SHUFFLES`, or the MEAN of the shuffles' path scores instead of the best of three
(the best is what stops one lucky shuffle flattering a wrong text, so a mean needs its own floor). Either
moves every number in this docstring, so it belongs to a recalibration (PER MODEL) and its reject-if, not to
a live tree.

EXEMPT (the step decides, `AlignStepsImpl._word_lift` / `_measured_lift`): the ASR tier, whose words were
heard on this audio, a text the lift cannot measure (`lift` returns None), a lift whose decode raised (the
trail says so; the bench scores it an ERROR row), and A MATRIX FROM ANOTHER MODEL (below). Each keeps the
envelope gate, and NONE of them is a pass: `TimedDoc.vouched` is False for an unmeasured non-ASR text, since
"no gate doubted these words" and "no gate read them" are not the same claim (W3 review r2). A pin is
measured but never refused: refused words publish with every line `low` and `vouched: false` (a person
chose them, so the words are not judged a wrong text — but nothing vouches for them either, and core must
not read them as a claim).

ONLY ON THE MODEL THEY WERE MEASURED ON (W3 review r2). The emission model is chosen PER LANGUAGE, not per
wave — `adapters.ml.WhisperXAligner._aligner` calls `whisperx.load_align_model(language_code=...)`, and this
worker deliberately supports every language whisperx tables (de/es/fr are wav2vec2-XLSR fine-tunes: another
scale, another vocabulary, so another lift distribution). Nothing in the lift reads the language, so the
bands would be applied to whatever bundle the song's language loaded. `Emissions.model` names the bundle it
came from, and `_measured_lift` treats a matrix whose name is not `BANDS.model` exactly as an unmeasurable
one: the lift stays on the trail as a READING, the envelope gate decides, and the text is not vouched for.
A matrix that names no model at all (a test's fake, a bench cache written before the field existed) is read
as the bands' own — the shipped adapter always names one.

PER MODEL AND PER TEXT NORMALISATION. Every number above is the base model's, measured on the texts
`clean_segments` produces. A CHANGE TO EITHER invalidates `BANDS`, and normalisation moves lifts by the same
order a model does: diffing the wave's own rows case by case — `results/w4-time_text.cases.jsonl` (a
provider's RAW claims) against `results/w4-run_align.cases.jsonl` (the same texts through `clean_segments`),
1088 keys on both sides — 302 cases move, by a median 0.022, a p90 of 0.072 and a maximum of 0.147
(Kinematic `wrongtext+ownclock` #1, -0.040 raw against +0.108 cleaned), against the 0.0082 by which
`refuse_below` clears the wrong population and the 0.064 margin the lowest right text keeps. One case
crosses the floor: LUNABLIND #2 `wrongtext`, +0.232 raw and +0.172 cleaned, which is exactly the 1/320 the
`time_text` level publishes and `run_align` does not. (W3's rows read the same shape on the old clock — 302
cases, median 0.026, max 0.153 — which is the point: the clock moves every lift and moves this diff not at
all.) So W5's text-hygiene wave (`clean.py`: anchored
section headers, rolling captions, ad-libs) owes this record the same reject-if a model change does: re-run
`lift_gate.py` for BOTH targets and re-read every threshold, or state case by case that no served text
moved. W4's model change (HuBERT, review §3 item 6b) re-runs
`lift_gate.py --model <bundle>` for both targets and replaces `BANDS` by the same procedure, on the 0.05
grid: `refuse_below` at the pooled gap's midpoint (protected right texts and drop50 against both wrong
populations), rounded down, with each split's own fit scored on the other; `ok_from` the higher split fit,
rounded up; `mix_floor` the smallest step above both splits' wrong maxima; `mix_ok_from` where the truth
texts' blind decodes stop being poor in the per-band table. If the stem populations overlap on a model, no
threshold meets the reject-if, and the wave says so rather than picking one. `BANDS` is the ONE place each
number lives — the LINE_SYNC rung and the bench's `lift_gate.py` / `line_gate.py` read it, none of them
carries a copy — so replacing this record is the whole change. A recalibration is also where a wider
`SHUFFLES` or a mean reference belongs (REDRAW NOISE): re-run `lift_gate.py` both ways and keep whichever
population separates further, since either changes the numbers the bands are read off.

DETERMINISTIC: the shuffles are drawn from a generator seeded by the text itself (crc32, never the salted
`hash()`), so a replayed step and a bench re-run measure the same thing.

PURE. The decoder is injected (production: `adapters.ml.forced_align_decoder`), and whatever it raises
propagates: this module cannot tell a kernel that refused these targets from one that is gone, and the step
that calls it can (`adapters.ports.InfraFault`).
"""

from __future__ import annotations

import random
import zlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from encore_worker.domain.lyrics.generate import Decoder as _Decoder
from encore_worker.domain.lyrics.generate import blank_of

#: THE decoder contract, imported rather than restated: `generate.Decoder` gained its `blank` argument in
#: review M9's fix, and a second copy of the shape here would have kept the lift measuring on blank 0 while
#: the decode that publishes moved (one literal per idea — W2 review r1's rule). `blank_of`, beside it, is
#: the other half of that contract and is imported for the same reason (W4 review r1).
Decoder = _Decoder

#: How many shuffles the text is contrasted with; the BEST of them is the reference. Three is a NOISY
#: estimator at the bands' scale (SD 0.03-0.07 nats/letter per redraw, module docstring REDRAW NOISE); raising
#: it narrows the spread and moves every calibrated number, so it moves with `BANDS`, never alone.
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
        # THREE DECIMALS on the lift, not two (W3 review r2): both gates print this string beside the
        # threshold they compared it to (`align_steps`), and at two decimals a text at +0.195 read
        # "lexical lift +0.20 ..., below the lexical gate (0.2)" — the one note that makes a wrong-lyrics
        # report debuggable, contradicting itself at the boundary it is read at most. The bands are set on
        # a 0.05 grid with margins of 0.008, and the bench's `lift` field stores full precision, so the note
        # matches the precision the decision is taken on. The per-letter reading stays at two: it is
        # context (a scale), not a number anything is compared to.
        return (
            f"lexical lift {self.value:+.3f} nats/letter over {self.letters} letters "
            f"(the text {self.per_letter:.2f}/letter against the best of {SHUFFLES} shuffles of its words)"
        )


def letters_of(line_texts: Sequence[str], dictionary: Mapping[str, int], blank: int = 0) -> list[int]:
    """The targets `generate` decodes `line_texts` as: every character the dictionary maps to a non-blank id,
    lowercased, word by word. The SAME rule, so a lift is measured on the decode that publishes — which is
    why `blank` is an argument and not a 0 (review M9): on a vocabulary whose pad is elsewhere, a filter
    that drops id 0 drops a LETTER, and the lift would then be the score of a different text than the one
    the gate is about to publish."""
    return [
        token
        for text in line_texts
        for word in text.split()
        for ch in word.lower()
        if (token := dictionary.get(ch)) is not None and token != blank
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
    it cannot say: under `MIN_LETTERS` alignable letters, an empty matrix, or a text every shuffle of which
    decodes as the text itself (one word repeated; a `na na na` chant, whose word order carries no
    information to test). Whatever the decoder raises propagates (see the module docstring)."""
    # `blank_of`, NOT a second `getattr` with its own default (W4 review r1): the rule that made this module
    # import `generate.Decoder` rather than restate it — one literal per idea — applies to the other half of
    # the same contract. A copy here would keep the GATE measuring on blank 0 if the decode that publishes
    # ever moved (e.g. to preferring `specials['[pad]']`, or to raising on a matrix that names a column it
    # does not have), and the lift would then be the score of a different text than the one about to publish.
    blank = blank_of(emissions)
    targets = letters_of(line_texts, emissions.dictionary, blank)
    if len(targets) < MIN_LETTERS or emissions.frames == 0:
        return None
    # A CONTRAST IS A DIFFERENT TARGET SEQUENCE, not a different line string (W3 review r2). The lines are
    # what a reader sees; `path` scores `letters_of`, which lowercases and drops every character the
    # dictionary has no id for. A shuffle whose LINES differ while its letters do not is the text itself
    # under another name — its forced path is the text's, so `best == own` and the lift is exactly 0.0,
    # which `band` reads as REFUSE. Real and reachable: `["na na na na na", "na na nana na", ...]` (40
    # alignable letters, past `MIN_LETTERS`) permutes to the same letters, and a chant, a `la la la` outro
    # or a hook-only caption track is the shape. Filtered on the targets, such a text has no contrast left
    # and `lift` says so (None: the envelope gate keeps it) instead of convicting it.
    shuffled = [
        lines
        for lines in shuffles_of(line_texts)
        if letters_of(lines, emissions.dictionary, blank) != targets
    ]
    if not shuffled:
        return None

    def path(lines: Sequence[str]) -> float:
        _labels, scores = decoder(emissions.log_probs, letters_of(lines, emissions.dictionary, blank), blank)
        return float(sum(scores))

    own = path(line_texts)
    best = max(path(lines) for lines in shuffled)
    return Lift(value=(own - best) / len(targets), letters=len(targets), per_letter=own / len(targets))


class Band(StrEnum):
    """What a GLOBAL word document's lift says about its text (`band`). The MEASUREMENT, not the outcome:
    what the step does with each band is its own (`align_steps._time_text_global`) — a pin is never refused,
    and on the mix `REFUSE` is published as `DOUBT` unless an arm makes it a verdict (see `mix_floor`)."""

    #: The words are not what is sung. On a stem, the text is refused (`steps.records.Refused` ends it); on
    #: the mix it publishes, and it is the one band there whose words go out unvouched (see `mix_floor`).
    REFUSE = "refuse"
    #: Every line `low` and the document `medium`, on both targets. ON A STEM its words are also UNVOUCHED
    #: (`vouched: false`, so core ranks it under a document a gate passed); on the MIX they are not — there
    #: this band reads audibility, not wrongness, and holds most of the corpus's right texts (`mix_ok_from`).
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
    #: On the mix: under it, REFUSE — a verdict since W4 review r1, published as DOUBT only under the control
    #: arm `h3-mix-envelope` (it refuses 7 of the corpus's 32 truth texts, and the envelope gate it replaced
    #: refused 10 of them plus 27 of 64 wrong texts; see the docstring's MIX section).
    mix_floor: float
    #: On the mix: from `mix_floor` up to it, DOUBT; from it, OK. A GRADING threshold (how audible the words
    #: are), never the words' standing: 104 of the corpus's 192 right mix texts lift under it (docstring MIX).
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
