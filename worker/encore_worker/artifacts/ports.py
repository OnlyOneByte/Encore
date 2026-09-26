"""The ARTIFACT STORE seam — two methods, structurally typed.

WHY A PORT FOR SOMETHING AS SMALL AS "WRITE A FILE". Because it is not always a file. Core runs one of two
MediaStore backends and ANNOUNCES which at handshake (`worker:welcome` carries `mediaStore`): `local` is a
shared filesystem, `object` is S3/MinIO for workers that do not share a disk. Both are keyed by the same
ref, so the only thing that differs is how bytes get there. Putting that behind a Protocol now means the
object backend is an added file rather than a change to every publish site.

It also keeps the fast suite honest: a fake store needs no filesystem, so a publish decision is testable
without asking whether a temp directory was writable.

DELIBERATELY TINY. `put` and `exists` are enough to publish and to answer "did a previous attempt already
land this". Reading bytes back is core's job, not ours — the worker never serves media.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


class ArtifactStoreError(RuntimeError):
    """A store could not accept bytes.

    RETRYABLE by default, which is the honest default for storage: a full disk, a permission problem or an
    S3 5xx are all worth another attempt, and the ones that are not (a malformed key) are programming
    errors that a retry will surface identically rather than hide.
    """

    retryable = True


@runtime_checkable
class ArtifactStore(Protocol):
    """Where published bytes go, keyed by the refs in `keys.py`."""

    async def put(self, ref: str, source: str) -> None:
        """Place the file at `source` under `ref`, replacing anything already there.

        MUST BE ATOMIC AS OBSERVED BY A READER. Core serves byte-range requests off these same keys while
        the worker is writing — `MediaStore.getRange` exists precisely for the TV's seeking — so a reader
        must see either the old file or the new one, never a partial stream. A half-written FLAC is a
        CORRUPT stream rather than a missing one, and the player reports it as a decode failure with
        nothing pointing back here.

        Takes a PATH rather than bytes: a lossless stem is tens of megabytes and the caller has just
        written it to scratch anyway, so reading it into memory to hand it over buys nothing.

        `source` is consumed by the move where the implementation can — callers must not reuse it after.
        """
        ...

    async def exists(self, ref: str) -> bool:
        """Is something already published at this ref?

        For idempotency, not for correctness: a durable step that is retried after its bytes landed should
        not redo a 40-minute encode. A False is never proof that publishing is safe — ownership answers
        that, and it is asked separately.
        """
        ...
