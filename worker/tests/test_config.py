"""Worker configuration. The rules under test are the ones that decide whether a misconfigured box
fails loudly, fails silently, or keeps working:

  - a malformed number must NEVER become zero (a worker with concurrency=0 accepts no jobs and looks
    exactly like a network problem),
  - an unset knob must be OMITTED from the CLI so upstream defaults keep applying, rather than being
    passed as a guessed value,
  - every rejection must be reported in `warnings`, because config that is silently ignored is worse
    than config that is refused.
"""

from src.config import WorkerConfig, auto_demucs_jobs, auto_torch_threads, resolve, whisperx_device_for
from src.separation import demucs


def test_defaults_are_the_shipped_behaviour():
    c = WorkerConfig.from_env({})
    # Capabilities are no longer DECLARED here. from_env is pure over env, and what a box can actually
    # do depends on PATH and importable modules — host facts. So the env layer carries only an optional
    # narrowing override, and the effective set is filled in by config.resolve() from probes.
    assert c.capabilities == (), "unresolved until probed — never a hardcoded guess"
    assert c.capabilities_override is None, "no override means 'advertise everything provable'"
    assert c.concurrency == 1
    assert c.demucs_model == "htdemucs"
    assert c.demucs_jobs == auto_demucs_jobs()  # scales with the box, not a hardcoded guess
    # unset = let the tool decide; we do not invent a value
    assert c.device is None
    assert c.demucs_overlap is None
    assert c.demucs_segment is None
    assert c.demucs_shifts is None
    # Alignment no longer defaults to a hardcoded "cpu" — that made a GPU box transcribe on the CPU
    # unless a human set a second variable. None means "derive it from the resolved device".
    assert c.whisperx_device is None
    # torch_threads is the ONE exception to "unset = let the tool decide": leaving it alone means every
    # one of `concurrency x demucs_jobs` separations defaults to all cores and they fight. Derived from
    # the box rather than hardcoded, so this asserts the derivation and not one machine's answer.
    assert c.torch_threads == auto_torch_threads(c.concurrency, c.demucs_jobs)
    assert c.warnings == ()


def test_every_perf_knob_is_settable():
    c = WorkerConfig.from_env(
        {
            "ENCORE_DEMUCS_MODEL": "htdemucs_ft",
            "ENCORE_DEVICE": "cuda:1",
            "ENCORE_DEMUCS_JOBS": "8",
            "ENCORE_DEMUCS_OVERLAP": "0.1",
            "ENCORE_DEMUCS_SEGMENT": "7",
            "ENCORE_DEMUCS_SHIFTS": "2",
            "ENCORE_TORCH_THREADS": "4",
            "ENCORE_WORKER_CONCURRENCY": "3",
            "ENCORE_FLAC_LEVEL": "5",
            "ENCORE_FFMPEG_BIN": "/opt/ffmpeg",
            # These three were previously omitted despite the test's name claiming completeness, so a
            # deployment that stopped reading any of them would have shipped green. ENCORE_WHISPERX_DEVICE
            # is the operator override for the alignment device; ENCORE_SEPARATOR_BACKEND selects the
            # separation implementation; ENCORE_ANNOTATE toggles the MusicBrainz identify step.
            "ENCORE_WHISPERX_DEVICE": "cuda",
            "ENCORE_SEPARATOR_BACKEND": "mlx",
            "ENCORE_ANNOTATE": "0",
        }
    )
    assert (c.demucs_model, c.device, c.demucs_jobs) == ("htdemucs_ft", "cuda:1", 8)
    assert (c.demucs_overlap, c.demucs_segment, c.demucs_shifts) == (0.1, 7, 2)
    assert (c.torch_threads, c.concurrency) == (4, 3)
    assert (c.flac_level, c.ffmpeg_bin) == (5, "/opt/ffmpeg")
    # from_env carries the operator override verbatim; whether it is HONOURED is decided later in
    # resolve() (see the whisperx-device tests below). Backend is lower-cased; annotate is a flag.
    assert c.whisperx_device == "cuda"
    assert c.separator_backend == "mlx"
    assert c.annotate is False
    assert c.warnings == ()


def test_legacy_demucs_device_still_works_but_says_it_is_deprecated():
    # An existing deployment must not break on upgrade — but the old name applied to separation only,
    # and now sets the device for the whole worker, which is what every operator setting it wanted.
    c = WorkerConfig.from_env({"ENCORE_DEMUCS_DEVICE": "cuda"})
    assert c.device == "cuda"
    assert any("deprecated" in w for w in c.warnings)


def test_the_new_device_name_wins_over_the_legacy_one():
    c = WorkerConfig.from_env({"ENCORE_DEVICE": "cuda", "ENCORE_DEMUCS_DEVICE": "cpu"})
    assert c.device == "cuda"
    assert any("ENCORE_DEVICE wins" in w for w in c.warnings)


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


def test_blank_capability_override_is_treated_as_absent_not_as_an_empty_set():
    # " , ," must mean "no override given", NOT "advertise nothing". Reading it as an empty set would
    # produce a worker that connects and is never given work — the exact silent failure the probe
    # exists to remove.
    c = WorkerConfig.from_env({"ENCORE_WORKER_CAPABILITIES": " , ,"})
    assert c.capabilities_override is None


def test_blank_env_vars_fall_back_to_defaults_not_to_empty_strings():
    # Compose plumbs optional overrides as `FOO=${FOO:-}`, which puts an EMPTY STRING in the
    # environment rather than leaving it absent. `dict.get(key, default)` sees a present value and
    # returns "", so an unset override became demucs_model="" — a worker that passes `-n ''` to demucs
    # and fails every cook for a reason the config line would not explain.
    blank = {
        k: ""
        for k in (
            "ENCORE_CORE_WS",
            "ENCORE_WORKER_ID",
            "ENCORE_WORKER_VERSION",
            "MEDIA_DIR",
            "ENCORE_PROCESSOR",
            "ENCORE_DEMUCS_MODEL",
            "ENCORE_ASR_MODEL",
            "ENCORE_SYNC_MODE",
            "ENCORE_LRCLIB_BASE",
            "ENCORE_YTDLP_BIN",
            "ENCORE_DEMUCS_BIN",
            "ENCORE_FFMPEG_BIN",
            "ENCORE_WORKER_CAPABILITIES",
            "ENCORE_DEVICE",
            "ENCORE_WORKER_CONCURRENCY",
            "ENCORE_DEMUCS_JOBS",
            "ENCORE_TORCH_THREADS",
            "ENCORE_FLAC_LEVEL",
        )
    }
    c = WorkerConfig.from_env(blank)
    assert c.demucs_model == "htdemucs"
    assert c.core_ws == "ws://localhost:3000/ws?role=worker"
    assert c.media_dir == "/app/media"
    assert c.processor == "real"
    assert c.flac_level == 8
    assert (c.asr_model, c.sync_mode) == ("base", "forced")
    assert (c.ytdlp_bin, c.demucs_bin, c.ffmpeg_bin) == ("yt-dlp", "demucs", "ffmpeg")
    assert c.lrclib_base == "https://lrclib.net"
    assert c.concurrency == 1
    assert c.capabilities_override is None
    assert c.device is None
    assert c.warnings == (), "a blank override is not a misconfiguration and must not warn"


def test_describe_names_the_throughput_settings():
    line = WorkerConfig.from_env({"ENCORE_DEMUCS_JOBS": "8", "ENCORE_DEVICE": "cuda"}).describe()
    assert "jobs=8" in line and "device=cuda" in line and "concurrency=1" in line


# ── the flags actually reach the CLI ────────────────────────────────────────────────
def test_unset_knobs_are_OMITTED_so_demucs_defaults_apply():
    argv = demucs.demucs_argv("in.wav", "/out")
    for flag in ("-j", "--overlap", "--segment", "--shifts", "-d"):
        assert flag not in argv, f"{flag} must not be passed when unset"
    assert argv[-1] == "in.wav"  # input stays last


def test_set_knobs_reach_the_cli_in_a_valid_shape():
    argv = demucs.demucs_argv(
        "in.wav", "/out", "htdemucs_ft", device="cuda", jobs=8, overlap=0.1, segment=7, shifts=2
    )
    joined = " ".join(argv)
    assert "-n htdemucs_ft" in joined
    assert "-d cuda" in joined and "-j 8" in joined
    assert "--overlap 0.1" in joined and "--segment 7" in joined and "--shifts 2" in joined
    assert argv[-1] == "in.wav"


def test_jobs_of_one_is_not_passed_since_it_is_the_default():
    assert "-j" not in demucs.demucs_argv("in.wav", "/out", jobs=1)


# ── worker token (FIX 1: close the auth loop with the core's role=worker gate) ──────────
def test_worker_token_is_unset_by_default():
    c = WorkerConfig.from_env({})
    assert c.worker_token == ""


def test_worker_token_read_from_env():
    c = WorkerConfig.from_env({"ENCORE_WORKER_TOKEN": "s3cret"})
    assert c.worker_token == "s3cret"


def test_authed_core_ws_unset_token_is_byte_identical_to_core_ws():
    # The pre-auth behaviour: no token means the URL is passed through unchanged.
    c = WorkerConfig.from_env({"ENCORE_CORE_WS": "ws://host:3000/ws?role=worker"})
    assert c.worker_token == ""
    assert c.authed_core_ws() == "ws://host:3000/ws?role=worker"


def test_authed_core_ws_appends_token_when_url_already_has_a_query():
    # The documented form already carries ?role=worker, so the token must be an ADDITIONAL param.
    c = WorkerConfig.from_env(
        {"ENCORE_CORE_WS": "ws://host:3000/ws?role=worker", "ENCORE_WORKER_TOKEN": "abc123"}
    )
    url = c.authed_core_ws()
    from urllib.parse import parse_qs, urlsplit

    q = parse_qs(urlsplit(url).query)
    assert q["role"] == ["worker"]
    assert q["token"] == ["abc123"]
    assert urlsplit(url).path == "/ws"


def test_authed_core_ws_appends_token_when_url_has_no_query():
    c = WorkerConfig.from_env({"ENCORE_CORE_WS": "ws://host:3000/ws", "ENCORE_WORKER_TOKEN": "abc123"})
    url = c.authed_core_ws()
    from urllib.parse import parse_qs, urlsplit

    assert urlsplit(url).path == "/ws"
    assert parse_qs(urlsplit(url).query)["token"] == ["abc123"]


def test_authed_core_ws_replaces_a_pre_existing_token_rather_than_duplicating():
    c = WorkerConfig.from_env(
        {"ENCORE_CORE_WS": "ws://host/ws?role=worker&token=old", "ENCORE_WORKER_TOKEN": "new"}
    )
    from urllib.parse import parse_qs, urlsplit

    assert parse_qs(urlsplit(c.authed_core_ws()).query)["token"] == ["new"]


def test_describe_shows_token_presence_not_value():
    c = WorkerConfig.from_env({"ENCORE_WORKER_TOKEN": "TOP-SECRET-VALUE"})
    d = c.describe()
    assert "worker_token=set" in d
    assert "TOP-SECRET-VALUE" not in d
    assert WorkerConfig.from_env({}).describe().count("worker_token=unset") == 1


# ── segment sizing from FREE accelerator memory ───────────────────────────────────


def test_no_measurement_means_demucs_chooses():
    """CPU boxes and unmeasurable cards must not get a guessed flag: demucs' own default is better
    informed than a number invented here."""
    from src.config import auto_demucs_segment

    assert auto_demucs_segment(None) is None


def test_a_roomy_card_gets_no_segment_flag():
    """htdemucs cannot be given a segment longer than it was trained on, so there is nothing to win by
    passing one when memory is plentiful — only a constraint to accidentally impose."""
    from src.config import auto_demucs_segment

    assert auto_demucs_segment(11 * 1024**3) is None


def test_segment_shrinks_as_free_memory_shrinks():
    """The property that matters, asserted as monotonicity rather than by pinning each band: less free
    memory must never yield a LARGER chunk."""
    from src.config import auto_demucs_segment

    sizes = [auto_demucs_segment(int(g * 1024**3)) or 99 for g in (11, 5, 3.5, 1.5)]
    assert sizes == sorted(sizes, reverse=True), sizes


def test_a_nearly_full_card_still_gets_a_workable_chunk():
    """The case this exists for: a 12GiB card with a display server and another cook on it. A slow cook
    beats a CUDA OOM reported to the room as a failed song."""
    from src.config import auto_demucs_segment

    seg = auto_demucs_segment(int(1.2 * 1024**3))
    assert seg is not None and 1 <= seg <= 4


def test_free_memory_is_what_is_measured_not_physical_capacity():
    """The distinction the whole helper turns on. A card whose PHYSICAL size is large but which is
    mostly occupied must be sized for what is left."""
    from src.config import auto_demucs_segment

    assert auto_demucs_segment(int(2.0 * 1024**3)) == auto_demucs_segment(int(2.0 * 1024**3))
    # a 12GiB card with 2GiB free is sized like a small card, not like a 12GiB one
    assert auto_demucs_segment(int(2.0 * 1024**3)) is not None
    assert auto_demucs_segment(int(12.0 * 1024**3)) is None


# ── the alignment device (FIX: pin whisperx_device_for + config.resolve, which no test reached) ──────
#
# CTranslate2 (what whisperx transcribes through) has only a cuda backend and a cpu backend, so the
# one device that runs the whole worker cannot be handed straight to the aligner: an Intel/Apple box
# separates on its accelerator but must still align on the CPU. `whisperx_device_for` is that mapping
# and `resolve()` is the only thing that wires it, yet nothing exercised either — a `return "cpu"`
# regression (a CUDA box separating on the GPU then transcribing every song on the CPU: slow,
# correct-looking, and silent) would have shipped green. These assert the mapping AS VALUES and drive
# the real production functions, not a reimplementation.


def test_whisperx_device_for_maps_only_cuda_to_cuda():
    # A cuda device (with or without an ordinal) aligns on cuda; EVERYTHING else aligns on cpu, because
    # CTranslate2 has no xpu/mps backend. Asserting the concrete values kills a `return "cpu"` (the
    # pre-fix regression) and a `return "<garbage>"` alike.
    assert whisperx_device_for("cuda") == "cuda"
    assert whisperx_device_for("cuda:1") == "cuda"
    assert whisperx_device_for("cuda:0") == "cuda"
    for other in (None, "cpu", "xpu", "mps"):
        assert whisperx_device_for(other) == "cpu", other


def test_resolve_derives_the_align_device_from_the_separation_device():
    # The wiring at config.py:391. A GPU box with no explicit override must align on cuda, NOT fall back
    # to a hardcoded cpu — that fallback is the exact bug this code exists to prevent.
    resolved, _warnings = resolve(WorkerConfig.from_env({}), device="cuda:0")
    assert resolved.whisperx_device == "cuda"

    # No accelerator resolved: alignment stays on cpu.
    resolved_cpu, _w = resolve(WorkerConfig.from_env({}), device=None)
    assert resolved_cpu.whisperx_device == "cpu"


def test_resolve_lets_an_explicit_operator_override_win_over_the_derivation():
    # An operator who sets ENCORE_WHISPERX_DEVICE must have it honoured, not silently replaced by the
    # derived value. `cpu` on a cuda box is a real choice (e.g. the GPU is reserved for separation), so
    # the override has to survive resolve().
    resolved, _warnings = resolve(WorkerConfig.from_env({"ENCORE_WHISPERX_DEVICE": "cpu"}), device="cuda:0")
    assert resolved.whisperx_device == "cpu"


def test_resolve_warns_on_an_align_device_ctranslate2_cannot_use():
    # A typo like ENCORE_WHISPERX_DEVICE=mps must not be swallowed: CTranslate2 supports only cuda and
    # cpu, so alignment would fail, and the one message explaining why must be emitted.
    _resolved, warnings = resolve(WorkerConfig.from_env({"ENCORE_WHISPERX_DEVICE": "mps"}), device=None)
    assert any("CTranslate2" in w for w in warnings), warnings

    # A valid override (cuda / cuda:N / cpu) must NOT trigger that warning.
    for good in ("cpu", "cuda", "cuda:1"):
        _r, w = resolve(WorkerConfig.from_env({"ENCORE_WHISPERX_DEVICE": good}), device=None)
        assert not any("CTranslate2" in m for m in w), (good, w)


def test_annotate_flag_is_case_insensitive_like_its_siblings():
    # ENCORE_ANNOTATE was the only boolean parsed WITHOUT .lower(), so the natural
    # capitalized spellings silently left annotation ON on the very box the flag exists to spare.
    # Expected values are hard-coded (never derived through the config's own parse) so the assertion
    # cannot agree with a still-broken parse. off-spellings resolve to False; on-spellings to True.
    off_values = ["0", "false", "False", "FALSE", "no", "No", "NO", "off", "Off", "OFF", " False ", " no "]
    for v in off_values:
        c = WorkerConfig.from_env({"ENCORE_ANNOTATE": v})
        assert c.annotate is False, f"ENCORE_ANNOTATE={v!r} should turn annotation OFF"
        assert c.warnings == ()  # a recognized off-value is not a malformed input

    on_values = ["1", "true", "True", "TRUE", "yes", "Yes", "on", "anything-else"]
    for v in on_values:
        c = WorkerConfig.from_env({"ENCORE_ANNOTATE": v})
        assert c.annotate is True, f"ENCORE_ANNOTATE={v!r} should leave annotation ON"

    # Unset falls back to the on-by-default documented in the dataclass.
    assert WorkerConfig.from_env({}).annotate is True
