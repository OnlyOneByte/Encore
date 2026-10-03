"""`ArtifactStore` over a shared filesystem — the single-box deployment, and the only one wired today.

Per-class roots, atomic publication and refusing to escape the root are what make this more than
`shutil.move`, and each was a real bug somewhere: docs/arch/05-worker.md §4.
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

    Separate from the store so resolution is testable without a filesystem; `host/config.py` reads the env.
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
                return os.path.join(self.media, "work")  # not overridable; docs/arch/05-worker.md §4
            case _:
                return self.media


class LocalArtifactStore:
    """Publishes by moving a finished file into place under the right class root."""

    def __init__(self, roots: Roots) -> None:
        self._roots = roots

    def path_of(self, ref: str) -> str:
        """The absolute path a ref names. Raises rather than returning a path outside its class root.

        Public so the end-to-end test can assert a published file is where core would look for it.
        """
        clean = ref.lstrip("/")
        if not clean:
            raise ArtifactStoreError("empty artifact ref")
        cls = keys.class_of(clean)
        base = self._roots.of_class(cls)
        # The root already encodes the class, so that segment is stripped rather than joined twice.
        rest = clean if cls == "root" else clean[len(cls) + 1 :]
        if not rest:
            raise ArtifactStoreError(f"ref names a class but no file: {ref!r}")
        resolved = os.path.abspath(os.path.join(base, rest))
        # `commonpath` and not `startswith`: `/media/derived-evil` startswith `/media/derived`.
        if os.path.commonpath([resolved, os.path.abspath(base)]) != os.path.abspath(base):
            raise ArtifactStoreError(f"ref escapes its storage class root: {ref!r}")
        return resolved

    async def put(self, ref: str, source: str) -> None:
        target = self.path_of(ref)
        if not os.path.isfile(source):
            raise ArtifactStoreError(f"nothing to publish at {source!r} for ref {ref!r}")
        directory = os.path.dirname(target)
        os.makedirs(directory, exist_ok=True)
        # Staged IN the destination directory so the rename below cannot cross devices.
        handle, staged = tempfile.mkstemp(dir=directory, prefix=".publishing-", suffix=".part")
        os.close(handle)
        try:
            # `move` and not `copy`, which degrades to a copy across devices — hence the separate
            # `os.replace` (docs/arch/05-worker.md §4).
            shutil.move(source, staged)
            os.replace(staged, target)
        except OSError as exc:
            raise ArtifactStoreError(f"could not publish {ref!r}: {exc}") from exc
        finally:
            # `staged` still exists only if the move or replace failed; a leftover would accumulate.
            if os.path.exists(staged):
                os.unlink(staged)

    async def exists(self, ref: str) -> bool:
        try:
            return os.path.isfile(self.path_of(ref))
        except ArtifactStoreError:
            # A malformed ref does not exist, and this is a cheap idempotency check, not a validator.
            return False
