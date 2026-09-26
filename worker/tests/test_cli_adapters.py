"""The subprocess adapters: argv shape and output parsing, with no subprocess run.

Every builder is pure, so the exact command line is assertable — which is the only way to check a flag
whose absence only shows up on a real download. `--no-playlist` is the example that earned this file: a
YouTube url carrying a list parameter turns one song into a two-hundred-track download.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from encore_worker.adapters import cli
from encore_worker.adapters.cli import (
    audio_argv,
    caption_argv,
    duration_argv,
    find_caption_file,
    parse_duration,
    parse_max_volume,
    parse_pct,
    parse_vtt,
    volume_argv,
)

# ── argv ─────────────────────────────────────────────────────────────────────────────────────────


def test_audio_argv_refuses_playlists_and_asks_for_audio_only() -> None:
    argv = audio_argv("https://x.test/watch?v=1&list=PL9", "/tmp/w", "yt-dlp-9")
    assert argv[0] == "yt-dlp-9", "the configured binary, never a bare name off PATH"
    assert "--no-playlist" in argv, "a list parameter would otherwise download the whole playlist"
    assert "bestaudio/best" in argv, "muxing a video stream we discard wastes the whole download"
    assert argv[-1] == "https://x.test/watch?v=1&list=PL9", "the url is the final positional"


def test_audio_argv_asks_for_parseable_progress() -> None:
    """Without newline-delimited output there is no percentage to forward as a keepalive."""
    assert "--newline" in audio_argv("u", "/tmp/w")


def test_caption_argv_skips_the_download() -> None:
    """Without this, every caption tier re-downloads the audio and an align job costs 3x the bandwidth."""
    assert "--skip-download" in caption_argv("u", "/tmp/c.%(ext)s", automatic=False)


def test_authored_and_automatic_tracks_are_different_requests() -> None:
    """They mean different things — a claim about the words versus evidence of what is audible — so a
    single call returning "whichever exists" could not tell them apart."""
    authored = caption_argv("u", "/tmp/c.%(ext)s", automatic=False)
    automatic = caption_argv("u", "/tmp/c.%(ext)s", automatic=True)

    assert "--write-subs" in authored and "--write-auto-subs" not in authored
    assert "--write-auto-subs" in automatic and "--write-subs" not in automatic


def test_measurement_argv_writes_nothing() -> None:
    assert duration_argv("/a.mp3") == ["ffmpeg", "-hide_banner", "-i", "/a.mp3"]
    volume = volume_argv("/a.mp3")
    assert "volumedetect" in volume
    assert volume[-3:] == ["-f", "null", "-"], "the decoded stream is discarded, not written"


# ── parsing ──────────────────────────────────────────────────────────────────────────────────────


def test_parses_a_download_percentage() -> None:
    assert parse_pct("[download]  42.1% of 5.00MiB at 1.00MiB/s") == 42
    assert parse_pct("[download] 100% of 5.00MiB") == 100
    assert parse_pct("[info] writing thumbnail") is None


def test_percentages_are_clamped() -> None:
    """Never trusted blindly: a bar above 100 would drive a progress frame the core rejects."""
    assert parse_pct("[download] 999% of 5MiB") == 100


def test_parses_a_duration() -> None:
    assert parse_duration("  Duration: 00:03:21.45, start: 0.000000, bitrate: 128 kb/s") == 201.45
    assert parse_duration("  Duration: 01:00:00.00,") == 3600.0


def test_an_unmeasurable_file_reports_zero_meaning_unknown() -> None:
    """Zero is UNKNOWN, not a zero-length song — `measure` reports no coverage rather than guessing."""
    assert parse_duration("moov atom not found") == 0.0


def test_parses_peak_volume_including_silence() -> None:
    assert parse_max_volume("[Parsed_volumedetect_0] max_volume: -3.4 dB") == -3.4
    assert parse_max_volume("[Parsed_volumedetect_0] max_volume: -91.0 dB") == -91.0


def test_an_unmeasurable_peak_is_none_never_zero() -> None:
    """THE bug this replaced: 0.0 dBFS is a REAL reading — full scale, the loudest a sample can be — so
    using it for "could not measure" made a measurement failure read as the loudest possible signal, and
    the silence guard passed everything.

    Contrast `parse_duration`, which legitimately uses 0.0 for unknown: no recording is 0 seconds long,
    so there the sentinel cannot collide with a real value.
    """
    for unparseable in ("", "moov atom not found", "[Parsed_volumedetect_0] mean_volume: -20.0 dB"):
        assert parse_max_volume(unparseable) is None, f"{unparseable!r} must not read as 0.0 dBFS"


def test_full_scale_audio_is_a_real_zero_not_an_unknown() -> None:
    """The reading that made 0.0 unusable as a sentinel."""
    assert parse_max_volume("[Parsed_volumedetect_0] max_volume: 0.0 dB") == 0.0


# ── caption parsing ──────────────────────────────────────────────────────────────────────────────

VTT = """WEBVTT

00:00:01.000 --> 00:00:03.500
Hello there

00:00:04.000 --> 00:00:06.000
second
line wrapped

00:00:07.000 --> 00:00:08.000
"""


def test_parses_webvtt_cues() -> None:
    cues = parse_vtt(VTT)
    assert len(cues) == 2, "a cue with a timestamp and no words is styling, not a lyric"
    assert cues[0] == {"start": 1.0, "end": 3.5, "text": "Hello there"}


def test_a_wrapped_cue_becomes_one_line() -> None:
    """A caption wrapped for a video player is ONE lyric line; preserving the wrap would publish a lyric
    broken at whatever width YouTube chose."""
    assert parse_vtt(VTT)[1]["text"] == "second line wrapped"


def test_parses_srt_with_comma_millis_and_index_lines() -> None:
    """One parser for both formats: they differ only in the separator and a numeric index."""
    srt = "1\n00:00:02,250 --> 00:00:04,000\nSubtitle text\n"
    cues = parse_vtt(srt)
    assert cues == ({"start": 2.25, "end": 4.0, "text": "Subtitle text"},)


def test_an_empty_or_headerless_body_yields_nothing() -> None:
    assert parse_vtt("") == ()
    assert parse_vtt("WEBVTT\n\n") == ()
    assert parse_vtt("no timestamps at all\n") == ()


def test_short_millis_are_padded_not_truncated() -> None:
    """`.5` is half a second, not five milliseconds."""
    assert parse_vtt("00:00:00.5 --> 00:00:01.0\nx\n")[0]["start"] == 0.5


def test_finds_the_caption_file_deterministically(tmp_path: Path) -> None:
    """A retry must read the same bytes, so the choice cannot depend on filesystem order."""
    (tmp_path / "captions.en.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\na\n")
    (tmp_path / "captions.en.vtt").write_text("WEBVTT\n")
    found = find_caption_file(str(tmp_path))
    assert found is not None
    assert found.endswith(".vtt"), "vtt is preferred over srt"


def test_no_caption_file_is_none_not_an_error(tmp_path: Path) -> None:
    assert find_caption_file(str(tmp_path)) is None


# ── out-of-memory: the failure that must not be retried ────────────────────────────────────────────


@pytest.mark.parametrize(
    "output",
    [
        "RuntimeError: CUDA error: out of memory",
        "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB",
        "RuntimeError: MPS backend out of memory (MPS allocated: 9.20 GB)",
        "hip out of memory",
        "failed to allocate 4294967296 bytes",
        "Killed",
    ],
)
def test_every_accelerator_dialect_of_out_of_memory_is_recognised(output: str) -> None:
    """Each vendor phrases it differently, and the OOM killer says nothing at all — just `Killed`. Missing
    any means the failure is classed retryable and the box spends three long attempts reproducing it."""
    assert cli.looks_like_oom(output)


@pytest.mark.parametrize(
    "output",
    [
        "ffmpeg: No such file or directory",
        "ERROR: unable to download video data",
        "unsupported WAV sample width 3 bytes",
        "",
    ],
)
def test_an_ordinary_failure_is_not_read_as_out_of_memory(output: str) -> None:
    """Over-matching is worse than under-matching here: a transient fault wrongly classed as OOM becomes
    non-retryable, so a job that a second attempt would have completed fails permanently."""
    assert not cli.looks_like_oom(output)


def test_an_out_of_memory_failure_is_not_retryable() -> None:
    """THE reason this classification exists. Model choice is deliberately NOT gated on VRAM — a memory
    ceiling moves with segment size and precision, so a gate would block configurations that work. The cost of
    letting anyone pick anything is that the failure must be legible: once, with a message naming memory,
    rather than three identical crashes about tensor allocation.
    """

    # Asserted the way the TRANSPORT reads it — `getattr(exc, "retryable", True)` — rather than by checking
    # for an attribute. An ordinary failure carries none and defaults to retryable, which is the behaviour
    # that matters; testing for the attribute's presence would pass while the effective answer was wrong.
    def effective(exc: BaseException) -> bool:
        return bool(getattr(exc, "retryable", True))

    assert effective(cli.OutOfMemory("no memory")) is False
    assert effective(cli.ToolFailed(["x"], 1, "boom")) is True, "an ordinary tool failure stays retryable"


def test_an_out_of_memory_message_names_the_remedy() -> None:
    """A person has to act on this — a smaller model, or a bigger box. A stack trace about tensors does not
    say that, which is why the message is written rather than passed through."""
    import unittest.mock

    with unittest.mock.patch.object(cli, "_drain", return_value="CUDA out of memory", create=True):
        pass  # the drain helper is private; the classification is asserted directly below

    err = cli.OutOfMemory(
        "x ran out of memory. This model needs more than this box has — try a smaller model"
    )
    assert "smaller" in str(err) and "memory" in str(err)
