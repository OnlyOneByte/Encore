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
from encore_worker.adapters.ratelimit import RateLimiter

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
    # A gate that paces by ARITHMETIC ONLY. Without it this file pays the production 1 s/request interval
    # plus retry backoff on every 503 test — measured at 12 s. A status-ladder test must not wait on a clock.
    clock = [0.0]

    def sleep(seconds: float) -> None:
        clock[0] += seconds

    return LrclibClient(
        opener=FakeOpener(body=body, raises=raises),  # type: ignore[arg-type]
        gate=RateLimiter(now=lambda: clock[0], sleep=sleep),
    )


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


# ── the four things parse_lrc got wrong ───────────────────────────────────────────────────────────


def test_a_timestamp_only_line_ends_the_line_before_it() -> None:
    """The measured defect. A bare stamp is how a sheet writes "vocals stop here" before an instrumental
    break; skipping it ran the previous line's interpolated end to the next SUNG line — one claim window
    ran 14-40 s across a break and R1's claim-envelope correlation fell from 0.87 to 0.27."""
    cues = parse_lrc("[00:12.00] last line of the verse\n[00:14.00]\n[00:40.00] after the break\n")
    assert [c["text"] for c in cues] == ["last line of the verse", "after the break"]
    assert cues[0]["end"] == 14.0, "the boundary closes it, not the next sung line at 40 s"


def test_stacked_stamps_become_one_claim_each_and_never_a_lyric() -> None:
    """`[00:45.00][01:20.00] a chorus twice` used to publish `[01:20.00] a chorus twice` as the LINE —
    the second stamp arriving on screen as the line's opening word."""
    cues = parse_lrc("[00:45.00][01:20.00] a chorus twice\n[01:30.00] and on\n")
    assert [(c["start"], c["text"]) for c in cues] == [
        (45.0, "a chorus twice"),
        (80.0, "a chorus twice"),
        (90.0, "and on"),
    ]
    assert cues[0]["end"] == 80.0


def test_stacked_stamps_are_why_the_sort_is_not_optional() -> None:
    """A single line can emit a 65 s claim before the 13 s one that follows it in the file, so an LRC's
    events are out of order by CONSTRUCTION and not merely because a human edited it."""
    cues = parse_lrc("[00:45.00][01:20.00] chorus\n[00:50.00] a verse line\n")
    assert [c["start"] for c in cues] == [45.0, 50.0, 80.0]


def test_a2_word_tags_become_word_claims_rather_than_text() -> None:
    """An enhanced (A2) sheet times every word; the angle-bracket stamps used to be published INSIDE the
    lyric. Read as claims they make the sheet a word-timed candidate instead."""
    cues = parse_lrc("[01:30.00] <01:30.50> aaa <01:31.00> bbb <01:31.80> ccc\n[01:35.00] ddd\n")
    assert cues[0]["text"] == "aaa bbb ccc"
    words = cues[0]["words"]
    assert isinstance(words, tuple)
    assert [(w["word"], w["start"]) for w in words] == [("aaa", 90.5), ("bbb", 91.0), ("ccc", 91.8)]
    # The LAST word is closed by the LINE's end — the next event's start — exactly as the line is, because
    # `measure` reads a missing end as equal to the start and that is a zero-width window.
    assert [w.get("end") for w in words] == [91.0, 91.8, 95.0]


def test_the_trailing_end_tag_of_an_a2_line_closes_its_last_word() -> None:
    """THE STANDARD ENHANCED-LRC SHAPE: a line ends with a final stamp that marks
    the last word's END. The run after it holds no token, and dropping that run threw the stamp away, so
    every A2 line's last word claim was a zero-width window — while `cli._inline_words` closes its last
    word at the cue end for exactly this reason."""
    cues = parse_lrc("[00:10.00]<00:10.10>aaa <00:10.50>bbb <00:11.00>ccc<00:11.80>\n[00:12.00]ddd\n")
    words = cues[0]["words"]
    assert isinstance(words, tuple)
    assert [(w["word"], w["start"], w.get("end")) for w in words] == [
        ("aaa", 10.1, 10.5),
        ("bbb", 10.5, 11.0),
        ("ccc", 11.0, 11.8),
    ]
    assert cues[0]["end"] == 12.0, "the line's own end is the next event, and the word stops before it"


def test_the_last_line_of_a_sheet_leaves_its_last_word_open_like_the_line() -> None:
    """No next event, so there is no end to take — the same answer the LINE gives, rather than an invented
    one. A trailing tag still closes it when the sheet wrote one."""
    words = parse_lrc("[00:10.00]<00:10.10>aaa <00:10.50>bbb\n")[0]["words"]
    assert isinstance(words, tuple)
    assert "end" not in words[-1]


def test_a_line_with_no_word_tags_claims_no_word_timing() -> None:
    assert "words" not in parse_lrc(SYNCED)[0]


def test_a_tag_that_times_a_run_of_words_publishes_no_zero_width_claim() -> None:
    """The identical defect was fixed earlier in the sibling parser
    (`cli._inline_words`). Every token after the first in a tagged run was given the PREVIOUS
    token's start and ended where the next began, so all but the last read `start == end` — and the TV lights
    a word while `start <= pos < end`, which a zero-width span never satisfies. The run is apportioned across
    the room to the next onset by character count instead. The untagged HEAD run is the same shape, opening at
    the line's own stamp."""
    cues = parse_lrc("[00:10.00]aaa bb <00:11.00>cccc ddd <00:12.00>eee\n[00:20.00]zzz\n")
    words = cues[0]["words"]
    assert isinstance(words, tuple)
    assert [w["word"] for w in words] == ["aaa", "bb", "cccc", "ddd", "eee"]
    assert all(float(str(w["end"])) > float(str(w["start"])) for w in words), "no word can never be lit"
    assert float(str(words[0]["start"])) == 10.0, "the head run opens at the line's own stamp"
    assert float(str(words[1]["end"])) == 11.0, "and closes at the first tag the author wrote"
    assert float(str(words[2]["start"])) == 11.0, "a tagged token keeps the onset it was given"
    assert float(str(words[-1]["end"])) == 20.0, "the last run closes at the line's end"
    # BY CHARACTER COUNT, not evenly: `cccc` is four letters against `ddd`'s three, so it takes more of the
    # 1.0 s the two share (`presplit`'s and `parts._spread`'s measured reason).
    assert float(str(words[2]["end"])) == pytest.approx(11.0 + 1.0 * 4 / 7)


def test_a_stacked_lines_word_claims_belong_to_its_first_stamp_only() -> None:
    """`<mm:ss.xx>` is an ABSOLUTE time, so reading the tags once per stamp gave the
    65 s occurrence of a stacked line the 10 s occurrence's word claims verbatim — word times 55 s before
    their own line's start, which is the non-monotone claim stream the sort exists to prevent. The repeat
    stays LINE-timed: nobody timed those words."""
    cues = parse_lrc("[00:10.00][01:05.00]<00:10.10>aaa bbb <00:11.30>ccc\n[00:30.00]zzz\n")
    assert [(c["start"], c["text"]) for c in cues] == [
        (10.0, "aaa bbb ccc"),
        (30.0, "zzz"),
        (65.0, "aaa bbb ccc"),
    ]
    assert "words" in cues[0] and "words" not in cues[2]
    for cue in cues:
        words = cue.get("words")
        assert isinstance(words, tuple) or words is None
        for word in words or ():
            assert float(str(word["start"])) >= float(str(cue["start"])), "no claim before its own line"


def test_the_offset_tag_is_honoured_and_a_positive_one_moves_the_lyrics_earlier() -> None:
    """THE SIGN IS THE SPEC'S: `[offset:+500]` makes the lyrics appear SOONER, so it is subtracted. The tag
    exists because the sheet was timed against a different master; ignoring it kept a stated error."""
    cues = parse_lrc("[offset:+500]\n[00:10.00] a\n[00:20.00] b\n")
    assert [c["start"] for c in cues] == [9.5, 19.5]
    assert cues[0]["end"] == 19.5, "the interpolated end moves with the stamp it was read from"
    assert parse_lrc("[offset:-2000]\n[00:10.00] a\n[00:20.00] b\n")[0]["start"] == 12.0


def test_an_offset_cannot_push_a_claim_before_zero() -> None:
    """A negative claim start is a claim no clock can map."""
    assert parse_lrc("[offset:+5000]\n[00:01.00] a\n[00:20.00] b\n")[0]["start"] == 0.0


def test_the_offset_moves_word_edges_too() -> None:
    """Shifting only starts left a word ending before the next one began — an `out_of_order` reading
    manufactured by the fix for the offset."""
    cues = parse_lrc("[offset:+500]\n[01:30.00] <01:30.50> hold <01:31.00> me\n[01:40.00] next\n")
    words = cues[0]["words"]
    assert isinstance(words, tuple)
    assert [(w["word"], w["start"], w.get("end")) for w in words] == [
        ("hold", 90.0, 90.5),
        ("me", 90.5, 99.5),
    ]


def test_an_unparseable_offset_is_ignored_rather_than_fatal() -> None:
    assert parse_lrc("[offset:later]\n[00:10.00] a\n")[0]["start"] == 10.0


# ── an LRCLIB duration miss is retried without the duration ───────────────────────────────────────


class ScriptedOpener:
    """An opener that answers each request from a queue, so a RETRY can be observed."""

    def __init__(self, *bodies: str | Exception) -> None:
        self._bodies = list(bodies)
        self.opened: list[str] = []

    def open(self, request: object, timeout: float | None = None) -> FakeResponse:
        self.opened.append(getattr(request, "full_url", str(request)))
        answer = self._bodies.pop(0) if self._bodies else "{}"
        if isinstance(answer, Exception):
            raise answer
        return FakeResponse(answer)


def scripted(*bodies: str | Exception) -> tuple[LrclibClient, ScriptedOpener]:
    clock = [0.0]
    opener = ScriptedOpener(*bodies)
    return (
        LrclibClient(
            opener=opener,  # type: ignore[arg-type]
            gate=RateLimiter(now=lambda: clock[0], sleep=lambda s: clock.__setitem__(0, clock[0] + s)),
        ),
        opener,
    )


def missing() -> urllib.error.HTTPError:
    return urllib.error.HTTPError("u", 404, "Not Found", {}, None)  # type: ignore[arg-type]


def test_a_duration_miss_is_retried_without_the_duration() -> None:
    """LRCLIB matches within ±2 s and the duration this worker measures is the UPLOAD's: a music
    video with an intro, an outro or a spoken skit is minutes longer than the track, so the qualified
    lookup 404s and a perfectly good human sheet is one request away."""
    api, opener = scripted(missing(), json.dumps({"syncedLyrics": SYNCED}))
    cues = api.fetch(artist="a-ha", track="Take On Me", duration_sec=420.0)

    assert len(cues) == 3
    assert len(opener.opened) == 2
    assert "duration=420" in opener.opened[0]
    assert "duration" not in opener.opened[1], "the retry must drop it, not merely change it"


def test_a_hit_is_not_retried() -> None:
    api, opener = scripted(json.dumps({"syncedLyrics": SYNCED}))
    assert api.fetch(artist="a", track="b", duration_sec=225.0)
    assert len(opener.opened) == 1


def test_a_lookup_that_sent_no_duration_is_not_retried() -> None:
    """There is nothing to drop, so a second identical request would only cost the provider."""
    api, opener = scripted(missing())
    assert api.fetch(artist="a", track="b", duration_sec=None) == ()
    assert len(opener.opened) == 1


def test_both_misses_are_still_a_miss_and_not_an_outage() -> None:
    api, opener = scripted(missing(), missing())
    assert api.fetch(artist="a", track="b", duration_sec=225.0) == ()
    assert len(opener.opened) == 2


def test_the_retry_does_not_swallow_a_provider_failure() -> None:
    """A 500 on the second request is still an outage: only a 404 earns the retry, and only once."""
    failed = urllib.error.HTTPError("u", 503, "nope", {}, None)  # type: ignore[arg-type]
    api, _opener = scripted(missing(), failed, failed, failed, failed)
    with pytest.raises(ProviderUnreachable):
        api.fetch(artist="a", track="b", duration_sec=225.0)
