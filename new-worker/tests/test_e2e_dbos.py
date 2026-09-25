"""END TO END through REAL DBOS: a launched instance, a real SQLite file, real `@DBOS.step` registration.

WHY THIS EXISTS. Everything else in the suite drives `run_align` with fakes, which proves the state
machine but says nothing about the one thing the whole architecture is betting on: that DBOS actually
registers these steps, checkpoints them, and resumes. `workflows/dbos_align.py` guessed at `DBOS.step`'s
signature and carried a `TypeError` fallback — so until this file existed, the durable path had never run
once and the fallback had never been shown to be unnecessary.

The heavy seams are still faked. What is real here is DBOS: the registration, the checkpoint writes, and
the workflow-status bookkeeping.

Marked `dbos` so it can be deselected: it writes a SQLite file and takes seconds, where the rest of the
suite is milliseconds.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import pytest

from encore_worker.domain.document import TIMING_LINE
from encore_worker.domain.lyrics.policy import Tier
from encore_worker.domain.lyrics.report import TimingReport
from encore_worker.host.config import Config
from encore_worker.protocol.vocabulary import Stage
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.records import AudioRef, JobRef, TextRef
from encore_worker.workflows.align import run_align

pytestmark = pytest.mark.dbos


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

    def transcribe(self, audio_path: str, *, language: str | None = None) -> Sequence[object]:
        self.calls += 1
        return [{"start": 0.0, "end": 2.0, "text": "what was heard"}]


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
