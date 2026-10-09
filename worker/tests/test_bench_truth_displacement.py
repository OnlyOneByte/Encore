"""The corpus's truth quality: the displacement measurement, and the exclusion the harness derives from it.

Hermetic — the envelopes are synthesised and the metadata is written to tmp, so no audio and no model is read.
What matters here is that the four songs that leave accuracy scoring leave it on NUMBERS in
`corpus-truth.json` rather than on their names, that the pooled `all` reading never moves because of the
exclusion, and that a results file says which songs scored. README, "W8b: the corpus's own truth, measured,
and the 28 songs that score".
"""

from __future__ import annotations

import importlib.util
import json
import sys
from collections.abc import Sequence
from pathlib import Path
from types import ModuleType
from typing import Any

import numpy as np
import pytest

SCRIPTS = Path(__file__).resolve().parents[2] / "docs" / "benchmarks" / "forced-alignment" / "scripts"


def _load(name: str) -> ModuleType:
    if name in sys.modules:
        return sys.modules[name]
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


lib: Any = _load("e2e_lib")
gates: Any = _load("e2e_gates")
displacement: Any = _load("truth_displacement")

HOP = 0.02

#: The four songs the owner's W8b decision takes out of accuracy scoring, and on which ground.
DISPLACED = ("bad-guy", "believer", "tfr-chosen")
UNUSABLE = "numb"
#: numb's: its truth leads its audio, and its stem is never quiet at a line start for the arbiter to read it.
UNUSABLE_GROUND = "continuous-vocal"


def envelope_of(loud: Sequence[tuple[float, float]], seconds: float = 60.0) -> np.ndarray:
    """A 0/1 activity envelope that is loud exactly over `loud`, at `activity.HOP_SEC`."""
    frames = np.zeros(int(seconds / HOP))
    for start, end in loud:
        frames[int(start / HOP) : int(end / HOP)] = 1.0
    return frames


def graded_envelope(blocks: Sequence[tuple[float, float, float]], seconds: float = 60.0) -> np.ndarray:
    """An envelope at a LEVEL per block, for the two predicates a 0/1 fixture cannot tell apart."""
    frames = np.zeros(int(seconds / HOP))
    for start, end, level in blocks:
        frames[int(start / HOP) : int(end / HOP)] = level
    return frames


def truth_of(starts: Sequence[float]) -> tuple[Any, ...]:
    return tuple(lib.TruthLine(f"line {n}", start, start + 2.0) for n, start in enumerate(starts))


def quality(**kw: Any) -> Any:
    fields: dict[str, Any] = {
        "slug": "s",
        "truth_lines": 100,
        "silent_starts": 20,
        "onsets": 20,
        "median_ms": 500.0,
        "mad_ms": 50.0,
        "max_ms": 900.0,
        "lag_ms": 500.0,
        "correlation": 0.5,
        "starts_level_median": 0.5,
        "method": lib.DISPLACEMENT_METHOD,
    }
    return lib.TruthQuality(**{**fields, **kw})


# ── the measurement ──────────────────────────────────────────────────────────────────────────────────


def test_a_start_in_silence_measures_the_delay_to_the_singing_that_follows() -> None:
    """The one-sided reading: a start 0.6 s before the singing reads +0.6, and one inside it abstains."""
    env = envelope_of([(10.6, 14.0), (30.0, 34.0)])
    assert displacement.starts_in_silence(env, 10.0, HOP)
    assert not displacement.starts_in_silence(env, 30.0, HOP), "a start ON the singing is not in silence"
    assert displacement.singing_after(env, 10.0, HOP) == pytest.approx(0.6, abs=HOP)
    reading = displacement.read_song(env, truth_of([10.0, 30.0]), lag_ms=0.0, correlation=0.5, hop=HOP)
    assert (reading.silent_starts, len(reading.onsets)) == (1, 1)
    assert reading.as_json()["median_ms"] == pytest.approx(600.0, abs=20.0)


def test_a_silent_start_with_no_singing_within_reach_is_counted_but_not_timed() -> None:
    """`silent_starts` and `onsets` are different denominators, and the share rule reads the second."""
    env = envelope_of([(50.0, 55.0)])
    reading = displacement.read_song(env, truth_of([10.0]), lag_ms=0.0, correlation=0.5, hop=HOP)
    assert (reading.silent_starts, len(reading.onsets)) == (1, 0)
    assert reading.as_json()["median_ms"] is None and reading.as_json()["max_ms"] is None


def test_a_start_at_the_tail_of_a_sung_phrase_is_not_in_silence() -> None:
    """`starts_in_silence` reads the window's MEAN, not its quietest frame.

    Every other fixture here is binary 0/1 with multi-second blocks, so no probe window is ever partially
    loud and `window.min()` would pass them all — while calling a start sitting inside singing with one quiet
    frame "silent" and inflating both `silent_starts` and the median (review r2-tests-16).
    """
    frames = graded_envelope([(10.0, 14.0, 0.8)])
    quiet = int(10.1 / HOP)
    frames[quiet] = 0.0
    assert not displacement.starts_in_silence(frames, 10.0, HOP)
    level = displacement.level_at(frames, 10.0, HOP)
    assert level is not None and level == pytest.approx(0.733, abs=0.01)
    assert frames[quiet] < displacement.SILENT_LEVEL, "the one quiet frame the mean absorbs"


def test_a_breath_before_the_singing_is_not_the_onset_the_delay_is_measured_to() -> None:
    """`singing_after`'s HOLD: a transient over `SINGING_LEVEL` that falls back is not where singing resumes.

    numb's measured shape, and the conjunct no 0/1 fixture can see — without the hold this start reads +0.4 s
    off a single loud frame instead of the +1.0 s to the phrase (review r2-tests-16).
    """
    frames = graded_envelope([(10.4, 10.42, 0.5), (11.0, 14.0, 0.8)])
    assert displacement.starts_in_silence(frames, 10.0, HOP)
    assert displacement.singing_after(frames, 10.0, HOP) == pytest.approx(1.0, abs=HOP)
    burst = int(10.4 / HOP)
    assert frames[burst] >= displacement.SINGING_LEVEL, "the transient does reach the singing level"
    assert frames[burst : burst + int(displacement.HOLD_SEC / HOP)].min() < displacement.SILENT_LEVEL


def test_the_reading_records_the_stems_own_level_at_a_truth_start() -> None:
    """Over EVERY start, silent or not: it is what says whether the silence arbiter could read this song."""
    frames = graded_envelope([(10.0, 14.0, 0.8), (30.0, 34.0, 0.2)])
    reading = displacement.read_song(frames, truth_of([10.0, 30.0]), lag_ms=0.0, correlation=0.5, hop=HOP)
    assert reading.as_json()["starts_level_median"] == pytest.approx(0.5, abs=0.01)
    assert reading.silent_starts == 0, "both starts are above the silence bar, at different levels"
    empty = displacement.read_song(frames, (), lag_ms=0.0, correlation=0.5, hop=HOP)
    assert empty.as_json()["starts_level_median"] is None


def test_the_reading_records_its_spread_and_its_worst_line() -> None:
    env = envelope_of([(10.4, 12.0), (20.6, 22.0), (31.0, 33.0)])
    reading = displacement.read_song(env, truth_of([10.0, 20.0, 30.0]), lag_ms=0.0, correlation=0.5, hop=HOP)
    written = reading.as_json()
    assert written["onsets"] == 3
    assert written["median_ms"] == pytest.approx(600.0, abs=20.0)
    assert written["max_ms"] == pytest.approx(1000.0, abs=20.0)
    assert written["mad_ms"] == pytest.approx(200.0, abs=20.0)
    assert written["method"] == lib.DISPLACEMENT_METHOD


# ── the rule ─────────────────────────────────────────────────────────────────────────────────────────


def test_a_displacement_needs_both_readings_over_the_limit() -> None:
    """Neither number alone excludes a song: the silent-start median is one-sided and the lag has known
    false positives (never-be-alone, −800 ms at r 0.77)."""
    assert quality().displaced
    assert not quality(median_ms=lib.DISPLACEMENT_LIMIT_MS - 1).displaced
    assert not quality(lag_ms=lib.DISPLACEMENT_LIMIT_MS - 1).displaced
    assert not quality(median_ms=None, onsets=0).displaced


def test_a_lag_the_worker_would_not_use_cannot_be_the_second_witness() -> None:
    """The second conjunct is a READING, so it carries a quality bar: `lib.MIN_LAG_CORRELATION`.

    Without one, a lag that landed past the limit by noise satisfied "an independent second witness" — the
    phrase the rule is sold on (review r2-spec-8). bad-guy's +780 ms sits at r 0.19, under the bar the worker
    itself refuses to offer a lag as a clock candidate at, so bad-guy is displaced on the OTHER branch.
    """
    assert quality().lag_corroborates
    assert not quality(correlation=lib.MIN_LAG_CORRELATION - 0.01).lag_corroborates
    assert not quality(lag_ms=lib.DISPLACEMENT_LIMIT_MS - 1).lag_corroborates
    weak = quality(correlation=0.19)
    assert not weak.lag_corroborates and not weak.silence_stands_alone
    assert not weak.displaced, "20 of 100 starts at 500 ms is not enough to stand without a witness"
    assert "under the" in (quality(median_ms=900.0, onsets=40, correlation=0.19).exclusion or "")


def test_the_silence_arbiter_alone_needs_twice_each_of_its_own_bars() -> None:
    """bad-guy's shape, and the only branch that admits a song whose lag cannot corroborate.

    Twice the onset count, twice the share and twice the displacement limit — one stated doubling rather than
    a threshold read off the song it has to admit. bad-guy: 27 of 79 starts (share 0.34) at a median 834 ms.
    """
    strong = quality(onsets=27, truth_lines=79, median_ms=834.0, lag_ms=780.0, correlation=0.19)
    assert strong.silence_stands_alone and strong.displaced
    assert not quality(
        onsets=2 * lib.MIN_DISPLACEMENT_ONSETS - 1,
        truth_lines=10,
        median_ms=834.0,
        correlation=0.19,
    ).displaced
    assert not quality(
        onsets=27, truth_lines=79, median_ms=2 * lib.DISPLACEMENT_LIMIT_MS - 1, correlation=0.19
    ).displaced
    half = quality(onsets=15, truth_lines=73, median_ms=834.0, correlation=0.19)
    assert half.onset_share < 2 * lib.MIN_DISPLACEMENT_SHARE and not half.displaced


def test_the_rules_bars_are_the_workers_own_numbers_and_not_a_second_opinion() -> None:
    """Each limit this file reads is reused from the shipped aligner or from the measurement tool, so the two
    cannot drift apart silently — the provenance the `#:` comments claim, as an assertion."""
    from encore_worker.domain.lyrics import claimmap

    assert lib.MIN_LAG_CORRELATION == claimmap.MIN_ENVELOPE_CORRELATION
    assert lib.CONTINUOUS_VOCAL_LEVEL == displacement.SINGING_LEVEL


def test_thin_evidence_is_not_a_displacement_however_large_the_median() -> None:
    """`Avercage_-_Embers` reads +929 ms over 4 of 42 lines and is NOT displaced; one line is not a median."""
    assert quality(onsets=lib.MIN_DISPLACEMENT_ONSETS - 1).confidence == lib.THIN
    assert quality(onsets=4, truth_lines=42, median_ms=929.0, lag_ms=900.0).displaced is False
    share = lib.MIN_DISPLACEMENT_SHARE
    assert quality(onsets=10, truth_lines=int(10 / share) + 10).confidence == lib.THIN
    assert quality(onsets=10, truth_lines=int(10 / share)).confidence == lib.MEASURED
    assert quality(onsets=0, median_ms=None).confidence == lib.NO_EVIDENCE


def test_the_onset_count_floor_refuses_a_song_its_share_alone_would_admit() -> None:
    """`MIN_DISPLACEMENT_ONSETS` is published in `corpus-truth.json`'s `limits`, so it is pinned on its own.

    Both of the assertions above sit under the share floor as well, so each is satisfied by that conjunct
    alone; at share 1.0 only the count can refuse the reading."""
    lines = lib.MIN_DISPLACEMENT_ONSETS - 1
    assert quality(onsets=lines, truth_lines=lines).onset_share == 1.0
    assert quality(onsets=lines, truth_lines=lines).confidence == lib.THIN
    full = lib.MIN_DISPLACEMENT_ONSETS
    assert quality(onsets=full, truth_lines=full).confidence == lib.MEASURED


def test_the_exclusion_reason_carries_the_numbers_that_caused_it() -> None:
    reason = quality(median_ms=834.0, onsets=27, truth_lines=79, lag_ms=780.0).exclusion
    assert reason is not None
    assert "834 ms" in reason and "27 of 79" in reason and "+780 ms" in reason
    assert quality(median_ms=100.0).exclusion is None, "a song inside the limit scores"


def test_a_song_may_leave_scoring_on_a_named_ground_other_than_displacement() -> None:
    """numb's ground. The rule's verdict stays `not displaced`, and the reason names the recording instead."""
    thin = quality(onsets=1, truth_lines=35, median_ms=380.0, lag_ms=620.0, unusable=UNUSABLE_GROUND)
    assert not thin.displaced and thin.confidence == lib.THIN
    assert thin.exclusion is not None and thin.exclusion.startswith(UNUSABLE_GROUND)
    assert lib.UNUSABLE_REASONS == frozenset({UNUSABLE_GROUND}), "the set stays closed and stays one entry"


def test_the_metadata_file_is_refused_rather_than_half_understood(tmp_path: Path) -> None:
    """A corpus file the harness cannot read would drop or admit songs silently."""
    path = tmp_path / "corpus-truth.json"
    body: dict[str, Any] = {"songs": {"s": {"truth_lines": 10, "madeup": 1}}}
    path.write_text(json.dumps(body), encoding="utf-8")
    with pytest.raises(ValueError, match="not a truth-quality entry"):
        lib.load_corpus_truth(path)
    good = {
        "truth_lines": 10,
        "silent_starts": 0,
        "onsets": 0,
        "median_ms": None,
        "mad_ms": None,
        "max_ms": None,
        "lag_ms": 0.0,
        "correlation": 0.5,
        "starts_level_median": 0.5,
        "method": lib.DISPLACEMENT_METHOD,
    }
    path.write_text(json.dumps({"songs": {"s": {**good, "unusable": "because-i-said-so"}}}), encoding="utf-8")
    with pytest.raises(ValueError, match="not one of"):
        lib.load_corpus_truth(path)


def test_an_unusable_ground_its_own_numbers_refuse_is_not_an_exclusion(tmp_path: Path) -> None:
    """The `unusable` ground is re-derived like `displaced`, so it is not a one-way door.

    It used to be read verbatim with no numeric precondition at all, and `truth_displacement.py` copied it
    onto every fresh reading — so re-anchoring numb's sheet would have left the exclusion standing on a
    measurement that no longer said anything (review r2-correctness-1). Each conjunct is pinned separately.
    """
    path = tmp_path / "corpus-truth.json"
    held = {
        "truth_lines": 35,
        "silent_starts": 1,
        "onsets": 1,
        "median_ms": 380.0,
        "mad_ms": 0.0,
        "max_ms": 380.0,
        "lag_ms": 620.0,
        "correlation": 0.702,
        "starts_level_median": 0.546,
        "method": lib.DISPLACEMENT_METHOD,
        "unusable": UNUSABLE_GROUND,
        "note": "numb's",
    }

    def written(**edit: Any) -> dict[str, Any]:
        entry = {**held, **edit}
        body = {**entry, **lib.derived_of(lib.TruthQuality(slug="s", **entry))}
        path.write_text(json.dumps({"songs": {"s": body}}), encoding="utf-8")
        return body

    written()
    assert lib.accuracy_exclusions(path)["s"].startswith(UNUSABLE_GROUND), "numb's own numbers, as recorded"
    for edit, said in (
        ({"lag_ms": 0.0}, "under the 250 ms limit"),
        ({"correlation": 0.1}, "under 0.25"),
        ({"starts_level_median": 0.05}, f"under the {lib.CONTINUOUS_VOCAL_LEVEL} bar"),
        ({"starts_level_median": None}, "was not measured"),
        ({"onsets": 20, "truth_lines": 35}, "enough to measure a displacement"),
    ):
        written(**edit)
        with pytest.raises(ValueError, match="no longer support"):
            lib.load_corpus_truth(path)
        with pytest.raises(ValueError, match=said.replace(".", r"\.")):
            lib.load_corpus_truth(path)


def test_an_absent_corpus_file_refuses_rather_than_scoring_every_song(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The file is what says which songs score, so its absence must not read as "none are excluded".

    A sweep from a tree where it was moved or not yet written would otherwise pool all 32 songs and label the
    result a 28-song baseline. Scoring all of them stays possible, as an explicit request that the harness
    fingerprint records."""
    absent = tmp_path / "absent.json"
    with pytest.raises(ValueError, match="nothing says which songs score"):
        lib.accuracy_exclusions(absent)
    monkeypatch.setattr(lib, "CORPUS_TRUTH", absent)
    with pytest.raises(ValueError, match="nothing says which songs score"):
        lib.corpus_truth_bytes()
    monkeypatch.setenv(lib.SCORE_ALL_ENV, "1")
    assert lib.accuracy_exclusions(absent) == {}, "asked for explicitly, nothing is excluded"
    assert lib.corpus_truth_bytes() == lib.NO_CORPUS_TRUTH, "and the fingerprint is not an empty-bytes hash"


def test_the_verdict_the_file_records_is_re_derived_and_never_trusted(tmp_path: Path) -> None:
    """`confidence` and `displaced` are written for a human to read, so an edited one cannot drift unseen."""
    path = tmp_path / "corpus-truth.json"
    entry = {
        "truth_lines": 100,
        "silent_starts": 20,
        "onsets": 20,
        "median_ms": 500.0,
        "mad_ms": 50.0,
        "max_ms": 900.0,
        "lag_ms": 500.0,
        "correlation": 0.5,
        "starts_level_median": 0.5,
        "method": lib.DISPLACEMENT_METHOD,
    }
    honest = {**entry, **lib.derived_of(quality())}
    path.write_text(json.dumps({"songs": {"s": honest}}), encoding="utf-8")
    assert lib.load_corpus_truth(path)["s"].displaced
    path.write_text(json.dumps({"songs": {"s": {**honest, "displaced": False}}}), encoding="utf-8")
    with pytest.raises(ValueError, match="re-run truth_displacement.py"):
        lib.load_corpus_truth(path)
    assert tuple(lib.derived_of(quality())) == lib.DERIVED_KEYS


def test_the_shipped_file_records_the_confidence_and_the_verdict_for_every_song() -> None:
    body = json.loads(lib.CORPUS_TRUTH.read_text(encoding="utf-8"))
    assert body["doc"] == lib.CORPUS_TRUTH_DOC and body["method"] == lib.DISPLACEMENT_METHOD
    assert body["limits"] == {
        "displacement_ms": lib.DISPLACEMENT_LIMIT_MS,
        "min_onsets": lib.MIN_DISPLACEMENT_ONSETS,
        "min_onset_share": lib.MIN_DISPLACEMENT_SHARE,
        "min_lag_correlation": lib.MIN_LAG_CORRELATION,
        "continuous_vocal_level": lib.CONTINUOUS_VOCAL_LEVEL,
    }, "every bar the rule reads is published beside the readings it reads them against"
    for slug, entry in body["songs"].items():
        assert set(lib.DERIVED_KEYS) <= set(entry), f"{slug} records no verdict for a reader"
        assert entry["method"] == lib.DISPLACEMENT_METHOD
        assert entry["starts_level_median"] is not None, f"{slug} records no level at its truth starts"


def test_measuring_one_song_rewrites_the_file_without_losing_the_others(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--songs one --out corpus-truth.json` MEASURES one song and REWRITES the whole file.

    Writing only the measured subset would delete the other songs' numbers, their `unusable` grounds and
    therefore their exclusions — putting them back into accuracy scoring with nothing to show it happened."""
    out = tmp_path / "corpus-truth.json"
    out.write_bytes(lib.CORPUS_TRUTH.read_bytes())
    monkeypatch.setattr(lib, "CORPUS_TRUTH", out)
    before = json.loads(out.read_text(encoding="utf-8"))["songs"]
    one = next(iter(DISPLACED))
    _measures(monkeypatch, one, reading(median=0.9))
    assert displacement.main(["--songs", one, "--out", str(out)]) == 0
    after = json.loads(out.read_text(encoding="utf-8"))["songs"]
    assert set(after) == set(before) and len(after) == 32
    assert {s: e for s, e in after.items() if s != one} == {s: e for s, e in before.items() if s != one}
    assert after[one]["median_ms"] == 900.0, "and the measured song is the one that moved"
    assert sorted(lib.accuracy_exclusions(out)) == sorted([*DISPLACED, UNUSABLE])


def reading(
    *,
    median: float = 0.9,
    onsets: int = 6,
    truth_lines: int = 10,
    lag_ms: float = 900.0,
    level: float | None = 0.6,
) -> Any:
    """A `Reading` — `measure()`'s output, without the audio."""
    return displacement.Reading(
        truth_lines=truth_lines,
        silent_starts=onsets,
        onsets=(median,) * onsets,
        lag_ms=lag_ms,
        correlation=0.5,
        starts_level_median=level,
    )


def _measures(monkeypatch: pytest.MonkeyPatch, slug: str, fresh: Any) -> None:
    """`--songs slug` over a corpus of that one song, with `measure()` returning `fresh`."""
    song = lib.Song(
        slug=slug,
        group=lib.JAMENDO,
        mix=Path("/nonexistent.mp3"),
        vocals=Path("/nonexistent.wav"),
        truth=truth_of([10.0]),
    )
    monkeypatch.setattr(lib, "discover", lambda *_a, **_k: [song])
    monkeypatch.setattr(displacement, "measure", lambda _song: fresh)


def test_re_measuring_the_unusable_song_keeps_a_ground_its_numbers_still_support(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`--songs numb` is the operator action the carry-forward exists for, and the one that can clear it.

    The block used to copy `unusable` / `note` onto any fresh reading unconditionally, and no test failed when
    it was deleted — so numb silently returning to accuracy scoring, or silently staying out of it after a
    re-anchor, were both invisible (review r2-tests-12 and r2-correctness-1).
    """
    out = tmp_path / "corpus-truth.json"
    out.write_bytes(lib.CORPUS_TRUTH.read_bytes())
    monkeypatch.setattr(lib, "CORPUS_TRUTH", out)
    note = json.loads(out.read_text(encoding="utf-8"))["songs"][UNUSABLE]["note"]

    def numbs(lag_ms: float) -> Any:
        """numb's own reading: one timed start of 35, at a stem level no silence test can clear."""
        return reading(onsets=1, truth_lines=35, median=0.38, level=0.546, lag_ms=lag_ms)

    _measures(monkeypatch, UNUSABLE, numbs(620.0))
    assert displacement.main(["--songs", UNUSABLE, "--out", str(out)]) == 0
    kept = json.loads(out.read_text(encoding="utf-8"))["songs"][UNUSABLE]
    assert (kept["unusable"], kept["note"]) == (UNUSABLE_GROUND, note), "the ground and its prose survive"
    assert sorted(lib.accuracy_exclusions(out)) == sorted([*DISPLACED, UNUSABLE])

    # ... and the re-anchor the next wave contemplates: the lag is gone, so the ground goes with it.
    _measures(monkeypatch, UNUSABLE, numbs(10.0))
    assert displacement.main(["--songs", UNUSABLE, "--out", str(out)]) == 0
    assert "DROPPED" in capsys.readouterr().out, "loudly, on the operator's terminal"
    cleared = json.loads(out.read_text(encoding="utf-8"))["songs"][UNUSABLE]
    assert "unusable" not in cleared and "note" not in cleared
    assert sorted(lib.accuracy_exclusions(out)) == sorted(DISPLACED), "numb scores again"


# ── the shipped corpus ───────────────────────────────────────────────────────────────────────────────


def test_the_shipped_corpus_excludes_exactly_the_four_songs_the_owner_named() -> None:
    """A song the file does not measure is refused at `discover()`, so growth cannot outrun the measurement;
    what is checkable without the bench disk is that every slug the REPO declares is in here."""
    excluded = lib.accuracy_exclusions()
    assert sorted(excluded) == sorted([*DISPLACED, UNUSABLE])
    recorded = lib.load_corpus_truth()
    assert len(recorded) == 32, "every corpus song is measured, not only the excluded ones"
    assert set(lib.YOUTUBE_SLUGS) | set(lib.TFR_SLUGS) <= set(recorded)
    for slug in DISPLACED:
        assert "leads its audio" in excluded[slug]
    assert excluded[UNUSABLE].startswith(UNUSABLE_GROUND)


def test_a_committed_results_file_records_the_reason_its_own_sweep_read() -> None:
    """The reason string in `results/` is a RECORD of what the harness said then, and the live corpus file is
    the only source of truth — so what must hold across the two is the SONG SET and the GROUND, not the prose.

    The W8b rows were published before the note that opens numb's entry was re-ordered, and before `exclusion`
    stopped copying that note into every row at all; nothing noticed, because nothing compared them (review
    r2-tests-15). A results file is never rewritten to match today's wording: it would stop being its run's
    own output. What is forbidden is a file whose pool or whose grounds are no longer the corpus file's.
    """
    live = lib.accuracy_exclusions()
    grounds = tuple(f"{reason}:" for reason in sorted(lib.UNUSABLE_REASONS)) + ("truth leads its audio by",)
    seen = 0
    for path in sorted((SCRIPTS.parent / "results").glob("w8b-*.json")):
        recorded = (json.loads(path.read_text(encoding="utf-8")).get("meta") or {}).get("accuracy_excluded")
        if not recorded:
            continue
        seen += 1
        assert sorted(recorded) == sorted(live), f"{path.name} pooled other songs than the corpus file names"
        for slug, reason in recorded.items():
            assert reason.startswith(grounds), f"{path.name}: {slug} on a ground the rule no longer knows"
    assert seen >= 6, "every W8b row that excluded a song is read here"
    assert lib.load_corpus_truth()[UNUSABLE].note not in live[UNUSABLE], "the row carries numbers, not prose"


def test_every_excluded_song_is_excluded_by_the_rule_and_every_kept_one_fails_a_conjunct() -> None:
    """The anti-hardcoding assertion: the exclusion is the measurement's verdict, not a list. A future song
    measured displaced leaves scoring without an edit; a kept song can only be kept by failing a conjunct."""
    recorded = lib.load_corpus_truth()
    assert {slug for slug, q in recorded.items() if q.displaced} == set(DISPLACED)
    for slug in DISPLACED:
        entry = recorded[slug]
        assert entry.confidence == lib.MEASURED
        assert entry.median_ms is not None and entry.median_ms >= lib.DISPLACEMENT_LIMIT_MS
        assert entry.lag_ms >= lib.DISPLACEMENT_LIMIT_MS
    for slug, entry in recorded.items():
        if slug in DISPLACED:
            continue
        assert (
            entry.confidence != lib.MEASURED
            or (entry.median_ms or 0.0) < lib.DISPLACEMENT_LIMIT_MS
            or entry.lag_ms < lib.DISPLACEMENT_LIMIT_MS
        ), f"{slug} satisfies the displacement rule but is not excluded by it"


def test_numbs_displacement_is_not_established_by_the_rule_and_the_record_says_why() -> None:
    """1 of 35 starts in silence — because the stem is never quiet at one, which the note carries with the
    two readings that do not need silence. README, "numb is excluded on a displacement the silence arbiter
    cannot see"."""
    entry = lib.load_corpus_truth()[UNUSABLE]
    assert entry.onsets == 1 and entry.confidence == lib.THIN and not entry.displaced
    assert entry.unusable == UNUSABLE_GROUND
    assert entry.note is not None
    assert "+690 ms" in entry.note and "+620 ms" in entry.note, "both witnesses, with their numbers"
    assert entry.starts_level_median == 0.546, "why the arbiter reads one line, now as a field"
    assert "0.546" in entry.note
    lag, decode = entry.note.index("+620 ms"), entry.note.index("+690 ms")
    assert lag < decode, "the independent reading leads; the aligner's own residual corroborates it"
    assert "residual" in entry.note[decode : decode + 200], "and is labelled as the aligner's own"
    # The superlative that used to stand here was false under its own definition of the set (review
    # r2-spec-10): Kinematic_-_Peyote reads 0.824 on a sheet nothing says is displaced.
    assert "highest of the band songs" not in entry.note
    assert "0.40" in entry.note, "what r 0.702 actually clears: the worker's own activity.MIN_CORRELATION"
    higher = {s: q.correlation for s, q in lib.load_corpus_truth().items() if q.correlation > 0.702}
    assert "Kinematic_-_Peyote" in entry.note and higher["Kinematic_-_Peyote"] == 0.824
    assert set(higher) - {UNUSABLE, *DISPLACED} == set(higher), "none of the excluded four reads higher"


# ── the wiring into a fresh sweep ────────────────────────────────────────────────────────────────────


def _corpus_tree(root: Path, songs: Path, slugs: Sequence[str]) -> None:
    """A bench root `discover()` can walk: one truth line per song, and the jamendo stems it requires."""
    for slug in slugs:
        (root / "jamendo" / slug / "mix").mkdir(parents=True)
        (root / "jamendo" / slug / "mix" / "vocals.wav").write_bytes(b"")
    for slug in lib.YOUTUBE_SLUGS:
        (root / slug).mkdir(parents=True, exist_ok=True)
    for slug in lib.TFR_SLUGS:
        (songs / slug).mkdir(parents=True)
    lines = json.dumps({"lines": [{"text": "aaa bbb", "start": 1.0, "end": 2.0}]})
    for directory in (
        *((root / "jamendo" / slug) for slug in slugs),
        *((root / slug) for slug in lib.YOUTUBE_SLUGS),
        *((songs / slug) for slug in lib.TFR_SLUGS),
    ):
        (directory / "truth-lines.json").write_text(lines, encoding="utf-8")


def test_a_fresh_sweep_hangs_the_exclusion_on_every_songs_source(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`discover()` is the only place a fresh run decides which songs score, and it has three source branches.

    The hermetic tests elsewhere build `Song(accuracy_excluded=...)` by hand, which proves the pooling and not
    the wiring: all three keywords could be deleted with the suite green."""
    jamendo = ("jamendo-one", "jamendo-two")
    excluded = {"jamendo-one", lib.YOUTUBE_SLUGS[0], lib.TFR_SLUGS[0]}
    corpus = tmp_path / "corpus-truth.json"

    def entry(slug: str) -> dict[str, Any]:
        """Displaced for the three the test excludes, inside every limit for the rest."""
        early = slug in excluded
        return {
            "truth_lines": 40,
            "silent_starts": 20,
            "onsets": 20,
            "median_ms": 800.0 if early else 100.0,
            "mad_ms": 50.0,
            "max_ms": 900.0,
            "lag_ms": 700.0 if early else 0.0,
            "correlation": 0.5,
            "starts_level_median": 0.5,
            "method": lib.DISPLACEMENT_METHOD,
        }

    everything = (*jamendo, *lib.YOUTUBE_SLUGS, *lib.TFR_SLUGS)
    corpus.write_text(json.dumps({"songs": {s: entry(s) for s in everything}}), encoding="utf-8")
    monkeypatch.setattr(lib, "CORPUS_TRUTH", corpus)
    _corpus_tree(tmp_path / "bench", tmp_path / "songs", jamendo)
    found = lib.discover(tmp_path / "bench", tmp_path / "songs")
    assert len(found) == 2 + len(lib.YOUTUBE_SLUGS) + len(lib.TFR_SLUGS)
    assert {s.slug for s in found if s.accuracy_excluded is not None} == excluded
    for song in found:
        assert (song.accuracy_excluded is None) == (song.slug not in excluded)
        if song.accuracy_excluded is not None:
            assert "leads its audio by 800 ms" in song.accuracy_excluded


def test_a_corpus_song_nothing_measured_stops_the_sweep_instead_of_scoring(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`discover()` never defaults to "this song scores" — not for an absent file, and not per song either.

    A 33rd song added to the corpus used to pool into a label that says 28 of 32 with nothing recording the
    decision, which is the hole `_no_corpus_truth` exists to close one level up (review r2-spec-11).
    """
    corpus = tmp_path / "corpus-truth.json"
    monkeypatch.setattr(lib, "CORPUS_TRUTH", corpus)
    _corpus_tree(tmp_path / "bench", tmp_path / "songs", ("jamendo-one",))

    corpus.write_text(json.dumps({"songs": {}}), encoding="utf-8")
    with pytest.raises(ValueError, match="names no song"):
        lib.discover(tmp_path / "bench", tmp_path / "songs")
    for body in ({"doc": "x"}, {"songs": None}):
        corpus.write_text(json.dumps(body), encoding="utf-8")
        with pytest.raises(ValueError, match="nothing says which songs score"):
            lib.accuracy_exclusions(corpus)

    one = {
        "truth_lines": 1,
        "silent_starts": 0,
        "onsets": 0,
        "median_ms": None,
        "mad_ms": None,
        "max_ms": None,
        "lag_ms": 0.0,
        "correlation": 0.5,
        "starts_level_median": 0.5,
        "method": lib.DISPLACEMENT_METHOD,
    }
    corpus.write_text(json.dumps({"songs": {"jamendo-one": one}}), encoding="utf-8")
    with pytest.raises(ValueError, match=f"no entry for {lib.YOUTUBE_SLUGS[0]}"):
        lib.discover(tmp_path / "bench", tmp_path / "songs")
    monkeypatch.setenv(lib.SCORE_ALL_ENV, "1")
    found = lib.discover(tmp_path / "bench", tmp_path / "songs")
    assert [s.accuracy_excluded for s in found] == [None] * len(found), "asked for explicitly"


def test_the_rows_a_sweep_writes_carry_the_exclusion_and_a_document_records_its_pool(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A results file must say which songs its pooled numbers were read over, rather than leaving a later
    reader to re-derive it from whatever `corpus-truth.json` says then (`e2e_gates.view_of` reads this)."""
    reason = "truth leads its audio by 800 ms"
    rows = _rows(reason)
    assert [row["accuracy_excluded"] for row in rows] == [None, reason], "every row carries its own answer"
    path = tmp_path / "rows.jsonl"
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    assert lib.rows_document(path)["meta"]["accuracy_excluded"] == {"dropped": reason}
    monkeypatch.setattr(lib, "CORPUS_TRUTH", tmp_path / "none.json")
    monkeypatch.setenv(lib.SCORE_ALL_ENV, "1")
    assert lib.exclusions_of(rows) == {"dropped": reason}, "the rows' own answer, not today's corpus file"


# ── what a results file shows ────────────────────────────────────────────────────────────────────────


def _rows(excluded: str | None) -> list[dict[str, Any]]:
    """Two songs, one of them excluded, each published 0.8 s late — inside the band, outside ±500."""
    out = []
    for slug, reason in (("keeper", None), ("dropped", excluded)):
        song = lib.Song(
            slug=slug,
            group=lib.YOUTUBE,
            mix=Path("/nonexistent.wav"),
            vocals=Path("/nonexistent.wav"),
            truth=truth_of([10.0, 20.0, 30.0, 40.0]),
            accuracy_excluded=reason,
        )
        claims = lib.build_claims(song, "truth", corpus=[song], duration_sec=60.0)
        late = 0.0 if slug == "keeper" else 0.8
        doc = [
            lib.DocLine("", t.start + late, t.start + late + 1.0, "high", n, ())
            for n, t in enumerate(song.truth)
        ]
        out.append(
            lib.row_of(song=song, mode="truth", variant=0, claims=claims, outcome=lib.PUBLISHED, doc=doc)
        )
    return out


def test_the_scored_pool_leaves_the_excluded_song_out_and_all_keeps_it() -> None:
    summary = lib.summarize(_rows("truth leads its audio by 800 ms"))["truth"]
    assert summary["all"]["lines"]["scored"] == 8 and summary["all"]["lines"]["w500_pct"] == 50.0
    assert summary["scored"]["lines"]["scored"] == 4 and summary["scored"]["lines"]["w500_pct"] == 100.0
    assert summary["all"]["lines"]["band"] == 4 and summary["scored"]["lines"]["band"] == 0
    assert summary["youtube"] == summary["all"], "the exclusion never moves an existing group"
    assert lib.GROUPS == (lib.JAMENDO, lib.YOUTUBE, lib.SCORED, lib.ALL)


def test_nothing_is_excluded_when_the_corpus_says_nothing() -> None:
    summary = lib.summarize(_rows(None))["truth"]
    assert summary["scored"]["lines"] == summary["all"]["lines"], "`scored` is `all` until a song leaves it"


def test_a_results_file_says_which_songs_scored_and_why_the_others_did_not() -> None:
    reason = "truth leads its audio by 800 ms (median over 3 of 4 line starts landing in stem silence)"
    songs = lib.per_song(_rows(reason))["truth"]
    assert songs["dropped"]["accuracy_excluded"] == reason
    assert "accuracy_excluded" not in songs["keeper"], "only a song that did not score carries a reason"
    assert songs["dropped"]["pm500"] == 0.0, "its numbers are still measured, and still readable"


def test_a_row_measured_before_the_exclusion_existed_still_splits_the_pool() -> None:
    """Every committed baseline is such a row, and `--compare` must pool the same 28 songs on both sides."""
    rows = _rows(None)
    rows[1]["song"] = next(iter(DISPLACED))
    for row in rows:
        del row["accuracy_excluded"]
    assert lib.excluded_of(rows[1]) == lib.accuracy_exclusions()[next(iter(DISPLACED))]
    assert lib.in_group(rows[0], lib.SCORED) and not lib.in_group(rows[1], lib.SCORED)
    assert lib.summarize(rows)["truth"]["scored"]["lines"]["scored"] == 4


def test_the_gate_language_can_address_the_scored_pool_on_both_sides() -> None:
    rows = _rows("truth leads its audio by 800 ms")
    document = {"meta": {"level": "time_text"}, "summary": lib.summarize(rows), "songs": lib.per_song(rows)}
    view = gates.view_of(document)
    rules = gates.parse_gates("scored-pool: truth.scored.pm500 >= 100.0\nwhole-corpus: truth.pm500 >= 50.0")
    verdicts = gates.run_gates(rules, view, view)
    assert ("scored-pool", "PASS") in [(v.gate.name, v.status) for v in verdicts]
    assert [v.gate.name for v in verdicts if v.status != "PASS"] == [], gates.format_gates(verdicts)


def test_a_group_the_baseline_predates_is_named_rather_than_dropped_from_the_compare() -> None:
    """Every committed baseline has no `scored` column, and a silently missing column is how a pool goes
    unnoticed. A per-song gate against such a base still pools the same songs (the test above)."""
    rows = _rows("truth leads its audio by 800 ms")
    meta = {"level": "time_text", "seed": 0, "wrong_k": 10, "language": "en"}
    summary = lib.summarize(rows)
    run = {"meta": meta, "summary": summary, "songs": lib.per_song(rows)}
    thinned = {mode: {g: e for g, e in groups.items() if g != lib.SCORED} for mode, groups in summary.items()}
    base = {"meta": meta, "summary": thinned, "songs": run["songs"]}
    said = gates.format_compare(gates.view_of(run), gates.view_of(base))
    assert "groups only in run: scored" in said
    assert "groups only in run" not in gates.format_compare(gates.view_of(run), gates.view_of(run))


def test_the_28_song_baseline_is_what_the_committed_bases_say_over_the_songs_that_score() -> None:
    """The comparison base from here, derived from the committed per-song rows rather than re-measured.

    The pooled reading of a results file written before `scored` existed is recoverable from its own per-song
    entries, so the README's headline is pinned to data in the repo: `truth` ±500 97.07 % / band 44 / missing
    32 over 1504 lines at `run_align`, and 97.12 % / 44 / 10 over 1526 at `time_text` — against 90.45 % and
    163 band lines over all 32. README, "Both ways: 32 songs and the 28 that score".
    """
    excluded = set(lib.accuracy_exclusions())
    for name, lines, pm500, band, missing, pooled32 in (
        ("w8a-band-run_align", 1504, 97.07, 44, 32, 90.45),
        ("w8a-base-time_text", 1526, 97.12, 44, 10, 90.89),
    ):
        body = json.loads((SCRIPTS.parent / "results" / f"{name}.json").read_text(encoding="utf-8"))
        kept = {s: e for s, e in body["songs"]["truth"].items() if s not in excluded}
        assert len(kept) == 28, "the four leave accuracy scoring; the corpus keeps 32"
        scored = sum(e["scored"] for e in kept.values())
        hits = sum(round(e["scored"] * e["pm500"] / 100.0) for e in kept.values())
        assert (scored, round(hits / scored * 100, 2)) == (lines, pm500)
        assert (sum(e["band"] for e in kept.values()), sum(e["missing"] for e in kept.values())) == (
            band,
            missing,
        )
        assert body["summary"]["truth"]["all"]["lines"]["w500_pct"] == pooled32, "and `all` is unchanged"


def test_the_four_carry_the_bands_the_missed_lines_and_every_overclaimed_line() -> None:
    """Why the exclusion matters: 119 of 163 band lines and 94 of 94 `high`-but-wrong lines were theirs."""
    body = json.loads((SCRIPTS.parent / "results" / "w8a-band-run_align.json").read_text(encoding="utf-8"))
    truth = body["songs"]["truth"]
    excluded = set(lib.accuracy_exclusions())
    assert sum(truth[s]["band"] for s in excluded) == 119
    assert sum(truth[s]["missing"] for s in excluded) == 21
    assert body["summary"]["truth"]["all"]["lines"]["band"] == 163
    assert body["summary"]["truth"]["all"]["lines"]["high_bad"] == 94


def test_the_corpus_metadata_is_part_of_the_harness_fingerprint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A file that decides which songs score must move `meta.harness` when it changes.

    Read on a COPY: `harness_digest` resolves `lib.CORPUS_TRUTH` at call time, and a test that edited the repo
    file would leave the tree corrupted if it were killed inside the window (the suite runs ~3 minutes)."""
    e2e: Any = _load("e2e")
    copy = tmp_path / "corpus-truth.json"
    copy.write_bytes(lib.CORPUS_TRUTH.read_bytes())
    monkeypatch.setattr(lib, "CORPUS_TRUTH", copy)
    before = e2e.harness_digest()
    assert before == e2e.harness_digest()
    copy.write_bytes(copy.read_bytes() + b"\n")
    assert e2e.harness_digest() != before
