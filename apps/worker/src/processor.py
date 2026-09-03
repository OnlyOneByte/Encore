"""Job processor seam — the pluggable unit that turns a source into stems/lyrics.

The STUB processor walks the job's stage plan (protocol.stages_for), yields a
progress event per stage, and writes a placeholder artifact to the MediaStore path. Swapping in
the real Demucs `htdemucs` pipeline behind the SAME interface (an async generator of ProgressEvent
ending with a CompleteResult), so the dial-home loop never changes. Mirrors the TS "pure logic
split from I/O so it unit-tests without the binary" convention (ytdlp.ts parseSearchJson).
"""
from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from typing import AsyncIterator, Protocol

from . import protocol

# Stored stem formats. The two stems get DIFFERENT treatment because they
# have different jobs:
#
#   instrumental -> FLAC (lossless). This is the file that comes out of the speakers at volume, and it
#     is the one place a second lossy generation is audible: ffmpeg's native AAC encoder smears
#     high-frequency transients, which is exactly what a crash cymbal is. Lossless removes that
#     generation entirely. ~22 MB for a 3:27 track vs ~5 MB, which is affordable now.
#   vocals -> AAC (lossy). Nothing plays it aloud; it feeds pitch extraction and the future vocal
#     guide, so transparency is not the bar.
#
# MUST match the core's paths.ts INSTRUMENTAL_EXT / VOCALS_EXT.
INSTRUMENTAL_EXT = "flac"
VOCALS_EXT = "m4a"


@dataclass
class ProgressEvent:
    stage: str
    pct: int
    eta_sec: int | None = None


@dataclass
class CompleteResult:
    media_uri: str
    artifacts: dict


@dataclass
class JobSpec:
    job_id: str
    media_id: str
    job_type: str
    source_uri: str
    params: dict
    # where the worker writes outputs (the shared /media volume in single-box mode)
    media_dir: str


class Processor(Protocol):
    """Process one job, yielding ProgressEvents and finally a CompleteResult. Raising signals a
    failure to the caller, which decides retryable-or-not."""

    def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]: ...


class StubProcessor:
    """No-ML stand-in: emits each planned stage at stepped pct and writes a tiny placeholder file so
    the end-to-end path (assign→accept→progress→complete→ready, media flip) is exercisable without
    torch. `step_delay` is injectable so tests run instantly."""

    def __init__(self, step_delay: float = 0.0) -> None:
        self._delay = step_delay

    async def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        stages = protocol.stages_for(job.job_type)
        for i, stage in enumerate(stages):
            # ramp pct across stages: e.g. 2 stages -> 50, 100
            pct = round((i + 1) / len(stages) * 100)
            if self._delay:
                await asyncio.sleep(self._delay)
            yield ProgressEvent(stage=stage, pct=pct, eta_sec=max(0, (len(stages) - i - 1)))

        out_path = instrumental_path(job.media_dir, job.media_id)
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(b"ENCORE_STUB_INSTRUMENTAL\n")  # placeholder; the real processor writes the track
        yield CompleteResult(media_uri=out_path, artifacts={"stems": {"instrumental": out_path}})


def instrumental_path(media_dir: str, media_id: str) -> str:
    """Deterministic MediaStore key for a media's instrumental stem.

    Lives under the `derived/` storage class (regenerable from `audio/`). MUST match the core's
    paths.ts instrumentalKey() byte-for-byte -- the TV resolves /media/<ref>, so a mismatch 404s on a
    file that exists.
    """
    return os.path.join(media_dir, "derived", "stems", f"{media_id}-instrumental.{INSTRUMENTAL_EXT}")


def source_audio_path(media_dir: str, media_id: str, ext: str = "wav") -> str:
    """Deterministic key for a media's RAW ORIGINAL audio in the `audio/` storage class.

    This is the only class that cannot be regenerated: re-acquiring it needs network, and it is gone
    permanently once the upload disappears. It used to be written to `stems/_work/<id>/source.wav` --
    a scratch path -- which meant it was simultaneously our most expensive asset and the one treated
    as garbage (432MB of it accumulated on the live box because nothing cleaned scratch either).
    Mirrors the core's paths.ts audioKey().
    """
    return os.path.join(media_dir, "audio", f"{media_id}.{ext.lstrip('.')}")


def vocals_path(media_dir: str, media_id: str) -> str:
    """Deterministic MediaStore key for a media's ISOLATED VOCALS stem. Feeds pitch
    extraction and the vocal-guide mix (docs/archive/reference/vocal-guide-spec.md). Parallels the core's
    make-karaoke `vocalsKey` (stems/<mediaId>-vocals.wav) so the TV resolves the same /media name."""
    return os.path.join(media_dir, "derived", "stems", f"{media_id}-vocals.{VOCALS_EXT}")


def pitch_track_path(media_dir: str, media_id: str) -> str:
    """Deterministic MediaStore key for a media's reference pitch-track artifact. The core
    fetches it via /media to score the live mic against. JSON, keyed parallel to the stems."""
    return os.path.join(media_dir, "derived", "pitch", f"{media_id}-pitch.json")


class RoutingProcessor:
    """Dispatch a job to the right sub-processor by job_type (e.g. stems→Demucs, align→WhisperX).
    A worker advertising multiple capabilities runs one RoutingProcessor; unknown types raise (the
    dial-home loop reports a failure). Keeps dial_home.py agnostic to which pipeline runs."""

    def __init__(self, by_type: dict[str, Processor]) -> None:
        self._by_type = by_type

    def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        proc = self._by_type.get(job.job_type)
        if proc is None:
            raise RuntimeError(f"no processor for job type: {job.job_type}")
        return proc.process(job)


class EngineRouter:
    """Route a SEPARATION job (stems / stems-upgrade) to the engine named by params.engine:
    'demucs' → DemucsProcessor, 'roformer' → RoformerProcessor. Defaults to 'demucs' when the param
    is absent, so a job from an older core (which sent no engine) still separates. An engine this
    worker was not built with raises — but that should never happen, because the CORE only routes a
    roformer cook to a worker advertising the `stems:roformer` capability."""

    def __init__(self, by_engine: dict[str, "Processor"], default: str = "demucs") -> None:
        self._by_engine = by_engine
        self._default = default

    def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        engine = job.params.get("engine") or self._default
        proc = self._by_engine.get(engine)
        if proc is None:
            raise RuntimeError(f"no processor for separator engine: {engine}")
        return proc.process(job)
