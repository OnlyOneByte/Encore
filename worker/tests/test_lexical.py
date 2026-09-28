"""The lexical lift (`domain.lyrics.lexical`): does THIS order of these words explain the emissions better
than shuffles of them? On the CTC fixture's sung matrices, decoded by its exact Viterbi.

The fixture scores LETTERS (a sung char at 0.9, everything else flat), so its lifts are far larger than a
real model's (truth +15 nats/letter here, +0.47 to +4.3 on the bench's stems); what these tests pin is the
contrast and its contract, not the threshold, which `scripts/lift_gate.py` measures on real matrices.
"""

from __future__ import annotations

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

    def spy(log_probs: Any, targets: Sequence[int]) -> tuple[list[int], list[float]]:
        seen.append(list(targets))
        return ctc_viterbi(log_probs, targets)

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


def test_an_empty_matrix_is_unmeasured() -> None:
    empty = FakeEmissions(log_probs=sung_matrix([], DIC, 0.0), frame_sec=FRAME_SEC, dictionary=DIC)
    assert lexical.lift(SUNG, empty, decoder=ctc_viterbi) is None


def test_what_the_decoder_raises_propagates() -> None:
    """Pure: it cannot tell a kernel that refused these targets from one that is gone. The step can."""

    def refusing(log_probs: Any, targets: Sequence[int]) -> tuple[list[int], list[float]]:
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
    assert lexical.band(value, on_stem=on_stem) is want


def test_the_shipped_bands_keep_the_calibrated_populations_apart() -> None:
    """The base model's calibration (`lift_gate.py`, the module docstring): no wrong text reached the refuse
    threshold on either target (stem +0.189, mix +0.132), every protected right text on a stem sits above
    the doubt band (+0.359), and each band is non-empty and ordered."""
    bands = lexical.BANDS
    assert bands.model == "WAV2VEC2_ASR_BASE_960H"
    assert 0.189 < bands.refuse_below < bands.ok_from <= 0.359
    assert 0.132 < bands.mix_floor < bands.mix_ok_from
    assert bands.mix_floor < bands.refuse_below, "a mix is heard less well, and its floor is lower"


def test_the_bands_are_read_at_call_time(monkeypatch: pytest.MonkeyPatch) -> None:
    """Not bound as a default argument: whatever replaces `BANDS` (a recalibration, a test) is what every
    later call reads, and an explicit `bands` wins over it."""
    assert lexical.band(5.5, on_stem=True) is lexical.Band.OK
    moved = lexical.Bands(model="x", refuse_below=5.0, ok_from=6.0, mix_floor=1.0, mix_ok_from=2.0)
    monkeypatch.setattr(lexical, "BANDS", moved)
    assert lexical.band(5.5, on_stem=True) is lexical.Band.DOUBT
    assert lexical.band(1.5, on_stem=False) is lexical.Band.DOUBT
    assert lexical.band(5.5, on_stem=True, bands=lexical.Bands("y", 0.0, 0.0, 0.0, 0.0)) is lexical.Band.OK


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
