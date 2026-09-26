"""The one outbound rate gate every provider call passes through.

WHY A GATE AT ALL, when this worker makes one lookup per job. Because jobs arrive in bursts: a library
import queues dozens at once, and with `ENCORE_WORKER_CONCURRENCY > 1` two of them reach a provider in the
same instant. The budget is per SOURCE IP — a property of the process, not of a client object — and on a
small free service a burst reads as abuse. LRCmux is someone else's server.

SERIALISED, NOT A BEST-EFFORT INTERVAL CHECK. An unlocked "has enough time passed?" lets two callers read
the same timestamp, both decide yes, and both fire — exactly the burst this prevents. The lock is held
across the REQUEST as well as the wait, because releasing before the call would put two requests in flight
at once, which is the thing being prevented. Retries happen inside the lock too, so a throttled box does not
pile every queued caller onto the request already being refused.

ONE GATE PER SERVICE, NOT ONE PER PROCESS. Each provider keeps its own instance: the budgets are
independent, and sharing one would halve both. What must not be per-CLIENT is the instance within one
service.

`threading` rather than `asyncio`, because every provider call runs inside `asyncio.to_thread` — the
contention is between OS threads, and an `asyncio.Lock` would not exclude anything.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

#: Exponential backoff, so one blip does not lose the lookup; BOUNDED, so a genuinely down service degrades
#: to a legible error rather than being hammered forever.
MAX_ATTEMPTS = 3
BACKOFF_BASE_SEC = 1.0

#: One request per second per source IP is what these services ask for. Pacing must be SERIALISED rather
#: than best-effort: a penalty is typically total rather than partial — every request declined until the
#: rate drops — so a single burst costs far more than the second it saves.
MIN_INTERVAL_SEC = 1.0

#: "Wait and try again". 429 is the explicit rate-limit signal; 503 is how a busy service says the same
#: thing. Anything outside this set is the CALLER's status ladder to interpret — a 404 means "no lyrics for
#: this song", which is a normal answer and must not be retried.
RETRY_STATUSES = frozenset({503, 429})


class RateLimiter:
    """One gate every call to a provider passes through, one at a time.

    Counters exist so an operator can tell "the provider is throttling us" from "the network is slow" — a
    paced call is indistinguishable from a slow one from the outside.

    `now`/`sleep` are injected purely so tests are hermetic: a real `time.sleep(1.0)` per call would make the
    suite wait seconds to prove something about arithmetic.
    """

    def __init__(
        self,
        min_interval: float = MIN_INTERVAL_SEC,
        *,
        retry_statuses: frozenset[int] | set[int] = RETRY_STATUSES,
        now: Callable[[], float] | None = None,
        sleep: Callable[[float], None] | None = None,
    ) -> None:
        self._min_interval = min_interval
        self._retry_statuses = frozenset(retry_statuses)
        self._lock = threading.Lock()
        self._now = now or time.monotonic
        self._sleep = sleep or time.sleep
        #: None, not 0.0: "never called" must stay distinguishable from "called at t=0", which is falsy.
        self._last_call: float | None = None
        self.calls = 0
        self.retries = 0
        self.throttled = 0
        self.waited_sec = 0.0

    def _pace(self) -> None:
        """Sleep until the minimum interval since the last call has elapsed."""
        if self._last_call is not None:
            elapsed = self._now() - self._last_call
            if elapsed < self._min_interval:
                wait = self._min_interval - elapsed
                self.waited_sec += wait
                self._sleep(wait)
        self._last_call = self._now()

    def run(self, call: Callable[[], tuple[int, str]]) -> tuple[int, str]:
        """Execute one paced request under the gate, retrying a transient status with backoff.

        Returns the LAST (status, body) seen rather than raising: the caller's status ladder decides what a
        retried-out failure means, and a provider miss (404) is a normal answer rather than an error.
        """
        with self._lock:
            status, body = 0, ""
            for attempt in range(1, MAX_ATTEMPTS + 1):
                self._pace()
                self.calls += 1
                status, body = call()
                if status not in self._retry_statuses:
                    return status, body
                # Over the limit, or the service is busy: same remedy either way.
                self.throttled += 1
                if attempt == MAX_ATTEMPTS:
                    return status, body
                self.retries += 1
                backoff = BACKOFF_BASE_SEC * (2 ** (attempt - 1))
                self.waited_sec += backoff
                self._sleep(backoff)
            return status, body  # unreachable; kept for the type checker

    def stats(self) -> dict[str, Any]:
        """Counters for the operator. `waited_sec` is the whole point: it separates "we are being paced" from
        "the network is slow", which look identical from outside."""
        return {
            "calls": self.calls,
            "retries": self.retries,
            "throttled": self.throttled,
            "waited_sec": round(self.waited_sec, 2),
        }
