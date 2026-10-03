"""The dependency rule, enforced rather than described.

`README.md` claims dependencies point down only and that `domain/` is importable with no ML installed.
Both are claims a reader follows to decide where code goes, so both are asserted here. The old worker
learned this the hard way: a module docstring stating "both separation and alignment call it" was false
for three of four callers, and nothing noticed.

Deliberately AST-based rather than import-based: importing `adapters/` would require torch, and the
whole point is that this suite runs without it (`uv sync --only-group dev`).
"""

from __future__ import annotations

import ast
from collections.abc import Iterator
from pathlib import Path

PKG = Path(__file__).resolve().parent.parent / "encore_worker"

#: Layer -> the sibling layers it may import. A layer absent from a value set is a violation.
#: `protocol` is importable by anything: it is inert wire shapes with zero dependencies.
#: Every layer may import ITSELF — a package split across files is still one layer. `protocol` and
#: `host` were originally given empty sets, which made an ordinary sibling import inside them a
#: violation; the check only surfaced it once it stopped being vacuous.
ALLOWED: dict[str, frozenset[str]] = {
    "protocol": frozenset({"protocol"}),
    "host": frozenset({"host"}),
    "domain": frozenset({"domain", "host", "protocol"}),
    # Where published bytes go. Peer of `adapters` rather than under it: both are outbound seams, and this
    # one is deliberately unable to reach `domain` or `adapters` — a store must not learn what a lyric is,
    # and a key must be derivable from an id alone. `keys` is pure; only `local` touches a filesystem.
    "artifacts": frozenset({"artifacts", "host", "protocol"}),
    "adapters": frozenset({"adapters", "domain", "host", "protocol"}),
    "steps": frozenset({"steps", "artifacts", "adapters", "domain", "host", "protocol"}),
    "workflows": frozenset({"workflows", "steps", "domain", "protocol"}),
    "transport": frozenset({"transport", "workflows", "protocol", "host"}),
}

#: Packages that must never be reachable from `domain/`. Each is why the suite can run without ML:
#: `domain` is pure functions over data, so a decision there is testable with no model and no event loop.
#: Numpy is NOT here and is used in `domain/` by design — see `docs/arch/04-alignment.md` XA-15 and §15.
BANNED_IN_DOMAIN = frozenset({"dbos", "asyncio", "torch", "torchaudio", "whisperx", "pyannote", "demucs"})

#: The only `domain/` modules that may import `random`, each with the DATA its seed comes from. A domain call
#: is reached from a DBOS workflow body, which is replayed on recovery, so a seed off a clock or off
#: `random`'s global state would answer differently the second time and the attempt would load two bundles.
#: XA-15 used to be written as "no random", which three shipped modules contradicted while the guard checked
#: none of it (W7b review r2-tests-9); an allowlist states the real rule and can only shrink.
SEEDED_FROM_DATA = {
    "lyrics/lexical.py": "crc32 of the text being scored, so a shuffle control repeats on a replay",
}

#: The only `domain/` modules that may touch the filesystem, and what they read. Both are read-only and
#: neither depends on the job: a packaged data table and the worker's own wav reader.
PACKAGED_DATA_READERS = {
    "lyrics/syllabify.py": "its packaged `mhyph` hyphenation table, via importlib.resources",
    "audio/wav.py": "a wav the step layer resolved, via the stdlib `wave` module",
}

#: What "touches the filesystem" means for the check above: the stdlib doors into one.
FILESYSTEM_IMPORTS = frozenset({"importlib.resources", "pathlib", "wave", "os", "shutil", "tempfile", "glob"})


def _modules() -> Iterator[tuple[Path, str, ast.Module]]:
    """Every source file, its layer, and its parsed tree."""
    for path in sorted(PKG.rglob("*.py")):
        rel = path.relative_to(PKG)
        # `__main__.py` sits above the layers: it is the composition root and may import anything.
        if rel.parts[0] == "__main__.py" or rel.name == "__init__.py" and len(rel.parts) == 1:
            continue
        yield path, rel.parts[0], ast.parse(path.read_text(), filename=str(path))


PKG_NAME = "encore_worker"


def _layer_of(dotted: str) -> str:
    """The LAYER a module path names, stripping this package's own prefix first.

    THE BUG THIS EXISTS TO PREVENT, found by this test failing to catch a real violation: taking
    `dotted.split(".")[0]` on `encore_worker.workflows.fetch` yields `"encore_worker"`, which matches no
    layer, so every absolute intra-package import was invisible. Since this codebase imports absolutely
    throughout, the check was VACUOUS — passing because it examined nothing, which is exactly what a
    working check and a broken one both look like from the outside.
    """
    parts = dotted.split(".")
    if parts and parts[0] == PKG_NAME:
        parts = parts[1:]
    return parts[0] if parts else ""


def _imported_roots(tree: ast.Module) -> set[str]:
    """Every layer this file imports, across all three import spellings."""
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(_layer_of(alias.name) for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level and node.module:
                roots.add(_layer_of(node.module))  # `from ..domain.lyrics import x`
            elif node.level:
                roots.update(alias.name for alias in node.names)  # `from .. import domain`
            elif node.module:
                roots.add(_layer_of(node.module))  # `from encore_worker.domain import x`
    return roots


def test_the_import_scan_actually_sees_absolute_imports() -> None:
    """The non-vacuity floor, and it is not hypothetical.

    This module's first version read the root off `dotted.split(".")[0]`, which is `"encore_worker"` for
    every absolute import in the package — so the two checks below examined nothing and passed. A guard
    that inspects an empty set is indistinguishable from a guard that found no violations.
    """
    tree = ast.parse("from encore_worker.workflows.fetch import Identified")
    assert _imported_roots(tree) == {"workflows"}, "an absolute intra-package import must be seen"

    assert _layer_of("encore_worker.domain.lyrics.policy") == "domain"
    assert _layer_of("domain.lyrics") == "domain"
    assert _layer_of("asyncio") == "asyncio"


def test_layers_only_import_downward() -> None:
    violations: list[str] = []
    for path, layer, tree in _modules():
        allowed = ALLOWED.get(layer)
        if allowed is None:
            continue  # a new top-level layer: covered by the completeness test below
        for root in _imported_roots(tree) & set(ALLOWED):
            if root not in allowed:
                violations.append(f"{path.name} (layer {layer!r}) imports {root!r}")
    assert not violations, "dependencies must point down only:\n  " + "\n  ".join(violations)


def test_domain_is_pure() -> None:
    """`domain/` must not reach DBOS, asyncio, or any model library."""
    violations: list[str] = []
    for path, layer, tree in _modules():
        if layer != "domain":
            continue
        for root in _imported_roots(tree) & BANNED_IN_DOMAIN:
            violations.append(f"{path.relative_to(PKG)} imports {root!r}")
    assert not violations, (
        "domain/ is pure functions over data, and the suite runs with no ML installed:\n  "
        + "\n  ".join(violations)
    )


def _imported_names(tree: ast.Module) -> set[str]:
    """Every module name this file imports, dotted and whole — `importlib.resources`, not `importlib`."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            names.add(node.module)
            names.update(f"{node.module}.{alias.name}" for alias in node.names)
    return names


def _domain_modules() -> Iterator[tuple[str, ast.Module]]:
    """`(path under domain/, tree)` for every domain module, which is how the allowlists are keyed."""
    for path, layer, tree in _modules():
        if layer == "domain":
            yield str(path.relative_to(PKG / "domain")), tree


def test_randomness_in_domain_is_seeded_from_the_data() -> None:
    """XA-15's randomness clause, which used to be written as "no random" and enforced nowhere.

    A domain decision is replayed by DBOS, so the rule is not "no randomness" — `lexical`'s shuffle control
    needs it — but "no randomness this tree cannot reproduce". The allowlist names the seed's source.
    """
    users = {rel for rel, tree in _domain_modules() if {"random", "secrets"} & _imported_names(tree)}
    assert users <= set(SEEDED_FROM_DATA), (
        f"these domain modules draw randomness without declaring where the seed comes from: "
        f"{sorted(users - set(SEEDED_FROM_DATA))}. A DBOS replay must repeat the answer."
    )
    stale = sorted(set(SEEDED_FROM_DATA) - users)
    assert not stale, f"these entries no longer import random and must leave SEEDED_FROM_DATA: {stale}"


def test_the_filesystem_in_domain_is_packaged_read_only_data() -> None:
    """XA-15's filesystem clause. `domain/` may read what SHIPS with it, never what a job produced."""
    users = {rel for rel, tree in _domain_modules() if FILESYSTEM_IMPORTS & _imported_names(tree)}
    assert users <= set(PACKAGED_DATA_READERS), (
        f"these domain modules reach a filesystem without declaring what they read: "
        f"{sorted(users - set(PACKAGED_DATA_READERS))}. Take the bytes as an argument instead."
    )
    stale = sorted(set(PACKAGED_DATA_READERS) - users)
    assert not stale, f"these entries no longer read a file and must leave PACKAGED_DATA_READERS: {stale}"


def test_the_two_allowlists_are_not_vacuous() -> None:
    """Both rules above pass by finding nothing if `_imported_names` stops reading the import spellings.

    `_imported_roots`' own history is the reason this is here: it read `dotted.split(".")[0]` and so saw
    `"encore_worker"` for every absolute import in the package, which made two checks examine nothing.
    """
    tree = ast.parse("import random\nfrom importlib import resources\nfrom pathlib import Path\n")
    names = _imported_names(tree)
    assert "random" in names
    assert "importlib.resources" in names, "the dotted form a `from importlib import resources` means"
    assert FILESYSTEM_IMPORTS & names, "the filesystem check must see a stdlib door into one"
    assert SEEDED_FROM_DATA and PACKAGED_DATA_READERS, "an empty allowlist makes its rule unfalsifiable"


def test_every_layer_declares_its_allowance() -> None:
    """A new layer directory must be added to ALLOWED, or it would be silently unchecked.

    This is the non-vacuity floor: the two tests above iterate real files, so a layer missing from
    ALLOWED passes them by being skipped rather than by being correct.
    """
    on_disk = {p.name for p in PKG.iterdir() if p.is_dir() and not p.name.startswith("__")}
    assert on_disk == set(ALLOWED), (
        f"layers on disk {sorted(on_disk)} do not match ALLOWED {sorted(ALLOWED)} — "
        "add the new layer and declare what it may import"
    )
