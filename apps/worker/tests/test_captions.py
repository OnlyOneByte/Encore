"""YouTube caption parsing, and the guarantee that auto-generated tracks never get in.

The refusal of automatic captions is STRUCTURAL, not a filter: yt-dlp is never asked for them, so no
auto-generated file exists to accidentally read. `test_the_argv_never_requests_auto_generated_captions`
is the load-bearing test in this file — if it fails, `CaptionsSource`'s `high` text confidence has become
a lie and an ASR track can outrank a correct database lookup.
"""
from __future__ import annotations

from src.lyrics.captions import caption_argv, find_caption_file, is_translated_track, parse_vtt, read_captions

# A real-shaped WebVTT track: header, a NOTE block, cue identifiers, cue settings, inline markup,
# an annotation-only cue, and a line held on screen across two cues.
SAMPLE_VTT = """WEBVTT
Kind: subtitles
Language: en

NOTE this block is metadata, not a cue

1
00:00:07.120 --> 00:00:09.500 align:start position:0%
[Music]

2
00:00:09.500 --> 00:00:12.000
Hello, hello baby

3
00:00:12.000 --> 00:00:14.250
<c.colorE5E5E5>You called, I can't hear a thing</c>

4
00:00:14.250 --> 00:00:16.000
You called, I can't hear a thing

5
00:00:16.000 --> 00:00:18.400
♪♪
"""


def test_the_two_caption_kinds_are_requested_SEPARATELY_never_together():
    """THE GUARANTEE. One call fetches authored tracks, the other fetches YouTube's machine-generated
    ones, and never both — because the two have opposite roles. An authored track is a CANDIDATE for the
    song's words; a machine track is a BASELINE, evidence of what is audible, barred from being the answer
    while a candidate is trustworthy.

    yt-dlp names both kinds identically, so requesting them together would leave "authored or machine-made"
    to a filename heuristic. Getting that wrong would rank YouTube's ASR — made from the MIXED audio, so
    worse than this worker's own transcription of an isolated vocals stem — as authoritative text able to
    outrank a correct database lookup.
    """
    authored = caption_argv("https://youtube.com/watch?v=abc", "/tmp/c.%(ext)s")
    assert "--write-subs" in authored
    assert "--write-auto-subs" not in authored

    machine = caption_argv("https://youtube.com/watch?v=abc", "/tmp/c.%(ext)s", auto=True)
    assert "--write-auto-subs" in machine
    assert "--write-subs" not in machine


def test_the_argv_downloads_no_media():
    """This runs on every align job, including for a song whose audio is already on disk. It must be a
    metadata request, not a second download."""
    for auto in (False, True):
        assert "--skip-download" in caption_argv("https://youtube.com/watch?v=abc", "/tmp/c.%(ext)s", auto=auto)


def test_cues_become_timed_segments():
    segs = parse_vtt(SAMPLE_VTT)
    assert [s["text"] for s in segs] == ["Hello, hello baby", "You called, I can't hear a thing"]
    assert segs[0]["start"] == 9.5
    assert segs[0]["end"] == 12.0


def test_inline_markup_is_stripped_but_the_words_survive():
    """Caption tracks carry colour and per-word timing tags. The aligner needs words, not markup."""
    segs = parse_vtt(SAMPLE_VTT)
    assert "<c" not in segs[1]["text"]
    assert segs[1]["text"] == "You called, I can't hear a thing"


def test_annotation_only_cues_are_dropped():
    """[Music] and ♪♪ are not lyrics. Fed to a forced aligner they corrupt the words on either side,
    because the aligner tries to find them in the audio."""
    texts = [s["text"] for s in parse_vtt(SAMPLE_VTT)]
    assert not any("Music" in t or "♪" in t for t in texts)


def test_a_line_held_across_consecutive_cues_is_collapsed_and_its_window_extended():
    """Tracks repeat a line to hold it on screen. Left in, the same line would be aligned twice and the
    text would score as far more repetitive than the vocals are — which would skew agreement."""
    segs = parse_vtt(SAMPLE_VTT)
    held = [s for s in segs if s["text"].startswith("You called")]
    assert len(held) == 1
    assert held[0]["end"] == 16.0  # extended over both cues rather than truncated at the first


def test_the_hour_field_is_optional():
    """Both forms are legal WebVTT and both appear in the wild."""
    short = parse_vtt("WEBVTT\n\n01:05.000 --> 01:07.000\nlate in the song\n")
    long = parse_vtt("WEBVTT\n\n00:01:05.000 --> 00:01:07.000\nlate in the song\n")
    assert short == long
    assert short[0]["start"] == 65.0


def test_srt_comma_milliseconds_parse_too():
    """`--sub-format vtt/srt/best` can land an SRT; its cue grammar differs only in the decimal mark."""
    segs = parse_vtt("1\n00:00:03,500 --> 00:00:05,000\nhello\n")
    assert segs[0]["start"] == 3.5


def test_hours_past_one_are_not_read_as_minutes():
    """A 90-minute upload (a full-album video) must not wrap. 01:30:00 is 5400s, not 90s."""
    assert parse_vtt("WEBVTT\n\n01:30:00.000 --> 01:30:02.000\nx\n")[0]["start"] == 5400.0


def test_a_zero_length_or_reversed_cue_is_skipped():
    """Would produce a segment the aligner cannot use, and an out-of-order one fails validate_timing."""
    assert parse_vtt("WEBVTT\n\n00:00:05.000 --> 00:00:05.000\nx\n") == []
    assert parse_vtt("WEBVTT\n\n00:00:09.000 --> 00:00:03.000\nx\n") == []


def test_junk_is_not_mistaken_for_a_track():
    assert parse_vtt("") == []
    assert parse_vtt("WEBVTT\n\nno cues here at all\n") == []


def test_no_caption_file_reads_as_no_captions(tmp_path):
    """Every ordinary miss — video has none, yt-dlp absent, network gone — arrives here as an empty
    directory, and must be [] rather than an exception."""
    assert read_captions(str(tmp_path)) == []
    assert read_captions(str(tmp_path / "does-not-exist")) == []
    assert find_caption_file(str(tmp_path)) is None


def test_the_written_track_is_found_and_parsed(tmp_path):
    (tmp_path / "captions.en.vtt").write_text(SAMPLE_VTT, encoding="utf-8")
    segs = read_captions(str(tmp_path))
    assert [s["text"] for s in segs] == ["Hello, hello baby", "You called, I can't hear a thing"]


def test_track_choice_is_deterministic_when_several_languages_land(tmp_path):
    """Both are equally authoritative; picking the same one every run is what stops a re-cook producing
    different lyrics for no reason."""
    (tmp_path / "captions.en.vtt").write_text(SAMPLE_VTT, encoding="utf-8")
    (tmp_path / "captions.en-GB.vtt").write_text(SAMPLE_VTT, encoding="utf-8")
    (tmp_path / "captions.de.vtt").write_text(SAMPLE_VTT, encoding="utf-8")
    chosen = find_caption_file(str(tmp_path))
    assert chosen is not None and chosen.endswith("captions.en.vtt")


# ── the translation trap ───────────────────────────────────────────────────────────────


def test_a_MACHINE_TRANSLATED_track_is_recognised_as_such():
    """YouTube offers machine translations of a caption track under the target language with a long opaque
    suffix, alongside the original (plain, or explicitly '-orig'). Short region variants are NOT
    translations."""
    assert is_translated_track("captions.en-nP7Qs3xK9dQ.vtt")
    assert not is_translated_track("captions.en.vtt")
    assert not is_translated_track("captions.en-orig.vtt")
    assert not is_translated_track("captions.en-GB.vtt")
    assert not is_translated_track("captions.pt-BR.vtt")


def test_a_translated_track_is_REFUSED_rather_than_ranked_last(tmp_path):
    """Load-bearing for correctness, not tidiness.

    A Spanish song's captions can be offered translated into English. As a baseline that text would be
    fluent, long enough to clear MIN_TOKENS_TO_COMPARE, and about the right song in the WRONG language —
    so it would not abstain, it would vote confidently against every correct candidate. Worse than having
    no baseline at all. Ranking it last is not enough when it is the only file present.
    """
    (tmp_path / "captions.en-nP7Qs3xK9dQ.vtt").write_text(SAMPLE_VTT, encoding="utf-8")
    assert find_caption_file(str(tmp_path)) is None
    assert read_captions(str(tmp_path)) == []


def test_the_original_language_track_wins_over_a_translation(tmp_path):
    (tmp_path / "captions.en-nP7Qs3xK9dQ.vtt").write_text(SAMPLE_VTT, encoding="utf-8")
    (tmp_path / "captions.es-orig.vtt").write_text(SAMPLE_VTT, encoding="utf-8")
    chosen = find_caption_file(str(tmp_path))
    assert chosen is not None and chosen.endswith("captions.es-orig.vtt")
