"""Handing the finished candidates to the core.

Extracted from `steps/lyrics.py`, which held all six lyrics steps in 1029 lines — 55% of every step
in the worker, where no other step file holds more than four.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

from ...processor import ProgressEvent
from ...runtime.ctx import Ctx
from ...runtime.step import Step, StepResult
from ...vocabulary import Stage


class PublishLyrics(Step):
    """Point the CompleteResult at an artifact and report the resolved engines.

    `uri` is the FIRST candidate, not the best. Ranking lives in exactly one place — pickBestLyrics in
    src/lib/contract/lyrics/lyrics.ts — and the core re-picks from `candidates` on every write and restore.
    A second ranking here would drift silently.
    """

    name = "publish-lyrics"
    stage = Stage.ALIGNING
    reads = frozenset({"job", "engines", "out"})
    writes = frozenset({"out"})

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        lyrics = ctx.out.artifacts.get("lyrics")
        if not lyrics or not lyrics.get("candidates"):
            return
        first = lyrics["candidates"][0]
        uri = os.path.join(ctx.job.media_dir, first["ref"])
        lyrics["uri"] = uri
        ctx.out.media_uri = uri
        # Device is deliberately absent — it belongs to the transcriber/aligner, not here, and a guess
        # would be worse than a null.
        ctx.out.facts["asrModel"] = ctx.engines.asr_model
        ctx.out.facts["syncMode"] = ctx.engines.sync_mode.value
        return
        yield  # pragma: no cover - makes this an async generator
