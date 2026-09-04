"""Worker configuration. The rules under test are the ones that decide whether a misconfigured box
fails loudly, fails silently, or keeps working:

  - a malformed number must NEVER become zero (a worker with concurrency=0 accepts no jobs and looks
    exactly like a network problem),
  - an unset knob must be OMITTED from the CLI so upstream defaults keep applying, rather than being
    passed as a guessed value,
  - every rejection must be reported in `warnings`, because config that is silently ignored is worse
    than config that is refused.
"""
from src.config import WorkerConfig, auto_demucs_jobs, auto_torch_threads
from src import demucs


def test_defaults_are_the_shipped_behaviour():
    c = WorkerConfig.from_env({})
    # The WHOLE cook, not just separation. A stems-only default silently breaks the quickstart: the
    # core still enqueues `fetch` and `align`, nothing claims them, and the song sits at 0% or never
    # gets lyrics — indistinguishable from a hung worker.
    assert c.capabilities == ("fetch:ytdlp", "stems", "align")
    assert c.concurrency == 1
    assert c.demucs_model == "htdemucs"
    assert c.demucs_jobs == auto_demucs_jobs()  # scales with the box, not a hardcoded guess
    assert c.stem_bitrate == "192k"
    # unset = let the tool decide; we do not invent a value
    assert c.demucs_device is None
    assert c.demucs_overlap is None
    assert c.demucs_segment is None
    assert c.demucs_shifts is None
    # torch_threads is the ONE exception to "unset = let the tool decide": leaving it alone means every
    # one of `concurrency x demucs_jobs` separations defaults to all cores and they fight. Derived from
    # the box rather than hardcoded, so this asserts the derivation and not one machine's answer.
    assert c.torch_threads == auto_torch_threads(c.concurrency, c.demucs_jobs)
    assert c.warnings == ()


def test_every_perf_knob_is_settable():
    c = WorkerConfig.from_env({
        "ENCORE_DEMUCS_MODEL": "htdemucs_ft",
        "ENCORE_DEMUCS_DEVICE": "cuda:1",
        "ENCORE_DEMUCS_JOBS": "8",
        "ENCORE_DEMUCS_OVERLAP": "0.1",
        "ENCORE_DEMUCS_SEGMENT": "7",
        "ENCORE_DEMUCS_SHIFTS": "2",
        "ENCORE_TORCH_THREADS": "4",
        "ENCORE_WORKER_CONCURRENCY": "3",
        "ENCORE_STEM_BITRATE": "256k",
        "ENCORE_FLAC_LEVEL": "5",
        "ENCORE_FFMPEG_BIN": "/opt/ffmpeg",
    })
    assert (c.demucs_model, c.demucs_device, c.demucs_jobs) == ("htdemucs_ft", "cuda:1", 8)
    assert (c.demucs_overlap, c.demucs_segment, c.demucs_shifts) == (0.1, 7, 2)
    assert (c.torch_threads, c.concurrency) == (4, 3)
    assert (c.stem_bitrate, c.flac_level, c.ffmpeg_bin) == ("256k", 5, "/opt/ffmpeg")
    assert c.warnings == ()


def test_auto_jobs_scales_with_cores_and_never_ooms_a_small_box():
    # Each job holds its own model copy, so the default must not assume a big machine.
    assert auto_demucs_jobs(1) == 1
    assert auto_demucs_jobs(4) == 1
    assert auto_demucs_jobs(8) == 1
    assert auto_demucs_jobs(16) == 2
    assert auto_demucs_jobs(32) == 4
    assert auto_demucs_jobs(128) == 4, "capped: measured gains are flat past 4"


def test_auto_torch_threads_divides_the_box_among_contending_separations():
    # 32 cores, 2 concurrent songs x 4 chunk jobs = 8 processes -> 4 threads each, i.e. one per core.
    assert auto_torch_threads(2, 4, 32) == 4
    assert auto_torch_threads(1, 4, 32) == 8
    assert auto_torch_threads(4, 4, 16) == 1
    # Never zero: a thread cap of 0 would be a worker that separates nothing.
    assert auto_torch_threads(8, 8, 4) == 1


def test_auto_torch_threads_declines_when_nothing_can_contend():
    # os.cpu_count() reports LOGICAL cpus while torch's own default is physical-core aware, so pinning
    # to it with no contention could only make a single separation slower on an SMT box.
    assert auto_torch_threads(1, 1, 32) is None
    assert auto_torch_threads(0, 0, 32) is None, "clamped to 1x1, still nothing to divide"


def test_threads_default_is_derived_but_an_explicit_value_always_wins():
    derived = WorkerConfig.from_env({"ENCORE_WORKER_CONCURRENCY": "2", "ENCORE_DEMUCS_JOBS": "4"})
    assert derived.torch_threads == auto_torch_threads(2, 4)
    explicit = WorkerConfig.from_env(
        {"ENCORE_WORKER_CONCURRENCY": "2", "ENCORE_DEMUCS_JOBS": "4", "ENCORE_TORCH_THREADS": "16"}
    )
    assert explicit.torch_threads == 16, "a deliberate over-commit is the operator's call"


def test_garbage_falls_back_and_is_REPORTED_never_silently_zero():
    c = WorkerConfig.from_env({"ENCORE_WORKER_CONCURRENCY": "banana", "ENCORE_DEMUCS_JOBS": "0"})
    assert c.concurrency == 1, "a worker that accepts no jobs looks like a network fault"
    assert c.demucs_jobs == auto_demucs_jobs()
    assert len(c.warnings) == 2
    assert any("banana" in w for w in c.warnings)


def test_out_of_range_values_are_ignored_not_clamped_silently():
    c = WorkerConfig.from_env({"ENCORE_DEMUCS_OVERLAP": "5"})  # overlap is a 0..1 fraction
    assert c.demucs_overlap is None
    assert any("ENCORE_DEMUCS_OVERLAP" in w for w in c.warnings)


def test_shifts_may_be_zero_but_jobs_may_not():
    # shifts=0 is meaningful (no shift averaging); jobs=0 would mean "no work".
    assert WorkerConfig.from_env({"ENCORE_DEMUCS_SHIFTS": "0"}).demucs_shifts == 0
    assert WorkerConfig.from_env({"ENCORE_DEMUCS_JOBS": "0"}).demucs_jobs == auto_demucs_jobs()


def test_empty_capabilities_does_not_produce_a_useless_worker():
    c = WorkerConfig.from_env({"ENCORE_WORKER_CAPABILITIES": " , ,"})
    assert c.capabilities == ("fetch:ytdlp", "stems", "align")
    assert c.warnings


def test_describe_names_the_throughput_settings():
    line = WorkerConfig.from_env({"ENCORE_DEMUCS_JOBS": "8", "ENCORE_DEMUCS_DEVICE": "cuda"}).describe()
    assert "jobs=8" in line and "device=cuda" in line and "concurrency=1" in line


# ── the flags actually reach the CLI ────────────────────────────────────────────────
def test_unset_knobs_are_OMITTED_so_demucs_defaults_apply():
    argv = demucs.demucs_argv("in.wav", "/out")
    for flag in ("-j", "--overlap", "--segment", "--shifts", "-d"):
        assert flag not in argv, f"{flag} must not be passed when unset"
    assert argv[-1] == "in.wav"  # input stays last


def test_set_knobs_reach_the_cli_in_a_valid_shape():
    argv = demucs.demucs_argv("in.wav", "/out", "htdemucs_ft", device="cuda", jobs=8, overlap=0.1, segment=7, shifts=2)
    joined = " ".join(argv)
    assert "-n htdemucs_ft" in joined
    assert "-d cuda" in joined and "-j 8" in joined
    assert "--overlap 0.1" in joined and "--segment 7" in joined and "--shifts 2" in joined
    assert argv[-1] == "in.wav"


def test_jobs_of_one_is_not_passed_since_it_is_the_default():
    assert "-j" not in demucs.demucs_argv("in.wav", "/out", jobs=1)
