"""Version selection: choosing WHICH RECORDING of a song a source found.

The bug these pin, in one sentence: a song with two popular versions ("Telephone" with and without
Beyoncé's verse) has a lyrics record for each, both matching artist+track, and the old single-record
lookup took whichever one the provider returned — then, on noticing the mismatch, threw the lookup away
and sang the ASR guess instead.

Two mechanisms, deliberately separate, and the distinction is the point of most of these tests:

  * SELECTION is comparative (`select_by_baselines`). No threshold. It works precisely because two versions
    of one song both score far ABOVE the wrong-song threshold, so only their ORDER matters.
  * DEMOTION is absolute (SUSPECT_COVERAGE on baseline coverage). It judges whether the winner
    is trustworthy at all.
"""

from __future__ import annotations

from src.lyrics.chain import (
    BASELINE_CAPTIONS_AUTO,
    ROLE_BASELINE,
    ROLE_CANDIDATE,
    SOURCE_ASR,
    SOURCE_CAPTIONS,
    SOURCE_LRCLIB,
    TIMING_LINE,
    TIMING_NONE,
    AutoCaptionsSource,
    CaptionsSource,
    LrclibSource,
    LyricsRequest,
    LyricsText,
    baselines_of,
    candidate_key,
    candidates_of,
    composite_score,
    select_by_baselines,
)
from src.lyrics.registry import build_sources
from src.lyrics.source import (
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
    """A CANDIDATE — an authored claim about the song's words, to be graded."""
    return LyricsText(
        text_source=source,
        segments=[{"start": 0.0, "end": 1.0, "text": line} for line in body.split(" ")],
        timing=TIMING_LINE,
        text_confidence="high",
        role=ROLE_CANDIDATE,
        variant=variant,
    )


def base(body: str, rank: int = 0, variant: str = "whisper/vocals", source: str = SOURCE_ASR) -> LyricsText:
    """A BASELINE — evidence of what is audible. It grades; it is never graded."""
    t = text(source, body, variant)
    t.role = ROLE_BASELINE
    t.baseline_rank = rank
    t.text_confidence = "low"
    return t


# ── the headline behaviour ────────────────────────────────────────────────────────────


def test_THE_BUG_the_version_matching_the_audio_is_chosen_over_the_one_that_does_not():
    """The whole feature. Both records are 'Lady Gaga / Telephone'; the sung audio has the guest verse."""
    lrclib = text(SOURCE_LRCLIB, SOLO_TEXT, "solo")
    lrclib.alternates = [text(SOURCE_LRCLIB, FEAT_TEXT, "feat")]

    sel = select_by_baselines([lrclib, base(ASR_OF_FEAT)])

    assert sel.publish[0].variant == "feat"
    assert [c.considered for c in sel.choices] == [2]
    assert sel.choices[0].decided_by == "agreement"
    assert not sel.winner_suspect


def test_the_wrong_version_scores_ABOVE_the_wrong_song_threshold_so_a_threshold_cannot_fix_this():
    """Why selection had to be comparative rather than a tuned cutoff.

    If the losing version's baseline COVERAGE were below SUSPECT_COVERAGE, the absolute wrong-song check
    would already have handled this case and none of this code would be needed. It does not: two versions
    of one song share most of their words, so the shorter one still covers what is audible. This test
    fails the moment someone 'simplifies' selection into a threshold. (the judgement axis is
    coverage now, not the ranking score — but the point stands on either, and coverage is the honest one
    to make it on, because coverage is what the threshold actually reads.)
    """
    from src.lyrics.chain import SUSPECT_COVERAGE, agreement

    wrong = agreement(SOLO_TEXT, ASR_OF_FEAT)
    right = agreement(FEAT_TEXT, ASR_OF_FEAT)
    assert wrong is not None and right is not None
    assert wrong.coverage > SUSPECT_COVERAGE  # the wrong version looks perfectly fine in absolute terms
    assert right.rank_score > wrong.rank_score  # ...and is only exposed by comparison


def test_THE_MEAN_of_several_baselines_decides_not_any_single_one():
    """The two-tier core. A single baseline is one opinion with its own blind spots; the composite is the
    mean across independent ones, so a baseline that mis-hears a passage cannot swing the choice alone.

    Constructed so the FIRST baseline alone would pick wrong and the mean picks right — otherwise the
    test would pass without the averaging ever mattering.
    """
    lrclib = text(SOURCE_LRCLIB, SOLO_TEXT, "solo")
    lrclib.alternates = [text(SOURCE_LRCLIB, FEAT_TEXT, "feat")]
    # baseline 1 heard only the shared part (so it favours 'solo' — a subset match scores higher)
    # baselines 2 and 3 heard the guest verse too
    misheard = base(SHARED, rank=0, variant="whisper/vocals")
    heard_a = base(ASR_OF_FEAT, rank=1, variant="whisper/mix")
    heard_b = base(f"{SHARED} {GUEST_VERSE}", rank=2, variant="youtube auto-captions", source=SOURCE_CAPTIONS)

    assert composite_score(lrclib, [misheard])[0] > composite_score(lrclib.alternates[0], [misheard])[0]
    sel = select_by_baselines([lrclib, misheard, heard_a, heard_b])
    assert sel.publish[0].variant == "feat"  # the mean overrules the single dissenting baseline
    assert sel.choices[0].votes == 3


def test_only_what_is_published_gets_aligned():
    """Cost claim, pinned. Grading is free (token sets already in memory); alignment is not. A trustworthy
    winner publishes exactly one text, so a run costs ONE alignment however many versions were judged."""
    lrclib = text(SOURCE_LRCLIB, SOLO_TEXT, "solo")
    lrclib.alternates = [text(SOURCE_LRCLIB, FEAT_TEXT, "feat")]

    sel = select_by_baselines([lrclib, base(ASR_OF_FEAT), base(ASR_OF_FEAT, rank=1, variant="whisper/mix")])

    assert len(sel.publish) == 1
    assert sel.publish[0].alternates == []  # the choice is resolved, not deferred


# ── the two roles, kept apart ──────────────────────────────────────────────────────────


def test_baselines_are_ordered_by_how_clean_their_evidence_is():
    """Only consulted to pick a fallback to SHOW — never to weight the grading, where every baseline that
    speaks gets one equal vote."""
    caps = base("x", rank=2, variant="youtube auto-captions", source=SOURCE_CAPTIONS)
    mix = base("y", rank=1, variant="whisper/mix")
    vocals = base("z", rank=0, variant="whisper/vocals")
    assert [b.variant for b in baselines_of([caps, mix, vocals])] == [
        "whisper/vocals",
        "whisper/mix",
        "youtube auto-captions",
    ]


def test_a_baseline_is_never_a_candidate():
    """The structural reason YouTube's automatic captions are safe here and were not safe as a source of
    record: they cannot be chosen as the song's words while any authored claim exists."""
    lrclib = text(SOURCE_LRCLIB, SOLO_TEXT, "lookup")
    auto = base(FEAT_TEXT, rank=2, variant="youtube auto-captions", source=SOURCE_CAPTIONS)

    assert candidates_of([lrclib, auto]) == [lrclib]
    assert baselines_of([lrclib, auto]) == [auto]
    # even though the auto track's text matches the audio PERFECTLY (it is the audio), the lookup wins
    sel = select_by_baselines([lrclib, auto])
    # The published winner is the lrclib candidate. It is a COPY, not the same object: the
    # selector now clears `alternates` via dataclasses.replace instead of mutating the caller's object
    # in place, so compare by identifying content rather than by `is`.
    assert sel.publish[0].text_source == lrclib.text_source
    assert sel.publish[0].variant == lrclib.variant
    assert sel.publish[0].role == lrclib.role == ROLE_CANDIDATE
    assert not sel.baseline_fallback


def test_with_NO_candidate_the_tiering_system_picks_a_baseline_to_show():
    """A song nobody has written lyrics for. The best available evidence becomes the answer, and says so."""
    sel = select_by_baselines(
        [
            base(ASR_OF_FEAT, rank=1, variant="whisper/mix"),
            base(ASR_OF_FEAT, rank=0, variant="whisper/vocals"),
        ]
    )
    assert sel.baseline_fallback
    assert [t.variant for t in sel.publish] == ["whisper/vocals"]  # best evidence, not first acquired
    assert sel.winner_score is None


def test_no_text_at_all_publishes_nothing():
    sel = select_by_baselines([])
    assert sel.publish == [] and sel.baseline_fallback


# ── the absolute judgement, distinct from the comparative one ───────────────────────────


def test_a_winner_that_disagrees_with_every_baseline_is_flagged_AND_gets_a_real_alternative():
    """Selection is comparative and always returns a best; that says nothing about whether the best is any
    good. When it is not, the room needs words that ARE about this audio — not just a warning label on
    words that are not."""
    wrong = text(
        SOURCE_LRCLIB, "never gonna give you up let down run around desert cry goodbye lie hurt", "wrong"
    )
    sel = select_by_baselines([wrong, base(ASR_OF_FEAT)])

    assert sel.winner_suspect
    assert len(sel.publish) == 2  # the suspect winner AND what was actually heard
    assert sel.publish[1].role == ROLE_BASELINE


def test_a_trustworthy_winner_publishes_alone():
    """The baselines have done their job by grading it. Publishing one anyway would buy a whole extra
    alignment pass to produce words nobody shows."""
    sel = select_by_baselines([text(SOURCE_LRCLIB, FEAT_TEXT, "right"), base(ASR_OF_FEAT)])
    assert not sel.winner_suspect
    assert len(sel.publish) == 1


# ── abstention: what makes a weak baseline safe to include ─────────────────────────────


def test_a_thin_baseline_ABSTAINS_and_is_reported_as_abstaining():
    """YouTube auto-captions on music collapse into [Music] markers (measured: 8 words on one upload).
    Below MIN_TOKENS_TO_COMPARE it cannot vote — and the log has to say so, because a silent abstention
    is indistinguishable from a baseline that agreed."""
    thin = base("la la la", rank=2, variant="youtube auto-captions", source=SOURCE_CAPTIONS)
    sel = select_by_baselines([text(SOURCE_LRCLIB, FEAT_TEXT, "v"), base(ASR_OF_FEAT), thin])

    assert sel.choices == []  # one version, no choice to report
    assert any("ABSTAINS" in n for n in sel.baseline_notes)
    assert sel.winner_score is not None  # the baseline that COULD speak still judged it


def test_with_no_baseline_able_to_judge_the_metadata_order_stands():
    """An instrumental transcribes to almost nothing. 'Cannot tell' is not 'they differ', so the cheap
    duration ranking survives rather than being overruled by an unusable signal."""
    lrclib = text(SOURCE_LRCLIB, SOLO_TEXT, "solo")
    lrclib.alternates = [text(SOURCE_LRCLIB, FEAT_TEXT, "feat")]

    sel = select_by_baselines([lrclib, base("mmm ooh yeah")])

    assert sel.publish[0].variant == "solo"
    assert sel.choices[0].decided_by == "metadata"
    assert sel.winner_score is None
    assert not sel.winner_suspect  # unjudged must never read as "probably wrong"


def test_no_baselines_at_all_still_yields_a_candidate():
    lrclib = text(SOURCE_LRCLIB, SOLO_TEXT, "solo")
    lrclib.alternates = [text(SOURCE_LRCLIB, FEAT_TEXT, "feat")]
    sel = select_by_baselines([lrclib])
    assert sel.publish[0].variant == "solo"
    assert sel.winner_score is None


def test_an_exact_tie_keeps_the_better_METADATA_match():
    """Identical text on both records — the baselines cannot separate them, so the earlier (better
    duration match) must win rather than the later one displacing it arbitrarily."""
    first = text(SOURCE_LRCLIB, FEAT_TEXT, "closest-duration")
    first.alternates = [text(SOURCE_LRCLIB, FEAT_TEXT, "further-away")]

    sel = select_by_baselines([first, base(ASR_OF_FEAT)])

    assert sel.publish[0].variant == "closest-duration"


def test_the_best_candidate_ACROSS_sources_wins_not_merely_within_one():
    """Two authored sources, each internally resolved, then compared to each other by the same ruler."""
    lrclib = text(SOURCE_LRCLIB, SOLO_TEXT, "lrclib-solo")
    caps = text(SOURCE_CAPTIONS, FEAT_TEXT, "caps-feat")

    sel = select_by_baselines([lrclib, caps, base(ASR_OF_FEAT)])

    assert sel.publish[0].variant == "caps-feat"


def test_an_UNJUDGED_candidate_never_displaces_a_graded_one_ACROSS_sources():
    """The single line the whole two-tier design funnels into: baselines grade candidates, and this
    comparison turns those grades into published text. A candidate the baselines COULD NOT judge at all
    (its own text below MIN_TOKENS_TO_COMPARE, so `composite_score` returns None) must never outrank a
    candidate measured at real agreement — regardless of which source was acquired first. If it did, the
    room gets unverified words while correct ones were in hand, and the `winner_suspect` safety net can
    never fire because a None score reads as neither trustworthy nor suspect."""
    graded = text(SOURCE_LRCLIB, FEAT_TEXT, "lrclib-full")  # 31 distinct tokens -> judged ~0.94
    stub = text(SOURCE_CAPTIONS, "la la la", "captions-stub")  # 1 distinct token  -> UNJUDGEABLE

    # Both acquisition orders must publish the GRADED candidate with its REAL score, never the stub.
    for pool, order in (([graded, stub], "graded-first"), ([stub, graded], "stub-first")):
        sel = select_by_baselines([*pool, base(ASR_OF_FEAT)])
        assert sel.publish[0].variant == "lrclib-full", f"unjudged candidate displaced the winner ({order})"
        assert sel.winner_score is not None, f"winner lost its real score to an unjudged candidate ({order})"


def test_between_two_UNJUDGEABLE_candidates_the_first_acquired_stands():
    """When neither candidate can be graded, 'cannot tell' is not 'they differ' — the earlier (better
    metadata match) must stand rather than the later one displacing it arbitrarily. This pins the strict
    `>` in the cross-source comparison: a `>=` would silently let registry acquisition ORDER hand the win
    to whichever ungradeable candidate came last."""
    first = text(SOURCE_LRCLIB, "mmm ooh yeah", "first-acquired")  # both under MIN_TOKENS_TO_COMPARE,
    second = text(SOURCE_CAPTIONS, "na na hey", "second-acquired")  # so neither can be judged

    sel = select_by_baselines([first, second, base(ASR_OF_FEAT)])

    assert sel.publish[0].variant == "first-acquired"
    assert sel.winner_score is None  # nothing could judge either — must not read as a real score


def test_the_report_names_the_loser_and_its_score_for_the_log():
    """A decision nobody can read is a decision nobody can debug — the operator needs to see which
    version lost, by how much, and on how many votes."""
    lrclib = text(SOURCE_LRCLIB, SOLO_TEXT, "solo")
    lrclib.alternates = [text(SOURCE_LRCLIB, FEAT_TEXT, "feat")]

    sel = select_by_baselines([lrclib, base(ASR_OF_FEAT)])

    report = sel.choices[0]
    assert report.chosen == "feat"
    assert [label for label, _ in report.rejected] == ["solo"]
    assert "solo" in report.summary() and "feat" in report.summary()
    assert "1 baseline" in report.summary()


# ── artifact keys: two baselines from one source must not overwrite each other ──────────


def test_the_tag_keeps_same_source_texts_from_clobbering_each_other():
    """Two baselines are both `asr` and two caption tiers are both `captions`. Without the tag the second
    write of a pair silently destroys the first — and destroys exactly the independence that makes
    averaging baselines worth doing."""
    vocals = candidate_key("m1", SOURCE_ASR, TIMING_LINE, "vocals")
    mix = candidate_key("m1", SOURCE_ASR, TIMING_LINE, "mix")
    assert vocals != mix
    manual = candidate_key("m1", SOURCE_CAPTIONS, TIMING_LINE, "manual")
    auto = candidate_key("m1", SOURCE_CAPTIONS, TIMING_LINE, "auto")
    assert manual != auto
    # a source with no tag keeps its historical key shape
    assert candidate_key("m1", SOURCE_LRCLIB, TIMING_LINE) == "derived/lyrics/m1-lrclib-line.json"


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
        [
            rec(id=1, artist_name="Lady Gaga", duration=243.0),
            rec(id=2, artist_name="Lady Gaga feat. Beyoncé", duration=243.0),
        ],
        duration=243.0,
        credit="Lady Gaga feat. Beyoncé",
    )
    assert [r.id for r in pool] == [2, 1]


def test_duration_outranks_the_credit():
    """Ordering of the axes, pinned. A record whose LENGTH matches the audio is better evidence than one
    whose artist string reads well: the credit is parsed from an upload title and is often wrong."""
    pool = rank_lrclib_candidates(
        [
            rec(id=1, artist_name="Lady Gaga feat. Beyoncé", duration=180.0),
            rec(id=2, artist_name="Lady Gaga", duration=243.0),
        ],
        duration=243.0,
        credit="Lady Gaga feat. Beyoncé",
    )
    assert [r.id for r in pool] == [2, 1]


def test_the_pool_is_capped():
    """Bounds log noise and response handling; a popular song can have dozens of records."""
    assert len(rank_lrclib_candidates([rec(id=i) for i in range(40)], limit=5)) == 5


def test_a_record_label_names_the_version_for_the_log():
    r = rec(
        id=77, track_name="Telephone", artist_name="Lady Gaga", album_name="The Fame Monster", duration=243.0
    )
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
        media_id="m1",
        artist="Lady Gaga",
        track="Telephone",
        artist_credit="Lady Gaga feat. Beyoncé",
        duration=243.0,
    )


def test_the_source_searches_and_attaches_the_losing_versions_as_alternates():
    """The pool reaches the chain intact so `select_by_baselines` has something to choose between — one
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


def test_authored_captions_are_a_CANDIDATE_and_authoritative():
    """`high` confidence is defensible only because an automatic track cannot reach this tier — the two
    arrive from separate fetches into separate directories. See test_captions.py.

    The ROLE is asserted through the registry (below), not here: the source no longer decides its own tier.
    """
    got = CaptionsSource().fetch(
        LyricsRequest(media_id="m", caption_segments=[{"start": 0.0, "end": 2.0, "text": "hello hello baby"}])
    )
    assert got is not None
    assert got.text_source == SOURCE_CAPTIONS
    assert got.text_confidence == "high"
    assert got.timing == TIMING_LINE  # a cue bounds a LINE; word timings come from the aligner
    assert got.tag == "manual"


def test_automatic_captions_are_never_authoritative():
    """The reversal the two-tier split earns. The same text that would be dangerous as a source of record
    is useful as a third opinion on what is audible — and `low` keeps isAuthoritativeText() false, so even
    when it is all that is left the TV labels it.
    """
    got = AutoCaptionsSource().fetch(
        LyricsRequest(
            media_id="m", auto_caption_segments=[{"start": 0.0, "end": 2.0, "text": "hello hello baby"}]
        )
    )
    assert got is not None
    assert got.text_confidence == "low"
    assert got.tag == "auto"


def test_the_REGISTRY_decides_which_tier_each_source_speaks_in():
    """The two-tier split, asserted where it is now declared — and the assertion the old pair could not
    make.

    Those tests read `role` off a directly-constructed source, so they were checking that `chain.py` agreed
    with itself. The authored-captions one was worse than redundant: CANDIDATE is `LyricsText`'s default, so
    it would have passed even with the assignment deleted. This drives the real path — registry builds the
    source, source fetches, registry stamps the tier — so a source and its spec cannot disagree.
    """
    req = LyricsRequest(
        media_id="m",
        caption_segments=[{"start": 0.0, "end": 2.0, "text": "hello hello baby"}],
        auto_caption_segments=[{"start": 0.0, "end": 2.0, "text": "hello hello baby"}],
    )
    sources, _ = build_sources(req)
    by_tier = {}
    for src in sources:
        got = src.fetch(req)
        if got is not None:
            by_tier[got.text_source, got.tag] = (got.role, got.baseline_rank)

    assert by_tier[SOURCE_CAPTIONS, "manual"] == (ROLE_CANDIDATE, None)
    assert by_tier[SOURCE_CAPTIONS, "auto"] == (ROLE_BASELINE, BASELINE_CAPTIONS_AUTO)


def test_the_two_caption_kinds_read_from_SEPARATE_inputs():
    """Structural, not a filter: an authored track cannot arrive through the automatic door or vice versa,
    because they are different fields fed by different yt-dlp fetches."""
    only_auto = LyricsRequest(
        media_id="m", auto_caption_segments=[{"start": 0.0, "end": 2.0, "text": "hi there"}]
    )
    assert CaptionsSource().fetch(only_auto) is None
    assert AutoCaptionsSource().fetch(only_auto) is not None

    only_manual = LyricsRequest(
        media_id="m", caption_segments=[{"start": 0.0, "end": 2.0, "text": "hi there"}]
    )
    assert AutoCaptionsSource().fetch(only_manual) is None
    assert CaptionsSource().fetch(only_manual) is not None


def test_captions_cannot_be_about_a_different_version_of_the_song():
    """Why the authored tier exists at all. It is attached to the exact upload being sung over, so unlike a
    database lookup it has no notion of 'another recording' to get wrong — hence no alternates."""
    got = CaptionsSource().fetch(
        LyricsRequest(media_id="m", caption_segments=[{"start": 0.0, "end": 2.0, "text": "hello"}])
    )
    assert got is not None
    assert got.alternates == []


# ── overshoot demotion: a candidate timed past audio-end loses to one that fits ─────────────
#
# Owner ruling B: a candidate whose own timings run well past the end of the audio is a wrong-version
# pick (its lyrics belong to a longer master), and it must be DEMOTED during selection so a rival that
# fits wins. Comparative, not a threshold — the demotion steers the same argmax selection already runs.
# The two real cases overshoot by +39% and +27% of duration; the tolerance band is OVERSHOOT_FRACTION_MAX.

from src.lyrics.chain import OVERSHOOT_FRACTION_MAX  # noqa: E402


def timed(source, body, variant, per_word_end, *, role=ROLE_CANDIDATE):
    """A candidate whose segments carry real end times, so its overshoot is measurable at selection.

    Each word-line ends at `per_word_end` (the last one is the candidate's last_end), so a caller sets
    where this candidate's timings STOP relative to the audio duration.
    """
    words = body.split(" ")
    segs = [{"start": 0.0, "end": float(per_word_end), "text": w} for w in words]
    t = LyricsText(
        text_source=source,
        segments=segs,
        timing=TIMING_LINE,
        text_confidence="high",
        role=role,
        variant=variant,
    )
    return t


def test_a_candidate_timed_past_audio_end_is_DEMOTED_below_one_that_fits():
    """The headline fix. Two candidates, DIFFERENT sources; the over-covered one agrees with the audio
    MORE, so on raw score alone it would win — exactly the '0.94 wrong-version beats 0.55 clean rival'
    trap the issue describes. Overshoot must flip the pick to the candidate that fits the audio length.

    MECHANISM: on base, overshoot is invisible to selection, so the higher-agreement over-covered
    candidate wins the argmax and this test reds (asserts the wrong variant). On head the penalty
    demotes it below the fitting rival. Duration 100s; the over-covered candidate ends at 180s (+80%,
    far past OVERSHOOT_FRACTION_MAX), the fitting one ends at 90s.
    """
    baseline_body = SHARED  # what the audio actually contains
    over = timed(SOURCE_LRCLIB, f"{SHARED} {GUEST_VERSE}", "wrong-longer-master", per_word_end=180.0)
    fits = timed(SOURCE_CAPTIONS, SHARED, "fits-the-audio", per_word_end=90.0)

    sel = select_by_baselines([over, fits, base(baseline_body)], duration_sec=100.0)

    assert sel.publish[0].variant == "fits-the-audio"


def test_the_same_two_candidates_WITHOUT_a_duration_keep_the_raw_ranking():
    """Fail-open control: with no duration, overshoot cannot be judged, so raw agreement decides and the
    over-covered (higher-agreement) candidate wins — proving the demotion is what flips the pick above,
    not some incidental ordering."""
    over = timed(SOURCE_LRCLIB, f"{SHARED} {GUEST_VERSE}", "wrong-longer-master", per_word_end=180.0)
    fits = timed(SOURCE_CAPTIONS, SHARED, "fits-the-audio", per_word_end=90.0)

    sel = select_by_baselines([over, fits, base(f"{SHARED} {GUEST_VERSE}")], duration_sec=None)

    assert sel.publish[0].variant == "wrong-longer-master"


def test_a_small_overshoot_within_tolerance_does_not_change_the_pick():
    """The owner's stated trap: a same-recording LRC with a short trailing artefact cue must NOT be
    rejected. A candidate ending a hair past duration (well under OVERSHOOT_FRACTION_MAX) still wins on
    agreement."""
    assert OVERSHOOT_FRACTION_MAX >= 0.05  # sanity: the tolerance band exists
    small_over = timed(
        SOURCE_LRCLIB, f"{SHARED} {GUEST_VERSE}", "same-master-trailing-cue", per_word_end=102.0
    )
    fits = timed(SOURCE_CAPTIONS, SHARED, "shorter", per_word_end=90.0)

    sel = select_by_baselines([small_over, fits, base(f"{SHARED} {GUEST_VERSE}")], duration_sec=100.0)

    assert sel.publish[0].variant == "same-master-trailing-cue"


def test_winner_score_reports_raw_agreement_not_the_penalty():
    """Provenance stays honest: the penalty steers the comparison, it is not folded into the reported
    score. A fitting winner's winner_score is its true agreement in [0, 1]."""
    over = timed(SOURCE_LRCLIB, f"{SHARED} {GUEST_VERSE}", "wrong-longer-master", per_word_end=180.0)
    fits = timed(SOURCE_CAPTIONS, SHARED, "fits-the-audio", per_word_end=90.0)

    sel = select_by_baselines([over, fits, base(SHARED)], duration_sec=100.0)

    assert sel.winner_score is not None and 0.0 <= sel.winner_score <= 1.0


def test_within_one_source_the_overcovered_ALTERNATE_is_demoted_below_the_fitting_one():
    """Same source, two versions (a candidate + its alternate). The over-covered version agrees MORE
    with the audio, so on raw score the WITHIN-POOL argmax picks it — this pins the pool-ranking key
    specifically (the across-source path uses different sources and cannot reach it). On base the
    over-covered alternate wins the pool; on head the fitting one does.

    MECHANISM: reverting the pool argmax key from the penalised `ranked` back to raw `scored` reds here,
    because within one source the penalty is the only thing that can reorder the two versions."""
    lrclib = timed(SOURCE_LRCLIB, f"{SHARED} {GUEST_VERSE}", "wrong-longer-master", per_word_end=180.0)
    lrclib.alternates = [timed(SOURCE_LRCLIB, SHARED, "fits-the-audio", per_word_end=90.0)]

    sel = select_by_baselines([lrclib, base(f"{SHARED} {GUEST_VERSE}")], duration_sec=100.0)

    assert sel.publish[0].variant == "fits-the-audio"
