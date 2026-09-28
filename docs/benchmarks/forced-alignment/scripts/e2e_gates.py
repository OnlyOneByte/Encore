"""Compare two E2E bench summaries, and evaluate a wave's reject-if gates against them.

    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/e2e.py --modes all \\
        --compare ../docs/benchmarks/forced-alignment/results/baseline-v2.json --gates my-wave.yaml
    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/e2e.py \\
        --summarize NEW/rows.jsonl --compare BASE/summary.json --gates my-wave.yaml

WHY A LANGUAGE, AND WHY SO SMALL. Every wave of PLAN-alignment-v3 is accepted or rejected on conditions like
"truth-mode ±500 drops more than 1.0 pt" or "any Jamendo song gains a gross line". Checked by hand from two
printed tables, the arithmetic is where a gate quietly passes. Written as expressions, they are checked the
same way on every run, and a failing gate exits non-zero. The grammar is a RESTRICTED Python expression,
parsed with `ast` and walked node by node (never `eval`), with exactly these parts:

  REFERENCES, dotted paths into a summary:
      [base.]MODE[.GROUP].METRIC           one pooled number   truth.pm500   base.blind.jamendo.gross
      [base.][MODE.][GROUP.]song.METRIC    one number PER SONG truth.jamendo.song.word_pm300   song.gross
    MODE is a claim mode (`truth`, `off15`), or `mode("jit+off15")` for a `+`-combined one. GROUP is
    `jamendo`, `youtube` or `all` (the default). `base.` reads the `--compare` baseline. A per-song path
    without a MODE ranges over EVERY mode, keyed (mode, song). METRIC is a name from `e2e_lib.flat_metrics`:
    pm500 pm1000 text_pm500 text_pm1000 gross zero_gross_songs high high_gross refused error published
    scored in_text missing unsung text_paired; word_pm100/250/300 word_pco300 word_bias_ms word_gross;
    end_pm100 end_pm250 end_bias_ms final_end_pm100 final_end_pm250 final_end_bias_ms; highlight;
    wrongtext_pass; the run_align policy counts (attempts retried mix_published changed_vs_first
    asr_requested asr_published no_lyrics, and retime_<knob> for EVERY policy knob, 0 when unused); and the
    95% bounds pm500_lo/_hi,
    text_pm500_lo/_hi, gross_lo/_hi, word_pm300_lo/_hi, word_pco300_lo/_hi, highlight_lo/_hi. A per-song
    path knows `e2e_lib.SONG_METRICS`, plus `doc_changed` / `onsets_changed`: 1 where the published
    document (its bytes, or only its line and word START times) differs from the baseline's, a refusal on
    either side counting as a document of its own. `METRIC_up` / `METRIC_down` is 1 where the run is
    above / below the baseline.
  WHICH ±500. `pm500` / `pm1000` are e2e2's, over the lines PUBLISHED documents scored: the review baseline
    is stated in them, and a refused song adds nothing. `text_pm500` / `text_pm1000` are over every truth
    line the text asked for, a refused case's lines counted as misses — the one to gate on wherever a
    refusal must not read as an improvement. `word_pco300`, `highlight` and `missing` count refused and
    ERROR cases in their denominators already.
  OPERATORS: numbers, + - * /, comparisons (chainable), and / or / not — with EVERY operand evaluated, no
    short-circuit, so `ok or typo.pm500 > 0` errors instead of passing. Per-song values combine
    elementwise; a plain number broadcasts.
  FUNCTIONS: count(v) = how many per-song values are true (non-zero); min / max / mean / sum of per-song
    values (min and max also take two or more numbers); abs(x); delta(ref) = run − baseline of one
    POOLED number (a `song.` path is an ERROR — it used to read the pooled number silently);
    min_song_delta(ref) / max_song_delta(ref) = the smallest / largest per-song (run − baseline) of
    `ref`, read per song (so `song.` may be left out).

A GATE IS THE CONDITION THAT MUST HOLD — the negation of the reject-if. So "reject if truth ±500 drops more
than 1 pt" is `truth.pm500 >= base.truth.pm500 - 1.0`, and "reject if any Jamendo song is more than 1 pt
worse at ±300" is `min_song_delta(jamendo.word_pm300) >= -1.0` — MIN, the worst song, for a metric where
higher is better (`max_song_delta` would read the best song). "Reject if any song gains a gross line" is
`count(song.gross_up + song.missing_up) == 0`: `gross` counts only lines that PUBLISHED, so a song with 2
gross lines that flips to refused, or drops one of them, reads FEWER and `count(song.gross_up) == 0` holds
(pinned in test_bench_e2e); `missing` (text lines not scored) rises with either. W1's "reject if a
published doc changes on a song whose stem coverage is >= 0.80" is
`count(song.doc_changed * (base.song.coverage >= 0.8)) == 0`.

A gate that CANNOT BE EVALUATED is an ERROR, and an error fails the run exactly like a FAIL. A gate that
silently passes on missing data is how a regression ships, so every one of these is an ERROR:
  * a mode the run did not measure, a metric with no data (YouTube has no word truth), a `base.` path with
    no `--compare`, no song in common;
  * a run-vs-baseline comparison over songs the run did not measure — per song, any (mode, song) the
    baseline has and the run lacks; pooled, any difference between the two sides' song sets for that
    mode and group (a `--songs` run against the full baseline compares two different pools), and the
    same for a REDUCTION of a baseline per-song value (`sum(song.gross) <= sum(base.song.gross)`);
  * any gate that reads the baseline when the two summaries measured another SETUP — level, seed,
    wrong_k, language, tfr audio, ASR or sync mode (`SETUP_META`; an unrecorded sync mode is `forced`, what
    every run before `--sync-mode` sent), or another key either side does not record. A model or
    `align_*` difference is what an arm varies, so `--compare` only warns on it;
  * a song that LOST its value (scored in the baseline, refused now: a refused song has no ±500 / word /
    highlight value but a gross COUNT of 0), in `min_song_delta` / `_up` / `_down` and in explicit
    arithmetic like `truth.song.pm500 - base.truth.song.pm500` alike. A song that GAINED a value has no
    delta and is skipped (`refused_down` counts it);
  * a reduction (`count` / `min` / `max` / `mean` / `sum`) over per-song values some song has NO value for
    — `min(truth.song.pm500) >= 85` must not pass because the worst song was refused. Gate a metric every
    song has (`text_pm500`, `gross`, `refused`), or scope the path to where the metric exists.
And ERROR ROWS FAIL THE RUN on their own: `run_gates` adds a built-in `no-error-rows` gate, because a
case the harness could not complete otherwise reads as a refusal (a wrong text "correctly" refused) or
drops out of every pooled number.

GATE FILES: JSON (`{"name": "expression", ...}` or `[{"name": ..., "expr": ...}, ...]`), or the YAML
subset every example uses — one `name: expression` per line, `#` comments, optional quotes. That subset is
plain YAML, so a real YAML parser reads the same gates (quote an expression that starts with `[`, `{` or
`- `). The CLI exits 3 when any gate FAILs or ERRORs, 2 when the gate file or baseline cannot be read.
"""

from __future__ import annotations

import ast
import json
import math
import operator
import statistics
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import e2e_lib as lib

GROUPS = ("jamendo", "youtube", "all")


class GateError(ValueError):
    """A gate (or gate file) that cannot be evaluated. Reported as ERROR, which fails the run."""


@dataclass(frozen=True, slots=True)
class View:
    """One summary document as the gates read it."""

    #: {mode: {group: {metric: number | None}}} — `e2e_lib.flat_metrics` of every summary entry.
    modes: Mapping[str, Mapping[str, Mapping[str, float | None]]]
    #: {mode: {song: {"group": ..., metric: number}}} — `e2e_lib.per_song`.
    songs: Mapping[str, Mapping[str, Mapping[str, Any]]]
    meta: Mapping[str, Any]


def view_of(document: Mapping[str, Any]) -> View:
    summary: Mapping[str, Mapping[str, Mapping[str, Any]]] = document.get("summary") or {}
    return View(
        modes={
            mode: {group: lib.flat_metrics(entry) for group, entry in groups.items()}
            for mode, groups in summary.items()
        },
        songs=document.get("songs") or {},
        meta=document.get("meta") or {},
    )


def load_document(path: Path) -> dict[str, Any]:
    """A summary document from a `summary.json`, a run directory, or a `rows.jsonl` (re-summarized).

    A rows file is re-summarized with THIS harness, so a baseline recorded before a metric existed still
    gets it — provided its rows carry the raw data (ends need the rows' `end_errors`). Its meta is the
    `run.json` beside it (`e2e_lib.rows_document`), so the setup check in `run_gates` can see what it
    measured; a compact `.cases.jsonl` is refused rather than re-summarized into wrong numbers.
    """
    if path.is_dir():
        path = path / "summary.json" if (path / "summary.json").is_file() else path / "rows.jsonl"
    if path.suffix == ".jsonl":
        return lib.rows_document(path)
    loaded: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    if "summary" not in loaded:
        raise GateError(f"{path} is not a bench summary (no 'summary' key)")
    return loaded


# ── compare ──────────────────────────────────────────────────────────────────────────────────────────

#: (flat metric, printed label, format) — the columns `--compare` prints for every mode x group.
COMPARE_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("gross", "gross", ".0f"),
    ("pm500", "±500", ".1f"),
    ("pm1000", "±1s", ".1f"),
    ("text_pm500", "±500/text", ".1f"),
    ("zero_gross_songs", "0-gross", ".0f"),
    ("high_gross", "high>2s", ".0f"),
    ("refused", "refused", ".0f"),
    ("error", "ERROR", ".0f"),
    ("word_pm300", "word±300", ".1f"),
    ("word_pco300", "PCO@.3", ".1f"),
    ("final_end_pm100", "final-end±100", ".1f"),
    ("highlight", "highlight", ".1f"),
    ("wrongtext_pass", "wrong-text pass", ".1f"),
    ("mix_published", "mix-published", ".0f"),
)

#: The measurement SETUP a run and its baseline must share for a `base.` gate to mean anything: which job
#: is measured (`level`), which cases and claims (`seed`, `wrong_k`), which text language, which audio (the
#: tfr songs' `tfr_audio`) and, at `run_align`, which transcriber (`asr`). A gate that reads the baseline
#: across a difference here is an ERROR (`run_gates`), not a warning. Measured on the committed results:
#: `baseline-v2-reference.json` (oracle tfr stems) against `baseline-v2.json` (youtube) passed
#: `drop20.gross <= base.drop20.gross` as 41 <= 51, a 10-line gap made entirely by the tfr audio; both have
#: the same 32 song names, so the song-set check could not see it. A key missing on either side is a
#: difference too: nothing then shows the two ran the same setup (`--summarize` reads `run.json`).
SETUP_META = ("level", "seed", "wrong_k", "language", "tfr_audio", "asr", "sync_mode")

#: A setup key a summary may leave out, and what its absence means: every run before `--sync-mode` existed
#: (W3) sent no `syncMode`, which the worker reads as `forced`. So a forced run compares with those
#: baselines, and a `lines` run against any of them is a setup mismatch, not a comparison.
SETUP_DEFAULTS: Mapping[str, str] = {"sync_mode": "forced"}

#: Run metadata `--compare` WARNS on but gates accept: the independent variables of an arm. W4 6b/6c gate a
#: model change against the base-model baseline, and every default-off arm is an `align_experiments`
#: setting, so a difference here is the experiment, not a broken comparison. `code` is absent for the same
#: reason — a wave's run differs from its baseline in code by definition — and is printed in the header.
COMPARED_META = ("model", "model_identity", "align_config")


def setup_mismatch(run: Mapping[str, Any], base: Mapping[str, Any]) -> list[str]:
    """How two summaries' `SETUP_META` differ (or cannot be shown equal), one phrase per key; [] when equal.

    `asr` and `sync_mode` are recorded at `run_align` only, so they are compared only when either side is a
    `run_align` run; a missing `sync_mode` is its `SETUP_DEFAULTS` value.
    """
    out: list[str] = []
    for key in SETUP_META:
        if key in ("asr", "sync_mode") and "run_align" not in (run.get("level"), base.get("level")):
            continue
        if key in SETUP_DEFAULTS:
            ours, theirs = run.get(key, SETUP_DEFAULTS[key]), base.get(key, SETUP_DEFAULTS[key])
            if ours != theirs:
                out.append(f"{key} differs — run {ours!r}, base {theirs!r}")
            continue
        if key not in run or key not in base:
            silent = [side for side, meta in (("the run", run), ("the baseline", base)) if key not in meta]
            out.append(f"{key} not recorded by {' and '.join(silent)}")
        elif run[key] != base[key]:
            out.append(f"{key} differs — run {run[key]!r}, base {base[key]!r}")
    return out


def _cell(value: float | None, base: float | None, spec: str) -> str:
    if value is None and base is None:
        return "-"
    if value is None or base is None:
        shown = "-" if value is None else format(value, spec)
        return f"{shown} (base {'-' if base is None else format(base, spec)})"
    delta = value - base
    return f"{format(value, spec)} ({'=' if abs(delta) < 1e-9 else format(delta, '+' + spec)})"


def format_compare(run: View, base: View) -> str:
    """Per mode x group: each headline metric as `run (Δ vs base)`, then which SONGS moved."""
    out: list[str] = [
        f"== compare: run [{_describe(run.meta)}] vs base [{_describe(base.meta)}]",
    ]
    out.extend(
        f"  WARNING: {phrase} — every gate that reads the baseline is an ERROR"
        for phrase in setup_mismatch(run.meta, base.meta)
    )
    for key in COMPARED_META:
        if key in run.meta and key in base.meta and run.meta[key] != base.meta[key]:
            out.append(f"  WARNING: {key} differs — run {run.meta[key]!r}, base {base.meta[key]!r}")
    for side, meta in (("run", run.meta), ("base", base.meta)):
        codes = meta.get("row_codes") or []
        if len(codes) > 1:
            out.append(
                f"  WARNING: the {side}'s rows were measured on {len(codes)} different worker trees "
                f"({', '.join(codes)}) — a --resume across a code change"
            )
    only_run = [m for m in run.modes if m not in base.modes]
    only_base = [m for m in base.modes if m not in run.modes]
    if only_run or only_base:
        out.append(
            f"  modes only in run: {', '.join(only_run) or '-'}; only in base: {', '.join(only_base) or '-'}"
        )
    for mode, groups in run.modes.items():
        if mode not in base.modes:
            continue
        out.append(f"== {mode}")
        for group, flat in groups.items():
            other = base.modes[mode].get(group)
            if other is None:
                continue
            cells = [
                f"{label} {_cell(flat.get(name), other.get(name), spec)}"
                for name, label, spec in COMPARE_COLUMNS
                if flat.get(name) is not None or other.get(name) is not None
            ]
            out.append(f"  {group:<8} " + "  ".join(cells))
        out.extend(f"  {line}" for line in _song_moves(run.songs.get(mode, {}), base.songs.get(mode, {})))
    return "\n".join(out)


def _describe(meta: Mapping[str, Any]) -> str:
    git = meta.get("git") or {}
    head = str(git.get("head") or "")[:8]
    bits = [str(meta[k]) for k in ("level", "model") if meta.get(k)]
    if meta.get("sync_mode", SETUP_DEFAULTS["sync_mode"]) != SETUP_DEFAULTS["sync_mode"]:
        bits.append(f"syncMode={meta['sync_mode']}")
    if head:
        bits.append(head + (f"+{git['dirty_files']} dirty" if git.get("dirty_files") else ""))
    if meta.get("code"):
        bits.append(f"code {meta['code']}")
    return " ".join(bits) or str(meta.get("rows") or "?")


def _song_moves(run: Mapping[str, Mapping[str, Any]], base: Mapping[str, Mapping[str, Any]]) -> list[str]:
    common = [song for song in run if song in base]
    if not common:
        return ["songs: none in common"] if run and base else []
    lines: list[str] = []
    for name, label in (("gross", "gross"), ("refused", "refused"), ("error", "ERROR")):
        moved = sorted(
            ((float(run[s].get(name) or 0) - float(base[s].get(name) or 0), s) for s in common),
            key=lambda item: (-item[0], item[1]),
        )
        up = [f"{s} {d:+.0f}" for d, s in moved if d > 0]
        down = [f"{s} {d:+.0f}" for d, s in moved if d < 0]
        if up or down:
            lines.append(f"songs {label} up: {', '.join(up) or '-'}; down: {', '.join(down) or '-'}")
    for name, label in (
        ("pm500", "±500"),
        ("text_pm500", "±500/text"),
        ("word_pm300", "word ±300"),
        ("highlight", "highlight"),
    ):
        deltas = [
            (float(run[s][name]) - float(base[s][name]), s)
            for s in common
            if run[s].get(name) is not None and base[s].get(name) is not None
        ]
        if deltas:
            worst, best = min(deltas), max(deltas)
            lines.append(f"songs {label}: worst {worst[1]} {worst[0]:+.1f}, best {best[1]} {best[0]:+.1f}")
    return lines


# ── gates ────────────────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Gate:
    name: str
    expr: str


@dataclass(frozen=True, slots=True)
class GateResult:
    gate: Gate
    #: PASS / FAIL / ERROR. Both FAIL and ERROR reject.
    status: str
    detail: str


def parse_gates(text: str) -> list[Gate]:
    """A gate file: JSON (object or list), else the one-`name: expression`-per-line YAML subset."""
    stripped = text.lstrip()
    gates: list[Gate] = []
    if stripped.startswith(("{", "[")):
        loaded = json.loads(text)
        items = (
            loaded.items() if isinstance(loaded, dict) else ((g.get("name"), g.get("expr")) for g in loaded)
        )
        gates = [Gate(str(name), str(expr)) for name, expr in items]
    else:
        for number, raw in enumerate(text.splitlines(), 1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if raw[:1].isspace():
                raise GateError(
                    f"gate file line {number}: nested YAML is not supported — one `name: expr` per line"
                )
            name, colon, expr = line.partition(":")
            expr = expr.split(" #", 1)[0].strip()
            if len(expr) >= 2 and expr[0] in "'\"" and expr[-1] == expr[0]:
                expr = expr[1:-1]
            if not colon or not name.strip() or not expr:
                raise GateError(f"gate file line {number}: expected `name: expression`, got {raw!r}")
            gates.append(Gate(name.strip(), expr))
    names = [g.name for g in gates]
    duplicated = sorted({n for n in names if names.count(n) > 1})
    if duplicated:
        raise GateError(f"gate file names a gate twice: {', '.join(duplicated)}")
    if not gates:
        raise GateError("gate file holds no gates")
    return gates


#: The gate every run gets whether its file names it or not (see the module docstring).
NO_ERROR_ROWS = Gate("no-error-rows", "error == 0 in every mode (built in)")


def error_rows_gate(run: View) -> GateResult:
    """FAIL when any mode has an ERROR row: a case the harness could not complete is not a measurement.

    Measured risk, not a style rule: an ERROR on a wrong-text case used to count as a refusal, so a
    helper that raised on some texts LOWERED the wrong-text pass rate and passed W3's gate on a crash.
    """
    if not run.modes:
        return GateResult(NO_ERROR_ROWS, "ERROR", "the run has no modes")
    broken = {
        mode: int(groups["all"].get("error") or 0)
        for mode, groups in run.modes.items()
        if "all" in groups and (groups["all"].get("error") or 0) > 0
    }
    if broken:
        detail = ", ".join(f"{mode} {count}" for mode, count in broken.items())
        return GateResult(NO_ERROR_ROWS, "FAIL", f"ERROR rows: {detail}")
    return GateResult(NO_ERROR_ROWS, "PASS", "0 ERROR rows")


def run_gates(
    gates: Iterable[Gate], run: View, base: View | None, *, builtin: bool = True
) -> list[GateResult]:
    """Every gate's verdict, the built-in `no-error-rows` first unless `builtin` is off.

    A gate that READ THE BASELINE (a `base.` path, `delta`, `*_song_delta`, `_up` / `_down`,
    `doc_changed`) is an ERROR when the two summaries' measurement setup differs (`setup_mismatch`):
    `--compare` used to print a WARNING and the verdicts went on as if the runs were comparable. A gate
    that reads only the run is judged as usual.
    """
    out: list[GateResult] = [error_rows_gate(run)] if builtin else []
    mismatch = setup_mismatch(run.meta, base.meta) if base is not None else []
    for gate in gates:
        walker = _Walker(run, base)
        try:
            held, detail = _evaluate(gate.expr, walker)
        except GateError as error:
            out.append(GateResult(gate, "ERROR", str(error)))
            continue
        if walker.read_base and mismatch:
            why = "; ".join(mismatch)
            out.append(
                GateResult(
                    gate, "ERROR", f"reads the baseline, but the two runs measured another setup: {why}"
                )
            )
        else:
            out.append(GateResult(gate, "PASS" if held else "FAIL", detail))
    return out


def format_gates(results: Sequence[GateResult]) -> str:
    failed = [r for r in results if r.status != "PASS"]
    lines = [f"== gates: {len(results) - len(failed)}/{len(results)} pass" + (" — REJECT" if failed else "")]
    width = max(len(r.gate.name) for r in results)
    for r in results:
        lines.append(f"  {r.status:<5} {r.gate.name:<{width}}  {r.gate.expr}   [{r.detail}]")
    return "\n".join(lines)


RUN, BASE = "run", "base"


class Songs:
    """A per-song value: {(mode, song): number}, and which summary it was read from.

    `absent` holds the songs the summary HAS but that carry no value for the metric — a refused song has no
    ±500 — so a run-vs-baseline comparison can tell "lost its value" (a regression) from "gained one",
    and a reduction can refuse to pretend the song is not there. It is CARRIED through arithmetic.

    `side` is RUN or BASE for a value read straight from one summary, None once derived (a delta, an
    `_up` flag, a run-vs-baseline expression). It decides how two per-song values pair (`_combine`).

    `pool`, on a BASE value only, is the (mode, song) keys the RUN measured at the same address. A
    reduction of a baseline value must range over exactly the run's songs (`_Walker.call`), or
    `sum(song.gross) <= sum(base.song.gross)` compares two pools: measured, a run of song a alone (3
    gross) passed `3 <= 9` against a baseline of a (0) and b (9).
    """

    __slots__ = ("absent", "pool", "side", "values")

    def __init__(
        self,
        values: Mapping[tuple[str, str], float],
        absent: Iterable[tuple[str, str]] = (),
        *,
        side: str | None = None,
        pool: frozenset[tuple[str, str]] | None = None,
    ) -> None:
        self.values = dict(values)
        self.absent = frozenset(absent)
        self.side = side
        self.pool = pool

    def keys(self) -> frozenset[tuple[str, str]]:
        """Every song this value knows of, with or without a number."""
        return frozenset(self.values) | self.absent

    def __repr__(self) -> str:
        return f"{len(self.values)} songs" + (f" ({len(self.absent)} without a value)" if self.absent else "")


Value = float | bool | Songs


@dataclass(frozen=True, slots=True)
class _Mode:
    """`mode("jit+off15")` — a claim mode that is not a Python identifier."""

    name: str


@dataclass(frozen=True, slots=True)
class _Address:
    base: bool
    mode: str | None
    group: str | None
    song: bool
    metric: str

    def __str__(self) -> str:
        parts = ["base"] if self.base else []
        parts += [p for p in (self.mode, self.group) if p]
        parts += ["song"] if self.song else []
        return ".".join([*parts, self.metric])


_ARITHMETIC: Mapping[type[ast.operator], Callable[[float, float], float]] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
}
_COMPARE: Mapping[type[ast.cmpop], Callable[[float, float], bool]] = {
    ast.Lt: operator.lt,
    ast.LtE: operator.le,
    ast.Gt: operator.gt,
    ast.GtE: operator.ge,
    ast.Eq: operator.eq,
    ast.NotEq: operator.ne,
}
_SYMBOL: Mapping[type[ast.cmpop], str] = {
    ast.Lt: "<",
    ast.LtE: "<=",
    ast.Gt: ">",
    ast.GtE: ">=",
    ast.Eq: "==",
    ast.NotEq: "!=",
}
FUNCTIONS = ("count", "min", "max", "mean", "sum", "abs", "delta", "min_song_delta", "max_song_delta")

#: Per-song metrics derived from `e2e_lib.SONG_DIGESTS`, run against baseline: {metric: per-song key}.
DIGEST_METRICS: Mapping[str, str] = {"doc_changed": "doc", "onsets_changed": "onsets"}


def evaluate(expr: str, run: View, base: View | None) -> tuple[bool, str]:
    """(does the gate hold, the evaluated operands of its top-level comparison).

    The expression alone: `run_gates` adds the run-vs-baseline setup check on top.
    """
    return _evaluate(expr, _Walker(run, base))


def _evaluate(expr: str, walker: _Walker) -> tuple[bool, str]:
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as error:
        raise GateError(f"not an expression: {error.msg}") from error
    held = walker.value(tree.body)
    if not isinstance(held, bool):
        raise GateError("a gate must be a condition (a comparison, or/and/not), not a value")
    detail = ""
    if isinstance(tree.body, ast.Compare):
        operands = [walker.value(tree.body.left), *(walker.value(c) for c in tree.body.comparators)]
        symbols = [_SYMBOL[type(op)] for op in tree.body.ops]
        detail = " ".join(
            [
                _show(operands[0]),
                *(f"{symbol} {_show(v)}" for symbol, v in zip(symbols, operands[1:], strict=True)),
            ]
        )
    return held, detail


def _show(value: Value) -> str:
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, Songs):
        return repr(value)
    return f"{value:.4g}"


class _Walker:
    def __init__(self, run: View, base: View | None) -> None:
        self.run = run
        self.base = base
        #: Whether evaluating read the baseline at all (directly or through delta / _up / doc_changed):
        #: `run_gates` holds such a gate to the same measurement setup on both sides.
        self.read_base = False

    # ── expressions ──

    def value(self, node: ast.expr) -> Value:
        if isinstance(node, ast.Constant):
            if isinstance(node.value, bool):
                return node.value
            if isinstance(node.value, (int, float)):
                return float(node.value)
            raise GateError(f"unexpected literal {node.value!r} (strings only appear inside mode(...))")
        if isinstance(node, ast.Call) and not _is_mode_call(node):
            return self.call(node)
        if isinstance(node, (ast.Name, ast.Attribute, ast.Call)):
            address = _address(_segments(node))
            if address.song:
                return self.songs(address)
            number = self.scalar(address)
            return bool(number) if _derived(address.metric) is not None else number
        if isinstance(node, ast.BinOp):
            op = _ARITHMETIC.get(type(node.op))
            if op is None:
                raise GateError(f"operator {type(node.op).__name__} is not part of the gate language")
            return _combine(op, self.value(node.left), self.value(node.right))
        if isinstance(node, ast.UnaryOp):
            operand = self.value(node.operand)
            if isinstance(node.op, ast.Not):
                return not _truth(operand)
            if isinstance(node.op, (ast.USub, ast.UAdd)):
                return _combine(operator.mul, -1.0 if isinstance(node.op, ast.USub) else 1.0, operand)
            raise GateError(f"operator {type(node.op).__name__} is not part of the gate language")
        if isinstance(node, ast.BoolOp):
            # EVERY operand is evaluated — no short-circuit — so `ok or typo.pm500 > 0` is an ERROR rather
            # than a pass that never looked at its broken half.
            values = [_truth(self.value(v)) for v in node.values]
            return all(values) if isinstance(node.op, ast.And) else any(values)
        if isinstance(node, ast.Compare):
            left = self.value(node.left)
            result: Value = True
            for comparison, comparator in zip(node.ops, node.comparators, strict=True):
                test = _COMPARE.get(type(comparison))
                if test is None:
                    raise GateError(
                        f"comparison {type(comparison).__name__} is not part of the gate language"
                    )
                right = self.value(comparator)
                step = _combine(_as_float(test), left, right)
                result = step if result is True else _combine(_both, result, step)
                left = right
            return _as_condition(result)
        raise GateError(f"{type(node).__name__} is not part of the gate language")

    def call(self, node: ast.Call) -> Value:
        name = node.func.id if isinstance(node.func, ast.Name) else None
        if name not in FUNCTIONS or node.keywords:
            raise GateError(f"unknown function {ast.unparse(node.func)}(); known: {', '.join(FUNCTIONS)}")
        if name in ("delta", "min_song_delta", "max_song_delta"):
            if len(node.args) != 1:
                raise GateError(f"{name}() takes one reference")
            address = _address(_segments(node.args[0]))
            if address.base:
                raise GateError(f"{name}() reads the run against the baseline; drop the `base.` prefix")
            if name == "delta":
                if address.song:
                    # It used to read the POOLED number silently: `delta(truth.song.gross) <= 0` passed as
                    # -1 <= 0 on a run where song a gained 3 gross lines.
                    raise GateError(
                        f"delta({address}) takes one pooled number; per song, use min_song_delta / "
                        "max_song_delta or song.METRIC_up / _down"
                    )
                return self.scalar(address) - self.scalar(_rebased(address))
            deltas = self.deltas(_as_song(address))
            return (min if name == "min_song_delta" else max)(deltas.values.values())
        args = [self.value(arg) for arg in node.args]
        if name == "abs":
            if len(args) != 1:
                raise GateError("abs() takes one value")
            return _combine(lambda a, _b: abs(a), args[0], 0.0)
        if name in ("min", "max") and len(args) > 1:
            numbers = [float(a) for a in args if not isinstance(a, Songs)]
            if len(numbers) != len(args):
                raise GateError(f"{name}() of several values takes numbers; reduce per-song values first")
            return (min if name == "min" else max)(numbers)
        if len(args) != 1 or not isinstance(args[0], Songs):
            raise GateError(f"{name}() reduces per-song values (a `song.` path or a per-song expression)")
        if args[0].absent:
            # A song with no value would vanish from the reduction — the worst song, when it was refused.
            raise GateError(
                f"{name}() cannot reduce over songs with no value: {_named(args[0].absent)} (refused?); gate "
                "a metric every song has (text_pm500, gross, refused) or scope the path to where it exists"
            )
        if args[0].side == BASE and args[0].pool is not None and args[0].keys() != args[0].pool:
            # `songs()` already refused a baseline song the run lacks; what is left is the run measuring
            # MORE songs, which moves the run's own reduction and not the baseline's.
            raise GateError(
                f"{name}() reduces the baseline over other songs than the run measured (only in the run: "
                f"{_named(args[0].pool - args[0].keys())}); a pooled comparison needs the same songs"
            )
        values = list(args[0].values.values())
        if name == "count":
            return float(sum(1 for v in values if v))
        if not values:
            raise GateError(f"{name}() of no songs")
        reducers: Mapping[str, Callable[[list[float]], float]] = {
            "min": min,
            "max": max,
            "mean": statistics.fmean,
            "sum": math.fsum,
        }
        return reducers[name](values)

    # ── references ──

    def _side(self, address: _Address) -> View:
        if not address.base:
            return self.run
        self.read_base = True
        if self.base is None:
            raise GateError(f"{address} reads the baseline, but no --compare baseline was given")
        return self.base

    def scalar(self, address: _Address) -> float:
        if address.song:
            raise GateError(f"{address} is per song; a pooled number is [base.]MODE[.GROUP].METRIC")
        derived = _derived(address.metric)
        if derived is not None:
            stem, sign = derived
            if address.base:
                raise GateError(f"{address}: _up/_down already compare with the baseline")
            plain = _with_metric(address, stem)
            return float(sign * (self.scalar(plain) - self.scalar(_rebased(plain))) > 0)
        if address.mode is None:
            raise GateError(
                f"{address} names no mode — a pooled number needs one (e.g. truth.{address.metric})"
            )
        view = self._side(address)
        groups = view.modes.get(address.mode)
        if groups is None:
            raise GateError(
                f"{address}: mode {address.mode!r} is not in this summary ({', '.join(view.modes)})"
            )
        flat = groups.get(address.group or "all")
        if flat is None:
            raise GateError(f"{address}: group {address.group!r} has no songs in this summary")
        if address.metric not in flat:
            raise GateError(f"{address}: unknown metric; known: {', '.join(sorted(flat))}")
        value = flat[address.metric]
        if value is None:
            raise GateError(f"{address} has no value (no data for this metric here)")
        if address.base:
            self._same_pool(address)
        return value

    def _same_pool(self, address: _Address) -> None:
        """A pooled baseline number compares with the run's only over the SAME songs.

        A `--songs hello` run against the 32-song baseline would otherwise gate one song's ±500 against a
        pool of 32, and pass or fail on the difference in corpus rather than in code.
        """
        assert self.base is not None and address.mode is not None
        group = address.group or "all"
        run, base = _song_set(self.run, address.mode, group), _song_set(self.base, address.mode, group)
        if run is None or base is None:
            raise GateError(
                f"{address}: {'the run' if run is None else 'the baseline'} has no per-song data for mode "
                f"{address.mode!r}, so nothing shows the two sides pooled the same songs"
            )
        if run != base:
            missing, extra = sorted(base - run), sorted(run - base)
            raise GateError(
                f"{address}: the run pooled other songs than the baseline under {address.mode}/{group} "
                f"(not measured: {', '.join(missing[:5]) or '-'}; only in the run: "
                f"{', '.join(extra[:5]) or '-'}); re-run the baseline's songs"
            )

    def songs(self, address: _Address) -> Songs:
        derived = _derived(address.metric)
        if derived is not None:
            stem, sign = derived
            if address.base:
                raise GateError(f"{address}: _up/_down already compare with the baseline")
            delta = self.deltas(_with_metric(address, stem))
            return Songs({k: float(sign * v > 0) for k, v in delta.values.items()})
        if address.metric in DIGEST_METRICS:
            return self.changed(address, DIGEST_METRICS[address.metric])
        if address.metric not in lib.SONG_METRICS:
            known = ", ".join([*lib.SONG_METRICS, *DIGEST_METRICS])
            raise GateError(f"{address}: not a per-song metric; per-song: {known}")
        entries = self._entries(address)
        values = {
            key: float(entry[address.metric]) for key, entry in entries.items() if address.metric in entry
        }
        if not values:
            raise GateError(f"{address}: no song has this value in this summary")
        pool: frozenset[tuple[str, str]] | None = None
        if address.base:
            # A baseline song the run never measured is an ERROR however the value is used — in arithmetic
            # against the run (`_require_paired`) and in a reduction alike (the `pool` check).
            pool = frozenset(self._entries(_with_side(address, base=False)))
            _require_measured(set(entries) - pool, address)
        return Songs(
            values,
            absent=(key for key in entries if key not in values),
            side=BASE if address.base else RUN,
            pool=pool,
        )

    def _entries(self, address: _Address) -> dict[tuple[str, str], Mapping[str, Any]]:
        """The per-song entries `address` ranges over: its mode (or every mode), its group."""
        view = self._side(address)
        if address.mode is not None and address.mode not in view.songs:
            raise GateError(f"{address}: mode {address.mode!r} has no per-song data in this summary")
        modes = [address.mode] if address.mode is not None else list(view.songs)
        return {
            (mode, song): entry
            for mode in modes
            for song, entry in view.songs[mode].items()
            if address.group in (None, "all", entry.get("group"))
        }

    def changed(self, address: _Address, key: str) -> Songs:
        """`song.doc_changed` / `song.onsets_changed`: 1 where the run's digest is not the baseline's."""
        if address.base:
            raise GateError(f"{address}: {address.metric} already compares with the baseline")
        run = self._entries(address)
        base = self._entries(_rebased(address))
        for side, entries in (("this run", run), ("the baseline", base)):
            bare = sorted(k for k, entry in entries.items() if key not in entry)
            if bare:
                raise GateError(
                    f"{address}: no `{key}` digest in {side} for {_named(bare)} (a `generate` run, or a "
                    "summary written before digests existed)"
                )
        _require_measured(set(base) - set(run), address)
        return Songs({k: float(run[k][key] != base[k][key]) for k in base})

    def deltas(self, address: _Address) -> Songs:
        """Per song, run − baseline of `address` (`_combine` pairs the two and enforces the rules).

        A song whose value the BASELINE has and this run LOST (it was scored, now it is refused) is an ERROR:
        dropping it would let the worst regression of all pass a "no song got worse" gate. So is a song the
        baseline has and the run did not measure at all. The reverse — a song that gained a value — has no
        delta and is skipped (`refused_down` counts it).
        """
        run, base = self.songs(address), self.songs(_rebased(address))
        try:
            delta = _combine(operator.sub, run, base)
        except GateError as error:  # name the reference: `_combine` only knows songs
            raise GateError(f"{address}: {error}") from error
        assert isinstance(delta, Songs)
        return delta


def _is_mode_call(node: ast.Call) -> bool:
    func = node.func
    named = (isinstance(func, ast.Name) and func.id == "mode") or (
        isinstance(func, ast.Attribute) and func.attr == "mode"
    )
    return named and len(node.args) == 1 and isinstance(node.args[0], ast.Constant) and not node.keywords


def _segments(node: ast.expr) -> list[str | _Mode]:
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, ast.Attribute):
        return [*_segments(node.value), node.attr]
    if isinstance(node, ast.Call) and _is_mode_call(node):
        literal = node.args[0]
        assert isinstance(literal, ast.Constant)
        head = _segments(node.func.value) if isinstance(node.func, ast.Attribute) else []
        return [*head, _Mode(str(literal.value))]
    raise GateError(f"{ast.unparse(node)} is not a reference (expected MODE.METRIC, song.METRIC, ...)")


def _address(segments: Sequence[str | _Mode]) -> _Address:
    parts = list(segments)
    base = parts[:1] == ["base"]
    if base:
        parts = parts[1:]
    if not parts or not isinstance(parts[-1], str):
        raise GateError(f"reference {'.'.join(map(str, segments))} ends without a metric")
    metric = str(parts.pop())
    song = parts[-1:] == ["song"]
    if song:
        parts.pop()
    group = str(parts.pop()) if parts and parts[-1] in GROUPS else None
    mode: str | None = None
    if parts:
        head = parts.pop(0)
        mode = head.name if isinstance(head, _Mode) else head
    if parts:
        raise GateError(
            f"cannot read reference {'.'.join(map(str, segments))} as [base.]MODE[.GROUP][.song].METRIC"
        )
    return _Address(base, mode, group, song, metric)


def _rebased(address: _Address) -> _Address:
    return _with_side(address, base=True)


def _with_side(address: _Address, *, base: bool) -> _Address:
    return _Address(base, address.mode, address.group, address.song, address.metric)


def _as_song(address: _Address) -> _Address:
    return _Address(address.base, address.mode, address.group, True, address.metric)


def _with_metric(address: _Address, metric: str) -> _Address:
    return _Address(address.base, address.mode, address.group, address.song, metric)


def _derived(metric: str) -> tuple[str, float] | None:
    """`gross_up` -> ("gross", +1); `pm500_down` -> ("pm500", -1); None for a plain metric."""
    for suffix, sign in (("_up", 1.0), ("_down", -1.0)):
        if metric.endswith(suffix) and len(metric) > len(suffix):
            return metric[: -len(suffix)], sign
    return None


def _as_float(test: Callable[[float, float], bool]) -> Callable[[float, float], float]:
    return lambda a, b: float(test(a, b))


def _both(a: float, b: float) -> float:
    return float(bool(a) and bool(b))


def _truth(value: Value) -> bool:
    if isinstance(value, Songs):
        raise GateError("and / or / not take conditions; reduce per-song values with count/min/max first")
    return bool(value)


def _as_condition(value: Value) -> Value:
    """A scalar comparison result is a bool; a per-song one stays per-song (1.0 / 0.0)."""
    return value if isinstance(value, Songs) else bool(value)


def _combine(op: Callable[[float, float], float], left: Value, right: Value) -> Value:
    """`op` elementwise; a number broadcasts against per-song values, whose `absent` songs ride along.

    Two per-song values pair on the songs both have a number for. How the REST is treated depends on
    where the two came from, because silently dropping a song is exactly how a regression passes:
      * the RUN against the BASELINE (`truth.song.pm500 - base.truth.song.pm500`): a song with a baseline
        value that the run lost, or did not measure at all, is an ERROR (`_require_paired`) — the same
        rule `min_song_delta` and `_up` / `_down` apply, so the explicit spelling of "no song worse by more
        than 1 pt" cannot pass on the song that was refused. A song that GAINED a value is skipped;
      * anything else (one summary with itself, a derived value with either): a song both know of but
        one has no number for stays `absent`, so a later reduction refuses to pretend it is not there.
    """
    if isinstance(left, Songs) and isinstance(right, Songs):
        common = [k for k in left.values if k in right.values]
        if {left.side, right.side} == {RUN, BASE}:
            run, base = (left, right) if left.side == RUN else (right, left)
            _require_paired(run, base)
            if not common:
                raise GateError("the run and the baseline have no song in common")
            return Songs({k: _apply(op, left.values[k], right.values[k]) for k in common})
        if not common:
            raise GateError("the two per-song values have no song in common")
        side = left.side if left.side == right.side else None
        return Songs(
            {k: _apply(op, left.values[k], right.values[k]) for k in common},
            absent=(left.keys() & right.keys()) - set(common),
            side=side,
            # Two baseline values keep the run songs BOTH addresses cover, matching the kept keys.
            pool=None if side != BASE or left.pool is None or right.pool is None else left.pool & right.pool,
        )
    if isinstance(left, Songs):
        assert not isinstance(right, Songs)  # both-Songs returned above
        number = float(right)
        return Songs(
            {k: _apply(op, v, number) for k, v in left.values.items()},
            left.absent,
            side=left.side,
            pool=left.pool,
        )
    if isinstance(right, Songs):
        number = float(left)
        return Songs(
            {k: _apply(op, number, v) for k, v in right.values.items()},
            right.absent,
            side=right.side,
            pool=right.pool,
        )
    return _apply(op, float(left), float(right))


def _apply(op: Callable[[float, float], float], a: float, b: float) -> float:
    try:
        return op(a, b)
    except ZeroDivisionError as error:
        raise GateError("division by zero") from error


def _require_paired(run: Songs, base: Songs) -> None:
    """ERROR on a baseline song the run LOST the value of, or did not measure at all."""
    lost = sorted(key for key in base.values if key in run.absent)
    if lost:
        raise GateError(f"{_named(lost)} had a value in the baseline and has none in this run (refused?)")
    _require_measured(base.keys() - run.keys())


def _require_measured(unmeasured: Iterable[tuple[str, str]], address: _Address | None = None) -> None:
    """ERROR on (mode, song) keys the baseline has and the run does not — a comparison it cannot make."""
    missing = sorted(unmeasured)
    if missing:
        where = f"{address}: " if address is not None else ""
        raise GateError(
            f"{where}the baseline has {_named(missing)}, which this run did not measure; a comparison over "
            "them would pass vacuously"
        )


def _named(keys: Iterable[tuple[str, str]]) -> str:
    """`song (mode), ...` for an error message, five at most."""
    listed = sorted(keys)
    return ", ".join(f"{song} ({mode})" for mode, song in listed[:5]) + (" ..." if len(listed) > 5 else "")


def _song_set(view: View, mode: str, group: str) -> frozenset[str] | None:
    """The songs `view` measured under `mode` in `group`, or None when it keeps no per-song data."""
    entries = view.songs.get(mode)
    if entries is None:
        return None
    return frozenset(song for song, entry in entries.items() if group == "all" or entry.get("group") == group)
