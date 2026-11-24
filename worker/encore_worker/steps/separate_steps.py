"""The real `SeparateSteps`, and the fetch flow's steps. Thin shells, same as `align_steps`.

Shares `acquire_audio` with the align implementation by DELEGATION rather than inheritance: a stems job
and an align job acquire audio identically, and a subclass would make that identity a structural claim
that a later divergence would silently break.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping

from encore_worker.adapters import cli
from encore_worker.adapters import separate as sep
from encore_worker.adapters.encode import EncodeFailed, FfmpegEncoder
from encore_worker.adapters.ports import AudioProbe, Separator
from encore_worker.artifacts import keys
from encore_worker.artifacts.ports import ArtifactStore
from encore_worker.domain.audio import profile as audio_profile
from encore_worker.domain.identity import Identified, identify_from_title
from encore_worker.host.config import Config
from encore_worker.protocol.vocabulary import Stage
from encore_worker.steps.align_steps import AlignStepsImpl, Reporter, progress_sink
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
        # Required, not optional: `host.capabilities` already refuses to advertise `stems` without ffmpeg.
        self._encoder = encoder or FfmpegEncoder(config.ffmpeg_bin, config.flac_level)
        # The LIVE value the transport learned from `worker:welcome`; config is only the fallback, because
        # core owns the storage layout (`Config.publish_stem_format`).
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
        # The subprocess engines forward what their own bar prints (WK-07). The in-process zoo gets no sink:
        # its heartbeat is a CLOCK, not a measurement (`audiosep._heartbeat`); the phone shows the ETA alone.
        sink = None
        if not str(getattr(self._sep, "name", "")).startswith("audiosep:"):
            sink = progress_sink(self._out, job.job_id, Stage.SEPARATING)
        # `in_job` counts the call on the job's token IN its thread, so a stop holds the slot until the
        # separation returns even when it is in-process (the zoo) and there is no child to kill (WK-02).
        stems = await asyncio.to_thread(
            cli.in_job, self._sep.separate, input_wav, self._work(job), on_progress=sink
        )
        return AudioRef(
            path=stems.instrumental_path,
            duration_sec=0.0,  # measured after publication; the separator does not report it
            vocals_path=stems.vocals_path,
        )

    async def probe_silence(self, job: JobRef, audio: AudioRef) -> float | None:
        """Peak dBFS of the instrumental, or None when it could not be measured.

        None reaches the workflow, which REFUSES: "unmeasured" and "definitely fine" must not be one value
        (docs/arch/05-worker.md §2.4).
        """
        if self._probe is None:
            return None
        return await asyncio.to_thread(self._probe.peak_dbfs, audio.path)

    async def measure_profile(self, job: JobRef, audio: AudioRef) -> Mapping[str, object]:
        """The `songProfile` artifact: key from the instrumental, vocal range from the vocals.

        ALWAYS returns the full wire shape and NEVER raises (docs/arch/05-worker.md §3). Measured on the
        SCRATCH stems, so it must run before publication re-encodes them.
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

        ORDER MATTERS: ownership FIRST, then encode into scratch, then place, so a failure halfway leaves the
        store untouched. The guide mix is built from the ENCODED stems, so what the TV splits is byte-wise
        what it would get from the two files (docs/arch/05-worker.md §4).
        """
        if not await self._out.confirm_ownership(job.job_id):
            raise NotOurJob(self._out.explain_ownership(job.job_id))

        work = self._work(job)
        ext = self._publish_ext
        # The two encodes are independent, so they run AT ONCE: each is one single-threaded ffmpeg, and this
        # publish took 1.7 s instead of 4.1 s on a 240 s song (32-core aarch64 CPU).
        encodes = [
            asyncio.to_thread(
                self._encoder.stem, audio.path, os.path.join(work, f"publish-instrumental.{ext}")
            )
        ]
        if audio.vocals_path:
            encodes.append(
                asyncio.to_thread(
                    self._encoder.stem, audio.vocals_path, os.path.join(work, f"publish-vocals.{ext}")
                )
            )
        staged = await asyncio.gather(*encodes)
        staged_instrumental = staged[0]
        staged_vocals = staged[1] if len(staged) > 1 else None

        # Built before anything is placed, and best-effort: refusing the whole publication over an optional
        # artifact would throw away a completed separation (`PublishedStems.guide_mix`).
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
                # On the same decision trail align uses, so "why is there no guide mix" is answerable from
                # the job row rather than only from a process log.
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

        return PublishedStems(
            instrumental=instrumental_ref,
            vocals=vocals_ref,
            guide_mix=guide_ref,
            engine=getattr(self._sep, "name", None),
            model=getattr(self._sep, "model", None),
        )

    def _work(self, job: JobRef) -> str:
        path = os.path.join(job.media_dir, "work", job.job_id)
        os.makedirs(path, exist_ok=True)
        return path


class _Permanent(RuntimeError):
    """A capability this box does not have. No retry can supply it."""

    retryable = False


class FetchStepsImpl:
    """`FetchSteps`, for real. The shortest implementation, and the only one producing METADATA.

    How the song was named is recorded in `Identified.source`, so a later wrong-lyrics report is traceable to
    it. See docs/arch/05-worker.md §6.
    """

    def __init__(
        self,
        *,
        config: Config,
        audio: AlignStepsImpl,
        reporter: Reporter,
        store: ArtifactStore,
        annotator: object | None = None,
    ) -> None:
        self._cfg = config
        self._audio = audio
        self._out = reporter
        self._store = store
        #: A MusicBrainz client, or None when annotation is off or the box has no network. None degrades to
        #: the title parse, which is the behaviour before this existed.
        self._annotator = annotator

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        # The one job whose bar IS the download, and the song's only download: the captions come in the same
        # call and are kept for align.
        return await self._audio.acquire_audio(job, report_download=True, with_captions=True)

    async def annotate(self, job: JobRef, audio: AudioRef) -> Identified:
        """Identify the song. Never raises — not knowing is a real answer, not a failure.

        These become a later align job's LYRICS LOOKUP KEYS, so a title parse standing alone is a provider
        miss. MusicBrainz REFINES the parse rather than replacing it (docs/arch/05-worker.md §6).
        """
        artist, track = job.param_str("artist"), job.param_str("track")
        if artist and track:
            # Core already has names, but they are ITS OWN TITLE PARSE and not a citation, so they are
            # refined like any other guess. Returning them as final made the MusicBrainz lookup unreachable,
            # core sending them on every job.
            supplied = Identified(artist=artist, track=track, source="job-params")
            return await self._refine(job, supplied, audio)
        title = job.param_str("title")
        if not title:
            return Identified(source="none")
        return await self._refine(job, identify_from_title(title), audio)

    async def _refine(self, job: JobRef, parsed: Identified, audio: AudioRef) -> Identified:
        """Upgrade a title parse to a MusicBrainz match, or return the parse untouched.

        `to_thread` because the lookup is a blocking HTTP call behind a one-request-per-second gate, and
        awaiting it inline would stop the progress keepalive and let the lease expire on a healthy job.
        """
        if self._annotator is None or not parsed.confident:
            return parsed
        from encore_worker.adapters.musicbrainz import annotate_or_reason  # noqa: PLC0415

        found, why = await asyncio.to_thread(
            annotate_or_reason, self._annotator, parsed.artist, parsed.track, audio.duration_sec
        )
        if found is None:
            # On the trail rather than swallowed: a throttled box and a per-song miss look identical from
            # the outside, and only one is worth an operator's attention.
            await self._out.state(job.job_id, "annotate", 1, "declined", why or "no match", None)
            return parsed
        return Identified(
            artist=found.artist,
            track=found.title,
            source="musicbrainz",
            mbid=found.mbid,
            confidence=found.confidence,
        )

    async def publish_original(self, job: JobRef, audio: AudioRef, found: Identified) -> str:
        """Keep the download at `audio/<id>.<ext>` and its caption tracks in the store, captions first, so
        later stages read them instead of downloading again. Guarded, like every other publish."""
        if not await self._out.confirm_ownership(job.job_id):
            raise NotOurJob(self._out.explain_ownership(job.job_id))
        ext = os.path.splitext(audio.path)[1].lstrip(".").lower()
        if ext not in keys.KNOWN_AUDIO_EXTS:
            # Core's delete names the known exts only, so this stays in scratch and later stages download.
            return os.path.relpath(audio.path, job.media_dir)
        # shortcut: a re-fetch that finds fewer tracks or another ext leaves the earlier files (the store has
        # no delete); fine while a re-fetch is of the same video, revisit if one can change source.
        for kind, path in cli.fetched_captions(os.path.dirname(audio.path)).items():
            track_ext = os.path.splitext(path)[1].lstrip(".")
            kept = "captions" if kind == "authored" else "auto-captions"
            await self._store.put(keys.raw_caption_key(job.media_id, kept, track_ext), path)
        ref = keys.audio_key(job.media_id, ext)
        await self._store.put(ref, audio.path)
        return ref

    async def note(
        self, job: JobRef, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        await self._audio.note(job, state, attempt, verdict, why, knob)
