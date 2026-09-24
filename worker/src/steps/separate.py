"""The stems action, as steps. Engine differences live behind the seam in `separation/engines.py`.

Separation can SUCCEED and still write digital silence (both stems pinned at the 16-bit floor,
~50KB against 20MB, has happened on real audio) — a silent guiding track is worse than a missing
one, since the singer drags the control up and nothing happens. Every engine gets probed for it.
"""

from __future__ import annotations

import contextlib
import os
from collections.abc import AsyncIterator

from ..analysis import wav_frame_length
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
from ..runtime.runner import run_capture, run_quiet, run_stage
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
            # Guaranteed non-empty by AcquireAudio, so name the missing key rather than hand ffmpeg an
            # empty input. PermanentError: a step out of order fails identically on every retry.
            raise PermanentError("decode-to-wav: audio.path is empty (AcquireAudio did not run or failed)")
        await run_quiet(ctx.runner, decode_argv(ctx.audio.path, out, self._ffmpeg))
        ctx.audio.decoded_wav = out
        return
        yield  # pragma: no cover - makes this an async generator


class Separate(Step):
    """Split the mix, and record which engine and checkpoint actually ran.

    `facts` carries the RESOLVED model, not the token the core sent, so a token that resolves to a
    different checkpoint than the one benchmarked under that name is visible in the ledger.
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
        # The ONE subprocess-with-progress loop, so no per-engine copy can double-fire pct=100.
        async for ev in run_stage(ctx.runner, self.stage, argv, engine.parse_progress):
            yield ev

        # Not every CLI writes the 2-stem {no_vocals,vocals} layout the pipeline reads: MLX emits
        # four or six and derives the instrumental with a mix-minus pass declared here.
        for derive_argv in engine.derive_argvs(ctx.audio.decoded_wav or "", out_dir, model):
            await run_quiet(ctx.runner, derive_argv)

        found = engine.find_outputs(out_dir, model)
        if not found.get("instrumental"):
            raise PermanentError(f"{engine.id} produced no instrumental in {out_dir}")
        ctx.stems.raw = {k: v for k, v in found.items() if v}
        ctx.out.facts.update({"engine": engine.id, "model": model, "backend": engine.backend})


class ProbeSilence(Step):
    """Measure whether either separated stem is digital silence, before paying to encode it.

    Probes the RAW separated WAV rather than the encoded stem — same answer (encoding silence yields
    silence) and it saves the encode entirely when the stem is silent.

    The two stems fail DIFFERENTLY:

    * A silent VOCALS stem costs the room a guide track nobody hears at volume. Recorded, not fatal,
      and the stem is NOT deleted: the next step's profile analysis still reads the raw vocals WAV, so
      a silent-vocals song gets a present-but-empty songProfile and reads as processed, not stuck.
    * A silent INSTRUMENTAL is the file that plays at volume, so publishing it means the room plays
      nothing while every surface says Ready. It fails the job like any other unusable separation,
      putting the song in the operator's ledger and leaving it re-processable rather than silently
      poisoning the rotation.
    """

    name = "probe-silence"
    stage = Stage.SEPARATING
    reads = frozenset({"stems.raw", "runner"})
    writes = frozenset({"stems"})

    def __init__(self, ffmpeg_bin: str = "ffmpeg") -> None:
        self._ffmpeg = ffmpeg_bin

    def applies(self, ctx: Ctx) -> bool:
        # EITHER stem: gating on vocals alone skips a process that produced only an instrumental, the
        # one stem whose silence is fatal.
        return bool(ctx.stems.raw.get("vocals") or ctx.stems.raw.get("instrumental"))

    async def _is_silent(self, ctx: Ctx, path: str) -> bool:
        output = await run_capture(ctx.runner, volumedetect_argv(path, self._ffmpeg))
        return is_silent(parse_max_volume_db(output))

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        instrumental = ctx.stems.raw.get("instrumental")
        if instrumental:
            # No try/except: a probe that cannot answer must not be read as "fine".
            if await self._is_silent(ctx, instrumental):
                raise PermanentError(
                    "instrumental stem is digital silence — refusing to publish a song that would "
                    "play as four minutes of nothing"
                )

        vocals = ctx.stems.raw.get("vocals")
        if vocals:
            try:
                silent = await self._is_silent(ctx, vocals)
            except Exception as err:  # noqa: BLE001 — a failed probe must never cost the room a guide
                # Unmeasurable, NOT measured-healthy — so it is noted rather than swallowed.
                silent = False
                ctx.note(
                    f"vocals silence probe failed ({type(err).__name__}: {err})"
                    " — the guide stem is being published UNCHECKED"
                )
            ctx.stems.vocals_silent = silent
            if silent:
                ctx.note("vocals stem is digital silence — it will not be published")
        return
        yield  # pragma: no cover - makes this an async generator


class PublishStems(Step):
    """Encode and publish the stems.

    Both stems to LOSSLESS FLAC, same encoder, same container: a lossy AAC-in-m4a encoder adds
    priming samples (~1024, ~21ms at 48kHz) that shift the vocals guide track's start relative to the
    instrumental — enough to require a startup rate-trim to converge. Matching codecs makes both
    stems decode to a sample-exact common start instead.

    The vocals stem is BEST-EFFORT throughout: a missing, silent or unencodable vocals file must
    never fail the load-bearing instrumental.
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
        # ENCORE_GUIDE_MIX=0 turns the extra encode off for a box tight on disk: the mix roughly DOUBLES
        # a song's derived stem bytes. Off means NO GUIDING TRACK at all — there is no lower-precision
        # fallback — though the instrumental is untouched. Injected, so the step tests without the env.
        self._guide_mix_enabled = (
            os.environ.get("ENCORE_GUIDE_MIX", "1") != "0" if guide_mix is None else guide_mix
        )

    async def _publish_guide_mix(self, ctx: Ctx, raw_inst: str, raw_vox: str) -> None:
        """Fold both stems into ONE 4-channel FLAC (ch 0/1 instrumental, ch 2/3 vocals), so the TV plays
        the guide from a SINGLE element with one playhead.

        Built from the RAW scratch WAVs, not the encoded FLACs, so it inherits their sample-exact PCM
        alignment rather than trusting two decodes to agree; no alignment measurement is needed, since both
        stems come from ONE pass over ONE decoded input. BEST-EFFORT throughout: every way out of here
        leaves a room playing the song without a guide rather than a room playing nothing.

        The two declines are ORDERED — a length mismatch is reported even on a box that has the mix turned
        off, because it is a fact about the STEMS an operator wants to see either way.
        """
        # LENGTH is a different question from alignment: `join` TRUNCATES to the shorter input and
        # exits 0, and since ch 0/1 are the master the TV plays, a short vocals stem ends the song
        # early with nothing in any log. Unreachable with today's engines, but guarded rather than
        # assumed; an unreadable header reads as "cannot confirm" and skips the mix.
        inst_len, vox_len = wav_frame_length(raw_inst), wav_frame_length(raw_vox)
        if inst_len is None or vox_len is None or inst_len != vox_len:
            ctx.note(
                f"guide mix skipped — the stems do not match ({inst_len} vs {vox_len} frames/rate);"
                " `join` would truncate the mix to the shorter one and the song would end early"
            )
            return
        if not self._guide_mix_enabled:
            ctx.note("guide mix disabled (ENCORE_GUIDE_MIX=0) — this song will offer no guiding track")
            return

        mix = guide_mix_path(ctx.job.media_dir, ctx.job.media_id)
        # Temp sibling then rename, which is atomic within a directory: a SIGTERM makes ffmpeg
        # FINALISE what it has, so a killed encode leaves a valid but SHORT FLAC that is
        # indistinguishable from a good one — and the mix owns `duration` as the TV's master.
        tmp = f"{mix}.{os.getpid()}.tmp"
        try:
            await run_quiet(
                ctx.runner,
                encode_guide_mix_argv(raw_inst, raw_vox, tmp, self._ffmpeg, self._flac_level),
            )
            os.replace(tmp, mix)
            ctx.stems.published["guideMix"] = mix
        except Exception as err:  # noqa: BLE001 — an enhancement must never fail the job
            # Non-fatal is a statement about the JOB, not a licence to discard the cause.
            ctx.note(
                f"guide-mix encode failed (non-fatal: {type(err).__name__}: {err})"
                " — this song will offer no guiding track"
            )
        finally:
            # The temp is in `derived/`, so an orphan counts against the retention cap forever
            # while naming no artifact any media owns.
            if os.path.exists(tmp):
                with contextlib.suppress(OSError):
                    os.remove(tmp)

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        job = ctx.job
        raw_inst = ctx.stems.raw.get("instrumental")
        if not raw_inst:
            # Guaranteed present by Separate and ProbeSilence, so name the missing key rather than
            # encode an empty path. PermanentError: it would fail identically on every retry.
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
            except Exception as err:  # noqa: BLE001 — an enhancement must never fail the job
                # The cause is carried, for the reason _publish_guide_mix states below.
                ctx.note(
                    f"vocals encode failed (non-fatal: {type(err).__name__}: {err})"
                    " — publishing the instrumental alone"
                )

        # Only ever attempted once the vocals stem actually PUBLISHED, which is what makes `raw_vox`
        # non-optional below rather than re-narrowed at each use.
        if raw_vox and ctx.stems.published.get("vocals"):
            await self._publish_guide_mix(ctx, raw_inst, raw_vox)

        # songProfile is a TOP-level SIBLING of stems, never nested: the process gate requires it there
        # and would otherwise stall every process at "Separating vocals" forever.
        ctx.out.artifacts["stems"] = dict(ctx.stems.published)
        ctx.out.artifacts["songProfile"] = ctx.stems.song_profile
        ctx.out.media_uri = final
        return
        yield  # pragma: no cover - makes this an async generator


def _engine(ctx: Ctx) -> SeparatorEngine:
    return engine_for(ctx.engines.separator, device=ctx.engines.device)
