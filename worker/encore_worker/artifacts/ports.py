"""The ARTIFACT STORE seam — two methods, structurally typed, so a fake store needs no filesystem.

Why a port at all, why only these two methods, and what `put` must guarantee: docs/arch/05-worker.md §4.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


class ArtifactStoreError(RuntimeError):
    """A store could not accept bytes. Retryable by default; docs/arch/05-worker.md §4."""

    retryable = True


@runtime_checkable
class ArtifactStore(Protocol):
    """Where published bytes go, keyed by the refs in `keys.py`."""

    async def put(self, ref: str, source: str) -> None:
        """Place the file at `source` under `ref`, replacing anything there. MUST BE ATOMIC AS OBSERVED BY A
        READER, and `source` is CONSUMED: docs/arch/05-worker.md §4."""
        ...

    async def exists(self, ref: str) -> bool:
        """Is something already published at this ref? For idempotency, never for correctness — a `False` is
        not proof that publishing is safe, ownership being what answers that."""
        ...
