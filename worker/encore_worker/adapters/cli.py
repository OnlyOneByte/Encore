"""The subprocess-backed adapters: yt-dlp for audio and captions, ffmpeg/ffprobe for measurement.

ARGV IS BUILT PURELY, then run, so the exact command line is assertable in a unit test — the only way to check
a flag that only matters on a real download. NOTHING HERE IMPORTS torch, whisperx OR ANY MODEL, which is why
fetch-only workers are possible. The caption parser's rules are docs/arch/05-worker.md §6.1.
"""

from __future__ import annotations

import contextlib
import glob
import os
import re
import signal
import subprocess
import threading
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from encore_worker.adapters.ports import InfraFault, ProgressSink
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics.clean import clean_segments

#: yt-dlp writes progress as a percentage; this is the only shape worth parsing out of its output.
_PCT = re.compile(r"\[download\]\s+(\d{1,3})(?:\.\d+)?%")

#: `ffmpeg -i` reports duration on stderr in this shape. ffprobe is cleaner but is a second binary.
_DURATION = re.compile(r"Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)")

#: `-af volumedetect` summary. The number that decides whether an instrumental is digital silence.
_MAX_VOLUME = re.compile(r"max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB")


class ToolFailed(RuntimeError):
    """A subprocess exited non-zero. Carries its output, because the message is the diagnosis."""

    def __init__(self, argv: Sequence[str], code: int, output: str) -> None:
        super().__init__(f"{argv[0]} exited {code}: {output.strip()[-400:]}")
        self.argv = tuple(argv)
        self.code = code
        self.output = output

    def __reduce__(self) -> tuple[type[ToolFailed], tuple[tuple[str, ...], int, str]]:
        # DBOS pickles a workflow's exception. The default reduce replays `__init__` with `self.args` — the
        # one formatted message — so unpickling raised a TypeError that replaced the diagnosis it carried.
        return (type(self), (self.argv, self.code, self.output))


#: Substrings every accelerator uses to say "not enough memory", matched case-insensitively against a failed
#: command's combined output. Why these exist rather than a VRAM gate: docs/arch/05-worker.md §2.1.
OOM_MARKERS = (
    "out of memory",
    "outofmemoryerror",
    "cuda error: out of memory",
    "mps backend out of memory",
    "hip out of memory",
    "failed to allocate",
    "cannot allocate memory",
    "killed",  # the OOM killer, which leaves no message of its own
)


class OutOfMemory(InfraFault):
    """A model needed more memory than this box has.

    NOT retryable: the same model on the same audio on the same box exhausts the same memory every time, and
    it is recoverable only by CHANGING something, which is a person's decision. An `InfraFault`, so an
    alignment step lets it through rather than declining one attempt over it.
    """

    retryable = False


def looks_like_oom(output: str) -> bool:
    """Did this failure run out of memory? Read off the command's own output, a subprocess being unable to
    raise a typed exception across the boundary."""
    low = output.lower()
    return any(marker in low for marker in OOM_MARKERS)


class CancelToken:
    """One job's stop signal, and a count of the children it still has alive.

    The count is what lets the transport keep a cancelled job's slot until its work has REALLY stopped: an
    `asyncio` cancel ends the awaiting coroutine at once, while the child it was waiting on keeps running in
    its thread (WK-02).
    """

    def __init__(self) -> None:
        self._stop = threading.Event()
        self._live = 0
        self._idle = threading.Condition()

    def cancel(self) -> None:
        self._stop.set()

    @property
    def cancelled(self) -> bool:
        return self._stop.is_set()

    def wait_idle(self, timeout_sec: float | None) -> bool:
        """Block until no child of this job is alive (None: however long). False if one still is."""
        with self._idle:
            return self._idle.wait_for(lambda: self._live == 0, timeout_sec)

    @contextlib.contextmanager
    def busy(self) -> Iterator[None]:
        """Count work that is not a `run` child (an in-process separator) as alive, so its slot is held too.
        Entered in the WORKER THREAD, never around the `await`: a cancelled await would leave it at once."""
        self._started()
        try:
            yield
        finally:
            self._ended()

    def _started(self) -> None:
        with self._idle:
            self._live += 1

    def _ended(self) -> None:
        with self._idle:
            self._live -= 1
            self._idle.notify_all()


def in_job[T](fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    """Call `fn` counted on the running job's token. For `asyncio.to_thread(in_job, port.method, …)`."""
    token = current_token.get()
    if token is None:
        return fn(*args, **kwargs)
    with token.busy():
        return fn(*args, **kwargs)


class Stalled(ToolFailed):
    """A tool printed nothing for its whole idle allowance: hung, not slow.

    NOT retryable. The same source stalls the same way on the next attempt, and three attempts of a hung
    download were three hours of "Making karaoke…" before the room was told; this way it is about a minute.
    """

    retryable = False


#: The running job's token. A context variable rather than a parameter on every adapter, because
#: `asyncio.to_thread` carries the caller's context into its thread: the job sets it once and every `run`
#: under it, however deep, can be stopped.
current_token: ContextVar[CancelToken | None] = ContextVar("encore_cancel_token", default=None)

#: Every running job's token, by job id: set by the transport's job runner, read back by `bind` and `_stop`.
tokens: dict[str, CancelToken] = {}


def bind(job_id: str) -> None:
    """Make job `job_id`'s token the current one, on whichever loop and context this runs."""
    current_token.set(tokens.get(job_id))


#: How often the watchdog looks at the deadline and the token. Bounds how late a kill can land.
_WATCH_SEC = 0.5


def run(
    argv: Sequence[str],
    *,
    on_progress: ProgressSink | None = None,
    timeout_sec: float = 3600.0,
    idle_sec: float | None = None,
    cancel: CancelToken | None = None,
) -> str:
    """Run a command to completion, returning its combined output.

    SYNCHRONOUS on purpose, every caller already being inside `asyncio.to_thread`. The child gets its own
    process group, so a kill takes the whole tree. The deadline, the token and `idle_sec` (no output for
    that long: `Stalled`) are a WATCHDOG thread's to enforce, because reading output blocks (WK-03).
    """
    token = cancel if cancel is not None else current_token.get()
    if token is not None and token.cancelled:
        # A DBOS step retry, or the next step of a job already stopped: nothing to start.
        raise ToolFailed(argv, -1, "cancelled")
    lines: list[str] = []
    proc = subprocess.Popen(  # noqa: S603 - argv is built by the pure builders above, never a shell string
        list(argv),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    if token is not None:
        token._started()
    done = threading.Event()
    why: list[str] = []  # set by the watchdog before it kills, read after the child is reaped
    heard = [time.monotonic()]  # when the child last printed a line; written by the reader below

    def watch() -> None:
        deadline = time.monotonic() + timeout_sec
        while not done.wait(_WATCH_SEC):
            now = time.monotonic()
            if token is not None and token.cancelled:
                why.append("cancelled")
            elif now >= deadline:
                why.append(f"timed out after {timeout_sec:.0f}s")
            elif idle_sec is not None and now - heard[0] >= idle_sec:
                why.append(f"stalled: no output for {idle_sec:.0f}s")
            else:
                continue
            _kill_group(proc)
            return

    # `stdout=PIPE` above guarantees this; narrowed without an `assert`, which `-O` would strip.
    stream = proc.stdout
    if stream is None:  # pragma: no cover - unreachable with stdout=PIPE
        raise ToolFailed(argv, -1, "no stdout pipe")
    failed: list[BaseException] = []  # what the reader raised (a progress sink's fault), re-raised here

    def read() -> None:
        try:
            for line in stream:
                heard[0] = time.monotonic()
                lines.append(line)
                # A killed run reports nothing more, even from a descendant that outlives it: its job is over.
                if on_progress is not None and not why:
                    pct = parse_pct(line)
                    if pct is not None:
                        on_progress(pct)
        except BaseException as exc:  # noqa: BLE001 - handed to the calling thread below
            failed.append(exc)
            why.append("raised")  # a kill like the watchdog's, so the slot waits for the group below
            _kill_group(proc)

    watchdog = threading.Thread(target=watch, name=f"watch-{os.path.basename(argv[0])}", daemon=True)
    reader = threading.Thread(target=read, name=f"read-{os.path.basename(argv[0])}", daemon=True)
    watchdog.start()
    reader.start()
    try:
        code = proc.wait()
        # Drain every line before returning: the last ones carry the final figure and ffmpeg's report. A kill,
        # before the child exited or after, ends that wait at the group grace: a descendant that left the
        # group with stdout open (`setsid`) would otherwise hold the read, and the slot, until it chose to go.
        while reader.is_alive() and not why:
            reader.join(_WATCH_SEC)
        reader.join(_GROUP_GONE_SEC)
    except BaseException:
        _kill_group(proc)
        proc.wait()
        why.append("raised")
        raise
    finally:
        done.set()
        watchdog.join()
        if why:
            # Reaping the child is not the group being gone: its own children die a moment later, and the slot
            # this count holds must outlast them.
            _await_group_gone(proc.pid)
        if token is not None:
            token._ended()
    if failed:
        raise failed[0]
    if why:
        raise (Stalled if why[0].startswith("stalled") else ToolFailed)(argv, -1, why[0])
    output = "".join(lines)
    if code != 0:
        if looks_like_oom(output):
            # Raised INSTEAD of ToolFailed, so the non-retryable classification survives the boundary.
            raise OutOfMemory(
                f"{argv[0]} ran out of memory. This model needs more than this box has — try a smaller "
                f"model, or a box with more memory. Exit {code}."
            )
        raise ToolFailed(argv, code, output)
    return output


def _kill_group(proc: subprocess.Popen[str]) -> None:
    """SIGKILL the child's whole process group. Already gone is fine: it is the outcome wanted."""
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(proc.pid, signal.SIGKILL)


#: The longest a killed group's stragglers are waited for. They die in milliseconds; this only bounds a box
#: where the group cannot be inspected.
_GROUP_GONE_SEC = 2.0


def _await_group_gone(pgid: int) -> None:
    """Block until no LIVE process of group `pgid` is left, or `_GROUP_GONE_SEC` has passed."""
    deadline = time.monotonic() + _GROUP_GONE_SEC
    while time.monotonic() < deadline and _group_alive(pgid):
        time.sleep(0.02)


def _group_alive(pgid: int) -> bool:
    """Does group `pgid` have a member that is not a zombie? On Linux, read off /proc, because a zombie stays
    a member until it is reaped, and a container whose PID 1 reaps nothing (the worker image) never does.
    Elsewhere, any member at all counts."""
    if not os.path.isdir("/proc/self"):
        try:
            os.killpg(pgid, 0)
        except (ProcessLookupError, PermissionError):
            return False
        return True
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat") as stat:
                # `pid (comm) state ppid pgrp …`; comm may hold spaces, so split after its closing paren.
                fields = stat.read().rsplit(")", 1)[1].split()
        except OSError:
            continue
        if int(fields[2]) == pgid and fields[0] != "Z":
            return True
    return False


def parse_pct(line: str) -> int | None:
    """A 0..100 percentage from a yt-dlp progress line, or None. Clamped, never trusted blindly."""
    found = _PCT.search(line)
    if found is None:
        return None
    return max(0, min(100, int(found.group(1))))


# ── argv builders (pure) ─────────────────────────────────────────────────────────────────────────


#: yt-dlp's own per-socket read timeout: a dead connection errors out rather than waiting forever.
YTDLP_SOCKET_TIMEOUT_SEC = 30

#: yt-dlp prints a progress line many times a second, so this long without one is a hang (`Stalled`).
YTDLP_IDLE_SEC = 60.0


def audio_argv(source_uri: str, out_dir: str, ytdlp_bin: str = "yt-dlp") -> list[str]:
    """Download the best audio-only stream as a single file.

    `--no-playlist` is load-bearing: a YouTube url carrying a list parameter otherwise downloads the
    whole list, which is how one song became two hundred. `-f bestaudio` avoids muxing a video stream we
    would immediately discard.
    """
    return [
        ytdlp_bin,
        "--no-playlist",
        "--socket-timeout",
        str(YTDLP_SOCKET_TIMEOUT_SEC),
        # Newline-delimited progress, so `run` can parse a percentage out of it line by line — and so a
        # silence of `YTDLP_IDLE_SEC` means a hang rather than a long line.
        "--newline",
        "-f",
        "bestaudio/best",
        "-o",
        os.path.join(out_dir, "original.%(ext)s"),
        source_uri,
    ]


def caption_argv(
    source_uri: str, out_template: str, ytdlp_bin: str = "yt-dlp", *, automatic: bool
) -> list[str]:
    """Fetch ONE kind of caption track and nothing else.

    `--skip-download` matters: without it this re-downloads the audio for every caption tier, tripling
    the bandwidth of an align job. The authored and automatic tracks are requested separately because
    they mean different things — one is a claim about the words, the other is evidence of what is
    audible — and a single call that returns "whichever exists" cannot tell them apart.
    """
    return [
        ytdlp_bin,
        "--no-playlist",
        "--socket-timeout",
        str(YTDLP_SOCKET_TIMEOUT_SEC),
        "--skip-download",
        "--write-auto-subs" if automatic else "--write-subs",
        "--sub-langs",
        "en.*,en",
        "--sub-format",
        "vtt/srt/best",
        "-o",
        out_template,
        source_uri,
    ]


def duration_argv(path: str, ffmpeg_bin: str = "ffmpeg") -> list[str]:
    """Ask ffmpeg to describe the file. Exits non-zero by design — there is no output to produce."""
    return [ffmpeg_bin, "-hide_banner", "-i", path]


def volume_argv(path: str, ffmpeg_bin: str = "ffmpeg") -> list[str]:
    """Measure peak level without writing anything. `-f null -` discards the decoded stream."""
    return [ffmpeg_bin, "-hide_banner", "-i", path, "-af", "volumedetect", "-f", "null", "-"]


def parse_duration(output: str) -> float:
    """Seconds from ffmpeg's `Duration:` line, or 0.0 when it said nothing.

    Zero means UNKNOWN, and every consumer treats it that way rather than as a zero-length song — see
    `measure.measure`, which reports no coverage rather than guessing when the duration is not positive.
    """
    found = _DURATION.search(output)
    if found is None:
        return 0.0
    hours, minutes, seconds = found.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def parse_max_volume(output: str) -> float | None:
    """Peak dBFS from volumedetect, or None when ffmpeg said nothing parseable.

    NONE IS NOT 0.0, and the asymmetry with `parse_duration` is deliberate rather than inconsistent:
    0.0 seconds is not a duration any recording has, so it can serve as a sentinel for "unknown". 0.0
    dBFS is a REAL peak — full scale, the loudest a sample can be — so using it for "unmeasured" makes a
    measurement failure read as the loudest possible signal. That is the exact shape of a silence guard
    that passes everything: the one reading that must never be faked is the one that means "safe".
    """
    found = _MAX_VOLUME.search(output)
    if found is None:
        return None
    return float(found.group(1))


# ── adapters ─────────────────────────────────────────────────────────────────────────────────────


class YtDlpAudio:
    """`AudioFetcher` over yt-dlp."""

    def __init__(self, ytdlp_bin: str = "yt-dlp") -> None:
        self._bin = ytdlp_bin

    def fetch(self, source_uri: str, out_dir: str, *, on_progress: ProgressSink | None = None) -> str:
        run(audio_argv(source_uri, out_dir, self._bin), on_progress=on_progress, idle_sec=YTDLP_IDLE_SEC)
        found = sorted(glob.glob(os.path.join(out_dir, "original.*")))
        if not found:
            raise ToolFailed([self._bin], 0, f"yt-dlp reported success but wrote nothing into {out_dir}")
        return found[0]


class YtDlpCaptions:
    """`CaptionSource` over yt-dlp. A missing track is a miss, not an error."""

    def __init__(self, ytdlp_bin: str = "yt-dlp") -> None:
        self._bin = ytdlp_bin

    def fetch(self, source_uri: str, out_dir: str, *, automatic: bool) -> Sequence[Segment]:
        template = os.path.join(out_dir, "captions.%(ext)s")
        try:
            run(caption_argv(source_uri, template, self._bin, automatic=automatic), idle_sec=YTDLP_IDLE_SEC)
        except ToolFailed:
            return ()  # a video with no track of this kind is the common case
        path = find_caption_file(out_dir)
        if path is None:
            return ()
        with open(path, encoding="utf-8", errors="replace") as handle:
            return parse_vtt(handle.read())


def find_caption_file(out_dir: str) -> str | None:
    """The caption file yt-dlp wrote, preferring vtt. Deterministic, so a retry reads the same bytes."""
    for ext in ("vtt", "srt"):
        found = sorted(glob.glob(os.path.join(out_dir, f"*.{ext}")))
        if found:
            return found[0]
    return None


def parse_vtt(text: str) -> tuple[Segment, ...]:
    """Cues from a WebVTT or SRT body, with YouTube's ROLLING auto-caption shape handled.

    One parser for both formats, body lines joined with SPACES, and four rules for a roll-up — each of them a
    defect the parser this replaced had: docs/arch/05-worker.md §6.1, with the counts in README, "Caption
    cues: the two populations a duration floor separates".
    """
    blocks: list[tuple[tuple[float, float], list[str]]] = []
    open_at: tuple[float, float] | None = None
    body: list[str] = []

    def close() -> None:
        nonlocal open_at, body
        if open_at is not None:
            blocks.append((open_at, [line for line in body if line.strip()]))
        open_at, body = None, []

    # NO `.strip()` ON THE LINE ITSELF: a line of one space is cue payload (docs/arch/05-worker.md §6.1).
    for raw in text.replace("\r\n", "\n").split("\n"):
        line = raw.lstrip("﻿").rstrip("\r")
        found = _TIMESTAMP.search(line)
        if found is not None:
            close()
            open_at = (_secs(*found.groups()[:4]), _secs(*found.groups()[4:]))
            continue
        if not line:
            close()
            continue
        if open_at is not None:
            body.append(line)
    close()

    # RULE 3's VERDICT IS READ OVER THE WHOLE TRACK BEFORE ANY CUE IS BUILT (`_track_roll`), because that is
    # what it is a fact about (docs/arch/05-worker.md §6.1).
    rolling = _track_roll(blocks).certain
    cues: list[dict[str, object]] = []
    for span, lines in blocks:
        cue = _cue_of(span, lines, previous=cues[-1] if cues else None, rolling=rolling)
        if cue is not None:
            cues.append(cue)
    # CAPTION FORMAT IS NOT LYRIC, and published unfiltered it was drawn on the television as words to sing
    # (docs/arch/05-worker.md §6.1; docs/arch/04-alignment.md §8 for what is deliberately kept).
    return clean_segments(cues)


_TIMESTAMP = re.compile(r"(\d{1,2}):(\d\d):(\d\d)[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d\d):(\d\d)[.,](\d{1,3})")

#: An inline per-word onset in a roll-up track: `we're<00:00:19.039><c> no</c>`. The tag PRECEDES the word
#: it times, and the cue's own start times the first.
_INLINE_ONSET = re.compile(r"<(\d{1,2}):(\d\d):(\d\d)[.,](\d{1,3})>")

#: Markup inside a cue line, removed only for the word split and the carry comparison: the published text
#: keeps it until `clean_line` decides what is format.
_TAG_SPAN = re.compile(r"</?[a-zA-Z][^<>]*>")

#: Seconds below which a cue is a roll-up MARKER rather than a caption: placed in the EMPTY band the two
#: populations leave, 10 ms markers against 1.15 s captions. NOT a frame count — it is 2.5 of `adapters/ml`'s
#: 20 ms hops (README, "Caption cues: the two populations a duration floor separates").
MIN_CUE_SEC = 0.05

#: How many cues must overlap their predecessor before OVERLAP ALONE proves a roll-up. One pair is not a
#: convention and latching on it deleted a repeated line (docs/arch/05-worker.md §6.1; README, "Caption cues:
#: the two populations a duration floor separates", for the 16-track census).
_ROLLING_OVERLAPS = 2


@dataclass(frozen=True, slots=True)
class _Roll:
    """A track's accumulated roll-up evidence, rule 3's precondition.

    A record and not a bool because the two signals are of unequal strength: a tag PROVES the track tags its
    words, where an overlap has to REPEAT before it proves anything (`_ROLLING_OVERLAPS`).
    """

    tagged: bool = False
    overlaps: int = 0

    @property
    def certain(self) -> bool:
        """Is the track a roll-up, so rule 3's carry removal applies to every cue of it?"""
        return self.tagged or self.overlaps >= _ROLLING_OVERLAPS


def _cue_of(
    span: tuple[float, float],
    body: Sequence[str],
    previous: Mapping[str, object] | None,
    *,
    rolling: bool,
) -> dict[str, object] | None:
    """One cue, or None when it carries no words, is a roll-up marker, or is all carried-over text.

    `previous` is the last cue this parse KEPT and `rolling` is the WHOLE TRACK's verdict, decided before the
    first cue is built; both choices are docs/arch/05-worker.md §6.1.
    """
    start, end = span
    if end - start < MIN_CUE_SEC:
        return None
    lines = [line for line in body if line.strip()]
    if not lines:
        return None  # a timestamp and no words is a positioning or style cue, not a lyric
    lines = _rolled(lines, previous, rolling=rolling)
    if not lines:
        return None
    text = " ".join(lines).strip()
    if not text:
        return None
    cue: dict[str, object] = {"start": start, "end": end, "text": text}
    words = _inline_words(lines, start, end)
    if words:
        cue["words"] = words
    return cue


def _track_roll(blocks: Sequence[tuple[tuple[float, float], Sequence[str]]]) -> _Roll:
    """The whole track's roll-up evidence: a tag, which is proof on its own, and overlaps, which are COUNTED.

    ADJACENCY IS NOT OVERLAP, and a marker or positioning cue is not evidence either
    (docs/arch/05-worker.md §6.1).
    """
    tagged = False
    overlaps = 0
    previous_end: float | None = None
    for (start, end), lines in blocks:
        if end - start < MIN_CUE_SEC or not lines:
            continue
        if any(_INLINE_ONSET.search(line) for line in lines):
            tagged = True
        if previous_end is not None and start < previous_end:
            overlaps += 1
        previous_end = end
    return _Roll(tagged=tagged, overlaps=overlaps)


def _rolled(lines: Sequence[str], previous: Mapping[str, object] | None, *, rolling: bool) -> list[str]:
    """Rule 3: the roll-up's carried-over leading lines removed, or `lines` unchanged.

    The carry is TEXT IDENTITY against what the previous cue published, and identity alone is not enough — the
    track must be a roll-up first (`rolling`), or an ordinary repeated line is deleted from the served text.
    docs/arch/05-worker.md §6.1.
    """
    if previous is None or len(lines) < 2 or not rolling:
        return list(lines)
    carried = _plain(str(previous.get("text") or ""))
    if not carried:
        return list(lines)
    kept = list(lines)
    while len(kept) > 1 and _plain(kept[0]) and carried.endswith(_plain(kept[0])):
        kept.pop(0)
    return kept


def _plain(line: str) -> str:
    """A cue line with its inline onsets and tags removed, whitespace collapsed — for comparison only."""
    return re.sub(r"\s+", " ", _INLINE_ONSET.sub("", _TAG_SPAN.sub("", line))).strip()


def _inline_words(lines: Sequence[str], start: float, end: float) -> tuple[Segment, ...]:
    """Rule 4: `<hh:mm:ss.mmm>`-tagged words as word claims, or empty when the cue carries no tags.

    EVERY WORD GETS A SPAN, and A TAG TIMES A RUN rather than always one word, so the run is APPORTIONED by
    character count; a cue is refused whole only when it carries NO tag at all. docs/arch/05-worker.md §6.1.
    """
    runs: list[tuple[float, list[str]]] = []
    tagged = False
    for line in lines:
        for at, piece in _onset_runs(line):
            if at is not None:
                tagged = True
            tokens = _TAG_SPAN.sub(" ", piece).split()
            if not tokens:
                continue
            if at is None:
                # The run no tag opens: the cue's own start on its first line, and the run the line before
                # left open on a later one (docs/arch/05-worker.md §6.1).
                if runs:
                    runs[-1][1].extend(tokens)
                    continue
                at = start
            runs.append((at, tokens))
    if not tagged or not runs:
        return ()
    out: list[Segment] = []
    for index, (at, tokens) in enumerate(runs):
        closes = runs[index + 1][0] if index + 1 < len(runs) else end
        out.extend(_apportioned(tokens, at, max(at, closes)))
    return tuple(out)


def _apportioned(tokens: Sequence[str], low: float, high: float) -> list[Segment]:
    """`tokens` across `[low, high]` BY CHARACTER COUNT — one claim each, and no zero-width span unless the
    room itself is zero, which no clock could separate either."""
    room = max(0.0, high - low)
    total = sum(len(token) for token in tokens) or 1
    out: list[Segment] = []
    at = low
    for position, token in enumerate(tokens):
        closes = high if position == len(tokens) - 1 else at + room * (len(token) / total)
        out.append({"word": token, "start": at, "end": max(at, closes)})
        at = max(at, closes)
    return out


def _onset_runs(line: str) -> list[tuple[float | None, str]]:
    """The line as `(onset of what follows, text)` runs. The first run's onset is None (the cue's own)."""
    out: list[tuple[float | None, str]] = []
    at: float | None = None
    pos = 0
    for found in _INLINE_ONSET.finditer(line):
        out.append((at, line[pos : found.start()]))
        at = _secs(*found.groups())
        pos = found.end()
    out.append((at, line[pos:]))
    return out


def _secs(hours: str, minutes: str, seconds: str, millis: str) -> float:
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(millis.ljust(3, "0")) / 1000.0


class FfmpegProbe:
    """`AudioProbe` over ffmpeg. Never raises for an unmeasurable file — 0.0 means unknown."""

    def __init__(self, ffmpeg_bin: str = "ffmpeg") -> None:
        self._bin = ffmpeg_bin

    def duration_sec(self, audio_path: str) -> float:
        try:
            # `-i` with no output makes ffmpeg exit non-zero after printing what we want.
            return parse_duration(run(duration_argv(audio_path, self._bin), timeout_sec=60.0))
        except ToolFailed as failed:
            return parse_duration(failed.output)

    def peak_dbfs(self, audio_path: str) -> float | None:
        """Peak level, or None when it could not be measured at all.

        A `ToolFailed` is still worth parsing: ffmpeg exits non-zero after printing the summary for some
        inputs, so the number is often present in the output of a "failed" run.
        """
        try:
            return parse_max_volume(run(volume_argv(audio_path, self._bin), timeout_sec=600.0))
        except ToolFailed as failed:
            return parse_max_volume(failed.output)
