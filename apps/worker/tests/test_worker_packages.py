"""Guards on the worker's package structure.

These exist because S0 of docs/archive/specs/SPEC-worker-pipeline.md introduced packages, and packaging has two
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
#: docs/archive/specs/SPEC-worker-pipeline.md §3. Listed separately from the domains because the layering guard
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


def test_the_separation_audio_policy_does_not_claim_the_vocals_stem_is_unplayed():
    """Issue #85. The separation domain's audio policy is the rule that stops a reader re-encoding a stem
    badly, and its load-bearing clauses were false in the direction that RELAXES the rule.

    Two false facts had to go, at three sites: (1) "nothing plays [the vocals stem]" — the vocals stem is
    the guiding track, a second <audio> the TV mixes under the instrumental at up to full gain and pitch-
    shifts with the key (apps/core/src/lib/tv/TvPlayer.svelte); (2) STEM_BITRATE is the storage format "for
    both stems" — it governs the vocals stem only (encode_stem_argv); the instrumental is FLAC through
    encode_flac_argv. There is no behaviour to test, so this pins the prose instead: the false clauses stay
    gone and the true reason (the guiding track) stays named."""
    src = Path(__file__).resolve().parents[1] / "src"

    # (1) The "nothing plays it" clause is false and must not reappear at any of its three former sites.
    init_doc = importlib.import_module("src.separation").__doc__ or ""
    separate_src = (src / "steps" / "separate.py").read_text(encoding="utf-8")
    for name, text in (("separation/__init__.py", init_doc), ("steps/separate.py", separate_src)):
        assert "nothing plays" not in text, (
            f"{name} still claims the vocals stem is unplayed — it is the guiding track (issue #85)"
        )
    # The true reason must be stated where the policy lives, not merely absent.
    assert "GUIDING TRACK" in init_doc, "separation/__init__.py must name the guiding track as the reason (#85)"
    assert "GUIDING TRACK" in separate_src, "steps/separate.py must name the guiding track as the reason (#85)"

    # (2) STEM_BITRATE must not be described as governing BOTH stems; it is the vocals stem only.
    demucs_src = (src / "separation" / "demucs.py").read_text(encoding="utf-8")
    assert "for both stems" not in demucs_src, (
        "demucs.py STEM_BITRATE still claims it governs both stems — it governs the vocals stem only, the "
        "instrumental is FLAC via encode_flac_argv (issue #85)"
    )
