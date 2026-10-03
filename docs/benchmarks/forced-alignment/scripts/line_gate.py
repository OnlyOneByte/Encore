#!/usr/bin/env python
"""The LINE_SYNC rung's gate, measured rule by rule over every timed bench case on the stems. No model pass.

    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/line_gate.py \\
        [--songs a,b] [--out rows.json] [--from rows.json] [--model NAME]

The rung publishes the text's OWN line timings, so its gate owes two answers: are these words sung, and do
these TIMINGS describe this audio. This prices six candidate rules over the same cases — right texts refused,
the published documents' accuracy, and wrong texts passed — with the documents built by the shipped functions
and the decode read from the bench's emission cache. The six rules, what W1's gate cost and what "placed"
means since the rung took its own claim-clock vote are in docs/benchmarks/forced-alignment/README.md, "The
LINE_SYNC rung's gate".
"""

from __future__ import annotations

import argparse
import collections
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


def share_rule(kind: str, theta: float) -> str:
    """`decode(0.5)` / `either(0.45)` — one namer for the share-keyed rules (W4b review r1).

    `:g` rather than `:.1f`, so a row whose share is NOT one of `THETAS` (a future 0.45) gets a key of its own
    instead of colliding with the grid step it rounds to; every swept share prints exactly as it always did.
    """
    return f"{kind}({theta:g})"


def rules(tau: float, theta: float | None = None) -> dict[str, Callable[[Row], bool]]:
    """Each rule as `row -> refused`. A lift of None (unmeasurable) checks no words, and a decode that paired
    under 3 lines (`near` None) leaves the timings to the sheet gate — the shipped rung's fallbacks.

    `theta` is the SHIPPED share of the model under test, swept alongside `THETAS` so a row whose share the
    sweep's 0.1 grid does not hold still has its own `decode`/`either` rule to be reported by (W4b review r1).
    """

    def lifted(row: Row) -> bool:
        return row["lift"] is None or float(row["lift"]) >= tau

    def decoded(row: Row, theta: float) -> bool:
        return bool(row["sheet"]) if row["near"] is None else float(row["near"]) >= theta

    def on_time(row: Row, lag: float) -> bool:
        # `.get`, unlike every other reading here: a row set written before the lag rule existed carries no
        # `offset` for its unpaired cases, and an absent one is "no lag to read", as a None one is.
        seen = row.get("offset")
        return seen is None or abs(float(seen)) <= lag

    out: dict[str, Callable[[Row], bool]] = {
        "sheet alone": lambda r: not r["sheet"],
        "sheet+lift": lambda r: not (r["sheet"] and lifted(r)),
        "lift alone": lambda r: not lifted(r),
    }

    def by_decode(theta: float) -> Callable[[Row], bool]:
        return lambda r: not (lifted(r) and decoded(r, theta))

    def by_either(theta: float) -> Callable[[Row], bool]:
        return lambda r: not (lifted(r) and (bool(r["sheet"]) or decoded(r, theta)))

    def by_lag(lag: float) -> Callable[[Row], bool]:
        return lambda r: not (lifted(r) and decoded(r, 0.5) and on_time(r, lag))

    for share in sorted({*THETAS, *(() if theta is None else (theta,))}):
        out[share_rule("decode", share)] = by_decode(share)
        out[share_rule("either", share)] = by_either(share)
    # THE LAG TERM, measured and NOT taken (W3). The share is read against the text's own blind decode, so a
    # document uniformly 0.5-1.0 s late agrees with itself: 23 of the 328 right-text documents `decode(0.5)`
    # publishes have 0 lines within ±500 ms of truth and all within 1 s. Refusing on the lag the decode reads
    # does not recover them — both witnesses agree on the same misplacement — and the cost, from these rows,
    # is right texts refused 32 -> 39 of 320 at 0.5 s, text ±500 82.8% -> 80.6%, good documents refused
    # 28 -> 37 of 346; what it buys is the tempo modes' gross lines, which are W2's claim clock to fix.
    for lag in (0.3, 0.5):
        out[f"decode(0.5)+lag({lag:.1f})"] = by_lag(lag)
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


def refusals(rows: Sequence[Row], tau: float, name: str, theta: float | None = None) -> list[str]:
    """Which right texts a rule refuses, per mode, with what their line documents would have scored.

    `theta` only widens the rule table (`rules`), so a caller may ask for the model's own share by name."""
    refused_by = rules(tau, theta)[name]
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


def _starts_of(segments: Sequence[Any]) -> dict[int, float]:
    """Every segment's claimed start keyed by position, as `align_steps._claimed_starts` keys them."""
    return {i: float(s["start"]) for i, s in enumerate(segments) if isinstance(s.get("start"), (int, float))}


def placements(rows: Sequence[Row], tau: float, modes: Sequence[str], theta: float) -> list[str]:
    """W3's placement (`_placed_by`'s unconditional activity shift) against W2's (the rung's claim-clock
    vote), per mode and on the same decode: what the vote moved, what the gate then admits, and how many
    published documents have NO line within ±500 ms of truth.

    That last is `gates/w3-lines.yaml`'s `zero-pm500-documents-not-up`, the count the clock owes, and only
    rows carrying `w3_near` can be read. `theta` IS PASSED IN rather than read from the shipped module: the
    share lives in the per-model calibration row, so a `--model` run is scored at ITS row's share."""

    def lifted(row: Row) -> bool:
        return row["lift"] is None or float(row["lift"]) >= tau

    def refused(row: Row, key: str) -> bool:
        near = row.get(key)
        timed = bool(row["sheet"]) if near is None else float(near) >= theta
        return not (lifted(row) and timed)

    def counts(got: Sequence[Row], near: str, w500: str, scored: str, gross: str) -> str:
        """One placement's row. EVERY column is keyed, `gross` included (W2 review r2): it used to be
        hardcoded to `r['gross']` while the other three were parameters, so the W3 row summed the W2
        placement's gross over the documents W3's rule publishes and `w3_gross` — written by `measure()` —
        was read nowhere. On these rows that printed 0 where the W3 placement's own count is 47."""
        shown = [r for r in got if not refused(r, near)]
        lines = sum(int(r[scored]) for r in shown)
        zero = sum(1 for r in shown if int(r[scored]) and not int(r[w500]))
        return (
            f"refused {len(got) - len(shown):3}/{len(got):3}  ±500 "
            f"{_pct(sum(int(r[w500]) for r in shown), lines)}%  text ±500 "
            f"{_pct(sum(int(r[w500]) for r in shown), sum(int(r['in_text']) for r in got))}%  "
            f"gross {sum(int(r[gross]) for r in shown):4}  zero-±500 docs {zero:3}"
        )

    out: list[str] = []
    for mode in (*modes, "ALL"):
        got = [r for r in rows if (r["mode"] in modes if mode == "ALL" else r["mode"] == mode)]
        if not got or any("w3_near" not in r for r in got):
            continue
        taken = collections.Counter(str(r["map"]) for r in got if r["map_applied"])
        out.append(
            f"  {mode:10} W3 {counts(got, 'w3_near', 'w3_w500', 'w3_scored', 'w3_gross')}\n"
            f"  {'':10} W2 {counts(got, 'near', 'w500', 'scored', 'gross')}  "
            f"maps {sum(taken.values())}/{len(got)} ({', '.join(f'{k} {v}' for k, v in taken.most_common())})"
            + (f", held {sum(int(r['held']) for r in got)}" if any(r["held"] for r in got) else "")
        )
    return out


def summarize(rows: Sequence[Row], tau: float, theta: float) -> list[str]:
    lines = [f"== {len(rows)} cases; lexical gate at {tau}, shipped agreement share {theta}"]
    lines.append(f"-- W1's lines-mode set ({len(W1_LINES_MODES)} modes)")
    lines += table(rows, tau, W1_LINES_MODES)
    lines.append(f"-- every timed mode ({len(TIMED_MODES)})")
    lines += table(rows, tau, TIMED_MODES)
    lines.append("-- line-document quality per rule (every timed mode)")
    lines += quality(rows, tau)
    lines.append("-- decode agreement (share of decoded lines within --near of their placed claim)")
    lines += distributions(rows)
    lines.append(
        f"-- placement: W3's shift vs W2's claim clock, shipped rule (W1's {len(W1_LINES_MODES)} modes)"
    )
    lines += placements(rows, tau, W1_LINES_MODES, theta) or ["  no w3_near in these rows (pre-W2 run)"]
    lines.append("-- placement: every timed mode")
    lines += placements(rows, tau, TIMED_MODES, theta) or ["  no w3_near in these rows (pre-W2 run)"]
    # THE REFUSAL TABLES READ THIS MODEL'S SHARE (W4b review r1). `theta` is the row under test's — the
    # header above prints it — so hardcoding `decode(0.5)` here listed the right texts ANOTHER model's
    # threshold would refuse, directly above `fitted_share`'s "-> line_sync_min_agreement=...". That section
    # is what a calibrator reads to see WHICH texts the shipped rule costs, so it has to be the shipped rule.
    for name in ("sheet+lift", "lift alone", share_rule("decode", theta), share_rule("either", theta)):
        lines.append(f"-- refused by {name}")
        lines += refusals(rows, tau, name, theta) or ["  none"]
    lines.append("-- the fitted share for this model's calibration row")
    lines += fitted_share(rows, tau)
    return lines


def fitted_share(rows: Sequence[Row], tau: float) -> list[str]:
    """THE ROW THIS RUN FITS: the share where the gross lines start, read off THESE rows, printed ready to
    paste into `lexical.CALIBRATED`.

    The rule is the one every recalibration has followed: take the LOWEST swept share that shows no gross
    line on the right texts, since a lower one buys published documents at the price of lines more than 2 s
    out and a higher one refuses right texts for nothing. Printed beside the whole sweep, so a wave can see
    whether the population separates at all — if every share shows gross lines, this model has no share and
    ships with no row, which stands every emission-scale gate down (docs/arch/04-alignment.md §5.4)."""
    right = [r for r in rows if r["mode"] in TIMED_MODES]
    every = rules(tau)
    out: list[str] = []
    fitted: float | None = None
    for theta in THETAS:
        refused_by = every[share_rule("decode", theta)]
        shown = [r for r in right if not refused_by(r)]
        gross = sum(int(r["gross"]) for r in shown)
        out.append(
            f"  share {theta:.1f}: right refused {len(right) - len(shown):3}/{len(right)}, "
            f"shown gross {gross:3}, ±500 "
            f"{_pct(sum(int(r['w500']) for r in shown), sum(int(r['scored']) for r in shown))}%"
        )
        if gross == 0 and fitted is None:
            fitted = theta
    out.append(
        f"  -> line_sync_min_agreement={fitted}"
        if fitted is not None
        else "  -> NO share in the sweep shows 0 gross lines: this model gets no row (refuse to gate)"
    )
    return out


def claim_agreement(
    generated: Sequence[Any], placed: Mapping[int, float], near_sec: float
) -> dict[str, float | None]:
    """How the placed claim starts sit against the text's blind decode, over the lines both carry:

      near        `reconcile.as_claimed`'s share within `near_sec` — the shipped gate's number
      offset      its median (decode − claim): the claims' lag as the decode reads it
      median_gap  the median |decode − claim|
      near_fit    the share within `near_sec` once that lag is removed
      pairs       how many lines the share is OVER, `generate` dropping any line with no alignable character
    """
    from encore_worker.domain.lyrics import reconcile as rc  # noqa: PLC0415

    got = rc.as_claimed(generated, placed, tolerance_sec=near_sec)
    if got is None:
        return dict.fromkeys(("near", "median_gap", "offset", "near_fit", "pairs"))
    residuals = [line.start - placed[line.index] for line in generated if line.index in placed]
    return {
        "near": got.near,
        "median_gap": statistics.median(abs(r) for r in residuals),
        "offset": got.offset_sec,
        "near_fit": sum(abs(r - got.offset_sec) <= near_sec for r in residuals) / len(residuals),
        "pairs": float(got.pairs),
    }


def model_name(named: str | None, device: str) -> str:
    """The bundle a row set was measured on, RESOLVED — never the placeholder "default": see
    `lift_gate.model_name` for why a committed row set has to name the model it can be matched to
    (W3 review r1), and why an absent `--model` resolves to `device`'s SHIPPED bundle (W4b)."""
    import e2e  # noqa: PLC0415 - loads torch, which `--from` never needs

    return named or e2e.default_model("en", device)


def measure(args: argparse.Namespace, device: str) -> list[dict[str, Any]]:
    """Every timed case on every selected song's stem (see the module docstring).

    `device` is the caller's, since an unnamed `--model` means THIS device's shipped bundle (`model_name`)."""
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
        model=model_name(args.model, device),
        emitter=e2e.emitter_fingerprint(config),
    )
    aligner = e2e.BenchAligner(device=device, model=args.model, store=store)
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
        #: Per distinct served text: (lift, the blind decode). Timing-only modes share the truth's text, and
        #: neither reads a timing.
        decoded: dict[tuple[str, ...], tuple[float | None, Any]] = {}
        for mode in (*TIMED_MODES, *WRONG_MODES):
            for variant in range(lib.variants_of(mode)):
                claims = lib.build_claims(song, mode, corpus=corpus, duration_sec=duration, variant=variant)
                served = clean_segments(claims.segments())
                kept = [i for i, line in enumerate(claims.lines) if clean_line(line.text)]
                texts = tuple(str(s.get("text") or "") for s in served)
                if texts not in decoded:
                    got = lexical.lift(texts, emissions, decoder=forced_align_decoder)
                    blind = generate(texts, emissions, decoder=forced_align_decoder, language="en")
                    decoded[texts] = (None if got is None else round(got.value, 4), blind)
                lift, blind = decoded[texts]
                blind_lines = blind.lines
                fit = activity.fit_sheet_to_audio(signal, 16000, align_steps._sheet_spans(served))
                request = TimeRequest(
                    job=JobRef(job_id=song.slug, media_id=song.slug, media_dir="", source_uri=None),
                    text=TextRef(
                        tier=Tier.CANDIDATE, label="captions:authored", segments=served, timing=TIMING_LINE
                    ),
                    audio=AudioRef(path=str(song.mix), vocals_path=str(song.vocals), duration_sec=duration),
                    language="en",
                )

                # W3's placement (the unconditional activity shift) and W2's (the rung's own claim-clock
                # vote), through the SHIPPED functions, so one run reads both rules. The primary keys are
                # the rung's CURRENT placement; `w3_*` carries the pre-map one for the delta.
                truth_of = {
                    i: song.truth[t].start
                    for i in range(len(served))
                    if (t := claims.lines[kept[i]].truth) is not None
                }
                w3_placed = _starts_of(impl._placed_by(request, fit))
                clock = align_steps._line_sync_clock(fit, _starts_of(served), blind)
                mapped, held, unheld = align_steps._in_claim_order(impl._placed_by(request, fit, clock=clock))
                placed = _starts_of(mapped)
                errors = [at - truth_of[i] for i, at in placed.items() if i in truth_of]
                w3_errors = [at - truth_of[i] for i, at in w3_placed.items() if i in truth_of]
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
                        #: The sheet's CLAIMED lines, the denominator `pairs` is a share of: together they
                        #: re-read `align_steps._LINE_SYNC_MIN_DECODED_SHARE` off a stored run (W3 review r2).
                        "claims": len(placed),
                        "in_text": sum(
                            1 for i in range(len(served)) if claims.lines[kept[i]].truth is not None
                        ),
                        "scored": len(errors),
                        "gross": sum(abs(e) > lib.GROSS_SEC for e in errors),
                        "w500": sum(abs(e) <= 0.5 for e in errors),
                        "w1000": sum(abs(e) <= 1.0 for e in errors),
                        #: THE CLAIM CLOCK's own reading (W2): which candidate the vote took and what it
                        #: explained, so a later wave can re-read the margin off a stored run.
                        "map": "-" if clock is None else clock.candidate,
                        "map_applied": bool(clock is not None and clock.applied),
                        "map_offset": (
                            None
                            if clock is None or not clock.pieces
                            else round(clock.pieces[0].offset_sec, 3)
                        ),
                        "map_scale": (
                            None if clock is None or not clock.pieces else round(clock.pieces[0].scale, 5)
                        ),
                        "map_inliers": None if clock is None else clock.inliers,
                        "map_baseline": None if clock is None else clock.baseline,
                        "map_margin": None if clock is None else clock.margin,
                        #: Claimed starts `_in_claim_order` held at the line before them (Tom_Orlando jit), and
                        #: the inversions it REFUSED to hold. A refused sheet publishes its inversions, so
                        #: `measure.out_of_order` reaches `decide` and the text is dropped.
                        "held": held,
                        "unheld": unheld,
                        #: The SAME row under W3's placement, for the comparison table: the agreement the
                        #: activity-shifted sheet read and what its document scored.
                        "w3_near": (lambda g: None if g is None else round(g, 4))(
                            claim_agreement(blind_lines, w3_placed, args.near)["near"]
                        ),
                        "w3_scored": len(w3_errors),
                        "w3_gross": sum(abs(e) > lib.GROSS_SEC for e in w3_errors),
                        "w3_w500": sum(abs(e) <= 0.5 for e in w3_errors),
                        "w3_w1000": sum(abs(e) <= 1.0 for e in w3_errors),
                    }
                )
        print(f"{song.slug} ({time.monotonic() - began:.0f} s; {dict(aligner.served)})", file=sys.stderr)
    return rows


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0] if __doc__ else None)
    ap.add_argument("--model", default=None, help="torchaudio bundle (default: this device's shipped one)")
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

    # THE THRESHOLDS ARE THIS MODEL'S (W4b). `lexical.CALIBRATED` is keyed by bundle, so a run is scored at
    # the row of the bundle it MEASURED — the stored one under `--from`, else the named or this device's
    # shipped one; a model with NO row is what this script exists to fit, and it then scores with the shipped
    # row's numbers as a stated REFERENCE rather than pretending they are its own.
    stored = json.loads(Path(args.source).read_text(encoding="utf-8")) if args.source else None
    device = ""
    if stored is None:
        import e2e  # noqa: PLC0415 - loads torch; `--from` never needs it

        device = e2e.resolve_device(args.device)
    asked = str(stored["model"]) if stored is not None else model_name(args.model, device)
    row = lexical.CALIBRATED.get(asked)
    if row is None:
        print(
            f"-- {asked} has no calibration row: scoring with {lexical.BANDS.model}'s tau "
            f"{lexical.BANDS.refuse_below} and share {lexical.BANDS.line_sync_min_agreement} as a REFERENCE. "
            "Fit this model's own with lift_gate.py --model, and read the fitted share at the end.",
            file=sys.stderr,
        )
        row = lexical.BANDS
    args.tau = row.refuse_below if args.tau is None else args.tau
    theta = row.line_sync_min_agreement
    if args.near is None:
        args.near = align_steps._LINE_SYNC_NEAR_SEC
    else:
        # A SWEEP MOVES BOTH READERS (W2). Since the rung maps the claims before reading them, `near` is the
        # band the claim-clock VOTE scores candidates in as well as the band the gate counts a line near in
        # (`_line_sync_clock`: "explains" must mean what the reader means by it). Re-deriving one without the
        # other would measure a rule the rung cannot be set to.
        align_steps._LINE_SYNC_NEAR_SEC = args.near
        print(f"-- near swept to {args.near}: the vote's band and the gate's both", file=sys.stderr)
    warnings.filterwarnings("ignore", message=r".*forced_align has been deprecated.*")
    warnings.filterwarnings("ignore", message=r"(?s).*torchcodec is not installed correctly.*")
    if stored is not None:
        rows: list[dict[str, Any]] = list(stored["rows"])
    else:
        rows = measure(args, device)
        if args.out:
            body = {"model": asked, "near_sec": args.near, "rows": rows}
            Path(args.out).write_text(json.dumps(body), encoding="utf-8")
    for line in summarize(rows, args.tau, theta):
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
