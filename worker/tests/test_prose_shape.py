"""The prose-shape policy as a test: a docstring is a few lines of WHAT and WHY; prose lives in `docs/`.

Ten rules over four roots — the package, the worker's own tests and BOTH committed bench harnesses. Five are
SHAPE (module docstring, def docstring, comment run, `#:` comment, and the bridged BLOCK that catches them in
combination), four are RATIO, which stops prose the shape rules allow accumulating module by module, layer by
layer and root by root, and the tenth reads two comments against EACH OTHER: a pasted block is short enough
for every bound and still says nothing true about the value under it.

docs/arch/05-worker.md §12 carries each bound, what sat on it when it was set, and why the ratio rules bind
per module in the package and per ROOT elsewhere. The remedy for a failure is always the same: move the
narrative to that document, to 04-alignment.md or to the measurement README, and cite it by path and `§N`.
"""

from __future__ import annotations

import ast
import io
import re
import tokenize
from collections.abc import Mapping
from pathlib import Path

import pytest

#: Lines a MODULE docstring may use: what the module is, what it is for, and where the long story lives.
#: A harness script's also holds the command lines that run it, which is most of its twelve.
MAX_MODULE_DOCSTRING = 12

#: Lines a function, method or class docstring may use. `align_steps` held a 125-line one when this was set.
MAX_DEF_DOCSTRING = 8

#: Lines a run of own-line `#` comments may use, bridged across blank lines as rule 5 bridges.
#: `host/config.py` held 261 before this rule, as `#` continuation rather than as a docstring.
MAX_COMMENT_RUN = 6

#: Lines a `#:` attribute comment may use: what the value means, its unit, and a pointer. NOT its derivation —
#: that is a measurement, and measurements live in docs/benchmarks/forced-alignment/LOG.md.
MAX_ATTRIBUTE_COMMENT = 3

#: Lines a bridged prose BLOCK may use: EXACTLY what rules 1 and 3 allow back to back, the worst legal
#: combination, so this is a BACKSTOP that catches a THIRD paragraph rather than a bound anything sits on.
#: `test_each_bound_still_names_what_sits_on_it` asserts that headroom instead of pretending it away.
MAX_BLOCK_LINES = MAX_MODULE_DOCSTRING + MAX_COMMENT_RUN

#: Prose lines per line of code, for a module rule 6 reaches. It was once 1.1; the package measured 0.82
#: before the prose sweep and 0.49 now (`MEASURED_ROOT_RATIO`).
MAX_PROSE_RATIO = 0.55

#: Below this many lines of code the ratio measures a module's INTERFACE rather than its prose, so rule 6
#: skips it and rules 1-5 and 7 carry it. The smallest module rule 6 reaches is `domain/audio/vocal_range.py`.
RATIO_MIN_CODE = 100

#: Rule 7, the aggregates that hold the modules rule 6 is too coarse for. The worst layer is
#: `encore_worker/artifacts` at 0.545 and the package is 0.489; the package bound sits below the layer bound
#: because every layer being at its bound would be a different package from this one.
MAX_LAYER_RATIO = 0.55
MAX_PACKAGE_RATIO = 0.52

#: Named exceptions, `"<label>::<qualname>": "the reason"`, with `<qualname>` = `BLOCK_KEY` for rule 5.
#: EMPTY, and that is the finished state: 271 package violations and 243 in the other three roots were
#: cleared without granting one. `test_every_named_exception_is_still_needed` deletes a stale entry.
EXCEPTIONS: dict[str, str] = {}

#: The `<qualname>` a rule 5 grant is keyed under: a block spans every docstring and comment run that touches
#: it, so it has no qualname and the grant is per MODULE. Rule 5 read `EXCEPTIONS` not at all before this
#: (docs/arch/05-worker.md §12).
BLOCK_KEY = "<block>"

#: The module or layer sitting CLOSEST to each bound, checked by
#: `test_each_bound_still_names_what_sits_on_it`, which also asserts rule 5's headroom still exists: a comment
#: claiming headroom it has not got sends the next wave to raise a number (docs/arch/05-worker.md §12).
TIGHTEST = {
    "module": "encore_worker/adapters/audiosep.py",
    "def": "encore_worker/adapters/cli.py",
    "comment": "encore_worker/__main__.py",
    "attribute": "encore_worker/adapters/ml.py",
    "block": "forced-alignment/e2e.py",
    "ratio": "encore_worker/domain/lyrics/policy.py",
    "layer": "encore_worker/artifacts",
}

#: Every directory of the package holding Python, NESTED ONES INCLUDED — a top-level-only list left
#: `domain/audio` (measured 1.18 before the sweep) above the bound and invisible behind its parent's average.
#: `test_every_layer_of_the_package_is_listed` walks recursively too, so nothing may leave this tuple.
LAYERS = (
    "encore_worker/adapters",
    "encore_worker/artifacts",
    "encore_worker/domain",
    "encore_worker/domain/audio",
    "encore_worker/domain/lyrics",
    "encore_worker/host",
    "encore_worker/protocol",
    "encore_worker/steps",
    "encore_worker/transport",
    "encore_worker/workflows",
)

#: The four roots every shape rule reads, worker-root-relative. An essay is no more checkable in a test file
#: or in a gate script than in the package, so none is exempt — the stem-separation harness included,
#: which an earlier list left out silently.
PACKAGE_ROOT = "encore_worker"
TESTS_ROOT = "tests"
HARNESS_ROOT = "../docs/benchmarks/forced-alignment/scripts"
SEPARATION_ROOT = "../docs/benchmarks/stem-separation/scripts"
ROOTS = (PACKAGE_ROOT, TESTS_ROOT, HARNESS_ROOT, SEPARATION_ROOT)

#: A spelled claim about how many roots there are IN TOTAL, held to `len(ROOTS)` by
#: `test_the_shape_rules_say_where`. The lead-in is required, or "the other three roots" and "two roots share
#: a label" — both true, neither a total — would read as the claim.
_ROOT_COUNT_WORD = re.compile(r"\b(?:all|over|[Tt]he) (one|two|three|four|five|six|seven|eight) roots\b")

#: Counts the tree spells rather than writes, so a test can check one. Prose is where a count goes stale.
_SPELLED = ("zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven")

#: Rule 9: every root but the package, each held to an aggregate rather than to rule 6 per module
#: (docs/arch/05-worker.md §12 — a test file is many small functions each honestly carrying two lines of WHAT,
#: a gate script a measurement argument with a `main()`). Per root, the roots being of very different sizes.
MAX_ROOT_RATIO = {TESTS_ROOT: 0.33, HARNESS_ROOT: 0.28, SEPARATION_ROOT: 0.30}

#: What each root MEASURES, to the two decimals it is quoted in to here and in docs/arch/05-worker.md §12 and
#: held there by `test_the_quoted_root_ratios_still_measure_what_they_say`: two quoted root ratios were stale
#: on the day they shipped and no test could see it.
MEASURED_ROOT_RATIO = {PACKAGE_ROOT: 0.49, TESTS_ROOT: 0.32, HARNESS_ROOT: 0.26, SEPARATION_ROOT: 0.22}

#: How far a quoted ratio may sit ABOVE the tree's reading before it is stale rather than merely conservative.
#: Below the reading it is stale at once: that direction claims less prose than the root carries. One-sided,
#: because the equality this replaced failed the suite when prose was DELETED.
QUOTE_STALE_ABOVE = 0.05

#: Ratio figures a document has RETRACTED, `"figure": "why"`. A retracted figure may still be quoted — never
#: delete a measured number — but only in a paragraph that retracts it, which is the defect
#: `test_a_retracted_ratio_is_never_republished_as_a_reading` closes.
RETRACTED_RATIOS = {
    "0.745": "the package read MID-WAVE, published as its pre-W7c baseline (review r1-tests-11)",
    "0.3124": "worker/tests read before the wave's last edits, where w7c-start reads 0.3114",
    "0.2580": "the forced-alignment harness, stale on the day rule 9's row shipped (review r1-spec-10)",
}

#: What marks a paragraph as retracting rather than republishing: any of these words near the figure.
_RETRACTION = ("retract", "stale", "mid-wave", "was never", "already", "before the wave")

#: Where a root ratio is quoted outside the code, repo-relative. All are read by the test above, since the
#: defect was the measurement log re-publishing what the design document had already withdrawn.
RATIO_DOCS = (
    "docs/arch/05-worker.md",
    "docs/benchmarks/forced-alignment/LOG.md",
    "docs/benchmarks/forced-alignment/README.md",
)

#: The smallest honest population per root, for `test_every_root_has_modules_to_measure`: a glob that silently
#: matched nothing would make every rule below vacuously green, and one floor cannot serve both a 68-module
#: root and a three-script one.
ROOT_MODULE_FLOOR = {PACKAGE_ROOT: 60, TESTS_ROOT: 50, HARNESS_ROOT: 10, SEPARATION_ROOT: 3}

#: The least code a root may hold before rule 9's ratio is measuring something other than that root.
ROOT_CODE_FLOOR = {TESTS_ROOT: 10_000, HARNESS_ROOT: 5_000, SEPARATION_ROOT: 250}


def _worker_root() -> Path:
    """Walked up to rather than counted down from, so this survives the tests moving."""
    for parent in Path(__file__).resolve().parents:
        if (parent / "encore_worker").is_dir() and (parent / "pyproject.toml").is_file():
            return parent
    raise AssertionError(
        "could not find the worker root: no parent holds both encore_worker and pyproject.toml"
    )


def _prose_lines(source: str) -> set[int]:
    """Every 1-based line number a docstring or a comment occupies. A line-1 `#!` is not prose: it is how a
    harness script is executed, and counting it bridged every shebang into the docstring below it."""
    lines: set[int] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
            if isinstance(node.value.value, str):
                lines.update(range(node.lineno, (node.end_lineno or node.lineno) + 1))
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.COMMENT and token.start[0] > 1:
            lines.add(token.start[0])
    return lines


def _counts(source: str) -> tuple[int, int]:
    """`(prose lines, code lines)` — blank lines count as neither."""
    prose = _prose_lines(source)
    lines = source.splitlines()
    code = sum(1 for n in range(1, len(lines) + 1) if n not in prose and lines[n - 1].strip())
    return len(prose), code


def _docstrings(source: str) -> list[tuple[str, str, int, int]]:
    """`(kind, qualname, first line, lines)` for the module docstring and every def and class docstring."""
    found: list[tuple[str, str, int, int]] = []

    def record(node: ast.AST, kind: str, qualname: str) -> None:
        if ast.get_docstring(node, clean=False) is None:  # type: ignore[arg-type]
            return
        first = node.body[0]  # type: ignore[attr-defined]
        found.append((kind, qualname, first.lineno, (first.end_lineno or first.lineno) - first.lineno + 1))

    def walk(prefix: str, node: ast.AST) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
                qualname = f"{prefix}{child.name}"
                record(child, "class" if isinstance(child, ast.ClassDef) else "def", qualname)
                walk(f"{qualname}.", child)
            else:
                walk(prefix, child)

    tree = ast.parse(source)
    record(tree, "module", "<module>")
    walk("", tree)
    return found


def _grouped(numbers: list[int], lines: list[str]) -> list[list[int]]:
    """Line numbers grouped into maximal runs, BRIDGED across blank lines for rule 5's reason."""
    runs: list[list[int]] = []
    current: list[int] = []
    for number in sorted(numbers):
        bridged = bool(current) and all(not line.strip() for line in lines[current[-1] : number - 1])
        if current and (number == current[-1] + 1 or bridged):
            current.append(number)
            continue
        if current:
            runs.append(current)
        current = [number]
    if current:
        runs.append(current)
    return runs


def _comment_runs(source: str) -> list[tuple[int, int, str]]:
    """`(first line, lines, "comment" | "attribute")` for every run of OWN-LINE comments.

    A comment TRAILING a line of code is not part of a run: two of those on consecutive lines are not a
    paragraph, and counting them would bridge unrelated runs. `#:` runs are grouped on their own as well as
    inside the general run, or a `# ── banner ──` above one would shield it from rule 4 and hand it rule 3's
    bound; a run that is ENTIRELY `#:` is rule 4's alone, so neither is reported twice.
    """
    lines = source.splitlines()
    own = [
        token.start[0]
        for token in tokenize.generate_tokens(io.StringIO(source).readline)
        if token.type == tokenize.COMMENT
        and token.start[0] > 1
        and lines[token.start[0] - 1].lstrip().startswith("#")
    ]
    attribute = [number for number in own if lines[number - 1].lstrip().startswith("#:")]
    found = [
        (run[0], len(run), "comment")
        for run in _grouped(own, lines)
        if not all(number in attribute for number in run)
    ]
    found += [(run[0], len(run), "attribute") for run in _grouped(attribute, lines)]
    return sorted(found)


def _longest_block(source: str) -> tuple[int, int]:
    """`(prose lines, first line)` of the longest prose BLOCK, so the failure can name where.

    A block is bridged across blank lines and ended only by code: before this bridged, one bare blank line
    every 40 lines split any essay into passing halves.
    """
    prose = _prose_lines(source)
    lines = source.splitlines()
    best = (0, 0)
    run = start = 0
    for number in range(1, len(lines) + 2):
        if number in prose:
            if not run:
                start = number
            run += 1
            continue
        if run and number <= len(lines) and not lines[number - 1].strip():
            continue  # blank: bridged, and not counted
        if run > best[0]:
            best = (run, start)
        run = 0
    return best


def _modules(worker: Path) -> list[str]:
    """Every module of the PACKAGE, worker-root-relative and sorted — what the ratio rules read."""
    return sorted(str(path.relative_to(worker)) for path in (worker / "encore_worker").rglob("*.py"))


def _label_of(root: str) -> str:
    """The prefix a root's modules are reported under: its own directory name, except that BOTH bench
    harnesses are directories called `scripts`, and one label for two roots would merge them."""
    path = Path(root)
    return path.parent.name if path.name == "scripts" else path.name


def _root_modules(worker: Path, roots: tuple[str, ...] = ROOTS) -> list[tuple[str, Path]]:
    """`(label, path)` for every module of `roots`, labelled by `_label_of`."""
    found: list[tuple[str, Path]] = []
    for root in roots:
        base = (worker / root).resolve()
        assert base.is_dir(), f"the shape rules' root {root} is not a directory"
        for path in sorted(base.rglob("*.py")):
            found.append((f"{_label_of(root)}/{path.relative_to(base)}", path))
    return found


def _shape_violations(worker: Path) -> dict[str, list[tuple[str, str]]]:
    """`{rule: [(label::qualname, how it reads)]}` for rules 1-4 over every root, exceptions applied."""
    found: dict[str, list[tuple[str, str]]] = {"module": [], "def": [], "comment": [], "attribute": []}
    bounds = {
        "module": MAX_MODULE_DOCSTRING,
        "def": MAX_DEF_DOCSTRING,
        "class": MAX_DEF_DOCSTRING,
        "comment": MAX_COMMENT_RUN,
        "attribute": MAX_ATTRIBUTE_COMMENT,
    }
    for label, path in _root_modules(worker):
        source = path.read_text(encoding="utf-8")
        for kind, qualname, first, length in _docstrings(source):
            rule = "def" if kind == "class" else kind
            key = f"{label}::{qualname}"
            if length > bounds[kind] and key not in EXCEPTIONS:
                found[rule].append((key, f"{label}:{first} ({length} lines, bound {bounds[kind]})"))
        for first, length, rule in _comment_runs(source):
            if length > bounds[rule]:
                found[rule].append((label, f"{label}:{first} ({length} lines, bound {bounds[rule]})"))
    return found


def _essays(modules: list[tuple[str, Path]], exceptions: Mapping[str, str] = EXCEPTIONS) -> list[str]:
    """Rule 5's violations, `EXCEPTIONS` applied under `BLOCK_KEY` as rules 1-4 apply it under a qualname."""
    found: list[str] = []
    for label, path in modules:
        length, first = _longest_block(path.read_text(encoding="utf-8"))
        if length > MAX_BLOCK_LINES and f"{label}::{BLOCK_KEY}" not in exceptions:
            found.append(f"{label}:{first} ({length} lines, bound {MAX_BLOCK_LINES})")
    return found


def _quote_stale(prose: int, code: int, quoted: float) -> str:
    """Why a quoted root ratio no longer measures the tree, or `""` when it still does.

    One-sided on purpose: a reading that has DROPPED below the quote is the prose-shape policy being
    obeyed, so it costs a re-quote only once it drops `QUOTE_STALE_ABOVE`.
    """
    reading = prose / code
    if round(reading, 2) > quoted:
        return f"measures {prose}/{code} = {reading:.4f}, ABOVE the {quoted} quoted: prose has been ADDED"
    if quoted - reading > QUOTE_STALE_ABOVE:
        return (
            f"measures {prose}/{code} = {reading:.4f}, {quoted - reading:.4f} under the {quoted} quoted, "
            f"past the {QUOTE_STALE_ABOVE} a conservative quote may keep"
        )
    return ""


#: Rule 10: how much of two CONSECUTIVE comment runs' content words may coincide (Jaccard) before the second
#: reads as a copy of the first rather than a comment of its own. Set in the gap the tree measures — the one
#: real pair 0.889, the next 0.436 over 773 pairs (docs/arch/05-worker.md §12).
MAX_COMMENT_OVERLAP = 0.6

#: What rule 10 compares: lowercase words of four letters or more, so two runs sharing only `the`/`and`/a
#: backticked short name are not a duplicate pair.
_CONTENT_WORD = re.compile(r"[a-z][a-z_]{3,}")


def _comment_blocks(source: str) -> list[tuple[int, int, str]]:
    """`(first line, last line, text)` for every own-line comment run of 2+ lines, at most one per start line.

    A `# ── banner ──` BRIDGES into the `#:` block below it, so `_comment_runs` reports the pair twice: once
    as the whole run and once as the `#:` part. Both are kept and rule 10 drops the overlap, since a run
    nested inside another shares every word with it by construction.
    """
    lines = source.splitlines()
    longest: dict[int, int] = {}
    for first, length, _kind in _comment_runs(source):
        longest[first] = max(longest.get(first, 0), length)
    blocks: list[tuple[int, int, str]] = []
    for first, length in sorted(longest.items()):
        if length < 2:
            continue
        taken: list[str] = []
        number = first
        while len(taken) < length and number <= len(lines):
            if lines[number - 1].lstrip().startswith("#"):
                taken.append(lines[number - 1])
            number += 1
        blocks.append((first, number - 1, " ".join(taken)))
    return blocks


def _duplicate_comments(modules: list[tuple[str, Path]], limit: float = MAX_COMMENT_OVERLAP) -> list[str]:
    """Rule 10's violations: consecutive DISJOINT comment runs whose content words overlap past `limit`."""
    found: list[str] = []
    for label, path in modules:
        blocks = _comment_blocks(path.read_text(encoding="utf-8"))
        for (first, last, one), (second, _end, two) in zip(blocks, blocks[1:], strict=False):
            if second <= last:
                continue
            left, right = set(_CONTENT_WORD.findall(one)), set(_CONTENT_WORD.findall(two))
            if not left or not right:
                continue
            overlap = len(left & right) / len(left | right)
            if overlap > limit:
                found.append(f"{label}:{first} and :{second} share {overlap:.2f} of their content words")
    return found


@pytest.fixture(scope="module")
def worker() -> Path:
    return _worker_root()


def test_every_root_has_modules_to_measure(worker: Path) -> None:
    """A glob that silently matched nothing would make every rule below vacuously green."""
    labels = [label for label, _path in _root_modules(worker)]
    assert len(labels) > 150, f"expected all four roots, found {len(labels)} modules"
    for root in ROOTS:
        prefix = f"{_label_of(root)}/"
        found = sum(1 for label in labels if label.startswith(prefix))
        assert found >= ROOT_MODULE_FLOOR[root], f"{root} matched {found} modules, under its own floor"
    assert len(set(labels)) == len(labels), "two roots share a label, so their worst prose would be merged"
    assert "encore_worker/steps/align_steps.py" in labels
    assert len(_modules(worker)) > 60, "the ratio rules have stopped seeing the package"


def test_the_shape_rules_say_where(worker: Path) -> None:
    """Rules 1-4's roots are a claim about coverage, so they are asserted rather than left to the constant."""
    counted = _shape_violations(worker)
    read = sum(len(_docstrings(path.read_text(encoding="utf-8"))) for _label, path in _root_modules(worker))
    assert read > 1500, f"rules 1-2 read only {read} docstrings; a root has stopped matching"
    assert set(counted) == {"module", "def", "comment", "attribute"}
    assert set(ROOTS) == {PACKAGE_ROOT, TESTS_ROOT, HARNESS_ROOT, SEPARATION_ROOT}
    assert set(MAX_ROOT_RATIO) == set(ROOTS) - {PACKAGE_ROOT}, "rule 9 must bind on every non-package root"
    assert set(MEASURED_ROOT_RATIO) == set(ROOTS), "every root's measured ratio is quoted and checked"
    # And the TOTAL spelled in this module's own prose: rule 2's docstring went on claiming a count one short
    # of `ROOTS` for a long time after the fourth was added.
    said = set(_ROOT_COUNT_WORD.findall(re.sub(r"\s+", " ", Path(__file__).read_text(encoding="utf-8"))))
    assert said == {_SPELLED[len(ROOTS)]}, (
        f"this module's prose spells the root count as {sorted(said)} where ROOTS holds {len(ROOTS)}"
    )


def test_the_measure_still_sees_prose(worker: Path) -> None:
    """The non-vacuity floor rules 5-9 all lacked: zeroing the MEASURE left 24 of 24 tests green.

    `_longest_block` and `_counts` both read `_prose_lines`, and nothing asserted that it returns anything, so
    `_prose_lines = lambda _: set()` passed the whole file — `_worst` returning every key at a tie of 0 even
    kept `TIGHTEST` happy.
    """
    sources = [path.read_text(encoding="utf-8") for _label, path in _root_modules(worker)]
    seen = sum(len(_prose_lines(source)) for source in sources)
    assert seen > 4_000, f"the measure sees only {seen} prose lines across the roots; it has gone blind"
    counted = sum(_counts(source)[0] for source in sources)
    assert counted == seen, f"`_counts` reads {counted} prose lines where `_prose_lines` reads {seen}"
    longest = max(_longest_block(source)[0] for source in sources)
    assert longest >= 10, f"the longest block measures {longest} lines: the block walk has gone blind"
    # And the bridging rule itself, on a synthetic module rather than on whatever the tree happens to hold: a
    # docstring, two blank lines, a comment run, then code — one block of five, not two of three and two.
    bridged = '"""one\ntwo\n"""\n\n\n# three\n# four\n\nx = 1\n'
    assert _longest_block(bridged) == (5, 1), "a blank line must not split a block (rule 5's whole reason)"
    assert _counts(bridged) == (5, 1)
    assert _longest_block("x = 1\n") == (0, 0), "and code alone is no block at all"


def test_a_module_docstring_says_what_it_is_and_points_at_the_rest(worker: Path) -> None:
    """Rule 1. A module-level `\"\"\"...\"\"\"` that merely lists a class's fields is dead prose, not an
    exception: delete it, or name the one thing the module is for."""
    over = sorted(where for _, where in _shape_violations(worker)["module"])
    assert not over, (
        f"these module docstrings exceed {MAX_MODULE_DOCSTRING} lines: {over}. A module says what it is, "
        "what it is for, and where the long story lives — see docs/arch/04-alignment.md and 05-worker.md."
    )


def test_a_def_docstring_is_what_and_why_and_nothing_longer(worker: Path) -> None:
    """Rule 2, over every function, method and class of all four roots.

    A TEST's docstring keeps the claim it pins and the mutation that used to survive; what it does not keep is
    a re-derivation of a measurement or a re-argued review finding (docs/arch/05-worker.md §12).
    """
    over = sorted(where for _, where in _shape_violations(worker)["def"])
    assert not over, (
        f"these def/class docstrings exceed {MAX_DEF_DOCSTRING} lines: {over}. Threshold provenance, "
        "rejected alternatives, failure accounts and per-song numbers belong in docs/ with the code citing "
        "the path (see tests/test_docs_pointers.py)."
    )


def test_a_comment_run_does_not_become_a_paragraph(worker: Path) -> None:
    """Rule 3. `#` continuation is the cheapest way to keep an essay, so it has a bound of its own."""
    over = sorted(where for _, where in _shape_violations(worker)["comment"])
    assert not over, (
        f"these comment runs exceed {MAX_COMMENT_RUN} lines: {over}. Prefer a clear name over a comment "
        "explaining an unclear one, and move an argument to docs/."
    )


def test_an_attribute_comment_gives_the_unit_and_a_pointer_not_a_derivation(worker: Path) -> None:
    """Rule 4. `#:` comments are kept by the idiom and kept SHORT by this."""
    over = sorted(where for _, where in _shape_violations(worker)["attribute"])
    assert not over, (
        f"these `#:` attribute comments exceed {MAX_ATTRIBUTE_COMMENT} lines: {over}. A calibrated constant "
        "carries its value, its unit and a pointer; its derivation is a measurement and lives in "
        "docs/benchmarks/forced-alignment/LOG.md."
    )


def test_no_prose_block_is_an_essay(worker: Path) -> None:
    """Rule 5, over every module of every root: the combination bound rules 1-4 cannot see."""
    modules = _root_modules(worker)
    assert len(modules) > 150, f"rule 5 read only {len(modules)} modules; a root has stopped matching"
    essays = sorted(_essays(modules))
    assert not essays, (
        f"these carry a prose run over the {MAX_BLOCK_LINES}-line bound: {essays}. Measurement narratives, "
        "threshold derivations, rejected alternatives and failure accounts belong in docs/ with the code "
        "citing the path (see tests/test_docs_pointers.py)."
    )


def test_rule_5_honours_a_grant_as_rules_1_to_4_do(tmp_path: Path) -> None:
    """`EXCEPTIONS` was read by `_shape_violations` alone, so the only sanctioned route could not sanction a
    docstring over `MAX_BLOCK_LINES` — the one length it exists for."""
    module = tmp_path / "essay.py"
    body = "\n".join(f"line {n}" for n in range(MAX_BLOCK_LINES + 1))
    module.write_text(f'"""{body}"""\nx = 1\n', encoding="utf-8")
    modules = [("encore_worker/essay.py", module)]
    assert _essays(modules, {}), f"a {MAX_BLOCK_LINES + 1}-line docstring must violate rule 5 ungranted"
    granted = {f"encore_worker/essay.py::{BLOCK_KEY}": "a reason long enough to satisfy the hatch's own test"}
    assert not _essays(modules, granted), "a rule 5 grant must suppress the violation it names"
    assert _essays(modules, {f"encore_worker/essay.py::{'<module>'}": "wrong key"}), (
        "a grant on the DOCSTRING's qualname must not silently serve as a block grant"
    )


def test_a_comment_is_not_a_copy_of_the_one_above_it(worker: Path) -> None:
    """Rule 10. `pool_gate.py`'s `ARMS` carried `SOUND_CUES`' block verbatim — three index claims that were
    false of its own tuple, and the arms' real semantics deleted."""
    copies = sorted(_duplicate_comments(_root_modules(worker)))
    assert not copies, (
        f"these read as copies rather than as comments of their own: {copies}. A pasted block describes the "
        f"value above it, not the one below: write the second constant's own ({MAX_COMMENT_OVERLAP} Jaccard "
        "bound, docs/arch/05-worker.md §12)."
    )


def test_rule_10_reads_the_pair_it_was_written_for(tmp_path: Path) -> None:
    """Rule 10 compares DISJOINT runs only: a `# ── banner ──` bridges into the `#:` block below it, so
    `_comment_runs` reports that pair twice and the nested copy shares every word by construction."""
    head = "ZERO = 0\n"  # line 1 is never prose: `_comment_runs` skips it, a shebang not being a comment
    one_line = "#: alpha bravo charlie delta echo foxtrot indexes the surviving cue\n"
    two_line = "#: alpha bravo charlie delta echo\n#: foxtrot indexes the surviving cue\n"
    cases = {
        "pasted": (f"{head}{one_line}FIRST = 1\n{one_line}SECOND = 2\n", False),
        "pair": (f"{head}{two_line}FIRST = 1\n{two_line}SECOND = 2\n", True),
        "nested": (f"{head}# -- banner --\n\n{two_line}FIRST = 1\n", False),
        "distinct": (f"{head}{two_line}FIRST = 1\n#: golf hotel\n#: india juliett\nSECOND = 2\n", False),
    }
    for name, (source, caught) in cases.items():
        module = tmp_path / f"{name}.py"
        module.write_text(source, encoding="utf-8")
        found = _duplicate_comments([(f"tests/{name}.py", module)])
        assert bool(found) is caught, f"rule 10 read {name} as {found}, expecting caught={caught}"


def test_a_module_with_real_code_carries_half_as_much_prose_as_code(worker: Path) -> None:
    """Rule 6, over every PACKAGE module big enough for the ratio to mean something (`RATIO_MIN_CODE`)."""
    over: list[str] = []
    measured = 0
    for module in _modules(worker):
        prose, code = _counts((worker / module).read_text(encoding="utf-8"))
        if code < RATIO_MIN_CODE:
            continue
        measured += 1
        if prose / code > MAX_PROSE_RATIO:
            over.append(f"{module} ({prose} prose / {code} code = {prose / code:.2f})")
    assert measured > 20, f"only {measured} modules reached the ratio rule; the threshold has drifted"
    assert not over, (
        f"these exceed the {MAX_PROSE_RATIO} prose-to-code bound: {over}. Move the narrative to docs/ and "
        "cite it by path."
    )


@pytest.mark.parametrize("layer", LAYERS)
def test_a_layer_carries_half_as_much_prose_as_code(worker: Path, layer: str) -> None:
    """Rule 7 per layer — the aggregate that holds the modules rule 6 is too coarse for."""
    files = sorted((worker / layer).rglob("*.py"))
    assert files, f"{layer} matched no module"
    prose = code = 0
    for path in files:
        one_prose, one_code = _counts(path.read_text(encoding="utf-8"))
        prose += one_prose
        code += one_code
    if not code:
        # A namespace holder (one `__init__.py`, one line of WHAT) has no denominator, so rule 1's bound is
        # the whole of what can be said about it. Asserted rather than skipped: it must stay that small.
        assert prose <= MAX_MODULE_DOCSTRING, (
            f"{layer} holds no code and {prose} prose lines; a directory that is only a docstring may not "
            "grow a narrative. Move it to docs/."
        )
        return
    assert prose / code <= MAX_LAYER_RATIO, (
        f"{layer} is {prose} prose lines to {code} of code ({prose / code:.2f}), over the "
        f"{MAX_LAYER_RATIO} bound. A layer's small modules may not bloat collectively."
    )


def _root_ratio(worker: Path, root: str) -> tuple[int, int]:
    """`(prose, code)` summed over one root's modules."""
    prose = code = 0
    for _label, path in _root_modules(worker, (root,)):
        one_prose, one_code = _counts(path.read_text(encoding="utf-8"))
        prose += one_prose
        code += one_code
    return prose, code


def test_the_whole_package_carries_half_as_much_prose_as_code(worker: Path) -> None:
    """Rule 8: the one number the policy was given in."""
    prose, code = _root_ratio(worker, PACKAGE_ROOT)
    assert prose / code <= MAX_PACKAGE_RATIO, (
        f"encore_worker is {prose} prose lines to {code} of code ({prose / code:.2f}), over the "
        f"{MAX_PACKAGE_RATIO} bound. It was 1.21 before W7b, 0.82 before W7c and 0.49 after."
    )


@pytest.mark.parametrize("root", sorted(MAX_ROOT_RATIO))
def test_a_root_outside_the_package_carries_less_prose_than_its_own_bound(worker: Path, root: str) -> None:
    """Rule 9: the tests an earlier scope left out entirely, and both committed bench harnesses.

    An aggregate rather than rule 6 per module, for docs/arch/05-worker.md §12's reason: a test file is many
    small functions each honestly carrying two lines of WHAT, so a per-module bound would delete the right
    length of docstring. "No narrative here either" still has to be checkable, and this is how.
    """
    prose, code = _root_ratio(worker, root)
    assert code >= ROOT_CODE_FLOOR[root], f"{root} matched only {code} lines of code; it has moved"
    assert prose / code <= MAX_ROOT_RATIO[root], (
        f"{root} is {prose} prose lines to {code} of code ({prose / code:.2f}), over its "
        f"{MAX_ROOT_RATIO[root]} bound. A test docstring says what it pins and why, and a harness's argument "
        "belongs in the README it measures for."
    )


@pytest.mark.parametrize("root", sorted(MEASURED_ROOT_RATIO))
def test_the_quoted_root_ratios_still_measure_what_they_say(worker: Path, root: str) -> None:
    """A quoted ratio is a measurement, so it is read off the tree rather than believed.

    Rule 9's own `#:` comment and docs/arch/05-worker.md §12's rule-9 row both shipped quoting 0.3124 and
    0.2580 where the tree read 0.3114 and 0.2578. `TIGHTEST`'s test holds the module and layer NAMES to the
    same standard and could not see these, there being no name in them.
    """
    prose, code = _root_ratio(worker, root)
    stale = _quote_stale(prose, code, MEASURED_ROOT_RATIO[root])
    assert not stale, (
        f"{root} {stale}. Re-measure and correct MEASURED_ROOT_RATIO and docs/arch/05-worker.md §12 together."
    )


def test_a_retracted_ratio_is_never_republished_as_a_reading(worker: Path) -> None:
    """The measurement README quoted 0.745 as the package's pre-sweep figure in the change where 05-worker.md
    §12 retracted it, so the measurement-of-record and the design document contradicted each other and no
    test could see it. A figure stays in the repo; it may only appear where it is withdrawn."""
    repo = worker.parent
    republished: list[str] = []
    for doc in RATIO_DOCS:
        for paragraph in repo.joinpath(doc).read_text(encoding="utf-8").split("\n\n"):
            flat = re.sub(r"\s+", " ", paragraph).lower()
            retracts = any(word in flat for word in _RETRACTION)
            republished += [
                f"{doc}: {figure} without a retraction — {why}"
                for figure, why in RETRACTED_RATIOS.items()
                if figure in flat and not retracts
            ]
    assert not republished, (
        f"these republish a retracted ratio as a reading: {republished}. Quote it only where withdrawn, "
        f"or drop it from RETRACTED_RATIOS once no document carries it. Marks: {_RETRACTION}."
    )


def test_a_quoted_root_ratio_is_a_ceiling_so_prose_can_still_be_deleted() -> None:
    """The quote was pinned by EQUALITY at +-0.005, and the stem-separation root had under one line of slack:
    deleting three docstring lines from it failed the suite, i.e. the prose-shape policy's own remedy broke
    the ratchet that enforces it. Read on that root's own measurement, 72/324."""
    assert not _quote_stale(72, 324, 0.22), "the shipped reading must satisfy its own quote"
    assert not _quote_stale(69, 324, 0.22), "deleting three prose lines must not fail the suite"
    assert _quote_stale(85, 324, 0.22), "ADDING a module docstring must fail: the quote would understate"
    assert _quote_stale(55, 324, 0.22), "and a sweep past QUOTE_STALE_ABOVE must ask for the re-quote"


def _layer_ratio(worker: Path, layer: str) -> float:
    prose = code = 0
    for path in sorted((worker / layer).rglob("*.py")):
        one_prose, one_code = _counts(path.read_text(encoding="utf-8"))
        prose += one_prose
        code += one_code
    return prose / code if code else 0.0


def _worst(measured: dict[str, float]) -> set[str]:
    """Every key at the maximum — all of them, because several docstrings sit on a bound at once."""
    peak = max(measured.values())
    return {key for key, value in measured.items() if value == peak}


def test_each_bound_still_names_what_sits_on_it(worker: Path) -> None:
    """The `#:` comments above quote where the headroom has run out, so the quotes are measured, not asserted.

    This is the defect it closes: three bounds shipped with comments calling
    them generous while two modules sat exactly on them. Update `TIGHTEST` and the comment together.
    """
    longest: dict[str, dict[str, float]] = {
        "module": {},
        "def": {},
        "comment": {},
        "attribute": {},
        "block": {},
    }
    for label, path in _root_modules(worker):
        source = path.read_text(encoding="utf-8")
        for kind, _, _, length in _docstrings(source):
            rule = "def" if kind == "class" else kind
            longest[rule][label] = max(longest[rule].get(label, 0), length)
        for _, length, rule in _comment_runs(source):
            longest[rule][label] = max(longest[rule].get(label, 0), length)
        longest["block"][label] = float(_longest_block(source)[0])
    for rule in longest:
        assert TIGHTEST[rule] in _worst(longest[rule]), (
            f"the longest {rule} prose is no longer in {TIGHTEST[rule]} but in "
            f"{sorted(_worst(longest[rule]))}. Re-point TIGHTEST and that bound's `#:` comment at it."
        )
    # Rule 5 is the only bound with headroom, and the comment on it says so: rules 1-4 bind first, so no
    # module reaches the worst legal combination. Asserted, or that claim could go stale too.
    worst_block = max(longest["block"].values())
    assert worst_block < MAX_BLOCK_LINES, (
        f"a block reaches {worst_block:.0f} of {MAX_BLOCK_LINES}: rules 1-4 no longer bind first, so "
        "MAX_BLOCK_LINES' `#:` comment is stale."
    )

    ratios = {
        module: prose / code
        for module in _modules(worker)
        for prose, code in [_counts((worker / module).read_text(encoding="utf-8"))]
        if code >= RATIO_MIN_CODE
    }
    assert TIGHTEST["ratio"] in _worst(ratios), (
        f"the highest module prose ratio is now {sorted(_worst(ratios))}, not {TIGHTEST['ratio']}."
    )

    layers = {layer: _layer_ratio(worker, layer) for layer in LAYERS}
    assert TIGHTEST["layer"] in _worst(layers), (
        f"the worst layer ratio is now {sorted(_worst(layers))}, not {TIGHTEST['layer']}."
    )


def test_every_named_exception_is_still_needed(worker: Path) -> None:
    """An exception nobody needs reads as a defect that is still open, so a stale one fails.

    The route is deliberately narrow: only a docstring or a module's longest BLOCK can be excepted, by
    `label::qualname` or `label::<block>`, and only with a reason. A comment run has no stable name and so has
    no route at all — shorten it, or make it a docstring and argue for the exception there.
    """
    paths = dict(_root_modules(worker))
    for key, reason in EXCEPTIONS.items():
        label, _, qualname = key.partition("::")
        assert qualname, f"{key} is not a `label::qualname` exception key"
        assert len(reason) > 20, f"{key}'s exception gives no reason: {reason!r}"
        assert label in paths, f"{key} excepts a module that no longer exists"
        if qualname == BLOCK_KEY:
            length, _first = _longest_block(paths[label].read_text(encoding="utf-8"))
            assert length > MAX_BLOCK_LINES, (
                f"{key}'s block is {length} lines, inside the {MAX_BLOCK_LINES}-line bound: delete it."
            )
            continue
        lengths = {
            name: length
            for kind, name, _, length in _docstrings(paths[label].read_text(encoding="utf-8"))
            if (kind == "module" and qualname == "<module>") or (kind != "module" and name == qualname)
        }
        assert qualname in lengths, f"{key} excepts a docstring that no longer exists"
        bound = MAX_MODULE_DOCSTRING if qualname == "<module>" else MAX_DEF_DOCSTRING
        assert lengths[qualname] > bound, (
            f"{key} is {lengths[qualname]} lines, within the {bound}-line bound: delete the exception."
        )


def test_every_layer_of_the_package_is_listed(worker: Path) -> None:
    """A layer missing from `LAYERS` is a layer rule 7 does not read, which is how the rule goes hollow.

    RECURSIVE, because the hole this closes was a NESTED directory: with top-level names only, `domain/audio`
    could never be required and sat over the bound behind `domain/`'s average.
    """
    package = worker / "encore_worker"
    listed = set(LAYERS)
    found = {
        str(path.relative_to(worker))
        for path in package.rglob("*")
        if path.is_dir() and path.name != "__pycache__" and any(path.rglob("*.py"))
    }
    assert found <= listed, f"these package directories are not in LAYERS: {sorted(found - listed)}"
    assert listed <= found, f"these LAYERS entries no longer exist: {sorted(listed - found)}"
    # And the package's FRONT DOOR, which spelled seven layers and listed seven of the eight for a long time,
    # beside an invariant id about stem roles. A count in prose is a measurement.
    door = (package / "__init__.py").read_text(encoding="utf-8")
    front = re.sub(r"\s+", " ", ast.get_docstring(ast.parse(door)) or "")
    top = sorted(name.split("/")[1] for name in listed if name.count("/") == 1)
    unnamed = [name for name in top if f"`{name}/`" not in front]
    assert not unnamed, f"encore_worker/__init__.py's docstring does not name these layers: {unnamed}"
    assert f"{_SPELLED[len(top)]} layers" in front.lower(), (
        f"the package has {len(top)} top-level layers; its docstring spells a different count: {front[:120]}"
    )
