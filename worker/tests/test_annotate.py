"""MusicBrainz annotation: identify a downloaded song, or refuse.

Fixtures are TRIMMED CAPTURES of the real service (a-ha / "Take On Me"), not invented shapes \u2014
including two things that would break a from-the-docs implementation: the artist comes back with a
UNICODE HYPHEN (U+2010), so a raw string comparison rejects the correct recording; and the top three
recordings all score 100 while their lengths differ by 110 seconds, so MusicBrainz's own score cannot
separate a single from an album cut and duration has to do the work.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src import ratelimit as gate  # the shared outbound rate gate  # noqa: E402
from src.metadata import annotate as ann  # noqa: E402

# Trimmed from a real response. Note the U+2010 in every artist name.
REAL_BODY = {
    "count": 97,
    "recordings": [
        {
            "id": "e1e0c4f8-131f-40f5-8a5b-bc838c839868",
            "score": 100,
            "title": "Take on Me",
            "length": 229186,  # 229.186s — an album/compilation cut
            "artist-credit": [{"name": "a\u2010ha", "artist": {"name": "a\u2010ha"}}],
            "releases": [{"title": "Classic Party", "date": "2005-01-01"}],
        },
        {
            "id": "8c0c2908-0000-4000-8000-000000000002",
            "score": 100,
            "title": "Take On Me",
            "length": 217906,  # 217.906s — the single
            "artist-credit": [{"name": "a-ha"}],
            "releases": [{"title": "Hunting High and Low", "date": "1985-06-01"}],
        },
        {
            "id": "1c0c8409-0000-4000-8000-000000000003",
            "score": 100,
            "title": "Take On Me",
            "length": 119773,  # 119.773s — a short edit
            "artist-credit": [{"name": "a\u2010ha"}],
            "releases": [],
        },
    ],
}


def client(body=REAL_BODY, status=200, calls=None):
    def fetch(url, headers):
        if calls is not None:
            calls.append((url, headers))
        return status, __import__("json").dumps(body)

    # Its own limiter: the process-global gate would make tests order-dependent and sleep for real.
    return ann.MusicBrainzClient(
        fetcher=fetch,
        rate_limiter=ann.RateLimiter(now=lambda: 0.0, sleep=lambda _s: None),
    )


def test_a_unicode_hyphen_compares_equal_to_an_ascii_one():
    # THE measured trap: without this, the correct a-ha recording is rejected.
    assert ann.normalize_for_match("a\u2010ha") == ann.normalize_for_match("a-ha")
    assert ann.normalize_for_match("Take on Me") == ann.normalize_for_match("TAKE ON ME")
    assert ann.normalize_for_match("Where Is My Mind?") == ann.normalize_for_match("where is my mind")
    assert ann.normalize_for_match(None) == ""


def test_lucene_specials_are_escaped_so_a_punctuated_title_is_not_a_syntax_error():
    q = ann.build_query("AC/DC", "Where Is My Mind?")
    assert "AC\\/DC" in q
    assert "Mind\\?" in q
    assert q.startswith('artist:"')


def test_length_is_milliseconds_and_becomes_seconds():
    # Treating ms as seconds makes every match fail the tolerance, which reads as "never matches".
    recs = ann.parse_recordings(REAL_BODY)
    assert [round(r.duration_sec, 3) for r in recs] == [229.186, 217.906, 119.773]


def test_parsing_survives_missing_fields_and_skips_entries_with_no_id():
    recs = ann.parse_recordings({"recordings": [{"score": 100}, {"id": "x", "title": "T"}]})
    assert len(recs) == 1
    assert recs[0].mbid == "x" and recs[0].duration_sec is None and recs[0].artist == ""


def test_album_and_year_come_from_a_dated_release():
    recs = ann.parse_recordings(REAL_BODY)
    assert recs[1].album == "Hunting High and Low"
    assert recs[1].year == 1985


def test_the_earliest_release_wins_over_a_later_compilation():
    # MusicBrainz does NOT order releases: taking releases[0] gave a live-tour album and a karaoke
    # compilation.
    body = {
        "recordings": [
            {
                "id": "x",
                "score": 100,
                "title": "T",
                "length": 200000,
                "artist-credit": [{"name": "A"}],
                "releases": [
                    {"title": "Greatest Hits Vol 3", "date": "2011-01-01"},
                    {"title": "The Original Album", "date": "1985-06-01"},
                    {"title": "Some Reissue", "date": "1999-01-01"},
                ],
            }
        ]
    }
    rec = ann.parse_recordings(body)[0]
    assert rec.album == "The Original Album"
    assert rec.year == 1985


def test_an_undated_release_is_kept_rather_than_discarded():
    body = {
        "recordings": [
            {
                "id": "x",
                "title": "T",
                "artist-credit": [{"name": "A"}],
                "releases": [{"title": "Undated Single"}],
            }
        ]
    }
    rec = ann.parse_recordings(body)[0]
    assert rec.album == "Undated Single" and rec.year is None


def test_duration_picks_the_right_recording_when_every_score_ties_at_100():
    # 3:38 (218s) is the single. Score cannot tell it from the 229s cut or the 120s edit.
    got = ann.pick_best(ann.parse_recordings(REAL_BODY), "a-ha", "Take On Me", 218.0)
    assert got is not None
    assert got.mbid == "8c0c2908-0000-4000-8000-000000000002"
    assert got.confidence == ann.CONFIDENCE_HIGH
    assert got.album == "Hunting High and Low"


def test_a_different_expected_duration_selects_a_different_recording():
    got = ann.pick_best(ann.parse_recordings(REAL_BODY), "a-ha", "Take On Me", 229.0)
    assert got is not None and got.mbid.startswith("e1e0c4f8")


def test_confidence_tiers_follow_the_ratified_tolerances():
    assert ann.confidence_for(218.0, 219.0) == ann.CONFIDENCE_HIGH  # within 2s
    assert ann.confidence_for(218.0, 222.0) == ann.CONFIDENCE_MEDIUM  # within 5s
    assert ann.confidence_for(218.0, 240.0) is None  # refuse
    # unknown on either side is never `high` — nothing corroborated the identification
    assert ann.confidence_for(None, 218.0) == ann.CONFIDENCE_MEDIUM
    assert ann.confidence_for(218.0, None) == ann.CONFIDENCE_MEDIUM


def test_a_wrong_song_by_the_right_artist_is_REFUSED_not_written():
    # MusicBrainz happily returns another track by the same artist at a high lexical score, and writing
    # that as fact poisons the LRCLIB query indistinguishably from a correct answer. Length is held EQUAL
    # to duration_sec, so only the title-agreement gate can refuse this candidate.
    body = {
        "recordings": [
            {
                "id": "wrong",
                "score": 98,
                "title": "The Sun Always Shines on T.V.",
                "length": 218000,  # agrees with duration_sec=218.0 -> only the title gate can refuse
                "artist-credit": [{"name": "a-ha"}],
            }
        ]
    }
    assert ann.pick_best(ann.parse_recordings(body), "a-ha", "Take On Me", 218.0) is None


def test_every_candidate_too_far_off_in_length_is_refused():
    only_short = {"recordings": [REAL_BODY["recordings"][2]]}  # 119.773s
    assert ann.pick_best(ann.parse_recordings(only_short), "a-ha", "Take On Me", 218.0) is None


def test_no_confident_artist_or_title_means_no_lookup_at_all():
    assert ann.pick_best(ann.parse_recordings(REAL_BODY), "", "Take On Me", 218.0) is None

    # OBSERVE the attempt, not just the None: a missing guard also reads as None.
    calls: list = []
    assert ann.annotate(client(calls=calls), None, "Take On Me", 218.0) is None
    assert ann.annotate(client(calls=calls), "a-ha", "", 218.0) is None
    assert calls == [], f"declined for lack of keys but still looked up: {calls}"


def test_the_client_identifies_itself_as_musicbrainz_requires():
    calls: list = []
    client(calls=calls).search("a-ha", "Take On Me")
    _url, headers = calls[0]
    assert "Encore" in headers["User-Agent"] and "http" in headers["User-Agent"]


def test_requests_are_paced_to_one_per_second():
    slept: list[float] = []
    t = {"now": 0.0}
    lim = ann.RateLimiter(now=lambda: t["now"], sleep=lambda s: slept.append(s))
    c = ann.MusicBrainzClient(fetcher=lambda u, h: (200, "{}"), rate_limiter=lim)
    c.search("a", "b")  # first call never waits
    assert slept == []
    c.search("a", "b")  # immediately again → must wait out the interval
    assert slept and slept[0] == pytest.approx(gate.MIN_INTERVAL_SEC)


def test_TWO_CLIENTS_in_one_process_share_the_gate():
    # The limit is per source IP, a PROCESS property: two clients pacing independently still burst.
    slept: list[float] = []
    lim = ann.RateLimiter(now=lambda: 0.0, sleep=lambda s: slept.append(s))
    a = ann.MusicBrainzClient(fetcher=lambda u, h: (200, "{}"), rate_limiter=lim)
    b = ann.MusicBrainzClient(fetcher=lambda u, h: (200, "{}"), rate_limiter=lim)
    a.search("x", "y")
    b.search("x", "y")  # a DIFFERENT client — must still wait its turn
    assert slept and slept[0] == pytest.approx(gate.MIN_INTERVAL_SEC)


def test_calls_are_serialised_so_two_threads_cannot_burst():
    # An unlocked "has enough time passed?" lets two threads read one timestamp and both fire.
    import threading

    in_flight = {"now": 0, "max": 0}
    lock = threading.Lock()

    def fetch(url, headers):
        with lock:
            in_flight["now"] += 1
            in_flight["max"] = max(in_flight["max"], in_flight["now"])
        import time

        time.sleep(0.02)  # hold the "request" open long enough for an overlap to be observable
        with lock:
            in_flight["now"] -= 1
        return 200, "{}"

    lim = ann.RateLimiter(min_interval=0.0)  # isolate SERIALISATION from pacing
    clients = [ann.MusicBrainzClient(fetcher=fetch, rate_limiter=lim) for _ in range(4)]
    threads = [threading.Thread(target=c.search, args=("a", "b")) for c in clients]
    for t_ in threads:
        t_.start()
    for t_ in threads:
        t_.join()
    assert in_flight["max"] == 1, "two MusicBrainz requests were in flight at once"


def test_a_503_is_retried_with_backoff_then_gives_up():
    # 503 is "over the limit", so retrying recovers it; bounded, so a blocked box stops hammering.
    slept: list[float] = []
    attempts = {"n": 0}

    def always_throttled(url, headers):
        attempts["n"] += 1
        return 503, ""

    # min_interval=0 isolates BACKOFF from pacing, which are otherwise both 1s.
    lim = ann.RateLimiter(min_interval=0.0, now=lambda: 0.0, sleep=lambda s: slept.append(s))
    c = ann.MusicBrainzClient(fetcher=always_throttled, rate_limiter=lim)
    with pytest.raises(ann.AnnotationFetchError, match="throttled"):
        c.search("a", "b")
    assert attempts["n"] == gate.MAX_ATTEMPTS
    assert lim.throttled == gate.MAX_ATTEMPTS
    assert lim.retries == gate.MAX_ATTEMPTS - 1
    # exponential, not a fixed pause
    assert slept == [gate.BACKOFF_BASE_SEC, gate.BACKOFF_BASE_SEC * 2]


def test_a_503_that_clears_is_recovered_rather_than_lost():
    seq = [503, 200]

    def flaky(url, headers):
        return seq.pop(0), '{"recordings": []}'

    lim = ann.RateLimiter(now=lambda: 0.0, sleep=lambda _s: None)
    c = ann.MusicBrainzClient(fetcher=flaky, rate_limiter=lim)
    assert c.search("a", "b") == []  # succeeded on the retry
    assert lim.retries == 1


def test_the_gate_counts_what_it_did_so_throttling_is_distinguishable_from_slowness():
    lim = ann.RateLimiter(now=lambda: 0.0, sleep=lambda _s: None)
    ann.MusicBrainzClient(fetcher=lambda u, h: (200, "{}"), rate_limiter=lim).search("a", "b")
    st = lim.stats()
    assert st["calls"] == 1 and st["throttled"] == 0 and st["retries"] == 0
    assert set(st) == {"calls", "retries", "throttled", "waited_sec"}


def test_the_user_agent_is_not_the_anonymous_python_urllib_default():
    # MusicBrainz throttles `Python-urllib` far harder, and urllib sends that header unless overridden.
    assert "urllib" not in ann.USER_AGENT
    assert "Encore/" in ann.USER_AGENT and "github.com" in ann.USER_AGENT


def test_a_404_is_an_empty_result_but_a_500_is_a_transport_fault():
    assert client(status=404).search("a", "b") == []
    with pytest.raises(ann.AnnotationFetchError):
        client(status=503).search("a", "b")


def test_annotate_DECLINES_when_the_service_is_unreachable_and_never_fails_the_job():
    class Dead:
        def search(self, *_a, **_k):
            raise ann.AnnotationFetchError("sinkholed, like lrclib on the corp box")

    assert ann.annotate(Dead(), "a-ha", "Take On Me", 218.0) is None


def test_the_artifact_shape_carries_provenance_and_confidence():
    got = ann.annotate(client(), "a-ha", "Take On Me", 218.0)
    assert got is not None
    art = got.as_artifact()
    assert art["source"] == "musicbrainz"
    assert art["confidence"] == ann.CONFIDENCE_HIGH
    assert art["mbid"].startswith("8c0c2908")
    # Parsed for SELECTION but not published: a search hit's release list is partial, so a wrong album
    # is worse than a missing one.
    assert set(art) == {"source", "mbid", "artist", "title", "confidence"}
    assert "album" not in art and "year" not in art


def test_when_durations_tie_the_EARLIEST_release_wins():
    # Duration alone can tie several real recordings, and the original is the one a singer recognises.
    body = {
        "recordings": [
            {
                "id": "live",
                "score": 100,
                "title": "Take On Me",
                "length": 225000,
                "artist-credit": [{"name": "a-ha"}],
                "releases": [{"title": "On Tour In Brazil", "date": "1989-01-01"}],
            },
            {
                "id": "studio",
                "score": 100,
                "title": "Take On Me",
                "length": 225040,
                "artist-credit": [{"name": "a-ha"}],
                "releases": [{"title": "Hunting High and Low", "date": "1985-06-01"}],
            },
        ]
    }
    got = ann.pick_best(ann.parse_recordings(body), "a-ha", "Take On Me", 225.0)
    assert got is not None
    assert got.mbid == "studio", "a 40ms closer live cut must not outrank the original release"
    assert got.album == "Hunting High and Low"


def test_a_genuinely_closer_duration_still_beats_an_older_release():
    # A TIE-BREAK, not an override: a 60s edit must not win for being old.
    body = {
        "recordings": [
            {
                "id": "old-edit",
                "score": 100,
                "title": "T",
                "length": 60000,
                "artist-credit": [{"name": "A"}],
                "releases": [{"title": "Ancient", "date": "1970-01-01"}],
            },
            {
                "id": "right",
                "score": 100,
                "title": "T",
                "length": 200000,
                "artist-credit": [{"name": "A"}],
                "releases": [{"title": "Later", "date": "2001-01-01"}],
            },
        ]
    }
    got = ann.pick_best(ann.parse_recordings(body), "A", "T", 200.0)
    assert got is not None and got.mbid == "right"


#: MusicBrainz publishes a collaboration as ONE joined credit, so comparing it against a caller's single
#: primary artist rejects an exact match sitting at score 100.
COLLAB_BODY = {
    "recordings": [
        {
            "id": "8a5ceed8-dec8-4e48-b2b0-205768bf7751",
            "score": 100,
            "title": "Legends Never Die",
            "length": 179000,
            "artist-credit": [
                {"name": "League of Legends", "joinphrase": " feat. "},
                {"name": "Against the Current"},
            ],
        },
        {
            "id": "instrumental",
            "score": 93,
            "title": "Legends Never Die (Instrumental)",
            "length": 235000,
            "artist-credit": [
                {"name": "League of Legends", "joinphrase": " feat. "},
                {"name": "Against the Current"},
            ],
        },
    ]
}


def test_the_primary_credit_is_parsed_beside_the_joined_one():
    rec = ann.parse_recordings(COLLAB_BODY)[0]
    assert rec.artist == "League of Legends feat. Against the Current"
    assert rec.artist_primary == "League of Legends"


def test_a_collaboration_matches_on_the_PRIMARY_artist():
    # The caller's normalizer only produces a PRIMARY, so requiring the joined billing to agree would
    # make no song with a guest on it annotatable.
    got = ann.pick_best(ann.parse_recordings(COLLAB_BODY), "League of Legends", "Legends Never Die", 179.0)
    assert got is not None, "a guest credit must not make an exact match unreachable"
    assert got.mbid == "8a5ceed8-dec8-4e48-b2b0-205768bf7751"
    assert got.confidence == ann.CONFIDENCE_HIGH


def test_what_gets_published_is_the_FULL_billing_not_the_key_that_matched():
    # The singer wants to read who is actually on the track; the primary was only the lookup key.
    got = ann.pick_best(ann.parse_recordings(COLLAB_BODY), "League of Legends", "Legends Never Die", 179.0)
    assert got is not None
    assert got.artist == "League of Legends feat. Against the Current"


def test_an_exact_full_credit_agreement_still_OUTRANKS_a_primary_only_one():
    # Relaxing must not make the stronger evidence lose: the whole billing agreeing is better.
    body = {
        "recordings": [
            {
                "id": "primary-only",
                "score": 100,
                "title": "T",
                "length": 200000,
                "artist-credit": [{"name": "A", "joinphrase": " feat. "}, {"name": "Guest"}],
            },
            {"id": "exact", "score": 100, "title": "T", "length": 200000, "artist-credit": [{"name": "A"}]},
        ]
    }
    got = ann.pick_best(ann.parse_recordings(body), "A", "T", 200.0)
    assert got is not None and got.mbid == "exact"


def test_a_different_primary_artist_is_still_refused():
    # The relaxation is about the guests, not about the artist. A wrong primary writes nothing.
    got = ann.pick_best(ann.parse_recordings(COLLAB_BODY), "Against the Current", "Legends Never Die", 179.0)
    assert got is None


def test_a_recording_with_no_credit_list_cannot_agree_with_anything():
    # normalize_for_match("") is "", so an empty primary must not collide with an empty want.
    body = {"recordings": [{"id": "x", "score": 100, "title": "T", "length": 200000}]}
    assert ann.pick_best(ann.parse_recordings(body), "A", "T", 200.0) is None


def test_a_throttle_decline_carries_the_gate_counters_so_it_is_not_a_silent_none():
    # An IP block and "nothing agreed" are both None from annotate(); annotate_or_reason separates them.
    lim = ann.RateLimiter(min_interval=0.0, now=lambda: 0.0, sleep=lambda _s: None)
    c = ann.MusicBrainzClient(fetcher=lambda u, h: (503, ""), rate_limiter=lim)
    got, reason = ann.annotate_or_reason(c, "a-ha", "Take On Me", 218.0)
    assert got is None
    assert reason is not None and "throttled" in reason
    # the gate's OBSERVED counters ride along, which is the whole capability the docstring promised
    assert "'throttled': 3" in reason and "'calls': 3" in reason


def test_a_genuine_miss_and_a_throttle_produce_DIFFERENT_reasons():
    # control: a healthy 200 that simply matches nothing must NOT read as a throttle.
    miss = ann.MusicBrainzClient(
        fetcher=lambda u, h: (200, '{"recordings": []}'),
        rate_limiter=ann.RateLimiter(now=lambda: 0.0, sleep=lambda _s: None),
    )
    got, reason = ann.annotate_or_reason(miss, "a-ha", "Take On Me", 218.0)
    assert got is None
    assert reason == "no confident match"


def test_no_artist_or_title_declines_with_a_reason_and_never_looks_up():
    got, reason = ann.annotate_or_reason(client(), None, "Take On Me", 218.0)
    assert got is None and reason == "no artist/title to look up"


def test_a_match_returns_the_annotation_and_no_reason():
    got, reason = ann.annotate_or_reason(client(), "a-ha", "Take On Me", 218.0)
    assert got is not None and reason is None
    assert got.confidence == ann.CONFIDENCE_HIGH


def test_annotate_still_returns_None_on_a_transport_fault_delegating_to_the_reason_form():
    # annotate() delegates and drops the reason, so a throttle is still a None, never a raise.
    class Dead:
        def search(self, *_a, **_k):
            raise ann.AnnotationFetchError("sinkholed")

    assert ann.annotate(Dead(), "a-ha", "Take On Me", 218.0) is None
