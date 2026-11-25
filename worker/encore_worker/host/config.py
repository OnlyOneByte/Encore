"""Everything this worker reads from its environment, parsed once at the boundary.

An unknown token is refused here, with a message naming the variable and the accepted values, rather than
reaching a subprocess several stages later as an opaque failure. `Config.from_env` is the only reader of
`os.environ`, so a test builds a `Config` literal instead of mutating process state — which is why every
field has a default (XW-13).

See docs/arch/05-worker.md §9.
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
import unicodedata
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import urlsplit

from encore_worker.host import ffmpeg

_TOKEN_PARAM = re.compile(r"(token=)[^&#\s'\"]*")


def redact_token(text: str) -> str:
    """`text` with every `token=` query value blanked, for anything that may echo a dialled URL into a log."""
    return _TOKEN_PARAM.sub(r"\1<redacted>", text)


def clean_token(raw: str) -> str:
    """Core's `cleanToken` (secret-text.ts): drop control and format characters (U+200B, a BOM), then strip.
    The two agree while Python's and Bun's Unicode tables do; a newer table may class a code point apart."""
    return "".join(c for c in raw if unicodedata.category(c) not in ("Cc", "Cf")).strip()


#: Progress emitted this often while a long step runs. Must stay well under the core's 30 s progress lease,
#: or the reaper requeues a healthy job.
KEEPALIVE_SEC = 10.0

# A BACKSTOP, not the hang detector: `cli.run`'s silence deadline catches a hung subprocess in minutes, so
# this bounds only what nothing can kill (the in-process zoo), well past a slow CPU zoo pass on a long song.
# shortcut: fixed, not derived from history; core could fail a job past max(3600, 3 × its ETA) instead.

#: Seconds, from JOB start, that the keepalive vouches for a job before core's lease may lapse.
JOB_CEILING_SEC = 6 * 3600.0

#: Backends this worker knows how to build a separator for.
BACKENDS = ("torch", "mlx")

#: Whisper checkpoints the ASR fallback may load. A job may not name an arbitrary model.
ASR_MODELS = ("tiny", "base", "small", "medium", "large-v2", "large-v3")

#: CTranslate2 compute types `ENCORE_ASR_COMPUTE` may name. `int8` is faster on CPU but unmeasured against the
#: alignment corpus, so it is never the auto pick.
ASR_COMPUTE_TYPES = ("float32", "float16", "bfloat16", "int8", "int8_float16", "int8_float32")

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
    #: The shared secret core checks on a `role=worker` upgrade (`ENCORE_WORKER_TOKEN`, the SAME value both
    #: sides). Sent as the `token` query param at dial time; kept out of `core_url` and `repr` so it is never
    #: printed. None means the token file below, or none at all.
    worker_token: str | None = field(default=None, repr=False)
    #: The file core writes its token to when ENCORE_WORKER_TOKEN is unset (`ENCORE_WORKER_TOKEN_FILE`). Read
    #: at every dial, because core may write it after this worker starts.
    worker_token_file: str | None = None
    #: Core keys a worker by this id and treats a repeated id as a RECONNECT of the same worker, so two live
    #: workers must never share one. `from_env` derives it per machine (`_default_worker_id`); this literal is
    #: only what a test-built `Config()` carries.
    worker_id: str = "worker-1"
    version: str = "0.1.0"
    #: How many jobs at once, which also sizes the emission cache (`adapters.ml._emission_cache_size`). Unset,
    #: `hardware.resolve_profile` picks it at boot.
    concurrency: int = 1
    #: True when nobody set ENCORE_WORKER_CONCURRENCY, so the boot profile may pick it.
    auto_concurrency: bool = False
    #: torch's intra-op threads, and OMP_NUM_THREADS for the demucs children (`ENCORE_THREADS`); unset means
    #: `hardware.resolve_profile` picks from the cores and the concurrency.
    threads: int | None = None
    media_dir: str = "/media"
    #: Where DBOS keeps its durable state. Per-box machine state: it holds in-flight checkpoints, so it must
    #: not be shared or committed.
    dbos_db: str = "encore-worker.sqlite"
    backend: str | None = None
    device: str | None = None
    #: torch demucs `-j` (`ENCORE_DEMUCS_JOBS`); unset means 1 (`hardware.DEMUCS_JOBS_UNSAFE`).
    demucs_jobs: int | None = None
    asr_model: str = "base"
    #: whisper's CTranslate2 compute type (`ENCORE_ASR_COMPUTE`); unset means float16 on CUDA, else float32.
    asr_compute: str | None = None
    #: Load the models and fetch missing checkpoints right after the dial (`ENCORE_WARMUP=0` turns it off).
    warmup: bool = True
    #: A bare name as the dataclass default, but `from_env` resolves a real path through `host.ffmpeg`. Left
    #: bare so a `Config()` built in a test does not need the `ffmpeg` extra installed.
    ffmpeg_bin: str = "ffmpeg"
    ytdlp_bin: str = "yt-dlp"
    mlx_bin: str = "demucs-mlx"
    #: Where zoo checkpoints are cached; `from_env` derives it from XDG_CACHE_HOME. Deliberately not `/tmp`
    #: — see `_default_zoo_dir`.
    zoo_model_dir: str = ""
    #: The yt-dlp config files this worker's yt-dlp reads, for the boot check that YouTube can work
    #: (`hardware.youtube_gap`); `from_env` derives them from XDG_CONFIG_HOME and HOME.
    ytdlp_config_paths: tuple[str, ...] = ()
    keepalive_sec: float = KEEPALIVE_SEC
    job_ceiling_sec: float = JOB_CEILING_SEC
    #: The container published stems are written in — CORE'S DECISION, announced at handshake. Not the
    #: SCRATCH container a separator writes, which no setting controls (docs/arch/05-worker.md §2.5).
    publish_stem_format: str = "flac"
    #: FLAC compression level: the size/CPU knee, and decode-cheap, which is what a browser starting playback
    #: in a room pays for.
    flac_level: int = 8
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

    def hand_set(self) -> tuple[str, ...]:
        """The performance settings set by hand, by their `Hello` wire names; every other one was picked at
        boot. Read BEFORE `__main__` replaces the unset ones with what the box picked."""
        chosen = {
            "device": self.device is not None,
            "backend": self.backend is not None,
            "threads": self.threads is not None,
            "demucsJobs": self.demucs_jobs is not None,
            "concurrency": not self.auto_concurrency,
            "asrCompute": self.asr_compute is not None,
            # On is the default, so only switching it off is a choice.
            "warmup": not self.warmup,
        }
        return tuple(name for name, by_hand in chosen.items() if by_hand)

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

        core_url = text("ENCORE_CORE_URL", "ws://localhost:3000/ws?role=worker")
        parts = urlsplit(core_url)
        if parts.scheme not in ("ws", "wss") or not parts.netloc:
            raise ConfigError(
                f"ENCORE_CORE_URL={redact_token(core_url)!r} is not a ws:// or wss:// URL. "
                "Expected e.g. ws://localhost:3000/ws?role=worker."
            )

        asr = text("ENCORE_ASR_MODEL", "base")
        if asr not in ASR_MODELS:
            raise ConfigError(
                f"ENCORE_ASR_MODEL={asr!r} is not a known checkpoint. "
                f"Expected one of {', '.join(ASR_MODELS)}."
            )

        compute = optional("ENCORE_ASR_COMPUTE")
        if compute is not None and compute not in ASR_COMPUTE_TYPES:
            raise ConfigError(
                f"ENCORE_ASR_COMPUTE={compute!r} is not a compute type whisper takes. "
                f"Expected one of {', '.join(ASR_COMPUTE_TYPES)}, or leave it unset."
            )

        dbos_db = text("ENCORE_DBOS_DB", "encore-worker.sqlite")
        concurrency = _positive_int(src, "ENCORE_WORKER_CONCURRENCY", 0)
        return Config(
            core_url=core_url,
            worker_token=clean_token(src.get("ENCORE_WORKER_TOKEN", "")) or None,
            worker_token_file=optional("ENCORE_WORKER_TOKEN_FILE"),
            worker_id=optional("ENCORE_WORKER_ID") or _default_worker_id(dbos_db),
            version=text("ENCORE_WORKER_VERSION", "0.1.0"),
            concurrency=concurrency or 1,
            auto_concurrency=not concurrency,
            threads=_positive_int(src, "ENCORE_THREADS", 0) or None,
            asr_compute=compute,
            # On unless switched off: `_flag` reads unset as False, which is the wrong default here.
            warmup=src.get("ENCORE_WARMUP", "").strip().lower() not in ("0", "false", "no", "off"),
            media_dir=text("ENCORE_MEDIA_DIR", "/media"),
            dbos_db=dbos_db,
            backend=backend,
            device=optional("ENCORE_DEVICE"),
            demucs_jobs=_positive_int(src, "ENCORE_DEMUCS_JOBS", 0) or None,
            asr_model=asr,
            # RESOLVED, not read: unset means "pick the best available" (`host.ffmpeg`). `optional` so an
            # empty string reads as unset rather than as a request to exec "".
            ffmpeg_bin=ffmpeg.resolve(optional("ENCORE_FFMPEG_BIN")),
            ytdlp_bin=text("ENCORE_YTDLP_BIN", "yt-dlp"),
            mlx_bin=text("ENCORE_MLX_BIN", _beside_python("demucs-mlx")),
            zoo_model_dir=text("ENCORE_ZOO_MODEL_DIR", _default_zoo_dir(src)),
            ytdlp_config_paths=_ytdlp_config_paths(src),
            keepalive_sec=_positive_float(src, "ENCORE_KEEPALIVE_SEC", KEEPALIVE_SEC),
            job_ceiling_sec=_positive_float(src, "ENCORE_JOB_CEILING_SEC", JOB_CEILING_SEC),
            # A FALLBACK only: core announces the live value at handshake and that wins. This exists so a
            # worker started against an older core, which announces nothing, still publishes something.
            publish_stem_format=text("ENCORE_PUBLISH_STEM_FORMAT", "flac").lstrip(".").lower(),
            flac_level=_positive_int(src, "ENCORE_FLAC_LEVEL", 8),
            offline=_flag(src, "ENCORE_OFFLINE"),
            lrcmux_url=text("ENCORE_LRCMUX_URL", "https://api.lrcmux.dev"),
            lrclib_url=text("ENCORE_LRCLIB_URL", "https://lrclib.net/api/get"),
            https_proxy=optional("ENCORE_HTTPS_PROXY"),
            align_experiments=_experiments(src, "ENCORE_ALIGN_EXPERIMENTS"),
            align_model=optional("ENCORE_ALIGN_MODEL"),
        )


def _default_worker_id(dbos_db: str) -> str:
    """`worker-` plus a stable hash of the MAC and the durable-state path, e.g. `worker-3fa2c1`.

    Two boxes differ by MAC, two workers on one box by state file; restarts keep the id. No hostname: guests
    see the id on /metrics, and a hostname often names the owner. A relative ENCORE_DBOS_DB is resolved from
    the current directory, so a worker started elsewhere gets a new id along with its new state file.
    shortcut: `uuid.getnode` falls back to a random number on a box with no readable MAC, so the id there
    changes on restart; set ENCORE_WORKER_ID if a box like that needs a fixed name.
    """
    seed = f"{uuid.getnode():012x}:{os.path.abspath(dbos_db)}"
    return f"worker-{hashlib.sha256(seed.encode()).hexdigest()[:6]}"


def _beside_python(name: str) -> str:
    """`name` from this interpreter's own `bin/` when it is installed there, else the bare name for PATH.

    A worker started as `.venv/bin/python -m encore_worker` (systemd, launchd) has no venv on PATH, so the
    bare name would miss the console script the same install put next to the interpreter.
    """
    beside = os.path.join(os.path.dirname(sys.executable), name)
    return beside if os.access(beside, os.X_OK) else name


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


def _ytdlp_config_paths(src: Mapping[str, str]) -> tuple[str, ...]:
    """The config files yt-dlp reads on Linux and macOS, in its own lookup order (yt-dlp README,
    "Configuration"). dev.sh points XDG_CONFIG_HOME at its own; the image uses /etc/yt-dlp.conf."""
    home = src.get("HOME", "").strip() or os.path.expanduser("~")
    xdg = src.get("XDG_CONFIG_HOME", "").strip() or os.path.join(home, ".config")
    return (
        os.path.join(xdg, "yt-dlp", "config"),
        os.path.join(xdg, "yt-dlp.conf"),
        os.path.join(home, "yt-dlp.conf"),
        os.path.join(home, ".yt-dlp", "config"),
        "/etc/yt-dlp.conf",
        "/etc/yt-dlp/config",
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
