"""A document coherently 0.5-2 s from its sheet, and what the global engine can see of it.

TWO DOCUMENTS LOOK IDENTICAL FROM THE CLAIMS ALONE and the engine must grade them apart: `bad-guy`'s, whose
SHEET is 0.86 s early and whose timings are right, and the mirror case, whose DECODE is 0.86 s late on a sheet
the audio confirms. `reconcile.off_sheet` separates them with the activity envelope and demotes only the
second. docs/arch/04-alignment.md §6.1; docs/benchmarks/forced-alignment/README.md, "The 0.5-2 s band".
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from encore_worker.domain.lyrics import reconcile as rc
from encore_worker.domain.lyrics.generate import ONSET_LEAD_SEC
from tests.test_align_provenance import SPARSE, align, truth

#: Seconds the sheet precedes the singing: `bad-guy`'s measured caption lead, +1.007 s against its own
#: stem's vocal onsets, rounded to the band's middle (README, "The 0.5-2 s band").
EARLY_BY = 0.86

#: Seconds the DECODE is late in the mirror case. The same magnitude as `EARLY_BY`, so the two documents are
#: the same distance from their sheets and only the envelope tells them apart.
LATE_BY = 0.86

DURATION = 48.0


@dataclass(frozen=True, slots=True)
class _Start:
    """What `reconcile.as_claimed` reads off a line: its input index and its start."""

    index: int
    start: float


def _reading(*, offset_sec: float, spread_sec: float, together: float, near: float = 0.0) -> rc.AsClaimed:
    """An `AsClaimed` for the rule's own tests. Every field is spelled: none of them defaults, a constructor
    that forgot one having been able to hand `off_sheet` a perfectly coherent reading (review r2-spec-14)."""
    return rc.AsClaimed(
        near=near,
        pairs=12,
        tolerance_sec=rc.AGREE_TOLERANCE_SEC,
        offset_sec=offset_sec,
        spread_sec=spread_sec,
        together=together,
    )


def _early_sheet(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **kwargs: Any) -> Any:
    return align(
        tmp_path,
        monkeypatch,
        phrases=SPARSE,
        duration=DURATION,
        claims=truth(SPARSE, -EARLY_BY),
        **kwargs,
    )


def test_a_sheet_a_second_early_publishes_every_line_high_that_far_from_its_claim(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE SHEET MOVED, and the grade must not punish the document for it. We publish where the song is SUNG,
    so the document stays `high` even though every line sits `EARLY_BY` from the claim a viewer's sheet
    carries: the envelope reads those same claims as displaced, which is the second witness refusing to
    convict us. What W8a changed is that the trail now NAMES the distance."""
    got = _early_sheet(tmp_path, monkeypatch)
    for line, (text, start, _end) in zip(got.lines, SPARSE, strict=True):
        assert line["text"] == text
        assert abs(line["start"] - start) < 0.15, f"{text!r} publishes where it is sung"
        assert line["confidence"] == "high", f"{text!r}: corroborated once the offset is fitted out"
        assert line["start"] - (start - EARLY_BY) > 0.5, f"{text!r} is in the band against its own claim"
    assert got.timed.confidence == "high"
    why = got.verdict[4]
    assert "claims mapped onto our clock by" in why and "6 of 6 paired lines explained" in why
    assert why.endswith("6/6 lines high")
    # The distance, on the trail, in the room's own terms: 0% of the lines are within the corroboration band
    # of their own claim, and the median lag is the sheet's lead. Not a demotion — the envelope sided with us.
    assert "against the sheet as served: 0% of 6 lines within 0.25 s of their own claim" in why
    assert "no coherent displacement both witnesses confirm" in why
    assert "OFF ITS SHEET" not in why


def test_the_distance_the_grade_could_not_see_is_the_one_as_claimed_reads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`reconcile.as_claimed` removes no offset, so it reads the error a room would see — and W8a is where the
    global engine started calling it. Before, only the LINE_SYNC rung did (`_agreement_of`), which is why a
    document 0.86 s off its sheet could publish `high` with no number anywhere naming 0.86."""
    calls: list[int] = []
    original = rc.as_claimed

    def spy(*args: Any, **kwargs: Any) -> rc.AsClaimed | None:
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(rc, "as_claimed", spy)
    got = _early_sheet(tmp_path, monkeypatch)
    assert calls, "the global engine takes an un-fitted reading of its own agreement"

    served = {index: start - EARLY_BY for index, (_t, start, _e) in enumerate(SPARSE)}
    published = [_Start(index=index, start=line["start"]) for index, line in enumerate(got.lines)]
    tight = rc.as_claimed(published, served, tolerance_sec=rc.AGREE_TOLERANCE_SEC)
    assert tight is not None
    assert tight.near == 0.0, "not one published line is within the corroboration band of its claim"
    assert tight.offset_sec == pytest.approx(EARLY_BY - ONSET_LEAD_SEC, abs=0.05)
    assert tight.spread_sec < rc.AGREE_TOLERANCE_SEC, "and they moved TOGETHER: one lag, not scatter"

    loose = rc.as_claimed(published, served)
    assert loose is not None and loose.near == 1.0, "and every one of them is inside a phrase of it"


def test_off_sheet_needs_both_witnesses_and_the_envelope_is_the_one_that_decides() -> None:
    """The rule, on the reading alone. A coherent lag is necessary and never sufficient: what convicts the
    document is the envelope finding the singing where the SHEET says, so the sheet is not what moved."""
    coherent = _reading(offset_sec=0.9, spread_sec=0.08, together=1.0)
    assert rc.off_sheet(coherent, envelope_lag_sec=0.02) is not None, "both witnesses: demoted"
    assert rc.off_sheet(coherent, envelope_lag_sec=0.9) is None, "the sheet is displaced too: not ours"
    assert rc.off_sheet(coherent, envelope_lag_sec=None) is None, "the fit was too weak to read: abstain"
    assert rc.off_sheet(None, envelope_lag_sec=0.02) is None, "too few pairs to read: abstain"

    scattered = _reading(offset_sec=0.9, spread_sec=0.9, together=0.4)
    assert rc.off_sheet(scattered, envelope_lag_sec=0.02) is None, "a lopsided spread is not one displacement"
    near = _reading(offset_sec=0.2, spread_sec=0.05, together=1.0, near=1.0)
    assert rc.off_sheet(near, envelope_lag_sec=0.0) is None, "inside the corroboration band: no finding"
    # SIGN-SYMMETRIC in both witnesses, so a sheet that is LATE cannot read as a sheet that is early.
    early = _reading(offset_sec=-0.9, spread_sec=0.08, together=1.0)
    assert rc.off_sheet(early, envelope_lag_sec=0.02) is not None
    assert rc.off_sheet(early, envelope_lag_sec=-0.9) is None


def test_half_a_document_shifted_and_half_exactly_on_its_claim_is_not_one_displacement() -> None:
    """Review r2-correctness-2: the MAD is robust, so it reads 0.00 on a SPLIT population and the coherence
    conjunct passed on documents whose lines are nearly half correct — a demotion that grades every line `low`
    and turns off the room's word wipe. `MIN_COHERENT_SHARE` is the share conjunct the rule was missing.

    The numbers are the finding's own: 11 lines 0.9 s late, 9 EXACTLY on their claim. The floor's provenance
    (the corpus's own coherent readings bottom out at 0.714) is in README, "W8a: the share a coherent lag has
    to carry".
    """
    claims = {index: 10.0 * index for index in range(20)}
    split = [_Start(index=i, start=claims[i] + (0.9 if i < 11 else 0.0)) for i in range(20)]
    reading = rc.as_claimed(split, claims, tolerance_sec=rc.AGREE_TOLERANCE_SEC)
    assert reading is not None
    assert reading.offset_sec == pytest.approx(0.9) and reading.spread_sec == pytest.approx(0.0), (
        "the median and its MAD see one perfectly coherent 0.9 s shift"
    )
    assert reading.together == pytest.approx(11 / 20), "while only 11 of the 20 lines carry that lag"
    assert reading.together < rc.MIN_COHERENT_SHARE
    assert rc.off_sheet(reading, envelope_lag_sec=0.0) is None, "so the document is not convicted"

    whole = [_Start(index=i, start=claims[i] + 0.9) for i in range(20)]
    moved = rc.as_claimed(whole, claims, tolerance_sec=rc.AGREE_TOLERANCE_SEC)
    assert moved is not None and moved.together == 1.0
    off = rc.off_sheet(moved, envelope_lag_sec=0.0)
    assert off is not None, "the true positive the rule exists for still convicts"
    assert "100% of 20 paired lines within 0.25 s of it" in off.why()


def test_a_lag_that_is_the_claim_clocks_own_map_is_not_a_second_witness() -> None:
    """Review r2-spec-7: `as_claimed` reads the PUBLISHED document against the sheet AS SERVED, so when the
    claim clock has already mapped that sheet by the same amount, the first witness is restating a decision
    this pipeline made rather than witnessing anything — the conjunction is then a ONE-witness rule, the
    envelope's. The conviction stands (the envelope is the witness that decides) and the record says which.
    """
    reading = _reading(offset_sec=0.9, spread_sec=0.08, together=1.0)
    mapped = rc.off_sheet(reading, envelope_lag_sec=0.0, clock_lag_sec=0.9)
    assert mapped is not None and mapped.claims_independent is False
    assert "this lag IS the claim clock's own map" in mapped.why()

    own = rc.off_sheet(reading, envelope_lag_sec=0.0, clock_lag_sec=0.0)
    assert own is not None and own.claims_independent is True
    assert "both witnesses place this document away from where it published" in own.why()


def test_a_decode_coherently_late_on_a_sheet_the_audio_confirms_publishes_low(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE DECODE MOVED. Same distance as the canary and the opposite verdict: the stem SINGS where the sheet
    says, and only the emission matrix is late, so both witnesses place the document away from where it
    published. This is the grade `bad-guy` would have had if its captions had been right.

    DEMOTING ON IT IS BEHIND `band-off-sheet` AND OFF BY DEFAULT, so both readings are here; the default must
    still SAY SO on the trail. Why it ships off: README, "W8a: what the corpus said about the two band
    components"."""
    from tests.ctc_fixture import sung_matrix  # noqa: PLC0415
    from tests.test_align_provenance import DIC  # noqa: PLC0415

    late = [(text, start + LATE_BY, end + LATE_BY) for text, start, end in SPARSE]

    def published(**kwargs: Any) -> Any:
        return align(
            tmp_path,
            monkeypatch,
            phrases=SPARSE,
            duration=DURATION,
            claims=truth(SPARSE),
            stem_matrix=sung_matrix(late, DIC, DURATION),
            **kwargs,
        )

    got = published(experiments=frozenset({"band-off-sheet"}))
    starts = [line["start"] for line in got.lines]
    moved = [start - truth_start for start, (_t, truth_start, _e) in zip(starts, SPARSE, strict=True)]
    assert all(m > rc.AGREE_TOLERANCE_SEC for m in moved), f"every line published late: {moved}"
    assert all(line["confidence"] == "low" for line in got.lines), "the coherence check demotes every line"
    assert got.timed.confidence == "low", "and the document, on the TIMINGS' axis"
    why = got.verdict[4]
    assert "OFF ITS SHEET" in why and "every line graded low" in why
    # ON THIS FIXTURE THE CLAIMS ARE NOT A SECOND WITNESS, and the record says so: the sheet is right, so the
    # claim clock maps it onto our LATE decode and the published document then sits exactly the map's own
    # +0.83 s from the sheet as served. The envelope is what convicts (review r2-spec-7).
    assert "this lag IS the claim clock's own map" in why
    assert "claims mapped onto our clock by" in why

    default = published()
    assert [line["start"] for line in default.lines] == starts, "the arm is a GRADE, so no timing moves"
    assert default.timed.confidence != "low", "the default does not demote on this reading"
    said = default.verdict[4]
    assert "OFF ITS SHEET" in said, "but it still reports the conviction, which is the half that always ran"
    assert "not demoted (band-off-sheet is off)" in said
