#!/usr/bin/env python
"""The LINE_SYNC rung's gate, measured rule by rule over every timed bench case on the stems. No model pass.

    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/line_gate.py \\
        [--songs a,b] [--out rows.json] [--from rows.json] [--model NAME]

WHY IT EXISTS (W3). Under `syncMode=lines` the LINE_SYNC rung is each text's only attempt, and in forced mode
it is the terminal knob for a word document that came back unusable. It publishes the text's OWN line timings
(placed by the stem's activity fit, `AlignStepsImpl._placed_by`), so its gate has two questions to answer:
are these words sung (a same-video translation's timings describe the audio whatever its words), and do
these TIMINGS describe the audio (a sheet for another master, off by seconds, would publish off by seconds).
At W1 the answer was the sheet-span envelope gate (`align_steps._sheet_passes`) AND the lexical lift on the
stem >= 0.2. Measured at W1 review r2 (`syncMode=lines`, run_align, 10 timed modes): wrong texts 0/640
published, but 107/320 right texts refused by the sheet gate (truth 4/32: hello, rap-god, bohemian-rhapsody,
bad-guy), every one of them a text whose lift was >= +0.26. The lift reads the text on the stem's emission
matrix, decoding it blind, so the rung holds the text's own DECODE too — a second witness to where each line
is sung, one the envelope cannot give.

THE RULES, each over the same cases (the lift is the lexical gate at `align_steps._LINE_SYNC_MIN_LIFT` in
all but `sheet alone`; where a reading is missing the rule falls back as the shipped rung does):

  sheet alone      the sheet-span envelope gate only (the M1 gate before W1 r2)
  sheet+lift       W1's gate: the sheet gate AND the lift
  lift alone       the lift only; the timings go unchecked
  decode(θ)        the lift AND the placed line starts agree with the text's own blind decode: at least θ of
                   the decoded lines start within `--near` seconds of their placed claim
                   (`reconcile.as_claimed`); the sheet gate where the decode pairs under 3 lines. SHIPPED
                   at W3 with θ = `_LINE_SYNC_MIN_AGREEMENT`, `--near` = `_LINE_SYNC_NEAR_SEC`.
  either(θ)        the lift AND (the sheet gate OR decode(θ)'s agreement)

For every rule it prints: right texts refused (per mode, and over W1's 10-mode lines set), the published
right documents' lines (scored, > 2 s gross, within ±500 ms / ±1 s of truth), the text-denominator ±500
(a refused text's lines count as misses), and wrong texts passed (`wrongtext`, `wrongtext+ownclock`). A
rule that refuses a right text whose line document would have been accurate costs the room lyrics; one that
publishes a right text on timings seconds off shows it lines that are wrong. The line documents are built
with the shipped functions (`_sheet_spans`, `activity.fit_sheet_to_audio` on the stem, `_placed_by`), the
decode with the shipped decoder through `generate`, from the bench's emission cache (the key `e2e.py` uses).

Texts are served as the run_align ports serve them (`clean_segments`), for the 13 timed claim modes plus both
wrong-text modes (`blind` has no timings to sync). `--from` re-prints the summary from a stored `--out`.
"""

from __future__ import annotations

import argparse
import json
import statistics
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
from encore_worker.domain.lyrics.clean import clean_line, clean_segments  # noqa: E402

#: Every timed claim mode `--modes all` runs, and both wrong-text modes.
TIMED_MODES = tuple(m for m in lib.ALL_MODES if m not in ("blind", "wrongtext"))
WRONG_MODES = ("wrongtext", "wrongtext+ownclock")
#: The ten modes W1 review r2's `syncMode=lines` probe measured (107/320 right texts refused).
W1_LINES_MODES = (
    "truth",
    "jit",
    "off05",
    "off15",
    "off3",
    "headers",
    "credit",
    "extraverse",
    "drop20",
    "drop50",
)
#: The decode-agreement thresholds swept.
THETAS = (0.3, 0.4, 0.5, 0.6, 0.7, 0.8)

Row = Mapping[str, Any]


def rules(tau: float) -> dict[str, Callable[[Row], bool]]:
    """Each rule as `row -> refused`. A lift of None (unmeasurable) checks no words, and a decode that paired
    under 3 lines (`near` None) leaves the timings to the sheet gate — the shipped rung's fallbacks."""

    def lifted(row: Row) -> bool:
        return row["lift"] is None or float(row["lift"]) >= tau

    def decoded(row: Row, theta: float) -> bool:
        return bool(row["sheet"]) if row["near"] is None else float(row["near"]) >= theta

    out: dict[str, Callable[[Row], bool]] = {
        "sheet alone": lambda r: not r["sheet"],
        "sheet+lift": lambda r: not (r["sheet"] and lifted(r)),
        "lift alone": lambda r: not lifted(r),
    }

    def by_decode(theta: float) -> Callable[[Row], bool]:
        return lambda r: not (lifted(r) and decoded(r, theta))

    def by_either(theta: float) -> Callable[[Row], bool]:
        return lambda r: not (lifted(r) and (bool(r["sheet"]) or decoded(r, theta)))

    for theta in THETAS:
        out[f"decode({theta:.1f})"] = by_decode(theta)
        out[f"either({theta:.1f})"] = by_either(theta)
    return out


#: A right text's line document is GOOD when at least this share of its lines start within 1 s of truth,
#: BAD under `BAD_BELOW`: what a rule should publish, and what it should not.
GOOD_FROM, BAD_BELOW = 0.8, 0.5


def quality(rows: Sequence[Row], tau: float) -> list[str]:
    """Per rule, over every timed mode's right texts: good documents refused, bad and middling ones shown."""
    right = [r for r in rows if r["mode"] in TIMED_MODES and int(r["scored"])]

    def share(r: Row) -> float:
        return int(r["w1000"]) / int(r["scored"])

    good = [r for r in right if share(r) >= GOOD_FROM]
    bad = [r for r in right if share(r) < BAD_BELOW]
    mid = [r for r in right if BAD_BELOW <= share(r) < GOOD_FROM]
    out = [f"good (>= {GOOD_FROM:.0%} of lines within 1 s) {len(good)}, middling {len(mid)}, bad {len(bad)}"]
    for name, refused_by in rules(tau).items():
        out.append(
            f"{name:12} good refused {sum(1 for r in good if refused_by(r)):3}/{len(good)}  bad shown "
            f"{sum(1 for r in bad if not refused_by(r)):3}/{len(bad)}  middling shown "
            f"{sum(1 for r in mid if not refused_by(r)):3}/{len(mid)}"
        )
    return out


def _pct(part: float, whole: float) -> str:
    return f"{100.0 * part / whole:5.1f}" if whole else "    -"


def table(rows: Sequence[Row], tau: float, modes: Sequence[str]) -> list[str]:
    """One line per rule over `modes`: right refused, published accuracy, text ±500, wrong passed."""
    right = [r for r in rows if r["mode"] in modes]
    wrong = [r for r in rows if r["mode"] in WRONG_MODES]
    out = []
    for name, refused_by in rules(tau).items():
        refused = [r for r in right if refused_by(r)]
        shown = [r for r in right if not refused_by(r)]
        scored = sum(int(r["scored"]) for r in shown)
        gross = sum(int(r["gross"]) for r in shown)
        w500 = sum(int(r["w500"]) for r in shown)
        w1000 = sum(int(r["w1000"]) for r in shown)
        in_text = sum(int(r["in_text"]) for r in right)
        passed = {m: sum(1 for r in wrong if r["mode"] == m and not refused_by(r)) for m in WRONG_MODES}
        totals = {m: sum(1 for r in wrong if r["mode"] == m) for m in WRONG_MODES}
        truth_refused = sum(1 for r in refused if r["mode"] == "truth")
        out.append(
            f"{name:12} right refused {len(refused):3}/{len(right)} (truth {truth_refused:2}) | shown lines "
            f"{scored:5}, gross {gross:4}, ±500 {_pct(w500, scored)}%, ±1 s {_pct(w1000, scored)}% | text "
            f"±500 {_pct(w500, in_text)}% | wrong passed "
            + ", ".join(f"{m} {passed[m]}/{totals[m]}" for m in WRONG_MODES)
        )
    return out


def refusals(rows: Sequence[Row], tau: float, name: str) -> list[str]:
    """Which right texts a rule refuses, per mode, with what their line documents would have scored."""
    refused_by = rules(tau)[name]
    out = []
    for mode in TIMED_MODES:
        got = [r for r in rows if r["mode"] == mode and refused_by(r)]
        if got:
            would = sum(int(r["gross"]) for r in got), sum(int(r["w500"]) for r in got)
            lines = sum(int(r["scored"]) for r in got)
            out.append(
                f"  {mode:10} {len(got):2}: would have shown {lines} lines, {would[0]} gross, "
                f"{_pct(would[1], lines)}% ±500 — "
                + ", ".join(f"{r['song'][:18]}(near {_near(r)}, r {r['sheet_r']:.2f})" for r in got[:6])
                + (" ..." if len(got) > 6 else "")
            )
    return out


def _near(row: Row) -> str:
    return "-" if row["near"] is None else f"{float(row['near']):.2f}"


def distributions(rows: Sequence[Row]) -> list[str]:
    """The decode agreement per population: right texts split by what their line document scores."""
    out = []
    groups: dict[str, list[float]] = {}
    for r in rows:
        if r["near"] is None:
            continue
        if r["mode"] in WRONG_MODES:
            key = r["mode"]
        else:
            bad = int(r["scored"]) and int(r["gross"]) / int(r["scored"]) > 0.2
            key = "right, doc >20% gross" if bad else "right, doc ok"
        groups.setdefault(key, []).append(float(r["near"]))
    for key, values in sorted(groups.items()):
        ordered = sorted(values)
        n = len(ordered)
        out.append(
            f"  {key:24} n={n:4}  min {ordered[0]:.2f}  p10 {ordered[n // 10]:.2f}  median "
            f"{ordered[n // 2]:.2f}  p90 {ordered[(n * 9) // 10]:.2f}  max {ordered[-1]:.2f}"
        )
    return out


def summarize(rows: Sequence[Row], tau: float) -> list[str]:
    lines = [f"== {len(rows)} cases; lexical gate at {tau}"]
    lines.append(f"-- W1's lines-mode set ({len(W1_LINES_MODES)} modes)")
    lines += table(rows, tau, W1_LINES_MODES)
    lines.append(f"-- every timed mode ({len(TIMED_MODES)})")
    lines += table(rows, tau, TIMED_MODES)
    lines.append("-- line-document quality per rule (every timed mode)")
    lines += quality(rows, tau)
    lines.append("-- decode agreement (share of decoded lines within --near of their placed claim)")
    lines += distributions(rows)
    for name in ("sheet+lift", "lift alone", "decode(0.5)", "either(0.5)"):
        lines.append(f"-- refused by {name}")
        lines += refusals(rows, tau, name) or ["  none"]
    return lines


def claim_agreement(
    generated: Sequence[Any], placed: Mapping[int, float], near_sec: float
) -> dict[str, float | None]:
    """How the placed claim starts sit against the text's blind decode, over the lines both carry:

      near        `reconcile.as_claimed`'s share within `near_sec` — the shipped gate's number
      offset      its median (decode − claim): the claims' lag as the decode reads it
      median_gap  the median |decode − claim|
      near_fit    the share within `near_sec` once that lag is removed (does the decode describe the same
                  performance at all, whatever the claims' clock? What W2's claim clock could place)

    All None when fewer than `reconcile.MIN_PAIRS` lines are on both sides (the gate's fallback)."""
    from encore_worker.domain.lyrics import reconcile as rc  # noqa: PLC0415

    got = rc.as_claimed(generated, placed, tolerance_sec=near_sec)
    if got is None:
        return dict.fromkeys(("near", "median_gap", "offset", "near_fit"))
    residuals = [line.start - placed[line.index] for line in generated if line.index in placed]
    return {
        "near": got.near,
        "median_gap": statistics.median(abs(r) for r in residuals),
        "offset": got.offset_sec,
        "near_fit": sum(abs(r - got.offset_sec) <= near_sec for r in residuals) / len(residuals),
    }


def measure(args: argparse.Namespace) -> list[dict[str, Any]]:
    """Every timed case on every selected song's stem (see the module docstring)."""
    import e2e  # noqa: PLC0415 - loads torch; `--from` never needs it
    import soundfile as sf  # noqa: PLC0415

    from encore_worker.adapters.ml import forced_align_decoder, load_audio_mono_16k  # noqa: PLC0415
    from encore_worker.domain.audio import activity  # noqa: PLC0415
    from encore_worker.domain.lyrics.generate import generate  # noqa: PLC0415
    from encore_worker.domain.lyrics.policy import Tier  # noqa: PLC0415
    from encore_worker.host.config import Config  # noqa: PLC0415
    from encore_worker.steps import align_steps  # noqa: PLC0415
    from encore_worker.steps.records import (  # noqa: PLC0415
        TIMING_LINE,
        AudioRef,
        JobRef,
        TextRef,
        TimeRequest,
    )

    root = lib.bench_root()
    corpus = lib.discover(root)
    config = Config.from_env()
    store = lib.EmissionStore(
        root / "_emissions",
        model=args.model or e2e.default_model("en"),
        emitter=e2e.emitter_fingerprint(config),
    )
    aligner = e2e.BenchAligner(device=e2e.resolve_device(args.device), model=args.model, store=store)
    impl = align_steps.AlignStepsImpl(config=config, adapters=align_steps.Adapters(), reporter=e2e.Trail())
    chosen = set(args.songs.split(",")) if args.songs else None
    rows: list[dict[str, Any]] = []
    began = time.monotonic()
    for song in corpus:
        if chosen is not None and song.slug not in chosen:
            continue
        emissions = aligner.emissions(str(song.vocals), "en")
        signal = load_audio_mono_16k(str(song.vocals))
        info = sf.info(str(song.vocals))
        duration = info.frames / info.samplerate
        #: Per distinct served text: (lift, the blind decode's lines). Timing-only modes share the truth's
        #: text, and neither reads a timing.
        decoded: dict[tuple[str, ...], tuple[float | None, tuple[Any, ...]]] = {}
        for mode in (*TIMED_MODES, *WRONG_MODES):
            for variant in range(lib.variants_of(mode)):
                claims = lib.build_claims(song, mode, corpus=corpus, duration_sec=duration, variant=variant)
                served = clean_segments(claims.segments())
                kept = [i for i, line in enumerate(claims.lines) if clean_line(line.text)]
                texts = tuple(str(s.get("text") or "") for s in served)
                if texts not in decoded:
                    got = lexical.lift(texts, emissions, decoder=forced_align_decoder)
                    blind = generate(texts, emissions, decoder=forced_align_decoder, language="en")
                    decoded[texts] = (None if got is None else round(got.value, 4), blind.lines)
                lift, blind_lines = decoded[texts]
                fit = activity.fit_sheet_to_audio(signal, 16000, align_steps._sheet_spans(served))
                request = TimeRequest(
                    job=JobRef(job_id=song.slug, media_id=song.slug, media_dir="", source_uri=None),
                    text=TextRef(
                        tier=Tier.CANDIDATE, label="captions:authored", segments=served, timing=TIMING_LINE
                    ),
                    audio=AudioRef(path=str(song.mix), vocals_path=str(song.vocals), duration_sec=duration),
                    language="en",
                )
                placed = {
                    i: float(s["start"])  # type: ignore[arg-type]
                    for i, s in enumerate(impl._placed_by(request, fit))
                    if isinstance(s.get("start"), (int, float))
                }
                errors = [
                    placed[i] - song.truth[t].start
                    for i in placed
                    if (t := claims.lines[kept[i]].truth) is not None
                ]
                agreement = claim_agreement(blind_lines, placed, args.near)
                rows.append(
                    {
                        "song": song.slug,
                        "group": song.group,
                        "mode": mode,
                        "variant": variant,
                        "lift": lift,
                        "sheet": align_steps._sheet_passes(fit),
                        "sheet_r": round(fit.correlation, 4),
                        "sheet_lag": round(fit.seconds, 3),
                        "placed_shift": round(fit.seconds, 3) if fit.usable else 0.0,
                        **{k: None if v is None else round(v, 4) for k, v in agreement.items()},
                        "in_text": sum(
                            1 for i in range(len(served)) if claims.lines[kept[i]].truth is not None
                        ),
                        "scored": len(errors),
                        "gross": sum(abs(e) > lib.GROSS_SEC for e in errors),
                        "w500": sum(abs(e) <= 0.5 for e in errors),
                        "w1000": sum(abs(e) <= 1.0 for e in errors),
                    }
                )
        print(f"{song.slug} ({time.monotonic() - began:.0f} s; {dict(aligner.served)})", file=sys.stderr)
    return rows


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    ap.add_argument("--model", default=None, help="torchaudio bundle (default: whisperx's `en` default)")
    ap.add_argument("--out", default=None, help="write every case's measurements here (JSON)")
    ap.add_argument("--from", dest="source", default=None, help="summarize a stored --out instead")
    ap.add_argument("--songs", default=None, help="comma-separated slugs (default: the whole corpus)")
    ap.add_argument("--device", default=None, help="the emission model's device on a cache miss")
    ap.add_argument(
        "--near", type=float, default=None, help="decode agreement tolerance, s (default: the shipped one)"
    )
    ap.add_argument("--tau", type=float, default=None, help="the lexical floor (default: the shipped one)")
    args = ap.parse_args(argv)
    from encore_worker.steps import align_steps  # noqa: PLC0415

    args.near = align_steps._LINE_SYNC_NEAR_SEC if args.near is None else args.near
    args.tau = align_steps._LINE_SYNC_MIN_LIFT if args.tau is None else args.tau
    warnings.filterwarnings("ignore", message=r".*forced_align has been deprecated.*")
    warnings.filterwarnings("ignore", message=r"(?s).*torchcodec is not installed correctly.*")
    if args.source:
        rows: list[dict[str, Any]] = list(json.loads(Path(args.source).read_text(encoding="utf-8"))["rows"])
    else:
        rows = measure(args)
        if args.out:
            body = {"model": args.model or "default", "near_sec": args.near, "rows": rows}
            Path(args.out).write_text(json.dumps(body), encoding="utf-8")
    for line in summarize(rows, args.tau):
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
