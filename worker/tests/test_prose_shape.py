"""The 2026-10-01 directive as a test: a docstring is a few lines of WHAT and WHY; prose lives in `docs/`.

W7b moved ~3 800 prose lines out of a package that measured 48% prose, and left the bound at "no block over
40 lines" — which 101 blocks of 12 lines or more then satisfied, module docstrings of 28–40 lines among them.
W7c replaced that one bound with the shape rules below, so "a few lines" is a number per KIND of prose rather
than per run of it, and the remedy for a failure is always the same: move the narrative to
`docs/arch/04-alignment.md`, `docs/arch/05-worker.md` or the measurement README and cite it by path and `§N`
(`test_docs_pointers.py` checks that the pointer resolves).

Eight rules. Five are shape — module docstring, def docstring, comment run, `#:` attribute comment, and the
bridged BLOCK that catches them in combination — and three are ratio, which is what stops prose the shape
rules allow accumulating module by module and layer by layer.
"""

from __future__ import annotations

import ast
import io
import tokenize
from pathlib import Path

import pytest

#: Lines a MODULE docstring may use: what the module is, what it is for, and where the long story lives.
#: `domain/lyrics/parts.py` held 40 — a mechanism, two anchored rules, a measured refusal, an interpolation
#: policy and an order invariant, all of which is `docs/arch/04-alignment.md` §8 and §12 now. Five modules sit
#: at exactly 12; `TIGHTEST` names one of them.
MAX_MODULE_DOCSTRING = 12

#: Lines a function, method or class docstring may use. Measured at the directive: `align_steps` held a
#: 125-line one. Its longest now is 8 (`docs/arch/04-alignment.md` §4 carries the repair narrative).
MAX_DEF_DOCSTRING = 8

#: Lines a run of own-line `#` comments may use, bridged across blank lines as rule 5 bridges.
#: `host/config.py` held 261 before W7b; two modules sit at exactly 6.
MAX_COMMENT_RUN = 6

#: Lines a `#:` attribute comment may use: what the value means, its unit, and a pointer. NOT its derivation —
#: that is a measurement, and measurements live in `docs/benchmarks/forced-alignment/README.md`.
MAX_ATTRIBUTE_COMMENT = 3

#: Lines a bridged prose BLOCK may use in the package: EXACTLY what rules 1 and 3 allow back to back, which is
#: the worst legal combination, so this is a BACKSTOP rather than a bound anything sits on — the package's
#: longest block is 12 and `test_each_bound_still_names_what_sits_on_it` asserts that headroom rather than
#: pretending it away. What it catches is a THIRD paragraph after those two. Bridged across blank lines.
MAX_BLOCK_LINES = MAX_MODULE_DOCSTRING + MAX_COMMENT_RUN

#: Rule 5's bound for the TESTS and the BENCH HARNESS, which rules 1-4 do not reach. Higher than the package's
#: because a harness script's docstring carries the COMMAND LINES that run it and a test's carries the shapes
#: it pins — both of which belong beside the code. W7b's bound for all three roots was 40, and `TIGHTEST`
#: names `tests/test_align_provenance.py` sitting on this one exactly.
MAX_SCRIPT_BLOCK_LINES = 24

#: Prose lines per line of code, for a module rule 6 reaches. W7b's bound was 1.1; the package measured 0.745
#: when W7c started and 0.489 when it finished. `TIGHTEST` names the module closest to this.
MAX_PROSE_RATIO = 0.55

#: Below this many lines of code the ratio measures the module's INTERFACE rather than its prose — a Protocol
#: or a table of constants is one line of code per declaration — so rule 6 skips the module and rules 1–5 and
#: 7 carry it. The smallest module rule 6 reaches is `domain/audio/vocal_range.py` at 101 lines of code.
RATIO_MIN_CODE = 100

#: Rule 7: the aggregates, which is what holds the modules rule 6 is too coarse for. Both were 1.1 / 0.95 at
#: W7b. The worst layer is `encore_worker/artifacts` at 0.545 and the package is 0.489; the package bound sits
#: below the layer bound because every layer being at its bound would be a different package from this one.
MAX_LAYER_RATIO = 0.55
MAX_PACKAGE_RATIO = 0.52

#: Named exceptions, `"<module>::<qualname>": "the reason"`. EMPTY, and that is the finished state: W7c
#: cleared 271 package violations without granting one, which is the point — an exception is a judgement about
#: a particular docstring, and raising a bound is a judgement about every docstring in the package.
#: `test_every_named_exception_is_still_needed` deletes a stale entry for whoever adds one.
EXCEPTIONS: dict[str, str] = {}

#: The module or layer sitting CLOSEST to each bound, checked by
#: `test_each_bound_still_names_what_sits_on_it` — which also asserts the ONE bound with headroom
#: (`MAX_BLOCK_LINES`) still has it. A comment claiming headroom it does not have is worse than no comment: it
#: sends the next wave to raise the number instead of moving the paragraph, which the directive rules out.
TIGHTEST = {
    "module": "encore_worker/adapters/audiosep.py",
    "def": "encore_worker/adapters/cli.py",
    "comment": "encore_worker/__main__.py",
    "attribute": "encore_worker/adapters/ml.py",
    "script_block": "tests/test_align_provenance.py",
    "ratio": "encore_worker/domain/lyrics/policy.py",
    "layer": "encore_worker/artifacts",
}

#: Every directory of the package holding Python, NESTED ONES INCLUDED — a top-level-only list left
#: `domain/audio` (measured 1.18 at W7b review r1) above the bound and invisible, because its parent
#: `domain/` averaged it away. `test_every_layer_of_the_package_is_listed` walks recursively too, so nothing
#: may leave this tuple and a new directory must join it.
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

#: Rule 5's roots: the package, the PLAN's second cleanup root, and the worker's own tests — an essay is no
#: more checkable in a test file. Rules 1–4 bind on `SHAPE_ROOT` alone; see `test_the_shape_rules_say_where`.
BLOCK_ROOTS = (
    "encore_worker",
    "tests",
    "../docs/benchmarks/forced-alignment/scripts",
)

#: Where rules 1–4 bind. The package is what the 2026-10-01 directive measured and what W7b and W7c swept;
#: `tests/` and the harness are held by rule 5 and by their own aggregate, and carrying the per-kind rules
#: into them is a wave of its own (measured as this one closed: 156 and 83 violations).
SHAPE_ROOT = "encore_worker"

#: The committed bench harness, held to an aggregate of its own rather than to `MAX_PROSE_RATIO` per module: a
#: gate script is a measurement argument with a `main()` attached, so its honest prose share is higher than a
#: library's. 0.35 after the W7b sweep, 0.322 after W7c trimmed its blocks.
HARNESS_ROOT = "../docs/benchmarks/forced-alignment/scripts"
MAX_HARNESS_RATIO = 0.33


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
    """Every module of the package, worker-root-relative and sorted."""
    return sorted(str(path.relative_to(worker)) for path in (worker / "encore_worker").rglob("*.py"))


def _block_root_modules(worker: Path) -> list[tuple[str, Path]]:
    """`(label, path)` for every module rule 5 reads, over all of `BLOCK_ROOTS`."""
    found: list[tuple[str, Path]] = []
    for root in BLOCK_ROOTS:
        base = (worker / root).resolve()
        assert base.is_dir(), f"rule 5's root {root} is not a directory"
        for path in sorted(base.rglob("*.py")):
            found.append((f"{Path(root).name}/{path.relative_to(base)}", path))
    return found


def _shape_violations(worker: Path) -> dict[str, list[tuple[str, str]]]:
    """`{rule: [(module::qualname, how it reads)]}` for rules 1–4 over `SHAPE_ROOT`, exceptions applied."""
    found: dict[str, list[tuple[str, str]]] = {"module": [], "def": [], "comment": [], "attribute": []}
    bounds = {
        "module": MAX_MODULE_DOCSTRING,
        "def": MAX_DEF_DOCSTRING,
        "class": MAX_DEF_DOCSTRING,
        "comment": MAX_COMMENT_RUN,
        "attribute": MAX_ATTRIBUTE_COMMENT,
    }
    for module in _modules(worker):
        source = (worker / module).read_text(encoding="utf-8")
        for kind, qualname, first, length in _docstrings(source):
            rule = "def" if kind == "class" else kind
            key = f"{module}::{qualname}"
            if length > bounds[kind] and key not in EXCEPTIONS:
                found[rule].append((key, f"{module}:{first} ({length} lines, bound {bounds[kind]})"))
        for first, length, rule in _comment_runs(source):
            if length > bounds[rule]:
                found[rule].append((module, f"{module}:{first} ({length} lines, bound {bounds[rule]})"))
    return found


@pytest.fixture(scope="module")
def worker() -> Path:
    return _worker_root()


def test_the_package_has_modules_to_measure(worker: Path) -> None:
    """A glob that silently matched nothing would make every rule below vacuously green."""
    found = _modules(worker)
    assert len(found) > 60, f"expected the whole package, found {len(found)} modules"
    assert "encore_worker/steps/align_steps.py" in found


def test_the_shape_rules_say_where(worker: Path) -> None:
    """Rules 1–4's root is a claim about coverage, so it is asserted rather than left to the constant."""
    assert SHAPE_ROOT in BLOCK_ROOTS, "the shape root must also be read by rule 5"
    counted = _shape_violations(worker)
    read = sum(len(_docstrings((worker / module).read_text(encoding="utf-8"))) for module in _modules(worker))
    assert read > 400, f"rules 1–2 read only {read} docstrings; the shape root has stopped matching"
    assert set(counted) == {"module", "def", "comment", "attribute"}


def test_a_module_docstring_says_what_it_is_and_points_at_the_rest(worker: Path) -> None:
    """Rule 1. A module-level `\"\"\"...\"\"\"` that merely lists a class's fields is dead prose, not an
    exception: delete it, or name the one thing the module is for."""
    over = sorted(where for _, where in _shape_violations(worker)["module"])
    assert not over, (
        f"these module docstrings exceed {MAX_MODULE_DOCSTRING} lines: {over}. A module says what it is, "
        "what it is for, and where the long story lives — see docs/arch/04-alignment.md and 05-worker.md."
    )


def test_a_def_docstring_is_what_and_why_and_nothing_longer(worker: Path) -> None:
    """Rule 2, over every function, method and class of the package."""
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


def _block_bound(label: str) -> int:
    """`MAX_BLOCK_LINES` inside the package, `MAX_SCRIPT_BLOCK_LINES` in the tests and the harness."""
    return MAX_BLOCK_LINES if label.startswith(f"{SHAPE_ROOT}/") else MAX_SCRIPT_BLOCK_LINES


def test_no_prose_block_is_an_essay(worker: Path) -> None:
    """Rule 5, over every module of every root: the combination bound rules 1–4 cannot see."""
    modules = _block_root_modules(worker)
    assert len(modules) > 150, f"rule 5 read only {len(modules)} modules; a root has stopped matching"
    essays: list[str] = []
    for label, path in modules:
        length, first = _longest_block(path.read_text(encoding="utf-8"))
        if length > _block_bound(label):
            essays.append(f"{label}:{first} ({length} lines, bound {_block_bound(label)})")
    assert not essays, (
        f"these carry a prose run over their root's bound: {essays}. Measurement narratives, threshold "
        "derivations, rejected alternatives and failure accounts belong in docs/ with the code citing the "
        "path (see tests/test_docs_pointers.py)."
    )


def test_a_module_with_real_code_carries_half_as_much_prose_as_code(worker: Path) -> None:
    """Rule 6, over every module big enough for the ratio to mean something (`RATIO_MIN_CODE`)."""
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


def test_the_whole_package_carries_half_as_much_prose_as_code(worker: Path) -> None:
    """Rule 7 for the package: the one number the directive was given in."""
    prose = code = 0
    for module in _modules(worker):
        one_prose, one_code = _counts((worker / module).read_text(encoding="utf-8"))
        prose += one_prose
        code += one_code
    assert prose / code <= MAX_PACKAGE_RATIO, (
        f"encore_worker is {prose} prose lines to {code} of code ({prose / code:.2f}), over the "
        f"{MAX_PACKAGE_RATIO} bound. It was 1.21 before W7b, 0.745 before W7c and 0.50 after."
    )


def test_the_bench_harness_carries_less_prose_than_its_own_bound(worker: Path) -> None:
    """The PLAN's second cleanup root, as an aggregate: `MAX_PROSE_RATIO` per module is the wrong instrument
    for a gate script, but "no narrative here either" still has to be checkable."""
    files = sorted((worker / HARNESS_ROOT).resolve().rglob("*.py"))
    assert len(files) > 8, f"the bench harness matched {len(files)} modules; the root has moved"
    prose = code = 0
    for path in files:
        one_prose, one_code = _counts(path.read_text(encoding="utf-8"))
        prose += one_prose
        code += one_code
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
    longest: dict[str, dict[str, float]] = {"module": {}, "def": {}, "comment": {}, "attribute": {}}
    for module in _modules(worker):
        source = (worker / module).read_text(encoding="utf-8")
        for kind, _, _, length in _docstrings(source):
            rule = "def" if kind == "class" else kind
            longest[rule][module] = max(longest[rule].get(module, 0), length)
        for _, length, rule in _comment_runs(source):
            longest[rule][module] = max(longest[rule].get(module, 0), length)
    for rule in longest:
        assert TIGHTEST[rule] in _worst(longest[rule]), (
            f"the longest {rule} prose is no longer in {TIGHTEST[rule]} but in "
            f"{sorted(_worst(longest[rule]))}. Re-point TIGHTEST and that bound's `#:` comment at it."
        )

    blocks: dict[str, dict[str, float]] = {"block": {}, "script_block": {}}
    for label, path in _block_root_modules(worker):
        rule = "block" if label.startswith(f"{SHAPE_ROOT}/") else "script_block"
        blocks[rule][label] = float(_longest_block(path.read_text(encoding="utf-8"))[0])
    assert TIGHTEST["script_block"] in _worst(blocks["script_block"]), (
        f"the longest script block is now in {sorted(_worst(blocks['script_block']))}, not "
        f"{TIGHTEST['script_block']}."
    )
    # Rule 5's PACKAGE bound is the only one with headroom, and the comment on it says so: rules 1-4 bind
    # first, so no module reaches the worst legal combination. Asserted, or that claim could go stale too.
    worst_block = max(blocks["block"].values())
    assert worst_block < MAX_BLOCK_LINES, (
        f"a package block reaches {worst_block:.0f} of {MAX_BLOCK_LINES}: rules 1-4 no longer bind first, "
        "so MAX_BLOCK_LINES' `#:` comment is stale and TIGHTEST owes it an entry."
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

    The route is deliberately narrow: only a docstring can be excepted, by `module::qualname`, and only with a
    reason. A comment run has no stable name and so has no route at all — shorten it, or make it a docstring
    and argue for the exception there.
    """
    for key, reason in EXCEPTIONS.items():
        module, _, qualname = key.partition("::")
        assert qualname, f"{key} is not a `module::qualname` exception key"
        assert len(reason) > 20, f"{key}'s exception gives no reason: {reason!r}"
        path = worker / module
        assert path.is_file(), f"{key} excepts a module that no longer exists"
        lengths = {
            name: length
            for kind, name, _, length in _docstrings(path.read_text(encoding="utf-8"))
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
