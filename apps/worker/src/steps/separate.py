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

import os
from collections.abc import AsyncIterator

from ..processor import (
    ProgressEvent,
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
from ..separation.demucs import decode_argv, encode_flac_argv
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
            # it must fail fast rather than burn three attempts (#583, same class as #571).
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

        found = engine.find_outputs(out_dir, model)
        if not found.get("instrumental"):
            raise PermanentError(f"{engine.id} produced no instrumental in {out_dir}")
        ctx.stems.raw = {k: v for k, v in found.items() if v}
        ctx.out.facts.update({"engine": engine.id, "model": model, "backend": engine.backend})


class ProbeSilence(Step):
    """Measure whether either separated stem is digital silence, before paying to encode it.

    Applies to BOTH engines now. Only demucs used to check, so a roformer cook could publish a silent
    guiding track — the failure the probe exists to catch.

    Probes the RAW separated WAV rather than the encoded stem, which is where demucs used to do it. Same
    answer — encoding silence yields silence, and an encode that fails raises rather than emptying a file
    — and it saves the encode entirely when the stem is silent.

    The two stems fail DIFFERENTLY, which is why one verdict is recorded and the other raises:

    * A silent VOCALS stem costs the room a guide track nobody hears at volume. Recorded, not fatal, and
      the stem is NOT deleted: the profile analysis in the next step reads the raw vocals WAV regardless,
      so a silent-vocals song still gets a present-but-empty songProfile and reads as cooked rather
      than stuck.
    * A silent INSTRUMENTAL is the file that plays at volume, so publishing it means the room plays
      four minutes of nothing while every surface says Ready and the TV reports advancing telemetry.
      There is no honest way to serve that, so it fails the job like any other unusable separation
      (compare Separate.run, which raises when no instrumental is produced at all). Failing puts the
      song in the operator's ledger and leaves it re-cookable — possibly on the other engine — instead
      of silently poisoning the rotation.
    """

    name = "probe-silence"
    stage = Stage.SEPARATING
    reads = frozenset({"stems.raw", "runner"})
    writes = frozenset({"stems"})

    def __init__(self, ffmpeg_bin: str = "ffmpeg") -> None:
        self._ffmpeg = ffmpeg_bin

    def applies(self, ctx: Ctx) -> bool:
        # Either stem is worth probing. Gating on vocals alone skipped the whole step for a cook that
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

    Both stems to LOSSLESS FLAC (#480). The instrumental plays at volume as the master and a second lossy
    generation is audible on high-frequency transients — a crash cymbal especially. The vocals stem is the
    GUIDING TRACK — a second audio element the TV mixes under the instrumental and pitch-shifts with the key
    (apps/core/src/lib/tv/TvPlayer.svelte) — so it plays aloud too, and it also feeds pitch extraction and
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

    def __init__(self, ffmpeg_bin: str = "ffmpeg", flac_level: int = 8) -> None:
        self._ffmpeg = ffmpeg_bin
        self._flac_level = flac_level

    async def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]:
        job = ctx.job
        raw_inst = ctx.stems.raw.get("instrumental")
        if not raw_inst:
            # Guaranteed present by Separate (raises when no instrumental is produced) and by
            # ProbeSilence (raises on a silent instrumental). The old `or ""` would encode an
            # empty path into "ffmpeg: : No such file or directory"; name the missing key instead.
            # PermanentError (retryable=False): a missing instrumental key is a deterministic plan
            # error — every retry re-runs the same passes and fails identically, so it must fail fast
            # rather than burn three attempts (#583, same class as #571).
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

        # songProfile sits at the TOP level, a SIBLING of stems. The core reads it there; publishing it
        # nested inside `stems` is a shape mismatch that would stall every cook at "Separating vocals"
        # forever, because the cook gate requires the profile to be present and the re-cook check reads
        # hasInstrumental rather than the gate. Pinned from the other side of the wire by
        # apps/core/src/server/jobs/vocabulary-parity.test.ts.
        ctx.out.artifacts["stems"] = dict(ctx.stems.published)
        ctx.out.artifacts["songProfile"] = ctx.stems.song_profile
        ctx.out.media_uri = final
        return
        yield  # pragma: no cover - makes this an async generator


def _engine(ctx: Ctx) -> SeparatorEngine:
    return engine_for(ctx.engines.separator, device=ctx.engines.device)
