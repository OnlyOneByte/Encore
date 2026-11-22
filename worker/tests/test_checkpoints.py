"""A checkpoint written before a record gained a field must still replay.

DBOS pickles every step's record, and a frozen slotted dataclass restores its state POSITIONALLY: a field
appended after the checkpoint was written was left unset, and the first read of it raised
`AttributeError`. One release appended `TimingReport.engine` / `lines` / `refused`, `TimedDoc.tier` and
`AlignOutcome.sync_mode`, so a job in flight at the upgrade — and every fork of an old failed job, which
copies its checkpoints — failed on them, requeue after requeue.

The OLD pickles here are real pickles of today's classes with the state cut back to the v2 field list
(`pickled_as`), so what is exercised is pickle's own `__setstate__` call, exactly as a DBOS replay makes it.
"""

from __future__ import annotations

import pickle
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, cast

import pytest

from encore_worker.domain.lyrics.policy import Attempt, NextText, Tier, decide
from encore_worker.domain.lyrics.report import Engine, TimingReport, restore_appended
from encore_worker.steps.records import AlignOutcome, TimedDoc

#: The field counts v2 (HEAD 23c44114) pickled: TimingReport words..notes, TimedDoc ref..line_starts,
#: AlignOutcome published..candidates.
V2_REPORT, V2_DOC, V2_OUTCOME = 10, 7, 4


def _cut(full: Callable[[Any], list[object]], n: int) -> Callable[[Any], list[object]]:
    def getstate(self: Any) -> list[object]:
        return full(self)[:n]

    return getstate


@contextmanager
def pickled_as(*cuts: tuple[type[Any], int]) -> Iterator[None]:
    """While active, each class pickles only its first `n` fields: the checkpoint an older release wrote."""
    saved: dict[type[Any], Any] = {cls: cls.__getstate__ for cls, _n in cuts}
    try:
        for cls, n in cuts:
            setattr(cls, "__getstate__", _cut(saved[cls], n))  # noqa: B010 - a class attribute, by name
        yield
    finally:
        for cls, getstate in saved.items():
            setattr(cls, "__getstate__", getstate)  # noqa: B010


def v2_report() -> TimingReport:
    return TimingReport(words=12, coverage=0.9, out_of_order=2, duration_sec=200.0)


def test_a_v2_timing_report_replays_with_the_defaults_it_was_measured_under() -> None:
    with pickled_as((TimingReport, V2_REPORT)):
        blob = pickle.dumps(v2_report())
    got = pickle.loads(blob)

    assert (got.engine, got.lines, got.refused) == (Engine.GLOBAL, 0, None)
    assert got.words == 12 and got.out_of_order == 2
    assert not got.usable, "the read that raised AttributeError on every replayed attempt"
    assert isinstance(decide(got, Attempt()), NextText)


@pytest.mark.parametrize(
    ("label", "tier"),
    [
        ("captions:authored", Tier.CANDIDATE),
        ("lrclib", Tier.CANDIDATE),
        ("captions:machine", Tier.MACHINE),
        ("captions:auto", Tier.MACHINE),
        ("asr:vocals", Tier.ASR),
    ],
)
def test_a_v2_document_takes_the_tier_its_label_was_acquired_at(label: str, tier: Tier) -> None:
    """`tier` has no default (the step must say it), so an old record's is what its label implies —
    `textConfidence` then says what the text is, not `high` for a machine track."""
    doc = TimedDoc(
        ref="derived/lyrics/m1-x-word.json",
        timing="word",
        confidence="high",
        report=v2_report(),
        label=label,
        tier=Tier.ASR if tier is not Tier.ASR else Tier.CANDIDATE,  # never the answer: it is not pickled
    )
    with pickled_as((TimedDoc, V2_DOC), (TimingReport, V2_REPORT)):
        blob = pickle.dumps(doc)
    got = pickle.loads(blob)

    assert got.tier is tier
    assert got.label == label and got.report.engine is Engine.GLOBAL


def test_a_finished_v2_outcome_still_builds_its_completion_frame() -> None:
    """A v2 workflow that SUCCEEDED returns its recorded outcome to a duplicate requeue: the frame builder
    reads `sync_mode` and every candidate's `tier`, and both come back as their defaults."""
    from encore_worker.__main__ import _align_completion
    from encore_worker.host.config import Config
    from encore_worker.steps.records import JobRef

    doc = TimedDoc(
        ref="derived/lyrics/m1-captions-machine-word.json",
        timing="word",
        confidence="high",
        report=v2_report(),
        label="captions:machine",
        tier=Tier.CANDIDATE,
    )
    outcome = AlignOutcome(published=doc, why="accepted", candidates=(doc,), sync_mode="lines")
    with pickled_as((AlignOutcome, V2_OUTCOME), (TimedDoc, V2_DOC), (TimingReport, V2_REPORT)):
        blob = pickle.dumps(outcome)
    got = pickle.loads(blob)

    assert got.sync_mode is None
    frame = _align_completion(JobRef(job_id="j", media_id="m1", media_dir="/m"), Config(), got, now_ms=1)
    assert frame.facts is not None and frame.artifacts is not None
    assert frame.facts["syncMode"] == "forced", "the job's own param: the v2 record never said"
    candidate = frame.artifacts["lyrics"]["candidates"][0]
    assert candidate["textConfidence"] == "low", "a machine track is not a claim about the words"


def test_a_current_checkpoint_round_trips_unchanged() -> None:
    report = TimingReport(words=0, lines=4, engine=Engine.LINE_SYNC, refused="gate", duration_sec=9.0)
    doc = TimedDoc(ref="r", timing="line", confidence="low", report=report, label="lrclib", tier=Tier.MACHINE)
    outcome = AlignOutcome(published=doc, why="w", candidates=(doc,), sync_mode="lines")

    assert pickle.loads(pickle.dumps(outcome)) == outcome
    assert pickle.loads(pickle.dumps(doc)).tier is Tier.MACHINE, "a pickled tier is never re-derived"


async def test_a_pre_m13_provider_checkpoint_replays_as_a_list() -> None:
    """The same rule one layer out: a STEP's return SHAPE is checkpointed
    too. `fetch_provider_lyrics` used to return `TextRef | None` and returns `list[TextRef]` now, so a
    workflow resumed or forked across the upgrade replays the recorded value instead of calling the impl —
    and `_acquire_texts` splats it, where `*TextRef(...)` and `*None` both raise `TypeError` in the workflow
    BODY: past the step's retries, where nothing declines it, requeue after requeue. Normalised in the DBOS
    wrapper, which is the one place a replayed value enters this process."""
    from encore_worker.steps.align_steps import AlignStepsImpl
    from encore_worker.steps.records import AudioRef, JobRef, TextRef
    from encore_worker.workflows.dbos_align import DbosAlignSteps

    impl = SimpleNamespace(
        acquire_audio=None,
        fetch_captions=None,
        fetch_provider_lyrics=None,
        fetch_pinned_text=None,
        transcribe=None,
        time_text=None,
        diarize=None,
        publish=None,
        note=None,
    )
    steps = DbosAlignSteps(cast("AlignStepsImpl", impl), None)
    job = JobRef(job_id="j", media_id="m1", media_dir="/m", source_uri="x", params={})
    audio = AudioRef(path="/m/a.mp3", duration_sec=1.0, vocals_path=None)
    sheet = TextRef(tier=Tier.CANDIDATE, label="lrclib", segments=({"text": "aaa bbb"},), timing="line")

    async def replays(value: object) -> list[TextRef]:
        async def recorded(*_args: object, **_kwargs: object) -> object:
            return value

        steps._provider = recorded
        return await steps.fetch_provider_lyrics(job, audio)

    assert await replays(sheet) == [sheet], "the v2 shape: one text or nothing"
    assert await replays(None) == []
    assert await replays([sheet]) == [sheet], "and today's shape is untouched"


def test_a_missing_field_with_no_default_names_itself() -> None:
    """Better a replay that fails saying which field than a record that fails later on a bare slot."""

    @dataclass(frozen=True, slots=True)
    class Grown:
        kept: int
        needed: str = field(kw_only=True)

        def __setstate__(self, state: list[object]) -> None:
            restore_appended(self, state)

    with pytest.raises(TypeError, match="'needed'"):
        Grown.__new__(Grown).__setstate__([1])
