"""Worker-side MediaStore config (M7-C10): parse the `worker:welcome` mediaStore handshake and
resolve WHERE this worker reads source / writes stems — a shared local volume (single-box) or an
S3/MinIO bucket (scale-out, MASTER-DESIGN §2).

PURE config + key resolution (no boto3, no network) is unit-tested here. The actual S3 upload is a
thin injectable seam (Uploader) the processor calls after writing locally — on a real worker box
that's a boto3/minio put; in tests it's a fake. Mirrors the TS MediaStore: local default, object
opt-in, identical key layout (stems/<id>-instrumental.wav, lyrics/<id>.json) so the core resolves
the same ref it told the worker to write.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass
class MediaStoreConfig:
    kind: str  # 'local' | 'object'
    bucket: str | None = None
    endpoint: str | None = None
    region: str | None = None
    prefix: str | None = None  # already normalized by the core (single trailing '/', or None)

    @property
    def is_object(self) -> bool:
        return self.kind == "object" and bool(self.bucket)


def parse_media_store(welcome: dict[str, Any]) -> MediaStoreConfig:
    """Read the mediaStore block out of a worker:welcome message. Anything not a usable object
    config (missing kind/bucket) → local, so a worker NEVER fails to run because of a bad handshake."""
    ms = welcome.get("mediaStore") if isinstance(welcome, dict) else None
    if not isinstance(ms, dict) or ms.get("kind") != "object":
        return MediaStoreConfig(kind="local")
    bucket = ms.get("bucket")
    if not isinstance(bucket, str) or not bucket.strip():
        return MediaStoreConfig(kind="local")  # object requested but unusable → safe default
    return MediaStoreConfig(
        kind="object",
        bucket=bucket.strip(),
        endpoint=_str_or_none(ms.get("endpoint")),
        region=_str_or_none(ms.get("region")),
        prefix=_str_or_none(ms.get("prefix")),
    )


def object_key(config: MediaStoreConfig, ref: str) -> str:
    """The full S3 key for a media ref under the configured prefix (matches the core's objectKey)."""
    return f"{config.prefix or ''}{ref}"


def _str_or_none(v: Any) -> str | None:
    return v.strip() if isinstance(v, str) and v.strip() else None


# A publisher takes a local file path + its media ref and makes it reachable by the core. For a
# local store that's a no-op (already on the shared volume); for an object store it uploads to S3.
Uploader = Callable[[str, str], None]


def make_publisher(config: MediaStoreConfig, s3_put: Callable[[str, str, str], None] | None = None) -> Uploader:
    """Build the post-process publisher for a store config. local → no-op (the file is already on
    the shared volume the core reads). object → upload local_path to bucket/object_key(ref) via the
    injected s3_put(bucket, key, local_path) (boto3/minio on a real worker; a fake in tests)."""
    if not config.is_object:
        return lambda local_path, ref: None
    if s3_put is None:
        raise ValueError("object MediaStore requires an s3_put uploader")

    def publish(local_path: str, ref: str) -> None:
        s3_put(config.bucket, object_key(config, ref), local_path)  # type: ignore[arg-type]

    return publish
