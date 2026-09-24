"""The composition root: turning a resolved config into the Processor that runs jobs.

This is the module that is ALLOWED to know about everything. `_build_processor` reads the capability
set and wires config -> resolved backend -> tuning -> engines -> plans -> a RoutingProcessor keyed by
job type. Every import in it is deliberately LAZY: a fetch-only box must never load torch, since
importing the separation plan eagerly would drag multi-GB of ML into a process that only shells out
to yt-dlp.

`oversubscription_warnings` lives here rather than in `config.py`: it is a startup DIAGNOSTIC about
the box, not a setting, pure (cores and memory are arguments) so it unit-tests without touching the
machine, and read at the same moment the processor is built.
"""

from __future__ import annotations

import os

from .host.config import WorkerConfig
from .processor import Processor, StubProcessor
from .vocabulary import Capability, serves_family


def oversubscription_warnings(
    cfg: WorkerConfig, cores: int | None, memory_bytes: int | None = None
) -> list[str]:
    """Warn when concurrency x jobs asks for more parallel work than the box can run.

    PURE (cores and memory are passed in) so it unit-tests without touching the machine; core count is
    a property of the HOST, not the environment, so this lives outside `WorkerConfig.from_env`.

    Worth warning about because the two knobs MULTIPLY: `concurrency=4, jobs=4` is 16 concurrent
    demucs chunk workers, each holding its own model copy, so the box thrashes and every song gets
    slower. Never fatal: a GPU box or a deliberate over-commit is the operator's call.

    `cores` should be the EFFECTIVE count (hardware.effective_cpus), not os.cpu_count(): inside a
    throttled container the host figure hides exactly the contention this is looking for.
    """
    out: list[str] = []
    parallel = max(1, cfg.concurrency) * max(1, cfg.demucs_jobs)
    if cores and parallel > cores:
        out.append(
            f"concurrency={cfg.concurrency} x demucs_jobs={cfg.demucs_jobs} = {parallel} parallel "
            f"separations on {cores} usable cores; songs will contend"
        )
    if memory_bytes:
        # ~2 GiB per parallel separation is conservative for htdemucs, so this under-warns.
        need = parallel * 2 * 1024**3
        if need > memory_bytes:
            out.append(
                f"{parallel} parallel separations need roughly {need // 1024**3} GiB but only "
                f"{memory_bytes // 1024**3} GiB is available; expect the OOM killer rather than "
                "slow processes — lower ENCORE_WORKER_CONCURRENCY or ENCORE_DEMUCS_JOBS"
            )
    return out


def _apply_torch_threads(cfg: WorkerConfig) -> None:
    """Cap torch's intra-op threads, BEFORE any model loads.

    demucs runs as a separate SUBPROCESS, so `torch.set_num_threads()` here cannot reach it — OMP/MKL in
    `os.environ` are how the cap crosses the process boundary. Both are set, since the in-process torch
    (alignment) and the subprocess (separation) are two different consumers of the same decision.
    """
    if cfg.torch_threads is None:
        return
    os.environ["OMP_NUM_THREADS"] = str(cfg.torch_threads)
    os.environ["MKL_NUM_THREADS"] = str(cfg.torch_threads)
    try:
        import torch

        torch.set_num_threads(cfg.torch_threads)
    except Exception as exc:  # noqa: BLE001 — a tuning hint must never stop the worker
        print(f"[worker] could not set torch threads: {exc}", flush=True)


def _resolve_device_and_backend(cfg: WorkerConfig) -> tuple[str | None, str | None]:
    """The torch device and separator backend, answered ONCE for the whole worker.

    One answer rather than one per action, because a CUDA box separates on GPU and transcribes on GPU off
    the SAME decision — two independent resolutions could disagree. The backend is returned rather than
    just logged: it DRIVES the engine and reaches `out.facts`.

    (None, None) when this box advertises neither separation nor alignment, so a fetch-only worker never
    imports torch to answer a question it does not ask.
    """
    if not (serves_family(cfg.capabilities, Capability.STEMS.family) or Capability.ALIGN in cfg.capabilities):
        return None, None
    from .host.backends import resolve_backend
    from .vocabulary import Engine

    choice = resolve_backend(cfg.separator_backend, engine=Engine.DEMUCS, device=cfg.device)
    print(f"[worker] separator backend: {choice.backend.value} — {choice.reason}", flush=True)
    return choice.device, choice.backend.value


def _fetch_runner_for(cfg: WorkerConfig) -> Processor:
    """The acquisition runner. Needs no ML, so it builds on a box that cannot separate at all.

    The annotated local is deliberate: the `plans.*_runner` builders are typed `-> Any` (they compose a
    PlanRunner out of lazily imported parts), so each helper here is where that Any becomes a `Processor`.
    """
    from .plans import fetch_runner
    from .separation.demucs import subprocess_runner

    annotator = None
    if cfg.annotate:
        from .metadata.annotate import MusicBrainzClient

        annotator = MusicBrainzClient()
    built: Processor = fetch_runner(runner=subprocess_runner, annotator=annotator, ytdlp_bin=cfg.ytdlp_bin)
    return built


def _resolve_demucs_segment(cfg: WorkerConfig) -> int | None:
    """The chunk length to separate with: an explicit ENCORE_DEMUCS_SEGMENT wins, else it is sized to FREE
    card memory.

    Measured HERE, not in `from_env`, because reading free VRAM imports torch and config is built at module
    import — which would pull the ML stack into a worker that only fetches.
    """
    if cfg.demucs_segment is not None:
        return cfg.demucs_segment
    from .host.config import auto_demucs_segment
    from .host.hardware import free_vram_bytes

    free = free_vram_bytes()
    segment = auto_demucs_segment(free)
    if segment is not None and free is not None:
        print(
            f"[worker] demucs segment: {segment}s — derived from "
            f"{free / (1024**3):.1f}GiB free accelerator memory "
            f"(set ENCORE_DEMUCS_SEGMENT to override)",
            flush=True,
        )
    return segment


def _stems_runner_for(cfg: WorkerConfig, device: str | None, backend: str | None) -> Processor:
    """The separation runner, serving BOTH separation actions.

    One runner, not one per action: the engine resolves from job params into `ctx.engines` before the first
    step runs, so there is no second dispatch layer. `device`, `backend` and the segment are the three
    values config cannot know by itself, folded into one `SeparationTuning` so the knobs have a single owner.
    """
    from .host.config import separation_tuning
    from .plans import stems_runner
    from .separation.demucs import subprocess_runner

    built: Processor = stems_runner(
        runner=subprocess_runner,
        ffmpeg_bin=cfg.ffmpeg_bin,
        ytdlp_bin=cfg.ytdlp_bin,
        flac_level=cfg.flac_level,
        tuning=separation_tuning(cfg, device=device, backend=backend, segment=_resolve_demucs_segment(cfg)),
    )
    return built


def _align_runner_for(cfg: WorkerConfig, device: str | None) -> Processor:
    """The alignment runner.

    The same device decision as separation, mapped through `whisperx_device_for` because CTranslate2 has
    only cuda and cpu backends: an mps box separates on its accelerator and aligns on the CPU.
    """
    from .host.config import whisperx_device_for
    from .lyrics import LrclibClient
    from .plans import align_runner
    from .separation.demucs import subprocess_runner

    built: Processor = align_runner(
        runner=subprocess_runner,
        lyrics_client=LrclibClient(base_url=cfg.lrclib_base),
        device=cfg.whisperx_device or whisperx_device_for(device),
        model=cfg.asr_model,
        sync_mode=cfg.sync_mode,
        ytdlp_bin=cfg.ytdlp_bin,
        keep_raw=cfg.keep_raw_captions,
    )
    return built


def _build_processor(cfg: WorkerConfig | None = None) -> Processor:
    """Build the processor from this worker's capabilities. ENCORE_PROCESSOR=stub forces the no-ML
    StubProcessor. Otherwise a RoutingProcessor dispatches by job type onto a PlanRunner per action —
    fetch, stems, stems-upgrade and align — each running the declared plan for that action.

    Reads as a WIRING TABLE: which capability binds which runner, with the how of each in its own helper
    above. Every import in those helpers is LAZY and each is called only under its own capability guard, so
    a fetch-only box never loads torch — importing the separation plan eagerly would drag multi-GB of ML
    into a process that only shells out to yt-dlp.

    Config is read ON CALL, not captured at import: a module-level default would silently ignore an
    environment set after import, and be untestable.
    """
    cfg = cfg or WorkerConfig.from_env()
    if cfg.processor == "stub":
        return StubProcessor()

    from .processor import RoutingProcessor

    _apply_torch_threads(cfg)
    device, backend = _resolve_device_and_backend(cfg)

    by_type: dict[str, Processor] = {}
    # Each guard is asked of the VOCABULARY rather than a literal token list, so a box advertising a new
    # engine token always gets a bound runner and never accepts work with nothing to run it.
    if serves_family(cfg.capabilities, Capability.FETCH_YTDLP.family):
        by_type["fetch"] = _fetch_runner_for(cfg)
    if serves_family(cfg.capabilities, Capability.STEMS.family):
        runner = _stems_runner_for(cfg, device, backend)
        by_type["stems"] = runner
        by_type["stems-upgrade"] = runner  # an upgrade is a separation job like any other
    if Capability.ALIGN in cfg.capabilities:
        by_type["align"] = _align_runner_for(cfg, device)
    return RoutingProcessor(by_type)
