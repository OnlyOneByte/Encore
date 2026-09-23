"""One decision, one table: is a worker failure worth retrying?

Structured `.retryable` on the exception wins if present; else a message-marker heuristic, defaulting
retryable. See docs/SERVER.md#worker-runtime.
"""

from __future__ import annotations

# Canonical permanent-failure markers: a source or input a retry cannot fix.
PERMANENT_MARKERS: tuple[str, ...] = (
    # source gone / unreachable
    "video unavailable",
    "private video",
    "members-only",
    "removed",
    "404",
    "not found",
    "no such file",
    # source refused / unusable
    "unsupported url",
    "is not a valid url",
    "copyright",
    "unsupported",
    "corrupt",
)


def permanent_by_message(message: str) -> bool:
    """True if the message contains a permanent-failure marker (a retry cannot help)."""
    low = message.lower()
    return any(m in low for m in PERMANENT_MARKERS)


def is_retryable(exc: BaseException) -> bool:
    """The single retry decision, so `dial_home` and any future caller cannot drift apart."""
    structured = getattr(exc, "retryable", None)
    if isinstance(structured, bool):
        return structured
    return not permanent_by_message(str(exc))


class BoundaryError(ValueError):
    """An unknown fetcher/ASR/engine token, caught at the boundary; `ValueError` subclass so existing
    call sites still match, `retryable = False` so it fails fast rather than re-resolving forever."""

    retryable = False


class PermanentError(RuntimeError):
    """A non-`ValueError` boundary failure (e.g. no separator engine registered); `RuntimeError`
    subclass so existing `pytest.raises(RuntimeError, ...)` sites still match."""

    retryable = False
