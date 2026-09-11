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

    Swallows everything: a declined match, an unreachable service or `ENCORE_ANNOTATE=0` all leave the
    title-parser's values standing. A cook must never fail over metadata.

    Runs OFF the event loop. The MusicBrainz gate serialises calls and SLEEPS to hold one request per
    second, and a blocking sleep here would stall the whole worker — with concurrency > 1 that means the
    OTHER job's progress events stop arriving and the core's progress lease starts expiring. Waiting on
    metadata must not look like a hung separation.
    """

    name = "annotate"
    stage = Stage.DOWNLOADING
    reads = frozenset({"job", "audio.duration_sec", "audio.youtube_credit"})
    writes = frozenset({"out"})

    def __init__(self, annotator: Any = None) -> None:
        self._annotator = annotator

    def applies(self, ctx: Ctx) -> bool:
        # Runs whenever there is a YouTube credit to publish, OR an annotator to query. A local job with
        # no annotator and no credit has nothing to do.
        return self._annotator is not None or ctx.audio.youtube_credit is not None

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        from ..metadata.annotate import annotate_or_reason

        params = ctx.params
        credit = ctx.audio.youtube_credit

        # YouTube's OWN declared credit is a citation, so it is PREFERRED over the title parser and
        # published up front. MusicBrainz can still upgrade it — a match adds an MBID and
        # duration corroboration — so it is not the end of the story, just the floor. When present it
        # also becomes the MusicBrainz QUERY KEY: the bad-title-parse that used to defeat the lookup
        # ("No Vocal", "American Idol 2024") is exactly what the citation replaces, so querying with the
        # citation is what lets MusicBrainz find the song at all.
        if credit:
            ctx.out.artifacts["annotation"] = dict(credit)
            ctx.note(f"identified from YouTube metadata ({credit['artist']} — {credit['title']})")

        if self._annotator is None:
            return

        query_artist = credit["artist"] if credit else params.get("artist")
        query_track = credit["title"] if credit else params.get("track")

        def _call():
            return annotate_or_reason(self._annotator, query_artist, query_track, params.get("durationSec"))

        # Run the lookup through run_blocking, exactly as the sibling blocking steps do (lyrics AcquireTexts,
        # analysis SongProfile). A raw asyncio.to_thread here emitted NOTHING for the whole MusicBrainz wait,
        # and that wait can be long: the gate serialises calls and SLEEPS to hold one request per second, so a
        # throttled/slow service holds this thread well past the core's 30 s progress lease — the ONLY emitter
        # of job:progress during the wait is gone, the reaper requeues a healthy cook
        # (progress-lease-expired),
        # and each retry is a full re-acquire. run_blocking yields a keepalive ProgressEvent every
        # LEASE_KEEPALIVE_SEC so the lease is renewed. pct=100 matches analysis: acquisition has
        # already reached
        # 100 by the time Annotate runs, so the keepalive holds the bar rather than moving it backward.
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
            # A MusicBrainz match is strictly more informative (it carries an MBID) so it overwrites the
            # YouTube floor. The core's applyAnnotation never-regress rule protects a prior high citation
            # regardless of which source wrote it.
            ctx.out.artifacts["annotation"] = got.as_artifact()
            ctx.note("identified against MusicBrainz")
        elif credit is None:
            # The decline used to be SILENT on every path — a throttled box declines every annotation
            # indefinitely (ENCORE_ANNOTATE is on by default, so this runs on every fetch) and an
            # operator had no way to tell that from a healthy "nothing agreed on the names" miss. The
            # reason distinguishes them, carrying the rate gate's counters when it was a throttle. When a
            # YouTube credit already stands, the MusicBrainz decline is expected enrichment, not a gap.
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
