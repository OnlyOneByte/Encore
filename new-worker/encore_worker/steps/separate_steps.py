"""The real `SeparateSteps`, and the fetch flow's steps. Thin shells, same as `align_steps`.

Shares `acquire_audio` with the align implementation by DELEGATION rather than inheritance: a stems job
and an align job acquire audio identically, and a subclass would make that identity a structural claim
that a later divergence would silently break.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping

from encore_worker.adapters import separate as sep
from encore_worker.adapters.encode import EncodeFailed, FfmpegEncoder
from encore_worker.adapters.ports import AudioProbe, Separator
from encore_worker.artifacts import keys
from encore_worker.artifacts.ports import ArtifactStore
from encore_worker.domain.audio import profile as audio_profile
from encore_worker.domain.identity import Identified, identify_from_title
from encore_worker.host.config import Config
from encore_worker.steps.align_steps import AlignStepsImpl, Reporter
from encore_worker.steps.api import NotOurJob
from encore_worker.steps.records import AudioRef, JobRef, PublishedStems


class SeparateStepsImpl:
    """`SeparateSteps`, for real."""

    def __init__(
        self,
        *,
        config: Config,
        audio: AlignStepsImpl,
        reporter: Reporter,
        store: ArtifactStore,
        separator: Separator | None = None,
        probe: AudioProbe | None = None,
        encoder: FfmpegEncoder | None = None,
        publish_stem_format: str | None = None,
    ) -> None:
        self._cfg = config
        self._audio = audio
        self._out = reporter
        self._sep = separator
        self._probe = probe
        self._store = store
        # Required, not optional: a box without ffmpeg cannot publish, and `host.capabilities` already
        # refuses to advertise `stems` without it — so defaulting one here is safe rather than hopeful.
        self._encoder = encoder or FfmpegEncoder(config.ffmpeg_bin, config.flac_level)
        # The LIVE value, which the transport learned from `worker:welcome`. Falls back to config only when
        # the caller has nothing better — core owns this decision, so its announcement must win over a local
        # setting rather than the other way round.
        self._publish_ext = publish_stem_format or config.publish_stem_format

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        """Identical to align's, by delegation. See the module docstring for why not inheritance."""
        return await self._audio.acquire_audio(job)

    async def decode_to_wav(self, job: JobRef, audio: AudioRef) -> str:
        """Normalise to the one format both separators expect.

        Done here rather than inside each engine so a variable-bitrate mp3 or an opus stream cannot
        produce a subtly different stem layout depending on which engine ran.
        """
        out = os.path.join(self._work(job), "input.wav")
        await asyncio.to_thread(sep.run, sep.decode_argv(audio.path, out, self._cfg.ffmpeg_bin))
        return out

    async def separate(self, job: JobRef, input_wav: str) -> AudioRef:
        """Run the engine. The long one — tens of minutes on a real song.

        `to_thread` because `run` is a blocking subprocess drain: awaiting it inline would freeze the
        event loop, stop the socket keepalive, and let the core's lease expire on a healthy job.
        """
        if self._sep is None:
            raise _Permanent("this worker has no separator engine, so it cannot serve a stems job")
        stems = await asyncio.to_thread(self._sep.separate, input_wav, self._work(job), on_progress=None)
        return AudioRef(
            path=stems.instrumental_path,
            duration_sec=0.0,  # measured after publication; the separator does not report it
            vocals_path=stems.vocals_path,
        )

    async def probe_silence(self, job: JobRef, audio: AudioRef) -> float | None:
        """Peak dBFS of the instrumental, or None when it could not be measured.

        The earlier version returned 0.0 here — the loudest possible reading — so a box that could not
        measure published unverified. That made "unmeasured" and "definitely fine" the same value, which
        is the failure this whole guard exists to prevent.

        None now reaches the workflow, which refuses. That is safe to do because `host.capabilities` no
        longer advertises `stems` without ffmpeg, so a box running this HAS a probe — meaning None is
        ffmpeg failing on THIS file, which is a real fault rather than a missing capability.
        """
        if self._probe is None:
            return None
        return await asyncio.to_thread(self._probe.peak_dbfs, audio.path)

    async def measure_profile(self, job: JobRef, audio: AudioRef) -> Mapping[str, object]:
        """The `songProfile` artifact: key from the instrumental, vocal range from the vocals.

        ALWAYS returns the full wire shape and NEVER raises — `build_song_profile` catches per-half and
        degrades to nulls. That total is the contract, not defensiveness: core's process gate reads a present
        profile as "the analysis ran", so a raise that lost the artifact would leave core waiting forever for
        a step it thinks already happened, and the song permanently unsingable AND never reprocessed.

        `to_thread` because the analysis is numpy over a multi-minute decode — tens of seconds of CPU that
        would otherwise freeze the event loop and stop the socket keepalive.

        Measured on the SCRATCH stems, which is why it must run before publication moves and re-encodes them.
        """
        return await asyncio.to_thread(
            audio_profile.build_song_profile,
            audio.path,
            audio.vocals_path,
            job.media_id,
            log=lambda *a, **k: None,  # the decision trail is the operator surface, not stdout
        )

    async def publish_stems(self, job: JobRef, audio: AudioRef) -> PublishedStems:
        """Encode the scratch stems to the published format and place them at core's keys.

        THIS USED TO BE `os.path.relpath(audio.path, job.media_dir)` — a ref shaped correctly and pointing
        at the separator's raw output inside `work/{job_id}/`. Core recorded it, so the row looked healthy,
        while the file sat in job scratch that retention evicts and carried the wrong extension for the
        player. Nothing failed; the song just stopped working later.

        ORDER MATTERS. Ownership is re-asserted FIRST, before any bytes become visible: separation takes
        tens of minutes, so a lease that was valid at the start routinely is not here. Then the stems are
        encoded into scratch, and only then placed — so a failure halfway leaves the store untouched rather
        than half-updated.

        The guide mix is built from the ENCODED stems, not the raw ones, so what the TV splits is byte-wise
        the same audio it would get from the two separate files.
        """
        if not await self._out.confirm_ownership(job.job_id):
            raise NotOurJob(self._out.explain_ownership(job.job_id))

        work = self._work(job)
        ext = self._publish_ext
        staged_instrumental = await asyncio.to_thread(
            self._encoder.stem, audio.path, os.path.join(work, f"publish-instrumental.{ext}")
        )
        staged_vocals = (
            await asyncio.to_thread(
                self._encoder.stem, audio.vocals_path, os.path.join(work, f"publish-vocals.{ext}")
            )
            if audio.vocals_path
            else None
        )

        # Built before anything is placed, and best-effort: a box that cannot produce the 4-channel join
        # still has two usable stems, and the TV falls back to the two-element guide. Refusing the whole
        # publication over the optional artifact would throw away a completed separation.
        staged_guide: str | None = None
        if staged_vocals is not None:
            try:
                staged_guide = await asyncio.to_thread(
                    self._encoder.guide_mix,
                    staged_instrumental,
                    staged_vocals,
                    os.path.join(work, f"publish-guidemix.{ext}"),
                )
            except EncodeFailed as exc:
                # Fire-and-forget through the same decision trail align uses, so "why is there no guide
                # mix" is answerable from the job row rather than only from a process log.
                await self._out.state(
                    job.job_id,
                    "publish",
                    1,
                    "degraded",
                    f"guide mix unavailable, publishing stems only: {exc}",
                    None,
                )

        instrumental_ref = keys.instrumental_key(job.media_id, ext)
        await self._store.put(instrumental_ref, staged_instrumental)

        vocals_ref: str | None = None
        if staged_vocals is not None:
            vocals_ref = keys.vocals_key(job.media_id, ext)
            await self._store.put(vocals_ref, staged_vocals)

        guide_ref: str | None = None
        if staged_guide is not None:
            guide_ref = keys.guide_mix_key(job.media_id, ext)
            await self._store.put(guide_ref, staged_guide)

        return PublishedStems(instrumental=instrumental_ref, vocals=vocals_ref, guide_mix=guide_ref)

    def _work(self, job: JobRef) -> str:
        path = os.path.join(job.media_dir, "work", job.job_id)
        os.makedirs(path, exist_ok=True)
        return path


class _Permanent(RuntimeError):
    """A capability this box does not have. No retry can supply it."""

    retryable = False


class FetchStepsImpl:
    """`FetchSteps`, for real. The shortest implementation, and the only one producing METADATA.

    `annotate` reads the file's own tags first and falls back to parsing the upload title, because a tag
    written by whoever encoded the file is evidence where a title is a guess. Both are recorded in
    `Identified.source`, so a later wrong-lyrics report is traceable to how the song was named.
    """

    def __init__(self, *, config: Config, audio: AlignStepsImpl, reporter: Reporter) -> None:
        self._cfg = config
        self._audio = audio
        self._out = reporter

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        return await self._audio.acquire_audio(job)

    async def annotate(self, job: JobRef, audio: AudioRef) -> Identified:
        """Identify the song. Never raises — not knowing is a real answer, not a failure."""
        artist, track = job.param_str("artist"), job.param_str("track")
        if artist and track:
            # The core already knows: an operator typed it, or a previous fetch recorded it.
            return Identified(artist=artist, track=track, source="job-params")
        title = job.param_str("title")
        if title:
            return identify_from_title(title)
        return Identified(source="none")

    async def publish_original(self, job: JobRef, audio: AudioRef, found: Identified) -> str:
        """Guarded, like every other publish."""
        if not await self._out.confirm_ownership(job.job_id):
            raise NotOurJob(self._out.explain_ownership(job.job_id))
        return os.path.relpath(audio.path, job.media_dir)

    async def note(
        self, job: JobRef, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        await self._audio.note(job, state, attempt, verdict, why, knob)
