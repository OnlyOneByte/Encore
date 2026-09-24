"""What each action does, declared as data.

The ONE module allowed to import both the runtime and the steps — the seam that makes the dependency
rule in `docs/ARCHITECTURE.md` §7.1 hold mechanically: the runtime never imports a step, a domain
never imports the runtime.

A plan is a flat list read top to bottom, not a transition table — see the spec's §5.2 for the
branching analysis and the revisit trigger if that ever stops being true.
"""

from __future__ import annotations

from typing import Any

from .runtime.ctx import ResolvedEngines
from .runtime.plan import PLANS, LinearPlan
from .separation.tuning import SeparationTuning
from .steps.acquire import AcquireAudio
from .steps.diarize import Diarize
from .steps.key_and_range import KeyAndRange
from .steps.lyrics import (
    AUTHORED,
    MACHINE,
    AcquireTexts,
    FetchCaptions,
    GradeAndSelect,
    PresplitTexts,
    PublishLyrics,
    TimeTexts,
)
from .steps.metadata import Annotate, PublishOriginal
from .steps.separate import DecodeToWav, ProbeSilence, PublishStems, Separate
from .vocabulary import (
    Action,
    AsrModel,
    Engine,
    SyncMode,
    parse_asr_model,
    parse_engine,
    parse_sync_mode,
)


def align_plan(
    *,
    sources: list[Any] | None = None,
    lyrics_client: Any = None,
    transcriber: Any = None,
    aligner: Any = None,
    diarizer: Any = None,
    ytdlp_bin: str = "yt-dlp",
    keep_raw: bool = False,
) -> LinearPlan:
    """The align action: acquire, fetch captions, acquire+grade+time texts, diarize, publish.

    Every real dependency (WhisperX, LRCLIB, yt-dlp, pyannote) only ever runs on a worker box, so each
    is an injectable seam — `diarizer` for `Diarize` exactly as `aligner` is for `TimeTexts` — and the
    whole flow is exercisable without any of them.
    """
    return LinearPlan(
        "align",
        [
            AcquireAudio(ytdlp_bin=ytdlp_bin),
            FetchCaptions(AUTHORED, ytdlp_bin=ytdlp_bin, keep_raw=keep_raw),
            FetchCaptions(MACHINE, ytdlp_bin=ytdlp_bin, keep_raw=keep_raw),
            AcquireTexts(sources=sources, lyrics_client=lyrics_client, transcriber=transcriber),
            PresplitTexts(),
            GradeAndSelect(),
            TimeTexts(aligner=aligner),
            Diarize(diarizer=diarizer),
            PublishLyrics(),
        ],
    )


def stems_plan(
    *,
    engine: Any = None,
    profiler: Any = None,
    ffmpeg_bin: str = "ffmpeg",
    flac_level: int = 8,
    ytdlp_bin: str = "yt-dlp",
) -> LinearPlan:
    """The stems action: acquire, decode, separate, probe, analyse, publish.

    `ProbeSilence` and `KeyAndRange` are steps, not lines inside publishing/engine code, so BOTH engines
    get them uniformly (a roformer process cannot skip the silence probe a demucs one runs) and each is
    testable with no ffmpeg. As a step, `KeyAndRange`'s cost is also timed by the runner into
    `ctx.out.timings_sec` — measured, though not yet surfaced anywhere (the core drops it at its fact
    allowlist).
    """
    return LinearPlan(
        "stems",
        [
            AcquireAudio(ytdlp_bin=ytdlp_bin),
            DecodeToWav(engine=engine, ffmpeg_bin=ffmpeg_bin),
            Separate(engine=engine),
            ProbeSilence(ffmpeg_bin=ffmpeg_bin),
            KeyAndRange(profiler=profiler),
            PublishStems(ffmpeg_bin=ffmpeg_bin, flac_level=flac_level),
        ],
    )


def stems_upgrade_plan(**kwargs: Any) -> LinearPlan:
    """The stems-upgrade action. Its steps are identical to `stems` — deliberately: the worker does
    exactly the same work for an upgrade, and the refusal to publish something that doesn't outrank
    what's already there happens CORE-side, in `markMediaReady`. Kept as a separate declaration (not a
    conditional inside a shared step) so the day the two need to differ, they differ in a plan;
    `validate_plan` checks both and the generated doc shows both, so the copy cannot silently rot.
    """
    plan = stems_plan(**kwargs)
    return LinearPlan("stems-upgrade", plan.steps())


def fetch_plan(*, annotator: Any = None, ytdlp_bin: str = "yt-dlp") -> LinearPlan:
    """The fetch action: acquire the bytes, identify the song, report it. No separation."""
    return LinearPlan(
        "fetch", [AcquireAudio(ytdlp_bin=ytdlp_bin), Annotate(annotator=annotator), PublishOriginal()]
    )


def register_default_plans() -> None:
    """Install the plans the runner looks up. Idempotent, so importing twice is harmless."""
    PLANS[Action.ALIGN] = align_plan()
    PLANS[Action.STEMS] = stems_plan()
    PLANS[Action.STEMS_UPGRADE] = stems_upgrade_plan()
    PLANS[Action.FETCH] = fetch_plan()


def resolve_engines(params: dict[str, Any], defaults: ResolvedEngines | None = None) -> ResolvedEngines:
    """Fold a job's params over this worker's configured defaults — ONCE, per job, into a fresh
    `ResolvedEngines`. Not a tidy-up: state resolved onto a SHARED processor instance instead would let
    two concurrent align jobs (ENCORE_WORKER_CONCURRENCY > 1) carrying different `asrModel` race —
    one nulling the other's cached sources mid-acquire, or transcribing with the other's weights.

    `defaults` is the worker's own env fallback (ENCORE_ASR_MODEL / ENCORE_SYNC_MODE), consulted only
    for a job that carries neither — the core normally sends its global settings on every align job, so
    an operator's change takes effect on the next process with no restart. Every field (asrModel,
    syncMode, engine) is parsed at this boundary: an unknown or de-whitelisted value RAISES a
    BoundaryError here rather than failing opaquely deeper in a step.
    """
    base = defaults or ResolvedEngines()
    return ResolvedEngines(
        asr_model=parse_asr_model(params.get("asrModel"), AsrModel(base.asr_model)).value,
        sync_mode=parse_sync_mode(params.get("syncMode"), base.sync_mode),
        separator=str(parse_engine(params.get("engine"), Engine(base.separator))),
        device=params.get("device") or base.device,
    )


register_default_plans()


def align_runner(
    *,
    runner: Any,
    sources: list[Any] | None = None,
    lyrics_client: Any = None,
    transcriber: Any = None,
    aligner: Any = None,
    diarizer: Any = None,
    model: str | None = None,
    sync_mode: Any = None,
    device: str | None = None,
    ytdlp_bin: str = "yt-dlp",
    keep_raw: bool = False,
) -> Any:
    """A PlanRunner wired to run the align plan with these seams and these worker defaults.

    `model` / `sync_mode` / `device` are this WORKER's fallbacks (its env config), not the job's. A job
    carrying `asrModel` overrides them, which is how a settings change reaches the next process.
    """
    from .runtime.runner import PlanRunner

    defaults = ResolvedEngines()
    if model is not None:
        defaults.asr_model = parse_asr_model(model, AsrModel.BASE).value
    if sync_mode is not None:
        defaults.sync_mode = parse_sync_mode(sync_mode, SyncMode.FORCED)
    if device is not None:
        defaults.device = device

    plan = align_plan(
        sources=sources,
        lyrics_client=lyrics_client,
        transcriber=transcriber,
        aligner=aligner,
        diarizer=diarizer,
        ytdlp_bin=ytdlp_bin,
        keep_raw=keep_raw,
    )
    return PlanRunner(
        runner=runner,
        resolve_engines=lambda params: resolve_engines(params, defaults),
        plans=lambda job, engines: plan,
    )


def stems_runner(
    *,
    runner: Any,
    profiler: Any = None,
    ffmpeg_bin: str = "ffmpeg",
    ytdlp_bin: str = "yt-dlp",
    flac_level: int = 8,
    tuning: SeparationTuning | None = None,
) -> Any:
    """A PlanRunner for both separation actions, with this worker's separator configuration.

    The engine is chosen per JOB from `params.engine` (plan selection, §5.2c) via `engine_for` below,
    so one runner serves both demucs and roformer processes. There is deliberately NO engine override
    here: a test that wants a fake separator builds `stems_plan(engine=...)` or `Separate(engine=...)`
    directly, which is where the seam actually is — an override at this level had no caller and its
    presence claimed a seam that did not exist.

    `backend` is the hardware backend `backends.resolve_backend` resolved for this worker (torch/mlx),
    resolved once in `dial_home` and threaded into `engine_for` so it drives the engine that actually
    runs and is recorded into `facts.backend` — a Mac announcing `mlx` must not run torch demucs while
    reporting `torch`.
    """
    from .runtime.runner import PlanRunner
    from .separation.engines import engine_for

    tune = tuning if tuning is not None else SeparationTuning()

    def resolve(params: dict[str, Any]) -> ResolvedEngines:
        return resolve_engines(params, ResolvedEngines(device=tune.device))

    def pick(job: Any, engines: ResolvedEngines) -> LinearPlan:
        # `engine_kwargs` carries the job's RESOLVED device (from `resolve_engines`, folding
        # `params['device']` over the worker's own), same value alignment and diarization read — so a
        # job cannot separate on one device and align on another, and `facts.device` always matches
        # what the engine was actually built with.
        # `ffmpeg_bin` is passed alongside the tuning, not folded into it: only demucs-mlx needs it
        # (its instrumental is DERIVED by an ffmpeg mix-minus pass, since the CLI has no
        # `--two-stems`), and it must reach the ENGINE itself, not just the steps below — an
        # Apple-Silicon box with ENCORE_FFMPEG_BIN set must not fall back to a bare `ffmpeg` for the
        # one call an mlx separation needs to produce no_vocals.wav at all.
        eng = engine_for(
            engines.separator, ffmpeg_bin=ffmpeg_bin, **tune.engine_kwargs(device=engines.device)
        )
        kwargs: dict[str, Any] = dict(
            engine=eng, profiler=profiler, ffmpeg_bin=ffmpeg_bin, flac_level=flac_level, ytdlp_bin=ytdlp_bin
        )
        return (
            stems_upgrade_plan(**kwargs)
            if job.job_type == Action.STEMS_UPGRADE.value
            else stems_plan(**kwargs)
        )

    return PlanRunner(runner=runner, resolve_engines=resolve, plans=pick)


def fetch_runner(*, runner: Any, annotator: Any = None, ytdlp_bin: str = "yt-dlp") -> Any:
    """A PlanRunner for the fetch action."""
    from .runtime.runner import PlanRunner

    plan = fetch_plan(annotator=annotator, ytdlp_bin=ytdlp_bin)
    return PlanRunner(runner=runner, resolve_engines=resolve_engines, plans=lambda job, engines: plan)
