"""What this box actually is — probed, never configured.

Everything here answers a question the WORKER is better placed to answer than any human editing a
compose file: how many cores can this process really use, how much memory, which accelerator. The
results feed three consumers: the auto-sizers in config.py, the capability probe in capabilities.py,
and the hardware report the worker sends to the core on `worker:hello`.

Two rules, both learned the hard way:

  * PRESENCE IS NOT SUFFICIENCY. A probe reports that a device exists, never that it is big enough
    or that every kernel a model needs is implemented. `cuda.is_available()` says a card is there,
    not that the checkpoint fits. So nothing here promises a cook will succeed; the values are for
    SIZING and for REPORTING, and the honest failure mode is still an OOM at run time.
  * ASK THE CGROUP, NOT THE HOST. `os.cpu_count()` reports the machine's cores even when the
    container is throttled to two of them, so a container-blind auto-sizer cheerfully starts 4
    model-holding jobs on a 2-core budget and every song gets slower. That bug is invisible on an
    un-contained box, which is exactly why it survives so long.

PURE-ish: every reader takes an optional root/env so tests can point it at a fixture tree instead of
the live /sys and /proc.
"""
from __future__ import annotations

import os
import platform
import socket
from dataclasses import dataclass

#: cgroup v2 then v1 locations for the CPU quota and the memory ceiling. Both layouts are still in
#: the wild (Amazon Linux 2 is v1, most modern distros are v2), and a v2-only reader silently
#: reports "no limit" on v1 — the same failure as not looking at all.
_CPU_MAX_V2 = "/sys/fs/cgroup/cpu.max"
_CPU_QUOTA_V1 = "/sys/fs/cgroup/cpu/cpu.cfs_quota_us"
_CPU_PERIOD_V1 = "/sys/fs/cgroup/cpu/cpu.cfs_period_us"
_MEM_MAX_V2 = "/sys/fs/cgroup/memory.max"
_MEM_MAX_V1 = "/sys/fs/cgroup/memory/memory.limit_in_bytes"

#: Values at or above this are the kernel's "unlimited" sentinel rather than a real ceiling. cgroup
#: v1 reports a page-aligned INT64_MAX (9223372036854771712), so an exact == check misses it.
_UNLIMITED = 2**62


def _read(path: str, root: str = "") -> str | None:
    try:
        with open(os.path.join(root, path.lstrip("/")) if root else path, encoding="utf-8") as fh:
            return fh.read().strip()
    except (OSError, ValueError):
        return None


def cgroup_cpu_quota(root: str = "") -> float | None:
    """CPU cores this cgroup may use, or None when unlimited/absent.

    Fractional on purpose: a 1500ms/1000ms quota is 1.5 cores and rounding it up to 2 re-introduces
    the oversubscription this exists to prevent.
    """
    v2 = _read(_CPU_MAX_V2, root)
    if v2:
        parts = v2.split()
        if parts and parts[0] != "max":
            try:
                period = float(parts[1]) if len(parts) > 1 else 100_000.0
                quota = float(parts[0])
                if period > 0 and quota > 0:
                    return quota / period
            except (ValueError, IndexError):
                pass
    quota_raw = _read(_CPU_QUOTA_V1, root)
    period_raw = _read(_CPU_PERIOD_V1, root)
    if quota_raw and period_raw:
        try:
            quota, period = float(quota_raw), float(period_raw)
            if quota > 0 and period > 0:  # -1 is v1's "unlimited"
                return quota / period
        except ValueError:
            pass
    return None


def cgroup_memory_limit(root: str = "") -> int | None:
    """Memory ceiling in bytes for this cgroup, or None when unlimited/absent."""
    for path in (_MEM_MAX_V2, _MEM_MAX_V1):
        raw = _read(path, root)
        if not raw or raw == "max":
            continue
        try:
            v = int(raw)
        except ValueError:
            continue
        if 0 < v < _UNLIMITED:
            return v
    return None


def meminfo_bytes(key: str = "MemAvailable", root: str = "") -> int | None:
    """A /proc/meminfo field in bytes. `MemAvailable` is the useful one — it is what can be handed
    out without swapping, whereas `MemTotal` includes memory already spoken for."""
    raw = _read("/proc/meminfo", root)
    if not raw:
        return None
    for line in raw.splitlines():
        if line.startswith(f"{key}:"):
            parts = line.split()
            if len(parts) >= 2:
                try:
                    return int(parts[1]) * 1024  # meminfo is in kB
                except ValueError:
                    return None
    return None


def effective_cpus(root: str = "") -> int:
    """Cores this process can ACTUALLY use — the tightest of three different lies.

    `os.cpu_count()` is the machine. `sched_getaffinity` catches cpuset pinning but not a CFS quota,
    so a container limited to 1.5 cores still reports all 32. The cgroup quota catches that. Taking
    the minimum of all three is the only value that is right in every case, and it degrades to
    `cpu_count` on a plain host where the others are absent.

    Never returns 0: a zero here would propagate into `//` divisions and produce a worker that
    accepts no work, which reads as a network fault rather than a config one.
    """
    candidates: list[int] = []
    host = os.cpu_count()
    if host:
        candidates.append(host)
    # Linux-only; absent on macOS, where a native worker is a supported deployment.
    affinity = getattr(os, "sched_getaffinity", None)
    if affinity is not None:
        try:
            candidates.append(len(affinity(0)))
        except OSError:
            pass
    quota = cgroup_cpu_quota(root)
    if quota is not None:
        candidates.append(max(1, int(quota)))  # floor: 1.5 cores schedules like 1
    return max(1, min(candidates)) if candidates else 1


def available_memory_bytes(root: str = "") -> int | None:
    """Memory this worker can count on, honouring a container ceiling. None when nothing is knowable
    (a non-Linux box), which callers must treat as "do not enforce", never as zero."""
    limit = cgroup_memory_limit(root)
    avail = meminfo_bytes("MemAvailable", root)
    known = [v for v in (limit, avail) if v]
    return min(known) if known else None


# ── accelerator ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Accelerator:
    """A detected compute device. `vram_bytes` is PHYSICAL capacity, not free memory."""

    kind: str  # "cuda" | "xpu" | "mps" | "rocm" | "cpu"
    name: str = ""
    count: int = 1
    vram_bytes: int | None = None


def detect_accelerator() -> Accelerator:
    """The accelerator torch can reach here, or a cpu Accelerator.

    Deliberately tolerant: torch may be absent entirely (the stub processor needs no ML), the wheel
    may be built for a different backend than the box has, and a driver mismatch raises rather than
    returning False. Every one of those is a cpu answer, not a crash — the worker must still start
    and still cook, just slower.

    ROCm masquerades as `cuda` in torch's API (there is no `torch.rocm`), so `torch.version.hip` is
    the only way to tell the two apart, and it matters for the report: "cuda" on an AMD card would
    send the core a hardware fact that is wrong.
    """
    try:
        import torch
    except Exception:
        return Accelerator(kind="cpu", name=platform.machine())

    try:
        if torch.cuda.is_available():
            is_rocm = bool(getattr(torch.version, "hip", None))
            props = torch.cuda.get_device_properties(0)
            return Accelerator(
                kind="rocm" if is_rocm else "cuda",
                name=getattr(props, "name", ""),
                count=torch.cuda.device_count(),
                vram_bytes=getattr(props, "total_memory", None),
            )
    except Exception:
        pass
    try:
        xpu = getattr(torch, "xpu", None)  # absent on non-xpu wheels; attribute access would raise
        if xpu is not None and xpu.is_available():
            name = ""
            vram = None
            try:
                props = xpu.get_device_properties(0)
                name = getattr(props, "name", "")
                vram = getattr(props, "total_memory", None)
            except Exception:
                pass
            return Accelerator(kind="xpu", name=name, count=xpu.device_count(), vram_bytes=vram)
    except Exception:
        pass
    try:
        if torch.backends.mps.is_available():
            # Unified memory: there is no separate VRAM figure to report, and reporting system RAM
            # would overstate what a model can actually claim.
            return Accelerator(kind="mps", name="Apple Silicon (Metal)")
    except Exception:
        pass
    return Accelerator(kind="cpu", name=platform.machine())


def free_vram_bytes() -> int | None:
    """FREE accelerator memory, which is what a segment size must fit inside. Distinct from
    `Accelerator.vram_bytes`: another process may already hold most of the card."""
    try:
        import torch

        if torch.cuda.is_available():
            free, _total = torch.cuda.mem_get_info()
            return int(free)
    except Exception:
        pass
    return None


# ── the report ────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class HardwareReport:
    """What this worker tells the core about itself on `worker:hello`.

    The core resolves the cost-bearing choices (which engine, which model) but has historically done
    so blind — `estimateCookSeconds` takes a `hardwareFactor` that nothing ever supplied, so every
    estimate assumed the reference box. This is the payload that makes that number real, and it is
    also what lets the core say "the connected worker will take eight minutes for this" instead of
    quoting a figure from different silicon.
    """

    accelerator: str  # "cuda" | "xpu" | "mps" | "rocm" | "cpu"
    device_name: str
    device_count: int
    cpus: int  # EFFECTIVE cores, not the host's
    memory_bytes: int | None
    vram_bytes: int | None
    platform_name: str
    machine: str
    torch_version: str | None
    contained: bool  # a cgroup limit is in force, so `cpus` is below the host's count

    # No `to_wire()` here on purpose: the wire shape is assembled by protocol.host_facts(), which owns
    # the WorkerHost field names (camelCase, and `cpuCount` rather than `cpus`). A second serializer
    # would be a second place to update when that contract moves.

    def describe(self) -> str:
        bits = [f"accel={self.accelerator}", f"cpus={self.cpus}"]
        if self.device_name:
            bits.append(f"device={self.device_name!r}")
        if self.device_count > 1:
            bits.append(f"devices={self.device_count}")
        if self.vram_bytes:
            bits.append(f"vram={self.vram_bytes // (1024**3)}GiB")
        if self.memory_bytes:
            bits.append(f"mem={self.memory_bytes // (1024**3)}GiB")
        if self.contained:
            bits.append("contained")
        return " ".join(bits)


def probe(root: str = "") -> HardwareReport:
    """One full hardware probe. Called once at startup — it imports torch, so it is not free."""
    accel = detect_accelerator()
    cpus = effective_cpus(root)
    host = os.cpu_count() or cpus
    try:
        import torch

        torch_version = str(torch.__version__)
    except Exception:
        torch_version = None
    return HardwareReport(
        accelerator=accel.kind,
        device_name=accel.name,
        device_count=accel.count,
        cpus=cpus,
        memory_bytes=available_memory_bytes(root),
        vram_bytes=accel.vram_bytes,
        platform_name=platform.system(),
        machine=platform.machine(),
        torch_version=torch_version,
        contained=cpus < host,
    )


def default_worker_id() -> str:
    """A stable, unique-enough worker id derived from the box.

    Replaces a hardcoded fallback of "worker-1", which two unset workers both announced — and since
    the core keys its registry by workerId, the second hello REPLACED the first rather than joining
    the fleet. Half the fleet silently vanishing is not a failure either side can detect.

    Hostname-based so it stays the same across a restart (a reconnecting worker should look like the
    same worker, not a new one); pid-suffixed so two workers on one host still differ.
    """
    try:
        host = socket.gethostname().split(".")[0] or "worker"
    except Exception:
        host = "worker"
    return f"{host}-{os.getpid()}"
