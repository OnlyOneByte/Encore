"""Measure how far each corpus song's TRUTH sits from its own audio, and write `corpus-truth.json`.

A truth file that leads its recording makes a correct aligner score badly, so the four songs W8b excludes from
accuracy scoring are excluded on a measurement rather than on a name. Three readings per song: the delay to
first singing after a claimed start that lands in stem SILENCE, the whole sheet's envelope cross-correlation
lag, and the stem's own median level at a truth start — which says whether the first reading could see
anything here at all. None of them touches a `truth-lines.json`.

Method, thresholds, the per-song numbers and the controls that set the limits: LOG.md, "W8b: the corpus's own
truth, measured, and the 28 songs that score".
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import e2e_lib as lib  # noqa: E402

#: Mean envelope over `PROBE_SEC` from a claimed start, below which that start sits in SILENCE. The level and
#: the window are LOG.md's third arbiter ("Stem energy at the instant each line claims").
SILENT_LEVEL, PROBE_SEC = 0.10, 0.25

#: Singing resumes at the first frame reaching `SINGING_LEVEL` that holds above `SILENT_LEVEL` for
#: `HOLD_SEC`, searched this far forward. The first arbiter's onset detector, unchanged.
SINGING_LEVEL, HOLD_SEC, REACH_SEC = 0.30, 0.1, 4.0


@dataclass(frozen=True, slots=True)
class Reading:
    """One song's measured truth displacement, as `corpus-truth.json` records it."""

    truth_lines: int
    silent_starts: int
    onsets: tuple[float, ...]
    lag_ms: float
    correlation: float
    starts_level_median: float | None

    def as_json(self) -> dict[str, object]:
        centre = statistics.median(self.onsets) if self.onsets else None
        return {
            "truth_lines": self.truth_lines,
            "silent_starts": self.silent_starts,
            "onsets": len(self.onsets),
            "median_ms": None if centre is None else round(centre * 1000.0, 1),
            "mad_ms": None
            if centre is None
            else round(statistics.median(abs(d - centre) for d in self.onsets) * 1000.0, 1),
            "max_ms": None if not self.onsets else round(max(self.onsets) * 1000.0, 1),
            "lag_ms": round(self.lag_ms, 1),
            "correlation": round(self.correlation, 3),
            "starts_level_median": None
            if self.starts_level_median is None
            else round(self.starts_level_median, 3),
            "method": lib.DISPLACEMENT_METHOD,
        }


def level_at(envelope: np.ndarray, start: float, hop: float) -> float | None:
    """The mean stem level over `PROBE_SEC` from `start`; None when the start is past the audio."""
    first = max(0, int(start / hop))
    window = envelope[first : first + max(1, int(PROBE_SEC / hop))]
    return float(window.mean()) if len(window) else None


def starts_in_silence(envelope: np.ndarray, start: float, hop: float) -> bool:
    level = level_at(envelope, start, hop)
    return level is not None and level < SILENT_LEVEL


def singing_after(envelope: np.ndarray, start: float, hop: float) -> float | None:
    """Seconds from `start` to the first held onset at or after it; None if none comes within `REACH_SEC`."""
    first = max(0, int(start / hop))
    last = min(len(envelope), int((start + REACH_SEC) / hop))
    hold = max(1, int(HOLD_SEC / hop))
    for frame in range(first, last - hold):
        if envelope[frame] >= SINGING_LEVEL and float(envelope[frame : frame + hold].min()) >= SILENT_LEVEL:
            return frame * hop - start
    return None


def read_song(
    envelope: np.ndarray,
    truth: Sequence[lib.TruthLine],
    *,
    lag_ms: float,
    correlation: float,
    hop: float,
) -> Reading:
    """The silent-start delays of one song, paired with a cross-correlation lag measured by the caller.

    ONE-SIDED by construction: a start sitting in silence can only be followed by singing, never preceded by
    it, so this detects a sheet that runs EARLY and is blind to one that runs late. How many lines qualify is
    therefore half the evidence, which `lib.TruthQuality.confidence` reads against
    `lib.MIN_DISPLACEMENT_ONSETS` and `lib.MIN_DISPLACEMENT_SHARE`. `starts_level_median` is read over EVERY
    start, silent or not: it says whether this arbiter could see anything here (`lib.CONTINUOUS_VOCAL_LEVEL`).
    """
    silent = [line.start for line in truth if starts_in_silence(envelope, line.start, hop)]
    delays = [delay for start in silent if (delay := singing_after(envelope, start, hop)) is not None]
    levels = [level for line in truth if (level := level_at(envelope, line.start, hop)) is not None]
    return Reading(
        truth_lines=len(truth),
        silent_starts=len(silent),
        onsets=tuple(delays),
        lag_ms=lag_ms,
        correlation=correlation,
        starts_level_median=statistics.median(levels) if levels else None,
    )


def measure(song: lib.Song) -> Reading:
    """`read_song` over a corpus song's vocals stem. The only part that touches audio."""
    from encore_worker.domain.audio import activity, wav

    signal, rate = wav.read_wav_mono(str(song.vocals))
    fit = activity.fit_sheet_to_audio(signal, rate, [(line.start, line.end) for line in song.truth])
    return read_song(
        activity.envelope(signal, rate),
        song.truth,
        lag_ms=fit.seconds * 1000.0,
        correlation=fit.correlation,
        hop=activity.HOP_SEC,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--songs", default=None, help="slugs, prefixes or a group (default: all 32)")
    parser.add_argument(
        "--corpus",
        choices=lib.CORPORA,
        default=lib.ENGLISH_CORPUS,
        help="which song set to measure; the non-Latin songs are their own corpus (W8)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help=f"write the corpus file — measured songs merged over the recorded ones (= {lib.CORPUS_TRUTH})",
    )
    args = parser.parse_args(argv)

    recorded = lib.load_corpus_truth()
    kept_entries = lib.corpus_truth_entries()
    songs = lib.select(lib.discover(lib.bench_root(), corpus=args.corpus), args.songs)
    measured: dict[str, dict[str, object]] = {}
    for song in songs:
        reading = measure(song).as_json()
        kept = recorded.get(song.slug)
        if kept is not None and kept.unusable is not None:
            # A ground that is not a measurement is the operator's to write and this tool's to preserve — but
            # only while the FRESH numbers still support it, or a re-anchored sheet would keep an exclusion
            # nothing can clear (review r2-correctness-1).
            reading["unusable"] = kept.unusable
            reading["note"] = kept.note
        entry = lib.TruthQuality(slug=song.slug, **reading)  # type: ignore[arg-type]
        if refuses := entry.unsupported_ground():
            print(
                f"{song.slug:<40} DROPPED the recorded ground {entry.unusable!r}: {'; '.join(refuses)}",
                flush=True,
            )
            del reading["unusable"], reading["note"]
            entry = lib.TruthQuality(slug=song.slug, **reading)  # type: ignore[arg-type]
        measured[song.slug] = {**reading, **lib.derived_of(entry)}
        print(
            f"{song.slug:<40} lines {reading['truth_lines']:>3} silent {reading['silent_starts']:>3} "
            f"onsets {reading['onsets']:>3} median {_ms(reading['median_ms'])} MAD {_ms(reading['mad_ms'])} "
            f"max {_ms(reading['max_ms'])} lag {_ms(reading['lag_ms'])} r {reading['correlation']} "
            f"lvl {reading['starts_level_median']} "
            f"{entry.confidence:<13} {'DISPLACED' if entry.displaced else ''}"
            f"{'' if entry.exclusion is None else ' EXCLUDED'}",
            flush=True,
        )
    if args.out is not None:
        # A `--songs` subset MEASURES a subset and REWRITES the whole file, so the songs it did not read keep
        # the numbers (and the operator's `unusable` grounds) they were measured with.
        document = {
            "doc": lib.CORPUS_TRUTH_DOC,
            "method": lib.DISPLACEMENT_METHOD,
            "limits": {
                "displacement_ms": lib.DISPLACEMENT_LIMIT_MS,
                "min_onsets": lib.MIN_DISPLACEMENT_ONSETS,
                "min_onset_share": lib.MIN_DISPLACEMENT_SHARE,
                "min_lag_correlation": lib.MIN_LAG_CORRELATION,
                "continuous_vocal_level": lib.CONTINUOUS_VOCAL_LEVEL,
            },
            "songs": dict(sorted({**kept_entries, **measured}.items())),
        }
        args.out.write_text(json.dumps(document, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {args.out}")
    return 0


def _ms(value: object) -> str:
    return "      -" if value is None else f"{float(str(value)):+7.0f}"


if __name__ == "__main__":
    raise SystemExit(main())
