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

from src.lyrics import ROLE_BASELINE, ROLE_CANDIDATE, LyricsRequest  # noqa: E402
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
    return build_sources(req, client=object(), to_segments=lambda *a: [], transcriber=object(), normalize=lambda d: d, **kw)


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


# ── the settings hook ────────────────────────────────────────────────────────────


def test_a_source_can_be_DISABLED_by_id_and_says_so():
    """Filtering is data now: "do not grade with machine captions" is a set difference over SPECS rather
    than an edit to a chain."""
    keep = frozenset(s.id for s in SPECS if s.id != "captions:machine")
    sources, notes = build(full_request(), enabled=keep)
    assert len(sources) == len(SPECS) - 1
    assert any("captions:machine" in n and "disabled" in n for n in notes)


def test_disabled_and_unmet_are_DIFFERENT_reasons():
    """An operator turning a source off and a source that could not run are not the same event, and a log
    that conflated them would send someone hunting for a broken provider."""
    _, notes = build(full_request(vocals_path=None), enabled=frozenset({"lrclib", "asr:vocals"}))
    joined = " | ".join(notes)
    assert "asr:vocals: did not run" in joined  # enabled, but its input is absent
    assert "captions:machine: disabled by settings" in joined


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
