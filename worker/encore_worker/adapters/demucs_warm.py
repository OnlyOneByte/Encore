"""The warm separator: one `demucs_pool --serve` child kept loaded between songs on a CPU box (#1357).

It pays a cold separation's start-up (process, model, `-j` pool workers) once. At most ONE is kept, only while
nobody is using it: a job that finds it busy runs today's cold child. It is retired after `RECYCLE_SONGS`
songs, `IDLE_SEC` unused, a failure, stop or stall, a different model/`-j`/threads, or tight free RAM. Each
song keeps `cli.run`'s cancel, idle and deadline rules. docs/arch/05-worker.md §9.3 has the measurements.
"""

from __future__ import annotations

import atexit
import contextlib
import json
import os
import subprocess
import sys
import threading
import time
from collections.abc import Mapping, Sequence

from encore_worker.adapters import cli
from encore_worker.adapters.demucs_pool import DONE
from encore_worker.adapters.ports import ProgressSink
from encore_worker.host import hardware

#: Songs one child separates before it is replaced, so a slow leak never outlives an evening.
RECYCLE_SONGS = 20
#: How long an unused child keeps its RAM before it is let go.
IDLE_SEC = 600.0
#: How often an idle child is checked for `IDLE_SEC` and for memory pressure.
_SWEEP_SEC = 30.0
#: The child. A list so a test can stand a fake in for demucs.
SERVE_ARGV = [sys.executable, "-m", "encore_worker.adapters.demucs_pool", "--serve"]


def _tight() -> bool:
    """Is free RAM under what the boot warm-up needs? Then a warm separator gives its memory back."""
    free = hardware.memory_gb()[1]
    return free is not None and free < hardware.WARMUP_MIN_FREE_RAM_GB


class _Child:
    """One `--serve` process, in its own process group like every `cli.run` child."""

    def __init__(self, key: tuple[str, ...], env: Mapping[str, str]) -> None:
        self.key = key
        self.songs = 0
        self.used = time.monotonic()
        self.proc = subprocess.Popen(  # noqa: S603 - a fixed argv
            list(SERVE_ARGV),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            start_new_session=True,
            env={**os.environ, **env},
        )

    def close(self) -> None:
        cli._kill_group(self.proc)
        with contextlib.suppress(Exception):
            self.proc.wait(timeout=cli._GROUP_GONE_SEC)
        cli._await_group_gone(self.proc.pid)

    def separate(
        self, argv: Sequence[str], *, on_progress: ProgressSink | None, idle_sec: float, timeout_sec: float
    ) -> None:
        """Run one song to its `DONE` line. Raises as `cli.run` does; the caller then retires the child."""
        stdin, stream = self.proc.stdin, self.proc.stdout
        if stdin is None or stream is None:  # pragma: no cover - unreachable with PIPE
            raise cli.ToolFailed(argv, -1, "no pipes")
        token = cli.current_token.get()
        if token is not None and token.cancelled:
            raise cli.ToolFailed(argv, -1, "cancelled")
        lines: list[str] = []
        done = threading.Event()
        why: list[str] = []
        heard = [time.monotonic()]
        result: list[dict[str, object]] = []

        def watch() -> None:
            deadline = time.monotonic() + timeout_sec
            while not done.wait(cli._WATCH_SEC):
                now = time.monotonic()
                if token is not None and token.cancelled:
                    why.append("cancelled")
                elif now >= deadline:
                    why.append(f"timed out after {timeout_sec:.0f}s")
                elif now - heard[0] >= idle_sec:
                    why.append(f"stalled: no output for {idle_sec:.0f}s")
                else:
                    continue
                cli._kill_group(self.proc)
                return

        def read() -> None:
            for line in stream:
                heard[0] = time.monotonic()
                if line.startswith(DONE):
                    result.append(json.loads(line[len(DONE) :]))
                    return
                lines.append(line)
                if on_progress is not None and not why and (pct := cli.parse_pct(line)) is not None:
                    on_progress(pct)

        watchdog = threading.Thread(target=watch, name="watch-warm-demucs", daemon=True)
        reader = threading.Thread(target=read, name="read-warm-demucs", daemon=True)
        if token is not None:
            token._started()
        try:
            stdin.write(json.dumps({"argv": list(argv)}) + "\n")
            stdin.flush()
            watchdog.start()
            reader.start()
            reader.join()
        finally:
            done.set()
            if watchdog.ident is not None:
                watchdog.join()
            if token is not None:
                token._ended()
        if why:
            raise (cli.Stalled if why[0].startswith("stalled") else cli.ToolFailed)(argv, -1, why[0])
        output = "".join(lines)
        if not result:  # the child died mid-song
            if cli.looks_like_oom(output):
                raise cli.OutOfMemory("demucs ran out of memory. Try a box with more memory or a smaller -j.")
            raise cli.ToolFailed(argv, self.proc.poll() or -1, output)
        if not result[0].get("ok"):
            raise cli.ToolFailed(argv, 1, f"{output}{result[0].get('why', '')}")


_lock = threading.Lock()
#: The child kept warm while nobody is using it, and whether one is out with a job right now.
_idle: _Child | None = None
_out = False
_sweeper: threading.Thread | None = None


def separate(
    argv: Sequence[str],
    *,
    key: tuple[str, ...],
    env: Mapping[str, str],
    on_progress: ProgressSink | None,
    idle_sec: float,
    timeout_sec: float = 3600.0,
) -> bool:
    """Separate one song on the warm child (`argv` is `demucs.separate`'s), starting one if none fits.

    False, with nothing run, when the warm child is out with another job: the caller runs the cold path.
    """
    global _idle, _out
    with _lock:
        if _out:
            return False
        _out = True
        child, _idle = _idle, None
    try:
        if child is not None and (child.key != key or child.proc.poll() is not None or _tight()):
            child.close()
            child = None
        if child is None:
            child = _Child(key, env)
        try:
            child.separate(argv, on_progress=on_progress, idle_sec=idle_sec, timeout_sec=timeout_sec)
        except BaseException:
            child.close()
            raise
        child.songs += 1
        child.used = time.monotonic()
        if child.songs >= RECYCLE_SONGS or _tight():
            child.close()
        else:
            with _lock:
                _idle = child
            _start_sweeper()
        return True
    finally:
        with _lock:
            _out = False


def _start_sweeper() -> None:
    global _sweeper
    with _lock:
        if _sweeper is not None:
            return
        _sweeper = threading.Thread(target=_sweep, name="warm-demucs-sweep", daemon=True)
    _sweeper.start()


def _sweep() -> None:
    while True:
        time.sleep(_SWEEP_SEC)
        release(only_if_stale=True)


def release(*, only_if_stale: bool = False) -> None:
    """Let the idle child go: always, or (`only_if_stale`) when it has sat `IDLE_SEC` or RAM is tight."""
    global _idle
    with _lock:
        child = _idle
        if child is None or (only_if_stale and time.monotonic() - child.used < IDLE_SEC and not _tight()):
            return
        _idle = None
    child.close()


atexit.register(release)
