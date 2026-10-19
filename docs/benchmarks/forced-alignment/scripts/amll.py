#!/usr/bin/env python
"""AMLL TTML DB -> this benchmark's truth format: the NON-LATIN lane's ground truth (W8 stage 0).

    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/amll.py [--root DIR]

Reads `<bench>/amll/<slug>/lyrics.ttml` (CC0, github.com/amll-dev/amll-ttml-db) and writes that song's
`truth-lines.json` + `truth-words.json`. The TTML times every SYLLABLE; a WORD here is a run of syllables the
TTML writes with no space between them, so the truth words and `line.text.split()` are one tokenisation.
Background vocals, translations and romanisations are dropped — the bench's truth is one voice's line
sequence. The licence posture, what each song's audio is, and why a displaced song is dropped rather than
shifted: README, "W8: the non-Latin truth set".
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
import xml.etree.ElementTree as ET
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass

HERE = pathlib.Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import e2e_lib as lib  # noqa: E402 - after the path setup above

TTML = "{http://www.w3.org/ns/ttml}"
TTM = "{http://www.w3.org/ns/ttml#metadata}"
AMLL = "{http://www.example.com/ns/amll}"

#: The source every written truth file names, so a bench row can be traced to the commit it came from.
SOURCE = "amll-ttml-db/raw-lyrics (CC0)"

#: Roles whose spans are NOT the lead voice being timed: `x-bg` wraps background vocals in their own nested
#: spans, the other two carry a translation or a romanisation of the line.
DROPPED_ROLES = ("x-bg", "x-translation", "x-roman")


@dataclass(frozen=True, slots=True)
class Syllable:
    """One timed `<span>`: the finest unit this truth set has, and a hanzi or a mora in practice."""

    text: str
    start: float
    end: float


@dataclass(frozen=True, slots=True)
class Word:
    """One run of syllables the TTML writes without a space inside it."""

    text: str
    start: float
    end: float
    syllables: int
    spans: tuple[Syllable, ...] = ()


@dataclass(frozen=True, slots=True)
class Line:
    """One `<p>`: the lead voice's words, and which agent sang it."""

    words: tuple[Word, ...]
    agent: str

    @property
    def text(self) -> str:
        return " ".join(word.text for word in self.words)

    @property
    def start(self) -> float:
        return self.words[0].start

    @property
    def end(self) -> float:
        return max(word.end for word in self.words)


@dataclass(frozen=True, slots=True)
class Parsed:
    """One TTML file, read: its lines plus what was left out of them."""

    lines: tuple[Line, ...]
    meta: Mapping[str, str]
    dropped_roles: Mapping[str, int]
    #: `<p>` elements with no lead-voice span at all (a background-only interjection), and `<p>` stamps that
    #: disagree with their own spans by more than a millisecond — both reported rather than repaired.
    wordless_lines: int
    restamped_lines: int

    @property
    def unknown_roles(self) -> tuple[str, ...]:
        """Roles outside `DROPPED_ROLES` this file carries. `_syllables` drops a span with ANY role, so a
        fourth name is timed truth leaving the set — a change to the SOURCE FORMAT rather than a per-song
        fact, and `build` refuses the song instead of reporting it (review r2-correctness-6)."""
        return tuple(sorted(role for role in self.dropped_roles if role not in DROPPED_ROLES))

    @property
    def agents(self) -> tuple[str, ...]:
        return tuple(sorted({line.agent for line in self.lines if line.agent}))

    @property
    def syllables(self) -> int:
        return sum(word.syllables for line in self.lines for word in line.words)


def seconds(stamp: str | None) -> float | None:
    """A TTML timestamp (`h:mm:ss.sss`, `mm:ss.sss` or `12.5s`) in seconds, or None when there is none."""
    if not stamp:
        return None
    text = stamp.strip()
    if text.endswith("s") and ":" not in text:
        return float(text[:-1])
    parts = [float(part) for part in text.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0.0)
    return parts[0] * 3600.0 + parts[1] * 60.0 + parts[2]


def _syllables(paragraph: ET.Element) -> Iterator[tuple[str, float, float, bool]]:
    """`paragraph`'s lead-voice spans as (text, start, end, starts_a_word).

    A word break is the WHITESPACE the TTML writes between two spans — in the first span's `tail`, or in the
    paragraph's own text before it — so a dropped role cannot join the words either side of it.
    """
    break_before = True
    for span in paragraph:
        if span.tag not in (f"{TTML}span", "span"):
            continue
        role = span.get(f"{TTM}role")
        if role is not None:
            break_before = True
            continue
        text = (span.text or "").strip()
        start, end = seconds(span.get("begin")), seconds(span.get("end"))
        if text and start is not None and end is not None:
            yield text, start, max(end, start), break_before
        tail = span.tail or ""
        break_before = tail != tail.strip()


def parse(xml: str) -> Parsed:
    """One AMLL TTML document's lead-voice lines, in the order it writes them."""
    root = ET.fromstring(xml)  # noqa: S314 - CC0 text files in the bench corpus, not network input
    meta = {
        str(element.get("key")): str(element.get("value"))
        for element in root.iter()
        if element.tag in (f"{AMLL}meta", "meta") and element.get("key")
    }
    dropped: dict[str, int] = {}
    lines: list[Line] = []
    wordless = restamped = 0
    for paragraph in root.iter():
        if paragraph.tag not in (f"{TTML}p", "p"):
            continue
        # EVERY role, not only the three known ones: `_syllables` drops a span on `role is not None`, so a
        # tally of the recognised names alone would lose timed truth with nothing in the report saying it
        # (review r2-correctness-6).
        for span in paragraph.iter():
            role = span.get(f"{TTM}role")
            if role is not None:
                dropped[role] = dropped.get(role, 0) + 1
        words: list[Word] = []
        for text, start, end, breaks in _syllables(paragraph):
            span = Syllable(text, start, end)
            if breaks or not words:
                words.append(Word(text, start, end, 1, (span,)))
                continue
            last = words[-1]
            words[-1] = Word(
                last.text + text,
                last.start,
                max(last.end, end),
                last.syllables + 1,
                (*last.spans, span),
            )
        if not words:
            wordless += 1
            continue
        line = Line(tuple(words), str(paragraph.get(f"{TTM}agent") or ""))
        claimed = (seconds(paragraph.get("begin")), seconds(paragraph.get("end")))
        if claimed[0] is not None and abs(claimed[0] - line.start) > 0.001:
            restamped += 1
        elif claimed[1] is not None and abs(claimed[1] - line.end) > 0.001:
            restamped += 1
        lines.append(line)
    return Parsed(tuple(lines), meta, dropped, wordless, restamped)


def _offsets(line: Line) -> Iterator[tuple[int, Syllable]]:
    """`(character offset in `line.text`, syllable)` for every timed span of `line`.

    The offset is what pairs a truth syllable with a published unit: `Line.text` joins its WORDS with a
    space, so each word's spans start one character further on than its own letters.
    """
    at = 0
    for word in line.words:
        for span in word.spans:
            yield at, span
            at += len(span.text)
        at += 1  # the space `Line.text` writes between two words


def out_of_order(lines: Sequence[Line]) -> list[int]:
    """Indexes whose start sits before the line before them — a truth file this benchmark cannot score."""
    return [
        index for index, line in enumerate(lines) if index and line.start < lines[index - 1].start - 0.001
    ]


def write(directory: pathlib.Path, parsed: Parsed, ttml: pathlib.Path) -> None:
    """`truth-lines.json` and `truth-words.json` for one song, in `load_truth_*`'s shape."""
    (directory / "truth-lines.json").write_text(
        json.dumps(
            {
                "source": f"{SOURCE}: {ttml.name}",
                "music_name": parsed.meta.get("musicName", ""),
                "artists": parsed.meta.get("artists", ""),
                "agents": list(parsed.agents),
                "lines": [{"start": line.start, "end": line.end, "text": line.text} for line in parsed.lines],
            },
            ensure_ascii=False,
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    (directory / "truth-words.json").write_text(
        json.dumps(
            {
                "source": f"{SOURCE}: {ttml.name}",
                "words": [
                    {"start": word.start, "end": word.end} for line in parsed.lines for word in line.words
                ],
                "tokens": [word.text for line in parsed.lines for word in line.words],
            },
            ensure_ascii=False,
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    # THE SYLLABLE FILE IS WHERE THIS LANE'S WORD TRUTH ACTUALLY IS: Chinese and Japanese write a line with
    # no space in it, so a "word" above is the whole line and nothing but this file times a character. Its
    # `line` and `at` are a CHARACTER OFFSET, so a published unit pairs with it whatever rule split it
    # (`e2e_lib.load_truth_syllables`; README, "W8 stages 1-2").
    (directory / "truth-syllables.json").write_text(
        json.dumps(
            {
                "source": f"{SOURCE}: {ttml.name}",
                "syllables": [
                    {"line": index, "at": at, "text": span.text, "start": span.start, "end": span.end}
                    for index, line in enumerate(parsed.lines)
                    for at, span in _offsets(line)
                ],
            },
            ensure_ascii=False,
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )


def build(root: pathlib.Path) -> int:
    """Every `<root>/amll/<slug>/lyrics.ttml` converted; one line of report per song.

    Non-zero when a song was refused for a `ttm:role` this script does not know, that being a source-format
    change a CI leg must see rather than a per-song reading (review r2-correctness-6).
    """
    songs = sorted(path.parent for path in (root / lib.AMLL_DIR).glob("*/lyrics.ttml"))
    if not songs:
        print(f"no {root / lib.AMLL_DIR}/*/lyrics.ttml to read", file=sys.stderr)
        return 2
    refused = 0
    for directory in songs:
        ttml = directory / "lyrics.ttml"
        parsed = parse(ttml.read_text(encoding="utf-8"))
        unknown = parsed.unknown_roles
        if unknown:
            refused += 1
            print(
                f"{directory.name:<28} SKIP — ttm:role {', '.join(unknown)} is not one of "
                f"{', '.join(DROPPED_ROLES)}, and every role's spans are dropped: this song's truth would "
                f"be short by them. Read the TTML and extend DROPPED_ROLES.",
                flush=True,
            )
            continue
        broken = out_of_order(parsed.lines)
        if broken:
            print(f"{directory.name:<28} SKIP — line starts run backwards at {broken}", flush=True)
            continue
        write(directory, parsed, ttml)
        dropped = ", ".join(f"{role} {count}" for role, count in sorted(parsed.dropped_roles.items()))
        print(
            f"{directory.name:<28} {len(parsed.lines):>3} lines {parsed.syllables:>4} syllables "
            f"{sum(len(line.words) for line in parsed.lines):>4} words "
            f"{parsed.lines[-1].end:>7.2f}s agents={','.join(parsed.agents) or '-'} "
            f"dropped=[{dropped or '-'}] wordless={parsed.wordless_lines} "
            f"restamped={parsed.restamped_lines}",
            flush=True,
        )
    # `--corpus nonlatin` is not optional: these songs are only discovered there (`e2e_lib.discover`), and
    # without it the next step dies on "--songs matched nothing" (review r2-tests-18).
    print(
        "next: separate vocals, then "
        "truth_displacement.py --corpus nonlatin --songs amll --out <corpus-truth.json>"
    )
    return 1 if refused else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=pathlib.Path, default=None, help=f"default: {lib.bench_root()}")
    args = parser.parse_args(argv)
    return build(args.root or lib.bench_root())


if __name__ == "__main__":
    raise SystemExit(main())
