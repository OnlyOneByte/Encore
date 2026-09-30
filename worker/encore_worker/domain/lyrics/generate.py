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

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

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

    `text.split()` and `lower()` are `generate`'s own target filter, so "alignable" means exactly what the
    decode will try to align: a character the dictionary lacks is dropped there too, and a non-character
    column's character is not a letter of the language whatever the dictionary calls it.
    """
    excluded = excluded_of(emissions)
    return sum(
        1
        for word in text.split()
        for ch in word.lower()
        if (token := emissions.dictionary.get(ch)) is not None and token not in excluded
    )


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

    STRUCTURAL INVARIANT (tested): syllables nest within their word's span, words within their line's,
    all ordered. It holds by construction — every level groups the same char spans — and the test exists
    so a refactor that breaks construction is caught by the property, not by a benchmark regression.
    """
    dictionary: Mapping[str, int] = emissions.dictionary
    blank = blank_of(emissions)
    excluded = excluded_of(emissions)
    separator = separator_of(emissions) if separate_lines else None
    decode = decoder
    if syllabifier is not None:
        split = syllabifier
    else:
        from encore_worker.domain.lyrics.syllabify import syllables  # noqa: PLC0415

        split = syllables

    # ── flatten to char targets, remembering every char's owner ──
    targets: list[int] = []
    owners: list[tuple[int, int]] = []  # (line index, word index) per emitted char
    char_of: list[int] = []  # index within the word, for syllable regrouping
    words_by_line: list[list[str]] = []
    separators = 0  # targets with no character of their own (`separate_lines`)
    pending_separator: int | None = None
    for line_index, text in enumerate(line_texts):
        words_by_line.append(text.split())
        for word_index, word in enumerate(words_by_line[-1]):
            for char_index, ch in enumerate(word.lower()):
                token = dictionary.get(ch)
                if token is None or token in excluded:
                    continue
                if pending_separator is not None:
                    targets.append(pending_separator)
                    separators += 1
                    pending_separator = None
                targets.append(token)
                owners.append((line_index, word_index))
                char_of.append(char_index)
        if separator is not None and targets:
            # A BOUNDARY IS OWED, and is paid at the next line that has a character (so never trailing, and
            # never twice over a line that contributes none).
            pending_separator = separator

    if not targets or emissions.frames == 0:
        return Generated(lines=(), language=language)

    frame_labels, frame_scores = decode(emissions.log_probs, targets, blank)
    if separators:
        # THE SEPARATOR'S FRAMES BECOME BLANK (review 6c): it is a target the path had to visit, not a token
        # with a span, and as blank it plays exactly the part the blanks between two repeated characters
        # already play in `_char_spans`.
        frame_labels = [blank if label == separator else label for label in frame_labels]
    spans = _lead_starts(_char_spans(frame_labels, frame_scores, emissions.frame_sec, blank), ONSET_LEAD_SEC)
    # forced_align emits exactly one span per target when it succeeds; anything else means the decode and
    # the grouping disagree about the token stream, which is a defect and not a degradable condition.
    # MINUS THE SEPARATORS, whose frames were just relabelled away: they are targets that own no character.
    if len(spans) != len(targets) - separators:
        raise ValueError(
            f"decode produced {len(spans)} token spans for {len(targets) - separators} character targets "
            f"(of {len(targets)}, {separators} of them line separators); "
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
