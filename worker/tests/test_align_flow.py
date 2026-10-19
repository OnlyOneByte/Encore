"""The align flow end to end, driven by fakes.

No DBOS, no SQLite, no models, no network, no audio. That is the point of `run_align` taking its step
surface as an argument: the state machine is exercised as a state machine, and the scenarios below are
the ones that used to require a real alignment pass to observe.

The fake records every call, so a test asserts on WHAT RAN, not only on the outcome. "A job whose first
candidate is good never runs a model" is a claim about cost, and only the call log can check it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import replace

import pytest

from encore_worker.adapters.cli import OutOfMemory
from encore_worker.adapters.ml import ModelUnavailable
from encore_worker.adapters.ports import InfraFault
from encore_worker.domain.lyrics.policy import Knob, Tier
from encore_worker.domain.lyrics.report import Engine, TimingReport
from encore_worker.protocol import frames as f
from encore_worker.steps.api import NotOurJob
from encore_worker.steps.records import (
    TIMING_LINE,
    TIMING_WORD,
    AudioRef,
    JobRef,
    Refused,
    TextRef,
    TimedDoc,
    TimeRequest,
)
from encore_worker.workflows.align import run_align
from tests.test_client import FakeSocket, Session, assign, client

JOB = JobRef(job_id="j1", media_id="m1", media_dir="/media/m1", source_uri="https://x.test/v")

#: The retry ladder's defects are WINDOWED reports: the global engine reads only LINE_SYNC (review H2).
WINDOWED = Engine.WINDOWED
CLEAN = TimingReport(words=200, coverage=1.0, duration_sec=200.0)
THIN = TimingReport(words=40, coverage=0.25, duration_sec=200.0, engine=WINDOWED)
INCOHERENT = TimingReport(words=200, coverage=1.0, duration_sec=200.0, out_of_order=9)
MISPLACED = TimingReport(words=200, coverage=1.0, duration_sec=200.0, residual_sec=-6.0, engine=WINDOWED)
LINE_SYNCED = TimingReport(coverage=0.9, duration_sec=200.0, engine=Engine.LINE_SYNC, lines=12)
REFUSED = TimingReport(duration_sec=200.0, refused="envelope gate refused: blind r=0.09 @ -5.10s")
NOTHING = TimingReport(words=0, coverage=0.0)


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
        providers: list[TextRef] | None = None,
        machine: TextRef | None = None,
        transcribed: TextRef | None = None,
        transcribed_on_mix: TextRef | None = None,
        reports: list[TimingReport] | None = None,
        vocals: bool = True,
        publish_raises: Exception | None = None,
        faults: dict[int, Exception] | None = None,
        pinned: TextRef | None = None,
    ) -> None:
        self._authored = authored
        #: EVERY provider's sheet (review M13). `provider=` is the one-sheet shorthand the existing cases
        #: use; `providers=` is how a case puts two in the pool.
        self._providers = list(providers) if providers is not None else ([provider] if provider else [])
        self._machine = machine
        self._transcribed = transcribed
        self._transcribed_on_mix = transcribed_on_mix
        self._reports = list(reports or [])
        self._vocals = vocals
        self._publish_raises = publish_raises
        #: `time_text` call number (from 1) -> the exception that call raises: a machinery fault mid-job.
        self._faults = dict(faults or {})
        #: What `fetch_pinned_text` serves a pinned job (review H5); None = the pin could not be read.
        self._pinned = pinned
        self.calls: list[str] = []
        self.timed: list[TimeRequest] = []
        self.notes: list[tuple[str, str, str | None]] = []
        #: Each note's `why`, parallel to `notes`.
        self.whys: list[str] = []
        self.published: TimedDoc | None = None
        #: What `publish` was asked to place in the store: every document the job wrote (review W1 r1).
        self.placed: list[TimedDoc] = []
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

    async def fetch_provider_lyrics(self, job: JobRef, audio: AudioRef) -> list[TextRef]:
        self.calls.append("fetch_provider_lyrics")
        return list(self._providers)

    async def fetch_pinned_text(self, job: JobRef) -> TextRef | None:
        self.calls.append("fetch_pinned_text")
        return self._pinned

    async def transcribe(self, job: JobRef, audio: AudioRef, *, on_vocals: bool) -> TextRef | None:
        self.calls.append(f"transcribe:{'vocals' if on_vocals else 'mix'}")
        return self._transcribed if on_vocals else self._transcribed_on_mix

    async def time_text(self, req: TimeRequest) -> TimedDoc | Refused | None:
        self.calls.append(f"time_text:{req.text.label}")
        self.timed.append(req)
        if len(self.timed) in self._faults:
            raise self._faults[len(self.timed)]
        report = self._reports.pop(0) if self._reports else CLEAN
        if report.refused is not None:
            return Refused(report)  # a gate judged the text wrong for this audio
        if report.words == 0 and report.lines == 0:
            return None  # the step produced nothing publishable
        knobs = "".join(f"-{knob.value}" for knob in Knob if knob in req.knobs)
        return TimedDoc(
            # Knob-bearing, as the real `_write` makes it, so no retry shares its attempt's ref.
            ref=f"derived/lyrics/{req.text.label}{knobs}.json",
            timing=TIMING_LINE if report.engine is Engine.LINE_SYNC else TIMING_WORD,
            confidence="high",
            report=report,
            tier=req.text.tier,
            label=req.text.label,
            # A real record carries these, and the workflow threads them into the next attempt as the
            # RESHIFT reference. A fake that omitted them made the knob look like a no-op.
            line_starts=tuple(float(n) * 10.0 for n in range(len(req.text.segments) or 1)),
        )

    async def diarize(self, job: JobRef, audio: AudioRef, doc: TimedDoc) -> TimedDoc:
        self.calls.append("diarize")
        return doc

    async def publish(self, job: JobRef, doc: TimedDoc | None, *, placing: Sequence[TimedDoc] = ()) -> str:
        self.calls.append("publish")
        self.publish_count += 1
        if self._publish_raises is not None:
            raise self._publish_raises
        self.published = doc
        self.placed = list(placing)
        return "media/m1.mp3"

    async def note(
        self, job: JobRef, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        self.notes.append((state, verdict, knob))
        self.whys.append(why)


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
    overshooting = TimingReport(
        words=200, coverage=1.0, duration_sec=200.0, overshoot_sec=60.0, engine=WINDOWED
    )
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


# ── engine-aware policy + best-so-far (review H2) ────────────────────────────────────────────────


async def test_thin_global_coverage_publishes_the_stem_document_with_no_mix_retry() -> None:
    """H2 as a workflow: a long instrumental outro (coverage 71% on Kinematic, 0 gross) used to spend a
    mix re-decode that either replaced the stem document (Pure_Mids 0 -> 13 gross) or, refused, dropped
    the song to NO LYRICS. The global engine reads no mix knob, so the stem document publishes."""
    thin_global = TimingReport(words=150, coverage=0.71, duration_sec=200.0)
    fake = Fake(provider=lrc(), reports=[thin_global])
    outcome = await run_align(JOB, fake)
    assert len(fake.timed) == 1 and fake.timed[0].on_mix is False
    assert outcome.published is not None and outcome.published.report is thin_global


async def test_a_worse_retry_publishes_the_attempt_it_retried() -> None:
    """Best-so-far: a mix retry covering LESS than the stem attempt loses to it, and the stem attempt's
    OWN document is what publishes — its record, and its file (the knob is in the retry's ref)."""
    worse = TimingReport(words=30, coverage=0.2, duration_sec=200.0, engine=WINDOWED)
    fake = Fake(provider=lrc(), reports=[THIN, worse])
    outcome = await run_align(JOB, fake)
    assert [req.on_mix for req in fake.timed] == [False, True]
    assert outcome.published is not None and outcome.published.report is THIN
    assert outcome.published.ref == "derived/lyrics/lrclib.json"
    assert [d.ref for d in outcome.candidates] == [
        "derived/lyrics/lrclib.json",
        "derived/lyrics/lrclib-align-on-mix.json",
    ], "both attempts wrote, both are reported, and neither overwrote the other"
    assert "keeping attempt 1" in outcome.why


async def test_a_retry_that_produced_nothing_publishes_the_attempt_it_retried() -> None:
    """Before best-so-far, a Retime returning None left `pending` empty: the usable first document was
    lost to line sync or the next text."""
    fake = Fake(provider=lrc(), transcribed=asr_text(), reports=[MISPLACED, NOTHING])
    outcome = await run_align(JOB, fake)
    assert len(fake.timed) == 2 and fake.timed[1].reshift is True
    assert outcome.published is not None and outcome.published.report is MISPLACED
    assert not any(c.startswith("transcribe") for c in fake.calls)


# ── line sync commits, and never after a refusal (review M1 + the W0 hazard) ──────────────────────


async def test_an_incoherent_document_line_syncs_and_the_line_document_publishes() -> None:
    """M1 end to end: the LINE_SYNC attempt's line-timed document is committed, not dropped for the
    next text (which, with none left, was ASR and then NO LYRICS)."""
    fake = Fake(provider=lrc(), transcribed=asr_text(), reports=[INCOHERENT, LINE_SYNCED])
    outcome = await run_align(JOB, fake)
    assert [req.force_line_sync for req in fake.timed] == [False, True]
    assert outcome.published is not None and outcome.published.timing == TIMING_LINE
    assert outcome.published.ref == "derived/lyrics/lrclib-line-sync.json"
    assert not any(c.startswith("transcribe") for c in fake.calls)


async def test_a_refused_text_is_never_line_synced() -> None:
    """The wrong-text hole: a timed text the envelope gate refused used to retry LINE_SYNC, whose line
    timings pass no gate there. Refused ends the text: the next source is tried instead."""
    fake = Fake(provider=lrc(), transcribed=asr_text(), reports=[REFUSED, CLEAN])
    outcome = await run_align(JOB, fake)
    assert [req.text.label for req in fake.timed] == ["lrclib", "asr:vocals"]
    assert not any(req.force_line_sync for req in fake.timed)
    assert outcome.published is not None and outcome.published.label == "asr:vocals"
    assert outcome.candidates == (outcome.published,), "a refusal writes no document"


# ── the cross-kind comparison (W4): a usable word document against the sheet's own timings ────────


#: A publishable GLOBAL word document `reconcile` could fit NO map between and the text's OWN claims (W4):
#: `policy.decide` rule 6's one shape, and the only route to the LINE_SYNC rung from a document that could
#: have published. 12 lines, so `LINE_SYNCED` above times as many.
UNRELATED = TimingReport(words=200, coverage=1.0, duration_sec=200.0, lines=12, claims_related=False)
#: The LINE_SYNC rung's own gate refusing the SHEET (W3): its blind decode does not hear the lines where the
#: sheet claims them. Not a verdict on the words — the word document passed the same lexical gate.
LINE_REFUSED = TimingReport(
    duration_sec=200.0,
    engine=Engine.LINE_SYNC,
    lines=12,
    refused="47% of 12 decoded lines within 1.0s of their mapped claim, below 50%",
)


async def test_a_word_document_nothing_related_to_its_claims_publishes_the_sheets_own_timings() -> None:
    """W4 end to end: the word document is USABLE — it would have published on arrival order — and the
    sheet's line timings replace it because `reconcile` could relate nothing between the two witnesses and
    the line document survived its own gate. The 18 song-modes this fires on at `run_align` hold ALL 299 of
    their gross lines (PLAN W4 (b))."""
    fake = Fake(provider=lrc(), transcribed=asr_text(), reports=[UNRELATED, LINE_SYNCED])
    outcome = await run_align(JOB, fake)
    assert [req.force_line_sync for req in fake.timed] == [False, True]
    assert outcome.published is not None and outcome.published.timing == TIMING_LINE
    assert outcome.published.ref == "derived/lyrics/lrclib-line-sync.json"
    assert not any(c.startswith("transcribe") for c in fake.calls)
    assert any("nothing relates these timings" in why for why in fake.whys), "rule 6 is on the trail"


async def test_the_words_publish_when_the_rungs_gate_refuses_the_sheet_and_are_not_withdrawn() -> None:
    """Two rules meeting. Best-so-far: a line document its own gate refused loses to the word document it
    retried, which publishes (the refusal says the SHEET'S CLOCK is unreadable, not that the words are
    wrong — they passed the same lexical gate). And a text this job PUBLISHES must not ride out on
    `outcome.refused`, which is what makes the frame withdraw an earlier job's candidate for those same
    words (`align_text.superseded_candidates`): withdrawing them here would delete the document we just
    published from the room's alternatives."""
    fake = Fake(provider=lrc(), transcribed=asr_text(), reports=[UNRELATED, LINE_REFUSED])
    outcome = await run_align(JOB, fake)
    assert [req.force_line_sync for req in fake.timed] == [False, True]
    assert outcome.published is not None and outcome.published.timing == TIMING_WORD
    assert outcome.published.ref == "derived/lyrics/lrclib.json", "attempt 1, by serial"
    assert outcome.refused == (), "the published text is not a refused text"
    assert any("line-sync retry was refused" in why for why in fake.whys), "the refusal stays on the trail"
    assert not any(c.startswith("transcribe") for c in fake.calls), "and the text is not abandoned"


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


def machine(label: str = "captions:machine") -> TextRef:
    """YouTube's automatic track: line-timed, the MACHINE tier."""
    return TextRef(
        tier=Tier.MACHINE,
        label=label,
        segments=({"start": 0.0, "end": 2.0, "text": "hello"},),
        timing=TIMING_LINE,
    )


# ── a machinery fault fails the job instead of walking the ladder (review M7) ─────────────────────


async def test_a_machinery_fault_fails_the_job_instead_of_ending_in_no_lyrics() -> None:
    """A model download that answered 503 fails every attempt of every text alike. As a declined attempt
    it walked the ladder: every text, every line-sync rung, whisper, and a published "no lyrics" (measured
    through the real steps: 7 declines, machine captions tried twice). It must fail the job, once."""
    fault = InfraFault("loading the 'en' alignment model failed (OSError: HTTP Error 503)")
    fake = Fake(
        authored=lrc("captions:authored"),
        provider=lrc(),
        machine=machine(),
        transcribed=asr_text(),
        faults={1: fault},
    )
    with pytest.raises(InfraFault) as raised:
        await run_align(JOB, fake)
    assert raised.value is fault and raised.value.retryable is True
    assert [c for c in fake.calls if c.startswith("time_text")] == ["time_text:captions:authored"]
    assert not any(c.startswith("transcribe") for c in fake.calls), "whisper must not run for a dead model"
    assert "publish" not in fake.calls, "no outcome is published for a job that failed"


@pytest.mark.parametrize(
    "fault",
    [
        ModelUnavailable("torchaudio's CTC kernel (`torchaudio.functional.forced_align`) is gone"),
        OutOfMemory("the emission pass on mps ran out of memory (RuntimeError: MPS backend out of memory)"),
    ],
    ids=["kernel-gone", "out-of-memory"],
)
async def test_a_deterministic_machinery_fault_keeps_its_non_retryable_flag(fault: InfraFault) -> None:
    """The same box fails the same way again, so these say `retryable = False` and the job must carry it
    out unchanged: nothing between the step and the transport re-wraps it."""
    fake = Fake(provider=lrc(), transcribed=asr_text(), faults={1: fault})
    with pytest.raises(InfraFault) as raised:
        await run_align(JOB, fake)
    assert raised.value is fault and raised.value.retryable is False


async def test_a_machinery_fault_on_a_later_text_still_fails_the_job() -> None:
    """The first text was judged (refused); the fault arrives on the next one. It is not a lyric outcome
    either: the ladder is not walked around it, and nothing publishes."""
    fault = InfraFault("the emission pass on mps failed (RuntimeError: MPS backend failure)")
    fake = Fake(authored=lrc("captions:authored"), provider=lrc(), reports=[REFUSED], faults={2: fault})
    with pytest.raises(InfraFault):
        await run_align(JOB, fake)
    assert [req.text.label for req in fake.timed] == ["captions:authored", "lrclib"]
    assert "publish" not in fake.calls and not any(c.startswith("transcribe") for c in fake.calls)


async def test_a_machinery_fault_reaches_the_wire_as_a_retryable_failure() -> None:
    """The whole chain with fakes: the step's fault through `run_align` to the transport's `job:failed`
    frame, whose `retryable` is the fault's own and whose error is its diagnosis."""
    for fault, retryable in (
        (InfraFault("loading the 'en' alignment model failed (OSError: HTTP Error 503)"), True),
        (ModelUnavailable("torchaudio's CTC kernel is gone"), False),
    ):

        async def run_job(_assign: f.Assign, fault: InfraFault = fault) -> f.Complete:
            await run_align(JOB, Fake(provider=lrc(), faults={1: fault}))
            raise AssertionError("run_align must raise a machinery fault, not return")

        sock = FakeSocket([assign()])
        async with Session(client(sock, run_job=run_job), sock):
            pass
        failed = sock.first("job:failed")
        assert (failed["error"], failed["retryable"]) == (str(fault), retryable)
        assert "job:complete" not in sock.types()


async def test_the_machine_track_is_tried_once_even_after_asr_declines() -> None:
    """Review s11: the on-demand ASR text was SORTED into the walk ahead of the machine captions it ran
    after, so when it declined the cursor walked onto them again: both machine attempts twice."""
    fake = Fake(
        authored=lrc("captions:authored"),
        machine=machine(),
        transcribed=asr_text(),
        reports=[NOTHING] * 12,
    )
    outcome = await run_align(JOB, fake)
    assert [req.text.label for req in fake.timed] == [
        "captions:authored",
        "captions:authored",  # its line-sync rung
        "captions:machine",
        "captions:machine",  # its line-sync rung
        "asr:vocals",
    ]
    assert outcome.no_lyrics is True and fake.calls.count("transcribe:vocals") == 1


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


async def test_a_retry_after_a_lost_one_extends_and_re_places_against_the_kept_attempt() -> None:
    """Best-so-far goes BACK to the attempt a retry lost to, and the next knob starts from it (review W1
    r1): DROP_WINDOWS leaves the overshoot as it was, so RESHIFT runs next — WITH the windows (the lost
    knob is not applied), on attempt 1's knob set, and re-placed against attempt 1's line starts, not the
    losing retry's. That RESHIFT fixes it, and is what publishes."""

    class Numbered(Fake):
        """Every attempt's document carries its own attempt number as its line starts."""

        async def time_text(self, req: TimeRequest) -> TimedDoc | Refused | None:
            got = await super().time_text(req)
            return replace(got, line_starts=(float(len(self.timed)),)) if isinstance(got, TimedDoc) else got

    over = TimingReport(words=150, coverage=1.0, duration_sec=200.0, overshoot_sec=40.0, engine=WINDOWED)
    fixed = TimingReport(words=150, coverage=1.0, duration_sec=200.0, engine=WINDOWED)
    fake = Numbered(provider=lrc(), reports=[over, over, fixed])
    outcome = await run_align(JOB, fake)

    assert [req.knobs for req in fake.timed] == [
        frozenset(),
        frozenset({Knob.DROP_WINDOWS}),
        frozenset({Knob.RESHIFT}),
    ], "the third attempt extends the first, not the retry that lost"
    assert fake.timed[2].reference_starts == (1.0,), "re-placed against the KEPT attempt's alignment"
    assert outcome.published is not None and outcome.published.ref == "derived/lyrics/lrclib-reshift.json"
    assert [n for n in fake.notes if n[0] == "time"][2] == ("time", "try", Knob.RESHIFT.value)


async def test_a_reference_is_not_carried_across_different_texts() -> None:
    """Another source's line count and ordering are not a ruler for this one — pairing is by ORDER, so a
    mismatched series would produce a confident and wrong shift."""
    plain = TextRef(tier=Tier.CANDIDATE, label="plain", segments=({"text": "hello"},))
    fake = Fake(provider=plain, transcribed=asr_text(), reports=[INCOHERENT, CLEAN])
    await run_align(JOB, fake)

    moved_on = [req for req in fake.timed if req.text.label == "asr:vocals"]
    assert moved_on, "the search must reach the ASR tier"
    assert moved_on[0].reference_starts == (), "a new text starts with no reference"


# ── candidates: what core needs to clean up after us ──────────────────────────────────────────────


async def test_every_written_document_is_reported_as_a_candidate() -> None:
    """NOT decoration. Core's retention sweep builds its cleanup set from `lyricsCandidates`
    (`retention.ts:182`), so a document this worker wrote and did not declare is never enumerated and
    therefore never evicted — it leaks for the life of the library.

    Only the LATEST attempt used to be kept (`pending`), so every superseded attempt's file was orphaned on
    disk the moment a retry improved on it.
    """
    steps = Fake(provider=lrc(), reports=[CLEAN])
    outcome = await run_align(JOB, steps)

    assert outcome.published is not None
    assert len(outcome.candidates) == 1
    assert outcome.candidates[0].ref == outcome.published.ref


async def test_a_superseded_attempt_is_still_reported() -> None:
    """The retry's own file is on disk too. Reporting only the winner leaks every earlier attempt — and a
    job that retimes three times leaves three files, of which core can name one."""
    # First attempt is misplaced, so the search retimes it: two documents written, one published.
    steps = Fake(provider=lrc(), reports=[MISPLACED, CLEAN])
    outcome = await run_align(JOB, steps)

    assert len(outcome.candidates) >= 2, "each attempt wrote a document, so each must be nameable"
    refs = [d.ref for d in outcome.candidates]
    assert len(refs) == len(set(refs)), "the knob is in the ref, so a retime never rewrites its attempt's"
    assert outcome.published is not None
    assert outcome.published.ref in refs


async def test_a_job_that_lost_its_lease_placed_nothing_and_reports_nothing() -> None:
    """Attempts are staged in job scratch and `publish` places them only after the ownership check (review
    W1 r1), so a job that is no longer ours put nothing in the store: there is nothing for core to name,
    and the scratch goes with the job. (It used to report the files it had written straight into the
    store, which an `InfraFault` before `publish` could not do at all.)"""
    steps = Fake(provider=lrc(), reports=[CLEAN], publish_raises=NotOurJob("gone"))
    outcome = await run_align(JOB, steps)

    assert outcome.published is None and outcome.candidates == ()
    assert "abandoned before publishing" in outcome.why


async def test_publish_is_asked_to_place_every_attempt_and_reports_their_store_refs() -> None:
    """Every document the job wrote goes to `publish` to be placed (the published one and the one it beat),
    and the outcome names each under its STORE ref, which is what core's retention and re-pick read."""
    worse = TimingReport(words=30, coverage=0.2, duration_sec=200.0, engine=WINDOWED)
    fake = Fake(provider=lrc(), reports=[THIN, worse])
    outcome = await run_align(JOB, fake)
    assert [d.ref for d in fake.placed] == [
        "derived/lyrics/lrclib.json",
        "derived/lyrics/lrclib-align-on-mix.json",
    ]
    assert outcome.published is not None and outcome.published.ref == "derived/lyrics/lrclib.json"
    assert [d.ref for d in outcome.candidates] == [d.ref for d in fake.placed]


async def test_a_machinery_fault_mid_ladder_places_nothing() -> None:
    """Review W1 r1's scenario: text 1's attempt wrote a document and was retried away; text 2's attempt hit
    a transient fault. The job fails, and `publish` — the only thing that puts an attempt in the store —
    never ran, so the store holds nothing the failed job wrote."""
    fault = InfraFault("decoding the stem through ffmpeg failed (RuntimeError: Broken pipe)")
    fake = Fake(
        authored=lrc("captions:authored"), provider=lrc(), reports=[INCOHERENT, NOTHING], faults={3: fault}
    )
    with pytest.raises(InfraFault):
        await run_align(JOB, fake)
    assert len(fake.timed) == 3 and "publish" not in fake.calls and fake.placed == []


async def test_the_texts_a_gate_refused_ride_on_the_outcome() -> None:
    """Review W1 r2 (M3). A refused attempt writes nothing, so without naming the refused TEXTS the frame
    could not withdraw a candidate an earlier job stored for the same words (`superseded_candidates`).
    One entry per label, whichever rung refused it; none from a lost lease."""
    authored = lrc("captions:authored")
    fake = Fake(authored=authored, provider=lrc(), transcribed=asr_text(), reports=[REFUSED, REFUSED, CLEAN])
    outcome = await run_align(JOB, fake)
    assert outcome.published is not None and outcome.published.label == "asr:vocals"
    assert [text.label for text in outcome.refused] == ["captions:authored", "lrclib"]
    assert outcome.refused[0] == authored

    line_synced = Fake(provider=lrc(), transcribed=asr_text(), reports=[INCOHERENT, REFUSED, CLEAN])
    assert [t.label for t in (await run_align(JOB, line_synced)).refused] == ["lrclib"], "LINE_SYNC's gate"

    lost = Fake(
        provider=lrc(), transcribed=asr_text(), reports=[REFUSED, CLEAN], publish_raises=NotOurJob("x")
    )
    assert (await run_align(JOB, lost)).refused == ()


# ── review M13: every provider is a candidate, and corroboration orders the tier ───────────────────


def sheet(label: str, *lines: str) -> TextRef:
    """A provider sheet with its own words, so two of them can agree or disagree about the song."""
    return TextRef(
        tier=Tier.CANDIDATE,
        label=label,
        segments=tuple({"start": float(n), "end": n + 2.0, "text": line} for n, line in enumerate(lines)),
        timing=TIMING_LINE,
        language="en",
    )


NUMB = ("I've become so numb", "I can't feel you there", "Become so tired, so much more aware")
HELLO = ("Hello from the other side", "I must have called a thousand times", "To tell you I'm sorry")


async def test_every_providers_sheet_reaches_the_pool() -> None:
    """lrcmux is first in the chain, so returning only its hit meant LRCLIB was consulted exactly when
    lrcmux was UNREACHABLE and never when it merely answered with a worse sheet."""
    fake = Fake(
        providers=[sheet("lrcmux:KuGou", *HELLO), sheet("lrclib", *NUMB)],
        reports=[REFUSED, CLEAN],
    )
    await run_align(JOB, fake)

    assert [t.text.label for t in fake.timed] == ["lrcmux:KuGou", "lrclib"]


async def test_the_corroborated_text_is_tried_first_even_when_it_arrived_last() -> None:
    """The measured case (Hello): the SDH authored caption track went first because it was FETCHED first,
    and published over a clean provider sheet. Here the upload's own track and the LRCLIB sheet agree —
    two INDEPENDENT witnesses (`policy.witness_of`) — so the lrcmux sheet that agrees with neither drops
    behind the one that arrived after it, and nothing about tier ordering moved."""
    fake = Fake(
        authored=sheet("captions:authored", *NUMB),
        providers=[sheet("lrcmux:KuGou", *HELLO), sheet("lrclib", *NUMB[:2])],
        reports=[REFUSED, REFUSED, CLEAN],
    )
    await run_align(JOB, fake)

    assert [t.text.label for t in fake.timed] == ["captions:authored", "lrclib", "lrcmux:KuGou"]
    assert fake.calls.count("fetch_provider_lyrics") == 1, "one step, every provider"


async def test_two_provider_sheets_agreeing_are_one_witness_and_promote_neither() -> None:
    """W5 review r1-correctness-4 / r1-spec-12. `fetch_provider_lyrics` asks every provider the SAME
    artist/track and LRCLIB is one of lrcmux's own upstreams, so two sheets that agree can be ONE answer
    reached twice — a metadata mismatch returns two copies of the wrong song's sheet. Counted as two
    witnesses, that pair was tried ahead of the upload's own caption track, the one text in the pool that
    can only be about this recording. Arrival order instead, which is what it was before M13."""
    fake = Fake(
        authored=sheet("captions:authored", *HELLO),
        providers=[sheet("lrcmux:KuGou", *NUMB), sheet("lrclib", *NUMB[:2])],
        reports=[REFUSED, REFUSED, CLEAN],
    )
    await run_align(JOB, fake)

    assert [t.text.label for t in fake.timed] == ["captions:authored", "lrcmux:KuGou", "lrclib"]


async def test_a_pool_where_nothing_agrees_walks_in_arrival_order() -> None:
    """The change is a TIE-BREAK, so a pool with no corroboration behaves exactly as it did before."""
    fake = Fake(
        authored=sheet("captions:authored", *HELLO),
        providers=[sheet("lrclib", *NUMB)],
        reports=[REFUSED, CLEAN],
    )
    await run_align(JOB, fake)

    assert [t.text.label for t in fake.timed] == ["captions:authored", "lrclib"]
