"""END TO END through REAL DBOS: a launched instance, a real SQLite file, real `@DBOS.step` registration.

Everything else in the suite drives `run_align` with fakes, which proves the state machine but says nothing
about the thing the architecture bets on: that DBOS actually registers these steps, checkpoints them and
resumes. `workflows/dbos_align.py` guessed at `DBOS.step`'s signature and carried a `TypeError` fallback, so
until this file existed the durable path had never run once. The heavy seams are still faked; what is real
here is DBOS — the registration, the checkpoint writes and the workflow-status bookkeeping.

Marked `dbos` so it can be deselected: it writes a SQLite file and takes seconds, where the rest of the
suite is milliseconds.
"""

from __future__ import annotations

import asyncio
import sqlite3
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest

from encore_worker.adapters import cli, ports
from encore_worker.adapters.ports import InfraFault
from encore_worker.domain.document import TIMING_LINE
from encore_worker.domain.lyrics.policy import Tier
from encore_worker.domain.lyrics.report import TimingReport
from encore_worker.host.config import Config
from encore_worker.protocol.vocabulary import Stage
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.records import AudioRef, JobRef, TextRef
from encore_worker.workflows.align import run_align

pytestmark = [
    pytest.mark.dbos,
    # On Python >= 3.12 DBOS's SQLite schema stamps every row with `unixepoch('subsec')`, which SQLite
    # added in 3.42. An older SQLite answers NULL and every DBOS write fails `NOT NULL constraint failed`
    # (TL-15: Debian bookworm's python:3.12-slim links 3.40.1). That is the box, not this code.
    pytest.mark.skipif(
        sys.version_info >= (3, 12) and sqlite3.sqlite_version_info < (3, 42),
        reason=f"DBOS needs SQLite >= 3.42 for unixepoch('subsec'); this one is {sqlite3.sqlite_version}",
    ),
]


class Reporter:
    """Records what reached the wire; always confirms ownership."""

    def __init__(self) -> None:
        self.states: list[tuple[str, str, str | None]] = []

    async def progress(self, job_id: str, stage: Stage, pct: int) -> None:
        pass

    async def state(
        self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        self.states.append((state, verdict, knob))

    async def confirm_ownership(self, job_id: str, *, timeout_sec: float = 10.0) -> bool:
        return True

    def explain_ownership(self, job_id: str) -> str:
        return "ours"


class CountingAligner:
    """Counts alignments, so a resumed run can be shown NOT to redo completed work."""

    def __init__(self, *, reports: list[TimingReport] | None = None) -> None:
        self.calls = 0
        self._reports = list(reports or [])

    def align(self, search: Sequence[object], audio_path: str, language: str) -> Sequence[object]:
        self.calls += 1
        return [{"text": "hello", "words": [{"word": "hello", "start": 0.0, "end": 1.0}]}]


class Transcriber:
    def __init__(self) -> None:
        self.calls = 0

    def transcribe(self, audio_path: str, *, language: str | None = None) -> ports.Transcribed:
        self.calls += 1
        return ports.Transcribed(segments=({"start": 0.0, "end": 2.0, "text": "what was heard"},))


class Provider:
    name = "fake-provider"

    def __init__(self, cues: Sequence[object] = ()) -> None:
        self.cues = cues
        self.calls = 0
        self.last_source: str | None = None

    def fetch(self, *, artist: str, track: str, duration_sec: float | None) -> Sequence[object]:
        self.calls += 1
        return self.cues


LINE_CUES = ({"start": 0.0, "end": 2.0, "text": "hello there"},)


@pytest.fixture
def dbos_instance(tmp_path: Path):  # type: ignore[no-untyped-def]
    """A launched DBOS backed by a SQLite file in a temp directory.

    Destroyed after each test: DBOS keeps module-level registration state, so leaking an instance makes a
    later test register its steps against a dead handle.
    """
    dbos_mod = pytest.importorskip("dbos", reason="dbos is not installed")
    db = tmp_path / "e2e.sqlite"
    instance = dbos_mod.DBOS(
        config=dbos_mod.DBOSConfig(name="encore-worker-test", system_database_url=f"sqlite:///{db}")
    )
    dbos_mod.DBOS.launch()
    try:
        yield instance
    finally:
        dbos_mod.DBOS.destroy()


def build(tmp_path: Path, **adapters: object) -> tuple[AlignStepsImpl, Reporter]:
    reporter = Reporter()
    impl = AlignStepsImpl(
        config=Config(worker_id="w1"),
        adapters=Adapters(**adapters),  # type: ignore[arg-type]
        reporter=reporter,
    )
    return impl, reporter


def job_of(tmp_path: Path) -> JobRef:
    return JobRef(
        job_id="e2e-1",
        media_id="m1",
        media_dir=str(tmp_path),
        source_uri=str(tmp_path / "original.mp3"),
        params={"fetcher": "local", "artist": "a-ha", "track": "Take On Me"},
    )


# ── the durable path actually runs ────────────────────────────────────────────────────────────────


async def test_the_align_flow_runs_through_real_dbos_steps(dbos_instance: object, tmp_path: Path) -> None:
    """THE claim this file exists to check: the steps register with a live DBOS and the flow completes.

    Until this ran, `dbos_align._step` had only ever been exercised with `dbos=None`.
    """
    from encore_worker.workflows.dbos_align import DbosAlignSteps

    (tmp_path / "original.mp3").write_bytes(b"not really audio")
    impl, reporter = build(tmp_path, aligner=CountingAligner(), providers=(Provider(LINE_CUES),))

    steps = DbosAlignSteps(impl, dbos_instance)
    outcome = await run_align(job_of(tmp_path), steps)

    assert outcome.published is not None, f"expected a published doc, got: {outcome.why}"
    assert (tmp_path / outcome.published.ref).exists(), "the artifact must be on disk, not just recorded"
    assert outcome.trail, "the decision trail must survive the durable path"


async def test_steps_register_with_the_real_signature(dbos_instance: object, tmp_path: Path) -> None:
    """`_step` once carried a `TypeError` fallback for a DBOS whose `step()` signature might differ. The
    real signature takes `name`, `retries_allowed` and `max_attempts`, so the fallback was dead code
    masking the possibility of a wrong call — it is gone, and this pins the signature that replaced it.
    """
    from encore_worker.workflows import dbos_align

    calls: list[dict[str, object]] = []
    real_step = dbos_instance.step  # type: ignore[attr-defined]

    def spy(**kwargs: object) -> object:
        calls.append(kwargs)
        return real_step(**kwargs)

    dbos_instance.step = spy  # type: ignore[attr-defined]
    impl, _ = build(tmp_path, aligner=CountingAligner())
    dbos_align.DbosAlignSteps(impl, dbos_instance)

    assert calls, "no step was registered at all"
    assert all("max_attempts" in kw and "name" in kw for kw in calls), (
        f"the primary signature must be the one used; saw {calls[:1]}"
    )


async def test_retry_policy_differs_per_step(dbos_instance: object, tmp_path: Path) -> None:
    """Acquisition is worth retrying; a model step is not, because the search has a better answer than a
    retry — try the next knob, or the next text."""
    from encore_worker.workflows import dbos_align

    registered: dict[str, int] = {}
    real_step = dbos_instance.step  # type: ignore[attr-defined]

    def spy(**kwargs: object) -> object:
        attempts = kwargs.get("max_attempts")
        registered[str(kwargs.get("name"))] = attempts if isinstance(attempts, int) else 0
        return real_step(**kwargs)

    dbos_instance.step = spy  # type: ignore[attr-defined]
    impl, _ = build(tmp_path, aligner=CountingAligner())
    dbos_align.DbosAlignSteps(impl, dbos_instance)

    assert registered["acquire_audio"] > 1, "a transient network failure is the common case"
    assert registered["time_text"] == 1, "a failed alignment should move on, not repeat itself"
    assert registered["publish"] == 1, "a refused publish means another worker owns the job"


# ── the ASR fallback survives the durable path ────────────────────────────────────────────────────


async def test_the_asr_fallback_runs_end_to_end_through_dbos(dbos_instance: object, tmp_path: Path) -> None:
    """The headline behaviour, through real checkpointing: no provider text, so ASR is transcribed on
    demand and published."""
    from encore_worker.workflows.dbos_align import DbosAlignSteps

    (tmp_path / "original.mp3").write_bytes(b"x")
    transcriber = Transcriber()
    impl, reporter = build(tmp_path, aligner=CountingAligner(), transcriber=transcriber)

    outcome = await run_align(job_of(tmp_path), DbosAlignSteps(impl, dbos_instance))

    assert transcriber.calls >= 1, "ASR must be reached when no candidate produced text"
    assert outcome.published is not None
    assert outcome.published.label.startswith("asr:")
    assert any(verdict == "asr-fallback" for _s, verdict, _k in reporter.states)


async def test_a_pinned_paste_publishes_under_the_manual_key_through_dbos(
    dbos_instance: object, tmp_path: Path
) -> None:
    """Through real checkpointing: `fetch_pinned_text` is a registered step, the attempt goes to
    job scratch, and `publish` places it at the pinned ref. No provider is asked: the pin is the pool."""
    from dbos import DBOS

    from encore_worker.workflows.dbos_align import DbosAlignSteps

    (tmp_path / "original.mp3").write_bytes(b"x")
    provider = Provider(LINE_CUES)
    impl, _ = build(tmp_path, aligner=CountingAligner(), providers=(provider,))
    manual = "derived/lyrics/m1-manual-word.json"
    base = job_of(tmp_path)
    pinned = JobRef(
        job_id=base.job_id,
        media_id=base.media_id,
        media_dir=base.media_dir,
        source_uri=base.source_uri,
        params={**base.params, "pinnedRef": manual, "pinnedText": "hello\nit is me"},
    )

    @DBOS.workflow(name="e2e-pinned")
    async def flow(job: JobRef) -> str:
        outcome = await run_align(job, DbosAlignSteps(impl, dbos_instance))
        return outcome.published.ref if outcome.published is not None else outcome.why

    handle = await DBOS.start_workflow_async(flow, pinned)
    assert await handle.get_result() == manual
    assert (tmp_path / manual).is_file(), "the accepted attempt was placed at the pinned ref"
    assert provider.calls == 0
    steps = await DBOS.list_workflow_steps_async(handle.workflow_id)
    names = [str(s.get("function_name") or s.get("name") or "") for s in steps]
    assert any("fetch_pinned_text" in n for n in names), names


async def test_no_lyrics_is_a_completion_not_a_failure_through_dbos(
    dbos_instance: object, tmp_path: Path
) -> None:
    """A silent song must complete. Raising would strand it in "processing" forever, since readiness
    waits on align."""
    from encore_worker.workflows.dbos_align import DbosAlignSteps

    (tmp_path / "original.mp3").write_bytes(b"x")
    impl, _ = build(tmp_path, aligner=CountingAligner())  # no provider, no transcriber

    outcome = await run_align(job_of(tmp_path), DbosAlignSteps(impl, dbos_instance))
    assert outcome.no_lyrics is True
    assert "produced no text" in outcome.why or "exhausted" in outcome.why


# ── checkpointing is real ─────────────────────────────────────────────────────────────────────────


async def test_completed_steps_are_recorded_in_the_system_database(
    dbos_instance: object, tmp_path: Path
) -> None:
    """The durability claim, checked against DBOS's own bookkeeping rather than inferred.

    If steps were not being checkpointed, resumption would be a no-op and the whole reason for choosing a
    durable engine over a hand-rolled state machine would be absent.
    """
    from dbos import DBOS

    from encore_worker.workflows.dbos_align import DbosAlignSteps

    (tmp_path / "original.mp3").write_bytes(b"x")
    impl, _ = build(tmp_path, aligner=CountingAligner(), transcriber=Transcriber())

    @DBOS.workflow(name="e2e-align")
    async def flow(job: JobRef) -> bool:
        outcome = await run_align(job, DbosAlignSteps(impl, dbos_instance))
        return outcome.published is not None

    handle = await DBOS.start_workflow_async(flow, job_of(tmp_path))
    published = await handle.get_result()
    assert published is True

    steps = await DBOS.list_workflow_steps_async(handle.workflow_id)
    names = [str(s.get("function_name") or s.get("name") or "") for s in steps]
    assert steps, "DBOS recorded no steps at all, so nothing was checkpointed"
    assert any("acquire" in n for n in names), f"expected acquisition among the recorded steps: {names}"


async def test_a_workflow_reaches_a_terminal_status(dbos_instance: object, tmp_path: Path) -> None:
    """A workflow left PENDING would be picked up and re-run forever by recovery."""
    from dbos import DBOS

    from encore_worker.workflows.dbos_align import DbosAlignSteps

    (tmp_path / "original.mp3").write_bytes(b"x")
    impl, _ = build(tmp_path, aligner=CountingAligner(), transcriber=Transcriber())

    @DBOS.workflow(name="e2e-status")
    async def flow(job: JobRef) -> str:
        outcome = await run_align(job, DbosAlignSteps(impl, dbos_instance))
        return outcome.why

    handle = await DBOS.start_workflow_async(flow, job_of(tmp_path))
    await handle.get_result()
    status = await handle.get_status()
    assert str(status.status).upper().endswith("SUCCESS"), f"terminal status was {status.status}"


# ── the retry ladder survives serialization ───────────────────────────────────────────────────────


async def test_a_retimed_attempt_survives_the_checkpoint_boundary(
    dbos_instance: object, tmp_path: Path
) -> None:
    """A knob set and the reference line starts both cross a step boundary, so they must SERIALIZE.

    A frozen dataclass holding a `frozenset[Knob]` and a tuple of floats is exactly the kind of thing that
    works in-process and fails once DBOS pickles it — which no fake-driven test would catch.
    """
    from encore_worker.workflows.dbos_align import DbosAlignSteps

    (tmp_path / "original.mp3").write_bytes(b"x")

    class ThinThenClean(CountingAligner):
        """Forces one retime by making the first alignment look thin, then succeeding."""

    aligner = ThinThenClean()
    impl, reporter = build(
        tmp_path,
        aligner=aligner,
        providers=(
            Provider(
                (
                    {"start": 0.0, "end": 2.0, "text": "one"},
                    {"start": 10.0, "end": 12.0, "text": "two"},
                    {"start": 20.0, "end": 22.0, "text": "three"},
                )
            ),
        ),
    )

    outcome = await run_align(job_of(tmp_path), DbosAlignSteps(impl, dbos_instance))

    assert outcome.published is not None, outcome.why
    assert aligner.calls >= 1
    # Every state note must have survived the durable boundary intact.
    assert all(isinstance(state, str) for state, _v, _k in reporter.states)


def build_text() -> TextRef:
    return TextRef(
        tier=Tier.CANDIDATE,
        label="fake-provider",
        segments=({"start": 0.0, "end": 2.0, "text": "hello"},),
        timing=TIMING_LINE,
        language="en",
    )


async def test_records_round_trip_through_dbos_serialization(dbos_instance: object, tmp_path: Path) -> None:
    """Every checkpointed record must survive a real serialize/deserialize, not just an in-process call.

    Asserted through a workflow that returns each record, because DBOS serializes a step's return value —
    so a field that cannot be pickled fails here and nowhere else in the suite.
    """
    from dbos import DBOS

    @DBOS.step(name="echo_text")
    async def echo_text(text: TextRef) -> TextRef:
        return text

    @DBOS.step(name="echo_audio")
    async def echo_audio(audio: AudioRef) -> AudioRef:
        return audio

    @DBOS.workflow(name="e2e-roundtrip")
    async def flow() -> tuple[TextRef, AudioRef]:
        return await echo_text(build_text()), await echo_audio(
            AudioRef(path="/a.mp3", duration_sec=200.0, vocals_path="/v.wav")
        )

    handle = await DBOS.start_workflow_async(flow)
    text, audio = await handle.get_result()

    assert text == build_text(), "a TextRef must survive the checkpoint unchanged"
    assert audio.vocals_path == "/v.wav"
    assert text.tier is Tier.CANDIDATE, "a StrEnum must come back as the enum, not a bare string"


async def test_a_timing_report_survives_the_checkpoint(dbos_instance: object) -> None:
    """`TimedDoc` carries a `TimingReport` with tuple-of-tuple fields, which is the fiddliest shape here."""
    from dbos import DBOS

    original = TimingReport(
        words=120,
        coverage=0.91,
        overshoot_sec=3.5,
        out_of_order=0,
        residual_sec=-1.25,
        long_gaps=((10.0, 25.0),),
        smeared=(("held", 4.2),),
        flashed=(("x", 0.01),),
        duration_sec=200.0,
    )

    @DBOS.step(name="echo_report")
    async def echo(report: TimingReport) -> TimingReport:
        return report

    @DBOS.workflow(name="e2e-report")
    async def flow() -> TimingReport:
        return await echo(original)

    handle = await DBOS.start_workflow_async(flow)
    got = await handle.get_result()

    assert got == original
    assert got.summary() == original.summary(), "the derived summary must be reproducible after a replay"


# ── the wiring, not the design ────────────────────────────────────────────────────────────────────


async def test_production_wiring_records_a_workflow(dbos_instance: object, tmp_path: Path) -> None:
    """THE test whose absence let durability be missing from the running worker for a whole rewrite.

    Every other test here declares its OWN `@DBOS.workflow` and then asserts steps were recorded, which
    proves DBOS works and proves nothing about whether `__main__` asks it to. Production wrapped its STEPS
    with `DBOS.step` and called them from a plain `async def`, so nothing ran in a workflow context and
    nothing checkpointed — a live job confirmed it, with zero rows in `workflow_status`. So this goes
    through `durable.align`, the exact call the composition root makes, and declares no wrapper of its own."""
    from dbos import DBOS

    from encore_worker.workflows import durable
    from encore_worker.workflows.dbos_align import DbosAlignSteps

    (tmp_path / "original.mp3").write_bytes(b"x")
    impl, _ = build(tmp_path, aligner=CountingAligner(), transcriber=Transcriber())
    durable.register(
        dbos_instance,
        align_steps_for=lambda _job: DbosAlignSteps(impl, dbos_instance),
        stems_steps_for=lambda _job: None,  # type: ignore[arg-type,return-value]  # unused here
    )

    job = job_of(tmp_path)
    outcome = await durable.align(job)
    assert outcome.published is not None, "the flow must still work through the workflow layer"

    steps = await DBOS.list_workflow_steps_async(job.job_id)
    assert steps, (
        "DBOS recorded no steps for the job id, so production is still running outside a workflow "
        "context and a crash would restart from scratch rather than resume"
    )


async def test_the_workflow_id_is_the_job_id(dbos_instance: object, tmp_path: Path) -> None:
    """What makes a requeue idempotent rather than duplicated work.

    The core requeues the SAME job id when a lease expires, so pinning the workflow to it is what lets DBOS
    recognise the second attempt as a resumption. With a generated id, a requeue after a 45-minute
    separation would start a parallel workflow and separate the song again.
    """
    from dbos import DBOS

    from encore_worker.workflows import durable
    from encore_worker.workflows.dbos_align import DbosAlignSteps

    (tmp_path / "original.mp3").write_bytes(b"x")
    impl, _ = build(tmp_path, aligner=CountingAligner(), transcriber=Transcriber())
    durable.register(
        dbos_instance,
        align_steps_for=lambda _job: DbosAlignSteps(impl, dbos_instance),
        stems_steps_for=lambda _job: None,  # type: ignore[arg-type,return-value]  # unused here
    )

    job = job_of(tmp_path)
    await durable.align(job)

    # Addressable BY THE JOB ID, with no handle retained — which is exactly what a resuming process has.
    status: Any = await DBOS.retrieve_workflow_async(job.job_id)
    assert status is not None
    assert await status.get_result() is not None


class FaultingAligner(CountingAligner):
    """An aligner whose first `failures` alignments raise a machinery fault, then work."""

    def __init__(self, fault: Exception, *, failures: int = 1_000) -> None:
        super().__init__()
        self.fault = fault
        self.failures = failures

    def align(self, search: Sequence[object], audio_path: str, language: str) -> Sequence[object]:
        if self.calls < self.failures:
            self.calls += 1
            raise self.fault
        return super().align(search, audio_path, language)


def durable_with(dbos_instance: object, tmp_path: Path, aligner: CountingAligner) -> JobRef:
    """`durable.align`'s production wiring around the real steps, with a provider text and `aligner`."""
    from encore_worker.workflows import durable
    from encore_worker.workflows.dbos_align import DbosAlignSteps

    (tmp_path / "original.mp3").write_bytes(b"x")
    impl, _ = build(tmp_path, aligner=aligner, transcriber=Transcriber(), providers=(Provider(LINE_CUES),))
    durable.register(
        dbos_instance,
        align_steps_for=lambda _job: DbosAlignSteps(impl, dbos_instance),
        stems_steps_for=lambda _job: None,  # type: ignore[arg-type,return-value]  # unused here
    )
    return job_of(tmp_path)


@pytest.mark.parametrize("retryable", [True, False], ids=["download", "kernel-gone"])
async def test_a_machinery_fault_fails_the_workflow_and_survives_its_checkpoint(
    dbos_instance: object, tmp_path: Path, retryable: bool
) -> None:
    """Through REAL DBOS: `time_text`'s `InfraFault` fails the workflow (not a no-lyrics
    completion), and the error DBOS records, read back on the requeue, is the same class with the same
    `retryable`, so the transport sends the flag the adapter meant. A retryable flag lost in the pickle
    would retry a deterministic fault; a class lost would send it as a generic retryable error."""
    from dbos import DBOS

    from encore_worker.adapters.ml import ModelUnavailable
    from encore_worker.workflows import durable

    fault = InfraFault("loading the 'en' alignment model failed (OSError: 503)")
    if not retryable:
        fault = ModelUnavailable("torchaudio's CTC kernel is gone")
    job = durable_with(dbos_instance, tmp_path, FaultingAligner(fault))

    with pytest.raises(InfraFault) as first:
        await durable.align(job)
    assert first.value.retryable is retryable
    status: Any = await DBOS.get_workflow_status_async(job.job_id)
    assert status is not None and status.status == "ERROR", "a failed job, not a published no-lyrics"

    # The requeue re-runs the failed step (a fork: `durable._run_id`), which fails the same way here; what
    # comes back is DBOS's RECORD of that failure, so the round trip is still what is checked.
    with pytest.raises(InfraFault) as replayed:
        await durable.align(job)
    assert type(replayed.value) is type(fault) and replayed.value.retryable is retryable
    assert str(replayed.value) == str(fault)


async def test_a_requeued_job_re_runs_the_step_its_retryable_fault_failed(
    dbos_instance: object, tmp_path: Path
) -> None:
    """A machinery fault under DBOS. The core requeues a retryable failure under the SAME job id, and DBOS
    answered a start under an ERROR workflow's id with the recorded exception: no step re-ran (measured: 1
    `time_text` across 3 requeues), so a transient fault burned `maxAttempts` in instant replays and failed
    the job terminally with its cause gone. The requeue now runs a FORK of the failed workflow from the
    step that failed: the steps before it replay from their checkpoints (the provider is not asked again),
    the failed `time_text` runs again, and the song publishes. A duplicate requeue after that is the
    finished fork's result, re-running nothing."""
    from dbos import DBOS

    from encore_worker.workflows import durable
    from encore_worker.workflows.dbos_align import DbosAlignSteps

    (tmp_path / "original.mp3").write_bytes(b"x")
    provider = Provider(LINE_CUES)
    aligner = FaultingAligner(InfraFault("a transient download failure"), failures=1)
    impl, _ = build(tmp_path, aligner=aligner, transcriber=Transcriber(), providers=(provider,))
    durable.register(
        dbos_instance,
        align_steps_for=lambda _job: DbosAlignSteps(impl, dbos_instance),
        stems_steps_for=lambda _job: None,  # type: ignore[arg-type,return-value]  # unused here
    )
    job = job_of(tmp_path)

    with pytest.raises(InfraFault):
        await durable.align(job)
    outcome = await durable.align(job)  # the core's requeue: same job id

    assert outcome.published is not None, outcome.why
    assert aligner.calls == 2, "the failed alignment ran again, once"
    assert provider.calls == 1, "the steps before it replayed from their checkpoints"
    first: Any = await DBOS.get_workflow_status_async(job.job_id)
    fork: Any = await DBOS.get_workflow_status_async(f"{job.job_id}~requeue-1")
    assert (first.status, fork.status) == ("ERROR", "SUCCESS")

    again = await durable.align(job)  # a duplicate requeue: the fork's recorded result
    assert again.published == outcome.published and (aligner.calls, provider.calls) == (2, 1)


def counting_acquire(impl: AlignStepsImpl) -> list[int]:
    """Count `impl.acquire_audio` calls (one entry per attempt DBOS made), delegating to the real step."""
    calls: list[int] = []
    real = impl.acquire_audio

    async def counted(job: JobRef, **kw: Any) -> AudioRef:
        calls.append(1)
        return await real(job, **kw)

    impl.acquire_audio = counted  # type: ignore[method-assign]
    return calls


async def test_a_permanent_acquisition_fault_is_not_retried_and_fails_the_job_as_permanent(
    dbos_instance: object, tmp_path: Path
) -> None:
    """`acquire_audio` is the one step DBOS retries (3 attempts), and it raised `_Permanent`
    for a local source that is not a file. DBOS retried it anyway, with backoff, then raised
    `DBOSMaxStepRetriesExceeded`, which has no `retryable`: the transport sent the job as RETRYABLE, core
    requeued it, and each requeue's fork (`durable._run_id`) ran the step three more times until
    `maxAttempts`. Now the fault's own `retryable = False` stops DBOS retrying, and what reaches the transport
    is the fault itself: permanent, with its own message."""
    from encore_worker.steps.align_text import _Permanent
    from encore_worker.workflows import durable
    from encore_worker.workflows.dbos_align import DbosAlignSteps

    # No `original.mp3`: the local source does not resolve to a file (a media-volume mismatch).
    impl, _ = build(tmp_path, aligner=CountingAligner(), providers=(Provider(LINE_CUES),))
    calls = counting_acquire(impl)
    durable.register(
        dbos_instance,
        align_steps_for=lambda _job: DbosAlignSteps(impl, dbos_instance),
        stems_steps_for=lambda _job: None,  # type: ignore[arg-type,return-value]  # unused here
    )

    with pytest.raises(InfraFault) as failed:
        await durable.align(job_of(tmp_path))

    assert type(failed.value) is _Permanent, f"the transport must see the fault, not {type(failed.value)}"
    assert failed.value.retryable is False, "sent as retryable, core requeues a fault no retry can fix"
    assert "is not a file" in str(failed.value), "the reason core records is the fault's own"
    assert len(calls) == 1, f"DBOS retried a permanent fault {len(calls) - 1} times"


async def test_a_retryable_fault_that_exhausts_its_retries_fails_the_job_as_itself(
    dbos_instance: object, tmp_path: Path
) -> None:
    """The other half: a fault worth retrying IS retried (3 attempts), and once every attempt has failed, the
    transport sees the last attempt's exception, `retryable` and message intact — not DBOS's
    `DBOSMaxStepRetriesExceeded` ("Step acquire_audio has exceeded its maximum of 3 retries"), which it read
    as retryable whatever the fault was. Slow by DBOS's own backoff (1 s, then 2 s)."""
    from encore_worker.workflows import durable
    from encore_worker.workflows.dbos_align import DbosAlignSteps

    class DownFetcher:
        def fetch(self, source_uri: str, out_dir: str, *, on_progress: object = None) -> str:
            raise InfraFault("the host answered 503")

    impl, _ = build(tmp_path, fetcher=DownFetcher(), aligner=CountingAligner())
    calls = counting_acquire(impl)
    durable.register(
        dbos_instance,
        align_steps_for=lambda _job: DbosAlignSteps(impl, dbos_instance),
        stems_steps_for=lambda _job: None,  # type: ignore[arg-type,return-value]  # unused here
    )
    job = JobRef(job_id="e2e-remote", media_id="m1", media_dir=str(tmp_path), source_uri="https://x/y")

    with pytest.raises(InfraFault) as failed:
        await durable.align(job)

    assert type(failed.value) is InfraFault and failed.value.retryable is True
    assert str(failed.value) == "the host answered 503"
    assert len(calls) == 3, "a transient fault keeps its retries"


def test_only_a_fault_that_says_so_is_spared_its_retries() -> None:
    """`should_retry` reads the fault's own flag, and an exception that has none (a network error) is
    retried as before."""
    from encore_worker.adapters.ml import ModelUnavailable
    from encore_worker.steps.align_text import _Permanent
    from encore_worker.workflows.dbos_align import _worth_retrying

    assert _worth_retrying(OSError("connection reset")) is True
    assert _worth_retrying(InfraFault("503")) is True
    assert _worth_retrying(_Permanent("no fetcher")) is False
    assert _worth_retrying(ModelUnavailable("no kernel")) is False


async def test_a_box_without_dbos_still_runs_the_flow(tmp_path: Path) -> None:
    """A worker with no durable state is DEGRADED, not broken. `register(None)` must leave the flow callable,
    because a box that cannot checkpoint should still process songs."""

    from encore_worker.workflows import durable
    from encore_worker.workflows.dbos_align import DbosAlignSteps

    (tmp_path / "original.mp3").write_bytes(b"x")
    impl, _ = build(tmp_path, aligner=CountingAligner(), transcriber=Transcriber())
    durable.register(
        None,
        align_steps_for=lambda _job: DbosAlignSteps(impl, None),
        stems_steps_for=lambda _job: None,  # type: ignore[arg-type,return-value]  # unused here
    )

    outcome = await durable.align(job_of(tmp_path))
    assert outcome.published is not None


# ── a cancel reaches the run DBOS executes ────────────────────────────────────────────────────────────


class FailingThenHangingSteps:
    """Stems steps whose first separation fails, so the requeue FORKS, and whose second hangs in a child."""

    def __init__(self, runs: list[str]) -> None:
        self.runs = runs

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        return AudioRef(path="/dev/null", duration_sec=1.0)

    async def decode_to_wav(self, job: JobRef, audio: AudioRef) -> str:
        return "/dev/null"

    async def separate(self, job: JobRef, input_wav: str) -> AudioRef:
        self.runs.append("separate")
        if len(self.runs) == 1:
            raise RuntimeError("the first attempt fails, so the requeue forks")
        await asyncio.to_thread(cli.run, ["sh", "-c", "sleep 30"])
        raise AssertionError("unreachable: only a kill ends the child")


async def _forked_and_hanging(dbos_instance: object, tmp_path: Path, job_id: str) -> tuple[JobRef, list[str]]:
    """Register the stems flow, and run it once so its ERROR row makes the next start a fork."""
    from encore_worker.workflows import durable

    runs: list[str] = []
    durable.register(
        dbos_instance,
        align_steps_for=lambda _job: None,  # type: ignore[arg-type,return-value]  # unused here
        stems_steps_for=lambda _job: FailingThenHangingSteps(runs),  # type: ignore[arg-type,return-value]
    )
    job = JobRef(job_id=job_id, media_id="m1", media_dir=str(tmp_path), source_uri="")
    with pytest.raises(RuntimeError, match="first attempt"):
        await durable.stems(job)
    return job, runs


async def test_a_forked_run_is_killed_by_its_jobs_token(
    dbos_instance: object, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """DBOS executes the fork itself, in a context this test never set the token in: only the workflow body's
    own binding (`steps.cancel.bind_cancel_token`) can let the cancel reach the fork's child."""
    from dbos import DBOS

    from encore_worker.workflows import durable

    job, runs = await _forked_and_hanging(dbos_instance, tmp_path, "cancel-1")
    token = cli.CancelToken()
    monkeypatch.setitem(cli.tokens, job.job_id, token)
    assert cli.current_token.get() is None
    asyncio.get_running_loop().call_later(1.0, token.cancel)
    started = time.monotonic()
    with pytest.raises(cli.ToolFailed, match="cancelled"):
        await asyncio.wait_for(durable.stems(job), 20.0)
    assert runs == ["separate", "separate"], runs
    assert time.monotonic() - started < 4.0, "the fork's child outlived the cancel"
    assert await DBOS.get_workflow_status_async("cancel-1~requeue-1") is not None, "the second run was a fork"


async def test_cancelling_a_live_fork_makes_the_next_requeue_fork_again(
    dbos_instance: object, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from dbos import DBOS

    from encore_worker.workflows import durable

    job, runs = await _forked_and_hanging(dbos_instance, tmp_path, "cancel-2")
    token = cli.CancelToken()
    monkeypatch.setitem(cli.tokens, job.job_id, token)
    task = asyncio.create_task(durable.stems(job))
    for _ in range(100):
        await asyncio.sleep(0.05)
        if len(runs) == 2 and await DBOS.get_workflow_status_async("cancel-2~requeue-1") is not None:
            break
    await durable.cancel(job.job_id)
    token.cancel()
    with pytest.raises(BaseException):  # noqa: B017 - DBOS's cancellation or the killed child: either ends it
        await asyncio.wait_for(task, 10.0)
    status: Any = await DBOS.get_workflow_status_async("cancel-2~requeue-1")
    assert status is not None and status.status == "CANCELLED", status
    assert await durable._run_id(job.job_id) == "cancel-2~requeue-2", (
        "a cancelled run is forked, not replayed"
    )
    # `_run_id` made that fork, and DBOS's queue would start it while the fixture tears DBOS down.
    await DBOS.cancel_workflow_async("cancel-2~requeue-2")
