#!/usr/bin/env python
"""The lexical-lift gates' calibration: every bench text's lift on each song's stem (or mix) matrix.

    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/lift_gate.py \\
        [--target stem|mix] [--model NAME] [--corpus C] [--language L] [--songs a,b] [--out|--from f.json]

It fits `lexical.lift`'s bands for both consumers — the LINE_SYNC rung and the global engine's word
documents — over every right and wrong text the bench serves, through the SHIPPED helper and decoder off the
bench's emission cache. Its ninth printed block is THE ROW THIS RUN FITS, or a refusal to pick one where the
populations overlap; `line_sync_min_agreement` comes from `line_gate.py`. A row is one (bundle, LANGUAGE)
pair's, so `--corpus nonlatin --language zh` fits that lane's row off its own songs. LOG.md, "The lexical
calibration rows, exhibit by exhibit" and "W10: the first non-Latin calibration rows".
"""

from __future__ import annotations

import argparse
import json
import math
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

from encore_worker.domain.lyrics import lexical  # noqa: E402
from encore_worker.domain.lyrics.clean import clean_segments  # noqa: E402

#: The text-changing right-text modes. Every other timed mode serves `truth`'s text, and the lift reads none
#: of a text's timings.
RIGHT_MODES = ("truth", "headers", "credit", "extraverse", "drop20", "drop50")
#: The right texts the wrong-text reject-if protects outright ("any right text on a stem refused, including
#: <= 20% missing lines"): all but drop50, which is reported on its own.
PROTECTED = ("truth", "headers", "credit", "extraverse", "drop20")
WRONG_MODES = ("wrongtext", "wrongtext+ownclock")
#: Modes that BORROW another song's lines, so a one-song pool cannot build them at all.
DONOR_MODES = (*WRONG_MODES, "extraverse")
THRESHOLDS = (0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8)
#: The English corpus's two truth kinds: the held-out fit trains on one and scores on the other.
ENGLISH_SPLITS = (lib.JAMENDO, lib.YOUTUBE)
TARGETS = ("stem", "mix")

RESULTS = HERE.parent / "results"
#: The W1 run_align bench's line-synced right texts, as (song, mode): the rung's commits the check must keep.
W1_RUN_ALIGN = RESULTS / "w1-run_align.cases.jsonl"
#: The W1 time_text bench: every case's outcome under the shipped (envelope-only) gate.
W1_TIME_TEXT = (RESULTS / "w1-time_text.cases.jsonl", RESULTS / "w1-ownclock-time_text.cases.jsonl")

#: The groups of the corpus under measurement, set by `main` (`splits_of`).
SPLITS: tuple[str, ...] = ENGLISH_SPLITS

Row = Mapping[str, Any]


def text_mode(mode: str) -> str:
    """The mode whose TEXT `mode` serves: a timing-only mode serves the truth's."""
    ops = set(lib.parse_mode(mode))
    if "wrongtext" in ops:
        return "wrongtext+ownclock" if "ownclock" in ops else "wrongtext"
    return mode if ops & {"headers", "credit", "extraverse", *lib.DROPS} else "truth"


def line_synced(path: Path) -> list[tuple[str, str]]:
    """(song, mode) of every right-text case the W1 run_align bench published through LINE_SYNC."""
    if not path.is_file():
        return []
    out = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        row = json.loads(raw)
        if "wrongtext" not in row["mode"] and "line-sync" in (row.get("published_knobs") or []):
            out.append((str(row["song"]), str(row["mode"])))
    return out


def bench_cases(paths: Sequence[Path]) -> list[dict[str, Any]]:
    """Every case of the W1 time_text bench (song, mode, variant, outcome), for the combination table."""
    return [row for path in paths if path.is_file() for row in lib.read_rows(path)]


def _range(values: Sequence[float]) -> str:
    if not values:
        return "n=0"
    ordered = sorted(values)
    n = len(ordered)
    return (
        f"n={n:3}  min {ordered[0]:+.3f}  p5 {ordered[n // 20]:+.3f}  median {ordered[n // 2]:+.3f}  "
        f"p95 {ordered[(n * 19) // 20]:+.3f}  max {ordered[-1]:+.3f}"
    )


def _lifts(rows: Sequence[Row], modes: Sequence[str], split: str | None = None) -> list[float]:
    return [
        float(r["lift"])
        for r in rows
        if r["lift"] is not None and r["mode"] in modes and (split is None or r["group"] == split)
    ]


def fitted_tau(rows: Sequence[Row], split: str) -> tuple[float, float, float] | None:
    """(protected right minimum, wrong maximum, tau) on `split`: tau is the midpoint of the gap between the
    two, or the wrong maximum itself when the populations overlap there (nothing wrong passes). None when
    the split holds no song of the run."""
    right = _lifts(rows, PROTECTED, split)
    wrong = _lifts(rows, WRONG_MODES, split)
    if not right or not wrong:
        return None
    low, high = min(right), max(wrong)
    return low, high, (low + high) / 2 if low > high else high


def held_out(rows: Sequence[Row]) -> list[str]:
    if len(SPLITS) < 2:
        # One pool cannot be held out of itself, and fitting on the songs scored reads as a validation.
        return [f"{SPLITS[0]} is a single pool: no held-out split, so the pooled sweep below is the fit"]
    lines = []
    for fit in SPLITS:
        check = next(s for s in SPLITS if s != fit)
        fitted = fitted_tau(rows, fit)
        if fitted is None or fitted_tau(rows, check) is None:
            lines.append(f"fit on {fit}: a split has no song in this run")
            continue
        low, high, tau = fitted
        refused = [
            f"{r['song']}:{r['mode']}"
            for r in rows
            if r["group"] == check and r["mode"] in PROTECTED and r["lift"] is not None and r["lift"] < tau
        ]
        drop50 = sum(1 for v in _lifts(rows, ("drop50",), check) if v < tau)
        passed = {m: sum(1 for v in _lifts(rows, (m,), check) if v >= tau) for m in WRONG_MODES}
        totals = {m: len(_lifts(rows, (m,), check)) for m in WRONG_MODES}
        lines.append(
            f"fit on {fit}: right min {low:+.3f}, wrong max {high:+.3f} -> tau {tau:+.3f}; on {check}: "
            f"right refused {len(refused)}/{len(_lifts(rows, PROTECTED, check))}"
            + (f" ({', '.join(refused[:6])})" if refused else "")
            + f", drop50 refused {drop50}/{len(_lifts(rows, ('drop50',), check))}, wrong passed "
            + ", ".join(f"{m} {passed[m]}/{totals[m]}" for m in WRONG_MODES)
        )
    return lines


def sweep(rows: Sequence[Row]) -> list[str]:
    lines = []
    for tau in THRESHOLDS:
        refused = [f"{r['song']}:{r['mode']}" for r in rows if r["mode"] in RIGHT_MODES and _below(r, tau)]
        protected = sum(1 for r in rows if r["mode"] in PROTECTED and _below(r, tau))
        passed = {m: sum(1 for v in _lifts(rows, (m,)) if v >= tau) for m in WRONG_MODES}
        totals = {m: len(_lifts(rows, (m,))) for m in WRONG_MODES}
        lines.append(
            f"tau {tau:.2f}: right refused {len(refused)}/{len(_lifts(rows, RIGHT_MODES))} "
            f"(protected {protected})"
            + (f" [{', '.join(refused[:5])}{' ...' if len(refused) > 5 else ''}]" if refused else "")
            + "; wrong passed "
            + ", ".join(f"{m} {passed[m]}/{totals[m]}" for m in WRONG_MODES)
        )
    return lines


def _below(row: Row, tau: float) -> bool:
    return row["lift"] is not None and float(row["lift"]) < tau


#: A gate rule over one case: (envelope refused it, its text's lift or None) -> refused.
Rule = Callable[[bool, float | None, float], bool]

RULES: Mapping[str, Rule] = {
    # The shipped W1 gate: the envelope fit of our own decode (blind or repaired) alone.
    "envelope alone": lambda env, _lift, _tau: env,
    # The lift replaces the envelope gate wherever it can measure the text.
    "lift alone": lambda env, lift, tau: lift < tau if lift is not None else env,
    # Both must pass.
    "both required": lambda env, lift, tau: env or (lift is not None and lift < tau),
    # Either is enough.
    "either enough": lambda env, lift, tau: env and (lift is None or lift < tau),
}


def combination(rows: Sequence[Row], cases: Sequence[Row], taus: Sequence[float]) -> list[str]:
    """Each rule over the W1 time_text bench's cases: right cases refused (per text mode), wrong passed."""
    lift = {(r["song"], r["mode"], r["variant"]): r["lift"] for r in rows}
    lines = [f"{len(cases)} W1 time_text cases (their outcome = the envelope gate's)"]
    for tau in taus:
        for name, rule in RULES.items():
            right_refused: dict[str, list[str]] = {}
            wrong_passed: dict[str, int] = dict.fromkeys(WRONG_MODES, 0)
            wrong_total: dict[str, int] = dict.fromkeys(WRONG_MODES, 0)
            right_total = 0
            for case in cases:
                mode = text_mode(str(case["mode"]))
                variant = int(case["variant"]) if mode in WRONG_MODES else 0
                value = lift.get((case["song"], mode, variant))
                refused = rule(case["outcome"] == "refused", value, tau)
                if mode in WRONG_MODES:
                    wrong_total[mode] += 1
                    wrong_passed[mode] += 0 if refused else 1
                else:
                    right_total += 1
                    if refused:
                        right_refused.setdefault(str(case["mode"]), []).append(str(case["song"]))
            count = sum(len(v) for v in right_refused.values())
            protected = sum(len(v) for m, v in right_refused.items() if text_mode(m) in PROTECTED)
            lines.append(
                f"tau {tau:.2f} {name:14}: right refused {count}/{right_total} (protected {protected})"
                + (
                    " ["
                    + "; ".join(
                        f"{m} {','.join(s[:3])}{'…' if len(s) > 3 else ''}" for m, s in right_refused.items()
                    )
                    + "]"
                    if right_refused
                    else ""
                )
                + "; wrong passed "
                + ", ".join(f"{m} {wrong_passed[m]}/{wrong_total[m]}" for m in WRONG_MODES)
            )
    return lines


def mix_floor(rows: Sequence[Row]) -> list[str]:
    """The mix gate as shipped (blind envelope AND lift >= floor), per floor, vs each half alone."""
    env = [r for r in rows if r.get("env_pass") is not None]
    if not env:
        return ["no envelope fits recorded (a --target stem run)"]
    lines = []
    right = [r for r in env if r["mode"] in RIGHT_MODES]
    wrong = [r for r in env if r["mode"] in WRONG_MODES]
    lines.append(
        f"blind envelope alone: right refused {sum(1 for r in right if not r['env_pass'])}/{len(right)}, "
        + ", ".join(
            f"{m} passed {sum(1 for r in wrong if r['mode'] == m and r['env_pass'])}/"
            f"{sum(1 for r in wrong if r['mode'] == m)}"
            for m in WRONG_MODES
        )
    )
    for floor in THRESHOLDS:
        by_lift = [r for r in right if _below(r, floor)]
        by_both = [r for r in right if not r["env_pass"] or _below(r, floor)]
        passed = {
            m: sum(1 for r in wrong if r["mode"] == m and r["env_pass"] and not _below(r, floor))
            for m in WRONG_MODES
        }
        lift_only = {m: sum(1 for r in wrong if r["mode"] == m and not _below(r, floor)) for m in WRONG_MODES}
        lines.append(
            f"floor {floor:.2f}: right refused by the lift {len(by_lift)}, "
            f"by the gate {len(by_both)}/{len(right)}"
            + (f" [{', '.join(f'{r["song"]}:{r["mode"]}' for r in by_lift[:4])}]" if by_lift else "")
            + "; wrong passed the gate "
            + ", ".join(f"{m} {passed[m]}" for m in WRONG_MODES)
            + " (the lift alone "
            + ", ".join(f"{lift_only[m]}" for m in WRONG_MODES)
            + ")"
        )
    return lines


def banded(rows: Sequence[Row], target: str, bands: lexical.Bands) -> list[str]:
    """Each population per band, read off the row of the MODEL this run measured (W4b: `lexical.CALIBRATED` is
    keyed by bundle, so a `--model` run must not be scored against the shipped `en` row)."""
    lines = [f"bands = {bands}"]
    for mode in (*RIGHT_MODES, *WRONG_MODES):
        counts: dict[str, int] = {}
        doubted: list[str] = []
        for r in rows:
            if r["mode"] != mode:
                continue
            got = (
                "unmeasured"
                if r["lift"] is None
                else lexical.band(r["lift"], on_stem=target == "stem", bands=bands).value
            )
            counts[got] = counts.get(got, 0) + 1
            if got == lexical.Band.DOUBT.value:
                doubted.append(f"{r['song']}({r['lift']:+.2f})")
        lines.append(
            f"{mode:20} "
            + ", ".join(f"{k} {v}" for k, v in sorted(counts.items()))
            + (f"  doubt: {', '.join(doubted[:6])}{' ...' if len(doubted) > 6 else ''}" if doubted else "")
        )
    return lines


def summarize(
    rows: Sequence[Row],
    *,
    target: str,
    cases: Sequence[Row],
    synced: Sequence[tuple[str, str]],
    bands: lexical.Bands,
) -> list[str]:
    measured = [r for r in rows if r["lift"] is not None]
    short = [f"{r['song']}:{r['mode']}:{r['variant']} ({r['letters']})" for r in rows if r["lift"] is None]
    lines = [f"== {target}: {len(rows)} texts, {len(measured)} measured"]
    lines.append(
        f"-- unmeasured (under {lexical.MIN_LETTERS} alignable letters, or no order to contrast): "
        f"{len(short)}" + (f" [{', '.join(short[:8])}]" if short else "")
    )
    lines.append("-- populations")
    for mode in (*RIGHT_MODES, *WRONG_MODES):
        lines.append(f"{mode:20} all      {_range(_lifts(rows, (mode,)))}")
        for split in SPLITS:
            lines.append(f"{'':20} {split:8} {_range(_lifts(rows, (mode,), split))}")
    for split in SPLITS:
        right, drop50 = _lifts(rows, PROTECTED, split), _lifts(rows, ("drop50",), split)
        wrong = _lifts(rows, WRONG_MODES, split)
        if right and drop50 and wrong:
            lines.append(
                f"{split}: protected right min {min(right):+.3f}, drop50 min {min(drop50):+.3f}, "
                f"wrong max {max(wrong):+.3f}"
            )
    lines.append("-- held-out (fit tau on one split, score it on the other)")
    lines += held_out(rows)
    lines.append("-- pooled sweep")
    lines += sweep(rows)
    if target == "stem":
        lines.append("-- the lift with the shipped envelope gate (W1 time_text cases)")
        taus = sorted({bands.refuse_below, 0.2})
        lines += combination(rows, cases, taus) if cases else ["no W1 time_text cases found"]
    else:
        lines.append("-- the mix gate: blind envelope AND lift >= floor")
        lines += mix_floor(rows)
    lines.append("-- the bands being scored against")
    lines += banded(rows, target, bands)
    lines.append("-- the truth texts' blind decode, per band")
    lines += timing_by_band(rows, target, bands)
    lines.append("-- THE ROW THIS RUN FITS (the procedure in `lexical`'s docstring, on the 0.05 grid)")
    lines += fitted(rows, target)
    if target == "stem":
        index = {(r["song"], r["mode"]): r["lift"] for r in rows if r["variant"] == 0}
        for song, mode in synced:
            got = index.get((song, text_mode(mode)))
            lines.append(
                f"W1 line-synced {song} {mode}: lift {'unmeasured' if got is None else f'{got:+.3f}'}"
            )
    return lines


#: The grid every calibrated threshold is rounded onto, so a band is a number a person can read and a redraw
#: of the shuffles (SD 0.03-0.07, `lexical`'s REDRAW NOISE) cannot move it.
GRID = 0.05

#: Slack when rounding onto `GRID`, because these are binary floats: `0.60 / 0.05` is 11.999999999999998, so a
#: bare floor sends a midpoint that sits EXACTLY on the grid down a whole step (0.60 -> 0.55). A billionth of
#: a step is nine orders below anything a calibration can distinguish and nine above the representation error.
_GRID_SLACK = 1e-9


def _down(value: float) -> float:
    """`value` floored onto `GRID` (see `_GRID_SLACK`)."""
    return math.floor(value / GRID + _GRID_SLACK) * GRID


def _up(value: float) -> float:
    """`value` raised onto `GRID`."""
    return math.ceil(value / GRID - _GRID_SLACK) * GRID


def fitted(rows: Sequence[Row], target: str) -> list[str]:
    """The calibration row THESE rows imply, ready to paste into `lexical.CALIBRATED`: this script is the
    procedure, so it prints its answer rather than leaving a reader to do the arithmetic.

    For a STEM, `refuse_below` is the pooled gap's midpoint between the protected right texts' minimum and the
    wrong texts' maximum, rounded DOWN onto `GRID`, and `ok_from` the smallest step above the weakest drop50,
    never above the weakest PROTECTED right text; overlapping populations meet no reject-if, so such a model
    ships with NO ROW. For a MIX, `mix_floor` is the smallest step above both splits' wrong maxima and
    `mix_ok_from` is read off the per-band timing table by a person. The fifth field is `line_gate.py`'s."""
    right = _lifts(rows, PROTECTED) + _lifts(rows, ("drop50",))
    wrong = _lifts(rows, WRONG_MODES)
    if not right or not wrong:
        return ["  no population to fit (this run has no right or no wrong texts)"]
    low, high = min(right), max(wrong)
    out = [f"  right min (protected + drop50) {low:+.4f}   wrong max {high:+.4f}   gap {low - high:+.4f}"]
    if target == "mix":
        maxima = [got for split in SPLITS if (got := _lifts(rows, WRONG_MODES, split))]
        floor = _down(max(max(m) for m in maxima)) + GRID if maxima else None
        out.append(
            f"  -> mix_floor={floor:.2f} (the smallest {GRID} step above every split's wrong max: "
            + ", ".join(f"{max(m):+.4f}" for m in maxima)
            + "); mix_ok_from from the per-band table above"
        )
        # AND THE MIX HEAD-ROOM, printed exactly as the stem's is (W4b review r1). It was the one margin no
        # row stated, and it is the margin that matters MOST: on a stemless song this floor is the wrong-text
        # verdict and a refusal there is terminal, where a stem's floor has the mix path behind it. The row
        # that exposed the gap is HuBERT-XLarge's, whose +0.1479 wrong maximum leaves **+0.0021** under the
        # shipped 0.15 — a twentieth of one redraw SD — against the base row's +0.0349 and HuBERT-L's +0.0343.
        if floor is not None:
            # HALF A GRID STEP is the band worth counting: it is the margin a floor one step lower would have
            # had to clear, so "how many wrong texts sit in the half-step under the floor" says whether the
            # margin is one text's luck (XL: 3) or a whole population's distance (base and L: 0).
            near = floor - GRID / 2
            over = sorted((value for m in maxima for value in m if value >= near), reverse=True)
            out.append(
                f"  Head-room over the wrong population: {floor - high:+.4f}"
                f"   wrong texts at or above {near:.4f}: {len(over)}"
                + (" (" + ", ".join(f"{value:+.4f}" for value in over[:5]) + ")" if over else "")
            )
        return out
    if low <= high:
        out.append(
            "  -> NO THRESHOLD: the populations OVERLAP, so nothing meets the wrong-text reject-if. This "
            "model gets no row (refuse to gate), and the wave says so."
        )
        return out
    refuse = _down((low + high) / 2)
    fits = [fit[2] for split in SPLITS if (fit := fitted_tau(rows, split)) is not None]
    doubtable = _lifts(rows, ("drop50",))
    protected = _lifts(rows, PROTECTED)
    # The band holds the right texts the reject-if does not protect and stops below the weakest protected one;
    # `_down` on that cap keeps it on the grid, and `refuse + GRID` keeps the band non-empty.
    ok = (
        min(_down(min(doubtable)) + GRID, _down(min(protected))) if doubtable and protected else refuse + GRID
    )
    out.append(
        f"  -> refuse_below={refuse:.2f}, ok_from={max(ok, refuse + GRID):.2f} "
        f"(midpoint {(low + high) / 2:+.4f} rounded down; the step above the weakest drop50 "
        f"{min(doubtable):+.4f} if any, capped at the weakest protected right text "
        f"{min(protected):+.4f}; the splits' own fits, which this rule is NOT, are "
        + ", ".join(f"{value:+.4f}" for value in fits)
        + "). Head-room over the wrong population: "
        f"{refuse - high:+.4f}"
    )
    return out


def blind_timing(song: lib.Song, claims: lib.Claims, lines: Sequence[Any]) -> dict[str, Any]:
    """How well the truth text's BLIND decode (no claims, no repair) is timed: the fraction of its lines
    starting within 1 s of the truth, and how many are over 2 s off. Each decoded line is paired back
    through the lines `clean_segments` kept, read off `clean_indexed` — which drops a NON-LYRIC row as well
    as an empty one, so a `clean_line` filter shifted the pairing (`line_gate.measure` carries the case)."""
    from encore_worker.domain.lyrics.clean import clean_indexed  # noqa: PLC0415

    at = [index for index, _segment in clean_indexed(claims.segments())]
    kept = [claims.lines[index].truth for index in at]
    errors = [abs(ln.start - song.truth[kept[ln.index]].start) for ln in lines if kept[ln.index] is not None]
    return {
        "blind_pm1": round(sum(e <= 1.0 for e in errors) / len(errors), 4) if errors else None,
        "blind_gross": sum(e > 2.0 for e in errors),
        "blind_lines": len(errors),
    }


def timing_by_band(rows: Sequence[Row], target: str, bands: lexical.Bands) -> list[str]:
    """The truth texts' blind decode timing per lift band: on the mix, the lift reads how well the words
    are HEARD, which is what its doubt band is drawn on (`lexical.Bands.mix_ok_from`)."""
    truth = sorted((r for r in rows if r["mode"] == "truth" and r.get("blind_pm1") is not None), key=_lift_of)
    if not truth:
        return ["no blind timing recorded (a run from before W3)"]
    lines = []
    for name in (b.value for b in lexical.Band):
        inside = [r for r in truth if _band_of(r, target, bands) == name]
        if inside:
            pm1 = sorted(float(r["blind_pm1"]) for r in inside)
            lines.append(
                f"{name:7} n={len(inside):2}  lines within 1 s: median {pm1[len(pm1) // 2]:.0%} "
                f"(min {pm1[0]:.0%})  over 2 s: {sum(int(r['blind_gross']) for r in inside)}/"
                f"{sum(int(r['blind_lines']) for r in inside)}"
            )
    lines += [
        f"  {r['song'][:28]:28} lift {r['lift']:+.3f}  within 1 s {r['blind_pm1']:.0%}  "
        f"over 2 s {r['blind_gross']}/{r['blind_lines']}"
        for r in truth
    ]
    return lines


def _lift_of(row: Row) -> float:
    return float(row["lift"]) if row["lift"] is not None else float("-inf")


def _band_of(row: Row, target: str, bands: lexical.Bands) -> str:
    if row["lift"] is None:
        return "unmeasured"
    return lexical.band(float(row["lift"]), on_stem=target == "stem", bands=bands).value


def _same_language(song: lib.Song, corpus: str, language: str) -> bool:
    """Is `song` one of `language`'s? Every English-corpus song is, the AMLL slugs DECLARE theirs."""
    if corpus != lib.NONLATIN_CORPUS:
        return True
    return lib.nonlatin_language_of(song.slug) == language


def splits_of(corpus: str) -> tuple[str, ...]:
    """The groups a run over `corpus` can hold out across — one for the non-Latin corpus, so `held_out`
    declines rather than fitting and scoring on the same songs."""
    return ENGLISH_SPLITS if corpus != lib.NONLATIN_CORPUS else (lib.NONLATIN,)


def model_name(named: str | None, device: str, language: str = "en", config: Any = None) -> str:
    """The bundle a row set was measured on, RESOLVED — never the placeholder "default" (W3 review r1).

    `CALIBRATED` is keyed by (bundle, language), so a committed row set has to name the pair it can be
    matched to. `--model` absent names what `language` actually loads, THE PER-LANGUAGE STAGE-2 TABLE
    INCLUDED (`e2e.nonlatin_routes`, which is production's own rule).
    """
    import e2e  # noqa: PLC0415 - loads torch, which `--from` never needs

    if named:
        return named
    routed = e2e.nonlatin_routes(config).get(language) if config is not None else None
    return routed or e2e.default_model(language, device)


def measure(args: argparse.Namespace, device: str) -> list[dict[str, Any]]:
    """Decode every text on every selected song's `args.target` matrix (see the module docstring).

    `device` is resolved by the caller, because the bundle an unnamed `--model` means is this device's
    (`model_name`) and the run's rows have to be filed under the name the aligner actually loads."""
    import e2e  # noqa: PLC0415 - loads torch; `--from` never needs it
    import soundfile as sf  # noqa: PLC0415

    from encore_worker.adapters.ml import forced_align_decoder, load_audio_mono_16k  # noqa: PLC0415
    from encore_worker.domain.audio import activity  # noqa: PLC0415
    from encore_worker.domain.lyrics import units  # noqa: PLC0415
    from encore_worker.domain.lyrics.generate import excluded_of, generate  # noqa: PLC0415
    from encore_worker.host.config import Config  # noqa: PLC0415
    from encore_worker.steps import align_lines  # noqa: PLC0415

    root = lib.bench_root()
    corpus = lib.discover(root, corpus=args.corpus)
    config = Config.from_env()
    #: THE UNIT RULE THE LANE SHIPS: with the whitespace rule a CJK line is one token, so a "shuffle" only
    #: reorders lines — the degraded contrast W8 refused to fit off (`lexical.shuffles_of`).
    rules = units.rules_for(args.language, config.align_experiments)
    store = lib.EmissionStore(
        root / "_emissions",
        model=model_name(args.model, device, args.language, config),
        emitter=e2e.emitter_fingerprint(config),
    )
    aligner = e2e.BenchAligner(
        device=device,
        model=args.model,
        nonlatin_routes=e2e.nonlatin_routes(config),
        store=store,
    )
    chosen = set(args.songs.split(",")) if args.songs else None
    #: THE DONOR POOL IS THE RUN'S OWN LANGUAGE: a cross-script wrong text is refused by the script rule
    #: (`lexical.may_time_words`) before a lift reads it, so it is another gate's work, not this one's.
    donors = [song for song in corpus if _same_language(song, args.corpus, args.language)]
    #: One wrong text counted twice is not two this gate separated, and a pool under `WRONG_K` repeats
    #: donors. ONLY on the non-Latin corpus, where the pool is small: the English rows are recorded with
    #: both wrong modes serving the same texts, and dedup would silently re-measure the procedure.
    dedupe = args.corpus == lib.NONLATIN_CORPUS
    if dedupe and len(donors) < 2:
        print(
            f"-- {args.language}: {len(donors)} song(s), so there is NO wrong-text population and no row "
            "can be fitted: this language keeps the line-sync-only rule",
            file=sys.stderr,
        )
    rows: list[dict[str, Any]] = []
    began = time.monotonic()
    for song in corpus:
        if chosen is not None and song.slug not in chosen:
            continue
        if not _same_language(song, args.corpus, args.language):
            continue
        audio = song.vocals if args.target == "stem" else song.mix
        emissions = aligner.emissions(str(audio), args.language)
        info = sf.info(str(song.vocals))  # the duration the claims are built for, as e2e.py builds them
        duration = info.frames / info.samplerate
        signal = load_audio_mono_16k(str(audio)) if args.target == "mix" else None
        seen_donors: set[str] = set()
        for mode in (*RIGHT_MODES, *WRONG_MODES):
            if mode in DONOR_MODES and len(donors) < 2:
                continue
            for variant in range(lib.variants_of(mode)):
                claims = lib.build_claims(song, mode, corpus=donors, duration_sec=duration, variant=variant)
                if mode in WRONG_MODES and dedupe:
                    if claims.donor is None or claims.donor in seen_donors:
                        continue
                    seen_donors.add(str(claims.donor))
                texts = [str(s.get("text") or "") for s in clean_segments(claims.segments())]
                got = lexical.lift(texts, emissions, decoder=forced_align_decoder, units=rules)
                row: dict[str, Any] = {
                    "song": song.slug,
                    "group": song.group,
                    "mode": mode,
                    "variant": variant,
                    "donor": claims.donor,
                    "lift": None if got is None else round(got.value, 4),
                    "per_letter": None if got is None else round(got.per_letter, 4),
                    # The matrix's OWN non-character columns, not a literal 0 (review M9, threaded in W4;
                    # widened to every special in W4b): a recalibration on another bundle must count the
                    # letters THAT bundle's decode publishes, and `excluded_of` is the filter it uses.
                    "letters": len(
                        lexical.letters_of(texts, emissions.dictionary, excluded_of(emissions), rules)
                    ),
                }
                generated = (
                    generate(
                        texts,
                        emissions,
                        decoder=forced_align_decoder,
                        language=args.language,
                        units=rules,
                    )
                    if signal is not None or mode == "truth"
                    else None
                )
                if generated is not None and signal is not None:
                    fit = activity.fit_sheet_to_audio(
                        signal, 16000, [(ln.start, ln.end) for ln in generated.lines]
                    )
                    row["env_pass"] = align_lines._envelope_passes(fit)
                    row["env_r"] = round(fit.correlation, 4)
                    row["env_lag"] = round(fit.seconds, 3)
                if generated is not None and mode == "truth":
                    row.update(blind_timing(song, claims, generated.lines))
                rows.append(row)
        print(f"{song.slug} ({time.monotonic() - began:.0f} s; {dict(aligner.served)})", file=sys.stderr)
    return rows


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    ap.add_argument("--target", choices=TARGETS, default="stem", help="which matrix the texts are lifted on")
    ap.add_argument("--model", default=None, help="torchaudio bundle (default: this device's shipped one)")
    ap.add_argument("--corpus", choices=lib.CORPORA, default=lib.ENGLISH_CORPUS, help="which song set")
    ap.add_argument("--language", default="en", help="the language whose row is fitted, ONE a run")
    ap.add_argument("--out", default=None, help="write every text's lift here (JSON)")
    ap.add_argument("--from", dest="source", default=None, help="summarize a stored --out instead")
    ap.add_argument("--songs", default=None, help="comma-separated slugs (default: the whole corpus)")
    ap.add_argument("--device", default=None, help="the emission model's device on a cache miss")
    args = ap.parse_args(argv)
    warnings.filterwarnings("ignore", message=r".*forced_align has been deprecated.*")
    warnings.filterwarnings("ignore", message=r"(?s).*torchcodec is not installed correctly.*")

    global SPLITS  # noqa: PLW0603 - which groups this corpus has is one fact every block reads
    if args.corpus == lib.NONLATIN_CORPUS and args.language == "en" and not args.source:
        print(
            f"--corpus {lib.NONLATIN_CORPUS} needs --language (zh / ja / ko), ONE a run: left at 'en' these "
            "songs would be lifted on the English bundle, whose row is not this lane's",
            file=sys.stderr,
        )
        return 2
    if args.source:
        stored = json.loads(Path(args.source).read_text(encoding="utf-8"))
        rows: list[dict[str, Any]] = list(stored["rows"])
        target = str(stored["target"])
        # THE SETUP THESE ROWS WERE MEASURED ON, not this invocation's flags: scoring a stored set under
        # another corpus or language reads one lane's rows as another's. The (model, language) pair with no
        # row is what this script exists to fit; it scores against the shipped row as a stated REFERENCE.
        args.corpus = str(stored.get("corpus", lib.ENGLISH_CORPUS))
        args.language = str(stored.get("language", "en"))
        asked = str(stored["model"])
    else:
        import e2e  # noqa: PLC0415 - loads torch; `--from` never needs it

        from encore_worker.host.config import Config  # noqa: PLC0415

        device = e2e.resolve_device(args.device)
        asked = model_name(args.model, device, args.language, Config.from_env())
        rows = measure(args, device)
        target = args.target
        if args.out:
            body = {
                "target": target,
                "model": asked,
                "corpus": args.corpus,
                "language": args.language,
                "rows": rows,
            }
            Path(args.out).write_text(json.dumps(body), encoding="utf-8")
    SPLITS = splits_of(args.corpus)
    bands = lexical.CALIBRATED.get((asked, args.language))
    if bands is None:
        print(
            f"-- {asked}/{args.language} has no calibration row: the band tables below are scored against "
            f"{lexical.BANDS.model}/{lexical.BANDS.language}'s as a REFERENCE. THE ROW THIS RUN FITS is "
            "printed at the end.",
            file=sys.stderr,
        )
        bands = lexical.BANDS
    # The combination table reads the English bench's cases one by one, so on another song set every
    # lookup would miss and the table would read all-zero.
    english = args.corpus != lib.NONLATIN_CORPUS
    for line in summarize(
        rows,
        target=target,
        cases=bench_cases(W1_TIME_TEXT) if english else [],
        synced=line_synced(W1_RUN_ALIGN) if english else [],
        bands=bands,
    ):
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
