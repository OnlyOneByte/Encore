"""A worker comes back within seconds of a restarted core (#1082), timed against a real websocket core.

The one transport test that dials a real socket and waits on a real clock: what it proves is how long the
default backoff keeps a worker away, which a zero-delay fake cannot show. It dials loopback only, an
ephemeral port it binds itself, so it marks itself `allow_network` and reaches nothing off the box.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import time
from typing import Any

import pytest
import websockets

from encore_worker.host.config import Config
from encore_worker.protocol import frames as f
from encore_worker.transport.client import Client

#: Down long enough that the worker has failed a few dials and reached the cap.
OUTAGE_SEC = 6.0
#: The cap, 3 s, with its jitter is 4.5 s; the rest is the dial and the handshake.
BACK_WITHIN_SEC = 5.0


async def _never(_assign: f.Assign) -> f.Complete:  # pragma: no cover - never invoked
    raise AssertionError("run_job should not be called")


@pytest.mark.allow_network
async def test_a_worker_is_back_within_seconds_of_a_core_restart() -> None:
    connected = asyncio.Event()

    async def core(ws: Any) -> None:
        connected.set()
        async for _ in ws:
            await ws.send(json.dumps({"type": "worker:welcome", "workerId": "w1"}))

    server = await websockets.serve(core, "127.0.0.1", 0)
    port = next(iter(server.sockets)).getsockname()[1]
    cfg = Config(core_url=f"ws://127.0.0.1:{port}/ws?role=worker", worker_id="w1", concurrency=1, version="9")

    async def dial(url: str) -> Any:
        return await websockets.connect(url, max_size=None)

    worker = asyncio.create_task(
        Client(config=cfg, connect=dial, run_job=_never, capabilities=frozenset({"align"})).serve_forever()
    )
    try:
        await asyncio.wait_for(connected.wait(), 10.0)
        server.close()
        await server.wait_closed()
        connected.clear()
        await asyncio.sleep(OUTAGE_SEC)
        server = await websockets.serve(core, "127.0.0.1", port)
        back = time.monotonic()
        await asyncio.wait_for(connected.wait(), 30.0)
        took = time.monotonic() - back
        assert took < BACK_WITHIN_SEC, f"the worker came back {took:.1f} s after core did"
    finally:
        worker.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await worker
        server.close()
        await server.wait_closed()
