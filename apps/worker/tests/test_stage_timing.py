"""Per-stage timing, measured from the progress stream the processors already emit.

Before this the worker measured NOTHING — no perf_counter anywhere in the tree — so "stems took 43
minutes" could not be broken down into download versus separate. These tests pin the arithmetic with
an injected clock, so they assert real behaviour without sleeping.
"""

from __future__ import annotations

from src import protocol


class FakeClock:
    """A monotonic clock the test drives by hand."""

    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def test_a_stage_ends_when_a_different_stage_begins():
    clock = FakeClock()
    timer = protocol.StageTimer(clock)

    timer.observe("downloading")
    clock.advance(12.0)
    timer.observe("separating")  # download is over at this instant
    clock.advance(51.0)

    assert timer.finish() == [
        {"stage": "downloading", "ms": 12_000},
        {"stage": "separating", "ms": 51_000},
    ]


def test_repeated_progress_in_one_stage_is_not_a_transition():
    # Every processor emits many progress events per stage as pct climbs. Treating each as a
    # transition would produce one near-zero row per tick instead of one row per stage.
    clock = FakeClock()
    timer = protocol.StageTimer(clock)

    timer.observe("separating")
    for _ in range(5):
        clock.advance(2.0)
        timer.observe("separating")

    assert timer.finish() == [{"stage": "separating", "ms": 10_000}]


def test_the_final_stage_is_closed_by_finishing():
    # Nothing follows the last stage, so only finish() can end it — otherwise the most expensive
    # stage of every job (the separation) would be the one never recorded.
    clock = FakeClock()
    timer = protocol.StageTimer(clock)
    timer.observe("separating")
    clock.advance(90.0)

    assert timer.finish() == [{"stage": "separating", "ms": 90_000}]


def test_a_job_that_emitted_no_progress_reports_no_stages():
    timer = protocol.StageTimer(FakeClock())
    assert timer.finish() == []


def test_stage_order_is_preserved():
    clock = FakeClock()
    timer = protocol.StageTimer(clock)
    for stage in ("downloading", "aligning"):
        timer.observe(stage)
        clock.advance(1.0)

    assert [s["stage"] for s in timer.finish()] == ["downloading", "aligning"]


def test_a_duration_is_never_negative():
    # A monotonic clock should not step backwards, but a clamped floor is cheaper than a dashboard
    # rendering a negative bar if one ever does.
    class Backwards:
        def __init__(self) -> None:
            self.vals = [100.0, 50.0]

        def __call__(self) -> float:
            return self.vals.pop(0) if self.vals else 0.0

    timer = protocol.StageTimer(Backwards())
    timer.observe("separating")
    assert timer.finish() == [{"stage": "separating", "ms": 0}]


def test_finish_is_idempotent():
    clock = FakeClock()
    timer = protocol.StageTimer(clock)
    timer.observe("separating")
    clock.advance(3.0)

    first = timer.finish()
    assert timer.finish() == first  # a second call must not append a duplicate row


def test_complete_omits_facts_and_stages_when_there_are_none():
    # Additive wire fields: an older core must not receive keys it does not understand, and an empty
    # list is not a measurement.
    msg = protocol.complete("w1", "j1", "/media/x.flac", {"stems": {}})
    assert "facts" not in msg and "stages" not in msg


def test_complete_carries_resolved_facts_and_the_stage_split():
    msg = protocol.complete(
        "w1",
        "j1",
        "/media/x.flac",
        {"stems": {}},
        facts={"engine": "roformer", "model": "mel-band-roformer"},
        stages=[{"stage": "separating", "ms": 51_000}],
    )
    # The model here is the RESOLVED checkpoint, which is the point: a token was once found to resolve
    # to a different model than the one benchmarked under that name.
    assert msg["facts"]["model"] == "mel-band-roformer"
    assert msg["stages"] == [{"stage": "separating", "ms": 51_000}]


def test_host_facts_survive_a_box_with_no_torch():
    # ENCORE_PROCESSOR=stub genuinely runs without torch. A probe that raised would take down a worker
    # over a diagnostic, so the torch keys are simply absent.
    facts = protocol.host_facts()
    assert isinstance(facts["cpuCount"], int)
    assert facts["platform"] and facts["machine"] and facts["python"]
