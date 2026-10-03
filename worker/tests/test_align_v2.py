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
from dataclasses import dataclass, replace
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
    #: The BUNDLE these frames came off (`adapters.ml.Emissions.model`). None is "unnamed", which
    #: `lexical.calibration` reads as the shipped row by construction — a fake's matrix really is that
    #: model's as far as every threshold is concerned. A test that needs another bundle's row names it.
    model: str | None = None

    @property
    def frames(self) -> int:
        return len(self.log_probs)  # type: ignore[arg-type]


class FakeAligner:
    """An `Aligner` whose `emissions` hear every phrase's chars evenly inside its true span."""

    def __init__(self, model: str | None = None) -> None:
        self.align_calls = 0
        self.model = model

    def emissions(self, _path: str, _language: str) -> FakeEmissions:
        return FakeEmissions(
            log_probs=sung_matrix(PHRASES, DIC, DURATION),
            frame_sec=0.02,
            dictionary=DIC,
            model=self.model,
        )

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


def scripted_decoder(
    log_probs: object, targets: Sequence[int], blank: int = 0
) -> tuple[list[int], list[float]]:
    """A decode that is 'right' by construction, over WHATEVER frames it is handed.

    A real CTC Viterbi over the sung matrix. The whole song places each phrase on its true span, and a
    repair window gets its own slice decoded, with spans relative to that slice. `blank` is FORWARDED
    rather than defaulted, so this fake decodes whatever column its matrix calls blank (review M9).
    """
    return ctc_viterbi(log_probs, targets, blank)


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


def test_a_failing_envelope_gate_fails_the_attempt_rather_than_publishing(
    rig: Rig, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Wrong text — or a garbage decode — must not publish just because it decoded.

    Silence in place of the sung audio makes the envelope refuse, the attempt is REFUSED (a verdict that
    ends the text, so line sync cannot publish the same words ungated), and nothing falls back to another
    engine. The envelope gate now decides only where the LIFT could not measure the text, on either
    target; the two controls that put it back in the verdict's seat on a mix are pinned in
    `tests/test_lexical_gate.py` (`h3-mix-envelope`, `h3-mix-floor`)."""
    unmeasured_lift(monkeypatch)
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
        log_probs: object, targets: Sequence[int], blank: int = 0
    ) -> tuple[list[int], list[float]]:
        if len(targets) != whole_song:
            raise ml.ModelUnavailable("the CTC kernel went away mid-job")
        return ctc_viterbi(log_probs, targets, blank)

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
    """The other side of the tier-2 band, and read through the gate's own scope: `unmeasured_lift`, because
    since W4 review r1 the lift is the wrong-text verdict on a mix as well as on a stem, so the envelope
    gate refuses only where no lift measured the text (the test above says the same)."""
    from encore_worker.domain.audio import activity

    unmeasured_lift(monkeypatch)
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

    def window_decoder(
        log_probs: Sequence[float], targets: Sequence[int], blank: int = 0
    ) -> tuple[list[int], list[float]]:
        # Spreads targets over the middle of WHATEVER slice it is given: the GLOBAL decode therefore
        # scatters lines across the whole song (wrong), while a claim-window re-decode necessarily lands
        # inside the window (right, by anchor) — the shape of a real misbound repeat-heavy decode.
        labels = [blank] * len(log_probs)
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


def test_no_envelope_fit_runs_on_the_event_loop(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> None:
    """No envelope fit runs on the event loop (L6).

    `fit_shift` is synchronous numpy — 42 ms on a 60-minute recording even bounded — and the step sits
    inside a socket keepalive the reaper reads, so a fit on the loop stalls it. Every other call site was
    already in `asyncio.to_thread`; the one R1 makes when the claims out-fit the decode was not, and
    nothing could see it, a stalled keepalive being no kind of wrong timing. Asserted by THREAD IDENTITY
    (`asyncio.run` puts the loop on the main thread), through the R1 path that used to."""
    import threading

    from encore_worker.domain.audio import activity

    threads: list[str] = []
    real = activity.fit_shift

    def watched(*args: object, **kwargs: object) -> object:
        threads.append(threading.current_thread().name)
        return real(*args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(activity, "fit_shift", watched)

    def window_decoder(
        log_probs: Sequence[float], targets: Sequence[int], blank: int = 0
    ) -> tuple[list[int], list[float]]:
        labels = [blank] * len(log_probs)
        scores = [-0.4] * len(log_probs)
        low, high = int(0.2 * len(log_probs)), int(0.9 * len(log_probs))
        per = (high - low) / max(len(targets), 1)
        for i, token in enumerate(targets):
            first = low + int(i * per)
            for f in range(first, min(max(low + int(i * per + 0.7 * per), first + 1), len(labels))):
                labels[f] = token
        return labels, scores

    from encore_worker.adapters import ml

    monkeypatch.setattr(ml, "forced_align_decoder", window_decoder)
    unmeasured_lift(monkeypatch)
    impl, _aligner, trail, job, audio, _tmp = rig
    assert asyncio.run(impl.time_text(request(job, audio, timed=True))) is not None
    notes = [s for s in trail.states if s[1] == "align-global"]
    assert notes and "claim windows" in notes[-1][4], "R1 must have run, or this proves nothing"
    assert len(threads) >= 2, f"the fits are not being counted: {threads}"
    assert threading.main_thread().name not in threads, f"a fit ran on the event loop: {threads}"


def test_a_line_the_decode_cannot_hear_adopts_the_claim_timing(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """tfr-chosen's outro, hermetically: chopped vocals the captions time but the model cannot recognise.
    The global decode misplaces one claimed line; the R2 window re-decode then sticks to the window's left
    edge (it heard nothing), and the line SURRENDERS to the claim's own timing — words interpolated,
    confidence `low`, the adoption named on the trail."""
    full_frames = int(DURATION / 0.02)

    def deaf_in_windows(
        log_probs: Sequence[float], targets: Sequence[int], _blank: int = 0
    ) -> tuple[list[int], list[float]]:
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
        log_probs: Sequence[float], targets: Sequence[int], blank: int = 0
    ) -> tuple[list[int], list[float]]:
        labels, scores = scripted_decoder(log_probs, list(targets)[:phrase_chars], blank)
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

    got, refused, pulled = _clamped(
        Generated(lines=tuple(lines), language="en"),
        repaired,
        blind=Generated(lines=tuple(blind), language="en"),
        frame_sec=0.02,
        ordered=True,
    )
    assert pulled == {}, "the arm refuses a run rather than moving a trusted end: it reports no pull"
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


def default_clamp(
    lines: Sequence[Line], blind: Sequence[Line], repaired: set[int], frame_sec: float = 0.02
) -> tuple[tuple[Line, ...], frozenset[int], dict[int, float]]:
    """The SHIPPED clamp (`_clamped` without `ordered`): v2's, with W6's bounded left floor.

    Three values, the third being the PULLS it reports — `{index: seconds of overrun removed}` — which is a
    published timing changed on a line no stage repaired and therefore the one thing about this clamp the
    trail has to carry (W6 review r1-spec-15 / r1-tests-19, `_pulls_why`).
    """
    from encore_worker.steps.align_steps import _clamped

    got, refused, pulled = _clamped(
        Generated(lines=tuple(lines), language="en"),
        repaired,
        blind=Generated(lines=tuple(blind), language="en"),
        frame_sec=frame_sec,
        ordered=False,
    )
    return got.lines, refused, pulled


def test_the_default_clamp_never_refuses_and_still_publishes_m2s_first_shape() -> None:
    """Without `m2-order-clamp` — the shipped default since W1 measured the arm failing its reject-if on
    the corpus (`_clamped`) — seed 6's shape is SQUEEZED to 0.2 s at its own start, after its successor,
    not refused. Nothing precedes the repair there, so W6's bounded floor has nothing to pull."""
    trusted, following, blind = (
        two_word_line(0, 5.0, 8.0),
        two_word_line(2, 11.0, 14.0),
        two_word_line(1, 8.5, 10.5),
    )
    lines, refused, pulled = default_clamp(
        (trusted, two_word_line(1, 14.5, 16.0), following), (trusted, blind, following), {1}
    )
    assert refused == frozenset(), "v2's clamp never refuses"
    assert pulled == {}, "nothing precedes the repair, so no end was pulled and the trail says nothing"
    assert (lines[0], lines[2]) == (trusted, following)
    assert (lines[1].start, lines[1].end) == pytest.approx((14.5, 14.7))
    assert not ordered(lines), "review M2's first shape, still published by the default"


# W6's bounded left floor (`_clamped_v2`, `_pulled_end`): the floor used to be the previous published END,
# which is the blind decode's own boundary — the reading the repair was there to correct — so it put the
# repaired line back where the decode had it (7 gross line starts manufactured on HuBERT-Large, 3 on the
# base bundle; the numbers are in `_clamped_v2`). The overlap is resolved at the neighbour's END instead.


def test_the_default_clamp_pulls_a_neighbours_end_back_instead_of_pushing_the_repair() -> None:
    """`hello` [46]'s shape: the line before the repair ends 1.0 s past the repair's start. v2 published
    the repair at the neighbour's end; the default now ends the NEIGHBOUR at the repair's start and
    leaves the repair exactly where the ladder measured it. The neighbour keeps its start and its order."""
    trusted, following = two_word_line(0, 5.0, 8.0), two_word_line(2, 11.0, 14.0)
    repair = two_word_line(1, 7.0, 10.0)
    lines, refused, pulled = default_clamp((trusted, repair, following), (trusted, repair, following), {1})
    assert refused == frozenset()
    # THE PULL IS REPORTED, by index and by how far (W6 review r1-spec-15 / r1-tests-19): line [0] is a line
    # the ladder did not repair, its published END moved, and `provenance` deliberately still calls it the
    # blind decode's — so if this mapping were empty the trail would assert the decode timed that end.
    assert pulled == {0: pytest.approx(1.0)}
    assert (lines[1].start, lines[1].end) == pytest.approx((7.0, 10.0)), "the repair is untouched"
    assert (lines[0].start, lines[0].end) == pytest.approx((5.0, 7.0)), "the neighbour's END came back"
    assert lines[0].text == trusted.text and lines[0].index == 0 and lines[0].score == trusted.score
    assert lines[2] == following
    assert ordered(lines), "which is the property the floor exists for"
    # `generate.trimmed`, not `remapped`: both of the neighbour's onsets are before the boundary, so both
    # SURVIVE the pull and only its last word's end moves. Affine compression read 5.0 / 6.0 here, and
    # 0.1-0.2 pt worse on four of the Jamendo word gates.
    assert [w.start for w in lines[0].words] == pytest.approx([5.0, 6.5])
    assert lines[0].words[-1].end == pytest.approx(7.0)


def test_a_neighbours_end_is_not_pulled_below_one_frame_per_letter() -> None:
    """`_pulled_end`'s one guard that fires on the corpus (4 times on HuBERT-Large, 3 on the base bundle):
    squeezed under a decoder frame per letter the neighbour is ordered but is no longer a decoded timing,
    so v2's push is taken instead — the repair goes to the neighbour's end, as it always did."""
    trusted, following = two_word_line(0, 5.0, 8.0), two_word_line(2, 11.0, 14.0)
    repair = two_word_line(1, 5.05, 10.0)  # "line 0" is 4 letters: 4 x 20 ms = 80 ms > 50 ms of room
    lines, _refused, pulled = default_clamp((trusted, repair, following), (trusted, repair, following), {1})
    assert (lines[0].start, lines[0].end) == (5.0, 8.0), "the neighbour is left alone"
    assert (lines[1].start, lines[1].end) == pytest.approx((8.0, 10.0)), "so the repair is pushed"
    assert pulled == {}, "a refused pull is not a pull: the trail must not claim an end came back"
    wide = default_clamp(
        (trusted, two_word_line(1, 5.15, 10.0), following), (trusted, repair, following), {1}
    )[0]
    assert (wide[0].start, wide[0].end) == pytest.approx((5.0, 5.15)), "150 ms of room fits 4 letters"


def leading_silence_line(index: int, start: float, first_word: float, end: float) -> Line:
    """A line whose first word starts INSIDE its span — the shape that made `remapped` invert lines."""
    return Line(
        text=f"line {index}",
        start=start,
        end=end,
        words=(
            Word(word="a", start=first_word, end=(first_word + end) / 2, score=-0.4),
            Word(word="b", start=(first_word + end) / 2, end=end, score=-0.4),
        ),
        score=-0.4,
        index=index,
    )


def test_a_pull_can_never_move_a_word_start_earlier() -> None:
    """Why `_pulled_end` needs no order guard, where an affine re-fit did (it carried one, measured at 0
    firings, and `generate.trimmed` makes it unreachable).

    The shape: the line TWO back is a trusted line whose overlap is a measurement and stays, and it already
    reaches past the neighbour's start; the neighbour has leading silence. `remapped` would slide the
    neighbour's first word from 4.0 back to 3.05, BEFORE `swallowing`'s last word at 3.5 — a new inversion,
    and `policy.decide` drops the whole text to line sync over one. `trimmed` keeps it at 4.0."""
    swallowing = two_word_line(0, 1.0, 6.0)  # last word at 3.5, span ends inside `neighbour`
    neighbour = leading_silence_line(1, 3.0, 4.0, 9.0)  # in order today: 3.5 <= 4.0
    repair, following = two_word_line(2, 4.5, 9.5), two_word_line(3, 12.0, 14.0)
    series = (swallowing, neighbour, repair, following)
    lines, _refused, _pulled = default_clamp(series, series, {2})
    assert (lines[1].start, lines[1].end) == pytest.approx((3.0, 4.5)), "pulled onto the repair"
    assert (lines[2].start, lines[2].end) == pytest.approx((4.5, 9.5)), "the repair keeps its start"
    assert [w.start for w in lines[1].words] == pytest.approx([4.0, 4.25]), "the onset at 4.0 survives"
    assert ordered(lines)
    assert lines[1].words[0].start == neighbour.words[0].start, "the FIRST onset is what cannot move"
    assert min(w.start for w in lines[1].words) >= neighbour.words[0].start, "nor may the tail pass it"


def test_a_neighbour_no_word_of_which_starts_before_the_repair_is_not_pulled() -> None:
    """`generate.trimmed`'s own refusal: a line whose every word starts after the boundary was not sung
    before it, so there is nothing to keep and v2's push applies. It never fired on the corpus — with it,
    20 Jamendo songs' word metrics are identical to letting an affine re-fit compress such a line."""
    from encore_worker.domain.lyrics.generate import trimmed

    swallowing = leading_silence_line(0, 1.0, 5.0, 9.0)  # 4 letters, so 1.0 -> 4.0 clears the frame floor
    repair, following = two_word_line(1, 4.0, 9.5), two_word_line(2, 12.0, 14.0)
    assert trimmed(swallowing, 4.0, frame_sec=0.02) is None
    lines, _refused, pulled = default_clamp(
        (swallowing, repair, following), (swallowing, repair, following), {1}
    )
    assert (lines[0].start, lines[0].end) == (1.0, 9.0), "the neighbour is left alone"
    assert pulled == {}, "`trimmed` refused, so no end moved and none is reported"
    assert (lines[1].start, lines[1].end) == pytest.approx((9.0, 9.5)), "so the repair is pushed"


def many_word_line(index: int, onsets: Sequence[float], *, start: float, end: float) -> Line:
    """A line whose word onsets are given exactly — the shape a tail collapse needs (`trimmed`'s anchor)."""
    bounds = [*onsets, end]
    return Line(
        text=" ".join(f"w{i}" for i in range(len(onsets))),
        start=start,
        end=end,
        words=tuple(
            Word(word=f"w{i}", start=onset, end=bounds[i + 1], score=-0.4) for i, onset in enumerate(onsets)
        ),
        score=-0.4,
        index=index,
    )


def test_a_pulled_tail_keeps_a_decoder_frame_for_every_word_it_re_fits() -> None:
    """W6 review r2-spec-9. The ANCHOR is the last word starting before the boundary, and where it starts a
    hair before it the tail's scale goes to ~0: this neighbour's last three words used to publish inside
    0.8 ms of 19.999, four words the TV can never light (it lights `start <= pos < end`) and three onsets no
    longer within a frame of anything measured. `_pulled_end`'s letter rule cannot see it — it measures the
    WHOLE line, 10 s against 0.3 s of letters — so `trimmed` takes an earlier anchor instead, which keeps the
    pull (no repaired start goes back onto the smeared end) and keeps every word a width. 42 published lines
    of the recorded base-bundle corpus carry the old shape, 27 of them `rap-god`'s."""
    neighbour = many_word_line(0, [10.0, 19.999, 20.4, 20.9, 21.6], start=9.5, end=22.0)
    repair, following = two_word_line(1, 20.0, 24.0), two_word_line(2, 30.0, 32.0)
    series = (neighbour, repair, following)
    lines, _refused, pulled = default_clamp(series, series, {1})
    assert pulled == {0: pytest.approx(2.0)}, "the pull still happens; that is the point of the walk"
    assert (lines[1].start, lines[1].end) == pytest.approx((20.0, 24.0)), "the repair is untouched"
    starts = [w.start for w in lines[0].words]
    assert starts[0] == 10.0, "the first onset never moves, whichever word the anchor is"
    assert lines[0].words[-1].end == pytest.approx(20.0), "and the tail ends where the line now does"
    assert all(b - a >= 0.02 - 1e-9 for a, b in zip(starts, starts[1:], strict=False)), (
        f"every re-fitted onset keeps a decoder frame: {starts}"
    )
    assert all(w.end - w.start >= 0.02 - 1e-9 for w in lines[0].words), "so every word can be lit"
    assert ordered(lines)
    # The anchor walked from 19.999 (3 words to place in 1 ms) to 10.0 (4 words in 10 s), so the tail is the
    # affine re-fit of [10.0, 22.0] into [10.0, 20.0] — ONE measured onset traded for a tail that is a timing.
    assert starts[1] == pytest.approx(10.0 + (19.999 - 10.0) * (10.0 / 12.0))


def test_a_repaired_lines_width_floor_is_a_refit_floor_and_the_pull_outranks_it() -> None:
    """W6 review r2-correctness-4. `_clamped_v2` floors every repaired line at `_REPAIRED_MIN_SEC` as it
    remaps it, and a LATER iteration can pull that same line's end back inside the floor: two repairs 0.1 s
    apart cannot both be 0.2 s wide without overlapping, so the floor is unsatisfiable and the pull wins.
    That is the right way round — the start is what grading and every line metric read, and the alternative
    pushes [1] to 10.2, which is the smeared-end failure the bounded floor exists to end — and what bounds
    the published width instead is `_pulled_end`'s frame per letter. Pinned because the floor's docstring
    promised the published width until this finding read the two against each other."""
    from encore_worker.steps.align_steps import _REPAIRED_MIN_SEC

    oh = many_word_line(0, [10.0], start=10.0, end=10.02)
    night = many_word_line(1, [10.1, 10.6, 11.0, 11.4, 11.7], start=10.1, end=12.0)
    trusted = two_word_line(2, 14.0, 16.0)
    series = (oh, night, trusted)
    lines, _refused, pulled = default_clamp(series, series, {0, 1})
    assert (lines[0].start, lines[0].end) == pytest.approx((10.0, 10.1))
    assert lines[0].end - lines[0].start < _REPAIRED_MIN_SEC, "the floor is not the published width"
    assert lines[0].end - lines[0].start >= 2 * 0.02, "one frame per letter of 'w0' is, and it holds"
    assert pulled == {0: pytest.approx(0.1)}, "and the trail is told the end moved"
    assert (lines[1].start, lines[1].end) == pytest.approx((10.1, 12.0)), "the repair keeps its start"
    assert ordered(lines)


def test_the_pull_cascades_through_a_run_of_repaired_lines() -> None:
    """`The_Rinn` [43-45]'s shape: a 4.0 s adopted span with two repaired lines inside it. Each pull is
    read against the series AS PUBLISHED SO FAR, so the wide span comes back to the first repair and the
    first repair's own end comes back to the second — the 7.63 s the corpus's worst clamp-made gross line
    was published late."""
    wide, following = two_word_line(0, 1.0, 5.0), two_word_line(3, 6.0, 7.0)
    first, second = two_word_line(1, 2.0, 4.0), two_word_line(2, 3.0, 5.5)
    lines, _refused, pulled = default_clamp(
        (wide, first, second, following), (wide, first, second, following), {1, 2}
    )
    assert [(line.start, line.end) for line in lines] == pytest.approx(
        [(1.0, 2.0), (2.0, 3.0), (3.0, 5.5), (6.0, 7.0)]
    )
    assert ordered(lines)
    # BOTH pulls are reported, including the one on a line the ladder DID repair: the clause's count is what
    # a reader compares against `timing sources`, and dropping either would understate the clamp's reach.
    assert pulled == {0: pytest.approx(3.0), 1: pytest.approx(1.0)}


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
    ) -> tuple[Generated, frozenset[int], dict[int, float]]:
        got, refused, pulled = real(generated, repaired, blind=blind, frame_sec=frame_sec, ordered=ordered)
        lines = list(got.lines)
        assert lines[4].index == 4 and 4 in repaired, "the rig's R3 repairs the repeat at [4]"
        lines[4] = remapped(lines[4], lines[3].start + 0.3, lines[3].start + 2.3)
        return Generated(lines=tuple(lines), language=got.language), refused, pulled

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
    """A stem-invisible line is re-decoded against the MIX (tfr-chosen's outro, hermetically).

    The vocals stem falls silent while the mix still carries the singing, so the stem decode has no
    evidence for the line and R4 computes a SECOND emissions on the mix and re-decodes just that line
    inside its claim window. Measured on real audio: -45 to -54 s errors -> under 1 s. The evidence is
    PATH-DEPENDENT, which is what lets this test say which matrix R4 read: with one flat matrix for both
    paths and a scripted decoder, R4 decoding the STEM left the whole suite green and the line published
    at 25.38-28.46 s against its sung 25.50-27.50 s."""
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

    def scattered(
        log_probs: Sequence[float], targets: Sequence[int], _blank: int = 0
    ) -> tuple[list[int], list[float]]:
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
    """The measured R3 no-op, as a property: a run re-decoded between the global path's own anchors
    reproduces that path word for word, CTC's monotonicity having already confined the repeat to the gap.

    R3 must still RUN — its trail note says every chorus line was re-decoded, and nothing raised. The
    comparison is against the RAW decode bit for bit, which W4's word-end post-pass does not disturb on
    this rig: one wav serves as both mix and vocals stem, so the step reads its align target as the MIX,
    where the post-pass does not run at all. Any difference is therefore a repair moving something."""
    from encore_worker.domain.lyrics.generate import generate

    impl, aligner, trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(untimed(job, audio)))
    assert timed is not None
    notes = global_notes(trail)
    assert f"re-decoded {len(CHORUS)} repeated lines between unique anchors" in notes[-1][4]
    assert "word ends: the raw decode's (no vocals stem" in notes[-1][4], "one wav: the target is the mix"
    assert not [n for n in notes if n[3] == "repair-faults"]
    raw = generate([t for t, _s, _e in PHRASES], aligner.emissions("", "en"), decoder=scripted_decoder)
    shown = raw
    published = doc_of(tmp, timed)["lines"]
    assert len(published) == len(shown.lines)
    for got, want, decoded in zip(published, shown.lines, raw.lines, strict=True):
        assert got["start"] == pytest.approx(want.start, abs=1e-9)
        assert got["end"] == pytest.approx(want.end, abs=1e-9)
        spans = [t for w in got["words"] for t in (w["start"], w["end"])]
        assert spans == pytest.approx([t for w in want.words for t in (w.start, w.end)], abs=1e-9)
        # Starts against the DECODE's own, so this keeps saying what it always said about R3.
        starts = [w["start"] for w in got["words"]]
        assert starts == pytest.approx([w.start for w in decoded.words], abs=1e-9)


def test_a_repair_decode_that_raises_is_a_note_on_the_trail_not_a_silence(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Review L8's exhibit: the rig's old decoder served the WHOLE song's spans whatever it was handed.
    Every R3 window decode raised and `regenerate` swallowed it, which is how R3 went untested unseen.
    The originals are still kept, but the count and the first error are now on the trail, and the
    verdict note carries the count too."""
    from encore_worker.adapters import ml

    whole_song = sum(len(alignable(t, DIC)) for t, _s, _e in PHRASES)

    def whole_song_decoder(
        log_probs: object, targets: Sequence[int], blank: int = 0
    ) -> tuple[list[int], list[float]]:
        if len(targets) != whole_song:
            raise AssertionError(f"{whole_song} spans vs {len(targets)} targets")
        return ctc_viterbi(log_probs, targets, blank)

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


# ── the placement-margin demotion (review §3.7; W6, `domain/lyrics/margin.py`) ───────────────────
#
# The KERNEL is proved in `test_margin.py` against an exhaustive per-frame DP. What is pinned here is the
# WIRING, which is where the rule's two design decisions live: it is computed on the blind decode's own
# texts, and it is read on the ONE branch whose grade rests on our decode alone.


def _margins(monkeypatch: pytest.MonkeyPatch, gaps: dict[int, float]) -> list[tuple[int, ...]]:
    """Force `placement_margins` to report `gaps` (a line it does not name is unambiguous), and record the
    LINES it was asked about on each call."""
    from encore_worker.domain.lyrics import margin

    asked: list[tuple[int, ...]] = []

    def fake(log_probs: Any, targets: Any, first: Any, **kw: Any) -> dict[int, float]:
        del log_probs, targets, kw
        asked.append(tuple(sorted(int(index) for index in first)))
        return {int(index): gaps.get(int(index), 1e6) for index in first}

    monkeypatch.setattr(margin, "placement_margins", fake)
    return asked


def test_an_ambiguous_placement_demotes_a_line_nothing_else_vouches_for(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The headline: an UNIQUE line on an untimed sheet used to be `high` by default (nothing but its own
    uniqueness said so). Where the trellis says the same letters fit somewhere else nearly as well, it is
    `low` — 11 of the corpus's `high` lines more than 2 s out were exactly this shape."""
    unique = next(i for i, (text, _s, _e) in enumerate(PHRASES) if text == "with me tonight")
    _margins(monkeypatch, {unique: 0.5})
    impl, _aligner, _trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(untimed(job, audio)))
    assert isinstance(timed, TimedDoc)
    lines = doc_of(tmp, timed)["lines"]
    assert lines[unique]["confidence"] == "low"
    assert lines[unique]["words"], "a demotion grades the line; it must not drop its words"
    other = next(i for i, (text, _s, _e) in enumerate(PHRASES) if text == "stars are out")
    assert lines[other]["confidence"] == "high", "an unambiguous placement is untouched"


def test_a_corroborated_line_keeps_its_grade_however_ambiguous_our_decode_was(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The restriction, and review H4's argument read forward: two INDEPENDENT measurements agreeing beats
    the decode's own opinion of itself, and the margin is the decode's own opinion of itself. Measured on 4
    songs x truth/off15/drop50 (516 lines): charging corroborated lines for it cost 84 of 278 word wipes
    and found nothing, because claim-mode bad-among-high was already 0.00% (the figures README's "It is read
    on ONE branch" section and `align_steps`' own comment carry: 278 -> 194 `high`, 53.9% -> 37.6%)."""
    _margins(monkeypatch, dict.fromkeys(range(len(PHRASES)), 0.0))
    impl, _aligner, _trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(request(job, audio, timed=True)))
    assert isinstance(timed, TimedDoc) and timed.confidence == "high"
    assert all(line["confidence"] == "high" for line in doc_of(tmp, timed)["lines"])


def test_the_margins_are_asked_about_the_blind_decodes_own_lines_once(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Once per `time_text`, on the whole song's target sequence — not once per repair window. A margin
    measured inside a repair window would be asking whether the line could have gone elsewhere IN THAT
    WINDOW, which is a question the window already answered by fiat."""
    asked = _margins(monkeypatch, {})
    impl, _aligner, _trail, job, audio, _tmp = rig
    assert asyncio.run(impl.time_text(untimed(job, audio))) is not None
    assert len(asked) == 1, f"the margin ran {len(asked)} times"
    assert asked[0] == tuple(range(len(PHRASES)))


def test_conf_legacy_skips_the_whole_demotion_and_its_cost(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> None:
    """`conf-legacy`, the control: it restores the grading the margin joined, score half included.

    It must also skip the two Viterbi passes, which is the only reason to set it in production, and it
    must say WHICH rule ran: this assertion used to read "not measured", which a swallowed `MemoryError`
    printed byte for byte — so a run whose default-on grading had silently fallen back to the rule it
    replaced (446 `high` / 11.88% bad / 23 gross against the default's 286 / 2.80% / zero) read exactly
    like an A/B an operator asked for. The fault's own wording is asserted one test below."""
    from encore_worker.domain.lyrics import margin

    called: list[int] = []
    monkeypatch.setattr(
        margin,
        "placement_margins",
        lambda *_a, **_k: called.append(1) or {},  # type: ignore[func-returns-value]
    )
    monkeypatch.setattr(margin, "low_lines", lambda *_a, **_k: pytest.fail("the control read the rule"))
    _impl, aligner, trail, job, audio, tmp = rig
    impl = AlignStepsImpl(
        config=Config(align_experiments=frozenset({"conf-legacy"})),
        adapters=Adapters(aligner=aligner),
        reporter=trail,
    )
    timed = asyncio.run(impl.time_text(untimed(job, audio)))
    assert isinstance(timed, TimedDoc)
    assert called == [], "the control must not compute the margins at all"
    unique = next(i for i, (text, _s, _e) in enumerate(PHRASES) if text == "with me tonight")
    assert doc_of(tmp, timed)["lines"][unique]["confidence"] == "high"
    why = global_notes(trail)[-1][4]
    assert "placement margins: not read, `conf-legacy` asked for the grading that preceded" in why
    assert "not measured" not in why, "which is a FAULT's sentence, and this is not one"


def test_a_margin_that_cannot_be_computed_grades_as_if_it_never_existed(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`{}` means NOT MEASURED, never "ambiguous". A fault that demoted every line would be a silent
    failure dressed as caution, and on a box short of memory it would demote every line of every song."""
    from encore_worker.domain.lyrics import margin

    def boom(*_a: Any, **_k: Any) -> dict[int, float]:
        raise MemoryError("two curves too many")

    monkeypatch.setattr(margin, "placement_margins", boom)
    impl, _aligner, trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(untimed(job, audio)))
    assert isinstance(timed, TimedDoc)
    unique = next(i for i, (text, _s, _e) in enumerate(PHRASES) if text == "with me tonight")
    assert doc_of(tmp, timed)["lines"][unique]["confidence"] == "high"
    assert "placement margins: not measured" in global_notes(trail)[-1][4]


def near_repeat_request(job: JobRef, audio: AudioRef) -> TimeRequest:
    """The rig's sheet with its LAST line turned into a NEAR repeat of line [0] — `difflib` 0.89, so
    `margin.fuzzy_repeats` flags it while `normalized.count(text) > 1` (R3's exact rule, which already grades
    both copies `low`) does not. ONE CHARACTER, not one word: the audio sings "away" there and the real CTC
    fixture forces the 'r' onto it, so the line's own score stays inside `low_lines`' score half — a sheet
    whose near-repeat was ALSO the song's worst-scoring line could not tell the arm from that half."""
    texts = [text for text, _s, _e in PHRASES]
    texts[-1] = texts[-1].replace("away", "awry")
    text = TextRef(
        tier=Tier.CANDIDATE,
        label="test",
        segments=tuple({"text": line} for line in texts),
        timing=None,
    )
    return TimeRequest(job=job, text=text, audio=audio, language="en")


def test_the_fuzzy_repeat_arm_demotes_a_near_repeat_the_default_grades_high(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """W6 review r2-tests-14. `conf-fuzzy-repeats` was built, priced on the corpus (49 near-repeats: 3 bad
    demoted, 30 correct demoted, 0 gross — the 10:1 trade that keeps it off) and tested NOWHERE: changing the
    call to `if False and "conf-fuzzy-repeats" in experiments` left the whole worker suite green, because the
    only test of it was `test_ownership`'s grep for the literal. So this asserts the three things the arm is:
    the demotion it adds, the texts it is asked about (`line_texts_active`, the POST-drop texts, so its keys
    line up with `low_lines`'s), and the default's answer on the same line."""
    from encore_worker.domain.lyrics import margin

    asked: list[dict[int, str]] = []
    real = margin.fuzzy_repeats
    monkeypatch.setattr(
        margin,
        "fuzzy_repeats",
        lambda texts, **kw: asked.append(dict(texts)) or real(texts, **kw),  # type: ignore[func-returns-value]
    )
    _margins(monkeypatch, {})
    _impl, aligner, trail, job, audio, tmp = rig
    near = len(PHRASES) - 1

    def run(experiments: frozenset[str]) -> dict[str, Any]:
        impl = AlignStepsImpl(
            config=Config(align_experiments=experiments),
            adapters=Adapters(aligner=aligner),
            reporter=trail,
        )
        timed = asyncio.run(impl.time_text(near_repeat_request(job, audio)))
        assert isinstance(timed, TimedDoc), timed
        return doc_of(tmp, timed)

    default = run(frozenset())
    assert asked == [], "the default never asks: the arm is the only reader"
    assert default["lines"][near]["confidence"] == "high", "an unambiguous near-repeat is `high` today"
    armed = run(frozenset({"conf-fuzzy-repeats"}))
    assert armed["lines"][near]["confidence"] == "low", "and the arm demotes it"
    assert len(asked) == 1, f"once per document, like the margins: {len(asked)}"
    assert asked[0] == dict(enumerate(line["text"] for line in armed["lines"])), (
        "about the texts the blind decode ran on, keyed the way `low_lines` keys its own answer"
    )
    assert "near-repeat demotion (conf-fuzzy-repeats): 3 line(s) flagged" in global_notes(trail)[-1][4], (
        "the two exact copies of line [0] are near-repeats of each other too, and of [7]"
    )


def test_the_fuzzy_repeat_arm_fires_on_a_bundle_with_no_measured_margin_floor(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """W6 review r2-correctness-5. `margin.fuzzy_repeats` is a `difflib` ratio over the line TEXTS — no
    emission scale, no bundle, nothing to calibrate — and it was gated behind the MARGIN's abstention, so on
    `HUBERT_ASR_XLARGE` (a name `lexical.is_calibrated` passes, whose `margin_floor_nats` is deliberately
    None) an operator setting `ENCORE_ALIGN_EXPERIMENTS=conf-fuzzy-repeats` got the default grading with
    nothing on the trail saying the arm had done nothing: a bench row under the arm's name measuring the
    default path, which is the mistake `ALIGN_EXPERIMENTS` refuses unknown names to prevent, from the other
    side. The margin half still stands down — that floor really is this bundle's missing measurement."""
    from encore_worker.domain.lyrics import lexical, margin

    assert lexical.is_calibrated("HUBERT_ASR_XLARGE"), "the hole is a row that exists with a field unfitted"
    monkeypatch.setattr(
        margin, "placement_margins", lambda *_a, **_k: pytest.fail("another bundle's nats were read")
    )
    _impl, _aligner, trail, job, audio, tmp = rig
    impl = AlignStepsImpl(
        config=Config(align_experiments=frozenset({"conf-fuzzy-repeats"})),
        adapters=Adapters(aligner=FakeAligner(model="HUBERT_ASR_XLARGE")),
        reporter=trail,
    )
    timed = asyncio.run(impl.time_text(near_repeat_request(job, audio)))
    assert isinstance(timed, TimedDoc)
    near = len(PHRASES) - 1
    assert doc_of(tmp, timed)["lines"][near]["confidence"] == "low", "the arm needed no calibration"
    why = global_notes(trail)[-1][4]
    assert "near-repeat demotion (conf-fuzzy-repeats): 3 line(s) flagged" in why, why
    assert "no calibrated margin floor" in why, "and the MARGIN half still says why it stood down"


def test_the_control_arm_stands_the_fuzzy_repeat_arm_down_and_says_so(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`conf-legacy` means the grading that preceded review §3.7, which has no demotion to widen, so the two
    arms together are a contradiction — and the one thing that must not happen is the quiet reading of it
    (W6 review r2-correctness-5). The clause names the arm, says it was requested, and says what stood it
    down, so a row recorded with both names cannot be read as the fuzzy arm's."""
    from encore_worker.domain.lyrics import margin

    monkeypatch.setattr(
        margin, "fuzzy_repeats", lambda *_a, **_k: pytest.fail("the control read the widened rule")
    )
    _impl, aligner, trail, job, audio, tmp = rig
    impl = AlignStepsImpl(
        config=Config(align_experiments=frozenset({"conf-legacy", "conf-fuzzy-repeats"})),
        adapters=Adapters(aligner=aligner),
        reporter=trail,
    )
    timed = asyncio.run(impl.time_text(near_repeat_request(job, audio)))
    assert isinstance(timed, TimedDoc)
    assert doc_of(tmp, timed)["lines"][len(PHRASES) - 1]["confidence"] == "high", "the control's grading"
    why = global_notes(trail)[-1][4]
    assert "near-repeat demotion (conf-fuzzy-repeats): requested, not applied — `conf-legacy`" in why


def test_both_new_arm_names_are_declared_experiments() -> None:
    """W6 review r2-tests-15. The two tests of these arms construct `Config(align_experiments=...)` directly,
    so deleting either name from `ALIGN_EXPERIMENTS` left the full suite green while
    `ENCORE_ALIGN_EXPERIMENTS=conf-legacy` — the command `gates/w6-conf.yaml`'s own header prescribes for the
    baseline of a DEFAULT-ON grading change — made the worker refuse to START (`ConfigError`, by design: an
    unknown name is a typo). The off switch has to be settable from the environment to be an off switch."""
    from encore_worker.host.config import ALIGN_EXPERIMENTS

    assert {"conf-legacy", "conf-fuzzy-repeats"} <= set(ALIGN_EXPERIMENTS)
    both = Config.from_env({"ENCORE_ALIGN_EXPERIMENTS": "conf-legacy,conf-fuzzy-repeats"})
    assert both.align_experiments == frozenset({"conf-legacy", "conf-fuzzy-repeats"})
    assert Config.from_env({}).align_experiments == frozenset()


def test_a_swallowed_fault_names_itself_so_it_cannot_read_as_the_control_arm(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """W6 review r2-spec-7. The fault path and `conf-legacy` both reached the trail as "placement margins: not
    measured, so grading is as it was before review §3.7" — one sentence for an operator's deliberate A/B and
    for a swallowed `MemoryError` that drops a DEFAULT-ON grading rule back to the rule it replaced (446
    `high` / 11.88% bad / 23 gross `high` lines against 286 / 2.80% / zero). A wrong-confidence report on a
    long song could not tell the two apart, and `_placement_margins` catches EVERY exception by design, so
    there is no crash to find either. The clause now names the exception TYPE — which is also the whole of
    what a reader needs to know whether to re-run or to re-fit."""
    from encore_worker.domain.lyrics import margin

    monkeypatch.setattr(
        margin, "placement_margins", lambda *_a, **_k: (_ for _ in ()).throw(MemoryError("too many curves"))
    )
    impl, _aligner, trail, job, audio, _tmp = rig
    assert isinstance(asyncio.run(impl.time_text(untimed(job, audio))), TimedDoc)
    why = global_notes(trail)[-1][4]
    assert "placement margins: not measured, `MemoryError` inside the two Viterbi passes" in why
    assert "conf-legacy" not in why, "and the arm's sentence is the arm's alone"


def test_an_unreadable_matrix_is_not_measured_and_does_not_read_the_score_half(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """W6 review r2-tests-16. `_placement_margins` turns `{}` into "not measured", and THAT conversion is
    what keeps the half-control rule out of production: `margin.placement_margins` answers `{}` — without
    raising — for a matrix with no frames, a blank or target outside the vocabulary, or targets that do not
    fit the frames, and `margin.low_lines({}, scores)` would still apply its SCORE half. That is the third,
    unintended rule this wave prices at 385 `high` blind Jamendo lines / 7.79% bad / ELEVEN gross against the
    control's 446 / 11.88% / 23 and the shipped rule's 286 / 2.80% / zero. Deleting the `or None` left all 450
    relevant tests green, so this is the sibling of the fault test one branch over — and it asserts the
    SENTENCE too, because an unreadable matrix is not a fault and must not be reported as one."""
    from encore_worker.domain.lyrics import margin

    monkeypatch.setattr(margin, "placement_margins", lambda *_a, **_k: {})
    monkeypatch.setattr(
        margin, "low_lines", lambda *_a, **_k: pytest.fail("`{}` is not a measurement; the rule was read")
    )
    impl, _aligner, trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(untimed(job, audio)))
    assert isinstance(timed, TimedDoc)
    unique = next(i for i, (text, _s, _e) in enumerate(PHRASES) if text == "with me tonight")
    assert doc_of(tmp, timed)["lines"][unique]["confidence"] == "high", "grading as before review §3.7"
    why = global_notes(trail)[-1][4]
    assert "placement margins: not measured, these frames and targets carry no path to compare" in why
    assert "MemoryError" not in why and "conf-legacy" not in why


def test_a_document_already_graded_low_throughout_does_not_pay_for_the_margins(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """W6 review r2-spec-11. `line_confidence` returns `low` unconditionally inside the lexical DOUBT band,
    decided ~250 lines before the margins are taken, so the two Viterbi passes (0.43 s median, 1.16 s on the
    longest song measured, plus a float64 copy of the matrix) bought an `ambiguous` set that could not change
    one published grade. The trail still says the rule was not read and why, which is all the skip costs."""
    from encore_worker.domain.lyrics import lexical, margin

    monkeypatch.setattr(
        margin, "placement_margins", lambda *_a, **_k: pytest.fail("the passes were paid for anyway")
    )
    # The rig's sung text lifts +15 nats/letter, so the BAND is moved over it (read at call time), exactly as
    # `test_lexical_gate`'s own doubt-band cases do.
    monkeypatch.setattr(
        lexical,
        "BANDS",
        replace(lexical.BANDS, refuse_below=0.2, ok_from=1e3, mix_floor=0.15, mix_ok_from=1e3),
    )
    impl, _aligner, trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(untimed(job, audio)))
    assert isinstance(timed, TimedDoc) and timed.confidence == "medium"
    assert {line["confidence"] for line in doc_of(tmp, timed)["lines"]} == {"low"}, "the band's own grade"
    assert (
        "placement margins: not read, every line of this document is graded low"
        in (global_notes(trail)[-1][4])
    )


def test_the_trail_note_carries_the_margins_that_graded_the_lines(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A "these lyrics are out of sync" report is answered by this clause: the signal, its threshold, and
    how many lines it demoted."""
    unique = next(i for i, (text, _s, _e) in enumerate(PHRASES) if text == "with me tonight")
    _margins(monkeypatch, {unique: 0.5})
    impl, _aligner, trail, job, audio, _tmp = rig
    assert asyncio.run(impl.time_text(untimed(job, audio))) is not None
    why = global_notes(trail)[-1][4]
    assert "placement margins over 8 of 8 lines" in why
    assert "min 0" in why and "1 under 10" in why
    assert "1 doubted on ambiguity or a low score" in why


def test_a_fault_does_not_quietly_switch_grading_to_the_score_half(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A fault in `_placement_margins` may not quietly switch grading to the score half.

    `{}` does not mean "as if this never existed": `margin.low_lines({}, scores)` still applies its SCORE
    half, so a MemoryError on a long song moved grading onto a THIRD rule — 385 `high` / 7.79% bad /
    eleven gross over 20 Jamendo songs' blind decode, against the control's 446 / 11.88% / 23 and the
    shipped rule's 286 / 2.80% / zero. The assertion is that the rule is not CONSULTED at all, the one
    statement no score distribution can weaken: the rig's lines score alike, so reading the grades passed
    on the broken code too. `test_margin.py` holds the companion half, where `{}` is a real measurement."""
    from encore_worker.domain.lyrics import margin

    def boom(*_a: Any, **_k: Any) -> dict[int, float]:
        raise MemoryError("two curves too many")

    monkeypatch.setattr(margin, "placement_margins", boom)
    monkeypatch.setattr(
        margin, "low_lines", lambda *_a, **_k: pytest.fail("a fault read the rule it promised to skip")
    )
    impl, _aligner, trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(untimed(job, audio)))
    assert isinstance(timed, TimedDoc)
    unique = next(i for i, (text, _s, _e) in enumerate(PHRASES) if text == "with me tonight")
    assert doc_of(tmp, timed)["lines"][unique]["confidence"] == "high"
    assert "placement margins: not measured" in global_notes(trail)[-1][4]


def test_any_fault_means_not_measured_not_just_the_two_that_were_listed(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The except clause used to name `(ValueError, MemoryError)`, so any OTHER numpy fault escaped and lost
    a document that was already timed — and a guess at which exception a vectorised kernel raises is exactly
    the kind of list that goes stale. `InfraFault` still propagates: a machinery failure must not be
    swallowed into a grade (review M7)."""
    from encore_worker.adapters.ports import InfraFault
    from encore_worker.domain.lyrics import margin

    monkeypatch.setattr(
        margin, "placement_margins", lambda *_a, **_k: (_ for _ in ()).throw(FloatingPointError("underflow"))
    )
    impl, _aligner, trail, job, audio, _tmp = rig
    assert isinstance(asyncio.run(impl.time_text(untimed(job, audio))), TimedDoc)
    assert "placement margins: not measured" in global_notes(trail)[-1][4]

    def infra(*_a: Any, **_k: Any) -> dict[int, float]:
        raise InfraFault("the kernel is gone")

    monkeypatch.setattr(margin, "placement_margins", infra)
    with pytest.raises(InfraFault):
        asyncio.run(impl.time_text(untimed(job, audio)))


def test_an_uncalibrated_bundle_abstains_rather_than_reading_the_base_models_nats(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """W6 review r1-spec-9. The margin floor is a sum of log-probabilities, so it belongs to the bundle whose
    trellis produced the margins (`lexical.Bands.margin_floor_nats`). `HUBERT_ASR_XLARGE` is reachable by name
    and `is_calibrated` passes it, but nobody has decoded one of its matrices, so its row carries None and the
    whole rule stands down — the two Viterbi passes are not even paid for. Before this the floor was a module
    constant in `margin.py`, i.e. the base bundle's 10 nats on an unmeasured bundle with nothing in the
    trail to say so, which is the review's high-severity W3 finding one field further on."""
    from encore_worker.domain.lyrics import lexical, margin

    assert lexical.is_calibrated("HUBERT_ASR_XLARGE"), "the hole is a row that exists with a field unfitted"
    monkeypatch.setattr(
        margin, "placement_margins", lambda *_a, **_k: pytest.fail("the passes were paid for anyway")
    )
    monkeypatch.setattr(margin, "low_lines", lambda *_a, **_k: pytest.fail("another bundle's nats were read"))
    _impl, _aligner, trail, job, audio, tmp = rig
    impl = AlignStepsImpl(
        config=Config(),
        adapters=Adapters(aligner=FakeAligner(model="HUBERT_ASR_XLARGE")),
        reporter=trail,
    )
    timed = asyncio.run(impl.time_text(untimed(job, audio)))
    assert isinstance(timed, TimedDoc)
    unique = next(i for i, (text, _s, _e) in enumerate(PHRASES) if text == "with me tonight")
    assert doc_of(tmp, timed)["lines"][unique]["confidence"] == "high", "grading as before review §3.7"
    why = global_notes(trail)[-1][4]
    assert "no calibrated margin floor" in why, "and the trail says WHICH silence this is"


def test_the_trail_prints_the_floor_this_bundle_was_graded_against(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The clause reads the floor it actually used, not a module constant: with the shipped row monkeypatched
    to 30 nats the note says 30 and the 20-nat line is doubted, which a hard-coded `10` could not do."""
    from encore_worker.domain.lyrics import lexical

    unique = next(i for i, (text, _s, _e) in enumerate(PHRASES) if text == "with me tonight")
    _margins(monkeypatch, {unique: 20.0})
    # The rig's matrix names no bundle, which `lexical.calibration` reads as the shipped row through the
    # MODULE ATTRIBUTE — exactly so a test can move the shipped numbers without rewriting the table.
    monkeypatch.setattr(lexical, "BANDS", replace(lexical.BANDS, margin_floor_nats=30.0))
    impl, _aligner, trail, job, audio, tmp = rig
    timed = asyncio.run(impl.time_text(untimed(job, audio)))
    assert isinstance(timed, TimedDoc)
    why = global_notes(trail)[-1][4]
    assert "1 under 30" in why and "1 doubted" in why
    assert doc_of(tmp, timed)["lines"][unique]["confidence"] == "low", (
        "a 20-nat margin is unambiguous at the shipped 10 and doubted at this row's 30"
    )


def test_the_margins_are_asked_about_the_texts_that_survived_the_never_sung_drop(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The margins are asked about the texts that survived the never-sung drop.

    The margin is read off the trellis of `line_texts_active`, so a line the drop blanked contributes no
    targets and every later line's position in the target sequence moves with it: taken before the drop,
    `first_char_target` would point at the wrong characters for every line after the dropped one and the
    rule would grade the wrong lines. The ordering was argued in a comment and tested nowhere — moving
    the block above the drop loop left 199 tests passing — so the credit line's index must be ABSENT from
    the query and the queried indexes must be exactly the re-decoded set."""
    from encore_worker.steps import align_steps as steps_module

    monkeypatch.setattr(steps_module, "_NEVER_SUNG_RATE", 1000.0)
    credit = "thanks for watching everyone"
    credit_chars = len([c for w in credit.split() for c in w if DIC.get(c)])
    phrase_chars = sum(1 for text, _s, _e in PHRASES for w in text.split() for c in w if DIC.get(c))

    def decoder_with_credit(
        log_probs: Sequence[float], targets: Sequence[int], blank: int = 0
    ) -> tuple[list[int], list[float]]:
        labels, scores = scripted_decoder(log_probs, list(targets)[:phrase_chars], blank)
        if len(targets) > phrase_chars:
            step = 1.4 / credit_chars
            for i, token in enumerate(targets[phrase_chars:]):
                first = int((38.5 + i * step) / 0.02)
                for f in range(first, min(first + 2, len(labels))):
                    labels[f] = token
                    scores[f] = -5.0
        return labels, scores

    from encore_worker.adapters import ml

    monkeypatch.setattr(ml, "forced_align_decoder", decoder_with_credit)
    asked = _margins(monkeypatch, {})
    impl, _aligner, trail, job, audio, tmp = rig
    segments = tuple({"text": text} for text, _s, _e in PHRASES) + ({"text": credit},)
    text = TextRef(tier=Tier.CANDIDATE, label="test", segments=segments, timing=None)
    timed = asyncio.run(impl.time_text(TimeRequest(job=job, text=text, audio=audio, language="en")))
    assert isinstance(timed, TimedDoc)
    assert [line["text"] for line in doc_of(tmp, timed)["lines"]] == [t for t, _s, _e in PHRASES]
    assert "never-sung" in global_notes(trail)[-1][4], "the drop really happened"
    credit_index = len(PHRASES)
    assert asked == [tuple(range(len(PHRASES)))], (
        f"the margins must be asked once, about the surviving texts alone; [{credit_index}] was dropped"
    )


def test_the_trail_records_the_ends_the_clamp_pulled_back(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> None:
    """The trail records the ends `_clamped_v2` pulled back (`_pulls_why`).

    The clamp pulls the END of the line before a repair onto it — 101 times a corpus pass on the base
    bundle, 43 of them on a line the ladder did NOT repair — and `provenance` is deliberately untouched,
    so `_sources_why` reads such a line as wholly the blind decode's and a "the ball hangs on the last
    word of this line" report had no answer short of re-running the ladder. The real clamp's pulls are
    asserted where they happen; this is the wiring, the rig's exact decoder leaving no line overlapping."""
    from encore_worker.steps import align_steps

    real = align_steps._clamped

    def pulling(
        generated: Generated, repaired: set[int], *, blind: Generated, frame_sec: float, ordered: bool
    ) -> tuple[Generated, frozenset[int], dict[int, float]]:
        got, refused, pulled = real(generated, repaired, blind=blind, frame_sec=frame_sec, ordered=ordered)
        assert pulled == {}, "the rig's decode overlaps nothing, so every pull below is the injected one"
        return got, refused, {3: 0.4, 5: 0.6}

    monkeypatch.setattr(align_steps, "_clamped", pulling)
    impl, _aligner, trail, job, audio, _tmp = rig
    assert isinstance(asyncio.run(impl.time_text(untimed(job, audio))), TimedDoc)
    why = global_notes(trail)[-1][4]
    assert "pulled 2 line end(s) back onto the repair that followed them" in why
    assert "median 0.50s of overrun removed" in why
    assert "[3] [5]" in why
    assert "timing sources:" in why, "beside the provenance clause, which keeps calling those lines blind"


def test_the_pull_clause_says_nothing_when_no_end_moved() -> None:
    """A trail clause that fired on every document would be noise, and `_pulls_why`'s cap is what keeps the
    note readable on the songs where the clamp pulls dozens (101 a corpus pass is the measured figure)."""
    from encore_worker.steps.align_steps import _SOURCES_NAMED, _pulls_why

    assert _pulls_why({}) == ""
    one = _pulls_why({7: 0.25})
    assert one.startswith("pulled 1 line end(s) back") and "median 0.25s" in one and "[7]" in one
    many = _pulls_why({i: 0.1 * (i + 1) for i in range(_SOURCES_NAMED + 3)})
    assert "+3 more" in many and f"[{_SOURCES_NAMED}]" not in many
