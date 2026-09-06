"""YouTube caption parsing, and the guarantee that keeps a machine track from being read as authored.

TWO KINDS, OPPOSITE ROLES, KEPT APART STRUCTURALLY. An uploader-authored track is a CANDIDATE for the
song's words; YouTube's automatic track is a BASELINE — evidence of what is audible, barred from being
the answer while a candidate is trustworthy. Since the two-tier split (`1b948ad`) BOTH kinds are
deliberately requested: `caption_argv(..., auto=False)` passes `--write-subs`, `caption_argv(..., auto=True)`
passes `--write-auto-subs`, exactly one per call. yt-dlp names both kinds identically, so the distinction
is NOT a filename filter — `FetchCaptions` fetches each kind into its own directory (`steps/lyrics.py`
`AUTHORED = "captions"` / `MACHINE = "auto-captions"`), and that directory separation is the whole
guarantee that an automatic track cannot be mistaken for an authored one downstream.

Two load-bearing tests hold that up:
  - `test_the_two_caption_kinds_are_requested_SEPARATELY_never_together` — one call asks for `--write-subs`
    XOR `--write-auto-subs`, never both.
  - `test_FetchCaptions_writes_the_two_kinds_into_separate_directories` — the two `FetchCaptions` steps,
    run in plan order against yt-dlp's no-overwrite default, land the kinds in DIFFERENT directories and
    keep the authored candidate distinct from the machine baseline. If it fails, an ASR track made from
    the mixed audio can be read back as an authored candidate and outrank a correct database lookup.
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


def test_the_requested_langs_are_explicit_codes_never_a_glob():
    """The `en.*` glob is what earned `HTTP Error 429: Too Many Requests` from YouTube.

    YouTube offers the auto-caption track machine-translated into ~190 languages, and for a video whose
    audio is not English they appear under `en-<source>` codes (`en-cs`, `en-de`, ...) — all matched by
    `en.*`. One align job therefore fired dozens of timedtext requests, got rate-limited part way
    through, and left the tier with a degraded or missing baseline. Doubly wasteful, since
    `find_caption_file` refuses translations and returns exactly one file.

    A pattern here is the defect, so the test bans the metacharacter rather than pinning an exact string.
    """
    argv = caption_argv("https://youtube.com/watch?v=abc", "/tmp/c.%(ext)s")
    langs = argv[argv.index("--sub-langs") + 1]
    assert "*" not in langs, f"a glob in --sub-langs fans out into a 429: {langs!r}"
    codes = langs.split(",")
    assert codes, "at least one language must be requested"
    assert len(codes) <= 6, f"every extra code is another rate-limited request: {codes!r}"
    assert "en-orig" in codes  # YouTube's original-language marker: the one track that cannot be a translation
    assert "en" in codes


def test_the_argv_survives_a_rate_limit_instead_of_losing_the_baseline():
    """A caption miss is SILENT — the step swallows the failure and the tier simply has no baseline — so
    a transient 429 must be retried rather than dropped.

    Pinned as behaviour, not formatting: spacing the requests out is what stops the burst, and backing
    off is what recovers the track that was refused anyway.
    """
    for auto in (False, True):
        argv = caption_argv("https://youtube.com/watch?v=abc", "/tmp/c.%(ext)s", auto=auto)
        assert "--sleep-subtitles" in argv, "requests must not arrive as a burst"
        assert int(argv[argv.index("--sleep-subtitles") + 1]) >= 1
        # Exponential backoff on a retryable HTTP status, 429 among them.
        assert argv[argv.index("--retry-sleep") + 1].startswith("http:exp=")
        assert int(argv[argv.index("--extractor-retries") + 1]) >= 1


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


def test_a_translated_FROM_track_is_recognised_despite_a_short_suffix():
    """The second shape of translation, and the one that slipped through.

    YouTube also names a translation `en-<source language>` — `en-cs` is English translated from Czech,
    observed live in a worker log. The opaque-suffix pattern needs 8+ characters, so a two-letter subtag
    sailed past it and could have been selected as a BASELINE: fluent English about the right song, long
    enough not to abstain, and therefore able to vote confidently against every correct candidate.

    Case is the discriminator, per BCP 47: a REGION subtag is uppercase (`en-GB`), a LANGUAGE subtag is
    lowercase (`en-cs`). Both cases are asserted together because a rule that rejected `en-GB` would
    throw away legitimate tracks that some uploads are the only carrier of.
    """
    assert is_translated_track("captions.en-cs.vtt")
    assert is_translated_track("captions.en-de.vtt")
    assert is_translated_track("captions.en-fil.vtt")  # three-letter subtags exist
    # Region variants and the original marker must survive the widened rule.
    assert not is_translated_track("captions.en-GB.vtt")
    assert not is_translated_track("captions.en-US.vtt")
    assert not is_translated_track("captions.pt-BR.vtt")
    assert not is_translated_track("captions.en-orig.vtt")


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


# ── THE separate-directory guarantee, driven through the real steps ──────────────────────
#
# The tests above pin `caption_argv` (one kind per call) and the parser. What none of them touched —
# and what issue #96 flagged as unguarded across the whole 546-test suite — is the step-level guarantee
# that the two kinds land in SEPARATE directories. `caption_argv` asking for one kind is not enough:
# yt-dlp names both kinds' files identically (`captions.en.vtt`), so if `FetchCaptions` derived both
# output directories from one expression the machine fetch would target the same directory the authored
# fetch already populated, hit yt-dlp's no-overwrite default, and read the AUTHORED cues back as the
# machine BASELINE — collapsing the candidate and its own grader into the same text. These drive the
# real `FetchCaptions` steps in plan order to pin that the directories stay distinct.

import os  # noqa: E402
import sys  # noqa: E402
from pathlib import Path  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.processor import JobSpec  # noqa: E402
from src.runtime import Ctx  # noqa: E402
from src.steps.lyrics import AUTHORED, FetchCaptions, MACHINE  # noqa: E402

# Two distinct VTT tracks. The authored one is the correct words; the machine one is ASR of the mixed
# audio — recognisably the same song, recognisably worse. If the guarantee breaks, the machine baseline
# comes back reading as the authored candidate, i.e. these two collapse to the SAME text.
_AUTHORED_VTT = "WEBVTT\n\n00:00:09.500 --> 00:00:12.000\nHello, hello baby\n\n00:00:12.000 --> 00:00:14.250\nYou called, I can't hear a thing\n"
_MACHINE_VTT = "WEBVTT\n\n00:00:09.500 --> 00:00:12.000\nhello hello baby\n\n00:00:12.000 --> 00:00:14.250\nyou call i can hardly hear a thing\n"


def _no_overwrite_ytdlp_runner():
    """A yt-dlp stand-in that models the two behaviours the guarantee depends on:

      1. It writes DIFFERENT text for each kind (authored track vs machine ASR), keyed off which
         `--write-*` flag is in the argv — the two kinds really are different tracks.
      2. It honours yt-dlp's DEFAULT no-overwrite policy: if the target caption file already exists on
         disk it leaves it untouched (real yt-dlp requires `--force-overwrites` to clobber, and the argv
         does not pass it). This is what turns a shared directory into a silent collapse rather than a
         visible overwrite.

    Both files land under the `-o` template's directory as `captions.en.vtt` — the SAME basename for both
    kinds, exactly as real yt-dlp names them.
    """

    async def run(argv):
        template = argv[argv.index("-o") + 1]
        out_dir = os.path.dirname(template)
        os.makedirs(out_dir, exist_ok=True)
        body = _MACHINE_VTT if "--write-auto-subs" in argv else _AUTHORED_VTT
        target = os.path.join(out_dir, "captions.en.vtt")
        if not os.path.exists(target):  # yt-dlp's default: never clobber an existing file
            Path(target).write_text(body, encoding="utf-8")
        return
        yield  # pragma: no cover — makes this an async generator with no output lines

    return run


def _ctx_for_captions(tmp_path):
    job = JobSpec(job_id="j1", media_id="m1", job_type="align",
                  source_uri="https://youtube.com/watch?v=abc", params={}, media_dir=str(tmp_path))
    return Ctx(job=job, work=str(tmp_path / "work"), runner=_no_overwrite_ytdlp_runner())


async def _drain(step, ctx):
    async for _ in step.run(ctx):
        pass


async def test_FetchCaptions_writes_the_two_kinds_into_separate_directories(tmp_path):
    """THE GUARANTEE, at the step level — issue #96.

    `plans.py` runs `FetchCaptions(AUTHORED)` then `FetchCaptions(MACHINE)` for every align job. yt-dlp
    names both kinds' files identically, so the ONLY thing that keeps the machine BASELINE from being
    read back as the authored CANDIDATE is that each step fetches into its OWN directory. Deriving both
    directories from one expression — a reader could reasonably do it, since `self.kind` is used for
    nothing else in the method — silently collapses them: the machine fetch targets the directory the
    authored fetch already filled, yt-dlp's no-overwrite default declines to write, and the machine step
    reads the authored cues. Candidate and its own grader become the same text.

    This drives the real steps in plan order and pins two independently sufficient facts: the two kinds
    live in different directories on disk, and the authored candidate stays distinct from the machine
    baseline.
    """
    ctx = _ctx_for_captions(tmp_path)

    await _drain(FetchCaptions(AUTHORED), ctx)
    await _drain(FetchCaptions(MACHINE), ctx)

    # 1. The two kinds landed in DIFFERENT directories under work/ — this is the guarantee itself.
    kind_dirs = sorted(d for d in os.listdir(ctx.work) if os.path.isdir(os.path.join(ctx.work, d)))
    assert kind_dirs == sorted([AUTHORED, MACHINE]), (
        f"the two caption kinds must occupy separate directories, saw {kind_dirs!r}"
    )
    assert AUTHORED != MACHINE  # the directory names themselves must differ

    # 2. Both cue sets were populated, and the machine BASELINE did not come back as the authored
    #    CANDIDATE. If the directories collapse, the machine fetch reads the authored file and these
    #    two become identical.
    assert ctx.lyrics.authored_cues, "authored fetch must yield cues"
    assert ctx.lyrics.machine_cues, "machine fetch must yield cues"
    authored_text = " ".join(c["text"] for c in ctx.lyrics.authored_cues)
    machine_text = " ".join(c["text"] for c in ctx.lyrics.machine_cues)
    assert authored_text != machine_text, (
        "the machine baseline was read back as the authored candidate — the separate-directory "
        "guarantee has collapsed (both kinds share a directory)"
    )
    assert authored_text == "Hello, hello baby You called, I can't hear a thing"
    assert machine_text == "hello hello baby you call i can hardly hear a thing"
