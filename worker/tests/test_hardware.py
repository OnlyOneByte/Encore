"""Hardware probing — the container-awareness that makes the auto-sizers honest.

Every cgroup reader takes a `root`, so these tests build fixture trees rather than asserting anything
about the machine running them. That matters here more than usual: the bug being tested for is
invisible on an un-contained box, so a test that reads the real /sys would pass on this dev box
whether the code worked or not.
"""

from __future__ import annotations

import os

from src.host import hardware


def _tree(tmp_path, files: dict[str, str]) -> str:
    for rel, body in files.items():
        p = tmp_path / rel.lstrip("/")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body)
    return str(tmp_path)


# ── cpu quota ───────────────────────────────────────────────────────────────────────
def test_cgroup_v2_quota_is_read_as_fractional_cores(tmp_path):
    # 150000/100000 = 1.5 cores. Fractional on purpose: rounding up to 2 re-creates the
    # oversubscription this exists to prevent.
    root = _tree(tmp_path, {"sys/fs/cgroup/cpu.max": "150000 100000\n"})
    assert hardware.cgroup_cpu_quota(root) == 1.5


def test_cgroup_v2_max_means_unlimited(tmp_path):
    root = _tree(tmp_path, {"sys/fs/cgroup/cpu.max": "max 100000\n"})
    assert hardware.cgroup_cpu_quota(root) is None


def test_cgroup_v1_quota_is_read_too(tmp_path):
    # v1 is still the live layout on Amazon Linux 2, and a v2-only reader silently reports "no limit"
    # there — the same outcome as not looking at all.
    root = _tree(
        tmp_path,
        {
            "sys/fs/cgroup/cpu/cpu.cfs_quota_us": "200000\n",
            "sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
        },
    )
    assert hardware.cgroup_cpu_quota(root) == 2.0


def test_cgroup_v1_negative_quota_means_unlimited(tmp_path):
    root = _tree(
        tmp_path,
        {
            "sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1\n",
            "sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
        },
    )
    assert hardware.cgroup_cpu_quota(root) is None


def test_absent_cgroup_is_not_an_error(tmp_path):
    assert hardware.cgroup_cpu_quota(str(tmp_path)) is None


# ── memory ──────────────────────────────────────────────────────────────────────────
def test_cgroup_v1_unlimited_sentinel_is_not_mistaken_for_a_real_limit(tmp_path):
    # v1 reports a page-aligned INT64_MAX rather than the string "max", so an exact == check misses it
    # and the worker would believe it had 8 exabytes.
    root = _tree(tmp_path, {"sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n"})
    assert hardware.cgroup_memory_limit(root) is None


def test_a_real_memory_ceiling_is_reported(tmp_path):
    root = _tree(tmp_path, {"sys/fs/cgroup/memory.max": str(2 * 1024**3) + "\n"})
    assert hardware.cgroup_memory_limit(root) == 2 * 1024**3


def test_meminfo_is_converted_from_kb_to_bytes(tmp_path):
    root = _tree(tmp_path, {"proc/meminfo": "MemTotal:       1024 kB\nMemAvailable:    512 kB\n"})
    assert hardware.meminfo_bytes("MemAvailable", root) == 512 * 1024
    assert hardware.meminfo_bytes("MemTotal", root) == 1024 * 1024


def test_available_memory_takes_the_tighter_of_cgroup_and_meminfo(tmp_path):
    # The container ceiling wins even when the host has plenty free — that is the whole point.
    root = _tree(
        tmp_path,
        {
            "proc/meminfo": f"MemAvailable: {64 * 1024 * 1024} kB\n",  # 64 GiB
            "sys/fs/cgroup/memory.max": str(2 * 1024**3) + "\n",  # 2 GiB
        },
    )
    assert hardware.available_memory_bytes(root) == 2 * 1024**3


def test_unknowable_memory_is_None_not_zero(tmp_path):
    # A caller must be able to tell "no limit known" from "no memory", because zero would make every
    # sizing decision refuse to run anything.
    assert hardware.available_memory_bytes(str(tmp_path)) is None


# ── effective cpus ──────────────────────────────────────────────────────────────────
def test_effective_cpus_honours_a_container_quota(tmp_path):
    # THE bug this module exists for: os.cpu_count() reports the host's cores inside a throttled
    # container, so a 2-core container would start 4 model-holding jobs and every song gets slower.
    root = _tree(tmp_path, {"sys/fs/cgroup/cpu.max": "200000 100000\n"})
    assert hardware.effective_cpus(root) == 2


def test_effective_cpus_floors_a_fractional_quota(tmp_path):
    # 1.5 cores schedules like 1 for a model-holding process; rounding up would oversubscribe.
    root = _tree(tmp_path, {"sys/fs/cgroup/cpu.max": "150000 100000\n"})
    assert hardware.effective_cpus(root) == 1


def test_effective_cpus_never_returns_zero(tmp_path):
    # A zero would propagate into `//` divisions and yield a worker that accepts no work — which reads
    # as a network fault rather than a config one.
    root = _tree(tmp_path, {"sys/fs/cgroup/cpu.max": "1000 100000\n"})  # 0.01 cores
    assert hardware.effective_cpus(root) >= 1


def test_effective_cpus_falls_back_to_the_host_when_uncontained(tmp_path, monkeypatch):
    # On a plain host all the cgroup files are absent and the answer must be the machine's own count.
    # Pin an INDEPENDENT expected value instead of re-deriving min(cpu_count, affinity): fix both
    # sources to a known 8 (host and affinity agree, no cgroup files) and assert the answer is 8. The
    # old form recomputed the code's own expression, so it agreed with any composition of the two.
    monkeypatch.setattr(os, "cpu_count", lambda: 8)
    monkeypatch.setattr(os, "sched_getaffinity", lambda _pid: set(range(8)))
    assert hardware.effective_cpus(str(tmp_path)) == 8


def test_effective_cpus_honours_a_cpuset_pin_below_the_host_count(tmp_path, monkeypatch):
    # The cpuset case the module docstring exists to catch: a many-core host pinned to a 2-CPU set via
    # `docker run --cpuset-cpus=0,1`, systemd AllowedCPUs=, or a k8s static CPU pin. Cpuset leaves no
    # CFS quota, so cgroup_cpu_quota() is None and affinity is the ONLY signal that the worker is
    # confined. Independent values (host says 8, affinity says 2, no cgroup files) — the answer must
    # be 2, not 8. Drops if the affinity candidate stops being appended.
    monkeypatch.setattr(os, "cpu_count", lambda: 8)
    monkeypatch.setattr(os, "sched_getaffinity", lambda _pid: {0, 1})
    assert hardware.effective_cpus(str(tmp_path)) == 2


def test_effective_cpus_takes_the_tighter_of_a_cpuset_pin_and_a_quota(tmp_path, monkeypatch):
    # Both a cpuset pin (affinity=2) and a CFS quota (8 cores) present: the tighter — the cpuset — must
    # win. Pins that affinity is composed with the quota rather than either shadowing the other.
    root = _tree(tmp_path, {"sys/fs/cgroup/cpu.max": "800000 100000\n"})  # 8 cores
    monkeypatch.setattr(os, "cpu_count", lambda: 16)
    monkeypatch.setattr(os, "sched_getaffinity", lambda _pid: {0, 1})
    assert hardware.effective_cpus(root) == 2


# ── accelerator + report ────────────────────────────────────────────────────────────
def test_accelerator_detection_survives_torch_being_absent():
    # torch is genuinely not installed in this test environment, and the worker must still start: the
    # stub processor needs no ML at all, and a CPU process is a valid outcome, not a crash.
    accel = hardware.detect_accelerator()
    assert accel.kind == "cpu"


def test_host_facts_reports_the_EFFECTIVE_core_count_not_the_hosts():
    # The wire shape lives in protocol.host_facts(), which delegates here rather than re-deriving the
    # fields. That delegation is the point: the auto-sizers already need the effective count, and a
    # dashboard reporting os.cpu_count() beside a worker that sized itself for 2 of those 32 cores
    # shows two disagreeing numbers with neither labelled.
    from src import protocol

    facts = protocol.host_facts()
    assert facts["cpuCount"] == hardware.effective_cpus()
    assert facts["accelerator"] in ("cuda", "rocm", "xpu", "mps", "cpu")
    # `cuda` is kept for readers that already branch on it, and must agree with `accelerator` — a plain
    # boolean previously reported an AMD/ROCm card as NVIDIA, since ROCm reports through torch's cuda API.
    assert facts["cuda"] is (facts["accelerator"] == "cuda")
    assert "contained" in facts
    for k in ("platform", "machine", "python"):
        assert facts[k]


def test_host_facts_never_fails_the_handshake_over_a_diagnostic(monkeypatch):
    # A probe that raised here would take down a worker for the sake of a dashboard field.
    def boom(*_a, **_k):
        raise RuntimeError("probe exploded")

    monkeypatch.setattr(hardware, "probe", boom)
    from src import protocol

    facts = protocol.host_facts()
    assert facts["platform"] and facts["machine"] and facts["python"]


def test_describe_is_readable_and_mentions_the_accelerator():
    line = hardware.probe().describe()
    assert "accel=" in line and "cpus=" in line


# ── worker identity ─────────────────────────────────────────────────────────────────
def test_default_worker_id_is_unique_per_process_not_a_shared_constant():
    # The old fallback was the literal "worker-1", so two workers with the id unset both announced it —
    # and since the core keys its registry by workerId, the second hello REPLACED the first instead of
    # joining the fleet. Half the fleet vanishing is not detectable from either side.
    wid = hardware.default_worker_id()
    assert wid != "worker-1"
    assert str(os.getpid()) in wid


def test_default_worker_id_is_stable_within_a_process():
    # A reconnecting worker should look like the SAME worker, not a new one, or the core accumulates
    # dead sessions across every restart.
    assert hardware.default_worker_id() == hardware.default_worker_id()
