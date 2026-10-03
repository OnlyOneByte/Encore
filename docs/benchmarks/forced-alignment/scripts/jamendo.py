#!/usr/bin/env python
"""JamendoLyrics -> this benchmark's truth format. The first MEASURED (not authored) ground truth here.

    git clone https://github.com/f90/jamendolyrics /tmp/encore-align-bench/jamendolyrics
    uv run python docs/benchmarks/forced-alignment/scripts/jamendo.py

WHY THIS EXISTS. Every other song's truth is AUTHORED captions, one onset per line and carrying the caption
author's jitter, so the benchmark could only ever measure LINE onsets. JamendoLyrics ships hand-MEASURED word
AND line onsets — the karaoke ball's actual unit, and clean enough that a 50 ms aligner error reads as 50 ms.

ENGLISH ONLY, the shipped syllabifier and the default bundle being English. WORD TRUTH SHAPE: the onsets and
the tokens arrive in two positional files, so `truth-words.json` keeps them as parallel lists and the scorer
walks the same order.
"""

from __future__ import annotations

import csv
import json
import os
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
ROOT = pathlib.Path("/tmp/encore-align-bench/jamendolyrics")
OUT = pathlib.Path("/tmp/encore-align-bench/jamendo")


def build() -> None:
    if not ROOT.is_dir():
        raise SystemExit(f"clone f90/jamendolyrics to {ROOT} first")
    rows = list(csv.DictReader(open(ROOT / "JamendoLyrics.csv", encoding="utf-8")))
    english = [r for r in rows if r["Language"] == "English"]
    made = 0
    for r in english:
        slug = r["Filepath"][:-4]  # drop .mp3
        directory = OUT / slug
        directory.mkdir(parents=True, exist_ok=True)

        lines = []
        with open(ROOT / "annotations" / "lines" / f"{slug}.csv", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                lines.append(
                    {
                        "start": float(row["start_time"]),
                        "end": float(row["end_time"]),
                        "text": row["lyrics_line"],
                    }
                )
        json.dump(
            {"source": "jamendolyrics/annotations/lines", "lines": lines},
            open(directory / "truth-lines.json", "w", encoding="utf-8"),
            indent=1,
        )

        words = []
        with open(ROOT / "annotations" / "words" / f"{slug}.csv", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                words.append({"start": float(row["word_start"]), "end": float(row["word_end"])})
        tokens = [
            t
            for t in open(ROOT / "lyrics" / f"{slug}.words.txt", encoding="utf-8").read().split("\n")
            if t.strip()
        ]
        if len(tokens) != len(words):
            print(f"  {slug}: SKIP — {len(tokens)} tokens vs {len(words)} onsets")
            continue
        json.dump(
            {"words": words, "tokens": tokens},
            open(directory / "truth-words.json", "w", encoding="utf-8"),
            indent=1,
        )

        link = directory / "mix.mp3"
        if not link.exists():
            os.symlink(ROOT / "mp3" / r["Filepath"], link)
        made += 1
    print(f"built {made} English songs under {OUT}")
    print(
        "next: separate vocals (demucs-mlx -n htdemucs -o <dir> <dir>/mix.mp3), then bench.py "
        "--global --words <dir>/truth-words.json --audio <dir>/mix/vocals.wav"
    )


if __name__ == "__main__":
    build()
