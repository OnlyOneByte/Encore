"""The warm separator (#1357): one child kept loaded between songs, retired on anything that could leave it
bad, and never more than one. A fake `--serve` child stands in for demucs, speaking the same protocol."""

from __future__ import annotations

import sys
from collections.abc import Iterator
from pathlib import Path
from typing import cast

import pytest

from encore_worker.adapters import cli, demucs_warm
from encore_worker.adapters import separate as sep
from encore_worker.adapters.ports import ProgressSink
from encore_worker.host import hardware
from encore_worker.host.config import Config

FAKE = r"""
import json, os, sys, time
DONE = "\x1eencore-separated"
for line in sys.stdin:
    argv = json.loads(line)["argv"]
    if "hang" in argv:
        time.sleep(60)
    if "die" in argv:
        sys.exit(3)
    if "fail" in argv:
        print(DONE + " " + json.dumps({"ok": False, "why": "boom"}), flush=True)
        continue
    print(" 50%|#####     | 5/10", file=sys.stderr, flush=True)
    print(DONE + " " + json.dumps({"ok": True, "why": ""}), flush=True)
"""

KEY = ("htdemucs", "4", "32")


@pytest.fixture(autouse=True)
def fake_child(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    script = tmp_path / "fake_serve.py"
    script.write_text(FAKE)
    monkeypatch.setattr(demucs_warm, "SERVE_ARGV", [sys.executable, str(script)])
    monkeypatch.setattr(demucs_warm, "_tight", lambda: False)
    demucs_warm.release()
    yield
    demucs_warm.release()


def song(
    *extra: str, key: tuple[str, ...] = KEY, progress: list[int] | None = None, idle: float = 30.0
) -> bool:
    sink = cast("ProgressSink", progress.append) if progress is not None else None
    return demucs_warm.separate(["song.wav", *extra], key=key, env={}, on_progress=sink, idle_sec=idle)


def kept_pid() -> int | None:
    child = demucs_warm._idle
    return child.proc.pid if child is not None else None


def test_the_second_song_reuses_the_child_the_first_one_started() -> None:
    heard: list[int] = []
    assert song(progress=heard)
    first = kept_pid()
    assert song(progress=heard)
    assert first is not None and kept_pid() == first
    assert heard == [50, 50], "progress still reaches the job, as from a cold child"


def test_a_different_j_or_thread_count_starts_a_fresh_child() -> None:
    assert song()
    first = kept_pid()
    assert song(key=("htdemucs", "2", "16"))
    assert kept_pid() not in (None, first)


def test_a_job_finding_it_busy_runs_cold_and_no_second_child_starts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(demucs_warm, "_out", True)
    assert song() is False
    assert demucs_warm._idle is None


@pytest.mark.parametrize("trouble", ["fail", "die"])
def test_a_failed_song_raises_and_retires_the_child(trouble: str) -> None:
    assert song()
    with pytest.raises(cli.ToolFailed):
        song(trouble)
    assert demucs_warm._idle is None
    assert song(), "the next song starts a fresh child"


def test_a_silent_child_is_stalled_and_killed() -> None:
    with pytest.raises(cli.Stalled):
        song("hang", idle=0.5)
    assert demucs_warm._idle is None


def test_a_stopped_job_kills_its_song() -> None:
    token = cli.CancelToken()
    bound = cli.current_token.set(token)
    try:
        assert song()
        token.cancel()
        with pytest.raises(cli.ToolFailed, match="cancelled"):
            song()
    finally:
        cli.current_token.reset(bound)
    assert demucs_warm._idle is None
    assert token.wait_idle(0), "the slot is not held after the song is stopped"


def test_it_is_recycled_after_its_songs(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(demucs_warm, "RECYCLE_SONGS", 2)
    assert song()
    assert kept_pid() is not None
    assert song()
    assert demucs_warm._idle is None


def test_tight_ram_gives_the_child_back(monkeypatch: pytest.MonkeyPatch) -> None:
    assert song()
    monkeypatch.setattr(demucs_warm, "_tight", lambda: True)
    demucs_warm.release(only_if_stale=True)
    assert demucs_warm._idle is None
    assert song()
    assert demucs_warm._idle is None, "not kept while RAM stays tight"


def test_an_idle_child_is_let_go_after_its_allowance(monkeypatch: pytest.MonkeyPatch) -> None:
    assert song()
    demucs_warm.release(only_if_stale=True)
    assert kept_pid() is not None, "still inside IDLE_SEC"
    monkeypatch.setattr(demucs_warm, "IDLE_SEC", 0.0)
    demucs_warm.release(only_if_stale=True)
    assert demucs_warm._idle is None


def test_torch_demucs_uses_the_warm_child_and_else_a_cold_one(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[list[str]] = []
    cold: list[list[str]] = []
    answer = [True]

    def warm(argv: list[str], **_: object) -> bool:
        sent.append(list(argv))
        return answer[0]

    def run(argv: list[str], **_: object) -> str:
        cold.append(list(argv))
        return ""

    monkeypatch.setattr(demucs_warm, "separate", warm)
    monkeypatch.setattr(sep, "run", run)
    demucs = sep.TorchDemucs(device="cpu", jobs=4, threads=32, warm=True)
    demucs.separate("/in/song.wav", "/out")
    assert sent[0][:2] == ["-n", "htdemucs"] and not cold, "demucs.separate's own argv, no interpreter"
    answer[0] = False
    demucs.separate("/in/song.wav", "/out")
    assert cold and cold[0][2] == "encore_worker.adapters.demucs_pool"
    sep.TorchDemucs(device="cuda", warm=True).separate("/in/song.wav", "/out")
    assert len(sent) == 2, "never warm off the CPU"


def test_the_warm_separator_picks_itself_and_can_be_set_by_hand() -> None:
    on = hardware.resolve_warm_separator(None, device="cpu", free_ram_gb=60.0, workers=4)
    assert on.count == 1 and "ENCORE_WARM_SEPARATOR=0" in on.why
    tight = hardware.resolve_warm_separator(None, device="cpu", free_ram_gb=6.0, workers=4)
    assert tight.count == 0 and "under 8" in tight.why
    assert hardware.resolve_warm_separator(None, device="cuda", free_ram_gb=60.0, workers=4).count == 0
    assert hardware.resolve_warm_separator(True, device="cuda", free_ram_gb=1.0, workers=4).count == 1
    assert hardware.resolve_warm_separator(False, device="cpu", free_ram_gb=60.0, workers=4).count == 0
    assert Config.from_env({"ENCORE_WARM_SEPARATOR": "0"}).warm_separator is False
    assert Config.from_env({}).warm_separator is None


def test_the_startup_lines_say_whether_it_is_kept() -> None:
    profile = hardware.resolve_profile(
        concurrency=None,
        threads=None,
        demucs_jobs=None,
        asr_compute=None,
        warmup=None,
        device="cpu",
        cores=32,
        ram_gb=124.0,
        free_ram_gb=60.0,
    )
    assert profile.warm_separator.count == 1
    assert profile.lines()[-1].startswith("warm separator on (auto on")
