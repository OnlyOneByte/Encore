"""Every frame on the wire, as a frozen dataclass.

mypy checks construction, `to_wire()` is the ONLY place a camelCase key is spelled, and `parse()` the only
place an inbound payload is trusted — raising rather than returning None. Why a type per frame, why two
naming conventions, and why an absent field is omitted and not `null`: XW-10, docs/arch/05-worker.md §7.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, ClassVar, Final, NoReturn

from encore_worker.protocol.vocabulary import Stage

# ── worker -> core ────────────────────────────────────────────────────────────────────────────────
HELLO: Final = "worker:hello"
HEARTBEAT: Final = "worker:heartbeat"
ACCEPT: Final = "job:accept"
REJECT: Final = "job:reject"
PROGRESS: Final = "job:progress"
STATE: Final = "job:state"
COMPLETE: Final = "job:complete"
FAILED: Final = "job:failed"
CLAIM: Final = "job:claim"
CATALOGUE: Final = "worker:catalogue"
WARNINGS: Final = "worker:warnings"

# ── core -> worker ────────────────────────────────────────────────────────────────────────────────
WELCOME: Final = "worker:welcome"
ASSIGN: Final = "job:assign"
CANCEL: Final = "job:cancel"
REVOKED: Final = "job:revoked"
CLAIM_ACK: Final = "job:claim-ack"
PING: Final = "ping"
RECHECK: Final = "worker:recheck"


class ProtocolError(ValueError):
    """An inbound payload that does not match the contract.

    `retryable = False`: a malformed frame is not fixed by receiving it again. The worker's failure
    policy reads this attribute, so a boundary violation fails fast instead of burning attempts.
    """

    retryable = False


def _wire(kind: str, **fields: object) -> dict[str, object]:
    """A frame dict with `type` first and every None-valued field dropped. See the module docstring."""
    out: dict[str, object] = {"type": kind}
    out.update({k: v for k, v in fields.items() if v is not None})
    return out


def _require(raw: dict[str, Any], key: str, kind: type) -> Any:
    """Read a required field, naming the frame and the key when it is missing or the wrong shape."""
    if key not in raw:
        _fail(raw, f"missing required field {key!r}")
    value = raw[key]
    # bool is a subclass of int, and a bool where an int is expected is a real defect (a pct of `True`).
    if not isinstance(value, kind) or (kind is int and isinstance(value, bool)):
        _fail(raw, f"field {key!r} must be {kind.__name__}, got {type(value).__name__}")
    return value


def _fail(raw: dict[str, Any], why: str) -> NoReturn:
    raise ProtocolError(f"{raw.get('type', '<untyped>')}: {why}")


# ══ worker -> core ════════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class Note:
    """One thing this box knows is broken or off, for the host's Ready for tonight page (proposal 39).

    `code` is one of a fixed set the core reads (`steps/readiness.py`); `text` is the line the worker already
    prints; `detail` is the technical cause (an error class), never a path, a host or a secret.
    """

    code: str
    text: str
    detail: str | None = None

    def to_wire(self) -> dict[str, object]:
        wire = {"code": self.code, "text": self.text, "detail": self.detail}
        return {k: v for k, v in wire.items() if v is not None}


@dataclass(frozen=True, slots=True)
class Hello:
    """The handshake. `host` is diagnostic only, so a probe failure must omit it rather than fail."""

    TYPE: ClassVar[str] = HELLO
    worker_id: str
    capabilities: tuple[str, ...]
    concurrency: int
    version: str
    #: Resolved separator backend (`torch` / `mlx`). Recorded so a Mac announcing `mlx` cannot be
    #: believed to be running torch demucs.
    backend: str | None = None
    #: The resolved torch device and torch's intra-op threads. With `backend`, core's `WorkerProfile`: it
    #: stamps all three on every attempt this worker is assigned. Names and a count, never a host or path.
    device: str | None = None
    threads: int | None = None
    #: How many tracks torch demucs separates at once (its `-j`). Core accepts it in `WorkerProfile`.
    demucs_jobs: int | None = None
    #: whisper's compute type and whether the boot warm-up runs, the rest of the boot profile.
    asr_compute: str | None = None
    warmup: bool | None = None
    #: Which of the profile's settings were set by hand (`Config.hand_set`); the others were picked at boot.
    hand_set: tuple[str, ...] = ()
    host: dict[str, Any] | None = None
    #: What this box knows is broken or off at boot; a fresh set follows in `Warnings`.
    warnings: tuple[Note, ...] = ()
    #: Slots per lane, `{"fetch": 1, "compute": N}` (#1176): a download gets its own slot instead of waiting
    #: behind a separation. An older core ignores it and counts `concurrency` alone.
    lanes: dict[str, int] | None = None

    def to_wire(self) -> dict[str, object]:
        return _wire(
            HELLO,
            workerId=self.worker_id,
            capabilities=list(self.capabilities),
            concurrency=self.concurrency,
            version=self.version,
            backend=self.backend,
            device=self.device,
            threads=self.threads,
            demucsJobs=self.demucs_jobs,
            asrCompute=self.asr_compute,
            warmup=self.warmup,
            handSet=list(self.hand_set),
            host=self.host,
            warnings=[w.to_wire() for w in self.warnings],
            lanes=self.lanes,
        )


@dataclass(frozen=True, slots=True)
class SeparatorOffer:
    """One selectable separation model, as the core's settings UI needs to describe it.

    METADATA ONLY — routing does NOT read this. A model is routed on the capability token
    `stems:model:<token>` in `Hello.capabilities`, because that is what core's existing dispatch already
    matches on. Everything here (a label, an architecture, a published score) is for rendering a picker, and
    a score is not a routing input.
    """

    token: str
    label: str
    architecture: str
    #: Upstream's published instrumental SDR, NEVER this project's own measurement. `zoo.provenance` carries
    #: the full caveat; the flag below is what stops a UI from printing it as if we measured it.
    upstream_instrumental_sdr: float | None = None
    upstream_vocals_sdr: float | None = None
    #: `"declared"` when the model's metadata names its stems, `"unknown"` when the worker will determine
    #: them from the audio. Surfaced so an operator picking an exotic model knows which they are getting.
    role_source: str = "unknown"

    def to_wire(self) -> dict[str, object]:
        """A nested object, so NOT built by `_wire` — that helper stamps a `type` key, which belongs on a
        frame and not on an element inside one. The None-dropping convention is kept by hand."""
        fields: dict[str, object | None] = {
            "token": self.token,
            "label": self.label,
            "architecture": self.architecture,
            "upstreamInstrumentalSdr": self.upstream_instrumental_sdr,
            "upstreamVocalsSdr": self.upstream_vocals_sdr,
            "roleSource": self.role_source,
        }
        return {k: v for k, v in fields.items() if v is not None}


@dataclass(frozen=True, slots=True)
class Catalogue:
    """The selectable models this box can run, sent AFTER `Hello` rather than inside it, because enumerating
    the zoo is slow enough to delay registration (docs/arch/05-worker.md §7.1).

    `capabilities` REPEATS the full set rather than sending a delta, which makes it idempotent: a reconnect
    or a dropped frame cannot leave core with a half-updated view.
    """

    TYPE: ClassVar[str] = CATALOGUE
    worker_id: str
    capabilities: tuple[str, ...]
    separators: tuple[SeparatorOffer, ...]

    def to_wire(self) -> dict[str, object]:
        return _wire(
            CATALOGUE,
            workerId=self.worker_id,
            capabilities=list(self.capabilities),
            separators=[offer.to_wire() for offer in self.separators],
        )


@dataclass(frozen=True, slots=True)
class Warnings:
    """The FULL current set of `Note`s, after a lyrics check finishes or core asks again (`Recheck`).
    Replace, never merge, like `Catalogue`: an empty list means everything is fine now."""

    TYPE: ClassVar[str] = WARNINGS
    worker_id: str
    warnings: tuple[Note, ...]

    def to_wire(self) -> dict[str, object]:
        return _wire(WARNINGS, workerId=self.worker_id, warnings=[w.to_wire() for w in self.warnings])


@dataclass(frozen=True, slots=True)
class Heartbeat:
    TYPE: ClassVar[str] = HEARTBEAT
    worker_id: str
    slots_free: int
    running_job_ids: tuple[str, ...]
    #: Free slots per lane, beside `slots_free` for a core that reads only that.
    lanes_free: dict[str, int] | None = None

    def to_wire(self) -> dict[str, object]:
        return _wire(
            HEARTBEAT,
            workerId=self.worker_id,
            slotsFree=self.slots_free,
            runningJobIds=list(self.running_job_ids),
            lanesFree=self.lanes_free,
        )


@dataclass(frozen=True, slots=True)
class Accept:
    TYPE: ClassVar[str] = ACCEPT
    worker_id: str
    job_id: str

    def to_wire(self) -> dict[str, object]:
        return _wire(ACCEPT, workerId=self.worker_id, jobId=self.job_id)


@dataclass(frozen=True, slots=True)
class Reject:
    """A refusal to take a job. `reason` is required — an unexplained reject is undiagnosable."""

    TYPE: ClassVar[str] = REJECT
    worker_id: str
    job_id: str
    reason: str

    def to_wire(self) -> dict[str, object]:
        return _wire(REJECT, workerId=self.worker_id, jobId=self.job_id, reason=self.reason)


@dataclass(frozen=True, slots=True)
class Progress:
    """Coarse stage + percentage, for the phone's bar. Doubles as the lease keepalive."""

    TYPE: ClassVar[str] = PROGRESS
    worker_id: str
    job_id: str
    stage: Stage
    pct: int
    eta_sec: int | None = None

    def to_wire(self) -> dict[str, object]:
        return _wire(
            PROGRESS,
            workerId=self.worker_id,
            jobId=self.job_id,
            stage=self.stage.value,
            pct=self.pct,
            etaSec=self.eta_sec,
        )


@dataclass(frozen=True, slots=True)
class State:
    """Where the state machine IS, and why it moved.

    Distinct from `Progress` on purpose. A stage and a percentage cannot express "re-aligning, attempt
    2, knob vocals->mix, because coverage was 0.42". The process log rotates, so putting that explanation
    on the wire is what makes "why did this job publish these lyrics" answerable weeks later.
    """

    TYPE: ClassVar[str] = STATE
    worker_id: str
    job_id: str
    state: str
    attempt: int
    #: The retime parameter in play, when the machine is retrying rather than advancing.
    knob: str | None = None
    #: The verdict that caused the LAST transition, and its reason.
    verdict: str | None = None
    why: str | None = None

    def to_wire(self) -> dict[str, object]:
        return _wire(
            STATE,
            workerId=self.worker_id,
            jobId=self.job_id,
            state=self.state,
            attempt=self.attempt,
            knob=self.knob,
            verdict=self.verdict,
            why=self.why,
        )


@dataclass(frozen=True, slots=True)
class Complete:
    """A finished job. `trail` is the ordered decision history the state machine produced."""

    TYPE: ClassVar[str] = COMPLETE
    worker_id: str
    job_id: str
    media_uri: str
    artifacts: dict[str, Any] | None = None
    #: What actually RAN, never what was asked for.
    facts: dict[str, Any] | None = None
    #: Why this candidate won, durable beyond the process log.
    selection: dict[str, Any] | None = None
    stages: tuple[dict[str, Any], ...] | None = None
    trail: tuple[dict[str, Any], ...] | None = None

    def to_wire(self) -> dict[str, object]:
        return _wire(
            COMPLETE,
            workerId=self.worker_id,
            jobId=self.job_id,
            mediaUri=self.media_uri,
            artifacts=self.artifacts,
            facts=self.facts,
            selection=self.selection,
            stages=list(self.stages) if self.stages is not None else None,
            trail=list(self.trail) if self.trail is not None else None,
        )


@dataclass(frozen=True, slots=True)
class Failed:
    """An INFRASTRUCTURE failure. No lyric outcome reaches here — see README, the align state machine."""

    TYPE: ClassVar[str] = FAILED
    worker_id: str
    job_id: str
    error: str
    retryable: bool

    def to_wire(self) -> dict[str, object]:
        return _wire(
            FAILED,
            workerId=self.worker_id,
            jobId=self.job_id,
            error=self.error,
            retryable=self.retryable,
        )


@dataclass(frozen=True, slots=True)
class Claim:
    """Asks the core whether these jobs are still ours: on reconnect, and again before any publish.

    The PULL half of the ownership guard. `Revoked` is the push half; both exist because a push is
    exactly what a disconnect loses, and a disconnect is what causes a reassignment.
    """

    TYPE: ClassVar[str] = CLAIM
    worker_id: str
    job_ids: tuple[str, ...]

    def to_wire(self) -> dict[str, object]:
        return _wire(CLAIM, workerId=self.worker_id, jobIds=list(self.job_ids))


ToCore = (
    Hello | Catalogue | Warnings | Heartbeat | Accept | Reject | Progress | State | Complete | Failed | Claim
)


# ══ core -> worker ═══════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class Welcome:
    TYPE: ClassVar[str] = WELCOME
    #: Echoed back so a worker can detect the core disagreeing about who it is.
    worker_id: str | None = None
    #: The container the core wants PUBLISHED stems in, `None` from an older core that does not announce
    #: one. CORE'S DECISION, not this box's (docs/arch/05-worker.md §2.5).
    publish_stem_format: str | None = None
    #: How often core wants `worker:heartbeat`, `None` when it names no usable interval. The heartbeat is
    #: how core learns this box's real free slots after a reconnect resets its count.
    heartbeat_interval_sec: float | None = None

    @staticmethod
    def parse(raw: dict[str, Any]) -> Welcome:
        got = raw.get("workerId")
        fmt = raw.get("publishStemFormat")
        beat = raw.get("heartbeatIntervalSec")
        # Normalised the same way core normalises it, so `.FLAC` and `flac` cannot become two formats.
        cleaned = fmt.strip().lstrip(".").lower() if isinstance(fmt, str) and fmt.strip() else None
        # `bool` is an `int`, and a zero or negative interval would spin the heartbeat loop.
        interval = beat if isinstance(beat, int | float) and not isinstance(beat, bool) and beat > 0 else None
        return Welcome(
            worker_id=got if isinstance(got, str) else None,
            publish_stem_format=cleaned,
            heartbeat_interval_sec=float(interval) if interval is not None else None,
        )


@dataclass(frozen=True, slots=True)
class Assign:
    """A job to run. `params` is UNVALIDATED here by design: the protocol layer knows the envelope,
    and each action's own boundary parses the fields it cares about, where an unknown token can be
    refused with a message naming it."""

    TYPE: ClassVar[str] = ASSIGN
    job_id: str
    media_id: str
    action: str
    #: The media volume, when the core names one. USUALLY None — the volume is a property of the WORKER'S
    #: HOST and not of the job — so the composition root falls back to `Config.media_dir`. Requiring it here
    #: once rejected every real `job:assign` core sent (docs/arch/05-worker.md §7).
    media_dir: str | None = None
    source_uri: str | None = None
    params: dict[str, Any] | None = None
    #: The core's own handle for this processing attempt. Echoed in nothing yet; kept so a frame the core
    #: sends is not silently dropped on the floor.
    processing_id: str | None = None

    @staticmethod
    def parse(raw: dict[str, Any]) -> Assign:
        source = raw.get("sourceUri")
        params = raw.get("params")
        media_dir = raw.get("mediaDir")
        processing = raw.get("processingId")
        return Assign(
            job_id=_require(raw, "jobId", str),
            media_id=_require(raw, "mediaId", str),
            action=_require(raw, "jobType", str),
            media_dir=media_dir if isinstance(media_dir, str) and media_dir else None,
            source_uri=source if isinstance(source, str) else None,
            params=params if isinstance(params, dict) else None,
            processing_id=processing if isinstance(processing, str) else None,
        )


@dataclass(frozen=True, slots=True)
class Cancel:
    """Stop this job. An operator action, distinct from `Revoked`, which is the core reassigning."""

    TYPE: ClassVar[str] = CANCEL
    job_id: str

    @staticmethod
    def parse(raw: dict[str, Any]) -> Cancel:
        return Cancel(job_id=_require(raw, "jobId", str))


@dataclass(frozen=True, slots=True)
class Revoked:
    """This job is no longer yours: stop, and do NOT publish.

    The PUSH half of the ownership guard. Arrives when the core's reaper requeued a job whose lease
    expired, which is the case where two workers could otherwise publish different lyrics for one song.
    """

    TYPE: ClassVar[str] = REVOKED
    job_id: str
    reason: str | None = None

    @staticmethod
    def parse(raw: dict[str, Any]) -> Revoked:
        reason = raw.get("reason")
        return Revoked(
            job_id=_require(raw, "jobId", str),
            reason=reason if isinstance(reason, str) else None,
        )


@dataclass(frozen=True, slots=True)
class ClaimAck:
    """The answer to `Claim`: which of the asked-about jobs are still ours, and which are not.

    Both lists are explicit rather than one being the complement. A job the core has never heard of
    belongs in neither, and collapsing that into "not owned" would hide a genuine desync.
    """

    TYPE: ClassVar[str] = CLAIM_ACK
    owned: tuple[str, ...] = ()
    revoked: tuple[str, ...] = ()
    unknown: tuple[str, ...] = ()

    @staticmethod
    def parse(raw: dict[str, Any]) -> ClaimAck:
        def ids(key: str) -> tuple[str, ...]:
            got = raw.get(key)
            if got is None:
                return ()
            if not isinstance(got, list):
                _fail(raw, f"field {key!r} must be a list")
            return tuple(i for i in got if isinstance(i, str))

        return ClaimAck(owned=ids("owned"), revoked=ids("revoked"), unknown=ids("unknown"))


@dataclass(frozen=True, slots=True)
class Ping:
    TYPE: ClassVar[str] = PING

    @staticmethod
    def parse(raw: dict[str, Any]) -> Ping:
        return Ping()


@dataclass(frozen=True, slots=True)
class Recheck:
    """The host tapped Check again: run the lyrics check now and answer with `Warnings`."""

    TYPE: ClassVar[str] = RECHECK

    @staticmethod
    def parse(raw: dict[str, Any]) -> Recheck:
        return Recheck()


FromCore = Welcome | Assign | Cancel | Revoked | ClaimAck | Ping | Recheck

#: Inbound dispatch. A dict rather than a chain of ifs so `parse` cannot grow a branch that forgets to
#: return, and so `test_frames.py` can assert this table covers exactly the FromCore union.
_PARSERS: Final[dict[str, Any]] = {
    WELCOME: Welcome.parse,
    ASSIGN: Assign.parse,
    CANCEL: Cancel.parse,
    REVOKED: Revoked.parse,
    CLAIM_ACK: ClaimAck.parse,
    PING: Ping.parse,
    RECHECK: Recheck.parse,
}


def parse(raw: object) -> FromCore:
    """One inbound frame, or `ProtocolError`.

    An UNKNOWN type raises. The tempting alternative — ignore it, the core may be newer — is how a
    worker silently stops honouring a frame that was added precisely because it mattered. A core that
    needs to send something this worker ignores can gate it on the `version` in `Hello`.
    """
    if not isinstance(raw, dict):
        raise ProtocolError(f"frame must be an object, got {type(raw).__name__}")
    kind = raw.get("type")
    if not isinstance(kind, str):
        raise ProtocolError("frame has no string `type`")
    parser = _PARSERS.get(kind)
    if parser is None:
        raise ProtocolError(f"unknown frame type {kind!r}; known: {', '.join(sorted(_PARSERS))}")
    parsed: FromCore = parser(raw)
    return parsed
