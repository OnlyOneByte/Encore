"""Worker configuration — one place that reads the environment.

The dial-home architecture is explicitly heterogeneous: a GPU box and a CPU box connect to the same
core and should be tuned differently. Per-worker env is the right shape for that, so every
performance knob (`-j`, `--overlap`, `--segment`, `--shifts`, `-d`, stem bitrate, FLAC level, torch
threads) is configurable here, not just the placement settings.

Design rules:
  - PURE `from_env(env)` -- takes the environment as an argument, so it is testable without mutating
    the process.
  - Bad input NEVER crashes the worker and never silently becomes zero. A malformed number falls
    back to the default and is reported in `warnings`, because a worker quietly running with
    `concurrency=0` accepts no jobs and looks like a network problem.
  - Anything left unset is OMITTED from the CLI rather than passed as a guessed value, so upstream
    defaults (demucs' own overlap, its cuda-if-available device pick) keep applying.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _int(env: dict[str, str], key: str, default: int, warnings: list[str], *, minimum: int = 1) -> int:
    raw = env.get(key, "").strip()
    if not raw:
        return default
    try:
        v = int(raw)
    except ValueError:
        warnings.append(f"{key}={raw!r} is not an integer; using {default}")
        return default
    if v < minimum:
        warnings.append(f"{key}={v} is below the minimum {minimum}; using {default}")
        return default
    return v


def _opt_int(env: dict[str, str], key: str, warnings: list[str], *, minimum: int = 1) -> int | None:
    """An optional int: unset means 'do not pass the flag at all'."""
    raw = env.get(key, "").strip()
    if not raw:
        return None
    try:
        v = int(raw)
    except ValueError:
        warnings.append(f"{key}={raw!r} is not an integer; ignoring")
        return None
    if v < minimum:
        warnings.append(f"{key}={v} is below the minimum {minimum}; ignoring")
        return None
    return v


def auto_demucs_jobs(cpu_count: int | None = None) -> int:
    """A safe parallel-jobs default derived from the core count.

    Measured on a 32-core box with a 60s clip: baseline 21.8s, `-j 4` 12.7s (1.72x), `-j 8` 12.1s
    (1.80x) — so 4 captures nearly all of the win and the curve is flat after it. `-j` is a pure
    SCHEDULING change (same chunks, same overlap, same model), so the output is identical and the
    speedup is free; unlike `--overlap`, which alters the audio at chunk seams and is therefore left
    at demucs' default.

    Scaled by cores because each job holds its own model copy: 4 of them would exhaust a small box.
    One job per 8 cores, capped at 4 → 32 cores gives 4, 8 cores gives 1.
    """
    n = cpu_count if cpu_count is not None else (os.cpu_count() or 1)
    return max(1, min(4, n // 8))


def auto_torch_threads(concurrency: int, demucs_jobs: int, cpu_count: int | None = None) -> int | None:
    """An intra-op thread cap derived from how many separations can actually run at once.

    `concurrency` and `demucs_jobs` MULTIPLY into the number of demucs processes in flight, and each
    one otherwise defaults to every core on the box. On a 32-core machine `concurrency=2, jobs=4` asks
    for 8 x 32 = 256 threads across 32 cores, so they fight instead of scaling and raising either knob
    makes every song SLOWER — the opposite of what it looks like it should do. Dividing the cores among
    the processes restores roughly one thread per core.

    Derived rather than a fixed number for the same reason as `auto_demucs_jobs`: a hardcoded 4 is
    right on a 32-core box, over-subscribes an 8-core one, and leaves an x86_64 GPU host misconfigured.

    Returns None when nothing can contend (a single separation), because a cap could then only make
    things worse: torch's own default is physical-core aware, whereas `os.cpu_count()` reports LOGICAL
    CPUs, so pinning to it on an SMT box would oversubscribe 2x. That caveat also softens the divided
    value on an SMT host, where this lands nearer two threads per physical core than one — still far
    better than uncapped, but not exact. Set ENCORE_TORCH_THREADS explicitly to measure a specific box.
    """
    parallel = max(1, concurrency) * max(1, demucs_jobs)
    if parallel <= 1:
        return None
    n = cpu_count if cpu_count is not None else (os.cpu_count() or 1)
    return max(1, n // parallel)


def _opt_float(env: dict[str, str], key: str, warnings: list[str], *, lo: float, hi: float) -> float | None:
    raw = env.get(key, "").strip()
    if not raw:
        return None
    try:
        v = float(raw)
    except ValueError:
        warnings.append(f"{key}={raw!r} is not a number; ignoring")
        return None
    if not (lo <= v <= hi):
        warnings.append(f"{key}={v} is outside {lo}..{hi}; ignoring")
        return None
    return v


# The cook this worker can complete end to end: acquire → separate → time the words. Kept as ONE
# constant so the default and the empty-value fallback cannot drift apart, and so the value the docs
# quote has a single home. `score` is absent on purpose — nothing enqueues it (see followUps in the
# core's dispatch.ts).
DEFAULT_CAPABILITIES = "fetch:ytdlp,stems,align"


@dataclass(frozen=True)
class WorkerConfig:
    # ── placement / identity ──────────────────────────────────────────────────────
    core_ws: str = "ws://localhost:3000/ws?role=worker"
    worker_id: str = ""
    version: str = "0.1.0"
    capabilities: tuple[str, ...] = ("stems",)
    concurrency: int = 1
    media_dir: str = "/app/media"
    processor: str = "real"  # "stub" forces the no-ML path

    # ── separation (demucs) ───────────────────────────────────────────────────────
    demucs_model: str = "htdemucs"
    #: None => let demucs pick (cuda if available, else cpu). Set to force "cpu" / "cuda" / "cuda:1".
    demucs_device: str | None = None
    #: Parallel chunk jobs. Each job holds its own model copy, so this trades MEMORY for wall time.
    #: Defaults to `auto_demucs_jobs(cpu_count)` rather than a fixed number: measured 1.72x on a 32-core
    #: box (21.8s -> 12.7s for a 60s clip), but 4 model copies would OOM a small machine, so the
    #: default scales with the core count instead of assuming a big one.
    demucs_jobs: int = 1
    #: None => demucs' own default (0.25). Lower is faster, with a small quality cost at the seams.
    demucs_overlap: float | None = None
    #: None => demucs' own chunking. Smaller segments cut peak memory on a small box.
    demucs_segment: int | None = None
    #: None => demucs' default. Higher averages more predictions: better and proportionally slower.
    demucs_shifts: int | None = None
    #: Cap torch's intra-op threads. Matters with demucs_jobs > 1, where N jobs x all-cores oversubscribe.
    #: Defaults to `auto_torch_threads(concurrency, demucs_jobs)` — the cores divided among the
    #: separations that can actually contend — and stays None when only one can run, so a box with no
    #: contention keeps torch's own physical-core-aware default.
    torch_threads: int | None = None
    #: Identify a download against MusicBrainz after fetching it. On by default because the payoff is a
    #: correct artist/title for the LRCLIB lookup; set ENCORE_ANNOTATE=0 on a box with no outbound
    #: network, where every call would decline anyway and only cost a timeout per cook.
    annotate: bool = True
    #: Which backend executes a separator engine here: "torch", "mlx", or unset for auto-detect.
    #: Distinct from demucs_device: the backend is the IMPLEMENTATION, the device is where torch runs.
    #: An explicit backend that is unavailable fails at startup rather than silently cooking on CPU.
    separator_backend: str | None = None

    # ── encoding ──────────────────────────────────────────────────────────────────
    stem_bitrate: str = "192k"  # the lossy VOCALS stem; the instrumental is lossless
    flac_level: int = 8
    whisperx_device: str = "cpu"

    # ── lyrics ────────────────────────────────────────────────────────────────────
    #: Which faster-whisper checkpoint the ASR tier transcribes with, and how words get timestamps.
    #: These are a DEPLOYMENT choice and normally arrive per-job in `params` from the core's global
    #: settings; these env values are the fallback for a job that carries neither — an older core, or a
    #: worker driven directly in a test. Whitelist lives in packages/shared/src/lyrics-engines.ts.
    asr_model: str = "base"
    sync_mode: str = "forced"

    # ── lyrics ────────────────────────────────────────────────────────────────────
    #: LRCLIB base URL. Configurable because reachability is a property of the BOX, not the
    #: project: lrclib.net is blocked on the owner's laptop but fine elsewhere. Point this at a proxy,
    #: or at a self-hosted LRCLIB built from their published DB dump — which suits a party box better
    #: than a live API call over party wifi anyway. Empty/unset keeps the public default.
    lrclib_base: str = "https://lrclib.net"

    # ── binaries ──────────────────────────────────────────────────────────────────
    ytdlp_bin: str = "yt-dlp"
    demucs_bin: str = "demucs"
    ffmpeg_bin: str = "ffmpeg"

    #: Human-readable problems found while parsing. Logged at startup; never fatal.
    warnings: tuple[str, ...] = field(default_factory=tuple)

    @staticmethod
    def from_env(env: dict[str, str] | None = None) -> "WorkerConfig":
        e = dict(os.environ if env is None else env)
        w: list[str] = []

        # The whole cook (fetch → stems → align), not just separation. A `stems`-only default is worse
        # than it looks: the core still enqueues `fetch` and `align`, nothing claims them, and the song
        # sits at 0% or never gets lyrics — indistinguishable from a hung worker. A box that should NOT
        # do everything says so explicitly.
        caps = tuple(c.strip() for c in e.get("ENCORE_WORKER_CAPABILITIES", DEFAULT_CAPABILITIES).split(",") if c.strip())
        if not caps:
            w.append(f"ENCORE_WORKER_CAPABILITIES was empty; using '{DEFAULT_CAPABILITIES}'")
            caps = tuple(DEFAULT_CAPABILITIES.split(","))

        concurrency = _int(e, "ENCORE_WORKER_CONCURRENCY", 1, w)
        demucs_jobs = _int(e, "ENCORE_DEMUCS_JOBS", auto_demucs_jobs(), w)
        torch_threads = _opt_int(e, "ENCORE_TORCH_THREADS", w)
        if torch_threads is None:
            torch_threads = auto_torch_threads(concurrency, demucs_jobs)

        return WorkerConfig(
            core_ws=e.get("ENCORE_CORE_WS", "ws://localhost:3000/ws?role=worker"),
            worker_id=e.get("ENCORE_WORKER_ID", ""),
            version=e.get("ENCORE_WORKER_VERSION", "0.1.0"),
            capabilities=caps,
            concurrency=concurrency,
            media_dir=e.get("MEDIA_DIR", "/app/media"),
            processor=e.get("ENCORE_PROCESSOR", "real").lower(),
            demucs_model=e.get("ENCORE_DEMUCS_MODEL", "htdemucs"),
            demucs_device=(e.get("ENCORE_DEMUCS_DEVICE", "").strip() or None),
            demucs_jobs=demucs_jobs,
            demucs_overlap=_opt_float(e, "ENCORE_DEMUCS_OVERLAP", w, lo=0.0, hi=0.99),
            demucs_segment=_opt_int(e, "ENCORE_DEMUCS_SEGMENT", w),
            demucs_shifts=_opt_int(e, "ENCORE_DEMUCS_SHIFTS", w, minimum=0),
            torch_threads=torch_threads,
            annotate=e.get("ENCORE_ANNOTATE", "1").strip() not in ("0", "false", "no"),
            separator_backend=(e.get("ENCORE_SEPARATOR_BACKEND", "").strip().lower() or None),
            stem_bitrate=e.get("ENCORE_STEM_BITRATE", "192k").strip() or "192k",
            flac_level=_int(e, "ENCORE_FLAC_LEVEL", 8, w, minimum=0),
            whisperx_device=e.get("ENCORE_WHISPERX_DEVICE", "cpu"),
            asr_model=(e.get("ENCORE_ASR_MODEL", "").strip() or "base"),
            sync_mode=(e.get("ENCORE_SYNC_MODE", "").strip().lower() or "forced"),
            lrclib_base=(e.get("ENCORE_LRCLIB_BASE", "").strip().rstrip("/") or "https://lrclib.net"),
            ytdlp_bin=e.get("ENCORE_YTDLP_BIN", "yt-dlp"),
            demucs_bin=e.get("ENCORE_DEMUCS_BIN", "demucs"),
            ffmpeg_bin=e.get("ENCORE_FFMPEG_BIN", "ffmpeg"),
            warnings=tuple(w),
        )

    def describe(self) -> str:
        """One line naming the settings that change throughput — what to check first when a box is slow."""
        bits = [
            f"model={self.demucs_model}",
            f"backend={self.separator_backend or 'auto'}",
            f"device={self.demucs_device or 'auto'}",
            f"jobs={self.demucs_jobs}",
            f"concurrency={self.concurrency}",
            f"caps={','.join(self.capabilities)}",
        ]
        if self.demucs_overlap is not None:
            bits.append(f"overlap={self.demucs_overlap}")
        if self.demucs_segment is not None:
            bits.append(f"segment={self.demucs_segment}")
        if self.demucs_shifts is not None:
            bits.append(f"shifts={self.demucs_shifts}")
        if self.torch_threads is not None:
            bits.append(f"torch_threads={self.torch_threads}")
        return " ".join(bits)
