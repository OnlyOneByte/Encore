"""The step surface an align workflow depends on, as one Protocol.

WHY A BUNDLE AND NOT MODULE-LEVEL FUNCTIONS. The workflow takes this as an argument, so the align flow
can be driven end to end by fakes — no DBOS launched, no SQLite, no models, no event loop beyond
asyncio itself. That is what makes the state machine testable as a state machine rather than only as a
deployment.

The real implementation is `steps/dbos_steps.py`, where each method is a `@DBOS.step`. The split is the
same one `ports.py` makes for the heavy seams, one layer up: a Protocol here, the I/O there.

EVERY METHOD IS ASYNC, including the ones that are currently trivial. A step that is sync today and
async tomorrow would otherwise change every call site; and a DBOS coroutine step is what lets the
progress emitter run while a 45-minute separation blocks in a thread.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol

from encore_worker.steps.records import (
    AudioRef,
    JobRef,
    Segment,
    TextRef,
    TimedDoc,
    TimeRequest,
)


class AlignSteps(Protocol):
    """Everything the align workflow can do to the world."""

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        """Get the bytes and measure them. Raises when the source is unreachable or refused.

        This is one of the few genuinely FAILING steps: with no audio there is nothing to align, and no
        fallback can substitute for it.
        """
        ...

    async def fetch_captions(self, job: JobRef, *, automatic: bool) -> TextRef | None:
        """The upload's authored (`automatic=False`) or machine (`automatic=True`) caption track.

        `None` for "no such track", which is the common case and not an error. Never raises for a miss:
        yt-dlp exits non-zero simply because a video has no track of the kind asked for.
        """
        ...

    async def fetch_provider_lyrics(self, job: JobRef, audio: AudioRef) -> TextRef | None:
        """A lyrics sheet by metadata. `None` when the provider has nothing for this song.

        Raising and returning None mean different things: raising is "the provider could not be
        reached", which must be visible, because the old worker had a provider fail for a month and it
        was indistinguishable from a library of instrumentals.
        """
        ...

    async def transcribe(self, job: JobRef, audio: AudioRef, *, on_vocals: bool) -> TextRef | None:
        """Whisper over the stem (`on_vocals=True`) or the mix. `None` when nothing was heard.

        The mandatory fallback tier. `None` here — after it actually ran — is the ONLY evidence that
        justifies concluding a song has no words.
        """
        ...

    async def time_text(self, req: TimeRequest) -> TimedDoc | None:
        """Align one text with one knob set, write the document, and measure the result.

        `None` means this attempt produced nothing publishable at all, which the workflow treats as an
        unusable report rather than an error — the search has other things to try.
        """
        ...

    async def diarize(self, job: JobRef, audio: AudioRef, doc: TimedDoc) -> TimedDoc:
        """Attribute lines to singers. Optional by contract: returns `doc` unchanged on any failure.

        Returns the doc rather than the spans so the workflow has one thing to publish, and so a
        diarizer that could not answer is indistinguishable downstream from a song with one singer.
        """
        ...

    async def publish(self, job: JobRef, doc: TimedDoc | None) -> str:
        """Make the result visible, after re-asserting ownership. Returns the published media uri.

        THE GUARDED STEP. Its first act is to confirm the core still considers this worker the owner of
        this job, because a lease can expire DURING a long alignment — so a workflow that legitimately
        owned its job at reconnect can be reassigned before it reaches here. Raises `NotOurJob` when
        ownership is gone, which the workflow treats as a normal outcome, not a failure.

        `doc=None` publishes the no-lyrics outcome, which still has to be recorded: readiness waits on
        align, so a song that silently published nothing stays in "processing" forever.
        """
        ...

    async def note(
        self,
        job: JobRef,
        state: str,
        attempt: int,
        verdict: str,
        why: str,
        knob: str | None,
    ) -> None:
        """Emit a `job:state` frame. Fire-and-forget: a lost note must never fail a job.

        Deliberately a step rather than a direct socket write. A workflow body must be deterministic and
        performs no I/O, and on a replay these are checkpointed rather than re-sent — so an operator
        reading the trail sees each decision once, not once per recovery.
        """
        ...


class SeparateSteps(Protocol):
    """The separation surface. Declared beside `AlignSteps` because a stems job chains into an align
    job, and the two share `acquire_audio`'s contract."""

    async def acquire_audio(self, job: JobRef) -> AudioRef: ...

    async def decode_to_wav(self, job: JobRef, audio: AudioRef) -> str: ...

    async def separate(self, job: JobRef, input_wav: str) -> AudioRef:
        """Run the engine. Returns the audio with `vocals_path` populated."""
        ...

    async def probe_silence(self, job: JobRef, audio: AudioRef) -> float | None:
        """Peak dBFS of the instrumental, or None when it could not be measured.

        A digitally silent instrumental is refused rather than published: it looks like a successful
        separation and sounds like a broken song. An UNMEASURED one is refused too — see `run_stems`.
        """
        ...

    async def publish_stems(self, job: JobRef, audio: AudioRef) -> str: ...


class NotOurJob(RuntimeError):
    """The core reassigned this job while we were working on it.

    `retryable = False`: retrying would re-run work someone else is already doing or has finished. The
    workflow catches this and completes quietly — it is a normal outcome of a lease expiring under load,
    not an error to escalate.
    """

    retryable = False


def language_of(job: JobRef, text: TextRef | None = None) -> str:
    """The language to align in: the text's own, else the job's, else English.

    The text wins over the job because a provider that told us the language measured it, where the job's
    value is a room-wide default that nobody set per song.
    """
    if text is not None and text.language:
        return text.language
    return job.param_str("language") or "en"


def as_segments(raw: Sequence[Segment]) -> tuple[Segment, ...]:
    """Freeze a port's sequence into the tuple a checkpointed record requires."""
    return tuple(raw)
