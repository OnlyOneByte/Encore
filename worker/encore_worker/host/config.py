"""Everything this worker reads from its environment, parsed once at the boundary.

An unknown token is refused here, with a message naming the variable and the accepted values, rather than
reaching a subprocess several stages later as an opaque failure. `Config.from_env` is the only reader of
`os.environ`, so a test builds a `Config` literal instead of mutating process state — which is why every
field has a default (XW-13).

See docs/arch/05-worker.md §9.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field

from encore_worker.host import ffmpeg

#: Progress emitted this often while a long step runs. Must stay well under the core's 30 s progress lease,
#: or the reaper requeues a healthy job.
KEEPALIVE_SEC = 10.0

#: Backends this worker knows how to build a separator for.
BACKENDS = ("torch", "mlx")

#: Whisper checkpoints the ASR fallback may load. A job may not name an arbitrary model.
ASR_MODELS = ("tiny", "base", "small", "medium", "large-v2", "large-v3")

#: Every alignment arm `ENCORE_ALIGN_EXPERIMENTS` may switch on (`Config.align_experiments`); seven of these
#: names are default-ON features' controls. What each switches, why it is off and what retiring a name costs:
#: docs/arch/04-alignment.md §14, with the numbers in docs/benchmarks/forced-alignment/README.md.
ALIGN_EXPERIMENTS = (
    "l1-mix-kept",
    "l1-blind-median",
    "m2-order-clamp",
    "m6-mix-spare",
    "m6-window-spare",
    "m5-adopt-floor",
    "h3-mix-floor",
    "h3-mix-envelope",
    "h3-ungated-words",
    "claimmap-piecewise",
    "ends-tile",
    "ends-raw",
    "linesep",
    "star",
    "adlibs",
    "lang-route-mix",
    "conf-legacy",
    "conf-fuzzy-repeats",
    "band-off-sheet",
    "band-late-kept",
    "vendored",
    "skip-arcs",
    "star-b",
    "claim-priors",
    "claim-fusion",
    "priors-decide",
    "nonlatin-units",
    "zh-simplify",
    "mms-roman",
    "nonlatin-unrouted",
)


class ConfigError(ValueError):
    """A setting that cannot be honoured. NOT retryable: the same environment yields the same value."""

    retryable = False


@dataclass(frozen=True, slots=True)
class Config:
    """This worker's resolved configuration."""

    #: Where the core is. Both the `/ws` path and `role=worker` are required — core routes every socket
    #: through one endpoint and reads `role` to decide what the connection may do.
    core_url: str = "ws://localhost:3000/ws?role=worker"
    worker_id: str = "worker-1"
    version: str = "0.1.0"
    #: How many jobs at once. One by default: separation and alignment are both GPU-bound. It also sizes the
    #: emission cache (`adapters.ml._emission_cache_size`), since each live align job holds two matrices.
    concurrency: int = 1
    media_dir: str = "/media"
    #: Where DBOS keeps its durable state. Per-box machine state: it holds in-flight checkpoints, so it must
    #: not be shared or committed.
    dbos_db: str = "encore-worker.sqlite"
    backend: str | None = None
    device: str | None = None
    asr_model: str = "base"
    #: A bare name as the dataclass default, but `from_env` resolves a real path through `host.ffmpeg`. Left
    #: bare so a `Config()` built in a test does not need the `ffmpeg` extra installed.
    ffmpeg_bin: str = "ffmpeg"
    ytdlp_bin: str = "yt-dlp"
    mlx_bin: str = "demucs-mlx"
    #: Where zoo checkpoints are cached; `from_env` derives it from XDG_CACHE_HOME. Deliberately not `/tmp`
    #: — see `_default_zoo_dir`.
    zoo_model_dir: str = ""
    keepalive_sec: float = KEEPALIVE_SEC
    #: The container published stems are written in — CORE'S DECISION, announced at handshake. Not
    #: `ENCORE_STEM_FORMAT`, which is the SCRATCH container a separator writes (docs/arch/05-worker.md §2.5).
    publish_stem_format: str = "flac"
    #: FLAC compression level: the size/CPU knee, and decode-cheap, which is what a browser starting playback
    #: in a room pays for.
    flac_level: int = 8
    #: Retain the raw caption track under `derived/` for diagnosing the parser. Evidence for a specific
    #: investigation, not something every room needs on disk.
    keep_raw_captions: bool = False
    #: No outbound internet. Skips the lyrics provider rather than paying its timeout per song; captions and
    #: ASR still work, so an offline room still gets lyrics from what it can hear.
    offline: bool = False
    #: The lyrics multiplexer, tried first. Configurable because it is self-hostable, and a restricted network
    #: may reach one host and not another.
    lrcmux_url: str = "https://api.lrcmux.dev"
    #: The direct provider, tried second. Also self-hostable.
    lrclib_url: str = "https://lrclib.net/api/get"
    #: An explicit HTTPS proxy for provider lookups; unset falls back to the standard env variables
    #: (`adapters/lrcmux.build_opener` for why each client builds its own opener).
    https_proxy: str | None = None
    #: The default-off alignment arms switched on (`ALIGN_EXPERIMENTS`): the ONE place they live, so a bench
    #: run records exactly which arms it measured (`e2e_lib.align_config` reads every `align_*` field).
    align_experiments: frozenset[str] = frozenset()
    #: The ENGLISH alignment bundle (`ENCORE_ALIGN_MODEL`), a torchaudio pipeline name; unset means this
    #: DEVICE's default, resolved and validated at `__main__.align_model_for` (docs/arch/04-alignment.md §3,
    #: §5.4, and docs/benchmarks/forced-alignment/README.md for what each bundle measured).
    align_model: str | None = None
    extra: Mapping[str, str] = field(default_factory=dict)

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> Config:
        """Parse the environment. The ONLY place `os.environ` is read."""
        src = dict(os.environ if env is None else env)

        def text(key: str, fallback: str) -> str:
            got = src.get(key, "").strip()
            return got or fallback

        def optional(key: str) -> str | None:
            return src.get(key, "").strip() or None

        backend = optional("ENCORE_SEPARATOR_BACKEND")
        if backend is not None and backend not in BACKENDS:
            raise ConfigError(
                f"ENCORE_SEPARATOR_BACKEND={backend!r} is not a backend this worker can build. "
                f"Expected one of {', '.join(BACKENDS)}, or leave it unset to auto-select."
            )

        asr = text("ENCORE_ASR_MODEL", "base")
        if asr not in ASR_MODELS:
            raise ConfigError(
                f"ENCORE_ASR_MODEL={asr!r} is not a known checkpoint. "
                f"Expected one of {', '.join(ASR_MODELS)}."
            )

        return Config(
            core_url=text("ENCORE_CORE_URL", "ws://localhost:3000/ws?role=worker"),
            worker_id=text("ENCORE_WORKER_ID", "worker-1"),
            version=text("ENCORE_WORKER_VERSION", "0.1.0"),
            concurrency=_positive_int(src, "ENCORE_WORKER_CONCURRENCY", 1),
            media_dir=text("ENCORE_MEDIA_DIR", "/media"),
            dbos_db=text("ENCORE_DBOS_DB", "encore-worker.sqlite"),
            backend=backend,
            device=optional("ENCORE_DEVICE"),
            asr_model=asr,
            # RESOLVED, not read: unset means "pick the best available" (`host.ffmpeg`). `optional` so an
            # empty string reads as unset rather than as a request to exec "".
            ffmpeg_bin=ffmpeg.resolve(optional("ENCORE_FFMPEG_BIN")),
            ytdlp_bin=text("ENCORE_YTDLP_BIN", "yt-dlp"),
            mlx_bin=text("ENCORE_MLX_BIN", "demucs-mlx"),
            zoo_model_dir=text("ENCORE_ZOO_MODEL_DIR", _default_zoo_dir(src)),
            keepalive_sec=_positive_float(src, "ENCORE_KEEPALIVE_SEC", KEEPALIVE_SEC),
            # A FALLBACK only: core announces the live value at handshake and that wins. This exists so a
            # worker started against an older core, which announces nothing, still publishes something.
            publish_stem_format=text("ENCORE_PUBLISH_STEM_FORMAT", "flac").lstrip(".").lower(),
            flac_level=_positive_int(src, "ENCORE_FLAC_LEVEL", 8),
            keep_raw_captions=_flag(src, "ENCORE_KEEP_RAW_CAPTIONS"),
            offline=_flag(src, "ENCORE_OFFLINE"),
            lrcmux_url=text("ENCORE_LRCMUX_URL", "https://api.lrcmux.dev"),
            lrclib_url=text("ENCORE_LRCLIB_URL", "https://lrclib.net/api/get"),
            https_proxy=optional("ENCORE_HTTPS_PROXY"),
            align_experiments=_experiments(src, "ENCORE_ALIGN_EXPERIMENTS"),
            align_model=optional("ENCORE_ALIGN_MODEL"),
        )


def _default_zoo_dir(src: Mapping[str, str]) -> str:
    """Where zoo checkpoints live when the operator has not said.

    XDG_CACHE_HOME first because the Docker image points it at the persistent `worker-cache` volume.
    Explicitly not `audio-separator`'s own `/tmp/audio-separator-models/`: these are 100-400 MB downloads,
    /tmp is cleared on reboot, and where it is a tmpfs the download lands in RAM.
    """
    base = src.get("XDG_CACHE_HOME", "").strip() or os.path.join(
        src.get("HOME", "").strip() or os.path.expanduser("~"), ".cache"
    )
    return os.path.join(base, "encore-worker", "separator-models")


def _positive_int(src: Mapping[str, str], key: str, fallback: int) -> int:
    raw = src.get(key, "").strip()
    if not raw:
        return fallback
    try:
        got = int(raw)
    except ValueError as bad:
        raise ConfigError(f"{key}={raw!r} is not an integer") from bad
    if got < 1:
        raise ConfigError(f"{key}={got} must be at least 1")
    return got


def _positive_float(src: Mapping[str, str], key: str, fallback: float) -> float:
    raw = src.get(key, "").strip()
    if not raw:
        return fallback
    try:
        got = float(raw)
    except ValueError as bad:
        raise ConfigError(f"{key}={raw!r} is not a number") from bad
    if got <= 0:
        raise ConfigError(f"{key}={got} must be positive")
    return got


def _experiments(src: Mapping[str, str], key: str) -> frozenset[str]:
    """A comma-separated set of `ALIGN_EXPERIMENTS` names; blanks ignored, anything else refused."""
    named = frozenset(part.strip().lower() for part in src.get(key, "").split(",") if part.strip())
    unknown = sorted(named - set(ALIGN_EXPERIMENTS))
    if unknown:
        raise ConfigError(
            f"{key} names {', '.join(repr(name) for name in unknown)}, which is not an alignment experiment. "
            f"Expected a comma-separated subset of {', '.join(ALIGN_EXPERIMENTS)}, or leave it unset."
        )
    return named


def _flag(src: Mapping[str, str], key: str) -> bool:
    """A boolean env var. Accepts the spellings people actually type; everything else is False.

    Deliberately not `bool(value)`, which makes `=0` and `=false` both True.
    """
    return src.get(key, "").strip().lower() in ("1", "true", "yes", "on")
