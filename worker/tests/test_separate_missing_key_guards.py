"""DecodeToWav's empty-`audio.path` guard and PublishStems' missing-instrumental guard must classify
NON-RETRYABLE: both are DETERMINISTIC plan errors (a step ran out of order), so a retry re-runs the
same passes and fails identically, and a bare RuntimeError (retryable by default) would burn up to
three attempts on a job that can never succeed.

These assert the CLASSIFICATION (is_retryable is False), not the exception type: PermanentError IS-A
RuntimeError, so `pytest.raises(RuntimeError)` matches even on a reverted bare raise — only the
is_retryable assertion reds in that case.
"""

from __future__ import annotations

import sys
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import retry_policy  # noqa: E402
from src.processor import JobSpec  # noqa: E402
from src.runtime import Ctx  # noqa: E402
from src.steps.separate import DecodeToWav, PublishStems  # noqa: E402


class _FakeEngine:
    """Minimal SeparatorEngine stand-in: DecodeToWav only needs input_wav() to pick a scratch path
    before it checks audio.path, and it must NOT reach the runner (the guard raises first)."""

    id = "fake"

    def input_wav(self, work: str) -> str:
        return f"{work}/fake_in/input.wav"


async def _boom_runner(argv) -> AsyncIterator[str]:
    # The guard raises before the runner is ever invoked; if it were reached, this would surface it.
    raise AssertionError("runner must not be reached — the missing-key guard raises first")
    yield ""  # pragma: no cover — makes this an async generator


def _ctx(tmp_path) -> Ctx:
    job = JobSpec(
        job_id="j1", media_id="m1", job_type="stems", source_uri="u", params={}, media_dir=str(tmp_path)
    )
    return Ctx(job=job, work=str(tmp_path / "work"), runner=_boom_runner)


async def test_decode_to_wav_empty_audio_path_is_classified_non_retryable(tmp_path):
    """An empty audio.path is a deterministic plan error (AcquireAudio did not run). The raise
    must carry a non-retryable classification so the core fails it after one pass instead of three.
    Asserts the CLASSIFICATION, not the type: on base (a bare RuntimeError) the exception still matches
    but is_retryable returns True and this assertion reds."""
    ctx = _ctx(tmp_path)
    assert ctx.audio.path in (None, "")  # premise: AcquireAudio did not run
    with pytest.raises(RuntimeError) as exc:  # PermanentError IS-A RuntimeError
        async for _ in DecodeToWav(engine=_FakeEngine()).run(ctx):
            pass
    assert retry_policy.is_retryable(exc.value) is False


async def test_publish_stems_missing_instrumental_is_classified_non_retryable(tmp_path):
    """A missing stems.raw['instrumental'] is a deterministic plan error (Separate did not run).
    Same reasoning and same base-red mechanism as the DecodeToWav guard above."""
    ctx = _ctx(tmp_path)
    ctx.stems.raw = {}  # premise: Separate did not run — no instrumental key
    with pytest.raises(RuntimeError) as exc:  # PermanentError IS-A RuntimeError
        async for _ in PublishStems().run(ctx):
            pass
    assert retry_policy.is_retryable(exc.value) is False
