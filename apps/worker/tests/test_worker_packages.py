"""Guards on the worker's package structure.

These exist because S0 of docs/specs/SPEC-worker-pipeline.md introduced packages, and packaging has two
failure modes that are silent until something far away breaks. Both were hit while doing the move, which
is why they are pinned rather than remembered.

They are the first of the spec's enforcement tests (§7). The rest arrive with the runtime.
"""
from __future__ import annotations

import importlib
import pkgutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

#: The domain packages. Each owns one concern and is named for it.
DOMAIN_PACKAGES = ["acquisition", "analysis", "lyrics", "metadata", "separation"]

#: The runtime layers. These execute a plan and know nothing about audio, lyrics or separation — see
#: docs/specs/SPEC-worker-pipeline.md §3. Listed separately from the domains because the layering guard
#: treats them differently: a domain may not import these, and these may not import a domain.
RUNTIME_PACKAGES = ["runtime", "steps"]

ALL_PACKAGES = DOMAIN_PACKAGES + RUNTIME_PACKAGES

#: Modules that USED to live flat in src/ and were moved into a package. Importing one of these again
#: means either a stale copy survived the move or someone re-created it beside its package.
MOVED_AWAY = [
    "annotate",
    "whisperx",
    "captions",
    "demucs",
    "fetch",
    "key_detect",
    "lyrics_chain",
    "lyrics_presplit",
    "lyrics_source",
    "lyrics_validate",
    "roformer",
    "song_profile",
    "stream_quality",
    "vocal_range",
]


def test_no_module_is_importable_by_its_OLD_flat_path():
    """S0's own guarantee. A mis-merged `git mv` plus a re-export can leave one module importable under
    two names, and then two copies of the same class exist and `isinstance` starts failing in ways that
    look like anything except a packaging mistake."""
    for name in MOVED_AWAY:
        assert not (Path(__file__).resolve().parents[1] / "src" / f"{name}.py").exists(), (
            f"src/{name}.py still exists — it was supposed to move into a package"
        )


def test_no_package_reexport_SHADOWS_one_of_its_own_submodules():
    """The trap that actually bit during S0.

    `metadata/__init__.py` re-exported the function `annotate` from the submodule `annotate`. The name
    bound in the package namespace is then the FUNCTION, so `from src.metadata import annotate as ann`
    gives you something whose `.parse_recordings` raises AttributeError on a plain function object — an
    error that says nothing about the real cause. Any package with a submodule and a same-named member is
    a landmine, so the rule is enforced rather than reviewed.
    """
    for pkg_name in ALL_PACKAGES:
        pkg = importlib.import_module(f"src.{pkg_name}")
        submodules = {m.name for m in pkgutil.iter_modules(pkg.__path__)}
        exported = set(getattr(pkg, "__all__", []))
        clash = submodules & exported
        assert not clash, (
            f"src/{pkg_name}/__init__.py re-exports {sorted(clash)}, which shadows the submodule(s) of "
            f"the same name. Reach those at their full path instead."
        )


def test_every_domain_package_explains_what_belongs_in_it():
    """A package boundary that is not written down is a boundary the next person guesses at. Each one
    states what it owns AND what it deliberately does not."""
    for pkg_name in ALL_PACKAGES:
        pkg = importlib.import_module(f"src.{pkg_name}")
        doc = (pkg.__doc__ or "").strip()
        assert len(doc) > 200, f"src/{pkg_name}/__init__.py needs a docstring saying what belongs in it"


def test_the_domain_packages_are_exactly_the_ones_declared():
    """Catches a package added without a decision — the point of the layering in the spec is that a new
    domain is a deliberate act, not something that appears because a file needed somewhere to go."""
    src = Path(__file__).resolve().parents[1] / "src"
    found = sorted(
        p.name for p in src.iterdir() if p.is_dir() and (p / "__init__.py").exists() and not p.name.startswith("_")
    )
    assert found == sorted(ALL_PACKAGES), (
        f"packages on disk {found} != declared {sorted(ALL_PACKAGES)}. Add it to DOMAIN_PACKAGES or\n"
        f"RUNTIME_PACKAGES (and give it a docstring) if the new package is intended."
    )
