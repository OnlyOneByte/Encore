"""The align step is six modules plus the step itself (W10): what that split has to keep true.

The split was a pure move — `_tools/ast_identity.py` proves the bodies — but two properties are not
statements about bodies and nothing else checks them: a monkeypatch only reaches code that reads the name
out of the patched module's own globals, and a sibling that imported the step back would be a cycle.
Design: docs/arch/05-worker.md §1.1.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

#: The step's modules, as the split named them. A seventh file here is fine; a missing one is the split
#: being quietly undone, which is what the count in each assertion is for.
SIBLINGS = (
    "align_claims",
    "align_geometry",
    "align_lines",
    "align_notes",
    "align_text",
    "align_unsung",
)

STEPS = Path(__file__).resolve().parent.parent / "encore_worker" / "steps"
TESTS = Path(__file__).resolve().parent


def _step_modules() -> dict[str, str]:
    return {path.stem: path.read_text(encoding="utf-8") for path in sorted(STEPS.glob("align_*.py"))}


def test_the_step_is_the_declared_set_of_modules() -> None:
    got = _step_modules()
    assert set(got) == {"align_steps", *SIBLINGS}, (
        "the align step's module set has drifted from the one this module and docs/arch/05-worker.md §1.1 "
        f"name: {sorted(got)}"
    )
    assert len(got["align_steps"].splitlines()) < 2600, (
        "align_steps.py is growing back towards the 3 696 lines W10 split: the module-level helpers belong "
        "in a sibling (docs/arch/05-worker.md §1.1)"
    )


def test_no_sibling_imports_the_step_back() -> None:
    """A sibling importing `align_steps` would be a cycle, and the step imports every one of them."""
    offenders = [
        name for name, source in _step_modules().items() if name != "align_steps" and "align_steps" in source
    ]
    assert not offenders, f"these modules of the step import or name the step itself: {offenders}"


def _patched_on_the_step() -> set[str]:
    """Every name a test here rebinds on the step (`monkeypatch.setattr(align_steps, "x", …)`)."""
    found: set[str] = set()
    for path in sorted(TESTS.glob("test_*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.Call):
                continue
            callee = node.func
            if not (isinstance(callee, ast.Attribute) and callee.attr == "setattr"):
                continue
            if len(node.args) < 2:
                continue
            target, name = node.args[0], node.args[1]
            on_step = isinstance(target, ast.Name) and "align_steps" in target.id
            on_step = on_step or (isinstance(target, ast.Name) and target.id == "steps_module")
            if on_step and isinstance(name, ast.Constant) and isinstance(name.value, str):
                found.add(name.value)
    return found


def test_every_name_a_test_patches_on_the_step_is_read_by_the_step_alone() -> None:
    """The one way the split could silently break a test: a name that moved to a sibling, is PATCHED on
    `align_steps` — which the step's own code reads, so the patch takes — and is ALSO read inside the
    sibling, where the module global is the real one and the spy is never called.
    """
    patched = _patched_on_the_step()
    assert patched >= {"_NEVER_SUNG_RATE", "_clamped", "_skipped_lines"}, (
        f"the scan found only {sorted(patched)}; the three the ladder's tests patch are the floor"
    )
    modules = _step_modules()
    step = modules.pop("align_steps")
    read_in = {
        where: {
            node.id
            for node in ast.walk(ast.parse(source))
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
        }
        for where, source in modules.items()
    }
    for name in sorted(patched):
        assert name in step, f"{name} is patched on the step but the step's own source never reads it"
        elsewhere = sorted(where for where, names in read_in.items() if name in names)
        assert not elsewhere, (
            f"{name} is patched on align_steps but also READ in {elsewhere}, where the patch cannot reach "
            "it — move the reader into the step, or patch the module that owns the name"
        )


@pytest.mark.parametrize("name", SIBLINGS)
def test_every_sibling_carries_a_module_docstring_that_points_somewhere(name: str) -> None:
    """A moved helper's design pointer is the only thing that survives the move, so the module has to carry
    one (hard rule 1: prose lives in `docs/`, and the code points at it by path)."""
    doc = ast.get_docstring(ast.parse(_step_modules()[name]))
    assert doc is not None, f"{name} has no module docstring"
    assert "docs/" in doc, f"{name}'s docstring cites no document"
