"""Real make-karaoke pipeline: yt-dlp (fetch source) → Demucs htdemucs (split vocals) → instrumental.

The PURE half (argv builders, progress parsers, stem-path resolver, retryability classifier) has no
subprocess / torch and is fully unit-tested. The I/O half (DemucsProcessor) streams the two CLIs
through an INJECTABLE async runner, so the whole assign→complete flow tests with a fake subprocess —
the real binaries (multi-GB torch) only run on a worker box / GPU. Mirrors ytdlp.ts: pure
parseSearchJson split from the Bun.spawn backend.

Demucs `--two-stems=vocals` emits two files; the INSTRUMENTAL (backing track) is `no_vocals.wav`.
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
from collections import deque
from typing import AsyncIterator, Awaitable, Callable

from .processor import CompleteResult, JobSpec, ProgressEvent, instrumental_path

DEFAULT_MODEL = "htdemucs"

# ── pure helpers (no IO) ─────────────────────────────────────────────────────────


def is_local_source(source_uri: str) -> bool:
    """A local-library source is a file key/path; a YouTube source is an http(s) URL to download."""
    return not source_uri.startswith(("http://", "https://"))


def download_argv(source_uri: str, out_path: str, ytdlp_bin: str = "yt-dlp") -> list[str]:
    """yt-dlp argv: extract best audio to a wav at out_path (no playlist, quiet but progress on)."""
    return [
        ytdlp_bin,
        "--no-playlist",
        "--newline",  # emit progress as discrete lines (not \r) so the parser sees each update
        "-x",
        "--audio-format", "wav",
        "-o", out_path,
        source_uri,
    ]


def demucs_argv(input_path: str, out_dir: str, model: str = DEFAULT_MODEL, demucs_bin: str = "demucs") -> list[str]:
    """demucs argv: two-stem (vocals / no_vocals) separation. `--filename {stem}.{ext}` flattens the
    output to <out_dir>/<model>/<stem>.wav so the result path is deterministic regardless of input."""
    return [
        demucs_bin,
        "-n", model,
        "--two-stems", "vocals",
        "-o", out_dir,
        "--filename", "{stem}.{ext}",
        input_path,
    ]


def demucs_no_vocals_path(out_dir: str, model: str = DEFAULT_MODEL) -> str:
    """Where demucs writes the instrumental given the flattened `--filename {stem}.{ext}` template."""
    return os.path.join(out_dir, model, "no_vocals.wav")


_YTDLP_PCT = re.compile(r"\[download\]\s+([\d.]+)%")
_TQDM_PCT = re.compile(r"(\d+)%\|")  # demucs uses a tqdm bar: "  56%|████▏     | ..."


def parse_ytdlp_progress(line: str) -> int | None:
    """Extract the download percentage from a yt-dlp `[download] 45.2% of ...` line, else None."""
    m = _YTDLP_PCT.search(line)
    return int(float(m.group(1))) if m else None


def parse_demucs_progress(line: str) -> int | None:
    """Extract the separation percentage from a demucs tqdm progress line, else None."""
    m = _TQDM_PCT.search(line)
    return int(m.group(1)) if m else None


# Markers that mean a retry will NEVER succeed (source gone / unusable) → non-retryable.
_PERMANENT_MARKERS = (
    "video unavailable",
    "private video",
    "members-only",
    "removed",
    "404",
    "not found",
    "no such file",
    "unsupported url",
    "is not a valid url",
    "copyright",
)


def classify_retryable(stderr_text: str) -> bool:
    """True if the failure is worth retrying (transient); False for permanent source/format errors."""
    low = stderr_text.lower()
    return not any(m in low for m in _PERMANENT_MARKERS)


class ProcessError(RuntimeError):
    """A CLI exited non-zero. Carries a structured `.retryable` so the dial-home loop reports the
    right flag without re-parsing the message (it still falls back to a string heuristic if absent)."""

    def __init__(self, argv: list[str], returncode: int, output_tail: str) -> None:
        self.returncode = returncode
        self.output_tail = output_tail
        self.retryable = classify_retryable(output_tail)
        super().__init__(f"{argv[0]} exited {returncode}: {output_tail.strip()[-500:]}")


# ── IO: injectable subprocess runner ──────────────────────────────────────────────
# A runner streams a command's merged stdout/stderr line-by-line and raises ProcessError on a
# non-zero exit. Injecting it lets tests drive DemucsProcessor with canned output + no real binary.
Runner = Callable[[list[str]], AsyncIterator[str]]


async def _iter_lines(stream: asyncio.StreamReader) -> AsyncIterator[str]:
    """Yield lines split on BOTH \\n and \\r (tqdm/yt-dlp redraw progress with carriage returns)."""
    buf = b""
    while True:
        chunk = await stream.read(256)
        if not chunk:
            break
        buf += chunk
        parts = re.split(rb"[\r\n]", buf)
        buf = parts.pop()  # keep the trailing partial line
        for p in parts:
            if p.strip():
                yield p.decode("utf-8", "replace")
    if buf.strip():
        yield buf.decode("utf-8", "replace")


async def subprocess_runner(argv: list[str]) -> AsyncIterator[str]:
    """Real runner: spawn the CLI, stream merged output, raise ProcessError on non-zero exit."""
    proc = await asyncio.create_subprocess_exec(
        *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT
    )
    assert proc.stdout is not None
    tail: deque[str] = deque(maxlen=30)
    async for line in _iter_lines(proc.stdout):
        tail.append(line)
        yield line
    rc = await proc.wait()
    if rc != 0:
        raise ProcessError(argv, rc, "\n".join(tail))


# ── the processor ──────────────────────────────────────────────────────────────────
class DemucsProcessor:
    """Production processor (M7-C5). For a `stems` job: fetch the source audio (yt-dlp, unless the
    source is already a local file), run Demucs htdemucs two-stem separation, and move the resulting
    `no_vocals.wav` to the deterministic MediaStore instrumental path. Emits per-stage progress
    (downloading → separating) for the live phone bar. Same async-generator interface as
    StubProcessor, so dial_home.py is unchanged."""

    def __init__(
        self,
        *,
        model: str = DEFAULT_MODEL,
        runner: Runner = subprocess_runner,
        ytdlp_bin: str = "yt-dlp",
        demucs_bin: str = "demucs",
        mover: Callable[[str, str], None] = shutil.move,
    ) -> None:
        self._model = model
        self._runner = runner
        self._ytdlp_bin = ytdlp_bin
        self._demucs_bin = demucs_bin
        self._move = mover

    async def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        work = os.path.join(job.media_dir, "stems", "_work", job.media_id)
        os.makedirs(work, exist_ok=True)

        # ── stage 1: obtain the source audio ──────────────────────────────────────
        if is_local_source(job.source_uri):
            input_path = job.source_uri if os.path.isabs(job.source_uri) else os.path.join(job.media_dir, job.source_uri)
        else:
            input_path = os.path.join(work, "source.wav")
            async for ev in self._run_stage("downloading", download_argv(job.source_uri, input_path, self._ytdlp_bin), parse_ytdlp_progress):
                yield ev

        # ── stage 2: separate vocals (Demucs htdemucs) ────────────────────────────
        sep_out = os.path.join(work, "separated")
        async for ev in self._run_stage("separating", demucs_argv(input_path, sep_out, self._model, self._demucs_bin), parse_demucs_progress):
            yield ev

        # ── stage 3: publish the instrumental to the MediaStore ───────────────────
        produced = demucs_no_vocals_path(sep_out, self._model)
        if not os.path.exists(produced):
            raise RuntimeError(f"demucs produced no instrumental at {produced}")
        final = instrumental_path(job.media_dir, job.media_id)
        os.makedirs(os.path.dirname(final), exist_ok=True)
        self._move(produced, final)
        yield CompleteResult(media_uri=final, artifacts={"stems": {"instrumental": final}})

    async def _run_stage(
        self, stage: str, argv: list[str], parse: Callable[[str], int | None]
    ) -> AsyncIterator[ProgressEvent]:
        """Run one CLI, translating its progress lines into deduped per-stage ProgressEvents."""
        yield ProgressEvent(stage=stage, pct=0)
        last = -1
        async for line in self._runner(argv):
            pct = parse(line)
            if pct is not None and pct != last:
                last = pct
                yield ProgressEvent(stage=stage, pct=pct)
        if last < 100:
            yield ProgressEvent(stage=stage, pct=100)  # stage finished cleanly
