"""The step surface an align workflow depends on, as one Protocol.

A bundle rather than module-level functions because the workflow takes it as an ARGUMENT, so the align flow
is drivable end to end by fakes with no DBOS, no SQLite and no models. Every method is async even where it is
trivial today, so a step that gains I/O changes no call site. See docs/arch/05-worker.md §1.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Protocol

from encore_worker.artifacts import keys
from encore_worker.host.config import ASR_MODELS
from encore_worker.protocol.vocabulary import SyncMode
from encore_worker.steps.records import (
    AudioRef,
    JobRef,
    PublishedStems,
    Refused,
    Segment,
    TextRef,
    TimedDoc,
    TimeRequest,
)


class AlignSteps(Protocol):
    """Everything the align workflow can do to the world."""

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        """Get the bytes and measure them. Raises when the source is unreachable or refused — one of the few
        genuinely FAILING steps, no fallback being able to substitute for audio."""
        ...

    async def fetch_captions(self, job: JobRef, *, automatic: bool) -> TextRef | None:
        """The upload's authored (`automatic=False`) or machine (`automatic=True`) caption track. `None` for
        "no such track", which is the common case and not an error."""
        ...

    async def fetch_provider_lyrics(self, job: JobRef, audio: AudioRef) -> list[TextRef]:
        """A lyrics sheet by metadata from EVERY provider that has one. Empty when none has this song.

        The plural is the point: two sources agreeing is the text side's strongest free signal. Raising and
        returning empty mean different things, a provider dead for a month otherwise reading as a library of
        instrumentals.
        """
        ...

    async def fetch_pinned_text(self, job: JobRef) -> TextRef | None:
        """The ONE text a pinned job re-times (`pin_of`): the paste, or the stored candidate's words.

        `None` when the pin cannot be honoured, which the workflow answers by publishing nothing rather than
        re-picking behind the person who chose it.
        """
        ...

    async def transcribe(self, job: JobRef, audio: AudioRef, *, on_vocals: bool) -> TextRef | None:
        """Whisper over the stem (`on_vocals=True`) or the mix. `None` when nothing was heard, which — after
        it actually ran — is the ONLY evidence that justifies concluding a song has no words."""
        ...

    async def time_text(self, req: TimeRequest) -> TimedDoc | Refused | None:
        """Align one text with one knob set, write the document, and measure the result.

        `None` is "this attempt produced nothing publishable"; `Refused` is a gate's verdict on the TEXT,
        which ends it with no line sync (XA-05).
        """
        ...

    async def diarize(self, job: JobRef, audio: AudioRef, doc: TimedDoc) -> TimedDoc:
        """Attribute lines to singers. Optional by contract: returns `doc` unchanged on any failure, so a
        diarizer that could not answer is indistinguishable downstream from a one-singer song."""
        ...

    async def publish(self, job: JobRef, doc: TimedDoc | None, *, placing: Sequence[TimedDoc] = ()) -> str:
        """Make the result visible, after re-asserting ownership. Returns the published media uri.

        THE GUARDED STEP (docs/arch/05-worker.md §7.1): raises `NotOurJob` when ownership is gone, which the
        workflow treats as a normal outcome, and only otherwise PLACES the job's attempts. `doc=None`
        publishes the no-lyrics outcome, which still has to be recorded — readiness waits on align.
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

        A step rather than a direct socket write, so on a replay these are checkpointed rather than re-sent
        and an operator sees each decision once (docs/arch/05-worker.md §8).
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
        """Peak dBFS of the instrumental, or None when it could not be measured. A silent instrumental is
        refused rather than published, and an UNMEASURED one too (docs/arch/05-worker.md §2.4)."""
        ...

    async def measure_profile(self, job: JobRef, audio: AudioRef) -> Mapping[str, object]: ...

    async def publish_stems(self, job: JobRef, audio: AudioRef) -> PublishedStems: ...


class NotOurJob(RuntimeError):
    """The core reassigned this job while we were working on it. NOT retryable, and the workflow completes
    quietly: a lease expiring under load is a normal outcome (docs/arch/05-worker.md §7.1)."""

    retryable = False


def language_of(job: JobRef, text: TextRef | None = None) -> str:
    """The TEXT's language: its own, else the job's, else English.

    The text wins because the side that acquired it MEASURED the language, where the job's value is a
    room-wide default. NOT the bundle's language, which `language.model_language` chooses from this
    (docs/arch/04-alignment.md §9).
    """
    if text is not None and text.language:
        return text.language
    return job.param_str("language") or "en"


def as_segments(raw: Sequence[Segment]) -> tuple[Segment, ...]:
    """Freeze a port's sequence into the tuple a checkpointed record requires."""
    return tuple(raw)


# ── what the job asks for: a pin, a sync mode, an ASR model ─────────────────────────────────────
# PURE READS OF THE JOB'S PARAMS, shared by the workflow and the steps — one function per param, so the two
# sides cannot read one param two ways.

#: Where every lyrics document lives, and the only place a pin may write (see `pin_of`).
_LYRICS_DIR = "derived/lyrics/"


@dataclass(frozen=True, slots=True)
class Pin:
    """A HUMAN RE-PICK: core's `pinnedRef`, optionally with `pinnedText`.

    Core pins the chosen candidate as the media's override BEFORE it enqueues the align, so the job re-times
    exactly that text and publishes it under exactly that ref (docs/arch/04-alignment.md §11).
    """

    #: The ref the re-timed document is published under: core's pin, else the manual key for a bare
    #: paste (core never sends one — `pinnedText` rides only beside `pinnedRef` — but a paste is never
    #: dropped for it).
    ref: str
    #: The PASTED words, verbatim; None re-times the stored candidate at `ref`. A paste outranks the
    #: stored words: core sends it only beside the manual ref it was pinned under.
    pasted: str | None = None
    #: Why the pin cannot be honoured, or None. A refused pin publishes NOTHING (old-worker semantics):
    #: never a silent downgrade to an ordinary job over the person's choice.
    refused: str | None = None


def pin_of(job: JobRef) -> Pin | None:
    """The human re-pick this align job carries, or None for an ordinary job.

    REFUSES a ref outside the lyrics store, this value being joined onto the media directory to both READ and
    WRITE: core rejects those shapes too, but the worker holds the file handle.
    """
    asked = job.param_str("pinnedRef")
    pasted = job.param_str("pinnedText")
    if asked is None and pasted is None:
        return None
    ref = asked if asked is not None else keys.manual_lyrics_key(job.media_id)
    if ref.startswith("/") or "\\" in ref or ".." in ref.split("/"):
        refused = f"REFUSING pinned ref {ref!r}: it leaves the media directory"
    elif not ref.startswith(_LYRICS_DIR) or not ref.endswith(".json"):
        refused = f"REFUSING pinned ref {ref!r}: it names no lyrics document ({_LYRICS_DIR}*.json)"
    else:
        refused = None
    return Pin(ref=ref, pasted=pasted, refused=refused)


def attempt_ref(job: JobRef, name: str) -> str:
    """Where an align ATTEMPT's document `name` is written: the job's own scratch, never the store, so a
    failed job's attempts go with the job (XA-13; docs/arch/04-alignment.md §11)."""
    kind = "pinned" if pin_of(job) is not None else "lyrics"
    stem = name if kind == "pinned" else f"{job.media_id}-{name}"
    return f"work/{job.job_id}/{kind}/{stem}"


def store_ref(job: JobRef, ref: str) -> str:
    """The store ref an attempt written at `ref` (`attempt_ref`) is published under — what core is told.

    A pin's accepted attempt goes to the pinned ref; any other keeps its name under `derived/lyrics/`. A ref
    already in the store is its own store ref.
    """
    pin = pin_of(job)
    if pin is not None and pin.refused is None:
        return pin.ref
    return f"{_LYRICS_DIR}{ref.rsplit('/', 1)[-1]}"


def sync_mode_of(job: JobRef) -> SyncMode:
    """How this job's words get their timestamps: the job's `syncMode`, else FORCED.

    A PIN IS ALWAYS FORCED, a paste having no line timings and a stored candidate's being the ones the person
    just rejected. An unknown value is FORCED too, with the fallback on the trail.
    """
    if pin_of(job) is not None:
        return SyncMode.FORCED
    asked = job.param_str("syncMode")
    return next((mode for mode in SyncMode if mode.value == asked), SyncMode.FORCED)


def asr_model_of(job: JobRef, default: str) -> str:
    """The whisper checkpoint this job's ASR fallback loads: its `asrModel`, else this worker's default.

    Only a checkpoint in `host.config.ASR_MODELS`, and an unknown one falls back with a note on the trail
    rather than failing a job that may never load whisper at all.
    """
    asked = job.param_str("asrModel")
    return asked if asked is not None and asked in ASR_MODELS else default
