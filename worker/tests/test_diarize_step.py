"""The Diarize step, wired into the real align plan.

Drives `plans.align_runner` with an injected fake diarizer and a vocals stem on disk, and asserts the
published word-timed doc gains `part` labels on a confident duet — and stays byte-identical to today
on every fallback path (no stem, no diarizer signal, not a duet, diarizer raises). The align seams
(yt-dlp, LRCLIB, aligner) are the existing fakes from `test_align_plan.py`, imported so this test
exercises the SAME plan a worker runs, not a toy one.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import plans  # noqa: E402
from src.processor import VOCALS_EXT, CompleteResult  # noqa: E402
from tests.conftest import drain  # noqa: E402
from tests.test_align_plan import FakeAligner, fake_client, fake_ytdlp_runner, spec  # noqa: E402


class FakeDiarizer:
    """Diarizer stand-in: returns a fixed segment list and records that it was asked. `segments=None`
    models a diarizer that could not label anything (the single-colour fallback)."""

    def __init__(self, segments):
        self._segments = segments
        self.calls: list[str] = []

    def diarize(self, vocals_path: str):
        self.calls.append(vocals_path)
        if self._segments is None:
            return []
        return list(self._segments)


class BrokenDiarizer:
    def diarize(self, vocals_path: str):
        raise RuntimeError("pyannote unavailable (simulated)")


def _seed_vocals_stem(tmp_path: Path, media_id: str = "m1") -> None:
    """Put a `<id>-vocals.<ext>` on disk so AcquireAudio sets ctx.audio.vocals_path and Diarize applies.

    `_existing_vocals` globs the canonical `derived/stems/<id>-vocals.*` path, so the byte content is
    irrelevant — only presence there matters, exactly as a real stems process would have left it."""
    from src.processor import vocals_path

    stem = Path(vocals_path(str(tmp_path), media_id))
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.write_bytes(b"stem")


def _published_doc(events) -> dict:
    completes = [e for e in events if isinstance(e, CompleteResult)]
    assert len(completes) == 1
    return json.loads(Path(completes[0].media_uri).read_text())


# The default fake_client (test_align_plan) yields a 2-line LRCLIB record aligned to [1,3] and [3,5];
# FakeAligner word-times them. A clean two-speaker split over those two lines is a confident duet.
_DUET = [
    {"start": 0.9, "end": 3.0, "speaker": "SPEAKER_00"},
    {"start": 3.0, "end": 5.1, "speaker": "SPEAKER_01"},
]


@pytest.mark.asyncio
async def test_a_confident_duet_stamps_part_onto_the_published_lyrics(tmp_path):
    _seed_vocals_stem(tmp_path)
    diarizer = FakeDiarizer(_DUET)
    proc = plans.align_runner(
        runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=FakeAligner(), diarizer=diarizer
    )
    events = await drain(proc, spec(tmp_path))
    # It ran against the isolated vocals stem, not the mix.
    assert diarizer.calls and diarizer.calls[0].endswith(f"m1-vocals.{VOCALS_EXT}")
    doc = _published_doc(events)
    parts = [ln.get("part") for ln in doc["lines"]]
    assert parts == ["A", "B"], "a clean two-speaker duet must carry A/B parts on its lines"


@pytest.mark.asyncio
async def test_no_vocals_stem_skips_diarization_entirely(tmp_path):
    # No stem seeded → ctx.audio.vocals_path is None → Diarize.applies() is False.
    diarizer = FakeDiarizer(_DUET)
    proc = plans.align_runner(
        runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=FakeAligner(), diarizer=diarizer
    )
    doc = _published_doc(await drain(proc, spec(tmp_path)))
    assert not diarizer.calls, "diarization must not run without a vocals stem"
    assert all("part" not in ln for ln in doc["lines"])


@pytest.mark.asyncio
async def test_a_single_speaker_result_leaves_lyrics_single_colour(tmp_path):
    _seed_vocals_stem(tmp_path)
    diarizer = FakeDiarizer([{"start": 0.0, "end": 6.0, "speaker": "SPEAKER_00"}])
    proc = plans.align_runner(
        runner=fake_ytdlp_runner(), lyrics_client=fake_client(), aligner=FakeAligner(), diarizer=diarizer
    )
    doc = _published_doc(await drain(proc, spec(tmp_path)))
    assert diarizer.calls, "diarization SHOULD have run (a stem exists)"
    assert all("part" not in ln for ln in doc["lines"]), "one voice → single colour, no part field"


@pytest.mark.asyncio
async def test_a_diarizer_that_raises_never_fails_the_align_job(tmp_path):
    _seed_vocals_stem(tmp_path)
    proc = plans.align_runner(
        runner=fake_ytdlp_runner(),
        lyrics_client=fake_client(),
        aligner=FakeAligner(),
        diarizer=BrokenDiarizer(),
    )
    events = await drain(proc, spec(tmp_path))
    # The job still completes with lyrics; diarization failure is a silent single-colour fallback.
    doc = _published_doc(events)
    assert doc["lines"], "align job must still publish lyrics when diarization raises"
    assert all("part" not in ln for ln in doc["lines"])
