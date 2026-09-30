#!/usr/bin/env python
"""End-to-end alignment bench: the SHIPPED `time_text` and `run_align` over the corpus, under claim noise.

    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/e2e.py      # truth,jit,blind
    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/e2e.py --modes all
    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/e2e.py \\
        --modes truth,jit+off15,blind+headers --songs hello,jamendo --model WAV2VEC2_ASR_BASE_960H
    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/e2e.py --level run_align \\
        --modes all --compare <base>/summary.json --gates <wave>.yaml

THE GATE, NOT A DEMO. Every later alignment wave is accepted or rejected on this harness's numbers, so it
measures the production path rather than a reimplementation of it (review M14: the old 32-song headline
came from an uncommitted /tmp script that fed truth as the claims and synthesised durations):

  * the real `time_text` (level `time_text`) — generate, never-sung drop, R3/R4/R1/R2 repairs, `_clamped`,
    the envelope gate, grading — with nothing stubbed but the job reporter;
  * a vocals stem SEPARATED from each song's mix as the target and that mix as R4's witness, as a stems
    job leaves them. For the 3 tfr songs that needs `--prepare-tfr` once (htdemucs over the worker's own
    `youtube-mix.wav`); `--tfr-audio reference` runs them on the producer's ORACLE stems instead, which is
    what the review's baseline did (review M14) and is kept only to reproduce it. `--no-stem` runs every
    case STEMLESS instead — no stem at all, so the MIX is the align target, exactly as production runs a
    song whose stems job could not separate one (`TimeTextDriver.target_of`). Every corpus song HAS a
    stem, so that flag is the only way the mix's own path is measurable: its lexical bands, its missing R4
    witness, its unavailable ALIGN_ON_MIX knob and its declining LINE_SYNC rung;
  * real durations, read from the vocals file (as the review's harness did — the baseline depends on it);
  * the worker `Config` from the environment (`Config.from_env`), so an `ENCORE_ALIGN_*` setting reaches
    the shipped code exactly as in production, and is recorded (`e2e_lib.align_config`);
  * claims built per MODE (`e2e_lib.build_claims`): truth, jitter, offsets, tempo, partial sheets, an
    extra verse, headers, a credit line, no timings at all, and another song's sheet.

LEVELS. `time_text` is one shipped attempt per case. `run_align` is the WHOLE JOB: the real
`workflows.align.run_align` — text acquisition, `Search`, `policy.decide`, retimes, the ASR fallback,
publish — over a harness `AlignSteps` (`RecordingSteps`) that delegates every call to the real
`AlignStepsImpl`. Only the PORTS under it are the harness's: an authored caption track serving the case's
timed claims (`captions:authored`, cleaned by `clean_segments` exactly as the yt-dlp adapter cleans its
cues), an LRCLIB-shaped provider serving an untimed sheet for `blind` modes (cleaned the same way), a
probe returning the stem's duration, the stem placed at the
conventional `derived/stems/<id>-vocals.wav` key a stems job leaves, and no transcriber unless `--asr
whisper`. So the TextRefs, tiers, labels and timing flags are built by production's own `fetch_*` code,
and every policy retry — ALIGN_ON_MIX on thin coverage (review H2), LINE_SYNC, NextText, GiveUp — runs
and is recorded per case: which attempts ran with which knobs, what each scored, and which one
published. `generate` is the raw global decode alone. Attempt 1 at `run_align` is the `time_text` call.

TWO HARNESS-ONLY SEAMS, neither of which changes what the shipped code computes:

  1. `BenchAligner` subclasses the shipped `WhisperXAligner`: `--model` is the bundle the SHIPPED adapter
     takes as an argument (W4b 6b's `ENCORE_ALIGN_MODEL`, which `main` reads when `--model` is absent), so an
     unnamed run resolves to this device's shipped default exactly as `ml.build_aligner` resolves it — the
     BASE bundle on every device today, W4b's sweep having rejected the HuBERT flip as a default — and a
     candidate bundle is named on the command line. `emissions()` is wrapped by a DISK cache under
     `$ENCORE_BENCH_ROOT/_emissions` (see `e2e_lib.EmissionStore` for the key; its model part is a digest
     of the weights the aligner actually loaded). A cold full sweep spends most of its time in the model
     pass; warm, it is the decode and repairs only. `--verify-cache` proves a cached matrix yields the
     byte-identical document a fresh one does. It also records every exception `emissions()` raises, and
     a case during which one did — or during which `time_text` declined on a caught fault — is an ERROR
     row, never the refusal `time_text` reports it as (`case_fault`).
  2. `capture_generated()` wraps `Generated.as_doc` to record WHICH input line each published line is, and
     each word's provenance. The published document carries neither — and pairing published lines back to
     truth by text mis-pairs a repeated chorus as soon as a line is dropped or injected (the F1-style
     mispairing the drop/extra-verse/header modes would otherwise hit on every run).

OUTPUT: `<out>/rows.jsonl` (one row per case, raw per-line and per-word errors, so the summary is
recomputable — `--summarize`), `<out>/summary.json` (metrics per mode x {jamendo, youtube, all} with
song-bootstrap 95% intervals, per-song metrics and document digests, and run metadata incl. wall time per
mode), every written document under `<out>/media/`, and the table printed per mode. `--compare BASE`
prints deltas against another summary and `--gates FILE` evaluates a wave's reject-if list
(`e2e_gates.py` documents the gate language); a failing gate, or any ERROR row, exits 3.

LONG RUNS: a full `--modes all` sweep is tens of minutes. Run it in the background and poll the log;
`--resume` continues an interrupted `--out` — only under the same settings AND the same code: each row
carries a fingerprint of the worker package and the harness (`code_fingerprint`), and a resume across a
code change is refused, since HEAD stays one commit for a whole uncommitted wave. ONE bench at a time:
parallel runs thrash the accelerator (~75 s vs 3.4 s per song-mode, measured by the review).

CHECKED LIKE WORKER CODE, though outside the worker gate's file list (the pure half is also exercised by
`worker/tests/test_bench_e2e.py`, which is in it):

    cd worker && .venv/bin/ruff check ../docs/benchmarks/forced-alignment/scripts/e2e*.py \
        && .venv/bin/ruff format --check ../docs/benchmarks/forced-alignment/scripts/e2e*.py \
        && .venv/bin/mypy --strict ../docs/benchmarks/forced-alignment/scripts/e2e*.py
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import dataclasses
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import warnings
from collections import Counter
from collections.abc import Callable, Iterator, Mapping, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
try:
    import encore_worker  # noqa: F401 - probe: the worker venv normally has it installed
except ImportError:  # pragma: no cover - only when run with a python that lacks the editable install
    sys.path.insert(0, str(REPO / "worker"))

import e2e_gates as gates  # noqa: E402 - after the path setup above
import e2e_lib as lib  # noqa: E402

from encore_worker.adapters import ml, ports  # noqa: E402
from encore_worker.adapters.ml import Emissions, WhisperXAligner  # noqa: E402
from encore_worker.artifacts import keys  # noqa: E402
from encore_worker.domain.lyrics import lexical  # noqa: E402
from encore_worker.domain.lyrics.clean import clean_line, clean_segments  # noqa: E402
from encore_worker.domain.lyrics.policy import Tier  # noqa: E402
from encore_worker.host.config import Config, ConfigError  # noqa: E402
from encore_worker.protocol.vocabulary import Stage, SyncMode  # noqa: E402
from encore_worker.steps.align_steps import Adapters, AlignStepsImpl  # noqa: E402
from encore_worker.steps.api import store_ref  # noqa: E402
from encore_worker.steps.records import (  # noqa: E402
    TIMING_LINE,
    TIMING_WORD,
    AlignOutcome,
    AudioRef,
    JobRef,
    Refused,
    Segment,
    TextRef,
    TimedDoc,
    TimeRequest,
)
from encore_worker.workflows.align import run_align  # noqa: E402

if TYPE_CHECKING:
    from encore_worker.domain.lyrics.generate import Generated

#: `time_text` is the shipped attempt; `run_align` the whole job (workflow + Search + policy) over
#: corpus-backed ports; `generate` the raw global decode alone (see the drivers).
LEVELS = ("time_text", "run_align", "generate")

#: `--sync-mode`: the `syncMode` a `run_align` job carries — core's two (`protocol.vocabulary.SyncMode`).
#: `lines` is where the LINE_SYNC rung is each text's ONLY attempt, so it is the level that measures the
#: rung's gate on every timed text rather than on the few forced mode degrades to it (W1 review r2 had to
#: wrap this harness in a scratch script to ask it).
SYNC_FORCED, SYNC_LINES = SyncMode.FORCED.value, SyncMode.LINES.value
SYNC_MODES = (SYNC_FORCED, SYNC_LINES)


# ── seams ─────────────────────────────────────────────────────────────────────────────────────────────

#: One reporter `state` call: (job id, state, attempt, verdict, why, knob).
Note = tuple[str, str, int, str, str, str | None]


def global_verdict(states: Sequence[Note]) -> tuple[str, str]:
    """(verdict, why) of the last `align-global` note among `states` — e2e2's verdict read."""
    for _job, state, _attempt, verdict, why, _knob in reversed(states):
        if state == "align-global":
            return verdict, why
    return "?", ""


def line_sync_note(states: Sequence[Note]) -> tuple[str, str] | None:
    """(verdict, why) of the last `align-line-sync` note among `states`, or None when the rung did not run.

    The LINE_SYNC rung writes no `align-global` note, so `global_verdict` reads `?` for it; its own note
    carries the gate's whole reading (the sheet-span fit, the lexical lift, the decode's agreement with the
    claims) and its verdict (`line-sync`, `refused`, `declined`). W1 review r2 could read it only through a
    scratch wrapper around this harness; rows carry it now (`line_sync_verdict` / `line_sync_why`, per
    attempt at `run_align`).
    """
    for _job, state, _attempt, verdict, why, _knob in reversed(states):
        if state == "align-line-sync":
            return verdict, why
    return None


def line_sync_fields(states: Sequence[Note]) -> dict[str, str]:
    """`line_sync_verdict` / `line_sync_why` of `states`' LINE_SYNC note, or {} when the rung did not run."""
    note = line_sync_note(states)
    return {} if note is None else {"line_sync_verdict": note[0], "line_sync_why": note[1]}


def repair_faults(states: Sequence[Note]) -> list[str]:
    """Every `repair-faults` note among `states`: window re-decodes that RAISED and kept their originals.

    Recorded per row because a swallowed repair fault looks exactly like a repair nobody needed (review
    L8), and the bench is where a real-audio fault would first show.
    """
    return [why for _job, state, _attempt, verdict, why, _knob in states if verdict == "repair-faults"]


#: The `align-global` decline reasons `time_text` gives when something RAISED — the emissions, `generate`,
#: the re-decode after a never-sung drop — rather than when it JUDGED the text. The bench must not score
#: one as a refusal, because a refusal row counts its lines as missing and a refused wrong text as
#: correctly refused. Since W1 (review M7) the shipped adapters TYPE the machinery's faults (a model that
#: will not load, a gone kernel, a device fault or out-of-memory, audio ffmpeg will not decode) and
#: `time_text` RAISES them, so they are ERROR rows through the drivers' exception path. What still
#: declines here is a decoder refusing a text (more characters than frames), a language with no model, a
#: domain defect, or a fault the adapter did not type (this harness's own cache): kept an ERROR, which is
#: the side that gets looked at, since the 32-song baseline has none of them. "audio unreadable for the
#: envelope:" is v2's reason, kept so an older run's states still read as the fault they were.
FAULT_DECLINES = ("decode failed:", "audio unreadable for the envelope:", "re-decode after drop failed:")

#: A lexical check's own caught fault: its decode or emission pass RAISED (anything but an `InfraFault`). The
#: LINE_SYNC rung (W1 review r2) then publishes on the sheet gate alone, saying so in its `line-sync` note;
#: the global engine (W3) leaves the text to the envelope gate alone, saying so in its verdict note or in
#: the envelope gate's refusal. Scored as that document (or refusal), a decoder that raises on some texts
#: would read as a check that passed (or refused) them, so it is an ERROR row too.
FAULT_LEXICAL = "no lexical check: it raised"

#: The LINE_SYNC rung's timing check's own caught fault (W3): its blind decode, or the emission pass under it,
#: RAISED (anything but an `InfraFault`), so the sheet-span gate decided in its place, saying so in the note.
#: Scored as that document or refusal, it would read as a timing check that ran: an ERROR row, like
#: `FAULT_LEXICAL`, whatever the rung's verdict.
FAULT_DECODE = "no decode check: it raised"


def fault_declines(states: Sequence[Note]) -> list[str]:
    """Every note among `states` that is a caught exception (`FAULT_DECLINES`, `FAULT_LEXICAL`,
    `FAULT_DECODE`), not a judgement. A LINE_SYNC note counts whatever its verdict: since W3 a check that
    raised hands the text to another gate, which may publish it or refuse it."""
    return [
        why
        for _job, state, _attempt, verdict, why, _knob in states
        if (state == "align-global" and verdict == "declined" and why.startswith(FAULT_DECLINES))
        or (state == "align-line-sync" and (FAULT_LEXICAL in why or FAULT_DECODE in why))
        or (state == "align-global" and FAULT_LEXICAL in why)
    ]


def emission_faults(aligner: object) -> list[str]:
    """The aligner's recorded emission faults (`BenchAligner.faults`), or [] for one that keeps none."""
    faults = getattr(aligner, "faults", None)
    return [str(f) for f in faults] if isinstance(faults, list) else []


def case_fault(states: Sequence[Note], emitted: Sequence[str]) -> str | None:
    """The ERROR note for a case during which something raised and was caught, else None.

    `emitted` is what the aligner's `faults` gained during the case: an emissions fault R4 swallowed
    (`mix-witness-declined`) publishes a document WITHOUT the repair, which no decline reason shows.
    """
    parts = [*(f"emissions raised: {fault}" for fault in emitted), *fault_declines(states)]
    if not parts:
        return None
    return "a fault time_text caught, not a verdict: " + "; ".join(parts)


class Trail:
    """The job reporter, as a recorder: `time_text`'s verdict and every decline reason land here."""

    def __init__(self) -> None:
        self.states: list[Note] = []

    async def progress(self, job_id: str, stage: Stage, pct: int) -> None:
        return None

    async def state(
        self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        self.states.append((job_id, state, attempt, verdict, why, knob))

    async def confirm_ownership(self, job_id: str, *, timeout_sec: float = 10.0) -> bool:
        return True

    def explain_ownership(self, job_id: str) -> str:
        return ""

    def last_global(self) -> tuple[str, str]:
        return global_verdict(self.states)


def default_model(language: str, device: str = "cpu") -> str:
    """The bundle a run with NEITHER `--model` nor `ENCORE_ALIGN_MODEL` loads — the shipped choice.

    For English that is `ml.default_align_model(device)`, exactly what `ml.build_aligner` resolves for a
    worker whose `ENCORE_ALIGN_MODEL` is unset, because the harness is built the way the host builds its
    aligner and a default the bench did not follow would measure a configuration nobody ships.
    WHICH BUNDLE THAT IS TODAY:
    `WAV2VEC2_ASR_BASE_960H` on cpu, mps AND cuda — W4b 6b made the bundle a setting and its corpus sweep then
    REJECTED the HuBERT-Large flip as a default (`gates/w4b.yaml`, `gates/w4b-hubert.yaml`), so
    `ml.ALIGN_MODELS_BY_DEVICE` is empty and the per-device mechanism is kept for the row a CUDA sweep would
    earn. This docstring said "HuBERT-Large, XLarge on CUDA" until W4b review r1, which is what a later wave
    would have read an unnamed run as having loaded. Every other language keeps whisperx's own table, the way
    `ml.align_model_name` reads it. To measure ANOTHER bundle — the HuBERT candidates, or one under
    recalibration — name it: `--model HUBERT_ASR_LARGE`, or set `ENCORE_ALIGN_MODEL`, which `main` now honours
    the way the worker does (review r1: it was recorded and not loaded).
    """
    if language == ml.ENGLISH:
        return ml.default_align_model(device)
    from whisperx.alignment import DEFAULT_ALIGN_MODELS_HF, DEFAULT_ALIGN_MODELS_TORCH  # noqa: PLC0415

    name = DEFAULT_ALIGN_MODELS_TORCH.get(language) or DEFAULT_ALIGN_MODELS_HF.get(language)
    return str(name or f"default:{language}")


def resolve_bundle(named: str | None, config: Any, language: str) -> tuple[str | None, str | None]:
    """(the bundle this run ALIGNS on, a refusal) — `--model`, else `ENCORE_ALIGN_MODEL`, else None meaning
    "this device's shipped default" (`default_model`, which `BenchAligner` resolves the way `ml.build_aligner`
    does).

    WHY THE ENV KNOB IS READ HERE (W4b review r1). `main` builds `Config.from_env()` so an `ENCORE_ALIGN_*`
    knob reaches the shipped code, and `e2e_lib.align_config` used to RECORD `align_model` in a run's
    `run.json` — but nothing loaded it: the bundle came from `--model` alone. So the command README.md and
    `Config.align_model`'s own docstring both give as the way to sweep a non-default bundle
    (`ENCORE_ALIGN_MODEL=HUBERT_ASR_LARGE … e2e.py --modes all`) recorded a HuBERT run that had aligned on the
    base model, after paying a 2-3 hour sweep for it. One resolution, used for the label, the emission store's
    key and the aligner, is what makes the recorded name and the loaded weights the same fact.

    THE TWO SPELLINGS ARE NOW ONE FINGERPRINT TOO (W4b review r2): the resolved bundle is recorded as
    `run.json`'s `model`, as the summary's `model` + `model_identity` and in the emission store's own key,
    and `e2e_lib.SPELLING_ONLY` keeps `align_model` OUT of `align_config` — so `--model X` and
    `ENCORE_ALIGN_MODEL=X` produce the same `emitter_fingerprint`, reuse the same 64 matrices and no longer
    warn against each other on `--compare` (`pinned in tests/test_bench_e2e.py`).

    AN UNCALIBRATED BUNDLE IS ANNOUNCED, NOT REFUSED (W4b review r2, spec-13). Production refuses to start on
    one (`__main__.align_model_for` — `lexical.is_calibrated`), but the wave's procedure is
    measure-then-paste-the-row, so the FIRST sweep of a new bundle is uncalibrated by construction and the
    harness has to be able to run it. `main` prints `uncalibrated_banner` and records `uncalibrated` in
    `run.json` and in the summary's meta instead, so no reader mistakes such a run's `wrongtext_pass` or
    `lift` columns for that bundle's (`e2e_gates` ERRORs any gate that reads them).

    ENGLISH ONLY, as production applies it (`ml.ENGLISH`; the bundle is a constructor argument on
    `WhisperXAligner` and every other language keeps whisperx's own table), so the knob cannot mislabel a
    French run.

    REFUSED WHEN BOTH NAME A BUNDLE AND DISAGREE, the way `resume_refusal` refuses a blended run: silently
    preferring either one would make the same command mean different things on two boxes.
    """
    from_env = getattr(config, "align_model", None) if language == ml.ENGLISH else None
    if named and from_env and named != from_env:
        return None, (
            f"--model {named} disagrees with ENCORE_ALIGN_MODEL={from_env}: a run measures ONE bundle, and "
            "both would be recorded. Drop one of the two."
        )
    return (named or from_env), None


def uncalibrated_banner(model: str) -> str | None:
    """The loud stderr banner for a run whose bundle has no `lexical.CALIBRATED` row, or None when it has one.

    THE ONE PLACE THE HARNESS IS MORE PERMISSIVE THAN PRODUCTION, and deliberately (W4b review r2, spec-13):
    `__main__.align_model_for` REFUSES to start a worker on an uncalibrated bundle, but this wave's procedure
    is measure-then-paste-the-row (`lexical`'s module docstring), so the first corpus run of a new bundle is
    uncalibrated by construction. What must not happen is that its numbers read like a calibrated bundle's:
    with no row `align_steps._word_lift` returns no lift, the wrong-text verdict falls back to the sheet-span
    envelope gate — 125/320 wrongtext passes on this corpus — and a `wrongtext_pass` of 0.00 would be recorded
    under the new bundle's name as if its floor had held. So the banner names the bundle, says what stood down
    and names the fix, `run.json` and the summary's meta carry `uncalibrated: true`, and `e2e_gates` ERRORs any
    gate that reads a metric the stand-down moved (`e2e_gates.UNCALIBRATED_METRICS`).
    """
    if lexical.is_calibrated(model):
        return None
    return (
        f"!! {model} HAS NO LEXICAL CALIBRATION ROW — every emission-scale gate stands down on this run.\n"
        f"!! {lexical.uncalibrated(model)}\n"
        "!! So this run's wrongtext_pass / lift columns are the sheet-span envelope gate's readings, NOT this "
        "bundle's (the envelope gate passes 125/320 wrong texts on this corpus). The rows are marked "
        "`uncalibrated` and any gate reading them is an ERROR.\n"
        "!! Production would REFUSE to start on it (encore_worker.__main__.align_model_for); measure first "
        "(scripts/lift_gate.py --model, scripts/line_gate.py --model), paste the row, then sweep."
    )


def emitter_versions(
    packages: Sequence[str] = ("torch", "torchaudio", "whisperx", "transformers"),
) -> dict[str, str]:
    """The library versions, and the ffmpeg build, that shape an emission matrix or a transcript.

    ffmpeg because `WhisperXAligner.emissions` reads audio through `whisperx.load_audio`, which shells the
    `ffmpeg` on PATH to decode AND resample (a `brew upgrade ffmpeg` can move a resampler or an mp3
    decoder, and the Jamendo mixes R4 reads are mp3), while `time_text`'s envelope decodes fresh on every
    run — a stale matrix would be scored against a fresh envelope. transformers because it runs any Hub
    checkpoint (`--model <org/name>`, the non-English lanes). Absent is recorded as such, never skipped.
    """
    from importlib.metadata import PackageNotFoundError, version  # noqa: PLC0415

    from encore_worker.host import ffmpeg  # noqa: PLC0415

    versions: dict[str, str] = {}
    for package in packages:
        try:
            versions[package] = version(package)
        except PackageNotFoundError:
            versions[package] = "absent"
    binary = shutil.which("ffmpeg")
    versions["ffmpeg"] = (ffmpeg.probe_version(binary) or "unrunnable") if binary else "absent"
    return versions


def emitter_sources() -> list[Path]:
    """The worker files that produce emissions: `WhisperXAligner.emissions`' module and its import closure."""
    import inspect  # noqa: PLC0415

    import encore_worker  # noqa: PLC0415 - the package this process actually imported

    source = inspect.getsourcefile(WhisperXAligner.emissions)
    if source is None:  # pragma: no cover - only for a frozen / sourceless install
        raise RuntimeError("WhisperXAligner.emissions has no source file to fingerprint")
    return lib.module_closure(Path(source), Path(encore_worker.__file__).resolve().parent)


def emitter_fingerprint(config: object) -> str:
    """The code, library versions and worker settings that produce emissions (`e2e_lib.emitter_fingerprint`).

    THE `align_*` SETTINGS ARE IN IT because a PLAN-v3 arm that fails its gate ships default-off behind
    `ENCORE_ALIGN_EXPERIMENTS`, and an arm inside `WhisperXAligner.emissions` (W4 6a's frame grid and
    context trim) changes the matrix without changing the code, the weights or the audio: keyed on those
    alone, whichever of the knob-on and knob-off runs went first would serve the other its matrices, and the
    arm would read exactly like the baseline. Every `align_*` setting counts, not only the emission ones —
    one recompute per arm, in the safe direction. `config` is the `Config` the drivers run with (or any
    dataclass; `e2e_lib.align_config`).
    """
    versions = {**emitter_versions(), "align_config": json.dumps(lib.align_config(config), sort_keys=True)}
    return lib.emitter_fingerprint(emitter_sources(), versions)


class BenchAligner(WhisperXAligner):
    """The shipped aligner, with a `--model` override and a disk cache around `emissions()`.

    `read`: serve a stored matrix when one exists. `write`: `always` overwrites (`--emissions-cache
    refresh`), `missing` stores only what the store lacks (the default, and what `--verify-cache` needs so a
    PRE-EXISTING entry is what the cached run is compared against).

    THE CACHE IS KEYED ON WHAT WAS LOADED. Per language, `identify` names the model `_aligner` returns —
    by default `loaded_identity`, a digest of its class, dictionary and every weight — and the store's
    model part becomes `<label>@<identity>`. The label alone (`--model`, else the shipped per-device default)
    is the harness's GUESS at the model: a Hub checkpoint can update under a name, and the same label would
    then serve one model's matrices to another. The cost is one model load per language per run, even when
    every matrix is on disk.

    BUILT AS THE HOST BUILDS ITS ALIGNER: `ml.build_aligner(device=..., jobs=..., model=...)` passes the
    device, the box's job concurrency and the English bundle, and so does this; `test_bench_e2e` pins both
    signatures, so a factory argument that reaches production must be forwarded here too. `jobs` sizes the
    in-memory emission LRU (`ml._emission_cache_size`) and the bench runs one case at a time, so its default
    of 1 is the shipped default — it is forwarded rather than dropped because the disk store sits BESIDE that
    LRU, not over it, so a bench run's memory behaviour is the host's.

    `--model` IS NOT A SEAM ANY MORE (W4b): the shipped adapter takes the bundle as an argument now (review
    §3 item 6b's `ENCORE_ALIGN_MODEL`), so the override is simply the argument, resolved through
    `ml.default_align_model` when absent exactly as the factory resolves it — the BASE bundle on every device
    today, W4b's own sweep having rejected the HuBERT flip as a default. The subclass used to re-implement
    `_aligner` and `_bundle_name` to pass `model_name=`, which is how a harness ends up loading one model and
    naming another; `main` resolves `ENCORE_ALIGN_MODEL` into this argument (`resolve_bundle`) for the same
    reason — until W4b review r1 the knob was recorded in `run.json` and never loaded.

    EVERY FAULT IS RECORDED (`faults`). `time_text` lets the shipped adapter's typed `InfraFault` through
    (review M7) but declines any other emissions exception ("decode failed: ...") and, on R4's mix witness,
    publishes without the repair whatever it caught — so a full disk under `EmissionStore.save`, a corrupt
    `.npz`, or an out-of-memory on the mix alone would read as a refusal or as a clean document. The
    drivers turn any fault recorded during a case into an ERROR row.
    """

    def __init__(
        self,
        *,
        device: str,
        jobs: int = 1,
        model: str | None = None,
        store: lib.EmissionStore | None = None,
        read: bool = True,
        write: Literal["always", "missing"] = "missing",
        identify: Callable[[str], str] | None = None,
    ) -> None:
        super().__init__(device=device, jobs=jobs, model=model or ml.default_align_model(device))
        self._store = store
        self._read = read
        self._write = write
        self._identify = identify or self.loaded_identity
        self._memory: dict[tuple[str, str], Emissions] = {}
        self._stores: dict[str, lib.EmissionStore] = {}
        #: memory / disk / computed — how each emissions() call was served, for the run's metadata.
        self.served: Counter[str] = Counter()
        #: {language: identity} of every model the cache was keyed on — the summary's `model_identity`.
        self.identities: dict[str, str] = {}
        #: Every exception `emissions()` raised, `<file>: <Type>: <message>`, in call order (append-only;
        #: a driver reads what a case added — `emission_faults`).
        self.faults: list[str] = []

    def loaded_identity(self, language: str) -> str:
        """What `_aligner(language)` LOADED: class, pipeline type, dictionary and every weight, 16 hex."""
        import torch  # noqa: PLC0415

        model, metadata = self._aligner(language)
        digest = hashlib.sha256()
        dictionary = sorted((str(k), int(v)) for k, v in dict(metadata.get("dictionary") or {}).items())
        digest.update(
            json.dumps([type(model).__qualname__, str(metadata.get("type")), dictionary]).encode("utf-8")
        )
        with torch.inference_mode():
            for name, tensor in model.state_dict().items():
                flat = tensor.detach().to("cpu").contiguous().reshape(-1)
                digest.update(f"{name}:{tuple(tensor.shape)}:{tensor.dtype}".encode())
                digest.update(flat.view(torch.uint8).numpy())
        return digest.hexdigest()[:16]

    def store_for(self, language: str) -> lib.EmissionStore | None:
        """The store keyed on the identity of `language`'s loaded model (see the class docstring)."""
        if self._store is None:
            return None
        if language not in self._stores:
            identity = self._identify(language)
            self.identities[language] = identity
            self._stores[language] = self._store.for_model(f"{self._store.model}@{identity}")
        return self._stores[language]

    def emissions(self, audio_path: str, language: str) -> Emissions:
        try:
            return self._cached_or_computed(audio_path, language)
        except Exception as exc:
            self.faults.append(f"{Path(audio_path).name}: {type(exc).__name__}: {exc}")
            raise

    def _cached_or_computed(self, audio_path: str, language: str) -> Emissions:
        key = (os.path.realpath(audio_path), language)
        if key in self._memory:
            self.served["memory"] += 1
            return self._memory[key]
        emitted: Emissions | None = None
        store = self.store_for(language)
        if store is not None and self._read:
            stored = store.load(audio_path, language)
            if stored is not None:
                matrix, meta = stored
                log_probs: Any = matrix
                if meta.get("kind") == "torch":
                    import torch  # noqa: PLC0415 - the shipped decoder calls `.unsqueeze` on it

                    log_probs = torch.from_numpy(matrix)
                emitted = Emissions(log_probs=log_probs, **meta["fields"])
                self.served["disk"] += 1
        if emitted is None:
            emitted = super().emissions(audio_path, language)
            self.served["computed"] += 1
            if store is not None:
                digest, _parts = store.key(audio_path, language)
                if self._write == "always" or not store.path_of(digest).is_file():
                    fields = {
                        f.name: getattr(emitted, f.name)
                        for f in dataclasses.fields(emitted)
                        if f.name != "log_probs"
                    }
                    store.save(
                        audio_path,
                        language,
                        np.asarray(emitted.log_probs),
                        fields,
                        produced_on=self._device,
                        kind=type(emitted.log_probs).__module__.split(".")[0],
                    )
        self._memory[key] = emitted
        return emitted


@contextlib.contextmanager
def capture_generated() -> Iterator[list[Generated]]:
    """Every `Generated` rendered to a document while the block runs, in call order.

    A class-attribute wrap of `as_doc` that returns exactly what the original returns — the shipped code
    computes and writes the same bytes; the harness only learns each line's input index and each word's
    provenance, which the written document does not carry.
    """
    from encore_worker.domain.lyrics.generate import Generated  # noqa: PLC0415

    seen: list[Generated] = []
    original = Generated.as_doc

    def as_doc(self: Generated) -> dict[str, Any]:
        seen.append(self)
        return original(self)

    Generated.as_doc = as_doc  # type: ignore[method-assign]
    try:
        yield seen
    finally:
        Generated.as_doc = original  # type: ignore[method-assign]


@contextlib.contextmanager
def capture_lifts() -> Iterator[list[float | None]]:
    """Every `lexical.lift` the shipped gates computed while the block runs, in call order: its value, or None
    for a text the lift could not measure (under `lexical.MIN_LETTERS`, no order to contrast).

    A module-attribute wrap that returns exactly what the original returns — both lexical gates read
    `lexical.lift` at call time (`align_steps._measured_lift`), so they decide as they would unwrapped — and
    records the number at FULL PRECISION: the trail prints it to two decimals, and a lift of +0.195 prints
    `+0.20` and is refused at 0.2. A lift whose decode RAISED records nothing (the note says so, and the row
    is an ERROR: `FAULT_LEXICAL`). Exempt texts (the ASR tier) are never measured, so they add nothing.
    """
    from encore_worker.domain.lyrics import lexical  # noqa: PLC0415

    seen: list[float | None] = []
    original = lexical.lift

    def lift(*args: Any, **kwargs: Any) -> lexical.Lift | None:
        got = original(*args, **kwargs)
        seen.append(None if got is None else got.value)
        return got

    lexical.lift = lift
    try:
        yield seen
    finally:
        lexical.lift = original


#: (claim index, text as served) per segment of the request: what `time_text`'s line indexes point at.
Served = Sequence[tuple[int, str]]


def served_claims(claims: lib.Claims) -> tuple[tuple[Segment, ...], tuple[tuple[int, str], ...]]:
    """The claims as a production text ADAPTER hands them on, and the claim index of each kept segment.

    Every text adapter returns `clean_segments(...)` (yt-dlp captions `cli.py`, LRCLIB, lrcmux), so the
    `run_align` ports do too: text-hygiene work in `clean.py` (W5) must reach the scores. Measured on the
    corpus's truth: `clean_line` changes 660 of 1760 lines (636 YouTube lines lose `♪`; no Jamendo line
    changes its word count) and drops 14 — believer 1, shape-of-you 1, bad-guy 10, tfr-chosen 2. Dropping
    RENUMBERS the request, so each kept segment's claim index is returned for identity pairing.
    """
    segments = claims.segments()
    cleaned = clean_segments(segments)
    kept = tuple(
        (index, text)
        for index, segment in enumerate(segments)
        if (text := clean_line(str(segment.get("text") or "")))
    )
    if [text for _index, text in kept] != [str(s.get("text") or "") for s in cleaned]:  # pragma: no cover
        raise AssertionError("clean_segments no longer maps one segment to at most one; re-derive `kept`")
    return cleaned, kept


def doc_lines(
    doc: Mapping[str, Any],
    captured: Sequence[Generated],
    claims: lib.Claims,
    served: Served | None = None,
) -> tuple[list[lib.DocLine], str]:
    """The published lines with their identity, and how it was established (`captured` or `text`).

    The capture is matched to the written document by content (texts and starts), newest first, so a
    future `time_text` that renders more than one document (a best-so-far) still pairs with the right one.
    `served` maps the request's segments back to `claims.lines` when a port cleaned or dropped some
    (`served_claims`); without it the request IS the claims.
    """
    served = served if served is not None else [(i, c.text) for i, c in enumerate(claims.lines)]
    rendered = [line for line in doc.get("lines") or [] if isinstance(line, dict)]
    texts = [str(line.get("text") or "") for line in rendered]
    starts = [float(line.get("start") or 0.0) for line in rendered]
    for generated in reversed(captured):
        if [ln.text for ln in generated.lines] == texts and [ln.start for ln in generated.lines] == starts:
            out = []
            for line, raw in zip(generated.lines, rendered, strict=True):
                words = raw.get("words") or []
                known = len(words) == len(line.words)  # else a post-pass re-cut the words: use the score
                out.append(
                    lib.DocLine(
                        text=line.text,
                        start=float(raw["start"]),
                        end=float(raw["end"]),
                        confidence=raw.get("confidence"),
                        source=served[line.index][0],
                        words=tuple(
                            lib.DocWord(
                                float(w["start"]),
                                float(w["end"]),
                                line.words[k].provenance == "aligned" if known else _scored(w),
                                str(w.get("word") or ""),
                            )
                            for k, w in enumerate(words)
                        ),
                    )
                )
            return out, "captured"
    # FALLBACK (a line-synced doc; nothing rendered through as_doc): in-order text pairing, and a word is
    # taken as aligned unless its score is exactly 0.0 — what adopted and interpolated words carry. A
    # WORD-timed document landing here is the F1 mispairing this harness exists to avoid, so the drivers
    # turn it into an ERROR row (`unpaired_word_doc`).
    positions = lib.pair_by_text(texts, [text for _index, text in served])
    sources = [None if p is None else served[p][0] for p in positions]
    out = [
        lib.DocLine(
            text=text,
            start=start,
            end=float(raw.get("end") or start),
            confidence=raw.get("confidence"),
            source=source,
            words=tuple(
                lib.DocWord(float(w["start"]), float(w["end"]), _scored(w), str(w.get("word") or ""))
                for w in raw.get("words") or []
            ),
        )
        for text, start, raw, source in zip(texts, starts, rendered, sources, strict=True)
    ]
    return out, "text"


def _scored(word: Mapping[str, Any]) -> bool:
    """Aligned, judged from the document alone: adopted and interpolated words score exactly 0.0."""
    return float(word.get("score") or 0.0) != 0.0


def unpaired_word_doc(identity: str, timing: str) -> str | None:
    """The ERROR for a WORD-timed document whose identity fell back to text pairing, else None.

    `doc_lines` accepts a capture only when its texts and starts equal the written document's exactly, so
    any later post-pass that edits the dict after `as_doc()` (ad-lib timing inside host lines, a doc-level
    re-cut) would silently turn every row into e2e2's text pairing: claims [A, A, B] with the first A
    dropped publish [A, B], and text pairing binds the surviving A to claim 0 when it is claim 1. Only a
    line-synced document, which never renders through `as_doc`, may pair by text.
    """
    if identity == "text" and timing == TIMING_WORD:
        return (
            "identity: a word-timed document matched no captured render, so its lines could only pair by "
            "text (the F1 mispairing); fix the capture before scoring"
        )
    return None


# ── one case ──────────────────────────────────────────────────────────────────────────────────────────


@dataclasses.dataclass(frozen=True, slots=True)
class Case:
    song: lib.Song
    mode: str
    variant: int

    @property
    def name(self) -> str:
        return self.mode if not self.variant else f"{self.mode}-{self.variant}"


class TimeTextDriver:
    """Level `time_text`: one `AlignStepsImpl.time_text` call per case, exactly as e2e2 made it.

    The claims go in RAW, as e2e2 sent them (the review reproduction depends on it), and the shipped
    `time_text` cleans nothing itself — only the text adapters call `clean_segments`. So a text-hygiene
    change in `clean.py` (W5's anchored header / credit stripping, M11) CANNOT move this level: its headers
    and credit rows read the same before and after. Measure one at `--level run_align`, whose ports clean
    as production's adapters do, against `results/baseline-v2-run_align.json`.
    """

    level = "time_text"

    def __init__(
        self,
        *,
        aligner: WhisperXAligner,
        corpus: Sequence[lib.Song],
        media_root: Path,
        language: str = "en",
        seed: int = 0,
        wrong_k: int = lib.WRONG_K,
        config: Config | None = None,
        stem: bool = True,
    ) -> None:
        self.aligner = aligner
        self.corpus = list(corpus)
        self.media_root = media_root
        self.language = language
        self.seed = seed
        self.wrong_k = wrong_k
        #: The worker settings every `AlignStepsImpl` is built with. `main` passes `Config.from_env()`, so
        #: an `ENCORE_ALIGN_*` knob reaches the shipped code; a bare `Config()` would silently measure the
        #: default path with the knob set (tests pass a literal, as the worker's own tests do).
        self.config = config if config is not None else Config()
        #: False under `--no-stem`: the case runs as a STEMLESS song (see `target_of`).
        self.stem = stem
        self._durations: dict[str, float] = {}

    def duration_of(self, song: lib.Song) -> float:
        """Seconds of the VOCALS file (e2e2's choice; production probes the source, within a frame).

        The vocals file EVEN UNDER `--no-stem`, where the aligner never reads it: it was separated from
        this mix, so the two are the same length, and one number keeps a stemless row comparable with its
        stem row case for case — the claims are built from it (`lib.build_claims`, whose tempo and offset
        modes scale by the duration), so a second reading would change the CLAIMS as well as the target.
        """
        if song.slug not in self._durations:
            import soundfile as sf  # noqa: PLC0415

            info = sf.info(str(song.vocals))
            self._durations[song.slug] = info.frames / info.samplerate
        return self._durations[song.slug]

    def target_of(self, song: lib.Song) -> str:
        """The file the aligner decodes: the vocals stem, or the MIX when the case is stemless.

        `--no-stem` (`stem=False`) is the harness's STEMLESS dimension, composable with every claim mode:
        the case is run exactly as production runs a song no stems job could separate — `vocals_path` is
        None, so `AudioRef.align_target` is the mix, R4 has no second witness (the mix IS the target),
        `Knob.ALIGN_ON_MIX` is never offered (`Search.aligned_on_stem`), the LINE_SYNC rung declines
        (`_time_line_sync`), and the lexical gate reads the MIX bands, where SINCE W4 REVIEW R1 THE FLOOR
        IS THE VERDICT and the envelope fit is only reported (`lexical.BANDS`, MIX). The two controls are
        `h3-mix-envelope` (W3's default: the envelope gate alone, the floor grading — the row is
        `results/w4-stemless-envelope-time_text.json`) and `h3-mix-floor` (both gates, which is also what
        setting both names means). No corpus song LACKS a stem, so this mode is the only way that band and
        those arms are measurable at all — W3 shipped its mix decision on the lift population alone
        (`results/w3-lift-mix.json`), and this mode is what flipped it.
        """
        return str(song.vocals if self.stem else song.mix)

    def claims_for(self, case: Case) -> lib.Claims:
        return lib.build_claims(
            case.song,
            case.mode,
            corpus=self.corpus,
            duration_sec=self.duration_of(case.song),
            variant=case.variant,
            seed=self.seed,
            wrong_k=self.wrong_k,
        )

    def run(self, case: Case) -> dict[str, Any]:
        claims = self.claims_for(case)
        media_dir = self.media_root / case.song.slug / case.name
        # `work/`: since W1 review r1 the attempts are staged in job scratch, not `derived/lyrics/`.
        for sub in ("derived", "work"):
            shutil.rmtree(media_dir / sub, ignore_errors=True)
        media_dir.mkdir(parents=True, exist_ok=True)
        trail = Trail()
        impl = AlignStepsImpl(config=self.config, adapters=Adapters(aligner=self.aligner), reporter=trail)
        job = JobRef(
            job_id=case.song.slug, media_id=case.song.slug, media_dir=str(media_dir), source_uri=None
        )
        audio = AudioRef(
            path=str(case.song.mix),
            vocals_path=str(case.song.vocals) if self.stem else None,
            duration_sec=self.duration_of(case.song),
        )
        text = TextRef(
            tier=Tier.CANDIDATE,
            label=claims.label,
            segments=claims.segments(),
            timing=TIMING_LINE if claims.timed else None,
        )
        request = TimeRequest(job=job, text=text, audio=audio, language=self.language)
        started = time.perf_counter()
        #: Digests and attempt-1 coverage are on EVERY row (None where there is nothing to digest), so the
        #: per-song `doc` / `onsets` / `coverage` exist for every song and W1's gate can read them.
        extra: dict[str, object] = {"doc_sha256": None, "onsets_sha256": None, "first_coverage": None}
        lines: list[lib.DocLine] = []
        faulted = len(emission_faults(self.aligner))
        lifts: list[float | None] = []
        try:
            with capture_generated() as captured, capture_lifts() as lifts:
                result = asyncio.run(impl.time_text(request))
        except Exception as exc:  # noqa: BLE001 - one broken case must not lose a 40-minute sweep
            outcome, timed = lib.ERROR, None
            extra["exception"] = f"{type(exc).__name__}: {exc}"
        else:
            # A gate's `Refused` (W1) and a declined `None` are both a refusal of the text at this level.
            timed = result if isinstance(result, TimedDoc) else None
            if timed is None:
                outcome = lib.REFUSED
                extra["first_coverage"] = 0.0
            else:
                outcome = lib.LINE_SYNC if timed.timing == TIMING_LINE else lib.PUBLISHED
                extra.update(
                    confidence=timed.confidence,
                    ref=str((media_dir / timed.ref).relative_to(self.media_root)),
                    report_words=timed.report.words,
                    coverage=round(timed.report.coverage, 4),
                    first_coverage=round(timed.report.coverage, 4),
                )
                try:
                    body = (media_dir / timed.ref).read_bytes()
                    lines, identity = doc_lines(json.loads(body), captured, claims)
                    extra.update(identity=identity, doc_sha256=lib.doc_digest(body))
                    extra["onsets_sha256"] = lib.onset_digest(lines)
                    unpaired = unpaired_word_doc(identity, timed.timing)
                    if unpaired is not None:
                        outcome, lines = lib.ERROR, []
                        extra["exception"] = unpaired
                except Exception as exc:  # noqa: BLE001 - an unscoreable doc is an ERROR row, not a crash
                    outcome, lines = lib.ERROR, []
                    extra["exception"] = f"scoring: {type(exc).__name__}: {exc}"
        fault = case_fault(trail.states, emission_faults(self.aligner)[faulted:])
        if fault is not None and outcome != lib.ERROR:
            outcome, lines = lib.ERROR, []
            extra["exception"] = fault
        verdict, why = trail.last_global()
        extra.update(verdict=verdict, why=why, seconds=round(time.perf_counter() - started, 2))
        extra["repair_faults"] = repair_faults(trail.states)
        # The lexical gate's reading (None: exempt, unmeasurable, or it raised — the `why` says which).
        extra["lift"] = lifts[-1] if lifts else None
        return lib.row_of(
            song=case.song,
            mode=case.mode,
            variant=case.variant,
            claims=claims,
            outcome=outcome,
            doc=lines,
            extra=extra,
        )


class GenerateDriver(TimeTextDriver):
    """Level `generate`: the raw global decode ALONE — no never-sung drop, no repairs, no gate, no grading.

    `bench.py --global --words`' path, kept here so a DECODER change can be told apart from a LADDER change.
    The review's blind Jamendo word figures are this level (±100 78.7 / ±250 90.5 / ±300 91.3, bias +4 ms,
    141/5693 words >2 s). Through `time_text` the never-sung rule drops 2 Jamendo lines (Quentin_Hannappe
    "how many gonna stand", Ridgway "whoa oh oh oh oh" — 9 words; raw places the Ridgway line -40.25 s off)
    and re-decodes, which reads 78.8 / 90.5 / 91.3, +4 ms, 139 >2 s on the review's own documents.

    Claimed timings never enter `generate()`, so a timed mode equals its text-only twin here; every line is
    ungraded (confidence None), so the `high` columns read 0.

    THE ONE ARM THAT REACHES THIS LEVEL is 6c's line separator (`linesep`, review D1): it is an argument to
    `generate` itself, so the raw decode is where its factorial is read (`gates/w4b-linesep.yaml`). Every
    other `align_experiments` name lives in the ladder above this call and is inert here — which is the point
    of measuring a decoder change at this level, and the reason the arm is threaded from `self.config` rather
    than from a flag of its own: one setting, recorded once, in `align_config`.
    """

    level = "generate"

    def run(self, case: Case) -> dict[str, Any]:
        from encore_worker.adapters.ml import forced_align_decoder  # noqa: PLC0415
        from encore_worker.domain.lyrics.generate import generate  # noqa: PLC0415

        claims = self.claims_for(case)
        started = time.perf_counter()
        extra: dict[str, object] = {"verdict": "generate", "why": "", "onsets_sha256": None}
        lines: list[lib.DocLine] = []
        try:
            emissions = self.aligner.emissions(self.target_of(case.song), self.language)
            generated = generate(
                [line.text for line in claims.lines],
                emissions,
                decoder=forced_align_decoder,
                language=self.language,
                separate_lines="linesep" in self.config.align_experiments,
            )
        except Exception as exc:  # noqa: BLE001 - one broken case must not lose the sweep
            outcome = lib.ERROR
            extra["exception"] = f"{type(exc).__name__}: {exc}"
        else:
            lines = [
                lib.DocLine(
                    text=line.text,
                    start=line.start,
                    end=line.end,
                    confidence=None,
                    source=line.index,
                    words=tuple(
                        lib.DocWord(w.start, w.end, w.provenance == "aligned", w.word) for w in line.words
                    ),
                )
                for line in generated.lines
            ]
            outcome = lib.PUBLISHED if lines else lib.REFUSED
            # No document is written at this level, so no `doc` digest; the onsets are the decoder's.
            extra["onsets_sha256"] = lib.onset_digest(lines) if lines else None
        extra["seconds"] = round(time.perf_counter() - started, 2)
        return lib.row_of(
            song=case.song,
            mode=case.mode,
            variant=case.variant,
            claims=claims,
            outcome=outcome,
            doc=lines,
            extra=extra,
        )


# ── level run_align: the real workflow over corpus-backed ports ──────────────────────────────────────


class ClaimCaptions:
    """`CaptionSource`: the case's TIMED claims as the upload's authored track; no machine track.

    Cues in the shape `adapters.captions` yields them — text/start/end, CLEANED (`clean_segments`, as
    `parse_vtt` returns them) — so `AlignStepsImpl.fetch_captions` builds the TextRef production builds:
    tier CANDIDATE, label `captions:authored`, line timing.
    """

    def __init__(self, cues: Sequence[Segment]) -> None:
        self._cues = clean_segments(cues)

    def fetch(self, source_uri: str, out_dir: str, *, automatic: bool) -> Sequence[Segment]:
        return () if automatic else self._cues


class ClaimProvider:
    """`LyricsProvider`: the case's UNTIMED text as an LRCLIB plain sheet (no starts, so `timing` None).

    Cleaned as `adapters.lrclib` cleans what it parses (`clean_segments`).
    """

    name = "lrclib"

    def __init__(self, cues: Sequence[Segment]) -> None:
        self._cues = clean_segments(cues)

    def fetch(self, *, artist: str, track: str, duration_sec: float | None) -> Sequence[Segment]:
        return self._cues


class FixedProbe:
    """`AudioProbe`: the song's duration as the `time_text` level reads it (the stem's), whatever the path.

    Production probes the SOURCE; the two agree within a frame on this corpus, and one number for both
    levels keeps attempt 1 of `run_align` byte-comparable with `time_text`.
    """

    def __init__(self, seconds: float) -> None:
        self._seconds = seconds

    def duration_sec(self, audio_path: str) -> float:
        return self._seconds

    def peak_dbfs(self, audio_path: str) -> float | None:
        return None


@dataclasses.dataclass(frozen=True, slots=True)
class AttemptLog:
    """One `time_text` call as `run_align` made it, captured at the moment it returned."""

    request: TimeRequest
    doc: TimedDoc | None
    #: The written document's bytes THEN. Before W1 a later ALIGN_ON_MIX attempt rewrote the same ref
    #: (review H2), so the file on disk could not say what an earlier attempt produced.
    body: bytes | None
    #: The `Generated` documents this attempt rendered — each line's input index, for identity pairing.
    generated: tuple[Generated, ...]
    #: The reporter notes this attempt emitted (its `align-global` verdict among them).
    states: tuple[Note, ...]
    seconds: float
    #: A gate's refusal reason when the attempt returned `Refused` (W1: it ends the text); None otherwise.
    refused: str | None = None
    #: Every `lexical.lift` this attempt's gates computed (`capture_lifts`), in call order.
    lifts: tuple[float | None, ...] = ()


def published_attempt(attempts: Sequence[AttemptLog], published: TimedDoc | None) -> int | None:
    """Which attempt's record the job published, or None.

    The workflow reports it under its STORE ref (`steps.api.store_ref`): since W1 every attempt is staged
    in job scratch and `publish` places it, so the published record is the attempt's own with only its ref
    moved. Matched as exactly that — the attempt whose store ref is the published ref, equal in every other
    field — and by identity first. A record that matches no attempt (a diarizer or a later step rebuilt
    it) is the caller's ERROR.
    """
    if published is None:
        return None
    for number, attempt in enumerate(attempts):
        if attempt.doc is published:
            return number
    for number, attempt in enumerate(attempts):
        doc = attempt.doc
        if doc is None or store_ref(attempt.request.job, doc.ref) != published.ref:
            continue
        if dataclasses.replace(doc, ref=published.ref) == published:
            return number
    return None


class RecordingSteps:
    """`AlignSteps` for level `run_align`: the REAL `AlignStepsImpl`, every call delegated unchanged.

    `time_text` and `transcribe` are additionally RECORDED (`attempts`, `transcriptions`); nothing a step
    returns is altered, so the workflow makes exactly the decisions it makes in production.
    """

    def __init__(
        self,
        impl: AlignStepsImpl,
        *,
        trail: Trail,
        captured: list[Generated],
        lifts: list[float | None] | None = None,
    ) -> None:
        self._impl = impl
        self._trail = trail
        self._captured = captured
        self._lifts: list[float | None] = lifts if lifts is not None else []
        self.attempts: list[AttemptLog] = []
        #: (on_vocals asked, whether it heard anything), in call order.
        self.transcriptions: list[tuple[bool, bool]] = []

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        return await self._impl.acquire_audio(job)

    async def fetch_captions(self, job: JobRef, *, automatic: bool) -> TextRef | None:
        return await self._impl.fetch_captions(job, automatic=automatic)

    async def fetch_provider_lyrics(self, job: JobRef, audio: AudioRef) -> TextRef | None:
        return await self._impl.fetch_provider_lyrics(job, audio)

    async def fetch_pinned_text(self, job: JobRef) -> TextRef | None:
        # Never reached: a bench job carries no pin (`pinnedRef` / `pinnedText`). Delegated like the rest.
        return await self._impl.fetch_pinned_text(job)

    async def transcribe(self, job: JobRef, audio: AudioRef, *, on_vocals: bool) -> TextRef | None:
        heard = await self._impl.transcribe(job, audio, on_vocals=on_vocals)
        self.transcriptions.append((on_vocals, heard is not None))
        return heard

    async def time_text(self, req: TimeRequest) -> TimedDoc | Refused | None:
        notes, rendered, lifted = len(self._trail.states), len(self._captured), len(self._lifts)
        started = time.perf_counter()
        result = await self._impl.time_text(req)
        doc = result if isinstance(result, TimedDoc) else None
        body = None
        if doc is not None:
            body = (Path(req.job.media_dir) / doc.ref).read_bytes()
        self.attempts.append(
            AttemptLog(
                request=req,
                doc=doc,
                body=body,
                generated=tuple(self._captured[rendered:]),
                states=tuple(self._trail.states[notes:]),
                seconds=round(time.perf_counter() - started, 2),
                refused=result.report.refused if isinstance(result, Refused) else None,
                lifts=tuple(self._lifts[lifted:]),
            )
        )
        return result

    async def diarize(self, job: JobRef, audio: AudioRef, doc: TimedDoc) -> TimedDoc:
        return await self._impl.diarize(job, audio, doc)

    async def publish(self, job: JobRef, doc: TimedDoc | None, *, placing: Sequence[TimedDoc] = ()) -> str:
        return await self._impl.publish(job, doc, placing=placing)

    async def note(
        self, job: JobRef, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        await self._impl.note(job, state, attempt, verdict, why, knob)


class RunAlignDriver(TimeTextDriver):
    """Level `run_align`: one `workflows.align.run_align` job per case (see the module docstring).

    The row's `outcome` is about the CLAIM TEXT, as at `time_text`: published / line-sync when the
    document the job published is that text's, else refused — even when the job went on to publish an
    ASR transcript, which has no identity to pair with truth and is reported under `terminal` /
    `published_label` instead. Attempt records carry per-attempt line scores, so an H2 swap (a clean
    stem document replaced by a worse mix one) reads straight off one row.

    WHAT IS SCORED IS THE FILE THE TV READS: `media_dir / published.ref` after the job returned, not the
    bytes the published attempt wrote when it returned. A stem attempt and its ALIGN_ON_MIX retry write
    the SAME ref (review H2), so a job that publishes attempt 1's record after attempt 2 overwrote its
    file — the shape of a partial W1 best-so-far — would show the room attempt 2's document while the
    bench scored attempt 1's. Such a row is an ERROR (`published_file_attempt` names whose bytes the
    file holds). The harness wires no diarizer, the one step that rewrites a published file on purpose.
    """

    level = "run_align"

    def __init__(
        self,
        *,
        aligner: WhisperXAligner,
        corpus: Sequence[lib.Song],
        media_root: Path,
        language: str = "en",
        seed: int = 0,
        wrong_k: int = lib.WRONG_K,
        config: Config | None = None,
        stem: bool = True,
        transcriber: ports.Transcriber | None = None,
        sync_mode: str = SYNC_FORCED,
    ) -> None:
        super().__init__(
            aligner=aligner,
            corpus=corpus,
            media_root=media_root,
            language=language,
            seed=seed,
            wrong_k=wrong_k,
            config=config,
            stem=stem,
        )
        self.transcriber = transcriber
        if sync_mode not in SYNC_MODES:
            raise ValueError(f"sync mode {sync_mode!r}; expected one of {', '.join(SYNC_MODES)}")
        #: The job's `syncMode` (`--sync-mode`). `lines` makes every text's only attempt the gated LINE_SYNC
        #: rung (`Search.line_only`); `forced` sends no `syncMode` at all, so a forced run's jobs are exactly
        #: the ones every earlier baseline ran.
        self.sync_mode = sync_mode

    def _media_dir(self, case: Case) -> Path:
        """A clean media dir with the stem at the conventional key a stems job publishes it under.

        UNDER `--no-stem` the key is left EMPTY, which is the whole stemless seam at this level: nothing is
        faked, `AlignStepsImpl._vocals_of` finds no file and returns None exactly as it does for a song whose
        stems job refused a silent instrumental, and every downstream decision follows from the AudioRef
        production would have built (`TimeTextDriver.target_of`).
        """
        media_dir = self.media_root / case.song.slug / case.name
        for sub in ("derived", "work", "attempts"):
            shutil.rmtree(media_dir / sub, ignore_errors=True)
        if not self.stem:
            media_dir.mkdir(parents=True, exist_ok=True)
            return media_dir
        ext = case.song.vocals.suffix.lstrip(".").lower()
        if ext not in keys.KNOWN_STEM_EXTS:
            raise ValueError(f"{case.song.vocals}: not a stem extension the worker looks for")
        stem = media_dir / keys.vocals_key(case.song.slug, ext)
        stem.parent.mkdir(parents=True, exist_ok=True)
        stem.symlink_to(os.path.abspath(case.song.vocals))
        return media_dir

    def run(self, case: Case) -> dict[str, Any]:
        claims = self.claims_for(case)
        started = time.perf_counter()
        extra: dict[str, object] = {"doc_sha256": None, "onsets_sha256": None, "first_coverage": None}
        lines: list[lib.DocLine] = []
        outcome = lib.ERROR
        faulted = len(emission_faults(self.aligner))
        try:
            media_dir = self._media_dir(case)
            trail = Trail()
            cues = claims.segments()
            _cleaned, served = served_claims(claims)
            extra["served_lines"] = len(served)
            impl = AlignStepsImpl(
                config=self.config,
                adapters=Adapters(
                    captions=ClaimCaptions(cues if claims.timed else ()),
                    providers=(ClaimProvider(() if claims.timed else cues),),
                    probe=FixedProbe(self.duration_of(case.song)),
                    transcriber=self.transcriber,
                    aligner=self.aligner,
                ),
                reporter=trail,
            )
            job = JobRef(
                job_id=case.song.slug,
                media_id=case.song.slug,
                media_dir=str(media_dir),
                source_uri=os.path.abspath(case.song.mix),
                params={
                    "fetcher": "local",
                    "artist": case.song.slug,
                    "track": case.song.slug,
                    "language": self.language,
                    **({"syncMode": self.sync_mode} if self.sync_mode != SYNC_FORCED else {}),
                },
            )
            with capture_generated() as captured, capture_lifts() as lifts:
                steps = RecordingSteps(impl, trail=trail, captured=captured, lifts=lifts)
                result = asyncio.run(run_align(job, steps))
            emitted = emission_faults(self.aligner)[faulted:]
            outcome, lines = self._record(case, claims, served, media_dir, steps, result, extra, emitted)
        except Exception as exc:  # noqa: BLE001 - one broken case must not lose the sweep
            outcome, lines = lib.ERROR, []
            extra["exception"] = f"{type(exc).__name__}: {exc}"
        extra["seconds"] = round(time.perf_counter() - started, 2)
        extra.setdefault("verdict", "?")
        extra.setdefault("why", "")
        extra.setdefault("lift", None)
        return lib.row_of(
            song=case.song,
            mode=case.mode,
            variant=case.variant,
            claims=claims,
            outcome=outcome,
            doc=lines,
            extra=extra,
        )

    def _record(
        self,
        case: Case,
        claims: lib.Claims,
        served: Served,
        media_dir: Path,
        steps: RecordingSteps,
        result: AlignOutcome,
        extra: dict[str, object],
        emitted: Sequence[str],
    ) -> tuple[str, list[lib.DocLine]]:
        """Score the published claim-text document; fill `extra` with the job's whole story.

        ERROR, not a verdict, whenever the row cannot say what production would have published: an attempt
        whose request is not the served claims (`foreign`), a fault any attempt caught (`case_fault` over
        every attempt's notes and the emissions faults `emitted` during the job — a fault on attempt 1
        sends the policy down a retry production would not take), a published record that matches NO
        attempt, and a published file holding other bytes than the published attempt's.
        """
        attempts = steps.attempts
        published = result.published
        chosen = published_attempt(attempts, published)
        decisions = [e for e in result.trail if e.get("verdict") in ("accept", "retime", "next")]
        served_texts = [text for _index, text in served]
        #: Claim-text attempts whose request was NOT the served claims — identity would pair wrongly.
        foreign: list[int] = []
        records: list[dict[str, object]] = []
        for number, attempt in enumerate(attempts):
            previous = attempts[number - 1].request if number else None
            same_text = previous is not None and previous.text.label == attempt.request.text.label
            added = attempt.request.knobs - (previous.knobs if previous is not None and same_text else set())
            record: dict[str, object] = {
                "n": number + 1,
                "text": attempt.request.text.label,
                "tier": attempt.request.text.tier.value,
                "knobs": sorted(k.value for k in attempt.request.knobs),
                "knob": next(iter(sorted(k.value for k in added)), None),
                "result": (
                    attempt.doc.timing
                    if attempt.doc is not None
                    else ("refused" if attempt.refused is not None else "none")
                ),
                "seconds": attempt.seconds,
            }
            verdict, why = global_verdict(attempt.states)
            record.update(verdict=verdict, why=why, repair_faults=repair_faults(attempt.states))
            # The gate's own readings: the lexical lift at full precision (None: exempt, unmeasurable, or it
            # raised), and a LINE_SYNC attempt's note, which carries no `align-global` verdict.
            record["lift"] = attempt.lifts[-1] if attempt.lifts else None
            record.update(line_sync_fields(attempt.states))
            if attempt.doc is not None:
                record.update(
                    ref=attempt.doc.ref,
                    confidence=attempt.doc.confidence,
                    coverage=round(attempt.doc.report.coverage, 4),
                    words=attempt.doc.report.words,
                    out_of_order=attempt.doc.report.out_of_order,
                )
            claim_text = attempt.request.text.tier is not Tier.ASR
            if (
                claim_text
                and [str(s.get("text") or "") for s in attempt.request.text.segments] != served_texts
            ):
                foreign.append(number + 1)
            elif attempt.body is not None and claim_text:
                scored, identity = doc_lines(json.loads(attempt.body), attempt.generated, claims, served)
                counts = lib.count_lines(lib.score_lines(case.song, claims, scored)[0])
                record.update(
                    scored=counts["scored"], gross=counts["gross"], w500=counts["w500"], identity=identity
                )
            if number < len(decisions):
                record.update(decision=decisions[number]["verdict"], decision_why=decisions[number]["why"])
            records.append(record)
        if len(attempts) > 1:
            # Every attempt's document kept, since the published ref may hold only the last write.
            keep = media_dir / "attempts"
            keep.mkdir(parents=True, exist_ok=True)
            for number, attempt in enumerate(attempts, 1):
                if attempt.body is not None:
                    knobs = "+".join(sorted(k.value for k in attempt.request.knobs)) or "first"
                    label = attempt.request.text.label.replace(":", "-")
                    (keep / f"{number}-{label}-{knobs}.json").write_bytes(attempt.body)

        terminal = (
            "published"
            if published is not None
            else ("abandoned" if result.why.startswith("abandoned") else "no-lyrics")
        )
        # Attempt 1 OF THE CLAIM TEXT (an all-decoration text never reaches one; ASR attempts are not it).
        first = next((a.doc for a in attempts if a.request.text.tier is not Tier.ASR), None)
        extra.update(
            terminal=terminal,
            outcome_why=result.why,
            attempts=records,
            published_attempt=None if chosen is None else chosen + 1,
            published_label=None if published is None else published.label,
            published_knobs=[] if chosen is None else sorted(k.value for k in attempts[chosen].request.knobs),
            asr_requested=any(e.get("verdict") == "asr-fallback" for e in result.trail),
            transcriptions=[{"on_vocals": v, "heard": h} for v, h in steps.transcriptions],
            trail=[dict(e) for e in result.trail],
            first_coverage=0.0 if first is None else round(first.report.coverage, 4),
        )
        # The printed verdict: the published attempt's, else the first claim-text attempt's.
        shown = chosen if chosen is not None else (0 if attempts else None)
        if shown is not None:
            extra["verdict"], extra["why"] = global_verdict(attempts[shown].states)
            extra["lift"] = records[shown]["lift"]
            extra.update(line_sync_fields(attempts[shown].states))
        final = (media_dir / published.ref).read_bytes() if published is not None and published.ref else None
        holder: int | None = None
        if final is not None:
            extra["doc_sha256"] = lib.doc_digest(final)
            holder = next((i for i in reversed(range(len(attempts))) if attempts[i].body == final), None)
            extra["published_file_attempt"] = None if holder is None else holder + 1
        if foreign:
            extra["exception"] = (
                f"attempt(s) {foreign}: the request's segments are not the served claims, so the published "
                "lines cannot be paired to truth by identity"
            )
            return lib.ERROR, []
        fault = case_fault([note for attempt in attempts for note in attempt.states], emitted)
        if fault is not None:
            extra["exception"] = fault
            return lib.ERROR, []
        if published is not None and chosen is None:
            # The job PUBLISHED, but no attempt returned this record (by identity or equality): a later step
            # rebuilt it — a wired diarizer, a W1 best-so-far re-writing it under a knob-bearing ref. The
            # room sees lyrics; scored as a refusal, its lines would read as missing and a wrong text as
            # correctly refused.
            extra["exception"] = (
                f"the published record ({published.label}, {published.ref}) matches no attempt, so what the "
                "job published cannot be paired to a request"
            )
            return lib.ERROR, []
        if chosen is None or published is None or attempts[chosen].request.text.tier is Tier.ASR:
            return lib.REFUSED, []
        attempt = attempts[chosen]
        if final != attempt.body:
            extra["exception"] = (
                f"the published ref holds {'no attempt' if holder is None else f'attempt {holder + 1}'}'s "
                f"bytes, not the published attempt {chosen + 1}'s: the TV would show another document than "
                "the one the job published"
            )
            return lib.ERROR, []
        assert final is not None  # equal to the published attempt's body, which a returned document has
        lines, identity = doc_lines(json.loads(final), attempt.generated, claims, served)
        extra.update(
            confidence=published.confidence,
            ref=str((media_dir / published.ref).relative_to(self.media_root)),
            report_words=published.report.words,
            coverage=round(published.report.coverage, 4),
            identity=identity,
            changed_vs_first=chosen != 0 and attempt.body != attempts[0].body,
            onsets_sha256=lib.onset_digest(lines),
        )
        unpaired = unpaired_word_doc(identity, published.timing)
        if unpaired is not None:
            extra["exception"] = unpaired
            return lib.ERROR, []
        return (lib.LINE_SYNC if published.timing == TIMING_LINE else lib.PUBLISHED), lines


DRIVERS: Mapping[str, type[TimeTextDriver]] = {
    "time_text": TimeTextDriver,
    "run_align": RunAlignDriver,
    "generate": GenerateDriver,
}


# ── the run ───────────────────────────────────────────────────────────────────────────────────────────


def resolve_device(requested: str | None) -> str:
    if requested:
        return requested
    import torch  # noqa: PLC0415

    if torch.backends.mps.is_available():
        return "mps"
    return "cuda" if torch.cuda.is_available() else "cpu"


def cases_for(songs: Sequence[lib.Song], modes: Sequence[str], wrong_k: int) -> list[Case]:
    """Mode-major, as e2e2 ran them: every song under one mode before the next mode starts."""
    return [
        Case(song, mode, variant)
        for mode in modes
        for song in songs
        for variant in range(lib.variants_of(mode, wrong_k))
    ]


def git_state() -> dict[str, object]:
    """HEAD and whether the tree is dirty — read-only git, so a summary says what code it measured."""
    try:
        head = subprocess.run(
            ["git", "-C", str(REPO), "log", "-1", "--format=%H"], capture_output=True, text=True, check=True
        ).stdout.strip()
        dirty = subprocess.run(
            ["git", "-C", str(REPO), "status", "--porcelain"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return {"head": None, "dirty": None}
    return {"head": head, "dirty_files": len(dirty.splitlines())}


def harness_digest() -> str:
    digest = hashlib.sha256()
    for path in (HERE / "e2e.py", HERE / "e2e_lib.py", HERE / "e2e_gates.py"):
        digest.update(path.read_bytes())
    return digest.hexdigest()[:16]


def code_fingerprint() -> str:
    """The code a row measured: every file of the imported `encore_worker` package plus the harness.

    Recorded in `run.json`, in every row (`code`) and in the summary's meta. HEAD cannot say it — this plan
    lands every wave uncommitted on one HEAD — and only the emissions cache was fingerprinted before, so
    a `--resume` after a fix pooled rows from two versions of `time_text` under one meta record.
    """
    import encore_worker  # noqa: PLC0415 - the package this process actually imported, wherever it lives

    package = Path(encore_worker.__file__).resolve().parent
    return hashlib.sha256(f"{lib.tree_digest([package])}|{harness_digest()}".encode()).hexdigest()[:16]


def resume_refusal(config_path: Path, config: Mapping[str, object]) -> str | None:
    """Why the run at `config_path` must not be continued under `config`, or None when it may be.

    A resumed run must continue THE SAME run: rows under another level, model, seed, alignment setting or
    worker CODE would blend into one summary silently. A `run.json` from before a key existed differs, so
    it is refused too (start a new `--out`).
    """
    if not config_path.exists():
        return None
    started: object = json.loads(config_path.read_text(encoding="utf-8"))
    if started == dict(config):
        return None
    changed = (
        sorted(k for k in {*started, *config} if started.get(k) != config.get(k))
        if isinstance(started, dict)
        else ["(not a run.json)"]
    )
    return (
        f"{config_path.parent} was started with {json.dumps(started)}; not resuming as "
        f"{json.dumps(dict(config))} (differs in: {', '.join(changed)})"
    )


def parse_modes(spec: str) -> list[str]:
    """`--modes`: comma-separated modes, where `all` stands for `e2e_lib.ALL_MODES` — alone or beside others
    (`all,wrongtext+ownclock` is the W3 gate's whole sweep in one run). In order, each mode once."""
    modes: list[str] = []
    for part in (m.strip() for m in spec.split(",")):
        for mode in lib.ALL_MODES if part == "all" else (part,) if part else ():
            lib.parse_mode(mode)  # raises with the list of known ops
            if mode not in modes:
                modes.append(mode)
    return modes


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="E2E alignment bench over the SHIPPED time_text / run_align (see the module docstring).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="modes: truth, " + ", ".join(lib.OPS) + "; combine with '+', e.g. jit+off15, blind+headers",
    )
    ap.add_argument("--level", choices=LEVELS, default="time_text")
    ap.add_argument("--modes", default=",".join(lib.DEFAULT_MODES), help="comma-separated, or 'all'")
    ap.add_argument("--songs", default=None, help="comma-separated slugs, slug prefixes, or jamendo/youtube")
    ap.add_argument(
        "--model",
        default=None,
        help="torchaudio bundle name, e.g. HUBERT_ASR_LARGE (unset: ENCORE_ALIGN_MODEL, else this device's "
        "shipped default)",
    )
    ap.add_argument("--device", default=None, help="mps / cuda / cpu (default: the best available)")
    ap.add_argument("--language", default="en")
    ap.add_argument("--seed", type=int, default=0, help="seeds jitter, drops, donors, injections")
    ap.add_argument("--wrong-k", type=int, default=lib.WRONG_K, help="wrong-text cross-pairs per song")
    ap.add_argument(
        "--tfr-audio",
        choices=lib.TFR_AUDIO,
        default=lib.TFR_YOUTUBE,
        help="the tfr songs' audio: youtube = production-shaped (needs --prepare-tfr once), reference = "
        "the producer's oracle stems, only to reproduce the review baseline",
    )
    ap.add_argument(
        "--prepare-tfr",
        action="store_true",
        help="separate each tfr song's youtube-mix.wav into the vocals stem --tfr-audio youtube reads",
    )
    ap.add_argument(
        "--no-stem",
        action="store_true",
        help="run every case STEMLESS: vocals_path None, so the mix is the align target, as production "
        "runs a song no stems job could separate (the only way the mix bands and the h3-mix-* arms are "
        "measurable — no corpus song lacks a stem). Composable with every claim mode and --sync-mode",
    )
    ap.add_argument("--out", default=None, help="run directory (default: $ENCORE_BENCH_ROOT/_runs/<tag>)")
    ap.add_argument("--tag", default=None)
    ap.add_argument("--resume", action="store_true", help="continue an interrupted --out")
    ap.add_argument("--emissions-cache", choices=("use", "refresh", "off"), default="use")
    ap.add_argument(
        "--verify-cache",
        action="store_true",
        help="run the first selected song x mode with fresh and with disk-cached emissions; compare docs",
    )
    ap.add_argument(
        "--asr",
        choices=("off", "whisper"),
        default="off",
        help="run_align: the ASR fallback's transcriber (off = a box with none; whisper = cached on disk)",
    )
    ap.add_argument(
        "--asr-model", default=None, help="whisper checkpoint for --asr whisper (default: Config's)"
    )
    ap.add_argument(
        "--sync-mode",
        choices=SYNC_MODES,
        default=SYNC_FORCED,
        help="run_align: the job's syncMode (lines = every text's only attempt is the gated LINE_SYNC rung)",
    )
    ap.add_argument("--summarize", default=None, metavar="ROWS", help="re-print the summary of a rows.jsonl")
    ap.add_argument(
        "--compact",
        nargs=2,
        default=None,
        metavar=("ROWS", "OUT"),
        help="write a rows.jsonl's compact per-case digest (results/*.cases.jsonl) to OUT, then exit",
    )
    ap.add_argument(
        "--compare",
        default=None,
        metavar="BASE",
        help="a baseline summary.json (or run dir, or rows.jsonl): print per-mode and per-song deltas",
    )
    ap.add_argument(
        "--gates",
        default=None,
        metavar="FILE",
        help="reject-if gates (yaml subset or json; see e2e_gates.py); any FAIL/ERROR exits 3",
    )
    args = ap.parse_args(argv)
    sys.stdout.reconfigure(line_buffering=True)  # type: ignore[union-attr]
    # Two known, per-call library notices that would bury the per-case lines; nothing else is silenced.
    warnings.filterwarnings("ignore", message=r".*forced_align has been deprecated.*")
    warnings.filterwarnings("ignore", message=r"(?s).*torchcodec is not installed correctly.*")

    if args.compact:
        rows_in, compact_out = (Path(p) for p in args.compact)
        try:
            lines = [
                json.dumps(lib.compact_row(row), ensure_ascii=False, separators=(",", ":")) + "\n"
                for row in lib.read_rows(rows_in)
            ]
        except (OSError, ValueError) as error:
            print(f"compact: {error}", file=sys.stderr)
            return 2
        compact_out.write_text("".join(lines), encoding="utf-8")
        print(f"compact: {len(lines)} cases -> {compact_out}")
        return 0
    if args.sync_mode != SYNC_FORCED and args.level != "run_align":
        print("--sync-mode is a job parameter: it applies at --level run_align only", file=sys.stderr)
        return 2
    if args.summarize:
        # The rows' own `run.json` is the meta, so `--compare` / `--gates` see the setup they measured.
        try:
            document = lib.rows_document(Path(args.summarize))
        except (OSError, ValueError) as error:
            print(f"summarize: {error}", file=sys.stderr)
            return 2
        print(lib.format_summary(document["summary"]))
        return verdicts(document, args)

    try:
        # THE WORKER'S OWN SETTINGS, read as the worker reads them. A bare `Config()` would ignore every
        # `ENCORE_ALIGN_*` knob, so a default-off arm run with its knob set would measure the baseline.
        config = Config.from_env()
    except ConfigError as error:
        print(f"worker config: {error}", file=sys.stderr)
        return 2
    root = lib.bench_root()
    if args.prepare_tfr:
        return prepare_tfr(root, config)
    corpus = lib.discover(root, tfr_audio=args.tfr_audio)
    songs = lib.select(corpus, args.songs)
    missing = [f"{song.slug}: {path}" for song in songs for path in song.missing_files()]
    if missing:
        hint = " (tfr stems: run --prepare-tfr once)" if any(s.slug in lib.TFR_SLUGS for s in songs) else ""
        print(f"missing audio (prepare the corpus first{hint}):\n  " + "\n  ".join(missing), file=sys.stderr)
        return 2
    modes = parse_modes(args.modes)
    device = resolve_device(args.device)
    named, refused_bundle = resolve_bundle(args.model, config, args.language)
    if refused_bundle is not None:
        print(refused_bundle, file=sys.stderr)
        return 2
    model_label = named or default_model(args.language, device)
    banner = uncalibrated_banner(model_label)
    if banner is not None:
        print(banner, file=sys.stderr)
    store = (
        None
        if args.emissions_cache == "off"
        else lib.EmissionStore(root / "_emissions", model=model_label, emitter=emitter_fingerprint(config))
    )

    if args.verify_cache:
        if store is None:
            print("--verify-cache needs the emissions cache (drop --emissions-cache off)", file=sys.stderr)
            return 2
        return verify_cache(args, corpus, songs[0], modes[0], device, store, root, config, named)

    tag = args.tag or f"{args.level}-{model_label}-{datetime.datetime.now():%Y%m%d-%H%M%S}"
    out = Path(args.out) if args.out else root / "_runs" / tag
    rows_path = out / "rows.jsonl"
    if rows_path.exists() and not args.resume:
        print(
            f"{rows_path} exists; pass --resume to continue it, or choose another --out/--tag",
            file=sys.stderr,
        )
        return 2
    out.mkdir(parents=True, exist_ok=True)
    code = code_fingerprint()
    run_config: dict[str, object] = {
        "level": args.level,
        "model": model_label,
        "seed": args.seed,
        "wrong_k": args.wrong_k,
        "language": args.language,
        "tfr_audio": args.tfr_audio,
        #: The align TARGET, at every level: the stem a stems job leaves, or the mix of a stemless song
        #: (`--no-stem`). Part of the setup a `base.` gate must share (`e2e_gates.SETUP_META`), because the
        #: two targets are different audio measured against the same truth.
        "target": lib.STEMLESS_TARGET if args.no_stem else lib.STEM_TARGET,
        "align_config": lib.align_config(config),
        "code": code,
    }
    if banner is not None:
        #: RECORDED ONLY WHEN TRUE (W4b review r2), so every calibrated run — i.e. every run ever measured —
        #: keeps the `run.json` shape `resume_refusal` compares, and a `--resume` across a calibration being
        #: PASTED IN is refused as the setting change it is.
        run_config["uncalibrated"] = True
    if args.level == "run_align":
        run_config["asr"] = args.asr if args.asr == "off" else f"whisper:{args.asr_model or config.asr_model}"
        run_config["sync_mode"] = args.sync_mode
    config_path = out / "run.json"
    refusal = resume_refusal(config_path, run_config)
    if refusal is not None:
        print(refusal, file=sys.stderr)
        return 2
    config_path.write_text(json.dumps(run_config) + "\n", encoding="utf-8")
    done = (
        {(r["song"], r["mode"], r["variant"]) for r in lib.read_rows(rows_path)}
        if rows_path.exists()
        else set()
    )

    aligner = BenchAligner(
        device=device,
        model=named,
        store=store,
        read=args.emissions_cache == "use",
        write="always" if args.emissions_cache == "refresh" else "missing",
    )
    transcriber = build_asr(args, root, device, config) if args.level == "run_align" else None
    driver = (
        RunAlignDriver(
            aligner=aligner,
            corpus=corpus,
            media_root=out / "media",
            language=args.language,
            seed=args.seed,
            wrong_k=args.wrong_k,
            config=config,
            stem=not args.no_stem,
            transcriber=transcriber,
            sync_mode=args.sync_mode,
        )
        if args.level == "run_align"
        else DRIVERS[args.level](
            aligner=aligner,
            corpus=corpus,
            media_root=out / "media",
            language=args.language,
            seed=args.seed,
            wrong_k=args.wrong_k,
            config=config,
            stem=not args.no_stem,
        )
    )
    cases = cases_for(songs, modes, args.wrong_k)
    print(
        f"e2e level={args.level} model={model_label} device={device} seed={args.seed} "
        f"tfr={args.tfr_audio} code={code} songs={len(songs)} modes={','.join(modes)} cases={len(cases)} "
        f"out={out}"
    )
    started = datetime.datetime.now()
    clock = time.perf_counter()
    #: Wall seconds and cases per mode, THIS process (a resumed run times only what it ran).
    mode_clock: dict[str, list[float]] = {mode: [0.0, 0] for mode in modes}
    with rows_path.open("a", encoding="utf-8") as sink:
        for number, case in enumerate(cases, 1):
            if (case.song.slug, case.mode, case.variant) in done:
                continue
            case_clock = time.perf_counter()
            row = {**driver.run(case), "code": code}
            sink.write(json.dumps(row, ensure_ascii=False) + "\n")
            sink.flush()
            mode_clock[case.mode][0] += time.perf_counter() - case_clock
            mode_clock[case.mode][1] += 1
            pct = lib.pct(row["w500"], row["scored"])
            print(
                f"[{number:>4}/{len(cases)}] {case.name:<14} {case.song.slug[:30]:<30} "
                f"{row['outcome']:<9} {str(row.get('verdict'))[:11]:<11} lines {row['scored']:>3}/"
                f"{row['truth_lines']:<3} gross {row['gross']:>3} ±500 {pct if pct is not None else '-':>6} "
                f"{row['seconds']:5.1f}s  [{time.perf_counter() - clock:5.0f}s]{_policy_note(row)}"
                + (f"  ERROR {row.get('exception')}" if row["outcome"] == lib.ERROR else "")
            )

    rows = [r for r in lib.read_rows(rows_path) if r["mode"] in modes]
    summary = lib.summarize(rows)
    codes = lib.row_codes(rows)
    meta = {
        "level": args.level,
        "model": model_label,
        "model_identity": dict(aligner.identities),
        "device": device,
        "language": args.language,
        "seed": args.seed,
        "wrong_k": args.wrong_k,
        "tfr_audio": args.tfr_audio,
        "target": run_config["target"],
        "align_config": run_config["align_config"],
        **({"uncalibrated": True} if banner is not None else {}),
        "modes": modes,
        "songs": [song.slug for song in songs],
        "bench_root": str(root),
        "git": git_state(),
        "harness": harness_digest(),
        "code": code,
        "row_codes": codes,
        "emissions": dict(aligner.served),
        "started": started.isoformat(timespec="seconds"),
        "seconds": round(time.perf_counter() - clock, 1),
        "mode_seconds": {mode: round(spent, 1) for mode, (spent, _n) in mode_clock.items()},
    }
    if args.level == "run_align":
        meta["asr"] = run_config["asr"]
        meta["sync_mode"] = run_config["sync_mode"]
        if isinstance(transcriber, lib.CachedTranscriber):
            meta["transcripts"] = dict(transcriber.served)
    document = {"meta": meta, "summary": summary, "songs": lib.per_song(rows)}
    (out / "summary.json").write_text(lib.dump_document(document), encoding="utf-8")
    print(lib.format_summary(summary))
    if len(codes) > 1:
        print(f"WARNING: these rows were measured on {len(codes)} worker trees: {', '.join(codes)}")
    print(
        "wall time per mode: "
        + ", ".join(f"{mode} {spent:.0f}s/{n:.0f} cases" for mode, (spent, n) in mode_clock.items())
        + f"; total {time.perf_counter() - clock:.0f}s (emissions {dict(aligner.served)})"
    )
    print(f"rows: {rows_path}\nsummary: {out / 'summary.json'}")
    return verdicts(document, args)


def prepare_tfr(root: Path, config: Config) -> int:
    """Separate each tfr song's `youtube-mix.wav` into the vocals stem `--tfr-audio youtube` aligns on.

    PRODUCTION'S STEMS PATH, run by hand: `separate.decode_argv` (44.1 kHz stereo 16-bit, what the stems
    step decodes to) then the shipped `MlxDemucs` with htdemucs, the engine and model the corpus's other
    29 stems were separated with. The stem lands at `e2e_lib.tfr_stem` with a provenance note beside it;
    an existing stem is kept, so this is idempotent. `youtube-mix.wav` comes from
    `stem-separation/scripts/prepare.py` (yt-dlp, as the worker fetches it).
    """
    from encore_worker.adapters import separate  # noqa: PLC0415

    # The worker's `mlx_bin` names a binary on PATH; the bench runs as `.venv/bin/python` without the venv
    # activated, so fall back to the one installed beside this interpreter.
    beside = Path(sys.executable).parent / config.mlx_bin
    mlx_bin = config.mlx_bin if shutil.which(config.mlx_bin) or not beside.is_file() else str(beside)
    for slug in lib.TFR_SLUGS:
        source = lib.REPO_SONGS / slug / "youtube-mix.wav"
        target = lib.tfr_stem(root, slug)
        if target.is_file():
            print(f"{slug}: {target} present, kept")
            continue
        if not source.is_file():
            print(
                f"{slug}: {source} missing (stem-separation/scripts/prepare.py fetches it)", file=sys.stderr
            )
            return 2
        started = time.perf_counter()
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=target.parent) as scratch:
            decoded = str(Path(scratch) / "input.wav")
            separate.run(separate.decode_argv(str(source), decoded, config.ffmpeg_bin))
            engine = separate.MlxDemucs(model="htdemucs", mlx_bin=mlx_bin, ffmpeg_bin=config.ffmpeg_bin)
            stems = engine.separate(decoded, scratch)
            if stems.vocals_path is None:
                print(f"{slug}: {stems.engine} returned no vocals stem", file=sys.stderr)
                return 2
            shutil.move(stems.vocals_path, target)
        note = {
            "source": str(source),
            "source_bytes": source.stat().st_size,
            "engine": stems.engine,
            "model": "htdemucs",
            "decode": "separate.decode_argv (44.1 kHz stereo pcm_s16le)",
            "seconds": round(time.perf_counter() - started, 1),
        }
        (target.parent / "provenance.json").write_text(json.dumps(note, indent=1) + "\n", encoding="utf-8")
        print(f"{slug}: {target} ({note['seconds']} s)")
    return 0


def _policy_note(row: Mapping[str, Any]) -> str:
    """The per-case line's run_align tail: how many attempts, and what published if not attempt 1."""
    attempts = row.get("attempts")
    if not isinstance(attempts, list):
        return ""
    knobs = "+".join(row.get("published_knobs") or [])
    tail = f"  attempts {len(attempts)}"
    if row.get("published_attempt") not in (None, 1):
        tail += f", published #{row['published_attempt']} {row.get('published_label')}"
        tail += f" {knobs}" if knobs else ""
    if row.get("terminal") != "published":
        tail += f", {row.get('terminal')}"
    return tail


def verdicts(document: Mapping[str, Any], args: argparse.Namespace) -> int:
    """`--compare` deltas and `--gates` verdicts for a summary document; 3 if any gate rejects.

    ERROR ROWS exit 3 with or without `--gates` (the built-in `no-error-rows` gate): a case the harness
    could not complete is not a measurement, and a sweep that prints a table over it must not look clean.
    """
    base: gates.View | None = None
    run = gates.view_of(document)
    try:
        if args.compare:
            base = gates.view_of(gates.load_document(Path(args.compare)))
            print(gates.format_compare(run, base))
        if args.gates:
            results = gates.run_gates(
                gates.parse_gates(Path(args.gates).read_text(encoding="utf-8")), run, base
            )
            print(gates.format_gates(results))
            return 3 if any(r.status != "PASS" for r in results) else 0
    except (OSError, ValueError) as error:
        print(f"compare/gates: {error}", file=sys.stderr)
        return 2
    errors = gates.error_rows_gate(run)
    if errors.status != "PASS":
        print(gates.format_gates([errors]))
        return 3
    return 0


def build_asr(args: argparse.Namespace, root: Path, device: str, config: Config) -> ports.Transcriber | None:
    """`--asr whisper`: the shipped `WhisperTranscriber` behind a disk cache; `off`: no transcriber at all.

    OFF BY DEFAULT because the claim-text metrics cannot depend on it: `order_pool` tries every candidate
    text before ASR, so the claim text's attempts are identical either way. What ASR changes is only how a
    REFUSED case ends (no-lyrics vs an ASR document, which has no identity to score against truth).
    """
    if args.asr == "off":
        return None
    from encore_worker.adapters import ml  # noqa: PLC0415

    checkpoint = args.asr_model or config.asr_model
    inner = ml.build_transcriber(device=device, checkpoint=checkpoint)
    if inner is None:
        raise SystemExit("--asr whisper needs whisperx (the worker's `ml` extra)")
    # whisper reads its audio through the same ffmpeg (`emitter_versions` records its build), and
    # `WhisperTranscriber` lives in the emitting module, so it shares its import closure.
    versions = emitter_versions(("whisperx", "faster-whisper", "ctranslate2"))
    store = lib.TranscriptStore(
        root / "_transcripts",
        model=f"whisper:{checkpoint}",
        emitter=lib.emitter_fingerprint(emitter_sources(), versions),
    )
    return lib.CachedTranscriber(inner, store)


def verify_cache(
    args: argparse.Namespace,
    corpus: Sequence[lib.Song],
    song: lib.Song,
    mode: str,
    device: str,
    store: lib.EmissionStore,
    root: Path,
    config: Config,
    bundle: str | None,
) -> int:
    """Fresh vs disk-cached emissions on one song x mode must give BYTE-IDENTICAL documents.

    The fresh run recomputes every matrix (the in-process model cache cleared first) and stores only
    what the store lacks, so an entry made earlier — possibly on another device — is what the cached run
    loads and is judged by.
    """
    out = Path(args.out) if args.out else root / "_runs" / f"verify-cache-{song.slug}-{mode}"
    results: dict[str, tuple[dict[str, Any], bytes]] = {}
    for label, read in (("fresh", False), ("cached", True)):
        ml.clear_cache()
        aligner = BenchAligner(device=device, model=bundle, store=store, read=read, write="missing")
        driver = TimeTextDriver(
            aligner=aligner,
            corpus=corpus,
            media_root=out / label,
            language=args.language,
            seed=args.seed,
            wrong_k=args.wrong_k,
            config=config,
            stem=not args.no_stem,
        )
        row = driver.run(Case(song, mode, 0))
        ref = row.get("ref")
        body = (out / label / str(ref)).read_bytes() if ref else b""
        results[label] = (row, body)
        print(f"{label:>6}: emissions {dict(aligner.served)}; outcome {row['outcome']}; doc {len(body)} B")
    (fresh_row, fresh_doc), (cached_row, cached_doc) = results["fresh"], results["cached"]
    same = fresh_doc == cached_doc and fresh_row["line_errors"] == cached_row["line_errors"]
    print(f"verify-cache {song.slug} x {mode}: {'IDENTICAL' if same else 'DIFFERENT'} documents")
    return 0 if same else 1


if __name__ == "__main__":
    raise SystemExit(main())
