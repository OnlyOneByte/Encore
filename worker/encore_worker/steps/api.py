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

    async def fetch_provider_lyrics(self, job: JobRef, audio: AudioRef) -> list[TextRef]:
        """A lyrics sheet by metadata from EVERY provider that has one. Empty when none has this song.

        A LIST SINCE REVIEW M13, and the plural is the fix: the first hit used to win, and lrcmux is first
        in the chain, so LRCLIB was consulted only when lrcmux was UNREACHABLE and never when it merely
        answered badly. Two sources disagreeing is the text side's strongest free signal
        (`policy.corroboration` ranks the pool on it).

        Raising and returning empty mean different things: raising is "the provider could not be
        reached", which must be visible, because the old worker had a provider fail for a month and it
        was indistinguishable from a library of instrumentals.
        """
        ...

    async def fetch_pinned_text(self, job: JobRef) -> TextRef | None:
        """The ONE text a pinned job re-times (`pin_of`): the paste, or the stored candidate's words.

        `None` when the pin cannot be honoured (a stored candidate that is gone or carries no readable
        line), which the workflow answers by publishing nothing: the candidate core already holds stays
        exactly as it is, rather than an automatic search re-picking behind the person who chose it.
        """
        ...

    async def transcribe(self, job: JobRef, audio: AudioRef, *, on_vocals: bool) -> TextRef | None:
        """Whisper over the stem (`on_vocals=True`) or the mix. `None` when nothing was heard.

        The mandatory fallback tier. `None` here — after it actually ran — is the ONLY evidence that
        justifies concluding a song has no words. Transcribes with the job's `asrModel` (`asr_model_of`).
        """
        ...

    async def time_text(self, req: TimeRequest) -> TimedDoc | Refused | None:
        """Align one text with one knob set, write the document, and measure the result.

        `None` means this attempt produced nothing publishable at all, which the workflow treats as an
        unusable report rather than an error — the search has other things to try. `Refused` means a gate
        MEASURED that this text does not describe this audio, which ends the text (no line sync).
        """
        ...

    async def diarize(self, job: JobRef, audio: AudioRef, doc: TimedDoc) -> TimedDoc:
        """Attribute lines to singers. Optional by contract: returns `doc` unchanged on any failure.

        Returns the doc rather than the spans so the workflow has one thing to publish, and so a
        diarizer that could not answer is indistinguishable downstream from a song with one singer.
        """
        ...

    async def publish(self, job: JobRef, doc: TimedDoc | None, *, placing: Sequence[TimedDoc] = ()) -> str:
        """Make the result visible, after re-asserting ownership. Returns the published media uri.

        THE GUARDED STEP. Its first act is to confirm the core still considers this worker the owner of
        this job, because a lease can expire DURING a long alignment — so a workflow that legitimately
        owned its job at reconnect can be reassigned before it reaches here. Raises `NotOurJob` when
        ownership is gone, which the workflow treats as a normal outcome, not a failure.

        Then it PLACES the job's attempts (`placing`, every document it wrote; they were staged in job
        scratch, `attempt_ref`) at their store refs (`store_ref`) — or, for a pin, `doc` alone at the pin —
        so nothing reaches the store before the job is known to be ours and finished.

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

    async def measure_profile(self, job: JobRef, audio: AudioRef) -> Mapping[str, object]: ...

    async def publish_stems(self, job: JobRef, audio: AudioRef) -> PublishedStems: ...


class NotOurJob(RuntimeError):
    """The core reassigned this job while we were working on it.

    `retryable = False`: retrying would re-run work someone else is already doing or has finished. The
    workflow catches this and completes quietly — it is a normal outcome of a lease expiring under load,
    not an error to escalate.
    """

    retryable = False


def language_of(job: JobRef, text: TextRef | None = None) -> str:
    """The TEXT's language: its own, else the job's, else English.

    The text wins over the job because the side that acquired it MEASURED the language — a Unicode script
    histogram of the words, whisper's own detection where ASR ran, lingua over Latin script
    (`domain.lyrics.language.detect`, called in `align_steps`' four acquiring steps) — where the job's
    value is a room-wide default nobody set per song.

    THIS FUNCTION WAS ALWAYS HERE AND ALWAYS ANSWERED `"en"`, which is review M8 in one line: no adapter set
    `TextRef.language`, core sends no `language` param (deliberately — its `JobParams` says "a guessed one is
    worse than letting ASR detect it"), and whisper's detection was read off its result dict and discarded. So
    the decision existed and had no input. W7 gives it one.

    IT IS NOT THE BUNDLE'S LANGUAGE. `TimeRequest.language` is this, and the model that produces the frames is
    chosen from it by `language.model_language` (`align_steps._bundle_language`): Latin script stays on the
    measured English default, a non-Latin script routes. Conflating the two would publish a German sheet as
    English, or syllabify a French one with the English hyphenator while a French model timed it.
    """
    if text is not None and text.language:
        return text.language
    return job.param_str("language") or "en"


def as_segments(raw: Sequence[Segment]) -> tuple[Segment, ...]:
    """Freeze a port's sequence into the tuple a checkpointed record requires."""
    return tuple(raw)


# ── what the job asks for: a pin, a sync mode, an ASR model (review H5) ─────────────────────────
#
# PURE READS OF THE JOB'S PARAMS, shared by the workflow (which decides the flow on them, so they must be
# deterministic under a DBOS replay) and the steps (which write, place and transcribe on them). One
# function per param, so the two sides cannot read one param two ways. Before review H5 none of the four
# was read at all: a paste through `/api/lyrics-reselect` was silently replaced by the automatic search,
# and a room's ASR model and sync mode changed nothing (regressed when the old worker was removed,
# f04a2d0e; its `steps/lyrics/pinned.py` is the semantics kept here).

#: Where every lyrics document lives, and the only place a pin may write (see `pin_of`).
_LYRICS_DIR = "derived/lyrics/"


@dataclass(frozen=True, slots=True)
class Pin:
    """A HUMAN RE-PICK: core's `pinnedRef`, optionally with `pinnedText` (`dispatch.ts assignParams`).

    Core pins the chosen candidate as the media's `lyricsOverrideRef` BEFORE it enqueues the align, and
    that override outranks its own ranking (`resolveLyricsRef`), so the job re-times exactly that one
    text and publishes it under exactly that ref. Anything else it did — re-fetch the providers, fall
    back to ASR, publish under a derived key — could only override the person's choice.
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

    REFUSES a ref outside the lyrics store: this value is joined onto the media directory to READ the
    stored candidate and to WRITE the re-timed one, so `../` or an absolute path would point the step at
    a file outside the store, and a ref naming a stem (`derived/stems/{id}-vocals.flac`) would overwrite
    audio with JSON. Core's `safeMediaPath` rejects the first two shapes; the worker does not take that on
    trust, being the side holding the file handle. Narrower than the old worker's check (which allowed any
    relative path): every ref core can pin is a `derived/lyrics/*.json` the worker itself reported, or the
    manual key core minted there.
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
    """Where an align ATTEMPT's document `name` is written: the job's own scratch, never the store.

    WHY STAGED (review W1 r1). Attempts used to be written straight into `derived/lyrics/`, and only a
    job that reached `publish` reported them to core — whose retention sweep evicts only what a report
    names (`AlignOutcome.candidates`). So a job an `InfraFault` failed mid-ladder (text 2's attempt hitting
    an ffmpeg or device fault after text 1's had written) left every earlier attempt's file in the store,
    named by nothing, for the life of the library; and an ordinary re-align overwrote the document the TV
    was showing with an attempt the ladder might still reject. In scratch, a failed or abandoned job's
    attempts go with the job, and `publish` places them in the store only after the ownership check.

    A PIN's attempts are the pinned subfolder, placed one-for-all at the pin (`store_ref`).
    """
    kind = "pinned" if pin_of(job) is not None else "lyrics"
    stem = name if kind == "pinned" else f"{job.media_id}-{name}"
    return f"work/{job.job_id}/{kind}/{stem}"


def store_ref(job: JobRef, ref: str) -> str:
    """The store ref an attempt written at `ref` (`attempt_ref`) is published under — what core is told.

    A pin's accepted attempt goes to the pinned ref, whatever it was named; any other attempt keeps its
    name, under `derived/lyrics/` (`{media}-{label}{-knob…}-{timing}.json`, `AlignStepsImpl._write`). A ref
    already in the store (a record checkpointed before attempts were staged) is its own store ref.
    """
    pin = pin_of(job)
    if pin is not None and pin.refused is None:
        return pin.ref
    return f"{_LYRICS_DIR}{ref.rsplit('/', 1)[-1]}"


def sync_mode_of(job: JobRef) -> SyncMode:
    """How this job's words get their timestamps: the job's `syncMode`, else FORCED.

    A PIN IS ALWAYS FORCED. `lines` publishes a text's OWN line timings, and a paste has none; a stored
    candidate's are the very timings the person just rejected (the old worker dropped them for exactly
    that reason). So under `lines` a pin published nothing in the old worker, and a paste silently never
    showing is the H5 failure itself. A pin is one explicit request, so it pays its one aligner pass.

    An unknown value (a newer core) is FORCED, the default on both sides (`DEFAULT_SYNC_MODE`): never
    fail a job for a mode it can still serve. The workflow notes the fallback on the trail.
    """
    if pin_of(job) is not None:
        return SyncMode.FORCED
    asked = job.param_str("syncMode")
    return next((mode for mode in SyncMode if mode.value == asked), SyncMode.FORCED)


def asr_model_of(job: JobRef, default: str) -> str:
    """The whisper checkpoint this job's ASR fallback loads: its `asrModel`, else this worker's default.

    Only a checkpoint in `host.config.ASR_MODELS`: a job may not name an arbitrary model. An unknown one
    falls back to `default` (the transcribe step says so on the trail) rather than failing the job — the
    old worker raised here, but the setting is read only by the FALLBACK, and a job whose first text
    publishes never loads whisper at all. Core validates the setting against its own list, a subset.
    """
    asked = job.param_str("asrModel")
    return asked if asked is not None and asked in ASR_MODELS else default
