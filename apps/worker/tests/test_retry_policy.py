"""#443: the retry decision is ONE table, and permanent boundary failures fail fast.

Two guarantees, both red on base (`origin/main`) before the fix:

  * The four boundary failures the issue names — an unknown fetcher / ASR model, no separator engine,
    and an unroutable action (`PlanError`) — are classified NON-retryable through the SAME entry point
    the dial-home loop uses (`dial_home._is_retryable`). On base each missed all four substrings of
    `_is_retryable`'s private heuristic and was retried up to `maxAttempts` (three 45-minute roformer
    passes on a source that can never succeed).
  * `dial_home` no longer keeps a private classification table: it delegates to `retry_policy`, so the
    single source of truth drives the one real caller and the two tables cannot drift again.

The transient-blip default (an UNSTRUCTURED failure is retried) is deliberately preserved — the #443 fix
gives the boundary errors a structured `retryable = False`, it does not flip the heuristic's default.
"""

import ast
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import dial_home as dh  # noqa: E402
from src import retry_policy  # noqa: E402
from src.dial_home import _is_retryable  # noqa: E402
from src.runtime.plan import PlanError  # noqa: E402
from src.separation.demucs import (
    ProcessError,  # noqa: E402
    resolve_demucs_model,  # noqa: E402
)
from src.separation.engines import engine_for  # noqa: E402
from src.separation.roformer import resolve_roformer_slug  # noqa: E402
from src.vocabulary import (  # noqa: E402
    parse_action,
    parse_asr_model,
    parse_backend,
    parse_engine,
    parse_fetcher,
    parse_sync_mode,
)


def _raised(fn):
    with pytest.raises(Exception) as ei:  # noqa: PT011 — we assert the flag, not the type, on purpose
        fn()
    return ei.value


def _plan_error():
    raise PlanError("no plan for action: karaoke")


# ── the four boundary failures the issue tabulates: each must be NON-retryable ──────────────────────
# On base these are RETRYABLE (retryable=True); this parametrized case reds on base for every row.
@pytest.mark.parametrize(
    "make_exc",
    [
        pytest.param(lambda: parse_fetcher("spotify:track"), id="unknown-fetcher"),
        pytest.param(lambda: parse_asr_model("gpt-whisper"), id="unknown-asr-model"),
        pytest.param(lambda: engine_for("ensemble"), id="no-separator-engine"),
        pytest.param(_plan_error, id="plan-error"),
    ],
)
def test_permanent_boundary_failures_are_not_retryable(make_exc):
    # Drive it through _is_retryable — the exact function dial_home._run_job calls before it reports
    # the failure to the core — so this pins the decision the retry loop actually sees.
    exc = _raised(make_exc)
    assert _is_retryable(exc) is False, f"{type(exc).__name__} ({exc}) must be non-retryable"


# Each parse_* coercion is its OWN boundary and its OWN hunk (ValueError → BoundaryError). Pin every
# one so a single reverted parse_* reds exactly its row: on base each raised a bare ValueError whose
# .retryable is None, so _is_retryable fell through to the heuristic and returned True.
@pytest.mark.parametrize(
    "coerce",
    [
        pytest.param(lambda: parse_action("karaoke"), id="parse_action"),
        pytest.param(lambda: parse_fetcher("spotify:track"), id="parse_fetcher"),
        pytest.param(lambda: parse_engine("spleeter"), id="parse_engine"),
        pytest.param(lambda: parse_asr_model("gpt-whisper"), id="parse_asr_model"),
        pytest.param(lambda: parse_sync_mode("interpolate"), id="parse_sync_mode"),
        pytest.param(lambda: parse_backend("cuda-graphs"), id="parse_backend"),
    ],
)
def test_every_boundary_coercion_is_non_retryable(coerce):
    exc = _raised(coerce)
    from src.retry_policy import BoundaryError

    assert isinstance(exc, BoundaryError), f"{type(exc).__name__} should be a BoundaryError"
    assert exc.retryable is False
    assert _is_retryable(exc) is False


def test_boundary_errors_carry_the_structured_flag():
    """Each boundary error carries retryable=False as an attribute — same mechanism ProcessError uses,
    so the decision holds regardless of message wording (a future rename cannot re-strand them)."""
    assert _raised(lambda: parse_fetcher("spotify:x")).retryable is False
    assert _raised(lambda: parse_asr_model("nope")).retryable is False
    assert _raised(lambda: engine_for("ensemble")).retryable is False
    assert PlanError.retryable is False


def test_boundary_errors_stay_backward_compatible_exception_types():
    """The coercions historically raised ValueError / RuntimeError and callers + older tests match on
    those. BoundaryError IS-A ValueError and PermanentError IS-A RuntimeError, so nothing that caught
    the old type stops catching it."""
    assert isinstance(_raised(lambda: parse_fetcher("spotify:x")), ValueError)
    assert isinstance(_raised(lambda: engine_for("ensemble")), RuntimeError)


def test_transient_and_structured_classification_is_preserved():
    """The #443 fix must not change the two behaviours the old table got right."""
    # unstructured transient → retryable (default preserved)
    assert _is_retryable(RuntimeError("temporary network blip")) is True
    # unstructured permanent marker → non-retryable
    assert _is_retryable(RuntimeError("HTTP 404 not found")) is False  # marker on unstructured msg
    assert _is_retryable(RuntimeError("source not found")) is False
    # structured ProcessError flag wins over any message
    assert _is_retryable(ProcessError(["demucs"], 1, "CUDA out of memory")) is True
    assert _is_retryable(ProcessError(["yt-dlp"], 1, "ERROR: Video unavailable")) is False


def test_canonical_table_is_a_superset_of_both_former_tables():
    """The one table never UNDER-classifies relative to either copy it replaces: every marker the old
    dial_home heuristic and the demucs list checked is still present, so no previously-permanent
    failure silently becomes retryable."""
    old_dial_home = ("not found", "404", "unsupported", "corrupt")
    old_demucs = (
        "video unavailable",
        "private video",
        "members-only",
        "removed",
        "404",
        "not found",
        "no such file",
        "unsupported url",
        "is not a valid url",
        "copyright",
    )
    for m in old_dial_home + old_demucs:
        assert retry_policy.permanent_by_message(f"failed: {m}"), f"lost permanent marker {m!r}"


def test_dial_home_keeps_no_private_classification_table():
    """SINGLE SOURCE OF TRUTH guard: dial_home._is_retryable must DELEGATE to retry_policy, not carry
    its own substring list. A source-level check so re-introducing a private table (the exact drift
    #443 removed) reds here even if it happens to agree with retry_policy today.

    Reverting dial_home to its base body (the inline `permanent = (...)` tuple + `any(...)`) reds this.
    """
    src = Path(dh.__file__).read_text()
    tree = ast.parse(src)
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "_is_retryable")
    # It must call retry_policy.is_retryable (imported as is_retryable) …
    calls = [c.func.id for c in ast.walk(fn) if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)]
    assert "is_retryable" in calls, "dial_home._is_retryable must delegate to retry_policy.is_retryable"
    # … and must NOT rebuild a private marker table (no string-tuple / substring loop of its own).
    assert "not found" not in src.split("def _is_retryable")[1].split("def ", 1)[0], (
        "dial_home._is_retryable must not carry its own permanent-marker substrings"
    )


# ── #651: the two SEPARATOR MODEL RESOLVERS are boundary failures too ───────────────────────────────
# An explicit-but-unknown model token is a permanent config error (retrying re-resolves the same bad
# token forever, burning cook attempts). Both resolvers must fail NON-retryable through is_retryable.
# On base, roformer.resolve_roformer_slug raised a bare ValueError (.retryable=None → is_retryable
# defaulted it retryable), so the roformer row REDS on base; the demucs row already routed through
# BoundaryError (#497) and PASSES on base — it is the not-vacuous sentinel that keeps this test honest
# if the anchor for the demucs side ever moves.
@pytest.mark.parametrize(
    "resolve",
    [
        pytest.param(lambda: resolve_roformer_slug({"model": "htdemucs"}), id="roformer-unknown-model"),
        pytest.param(lambda: resolve_demucs_model({"model": "bs-roformer-1297"}), id="demucs-unknown-model"),
    ],
)
def test_unknown_separator_model_is_non_retryable(resolve):
    from src.retry_policy import BoundaryError

    exc = _raised(resolve)
    assert isinstance(exc, ValueError), "must stay a ValueError drop-in for existing pytest.raises"
    assert isinstance(exc, BoundaryError), f"{type(exc).__name__} should be a BoundaryError"
    assert exc.retryable is False
    assert _is_retryable(exc) is False


def test_every_separation_raise_carries_a_structured_retryable():
    """CLOSE THE CLASS (#651): every `raise` in apps/worker/src/separation/*.py must raise an
    exception type that carries a structured `retryable` flag — never a bare Exception/ValueError/
    RuntimeError whose retryability falls to the message heuristic. On base this AST census finds
    exactly one offender, roformer.py's bare `ValueError`, so it REDS on base; after the fix it finds
    none. Using ast.parse means comments and docstrings are dropped by construction, so the prose in
    these files can neither satisfy nor trip the scan (same reasoning #650 recorded).
    """
    sep_dir = Path(retry_policy.__file__).resolve().parent / "separation"

    # Exception TYPES that carry a structured `.retryable` (self-classifying) — the allowlist of
    # constructors a `raise` in this domain may use. Anything else falls through to the heuristic.
    STRUCTURED = {"BoundaryError", "PermanentError", "ProcessError", "ProcessTimeout"}

    def raised_name(node: ast.Raise) -> str | None:
        exc = node.exc
        if exc is None:  # bare `raise` re-raises the active exception — carries whatever it already had
            return None
        call = exc if isinstance(exc, ast.Call) else None
        target = call.func if call is not None else exc
        if isinstance(target, ast.Name):
            return target.id
        if isinstance(target, ast.Attribute):
            return target.attr
        return None

    offenders: list[str] = []
    raise_sites = 0
    for path in sorted(sep_dir.glob("*.py")):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Raise):
                name = raised_name(node)
                if name is None:  # bare re-raise
                    continue
                raise_sites += 1
                if name not in STRUCTURED:
                    offenders.append(f"{path.name}:{node.lineno} raise {name}")

    # Not-vacuous sentinel: the census must actually have SEEN the domain's raise sites, so an empty
    # scan (wrong glob, moved dir) fails loudly instead of passing on nothing. The domain currently has
    # 6 structured raise sites (demucs.py x3, engines.py x1, mlx.py x1, roformer.py x1); #595 replaced
    # MlxDemucsEngine's construction-refusal stub (which raised) with the working demucs-mlx engine, so
    # the count dropped from its earlier value — the floor tracks the true count rather than a stale one.
    assert raise_sites >= 5, f"census saw only {raise_sites} raise sites — scan is not reaching the domain"
    assert offenders == [], f"unstructured raise(s) in src/separation that skip retry_policy: {offenders}"
