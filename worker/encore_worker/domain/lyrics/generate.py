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
the split points, the spans are already timed). A sustained sung vowel's char span stretches with the
singing, so a syllable's duration is its SUNG duration — the behaviour a karaoke ball wants.

WHAT THE PATH SCORE IS NOT. The whole-path CTC score does NOT detect wrong text — measured: a different
song's lyrics scored BETTER on the mix (-0.367 against -0.472). Per-line means are carried for GRADING
lines against each other within one song; the wrong-song verdict belongs to the activity-envelope gate
(`domain/audio/activity.py`), which does separate the populations.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

#: A word whose every character is out-of-dictionary gets its span INTERPOLATED from its neighbours and
#: this confidence, so a non-Latin token or a run of digits degrades one word rather than failing the line.
OOV_CONFIDENCE = "low"

#: How far every char span's START is pulled back toward the true acoustic onset, clamped at the previous
#: span's end. MEASURED, not tuned: across 5693 words with hand-measured onsets (JamendoLyrics, 20 songs)
#: the raw decode starts +41 ms late on EVERY song — wav2vec2 emits a character a frame or two after the
#: sound begins — while ENDS are 46 ms EARLY, so this applies to starts only; a translation would damage
#: the ends it fixed the starts with. Effect at the measured optimum (40-50 ms): words within ±100 ms of
#: truth go from 72.0% to ~79%. The clamp is what makes it safe: an interior char bounded by its
#: predecessor cannot move, so the lead acts exactly where the delay physically lives — onsets after gaps.
ONSET_LEAD_SEC = 0.04


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


#: `(log_probs, targets) -> (frame_labels, frame_scores)`. In production this is
#: `adapters.ml.forced_align_decoder` (torchaudio's CTC kernel); it lives THERE and not here because
#: domain/ is pure functions over data and must run with no ML installed — a layering rule with its own
#: test. Injection is also what makes the grouping logic hermetically testable.
Decoder = Callable[[Any, Sequence[int]], tuple[Sequence[int], Sequence[float]]]


def _char_spans(
    frame_labels: Sequence[int], frame_scores: Sequence[float], frame_sec: float
) -> list[tuple[float, float, float]]:
    """Per-emitted-token `(start, end, mean_score)`, in target order.

    A hand-rolled merge rather than `torchaudio.functional.merge_tokens` so the grouping half of this
    module runs — and is tested — without torch. CTC repeats a label across frames and separates repeats
    with blanks; a span is a maximal run of one non-blank label.
    """
    spans: list[tuple[float, float, float]] = []
    run_label, run_start, run_scores = 0, 0, []  # type: int, int, list[float]
    for index, label in enumerate([*frame_labels, 0]):  # sentinel blank flushes the last run
        if label == run_label:
            if label != 0:
                run_scores.append(frame_scores[index] if index < len(frame_scores) else 0.0)
            continue
        if run_label != 0:
            spans.append(
                (
                    run_start * frame_sec,
                    index * frame_sec,
                    sum(run_scores) / len(run_scores) if run_scores else 0.0,
                )
            )
        run_label, run_start = label, index
        run_scores = [frame_scores[index]] if label != 0 and index < len(frame_scores) else []
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
    """
    repaired: dict[int, Line] = {}
    for run, (window_start, window_end) in runs:
        if not run or emissions.frame_sec <= 0:
            continue
        first = max(0, int(window_start / emissions.frame_sec))
        last = min(emissions.frames, int(window_end / emissions.frame_sec))
        alignable = sum(
            1
            for line in run
            for word in line.text.split()
            for ch in word.lower()
            if emissions.dictionary.get(ch) not in (None, 0)
        )
        # CTC needs at least one frame per target; anything tighter than 2x is a forced smear, not a fix.
        if alignable == 0 or (last - first) < 2 * alignable:
            continue
        window = _SlicedEmissions(
            log_probs=emissions.log_probs[first:last],
            frame_sec=emissions.frame_sec,
            dictionary=emissions.dictionary,
        )
        try:
            got = generate(
                [line.text for line in run],
                window,
                language=language,
                decoder=decoder,
                syllabifier=syllabifier,
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
) -> Generated:
    """Align `line_texts` over the whole recording and return nested line/word/syllable timings.

    `emissions` is `adapters.ml.Emissions` (duck-typed: `log_probs`, `frame_sec`, `dictionary`), computed
    once per song and shared by every candidate text — that is the design's cost model: one 4 s model pass,
    then a millisecond decode per candidate.

    THE BLANK ID IS EXCLUDED FROM TARGETS, and that is a measured requirement rather than tidiness: the
    English dictionary maps `-` to id 0, which is also CTC's blank, and `forced_align` refuses a target
    list containing it outright.

    STRUCTURAL INVARIANT (tested): syllables nest within their word's span, words within their line's,
    all ordered. It holds by construction — every level groups the same char spans — and the test exists
    so a refactor that breaks construction is caught by the property, not by a benchmark regression.
    """
    dictionary: Mapping[str, int] = emissions.dictionary
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
    for line_index, text in enumerate(line_texts):
        words_by_line.append(text.split())
        for word_index, word in enumerate(words_by_line[-1]):
            for char_index, ch in enumerate(word.lower()):
                token = dictionary.get(ch)
                if token is None or token == 0:
                    continue
                targets.append(token)
                owners.append((line_index, word_index))
                char_of.append(char_index)

    if not targets or emissions.frames == 0:
        return Generated(lines=(), language=language)

    frame_labels, frame_scores = decode(emissions.log_probs, targets)
    spans = _lead_starts(_char_spans(frame_labels, frame_scores, emissions.frame_sec), ONSET_LEAD_SEC)
    # forced_align emits exactly one span per target when it succeeds; anything else means the decode and
    # the grouping disagree about the token stream, which is a defect and not a degradable condition.
    if len(spans) != len(targets):
        raise ValueError(
            f"decode produced {len(spans)} token spans for {len(targets)} targets; "
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
