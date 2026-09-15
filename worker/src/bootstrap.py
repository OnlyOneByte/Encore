"""The composition root: turning a resolved config into the Processor that runs jobs.

This is the module that is ALLOWED to know about everything. `_build_processor` reads the capability set
and wires config -> resolved backend -> tuning -> engines -> plans -> a RoutingProcessor keyed by job
type. Every import in it is deliberately LAZY, because the point of capability-driven construction is
that a fetch-only box never loads torch: importing the separation plan eagerly would drag multi-GB of ML
into a process that only shells out to yt-dlp.

WHY IT IS NOT IN `dial_home.py` ANY MORE. That module was 884 lines carrying six unrelated jobs — the WS
protocol loop, the scratch reaper, retry classification, these warnings, this wiring, and the entrypoint.
The protocol loop and the wiring are the two that change for completely different reasons: one moves when
the core's message shape changes, the other when a step, engine or capability is added. Keeping them in
one file meant every reader of either had to scroll past the other.

`oversubscription_warnings` lives here rather than in `config.py` because it is a startup DIAGNOSTIC about
the box, not a setting: it is pure (cores and memory are arguments) so it unit-tests without touching the
machine, and it is read at the same moment the processor is built.
"""

from __future__ import annotations

import os

from .config import WorkerConfig
from .processor import Processor, StubProcessor
from .vocabulary import Capability, serves_family


def oversubscription_warnings(
    cfg: WorkerConfig, cores: int | None, memory_bytes: int | None = None
) -> list[str]:
    """Warn when concurrency x jobs asks for more parallel work than the box can run.

    PURE (cores and memory are passed in) so it unit-tests without touching the machine. This is its
    own check rather than part of WorkerConfig.from_env because core count is a property of the HOST,
    not the environment, and from_env is deliberately pure over env alone.

    Worth warning about because the two knobs MULTIPLY: `concurrency=4, jobs=4` is 16 concurrent
    demucs chunk workers, each holding its own model copy, so the box thrashes and every song gets
    slower — the opposite of what raising them looks like it should do. Never fatal: a GPU box or a
    deliberate over-commit is the operator's call.

    `cores` should be the EFFECTIVE count (hardware.effective_cpus), not os.cpu_count(): inside a
    throttled container the host figure hides exactly the contention this is looking for.

    Only MEMORY-and-scheduling contention is reported here. There is deliberately no "you forgot to
    cap threads" warning any more: `from_env` derives `torch_threads` from concurrency x jobs whenever
    it is unset, so the condition that warning described cannot arise, and a warning naming a fix that
    has already been applied is worse than none. What remains is the case config cannot fix for you —
    asking for more parallel separations than the host has cores, or than its RAM can hold.
    """
    out: list[str] = []
    parallel = max(1, cfg.concurrency) * max(1, cfg.demucs_jobs)
    if cores and parallel > cores:
        out.append(
            f"concurrency={cfg.concurrency} x demucs_jobs={cfg.demucs_jobs} = {parallel} parallel "
            f"separations on {cores} usable cores; songs will contend"
        )
    if memory_bytes:
        # Each parallel separation holds its own model copy plus the decoded audio it is working on.
        # ~2 GiB is the conservative figure for htdemucs; roformer is heavier, so this under-warns
        # rather than crying wolf.
        need = parallel * 2 * 1024**3
        if need > memory_bytes:
            out.append(
                f"{parallel} parallel separations need roughly {need // 1024**3} GiB but only "
                f"{memory_bytes // 1024**3} GiB is available; expect the OOM killer rather than "
                "slow processes — lower ENCORE_WORKER_CONCURRENCY or ENCORE_DEMUCS_JOBS"
            )
    return out


def _build_processor(cfg: WorkerConfig | None = None) -> Processor:
    """Build the processor from this worker's capabilities. ENCORE_PROCESSOR=stub forces the no-ML
    StubProcessor. Otherwise a RoutingProcessor dispatches by job type onto a PlanRunner per action —
    fetch, stems, stems-upgrade and align — each running the declared plan for that action. Imports are
    lazy so torch only loads for advertised capabilities.

    Config is read ON CALL, not captured at import: a module-level default would silently ignore an
    environment set after import, and be untestable.
    """
    cfg = cfg or WorkerConfig.from_env()
    if cfg.processor == "stub":
        return StubProcessor()

    from .processor import RoutingProcessor

    # Cap intra-op threads BEFORE any model loads. Matters when demucs_jobs > 1: N jobs each
    # defaulting to all cores oversubscribe the box and fight instead of scaling.
    #
    # demucs runs as a separate CLI SUBPROCESS (see demucs.py subprocess_runner), so
    # torch.set_num_threads() in THIS process cannot reach it — the child inherits os.environ, so
    # OMP/MKL are how the cap crosses the process boundary. Measured on a 10-core box: `-j 1` already
    # ran ~3.9 cores wide, so `-j 4` uncapped just oversubscribes (86s vs 99s); the cap is what lets
    # jobs scale instead of fight. torch.set_num_threads() still applies to the IN-PROCESS consumers.
    if cfg.torch_threads is not None:
        os.environ["OMP_NUM_THREADS"] = str(cfg.torch_threads)
        os.environ["MKL_NUM_THREADS"] = str(cfg.torch_threads)
        try:
            import torch

            torch.set_num_threads(cfg.torch_threads)
        except Exception as exc:  # noqa: BLE001 — a tuning hint must never stop the worker
            print(f"[worker] could not set torch threads: {exc}", flush=True)

    by_type: dict[str, Processor] = {}
    # Resolve the device ONCE for the whole worker. Separation and alignment used to answer this
    # question independently — and alignment's answer was a hardcoded "cpu" — so a CUDA box separated
    # on the GPU and then transcribed on the CPU unless a human set a second env var. One resolution
    # means the two cannot disagree.
    device: str | None = None
    # The RESOLVED separator backend for this worker (torch/mlx). Bound to None up here alongside
    # `device` so it is unconditionally defined, then threaded into stems_runner below so it drives the
    # engine and is recorded into facts — not merely printed.
    backend: str | None = None
    # Any separation-family capability, or alignment, means this box does heavy ML and needs a resolved
    # backend. Derived from the vocabulary rather than a literal list — the literal list here omitted
    # `stems:audiosep`, so an audio-separator-only box never resolved a backend or printed the line.
    if serves_family(cfg.capabilities, Capability.STEMS.family) or Capability.ALIGN in cfg.capabilities:
        from .backends import resolve_backend
        from .vocabulary import Engine

        choice = resolve_backend(cfg.separator_backend, engine=Engine.DEMUCS, device=cfg.device)
        device = choice.device
        backend = choice.backend.value
        print(f"[worker] separator backend: {choice.backend.value} — {choice.reason}", flush=True)

    if serves_family(cfg.capabilities, Capability.FETCH_YTDLP.family):
        from .plans import fetch_runner
        from .separation.demucs import subprocess_runner

        # Acquisition needs no ML, so it is built whenever a fetch capability is advertised — including
        # on a box that cannot separate at all. That asymmetry is the point of routing fetch separately.
        annotator = None
        if cfg.annotate:
            from .metadata.annotate import MusicBrainzClient

            annotator = MusicBrainzClient()
        by_type["fetch"] = fetch_runner(
            runner=subprocess_runner, annotator=annotator, ytdlp_bin=cfg.ytdlp_bin
        )
    # THE BUG THIS FIXES: the two tokens were listed literally, so `stems:audiosep` — added to the
    # probes later — never reached here. A box with audio-separator and no demucs proved
    # `stems:audiosep`, advertised it, matched the core's `stems` routing on the `stems:` prefix, and
    # bound NO stems runner: it accepted separation work it could not run a single job of. Asking the
    # vocabulary which tokens serve the stems family means a new engine token cannot be missed here.
    if serves_family(cfg.capabilities, Capability.STEMS.family):
        from .plans import stems_runner
        from .separation.demucs import subprocess_runner

        # ONE runner for both separation actions. The engine is resolved from job params into ctx.engines
        # before the first step runs (plan SELECTION, not branching — see the spec's §5.2c), so there is no
        # second dispatch layer: EngineRouter's job is now `engine_for` inside the Separate step.
        #
        # Roformer's ~700MB checkpoint machinery is still only reachable when the capability was granted:
        # engine_for imports it lazily, and the CORE only routes a roformer process to a worker advertising
        # stems:roformer.
        # Segment: an explicit ENCORE_DEMUCS_SEGMENT always wins; otherwise size it to the memory the
        # card actually has FREE right now. Measured here rather than in `WorkerConfig.from_env` on
        # purpose — reading free VRAM imports torch, and config is built at module import, so deriving
        # it there would pull the ML stack into every worker process including one that only fetches.
        segment = cfg.demucs_segment
        if segment is None:
            from .config import auto_demucs_segment
            from .hardware import free_vram_bytes

            free = free_vram_bytes()
            segment = auto_demucs_segment(free)
            if segment is not None and free is not None:
                print(
                    f"[worker] demucs segment: {segment}s — derived from "
                    f"{free / (1024**3):.1f}GiB free accelerator memory "
                    f"(set ENCORE_DEMUCS_SEGMENT to override)",
                    flush=True,
                )

        # ONE value for the nine separator knobs — see `separation/tuning.py` for why they stopped being
        # nine parameters. The three arguments are the ones config cannot know by itself: the resolved
        # device and backend (which DRIVE the engine and reach `facts`, so the startup log and the ledger
        # cannot disagree) and a segment that may be derived from free accelerator memory.
        from .config import separation_tuning

        runner = stems_runner(
            runner=subprocess_runner,
            ffmpeg_bin=cfg.ffmpeg_bin,
            ytdlp_bin=cfg.ytdlp_bin,
            flac_level=cfg.flac_level,
            tuning=separation_tuning(cfg, device=device, backend=backend, segment=segment),
        )
        by_type["stems"] = runner
        by_type["stems-upgrade"] = runner  # an upgrade is a separation job like any other
    if Capability.ALIGN in cfg.capabilities:
        from .config import whisperx_device_for
        from .lyrics import LrclibClient
        from .plans import align_runner
        from .separation.demucs import subprocess_runner

        # Follows the same device decision as separation, mapped through whisperx_device_for because
        # CTranslate2 has only cuda and cpu backends — an xpu or mps box separates on its accelerator
        # and still aligns on the CPU, which is a real constraint rather than a missed optimisation.
        #
        # A PlanRunner over the declared align plan, not a bespoke processor: eight named steps rather
        # than one 257-line method, and engines resolved per JOB rather than mutated on this instance.
        # See docs/ARCHITECTURE.md §7.1 (the align plan).
        by_type["align"] = align_runner(
            runner=subprocess_runner,
            lyrics_client=LrclibClient(base_url=cfg.lrclib_base),
            device=cfg.whisperx_device or whisperx_device_for(device),
            model=cfg.asr_model,
            sync_mode=cfg.sync_mode,
            ytdlp_bin=cfg.ytdlp_bin,
            keep_raw=cfg.keep_raw_captions,
        )
    return RoutingProcessor(by_type)
