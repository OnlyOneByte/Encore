#!/usr/bin/env python
"""Fetch each benchmark song's audio and build its ground-truth reference from the artist's stems.

    uv run python docs/benchmarks/stem-separation/scripts/prepare.py              # every song
    uv run python docs/benchmarks/stem-separation/scripts/prepare.py tfr-mayday   # just one

Writes four files per song, all gitignored because this script rebuilds them deterministically:

    youtube-mix.wav           the WORKER'S OWN input, fetched with yt-dlp exactly as `adapters/cli` does
    reference-mix.wav         instrumental + vocals, scaled
    reference-instrumental.wav
    reference-vocals.wav

TWO MIXES, MEASURING DIFFERENT THINGS, and they are not interchangeable. Timing belongs on the YouTube file
because that is what production actually receives — lossy-sourced, 48 kHz. Scoring cannot use it: the master
is neither the same sample rate nor the same length as the stems (flyaway: 48000 vs 44100 Hz, 194.258 vs
194.065 s), so an SDR computed against them would be measuring misalignment, not separation.

WHY THE REFERENCE IS SCALED. Summed raw, these stems clip — flyaway peaks at 2.16, chosen at 2.48, mayday at
1.86 — because each released master applied gain reduction and limiting afterwards. One constant is therefore
applied to the mixture and to BOTH ground-truth stems identically, which preserves
`mixture == instrumental + vocals` exactly. That identity is the single property every SDR figure depends on,
so it is asserted here rather than assumed.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys

import numpy as np
import soundfile as sf

import songs as catalogue

#: Leaves headroom without being so quiet that 24-bit quantisation shows up in an SDR figure.
TARGET_PEAK = 0.95


def fetch_youtube(song: catalogue.Song) -> None:
    """Download the mix the way the worker does. Skipped when already present — this is a 40 MB download and
    the file is byte-stable, so re-fetching on every run wastes bandwidth and changes nothing."""
    if os.path.isfile(song.youtube_mix):
        print(f"  youtube-mix.wav present, skipping download")
        return
    if shutil.which("yt-dlp") is None:
        print("  yt-dlp not on PATH; skipping the timing input (scoring still works)", file=sys.stderr)
        return
    subprocess.run(
        ["yt-dlp", "-x", "--audio-format", "wav", "--audio-quality", "0",
         "-o", os.path.join(song.directory, "youtube-mix.%(ext)s"), song.video],
        check=True,
    )


def sum_stems(song: catalogue.Song, names: tuple[str, ...]) -> tuple[np.ndarray, int, int]:
    """Sum the named files. Returns (audio, sample_rate, frames)."""
    total: np.ndarray | None = None
    rate = 0
    for name in names:
        path = song.path(name)
        if not os.path.isfile(path):
            raise SystemExit(f"{song.song_id}: missing stem {name!r}. Expected at {path}")
        audio, sr = sf.read(path, dtype="float64", always_2d=True)
        if total is None:
            total, rate = audio, sr
        else:
            if sr != rate:
                raise SystemExit(f"{song.song_id}: {name!r} is {sr} Hz but a sibling is {rate} Hz")
            n = min(len(total), len(audio))
            total = total[:n] + audio[:n]
    assert total is not None
    return total, rate, len(total)


def build_reference(song: catalogue.Song) -> None:
    instrumental, rate, _ = sum_stems(song, song.instrumental)
    vocals, voc_rate, _ = sum_stems(song, song.vocals)
    if rate != voc_rate:
        raise SystemExit(f"{song.song_id}: instrumental is {rate} Hz, vocals {voc_rate} Hz")

    n = min(len(instrumental), len(vocals))
    instrumental, vocals = instrumental[:n], vocals[:n]
    mixture = instrumental + vocals

    peak = float(np.abs(mixture).max())
    gain = TARGET_PEAK / peak if peak > TARGET_PEAK else 1.0
    print(f"  raw sum peaks at {peak:.4f}; scaling by {gain:.4f}")

    for name, data in (
        ("reference-mix", mixture),
        ("reference-instrumental", instrumental),
        ("reference-vocals", vocals),
    ):
        sf.write(song.path(f"{name}.wav"), data * gain, rate, subtype="PCM_24")

    # The identity every SDR figure rests on, checked against the resolution that actually matters.
    #
    # NOT asserted as exact equality: `(a + b) * g` and `a * g + b * g` differ by one float64 epsilon
    # (measured 1.11e-16), which is IEEE754 rounding rather than a defect. The meaningful bound is the output
    # format — one PCM_24 step is 2^-23 ~ 1.2e-7, so an error 9 orders of magnitude below that cannot affect
    # any SDR figure. An exact check here fails on correct data, which it did on the first run.
    pcm24_step = 2.0**-23
    residual = float(np.abs((mixture * gain) - ((instrumental * gain) + (vocals * gain))).max())
    if residual > pcm24_step:
        raise SystemExit(
            f"{song.song_id}: mixture != instrumental + vocals. max |diff| {residual:.3e} exceeds one "
            f"PCM_24 step ({pcm24_step:.3e}), so the error is real rather than rounding."
        )
    print(f"  {n / rate:7.2f}s @ {rate} Hz — mix == instrumental + vocals to {residual:.2e} "
          f"(< 1 PCM_24 step, {pcm24_step:.1e})")


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser()
    ap.add_argument("song", nargs="*", default=None, help="song ids; omit for all")
    ap.add_argument("--skip-download", action="store_true", help="build references only")
    args = ap.parse_args()

    chosen = [catalogue.get(s) for s in args.song] if args.song else list(catalogue.SONGS)
    for song in chosen:
        print(f"\n{song.song_id}  ({song.title})")
        if not os.path.isdir(song.directory):
            print(f"  no directory at {song.directory}; skipping", file=sys.stderr)
            continue
        if not args.skip_download:
            fetch_youtube(song)
        build_reference(song)
        for name, why in song.excluded.items():
            print(f"  NOT USED  {name}: {why}")


if __name__ == "__main__":
    main()
