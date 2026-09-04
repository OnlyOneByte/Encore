"""Job processor seam — the pluggable unit that turns a source into stems/lyrics.

The STUB processor walks the job's stage plan, yields a progress event per stage, and writes a
placeholder artifact. The real Demucs pipeline swaps in behind the SAME interface (an async
generator of ProgressEvent ending with a CompleteResult), so the dial-home loop never changes.
"""
from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field
from typing import AsyncIterator, Protocol

from . import protocol

# Stored stem formats — the two stems get DIFFERENT treatment:
#   instrumental -> FLAC (lossless). It comes out of the speakers at volume, and it is the one place
#     a second lossy generation is audible: AAC smears high-frequency transients (a crash cymbal).
#     ~22 MB for a 3:27 track vs ~5 MB, affordable now.
#   vocals -> AAC (lossy). Nothing plays it aloud; it feeds pitch extraction + the future vocal
#     guide, so transparency is not the bar.
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
    # What this processor ACTUALLY resolved and ran — engine/model/backend/device. Distinct from
    # `job.params`, which is what the core ASKED for: a processor may resolve a model alias to a
    # different checkpoint, or fall back to CPU when the requested backend will not load. Defaults
    # empty so a processor that reports nothing simply leaves the core's dispatched values standing.
    facts: dict = field(default_factory=dict)


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


# ── silence detection ───────────────────────────────────────────────────────────
# Separation can SUCCEED and still write digital silence. It has happened twice in the owner's
# library: both stems came back pinned at the 16-bit floor, ~50KB against 20MB, and every readiness
# check downstream only ever verified that the file EXISTED. The song then sat in the Ready list and
# would have played four minutes of nothing.
#
# For the guiding track that failure is worse than a missing stem, because a silent guide looks like
# a working one — the singer drags the control up and nothing happens. The worker is the right place
# to catch it: it owns the encoder, it has ffmpeg, and it knows the answer immediately. A stem it
# measures as silent is simply not reported, so an absent artifact stays a real answer rather than a
# missing one.

#: Peak at or below this (dBFS) is digital silence. 16-bit silence measures ~-91 dB; no real vocal
#: stem peaks near it. -90 leaves headroom for a dithered "silent" file without catching real audio.
SILENCE_FLOOR_DB = -90.0


def volumedetect_argv(path: str, ffmpeg_bin: str = "ffmpeg") -> list[str]:
    """ffmpeg argv that measures a file's mean/max volume and writes nothing."""
    return [
        ffmpeg_bin,
        "-hide_banner",
        "-nostats",
        "-i",
        path,
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
    ]


def parse_max_volume_db(output: str) -> float | None:
    """PURE: pull `max_volume: -N dB` out of ffmpeg's volumedetect output.

    Returns None when the line is absent (ffmpeg error, wrong filter, truncated output). None means
    UNMEASURABLE, which is deliberately not the same as silent -- see `is_silent`.
    """
    for line in output.splitlines():
        idx = line.find("max_volume:")
        if idx == -1:
            continue
        tail = line[idx + len("max_volume:") :].strip()
        token = tail.split(" ", 1)[0]
        try:
            return float(token)
        except ValueError:
            return None
    return None


def is_silent(max_volume_db: float | None) -> bool:
    """PURE: is this reading digital silence?

    An UNMEASURABLE file (None) is NOT silence. If ffmpeg is missing or refuses the file, declaring
    every stem silent would throw away working guides across the whole library; trusting the encoder
    is the safer failure. We only ever act on a positive measurement.
    """
    if max_volume_db is None:
        return False
    return max_volume_db <= SILENCE_FLOOR_DB


class RoutingProcessor:
    """Dispatch a job to the right sub-processor by job_type (stems→Demucs, align→WhisperX).
    Unknown types raise (the dial-home loop reports a failure)."""

    def __init__(self, by_type: dict[str, Processor]) -> None:
        self._by_type = by_type

    def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        proc = self._by_type.get(job.job_type)
        if proc is None:
            raise RuntimeError(f"no processor for job type: {job.job_type}")
        return proc.process(job)


class EngineRouter:
    """Route a SEPARATION job (stems / stems-upgrade) to the engine named by params.engine:
    'demucs' → DemucsProcessor, 'roformer' → RoformerProcessor. Defaults to 'demucs' when absent, so
    a job from an older core (no engine) still separates. An engine this worker was not built with
    raises — but the CORE only routes a roformer cook to a worker advertising `stems:roformer`."""

    def __init__(self, by_engine: dict[str, "Processor"], default: str = "demucs") -> None:
        self._by_engine = by_engine
        self._default = default

    def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        engine = job.params.get("engine") or self._default
        proc = self._by_engine.get(engine)
        if proc is None:
            raise RuntimeError(f"no processor for separator engine: {engine}")
        return proc.process(job)
