"""The one outbound rate gate, shared by every provider client.

WHY IT IS NOT IN A DOMAIN. `lyrics/lrclib.py` (LRCLIB) and `metadata/annotate.py` (MusicBrainz) each
had a byte-identical copy of this class. A per-IP request budget is a property of the PROCESS, not a
lyrics concern that metadata borrows, so it lives at the root for the same reason `mlrt.py` does.

ONE GATE PER SERVICE, NOT ONE PER PROCESS. Each provider module keeps its own instance, because the
budgets are independent — sharing one would halve both. What must not be per-CLIENT is the instance
within one service; that is the burst this exists to prevent.

PROVIDER-SPECIFIC, and therefore a parameter rather than a copy: the interval, and WHICH statuses mean
"wait and try again" (MusicBrainz signals its limit with 503 alone; LRCLIB also uses 429). Hardcoding
either is what let the two copies drift.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

#: Exponential backoff, so one blip does not lose the lookup; BOUNDED, so a genuinely down service
#: degrades to a legible error rather than being hammered forever.
MAX_ATTEMPTS = 3

BACKOFF_BASE_SEC = 1.0

#: One request per second per SOURCE IP is what both providers ask for. A burst on a small free
#: service reads as abuse, and MusicBrainz's penalty is TOTAL rather than partial — it declines 100%
#: of requests until the rate drops — so pacing must be serialised, never best-effort.
MIN_INTERVAL_SEC = 1.0

#: The generic "wait and try again" set. A provider whose own signal is narrower passes its own (see
#: `metadata/annotate.py`); anything outside the set is the caller's status ladder to interpret.
RETRY_STATUSES = frozenset({503, 429})


class RateLimiter:
    """One gate every call to a provider passes through, one at a time.

    SERIALISED AND SHARED, not a per-client interval check: the limit is per SOURCE IP (a property of
    the process, not of a client object), and `ENCORE_WORKER_CONCURRENCY` > 1 means two jobs can reach
    this concurrently — an unlocked "has enough time passed?" check lets both read the same timestamp,
    both decide yes, and both fire, which is exactly the burst that gets an IP blocked outright.

    The lock is held across the REQUEST as well as the wait: releasing before the call would let two
    requests be in flight simultaneously, the exact thing being prevented. Retries happen INSIDE the
    lock too, so a throttled box does not pile every queued caller onto the request already being
    refused.

    Counters exist so an operator can tell "the provider is throttling us" from "the network is slow",
    since a paced call is indistinguishable from a slow one from the outside.

    `now`/`sleep` are injectable purely so tests are hermetic; production uses the monotonic clock.
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
        # None, not 0.0: "never called" must stay distinguishable from "called at t=0", which is falsy.
        self._last_call: float | None = None
        self.calls = 0
        self.retries = 0
        self.throttled = 0
        self.waited_sec = 0.0

    def _pace(self) -> None:
        if self._last_call is not None:
            elapsed = self._now() - self._last_call
            if elapsed < self._min_interval:
                wait = self._min_interval - elapsed
                self.waited_sec += wait
                self._sleep(wait)
        self._last_call = self._now()

    def run(self, call: Callable[[], tuple[int, str]]) -> tuple[int, str]:
        """Execute one paced request under the gate, retrying a transient status with backoff.

        Returns the last (status, body) seen — the CALLER's status ladder decides what a retried-out
        failure means, so this never raises a provider-specific error of its own.
        """
        with self._lock:
            status, body = 0, ""
            for attempt in range(1, MAX_ATTEMPTS + 1):
                self._pace()
                self.calls += 1
                status, body = call()
                if status not in self._retry_statuses:
                    return status, body
                # Over the limit or service busy: the same remedy either way.
                self.throttled += 1
                if attempt == MAX_ATTEMPTS:
                    return status, body
                self.retries += 1
                backoff = BACKOFF_BASE_SEC * (2 ** (attempt - 1))
                self.waited_sec += backoff
                self._sleep(backoff)
            return status, body  # unreachable, kept for the type checker's benefit

    def stats(self) -> dict[str, Any]:
        return {
            "calls": self.calls,
            "retries": self.retries,
            "throttled": self.throttled,
            "waited_sec": round(self.waited_sec, 2),
        }
