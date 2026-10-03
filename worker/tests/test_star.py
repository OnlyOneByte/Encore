"""The STAR: one filler target before every line, over a matrix one column wider (the `star` arm).

A file of its own, like `test_blank_id.py` for M9, because the star is one token and five places that have to
agree: the COLUMN (`ml.starred`: frame max less P, named on `Emissions.specials`), the TARGET list (before
every line with a character), the RELABEL of its frames to blank before `_char_spans` AND `_lead_starts`, the
span-count invariant that relabel turns into `spans == targets - separators - stars`, and the step's wiring
(only the document decodes read the starred matrix). Three of the five fail LOUDLY; two fail SILENTLY — an
onset lead clamped at a star span is 30 ms nobody sees, and a gate decode handed a star column misreads one.

The arm ships OFF and its verdict is the corpus harness's (`gates/w7-star.yaml`; `ml.STAR_PENALTY_NATS`
carries P's sweep): what a suite can settle is that the mechanism it exists for is the one at work.
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

from encore_worker.adapters import ml
from encore_worker.domain.lyrics.generate import (
    ONSET_LEAD_SEC,
    Line,
    _char_spans,
    _lead_starts,
    alignable_chars,
    char_ids,
    char_targets,
    excluded_of,
    generate,
    regenerate,
    star_of,
)
from encore_worker.domain.lyrics.policy import Tier
from encore_worker.host.config import ALIGN_EXPERIMENTS, Config
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl, _star_why
from encore_worker.steps.records import AudioRef, JobRef, TextRef, TimedDoc, TimeRequest
from tests.ctc_fixture import FRAME_SEC, HIT, Matrix, ctc_viterbi, sung_matrix

DIC = {ch: i + 1 for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz'")}
#: The shipped `en` vocabulary's shape, `|` included, so the two arms can be shown independent.
VOCAB = {**DIC, "|": max(DIC.values()) + 1}
STAR = max(VOCAB.values()) + 1  # `ml.starred` appends, so the star id is the matrix's old width

#: Three sung lines, of which THE TEXT HOLDS ONLY THE LAST TWO: the first is the "intro", audio no line of the
#: text mentions, which is D3's shape. The last two carry 46 ALIGNABLE LETTERS, deliberately over
#: `lexical.MIN_LETTERS` (40), or the wrong-text gate reports "too short to measure" and no decode runs.
SUNG = (
    ("a candle in a paper cup", 0.4, 2.2),
    ("and all the ash it carries", 2.6, 4.6),
    ("away from all that we once were", 5.0, 6.8),
)
LINES = tuple(text for text, _s, _e in SUNG)
DURATION = 7.4

#: `generate`'s "do not syllabify" fixture, as the rest of the suite spells it.
ONE_SYLLABLE: Any = lambda word, _language: [word]  # noqa: E731

#: How much the UNCOVERED intro also sounds like the text's own first letters, log-probability — the whole of
#: D3's mechanism, the frames having to be labelled with SOMETHING. DERIVED FROM THE SHIPPED PENALTY: one nat
#: worse than the star and far better than the matrix's own `rest`, both asserted by the fixture.
TEMPTING = math.log(HIT) - ml.STAR_PENALTY_NATS - 1.0


def emissions(matrix: Matrix, *, vocab: dict[str, int] | None = None) -> ml.Emissions:
    """The SHIPPED `Emissions` over a fixture matrix — the real type, because `ml.starred` returns one.

    `model` IS EMPTY, as every other fixture in this suite leaves it: `lexical.calibration` reads that as the
    BASE bundle's row, which is what these synthetic matrices resemble, and a made-up name would make the
    lexical gate and the placement margin stand down — so a test of the arm's wiring would pass with half the
    wiring never reached (it did, while this file was being written).
    """
    return ml.Emissions(
        log_probs=matrix,
        frame_sec=FRAME_SEC,
        dictionary=dict(vocab or VOCAB),
        model="",
        blank_id=0,
        specials={"<pad>": 0, "|": (vocab or VOCAB).get("|", 0)},
    )


def tempting(text: Sequence[str]) -> Matrix:
    """`SUNG`, with the INTRO (line 1, which `text` does not hold) also sounding like `text`'s own letters.

    The failure D3 is about, in the smallest form that reproduces it. `sung_matrix` alone is too clean to
    show it: over the intro's frames the text's letters and the blank are both at the matrix's `rest`, so
    the Viterbi's tie-break leaves the path on the blank and nothing is dragged. A real model's emissions
    over unsung audio are not flat — the intro's phonemes partly match the letters the text does have — and
    that is what pulls the first line of the text backwards into them."""
    matrix = sung_matrix(SUNG, VOCAB, DURATION)
    rest = float(matrix[0].min())
    assert rest < TEMPTING < math.log(HIT) - ml.STAR_PENALTY_NATS, (
        f"the temptation must sit between this matrix's floor ({rest:.2f}) and the star "
        f"({math.log(HIT) - ml.STAR_PENALTY_NATS:.2f}), or the fixture proves nothing"
    )
    intro_text, intro_start, intro_end = SUNG[0]
    first, last = int(intro_start / FRAME_SEC), int(intro_end / FRAME_SEC)
    for letter in {ch for line in text for ch in line if ch in VOCAB}:
        column = matrix[first:last, VOCAB[letter]]
        matrix[first:last, VOCAB[letter]] = np.maximum(column, TEMPTING)
    assert intro_text not in text, "the intro is the line the text does NOT hold"
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

    def stars(self) -> list[int]:
        """Where the stars sit in the last target list, as positions among the targets."""
        return [i for i, token in enumerate(self.last) if token == STAR]


# ── the column (`ml.starred`) ──────────────────────────────────────────────────────────────────────────


def test_the_star_column_is_the_frame_maximum_less_the_penalty() -> None:
    """`frame max - P`, PER FRAME, and nothing else about the matrix changes.

    Per frame is the whole point: a log-probability only means something against the rest of its own frame,
    so a flat frame's star comes down with it while a confidently sung frame's star sits P nats under a
    character the path wants anyway. A CONSTANT star (MMS's `log p = 0`) was measured over-eager —
    all-corpus ±250 67.9 -> 64.0 — which is the comparison this arithmetic exists to avoid."""
    matrix = sung_matrix(SUNG, VOCAB, DURATION)
    plain = emissions(matrix)
    starred = ml.starred(plain, penalty=2.0)
    assert np.asarray(starred.log_probs).shape == (matrix.shape[0], matrix.shape[1] + 1)
    widened = np.asarray(starred.log_probs)
    assert np.array_equal(widened[:, : matrix.shape[1]], matrix), "the model's own columns are untouched"
    assert np.allclose(widened[:, STAR], matrix.max(axis=1) - 2.0)
    assert np.allclose(np.asarray(ml.starred(plain, penalty=4.0).log_probs)[:, STAR], widened[:, STAR] - 2.0)
    assert starred.frame_sec == plain.frame_sec and starred.dictionary == plain.dictionary
    assert starred.model == plain.model and starred.blank_id == plain.blank_id
    assert np.asarray(plain.log_probs).shape == matrix.shape, "and the original is not mutated"


def test_the_starred_matrix_names_the_column_and_keeps_every_other_name() -> None:
    """The id goes on `Emissions.specials` (review §3.10's own instruction), beside the names that were
    already there — so `excluded_of` picks it up for free and the two arms are independent."""
    starred = ml.starred(emissions(sung_matrix(SUNG, VOCAB, DURATION)))
    assert starred.specials == {"<pad>": 0, "|": VOCAB["|"], ml.STAR_NAME: STAR}
    assert star_of(starred) == STAR
    assert star_of(emissions(sung_matrix(SUNG, VOCAB, DURATION))) is None
    assert star_of(object()) is None, "a matrix that names no specials has no star to emit"
    assert STAR in excluded_of(starred), "a text can never target the star: it owns no character"


def test_the_domain_and_the_adapter_name_the_same_column() -> None:
    """`domain/` may not import the adapters (`test_layers`), so the name is written twice — as `|`'s is in
    `generate.separator_named` and `ml._SPECIAL_NAMES`. Two literals that must not drift, held here.

    AND WHY IT IS NOT `*`: `specials` is keyed by vocabulary ENTRY and `char_ids` looks up single CHARACTERS,
    so a bundle whose vocabulary held `*` would have the star's name collide with a character's — and that
    character would then be dropped from every word that contains it, which is review M9's defect wearing
    another hat. A multi-character name cannot collide, and the second half of this test is that proof.
    """
    from encore_worker.domain.lyrics import generate as module

    assert module._STAR_NAME == ml.STAR_NAME
    assert len(ml.STAR_NAME) > 1, "a one-character name could be a lyric's own character"

    starry = {**VOCAB, "*": max(VOCAB.values()) + 1}
    matrix = np.zeros((4, max(starry.values()) + 1), dtype=np.float32)
    starred = ml.starred(emissions(matrix, vocab=starry))
    assert char_ids("*", starred.dictionary, excluded_of(starred)) == [(0, starry["*"])], (
        "a vocabulary's own `*` is still a character the decode may align"
    )


def test_the_widened_matrix_carries_the_blank_of_the_vocabulary_it_came_from() -> None:
    """`starred` is the one code path that REBUILDS an `Emissions`, so it is the one that can lose a field.

    `blank_id` is the field the decodes it feeds read off the WIDENED matrix, never off the original
    (`generate.blank_of(decode_matrix)`, `_placement_margins`' `blank=`). Mutating the copy to `blank_id=0`
    passed the WHOLE SUITE: every star fixture here is a `blank_id=0` vocabulary and the non-zero-blank ones
    never reach the arm. So both halves are asserted on the shape 23 of whisperx's 36 HF bundles have —
    `test_blank_id.permuted` — and M9's equality is re-asserted THROUGH the arm: the same evidence under
    another vocabulary must publish the same document, stars and all."""
    from tests.test_blank_id import permuted

    matrix = sung_matrix(SUNG, VOCAB, DURATION)
    moved, swapped = permuted(matrix, VOCAB, "a")
    blank = ml.blank_id_of(swapped)
    assert blank == VOCAB["a"] != 0, "the fixture must really move the blank off column 0"
    aware = ml.Emissions(
        log_probs=moved,
        frame_sec=FRAME_SEC,
        dictionary=swapped,
        model="",
        blank_id=blank,
        specials={"<pad>": blank, "|": swapped["|"]},
    )
    widened = ml.starred(aware)
    assert widened.blank_id == blank, "the widened matrix keeps the blank its own vocabulary names"
    assert widened.specials == {"<pad>": blank, "|": swapped["|"], ml.STAR_NAME: STAR}

    want = generate(
        LINES, ml.starred(emissions(matrix)), decoder=ctc_viterbi, syllabifier=ONE_SYLLABLE, stars=True
    )
    got = generate(LINES, widened, decoder=ctc_viterbi, syllabifier=ONE_SYLLABLE, stars=True)
    assert got.as_doc() == want.as_doc()


def test_an_empty_matrix_leaves_the_arm_inert_rather_than_fatal() -> None:
    """There is no maximum to take over no frames. `starred` returns the matrix unchanged, `star_of` names
    nothing, and the decode is the default's — the same shape of refusal `separator_of` makes on a vocabulary
    whose `|` is its blank, and the trail note says so (`_star_why`)."""
    empty = emissions(np.zeros((0, max(VOCAB.values()) + 1), dtype=np.float32))
    assert ml.starred(empty) is empty
    assert star_of(ml.starred(empty)) is None
    assert "carries no star column" in _star_why(star_of(ml.starred(empty)))
    assert f"id {STAR}" in _star_why(STAR) and "frame max" in _star_why(STAR)


def test_the_torch_and_numpy_paths_build_the_same_column() -> None:
    """The shipped matrix is a torch tensor (the kernel needs one, and `max` must not leave the job's device);
    this suite's fixtures are numpy. Two code paths in `starred`, held equal here, so a test that exercises
    the numpy one says something about production."""
    torch = pytest.importorskip("torch")
    matrix = sung_matrix(SUNG, VOCAB, DURATION)
    as_numpy = np.asarray(ml.starred(emissions(matrix), penalty=2.0).log_probs)
    tensor = ml.starred(emissions(torch.from_numpy(np.ascontiguousarray(matrix))), penalty=2.0)
    assert isinstance(tensor.log_probs, torch.Tensor), "a torch matrix must stay a torch matrix"
    assert np.allclose(tensor.log_probs.numpy(), as_numpy)


# ── where the stars go in the targets ──────────────────────────────────────────────────────────────────


def test_the_arm_off_is_the_target_list_it_always_was() -> None:
    """The default path is not merely equivalent: it is the same call. No star is emitted even over a matrix
    that CARRIES the column, nothing is relabelled, and the span check is the count it was before."""
    starred = ml.starred(emissions(sung_matrix(SUNG, VOCAB, DURATION)))
    tap = Recording()
    got = generate(LINES, starred, decoder=tap.decoder(), syllabifier=ONE_SYLLABLE)
    assert STAR not in tap.last
    assert len(tap.last) == sum(alignable_chars(text, starred) for text in LINES)
    plain = generate(
        LINES, emissions(sung_matrix(SUNG, VOCAB, DURATION)), decoder=ctc_viterbi, syllabifier=ONE_SYLLABLE
    )
    assert got.as_doc() == plain.as_doc(), "an unused column cannot move a timing"


def test_one_star_before_every_line_including_the_first() -> None:
    """Review §3.10: a star BEFORE EVERY LINE. Before the first one too — that is the star an intro the text
    does not mention is spent on — and never inside a line, which is where D1's own mechanism says a token the
    model does not emit between words would cost the letters their frames."""
    starred = ml.starred(emissions(sung_matrix(SUNG, VOCAB, DURATION)))
    tap = Recording()
    generate(LINES, starred, decoder=tap.decoder(), syllabifier=ONE_SYLLABLE, stars=True)
    chars = [alignable_chars(text, starred) for text in LINES]
    assert tap.stars() == [0, 1 + chars[0], 2 + chars[0] + chars[1]]
    assert len(tap.last) == sum(chars) + len(LINES)
    flat = char_targets(LINES, starred, stars=True)
    assert flat.stars == len(LINES) and flat.separators == 0
    assert len(flat.owners) == sum(chars), "a star owns no character"
    assert [flat.targets[position] for position in flat.first_char_target.values()] != [STAR] * len(LINES)
    assert flat.first_char_target == {0: 1, 1: 2 + chars[0], 2: 3 + chars[0] + chars[1]}


def test_a_line_with_no_alignable_character_gets_no_star_of_its_own() -> None:
    """A decorative row (`♪`, an emoji line) and a line the never-sung rule blanked to `""` contribute no
    character, so they get no star: a second absorbing token in the same gap is a token the path can hide in
    twice, and the review asks for one per LINE that is decoded."""
    starred = ml.starred(emissions(sung_matrix(SUNG, VOCAB, DURATION)))
    for filler in ("", "♪", "   "):
        tap = Recording()
        generate(
            [LINES[0], filler, LINES[1]],
            starred,
            decoder=tap.decoder(),
            syllabifier=ONE_SYLLABLE,
            stars=True,
        )
        assert len(tap.stars()) == 2, f"{filler!r} bought a star of its own"
        assert tap.stars() == [0, 1 + alignable_chars(LINES[0], starred)]


def test_the_two_arms_compose_one_boundary_and_one_star() -> None:
    """`linesep` and `star` are independent targets at the same place, and the counts stay apart: the
    separator is owed by the PREVIOUS line's boundary, the star by THIS line's opening, so a gap under both
    arms carries exactly one of each, in that order."""
    starred = ml.starred(emissions(sung_matrix(SUNG, VOCAB, DURATION)))
    tap = Recording()
    generate(LINES, starred, decoder=tap.decoder(), syllabifier=ONE_SYLLABLE, separate_lines=True, stars=True)
    flat = char_targets(LINES, starred, separate_lines=True, stars=True)
    assert (flat.stars, flat.separators) == (3, 2)
    chars = [alignable_chars(text, starred) for text in LINES]
    assert tap.last[chars[0] + 1 : chars[0] + 3] == [VOCAB["|"], STAR]
    assert len(tap.last) == sum(chars) + 3 + 2


# ── the frames: relabelled to blank before the spans AND before the lead ───────────────────────────────


def test_the_stars_frames_play_the_blanks_part_in_the_grouping() -> None:
    """`_char_spans` merges maximal runs of one non-blank label, and CTC's topology puts a blank between two
    occurrences of the SAME label. A star relabelled to blank is therefore exactly the separator the grouping
    already understands — so a line ending in `e` followed by one starting with `e` still yields two spans."""
    blank, letter = 0, 5
    labels = [letter, STAR, letter]
    scores = [-0.1, -0.2, -0.3]
    assert len(_char_spans(labels, scores, FRAME_SEC, blank)) == 3, "unrelabelled: the star is a span"
    relabelled = [blank if label == STAR else label for label in labels]
    spans = _char_spans(relabelled, scores, FRAME_SEC, blank)
    assert [(round(start, 4), round(end, 4)) for start, end, _s in spans] == [(0.0, 0.02), (0.04, 0.06)]


def test_the_onset_lead_is_not_clamped_at_a_star_span() -> None:
    """THE HALF REVIEW §3.10 ASKS FOR BY NAME: relabel before `_lead_starts`, not only before `_char_spans`.

    `_lead_starts` pulls every char's start back by `ONSET_LEAD_SEC` and clamps it at the PREVIOUS SPAN's end,
    which is what keeps chars from overlapping. A star left in the label stream owns a span, so the clamp
    becomes the star's end and the first character of every line loses its lead — the review names that clamp
    as the likely cause of one song's ±250 drop, and it is 30 ms, so nothing but this would show it.
    """
    blank, first, second = 0, 5, 6
    labels = [first, STAR, STAR, second]
    scores = [-0.1, -0.2, -0.3, -0.4]
    lead = _lead_starts(_char_spans(labels, scores, FRAME_SEC, blank), ONSET_LEAD_SEC)
    assert round(lead[-1][0], 4) == 0.06, "the star's span clamped the lead away"
    voided = [blank if label == STAR else label for label in labels]
    shipped = _lead_starts(_char_spans(voided, scores, FRAME_SEC, blank), ONSET_LEAD_SEC)
    assert round(shipped[-1][0], 4) == round(0.06 - ONSET_LEAD_SEC, 4)
    assert len(shipped) == 2 and round(shipped[0][0], 4) == 0.0


def test_the_span_check_counts_the_stars_and_says_so() -> None:
    """The invariant is spans == targets − separators − stars. A decoder that emits one span too many is still
    caught, and the message names the stars or the next reader of it will think the arm is the bug."""

    def extra(log_probs: object, targets: Sequence[int], blank: int = 0) -> tuple[list[int], list[float]]:
        labels, scores = ctc_viterbi(log_probs, targets, blank)
        return [*labels[:-2], 7, blank], scores  # a letter run planted in the trailing silence

    starred = ml.starred(emissions(sung_matrix(SUNG, VOCAB, DURATION)))
    with pytest.raises(ValueError, match=r"line separators and 3 stars\)"):
        generate(LINES, starred, decoder=extra, syllabifier=ONE_SYLLABLE, stars=True)
    with pytest.raises(ValueError, match=r"of them line separators\); "):
        generate(LINES, starred, decoder=extra, syllabifier=ONE_SYLLABLE)


# ── what it does to a timing: review D3's drag, in the smallest form that shows it ──────────────────────


def test_a_star_absorbs_audio_the_text_does_not_mention() -> None:
    """The mechanism the arm exists for: a forced CTC path must label EVERY frame.

    When the audio sings something the text does not hold — an intro, an instrumental break, the verse a
    partial sheet dropped — the path spends those frames on whichever of the text's own characters are least
    implausible there, and the first lines are dragged into them. Measured at corpus scale: with half the
    lines deleted 107/387 and 165/356 line starts more than 2 s off, a 6-line unsung verse 142 gross lines,
    `feel-my-heart`'s first word bound about 28 s early. Here the audio sings three lines and the text holds
    the LAST TWO, so line 1's 1.8 s are uncovered and a star keeps the text on its own onset."""
    text = LINES[1:]
    matrix = tempting(text)
    plain = generate(text, emissions(matrix), decoder=ctc_viterbi, syllabifier=ONE_SYLLABLE)
    starred = generate(
        text,
        ml.starred(emissions(matrix)),
        decoder=ctc_viterbi,
        syllabifier=ONE_SYLLABLE,
        stars=True,
    )
    truth = {text: start for text, start, _end in SUNG}
    dragged = [round(line.start - truth[line.text], 2) for line in plain.lines]
    held = [round(line.start - truth[line.text], 2) for line in starred.lines]
    assert dragged[0] < -1.0, f"the fixture must reproduce the drag, got {dragged}"
    assert all(abs(error) <= ONSET_LEAD_SEC + 1e-9 for error in held), f"the star did not hold it: {held}"
    assert [line.text for line in starred.lines] == list(text)
    assert all(word.end > word.start for line in starred.lines for word in line.words), (
        "no word lost its span to a star"
    )
    starts = [word.start for line in starred.lines for word in line.words]
    assert starts == sorted(starts), "the stars kept the path monotone"


def test_a_repair_window_is_not_starred_and_decodes_as_it_always_did() -> None:
    """REPAIRS STAY STAR-FREE (`generate`'s docstring owns the reasoning: §3.10's defect is the GLOBAL path's,
    and a repair window is already bounded on both sides by evidence that says which text belongs in it).

    The mechanical half, which is why it is safe: `regenerate` carries the sliced matrix's `specials` — the
    star's name included — into the window, and asks for no star, so the extra column is simply never a
    target.
    A window decode over the starred matrix is therefore byte-identical to one over the plain one.
    """
    matrix = sung_matrix(SUNG, VOCAB, DURATION)
    run = tuple(
        Line(text=text, start=start, end=end, words=(), score=0.0, index=i)
        for i, (text, start, end) in enumerate(SUNG)
    )
    window = (0.3, DURATION)
    kwargs: dict[str, Any] = {"decoder": ctc_viterbi, "syllabifier": ONE_SYLLABLE}
    plain = regenerate([(run, window)], emissions(matrix), **kwargs)
    starred = regenerate([(run, window)], ml.starred(emissions(matrix)), **kwargs)
    assert set(plain) == set(starred) == {0, 1, 2}
    assert [(line.text, round(line.start, 6)) for line in plain.values()] == [
        (line.text, round(line.start, 6)) for line in starred.values()
    ]


# ── the arm reaches the shipped step, and only where it should ─────────────────────────────────────────


class StarAligner:
    """An `Aligner` over the fixture matrix (`tempting`), which the step then widens under the arm."""

    def __init__(self, matrix: Matrix) -> None:
        self._matrix = matrix
        self.asked: list[str] = []

    def emissions(self, path: str, _language: str) -> ml.Emissions:
        self.asked.append(path)
        return emissions(self._matrix)

    def align(self, *_a: object) -> tuple[dict[str, object], ...]:
        raise AssertionError("the windowed engine must not run: the global decode has emissions")


@dataclass
class Widths:
    """Every (vocab width, star among the targets) the step's decoder was handed, in call order.

    ONE SPY FOR THE WHOLE WIRING. The gate decodes (`lexical.lift`), the global decode and every repair window
    all go through `ml.forced_align_decoder`, so the widths alone say which matrix each of them read — and
    the star arm's contract is exactly a statement about that: the document decodes see the extra column, the
    thresholds calibrated on star-free targets do not.
    """

    seen: list[tuple[int, bool]] = field(default_factory=list)

    def decoder(self) -> Any:
        def decode(
            log_probs: object, targets: Sequence[int], blank: int = 0
        ) -> tuple[list[int], list[float]]:
            self.seen.append((int(np.asarray(log_probs).shape[1]), STAR in set(targets)))
            return ctc_viterbi(log_probs, targets, blank)

        return decode


def step_run(
    media: Path, monkeypatch: pytest.MonkeyPatch, *, experiments: frozenset[str], text: Sequence[str]
) -> tuple[Any, str, list[dict[str, Any]], Widths]:
    """One real `time_text` over the star fixture: its result, its verdict note, its lines and the widths."""
    from tests.test_align_provenance import TrailSpy, sung_wav

    media.mkdir(parents=True, exist_ok=True)
    spy = Widths()
    monkeypatch.setattr(ml, "forced_align_decoder", spy.decoder())
    wav = sung_wav(media / "vocals.wav", list(SUNG), DURATION, seed=0)
    mix = sung_wav(media / "mix.wav", list(SUNG), DURATION, seed=1)
    trail = TrailSpy()
    impl = AlignStepsImpl(
        config=Config(align_experiments=experiments),
        adapters=Adapters(aligner=StarAligner(tempting(text))),
        reporter=trail,
    )
    request = TimeRequest(
        job=JobRef(job_id="j1", media_id="m1", media_dir=str(media), source_uri=None),
        text=TextRef(
            tier=Tier.CANDIDATE,
            label="test",
            segments=tuple({"text": line} for line in text),
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
    return got, str(notes[-1][4]), lines, spy


def test_the_step_decodes_with_the_star_only_under_the_arm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The wiring, through the real `_time_text_global`, on the same uncovered-intro fixture as the unit test
    above: the published onsets move by exactly what the star holds back, and the verdict note carries the arm
    (with its penalty) so an audit page can tell an arm's run from the default's."""
    text = LINES[1:]
    default, plain_note, plain_lines, _off = step_run(
        tmp_path / "off", monkeypatch, experiments=frozenset(), text=text
    )
    assert isinstance(default, TimedDoc), default
    assert "star:" not in plain_note, "the default's note says nothing about a star"

    armed, armed_note, armed_lines, _on = step_run(
        tmp_path / "on", monkeypatch, experiments=frozenset({"star"}), text=text
    )
    assert isinstance(armed, TimedDoc), armed
    assert f"star: one per line, id {STAR} = frame max − {ml.STAR_PENALTY_NATS:g} nats" in armed_note
    assert [line["text"] for line in armed_lines] == [line["text"] for line in plain_lines]
    # The text's first line is sung at 2.6 s and the DEFAULT publishes it at 0.37 — dragged 2.2 s back into
    # the intro, which is the gross line review D3 counts. The arm publishes it at its own onset less the
    # measured lead (2.6 − `ONSET_LEAD_SEC`), and the line the drag never reached does not move by a frame.
    assert [round(float(line["start"]), 2) for line in plain_lines] == [0.37, 4.97]
    assert [round(float(line["start"]), 2) for line in armed_lines] == [2.57, 4.99], (
        "the arm reached the shipped decode, or this test proves nothing"
    )


def test_only_the_decodes_that_publish_a_timing_see_the_star_column(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The contract `host.config.ALIGN_EXPERIMENTS` states for this arm, on the real step: the document
    decodes read the starred matrix and everything else reads the matrix it was calibrated on.

    The lexical gate's four decodes (`lexical.lift`) and the mix witness's reads are thresholds fitted per
    bundle on star-free target sequences, so a star column under them would be measuring a recalibration —
    `linesep`'s docstring makes the same point for the separator. A repair window is left alone for a
    different reason, which `generate`'s docstring owns."""
    plain = max(VOCAB.values()) + 1
    _armed, _note, _lines, spy = step_run(
        tmp_path / "on", monkeypatch, experiments=frozenset({"star"}), text=LINES[1:]
    )
    starred = [(width, had_star) for width, had_star in spy.seen if width == plain + 1]
    assert starred, "no decode saw the star column at all"
    assert all(had_star for _width, had_star in starred), "a widened matrix decoded with no star target"
    assert all(not had_star for width, had_star in spy.seen if width == plain)
    assert len(starred) == 1, f"exactly the one global decode this fixture has: {spy.seen}"
    assert len([1 for width, _s in spy.seen if width == plain]) >= 2, "the gate decodes must have run"


@dataclass
class Decodes:
    """What the step asked the two domain entry points for: `stars` per GLOBAL decode, `stars` per window
    decode inside a repair, and whether each repair stage's matrix carried a star column at all.

    `align_steps` imports `generate`/`regenerate` inside `_time_text_global`, so the patch goes on the
    domain module and every call re-reads it. The inner calls are counted separately because `regenerate`
    decodes each run through `generate` itself and resolves that name in the same module, so a spy on
    `generate` alone cannot tell a global decode from a window's — it did not, and six window decodes read
    as six global ones."""

    whole: list[bool] = field(default_factory=list)
    inner: list[bool] = field(default_factory=list)
    windows: list[bool] = field(default_factory=list)

    def tap(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from encore_worker.domain.lyrics import generate as module

        real_generate, real_regenerate = module.generate, module.regenerate
        repairing = False

        def generate_spy(*args: Any, stars: bool = False, **kwargs: Any) -> Any:
            (self.inner if repairing else self.whole).append(stars)
            return real_generate(*args, stars=stars, **kwargs)

        def regenerate_spy(runs: Any, matrix: Any, **kwargs: Any) -> Any:
            nonlocal repairing
            self.windows.append(star_of(matrix) is not None)
            repairing = True
            try:
                return real_regenerate(runs, matrix, **kwargs)
            finally:
                repairing = False

        monkeypatch.setattr(module, "generate", generate_spy)
        monkeypatch.setattr(module, "regenerate", regenerate_spy)


def test_the_re_decode_after_a_never_sung_drop_keeps_the_arm_and_no_repair_window_does(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The two decode sites a three-line fixture cannot reach, on the ladder's own fixtures (the shape W4b
    review r2 found `linesep` had left uncovered at both): the re-decode after a never-sung drop PUBLISHES, so
    it owns the arm, while every repair window is handed the UNSTARRED matrix on purpose."""
    from encore_worker.steps import align_steps
    from tests.ctc_fixture import misheard
    from tests.test_align_provenance import (
        FAINT,
        SCATTERED,
        TRUNCATED,
        TRUNCATED_DURATION,
        UNIQUE,
        UNIQUE_DURATION,
        align,
        truth,
        weakly_sung,
    )

    monkeypatch.setattr(align_steps, "_NEVER_SUNG_RATE", 1000.0)
    credit = "thanks for watching everyone"

    def dropping(media: Path, experiments: frozenset[str]) -> Decodes:
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

    armed = dropping(tmp_path / "drop-on", frozenset({"star"}))
    assert all(armed.whole), f"the re-decode dropped the arm: {armed.whole}"
    assert not any(dropping(tmp_path / "drop-off", frozenset()).whole), "and the default asks for none of it"

    # THE SUBSTITUTED MATRIX IS WIDENED TOO, and it has to be: `misheard` hands the GLOBAL pass a different
    # matrix (that is the only way to make a repair matter under an exact Viterbi), and under the arm the
    # global targets hold a star id that a matrix of the original width has no column for. Widening it for
    # BOTH runs keeps the comparison honest — an unused column cannot move a timing, which is what
    # `test_the_arm_off_is_the_target_list_it_always_was` pins.
    scattered = np.asarray(
        ml.starred(emissions(sung_matrix(SCATTERED, DIC, TRUNCATED_DURATION), vocab=DIC)).log_probs
    )

    def repairing(media: Path, experiments: frozenset[str]) -> Decodes:
        media.mkdir(parents=True, exist_ok=True)
        spy = Decodes()
        spy.tap(monkeypatch)
        got = align(
            media,
            monkeypatch,
            phrases=TRUNCATED,
            duration=TRUNCATED_DURATION,
            claims=[*truth(TRUNCATED)[:5], (40.0, None)],
            decoder=misheard(scattered, int(TRUNCATED_DURATION / FRAME_SEC)),
            experiments=experiments,
        )
        assert "timing sources: 6 window" in got.verdict[4], "the fixture must really repair"
        return spy

    windows = repairing(tmp_path / "repair-on", frozenset({"star"}))
    assert windows.windows and not any(windows.windows), (
        f"a repair window was handed a starred matrix: {windows.windows}"
    )
    assert windows.inner and not any(windows.inner), f"a window decode asked for stars: {windows.inner}"
    assert windows.whole and all(windows.whole), "while the global decodes kept the arm"


def test_the_placement_margin_reads_the_trellis_the_decode_ran_on(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A margin measured on a decode that did not run is not evidence about the one that did (review §3.7's
    whole premise is "could this line have gone somewhere else", and under the arm the path that answers it
    has a star to park on). So `_placement_margins` is handed the STARRED matrix and the same targets —
    `char_targets` is the one flatten both readers share, which is what keeps them from drifting."""
    from encore_worker.domain.lyrics import margin as module

    seen: list[tuple[int, bool]] = []
    real = module.placement_margins

    def spy(log_probs: Any, targets: Sequence[int], *args: Any, **kwargs: Any) -> Any:
        seen.append((int(np.asarray(log_probs).shape[1]), STAR in set(targets)))
        return real(log_probs, targets, *args, **kwargs)

    monkeypatch.setattr(module, "placement_margins", spy)
    _armed, _note, _lines, _spy = step_run(
        tmp_path / "on", monkeypatch, experiments=frozenset({"star"}), text=LINES[1:]
    )
    assert seen == [(max(VOCAB.values()) + 2, True)], f"the margin read another decode's trellis: {seen}"


def test_the_arm_is_a_declared_experiment() -> None:
    """It ships OFF behind the ONE knob, and an unknown name is refused (`test_ownership`), so the name has to
    be declared for `ENCORE_ALIGN_EXPERIMENTS=star` to be settable at all."""
    assert "star" in ALIGN_EXPERIMENTS
    assert Config.from_env({"ENCORE_ALIGN_EXPERIMENTS": "star"}).align_experiments == frozenset({"star"})
    assert Config.from_env({}).align_experiments == frozenset()
