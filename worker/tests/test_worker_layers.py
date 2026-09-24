"""Enforcement: the tests that make the architecture stick.

`docs/ARCHITECTURE.md` §7.1 records that this codebase's failure mode is not missing
abstractions but UNENFORCED ones — four verified cases, one of which shipped a near-miss bug. So every
mechanism the refactor introduced gets a test that fails when someone routes around it. Without this file
the refactor is decoration.

  E3  there is exactly one Processor implementation
  E4  STAGE_PLANS agrees with what the plans actually emit
  E6  acquisition has one caller path
  E7  the layering rule holds: dependencies point down only
  E8  one publish shape per artifact kind
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC.parent))

from src import plans as plans_mod  # noqa: E402
from src.runtime.plan import stages_of, validate_plan  # noqa: E402
from src.vocabulary import STAGE_PLANS, Action  # noqa: E402


def _strip_src(name: str) -> str:
    """Normalise a `src.`-prefixed absolute name to the package-relative form the matchers expect,
    so `src.runtime.plan` and `..runtime.plan` (the same cross-layer edge written two ways) become
    indistinguishable to the layering guards below."""
    if name == "src":
        return ""
    if name.startswith("src."):
        return name[len("src.") :]
    return name


def _imports(path: Path) -> set[str]:
    """Every module this file imports, as a dotted name relative to `src` where it is a sibling."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level == 0:
                out.add(_strip_src(node.module or ""))
                continue
            # A relative import: '.' is this package, '..' its parent.
            base = list(path.relative_to(SRC).parts[:-1])
            up = node.level - 1
            base = base[: len(base) - up] if up else base
            out.add(_strip_src(".".join([*base, node.module]) if node.module else ".".join(base)))
        elif isinstance(node, ast.Import):
            for alias in node.names:
                out.add(_strip_src(alias.name))
    return out


def _py_files(*rel: str) -> list[Path]:
    files: list[Path] = []
    for r in rel:
        root = SRC / r
        files.extend(p for p in root.rglob("*.py") if "__pycache__" not in p.parts)
    # Non-vacuity floor: an empty result means SRC is wrong or the tree moved, which would make every
    # layering scan that iterates this pass while guarding nothing.
    assert files, f"_py_files({rel!r}) found no .py files under {SRC} -- the guard has stopped guarding"
    return files


@pytest.mark.parametrize("action", list(Action))
def test_STAGE_PLANS_agrees_with_what_the_plan_actually_emits(action: Action):
    """E4. `STAGE_PLANS` stays hand-written rather than computed because `vocabulary.py` is the wire
    contract and sits below everything — importing the plans there would be a cycle — so agreement is
    enforced here instead, the same way TS/Python vocabulary parity is enforced from the other side.
    """
    plan = plans_mod.PLANS.get(action)
    if plan is None:
        pytest.skip(f"{action.value} has no plan yet")
    assert stages_of(plan) == STAGE_PLANS[action], (
        f"{action.value}: the plan emits {[s.value for s in stages_of(plan)]} but STAGE_PLANS declares "
        f"{[s.value for s in STAGE_PLANS[action]]}. The phone's progress bar reads the table."
    )


def test_every_action_the_core_can_dispatch_HAS_a_plan():
    """A missing plan is a job the worker accepts and then cannot run — which looks like a hung worker."""
    missing = [a.value for a in Action if a not in plans_mod.PLANS]
    assert not missing, f"actions with no plan: {missing}"


@pytest.mark.parametrize("action", list(Action))
def test_every_registered_plan_is_WELL_FORMED(action: Action):
    """E1 applied to the real plans, not toy ones: no step reads a key nothing earlier writes."""
    plan = plans_mod.PLANS.get(action)
    if plan is None:
        pytest.skip(f"{action.value} has no plan yet")
    validate_plan(plan)


def test_there_is_exactly_ONE_thing_that_executes_a_plan():
    """E3. `Processor` is the Protocol that DEFINES the seam; `RoutingProcessor` dispatches by action
    and owns no work; `StubProcessor` is the deliberate no-ML stand-in walking the declared stage plan.
    A new class with its own `process()` is how the worker previously grew processors that each
    reimplemented acquisition, the subprocess wrapper and the keepalive.
    """
    allowed = {"PlanRunner", "Processor", "StubProcessor", "RoutingProcessor"}
    found: dict[str, str] = {}
    for path in _py_files(""):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            methods = {n.name for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
            if "process" in methods:
                found[node.name] = str(path.relative_to(SRC))
    # Non-vacuity floor: a broken AST walk finding zero process() classes would leave `unexpected`
    # empty and pass without proving the one-runner rule.
    assert found, "no class with a process() method found -- the one-runner guard has stopped guarding"
    unexpected = {k: v for k, v in found.items() if k not in allowed}
    assert not unexpected, (
        f"new Processor implementations: {unexpected}. Work belongs in a Step inside a plan, not in a "
        f"class with its own process() — see docs/ARCHITECTURE.md §7.1 (one runner)."
    )


def test_only_acquisition_and_its_step_decide_where_the_bytes_ARE():
    """E6. The regression this must catch is a NEW module reaching into `acquisition` (the package) or
    `acquisition.fetch` (its byte-location primitives) to re-derive where a job's audio lives — the
    import edge is the whole signal, so no specific symbol name is also required. Importing
    `acquisition.stream_quality` (the format-selector constant) is NOT re-deriving byte location, so
    it is deliberately not matched.
    """
    # fetch.py holds the primitives; acquire.py is the one step that uses them; __init__ is the package
    # surface that re-exports them.
    allowed = {"acquisition/fetch.py", "acquisition/__init__.py", "steps/acquire.py"}
    offenders: dict[str, list[str]] = {}
    scanned = 0
    for path in _py_files(""):
        rel = str(path.relative_to(SRC))
        if rel in allowed:
            continue
        scanned += 1
        names = _imports(path)
        bad = [
            n
            for n in names
            if n.endswith("acquisition.fetch") or n == "acquisition" or n.endswith(".acquisition")
        ]
        # `_imports` records a dotted module and so misses `from . import acquisition`, where the
        # package is an imported NAME not part of the module path. Scan names directly to close that gap.
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.level > 0 and not node.module:
                bad.extend(f"from . import {a.name}" for a in node.names if a.name == "acquisition")
        if bad:
            offenders[rel] = bad
    # Non-vacuity floor: an empty scan would leave `offenders` empty and pass without inspecting a single import edge.
    assert scanned > 10, (
        f"only {scanned} modules scanned -- the acquisition-caller guard has stopped guarding"
    )
    assert not offenders, (
        f"{sorted(offenders)} re-derive where a job's audio is. Use the AcquireAudio step, or "
        f"AcquireAudio is the single answer -- see the spec §7 E6."
    )


def test_imports_normalises_the_src_prefixed_form_to_the_relative_one(tmp_path: Path):
    """`src.runtime.plan` and `..runtime.plan` are the SAME cross-layer edge written two ways. The
    matchers below key off a bare `runtime`/`steps`/`plans` segment, so `_imports()` must collapse
    both forms to the same package-relative name or one spelling could slip a domain a runtime
    dependency past every matcher.
    """
    pkg = tmp_path / "src" / "lyrics"
    pkg.mkdir(parents=True)

    absolute = pkg / "with_absolute.py"
    absolute.write_text("from src.runtime.plan import validate_plan\n", encoding="utf-8")

    relative = pkg / "with_relative.py"
    relative.write_text("from ..runtime.plan import validate_plan\n", encoding="utf-8")

    # `_imports` measures against the module SRC; both fixtures share a src-relative shape, so patch the
    # module-level SRC for the read of these two throwaway files only.
    import src as _src_pkg  # noqa: F401  (import guard: the module under test is importable)

    global SRC
    saved = SRC
    try:
        SRC = tmp_path / "src"  # noqa: F811
        got_abs = _imports(absolute)
        got_rel = _imports(relative)
    finally:
        SRC = saved

    assert got_abs == {"runtime.plan"}, (
        f"src.-prefixed absolute import recorded as {got_abs}, not 'runtime.plan'"
    )
    assert got_rel == {"runtime.plan"}, f"..-relative import recorded as {got_rel}, not 'runtime.plan'"
    assert got_abs == got_rel, "the two forms of the same edge must be indistinguishable to the guard"


#: The domain packages, DERIVED from disk rather than listed, so a new domain is guarded the day it
#: appears rather than silently skipped by a stale hardcoded list. `test_worker_packages.py`
#: separately asserts the set on disk equals the set it declares.
DOMAINS = sorted(
    p.name
    for p in SRC.iterdir()
    if p.is_dir()
    and (p / "__init__.py").exists()
    and p.name not in {"runtime", "steps", "host"}
    and not p.name.startswith(("_", "."))
)


@pytest.mark.parametrize("domain", DOMAINS)
def test_a_domain_never_imports_the_runtime_or_a_step(domain: str):
    """E7: dependencies point DOWN only. It is what makes a domain unit-testable with no event loop,
    no fake subprocess and no CompleteResult drain — the moment `lyrics/` imports a Step, testing a
    grading decision needs a plan.
    """
    for path in _py_files(domain):
        bad = sorted(n for n in _imports(path) if n.startswith(("runtime", "steps", "plans", "dial_home")))
        assert not bad, f"{path.relative_to(SRC)} imports {bad} — a domain must not depend on the runtime"


def test_no_domain_imports_another_domain():
    """The domains are siblings, not a hierarchy, and nothing shared may live inside one of them: a
    process-wide lock two domains both need (e.g. one whisperx/whisper/pyannote all take) is a property
    of the process, living in `src/mlrt.py`, not a concern one domain lends to another.
    """
    offenders: list[str] = []
    for domain in DOMAINS:
        for path in _py_files(domain):
            for name in _imports(path):
                top = name.split(".")[0]
                if top in set(DOMAINS) - {domain}:
                    offenders.append(f"{path.relative_to(SRC)} imports {name}")
    assert not offenders, "a domain imports another domain; move the shared thing out of both: " + "; ".join(
        offenders
    )


def test_the_runtime_never_imports_a_domain_or_a_step():
    """The other direction. The runtime executes plans and knows nothing about audio, lyrics or
    separation; `plans.py` is the single seam where the two meet."""
    for path in _py_files("runtime"):
        bad = sorted(n for n in _imports(path) if n.split(".")[0] in {*DOMAINS, "steps", "plans"})
        assert not bad, f"{path.relative_to(SRC)} imports {bad} — the runtime must stay domain-agnostic"


def test_plans_py_is_the_ONLY_module_importing_both_sides():
    """Stated as a test so the seam is a decision rather than an accident."""
    both: list[str] = []
    for path in _py_files(""):
        rel = str(path.relative_to(SRC))
        names = _imports(path)
        # A module's imports of its OWN package are not a crossing: `steps/lyrics/` modules import
        # each other (`align` needs `pinned`), and the rule is about runtime meeting the STEP LAYER in
        # one place, not a step file naming its sibling.
        own = ".".join(path.relative_to(SRC).parts[:-1])
        names = {n for n in names if not (own and (n == own or n.startswith(own + ".")))}
        touches_runtime = any(n.split(".")[0] == "runtime" for n in names)
        touches_steps = any(n.split(".")[0] == "steps" for n in names)
        if touches_runtime and touches_steps:
            both.append(rel)
    assert both == ["plans.py"], f"expected only plans.py to import both runtime and steps, got {both}"


def test_only_ONE_step_writes_each_artifact_kind():
    """E8. One writer per artifact kind means two engines publishing the same kind cannot disagree on
    its shape — a shape mismatch (e.g. songProfile nested wrong) would stall every process at
    "Separating vocals" forever."""
    writers: dict[str, set[str]] = {}

    def _record(kind: object, rel: str) -> None:
        # Only string keys name an artifact kind; a non-constant key is out of AST reach and left to
        # the `assert writers` backstop below.
        if isinstance(kind, str):
            writers.setdefault(kind, set()).add(rel)

    def _is_artifacts(value: ast.expr) -> bool:
        return ast.unparse(value).endswith("out.artifacts")

    for path in _py_files("steps"):
        rel = str(path.relative_to(SRC))
        text = path.read_text(encoding="utf-8")
        tree = ast.parse(text)
        for node in ast.walk(tree):
            # Shape 1 — per-key subscript: ctx.out.artifacts["<kind>"] = ...
            if (
                isinstance(node, ast.Subscript)
                and isinstance(node.slice, ast.Constant)
                and _is_artifacts(node.value)
            ):
                _record(node.slice.value, rel)
                continue
            # Shapes 2 & 3 — the dict mutated as a whole:
            #   ctx.out.artifacts.update({"<kind>":...,...})   (a dict literal argument)
            #   ctx.out.artifacts.setdefault("<kind>",...)
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and _is_artifacts(node.func.value)
            ):
                if node.func.attr == "update" and node.args and isinstance(node.args[0], ast.Dict):
                    for key in node.args[0].keys:
                        if isinstance(key, ast.Constant):
                            _record(key.value, rel)
                elif node.func.attr == "setdefault" and node.args and isinstance(node.args[0], ast.Constant):
                    _record(node.args[0].value, rel)
    multi = {k: sorted(v) for k, v in writers.items() if len(v) > 1}
    assert not multi, f"more than one step writes these artifact kinds: {multi}"
    assert writers, "no artifact writers found — this guard has stopped guarding"


def test_the_pipeline_doc_matches_what_the_plans_actually_declare():
    """E5. The committed region in docs/ARCHITECTURE.md is generated output; this is what makes that
    mean something rather than prose that silently drifts from the real plans. Regenerate with
    `cd worker && python3 -m src.docgen --write`.
    """
    from src.docgen import ARCHITECTURE, BEGIN, END, render

    text = ARCHITECTURE.read_text(encoding="utf-8")
    assert BEGIN in text and END in text, f"the generated markers are missing from {ARCHITECTURE}"
    committed = BEGIN + text.split(BEGIN, 1)[1].split(END, 1)[0] + END
    assert committed.strip() == render().strip(), (
        "docs/ARCHITECTURE.md's generated region is stale — run `python3 -m src.docgen --write` from "
        "worker"
    )


def test_no_lyrics_SOURCE_stamps_its_own_role_or_baseline_rank():
    """E9. The tier a source speaks in belongs to its SourceSpec (`registry.py`), and to nothing else
    — a source quietly returning CANDIDATE would otherwise become eligible to be published as the
    song's words while every test stayed green.

    AST, not a substring scan: the words `role=`/`baseline_rank=` appear in this repo's prose
    constantly, including in this docstring. Scans the WHOLE `src/lyrics` package, not one hardcoded
    file, backed by a non-vacuity floor so the scan cannot silently empty out if the sources move again.
    """
    lyrics_dir = Path(__file__).resolve().parents[1] / "src" / "lyrics"

    offenders: list[str] = []
    constructions = 0
    for path in sorted(lyrics_dir.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            # Only LyricsText(...) construction matters. Assigning to a LyricsText the caller already owns
            # is what the registry itself does, and that is the one place allowed to.
            if not (isinstance(node, ast.Call) and getattr(node.func, "id", None) == "LyricsText"):
                continue
            constructions += 1
            for kw in node.keywords:
                if kw.arg in {"role", "baseline_rank"}:
                    offenders.append(f"{path.name}:{node.lineno} passes {kw.arg}= to LyricsText")

    assert constructions, (
        "no LyricsText(...) construction found under src/lyrics — the tier guard has stopped guarding "
        "(the sources moved and this scan no longer reaches them)"
    )
    assert not offenders, (
        "a lyrics source is deciding its own tier again — that belongs to its SourceSpec in "
        "lyrics/registry.py, which stamps it in _Classified.fetch: " + "; ".join(offenders)
    )


def test_no_step_mutates_a_published_lyrics_text_attribute_in_place():
    """E9b. The step layer must not reach into a domain LyricsText and rewrite a field on the
    caller's object — it publishes copies via dataclasses.replace instead.

    Recognises the reaching-in write by its TARGET: any assignment whose target is `<expr>.<field>`
    where `<field>` is a real LyricsText field name and `<expr>` is NOT a bare `self` (`self.<x> = ...`
    is a step owning its own constructor attribute and is allowed). Field names are read from the
    LyricsText dataclass itself so this cannot drift as fields are added. AST, not a substring scan,
    since these names appear all over the module in reads and in `replace(..., text_confidence=...)`.
    """
    from src.lyrics.grading import LyricsText

    fields = {f.name for f in __import__("dataclasses").fields(LyricsText)}

    def _is_self(expr: ast.expr) -> bool:
        return isinstance(expr, ast.Name) and expr.id == "self"

    offenders: list[str] = []
    for path in _py_files("steps"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            targets: list[ast.expr] = []
            if isinstance(node, ast.Assign):
                targets = list(node.targets)
            elif isinstance(node, (ast.AnnAssign, ast.AugAssign)):
                targets = [node.target]
            for target in targets:
                # `<expr>.<field> = ...` where <field> is a LyricsText field and <expr> is not `self`.
                # `sel.publish[0].text_confidence = ...` (subscript base), `x.text_confidence = ...`
                # (aliased local) and `obj.role = ...` all match; `self.role = ...` does not.
                if isinstance(target, ast.Attribute) and target.attr in fields and not _is_self(target.value):
                    offenders.append(
                        f"{path.name}:{target.lineno} assigns .{target.attr} on a non-self object"
                    )

    assert not offenders, (
        "a step is mutating a domain LyricsText field in place — use dataclasses.replace and assign the "
        "copy back to the list slot (or a local) instead of rewriting a caller-owned object: "
        + "; ".join(offenders)
    )


#: The blocking primitives a Step must never touch directly. Reaching any of these on the event loop
#: freezes it: the worker stops answering the websocket keepalive AND stops emitting job:progress, so
#: the core's 30s progressLease expires and the reaper requeues a HEALTHY process.
_BLOCKING_IMPORT_ROOTS = frozenset(
    {
        "torch",
        "torchaudio",
        "intel_extension_for_pytorch",
        "whisperx",
        "whisper",
        "numpy",
        "requests",
        "httpx",
        "aiohttp",
        "urllib",  # urllib.request is a blocking fetch; matched at the root so .request/.error both count
    }
)


def _blocking_offenders_in(path: Path) -> list[str]:
    """Every place a step module reaches blocking work directly instead of through a wrapper.

    Two shapes, both AST (a substring scan would false-positive on this file's own prose):
      1. an IMPORT of a blocking ML / network module (torch, whisperx, numpy, requests, urllib,...).
         Steps delegate that work to a domain function passed to `run_blocking`, so the import belongs
         in `analysis/`, `lyrics/`, `metadata/` — never in `steps/`.
      2. a CALL to a blocking primitive the runtime owns: `asyncio.to_thread(...)` (run_blocking is the
         one legitimate caller), `subprocess.*`/`asyncio.create_subprocess_exec|_shell` (steps shell
         out through `ctx.runner`/`run_stage`), or `os.system(...)`.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] in _BLOCKING_IMPORT_ROOTS:
                    out.append(f"line {node.lineno}: import {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module and node.module.split(".")[0] in _BLOCKING_IMPORT_ROOTS:
                out.append(f"line {node.lineno}: from {node.module} import ...")
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            attr = node.func.attr
            base = ast.unparse(node.func.value)
            if base == "asyncio" and attr == "to_thread":
                out.append(f"line {node.lineno}: asyncio.to_thread(...) — route through run_blocking")
            elif base == "asyncio" and attr in {"create_subprocess_exec", "create_subprocess_shell"}:
                out.append(f"line {node.lineno}: asyncio.{attr}(...) — shell out through ctx.runner")
            elif base == "subprocess" or base.startswith("subprocess."):
                out.append(f"line {node.lineno}: subprocess.{attr}(...) — shell out through ctx.runner")
            elif base == "os" and attr == "system":
                out.append(f"line {node.lineno}: os.system(...) — shell out through ctx.runner")
    return out


def test_no_step_reaches_blocking_work_outside_run_blocking_or_run_stage():
    """E10. The lease keepalive only fires if a step ROUTES through `run_blocking`/`run_stage` (both
    live in `runtime/runner.py`): `run_blocking` runs the in-process ML call in a thread and keepalives
    it; `run_stage`/`ctx.runner` run a subprocess and keepalive it. A step reaching a blocking
    primitive directly bypasses both keepalives and gets its healthy job reaped at the 30s progress lease.
    """
    steps = _py_files("steps")
    offenders = {str(p.relative_to(SRC)): bad for p in steps if (bad := _blocking_offenders_in(p))}
    assert not offenders, (
        "a step reaches blocking work directly instead of through run_blocking / run_stage, so its "
        "keepalive never fires and a healthy process is reaped at the 30 s progress lease "
        "(docs/ARCHITECTURE.md §7.1): "
        + "; ".join(f"{rel} -> {found}" for rel, found in sorted(offenders.items()))
    )


def test_the_blocking_bypass_guard_actually_detects_a_direct_call(tmp_path: Path):
    """Non-vacuity floor: a matcher whose AST shapes are wrong would leave `offenders` empty and pass
    while guarding nothing. Feed it a synthetic step that imports torch and calls asyncio.to_thread
    directly, and confirm every intended shape is reported.
    """
    fake = tmp_path / "bypass_step.py"
    fake.write_text(
        "import torch\n"
        "import asyncio\n"
        "import subprocess\n"
        "from urllib.request import urlopen\n"
        "\n"
        "async def run(ctx):\n"
        "    asyncio.to_thread(lambda: torch.zeros(1))\n"
        "    subprocess.run(['ffmpeg'])\n"
        "    proc = await asyncio.create_subprocess_exec('yt-dlp')\n",
        encoding="utf-8",
    )
    found = _blocking_offenders_in(fake)
    joined = " | ".join(found)
    assert any("import torch" in f for f in found), f"missed a blocking import: {joined}"
    assert any("from urllib" in f for f in found), f"missed a blocking urllib import: {joined}"
    assert any("to_thread" in f for f in found), f"missed asyncio.to_thread: {joined}"
    assert any("subprocess.run" in f for f in found), f"missed subprocess.run: {joined}"
    assert any("create_subprocess_exec" in f for f in found), f"missed create_subprocess_exec: {joined}"


RUNNER_PY = SRC / "runtime" / "runner.py"


def _run_stage_class_methods(source: str) -> list[str]:
    """Every class in `source` that defines a method named `run_stage`, as `ClassName (line N)`.

    AST, not a source scan: `ast.parse` drops comments and docstrings by construction, so prose lines
    naming `run_stage` can neither satisfy nor trip the check. Only a real `ClassDef` body with a
    `FunctionDef`/`AsyncFunctionDef` named `run_stage` counts.
    """
    tree = ast.parse(source)
    out: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and item.name == "run_stage":
                    out.append(f"{node.name}.run_stage (line {item.lineno})")
    return out


def test_run_stage_is_defined_once_and_only_as_a_free_function():
    """E11. `runtime/runner.py` promises `run_stage` lives there and nowhere else — one implementation
    for every step that shells out. A second, callerless `PlanRunner.run_stage` method would re-open
    the "which run_stage do I call?" ambiguity the file exists to kill (the drift that once
    double-fired a stage's completion event), so no class in `runner.py` may define that method name.
    """
    twins = _run_stage_class_methods(RUNNER_PY.read_text(encoding="utf-8"))
    assert not twins, (
        "run_stage is defined more than once in runner.py — a class defines it as a method alongside the "
        "canonical module-level free function, re-opening the ambiguity runner.py exists to end "
        ": " + "; ".join(twins)
    )


def test_run_stage_class_method_guard_is_not_vacuous():
    """Non-vacuity floor: feed it a synthetic module that DOES define a `run_stage` method on a class
    and confirm the guard reports it. Also confirm a module-level `async def run_stage` and a
    docstring/comment naming `run_stage` are NOT flagged.
    """
    twin = (
        "class Fake:\n"
        "    async def run_stage(self, ctx):\n"
        '        """delegates to the free run_stage"""\n'
        "        yield 1\n"
        "\n"
        "# run_stage lives here and nowhere else\n"
        "async def run_stage(runner, stage):\n"
        "    yield 1\n"
    )
    found = _run_stage_class_methods(twin)
    assert found == ["Fake.run_stage (line 2)"], f"guard mis-detected the method twin: {found!r}"
