"""The global-decode wiring in `time_text`: the decline ladder, the repairs and the grading policy.

Hermetic — the aligner, decoder and audio are all fakes. The real-audio acceptance run lives in the
benchmark (`bench.py --global`) and was verified through this exact code path: an UNTIMED sheet moved from
1.3% to 70.7% of lines within ±250 ms, and a +1.0 s LRC was diagnosed `structural` with 64/75 lines
corroborated and `offset −0.88s` on the trail.

THE RIG'S DECODER IS A REAL CTC VITERBI (`tests/ctc_fixture.py`) over a matrix that sings PHRASES. It was
a script that returned the whole song's spans whatever it was handed. So every repair-window decode
raised, `regenerate` swallowed it, and R3 ran in no test: deleting it left the suite green (review L8).
The fake is frame-for-frame equal to torchaudio's kernel on these matrices (`test_ml_contract.py`).
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
from encore_worker.domain.lyrics.generate import Generated, Line, Word
from encore_worker.domain.lyrics.policy import Tier
from encore_worker.host.config import Config
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.records import AudioRef, JobRef, Refused, TextRef, TimedDoc, TimeRequest
from tests.ctc_fixture import alignable, ctc_viterbi, misheard, sung_matrix

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
    """An `Aligner` whose `emissions` hear every phrase's chars evenly inside its true span."""

    def __init__(self) -> None:
        self.align_calls = 0

    def emissions(self, _path: str, _language: str) -> FakeEmissions:
        return FakeEmissions(log_probs=sung_matrix(PHRASES, DIC, DURATION), frame_sec=0.02, dictionary=DIC)

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


def scripted_decoder(log_probs: object, targets: Sequence[int]) -> tuple[list[int], list[float]]:
    """A decode that is 'right' by construction, over WHATEVER frames it is handed.

    A real CTC Viterbi over the sung matrix. The whole song places each phrase on its true span, and a
    repair window gets its own slice decoded, with spans relative to that slice.
    """
    return ctc_viterbi(log_probs, targets)


def unmeasured_lift(monkeypatch: pytest.MonkeyPatch) -> None:
    """For a SCRIPTED decoder, which scores every frame alike whatever the targets: its lexical lift reads 0
    for any text, so the global engine's lexical gate (W3, `lexical.BANDS`) would refuse the song's own words
    before the repair the test is about. Such a test takes the check out (`lexical.lift` unmeasurable, as
    for a text under `lexical.MIN_LETTERS`) and the envelope gate decides, as it did before W3. The rig's
    own decoder is a real Viterbi over a sung matrix, which the lift reads (`test_lexical_gate.py`)."""
    from encore_worker.domain.lyrics import lexical

    monkeypatch.setattr(lexical, "lift", lambda *_a, **_k: None)


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
    assert isinstance(timed, TimedDoc) and timed.timing == "word"
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
    assert isinstance(timed, TimedDoc)
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
    of the sung audio makes the envelope refuse; the attempt is REFUSED (a verdict that ends the text —
    no line sync, which would publish the same words ungated) and NOTHING falls back to another engine."""
    impl, aligner, trail, job, _audio, _tmp = rig
    silent = tmp_path / "silence.wav"
    sf.write(silent, np.zeros(int(DURATION * RATE)), RATE)
    audio = AudioRef(path=str(silent), vocals_path=str(silent), duration_sec=DURATION)
    timed = asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert isinstance(timed, Refused)
    assert timed.report.refused is not None and timed.report.refused.startswith("envelope gate refused")
    assert aligner.align_calls == 0, "no windowed fallback: the refusal is the outcome"
    declines = [s for s in trail.states if s[1] == "align-global" and s[3] == "declined"]
    assert declines, "the refusal must be on the trail, or it is indistinguishable from never running"
    assert declines[-1][4] == timed.report.refused, "the trail and the verdict say the same thing"


def test_a_decode_that_refuses_this_text_fails_the_attempt_with_a_trail_note(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The kernel's own refusal of THESE targets (more characters than frames: the real kernel's message,
    `test_ml_contract`) is a fact about the text on this audio, so it is one attempt declining. The case
    this test used to stage, "kernel gone", is the machinery's (review M7): below, and it raises."""
    from encore_worker.adapters import ml

    def refuse(*_a: object, **_k: object) -> tuple[list[int], list[float]]:
        raise RuntimeError("targets length is too long for CTC. Found log_probs length: 5, targets length: 6")

    monkeypatch.setattr(ml, "forced_align_decoder", refuse)
    impl, aligner, trail, job, audio, _tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert timed is None and aligner.align_calls == 0
    declines = [s for s in trail.states if s[1] == "align-global" and s[3] == "declined"]
    assert declines and declines[-1][4].startswith("decode failed: RuntimeError: targets length is too long")


# ── machinery faults fail the JOB, not the attempt (review M7) ─────────────────────────────────────


def test_a_model_that_would_not_load_fails_the_job_rather_than_declining(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A download that answered 503 fails every attempt of every text alike. Declined, it walked the ladder
    to a published "no lyrics" (measured through `run_align`: 7 declines, machine captions tried twice,
    whisper run for nothing). Raised, it reaches the transport with its own `retryable`."""
    from encore_worker.adapters.ports import InfraFault

    def unavailable(_self: object, _path: str, _language: str) -> FakeEmissions:
        raise InfraFault("loading the 'en' alignment model failed (OSError: HTTP Error 503)")

    monkeypatch.setattr(FakeAligner, "emissions", unavailable)
    impl, aligner, trail, job, audio, _tmp = rig
    with pytest.raises(InfraFault, match="HTTP Error 503") as raised:
        asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert raised.value.retryable is True, "a download is worth another attempt"
    assert aligner.align_calls == 0, "no windowed fallback either: the machinery is the same"
    assert not [s for s in trail.states if s[3] == "declined"], "a fault is not a verdict on the text"


def test_a_ctc_kernel_that_is_gone_fails_the_job_and_is_not_retried(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """torchaudio 2.9 deprecates `forced_align` for removal; a box whose torchaudio lost it cannot decode any
    text, and trying again on the same box changes nothing (`ModelUnavailable.retryable` is False)."""
    from encore_worker.adapters import ml

    def gone(*_a: object, **_k: object) -> tuple[list[int], list[float]]:
        raise ml.ModelUnavailable("torchaudio's CTC kernel (`torchaudio.functional.forced_align`) is gone")

    monkeypatch.setattr(ml, "forced_align_decoder", gone)
    impl, _aligner, trail, job, audio, _tmp = rig
    with pytest.raises(ml.ModelUnavailable) as raised:
        asyncio.run(impl.time_text(request(job, audio, timed=False)))
    assert raised.value.retryable is False
    assert not [s for s in trail.states if s[3] == "declined"]


def test_audio_the_emission_pass_read_but_the_envelope_cannot_fails_the_job(rig: Rig, tmp_path: Path) -> None:
    """The envelope reads the same file the emission pass just decoded, and no text changes it: a read that
    fails there fails every attempt identically. `load_audio_mono_16k` raises it typed, and nothing
    between it and the transport catches it (it used to decline, attempt after attempt)."""
    from encore_worker.adapters.ports import InfraFault

    impl, _aligner, trail, job, _audio, _tmp = rig
    gone = str(tmp_path / "reclaimed-vocals.wav")  # the rig's emissions are a fake; the envelope is ffmpeg
    audio = AudioRef(path=gone, vocals_path=gone, duration_sec=DURATION)
    with pytest.raises(InfraFault, match="through ffmpeg"):
        asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert not [s for s in trail.states if s[3] == "declined"]


def test_a_machinery_fault_inside_a_repair_window_is_not_a_repair_fault(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`regenerate` keeps a window's originals when its decode raises, and counts a repair fault, which is
    right for a window too narrow for its text and wrong for the kernel going away between two decodes: the
    step catches the `InfraFault` on its way through the pure repair and raises it."""
    from encore_worker.adapters import ml

    whole_song = sum(len(alignable(t, DIC)) for t, _s, _e in PHRASES)

    def gone_after_the_blind_decode(
        log_probs: object, targets: Sequence[int]
    ) -> tuple[list[int], list[float]]:
        if len(targets) != whole_song:
            raise ml.ModelUnavailable("the CTC kernel went away mid-job")
        return ctc_viterbi(log_probs, targets)

    monkeypatch.setattr(ml, "forced_align_decoder", gone_after_the_blind_decode)
    impl, _aligner, trail, job, audio, _tmp = rig
    with pytest.raises(ml.ModelUnavailable, match="went away mid-job"):
        asyncio.run(impl.time_text(request(job, audio, timed=False)))  # untimed: R3 re-decodes the chorus
    assert not [s for s in trail.states if s[3] in ("repair-faults", "declined")]


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
    assert isinstance(timed, TimedDoc) and timed.timing == "line"
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
    assert isinstance(timed, TimedDoc) and timed.timing == "word"
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
    assert isinstance(timed, Refused) and aligner.align_calls == 0
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
    unmeasured_lift(monkeypatch)
    impl, aligner, trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert aligner.align_calls == 0, "repair happens in place; no other engine runs"
    assert isinstance(timed, TimedDoc) and timed.timing == "word"
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
    unmeasured_lift(monkeypatch)
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


def two_word_line(index: int, start: float, end: float) -> Line:
    """A line of two words splitting `[start, end]` — `_clamped`'s unit, with a letter count to check."""
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


def clamp(
    lines: Sequence[Line], blind: Sequence[Line], repaired: set[int]
) -> tuple[tuple[Line, ...], frozenset[int]]:
    """`_clamped`'s `m2-order-clamp` arm at the global decode's frame (20 ms), `blind` the fallback."""
    from encore_worker.steps.align_steps import _clamped

    got, refused = _clamped(
        Generated(lines=tuple(lines), language="en"),
        repaired,
        blind=Generated(lines=tuple(blind), language="en"),
        frame_sec=0.02,
        ordered=True,
    )
    return got.lines, refused


def ordered(lines: Sequence[Line]) -> bool:
    """`measure`'s order: no word starts before the one ahead of it, across lines."""
    starts = [word.start for line in lines for word in line.words]
    return all(b >= a for a, b in zip(starts, starts[1:], strict=False))


def test_clamped_refits_repaired_lines_without_touching_trusted_ones() -> None:
    """The live degradation: a repaired line spilling over its neighbour reads as out-of-order words and
    `decide` throws the whole document away. Clamping re-fits ONLY repaired lines into the free gap —
    a trusted line's overlap is a measurement and must survive."""
    trusted, spilled, following = (
        two_word_line(0, 5.0, 8.0),
        two_word_line(1, 7.0, 12.0),
        two_word_line(2, 11.0, 14.0),
    )
    (kept, fixed, after), refused = clamp(
        (trusted, spilled, following), (trusted, two_word_line(1, 8.5, 10.5), following), {1}
    )
    assert refused == frozenset(), "a spill that fits the gap is clipped, not refused"
    assert (kept.start, kept.end) == (5.0, 8.0), "trusted lines never move"
    assert (after.start, after.end) == (11.0, 14.0)
    assert fixed.start >= kept.end - 1e-9 and fixed.end <= after.start + 1e-9
    for word in fixed.words:
        assert fixed.start - 1e-9 <= word.start <= word.end <= fixed.end + 1e-9
    assert fixed.words[0].start < fixed.words[1].start, "internal order survives the refit"


# M2's three shapes (review M2; `test_repair_order` seeds 6, 12 and 2/30 through the real `time_text`).
# Each published backwards word starts under the old clamp; each now goes back to the blind line.


def test_clamped_refuses_a_repair_that_starts_after_the_next_trusted_line() -> None:
    """Seed 6's shape: the repair landed past its successor. The old clamp squeezed it to 0.2 s at its
    own start, AFTER line 2, and `decide` read the inversion as incoherent timing."""
    trusted, following = two_word_line(0, 5.0, 8.0), two_word_line(2, 11.0, 14.0)
    blind = two_word_line(1, 8.5, 10.5)
    lines, refused = clamp(
        (trusted, two_word_line(1, 14.5, 16.0), following), (trusted, blind, following), {1}
    )
    assert refused == {1}
    assert lines == (trusted, blind, following), "the blind line is back, untouched"


def test_clamped_refuses_a_squeeze_below_one_frame_per_letter() -> None:
    """Seed 12's shape: the repair starts 50 ms before its successor. Clipped, it would keep order but hold
    `line 1`'s 4 letters in 50 ms, under CTC's one frame each; the old 0.2 s floor instead pushed its
    words past line 2's start. The threshold is a frame per LETTER: the digit is out of vocabulary."""
    trusted, following = two_word_line(0, 5.0, 8.0), two_word_line(2, 11.0, 14.0)
    blind = two_word_line(1, 8.5, 10.5)

    def clipped_from(start: float) -> tuple[tuple[Line, ...], frozenset[int]]:
        return clamp((trusted, two_word_line(1, start, 12.5), following), (trusted, blind, following), {1})

    for start in (10.95, 10.93):  # 50 and 70 ms for 4 letters: under 80 ms
        lines, refused = clipped_from(start)
        assert refused == {1} and lines[1] is blind, start
    lines, refused = clipped_from(10.91)  # 90 ms: fits, clipped and in order (5 chars would not)
    assert refused == frozenset() and ordered(lines)
    assert (lines[1].start, lines[1].end) == (10.91, 11.0)


def test_clamped_judges_a_run_of_repaired_lines_as_one_unit() -> None:
    """Seeds 2 and 30: two consecutive repaired lines. The first was bounded by nothing (its successor
    was repaired too) and landed past the run's trusted successor; the old clamp then squeezed the
    second after it. The run cannot fit between its anchors, so BOTH go back to blind, the second's
    repair included: the run is the unit (refusing line by line measured no better; see `_clamped`)."""
    trusted, following = two_word_line(0, 5.0, 8.0), two_word_line(3, 20.0, 22.0)
    blind = (two_word_line(1, 9.0, 12.0), two_word_line(2, 13.0, 17.0))
    run = (two_word_line(1, 21.0, 23.0), two_word_line(2, 15.0, 17.0))
    lines, refused = clamp((trusted, *run, following), (trusted, *blind, following), {1, 2})
    assert refused == {1, 2}
    assert lines == (trusted, *blind, following)


def test_clamped_fits_a_run_that_can_keep_order_and_leaves_the_last_line_unbounded() -> None:
    """The run is clipped line by line into what its predecessors left: overlapping repairs are pushed
    right, the last one stops at the run's trusted successor. A repaired LAST line has no successor and
    keeps its end."""
    trusted, following = two_word_line(0, 5.0, 8.0), two_word_line(3, 18.0, 20.0)
    run = (two_word_line(1, 7.5, 12.0), two_word_line(2, 11.5, 19.0))
    blind = (two_word_line(1, 9.0, 12.0), two_word_line(2, 13.0, 17.0))
    lines, refused = clamp((trusted, *run, following), (trusted, *blind, following), {1, 2})
    assert refused == frozenset() and ordered(lines)
    assert [(line.start, line.end) for line in lines[1:3]] == [(8.0, 12.0), (12.0, 18.0)]
    tail = two_word_line(4, 19.5, 30.0)
    lines, refused = clamp(
        (trusted, following, tail), (trusted, following, two_word_line(4, 21.0, 24.0)), {4}
    )
    assert refused == frozenset() and (lines[2].start, lines[2].end) == (20.0, 30.0)


def test_the_default_clamp_is_v2s_which_squeezes_and_never_refuses() -> None:
    """Without `m2-order-clamp` — the shipped default since W1 measured the arm failing its reject-if on
    the corpus (`_clamped`) — the clamp is v2's: a spill that fits is clipped exactly as the arm clips
    it, and seed 6's shape is SQUEEZED to 0.2 s at its own start, after its successor, not refused."""
    from encore_worker.steps.align_steps import _clamped

    def default(lines: Sequence[Line], blind: Sequence[Line]) -> tuple[tuple[Line, ...], frozenset[int]]:
        got, refused = _clamped(
            Generated(lines=tuple(lines), language="en"),
            {1},
            blind=Generated(lines=tuple(blind), language="en"),
            frame_sec=0.02,
            ordered=False,
        )
        return got.lines, refused

    trusted, following, blind = (
        two_word_line(0, 5.0, 8.0),
        two_word_line(2, 11.0, 14.0),
        two_word_line(1, 8.5, 10.5),
    )
    spill = (trusted, two_word_line(1, 7.0, 12.0), following)
    assert default(spill, (trusted, blind, following)) == clamp(spill, (trusted, blind, following), {1})
    lines, refused = default((trusted, two_word_line(1, 14.5, 16.0), following), (trusted, blind, following))
    assert refused == frozenset(), "v2's clamp never refuses"
    assert (lines[0], lines[2]) == (trusted, following)
    assert (lines[1].start, lines[1].end) == pytest.approx((14.5, 14.7))
    assert not ordered(lines), "review M2's first shape, still published by the default"


def test_an_out_of_order_global_document_names_its_lines_on_the_trail(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The safety net behind `_clamped`: should a published word document still run backwards, the trail
    says which lines — `decide` drops the text to line sync over it, and the count alone names nothing.

    Forced by moving R3's repaired line 4 to start inside line 3 AFTER the real clamp (the default clamp
    produces it on review M2's shapes, `test_repair_order`; the `m2-order-clamp` arm cannot). The note
    precedes the verdict note, so the last `align-global` note — the one the bench reads as the verdict —
    is still the verdict."""
    from encore_worker.domain.lyrics.generate import remapped
    from encore_worker.steps import align_steps

    real = align_steps._clamped

    def inverting(
        generated: Generated, repaired: set[int], *, blind: Generated, frame_sec: float, ordered: bool
    ) -> tuple[Generated, frozenset[int]]:
        got, refused = real(generated, repaired, blind=blind, frame_sec=frame_sec, ordered=ordered)
        lines = list(got.lines)
        assert lines[4].index == 4 and 4 in repaired, "the rig's R3 repairs the repeat at [4]"
        lines[4] = remapped(lines[4], lines[3].start + 0.3, lines[3].start + 2.3)
        return Generated(lines=tuple(lines), language=got.language), refused

    monkeypatch.setattr(align_steps, "_clamped", inverting)
    impl, _aligner, trail, job, audio, _tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=False)))
    assert isinstance(timed, TimedDoc) and timed.report.out_of_order > 0
    notes = [s for s in trail.states if s[1] == "align-global"]
    flagged = [s for s in notes if s[3] == "out-of-order"]
    assert len(flagged) == 1 and notes[-1][3] != "out-of-order"
    assert flagged[0][4] == f"{timed.report.out_of_order} word starts run backwards, in lines [4] (repaired)"


def test_a_stem_invisible_line_is_re_decoded_against_the_mix(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """tfr-chosen's outro, hermetically: the vocals stem falls silent while the mix still carries the
    singing. The stem decode has no evidence for the line; R4 computes a SECOND emissions on the MIX and
    re-decodes just that line inside its claim window. Measured on real audio: -45 to -54 s errors ->
    under 1 s.

    THE EVIDENCE IS PATH-DEPENDENT, which is what makes this test able to tell WHICH matrix R4 decoded:
    the stem's matrix has no frames for line 5 and the mix's has them where it is sung, both decoded by
    the real CTC Viterbi (`ctc_fixture`). The test this replaces served one flat matrix for both paths
    and a scripted decoder, so R4 decoding the STEM left the whole suite green (mutation, review r1:
    994 passed). Measured with that mutation: line 5 publishes at 25.38-28.46 s against its sung
    25.50-27.50 s, and this test fails on it."""
    from tests.ctc_fixture import sung_matrix as sung

    impl, aligner, trail, job, audio, tmp = rig
    lost = 5
    on_stem = [phrase for index, phrase in enumerate(PHRASES) if index != lost]
    # The stem is SILENT under line 5 (what a demucs stem does on an effects-heavy section), the mix is
    # not: the envelope sees line 5's claim window on stem silence, which is what sends it to R4.
    stem_signal = np.random.default_rng(0).normal(0.0, 0.002, int(DURATION * RATE))
    mix_signal = np.random.default_rng(1).normal(0.0, 0.002, int(DURATION * RATE))
    for index, (_text, start, end) in enumerate(PHRASES):
        t = np.arange(int((end - start) * RATE)) / RATE
        a, b = int(start * RATE), int(start * RATE) + len(t)
        tone = 0.3 * np.sin(2 * math.pi * 220.0 * t)
        mix_signal[a:b] += tone
        if index != lost:
            stem_signal[a:b] += tone
    assert audio.vocals_path is not None
    sf.write(audio.vocals_path, stem_signal, RATE)
    mix_wav = tmp_path / "mix.wav"
    sf.write(mix_wav, mix_signal, RATE)
    audio = AudioRef(path=str(mix_wav), vocals_path=audio.vocals_path, duration_sec=DURATION)
    heard = {audio.vocals_path: sung(on_stem, DIC, DURATION), str(mix_wav): sung(PHRASES, DIC, DURATION)}
    asked: list[str] = []

    def emissions_by_path(path: str, _lang: str) -> FakeEmissions:
        asked.append(path)
        return FakeEmissions(log_probs=heard[path], frame_sec=0.02, dictionary=DIC)

    monkeypatch.setattr(FakeAligner, "emissions", staticmethod(emissions_by_path))
    timed = asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert timed is not None and aligner.align_calls == 0
    assert asked == [audio.vocals_path, str(mix_wav)], "the stem first, then the mix for R4 alone"
    line5 = doc_of(tmp, timed)["lines"][lost]
    assert line5["text"] == PHRASES[lost][0]
    assert abs(line5["start"] - PHRASES[lost][1]) < 0.1 and abs(line5["end"] - PHRASES[lost][2]) < 0.2, (
        f"line {lost} published at {line5['start']:.2f}-{line5['end']:.2f}s, sung "
        f"{PHRASES[lost][1]:.2f}-{PHRASES[lost][2]:.2f}s: R4 did not decode the MIX"
    )
    notes = [s for s in trail.states if s[1] == "align-global"]
    assert notes and "re-decoded 1 stem-invisible lines against the mix" in notes[-1][4], (
        f"trail must name the mix repair: {notes[-1][4] if notes else '(none)'}"
    )


def test_a_machinery_fault_on_the_mix_witness_degrades_rather_than_failing_the_job(
    rig: Rig, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """R4 is OPTIONAL evidence, like the diarizer: an out-of-memory on the MIX's emission pass leaves the
    stem-invisible line on the stem's decode and says so on the trail. Failing the job over it would throw
    away a document the stem already made, for a witness only some lines consult (review M7's line)."""
    from encore_worker.adapters.cli import OutOfMemory

    impl, aligner, trail, job, audio, tmp = rig
    lost = 5
    stem_signal = np.random.default_rng(0).normal(0.0, 0.002, int(DURATION * RATE))
    for index, (_text, start, end) in enumerate(PHRASES):
        if index != lost:
            t = np.arange(int((end - start) * RATE)) / RATE
            a = int(start * RATE)
            stem_signal[a : a + len(t)] += 0.3 * np.sin(2 * math.pi * 220.0 * t)
    assert audio.vocals_path is not None
    sf.write(audio.vocals_path, stem_signal, RATE)
    mix = str(tmp_path / "mix.wav")
    sf.write(mix, np.zeros(int(DURATION * RATE)), RATE)
    audio = AudioRef(path=mix, vocals_path=audio.vocals_path, duration_sec=DURATION)
    on_stem = sung_matrix([p for i, p in enumerate(PHRASES) if i != lost], DIC, DURATION)

    def stem_only(path: str, _lang: str) -> FakeEmissions:
        if path == mix:
            raise OutOfMemory(
                "the emission pass on mps ran out of memory (RuntimeError: MPS backend out of memory)"
            )
        return FakeEmissions(log_probs=on_stem, frame_sec=0.02, dictionary=DIC)

    monkeypatch.setattr(FakeAligner, "emissions", staticmethod(stem_only))
    timed = asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert isinstance(timed, TimedDoc) and aligner.align_calls == 0
    witness = [s for s in trail.states if s[3] == "mix-witness-declined"]
    assert len(witness) == 1 and "OutOfMemory" in witness[0][4], witness
    assert "against the mix" not in global_notes(trail)[-1][4], "no mix repair happened, and none is claimed"


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
    unmeasured_lift(monkeypatch)
    impl, aligner, _trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert timed is not None
    doc = doc_of(tmp, timed)
    confidences = {line["confidence"] for line in doc["lines"]}
    assert confidences == {"low"}, f"expected all low, got {confidences}"


# ── R3, run for real ─────────────────────────────────────────────────────────────────────────────

#: The three occurrences of the repeated chorus: the lines R3 treats as blind on an untimed sheet.
CHORUS = [i for i, (text, _s, _e) in enumerate(PHRASES) if text == PHRASES[0][0]]


def global_notes(trail: TrailSpy) -> list[tuple[Any, ...]]:
    return [s for s in trail.states if s[1] == "align-global"]


def untimed(job: JobRef, audio: AudioRef) -> TimeRequest:
    return request(job, audio, timed=False)


def test_r3_redecodes_a_misplaced_blind_repeat_inside_its_anchor_gap(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """R3's effect: a repeat the global pass placed wrong INSIDE its gap is re-decoded there and lands
    where it is sung. No claim says which chorus is which, so the unique neighbours around it bound the
    window. Delete R3 (mutation, measured) and the line publishes at 18.34 s instead of 21.96 s.

    An exact Viterbi reproduces its own global path between its own anchors (the README's measured R3
    no-op; pinned below). So the misplacement is made the only honest way: the GLOBAL pass hears the
    second chorus at 18.4 s, and the repair window decodes the real song it is handed."""
    from encore_worker.adapters import ml

    moved = [(t, 18.4, 20.4) if i == CHORUS[1] else (t, s, e) for i, (t, s, e) in enumerate(PHRASES)]
    heard = sung_matrix(moved, DIC, DURATION)
    monkeypatch.setattr(ml, "forced_align_decoder", misheard(heard, int(DURATION / 0.02)))
    impl, aligner, trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(untimed(job, audio)))
    assert timed is not None and aligner.align_calls == 0
    line = doc_of(tmp, timed)["lines"][CHORUS[1]]
    assert abs(line["start"] - 22.0) < 0.1, f"the repeat stayed at {line['start']:.2f}s; R3 did not fix it"
    assert line["confidence"] == "low", "an anchor vouches for the region, not for which chorus it is"
    notes = global_notes(trail)
    assert "re-decoded 3 repeated lines between unique anchors" in notes[-1][4]
    assert not [n for n in notes if n[3] == "repair-faults"]


def test_an_r3_repair_that_lands_on_its_claim_is_two_witnesses_agreeing(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The same misbound chorus, now with the sheet's TIMED claims. The blind verdict disputes only that
    line, so R3 re-decodes it between its unique anchors — without reading the claims — and it lands on
    its claim. Two independent measurements agreeing: `high` (review W1 r1). The rule for lines decoded
    INSIDE a claim window (the blind decode must have corroborated them) cannot apply here: R3 takes
    exactly the repeats the blind verdict did not corroborate, so it graded every R3 repair `low`."""
    from encore_worker.adapters import ml

    moved = [(t, 18.4, 20.4) if i == CHORUS[1] else (t, s, e) for i, (t, s, e) in enumerate(PHRASES)]
    monkeypatch.setattr(
        ml, "forced_align_decoder", misheard(sung_matrix(moved, DIC, DURATION), int(DURATION / 0.02))
    )
    impl, _aligner, trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert timed is not None
    lines = doc_of(tmp, timed)["lines"]
    assert abs(lines[CHORUS[1]]["start"] - 22.0) < 0.1, "R3 moved it where it is sung"
    assert lines[CHORUS[1]]["confidence"] == "high"
    why = global_notes(trail)[-1][4]
    assert f"timing sources: 7 blind, 1 anchored [{CHORUS[1]}]" in why
    assert why.endswith("8/8 lines high")


def test_on_an_exact_decode_r3_reproduces_the_global_path(rig: Rig) -> None:
    """The measured R3 no-op, as a property. On the same matrix, re-decoding a run between the global
    path's own anchors reproduces the global path word for word, because CTC's monotonicity already
    confined the repeat to that gap. R3 must still RUN: its note on the trail says every chorus line was
    re-decoded, and nothing raised."""
    from encore_worker.domain.lyrics.generate import generate

    impl, aligner, trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(untimed(job, audio)))
    assert timed is not None
    notes = global_notes(trail)
    assert f"re-decoded {len(CHORUS)} repeated lines between unique anchors" in notes[-1][4]
    assert not [n for n in notes if n[3] == "repair-faults"]
    raw = generate([t for t, _s, _e in PHRASES], aligner.emissions("", "en"), decoder=scripted_decoder)
    published = doc_of(tmp, timed)["lines"]
    assert len(published) == len(raw.lines)
    for got, want in zip(published, raw.lines, strict=True):
        assert got["start"] == pytest.approx(want.start, abs=1e-9)
        assert got["end"] == pytest.approx(want.end, abs=1e-9)
        spans = [t for w in got["words"] for t in (w["start"], w["end"])]
        assert spans == pytest.approx([t for w in want.words for t in (w.start, w.end)], abs=1e-9)


def test_a_repair_decode_that_raises_is_a_note_on_the_trail_not_a_silence(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review L8's exhibit: the rig's old decoder served the WHOLE song's spans whatever it was handed.
    Every R3 window decode raised and `regenerate` swallowed it, which is how R3 went untested unseen.
    The originals are still kept, but the count and the first error are now on the trail, and the
    verdict note carries the count too."""
    from encore_worker.adapters import ml

    whole_song = sum(len(alignable(t, DIC)) for t, _s, _e in PHRASES)

    def whole_song_decoder(log_probs: object, targets: Sequence[int]) -> tuple[list[int], list[float]]:
        if len(targets) != whole_song:
            raise AssertionError(f"{whole_song} spans vs {len(targets)} targets")
        return ctc_viterbi(log_probs, targets)

    monkeypatch.setattr(ml, "forced_align_decoder", whole_song_decoder)
    impl, _aligner, trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(untimed(job, audio)))
    assert timed is not None, "a failed repair keeps the originals; the attempt still publishes"
    notes = global_notes(trail)
    faults = [n for n in notes if n[3] == "repair-faults"]
    assert len(faults) == 1, faults
    assert faults[0][4].startswith(f"R3: {len(CHORUS)} of {len(CHORUS)} window decodes raised")
    assert "AssertionError" in faults[0][4], "the first error is named"
    assert f"R3: {len(CHORUS)} window decodes raised" in notes[-1][4]
    assert "re-decoded" not in notes[-1][4], "nothing was repaired, and the trail must not claim it was"
    chorus = doc_of(tmp, timed)["lines"][CHORUS[1]]
    assert abs(chorus["start"] - PHRASES[CHORUS[1]][1]) < 0.1, "the global placement is what published"


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
