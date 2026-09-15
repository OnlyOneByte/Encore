"""`dial_home.py` carried six unrelated jobs; three of them now live elsewhere.

It was 884 lines doing the WS protocol loop, orphaned-scratch reclaim, retry classification,
oversubscription warnings, processor construction and the entrypoint. The protocol loop and the wiring in
particular change for completely different reasons — one when the core's message shape moves, the other
when a step, engine or capability is added — so a reader of either had to scroll past the other.

These guards pin the split itself. They are cheap and they guard the kind of thing that silently rots: the
easiest way to "fix" a future import problem is to paste a helper back into dial_home.
"""

from __future__ import annotations

import ast
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"


def _defs(module: str) -> set[str]:
    tree = ast.parse((SRC / module).read_text(encoding="utf-8"))
    return {
        node.name
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
    }


def test_the_reaper_and_the_composition_root_are_not_defined_in_dial_home() -> None:
    """They may be IMPORTED there (the entrypoint uses them); they must not be defined there."""
    here = _defs("dial_home.py")
    for moved in ("sweep_orphaned_scratch", "_newest_mtime", "_scratch_sweep_loop"):
        assert moved not in here, f"{moved} is defined in dial_home.py again — it belongs to scratch_reaper"
    for moved in ("_build_processor", "oversubscription_warnings"):
        assert moved not in here, f"{moved} is defined in dial_home.py again — it belongs to bootstrap"


def test_each_module_owns_its_own_job() -> None:
    assert {"sweep_orphaned_scratch", "_newest_mtime", "_scratch_sweep_loop"} <= _defs("scratch_reaper.py")
    assert {"_build_processor", "oversubscription_warnings"} <= _defs("bootstrap.py")
    assert "WorkerClient" in _defs("dial_home.py"), "the protocol loop is what dial_home is FOR"


def test_the_reaper_knows_nothing_about_the_protocol() -> None:
    """The point of the extraction: reclaiming disk has no business with the socket.

    Stated as a test because it is the property that makes the file readable on its own, and an import
    added for convenience would take it away without any other symptom.
    """
    tree = ast.parse((SRC / "scratch_reaper.py").read_text(encoding="utf-8"))
    imported = {
        node.module
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.level == 1 and node.module
    }
    for forbidden in ("protocol", "processor", "dial_home", "config"):
        assert forbidden not in imported, (
            f"scratch_reaper imports `{forbidden}` — it reclaims directories and should need none of the "
            f"protocol, the processor seam, the client, or the config to do it"
        )


def test_dial_home_still_exposes_what_its_callers_import() -> None:
    """The names moved; where importers find them did not."""
    import src.dial_home as dh

    for name in ("WorkerClient", "CONFIG", "_is_retryable", "_build_processor", "sweep_orphaned_scratch"):
        assert hasattr(dh, name), f"`from .dial_home import {name}` no longer resolves"


def test_dial_home_is_no_longer_a_god_file() -> None:
    """A number, so the split cannot quietly undo itself one paste at a time.

    884 lines before. The bound is generous rather than tight — this guards against regrowth, not against
    a few lines of honest change.
    """
    n = len((SRC / "dial_home.py").read_text(encoding="utf-8").splitlines())
    assert n < 700, f"dial_home.py is back up to {n} lines — something was pasted back in"
