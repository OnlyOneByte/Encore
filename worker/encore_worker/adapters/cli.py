"""The subprocess-backed adapters: yt-dlp for audio and captions, ffmpeg/ffprobe for measurement.

ARGV IS BUILT PURELY, then run. Every `*_argv` function below is a pure list-of-strings builder with no
side effects, so the exact command line is assertable in a unit test — which is the only way to check a
flag that only matters on a real download. The old worker learned this the hard way: a missing
`--no-playlist` turned one song into a 200-track download, and a missing `ENCORE_YTDLP_BIN` silently
shelled a bare `yt-dlp` off PATH and missed.

NOTHING HERE IMPORTS torch, whisperx OR ANY MODEL. These adapters work on a box with no ML installed,
which is why fetch-only workers are possible.
"""

from __future__ import annotations

import glob
import os
import re
import subprocess
from collections.abc import Sequence

from encore_worker.adapters.ports import ProgressSink
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics.clean import clean_segments

#: yt-dlp writes progress as a percentage; this is the only shape worth parsing out of its output.
_PCT = re.compile(r"\[download\]\s+(\d{1,3})(?:\.\d+)?%")

#: `ffmpeg -i` reports duration on stderr in this shape. ffprobe is cleaner but is a second binary, and
#: a box is far more likely to have ffmpeg alone.
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


#: Substrings every accelerator uses to say "not enough memory". Matched case-insensitively against a failed
#: command's combined output.
#:
#: WHY THIS EXISTS AT ALL. Model choice is deliberately NOT gated on VRAM — a memory ceiling is a continuum,
#: not a yes/no, and it moves with segment size, overlap and precision, so a gate would block configurations
#: that work. The cost of letting anyone pick anything is that the FAILURE has to be legible: an OOM must say
#: "this model needs more memory than this box has", once, rather than burning three attempts producing the
#: same crash with a stack trace about tensors.
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


class OutOfMemory(RuntimeError):
    """A model needed more memory than this box has.

    `retryable = False`, and that is the whole point: the same model on the same audio on the same box will
    exhaust the same memory every time, so three attempts cost three long failures and tell the operator
    nothing the first did not. Deterministic failures must not be retried — the same reasoning
    `SilentInstrumental` uses.

    Recoverable by CHANGING something — a smaller model, a reduced segment, a bigger box — which is a
    decision for a person, not for a retry loop.
    """

    retryable = False


def looks_like_oom(output: str) -> bool:
    """Did this failure run out of memory? Read from the command's own output, since a subprocess cannot
    raise a typed exception across the boundary."""
    low = output.lower()
    return any(marker in low for marker in OOM_MARKERS)


def run(argv: Sequence[str], *, on_progress: ProgressSink | None = None, timeout_sec: float = 3600.0) -> str:
    """Run a command to completion, returning its combined output.

    SYNCHRONOUS on purpose. Every caller is already inside `asyncio.to_thread` (see `align_steps`), so
    an async subprocess here would add a second concurrency model for no benefit. `start_new_session`
    puts the child in its own process group, so a timeout kills the whole tree rather than orphaning
    ffmpeg children that keep writing to a scratch directory nobody is watching any more.
    """
    lines: list[str] = []
    proc = subprocess.Popen(  # noqa: S603 - argv is built by the pure builders above, never a shell string
        list(argv),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )
    try:
        # `stdout=PIPE` above guarantees this; narrowed without an `assert`, which `-O` would strip.
        stream = proc.stdout
        if stream is None:  # pragma: no cover - unreachable with stdout=PIPE
            raise ToolFailed(argv, -1, "no stdout pipe")
        for line in stream:
            lines.append(line)
            if on_progress is not None:
                pct = parse_pct(line)
                if pct is not None:
                    on_progress(pct)
        code = proc.wait(timeout=timeout_sec)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise ToolFailed(argv, -1, f"timed out after {timeout_sec:.0f}s") from None
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    output = "".join(lines)
    if code != 0:
        if looks_like_oom(output):
            # Raised INSTEAD of ToolFailed so the non-retryable classification survives: a subprocess cannot
            # raise a typed exception across the boundary, so the only evidence is its output.
            raise OutOfMemory(
                f"{argv[0]} ran out of memory. This model needs more than this box has — try a smaller "
                f"model, or a box with more memory. Exit {code}."
            )
        raise ToolFailed(argv, code, output)
    return output


def parse_pct(line: str) -> int | None:
    """A 0..100 percentage from a yt-dlp progress line, or None. Clamped, never trusted blindly."""
    found = _PCT.search(line)
    if found is None:
        return None
    return max(0, min(100, int(found.group(1))))


# ── argv builders (pure) ─────────────────────────────────────────────────────────────────────────


def audio_argv(source_uri: str, out_dir: str, ytdlp_bin: str = "yt-dlp") -> list[str]:
    """Download the best audio-only stream as a single file.

    `--no-playlist` is load-bearing: a YouTube url carrying a list parameter otherwise downloads the
    whole list, which is how one song became two hundred. `-f bestaudio` avoids muxing a video stream we
    would immediately discard.
    """
    return [
        ytdlp_bin,
        "--no-playlist",
        # Newline-delimited progress, so `run` can parse a percentage out of it line by line.
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
        run(audio_argv(source_uri, out_dir, self._bin), on_progress=on_progress)
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
            run(caption_argv(source_uri, template, self._bin, automatic=automatic))
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
    """Cues from a WebVTT or SRT body.

    Both formats are handled by one parser because they differ only in the timestamp separator and a
    numeric index line. Two parsers for two nearly identical formats is two things to drift.

    Cue text is JOINED with spaces rather than newlines: a caption line-wrapped for a video player is
    one lyric line, and preserving the wrap would publish a lyric broken at whatever width YouTube chose.
    """
    cues: list[Segment] = []
    block: list[str] = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        line = raw.strip()
        if line:
            block.append(line)
            continue
        cue = _cue_of(block)
        if cue is not None:
            cues.append(cue)
        block = []
    cue = _cue_of(block)
    if cue is not None:
        cues.append(cue)
    # CAPTION FORMAT IS NOT LYRIC. A cue body carries italic tags, ASR per-word timestamp spans, music
    # notes and speaker dashes; published unfiltered they were drawn on the television as words to sing
    # (measured: `- ♪♪ Gotta get that ♪♪ <i>- ♪♪ Boom boom boom ♪♪</i>`). See `domain/lyrics/clean.py`
    # for what is removed and — more importantly — what deliberately is not.
    return clean_segments(cues)


_TIMESTAMP = re.compile(r"(\d{1,2}):(\d\d):(\d\d)[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d\d):(\d\d)[.,](\d{1,3})")


def _cue_of(block: Sequence[str]) -> Segment | None:
    """One cue from a block of lines, or None when the block carries no timestamp."""
    for index, line in enumerate(block):
        found = _TIMESTAMP.search(line)
        if found is None:
            continue
        body = " ".join(block[index + 1 :]).strip()
        # A cue with a timestamp and no words is a positioning or style cue, not a lyric.
        if not body:
            return None
        return {"start": _secs(*found.groups()[:4]), "end": _secs(*found.groups()[4:]), "text": body}
    return None


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
