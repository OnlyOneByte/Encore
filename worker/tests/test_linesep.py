"""6c's LINE SEPARATOR: `|` in the CTC targets at line boundaries only (D1, the `linesep` arm).

A file of its own, like `test_blank_id.py` for M9, because the separator is one token and four places that
have to agree: the target list (between lines, never inside one, never at an edge, one boundary per gap
however many decorative rows sit in it), the relabel of its frames to blank before `_char_spans`, the
span-count invariant that check turns into `spans == targets - separators`, and `regenerate`'s window floor,
which is a floor on TARGETS and so grows with them. Three fail LOUDLY when wrong; the fourth fails silently
by admitting a smear, which is the one the blank-id work already learned to test directly.

It is DISPUTED and ships off, so what is pinned here is BEHAVIOUR rather than a gain: that the arm does what
6c describes, that it is inert where the vocabulary has no separator, and that with it off nothing moves.
"""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from encore_worker.domain.lyrics.generate import (
    Line,
    _char_spans,
    alignable_chars,
    generate,
    regenerate,
    separator_named,
    separator_of,
)
from encore_worker.domain.lyrics.policy import Tier
from encore_worker.host.config import ALIGN_EXPERIMENTS, Config
from encore_worker.steps.align_notes import _linesep_why
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.records import AudioRef, JobRef, TextRef, TimedDoc, TimeRequest
from tests.ctc_fixture import FRAME_SEC, Matrix, char_frames, ctc_viterbi, sung_matrix

DIC = {ch: i + 1 for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz'")}
PIPE = "|"
#: The shipped `en` vocabulary's shape (`{'-': 0, '|': 1, 'e': 2, ...}`) with the separator APPENDED instead
#: of inserted, so the sung letters keep the ids every other fixture in this suite gives them.
VOCAB = {**DIC, PIPE: max(DIC.values()) + 1}
SEPARATOR = VOCAB[PIPE]

#: Two lines whose boundary is a REPEATED LETTER: `me` / `each`. CTC needs a blank between two occurrences of
#: one label, so this is the pair that proves the relabel: the separator's frames have to play the blank's
#: part or the two `e`s merge into one span and the span count stops matching the targets.
REPEAT = ("come away with me", "each of the lost days")
REPEAT_SUNG = ((REPEAT[0], 0.4, 2.2), (REPEAT[1], 2.6, 4.4))
REPEAT_DURATION = 5.0

#: Three lines with a `|` SUNG between them — the only fixture where the model hears what the arm asks about,
#: and so the only one that can show the arm moving a timing for the reason review D1 gives.
LINES = ("a candle in a paper cup", "and all the ash it carries", "away from what we are")
BOUNDARY = 0.2  # seconds of separator between two lines
SEPARATED = (
    (LINES[0], 0.4, 2.2),
    (PIPE, 2.3, 2.3 + BOUNDARY),
    (LINES[1], 2.6, 4.6),
    (PIPE, 4.7, 4.7 + BOUNDARY),
    (LINES[2], 5.0, 6.8),
)
DURATION = 7.4

#: How much the boundary also SOUNDS LIKE the next line's first letter in `dragged()` — a held vowel or a
#: breath across the gap, log 0.5 against the sung letter's 0.9 and the silence's 0.0037.
DRAGGING = math.log(0.5)

ONE_SYLLABLE: Any = lambda word, _language: [word]  # noqa: E731 - the suite's "do not syllabify" fixture


@dataclass(frozen=True)
class Specialled:
    """`Emissions`' duck type as the shipped adapter builds it: it NAMES its non-character columns."""

    log_probs: Any
    frame_sec: float
    dictionary: dict[str, int]
    blank_id: int = 0
    specials: dict[str, int] = field(default_factory=dict)

    @property
    def frames(self) -> int:
        return int(np.asarray(self.log_probs).shape[0])


def named(matrix: Matrix, *, separator: int | None = SEPARATOR) -> Specialled:
    """`matrix` under a vocabulary that names `|` at `separator` (None: one that names none)."""
    return Specialled(
        log_probs=matrix,
        frame_sec=FRAME_SEC,
        dictionary=VOCAB,
        blank_id=0,
        specials={"<pad>": 0} | ({} if separator is None else {PIPE: separator}),
    )


def dragged() -> Matrix:
    """`SEPARATED`, with each boundary ALSO sounding a little like the next line's first letter.

    THE FAILURE D1's FOR COLUMN IS ABOUT, in the smallest form that reproduces it. A sung boundary is rarely
    silence — it is a held vowel, a breath, the tail of the last word — and a forced path with no boundary
    token to spend those frames on will start the next line inside them if the letter is even slightly
    cheaper there than the blank. The arm's separator is what the frames then belong to instead. Measured
    below: lines 2 and 3 start 0.32 s and 0.30 s early without the arm and on their true onsets with it.
    """
    matrix = sung_matrix(SEPARATED, VOCAB, DURATION)
    boundaries = [(a, b) for a, b, token in char_frames(SEPARATED, VOCAB) if token == SEPARATOR]
    for (first, last), line in zip(boundaries, LINES[1:], strict=True):
        matrix[first:last, VOCAB[line[0]]] = DRAGGING
    return matrix


@dataclass
class Recording:
    """Every target list a decode was handed, in order — the arm's own output, before any grouping."""

    seen: list[list[int]] = field(default_factory=list)

    def decoder(self) -> Any:
        def decode(
            log_probs: object, targets: Sequence[int], blank: int = 0
        ) -> tuple[list[int], list[float]]:
            self.seen.append(list(targets))
            return ctc_viterbi(log_probs, targets, blank)

        return decode

    @property
    def last(self) -> list[int]:
        assert self.seen, "nothing decoded"
        return self.seen[-1]

    def boundaries(self) -> list[int]:
        """Where the separator sits in the last target list, as positions among the targets."""
        return [i for i, token in enumerate(self.last) if token == SEPARATOR]


# ── which column the arm emits (`separator_of`) ────────────────────────────────────────────────────────


def test_the_separator_is_the_one_the_matrix_names_and_nothing_otherwise() -> None:
    """Read off `specials`, exactly as `excluded_of` reads it, so the filter that keeps a lyric's literal `|`
    out of a word and the arm that puts one between lines cannot disagree about which column that is."""
    assert separator_of(named(np.zeros((1, 2), dtype=np.float32))) == SEPARATOR
    assert separator_of(named(np.zeros((1, 2), dtype=np.float32), separator=None)) is None
    assert separator_of(object()) is None, "a matrix that names no specials has no separator to emit"


def test_a_separator_that_is_the_blank_column_makes_the_arm_inert_rather_than_fatal() -> None:
    """`forced_align` REFUSES a target list containing the blank outright, so a vocabulary that maps `|` to
    its blank column would turn every decode under this arm into a decline — the whole song, on every text,
    for a display experiment. Reachable: whisperx tables Norwegian Bokmal with `|` at id 0, and it is only
    that vocabulary's `[PAD]`=38 keeping the two apart."""
    collide = Specialled(
        log_probs=np.zeros((1, 2), dtype=np.float32),
        frame_sec=FRAME_SEC,
        dictionary=VOCAB,
        blank_id=SEPARATOR,
        specials={PIPE: SEPARATOR},
    )
    assert separator_of(collide) is None

    # The same thing end to end, on the shape that vocabulary really has: `|` at id 0, which is also where a
    # torchaudio bundle's blank is. The arm must publish the DEFAULT's document rather than raise.
    at_zero = {**DIC, PIPE: 0}
    blanked = Specialled(
        log_probs=sung_matrix(REPEAT_SUNG, at_zero, REPEAT_DURATION),
        frame_sec=FRAME_SEC,
        dictionary=at_zero,
        blank_id=0,
        specials={"<pad>": 0, PIPE: 0},
    )
    got = generate(
        REPEAT, blanked, decoder=ctc_viterbi, syllabifier=ONE_SYLLABLE, separate_lines=True
    ).as_doc()
    want = generate(REPEAT, blanked, decoder=ctc_viterbi, syllabifier=ONE_SYLLABLE).as_doc()
    assert got == want, "the arm decoded as the default, and the trail note says so (`_linesep_why`)"


def test_the_trail_says_which_of_the_two_inert_cases_happened() -> None:
    """W4b review r1. `host.config.ALIGN_EXPERIMENTS` states it as this arm's contract — "INERT, not fatal, on
    a vocabulary that names no separator or maps it to the blank column, and the trail note says which of the
    two happened" — and both folded into one message, so an operator on a bundle whose `|` IS its blank column
    (the ONLY reason the arm is inert rather than fatal) read "this vocabulary names none" and had no way to
    tell the two apart but a vocabulary dump.

    `separator_named` is the unfolded reading; `separator_of` stays the one the decode uses."""
    none_named = named(np.zeros((1, 2), dtype=np.float32), separator=None)
    collides = Specialled(
        log_probs=np.zeros((1, 2), dtype=np.float32),
        frame_sec=FRAME_SEC,
        dictionary=VOCAB,
        blank_id=SEPARATOR,
        specials={PIPE: SEPARATOR},
    )
    assert (separator_named(none_named), separator_named(collides)) == (None, SEPARATOR)
    assert separator_named(object()) is None, "a matrix that names no specials names no `|` either"
    assert (separator_of(none_named), separator_of(collides)) == (None, None), "both are inert"

    def why(matrix: object) -> str:
        return _linesep_why(separator_of(matrix), named=separator_named(matrix))

    assert "names none" in why(none_named) and "blank column" not in why(none_named)
    said = why(collides)
    assert f"`|` IS its blank column (id {SEPARATOR})" in said and "inert" in said
    assert "names none" not in said, "the case the arm exists for must not read as the absent one"
    assert f"id {SEPARATOR}" in why(named(np.zeros((1, 2), dtype=np.float32))), "and a live arm names its id"


# ── where the separator goes in the targets ────────────────────────────────────────────────────────────


def test_the_arm_off_is_the_target_list_it_always_was() -> None:
    """The default path is not merely equivalent: it is the same call. Nothing is emitted, nothing relabelled,
    and the span check is the count it was before this arm existed."""
    matrix = named(sung_matrix(REPEAT_SUNG, VOCAB, REPEAT_DURATION))
    tap = Recording()
    got = generate(REPEAT, matrix, decoder=tap.decoder(), syllabifier=ONE_SYLLABLE)
    assert SEPARATOR not in tap.last
    assert len(tap.last) == sum(alignable_chars(text, matrix) for text in REPEAT)
    plain = generate(REPEAT, matrix, decoder=ctc_viterbi, syllabifier=ONE_SYLLABLE, separate_lines=False)
    assert got.as_doc() == plain.as_doc()


def test_one_separator_per_boundary_and_never_at_an_edge() -> None:
    """Review 6c's own words: BETWEEN lines. So the target list neither starts nor ends with a separator, and
    two lines of a three-line text are separated twice, not four times."""
    matrix = named(sung_matrix(SEPARATED, VOCAB, DURATION))
    tap = Recording()
    generate(LINES, matrix, decoder=tap.decoder(), syllabifier=ONE_SYLLABLE, separate_lines=True)
    chars = [alignable_chars(text, matrix) for text in LINES]
    assert tap.boundaries() == [chars[0], chars[0] + 1 + chars[1]]
    assert len(tap.last) == sum(chars) + 2
    assert tap.last[0] != SEPARATOR and tap.last[-1] != SEPARATOR


def test_a_line_with_no_alignable_character_is_one_boundary_and_not_two() -> None:
    """A decorative row (`♪`, an emoji line) and a line the never-sung rule blanked to `""` both contribute no
    character, so the boundary they sit in is still ONE separator. Two consecutive separator targets would
    cost a second frame each side of nothing and — where the frames are tight — refuse a repair that fits."""
    matrix = named(sung_matrix(SEPARATED, VOCAB, DURATION))
    for filler in ("", "♪", "   "):
        tap = Recording()
        generate(
            [LINES[0], filler, LINES[1]],
            matrix,
            decoder=tap.decoder(),
            syllabifier=ONE_SYLLABLE,
            separate_lines=True,
        )
        assert tap.boundaries() == [alignable_chars(LINES[0], matrix)], f"{filler!r} split the boundary"

    tap = Recording()
    generate(["♪", LINES[0], "♪"], matrix, decoder=tap.decoder(), separate_lines=True)
    assert tap.boundaries() == [], "a text with one sung line has no boundary to mark"


# ── the frames: relabelled to blank before the spans are grouped ───────────────────────────────────────


def test_the_separators_frames_play_the_blanks_part_in_the_grouping() -> None:
    """`_char_spans` is a merge of maximal runs of one non-blank label, and CTC's topology puts a blank
    between two occurrences of the SAME label. A separator relabelled to blank is therefore exactly the
    separator the grouping already understands — and left unrelabelled it is a third span between the two
    `e`s, which is what the span check would then raise on."""
    blank, letter = 0, 5
    labels = [letter, SEPARATOR, letter]
    scores = [-0.1, -0.2, -0.3]
    assert len(_char_spans(labels, scores, FRAME_SEC, blank)) == 3, "unrelabelled: the separator is a span"
    relabelled = [blank if label == SEPARATOR else label for label in labels]
    spans = _char_spans(relabelled, scores, FRAME_SEC, blank)
    assert [(round(start, 4), round(end, 4)) for start, end, _s in spans] == [(0.0, 0.02), (0.04, 0.06)]


def test_a_repeated_letter_across_a_boundary_still_publishes_two_words() -> None:
    """The end-to-end form of the case above: `...me` / `each...`. Every character keeps a span of its own, so
    the document has every word, in order, nested — the invariant `generate` raises on when the separator is
    counted wrongly anywhere in the chain."""
    matrix = named(sung_matrix(REPEAT_SUNG, VOCAB, REPEAT_DURATION))
    got = generate(REPEAT, matrix, decoder=ctc_viterbi, syllabifier=ONE_SYLLABLE, separate_lines=True)
    assert [line.text for line in got.lines] == list(REPEAT)
    placed = [(w.word, w.start, w.end) for line in got.lines for w in line.words]
    assert [word for word, _s, _e in placed] == [word for text in REPEAT for word in text.split()]
    assert all(end > start for _w, start, end in placed), "no word lost its span to the separator"
    assert [start for _w, start, _e in placed] == sorted(start for _w, start, _e in placed)
    first, second = got.lines
    assert first.words[-1].end <= second.words[0].start


def test_the_span_check_counts_the_separators_and_says_so() -> None:
    """The invariant is spans == targets - separators. A decoder that emits one span too many must still be
    caught, and the message has to name both counts or the next reader of it will think the arm is the bug."""

    def extra(log_probs: object, targets: Sequence[int], blank: int = 0) -> tuple[list[int], list[float]]:
        labels, scores = ctc_viterbi(log_probs, targets, blank)
        # One more span than there are characters: a letter run planted in the trailing silence.
        return [*labels[:-2], 7, blank], scores

    matrix = named(sung_matrix(REPEAT_SUNG, VOCAB, REPEAT_DURATION))
    with pytest.raises(ValueError, match=r"character targets \(of \d+, 1 of them line separators\)"):
        generate(REPEAT, matrix, decoder=extra, syllabifier=ONE_SYLLABLE, separate_lines=True)


# ── what it does to a timing, where the model hears the boundary ───────────────────────────────────────


def test_the_separator_keeps_the_next_lines_onset_out_of_the_boundary() -> None:
    """The mechanism D1's FOR column is about, in the smallest form that reproduces it (`dragged`).

    Without a boundary token the path has nothing to spend the boundary's frames on, so it starts the next
    line inside them: line 2 opens at 2.25 s and line 3 at 4.67 against true onsets of 2.6 and 5.0 — 0.32 s
    and 0.30 s early, the shape of a gross line start. With the separator emitted those frames belong to it
    and both lines land on their own onsets (2.57 / 4.97, the true onset less `ONSET_LEAD_SEC`), while
    nothing else in either document moves. A SILENT boundary changes nothing at all, which is half of why
    the corpus verdict is a factorial and not a unit test."""
    matrix = named(dragged())
    kwargs: dict[str, Any] = {"decoder": ctc_viterbi, "syllabifier": ONE_SYLLABLE}
    plain = generate(LINES, matrix, **kwargs)
    armed = generate(LINES, matrix, **kwargs, separate_lines=True)

    assert [round(line.start, 2) for line in plain.lines] == [0.37, 2.25, 4.67]
    assert [round(line.start, 2) for line in armed.lines] == [0.37, 2.57, 4.97]
    assert [round(line.end, 2) for line in armed.lines] == [round(line.end, 2) for line in plain.lines]
    assert [w.word for line in armed.lines for w in line.words] == [
        w.word for line in plain.lines for w in line.words
    ]

    silent = named(sung_matrix(SEPARATED, VOCAB, DURATION))
    assert (
        generate(LINES, silent, **kwargs, separate_lines=True).as_doc()
        == generate(LINES, silent, **kwargs).as_doc()
    ), "over a silent boundary the arm is a different path with the same document"


# ── regenerate: the window floor is a floor on TARGETS ─────────────────────────────────────────────────


def test_a_repair_window_decodes_with_the_separator_the_global_pass_used() -> None:
    """A window re-decoded without it would put the repaired line on a different token stream from the lines
    around it. `_SlicedEmissions` already carries `specials` (W4b), so the slice can see the column."""
    matrix = named(sung_matrix(SEPARATED, VOCAB, DURATION))
    run = tuple(
        Line(text=text, start=start, end=end, words=(), score=0.0, index=i)
        for i, (text, start, end) in enumerate([(LINES[0], 0.4, 2.2), (LINES[1], 2.6, 4.6)])
    )
    tap = Recording()
    repaired = regenerate(
        [(run, (0.3, 4.8))],
        matrix,
        decoder=tap.decoder(),
        syllabifier=ONE_SYLLABLE,
        separate_lines=True,
    )
    assert set(repaired) == {0, 1}, "the fixture's window must really repair"
    assert tap.boundaries() == [alignable_chars(LINES[0], matrix)]


def test_the_window_floor_grows_with_the_separators_it_will_emit() -> None:
    """THE ONE PLACE A MISCOUNT IS SILENT. `regenerate` refuses a window holding fewer than two emission
    frames per target — anything tighter is a forced smear, not a fit — and the arm adds one target per
    boundary. Here the window is exactly two frames per CHARACTER of a two-line run: over the default's floor
    and one target under the arm's, so the default repairs and the arm refuses. A guard that missed the
    separator would force 32 targets through a window sized for 31, which is the truncated-caption shape
    `alignable_chars` exists for, arriving from the other side.
    """
    matrix = named(sung_matrix(REPEAT_SUNG, VOCAB, REPEAT_DURATION))
    run = tuple(
        Line(text=text, start=start, end=end, words=(), score=0.0, index=i)
        for i, (text, start, end) in enumerate(REPEAT_SUNG)
    )
    chars = sum(alignable_chars(text, matrix) for text in REPEAT)
    # Built from FRAME INDICES with half a frame of slack, because `regenerate` floors both edges: a window
    # written as `(first * FRAME_SEC, (first + 2 * chars) * FRAME_SEC)` loses its last frame to binary
    # floating point (`int(1.64 / 0.02) == 81`), which would make this test pass for the wrong reason.
    first = 20
    window = (first * FRAME_SEC, (first + 2 * chars + 0.5) * FRAME_SEC)
    kwargs: dict[str, Any] = {"decoder": ctc_viterbi, "syllabifier": ONE_SYLLABLE}
    assert set(regenerate([(run, window)], matrix, **kwargs)) == {0, 1}
    assert set(regenerate([(run, window)], matrix, **kwargs, separate_lines=True)) == set()
    # One frame more and the arm's own floor is met, so the refusal is the count and not the window.
    wider = (window[0], window[1] + 2 * FRAME_SEC)
    assert set(regenerate([(run, wider)], matrix, **kwargs, separate_lines=True)) == {0, 1}


def test_the_floor_charges_for_every_boundary_and_not_for_one() -> None:
    """A three-line run is charged TWO separators, so the floor is `2 * (chars + 2)`. A count that used one
    boundary per RUN instead of one per gap would be right on the two-line case above and wrong here.

    A run holding a characterless row is not this test's shape and cannot be: `generate` publishes no line for
    it, so `regenerate` sees fewer lines back than it sent and keeps the originals whatever the floor said
    (pre-existing behaviour, unrelated to this arm). Which lines a boundary is owed between is therefore
    `generate`'s to prove, and it does, above.
    """
    matrix = named(sung_matrix(SEPARATED, VOCAB, DURATION))
    run = tuple(
        Line(text=text, start=start, end=end, words=(), score=0.0, index=i)
        for i, (text, start, end) in enumerate(
            [(LINES[0], 0.4, 2.2), (LINES[1], 2.6, 4.6), (LINES[2], 5.0, 6.8)]
        )
    )
    chars = sum(alignable_chars(text, matrix) for text in LINES)
    first = 20
    kwargs: dict[str, Any] = {"decoder": ctc_viterbi, "syllabifier": ONE_SYLLABLE}

    def window(targets: int) -> tuple[float, float]:
        return (first * FRAME_SEC, (first + 2 * targets + 0.5) * FRAME_SEC)

    assert set(regenerate([(run, window(chars))], matrix, **kwargs)) == {0, 1, 2}
    assert set(regenerate([(run, window(chars + 1))], matrix, **kwargs, separate_lines=True)) == set()
    assert set(regenerate([(run, window(chars + 2))], matrix, **kwargs, separate_lines=True)) == {0, 1, 2}


# ── the arm reaches the shipped step, and says which ───────────────────────────────────────────────────


class SepAligner:
    """An `Aligner` whose matrices name `|`, or (when `separator` is None) name no specials at all."""

    def __init__(self, matrix: Matrix, *, separator: int | None) -> None:
        self._matrix = matrix
        self._separator = separator
        self.asked: list[str] = []

    def emissions(self, path: str, _language: str) -> Specialled:
        self.asked.append(path)
        return named(self._matrix, separator=self._separator)

    def align(self, *_a: object) -> tuple[dict[str, object], ...]:
        raise AssertionError("the windowed engine must not run: the global decode has emissions")


def step_run(
    media: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    experiments: frozenset[str],
    separator: int | None = SEPARATOR,
) -> tuple[Any, str, list[dict[str, Any]]]:
    """One real `time_text` over the separator fixture: its result, its verdict note and its written lines.

    `media` is this attempt's OWN directory (two attempts in one test must not share written documents).
    """
    from encore_worker.adapters import ml
    from tests.test_align_provenance import TrailSpy, sung_wav

    media.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    wav = sung_wav(media / "vocals.wav", list(SEPARATED), DURATION, seed=0)
    mix = sung_wav(media / "mix.wav", list(SEPARATED), DURATION, seed=1)
    aligner = SepAligner(dragged(), separator=separator)
    trail = TrailSpy()
    impl = AlignStepsImpl(
        config=Config(align_experiments=experiments),
        adapters=Adapters(aligner=aligner),
        reporter=trail,
    )
    request = TimeRequest(
        job=JobRef(job_id="j1", media_id="m1", media_dir=str(media), source_uri=None),
        text=TextRef(
            tier=Tier.CANDIDATE,
            label="test",
            segments=tuple({"text": text} for text in LINES),
            timing="none",
        ),
        audio=AudioRef(path=mix, vocals_path=wav, duration_sec=DURATION),
        language="en",
    )
    got = asyncio.run(impl.time_text(request))
    notes = [state for state in trail.states if state[1] == "align-global"]
    lines: list[dict[str, Any]] = []
    if isinstance(got, TimedDoc):
        lines = json.loads((media / got.ref).read_text())["lines"]
    return got, str(notes[-1][4]), lines


def test_the_step_decodes_with_the_separator_only_under_the_arm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The wiring, through the real `_time_text_global`: every decode that produces a PUBLISHED timing gets
    the arm, and the verdict note carries it so an audit page can tell an arm's run from the default's.

    Read on the ONSETS, which is also a fact about what the arm can be measured on at all: the word-end
    post-pass runs after every decode and re-fits every END from the envelope, so on a stem it ERASES
    whatever the separator did to an end and leaves only the starts. That is why the onset fixture drags an
    ONSET, and why the factorial's word-±300 and gross-line columns are where a verdict can come from."""
    default, plain_note, plain_lines = step_run(tmp_path / "off", monkeypatch, experiments=frozenset())
    assert isinstance(default, TimedDoc), default
    assert "line separator" not in plain_note, "the default's note says nothing about a separator"

    armed, armed_note, armed_lines = step_run(
        tmp_path / "on", monkeypatch, experiments=frozenset({"linesep"})
    )
    assert isinstance(armed, TimedDoc), armed
    assert f"line separator: `|` (id {SEPARATOR}) between lines, its frames blank (linesep)" in armed_note
    assert [line["text"] for line in armed_lines] == [line["text"] for line in plain_lines]
    assert [round(float(line["start"]), 2) for line in plain_lines] == [0.37, 2.25, 4.67]
    assert [round(float(line["start"]), 2) for line in armed_lines] == [0.37, 2.57, 4.97], (
        "the arm reached the shipped decode, or this test proves nothing"
    )


@dataclass
class Decodes:
    """Every `separate_lines` the step handed the two decoders that produce PUBLISHED timings, in order.

    `align_steps` imports `generate`/`regenerate` inside `_time_text_global`, so the patch goes on the domain
    module and every call re-reads it — the same seam `tests.test_align_provenance` taps for the decoder.
    """

    whole: list[bool] = field(default_factory=list)
    windows: list[bool] = field(default_factory=list)

    def tap(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from encore_worker.domain.lyrics import generate as module

        real_generate, real_regenerate = module.generate, module.regenerate

        def generate_spy(*args: Any, separate_lines: bool = False, **kwargs: Any) -> Any:
            self.whole.append(separate_lines)
            return real_generate(*args, separate_lines=separate_lines, **kwargs)

        def regenerate_spy(*args: Any, separate_lines: bool = False, **kwargs: Any) -> Any:
            self.windows.append(separate_lines)
            return real_regenerate(*args, separate_lines=separate_lines, **kwargs)

        monkeypatch.setattr(module, "generate", generate_spy)
        monkeypatch.setattr(module, "regenerate", regenerate_spy)


def test_every_repair_window_is_decoded_under_the_arm_and_none_with_it_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """W4b REVIEW R2, tests-17: `test_the_step_decodes_with_the_separator_only_under_the_arm` claims to cover
    every decode that publishes a timing, but only the BLIND one was exercised — its three-line fixture has no
    claims to repair, so hard-coding `separate_lines=False` at the repair call site left the whole suite
    green. The ladder's own M5 fixture puts R1 on all six lines, so every repair window is one of these calls.

    The unit half (`test_a_repair_window_decodes_with_the_separator_the_global_pass_used`) proves the
    separator reaches the TARGETS of a window; what was missing is that the STEP asks for it.
    """
    from tests.ctc_fixture import misheard
    from tests.test_align_provenance import SCATTERED, TRUNCATED, TRUNCATED_DURATION, align, truth

    def run(media: Path, experiments: frozenset[str]) -> Decodes:
        media.mkdir(parents=True, exist_ok=True)
        spy = Decodes()
        spy.tap(monkeypatch)
        got = align(
            media,
            monkeypatch,
            phrases=TRUNCATED,
            duration=TRUNCATED_DURATION,
            claims=[*truth(TRUNCATED)[:5], (40.0, None)],
            decoder=misheard(
                sung_matrix(SCATTERED, DIC, TRUNCATED_DURATION), int(TRUNCATED_DURATION / FRAME_SEC)
            ),
            experiments=experiments,
        )
        assert "timing sources: 6 window" in got.verdict[4], "the fixture must really repair"
        return spy

    armed = run(tmp_path / "on", frozenset({"linesep"}))
    assert armed.windows and all(armed.windows), f"a repair window decoded without the arm: {armed.windows}"
    assert armed.whole and all(armed.whole)
    off = run(tmp_path / "off", frozenset())
    assert off.windows and not any(off.windows), "and the default asks for none of it"
    assert off.whole and not any(off.whole)


def test_the_re_decode_after_a_never_sung_drop_keeps_the_arm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """W4b REVIEW R2, tests-17, the second uncovered site. The never-sung rule drops a line and re-decodes the
    rest over the matrix already in hand; that document is what publishes, so its decode owns the arm too, and
    `separate_lines=False` there also left the suite green. The fixture is the ladder's own credit case: an
    uploader's line the stem holds only a faint trace of, claimed over the outro."""
    from encore_worker.steps import align_steps
    from tests.test_align_provenance import (
        FAINT,
        UNIQUE,
        UNIQUE_DURATION,
        align,
        truth,
        weakly_sung,
    )

    # The rule's tempo signal is fitted on real songs (~1 char/s); a trace short enough to fit this song's
    # silence smears faster, so it is relaxed exactly as `test_align_provenance.any_tempo` relaxes it.
    monkeypatch.setattr(align_steps, "_NEVER_SUNG_RATE", 1000.0)
    credit = "thanks for watching everyone"

    def run(media: Path, experiments: frozenset[str]) -> Decodes:
        media.mkdir(parents=True, exist_ok=True)
        spy = Decodes()
        spy.tap(monkeypatch)
        got = align(
            media,
            monkeypatch,
            phrases=UNIQUE,
            duration=UNIQUE_DURATION,
            claims=[*truth(UNIQUE), (44.0, 47.0)],
            stem_matrix=weakly_sung(sung_matrix(UNIQUE, DIC, UNIQUE_DURATION), (credit, 43.0, 49.0), FAINT),
            extra_text=[credit],
            experiments=experiments,
        )
        assert f"dropped never-sung: [{len(UNIQUE)}] {credit!r}" in got.verdict[4]
        assert len(spy.whole) == 2, f"the blind decode and the re-decode after the drop: {spy.whole}"
        return spy

    armed = run(tmp_path / "on", frozenset({"linesep"}))
    assert all(armed.whole), f"the re-decode dropped the arm: {armed.whole}"
    off = run(tmp_path / "off", frozenset())
    assert not any(off.whole), "and the default asks for none of it"


def test_an_arm_that_cannot_act_says_so_on_the_trail(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A vocabulary naming no separator makes the arm INERT, and an arm going quietly inert is the same
    mistake `Config.ALIGN_EXPERIMENTS` refuses unknown names to prevent, arriving from the other side: the run
    would be recorded under the arm's name having measured the default path."""
    inert, note, lines = step_run(
        tmp_path / "inert", monkeypatch, experiments=frozenset({"linesep"}), separator=None
    )
    assert isinstance(inert, TimedDoc), inert
    assert "line separator: requested (linesep) but this vocabulary names none" in note
    default, _plain_note, plain_lines = step_run(
        tmp_path / "off", monkeypatch, experiments=frozenset(), separator=None
    )
    assert isinstance(default, TimedDoc)
    assert lines == plain_lines, "and it published exactly the default's document"


def test_the_arm_is_a_declared_experiment() -> None:
    """It ships OFF behind the ONE knob, and an unknown name is refused (`test_ownership`), so the name has to
    be declared for `ENCORE_ALIGN_EXPERIMENTS=linesep` to be settable at all."""
    assert "linesep" in ALIGN_EXPERIMENTS
    assert Config.from_env({"ENCORE_ALIGN_EXPERIMENTS": "linesep"}).align_experiments == frozenset(
        {"linesep"}
    )
    assert Config.from_env({}).align_experiments == frozenset()
