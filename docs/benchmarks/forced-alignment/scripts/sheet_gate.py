#!/usr/bin/env python
"""The LINE_SYNC rung's sheet-span gate, measured over the E2E bench's own claims. No model runs.

    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/sheet_gate.py [--out f.json]

WHY IT EXISTS (W1, review M1 + the W0 hazard). Once a LINE_SYNC document can commit, the rung publishes the
text's OWN line timings — so it needs a gate, and the one the worker ships (`align_steps._sheet_spans` +
`_sheet_passes`) is an envelope correlation of the text's claimed spans against the stem's activity: the
sheet-span null the envelope thresholds were first calibrated on. This script is that gate's calibration,
run through the SHIPPED functions, for every case `e2e.py --level run_align --modes all` would run (the 13
timed modes; `blind` has no spans), with the claims SERVED as the run_align ports serve them
(`clean_segments`), in two shapes:

  * `caption` — the served segments themselves (authored captions: each line has its own end);
  * `lrc`     — parse_lrc's shape (each line ends at the next line's start; the last line has no end),
                because LRCLIB is what production line-syncs most and its spans tile the song.

Per shape it prints how many wrong texts (`wrongtext`, K donors per song) and right texts pass, the truth
row, and the old literal gate (the three envelope tiers over the raw spans) for comparison. Measured at W1
(2026-09-27, youtube tfr stems): caption 0/320 wrong, 241/416 right, truth 28/32; lrc 2/320, 163/416,
22/32; the literal gate 3/320 and 31/320.

`--target mix` gates each song's MIX instead, as a song with no vocals stem would be (W1 review r1):
caption 3/320 wrong, 39/416 right, truth 8/32; lrc 3/320, 37/416, 3/32; the literal gate 6/320 and
100/416, 52/320 and 220/416. The best (r, lag) threshold at <= 3/320 wrong keeps 60/416 right (r >= 0.30
within ±0.1 s): truth r has median 0.33 on the mix, the wrong texts 0.17 with a top decile at 0.32. Which is
why `syncMode=lines` on a stemless song is aligned as forced (`workflows/align._sync_mode_note`).
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
try:
    import encore_worker  # noqa: F401 - probe: the worker venv normally has it installed
except ImportError:  # pragma: no cover - only when run with a python that lacks the editable install
    sys.path.insert(0, str(REPO / "worker"))

import e2e_lib as lib  # noqa: E402 - after the path setup above

from encore_worker.domain.document import Segment  # noqa: E402
from encore_worker.domain.lyrics.clean import clean_segments  # noqa: E402
from encore_worker.steps import align_steps  # noqa: E402

SHAPES = ("caption", "lrc")


def lrc_shaped(served: Sequence[Segment]) -> list[Segment]:
    """`served` as parse_lrc would have produced it: timed lines in time order, each ending at the next."""
    timed = sorted(
        (s for s in served if isinstance(s.get("start"), (int, float))),
        key=lambda s: float(s["start"]),  # type: ignore[arg-type]
    )
    out: list[Segment] = []
    for index, segment in enumerate(timed):
        line: dict[str, object] = {"text": segment.get("text"), "start": segment["start"]}
        if index + 1 < len(timed):
            line["end"] = timed[index + 1]["start"]
        out.append(line)
    return out


def measure_case(signal: Any, served: Sequence[Segment]) -> dict[str, dict[str, object]]:
    """The shipped gate and the literal three-tier gate, over both shapes of one case's claims."""
    from encore_worker.domain.audio import activity  # noqa: PLC0415

    row: dict[str, dict[str, object]] = {}
    for shape, segments in (("caption", list(served)), ("lrc", lrc_shaped(served))):
        fit = activity.fit_sheet_to_audio(signal, 16000, align_steps._sheet_spans(segments))
        raw = activity.fit_sheet_to_audio(signal, 16000, align_steps._timed_spans(segments))
        row[shape] = {
            "r": round(fit.correlation, 4),
            "lag": round(fit.seconds, 2),
            "passes": align_steps._sheet_passes(fit),
            "literal": align_steps._envelope_passes(raw),
        }
    return row


def summarize(rows: Sequence[Mapping[str, Any]]) -> list[str]:
    wrong = [r for r in rows if r["mode"] == "wrongtext"]
    right = [r for r in rows if r["mode"] != "wrongtext"]
    truth = [r for r in right if r["mode"] == "truth"]
    lines = []
    for shape in SHAPES:
        for gate in ("passes", "literal"):

            def count(group: Sequence[Mapping[str, Any]], shape: str = shape, gate: str = gate) -> str:
                return f"{sum(1 for r in group if r[shape][gate])}/{len(group)}"

            lines.append(
                f"{shape:8} {'shipped' if gate == 'passes' else 'literal':8} wrong {count(wrong):>8}  "
                f"right {count(right):>8}  truth {count(truth):>6}"
            )
    return lines


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    ap.add_argument("--out", default=None, help="write every case's r / lag / verdicts here (JSON)")
    ap.add_argument("--songs", default=None, help="comma-separated slugs (default: the whole corpus)")
    ap.add_argument(
        "--target",
        choices=("vocals", "mix"),
        default="vocals",
        help="the audio the gate reads: the stem (default), or the MIX, as a song with no stem is gated",
    )
    args = ap.parse_args(argv)

    import soundfile as sf  # noqa: PLC0415

    from encore_worker.adapters.ml import load_audio_mono_16k  # noqa: PLC0415

    corpus = lib.discover(lib.bench_root())
    chosen = set(args.songs.split(",")) if args.songs else None
    rows: list[dict[str, Any]] = []
    for song in corpus:
        if chosen is not None and song.slug not in chosen:
            continue
        signal = load_audio_mono_16k(str(song.vocals if args.target == "vocals" else song.mix))
        info = sf.info(str(song.vocals))  # the duration the claims are built for, whichever is gated
        duration = info.frames / info.samplerate
        for mode in lib.ALL_MODES:
            if mode == "blind":
                continue
            for variant in range(lib.variants_of(mode)):
                claims = lib.build_claims(song, mode, corpus=corpus, duration_sec=duration, variant=variant)
                served = clean_segments(claims.segments())
                rows.append(
                    {
                        "song": song.slug,
                        "group": song.group,
                        "mode": mode,
                        "variant": variant,
                        **measure_case(signal, served),
                    }
                )
        print(song.slug, file=sys.stderr, flush=True)
    for line in summarize(rows):
        print(line)
    if args.out:
        Path(args.out).write_text(json.dumps(rows), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
