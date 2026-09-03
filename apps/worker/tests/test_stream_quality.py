"""B-9-C2: pin the source-audio stream-quality policy.

WHY THIS EXISTS. `-f bestaudio` takes whatever yt-dlp ranks first, and yt-dlp's default ranking is
driven by bitrate, so on an OLD upload it can hand back legacy AAC when the same video also carries a
modern Opus stream. Opus at a LOWER nominal bitrate is generally cleaner than legacy AAC at a higher
one, and -- the part that actually matters for Encore -- everything downstream inherits whatever this
step picks: the separator, the FLAC instrumental, and the ASR lyrics tier all consume it. Encoding the
instrumental losslessly cannot recover fidelity discarded here.

Idea borrowed from nomadkaraoke/flacfetch (MIT), which ranks YouTube candidates by codec generation
and by whether the upload looks official rather than trusting the platform's own ordering.

These tests are PURE: they build argv strings and rank recorded metadata dicts. No network, no yt-dlp
process, no fixtures that rot when YouTube changes.
"""
from __future__ import annotations

from src import demucs
from src.stream_quality import (
    FORMAT_SELECTOR,
    officiality_score,
    rank_search_candidates,
)


# ── the format selector ─────────────────────────────────────────────────────────────

def test_selector_prefers_opus_then_m4a_then_falls_back_to_bestaudio():
    # Ordered preference with `/` alternatives: yt-dlp takes the FIRST branch that matches, so codec
    # preference is expressed by position, not by bitrate.
    parts = FORMAT_SELECTOR.split("/")
    assert parts[0].startswith("bestaudio[acodec"), FORMAT_SELECTOR
    assert "opus" in parts[0]
    # m4a/AAC is the accepted second choice -- it is what YouTube serves when there is no Opus.
    assert any("m4a" in p or "aac" in p for p in parts[1:]), FORMAT_SELECTOR
    # A bare `bestaudio` MUST remain the last branch: a video with neither codec must still download
    # rather than failing the cook outright.
    assert parts[-1] == "bestaudio", FORMAT_SELECTOR


def test_selector_never_requests_video_or_a_transcode():
    assert "bestvideo" not in FORMAT_SELECTOR
    # B-7 policy still holds: native container, no extract-audio, no wav.
    argv = demucs.download_argv("https://youtu.be/x", "/m/audio/id1.%(ext)s")
    assert "--audio-format" not in argv
    assert "wav" not in " ".join(argv)


def test_download_argv_uses_the_ranked_selector_not_bare_bestaudio():
    argv = demucs.download_argv("https://youtu.be/x", "/m/audio/id1.%(ext)s")
    assert FORMAT_SELECTOR in argv, argv
    # the extension stays a template -- the container is whichever branch won
    assert "%(ext)s" in " ".join(argv)


# ── officiality signal ──────────────────────────────────────────────────────────────

def test_official_channel_markers_score_above_a_random_reupload():
    topic = officiality_score({"uploader": "Stephanie Mabey - Topic", "title": "The Zombie Song"})
    official_audio = officiality_score({"uploader": "SomeLabel", "title": "Song (Official Audio)"})
    verified = officiality_score({"uploader": "ArtistVEVO", "title": "Song"})
    plain = officiality_score({"uploader": "7clouds", "title": "Song (Lyrics)"})
    assert topic > plain
    assert official_audio > plain
    assert verified > plain


def test_officiality_ignores_case_and_tolerates_missing_fields():
    assert officiality_score({"uploader": "artist - topic", "title": None}) > 0
    assert officiality_score({}) == 0
    assert officiality_score({"uploader": None, "title": None}) == 0


# ── candidate ranking ───────────────────────────────────────────────────────────────

def _c(**kw):
    base = {"id": "v", "title": "t", "uploader": "u", "acodec": "opus", "abr": 130, "duration": 200}
    base.update(kw)
    return base


def test_opus_beats_legacy_aac_even_at_a_lower_bitrate():
    aac = _c(id="old", acodec="mp4a.40.2", abr=160)
    opus = _c(id="new", acodec="opus", abr=130)
    assert rank_search_candidates([aac, opus])[0]["id"] == "new"


def test_official_upload_wins_when_codecs_are_comparable():
    plain = _c(id="reupload", uploader="7clouds")
    official = _c(id="official", uploader="Artist - Topic")
    assert rank_search_candidates([plain, official])[0]["id"] == "official"


def test_officiality_never_overrides_a_materially_better_codec():
    # The trap flacfetch's heuristic invites: an "official" legacy-AAC upload must NOT beat a modern
    # Opus stream, because codec generation is the axis that survives into the instrumental.
    official_aac = _c(id="official-aac", uploader="Artist - Topic", acodec="mp4a.40.2", abr=128)
    plain_opus = _c(id="plain-opus", uploader="randomuser", acodec="opus", abr=128)
    assert rank_search_candidates([official_aac, plain_opus])[0]["id"] == "plain-opus"


def test_unusable_candidates_are_dropped_not_merely_deprioritised():
    good = _c(id="good")
    ranked = rank_search_candidates([
        {"id": "novideo-noaudio", "acodec": "none", "abr": 0},
        {"id": "missing-codec"},
        good,
    ])
    assert [c["id"] for c in ranked] == ["good"]


def test_ranking_is_deterministic_and_total():
    # Identical candidates must not reorder run to run (dict ordering / sort stability).
    a = _c(id="a")
    b = _c(id="b")
    assert [c["id"] for c in rank_search_candidates([a, b])] == ["a", "b"]
    assert [c["id"] for c in rank_search_candidates([b, a])] == ["b", "a"]


def test_empty_input_returns_empty_without_raising():
    assert rank_search_candidates([]) == []
