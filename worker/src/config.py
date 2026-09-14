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

from .hardware import effective_cpus
from .vocabulary import StemFormat, parse_stem_format


def _str(env: dict[str, str], key: str, default: str) -> str:
    """A string setting where BLANK means unset.

    `dict.get(key, default)` is wrong for compose-style plumbing: `FOO=${FOO:-}` puts an empty string
    in the environment, which is present, so `.get` returns `""` and the default never applies. That
    turned an unset override into `demucs_model=""` — a worker that passes `-n ''` to demucs and fails
    every process for a reason nothing in the config line would explain.
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

    Measured on a 32-core box with a 60s clip: baseline 21.8s, `-j 4` 12.7s (1.72x), `-j 8` 12.1s
    (1.80x) — so 4 captures nearly all of the win and the curve is flat after it. `-j` is a pure
    SCHEDULING change (same chunks, same overlap, same model), so the output is identical and the
    speedup is free; unlike `--overlap`, which alters the audio at chunk seams and is therefore left
    at demucs' default.

    Scaled by cores because each job holds its own model copy: 4 of them would exhaust a small box.
    One job per 8 cores, capped at 4 → 32 cores gives 4, 8 cores gives 1.

    The core count comes from `effective_cpus()`, not `os.cpu_count()`: inside a throttled container
    the latter reports the HOST's cores, so a 2-core container would start 4 model-holding jobs and
    every song would get slower. That mistake is invisible on an un-contained box.
    """
    n = cpu_count if cpu_count is not None else effective_cpus()
    return max(1, min(4, n // 8))


def auto_demucs_segment(free_vram: int | None = None) -> int | None:
    """A segment length that fits in the accelerator memory actually AVAILABLE, or None for demucs' own.

    `--segment` is the chunk of audio demucs processes at once, and peak VRAM scales with it. The
    interesting direction is only DOWNWARD: htdemucs cannot be given a segment longer than the one it
    was trained on, so there is nothing to win by raising it — the win is not dying on a card that is
    already half-occupied.

    Keyed on FREE memory rather than `Accelerator.vram_bytes`, which is physical capacity. That
    distinction is the whole reason this exists: a 12 GiB card with a browser, a display server or a
    second process already on it can have under 3 GiB free, and a worker that sizes itself for 12 fails at
    the first chunk with a CUDA OOM — reported to the room as a failed process, not as a full card.

    None means "say nothing and let demucs choose", which is correct in three cases: no accelerator
    (CPU separation is bounded by RAM, and the box's own swap behaviour is a better judge than a guess
    here), memory we could not measure, and a card with room to spare.

    THE BANDS ARE CONSERVATIVE, NOT MEASURED. Unlike `auto_demucs_jobs`, whose numbers come from timing
    a real 32-core box, no GPU was available to profile peak VRAM per segment second — so these are
    deliberately pessimistic round numbers, and the comment says so rather than implying a benchmark
    that was never run. An operator who has measured their own card should set
    `ENCORE_DEMUCS_SEGMENT`, which always wins over this.
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

    `concurrency` and `demucs_jobs` MULTIPLY into the number of demucs processes in flight, and each
    one otherwise defaults to every core on the box. On a 32-core machine `concurrency=2, jobs=4` asks
    for 8 x 32 = 256 threads across 32 cores, so they fight instead of scaling and raising either knob
    makes every song SLOWER — the opposite of what it looks like it should do. Dividing the cores among
    the processes restores roughly one thread per core.

    Derived rather than a fixed number for the same reason as `auto_demucs_jobs`: a hardcoded 4 is
    right on a 32-core box, over-subscribes an 8-core one, and leaves an x86_64 GPU host misconfigured.

    Returns None when nothing can contend (a single separation), because a cap could then only make
    things worse: torch's own default is physical-core aware, whereas the counts here are LOGICAL
    CPUs, so pinning to them on an SMT box would oversubscribe 2x. That caveat also softens the
    divided value on an SMT host, where this lands nearer two threads per physical core than one —
    still far better than uncapped, but not exact. Set ENCORE_TORCH_THREADS explicitly to measure a
    specific box.
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


# Which faster-whisper devices exist at all. CTranslate2 (what whisperx transcribes through) has a
# CUDA backend and a CPU backend and nothing else — there is no xpu or mps path — so an Intel or Apple
# box that separates on its accelerator must still align on the CPU. Mapping instead of passing the
# device straight through is what stops "one device for the whole worker" from crashing alignment on
# exactly the hardware it was meant to help.
def whisperx_device_for(device: str | None) -> str:
    """The alignment device implied by the worker's resolved torch device."""
    return "cuda" if device and device.startswith("cuda") else "cpu"


@dataclass(frozen=True)
class WorkerConfig:
    # ── placement / identity ──────────────────────────────────────────────────────
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
    #: Shared secret the core requires on the worker WS handshake. The core gates `role=worker`
    #: connections when ENCORE_WORKER_TOKEN is set on ITS side (server.ts) and returns 401 otherwise,
    #: so a worker that does not present the same token is refused and ALL processing silently stops.
    #: Empty/unset means the connection carries no token — identical to the pre-auth behaviour, for a
    #: deployment that has not set a token. NEVER logged as a value: `describe()` shows presence only.
    worker_token: str = ""

    # ── separation (demucs) ───────────────────────────────────────────────────────
    demucs_model: str = "htdemucs"
    #: ONE device override for the whole worker (separation AND alignment). None => auto-detect the
    #: best accelerator present. Set to force "cpu" / "cuda" / "cuda:1" / "xpu" / "mps"; an explicit
    #: device that is not reachable raises at startup rather than silently processing on CPU.
    device: str | None = None
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
    #: network, where every call would decline anyway and only cost a timeout per process.
    annotate: bool = True
    #: Retain the RAW caption track (the winning `.vtt`/`.srt`) in durable `derived/` storage for
    #: post-process diagnosis of a caption-parsing defect. OFF by default: retaining it puts
    #: third-party caption text into the media volume for every process, and an earlier change's core-side
    # change is
    #: what lets the retention cap count and evict it. Parsed at the config boundary like every other
    #: operator boolean — reading it as bare truthiness inside the step (its original form) made
    #: `ENCORE_KEEP_RAW_CAPTIONS=0` turn it ON, since "0" is a non-empty string.
    keep_raw_captions: bool = False
    #: Which backend executes a separator engine here: "torch", "mlx", or unset for auto-detect.
    #: Distinct from `device`: the backend is the IMPLEMENTATION, the device is where torch runs.
    #: An explicit backend that is unavailable fails at startup rather than silently processing on CPU.
    separator_backend: str | None = None

    # ── encoding ──────────────────────────────────────────────────────────────────
    flac_level: int = 8
    #: Container the separator writes its RAW scratch stems in, for the two engines whose CLI takes a
    #: format flag (torch demucs, audio-separator). FLAC by default: it is what the pipeline publishes, so
    #: the whole chain is one lossless codec end to end, and it roughly halves the scratch bytes of a
    #: full-rate stem pair. WAV is selectable for a box that would rather skip the encode during
    #: separation. demucs-mlx and bs-roformer-infer expose no such flag, so their engines declare a fixed
    #: format and this value does not reach them — see `SeparatorEngine.stem_format`.
    stem_format: StemFormat = StemFormat.FLAC
    #: None => derived from the resolved device via `whisperx_device_for`. It used to default to a
    #: hardcoded "cpu", which meant a CUDA box separated on the GPU and then transcribed on the CPU
    #: unless a human set a SECOND env var — slow, correct-looking, and silent.
    whisperx_device: str | None = None

    # ── lyrics ────────────────────────────────────────────────────────────────────
    #: Which faster-whisper checkpoint the ASR tier transcribes with, and how words get timestamps.
    #: These are a DEPLOYMENT choice and normally arrive per-job in `params` from the core's global
    #: settings; these env values are the fallback for a job that carries neither — an older core, or a
    #: worker driven directly in a test. Whitelist lives in src/lib/contract/lyrics/lyrics-engines.ts.
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
    def from_env(env: dict[str, str] | None = None) -> WorkerConfig:
        e = dict(os.environ if env is None else env)
        w: list[str] = []

        # Capabilities are PROVEN, not declared (see capabilities.py). This env var survives only as a
        # narrowing filter — "this box could do everything but I want it to only fetch" is a real fleet
        # layout, whereas claiming a capability the box lacks is the failure the probe removes. Left
        # unresolved here because probing touches PATH and imports, and from_env is pure over env.
        raw_caps = tuple(c.strip() for c in e.get("ENCORE_WORKER_CAPABILITIES", "").split(",") if c.strip())
        caps_override = raw_caps or None

        concurrency = _int(e, "ENCORE_WORKER_CONCURRENCY", 1, w)
        demucs_jobs = _int(e, "ENCORE_DEMUCS_JOBS", auto_demucs_jobs(), w)
        torch_threads = _opt_int(e, "ENCORE_TORCH_THREADS", w)
        if torch_threads is None:
            torch_threads = auto_torch_threads(concurrency, demucs_jobs)

        # ENCORE_DEMUCS_DEVICE is the old name and applied to separation only. Accepted so an existing
        # deployment keeps working, but it now sets the device for the WHOLE worker, which is what the
        # operator wanted in every case we have seen.
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
            # Default "0" (OFF) so an absent flag keeps the ordinary-process footprint; the SAME
            # false-spelling set annotate uses, so "0"/"false"/"no"/"off" all read as off.
            # `or "0"` folds an empty / whitespace-only value into the false set: this flag defaults
            # OFF, and `ENCORE_KEEP_RAW_CAPTIONS=` (blank, the .env/compose idiom for "neutralise this")
            # must stay OFF rather than reading as a non-empty truthy string (A1).
            keep_raw_captions=(
                (e.get("ENCORE_KEEP_RAW_CAPTIONS", "0").strip().lower() or "0")
                not in ("0", "false", "no", "off")
            ),
            separator_backend=(e.get("ENCORE_SEPARATOR_BACKEND", "").strip().lower() or None),
            flac_level=_int(e, "ENCORE_FLAC_LEVEL", 8, w, minimum=0),
            # Parsed at the BOUNDARY, so an unknown value fails here rather than reaching the engines as a
            # format the readers were never told about — which is the silent guide-mix loss this type ended.
            stem_format=parse_stem_format(e.get("ENCORE_STEM_FORMAT", "").strip().lower() or None),
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

        The core gates `role=worker` connections when ENCORE_WORKER_TOKEN is set on its side, reading
        the token from the `token` query param (server.ts). `core_ws` almost always ALREADY carries a
        query string (the documented form is `ws://host:3000/ws?role=worker`), so the token is added
        as an additional param — rebuilt through urllib rather than string-concatenated so an existing
        `?`/`&` and any pre-existing `token` are handled correctly. Unset token returns `core_ws`
        unchanged, which is byte-identical to the pre-auth behaviour.
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

    Kept out of `from_env` on purpose: that function is pure over a dict so the perf knobs stay
    testable without touching the machine, and probing PATH, importing modules and reading a hostname
    are all host facts. Same reasoning as `oversubscription_warnings`.

    `device` is the already-resolved torch device (from backends.resolve_backend), passed in so the
    alignment device is derived from the SAME decision that separation uses rather than a second,
    independent guess that could disagree.

    Returns (config, warnings). Warnings are additive — a probe that drops a requested capability must
    say so, or the operator is left with a worker that silently does less than they asked.
    """
    from . import capabilities as caps_mod
    from .hardware import default_worker_id

    caps, probes, warnings = caps_mod.resolve(
        cfg.capabilities_override, ytdlp_bin=cfg.ytdlp_bin, demucs_bin=cfg.demucs_bin
    )

    # HONESTY: `caps` proves `stems` from demucs being importable, but an earlier change made the resolved
    # separator
    # backend DRIVE which demucs engine runs, and only `torch` has an implementation. So a box that
    # proves `stems` but resolves its backend to one with no engine (an Apple-Silicon box with
    # `demucs-mlx` importable auto-selects `mlx`) would advertise `stems` and then fail every process it is
    # handed at plan selection. Narrow the set HERE — the one place that both has the proven capability
    # set and can resolve the backend — so the box refuses the work at boot instead. The backend is
    # resolved SILENTLY (`_build_processor` owns the single startup print of it); this only needs its
    # value to decide, and only bothers when a stems capability was actually proven.
    if "stems" in caps:
        from .backends import resolve_backend
        from .vocabulary import Engine

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
    # The PROBES come back too, rather than being computed and thrown away. `capability_probe_lines` used
    # to re-run `probe_all` purely to render the startup log, so every boot probed the box TWICE — four
    # extra `shutil.which` calls plus a `find_spec` on `whisperx` and `pyannote.audio`, and those two are
    # the expensive ones because resolving them imports their parent packages.
    return resolved, warnings, probes


def capability_probe_lines(cfg: WorkerConfig, probes: list[Any] | None = None) -> list[str]:
    """One line per capability with the evidence, for the startup log. A capability that is MISSING is
    the interesting case — that is the one that leaves songs stuck at 0% — so absent ones are reported
    just as loudly as present ones.

    Pass the `probes` `resolve()` already returned. Without them this re-probes the box, which is what made
    every boot probe twice for one log block; the parameter stays optional so a caller that only has a
    config (a test, a diagnostic) still works.
    """
    from . import capabilities as caps_mod

    if probes is None:
        probes = list(caps_mod.probe_all(ytdlp_bin=cfg.ytdlp_bin, demucs_bin=cfg.demucs_bin))
    lines = []
    for p in probes:
        mark = "yes" if p.available else "NO "
        lines.append(f"  {mark} {p.token}: {p.reason}")
    return lines
