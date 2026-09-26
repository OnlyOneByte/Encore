#!/usr/bin/env python
"""Ground truth for forced alignment: AUTHORED line timings, fetched from the song's own captions.

    uv run python docs/benchmarks/forced-alignment/scripts/truth.py tfr-flyaway

AUTHORED, NEVER AUTO-GENERATED, and the distinction is the whole validity of this benchmark. yt-dlp's
`--write-subs` returns the track a human typed; `--write-auto-subs` returns YouTube's own ASR. Scoring a
forced aligner against another model's output measures agreement between two models, not correctness — so
this script passes `--write-subs` only, and refuses a song that has none rather than falling back.

LINE LEVEL, because that is what exists. A `json3` caption event carries one start and one duration for a
whole line; the per-word offsets a karaoke ball would want are absent (verified: 0 of 75 events on
tfr-flyaway carry more than one timed segment). So every figure in this benchmark is a LINE ONSET figure,
and no claim is made about word placement.

WHY LINE ONSETS ARE STILL THE NUMBER THAT MATTERS: a singer reads the line before singing it. A line that
highlights late is the complaint; a word inside a correctly-placed line being 80 ms off is not.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SONGS_DIR = os.path.normpath(os.path.join(HERE, "..", "..", "benchmark-songs"))

#: The same manifest the stem-separation benchmark uses, so one prepared song serves both.
VIDEOS = {
    "tfr-flyaway": "https://www.youtube.com/watch?v=cMg8KaMdDYo",
    "tfr-mayday": "https://www.youtube.com/watch?v=DT61L8hbbJ4",
    "tfr-chosen": "https://www.youtube.com/watch?v=9YHTVML4PTE",
}


def fetch(song: str, out_dir: str) -> str | None:
    """Download authored captions, returning the json3 path or None when the song has none."""
    stem = os.path.join(out_dir, f"{song}.authored")
    subprocess.run(
        ["yt-dlp", "--skip-download", "--write-subs", "--sub-langs", "en.*",
         "--sub-format", "json3", "-o", f"{stem}.%(ext)s", VIDEOS[song]],
        check=False, capture_output=True,
    )
    for name in sorted(os.listdir(out_dir)):
        if name.startswith(f"{song}.authored") and name.endswith(".json3"):
            return os.path.join(out_dir, name)
    return None


def lines_of(json3_path: str) -> list[dict[str, object]]:
    """Caption events to `{start, end, text}`, in order, blanks dropped.

    `dDurationMs` is used for `end` rather than the next event's start: consecutive captions can overlap or
    leave a gap, and a duration is what the author actually declared.
    """
    doc = json.load(open(json3_path, encoding="utf-8"))
    out: list[dict[str, object]] = []
    for event in doc.get("events") or []:
        segs = event.get("segs") or []
        text = "".join(str(s.get("utf8", "")) for s in segs).replace("\n", " ").strip()
        if not text:
            continue
        start = float(event.get("tStartMs", 0)) / 1000.0
        out.append({"start": start, "end": start + float(event.get("dDurationMs", 0)) / 1000.0, "text": text})
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("song", nargs="*", default=None, help=f"one of: {', '.join(VIDEOS)}")
    args = ap.parse_args()
    for song in args.song or list(VIDEOS):
        directory = os.path.join(SONGS_DIR, song)
        if not os.path.isdir(directory):
            print(f"{song}: no directory at {directory}; skipping", file=sys.stderr)
            continue
        path = fetch(song, directory)
        if path is None:
            print(f"{song}: NO AUTHORED CAPTIONS — cannot be ground truth, and auto-subs are refused")
            continue
        lines = lines_of(path)
        target = os.path.join(directory, "truth-lines.json")
        with open(target, "w", encoding="utf-8") as handle:
            json.dump({"source": os.path.basename(path), "lines": lines}, handle, indent=1)
        span = f"{lines[0]['start']:.2f}s..{lines[-1]['end']:.2f}s" if lines else "empty"
        print(f"{song}: {len(lines)} authored lines, {span} -> {os.path.relpath(target, SONGS_DIR)}")


if __name__ == "__main__":
    main()
