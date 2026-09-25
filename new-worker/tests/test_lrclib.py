"""The LRCLIB adapter: URL shape, payload parsing, and the miss-versus-unreachable distinction.

No network. The URL builder and both parsers are pure, and the one method that does I/O is tested with a
fake opener, because the behaviour that matters is which HTTP status counts as "this song is not here"
versus "this provider is down" — and the old worker conflated them for a month.
"""

from __future__ import annotations

import json
import urllib.error

import pytest

from encore_worker.adapters.lrclib import (
    LrclibClient,
    ProviderUnreachable,
    build_provider,
    build_url,
    parse_lrc,
    parse_response,
)

# ── the URL ──────────────────────────────────────────────────────────────────────────────────────


def test_the_lookup_carries_artist_and_track() -> None:
    url = build_url("https://lrclib.test/api/get", artist="a-ha", track="Take On Me")
    assert "artist_name=a-ha" in url
    assert "track_name=Take+On+Me" in url


def test_duration_is_sent_when_known() -> None:
    """LRCLIB uses it to tell a single edit from an album version — exactly the "right song, wrong
    master" case that produces confidently misplaced lyrics downstream."""
    url = build_url("https://l.test/get", artist="a", track="b", duration_sec=225.4)
    assert "duration=225" in url, "integer seconds; a fractional value is noise to the matcher"


def test_an_unknown_duration_is_omitted_not_zeroed() -> None:
    """A duration of 0 would ask LRCLIB to match a zero-length recording and miss every time."""
    for unknown in (None, 0.0, -1.0):
        assert "duration" not in build_url("https://l.test/get", artist="a", track="b", duration_sec=unknown)


def test_special_characters_are_escaped() -> None:
    url = build_url("https://l.test/get", artist="AC/DC", track="T.N.T. & more")
    assert "AC%2FDC" in url
    assert " " not in url


# ── the payload ──────────────────────────────────────────────────────────────────────────────────

SYNCED = "[00:01.00] first line\n[00:05.50] second line\n[00:09.00] third line\n"


def test_synced_lyrics_are_preferred() -> None:
    """A synced sheet gives line timings, which is what makes LINE_SYNC and RESHIFT available at all."""
    body = json.dumps({"syncedLyrics": SYNCED, "plainLyrics": "first line\nsecond line"})
    cues = parse_response(body)
    assert cues[0]["start"] == 1.0
    assert cues[0]["text"] == "first line"


def test_plain_lyrics_are_a_fallback_not_a_failure() -> None:
    """Force alignment can time a plain sheet from scratch; discarding it would throw away a real
    candidate and drop the song to the ASR tier for no reason."""
    cues = parse_response(json.dumps({"plainLyrics": "one\ntwo\n\nthree\n"}))
    assert [c["text"] for c in cues] == ["one", "two", "three"]
    assert all("start" not in c for c in cues), "a plain sheet carries no timings to invent"


def test_an_explicitly_instrumental_track_yields_nothing() -> None:
    """LRCLIB stating positively that a track has no words is a real answer — and the ASR tier will
    confirm it by hearing nothing."""
    assert parse_response(json.dumps({"instrumental": True, "plainLyrics": "la la"})) == ()


def test_an_empty_or_malformed_payload_yields_nothing() -> None:
    for body in ("", "not json", "[]", "null", "{}", json.dumps({"syncedLyrics": "   "})):
        assert parse_response(body) == ()


def test_a_synced_field_with_no_parseable_lines_falls_back_to_plain() -> None:
    """Otherwise a sheet of pure metadata tags would beat a perfectly good plain body."""
    body = json.dumps({"syncedLyrics": "[ar:Someone]\n[by:Nobody]\n", "plainLyrics": "real words here"})
    assert [c["text"] for c in parse_response(body)] == ["real words here"]


# ── LRC parsing ──────────────────────────────────────────────────────────────────────────────────


def test_parses_timestamps_and_interpolates_ends() -> None:
    """LRC carries only starts, so each line's end is the next line's start."""
    cues = parse_lrc(SYNCED)
    assert len(cues) == 3
    assert cues[0] == {"start": 1.0, "end": 5.5, "text": "first line"}


def test_the_final_line_gets_no_fabricated_end() -> None:
    """`measure` reads a missing end as equal to the start — a flash, which is honest. A guessed
    duration would be a number nobody measured."""
    assert "end" not in parse_lrc(SYNCED)[-1]


def test_fraction_scale_follows_its_digit_count() -> None:
    """`[00:01.5]`, `[00:01.50]` and `[00:01.500]` are all one and a half seconds. Reading the digits as
    hundredths regardless would make a thousandths sheet run ten times fast."""
    assert parse_lrc("[00:01.5] x")[0]["start"] == 1.5
    assert parse_lrc("[00:01.50] x")[0]["start"] == 1.5
    assert parse_lrc("[00:01.500] x")[0]["start"] == 1.5


def test_a_missing_fraction_is_whole_seconds() -> None:
    assert parse_lrc("[01:30] x")[0]["start"] == 90.0


def test_metadata_tags_and_empty_markers_are_dropped() -> None:
    """An LRC's untimed lines are tags and section markers, not lyrics — putting a credit on screen
    mid-song is worse than dropping it."""
    cues = parse_lrc("[ar:Artist]\n[by:Someone]\n[00:10.00]\n[00:12.00] actual words\n")
    assert [c["text"] for c in cues] == ["actual words"]


def test_out_of_order_lines_are_sorted() -> None:
    """An LRC is a text file a human edited. An unsorted series would be measured as out-of-order and
    refused as incoherent word timing — losing a sheet over a formatting artefact."""
    cues = parse_lrc("[00:09.00] third\n[00:01.00] first\n[00:05.00] second\n")
    assert [c["text"] for c in cues] == ["first", "second", "third"]
    starts = [c["start"] for c in cues]
    assert starts == sorted(starts)  # type: ignore[type-var]


def test_long_timestamps_past_an_hour_parse() -> None:
    """A DJ mix or a live set is longer than 99 minutes."""
    assert parse_lrc("[100:30.00] x")[0]["start"] == 6030.0


def test_an_empty_body_yields_nothing() -> None:
    assert parse_lrc("") == ()
    assert parse_lrc("no timestamps here\n") == ()


# ── miss versus unreachable ──────────────────────────────────────────────────────────────────────


class FakeResponse:
    def __init__(self, body: str) -> None:
        self._body = body.encode()

    def read(self) -> bytes:
        return self._body

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


class FakeOpener:
    """An opener that answers from a script. Injected, so nothing patches a library function.

    The previous version of these tests monkeypatched `urllib.request.urlopen`; when the client started
    building its own opener the patch silently stopped intercepting and four tests began making live HTTP
    calls. They still passed, just slower and against a third party's uptime. `tests/conftest.py` now
    blocks the socket outright so that cannot recur.
    """

    def __init__(self, *, body: str | None = None, raises: Exception | None = None) -> None:
        self._body = body
        self._raises = raises
        self.opened: list[str] = []

    def open(self, request: object, timeout: float | None = None) -> FakeResponse:
        self.opened.append(getattr(request, "full_url", str(request)))
        if self._raises is not None:
            raise self._raises
        return FakeResponse(self._body or "{}")


def client(*, body: str | None = None, raises: Exception | None = None) -> LrclibClient:
    return LrclibClient(opener=FakeOpener(body=body, raises=raises))  # type: ignore[arg-type]


def test_a_hit_returns_segments() -> None:
    cues = client(body=json.dumps({"syncedLyrics": SYNCED})).fetch(
        artist="a-ha", track="Take On Me", duration_sec=225.0
    )
    assert len(cues) == 3


def test_a_404_is_a_MISS_and_returns_empty() -> None:
    """An obscure track LRCLIB has never heard of is an ordinary outcome, not an error."""
    missing = urllib.error.HTTPError("u", 404, "Not Found", {}, None)  # type: ignore[arg-type]
    assert client(raises=missing).fetch(artist="a", track="b", duration_sec=None) == ()


@pytest.mark.parametrize("status", [429, 500, 502, 503])
def test_any_other_status_RAISES(status: int) -> None:
    """THE distinction that matters. A provider that is down must be visible: the old worker had LRCLIB
    fail for a month and it was indistinguishable from a library of instrumentals."""
    failed = urllib.error.HTTPError("u", status, "nope", {}, None)  # type: ignore[arg-type]
    with pytest.raises(ProviderUnreachable, match=str(status)):
        client(raises=failed).fetch(artist="a", track="b", duration_sec=None)


def test_a_network_failure_raises() -> None:
    with pytest.raises(ProviderUnreachable, match="unreachable"):
        client(raises=urllib.error.URLError("no route to host")).fetch(
            artist="a", track="b", duration_sec=None
        )


def test_unreachable_is_retryable() -> None:
    """A transient network failure is the common case, and the align ladder has ASR behind it anyway."""
    assert ProviderUnreachable.retryable is True


def test_the_provider_can_be_turned_off() -> None:
    """An offline LAN deployment should not spend eight seconds per song on a host it cannot reach."""
    assert build_provider(enabled=False) is None
    assert build_provider(enabled=True) is not None
