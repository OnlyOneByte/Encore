"""Demucs: the argv, the progress parsing, and the stem paths its CLI produces.

PURE, and entirely so since S3 — argv builders, progress parsers, stem-path resolvers, the retryability
classifier and the subprocess error types. Nothing here runs a job. The orchestration this module used to
own moved to `steps/separate.py`, and `DemucsProcessor` was deleted; the engine adapter that answers the
four questions a separation step asks is `separation/engines.py`.

Fetching moved too: `download_argv` and `parse_ytdlp_progress` now live in `acquisition/fetch.py`, because
a yt-dlp argv builder in the demucs module was pre-package residue, and it forced the acquisition step to
import from the separation domain to download a file.

Demucs `--two-stems=vocals` emits two files; the INSTRUMENTAL (backing track) is `no_vocals.wav`. Both are
published: the instrumental is the karaoke output, and the isolated `vocals.wav` feeds the song profile and
the vocal-guide mix (docs/ARCHITECTURE.md §7).
"""

from __future__ import annotations

import asyncio
import os
import re
import signal
from collections import deque
from collections.abc import AsyncIterator, Callable
from typing import cast

from ..ffmpeg import ffmpeg_argv
from ..retry_policy import BoundaryError, permanent_by_message

DEFAULT_MODEL = "htdemucs"

# The demucs-family checkpoints this engine will run. Mirrors the `demucs` engine's model
# whitelist in packages/shared/src/lyrics/separators.ts — defence in depth: the core already validates the
# engine+model pairing before enqueueing, but a worker must never shell `demucs -n <arbitrary>` from
# a job param, so an unknown model is rejected here too rather than silently falling back.
DEMUCS_MODELS = ("htdemucs", "htdemucs_ft", "htdemucs_6s")


def resolve_demucs_model(params: dict, default: str = DEFAULT_MODEL) -> str:
    """Pick the demucs checkpoint for a job: the whitelisted `params['model']`, else the worker
    default. An explicit-but-unknown model raises (the job fails non-retryable) instead of quietly
    separating with the wrong model — a silent substitution would ship a different instrumental than
    the room asked for."""
    requested = params.get("model")
    if requested is None or requested == "":
        return default
    if requested not in DEMUCS_MODELS:
        # BoundaryError subclasses ValueError (drop-in for existing pytest.raises(ValueError)) but
        # carries the shared structured `retryable = False`, so an unknown model fails fast via
        # retry_policy instead of spending three attempts rediscovering the same bad token.
        raise BoundaryError(f"unknown demucs model {requested!r}; expected one of {DEMUCS_MODELS}")
    return cast(str, requested)


# ── pure helpers (no IO) ─────────────────────────────────────────────────────────


def decode_argv(input_path: str, out_wav: str, ffmpeg_bin: str = "ffmpeg") -> list[str]:
    """ffmpeg argv: decode any container to the stereo 16-bit PCM WAV that Demucs wants, at the
    SOURCE sample rate.

    WAV is a WORKING format, never a stored one: this lands in `work/<jobId>/` and dies with the
    scratch dir. Forcing stereo normalizes the channel layout so separation behaves identically
    whether the source arrived as Opus-in-webm or AAC-in-m4a; the sample rate is deliberately left
    alone -- see the `-ar` note in the argv below before adding one back.
    """
    # NO -ar: keep the SOURCE sample rate. YouTube serves 48 kHz Opus, so forcing 44100 here was a
    # resampling stage that cost quality and bought nothing — every output format we use (FLAC, AAC,
    # Opus) handles 48 kHz natively.
    return ffmpeg_argv(ffmpeg_bin, input_path, ["-ac", "2", "-c:a", "pcm_s16le"], [out_wav])


# History: the vocals stem used to be stored as stereo AAC-in-m4a at 192k, on the argument that a
# guiding track mixed UNDER the instrumental master tolerates lossy compression. An earlier change replaced that with
# lossless FLAC for both stems (see encode_flac_argv below and PublishStems in steps/separate.py): the
# offset argument won -- an AAC-in-m4a encoder adds priming samples (~21 ms) that shift the vocals start
# relative to the FLAC instrumental, so sharing one codec removes the need for a startup rate-trim. The
# AAC encoder and its bitrate knob are gone with #502.


def encode_flac_argv(input_wav: str, out_path: str, ffmpeg_bin: str = "ffmpeg", level: int = 8) -> list[str]:
    """ffmpeg argv: encode a separated stem to LOSSLESS FLAC, 16-bit stereo at the source rate.

    Used for BOTH stems. The instrumental plays at volume as the master, so it stays lossless;
    the vocals guiding track uses the SAME encoder so the two stems share one codec and one container
    and decode to a sample-exact common start (removing the ~21 ms AAC-in-m4a priming-sample START
    offset the guide used to carry and the player used to trim out at startup). FLAC in a browser is a
    narrower surface than AAC-in-m4a, but both stems play through an <audio> element (not <video>),
    where WebKit documents FLAC support -- the core settled
    that decision at apps/core/src/lib/tv/TvPlayer.svelte:5-13. 16-bit is transparent here: the signal
    originated as a lossy 48 kHz stream, so extra bit depth would only store quantisation noise.
    compression_level 8 is the size/CPU sweet spot and is decode-cheap, which matters for a browser
    starting playback.
    """
    return ffmpeg_argv(
        ffmpeg_bin,
        input_wav,
        ["-c:a", "flac", "-compression_level", str(level), "-sample_fmt", "s16", "-ac", "2"],
        [out_path],
    )


def demucs_argv(
    input_path: str,
    out_dir: str,
    model: str = DEFAULT_MODEL,
    demucs_bin: str = "demucs",
    *,
    device: str | None = None,
    jobs: int | None = 1,
    overlap: float | None = None,
    segment: int | None = None,
    shifts: int | None = None,
) -> list[str]:
    """demucs argv: two-stem (vocals / no_vocals) separation. `--filename {stem}.{ext}` flattens the
    output to <out_dir>/<model>/<stem>.wav so the result path is deterministic regardless of input.

    Every performance flag is OPTIONAL and omitted when unset, so demucs' own defaults keep applying --
    including its cuda-if-available device pick, which is why forcing a device is opt-in rather than
    the default. These are the knobs that decide how long a cook takes:

      - `jobs`    parallel chunk jobs; each holds its own model copy, trading memory for wall time.
      - `overlap` demucs defaults to 0.25; lower is faster with a small quality cost at chunk seams.
      - `segment` chunk length; smaller cuts peak memory on a small box.
      - `shifts`  averages N shifted predictions: better, and proportionally slower.
      - `device`  force "cpu" / "cuda" / "cuda:1" instead of auto-detection.
    """
    argv = [
        demucs_bin,
        "-n",
        model,
        "--two-stems",
        "vocals",
        "-o",
        out_dir,
        "--filename",
        "{stem}.{ext}",
    ]
    if device:
        argv += ["-d", device]
    if jobs and jobs > 1:
        argv += ["-j", str(jobs)]
    if overlap is not None:
        argv += ["--overlap", str(overlap)]
    if segment is not None:
        argv += ["--segment", str(segment)]
    if shifts is not None:
        argv += ["--shifts", str(shifts)]
    argv.append(input_path)
    return argv


def demucs_no_vocals_path(out_dir: str, model: str = DEFAULT_MODEL) -> str:
    """Where demucs writes the instrumental given the flattened `--filename {stem}.{ext}` template."""
    return os.path.join(out_dir, model, "no_vocals.wav")


def demucs_vocals_path(out_dir: str, model: str = DEFAULT_MODEL) -> str:
    """Where demucs writes the ISOLATED VOCALS given the flattened `--filename {stem}.{ext}` template.
    `--two-stems=vocals` always emits BOTH no_vocals.wav and vocals.wav; both are published."""
    return os.path.join(out_dir, model, "vocals.wav")


_TQDM_PCT = re.compile(r"(\d+)%\|")  # demucs uses a tqdm bar: "  56%|████▏     | ..."


def parse_demucs_progress(line: str) -> int | None:
    """Extract the separation percentage from a demucs tqdm progress line, else None."""
    m = _TQDM_PCT.search(line)
    return int(m.group(1)) if m else None


def classify_retryable(stderr_text: str) -> bool:
    """True if the failure is worth retrying (transient); False for permanent source/format errors.

    The permanent-marker table is NOT owned here: it is `retry_policy.PERMANENT_MARKERS`, the one
    canonical union (Part 2/3). demucs raises `ProcessError` for EVERY CLI it runs —
    yt-dlp, ffmpeg, and bs-roformer-infer — so a deterministic separator/encoder failure whose stderr
    hits a canonical marker (`"unsupported"`, `"corrupt"`) is now classified non-retryable here too,
    exactly as `dial_home` classifies it, instead of being retried to maxAttempts off a
    download-only list that had drifted from `dial_home`'s copy.
    """
    return not permanent_by_message(stderr_text)


class ProcessError(RuntimeError):
    """A CLI exited non-zero. Carries a structured `.retryable` so the dial-home loop reports the
    right flag without re-parsing the message (it still falls back to a string heuristic if absent)."""

    def __init__(self, argv: list[str], returncode: int, output_tail: str) -> None:
        self.returncode = returncode
        self.output_tail = output_tail
        self.retryable = classify_retryable(output_tail)
        super().__init__(f"{argv[0]} exited {returncode}: {output_tail.strip()[-500:]}")


# An IDLE-OUTPUT timeout, NOT a wall-clock cap: a legitimate CPU separation can run 45+ minutes while
# still printing a tqdm progress line, and a wall-clock bound short enough to catch a wedged child
# would also kill a slow-but-healthy cook. So the clock is reset on EVERY line the child emits, and
# only fires when the child has gone completely silent for this long — the signature of a wedged
# process, not a slow one. yt-dlp and demucs both emit progress far more often than this.
SUBPROCESS_IDLE_TIMEOUT_SEC = 600.0


class ProcessTimeout(RuntimeError):
    """A CLI produced no output for SUBPROCESS_IDLE_TIMEOUT_SEC and was killed as wedged. Retryable
    on purpose: a stuck child is exactly the transient the core's existing retry path is meant for."""

    def __init__(self, argv: list[str], idle_sec: float) -> None:
        self.retryable = True
        super().__init__(f"{argv[0]} produced no output for {idle_sec:.0f}s; killed as wedged")


# A runner streams a command's merged stdout/stderr line-by-line and raises ProcessError on a
# non-zero exit. Injecting it lets tests drive a separation step with canned output + no real binary.
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


async def _terminate(proc: asyncio.subprocess.Process) -> None:
    """Kill the child AND ITS CHILDREN if still running, then AWAIT it so it is reaped (no zombie, no
    leaked handle). SIGKILL rather than SIGTERM because these CLIs ignore polite signals mid-work, and by
    the time we terminate we have already decided the process must not survive this generator.

    The kill goes to the whole PROCESS GROUP, which is why the spawn sets start_new_session. `proc.kill()`
    alone signals only the CLI we launched — and demucs with `-j N` forks N worker processes holding a
    model each (~2 GiB). Killing just the parent left every one of them alive and unreachable, so a
    cancelled cook kept its memory forever and a box running ENCORE_WORKER_CONCURRENCY>1 OOMed after a
    few cancels.

    The pgid comparison is load-bearing, not defensive noise: if the child ever shares OUR group (the
    spawn flag removed, or a platform without process groups) then `killpg` would SIGKILL this worker
    process too. So we only ever signal a group we know we created, and otherwise fall back to killing
    the direct child — a leaked grandchild is bad, killing the worker mid-cook is worse.
    """
    if proc.returncode is None:
        killed = False
        try:
            pgid = os.getpgid(proc.pid)
            if pgid != os.getpgid(0):
                os.killpg(pgid, signal.SIGKILL)
                killed = True
        except (ProcessLookupError, PermissionError, AttributeError, OSError):
            pass  # gone between the check and the kill, or no process groups on this platform
        if not killed:
            try:
                proc.kill()
            except ProcessLookupError:
                pass  # it exited between the check and the kill — nothing to reap beyond the wait
    try:
        await proc.wait()
    except Exception:  # noqa: BLE001 — reaping must never mask the original unwind
        pass


async def subprocess_runner(argv: list[str]) -> AsyncIterator[str]:
    """Real runner: spawn the CLI, stream merged output, raise ProcessError on non-zero exit.

    The child is killed and reaped on EVERY exit path — a normal finish, an exception, or a
    GeneratorExit thrown in when the consuming task is cancelled (the cancel path from dial_home).
    Without that guarantee a cancelled or unwinding job orphaned demucs/roformer/yt-dlp, still holding
    CPU or VRAM, while the core's lease expired and the reaper requeued — so retries STACKED real
    separations of one song on a box that can barely run one. An idle-output timeout also kills a
    child that has gone silent, so a wedged process cannot hold its slot forever.
    """
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        # Own process group, so _terminate can signal the CLI's forked workers too. Without this,
        # killing demucs left its `-j N` model-holding children alive at ~2 GiB each.
        start_new_session=True,
    )
    assert proc.stdout is not None
    tail: deque[str] = deque(maxlen=30)
    try:
        lines = _iter_lines(proc.stdout)
        while True:
            try:
                line = await asyncio.wait_for(lines.__anext__(), timeout=SUBPROCESS_IDLE_TIMEOUT_SEC)
            except StopAsyncIteration:
                break
            except asyncio.TimeoutError:
                raise ProcessTimeout(argv, SUBPROCESS_IDLE_TIMEOUT_SEC) from None
            tail.append(line)
            yield line
        rc = await proc.wait()
        if rc != 0:
            raise ProcessError(argv, rc, "\n".join(tail))
    finally:
        # Normal exit: proc has already been waited and this is a cheap no-op. Exception / timeout /
        # GeneratorExit: this is the path that stops the orphaned child.
        await _terminate(proc)
