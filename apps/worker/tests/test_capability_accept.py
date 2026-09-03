"""A worker must accept a job it can actually run, even when the capability is NAMESPACED.

REGRESSION THIS PINS. `can_accept` compared the job type to the capability list as a literal string.
Both axes namespace their capabilities -- a separator engine advertises `stems:roformer`, a downloader
advertises `fetch:ytdlp` -- so a `fetch` job arriving at a worker advertising `fetch:ytdlp` was rejected
with "unsupported job type: fetch". Every acquisition silently bounced: the core kept the job assigned,
the worker logged nothing, and the song sat at 0% forever, which reads exactly like a hung download.

It was invisible to unit tests because those built the processor and called it directly; nothing
exercised the ACCEPT decision on the dial-home message path. Hence this file.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.protocol import WorkerState  # noqa: E402


def state(*caps: str, concurrency: int = 2) -> WorkerState:
    return WorkerState(worker_id="w1", capabilities=list(caps), concurrency=concurrency)


def test_a_namespaced_fetch_capability_accepts_a_fetch_job():
    s = state("fetch:ytdlp", "stems")
    assert s.supports("fetch") is True
    ok, reason = s.can_accept("fetch")
    assert ok is True, reason


def test_a_roformer_only_worker_still_accepts_a_stems_job():
    # Same class of bug on the separator axis: the job type is `stems`, the capability is
    # `stems:roformer`, and the engine is chosen per-job from params.
    s = state("stems:roformer")
    assert s.supports("stems") is True
    assert s.can_accept("stems")[0] is True


def test_an_unadvertised_action_is_still_refused():
    # The prefix match must not become "accept everything": a worker with no align capability must
    # keep rejecting align, or the core would hand it work it cannot do and wait for a lease to lapse.
    s = state("fetch:ytdlp", "stems")
    ok, reason = s.can_accept("align")
    assert ok is False
    assert "unsupported job type: align" in reason
    assert s.supports("align") is False


def test_a_prefix_match_is_anchored_to_the_action_not_a_substring():
    # `stems` must not be satisfied by something merely CONTAINING it, only by `stems` or `stems:*`.
    s = state("upgrade:stems")
    assert s.supports("stems") is False


def test_no_free_slots_still_refuses_a_supported_action():
    s = state("fetch:ytdlp", concurrency=1)
    s.start("j1")
    ok, reason = s.can_accept("fetch")
    assert ok is False
    assert reason == "no free slots"
