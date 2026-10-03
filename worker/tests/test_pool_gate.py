"""The MULTI-PROVIDER POOL gate (`docs/benchmarks/forced-alignment/scripts/pool_gate.py`).

It has unit tests like the E2E harness beside it, because this script is what finally MEASURES M13 (the
candidate tier ordered by corroboration rather than arrival order) and L5 (the LRCLIB duration retry), both
of which shipped in W5 on unit tests alone, `e2e.py`'s ports serving one text per case. A defect in the pool
it builds would move that verdict silently — a pool whose texts all read as one witness, a "wrong" sheet
that accidentally contains the song, an SDH variant whose damage text hygiene removes — so the pool's SHAPE
is pinned here, pure, and the arms are driven through the real workflow.

Hermetic: no model, no corpus, no network. The LRCLIB half runs the REAL `LrclibClient` over the script's own
injected opener, which is the point of that seam: the qualified 404 and the retry are production's own path.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from encore_worker.domain.lyrics.policy import Tier, corroboration, order_pool, witness_of
from tests.test_bench_e2e import (
    DURATION,
    PHRASES,
    VoicedAligner,
    _load,
    song_of,
    spread_decodes,
    write_voiced,
)

lib: Any = _load("e2e_lib")
e2e: Any = _load("e2e")
pool_gate: Any = _load("pool_gate")


#: Four songs, so the three wrong-text donors of `allwrong` can differ (the donor pool is the corpus minus
#: the song itself, and `build_claims` picks `variant % len(pool)`).
OTHERS = (
    ("a wholly different sheet of words", 3.0, 9.0),
    ("second donor singing other words", 2.0, 8.0),
    ("third donor with its own lines here", 4.0, 10.0),
)


def corpus_of(audio: Path, mix: Path) -> list[Any]:
    song = song_of(PHRASES, slug="synthetic", audio=audio, mix=mix)
    donors = [
        song_of([line], slug=f"donor{index}", audio=audio, mix=mix) for index, line in enumerate(OTHERS, 1)
    ]
    return [song, *donors]


def claims_of(song: Any, mode: str, corpus: list[Any], variant: int = 0) -> Any:
    return lib.build_claims(song, mode, corpus=corpus, duration_sec=DURATION, variant=variant)


# ── the texts a pool serves ──────────────────────────────────────────────────────────────────────────


def test_the_sdh_track_keeps_every_truth_identity_and_leads_the_singing() -> None:
    """The pollution must be scoreable: a published SDH line pairs with the same truth line a clean
    sheet's does (`e2e_lib.score_lines` pairs through `ClaimLine.truth`), or "better or worse against
    truth" has no denominator. The LEAD is the damage that survives text hygiene."""
    song = song_of(PHRASES, slug="s")
    clean = claims_of(song, "truth", [song, song_of(OTHERS[:1], slug="d")])
    sdh = pool_gate.sdh_track(clean)

    sung = [line for line in sdh.lines if line.truth is not None]
    assert [line.truth for line in sung] == [line.truth for line in clean.lines]
    for before, after in zip(clean.lines, sung, strict=True):
        assert after.start == pytest.approx(max(before.start - pool_gate.SDH_LEAD_SEC, 0.0))
    cues = [line for line in sdh.lines if line.truth is None]
    assert [line.text for line in cues] == [pool_gate.SOUND_CUES[0], pool_gate.SOUND_CUES[-1]]
    assert sdh.lines[0].text == pool_gate.SOUND_CUES[0], "a track opens with the subtitler's own cue"


def test_the_sdh_track_notates_nothing_because_the_corpus_truth_is_already_a_caption_track() -> None:
    """The measured reason the builder does NOT ♪-wrap or upper-case (see `sdh_track`): on a truth text
    whose lines already carry notes, re-notating the UNNOTED ones pushes `nonlyric.NOTED_SHARE` to 1.0 and
    saves lines R3 drops from the clean sheet — hello read 72 scored lines against the sheet's 63, so the
    "polluted" text scored BETTER for a reason no real track has."""
    notated = song_of([("♪ Is this the real life ♪", 1.0, 2.0), ("(wind buffeting)", 3.0, 4.0)], slug="s")
    plain = song_of([("Tired of being what you want me to be", 1.0, 2.0)], slug="s")
    for song in (notated, plain):
        clean = claims_of(song, "truth", [song, song_of(OTHERS[:1], slug="d")])
        sung = [line for line in pool_gate.sdh_track(clean).lines if line.truth is not None]
        assert [line.text for line in sung] == [line.text for line in clean.lines], (
            "a sung line's TEXT is never re-decorated: only its clock, its slips and the cues around it move"
        )


def test_the_sdh_track_mishears_one_word_in_a_few_lines_and_no_more() -> None:
    """A transcript of a recording, not a copy of a sheet — but SPARSELY, or the track stops agreeing with
    the clean sheet and the pool stops being review M13's own case (an SDH track OF THIS SONG)."""
    long_song = song_of(
        [(f"line number {index} of this longer sheet", float(index), index + 0.9) for index in range(20)],
        slug="s",
    )
    clean = claims_of(long_song, "truth", [long_song, song_of(OTHERS[:1], slug="d")])
    sdh = pool_gate.sdh_track(clean)

    sung = [line for line in sdh.lines if line.truth is not None]
    changed = [
        (before.text, after.text)
        for before, after in zip(clean.lines, sung, strict=True)
        if before.text != after.text
    ]
    assert len(changed) == 20 // pool_gate.MISHEARD_EVERY
    for before, after in changed:
        assert len(before.split()) == len(after.split()), "a slip keeps the word count score_words pairs on"
    assert corroboration(
        [[line.text for line in clean.lines], [line.text for line in sung]], ["lrclib", "captions:authored"]
    ) == [True, True], "the SDH track still agrees with the clean sheet"


def test_the_machine_track_is_the_same_words_lowercased_and_unpunctuated() -> None:
    song = song_of([("Hello, it's me!", 1.0, 2.0)], slug="s")
    clean = claims_of(song, "truth", [song, song_of(OTHERS[:1], slug="d")])
    machine = pool_gate.machine_track(clean)
    assert [line.text for line in machine.lines] == ["hello it's me"]
    assert [line.truth for line in machine.lines] == [0]


def test_the_lrc_body_round_trips_through_the_real_parser_at_the_claims_centisecond() -> None:
    """The clean sheet is served as a real `syncedLyrics` payload, so `parse_response` -> `parse_lrc` (review
    L4) is on the path — which is also why the recorded claims are `quantised`: an LRC carries centiseconds,
    and the row must say what the step was handed."""
    from encore_worker.adapters.lrclib import parse_response

    song = song_of(PHRASES, slug="s")
    clean = pool_gate.quantised(claims_of(song, "truth", [song, song_of(OTHERS[:1], slug="d")]))
    payload = pool_gate.lrclib_payload(clean, artist="s", track="s", duration_sec=DURATION)
    parsed = parse_response(payload)

    assert [str(s["text"]) for s in parsed] == [line.text for line in clean.lines]
    assert [s["start"] for s in parsed] == [line.start for line in clean.lines]
    assert "syncedLyrics" in payload and "plainLyrics" in payload, "both, so neither can be measured blind"


def test_the_wrong_sheets_of_a_pool_contain_none_of_the_songs_truth() -> None:
    """`wrong_published` is the gate's MUST, so "wrong" has to mean it: a text with no truth line at all."""
    songs = corpus_of(Path("/nonexistent.wav"), Path("/nonexistent.wav"))
    texts = pool_gate.pool_texts(songs[0], pool="allwrong", corpus=songs, duration_sec=DURATION)
    assert [t.label for t in texts] == [pool_gate.AUTHORED, pool_gate.LRCMUX, pool_gate.LRCLIB]
    assert [t.truth_lines for t in texts] == [0, 0, 0]
    assert len({t.claims.donor for t in texts}) == 3, "three different donors, so none is a near-miss"


def test_a_pool_arrives_in_the_order_production_acquires_it() -> None:
    """`_acquire_texts` fetches the authored track, then every provider, then the machine track, and the
    RANKING is the thing under measurement — so the pool is never pre-sorted here."""
    songs = corpus_of(Path("/nonexistent.wav"), Path("/nonexistent.wav"))
    for pool, labels in (
        ("clean", [pool_gate.LRCLIB]),
        ("sdh", [pool_gate.AUTHORED, pool_gate.LRCMUX, pool_gate.LRCLIB, pool_gate.MACHINE]),
        ("wrong-track", [pool_gate.AUTHORED, pool_gate.LRCMUX, pool_gate.LRCLIB, pool_gate.MACHINE]),
    ):
        texts = pool_gate.pool_texts(songs[0], pool=pool, corpus=songs, duration_sec=DURATION)
        assert [t.label for t in texts] == labels, pool


def test_the_pool_shapes_are_the_two_states_the_ranking_can_be_in() -> None:
    """The whole measurement rests on this, and it is pure: in `sdh` the authored track AGREES with the
    clean sheet, so corroboration cannot demote it and the ranked order equals the arrival order (review
    M13's own honest gap, `policy.order_pool`'s docstring); in `wrong-track` it agrees with nothing while
    the machine track backs the sheet, so the sheet is tried FIRST where arrival order tried it third."""
    songs = corpus_of(Path("/nonexistent.wav"), Path("/nonexistent.wav"))

    def ranking(pool: str) -> tuple[list[str], list[str], dict[str, bool]]:
        texts = pool_gate.pool_texts(songs[0], pool=pool, corpus=songs, duration_sec=DURATION)
        labels = [t.label for t in texts]
        tiers = [Tier.MACHINE if label == pool_gate.MACHINE else Tier.CANDIDATE for label in labels]
        agrees = corroboration([[line.text for line in t.claims.lines] for t in texts], labels)
        ranked = [labels[i] for i in order_pool(tiers, agrees)]
        arrival = [labels[i] for i in order_pool(tiers, [False] * len(labels))]
        return ranked, arrival, dict(zip(labels, agrees, strict=True))

    ranked, arrival, agrees = ranking("sdh")
    assert agrees[pool_gate.AUTHORED] and agrees[pool_gate.LRCLIB]
    assert not agrees[pool_gate.LRCMUX]
    assert ranked[0] == arrival[0] == pool_gate.AUTHORED
    assert ranked[1] == pool_gate.LRCLIB and arrival[1] == pool_gate.LRCMUX

    ranked, arrival, agrees = ranking("wrong-track")
    assert not agrees[pool_gate.AUTHORED] and agrees[pool_gate.LRCLIB]
    assert ranked[0] == pool_gate.LRCLIB and arrival[0] == pool_gate.AUTHORED
    assert witness_of(pool_gate.MACHINE) != witness_of(pool_gate.LRCLIB), "the third witness does the work"


# ── review L5: the sheet is in the pool only because the duration miss was retried ───────────────────


def test_the_duration_qualified_lookup_404s_and_the_retry_answers() -> None:
    opener = pool_gate.OneSheetOpener('{"syncedLyrics": "[00:01.00]one\\n[00:02.00]two"}')
    cues = pool_gate.lrclib_over(opener).fetch(artist="a", track="b", duration_sec=420.0)

    assert [str(c["text"]) for c in cues] == ["one", "two"]
    assert len(opener.opened) == 2 and "duration=420" in opener.opened[0]
    assert "duration" not in opener.opened[1], "L5 drops it rather than changing it"


def test_without_the_retry_the_sheet_simply_is_not_there() -> None:
    opener = pool_gate.OneSheetOpener('{"syncedLyrics": "[00:01.00]one"}', retry=False)
    assert pool_gate.lrclib_over(opener).fetch(artist="a", track="b", duration_sec=420.0) == ()
    assert len(opener.opened) == 2, "the client still retries; this opener 404s that too"


# ── the arms, through the real workflow ──────────────────────────────────────────────────────────────


@pytest.fixture()
def rig(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Any, Any]:
    """The pool driver over the E2E harness's synthetic song, with the lexical gate TAKEN OUT.

    `spread_decodes` disables `lexical.lift` because the spreading decoder's scores are flat, so every
    text's lift reads 0 and the W3 gate would refuse the song's own words. That makes these rigs a test of
    the HARNESS and of the ORDER — with the gate out, a wrong text is not refused, which is exactly how the
    control below gets to publish one. The gate itself is measured on the corpus, where it is in place.
    """
    spread_decodes(monkeypatch)
    vocals = write_voiced(tmp_path / "vocals.wav", DURATION)
    mix = write_voiced(tmp_path / "mix.wav", DURATION)
    corpus = corpus_of(vocals, mix)
    driver = pool_gate.PoolDriver(
        aligner=VoicedAligner(), corpus=corpus, media_root=tmp_path / "media", config=None
    )
    return driver, corpus[0]


def test_the_clean_pool_publishes_the_sheet_the_l5_retry_produced(rig: tuple[Any, Any]) -> None:
    """The whole ladder runs over the pool and every attempt is scored against truth. The rig's spreading
    decoder places this sheet's words badly through its tiled LRC windows, so `decide` rule 6 asks the
    text's own line timings and the LINE_SYNC rung publishes — which is the shipped path for an
    unreconcilable word document, and the per-attempt record is what says so."""
    driver, song = rig
    row = driver.run_pool(song, "clean", "ranked")
    assert (row["outcome"], row["published_label"]) == (lib.LINE_SYNC, pool_gate.LRCLIB)
    assert row["acquired"] == [pool_gate.LRCLIB] and row["wrong_published"] is False
    assert len(row["lrclib_lookups"]) == 2, "the duration miss, then the retry that answered"
    assert row["pool_in_text"] == len(PHRASES)
    assert [(a["text"], a["knobs"], a["scored"]) for a in row["attempts"]] == [
        (pool_gate.LRCLIB, [], len(PHRASES)),
        (pool_gate.LRCLIB, ["line-sync"], len(PHRASES)),
    ]


def test_the_sdh_pool_serves_four_texts_and_the_ranking_leaves_the_sdh_track_first(
    rig: tuple[Any, Any],
) -> None:
    """Review M13's measured case, end to end: the SDH track AGREES with the clean sheet, so it is tried
    first in both arms and the ranking's reach is the two sheets behind it."""
    driver, song = rig
    ranked = driver.run_pool(song, "sdh", "ranked")
    arrival = driver.run_pool(song, "sdh", "arrival")

    assert ranked["acquired"] == [
        pool_gate.AUTHORED,
        pool_gate.LRCMUX,
        pool_gate.LRCLIB,
        pool_gate.MACHINE,
    ]
    assert ranked["agrees"][pool_gate.AUTHORED] is True
    assert ranked["published_label"] == arrival["published_label"] == pool_gate.AUTHORED
    assert arrival["acquired"] == [pool_gate.AUTHORED, pool_gate.LRCMUX, pool_gate.MACHINE], (
        "pre-M13 acquisition keeps only the first provider that answered"
    )


def test_the_wrong_track_pool_is_where_the_ranking_changes_the_published_text(rig: tuple[Any, Any]) -> None:
    """The control publishes another song's words (no lexical gate in this rig); the shipped ranking tries
    the corroborated clean sheet first and publishes it."""
    driver, song = rig
    ranked = driver.run_pool(song, "wrong-track", "ranked")
    arrival = driver.run_pool(song, "wrong-track", "arrival")

    assert (ranked["published_label"], ranked["wrong_published"]) == (pool_gate.LRCLIB, False)
    assert ranked["gross"] == 0 and ranked["scored"] == len(PHRASES)
    assert (arrival["published_label"], arrival["wrong_published"]) == (pool_gate.AUTHORED, True)
    assert arrival["scored"] == 0, "a wrong text scores nothing: none of its lines is a truth line"
    assert (arrival["in_text"], arrival["pool_in_text"]) == (0, len(PHRASES)), (
        "the published text asked for none of this song's lines, and the POOL still asked for all of them: "
        "pooling over `in_text` would read a wrong-text publication as a song with nothing to find"
    )

    diff = pool_gate.chosen_diff([ranked, arrival], "wrong-track")
    assert [m["song"] for m in diff["moved"]] == [song.slug]
    assert diff["moved"][0]["wrong"] == [False, True]


def test_the_pre_tie_arm_separates_m13s_two_halves(rig: tuple[Any, Any]) -> None:
    """`pre-tie` keeps `fetch_provider_lyrics`' whole list — so the clean sheet IS in the pool — and
    neutralises only the corroboration tie-break. The acquisition is therefore the shipped one and the WALK
    is arrival order, which is what lets a run say which half of M13 paid for a change."""
    driver, song = rig
    ranked = driver.run_pool(song, "wrong-track", "ranked")
    pre = driver.run_pool(song, "wrong-track", "pre-tie")
    arrival = driver.run_pool(song, "wrong-track", "arrival")

    assert pre["acquired"] == ranked["acquired"], "the same pool as the shipped arm"
    assert pool_gate.LRCLIB in pre["acquired"] and pool_gate.LRCLIB not in arrival["acquired"]
    assert pre["pool_order"][0] == pool_gate.AUTHORED, "walked in arrival order"
    assert ranked["pool_order"][0] == pool_gate.LRCLIB, "the corroborated sheet first"
    assert pre["agrees"] == ranked["agrees"], "the shipped reading is recorded whatever the arm used"


def test_the_no_l5_arm_has_no_clean_sheet_at_all(rig: tuple[Any, Any]) -> None:
    """Review L5 as the bench sees it: without the retry the song falls through with a good human sheet one
    request away — here, to the wrong-song sheet the rig's missing gate lets publish."""
    driver, song = rig
    row = driver.run_pool(song, "sdh", "no-l5")
    assert pool_gate.LRCLIB not in row["acquired"]
    assert row["acquired"] == [pool_gate.AUTHORED, pool_gate.LRCMUX, pool_gate.MACHINE]
    assert len(row["lrclib_lookups"]) == 2, "both lookups 404 — the client's own retry included"


def test_a_pool_of_only_wrong_texts_publishes_one_only_because_this_rig_has_no_gate(
    rig: tuple[Any, Any],
) -> None:
    """The MUST's shape. With the lexical gate out, SOMETHING wrong publishes and the verdict FAILS, which
    is what makes the verdict meaningful when the corpus run has the gate in place."""
    driver, song = rig
    row = driver.run_pool(song, "allwrong", "ranked")
    assert row["wrong_published"] is True and row["scored"] == 0
    failed = {name: ok for name, ok, _why in pool_gate.verdicts([row])}
    assert failed["no-wrong-text-publishes"] is False
    assert failed["no-error-rows"] is True, "a wrong text that publishes is a VERDICT, never an error row"


def test_line_sync_mode_reaches_the_pool(rig: tuple[Any, Any], tmp_path: Path) -> None:
    """`syncMode=lines` with a pool active: every text's one attempt is the gated LINE_SYNC rung, so the
    rung is read on a pool rather than on the single text `e2e.py --sync-mode lines` serves."""
    driver, song = rig
    lines = pool_gate.PoolDriver(
        aligner=driver.aligner,
        corpus=driver.corpus,
        media_root=tmp_path / "lines",
        config=None,
        sync_mode="lines",
    )
    row = lines.run_pool(song, "sdh", "ranked")
    assert row["sync_mode"] == "lines"
    assert all(a["knobs"] == ["line-sync"] for a in row["attempts"]), row["attempts"]


# ── the summary and the verdicts ─────────────────────────────────────────────────────────────────────


def row(**fields: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "song": "s",
        "pool": "sdh",
        "arm": "ranked",
        "outcome": lib.PUBLISHED,
        "terminal": "published",
        "published_label": pool_gate.LRCLIB,
        "scored": 10,
        "gross": 0,
        "w500": 9,
        "in_text": 10,
        "pool_in_text": 10,
        "wrong_published": False,
        "acquired": [pool_gate.LRCLIB],
    }
    return {**base, **fields}


def test_the_tally_counts_what_published_per_pool_and_arm() -> None:
    got = pool_gate.tally([row(), row(arm="arrival", w500=7, gross=1)])
    assert got["sdh/ranked"]["chosen"] == {pool_gate.LRCLIB: 1}
    assert got["sdh/ranked"]["w500_pct"] == 90.0 and got["sdh/arrival"]["gross"] == 1


def test_a_ranking_that_loses_lines_or_adds_a_gross_one_fails_its_verdict() -> None:
    worse = [row(gross=2, w500=5), row(arm="arrival", gross=1, w500=9)]
    failed = {name: ok for name, ok, _why in pool_gate.verdicts(worse)}
    assert failed["sdh-ranking-adds-no-gross-line-vs-arrival"] is False
    assert failed["sdh-ranking-keeps-pm500-vs-arrival"] is False
    kept = [row(), row(arm="arrival", gross=1, w500=9)]
    passed = {name: ok for name, ok, _why in pool_gate.verdicts(kept)}
    assert passed["sdh-ranking-adds-no-gross-line-vs-arrival"]
    assert passed["sdh-ranking-keeps-pm500-vs-arrival"]
    assert "sdh-ranking-keeps-pm500-vs-pre-tie" not in passed, "a control that was not run has no verdict"


def test_every_per_pool_must_is_read_in_lines_mode_too() -> None:
    """Every per-pool MUST is read in `lines` mode too.

    `tally` keyed a `lines` cell `pool/arm/lines` while `verdicts` looked up `pool/arm`, so under
    `--sync-mode lines` every per-pool MUST found nothing and `continue`d: `results/w7-pool-lines.json`
    recorded 2 verdicts against the forced run's 13, both passing, and the script exited 0 — a green reading
    in which 11 of 13 gates were never evaluated. `key_of` is now the one spelling and the gate name carries
    the non-default mode, while the suffix stays: a `lines` document has LINE timings only, so pooling its
    ±500 with a forced run's would compare two different measurements."""
    lines = [row(sync_mode="lines", gross=2, w500=5), row(sync_mode="lines", arm="arrival", gross=1, w500=9)]
    read = {name: ok for name, ok, _why in pool_gate.verdicts(lines)}
    assert read["sdh-ranking-adds-no-gross-line-vs-arrival-lines"] is False
    assert read["sdh-ranking-keeps-pm500-vs-arrival-lines"] is False
    assert "sdh-ranking-adds-no-gross-line-vs-arrival" not in read, "the forced name belongs to forced rows"
    assert pool_gate.key_of("sdh", "ranked", "lines") == "sdh/ranked/lines"
    assert pool_gate.key_of("sdh", "ranked", None) == pool_gate.key_of("sdh", "ranked", e2e.SYNC_FORCED)


def test_a_cell_with_rows_but_no_gate_fails_rather_than_passing_quietly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The built-in that makes the defect above unrepeatable, modelled on `e2e_gates.run_gates`' refusal to
    pass an unmeasured gate: a (pool, arm) the ROWS carry and no comparison read is a FAIL that names it. An
    arm the plan simply did not run is not — the `lines` plan runs no `pre-tie`, and a gate cannot be owed
    against rows that do not exist."""
    name = "every-planned-comparison-was-read"
    paired = [row(), row(arm="arrival")]
    assert {n: ok for n, ok, _w in pool_gate.verdicts(paired)}[name] is True

    only_control = [row(arm="arrival")]  # no `ranked` rows: nothing to compare, and nothing is owed
    assert {n: ok for n, ok, _w in pool_gate.verdicts(only_control)}[name] is True

    # THE DEFECT, RE-INTRODUCED as the shape it had: the tally's keys and the lookup's disagree, so every
    # per-pool gate finds `None`. Patched on the TALLY side, since that is the half `verdicts` reads.
    real = pool_gate.tally
    monkeypatch.setattr(pool_gate, "tally", lambda rows: {f"{k}/x": v for k, v in real(rows).items()})
    verdicts = {n: ok for n, ok, _w in pool_gate.verdicts([row(), row(arm="arrival")])}
    assert verdicts[name] is False, "a gate that read nothing must say so instead of being absent"
    assert not any(n.startswith("sdh-ranking") for n in verdicts), "which is exactly what went unnoticed"


def test_the_l5_verdict_reads_the_absence_of_the_sheet_not_its_score() -> None:
    def read(rows: list[dict[str, Any]]) -> bool:
        verdicts: dict[str, bool] = {name: ok for name, ok, _why in pool_gate.verdicts(rows)}
        return verdicts["l5-is-why-the-clean-sheet-is-in-the-pool"]

    assert read([row(arm="no-l5", acquired=[pool_gate.AUTHORED, pool_gate.LRCLIB])]) is False
    assert read([row(arm="no-l5", acquired=[pool_gate.AUTHORED])]) is True


def test_an_unknown_pool_or_arm_is_refused_before_a_model_loads() -> None:
    """A gate script must not traceback on a typo, and must not start a run it cannot finish."""
    assert pool_gate.main(["--pools", "sdh", "--arms", "nope"]) == 2
    assert pool_gate.main(["--pools", "nope", "--arms", "ranked"]) == 2


def test_an_error_row_is_never_counted_as_a_choice() -> None:
    got = pool_gate.tally([row(outcome=lib.ERROR, exception="boom")])
    assert got["sdh/ranked"]["errors"] == 1 and got["sdh/ranked"]["published"] == 0
    assert got["sdh/ranked"]["chosen"] == {"ERROR": 1}
