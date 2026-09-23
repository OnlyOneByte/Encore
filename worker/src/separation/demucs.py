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

from ..host.ffmpeg import ffmpeg_argv
from ..retry_policy import BoundaryError, permanent_by_message
from ..vocabulary import StemFormat

DEFAULT_MODEL = "htdemucs"

# The demucs-family checkpoints this engine will run, mirroring the `demucs` engine's model
# allowlist in src/lib/contract/lyrics/separators.ts. Defence in depth: a worker must never shell
# `demucs -n <arbitrary>` from a job param even though the core already validates the pairing.
DEMUCS_MODELS = ("htdemucs", "htdemucs_ft", "htdemucs_6s")


def resolve_demucs_model(params: dict, default: str = DEFAULT_MODEL) -> str:
    """Pick the demucs checkpoint for a job: the allowlisted `params['model']`, else the worker
    default. An explicit-but-unknown model raises (the job fails non-retryable) instead of quietly
    separating with the wrong model — a silent substitution would ship a different instrumental than
    the room asked for."""
    requested = params.get("model")
    if requested is None or requested == "":
        return default
    if requested not in DEMUCS_MODELS:
        # BoundaryError subclasses ValueError but carries structured `retryable = False`, so an
        # unknown model fails fast via retry_policy instead of spending three attempts on a bad token.
        raise BoundaryError(f"unknown demucs model {requested!r}; expected one of {DEMUCS_MODELS}")
    return cast(str, requested)


def decode_argv(input_path: str, out_wav: str, ffmpeg_bin: str = "ffmpeg") -> list[str]:
    """ffmpeg argv: decode any container to the stereo 16-bit PCM WAV that Demucs wants, at the
    SOURCE sample rate.

    WAV is a WORKING format, never a stored one: this lands in `work/<jobId>/` and dies with the
    scratch dir. Forcing stereo normalizes the channel layout so separation behaves identically
    whether the source arrived as Opus-in-webm or AAC-in-m4a.
    """
    # NO -ar: keep the SOURCE sample rate. YouTube serves 48 kHz Opus, and every output format we use
    # (FLAC, AAC, Opus) handles 48 kHz natively, so forcing 44100 would only cost quality.
    return ffmpeg_argv(ffmpeg_bin, input_path, ["-ac", "2", "-c:a", "pcm_s16le"], [out_wav])


def encode_flac_argv(input_wav: str, out_path: str, ffmpeg_bin: str = "ffmpeg", level: int = 8) -> list[str]:
    """ffmpeg argv: encode a separated stem to LOSSLESS FLAC, 16-bit stereo at the source rate.

    Used for BOTH stems: the instrumental plays at volume as the master, and the vocals guiding
    track uses the SAME encoder so the two stems share one codec/container and decode to a
    sample-exact common start (an AAC-in-m4a encoder would add priming samples that shift the start).
    Both stems play through an <audio> element, where WebKit documents FLAC support. 16-bit is
    transparent here since the signal originated as a lossy 48 kHz stream. compression_level 8 is the
    size/CPU sweet spot and is decode-cheap, which matters for a browser starting playback.
    """
    return ffmpeg_argv(
        ffmpeg_bin,
        input_wav,
        ["-c:a", "flac", "-compression_level", str(level), "-sample_fmt", "s16", "-ac", "2"],
        [out_path],
    )


def encode_guide_mix_argv(
    instrumental_wav: str,
    vocals_wav: str,
    out_path: str,
    ffmpeg_bin: str = "ffmpeg",
    level: int = 8,
) -> list[str]:
    """ffmpeg argv: fold BOTH stems into ONE 4-channel FLAC — channels 0/1 instrumental, 2/3 vocals.

    Two separate stems would be two media elements with two decoders and two clocks, which cannot be
    sample-locked from script (a `currentTime`-based governor converges on a signal that excludes
    each element's output latency, leaving an audible residual). ONE file played by ONE element has
    ONE playhead, so the guide cannot drift.

    Reads the RAW scratch stems (sample-exact siblings of one mix), not the published FLACs. Nothing
    is resampled or mixed down.

    CHANNEL ORDER IS THE CONTRACT: the browser's `ChannelSplitter` splits by channel INDEX, and FLAC
    stores channels in the order written, so instrumental-then-vocals is what the TV relies on. The
    mapping is spelled out explicitly (defence-in-depth against a future ffmpeg default change)
    because the failure it guards is inaudible in review and unmistakable in a room: vocals landing
    in the instrumental's gain.

    MEASURED: a 4-channel FLAC built by this argv yields four DISTINCT channels through
    `<audio>` -> `MediaElementAudioSourceNode` -> `ChannelSplitter(4)` in both Chromium and Firefox
    ESR, with per-pair gain exact to the decibel — even though
    `MediaElementAudioSourceNode.channelCount` reports 2 in both engines, so it is NOT a capability probe.
    """
    return ffmpeg_argv(
        ffmpeg_bin,
        [instrumental_wav, vocals_wav],
        [
            "-filter_complex",
            # `map` is input.channel-output: instrumental L/R to the front pair, vocals L/R to the back.
            "[0:a][1:a]join=inputs=2:channel_layout=quad:map=0.0-FL|0.1-FR|1.0-BL|1.1-BR[mix]",
            "-map",
            "[mix]",
            "-c:a",
            "flac",
            "-compression_level",
            str(level),
            "-sample_fmt",
            "s16",
            # THE MUXER IS DECLARED, NEVER INFERRED: ffmpeg picks its container from the output
            # filename's extension when no `-f` is given, but the caller encodes to a temp sibling
            # ending in `.tmp` (no container maps to that), so without `-f` ffmpeg would abort before
            # encoding a frame and every room would silently fall back to the two-element guide.
            "-f",
            "flac",
        ],
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
    stem_format: StemFormat = StemFormat.FLAC,
) -> list[str]:
    """demucs argv: two-stem (vocals / no_vocals) separation. `--filename {stem}.{ext}` flattens the
    output to <out_dir>/<model>/<stem>.<ext> so the result path is deterministic regardless of input.

    `stem_format` selects the container, and demucs fills `{ext}` to match, so
    `demucs_no_vocals_path` derives the same extension from the same value. FLAC is the default
    because it is what the pipeline publishes and roughly halves the scratch bytes; WAV stays
    selectable as the cheaper working format on a box that would rather not spend the encode.

    Every performance flag is OPTIONAL and omitted when unset, so demucs' own defaults keep applying
    (including its cuda-if-available device pick). These are the knobs that decide how long a process takes:

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
    if stem_format is StemFormat.FLAC:
        # demucs writes WAV unless told otherwise; `--flac` makes `{ext}` resolve to `flac`, keeping
        # the argv and `demucs_no_vocals_path` in agreement.
        argv.append("--flac")
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


def demucs_no_vocals_path(
    out_dir: str, model: str = DEFAULT_MODEL, stem_format: StemFormat = StemFormat.FLAC
) -> str:
    """Where demucs writes the instrumental given the flattened `--filename {stem}.{ext}` template.

    The extension comes from the SAME `stem_format` value that put the format flag in `demucs_argv`,
    so the two cannot disagree — a hardcoded extension here while the argv is free to emit another
    reads downstream as "the separator produced nothing".
    """
    return os.path.join(out_dir, model, f"no_vocals{stem_format.ext}")


def demucs_vocals_path(
    out_dir: str, model: str = DEFAULT_MODEL, stem_format: StemFormat = StemFormat.FLAC
) -> str:
    """Where demucs writes the ISOLATED VOCALS given the flattened `--filename {stem}.{ext}` template.
    `--two-stems=vocals` always emits BOTH stems; both are published."""
    return os.path.join(out_dir, model, f"vocals{stem_format.ext}")


_TQDM_PCT = re.compile(r"(\d+)%\|")  # demucs uses a tqdm bar: "  56%|████▏     | ..."


def parse_demucs_progress(line: str) -> int | None:
    """Extract the separation percentage from a demucs tqdm progress line, else None."""
    m = _TQDM_PCT.search(line)
    return int(m.group(1)) if m else None


def classify_retryable(stderr_text: str) -> bool:
    """True if the failure is worth retrying (transient); False for permanent source/format errors.

    The permanent-marker table is NOT owned here: it is `retry_policy.PERMANENT_MARKERS`, the one
    canonical union. `ProcessError` is raised for EVERY CLI (yt-dlp, ffmpeg, bs-roformer-infer), so a
    deterministic failure whose stderr hits a canonical marker is classified non-retryable here too,
    the same way `dial_home` classifies it.
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


# An IDLE-OUTPUT timeout, NOT a wall-clock cap: a legitimate CPU separation can run 45+ minutes
# while still printing a tqdm line, and a wall-clock bound short enough to catch a wedged child would
# also kill a slow-but-healthy process. The clock resets on EVERY line the child emits and only fires
# on total silence — the signature of a wedged process, not a slow one.
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
    leaked handle). SIGKILL rather than SIGTERM: these CLIs ignore polite signals mid-work.

    The kill goes to the whole PROCESS GROUP (spawn sets start_new_session): `proc.kill()` alone
    signals only the launched CLI, and demucs with `-j N` forks N worker processes holding a model
    each (~2 GiB) that would otherwise stay alive and unreachable after a cancel, OOMing a box
    running concurrency>1 after a few cancels.

    The pgid comparison is load-bearing: if the child ever shares OUR group (spawn flag removed, or
    no process groups on this platform), `killpg` would SIGKILL this worker process too — so it only
    ever signals a group it knows it created, falling back to the direct child otherwise.
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

    The child is killed and reaped on EVERY exit path — normal finish, exception, or a GeneratorExit
    from a cancelled consuming task — or an orphaned demucs/roformer/yt-dlp keeps holding CPU/VRAM
    while the core's lease expires and the reaper requeues, stacking real separations of one song on
    a box that can barely run one. An idle-output timeout also kills a child gone silent.
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
