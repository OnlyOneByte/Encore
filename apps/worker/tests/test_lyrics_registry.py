"""The lyrics source registry: what each source needs, and what it says when it cannot run.

The gap this closes is worth stating plainly, because it is the reason the registry exists rather than a
hardcoded list. `acquire()` swallows a source's miss by design — correct for one song that genuinely has
no lyrics. But it was the ONLY signal, so "this song has no lyrics" and "this provider has been dead for a
month" were the same observation. lrclib.net has been failing 100% on the owner's corp box since a DNS
sinkhole, and nothing said so; it just looked like songs without lyrics.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.lyrics import (  # noqa: E402
    ROLE_BASELINE,
    ROLE_CANDIDATE,
    ROLE_UNSPECIFIED,
    LyricsRequest,
    LyricsText,
    baselines_of,
    candidates_of,
    select_by_baselines,
)
from src.lyrics.registry import (  # noqa: E402
    NEEDS_AUTHORED_CUES,
    NEEDS_MACHINE_CUES,
    NEEDS_METADATA,
    NEEDS_VOCALS_STEM,
    SPECS,
    build_sources,
    unmet,
)


def full_request(**over) -> LyricsRequest:
    """A request every source can serve, so a test can take exactly one thing away."""
    base = dict(
        media_id="m1",
        artist="Lady Gaga",
        track="Telephone",
        duration=243.0,
        audio_path="/media/audio/m1.m4a",
        vocals_path="/media/derived/stems/m1-vocals.m4a",
        caption_segments=[{"start": 0.0, "end": 1.0, "text": "hello"}],
        auto_caption_segments=[{"start": 0.0, "end": 1.0, "text": "hello"}],
    )
    base.update(over)
    return LyricsRequest(**base)


def build(req, **kw):
    return build_sources(
        req, client=object(), to_segments=lambda *a: [], transcriber=object(), normalize=lambda d: d, **kw
    )


# ── the reporting gap this closes ────────────────────────────────────────────────


def test_a_source_that_CANNOT_run_says_which_input_was_missing():
    """The LRCLIB sinkhole, generalised. A bare `return None` inside a source is indistinguishable from an
    instrumental; a declared unmet requirement names the cause."""
    sources, notes = build(full_request(artist=None, track=None))
    joined = " | ".join(notes)
    assert "lrclib: did not run" in joined
    assert NEEDS_METADATA in joined
    assert len(sources) == len(SPECS) - 1


def test_no_vocals_stem_is_reported_rather_than_silent():
    """The common real case: align ran before stems finished, so the cleanest baseline cannot speak. The
    log should say that rather than leaving an operator to infer it from a thinner composite."""
    _, notes = build(full_request(vocals_path=None))
    assert any("asr:vocals" in n and NEEDS_VOCALS_STEM in n for n in notes)


def test_a_request_that_satisfies_everything_reports_nothing():
    """No noise on the happy path — a log line per source every cook would train the operator to skim."""
    sources, notes = build(full_request())
    assert notes == []
    assert len(sources) == len(SPECS)


def test_absent_caption_tracks_are_reported_for_BOTH_kinds_independently():
    """They arrive from separate fetches into separate directories, so they are missing independently."""
    _, notes = build(full_request(caption_segments=[], auto_caption_segments=[]))
    joined = " | ".join(notes)
    assert "captions:authored" in joined and NEEDS_AUTHORED_CUES in joined
    assert "captions:machine" in joined and NEEDS_MACHINE_CUES in joined


# ── the shape of the registry itself ─────────────────────────────────────────────


def test_unmet_names_every_missing_requirement_not_just_the_first():
    got = unmet(frozenset({NEEDS_METADATA, NEEDS_VOCALS_STEM}), full_request(artist=None, vocals_path=None))
    assert got == sorted([NEEDS_METADATA, NEEDS_VOCALS_STEM])


def test_every_spec_declares_a_role_and_baselines_declare_a_rank():
    """A baseline with no rank cannot be ordered when one has to be SHOWN as the fallback answer."""
    for spec in SPECS:
        assert spec.role in {ROLE_BASELINE, ROLE_CANDIDATE}, spec.id
        if spec.is_baseline:
            assert spec.baseline_rank is not None, f"{spec.id} is a baseline with no rank"
        else:
            assert spec.baseline_rank is None, f"{spec.id} is a candidate with a baseline rank"


def test_baseline_ranks_are_unique_so_the_fallback_choice_is_deterministic():
    ranks = [s.baseline_rank for s in SPECS if s.is_baseline]
    assert len(ranks) == len(set(ranks)), f"duplicate baseline ranks: {ranks}"


def test_spec_ids_are_unique():
    ids = [s.id for s in SPECS]
    assert len(ids) == len(set(ids)), f"duplicate source ids: {ids}"


def test_the_registry_still_holds_two_candidates_and_three_baselines():
    """The two-tier shape, pinned. A fourth baseline is fine; a candidate quietly becoming a baseline (or
    the reverse) changes what can be chosen as the song's words."""
    assert sum(1 for s in SPECS if not s.is_baseline) == 2
    assert sum(1 for s in SPECS if s.is_baseline) == 3



def test_a_hand_built_text_with_no_role_is_NON_publishable_fail_closed():
    """#605: the LyricsText.role default is fail-CLOSED. A text built without an explicit role (a test,
    or one rehydrated from disk) must NOT be treated as publishable — it belongs to neither the candidate
    tier (whose winner is published as the song's words) nor the baseline tier (grading evidence). It
    simply does not participate until a role is stamped.

    RED ON BASE: base defaulted `role` to ROLE_CANDIDATE — the publishable tier — so an unspecified text
    silently landed in candidates_of and could be published as the song's words. That is the fail-OPEN
    hole this pins shut."""
    t = LyricsText(text_source="whatever")
    assert t.role == ROLE_UNSPECIFIED
    assert t.role not in {ROLE_CANDIDATE, ROLE_BASELINE}
    # the load-bearing consequence: not in EITHER tier
    assert candidates_of([t]) == [], "an unspecified-role text must not be a publishable candidate"
    assert baselines_of([t]) == [], "an unspecified-role text must not be counted as grading evidence"


def test_a_lone_unspecified_top_level_text_is_never_published_by_select_by_baselines():
    """The fail-closed property proved end-to-end through the selector for a LONE TOP-LEVEL text: a
    single unspecified text yields nothing to publish, rather than being published as the winner. On
    base (default CANDIDATE) it would have been the sole candidate and published.

    Scope note: this covers the top-level list only. The alternates arrangement — where an
    unspecified ALTERNATE of a candidate wins and publishes — is a different reachable path, guarded by
    `test_a_winning_alternate_carries_the_role_the_registry_stamped` below. The old name
    (`..._an_unspecified_text_is_never_published...`) claimed the universal property this test does not
    drive, which is exactly the hole #873 closes."""
    sel = select_by_baselines([LyricsText(text_source="lrclib", segments=[{"text": "some words here"}])])
    assert sel.publish == [], "an unspecified-role top-level text must not be selected for publication"


def test_select_by_baselines_does_not_mutate_a_caller_held_candidate_alternates():
    """#605: `select_by_baselines` used to do `winner.alternates = []` on a caller-owned object, reaching
    across a module boundary to clear a field on the very list the caller passed in. It now copies via
    dataclasses.replace, so the caller's objects are untouched.

    RED ON BASE: on base the in-place assignment empties `winner.alternates`, so the caller's candidate
    loses its alternates after selection."""
    alt = LyricsText(text_source="lrclib", role=ROLE_CANDIDATE, variant="v2",
                     segments=[{"text": "other version words"}])
    cand = LyricsText(text_source="lrclib", role=ROLE_CANDIDATE, variant="v1",
                      segments=[{"text": "the winning words"}], alternates=[alt])
    baseline = LyricsText(text_source="asr", role=ROLE_BASELINE, baseline_rank=0,
                          segments=[{"text": "the winning words"}])
    before = list(cand.alternates)
    select_by_baselines([cand, baseline])
    assert cand.alternates == before, "selection must not clear the caller's candidate.alternates in place"
    assert len(cand.alternates) == 1


def test_a_winning_alternate_carries_the_role_the_registry_stamped():
    """#873: the role stamp must reach a candidate's ALTERNATES, not just the parent it is attached to.

    Driven end to end through the REAL path — `build_sources` builds the `_Classified`-wrapped
    `LrclibSource`, the source fetches two records for one track (metadata-best is the WRONG version,
    the correct one lands in `alternates`), the registry stamps the tier, and `select_by_baselines`
    grades `[cand, *cand.alternates]` against an ASR baseline whose text is the alternate's, so the
    ALTERNATE wins. Nothing here hand-stamps a role: every role on the published text comes from the
    registry, which is the whole point (every existing alternates fixture supplies the stamp production
    does not, so none of them can see this hole).

    RED ON BASE: base stamps only the parent, so the winning alternate publishes at the fail-closed
    ROLE_UNSPECIFIED default. The `role == ROLE_CANDIDATE` assertion reds. GREEN after the fix stamps
    the alternates too.

    NOT VACUOUS: the sentinel asserts the ALTERNATE actually won (`variant == "feat"`), so the guard
    cannot pass by the parent winning instead — in which case the role would be present for the wrong
    reason and the hole would be invisible again.
    """
    from src.lyrics import ROLE_CANDIDATE, SOURCE_LRCLIB, select_by_baselines
    from src.lyrics.artifact import lrclib_to_segments
    from src.lyrics.source import LrclibResult

    shared = "hello hello baby you called i cant hear a thing i have got no service in the club you say"
    guest = "boy the way you blowing up my phone wont make me leave no faster put my coat on faster"
    solo = shared  # the WRONG version for this audio
    feat = f"{shared} {guest}"  # the version the audio actually sings
    asr_of_feat = f"{shared} boy the way you blowing up my fone wont make me leave no faster put my coat on"

    # Duration 243s audio. The SOLO record sits closest in duration (metadata-best → ranked first,
    # becomes the parent), the FEAT record is farther (→ lands in `alternates`). candidate_sort_key
    # ranks on duration proximity, so this ordering is what production would see.
    solo_rec = LrclibResult(
        id=1,
        instrumental=False,
        synced_lyrics=None,
        plain_lyrics=solo,
        track_name="Telephone",
        artist_name="Lady Gaga",
        album_name=None,
        duration=243.0,
    )
    feat_rec = LrclibResult(
        id=2,
        instrumental=False,
        synced_lyrics=None,
        plain_lyrics=feat,
        track_name="Telephone",
        artist_name="Lady Gaga",
        album_name=None,
        duration=210.0,
    )

    class FakeClient:
        def search(self, artist, track):
            return [solo_rec, feat_rec]

    req = full_request(duration=243.0)
    sources, _ = build_sources(
        req, client=FakeClient(), to_segments=lrclib_to_segments, transcriber=object(), normalize=lambda d: d
    )
    lrclib_source = next(s for s in sources if s.name == SOURCE_LRCLIB)

    cand = lrclib_source.fetch(req)
    assert cand is not None
    assert cand.variant == "Lady Gaga — Telephone (243s, #1)"  # solo is the metadata-best parent
    assert len(cand.alternates) == 1  # feat is the alternate, i.e. the version the audio matches

    # An ASR baseline whose words are the FEAT version, so the alternate wins on agreement.
    baseline = LyricsText(
        text_source="asr",
        role=ROLE_BASELINE,
        baseline_rank=0,
        segments=[{"start": 0.0, "end": 1.0, "text": w} for w in asr_of_feat.split(" ")],
        text_confidence="low",
    )

    sel = select_by_baselines([cand, baseline])

    assert sel.publish, "the alternate arrangement must publish a winner"
    # NOT-VACUOUS SENTINEL: the ALTERNATE won, not the parent.
    assert sel.publish[0].variant == "Lady Gaga — Telephone (210s, #2)"
    assert sel.publish[0].text_source == SOURCE_LRCLIB
    # THE PROPERTY: the winning alternate carries the tier the registry stamped, not the
    # fail-closed ROLE_UNSPECIFIED default. RED on base.
    assert sel.publish[0].role == ROLE_CANDIDATE
    assert sel.publish[0].role != ROLE_UNSPECIFIED
