"""The align flow end to end, driven by fakes.

No DBOS, no SQLite, no models, no network, no audio. That is the point of `run_align` taking its step
surface as an argument: the state machine is exercised as a state machine, and the scenarios below are
the ones that used to require a real alignment pass to observe.

The fake records every call, so a test asserts on WHAT RAN, not only on the outcome. "A job whose first
candidate is good never runs a model" is a claim about cost, and only the call log can check it.
"""

from __future__ import annotations

import pytest

from encore_worker.domain.lyrics.policy import Knob, Tier
from encore_worker.domain.lyrics.report import TimingReport
from encore_worker.steps.api import NotOurJob
from encore_worker.steps.records import (
    TIMING_LINE,
    AudioRef,
    JobRef,
    TextRef,
    TimedDoc,
    TimeRequest,
)
from encore_worker.workflows.align import run_align

JOB = JobRef(job_id="j1", media_id="m1", media_dir="/media/m1", source_uri="https://x.test/v")

CLEAN = TimingReport(words=200, coverage=1.0, duration_sec=200.0)
THIN = TimingReport(words=40, coverage=0.25, duration_sec=200.0)
INCOHERENT = TimingReport(words=200, coverage=1.0, duration_sec=200.0, out_of_order=9)
MISPLACED = TimingReport(words=200, coverage=1.0, duration_sec=200.0, residual_sec=-6.0)


def lrc(label: str = "lrclib") -> TextRef:
    """A provider sheet: its own line timings and presplit windows, so every knob applies."""
    return TextRef(
        tier=Tier.CANDIDATE,
        label=label,
        segments=({"start": 0.0, "end": 2.0, "text": "hello"},),
        timing=TIMING_LINE,
        windows=({"start": 0.0, "end": 2.5, "text": "hello"},),
        language="en",
    )


def asr_text(label: str = "asr:vocals") -> TextRef:
    return TextRef(
        tier=Tier.ASR,
        label=label,
        segments=({"start": 0.1, "end": 1.9, "text": "hello"},),
        timing="word",
    )


class Fake:
    """An `AlignSteps` that returns scripted results and logs every call.

    `reports` is consumed in order, one per `time_text`, so a scenario is written as the sequence of
    alignment outcomes it wants — which is exactly how the search is driven.
    """

    def __init__(
        self,
        *,
        authored: TextRef | None = None,
        provider: TextRef | None = None,
        machine: TextRef | None = None,
        transcribed: TextRef | None = None,
        transcribed_on_mix: TextRef | None = None,
        reports: list[TimingReport] | None = None,
        vocals: bool = True,
        publish_raises: Exception | None = None,
    ) -> None:
        self._authored = authored
        self._provider = provider
        self._machine = machine
        self._transcribed = transcribed
        self._transcribed_on_mix = transcribed_on_mix
        self._reports = list(reports or [])
        self._vocals = vocals
        self._publish_raises = publish_raises
        self.calls: list[str] = []
        self.timed: list[TimeRequest] = []
        self.notes: list[tuple[str, str, str | None]] = []
        self.published: TimedDoc | None = None
        self.publish_count = 0

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        self.calls.append("acquire_audio")
        return AudioRef(
            path="/media/m1/original.mp3",
            duration_sec=200.0,
            vocals_path="/media/m1/vocals.wav" if self._vocals else None,
        )

    async def fetch_captions(self, job: JobRef, *, automatic: bool) -> TextRef | None:
        self.calls.append(f"fetch_captions:{'machine' if automatic else 'authored'}")
        return self._machine if automatic else self._authored

    async def fetch_provider_lyrics(self, job: JobRef, audio: AudioRef) -> TextRef | None:
        self.calls.append("fetch_provider_lyrics")
        return self._provider

    async def transcribe(self, job: JobRef, audio: AudioRef, *, on_vocals: bool) -> TextRef | None:
        self.calls.append(f"transcribe:{'vocals' if on_vocals else 'mix'}")
        return self._transcribed if on_vocals else self._transcribed_on_mix

    async def time_text(self, req: TimeRequest) -> TimedDoc | None:
        self.calls.append(f"time_text:{req.text.label}")
        self.timed.append(req)
        report = self._reports.pop(0) if self._reports else CLEAN
        if report.words == 0:
            return None  # the step produced nothing publishable
        return TimedDoc(
            ref=f"derived/lyrics/{req.text.label}.json",
            timing="word",
            confidence="high",
            report=report,
            label=req.text.label,
            # A real record carries these, and the workflow threads them into the next attempt as the
            # RESHIFT reference. A fake that omitted them made the knob look like a no-op.
            line_starts=tuple(float(n) * 10.0 for n in range(len(req.text.segments) or 1)),
        )

    async def diarize(self, job: JobRef, audio: AudioRef, doc: TimedDoc) -> TimedDoc:
        self.calls.append("diarize")
        return doc

    async def publish(self, job: JobRef, doc: TimedDoc | None) -> str:
        self.calls.append("publish")
        self.publish_count += 1
        if self._publish_raises is not None:
            raise self._publish_raises
        self.published = doc
        return "media/m1.mp3"

    async def note(
        self, job: JobRef, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        self.notes.append((state, verdict, knob))


# ── the happy path ───────────────────────────────────────────────────────────────────────────────


async def test_a_good_candidate_publishes_without_running_a_model() -> None:
    """The cost claim: ASR is paid for only as a fallback, never to build a grading baseline.

    The old worker ran ASR on EVERY align job to grade candidates against. This asserts we do not.
    """
    fake = Fake(provider=lrc(), reports=[CLEAN])
    outcome = await run_align(JOB, fake)

    assert outcome.published is not None
    assert outcome.no_lyrics is False
    assert not any(c.startswith("transcribe") for c in fake.calls), "no model may run on the happy path"
    assert fake.calls.count("time_text:lrclib") == 1, "one alignment, not one per source"
    assert "diarize" in fake.calls and "publish" in fake.calls


async def test_candidates_are_tried_before_the_asr_tier() -> None:
    fake = Fake(provider=lrc(), machine=asr_text("captions:machine"), reports=[CLEAN])
    await run_align(JOB, fake)
    assert fake.timed[0].text.label == "lrclib"


# ── retrying with a different parameter ──────────────────────────────────────────────────────────


async def test_thin_coverage_retries_the_same_text_on_the_mix() -> None:
    """The knob that answers "coverage collapsed": align on the mix instead of the stem."""
    fake = Fake(provider=lrc(), reports=[THIN, CLEAN])
    outcome = await run_align(JOB, fake)

    assert len(fake.timed) == 2, "the defect must cause a second attempt"
    assert fake.timed[0].text.label == fake.timed[1].text.label == "lrclib"
    assert fake.timed[0].on_mix is False
    assert fake.timed[1].on_mix is True, "the retry must actually change the audio it aligns against"
    assert outcome.published is not None


async def test_a_misplaced_lrc_is_re_placed_before_anything_else() -> None:
    """The cheapest knob and the most direct answer to "the lyrics are out of sync"."""
    fake = Fake(provider=lrc(), reports=[MISPLACED, CLEAN])
    await run_align(JOB, fake)
    assert len(fake.timed) == 2
    assert fake.timed[1].reshift is True


async def test_overshoot_widens_the_search_window() -> None:
    """ "The song ends in the middle of the lyrics" — drop the narrow presplit windows and retry."""
    overshooting = TimingReport(words=200, coverage=1.0, duration_sec=200.0, overshoot_sec=60.0)
    fake = Fake(provider=lrc(), reports=[overshooting, CLEAN])
    await run_align(JOB, fake)

    assert fake.timed[0].search_spans() == fake.timed[0].text.windows
    assert fake.timed[1].drop_windows is True
    assert fake.timed[1].search_spans() == fake.timed[1].text.segments


async def test_no_vocals_stem_never_offers_the_mix_knob() -> None:
    """Already aligning on the mix, so that knob would spend a pass for an identical result."""
    fake = Fake(provider=lrc(), reports=[THIN, CLEAN], vocals=False)
    await run_align(JOB, fake)
    assert all(Knob.ALIGN_ON_MIX not in req.knobs for req in fake.timed)


# ── the ASR fallback ladder ──────────────────────────────────────────────────────────────────────


async def test_a_candidate_that_cannot_be_timed_falls_through_to_asr() -> None:
    """THE headline fix. The old worker discarded the ASR text before timing, so this ended the job."""
    plain = TextRef(tier=Tier.CANDIDATE, label="plain", segments=({"text": "hello"},))
    fake = Fake(provider=plain, transcribed=asr_text(), reports=[INCOHERENT, CLEAN])

    outcome = await run_align(JOB, fake)

    assert "transcribe:vocals" in fake.calls, "ASR must be requested once the candidate is exhausted"
    assert outcome.published is not None
    assert outcome.published.label == "asr:vocals"


async def test_no_text_at_all_still_transcribes_before_giving_up() -> None:
    """An empty pool is not evidence of an instrumental until ASR has had its turn."""
    fake = Fake(transcribed=asr_text(), reports=[CLEAN])
    outcome = await run_align(JOB, fake)

    assert "transcribe:vocals" in fake.calls
    assert outcome.published is not None, "ASR alone is enough to publish lyrics"


async def test_a_silent_stem_falls_back_to_transcribing_the_mix() -> None:
    """An over-suppressed stem yields nothing; the mix is a different question and gets asked."""
    fake = Fake(transcribed=None, transcribed_on_mix=asr_text("asr:mix"), reports=[CLEAN])
    outcome = await run_align(JOB, fake)

    assert fake.calls.count("transcribe:vocals") == 1
    assert fake.calls.count("transcribe:mix") == 1
    assert outcome.published is not None and outcome.published.label == "asr:mix"


async def test_no_lyrics_only_after_asr_produced_nothing() -> None:
    """The absolute worst case, and it must be earned: both ASR attempts heard nothing."""
    fake = Fake(transcribed=None, transcribed_on_mix=None)
    outcome = await run_align(JOB, fake)

    assert outcome.no_lyrics is True
    assert fake.calls.count("transcribe:vocals") == 1
    assert fake.calls.count("transcribe:mix") == 1
    assert "produced no text" in outcome.why


async def test_no_lyrics_is_still_published() -> None:
    """Readiness waits on align, so a silent completion strands the song in "processing" forever."""
    fake = Fake(transcribed=None, transcribed_on_mix=None)
    outcome = await run_align(JOB, fake)

    assert "publish" in fake.calls
    assert fake.published is None, "the no-lyrics outcome publishes, carrying no document"
    assert outcome.no_lyrics is True


async def test_asr_is_attempted_only_once_even_if_its_text_is_unusable() -> None:
    """Otherwise the flow loops between an empty pool and a transcriber that keeps disappointing."""
    fake = Fake(transcribed=asr_text(), reports=[INCOHERENT])
    outcome = await run_align(JOB, fake)

    assert fake.calls.count("transcribe:vocals") == 1
    assert outcome.no_lyrics is True


# ── a step that produces nothing ─────────────────────────────────────────────────────────────────


NOTHING = TimingReport(words=0, coverage=0.0)


async def test_a_time_step_returning_none_is_judged_not_crashed() -> None:
    """`time_text` yielding None is an unusable report, not an error — the search simply tries again."""
    fake = Fake(provider=lrc(), reports=[NOTHING, CLEAN])
    outcome = await run_align(JOB, fake)

    assert len(fake.timed) == 2, "a None result must provoke another attempt, not an exception"
    assert outcome.published is not None


async def test_every_attempt_producing_nothing_ends_in_no_lyrics_not_a_crash() -> None:
    """The floor. Nothing could be timed anywhere, so the honest answer is "no lyrics" — and it is
    still published, because readiness waits on align."""
    fake = Fake(provider=lrc(), transcribed=asr_text(), reports=[NOTHING] * 8)
    outcome = await run_align(JOB, fake)

    assert outcome.no_lyrics is True
    assert "transcribe:vocals" in fake.calls, "ASR still had to be tried before concluding this"
    assert "publish" in fake.calls


# ── the ownership guard ──────────────────────────────────────────────────────────────────────────


async def test_a_lost_lease_at_publish_is_a_normal_outcome() -> None:
    """The core reassigned the job mid-alignment. Another worker owns it; this is not an error."""
    fake = Fake(provider=lrc(), reports=[CLEAN], publish_raises=NotOurJob("reassigned to w2"))
    outcome = await run_align(JOB, fake)

    assert outcome.published is None
    assert "abandoned before publishing" in outcome.why
    assert "reassigned to w2" in outcome.why


async def test_an_infrastructure_failure_still_raises() -> None:
    """No audio means nothing can substitute. Unlike a lyric outcome, this must fail the job."""

    class NoAudio(Fake):
        async def acquire_audio(self, job: JobRef) -> AudioRef:
            raise RuntimeError("video unavailable")

    with pytest.raises(RuntimeError, match="video unavailable"):
        await run_align(JOB, NoAudio())


# ── the decision trail ───────────────────────────────────────────────────────────────────────────


async def test_outcome_carries_the_decision_trail() -> None:
    """ "Why did this job publish these lyrics" must be answerable from the completion payload."""
    fake = Fake(provider=lrc(), reports=[THIN, CLEAN])
    outcome = await run_align(JOB, fake)

    verdicts = [e["verdict"] for e in outcome.trail]
    assert "retime" in verdicts and "accept" in verdicts
    assert all("why" in e for e in outcome.trail)


async def test_state_notes_name_the_knob_in_play() -> None:
    """An operator watching a slow job should see "retrying on the mix", not just a percentage."""
    fake = Fake(provider=lrc(), reports=[THIN, CLEAN])
    await run_align(JOB, fake)

    knobs = [knob for _state, _verdict, knob in fake.notes if knob]
    assert Knob.ALIGN_ON_MIX.value in knobs


async def test_acquire_note_records_whether_a_stem_exists() -> None:
    """Aligning on the mix is materially less accurate, so it must be visible, not silent."""
    fake = Fake(provider=lrc(), reports=[CLEAN], vocals=False)
    await run_align(JOB, fake)
    assert any(state == "acquire" for state, _v, _k in fake.notes)


# ── the reference is threaded, and not across texts ───────────────────────────────────────────────


async def test_a_reshift_receives_the_previous_attempts_line_starts() -> None:
    """The workflow must carry the last alignment forward, or the knob has nothing to place against."""
    fake = Fake(provider=lrc(), reports=[MISPLACED, CLEAN])
    await run_align(JOB, fake)

    assert len(fake.timed) == 2
    assert fake.timed[0].reference_starts == (), "the first attempt has no reference"
    assert fake.timed[1].reference_starts != (), "the retry must be handed the previous alignment"


async def test_a_reference_is_not_carried_across_different_texts() -> None:
    """Another source's line count and ordering are not a ruler for this one — pairing is by ORDER, so a
    mismatched series would produce a confident and wrong shift."""
    plain = TextRef(tier=Tier.CANDIDATE, label="plain", segments=({"text": "hello"},))
    fake = Fake(provider=plain, transcribed=asr_text(), reports=[INCOHERENT, CLEAN])
    await run_align(JOB, fake)

    moved_on = [req for req in fake.timed if req.text.label == "asr:vocals"]
    assert moved_on, "the search must reach the ASR tier"
    assert moved_on[0].reference_starts == (), "a new text starts with no reference"
