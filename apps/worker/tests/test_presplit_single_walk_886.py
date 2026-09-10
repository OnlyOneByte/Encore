"""Guard: presplit's segment-classification-and-subdivide walk exists exactly ONCE (#886).

`presplit.py` used to implement the same per-segment passthrough/subdivide decision in TWO private
functions — `_relineate_segments` and `_relineate_with_opens` — kept equal only by a comment. That is
the "N places must change together, with nothing forcing the Nth" shape (N=2): a change to the rule in
one walk silently diverges the line-sync publish path from the aligner-window path, the exact class of
seam bug this file keeps producing (#217, #336, #410, #459).

A behaviour-preserving consolidation has no behavioural test that can red, so pin it STRUCTURALLY: read
the source, drop comments AND string literals (so the docstring that describes the walk cannot satisfy
or trip the check), and assert the passthrough-decision expression appears exactly once. On the base
tree the expression is at two sites and this reds; after delegating `_relineate_segments` to
`_relineate_with_opens` it is at one and this passes.
"""

import io
import sys
import tokenize
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

_PRESPLIT = Path(__file__).resolve().parents[1] / "src" / "lyrics" / "presplit.py"

# The load-bearing decision line — the exact per-segment passthrough guard both walks shared.
_NEEDLE = 'seg.get("words") or not isinstance(body, str) or not body.strip()'


def _code_only(source: str) -> str:
    """Return `source` with comments and DOCSTRINGS blanked IN PLACE, code spacing untouched.

    A docstring is a string that stands alone as a statement (module/class/function body). Those are
    the only strings that can carry prose describing the walk, so those — plus comments — are blanked
    to spaces; every other byte survives character-for-character. Inline string literals (e.g. the
    `"words"` inside the passthrough decision itself) are LEFT INTACT, so the needle matches literally.
    A docstring quoting `_NEEDLE` therefore cannot satisfy the count (a false pass) nor trip it.
    """
    lines = source.splitlines(keepends=True)
    offsets = [0]
    for ln in lines:
        offsets.append(offsets[-1] + len(ln))

    def pos(row: int, col: int) -> int:
        return offsets[row - 1] + col

    chars = list(source)

    def blank(tok: tokenize.TokenInfo) -> None:
        start, end = pos(*tok.start), pos(*tok.end)
        for i in range(start, end):
            if chars[i] != "\n":
                chars[i] = " "

    # A STRING token is a docstring when the only tokens before it on its logical line are the
    # structural ones that open a suite (NEWLINE/NL/INDENT/DEDENT/ENCODING). Track that with a flag
    # that resets on any real code token and is set again at a statement boundary.
    at_statement_start = True
    for tok in tokenize.generate_tokens(io.StringIO(source).readline):
        if tok.type == tokenize.COMMENT:
            blank(tok)
            continue
        if tok.type in (tokenize.NEWLINE, tokenize.NL, tokenize.INDENT, tokenize.DEDENT, tokenize.ENCODING):
            at_statement_start = True
            continue
        if tok.type == tokenize.STRING and at_statement_start:
            blank(tok)
            at_statement_start = False
            continue
        at_statement_start = False
    return "".join(chars)


def test_presplit_relineate_walk_appears_exactly_once():
    code = _code_only(_PRESPLIT.read_text())
    count = code.count(_NEEDLE)
    assert count == 1, (
        f"presplit re-lineation walk is duplicated ({count} code sites of the passthrough "
        f"decision). De-duplicate to one walk (see #886)."
    )


def test_guard_anchor_is_present_not_vacuous():
    # If the passthrough decision is renamed or reshaped, the count-of-1 assertion above could pass
    # vacuously (0 == wrong, but a refactor to 0 sites means the walk moved). Require the anchor to
    # exist at all so the guard fails loudly rather than silently going green on a moved walk.
    code = _code_only(_PRESPLIT.read_text())
    assert _NEEDLE in code, (
        "guard anchor missing — the presplit passthrough decision moved or was reshaped; "
        "update this guard to track the single walk (see #886)."
    )
