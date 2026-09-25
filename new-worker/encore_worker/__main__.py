"""The composition root: read config, probe the box, build the adapters, dial home.

THE ONLY MODULE ALLOWED TO IMPORT EVERY LAYER. Every other file obeys the one-directional rule in
`encore_worker/__init__.py`; this one wires the graph, which means it necessarily sees all of it. A test
enforces that boundary (`tests/test_layers.py` skips this file by name).

It contains no logic worth testing and holds no decisions — anything with a judgement in it belongs in
`domain/`, which is why this file is short and nearly all assignment.

    python -m encore_worker
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from typing import Any

from encore_worker.adapters import cli, lrclib, lrcmux, ml, ports, separate
from encore_worker.artifacts.local import LocalArtifactStore, Roots
from encore_worker.host import hardware
from encore_worker.host.config import Config
from encore_worker.protocol import frames as f
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.records import AlignOutcome, JobRef
from encore_worker.steps.separate_steps import FetchStepsImpl, SeparateStepsImpl
from encore_worker.transport.client import Client
from encore_worker.workflows import durable
from encore_worker.workflows.fetch import run_fetch


def build_adapters(config: Config, *, device: str) -> Adapters:
    """Everything this box can actually do. An absent adapter is None, never a stub that fails later.

    None is load-bearing rather than defensive: each step checks its adapter and degrades — no
    transcriber means the ASR tier yields nothing, which the search reads as "ASR had its turn and heard
    nothing". A stub that raised would turn a missing capability into a failed job.
    """
    return Adapters(
        fetcher=cli.YtDlpAudio(config.ytdlp_bin) if hardware.binary_available(config.ytdlp_bin) else None,
        probe=cli.FfmpegProbe(config.ffmpeg_bin) if hardware.binary_available(config.ffmpeg_bin) else None,
        captions=cli.YtDlpCaptions(config.ytdlp_bin) if hardware.binary_available(config.ytdlp_bin) else None,
        # An ordered CHAIN, empty when offline. See `build_providers`.
        providers=build_providers(config),
        transcriber=ml.build_transcriber(device=device, checkpoint=config.asr_model),
        aligner=ml.build_aligner(device=device),
        diarizer=ml.build_diarizer(device=device),
    )


def build_providers(config: Config) -> tuple[ports.LyricsProvider, ...]:
    """The lyrics providers, IN PRIORITY ORDER.

    LRCmux first because it fans one lookup across many sources and can return WORD-level timings, which
    is a materially better starting point for alignment than a line-timed sheet. LRCLIB second: it is a
    single source LRCmux already queries, so it is a genuine fallback only when LRCmux itself is
    unreachable — which on a restricted network is exactly the case worth covering.

    Empty when offline. A room with no outbound route should not pay a lookup timeout per song, and the
    ASR tier still produces lyrics from what it can hear.
    """
    if config.offline:
        return ()
    chain: list[ports.LyricsProvider] = []
    mux = lrcmux.build_provider(base_url=config.lrcmux_url, proxy=config.https_proxy)
    if mux is not None:
        chain.append(mux)
    direct = lrclib.build_provider(base_url=config.lrclib_url, proxy=config.https_proxy)
    if direct is not None:
        chain.append(direct)
    return tuple(chain)


def device_for(config: Config, report: hardware.Report) -> str:
    """The torch device string. Explicit config wins, else what the box actually has.

    Resolved ONCE here and threaded everywhere, so separation, alignment and diarization cannot end up
    on different devices — and so `Hello.device` reports what the models were really built with.
    """
    if config.device:
        return config.device
    return {"cuda": "cuda", "mps": "mps"}.get(report.accelerator, "cpu")


async def main() -> None:
    config = Config.from_env()
    report = hardware.probe()
    backend = hardware.resolve_backend(config.backend, report=report)
    device = device_for(config, report)
    caps = hardware.capabilities(backend=backend.name, ytdlp=config.ytdlp_bin, ffmpeg=config.ffmpeg_bin)

    print(
        f"[worker] {config.worker_id} on {report.platform} ({report.machine}); "
        f"accelerator={report.accelerator} device={device} backend={backend.name} ({backend.why}); "
        f"capabilities={','.join(sorted(caps)) or 'NONE'}",
        flush=True,
    )
    if not caps:
        # Not fatal: a box with no capabilities still connects and is visible on the dashboard, which is
        # more useful than a process that exits and leaves an operator wondering where the worker went.
        print("[worker] WARNING: no capabilities proven, so the core will route nothing here", flush=True)

    dbos = _launch_dbos(config)
    adapters = build_adapters(config, device=device)
    separator = separate.build_separator(
        backend.name,
        device=device,
        mlx_bin=config.mlx_bin,
        ffmpeg_bin=config.ffmpeg_bin,
    )

    client = Client(
        config=config,
        connect=_connect,
        run_job=lambda assign: _run(assign, config, adapters, separator, client, dbos),
        capabilities=caps,
        backend=backend.name,
    )

    # ONE registration, before any job. `DBOS.workflow` mutates a global registry, so doing it per job would
    # re-register the same name every time — and its ABSENCE is what meant every step ran outside a workflow
    # context and checkpointed nothing at all.
    #
    # The steps are supplied as PROVIDERS rather than as workflow arguments because DBOS serialises its
    # arguments into the system database: a steps object holds loaded models, a websocket and subprocess
    # handles, so passing it raises `PicklingError`. Only `JobRef` crosses the boundary; these closures keep
    # the process-level state on this side of it.
    def align_steps_for(job: JobRef) -> Any:
        from encore_worker.workflows.dbos_align import DbosAlignSteps  # noqa: PLC0415

        impl = AlignStepsImpl(config=config, adapters=adapters, reporter=_ReporterFor(client))
        return DbosAlignSteps(impl, dbos)

    def stems_steps_for(job: JobRef) -> Any:
        return SeparateStepsImpl(
            config=config,
            audio=AlignStepsImpl(config=config, adapters=adapters, reporter=_ReporterFor(client)),
            reporter=_ReporterFor(client),
            # Roots come from the JOB's media_dir, so a box serving two cores is not forced onto one layout.
            store=LocalArtifactStore(Roots.under(job.media_dir)),
            separator=separator,
            probe=adapters.probe,
            # What the CORE asked for at handshake, not what this box's env says.
            publish_stem_format=client.publish_stem_format,
        )

    durable.register(dbos, align_steps_for=align_steps_for, stems_steps_for=stems_steps_for)
    await client.serve_forever()


def _launch_dbos(config: Config) -> Any:
    """Start DBOS, or return None and run without durability.

    Degrading rather than exiting is deliberate. Durable resumption is an optimisation over restarting a
    job, not a correctness requirement — the core already requeues. A worker that refused to start
    because a SQLite file was unwritable would take the whole box out of service for a feature it can
    work without.
    """
    try:
        from dbos import DBOS, DBOSConfig  # noqa: PLC0415 - optional at runtime
    except ImportError:
        print("[worker] dbos not installed; running without durable resumption", flush=True)
        return None
    try:
        dbos = DBOS(
            config=DBOSConfig(name="encore-worker", system_database_url=f"sqlite:///{config.dbos_db}")
        )
        DBOS.launch()
    except Exception as exc:  # noqa: BLE001 - see the docstring; this must not take the box down
        print(f"[worker] DBOS failed to start ({exc}); running without durable resumption", flush=True)
        return None
    print(f"[worker] durable state in {config.dbos_db}", flush=True)
    return dbos


async def _connect(url: str) -> Any:
    """Open the websocket. Isolated so `Client` never imports a transport library."""
    import websockets  # noqa: PLC0415

    return await websockets.connect(url, max_size=None)


#: Worker labels are `provider` / `captions:authored` / `asr:vocals`-shaped; core's `LyricsTextSource` is a
#: closed set of four. Mapped explicitly rather than by splitting on ":", because an unmapped value would
#: reach core's contract as a string it does not accept and be dropped without a word.
_TEXT_SOURCES: dict[str, str] = {"captions": "captions", "asr": "asr", "manual": "manual"}


def _text_source_of(label: str) -> str:
    """Core's `LyricsTextSource` for one of this worker's labels.

    Everything that is not captions/asr/manual is a PROVIDER, and core spells that `lrclib` — the name is
    historical there (it predates lrcmux), so a provider label maps onto it rather than inventing a fifth
    value core would refuse.
    """
    head = label.split(":", 1)[0]
    return _TEXT_SOURCES.get(head, "lrclib")


def _lyrics_artifacts(outcome: AlignOutcome) -> dict[str, Any] | None:
    """The `artifacts` envelope for an align completion.

    CANDIDATES ARE NOT OPTIONAL DECORATION. Core's retention sweep builds its cleanup set from
    `lyricsCandidates` (`retention.ts:182`), so any document this worker wrote and did not declare here is
    never enumerated and therefore never evicted — it leaks for the life of the library. They are also what
    lets `/api/lyrics-reselect` switch to another reading without re-fetching the audio.

    Reported even when nothing was PUBLISHED: the files exist regardless, so they must be nameable.
    """
    if not outcome.published and not outcome.candidates:
        return None
    now = int(time.time() * 1000)
    candidates = [
        {
            "ref": doc.ref,
            "textSource": _text_source_of(doc.label),
            "timing": doc.timing,
            "textConfidence": doc.confidence,
            "createdAt": now,
            **({"language": doc.language} if doc.language else {}),
        }
        for doc in outcome.candidates
    ]
    lyrics: dict[str, Any] = {"uri": outcome.published.ref if outcome.published else ""}
    if candidates:
        lyrics["candidates"] = candidates
    return {"lyrics": lyrics}


async def _run(
    assign: f.Assign,
    config: Config,
    adapters: Adapters,
    separator: Any,
    client: Client,
    dbos: Any,
) -> f.Complete | f.Failed:
    """Run one assigned job and build its terminal frame.

    The action-to-workflow mapping lives here and nowhere else. An unknown action fails NON-retryably:
    the core should not have routed it, and three attempts cannot teach this worker a new verb.
    """
    job = JobRef(
        job_id=assign.job_id,
        media_id=assign.media_id,
        # The core does not name the volume — it is a property of THIS host, so this box's config is the
        # authority. An assignment that does name one wins, for a core that mounts it somewhere specific.
        media_dir=assign.media_dir or config.media_dir,
        source_uri=assign.source_uri,
        params=assign.params or {},
    )
    if assign.action == "align":
        outcome = await durable.align(job)
        return f.Complete(
            worker_id=config.worker_id,
            job_id=job.job_id,
            media_uri=outcome.published.ref if outcome.published else "",
            # `uri`, NOT `ref`. Core's `JobArtifacts.lyrics` is `{ uri, candidates? }` and reads
            # `artifacts?.lyrics?.uri` — `ref` is the field on a CANDIDATE, so the old key left core with
            # an undefined uri and no lyrics on a job that had just published them.
            artifacts=_lyrics_artifacts(outcome),
            facts={"backend": config.backend, "noLyrics": outcome.no_lyrics},
            trail=tuple(dict(entry) for entry in outcome.trail),
        )

    if assign.action in ("stems", "stems-upgrade"):
        separated = await durable.stems(job)
        stems = separated.published
        return f.Complete(
            worker_id=config.worker_id,
            job_id=job.job_id,
            # `mediaUri` is REQUIRED by core's validation (`worker-hub.ts` rejects a non-string), so a
            # refusal sends "" rather than omitting it — the frame must still parse to report the refusal.
            media_uri=stems.instrumental if stems else "",
            # EVERY ref, not just the instrumental. Core has a field per stem and uses them to serve, to
            # evict under retention and to delete with the media — an unreported ref is a file nothing
            # will ever clean up and nothing can play.
            artifacts=(
                {
                    "stems": {
                        k: v
                        for k, v in (
                            ("instrumental", stems.instrumental),
                            ("vocals", stems.vocals),
                            ("guideMix", stems.guide_mix),
                        )
                        if v
                    }
                }
                if stems
                else None
            ),
            facts={
                "backend": config.backend,
                "engine": getattr(separator, "name", None),
                "refused": separated.refused,
            },
        )

    if assign.action == "fetch":
        # Fetch is deliberately NOT durable: it is one download, and DBOS would checkpoint a step whose
        # retry is cheaper than its bookkeeping. See new-worker/README.md "What is deliberately absent".
        fetched = await run_fetch(
            job,
            FetchStepsImpl(
                config=config,
                audio=AlignStepsImpl(config=config, adapters=adapters, reporter=_ReporterFor(client)),
                reporter=_ReporterFor(client),
            ),
        )
        return f.Complete(
            worker_id=config.worker_id,
            job_id=job.job_id,
            media_uri=fetched.published,
            facts={
                "artist": fetched.identified.artist,
                "track": fetched.identified.track,
                "identifiedFrom": fetched.identified.source,
                "unidentified": fetched.unidentified,
            },
        )

    return f.Failed(
        worker_id=config.worker_id,
        job_id=job.job_id,
        error=f"this worker has no workflow for action {assign.action!r}",
        retryable=False,
    )


class _ReporterFor:
    """Adapts `Client` to the narrow `Reporter` a step is allowed to use.

    A step must not be able to send arbitrary frames — `job:accept` from inside an alignment would
    corrupt the conversation — so this exposes exactly four methods and nothing else.
    """

    def __init__(self, client: Client) -> None:
        self._client = client

    async def progress(self, job_id: str, stage: Any, pct: int) -> None:
        await self._client.progress(job_id, stage, pct)

    async def state(
        self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        await self._client.state(job_id, state, attempt, verdict, why, knob)

    async def confirm_ownership(self, job_id: str, *, timeout_sec: float = 10.0) -> bool:
        return await self._client.confirm_ownership(job_id, timeout_sec=timeout_sec)

    def explain_ownership(self, job_id: str) -> str:
        return self._client.ownership.explain(job_id)


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
