"""The stems action, as steps.

Was `DemucsProcessor.process()` and `RoformerProcessor.process()` — two ~100-line methods that agreed on
most of their shape and differed silently where it mattered. One plan now, with the engine differences
behind the seam in `separation/engines.py`.

THE BUG THIS FIXES BY CONSTRUCTION. Only demucs probed the vocals stem for digital silence; roformer
published whatever it produced. The probe exists because separation can SUCCEED and still write silence —
it has happened twice on the owner's library, both stems pinned at the 16-bit floor, ~50KB against 20MB —
and a silent guiding track is worse than a missing one, because the singer drags the control up and
nothing happens. As a step, both engines get it.
"""

from __future__ import annotations

import contextlib
import os
from collections.abc import AsyncIterator

from ..analysis import measure_guide_offset_ms, wav_frame_length
from ..processor import (
    ProgressEvent,
    guide_mix_path,
    instrumental_path,
    is_silent,
    parse_max_volume_db,
    vocals_path,
    volumedetect_argv,
)
from ..retry_policy import PermanentError
from ..runtime.ctx import Ctx
from ..runtime.runner import run_blocking, run_capture, run_quiet, run_stage
from ..runtime.step import Step, StepResult
from ..separation.demucs import decode_argv, encode_flac_argv, encode_guide_mix_argv
from ..separation.engines import SeparatorEngine, engine_for
from ..vocabulary import Stage


class DecodeToWav(Step):
    """Decode the retained original to the WAV a separator wants.

    TRANSIENT — it lives in scratch and dies with the job. Deliberately not stored: transcoding lossy
    YouTube audio to WAV costs roughly 12x the bytes for zero fidelity gain, since you cannot restore
    information the upload already discarded.
    """

    name = "decode-to-wav"
    stage = Stage.SEPARATING
    reads = frozenset({"audio.path", "work", "runner"})
    writes = frozenset({"audio.decoded_wav"})

    def __init__(self, engine: SeparatorEngine | None = None, ffmpeg_bin: str = "ffmpeg") -> None:
        self._engine = engine
        self._ffmpeg = ffmpeg_bin

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        engine = self._engine or _engine(ctx)
        out = engine.input_wav(ctx.work)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        if not ctx.audio.path:
            # Guaranteed non-empty by AcquireAudio, which raises if it cannot retain the original.
            # The old `or ""` would hand ffmpeg an empty input and die as the opaque
            # "ffmpeg: : No such file or directory"; name the missing key instead.
            # PermanentError (retryable=False): a step running out of order with no audio.path is a
            # deterministic plan error — every retry re-runs the same passes and fails identically, so
            # it must fail fast rather than burn three attempts (the same class as a CLI that exits 0 with no
            # output).
            raise PermanentError("decode-to-wav: audio.path is empty (AcquireAudio did not run or failed)")
        await run_quiet(ctx.runner, decode_argv(ctx.audio.path, out, self._ffmpeg))
        ctx.audio.decoded_wav = out
        return
        yield  # pragma: no cover - makes this an async generator


class Separate(Step):
    """Split the mix, and record which engine and checkpoint actually ran.

    `facts` carries the RESOLVED model, not the token the core sent. That distinction is the whole reason
    the field exists: a token was once found to resolve to a different checkpoint than the one
    benchmarked under that name, and nothing in the ledger would have shown it.
    """

    name = "separate"
    stage = Stage.SEPARATING
    reads = frozenset({"audio.decoded_wav", "work", "runner", "engines"})
    writes = frozenset({"stems.raw", "out"})

    def __init__(self, engine: SeparatorEngine | None = None) -> None:
        self._engine = engine

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        engine = self._engine or _engine(ctx)
        model = engine.resolve_model(ctx.params)
        out_dir = os.path.join(ctx.work, "separated")
        os.makedirs(out_dir, exist_ok=True)

        argv = engine.separate_argv(ctx.audio.decoded_wav or "", out_dir, model)
        # The ONE subprocess-with-progress loop, shared by every step that shells out. Its docstring
        # records that it was written to kill exactly this copy (demucs/whisperx each had one; roformer
        # borrowed it) — and the local copy this replaces had drifted back, emitting an UNCONDITIONAL
        # final pct=100 that double-fired whenever a parser already reached 100. run_stage guards it.
        async for ev in run_stage(ctx.runner, self.stage, argv, engine.parse_progress):
            yield ev

        # Some engines' CLIs do not themselves write the 2-stem {no_vocals,vocals} layout the pipeline
        # reads. The MLX engine (demucs-mlx) emits four/six stems and derives the instrumental with a
        # mix-minus ffmpeg pass declared here; demucs and roformer return no derivation. Each runs
        # quietly through the same runner, in order, before outputs are located.
        for derive_argv in engine.derive_argvs(ctx.audio.decoded_wav or "", out_dir, model):
            await run_quiet(ctx.runner, derive_argv)

        found = engine.find_outputs(out_dir, model)
        if not found.get("instrumental"):
            raise PermanentError(f"{engine.id} produced no instrumental in {out_dir}")
        ctx.stems.raw = {k: v for k, v in found.items() if v}
        ctx.out.facts.update({"engine": engine.id, "model": model, "backend": engine.backend})


class ProbeSilence(Step):
    """Measure whether either separated stem is digital silence, before paying to encode it.

    Applies to BOTH engines now. Only demucs used to check, so a roformer process could publish a silent
    guiding track — the failure the probe exists to catch.

    Probes the RAW separated WAV rather than the encoded stem, which is where demucs used to do it. Same
    answer — encoding silence yields silence, and an encode that fails raises rather than emptying a file
    — and it saves the encode entirely when the stem is silent.

    The two stems fail DIFFERENTLY, which is why one verdict is recorded and the other raises:

    * A silent VOCALS stem costs the room a guide track nobody hears at volume. Recorded, not fatal, and
      the stem is NOT deleted: the profile analysis in the next step reads the raw vocals WAV regardless,
      so a silent-vocals song still gets a present-but-empty songProfile and reads as processed rather
      than stuck.
    * A silent INSTRUMENTAL is the file that plays at volume, so publishing it means the room plays
      four minutes of nothing while every surface says Ready and the TV reports advancing telemetry.
      There is no honest way to serve that, so it fails the job like any other unusable separation
      (compare Separate.run, which raises when no instrumental is produced at all). Failing puts the
      song in the operator's ledger and leaves it re-processable — possibly on the other engine — instead
      of silently poisoning the rotation.
    """

    name = "probe-silence"
    stage = Stage.SEPARATING
    reads = frozenset({"stems.raw", "runner"})
    writes = frozenset({"stems"})

    def __init__(self, ffmpeg_bin: str = "ffmpeg") -> None:
        self._ffmpeg = ffmpeg_bin

    def applies(self, ctx: Ctx) -> bool:
        # Either stem is worth probing. Gating on vocals alone skipped the whole step for a process that
        # produced only an instrumental — the one stem whose silence is fatal.
        return bool(ctx.stems.raw.get("vocals") or ctx.stems.raw.get("instrumental"))

    async def _is_silent(self, ctx: Ctx, path: str) -> bool:
        output = await run_capture(ctx.runner, volumedetect_argv(path, self._ffmpeg))
        return is_silent(parse_max_volume_db(output))

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        instrumental = ctx.stems.raw.get("instrumental")
        if instrumental:
            # No try/except: unlike the guide, a probe that cannot answer must not be read as "fine".
            # An ffmpeg that fails here would fail the encode in PublishStems anyway.
            if await self._is_silent(ctx, instrumental):
                raise PermanentError(
                    "instrumental stem is digital silence — refusing to publish a song that would "
                    "play as four minutes of nothing"
                )

        vocals = ctx.stems.raw.get("vocals")
        if vocals:
            try:
                silent = await self._is_silent(ctx, vocals)
            except Exception:  # noqa: BLE001 — a failed probe must never cost the room a working guide
                silent = False
            ctx.stems.vocals_silent = silent
            if silent:
                ctx.note("vocals stem is digital silence — it will not be published")
        return
        yield  # pragma: no cover - makes this an async generator


class PublishStems(Step):
    """Encode and publish the stems.

    Both stems to LOSSLESS FLAC. The instrumental plays at volume as the master and a second lossy
    generation is audible on high-frequency transients — a crash cymbal especially. The vocals stem is the
    GUIDING TRACK — a second audio element the TV mixes under the instrumental and pitch-shifts with the key
    (src/lib/tv/TvPlayer.svelte) — so it plays aloud too, and it also feeds pitch extraction and
    vocal-range analysis. Encoding it through the SAME encoder as the instrumental (encode_flac_argv, one
    codec, one container) is the point: an AAC-in-m4a encoder adds priming samples (~1024, ~21 ms at 48 kHz)
    that shift the vocals START relative to the FLAC instrumental. That offset sat above guide-sync's 15 ms
    deadband, so the player converged it out with a startup rate-trim — matching codecs removes the NEED for
    that correction, since both stems now decode to a sample-exact common start.

    The vocals stem is BEST-EFFORT throughout. A missing, silent or unencodable vocals file must never
    fail the load-bearing instrumental.
    """

    name = "publish-stems"
    stage = Stage.SEPARATING
    reads = frozenset({"job", "stems.raw", "stems", "runner"})
    writes = frozenset({"stems.published", "out"})

    def __init__(
        self, ffmpeg_bin: str = "ffmpeg", flac_level: int = 8, guide_mix: bool | None = None
    ) -> None:
        self._ffmpeg = ffmpeg_bin
        self._flac_level = flac_level
        # ENCORE_GUIDE_MIX=0 turns the extra encode off. It exists because the mix roughly DOUBLES a song's
        # derived stem bytes (it is the two stems again, in one container), and a box tight on disk has no
        # other way to keep processing songs without paying that. Off means every song takes the two-element
        # guide path, which is the pre-feature behaviour — so this degrades the guide's precision, never the
        # song. Injected rather than read inline so the step stays testable without touching the environment.
        self._guide_mix_enabled = (
            os.environ.get("ENCORE_GUIDE_MIX", "1") != "0" if guide_mix is None else guide_mix
        )

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        job = ctx.job
        raw_inst = ctx.stems.raw.get("instrumental")
        if not raw_inst:
            # Guaranteed present by Separate (raises when no instrumental is produced) and by
            # ProbeSilence (raises on a silent instrumental). The old `or ""` would encode an
            # empty path into "ffmpeg: : No such file or directory"; name the missing key instead.
            # PermanentError (retryable=False): a missing instrumental key is a deterministic plan
            # error — every retry re-runs the same passes and fails identically, so it must fail fast
            # rather than burn three attempts (the same class as a CLI that exits 0 with no output).
            raise PermanentError("publish-stems: stems.raw['instrumental'] is missing (Separate did not run)")
        final = instrumental_path(job.media_dir, job.media_id)
        os.makedirs(os.path.dirname(final), exist_ok=True)
        await run_quiet(ctx.runner, encode_flac_argv(raw_inst, final, self._ffmpeg, self._flac_level))
        ctx.stems.published["instrumental"] = final

        raw_vox = ctx.stems.raw.get("vocals")
        if raw_vox and not ctx.stems.vocals_silent:
            out = vocals_path(job.media_dir, job.media_id)
            try:
                await run_quiet(ctx.runner, encode_flac_argv(raw_vox, out, self._ffmpeg, self._flac_level))
                ctx.stems.published["vocals"] = out
            except Exception:  # noqa: BLE001 — an enhancement must never fail the job
                ctx.note("vocals encode failed (non-fatal) — publishing the instrumental alone")

        # The GUIDE MIX: both stems folded into ONE 4-channel FLAC (ch 0/1 instrumental, ch 2/3 vocals).
        # This is what lets the TV play the guide from a SINGLE media element, and therefore a single
        # playhead — see `encode_guide_mix_argv` for why two elements cannot be held in sync from script
        # at all, and `guide_mix_path` for why it lives beside the stems it is built from.
        #
        # Built from the RAW scratch WAVs, not the encoded FLACs: they are the sample-exact PCM
        # separation just produced, so the mix inherits that alignment rather than trusting two decodes
        # to agree. It is skipped entirely when there is no publishable vocals stem — a "mix" of the
        # instrumental alone is just the instrumental, and offering one would advertise a guiding track
        # that carries nothing (the same lie the silent-stem refusal above exists to prevent).
        #
        # Measure the guide's OFFSET against the instrumental, from the RAW scratch WAVs — the guide-
        # alignment half of the guide feature made observable. Read the raw stems, not the encoded
        # ones: they are the same PCM measure_guide_offset_ms reads, and doing it here means no re-decode.
        # BEST-EFFORT and TRI-STATE, exactly like the vocals encode above: only measured when a vocals stem
        # was actually published (a silent/absent guide has nothing to align), never fatal, and a decline
        # reports None → the core stores null → the client holds the guide exactly as today. A
        # freshly-processed
        # song's two FLAC stems decode to a common start, so this is ~0 for the whole library; the non-zero
        # case is a legacy .m4a vocals stem (from before both stems shared one codec) or a deliberately
        # shifted one.
        #
        # MEASURED BEFORE THE MIX IS BUILT, deliberately — the mix's eligibility depends on the answer. See
        # case is a legacy pre-change .m4a vocals stem or a deliberately shifted one.
        guide_offset_ms: int | None = None
        if ctx.stems.published.get("vocals"):
            try:
                # THROUGH THE KEEPALIVE WRAPPER, not awaited inline. This is in-process numpy over a 30 s
                # window of two stems — a blocking CPU call, the same shape as KeyAndRange. Run directly on
                # the event loop it froze the loop for the duration, which is exactly the condition
                # `run_blocking` documents: no websocket keepalive and no `job:progress`, so the core's 30 s
                # progress lease could expire and the reaper requeue a job that was separating fine. Wrapping
                # it also gives this step the only progress it emits (it had none), so the lease is held
                # across the publish tail rather than merely not broken by it.
                async for kind, val in run_blocking(
                    lambda: measure_guide_offset_ms(raw_vox, raw_inst), self.stage, 100
                ):
                    if kind == "progress":
                        yield val
                    else:
                        guide_offset_ms = val
            except Exception:  # noqa: BLE001 — a measurement must never fail the load-bearing instrumental
                ctx.note("guide-offset measurement failed (non-fatal) — offset left unmeasured")
            # Log it so a wrong measurement is diagnosable WITHOUT the party box (DoD): a silent
            # correction is its own defect class, so the number is always emitted, None included.
            ctx.note(
                f"guide offset: {'unmeasured' if guide_offset_ms is None else f'{guide_offset_ms} ms'}"
                " (vocals stem vs instrumental)"
            )

        # The GUIDE MIX: both stems folded into ONE 4-channel FLAC (ch 0/1 instrumental, ch 2/3 vocals).
        # This is what lets the TV play the guide from a SINGLE media element, and therefore a single
        # playhead — see `encode_guide_mix_argv` for why two elements cannot be held in sync from script at
        # all, and `guide_mix_path` for why it lives beside the stems it is built from.
        #
        # Built from the RAW scratch WAVs, not the encoded FLACs: they are the sample-exact PCM separation
        # just produced, so the mix inherits that alignment rather than trusting two decodes to agree.
        #
        # IT IS REFUSED WHEN THE PAIR IS NOT ALIGNED, and that refusal is the point of measuring first.
        # One playhead means the alignment becomes PERMANENT: whatever offset the two stems carry at merge
        # time is frozen into the mix, and `guide-sync.ts`'s governor — the only thing that could trim it
        # out — is unreachable on the mix path by construction. So a measured non-zero offset must keep its
        # song on the two-element path, where the offset is still correctable. Absent (unmeasured) and a
        # measured 0 both mean "no reason to refuse": a pair of same-codec FLACs from one separation is
        # aligned by construction, which is what moving both stems to one lossless codec bought.
        #
        # Skipped entirely when there is no publishable vocals stem — a "mix" of the instrumental alone is
        # just the instrumental, and offering one would advertise a guiding track that carries nothing (the
        # same lie the silent-stem refusal above exists to prevent).
        #
        # BEST-EFFORT: the instrumental is load-bearing and the mix is not, so a failure here leaves a room
        # that plays the song with the two-element guide rather than a room that plays nothing.
        mix_wanted = bool(raw_vox) and bool(ctx.stems.published.get("vocals"))
        if mix_wanted and guide_offset_ms not in (None, 0):
            ctx.note(
                f"guide mix skipped — the stems measure {guide_offset_ms} ms apart, and one playhead"
                " cannot correct that; this song keeps the two-element guide"
            )
            mix_wanted = False
        if mix_wanted:
            # `join` TRUNCATES to the shorter input and exits 0, and silently resamples a rate mismatch —
            # both measured. Since channels 0/1 of this file are the instrumental the TV plays as master, a
            # short vocals stem yields a mix that ENDS EARLY, and the room hears the song cut off with
            # nothing in any log. Not reachable with today's engines (all three derive both stems from one
            # model pass over one resampled input, so they are sample-aligned by construction) — which is
            # exactly why it deserves a guard rather than a comment: nothing else would notice if that ever
            # stopped being true. An unreadable header returns None and is treated as "cannot confirm",
            # which skips the mix rather than shipping a possibly-truncated master.
            assert raw_vox is not None
            inst_len, vox_len = wav_frame_length(raw_inst), wav_frame_length(raw_vox)
            if inst_len is None or vox_len is None or inst_len != vox_len:
                ctx.note(
                    f"guide mix skipped — the stems do not match ({inst_len} vs {vox_len} frames/rate);"
                    " `join` would truncate the mix to the shorter one and the song would end early"
                )
                mix_wanted = False
        if mix_wanted and not self._guide_mix_enabled:
            ctx.note("guide mix disabled (ENCORE_GUIDE_MIX=0) — this song keeps the two-element guide")
            mix_wanted = False
        if mix_wanted:
            mix = guide_mix_path(job.media_dir, job.media_id)
            # ENCODE TO A TEMP SIBLING AND RENAME. ffmpeg writes its output incrementally, and a SIGTERM
            # (which is how a timeout kills it) makes it FINALISE what it has — so a killed or ENOSPC'd
            # encode leaves a *valid but short* FLAC. Written straight to the published path, that file is
            # indistinguishable from a good one, and because the mix is what the TV plays as MASTER it owns
            # `duration`, so the room hears the song cut off early with nothing in any log. A rename is
            # atomic within a directory, so the published path only ever holds a complete file. Same idiom
            # the core's sidecar writer uses, for the reason it records: "a crash, kill, or ENOSPC mid-write
            # leaves partial" output.
            tmp = f"{mix}.{os.getpid()}.tmp"
            try:
                assert raw_vox is not None  # narrowed by mix_wanted; keeps mypy honest about the argv
                await run_quiet(
                    ctx.runner,
                    encode_guide_mix_argv(raw_inst, raw_vox, tmp, self._ffmpeg, self._flac_level),
                )
                os.replace(tmp, mix)
                ctx.stems.published["guideMix"] = mix
            except Exception as err:  # noqa: BLE001 — an enhancement must never fail the job
                # NAME THE REASON. This note used to carry none, and that is why a guide mix which
                # failed on EVERY song — for one fixable reason, an output name ffmpeg could not
                # mux — read in the log as an unremarkable fallback line and stayed unfixed while
                # every room heard a drifting two-element guide. Non-fatal is a statement about the
                # JOB, not a licence to discard the cause: the guide is the part of the pipeline the
                # room actually notices, so the reason belongs beside the fallback it explains.
                ctx.note(
                    f"guide-mix encode failed (non-fatal: {type(err).__name__}: {err})"
                    " — the TV will fall back to two elements"
                )
            finally:
                # Never leave the temp behind: it is in `derived/`, so an orphan would be counted by the
                # retention cap forever while naming no artifact any media owns.
                if os.path.exists(tmp):
                    with contextlib.suppress(OSError):
                        os.remove(tmp)

        # songProfile sits at the TOP level, a SIBLING of stems. The core reads it there; publishing it
        # nested inside `stems` is a shape mismatch that would stall every process at "Separating vocals"
        # forever, because the process gate requires the profile to be present and the re-process check reads
        # hasInstrumental rather than the gate. Pinned from the other side of the wire by
        # src/server/jobs/vocabulary-parity.test.ts.
        ctx.out.artifacts["stems"] = dict(ctx.stems.published)
        ctx.out.artifacts["songProfile"] = ctx.stems.song_profile
        # guideOffsetMs rides beside them, top-level like songProfile — a measurement, not a file. Emitted
        # only when there is a value: an absent field on the wire is the same "not measured" the core reads
        # as null, so a decline does not need to send an explicit None.
        if guide_offset_ms is not None:
            ctx.out.artifacts["guideOffsetMs"] = guide_offset_ms
        ctx.out.media_uri = final
        return
        yield  # pragma: no cover - makes this an async generator


def _engine(ctx: Ctx) -> SeparatorEngine:
    return engine_for(ctx.engines.separator, device=ctx.engines.device)
