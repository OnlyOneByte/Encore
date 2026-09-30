"""CTC's blank is the MATRIX's, not a literal 0 (review M9), end to end over the whole decode chain.

WHY A FILE OF ITS OWN. `blank = 0` was hard-coded in five places that have to agree — the kernel call, the
target filter, `_char_spans`' run grouping and its flushing sentinel, `regenerate`'s alignable count and the
mix witness's non-blank mass — and the defect is DORMANT while the language is always `en`, because
torchaudio's bundles do put their blank at label 0. So no test that decodes English can see it. 23 of
whisperx's 36 HF align models put their pad elsewhere (the review's per-model vocabulary dumps: Danish
`<pad>`=32 with `u` at 0, Norwegian Bokmal `[PAD]`=38 with `|` at 0, Korean `[PAD]`=1204), and W7 turns the
language on.

HOW IT IS TESTED WITHOUT ANOTHER MODEL'S WEIGHTS, which is the review's own reproduction: PERMUTE the
fixture's matrix so the blank moves out of column 0 and a letter moves into it. That is the same evidence
under another vocabulary, so a blank-aware chain must return a BYTE-IDENTICAL document — and the old chain
must not, because it charges the true blank as a letter and silently drops every occurrence of the letter
that now sits at 0. Measured by the review on Danish: word onsets within ±250 ms 90.5% -> 73.2%, and words
more than 2 s out 141 -> 584.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pytest

from encore_worker.adapters.ml import blank_id_of
from encore_worker.domain.lyrics import lexical
from encore_worker.domain.lyrics.generate import Line, blank_of, generate, regenerate
from tests.ctc_fixture import FRAME_SEC, Matrix, ctc_viterbi, sung_matrix

DIC = {ch: i + 1 for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz'")}
SUNG = (
    ("a candle in a paper cup", 0.4, 2.2),
    ("and all the ash it carries", 2.6, 4.6),
    ("away from what we are", 5.0, 6.8),
)
DURATION = 7.4
#: The letter that changes places with the blank. `a` is everywhere in `SUNG`, so dropping it wrecks the
#: decode — which is the point: a permutation the chain ignores must be visible.
MOVED = "a"


@dataclass(frozen=True)
class Emitted:
    """`Emissions`' duck type. `blank_id` is a FIELD here and absent from `Unaware` below, which is how the
    `getattr` default that keeps every other fake working is held to being the only difference."""

    log_probs: Any
    frame_sec: float
    dictionary: dict[str, int]
    blank_id: int

    @property
    def frames(self) -> int:
        return int(np.asarray(self.log_probs).shape[0])


@dataclass(frozen=True)
class Unaware:
    """The same matrix through a reader that does NOT say which column is blank — every pre-W4 fake, and
    the shipped chain before review M9's fix."""

    log_probs: Any
    frame_sec: float
    dictionary: dict[str, int]

    @property
    def frames(self) -> int:
        return int(np.asarray(self.log_probs).shape[0])


def permuted(matrix: Matrix, dictionary: dict[str, int], letter: str) -> tuple[Matrix, dict[str, int]]:
    """The same evidence under a vocabulary whose blank is not 0: columns 0 and `letter`'s are swapped."""
    code = dictionary[letter]
    moved = np.array(matrix, copy=True)
    moved[:, [0, code]] = moved[:, [code, 0]]
    swapped = dict(dictionary)
    swapped[letter] = 0
    swapped["<pad>"] = code
    return moved, swapped


@pytest.fixture()
def evidence() -> tuple[Emitted, Emitted, Unaware]:
    plain = sung_matrix(SUNG, DIC, DURATION)
    moved, swapped = permuted(plain, DIC, MOVED)
    assert blank_id_of(swapped) == DIC[MOVED], "the fixture must really move the blank"
    return (
        Emitted(log_probs=plain, frame_sec=FRAME_SEC, dictionary=DIC, blank_id=0),
        Emitted(log_probs=moved, frame_sec=FRAME_SEC, dictionary=swapped, blank_id=blank_id_of(swapped)),
        Unaware(log_probs=moved, frame_sec=FRAME_SEC, dictionary=swapped),
    )


TEXTS = [text for text, _s, _e in SUNG]


def test_the_default_is_zero_only_for_a_matrix_that_does_not_say() -> None:
    """The `getattr` default is what keeps every fake emission object in this suite decoding as it did."""
    assert blank_of(Unaware(log_probs=[], frame_sec=0.02, dictionary={})) == 0
    assert blank_of(Emitted(log_probs=[], frame_sec=0.02, dictionary={}, blank_id=31)) == 31
    assert blank_of(object()) == 0


def test_char_spans_groups_runs_and_flushes_the_last_one_against_the_matrixs_blank() -> None:
    """`_char_spans` had the blank as a literal THREE times: the run it starts in, the run it refuses to
    emit, and the sentinel frame appended to flush the last one. The sentinel is the one a whole-song decode
    cannot show, because a song ends in silence and its last frames are blank either way — so it is asserted
    here on a label sequence that ends INSIDE a run of the letter that now occupies column 0.
    """
    from encore_worker.domain.lyrics.generate import _char_spans

    blank, other, at_zero = 1, 5, 0
    labels = [blank, other, other, blank, at_zero, at_zero]
    scores = [-0.1, -0.2, -0.3, -0.4, -0.5, -0.6]
    spans = _char_spans(labels, scores, 0.02, blank)
    assert [(round(start, 4), round(end, 4)) for start, end, _score in spans] == [
        (0.02, 0.06),
        (0.08, 0.12),
    ]
    assert spans[1][2] == pytest.approx(-0.55), "the trailing run's own frames score it"


def test_moving_the_blank_changes_nothing_when_the_matrix_says_where_it_is(
    evidence: tuple[Emitted, Emitted, Unaware],
) -> None:
    """The whole of M9's fix, as one equality: the same evidence under another vocabulary must publish the
    same document. It exercises the kernel's `blank=`, the target filter, `_char_spans`' runs AND its
    flushing sentinel at once — each of those was a literal 0."""
    plain, aware, _unaware = evidence
    want = generate(TEXTS, plain, decoder=ctc_viterbi, syllabifier=lambda w, _l: [w])
    got = generate(TEXTS, aware, decoder=ctc_viterbi, syllabifier=lambda w, _l: [w])
    assert got.as_doc() == want.as_doc()


def test_the_old_chain_drops_the_letter_at_zero_and_mistimes_the_rest(
    evidence: tuple[Emitted, Emitted, Unaware],
) -> None:
    """NON-VACUITY, and the review's measured failure. Reading blank as 0 on such a vocabulary does two
    things at once: every `a` is filtered out of the targets as if it were the blank (so its word is timed
    from its other letters, or interpolated when it has none), and the kernel charges the TRUE blank's
    frames as a letter, which drags the path."""
    plain, _aware, unaware = evidence
    want = generate(TEXTS, plain, decoder=ctc_viterbi, syllabifier=lambda w, _l: [w])
    got = generate(TEXTS, unaware, decoder=ctc_viterbi, syllabifier=lambda w, _l: [w])
    assert got.as_doc() != want.as_doc(), "the permutation must be visible to an unaware reader"

    interpolated = [w.word for line in got.lines for w in line.words if w.provenance != "aligned"]
    assert "a" in interpolated, "`a` has no other letter to be timed from, so the word is interpolated"
    moved = [
        abs(g.start - w.start)
        for line_got, line_want in zip(got.lines, want.lines, strict=True)
        for g, w in zip(line_got.words, line_want.words, strict=True)
    ]
    assert max(moved) > FRAME_SEC, f"the mistiming is under a frame: {max(moved):.4f} s"


def test_a_repair_window_decodes_against_the_same_blank_the_global_pass_did(
    evidence: tuple[Emitted, Emitted, Unaware],
) -> None:
    """`regenerate` slices the matrix and decodes inside it, so its `_SlicedEmissions` has to CARRY the
    blank: the inner `generate` would otherwise fall back to 0 on exactly the models where 0 is a letter,
    and a repaired line would disagree with the document it is repairing."""
    plain, aware, _unaware = evidence
    runs = [((Line(text=TEXTS[1], start=2.6, end=4.6, words=(), score=0.0, index=1),), (2.4, 4.8))]
    want = regenerate(runs, plain, decoder=ctc_viterbi, syllabifier=lambda w, _l: [w])
    got = regenerate(runs, aware, decoder=ctc_viterbi, syllabifier=lambda w, _l: [w])
    assert set(want) == {1}, "the fixture's window must actually repair, or this proves nothing"
    assert [(w.word, w.start, w.end) for w in got[1].words] == [
        (w.word, w.start, w.end) for w in want[1].words
    ]


def test_the_alignable_count_is_the_matrixs_blank_and_one_literal_for_two_floors(
    evidence: tuple[Emitted, Emitted, Unaware],
) -> None:
    """`generate.alignable_chars`, the count under `regenerate`'s window floor AND `align_steps.needs`.

    TWO COPIES OF IT SURVIVED being reverted to a literal 0 under mutation (W4 review r1), which is why it is
    one function now. The count itself is invisible on a vocabulary whose blank IS 0 and invisible in a
    DOCUMENT even when it is wrong, because it only ever gates a floor and undercounting makes the floor
    LOOSER — so this asserts the number, and the case below asserts the floor it feeds.
    """
    plain, aware, unaware = evidence
    from encore_worker.domain.lyrics.generate import alignable_chars

    text = TEXTS[1]  # "and all the ash it carries": 21 letters, 4 of them the `a` the permutation moves
    assert alignable_chars(text, plain) == 21
    assert alignable_chars(text, aware) == 21, "the same text under another vocabulary is the same length"
    assert alignable_chars(text, unaware) == 17, "a reader that assumes 0 drops every `a`"


def test_a_repair_window_is_refused_by_the_floor_the_matrixs_blank_implies(
    evidence: tuple[Emitted, Emitted, Unaware],
) -> None:
    """THE CONSEQUENCE of the count above, and the case the M9 fix had no test for.

    `regenerate` refuses a window holding fewer than two emission frames per alignable character — anything
    tighter is a forced smear, not a fit. Here the window is 38 frames: over the unaware reader's floor for
    17 characters (34) and under the real one for 21 (42). So a blank-aware chain REFUSES the repair and a
    chain that assumes 0 runs it, forcing 21 characters through a window sized for 17 — the shape of a
    truncated caption cue, which is where `regenerate`'s floor and `align_steps.needs` both bite.
    """
    plain, aware, unaware = evidence
    line = Line(text=TEXTS[1], start=2.6, end=4.6, words=(), score=0.0, index=1)
    window = (2.6, 2.6 + 38 * FRAME_SEC)
    runs = [((line,), window)]
    kwargs: dict[str, Any] = {"decoder": ctc_viterbi, "syllabifier": lambda w, _l: [w]}
    assert set(regenerate(runs, plain, **kwargs)) == set(), "21 characters do not fit 38 frames"
    assert set(regenerate(runs, aware, **kwargs)) == set(), "and the permutation does not change that"
    assert set(regenerate(runs, unaware, **kwargs)) == {1}, "the unaware floor admits the smear"


def test_the_lexical_lift_is_measured_on_the_same_targets_the_decode_publishes(
    evidence: tuple[Emitted, Emitted, Unaware],
) -> None:
    """`lexical.letters_of` is `generate`'s target filter restated, and the module's promise is that the two
    agree. A 0 there would measure the lift of a text with every `a` removed while the decode published the
    text with them — and `lexical.BANDS` is calibrated in nats per LETTER, so the denominator moves too."""
    plain, aware, unaware = evidence
    want = lexical.lift(TEXTS, plain, decoder=ctc_viterbi)
    got = lexical.lift(TEXTS, aware, decoder=ctc_viterbi)
    assert want is not None and got is not None
    assert (got.value, got.letters, got.per_letter) == (want.value, want.letters, want.per_letter)

    blind = lexical.lift(TEXTS, unaware, decoder=ctc_viterbi)
    assert blind is not None and blind.letters < want.letters, "the unaware reader loses the `a`s"


def test_the_mix_witness_reads_the_blank_column_it_is_told_about(
    evidence: tuple[Emitted, Emitted, Unaware],
) -> None:
    """`align_steps._speech_mass` is `1 - p(blank)`: on a permuted vocabulary the literal 0 read the
    probability of a LETTER, so a sung span scored as silence and a silent one as speech — which inverts
    every never-sung spare and every claim adoption that number gates."""
    from encore_worker.steps.align_steps import _speech_mass

    plain, aware, unaware = evidence
    sung = _speech_mass(plain, 0.4, 2.2)
    quiet = _speech_mass(plain, 6.9, 7.4)
    assert sung is not None and quiet is not None and sung > 0.5 > quiet
    assert _speech_mass(aware, 0.4, 2.2) == sung and _speech_mass(aware, 6.9, 7.4) == quiet
    assert _speech_mass(unaware, 6.9, 7.4) != quiet, "the unaware reader reads the wrong column"
    assert _speech_mass(Emitted([[0.0]], 0.02, {}, blank_id=7), 0.0, 1.0) is None, "a column it lacks"


# ── the OTHER non-character columns: `Emissions.specials` (W4b, review M9's second half) ─────────────────


@dataclass(frozen=True)
class Specialled:
    """A matrix that names its non-character columns, as `ml.Emissions` does since W4 (`specials_of`)."""

    log_probs: Any
    frame_sec: float
    dictionary: dict[str, int]
    blank_id: int
    specials: dict[str, int]

    @property
    def frames(self) -> int:
        return int(np.asarray(self.log_probs).shape[0])


#: The shipped `en` vocabulary's shape: `{'-': 0, '|': 1, 'e': 2, ...}`, i.e. the WORD SEPARATOR is a
#: single-character entry a lyric can reach. Here it is appended rather than inserted, so the sung chars keep
#: the ids the other fixtures use and only the pipe is new.
PIPE = "|"


@pytest.fixture()
def pipes() -> tuple[Specialled, Emitted]:
    """The same matrix, once NAMING `|` as a special and once not — nothing else differs."""
    vocab = {**DIC, PIPE: max(DIC.values()) + 1}
    matrix = sung_matrix(SUNG, vocab, DURATION)
    return (
        Specialled(
            log_probs=matrix,
            frame_sec=FRAME_SEC,
            dictionary=vocab,
            blank_id=0,
            specials={"<pad>": 0, PIPE: vocab[PIPE]},
        ),
        Emitted(log_probs=matrix, frame_sec=FRAME_SEC, dictionary=vocab, blank_id=0),
    )


def test_the_excluded_set_is_the_blank_plus_whatever_the_matrix_names() -> None:
    """`generate.excluded_of` is THE target filter, and it defaults to exactly the blank — so every fake in
    this suite and every bench cache entry written before the field filters what it always did."""
    from encore_worker.domain.lyrics.generate import excluded_of

    assert excluded_of(Unaware(log_probs=[], frame_sec=0.02, dictionary={})) == frozenset({0})
    assert excluded_of(Emitted(log_probs=[], frame_sec=0.02, dictionary={}, blank_id=31)) == frozenset({31})
    named = Specialled([], 0.02, {}, blank_id=31, specials={"<pad>": 31, "|": 4, "<unk>": 9})
    assert excluded_of(named) == frozenset({31, 4, 9}), "the blank and every other special"


def test_a_pipe_in_a_lyric_is_not_a_target_when_the_matrix_names_it(
    pipes: tuple[Specialled, Emitted],
) -> None:
    """THE DEFECT `Emissions.specials` EXISTED UNREAD FOR (W4b). Every HF align vocabulary maps `|` to the
    word separator, so a sheet that writes `oh | oh` — a caption track using it as a delimiter, an operator
    paste out of a table — fed id 1 in as a CHARACTER target: the decode forced a separator into the middle of
    a line and `_char_spans` gave it frames of its own, pushing every following letter later.

    A matrix that NAMES its specials drops it from the targets, so every SUNG word of the line keeps the
    timing it has without the pipe and the pipe itself comes out as a zero-width placeholder — the same
    treatment `generate` gives any word with no alignable character (W5's text hygiene owns removing it from
    the text). One that names none still emits it as a target, which is the old behaviour and is what makes
    this test about the reader rather than about the fixture."""
    from encore_worker.domain.lyrics.generate import alignable_chars

    named, unnamed = pipes
    piped = [f"{TEXTS[0]} {PIPE}", *TEXTS[1:]]
    kwargs: dict[str, Any] = {"decoder": ctc_viterbi, "syllabifier": lambda w, _l: [w]}

    def sung(got: Any) -> list[tuple[str, float, float]]:
        """Every word the decode actually placed: a placeholder has a zero-width span."""
        return [(w.word, w.start, w.end) for line in got.lines for w in line.words if w.end > w.start]

    want = generate(TEXTS, named, **kwargs)
    got = generate(piped, named, **kwargs)
    assert sung(got) == sung(want), "the pipe changed no timing: it is not a letter of the language"
    assert [w.word for w in got.lines[0].words][-1] == PIPE, "it is still shown, as a placeholder"
    assert got.lines[0].words[-1].end == got.lines[0].words[-1].start
    assert alignable_chars(f"{TEXTS[0]} {PIPE}", named) == alignable_chars(TEXTS[0], named)

    blind = generate(piped, unnamed, **kwargs)
    assert sung(blind) != sung(want), (
        "a reader that names no specials still forces the separator through, as every pre-W4b one did"
    )
    assert alignable_chars(f"{TEXTS[0]} {PIPE}", unnamed) == alignable_chars(TEXTS[0], unnamed) + 1


def test_the_lift_and_a_repair_read_the_same_excluded_set_as_the_decode(
    pipes: tuple[Specialled, Emitted],
) -> None:
    """One filter, three readers (W4b): `lexical.letters_of` must count the pipe out or the lift would be a
    different text's score per letter, and `regenerate`'s slice must CARRY the specials or a repaired line
    would be forced through a longer target sequence than the line it is repairing."""
    from encore_worker.domain.lyrics.generate import excluded_of

    named, unnamed = pipes
    piped = [f"{TEXTS[0]} {PIPE}", *TEXTS[1:]]
    assert lexical.letters_of(piped, named.dictionary, excluded_of(named)) == lexical.letters_of(
        TEXTS, named.dictionary, excluded_of(named)
    ), "the same targets the decode builds, pipe and no pipe"
    assert (
        len(lexical.letters_of(piped, unnamed.dictionary, excluded_of(unnamed)))
        == len(lexical.letters_of(TEXTS, named.dictionary, excluded_of(named))) + 1
    ), "and a reader with no specials measures one target more than the decode publishes"
    want = lexical.lift(TEXTS, named, decoder=ctc_viterbi)
    got = lexical.lift(piped, named, decoder=ctc_viterbi)
    assert want is not None and got is not None
    # The VALUE moves, and only because `shuffles_of` is seeded by the text string: the piped text is a
    # different string, so it draws different shuffles. What the filter promises is the DENOMINATOR and the
    # targets, asserted above.
    assert got.letters == want.letters

    line = Line(text=f"{TEXTS[1]} {PIPE}", start=2.6, end=4.6, words=(), score=0.0, index=1)
    plain = Line(text=TEXTS[1], start=2.6, end=4.6, words=(), score=0.0, index=1)
    window = (2.4, 4.8)
    kwargs: dict[str, Any] = {"decoder": ctc_viterbi, "syllabifier": lambda w, _l: [w]}
    repaired = regenerate([((line,), window)], named, **kwargs)
    reference = regenerate([((plain,), window)], named, **kwargs)
    assert set(repaired) == set(reference) == {1}, "the fixture's window must really repair"
    assert [(w.word, w.start, w.end) for w in repaired[1].words if w.end > w.start] == [
        (w.word, w.start, w.end) for w in reference[1].words if w.end > w.start
    ], "the repaired line's sung words are the same: the slice carried the specials"
