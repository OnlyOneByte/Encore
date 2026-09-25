"""The LRCmux adapter.

Two things carry the weight here. **Milliseconds to seconds**, because getting it wrong would not fail —
it would publish lyrics running a thousand times fast, which looks like a player bug. And the **three-way
status split**, measured against the live API rather than read off the spec (which declares only 200 and
default): 404 is a miss, 400 is our own malformed request, anything else is provider trouble.

The payload fixture below is the real shape returned for "Take On Me", trimmed — including that word
`text` values carry trailing spaces, which is how the provider encodes separation.
"""

from __future__ import annotations

import json
import urllib.error

import pytest

from encore_worker.adapters.lrcmux import (
    BadRequest,
    LrcmuxClient,
    ProviderUnreachable,
    build_provider,
    build_url,
    parse_response,
)
from encore_worker.domain.document import TIMING_LINE, TIMING_WORD

#: Trimmed from a real response. Times are INTEGER MILLISECONDS.
WORD_LEVEL = {
    "track": {"artist": "a-ha", "title": "Take on Me", "album": "Hunting High and Low", "duration": 227},
    "meta": {"level": "word", "source": {"id": "kugou", "name": "KuGou"}},
    "lines": [
        {
            "text": "Talking away",
            "start": 43004,
            "end": 44284,
            "words": [
                {"text": "Talking ", "start": 43004, "end": 43824},
                {"text": "away", "start": 43824, "end": 44284},
            ],
        },
        {"text": "I don't know what I'm to say", "start": 45130, "end": 47670},
    ],
}

LINE_LEVEL = {
    "meta": {"level": "line", "source": {"id": "lrclib", "name": "LRCLIB"}},
    "lines": [{"text": "first", "start": 1000, "end": 2500}, {"text": "second", "start": 2500}],
}


# ── the URL ──────────────────────────────────────────────────────────────────────────────────────


def test_the_lookup_asks_for_json_and_the_best_sync_level() -> None:
    url = build_url("https://api.lrcmux.test", artist="a-ha", track="Take On Me")
    assert url.startswith("https://api.lrcmux.test/get?")
    assert "artist=a-ha" in url
    assert "title=Take+On+Me" in url
    assert "format=json" in url
    assert "level=word" in url


def test_strict_is_never_sent() -> None:
    """`level=word` falls back on its own. Setting `strict` would turn a line-timed hit into a 404, and a
    line-timed sheet is far better than no sheet — the search's knobs handle it perfectly well."""
    assert "strict" not in build_url("https://l.test", artist="a", track="b")


def test_duration_is_sent_as_integer_seconds() -> None:
    assert "duration=225" in build_url("https://l.test", artist="a", track="b", duration_sec=225.4)


def test_an_unknown_duration_is_omitted() -> None:
    for unknown in (None, 0.0, -5.0):
        assert "duration" not in build_url("https://l.test", artist="a", track="b", duration_sec=unknown)


def test_sources_restriction_is_passed_through() -> None:
    """Lets an operator exclude a provider that keeps returning the wrong master."""
    assert "sources=%21kugou" in build_url("https://l.test", artist="a", track="b", sources="!kugou")


# ── milliseconds ─────────────────────────────────────────────────────────────────────────────────


def test_line_times_are_converted_from_milliseconds() -> None:
    """THE conversion that cannot be wrong. 43004 ms is 43 seconds, not 43004."""
    result = parse_response(json.dumps(WORD_LEVEL))
    assert result.segments[0]["start"] == 43.004
    assert result.segments[0]["end"] == 44.284


def test_word_times_are_converted_too() -> None:
    result = parse_response(json.dumps(WORD_LEVEL))
    words = result.segments[0]["words"]
    assert isinstance(words, tuple)
    assert words[0]["start"] == 43.004
    assert words[1]["end"] == 44.284


def test_a_boolean_time_is_rejected_not_read_as_one_millisecond() -> None:
    """`True` is an `int`, so an unguarded conversion would place the line at 0.001s."""
    payload = {"meta": {"level": "line"}, "lines": [{"text": "x", "start": True}]}
    assert "start" not in parse_response(json.dumps(payload)).segments[0]


# ── sync level ───────────────────────────────────────────────────────────────────────────────────


def test_word_spans_make_it_word_timed() -> None:
    assert parse_response(json.dumps(WORD_LEVEL)).timing == TIMING_WORD


def test_starts_without_word_spans_make_it_line_timed() -> None:
    assert parse_response(json.dumps(LINE_LEVEL)).timing == TIMING_LINE


def test_the_declared_level_is_not_trusted_over_the_payload() -> None:
    """A response tagged `word` whose lines carry no word spans is not word-timed, and believing the tag
    would offer retry knobs with nothing to act on."""
    lying = {"meta": {"level": "word"}, "lines": [{"text": "x", "start": 1000}]}
    assert parse_response(json.dumps(lying)).timing == TIMING_LINE


def test_a_level_of_none_is_not_reported_as_word_timed() -> None:
    unsynced = {"meta": {"level": "none"}, "lines": [{"text": "x"}]}
    assert parse_response(json.dumps(unsynced)).timing is None


def test_untimed_lines_still_count_as_a_text() -> None:
    """A plain sheet is real words; forced alignment can time it from scratch."""
    result = parse_response(json.dumps({"meta": {"level": "none"}, "lines": [{"text": "words here"}]}))
    assert len(result.segments) == 1
    assert result.timing is None


# ── source and instrumental ──────────────────────────────────────────────────────────────────────


def test_the_upstream_source_is_recorded() -> None:
    """A systematically bad source must be identifiable rather than anonymous behind the multiplexer."""
    assert parse_response(json.dumps(WORD_LEVEL)).source == "KuGou"


def test_the_source_falls_back_to_its_id() -> None:
    payload = {"meta": {"level": "line", "source": {"id": "kugou"}}, "lines": [{"text": "x"}]}
    assert parse_response(json.dumps(payload)).source == "kugou"


def test_an_explicitly_instrumental_track_yields_nothing_but_says_so() -> None:
    payload = {"meta": {"level": "none", "instrumental": True}, "lines": [{"text": "la"}]}
    result = parse_response(json.dumps(payload))
    assert result.segments == ()
    assert result.instrumental is True


# ── malformed payloads ───────────────────────────────────────────────────────────────────────────


def test_every_malformed_payload_is_survived() -> None:
    for body in (
        "",
        "not json",
        "[]",
        "null",
        "{}",
        '{"lines": null}',
        '{"lines": []}',
        '{"lines": "nope"}',
        '{"lines": [null, 7]}',
        '{"lines": [{}]}',
        '{"lines": [{"text": "  "}]}',
        '{"meta": "not an object", "lines": [{"text": "x"}]}',
    ):
        result = parse_response(body)
        assert isinstance(result.segments, tuple)


def test_a_word_entry_with_no_start_is_dropped() -> None:
    payload = {
        "meta": {"level": "word"},
        "lines": [{"text": "x", "start": 0, "words": [{"text": "a"}, {"text": "b", "start": 500}]}],
    }
    words = parse_response(json.dumps(payload)).segments[0]["words"]
    assert isinstance(words, tuple)
    assert len(words) == 1


def test_word_text_is_stripped_of_the_providers_separator_space() -> None:
    """The provider encodes separation as a trailing space; a span labelled "Talking " would show up in a
    smear report with a spurious space."""
    words = parse_response(json.dumps(WORD_LEVEL)).segments[0]["words"]
    assert isinstance(words, tuple)
    assert words[0]["word"] == "Talking"


# ── the three-way status split ───────────────────────────────────────────────────────────────────


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
    """Injected, so nothing patches a library function and no socket is opened."""

    def __init__(self, *, body: str | None = None, raises: Exception | None = None) -> None:
        self._body = body
        self._raises = raises
        self.opened: list[str] = []

    def open(self, request: object, timeout: float | None = None) -> FakeResponse:
        self.opened.append(getattr(request, "full_url", str(request)))
        if self._raises is not None:
            raise self._raises
        return FakeResponse(self._body or "{}")


def client(*, body: str | None = None, raises: Exception | None = None) -> LrcmuxClient:
    return LrcmuxClient(opener=FakeOpener(body=body, raises=raises))  # type: ignore[arg-type]


def http(status: int, detail: str) -> urllib.error.HTTPError:
    import io

    body = io.BytesIO(json.dumps({"status": status, "detail": detail}).encode())
    return urllib.error.HTTPError("u", status, "err", {}, body)  # type: ignore[arg-type]


def test_a_trailing_slash_on_the_base_does_not_double_up() -> None:
    """Asserted through the REQUEST rather than a private attribute, so it checks what the server sees."""
    opener = FakeOpener(body="{}")
    LrcmuxClient(base_url="https://l.test/", opener=opener).fetch(  # type: ignore[arg-type]
        artist="a", track="b", duration_sec=None
    )
    assert opener.opened[0].startswith("https://l.test/get?"), opener.opened[0]


def test_a_hit_returns_segments() -> None:
    cues = client(body=json.dumps(WORD_LEVEL)).fetch(artist="a-ha", track="Take On Me", duration_sec=227)
    assert len(cues) == 2


def test_the_last_source_is_exposed_for_the_decision_trail() -> None:
    got = client(body=json.dumps(WORD_LEVEL))
    got.fetch(artist="a-ha", track="Take On Me", duration_sec=227)
    assert got.last_source == "KuGou"


def test_a_404_is_a_MISS() -> None:
    """`{"detail": "no lyrics found"}` — an ordinary outcome for an obscure track."""
    assert client(raises=http(404, "no lyrics found")).fetch(artist="a", track="b", duration_sec=None) == ()


def test_a_400_is_OUR_bug_and_is_not_retryable() -> None:
    """The same malformed request sent again is still malformed."""
    with pytest.raises(BadRequest, match="rejected the request"):
        client(raises=http(400, "provide either ISRC or both artist and title")).fetch(
            artist="a", track="b", duration_sec=None
        )
    assert BadRequest.retryable is False


@pytest.mark.parametrize("status", [429, 500, 502, 503])
def test_anything_else_is_provider_trouble_and_is_retryable(status: int) -> None:
    with pytest.raises(ProviderUnreachable, match=str(status)):
        client(raises=http(status, "upstream died")).fetch(artist="a", track="b", duration_sec=None)
    assert ProviderUnreachable.retryable is True


def test_the_error_detail_reaches_the_message() -> None:
    """A message worth reading: the RFC7807 `detail` says which upstream failed and why."""
    with pytest.raises(ProviderUnreachable, match="upstream died"):
        client(raises=http(503, "upstream died")).fetch(artist="a", track="b", duration_sec=None)


def test_a_network_failure_raises() -> None:
    with pytest.raises(ProviderUnreachable, match="unreachable"):
        client(raises=urllib.error.URLError("no route to host")).fetch(
            artist="a", track="b", duration_sec=None
        )


def test_a_lookup_without_both_fields_is_refused_before_any_request() -> None:
    """A lookup on a guessed title returns another song's words. Refusing locally also means the 400
    branch should be unreachable in practice."""
    opener = FakeOpener(body="{}")
    got = LrcmuxClient(opener=opener)  # type: ignore[arg-type]
    for artist, track in (("", "b"), ("a", ""), ("", "")):
        with pytest.raises(BadRequest):
            got.fetch(artist=artist, track=track, duration_sec=None)
    assert opener.opened == [], "no request should have been sent at all"


def test_the_provider_can_be_turned_off() -> None:
    assert build_provider(enabled=False) is None
    assert build_provider(enabled=True) is not None
