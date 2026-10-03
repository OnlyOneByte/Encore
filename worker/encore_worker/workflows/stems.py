"""The stems flow: decode, separate, check, publish. And the fetch flow, which is shorter still.

DELIBERATELY LINEAR, so it reads top to bottom and the `GraphPlan`-shaped machinery align needs is absent on
purpose. The one real decision is `probe_silence`, and the reasons for both — plus why its two refusals
answer `retryable` oppositely — are in docs/arch/05-worker.md §2.4.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from encore_worker.steps.api import NotOurJob, SeparateSteps
from encore_worker.steps.records import AudioRef, JobRef, PublishedStems

STATE_DECODE = "decode"
STATE_SEPARATE = "separate"
STATE_PROBE = "probe-silence"
STATE_PUBLISH = "publish"

#: Peak level below which an instrumental is digital silence rather than a quiet mix. 16-bit silence
#: measures around -91 dBFS; -90 leaves headroom for dither so a legitimately quiet passage is not refused.
SILENCE_FLOOR_DBFS = -90.0


@dataclass(frozen=True, slots=True)
class StemsOutcome:
    """How a stems job ended. `published` is None when nothing was made visible.

    Carries the whole `PublishedStems` record rather than one ref, because core's artifacts envelope has a
    field per stem and a caller reporting only the instrumental leaves the others unrecorded — core would
    then have nothing to serve, evict, or delete for them.
    """

    published: PublishedStems | None
    why: str
    audio: AudioRef | None = None
    #: The `songProfile` artifact, ALWAYS the full wire shape once separation succeeded and never None on a
    #: published outcome, which is a contract rather than tidiness (docs/arch/05-worker.md §3).
    profile: Mapping[str, object] | None = None

    @property
    def refused(self) -> bool:
        return self.published is None


class SilentInstrumental(RuntimeError):
    """The separator produced silence and called it success. NOT retryable (docs/arch/05-worker.md §2.4)."""

    retryable = False


class UnverifiedInstrumental(RuntimeError):
    """The instrumental could not be measured, so it cannot be vouched for.

    A SEPARATE exception from `SilentInstrumental`, and retryable where that one is not: the two are
    different diagnoses leading to different fixes (docs/arch/05-worker.md §2.4).
    """

    retryable = True


async def run_stems(job: JobRef, steps: SeparateSteps) -> StemsOutcome:
    """Run one separation job to a terminal outcome."""
    audio = await steps.acquire_audio(job)
    wav = await steps.decode_to_wav(job, audio)
    separated = await steps.separate(job, wav)

    peak = await steps.probe_silence(job, separated)
    if peak is None:
        # UNMEASURED is not the same as fine. The earlier version of this code returned 0.0 for "could
        # not measure" — the loudest possible reading — so an unverifiable separation published as
        # though it had passed. Refusing here is only reasonable because `host.capabilities` does not
        # advertise `stems` without ffmpeg, so a box reaching this line HAS a probe and it failed.
        raise UnverifiedInstrumental(
            "the instrumental could not be measured, so it cannot be confirmed audible — refusing to "
            "publish an unverified separation"
        )
    if peak <= SILENCE_FLOOR_DBFS:
        # Refused rather than published. A silent instrumental looks like a successful separation and
        # sounds like a broken song, so shipping it moves the failure from this log to a living room.
        raise SilentInstrumental(
            f"instrumental measures {peak:.1f} dBFS, at or below the {SILENCE_FLOOR_DBFS:.0f} dBFS "
            "silence floor — refusing to publish it as ready"
        )

    # Measured BEFORE publication, from the scratch WAVs: publication moves those files into the store and
    # re-encodes them, so this is the last point where the raw separator output still exists. Best-effort by
    # construction — `build_song_profile` cannot raise, and degrades each half to nulls independently, so an
    # unreadable stem costs the key reading but not the vocal range.
    profile = await steps.measure_profile(job, separated)

    try:
        published = await steps.publish_stems(job, separated)
    except NotOurJob as lost:
        return StemsOutcome(
            published=None,
            why=f"abandoned before publishing: {lost}",
            audio=separated,
            profile=profile,
        )
    return StemsOutcome(
        published=published,
        profile=profile,
        why=f"separated at {peak:.1f} dBFS peak",
        audio=separated,
    )
