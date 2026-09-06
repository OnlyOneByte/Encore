"""The Annotate STEP, driven end-to-end — the decline must reach the operator's log (#102).

test_annotate.py covers annotate_or_reason as a unit. What was missing is exactly this: the STEP that
production runs on every fetch, deciding what an operator is told when the lookup declines. Before this
fix ctx.note fired ONLY on success, so an IP-level MusicBrainz block — which declines every annotation
indefinitely — was indistinguishable from a healthy per-song miss, and the rate gate's throttle
counters (built and documented as the operator's diagnosis) had no reader anywhere in src/. Here the
step drives a REAL MusicBrainzClient + RateLimiter through an injected fetcher (no unit under test is
mocked), so the note is proven to carry the real gate state.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.metadata import annotate as ann  # noqa: E402
from src.processor import JobSpec  # noqa: E402
from src.runtime import Ctx  # noqa: E402
from src.steps.metadata import Annotate  # noqa: E402

REAL_BODY = {
    "recordings": [
        {
            "id": "8c0c2908-0000-4000-8000-000000000002",
            "score": 100,
            "title": "Take On Me",
            "length": 217906,  # 217.906s — the single, matches durationSec 218
            "artist-credit": [{"name": "a-ha"}],
            "releases": [{"title": "Hunting High and Low", "date": "1985-06-01"}],
        }
    ]
}


def _client(fetcher):
    # Its own limiter (never the process-global one) so the test is order-independent; still a REAL
    # RateLimiter, so its counters are the genuine ones the step reads.
    return ann.MusicBrainzClient(
        fetcher=fetcher,
        rate_limiter=ann.RateLimiter(min_interval=0.0, now=lambda: 0.0, sleep=lambda _s: None),
    )


async def _drive(step: Annotate, ctx: Ctx) -> None:
    async for _ in step.run(ctx):
        pass


async def test_a_throttled_lookup_leaves_an_operator_note_carrying_the_gate_counters():
    step = Annotate(annotator=_client(lambda u, h: (503, "")))
    job = JobSpec(job_id="j", media_id="m", job_type="fetch", source_uri="u",
                  params={"artist": "a-ha", "track": "Take On Me", "durationSec": 218.0}, media_dir="/tmp")
    ctx = Ctx(job=job, work="/tmp/work")
    await _drive(step, ctx)
    # no annotation written — best-effort contract holds — but the decline is NO LONGER silent
    assert "annotation" not in ctx.out.artifacts
    notes = "\n".join(ctx.out.notes)
    assert "annotation declined" in notes
    assert "throttled" in notes
    assert "'throttled': 3" in notes  # the real gate counters rode into the log


async def test_a_healthy_match_still_writes_the_artifact_and_the_success_note():
    step = Annotate(annotator=_client(lambda u, h: (200, __import__("json").dumps(REAL_BODY))))
    job = JobSpec(job_id="j", media_id="m", job_type="fetch", source_uri="u",
                  params={"artist": "a-ha", "track": "Take On Me", "durationSec": 218.0}, media_dir="/tmp")
    ctx = Ctx(job=job, work="/tmp/work")
    await _drive(step, ctx)
    assert ctx.out.artifacts["annotation"]["source"] == "musicbrainz"
    assert any("identified against MusicBrainz" in n for n in ctx.out.notes)
    assert not any("declined" in n for n in ctx.out.notes)


async def test_a_genuine_miss_notes_a_DIFFERENT_reason_than_a_throttle():
    step = Annotate(annotator=_client(lambda u, h: (200, '{"recordings": []}')))
    job = JobSpec(job_id="j", media_id="m", job_type="fetch", source_uri="u",
                  params={"artist": "a-ha", "track": "Take On Me", "durationSec": 218.0}, media_dir="/tmp")
    ctx = Ctx(job=job, work="/tmp/work")
    await _drive(step, ctx)
    notes = "\n".join(ctx.out.notes)
    assert "annotation declined: no confident match" in notes
    assert "throttled" not in notes
