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
ALLOWED: dict[str, frozenset[str]] = {
    "protocol": frozenset(),
    "host": frozenset(),
    "domain": frozenset({"domain", "host", "protocol"}),
    "adapters": frozenset({"adapters", "domain", "host", "protocol"}),
    "steps": frozenset({"steps", "adapters", "domain", "host", "protocol"}),
    "workflows": frozenset({"workflows", "steps", "domain", "protocol"}),
    "transport": frozenset({"transport", "workflows", "protocol", "host"}),
}

#: Packages that must never be reachable from `domain/`. Each is why the suite can run without ML:
#: `domain` is pure functions over data, so a decision there is testable with no model and no event loop.
BANNED_IN_DOMAIN = frozenset({"dbos", "asyncio", "torch", "torchaudio", "whisperx", "pyannote", "demucs"})


def _modules() -> Iterator[tuple[Path, str, ast.Module]]:
    """Every source file, its layer, and its parsed tree."""
    for path in sorted(PKG.rglob("*.py")):
        rel = path.relative_to(PKG)
        # `__main__.py` sits above the layers: it is the composition root and may import anything.
        if rel.parts[0] == "__main__.py" or rel.name == "__init__.py" and len(rel.parts) == 1:
            continue
        yield path, rel.parts[0], ast.parse(path.read_text(), filename=str(path))


def _imported_roots(tree: ast.Module) -> set[str]:
    """Top-level module names this file imports, for both absolute and intra-package relative forms."""
    roots: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level and node.module:
                # `from ..domain.lyrics import x` -> "domain"
                roots.add(node.module.split(".")[0])
            elif node.level:
                # `from .. import domain` -> each imported name is the sibling layer
                roots.update(alias.name for alias in node.names)
            elif node.module:
                roots.add(node.module.split(".")[0])
    return roots


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
