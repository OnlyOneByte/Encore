"""`LocalArtifactStore`: where a ref lands, and that publication is atomic and cannot escape its root.

The three properties here each correspond to a way this can be wrong in production rather than in a test:
a key resolved against the wrong root writes where core never looks; a non-atomic replace hands the TV a
truncated FLAC mid-song; and a ref is data off a socket, so a traversal is an arbitrary-write primitive.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from encore_worker.artifacts import keys
from encore_worker.artifacts.local import LocalArtifactStore, Roots
from encore_worker.artifacts.ports import ArtifactStore, ArtifactStoreError


@pytest.fixture
def media(tmp_path: Path) -> Path:
    return tmp_path / "media"


@pytest.fixture
def store(media: Path) -> LocalArtifactStore:
    return LocalArtifactStore(Roots.under(str(media)))


def a_file(path: Path, content: bytes = b"audio-bytes") -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return str(path)


def test_it_satisfies_the_port(store: LocalArtifactStore) -> None:
    """`runtime_checkable` only checks method NAMES, so this is a weak check by construction — it catches a
    rename, not a signature change. mypy covers the rest, which is why the Protocol is worth having."""
    assert isinstance(store, ArtifactStore)


# ── resolution ───────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("ref", "expected"),
    [
        ("audio/m1.webm", "audio/m1.webm"),
        ("derived/stems/m1-instrumental.flac", "derived/stems/m1-instrumental.flac"),
        ("meta/m1.json", "meta/m1.json"),
        ("work/job-1/scratch.wav", "work/job-1/scratch.wav"),
    ],
)
def test_a_default_layout_puts_every_class_under_the_media_root(
    store: LocalArtifactStore, media: Path, ref: str, expected: str
) -> None:
    assert store.path_of(ref) == str(media / expected)


def test_a_class_root_may_point_outside_the_media_root(tmp_path: Path) -> None:
    """THE reason a key cannot simply be joined onto the media root. Splitting classes across filesystems is
    the documented deployment — back up `audio/`, put recomputable `derived/` on cheap disk — so `derived`
    legitimately resolves somewhere that is not a child of `media`."""
    roots = Roots(
        media=str(tmp_path / "media"),
        audio=str(tmp_path / "media" / "audio"),
        derived=str(tmp_path / "cheap-disk" / "derived"),
        meta=str(tmp_path / "media" / "meta"),
    )
    store = LocalArtifactStore(roots)
    resolved = store.path_of("derived/stems/m1-instrumental.flac")
    assert resolved == str(tmp_path / "cheap-disk" / "derived" / "stems" / "m1-instrumental.flac")
    assert "media" not in resolved, "the class root must win over the media root"


def test_the_class_segment_is_stripped_not_repeated(tmp_path: Path) -> None:
    """The root already encodes the class. Joining the whole key onto it yields `derived/derived/...`, which
    is a real file in a real directory that core will never read."""
    store = LocalArtifactStore(Roots.under(str(tmp_path)))
    assert store.path_of("derived/x.json").count("derived") == 1


def test_work_is_deliberately_not_overridable(tmp_path: Path) -> None:
    """Mirrors core. Scratch is transient and must sit next to the work rather than on whichever disk a
    class was pointed at — an override would put a 40-minute separation's scratch on a backed-up volume."""
    roots = Roots(
        media=str(tmp_path / "media"),
        audio=str(tmp_path / "elsewhere"),
        derived=str(tmp_path / "elsewhere"),
        meta=str(tmp_path / "elsewhere"),
    )
    assert LocalArtifactStore(roots).path_of("work/j/x.wav") == str(
        tmp_path / "media" / "work" / "j" / "x.wav"
    )


def test_an_unclassed_ref_falls_back_to_the_media_root(store: LocalArtifactStore, media: Path) -> None:
    assert store.path_of("thumbs/m1.png") == str(media / "thumbs" / "m1.png")


# ── refusing to escape ───────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "ref",
    [
        "derived/../../etc/passwd",
        "derived/../../../tmp/evil",
        "audio/../../escape",
        "derived/a/../../../../x",
    ],
)
def test_a_traversal_is_refused(store: LocalArtifactStore, ref: str) -> None:
    """A ref arrives over a socket. A store that writes this is an arbitrary-write primitive, so the refusal
    is a security boundary rather than tidiness."""
    with pytest.raises(ArtifactStoreError, match="escapes its storage class root"):
        store.path_of(ref)


def test_a_sibling_directory_with_a_shared_prefix_is_refused(tmp_path: Path) -> None:
    """Why `commonpath` and not `startswith`: `/x/derived-evil` startswith `/x/derived`. A prefix check
    passes this and writes outside the class root."""
    roots = Roots(
        media=str(tmp_path),
        audio=str(tmp_path / "audio"),
        derived=str(tmp_path / "derived"),
        meta=str(tmp_path / "meta"),
    )
    store = LocalArtifactStore(roots)
    with pytest.raises(ArtifactStoreError):
        store.path_of("derived/../derived-evil/x.flac")


@pytest.mark.parametrize("ref", ["", "/", "derived", "derived/", "audio"])
def test_a_ref_that_names_no_file_is_refused(store: LocalArtifactStore, ref: str) -> None:
    with pytest.raises(ArtifactStoreError):
        store.path_of(ref)


# ── publication ──────────────────────────────────────────────────────────────────────────────────


async def test_it_publishes_to_the_key_core_will_read(
    store: LocalArtifactStore, media: Path, tmp_path: Path
) -> None:
    ref = keys.instrumental_key("m1")
    await store.put(ref, a_file(tmp_path / "scratch" / "out.flac", b"stem"))
    assert (media / "derived" / "stems" / "m1-instrumental.flac").read_bytes() == b"stem"


async def test_it_creates_missing_directories(store: LocalArtifactStore, tmp_path: Path) -> None:
    """First publication on a fresh box: nothing under `derived/` exists yet."""
    await store.put(keys.lyrics_key("m1"), a_file(tmp_path / "s" / "doc.json", b"{}"))
    assert await store.exists(keys.lyrics_key("m1"))


async def test_publishing_twice_replaces_rather_than_erroring(
    store: LocalArtifactStore, media: Path, tmp_path: Path
) -> None:
    """A durable step can be retried after its bytes landed. The second attempt must win cleanly, because
    the alternative is a job that can never complete once it has partially succeeded."""
    ref = keys.instrumental_key("m1")
    await store.put(ref, a_file(tmp_path / "a.flac", b"first"))
    await store.put(ref, a_file(tmp_path / "b.flac", b"second"))
    assert (media / "derived" / "stems" / "m1-instrumental.flac").read_bytes() == b"second"


async def test_the_source_is_consumed(store: LocalArtifactStore, tmp_path: Path) -> None:
    """Moved, not copied: the source is scratch we are done with, and a lossless stem is tens of megabytes.
    Leaving it behind doubles peak disk for every job."""
    source = a_file(tmp_path / "scratch.flac", b"x")
    await store.put(keys.vocals_key("m1"), source)
    assert not os.path.exists(source)


async def test_a_reader_never_sees_a_partial_file(
    store: LocalArtifactStore, media: Path, tmp_path: Path
) -> None:
    """THE property that makes this more than `shutil.move`. Core serves byte ranges off this key while we
    write, so a reader must see the old file or the new one — never a truncated stream, which the player
    reports as a decode failure with nothing pointing back here.

    Observed by watching the destination directory: the staged file must be a DIFFERENT name from the target
    for the whole write, so the target only ever appears complete.
    """
    ref = keys.instrumental_key("m1")
    target = media / "derived" / "stems" / "m1-instrumental.flac"
    await store.put(ref, a_file(tmp_path / "v1.flac", b"old-content"))

    seen: list[bytes] = []
    real_replace = os.replace

    def watching_replace(src: object, dst: object) -> None:
        # Mid-publication: the target must still hold the PREVIOUS complete file, not the new partial one.
        seen.append(target.read_bytes())
        real_replace(src, dst)  # type: ignore[arg-type]

    import unittest.mock

    with unittest.mock.patch("os.replace", watching_replace):
        await store.put(ref, a_file(tmp_path / "v2.flac", b"new-longer-content"))

    assert seen == [b"old-content"], "the target was modified before the atomic swap"
    assert target.read_bytes() == b"new-longer-content"


async def test_the_staging_file_is_in_the_destination_directory(
    store: LocalArtifactStore, media: Path, tmp_path: Path
) -> None:
    """`os.replace` is only atomic WITHIN a filesystem. Staging in /tmp silently degrades to
    copy-then-unlink across devices, which reintroduces the partial-read window this exists to close."""
    ref = keys.instrumental_key("m1")
    staged_dirs: list[str] = []
    real_replace = os.replace

    def capture(src: object, dst: object) -> None:
        staged_dirs.append(os.path.dirname(str(src)))
        real_replace(src, dst)  # type: ignore[arg-type]

    import unittest.mock

    with unittest.mock.patch("os.replace", capture):
        await store.put(ref, a_file(tmp_path / "x.flac", b"y"))

    assert staged_dirs == [str(media / "derived" / "stems")]


async def test_a_missing_source_is_refused_before_anything_is_touched(
    store: LocalArtifactStore, media: Path
) -> None:
    """A publish step whose encode silently produced nothing must fail loudly, not publish a zero-byte
    file that core records as ready."""
    with pytest.raises(ArtifactStoreError, match="nothing to publish"):
        await store.put(keys.instrumental_key("m1"), str(media / "does-not-exist.flac"))
    assert not (media / "derived").exists()


async def test_a_failed_publish_leaves_no_staging_litter(
    store: LocalArtifactStore, media: Path, tmp_path: Path
) -> None:
    """A leftover `.publishing-*` accumulates in a real media directory, and retention does not know to
    evict it because no ref names it."""
    ref = keys.instrumental_key("m1")
    import unittest.mock

    with unittest.mock.patch("os.replace", side_effect=OSError("disk full")):
        with pytest.raises(ArtifactStoreError, match="could not publish"):
            await store.put(ref, a_file(tmp_path / "x.flac", b"y"))

    litter = list((media / "derived" / "stems").glob(".publishing-*"))
    assert litter == [], f"staging files left behind: {litter}"


# ── exists ───────────────────────────────────────────────────────────────────────────────────────


async def test_exists_is_false_for_an_unpublished_ref(store: LocalArtifactStore) -> None:
    assert await store.exists(keys.instrumental_key("nope")) is False


async def test_exists_is_false_rather_than_raising_for_a_malformed_ref(store: LocalArtifactStore) -> None:
    """Callers use this as a cheap idempotency check, so answering the question beats raising from it. The
    write path still refuses the same ref — that is where the boundary is enforced."""
    assert await store.exists("derived/../../etc/passwd") is False


async def test_exists_is_false_for_a_directory(store: LocalArtifactStore, tmp_path: Path) -> None:
    """`isfile`, not `exists`: a directory at a ref is not a published artifact, and treating it as one
    would let a publish step skip its work and report success."""
    await store.put(keys.instrumental_key("m1"), a_file(tmp_path / "x.flac", b"y"))
    assert await store.exists("derived/stems") is False
