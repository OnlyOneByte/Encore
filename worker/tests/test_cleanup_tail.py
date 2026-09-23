"""Mutation-provable pins for several small worker invariants:

  * resolve_engines parses `engine` at the boundary (unknown -> BoundaryError), like asrModel/syncMode
  * heartbeat_loop wraps its body so a send on a half-closed socket does not end as an unretrieved exc
  * no module-level CONFIG snapshots; WorkerClient resolves worker_id/concurrency/media_dir/version/caps
      from CONFIG on __init__ (config read ON CALL, not captured at import)
  * DecodeToWav / PublishStems raise a NAMED error on a missing key instead of `or ""` -> opaque ffmpeg
  * the worker service carries `init: true` (PID-1 zombie reaping) in all three compose files
"""

from __future__ import annotations

import ast
import sys
from collections.abc import AsyncIterator
from pathlib import Path

import pytest


def _repo_root() -> Path:
    """The repo root, by walking up for `bunfig.toml` — the same marker file the TypeScript harness
    uses, so both sides of the repo agree on the answer by construction rather than a hop count.
    """
    here = Path(__file__).resolve()
    for candidate in [here.parent, *here.parents]:
        if (candidate / "bunfig.toml").is_file():
            return candidate
    raise SystemExit(f"no bunfig.toml above {here}")


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
REPO_ROOT = _repo_root()

from src.processor import JobSpec  # noqa: E402
from src.retry_policy import BoundaryError  # noqa: E402
from src.runtime import Ctx  # noqa: E402
from src.runtime.ctx import ResolvedEngines  # noqa: E402
from src.steps.separate import DecodeToWav, PublishStems  # noqa: E402


def test_resolve_engines_raises_on_an_unknown_engine_at_the_boundary():
    """`engine` must be parsed at the same boundary as asrModel/syncMode, so a de-whitelisted value
    RAISES a BoundaryError here rather than carrying silently through to fail later at engine_for
    with a different exception type."""
    from src.plans import resolve_engines

    with pytest.raises(BoundaryError, match="unknown engine 'spleeter'"):
        resolve_engines({"engine": "spleeter"}, ResolvedEngines())


def test_resolve_engines_still_accepts_the_known_engines_and_the_default():
    from src.plans import resolve_engines

    assert resolve_engines({"engine": "roformer"}, ResolvedEngines()).separator == "roformer"
    assert resolve_engines({"engine": "demucs"}, ResolvedEngines()).separator == "demucs"
    # absent -> the worker's configured default (demucs), unchanged from before
    assert resolve_engines({}, ResolvedEngines()).separator == "demucs"


def test_resolve_engines_docstring_no_longer_claims_a_false_fallback():
    """The docstring must not claim an unknown value "falls back rather than failing the job" —
    parse_asr_model always RAISES."""
    from src.plans import resolve_engines

    doc = resolve_engines.__doc__ or ""
    assert "falls back rather than failing the job" not in doc
    assert "RAISES" in doc


def _func_ast(module_path: Path, func_name: str) -> ast.AST:
    tree = ast.parse(module_path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == func_name:
            return node
    raise AssertionError(f"{func_name} not found in {module_path}")


def test_heartbeat_loop_wraps_its_body_in_a_try_that_contains_a_send_failure():
    """Source-level guard: heartbeat_loop's `while` body must contain a Try that (a) calls
    self.send_heartbeat() inside its `try`, and (b) has an except handler catching Exception. A
    behavioural test cannot see the difference if this is missing — the unretrieved-exception warning
    only surfaces at GC."""
    dial = ROOT / "src" / "dial_home.py"
    fn = _func_ast(dial, "heartbeat_loop")

    tries = [n for n in ast.walk(fn) if isinstance(n, ast.Try)]
    assert tries, "heartbeat_loop has no try/except — a send on a half-closed socket ends the task uncaught"

    def _calls_send_heartbeat(nodes) -> bool:
        return any(
            isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute) and c.func.attr == "send_heartbeat"
            for n in nodes
            for c in ast.walk(n)
        )

    def _catches_exception(handlers) -> bool:
        for h in handlers:
            t = h.type
            if t is None:
                return True
            if isinstance(t, ast.Name) and t.id == "Exception":
                return True
        return False

    assert any(_calls_send_heartbeat(t.body) and _catches_exception(t.handlers) for t in tries), (
        "the send_heartbeat call must sit inside a try whose except catches Exception"
    )


def test_dial_home_has_no_dead_config_snapshot_globals():
    """The five module globals (WORKER_ID/CONCURRENCY/CAPABILITIES/MEDIA_DIR/VERSION) must not exist
    as module-level assignments: capturing CONFIG at import contradicts the "config read ON CALL"
    rule, and would freeze CAPABILITIES to [] since default caps are () until config.resolve() fills
    a NEW object."""
    dial = ROOT / "src" / "dial_home.py"
    tree = ast.parse(dial.read_text())
    dead = {"WORKER_ID", "CONCURRENCY", "CAPABILITIES", "MEDIA_DIR", "VERSION"}
    assigned_at_module_level = set()
    for node in tree.body:  # module level only, not nested
        if isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name):
                    assigned_at_module_level.add(tgt.id)
    leaked = dead & assigned_at_module_level
    assert not leaked, f"dead import-time CONFIG snapshots still present: {sorted(leaked)}"


def test_worker_client_resolves_config_on_call_when_kwargs_omitted():
    """A client built with no id/concurrency/media_dir/version/caps kwargs must pick up CONFIG's live
    values, read in __init__, not a stale import snapshot."""
    from src import dial_home
    from src.dial_home import WorkerClient

    async def _send(_m):  # pragma: no cover - never called
        pass

    class _P:
        pass

    client = WorkerClient(_send, _P())
    assert client.state.worker_id == dial_home.CONFIG.worker_id
    assert client.state.concurrency == dial_home.CONFIG.concurrency
    assert client._media_dir == dial_home.CONFIG.media_dir
    assert client._version == dial_home.CONFIG.version
    assert client.state.capabilities == list(dial_home.CONFIG.capabilities)


def _ctx(job_params=None, audio_path=None):
    async def runner(argv) -> AsyncIterator[str]:  # pragma: no cover - not reached when we raise first
        return
        yield ""

    job = JobSpec(
        job_id="j1",
        media_id="m1",
        job_type="stems",
        source_uri="u",
        params=job_params or {},
        media_dir="/tmp",
    )
    ctx = Ctx(job=job, work="/tmp/work-538", runner=runner)
    if audio_path is not None:
        ctx.audio.path = audio_path
    return ctx


async def test_decode_to_wav_raises_named_error_when_audio_path_is_empty():
    """An empty `ctx.audio.path` must raise a named error rather than handing ffmpeg an empty input
    (which dies as the opaque "ffmpeg: : No such file or directory")."""
    ctx = _ctx(audio_path="")  # empty, as if AcquireAudio never ran

    class _Eng:
        def input_wav(self, work):
            return "/tmp/work-538/input.wav"

    with pytest.raises(RuntimeError, match="audio.path is empty"):
        async for _ in DecodeToWav(engine=_Eng()).run(ctx):
            pass


async def test_publish_stems_raises_named_error_when_instrumental_is_missing():
    """A missing instrumental must raise a named error before any ffmpeg call, rather than encoding
    an empty path."""
    ctx = _ctx()
    ctx.stems.raw = {}  # no instrumental — Separate would have raised, but pin the guard anyway
    with pytest.raises(RuntimeError, match="instrumental.* is missing"):
        async for _ in PublishStems().run(ctx):
            pass


@pytest.mark.parametrize(
    "rel",
    [
        "docker-compose.yml",
        "docs/deploy/docker-compose.cuda.yml",
        "docs/deploy/docker-compose.intel.yml",
    ],
)
def test_worker_service_has_init_true_for_pid1_reaping(rel):
    """The worker runs python as PID 1 with no reaper; `init: true` interposes tini so demucs/ffmpeg
    grandchildren are reaped. Assert the token is present under the worker service in each compose file."""
    import re

    text = (REPO_ROOT / rel).read_text()
    assert "worker:" in text, f"{rel} has no worker service"
    # Match `init: true` as an actual YAML DIRECTIVE (a line that is only indentation + the key),
    # NOT the token wherever it appears — the explanatory comment above the directive also contains
    # the literal `init: true` in backticks, so a substring check would pass even with the directive
    # deleted (a mutation-blind guard). This regex reds the moment the real key is removed.
    assert re.search(r"(?m)^[ \t]+init:[ \t]+true[ \t]*$", text), (
        f"{rel} worker service is missing the `init: true` directive (PID-1 reaping)"
    )
