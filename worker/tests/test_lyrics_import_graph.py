"""The lyrics package's internal imports must stay a DAG.

`grading.py` and `sources.py` used to import each other: `sources.py` needed `LyricsRequest`/`LyricsText`
to declare what a source consumes and returns, and `grading.py` needed the source classes to run them. The
cycle was made to work by importing `.sources` from the FOOT of grading.py — after the two dataclasses were
defined — carrying `# noqa: E402` to silence the lint that exists to catch exactly that.

It ran correctly and cost real things: neither module could be read or imported independently, and
`validate.py` had to hide its own `from .grading import lyrics_tokens` inside a function body to stay out of
the tangle. Moving the shared vocabulary into `model.py` — which depends on nothing in the package — left
the cycle no edge to close.

A guard rather than a comment, because a comment saying "do not reintroduce the cycle" cannot fail a
build. This scans real imports with the AST, so prose about cycles does not trip it.
"""

from __future__ import annotations

import ast
from pathlib import Path

LYRICS = Path(__file__).resolve().parents[1] / "src" / "lyrics"


def _graph() -> dict[str, set[str]]:
    """module stem -> the sibling stems it imports, at ANY nesting depth.

    `ast.walk` rather than `tree.body` on purpose: an import buried in a function body is still an edge,
    and hiding one there is precisely how the old cycle was tolerated.
    """
    graph: dict[str, set[str]] = {}
    for path in sorted(LYRICS.glob("*.py")):
        if path.name == "__init__.py":
            continue  # the package surface imports everything by design; it is not part of the ordering
        tree = ast.parse(path.read_text(encoding="utf-8"))
        graph[path.stem] = {
            node.module
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.level == 1 and node.module
        }
    return graph


def _cycles(graph: dict[str, set[str]]) -> list[list[str]]:
    found: list[list[str]] = []

    def walk(node: str, path: list[str]) -> None:
        for nxt in sorted(graph.get(node, ())):
            if nxt in path:
                found.append(path[path.index(nxt) :] + [nxt])
                continue
            walk(nxt, path + [nxt])

    for node in graph:
        walk(node, [node])
    return found


def test_the_lyrics_package_has_no_import_cycle():
    graph = _graph()
    assert graph, "found no lyrics modules — this guard has stopped guarding"
    cycles = _cycles(graph)
    assert not cycles, "lyrics modules import each other in a cycle: " + "; ".join(
        " -> ".join(c) for c in cycles
    )


def test_model_is_the_dependency_free_base():
    """Everything can import `model`; `model` can import nothing here. That is what dissolved the cycle."""
    assert _graph()["model"] == set(), (
        "lyrics/model.py has taken a dependency on a sibling — it is the base every other module imports, "
        "so an edge out of it can close a cycle again"
    )


def test_neither_chain_nor_sources_imports_the_other_way():
    """The specific edge that was the cycle: sources.py must not reach back into grading.py."""
    graph = _graph()
    assert "grading" not in graph["sources"], (
        "sources.py imports grading.py again — the shared types belong in model.py, which both can import"
    )
    assert "sources" in graph["grading"], "grading.py should still drive the sources (one-way is the point)"


def test_no_sibling_import_hides_inside_a_function_body():
    """A deferred import is how the old cycle was tolerated, so a new one is worth a second look.

    Not a blanket ban: a LAZY import is legitimate for keeping a heavy dependency out of a process that
    does not need it. That is why the allowance is named per module rather than left open — `asr.py` may
    defer whisperx, and nothing in this package currently needs to defer a SIBLING.
    """
    offenders: list[str] = []
    for path in sorted(LYRICS.glob("*.py")):
        if path.name == "__init__.py":
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        top = {id(node) for node in tree.body}
        for node in ast.walk(tree):
            if not (isinstance(node, ast.ImportFrom) and node.level == 1 and node.module):
                continue
            if id(node) not in top:
                offenders.append(f"{path.name}:{node.lineno} defers `from .{node.module} import ...`")
    assert not offenders, (
        "a sibling import is hidden inside a function body; if it is dodging a cycle, move the shared "
        "names to model.py instead: " + "; ".join(offenders)
    )


def test_the_re_exports_chain_promises_still_resolve():
    """Moving definitions must not move where importers find them.

    Nine test modules and three source modules do `from .grading import LyricsText`, and the vocabulary
    constants have importers all over the suite. The names moved to `model.py`; `grading.py` re-exports every
    one, so this asserts the compatibility surface rather than trusting the comment that claims it.
    """
    from src.lyrics import grading

    for name in (
        "LyricsRequest",
        "LyricsText",
        "lyrics_tokens",
        "SOURCE_ASR",
        "SOURCE_CAPTIONS",
        "SOURCE_LRCLIB",
        "SOURCE_MANUAL",
        "TIMING_WORD",
        "TIMING_LINE",
        "TIMING_NONE",
        "ROLE_BASELINE",
        "ROLE_CANDIDATE",
        "ROLE_UNSPECIFIED",
        "AsrSource",
        "AutoCaptionsSource",
        "CaptionsSource",
        "LrclibSource",
        "LyricsSource",
        "_source_name",
        "_CaptionsSource",
    ):
        assert hasattr(grading, name), f"`from .grading import {name}` no longer resolves"
