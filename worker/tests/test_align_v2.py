"""The global-decode wiring in `time_text`: the decline ladder and the grading policy.

Hermetic — the aligner, decoder and audio are all fakes. The real-audio acceptance run lives in the
benchmark (`bench.py --global`) and was verified through this exact code path: an UNTIMED sheet moved from
1.3% to 70.7% of lines within ±250 ms, and a +1.0 s LRC was diagnosed `structural` with 64/75 lines
corroborated and `offset −0.88s` on the trail.
"""

from __future__ import annotations

import asyncio
import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf

from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics.policy import Tier
from encore_worker.host.config import Config
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.records import AudioRef, JobRef, TextRef, TimeRequest

RATE = 16000
DIC = {ch: i + 1 for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz'")}

#: Eight phrases the fake song "sings" — audio, emissions and truth all derive from this one table.
PHRASES = [
    ("come and fly away", 5.0, 7.0),
    ("with me tonight", 8.0, 10.0),
    ("over the silver water", 12.0, 14.5),
    ("carry me home", 16.0, 18.0),
    ("come and fly away", 22.0, 24.0),  # a REPEAT — the F2 case
    ("stars are out", 25.5, 27.5),
    ("morning light across the river", 30.0, 33.0),
    ("come and fly away", 35.0, 37.0),  # another repeat
]
DURATION = 40.0


@dataclass(frozen=True)
class FakeEmissions:
    log_probs: object
    frame_sec: float
    dictionary: dict[str, int]

    @property
    def frames(self) -> int:
        return len(self.log_probs)  # type: ignore[arg-type]


class FakeAligner:
    """An `Aligner` whose `emissions` places every phrase's chars evenly inside its true span."""

    def __init__(self) -> None:
        self.align_calls = 0

    def emissions(self, _path: str, _language: str) -> FakeEmissions:
        return FakeEmissions(log_probs=[0.0] * int(DURATION / 0.02), frame_sec=0.02, dictionary=DIC)

    def align(self, search: Sequence[Segment], audio_path: str, language: str) -> tuple[Segment, ...]:
        """The v1 windowed path. Counted, so a test can assert v2 did NOT fall back."""
        self.align_calls += 1
        return tuple(
            {
                "text": s["text"],
                "start": s.get("start", 0.0),
                "end": s.get("end", 0.0),
                "words": [
                    {"word": w, "start": s.get("start", 0.0), "end": s.get("end", 0.0)}
                    for w in str(s["text"]).split()
                ],
            }
            for s in search
        )


def scripted_decoder(log_probs: Sequence[float], targets: Sequence[int]) -> tuple[list[int], list[float]]:
    """Places target chars from PHRASES' true spans — a decode that is 'right' by construction."""
    labels = [0] * len(log_probs)
    scores = [-0.4] * len(log_probs)
    # Walk targets in order; each phrase's chars spread across its span.
    spans = []
    for text, start, end in PHRASES:
        chars = [c for w in text.split() for c in w if DIC.get(c)]
        step = (end - start) / max(len(chars), 1)
        for i, _c in enumerate(chars):
            spans.append((start + i * step, start + (i + 0.7) * step))
    assert len(spans) == len(targets), f"{len(spans)} spans vs {len(targets)} targets"
    for (start, end), token in zip(spans, targets, strict=True):
        first, last = int(start / 0.02), max(int(end / 0.02), int(start / 0.02) + 1)
        for f in range(first, min(last, len(labels))):
            labels[f] = token
    return labels, scores


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


Rig = tuple[AlignStepsImpl, FakeAligner, TrailSpy, JobRef, AudioRef, Path]


@pytest.fixture()
def rig(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Rig:
    """A media dir, a sung wav matching PHRASES, and an impl with v2 on."""
    from encore_worker.adapters import ml

    monkeypatch.setattr(ml, "forced_align_decoder", scripted_decoder)

    signal = np.random.default_rng(0).normal(0.0, 0.002, int(DURATION * RATE))
    for _text, start, end in PHRASES:
        t = np.arange(int((end - start) * RATE)) / RATE
        a, b = int(start * RATE), int(start * RATE) + len(t)
        signal[a:b] += 0.3 * np.sin(2 * math.pi * 220.0 * t)
    wav = tmp_path / "vocals.wav"
    sf.write(wav, signal, RATE)

    aligner = FakeAligner()
    trail = TrailSpy()
    impl = AlignStepsImpl(
        config=Config(),
        adapters=Adapters(aligner=aligner),
        reporter=trail,
    )
    job = JobRef(job_id="j1", media_id="m1", media_dir=str(tmp_path), source_uri=None, params={})
    audio = AudioRef(path=str(wav), vocals_path=str(wav), duration_sec=DURATION)
    return impl, aligner, trail, job, audio, tmp_path


def request(job: JobRef, audio: AudioRef, *, timed: bool, offset: float = 0.0) -> TimeRequest:
    segments = tuple(
        {"text": text, **({"start": start + offset, "end": end + offset} if timed else {})}
        for text, start, end in PHRASES
    )
    text = TextRef(
        tier=Tier.CANDIDATE,
        label="test",
        segments=segments,
        timing="line" if timed else None,
    )
    return TimeRequest(job=job, text=text, audio=audio, language="en")


def doc_of(tmp_path: Path, timed: Any) -> dict[str, Any]:
    doc: dict[str, Any] = json.loads((tmp_path / timed.ref).read_text())
    return doc


# ── the headline behaviours ──────────────────────────────────────────────────────────────────────


def test_an_untimed_sheet_is_word_timed_without_the_windowed_aligner(rig: Rig) -> None:
    """The 1.3% -> 70.7% case: v2 never calls `align`, so the windowed path's spread_over floor is gone."""
    impl, aligner, _trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=False)))
    assert timed is not None and timed.timing == "word"
    assert aligner.align_calls == 0, "v2 must not have fallen back to the windowed path"
    doc = doc_of(tmp, timed)
    onsets = {line["text"]: line["start"] for line in doc["lines"]}
    assert abs(onsets["with me tonight"] - 8.0) < 0.3


def test_repeated_lines_are_low_confidence_when_no_claims_anchor_them(rig: Rig) -> None:
    """F2's consequence: a monotonic decode can bind a repeat to the wrong occurrence, and without claims
    nothing can vouch for which — so every repeated-text line degrades, unique lines stay high."""
    impl, _aligner, _trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=False)))
    doc = doc_of(tmp, timed)
    by_text: dict[str, list[str]] = {}
    for line in doc["lines"]:
        by_text.setdefault(line["text"], []).append(line["confidence"])
    assert all(c == "low" for c in by_text["come and fly away"])
    assert by_text["with me tonight"] == ["high"]


def test_corroborating_claims_raise_repeats_to_high(rig: Rig) -> None:
    """The claims are the occurrence-anchor: an LRC agreeing line-for-line vouches for WHICH chorus each
    repeat is, so the F2 degradation lifts."""
    impl, _aligner, _trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert timed is not None
    doc = doc_of(tmp, timed)
    assert all(line["confidence"] == "high" for line in doc["lines"])
    assert timed.confidence == "high"


def test_an_offset_lrc_is_diagnosed_not_obeyed(rig: Rig) -> None:
    """The design's whole point, as wiring: claims 1 s late produce the SAME timings as no claims at all —
    they grade, they never move anything — and the trail records the diagnosis with its numbers."""
    impl, _aligner, trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=True, offset=1.0)))
    doc = doc_of(tmp, timed)
    onsets = {line["text"]: line["start"] for line in doc["lines"]}
    assert abs(onsets["with me tonight"] - 8.0) < 0.3, "claims must not drag the timing"
    verdicts = [s for s in trail.states if s[1] == "align-global"]
    assert verdicts and verdicts[-1][3] in ("offset", "structural", "drift", "agree")
    assert "-1.0" in verdicts[-1][4] or "1.0" in verdicts[-1][4], "the offset's size belongs on the trail"


def test_syllables_ride_along_in_the_published_document(rig: Rig) -> None:
    impl, _aligner, _trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=False)))
    doc = doc_of(tmp, timed)
    syllabled = [w for line in doc["lines"] for w in line["words"] if "syllables" in w]
    assert syllabled, "multi-syllable words must carry spans"
    for w in syllabled:
        for s in w["syllables"]:
            assert w["start"] - 1e-6 <= s["start"] <= s["end"] <= w["end"] + 1e-6


# ── refusals and repairs ─────────────────────────────────────────────────────────────────────────


def test_an_aligner_without_emissions_means_the_windowed_path_runs(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The compatibility decline: an aligner that cannot produce an emission matrix (a language whisperx
    has no CTC dictionary model for) gets the windowed path, not a failure."""
    impl, aligner, _trail, job, audio, _tmp = rig
    monkeypatch.delattr(FakeAligner, "emissions")
    asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert aligner.align_calls == 1


def test_the_global_report_carries_no_residual_so_reshift_is_never_offered(rig: Rig) -> None:
    """reconcile's fitted offset describes THE CLAIM — our timings never moved to match it. Feeding it to
    `measure` would let `decide` offer RESHIFT, a knob that re-places input timings this engine never
    used; the retry would re-run an identical decode. The offset reaches the trail via the verdict note."""
    impl, _aligner, _trail, job, audio, _tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=True, offset=1.0)))
    assert timed is not None
    assert timed.report.residual_sec is None


def test_a_failing_envelope_gate_fails_the_attempt_rather_than_publishing(rig: Rig, tmp_path: Path) -> None:
    """Wrong text — or a garbage decode — must not be published just because it decoded. Silence in place
    of the sung audio makes the envelope refuse; the attempt fails (the verify ladder moves to another
    knob or text) and NOTHING falls back to a different engine."""
    impl, aligner, trail, job, _audio, _tmp = rig
    silent = tmp_path / "silence.wav"
    sf.write(silent, np.zeros(int(DURATION * RATE)), RATE)
    audio = AudioRef(path=str(silent), vocals_path=str(silent), duration_sec=DURATION)
    timed = asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert timed is None
    assert aligner.align_calls == 0, "no windowed fallback: the refusal is the outcome"
    declines = [s for s in trail.states if s[1] == "align-global" and s[3] == "declined"]
    assert declines, "the refusal must be on the trail, or it is indistinguishable from never running"


def test_a_raising_decode_fails_the_attempt_with_a_trail_note(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    from encore_worker.adapters import ml

    def explode(*_a: object, **_k: object) -> tuple[list[int], list[float]]:
        raise RuntimeError("kernel gone (torchaudio 2.9?)")

    monkeypatch.setattr(ml, "forced_align_decoder", explode)
    impl, aligner, trail, job, audio, _tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert timed is None and aligner.align_calls == 0
    declines = [s for s in trail.states if s[1] == "align-global" and s[3] == "declined"]
    assert declines and "RuntimeError" in declines[-1][4]


def test_line_sync_knob_bypasses_the_global_engine_entirely(rig: Rig) -> None:
    """LINE_SYNC is a terminal knob publishing the text's own timings; generating word timings for it
    would be answering a question nobody asked."""
    from encore_worker.domain.lyrics.policy import Knob

    impl, aligner, _trail, job, audio, tmp = rig
    req = request(job, audio, timed=True)
    req = TimeRequest(
        job=req.job, text=req.text, audio=req.audio, language="en", knobs=frozenset({Knob.LINE_SYNC})
    )
    timed = asyncio.run(impl.time_text(req))
    assert timed is not None and timed.timing == "line"
    assert aligner.align_calls == 0


def test_a_weakly_correlated_but_zero_lag_fit_is_accepted(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> None:
    """The false-decline found LIVE: a sparse-singing song scored r=0.31 at fit −0.02 s — right timings the
    flat 0.40 floor refused. Tier 2 admits weak correlation ONLY at near-zero lag, where both measured
    wrong-song fits (+1.64 s, −7.66 s) cannot follow."""
    from encore_worker.domain.audio import activity

    monkeypatch.setattr(
        activity,
        "fit_sheet_to_audio",
        lambda *_a, **_k: activity.ShiftFit(seconds=-0.02, correlation=0.31),
    )
    impl, aligner, _trail, job, audio, _tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=False)))
    assert timed is not None and timed.timing == "word"
    assert aligner.align_calls == 0


def test_the_same_weak_correlation_at_a_real_lag_still_refuses(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    from encore_worker.domain.audio import activity

    monkeypatch.setattr(
        activity,
        "fit_sheet_to_audio",
        lambda *_a, **_k: activity.ShiftFit(seconds=1.64, correlation=0.31),
    )
    impl, aligner, trail, job, audio, _tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=False)))
    assert timed is None and aligner.align_calls == 0
    declines = [s for s in trail.states if s[1] == "align-global" and s[3] == "declined"]
    assert declines and "0.31" in declines[-1][4], "the refusal must carry its numbers"


def test_when_claims_describe_the_audio_better_they_become_the_repair_anchors(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE HUMILITY CASE, found live: authored captions for the exact video came back UNRELATED — because
    OUR decode had scattered on repeat-heavy text, not because the claims were wrong. The audio arbitrates
    (whichever series' envelope matches actual singing wins), and the winning claims become ANCHORS: every
    claimed line is re-decoded inside its claim window on the same emission matrix — no other engine runs.
    """

    def window_decoder(log_probs: Sequence[float], targets: Sequence[int]) -> tuple[list[int], list[float]]:
        # Spreads targets over the middle of WHATEVER slice it is given: the GLOBAL decode therefore
        # scatters lines across the whole song (wrong), while a claim-window re-decode necessarily lands
        # inside the window (right, by anchor) — the shape of a real misbound repeat-heavy decode.
        labels = [0] * len(log_probs)
        scores = [-0.4] * len(log_probs)
        low, high = int(0.2 * len(log_probs)), int(0.9 * len(log_probs))
        per = (high - low) / max(len(targets), 1)
        for i, token in enumerate(targets):
            first = low + int(i * per)
            last = max(low + int(i * per + 0.7 * per), first + 1)
            for f in range(first, min(last, len(labels))):
                labels[f] = token
        return labels, scores

    from encore_worker.adapters import ml

    monkeypatch.setattr(ml, "forced_align_decoder", window_decoder)
    impl, aligner, trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert aligner.align_calls == 0, "repair happens in place; no other engine runs"
    assert timed is not None and timed.timing == "word"
    doc = doc_of(tmp, timed)
    for line, (text, start, _end) in zip(doc["lines"], PHRASES, strict=True):
        assert line["text"] == text
        assert abs(line["start"] - start) <= 2.0, (
            f"{text!r} at {line['start']:.2f}s was not pulled into its claim window (claim {start:.1f}s)"
        )
    notes = [s for s in trail.states if s[1] == "align-global"]
    assert notes and "claim windows" in notes[-1][4], "the repair must be legible on the trail"


def test_a_line_the_decode_cannot_hear_adopts_the_claim_timing(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """tfr-chosen's outro, hermetically: chopped vocals the captions time but the model cannot recognise.
    The global decode misplaces one claimed line; the R2 window re-decode then sticks to the window's left
    edge (it heard nothing), and the line SURRENDERS to the claim's own timing — words interpolated,
    confidence `low`, the adoption named on the trail."""
    full_frames = int(DURATION / 0.02)

    def deaf_in_windows(log_probs: Sequence[float], targets: Sequence[int]) -> tuple[list[int], list[float]]:
        if len(log_probs) == full_frames:
            # The global pass: right everywhere except line 3, displaced +8 s — a STRUCTURAL dispute.
            labels = [0] * len(log_probs)
            scores = [-0.4] * len(log_probs)
            spans = []
            for line_index, (text, start, end) in enumerate(PHRASES):
                displaced = start + (8.0 if line_index == 3 else 0.0)
                chars = [c for w in text.split() for c in w if DIC.get(c)]
                step = (end - start) / max(len(chars), 1)
                for i, _c in enumerate(chars):
                    spans.append((displaced + i * step, displaced + (i + 0.7) * step))
            for (start, end), token in zip(spans, targets, strict=True):
                first, last = int(start / 0.02), max(int(end / 0.02), int(start / 0.02) + 1)
                for f in range(first, min(last, len(labels))):
                    labels[f] = token
            return labels, scores
        # A repair slice: every char collapses to the slice's left edge — the decode heard nothing.
        labels = [0] * len(log_probs)
        scores = [-0.4] * len(log_probs)
        for i, token in enumerate(targets):
            for f in range(i * 2, min(i * 2 + 1, len(labels))):
                labels[f] = token
        return labels, scores

    from encore_worker.adapters import ml

    monkeypatch.setattr(ml, "forced_align_decoder", deaf_in_windows)
    impl, aligner, trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert timed is not None and aligner.align_calls == 0
    doc = doc_of(tmp, timed)
    line = doc["lines"][3]
    assert line["text"] == "carry me home"
    assert abs(line["start"] - 16.0) < 0.05 and abs(line["end"] - 18.0) < 0.05, "the claim's span, adopted"
    assert line["confidence"] == "low", "an adopted line echoes the claim; echoes do not corroborate"
    for word in line["words"]:
        assert 16.0 - 1e-6 <= word["start"] <= word["end"] <= 18.0 + 1e-6
    notes = [s for s in trail.states if s[1] == "align-global"]
    assert notes and "adopted" in notes[-1][4] and "heard nothing" in notes[-1][4]


def test_a_never_sung_caption_is_dropped_and_the_rest_redecoded(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """tfr-chosen's uploader-credit caption, hermetically: a line that is NOT in the audio scores far
    below the song's norm, sits on silence, and (live) smears far below singing tempo. It is dropped and
    the remaining text RE-DECODED — forced monotonically through emissions that do not contain it, a
    never-sung line steals its neighbours' frames (measured: gross 14 -> 11 on the re-decode alone).
    The rate threshold is calibrated on real songs; this pins the mechanism, so it is relaxed here."""
    from encore_worker.steps import align_steps as steps_module

    monkeypatch.setattr(steps_module, "_NEVER_SUNG_RATE", 1000.0)

    credit = "thanks for watching everyone"
    credit_chars = len([c for w in credit.split() for c in w if DIC.get(c)])
    phrase_chars = sum(1 for text, _s, _e in PHRASES for w in text.split() for c in w if DIC.get(c))

    def decoder_with_credit(
        log_probs: Sequence[float], targets: Sequence[int]
    ) -> tuple[list[int], list[float]]:
        labels, scores = scripted_decoder(log_probs, list(targets)[:phrase_chars])
        if len(targets) > phrase_chars:  # first round: the credit line smeared onto trailing silence
            step = 1.4 / credit_chars
            for i, token in enumerate(targets[phrase_chars:]):
                first = int((38.5 + i * step) / 0.02)
                for f in range(first, min(first + 2, len(labels))):
                    labels[f] = token
                    scores[f] = -5.0
        return labels, scores

    from encore_worker.adapters import ml

    monkeypatch.setattr(ml, "forced_align_decoder", decoder_with_credit)
    impl, aligner, trail, job, audio, tmp = rig
    segments = tuple({"text": text} for text, _s, _e in PHRASES) + ({"text": credit},)
    text = TextRef(tier=Tier.CANDIDATE, label="test", segments=segments, timing=None)
    timed = asyncio.run(impl.time_text(TimeRequest(job=job, text=text, audio=audio, language="en")))
    assert timed is not None and aligner.align_calls == 0
    doc = doc_of(tmp, timed)
    assert [line["text"] for line in doc["lines"]] == [text for text, _s, _e in PHRASES]
    notes = [s for s in trail.states if s[1] == "align-global"]
    assert notes and "never-sung" in notes[-1][4]


def test_clamped_refits_repaired_lines_without_touching_trusted_ones() -> None:
    """The live degradation: a repaired line spilling over its neighbour reads as out-of-order words and
    `decide` throws the whole document away. Clamping re-fits ONLY repaired lines into the free gap —
    a trusted line's overlap is a measurement and must survive."""
    from encore_worker.domain.lyrics.generate import Generated, Line, Word
    from encore_worker.steps.align_steps import _clamped

    def line(index: int, start: float, end: float) -> Line:
        return Line(
            text=f"line {index}",
            start=start,
            end=end,
            words=(
                Word(word="a", start=start, end=(start + end) / 2, score=-0.4),
                Word(word="b", start=(start + end) / 2, end=end, score=-0.4),
            ),
            score=-0.4,
            index=index,
        )

    trusted, spilled, following = line(0, 5.0, 8.0), line(1, 7.0, 12.0), line(2, 11.0, 14.0)
    got = _clamped(Generated(lines=(trusted, spilled, following), language="en"), repaired={1})
    kept, fixed, after = got.lines
    assert (kept.start, kept.end) == (5.0, 8.0), "trusted lines never move"
    assert (after.start, after.end) == (11.0, 14.0)
    assert fixed.start >= kept.end - 1e-9 and fixed.end <= after.start + 1e-9
    for word in fixed.words:
        assert fixed.start - 1e-9 <= word.start <= word.end <= fixed.end + 1e-9
    assert fixed.words[0].start < fixed.words[1].start, "internal order survives the refit"


def test_a_stem_invisible_line_is_re_decoded_against_the_mix(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """tfr-chosen's outro, hermetically: the vocals stem falls silent while the mix still carries the
    singing. The stem decode has no evidence for the line so pins it near the last vocal frame; R4
    computes a SECOND emissions on the mix and re-decodes just that line inside its claim window.
    Measured on real audio: -45 to -54 s errors -> under 1 s. Here the stem produces one wrongly-placed
    line, and the same aligner given a MIX-flagged path places it correctly."""
    from encore_worker.adapters import ml

    impl, aligner, trail, job, audio, tmp = rig
    # Rebuild the stem WITHOUT singing under line 5 (this is what a demucs stem does on effects-heavy
    # sections). The MIX carries singing everywhere. The step now sees line 5 land on stem-silence at
    # audit time, and the R4 branch re-decodes it against the mix.
    stem_signal = np.random.default_rng(0).normal(0.0, 0.002, int(DURATION * RATE))
    for line_index, (_text, start, end) in enumerate(PHRASES):
        if line_index == 5:
            continue
        t = np.arange(int((end - start) * RATE)) / RATE
        a, b = int(start * RATE), int(start * RATE) + len(t)
        stem_signal[a:b] += 0.3 * np.sin(2 * math.pi * 220.0 * t)
    sf.write(audio.vocals_path, stem_signal, RATE)

    mix_wav = tmp_path / "mix.wav"
    mix_signal = np.random.default_rng(1).normal(0.0, 0.002, int(DURATION * RATE))
    for _text, start, end in PHRASES:
        t = np.arange(int((end - start) * RATE)) / RATE
        a, b = int(start * RATE), int(start * RATE) + len(t)
        mix_signal[a:b] += 0.3 * np.sin(2 * math.pi * 220.0 * t)
    sf.write(mix_wav, mix_signal, RATE)
    audio = AudioRef(path=str(mix_wav), vocals_path=audio.vocals_path, duration_sec=DURATION)

    # STEM decoder scatters line 5 far from its claim (a stem-silent line the decode had to place
    # somewhere); MIX decoder places it correctly. `emissions` is called TWICE — once per audio path.
    def emissions_by_path(path: str, _lang: str) -> FakeEmissions:
        return FakeEmissions(log_probs=[0.0] * int(DURATION / 0.02), frame_sec=0.02, dictionary=DIC)

    monkeypatch.setattr(FakeAligner, "emissions", staticmethod(emissions_by_path))

    def decoder_by_call(log_probs: Sequence[float], targets: Sequence[int]) -> tuple[list[int], list[float]]:
        """Places every phrase at its correct time (global pass) or slice-relative (window pass)."""
        labels, scores = [0] * len(log_probs), [-0.4] * len(log_probs)
        global_count = sum(1 for text, _s, _e in PHRASES for w in text.split() for c in w if DIC.get(c))
        if len(targets) < global_count:
            # A window re-decode: put each char one frame at the slice start (line 5's mix window).
            for i, token in enumerate(targets):
                for f in range(i * 2, min(i * 2 + 1, len(labels))):
                    labels[f] = token
            return labels, scores
        for _line_index, (text, start, end) in enumerate(PHRASES):
            chars = [c for w in text.split() for c in w if DIC.get(c)]
            step = (end - start) / max(len(chars), 1)
            for i, ch in enumerate(chars):
                token = DIC.get(ch, 0)
                if not token:
                    continue
                f0 = int((start + i * step) / 0.02)
                for f in range(f0, min(f0 + 3, len(labels))):
                    labels[f] = token
        return labels, scores

    monkeypatch.setattr(ml, "forced_align_decoder", decoder_by_call)
    timed = asyncio.run(impl.time_text(TimeRequest(
        job=job, text=TextRef(tier=Tier.CANDIDATE, label="test", timing="line",
                              segments=tuple({"text": t, "start": s, "end": e} for t, s, e in PHRASES)),
        audio=audio, language="en",
    )))
    assert timed is not None and aligner.align_calls == 0
    doc = doc_of(tmp, timed)
    line5 = next(line for line in doc["lines"] if line["text"] == PHRASES[5][0])
    assert abs(line5["start"] - PHRASES[5][1]) < 2.0, (
        f"stem-invisible line still at {line5['start']:.2f}s (claim {PHRASES[5][1]:.2f}s)"
    )
    notes = [s for s in trail.states if s[1] == "align-global"]
    assert notes and "stem-invisible" in notes[-1][4], (
        f"trail must name the mix repair: {notes[-1][4] if notes else '(none)'}"
    )


def test_lines_get_low_confidence_when_claims_disagree_with_the_decode(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The hello miss: an UNRELATED verdict against real claims means our decode and the claims disagree;
    WHICH side is right is unresolved, so no unique line should carry `high` on that basis alone (found
    3 gross-but-labelled-high lines live). Every line must publish at `low` — the honest label."""

    def scattered(log_probs: Sequence[float], targets: Sequence[int]) -> tuple[list[int], list[float]]:
        """A permutation decoder: each line's chars land on the WRONG phrase's audio span.
        The envelope fit remains high (chars sit ON singing) but no line agrees with its claim, so the
        reconcile verdict comes out UNRELATED — the exact hello shape."""
        labels = [0] * len(log_probs)
        scores = [-0.4] * len(log_probs)
        spans = []
        for line_index, (text, _start, _end) in enumerate(PHRASES):
            other = PHRASES[(line_index + 3) % len(PHRASES)]  # a permutation with no fixed points
            chars = [c for w in text.split() for c in w if DIC.get(c)]
            step = (other[2] - other[1]) / max(len(chars), 1)
            for j in range(len(chars)):
                spans.append((other[1] + j * step, other[1] + (j + 0.7) * step))
        for (start, end), token in zip(spans, targets, strict=True):
            first = int(start / 0.02)
            for f in range(first, min(max(int(end / 0.02), first + 1), len(labels))):
                labels[f] = token
        return labels, scores

    from encore_worker.adapters import ml

    monkeypatch.setattr(ml, "forced_align_decoder", scattered)
    impl, aligner, _trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert timed is not None
    doc = doc_of(tmp, timed)
    confidences = {line["confidence"] for line in doc["lines"]}
    assert confidences == {"low"}, f"expected all low, got {confidences}"


# ── the anchor windows behind R3 ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class _Stub:
    index: int
    start: float
    end: float


def test_anchored_runs_window_each_run_between_its_kept_neighbours() -> None:
    from encore_worker.steps.align_steps import _anchored_runs

    lines = [_Stub(0, 5.0, 7.0), _Stub(1, 8.0, 10.0), _Stub(2, 12.0, 14.0), _Stub(3, 16.0, 18.0)]
    runs = _anchored_runs(lines, {1, 2}, duration_sec=40.0)  # type: ignore[arg-type]
    assert len(runs) == 1
    run, (window_start, window_end) = runs[0]
    assert [line.index for line in run] == [1, 2]
    assert (window_start, window_end) == (7.0, 16.0), "the window is the gap between the kept anchors"


def test_anchored_runs_use_the_track_edges_when_no_anchor_exists() -> None:
    from encore_worker.steps.align_steps import _anchored_runs

    lines = [_Stub(0, 5.0, 7.0), _Stub(1, 8.0, 10.0), _Stub(2, 12.0, 14.0)]
    head = _anchored_runs(lines, {0}, duration_sec=40.0)  # type: ignore[arg-type]
    assert head[0][1] == (0.0, 8.0)
    tail = _anchored_runs(lines, {2}, duration_sec=40.0)  # type: ignore[arg-type]
    assert tail[0][1] == (10.0, 40.0)
