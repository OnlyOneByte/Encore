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
    """Normalise a `src.`-prefixed absolute name to the package-relative form the matchers expect.

    `src/` imports relatively today, but every file in `tests/` writes the absolute `src.runtime.plan`
    form, so that is the form a developer copies — and it resolves at runtime, so the violation would
    ship working while the three layering matchers (which key off a bare `runtime`/`steps`/`plans`
    segment) stayed blind. Stripping the leading `src.` (and a bare `src`) in the ONE place that records
    import names makes every consumer see the same names for both forms, so `src.runtime.plan` and
    `..runtime.plan` become indistinguishable to the guard — as they must be, since they are the same
    edge."""
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
    # Non-vacuity floor (issue #453): every intended call names a real, populated subtree, so an
    # empty result means SRC is wrong or the tree moved -- which would make the layering scans that
    # iterate this pass while guarding nothing. Fail loudly instead.
    assert files, f"_py_files({rel!r}) found no .py files under {SRC} -- the guard has stopped guarding"
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
    # Non-vacuity floor (issue #453): a broken AST walk finding zero process() classes leaves
    # `unexpected` empty and passes without proving the one-runner rule. There is always at least
    # the PlanRunner; assert we found the canonical implementations.
    assert found, "no class with a process() method found -- the one-runner guard has stopped guarding"
    unexpected = {k: v for k, v in found.items() if k not in allowed}
    assert not unexpected, (
        f"new Processor implementations: {unexpected}. Work belongs in a Step inside a plan, not in a "
        f"class with its own process() — see docs/ARCHITECTURE.md §7.1 (one runner)."
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
        # `_imports` records a dotted module and so misses `from . import acquisition` / `from .. import
        # acquisition`, where the package is an imported NAME not part of the module path — the exact
        # shape a regression module would reach for. Scan the imported names directly to close that gap.
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.level > 0 and not node.module:
                bad.extend(f"from . import {a.name}" for a in node.names if a.name == "acquisition")
        if bad:
            offenders[rel] = bad
    # Non-vacuity floor (issue #453): an empty scan leaves `offenders` empty and passes without
    # inspecting a single import edge.
    assert scanned > 10, (
        f"only {scanned} modules scanned -- the acquisition-caller guard has stopped guarding"
    )
    assert not offenders, (
        f"{sorted(offenders)} re-derive where a job's audio is. Use the AcquireAudio step, or "
        f"AcquireAudio is the single answer -- see the spec §7 E6."
    )


# ── _imports() normalisation: the two forms of the same edge must be indistinguishable ──────────


def test_imports_normalises_the_src_prefixed_form_to_the_relative_one(tmp_path: Path):
    """`src.runtime.plan` and `..runtime.plan` are the SAME cross-layer edge written two ways. Before this
    lock the three matchers below keyed off a bare `runtime`/`steps`/`plans` segment, so a name recorded
    as `src.runtime.plan` slipped past all of them while `runtime.plan` was caught — the exact blindness
    that let a domain take a runtime dependency with the whole suite green. `_imports()` must collapse
    both to the same package-relative name so the matchers cannot tell them apart.
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
            # Shapes 2 & 3 — the dict was mutated as a whole, which is exactly what the §1.2 bug did:
            #   ctx.out.artifacts.update({"<kind>": ..., ...})   (a dict literal argument)
            #   ctx.out.artifacts.setdefault("<kind>", ...)
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


# ── E9b: a step never mutates a domain dataclass attribute in place (#605) ─────────


def test_no_step_mutates_a_published_lyrics_text_attribute_in_place():
    """#605: the step layer must not reach into a domain LyricsText and rewrite a field on the caller's
    object — it publishes copies via dataclasses.replace instead.

    The specific offender this pins: `sel.publish[0].text_confidence = "low"` in GradeAndSelect, which
    assigned an attribute on an object subscripted out of the selection — a cross-layer, in-place mutation
    of a caller-owned domain dataclass. AST, not a substring scan, because "text_confidence" appears all
    over this module in reads and in `replace(..., text_confidence=...)`; only an assignment whose TARGET
    is `<subscript>.attr` is the reaching-in shape.
    """
    steps = Path(__file__).resolve().parents[1] / "src" / "steps" / "lyrics.py"
    tree = ast.parse(steps.read_text(encoding="utf-8"))

    offenders: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            # `x[i].attr = ...` — an attribute write onto a subscripted (indexed) object. That object is a
            # domain LyricsText pulled out of sel.publish/ctx.lyrics.texts; mutating it in place is the
            # cross-layer write. `replace(...)` produces a new value assigned back to the slot instead.
            if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Subscript):
                offenders.append(f"steps/lyrics.py:{target.lineno} assigns .{target.attr} on a subscript")

    assert not offenders, (
        "a step is mutating a domain dataclass attribute in place through a subscript — use "
        "dataclasses.replace and assign the copy back to the list slot instead: " + "; ".join(offenders)
    )


# ── E10: a step reaches blocking work ONLY through run_blocking / run_stage ────────

#: The blocking primitives a Step must never touch directly. Reaching any of these on the event loop
#: freezes it: the worker stops answering the websocket keepalive AND stops emitting job:progress, so
#: the core's 30 s progressLease (apps/core/src/server/jobs/leases.ts) expires and the reaper requeues a
#: HEALTHY cook — runner.py documents both failures as observed on a live cook. The ML stack names come
#: from apps/worker/pyproject.toml's mypy `ignore_missing_imports` overrides (the untyped C-extension
#: dependencies), plus the blocking HTTP/subprocess std-lib surfaces.
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

    Two shapes, both AST — a substring scan passes on the docstrings and comments these very step files
    carry ("in-process numpy", "asyncio.to_thread here emitted NOTHING", "subprocess-with-progress"):

      1. an IMPORT of a blocking ML / network module (torch, whisperx, numpy, requests, urllib, ...).
         Steps delegate that work to a domain function passed to `run_blocking`, so the import belongs in
         `analysis/`, `lyrics/`, `metadata/` — never in `steps/`.
      2. a CALL to a blocking primitive the runtime owns: `asyncio.to_thread(...)` (run_blocking is the
         one legitimate caller, and it lives in runtime/, not here), `subprocess.*` /
         `asyncio.create_subprocess_exec|_shell` (steps shell out through `ctx.runner` / `run_stage`),
         or `os.system(...)`.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: list[str] = []
    for node in ast.walk(tree):
        # ── shape 1: importing a blocking module ──
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name.split(".")[0] in _BLOCKING_IMPORT_ROOTS:
                    out.append(f"line {node.lineno}: import {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module and node.module.split(".")[0] in _BLOCKING_IMPORT_ROOTS:
                out.append(f"line {node.lineno}: from {node.module} import ...")
        # ── shape 2: calling a blocking primitive directly ──
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
    """The lease keepalive only fires if a step ROUTES through `run_blocking` / `run_stage`; nothing
    stopped a new step from calling torch, whisperx or a blocking HTTP client directly, freezing the loop
    and getting its healthy job reaped at the 30 s progress lease (issue #470). This is the repo's
    characteristic failure mode — a mechanism that exists, is tested, and can be silently bypassed — so
    it is ENFORCED, not trusted.

    The two wrappers are the only sanctioned routes and both live in `runtime/runner.py`, not here:
    `run_blocking` runs the in-process ML call in a thread (it owns the single `asyncio.to_thread`) and
    keepalives it; `run_stage` / `ctx.runner` run a subprocess and keepalive it. So a step that reaches a
    blocking primitive directly is exactly the bypass.

    Prove it bites by adding `import torch` (or an `asyncio.to_thread(...)` call) to any step and watching
    this red, then remove it — same recipe the issue prescribes.
    """
    steps = _py_files("steps")
    offenders = {str(p.relative_to(SRC)): bad for p in steps if (bad := _blocking_offenders_in(p))}
    assert not offenders, (
        "a step reaches blocking work directly instead of through run_blocking / run_stage, so its "
        "keepalive never fires and a healthy cook is reaped at the 30 s progress lease "
        "(docs/ARCHITECTURE.md §7.1; issue #470): "
        + "; ".join(f"{rel} -> {found}" for rel, found in sorted(offenders.items()))
    )


def test_the_blocking_bypass_guard_actually_detects_a_direct_call(tmp_path: Path):
    """Non-vacuity floor (the E8 `assert writers` idiom): a matcher that finds nothing because its AST
    shapes are wrong would leave `offenders` empty and pass while guarding nothing. Feed it a synthetic
    step that both imports torch and calls asyncio.to_thread directly, and confirm every intended shape
    is reported — so the guard above fails on a real bypass, not merely on today's clean tree.
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
