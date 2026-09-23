"""Boundary failures classify NON-retryable through dial_home._is_retryable; the unstructured
transient-blip default stays retryable. See docs/SERVER.md#worker-runtime."""

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
    exc = _raised(make_exc)
    assert _is_retryable(exc) is False, f"{type(exc).__name__} ({exc}) must be non-retryable"


# A bare ValueError (.retryable is None) would fall through to the heuristic and could return True.
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
    assert _raised(lambda: parse_fetcher("spotify:x")).retryable is False
    assert _raised(lambda: parse_asr_model("nope")).retryable is False
    assert _raised(lambda: engine_for("ensemble")).retryable is False
    assert PlanError.retryable is False


def test_boundary_errors_stay_backward_compatible_exception_types():
    """BoundaryError IS-A ValueError, PermanentError IS-A RuntimeError, so an old catch still matches."""
    assert isinstance(_raised(lambda: parse_fetcher("spotify:x")), ValueError)
    assert isinstance(_raised(lambda: engine_for("ensemble")), RuntimeError)


def test_transient_and_structured_classification_is_preserved():
    # unstructured transient → retryable (default preserved)
    assert _is_retryable(RuntimeError("temporary network blip")) is True
    # unstructured permanent marker → non-retryable
    assert _is_retryable(RuntimeError("HTTP 404 not found")) is False  # marker on unstructured msg
    assert _is_retryable(RuntimeError("source not found")) is False
    # structured ProcessError flag wins over any message
    assert _is_retryable(ProcessError(["demucs"], 1, "CUDA out of memory")) is True
    assert _is_retryable(ProcessError(["yt-dlp"], 1, "ERROR: Video unavailable")) is False


def test_canonical_table_is_a_superset_of_both_former_tables():
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
    """Source-level check: a reintroduced private table would still pass value comparisons, so this
    must inspect dial_home's actual text, not just today's behaviour."""
    src = Path(dh.__file__).read_text()
    tree = ast.parse(src)
    fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == "_is_retryable")
    calls = [c.func.id for c in ast.walk(fn) if isinstance(c, ast.Call) and isinstance(c.func, ast.Name)]
    assert "is_retryable" in calls, "dial_home._is_retryable must delegate to retry_policy.is_retryable"
    assert "not found" not in src.split("def _is_retryable")[1].split("def ", 1)[0], (
        "dial_home._is_retryable must not carry its own permanent-marker substrings"
    )


# See docs/SERVER.md#worker-runtime: an explicit-but-unknown model token is permanent.
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
    """Every `raise` in src/separation/*.py must use a structured-retryable type. Uses ast.parse so a
    comment or docstring cannot satisfy or trip the scan."""
    sep_dir = Path(retry_policy.__file__).resolve().parent / "separation"

    # Allowlisted constructors; anything else falls through to the message heuristic.
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

    # Not-vacuous sentinel: a wrong glob or moved dir must fail loudly, not pass on an empty scan.
    assert raise_sites >= 5, f"census saw only {raise_sites} raise sites — scan is not reaching the domain"
    assert offenders == [], f"unstructured raise(s) in src/separation that skip retry_policy: {offenders}"
