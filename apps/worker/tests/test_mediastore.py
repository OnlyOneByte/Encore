"""Worker MediaStore config — parse the worker:welcome handshake, resolve S3 keys, and build the
post-process publisher (local no-op vs object upload via an injected fake). Pure; no boto3/network."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import mediastore as ms  # noqa: E402


def test_parse_local_default_and_garbage():
    assert ms.parse_media_store({"mediaStore": {"kind": "local"}}).kind == "local"
    assert ms.parse_media_store({}).kind == "local"
    assert ms.parse_media_store({"mediaStore": "nope"}).kind == "local"
    # object requested but no bucket → safe local fallback
    assert ms.parse_media_store({"mediaStore": {"kind": "object"}}).kind == "local"
    assert ms.parse_media_store({"mediaStore": {"kind": "object", "bucket": "  "}}).kind == "local"


def test_parse_object_config():
    cfg = ms.parse_media_store({"mediaStore": {
        "kind": "object", "bucket": "encore-media",
        "endpoint": "https://minio.lan:9000", "region": "us-west-2", "prefix": "encore/"
    }})
    assert cfg.kind == "object" and cfg.is_object
    assert cfg.bucket == "encore-media"
    assert cfg.endpoint == "https://minio.lan:9000"
    assert cfg.region == "us-west-2"
    assert cfg.prefix == "encore/"


def test_object_key_matches_core_layout():
    cfg = ms.MediaStoreConfig(kind="object", bucket="b", prefix="encore/")
    assert ms.object_key(cfg, "stems/m1-instrumental.wav") == "encore/stems/m1-instrumental.wav"
    nocfg = ms.MediaStoreConfig(kind="local")
    assert ms.object_key(nocfg, "stems/m1.wav") == "stems/m1.wav"  # no prefix


def test_publisher_local_is_a_noop():
    publish = ms.make_publisher(ms.MediaStoreConfig(kind="local"))
    # returns without calling anything / raising
    assert publish("/tmp/x.wav", "stems/x.wav") is None


def test_publisher_object_uploads_to_prefixed_key():
    calls = []
    cfg = ms.MediaStoreConfig(kind="object", bucket="encore-media", prefix="encore/")
    publish = ms.make_publisher(cfg, s3_put=lambda bucket, key, path: calls.append((bucket, key, path)))
    publish("/work/m1-instrumental.wav", "stems/m1-instrumental.wav")
    assert calls == [("encore-media", "encore/stems/m1-instrumental.wav", "/work/m1-instrumental.wav")]


def test_publisher_object_requires_an_uploader():
    cfg = ms.MediaStoreConfig(kind="object", bucket="b")
    with pytest.raises(ValueError, match="requires an s3_put"):
        ms.make_publisher(cfg)  # no s3_put → explicit error (don't silently drop uploads)
