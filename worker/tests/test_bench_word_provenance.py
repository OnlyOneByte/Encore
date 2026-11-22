"""`word_provenance.py`: whether a run that re-labels words also moved them, word by word.

Hermetic — both "runs" are rows and documents written to tmp, so no audio, no model and no bench corpus is
read. The point under test is that a provenance change is priced against TRUTH rather than counted: the same
start under a new label is bookkeeping, a worse start is a regression, and an unreadable pair is refused
instead of guessed around. The measurement it was written for is in LOG.md, "W8b: re-judging
`word-aligned-not-down`".
"""

from __future__ import annotations

import importlib.util
import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from types import ModuleType
from typing import Any

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
prov: Any = _load("word_provenance")

#: The four words measured moving FURTHER from truth as they were re-labelled interpolated, at `jit`
#: (`band-reopen` on, `_runs/w8a-def-ra` against `_runs/w8ar2-arms-ra`): |published − truth| in ms, before
#: and after. Every one of them starts inside ±100 and lands outside ±300.
MEASURED_WORSE = (
    ("Explosive_Ear_Candy_-_Like_The_Sun", "you're", 14.8, 331.7),
    ("Explosive_Ear_Candy_-_Like_The_Sun", "you're", 72.9, 394.9),
    ("HILA_-_Give_Me_the_Same", "but", 7.2, 348.8),
    ("Quentin_Hannappe_-_Keep_On", "keep", 28.2, 300.9),
)

#: The two words that paid for them: `band-reopen` pulls Kinematic's late `oh` back toward the claim, which
#: at `jit` is truth plus jitter. Same measurement, same mode.
MEASURED_BETTER = (("Kinematic_-_Peyote", "oh", 783.9, 85.8), ("Kinematic_-_Peyote", "oh", 908.8, 186.5))


def song_of(lines: Sequence[tuple[str, float]], *, slug: str = "s") -> Any:
    """A song whose truth lines start where asked, every word on its line's start plus 0.5 s per word."""
    truth = tuple(lib.TruthLine(text, start, start + 3.0) for text, start in lines)
    words = tuple(
        lib.TruthWord(start + 0.5 * k, start + 0.5 * k + 0.4)
        for text, start in lines
        for k in range(len(text.split()))
    )
    return lib.Song(
        slug=slug,
        group="jamendo",
        mix=Path("mix.mp3"),
        vocals=Path("vocals.wav"),
        truth=truth,
        words=words,
    )


def doc_of(lines: Sequence[tuple[str, float, Sequence[tuple[str, float, float]]]]) -> dict[str, Any]:
    """A published document: (text, start, [(word, start, score)]). Score 0.0 is not aligned."""
    return {
        "lines": [
            {
                "text": text,
                "start": start,
                "end": start + 3.0,
                "words": [{"word": w, "start": s, "end": s + 0.4, "score": score} for w, s, score in words],
            }
            for text, start, words in lines
        ]
    }


#: The setup every real run directory records in `run.json`, which `main()` reads to refuse a mismatched pair.
SETUP: Mapping[str, Any] = {
    "level": "run_align",
    "seed": 0,
    "wrong_k": 10,
    "language": "en",
    "tfr_audio": "youtube",
    "target": "stem",
    "asr": "off",
    "sync_mode": "forced",
}


def write_run(
    root: Path,
    doc: dict[str, Any],
    *,
    song: str = "s",
    mode: str = "truth",
    line_errors: Sequence[tuple[int, float]],
    sha: str,
    setup: Mapping[str, Any] | None = SETUP,
) -> Path:
    """One run directory with a single row, the document it published, and the setup it measured."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "media").mkdir(exist_ok=True)
    (root / "media" / "doc.json").write_text(json.dumps(doc), encoding="utf-8")
    if setup is not None:
        (root / "run.json").write_text(json.dumps(dict(setup)), encoding="utf-8")
    row = {
        "song": song,
        "mode": mode,
        "variant": 0,
        "group": "jamendo",
        "ref": "doc.json",
        "doc_sha256": sha,
        "words": {"in_text": 1, "interpolated": 0, "errors": []},
        "line_errors": [[truth, error, "high"] for truth, error in line_errors],
    }
    (root / "rows.jsonl").write_text(json.dumps(row) + "\n", encoding="utf-8")
    return root


ONE_LINE = (("hold on", 10.0),)


def exit_code(monkeypatch: pytest.MonkeyPatch, song: Any, *argv: str) -> int:
    """`main()` over a corpus of one song — the CLI's only read of the bench root."""
    monkeypatch.setattr(lib, "discover", lambda *_a, **_k: [song])
    return int(prov.main(list(argv)))


def pair(
    tmp_path: Path,
    base_words: Sequence[tuple[str, float, float]],
    arms_words: Sequence[tuple[str, float, float]],
    *,
    lines: Sequence[tuple[str, float]] = ONE_LINE,
    base_doc: dict[str, Any] | None = None,
    arms_doc: dict[str, Any] | None = None,
) -> list[Any]:
    """`changes()` over a one-line song published twice, by default differing only in its words."""
    song = song_of(lines)
    text, start = lines[0]
    base = base_doc or doc_of([(text, base_words[0][1], base_words)])
    arms = arms_doc or doc_of([(text, arms_words[0][1], arms_words)])
    errors = [(0, base["lines"][0]["start"] - start)]
    write_run(tmp_path / "base", base, line_errors=errors, sha="a")
    write_run(tmp_path / "arms", arms, line_errors=errors, sha="b")
    return list(prov.changes(tmp_path / "base", tmp_path / "arms", {song.slug: song}))


def test_a_word_that_keeps_its_start_and_changes_only_its_label_is_bookkeeping(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The case the owner's decision asked about: `aligned` falls, nothing moves.

    The published start is the only thing truth can judge, so the verdict is `equal` and the run passes — a
    rule that rejected this would be refusing a change on its accounting rather than on its accuracy."""
    found = pair(
        tmp_path, [("hold", 10.2, -0.4), ("on", 10.5, -0.4)], [("hold", 10.2, 0.0), ("on", 10.5, -0.4)]
    )
    assert [(c.text, c.verdict, c.reprovenanced) for c in found] == [("hold", "equal", True)]
    base, arms = str(tmp_path / "base"), str(tmp_path / "arms")
    assert exit_code(monkeypatch, song_of(ONE_LINE), base, arms) == 0


def test_a_word_that_buys_its_new_label_with_a_start_further_from_truth_is_not(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The measured `jit` shape: 28 ms from truth as an aligned word, 301 ms as an interpolated one.

    `word_aligned` alone cannot tell this from the test above — both read one word fewer aligned."""
    found = pair(
        tmp_path, [("hold", 10.028, -0.4), ("on", 10.5, -0.4)], [("hold", 9.699, 0.0), ("on", 10.5, -0.4)]
    )
    priced = [
        (c.verdict, round(abs(c.base_error) * 1000, 1), round(abs(c.arms_error) * 1000, 1)) for c in found
    ]
    assert priced == [("worse", 28.0, 301.0)]
    base, arms = str(tmp_path / "base"), str(tmp_path / "arms")
    assert exit_code(monkeypatch, song_of(ONE_LINE), base, arms) == 1
    assert exit_code(monkeypatch, song_of(ONE_LINE), base, arms, "--allow-worse", "1") == 0


def test_a_word_that_moves_without_changing_its_label_is_read_too(tmp_path: Path) -> None:
    """A re-timing is the same question as a re-labelling, so both are priced; the report keeps them apart."""
    found = pair(
        tmp_path, [("hold", 10.4, -0.4), ("on", 10.5, -0.4)], [("hold", 10.05, -0.4), ("on", 10.5, -0.4)]
    )
    assert [(c.verdict, c.reprovenanced) for c in found] == [("better", False)]
    assert "retimed" in prov.report(found) and "reprovenanced better 0" in prov.report(found)


@pytest.mark.parametrize("verdict", ["better", "equal", "worse"])
def test_the_measured_w8b_words_price_the_way_the_readme_records_them(verdict: str) -> None:
    """The four `jit` words that got worse and the two that paid for them, as `WordChange` prices them.

    The run directories they were measured in are outside the repo, so what is pinned here is the
    classification of the recorded numbers — the step the re-judgement turned on."""
    table = {"worse": MEASURED_WORSE, "better": MEASURED_BETTER, "equal": ()}[verdict]
    for song, text, before, after in table:
        change = prov.WordChange(
            mode="jit",
            song=song,
            variant=0,
            position=0,
            index=0,
            text=text,
            base_start=before / 1000.0,
            arms_start=after / 1000.0,
            truth_start=0.0,
            base_aligned=True,
            arms_aligned=False,
        )
        assert change.verdict == verdict, f"{song}/{text} {before} -> {after}"
        assert change.reprovenanced
    assert len(MEASURED_WORSE) == 4 and len(MEASURED_BETTER) == 2, "six words at `jit`, and they disagree"


def test_the_truth_pairing_comes_from_the_row_not_from_the_text(tmp_path: Path) -> None:
    """A repeated chorus line and an injected header: text pairing mis-binds both, `line_errors` cannot.

    `score_words` pairs by an identity capture the run does not record, but each paired line's truth index
    and signed start error ARE recorded, which pins the published position exactly. Here line 0 is a header
    that is no truth line and lines 1 and 3 share their text, so the word under test is reached only by
    believing the row: it is line 3's, truth line 2's, and its truth onset is 30.0 s."""
    song = song_of((("hold on", 10.0), ("la la", 20.0), ("hold on", 30.0)))
    header = ("VERSE", 5.0, [("VERSE", 5.0, -0.4)])
    words = [("hold", 30.1, -0.4), ("on", 30.6, -0.4)]
    moved = [("hold", 30.9, -0.4), ("on", 30.6, -0.4)]
    base = doc_of(
        [
            header,
            ("hold on", 10.0, [("hold", 10.0, -0.4), ("on", 10.5, -0.4)]),
            ("la la", 20.0, [("la", 20.0, -0.4), ("la", 20.5, -0.4)]),
            ("hold on", 30.1, words),
        ]
    )
    arms = json.loads(json.dumps(base))
    arms["lines"][3]["words"] = [{"word": w, "start": s, "end": s + 0.4, "score": sc} for w, s, sc in moved]
    errors = [(0, 0.0), (1, 0.0), (2, 0.1)]
    write_run(tmp_path / "base", base, line_errors=errors, sha="a")
    write_run(tmp_path / "arms", arms, line_errors=errors, sha="b")
    found = list(prov.changes(tmp_path / "base", tmp_path / "arms", {song.slug: song}))
    assert [(c.position, c.index, c.truth_start, c.verdict) for c in found] == [(3, 0, 30.0, "worse")]


def test_a_header_label_does_not_shift_the_word_pairing(tmp_path: Path) -> None:
    """A published line may carry a label its truth line does not, so the truth words are its
    LAST ones — read off the text, which also proves the pairing instead of assuming it."""
    song = song_of((("hold on", 10.0),))
    labelled = [("CHORUS:", 9.8, -0.4), ("hold", 10.0, -0.4), ("on", 10.5, -0.4)]
    arms = [("CHORUS:", 9.8, -0.4), ("hold", 10.3, -0.4), ("on", 10.5, -0.4)]
    base_doc = doc_of([("CHORUS: hold on", 9.8, labelled)])
    arms_doc = doc_of([("CHORUS: hold on", 9.8, arms)])
    write_run(tmp_path / "base", base_doc, line_errors=[(0, -0.2)], sha="a")
    write_run(tmp_path / "arms", arms_doc, line_errors=[(0, -0.2)], sha="b")
    found = list(prov.changes(tmp_path / "base", tmp_path / "arms", {song.slug: song}))
    assert [(c.index, c.text, c.truth_start) for c in found] == [(0, "hold", 10.0)]


def test_an_unreadable_pair_is_refused_rather_than_priced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Five ways two runs stop being comparable word by word. Each is an UNREADABLE exit, never a clean one:
    a mispaired word would be priced against another word's truth and read as a large regression or a large
    gain, which is worse than no answer."""
    song = song_of((("hold on", 10.0),))
    good = doc_of([("hold on", 10.0, [("hold", 10.0, -0.4), ("on", 10.5, -0.4)])])
    three = [("hold", 10.0, -0.4), ("on", 10.5, -0.4), ("x", 11.0, -0.4)]
    cases = {
        "published different text": doc_of(
            [("hold tight", 10.0, [("hold", 10.0, -0.4), ("tight", 10.5, -0.4)])]
        ),
        "2 words against 3": doc_of([("hold on", 10.0, three)]),
        "are not the truth line's": doc_of([("hold on", 10.0, [("held", 10.0, -0.4), ("on", 10.5, -0.4)])]),
    }
    for why, arms in cases.items():
        write_run(tmp_path / "base", good, line_errors=[(0, 0.0)], sha="a")
        write_run(tmp_path / "arms", arms, line_errors=[(0, 0.0)], sha="b")
        with pytest.raises(prov.UnreadablePair, match=why):
            prov.changes(tmp_path / "base", tmp_path / "arms", {song.slug: song})
        assert exit_code(monkeypatch, song, str(tmp_path / "base"), str(tmp_path / "arms")) == 2
    write_run(tmp_path / "base", good, line_errors=[(0, 9.0)], sha="a")
    write_run(tmp_path / "arms", good, line_errors=[(0, 9.0)], sha="b")
    with pytest.raises(prov.UnreadablePair, match="has no line"):
        prov.changes(tmp_path / "base", tmp_path / "arms", {song.slug: song})
    write_run(tmp_path / "base", good, line_errors=[(0, 0.0)], sha="a")
    write_run(tmp_path / "arms", good, line_errors=[(0, 0.0)], sha="b")
    with pytest.raises(prov.UnreadablePair, match="not in the corpus"):
        prov.changes(tmp_path / "base", tmp_path / "arms", {})


def test_a_pair_whose_documents_are_byte_identical_is_never_opened(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`doc_sha256` already says the published bytes agree, so the media file is not read at all — which is
    what makes the tool cheap enough to run over a whole corpus sweep."""
    song = song_of((("hold on", 10.0),))
    good = doc_of([("hold on", 10.0, [("hold", 10.0, -0.4), ("on", 10.5, -0.4)])])
    write_run(tmp_path / "base", good, line_errors=[(0, 0.0)], sha="same")
    write_run(tmp_path / "arms", good, line_errors=[(0, 0.0)], sha="same")
    (tmp_path / "arms" / "media" / "doc.json").unlink()
    assert prov.changes(tmp_path / "base", tmp_path / "arms", {song.slug: song}) == []
    assert exit_code(monkeypatch, song, str(tmp_path / "base"), str(tmp_path / "arms")) == 0


def test_a_run_that_is_missing_rows_the_other_has_is_refused_not_read_as_clean(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The counterpart of the mode filter below: a row the OTHER run never produced.

    A sweep killed partway through used to be skipped row by row exactly like a filtered mode, so its finished
    modes were compared and the rest reported as "no word moved further from truth" — and the exit code is the
    verdict that answered the owner's `word-aligned-not-down` question."""
    song = song_of((("hold on", 10.0),))
    base = doc_of([("hold on", 10.0, [("hold", 10.0, -0.4), ("on", 10.5, -0.4)])])
    arms = doc_of([("hold on", 10.0, [("hold", 10.3, -0.4), ("on", 10.5, -0.4)])])
    songs = {song.slug: song}
    where = (str(tmp_path / "base"), str(tmp_path / "arms"))
    write_run(tmp_path / "base", base, line_errors=[(0, 0.0)], sha="a")
    write_run(tmp_path / "arms", arms, line_errors=[(0, 0.0)], sha="b")
    truth_row = json.loads((tmp_path / "base" / "rows.jsonl").read_text(encoding="utf-8"))
    (tmp_path / "base" / "rows.jsonl").write_text(
        json.dumps(truth_row) + "\n" + json.dumps({**truth_row, "mode": "jit"}) + "\n", encoding="utf-8"
    )
    with pytest.raises(prov.UnreadablePair, match="is missing 1 compared row"):
        prov.changes(tmp_path / "base", tmp_path / "arms", songs)
    assert exit_code(monkeypatch, song, *where) == 2
    with pytest.raises(prov.UnreadablePair, match="measured no such mode: jit"):
        prov.changes(tmp_path / "base", tmp_path / "arms", songs, modes=["jit"])
    assert exit_code(monkeypatch, song, *where, "--modes", "jit") == 2


def test_a_mode_the_run_never_measured_is_refused_not_read_as_clean(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--modes` is a filter, so a typo would otherwise report "nothing moved" and exit 0."""
    song = song_of((("hold on", 10.0),))
    base = doc_of([("hold on", 10.0, [("hold", 10.0, -0.4), ("on", 10.5, -0.4)])])
    arms = doc_of([("hold on", 10.0, [("hold", 10.3, -0.4), ("on", 10.5, -0.4)])])
    write_run(tmp_path / "base", base, mode="jit", line_errors=[(0, 0.0)], sha="a")
    write_run(tmp_path / "arms", arms, mode="jit", line_errors=[(0, 0.0)], sha="b")
    songs = {song.slug: song}
    with pytest.raises(prov.UnreadablePair, match="measured no such mode: truth"):
        prov.changes(tmp_path / "base", tmp_path / "arms", songs, modes=["truth"])
    assert len(prov.changes(tmp_path / "base", tmp_path / "arms", songs, modes=["jit"])) == 1
    where = (str(tmp_path / "base"), str(tmp_path / "arms"))
    assert exit_code(monkeypatch, song, *where, "--modes", "jit") == 1
    assert exit_code(monkeypatch, song, *where, "--modes", "jit", "--allow-worse", "1") == 0


def test_two_runs_that_measured_different_jobs_are_refused_before_a_word_is_priced(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The instrument the decision rests on read `rows.jsonl` and `media/` and never opened `run.json`.

    So `w8a-def-tt` against `w8a-def-ra` — a `time_text` run paired with a `run_align` one — printed
    "TOTAL better 0 equal 0 worse 0" and exited 0, which reads as "the arm moved nothing".
    `e2e_gates.py`'s rule for the same comparison is explicit: an ERROR, not a warning.
    """
    song = song_of((("hold on", 10.0),))
    base = doc_of([("hold on", 10.0, [("hold", 10.0, -0.4), ("on", 10.5, -0.4)])])
    arms = doc_of([("hold on", 10.0, [("hold", 10.3, -0.4), ("on", 10.5, -0.4)])])
    where = (str(tmp_path / "base"), str(tmp_path / "arms"))
    write_run(tmp_path / "base", base, line_errors=[(0, 0.0)], sha="a")
    write_run(tmp_path / "arms", arms, line_errors=[(0, 0.0)], sha="b", setup={**SETUP, "level": "time_text"})
    assert len(prov.changes(tmp_path / "base", tmp_path / "arms", {song.slug: song})) == 1, "the words differ"
    assert exit_code(monkeypatch, song, *where) == 2, "and the pair is still refused"
    with pytest.raises(prov.UnreadablePair, match="level differs"):
        prov._same_setup(tmp_path / "base", tmp_path / "arms")

    # An ARM is a difference in `align_config` and in the tree, which is the comparison this tool is for.
    write_run(
        tmp_path / "arms",
        arms,
        line_errors=[(0, 0.0)],
        sha="b",
        setup={**SETUP, "align_config": {"align_experiments": ["band-reopen"]}, "code": "abc"},
    )
    assert exit_code(monkeypatch, song, *where) == 1, "one word moved further from truth"

    (tmp_path / "arms" / "run.json").unlink()
    assert exit_code(monkeypatch, song, *where) == 2, "a run that says nothing about its setup is unreadable"
