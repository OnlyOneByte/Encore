"""Worker configuration — one place that reads the environment.

The dial-home architecture is explicitly heterogeneous: a GPU box and a CPU box connect to the same
core and should be tuned differently. But that does NOT mean a human should have to describe each box
to it. The rule here is that anything the worker can MEASURE about itself, it measures — cores,
memory, accelerator, which engines are installed — and the environment is reserved for the two facts
no probe can reach (where the core is, which volume it shares) plus overrides for when a measurement
is wrong or an operator wants to deliberately limit a box.

Design rules:
  - PURE `from_env(env)` -- takes the environment as an argument, so it is testable without mutating
    the process. Host facts (hostname, PATH, cgroup limits, torch devices) are resolved separately in
    `resolve()`, which keeps that purity intact.
  - Bad input NEVER crashes the worker and never silently becomes zero. A malformed number falls
    back to the default and is reported in `warnings`, because a worker quietly running with
    `concurrency=0` accepts no jobs and looks like a network problem.
  - Anything left unset is OMITTED from the CLI rather than passed as a guessed value, so upstream
    defaults (demucs' own overlap, its cuda-if-available device pick) keep applying.
  - An override may NARROW what a box does; it may not claim something the box cannot prove.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, replace
from typing import Any

from ..separation.tuning import SeparationTuning
from ..vocabulary import StemFormat, parse_stem_format
from .hardware import effective_cpus


def _str(env: dict[str, str], key: str, default: str) -> str:
    """A string setting where BLANK means unset.

    `dict.get(key, default)` is wrong for compose-style plumbing: `FOO=${FOO:-}` puts an empty
    string in the environment, so `.get` returns `""` and the default never applies — turning an
    unset override into e.g. `demucs_model=""`, which fails every process opaquely.
    """
    return env.get(key, "").strip() or default


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

    Measured on a 32-core box: `-j 4` gives 1.72x over baseline and the curve is flat after it. `-j`
    is a pure SCHEDULING change (same chunks, same overlap, same model), so the speedup is free —
    unlike `--overlap`, which alters the audio at chunk seams and stays at demucs' default.

    Scaled by cores because each job holds its own model copy: one job per 8 cores, capped at 4, so
    4 copies cannot exhaust a small box.

    Uses `effective_cpus()`, not `os.cpu_count()`: inside a throttled container the latter reports
    the HOST's cores, so a 2-core container would start 4 model-holding jobs and get slower — a
    mistake invisible on an un-contained box.
    """
    n = cpu_count if cpu_count is not None else effective_cpus()
    return max(1, min(4, n // 8))


def auto_demucs_segment(free_vram: int | None = None) -> int | None:
    """A segment length that fits in the accelerator memory actually AVAILABLE, or None for demucs' own.

    Only ever shrinks the segment: htdemucs cannot be given one longer than it was trained on, so
    the win is not dying on a card that is already half-occupied.

    Keyed on FREE memory, not physical VRAM capacity: a 12 GiB card with a browser or display server
    already on it can have under 3 GiB free, and sizing for 12 fails the first chunk with a CUDA OOM
    — reported as a failed process, not a full card.

    None ("let demucs choose") covers three cases: no accelerator, memory we could not measure, and a
    card with room to spare.

    THE BANDS BELOW ARE CONSERVATIVE, NOT MEASURED (no GPU was available to profile peak VRAM per
    segment). An operator who has measured their own card should set `ENCORE_DEMUCS_SEGMENT`, which
    always wins over this.
    """
    if free_vram is None:
        return None
    gib = free_vram / (1024**3)
    if gib >= 6.0:
        return None  # room for the model's full training segment; adding a flag would only constrain it
    if gib >= 4.0:
        return 7
    if gib >= 3.0:
        return 5
    return 3  # very tight — small chunks are slower per song, but a slow process beats an OOM


def auto_torch_threads(concurrency: int, demucs_jobs: int, cpu_count: int | None = None) -> int | None:
    """An intra-op thread cap derived from how many separations can actually run at once.

    `concurrency` and `demucs_jobs` MULTIPLY into the number of demucs processes in flight, each
    otherwise defaulting to every core on the box: on a 32-core machine `concurrency=2, jobs=4` asks
    for 256 threads across 32 cores, so they fight and raising either knob makes every song SLOWER.
    Dividing the cores among the processes restores roughly one thread per core.

    Returns None when nothing can contend (a single separation): a cap could then only make things
    worse, since torch's own default is physical-core aware while the counts here are LOGICAL CPUs
    (pinning to them on an SMT box would oversubscribe 2x). Set ENCORE_TORCH_THREADS explicitly to
    measure a specific box.
    """
    parallel = max(1, concurrency) * max(1, demucs_jobs)
    if parallel <= 1:
        return None
    n = cpu_count if cpu_count is not None else effective_cpus()
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


def whisperx_device_for(device: str | None) -> str:
    """The alignment device implied by the worker's resolved torch device.

    CTranslate2 (what whisperx transcribes through) has a CUDA backend and a CPU backend only — no
    xpu or mps path — so an Intel or Apple box that separates on its accelerator must still align on
    the CPU, or "one device for the whole worker" crashes alignment on the hardware it meant to help.
    """
    return "cuda" if device and device.startswith("cuda") else "cpu"


@dataclass(frozen=True)
class WorkerConfig:
    core_ws: str = "ws://localhost:3000/ws?role=worker"
    #: Empty means "derive one from the hostname" (see hardware.default_worker_id). Resolved outside
    #: from_env because a hostname is a property of the HOST, not the environment.
    worker_id: str = ""
    version: str = "0.1.0"
    #: The EFFECTIVE capability set — proven by probe, not declared. Empty until resolved (see
    #: capabilities.resolve), which cannot happen in from_env because probing touches PATH and imports.
    capabilities: tuple[str, ...] = ()
    #: An operator's request, which may only NARROW the proven set. None = advertise everything proven.
    capabilities_override: tuple[str, ...] | None = None
    concurrency: int = 1
    media_dir: str = "/app/media"
    processor: str = "real"  # "stub" forces the no-ML path
    #: Shared secret the core requires on the worker WS handshake; a worker with the wrong token is
    #: refused and ALL processing silently stops. Empty/unset = no token, identical to pre-auth.
    #: NEVER logged as a value: `describe()` shows presence only.
    worker_token: str = ""

    demucs_model: str = "htdemucs"
    #: ONE device override for the whole worker (separation AND alignment). None => auto-detect the
    #: best accelerator present. An explicit device that is not reachable raises at startup rather
    #: than silently processing on CPU.
    device: str | None = None
    #: Parallel chunk jobs; trades MEMORY for wall time. Defaults to `auto_demucs_jobs(cpu_count)`.
    demucs_jobs: int = 1
    #: None => demucs' own default (0.25). Lower is faster, with a small quality cost at the seams.
    demucs_overlap: float | None = None
    #: None => demucs' own chunking. Smaller segments cut peak memory on a small box.
    demucs_segment: int | None = None
    #: None => demucs' default. Higher averages more predictions: better and proportionally slower.
    demucs_shifts: int | None = None
    #: demucs-mlx's batch size (`-b`). None => let demucs-mlx choose. MLX-only; see
    #: `separation.tuning.SeparationTuning.mlx_batch_size` for why there is no default yet.
    mlx_batch_size: int | None = None
    #: Where the separator CLIs cache their auto-downloaded checkpoints. None => each tool's own default.
    #: See `separation.tuning.SeparationTuning.models_dir` for why one setting covers two CLI flags.
    models_dir: str | None = None
    #: Cap torch's intra-op threads. Defaults to `auto_torch_threads(concurrency, demucs_jobs)`, and
    #: stays None when only one separation can run, so an uncontended box keeps torch's own default.
    torch_threads: int | None = None
    #: Identify a download against MusicBrainz after fetching it. On by default because the payoff is a
    #: correct artist/title for the LRCLIB lookup; set ENCORE_ANNOTATE=0 on a box with no outbound
    #: network, where every call would decline anyway and only cost a timeout per process.
    annotate: bool = True
    #: Retain the RAW caption track in durable `derived/` storage for post-process diagnosis. OFF by
    #: default: retaining it puts third-party caption text into the media volume for every process.
    #: Parsed at the config boundary rather than as bare truthiness inside the step, or
    #: `ENCORE_KEEP_RAW_CAPTIONS=0` would turn it ON ("0" is a non-empty string).
    keep_raw_captions: bool = False
    #: Which backend executes a separator engine here: "torch", "mlx", or unset for auto-detect.
    #: Distinct from `device`: the backend is the IMPLEMENTATION, the device is where torch runs.
    #: An explicit backend that is unavailable fails at startup rather than silently processing on CPU.
    separator_backend: str | None = None

    flac_level: int = 8
    #: Container the separator writes its RAW scratch stems in, for the two engines whose CLI takes a
    #: format flag. FLAC by default: same lossless codec end to end, roughly half the scratch bytes
    #: of WAV. demucs-mlx and bs-roformer-infer expose no such flag and declare a fixed format
    #: instead — see `SeparatorEngine.stem_format`.
    stem_format: StemFormat = StemFormat.FLAC
    #: None => derived from the resolved device via `whisperx_device_for`, so a CUDA box that
    #: separates on the GPU also transcribes on it rather than silently falling back to CPU.
    whisperx_device: str | None = None

    #: Which faster-whisper checkpoint the ASR tier transcribes with, and how words get timestamps.
    #: Normally arrive per-job in `params` from the core's global settings; these env values are the
    #: fallback for a job carrying neither. Allowed values live in
    #: src/lib/contract/lyrics/lyrics-engines.ts.
    asr_model: str = "base"
    sync_mode: str = "forced"

    #: LRCLIB base URL. Configurable because reachability is a property of the BOX: point this at a
    #: proxy or a self-hosted LRCLIB when the public API is blocked. Empty/unset keeps the default.
    lrclib_base: str = "https://lrclib.net"

    ytdlp_bin: str = "yt-dlp"
    demucs_bin: str = "demucs"
    ffmpeg_bin: str = "ffmpeg"

    #: Human-readable problems found while parsing. Logged at startup; never fatal.
    warnings: tuple[str, ...] = field(default_factory=tuple)

    @staticmethod
    def from_env(env: dict[str, str] | None = None) -> WorkerConfig:
        e = dict(os.environ if env is None else env)
        w: list[str] = []

        # Capabilities are PROVEN, not declared: this env var only NARROWS the proven set (e.g. "this
        # box could do everything but I want it to only fetch"), never claims one the box lacks. Left
        # unresolved here since probing touches PATH and imports, and from_env is pure over env.
        raw_caps = tuple(c.strip() for c in e.get("ENCORE_WORKER_CAPABILITIES", "").split(",") if c.strip())
        caps_override = raw_caps or None

        concurrency = _int(e, "ENCORE_WORKER_CONCURRENCY", 1, w)
        demucs_jobs = _int(e, "ENCORE_DEMUCS_JOBS", auto_demucs_jobs(), w)
        torch_threads = _opt_int(e, "ENCORE_TORCH_THREADS", w)
        if torch_threads is None:
            torch_threads = auto_torch_threads(concurrency, demucs_jobs)

        # ENCORE_DEMUCS_DEVICE is the deprecated name (separation only); accepted for compatibility
        # but now sets the device for the WHOLE worker.
        device = e.get("ENCORE_DEVICE", "").strip() or None
        legacy_device = e.get("ENCORE_DEMUCS_DEVICE", "").strip() or None
        if legacy_device and not device:
            device = legacy_device
            w.append(
                "ENCORE_DEMUCS_DEVICE is deprecated; it now sets the device for alignment too. "
                "Rename it to ENCORE_DEVICE, or unset it entirely to auto-detect"
            )
        elif legacy_device and device:
            w.append("both ENCORE_DEVICE and ENCORE_DEMUCS_DEVICE are set; ENCORE_DEVICE wins")

        return WorkerConfig(
            core_ws=_str(e, "ENCORE_CORE_WS", "ws://localhost:3000/ws?role=worker"),
            worker_id=_str(e, "ENCORE_WORKER_ID", ""),
            version=_str(e, "ENCORE_WORKER_VERSION", "0.1.0"),
            capabilities_override=caps_override,
            concurrency=concurrency,
            media_dir=_str(e, "MEDIA_DIR", "/app/media"),
            processor=_str(e, "ENCORE_PROCESSOR", "real").lower(),
            worker_token=_str(e, "ENCORE_WORKER_TOKEN", ""),
            demucs_model=_str(e, "ENCORE_DEMUCS_MODEL", "htdemucs"),
            device=device,
            demucs_jobs=demucs_jobs,
            demucs_overlap=_opt_float(e, "ENCORE_DEMUCS_OVERLAP", w, lo=0.0, hi=0.99),
            demucs_segment=_opt_int(e, "ENCORE_DEMUCS_SEGMENT", w),
            demucs_shifts=_opt_int(e, "ENCORE_DEMUCS_SHIFTS", w, minimum=0),
            torch_threads=torch_threads,
            annotate=e.get("ENCORE_ANNOTATE", "1").strip().lower() not in ("0", "false", "no", "off"),
            # `or "0"` folds a blank value (the .env/compose idiom for "neutralise this") into the
            # false set, so `ENCORE_KEEP_RAW_CAPTIONS=` stays OFF rather than reading as truthy.
            keep_raw_captions=(
                (e.get("ENCORE_KEEP_RAW_CAPTIONS", "0").strip().lower() or "0")
                not in ("0", "false", "no", "off")
            ),
            separator_backend=(e.get("ENCORE_SEPARATOR_BACKEND", "").strip().lower() or None),
            flac_level=_int(e, "ENCORE_FLAC_LEVEL", 8, w, minimum=0),
            # Parsed at the BOUNDARY, so an unknown value fails here rather than reaching the engines
            # as a format the readers were never told about.
            stem_format=parse_stem_format(e.get("ENCORE_STEM_FORMAT", "").strip().lower() or None),
            # Deliberately NOT defaulted under MEDIA_DIR: that would write hundreds of MB of model
            # weights into the media volume, whose eviction cap (ENCORE_MEDIA_MAX_GB) knows nothing
            # about them.
            models_dir=(e.get("ENCORE_MODELS_DIR", "").strip() or None),
            mlx_batch_size=_opt_int(e, "ENCORE_MLX_BATCH_SIZE", w, minimum=1),
            whisperx_device=(e.get("ENCORE_WHISPERX_DEVICE", "").strip() or None),
            asr_model=_str(e, "ENCORE_ASR_MODEL", "base"),
            sync_mode=_str(e, "ENCORE_SYNC_MODE", "forced").lower(),
            lrclib_base=_str(e, "ENCORE_LRCLIB_BASE", "https://lrclib.net").rstrip("/"),
            ytdlp_bin=_str(e, "ENCORE_YTDLP_BIN", "yt-dlp"),
            demucs_bin=_str(e, "ENCORE_DEMUCS_BIN", "demucs"),
            ffmpeg_bin=_str(e, "ENCORE_FFMPEG_BIN", "ffmpeg"),
            warnings=tuple(w),
        )

    def describe(self) -> str:
        """One line naming the settings that change throughput — what to check first when a box is slow."""
        bits = [
            f"model={self.demucs_model}",
            f"backend={self.separator_backend or 'auto'}",
            f"device={self.device or 'auto'}",
            f"jobs={self.demucs_jobs}",
            f"concurrency={self.concurrency}",
            f"caps={','.join(self.capabilities) or 'unresolved'}",
            f"worker_token={'set' if self.worker_token else 'unset'}",
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

    def authed_core_ws(self) -> str:
        """The core WebSocket URL with the worker token attached, if one is configured.

        The core reads the token from the `token` query param (server.ts). Rebuilt through urllib
        rather than string-concatenated, since `core_ws` almost always already carries a query
        string, so an existing `?`/`&` and any pre-existing `token` must be handled correctly. Unset
        token returns `core_ws` unchanged (byte-identical to pre-auth).
        """
        if not self.worker_token:
            return self.core_ws
        from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

        parts = urlsplit(self.core_ws)
        query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "token"]
        query.append(("token", self.worker_token))
        return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def resolve(cfg: WorkerConfig, *, device: str | None = None) -> tuple[WorkerConfig, list[str], list[Any]]:
    """Fill in everything that depends on the HOST rather than the environment.

    Kept out of `from_env` on purpose: that function stays pure over a dict, testable without
    touching the machine, while probing PATH, importing modules and reading a hostname are host facts.

    `device` is the already-resolved torch device (from backends.resolve_backend), passed in so the
    alignment device is derived from the SAME decision that separation uses, not a second guess that
    could disagree.

    Returns (config, warnings, probes). Warnings are additive — a probe that drops a requested
    capability must say so, or the operator is left with a worker that silently does less than asked.
    """
    from . import capabilities as caps_mod
    from .hardware import default_worker_id

    caps, probes, warnings = caps_mod.resolve(
        cfg.capabilities_override, ytdlp_bin=cfg.ytdlp_bin, demucs_bin=cfg.demucs_bin
    )

    # HONESTY: `caps` proves `stems` from demucs being importable, but the resolved separator backend
    # DRIVES which demucs engine actually runs, and only `torch` has an implementation. A box that
    # proves `stems` but resolves to a backend with no engine (e.g. Apple Silicon auto-selecting
    # `mlx`) would advertise `stems` and then fail every process handed to it. Narrow HERE, the one
    # place with both the proven capability set and the resolved backend, so the box refuses the work
    # at boot instead.
    if "stems" in caps:
        from ..vocabulary import Engine
        from .backends import resolve_backend

        resolved_backend = resolve_backend(
            cfg.separator_backend, engine=Engine.DEMUCS, device=cfg.device
        ).backend.value
        caps, backend_warnings = caps_mod.narrow_for_backend(caps, resolved_backend)
        warnings.extend(backend_warnings)

    resolved = replace(
        cfg,
        capabilities=caps,
        worker_id=cfg.worker_id or default_worker_id(),
        whisperx_device=cfg.whisperx_device or whisperx_device_for(device),
    )
    if (
        cfg.whisperx_device
        and cfg.whisperx_device not in ("cpu", "cuda")
        and not cfg.whisperx_device.startswith("cuda")
    ):
        warnings.append(
            f"ENCORE_WHISPERX_DEVICE={cfg.whisperx_device!r} is not a device whisperx can use "
            "(CTranslate2 supports cuda and cpu only); alignment will likely fail"
        )
    # Probes come back too rather than being thrown away, so the startup log render
    # (capability_probe_lines) does not have to re-probe the box a second time.
    return resolved, warnings, probes


def separation_tuning(
    cfg: WorkerConfig,
    *,
    device: str | None,
    backend: str | None,
    segment: int | None,
) -> SeparationTuning:
    """Fold this worker's separator settings into ONE value for `plans.stems_runner`.

    Exists so the tuning knobs have a single owner rather than being enumerated as keyword arguments
    across multiple call sites, where adding one means several edits and forgetting one is silent.

    The three explicit arguments are the values config CANNOT know: `device` and `backend` come from
    `backends.resolve_backend` (imports torch, so it cannot run at config-build time), and `segment`
    may be derived from FREE accelerator memory, a runtime measurement. Everything else comes from `cfg`.
    """
    return SeparationTuning(
        model=cfg.demucs_model,
        demucs_bin=cfg.demucs_bin,
        device=device,
        backend=backend,
        jobs=cfg.demucs_jobs,
        overlap=cfg.demucs_overlap,
        segment=segment,
        shifts=cfg.demucs_shifts,
        stem_format=cfg.stem_format,
        models_dir=cfg.models_dir,
        mlx_batch_size=cfg.mlx_batch_size,
    )


def capability_probe_lines(cfg: WorkerConfig, probes: list[Any] | None = None) -> list[str]:
    """One line per capability with the evidence, for the startup log. A capability that is MISSING
    is the interesting case (it leaves songs stuck at 0%), so absent ones are reported just as loudly
    as present ones.

    Pass the `probes` `resolve()` already returned, or this re-probes the box; the parameter stays
    optional so a caller with only a config (a test, a diagnostic) still works.
    """
    from . import capabilities as caps_mod

    if probes is None:
        probes = list(caps_mod.probe_all(ytdlp_bin=cfg.ytdlp_bin, demucs_bin=cfg.demucs_bin))
    lines = []
    for p in probes:
        mark = "yes" if p.available else "NO "
        lines.append(f"  {mark} {p.token}: {p.reason}")
    return lines
