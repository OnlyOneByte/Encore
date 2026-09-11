"""One decision, one table: is a worker failure worth retrying?

The core retries a `job:failed` while `attempts < maxAttempts` (default 3, `schema.ts:279`), so the
`retryable` flag the worker sends on `job:failed` is what decides whether a failure costs the room
three attempts or fails fast. Getting it wrong is expensive: on roformer, three attempts is three
45-minute passes on a source that can never succeed.

Before this module the decision lived in TWO divergent copies:

  * `dial_home._is_retryable` had a four-substring heuristic (`"not found"`, `"404"`, `"unsupported"`,
    `"corrupt"`) and defaulted everything else to retryable. Four *permanent boundary* failures —
    `parse_fetcher` / `parse_asr_model` on an unknown token, `engines` on an unknown separator, and
    `PlanError` on an unroutable action — miss all four substrings and were retried forever.
  * `separation/demucs.classify_retryable` had a ten-marker download-domain list. Neither guarded the
    other, and they disagreed (`demucs` had `"copyright"`/`"private video"`; `dial_home` had `"corrupt"`).

This module is now the ONE place the decision is made. Two rules, in order:

  1. STRUCTURED FLAG WINS. An exception may carry a `.retryable: bool` it computed itself — `ProcessError`
     classifies a CLI's stderr, `ProcessTimeout` is always retryable, and the boundary errors below are
     always non-retryable. If it is there, it is authoritative and no string is inspected.
  2. Otherwise fall back to the message heuristic: a message containing a `PERMANENT_MARKER` is permanent
     (non-retryable); anything else is treated as a transient blip and retried. The default-retryable
     here is deliberate — an *unstructured* RuntimeError (a network hiccup, a transient decode glitch)
     usually IS worth one more attempt. The fix is not to flip this default; it is to give the four
     boundary failures a structured `retryable = False` so they never reach the heuristic at all.

`separation/demucs.py` still owns its own `classify_retryable`; wiring it onto `PERMANENT_MARKERS` here
is the deferred Part 2/3 of this change (split out because concurrent stems work owns that file — land
it once that work has merged).
"""

from __future__ import annotations

# The canonical permanent-failure marker table. A message containing any of these describes a source
# or input that a retry cannot fix (gone, private, malformed, unsupported), so the failure is permanent.
# This is the UNION of what the two former copies checked, deduplicated and ordered source→format:
# a superset never *under*-classifies relative to either old table, so no failure that was permanent
# before becomes retryable now.
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
    """The single retry decision for a worker failure.

    A structured `.retryable: bool` on the exception is authoritative (see rule 1 above); otherwise
    an *unstructured* exception falls back to the message heuristic (rule 2). This is the only place
    the decision is made, so `dial_home` and any future caller cannot drift apart.
    """
    structured = getattr(exc, "retryable", None)
    if isinstance(structured, bool):
        return structured
    return not permanent_by_message(str(exc))


class BoundaryError(ValueError):
    """A job asked for something this worker cannot honour — an unknown fetcher, ASR model, engine, or
    other enumerated token — detected at the BOUNDARY, before any download or ML work starts.

    Subclasses `ValueError` on purpose: the boundary coercions historically raised a plain `ValueError`
    and callers/tests match on it, so this stays a drop-in. What it adds is the structured
    `retryable = False` — a token this worker does not implement is permanent, so `is_retryable` fails
    it fast instead of spending three attempts (up to three 45-minute roformer passes) rediscovering
    the same unknown token.
    """

    retryable = False


class PermanentError(RuntimeError):
    """A permanent, non-`ValueError` failure detected at the boundary — e.g. no separator engine is
    registered for a requested name. Carries `retryable = False` so `is_retryable` fails it fast.

    Kept a `RuntimeError` subclass so existing `pytest.raises(RuntimeError, ...)` call sites still match.
    """

    retryable = False
