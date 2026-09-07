"""Guard: every runtime print in dial_home.py flushes, and the connect/disconnect pair especially (#473).

THE DEFECT. dial_home.py's two connection-lifecycle prints -- the "connected to ..." announcement and
the "disconnected (...); reconnecting in Ns" line -- were the ONLY two of the worker's runtime prints
missing flush=True, and they bracket a sleep: a flapping worker prints "disconnected ... reconnecting"
and then asyncio.sleep()s, so nothing pushes the stdout buffer and an operator watching a native run
(no PYTHONUNBUFFERED, which the README documents as supported) sees a HUNG worker, not a flapping one.

THE FIX. flush=True on both. This guard walks the AST of dial_home.py and asserts that EVERY print()
call reachable in the module (i.e. not inside docgen, which is a different file) passes flush=True as a
keyword. That is stricter than the two lines the issue names, so it also stops a future runtime print
from regressing the same way. It is an AST scan, not a regex, so a print spanning several physical lines
(the connect print does) is judged by its actual keywords, not by which line the keyword lands on.

WHY AST, NO HARNESS. A print's buffering behaviour is not observable from a unit test without a
subprocess and a non-TTY pipe; the property under test -- that the flush keyword is present on the call
-- is a property of the source, decidable by parsing it.
"""

from __future__ import annotations

import ast
from pathlib import Path

DIAL_HOME = Path(__file__).resolve().parents[1] / "src" / "dial_home.py"


def _print_calls(tree: ast.AST) -> list[ast.Call]:
    calls: list[ast.Call] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "print":
            calls.append(node)
    return calls


def _has_flush_true(call: ast.Call) -> bool:
    for kw in call.keywords:
        if kw.arg == "flush":
            v = kw.value
            return isinstance(v, ast.Constant) and v.value is True
    return False


def test_every_print_in_dial_home_flushes() -> None:
    tree = ast.parse(DIAL_HOME.read_text())
    calls = _print_calls(tree)
    # Sanity: dial_home has many runtime prints; if this drops to a handful the anchor is wrong.
    assert len(calls) >= 15, f"expected the worker's ~20 prints, found {len(calls)}"
    offenders = [c.lineno for c in calls if not _has_flush_true(c)]
    assert not offenders, (
        f"print() without flush=True at dial_home.py lines {offenders} -- a buffered runtime print is "
        f"lost when the worker then sleeps or crashes (#473)"
    )


def test_the_connect_and_disconnect_prints_specifically_flush() -> None:
    """The two lines the issue names, pinned by their content so a rename cannot silently un-pin them."""
    tree = ast.parse(DIAL_HOME.read_text())
    calls = _print_calls(tree)

    def _text_of(call: ast.Call) -> str:
        # Concatenate every constant/JoinedStr piece of the first positional arg into one searchable str.
        if not call.args:
            return ""
        arg = call.args[0]
        parts: list[str] = []
        for node in ast.walk(arg):
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                parts.append(node.value)
        return " ".join(parts)

    connect = [c for c in calls if "connected to" in _text_of(c)]
    disconnect = [c for c in calls if "reconnecting in" in _text_of(c)]
    assert len(connect) == 1, f"expected exactly one 'connected to' print, found {len(connect)}"
    assert len(disconnect) == 1, f"expected exactly one reconnect print, found {len(disconnect)}"
    assert _has_flush_true(connect[0]), "the 'connected to' print must flush (#473)"
    assert _has_flush_true(disconnect[0]), "the 'reconnecting in Ns' print must flush (#473)"
