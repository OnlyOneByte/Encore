"""Job processor seam — the pluggable unit that turns a source into stems/lyrics.

The STUB processor walks the job's stage plan, yields a progress event per stage, and writes a
placeholder artifact. The real implementation is `runtime.runner.PlanRunner`, which swaps in behind
the SAME interface (an async generator of ProgressEvent ending with a CompleteResult) — so the
dial-home loop never changes, and one runner serves all four actions rather than a class per action.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Protocol

from . import protocol
from .host.ffmpeg import ffmpeg_argv

# Both stems are lossless FLAC: the instrumental plays at volume (a second lossy generation would
# smear high-frequency transients), and the vocals guide track shares the SAME codec/container so
# both decode to a sample-exact common start (an AAC-in-m4a encoder's priming samples would otherwise
# shift the vocals start relative to the instrumental).
# MUST match the core's paths.ts INSTRUMENTAL_EXT / VOCALS_EXT.
INSTRUMENTAL_EXT = "flac"
VOCALS_EXT = "flac"
# The GUIDE MIX: both stems in ONE 4-channel FLAC (ch 0/1 instrumental, ch 2/3 vocals), played by one
# element with ONE playhead so the guide cannot drift from the instrumental at all.
# MUST match the core's paths.ts GUIDE_MIX_EXT.
GUIDE_MIX_EXT = "flac"


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
    # `job.params` (what the core ASKED for): a processor may resolve a model alias to a different
    # checkpoint. Defaults empty so a processor reporting nothing leaves the core's dispatched values
    # standing.
    facts: dict = field(default_factory=dict)
    # WHY the published lyric won: per-candidate label + composite score + decided_by + baseline vote
    # count. Lands in the job_attempts audit trail. None on a job that made no lyrics selection.
    selection: dict | None = None


@dataclass
class JobSpec:
    job_id: str
    media_id: str
    job_type: str
    source_uri: str
    params: dict
    # where the worker writes outputs (the shared /media volume in single-box mode)
    media_dir: str
    # The trace id the core mints and threads through a chained run, so the worker can correlate its
    # logs to the process the operator sees on /metrics/<mediaId>. Empty for a core that predates
    # carrying it on the assign frame.
    processing_id: str = ""


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
    permanently once the upload disappears. Mirrors the core's paths.ts audioKey().
    """
    return os.path.join(media_dir, "audio", f"{media_id}.{ext.lstrip('.')}")


def vocals_path(media_dir: str, media_id: str) -> str:
    """Deterministic MediaStore key for a media's ISOLATED VOCALS stem. Feeds pitch
    extraction and the vocal-guide mix (docs/ARCHITECTURE.md §7). Parallels the core's
    process `vocalsKey` (stems/<mediaId>-vocals.wav) so the TV resolves the same /media name."""
    return os.path.join(media_dir, "derived", "stems", f"{media_id}-vocals.{VOCALS_EXT}")


def guide_mix_path(media_dir: str, media_id: str) -> str:
    """Deterministic MediaStore key for a media's GUIDE MIX — both stems as one 4-channel FLAC.

    Under `derived/stems/` beside the two single-stem files it is built from, because it is exactly as
    regenerable as they are: it is a lossless remux of PCM that separation already produced, so it costs
    one ffmpeg pass and no separation to rebuild, and it is safe to evict first.

    MUST match the core's paths.ts `guideMixKey()` byte-for-byte — the TV resolves `/media/<ref>`, so a
    mismatch 404s on a file that exists. Named `-guidemix` rather than `-mix` so it can never be read as
    a mixdown: nothing here is summed, the two stems sit side by side in separate channels.
    """
    return os.path.join(media_dir, "derived", "stems", f"{media_id}-guidemix.{GUIDE_MIX_EXT}")


def raw_caption_path(media_dir: str, media_id: str, kind: str, ext: str = "vtt") -> str:
    """Deterministic key for a media's RAW caption track, retained for post-process diagnosis.

    Under the `derived/` storage class so it is "safe to delete, regenerable, first to evict". Eviction
    here is REF-DRIVEN, not directory-driven, so a `derived/` file is only bounded by the
    `ENCORE_MEDIA_MAX_GB` cap once its key is enumerated in the core's `derivedRefsOf` (which
    reconstructs it from CAPTION_KINDS x KNOWN_CAPTION_EXTS via `rawCaptionKey` in paths.ts). It is
    NOT a lyrics candidate and is never recorded in the sidecar; it is debugging evidence of what the
    parser was handed, otherwise destroyed with the job scratch and unrecoverable (the upload may be
    gone or the box rate-limited).

    `kind` ("captions" authored / "auto-captions" machine) is a directory segment, NOT a filename
    part, so the authored/machine distinction stays STRUCTURAL exactly as `captions.py` insists: yt-dlp
    names both tracks identically, so a single flat namespace would reintroduce the filename-heuristic
    ambiguity the two-directory fetch scheme exists to prevent.
    """
    return os.path.join(media_dir, "derived", "captions", kind, f"{media_id}.captions.{ext.lstrip('.')}")


# Separation can SUCCEED and still write digital silence (measured: both stems pinned at the 16-bit
# floor, ~50KB against 20MB), and readiness checks downstream only ever verify the file EXISTED. For
# the guiding track this is worse than a missing stem — a silent guide looks like a working one, so
# the singer drags the control up and nothing happens. A stem measured as silent is simply not
# reported, so an absent artifact stays a real answer rather than a missing one.

#: Peak at or below this (dBFS) is digital silence. 16-bit silence measures ~-91 dB; no real vocal
#: stem peaks near it. -90 leaves headroom for a dithered "silent" file without catching real audio.
SILENCE_FLOOR_DB = -90.0


def volumedetect_argv(path: str, ffmpeg_bin: str = "ffmpeg") -> list[str]:
    """ffmpeg argv that measures a file's mean/max volume and writes nothing."""
    # quiet=False, not -loglevel error: volumedetect writes its max_volume summary to stderr at
    # ffmpeg's INFO level, which -loglevel error would suppress.
    return ffmpeg_argv(
        ffmpeg_bin, path, ["-af", "volumedetect"], ["-f", "null", "-"], quiet=False, overwrite=False
    )


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
    """Dispatch a job to the right sub-processor by job_type.

    Each entry is a `PlanRunner` carrying the declared plan for one action (fetch, stems,
    stems-upgrade, align) — `dial_home._build_processor` registers only the ones this worker's
    capabilities allow. Unknown types raise (the dial-home loop reports a failure).
    """

    def __init__(self, by_type: dict[str, Processor]) -> None:
        self._by_type = by_type

    def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        proc = self._by_type.get(job.job_type)
        if proc is None:
            raise RuntimeError(f"no processor for job type: {job.job_type}")
        return proc.process(job)
