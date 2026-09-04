"""Version selection: choosing WHICH RECORDING of a song a source found.

The bug these pin, in one sentence: a song with two popular versions ("Telephone" with and without
Beyoncé's verse) has a lyrics record for each, both matching artist+track, and the old single-record
lookup took whichever one the provider returned — then, on noticing the mismatch, threw the lookup away
and sang the ASR guess instead.

Two mechanisms, deliberately separate, and the distinction is the point of most of these tests:

  * SELECTION is comparative (`select_variants`). No threshold. It works precisely because two versions
    of one song both score far ABOVE the wrong-song threshold, so only their ORDER matters.
  * DEMOTION is absolute (SUSPECT_AGREEMENT, tested in test_whisperx.py). It judges whether the winner
    is trustworthy at all.
"""
from __future__ import annotations

import pytest

from src.lyrics_chain import (
    SOURCE_ASR,
    SOURCE_CAPTIONS,
    SOURCE_LRCLIB,
    TIMING_LINE,
    TIMING_NONE,
    CaptionsSource,
    LrclibSource,
    LyricsRequest,
    LyricsText,
    select_variants,
)
from src.lyrics_source import (
    DURATION_TOLERANCE_SEC,
    LrclibResult,
    candidate_sort_key,
    lrclib_search_url,
    rank_lrclib_candidates,
)

# ── fixtures: two real versions of one song ───────────────────────────────────────────
#
# Written as the token sets that actually decide this, not as prose: agreement is Jaccard over word
# SETS, so what matters is which words each version contains and nothing about their order.

SHARED = "hello hello baby you called i cant hear a thing i have got no service in the club you say"
GUEST_VERSE = "boy the way you blowing up my phone wont make me leave no faster put my coat on faster"

#: The version WITHOUT the guest verse.
SOLO_TEXT = SHARED
#: The version WITH it — a superset, which is why an absolute threshold cannot separate the two.
FEAT_TEXT = f"{SHARED} {GUEST_VERSE}"
#: What Whisper hears off the vocals stem of the FEAT recording. Deliberately imperfect (mis-heard
#: words, a dropped line) because a real transcript is, and selection must survive that.
ASR_OF_FEAT = f"{SHARED} boy the way you blowing up my fone wont make me leave no faster put my coat on"


def text(source: str, body: str, variant: str) -> LyricsText:
    return LyricsText(
        text_source=source,
        segments=[{"start": 0.0, "end": 1.0, "text": line} for line in body.split(" ")],
        timing=TIMING_LINE,
        text_confidence="high",
        variant=variant,
    )


def asr(body: str) -> LyricsText:
    t = text(SOURCE_ASR, body, "whisper")
    t.text_confidence = "low"
    return t


# ── the headline behaviour ────────────────────────────────────────────────────────────


def test_THE_BUG_the_version_matching_the_vocals_is_chosen_over_the_one_that_does_not():
    """The whole feature. Both records are 'Lady Gaga / Telephone'; the sung audio has the guest verse."""
    lrclib = text(SOURCE_LRCLIB, SOLO_TEXT, "solo")
    lrclib.alternates = [text(SOURCE_LRCLIB, FEAT_TEXT, "feat")]

    resolved, choices = select_variants([lrclib, asr(ASR_OF_FEAT)])

    chosen = next(t for t in resolved if t.text_source == SOURCE_LRCLIB)
    assert chosen.variant == "feat"
    assert [c.considered for c in choices] == [2]
    assert choices[0].decided_by == "agreement"


def test_the_wrong_version_scores_ABOVE_the_wrong_song_threshold_so_a_threshold_cannot_fix_this():
    """Why selection had to be comparative rather than a tuned cutoff.

    If the losing version scored below SUSPECT_AGREEMENT, the pre-existing demotion would already have
    handled this case and none of this code would be needed. It does not: two versions of one song share
    most of their words. This test fails the moment someone 'simplifies' selection into a threshold.
    """
    from src.lyrics_chain import SUSPECT_AGREEMENT, agreement_score

    wrong = agreement_score(SOLO_TEXT, ASR_OF_FEAT)
    right = agreement_score(FEAT_TEXT, ASR_OF_FEAT)
    assert wrong is not None and right is not None
    assert wrong > SUSPECT_AGREEMENT  # the wrong version looks perfectly fine in absolute terms
    assert right > wrong  # ...and is only exposed by comparison


def test_selection_happens_on_TEXT_so_it_costs_no_alignment():
    """Cost claim, pinned: the loser is discarded before any timing work, and only one text survives to
    be aligned. A future refactor that aligned every candidate first would break this."""
    lrclib = text(SOURCE_LRCLIB, SOLO_TEXT, "solo")
    lrclib.alternates = [text(SOURCE_LRCLIB, FEAT_TEXT, "feat")]

    resolved, _ = select_variants([lrclib, asr(ASR_OF_FEAT)])

    lrclib_texts = [t for t in resolved if t.text_source == SOURCE_LRCLIB]
    assert len(lrclib_texts) == 1  # exactly one thing to align
    assert lrclib_texts[0].alternates == []  # the choice is resolved, not deferred


# ── falling back when the transcript cannot decide ────────────────────────────────────


def test_with_no_ASR_tier_the_metadata_order_stands():
    """No transcript, no comparison. Keeping the duration-ranked pick beats guessing."""
    lrclib = text(SOURCE_LRCLIB, SOLO_TEXT, "solo")
    lrclib.alternates = [text(SOURCE_LRCLIB, FEAT_TEXT, "feat")]

    resolved, choices = select_variants([lrclib])

    assert resolved[0].variant == "solo"
    assert choices[0].decided_by == "metadata"
    assert choices[0].chosen_score is None


def test_an_instrumental_transcribing_to_nothing_does_not_condemn_a_candidate():
    """An almost-empty transcript makes every comparison incomparable (below MIN_TOKENS_TO_COMPARE).
    That is 'cannot tell', not 'they differ', so the metadata pick survives."""
    lrclib = text(SOURCE_LRCLIB, SOLO_TEXT, "solo")
    lrclib.alternates = [text(SOURCE_LRCLIB, FEAT_TEXT, "feat")]

    resolved, choices = select_variants([lrclib, asr("mmm ooh yeah")])

    assert resolved[0].variant == "solo"
    assert choices[0].decided_by == "metadata"


def test_a_source_offering_one_version_is_reported_as_no_choice_at_all():
    """No alternates → nothing to decide, and no log line claiming a decision was made."""
    resolved, choices = select_variants([text(SOURCE_LRCLIB, SOLO_TEXT, "only"), asr(ASR_OF_FEAT)])
    assert len(resolved) == 2
    assert choices == []


def test_an_exact_tie_keeps_the_better_METADATA_match():
    """Identical text on both records — the ASR signal cannot separate them, so the earlier (better
    duration match) must win rather than the later one displacing it arbitrarily."""
    first = text(SOURCE_LRCLIB, FEAT_TEXT, "closest-duration")
    first.alternates = [text(SOURCE_LRCLIB, FEAT_TEXT, "further-away")]

    resolved, _ = select_variants([first, asr(ASR_OF_FEAT)])

    assert resolved[0].variant == "closest-duration"


def test_every_source_with_variants_is_resolved_not_just_the_first():
    """Selection is source-agnostic: captions can offer several authored tracks too, and 'which of these
    matches what is being sung' has one answer whoever asked the question."""
    lrclib = text(SOURCE_LRCLIB, SOLO_TEXT, "lrclib-solo")
    lrclib.alternates = [text(SOURCE_LRCLIB, FEAT_TEXT, "lrclib-feat")]
    caps = text(SOURCE_CAPTIONS, SOLO_TEXT, "caps-solo")
    caps.alternates = [text(SOURCE_CAPTIONS, FEAT_TEXT, "caps-feat")]

    resolved, choices = select_variants([lrclib, caps, asr(ASR_OF_FEAT)])

    assert [t.variant for t in resolved if t.text_source != SOURCE_ASR] == ["lrclib-feat", "caps-feat"]
    assert sorted(c.text_source for c in choices) == [SOURCE_CAPTIONS, SOURCE_LRCLIB]


def test_the_ASR_tier_itself_is_never_reordered_against_its_own_transcript():
    """Scoring ASR against itself would be a perfect 1.0 and meaningless. It carries no alternates, so
    it must pass through untouched and unreported."""
    a = asr(ASR_OF_FEAT)
    resolved, choices = select_variants([text(SOURCE_LRCLIB, FEAT_TEXT, "v"), a])
    assert resolved[1] is a
    assert choices == []


def test_the_report_names_the_loser_and_its_score_for_the_log():
    """A decision nobody can read is a decision nobody can debug — the operator needs to see which
    version lost and by how much."""
    lrclib = text(SOURCE_LRCLIB, SOLO_TEXT, "solo")
    lrclib.alternates = [text(SOURCE_LRCLIB, FEAT_TEXT, "feat")]

    _, choices = select_variants([lrclib, asr(ASR_OF_FEAT)])

    report = choices[0]
    assert report.chosen == "feat"
    assert [label for label, _ in report.rejected] == ["solo"]
    assert "solo" in report.summary() and "feat" in report.summary()


# ── the search pool: what /api/search is asked, and how its records are ordered ────────


def test_the_search_url_carries_NO_duration_filter():
    """The point of searching. /api/get applies a ±2s duration filter, which picks one version by fiat
    before anything has looked at the words — exactly the failure being fixed. Duration is a local
    RANKING axis instead, so a near-miss can still be considered."""
    url = lrclib_search_url("https://lrclib.net", "Lady Gaga", "Telephone")
    assert url.startswith("https://lrclib.net/api/search?")
    assert "artist_name=Lady+Gaga" in url
    assert "track_name=Telephone" in url
    assert "duration" not in url


def rec(**over) -> LrclibResult:
    base = dict(id=1, instrumental=False, synced_lyrics="[00:01.00]la", plain_lyrics="la")
    return LrclibResult(**{**base, **over})


def test_records_with_no_usable_lyrics_are_dropped_not_merely_ranked_last():
    """An instrumental record left in the pool could WIN a comparison against a near-empty transcript,
    which is the one case where its emptiness looks like agreement."""
    pool = rank_lrclib_candidates(
        [
            rec(id=1, instrumental=True, synced_lyrics=None, plain_lyrics=None),
            rec(id=2, synced_lyrics=None, plain_lyrics=None),
            rec(id=3),
        ]
    )
    assert [r.id for r in pool] == [3]


def test_the_closest_duration_ranks_first():
    """The strongest metadata signal for two versions: a guest verse usually adds 10-40 seconds."""
    pool = rank_lrclib_candidates([rec(id=1, duration=200.0), rec(id=2, duration=245.0)], duration=243.0)
    assert [r.id for r in pool] == [2, 1]


def test_an_unknown_duration_is_not_treated_as_a_mismatch():
    """'Cannot tell' must not rank below 'known to differ' — a record with no duration is scored at the
    tolerance, so it beats one that is demonstrably minutes off."""
    unknown = candidate_sort_key(rec(duration=None), duration=243.0)
    far_off = candidate_sort_key(rec(duration=45.0), duration=243.0)
    assert unknown[1] == DURATION_TOLERANCE_SEC
    assert unknown < far_off


def test_the_credit_breaks_a_duration_tie_toward_the_record_naming_the_GUEST():
    """What the parsed billing buys. Both records are the same length here, so only the credit can
    separate 'Lady Gaga' from 'Lady Gaga feat. Beyoncé'."""
    pool = rank_lrclib_candidates(
        [rec(id=1, artist_name="Lady Gaga", duration=243.0), rec(id=2, artist_name="Lady Gaga feat. Beyoncé", duration=243.0)],
        duration=243.0,
        credit="Lady Gaga feat. Beyoncé",
    )
    assert [r.id for r in pool] == [2, 1]


def test_duration_outranks_the_credit():
    """Ordering of the axes, pinned. A record whose LENGTH matches the audio is better evidence than one
    whose artist string reads well: the credit is parsed from an upload title and is often wrong."""
    pool = rank_lrclib_candidates(
        [rec(id=1, artist_name="Lady Gaga feat. Beyoncé", duration=180.0), rec(id=2, artist_name="Lady Gaga", duration=243.0)],
        duration=243.0,
        credit="Lady Gaga feat. Beyoncé",
    )
    assert [r.id for r in pool] == [2, 1]


def test_the_pool_is_capped():
    """Bounds log noise and response handling; a popular song can have dozens of records."""
    assert len(rank_lrclib_candidates([rec(id=i) for i in range(40)], limit=5)) == 5


def test_a_record_label_names_the_version_for_the_log():
    r = rec(id=77, track_name="Telephone", artist_name="Lady Gaga", album_name="The Fame Monster", duration=243.0)
    label = r.label
    assert "Lady Gaga" in label and "Telephone" in label and "243s" in label and "#77" in label


# ── LrclibSource: how the pool reaches the chain, and the no-regression fallback ───────


class FakeLrclib:
    """Records which endpoint was called, so a test can assert the fallback actually happened."""

    def __init__(self, search=None, get=None, search_raises=False, get_raises=False):
        self._search, self._get = search or [], get
        self._search_raises, self._get_raises = search_raises, get_raises
        self.calls: list[str] = []

    def search(self, artist, track):
        self.calls.append("search")
        if self._search_raises:
            raise RuntimeError("lrclib unreachable")
        return list(self._search)

    def get(self, artist, track, duration=None, album=None):
        self.calls.append("get")
        if self._get_raises:
            raise RuntimeError("lrclib unreachable")
        return self._get


def _segments(res, duration):
    """Stand-in for whisperx.lrclib_to_segments — one segment carrying the record's own body."""
    body = res.synced_lyrics or res.plain_lyrics or ""
    return [{"start": 0.0, "end": 1.0, "text": body}] if body else []


def _req():
    return LyricsRequest(
        media_id="m1", artist="Lady Gaga", track="Telephone", artist_credit="Lady Gaga feat. Beyoncé", duration=243.0
    )


def test_the_source_searches_and_attaches_the_losing_versions_as_alternates():
    """The pool reaches the chain intact so `select_variants` has something to choose between — one
    record would leave nothing to decide."""
    client = FakeLrclib(
        search=[
            rec(id=11, artist_name="Lady Gaga", duration=218.0, synced_lyrics="[00:01.00]solo"),
            rec(id=12, artist_name="Lady Gaga feat. Beyoncé", duration=243.0, synced_lyrics="[00:01.00]feat"),
        ]
    )
    got = LrclibSource(client, _segments).fetch(_req())

    assert got is not None
    assert client.calls == ["search"]  # no wasted /api/get when search answered
    assert len(got.alternates) == 1
    # ranked best-first: 243s matches the audio exactly, and the credit names the guest
    assert got.variant is not None and "243s" in got.variant
    assert got.text_confidence == "high"


def test_an_empty_search_falls_back_to_get_rather_than_losing_the_lyrics():
    """A regression from 'lyrics' to 'no lyrics' is not an acceptable price for adding version
    selection, so a record reachable only by exact match is still found."""
    client = FakeLrclib(search=[], get=rec(id=99, synced_lyrics="[00:01.00]only one"))
    got = LrclibSource(client, _segments).fetch(_req())

    assert got is not None
    assert client.calls == ["search", "get"]
    assert got.alternates == []


def test_a_failing_search_still_tries_get():
    """Transient failures are per-request. One dead endpoint must not condemn the tier."""
    client = FakeLrclib(search_raises=True, get=rec(id=99, synced_lyrics="[00:01.00]x"))
    assert LrclibSource(client, _segments).fetch(_req()) is not None


def test_both_endpoints_failing_is_a_miss_not_a_job_failure():
    """A dead LRCLIB must degrade the RESULT, not fail the cook — the invariant this module was
    originally written to establish."""
    client = FakeLrclib(search_raises=True, get_raises=True)
    assert LrclibSource(client, _segments).fetch(_req()) is None


def test_no_confident_metadata_means_no_lookup_at_all():
    """Searching on a guessed title returns another song's words, which is worse than a miss."""
    client = FakeLrclib(search=[rec(id=1)])
    assert LrclibSource(client, _segments).fetch(LyricsRequest(media_id="m1")) is None
    assert client.calls == []


def test_the_pool_is_capped_at_the_sources_limit():
    client = FakeLrclib(search=[rec(id=i, duration=float(200 + i)) for i in range(10)])
    got = LrclibSource(client, _segments, max_variants=3).fetch(_req())
    assert got is not None
    assert 1 + len(got.alternates) == 3


def test_a_synced_record_reports_line_timing_and_a_plain_one_reports_none():
    """An LRC carries real line timings; plainLyrics segments are synthetic even spacing and must not be
    presented as the line-level floor."""
    synced = FakeLrclib(search=[rec(id=1, synced_lyrics="[00:01.00]hi", plain_lyrics=None)])
    plain = FakeLrclib(search=[rec(id=2, synced_lyrics=None, plain_lyrics="hi")])
    assert LrclibSource(synced, _segments).fetch(_req()).timing == TIMING_LINE
    assert LrclibSource(plain, _segments).fetch(_req()).timing == TIMING_NONE


# ── the captions tier ─────────────────────────────────────────────────────────────────


def test_captions_decline_when_the_upload_has_no_manual_track():
    """The COMMON case and not an error — most uploads have no human captions."""
    assert CaptionsSource().fetch(LyricsRequest(media_id="m", caption_segments=[])) is None
    assert CaptionsSource().fetch(LyricsRequest(media_id="m")) is None


def test_captions_are_authoritative_because_auto_generated_ones_are_never_fetched():
    """`high` confidence is only defensible because caption_argv cannot return an ASR track — see
    test_captions.py. If that guarantee were ever relaxed, this grade would become a lie."""
    got = CaptionsSource().fetch(
        LyricsRequest(media_id="m", caption_segments=[{"start": 0.0, "end": 2.0, "text": "hello hello baby"}])
    )
    assert got is not None
    assert got.text_source == SOURCE_CAPTIONS
    assert got.text_confidence == "high"
    assert got.timing == TIMING_LINE  # a cue bounds a LINE; word timings come from the aligner


def test_captions_cannot_be_about_a_different_version_of_the_song():
    """Why this tier exists at all. It is attached to the exact upload being sung over, so unlike a
    database lookup it has no notion of 'another recording' to get wrong — hence no alternates."""
    got = CaptionsSource().fetch(
        LyricsRequest(media_id="m", caption_segments=[{"start": 0.0, "end": 2.0, "text": "hello"}])
    )
    assert got is not None
    assert got.alternates == []
