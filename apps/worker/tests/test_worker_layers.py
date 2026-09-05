"""Enforcement: the tests that make the architecture stick.

`docs/archive/specs/SPEC-worker-pipeline.md` §1.2 established that this codebase's failure mode is not missing
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


def _imports(path: Path) -> set[str]:
    """Every module this file imports, as a dotted name relative to `src` where it is a sibling."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: set[str] = set()
    pkg_depth = len(path.relative_to(SRC).parts) - 1
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level == 0:
                out.add(node.module or "")
                continue
            # A relative import: '.' is this package, '..' its parent.
            base = list(path.relative_to(SRC).parts[:-1])
            up = node.level - 1
            base = base[: len(base) - up] if up else base
            out.add(".".join([*base, node.module]) if node.module else ".".join(base))
        elif isinstance(node, ast.Import):
            for alias in node.names:
                out.add(alias.name)
    return out


def _py_files(*rel: str) -> list[Path]:
    files: list[Path] = []
    for r in rel:
        root = SRC / r
        files.extend(p for p in root.rglob("*.py") if "__pycache__" not in p.parts)
    return files


# ── E4: STAGE_PLANS is not a second description ──────────────────────────────────


@pytest.mark.parametrize("action", list(Action))
def test_STAGE_PLANS_agrees_with_what_the_plan_actually_emits(action: Action):
    """The drift this catches was REAL: the table said align was two stages while the action emitted
    DOWNLOADING three times and covered acquisition, grading and wav2vec2 under one ALIGNING span.

    The table stays hand-written rather than computed because `vocabulary.py` is the wire contract and sits
    below everything — importing the plans there would be a cycle. So it is enforced instead, the same way
    the TS/Python vocabulary parity is enforced from the other side of the wire.
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


# ── E3: one runner ───────────────────────────────────────────────────────────────


def test_there_is_exactly_ONE_thing_that_executes_a_plan():
    """The test that would have caught all four cases in the spec's §1.2.

    A new class with its own `process()` is how the worker grew four processors that each reimplemented
    acquisition, the subprocess wrapper and the keepalive — and how three of them came to bypass the
    function documented as canonical. `EngineRouter` is gone: choosing a separator is
    plan SELECTION now, resolved by `engine_for` before the Separate step runs.
    """
    # `Processor` is the Protocol that DEFINES the seam. `RoutingProcessor` dispatches by action and owns
    # no work. `StubProcessor` is the deliberate no-ML stand-in that walks the declared stage plan.
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
    unexpected = {k: v for k, v in found.items() if k not in allowed}
    assert not unexpected, (
        f"new Processor implementations: {unexpected}. Work belongs in a Step inside a plan, not in a "
        f"class with its own process() — see docs/archive/specs/SPEC-worker-pipeline.md §7 E3."
    )


# ── E6: acquisition has one caller path ──────────────────────────────────────────


def test_only_acquisition_and_its_step_decide_where_the_bytes_ARE():
    """Directly closes §1.2's first case: `resolve_source_audio` was documented as "the one place" and
    three of its four callers re-derived the answer instead — and got it WRONG, downloading to a literal
    `.wav` when yt-dlp needed a `%(ext)s` template.

    The regression this must catch is a NEW module that reaches into `acquisition` (the package) or
    `acquisition.fetch` (its byte-location primitives) to re-derive where a job's audio lives. The guard
    used to AND the import test with `"job_fetcher" in <file text>`, which made it vacuous: that literal
    appears only in the three allowed files, so `offenders` was always empty and the assert could never
    fail — and the very regression it names would import `acquisition` WITHOUT the symbol and sail
    through. The import edge is the whole signal; there is no honest reason to also require a specific
    symbol name. Importing `acquisition.stream_quality` (the format-selector constant, used by
    separation) is NOT re-deriving byte location, so it is deliberately not matched.
    """
    # fetch.py holds the primitives; acquire.py is the one step that uses them; __init__ is the package
    # surface that re-exports them.
    allowed = {"acquisition/fetch.py", "acquisition/__init__.py", "steps/acquire.py"}
    offenders: dict[str, list[str]] = {}
    for path in _py_files(""):
        rel = str(path.relative_to(SRC))
        if rel in allowed:
            continue
        names = _imports(path)
        bad = [n for n in names if n.endswith("acquisition.fetch") or n == "acquisition" or n.endswith(".acquisition")]
        # `_imports` records a dotted module and so misses `from . import acquisition` / `from .. import
        # acquisition`, where the package is an imported NAME not part of the module path — the exact
        # shape a regression module would reach for. Scan the imported names directly to close that gap.
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.level > 0 and not node.module:
                bad.extend(f"from . import {a.name}" for a in node.names if a.name == "acquisition")
        if bad:
            offenders[rel] = bad
    assert not offenders, (
        f"{sorted(offenders)} re-derive where a job's audio is. Use the AcquireAudio step, or "
        f"AcquireAudio is the single answer -- see the spec §7 E6."
    )


# ── E7: the layering rule ────────────────────────────────────────────────────────

DOMAINS = ["lyrics", "separation", "analysis", "acquisition", "metadata"]


@pytest.mark.parametrize("domain", DOMAINS)
def test_a_domain_never_imports_the_runtime_or_a_step(domain: str):
    """The spec's §3 has exactly one rule — dependencies point DOWN only — and this is it.

    It is what makes a domain unit-testable with no event loop, no fake subprocess and no CompleteResult
    drain. The moment `lyrics/` imports a Step, testing a grading decision needs a plan.
    """
    for path in _py_files(domain):
        bad = sorted(n for n in _imports(path) if n.startswith(("runtime", "steps", "plans", "dial_home")))
        assert not bad, f"{path.relative_to(SRC)} imports {bad} — a domain must not depend on the runtime"


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
        touches_runtime = any(n.split(".")[0] == "runtime" for n in names)
        touches_steps = any(n.split(".")[0] == "steps" for n in names)
        if touches_runtime and touches_steps:
            both.append(rel)
    assert both == ["plans.py"], f"expected only plans.py to import both runtime and steps, got {both}"


# ── E8: one publish shape per artifact kind ──────────────────────────────────────


def test_only_ONE_step_writes_each_artifact_kind():
    """The case in §1.2 that already cost a bug. `demucs.py` and `roformer.py` each hand-assembled
    `artifacts={"stems": ..., "songProfile": ...}`, and one of them put songProfile in the wrong place —
    a shape mismatch that would have stalled every cook at "Separating vocals" forever, caught only by a
    parity guard added afterwards. One writer per kind means the two engines cannot disagree."""
    writers: dict[str, set[str]] = {}
    for path in _py_files("steps"):
        text = path.read_text(encoding="utf-8")
        tree = ast.parse(text)
        for node in ast.walk(tree):
            # ctx.out.artifacts["<kind>"] = ...
            if not isinstance(node, ast.Subscript) or not isinstance(node.slice, ast.Constant):
                continue
            if ast.unparse(node.value).endswith("out.artifacts") and isinstance(node.slice.value, str):
                writers.setdefault(node.slice.value, set()).add(str(path.relative_to(SRC)))
    multi = {k: sorted(v) for k, v in writers.items() if len(v) > 1}
    assert not multi, f"more than one step writes these artifact kinds: {multi}"
    assert writers, "no artifact writers found — this guard has stopped guarding"


# ── E5: the generated doc cannot drift ───────────────────────────────────────────


def test_the_pipeline_doc_matches_what_the_plans_actually_declare():
    """The committed region in docs/ARCHITECTURE.md is generated output, and this is what makes that mean
    something. Regenerate with `cd apps/worker && python3 -m src.docgen --write`.

    Enforced rather than trusted because this repo's architecture prose has twice described a worker it did
    not have: `fetch.py` named a function as "the one place" three of its four callers bypassed, and
    STAGE_PLANS declared two stages for an action with eight steps.
    """
    from src.docgen import ARCHITECTURE, BEGIN, END, render

    text = ARCHITECTURE.read_text(encoding="utf-8")
    assert BEGIN in text and END in text, f"the generated markers are missing from {ARCHITECTURE}"
    committed = BEGIN + text.split(BEGIN, 1)[1].split(END, 1)[0] + END
    assert committed.strip() == render().strip(), (
        "docs/ARCHITECTURE.md's generated region is stale — run `python3 -m src.docgen --write` from "
        "apps/worker"
    )


# ── E9: the registry is the ONLY place a source's tier is decided ─────────────────


def test_no_lyrics_SOURCE_stamps_its_own_role_or_baseline_rank():
    """The tier a source speaks in belongs to its SourceSpec, and to nothing else.

    Before this, `chain.py`'s four sources each set `role=` (and AsrSource re-derived `baseline_rank=` from
    its audio argument) on the text they returned, while `registry.py` declared the same two facts in SPECS
    — read by nothing but the registry's own self-consistency tests. Two copies, no reader, no way to
    notice a disagreement: a source quietly returning CANDIDATE would become eligible to be published as
    the song's words while every test stayed green.

    AST, not a substring scan, because the words appear in this repo's prose constantly — the docstring
    above says `role=` twice. The np.correlate guard learned this the same way: a text search over source
    passes on a comment that says the right thing while the code does the wrong one.
    """
    chain = Path(__file__).resolve().parents[1] / "src" / "lyrics" / "chain.py"
    tree = ast.parse(chain.read_text(encoding="utf-8"))

    offenders: list[str] = []
    for node in ast.walk(tree):
        # Only LyricsText(...) construction matters. Assigning to a LyricsText the caller already owns is
        # what the registry itself does, and that is the one place allowed to.
        if not (isinstance(node, ast.Call) and getattr(node.func, "id", None) == "LyricsText"):
            continue
        for kw in node.keywords:
            if kw.arg in {"role", "baseline_rank"}:
                offenders.append(f"chain.py:{node.lineno} passes {kw.arg}= to LyricsText")

    assert not offenders, (
        "a lyrics source is deciding its own tier again — that belongs to its SourceSpec in "
        "lyrics/registry.py, which stamps it in _Classified.fetch: " + "; ".join(offenders)
    )
