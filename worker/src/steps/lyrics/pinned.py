"""The PINNED re-time path: re-running the one candidate an operator chose, under the ref core picked.

Its own module because THREE stages touch it: `acquire` rehydrates the pinned text from disk, `grade`
declines to grade a pinned run, and `align` writes back under the SAME ref so the core's merge
overwrites the rejected doc instead of adding a rival beside it.

Extracted from `steps/lyrics.py`, which held all six lyrics steps in 1029 lines — 55% of every step
in the worker, where no other step file holds more than four.
"""

from __future__ import annotations

import json
import os
from typing import Any

from ...lyrics import (
    SOURCE_MANUAL,
    TIMING_NONE,
    LyricsText,
)
from ...runtime.ctx import Ctx
from ...vocabulary import TextSource


def _pinned_ref(ctx: Ctx) -> str | None:
    """The MediaStore key of a candidate the operator pinned for re-timing, or None.

    REFUSES an absolute path and any key that climbs out of the media directory. This value is joined
    with `ctx.job.media_dir` to both READ a stored doc and WRITE the re-timed one, so an escaping key
    would point the align step at a file outside the store. The core's own `safeMediaPath` rejects the
    same shapes; the worker does not take that on trust, because the worker is the side holding the file
    handle. A refused key is never silently downgraded to a normal process — AcquireTexts STOPs and says so.
    """
    ref = str(ctx.params.get("pinnedRef") or "").strip()
    if not ref or os.path.isabs(ref) or ".." in ref.replace("\\", "/").split("/"):
        return None
    return ref


def _pinned_source_from_ref(ref: str, media_id: str) -> str | None:
    """The `textSource` a stored candidate's own artifact KEY encodes, or None if it does not parse.

    A lyrics doc on disk carries `language`/`lines`/`words` and NOT its provenance, so re-timing an
    already-stored candidate can only recover the tier from the key `candidate_key` built:
    `derived/lyrics/<media>-<source>[-<tag>]-<timing>.json`. Validated against the wire vocabulary, so
    an unrecognised shape DECLINES rather than inventing a tier.
    """
    stem = os.path.splitext(os.path.basename(ref))[0]
    prefix = f"{media_id}-"
    if not stem.startswith(prefix):
        return None
    parts = stem[len(prefix) :].split("-")
    if len(parts) < 2:
        return None
    return parts[0] if parts[0] in {s.value for s in TextSource} else None


def _stored_line_texts(path: str) -> list[str]:
    """The plain line texts of a stored lyrics artifact, in order. Empty when it cannot be read.

    Reads back the shape `TimeTexts` wrote (`lyrics/artifact.py`'s `lines[].text`) and keeps only the
    words: a re-time exists precisely because the stored TIMINGS were wrong for this recording.
    """
    try:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
    except (OSError, ValueError):
        return []
    if not isinstance(doc, dict):
        return []
    out: list[str] = []
    for line in doc.get("lines") or []:
        if isinstance(line, dict) and isinstance(line.get("text"), str) and line["text"].strip():
            out.append(line["text"].strip())
    return out


def _pinned_lyrics_text(ctx: Ctx, ref: str) -> LyricsText | None:
    """The ONE text a pinned align job must time, or None when the pin cannot be honoured.

    Two shapes, one per way an operator re-picks:

      * `pinnedText` — pasted words, used verbatim. The FIRST producer of SOURCE_MANUAL, which
        `grading.py` has held reserved with no producer since the two-tier split.
      * `pinnedRef` alone — re-time the candidate already on disk, keeping its own `textSource`, which
        by then survives only in its artifact key.

    TIMING_NONE either way, deliberately: re-timing is the whole point, so the stored line bounds must
    not become a line-sync fallback that republishes the timings the operator just rejected. The cost is
    real and accepted — `_time_one` drops a text with neither word nor line timings when the aligner
    fails, so a failed re-time publishes nothing and leaves the stored doc untouched, which is the honest
    outcome rather than shipping back the timings that prompted the re-pick.

    `text_confidence` is `high` because a human chose this text; that outranks any scored guess. `role`
    stays ROLE_UNSPECIFIED on purpose — nothing on this path reads it (grading is skipped), and stamping
    a tier here would put a second decider of tiers outside `lyrics/registry.py` (E9).
    """
    pasted = str(ctx.params.get("pinnedText") or "").strip()
    if pasted:
        lines, source = [ln.strip() for ln in pasted.splitlines() if ln.strip()], SOURCE_MANUAL
    else:
        lines = _stored_line_texts(os.path.join(ctx.job.media_dir, ref))
        source = _pinned_source_from_ref(ref, ctx.job.media_id) or SOURCE_MANUAL
    if not lines:
        return None
    segments: list[dict[str, Any]] = [{"text": ln} for ln in lines]
    return LyricsText(text_source=source, segments=segments, timing=TIMING_NONE, text_confidence="high")
