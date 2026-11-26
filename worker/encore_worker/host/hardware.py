"""What THIS box can do, probed rather than assumed.

`probe()` describes the machine for the dashboard and is best-effort; `resolve_backend()` and
`capabilities()` are load-bearing, since a box that advertises work it cannot finish accepts it and then
fails it. Import-free where possible, and what each capability gate proves: XW-14, docs/arch/05-worker.md §9
and §9.1.
"""

from __future__ import annotations

import importlib.util
import os
import platform
import shutil
from dataclasses import dataclass, replace


@dataclass(frozen=True, slots=True)
class Report:
    """A description of this machine; every field past `platform` is optional."""

    machine: str
    python: str
    platform: str
    #: "cuda" / "mps" / "cpu", from what is importable AND usable, never from the OS alone.
    accelerator: str = "cpu"
    apple_silicon: bool = False
    torch_version: str | None = None
    device_name: str | None = None
    #: torch's intra-op thread count in this process (`torch.get_num_threads`); None without torch.
    threads: int | None = None

    @property
    def cuda(self) -> bool:
        """Derived so it cannot disagree with `accelerator`. False for ROCm, which reports as cuda."""
        return self.accelerator == "cuda"

    def to_wire(self) -> dict[str, object]:
        """`Hello.host`, in core's `WorkerHost` shape. Unknown fields are omitted, never guessed."""
        fields: dict[str, object | None] = {
            "platform": self.platform,
            "machine": self.machine,
            "python": self.python,
            "torch": self.torch_version,
            "cuda": self.cuda,
            "accelerator": self.accelerator,
            "deviceName": self.device_name,
        }
        return {k: v for k, v in fields.items() if v is not None}


def module_available(name: str) -> bool:
    """Is this importable, without importing it? A missing PARENT package is a miss, not an error."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def binary_available(name: str) -> bool:
    return shutil.which(name) is not None


def is_apple_silicon() -> bool:
    return platform.system() == "Darwin" and platform.machine() in ("arm64", "aarch64")


def probe() -> Report:
    """Describe this box. Never raises — a diagnostic that fails a handshake is worse than a vague one."""
    base = Report(
        machine=platform.machine(),
        python=platform.python_version(),
        platform=platform.platform(),
        apple_silicon=is_apple_silicon(),
    )
    if not module_available("torch"):
        return base
    try:
        import torch  # noqa: PLC0415 - deliberately lazy; see the module docstring
    except Exception:  # noqa: BLE001 - a broken install must degrade to the base report
        return base

    accelerator = "cpu"
    device_name: str | None = None
    try:
        if torch.cuda.is_available():
            accelerator = "cuda"
            device_name = torch.cuda.get_device_name(0)
        elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            accelerator = "mps"
            device_name = "Apple GPU"
    except Exception:  # noqa: BLE001 - probing a driver can fail on a misconfigured box
        accelerator = "cpu"
    threads: int | None
    try:
        threads = int(torch.get_num_threads())
    except Exception:  # noqa: BLE001 - a diagnostic, never a reason to fail the probe
        threads = None

    return Report(
        machine=base.machine,
        python=base.python,
        platform=base.platform,
        accelerator=accelerator,
        apple_silicon=base.apple_silicon,
        torch_version=str(getattr(torch, "__version__", "")) or None,
        device_name=device_name,
        threads=threads,
    )


@dataclass(frozen=True, slots=True)
class Backend:
    """The resolved separator backend, and `why` — which is not decoration (docs/arch/05-worker.md §9.1)."""

    name: str
    why: str


def resolve_backend(
    configured: str | None, *, report: Report | None = None, mlx_bin: str = "demucs-mlx"
) -> Backend:
    """Which separator implementation will run. An EXPLICIT setting always wins, even where the box cannot
    honour it (docs/arch/05-worker.md §9.1). Auto only picks mlx when the CLI it runs is there, so a missing
    one falls back to torch rather than to no stems at all."""
    if configured:
        return Backend(configured, f"explicitly configured {configured}")
    box = report if report is not None else probe()
    if box.apple_silicon and module_available("demucs_mlx"):
        if binary_available(mlx_bin):
            return Backend("mlx", "auto-selected mlx (Apple Silicon, demucs_mlx present)")
        return Backend("torch", f"auto-selected torch (demucs-mlx not found: {mlx_bin})")
    return Backend("torch", "auto-selected torch")


@dataclass(frozen=True, slots=True)
class Jobs:
    """torch demucs `-j`, and `why`, for the startup line like `Backend`."""

    count: int
    why: str


#: `-j` above 1 on CPU runs chunks in processes, each with its own model (`adapters.demucs_pool`, #1130):
#: demucs's own threads over one model returned NaN chunks, saved as silence (#1125).
DEMUCS_POOL = "chunks in worker processes, a model each"

#: Separator cores per `-j` worker: 16-31 cores get 2-3, under 16 stay at 1. shortcut: measured on 32 cores
#: only; re-measure on a 16-core box before trusting 2-3.
_CORES_PER_DEMUCS_JOB = 8
_MAX_DEMUCS_JOBS = 4
#: Each pool worker adds about 1 GB while a song separates, on top of about 4 GB for the worker and its
#: models (#1284: 7.6 GB at `-j 4` against 4.0 GB at `-j 1`), so RAM caps the auto pick too.
_DEMUCS_WORKER_GB = 1.0
_WORKER_BASE_GB = 4.0


def _demucs_ram_cap(ram_gb: float | None, jobs_at_once: int) -> int | None:
    """The most pool workers each job's separator may start in RAM, or None when the OS would not say."""
    if ram_gb is None:
        return None
    return max(1, int((ram_gb - _WORKER_BASE_GB) / (_DEMUCS_WORKER_GB * max(1, jobs_at_once))))


CGROUP_ROOT = "/sys/fs/cgroup"


def _read(path: str) -> str | None:
    try:
        with open(path, encoding="ascii") as f:
            return f.read().strip()
    except (OSError, ValueError):
        return None


def _cgroup_cpus(root: str) -> int | None:
    """The CPU quota as whole cores (cgroup v2 `cpu.max`, then v1 cfs), or None when there is none."""
    quota: str | None = None
    period: str | None = None
    v2 = _read(f"{root}/cpu.max")
    if v2:
        quota, _, period = v2.partition(" ")
    else:
        quota, period = _read(f"{root}/cpu/cpu.cfs_quota_us"), _read(f"{root}/cpu/cpu.cfs_period_us")
    try:
        q, p = int(quota or ""), int(period or "")
    except ValueError:  # "max", missing, or junk: no quota
        return None
    return max(1, q // p) if q > 0 and p > 0 else None


def cpu_count(*, root: str | None = None) -> int:
    """Cores this process may run on: the affinity mask where the OS has one, so a cpuset counts, and no more
    than a cgroup CPU quota (`docker --cpus`) allows."""
    try:
        n = len(os.sched_getaffinity(0))
    except AttributeError:  # macOS and Windows have no affinity call
        n = os.cpu_count() or 1
    quota = _cgroup_cpus(root or CGROUP_ROOT)
    return min(n, quota) if quota else n


def resolve_demucs_jobs(
    configured: int | None,
    *,
    device: str,
    cores: int = 1,
    ram_gb: float | None = None,
    jobs_at_once: int = 1,
) -> Jobs:
    """How many chunks torch demucs separates at once. `cores` is the separator's share of the box.

    demucs pools `-j` on CPU alone, so auto is 1 elsewhere; on CPU it is one worker per 8 cores, up to 4, and
    no more than the RAM holds at about 1 GB a worker (`_demucs_ram_cap`).
    """
    if configured:
        how = f": {DEMUCS_POOL}" if configured > 1 and device == "cpu" else ""
        return Jobs(configured, f"explicitly configured {configured} (ENCORE_DEMUCS_JOBS){how}")
    if device != "cpu":
        return Jobs(1, f"auto 1 ({device}: demucs runs -j on CPU only)")
    by_cores = max(1, min(_MAX_DEMUCS_JOBS, cores // _CORES_PER_DEMUCS_JOB))
    cap = _demucs_ram_cap(ram_gb, jobs_at_once)
    if cap is not None and cap < by_cores:
        held = f"{cores} separator cores but {ram_gb:.0f} GB RAM"
        return Jobs(cap, f"auto {cap} (cpu, {held}; about 1 GB a worker)")
    if by_cores == 1:
        return Jobs(1, f"auto 1 (cpu, {cores} separator cores; one worker per {_CORES_PER_DEMUCS_JOB})")
    return Jobs(by_cores, f"auto {by_cores} (cpu, {cores} separator cores: {DEMUCS_POOL})")


def _meminfo_gb(key: str) -> float | None:
    """One `/proc/meminfo` line in GB, or None off Linux."""
    for line in (_read("/proc/meminfo") or "").splitlines():
        name, _, rest = line.partition(":")
        if name == key and rest.split():
            return int(rest.split()[0]) / 1024**2
    return None


def _cgroup_memory(root: str) -> tuple[float | None, float | None]:
    """The cgroup's memory limit and use in GB (v2, then v1), each None where there is none."""
    limit = _read(f"{root}/memory.max") or _read(f"{root}/memory/memory.limit_in_bytes")
    used = _read(f"{root}/memory.current") or _read(f"{root}/memory/memory.usage_in_bytes")

    def gb(raw: str | None) -> float | None:
        # v1 reports "no limit" as a huge number, so anything past 1 PB is no limit either.
        return int(raw) / 1024**3 if raw and raw.isdigit() and int(raw) < 2**50 else None

    return gb(limit), gb(used)


def memory_gb(*, root: str | None = None) -> tuple[float | None, float | None]:
    """(total, available) RAM this process may use in GB, a cgroup limit (`docker --memory`) counting; either
    is None where the OS will not say, which every caller reads as "do not pick on it"."""
    try:
        total: float | None = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 1024**3
    except (AttributeError, ValueError, OSError):  # Windows has no sysconf
        total = None
    available = _meminfo_gb("MemAvailable")
    limit, used = _cgroup_memory(root or CGROUP_ROOT)
    if limit is not None:
        total = min(total, limit) if total is not None else limit
        if used is not None:
            headroom = max(0.0, limit - used)
            available = min(available, headroom) if available is not None else headroom
    return total, available


def free_disk_gb(path: str) -> float | None:
    """Free space where `path` (or its nearest existing parent) lives, or None when it cannot be read."""
    while path and not os.path.exists(path):
        path = os.path.dirname(path)
    try:
        return shutil.disk_usage(path or ".").free / 1024**3
    except OSError:
        return None


#: Two jobs at once on CPU: one separates while another aligns, 3 queued songs ready 18-70% sooner (#1177).
#: Two peaked at 8.5 GB, and each separator takes `cores ÷ jobs running`, so a lone pick keeps every core.
#: shortcut: thresholds from one 32-core aarch64 box; tune them when a smaller box is measured.
TWO_JOBS_MIN_CORES = 16
TWO_JOBS_MIN_RAM_GB = 24.0


def resolve_concurrency(
    configured: int | None, *, device: str = "cpu", cores: int = 1, ram_gb: float | None = None
) -> Jobs:
    """How many jobs this box runs at once. `ENCORE_WORKER_CONCURRENCY` wins; auto is 2 on a CPU box with the
    cores and RAM for two (`TWO_JOBS_MIN_*`), else 1."""
    if configured:
        return Jobs(configured, f"explicitly configured {configured} (ENCORE_WORKER_CONCURRENCY)")
    if device != "cpu":
        return Jobs(1, f"auto 1 ({device}: the separators take turns on the card)")
    ram = "unknown RAM" if ram_gb is None else f"{ram_gb:.0f} GB RAM"
    if cores >= TWO_JOBS_MIN_CORES and ram_gb is not None and ram_gb >= TWO_JOBS_MIN_RAM_GB:
        return Jobs(2, f"auto 2 (cpu, {cores} cores, {ram}: one song separates while another aligns)")
    need = f"2 needs {TWO_JOBS_MIN_CORES} cores and {TWO_JOBS_MIN_RAM_GB:.0f} GB"
    return Jobs(1, f"auto 1 (cpu, {cores} cores, {ram}; {need})")


#: Below either, the boot warm-up would crowd the first song or fill the disk with checkpoints, so auto skips
#: it and each job loads what it needs, as before the warm-up existed. About 1.5 GB of checkpoints, and the
#: loaded models take about 3 GB.
WARMUP_MIN_FREE_RAM_GB = 4.0
WARMUP_MIN_FREE_DISK_GB = 5.0


def resolve_warmup(configured: bool | None, *, free_ram_gb: float | None, disk_gb: float | None) -> Jobs:
    """Whether the boot warm-up runs (`count` 1 or 0). `ENCORE_WARMUP` wins; auto is on unless RAM or the
    model cache's disk is tight. A figure the OS would not give counts as not tight, as the warm-up was on."""
    if configured is not None:
        state = "on" if configured else "off"
        return Jobs(int(configured), f"explicitly {state} (ENCORE_WARMUP)")
    force = "ENCORE_WARMUP=1 runs it anyway"
    if free_ram_gb is not None and free_ram_gb < WARMUP_MIN_FREE_RAM_GB:
        tight = f"{free_ram_gb:.1f} GB RAM free, under {WARMUP_MIN_FREE_RAM_GB:.0f}"
        return Jobs(0, f"auto off ({tight}; {force})")
    if disk_gb is not None and disk_gb < WARMUP_MIN_FREE_DISK_GB:
        tight = f"{disk_gb:.1f} GB free for models, under {WARMUP_MIN_FREE_DISK_GB:.0f}"
        return Jobs(0, f"auto off ({tight}; {force})")
    return Jobs(1, "auto on (ENCORE_WARMUP=0 turns it off)")


def resolve_warm_separator(
    configured: bool | None, *, device: str, free_ram_gb: float | None, workers: int
) -> Jobs:
    """Whether torch demucs stays loaded between songs (`count` 1 or 0; `adapters/demucs_warm`, #1357).
    `ENCORE_WARM_SEPARATOR` wins; auto is on for a CPU box with room for the warm-up's floor plus the kept
    separator's `workers` pool workers, about 1 GB each. Off on an accelerator, where it is unmeasured."""
    if configured is not None:
        state = "on" if configured else "off"
        return Jobs(int(configured), f"explicitly {state} (ENCORE_WARM_SEPARATOR)")
    if device != "cpu":
        return Jobs(0, f"auto off ({device}: measured on CPU only)")
    need = WARMUP_MIN_FREE_RAM_GB + max(1, workers) * _DEMUCS_WORKER_GB
    if free_ram_gb is not None and free_ram_gb < need:
        tight = f"{free_ram_gb:.1f} GB RAM free, under {need:.0f}"
        return Jobs(0, f"auto off ({tight}; ENCORE_WARM_SEPARATOR=1 keeps it anyway)")
    return Jobs(1, "auto on (ENCORE_WARM_SEPARATOR=0 turns it off)")


@dataclass(frozen=True, slots=True)
class Profile:
    """Every performance setting this box boots with, each with the `why` the startup lines print."""

    concurrency: Jobs
    #: torch intra-op threads; `count` 0 means "torch's own default", which is what an accelerator keeps.
    threads: Jobs
    demucs_jobs: Jobs
    asr_compute: str
    asr_compute_why: str
    #: `count` 1 when the boot warm-up runs.
    warmup: Jobs
    #: OMP/MKL threads each separator child gets; 0 means it inherits this process's.
    separator_threads: Jobs = Jobs(0, "inherited")
    #: Cores the separators split between the jobs running when each starts (`separator_share`); 0 keeps
    #: `separator_threads` fixed, as an explicit ENCORE_THREADS or an accelerator does.
    split_cores: int = 0
    #: The most demucs pool workers RAM allows each job (`_demucs_ram_cap`), when `-j` is picked per job from
    #: its core share; 0 keeps `demucs_jobs` fixed, as ENCORE_DEMUCS_JOBS or an accelerator does.
    demucs_cap: int = 0
    #: `count` 1 when torch demucs stays loaded between songs (`resolve_warm_separator`).
    warm_separator: Jobs = Jobs(0, "off")

    def separator_share(self, running: int) -> int:
        """A separator's OMP threads, given how many jobs are running as it starts (itself included). A song
        alone keeps every core; two at once take half each."""
        if not self.split_cores:
            return self.separator_threads.count
        return max(1, self.split_cores // max(1, running))

    def demucs_share(self, running: int) -> int:
        """demucs `-j` for a separator starting with `running` jobs: one worker per 8 of its cores, capped."""
        if not self.demucs_cap:
            return self.demucs_jobs.count
        return max(1, min(self.demucs_cap, self.separator_share(running) // _CORES_PER_DEMUCS_JOB))

    def lines(self) -> tuple[str, ...]:
        """One line per setting, for the startup log."""
        threads = str(self.threads.count) if self.threads.count else "torch default"
        child = self.separator_threads
        shared = child.count and child.count != self.threads.count
        children = f"; separators {child.count} ({child.why})" if shared else ""
        demucs = self.demucs_jobs
        alone = self.demucs_share(1)
        solo = f"; {alone} for a song alone" if alone != demucs.count else ""
        warm = self.warmup
        jobs = f"demucs -j {demucs.count} ({demucs.why}{solo})"
        return (
            f"concurrency {self.concurrency.count} ({self.concurrency.why})",
            f"threads {threads} ({self.threads.why}){children}; {jobs}",
            f"asr compute {self.asr_compute} ({self.asr_compute_why})",
            f"warm-up {'on' if warm.count else 'off'} ({warm.why})",
            f"warm separator {'on' if self.warm_separator.count else 'off'} ({self.warm_separator.why})",
        )


def resolve_profile(
    *,
    concurrency: int | None,
    threads: int | None,
    demucs_jobs: int | None,
    asr_compute: str | None,
    warmup: bool | None,
    device: str,
    cores: int | None = None,
    ram_gb: float | None = None,
    free_ram_gb: float | None = None,
    disk_gb: float | None = None,
    warm_separator: bool | None = None,
) -> Profile:
    """The boot profile: each setting's explicit value when one was set, else the auto pick for this box. The
    RAM and disk figures come from `memory_gb` and `free_disk_gb`; None means the OS would not say."""
    n = cores if cores is not None else cpu_count()
    jobs = resolve_concurrency(concurrency, device=device, cores=n, ram_gb=ram_gb)
    split = 0
    if threads:
        picked_threads = Jobs(threads, f"explicitly configured {threads} (ENCORE_THREADS)")
        child = picked_threads
    elif device != "cpu":
        picked_threads = Jobs(0, f"auto ({device}: the work is on the accelerator)")
        child = picked_threads
    else:
        # The in-process models take turns behind ML_LOCK, so only the separator children share the cores, and
        # only with the jobs running when each starts: a lone pick on a 2-job box keeps every core (#1177).
        picked_threads = Jobs(n, f"auto {n} (cpu, {n} cores; the models take turns)")
        each = max(1, n // jobs.count)
        child = Jobs(each, f"auto {each} ({n} cores / {jobs.count} at once; {n} for a song alone)")
        split = n
    if asr_compute:
        compute, compute_why = asr_compute, "explicitly configured (ENCORE_ASR_COMPUTE)"
    else:
        # float16 is an optimisation on CUDA alone; elsewhere it reads as a bad transcription, not a dtype
        # error. int8 is never picked: it is unmeasured against the alignment corpus.
        compute = "float16" if device == "cuda" else "float32"
        compute_why = f"auto ({device})"
    auto_demucs = not demucs_jobs and device == "cpu" and bool(split)
    ram_cap = _demucs_ram_cap(ram_gb, jobs.count)
    profile = Profile(
        concurrency=jobs,
        threads=picked_threads,
        demucs_jobs=resolve_demucs_jobs(
            demucs_jobs, device=device, cores=child.count or n, ram_gb=ram_gb, jobs_at_once=jobs.count
        ),
        asr_compute=compute,
        asr_compute_why=compute_why,
        warmup=resolve_warmup(warmup, free_ram_gb=free_ram_gb, disk_gb=disk_gb),
        separator_threads=child,
        split_cores=split,
        demucs_cap=min(_MAX_DEMUCS_JOBS, ram_cap or _MAX_DEMUCS_JOBS) if auto_demucs else 0,
    )
    # Sized for the separator it would keep: a song alone's `-j`, the largest one this box runs.
    kept = resolve_warm_separator(
        warm_separator, device=device, free_ram_gb=free_ram_gb, workers=profile.demucs_share(1)
    )
    return replace(profile, warm_separator=kept)


def apply_threads(threads: int) -> int | None:
    """Pin this process's torch threads, and the OMP/MKL threads every child inherits, to `threads`. 0 sets
    nothing. Returns the thread count torch now runs, or None without torch.

    Set in this process's environment too, for the children that are not given a share of their own.
    """
    if threads:
        # WRITTEN for the children, never read: not a setting docker/.env carries.
        os.environ.update(OMP_NUM_THREADS=str(threads), MKL_NUM_THREADS=str(threads))
    if not module_available("torch"):
        return threads or None
    try:
        import torch  # noqa: PLC0415 - deliberately lazy; see the module docstring

        if threads:
            torch.set_num_threads(threads)
        return int(torch.get_num_threads())
    except Exception:  # noqa: BLE001 - a broken install must not fail the boot over a thread count
        return threads or None


def capabilities(
    *, backend: str, ytdlp: str = "yt-dlp", ffmpeg: str = "ffmpeg", mlx_bin: str = "demucs-mlx"
) -> frozenset[str]:
    """What this box can PROVE it can do, so core only routes work it can finish.

    Every gate below is chosen to prove the last thing that could still be missing, and the table of what
    each one is for is docs/arch/05-worker.md §9.1.
    """
    caps: set[str] = set()
    if binary_available(ytdlp):
        caps.add("fetch:ytdlp")
    if module_available("whisperx"):
        caps.add("align")

    # Advertised but not routed on, and gated on the module rather than a binary
    # (docs/arch/05-worker.md §9.1).
    if module_available("pyannote.audio"):
        caps.add("diarize")

    # EVERY stems variant needs ffmpeg: the input is normalised by shelling it and the output verified by
    # shelling it (docs/arch/05-worker.md §9.1).
    if not binary_available(ffmpeg):
        return frozenset(caps)

    # The mlx engine runs as a CLI, so it is gated on the binary `build_separator` will exec, not the module.
    has_engine = binary_available(mlx_bin) if backend == "mlx" else module_available("demucs")
    if has_engine:
        caps.add("stems")
    # Gated on the CLI and not the module, which was a real bug (docs/arch/05-worker.md §9.1).
    if binary_available("bs-roformer-infer"):
        caps.add("stems:roformer")
    # The runtime being INSTALLED, never the accelerator being Apple Silicon
    # (docs/arch/05-worker.md §9.1).
    if module_available("mlx_audio"):
        caps.add("stems:melband-mlx")
    # The module is sufficient here in a way it was NOT for roformer, the zoo running in-process
    # (docs/arch/05-worker.md §9.1).
    if module_available("audio_separator"):
        caps.add("stems:audiosep")
    return frozenset(caps)


def youtube_gap(config_paths: tuple[str, ...], *, deno: str = "deno") -> str | None:
    """What yt-dlp is missing to download from YouTube, or None. A warning, not a capability gate: other
    sites still work, and `fetch:ytdlp` is about the binary.

    YouTube needs deno to solve its player challenge, and `--remote-components ejs:github` to fetch the
    solver. dev.sh and the image set both up (`docker/yt-dlp.conf`); a native boot outside them has neither,
    and every YouTube song fails with "Requested format is not available".
    """
    missing = []
    if not binary_available(deno):
        missing.append("deno on PATH")
    if not any(_mentions(path, "remote-components") for path in config_paths):
        # No path: this text goes to core for the host's Ready page. The boot log lists the files read.
        missing.append("--remote-components ejs:github in a yt-dlp config")
    return " and ".join(missing) or None


def _mentions(path: str, text: str) -> bool:
    """Does this config name `text` outside a comment? A `# --remote-components ...`, whole-line or trailing,
    sets nothing. shortcut: a `#` inside a quoted value also ends the line here; yt-dlp's own parser would keep it."""
    try:
        with open(path, encoding="utf-8") as fh:
            return any(text in line.split("#", 1)[0] for line in fh)
    except (OSError, UnicodeDecodeError):
        return False
