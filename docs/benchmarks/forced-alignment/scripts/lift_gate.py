#!/usr/bin/env python
"""The lexical-lift gates' calibration: every bench text's lift on each song's stem (or mix) matrix.

    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/lift_gate.py \\
        [--target stem|mix] [--model NAME] [--songs a,b] [--out rows.json] [--from rows.json]

WHAT IT CALIBRATES. `domain.lyrics.lexical.lift` — the text's forced-path log-probability against the best
of three seeded shuffles of its own words, per letter — gates two things:

  * the LINE_SYNC rung (W1 review r2, `align_steps._time_line_sync`, which reads `lexical.BANDS` too): a
    text at the rung must lift, so a same-video caption track in other words (a translation) cannot
    line-sync;
  * the GLOBAL engine's word documents (W3, review §3 item 4 / H3, `lexical.BANDS`): refuse / doubt / ok
    bands on a stem, where the lift REPLACES the envelope gate, because that gate scores OUR OWN decode, which
    the audio pulls onto the voiced frames whatever the text (152/320 wrong texts passed it at W1); and doubt
    / ok bands on the mix, whose floor only GRADES by default (W3 review r1: it refuses 7 of 32 truth texts
    there) and refuses under `h3-mix-floor` / `h3-mix-lift-alone`.

Both through the SHIPPED helper and decoder (`adapters.ml.forced_align_decoder`), over:

  * every text a right-text case serves (`truth` — which every offset, tempo, jitter and blind mode also
    serves, since the lift reads no timing — `headers`, `credit`, `extraverse`, `drop20`, `drop50`);
  * every wrong text (`wrongtext`, K donors per song) and every same-video wrong-words text
    (`wrongtext+ownclock`: the donor's words on this song's own truth clock, `e2e_lib._own_clock`).

Texts are served as the text adapters serve them (`clean_segments`). Matrices come from the bench's emission
cache (`e2e.BenchAligner`, the key `e2e.py` uses), so a warm stem run is decodes only; `--target mix` pays one
model pass per song the first time (then cached). `--target mix` also records each text's BLIND envelope fit
(generate, then `activity.fit_sheet_to_audio` on the mix signal, `align_steps._envelope_passes`): the half of
the shipped mix gate that reads no claims (the gate passes if the blind OR the repaired fit does, so this
under-counts passes a repair could add; `blind`-mode texts have no repairs at all).

WHAT IT PRINTS (the procedure W3 calibrated by; W4's HuBERT recalibration is `--model <bundle>` re-run):

  1. each population's range per split (Jamendo: measured truth; YouTube + tfr: authored captions);
  2. the texts too short to measure (under `lexical.MIN_LETTERS` alignable letters);
  3. the HELD-OUT check: tau fitted on one split (the midpoint of that split's gap between the wrong texts'
     maximum and the protected right texts' minimum) and scored on the other, both ways;
  4. pass counts per threshold, pooled;
  5. (stem) how the lift COMBINES with the shipped envelope gate, case by case over the W1 `time_text`
     bench (`results/w1-time_text.cases.jsonl` + `w1-ownclock-time_text.cases.jsonl`, whose outcomes ARE
     the envelope gate's): envelope alone, lift alone, both required, either enough;
     (mix) the blind envelope with the lift floor, per floor;
  6. the bands as shipped (`lexical.BANDS`): each population per band;
  7. the truth texts' BLIND decode timing per band (lines within 1 s of truth, lines over 2 s off): on the
     mix the lift reads how well the words are heard, which is what the mix doubt band is drawn on;
  8. the W1 run_align bench's line-synced right texts (the LINE_SYNC rung's 16 commits) and their lift.

`--from rows.json` re-prints the summary from a stored run without decoding anything.

Measured at W1 review r2 (2026-09-28, base model, youtube tfr stems, 367 s): right texts +0.255..+4.34
(truth +0.47), wrongtext -0.21..+0.19, wrongtext+ownclock -0.23..+0.14; the rung's floor 0.2. W3
(2026-09-28, the same tree's shipped decoder, all 64 matrices from disk): the stem run reproduces every W1
number (359 s); the mix run, envelope fits included, 508 s. W3's numbers (both targets, the held-out check,
the combination, the mix envelope) are in `lexical`'s module docstring, the rows in
`results/w3-lift-{stem,mix}.json` (`--from` re-prints either).
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

from encore_worker.domain.lyrics import lexical  # noqa: E402
from encore_worker.domain.lyrics.clean import clean_segments  # noqa: E402

#: The text-changing right-text modes. Every other timed mode serves `truth`'s text, and the lift reads none
#: of a text's timings.
RIGHT_MODES = ("truth", "headers", "credit", "extraverse", "drop20", "drop50")
#: The right texts review §3.4's reject-if protects outright ("any right text on a stem refused, including
#: <= 20% missing lines"): all but drop50, which is reported on its own.
PROTECTED = ("truth", "headers", "credit", "extraverse", "drop20")
WRONG_MODES = ("wrongtext", "wrongtext+ownclock")
THRESHOLDS = (0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.8)
SPLITS = (lib.JAMENDO, lib.YOUTUBE)
TARGETS = ("stem", "mix")

RESULTS = HERE.parent / "results"
#: The W1 run_align bench's line-synced right texts, as (song, mode): the rung's commits the check must keep.
W1_RUN_ALIGN = RESULTS / "w1-run_align.cases.jsonl"
#: The W1 time_text bench: every case's outcome under the shipped (envelope-only) gate.
W1_TIME_TEXT = (RESULTS / "w1-time_text.cases.jsonl", RESULTS / "w1-ownclock-time_text.cases.jsonl")

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


def banded(rows: Sequence[Row], target: str) -> list[str]:
    """Each population per shipped band (`lexical.band`)."""
    lines = [f"lexical.BANDS = {lexical.BANDS}"]
    for mode in (*RIGHT_MODES, *WRONG_MODES):
        counts: dict[str, int] = {}
        doubted: list[str] = []
        for r in rows:
            if r["mode"] != mode:
                continue
            got = (
                "unmeasured" if r["lift"] is None else lexical.band(r["lift"], on_stem=target == "stem").value
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
    rows: Sequence[Row], *, target: str, cases: Sequence[Row], synced: Sequence[tuple[str, str]]
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
        taus = sorted({lexical.BANDS.refuse_below, 0.2})
        lines += combination(rows, cases, taus) if cases else ["no W1 time_text cases found"]
    else:
        lines.append("-- the mix gate: blind envelope AND lift >= floor")
        lines += mix_floor(rows)
    lines.append("-- shipped bands")
    lines += banded(rows, target)
    lines.append("-- the truth texts' blind decode, per band")
    lines += timing_by_band(rows, target)
    if target == "stem":
        index = {(r["song"], r["mode"]): r["lift"] for r in rows if r["variant"] == 0}
        for song, mode in synced:
            got = index.get((song, text_mode(mode)))
            lines.append(
                f"W1 line-synced {song} {mode}: lift {'unmeasured' if got is None else f'{got:+.3f}'}"
            )
    return lines


def blind_timing(song: lib.Song, claims: lib.Claims, lines: Sequence[Any]) -> dict[str, Any]:
    """How well the truth text's BLIND decode (no claims, no repair) is timed: the fraction of its lines
    starting within 1 s of the truth, and how many are over 2 s off. Each decoded line is paired back to its
    truth line through the lines `clean_segments` kept (it drops a line whose text cleans to nothing)."""
    from encore_worker.domain.lyrics.clean import clean_line  # noqa: PLC0415

    kept = [line.truth for line in claims.lines if clean_line(line.text)]
    errors = [abs(ln.start - song.truth[kept[ln.index]].start) for ln in lines if kept[ln.index] is not None]
    return {
        "blind_pm1": round(sum(e <= 1.0 for e in errors) / len(errors), 4) if errors else None,
        "blind_gross": sum(e > 2.0 for e in errors),
        "blind_lines": len(errors),
    }


def timing_by_band(rows: Sequence[Row], target: str) -> list[str]:
    """The truth texts' blind decode timing per lift band: on the mix, the lift reads how well the words
    are HEARD, which is what its doubt band is drawn on (the module docstring of `lexical`)."""
    truth = sorted((r for r in rows if r["mode"] == "truth" and r.get("blind_pm1") is not None), key=_lift_of)
    if not truth:
        return ["no blind timing recorded (a run from before W3)"]
    lines = []
    for name in (b.value for b in lexical.Band):
        inside = [r for r in truth if _band_of(r, target) == name]
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


def _band_of(row: Row, target: str) -> str:
    if row["lift"] is None:
        return "unmeasured"
    return lexical.band(float(row["lift"]), on_stem=target == "stem").value


def model_name(named: str | None) -> str:
    """The bundle a row set was measured on, RESOLVED — never the placeholder "default" (W3 review r1).

    `lexical.BANDS.model` names a bundle, and the rows the bands were derived from have to be matchable to
    it: when W4 re-runs this script with `--model <hubert>` and replaces `BANDS`, a committed row set saying
    "default" cannot prove which model produced the shipped thresholds. Resolved the way the harness resolves
    the emission cache's key, so both name the same thing.
    """
    import e2e  # noqa: PLC0415 - loads torch, which `--from` never needs

    return named or e2e.default_model("en")


def measure(args: argparse.Namespace) -> list[dict[str, Any]]:
    """Decode every text on every selected song's `args.target` matrix (see the module docstring)."""
    import e2e  # noqa: PLC0415 - loads torch; `--from` never needs it
    import soundfile as sf  # noqa: PLC0415

    from encore_worker.adapters.ml import forced_align_decoder, load_audio_mono_16k  # noqa: PLC0415
    from encore_worker.domain.audio import activity  # noqa: PLC0415
    from encore_worker.domain.lyrics.generate import generate  # noqa: PLC0415
    from encore_worker.host.config import Config  # noqa: PLC0415
    from encore_worker.steps import align_steps  # noqa: PLC0415

    root = lib.bench_root()
    corpus = lib.discover(root)
    config = Config.from_env()
    store = lib.EmissionStore(
        root / "_emissions",
        model=model_name(args.model),
        emitter=e2e.emitter_fingerprint(config),
    )
    aligner = e2e.BenchAligner(device=e2e.resolve_device(args.device), model=args.model, store=store)
    chosen = set(args.songs.split(",")) if args.songs else None
    rows: list[dict[str, Any]] = []
    began = time.monotonic()
    for song in corpus:
        if chosen is not None and song.slug not in chosen:
            continue
        audio = song.vocals if args.target == "stem" else song.mix
        emissions = aligner.emissions(str(audio), "en")
        info = sf.info(str(song.vocals))  # the duration the claims are built for, as e2e.py builds them
        duration = info.frames / info.samplerate
        signal = load_audio_mono_16k(str(audio)) if args.target == "mix" else None
        for mode in (*RIGHT_MODES, *WRONG_MODES):
            for variant in range(lib.variants_of(mode)):
                claims = lib.build_claims(song, mode, corpus=corpus, duration_sec=duration, variant=variant)
                texts = [str(s.get("text") or "") for s in clean_segments(claims.segments())]
                got = lexical.lift(texts, emissions, decoder=forced_align_decoder)
                row: dict[str, Any] = {
                    "song": song.slug,
                    "group": song.group,
                    "mode": mode,
                    "variant": variant,
                    "donor": claims.donor,
                    "lift": None if got is None else round(got.value, 4),
                    "per_letter": None if got is None else round(got.per_letter, 4),
                    # The matrix's own blank, not 0 (review M9, threaded in W4): a recalibration on
                    # another bundle must count the letters THAT bundle's decode publishes.
                    "letters": len(lexical.letters_of(texts, emissions.dictionary, emissions.blank_id)),
                }
                generated = (
                    generate(texts, emissions, decoder=forced_align_decoder, language="en")
                    if signal is not None or mode == "truth"
                    else None
                )
                if generated is not None and signal is not None:
                    fit = activity.fit_sheet_to_audio(
                        signal, 16000, [(ln.start, ln.end) for ln in generated.lines]
                    )
                    row["env_pass"] = align_steps._envelope_passes(fit)
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
    ap.add_argument("--model", default=None, help="torchaudio bundle (default: whisperx's `en` default)")
    ap.add_argument("--out", default=None, help="write every text's lift here (JSON)")
    ap.add_argument("--from", dest="source", default=None, help="summarize a stored --out instead")
    ap.add_argument("--songs", default=None, help="comma-separated slugs (default: the whole corpus)")
    ap.add_argument("--device", default=None, help="the emission model's device on a cache miss")
    args = ap.parse_args(argv)
    warnings.filterwarnings("ignore", message=r".*forced_align has been deprecated.*")
    warnings.filterwarnings("ignore", message=r"(?s).*torchcodec is not installed correctly.*")

    if args.source:
        stored = json.loads(Path(args.source).read_text(encoding="utf-8"))
        rows: list[dict[str, Any]] = list(stored["rows"])
        target = str(stored["target"])
    else:
        rows = measure(args)
        target = args.target
        if args.out:
            body = {"target": target, "model": model_name(args.model), "rows": rows}
            Path(args.out).write_text(json.dumps(body), encoding="utf-8")
    for line in summarize(
        rows, target=target, cases=bench_cases(W1_TIME_TEXT), synced=line_synced(W1_RUN_ALIGN)
    ):
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
