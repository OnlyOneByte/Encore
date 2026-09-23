"""A worker must accept a job it can actually run, even when the capability is NAMESPACED.

`can_accept` must match the job type against a namespaced capability list, not compare literal
strings — a separator engine advertises `stems:roformer`, a downloader advertises `fetch:ytdlp` — or
a job silently bounces forever: the core keeps it assigned, the worker logs nothing, and the song
sits at 0%, indistinguishable from a hung download.
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


# `stems-upgrade` is a fourth Action, but no capability token is ever named `stems-upgrade` or
# `stems-upgrade:*`: the core maps the upgrade action onto a STEMS-family capability (`stems` for
# demucs, `stems:roformer`/`stems:ensemble` otherwise), so `supports("stems-upgrade")` must resolve
# through that family mapping rather than deriving a capability textually from the job type.


def test_a_demucs_stems_worker_accepts_a_stems_upgrade_job():
    # The common deployment: a plain demucs box advertises `stems`. With Re-process on and HT-Demucs FT
    # picked, the core demands `stems` for the upgrade, so this worker must accept it.
    s = state("fetch:ytdlp", "stems", "align")
    assert s.supports("stems-upgrade") is True
    assert s.can_accept("stems-upgrade")[0] is True


def test_a_roformer_only_worker_accepts_a_stems_upgrade_job():
    # A roformer engine box advertises `stems:roformer`; the upgrade is a separation job served by the
    # same engine token, so the prefix must match through the action→family resolution.
    s = state("stems:roformer")
    assert s.supports("stems-upgrade") is True
    assert s.can_accept("stems-upgrade")[0] is True


def test_a_fetch_only_worker_still_refuses_a_stems_upgrade_job():
    # The fix must not become "accept everything": a box with no stems-family capability must keep
    # refusing the upgrade, or the core would hand it work it cannot run.
    s = state("fetch:ytdlp")
    assert s.supports("stems-upgrade") is False
    ok, reason = s.can_accept("stems-upgrade")
    assert ok is False
    assert "unsupported job type: stems-upgrade" in reason


# EVERY action the core can dispatch must be accepted by a worker advertising the capability the
# core's requiredCapability (src/server/jobs/dispatch.ts) would demand for it. Asserted against the
# WORST-CASE demanded token (the most-namespaced form) so a worker advertising exactly that token and
# nothing broader still accepts. Kept as an explicit table, not derived from Action, so a new action
# must be added deliberately with the capability the core would demand for it.
_CORE_REQUIRED_CAPABILITY = {
    "fetch": "fetch:ytdlp",
    "stems": "stems:roformer",
    "stems-upgrade": "stems:ensemble",
    "align": "align",
}


def test_every_dispatchable_action_is_accepted_by_a_worker_with_the_core_demanded_capability():
    from src.vocabulary import Action

    # The table must cover every Action the core can dispatch, or a new action could slip through
    # unguarded (the exact shape of this bug).
    assert set(_CORE_REQUIRED_CAPABILITY) == {a.value for a in Action}

    for action, demanded in _CORE_REQUIRED_CAPABILITY.items():
        s = state(demanded)  # a worker advertising ONLY the capability the core demands for this action
        assert s.supports(action) is True, (
            f"worker with capability {demanded!r} refuses action {action!r} the core would route to it"
        )
        assert s.can_accept(action)[0] is True, action
