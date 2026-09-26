"""MusicBrainz identification: the ranking policy, and the refusals that keep a wrong name out.

WHY THIS MATTERS MORE THAN IT LOOKS. Core applies the annotation to `artistCanonical`/`titleCanonical`, and
`assignParams` sends exactly those to a later align job as its LYRICS LOOKUP KEYS. A wrong name is not a
cosmetic error — it returns another song's words. A missing one falls back to ASR for a song whose lyrics are
published somewhere.

Every test here is hermetic: `pick_best` and the parser are pure, and the client takes an injected fetcher.
"""

from __future__ import annotations

from typing import Any

import pytest

from encore_worker.adapters.musicbrainz import (
    AnnotationFetchError,
    MusicBrainzClient,
    annotate_or_reason,
)
from encore_worker.domain import metadata as md


def recording(**over: Any) -> md.Recording:
    base: dict[str, Any] = {
        "mbid": "mb-1",
        "title": "Fly Away",
        "artist": "TheFatRat",
        "duration_sec": 195.0,
        "score": 100,
        "artist_primary": "TheFatRat",
    }
    base.update(over)
    return md.Recording(**base)


# ── normalisation: comparing content, not typography ─────────────────────────────────────────────


def test_a_unicode_dash_does_not_defeat_a_match() -> None:
    """MusicBrainz writes en- and em-dashes where a human types a hyphen. A raw comparison would reject a
    correct match over punctuation nobody can see."""
    assert md.normalize_for_match("Jay‐Z") == md.normalize_for_match("Jay-Z")
    assert md.normalize_for_match("AC–DC") == md.normalize_for_match("AC-DC")


def test_case_and_punctuation_are_folded() -> None:
    assert md.normalize_for_match("Where Is My Mind?") == md.normalize_for_match("where is my mind")


def test_an_absent_name_normalises_to_empty_rather_than_crashing() -> None:
    """And empty must never agree with anything — see the primary-credit guard in `pick_best`."""
    assert md.normalize_for_match(None) == ""
    assert md.normalize_for_match("") == ""


# ── the query ────────────────────────────────────────────────────────────────────────────────────


def test_lucene_specials_are_escaped() -> None:
    """An unescaped `?` turns "Where Is My Mind?" into a syntax error, and the search returns nothing for a
    song that exists."""
    assert md.escape_lucene("Where Is My Mind?") == "Where Is My Mind\\?"
    assert md.escape_lucene("AC/DC") == "AC\\/DC"


def test_the_query_is_field_scoped_and_phrase_quoted() -> None:
    """Quoted so a multi-word title is ONE phrase: unquoted, "Fly Away" matches any recording containing
    either word, which is most of the database."""
    q = md.build_query("TheFatRat", "Fly Away")
    assert 'artist:"TheFatRat"' in q
    assert 'recording:"Fly Away"' in q
    assert " AND " in q


def test_the_url_carries_json_and_a_limit() -> None:
    url = md.search_url(md.MB_BASE, "A", "B", limit=7)
    assert url.startswith(f"{md.MB_BASE}/recording?")
    assert "fmt=json" in url and "limit=7" in url


# ── parsing ──────────────────────────────────────────────────────────────────────────────────────


def test_length_is_milliseconds() -> None:
    """Treating it as seconds fails EVERY match's duration tolerance, so nothing would ever be annotated."""
    got = md.parse_recordings({"recordings": [{"id": "x", "title": "T", "length": 195000}]})
    assert got[0].duration_sec == 195.0


def test_a_joined_credit_is_published_and_the_primary_is_kept_beside_it() -> None:
    """They do different jobs: the joined string is what a singer reads, the primary is what a title-parse
    guess can be compared against."""
    doc = {
        "recordings": [
            {
                "id": "x",
                "title": "Fly Away",
                "artist-credit": [
                    {"name": "TheFatRat", "joinphrase": " feat. "},
                    {"name": "Anjulie"},
                ],
            }
        ]
    }
    got = md.parse_recordings(doc)[0]
    assert got.artist == "TheFatRat feat. Anjulie"
    assert got.artist_primary == "TheFatRat"


def test_an_entry_with_no_id_is_skipped() -> None:
    assert md.parse_recordings({"recordings": [{"title": "no id"}]}) == []


def test_the_earliest_dated_release_wins_not_the_first_listed() -> None:
    """MusicBrainz does not order `releases` meaningfully, and taking [0] can pick a live-tour or
    karaoke-series compilation over the original."""
    doc = {
        "recordings": [
            {
                "id": "x",
                "title": "T",
                "releases": [
                    {"title": "Karaoke Hits 2019", "date": "2019-01-01"},
                    {"title": "The Original Album", "date": "2014-06-01"},
                ],
            }
        ]
    }
    got = md.parse_recordings(doc)[0]
    assert got.album == "The Original Album"
    assert got.year == 2014


def test_an_undated_release_is_kept_rather_than_dropped() -> None:
    """An undated original still beats no album at all."""
    got = md.parse_recordings({"recordings": [{"id": "x", "title": "T", "releases": [{"title": "Only"}]}]})[0]
    assert got.album == "Only"
    assert got.year is None


# ── confidence from duration ─────────────────────────────────────────────────────────────────────


def test_a_close_duration_is_high_confidence() -> None:
    """2 s is LRCLIB's own tolerance, so a `high` annotation is by construction good enough for the lookup
    it feeds."""
    assert md.confidence_for(195.0, 196.0) == md.CONFIDENCE_HIGH


def test_a_loose_duration_is_medium() -> None:
    assert md.confidence_for(195.0, 199.0) == md.CONFIDENCE_MEDIUM


def test_a_wide_gap_yields_nothing_at_all() -> None:
    """None means "do not write this": a 30 s difference is a different recording, however well the names
    match."""
    assert md.confidence_for(195.0, 240.0) is None


def test_an_unknown_duration_is_medium_never_high() -> None:
    """The identification may be right, but NOTHING corroborated it — and `high` is the tier core treats as
    fact."""
    assert md.confidence_for(None, 195.0) == md.CONFIDENCE_MEDIUM
    assert md.confidence_for(195.0, None) == md.CONFIDENCE_MEDIUM


# ── the ranking, which is the whole policy ───────────────────────────────────────────────────────


def test_name_agreement_is_required_rather_than_scored() -> None:
    """THE REFUSAL THAT MATTERS. MusicBrainz's score is LEXICAL: it will happily return a different song by
    the same artist with score 100, and writing that as fact is the failure this prevents."""
    wrong_song = recording(title="Monody", score=100)
    assert md.pick_best([wrong_song], "TheFatRat", "Fly Away", 195.0) is None


def test_a_guest_credit_still_matches_on_the_primary_artist() -> None:
    """MusicBrainz publishes a collaboration as one joined credit while a title parse yields a single
    primary artist. Requiring the joined string to agree would reject every song with a guest on it."""
    got = md.pick_best(
        [recording(artist="TheFatRat feat. Anjulie", artist_primary="TheFatRat")],
        "TheFatRat",
        "Fly Away",
        195.0,
    )
    assert got is not None
    # The FULL credit is what gets published — more informative, and what a singer wants to read.
    assert got.artist == "TheFatRat feat. Anjulie"


def test_an_exact_credit_outranks_a_primary_only_match() -> None:
    """Exact evidence wins, even when both agree and the durations tie."""
    primary_only = recording(mbid="primary", artist="TheFatRat feat. Someone")
    exact = recording(mbid="exact", artist="TheFatRat")
    got = md.pick_best([primary_only, exact], "TheFatRat", "Fly Away", 195.0)
    assert got is not None and got.mbid == "exact"


def test_the_closest_duration_wins() -> None:
    far = recording(mbid="far", duration_sec=199.0)
    near = recording(mbid="near", duration_sec=195.5)
    got = md.pick_best([far, near], "TheFatRat", "Fly Away", 195.0)
    assert got is not None and got.mbid == "near"


def test_the_earliest_release_breaks_a_duration_tie() -> None:
    """Duration alone leaves recordings tied, and the tie is routinely between the original and a karaoke or
    live-tour cut of identical length."""
    later = recording(mbid="karaoke", year=2019)
    earlier = recording(mbid="original", year=2014)
    got = md.pick_best([later, earlier], "TheFatRat", "Fly Away", 195.0)
    assert got is not None and got.mbid == "original"


def test_a_candidate_whose_duration_disagrees_is_dropped_entirely() -> None:
    assert md.pick_best([recording(duration_sec=300.0)], "TheFatRat", "Fly Away", 195.0) is None


def test_nothing_to_match_against_declines() -> None:
    """An empty key must not agree with a recording that also has an empty field."""
    assert md.pick_best([recording()], "", "Fly Away", 195.0) is None
    assert md.pick_best([recording(artist="", artist_primary="")], "", "Fly Away", 195.0) is None


def test_the_published_artifact_omits_album_and_year() -> None:
    """Parsed and used for SELECTION, not published: `releases` on a search hit is partial and the recording
    is chosen by duration, so a compilation matching the file's length brings its wrong release along. A
    wrong album is worse than a missing one."""
    art = md.Annotation(mbid="x", artist="A", title="T", confidence="high", album="Some LP", year=2014)
    assert art.as_artifact() == {
        "source": "musicbrainz",
        "mbid": "x",
        "artist": "A",
        "title": "T",
        "confidence": "high",
    }


# ── the client's status ladder ───────────────────────────────────────────────────────────────────


def fetcher(status: int, body: str = "") -> Any:
    return lambda _url, _headers: (status, body)


def test_a_404_is_a_miss_not_an_error() -> None:
    assert MusicBrainzClient(fetcher(404)).search("A", "B") == []


def test_a_503_after_retries_is_an_error_naming_the_throttle() -> None:
    """Retries exhausted means the IP is being refused; hammering only lengthens the block, and the caller
    needs to be able to say so rather than reporting a per-song miss."""
    with pytest.raises(AnnotationFetchError, match="throttled"):
        MusicBrainzClient(fetcher(503)).search("A", "B")


def test_an_unparseable_body_is_an_error_rather_than_an_empty_result() -> None:
    with pytest.raises(AnnotationFetchError, match="unparseable"):
        MusicBrainzClient(fetcher(200, "{not json")).search("A", "B")


# ── declining WITH a reason ──────────────────────────────────────────────────────────────────────


def test_a_transport_fault_declines_with_the_fault_as_the_reason() -> None:
    """An IP-level block and a healthy per-song miss both return None otherwise, so an operator cannot tell a
    throttled box from a song MusicBrainz does not have."""

    class Blocked:
        def search(self, *_a: Any, **_k: Any) -> list[md.Recording]:
            raise AnnotationFetchError("musicbrainz throttled us (503) after 3 attempts")

    found, why = annotate_or_reason(Blocked(), "A", "B", 195.0)
    assert found is None
    assert why is not None and "throttled" in why


def test_no_names_declines_without_a_lookup() -> None:
    class NeverCalled:
        def search(self, *_a: Any, **_k: Any) -> list[md.Recording]:
            raise AssertionError("must not search without a name to search on")

    found, why = annotate_or_reason(NeverCalled(), None, "B", 195.0)
    assert found is None and why == "no artist/title to look up"


def test_a_disagreement_names_how_many_candidates_were_considered() -> None:
    class Wrong:
        def search(self, *_a: Any, **_k: Any) -> list[md.Recording]:
            return [recording(title="Monody"), recording(title="Unity")]

    found, why = annotate_or_reason(Wrong(), "TheFatRat", "Fly Away", 195.0)
    assert found is None
    assert why is not None and "2 candidates" in why


def test_a_match_returns_no_reason() -> None:
    class Good:
        def search(self, *_a: Any, **_k: Any) -> list[md.Recording]:
            return [recording()]

    found, why = annotate_or_reason(Good(), "TheFatRat", "Fly Away", 195.0)
    assert found is not None and why is None
    assert found.confidence == md.CONFIDENCE_HIGH
