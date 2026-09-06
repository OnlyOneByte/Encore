"""Enumerated worker vocabulary: what a job asks for, how it progresses, and what runs it.

These were bare strings compared at call sites, so a typo or a value the core invented was only
discoverable at runtime — usually as a job that failed mid-cook or, worse, silently took a default.
Naming them once here gives three properties the strings did not have:

  * `parse_*` turns an untrusted wire value into a member or raises at the BOUNDARY, so an unknown
    action fails before any work starts rather than deep inside a pipeline.
  * `str` mixin keeps every member usable wherever a plain string is expected (dict keys, JSON,
    argv), so this is additive rather than a migration.

NOT here: the separation quality ladder. A `QUALITY_RANK` table used to live in this module, mirroring
`packages/shared/src/separators.ts` — but the refusal to publish an artifact that does not outrank the
current one is decided CORE-side in `markMediaReady`, so the worker copy had no caller and the two
tables could drift with nothing comparing them. It is deleted rather than guarded by a parity test,
because a test would only have kept a dead table faithfully in sync with a live one.
"""

from __future__ import annotations

from enum import Enum

from .retry_policy import BoundaryError


class _StrEnum(str, Enum):
    """`str`-valued enum: members compare and serialize as their value."""

    def __str__(self) -> str:  # so f-strings/argv render the value, not 'Class.MEMBER'
        return str(self.value)


class Action(_StrEnum):
    """What a job asks the worker to do. Mirrors the core's JobType."""

    FETCH = "fetch"
    STEMS = "stems"
    STEMS_UPGRADE = "stems-upgrade"
    ALIGN = "align"

    @property
    def is_separation(self) -> bool:
        """Separation actions run a separator engine and publish stems."""
        return self in (Action.STEMS, Action.STEMS_UPGRADE)


class Stage(_StrEnum):
    """Progress stages a job reports. The core maps these onto the phone's status bar."""

    DOWNLOADING = "downloading"
    SEPARATING = "separating"
    ALIGNING = "aligning"


class Fetcher(_StrEnum):
    """WHERE a job's source audio comes from, as DECLARED by the core.

    This exists to replace inference. Acquisition used to be guessed from the URI's shape -- an
    `http(s)` prefix meant download, anything else meant a local path -- which silently misclassified
    any other scheme and failed several stages later at ffmpeg with "No such file". A declared value
    parsed at the boundary fails immediately and names the cause.

    LOCAL is not a downloader: it means the bytes are already under MEDIA_DIR and `source_uri` is a
    path to read. Mirrors FetcherId in packages/shared/src/fetchers.ts.
    """

    YTDLP = "ytdlp"
    LOCAL = "local"


class Engine(_StrEnum):
    """A separator implementation family. Chosen by the room; carried in job params."""

    DEMUCS = "demucs"
    ROFORMER = "roformer"
    ENSEMBLE = "ensemble"


class AsrModel(_StrEnum):
    """Which faster-whisper checkpoint the ASR tier transcribes sung vocals with.

    A deployment choice carried in an align job's params, mirroring AsrModelId in
    packages/shared/src/lyrics-engines.ts — which is the source of truth for the whitelist and the
    only place a new checkpoint should be added first.

    Enumerated rather than passed through as a free string for a specific reason: an unrecognised token
    reaches `whisperx.load_model()`, which tries to resolve it as a HuggingFace repo, fails, and is
    swallowed by AsrSource's `except` — so the tier quietly DECLINES and the song finishes cooking with
    no words and nothing in the log naming why. Parsing at the boundary turns that into an immediate,
    named failure.
    """

    TINY = "tiny"
    BASE = "base"
    SMALL = "small"
    MEDIUM = "medium"
    LARGE_V3 = "large-v3"


class SyncMode(_StrEnum):
    """HOW a song's words get their timestamps.

    FORCED runs wav2vec2 forced alignment against the isolated vocals stem and yields per-word
    timings — the bouncing ball. LINES skips alignment entirely and keeps each source's own line
    timings, which costs one fewer ML pass per cook but cannot highlight individual words.

    Both were always code paths; LINES was only ever reachable as the landing spot of an `except` in
    whisperx.py's `_time_one`. Naming it makes it a choice instead of a consolation prize.
    """

    FORCED = "forced"
    LINES = "lines"


class TextSource(_StrEnum):
    """Where a lyrics candidate's TEXT came from. Mirrors LyricsTextSource in
    packages/shared/src/lyrics.ts — that union is the authority; keep the two in step.

    These were plain module string constants in lyrics/chain.py (SOURCE_LRCLIB and friends) guarded only
    by a `# must match LyricsTextSource` comment, while the five sibling enums here got a real bilateral
    parity check. Promoted so the same guard covers them: a value added or renamed on either side now
    reds vocabulary-parity.test.ts instead of drifting silently. chain.py re-exports these under the old
    SOURCE_* names, so its importers are unchanged.
    """

    LRCLIB = "lrclib"
    CAPTIONS = "captions"
    ASR = "asr"
    MANUAL = "manual"


class Timing(_StrEnum):
    """Timing fidelity a lyrics source supplies UNAIDED. Mirrors LyricsTiming in the same TS module.

    `line` is the floor (stanza scroll); `word` is the karaoke ideal; `none` needs the aligner. Promoted
    from chain.py's TIMING_* constants for the same reason as TextSource — a comment cannot fail a build.
    """

    WORD = "word"
    LINE = "line"
    NONE = "none"


class Backend(_StrEnum):
    """HOW an engine executes on this particular worker.

    Distinct from Engine on purpose: the room picks the engine (an audible choice), while the backend
    is a property of the hardware the worker happens to run on and is never user-visible. TORCH is
    the portable default and covers every torch device, including Intel Arc via IPEX (`-d xpu`) —
    a device, not a separate backend. MLX is a genuinely different implementation (Apple Silicon,
    no torch at inference). OPENVINO is registered but has no runtime: Intel publishes IR weights
    with STFT/iSTFT stripped for a C++ pipeline, so wiring it is a port, not a dependency.
    """

    TORCH = "torch"
    MLX = "mlx"
    OPENVINO = "openvino"


#: Ordered stage plan per action. An action absent here falls back to download+separate.
STAGE_PLANS: dict[Action, list[Stage]] = {
    # Acquisition only -- no separation. Its own action so a box that can download and a box that can
    # separate need not be the same machine.
    Action.FETCH: [Stage.DOWNLOADING],
    Action.STEMS: [Stage.DOWNLOADING, Stage.SEPARATING],
    Action.STEMS_UPGRADE: [Stage.DOWNLOADING, Stage.SEPARATING],
    Action.ALIGN: [Stage.DOWNLOADING, Stage.ALIGNING],
}


def parse_action(value: str) -> Action:
    """Coerce a wire job type to an Action, raising on anything unknown."""
    try:
        return Action(value)
    except ValueError:
        raise BoundaryError(
            f"unknown action {value!r}; expected one of {[a.value for a in Action]}"
        ) from None


def parse_fetcher(value: str | None, default: Fetcher = Fetcher.YTDLP) -> Fetcher:
    """Coerce a wire fetcher to a Fetcher. Absent means the default; unknown RAISES.

    Raising is the point: a job carrying a fetcher this worker does not implement must fail before any
    download or decode runs, rather than being treated as a local path and dying later.
    """
    if value is None or value == "":
        return default
    try:
        return Fetcher(value)
    except ValueError:
        raise BoundaryError(
            f"unknown fetcher {value!r}; expected one of {[f.value for f in Fetcher]}"
        ) from None


def parse_engine(value: str | None, default: Engine = Engine.DEMUCS) -> Engine:
    """Coerce a wire engine to an Engine. Absent means the default; unknown raises."""
    if value is None or value == "":
        return default
    try:
        return Engine(value)
    except ValueError:
        raise BoundaryError(
            f"unknown engine {value!r}; expected one of {[e.value for e in Engine]}"
        ) from None


def parse_asr_model(value: str | None, default: AsrModel = AsrModel.BASE) -> AsrModel:
    """Coerce a wire ASR model token to an AsrModel. Absent means the default; unknown RAISES.

    `default` is BASE deliberately: it is what whisperx.py hardcoded before this was configurable, so
    an align job from a core that predates the setting transcribes exactly as it always did.
    """
    if value is None or value == "":
        return default
    try:
        return AsrModel(value)
    except ValueError:
        raise BoundaryError(
            f"unknown ASR model {value!r}; expected one of {[m.value for m in AsrModel]}"
        ) from None


def parse_sync_mode(value: str | None, default: SyncMode = SyncMode.FORCED) -> SyncMode:
    """Coerce a wire sync mode to a SyncMode. Absent means the default; unknown raises."""
    if value is None or value == "":
        return default
    try:
        return SyncMode(value)
    except ValueError:
        raise BoundaryError(
            f"unknown sync mode {value!r}; expected one of {[m.value for m in SyncMode]}"
        ) from None


def parse_backend(value: str | None, default: Backend = Backend.TORCH) -> Backend:
    """Coerce a configured backend to a Backend. Absent means the portable default; unknown raises."""
    if value is None or value == "":
        return default
    try:
        return Backend(value)
    except ValueError:
        raise BoundaryError(
            f"unknown backend {value!r}; expected one of {[b.value for b in Backend]}"
        ) from None


def stages_for(action: Action | str) -> list[Stage]:
    """The ordered stages an action emits."""
    key = action if isinstance(action, Action) else parse_action(action)
    return STAGE_PLANS.get(key, [Stage.DOWNLOADING, Stage.SEPARATING])
