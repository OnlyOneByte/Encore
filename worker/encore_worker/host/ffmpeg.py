"""Which ffmpeg this box will run, and why that is a decision rather than a lookup.

The worker shells ffmpeg on every path, so "is ffmpeg present" gates the `stems` capability outright (see
`hardware.capabilities`), and an absent or ancient one is a class of failure that only shows up per codec,
at job time. Resolution order: `ENCORE_FFMPEG_BIN`, then `imageio-ffmpeg`'s pinned static build, then
`ffmpeg` on PATH.

Why bundled beats PATH, why that costs no hardware acceleration, and what it does not fix — torchcodec,
which `dlopen`s ffmpeg's shared libraries, answered by `ml.PyannoteDiarizer` handing pyannote a preloaded
waveform: `docs/arch/05-worker.md` §5.
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

    Returns a path WITHOUT checking it runs (`probe_version` does that), so a broken bundle is reported as
    one rather than falling through to a system ffmpeg of unknown vintage.
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
    """The ffmpeg this process should run. Cached, the answer being fixed for the process.

    An `explicit` `ENCORE_FFMPEG_BIN` is returned UNVALIDATED on purpose: naming a binary that does not
    exist should fail loudly rather than be quietly substituted.
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
