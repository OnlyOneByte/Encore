"""What each action does, declared as data.

The ONE module allowed to import both the runtime and the steps. That is what makes the dependency rule
in `docs/specs/SPEC-worker-pipeline.md` §3 hold mechanically: the runtime never imports a step, a domain
never imports the runtime, and this file is the seam where they meet.

Read a plan top to bottom and you have read what the action does. That readability is most of why this is
a list rather than a transition table — see the spec's §5.2 for the branching analysis, and for the
revisit trigger if that ever stops being true.
"""
from __future__ import annotations

from typing import Any

from .runtime.ctx import ResolvedEngines
from .runtime.plan import PLANS, LinearPlan
from .steps.acquire import AcquireAudio
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
from .vocabulary import Action, AsrModel, Engine, SyncMode, parse_asr_model, parse_sync_mode


def align_plan(*, sources: list[Any] | None = None, lyrics_client: Any = None, transcriber: Any = None, aligner: Any = None) -> LinearPlan:
    """The align action: eight steps that were one 257-line method.

    Seams stay injectable for the same reason they always were — the real WhisperX, the real LRCLIB and
    the real yt-dlp only ever run on a worker box, so the whole flow has to be exercisable without any of
    them.
    """
    return LinearPlan(
        "align",
        [
            AcquireAudio(),
            FetchCaptions(AUTHORED),
            FetchCaptions(MACHINE),
            AcquireTexts(sources=sources, lyrics_client=lyrics_client, transcriber=transcriber),
            PresplitTexts(),
            GradeAndSelect(),
            TimeTexts(aligner=aligner),
            PublishLyrics(),
        ],
    )


def register_default_plans() -> None:
    """Install the plans the runner looks up. Idempotent, so importing twice is harmless."""
    PLANS[Action.ALIGN] = align_plan()


def resolve_engines(params: dict[str, Any], defaults: ResolvedEngines | None = None) -> ResolvedEngines:
    """Fold a job's params over this worker's configured defaults — ONCE, per job.

    This is the fix for a latent concurrency bug, not a tidy-up. Engine resolution used to mutate the
    shared processor instance (`self._model`, `self._sync_mode`, and it nulled `self._transcriber` and
    `self._sources` to force a reload). With ENCORE_WORKER_CONCURRENCY > 1 two align jobs carrying
    different `asrModel` raced: one could null the other's cached sources mid-acquire, or transcribe with
    the other's weights. Nothing about the wire changed; the state simply had nowhere per-job to live.

    `defaults` is the worker's own env fallback (ENCORE_ASR_MODEL / ENCORE_SYNC_MODE), which is only
    consulted for a job that carries neither — the core normally sends its global settings on every align
    job so an operator changing the model takes effect on the next cook with no restart. An unknown or
    de-whitelisted value falls back rather than failing the job, so an older or newer core changes nothing.
    """
    base = defaults or ResolvedEngines()
    return ResolvedEngines(
        asr_model=parse_asr_model(params.get("asrModel"), AsrModel(base.asr_model)).value,
        sync_mode=parse_sync_mode(params.get("syncMode"), base.sync_mode),
        separator=str(params.get("engine") or base.separator),
        separator_model=params.get("model") or base.separator_model,
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
    model: str | None = None,
    sync_mode: Any = None,
    device: str | None = None,
) -> Any:
    """A PlanRunner wired to run the align plan with these seams and these worker defaults.

    The replacement for `WhisperXProcessor(...)`. Not a compatibility shim: "how do I build a runner for
    this action with these fakes" is a real question, and plans.py is where the answer belongs — it is
    already the module that knows both the runtime and the steps.

    `model` / `sync_mode` / `device` are this WORKER's fallbacks (its env config), not the job's. A job
    carrying `asrModel` overrides them, which is how a settings change reaches the next cook.
    """
    from .runtime.runner import PlanRunner

    defaults = ResolvedEngines()
    if model is not None:
        defaults.asr_model = parse_asr_model(model, AsrModel.BASE).value
    if sync_mode is not None:
        defaults.sync_mode = parse_sync_mode(sync_mode, SyncMode.FORCED)
    if device is not None:
        defaults.device = device

    plan = align_plan(sources=sources, lyrics_client=lyrics_client, transcriber=transcriber, aligner=aligner)
    return PlanRunner(
        runner=runner,
        resolve_engines=lambda params: resolve_engines(params, defaults),
        plans=lambda job, engines: plan,
    )
