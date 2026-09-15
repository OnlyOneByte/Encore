"""What each action does, declared as data.

The ONE module allowed to import both the runtime and the steps. That is what makes the dependency rule
in `docs/ARCHITECTURE.md` §7.1 hold mechanically: the runtime never imports a step, a domain
never imports the runtime, and this file is the seam where they meet.

Read a plan top to bottom and you have read what the action does. That readability is most of why this is
a list rather than a transition table — see the spec's §5.2 for the branching analysis, and for the
revisit trigger if that ever stops being true.
"""

from __future__ import annotations

from typing import Any

from .runtime.ctx import ResolvedEngines
from .runtime.plan import PLANS, LinearPlan
from .separation.tuning import SeparationTuning
from .steps.acquire import AcquireAudio
from .steps.analysis import KeyAndRange
from .steps.diarize import Diarize
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
    """The align action: nine steps that were one 257-line method.

    Seams stay injectable for the same reason they always were — the real WhisperX, the real LRCLIB and
    the real yt-dlp only ever run on a worker box, so the whole flow has to be exercisable without any of
    them. `diarizer` is the newest seam: the real pyannote pipeline only runs on a worker box, so
    Diarize takes an injected diarizer exactly as TimeTexts takes an aligner.
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

    `ProbeSilence` is a step rather than a line inside publishing, and that is a fix as well as a tidy-up:
    only demucs used to probe, so a roformer process could publish a silent guiding track. As a step both
    engines get it and it is testable with no ffmpeg.

    `KeyAndRange` likewise: it was called inline from both engines through two separate injectable
    `profiler` parameters. As a step the runner times it into `ctx.out.timings_sec`, so its cost is now
    measured — though that measurement is not yet surfaced anywhere (the core drops it at its fact allowlist).
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
    """The stems-upgrade action.

    Its own plan, and TODAY its steps are identical to `stems`. That is not an oversight and the
    duplication is deliberate: the worker does exactly the same work for an upgrade, and the refusal to
    publish something that does not outrank what is already there happens CORE-side, in `markMediaReady`.
    `dial_home` used to hand both actions the same processor, which stated the same thing less visibly.

    Separate anyway because they are separate declarations that happen to coincide, so the day one of them
    needs to differ, it differs in a plan rather than in a conditional inside a shared step. `validate_plan`
    checks both and the generated doc shows both, so the copy cannot silently rot.
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
    """Fold a job's params over this worker's configured defaults — ONCE, per job.

    This is the fix for a latent concurrency bug, not a tidy-up. Engine resolution used to mutate the
    shared processor instance (`self._model`, `self._sync_mode`, and it nulled `self._transcriber` and
    `self._sources` to force a reload). With ENCORE_WORKER_CONCURRENCY > 1 two align jobs carrying
    different `asrModel` raced: one could null the other's cached sources mid-acquire, or transcribe with
    the other's weights. Nothing about the wire changed; the state simply had nowhere per-job to live.

    `defaults` is the worker's own env fallback (ENCORE_ASR_MODEL / ENCORE_SYNC_MODE), which is only
    consulted for a job that carries neither — the core normally sends its global settings on every align
    job so an operator changing the model takes effect on the next process with no restart. Every field is
    parsed at this boundary (asrModel, syncMode, engine): an unknown or de-whitelisted value RAISES a
    BoundaryError here rather than reaching a step and failing opaquely deeper in — the same fail-at-the-
    edge contract every parse_* enforces. A field the job omits keeps the worker's own configured default.
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

    The replacement for `WhisperXProcessor(...)`. Not a compatibility shim: "how do I build a runner for
    this action with these fakes" is a real question, and plans.py is where the answer belongs — it is
    already the module that knows both the runtime and the steps.

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
    engine: Any = None,
    profiler: Any = None,
    ffmpeg_bin: str = "ffmpeg",
    ytdlp_bin: str = "yt-dlp",
    flac_level: int = 8,
    tuning: SeparationTuning | None = None,
) -> Any:
    """A PlanRunner for both separation actions, with this worker's separator configuration.

    The engine is chosen per JOB from `params.engine` (plan selection, §5.2c), so one runner serves both
    demucs and roformer processes — `EngineRouter`'s dispatch collapsed into `engine_for` inside the Separate
    step. Passing `engine` overrides that entirely, which is how a test drives a fake separator.

    `backend` is the hardware backend `backends.resolve_backend` resolved for this worker (torch/mlx),
    resolved once in `dial_home`. It is threaded into `engine_for` so it drives the engine that actually
    runs and is recorded into `facts.backend` — before threading, the resolved backend reached only a startup
    print, so a Mac announcing `mlx` still ran torch demucs and recorded `torch`.
    """
    from .runtime.runner import PlanRunner
    from .separation.engines import engine_for

    tune = tuning if tuning is not None else SeparationTuning()

    def resolve(params: dict[str, Any]) -> ResolvedEngines:
        return resolve_engines(params, ResolvedEngines(device=tune.device))

    def pick(job: Any, engines: ResolvedEngines) -> LinearPlan:
        # `engine_kwargs` carries the job's resolved device, not the worker's. `resolve_engines` folds
        # `params['device']` over this box's own, and alignment (steps/lyrics.py) and diarization
        # (steps/diarize.py) both read the folded value — separation once read the closure instead, so one
        # job could transcribe on the device it asked for and separate on a different one, with
        # `facts.device` reporting whichever the engine was built with.
        # `ffmpeg_bin` is passed alongside the tuning, not folded into it. Only ONE engine wants it —
        # demucs-mlx, whose instrumental is DERIVED by an ffmpeg mix-minus pass because the CLI has no
        # `--two-stems` — while `ffmpeg_bin` itself is shared with plans that never separate anything.
        # Before this it reached the three steps below and not the engine, so an Apple-Silicon box with
        # ENCORE_FFMPEG_BIN set derived its instrumental with bare `ffmpeg`: the one call that has to
        # succeed for an mlx separation to produce no_vocals.wav at all.
        eng = engine or engine_for(
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
