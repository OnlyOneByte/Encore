"""The lexical lift (`domain.lyrics.lexical`): does THIS order of these words explain the emissions better
than shuffles of them? On the CTC fixture's sung matrices, decoded by its exact Viterbi.

The fixture scores LETTERS (a sung char at 0.9, everything else flat), so its lifts are far larger than a
real model's (truth +15 nats/letter here, +0.47 to +4.3 on the bench's stems); what these tests pin is the
contrast and its contract, not the threshold, which `scripts/lift_gate.py` measures on real matrices.
"""

from __future__ import annotations

import inspect
from collections.abc import Sequence
from typing import Any

import pytest

from encore_worker.domain.lyrics import lexical
from encore_worker.domain.lyrics.generate import generate
from tests.ctc_fixture import ctc_viterbi, sung_matrix
from tests.test_align_provenance import DIC, UNIQUE, UNIQUE_DURATION, FakeEmissions

FRAME_SEC = 0.02
SUNG = [text for text, _s, _e in UNIQUE]


def heard(phrases: Sequence[tuple[str, float, float]] = UNIQUE) -> FakeEmissions:
    return FakeEmissions(
        log_probs=sung_matrix(phrases, DIC, UNIQUE_DURATION), frame_sec=FRAME_SEC, dictionary=DIC
    )


def test_the_sung_words_in_their_sung_order_lift_far_above_their_shuffles() -> None:
    got = lexical.lift(SUNG, heard(), decoder=ctc_viterbi)
    assert got is not None and got.value > 5.0
    assert got.letters == len(lexical.letters_of(SUNG, DIC))
    assert "lexical lift +" in got.why()


def test_words_that_are_not_sung_explain_the_audio_no_better_in_any_order() -> None:
    """Another text on the same clock (a translation of a caption track): its order is as arbitrary as any
    shuffle's, so the lift sits near zero whatever the letters' count."""
    other = [
        "viens et envole toi",
        "avec moi ce soir",
        "sur l'eau d'argent",
        "ramene moi chez moi",
        "les etoiles sont sorties",
        "lumiere du matin sur le fleuve",
        "tiens bon la nuit",
        "ne la lache jamais",
    ]
    got = lexical.lift(other, heard(), decoder=ctc_viterbi)
    assert got is not None and got.value < 0.2


def test_the_letters_are_the_targets_generate_decodes() -> None:
    """The same rule as `generate`'s target list, so a lift is measured on the decode that publishes."""
    seen: list[list[int]] = []

    def spy(log_probs: Any, targets: Sequence[int], blank: int = 0) -> tuple[list[int], list[float]]:
        seen.append(list(targets))
        return ctc_viterbi(log_probs, targets, blank)

    texts = ["Don't STOP me-now", "the 2nd time, OK?", "naïve café"]
    generate(texts, heard(), decoder=spy, language="en")
    assert seen == [lexical.letters_of(texts, DIC)]


def test_the_shuffles_are_deterministic_and_keep_the_texts_letters_and_lines() -> None:
    """Seeded by the text itself (a replay and a re-run measure the same thing), and each copy holds exactly
    the text's words on lines of the text's own word counts."""
    first, again = lexical.shuffles_of(SUNG), lexical.shuffles_of(SUNG)
    assert first == again and len(first) == lexical.SHUFFLES
    for copy in first:
        assert [len(line.split()) for line in copy] == [len(line.split()) for line in SUNG]
        assert sorted(" ".join(copy).split()) == sorted(" ".join(SUNG).split())
    assert any(copy != SUNG for copy in first)
    assert lexical.shuffles_of([*SUNG, "one more"]) != first, "another text, another draw"


@pytest.mark.parametrize(
    "texts",
    [
        ["come and fly", "away"],  # under MIN_LETTERS
        ["la la la la la la la la la la", "la la la la la la la la la la la la"],  # no order to contrast
    ],
    ids=["short", "one-word"],
)
def test_a_text_it_cannot_contrast_is_unmeasured(texts: list[str]) -> None:
    assert lexical.lift(texts, heard(), decoder=ctc_viterbi) is None


def test_a_shuffle_that_reads_as_the_text_itself_is_no_contrast() -> None:
    """W3 review r2. The contrast is a different TARGET SEQUENCE, not a different line string: `letters_of`
    lowercases and drops what the dictionary has no id for, so a text whose word permutations reproduce its
    own letters — a chant, a `la la` outro, a hook-only caption track — had shuffles whose forced path WAS
    the text's. `best == own` made the lift exactly 0.0, which `band` reads as REFUSE, so the gate convicted
    a right text as a wrong one (terminally on a stem, and at the LINE_SYNC rung too). Filtered on the
    targets, there is no contrast left to draw and the lift says so: None, and the envelope gate keeps it."""
    chant = ["na na na na na", "na na nana na", "na na na na na", "na na na na na"]
    assert len(lexical.letters_of(chant, DIC)) >= lexical.MIN_LETTERS, "past the minimum, so it is measured"
    assert {tuple(lines) for lines in lexical.shuffles_of(chant)} != {tuple(chant)}, (
        "its LINES do differ: the old filter kept every draw"
    )
    assert lexical.lift(chant, heard(), decoder=ctc_viterbi) is None


def test_the_note_prints_the_lift_at_the_precision_the_bands_are_set_on() -> None:
    """W3 review r2: at two decimals a text at +0.195 read `+0.20 ... below the lexical gate (0.2)` — the
    refusal note contradicting itself at the boundary it is read at most (`align_steps`)."""
    assert lexical.Lift(value=0.1954, letters=200, per_letter=-4.0).why().startswith("lexical lift +0.195 ")


def test_an_empty_matrix_is_unmeasured() -> None:
    empty = FakeEmissions(log_probs=sung_matrix([], DIC, 0.0), frame_sec=FRAME_SEC, dictionary=DIC)
    assert lexical.lift(SUNG, empty, decoder=ctc_viterbi) is None


def test_what_the_decoder_raises_propagates() -> None:
    """Pure: it cannot tell a kernel that refused these targets from one that is gone. The step can."""

    def refusing(log_probs: Any, targets: Sequence[int], blank: int = 0) -> tuple[list[int], list[float]]:
        raise ValueError("targets length is too long for CTC")

    with pytest.raises(ValueError, match="too long"):
        lexical.lift(SUNG, heard(), decoder=refusing)


def test_the_shuffles_do_not_depend_on_the_processs_hash_seed() -> None:
    """DBOS replay and a bench re-run must draw the SAME shuffles in another process: the seed is crc32 of
    the text, never the salted `hash()` (how e2e2's jit row became unrepeatable). Drawn in two fresh
    interpreters with different `PYTHONHASHSEED`s, and here."""
    import json
    import os
    import subprocess
    import sys

    script = (
        "import json, sys; from encore_worker.domain.lyrics import lexical; "
        "print(json.dumps(lexical.shuffles_of(json.loads(sys.argv[1]))))"
    )
    drawn = [
        json.loads(
            subprocess.run(
                [sys.executable, "-c", script, json.dumps(SUNG)],
                env={**os.environ, "PYTHONHASHSEED": seed},
                capture_output=True,
                text=True,
                check=True,
            ).stdout
        )
        for seed in ("1", "2")
    ]
    assert drawn[0] == drawn[1] == lexical.shuffles_of(SUNG)


@pytest.mark.parametrize(
    ("value", "on_stem", "want"),
    [
        (-0.5, True, lexical.Band.REFUSE),
        (lexical.BANDS.refuse_below - 1e-9, True, lexical.Band.REFUSE),
        (lexical.BANDS.refuse_below, True, lexical.Band.DOUBT),
        (lexical.BANDS.ok_from - 1e-9, True, lexical.Band.DOUBT),
        (lexical.BANDS.ok_from, True, lexical.Band.OK),
        (lexical.BANDS.mix_floor - 1e-9, False, lexical.Band.REFUSE),
        (lexical.BANDS.mix_floor, False, lexical.Band.DOUBT),
        (lexical.BANDS.mix_ok_from - 1e-9, False, lexical.Band.DOUBT),
        (lexical.BANDS.mix_ok_from, False, lexical.Band.OK),
    ],
)
def test_the_bands_are_half_open_and_read_per_target(value: float, on_stem: bool, want: lexical.Band) -> None:
    assert lexical.band(value, on_stem=on_stem, bands=lexical.BANDS) is want


def test_the_shipped_bands_keep_the_calibrated_populations_apart() -> None:
    """The base model's calibration (`lift_gate.py`, the module docstring): no wrong text reached the refuse
    threshold on either target (stem +0.189, mix +0.132), every protected right text on a stem sits above
    the doubt band (+0.359), and each band is non-empty and ordered."""
    bands = lexical.BANDS
    assert bands.model == "WAV2VEC2_ASR_BASE_960H"
    assert 0.189 < bands.refuse_below < bands.ok_from <= 0.359
    assert 0.132 < bands.mix_floor < bands.mix_ok_from
    assert bands.mix_floor < bands.refuse_below, "a mix is heard less well, and its floor is lower"


def test_every_calibration_row_is_keyed_by_its_own_model_and_ordered() -> None:
    """W4b: `CALIBRATED` is the ONE table, so a row filed under the wrong key would gate one model on
    another's numbers — the exact defect the table exists to prevent — and a paste error is the realistic way
    that happens. Every row is also held to the shape a calibration must have: ordered, non-empty bands and a
    share in (0, 1]."""
    assert lexical.CALIBRATED, "a worker with no calibrated model gates nothing"
    for key, row in lexical.CALIBRATED.items():
        assert row.model == key, f"{key} is filed under another model's name"
        assert 0.0 < row.refuse_below < row.ok_from
        assert 0.0 < row.mix_floor < row.mix_ok_from
        assert 0.0 < row.line_sync_min_agreement <= 1.0
    assert lexical.BANDS is lexical.CALIBRATED[lexical.BANDS.model], "BANDS is the table's row, not a copy"


def test_every_bundle_a_box_can_default_to_is_calibrated() -> None:
    """THE INVARIANT THAT LETS `adapters.ml` NOT IMPORT THIS MODULE (W4b 6b). The English bundle is a
    per-device default there (`ALIGN_MODELS_BY_DEVICE`), and a default with no row would put a worker in the
    one state the table forbids: gates that stand down on every job, with nobody having typed a model name to
    be refused for. `ml` cannot check it itself — importing `lexical` would drag every threshold into the
    emission cache's code fingerprint, so moving a band would invalidate every cached matrix — so the check is
    here, and a wave that adds a device default must add its row in the same breath.
    """
    from encore_worker.adapters import ml

    for device in ("cuda", "mps", "cpu", "an-accelerator-nobody-has-yet"):
        named = ml.default_align_model(device)
        assert lexical.is_calibrated(named), f"{device} would default to the uncalibrated {named}"


def test_a_matrix_is_calibrated_by_its_own_model_or_by_nothing() -> None:
    """The lookup, which is what "refuse to gate" rests on: the model's own row, `BANDS` for a matrix that
    names no model at all (every fake here, every bench cache entry written before `Emissions.model`), and
    None — never a substitute — for a model the table does not have."""

    class Matrix:
        def __init__(self, model: str | None) -> None:
            if model is not None:
                self.model = model

    assert lexical.calibration(Matrix(None)) is lexical.BANDS
    assert lexical.calibration(Matrix("")) is lexical.BANDS, "empty means unnamed, as `Emissions` defaults it"
    assert lexical.calibration(Matrix(lexical.BANDS.model)) is lexical.BANDS
    assert lexical.calibration(Matrix("WAV2VEC2_LARGE_XLSR_53_DE")) is None
    assert lexical.is_calibrated(lexical.BANDS.model)
    assert not lexical.is_calibrated("WAV2VEC2_LARGE_XLSR_53_DE")
    said = lexical.uncalibrated("WAV2VEC2_LARGE_XLSR_53_DE")
    assert "WAV2VEC2_LARGE_XLSR_53_DE" in said and lexical.BANDS.model in said
    assert "lift_gate.py --model WAV2VEC2_LARGE_XLSR_53_DE" in said, "the reason names the way to fix it"


def test_a_second_row_gates_its_own_model_and_leaves_the_first_alone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """What the table is FOR (W4b): two models gated at once, each on its own emission scale. W4b 6b adds
    HuBERT rows this way, and `is_calibrated` is what an operator knob naming a model must check."""
    other = lexical.Bands(
        model="HUBERT_ASR_LARGE",
        refuse_below=0.55,
        ok_from=0.8,
        mix_floor=0.4,
        mix_ok_from=0.9,
        line_sync_min_agreement=0.6,
    )
    monkeypatch.setitem(lexical.CALIBRATED, other.model, other)

    class Matrix:
        model = "HUBERT_ASR_LARGE"

    got = lexical.calibration(Matrix())
    assert got is other and lexical.is_calibrated("HUBERT_ASR_LARGE")
    assert lexical.band(0.5, on_stem=True, bands=got) is lexical.Band.REFUSE
    assert lexical.band(0.5, on_stem=True, bands=lexical.BANDS) is lexical.Band.OK, "the first row is untouched"
    # THE SHARE COMES OFF THE ROW TOO, and this is the only row in any test whose share is NOT 0.5 (W4b review
    # r2): all three shipped rows fit 0.5 and `LINE_SYNC_SHARE_UNCALIBRATED` is 0.5, so without a row that
    # differs, `line_sync_share` reading the constant instead of the field is indistinguishable from reading
    # the field — a mutation that ignores `bands` entirely passed the whole suite.
    assert lexical.line_sync_share(other) == 0.6, "this model's own share, not the uncalibrated constant"
    assert lexical.line_sync_share(lexical.BANDS) == lexical.BANDS.line_sync_min_agreement
    assert lexical.line_sync_share(None) == lexical.LINE_SYNC_SHARE_UNCALIBRATED


def test_the_row_is_the_callers_and_there_is_no_module_global_fallback() -> None:
    """`band` TAKES the row it judges by — there is no `bands=None -> BANDS` default (W4b review r2).

    The fallback shipped until r2 read what it costs: with it, one `band(value, on_stem=True)` in a new reader
    judges a HuBERT matrix's lift against the base model's floor (0.20 against 0.45) and publishes a wrong text
    silently — the review's high-severity W3 finding, re-entered through a default argument. Required, the
    omission is a type error at the call site, which is why this test reads the SIGNATURE and not a value: no
    runtime behaviour can distinguish "no fallback" from "a fallback nobody reached".
    """
    parameter = inspect.signature(lexical.band).parameters["bands"]
    assert parameter.default is inspect.Parameter.empty, "a default row is a cross-model threshold borrow"
    assert parameter.annotation == "Bands", "and `Bands | None` would put the decision back in here"
    moved = lexical.Bands("x", 5.0, 6.0, 1.0, 2.0, 0.5)
    assert lexical.band(5.5, on_stem=True, bands=moved) is lexical.Band.DOUBT
    assert lexical.band(1.5, on_stem=False, bands=moved) is lexical.Band.DOUBT
    assert lexical.band(5.5, on_stem=True, bands=lexical.Bands("y", 0.0, 0.0, 0.0, 0.0, 0.5)) is lexical.Band.OK


#: `UNIQUE` in German, on its own lines — "komm und flieg weg" for "come and fly away": a translation into a
#: language whose words share many of the sung words' letters IN ORDER (ü, not in the fixture's alphabet, is
#: written u, as the dictionary would drop it).
COGNATE_GERMAN = [
    "komm und flieg weg",
    "mit mir heute nacht",
    "uber das silberne wasser",
    "trag mich nach hause",
    "die sterne sind draussen",
    "morgenlicht uber den fluss",
    "halt fest an der nacht",
    "lass es niemals los",
]
#: The same lines in French, whose letters follow the sung ones far less.
FRENCH = [
    "viens et envole toi",
    "avec moi ce soir",
    "sur l'eau d'argent",
    "ramene moi chez moi",
    "les etoiles sont sorties",
    "lumiere du matin sur le fleuve",
    "tiens bon la nuit",
    "ne la lache jamais",
]


def test_a_cognate_heavy_translation_can_lift_where_another_language_does_not() -> None:
    """A KNOWN LIMIT, pinned hermetically because the bench cannot measure it (W3): no corpus song carries its
    lyrics in a second language (`e2e_lib.OPS`), so no translated-sheet mode exists. The lift contrasts the
    text's word ORDER with shuffles of it; a translation whose words keep the sung letters in order explains
    the audio better in its own order than shuffled, and lifts — here +1.98 nats/letter, above every band
    — where French reads -0.12 and the sung words +15.2. The fixture scores letters, so its scale is not
    the model's (the bench's right texts read +0.26..+4.3): this pins that the ORDER signal leaks through
    shared letters, not how far a real translation would lift. The LINE_SYNC rung's timing check does not
    cover it either (a same-video translation's lines sit where the song's are sung)."""
    sung = lexical.lift(SUNG, heard(), decoder=ctc_viterbi)
    german = lexical.lift(COGNATE_GERMAN, heard(), decoder=ctc_viterbi)
    french = lexical.lift(FRENCH, heard(), decoder=ctc_viterbi)
    assert sung is not None and german is not None and french is not None
    assert german.value == pytest.approx(1.98, abs=0.01) and german.value > lexical.BANDS.ok_from
    assert french.value == pytest.approx(-0.12, abs=0.01) and french.value < lexical.BANDS.refuse_below
    assert german.value < sung.value / 5, "far below the sung words' own lift: the signal is partial"
