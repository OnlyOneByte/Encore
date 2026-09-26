#!/usr/bin/env python
"""JamendoLyrics -> this benchmark's truth format. The first MEASURED (not authored) ground truth here.

    git clone https://github.com/f90/jamendolyrics /tmp/encore-align-bench/jamendolyrics
    uv run python docs/benchmarks/forced-alignment/scripts/jamendo.py

WHY THIS EXISTS. Every other song's truth is AUTHORED captions (yt-dlp --write-subs): a human typed the
line and YouTube stored one onset per line, so the benchmark could only ever measure LINE onsets, and even
those carry the caption author's timing jitter. JamendoLyrics (MultiLang, CC-licensed, f90/jamendolyrics)
ships hand-MEASURED word AND line onsets — the karaoke ball's actual unit, and a truth clean enough that a
50 ms aligner error reads as 50 ms rather than being lost under caption noise.

ENGLISH ONLY, because the shipped syllabifier and the wav2vec2 alignment model this benchmark drives are
English; the German/Spanish/French thirds of the corpus need their own align model to be a fair test.

WORD TRUTH SHAPE. `annotations/words/<song>.csv` carries one (word_start, word_end) per token in reading
order; `lyrics/<song>.words.txt` carries the tokens themselves, one per line. The two are positional — the
Nth onset belongs to the Nth token — so `truth-words.json` keeps them as parallel lists and the scorer
pairs them against generate()'s words by walking the same order.
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
        tokens = [t for t in open(ROOT / "lyrics" / f"{slug}.words.txt", encoding="utf-8").read().split("\n") if t.strip()]
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
    print("next: separate vocals (demucs-mlx -n htdemucs -o <dir> <dir>/mix.mp3), then bench.py "
          "--global --words <dir>/truth-words.json --audio <dir>/mix/vocals.wav")


if __name__ == "__main__":
    build()
