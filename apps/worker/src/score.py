"""Reference-pitch-track pipeline for the `score` job.

SingStar-style scoring needs a REFERENCE melody to compare the live mic against. That reference is
the pitch of the original vocal: so a `score` job runs the same stems separation the karaoke path
uses (reusing the tested DemucsProcessor pipeline verbatim) and then extracts a per-frame pitch
track from the isolated `vocals.wav`, publishing it as a regular-grid JSON artifact the core
scorer aligns the mic to.

Composition over duplication: PitchTrackProcessor WRAPS a separator, forwards its progress + stems,
and appends the pure pitch extraction. The extractor and file writer are INJECTABLE so the whole
flow unit-tests with a fake separator + canned frames — no torch, no real audio (the demucs.py
convention). Best-effort: if the vocals stem can't be tracked, the job still ships the stems (the
instrumental is the load-bearing karaoke output); scoring simply won't have a reference and no-ops.
"""
from __future__ import annotations

import json
import os
from typing import AsyncIterator, Callable

from .pitch_track import PitchFrame, extract_pitch_track, pitch_track_to_artifact, read_wav_mono
from .processor import CompleteResult, JobSpec, ProgressEvent, Processor, pitch_track_path

# (wav path) -> per-frame pitch track. Default reads the wav and runs the pure tracker; injectable
# so tests feed canned frames without real audio.
Extractor = Callable[[str], list[PitchFrame]]
# (path, text) -> None. Default writes the file; injectable so tests capture without touching disk.
Writer = Callable[[str, str], None]


def _default_extract(wav_path: str) -> list[PitchFrame]:
    samples, sample_rate = read_wav_mono(wav_path)
    return extract_pitch_track(samples, sample_rate)


def _default_write(path: str, text: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


class PitchTrackProcessor:
    """`score` job: separate (via the wrapped processor) → extract a reference pitch track from the
    isolated vocals → publish a `pitch` artifact alongside the stems. Same async-generator interface
    as every other processor, so dial_home.py / RoutingProcessor are unchanged."""

    def __init__(
        self,
        *,
        separator: Processor,
        extract: Extractor = _default_extract,
        writer: Writer = _default_write,
    ) -> None:
        self._sep = separator
        self._extract = extract
        self._write = writer

    async def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        # Run the separation, forwarding its progress; capture its terminal artifacts/media_uri.
        stems: dict[str, str] = {}
        media_uri = ""
        async for ev in self._sep.process(job):
            if isinstance(ev, CompleteResult):
                stems = dict(ev.artifacts.get("stems", {}))
                media_uri = ev.media_uri
                break  # separation done — don't forward its CompleteResult; we emit the final one
            yield ev

        artifacts: dict = {"stems": stems} if stems else {}

        # Extract the reference pitch track from the isolated vocals (best-effort).
        vocals = stems.get("vocals")
        if vocals:
            try:
                track = self._extract(vocals)
                out = pitch_track_path(job.media_dir, job.media_id)
                self._write(out, json.dumps(pitch_track_to_artifact(track)))
                artifacts["pitch"] = {"uri": out}
            except Exception:
                pass  # no reference track → scoring no-ops; the karaoke instrumental still ships

        yield CompleteResult(media_uri=media_uri, artifacts=artifacts)
