"""Pin the source-audio stream-quality policy.

WHY THIS EXISTS. `-f bestaudio` takes whatever yt-dlp ranks first, and yt-dlp's default ranking is
driven by bitrate, so on an OLD upload it can hand back legacy AAC when the same video also carries a
modern Opus stream. Opus at a LOWER nominal bitrate is generally cleaner than legacy AAC at a higher
one, and -- the part that actually matters for Encore -- everything downstream inherits whatever this
step picks: the separator, the FLAC instrumental, and the ASR lyrics tier all consume it. Encoding the
instrumental losslessly cannot recover fidelity discarded here.

`FORMAT_SELECTOR` is the whole of what this module actually decides: it expresses codec preference by
POSITION and hands multiple-format ranking to yt-dlp's own selector engine, which is the only place
the per-format codec/bitrate data exists. The worker never sees more than one candidate itself (a
JobSpec carries a single source_uri; search is a core/TypeScript concern), so there is no in-worker
candidate list to rank -- see the deletion guard below, which keeps that policy from silently
re-growing a dead ranking chain.

These tests are PURE: they build argv strings. No network, no yt-dlp process, no fixtures that rot when
YouTube changes.
"""

from __future__ import annotations

from src.acquisition import fetch as fetch_mod
from src.acquisition import stream_quality
from src.acquisition.stream_quality import FORMAT_SELECTOR

# ── the format selector ─────────────────────────────────────────────────────────────


def test_selector_prefers_opus_then_m4a_then_falls_back_to_bestaudio():
    # Ordered preference with `/` alternatives: yt-dlp takes the FIRST branch that matches, so codec
    # preference is expressed by position, not by bitrate.
    parts = FORMAT_SELECTOR.split("/")
    assert parts[0].startswith("bestaudio[acodec"), FORMAT_SELECTOR
    assert "opus" in parts[0]
    # m4a/AAC is the accepted second choice -- it is what YouTube serves when there is no Opus.
    assert any("m4a" in p or "aac" in p for p in parts[1:]), FORMAT_SELECTOR
    # A bare `bestaudio` is NOT sufficient as the last branch: it still requires an audio-only stream
    # to exist. Measured against a real video whose player API was refused, the only available format
    # was the muxed `18` (360p mp4 / AAC 128k), every `bestaudio` branch missed, and the process failed
    # at download. `best` is the true last resort, and it restores the guarantee that this selector
    # can only reorder what yt-dlp would have taken -- never make a video undownloadable.
    assert parts[-1] == "best", FORMAT_SELECTOR
    assert any(p == "bestaudio" for p in parts), FORMAT_SELECTOR


def test_selector_never_requests_video_or_a_transcode():
    assert "bestvideo" not in FORMAT_SELECTOR
    # the format policy still holds: native container, no extract-audio, no wav.
    argv = fetch_mod.download_argv("https://youtu.be/x", "/m/audio/id1.%(ext)s")
    assert "--audio-format" not in argv
    assert "wav" not in " ".join(argv)


def test_download_argv_uses_the_ranked_selector_not_bare_bestaudio():
    argv = fetch_mod.download_argv("https://youtu.be/x", "/m/audio/id1.%(ext)s")
    assert FORMAT_SELECTOR in argv, argv
    # the extension stays a template -- the container is whichever branch won
    assert "%(ext)s" in " ".join(argv)


# ── no dead in-worker candidate-ranking chain ───────────────────────────────────────


def test_module_carries_no_dead_candidate_ranking_chain():
    # This module previously shipped rank_search_candidates + officiality_score + codec_score +
    # is_usable, a whole chain with ZERO production callers: a JobSpec carries a single source_uri
    # and search is a core/TypeScript concern, so the worker never has a candidate LIST to rank, and
    # the codec/bitrate/uploader metadata it keyed on is never collected on the worker side. Wiring
    # such ranking on is a core change (widen SearchResult, stop using --flat-playlist, or rank in
    # TS), not a worker one. Deleting it is the honest state -- FORMAT_SELECTOR is the whole of what
    # this module decides. Pin that so the dead chain cannot silently re-grow inside the worker.
    for dead in (
        "rank_search_candidates",
        "officiality_score",
        "codec_score",
        "is_usable",
        "_OFFICIAL_MARKERS",
        "_CODEC_RANK",
    ):
        assert not hasattr(stream_quality, dead), (
            f"{dead} is back in stream_quality; in-worker candidate ranking has no caller and no "
            "metadata source -- wiring codec-aware search ranking is a core change, not a worker one"
        )
    # FORMAT_SELECTOR is what actually survives.
    assert hasattr(stream_quality, "FORMAT_SELECTOR")
