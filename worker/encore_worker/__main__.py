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
from collections.abc import Coroutine, Sequence
from typing import Any, TypeVar

from encore_worker.adapters import cli, lrclib, lrcmux, ml, musicbrainz, ports, separate, zoo
from encore_worker.artifacts import scratch
from encore_worker.artifacts.local import LocalArtifactStore, Roots
from encore_worker.domain.identity import Identified
from encore_worker.domain.lyrics import lexical
from encore_worker.host import ffmpeg, hardware
from encore_worker.host.config import Config, ConfigError
from encore_worker.protocol import frames as f
from encore_worker.protocol.vocabulary import Stage
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl, Superseded, superseded_candidates
from encore_worker.steps.api import asr_model_of, pin_of, sync_mode_of
from encore_worker.steps.records import AlignOutcome, JobRef, tier_of_label
from encore_worker.steps.separate_steps import FetchStepsImpl, SeparateStepsImpl
from encore_worker.transport import client as transport_client
from encore_worker.transport.client import Client
from encore_worker.workflows import durable
from encore_worker.workflows.fetch import run_fetch

_T = TypeVar("_T")


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
        # A job's own `asrModel` (review H5): built on demand, the weights cached per checkpoint in `ml`.
        transcriber_for=lambda checkpoint: ml.build_transcriber(device=device, checkpoint=checkpoint),
        # `jobs` sizes the emission cache, which holds a matrix per LIVE job (`ml._emission_cache_size`);
        # `model` is the English bundle this box aligns on, checked for a calibration row first (6b, W4b).
        aligner=ml.build_aligner(
            device=device, jobs=config.concurrency, model=align_model_for(config, device)
        ),
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


def align_model_for(config: Config, device: str) -> str:
    """The English alignment bundle this box will align on, REFUSED HERE if nothing calibrated it.

    THE LOUD HALF of "fail loudly or refuse to gate" (`domain.lyrics.lexical`'s module docstring, W4b). Every
    threshold read off an emission matrix — the lexical lift's bands, the mix floor, the LINE_SYNC rung's
    decode-agreement share — belongs to the bundle it was measured on, and `lexical.CALIBRATED` holds one row
    per bundle. A matrix from a model with NO row is not gated on another's numbers: the readers stand down
    and the text is merely not vouched for, which is right for a per-language bundle nobody chose (a German
    XLSR fine-tune) and WRONG for a model an operator typed in — that worker would run every job with its
    wrong-text gate silently off. So a named-but-uncalibrated `ENCORE_ALIGN_MODEL` ends the process here,
    with `host.config`'s manners: name the variable, say what is accepted, do not retry.

    THE ONE PLACE THIS CAN LIVE. `Config.from_env` cannot make the check (`host/` may not import `domain/`,
    `tests/test_layers.py`) and `adapters/ml` must not either — importing `lexical` there would put every
    calibrated threshold inside the emission cache's code fingerprint, so moving a band would invalidate
    every cached matrix (`e2e_lib.module_closure` reads lazy imports too). This module already imports every
    layer by definition, and it is where the DEVICE is resolved, which is what an unset knob resolves against.
    """
    named = config.align_model
    if named is not None and not lexical.is_calibrated(named):
        raise ConfigError(
            f"ENCORE_ALIGN_MODEL={named!r}: {lexical.uncalibrated(named)}. Expected one of "
            f"{', '.join(sorted(lexical.CALIBRATED))}, or leave it unset for this device's default "
            f"({ml.default_align_model(device)})."
        )
    return named or ml.default_align_model(device)


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
    caps = hardware.capabilities(
        backend=backend.name,
        ytdlp=config.ytdlp_bin,
        ffmpeg=config.ffmpeg_bin,
    )

    print(
        f"[worker] {config.worker_id} on {report.platform} ({report.machine}); "
        f"accelerator={report.accelerator} device={device} backend={backend.name} ({backend.why}); "
        f"capabilities={','.join(sorted(caps)) or 'NONE'}",
        flush=True,
    )
    # WHICH ffmpeg, stated once at startup. Every published stem was encoded by this binary, and nothing in
    # `job_attempts` records its version — so without this line "why does one worker's FLAC differ" has no
    # answer but guessing from the machine.
    print(f"[worker] ffmpeg {ffmpeg.describe(config.ffmpeg_bin)}", flush=True)
    # WHICH ENGLISH ALIGNMENT BUNDLE, for the same reason and since the same wave made it a setting (W4b 6b;
    # W4b review r1 found nothing on the record naming it). Every emission-scale threshold a job's gates read
    # comes off this bundle's calibration row, and `align_model_for` is pure, so printing it here says what
    # `build_adapters` will resolve below — and refuses an uncalibrated name before the box claims any work.
    print(f"[worker] align bundle {align_model_for(config, device)} (en; ENCORE_ALIGN_MODEL)", flush=True)
    if not caps:
        # Not fatal: a box with no capabilities still connects and is visible on the dashboard, which is
        # more useful than a process that exits and leaves an operator wondering where the worker went.
        print("[worker] WARNING: no capabilities proven, so the core will route nothing here", flush=True)

    dbos = _launch_dbos(config)
    adapters = build_adapters(config, device=device)
    # The STARTUP fallback, used only when a job names no engine of its own. No `model` here on purpose:
    # there is no job to read one from, so each engine takes its own default.
    separator = separate.build_separator(
        backend.name,
        device=device,
        mlx_bin=config.mlx_bin,
        ffmpeg_bin=config.ffmpeg_bin,
        zoo_model_dir=config.zoo_model_dir,
    )

    def settled(job_id: str, resumable: bool) -> None:
        """Reclaim a finished job's scratch — unless a retry could RESUME it.

        `resumable` is the whole decision. Every checkpointed step returns paths INTO scratch, so a requeue
        replays into those files; deleting them would break the one case durability exists for, and it is the
        expensive one. See `artifacts/scratch.py` for the full outcome table.
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
        on_settled=settled,
        # Enumerated OFF the event loop after registration — 4.8 s cold, and a picker's contents must not
        # delay the handshake. None on a box without the `audiosep` extra, which skips the frame entirely.
        catalogue=zoo.announcement if hardware.module_available("audio_separator") else None,
    )

    # ONE registration, before any job. `DBOS.workflow` mutates a global registry, so doing it per job would
    # re-register the same name every time — and its ABSENCE is what meant every step ran outside a workflow
    # context and checkpointed nothing at all.
    #
    # The steps are supplied as PROVIDERS rather than as workflow arguments because DBOS serialises its
    # arguments into the system database: a steps object holds loaded models, a websocket and subprocess
    # handles, so passing it raises `PicklingError`. Only `JobRef` crosses the boundary; these closures keep
    # the process-level state on this side of it.
    #: The loop the client serves on. A workflow DBOS resumes runs on DBOS's own loop (`_ReporterFor`), and
    #: these providers are called from inside the workflow, so the loop is captured HERE, not there.
    loop = asyncio.get_running_loop()

    def align_steps_for(job: JobRef) -> Any:
        from encore_worker.workflows.dbos_align import DbosAlignSteps  # noqa: PLC0415

        impl = AlignStepsImpl(config=config, adapters=adapters, reporter=_ReporterFor(client, loop))
        return DbosAlignSteps(impl, dbos)

    def stems_steps_for(job: JobRef) -> Any:
        # Built PER JOB from the job's OWN engine param, not once at startup from the box's backend. A
        # `stems-upgrade` job names `roformer`; honouring the startup backend instead would separate it with
        # demucs and publish that as the upgrade, which nothing downstream could contradict.
        #
        # `model` IS READ HERE, and its absence was a PORT REGRESSION. Core has always sent it — `worker-hub`
        # puts `settings.upgradeModel` on the assign frame — and the old worker honoured it in every engine
        # (`src/separation/{demucs,roformer,mlx}.py` all read `params.get("model")`). This worker read only
        # `engine`, so `resolve_model`/`resolve_roformer_slug` always saw None and returned their defaults:
        # an operator changing upgradeModel got no effect and no error. That is exactly the failure those
        # two functions raise `UnknownModel` to prevent, reached from the one direction they could not see.
        chosen = (
            separate.build_separator(
                backend.name,
                device=device,
                mlx_bin=config.mlx_bin,
                ffmpeg_bin=config.ffmpeg_bin,
                engine=job.param_str("engine"),
                model=job.param_str("model"),
                zoo_model_dir=config.zoo_model_dir,
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

    # The SECOND reclaim mechanism, and it is not redundant with `settled` above. Two leaks that hook cannot
    # reach: a crash leaves no code to run it, and retries EXHAUSTING is terminal while the worker cannot see
    # that it was the last attempt — there is no attempt count on the wire — so it preserves scratch it will
    # never be asked about again. Periodic, so a long-lived worker reclaims without a restart.
    sweeper = asyncio.create_task(_sweep_scratch(config))
    try:
        await client.serve_forever()
    finally:
        sweeper.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await sweeper


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


def _annotation_artifacts(found: Identified) -> dict[str, Any] | None:
    """The `annotation` artifact — how core learns a song's canonical artist and title.

    NOT the same as reporting it in `facts`. `facts` is a diagnostic record of what ran; `annotation` is what
    core APPLIES: it sets `artistCanonical`/`titleCanonical`, and those are exactly what `assignParams` sends
    to a later align job as its lookup keys. Reporting only `facts` means core never learns the names, so
    every align job arrives with nothing to look up and goes straight to ASR — which is silently why the
    provider tier never ran until a canonical artist was set by hand.

    `source: "youtube"` because core's `applyAnnotation` accepts exactly `youtube` or `musicbrainz` and
    ignores anything else. This is the YouTube FLOOR: no MBID, which core requires only for a musicbrainz
    annotation, and `medium` confidence because a title parse is a guess about a human-typed string.
    A MusicBrainz lookup would overwrite this with `high` and an MBID — see the README's parity note.

    None when the song was not identified: core requires both names, and a half-annotation would claim a
    lookup key that returns another song's words, which is worse than no key at all.
    """
    if not found.confident:
        return None
    if found.source == "musicbrainz" and found.mbid:
        # THE FULL ANNOTATION, and the reason `mbid` is required rather than optional here: core accepts
        # `source: "musicbrainz"` only with one, so sending the source without the id would be silently
        # ignored — a worse outcome than the youtube floor below, because it looks like it worked.
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
    return {
        "annotation": {
            "source": "youtube",
            "artist": found.artist or "",
            "title": found.track or "",
            # A parse of an uploader-typed title, so `medium` — never `high`, which core treats as a citation
            # that a later medium-confidence answer may not overwrite.
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
    """The `artifacts` envelope for an align completion.

    CANDIDATES ARE NOT OPTIONAL DECORATION. Core's retention sweep builds its cleanup set from
    `lyricsCandidates` (`retention.ts:182`), so any document this worker wrote and did not declare here is
    never enumerated and therefore never evicted — it leaks for the life of the library. They are also what
    lets `/api/lyrics-reselect` switch to another reading without re-fetching the audio.

    Reported even when nothing was PUBLISHED: the files exist regardless, so they must be nameable.

    EACH FIELD CORE RANKS ON SAYS WHAT ITS NAME SAYS (review M3). Core's `pickBestLyrics` ranks the WHOLE
    merged set, this report's attempts beside every earlier job's, and it read the timing grade as
    `textConfidence`, took every attempt as a peer, and broke ties on a `createdAt` all of them shared:
      * `textConfidence` is the TEXT's standing (`Tier.text_confidence`), `timingConfidence` the grade.
        A PIN's (`pinned`: the job carries `pinnedText` / `pinnedRef`) is `high` whatever its tier: a
        person chose these words, which is the old worker's reading ("`text_confidence` is `high` because
        a human chose this text; that outranks any scored guess", f04a2d0e^ `steps/lyrics/pinned.py`), and
        the orchestrator's decision after W1 (PLAN-alignment-v3, 2026-09-28 (2)). W1 had kept the stored
        text's tier here, so a re-timed machine caption or transcript went out `low`. The TIER itself is
        untouched (`steps.records.tier_of_label`): it still decides what it decides inside the job (the
        lexical gate's ASR exemption) and what an earlier job's withdrawn document of those words is
        sent as. Core then reads a re-picked machine caption as authoritative "Captions" (its TV drops
        the "not verified" mark), while a re-picked transcript stays unauthoritative: core's
        `isAuthoritativeText` never counts `asr` words as a claim, whatever their confidence.
      * `vouched` is the WORDS' OWN AXIS (`TimedDoc.vouched`, W3 review r1, moved off `textConfidence` by
        r2): `false` where a wrong-text gate measured these words and did not vouch for them — the lexical
        doubt band, a PIN whose lift the gate would have refused, or a text no such gate could read. Core
        reads it in `isAuthoritativeText`, so such a document ranks under one a gate passed, and the pin's
        `high` keeps saying what it means (a person chose these words) without also claiming the audio
        sings them. SENT ONLY WHEN FALSE, since absent is core's "vouched" — the compatible reading for
        every stored row and every earlier worker. It was `textConfidence: low` at r1, and that field
        carries a SECOND claim core reads: `lyricsSourceLabel` reports `captions` + `low` as "Auto
        captions", so a doubted hand-authored caption track was shown to the room as machine-generated —
        false about its provenance rather than about its words. The timing grade could not carry the doubt
        either: `timingConfidence` is not in core's ranking at all (only its tie-break), so a doubted word
        document tied with a vouched one at the top rank.
      * `selectable` is the ladder's verdict: `false` on every attempt this job did not publish — the
        ones it retried, moved past, or (no lyrics) all of them. Core never auto-selects one (a person
        still may), so within a report the worker's choice stands, while across jobs core's ranking
        still guards never-regress. Before, an equal-rank tie went to the FIRST listed — the attempt the
        ladder had retried — and a job that published nothing still had its rejects ranked and shown.
        Replayed over the W0 run_align baseline's ladders (`results/baseline-v2-run_align.cases.jsonl`, 768
        song-modes, one candidate per attempt as knob-bearing refs make it): core's ranking overrode the
        worker in 319. 236 of the 320 WRONG texts the worker declined would have been shown anyway (its
        rejected word doc, or the line doc of an ungated line-sync), 65 right texts it published nothing for
        showed a reject, and 18 published retries lost to the attempt they retried.
      * `createdAt` is ONE stamp per report, the moment this job's judgement was made. Recency is a
        tie-break between JOBS (a re-run at equal rank is presumed an improvement); within one report
        `selectable` decides, so no attempt is stamped as if it were newer than the job's choice.
      * `withdrawn` are EARLIER jobs' documents for words this job's gate refused
        (`align_steps.superseded_candidates`, review W1 r2): reported `selectable: false` too, since a
        refused attempt writes nothing and they would otherwise keep their rank beside this verdict. Their
        timing grade is not known here, so it is not sent (core reads it as unknown).
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
            # The WORDS' axis, only when a gate withheld them: absent is core's "vouched" (see above).
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

    `asrModel` and `syncMode` are the RESOLVED values (review H5), the ones `steps.api` resolves for the
    steps themselves: core records the request at dispatch and lets these overwrite it, so a checkpoint
    this worker would not load, or a pin aligned under `lines`, is reported as what actually ran rather
    than as what was asked. The old worker reported both on every align completion.
    """
    return {
        "backend": config.backend,
        "noLyrics": outcome.no_lyrics,
        "asrModel": asr_model_of(job, config.asr_model),
        # What RAN: `lines` on a stemless song is aligned (`workflows.align._sync_mode_note`). A record
        # checkpointed before the field existed restores it as None (`restore_appended`): the job's param.
        "syncMode": outcome.sync_mode or sync_mode_of(job).value,
    }


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
        # `uri`, NOT `ref`. Core's `JobArtifacts.lyrics` is `{ uri, candidates? }` and reads
        # `artifacts?.lyrics?.uri` — `ref` is the field on a CANDIDATE, so the old key left core with
        # an undefined uri and no lyrics on a job that had just published them.
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

    Safe on a volume shared with another worker because `sweep` only removes a directory whose NEWEST file is
    older than its threshold: a live job writes continuously, so its scratch can never look quiet. That is why
    an age check is the right test rather than a registry of "my" job ids, which would be blind to the other
    worker's orphans.

    Never lets a sweep failure stop the worker: reclaiming disk is maintenance, and a box that refused to
    process songs because a directory was busy would trade a full disk for no service at all.
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
    """Run one assigned job and build its terminal frame.

    The action-to-workflow mapping lives here and nowhere else. An unknown action fails NON-retryably:
    the core should not have routed it, and three attempts cannot teach this worker a new verb.

    WRAPPED IN A PROGRESS KEEPALIVE, and that is a correctness requirement rather than a nicety.
    `job:progress` doubles as the core's LEASE refresh (`leases.ts`: `progressLeaseMs` is 30 s), and this
    worker emitted no progress frame of any kind — `keepalive()` existed, fully written and documented, with
    no caller, and every `on_progress` was passed as None.

    MEASURED: a 195 s song fetched in 2.1 s and separated in 22.3 s, then its align job was revoked at 32.9 s
    with `progress-lease-expired` and requeued. Nothing was wrong with the job. Under 30 s of work per step
    the bug is invisible, which is why earlier end-to-end runs on short clips passed — so the failure
    arrives only with real songs, on slower boxes, in exactly the case that matters.
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
    # One task per job, cancelled in `finally` below. The stage is the coarse one the phone's bar reads; a
    # keepalive cannot know a real percentage, so it repeats the stage rather than inventing progress.
    keeper = asyncio.create_task(
        transport_client.keepalive(client, job.job_id, _STAGE_FOR.get(assign.action, Stage.SEPARATING))
    )
    try:
        return await _dispatch(assign, job, config, adapters, separator, client, dbos)
    finally:
        keeper.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await keeper


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
    """The action-to-workflow mapping. Split from `_run` so the keepalive wraps every branch including the
    unknown-action refusal — a job that fails to dispatch still holds a lease until its frame lands."""
    if assign.action == "align":
        return _align_completion(job, config, await durable.align(job))

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
                    # ALWAYS present when separation succeeded. Core's process gate reads a present profile
                    # as "the analysis step ran"; an absent one leaves core waiting forever for a step it
                    # believes already happened, so the song is unsingable AND never reprocessed.
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
        # retry is cheaper than its bookkeeping. See worker/README.md "What is deliberately absent".
        fetched = await run_fetch(
            job,
            FetchStepsImpl(
                config=config,
                audio=AlignStepsImpl(config=config, adapters=adapters, reporter=_ReporterFor(client)),
                reporter=_ReporterFor(client),
                # Built per fetch rather than once at startup: it holds no models and no socket, so there is
                # nothing to amortise, and `ENCORE_ANNOTATE=0` is then honoured without a restart.
                annotator=musicbrainz.build_client(),
            ),
        )
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

    ON THE CLIENT'S LOOP, whichever loop the step runs on. DBOS runs a workflow IT resumes — one recovered at
    launch, and the fork a requeued failure runs (`durable._run_id`, review W1 r1) — on its own background
    event loop, in another thread, while the socket, the ownership event and every future `Client` awaits
    belong to the loop `serve_forever` runs. Awaited from the other loop, a send failed (swallowed by
    `_send`, so the trail went quiet) and a stale-standing `confirm_ownership` waited on an event bound to
    the wrong loop and raised, failing the publish. So a call from another loop is handed to the client's.
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
