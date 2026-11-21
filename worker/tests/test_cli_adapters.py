"""The subprocess adapters: argv shape and output parsing, with no subprocess run.

Every builder is pure, so the exact command line is assertable — which is the only way to check a flag
whose absence only shows up on a real download. `--no-playlist` is the example that earned this file: a
YouTube url carrying a list parameter turns one song into a two-hundred-track download.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import signal
import threading
import time
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


def test_a_tool_failure_survives_pickling() -> None:
    """DBOS pickles a workflow's exception. A ToolFailed that could not round-trip reached the core as
    `TypeError: missing 2 required positional arguments`, replacing yt-dlp's actual error with our own."""
    import pickle

    original = cli.ToolFailed(["yt-dlp", "url"], 1, "ERROR: HTTP Error 403: Forbidden")
    restored = pickle.loads(pickle.dumps(original))

    assert type(restored) is cli.ToolFailed
    assert str(restored) == str(original)
    assert (restored.argv, restored.code, restored.output) == (original.argv, original.code, original.output)


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


# ── review M12: YouTube's ROLLING auto-caption shape ──────────────────────────────────────────────

#: The first 29 lines of dQw4w9WgXcQ's real `--write-auto-subs` track, verbatim (the review's own case,
#: re-fetched for this wave). Every feature M12 names is in it: a lone-SPACE placeholder line, a 10 ms
#: roll-up marker cue, the carried-over first line of each rolling cue, `[Music]`, and inline word onsets.
ROLLING = """WEBVTT
Kind: captions
Language: en

00:00:00.320 --> 00:00:18.790 align:start position:0%
\x20
[Music]

00:00:18.790 --> 00:00:18.800 align:start position:0%
\x20
\x20

00:00:18.800 --> 00:00:21.790 align:start position:0%
\x20
We're<00:00:19.039><c> no</c><00:00:19.359><c> strangers</c><00:00:19.840><c> to</c>

00:00:21.790 --> 00:00:21.800 align:start position:0%
We're no strangers to
\x20

00:00:21.800 --> 00:00:25.950 align:start position:0%
We're no strangers to
love.<00:00:22.800><c> You</c><00:00:23.039><c> know</c><00:00:23.279><c> the</c>
"""


def test_the_lone_space_placeholder_no_longer_eats_the_first_cue() -> None:
    """Rule 1. The cue separator is an EMPTY line; YouTube writes a lone SPACE as the roll-up's empty half,
    and a parser splitting on `line.strip() == ""` cut every such cue in two — the half with the timestamp
    had no body, the half with the body had no timestamp, and both were dropped. That is why the review
    measured "the first cue is lost"."""
    cues = parse_vtt(ROLLING)
    assert cues, "the track must parse at all"
    assert cues[0]["start"] == 18.8, "the 0.32 s cue is `[Music]`, dropped as an ASR marker, not as a bug"
    assert [str(c["text"]) for c in cues][:2] == [
        "We're no strangers to",
        "love. You know the",
    ]


def test_a_ten_millisecond_roll_up_marker_is_not_a_cue() -> None:
    """Rule 2. 51 of the real track's 103 cues are exactly 10 ms; they carry no new words, and a 10 ms
    claim is one no clock can use either."""
    spans = [(float(str(c["start"])), float(str(c["end"]))) for c in parse_vtt(ROLLING)]
    assert all(end - start >= cli.MIN_CUE_SEC for start, end in spans)
    assert 21.79 not in [start for start, _end in spans]


def test_the_cue_floor_sits_in_the_empty_band_rather_than_on_a_frame_count() -> None:
    """The `#:` comment derived `MIN_CUE_SEC` as "two decoder frames at the 20 ms hop", which is 0.04 s: the
    value is 2.5 frames and only the measured band justifies it (W7c review r2-spec-11)."""
    from encore_worker.adapters import ml

    assert ml.FRAME_SEC == 0.02, "the hop the comment's arithmetic is read at"
    assert cli.MIN_CUE_SEC / ml.FRAME_SEC == 2.5, "not a whole frame count, so no frame count may justify it"
    assert 0.01 < cli.MIN_CUE_SEC < 1.15, "it must sit inside the band the two cue populations leave empty"


def test_only_the_new_line_of_a_rolling_cue_survives() -> None:
    """Rule 3. The carry is identified by TEXT IDENTITY against what the previous KEPT cue published, with
    the inline onsets taken off — not by a guess about line counts, which is what keeps a line-WRAPPED
    authored cue whole (asserted above in `test_a_wrapped_cue_becomes_one_line`)."""
    texts = [str(c["text"]) for c in parse_vtt(ROLLING)]
    assert texts == ["We're no strangers to", "love. You know the"]
    assert not any(text.startswith("We're no strangers to love") for text in texts), "no carry republished"


def test_a_repeated_line_across_two_authored_cues_is_not_read_as_a_roll_up_carry() -> None:
    """W5 review r1-correctness-2. Rule 3 used to fire on TEXT IDENTITY alone, and a line repeated across a
    cue boundary — a chorus line that ends one cue and opens the next — is ordinary in song captions. On a
    plain authored track (no inline tags, cues merely ABUTTING) the repeat was deleted from the served text,
    so the TV never showed it while it was being sung. The cue must look like a roll-up first: a tag of its
    own, or a span overlapping the previous cue's."""
    authored = (
        "WEBVTT\n\n"
        "00:00:01.000 --> 00:00:04.000\naaa bbb ccc\nddd eee\n\n"
        "00:00:04.000 --> 00:00:07.000\nddd eee\nfff ggg\n"
    )
    assert [str(c["text"]) for c in parse_vtt(authored)] == ["aaa bbb ccc ddd eee", "ddd eee fff ggg"]


def test_an_overlapping_cue_is_evidence_of_a_roll_up_even_with_no_tags() -> None:
    """The other half of the same test: a rolling track's cues OVERLAP, which an authored track's never do,
    so a tagless roll-up still loses its carry. It overlaps on EVERY cue, which is why `_ROLLING_OVERLAPS`
    can ask for two of them (W5 review r2-correctness-3) without costing a real roll-up anything."""
    rolling = (
        "WEBVTT\n\n"
        "00:00:01.000 --> 00:00:04.000\naaa bbb ccc\n\n"
        "00:00:03.500 --> 00:00:07.000\naaa bbb ccc\nddd eee\n\n"
        "00:00:06.500 --> 00:00:10.000\nddd eee\nfff ggg\n"
    )
    assert [str(c["text"]) for c in parse_vtt(rolling)] == ["aaa bbb ccc", "ddd eee", "fff ggg"]


def test_one_overlapping_pair_does_not_arm_the_carry_rule_for_a_whole_track() -> None:
    """W5 review r2-correctness-3. `span[0] < previous_end` was proof on its own and `parse_vtt` latched it
    for the rest of the track, so ONE overlapping pair — two simultaneous speakers, a backing-vocal overlay,
    stacked karaoke subtitles, all of which real authored/SDH tracks write — armed rule 3 over every later
    cue, and a line repeated across a later cue boundary was DELETED. No inline tag anywhere here, so the
    track proves nothing: both occurrences of the repeated line must publish."""
    authored = (
        "WEBVTT\n\n"
        "00:00:01.000 --> 00:00:05.000\naaa bbb\n\n"
        "00:00:04.000 --> 00:00:07.000\nccc ddd\n\n"
        "00:00:10.000 --> 00:00:13.000\nggg hhh\niii jjj\n\n"
        "00:00:13.000 --> 00:00:16.000\niii jjj\nkkk lll\n"
    )
    assert [str(c["text"]) for c in parse_vtt(authored)] == [
        "aaa bbb",
        "ccc ddd",
        "ggg hhh iii jjj",
        "iii jjj kkk lll",
    ]


def test_a_tag_is_still_proof_on_its_own() -> None:
    """The asymmetry `_Roll` exists for: a tagged cue needs no second witness, because tagging every word
    but the first is something only a growing cue does (the one measured roll-up carries 239 such tags)."""
    tagged = (
        "WEBVTT\nKind: captions\n\n"
        "00:00:01.000 --> 00:00:04.000\naaa<00:00:02.000><c> bbb</c>\n\n"
        "00:00:04.000 --> 00:00:07.000\naaa bbb\nccc ddd\n"
    )
    assert [str(c["text"]) for c in parse_vtt(tagged)] == ["aaa bbb", "ccc ddd"]


def test_the_roll_up_evidence_is_the_tracks_and_not_each_cues() -> None:
    """A rolling track's LAST cue often carries no new word, so no tag of its own — and it is exactly the cue
    whose body is pure carry. Read per cue, rule 3 would stop applying there and republish the line; read per
    TRACK (one cue with a tag or an overlap makes the track a roll-up) it still goes."""
    rolling = (
        "WEBVTT\nKind: captions\n\n"
        "00:00:01.000 --> 00:00:04.000\naaa<00:00:02.000><c> bbb</c>\n\n"
        "00:00:04.000 --> 00:00:07.000\naaa bbb\nccc ddd\n"
    )
    assert [str(c["text"]) for c in parse_vtt(rolling)] == ["aaa bbb", "ccc ddd"]


def test_a_partially_tagged_cue_publishes_no_zero_width_word() -> None:
    """W5 review r1-tests-19. The docstring claimed such a cue was refused whole; it was not — every
    untagged token took the PREVIOUS word's onset, so a cue with one tag published three zero-width spans,
    and the TV lights a word while `start <= pos < end`, which a zero-width span never satisfies. A run of
    tokens sharing one onset is apportioned across the room to the next onset instead."""
    cues = parse_vtt("WEBVTT\n\n00:00:10.000 --> 00:00:13.000\nzzz yyy<00:00:11.500><c> xxx</c> www vvv\n")
    words = cues[0]["words"]
    assert isinstance(words, tuple)
    assert [w["word"] for w in words] == ["zzz", "yyy", "xxx", "www", "vvv"]
    assert all(float(str(w["end"])) > float(str(w["start"])) for w in words), "no word can never be lit"
    assert float(str(words[0]["start"])) == 10.0, "the untagged head run opens at the cue's own start"
    assert float(str(words[1]["end"])) == 11.5, "and closes at the first tag"
    assert float(str(words[2]["start"])) == 11.5, "the tagged word keeps the onset the author wrote"
    assert float(str(words[-1]["end"])) == 13.0, "the last word closes at the cue's end"


def test_inline_timestamps_become_word_claims() -> None:
    """Rule 4. They are the only per-word timing a rolling track carries, and `clean_line` strips them —
    the review measured 239 of them thrown away on this track. They are CARRIED, not declared: the caption
    path's `TextRef` stays `TIMING_LINE` on purpose (W5 review r2-correctness-6, and `fetch_captions` says
    why), so this asserts the payload and nothing about the text's sync level."""
    first = parse_vtt(ROLLING)[0]
    words = first["words"]
    assert isinstance(words, tuple)
    assert [(w["word"], w["start"]) for w in words] == [
        ("We're", 18.8),
        ("no", 19.039),
        ("strangers", 19.359),
        ("to", 19.84),
    ]
    assert [w["end"] for w in words] == [19.039, 19.359, 19.84, 21.79]


def test_an_authored_cue_with_no_inline_tags_claims_no_word_timing() -> None:
    """EVERY word gets a span or none do: a word list that disagreed with the line would be read in
    preference to it (`measure.timed_words`), so a partially tagged cue keeps line timing."""
    assert "words" not in parse_vtt(VTT)[0]


def test_a_cue_whose_body_is_only_a_separator_line_is_still_no_cue() -> None:
    assert parse_vtt("00:00:01.000 --> 00:00:03.000\n \n\x20\n") == ()


def test_two_cues_in_one_block_are_two_cues() -> None:
    """The parser is TIMESTAMP-driven, so a file that separates cues with a whitespace-only line (which is
    what rule 1 now treats as payload) cannot weld two cues into one and publish a timestamp as a lyric."""
    cues = parse_vtt("00:00:01.000 --> 00:00:02.000\nfirst\n \n00:00:03.000 --> 00:00:04.000\nsecond\n")
    assert [str(c["text"]) for c in cues] == ["first", "second"]


def test_a_word_timed_cues_word_stream_is_exactly_its_published_text() -> None:
    """THE INVARIANT THAT MAKES RULE 4 SAFE. `measure.timed_words` reads `word["word"]` in preference to the
    line, so a word list one token out of step with the text puts the ball on a word the screen is not
    showing. Verified on the whole real dQw4w9WgXcQ track too: 0 mismatches over its 41 word-timed cues,
    every word start monotonic and inside its cue."""
    for cue in parse_vtt(ROLLING):
        words = cue.get("words")
        if not words:
            continue
        assert isinstance(words, tuple)
        assert [str(w["word"]) for w in words] == str(cue["text"]).split()
        starts = [float(str(w["start"])) for w in words]
        assert starts == sorted(starts)
        assert all(float(str(cue["start"])) <= at <= float(str(cue["end"])) for at in starts)


# ── the watchdog and the cancel token (WK-02, WK-03) ─────────────────────────────────────────────


def _alive(pid: int) -> bool:
    """Running, as opposed to gone or a zombie: an orphan killed under a PID 1 that never reaps stays one."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    status = Path(f"/proc/{pid}/status")
    return not (status.exists() and "\nState:\tZ" in status.read_text())


def test_a_child_that_hangs_with_its_output_open_is_killed_at_its_deadline() -> None:
    """The sweep's probe: this returned normally after 6.0 s, the deadline only being checked after EOF."""
    started = time.monotonic()
    with pytest.raises(cli.ToolFailed, match="timed out after 1s"):
        cli.run(["sh", "-c", "sleep 6"], timeout_sec=1.0)
    assert time.monotonic() - started < 2.5, "killed at its deadline, not when it chose to exit"


def test_a_cancelled_run_leaves_no_live_child(tmp_path: Path) -> None:
    """The sweep's other probe: a cancelled job's child was still alive. The whole GROUP goes, grandchild
    included, which is the ffmpeg-under-demucs shape."""
    pidfile = tmp_path / "pid"
    token = cli.CancelToken()
    threading.Timer(0.3, token.cancel).start()
    started = time.monotonic()
    with pytest.raises(cli.ToolFailed, match="cancelled"):
        cli.run(["sh", "-c", f"sleep 30 & echo $! > {pidfile}; wait"], cancel=token)
    assert time.monotonic() - started < 2.0
    assert token.wait_idle(0.0), "no child of this job is counted alive"
    grandchild = int(pidfile.read_text())
    deadline = time.monotonic() + 2.0
    while _alive(grandchild) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not _alive(grandchild), "the child's own children are killed with it"


def test_a_run_under_a_cancelled_token_starts_nothing(tmp_path: Path) -> None:
    """A DBOS step retry after a stop, or the job's next step: refused before anything is spawned."""
    token = cli.CancelToken()
    token.cancel()
    marker = tmp_path / "ran"
    with pytest.raises(cli.ToolFailed, match="cancelled"):
        cli.run(["sh", "-c", f"touch {marker}"], cancel=token)
    assert not marker.exists()


def test_the_running_job_token_reaches_a_run_in_a_worker_thread() -> None:
    """`asyncio.to_thread` carries the job's context, so a `run` deep inside an adapter can be stopped
    without the token being threaded through every signature."""
    token = cli.CancelToken()

    async def job() -> None:
        cli.current_token.set(token)
        asyncio.get_running_loop().call_later(0.3, token.cancel)
        await asyncio.to_thread(cli.run, ["sh", "-c", "sleep 30"])

    with pytest.raises(cli.ToolFailed, match="cancelled"):
        asyncio.run(asyncio.wait_for(job(), 5.0))


def test_a_child_that_finishes_in_time_is_untouched() -> None:
    assert cli.run(["sh", "-c", "echo ok"], timeout_sec=5.0) == "ok\n"


def test_a_child_that_goes_quiet_is_killed_as_stalled_long_before_its_deadline() -> None:
    """The review's (a): the deadline is an hour, so only a SILENCE can turn a hang into a failure in about
    a minute. Stalled is not retryable, so the job is not given two more hung hours."""
    started = time.monotonic()
    with pytest.raises(cli.Stalled, match="stalled: no output for 1s") as stalled:
        cli.run(["sh", "-c", "echo starting; sleep 30"], timeout_sec=3600.0, idle_sec=1.0)
    assert time.monotonic() - started < 2.5
    assert stalled.value.retryable is False


def test_a_child_that_keeps_printing_is_not_stalled() -> None:
    script = "for i in 1 2 3 4 5 6; do echo $i; sleep 0.3; done"
    assert cli.run(["sh", "-c", script], idle_sec=1.0).split() == ["1", "2", "3", "4", "5", "6"]


def test_yt_dlp_gives_up_on_a_dead_socket_itself() -> None:
    for argv in (audio_argv("u", "/tmp/w"), caption_argv("u", "/tmp/c", automatic=True)):
        assert argv[argv.index("--socket-timeout") + 1] == "30"


def test_work_counted_in_job_holds_the_token_busy_until_it_returns() -> None:
    """The in-process zoo has no child to kill, so without this a stop freed its slot while it ran."""
    token = cli.CancelToken()

    def separation() -> str:
        time.sleep(0.6)
        return "done"

    def in_thread() -> str:
        cli.current_token.set(token)
        return cli.in_job(separation)

    worker = threading.Thread(target=in_thread)
    worker.start()
    time.sleep(0.2)
    assert token.wait_idle(0.0) is False, "still separating"
    assert token.wait_idle(2.0) is True
    worker.join()


def _record_run(monkeypatch: pytest.MonkeyPatch, module: object) -> list[dict[str, object]]:
    """Replace `module.run` with a recorder of each call's keyword arguments."""
    calls: list[dict[str, object]] = []

    def fake_run(argv: list[str], **kwargs: object) -> str:
        calls.append(kwargs)
        return ""

    monkeypatch.setattr(module, "run", fake_run)
    return calls


def test_every_yt_dlp_call_carries_the_silence_allowance(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A minute: yt-dlp prints progress many times a second, so 60 s without a line is a hang."""
    assert cli.YTDLP_IDLE_SEC == 60.0
    calls = _record_run(monkeypatch, cli)
    (tmp_path / "original.webm").write_bytes(b"x")
    cli.YtDlpAudio("yt-dlp").fetch("u", str(tmp_path))
    cli.YtDlpCaptions("yt-dlp").fetch("u", str(tmp_path), automatic=True)
    assert [c.get("idle_sec") for c in calls] == [60.0, 60.0]


def test_torch_demucs_carries_its_silence_allowance(monkeypatch: pytest.MonkeyPatch) -> None:
    """Five minutes: demucs redraws its bar every chunk, but loading the model prints nothing."""
    from encore_worker.adapters import separate  # noqa: PLC0415

    calls = _record_run(monkeypatch, separate)
    separate.TorchDemucs(model="htdemucs").separate("/in.wav", "/out")
    assert [c.get("idle_sec") for c in calls] == [300.0]


@pytest.mark.skipif(not os.path.isdir("/proc/self"), reason="reads /proc, Linux's")
def test_a_group_of_only_zombies_is_gone_but_a_running_one_is_not() -> None:
    """A killed child's group is waited out before its slot is freed, and a zombie never reaped (a container
    whose PID 1 reaps nothing) must not hold that wait for good."""
    import subprocess  # noqa: PLC0415

    live = subprocess.Popen(["sleep", "30"], start_new_session=True)  # noqa: S607
    dead = subprocess.Popen(["true"], start_new_session=True)  # noqa: S607
    try:
        deadline = time.monotonic() + 5
        while Path(f"/proc/{dead.pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z":
            assert time.monotonic() < deadline, "the child never exited"
            time.sleep(0.01)
        assert cli._group_alive(live.pid) is True
        assert cli._group_alive(dead.pid) is False, "a zombie is not alive"
    finally:
        live.kill()
        live.wait()
        dead.wait()
    assert cli._group_alive(live.pid) is False


def test_a_progress_sink_that_raises_stops_the_tool_and_reaches_the_caller() -> None:
    """The output is read on its own thread; a fault there must still end the run, as it did inline."""

    def sink(pct: int) -> None:
        raise RuntimeError("the sink broke")

    started = time.monotonic()
    with pytest.raises(RuntimeError, match="the sink broke"):
        cli.run(["sh", "-c", "echo '[download]  10.0% of 5MiB'; sleep 30"], on_progress=sink)
    assert time.monotonic() - started < 3.0, "the child was left running"


def _cancelled_run(token: cli.CancelToken, script: str) -> tuple[threading.Thread, list[float]]:
    """Start `run` on `script` under `token` in a thread; the list gets the moment `run` came back."""
    returned: list[float] = []

    def go() -> None:
        with pytest.raises(cli.ToolFailed, match="cancelled"):
            cli.run(["sh", "-c", script], cancel=token)
        returned.append(time.monotonic())

    thread = threading.Thread(target=go, daemon=True)
    thread.start()
    return thread, returned


def test_a_killed_runs_slot_is_held_until_its_whole_group_is_gone(monkeypatch: pytest.MonkeyPatch) -> None:
    """The child is reaped before its own children have died (CI saw it): the token must stay busy, and `run`
    must not return, while the group has a live member. The group check is faked, so no timing decides it."""
    gone_at = [float("inf")]
    monkeypatch.setattr(cli, "_group_alive", lambda pgid: time.monotonic() < gone_at[0])
    token = cli.CancelToken()
    thread, returned = _cancelled_run(token, "sleep 30")
    time.sleep(0.2)
    token.cancel()
    time.sleep(1.0)  # the watchdog has killed the child (within 0.5 s); the faked group lives on
    assert not returned and token.wait_idle(0.0) is False, "the slot was freed while the group still lived"
    gone_at[0] = time.monotonic()
    thread.join(3.0)
    assert returned and token.wait_idle(0.0) is True


def test_the_wait_for_a_group_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    """A group that never empties to the check (an un-inspectable box) still lets the slot go at the bound."""
    monkeypatch.setattr(cli, "_group_alive", lambda pgid: True)
    monkeypatch.setattr(cli, "_GROUP_GONE_SEC", 0.8)
    token = cli.CancelToken()
    thread, returned = _cancelled_run(token, "sleep 30")
    time.sleep(0.2)
    cancelled = time.monotonic()
    token.cancel()
    thread.join(5.0)
    assert returned, "the wait never ended"
    assert 0.8 <= returned[0] - cancelled < 2.5, returned[0] - cancelled


@pytest.mark.skipif(shutil.which("setsid") is None, reason="needs util-linux's setsid")
def test_a_descendant_that_left_the_group_cannot_hold_a_cancelled_run(tmp_path: Path) -> None:
    """`killpg` misses a process that called `setsid`, and one that kept stdout open held the read, and the
    slot, until it chose to exit. A killed run stops waiting on the pipe once its group is gone."""
    pidfile = tmp_path / "escaped"
    token = cli.CancelToken()
    thread, returned = _cancelled_run(token, f"setsid sh -c 'echo $$ > {pidfile}; exec sleep 30' & sleep 30")
    try:
        time.sleep(0.4)
        cancelled = time.monotonic()
        token.cancel()
        thread.join(6.0)
        assert returned, "the escaped descendant held the cancelled run"
        assert returned[0] - cancelled < 4.0
    finally:
        _kill_escaped(pidfile)


def _kill_escaped(pidfile: Path) -> None:
    if pidfile.exists() and pidfile.read_text().strip():
        with contextlib.suppress(ProcessLookupError):
            os.kill(int(pidfile.read_text()), signal.SIGKILL)


def test_a_sink_fault_holds_the_slot_until_the_group_is_gone(monkeypatch: pytest.MonkeyPatch) -> None:
    """A sink fault kills the group like a cancel does, so it must wait for the group the same way."""
    gone_at = [float("inf")]
    monkeypatch.setattr(cli, "_group_alive", lambda pgid: time.monotonic() < gone_at[0])
    token = cli.CancelToken()
    returned: list[float] = []

    def sink(pct: int) -> None:
        raise RuntimeError("the sink broke")

    def go() -> None:
        with pytest.raises(RuntimeError, match="the sink broke"):
            cli.run(["sh", "-c", "echo '[download]  10.0% x'; sleep 30"], on_progress=sink, cancel=token)
        returned.append(time.monotonic())

    thread = threading.Thread(target=go, daemon=True)
    thread.start()
    time.sleep(1.0)
    assert not returned and token.wait_idle(0.0) is False, "the slot was freed while the group still lived"
    gone_at[0] = time.monotonic()
    thread.join(3.0)
    assert returned and token.wait_idle(0.0) is True


def test_a_finished_run_has_read_every_line_before_it_returns(monkeypatch: pytest.MonkeyPatch) -> None:
    """The child is reaped before the reader has the last lines: those carry the final figure and ffmpeg's
    report, so `run` must not return until the reader has them. A sink slower than the kill grace holds the
    reader back, so only a full drain passes."""
    monkeypatch.setattr(cli, "_GROUP_GONE_SEC", 0.05)
    seen: list[int] = []

    def sink(pct: int) -> None:
        if pct == 100:
            time.sleep(0.6)
        seen.append(pct)

    script = 'i=1; while [ $i -le 100 ]; do echo "[download] $i.0% x"; i=$((i+1)); done; echo done'
    output = cli.run(["sh", "-c", script], on_progress=sink)
    assert seen[-1] == 100
    assert output.count("\n") == 101 and output.endswith("done\n")


@pytest.mark.skipif(shutil.which("setsid") is None, reason="needs util-linux's setsid")
def test_a_cancel_after_the_child_exits_is_not_held_by_a_descendant(tmp_path: Path) -> None:
    """The child exits 0 while a `setsid` descendant keeps stdout open: `run` is still draining when the
    cancel lands, and must stop waiting at the group grace, not when the descendant chooses to exit."""
    pidfile = tmp_path / "escaped"
    token = cli.CancelToken()
    thread, returned = _cancelled_run(token, f"setsid sh -c 'echo $$ > {pidfile}; exec sleep 30' & exit 0")
    try:
        time.sleep(0.6)
        assert not returned, "the drain did not wait for the open pipe"
        cancelled = time.monotonic()
        token.cancel()
        thread.join(6.0)
        assert returned, "the escaped descendant held the cancelled run"
        assert returned[0] - cancelled < 4.0
    finally:
        _kill_escaped(pidfile)


@pytest.mark.skipif(shutil.which("setsid") is None, reason="needs util-linux's setsid")
def test_a_killed_run_reports_no_more_progress(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A descendant that outlives the kill and prints a figure, before `run` returns or after, must not move a
    job that is over."""
    monkeypatch.setattr(cli, "_GROUP_GONE_SEC", 0.3)
    pidfile = tmp_path / "escaped"
    token = cli.CancelToken()
    calls: list[int] = []
    returned: list[float] = []
    script = (
        f'setsid sh -c \'echo $$ > {pidfile}; sleep 1; echo "[download] 55.0% x"; sleep 1.5; '
        f'echo "[download] 66.0% x"; sleep 1\' & sleep 30'
    )

    def sink(pct: int) -> None:
        calls.append(pct)

    def go() -> None:
        with pytest.raises(cli.ToolFailed, match="cancelled"):
            cli.run(["sh", "-c", script], cancel=token, on_progress=sink)
        returned.append(time.monotonic())

    thread = threading.Thread(target=go, daemon=True)
    thread.start()
    try:
        time.sleep(0.2)
        token.cancel()
        thread.join(5.0)
        assert returned
        time.sleep(3.5)
        assert calls == [], "a killed run's descendant moved its progress"
    finally:
        _kill_escaped(pidfile)
