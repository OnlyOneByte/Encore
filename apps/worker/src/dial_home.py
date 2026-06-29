"""Encore worker — dial-home WS client (SCAFFOLD).

The worker connects TO the core (never the reverse), so it scales to N and runs on any
box / GPU across NAT. See docs/job-lifecycle-and-worker-protocol.md §5.

This stub establishes the connection + hello/heartbeat shape. Real stem/align handlers
(stems.py, align.py) and the lease/accept/progress/complete protocol land when the smart
feature is built (container 2 only — not part of the MVP).
"""
import asyncio
import json
import os

CORE_URL = os.environ.get("ENCORE_CORE_WS", "ws://localhost:3000/ws?role=worker")
WORKER_ID = os.environ.get("ENCORE_WORKER_ID", "worker-1")
CONCURRENCY = int(os.environ.get("ENCORE_WORKER_CONCURRENCY", "1"))


async def main() -> None:
    # `websockets` is a container-2 dependency; imported lazily so the stub documents intent
    # without forcing the dep into the MVP image.
    import websockets  # type: ignore

    async with websockets.connect(CORE_URL) as ws:
        await ws.send(json.dumps({
            "type": "worker:hello",
            "workerId": WORKER_ID,
            "capabilities": ["stems", "align"],
            "concurrency": CONCURRENCY,
            "version": "0.0.0",
        }))
        async for raw in ws:
            msg = json.loads(raw)
            # TODO: handle job:assign -> accept -> Demucs/WhisperX -> progress -> complete
            print(f"[worker] <- {msg.get('type')}")


if __name__ == "__main__":
    asyncio.run(main())
