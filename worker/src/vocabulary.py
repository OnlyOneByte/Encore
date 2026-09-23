"""Enumerated worker vocabulary: what a job asks for, how it progresses, and what runs it.

Named once here rather than compared as bare strings at call sites, which gives two properties plain
strings do not have: `parse_*` turns an untrusted wire value into a member or raises at the BOUNDARY,
so an unknown action fails before any work starts rather than deep inside a pipeline; and the `str`
mixin keeps every member usable wherever a plain string is expected (dict keys, JSON, argv).
"""

from __future__ import annotations

from collections.abc import Iterable
from enum import Enum
from typing import TypeVar, cast

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
    """WHERE a job's source audio comes from, as DECLARED by the core — never inferred from the URI's
    shape, since an unrecognized scheme would otherwise reach ffmpeg several stages later as an opaque
    failure. LOCAL means the bytes are already under MEDIA_DIR; `source_uri` is a path to read, not a
    downloader. Mirrors FetcherId in src/lib/contract/process/fetchers.ts.
    """

    YTDLP = "ytdlp"
    LOCAL = "local"


class Engine(_StrEnum):
    """A separator implementation family. Chosen by the room; carried in job params."""

    DEMUCS = "demucs"
    ROFORMER = "roformer"
    AUDIOSEP = "audiosep"
    ENSEMBLE = "ensemble"


class AsrModel(_StrEnum):
    """Which faster-whisper checkpoint the ASR tier transcribes sung vocals with. Mirrors AsrModelId in
    src/lib/contract/lyrics/lyrics-engines.ts — the source of truth for the whitelist; add a checkpoint
    there first.

    Enumerated rather than a free string: an unrecognised token would reach `whisperx.load_model()`,
    fail to resolve as a HF repo, and be swallowed by AsrSource's `except` — the tier silently DECLINES
    with no words and nothing in the log naming why. Parsing at the boundary fails immediately instead.
    """

    TINY = "tiny"
    BASE = "base"
    SMALL = "small"
    MEDIUM = "medium"
    LARGE_V3 = "large-v3"


class SyncMode(_StrEnum):
    """HOW a song's words get their timestamps. FORCED runs wav2vec2 forced alignment against the
    isolated vocals stem for per-word timings (the bouncing ball); LINES skips alignment and keeps
    each source's own line timings — one fewer ML pass, but no per-word highlight.
    """

    FORCED = "forced"
    LINES = "lines"


class TextSource(_StrEnum):
    """Where a lyrics candidate's TEXT came from. Mirrors LyricsTextSource in
    src/lib/contract/lyrics/lyrics.ts — vocabulary-parity.test.ts fails if the two drift, so keep them in
    step. grading.py re-exports these under its old SOURCE_* names; importers there are unaffected.
    """

    LRCLIB = "lrclib"
    CAPTIONS = "captions"
    ASR = "asr"
    MANUAL = "manual"


class Timing(_StrEnum):
    """Timing fidelity a lyrics source supplies UNAIDED. Mirrors LyricsTiming in the same TS module.
    `line` is the floor (stanza scroll); `word` is the karaoke ideal; `none` needs the aligner.
    """

    WORD = "word"
    LINE = "line"
    NONE = "none"


# ROLES: the axis that decides HOW a lyrics text is judged, orthogonal to WHERE it came from
# (TextSource). BASELINE is evidence of what is heard — never scored. CANDIDATE is authored text
# scored against every baseline; the winner is PUBLISHED. See lyrics/grading.py for the rationale.
# Plain strings, not a _StrEnum: role is worker-internal and has no core-side mirror to parity-check.
#
# UNSPECIFIED is a fail-CLOSED default: it belongs to neither candidates_of nor baselines_of, so an
# unstamped text neither publishes nor grades — it just doesn't participate. Every real path stamps a
# role via the registry's SourceSpec; only hand-built/rehydrated texts (tests, disk) reach the default.
ROLE_BASELINE = "baseline"
ROLE_CANDIDATE = "candidate"
ROLE_UNSPECIFIED = "unspecified"


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


class Capability(_StrEnum):
    """What a worker can PROVE it can do, and therefore what the core will route to it.

    THE FAMILY IS DERIVED, not hardcoded: a capability is `family` or `family:variant`, and `in_family`
    computes membership from the members themselves. A `stems:whatever` token is picked up by every
    stems-family check automatically — a second hardcoded list is what let `stems:audiosep` advertise
    a token whose runner was never bound, so a box accepted separation work it could not run.
    """

    FETCH_YTDLP = "fetch:ytdlp"
    #: Plain `stems` is the demucs family; the engine is chosen per job from params, not by the token.
    STEMS = "stems"
    STEMS_ROFORMER = "stems:roformer"
    STEMS_AUDIOSEP = "stems:audiosep"
    #: In the vocabulary so configuration and routing can NAME it, but never advertised — no ensemble
    #: engine is implemented. Same treatment as `Backend.OPENVINO`.
    STEMS_ENSEMBLE = "stems:ensemble"
    ALIGN = "align"
    #: Opt-in: pyannote is HF-gated and heavy, so this reports available only when it can be imported.
    DIARIZE = "diarize"

    @property
    def family(self) -> str:
        """The action family this capability serves — the part before the colon.

        `stems:roformer` serves `stems`, and plain `align` serves `align`. This is the same rule the
        core routes on, so it is stated once here instead of re-spelled as a prefix test at each site.
        """
        return self.value.split(":", 1)[0]

    @classmethod
    def in_family(cls, family: str) -> tuple[Capability, ...]:
        """Every member serving `family`, computed from the members.

        Deliberately not a hardcoded frozenset: a second list of stems tokens is precisely what drifted
        from the probes and lost `stems:audiosep`.
        """
        return tuple(c for c in cls if c.family == family)


def serves_family(tokens: Iterable[str], family: str) -> bool:
    """Does any advertised token serve `family`?

    Takes plain strings, not members, on purpose. An advertised set can legitimately contain a token
    this build does not know: `ENCORE_WORKER_CAPABILITIES` is free text, and `capabilities.resolve`
    reports an unknown entry as unprovable and drops it WITH a warning rather than raising. Parsing
    strictly here would turn that diagnosable warning into a crash at startup.

    This is the same rule as `protocol.WorkerState.supports` — exact match on the family, or any token
    namespaced under it — which is why that method now calls this instead of re-spelling it.
    """
    return any(str(t) == family or str(t).startswith(f"{family}:") for t in tokens)


class StemFormat(_StrEnum):
    """The container a separator writes its RAW scratch stems in, declared on the engine
    (`SeparatorEngine.stem_format`) rather than inferred — a reader that assumes WAV cannot open a FLAC,
    which silently drops one engine's guide-offset measurement and gets its guide mix refused as
    "stems do not match" with no missing-container reported. `find_outputs` returns paths in the format
    the engine states; readers must honour that instead of guessing.

    FLAC is the default and what the pipeline publishes — one lossless codec end to end. WAV stays
    selectable as a legitimate WORKING format: it skips an encode on a CPU-bound box and is what demucs
    natively emits.
    """

    WAV = "wav"
    FLAC = "flac"

    @property
    def ext(self) -> str:
        """Filename extension, leading dot included — `.flac`. What `find_outputs` builds paths with."""
        return f".{self.value}"

    @property
    def ffmpeg_codec(self) -> str:
        """The ffmpeg `-c:a` codec that WRITES this format.

        `pcm_s16le` rather than a bare "wav": ffmpeg names the codec, not the container, and 16-bit
        little-endian PCM is what the separators consume and what `read_wav_mono` decodes.
        """
        return "flac" if self is StemFormat.FLAC else "pcm_s16le"


#: Ordered stage plan per action. An action absent here falls back to download+separate.
STAGE_PLANS: dict[Action, list[Stage]] = {
    # Acquisition only -- no separation. Its own action so a box that can download and a box that can
    # separate need not be the same machine.
    Action.FETCH: [Stage.DOWNLOADING],
    Action.STEMS: [Stage.DOWNLOADING, Stage.SEPARATING],
    Action.STEMS_UPGRADE: [Stage.DOWNLOADING, Stage.SEPARATING],
    Action.ALIGN: [Stage.DOWNLOADING, Stage.ALIGNING],
}


_E = TypeVar("_E", bound="_StrEnum")


class _Missing:
    """Sentinel type for a parser with NO default (only `parse_action`), so mypy can tell the
    default-bearing wrappers from it without `default` widening the return type to Any."""


_MISSING = _Missing()


def _parse(cls: type[_E], value: str | None, default: _E | _Missing, noun: str) -> _E:
    """Coerce a wire value to a member of `cls`, raising a BoundaryError on anything unknown.

    The single body all `parse_*` wrappers share. When `default` is given, an absent value (None or
    "") returns it; `parse_action` passes the `_MISSING` sentinel instead, so an empty/absent action
    still raises via `cls(value)`. An unknown value always RAISES at the boundary — the point of these
    parsers — with message `unknown {noun} {value!r}; expected one of {[member values]}`.
    """
    if not isinstance(default, _Missing) and (value is None or value == ""):
        return default
    try:
        return cast(_E, cls(value))
    except ValueError:
        raise BoundaryError(f"unknown {noun} {value!r}; expected one of {[m.value for m in cls]}") from None


def parse_action(value: str) -> Action:
    """Coerce a wire job type to an Action, raising on anything unknown."""
    return _parse(Action, value, _MISSING, "action")


def parse_fetcher(value: str | None, default: Fetcher = Fetcher.YTDLP) -> Fetcher:
    """Coerce a wire fetcher to a Fetcher. Absent means the default; unknown RAISES.

    Raising is the point: a job carrying a fetcher this worker does not implement must fail before any
    download or decode runs, rather than being treated as a local path and dying later.
    """
    return _parse(Fetcher, value, default, "fetcher")


def parse_engine(value: str | None, default: Engine = Engine.DEMUCS) -> Engine:
    """Coerce a wire engine to an Engine. Absent means the default; unknown raises."""
    return _parse(Engine, value, default, "engine")


def parse_asr_model(value: str | None, default: AsrModel = AsrModel.BASE) -> AsrModel:
    """Coerce a wire ASR model token to an AsrModel. Absent means the default; unknown RAISES.

    `default` is BASE deliberately: it is what whisperx.py hardcoded before this was configurable, so
    an align job from a core that predates the setting transcribes exactly as it always did.
    """
    return _parse(AsrModel, value, default, "ASR model")


def parse_sync_mode(value: str | None, default: SyncMode = SyncMode.FORCED) -> SyncMode:
    """Coerce a wire sync mode to a SyncMode. Absent means the default; unknown raises."""
    return _parse(SyncMode, value, default, "sync mode")


def parse_backend(value: str | None, default: Backend = Backend.TORCH) -> Backend:
    """Coerce a configured backend to a Backend. Absent means the portable default; unknown raises."""
    return _parse(Backend, value, default, "backend")


def parse_stem_format(value: str | None, default: StemFormat = StemFormat.FLAC) -> StemFormat:
    """Coerce a configured stem format to a StemFormat. Absent means FLAC; unknown RAISES.

    Raising matters more here than the noun suggests. The format is what every raw-stem READER is told
    to expect, so a typo that fell through to a default would not fail loudly — it would produce stems
    in one container and readers looking for another, which is the silent guide-mix refusal this type
    was introduced to end. Failing at the config boundary keeps that class of bug unreachable.
    """
    return _parse(StemFormat, value, default, "stem format")


def stages_for(action: Action | str) -> list[Stage]:
    """The ordered stages an action emits, off STAGE_PLANS. NOT the production path — that's
    `protocol.stages_for` (called by StubProcessor and the dial-home loop); this one has only test
    callers today, so treat the two as the same contract, not this as the live one."""
    key = action if isinstance(action, Action) else parse_action(action)
    return STAGE_PLANS.get(key, [Stage.DOWNLOADING, Stage.SEPARATING])
