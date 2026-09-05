"""The fetch action's remaining steps: identify the song, and report the bytes.

Acquisition itself is `steps/acquire.py` — shared with stems and align, which is the point of making
`fetch` its own action rather than a stage every consumer repeats.
"""
from __future__ import annotations

import asyncio
from typing import Any, AsyncIterator

from ..processor import ProgressEvent
from ..runtime.ctx import Ctx
from ..runtime.step import Step, StepResult
from ..vocabulary import Stage


class Annotate(Step):
    """Identify the song against MusicBrainz, best-effort.

    Swallows everything: a declined match, an unreachable service or `ENCORE_ANNOTATE=0` all leave the
    title-parser's values standing. A cook must never fail over metadata.

    Runs OFF the event loop. The MusicBrainz gate serialises calls and SLEEPS to hold one request per
    second, and a blocking sleep here would stall the whole worker — with concurrency > 1 that means the
    OTHER job's progress events stop arriving and the core's progress lease starts expiring. Waiting on
    metadata must not look like a hung separation.
    """

    name = "annotate"
    stage = Stage.DOWNLOADING
    reads = frozenset({"job", "audio.duration_sec"})
    writes = frozenset({"out"})

    def __init__(self, annotator: Any = None) -> None:
        self._annotator = annotator

    def applies(self, ctx: Ctx) -> bool:
        return self._annotator is not None

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        from ..metadata.annotate import annotate

        params = ctx.params

        def _call():
            return annotate(self._annotator, params.get("artist"), params.get("track"), params.get("durationSec"))

        try:
            got = await asyncio.to_thread(_call)
        except Exception:  # noqa: BLE001 — annotation is an enrichment; never a job failure
            got = None
        if got is not None:
            ctx.out.artifacts["annotation"] = got.as_artifact()
            ctx.note("identified against MusicBrainz")
        return
        yield  # pragma: no cover - makes this an async generator


class PublishOriginal(Step):
    """Report the retained original as this job's artifact.

    The `audio/` storage class is the only one that cannot be regenerated: re-acquiring it needs the
    network, and it is gone permanently once the upload disappears. Which is why acquisition is a job.
    """

    name = "publish-original"
    stage = Stage.DOWNLOADING
    reads = frozenset({"audio.path"})
    writes = frozenset({"out"})

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        path = ctx.audio.path
        if not path:
            raise RuntimeError(f"fetch produced no audio for {ctx.job.media_id}")
        ctx.out.artifacts["source"] = {"audio": path}
        ctx.out.media_uri = path
        return
        yield  # pragma: no cover - makes this an async generator
