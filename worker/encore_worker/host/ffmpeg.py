"""Which ffmpeg this box will run, and why that is a decision rather than a lookup.

THE WORKER SHELLS FFMPEG ON EVERY PATH. yt-dlp postprocesses to WAV with it, `decode_to_wav` normalises
the input with it, the FLAC and guide-mix encoders are it, and the silence probe reads levels with it. So
"is ffmpeg present" is not a nicety — it gates the `stems` capability outright (see `hardware.capabilities`),
and an absent or ancient one is a class of failure that only shows up per-codec, at job time.

RESOLUTION ORDER, and each step earns its place:

  1. `ENCORE_FFMPEG_BIN`   an explicit operator choice. Always wins: someone who built ffmpeg with NVENC,
                           VideoToolbox or a patched libopus has a reason, and no heuristic here should
                           second-guess it.
  2. the bundled binary    `imageio-ffmpeg`'s static FFmpeg 7.1, shipped per-platform in the wheel. Pinned,
                           so the FLAC this worker publishes is reproducible on a machine that has no
                           ffmpeg at all and on one whose distro ships 4.4.
  3. `ffmpeg` on PATH      the last resort, for platforms with no wheel (musl/Alpine, BSD, ppc64le).

BUNDLED BEATS PATH DELIBERATELY, which is the one choice here that could go either way. The argument for
PATH-first is that an operator's own build is probably better; the argument that wins is reproducibility —
two workers in a pool must not encode stems with different FFmpeg majors, and `job_attempts` records no
ffmpeg version to explain it if they do. An operator who wants their own build says so with one env var,
which is explicit and logged.

NO, THIS DOES NOT COST HARDWARE ACCELERATION. The question is a fair one — a static build has no NVENC,
no VideoToolbox, no QSV — but this worker decodes and encodes AUDIO ONLY: PCM, FLAC, AAC, Opus, Vorbis.
Every one of those is CPU-only in every FFmpeg build there is; there is no GPU audio codec to lose. The
acceleration that matters to this worker is torch's (CUDA / MPS / XPU), which lives in a different
dependency chain entirely and is untouched by any of this.

WHAT THIS DOES NOT FIX: torchcodec. pyannote 4.0 pulls torchcodec, which `dlopen`s FFmpeg SHARED
LIBRARIES (`libavutil.<major>.dylib` and friends) rather than running a binary — verified against
torchcodec 0.7.0 through 0.16.0, none of which bundle them. A static binary cannot satisfy that, so the
answer there is to not need it: `ml.PyannoteDiarizer` hands pyannote a preloaded waveform, which bypasses
its decoder. See that class.
"""

from __future__ import annotations

import functools
import shutil
import subprocess

#: What `hardware.binary_available` and every encoder default to when nothing better is found. Kept as the
#: bare name so a PATH lookup still happens at exec time on platforms this module cannot help.
FALLBACK = "ffmpeg"


def bundled() -> str | None:
    """The wheel-shipped static binary, or None when the `ffmpeg` extra is not installed.

    Returns a path WITHOUT checking it runs — `probe_version` is how a caller establishes that. Keeping
    the two separate means a broken bundle is reported as a broken bundle rather than silently falling
    through to a system ffmpeg of unknown vintage.
    """
    try:
        import imageio_ffmpeg  # noqa: PLC0415 - lazy: an extra, absent on a minimal install
    except ImportError:
        return None
    try:
        path: str = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001 - it raises a bare RuntimeError when no binary matches the platform
        return None
    return path


@functools.cache
def resolve(explicit: str | None = None) -> str:
    """The ffmpeg this process should run. Cached: the answer cannot change within one process, and
    `bundled()` costs an import.

    `explicit` is the operator's `ENCORE_FFMPEG_BIN` if they set one. An explicit value is returned
    UNVALIDATED and on purpose: if an operator names a binary that does not exist, the right outcome is
    the loud failure they can act on, not a quiet substitution of something else.
    """
    if explicit:
        return explicit
    return bundled() or FALLBACK


@functools.cache
def probe_version(binary: str) -> str | None:
    """`ffmpeg -version`'s first line, or None when the binary will not run at all.

    Recorded at startup so "which ffmpeg produced this FLAC" is answerable from a log rather than by
    guessing from the machine. A `None` here is exactly the state that makes `stems` unavailable.
    """
    try:
        done = subprocess.run(  # noqa: S603 - the binary is operator-supplied config, never job input
            [binary, "-hide_banner", "-version"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    first = done.stdout.splitlines()[0].strip() if done.stdout else ""
    return first or None


def describe(binary: str) -> str:
    """One log line naming the binary, its origin and its version — the three facts needed to reproduce
    an encode. Never raises; a box that cannot run ffmpeg still has to be able to say so."""
    origin = "bundled" if binary == bundled() else ("PATH" if binary == FALLBACK else "explicit")
    if binary == FALLBACK:
        found = shutil.which(FALLBACK)
        origin = f"PATH -> {found}" if found else "PATH -> NOT FOUND"
    return f"{binary} ({origin}): {probe_version(binary) or 'will not run'}"
