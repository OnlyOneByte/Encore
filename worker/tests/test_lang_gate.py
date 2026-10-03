"""The LANGUAGE gate (`docs/benchmarks/forced-alignment/scripts/lang_gate.py`).

WHY IT HAS UNIT TESTS, like `pool_gate.py` and the E2E harness beside it (W7 review r2-tests-15: this script
was 651 lines with no test at all, referenced only from docstrings and loaded by nothing). It carries the
decisive numbers of W7: the 59-song fr/de/es reading that ships `lang-route-mix` DEFAULT-OFF, the `--folds`
census that licenses the NFKD fold as a byte-level no-op on every row under `results/`, and review M9's live
blank proof. A defect in `score`'s truth pairing, in `pooled`'s arithmetic or in `fold_census`' alphabet would
move those verdicts silently — the whole class of defect this project's harness tests exist for, and one of
them (`pooled`'s AAE, r2-tests-14) was in fact live.

Hermetic: no model, no corpus, no network. `score` and `pooled` are plain data; `fold_census` reads the stdlib
UCD through `domain.lyrics.language`; the `--blank` arms are checked on `Unaware`'s own shape, which is what
makes it the faithful pre-W4 chain.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from tests.test_bench_e2e import _load

lang_gate: Any = _load("lang_gate")


def song_of(
    lines: list[tuple[str, float, float]], onsets: tuple[float, ...] = (), language: str = "fr"
) -> Any:
    return lang_gate.LangSong(
        slug="s",
        language=language,
        mix=Path("/nonexistent.mp3"),
        vocals=Path("/nonexistent.wav"),
        lines=tuple(lines),
        onsets=onsets,
    )


THREE = [("aaa bbb", 1.0, 3.0), ("ccc ddd", 5.0, 7.0), ("eee fff", 9.0, 11.0)]


# ── scoring one decode ────────────────────────────────────────────────────────────────────────────────


def test_an_unplaced_line_is_dropped_not_removed_from_the_denominator() -> None:
    """The scorer artefact review §3 item 10 recorded, which flatters exactly the configuration that places
    FEWER lines: `lines` is every annotated line and `lines_placed` is what the decode emitted, so a bundle
    that gives up on a line pays for it instead of raising its own percentage."""
    song = song_of(THREE)
    got = lang_gate.score(song, {0: (1.0, []), 2: (9.0, [])})
    assert (got["lines"], got["lines_placed"], got["lines_dropped"]) == (3, 2, 1)
    assert got["line_pm500"] == 2 and got["gross"] == 0

    none = lang_gate.score(song, {})
    assert (none["lines"], none["lines_placed"], none["lines_dropped"]) == (3, 0, 3)
    assert none["word_aae_ms"] is None, "no words measured is None, never 0 ms"


def test_the_words_are_paired_by_position_within_the_line_they_belong_to() -> None:
    """`song.onsets` is one measured onset per whitespace token in READING ORDER, so the cursor must advance
    over a line's own token count whether or not that line was placed — otherwise one dropped line shifts
    every later word onto its neighbour's truth and the whole tail reads gross."""
    song = song_of(THREE, onsets=(1.0, 2.0, 5.0, 6.0, 9.0, 10.0))
    placed = {
        0: (1.0, [(1.0, True), (2.0, True)]),
        2: (9.05, [(9.05, True), (10.4, False)]),
    }
    got = lang_gate.score(song, placed)
    assert got["words"] == 4, "the dropped line's two words are not scored"
    assert got["word_pm100"] == 3 and got["word_pm300"] == 3 and got["word_pm250"] == 3
    assert got["words_interpolated"] == 1, "a word `generate` placed by interpolation is counted as such"
    assert round(got["word_aae_ms"], 6) == 112.5, (
        "(0 + 0 + 50 + 400) / 4 — the third line's words paired with their OWN truth, not the second's"
    )


def test_a_line_start_more_than_two_seconds_out_is_gross_as_everywhere_else() -> None:
    song = song_of(THREE)
    got = lang_gate.score(song, {0: (3.0, []), 1: (7.01, []), 2: (9.0, [])})
    assert got["gross"] == 1 and got["line_pm1000"] == 1 and got["line_pm500"] == 1


# ── the pooled block ──────────────────────────────────────────────────────────────────────────────────


def rows_of() -> list[dict[str, Any]]:
    """Two rows whose sizes differ by 10x: the shape that separates a pooled rate from a mean of rates."""
    big = {"lines": 100, "lines_placed": 100, "lines_dropped": 0, "gross": 0, "line_pm500": 100,
           "line_pm1000": 100, "words": 1000, "words_interpolated": 0, "words_over_2s": 0,
           "word_pm100": 900, "word_pm250": 1000, "word_pm300": 1000, "word_aae_ms": 100.0}  # fmt: skip
    small = {**big, "lines": 10, "lines_placed": 10, "line_pm500": 5, "line_pm1000": 10, "words": 100,
             "word_pm100": 10, "word_pm250": 50, "word_pm300": 50, "word_aae_ms": 1000.0}  # fmt: skip
    return [big, small]


def test_every_rate_is_recomputed_from_the_sums() -> None:
    """One long song must not outvote twenty short ones by accident, which is the whole reason this function
    exists rather than a mean of the per-song percentages."""
    got = lang_gate.pooled(rows_of())
    assert (got["songs"], got["lines"], got["words"]) == (2, 110, 1100)
    assert got["line_pm500_pct"] == 100 * 105 / 110, "not the mean of 100% and 50%"
    assert got["word_pm300_pct"] == 100 * 1050 / 1100
    assert lang_gate.pooled([]) == {}, "no rows is empty, not a block of zeros"


def test_the_pooled_aae_is_over_the_words_and_the_mean_of_means_keeps_its_own_name() -> None:
    """W7 review r2-tests-14: the only absolute error this emitted was `statistics.fmean` over the per-song
    means, printed under a bare `AAE=` in the POOLED block and quoted as a pooled figure in
    `domain.lyrics.language.model_language` and in the README. On the committed 59-song sweep the two differ
    by a quarter of their value (186.0 ms per word against 235.8 per song, routed 388.7 against 540.0). Both
    are emitted now, each named for its denominator."""
    got = lang_gate.pooled(rows_of())
    assert got["word_aae_ms"] == (100.0 * 1000 + 1000.0 * 100) / 1100, "per WORD: 181.8, not 550.0"
    assert got["song_aae_ms"] == 550.0, "per SONG, which a per-song reject-if is the reader of"

    quiet = [{**rows_of()[0], "word_aae_ms": None, "words": 0}, rows_of()[1]]
    assert lang_gate.pooled(quiet)["word_aae_ms"] == 1000.0, "a row with no measured word adds no weight"


def test_the_committed_sweep_reproduces_both_statistics() -> None:
    """Read on the artefact the arm's verdict was taken from, so a later edit to `pooled` cannot quietly
    restate the published numbers (`results/w7-lang-stem.json`, 59 songs / 15 887 words per condition)."""
    import json

    rows = json.loads((Path(lang_gate.RESULTS) / "w7-lang-stem.json").read_text(encoding="utf-8"))["rows"]
    read = {
        condition: lang_gate.pooled([r for r in rows if r["condition"] == condition])
        for condition in ("default", "routed")
    }
    assert read["default"]["words"] == read["routed"]["words"] == 15887
    assert round(read["default"]["word_aae_ms"], 1) == 186.0
    assert round(read["routed"]["word_aae_ms"], 1) == 388.7
    assert round(read["default"]["song_aae_ms"], 1) == 235.8, "the figure that was published as pooled"
    assert round(read["routed"]["song_aae_ms"], 1) == 540.0
    assert round(read["default"]["word_pm300_pct"], 2) == 94.78, "the verdict itself is unmoved"
    assert round(read["routed"]["word_pm300_pct"], 2) == 92.97


# ── the fold census (`--folds`) ───────────────────────────────────────────────────────────────────────


def test_an_ascii_corpus_gains_nothing_which_is_what_licenses_every_recorded_row() -> None:
    """The gate on the whole W7 fold: the English corpus's cleaned truth holds no non-ASCII letter, so the
    new target filter returns what the three inlined copies returned and no number under `results/` moves."""
    got = lang_gate.fold_census(["don't stop", "aaa bbb ccc"])
    assert got["now_aligned"] == {} and got["now_aligned_total"] == 0
    assert got["still_dropped"] == {} and got["characters"] == len("don't stop") + len("aaa bbb ccc")
    assert got["scripts"] == {"Latin": 17}, "letters only: the apostrophe and the spaces are not script"


def test_an_accented_corpus_is_the_population_the_fix_exists_for() -> None:
    got = lang_gate.fold_census(["café", "Grüße"])
    assert got["now_aligned"] == {"é": 1, "ü": 1}, "folded to a letter the English vocabulary has"
    assert got["still_dropped"] == {"ß": 1}, "NFKD cannot decompose it — the residue `fold_to_base` names"
    assert got["now_aligned_total"] == 2 and got["still_dropped_total"] == 1


def test_the_census_counts_letters_only_which_is_exactly_what_the_filter_folds() -> None:
    """W7 review r2-spec-7: a census of LETTERS certified a fold that also reached the 953 non-letter
    codepoints NFKD decomposes onto letters, so `™` became two character targets with nothing measuring it.
    `generate.char_ids` now folds letters alone; this is the clause that keeps the two in step."""
    from encore_worker.domain.lyrics.generate import char_ids

    vocabulary = {"-": 0, **{ch: i + 1 for i, ch in enumerate("abcdefghijklmnopqrstuvwxyz")}}
    got = lang_gate.fold_census(["aaa™", "№"])
    assert got["now_aligned"] == {} and got["still_dropped"] == {}, "neither symbol is a letter to fold"
    assert char_ids("aaa™", vocabulary, {0}) == [(0, 1), (1, 1), (2, 1)], "and the filter agrees"
    assert char_ids("№", vocabulary, {0}) == []


# ── review M9's live arms ─────────────────────────────────────────────────────────────────────────────


def test_the_unaware_arm_drops_both_fields_so_all_five_readers_fall_back() -> None:
    """`blank = 0` was hard-coded in FIVE places that have to agree, and this arm is pre-W4 code running on a
    post-W7 tree: dropping the two FIELDS moves all five at once through the `getattr` defaults the shipped
    readers still carry. Forcing only the kernel's integer is the `kernel` arm, which RAISES — which is what a
    half-threaded blank looks like and why the five had to move together."""
    import numpy as np

    matrix = lang_gate.Unaware(log_probs=np.zeros((7, 3)), frame_sec=0.02, dictionary={"a": 1})
    assert matrix.frames == 7 and matrix.frame_sec == 0.02
    assert not hasattr(matrix, "blank_id"), "the field whose absence IS the pre-W4 chain"
    assert not hasattr(matrix, "specials"), "and the one W4b added beside it"
    assert lang_gate.BLANK_ARMS == ("matrix", "unaware", "kernel")
