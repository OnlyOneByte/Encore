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
from dataclasses import dataclass


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


#: Auto `-j` is 1: threaded chunks came back NaN, saved as silence (worker/README.md, `ENCORE_DEMUCS_JOBS`).
#: shortcut: about 2x slower on CPU; raise only for a parallel path proven NaN-free, say a model per process.
DEMUCS_JOBS_UNSAFE = "demucs -j above 1 can return NaN on CPU, saved as a silent song"


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


def resolve_demucs_jobs(configured: int | None, *, device: str) -> Jobs:
    """How many chunks torch demucs separates at once: 1 unless `ENCORE_DEMUCS_JOBS` says otherwise.

    demucs pools `-j` on CPU alone, and there it is unsafe (`DEMUCS_JOBS_UNSAFE`), so auto never picks more.
    """
    if configured:
        warn = f": {DEMUCS_JOBS_UNSAFE}" if configured > 1 and device == "cpu" else ""
        return Jobs(configured, f"explicitly configured {configured} (ENCORE_DEMUCS_JOBS){warn}")
    if device != "cpu":
        return Jobs(1, f"auto 1 ({device}: demucs runs -j on CPU only)")
    return Jobs(1, f"auto 1 (cpu: {DEMUCS_JOBS_UNSAFE})")


def resolve_concurrency(configured: int | None) -> Jobs:
    """How many jobs this box runs at once: 1 unless `ENCORE_WORKER_CONCURRENCY` says otherwise.

    2 made 3 queued songs 18-70% sooner but a song picked alone 10-30% slower, its align at least (#1177).
    shortcut: auto 1 until a lone pick at 2 measures flat; 2 is the opt-in for queue-heavy nights.
    """
    if configured:
        return Jobs(configured, f"explicitly configured {configured} (ENCORE_WORKER_CONCURRENCY)")
    return Jobs(1, "auto 1 (ENCORE_WORKER_CONCURRENCY=2 overlaps a queue of songs)")


@dataclass(frozen=True, slots=True)
class Profile:
    """Every performance setting this box boots with, each with the `why` the startup lines print."""

    concurrency: Jobs
    #: torch intra-op threads; `count` 0 means "torch's own default", which is what an accelerator keeps.
    threads: Jobs
    demucs_jobs: Jobs
    asr_compute: str
    asr_compute_why: str
    warmup: bool
    #: OMP/MKL threads each separator child gets; 0 means it inherits this process's.
    separator_threads: Jobs = Jobs(0, "inherited")

    def lines(self) -> tuple[str, ...]:
        """One line per setting, for the startup log."""
        threads = str(self.threads.count) if self.threads.count else "torch default"
        child = self.separator_threads
        shared = child.count and child.count != self.threads.count
        children = f"; separators {child.count} ({child.why})" if shared else ""
        demucs = self.demucs_jobs
        return (
            f"concurrency {self.concurrency.count} ({self.concurrency.why})",
            f"threads {threads} ({self.threads.why}){children}; demucs -j {demucs.count} ({demucs.why})",
            f"asr compute {self.asr_compute} ({self.asr_compute_why})",
            "warm-up on (ENCORE_WARMUP=0 turns it off)" if self.warmup else "warm-up off (ENCORE_WARMUP=0)",
        )


def resolve_profile(
    *,
    concurrency: int | None,
    threads: int | None,
    demucs_jobs: int | None,
    asr_compute: str | None,
    warmup: bool,
    device: str,
    cores: int | None = None,
) -> Profile:
    """The boot profile: each setting's explicit value when one was set, else the auto pick for this box."""
    n = cores if cores is not None else cpu_count()
    jobs = resolve_concurrency(concurrency)
    if threads:
        picked_threads = Jobs(threads, f"explicitly configured {threads} (ENCORE_THREADS)")
        child = picked_threads
    elif device != "cpu":
        picked_threads = Jobs(0, f"auto ({device}: the work is on the accelerator)")
        child = picked_threads
    else:
        # The in-process models take turns behind ML_LOCK, so only the separator children share the cores.
        picked_threads = Jobs(n, f"auto {n} (cpu, {n} cores; the models take turns)")
        each = max(1, n // jobs.count)
        child = Jobs(each, f"auto {each} ({n} cores / {jobs.count} at once)")
    if asr_compute:
        compute, compute_why = asr_compute, "explicitly configured (ENCORE_ASR_COMPUTE)"
    else:
        # float16 is an optimisation on CUDA alone; elsewhere it reads as a bad transcription, not a dtype
        # error. int8 is never picked: it is unmeasured against the alignment corpus.
        compute = "float16" if device == "cuda" else "float32"
        compute_why = f"auto ({device})"
    return Profile(
        concurrency=jobs,
        threads=picked_threads,
        demucs_jobs=resolve_demucs_jobs(demucs_jobs, device=device),
        asr_compute=compute,
        asr_compute_why=compute_why,
        warmup=warmup,
        separator_threads=child,
    )


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
        missing.append(f"--remote-components ejs:github in a yt-dlp config ({', '.join(config_paths)})")
    return " and ".join(missing) or None


def _mentions(path: str, text: str) -> bool:
    """Does an uncommented line of this config name `text`? A `# --remote-components ...` sets nothing."""
    try:
        with open(path, encoding="utf-8") as fh:
            return any(text in line for line in fh if not line.lstrip().startswith("#"))
    except (OSError, UnicodeDecodeError):
        return False
