"""The fetch action's remaining steps: identify the song, and report the bytes.

Acquisition itself is `steps/acquire.py` — shared with stems and align, which is the point of making
`fetch` its own action rather than a stage every consumer repeats.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from ..processor import ProgressEvent
from ..runtime.ctx import Ctx
from ..runtime.runner import run_blocking
from ..runtime.step import Step, StepResult
from ..vocabulary import Stage


class Annotate(Step):
    """Identify the song against MusicBrainz, best-effort.

    Swallows everything: a declined match, an unreachable service or `ENCORE_ANNOTATE=0` all leave
    the title-parser's values standing. A process must never fail over metadata.

    Runs OFF the event loop: the MusicBrainz gate serialises calls and SLEEPS to hold one request per
    second, and a blocking sleep here would stall the whole worker — with concurrency > 1 that means
    another job's progress events stop arriving and the core's progress lease starts expiring.
    """

    name = "annotate"
    stage = Stage.DOWNLOADING
    reads = frozenset({"job", "audio.duration_sec", "audio.youtube_credit"})
    writes = frozenset({"out"})

    def __init__(self, annotator: Any = None) -> None:
        self._annotator = annotator

    def applies(self, ctx: Ctx) -> bool:
        # A local job with no annotator and no YouTube credit has nothing to do.
        return self._annotator is not None or ctx.audio.youtube_credit is not None

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        from ..metadata.annotate import annotate_or_reason

        params = ctx.params
        credit = ctx.audio.youtube_credit

        # YouTube's OWN declared credit is preferred over the title parser and published up front as
        # the floor; MusicBrainz can still upgrade it (adds an MBID). It also becomes the query key,
        # since a bad title-parse would otherwise defeat the lookup.
        if credit:
            ctx.out.artifacts["annotation"] = dict(credit)
            ctx.note(f"identified from YouTube metadata ({credit['artist']} — {credit['title']})")

        if self._annotator is None:
            return

        query_artist = credit["artist"] if credit else params.get("artist")
        query_track = credit["title"] if credit else params.get("track")

        def _call():
            return annotate_or_reason(self._annotator, query_artist, query_track, params.get("durationSec"))

        # run_blocking (not a raw asyncio.to_thread) fires a keepalive ProgressEvent every
        # LEASE_KEEPALIVE_SEC: the MusicBrainz gate's one-request-per-second sleep can hold this
        # thread well past the core's 30s progress lease, and without a keepalive the reaper requeues
        # a healthy process. pct=100 holds the bar in place (acquisition already reached 100).
        got = reason = None
        try:
            async for kind, val in run_blocking(_call, self.stage, 100):
                if kind == "progress":
                    yield val
                else:
                    got, reason = val
        except Exception as exc:  # noqa: BLE001 — annotation is an enrichment; never a job failure
            got, reason = None, f"lookup crashed: {exc}"
        if got is not None:
            # Strictly more informative (carries an MBID), so it overwrites the YouTube floor.
            ctx.out.artifacts["annotation"] = got.as_artifact()
            ctx.note("identified against MusicBrainz")
        elif credit is None:
            # `reason` distinguishes a throttled decline from a healthy "names disagreed" miss.
            ctx.note(f"annotation declined: {reason or 'no reason'}")


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
