"""The packaging invariants that were each established by a MEASURED resolution failure.

WHY THESE ARE TESTS AND NOT JUST COMMENTS. Every assertion here was learned the hard way — a lock that
would not resolve, an ABI mismatch, a deprecation that will land on a future wheel — and each is recorded
in a `pyproject.toml` comment saying "do not simplify this". A comment does not survive a plausible-looking
cleanup; a failing test does.

These read configuration as data, which is the one place a text-shaped assertion is honest: the config IS
the subject, so there is no behaviour underneath it that the test could be substituting for. That is the
opposite of a source scan asserting a line exists in a module that has real behaviour to drive instead.
"""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any

import pytest

PYPROJECT = Path(__file__).parent.parent / "pyproject.toml"

#: These three ship a shared C++ ABI and must move together.
TORCH_TRIO = ("torch", "torchaudio", "torchvision")


@pytest.fixture(scope="module")
def config() -> dict[str, Any]:
    with PYPROJECT.open("rb") as handle:
        loaded: dict[str, Any] = tomllib.load(handle)
    return loaded


def extras(config: dict[str, Any]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = config["project"]["optional-dependencies"]
    return result


# ── the torch pins ───────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("backend", ["cpu", "cu128"])
def test_the_torch_trio_is_pinned_exactly(config: dict[str, Any], backend: str) -> None:
    """A `>=` here is not a loose pin but a broken install: torchaudio built against a different torch minor
    fails at import as `ImportError: undefined symbol`, and nothing about the message says why.

    It is ALSO what holds off torchcodec. torchaudio 2.9 routes `torchaudio.load` through torchcodec, which
    links ffmpeg 4-7, and this machine has ffmpeg 9 (libavutil 61), so that path cannot load at all. We
    never call `torchaudio.load` ourselves but demucs and whisperx do, so a float to 2.9 would break
    separation and alignment through a dependency. The exact pin makes that a deliberate bump."""
    pins = {
        name: spec for spec in extras(config)[backend] for name in TORCH_TRIO if spec.startswith(f"{name}==")
    }
    assert set(pins) == set(TORCH_TRIO), f"{backend} must pin all of {TORCH_TRIO}, got {sorted(pins)}"


def test_the_two_backends_pin_identical_versions(config: dict[str, Any]) -> None:
    """`cpu` and `cu128` differ ONLY in which index serves the wheels (see `[tool.uv.sources]`). If the
    version sets drifted apart, moving a box from CPU to CUDA would silently change model behaviour as
    well as the device — and the resulting difference in output would be attributed to the GPU."""
    assert sorted(extras(config)["cpu"]) == sorted(extras(config)["cu128"])


def test_the_backends_are_declared_mutually_exclusive(config: dict[str, Any]) -> None:
    """What lets ONE lockfile hold both. Without it uv tries to satisfy two torch indexes at once, which
    is unsatisfiable, and reports a resolution error rather than saying the extras conflict."""
    conflicts = config["tool"]["uv"]["conflicts"]
    declared = [{entry["extra"] for entry in group} for group in conflicts]
    assert {"cpu", "cu128"} in declared, f"cpu/cu128 must be declared conflicting, got {declared}"


def test_every_pytorch_index_is_explicit(config: dict[str, Any]) -> None:
    """Without `explicit = true` the pytorch index shadows PyPI for every package it happens to carry —
    which is a surprising number of them, resolved from a wheelhouse that is not their home."""
    for index in config["tool"]["uv"]["index"]:
        assert index.get("explicit") is True, f"index {index['name']} must be explicit"


# ── the audio-separator marker, which is a workaround for a resolver limit ────────────────────────


def test_audiosep_needs_no_platform_marker_at_all(config: dict[str, Any]) -> None:
    """THE MARKERS ARE GONE, and the torch pin is why.

    This test asserted the opposite until the zoo was pinned back: two atomic entries, the De Morgan
    expansion of an `or` exclusion uv 0.9.2 could not intersect with a transitive torch requirement, all of
    it working around ONE fact — audio-separator 0.46.0+ requires torch>=2.13 on arm64 mac while this
    project pins torch 2.8.0, so the zoo did not exist on Apple Silicon. 0.45.0 requires only torch>=2.3 and
    carries the IDENTICAL catalogue (same 89 download entries, same 84 roformers). Asserted as "no marker"
    rather than deleted, so that re-adding one is a decision."""
    specs = extras(config)["audiosep"]
    audio_separator = [s for s in specs if s.startswith("audio-separator")]
    assert len(audio_separator) == 1, f"one unconditional entry, not a per-platform split: {specs}"
    assert ";" not in audio_separator[0], (
        f"a platform marker is back on {audio_separator[0]!r}. That makes the zoo unavailable on the "
        "excluded platform — which is the state this pin exists to escape."
    )
    assert "==0.45.0" in audio_separator[0], (
        "the pin IS the fix: 0.46.0+ requires torch>=2.13 on arm64 mac against this project's 2.8.0"
    )


def test_audiosep_declares_the_dependency_its_own_metadata_omits(config: dict[str, Any]) -> None:
    """`audio_separator/separator/uvr_lib_v5/spec_utils.py` does a bare `import audioread`, and 0.45.0's
    metadata does not list it — so `from audio_separator.separator import Separator` raises
    ModuleNotFoundError on a clean install. Declared here so it fails at resolve time rather than on the
    first zoo job, hours later, on someone else's machine."""
    assert any(s.startswith("audioread") for s in extras(config)["audiosep"])


def test_audiosep_is_not_folded_into_the_ml_extra(config: dict[str, Any]) -> None:
    """Kept separate even though 0.45.0 no longer constrains torch, because that is a property of the
    current pin rather than of the package: 0.46.0 did constrain it, and inside `ml` such a pin would be
    able to move the torch version the ALIGNMENT stack runs on. An optional engine must not dictate the
    version the mandatory path uses."""
    assert not any("audio-separator" in spec for spec in extras(config)["ml"])


def test_the_mlx_backend_is_gated_to_apple_silicon(config: dict[str, Any]) -> None:
    """mlx builds only on Apple Silicon. The marker is what makes `--extra mlx` on a Linux box install
    nothing instead of failing the sync."""
    specs = extras(config)["mlx"]
    assert specs and all(
        "sys_platform == 'darwin'" in spec and "platform_machine == 'arm64'" in spec for spec in specs
    ), specs


# ── the property the whole test strategy rests on ────────────────────────────────────────────────


def test_no_heavy_dependency_is_in_the_base_set(config: dict[str, Any]) -> None:
    """The fast suite must be runnable with NO ML installed — that is why every seam is a Protocol. If
    torch reached the base dependencies, `uv sync` would pull multi-GB wheels for a contributor touching
    the policy module, and the "runs without models" property would be lost silently rather than loudly.
    """
    heavy = ("torch", "whisperx", "demucs", "pyannote", "scipy", "audio-separator")
    offenders = [
        spec
        for spec in config["project"]["dependencies"]
        if any(spec.lower().startswith(name) for name in heavy)
    ]
    assert not offenders, f"these belong in an extra, not the base set: {offenders}"


def test_the_dev_group_needs_no_ml(config: dict[str, Any]) -> None:
    """`uv sync --only-group dev` is the gate-only install. It must stay that."""
    dev = config["dependency-groups"]["dev"]
    assert not any("torch" in spec or "whisperx" in spec for spec in dev), dev


def test_mypy_checks_the_tests_tree(config: dict[str, Any]) -> None:
    """Gated from day one deliberately. The TypeScript half of this repo left its test tree checked by
    nothing, accumulated 284 errors, and had four genuine ones hiding among them. Gating an empty tree is
    nearly free; gating a full one is a project."""
    assert "tests" in config["tool"]["mypy"]["files"]
    assert config["tool"]["mypy"]["strict"] is True


# ── the markers, which carry the fast/slow split ─────────────────────────────────────────────────


def test_marker_typos_are_errors_rather_than_warnings(config: dict[str, Any]) -> None:
    """Without `--strict-markers` a marker mistyped as `mls` is a warning, so `-m 'not ml'` runs a test
    that needs half a gigabyte of checkpoints. On a box with no models that surfaces as a broken test
    rather than a broken marker, which is the expensive kind of wrong.

    Written as prose rather than as a literal decorator on purpose: the scan below reads these files as
    text, and an example typo spelled out in full would BE an undeclared marker to it. That is the whole
    weakness of a text-shaped assertion in one line — it convicted this docstring the first time it ran.
    """
    assert "--strict-markers" in config["tool"]["pytest"]["ini_options"]["addopts"]


def test_every_marker_a_test_uses_is_declared(config: dict[str, Any]) -> None:
    """Belt and braces with `--strict-markers`: this one names the offender and the file, where pytest's
    own error names only the marker."""
    declared = {entry.split(":", 1)[0] for entry in config["tool"]["pytest"]["ini_options"]["markers"]}
    builtin = {"parametrize", "skip", "skipif", "xfail", "usefixtures", "filterwarnings", "timeout"}
    used: dict[str, str] = {}
    for path in Path(__file__).parent.glob("test_*.py"):
        for line in path.read_text().splitlines():
            if "pytest.mark." in line:
                after = line.split("pytest.mark.", 1)[1]
                name = ""
                for char in after:
                    if char.isalnum() or char == "_":
                        name += char
                    else:
                        break
                if name:
                    used.setdefault(name, path.name)
    unknown = {name: where for name, where in used.items() if name not in declared | builtin}
    assert not unknown, f"undeclared markers: {unknown}"


def test_asyncio_mode_is_auto(config: dict[str, Any]) -> None:
    """Without it every async test is collected, never awaited, and reported as PASSING. This suite is
    mostly async, so the failure mode is a green run that tested nothing."""
    assert config["tool"]["pytest"]["ini_options"]["asyncio_mode"] == "auto"


def test_there_is_a_timeout(config: dict[str, Any]) -> None:
    """A wedged test should fail alone rather than hang the run and erase everything else's signal."""
    assert config["tool"]["pytest"]["ini_options"]["timeout"] > 0


# ── shipped package data (review L3's Moby tier) ──────────────────────────────────────────────────

MOBY = Path(__file__).parent.parent / "encore_worker" / "domain" / "lyrics" / "data" / "mhyph.xz"


def test_the_moby_data_is_declared_in_the_wheel(config: dict[str, Any]) -> None:
    """Its ABSENCE is a silent degradation rather than an ImportError: `syllabify._moby` returns an empty
    table and the ladder falls back to pyphen, which abstains on 44.8% of multi-syllable tokens. hatchling
    already includes it, so this pattern adds no file — it is here so a future `exclude`/`only-include`
    cannot drop it without having to edit this line too."""
    wheel = config["tool"]["hatch"]["build"]["targets"]["wheel"]
    assert "encore_worker/domain/lyrics/data/*.xz" in wheel["include"]
    assert wheel["packages"] == ["encore_worker"], (
        "the pattern supplements `packages`, it does not replace it"
    )


def test_the_moby_data_loads_through_importlib_resources() -> None:
    """Read the way the shipped code reads it, not off a relative path: an installed wheel has no source
    tree, and `importlib.resources` is the one access that works in both."""
    import importlib.resources

    from encore_worker.domain.lyrics import syllabify

    assert MOBY.is_file(), "the data file must be in the package directory, not beside it"
    raw = (importlib.resources.files("encore_worker.domain.lyrics") / "data" / "mhyph.xz").read_bytes()
    assert raw[:6] == b"\xfd7zXZ\x00", "LZMA/xz container, as the docstring says"
    assert len(syllabify._moby()) == 152085


def test_the_moby_data_stays_compact() -> None:
    """2.6 MB of latin-1 with U+00A5 separators became 456 KB by keeping only the lowercase-letter entries
    with at least one break, then LZMA'ing one `word-with-hyphens` per line. A file that grew far past
    this is a different artefact and its derivation (in `syllabify`'s docstring) needs re-reading."""
    assert MOBY.stat().st_size < 600_000
