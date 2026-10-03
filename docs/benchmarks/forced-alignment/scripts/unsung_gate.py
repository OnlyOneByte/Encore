#!/usr/bin/env python
"""The never-sung rule's calibration: its three signals per line, and every candidate floor priced end to end.

    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/unsung_gate.py \\
        [--target stem|mix] [--model NAME] [--songs a,b] [--modes truth,credit,...] \\
        [--out rows.json] [--from rows.json]

It runs the shipped two-round drop loop under each candidate floor and scores what survives against truth,
which is the only way to see the rule's real cost: a dropped line is one the metrics no longer see, a spared
one is a line the decode may have put seconds away. BLIND deliberately, and on a STEM by default, which is the
target every committed row was measured on. What it prints, and why `--target mix` is the open case: README,
"The harness scripts" and "The never-sung rule: the two lines no floor can separate".
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import warnings
from collections.abc import Callable, Mapping, Sequence
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

from encore_worker.domain.lyrics.clean import clean_line, clean_segments  # noqa: E402

#: The modes worth running: the right texts whose own lines the rule may drop, plus the three that INJECT a
#: line it should drop (`credit`, `headers`, `extraverse`). Every timing-only mode serves `truth`'s text and
#: the rule reads no claim, so it would decode the same document.
MODES = ("truth", "credit", "headers", "extraverse", "drop20", "drop50")

#: Absolute floors swept. 0.00 is the RULE OFF (no line's level is below it), which prices the rule itself.
ABSOLUTE = (0.10, 0.06, 0.05, 0.04, 0.03, 0.02, 0.00)

#: Quantiles of the song's own inter-line gap levels, swept both capped at the shipped floor (so the rule can
#: only ever spare a line, never drop a new one) and raw.
QUANTILES = (0.1, 0.25, 0.5)

#: A line is worth RECORDING when the two signals that do not depend on the floor already hold and its level
#: is anywhere near the floors swept. Well above every floor, so the committed rows carry the whole population
#: a re-read could want, and far below a sung line's level (the corpus's medians are 0.53-0.68).
CANDIDATE_ENV = 0.35

Row = Mapping[str, Any]


def quantile(values: Sequence[float], q: float) -> float | None:
    """The `q`-quantile by nearest rank (`line_gate`'s own convention), or None for an empty population."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))]


def floors(shipped: float) -> dict[str, Callable[[Sequence[float]], float]]:
    """Every candidate floor as `gap levels -> floor`. `shipped` is `align_steps._NEVER_SUNG_ENV`, which is
    both a swept value and the cap on the relative rules."""

    def absolute(level: float) -> Callable[[Sequence[float]], float]:
        return lambda _gaps: level

    def relative(q: float, cap: float) -> Callable[[Sequence[float]], float]:
        """The song's own `q`-quantile gap level, at most `cap`. A song with no readable gap keeps `shipped`:
        a floor read off nothing must not be a floor of 0, which would turn the rule off silently."""

        def rule(gaps: Sequence[float]) -> float:
            got = quantile(gaps, q)
            return shipped if got is None else min(cap, got)

        return rule

    out: dict[str, Callable[[Sequence[float]], float]] = {}
    for level in ABSOLUTE:
        out[f"abs-{level:.2f}"] = absolute(level)
    for q in QUANTILES:
        out[f"gapq{q:g}-capped"] = relative(q, shipped)
        out[f"gapq{q:g}-raw"] = relative(q, float("inf"))
    return out


def _fmt(value: float | None, digits: int = 4) -> float | None:
    return None if value is None else round(value, digits)


def measure(args: argparse.Namespace) -> list[dict[str, Any]]:
    """Decode every selected song x mode on its stem matrix and price every floor (module docstring)."""
    import e2e  # noqa: PLC0415 - loads torch; `--from` never needs it
    import numpy as np  # noqa: PLC0415
    import soundfile as sf  # noqa: PLC0415

    from encore_worker.adapters.ml import forced_align_decoder, load_audio_mono_16k  # noqa: PLC0415
    from encore_worker.domain.audio import activity  # noqa: PLC0415
    from encore_worker.domain.lyrics.generate import Generated, generate  # noqa: PLC0415
    from encore_worker.host.config import Config  # noqa: PLC0415
    from encore_worker.steps import align_steps  # noqa: PLC0415

    shipped = align_steps._NEVER_SUNG_ENV
    score_gap, rate_max = align_steps._NEVER_SUNG_SCORE_GAP, align_steps._NEVER_SUNG_RATE
    every = floors(shipped)
    root = lib.bench_root()
    corpus = lib.discover(root)
    config = Config.from_env()
    device = e2e.resolve_device(args.device)
    store = lib.EmissionStore(
        root / "_emissions",
        model=model_name(args.model, device),
        emitter=e2e.emitter_fingerprint(config),
    )
    aligner = e2e.BenchAligner(device=device, model=args.model, store=store)
    chosen = set(args.songs.split(",")) if args.songs else None
    modes = args.modes.split(",")
    #: The align TARGET, as `e2e.py --no-stem` names it: the vocals stem, or the MIX of a stemless song, which
    #: is the target review L2's objection is about (module docstring, ON A STEM BY DEFAULT).
    on_mix = args.target == lib.STEMLESS_TARGET
    rows: list[dict[str, Any]] = []
    began = time.monotonic()
    for song in corpus:
        if chosen is not None and song.slug not in chosen:
            continue
        target = song.mix if on_mix else song.vocals
        emissions = aligner.emissions(str(target), "en")
        signal = load_audio_mono_16k(str(target))
        env = activity.envelope(signal, 16000)
        duration = sf.info(str(target)).frames / sf.info(str(target)).samplerate

        def level(start: float, end: float, env: Any = env) -> float:
            """`align_steps`' own read: the envelope's mean over the span, at least one frame wide."""
            first = int(start / activity.HOP_SEC)
            last = max(int(end / activity.HOP_SEC), first + 1)
            window = env[max(0, first) : min(last, len(env))]
            return float(window.mean()) if len(window) else 0.0

        for mode in modes:
            claims = lib.build_claims(song, mode, corpus=corpus, duration_sec=duration, variant=0)
            texts = [str(segment.get("text") or "") for segment in clean_segments(claims.segments())]
            # `generate` keys a Line on its POSITION in the texts it was handed and `clean_segments` drops a
            # line that cleans to nothing, so the truth index of position i is the i-th KEPT claim line.
            kept = [line for line in claims.lines if clean_line(line.text)]
            truth_of = {
                index: song.truth[line.truth].start
                for index, line in enumerate(kept)
                if line.truth is not None and line.truth < len(song.truth)
            }
            base = generate(texts, emissions, decoder=forced_align_decoder, language="en")

            def loop(
                floor: float,
                base: Generated = base,
                texts: Sequence[str] = texts,
                emissions: Any = emissions,
                truth_of: Mapping[int, float] = truth_of,
            ) -> dict[str, Any]:
                """`align_steps`' two-round drop loop at `floor`, with no claims and no spare arm."""
                active, got, dropped = list(texts), base, []
                for _round in range(2):
                    if len(got.lines) < 4:
                        break
                    median = float(np.median([line.score for line in got.lines]))
                    never = [
                        line
                        for line in got.lines
                        if line.score < median - score_gap
                        and level(line.start, line.end) < floor
                        and len(line.text) / max(line.end - line.start, 1e-6) < rate_max
                    ]
                    if not never:
                        break
                    for line in never:
                        active[line.index] = ""
                        dropped.append(line.index)
                    got = generate(active, emissions, decoder=forced_align_decoder, language="en")
                    if not got.lines:
                        break
                errors = {
                    line.index: line.start - truth_of[line.index]
                    for line in got.lines
                    if line.index in truth_of
                }
                return {
                    "dropped": sorted(dropped),
                    "dropped_real": sorted(i for i in dropped if i in truth_of),
                    "dropped_fake": sorted(i for i in dropped if i not in truth_of),
                    "scored": len(errors),
                    "w500": sum(1 for e in errors.values() if abs(e) <= 0.5),
                    "w1000": sum(1 for e in errors.values() if abs(e) <= 1.0),
                    "gross": sum(1 for e in errors.values() if abs(e) > 2.0),
                }

            median_score = float(np.median([line.score for line in base.lines])) if base.lines else 0.0
            ordered = sorted(base.lines, key=lambda line: line.start)
            gaps = [
                level(before.end, after.start)
                for before, after in zip(ordered, ordered[1:], strict=False)
                if after.start > before.end
            ]
            outcomes: dict[str, Any] = {}
            by_floor: dict[float, dict[str, Any]] = {}
            for name, rule in every.items():
                floor = rule(gaps)
                if floor not in by_floor:  # rules that agree on a song cost one run between them
                    by_floor[floor] = loop(floor)
                outcomes[name] = {"floor": round(floor, 4), **by_floor[floor]}
            rows.append(
                {
                    "song": song.slug,
                    "group": song.group,
                    "mode": mode,
                    "median_score": round(median_score, 4),
                    "in_truth": len(truth_of),
                    "lines": len(base.lines),
                    "gaps": len(gaps),
                    "gap_q10": _fmt(quantile(gaps, 0.1)),
                    "gap_q25": _fmt(quantile(gaps, 0.25)),
                    "gap_median": _fmt(quantile(gaps, 0.5)),
                    "candidates": [
                        {
                            "index": line.index,
                            "text": line.text[:40],
                            "env": round(level(line.start, line.end), 4),
                            "score_gap": round(line.score - median_score, 3),
                            "rate": round(len(line.text) / max(line.end - line.start, 1e-6), 3),
                            "start": round(line.start, 2),
                            "end": round(line.end, 2),
                            "real": line.index in truth_of,
                            "error": (
                                None
                                if line.index not in truth_of
                                else round(line.start - truth_of[line.index], 3)
                            ),
                        }
                        for line in base.lines
                        if line.score < median_score - score_gap
                        and len(line.text) / max(line.end - line.start, 1e-6) < rate_max
                        and level(line.start, line.end) < CANDIDATE_ENV
                    ],
                    "rules": outcomes,
                }
            )
            print(f"{song.slug} {mode} ({time.monotonic() - began:.0f} s)", file=sys.stderr)
    return rows


def gap_table(rows: Sequence[Row]) -> list[str]:
    """Per song (one mode's rows), the inter-line gap levels a relative floor would be read off."""
    seen: dict[str, Row] = {}
    for row in rows:
        seen.setdefault(str(row["song"]), row)
    out = []
    for song, row in seen.items():
        out.append(
            f"  {song[:30]:30} n={row['gaps']:3}  q10 {row['gap_q10']}  q25 {row['gap_q25']}  "
            f"median {row['gap_median']}"
        )
    for key in ("gap_q10", "gap_q25", "gap_median"):
        values = sorted(float(r[key]) for r in seen.values() if r[key] is not None)
        if values:
            above = sum(1 for v in values if v >= 0.10)
            out.append(
                f"  {key:10} min {values[0]:.3f} median {values[len(values) // 2]:.3f} "
                f"max {values[-1]:.3f}; >= 0.10 on {above} of {len(values)} songs"
            )
    return out


def candidates(rows: Sequence[Row], shipped: float) -> list[str]:
    """The three signals' population, split real vs injected: what any floor has to sort."""
    out = []
    for real in (True, False):
        got = [
            (row, line)
            for row in rows
            for line in row["candidates"]
            if bool(line["real"]) is real and float(line["env"]) < shipped
        ]
        levels = sorted(float(line["env"]) for _row, line in got)
        out.append(
            f"  {'REAL (a truth line)' if real else 'INJECTED (the mode added it)':30} "
            f"n={len(got):3}" + (f"  env {levels[0]:.4f}..{levels[-1]:.4f}" if levels else "")
        )
        for row, line in sorted(got, key=lambda pair: -float(pair[1]["env"]))[:24]:
            out.append(
                f"    {str(row['song'])[:26]:26} {str(row['mode']):10} [{line['index']:3}] "
                f"env {float(line['env']):.4f} gap {float(line['score_gap']):+.2f} "
                f"rate {float(line['rate']):.2f} span {float(line['start']):.1f}-{float(line['end']):.1f} "
                f"err {line['error']} {str(line['text'])[:32]!r}"
            )
    return out


def priced(rows: Sequence[Row]) -> list[str]:
    """One row per floor rule over every case: what it drops and what the surviving documents score."""
    names = list(rows[0]["rules"]) if rows else []
    out = [
        f"  {'rule':18} {'realDrop':>8} {'fakeDrop':>8} {'scored':>7} {'±500':>6} {'±1s':>6} "
        f"{'gross':>6} {'moved':>6}"
    ]
    for name in names:
        totals = dict.fromkeys(("real", "fake", "scored", "w500", "w1000", "gross", "moved"), 0)
        for row in rows:
            got, shipped = row["rules"][name], row["rules"][f"abs-{ABSOLUTE[0]:.2f}"]
            totals["real"] += len(got["dropped_real"])
            totals["fake"] += len(got["dropped_fake"])
            for key in ("scored", "w500", "w1000", "gross"):
                totals[key] += int(got[key])
            totals["moved"] += int(got["dropped"] != shipped["dropped"])
        out.append(
            f"  {name:18} {totals['real']:8} {totals['fake']:8} {totals['scored']:7} {totals['w500']:6} "
            f"{totals['w1000']:6} {totals['gross']:6} {totals['moved']:6}"
        )
    return out


def summarize(rows: Sequence[Row], shipped: float, target: str = lib.STEM_TARGET) -> list[str]:
    lines = [
        f"== {len(rows)} song-modes; shipped floor {shipped}; target {target}"
        + ("" if target == lib.STEM_TARGET else "  (review L2's case: the floor may be a no-op here)")
    ]
    lines.append("-- the song's own inter-line gap levels (what a relative floor reads)")
    lines += gap_table(rows)
    lines.append(f"-- the three signals' candidate lines under the shipped floor {shipped}")
    lines += candidates(rows, shipped)
    lines.append("-- every floor priced through the shipped two-round loop (abs-0.00 = the rule OFF)")
    lines += priced(rows)
    return lines


def model_name(named: str | None, device: str) -> str:
    """The bundle a row set was measured on, RESOLVED — see `lift_gate.model_name` (W3 review r1; an unnamed
    `--model` is `device`'s shipped bundle since W4b)."""
    import e2e  # noqa: PLC0415 - loads torch, which `--from` never needs

    return named or e2e.default_model("en", device)


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    ap.add_argument("--model", default=None, help="torchaudio bundle (default: this device's shipped one)")
    ap.add_argument(
        "--target",
        choices=(lib.STEM_TARGET, lib.STEMLESS_TARGET),
        default=lib.STEM_TARGET,
        help="the align target: the vocals stem, or the mix of a stemless song (review L2's case)",
    )
    ap.add_argument("--out", default=None, help="write every case's measurements here (JSON)")
    ap.add_argument("--from", dest="source", default=None, help="summarize a stored --out instead")
    ap.add_argument("--songs", default=None, help="comma-separated slugs (default: the whole corpus)")
    ap.add_argument("--modes", default=",".join(MODES), help="comma-separated claim modes")
    ap.add_argument("--device", default=None, help="the emission model's device on a cache miss")
    args = ap.parse_args(argv)
    warnings.filterwarnings("ignore", message=r".*forced_align has been deprecated.*")
    warnings.filterwarnings("ignore", message=r"(?s).*torchcodec is not installed correctly.*")

    if args.source:
        stored = json.loads(Path(args.source).read_text(encoding="utf-8"))
        rows: list[dict[str, Any]] = list(stored["rows"])
        shipped = float(stored["floor"])
        # The W4b rows predate the field and are all stem, which is exactly what the default says.
        target = str(stored.get("target") or lib.STEM_TARGET)
    else:
        import e2e  # noqa: PLC0415 - loads torch; `--from` never needs it

        from encore_worker.steps import align_steps  # noqa: PLC0415

        shipped = align_steps._NEVER_SUNG_ENV
        target = str(args.target)
        rows = measure(args)
        if args.out:
            named = model_name(args.model, e2e.resolve_device(args.device))
            # `target` on the row set, for the same reason `model` is on it: a mix sweep and a stem sweep
            # measure different audio against the same truth, and the floor's verdict differs between them
            # (review L2). Absent on the W4b rows, which are all stem — `summarize` says so.
            body = {"model": named, "floor": shipped, "target": args.target, "rows": rows}
            Path(args.out).write_text(json.dumps(body), encoding="utf-8")
    for line in summarize(rows, shipped, target):
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
