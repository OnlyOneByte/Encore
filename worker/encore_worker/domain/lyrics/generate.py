"""Generating OUR OWN timings from text alone: one global CTC decode over the whole song.

THE INVERSION THIS IMPLEMENTS (docs/PLAN-alignment-v2.md). The windowed aligner is handed incoming timings
as its SEARCH SPACE — whisperx crops audio to each span — so an offset sheet passes through with unity gain
(measured: `bias = 1.005 x offset + 131 ms`). Here no timing ever enters: the candidate text is aligned over
the ENTIRE recording's emission matrix, and whatever the source claimed becomes evidence for
`reconcile`, never instructions.

Measured before this was built (docs/benchmarks/forced-alignment, tfr-flyaway, authored-caption truth):

    windowed + perfect spans (the old ceiling)    74.7% of lines within +/-250 ms, 0/75 gross
    THIS, text only, no windows                   70.7%,                          0/75 gross
    windowed + spread_over (the old untimed path)  1.3%,                          57/75 gross

So an untimed sheet — the case that used to be hopeless — aligns nearly as well as one with perfect timings.

CHAR-LEVEL NATIVELY, which is what makes syllables free. `forced_align` emits one span per character;
words and lines are groupings of those spans, and syllables are just a THIRD grouping (`syllabify` decides
the split points, the spans are already timed). WHAT A CHAR SPAN IS NOT is a duration: CTC is peaky, and
90.9% of 21,921 measured char spans are exactly ONE frame (review decode-4). This docstring used to claim
that "a sustained sung vowel's char span stretches with the singing, so a syllable's duration is its SUNG
duration"; it does not. What the spans carry is ORDERED ONSETS on the frame grid — which is what a karaoke
ball follows and what every metric here is scored on — while every END is the model's last confident frame
and runs early (phrase-final ends a median 107 ms early, review §3.5). Ends are a display problem, fixed
by a post-pass over the activity envelope rather than by believing the span: `domain/lyrics/ends.py`, which
the step applies after every gate and repair, so nothing in HERE has to lie about what a span means.

WHAT THE PATH SCORE IS NOT. The whole-path CTC score does NOT detect wrong text — measured: a different
song's lyrics scored BETTER on the mix (-0.367 against -0.472). Per-line means are carried for GRADING
lines against each other within one song; the wrong-song verdict belongs to the activity-envelope gate
(`domain/audio/activity.py`), which does separate the populations.
"""

from __future__ import annotations

from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from encore_worker.domain.lyrics.language import fold_to_base

#: A word whose every character is out-of-dictionary gets its span INTERPOLATED from its neighbours and
#: this confidence, so a non-Latin token or a run of digits degrades one word rather than failing the line.
OOV_CONFIDENCE = "low"

#: How far every char span's START is pulled back toward the true acoustic onset, clamped at the previous
#: span's end. MEASURED, not tuned: across 5693 words with hand-measured onsets (JamendoLyrics, 20 songs)
#: the raw decode starts LATE on every song — wav2vec2 emits a character a frame or two after the sound
#: begins — while ENDS are early, so this applies to starts only; a translation would damage the ends it
#: fixed the starts with. The clamp is what makes it safe: an interior char bounded by its predecessor
#: cannot move, so the lead acts exactly where the delay physically lives — onsets after gaps.
#:
#: RE-FITTED IN W4 (review 6a), 40 -> 30 ms, because 16 of those 41 ms were the CLOCK and not the model.
#: The old emission grid derived `frame_sec` as `duration / frames`, which came out 0.020014 on every
#: corpus song, so a lead fitted on it was absorbing a stretch as if it were a delay. On the exact 20 ms
#: grid (`adapters.ml.FRAME_SEC`) the raw decode is +25.3 ms late, not +41.2.
#:
#: THE SWEEP, on the same 5693 words, blind decode, vocals stems (`_runs/w4-clock/lead_sweep.py`, rows in
#: `lead_sweep.json`). Old grid at 40 ms — the shipped baseline — reproduces the review exactly: bias +4 ms,
#: ±100 78.7%, gross 47/868. On the exact grid:
#:
#:     lead   0 ms   bias +25.3   ±100 76.53   medAE 44.0   gross 41
#:     lead  20 ms   bias  +6.0   ±100 79.52   medAE 39.8   gross 41
#:     lead  25 ms   bias  +1.5   ±100 79.71   medAE 40.0   gross 41
#:     lead  30 ms   bias  -3.1   ±100 79.98   medAE 40.6   gross 41   <- shipped
#:     lead  35 ms   bias  -7.8   ±100 80.19   medAE 41.8   gross 41
#:     lead  40 ms   bias -12.2   ±100 80.05   medAE 43.1   gross 41
#:     lead  50 ms   bias -20.2   ±100 79.78   medAE 45.8   gross 42
#:
#: WHY 30 AND NOT THE ±100 MAXIMUM. ±100 is flat across 25-40 ms — 35 beats 30 by 0.21 pt (song-bootstrap
#: CI +0.02..+0.39) and 30 against 40 is 0.07 pt with the CI straddling zero — so that metric does not
#: choose. Two things that do: the BIAS, which is what this constant exists to remove and which crosses
#: zero at about 26 ms, and medAE, minimised over 20-30 ms and 1.2 ms worse by 35. Of the two 5 ms steps
#: either side of the crossing, 30 is the one on the EARLY side (-3.1 ms): a highlight that lights a hair
#: early reads as correct where one that lights late reads as broken (ITU-R BT.1359's asymmetry, which W6's
#: separate DISPLAY lead is fitted on — this constant stays acoustic truth).
#:
#: END TO END through the harness (`e2e.py --level generate --modes blind --songs jamendo`, old grid at
#: 40 ms = `results/baseline-v2-generate.json`, new grid at 30 ms = `_runs/w4-clock-generate/`):
#: word ±100 78.73 -> 79.98 (+1.25 pt, song-bootstrap CI +0.46..+2.22), ±250 90.46 -> 90.46, ±300
#: 91.29 -> 91.45, medAE 40.9 -> 40.6 ms, bias +3.7 -> -3.1 ms, words over 2 s out 141 -> 129, LINE gross
#: 47 -> 41 (zero-gross songs 5 -> 6), line ±500 87.67 -> 87.56, ±1 s 91.82 -> 91.94.
#:
#: TWO THINGS GET WORSE, both worth naming rather than averaging away.
#:   AAE 309 -> 337 ms, which is not an onset regression: the whole +160 s of it is four songs whose blind
#:   decode MISBINDS repeats (Pure_Mids +68 s, Tom_Orlando +40, Ridgway +40, Explosive_Ear_Candy +16), so
#:   what moved is how far an already-wrong word swings, not how precisely a right one is placed. On the
#:   same songs the count of words over 2 s out FALLS (Tom_Orlando 48 -> 32, and its line gross 8 -> 2).
#:   Every robust statistic — medAE, ±100/±250/±300, the gross counts — holds or improves.
#:   ENDS: word end ±100 73.2 -> 68.7, phrase-final ±100 40.6 -> 36.3, phrase-final bias -106 -> -121 ms,
#:   highlight 67.3% -> 66.0%. The old clock's 0.07% stretch was pushing every end later and so MASKING
#:   CTC's peakiness (90.9% of char spans are one frame); the ends were always this early and are now
#:   measured honestly. Review §3.5's envelope post-pass is what fixes them, and it is in this same wave.
ONSET_LEAD_SEC = 0.03


@dataclass(frozen=True, slots=True)
class Syllable:
    text: str
    start: float
    end: float


@dataclass(frozen=True, slots=True)
class Word:
    word: str
    start: float
    end: float
    #: Mean per-frame log-probability over this word's chars. Comparable WITHIN a song, not across songs.
    score: float
    syllables: tuple[Syllable, ...] = ()
    #: "aligned" for a word the decode placed; OOV_CONFIDENCE for one interpolated from its neighbours.
    provenance: str = "aligned"


@dataclass(frozen=True, slots=True)
class Line:
    text: str
    start: float
    end: float
    words: tuple[Word, ...]
    #: Mean per-frame log-probability across the line's aligned chars — the within-song grading signal.
    score: float
    #: Index into the INPUT `line_texts`. Carried because a line with no alignable characters (a decorative
    #: `♪`, an emoji row) is DROPPED from the output — measured on tfr-chosen, whose first caption is
    #: exactly that — and a caller matching output to input by position then scores every later line
    #: against the wrong row. Identity has to travel with the line, not be inferred from order.
    index: int = 0


@dataclass(frozen=True, slots=True)
class Generated:
    """A full document of our own timings, plus what grading needs."""

    lines: tuple[Line, ...]
    language: str

    def as_doc(self) -> dict[str, Any]:
        """The core-contract document shape. `syllables` is an optional key an older core ignores."""
        return {
            "language": self.language,
            "lines": [
                {
                    "text": line.text,
                    "start": line.start,
                    "end": line.end,
                    "words": [
                        {
                            "word": w.word,
                            "start": w.start,
                            "end": w.end,
                            "score": w.score,
                            **(
                                {
                                    "syllables": [
                                        {"text": s.text, "start": s.start, "end": s.end} for s in w.syllables
                                    ]
                                }
                                if w.syllables
                                else {}
                            ),
                        }
                        for w in line.words
                    ],
                }
                for line in self.lines
            ],
        }


class Decoder(Protocol):
    """`(log_probs, targets, blank) -> (frame_labels, frame_scores)`. In production this is
    `adapters.ml.forced_align_decoder` (torchaudio's CTC kernel); it lives THERE and not here because
    domain/ is pure functions over data and must run with no ML installed — a layering rule with its own
    test. Injection is also what makes the grouping logic hermetically testable.

    `blank` IS PART OF THE CONTRACT rather than a kernel default (review M9): the blank column belongs to
    the matrix, not to the decoder, so a fake that ignored it would pass tests that exist to prove the
    caller reads it. It is defaulted, so a caller with no matrix to ask still gets CTC's usual 0.

    POSITIONAL-ONLY, because every caller here passes positionally and the implementations are ordinary
    functions whose parameter NAMES are their own (`_log_probs` for a fake that ignores the matrix). A
    Protocol with named parameters would make those names part of the contract.
    """

    def __call__(
        self, log_probs: Any, targets: Sequence[int], blank: int = 0, /
    ) -> tuple[Sequence[int], Sequence[float]]: ...


def blank_of(emissions: Any) -> int:
    """`emissions.blank_id`, or CTC's usual 0 for a matrix that does not say (review M9).

    `getattr` ON PURPOSE. Every emission object in this repo's tests, and every bench cache entry written
    before the field existed, is a duck type with three attributes; the shipped `adapters.ml.Emissions`
    carries `blank_id`. Defaulting keeps those readers decoding exactly as they did, and the one place the
    default is wrong — an HF bundle whose pad sits elsewhere — is the shipped one, which always says.
    """
    return int(getattr(emissions, "blank_id", 0))


def excluded_of(emissions: Any) -> frozenset[int]:
    """Every vocabulary id a TARGET may never contain: CTC's blank, plus the other non-character entries the
    matrix names (`adapters.ml.Emissions.specials`) — the ONE filter every reader of this matrix shares.

    WHY THE SPECIALS AND NOT ONLY THE BLANK (W4b, review M9's other half). `specials` has named the word
    separator, the unknown and sentence markers and the blank since W4 and nothing read it, which left the
    filter one id wide: every HF vocabulary maps `|` to the word separator (the shipped `en` dictionary is
    `{'-': 0, '|': 1, 'e': 2, ...}`, so `specials` is `{'|': 1, '-': 0}`), and a lyric line containing a
    literal pipe — a sheet that writes `oh | oh`, a caption track using it as a delimiter, an operator paste
    from a table — emitted id 1 as a CHARACTER TARGET. The decode then forced a word separator into the
    middle of a word, and `_char_spans` gave it a span of its own, so the line's letters were pushed onto the
    frames after it. Not reachable from the bench corpus (0 pipes in 832 texts, so every recorded row is
    unchanged), and that is exactly why it needed a reader rather than a field nobody read.

    IT IS ALSO WHERE 6c's SEPARATOR COMES FROM (review D1, built in W4b): `separator_of` reads the same
    `specials` mapping for the one id the `linesep` arm deliberately EMITS at line boundaries, so the filter
    that keeps a lyric's literal `|` out of a word and the arm that puts one between lines cannot disagree
    about which column that is.

    `getattr` and a frozenset, for `blank_of`'s reason: a matrix that names no specials (every fake in this
    suite, every bench cache entry written before the field) filters exactly the blank, as it always did.
    """
    named: Mapping[str, int] = getattr(emissions, "specials", None) or {}
    return frozenset({blank_of(emissions), *(int(code) for code in named.values())})


def separator_of(emissions: Any) -> int | None:
    """The WORD-SEPARATOR id this matrix names (`adapters.ml.Emissions.specials['|']`), or None when it names
    none — the token `generate(separate_lines=True)` emits at LINE BOUNDARIES (review 6c / D1, the `linesep`
    arm).

    WHY THE SEPARATOR AND NOT A LETTER. `|` is what wav2vec2 and HuBERT were TRAINED to emit between words:
    every LibriSpeech-lexicon checkpoint's vocabulary is `{'-': 0, '|': 1, 'e': 2, ...}` and its transcripts
    are `THE|CAT|SAT`, so the column already carries "a word boundary happened here" and a forced path through
    it is asking the model something it knows. That is also the whole of D1's mechanism: CTC alignment is a
    monotone path, and a target the model emits at boundaries pins the path down between lines without
    constraining anything inside one.

    None WHERE THE ID IS THE BLANK, which makes the arm INERT rather than fatal on such a vocabulary: the
    kernel refuses a target list containing the blank outright (`adapters.ml.forced_align_decoder`), so a
    bundle that maps `|` to its blank column would turn every decode into a decline the moment the arm was
    set. Reachable: whisperx tables Norwegian Bokmal with `|` at id 0, and a torchaudio bundle's blank IS 0 —
    it is only the `[PAD]`=38 in that vocabulary that keeps the two apart today.

    `getattr`, for `blank_of`'s reason: a matrix that names no specials (every fake in this suite, every bench
    cache entry written before the field) has no separator to emit, so the arm is inert there too.

    THE TWO None's ARE DIFFERENT FACTS and a caller that reports the arm's silence must tell them apart, so
    `separator_named` is the reader that does not fold them (W4b review r1: `align_steps._linesep_why`
    printed "this vocabulary names none" over both, while `host.config`'s contract promised it said which of
    the two happened).
    """
    code = separator_named(emissions)
    return None if code is None or code == blank_of(emissions) else code


def separator_named(emissions: Any) -> int | None:
    """The id this matrix names for `|`, WHATEVER column it is — the blank included — or None when it names no
    `|` at all. `separator_of` is this filtered by the blank; the raw reading exists so the trail can say
    which of the two inert cases happened (W4b review r1).

    ONE LITERAL FOR ONE IDEA: which key names the separator lives here and nowhere else, as the blank's
    does in `blank_of` and the filter's in `excluded_of`.
    """
    named: Mapping[str, int] = getattr(emissions, "specials", None) or {}
    code = named.get("|")
    return None if code is None else int(code)


#: The `Emissions.specials` key the STAR column is named under (`adapters.ml.STAR_NAME`, review §3.10 — the
#: `star` arm). RESTATED HERE, as `|`'s key is in `separator_named`, because `domain/` may not import the
#: adapters; a test holds the two literals equal (`tests/test_star.py`).
_STAR_NAME = "<star>"


def star_of(emissions: Any) -> int | None:
    """The STAR id this matrix names (`adapters.ml.starred`, which appends the column), or None when it names
    none — the token `generate(stars=True)` emits BEFORE EVERY LINE (review §3.10 phase A, the `star` arm).

    WHAT THE STAR BUYS, stated where the target is built rather than only where the column is: a forced CTC
    path must label every frame, so audio the text does not cover — an intro, an instrumental break, a verse
    the sheet omits — is charged to whichever characters are nearest and drags them (review D3: 107/387 line
    starts more than 2 s off with half the lines dropped, 142 gross on one 6-line unsung verse,
    `feel-my-heart`'s first word about 28 s early). A star token scored `frame max − P` is somewhere cheap for
    the path to wait, so the letters stay where they were sung.

    BEFORE EVERY LINE, never between words and never only at the song's edges, which is review §3.10's own
    technique. The every-word variant is NOT implemented here in either direction, for the reason D1 gives the
    separator one: a token the model never emits INSIDE a phrase makes CTC leave the letters for a boundary
    it did not hear. A star only at the edges was measured to do nothing (review's rejected list).

    None, AND SO AN INERT ARM, for `separator_of`'s two reasons: a matrix that names no star (every fake in
    this suite, every bench cache entry, any matrix the step did not pass through `ml.starred`) and one whose
    star id IS the blank — the kernel refuses a target list containing the blank outright, so an arm that can
    only decline must stand down instead. The second cannot happen through `ml.starred` (its id is the
    matrix's width), which is exactly why it is cheap to refuse here rather than trusted upstream.
    """
    named: Mapping[str, int] = getattr(emissions, "specials", None) or {}
    code = named.get(_STAR_NAME)
    return None if code is None or int(code) == blank_of(emissions) else int(code)


def char_ids(word: str, dictionary: Mapping[str, int], excluded: Collection[int]) -> list[tuple[int, int]]:
    """`(index within `word`, vocabulary id)` for every character of `word` this vocabulary can align — THE
    target filter, and the only copy of it (`char_targets`, `alignable_chars` and `lexical.letters_of` all
    read this one function).

    THREE RULES, in order, and each of them is a measured requirement rather than tidiness:

      * LOWERCASED, because whisperx lowercases its dictionaries (`whisperx/alignment.py:98,110`).
      * A CHARACTER THE VOCABULARY LACKS IS FOLDED TO ITS BASE LETTERS BEFORE IT IS DROPPED (review §3 item 9,
        W7; `language.fold_to_base`). It used to be dropped outright, so `cafés` decoded as `cafs` and
        `Grüße` as `Gre` on the English bundle — the silent half of review M8, which the review's own words
        call "accents are silently skipped". The fold is NFKD, so it is a no-op for every character the
        vocabulary already has (checked first, so a bundle whose vocabulary HOLDS `é` still aligns the
        composed letter) and for every atomic letter NFKD cannot decompose (`ø`, `æ`, `ß` — named in
        `fold_to_base`). ONE FOLDED CHARACTER MAY YIELD SEVERAL TARGETS (`ﬁ` -> `f`, `i`), and both carry the
        ORIGINAL character's index, which is what keeps `generate`'s syllable regrouping exact: the fragment
        ranges it slices with are ranges over the input word, not over the targets.
      * A NON-CHARACTER COLUMN IS NEVER A TARGET (`excluded_of`): the blank, the word separator, the unknown
        and sentence markers. The kernel refuses a target list containing the blank outright, and a lyric's
        literal `|` forced a word separator into the middle of a word (see `excluded_of`).

    A NO-OP ON EVERY RECORDED ROW, measured before it shipped rather than argued
    (`scripts/lang_gate.py --folds`), because a fold that moved ONE English target sequence would move every
    number under `docs/benchmarks/forced-alignment/results/`: the 32-song corpus's cleaned truth lines hold
    50 516 characters and **not one** of them is a non-ASCII letter — 40 409 Latin letters, 0 other scripts, 0
    characters NFKD folds and 0 it cannot. So the function below returns exactly what the three inlined copies
    returned on every text the bench serves at `--level time_text` (the claim modes are built from those truth
    lines, the `wrongtext` donors are other corpus songs' truth lines, and `headers` injects ASCII), and the
    corpus cannot show the fix working. The texts that can are `scripts/lang_gate.py`'s fr/de/es JamendoLyrics
    songs: 59 songs, 81 925 characters, of which **1 035 now align and used to be dropped** (`é` 322, `ü` 184,
    `ä` 110, `à` 92, `ê` 74, `ö` 67, `è` 64, `ñ` 56, `ç` 28, and 38 more over seven letters) — 1.3% of every
    character in those sheets, concentrated in exactly the words an accent distinguishes. 43 stay dropped
    because NFKD cannot decompose them (`ß` 41, `œ` 2), which is the residue `fold_to_base` names.
    """
    out: list[tuple[int, int]] = []
    for index, ch in enumerate(word.lower()):
        token = dictionary.get(ch)
        if token is None:
            for folded in fold_to_base(ch).lower():
                code = dictionary.get(folded)
                if code is not None and code not in excluded:
                    out.append((index, int(code)))
            continue
        if token not in excluded:
            out.append((index, int(token)))
    return out


def alignable_chars(text: str, emissions: Any) -> int:
    """Characters of `text` this matrix can align: in its dictionary, and not one of its non-character
    columns (review M9's blank; `excluded_of`'s specials since W4b).

    ONE LITERAL FOR ONE IDEA (W4 review r1). This count is a FLOOR's input in two modules — `regenerate`
    refuses a repair window under two frames per alignable character, and `align_steps.needs` turns the same
    number into the seconds a text takes at that floor, which widens a truncated cue's window — and it was
    written out twice. Both copies survived being reverted to a literal 0 under mutation, because the floor
    only ever gets LOOSER when the count is too small, so the repair still ran and produced the same document
    on a vocabulary whose blank IS 0. On one whose blank is a letter (23 of whisperx's 36 HF align models;
    W7) the two floors would then be read off different texts, and a window sized for 17 characters would be
    handed 21 to force through it.

    `char_ids` IS `generate`'s own target filter, shared rather than restated, so "alignable" means exactly
    what the decode will try to align: the same lower-casing, the same NFKD fold of a character the vocabulary
    lacks (W7), and the same refusal to target a non-character column. It therefore counts TARGETS, which is
    what both floors need — a folded `ﬁ` costs two frames, not one.
    """
    excluded = excluded_of(emissions)
    return sum(len(char_ids(word, emissions.dictionary, excluded)) for word in text.split())


def _char_spans(
    frame_labels: Sequence[int], frame_scores: Sequence[float], frame_sec: float, blank: int = 0
) -> list[tuple[float, float, float]]:
    """Per-emitted-token `(start, end, mean_score)`, in target order.

    A hand-rolled merge rather than `torchaudio.functional.merge_tokens` so the grouping half of this
    module runs — and is tested — without torch. CTC repeats a label across frames and separates repeats
    with blanks; a span is a maximal run of one non-`blank` label, and the trailing sentinel that flushes
    the last run is a `blank` frame — both of which used to be the literal 0 (review M9). On a vocabulary
    whose pad is not 0 that produced spans for the blank's own runs and merged two real tokens across the
    sentinel, so the span count stopped matching the target count and `generate` raised.
    """
    spans: list[tuple[float, float, float]] = []
    run_label, run_start, run_scores = blank, 0, []  # type: int, int, list[float]
    for index, label in enumerate([*frame_labels, blank]):  # sentinel blank flushes the last run
        if label == run_label:
            if label != blank:
                run_scores.append(frame_scores[index] if index < len(frame_scores) else 0.0)
            continue
        if run_label != blank:
            spans.append(
                (
                    run_start * frame_sec,
                    index * frame_sec,
                    sum(run_scores) / len(run_scores) if run_scores else 0.0,
                )
            )
        run_label, run_start = label, index
        run_scores = [frame_scores[index]] if label != blank and index < len(frame_scores) else []
    return spans


@dataclass(frozen=True, slots=True)
class _SlicedEmissions:
    """A frame window over another emission matrix — the same duck type `generate` reads.

    What makes windowed REPAIR nearly free: the model pass happened once for the whole song, and a repair
    decode is a Viterbi over a slice of the matrix already in hand.
    """

    log_probs: Any
    frame_sec: float
    dictionary: Mapping[str, int]
    #: Carried from the sliced matrix, so a repair decode reads the same blank column the global one did
    #: (review M9). Without it `regenerate`'s inner `generate` would fall back to 0 on exactly the models
    #: where 0 is a letter.
    blank_id: int = 0
    #: Carried for the same reason, one filter further out (W4b): `excluded_of` reads it, so a repair decode
    #: drops exactly the ids the global decode dropped. Without it a line containing a `|` would be repaired
    #: as a longer target sequence than the one it is repairing.
    #:
    #: IT MAY NAME A STAR (W7's `star` arm) and that is harmless by construction: `regenerate` does not ask
    #: for stars (see `generate`'s docstring for why repair windows stay star-free), so the column the slice
    #: still carries is simply never a target — the kernel only ever reads the columns its targets name.
    specials: Mapping[str, int] = field(default_factory=dict)

    @property
    def frames(self) -> int:
        return len(self.log_probs)


def _shifted(line: Line, offset: float, index: int) -> Line:
    return Line(
        text=line.text,
        start=line.start + offset,
        end=line.end + offset,
        words=tuple(
            Word(
                word=w.word,
                start=w.start + offset,
                end=w.end + offset,
                score=w.score,
                syllables=tuple(
                    Syllable(text=s.text, start=s.start + offset, end=s.end + offset) for s in w.syllables
                ),
                provenance=w.provenance,
            )
            for w in line.words
        ),
        score=line.score,
        index=index,
    )


def regenerate(
    runs: Sequence[tuple[Sequence[Line], tuple[float, float]]],
    emissions: Any,
    *,
    language: str = "en",
    decoder: Decoder,
    syllabifier: Callable[[str, str], list[str]] | None = None,
    faults: list[str] | None = None,
    separate_lines: bool = False,
) -> dict[int, Line]:
    """Re-decode runs of lines INSIDE evidence-derived windows, on the same emission matrix.

    The repair primitive behind the reconciliation tactics in `steps/align_steps.py`: when the GLOBAL
    decode misbinds — a repeated chorus bound to the wrong occurrence (measured, tfr-chosen: 12/35 lines
    gross, all repeats), or a whole decode scattered on repeat-heavy text — the fix is not a different
    engine but the SAME decode constrained to a window some other evidence vouches for: a claimed line's
    span, or the gap between two well-anchored unique lines. Gentle's multipass realigner and
    nomadkaraoke's anchor-sequence gap handlers converge on this same shape.

    Each run is `(consecutive lines, (window_start_sec, window_end_sec))`, decoded JOINTLY so order within
    the run stays monotonic. Returns `{original line index: repaired Line}`. A run is SKIPPED, with its
    originals kept, when its window cannot hold the text or its decode fails, because a repair that can
    throw away a working timing is worse than no repair.

    `faults`, when given, gets one `"<Type>: <message>"` per run whose decode RAISED. The run still keeps
    its originals. The list exists so the caller can report the failure: a swallowed exception otherwise
    looks exactly like a repair that was never needed. Measured, not foreseen (review L8): every R3 window
    decode in the alignment suite raised here for as long as the suite existed, and nothing showed it.

    `separate_lines` IS COUNTED IN THE WINDOW GUARD, not merely forwarded (review 6c's own wording): under the
    arm a run of N decoding lines is N-1 targets longer than its characters, and the floor below which a
    forced path is a smear rather than a fit is a floor on TARGETS. A guard that missed them would hand a
    window sized for 17 characters 18 targets to force through — the same defect `alignable_chars`' docstring
    describes one layer down, arriving from the other side.
    """
    repaired: dict[int, Line] = {}
    blank = blank_of(emissions)
    separator = separator_of(emissions) if separate_lines else None
    for run, (window_start, window_end) in runs:
        if not run or emissions.frame_sec <= 0:
            continue
        first = max(0, int(window_start / emissions.frame_sec))
        last = min(emissions.frames, int(window_end / emissions.frame_sec))
        per_line = [alignable_chars(line.text, emissions) for line in run]
        alignable = sum(per_line)
        # Only a line that emits a character takes part in the boundary count, exactly as `generate` emits
        # them: a decorative row between two sung lines is one boundary, not two.
        separators = max(0, sum(1 for chars in per_line if chars) - 1) if separator is not None else 0
        # CTC needs at least one frame per target; anything tighter than 2x is a forced smear, not a fix.
        if alignable == 0 or (last - first) < 2 * (alignable + separators):
            continue
        window = _SlicedEmissions(
            log_probs=emissions.log_probs[first:last],
            frame_sec=emissions.frame_sec,
            dictionary=emissions.dictionary,
            blank_id=blank,
            specials=dict(getattr(emissions, "specials", None) or {}),
        )
        try:
            got = generate(
                [line.text for line in run],
                window,
                language=language,
                decoder=decoder,
                syllabifier=syllabifier,
                separate_lines=separate_lines,
            )
        except Exception as exc:  # noqa: BLE001 - a failed repair keeps the original, never degrades it
            if faults is not None:
                faults.append(f"{type(exc).__name__}: {exc}")
            continue
        if len(got.lines) != len(run):
            continue
        offset = first * emissions.frame_sec
        for original, redecoded in zip(run, got.lines, strict=True):
            repaired[original.index] = _shifted(redecoded, offset, original.index)
    return repaired


def remapped(line: Line, start: float, end: float) -> Line:
    """The same line affinely re-fitted onto `[start, end]`, internal proportions preserved.

    Exists for CLAMPING: a repaired line measured inside a PADDED claim window can spill over its
    neighbour, and two overlapping lines read as out-of-order words downstream — which `policy.decide`
    treats as incoherent word timing and degrades the whole document to line sync. Found live: a
    `structural` repair with 21/23 corroborating lines was thrown away over exactly 2 such words.
    """
    span = max(line.end - line.start, 1e-6)
    scale = max(end - start, 1e-6) / span

    def moved(t: float) -> float:
        return start + (t - line.start) * scale

    return Line(
        text=line.text,
        start=start,
        end=end,
        words=tuple(
            Word(
                word=w.word,
                start=moved(w.start),
                end=moved(w.end),
                score=w.score,
                syllables=tuple(
                    Syllable(text=s.text, start=moved(s.start), end=moved(s.end)) for s in w.syllables
                ),
                provenance=w.provenance,
            )
            for w in line.words
        ),
        score=line.score,
        index=line.index,
    )


def trimmed(line: Line, end: float, *, frame_sec: float) -> Line | None:
    """The same line ENDING at `end`, keeping every word onset it measured before `end` and re-fitting
    only the tail the decode smeared past it. None when no word of the line starts before `end`.

    `remapped`'s sibling and NOT a special case of it: `remapped(line, line.start, end)` compresses the
    WHOLE line, which moves onsets that were already right. Here only the sub-series from the ANCHOR — the
    last word starting before `end` whose tail still has a frame per word to place in, see below — is
    re-fitted, into `[that word's start, end]`. Two properties follow, and both are the reason this exists
    rather than a call to `remapped`:

      * NO ONSET MOVES BEFORE THE ANCHOR, and the anchor and every onset before it do not move at all — so
        the line's FIRST word stays exactly where it was and a line trimmed this way cannot invert against
        the line before it. `remapped` moves the first word EARLIER whenever the line has leading silence,
        which is the one shape that can. (The tail after the anchor does move earlier; it has to, that is
        what trimming is. Internal order survives because the map is monotone.)
      * THE ONSETS BEFORE `end` ARE MEASUREMENTS AND SURVIVE. Measured over the 20 Jamendo songs at `truth`
        through the shipped `time_text` (base model, `_runs/w6-{clamp,tail}-jamendo`), against `remapped`
        doing the same job: word ±100 83.52 against 83.12, ±250 94.08 against 93.92, ±300 95.04 against
        94.98, word end ±100 80.02 against 79.87, MedAE 38.2 ms against 38.5, highlight 77.58 against
        77.45 — every one of those back at or above the W4 row this must not regress (83.25 / 93.96 / 94.98
        / 80.02 / 38.2 / 77.10), where the affine version was 0.1-0.2 pt under four of them. It costs
        phrase-final end ±100, 59.23 against `remapped`'s 59.66 and W4's 59.83, on 2 more scored ends: the
        trimmed line's LAST word now ends at `end`, and that word is a phrase-final one.

    ONE FRAME PER WORD STILL TO BE PLACED, WHICH IS WHY THE ANCHOR CAN WALK BACK (W6 review r2-spec-9). The
    anchor is the LAST word starting before `end`, and where that word starts a hair before it the scale goes
    to ~0: words at 10.0 / 19.999 / 20.4 / 20.9 / 21.6 trimmed to 20.0 used to publish the last three inside
    0.8 ms of 19.999 — four words the TV can never light, since it lights `start <= pos < end` and that
    interval is empty to the float, and three onsets no longer within a decoder frame of anything measured.
    So an anchor whose tail cannot hold one `frame_sec` per word still to be placed is dropped and the word
    before it tried, which trades ONE measured onset for a tail that is a timing again (here: the anchor
    becomes 10.0 and the four words land ~0.4 s apart). The two properties above survive the walk exactly —
    the map is still `t <= anchor -> t`, so the FIRST onset never moves whichever word the anchor is, and the
    map is still monotone. None gains a second reason with it, reached only by a line whose every word is
    crammed into one frame-per-word's worth of room (not seen on the corpus). The word figures above were read
    BEFORE the walk; THE WALK IS NOW SWEPT (W6 round-2 re-bench, code `622288017e9d268a`) and they hold to the
    digit — `truth` Jamendo 83.52 / 94.08 / 95.04 / 80.02 / 38.2 ms / 77.58 unmoved, because the collapsed
    tail reaches 21 of 1088 `time_text` cases on the base bundle and 13 on HuBERT-L, none of them `truth` on
    a song with word truth. The walk is measured to BUY 3 gross words on `Wordsmith_-_The_Statement` drop20
    under HuBERT-L (43 -> 40 pooled, AAE 146 -> 143.7 ms). What it is measured to COST, and it is NOT only the
    tail: the out-of-order word the collapse produced was tripping `run_align`'s `line-sync` retime on three
    base-bundle cases, which now publish their word document instead — `believer` extraverse 65.75 (W4b) ->
    98.63 (the accident) -> 73.97, `feel-my-heart` credit back to W4b's 94.59, and `rap-god` drop20 100.00 ->
    87.93, a fallback no earlier tree lost (pooled `run_align` drop20 ±500 90.48 -> 88.98, extraverse
    90.69 -> 89.66, gross and `high_gross` 0 throughout). So this walk is not free at `run_align`, and the
    PLAN's status log carries the owner's open question about it.

    WHO CALLS IT: `align_steps._pulled_end`, the bounded left floor of the repair clamp (W6) — the one place
    a line the ladder did not repair has its end moved, and the one place `end` is another line's measured
    start rather than a window edge. None is its refusal: a line whose every word starts after `end` was not
    sung before it, so there is nothing to keep and the caller falls back to pushing the repair instead.
    """
    kept = [word for word in line.words if word.start < end]
    while kept and end - kept[-1].start < (len(line.words) - len(kept)) * frame_sec:
        kept.pop()
    if not kept:
        return None
    anchor = kept[-1].start
    scale = max(end - anchor, 1e-6) / max(line.end - anchor, 1e-6)

    def moved(t: float) -> float:
        return t if t <= anchor else anchor + (t - anchor) * scale

    return Line(
        text=line.text,
        start=line.start,
        end=end,
        words=tuple(
            Word(
                word=w.word,
                start=moved(w.start),
                end=moved(w.end),
                score=w.score,
                syllables=tuple(
                    Syllable(text=s.text, start=moved(s.start), end=moved(s.end)) for s in w.syllables
                ),
                provenance=w.provenance,
            )
            for w in line.words
        ),
        score=line.score,
        index=line.index,
    )


def adopted_line(text: str, index: int, start: float, end: float) -> Line | None:
    """A line carrying a CLAIM's own timing, built when the decode cannot hear the line at all.

    The measured case (tfr-chosen's outro): chopped, pitched vocal samples that captions time but wav2vec2
    cannot recognise as words — the emissions are flat, and a forced path through flat emissions sticks to
    the window's edge. A human's hand timing beats a decode that heard nothing, so the claim's span is
    adopted wholesale: words spread evenly inside it, every one flagged interpolated, score zero. The
    caller grades such a line `low` — this is a surrender to better evidence, not a measurement.
    """
    words = text.split()
    if not words or end <= start:
        return None
    step = (end - start) / len(words)
    spread = tuple(
        Word(
            word=word,
            start=start + i * step,
            end=start + (i + 1) * step,
            score=0.0,
            provenance=OOV_CONFIDENCE,
        )
        for i, word in enumerate(words)
    )
    return Line(text=text, start=start, end=end, words=spread, score=0.0, index=index)


@dataclass(frozen=True, slots=True)
class CharTargets:
    """The CTC target sequence one text becomes, and who owns each target.

    Extracted from `generate` so a SECOND reader of the same trellis exists: `domain.lyrics.margin` asks how
    ambiguous each line's placement was, which needs the exact target sequence the decode was handed and the
    position in it of each line's first character. Recomputing that beside `generate` would be two copies of
    the target filter (`excluded_of`), the lower-casing, and the separator's lazy placement — three rules
    whose disagreement would make the margin describe a decode that never ran. See `alignable_chars`'s
    docstring for what one duplicated target count already cost.
    """

    #: Vocabulary ids in decode order, separators included: exactly what the decoder is given.
    targets: tuple[int, ...]
    #: `(line index, word index)` per CHARACTER target, in order — separators own no character and so have
    #: no entry, which is why this is shorter than `targets` under `separate_lines`.
    owners: tuple[tuple[int, int], ...]
    #: Each character target's index WITHIN its word, for regrouping into syllables.
    char_of: tuple[int, ...]
    #: `text.split()` per input line, kept so the caller splits once.
    words_by_line: tuple[tuple[str, ...], ...]
    #: How many of `targets` are line separators (`separator_of`), i.e. targets with no character.
    separators: int
    #: Line index -> the position in `targets` of that line's FIRST character target. A line that emitted no
    #: target at all (a decorative row, a line the never-sung rule blanked) is absent.
    first_char_target: Mapping[int, int]
    #: How many of `targets` are STARS (`star_of`, the `star` arm) — the other kind of target that owns no
    #: character, counted separately because the two arms are independent and the span-count invariant below
    #: has to subtract both.
    stars: int = 0


def char_targets(
    line_texts: Sequence[str], emissions: Any, *, separate_lines: bool = False, stars: bool = False
) -> CharTargets:
    """Flatten `line_texts` into the decoder's target sequence (see `CharTargets`, and `generate`, its
    caller and the definition of every rule here)."""
    dictionary: Mapping[str, int] = emissions.dictionary
    excluded = excluded_of(emissions)
    separator = separator_of(emissions) if separate_lines else None
    star = star_of(emissions) if stars else None
    targets: list[int] = []
    owners: list[tuple[int, int]] = []
    char_of: list[int] = []
    words_by_line: list[tuple[str, ...]] = []
    first: dict[int, int] = {}
    separators = 0
    starred = 0
    pending_separator: int | None = None
    for line_index, text in enumerate(line_texts):
        words_by_line.append(tuple(text.split()))
        # A STAR IS OWED BY THIS LINE and paid at its first character target, for the separator's reason one
        # line down: a decorative row (`♪`, a line the never-sung rule blanked) contributes no character, and
        # two stars in a row would be a second absorbing token nobody asked for.
        pending_star = star
        for word_index, word in enumerate(words_by_line[-1]):
            for char_index, token in char_ids(word, dictionary, excluded):
                if pending_separator is not None:
                    targets.append(pending_separator)
                    separators += 1
                    pending_separator = None
                if pending_star is not None:
                    targets.append(pending_star)
                    starred += 1
                    pending_star = None
                first.setdefault(line_index, len(targets))
                targets.append(token)
                owners.append((line_index, word_index))
                char_of.append(char_index)
        if separator is not None and targets:
            # A BOUNDARY IS OWED, and is paid at the next line that has a character (so never trailing, and
            # never twice over a line that contributes none).
            pending_separator = separator
    return CharTargets(
        targets=tuple(targets),
        owners=tuple(owners),
        char_of=tuple(char_of),
        words_by_line=tuple(words_by_line),
        separators=separators,
        first_char_target=first,
        stars=starred,
    )


def _lead_starts(spans: list[tuple[float, float, float]], lead: float) -> list[tuple[float, float, float]]:
    """Each span's start pulled back by `lead`, never past the previous span's end (see ONSET_LEAD_SEC).

    Clamping against the ORIGINAL previous end preserves the ordering invariant every grouping level
    inherits: chars stay non-overlapping, so syllables and words do too.
    """
    out: list[tuple[float, float, float]] = []
    previous_end = 0.0
    for start, end, score in spans:
        pulled = min(max(start - lead, previous_end, 0.0), start)
        out.append((pulled, end, score))
        previous_end = end
    return out


def generate(
    line_texts: Sequence[str],
    emissions: Any,
    *,
    language: str = "en",
    decoder: Decoder,
    syllabifier: Callable[[str, str], list[str]] | None = None,
    separate_lines: bool = False,
    stars: bool = False,
) -> Generated:
    """Align `line_texts` over the whole recording and return nested line/word/syllable timings.

    `emissions` is `adapters.ml.Emissions` (duck-typed: `log_probs`, `frame_sec`, `dictionary`, and
    `blank_id` when it knows it), computed once per song and shared by every candidate text — that is the
    design's cost model: one ~4 s model pass, then one Viterbi decode per candidate (0.1-0.8 s and
    23-230 MB over the corpus, review evidence-6; the docstrings that called it "a millisecond" were wrong
    by an order of magnitude, which still leaves it cheap against the model pass).

    THE NON-CHARACTER IDS ARE EXCLUDED FROM TARGETS (`excluded_of`), and that is a measured requirement
    rather than tidiness: the English dictionary maps `-` to id 0, which is also CTC's blank, and
    `forced_align` refuses a target list containing it outright. WHICH id is blank comes from the matrix
    (`blank_of`) and not from a literal: 23 of whisperx's 36 HF align models put their pad somewhere other
    than 0, and on those the literal dropped a real letter from every word that contains it while feeding the
    true blank in as a target (review M9 — Danish onsets within ±250 ms 90.5% → 73.2%). Since W4b the same
    filter also drops the WORD SEPARATOR and the other specials the matrix names, so a lyric line holding a
    literal `|` cannot force one into the middle of a word (`excluded_of`).

    `separate_lines` EMITS THE WORD SEPARATOR BETWEEN LINES (review 6c / D1, the `linesep` arm, DEFAULT-OFF —
    see `host.config.ALIGN_EXPERIMENTS` for the numbers that decided it). Three mechanical facts, each of
    which is why the arm is three lines here and not a caller's post-pass:

      * BETWEEN, never inside and never at an edge. A separator is emitted lazily, just before the first
        character of the next line that HAS one, so a decorative row (`♪`, an emoji line, a line the
        never-sung rule blanked to `""`) is one boundary rather than two consecutive separator targets, and
        the target list neither starts nor ends with one. D1's AGAINST column is that `|` INSIDE a line hurts
        — CTC's path must then leave the letters to visit the separator, which is a boundary the model did not
        hear — so the every-word variant is not implemented here at all, in either direction.
      * ITS FRAMES ARE RELABELLED TO BLANK before `_char_spans`, which is what keeps the grouping half
        untouched: a run of separator frames then reads exactly as the run of blanks that already separates
        two repeated characters, so a line ending in `a` followed by one starting with `a` still yields two
        spans, and the previous line's last character still ends where the separator's first frame begins.
      * THE SPAN CHECK COUNTS THEM. `forced_align` emits one span per TARGET, and the separators are targets
        with no character to own them, so the invariant below is spans == targets - separators. Getting this
        wrong does not mis-time anything subtly: it raises on every song.

    The GATE decodes are deliberately left alone by this arm (`lexical.lift`, `align_steps._line_sync_decode`
    and the never-sung `_speech_mass` read): their thresholds are calibrated per model on separator-free
    target sequences (`lexical.CALIBRATED`), and an arm that moved the population a floor was fitted on would
    be measuring a recalibration rather than a separator.

    `stars` EMITS A STAR BEFORE EVERY LINE (review §3.10 phase A, the `star` arm, DEFAULT-OFF — the matrix
    must also carry the column, `adapters.ml.starred`, and the arm is INERT where it does not: `star_of`). Its
    three
    mechanical facts are the separator's three, arriving from the other side, so they are stated once each:

      * BEFORE, never inside a line (`char_targets`) — including before the FIRST line, which is the star that
        absorbs an intro the text does not mention.
      * ITS FRAMES ARE RELABELLED TO BLANK, below, which is both what keeps the grouping half untouched and
        review §3.10's explicit fix: with the star left in the label stream it got a span of its own, and
        `_lead_starts` then clamped the next line's first character against THE STAR's end instead of the
        previous character's — the review names that clamp as the likely cause of one song's ±250 drop. As
        blank, a star run reads exactly as the run of blanks that already separates two repeated characters.
      * THE SPAN CHECK COUNTS THEM, as it counts separators: spans == targets − separators − stars.

    REPAIR WINDOWS STAY STAR-FREE and that is deliberate (`regenerate` does not forward this, and the step
    hands repairs the unstarred matrix). §3.10's defect is a GLOBAL one — a monotone path over the whole song
    must spend every frame, so uncovered audio drags the nearest letters — while a repair window is bounded on
    both sides by evidence that already says which text belongs in it. Keeping the windows as they were also
    keeps the arm ATTRIBUTABLE: one change, in the one decode whose numbers §3.10 predicts. The GATE decodes
    named three paragraphs up (`lexical.lift`, `align_steps._line_sync_decode`, the never-sung `_speech_mass`
    read) are left alone for the separator's reason, which is the stronger one: their thresholds are
    calibrated per model on star-free target sequences, so an arm reaching them would measure a recalibration.

    STRUCTURAL INVARIANT (tested): syllables nest within their word's span, words within their line's,
    all ordered. It holds by construction — every level groups the same char spans — and the test exists
    so a refactor that breaks construction is caught by the property, not by a benchmark regression.
    """
    blank = blank_of(emissions)
    separator = separator_of(emissions) if separate_lines else None
    star = star_of(emissions) if stars else None
    decode = decoder
    if syllabifier is not None:
        split = syllabifier
    else:
        from encore_worker.domain.lyrics.syllabify import syllables  # noqa: PLC0415

        split = syllables

    # ── flatten to char targets, remembering every char's owner (`char_targets`, shared with `margin`) ──
    flat = char_targets(line_texts, emissions, separate_lines=separate_lines, stars=stars)
    targets, owners, char_of = flat.targets, flat.owners, flat.char_of
    words_by_line, separators = flat.words_by_line, flat.separators

    if not targets or emissions.frames == 0:
        return Generated(lines=(), language=language)

    frame_labels, frame_scores = decode(emissions.log_probs, targets, blank)
    if separators or flat.stars:
        # THE SEPARATOR'S AND THE STAR'S FRAMES BECOME BLANK (review 6c; §3.10): each is a target the path had
        # to visit, not a token with a span, and as blank they play exactly the part the blanks between two
        # repeated characters already play in `_char_spans`. BEFORE `_lead_starts` TOO, which is the half
        # §3.10 asks for by name: a star left in the stream would own a span, and the onset lead would clamp
        # the next line's first character against the STAR's end rather than the previous character's.
        voided = {token for token in (separator, star) if token is not None}
        frame_labels = [blank if label in voided else label for label in frame_labels]
    spans = _lead_starts(_char_spans(frame_labels, frame_scores, emissions.frame_sec, blank), ONSET_LEAD_SEC)
    # forced_align emits exactly one span per target when it succeeds; anything else means the decode and
    # the grouping disagree about the token stream, which is a defect and not a degradable condition.
    # MINUS THE SEPARATORS AND THE STARS, whose frames were just relabelled away: they are targets that own
    # no character.
    if len(spans) != len(targets) - separators - flat.stars:
        # The star clause only where there ARE stars, so the default's and `linesep`'s message is the one
        # every reader of this suite already knows (`tests/test_linesep.py` pins it).
        raise ValueError(
            f"decode produced {len(spans)} token spans for "
            f"{len(targets) - separators - flat.stars} character targets "
            f"(of {len(targets)}, {separators} of them line separators"
            f"{f' and {flat.stars} stars' if flat.stars else ''}); "
            "the emission matrix and the target encoding disagree"
        )

    # ── regroup: chars -> words -> syllables -> lines ──
    per_word: dict[tuple[int, int], list[tuple[int, tuple[float, float, float]]]] = {}
    for owner, char_index, span in zip(owners, char_of, spans, strict=True):
        per_word.setdefault(owner, []).append((char_index, span))

    lines: list[Line] = []
    for line_index, text in enumerate(line_texts):
        words: list[Word] = []
        pending_oov: list[int] = []
        for word_index, word_text in enumerate(words_by_line[line_index]):
            chars = per_word.get((line_index, word_index))
            if not chars:
                pending_oov.append(word_index)
                words.append(Word(word=word_text, start=0.0, end=0.0, score=0.0, provenance=OOV_CONFIDENCE))
                continue
            starts = [s for _c, (s, _e, _sc) in chars]
            ends = [e for _c, (_s, e, _sc) in chars]
            scores = [sc for _c, (_s, _e, sc) in chars]
            fragments = split(word_text, language)
            syls: list[Syllable] = []
            cursor = 0
            for fragment in fragments:
                lo, hi = cursor, cursor + len(fragment)
                cursor = hi
                inside = [span for c, span in chars if lo <= c < hi]
                if inside:
                    syls.append(Syllable(text=fragment, start=inside[0][0], end=inside[-1][1]))
                elif syls:
                    # A fragment whose chars were all OOV (an apostrophe, a digit) has no span of its own;
                    # zero-width at the previous fragment's end keeps the nesting invariant.
                    syls.append(Syllable(text=fragment, start=syls[-1].end, end=syls[-1].end))
            words.append(
                Word(
                    word=word_text,
                    start=min(starts),
                    end=max(ends),
                    score=sum(scores) / len(scores),
                    syllables=tuple(syls) if len(syls) > 1 else (),
                )
            )

        # OOV words: interpolate between aligned neighbours, flagged rather than silent.
        aligned_positions = [i for i, w in enumerate(words) if w.provenance == "aligned"]
        for position in pending_oov:
            before = max((i for i in aligned_positions if i < position), default=None)
            after = min((i for i in aligned_positions if i > position), default=None)
            if before is not None:
                start = words[before].end
            elif after is not None:
                start = words[after].start
            else:
                start = 0.0
            end = words[after].start if after is not None else start
            words[position] = Word(
                word=words[position].word,
                start=start,
                end=max(end, start),
                score=0.0,
                provenance=OOV_CONFIDENCE,
            )

        aligned_words = [w for w in words if w.provenance == "aligned"]
        if not aligned_words:
            continue  # a line with no alignable chars produces nothing rather than an invented span
        lines.append(
            Line(
                text=text,
                start=min(w.start for w in aligned_words),
                end=max(w.end for w in aligned_words),
                words=tuple(words),
                score=sum(w.score for w in aligned_words) / len(aligned_words),
                index=line_index,
            )
        )
    return Generated(lines=tuple(lines), language=language)
