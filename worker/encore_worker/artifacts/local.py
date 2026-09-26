"""`ArtifactStore` over a shared filesystem — the single-box deployment, and the only one wired today.

WHAT MAKES THIS MORE THAN `shutil.move`. Three things, each of which was a real bug somewhere:

  1. PER-CLASS ROOTS. A key's first segment names its storage class, and each class root is independently
     overridable (`ENCORE_AUDIO_DIR`, `ENCORE_DERIVED_DIR`, `ENCORE_META_DIR`) so classes can sit on
     different disks — back up `audio/`, put the recomputable `derived/` on cheap storage. A class dir may
     point OUTSIDE the media root, so a key CANNOT simply be joined onto that root. Core's `resolveBase`
     does exactly this; a worker that skips it writes where core will never look.
  2. ATOMIC PUBLICATION. Core serves byte ranges off these keys while we write. `os.replace` is atomic
     within a filesystem, so the temp file is created in the DESTINATION directory rather than in /tmp —
     a cross-device rename is not atomic and silently degrades to copy-then-unlink.
  3. REFUSING TO ESCAPE THE ROOT. A key is data that reached us over a socket. `derived/../../etc/passwd`
     resolves outside the class root, and a store that writes it is an arbitrary-write primitive.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from dataclasses import dataclass

from encore_worker.artifacts import keys
from encore_worker.artifacts.ports import ArtifactStoreError


@dataclass(frozen=True, slots=True)
class Roots:
    """Where each storage class lives, already resolved to absolute paths.

    Separate from the store so the resolution is testable without a filesystem, and so `host/config.py`
    owns reading the environment — this module never touches `os.environ`.
    """

    media: str
    audio: str
    derived: str
    meta: str

    @staticmethod
    def under(media_dir: str) -> Roots:
        """The default layout: every class a child of the media root, matching core's fallbacks."""
        base = os.path.abspath(media_dir)
        return Roots(
            media=base,
            audio=os.path.join(base, "audio"),
            derived=os.path.join(base, "derived"),
            meta=os.path.join(base, "meta"),
        )

    def of_class(self, cls: str) -> str:
        match cls:
            case "audio":
                return self.audio
            case "derived":
                return self.derived
            case "meta":
                return self.meta
            case "work":
                # Deliberately NOT overridable, mirroring core: scratch is transient and must sit next to
                # the work rather than on whichever disk someone pointed a class at.
                return os.path.join(self.media, "work")
            case _:
                return self.media


class LocalArtifactStore:
    """Publishes by moving a finished file into place under the right class root."""

    def __init__(self, roots: Roots) -> None:
        self._roots = roots

    def path_of(self, ref: str) -> str:
        """The absolute path a ref names. Raises rather than returning a path outside its class root.

        Public because the end-to-end test needs to assert a published file is where core would look for
        it, and re-deriving that in the test would just be a second copy of this logic to get wrong.
        """
        clean = ref.lstrip("/")
        if not clean:
            raise ArtifactStoreError("empty artifact ref")
        cls = keys.class_of(clean)
        base = self._roots.of_class(cls)
        # A classed key carries its class as the first segment; the root already encodes it, so the segment
        # is stripped rather than joined twice. `root` keys have no segment to strip.
        rest = clean if cls == "root" else clean[len(cls) + 1 :]
        if not rest:
            raise ArtifactStoreError(f"ref names a class but no file: {ref!r}")
        resolved = os.path.abspath(os.path.join(base, rest))
        # `commonpath` rather than `startswith`: `/media/derived-evil` startswith `/media/derived`.
        if os.path.commonpath([resolved, os.path.abspath(base)]) != os.path.abspath(base):
            raise ArtifactStoreError(f"ref escapes its storage class root: {ref!r}")
        return resolved

    async def put(self, ref: str, source: str) -> None:
        target = self.path_of(ref)
        if not os.path.isfile(source):
            raise ArtifactStoreError(f"nothing to publish at {source!r} for ref {ref!r}")
        directory = os.path.dirname(target)
        os.makedirs(directory, exist_ok=True)
        # The temp file is created IN the destination directory so the rename below cannot cross devices.
        handle, staged = tempfile.mkstemp(dir=directory, prefix=".publishing-", suffix=".part")
        os.close(handle)
        try:
            # `move` and not `copy`: the source is scratch we are done with, and on the same filesystem
            # this is a rename rather than tens of megabytes of copying. Falls back to a copy across
            # devices, which is why the atomic step below is separate.
            shutil.move(source, staged)
            os.replace(staged, target)
        except OSError as exc:
            raise ArtifactStoreError(f"could not publish {ref!r}: {exc}") from exc
        finally:
            # Only reached with `staged` still present if the move or replace failed — a leftover
            # `.publishing-*` would otherwise accumulate in a real media directory.
            if os.path.exists(staged):
                os.unlink(staged)

    async def exists(self, ref: str) -> bool:
        try:
            return os.path.isfile(self.path_of(ref))
        except ArtifactStoreError:
            # A malformed ref does not exist, and answering the question is better than raising from what
            # callers use as a cheap idempotency check.
            return False
