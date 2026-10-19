#!/usr/bin/env python
"""The TV-highlight parity fixture: documents, playback positions, and the word the TV lights at each.

    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/tv_parity.py        # rewrite
    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/tv_parity.py --check

The bench's `highlight` metric reads "which word is lit" through `e2e_lib`'s PORT of the TV's own
`core/src/lib/tv/lyrics.ts`, and three port mutations once passed the whole suite. So this fixture is written
FROM THE PORT and asserted in BOTH trees — `worker/tests/test_bench_e2e.py` and
`core/tests/unit/lib/tv/lyrics-bench-parity.test.ts` — and an edit on either side that moves a lit word fails
one of them. Change the other side with it and re-run this script; never hand-edit the JSON. README, "The
harness scripts", has the documents and what is EXPECTED of each.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import e2e_lib as lib  # noqa: E402 - after the path setup above

#: Where both trees read the fixture: beside the core test that pins `lyrics.ts` to it (core is built and
#: tested from `core/` alone, so the fixture lives there and the worker test reaches over).
FIXTURE = REPO / "core" / "tests" / "unit" / "lib" / "tv" / "bench-highlight-parity.json"

#: Where both trees read the CJK join class, as integer ranges: Python's `re` cannot write `CJK_JOINS`
#: (no Script_Extensions), so the equality needs an artefact to meet on.
CJK_FIXTURE = FIXTURE.with_name("cjk-join-ranges.json")

#: The overlay's word-level branch, verbatim: the port models a TV that lights words ONLY there. W6 added the
#: `wipesWords(l)` conjunct (a `low` line renders line-level), and this literal is what makes the core test
#: fail until the port has it too — `lib.tv_lit(wipe_low=True)` below.
OVERLAY_WORD_BRANCH = "{#if i === lineIdx && l.words.length && wordLevel && wipesWords(l)}"

RANDOM_DOCUMENTS = 16
SEED = 0

Word = tuple[str, float, float]


def _line(text: str | None, words: Sequence[Word]) -> dict[str, Any]:
    """A published line: its own bounds from its words (as the worker writes them), `text` or the words."""
    return {
        "start": min(s for _w, s, _e in words) if words else 0.0,
        "end": max(e for _w, _s, e in words) if words else 0.0,
        "text": " ".join(w for w, _s, _e in words) if text is None else text,
        "words": [{"word": w, "start": s, "end": e} for w, s, e in words],
    }


def _run(words: str, start: float, step: float = 0.4, sung: float = 0.3) -> list[Word]:
    """Words sung back to back from `start`, one every `step` seconds, each `sung` long."""
    return [
        (w, round(start + i * step, 3), round(start + i * step + sung, 3))
        for i, w in enumerate(words.split())
    ]


def _chars(text: str, start: float, step: float = 0.4, sung: float = 0.3) -> list[Word]:
    """`_run` for a script that writes no spaces: one word per character, as a CJK sheet is timed."""
    return [(ch, round(start + i * step, 3), round(start + i * step + sung, 3)) for i, ch in enumerate(text)]


def shaped() -> list[tuple[str, dict[str, Any]]]:
    """One document per rule of the port, named for it."""
    back = [
        *_run("morning light is falling on the rivers", 0.0),
        ("here", 3.4, 3.7),
        *_run("waiting for you", 5.0),
    ]
    forward = [
        *_run("we were singing on the long road", 0.0),
        # 0.9 s after "road", 0.5 s before "want" — both pauses split — so it folds FORWARD, a row before it.
        ("I", 3.6, 3.8),
        *_run("want a perfect body tonight", 4.3),
    ]
    thin = [("fly", 0.0, 0.3), ("away", 1.0, 1.3), ("home", 2.0, 2.3)]
    capped = _run("one two three four five six seven eight nine ten eleven twelve", 0.0, step=0.3, sung=0.3)
    return [
        (
            "ordered",
            {"lines": [_line(None, _run("the quick fox", 0.0)), _line(None, _run("jumps over", 2.0))]},
        ),
        (
            "misbound-late",
            {
                "lines": [
                    _line(None, _run("early words", 0.0)),
                    _line(None, _run("misbound late", 50.0)),
                    _line(None, _run("later words", 2.0)),
                ]
            },
        ),
        ("orphan-merges-back", {"lines": [_line(None, back)]}),
        ("orphan-merges-forward-after-a-row", {"lines": [_line(None, forward)]}),
        (
            # Its OWN bounds (0-10 s) outlast its words, so while it stands unsplit it holds the TV through
            # the next line's word; split, the rows end at 2.3 s and "next" lights.
            "coverage-refusal",
            {
                "lines": [
                    {
                        **_line("fly away home, and all the words this sheet never timed at all", thin),
                        "end": 10.0,
                    },
                    _line(None, [("next", 5.0, 5.5)]),
                ]
            },
        ),
        ("char-cap-without-a-pause", {"lines": [_line(None, capped)]}),
        (
            "overlapping-and-reversed-words",
            {
                "lines": [
                    _line(None, [("over", 1.0, 1.6), ("lap", 1.4, 2.0), ("back", 2.6, 2.2), ("on", 2.6, 3.0)])
                ]
            },
        ),
        (
            "blank-line-text",
            {"lines": [_line(" ", _run("words carry it", 1.0)), _line(None, _run("next", 3.0))]},
        ),
        (
            # W6's TV consumer: a `low` line renders as ONE text node, so no word is lit while
            # it is sung — the row still DISPLAYS, which is why `rows` is unchanged and only `lit` moves.
            "low-line-lights-no-word",
            {
                "lines": [
                    {**_line(None, _run("graded high", 0.0)), "confidence": "high"},
                    {**_line(None, _run("graded low", 2.0)), "confidence": "low"},
                    {**_line(None, _run("graded high again", 4.0)), "confidence": "high"},
                ]
            },
        ),
        (
            # Every row a `low` line splits into inherits the grade (`resegmentLine`'s last statements),
            # so a long doubted line lights nothing across all of its rows, not just the first.
            "low-line-splits-and-no-row-wipes",
            {"lines": [{**_line(None, back), "confidence": "low"}]},
        ),
        (
            # `medium`, an unknown value and a missing grade all keep the wipe: only `low` is doubt, and a
            # value `lyrics.ts` cannot parse is dropped there (so the line carries none) and is not `low`
            # here — the two readings agree by construction.
            "other-grades-still-wipe",
            {
                "lines": [
                    {**_line(None, _run("medium row", 0.0)), "confidence": "medium"},
                    {**_line(None, _run("unknown row", 2.0)), "confidence": "shiny"},
                    _line(None, _run("ungraded row", 4.0)),
                ]
            },
        ),
        (
            # W8's non-Latin lane: CJK writes no space between its words. Each line carries NO text, so
            # both trees rebuild it from the words and the gap rule is what they must agree on — including
            # Hangul, which spaces its words like Latin, and the mixed line's CJK/Latin boundary. The text
            # is SYNTHETIC in every script (README, "Why no fixture holds a lyric").
            "cjk-rebuilt-without-spaces",
            {
                "lines": [
                    _line("", _chars("山水风云雨雪雷", 0.0)),
                    _line("", _chars("雲が流れる", 3.0)),
                    _line("", _run("바다 하늘구름들", 5.0)),
                    _line("", [*_chars("山水风云", 8.0), *_run("a latin chorus", 9.5)]),
                ]
            },
        ),
        (
            # Long enough for the length guard to let the pause split fire, so each ROW's text is what
            # `lineFromWords`/`_line_from_words` rebuilt rather than the document's own.
            "cjk-splits-at-a-pause",
            {
                "lines": [
                    _line(
                        "ひらがなのれんしゅうです" * 4,
                        [
                            *_chars("ひらがなのれんしゅうです", 0.0, step=0.2, sung=0.15),
                            *_chars("ひらがなのれんしゅうです", 2.4, step=0.2, sung=0.15),
                            *_chars("ひらがなのれんしゅうです", 5.4, step=0.2, sung=0.15),
                            *_chars("ひらがなのれんしゅうです", 7.8, step=0.2, sung=0.15),
                        ],
                    )
                ]
            },
        ),
    ]


def randomized(rng: random.Random) -> dict[str, Any]:
    """A document mixing every shape: pauses, long lines, orphans, misbinding, reversed and zero spans."""
    lines: list[dict[str, Any]] = []
    clock = rng.uniform(0.0, 2.0)
    for _ in range(rng.randint(2, 6)):
        words: list[Word] = []
        for _k in range(rng.randint(1, 12)):
            word = "".join(rng.choice("abcdefghijklmnopqrstuvwxyz") for _c in range(rng.randint(1, 8)))
            sung = rng.choice((0.0, rng.uniform(0.05, 0.5), rng.uniform(0.5, 1.4)))
            start = round(clock, 3)
            end = round(clock + sung, 3)
            if rng.random() < 0.05:
                start, end = end, start  # a reversed span: never lit, but it still bounds the line
            words.append((word, start, end))
            clock += sung + rng.choice((0.0, 0.05, 0.2, 0.5, 1.2))
        text = None
        if rng.random() < 0.15:
            text = " ".join(w for w, _s, _e in words) + " and a long untimed tail the words do not cover"
        line = _line(text, words)
        if rng.random() < 0.1:  # misbound: the whole line placed 20-60 s late
            late = round(rng.uniform(20.0, 60.0), 3)
            line = _line(text, [(w, round(s + late, 3), round(e + late, 3)) for w, s, e in words])
        if rng.random() < 0.3:  # a grade on some lines: W6's low-line rule, mixed with every other shape
            line = {**line, "confidence": rng.choice(("high", "medium", "low"))}
        lines.append(line)
        clock += rng.uniform(0.2, 3.0)
    return {"lines": lines}


def tv_document(raw: dict[str, Any]) -> list[lib.TvLine]:
    """The port's view of a fixture document: `e2e_lib.tv_lines`, each word tagged with its FLAT index."""
    paired: list[tuple[lib.DocLine, list[int]]] = []
    flat = 0
    for line in raw["lines"]:
        words = tuple(
            lib.DocWord(float(w["start"]), float(w["end"]), True, str(w["word"])) for w in line["words"]
        )
        # `confidence` rides through as the document's own field, so the low-line rule (W6) is exercised by
        # the fixture rather than described by it.
        grade = line.get("confidence")
        doc = lib.DocLine(
            str(line["text"]),
            float(line["start"]),
            float(line["end"]),
            None if grade is None else str(grade),
            None,
            words,
        )
        paired.append((doc, list(range(flat, flat + len(words)))))
        flat += len(words)
    return lib.tv_lines(paired)


def positions(raw: dict[str, Any]) -> list[float]:
    """Every breakpoint, the midpoint of every gap between consecutive ones, and one outside each end."""
    points = sorted(
        {float(t) for line in raw["lines"] for t in (line["start"], line["end"])}
        | {float(t) for line in raw["lines"] for w in line["words"] for t in (w["start"], w["end"])}
    )
    middles = [(a + b) / 2 for a, b in zip(points, points[1:], strict=False) if b > a]
    return sorted({points[0] - 0.5, *points, *middles, points[-1] + 0.5})


def lit(lines: Sequence[lib.TvLine], pos: float) -> int:
    """The flat index of the word the port lights at `pos`, or -1.

    `wipe_low=True`: THE SHIPPED TV, which is what this fixture pins (the `highlight` metric asks the other
    question deliberately — `e2e_lib.score_highlight`). The core test's `litAt` must read `wipesWords` for
    the same reason, or the two trees agree only on documents that carry no grade.
    """
    word = lib.tv_lit(lines, pos, wipe_low=True)
    return -1 if word is None else word.truth


def build() -> dict[str, Any]:
    """The whole fixture, deterministically: same code, same bytes."""
    rng = random.Random(SEED)
    documents = [*shaped(), *((f"random-{i}", randomized(rng)) for i in range(RANDOM_DOCUMENTS))]
    cases = []
    for name, raw in documents:
        lines = tv_document(raw)
        at = positions(raw)
        rows = [[line.text, line.start, line.end] for line in lines]
        cases.append(
            {"name": name, "doc": raw, "rows": rows, "positions": at, "lit": [lit(lines, p) for p in at]}
        )
    return {
        "generator": "docs/benchmarks/forced-alignment/scripts/tv_parity.py",
        "constants": {
            "line_gap_sec": lib.TV_LINE_GAP_SEC,
            "line_max_chars": lib.TV_LINE_MAX_CHARS,
            "orphan_max_sec": lib.TV_ORPHAN_MAX_SEC,
            "lyrics_lead_sec": 0.0,
        },
        "overlay_word_branch": OVERLAY_WORD_BRANCH,
        "cases": cases,
    }


def dump(fixture: dict[str, Any]) -> str:
    """One case per line, so a moved word is a one-line diff."""
    head = {k: v for k, v in fixture.items() if k != "cases"}
    body = ",\n".join(f"  {json.dumps(case, separators=(',', ':'))}" for case in fixture["cases"])
    opening = json.dumps(head, indent=1)[:-2]
    return f'{opening},\n "cases": [\n{body}\n ]\n}}\n'


def cjk_ranges() -> str:
    """`lib.TV_CJK_JOINS` enumerated, for the core test that enumerates `lyrics.ts`'s own class against it —
    an equality nothing re-checked until review r1-tests-19 (README, "Core: one gap rule")."""
    ranges = lib.cjk_join_ranges()
    body = ",\n".join(f"  [{lo},{hi}]" for lo, hi in ranges)
    head = json.dumps(
        {
            "generator": "docs/benchmarks/forced-alignment/scripts/tv_parity.py --check",
            "source": "docs/benchmarks/forced-alignment/scripts/e2e_lib.py: TV_CJK_JOINS",
            "pins": "core/src/lib/tv/lyrics.ts: CJK_JOINS",
            "codepoints": sum(hi - lo + 1 for lo, hi in ranges),
        },
        indent=1,
    )[:-2]
    return f'{head},\n "ranges": [\n{body}\n ]\n}}\n'


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Write (or --check) the TV-highlight parity fixture.")
    ap.add_argument(
        "--check", action="store_true", help="exit 1 if the committed fixture is not what this writes"
    )
    args = ap.parse_args(argv)
    written = {FIXTURE: dump(build()), CJK_FIXTURE: cjk_ranges()}
    if args.check:
        # `is_file()` FIRST: an ungenerated fixture is the state `--check` exists to report, and reading it
        # for the comparison raised `FileNotFoundError` instead of saying so (review r2-correctness-7).
        stale = [
            path
            for path, text in written.items()
            if not path.is_file() or path.read_text(encoding="utf-8") != text
        ]
        for path in written:
            missing = not path.is_file()
            state = "up to date" if path not in stale else "MISSING" if missing else "STALE"
            print(f"{path}: {state}{'' if path not in stale else ' — re-run without --check'}")
        return 1 if stale else 0
    for path, text in written.items():
        path.write_text(text, encoding="utf-8")
    total = sum(len(case["positions"]) for case in build()["cases"])
    print(f"{FIXTURE}: {len(build()['cases'])} documents, {total} positions")
    print(f"{CJK_FIXTURE}: {len(lib.cjk_join_ranges())} ranges")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
