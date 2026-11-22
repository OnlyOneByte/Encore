"""The research arms where they reach the shipped step: the vendored decoder, and what it unblocks.

`test_viterbi.py` holds the GRAPH (the arcs, their price, the superset property) and `test_ml_contract.py`
holds the bit-compatibility claim against the real kernel. What is left, and what this file is, is the
WIRING: which decode each arm reaches, what the trail says it did, and that the claim-fed arms cannot
promote a line the blind decode never corroborated.

Every arm ships OFF; the verdicts are the corpus harness's (docs/benchmarks/forced-alignment/LOG.md,
"W9: a vendored decoder, and the three arms it unblocks").
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from encore_worker.adapters.ml import STAR_PENALTY_NATS
from encore_worker.domain.lyrics import viterbi
from encore_worker.domain.lyrics.generate import char_targets, line_blocks
from encore_worker.host.config import ALIGN_EXPERIMENTS, Config
from encore_worker.steps import align_steps, align_unsung
from tests.ctc_fixture import FRAME_SEC, Matrix, alignable, sung_matrix
from tests.test_align_provenance import (
    DIC,
    DURATION,
    PHRASES,
    UNIQUE,
    UNIQUE_DURATION,
    FakeEmissions,
    Outcome,
    Phrase,
    align,
    truth,
)

#: A line no recording of this song contains: what roadmap item 15's arc exists to leave unsung, and long
#: enough that bypassing it can pay its own price (34 alignable characters = 30 + 6 × 34 = 234 nats).
CREDIT = "thanks for watching everyone subscribe"


def packed(phrases: Sequence[Phrase], duration: float, hit: float = 0.99) -> Matrix:
    """`sung_matrix`'s song with every sung character on exactly ONE frame, the rest confident blank.

    `sung_matrix` spreads each character over ~4 frames, which leaves a monotone path room to smear an
    unsung line across its neighbours' spare frames for almost nothing — so on it no skip arc at the
    shipped price can ever pay, and a step-level test of the arcs would be testing the fixture. Packed,
    an extra character has to be bought from the silence at `log hit − log rest`, which is what a real
    matrix charges (docs/benchmarks/forced-alignment/LOG.md, the W9 section).
    """
    vocab = max(DIC.values()) + 1
    rest = math.log((1.0 - hit) / (vocab - 1))
    matrix = np.full((int(duration / FRAME_SEC), vocab), rest, dtype=np.float32)
    matrix[:, 0] = math.log(hit)
    for text, start, _end in phrases:
        for position, token in enumerate(alignable(text, DIC)):
            frame = int(start / FRAME_SEC) + 2 * position  # one frame sung, one blank, so doubles fit
            matrix[frame, :] = rest
            matrix[frame, token] = math.log(hit)
    return matrix


def attempt(media: Path, monkeypatch: pytest.MonkeyPatch, **shape: Any) -> Outcome:
    """`test_align_provenance.align` in a directory of its own, so two arms can be run side by side."""
    media.mkdir(parents=True, exist_ok=True)
    return align(media, monkeypatch, **shape)


#: What R3 says when it climbed its rung, which on this fixture is exactly one line.
R3_REPAIR = "re-decoded 1 repeated lines between unique anchors"


def misheard_repeat() -> dict[str, Any]:
    """`align` shape: `PHRASES` with ONE chorus occurrence misheard 3.6 s early.

    The sheet's own claims then dispute exactly that repeat, which is what gives R3 a rung to climb — and
    `UNIQUE`, the other fixture these arms are read on, has no repeated line to give it one.
    """
    chorus = [index for index, (text, _s, _e) in enumerate(PHRASES) if text == PHRASES[0][0]]
    moved = [(t, 18.4, 20.4) if i == chorus[1] else (t, s, e) for i, (t, s, e) in enumerate(PHRASES)]
    return {
        "phrases": PHRASES,
        "duration": DURATION,
        "claims": truth(PHRASES),
        "stem_matrix": sung_matrix(moved, DIC, DURATION),
    }


def clause(got: Outcome, name: str) -> str:
    """The one `; `-separated clause of the verdict note that starts with `name`, or ""."""
    note = str(got.verdict[4])
    return next((part.strip() for part in note.split(";") if part.strip().startswith(name)), "")


# ── the control: an empty graph is the kernel's own document ──────────────────────────────────────


def test_the_vendored_control_republishes_the_kernels_own_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """XA-18 at the STEP, which is the claim the other three arms rest on: swap the decoder with an empty
    graph and not one published byte may move.

    The unit tests compare the two decoders on matrices; this compares the two DOCUMENTS, so a difference
    anywhere between the matrix and the file — the spans, the leads, the ends, the grades — would show.
    """
    shape: dict[str, Any] = {
        "phrases": UNIQUE,
        "duration": UNIQUE_DURATION,
        "claims": truth(UNIQUE),
    }
    plain = attempt(tmp_path / "off", monkeypatch, **shape)
    vendored = attempt(tmp_path / "on", monkeypatch, experiments=frozenset({"vendored"}), **shape)

    assert vendored.lines == plain.lines, "the vendored control moved a published line"
    assert clause(plain, "vendored decoder") == "", "the default must not claim a vendored decode"
    assert clause(vendored, "vendored decoder") == (
        "vendored decoder: an empty graph, so this is torchaudio's own path (vendored)"
    )
    # The control is only a control if it really ran: the clause above is printed off `vendored_arm`, so
    # the one thing it cannot prove on its own is that the graph decoded anything.
    assert len(vendored.lines) == len(UNIQUE)


# ── roadmap item 15: the arcs, as the never-sung rule's complement ───────────────────────────────


def test_the_arc_leaves_unsung_a_line_the_recording_never_contained(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The arm end to end at the SHIPPED price: the credit line is bypassed, named in the trail, and absent
    from the document, while the default has to place it and smears it over the last sung line."""
    shape: dict[str, Any] = {
        "phrases": UNIQUE,
        "duration": UNIQUE_DURATION,
        "claims": [*truth(UNIQUE), None],
        "extra_text": [CREDIT],
        "stem_matrix": packed(UNIQUE, UNIQUE_DURATION),
    }
    default = attempt(tmp_path / "off", monkeypatch, **shape)
    assert CREDIT in [line["text"] for line in default.lines], "the default must publish the credit line"

    armed = attempt(tmp_path / "on", monkeypatch, experiments=frozenset({"skip-arcs"}), **shape)
    assert f"skip arcs left unsung: [{len(UNIQUE)}] {CREDIT!r}" in str(armed.verdict[4])
    assert CREDIT not in [line["text"] for line in armed.lines]
    assert [line["text"] for line in armed.lines] == [text for text, _s, _e in UNIQUE]


def test_the_arcs_take_nothing_from_a_sheet_the_recording_sings(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The false-drop direction, which is the one the corpus measured the replacement arm failing: on THIS
    matrix, where every line is in the audio and in the order the audio sings it, the arcs cost no line.

    NOT A GENERAL PROPERTY — the corpus priced the arm at 5 false drops in `truth`, and the test below is
    the fixture that pays it (LOG.md, "W9: the research track, priced on the corpus").
    """
    armed = attempt(
        tmp_path / "on",
        monkeypatch,
        phrases=UNIQUE,
        duration=UNIQUE_DURATION,
        claims=truth(UNIQUE),
        stem_matrix=packed(UNIQUE, UNIQUE_DURATION),
        experiments=frozenset({"skip-arcs"}),
    )
    assert "skip arcs left unsung" not in str(armed.verdict[4])
    assert [line["text"] for line in armed.lines] == [text for text, _s, _e in UNIQUE]
    # THE DETECTOR STILL HAS TO SAY IT LOOKED: a run that found nothing is otherwise silent about a graph
    # that is not the publishing decode's.
    assert clause(armed, "vendored decoder") == (
        f"vendored decoder: a detector graph offered a skip arc at "
        f"{viterbi.SKIP_LINE_NATS:g} + {viterbi.SKIP_CHAR_NATS:g} nats/char, "
        f"0 repeat(s) exempt: 0 line(s) bypassed"
    ), clause(armed, "vendored decoder")


def test_the_arcs_do_cost_a_sung_line_when_the_sheet_misorders_it() -> None:
    """The false-drop direction PRICED, so the arm's measured cost is asserted rather than contradicted.

    `_runs/w9-graph/arms28.json` (28 songs, shipped 30 + 6/char) reads `true_dropped` 5 at `truth` — lines
    the audio does contain and the arcs bypass anyway — which is one of the two readings that refused the
    arm (LOG.md, "W9: the research track, priced on the corpus"). A monotone path cannot place two lines the
    sheet orders against the recording, and bypassing the dearer one is cheaper than smearing it.
    """
    texts = [text for text, _s, _e in UNIQUE]
    matrix = FakeEmissions(log_probs=packed(UNIQUE, UNIQUE_DURATION), frame_sec=FRAME_SEC, dictionary=DIC)
    assert align_unsung._skipped_lines(matrix, texts) == frozenset(), "in order, nothing may be dropped"

    misordered = [*texts[:5], texts[6], texts[5], *texts[7:]]
    unsung = align_unsung._skipped_lines(matrix, misordered)
    assert unsung == frozenset({5}), f"the misordered sheet must cost a sung line: {unsung}"
    assert misordered[5] in texts, "and the line it cost is one the recording sings"


def test_a_repeated_line_is_exempt_from_the_arcs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The exemption is the step's to compute and `line_skips`' to honour, so this is a test of the SET the
    step hands over: an arc cannot tell which occurrence of a chorus is which, so bypassing one is as
    likely to drop the sung occurrence as the unsung one.
    """
    seen: list[frozenset[int]] = []
    real = align_unsung._skipped_lines

    def spy(*args: Any, exempt: frozenset[int] = frozenset(), **kwargs: Any) -> Any:
        seen.append(exempt)
        return real(*args, exempt=exempt, **kwargs)

    monkeypatch.setattr(align_steps, "_skipped_lines", spy)
    attempt(
        tmp_path / "on",
        monkeypatch,
        phrases=PHRASES,
        duration=40.0,
        claims=truth(PHRASES),
        experiments=frozenset({"skip-arcs"}),
    )
    chorus = {i for i, (text, _s, _e) in enumerate(PHRASES) if text == "come and fly away"}
    assert len(chorus) == 3, "the fixture must really repeat a line"
    assert seen == [chorus], f"every repeat and nothing else is exempt: {seen}"


def test_a_line_printed_exactly_twice_is_already_a_repeat(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The exemption's BOUNDARY, which the three-occurrence fixture above leaves open: `said.count(text) > 1`
    weakened to `> 2` passed every test in this file, and a line printed twice is
    the commonest repeat a sheet has.

    Both halves are here — the step exempts the PAIR, and the exemption is what keeps the second occurrence
    on a matrix that charges for a character — so the rule cannot be weakened in either direction.
    """
    seen: list[frozenset[int]] = []
    real = align_unsung._skipped_lines

    def spy(*args: Any, exempt: frozenset[int] = frozenset(), **kwargs: Any) -> Any:
        seen.append(exempt)
        return real(*args, exempt=exempt, **kwargs)

    repeated, unsung = UNIQUE[5][0], CREDIT
    shape: dict[str, Any] = {
        "phrases": UNIQUE,
        "duration": UNIQUE_DURATION,
        "claims": [*truth(UNIQUE), None, None],
        "extra_text": [repeated, unsung],
        "stem_matrix": packed(UNIQUE, UNIQUE_DURATION),
    }
    monkeypatch.setattr(align_steps, "_skipped_lines", spy)
    armed = attempt(tmp_path / "pair", monkeypatch, experiments=frozenset({"skip-arcs"}), **shape)
    assert seen == [frozenset({5, len(UNIQUE)})], f"a line printed twice is a repeat: {seen}"
    published = [line["text"] for line in armed.lines]
    assert published.count(repeated) == 2, f"the exempt pair lost an occurrence: {published}"
    assert unsung not in published, published

    # WITHOUT THE EXEMPTION, on that same matrix: `_skipped_lines` takes the SET and not the texts, so the
    # step's rule is the only thing standing between the pair and an arc.
    texts = [text for text, _s, _e in UNIQUE] + [repeated, unsung]
    matrix = FakeEmissions(log_probs=packed(UNIQUE, UNIQUE_DURATION), frame_sec=FRAME_SEC, dictionary=DIC)
    unexempted = align_unsung._skipped_lines(matrix, texts)
    assert unexempted is not None and len(UNIQUE) in unexempted, (
        f"without the exemption an occurrence of the pair is bypassed: {unexempted}"
    )


def test_the_arcs_run_before_the_never_sung_rule_and_both_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A COMPLEMENT and never a replacement (the corpus measured the replacement at +21 gross and +17 false
    drops): the arcs run first, on the blind decode, and the three-signal rule then grades what is left —
    so a sheet carrying one of each loses both lines and the trail names both reasons, in that order.

    The detector is stubbed to the line it would name, because the two fixtures pull opposite ways: the
    never-sung rule needs a matrix that HEARS the line faintly, and an arc only pays where nothing hears
    it at all.
    """
    from tests.ctc_fixture import sung_matrix as fixture_matrix
    from tests.test_align_provenance import FAINT, weakly_sung

    monkeypatch.setattr(align_steps, "_NEVER_SUNG_RATE", 1000.0)
    faint = "a whisper under the last chord"
    monkeypatch.setattr(
        align_steps,
        "_skipped_lines",
        lambda *_a, **_k: frozenset({len(UNIQUE)}),
    )
    got = attempt(
        tmp_path / "both",
        monkeypatch,
        phrases=UNIQUE,
        duration=UNIQUE_DURATION,
        claims=[*truth(UNIQUE), None, (44.0, 47.0)],
        extra_text=[CREDIT, faint],
        stem_matrix=weakly_sung(fixture_matrix(UNIQUE, DIC, UNIQUE_DURATION), (faint, 43.0, 49.0), FAINT),
        experiments=frozenset({"skip-arcs"}),
    )
    note = str(got.verdict[4])
    assert f"skip arcs left unsung: [{len(UNIQUE)}]" in note
    assert f"dropped never-sung: [{len(UNIQUE) + 1}] {faint!r}" in note
    assert note.index("skip arcs left unsung") < note.index("dropped never-sung"), (
        "the arcs are the rule's complement, so they are reported in the order they ran"
    )
    published = [line["text"] for line in got.lines]
    assert CREDIT not in published and faint not in published


def test_the_detector_reads_the_matrix_and_the_graph_the_publishing_decode_reads(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A detector run on another decode's evidence names lines about a decode that never happened: under
    `star-b` the publishing matrix carries the star column and its graph may BYPASS every star for free,
    so the detector has to read the same column and the same topology.

    Mandatory stars are not a smaller difference than the wrong matrix: each one is a state the detector's
    path must spend a frame on, which is evidence the publishing path never has to buy.
    """
    widths: list[int] = []
    real = align_unsung._skipped_lines

    def spy(matrix: Any, *args: Any, **kwargs: Any) -> Any:
        widths.append(int(np.asarray(matrix.log_probs).shape[1]))
        return real(matrix, *args, **kwargs)

    graphs: list[viterbi.Graph] = []
    decoded = viterbi.align

    def record(*args: Any, graph: viterbi.Graph = viterbi.PLAIN, **kwargs: Any) -> Any:
        graphs.append(graph)
        return decoded(*args, graph=graph, **kwargs)

    monkeypatch.setattr(align_steps, "_skipped_lines", spy)
    monkeypatch.setattr(viterbi, "align", record)
    armed = attempt(
        tmp_path / "on",
        monkeypatch,
        phrases=UNIQUE,
        duration=UNIQUE_DURATION,
        claims=truth(UNIQUE),
        experiments=frozenset({"skip-arcs", "star-b"}),
    )
    assert widths == [max(DIC.values()) + 2], f"the detector read an unstarred matrix: {widths}"
    note = str(armed.verdict[4])
    assert "a detector graph offered a skip arc at" in note, note
    assert "over the stars the publisher bypasses" in note, "the trail does not say which topology it read"

    published = {graph.stars for graph in graphs if graph.stars and not graph.skips}
    detector = [graph for graph in graphs if graph.skips]
    assert len(published) == 1, f"the publishing decode built no star graph: {published}"
    assert detector, "the detector decoded no graph at all"
    assert {graph.stars for graph in detector} == published, "the detector's stars are not the publisher's"
    assert {graph.star_penalty for graph in detector} == {STAR_PENALTY_NATS}


# ── star phase B ─────────────────────────────────────────────────────────────────────────────────


def test_star_b_is_expressed_in_the_vendored_graph_and_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Phase B is phase A's token in a graph that may BYPASS it, so the arm implies the vendored decoder
    and the trail carries both clauses: the column's identity, and the graph that made it optional.

    THE GRAPH CLAUSE MUST NOT BE THE CONTROL'S. `_graph_why` reports an unreported graph as "an empty graph,
    so this is torchaudio's own path", so an armed decode that noted nothing printed the `vendored` control's
    sentence byte for byte while really running a star bypass per line.
    """
    got = attempt(
        tmp_path / "on",
        monkeypatch,
        phrases=UNIQUE,
        duration=UNIQUE_DURATION,
        claims=truth(UNIQUE),
        experiments=frozenset({"star-b"}),
    )
    assert clause(got, "star:").startswith("star: one per line")
    assert clause(got, "vendored decoder") == (
        f"vendored decoder: decoded through a graph of {len(UNIQUE)} star state(s) bypassable at "
        f"{STAR_PENALTY_NATS:g} nats"
    ), clause(got, "vendored decoder")
    assert "empty graph" not in clause(got, "vendored decoder"), "the arm must not read as the control"
    assert len(got.lines) == len(UNIQUE)


def test_star_b_abstains_from_the_placement_margin_rule(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`_placement_margins` decodes the PLAIN topology and takes no graph, so under `star-b` — whose
    published decode bypasses every star for free — a margin read here would demote lines on a trellis no
    decode of the document used. Phase A is consistent, its star being
    mandatory in both, so it keeps the rule: the abstention belongs to the GRAPH, not to the column.
    """
    shape: dict[str, Any] = {
        "phrases": UNIQUE,
        "duration": UNIQUE_DURATION,
        "claims": truth(UNIQUE),
    }
    for arm in (frozenset(), frozenset({"star"})):
        read = attempt(tmp_path / f"read-{'-'.join(arm) or 'off'}", monkeypatch, experiments=arm, **shape)
        assert clause(read, "placement margins").startswith("placement margins over "), (
            f"{sorted(arm)}: the rule has to be READ here, or the contrast is vacuous"
        )

    armed = attempt(tmp_path / "star-b", monkeypatch, experiments=frozenset({"star-b"}), **shape)
    assert clause(armed, "placement margins") == (
        "placement margins: not read, `star-b` decoded through a graph whose stars are bypassable and the "
        "margin rule knows only the plain topology, so grading is as it was before the rule"
    ), clause(armed, "placement margins")


# ── roadmap item 14: the priors, the fusion, and the deciding arm ────────────────────────────────


def test_the_primed_re_decode_needs_a_claim_and_names_its_priors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The prior is the clock-mapped claims as a bonus, so with no claim there is nothing to prime with and
    the arm must go inert rather than decode a second time for nothing."""
    primed = attempt(
        tmp_path / "claimed",
        monkeypatch,
        phrases=UNIQUE,
        duration=UNIQUE_DURATION,
        claims=truth(UNIQUE),
        experiments=frozenset({"claim-priors"}),
    )
    assert f"re-decoded all {len(UNIQUE)} lines with {len(UNIQUE)} claim onset prior(s)" in str(
        primed.verdict[4]
    )
    assert f"{len(UNIQUE)} primed" in str(primed.verdict[4]), "the provenance has to read primed"

    bare = attempt(
        tmp_path / "unclaimed",
        monkeypatch,
        phrases=UNIQUE,
        duration=UNIQUE_DURATION,
        claims=[None] * len(UNIQUE),
        experiments=frozenset({"claim-priors"}),
    )
    assert "re-decoded all" not in str(bare.verdict[4])
    assert "primed" not in str(bare.verdict[4])


#: Claims displaced by a DIFFERENT amount per line, so `claimmap.consensus` cannot map the sheet onto our
#: clock and the reconcile verdict reads UNRELATED — the state the repair ladder exists for.
SCATTERED_CLAIMS = {0: 5.0, 1: 1.0, 2: 7.0, 3: 2.0, 4: 6.0, 5: 3.0, 6: 8.0, 7: 4.0}


def test_the_prior_promotes_no_line_the_default_graded_low(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """XA-03 under the prior: a claim tipped this path, so the line agreeing with that claim afterwards is
    not two witnesses agreeing, and the grade may not move up for it.

    `_Source.PRIMED` is not `BLIND`, so `line_confidence` takes the repaired branch and asks for blind
    corroboration AND agreement — strictly more than a blind line is asked for. Read on both sheets a
    grade can come out of: truth claims, where the default grades every line `high` off corroboration the
    prior did not provide, and scattered claims, where nothing corroborates anything.
    """
    graded: dict[str, set[str]] = {}
    for name, shift in (("truth", 0.0), ("scattered", SCATTERED_CLAIMS)):
        shape: dict[str, Any] = {
            "phrases": UNIQUE,
            "duration": UNIQUE_DURATION,
            "claims": truth(UNIQUE, shift),
        }
        default = attempt(tmp_path / f"off-{name}", monkeypatch, **shape)
        primed = attempt(
            tmp_path / f"on-{name}", monkeypatch, experiments=frozenset({"claim-priors"}), **shape
        )
        assert "primed" in clause(primed, "timing sources"), "the arm has to have run"
        for was, now in zip(default.lines, primed.lines, strict=True):
            assert not (was["confidence"] == "low" and now["confidence"] == "high"), (
                f"{name}: the prior promoted {was['text']!r} on the claim that primed it"
            )
        graded[name] = {line["confidence"] for line in primed.lines}
    # NOT VACUOUS: the truth sheet really does reach `high` under the arm, so the rule had something to
    # refuse; on the scattered sheet nothing corroborates anything and every line is `low` either way.
    assert graded == {"truth": {"high"}, "scattered": {"low"}}, graded


def test_the_primed_decode_does_not_decide_which_repeats_the_ladder_sees(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """R3 takes the repeats the BLIND verdict did not corroborate (XA-03), and the primed arms RE-READ the
    verdict on a claim-primed document, where a line the prior pulled onto its claim reads corroborated.
    Reading THAT set withholds from R3 exactly the repeats the prior moved, while `line_confidence`'s
    ANCHORED branch grades its output on blind corroboration regardless.

    The re-read is STUBBED to corroborate everything, because the shipped 4-nat peak is unfitted and cannot
    reach this fixture's 3.6 s — and this rule may not depend on how far a prior happens to pull.
    """
    from encore_worker.domain.lyrics import reconcile

    real = reconcile.reconcile
    read: list[str] = []

    def agreeable(lines: Any, claimed: Any) -> Any:
        got = real(lines, claimed)
        read.append(got.verdict)
        if len(read) == 1:
            return got  # the BLIND verdict, which grading reads and which stays as it really is
        return replace(got, lines=tuple(replace(j, corroborated=True) for j in got.lines))

    monkeypatch.setattr(reconcile, "reconcile", agreeable)
    primed = attempt(
        tmp_path / "on", monkeypatch, experiments=frozenset({"claim-priors"}), **misheard_repeat()
    )
    assert len(read) > 1, "the arm has to re-read the verdict for this to bite"
    assert f"re-decoded all {len(PHRASES)} lines with" in str(primed.verdict[4]), "the arm has to have run"
    assert R3_REPAIR in str(primed.verdict[4]), "a re-read verdict decided which repeats R3 was handed"


def test_the_fusion_reads_the_mix_only_where_the_stem_is_mute_in_a_claim_window(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The second half of item 14: inside a claim window the stem hears nothing in, the mix's frames are
    the only evidence there is. Where there is no second witness at all the arm says so instead."""
    from tests.test_align_provenance import SPARSE_SHORT

    # FOUR lines, which is under `claimmap.MIN_PAIRS`, so the claim clock abstains and the raw claims
    # survive — each one 2.5 s late and therefore wholly on the stem's silence between lines, which is
    # what the mask looks for. On the full six-line sheet the clock maps the offset away and there is no
    # mute window left to fuse (`test_align_provenance`'s H4 exhibits turn on the same distinction).
    fused = attempt(
        tmp_path / "sparse",
        monkeypatch,
        phrases=SPARSE_SHORT,
        duration=48.0,
        claims=truth(SPARSE_SHORT, 2.5),
        experiments=frozenset({"claim-fusion"}),
    )
    assert "fused the mix into" in clause(fused, "claim fusion"), clause(fused, "claim fusion")

    stemless = attempt(
        tmp_path / "stemless",
        monkeypatch,
        phrases=SPARSE_SHORT,
        duration=48.0,
        claims=truth(SPARSE_SHORT, 2.5),
        experiments=frozenset({"claim-fusion"}),
        stemless=True,
    )
    assert "no fusion: the target IS the mix" in clause(stemless, "claim fusion")

    # AND UNDER THE ARM ALWAYS, including where the primed decode never ran: `claim-fusion` changes the
    # evidence and not the decoder, so it owns no graph to report — and a run that fused a third of the
    # song into the decode must not read like one that had no claim to fuse inside. This clause was
    # MISSING: the trail printed it only under `vendored_arm`, which this arm alone does not set.
    unclaimed = attempt(
        tmp_path / "unclaimed",
        monkeypatch,
        phrases=SPARSE_SHORT,
        duration=48.0,
        claims=[None] * len(SPARSE_SHORT),
        experiments=frozenset({"claim-fusion"}),
    )
    assert clause(unclaimed, "claim fusion") == "claim fusion: no claim to fuse inside (claim-fusion)"
    assert clause(unclaimed, "vendored decoder") == "", "fusion is evidence, not a decoder"


def test_the_fused_matrix_decodes_on_the_kind_of_matrix_the_emitter_produced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`claim-fusion` alone keeps torchaudio's kernel, and the kernel calls TENSOR methods on what it is
    handed — while `prior.fused` is in `domain/`, which may not import torch and so answers in numpy.

    Every other test here decodes with the pure-numpy fake, which accepts either, so the arm read as if it
    had re-decoded on a box where it could not. Here the emitter's matrix is a real
    tensor and the decoder demands one, exactly as `forced_align_decoder`'s first line does.
    """
    torch = pytest.importorskip("torch")
    from tests.ctc_fixture import ctc_viterbi
    from tests.test_align_provenance import SPARSE_SHORT

    def only_tensors(log_probs: Any, targets: Sequence[int], blank: int = 0) -> tuple[list[int], list[float]]:
        """`forced_align_decoder`'s own demand: `log_probs.unsqueeze(0)`, which an ndarray has not got."""
        return ctc_viterbi(log_probs.unsqueeze(0)[0].numpy(), targets, blank)

    fused = attempt(
        tmp_path / "tensor",
        monkeypatch,
        phrases=SPARSE_SHORT,
        duration=48.0,
        claims=truth(SPARSE_SHORT, 2.5),
        stem_matrix=torch.from_numpy(np.ascontiguousarray(sung_matrix(SPARSE_SHORT, DIC, 48.0))),
        decoder=only_tensors,
        experiments=frozenset({"claim-fusion"}),
    )
    note = str(fused.verdict[4])
    assert "fused the mix into" in note, note
    assert f"re-decoded all {len(SPARSE_SHORT)} lines with 0 claim onset prior(s)" in note, note
    assert "the primed re-decode raised" not in note, note


def test_the_fusion_declines_a_mix_another_bundle_emitted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`prior.fused` swaps whole ROWS, so a row of one matrix has to BE a row of the other — and all it can
    compare is the WIDTH. The mix is emitted under its own language routing, which `lang-route-mix` can
    resolve to a different bundle, so the vocabulary is checked where both are in hand.
    Here the mix keeps the width and reverses the map, which a width check cannot see.
    """
    from tests import test_align_provenance as prov

    real = prov.PathAligner.emissions

    def other_bundle(aligner: Any, path: str, language: str) -> Any:
        got = real(aligner, path, language)
        if path.endswith("mix.wav"):
            return replace(got, dictionary={ch: at + 1 for at, ch in enumerate(reversed(list(DIC)))})
        return got

    monkeypatch.setattr(prov.PathAligner, "emissions", other_bundle)
    declined = attempt(
        tmp_path / "other",
        monkeypatch,
        phrases=prov.SPARSE_SHORT,
        duration=48.0,
        claims=truth(prov.SPARSE_SHORT, 2.5),
        experiments=frozenset({"claim-fusion"}),
    )
    assert clause(declined, "claim fusion") == (
        "claim fusion: no fusion: the mix was emitted by another bundle's vocabulary"
    ), clause(declined, "claim fusion")


def test_the_deciding_arm_stands_in_for_the_repair_ladder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The deciding arm is priors plus fusion plus optional lines WITH THE LADDER BYPASSED, so on
    a sheet the ladder repairs it must publish the primed decode instead and leave no repaired timing.

    THE CONTROL IS `vendored`, NOT THE DEFAULT. A repair window is handed `ml.forced_align_decoder`, which
    the harness monkeypatches — but a GLOBAL decode under any of these arms runs in the vendored graph
    instead, so the two runs have to share the decoder or the comparison measures the swap as well. Held
    constant, the only difference left between them is the bypass.
    """
    shape: dict[str, Any] = {
        "phrases": UNIQUE,
        "duration": UNIQUE_DURATION,
        "claims": truth(UNIQUE, SCATTERED_CLAIMS),
    }
    ladder = attempt(tmp_path / "ladder", monkeypatch, experiments=frozenset({"vendored"}), **shape)
    rungs = clause(ladder, "timing sources")
    assert "window" in rungs and "mix" in rungs, f"the sheet must really repair: {rungs}"

    deciding = attempt(tmp_path / "deciding", monkeypatch, experiments=frozenset({"priors-decide"}), **shape)
    sources = clause(deciding, "timing sources")
    assert "window" not in sources and "anchored" not in sources and "mix" not in sources, sources
    assert f"{len(UNIQUE)} primed" in sources, sources

    # R3 IS THE RUNG A UNIQUE SHEET CANNOT SEE: with no repeated line it never fires under either arm, so
    # the bypass has nothing to refuse there. The repeat-carrying fixture, with the
    # decoder mishearing ONE chorus occurrence and the sheet's own claims disputing exactly that line, is
    # where the control's ladder reaches it.
    repeating = misheard_repeat()
    climbed = attempt(tmp_path / "rungs", monkeypatch, experiments=frozenset({"vendored"}), **repeating)
    assert R3_REPAIR in str(climbed.verdict[4]), "the repeat fixture must really reach R3"

    decides = attempt(
        tmp_path / "decides", monkeypatch, experiments=frozenset({"priors-decide"}), **repeating
    )
    bypassed = clause(decides, "timing sources")
    assert R3_REPAIR not in str(decides.verdict[4]), "R3 ran under the deciding arm"
    assert "anchored" not in bypassed, bypassed
    assert f"{len(PHRASES)} primed" in bypassed, bypassed


# ── the knob, and the LOG.md sentence that counts this track ─────────────────────────────────────


def test_the_readme_counts_the_hermetic_tests_this_track_actually_has() -> None:
    """The measurement log's hermetic-test count for this track is how a later change decides whether an arm
    is covered, and it had drifted by six before anything derived it.

    The two whole files are counted from the files; `test_ml_contract.py`'s figure is the two cases that
    hold this decoder against the real kernel, which is a subset and stays the sentence's own claim.
    """
    import re

    readme = Path(__file__).resolve().parents[2] / "docs/benchmarks/forced-alignment/LOG.md"
    prose = re.sub(r"\s+", " ", readme.read_text(encoding="utf-8"))  # the sentence wraps
    said = re.search(
        r"\*\*(\d+) hermetic tests\*\* carry it: \*\*(\d+)\*\* in `tests/test_viterbi\.py`, "
        r"\*\*(\d+)\*\* in `tests/test_research_arms\.py` and \*\*(\d+)\*\* in `tests/test_ml_contract\.py`",
        prose,
    )
    assert said is not None, "the W9 research-track section no longer states its test count"
    total, viterbi_said, arms_said, contract_said = (int(group) for group in said.groups())

    here = Path(__file__).parent

    def defined(name: str) -> int:
        return len(re.findall(r"^def test_", (here / name).read_text(encoding="utf-8"), re.MULTILINE))

    assert (viterbi_said, arms_said) == (defined("test_viterbi.py"), defined("test_research_arms.py"))
    assert total == viterbi_said + arms_said + contract_said, f"{total} is not the sum of the three"


def test_every_w9_arm_is_a_declared_experiment() -> None:
    """Each ships OFF behind the ONE knob, and `test_ownership` refuses an undeclared name, so every arm
    has to be declared for `ENCORE_ALIGN_EXPERIMENTS` to be able to set it at all."""
    arms = ("vendored", "skip-arcs", "star-b", "claim-priors", "claim-fusion", "priors-decide")
    assert set(arms) <= set(ALIGN_EXPERIMENTS)
    assert Config.from_env({"ENCORE_ALIGN_EXPERIMENTS": ",".join(arms)}).align_experiments == frozenset(arms)
    assert Config.from_env({}).align_experiments == frozenset()


def test_the_graphs_line_blocks_are_the_runs_the_arcs_bypass() -> None:
    """`generate.line_blocks` is the one map from a line index to its own trellis states, and the arcs are
    priced off it, so a block that did not span exactly its line's characters would mis-price every arc."""

    class Emitted:
        log_probs = np.zeros((1, max(DIC.values()) + 1))
        frame_sec = FRAME_SEC
        dictionary = DIC
        blank_id = 0
        specials: dict[str, int] = {}

    texts = ["come and fly away", "", "carry me home"]
    flat = char_targets(texts, Emitted())
    blocks = line_blocks(flat)
    assert set(blocks) == {0, 2}, "a line with no alignable character gets no block and so no arc"
    for index, (first, last) in blocks.items():
        assert last - first == len(alignable(texts[index], DIC))
        assert list(flat.targets[first:last]) == alignable(texts[index], DIC)
