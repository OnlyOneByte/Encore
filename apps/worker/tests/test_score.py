"""score job (M8-C3): PitchTrackProcessor wraps the separator, then extracts a reference pitch track
from the isolated vocals and publishes it as a `pitch` artifact. Driven by a FAKE separator + canned
frames (no torch, no real audio) — the real-ML run defers to a GPU box."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.pitch_track import PitchFrame  # noqa: E402
from src.processor import CompleteResult, JobSpec, ProgressEvent  # noqa: E402
from src.score import PitchTrackProcessor  # noqa: E402


def spec(tmp_path, media_id="m1"):
    return JobSpec(job_id="j1", media_id=media_id, job_type="score", source_uri="https://yt/x",
                   params={}, media_dir=str(tmp_path))


class FakeSeparator:
    """Stands in for DemucsProcessor: yields two progress events then a stems CompleteResult."""

    def __init__(self, stems, media_uri="/media/stems/m1-instrumental.wav"):
        self._stems = stems
        self._media_uri = media_uri

    async def process(self, job):
        yield ProgressEvent(stage="downloading", pct=100)
        yield ProgressEvent(stage="separating", pct=100)
        yield CompleteResult(media_uri=self._media_uri, artifacts={"stems": self._stems})


CANNED = [
    PitchFrame(time_sec=0.0, f0_hz=0.0, midi=0.0, voiced=False, confidence=0.1),
    PitchFrame(time_sec=0.01, f0_hz=220.0, midi=57.0, voiced=True, confidence=0.9),
    PitchFrame(time_sec=0.02, f0_hz=440.0, midi=69.0, voiced=True, confidence=0.95),
]


async def drain(processor, job):
    events = []
    async for ev in processor.process(job):
        events.append(ev)
    return events


@pytest.mark.asyncio
async def test_score_publishes_reference_pitch_track(tmp_path):
    sep = FakeSeparator({"instrumental": "/media/stems/m1-instrumental.wav", "vocals": "/media/stems/m1-vocals.wav"})
    written = {}
    proc = PitchTrackProcessor(
        separator=sep,
        extract=lambda path: CANNED,  # canned frames — no real audio
        writer=lambda p, text: written.__setitem__(p, text),
    )
    events = await drain(proc, spec(tmp_path))

    # separation progress is forwarded; exactly one (final) CompleteResult
    stages = [(e.stage, e.pct) for e in events if isinstance(e, ProgressEvent)]
    assert ("downloading", 100) in stages and ("separating", 100) in stages
    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    final = completes[0]
    # media_uri is preserved (the karaoke instrumental); artifacts carry BOTH stems and pitch
    assert final.media_uri == "/media/stems/m1-instrumental.wav"
    assert final.artifacts["stems"]["vocals"].endswith("m1-vocals.wav")
    pitch_uri = final.artifacts["pitch"]["uri"]
    assert pitch_uri.endswith("m1-pitch.json")
    # the pitch artifact was written with the regular-grid shape
    doc = json.loads(written[pitch_uri])
    assert doc["frameCount"] == 3
    assert doc["hopSec"] == 0.01
    assert doc["f0Hz"] == [0.0, 220.0, 440.0]
    assert doc["voiced"] == [False, True, True]


@pytest.mark.asyncio
async def test_score_best_effort_no_vocals_still_completes(tmp_path):
    # separator produced no vocals stem → no reference pitch track, but the job still ships stems
    sep = FakeSeparator({"instrumental": "/media/stems/m1-instrumental.wav"})
    proc = PitchTrackProcessor(separator=sep, extract=lambda p: CANNED, writer=lambda p, t: None)
    completes = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    assert "pitch" not in completes[0].artifacts
    assert completes[0].artifacts["stems"]["instrumental"].endswith("m1-instrumental.wav")


@pytest.mark.asyncio
async def test_score_extractor_failure_is_best_effort(tmp_path):
    # a vocals stem exists but extraction throws (corrupt/unreadable) → still completes, no pitch
    def boom(_path):
        raise ValueError("unreadable wav")

    sep = FakeSeparator({"instrumental": "/media/stems/m1-instrumental.wav", "vocals": "/media/stems/m1-vocals.wav"})
    proc = PitchTrackProcessor(separator=sep, extract=boom, writer=lambda p, t: None)
    completes = [e for e in await drain(proc, spec(tmp_path)) if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    assert "pitch" not in completes[0].artifacts
    assert "stems" in completes[0].artifacts
