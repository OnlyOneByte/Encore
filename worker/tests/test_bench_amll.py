"""The non-Latin truth set's ingest: AMLL TTML -> this benchmark's truth files (`scripts/amll.py`).

Hermetic — the TTML is written to tmp, no audio and no model is read. What matters here is that a WORD is the
TTML's own whitespace grouping (so the truth words and `line.text.split()` are one tokenisation and
`load_truth_words` accepts the file), that the voices the bench does not time are dropped and COUNTED, and
that a file this benchmark cannot score is refused rather than written. LOG.md, "W8: the non-Latin truth set".
"""

from __future__ import annotations

import importlib.util
import json
import sys
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
amll: Any = _load("amll")

HEAD = (
    '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" '
    'xmlns:amll="http://www.example.com/ns/amll"><head><metadata xmlns="">'
    '<amll:meta key="musicName" value="歌"/><amll:meta key="artists" value="歌手"/>'
    "</metadata></head><body>"
)
TAIL = "</body></tt>"


def doc(*paragraphs: str) -> str:
    return HEAD + '<div xmlns="">' + "".join(paragraphs) + "</div>" + TAIL


#: Two syllables, a space, then three: one line, two words, as a zh TTML writes a word boundary.
TWO_WORDS = (
    '<p begin="00:01.000" end="00:03.500" ttm:agent="v1">'
    '<span begin="00:01.000" end="00:01.400">山</span>'
    '<span begin="00:01.400" end="00:01.900">水</span> '
    '<span begin="00:02.000" end="00:02.400">风</span>'
    '<span begin="00:02.400" end="00:02.900">云</span>'
    '<span begin="00:02.900" end="00:03.500">雨</span></p>'
)


def test_a_word_is_the_ttmls_own_whitespace_grouping() -> None:
    parsed = amll.parse(doc(TWO_WORDS))
    (line,) = parsed.lines
    assert [word.text for word in line.words] == ["山水", "风云雨"]
    assert [(word.start, word.end) for word in line.words] == [(1.0, 1.9), (2.0, 3.5)]
    assert [word.syllables for word in line.words] == [2, 3]
    assert line.text == "山水 风云雨" and line.start == 1.0 and line.end == 3.5
    assert parsed.syllables == 5 and line.agent == "v1"
    assert parsed.meta["musicName"] == "歌" and parsed.restamped_lines == 0


def test_the_voices_the_bench_does_not_time_are_dropped_and_counted() -> None:
    """Background vocals sing over the lead, and a translation or a romanisation is not sung at all: the
    bench's truth is ONE voice's line sequence, and what was left out is reported rather than silent."""
    extras = (
        '<p begin="00:04.000" end="00:05.000" ttm:agent="v1">'
        '<span begin="00:04.000" end="00:04.500">啊</span>'
        '<span ttm:role="x-bg" begin="00:04.000" end="00:05.000">'
        '<span begin="00:04.100" end="00:04.600">(oh)</span></span>'
        '<span ttm:role="x-translation">ah</span>'
        '<span ttm:role="x-roman">a</span></p>'
    )
    parsed = amll.parse(doc(TWO_WORDS, extras))
    assert [line.text for line in parsed.lines] == ["山水 风云雨", "啊"]
    assert parsed.dropped_roles == {"x-bg": 1, "x-translation": 1, "x-roman": 1}
    assert parsed.syllables == 6, "the background syllable is not one of the timed ones"


def test_a_paragraph_with_no_lead_voice_is_counted_rather_than_published() -> None:
    only_bg = (
        '<p begin="00:06.000" end="00:07.000" ttm:agent="v2">'
        '<span ttm:role="x-bg" begin="00:06.000" end="00:07.000">'
        '<span begin="00:06.000" end="00:06.500">(ooh)</span></span></p>'
    )
    parsed = amll.parse(doc(TWO_WORDS, only_bg))
    assert len(parsed.lines) == 1 and parsed.wordless_lines == 1
    assert parsed.agents == ("v1",), "a line nobody timed carries no agent into the set"


def test_a_paragraph_stamp_that_disagrees_with_its_own_spans_is_reported() -> None:
    """The spans are what is SUNG, so they decide the line's bounds; a `<p>` claiming otherwise is a reading
    the set records rather than a repair it hides."""
    shifted = TWO_WORDS.replace('<p begin="00:01.000"', '<p begin="00:00.500"')
    parsed = amll.parse(doc(shifted))
    assert parsed.lines[0].start == 1.0 and parsed.restamped_lines == 1


def test_timestamps_in_every_shape_the_source_writes() -> None:
    assert amll.seconds("00:22.402") == pytest.approx(22.402)
    assert amll.seconds("1:02:03.500") == pytest.approx(3723.5)
    assert amll.seconds("12.5s") == pytest.approx(12.5)
    assert amll.seconds(None) is None and amll.seconds("") is None


def test_a_truth_file_whose_lines_run_backwards_is_refused_not_written(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`score_lines` pairs a document against truth in order, and the LINE_SYNC rung holds a stray claim at
    the line before it — so a truth file that runs backwards would be scoring against something no rung can
    publish. Refused by name, with nothing written beside it."""
    backwards = (
        '<p begin="00:00.500" end="00:00.900" ttm:agent="v1">'
        '<span begin="00:00.500" end="00:00.900">后</span></p>'
    )
    directory = tmp_path / lib.AMLL_DIR / "amll-zh-test"
    directory.mkdir(parents=True)
    (directory / "lyrics.ttml").write_text(doc(TWO_WORDS, backwards), encoding="utf-8")
    assert amll.out_of_order(amll.parse(doc(TWO_WORDS, backwards)).lines) == [1]
    assert amll.build(tmp_path) == 0
    assert "SKIP — line starts run backwards at [1]" in capsys.readouterr().out
    assert not list(directory.glob("truth-*.json"))


def test_what_it_writes_is_what_the_harness_reads(tmp_path: Path) -> None:
    """The round trip that matters: `load_truth_lines` + `load_truth_words` on the written files, which only
    accept each other when the word count and the whitespace tokens agree line for line."""
    directory = tmp_path / lib.AMLL_DIR / "amll-zh-test"
    directory.mkdir(parents=True)
    (directory / "lyrics.ttml").write_text(doc(TWO_WORDS), encoding="utf-8")
    assert amll.build(tmp_path) == 0

    truth = lib.load_truth_lines(directory / "truth-lines.json")
    words = lib.load_truth_words(directory / "truth-words.json", truth)
    assert [line.text for line in truth] == ["山水 风云雨"]
    assert words is not None, "a word count that disagreed with the line texts would answer None"
    assert [(word.start, word.end) for word in words] == [(1.0, 1.9), (2.0, 3.5)]
    assert sum(len(line.text.split()) for line in truth) == len(words)
    written = json.loads((directory / "truth-lines.json").read_text(encoding="utf-8"))
    assert written["source"].startswith(amll.SOURCE) and written["agents"] == ["v1"]


def test_no_ttml_at_all_is_a_refusal_rather_than_an_empty_set(tmp_path: Path) -> None:
    assert amll.build(tmp_path) == 2


def test_the_syllable_file_is_this_lanes_only_sub_line_truth(tmp_path: Path) -> None:
    """A WORD of a Chinese sheet is usually the whole line, so the syllable spans are where the character
    timing actually is — and each carries the CHARACTER OFFSET a published unit pairs on (stages 1-2)."""
    directory = tmp_path / lib.AMLL_DIR / "amll-zh-test"
    directory.mkdir(parents=True)
    (directory / "lyrics.ttml").write_text(doc(TWO_WORDS), encoding="utf-8")
    assert amll.build(tmp_path) == 0

    truth = lib.load_truth_lines(directory / "truth-lines.json")
    syllables = lib.load_truth_syllables(directory / "truth-syllables.json", truth)
    assert syllables is not None, "an offset that was not where it said would answer None"
    assert [(s.at, s.text) for s in syllables] == [
        (0, "山"),
        (1, "水"),
        (3, "风"),
        (4, "云"),
        (5, "雨"),
    ], "offset 2 is the space `Line.text` writes between the two words"
    assert all(truth[s.line].text[s.at : s.until] == s.text for s in syllables)
    assert [s.start for s in syllables] == [1.0, 1.4, 2.0, 2.4, 2.9]


def test_a_drifted_syllable_offset_is_refused_rather_than_scored(tmp_path: Path) -> None:
    """Scoring a unit against the wrong syllable's onset is the one failure this truth set could hide, so
    the loader checks every offset against its own line's text.

    IT RAISES, and it answers None only for an ABSENT file (review r1-tests-20). Answering None for both
    made a drifted file indistinguishable from "this corpus has no syllable truth": `discover` stored it on
    `Song.syllables`, `score_syllables` returned None, and `syllable_metrics` filtered the row out — so the
    song left the numerator AND the denominator and the "zh | 4 songs" header went on saying four.
    """
    directory = tmp_path / lib.AMLL_DIR / "amll-zh-test"
    directory.mkdir(parents=True)
    (directory / "lyrics.ttml").write_text(doc(TWO_WORDS), encoding="utf-8")
    assert amll.build(tmp_path) == 0
    truth = lib.load_truth_lines(directory / "truth-lines.json")
    path = directory / "truth-syllables.json"
    written = json.loads(path.read_text(encoding="utf-8"))
    assert lib.load_truth_syllables(path, truth) is not None, "as written it loads"
    written["syllables"][0]["at"] = 1
    path.write_text(json.dumps(written, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match="drifted from its own lines"):
        lib.load_truth_syllables(path, truth)
    written["syllables"][0].update({"at": 0, "line": 7})
    path.write_text(json.dumps(written, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError, match="which this truth does not have"):
        lib.load_truth_syllables(path, truth)
    assert lib.load_truth_syllables(directory / "absent.json", truth) is None


def test_a_role_this_script_does_not_know_refuses_the_song_rather_than_shortening_its_truth(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """`_syllables` drops a span with ANY `ttm:role`, while `parse` counted only the three it knows — so a
    fourth role took timed spans out of `truth-*.json` with `dropped=[-]` printed beside it (review
    r2-correctness-6). Every role is tallied now, and a name outside `DROPPED_ROLES` is a change to the
    SOURCE FORMAT: the song is refused, by name, and `build` exits non-zero so a CI leg can see it.
    """
    unknown = (
        '<p begin="00:04.000" end="00:05.000" ttm:agent="v1">'
        '<span begin="00:04.000" end="00:04.500">啊</span>'
        '<span ttm:role="x-lead" begin="00:04.500" end="00:05.000">哦</span></p>'
    )
    parsed = amll.parse(doc(TWO_WORDS, unknown))
    assert parsed.dropped_roles == {"x-lead": 1}, "counted by what was DROPPED, not by what is recognised"
    assert parsed.unknown_roles == ("x-lead",)
    assert parsed.syllables == 6, "the unlisted role's span is not in the truth"

    directory = tmp_path / lib.AMLL_DIR / "amll-zh-role"
    directory.mkdir(parents=True)
    (directory / "lyrics.ttml").write_text(doc(TWO_WORDS, unknown), encoding="utf-8")
    assert amll.build(tmp_path) == 1, "non-zero: a source-format change is not a per-song reading"
    said = capsys.readouterr().out
    assert "SKIP — ttm:role x-lead" in said and "extend DROPPED_ROLES" in said
    assert not list(directory.glob("truth-*.json")), "nothing written beside a truth it cannot trust"
    assert amll.parse(doc(TWO_WORDS)).unknown_roles == (), "a file with only known roles is unaffected"


def test_the_printed_next_step_is_the_command_that_actually_runs(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Review r2-tests-18: the hint read `truth_displacement.py --songs amll`, and these songs are only
    discovered under `--corpus nonlatin` (`e2e_lib.discover`), so run as printed it died with
    "--songs matched nothing" before measuring anything — on the one instruction an operator follows to
    admit a newly ingested non-Latin song."""
    directory = tmp_path / lib.AMLL_DIR / "amll-zh-ok"
    directory.mkdir(parents=True)
    (directory / "lyrics.ttml").write_text(doc(TWO_WORDS), encoding="utf-8")
    assert amll.build(tmp_path) == 0
    printed = [line for line in capsys.readouterr().out.splitlines() if line.startswith("next:")]
    assert len(printed) == 1, printed
    flags = printed[0].split("truth_displacement.py", 1)[1].split()
    assert f"--corpus {lib.NONLATIN_CORPUS}" in " ".join(flags), printed[0]
    # The printed flags must be ones the tool accepts, and must select the non-Latin corpus.
    displacement: Any = _load("truth_displacement")
    parser = displacement.argparse.ArgumentParser()
    parser.add_argument("--songs", default=None)
    parser.add_argument("--corpus", choices=lib.CORPORA, default=lib.ENGLISH_CORPUS)
    parser.add_argument("--out", default=None)
    parsed = parser.parse_args(["x" if flag == "<corpus-truth.json>" else flag for flag in flags])
    assert (parsed.corpus, parsed.songs) == (lib.NONLATIN_CORPUS, "amll")
