"""Provenance through the repair ladder: who timed each line, and what that lets grading claim.

Three review findings, each pinned end to end through the real `time_text` on the CTC fixture
(`tests/ctc_fixture.py`, a slice-relative Viterbi frame-for-frame equal to torchaudio's kernel):

  H4  grading's corroboration comes from the BLIND decode against the claims. A line re-decoded inside
      its claim window lands on the claim by construction, so the ladder's re-reconcile counted the claim
      agreeing with itself (the review's exhibit: R4 lines parked at the pad's edge under offset claims,
      corroborated, `high` and wrong).
  L1  a line R4 timed on the MIX is not re-decoded on the stem by a later stage (repro s6), and the
      adoption test's reference median is the blind decode's, taken once (repro s5). Both are built and
      ship DEFAULT-OFF (`l1-mix-kept`, `l1-blind-median` in `Config.align_experiments`): each measured
      worse on real songs (never-be-alone; the numbers are at the arms in `_time_text_global`). The tests
      pin each arm's fix with it on, and the shipped behaviour with it off.
  M6  the never-sung rule does not bin a CLAIMED line the stem is silent in but the mix is not: R4, the
      mix witness, puts it back where the mix's acoustic model HEARS it (repro s7: a line the stem lost was
      deleted before R4 could hear it on the mix). Never as its claim's span, and never steering the rest
      of the ladder (review W1 r1: the mix envelope spared credits and headers the band made loud, and W1
      put back every one). Built and ships DEFAULT-OFF (`m6-mix-spare`): on the full corpus it still put
      back one header and one extra-verse line the mix's model heard the next line's speech under, which
      fails W1's unsung gates (the numbers are at the rule in `_time_text_global`). A line the stem itself
      sounds in is binned unless `m6-window-spare` is on. The tests pin each arm with it on, and the
      shipped default (v2's rule: binned) with it off.

EVIDENCE BY PATH. The aligner serves the stem's matrix and the mix's separately, and the wavs the envelope
reads are written separately too. That is what lets a test say which witness heard a line — a single
matrix for both is how "R4 decoded the stem" once passed the whole suite (review r1).
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

from encore_worker.domain.lyrics.generate import generate
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


def sung_wav(path: Path, phrases: Sequence[Phrase], duration: float, *, seed: int) -> str:
    """A tone under each phrase over a noise floor: what `activity.envelope` reads as singing."""
    signal = np.random.default_rng(seed).normal(0.0, 0.002, int(duration * RATE))
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
    claims: Sequence[tuple[float, float] | None],
    stem_sings: Sequence[Phrase] | None = None,
    stem_matrix: Matrix | None = None,
    extra_text: Sequence[str] = (),
    decoder: Decode = ctc_viterbi,
    experiments: frozenset[str] = frozenset(),
) -> Outcome:
    """One `time_text` attempt on a song whose MIX sings `phrases` and whose STEM sings `stem_sings`.

    The stem's wav (what the envelope hears) sings `stem_sings`; its matrix (what the decoder hears) is
    `stem_matrix`, the same phrases by default. `claims` is one (start, end) or None per line of the text,
    which is `phrases` then `extra_text`.
    """
    from encore_worker.adapters import ml

    monkeypatch.setattr(ml, "forced_align_decoder", decoder)
    on_stem = list(phrases if stem_sings is None else stem_sings)
    stem = sung_wav(tmp_path / "vocals.wav", on_stem, duration, seed=0)
    mix = sung_wav(tmp_path / "mix.wav", phrases, duration, seed=1)
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
        {"text": text, **({"start": claim[0], "end": claim[1]} if claim is not None else {})}
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


def test_lines_the_mix_timed_inside_offset_claim_windows_are_not_graded_high(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The review's H4 exhibit. An LRC 2.5 s late over sparse vocals: every claim window sits on stem
    silence, so R4 re-decodes every line on the mix inside [claim - 1 s, end + 1 s]. The window holds only
    the line's tail, the forced path parks the rest at the window's edge, and every line comes out at the
    same residual (-1 s, the pad) — which the ladder's re-reconcile reads as one coherent offset, every
    line corroborated. The old grading published all six `high`, 1.5 s late.

    The blind decode had them right, and it is the only independent witness: the blind verdict is OFFSET
    at -2.5 s and corroborates every line, but a repaired line stays `high` only if the repair kept that
    corroborated position. None did, so none is. (The timings themselves are the claim clock's job, W2.)
    """
    got = align(tmp_path, monkeypatch, phrases=SPARSE, duration=48.0, claims=truth(SPARSE, 2.5))
    assert got.aligner.asked[1:] == [str(tmp_path / "mix.wav")], "R4 decoded the mix"
    for line, (text, start, _end) in zip(got.lines, SPARSE, strict=True):
        assert line["text"] == text
        assert line["start"] - start > 0.5, f"{text!r}: the exhibit needs R4 to have moved it off"
        assert line["confidence"] == "low", f"{text!r} is {line['start'] - start:+.2f} s off and graded high"
    state, why = got.verdict[3], got.verdict[4]
    assert state == "offset", "the trail's verdict is the blind one, the one grading read"
    assert "claims are uniformly 2.54s late" in why, "2.5 s, plus the decode's 40 ms onset lead"
    assert "after repairs" in why and "(steers the repairs, never the grade)" in why
    assert "timing sources: 6 mix [0] [1] [2] [3] [4] [5]" in why
    assert why.endswith("0/6 lines high")


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


def s6(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, experiments: frozenset[str]) -> Outcome:
    """Review repro s6: the stem lost line 5, and its claim runs 0.4 s late."""
    return align(
        tmp_path,
        monkeypatch,
        phrases=PHRASES,
        duration=DURATION,
        claims=truth(PHRASES, {5: 0.4}),
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
    assert "1 mix [5]" in why and "adopted" not in why
    assert "disputed lines inside their claim windows" not in why


def test_by_default_r2_may_re_decode_a_line_r4_timed_on_the_mix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The shipped default (`l1-mix-kept` off, measured better on never-be-alone): R2 re-decodes the mix's
    line on the stem, hears nothing there, and adopts the jittered claim — repro s6's harm, kept."""
    got = s6(tmp_path, monkeypatch, frozenset())
    line = got.lines[5]
    assert abs(line["start"] - 25.9) < 1e-6 and all(word["score"] == 0.0 for word in line["words"])
    assert line["confidence"] == "low"
    assert "re-decoded 1 of 1 disputed lines inside their claim windows" in got.verdict[4]
    assert "1 adopted [5]" in got.verdict[4]


def quiet_and_lost(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, experiments: frozenset[str]) -> Outcome:
    """The stem lost the second half (lines 4-7), and line 1 is sung quietly with a claim 0.4 s late."""
    on_stem = [p for i, p in enumerate(PHRASES) if i < 4]
    return align(
        tmp_path,
        monkeypatch,
        phrases=PHRASES,
        duration=DURATION,
        claims=truth(PHRASES, {1: 0.4}),
        stem_sings=on_stem,
        stem_matrix=weakly_sung(sung_matrix(on_stem, DIC, DURATION), PHRASES[1], hit=0.35),
        experiments=experiments,
    )


def test_with_l1_blind_median_a_quiet_heard_line_is_not_adopted_over(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review L1's median. Line 1 is heard where it is sung, but scores well below the loud lines. Once R4
    has restored lines 4-7 from the mix, the verdict disputes line 1 (its claim is 0.4 s late) and R2
    re-decodes it in its window, where it is heard again at 8.0 s.

    Is that decode "unheard"? Against the BLIND decode's median — four loud lines and four the stem could
    not place, -2.8 — it sits far above the adoption gap and is kept (`l1-blind-median`). Recomputed at R2
    over the series as repaired so far (the default), the four mix lines stood in for the lines they
    replaced, the median rose to the loud lines' -0.1, and the quiet line fell below it and adopted its
    claim: 8.4 s, the claim's own 0.4 s error. The same shape as repro s5, where adopted lines' 0.0
    sentinels lifted the median. (With `m6-mix-spare` on as well: by default the never-sung rule bins the
    stem's two smeared closing lines, lines 6-7, and R4 restores only 4-5 — the median still keeps the
    quiet decode, but four mix lines is the shape this was measured on.)"""
    got = quiet_and_lost(tmp_path, monkeypatch, frozenset({"l1-blind-median", "m6-mix-spare"}))
    line = got.lines[1]
    assert line["text"] == "with me tonight"
    assert abs(line["start"] - 8.0) < 0.1, f"published at {line['start']:.2f} s, the claim is 8.40 s"
    assert all(word["score"] != 0.0 for word in line["words"]), "the quiet decode was adopted over"
    why = got.verdict[4]
    assert "re-decoded 1 of 1 disputed lines inside their claim windows" in why
    assert "1 window [1]" in why and "4 mix [4] [5] [6] [7]" in why
    assert "adopted" not in why


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
    assert "1 adopted [1]" in got.verdict[4]
    assert "scored 0.5 below the median line score: -0.11 (R2)" in got.verdict[4]


# ── M6 (`m6-mix-spare`): a claimed line is binned only when BOTH envelopes are silent over its claim window
#
# The never-sung rule's decode signals need a line the decode SMEARED over silence, which is what the real
# kernel does with a line the emissions do not contain (the calibration: tfr-chosen's credit, 1.0 chars/s).
# The exact Viterbi instead packs such a line into its neighbour's last frames, so these rigs give the
# stem's matrix a faint trace of the line on silent frames (`weakly_sung` at 0.05): the decode then parks
# it there, 3.0 below the song's score, exactly as the review's s7 decoder scripted it.

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
    assert "all 7 paired lines agree" in why, "the blind verdict, over the decode without it"
    assert "re-decoded 1 of 1 spared never-sung lines inside their claim windows on the stem" in why
    assert "timing sources: 7 blind, 1 window [3]" in why
