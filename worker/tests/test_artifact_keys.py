"""The KEY MIRROR, checked against core's `paths.ts` rather than trusted.

`artifacts/keys.py` duplicates a decision that lives in TypeScript. The duplication is unavoidable — two
processes, two languages, one on-disk layout — but the drift is not, and core's own header states the
consequence: "a mismatch is SILENT — the file exists and the player 404s." No runtime check can catch it,
both sides being individually self-consistent, so the agreement is asserted at build time from the actual
text of the other side. The scan is justified because the TEXT IS THE ARTIFACT: the alternative is not a
better test but a comment saying "MUST match", which is what both sides had while they drifted. If this
file cannot find `paths.ts` it FAILS rather than skips — a skipped mirror reports green from the moment
someone moves the file, which is when it most needs checking.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from encore_worker.artifacts import keys


#: Walked up to rather than counted down from, so this survives the worker moving inside the repo.
def _paths_ts() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "core/src/lib/server/media/paths.ts"
        if candidate.is_file():
            return candidate
    raise AssertionError(
        f"could not find core/src/lib/server/media/paths.ts above {here}. This is a PATH failure, not a "
        "satisfied invariant — the mirror in artifacts/keys.py is UNCHECKED until it is fixed. Do not "
        "convert this into a skip."
    )


@pytest.fixture(scope="module")
def source() -> str:
    return _paths_ts().read_text()


def template_of(source: str, fn: str) -> str:
    """The backtick template a single-expression key function returns.

    Deliberately a narrow regex over one function rather than a TS parser: the thing being pinned is a
    one-line string template, and a parser would be a large dependency to assert something this small.
    A function that stops being a one-line return fails here loudly rather than being mis-read.
    """
    match = re.search(
        rf"export function {re.escape(fn)}\([^)]*\)\s*:\s*string\s*\{{\s*return\s+`([^`]+)`",
        source,
        re.DOTALL,
    )
    assert match, f"{fn} not found in paths.ts as a single-template return — the mirror cannot be checked"
    return match.group(1)


def const_of(source: str, name: str) -> str:
    match = re.search(rf"export const {re.escape(name)}\s*=\s*'([^']+)'", source)
    assert match, f"const {name} not found in paths.ts"
    return match.group(1)


def list_of(source: str, name: str) -> tuple[str, ...]:
    match = re.search(rf"(?:export )?const {re.escape(name)}\s*=\s*\[([^\]]+)\]", source)
    assert match, f"const {name} not found in paths.ts"
    return tuple(re.findall(r"'([^']+)'", match.group(1)))


# ── the key templates ────────────────────────────────────────────────────────────────────────────

#: `(paths.ts function, our function, the args to call ours with)`. The TS side is turned into a concrete
#: string by substituting the same values, so the comparison is of RESULTS rather than of source text —
#: reformatting either side cannot break this, but changing a segment will.
MIRRORED = [
    ("audioKey", lambda: keys.audio_key("m1", "webm"), {"mediaId": "m1", "ext": "webm"}),
    ("instrumentalKey", lambda: keys.instrumental_key("m1", "flac"), {"mediaId": "m1", "ext": "flac"}),
    ("vocalsKey", lambda: keys.vocals_key("m1", "flac"), {"mediaId": "m1", "ext": "flac"}),
    ("guideMixKey", lambda: keys.guide_mix_key("m1", "flac"), {"mediaId": "m1", "ext": "flac"}),
    ("lyricsKey", lambda: keys.lyrics_key("m1"), {"mediaId": "m1"}),
    ("metaKey", lambda: keys.meta_key("m1"), {"mediaId": "m1"}),
    (
        "rawCaptionKey",
        lambda: keys.raw_caption_key("m1", "auto-captions", "vtt"),
        {"mediaId": "m1", "kind": "auto-captions", "ext": "vtt"},
    ),
]


def render(template: str, bindings: dict[str, str]) -> str:
    """A TS template literal with `${name}` and `${name.replace(...)}` holes filled in.

    The `.replace(/^\\./, '')` calls strip a leading dot from an ext; our side does `lstrip('.')` and the
    bindings here never carry one, so substituting the bare value is faithful.
    """
    out = template
    for name, value in bindings.items():
        out = re.sub(r"\$\{" + re.escape(name) + r"(?:\.replace\([^)]*\))?\}", value, out)
    assert "${" not in out, f"unsubstituted hole in {template!r} — bindings {sorted(bindings)} incomplete"
    return out


@pytest.mark.parametrize(("ts_name", "ours", "bindings"), MIRRORED, ids=[m[0] for m in MIRRORED])
def test_our_key_matches_cores(source: str, ts_name: str, ours: object, bindings: dict[str, str]) -> None:
    expected = render(template_of(source, ts_name), bindings)
    assert callable(ours)
    assert ours() == expected, (
        f"{ts_name} disagrees with artifacts/keys.py.\n"
        f"  core:   {expected}\n  worker: {ours()}\n"
        "A mismatch here is SILENT in production: the file exists, the DB row is right, the player 404s."
    )


# ── the extension constants ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("ts_name", "our_value"),
    [
        ("INSTRUMENTAL_EXT", keys.INSTRUMENTAL_EXT),
        ("VOCALS_EXT", keys.VOCALS_EXT),
        ("GUIDE_MIX_EXT", keys.GUIDE_MIX_EXT),
    ],
)
def test_default_exts_match(source: str, ts_name: str, our_value: str) -> None:
    """These are DEFAULTS on both sides, not the live value — core announces that at handshake. They still
    have to agree, because they are what a worker that was told nothing falls back to."""
    assert const_of(source, ts_name) == our_value


def test_known_audio_exts_match(source: str) -> None:
    """A superset is free here; one too few permanently orphans the unrecoverable class. Order matters —
    both sides serve newest-first."""
    assert list_of(source, "KNOWN_AUDIO_EXTS") == keys.KNOWN_AUDIO_EXTS


def test_known_stem_exts_cover_cores_vocals_exts(source: str) -> None:
    """Ours is named for STEMS because it is used for the instrumental and the guide mix too; core's list is
    still called KNOWN_VOCALS_EXTS. The names differ deliberately, so the CONTENTS are pinned instead."""
    assert list_of(source, "KNOWN_VOCALS_EXTS") == keys.KNOWN_STEM_EXTS


def test_caption_kinds_and_exts_match(source: str) -> None:
    assert list_of(source, "CAPTION_KINDS") == keys.CAPTION_KINDS
    assert list_of(source, "KNOWN_CAPTION_EXTS") == keys.KNOWN_CAPTION_EXTS


def test_storage_classes_match(source: str) -> None:
    """Core declares these as a union type rather than an array, so this reads the type. `root` is the
    sentinel for "names no class" on both sides and is not a directory."""
    match = re.search(r"export type StorageClass\s*=\s*([^;]+);", source)
    assert match, "StorageClass union not found in paths.ts"
    declared = set(re.findall(r"'([^']+)'", match.group(1)))
    assert declared - {"root"} == set(keys.CLASSES)


# ── behaviour of the derived helpers, which have no template to compare against ──────────────────


def test_legacy_vocals_refs_enumerate_every_stem_ext() -> None:
    refs = keys.legacy_vocals_refs("derived/stems/m1-instrumental.flac")
    assert refs == tuple(f"derived/stems/m1-vocals.{ext}" for ext in keys.KNOWN_STEM_EXTS)


def test_a_ref_with_no_instrumental_marker_has_no_sibling() -> None:
    """Empty is how a caller tells "no sibling is possible" from "it is one of these"."""
    assert keys.legacy_vocals_refs("derived/lyrics/m1.json") == ()


def test_candidate_audio_refs_are_deduplicated_and_newest_first() -> None:
    refs = keys.candidate_audio_refs("m1")
    assert refs[0] == "audio/m1.webm"
    assert len(refs) == len(set(refs))


def test_class_of_reads_the_first_segment() -> None:
    assert keys.class_of("derived/stems/m1-instrumental.flac") == "derived"
    assert keys.class_of("audio/m1.webm") == "audio"
    assert keys.class_of("meta/m1.json") == "meta"
    assert keys.class_of("work/job-1/scratch.wav") == "work"
    # Not a class: must fall back to `root` rather than inventing a directory.
    assert keys.class_of("thumbs/m1.png") == "root"
    assert keys.class_of("/derived/stems/x.flac") == "derived", "a leading slash must not hide the class"


def test_an_ext_is_accepted_with_or_without_its_dot() -> None:
    """Core strips a leading dot in every key function; ours must too, or `.flac` yields `..flac`."""
    assert keys.instrumental_key("m1", ".flac") == keys.instrumental_key("m1", "flac")
    assert keys.audio_key("m1", ".webm") == keys.audio_key("m1", "webm")


def test_a_lyrics_candidate_ref_is_safe_as_a_key() -> None:
    """A label is `asr:vocals`-shaped, and a colon is not safe in every object-store key or filesystem."""
    ref = keys.lyrics_candidate_key("m1", "asr:vocals", "word")
    assert ":" not in ref
    assert ref.startswith("derived/lyrics/")


def test_every_published_key_lands_in_a_real_storage_class() -> None:
    """A key whose class is `root` bypasses the per-class roots, so it would ignore ENCORE_DERIVED_DIR and
    land somewhere core does not look when the classes sit on different disks."""
    published = [
        keys.audio_key("m1"),
        keys.instrumental_key("m1"),
        keys.vocals_key("m1"),
        keys.guide_mix_key("m1"),
        keys.lyrics_key("m1"),
        keys.lyrics_candidate_key("m1", "lrcmux", "line"),
        keys.raw_caption_key("m1", "captions"),
        keys.meta_key("m1"),
    ]
    for ref in published:
        assert keys.class_of(ref) in keys.CLASSES, f"{ref} has no storage class"
