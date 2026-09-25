"""Everything this worker reads from its environment, parsed once at the boundary.

ONE PLACE, AND IT RAISES. An unknown token is refused here with a message naming the variable and the
accepted values, rather than reaching a subprocess several stages later as an opaque failure. The old
worker learned this: a de-whitelisted engine name failed deep inside a step, where the traceback named
ffmpeg rather than the setting.

NOTHING BELOW READS `os.environ` DIRECTLY. `Config.from_env` is the only call, so a test builds a Config
literal instead of mutating process state — which is also why every field has a default.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field

#: Emitted every this many seconds while a long step runs, so the core's lease does not expire.
#: MUST stay comfortably under the core's progress lease (30s in the old core), or the reaper requeues a
#: healthy job. With durable resumption a requeue is cheap now rather than fatal, but a keepalive that
#: never fires would still make every long separation look dead.
KEEPALIVE_SEC = 10.0

#: Backends this worker knows how to build a separator for.
BACKENDS = ("torch", "mlx")

#: Whisper checkpoints the ASR fallback may load. A job may not name an arbitrary model.
ASR_MODELS = ("tiny", "base", "small", "medium", "large-v2", "large-v3")


class ConfigError(ValueError):
    """A setting that cannot be honoured.

    `retryable = False`: re-reading the same environment yields the same value, so a worker with a bad
    setting must fail fast and loudly rather than burn attempts proving it.
    """

    retryable = False


@dataclass(frozen=True, slots=True)
class Config:
    """This worker's resolved configuration."""

    #: Where the core is. The one setting with no sensible default — a worker that guesses this
    #: silently dials a machine nobody meant.
    core_url: str = "ws://localhost:3000/worker"
    worker_id: str = "worker-1"
    version: str = "0.1.0"
    #: How many jobs at once. One by default: separation and alignment are both GPU-bound, and two
    #: concurrent passes on one device are slower than two in sequence.
    concurrency: int = 1
    media_dir: str = "/media"
    #: Where DBOS keeps its durable state. Per-box: it holds in-flight checkpoints, so it is machine
    #: state and must not be shared or committed.
    dbos_db: str = "encore-worker.sqlite"
    backend: str | None = None
    device: str | None = None
    asr_model: str = "base"
    ffmpeg_bin: str = "ffmpeg"
    ytdlp_bin: str = "yt-dlp"
    mlx_bin: str = "demucs-mlx"
    keepalive_sec: float = KEEPALIVE_SEC
    #: Retain the raw caption track under `derived/` for diagnosing the parser. Off by default: it is
    #: evidence for a specific investigation, not something every room needs on disk.
    keep_raw_captions: bool = False
    #: No outbound internet. Skips the lyrics provider entirely rather than paying its timeout per song;
    #: captions and ASR still work, so a fully offline room still gets lyrics from what it can hear.
    offline: bool = False
    #: The lyrics multiplexer, tried first. Configurable because it is self-hostable, and because a
    #: restricted network may reach one host and not another.
    lrcmux_url: str = "https://api.lrcmux.dev"
    #: The direct provider, tried second. Also self-hostable.
    lrclib_url: str = "https://lrclib.net/api/get"
    #: An explicit HTTPS proxy for provider lookups. Unset falls back to the standard environment
    #: variables — see `adapters/lrcmux.build_opener` for why each client builds its own opener.
    https_proxy: str | None = None
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
            core_url=text("ENCORE_CORE_URL", "ws://localhost:3000/worker"),
            worker_id=text("ENCORE_WORKER_ID", "worker-1"),
            version=text("ENCORE_WORKER_VERSION", "0.1.0"),
            concurrency=_positive_int(src, "ENCORE_WORKER_CONCURRENCY", 1),
            media_dir=text("ENCORE_MEDIA_DIR", "/media"),
            dbos_db=text("ENCORE_DBOS_DB", "encore-worker.sqlite"),
            backend=backend,
            device=optional("ENCORE_DEVICE"),
            asr_model=asr,
            ffmpeg_bin=text("ENCORE_FFMPEG_BIN", "ffmpeg"),
            ytdlp_bin=text("ENCORE_YTDLP_BIN", "yt-dlp"),
            mlx_bin=text("ENCORE_MLX_BIN", "demucs-mlx"),
            keepalive_sec=_positive_float(src, "ENCORE_KEEPALIVE_SEC", KEEPALIVE_SEC),
            keep_raw_captions=_flag(src, "ENCORE_KEEP_RAW_CAPTIONS"),
            offline=_flag(src, "ENCORE_OFFLINE"),
            lrcmux_url=text("ENCORE_LRCMUX_URL", "https://api.lrcmux.dev"),
            lrclib_url=text("ENCORE_LRCLIB_URL", "https://lrclib.net/api/get"),
            https_proxy=optional("ENCORE_HTTPS_PROXY"),
        )


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


def _flag(src: Mapping[str, str], key: str) -> bool:
    """A boolean env var. Accepts the spellings people actually type; everything else is False.

    Deliberately NOT `bool(value)`: that makes `ENCORE_KEEP_RAW_CAPTIONS=0` and `=false` both TRUE,
    which is the opposite of what the operator who typed it meant.
    """
    return src.get(key, "").strip().lower() in ("1", "true", "yes", "on")
