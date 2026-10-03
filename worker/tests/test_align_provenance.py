"""Provenance through the repair ladder: who timed each line, and what that lets grading claim.

Four review findings, pinned end to end through the real `time_text` on the CTC fixture: the claims are
mapped onto our clock once, before the first reconcile (H1); grading's corroboration comes from the BLIND
decode, a line re-decoded inside its claim window landing on its claim by construction (H4, XA-02, XA-03);
a line R4 timed on the MIX is not re-decoded on the stem by a later stage (L1); and the never-sung rule
does not bin a claimed line the stem is silent in but the mix is not (M6). L1's and M6's arms ship
DEFAULT-OFF, so both sides of each are pinned. The rules are docs/arch/04-alignment.md §4, §6 and §12 and
the arms' numbers README, "The L1 arms, priced on the song the review read them from"; the aligner serves
the stem's and the mix's matrices separately, which is what lets a test say which one R4 read.
"""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf

from encore_worker.domain.lyrics import claimmap
from encore_worker.domain.lyrics.generate import ONSET_LEAD_SEC, generate
from encore_worker.domain.lyrics.policy import Tier
from encore_worker.host.config import Config
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.records import AudioRef, JobRef, TextRef, TimedDoc, TimeRequest
from tests.ctc_fixture import Decode, Matrix, char_frames, ctc_viterbi, misheard, sung_matrix

RATE = 16000
FRAME_SEC = 0.02
DIC = {ch: i + 1 for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz'")}

Phrase = tuple[str, float, float]

#: test_align_v2's song: eight phrases, three of them the same chorus line.
PHRASES: list[Phrase] = [
    ("come and fly away", 5.0, 7.0),
    ("with me tonight", 8.0, 10.0),
    ("over the silver water", 12.0, 14.5),
    ("carry me home", 16.0, 18.0),
    ("come and fly away", 22.0, 24.0),
    ("stars are out", 25.5, 27.5),
    ("morning light across the river", 30.0, 33.0),
    ("come and fly away", 35.0, 37.0),
]
DURATION = 40.0

#: The review's s5-s7 song: eight unique lines, the last one sung alone after a gap.
UNIQUE: list[Phrase] = [
    ("come and fly away", 5.0, 7.0),
    ("with me tonight", 8.0, 10.0),
    ("over the silver water", 12.0, 14.5),
    ("carry me home", 16.0, 18.0),
    ("stars are out", 22.0, 24.0),
    ("morning light across the river", 27.0, 30.0),
    ("hold on to the night", 33.0, 35.0),
    ("never let it go", 38.0, 40.0),
]
UNIQUE_DURATION = 50.0


@dataclass(frozen=True)
class FakeEmissions:
    log_probs: object
    frame_sec: float
    dictionary: dict[str, int]

    @property
    def frames(self) -> int:
        return len(self.log_probs)  # type: ignore[arg-type]


class PathAligner:
    """An `Aligner` whose emission matrix depends on the PATH it is asked about: stem and mix differ."""

    def __init__(self, heard: Mapping[str, Matrix]) -> None:
        self.heard = dict(heard)
        self.asked: list[str] = []

    def emissions(self, path: str, _language: str) -> FakeEmissions:
        self.asked.append(path)
        return FakeEmissions(log_probs=self.heard[path], frame_sec=FRAME_SEC, dictionary=DIC)

    def align(self, *_a: object) -> tuple[dict[str, object], ...]:
        raise AssertionError("the windowed engine must not run: the global decode has emissions")


class TrailSpy:
    def __init__(self) -> None:
        self.states: list[tuple[Any, ...]] = []

    async def state(self, *args: Any) -> None:
        self.states.append(args)

    async def progress(self, *args: Any) -> None: ...

    async def confirm_ownership(self, *_a: object, **_k: object) -> bool:
        return True

    def explain_ownership(self, *_a: object) -> str:
        return ""


def sung_wav(path: Path, phrases: Sequence[Phrase], duration: float, *, seed: int, bed: float = 0.0) -> str:
    """A tone under each phrase over a noise floor: what `activity.envelope` reads as singing.

    `bed` adds a CONTINUOUS tone at that amplitude — an instrumental backing, which is what makes a real
    mix's envelope active almost everywhere (92-98% of frames on the corpus mixes against 59-77% on their
    stems; `domain/lyrics/ends.py`, ON A VOCALS STEM ONLY). A stem's wav leaves it at 0.
    """
    signal = np.random.default_rng(seed).normal(0.0, 0.002, int(duration * RATE))
    if bed:
        whole = np.arange(len(signal)) / RATE
        signal += bed * np.sin(2 * math.pi * 110.0 * whole)
    for _text, start, end in phrases:
        t = np.arange(int((end - start) * RATE)) / RATE
        first = int(start * RATE)
        signal[first : first + len(t)] += 0.3 * np.sin(2 * math.pi * 220.0 * t)
    sf.write(path, signal, RATE)
    return str(path)


def weakly_sung(matrix: Matrix, phrase: Phrase, hit: float) -> Matrix:
    """`matrix` with `phrase` heard at probability `hit` instead of the fixture's 0.9: a quiet vocal the
    decode still places right, but scores well below the song's norm."""
    out = matrix.copy()
    rest = math.log((1.0 - hit) / (out.shape[1] - 1))
    for first, last, token in char_frames([phrase], DIC):
        out[first:last, :] = rest
        out[first:last, token] = math.log(hit)
    return out


@dataclass(frozen=True)
class Outcome:
    timed: TimedDoc
    lines: list[dict[str, Any]]
    #: Every `align-global` note, in order; the last one is the verdict note.
    notes: list[tuple[Any, ...]]
    aligner: PathAligner

    @property
    def verdict(self) -> tuple[Any, ...]:
        return self.notes[-1]

    def line(self, text: str, occurrence: int = 0) -> dict[str, Any]:
        return [line for line in self.lines if line["text"] == text][occurrence]


def align(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    phrases: Sequence[Phrase],
    duration: float,
    claims: Sequence[tuple[float, float | None] | None],
    stem_sings: Sequence[Phrase] | None = None,
    stem_matrix: Matrix | None = None,
    extra_text: Sequence[str] = (),
    decoder: Decode = ctc_viterbi,
    experiments: frozenset[str] = frozenset(),
    stemless: bool = False,
    mix_bed: float = 0.0,
) -> Outcome:
    """One `time_text` attempt on a song whose MIX sings `phrases` and whose STEM sings `stem_sings`.

    The stem's wav is what the envelope hears and `stem_matrix` what the decoder hears. `claims` is one
    (start, end) or None per line of `phrases` then `extra_text`; `(start, None)` is a TRUNCATED cue, the
    shape an LRC's last line and a stacked timestamp carry. `stemless` serves the job no vocals stem, so
    the MIX is the align target at every stage (the bench's `--no-stem` shape), and `mix_bed` lays a
    continuous instrumental tone under the mix, which is what makes a real mix's envelope active."""
    from encore_worker.adapters import ml

    monkeypatch.setattr(ml, "forced_align_decoder", decoder)
    on_stem = list(phrases if stem_sings is None else stem_sings)
    mix = sung_wav(tmp_path / "mix.wav", phrases, duration, seed=1, bed=mix_bed)
    if stemless:
        aligner = PathAligner({mix: sung_matrix(phrases, DIC, duration)})
        stem = None
    else:
        stem = sung_wav(tmp_path / "vocals.wav", on_stem, duration, seed=0)
        aligner = PathAligner(
            {
                stem: sung_matrix(on_stem, DIC, duration) if stem_matrix is None else stem_matrix,
                mix: sung_matrix(phrases, DIC, duration),
            }
        )
    trail = TrailSpy()
    config = Config(align_experiments=experiments)
    impl = AlignStepsImpl(config=config, adapters=Adapters(aligner=aligner), reporter=trail)
    texts = [text for text, _s, _e in phrases] + list(extra_text)
    assert len(claims) == len(texts)
    segments = tuple(
        {
            "text": text,
            **({} if claim is None else {"start": claim[0]}),
            **({} if claim is None or claim[1] is None else {"end": claim[1]}),
        }
        for text, claim in zip(texts, claims, strict=True)
    )
    request = TimeRequest(
        job=JobRef(job_id="j1", media_id="m1", media_dir=str(tmp_path), source_uri=None, params={}),
        text=TextRef(tier=Tier.CANDIDATE, label="test", segments=segments, timing="line"),
        audio=AudioRef(path=mix, vocals_path=stem, duration_sec=duration),
        language="en",
    )
    timed = asyncio.run(impl.time_text(request))
    assert isinstance(timed, TimedDoc), f"expected a published document, got {timed!r}"
    doc: dict[str, Any] = json.loads((tmp_path / timed.ref).read_text())
    notes = [s for s in trail.states if s[1] == "align-global"]
    return Outcome(timed=timed, lines=doc["lines"], notes=notes, aligner=aligner)


def truth(phrases: Sequence[Phrase], shift: Mapping[int, float] | float = 0.0) -> list[tuple[float, float]]:
    """Each phrase's own span as its claim, moved by `shift` (one offset, or per line index)."""
    by = shift if isinstance(shift, Mapping) else dict.fromkeys(range(len(phrases)), shift)
    return [(start + by.get(i, 0.0), end + by.get(i, 0.0)) for i, (_t, start, end) in enumerate(phrases)]


# ── H4: corroboration from the blind decode only ─────────────────────────────────────────────────────

#: Sparse vocals: two-second lines, five seconds of silence between them, so a claim 2.5 s late sits
#: entirely on the stem's silence and R4 re-decodes every line on the mix.
SPARSE: list[Phrase] = [
    ("come and fly away", 5.0, 7.0),
    ("with me tonight", 12.0, 14.0),
    ("over the silver water", 19.0, 21.0),
    ("carry me home", 26.0, 28.0),
    ("stars are out", 33.0, 35.0),
    ("hold on to the night", 40.0, 42.0),
]

#: The same song with four lines, which is UNDER `claimmap.MIN_PAIRS` — so the claim clock abstains and the
#: raw claim clock still reaches R4. The review's H4 exhibit only exists on such a sheet now (W2).
SPARSE_SHORT: list[Phrase] = SPARSE[:4]


def test_lines_the_mix_timed_inside_offset_claim_windows_are_not_graded_high(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """H4's exhibit on a sheet the claim clock leaves alone: a repaired line may not grade `high`.

    An LRC 2.5 s late over sparse vocals, with four paired claims — under `claimmap.MIN_PAIRS`, so the
    clock abstains and the raw claims survive. Every claim window sits on stem silence, so R4 re-decodes
    every line on the mix, each lands at the window's own edge, and the re-reconcile reads one coherent
    offset with every line corroborated: the old grading published all of them `high`, 1.5 s late. The
    blind decode is the only independent witness, and the positions it corroborates are not these."""
    got = align(tmp_path, monkeypatch, phrases=SPARSE_SHORT, duration=48.0, claims=truth(SPARSE_SHORT, 2.5))
    assert got.aligner.asked[1:] == [str(tmp_path / "mix.wav")], "R4 decoded the mix"
    for line, (text, start, _end) in zip(got.lines, SPARSE_SHORT, strict=True):
        assert line["text"] == text
        assert line["start"] - start > 0.5, f"{text!r}: the exhibit needs R4 to have moved it off"
        assert line["confidence"] == "low", f"{text!r} is {line['start'] - start:+.2f} s off and graded high"
    state, why = got.verdict[3], got.verdict[4]
    assert state == "offset", "the trail's verdict is the blind one, the one grading read"
    # 2.5 s, plus the decode's own onset lead — READ from the constant, not written out, so a re-fit of
    # `ONSET_LEAD_SEC` (W4 re-fitted it 40 -> 30 ms on the exact frame grid) moves the exhibit's number
    # rather than breaking the exhibit.
    late_by = 2.5 + ONSET_LEAD_SEC
    assert f"claims are uniformly {late_by:.2f}s late" in why, why
    assert "4 paired line(s), 5 needed to map" in why, "the claim clock says why it abstained"
    assert "after repairs" in why and "(steers the repairs, never the grade)" in why
    assert "timing sources: 4 mix [0] [1] [2] [3]" in why
    assert why.endswith("0/4 lines high")


# ── H1: the claim clock, before anything reads the claims (review §3.2; W2) ───────────────────────────


def test_an_offset_sheet_is_mapped_onto_our_clock_before_any_repair_reads_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """H1 at the source: the exhibit above, with enough paired lines to map.

    Mapped onto our clock before anything reads them, the 2.5 s-late windows land back on the singing:
    nothing is stem-invisible, R4 never runs, the mix is never decoded, and the blind decode publishes
    where the song is sung, corroborated and `high`. The envelope lag and the decode median both explain
    all six lines, and a tie goes to the lag measured on the AUDIO — the one estimate that does not read
    our own decode."""
    got = align(tmp_path, monkeypatch, phrases=SPARSE, duration=48.0, claims=truth(SPARSE, 2.5))
    assert got.aligner.asked == [str(tmp_path / "vocals.wav")], "the mix is never decoded: R4 has no line"
    for line, (text, start, _end) in zip(got.lines, SPARSE, strict=True):
        assert line["text"] == text
        assert abs(line["start"] - start) < 0.15, f"{text!r} publishes where it is sung"
        assert line["confidence"] == "high", f"{text!r}: a corroborated blind line"
    why = got.verdict[4]
    assert "claims mapped onto our clock by envelope-lag -2.50s" in why
    assert "6 of 6 paired lines explained" in why and "against no-shift's 0" in why
    assert "timing sources: 6 blind" in why
    assert why.endswith("6/6 lines high")


def test_a_sheet_already_on_our_clock_is_left_alone(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The margin's job. Truth claims: no candidate can explain more lines than no-shift does, so the map
    abstains and says so — and the document is byte-identical to the one the raw clock produced."""
    got = align(tmp_path, monkeypatch, phrases=SPARSE, duration=48.0, claims=truth(SPARSE))
    why = got.verdict[4]
    assert "claims left on their own clock" in why and "under the 2-line margin" in why
    for line, (text, start, _end) in zip(got.lines, SPARSE, strict=True):
        assert line["text"] == text
        assert abs(line["start"] - start) < 0.15
        assert line["confidence"] == "high"


def test_the_piecewise_arm_reaches_the_estimator_only_when_it_is_on(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The knob's wiring. The change-point map's own behaviour is pinned pure (`test_claimmap.py`, where a
    45-line series can carry a step); what a step-level test can say is that `claimmap-piecewise` is the
    only thing that admits it, and that the default asks for a single map.

    A fake spy rather than a stepped song on purpose: a split needs `2 x MIN_PIECE_PAIRS` paired lines, so
    a fixture song long enough to split would cost a 10-line matrix to assert one boolean.
    """
    asked: list[bool] = []
    real = claimmap.consensus

    def spy(*args: Any, **kwargs: Any) -> claimmap.ClaimMap:
        asked.append(bool(kwargs.get("piecewise")))
        return real(*args, **kwargs)

    monkeypatch.setattr(claimmap, "consensus", spy)
    off, on = tmp_path / "off", tmp_path / "on"
    off.mkdir()
    on.mkdir()
    align(off, monkeypatch, phrases=SPARSE, duration=48.0, claims=truth(SPARSE, 2.5))
    align(
        on,
        monkeypatch,
        phrases=SPARSE,
        duration=48.0,
        claims=truth(SPARSE, 2.5),
        experiments=frozenset({"claimmap-piecewise"}),
    )
    assert asked == [False, True]


def test_a_repair_that_keeps_the_blind_decodes_position_stays_high(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other half of the rule. A quiet line the stem's ENVELOPE barely registers but its decoder still
    hears: its claim window reads as stem-invisible, so R4 re-decodes it on the mix. The blind decode had
    it where it is sung and the claim agrees, and the mix puts it there too, so the repair kept the
    position two independent witnesses agreed on: `high`, with its source named on the trail."""
    quiet = 5
    got = align(
        tmp_path,
        monkeypatch,
        phrases=PHRASES,
        duration=DURATION,
        claims=truth(PHRASES),
        stem_sings=[p for i, p in enumerate(PHRASES) if i != quiet],
        stem_matrix=sung_matrix(PHRASES, DIC, DURATION),
    )
    line = got.lines[quiet]
    assert abs(line["start"] - PHRASES[quiet][1]) < 0.1
    assert line["confidence"] == "high"
    assert f"timing sources: 7 blind, 1 mix [{quiet}]" in got.verdict[4]
    assert "re-decoded 1 stem-invisible lines against the mix" in got.verdict[4]


def test_a_line_r2_repairs_inside_its_claim_window_is_low_unless_the_blind_decode_agreed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """R2's circularity. The blind decode places `carry me home` 3 s late (the global pass hears it at
    19 s); the claim disputes it, and R2's re-decode inside the claim window finds it where it is sung.
    The repair is right, and the ladder's re-reconcile then calls every line corroborated — but the line
    now agrees with its claim BECAUSE it was decoded inside the claim's window. Only the blind decode could
    have corroborated it independently, and it disputed it: `low`. The trail's verdict stays the blind
    STRUCTURAL, with the re-reconcile's AGREE labelled as what steered the ladder."""
    moved = [(t, 19.0, 21.0) if i == 3 else (t, s, e) for i, (t, s, e) in enumerate(PHRASES)]
    got = align(
        tmp_path,
        monkeypatch,
        phrases=PHRASES,
        duration=DURATION,
        claims=truth(PHRASES),
        decoder=misheard(sung_matrix(moved, DIC, DURATION), int(DURATION / FRAME_SEC)),
    )
    repaired = got.lines[3]
    assert repaired["text"] == "carry me home" and abs(repaired["start"] - 16.0) < 0.1, "R2 found it"
    assert repaired["confidence"] == "low"
    assert [line["confidence"] for i, line in enumerate(got.lines) if i != 3] == ["high"] * 7
    state, why = got.verdict[3], got.verdict[4]
    assert state == "structural"
    assert "after repairs agree, 100% of 8 lines agree" in why
    assert "re-decoded 1 of 1 disputed lines inside their claim windows" in why
    assert "timing sources: 7 blind, 1 window [3]" in why


# ── L1: the two default-off arms ─────────────────────────────────────────────────────────────────────


#: Review repro s6's own numbers: the stem lost line 5 and its claim runs 0.4 s late.
S6 = {5: 0.4}

#: The same sheet with ONE grossly displaced stamp (line 0, three seconds out), which since W2 is what makes
#: R2 look at a sub-second disagreement at all: only a STRUCTURAL verdict disputes every uncorroborated line
#: (M4), and the 0.4 s sheet alone grades COARSE. docs/arch/04-alignment.md §7 carries the taxonomy.
S6_STRAY = {5: 0.4, 0: 3.0}


def s6(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    experiments: frozenset[str],
    shift: Mapping[int, float] = S6_STRAY,
) -> Outcome:
    return align(
        tmp_path,
        monkeypatch,
        phrases=PHRASES,
        duration=DURATION,
        claims=truth(PHRASES, shift),
        stem_sings=[p for i, p in enumerate(PHRASES) if i != 5],
        experiments=experiments,
    )


def test_with_l1_mix_kept_r2_does_not_undo_on_the_stem_a_line_r4_heard_on_the_mix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """R4 hears line 5 on the mix where it is sung (25.5 s), 0.4 s from its claim, so the ladder's
    re-reconcile disputes it — and R2 re-decodes it on the STEM, which is silent there: the decode sticks
    to its window's edge and the line adopts the claim, 25.9 s. With `l1-mix-kept` the mix's measurement
    is kept; the line is `low` either way (the blind decode never had it)."""
    got = s6(tmp_path, monkeypatch, frozenset({"l1-mix-kept"}))
    line = got.lines[5]
    assert abs(line["start"] - 25.5) < 0.1, f"published at {line['start']:.2f} s: R2 undid R4"
    assert all(word["score"] != 0.0 for word in line["words"]), "decoded, not the claim's span"
    assert line["confidence"] == "low"
    why = got.verdict[4]
    assert "1 mix [5]" in why and "1 adopted [0]" in why, "the stray stamp's own line still adopts"
    assert "re-decoded 1 of 1 disputed lines inside their claim windows" in why


def test_by_default_r2_may_re_decode_a_line_r4_timed_on_the_mix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The shipped default (`l1-mix-kept` off, measured better on never-be-alone): R2 re-decodes the mix's
    line on the stem, hears nothing there, and adopts the jittered claim — repro s6's harm, kept."""
    got = s6(tmp_path, monkeypatch, frozenset())
    line = got.lines[5]
    assert abs(line["start"] - 25.9) < 1e-6 and all(word["score"] == 0.0 for word in line["words"])
    assert line["confidence"] == "low"
    assert "re-decoded 2 of 2 disputed lines inside their claim windows" in got.verdict[4]
    assert "2 adopted [0] [5]" in got.verdict[4]


def test_a_sub_second_dispute_alone_does_not_send_r2_to_undo_the_mix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """M4 by default, on repro s6's own sheet: a sub-second dispute is not a repair candidate.

    The BLIND verdict is STRUCTURAL and rightly so — the stem lost line 5, a gross minority of one. R4
    finds that line on the mix 0.4 s from its claim, and the re-reconcile R2 reads is then COARSE, where
    nothing under `reconcile.COARSE_TOLERANCE_SEC` is disputed: R2 never runs and the mix's measurement
    stands. Before W2 any agreement under 1.0 read STRUCTURAL, and R2 re-decoded line 5 on the silent
    stem and adopted the jittered claim — 25.90 s for a line sung at 25.50 s."""
    got = s6(tmp_path, monkeypatch, frozenset(), S6)
    line = got.lines[5]
    assert abs(line["start"] - 25.5) < 0.1, f"published at {line['start']:.2f} s"
    assert all(word["score"] != 0.0 for word in line["words"]), "decoded, not the claim's span"
    why = got.verdict[4]
    assert got.verdict[3] == "structural", why
    assert "after repairs coarse, 88% of 8 lines agree" in why, "the class R2 reads, after R4's repair"
    assert "1 mix [5]" in why and "adopted" not in why
    assert "disputed lines inside their claim windows" not in why


#: Review repro s5's shape: line 1 sung quietly with its claim 0.4 s late, plus one stamp 1.2 s out (line 3),
#: for `S6_STRAY`'s reason — a sheet with no gross disagreement is never STRUCTURAL since W2, and no other
#: class disputes 0.4 s, so without the stray R2 would not run at all (the test after the pair pins that).
S5 = {1: 0.4}
S5_STRAY = {1: 0.4, 3: 1.2}


def quiet_and_lost(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    experiments: frozenset[str],
    shift: Mapping[int, float] = S5_STRAY,
) -> Outcome:
    """The stem lost the second half (lines 4-7), and line 1 is sung quietly with a claim 0.4 s late."""
    on_stem = [p for i, p in enumerate(PHRASES) if i < 4]
    return align(
        tmp_path,
        monkeypatch,
        phrases=PHRASES,
        duration=DURATION,
        claims=truth(PHRASES, shift),
        stem_sings=on_stem,
        stem_matrix=weakly_sung(sung_matrix(on_stem, DIC, DURATION), PHRASES[1], hit=0.35),
        experiments=experiments,
    )


def test_with_l1_blind_median_a_quiet_heard_line_is_not_adopted_over(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """L1's median: the adoption test's reference is the BLIND decode's, taken once (`l1-blind-median`).

    Line 1 is heard where it is sung but scores well below the loud lines, and R2 re-decodes it in its
    window. Against the blind median (-2.8, over four loud lines and four the stem could not place) it
    sits far above the adoption gap and is kept. Recomputed at R2 over the series as repaired so far —
    the default — the four restored mix lines lift the median to the loud lines' -0.1, and the quiet line
    falls below it and adopts its claim's own 0.4 s error, which is repro s5's shape."""
    got = quiet_and_lost(tmp_path, monkeypatch, frozenset({"l1-blind-median", "m6-mix-spare"}))
    line = got.lines[1]
    assert line["text"] == "with me tonight"
    assert abs(line["start"] - 8.0) < 0.1, f"published at {line['start']:.2f} s, the claim is 8.40 s"
    assert all(word["score"] != 0.0 for word in line["words"]), "the quiet decode was adopted over"
    why = got.verdict[4]
    assert "re-decoded 2 of 2 disputed lines inside their claim windows" in why
    assert "1 window [1]" in why and "4 mix [4] [5] [6] [7]" in why
    assert "1 adopted [3]" in why, "the stray stamp's own line, whose window sits on silence"


def test_by_default_the_adoption_median_is_the_series_as_repaired_so_far(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The shipped default (`l1-blind-median` off): the median R2 adopts against is re-read over the
    repaired series, so the quiet line adopts its claim. The note names the median each stage used, which
    is how the review's -2.98 -> -0.88 was read off never-be-alone's trail in the first place."""
    got = quiet_and_lost(tmp_path, monkeypatch, frozenset())
    line = got.lines[1]
    assert abs(line["start"] - 8.4) < 1e-6 and all(word["score"] == 0.0 for word in line["words"])
    stem = weakly_sung(sung_matrix(PHRASES[:4], DIC, DURATION), PHRASES[1], hit=0.35)
    blind = generate([t for t, _s, _e in PHRASES], FakeEmissions(stem, FRAME_SEC, DIC), decoder=ctc_viterbi)
    scores = sorted(ln.score for ln in blind.lines)
    assert (scores[3] + scores[4]) / 2 < -2.5, "the rig: the blind median sits far below the loud lines"
    assert "2 adopted [1] [3]" in got.verdict[4]
    assert "scored 0.5 below the median line score: -0.11 (R2)" in got.verdict[4]


def test_a_sub_second_dispute_alone_does_not_send_r2_to_adopt_over_a_quiet_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """REVIEW M4 removing repro s5's harm by default, on the repro's own sheet (`S5`, no stray stamp). The
    only disagreement is line 1's 0.4 s, so no class but STRUCTURAL would dispute it and no sheet without a
    gross minority is STRUCTURAL: R2 never runs, the quiet line keeps the decode that heard it, and the
    adoption median — which arm chooses it — never gets asked. Before W2 the same sheet sent R2 to re-decode
    line 1 and adopt its claim, 8.40 s for a line sung at 8.00 s."""
    got = quiet_and_lost(tmp_path, monkeypatch, frozenset(), S5)
    line = got.lines[1]
    assert abs(line["start"] - 8.0) < 0.1, f"published at {line['start']:.2f} s, the claim is 8.40 s"
    assert all(word["score"] != 0.0 for word in line["words"]), "the quiet decode stands"
    why = got.verdict[4]
    assert "disputed lines inside their claim windows" not in why
    assert "adopted" not in why


# ── M6 (`m6-mix-spare`): a claimed line is binned only when BOTH envelopes are silent over its window ──
#
# The never-sung rule's decode signals need a line the decode SMEARED over silence, which the real kernel
# does but an exact Viterbi does not — it packs such a line into its neighbour's last frames instead. So
# these rigs give the stem's matrix a faint trace on silent frames and the decode parks it 3.0 below.

#: A faint trace: under 0.05 the line's chars barely beat the blank on those frames.
FAINT = 0.05


@pytest.fixture()
def any_tempo(monkeypatch: pytest.MonkeyPatch) -> None:
    """The never-sung rule's tempo signal is calibrated on real songs (a never-sung line smears at ~1
    char/s); a trace short enough to fit these songs' silences smears faster. Relaxed where needed, as in
    test_align_v2's never-sung test, so the test reaches the envelope signals it is about."""
    from encore_worker.steps import align_steps

    monkeypatch.setattr(align_steps, "_NEVER_SUNG_RATE", 1000.0)


def stem_lost_the_closing_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, experiments: frozenset[str]
) -> Outcome:
    """Review repro s7's shape: the stem lost the closing line (its wav and its matrix sing the first 7),
    the mix sings all 8, and the stem's matrix holds only a faint trace of the lost line on the outro."""
    lost = len(UNIQUE) - 1
    return align(
        tmp_path,
        monkeypatch,
        phrases=UNIQUE,
        duration=UNIQUE_DURATION,
        claims=truth(UNIQUE),
        stem_sings=UNIQUE[:lost],
        stem_matrix=weakly_sung(
            sung_matrix(UNIQUE[:lost], DIC, UNIQUE_DURATION), ("never let it go", 41.0, 49.0), FAINT
        ),
        experiments=experiments,
    )


def test_with_m6_mix_spare_a_claimed_line_the_stem_lost_but_the_mix_sings_goes_to_r4_not_the_bin(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review repro s7, with the `m6-mix-spare` arm on. The stem lost the closing line; the mix sings it.
    The stem's decode smears it over the silent outro (41-49 s, 1.9 chars/s, 3.0 below the song's score),
    so on stem evidence alone every never-sung signal fires, and it used to be deleted BEFORE the claims
    were read or R4 could run. Its claim window is silent on the stem but not on the mix, so it is spared:
    it leaves the stem's decode like a binned line, R4 re-decodes it on the mix, where the acoustic model
    hears it sung, and puts it back; it publishes `low` (only the mix heard it)."""
    lost = len(UNIQUE) - 1
    got = stem_lost_the_closing_line(tmp_path, monkeypatch, frozenset({"m6-mix-spare"}))
    assert [line["text"] for line in got.lines] == [text for text, _s, _e in UNIQUE]
    line = got.lines[lost]
    assert abs(line["start"] - UNIQUE[lost][1]) < 0.1 and line["confidence"] == "low"
    why = got.verdict[4]
    assert "dropped never-sung" not in why
    assert (
        f"spared 1 never-sung candidates for the witness their claim windows sound on: [{lost}] "
        "'never let it go' on the mix" in why
    )
    assert (
        "re-decoded 1 stem-invisible lines against the mix (1 of them spared never-sung lines it heard); "
        f"timing sources: 7 blind, 1 mix [{lost}]" in why
    )


def test_by_default_a_claimed_line_the_stem_lost_is_binned_as_v2_binned_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The shipped default (`m6-mix-spare` off, W1's full-corpus bench: it put back one header and one
    extra-verse line the mix's model heard the next line's speech under). The never-sung rule reads the
    stem alone, as v2 did: the lost line is binned, the mix's envelope is never read, and R4 has nothing
    of the never-sung rule's to decode — the seven lines the stem sings publish as the blind decode
    placed them."""
    lost = len(UNIQUE) - 1
    got = stem_lost_the_closing_line(tmp_path, monkeypatch, frozenset())
    assert [line["text"] for line in got.lines] == [text for text, _s, _e in UNIQUE[:lost]]
    why = got.verdict[4]
    assert f"dropped never-sung: [{lost}] 'never let it go'" in why
    assert "spared" not in why and "stem-invisible" not in why
    assert "timing sources: 7 blind" in why
    assert got.aligner.asked == [str(tmp_path / "vocals.wav")], "only the stem was decoded"


@pytest.mark.usefixtures("any_tempo")
def test_a_claimed_line_silent_on_both_envelopes_is_still_binned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The rule still does its job: an uploader's credit, claimed over the outro, is sung on neither the
    stem nor the mix. Forced through the emissions it would steal its neighbours' frames, so it is binned
    and the rest re-decoded, exactly as before the mix was asked."""
    credit = "thanks for watching everyone"
    got = align(
        tmp_path,
        monkeypatch,
        phrases=UNIQUE,
        duration=UNIQUE_DURATION,
        claims=[*truth(UNIQUE), (44.0, 47.0)],
        stem_matrix=weakly_sung(sung_matrix(UNIQUE, DIC, UNIQUE_DURATION), (credit, 43.0, 49.0), FAINT),
        extra_text=[credit],
    )
    assert [line["text"] for line in got.lines] == [text for text, _s, _e in UNIQUE]
    why = got.verdict[4]
    assert f"dropped never-sung: [{len(UNIQUE)}] {credit!r}" in why
    assert "kept" not in why
    assert all(line["confidence"] == "high" for line in got.lines)


def muffled(phrases: Sequence[Phrase], duration: float) -> Matrix:
    """A mix matrix whose acoustic model barely hears the voice ANYWHERE: every sung char at 3.5% against a
    96% blank, so the decode still finds each line (the char beats the rest), but the speech mass over the
    song's own lines is ~0.04."""
    matrix = sung_matrix(phrases, DIC, duration)
    vocab = matrix.shape[1]
    blank, char, rest = math.log(0.96), math.log(0.035), math.log(0.005 / (vocab - 2))
    out = np.full_like(matrix, rest)
    out[:, 0] = blank
    for first, last, token in char_frames(phrases, DIC):
        out[first:last, token] = char
    return out


def credit_over_a_band_intro(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    *,
    band: bool = True,
    spoken: bool = False,
    muffle: bool = False,
    experiments: frozenset[str] = frozenset({"m6-mix-spare"}),
) -> Outcome:
    """An uploader's credit claimed from 0 s to the first lyric, the way an LRC's `[00:00.00]` credit
    parses, over an intro the BAND plays: the mix's envelope is loud there (so the claim window reads as
    audible on the mix and, under `m6-mix-spare`, the credit is spared), the stem is silent, and — unless
    `spoken` — the mix's acoustic model hears no speech in it, because nobody sings."""
    credit = "subtitles by the amara community"
    intro: list[Phrase] = [(credit, 0.5, 4.5)]
    stem = sung_wav(tmp_path / "vocals.wav", UNIQUE, UNIQUE_DURATION, seed=0)
    mix = sung_wav(tmp_path / "mix.wav", [*UNIQUE, *(intro if band else [])], UNIQUE_DURATION, seed=1)
    from encore_worker.adapters import ml

    monkeypatch.setattr(ml, "forced_align_decoder", ctc_viterbi)
    stem_matrix = weakly_sung(sung_matrix(UNIQUE, DIC, UNIQUE_DURATION), (credit, 0.5, 4.5), FAINT)
    sung_on_mix = [*UNIQUE, *(intro if spoken else [])]
    mix_matrix = (
        muffled(sung_on_mix, UNIQUE_DURATION) if muffle else sung_matrix(sung_on_mix, DIC, UNIQUE_DURATION)
    )
    aligner = PathAligner({stem: stem_matrix, mix: mix_matrix})
    trail = TrailSpy()
    impl = AlignStepsImpl(
        config=Config(align_experiments=experiments), adapters=Adapters(aligner=aligner), reporter=trail
    )
    segments = (
        {"text": credit, "start": 0.0, "end": UNIQUE[0][1]},
        *({"text": t, "start": s, "end": e} for t, s, e in UNIQUE),
    )
    request = TimeRequest(
        job=JobRef(job_id="j1", media_id="m1", media_dir=str(tmp_path), source_uri=None, params={}),
        text=TextRef(tier=Tier.CANDIDATE, label="test", segments=segments, timing="line"),
        audio=AudioRef(path=mix, vocals_path=stem, duration_sec=UNIQUE_DURATION),
        language="en",
    )
    timed = asyncio.run(impl.time_text(request))
    assert isinstance(timed, TimedDoc)
    doc: dict[str, Any] = json.loads((tmp_path / timed.ref).read_text())
    notes = [n for n in trail.states if n[1] == "align-global"]
    return Outcome(timed=timed, lines=doc["lines"], notes=notes, aligner=aligner)


@pytest.mark.usefixtures("any_tempo")
def test_a_credit_the_band_makes_audible_on_the_mix_is_spared_but_not_put_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review W1 r1. The mix ENVELOPE spares the credit (the band clears 0.10 there), and W1 then put it
    back — decoded on the mix, or adopted as its claim span by a later stage: 33 unsung lines spared that
    way on the bench, every one published. The mix's acoustic model hears no speech in the intro, so R4's
    decode did not HEAR it, and it goes where the never-sung rule sent it; nothing adopts its claim."""
    got = credit_over_a_band_intro(tmp_path, monkeypatch)
    assert [line["text"] for line in got.lines] == [text for text, _s, _e in UNIQUE]
    why = got.verdict[4]
    assert "spared 1 never-sung candidates" in why and "on the mix" in why
    assert (
        "dropped never-sung after all, no witness heard them: [0] 'subtitles by the amara community'" in why
    )
    assert "adopted" not in why and "1 mix [0]" not in why


@pytest.mark.usefixtures("any_tempo")
def test_a_spared_line_the_mix_hears_is_put_back_and_never_steers_or_adopts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The same shape where the mix DOES hear speech in the claim window: the line comes back as R4 decoded
    it, `low`. It then takes no part in the ladder: the re-reconcile that steers R1 / R2 is taken over the
    other 8 lines (it would count a claim-window decode agreeing with its own claim), and no later stage
    re-decodes it or adopts its claim span."""
    got = credit_over_a_band_intro(tmp_path, monkeypatch, spoken=True)
    line = got.line("subtitles by the amara community")
    assert line["confidence"] == "low" and all(word["score"] != 0.0 for word in line["words"])
    why = got.verdict[4]
    assert "(1 of them spared never-sung lines it heard)" in why and "1 mix [0]" in why
    assert "after repairs agree, 100% of 8 lines agree" in why, "the returned line does not steer"
    assert "adopted" not in why


@pytest.mark.usefixtures("any_tempo")
def test_by_default_a_line_the_mix_hears_under_its_claim_is_binned_without_asking_the_mix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The shipped default (`m6-mix-spare` off). The spoken line the arm puts back above is binned as v2
    binned it: the full corpus is where the arm's speech test let through what the unsung gates refuse
    (LUNABLIND's `[Verse 3]`, whose claim window the mix hears the next line's singing in)."""
    got = credit_over_a_band_intro(tmp_path, monkeypatch, spoken=True, experiments=frozenset())
    assert [line["text"] for line in got.lines] == [text for text, _s, _e in UNIQUE]
    why = got.verdict[4]
    assert "dropped never-sung: [0] 'subtitles by the amara community'" in why
    assert "spared" not in why and "mix [0]" not in why


@pytest.mark.usefixtures("any_tempo")
def test_a_mix_that_barely_hears_the_voice_anywhere_cannot_vouch_for_a_spared_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`_SPOKEN_FLOOR`. The same spoken line, on a mix matrix that hears every line only faintly: relative
    to the song's own lines the claim window reads as speech (the ratio passes), but a model that hears the
    voice in ~4% of the frames where the singer is cannot tell one line from the band (measured: the mixes
    whose spared lines were all headers, credits or other songs' verses read 0.02-0.05). Binned."""
    got = credit_over_a_band_intro(tmp_path, monkeypatch, spoken=True, muffle=True)
    assert all(line["text"] != "subtitles by the amara community" for line in got.lines)
    assert "dropped never-sung after all, no witness heard them: [0]" in got.verdict[4]


@pytest.mark.usefixtures("any_tempo")
def test_by_default_a_claimed_line_the_target_sounds_in_is_binned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Quentin's and Ridgway's shape: the global pass cannot hear `carry me home` where it is sung and smears
    it over the silence before the next chorus, so every never-sung signal fires, while its claim window is
    where the STEM sings. Sparing it for a claim-window decode on the stem is W1's extension of review M6,
    the `m6-window-spare` arm, and ships OFF (`_SPOKEN_RATIO`): by default the line is binned, as v2 binned
    it."""
    got = window_spare(tmp_path, monkeypatch, frozenset())
    assert all(line["text"] != "carry me home" for line in got.lines)
    why = got.verdict[4]
    assert "dropped never-sung: [3] 'carry me home'" in why and "spared" not in why


def window_spare(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, experiments: frozenset[str]) -> Outcome:
    deaf = [(t, s, e) for i, (t, s, e) in enumerate(PHRASES) if i != 3]
    heard = weakly_sung(sung_matrix(deaf, DIC, DURATION), ("carry me home", 18.5, 21.5), FAINT)
    return align(
        tmp_path,
        monkeypatch,
        phrases=PHRASES,
        duration=DURATION,
        claims=truth(PHRASES),
        decoder=misheard(heard, int(DURATION / FRAME_SEC)),
        experiments=experiments,
    )


@pytest.mark.usefixtures("any_tempo")
def test_with_m6_window_spare_a_claimed_line_the_decode_put_on_silence_is_kept_where_the_stem_sings_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The `m6-window-spare` arm: the line still leaves the blind decode (so its neighbours are decoded
    without it, as for a binned line), then comes back through a claim-window decode on the stem, where it
    is HEARD. `low`: the blind decode never had it to corroborate."""
    got = window_spare(tmp_path, monkeypatch, frozenset({"m6-window-spare"}))
    line = got.line("carry me home")
    assert abs(line["start"] - 16.0) < 0.1 and line["confidence"] == "low"
    assert all(word["score"] != 0.0 for word in line["words"]), "decoded, not the claim's span"
    why = got.verdict[4]
    assert "dropped never-sung" not in why
    assert (
        "spared 1 never-sung candidates for the witness their claim windows sound on: "
        "[3] 'carry me home' on the stem" in why
    )
    assert "100% of 7 paired lines agree" in why, "the blind verdict, over the decode without it"
    assert "re-decoded 1 of 1 spared never-sung lines inside their claim windows on the stem" in why
    assert "timing sources: 7 blind, 1 window [3]" in why


# ── M5: a truncating claim window must not read as "heard nothing" ────────────────────────────────────
#
# A claim carries an END only where the sheet gave one; `_time_text_global` defaults the rest to start +
# 1.0 s, which is what an LRC's last stamp, a stacked timestamp and a short caption cue all get. The song
# below is six lines with five-second gaps, the last too long (26 alignable characters) for a 1.0 s cue.

#: Sparse, so a window can be widened without reaching its neighbour, and one long closing line.
TRUNCATED: list[Phrase] = [
    ("come and fly away", 5.0, 7.0),
    ("with me tonight", 12.0, 14.0),
    ("over the silver water", 19.0, 21.0),
    ("carry me home", 26.0, 28.0),
    ("stars are out", 33.0, 35.0),
    ("morning light across the river", 40.0, 43.0),
]
TRUNCATED_DURATION = 50.0

#: What the GLOBAL pass hears (`misheard`): the first five lines displaced by 1-4 s, in order and without
#: overlap, the long closing line where it is really sung. Varied displacements on purpose — a UNIFORM one
#: is a map, and `claimmap.consensus` would put the sheet on our clock and there would be nothing to repair.
SCATTERED: list[Phrase] = [
    ("come and fly away", 8.0, 10.0),
    ("with me tonight", 16.0, 18.0),
    ("over the silver water", 21.5, 23.5),
    ("carry me home", 30.0, 32.0),
    ("stars are out", 34.0, 36.0),
    ("morning light across the river", 40.0, 43.0),
]


@pytest.mark.usefixtures("any_tempo")
def test_a_truncated_cue_is_re_decoded_in_a_window_wide_enough_to_hold_the_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """M5's fix: a truncated cue's window is held open to the blind decode's own span for the line.

    Our own decode has scattered, so the blind verdict is UNRELATED and the claims become R1's anchors —
    every claimed line re-decoded inside its claim window, the closing line among them, and its cue has
    no end. Cut to start + 1.0 s the window is 3 s including both pads against a line that takes 3 s to
    sing: the forced path compresses it, `adopt_where_unheard` reads the poor score as "heard nothing",
    and the claim's one-second span replaces a correct measurement (40.00-41.00 s against 40.00-43.00
    sung). Held open to the blind span's end, the re-decode finds the line where it is sung."""
    got = align(
        tmp_path,
        monkeypatch,
        phrases=TRUNCATED,
        duration=TRUNCATED_DURATION,
        claims=[*truth(TRUNCATED)[:5], (40.0, None)],
        decoder=misheard(
            sung_matrix(SCATTERED, DIC, TRUNCATED_DURATION), int(TRUNCATED_DURATION / FRAME_SEC)
        ),
    )
    why = got.verdict[4]
    assert "claims fit the audio better" in why, "R1 is the stage under test"
    line = got.line("morning light across the river")
    assert abs(line["start"] - 40.0) < 0.15 and abs(line["end"] - 43.0) < 0.3, (
        f"published {line['start']:.2f}-{line['end']:.2f}s, sung 40.00-43.00s"
    )
    assert all(word["score"] != 0.0 for word in line["words"]), "decoded, not the claim's span adopted"
    assert "1 adopted [5]" not in why and "kept the measured timing" not in why
    assert "timing sources: 6 window" in why, "R1 re-decoded all six, the closing line included"


@pytest.mark.usefixtures("any_tempo")
def test_a_claim_span_too_short_to_hold_the_line_is_not_adopted_under_the_floor_arm(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """M5's other half, where nothing vouches for a wider window (`m5-adopt-floor`, DEFAULT-OFF).

    The sheet claims the closing line 7 s early and gives no end, so the blind decode's span does not
    touch the cue and the window cannot be widened. R2 re-decodes inside the cue over frames that sing a
    different line, hears nothing, and the claim's span is adopted wholesale: 5.06 s from where the line
    is sung. Under the arm a span too short to hold the line at `regenerate`'s floor is a truncated cue
    rather than a timing, so the repair is dropped and the refusal goes on the trail. The arm costs the
    unperturbed corpus row 16 of 1736 lines within ±500 ms and a gross line, which is why it is off."""
    got = align(
        tmp_path,
        monkeypatch,
        phrases=TRUNCATED,
        duration=TRUNCATED_DURATION,
        claims=[*truth(TRUNCATED)[:5], (33.0, None)],
        experiments=frozenset({"m5-adopt-floor"}),
    )
    why = got.verdict[4]
    assert got.verdict[3] == "structural", why
    line = got.line("morning light across the river")
    assert abs(line["start"] - 40.0) < 0.15, f"published {line['start']:.2f}s, sung 40.00s"
    assert all(word["score"] != 0.0 for word in line["words"]), "the claim's span was not adopted"
    assert "adopted" not in why
    assert "kept the measured timing of 1 line(s) whose claim span is too short to hold them" in why
    assert "[5]" in why.split("too short to hold them")[1]
    # R2's own note is absent BECAUSE the refusal emptied its repair: the stage re-decoded one line and
    # published none of it, and the trail says which line and why rather than counting a repair that stood.
    assert "disputed lines inside their claim windows" not in why
    assert "timing sources: 6 blind" in why


@pytest.mark.usefixtures("any_tempo")
def test_the_shipped_default_adopts_a_short_claim_span_over_a_decode_that_heard_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The SAME fixture on the shipped default (`m5-adopt-floor` off), so the cost of shipping it off is a
    number and not a shrug: the 1 s cue is adopted and the line publishes 5 s before it is sung.

    This is the trade §3.11's reject-if forced (W2 bench). The arm removes this error on a cue whose START is
    also wrong, and takes 16 corpus lines with it on cues whose start is RIGHT and whose end is merely
    missing — the truncated cue every caption track is full of. Adoption is flagged `low` and its words carry
    no score, which is the standing the line's timing actually has.
    """
    got = align(
        tmp_path,
        monkeypatch,
        phrases=TRUNCATED,
        duration=TRUNCATED_DURATION,
        claims=[*truth(TRUNCATED)[:5], (33.0, None)],
    )
    why = got.verdict[4]
    line = got.line("morning light across the river")
    assert line["start"] > 34.0, f"published {line['start']:.2f}s — the claim's 33.00 s span was not adopted"
    assert abs(line["start"] - 34.94) < 0.3, f"published {line['start']:.2f}s, the measured 34.94 s"
    assert all(word["score"] == 0.0 for word in line["words"]), "an adopted span carries no word scores"
    assert "1 adopted [5]" in why
    assert "kept the measured timing" not in why, "the floor is the arm, not the default"


#: THE OFF-CLOCK SHEET: lines 2 s long every 4 s, so a claim stamped 3 s LATE still overlaps the next line's
#: singing on the stem — which keeps the case away from R4 and on R1, the stage the adoption guard guards.
#: This is never-be-alone's `off3` shape in miniature.
OFF_CLOCK: list[Phrase] = [
    ("come and fly away", 5.0, 7.0),
    ("with me tonight", 9.0, 11.0),
    ("over the silver water", 13.0, 15.0),
    ("carry me home", 17.0, 19.0),
    ("stars are out", 21.0, 23.0),
    ("hold on to the night", 25.0, 27.0),
    ("morning light across the river", 29.0, 31.0),
    ("never let it go", 33.0, 35.0),
]
OFF_CLOCK_DURATION = 44.0

#: What the DECODE hears: every line out by a DIFFERENT amount, so no candidate map explains two more paired
#: lines than no-shift and `claimmap.consensus` declines — the exact hole review r1 found, where a sheet the
#: clock left alone still had its raw claim times adopted.
OFF_CLOCK_HEARD: list[Phrase] = [
    (text, start + shift, end + shift)
    for (text, start, end), shift in zip(OFF_CLOCK, (3.0, 0.5, 4.0, 1.0, 3.5, 0.0, 2.5, 1.5), strict=True)
]

#: How late the sheet is stamped. Past `reconcile.COARSE_TOLERANCE_SEC` (1.0 s), which is the guard's own
#: bound, and far enough that the claim windows sit on the wrong line.
OFF_CLOCK_LATE = 3.0


@pytest.mark.usefixtures("any_tempo")
def test_a_raw_claim_time_is_not_adopted_on_a_sheet_the_audio_says_is_seconds_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """R1's `off_clock` guard: a raw claim time is not adopted on a sheet the audio says is seconds off.

    The shape no other fixture presents: the claim clock DECLINED to map the sheet, the envelope says the
    claims are 3 s from the singing with a good correlation, and the blind decode relates nothing to
    them. Adoption exists for the opposite case — a claim that is right and a window decode that heard
    nothing — so here the window re-decode's own timing must stand. On the corpus this is never-be-alone
    under a displaced sheet: R1 adopted 38 of 44 raw claim times and published 3 s late (off3 gross
    0 -> 44). The note prints `ShiftFit`'s own sign, seconds to ADD, as `claimmap.consensus` reads it."""
    got = align(
        tmp_path,
        monkeypatch,
        phrases=OFF_CLOCK,
        duration=OFF_CLOCK_DURATION,
        claims=truth(OFF_CLOCK, OFF_CLOCK_LATE),
        decoder=misheard(
            sung_matrix(OFF_CLOCK_HEARD, DIC, OFF_CLOCK_DURATION), int(OFF_CLOCK_DURATION / FRAME_SEC)
        ),
    )
    why = got.verdict[4]
    assert got.verdict[3] == "unrelated", why
    assert "claims left on their own clock" in why, "the vote must decline, or the guard is not under test"
    assert "claims fit the audio better" in why, "R1 is the stage that offers the adoption"
    assert "did not adopt 8 claim timing(s)" in why, why
    assert "claim timings where the decode heard nothing" not in why, "a raw claim time was adopted anyway"
    assert f"the audio puts the singing {-OFF_CLOCK_LATE:+.2f}s from these claims" in why, (
        "the displacement is printed negated: a sheet stamped late reads as EARLY"
    )
    for text, _start, _end in OFF_CLOCK:
        words = got.line(text)["words"]
        assert all(word["score"] != 0.0 for word in words), f"{text!r}: an adopted span carries no scores"


#: The window rule's own song (W2 review r1). Sparse and long, so a window can be widened without touching
#: its neighbour unless the rule lets it: line 0's cue sits inside the pad (the zero clamp), line 3's cue has
#: no end, and what the DECODE hears for line 3 both starts before that cue and smears 15 s past it.
WINDOWED: list[Phrase] = [
    ("come and fly away", 0.0, 1.2),
    ("with me tonight", 10.0, 12.0),
    ("over the silver water", 20.0, 22.0),
    ("morning light across the river", 30.0, 33.0),
    ("stars are out", 40.0, 42.0),
    ("carry me home", 50.0, 52.0),
]
WINDOWED_DURATION = 60.0

#: What the decode hears: the first three lines displaced by 2-4 s (so the blind verdict is UNRELATED and the
#: claims win R1's envelope contest), line 3 starting 0.6 s before its cue and smeared to 45.0 s — the
#: 7-10 s smear this repo measures on tfr-chosen's credit line, past line 4's cue at 40.0.
WINDOWED_HEARD: list[Phrase] = [
    ("come and fly away", 3.0, 4.5),
    ("with me tonight", 14.0, 16.0),
    ("over the silver water", 24.0, 26.0),
    ("morning light across the river", 30.0, 45.0),
    ("stars are out", 46.0, 48.0),
    ("carry me home", 50.0, 52.0),
]

#: The LAST cue's own song: the truncated cue is the sheet's FINAL one, the cue that has no next onset to be
#: capped at and the one an LRC always leaves without an end. Its line is 26 alignable characters, so the
#: reader's defaulted 1.0 s cannot hold it and the hold-open fires; onsets 10 s apart give `typical_slot` 10.0.
LAST_CUE: list[Phrase] = [
    ("come and fly away", 0.0, 1.2),
    ("with me tonight", 10.0, 12.0),
    ("over the silver water", 20.0, 22.0),
    ("stars are out", 30.0, 32.0),
    ("carry me home", 40.0, 42.0),
    ("morning light across the river", 50.0, 53.0),
]
LAST_CUE_DURATION = 80.0

#: What the REAL matrix holds: the song, plus an UNSTAMPED outro repeat of the final line at 70-73 s — the
#: ad-lib a sheet does not stamp and an uncapped last-cue window reaches.
LAST_CUE_REPEATED: list[Phrase] = [*LAST_CUE, ("morning light across the river", 70.0, 73.0)]

#: What the GLOBAL decode hears: every line displaced by a DIFFERENT amount, so no candidate map reaches the
#: vote's margin and the claims stay on their own clock, and the final line started on its cue but smeared to
#: the end of the audio — the 7-10 s-and-worse smear an UNRELATED blind verdict is named for.
LAST_CUE_HEARD: list[Phrase] = [
    ("come and fly away", 3.0, 4.5),
    ("with me tonight", 14.0, 16.0),
    ("over the silver water", 25.0, 27.0),
    ("stars are out", 33.0, 35.0),
    ("carry me home", 46.0, 48.0),
    ("morning light across the river", 50.0, 78.0),
]


@pytest.mark.usefixtures("any_tempo")
def test_a_repair_window_widens_only_its_end_and_never_past_the_next_cue(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`claim_run`'s window: the end only, never past the next cue, and the left edge the clamp produced.

    Line 3's decode starts 0.6 s before its cue, so a two-sided union would pull the left edge back to
    29.0 s — but a cue's START is what a sheet asserts and only its END is missing, so the edge stays at
    `claim_start - _REPAIR_PAD_SEC`. The decode then smears line 3 five seconds past line 4's cue, and
    uncapped the window would be a single-line forced decode over the next line's whole slot. Line 0's
    pad runs past zero, which is why the edge tests read the RECORDED window rather than recomputing it.
    README, "The repair window's two caps, priced", carries what each cap bought."""
    from encore_worker.domain.lyrics import generate as gen

    real = gen.regenerate
    seen: dict[int, tuple[float, float]] = {}

    def spy(runs: Any, matrix: Any, **kw: Any) -> Any:
        for lines, window in runs:
            seen[lines[0].index] = window
        return real(runs, matrix, **kw)

    monkeypatch.setattr(gen, "regenerate", spy)
    got = align(
        tmp_path,
        monkeypatch,
        phrases=WINDOWED,
        duration=WINDOWED_DURATION,
        claims=[(0.4, 1.6), (10.0, 12.0), (20.0, 22.0), (30.6, None), (40.0, 42.0), (50.0, 52.0)],
        decoder=misheard(
            sung_matrix(WINDOWED_HEARD, DIC, WINDOWED_DURATION), int(WINDOWED_DURATION / FRAME_SEC)
        ),
    )
    why = got.verdict[4]
    assert "claims left on their own clock" in why, "the vote must abstain, or the cues move under the test"
    assert "claims fit the audio better" in why, "R1 is the stage under test"
    assert seen[3][0] == pytest.approx(29.6), "the END only: the blind onset 0.6 s earlier did not move it"
    assert seen[3][1] == pytest.approx(40.0), "capped at line 4's cue, not at the smear's 46.0"
    assert seen[0][0] == 0.0, "the pad ran past zero: the recorded edge is the clamped one"
    assert seen[0][1] == pytest.approx(2.6), "a cue that holds its line is not widened at all"


@pytest.mark.usefixtures("any_tempo")
def test_the_next_cue_a_repair_window_stops_at_is_the_next_one_in_time_not_in_line_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cue a repair window stops at is the next one in TIME, not in line order.

    `claim_onsets` is sorted and nothing pinned the sort: every other fixture stamps its lines in
    ascending order, where dict order agrees. This sheet is a caption track's shape instead — `parse_vtt`
    reads cues in file order and `clean_segments` neither sorts nor moves them — stamping line 1 at
    45.0 s and line 4 at 33.0 s. The truncated cue is line 3 at 30.6 s, so the padded window must stop at
    33.0; read in dict order it would stop at 45.0 and swallow line 4's cue whole."""
    from encore_worker.domain.lyrics import generate as gen

    real = gen.regenerate
    seen: dict[int, tuple[float, float]] = {}

    def spy(runs: Any, matrix: Any, **kw: Any) -> Any:
        for lines, window in runs:
            seen[lines[0].index] = window
        return real(runs, matrix, **kw)

    monkeypatch.setattr(gen, "regenerate", spy)
    got = align(
        tmp_path,
        monkeypatch,
        phrases=WINDOWED,
        duration=WINDOWED_DURATION,
        claims=[(0.4, 1.6), (45.0, 47.0), (20.0, 22.0), (30.6, None), (33.0, 35.0), (50.0, 52.0)],
        decoder=misheard(
            sung_matrix(WINDOWED_HEARD, DIC, WINDOWED_DURATION), int(WINDOWED_DURATION / FRAME_SEC)
        ),
    )
    why = got.verdict[4]
    assert "claims left on their own clock" in why, "the vote must abstain, or the cues move under the test"
    assert "claims fit the audio better" in why, "R1 is the stage under test"
    assert seen[3][1] == pytest.approx(33.0), "stopped at line 4's onset in TIME, not at line 1's 45.0"


@pytest.mark.usefixtures("any_tempo")
def test_the_last_cue_is_capped_on_the_sheets_own_pacing_and_not_left_open_to_the_audios_end(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The latest cue has no next claim to stop at, so it is capped on the sheet's own pacing.

    That is the one cue whose end is ALWAYS missing: `parse_lrc` gives an LRC's last line no end and the
    reader defaults it to start + 1.0 s. What a final line can swallow is not a following line but an
    unstamped outro repeat of its own words — sung here at 70-73 s against the stamped 50-53 s, and sung
    weakly there, because at full strength an exact Viterbi prefers the earlier take and a wide window
    looks harmless. Uncapped the window was (49.6, 78.7) and the re-decode published the line at 69.96 s;
    the sheet's median onset gap (10.0 s) stands in, so the window is (49.6, 61.6) instead."""
    from encore_worker.domain.lyrics import generate as gen

    real = gen.regenerate
    seen: dict[int, tuple[float, float]] = {}

    def spy(runs: Any, matrix: Any, **kw: Any) -> Any:
        for lines, window in runs:
            seen[lines[0].index] = window
        return real(runs, matrix, **kw)

    monkeypatch.setattr(gen, "regenerate", spy)
    got = align(
        tmp_path,
        monkeypatch,
        phrases=LAST_CUE,
        duration=LAST_CUE_DURATION,
        claims=[(0.4, 1.6), (10.0, 12.0), (20.0, 22.0), (30.0, 32.0), (40.0, 42.0), (50.6, None)],
        stem_matrix=weakly_sung(sung_matrix(LAST_CUE_REPEATED, DIC, LAST_CUE_DURATION), LAST_CUE[-1], 0.45),
        decoder=misheard(
            sung_matrix(LAST_CUE_HEARD, DIC, LAST_CUE_DURATION), int(LAST_CUE_DURATION / FRAME_SEC)
        ),
    )
    why = got.verdict[4]
    assert "claims left on their own clock" in why, "the vote must abstain, or the cues move under the test"
    assert "claims fit the audio better" in why, "R1 is the stage under test"
    assert seen[5][1] == pytest.approx(61.6), "the last cue is capped at start + typical_slot, not at 78.7"
    last = got.lines[-1]
    assert last["start"] == pytest.approx(50.6), "published on its own note, not on the 70 s repeat"
    assert seen[4][1] == pytest.approx(43.0), "a cue that holds its line is still not widened at all"


@pytest.mark.usefixtures("any_tempo")
def test_a_decode_stuck_on_a_window_edge_the_clamp_moved_is_still_stuck(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`edge_stuck` reads the RECORDED window, which is the only reading a zero-clamped edge survives.

    Line 0 is claimed at 0.4 s, so its window is clamped to 0.0 rather than -0.6 s and its decode lands
    on that edge. The recomputed formula asks `|0.0 - (-0.6)| < 0.08` and calls the line fine; the
    recorded one asks `|0.0 - 0.0|` and calls it stuck, so the human's cue is adopted over a decode that
    may have found nothing but the edge of the file. The price is real and conservative: a line genuinely
    sung from the first frame loses its measured timing to its claim, inside the first pad of a song."""
    got = align(
        tmp_path,
        monkeypatch,
        phrases=WINDOWED,
        duration=WINDOWED_DURATION,
        claims=[(0.4, 1.6), (10.0, 12.0), (20.0, 22.0), (30.6, None), (40.0, 42.0), (50.0, 52.0)],
        decoder=misheard(
            sung_matrix(WINDOWED_HEARD, DIC, WINDOWED_DURATION), int(WINDOWED_DURATION / FRAME_SEC)
        ),
    )
    why = got.verdict[4]
    assert "claims left on their own clock" in why and "claims fit the audio better" in why
    line = got.line("come and fly away")
    assert line["start"] == pytest.approx(0.4) and line["end"] == pytest.approx(1.6), "the cue was adopted"
    assert all(word["score"] == 0.0 for word in line["words"]), "an adopted span carries no word scores"
    assert line["confidence"] == "low", "agreement with evidence you copied is not agreement"
    assert "1 adopted [0]" in why, why


# ── M4: which lines a verdict sends to R2 ─────────────────────────────────────────────────────────────


@pytest.mark.usefixtures("any_tempo")
def test_a_loosely_timed_sheet_is_graded_and_nothing_is_re_decoded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """M4 as an action: a loosely timed sheet grades COARSE and nothing is re-decoded.

    Stamps wander by up to 475 ms, five of eight lines inside the 250 ms corroboration band. Before W2
    that was STRUCTURAL — any agreement under 1.0 was — and R2 re-decoded all three stragglers inside
    their jittered claim windows, which Numb measured as making timings worse (MAD 312 -> 563 ms). The
    verdict is now read off the residual DISTRIBUTION, and the dispute band stays the fixed phrase
    tolerance `reconcile.COARSE_TOLERANCE_SEC`, a spread-scaled one having measured worse."""
    wander = {0: 0.1, 1: -0.1, 2: 0.4, 3: -0.45, 4: 0.05, 5: 0.1, 6: -0.4, 7: 0.0}
    got = align(
        tmp_path,
        monkeypatch,
        phrases=UNIQUE,
        duration=UNIQUE_DURATION,
        claims=truth(UNIQUE, wander),
    )
    why = got.verdict[4]
    assert got.verdict[3] == "coarse", why
    assert "same performance, loosely timed — grade, not repair, bar 0 line(s)" in why
    assert "disputed lines inside their claim windows" not in why
    assert "timing sources: 8 blind" in why, "every line as the claim-free decode measured it"
    for line, (_text, start, _end) in zip(got.lines, UNIQUE, strict=True):
        assert abs(line["start"] - start) < 0.15, f"{line['text']!r} moved to {line['start']:.2f}s"


# ── TOO_FEW_PAIRS: what a 3-4-pair disagreement may and may not do (W2 review r2) ──────────────────────


@pytest.mark.usefixtures("any_tempo")
def test_too_few_pairs_never_arms_the_claim_window_repair(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`rc.TOO_FEW_PAIRS` must not arm R1, the widest repair in the step.

    Four disagreeing pairs are not evidence of anything, and before W2 such sheets read UNRELATED and
    armed every claimed line's re-decode — the floor meant to make the taxonomy careful routed them to
    its most sweeping branch. The sheet here passes every other test R1 applies (4 paired claims, 0% of
    them agreeing with a decode displaced 3.0-7.5 s, and claims that ARE the truth, so their envelope
    correlation is 1.00 against the blind decode's 0.24), so only the verdict can refuse it: every line
    must publish where the wrong decode put it, with no window in its provenance."""
    heard = [
        (text, start + 3.0 + 1.5 * i, end + 3.0 + 1.5 * i)
        for i, (text, start, end) in enumerate(SPARSE_SHORT)
    ]
    got = align(
        tmp_path,
        monkeypatch,
        phrases=SPARSE_SHORT,
        duration=48.0,
        claims=truth(SPARSE_SHORT),
        decoder=misheard(sung_matrix(heard, DIC, 48.0), int(48.0 / FRAME_SEC)),
    )
    state, why = got.verdict[3], got.verdict[4]
    assert state == "too-few-pairs", why
    assert "4 paired line(s), 5 needed to map" in why, "the clock abstains, so the raw claims reach R1's gate"
    assert "claims fit the audio better" not in why, "R1 must not run: its arbitration never happened"
    assert "inside their claim windows" not in why, "and neither R1 nor R2 re-decoded anything"
    assert "adopted" not in why, "nor adopted a claim span over a measured timing"
    assert "timing sources: 4 blind" in why, "every line as the claim-free decode measured it"
    # NOR MAY IT DECIDE WHICH DOCUMENT PUBLISHES: nothing was repaired, so the last reconcile IS this one
    # and `TOO_FEW_PAIRS` must map to None rather than to False. `policy.decide` rule 6 spends the terminal
    # LINE_SYNC rung on `claims_related is False`, and `improves` then lets that rung's document replace
    # this word document — 5677 word timings on the corpus. Mutating the branch to `verdict not in
    # rc.DISAGREE`, which reads False here, left the whole suite green.
    assert got.timed.report.claims_related is None, "a 3-4-pair disagreement established nothing either way"
    for line, (_text, start, _end) in zip(got.lines, heard, strict=True):
        assert abs(line["start"] - start) < 0.1, f"{line['text']!r} moved to {line['start']:.2f}s"


@pytest.mark.usefixtures("any_tempo")
def test_too_few_pairs_grades_every_line_low_and_that_is_a_cliff(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """What `TOO_FEW_PAIRS` does do: it lowers grades, and the cliff at the 2-pair end is deliberate.

    The same four-line sheet three ways, claims exact but for line 3 at +8 s. At 2 paired claims
    `NO_CLAIMS`: no verdict at all, the decode stands alone, 4 of 4 lines `high`. At 4, `TOO_FEW_PAIRS`:
    no per-line judgements and nothing armed, but it is in `rc.DISAGREE`, so every line grades `low` —
    0 of 4 `high`, document `medium`. At 5, `STRUCTURAL`: the four agreeing lines are corroborated and
    only the stray is `low`. Less evidence therefore reads as more confidence at the 2-pair end, which
    is the price: nothing at 4 pairs can tell this sheet from `hello`'s 3 lines 3-51 s out."""
    exact = truth(SPARSE_SHORT)
    stray = [*exact[:3], (exact[3][0] + 8.0, exact[3][1] + 8.0)]

    def where(name: str) -> Path:
        """One media directory per attempt: `align` writes a wav pair and a document into it."""
        (made := tmp_path / name).mkdir()
        return made

    four = align(where("four"), monkeypatch, phrases=SPARSE_SHORT, duration=48.0, claims=stray)
    assert four.verdict[3] == "too-few-pairs", four.verdict[4]
    # WHAT IT MAY NOT DO TO THE DOCUMENT CHOICE is held by the test above, where nothing is repaired so the
    # LAST reconcile is this verdict. HERE it is `True`, and that is not a contradiction: R4's mix witness
    # re-times the stray line into its claim window, so the last reconcile sees 4 of 4 lines agreeing and the
    # report says the claims ARE related — a fact about the published document, which is what that field is
    # (`report.TimingReport.claims_related`; the grades below still read the BLIND verdict).
    assert four.timed.report.claims_related is True, "the repaired document agrees with the sheet"
    assert [line["confidence"] for line in four.lines] == ["low"] * 4
    assert four.verdict[4].endswith("0/4 lines high")
    assert "3 blind" in four.verdict[4], "lines 0-2 are the blind decode's own, on their claims"
    assert all(abs(four.lines[i]["start"] - exact[i][0]) < 0.1 for i in range(3)), "and they are right"

    two = align(
        where("two"),
        monkeypatch,
        phrases=SPARSE_SHORT,
        duration=48.0,
        claims=[stray[0], stray[1], None, None],
    )
    assert two.verdict[3] == "no-claims" and "3 needed for any verdict" in two.verdict[4]
    assert [line["confidence"] for line in two.lines] == ["high"] * 4, "no verdict takes nothing away"

    five = truth(SPARSE)
    five[3] = (five[3][0] + 8.0, five[3][1] + 8.0)
    more = align(where("five"), monkeypatch, phrases=SPARSE, duration=48.0, claims=[*five[:5], None])
    assert more.verdict[3] == "structural", more.verdict[4]
    assert [line["confidence"] for line in more.lines].count("high") == 5, "only the stray is low"


# ── W4: which reconcile the CROSS-KIND comparison reads (`TimingReport.claims_related`) ────────────────


def test_the_report_relates_the_claims_by_the_LAST_reconcile_where_grading_reads_the_BLIND_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The report relates the claims by the LAST reconcile where grading reads the BLIND one.

    Grading asks whether a LINE is corroborated, so only the blind decode can answer it: a line
    re-decoded inside its claim window agrees with its claim by construction. `policy.decide`'s rule 6
    asks whether the document about to publish tells the same story as the sheet, and there an agreement
    the repairs produced is the answer rather than a contaminant. Both readings sit on one trail note.
    """
    spans = [(start, end) for _text, start, end in PHRASES]

    def where(name: str) -> Path:
        """One media directory per attempt: `align` writes a wav pair and a document into it."""
        (made := tmp_path / name).mkdir()
        return made

    # (a) OUR DECODE was wrong and the SHEET was right: the blind pass hears every line one span late, so
    # nothing relates it to the claims — and R1, which UNRELATED is what arms, re-decodes inside the claim
    # windows and finds each line where it is really sung. The published document agrees with the sheet.
    rescued = align(
        where("rescued"),
        monkeypatch,
        phrases=PHRASES,
        duration=DURATION,
        claims=truth(PHRASES),
        decoder=misheard(
            sung_matrix(
                [(text, *spans[(i + 1) % len(spans)]) for i, (text, _s, _e) in enumerate(PHRASES)],
                DIC,
                DURATION,
            ),
            int(DURATION / FRAME_SEC),
        ),
    )
    assert rescued.verdict[3] == "unrelated", "the BLIND verdict, which grading reads"
    assert "after repairs agree, 100% of 8 lines agree" in rescued.verdict[4]
    assert rescued.timed.report.claims_related is True, (
        "the repairs related the document to the sheet, so the sheet has nothing to add and "
        "`policy.decide` must not spend the LINE_SYNC rung on it"
    )

    # (b) The SHEET is the one nothing relates: its claims are scattered across the song, and the repairs
    # cannot make our timings agree with them (`_clamped` keeps the blind decode). This is the one shape the
    # rung is spent on — the word document could publish, and only here does the sheet get its turn.
    scattered = align(
        where("scattered"),
        monkeypatch,
        phrases=PHRASES,
        duration=DURATION,
        claims=[spans[(i + 3) % len(spans)] for i in range(len(spans))],
    )
    assert scattered.verdict[3] == "unrelated"
    assert "after repairs unrelated, 0% of 8 lines agree" in scattered.verdict[4]
    assert scattered.timed.report.claims_related is False
