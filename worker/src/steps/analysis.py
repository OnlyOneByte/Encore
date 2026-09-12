"""Analysis steps: what the song IS, read back off the separated stems.

Its own step because it was invisible. `build_song_profile` used to be called inline from
`demucs.py:491` and `roformer.py:257` through two separate injectable `profiler` parameters, so its cost
was billed to SEPARATING and `/metrics` could not see it at all. Two call sites hand-assembling the same
artifact is also what let `songProfile` ship as a sibling of `stems` where the core read it nested.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from ..analysis import build_song_profile
from ..processor import ProgressEvent
from ..runtime.ctx import Ctx
from ..runtime.runner import run_blocking
from ..runtime.step import Step, StepResult
from ..vocabulary import Stage


class KeyAndRange(Step):
    """Musical key from the INSTRUMENTAL, vocal range from the VOCALS.

    Reads the RAW separated WAVs still sitting in scratch, so this costs no extra separation and no extra
    decode.

    Uses the vocals WAV EVEN WHEN the silence probe measured it silent (and so it was not published). The
    summarizer then finds no voiced frames and returns nulls, which is exactly the "present but empty"
    profile the core needs to see: an ABSENT profile reads as "still processing", so omitting it would strand
    a silent-vocals song forever.

    ALWAYS writes a profile, even on total analysis failure, for the same reason.

    Runs through the keepalive wrapper because it is in-process numpy over minutes of audio, not a
    subprocess: awaiting it inline would freeze the event loop and the core's progress lease would expire
    on a job that is running fine.
    """

    name = "key-and-range"
    stage = Stage.SEPARATING
    reads = frozenset({"job", "stems.raw"})
    writes = frozenset({"stems.song_profile"})

    def __init__(self, profiler: Any = None) -> None:
        self._profiler = profiler or build_song_profile

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        inst = ctx.stems.raw.get("instrumental")
        vox = ctx.stems.raw.get("vocals")
        profile = None
        async for kind, val in run_blocking(
            lambda: self._profiler(inst, vox, ctx.job.media_id), self.stage, 100
        ):
            if kind == "progress":
                yield val
            else:
                profile = val
        ctx.stems.song_profile = profile
