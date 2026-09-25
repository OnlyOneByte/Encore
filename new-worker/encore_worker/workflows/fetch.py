"""The fetch flow: get the bytes, work out what the song IS, report it.

The shortest action, and the only one whose product is METADATA rather than audio. Deliberately linear
like `stems` — there is no fallback ladder, because a failure here is a failure to identify, and the
honest answer to that is "unidentified", not a second guess.

WHY IT MATTERS DISPROPORTIONATELY. `artist` and `track` from this flow are what a later align job hands
to the lyrics provider. A wrong identification produces a confident lookup of the WRONG SONG, whose text
then aligns badly and costs the align flow several retries to reject. So an uncertain annotation must
report itself as uncertain rather than guessing — `Identified.confident` is that distinction, and the
align flow's provider step refuses to look anything up without both fields.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from encore_worker.domain.identity import Identified
from encore_worker.steps.api import NotOurJob
from encore_worker.steps.records import AudioRef, JobRef


class FetchSteps(Protocol):
    """Everything the fetch workflow can do to the world."""

    async def acquire_audio(self, job: JobRef) -> AudioRef: ...

    async def annotate(self, job: JobRef, audio: AudioRef) -> Identified:
        """Identify the song. Returns an empty `Identified` rather than raising when it cannot."""
        ...

    async def publish_original(self, job: JobRef, audio: AudioRef, found: Identified) -> str:
        """Record the audio and what we think it is. Guarded, like every other publish."""
        ...

    async def note(
        self, job: JobRef, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None: ...


@dataclass(frozen=True, slots=True)
class FetchOutcome:
    """How a fetch job ended. `published` is empty only when the lease was lost."""

    published: str
    identified: Identified
    why: str

    @property
    def unidentified(self) -> bool:
        return not self.identified.confident


STATE_ACQUIRE = "acquire"
STATE_ANNOTATE = "annotate"
STATE_PUBLISH = "publish"


async def run_fetch(job: JobRef, steps: FetchSteps) -> FetchOutcome:
    """Run one fetch job to a terminal outcome.

    An UNIDENTIFIED song still publishes. The bytes are on disk and the song is playable; not knowing its
    artist costs it lyrics later, not playability now — and refusing to publish would lose a download
    that succeeded over a metadata lookup that did not.
    """
    audio = await steps.acquire_audio(job)
    await steps.note(job, STATE_ACQUIRE, 0, "acquired", f"{audio.duration_sec:.0f}s audio", None)

    found = await steps.annotate(job, audio)
    await steps.note(
        job,
        STATE_ANNOTATE,
        0,
        "identified" if found.confident else "unidentified",
        _describe(found),
        None,
    )

    try:
        published = await steps.publish_original(job, audio, found)
    except NotOurJob as lost:
        return FetchOutcome(published="", identified=found, why=f"abandoned before publishing: {lost}")
    return FetchOutcome(published=published, identified=found, why=_describe(found))


def _describe(found: Identified) -> str:
    """One line for `job:state`, saying plainly when the song was NOT identified.

    Worded so the two cases are distinguishable at a glance: a later wrong-lyrics report is usually
    traceable to this line, and "artist unknown" is a different investigation from "wrong artist".
    """
    if found.confident:
        return f"{found.artist} — {found.track} (from {found.source})"
    if found.track:
        return f"track {found.track!r} but NO artist, so no lyrics lookup is possible (from {found.source})"
    if found.artist:
        return f"artist {found.artist!r} but NO track, so no lyrics lookup is possible (from {found.source})"
    return "not identified: no artist and no track, so a later align job cannot look up lyrics"
