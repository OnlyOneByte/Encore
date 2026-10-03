"""Turning separator scratch into the files core publishes: FLAC stems and the 4-channel guide mix.

EVERY CONSTANT HERE WAS PAID FOR, and none of them is stylistic: FLAC rather than AAC for SYNC (priming
samples would shift one stem against the other), `-sample_fmt s16`, `-compression_level 8`, `-f` always
declared because these write to a temp sibling whose suffix maps to no container, and the channel order the
TV's splitter relies on by INDEX. Each with its failure mode: `docs/arch/05-worker.md` §2.5.

The argv builders are PURE and separately tested — a flag whose absence only shows up on a real 45-minute
separation should be assertable in a millisecond.
"""

from __future__ import annotations

import os
from collections.abc import Sequence

from encore_worker.adapters.cli import ToolFailed, run

#: The size/CPU knee, and what every existing published file was written with.
DEFAULT_COMPRESSION_LEVEL = 8


def ffmpeg_argv(
    ffmpeg_bin: str,
    inputs: str | Sequence[str],
    middle: Sequence[str],
    output: str,
) -> list[str]:
    """Preamble, inputs in ORDER, codec/filter middle, then the output.

    Input order is a CONTRACT, not an incidental: it is the `[0:a]`/`[1:a]` numbering the guide-mix filter
    references. `-y` because every call here writes to scratch it owns.
    """
    argv = [ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-y"]
    for source in [inputs] if isinstance(inputs, str) else inputs:
        argv += ["-i", source]
    argv += list(middle)
    argv.append(output)
    return argv


def encode_stem_argv(
    source: str,
    out_path: str,
    ffmpeg_bin: str = "ffmpeg",
    level: int = DEFAULT_COMPRESSION_LEVEL,
) -> list[str]:
    """One stem to stereo FLAC. Used for BOTH the instrumental and the vocals, deliberately.

    The same encoder for both is what makes them share a container and decode to a sample-exact common
    start. Using a cheaper codec for the vocals — which are "only" a reference track — would reintroduce
    exactly the offset this avoids, because the vocals are what alignment and the guide mix are built from.
    """
    return ffmpeg_argv(
        ffmpeg_bin,
        source,
        [
            "-c:a",
            "flac",
            "-compression_level",
            str(level),
            "-sample_fmt",
            "s16",
            # Forced stereo: a separator can emit mono for a mono source, and the guide-mix join below
            # needs exactly two channels per input to build its quad layout.
            "-ac",
            "2",
            "-f",
            "flac",
        ],
        out_path,
    )


def encode_guide_mix_argv(
    instrumental: str,
    vocals: str,
    out_path: str,
    ffmpeg_bin: str = "ffmpeg",
    level: int = DEFAULT_COMPRESSION_LEVEL,
) -> list[str]:
    """Both stems folded into ONE 4-channel FLAC — channels 0/1 instrumental, 2/3 vocals.

    ONE FILE RATHER THAN TWO because two files are two media elements, two decoders and two clocks, and
    drift between them is then something to be governed rather than something unrepresentable. With one
    file there is no second start time that could differ.
    """
    return ffmpeg_argv(
        ffmpeg_bin,
        [instrumental, vocals],
        [
            "-filter_complex",
            # `map` entries are input.channel-output. Front pair = instrumental, back pair = vocals.
            "[0:a][1:a]join=inputs=2:channel_layout=quad:map=0.0-FL|0.1-FR|1.0-BL|1.1-BR[mix]",
            "-map",
            "[mix]",
            "-c:a",
            "flac",
            "-compression_level",
            str(level),
            "-sample_fmt",
            "s16",
            "-f",
            "flac",
        ],
        out_path,
    )


def copy_argv(source: str, out_path: str, ffmpeg_bin: str = "ffmpeg") -> list[str]:
    """Remux without re-encoding — for a scratch stem that is ALREADY in the published format.

    `-c:a copy` so a box configured with `ENCORE_STEM_FORMAT=flac` (scratch already FLAC) does not pay a
    second lossless encode, and more importantly does not resample: re-encoding FLAC to FLAC is lossless
    but pointless, and every extra pass is another chance to change a sample rate.
    """
    return ffmpeg_argv(ffmpeg_bin, source, ["-c:a", "copy", "-f", "flac"], out_path)


class FfmpegEncoder:
    """Runs the recipes above. The only part of this module that touches a process."""

    def __init__(self, ffmpeg_bin: str = "ffmpeg", level: int = DEFAULT_COMPRESSION_LEVEL) -> None:
        self._bin = ffmpeg_bin
        self._level = level

    def stem(self, source: str, out_path: str) -> str:
        """Encode one stem, returning `out_path`. Re-encodes even from FLAC unless the ext already matches."""
        already_flac = os.path.splitext(source)[1].lower() == ".flac"
        argv = (
            copy_argv(source, out_path, self._bin)
            if already_flac
            else encode_stem_argv(source, out_path, self._bin, self._level)
        )
        self._must_produce(argv, out_path, f"encode stem from {source}")
        return out_path

    def guide_mix(self, instrumental: str, vocals: str, out_path: str) -> str:
        argv = encode_guide_mix_argv(instrumental, vocals, out_path, self._bin, self._level)
        self._must_produce(argv, out_path, "build the guide mix")
        return out_path

    def _must_produce(self, argv: Sequence[str], out_path: str, what: str) -> None:
        """Run, then CHECK THE FILE EXISTS AND IS NON-EMPTY.

        ffmpeg can exit 0 having written nothing — a filter that produced no frames is the usual way — and
        a zero-byte artifact published as ready is worse than a failure, because core records the row and
        the room gets a decode error with nothing pointing back here.
        """
        try:
            run(list(argv), timeout_sec=1800.0)
        except ToolFailed as exc:
            raise EncodeFailed(f"could not {what}: {exc}") from exc
        if not os.path.isfile(out_path) or os.path.getsize(out_path) == 0:
            raise EncodeFailed(f"ffmpeg exited 0 but produced no bytes when asked to {what}")


class EncodeFailed(RuntimeError):
    """An encode did not produce a usable file.

    RETRYABLE: the usual causes are a truncated scratch file or a transient resource limit, and the cost of
    one more attempt is far below the cost of abandoning a completed 40-minute separation.
    """

    retryable = True
