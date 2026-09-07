"""Shared worker-test helpers, auto-loaded by pytest for apps/worker/tests.

Batch 2 of the test-suite dedup (#626, follows #618/#455): `drain()` was hand-copied
into SEVEN test files in two spellings of the same operation — consume a PlanRunner/processor's
async event stream into a list. Six were live callers, now routed here (test_align_plan,
test_demucs, test_fetch, test_runtime, test_roformer, test_song_profile); the seventh copy, in
test_stems_ytdlp_bin, was DEAD (defined, never called) and was deleted rather than routed.
Single-sourced here so a change to the drain contract lands in one place.
"""

from collections.abc import AsyncIterator
from typing import Any


async def drain(proc: Any, job: Any) -> list[Any]:
    """Consume ``proc.process(job)`` — an async iterator of progress/result events — into a list.

    ``proc`` is a PlanRunner (or processor) and ``job`` a JobSpec/spec; both are passed positionally
    at every call site, so unifying the second parameter's name (was ``job``/``spec``) is safe.
    """
    events: list[Any] = []
    stream: AsyncIterator[Any] = proc.process(job)
    async for ev in stream:
        events.append(ev)
    return events
