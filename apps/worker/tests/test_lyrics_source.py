"""LRCLIB lyrics source (known-text stage) — pure LRC parse/segment/shape + the injectable-fetcher
client. No network (this box DNS-sinkholes lrclib.net; the real fetch is deferred to the deploy box)."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.lyrics import source as ls  # noqa: E402


# ── LRC parsing ──────────────────────────────────────────────────────────────────
LRC = """[ar:a-ha]
[ti:Take On Me]
[length:03:45]
[00:18.50]Talking away
[00:21.90]I don't know what I'm to say
[00:25.30]I'll say it anyway
[00:29.00]
[00:32.10]Today's another day to find you
"""


def test_parse_lrc_extracts_timed_lines_skips_metadata():
    entries = ls.parse_lrc(LRC)
    # metadata tags ([ar:]/[ti:]/[length:]) are skipped; 5 timed lines remain (incl. the blank gap)
    assert [round(e.start, 2) for e in entries] == [18.5, 21.9, 25.3, 29.0, 32.1]
    assert entries[0].text == "Talking away"
    assert entries[3].text == ""  # blank gap marker kept (bounds the prior line)


def test_parse_lrc_timestamp_fraction_forms():
    # [mm:ss], [mm:ss.xx] centis, [mm:ss.xxx] millis, and the [mm:ss:xx] colon variant
    e = ls.parse_lrc("[01:02]A\n[00:05.5]B\n[00:05.50]C\n[00:05.500]D\n[00:07:25]E")
    starts = {x.text: round(x.start, 3) for x in e}
    assert starts["A"] == 62.0
    assert starts["B"] == starts["C"] == starts["D"] == 5.5  # 5 / 50 / 500 all → 0.5s
    assert starts["E"] == 7.25  # colon-frac variant


def test_parse_lrc_multi_timestamp_line():
    # one text repeated at several timestamps (a repeated chorus line)
    e = ls.parse_lrc("[00:10.00][00:47.00][01:24.00]repeat me")
    assert [round(x.start) for x in e] == [10, 47, 84]
    assert all(x.text == "repeat me" for x in e)


def test_parse_lrc_offset_tag_shifts_earlier_and_clamps():
    # [offset:+500] → lyrics display 500ms EARLIER (subtract); clamp at 0
    e = ls.parse_lrc("[offset:+500]\n[00:02.00]late\n[00:00.20]early")
    by = {x.text: x.start for x in e}
    assert by["late"] == 1.5  # 2.0 - 0.5
    assert by["early"] == 0.0  # 0.2 - 0.5 → clamped to 0
    # entries come back time-sorted
    assert [x.start for x in e] == sorted(x.start for x in e)


# ── segment building ───────────────────────────────────────────────────────────────
def test_entries_to_segments_end_is_next_start():
    entries = [ls.LrcEntry(1.0, "one"), ls.LrcEntry(3.0, "two"), ls.LrcEntry(6.0, "three")]
    segs = ls.entries_to_segments(entries, total_duration=10.0)
    assert segs == [
        {"start": 1.0, "end": 3.0, "text": "one"},
        {"start": 3.0, "end": 6.0, "text": "two"},
        {"start": 6.0, "end": 10.0, "text": "three"},  # last runs to total_duration
    ]


def test_entries_to_segments_blank_gap_caps_prior_line_and_is_dropped():
    entries = [ls.LrcEntry(1.0, "sing"), ls.LrcEntry(3.0, ""), ls.LrcEntry(8.0, "again")]
    segs = ls.entries_to_segments(entries, total_duration=12.0)
    # the blank at 3.0 bounds "sing" (end=3.0) but is itself dropped (no text)
    assert segs == [
        {"start": 1.0, "end": 3.0, "text": "sing"},
        {"start": 8.0, "end": 12.0, "text": "again"},
    ]


def test_entries_to_segments_unknown_duration_last_line_gets_min():
    segs = ls.entries_to_segments([ls.LrcEntry(1.0, "only")], total_duration=None, min_line_sec=0.5)
    assert segs == [{"start": 1.0, "end": 1.5, "text": "only"}]


def test_plain_lyrics_to_segments_evenly_distributes():
    segs = ls.plain_lyrics_to_segments("l1\n\nl2\nl3\n", total_duration=30.0)
    assert [s["text"] for s in segs] == ["l1", "l2", "l3"]
    assert segs[0]["start"] == 0.0 and segs[0]["end"] == 10.0
    assert segs[2]["start"] == 20.0 and segs[2]["end"] == 30.0
    assert ls.plain_lyrics_to_segments("", 30.0) == []


# ── line-synced artifact shape ───────────────────────────────────────────────────────
def test_line_synced_lyrics_shape_and_validity():
    segs = ls.entries_to_segments([ls.LrcEntry(1.0, "a"), ls.LrcEntry(2.0, "b")], total_duration=3.0)
    doc = ls.line_synced_lyrics(segs, language="en")
    assert doc["language"] == "en"
    assert [l["text"] for l in doc["lines"]] == ["a", "b"]
    assert all(l["words"] == [] for l in doc["lines"])  # line-synced → NO word timings
    assert doc["words"] == []
    assert ls.is_line_synced(doc) is True  # ≥1 line with numeric start + text (words NOT required)
    assert ls.is_line_synced({"lines": []}) is False
    assert ls.is_line_synced({"lines": [{"text": "x"}]}) is False  # no numeric start


# ── LRCLIB URL + response parse ──────────────────────────────────────────────────────
def test_lrclib_get_url_encodes_and_rounds_duration():
    url = ls.lrclib_get_url("https://lrclib.net", "a-ha", "Take On Me", duration=225.4)
    assert url.startswith("https://lrclib.net/api/get?")
    assert "artist_name=a-ha" in url and "track_name=Take+On+Me" in url and "duration=225" in url


def test_parse_lrclib_response():
    r = ls.parse_lrclib_response({"id": 42, "instrumental": False, "syncedLyrics": "[00:01.00]hi", "plainLyrics": "hi"})
    assert r.id == 42 and r.instrumental is False and r.has_synced and r.has_plain
    inst = ls.parse_lrclib_response({"id": 9, "instrumental": True, "syncedLyrics": None, "plainLyrics": None})
    assert inst.instrumental and not inst.has_synced and not inst.has_plain


# ── LrclibClient with an injected fetcher (no network) ────────────────────────────────
def fetcher_returning(status, body):
    calls = []

    def f(url, headers):
        calls.append((url, headers))
        return status, body

    f.calls = calls  # type: ignore[attr-defined]
    return f


def test_client_get_success():
    body = '{"id":1,"instrumental":false,"syncedLyrics":"[00:01.00]hi","plainLyrics":"hi"}'
    f = fetcher_returning(200, body)
    client = ls.LrclibClient(fetcher=f)
    res = client.get("a-ha", "Take On Me", duration=225)
    assert res is not None and res.has_synced
    # the request carried a UA identifying Encore (LRCLIB etiquette)
    assert "Encore" in f.calls[0][1]["User-Agent"]  # type: ignore[attr-defined]


def test_client_get_404_returns_none():
    assert ls.LrclibClient(fetcher=fetcher_returning(404, "")).get("x", "y") is None


# ── search: a POOL of records, because one song has several recordings ────────────────

SEARCH_BODY = (
    "["
    '{"id":11,"instrumental":false,"syncedLyrics":"[00:01.00]solo","plainLyrics":"solo",'
    '"trackName":"Telephone","artistName":"Lady Gaga","albumName":"The Fame Monster","duration":218},'
    '{"id":12,"instrumental":false,"syncedLyrics":"[00:01.00]feat","plainLyrics":"feat",'
    '"trackName":"Telephone","artistName":"Lady Gaga feat. Beyoncé","albumName":"The Fame Monster","duration":243}'
    "]"
)


def test_client_search_returns_every_record_with_its_own_metadata():
    """The metadata is the whole reason to search: with two records under one artist+track, `artistName`
    and `duration` are the only things distinguishing the versions."""
    res = ls.LrclibClient(fetcher=fetcher_returning(200, SEARCH_BODY)).search("Lady Gaga", "Telephone")
    assert [r.id for r in res] == [11, 12]
    assert res[1].artist_name == "Lady Gaga feat. Beyoncé"
    assert res[1].duration == 243.0
    assert res[0].album_name == "The Fame Monster"


def test_client_search_hits_the_search_endpoint_with_the_encore_user_agent():
    f = fetcher_returning(200, SEARCH_BODY)
    ls.LrclibClient(fetcher=f).search("Lady Gaga", "Telephone")
    url, headers = f.calls[0]  # type: ignore[attr-defined]
    assert "/api/search?" in url
    assert "Encore" in headers["User-Agent"]  # LRCLIB etiquette, same as get()


def test_client_search_404_and_empty_array_are_both_just_a_miss():
    """Neither is an error: the caller falls back exactly as it would for a get() miss."""
    assert ls.LrclibClient(fetcher=fetcher_returning(404, "")).search("x", "y") == []
    assert ls.LrclibClient(fetcher=fetcher_returning(200, "[]")).search("x", "y") == []


def test_client_search_tolerates_a_shape_it_does_not_recognise():
    """An object where an array was expected is a miss, not a job failure — a provider changing its
    response shape must not stop songs cooking."""
    assert ls.LrclibClient(fetcher=fetcher_returning(200, '{"id":1}')).search("x", "y") == []
    assert ls.LrclibClient(fetcher=fetcher_returning(200, "[1,2,null]")).search("x", "y") == []


def test_client_search_non_200_raises_like_get():
    with pytest.raises(ls.LyricsFetchError):
        ls.LrclibClient(fetcher=fetcher_returning(500, "")).search("x", "y")


def test_client_search_unparseable_body_raises():
    with pytest.raises(ls.LyricsFetchError):
        ls.LrclibClient(fetcher=fetcher_returning(200, "not json")).search("x", "y")


def test_client_get_non_200_raises():
    with pytest.raises(ls.LyricsFetchError):
        ls.LrclibClient(fetcher=fetcher_returning(500, "")).get("x", "y")


def test_client_get_unparseable_body_raises():
    with pytest.raises(ls.LyricsFetchError):
        ls.LrclibClient(fetcher=fetcher_returning(200, "<html>not json</html>")).get("x", "y")


# ── the DNS-sinkhole gap (#444): a URLError must NOT vanish as an ordinary miss ────────
def test_urllib_fetch_converts_urlerror_to_lyricsfetcherror(monkeypatch):
    """A DNS sinkhole (or refused connection / TLS failure / timeout) raises urllib.error.URLError,
    which carries NO HTTP status. Before #444 `_urllib_fetch` caught only HTTPError, so a URLError
    escaped to LyricsSource's bare `except Exception` and became a plain None — indistinguishable from
    "this song has no lyrics", which is exactly how lrclib.net failing 100% for a month stayed invisible.
    Now it must surface as the one explicit transport class the chain already routes to a note."""
    import urllib.error

    def boom(*_a, **_k):
        raise urllib.error.URLError("Name or service not known")

    monkeypatch.setattr("urllib.request.urlopen", boom)
    with pytest.raises(ls.LyricsFetchError) as ei:
        ls._urllib_fetch("https://lrclib.net/api/get?x=1", {"User-Agent": ls.USER_AGENT})
    assert "unreachable" in str(ei.value)


def test_urllib_fetch_still_maps_httperror_to_its_status(monkeypatch):
    """Regression guard on the ordering: HTTPError is a URLError subclass, so the new URLError arm
    must not steal an HTTP status — a 503 still comes back as (503, "") for the status ladder."""
    import urllib.error

    def http503(*_a, **_k):
        raise urllib.error.HTTPError("https://lrclib.net", 503, "busy", {}, None)  # type: ignore[arg-type]

    monkeypatch.setattr("urllib.request.urlopen", http503)
    status, body = ls._urllib_fetch("https://lrclib.net/api/get?x=1", {"User-Agent": ls.USER_AGENT})
    assert status == 503 and body == ""
