"""The 2026-10-01 directive as a test: a docstring is a few lines of WHAT and WHY; prose lives in `docs/`.

Nine rules over three roots — the package, the worker's own tests and the committed bench harness. Five are
SHAPE (module docstring, def docstring, comment run, `#:` comment, and the bridged BLOCK that catches them in
combination) and four are RATIO, which stops prose the shape rules allow accumulating module by module, layer
by layer and root by root.

docs/arch/05-worker.md §12 carries each bound, what sat on it when it was set, and why the ratio rules bind
per module in the package and per ROOT elsewhere. The remedy for a failure is always the same: move the
narrative to that document, to 04-alignment.md or to the measurement README, and cite it by path and `§N`.
"""

from __future__ import annotations

import ast
import io
import tokenize
from pathlib import Path

import pytest

#: Lines a MODULE docstring may use: what the module is, what it is for, and where the long story lives.
#: A harness script's also holds the command lines that run it, which is most of its twelve.
MAX_MODULE_DOCSTRING = 12

#: Lines a function, method or class docstring may use. `align_steps` held a 125-line one at the directive.
MAX_DEF_DOCSTRING = 8

#: Lines a run of own-line `#` comments may use, bridged across blank lines as rule 5 bridges.
#: `host/config.py` held 261 before W7b, as `#` continuation rather than as a docstring.
MAX_COMMENT_RUN = 6

#: Lines a `#:` attribute comment may use: what the value means, its unit, and a pointer. NOT its derivation —
#: that is a measurement, and measurements live in docs/benchmarks/forced-alignment/README.md.
MAX_ATTRIBUTE_COMMENT = 3

#: Lines a bridged prose BLOCK may use: EXACTLY what rules 1 and 3 allow back to back, the worst legal
#: combination, so this is a BACKSTOP that catches a THIRD paragraph rather than a bound anything sits on.
#: `test_each_bound_still_names_what_sits_on_it` asserts that headroom instead of pretending it away.
MAX_BLOCK_LINES = MAX_MODULE_DOCSTRING + MAX_COMMENT_RUN

#: Prose lines per line of code, for a module rule 6 reaches. W7b's bound was 1.1; the package measured 0.745
#: when W7c started and 0.489 when it finished.
MAX_PROSE_RATIO = 0.55

#: Below this many lines of code the ratio measures a module's INTERFACE rather than its prose, so rule 6
#: skips it and rules 1-5 and 7 carry it. The smallest module rule 6 reaches is `domain/audio/vocal_range.py`.
RATIO_MIN_CODE = 100

#: Rule 7, the aggregates that hold the modules rule 6 is too coarse for. The worst layer is
#: `encore_worker/artifacts` at 0.545 and the package is 0.489; the package bound sits below the layer bound
#: because every layer being at its bound would be a different package from this one.
MAX_LAYER_RATIO = 0.55
MAX_PACKAGE_RATIO = 0.52

#: Rule 9: the other two roots, each held to an aggregate rather than per module (docs/arch/05-worker.md §12 —
#: a test file is many small functions each honestly carrying two lines, a gate script a measurement argument
#: with a `main()`). Measured 0.3124 and 0.2580 when W7c extended the shape rules to them.
MAX_TESTS_RATIO = 0.33
MAX_HARNESS_RATIO = 0.28

#: Named exceptions, `"<label>::<qualname>": "the reason"`. EMPTY, and that is the finished state: W7c cleared
#: 271 package violations and 239 in the other two roots without granting one, which is the point.
#: `test_every_named_exception_is_still_needed` deletes a stale entry for whoever adds one.
EXCEPTIONS: dict[str, str] = {}

#: The module or layer sitting CLOSEST to each bound, checked by
#: `test_each_bound_still_names_what_sits_on_it`, which also asserts that rule 5's headroom still exists: a
#: comment claiming headroom it has not got sends the next wave to raise a number (05-worker.md §12).
TIGHTEST = {
    "module": "encore_worker/adapters/audiosep.py",
    "def": "encore_worker/adapters/cli.py",
    "comment": "encore_worker/__main__.py",
    "attribute": "encore_worker/adapters/ml.py",
    "block": "scripts/e2e.py",
    "ratio": "encore_worker/domain/lyrics/policy.py",
    "layer": "encore_worker/artifacts",
}

#: Every directory of the package holding Python, NESTED ONES INCLUDED — a top-level-only list left
#: `domain/audio` (measured 1.18 at W7b) above the bound and invisible behind its parent's average.
#: `test_every_layer_of_the_package_is_listed` walks recursively too, so nothing may leave this tuple.
LAYERS = (
    "encore_worker/adapters",
    "encore_worker/artifacts",
    "encore_worker/domain",
    "encore_worker/domain/analysis",
    "encore_worker/domain/audio",
    "encore_worker/domain/lyrics",
    "encore_worker/host",
    "encore_worker/protocol",
    "encore_worker/steps",
    "encore_worker/transport",
    "encore_worker/workflows",
)

#: The three roots every shape rule reads, worker-root-relative. An essay is no more checkable in a test file
#: or in a gate script than in the package, and W7c is the wave that stopped exempting them.
PACKAGE_ROOT = "encore_worker"
TESTS_ROOT = "tests"
HARNESS_ROOT = "../docs/benchmarks/forced-alignment/scripts"
ROOTS = (PACKAGE_ROOT, TESTS_ROOT, HARNESS_ROOT)


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
    every 40 lines split any essay into passing halves (W7b review r1).
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


def _root_modules(worker: Path, roots: tuple[str, ...] = ROOTS) -> list[tuple[str, Path]]:
    """`(label, path)` for every module of `roots`, labelled by the root's own directory name."""
    found: list[tuple[str, Path]] = []
    for root in roots:
        base = (worker / root).resolve()
        assert base.is_dir(), f"the shape rules' root {root} is not a directory"
        for path in sorted(base.rglob("*.py")):
            found.append((f"{Path(root).name}/{path.relative_to(base)}", path))
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


@pytest.fixture(scope="module")
def worker() -> Path:
    return _worker_root()


def test_the_three_roots_have_modules_to_measure(worker: Path) -> None:
    """A glob that silently matched nothing would make every rule below vacuously green."""
    labels = [label for label, _path in _root_modules(worker)]
    assert len(labels) > 150, f"expected all three roots, found {len(labels)} modules"
    for root in ROOTS:
        prefix = f"{Path(root).name}/"
        assert sum(1 for label in labels if label.startswith(prefix)) > 10, f"{root} matched almost nothing"
    assert "encore_worker/steps/align_steps.py" in labels
    assert len(_modules(worker)) > 60, "the ratio rules have stopped seeing the package"


def test_the_shape_rules_say_where(worker: Path) -> None:
    """Rules 1-4's roots are a claim about coverage, so they are asserted rather than left to the constant."""
    counted = _shape_violations(worker)
    read = sum(len(_docstrings(path.read_text(encoding="utf-8"))) for _label, path in _root_modules(worker))
    assert read > 1500, f"rules 1-2 read only {read} docstrings; a root has stopped matching"
    assert set(counted) == {"module", "def", "comment", "attribute"}
    assert set(ROOTS) == {PACKAGE_ROOT, TESTS_ROOT, HARNESS_ROOT}


def test_a_module_docstring_says_what_it_is_and_points_at_the_rest(worker: Path) -> None:
    """Rule 1. A module-level `\"\"\"...\"\"\"` that merely lists a class's fields is dead prose, not an
    exception: delete it, or name the one thing the module is for."""
    over = sorted(where for _, where in _shape_violations(worker)["module"])
    assert not over, (
        f"these module docstrings exceed {MAX_MODULE_DOCSTRING} lines: {over}. A module says what it is, "
        "what it is for, and where the long story lives — see docs/arch/04-alignment.md and 05-worker.md."
    )


def test_a_def_docstring_is_what_and_why_and_nothing_longer(worker: Path) -> None:
    """Rule 2, over every function, method and class of all three roots.

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
    """Rule 3. `#` continuation was W7b's cheapest way to keep an essay, so it has a bound of its own."""
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
        "docs/benchmarks/forced-alignment/README.md."
    )


def test_no_prose_block_is_an_essay(worker: Path) -> None:
    """Rule 5, over every module of every root: the combination bound rules 1-4 cannot see."""
    modules = _root_modules(worker)
    assert len(modules) > 150, f"rule 5 read only {len(modules)} modules; a root has stopped matching"
    essays: list[str] = []
    for label, path in modules:
        length, first = _longest_block(path.read_text(encoding="utf-8"))
        if length > MAX_BLOCK_LINES:
            essays.append(f"{label}:{first} ({length} lines, bound {MAX_BLOCK_LINES})")
    assert not essays, (
        f"these carry a prose run over the {MAX_BLOCK_LINES}-line bound: {essays}. Measurement narratives, "
        "threshold derivations, rejected alternatives and failure accounts belong in docs/ with the code "
        "citing the path (see tests/test_docs_pointers.py)."
    )


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
    """Rule 8: the one number the directive was given in."""
    prose, code = _root_ratio(worker, PACKAGE_ROOT)
    assert prose / code <= MAX_PACKAGE_RATIO, (
        f"encore_worker is {prose} prose lines to {code} of code ({prose / code:.2f}), over the "
        f"{MAX_PACKAGE_RATIO} bound. It was 1.21 before W7b, 0.745 before W7c and 0.49 after."
    )


def test_the_worker_tests_carry_less_prose_than_their_own_bound(worker: Path) -> None:
    """Rule 9 for `tests/`, which W7b left out of scope entirely and W7c swept (239 edits with the harness).

    An aggregate rather than rule 6 per module, for docs/arch/05-worker.md §12's reason: a test file is many
    small functions each honestly carrying two lines of WHAT, so a per-module bound would delete the right
    length of docstring. "No narrative here either" still has to be checkable, and this is how.
    """
    prose, code = _root_ratio(worker, TESTS_ROOT)
    assert code > 10_000, f"the tests root matched only {code} lines of code; it has moved"
    assert prose / code <= MAX_TESTS_RATIO, (
        f"worker/tests is {prose} prose lines to {code} of code ({prose / code:.2f}), over the "
        f"{MAX_TESTS_RATIO} bound. A test docstring says what it pins and why, and the measurement it was "
        "read off goes to docs/benchmarks/forced-alignment/README.md."
    )


def test_the_bench_harness_carries_less_prose_than_its_own_bound(worker: Path) -> None:
    """Rule 9 for the committed bench harness, the PLAN's second cleanup root."""
    prose, code = _root_ratio(worker, HARNESS_ROOT)
    assert code > 5_000, f"the bench harness matched only {code} lines of code; the root has moved"
    assert prose / code <= MAX_HARNESS_RATIO, (
        f"the bench harness is {prose} prose lines to {code} of code ({prose / code:.2f}), over the "
        f"{MAX_HARNESS_RATIO} bound. A harness's argument belongs in the README it measures for."
    )


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

    This is the defect it closes (W7b review r2-correctness-2): three bounds shipped with comments calling
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

    The route is deliberately narrow: only a docstring can be excepted, by `label::qualname`, and only with a
    reason. A comment run has no stable name and so has no route at all — shorten it, or make it a docstring
    and argue for the exception there.
    """
    paths = dict(_root_modules(worker))
    for key, reason in EXCEPTIONS.items():
        label, _, qualname = key.partition("::")
        assert qualname, f"{key} is not a `label::qualname` exception key"
        assert len(reason) > 20, f"{key}'s exception gives no reason: {reason!r}"
        assert label in paths, f"{key} excepts a module that no longer exists"
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
