"""The outbound rate gate. Every test drives an injected clock, so nothing here waits on a real one.

WHAT THIS PROTECTS. LRCmux and LRCLIB are someone else's servers, and a library import queues dozens of jobs
at once. The failure being prevented is not a slow lookup — it is an IP getting blocked outright, which is
typically TOTAL rather than partial: every request declined until the rate drops. A burst costs far more than
the second it saves.
"""

from __future__ import annotations

import threading

import pytest

from encore_worker.adapters.ratelimit import (
    BACKOFF_BASE_SEC,
    MAX_ATTEMPTS,
    MIN_INTERVAL_SEC,
    RETRY_STATUSES,
    RateLimiter,
)


class Clock:
    """A fake monotonic clock that only advances when something sleeps.

    Deliberately not `time.monotonic` with real sleeps: the gate's whole job is arithmetic over timestamps,
    and asserting it needs a clock the test controls, not one it races.
    """

    def __init__(self) -> None:
        self.t = 0.0
        self.slept: list[float] = []

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.t += seconds

    def advance(self, seconds: float) -> None:
        """Time passing WITHOUT the gate sleeping — a slow request, or a gap between jobs."""
        self.t += seconds


def gate(clock: Clock, **kw: object) -> RateLimiter:
    return RateLimiter(now=clock.now, sleep=clock.sleep, **kw)  # type: ignore[arg-type]


def ok() -> tuple[int, str]:
    return 200, "body"


# ── pacing ───────────────────────────────────────────────────────────────────────────────────────


def test_the_first_call_does_not_wait() -> None:
    """ "Never called" is distinguishable from "called at t=0" — which is why `_last_call` is None rather than
    0.0, a value that is falsy and would make the first call pay a full interval for nothing."""
    clock = Clock()
    gate(clock).run(ok)
    assert clock.slept == []


def test_a_second_immediate_call_waits_the_interval() -> None:
    clock = Clock()
    limiter = gate(clock)
    limiter.run(ok)
    limiter.run(ok)
    assert clock.slept == [pytest.approx(MIN_INTERVAL_SEC)]


def test_a_call_after_the_interval_has_passed_does_not_wait() -> None:
    """Pacing is a floor, not a tax: a job that took a minute must not then be delayed a further second."""
    clock = Clock()
    limiter = gate(clock)
    limiter.run(ok)
    clock.advance(MIN_INTERVAL_SEC * 3)
    limiter.run(ok)
    assert clock.slept == []


def test_it_waits_only_the_remaining_time() -> None:
    """Sleeping a full interval when most of it has already elapsed would halve the achievable rate for no
    benefit to the provider."""
    clock = Clock()
    limiter = gate(clock)
    limiter.run(ok)
    clock.advance(0.4)
    limiter.run(ok)
    assert clock.slept == [pytest.approx(MIN_INTERVAL_SEC - 0.4)]


def test_the_interval_is_configurable() -> None:
    """Per service, because the budgets are independent — a shared interval would be wrong for both."""
    clock = Clock()
    limiter = gate(clock, min_interval=5.0)
    limiter.run(ok)
    limiter.run(ok)
    assert clock.slept == [pytest.approx(5.0)]


# ── retries ──────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("status", sorted(RETRY_STATUSES))
def test_a_throttled_status_is_retried_with_backoff(status: int) -> None:
    """429 is the explicit signal, 503 is how a busy service says the same thing. Same remedy either way."""
    clock = Clock()
    attempts = []

    def flaky() -> tuple[int, str]:
        attempts.append(1)
        return (status, "busy") if len(attempts) < 3 else (200, "finally")

    got = gate(clock).run(flaky)
    assert got == (200, "finally")
    assert len(attempts) == 3
    # Exponential: 1s then 2s, plus the pacing between attempts.
    assert BACKOFF_BASE_SEC in clock.slept
    assert BACKOFF_BASE_SEC * 2 in clock.slept


def test_retries_are_bounded() -> None:
    """A genuinely down service must degrade to a legible error rather than being hammered forever — which
    would be the exact abuse the gate exists to avoid, just slower."""
    clock = Clock()
    attempts = []

    def always_busy() -> tuple[int, str]:
        attempts.append(1)
        return 503, "down"

    status, body = gate(clock).run(always_busy)
    assert (status, body) == (503, "down"), "the LAST status is returned, not an exception"
    assert len(attempts) == MAX_ATTEMPTS


def test_a_non_retryable_status_returns_immediately() -> None:
    """A 404 is an ORDINARY MISS for a lyrics lookup — the provider simply does not have the song. Retrying
    it would triple the cost of every such song and change nothing."""
    clock = Clock()
    attempts = []

    def missing() -> tuple[int, str]:
        attempts.append(1)
        return 404, ""

    assert gate(clock).run(missing) == (404, "")
    assert len(attempts) == 1
    assert clock.slept == []


def test_the_retry_set_is_configurable() -> None:
    """A provider whose own signal is narrower passes its own: MusicBrainz signals its limit with 503 alone,
    so treating 429 as retryable there would retry something it meant as final."""
    clock = Clock()
    attempts = []

    def rate_limited() -> tuple[int, str]:
        attempts.append(1)
        return 429, ""

    gate(clock, retry_statuses=frozenset({503})).run(rate_limited)
    assert len(attempts) == 1, "429 must not be retried when the caller excluded it"


def test_an_exception_propagates_rather_than_being_retried() -> None:
    """A transport failure is not a status, and no amount of backoff turns a closed port into an open one.
    It must also not leave the gate locked — the next test proves that."""
    clock = Clock()

    def boom() -> tuple[int, str]:
        raise OSError("no route to host")

    with pytest.raises(OSError, match="no route"):
        gate(clock).run(boom)


def test_the_lock_is_released_after_a_raising_call() -> None:
    """A gate that stayed locked after one transport failure would wedge every later lookup in the process —
    a single blip turning into a permanent outage for lyrics."""
    clock = Clock()
    limiter = gate(clock)

    def boom() -> tuple[int, str]:
        raise OSError("blip")

    with pytest.raises(OSError):
        limiter.run(boom)
    assert limiter.run(ok) == (200, "body"), "the gate must still be usable"


# ── serialisation, which is the whole point ──────────────────────────────────────────────────────


def test_two_threads_never_overlap_inside_the_gate() -> None:
    """THE property this exists for, and the one an interval check alone cannot give.

    An unlocked "has enough time passed?" lets two callers read the same timestamp, both decide yes, and both
    fire — which is precisely the burst that gets an IP blocked. Asserted by observing CONCURRENCY inside the
    call rather than by timing: a timing assertion would be a race dressed as a test.
    """
    limiter = RateLimiter(min_interval=0.0)  # pacing off; this is about mutual exclusion
    inside = 0
    peak = 0
    seen = threading.Lock()

    def call() -> tuple[int, str]:
        nonlocal inside, peak
        with seen:
            inside += 1
            peak = max(peak, inside)
        # Long enough that an unlocked gate would reliably overlap.
        threading.Event().wait(0.02)
        with seen:
            inside -= 1
        return 200, ""

    threads = [threading.Thread(target=lambda: limiter.run(call)) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert peak == 1, f"{peak} requests were in flight at once; the gate did not serialise"
    assert limiter.calls == 6


# ── counters ─────────────────────────────────────────────────────────────────────────────────────


def test_stats_separate_being_paced_from_being_slow() -> None:
    """The reason counters exist at all: from outside, a paced call and a slow network are identical. An
    operator needs to tell "the provider is throttling us" from "our link is bad"."""
    clock = Clock()
    limiter = gate(clock)
    limiter.run(ok)
    limiter.run(ok)  # pays one interval

    stats = limiter.stats()
    assert stats["calls"] == 2
    assert stats["throttled"] == 0
    assert stats["waited_sec"] == pytest.approx(MIN_INTERVAL_SEC)


def test_throttling_is_counted_separately_from_pacing() -> None:
    clock = Clock()
    attempts = []

    def busy_once() -> tuple[int, str]:
        attempts.append(1)
        return (503, "") if len(attempts) == 1 else (200, "")

    limiter = gate(clock)
    limiter.run(busy_once)
    stats = limiter.stats()
    assert stats["throttled"] == 1
    assert stats["retries"] == 1
    assert stats["calls"] == 2, "both attempts count as calls"
