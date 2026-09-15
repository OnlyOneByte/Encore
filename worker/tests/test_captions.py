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

from src.lyrics.captions import (
    _SCROLL_MIN_OVERLAP_WORDS,
    caption_argv,
    find_caption_file,
    is_translated_track,
    parse_vtt,
    read_captions,
)

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
        assert "--skip-download" in caption_argv(
            "https://youtube.com/watch?v=abc", "/tmp/c.%(ext)s", auto=auto
        )


def test_the_requested_langs_are_explicit_codes_never_a_glob():
    """The `en.*` glob is what earned `HTTP Error 429: Too Many Requests` from YouTube.

    YouTube offers the auto-caption track machine-translated into ~190 languages, and for a video whose
    audio is not English they appear under `en-<source>` codes (`en-cs`, `en-de`,...) — all matched by
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
    assert (
        "en-orig" in codes
    )  # YouTube's original-language marker: the one track that cannot be a translation
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
    """Tracks repeat a line to hold it on screen. Left in, the same line would be handed to the forced
    aligner twice and displayed twice on the TV's baseline-fallback path. (It does NOT "score as more
    repetitive": agreement_score is Jaccard over token SETS, so a repeated line cannot move it — the
    real beneficiaries are the aligner and the overlay.)"""
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
    """Both are equally authoritative; picking the same one every run is what stops a re-process producing
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
# and what issue an earlier change flagged as unguarded across the whole 546-test suite — is the step-level
# guarantee
# that the two kinds land in SEPARATE directories. `caption_argv` asking for one kind is not enough:
# yt-dlp names both kinds' files identically (`captions.en.vtt`), so if `FetchCaptions` derived both
# output directories from one expression the machine fetch would target the same directory the authored
# fetch already populated, hit yt-dlp's no-overwrite default, and read the AUTHORED cues back as the
# machine BASELINE — collapsing the candidate and its own grader into the same text. These drive the
# real `FetchCaptions` steps in plan order to pin that the directories stay distinct.

import os  # noqa: E402
import sys  # noqa: E402
from pathlib import Path  # noqa: E402

import pytest  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.host.config import WorkerConfig  # noqa: E402
from src.processor import JobSpec  # noqa: E402
from src.runtime import Ctx  # noqa: E402
from src.steps.lyrics import AUTHORED, MACHINE, FetchCaptions  # noqa: E402

# Two distinct VTT tracks. The authored one is the correct words; the machine one is ASR of the mixed
# audio — recognisably the same song, recognisably worse. If the guarantee breaks, the machine baseline
# comes back reading as the authored candidate, i.e. these two collapse to the SAME text.
_AUTHORED_VTT = (
    "WEBVTT\n\n00:00:09.500 --> 00:00:12.000\nHello, hello baby\n\n"
    "00:00:12.000 --> 00:00:14.250\nYou called, I can't hear a thing\n"
)
_MACHINE_VTT = (
    "WEBVTT\n\n00:00:09.500 --> 00:00:12.000\nhello hello baby\n\n"
    "00:00:12.000 --> 00:00:14.250\nyou call i can hardly hear a thing\n"
)


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
    job = JobSpec(
        job_id="j1",
        media_id="m1",
        job_type="align",
        source_uri="https://youtube.com/watch?v=abc",
        params={},
        media_dir=str(tmp_path),
    )
    return Ctx(job=job, work=str(tmp_path / "work"), runner=_no_overwrite_ytdlp_runner())


async def _drain(step, ctx):
    async for _ in step.run(ctx):
        pass


async def test_FetchCaptions_writes_the_two_kinds_into_separate_directories(tmp_path):
    """THE GUARANTEE, at the step level — issue an earlier change.

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


from src import plans  # noqa: E402


async def test_configured_ytdlp_binary_reaches_the_caption_argv(tmp_path):
    """Issue an earlier change — the align (caption) path. ENCORE_YTDLP_BIN was probed and logged but never
    reached
    the caption subprocess: `align_runner` accepted no yt-dlp argument and `align_plan` built
    `FetchCaptions(AUTHORED)` / `FetchCaptions(MACHINE)` with the hardcoded default, so the only reader
    left was a `ytdlpBin` job param the core never sends. Both YouTube caption tiers therefore shelled
    out to a bare "yt-dlp" from PATH and, when it was off-PATH, silently declined on every song.

    Pins the whole chain: the binary handed to `align_runner(ytdlp_bin=...)` is threaded through
    `align_plan` into the FetchCaptions steps the plan actually builds, and lands at argv[0] of the
    caption invocation for BOTH kinds. `/opt/encore/bin/yt-dlp` is a literal path the code never
    constructs, so this cannot pass by re-deriving the code's default.
    """
    configured = "/opt/encore/bin/yt-dlp"

    proc = plans.align_runner(runner=lambda argv: None, ytdlp_bin=configured)
    job = JobSpec(
        job_id="j1",
        media_id="m1",
        job_type="align",
        source_uri="https://youtube.com/watch?v=abc",
        params={},
        media_dir=str(tmp_path),
    )
    plan = proc._plan_for(job, None)  # the plan align_runner actually built for this job
    caption_steps = [s for s in plan.steps() if isinstance(s, FetchCaptions)]
    assert len(caption_steps) == 2, "the align plan must fetch both caption kinds"

    for step in caption_steps:
        seen: list[list[str]] = []

        async def spy(argv, seen=seen):
            seen.append(argv)
            return
            yield  # pragma: no cover — async generator with no output lines

        ctx = Ctx(job=job, work=str(tmp_path / step.kind), runner=spy)
        await _drain(step, ctx)

        assert seen, f"{step.name} must have invoked yt-dlp"
        assert seen[0][0] == configured, (
            f"{step.name} argv[0] must be the configured ENCORE_YTDLP_BIN, got {seen[0][0]!r}"
        )


# ── issue an earlier change: the raw caption track survives job-scratch teardown when opted in
# ─────────────────────
# The caption fetch writes the raw `.vtt` into per-job scratch (`ctx.work/<kind>/`), which
# `dial_home._run_job` rmtrees when the job ends — so only the PARSED cues survive, and a
# caption-parsing defect (earlier changes-class) can never be re-examined from the source bytes after a
# process.
# `ENCORE_KEEP_RAW_CAPTIONS=1` copies the raw track out to the durable `derived/` store BEFORE teardown,
# keeping the authored/machine distinction structural (a directory), off by default so the footprint of
# an ordinary process does not change. The flag is resolved at the config boundary: the step takes a
# resolved `keep_raw` bool, and `WorkerConfig.from_env` parses the env with the same false-spelling set
# every operator boolean uses — so `ENCORE_KEEP_RAW_CAPTIONS=0` is OFF, not a truthy non-empty string.

from src.processor import raw_caption_path  # noqa: E402


async def test_the_raw_caption_track_is_NOT_retained_by_default(tmp_path):
    """DEFAULT footprint is unchanged — the durable path stays empty unless opted in.

    The step now takes a RESOLVED `keep_raw` bool (default False); it no longer reads the environment, so the
    default is exercised by simply not passing keep_raw=True.
    """
    ctx = _ctx_for_captions(tmp_path)

    await _drain(FetchCaptions(AUTHORED), ctx)

    dest = raw_caption_path(ctx.job.media_dir, ctx.job.media_id, AUTHORED, "vtt")
    assert not os.path.exists(dest), (
        "with the flag off the raw track must NOT be copied into derived/ — the default footprint "
        "must not change"
    )


async def test_the_raw_caption_track_is_retained_to_the_durable_store_when_opted_in(tmp_path):
    """THE PIN — issue an earlier change.

    With `ENCORE_KEEP_RAW_CAPTIONS=1`, after the fetch step runs the RAW caption track is retrievable
    from a durable `derived/` path — not only from the scratch directory that is torn down with the
    job. This is what lets a caption-parsing bug be diagnosed from the exact bytes production parsed,
    long after the process that produced it has finished and its scratch is gone.

    Drives the real `FetchCaptions` step against the same no-overwrite yt-dlp stand-in the an earlier change
    guarantee
    uses, so the retained bytes are exactly what `read_captions` was handed. Asserts both tiers land in
    their OWN durable directory (the authored/machine split stays structural, never a filename guess)
    and that the retained bytes are byte-identical to the scratch source.
    """
    ctx = _ctx_for_captions(tmp_path)

    await _drain(FetchCaptions(AUTHORED, keep_raw=True), ctx)
    await _drain(FetchCaptions(MACHINE, keep_raw=True), ctx)

    authored_dest = raw_caption_path(ctx.job.media_dir, ctx.job.media_id, AUTHORED, "vtt")
    machine_dest = raw_caption_path(ctx.job.media_dir, ctx.job.media_id, MACHINE, "vtt")

    # 1. Both tiers were retained to the DURABLE derived/ store, each in its own directory — the same
    #    structural split the scratch fetch keeps, so the two kinds cannot be confused post-process.
    assert os.path.exists(authored_dest), "authored raw track must be retained to derived/"
    assert os.path.exists(machine_dest), "machine raw track must be retained to derived/"
    assert os.path.dirname(authored_dest) != os.path.dirname(machine_dest), (
        "authored and machine raw tracks must live in SEPARATE durable directories"
    )
    assert os.sep + "derived" + os.sep in authored_dest, "must land under the derived/ storage class"

    # 2. The durable bytes are IDENTICAL to what landed in scratch — i.e. exactly what the parser saw,
    #    which is the whole point of retaining the source rather than the parsed cues.
    authored_scratch = os.path.join(ctx.work, AUTHORED, "captions.en.vtt")
    machine_scratch = os.path.join(ctx.work, MACHINE, "captions.en.vtt")
    assert Path(authored_dest).read_text(encoding="utf-8") == Path(authored_scratch).read_text(
        encoding="utf-8"
    )
    assert Path(machine_dest).read_text(encoding="utf-8") == Path(machine_scratch).read_text(encoding="utf-8")

    # 3. The two retained tracks are the two DIFFERENT tracks (authored candidate vs machine baseline),
    #    not one track copied twice — the structural split is meaningful, not cosmetic.
    assert Path(authored_dest).read_text(encoding="utf-8") != Path(machine_dest).read_text(encoding="utf-8")


@pytest.mark.parametrize("value", ["0", "false", "False", "no", "off", "OFF", "", "   "])
async def test_keep_raw_captions_env_false_spellings_leave_retention_OFF(tmp_path, value):
    """THE F2 PIN — issue an earlier change.

    `ENCORE_KEEP_RAW_CAPTIONS` is an operator boolean, and every spelling of false must turn retention
    OFF. Its original form read the raw env string with bare `os.environ.get(...)` truthiness inside the
    step, so `=0` (this project's own documented way to turn a worker flag off, per README's ENCORE_ANNOTATE
    guidance) was a NON-EMPTY string and silently turned retention ON — the exact inversion.

    An empty or whitespace-only value counts as false too (A1): `ENCORE_KEEP_RAW_CAPTIONS=` is the
    .env/compose idiom for "neutralise this", and a default-OFF flag must honour it as OFF.

    Exercised through the REAL boundary, `WorkerConfig.from_env`, which is where an earlier change moves the
    parse, then
    the resolved bool is threaded into the step exactly as the align plan threads it. With any false
    spelling the durable path must stay empty.

    Red on base: on base the step ignores this resolved bool and reads the env directly, so `=0` lands the
    file. (WorkerConfig.keep_raw_captions does not even exist on base.)
    """
    cfg = WorkerConfig.from_env({"ENCORE_KEEP_RAW_CAPTIONS": value})
    assert cfg.keep_raw_captions is False, f"{value!r} must resolve to keep_raw_captions=False"

    ctx = _ctx_for_captions(tmp_path)
    await _drain(FetchCaptions(AUTHORED, keep_raw=cfg.keep_raw_captions), ctx)

    dest = raw_caption_path(ctx.job.media_dir, ctx.job.media_id, AUTHORED, "vtt")
    assert not os.path.exists(dest), (
        f"ENCORE_KEEP_RAW_CAPTIONS={value!r} must leave retention OFF — no raw track in derived/"
    )


@pytest.mark.parametrize("value", ["1", "true", "True", "yes", "on"])
async def test_keep_raw_captions_env_true_spellings_turn_retention_ON(tmp_path, value):
    """The affirmative half: true spellings resolve to True and retain the track (earlier changes)."""
    cfg = WorkerConfig.from_env({"ENCORE_KEEP_RAW_CAPTIONS": value})
    assert cfg.keep_raw_captions is True, f"{value!r} must resolve to keep_raw_captions=True"

    ctx = _ctx_for_captions(tmp_path)
    await _drain(FetchCaptions(AUTHORED, keep_raw=cfg.keep_raw_captions), ctx)

    dest = raw_caption_path(ctx.job.media_dir, ctx.job.media_id, AUTHORED, "vtt")
    assert os.path.exists(dest), f"ENCORE_KEEP_RAW_CAPTIONS={value!r} must retain the raw track"


def test_keep_raw_captions_defaults_off_when_unset():
    """Unset resolves to False — an ordinary process's footprint is unchanged."""
    assert WorkerConfig.from_env({}).keep_raw_captions is False


# ── the rolling YouTube auto-caption format, pinned against a REAL captured track ─────────
#
# The fixture below is a real YouTube automatic-caption track, not a hand-written one. It was captured
# with the exact `caption_argv(auto=True)` flags (`--write-auto-subs --convert-subs vtt` in particular,
# so the grammar is what production parses, not srv3/json3) from the 350s prank-call upload wRRsXxE1KVY,
# already in the library. Provenance is fixed by content hash so a re-capture that drifted would fail
# loudly rather than silently re-shape the test:
#
#   source:  https://www.youtube.com/watch?v=wRRsXxE1KVY  (--write-auto-subs, en-orig)
#   bytes:   39678
#   sha256:  427cd3e16dd18aca4b1d6b4807df9b0a1745251fda121b561c2636bcc9646fd5
#
# YouTube's rolling format emits cues in triplets: (a) a word-timed cue whose payload OPENS with a
# whitespace-only line and carries `<c>` per-word markup, (b) a ~10ms cue holding the plain text, then
# (c) a cue repeating that text and APPENDING the next words. The text therefore rolls forward as a
# growing prefix, and on base `parse_vtt` this survives as ~2× the real lines.

import hashlib  # noqa: E402

_ROLLING_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "youtube-rolling-auto-captions.en-orig.vtt"
_ROLLING_FIXTURE_SHA256 = "427cd3e16dd18aca4b1d6b4807df9b0a1745251fda121b561c2636bcc9646fd5"


def test_the_rolling_fixture_is_the_untouched_captured_track():
    """The proof is only as trustworthy as the fixture. Pin its content hash so an accidental re-save,
    normalisation, or line-ending rewrite is caught here rather than silently changing every count below.
    """
    data = _ROLLING_FIXTURE.read_bytes()
    assert hashlib.sha256(data).hexdigest() == _ROLLING_FIXTURE_SHA256
    assert len(data) == 39678


def test_a_rolling_auto_caption_run_collapses_to_the_real_line_count():
    """THE an earlier change PROOF. A real rolling auto-caption track must not survive as ~2× duplicated
    lines.

    Base `parse_vtt` collapses only EXACT consecutive duplicates (`out[-1]["text"] == body`), but the
    rolling repeat is a strict PREFIX, never an equality, so the guard never fires: base returns 236
    lines with 115 adjacent prefix-extend pairs (measured on this exact file). The fix folds a
    prefix-extending, time-adjacent run into one line, keeping the longest text — so the track parses to
    roughly half as many lines and NO adjacent pair where the earlier line is a prefix of the later one.

    Asserted as PROPERTIES of the collapse, not a golden line count, so the test states the mechanism:
    (1) no surviving rolling pair, (2) a large drop from the raw cue count, (3) no degenerate ~10ms
    lines from the triplet's hold cue. On base, (1) fails — 115 prefix-extends remain.
    """
    segs = parse_vtt(_ROLLING_FIXTURE.read_text(encoding="utf-8"))

    # an earlier change INVARIANT, PRESERVED. The prefix-extend collapse still fires: no adjacent pair where
    # the
    # earlier line is a strict prefix of the later one AND that later line is long enough to be a real
    # rolling extend. Base leaves 115 such pairs here; an earlier change drives them to 0. (Sub-threshold
    # short
    # leftovers created by the scroll trim below — a 1–2 word line quoted at the head of the next — are
    # deliberately spared, so this counts only extends of >= _SCROLL_MIN_OVERLAP_WORDS words.)
    prefix_extends = sum(
        1
        for a, b in zip(segs, segs[1:], strict=False)
        if b["text"] != a["text"]
        and b["text"].startswith(a["text"])
        and len(a["text"].split()) >= _SCROLL_MIN_OVERLAP_WORDS
    )
    assert prefix_extends == 0, (
        f"a rolling run survived uncollapsed: {prefix_extends} adjacent pairs where the earlier line is "
        "a strict prefix of the later one (base parse_vtt leaves 115 here)"
    )

    # an earlier change INVARIANT. The SCROLL residual is gone. YouTube's window also scrolls — words drop off
    # the
    # front — so line N+1's HEAD repeats line N's TAIL without N being a prefix of N+1. Measured on this
    # fixture the base has 90 adjacent pairs overlapping by >= _SCROLL_MIN_OVERLAP_WORDS words (46.1% of
    # all words repeat the previous tail). The trim drives that to 0. This is the assertion that reds on
    # an earlier change's head (its prefix-only fold cannot reach the scroll shape).
    def _tail_overlap_words(a: str, b: str) -> int:
        wa, wb = a.split(), b.split()
        for k in range(min(len(wa), len(wb)), 0, -1):
            if wa[-k:] == wb[:k]:
                return k
        return 0

    scroll_overlaps = sum(
        1
        for a, b in zip(segs, segs[1:], strict=False)
        if _tail_overlap_words(a["text"], b["text"]) >= _SCROLL_MIN_OVERLAP_WORDS
    )
    assert scroll_overlaps == 0, (
        f"a scroll-window run survived uncollapsed: {scroll_overlaps} adjacent pairs whose head repeats "
        "the previous tail by >= 3 words (base leaves 90 here — an earlier change's prefix fold does "
        "not reach them)"
    )

    # The trim keeps ONE window per real line rather than merging the run: the line count stays in the
    # same band an earlier change produced (122 pre-trim), NOT collapsed toward ~28 as a merge would. This is
    # the
    # guard that fails for a merge-shaped fix and passes for a trim-shaped one.
    assert 100 <= len(segs) <= 150, f"expected the rolling track to collapse to ~half; got {len(segs)}"

    # The triplet's 10ms hold cue must be folded into its run, not left as a degenerate line.
    assert min(s["end"] - s["start"] for s in segs) > 0.05

    # Sanity: monotonic, non-empty, and the opening rolled line is fully assembled (not truncated).
    assert segs[0]["text"].startswith("was this week's phone scam. Check it out.")
    assert all(a["start"] <= b["start"] for a, b in zip(segs, segs[1:], strict=False))


def test_a_time_separated_repeated_line_is_NOT_collapsed_as_a_scroll():
    """The scroll trim must not eat a genuine repeat. A chorus line that recurs LATER in the song is a
    real lyric, not a rolling-window artifact — the only thing keeping the two apart is TIME-ADJACENCY,
    since their text overlaps fully. Two identical lines separated by a large time gap must both survive.
    """
    vtt = (
        "WEBVTT\n\n"
        "00:00:10.000 --> 00:00:13.000\nwe will rock you we will rock you\n\n"
        "00:00:50.000 --> 00:00:53.000\nwe will rock you we will rock you\n\n"
    )
    segs = parse_vtt(vtt)
    assert [s["text"] for s in segs] == [
        "we will rock you we will rock you",
        "we will rock you we will rock you",
    ]


def test_a_single_shared_boundary_word_is_NOT_trimmed_as_a_scroll():
    """The word-overlap threshold is load-bearing. Two adjacent lines can share ONE boundary word by
    coincidence — the tail of one being the head of the next — without one being a scrolled view of the
    other. Trimming on any shared word would silently delete a legitimate opening word; the >= 3-word
    threshold spares it. Here the lines share exactly the word "the" at the boundary and must NOT trim.
    """
    vtt = (
        "WEBVTT\n\n"
        "00:00:10.000 --> 00:00:12.000\nthe cat sat on the\n\n"
        "00:00:12.000 --> 00:00:14.000\nthe dog ran away fast\n\n"
    )
    segs = parse_vtt(vtt)
    assert [s["text"] for s in segs] == ["the cat sat on the", "the dog ran away fast"]


def test_a_scroll_window_trims_the_repeated_head_and_keeps_the_new_tail():
    """The core scroll shape, minimal. Line N+1 is line N with words dropped off the FRONT and new words
    appended at the back — a scrolled window, NOT a prefix of N — so an earlier change's prefix fold leaves it
    whole.
    The trim removes the >= 3-word repeated head and keeps only the new tail as its own line, preserving
    per-line windows (two lines out, not one merged line).
    """
    vtt = (
        "WEBVTT\n\n"
        "00:00:10.000 --> 00:00:12.000\nJohn Cena defends his title\n\n"
        "00:00:12.000 --> 00:00:14.000\nCena defends his title in the Super Slam\n\n"
    )
    segs = parse_vtt(vtt)
    assert [s["text"] for s in segs] == ["John Cena defends his title", "in the Super Slam"]
    assert len(segs) == 2  # trimmed, not merged into one line


def test_a_cue_whose_payload_opens_with_a_whitespace_only_line_is_not_dropped():
    """DEFECT 2. A cue block ends at a literally EMPTY line; a whitespace-only line is legal INSIDE a
    payload. Base `parse_vtt` terminated the payload scan on `lines[i].strip()` being falsy, so a cue
    whose payload opens with a space-only line — which is exactly how YouTube opens the word-timed cue
    of each rolling triplet — collected an empty body and was discarded by the `if not body` guard.

    This is a minimal reproduction: one cue, whose real text sits after a leading space-only line. On
    base the space-only line ends the payload before the text is read, so the cue vanishes and parse
    returns []. The fix reads to the genuinely empty separator, so the text survives.
    """
    vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n \nreal lyric words\n\n"
    segs = parse_vtt(vtt)
    assert [s["text"] for s in segs] == ["real lyric words"]
