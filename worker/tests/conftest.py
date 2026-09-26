"""Suite-wide guards.

THE NETWORK BLOCK EXISTS BECAUSE IT CAUGHT A REAL PROBLEM. When the lyrics clients were changed to build
their own `urllib` opener, a test that monkeypatched `urllib.request.urlopen` stopped intercepting — so
four tests quietly started making live DNS lookups and HTTP requests. They still PASSED, just thirty
seconds slower, against whatever the public API happened to return that day.

That is the worst shape a test can take: green, slow, and dependent on someone else's uptime. Blocking
the socket turns it into an immediate, named failure instead.

A test that genuinely needs the network must say so with `@pytest.mark.allow_network`, which makes the
exception visible in the source rather than implicit in a passing run. Nothing in this suite uses it.
"""

from __future__ import annotations

import socket
from collections.abc import Iterator
from typing import Any

import pytest

_REAL_CONNECT = socket.socket.connect


class NetworkAccessDenied(RuntimeError):
    """A test tried to open a socket.

    The message names the address, because the useful question is not "did something use the network" but
    "which host, and which adapter reached for it".
    """


@pytest.fixture(autouse=True)
def _no_network(request: pytest.FixtureRequest) -> Iterator[None]:
    """Refuse every outbound socket unless the test opted in.

    Patches `socket.socket.connect` rather than a specific HTTP client, so it cannot be bypassed by
    swapping libraries — which is exactly how the original leak happened.
    """
    # `ml` tests download model checkpoints on first use. Their network access is a declared consequence
    # of the marker rather than a separate opt-in, so a new ML test does not silently fail on a cold cache.
    if request.node.get_closest_marker("allow_network") or request.node.get_closest_marker("ml"):
        yield
        return

    def denied(self: socket.socket, address: Any) -> None:
        raise NetworkAccessDenied(
            f"this test tried to connect to {address!r}. Tests must not touch the network: pass a fake "
            "opener or client instead, or mark the test with @pytest.mark.allow_network if it genuinely "
            "must. See tests/conftest.py for why this is blocked."
        )

    socket.socket.connect = denied  # type: ignore[assignment,method-assign]
    try:
        yield
    finally:
        socket.socket.connect = _REAL_CONNECT  # type: ignore[method-assign]


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "allow_network: this test genuinely needs outbound network access")
