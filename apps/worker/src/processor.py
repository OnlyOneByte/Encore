"""Job processor seam — the pluggable unit that turns a source into stems/lyrics.

M7-C4 ships the STUB processor: it walks the job's stage plan (protocol.stages_for), yields a
progress event per stage, and writes a placeholder artifact to the MediaStore path. M7-C5 swaps in
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
            f.write(b"ENCORE_STUB_INSTRUMENTAL\n")  # placeholder; M7-C5 writes the real track
        yield CompleteResult(media_uri=out_path, artifacts={"stems": {"instrumental": out_path}})


def instrumental_path(media_dir: str, media_id: str) -> str:
    """Deterministic MediaStore key for a media's instrumental stem (single-box local volume)."""
    return os.path.join(media_dir, "stems", f"{media_id}-instrumental.wav")


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
