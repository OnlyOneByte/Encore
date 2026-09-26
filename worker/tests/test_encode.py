"""The encode recipes — argv assertions, then a real ffmpeg round-trip.

WHY ARGV IS TESTED AS DATA. Every flag in these recipes guards a failure that is invisible in review: a
missing `-f` aborts before the first frame, a wrong channel map puts vocals at the instrumental's gain, and
a codec change silently desyncs the two stems. Those are exactly the things a pure argv test can pin, and
the reasons are recorded next to each assertion so a future edit has to argue with the reason rather than
with a string.

The round-trip at the bottom actually runs ffmpeg and reads the channel count back, because the argv being
right is not the same as ffmpeg agreeing.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from encore_worker.adapters.encode import (
    DEFAULT_COMPRESSION_LEVEL,
    EncodeFailed,
    FfmpegEncoder,
    copy_argv,
    encode_guide_mix_argv,
    encode_stem_argv,
    ffmpeg_argv,
)

HAVE_FFMPEG = shutil.which("ffmpeg") is not None


# ── argv shape ───────────────────────────────────────────────────────────────────────────────────


def test_inputs_are_emitted_in_order() -> None:
    """The order IS the filter's `[0:a]`/`[1:a]` numbering, so it is a contract of the builder. Swapped,
    the guide mix puts vocals in the front pair and the room hears the wrong thing at the wrong gain."""
    argv = ffmpeg_argv("ffmpeg", ["first.wav", "second.wav"], [], "out.flac")
    assert argv.index("first.wav") < argv.index("second.wav")
    assert argv[argv.index("first.wav") - 1] == "-i"
    assert argv[argv.index("second.wav") - 1] == "-i"


def test_the_output_is_last() -> None:
    """ffmpeg's grammar is positional: an output that is not last is read as an input."""
    assert ffmpeg_argv("ffmpeg", "a.wav", ["-c:a", "flac"], "out.flac")[-1] == "out.flac"


def test_a_writing_call_overwrites_without_prompting() -> None:
    """Without `-y` ffmpeg asks on stdin, and a worker has no stdin — the process would hang until the
    step's timeout rather than failing."""
    assert "-y" in ffmpeg_argv("ffmpeg", "a.wav", [], "out.flac")


# ── the stem recipe ──────────────────────────────────────────────────────────────────────────────


def test_a_stem_is_flac_not_a_lossy_codec() -> None:
    """THE sync constraint. An AAC-in-m4a encoder adds priming samples, so the two stems would decode to
    starts a few milliseconds apart — and they must stay sample-aligned."""
    argv = encode_stem_argv("in.wav", "out.flac")
    assert argv[argv.index("-c:a") + 1] == "flac"


def test_a_stem_declares_its_muxer() -> None:
    """ffmpeg infers the container from the output extension. These write to a temp sibling whose suffix
    maps to no container, so without `-f` ffmpeg aborts before encoding a frame."""
    argv = encode_stem_argv("in.wav", "out.part")
    assert argv[argv.index("-f") + 1] == "flac"


def test_a_stem_is_forced_to_stereo() -> None:
    """A separator can emit mono for a mono source, and the guide-mix join needs exactly two channels per
    input to build its quad layout."""
    argv = encode_stem_argv("in.wav", "out.flac")
    assert argv[argv.index("-ac") + 1] == "2"


def test_a_stem_uses_the_agreed_sample_format_and_level() -> None:
    argv = encode_stem_argv("in.wav", "out.flac")
    assert argv[argv.index("-sample_fmt") + 1] == "s16"
    assert argv[argv.index("-compression_level") + 1] == str(DEFAULT_COMPRESSION_LEVEL)


def test_the_level_is_overridable() -> None:
    """A CPU-bound box should be able to trade size for time without editing this module."""
    argv = encode_stem_argv("in.wav", "out.flac", level=3)
    assert argv[argv.index("-compression_level") + 1] == "3"


# ── the guide mix ────────────────────────────────────────────────────────────────────────────────


def test_the_guide_mix_maps_instrumental_front_and_vocals_back() -> None:
    """CHANNEL ORDER IS THE CONTRACT. The TV's `ChannelSplitter` splits by channel INDEX, so 0/1 must be
    the instrumental and 2/3 the vocals. Reversed, the room hears vocals at the instrumental's gain —
    inaudible in review, unmistakable in a room."""
    argv = encode_guide_mix_argv("instrumental.wav", "vocals.wav", "out.flac")
    filt = argv[argv.index("-filter_complex") + 1]
    assert "map=0.0-FL|0.1-FR|1.0-BL|1.1-BR" in filt
    assert "channel_layout=quad" in filt
    # Input 0 is the instrumental, and that is what `0.0`/`0.1` above refer to.
    assert argv.index("instrumental.wav") < argv.index("vocals.wav")


def test_the_guide_mix_is_one_file_not_two() -> None:
    """Two files are two decoders and two clocks, making drift something to govern rather than something
    unrepresentable. One output is the whole point."""
    argv = encode_guide_mix_argv("i.wav", "v.wav", "out.flac")
    assert argv.count("-map") == 1
    assert argv[-1] == "out.flac"


def test_the_guide_mix_declares_its_muxer_too() -> None:
    """The old worker's note records the consequence of omitting it: every room silently fell back to the
    two-element guide, because ffmpeg aborted before the first frame."""
    argv = encode_guide_mix_argv("i.wav", "v.wav", "out.part")
    assert argv[argv.index("-f") + 1] == "flac"


def test_the_guide_mix_does_not_force_channel_count() -> None:
    """`-ac 2` here would collapse the quad layout the filter just built back to stereo, silently undoing
    the entire point of the file."""
    assert "-ac" not in encode_guide_mix_argv("i.wav", "v.wav", "out.flac")


# ── remux ────────────────────────────────────────────────────────────────────────────────────────


def test_an_already_flac_stem_is_copied_not_re_encoded() -> None:
    """Re-encoding FLAC to FLAC is lossless but pointless, and every extra pass is another chance to change
    a sample rate."""
    argv = copy_argv("in.flac", "out.flac")
    assert argv[argv.index("-c:a") + 1] == "copy"
    assert argv[argv.index("-f") + 1] == "flac"


# ── real ffmpeg ──────────────────────────────────────────────────────────────────────────────────

pytestmark_ffmpeg = pytest.mark.skipif(not HAVE_FFMPEG, reason="ffmpeg not on PATH")


def tone(path: Path, freq: int, seconds: float = 1.0) -> str:
    """A synthesised tone, so the channel assertions below are about a KNOWN signal."""
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={freq}:duration={seconds}",
            "-ar",
            "44100",
            "-ac",
            "2",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return str(path)


def channels_of(path: str) -> int:
    out = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=channels",
            "-of",
            "csv=p=0",
            path,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return int(out.stdout.strip())


@pytestmark_ffmpeg
def test_a_real_stem_encodes_to_stereo_flac(tmp_path: Path) -> None:
    out = str(tmp_path / "stem.flac")
    FfmpegEncoder().stem(tone(tmp_path / "in.wav", 440), out)
    assert os.path.getsize(out) > 0
    assert channels_of(out) == 2


@pytestmark_ffmpeg
def test_a_real_guide_mix_has_FOUR_channels(tmp_path: Path) -> None:
    """The assertion the whole recipe exists for. Four distinct channels is what the TV splits; anything
    else and the room gets the wrong pair at the wrong gain."""
    out = str(tmp_path / "guide.flac")
    FfmpegEncoder().guide_mix(tone(tmp_path / "i.wav", 220), tone(tmp_path / "v.wav", 880), out)
    assert channels_of(out) == 4, "the guide mix must carry both stems as four channels"


@pytestmark_ffmpeg
def test_encoding_to_a_container_less_suffix_still_works(tmp_path: Path) -> None:
    """The regression test for the missing `-f`. The store stages to a `.part` name, so the encoder MUST NOT
    depend on the output extension to pick a muxer."""
    out = str(tmp_path / "staged.part")
    FfmpegEncoder().stem(tone(tmp_path / "in.wav", 440), out)
    assert channels_of(out) == 2


@pytestmark_ffmpeg
def test_a_missing_input_fails_loudly(tmp_path: Path) -> None:
    with pytest.raises(EncodeFailed, match="could not encode stem"):
        FfmpegEncoder().stem(str(tmp_path / "nope.wav"), str(tmp_path / "out.flac"))


@pytestmark_ffmpeg
def test_an_empty_output_is_treated_as_failure(tmp_path: Path) -> None:
    """ffmpeg can exit 0 having written nothing. A zero-byte artifact published as ready is worse than a
    failure: core records the row and the room gets a decode error with nothing pointing back here."""
    source = tone(tmp_path / "in.wav", 440)
    out = tmp_path / "out.flac"

    encoder = FfmpegEncoder()
    import unittest.mock

    def wrote_nothing(argv: object, **kwargs: object) -> str:
        out.write_bytes(b"")
        return ""

    with unittest.mock.patch("encore_worker.adapters.encode.run", wrote_nothing):
        with pytest.raises(EncodeFailed, match="produced no bytes"):
            encoder.stem(source, str(out))
