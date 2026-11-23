"""The composition root: read config, probe the box, build the adapters, dial home.

    python -m encore_worker

The only module allowed to import every layer, because it wires the graph (`tests/test_layers.py` skips it by
name). It holds no decisions — anything with a judgement in it belongs in `domain/`.

See docs/arch/05-worker.md §1.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Coroutine, Sequence
from typing import Any, TypeVar

from encore_worker.adapters import cli, lrclib, lrcmux, ml, musicbrainz, ports, separate, zoo
from encore_worker.artifacts import scratch
from encore_worker.artifacts.local import LocalArtifactStore, Roots
from encore_worker.domain.identity import Identified
from encore_worker.domain.lyrics import language, lexical, romanize, units
from encore_worker.host import ffmpeg, hardware
from encore_worker.host.config import Config, ConfigError
from encore_worker.protocol import frames as f
from encore_worker.protocol.vocabulary import Stage
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl
from encore_worker.steps.align_text import Superseded, superseded_candidates
from encore_worker.steps.api import asr_model_of, pin_of, sync_mode_of
from encore_worker.steps.records import AlignOutcome, JobRef, tier_of_label
from encore_worker.steps.separate_steps import FetchStepsImpl, SeparateStepsImpl
from encore_worker.transport import client as transport_client
from encore_worker.transport.client import Client
from encore_worker.workflows import durable
from encore_worker.workflows.fetch import FetchOutcome, run_fetch
from encore_worker.workflows.stems import StemsOutcome

_T = TypeVar("_T")


def build_adapters(config: Config, *, device: str) -> Adapters:
    """Everything this box can actually do. An absent adapter is None, never a stub that fails later.

    None is load-bearing: each step checks its adapter and degrades — no transcriber means the ASR tier
    yields nothing, which the search reads as "ASR had its turn and heard nothing". A stub that raised would
    turn a missing capability into a failed job.
    """
    return Adapters(
        fetcher=cli.YtDlpAudio(config.ytdlp_bin) if hardware.binary_available(config.ytdlp_bin) else None,
        probe=cli.FfmpegProbe(config.ffmpeg_bin) if hardware.binary_available(config.ffmpeg_bin) else None,
        captions=cli.YtDlpCaptions(config.ytdlp_bin) if hardware.binary_available(config.ytdlp_bin) else None,
        providers=build_providers(config),
        transcriber=ml.build_transcriber(device=device, checkpoint=config.asr_model),
        # A job's own `asrModel`: built on demand, the weights cached per checkpoint in `ml`.
        transcriber_for=lambda checkpoint: ml.build_transcriber(device=device, checkpoint=checkpoint),
        # `jobs` sizes the emission cache, which holds a matrix per LIVE job (`ml._emission_cache_size`).
        aligner=ml.build_aligner(
            device=device,
            jobs=config.concurrency,
            model=align_model_for(config, device),
            nonlatin_routes=nonlatin_routes_for(config),
        ),
        diarizer=ml.build_diarizer(device=device),
        # Built ONCE per process: lingua holds n-gram models per language. None without the `text` extra,
        # which costs accuracy on non-English LATIN songs and nothing else, the script half of the decision
        # being stdlib `unicodedata`. See docs/arch/04-alignment.md §9.
        detector=language.lingua_detector(),
        # DISPLAY-ONLY, and the factory rather than one romaniser: the language AND the script are
        # per-document facts and each backend is built once on first use (`romanize.build_romanizer`). None
        # for every language without the `romanize` extra, which publishes what this worker always did
        # (XA-19).
        romanizer=romanize.build_romanizer,
    )


def build_providers(config: Config) -> tuple[ports.LyricsProvider, ...]:
    """The lyrics providers, IN PRIORITY ORDER; empty when offline.

    LRCmux first because it fans one lookup across many sources and can return WORD-level timings. LRCLIB
    second: a single source LRCmux already queries, so a genuine fallback only when LRCmux is unreachable.
    See docs/arch/05-worker.md §6.
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


def align_model_for(config: Config, device: str) -> str:
    """The English alignment bundle this box will align on, REFUSED HERE if nothing calibrated it.

    An uncalibrated bundle makes every emission-scale gate stand down, which is wrong for a model an operator
    typed in. The only place the check can live, and with `host.config`'s manners: docs/arch/04-alignment.md
    §5.4 and docs/arch/05-worker.md §9 (XA-06).
    """
    named = config.align_model
    if named is not None and not lexical.is_calibrated(named):
        raise ConfigError(
            f"ENCORE_ALIGN_MODEL={named!r}: {lexical.uncalibrated(named)}. Expected one of "
            f"{', '.join(lexical.calibrated_pairs())}, or leave it unset for this device's default "
            f"({ml.default_align_model(device)})."
        )
    return named or ml.default_align_model(device)


def nonlatin_routes_for(config: Config) -> dict[str, str]:
    """`{language: the bundle it aligns on}` for every non-Latin language `units.ROUTED` routes off
    whisperx's own table — the startup reading of the per-language stage-2 table (XA-21).

    A box with no transliterator for that language is NOT routed (`units.stage2_bundle`) and keeps the
    script-unit rule; only an operator who NAMED `mms-roman` with no transliterator at all is refused
    outright. MMS_FA's weights are CC-BY-NC (docs/arch/04-alignment.md §9.2, §14.2).
    """
    if "mms-roman" in config.align_experiments and not any(
        romanize.build_transliterator(code) is not None for code in romanize.BACKENDS
    ):
        raise ConfigError(
            "ENCORE_ALIGN_EXPERIMENTS=mms-roman pairs MMS_FA's 26-letter Latin vocabulary with a romanised "
            "target sequence, and this box can build no transliterator for any language: install the "
            "`romanize` extra (pypinyin, cutlet, uroman) or drop the arm."
        )
    routes = {code: units.stage2_bundle(code, config.align_experiments) for code in sorted(units.ROUTED)}
    return {code: bundle for code, bundle in routes.items() if bundle != units.OWN_BUNDLE}


def _routes_described(config: Config) -> str:
    """The per-language stage-2 table as this box resolved it, for the startup line: which arms each routed
    language gets, on which bundle, and which arms this box could not honour for want of a backend."""
    routes = nonlatin_routes_for(config)
    out = []
    for code in sorted(units.ROUTED):
        arms = ",".join(sorted(units.arms_for(code, config.align_experiments))) or "none"
        bundle = ml.align_model_name(code, None, routes)
        missing = sorted(units.unhonoured(code, config.align_experiments))
        absent = f" [no backend for {','.join(missing)}]" if missing else ""
        words = "words may publish" if lexical.is_calibrated(bundle, code) else "LINES ONLY"
        out.append(f"{code}={arms} on {bundle} ({words}){absent}")
    return "; ".join(out)


def device_for(config: Config, report: hardware.Report) -> str:
    """The torch device string. Explicit config wins, else what the box actually has.

    Resolved ONCE here and threaded everywhere, so separation, alignment and diarization cannot end up on
    different devices, and `Hello.device` reports what the models were really built with.
    """
    if config.device:
        return config.device
    return {"cuda": "cuda", "mps": "mps"}.get(report.accelerator, "cpu")


async def main() -> None:
    config = Config.from_env()
    report = hardware.probe()
    backend = hardware.resolve_backend(config.backend, report=report, mlx_bin=config.mlx_bin)
    device = device_for(config, report)
    jobs = hardware.resolve_demucs_jobs(config.demucs_jobs, device=device)
    caps = hardware.capabilities(
        backend=backend.name,
        ytdlp=config.ytdlp_bin,
        ffmpeg=config.ffmpeg_bin,
        mlx_bin=config.mlx_bin,
    )
    # Checked ONCE here rather than failed once per align job (`ml.diarizer_blocked`).
    diarize_off = ml.diarizer_blocked() if "diarize" in caps else None
    if diarize_off:
        caps = caps - {"diarize"}

    print(
        f"[worker] {config.worker_id} on {report.platform} ({report.machine}); "
        f"accelerator={report.accelerator} device={device} backend={backend.name} ({backend.why}); "
        f"demucs -j {jobs.count} ({jobs.why}); "
        f"capabilities={','.join(sorted(caps)) or 'NONE'}",
        flush=True,
    )
    # WHICH ffmpeg and WHICH align bundle, stated once at startup because nothing in `job_attempts` records
    # either, and both are properties of every artifact this box publishes. `align_model_for` is pure, so this
    # line says what `build_adapters` resolves below — and refuses an uncalibrated name before any work.
    print(f"[worker] ffmpeg {ffmpeg.describe(config.ffmpeg_bin)}", flush=True)
    print(f"[worker] align bundle {align_model_for(config, device)} (en; ENCORE_ALIGN_MODEL)", flush=True)
    if diarize_off:
        print(f"[worker] diarize off: {diarize_off}", flush=True)
    if "fetch:ytdlp" in caps and (gap := hardware.youtube_gap(config.ytdlp_config_paths)):
        print(f"[worker] WARNING: YouTube downloads will fail without {gap}", flush=True)
    if not caps:
        # Not fatal: a box with no capabilities still connects and is visible on the dashboard, which beats a
        # process that exits and leaves an operator wondering where the worker went.
        print("[worker] WARNING: no capabilities proven, so the core will route nothing here", flush=True)

    dbos = _launch_dbos(config)
    adapters = build_adapters(config, device=device)
    if diarize_off:
        adapters.diarizer = None
    # The STARTUP fallback, used only when a job names no engine of its own. No `model` here on purpose:
    # there is no job to read one from, so each engine takes its own default.
    separator = separate.build_separator(
        backend.name,
        device=device,
        mlx_bin=config.mlx_bin,
        ffmpeg_bin=config.ffmpeg_bin,
        zoo_model_dir=config.zoo_model_dir,
        demucs_jobs=jobs.count,
    )

    def settled(job_id: str, resumable: bool) -> None:
        """Reclaim a finished job's scratch — unless a retry could RESUME it.

        Every checkpointed step returns paths INTO scratch, so a requeue replays into those files and deleting
        them would break the one case durability exists for. `artifacts/scratch.py` has the outcome table.
        """
        if resumable:
            return
        freed = scratch.release(config.media_dir, job_id)
        if freed > 0:
            print(f"[worker] reclaimed {freed // (1024 * 1024)} MB of scratch for {job_id}", flush=True)

    client = Client(
        config=config,
        connect=_connect,
        run_job=lambda assign: _run(assign, config, adapters, separator, client, dbos),
        capabilities=caps,
        backend=backend.name,
        host=report.to_wire(),
        on_settled=settled,
        stop_job=_stop,
        # Enumerated OFF the event loop after registration — 4.8 s cold, and a picker's contents must not
        # delay the handshake. None on a box without the `audiosep` extra, which skips the frame entirely.
        catalogue=zoo.announcement if hardware.module_available("audio_separator") else None,
    )

    # ONE registration, before any job: `DBOS.workflow` mutates a global registry. The steps are supplied as
    # PROVIDERS rather than as workflow arguments because DBOS serialises its arguments into the system
    # database and a steps object holds loaded models, a socket and subprocess handles, so passing it raises
    # `PicklingError`. Only `JobRef` crosses the boundary. See docs/arch/05-worker.md §8.
    #: The loop the client serves on. A workflow DBOS resumes runs on DBOS's own loop (`_ReporterFor`), and
    #: these providers are called from inside the workflow, so the loop is captured HERE, not there.
    loop = asyncio.get_running_loop()

    def align_steps_for(job: JobRef) -> Any:
        from encore_worker.workflows.dbos_align import DbosAlignSteps  # noqa: PLC0415

        impl = AlignStepsImpl(config=config, adapters=adapters, reporter=_ReporterFor(client, loop))
        return DbosAlignSteps(impl, dbos)

    def stems_steps_for(job: JobRef) -> Any:
        # Built PER JOB from the job's OWN `engine` and `model` params, not once at startup from the box's
        # backend: a `stems-upgrade` job names the engine it wants, and honouring the startup backend instead
        # would publish a demucs separation as the upgrade with nothing downstream able to contradict it.
        # See docs/arch/05-worker.md §2.4.
        chosen = (
            separate.build_separator(
                backend.name,
                device=device,
                mlx_bin=config.mlx_bin,
                ffmpeg_bin=config.ffmpeg_bin,
                engine=job.param_str("engine"),
                model=job.param_str("model"),
                zoo_model_dir=config.zoo_model_dir,
                demucs_jobs=jobs.count,
            )
            or separator
        )
        return SeparateStepsImpl(
            config=config,
            audio=AlignStepsImpl(config=config, adapters=adapters, reporter=_ReporterFor(client, loop)),
            reporter=_ReporterFor(client, loop),
            # Roots come from the JOB's media_dir, so a box serving two cores is not forced onto one layout.
            store=LocalArtifactStore(Roots.under(job.media_dir)),
            separator=chosen,
            probe=adapters.probe,
            # What the CORE asked for at handshake, not what this box's env says.
            publish_stem_format=client.publish_stem_format,
        )

    durable.register(dbos, align_steps_for=align_steps_for, stems_steps_for=stems_steps_for)

    # The SECOND reclaim mechanism, not redundant with `settled` above: it reaches the two leaks a run-end
    # hook cannot (a crash, and retries exhausting unseen). See docs/arch/05-worker.md §4.
    sweeper = asyncio.create_task(_sweep_scratch(config))
    # Off the loop and AFTER the dial starts: describing the routes imports torch, transformers and whisperx
    # (5.5 s on a warm CPU box), and nothing the handshake needs waits on a log line.
    routes = asyncio.create_task(asyncio.to_thread(_print_routes, config))
    try:
        await client.serve_forever()
    finally:
        for task in (sweeper, routes):
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task


def _print_routes(config: Config) -> None:
    """The startup line for the per-language stage-2 table. `nonlatin_routes_for` already refused a bad arm
    in `build_adapters`, before the dial, so a failure here is only a log line's."""
    try:
        print(f"[worker] non-Latin routes {_routes_described(config)}", flush=True)
    except Exception as exc:  # noqa: BLE001 - a log line must not take the worker down
        print(f"[worker] non-Latin routes not described ({type(exc).__name__}: {exc})", flush=True)


def _launch_dbos(config: Config) -> Any:
    """Start DBOS, or return None and run without durability.

    Degrading rather than exiting: durable resumption is an optimisation over restarting a job, not a
    correctness requirement, since the core already requeues. A worker that refused to start because a SQLite
    file was unwritable would take the box out of service for a feature it can work without.
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


def _annotation_artifacts(found: Identified) -> dict[str, Any] | None:
    """The `annotation` artifact — how core learns a song's canonical artist and title.

    Not the same as reporting it in `facts`, which records only what ran: these become a later align job's
    provider lookup keys. None when the song was not identified, core requiring both names and a
    half-annotation claiming a key that returns another song's words (docs/arch/05-worker.md §6).
    """
    if not found.confident:
        return None
    if found.source == "musicbrainz" and found.mbid:
        # `mbid` is required rather than optional: core accepts `source: "musicbrainz"` only with one, so
        # sending the source without the id is silently ignored — worse than the youtube floor below, because
        # it looks like it worked.
        return {
            "annotation": {
                "source": "musicbrainz",
                "mbid": found.mbid,
                "artist": found.artist or "",
                "title": found.track or "",
                # `high` ONLY when a duration corroborated the names; see `domain/metadata.confidence_for`.
                "confidence": found.confidence,
            }
        }
    # The YOUTUBE FLOOR: no MBID, which core requires only for a musicbrainz annotation. `medium` because this
    # is a parse of an uploader-typed title — never `high`, which core treats as a citation a later
    # medium-confidence answer may not overwrite.
    return {
        "annotation": {
            "source": "youtube",
            "artist": found.artist or "",
            "title": found.track or "",
            "confidence": "medium",
        }
    }


def _lyrics_artifacts(
    outcome: AlignOutcome,
    *,
    now_ms: int | None = None,
    withdrawn: Sequence[Superseded] = (),
    pinned: bool = False,
) -> dict[str, Any] | None:
    """The `artifacts` envelope for an align completion: every document this job wrote, and which one won.

    CANDIDATES ARE NOT OPTIONAL DECORATION: core's retention sweep builds its cleanup set from them, so an
    undeclared document is never evicted, and they are reported even when nothing was PUBLISHED. The four
    fields core ranks on, and what each replaced: docs/arch/04-alignment.md §11 (XA-13), docs/SERVER.md.
    """
    if not outcome.published and not outcome.candidates and not withdrawn:
        return None
    now = int(time.time() * 1000) if now_ms is None else now_ms
    chosen = outcome.published.ref if outcome.published else None
    candidates = [
        {
            "ref": doc.ref,
            "textSource": _text_source_of(doc.label),
            "timing": doc.timing,
            # A pinned job reports only the pin's own document (`workflows.align._publish`), so `pinned`
            # speaks for every candidate here; `withdrawn` below are earlier jobs' and keep their tier.
            "textConfidence": ("high" if pinned else doc.tier.text_confidence),
            # The WORDS' axis, only when a gate withheld them: absent is core's "vouched".
            **({} if doc.vouched else {"vouched": False}),
            "timingConfidence": doc.confidence,
            "selectable": doc.ref == chosen,
            "createdAt": now,
            **({"language": doc.language} if doc.language else {}),
        }
        for doc in outcome.candidates
    ]
    candidates += [
        {
            "ref": old.ref,
            "textSource": _text_source_of(old.label),
            "timing": old.timing,
            "textConfidence": tier_of_label(old.label).text_confidence,
            "selectable": False,
            "createdAt": now,
            **({"language": old.language} if old.language else {}),
        }
        for old in withdrawn
        if old.ref != chosen
    ]
    lyrics: dict[str, Any] = {"uri": outcome.published.ref if outcome.published else ""}
    if candidates:
        lyrics["candidates"] = candidates
    return {"lyrics": lyrics}


def _align_facts(job: JobRef, config: Config, outcome: AlignOutcome) -> dict[str, Any]:
    """What an align job RAN, for core's attempt row (`ResolvedFacts`, `reportFacts`).

    `asrModel` and `syncMode` are the RESOLVED values, the ones `steps.api` resolved for the steps: core
    records the request at dispatch and lets these overwrite it, so a checkpoint this worker would not load,
    or a pin aligned under `lines`, is reported as what ran rather than as what was asked.
    """
    return {
        "backend": config.backend,
        "noLyrics": outcome.no_lyrics,
        "asrModel": asr_model_of(job, config.asr_model),
        # What RAN: `lines` on a stemless song is aligned (`workflows.align._sync_mode_note`). A record
        # checkpointed before the field existed restores it as None (`restore_appended`): the job's param.
        "syncMode": outcome.sync_mode or sync_mode_of(job).value,
    }


def _fetch_completion(job: JobRef, config: Config, fetched: FetchOutcome) -> f.Complete | f.Failed:
    """The terminal frame a fetch job sends."""
    if not fetched.published:
        # Empty ONLY when the publish was refused for ownership: as for stems and align, that is not a
        # completion, and sent as one core marked the fetch done and queued its follow-ups.
        return f.Failed(config.worker_id, job.job_id, fetched.why, retryable=True)
    return f.Complete(
        worker_id=config.worker_id,
        job_id=job.job_id,
        media_uri=fetched.published,
        artifacts=_annotation_artifacts(fetched.identified),
        facts={
            "artist": fetched.identified.artist,
            "track": fetched.identified.track,
            "identifiedFrom": fetched.identified.source,
            "unidentified": fetched.unidentified,
        },
    )


def _stems_completion(
    job: JobRef, config: Config, separated: StemsOutcome, separator: Any
) -> f.Complete | f.Failed:
    """The terminal frame a stems job sends. `separator` is the startup one, the engine fact's fallback."""
    stems = separated.published
    if stems is None:
        # NOTHING was published, so this is not a completion: a `job:complete` here once made core mark
        # the song ready over a file never written. Retryable, because the refusal is about ownership,
        # not the audio; core ignores it when the job is already someone else's.
        return f.Failed(config.worker_id, job.job_id, separated.why, retryable=True)
    return f.Complete(
        worker_id=config.worker_id,
        job_id=job.job_id,
        media_uri=stems.instrumental,
        # EVERY ref, not just the instrumental: core serves, evicts and deletes per stem, so an
        # unreported ref is a file nothing will ever clean up and nothing can play.
        artifacts={
            # ALWAYS present when separation succeeded. Core's process gate reads a present profile as
            # "the analysis step ran"; an absent one leaves the song unsingable AND never reprocessed.
            "songProfile": dict(separated.profile or {}),
            "stems": {
                k: v
                for k, v in (
                    ("instrumental", stems.instrumental),
                    ("vocals", stems.vocals),
                    ("guideMix", stems.guide_mix),
                )
                if v
            },
        },
        # What RAN: a `stems-upgrade` builds its own separator per job, so the startup one is only the
        # fallback. An unknown model is OMITTED, so it cannot overwrite the requested one with null.
        facts={
            "backend": config.backend,
            # `getattr`: a record checkpointed before these fields existed unpickles without them.
            "engine": getattr(stems, "engine", None) or getattr(separator, "name", None),
            **({"model": model} if (model := getattr(stems, "model", None)) else {}),
            "refused": False,
        },
    )


def _align_completion(
    job: JobRef, config: Config, outcome: AlignOutcome, *, now_ms: int | None = None
) -> f.Complete:
    """The `job:complete` an align job sends — the frame core's `setMediaLyrics` reads.

    One builder, so the cross-language contract fixture (`tests/test_core_contract.py`, parsed by core's
    `worker-align-contract.test.ts`) is written from the frame this worker actually sends, not a copy.
    """
    return f.Complete(
        worker_id=config.worker_id,
        job_id=job.job_id,
        media_uri=outcome.published.ref if outcome.published else "",
        # `uri`, NOT `ref`: `ref` is the field on a CANDIDATE, and core reads `artifacts?.lyrics?.uri`.
        artifacts=_lyrics_artifacts(
            outcome,
            now_ms=now_ms,
            withdrawn=superseded_candidates(
                job, outcome.refused, placed={doc.ref for doc in outcome.candidates}
            ),
            pinned=pin_of(job) is not None,
        ),
        facts=_align_facts(job, config, outcome),
        trail=tuple(dict(entry) for entry in outcome.trail),
    )


async def _sweep_scratch(config: Config, *, every_sec: float = 900.0) -> None:
    """Reclaim quiet job scratch on a timer, forever.

    Safe on a volume shared with another worker, and never lets a sweep failure stop the worker.
    See docs/arch/05-worker.md §4.
    """
    while True:
        await asyncio.sleep(every_sec)
        try:
            got = await asyncio.to_thread(scratch.sweep, config.media_dir)
        except Exception as exc:  # noqa: BLE001 - maintenance must never take the worker down
            print(f"[worker] scratch sweep failed ({type(exc).__name__}: {exc})", flush=True)
            continue
        if got.any_removed:
            print(
                f"[worker] swept {len(got.removed)} orphaned scratch dir(s), "
                f"{got.bytes_freed // (1024 * 1024)} MB freed; {got.kept_live} still live",
                flush=True,
            )


async def _run(
    assign: f.Assign,
    config: Config,
    adapters: Adapters,
    separator: Any,
    client: Client,
    dbos: Any,
) -> f.Complete | f.Failed:
    """Run one assigned job and build its terminal frame, wrapped in a progress keepalive.

    The keepalive is a correctness requirement, not a nicety: `job:progress` doubles as the core's lease
    refresh, so without it a long step is revoked mid-job. See docs/arch/05-worker.md §7.
    """
    job = JobRef(
        job_id=assign.job_id,
        media_id=assign.media_id,
        # The volume is a property of THIS host, so this box's config is the authority — but an assignment
        # that does name one wins, for a core that mounts it somewhere specific.
        media_dir=assign.media_dir or config.media_dir,
        source_uri=assign.source_uri,
        params=assign.params or {},
    )
    # Set BEFORE the keepalive task exists, so every task and thread this job starts carries it.
    token = cli.tokens[job.job_id] = cli.CancelToken()
    bound = cli.current_token.set(token)
    # One task per job, cancelled in `finally` below.
    keeper = asyncio.create_task(
        transport_client.keepalive(
            client,
            job.job_id,
            _STAGE_FOR.get(assign.action, Stage.SEPARATING),
            every_sec=config.keepalive_sec,
            ceiling_sec=config.job_ceiling_sec,
        )
    )
    try:
        return await _dispatch(assign, job, config, adapters, separator, client, dbos)
    finally:
        cli.current_token.reset(bound)
        keeper.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await keeper
        # A cancelled run leaves its token for `_stop`, which runs after this unwinds.
        task = asyncio.current_task()
        if task is None or not task.cancelling():
            cli.tokens.pop(job.job_id, None)


#: How long a stop waits before it says the job's work is still running. It goes on waiting: a SIGKILLed
#: child is reaped in milliseconds, so what outlives this is in-process work (the zoo), which holds the box.
_STOP_WAIT_SEC = 10.0


async def _stop(job_id: str) -> None:
    """Stop a job the core took back: its workflow first, so DBOS starts no further step, then its children.

    Returns once the job's work has ended (its `run` children and any in-process call counted by
    `cli.in_job`), which is what keeps the slot counted until then (WK-02).
    """
    token = cli.tokens.pop(job_id, None)
    try:
        await durable.cancel(job_id)
    except Exception as exc:  # noqa: BLE001 - the children must still be killed
        print(
            f"[worker] job {job_id}: could not cancel its workflow ({type(exc).__name__}: {exc})", flush=True
        )
    if token is None:
        return
    token.cancel()
    if await asyncio.to_thread(token.wait_idle, _STOP_WAIT_SEC):
        return
    print(
        f"[worker] job {job_id}: still running {_STOP_WAIT_SEC:.0f}s after its stop; holding its slot",
        flush=True,
    )
    await asyncio.to_thread(token.wait_idle, None)


#: The stage a keepalive reports for each action, so the phone shows the right word while a long step runs.
_STAGE_FOR = {
    "fetch": Stage.DOWNLOADING,
    "stems": Stage.SEPARATING,
    "stems-upgrade": Stage.SEPARATING,
    "align": Stage.ALIGNING,
}


async def _dispatch(
    assign: f.Assign,
    job: JobRef,
    config: Config,
    adapters: Adapters,
    separator: Any,
    client: Client,
    dbos: Any,
) -> f.Complete | f.Failed:
    """The action-to-workflow mapping, split from `_run` so the keepalive wraps every branch.

    An unknown action fails NON-retryably: the core should not have routed it, and three attempts cannot
    teach this worker a new verb.
    """
    if assign.action == "align":
        aligned = await durable.align(job)
        if aligned.abandoned:
            # As for stems: a refusal is not a completion. Sent as one, core settled the lyrics gate as
            # "align ran and found no lyrics" for a job nobody finished.
            return f.Failed(config.worker_id, job.job_id, aligned.why, retryable=True)
        return _align_completion(job, config, aligned)

    if assign.action in ("stems", "stems-upgrade"):
        return _stems_completion(job, config, await durable.stems(job), separator)

    if assign.action == "fetch":
        # Fetch is deliberately NOT durable: one download, whose retry is cheaper than its bookkeeping.
        fetched = await run_fetch(
            job,
            FetchStepsImpl(
                config=config,
                audio=AlignStepsImpl(config=config, adapters=adapters, reporter=_ReporterFor(client)),
                reporter=_ReporterFor(client),
                # Built per fetch: it holds no models and no socket, so there is nothing to amortise, and
                # `ENCORE_ANNOTATE=0` is then honoured without a restart.
                annotator=musicbrainz.build_client(),
            ),
        )
        return _fetch_completion(job, config, fetched)

    return f.Failed(
        worker_id=config.worker_id,
        job_id=job.job_id,
        error=f"this worker has no workflow for action {assign.action!r}",
        retryable=False,
    )


class _ReporterFor:
    """Adapts `Client` to the narrow `Reporter` a step is allowed to use, on the CLIENT's loop.

    A step must not be able to send arbitrary frames — `job:accept` from inside an alignment would corrupt the
    conversation — so this exposes exactly four methods. DBOS runs a workflow IT resumes on its own background
    loop in another thread, while the socket and the ownership event belong to the loop `serve_forever` runs:
    awaited from the other loop, a send is swallowed and `confirm_ownership` raises on an event bound to the
    wrong loop, failing the publish. So a call from another loop is handed to the client's.
    """

    def __init__(self, client: Client, loop: asyncio.AbstractEventLoop | None = None) -> None:
        self._client = client
        #: The loop the client serves on: given by the composition root, else the one constructing this
        #: (`_run`, which the client itself calls from that loop).
        self._loop = loop if loop is not None else asyncio.get_running_loop()

    async def _on_client_loop(self, call: Coroutine[Any, Any, _T]) -> _T:
        if asyncio.get_running_loop() is self._loop:
            return await call
        return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(call, self._loop))

    async def progress(self, job_id: str, stage: Any, pct: int) -> None:
        await self._on_client_loop(self._client.progress(job_id, stage, pct))

    async def state(
        self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        await self._on_client_loop(self._client.state(job_id, state, attempt, verdict, why, knob))

    async def confirm_ownership(self, job_id: str, *, timeout_sec: float = 10.0) -> bool:
        return await self._on_client_loop(self._client.confirm_ownership(job_id, timeout_sec=timeout_sec))

    def explain_ownership(self, job_id: str) -> str:
        return self._client.ownership.explain(job_id)


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
