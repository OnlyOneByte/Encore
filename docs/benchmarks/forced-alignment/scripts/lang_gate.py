#!/usr/bin/env python
"""The LANGUAGE gates (review M8 / §3 item 9, W7): which bundle should time a non-English song, and the
live proof that review M9's `blank_id` fix works on a model whose `[PAD]` is not at 0.

    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/lang_gate.py --folds
    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/lang_gate.py \\
        --target stem|mix [--languages fr,de,es] [--songs N] [--out rows.json] [--from rows.json]
    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/lang_gate.py \\
        --blank [--blank-language nn] [--songs 2] [--out rows.json]

WHY A SEPARATE SCRIPT AND NOT A MODE OF `e2e.py`. The 32-song corpus `e2e.py` drives is ENGLISH — every
caption track is `en`, and JamendoLyrics MultiLang gives each song ONE language, so the whole claim-mode
machinery (wrong-text donors, the claim clock, the repair ladder's gates) is calibrated on English texts
against English bundles (`lexical.CALIBRATED`). The language question needs a different CORPUS (the 59
fr/de/es JamendoLyrics songs `jamendo.py` deliberately skipped: "the German/Spanish/French thirds of the
corpus need their own align model to be a fair test") and a different COMPARISON (bundle A against bundle B
on the same audio and text, blind, with no ladder in between), so folding it into `e2e.py` would have meant a
second corpus loader and a second scorer inside the harness that owns the shipped path. It reads the same
shipped functions — `ml.WhisperXAligner.emissions`, `generate`, `forced_align_decoder` — so what it measures
is the decode that publishes.

WHAT `--folds` ANSWERS, and it is the first thing to run because it gates everything else: the target filter
now folds a character the vocabulary lacks to its base letters (NFKD, `generate.char_ids` /
`language.fold_to_base`), and a fold that moved ONE English target sequence would move every number under
`results/`. It counts, over both corpora, the characters that newly align and the ones NFKD still cannot
decompose.

WHAT THE SWEEP ANSWERS. Review §3 item 9 measured fr/de/es on STEMS at 91.8% of words within +-300 ms under
the ENGLISH model — the same as English Jamendo's 91.1% — while routing to whisperx's per-language XLSR/
VoxPopuli fine-tunes won only on the MIX (de 50.1 -> 85.9, es 47.9 -> 62.6, fr 66.0 -> 72.2). Both readings
were n=7 songs (2 fr, 3 de, 2 es) and both were on the BASE bundle, which has not been this project's default
since W5's flip. This widens the stem reading to all 59 songs and re-reads both targets under the bundle that
ships, which is what decides whether `language.model_language` routes Latin script at all
(the `lang-route-mix` arm, `host.config.ALIGN_EXPERIMENTS`).

WHAT `--blank` ANSWERS, and why it is here rather than in a unit test. Review M9 measured the hard-coded CTC
blank costing Danish word onsets within +-250 ms 90.5% -> 73.2% and taking words more than 2 s off from 141 to
584 — but it measured it by PERMUTING an English model's emission columns (`_review-scratch/encore-review/
exp_blank.py`), because no non-English song with measured truth was in the corpus and no non-zero-pad model
had ever been loaded. W4 built the fix, W4b and W6 confirmed it was still DORMANT (the language was always
`en`, and torchaudio's English bundles put their blank at 0), and W7 is the wave that arms it. So this mode
loads a REAL whisperx HF bundle whose `[PAD]` is not at 0 — `nn`, NbAiLab/nb-wav2vec2-1b-nynorsk, whose id 0
is the WORD SEPARATOR `|` and whose `[PAD]` is 31, the worst of the 23 cases — runs a REAL forward pass over
real audio, and decodes the same text twice: once with the matrix's own `blank_id` (what ships) and once with
the literal 0 the code used before W4 (`--blank` prints both). The LANGUAGE PAIRING IS ARTIFICIAL AND SAID SO:
there is no Norwegian song with measured word truth on this corpus, so the text is an English (or fr/de/es)
JamendoLyrics song's, whose letters that vocabulary covers in full (`|abcdefghijklmnopqrstuvwxyzåæø`). What is
NOT artificial is the thing under test: the model, the pad's position, the forward pass, the audio and the
truth are all real, which is strictly more than the review's column permutation had.

MATRICES ARE NOT CACHED ON DISK HERE, deliberately: 59 songs x 2 targets x 2 bundles is ~4 GB of float32 that
no other run would read, and the model pass is ~5-9 s a song, so a full sweep is ~20-35 minutes either way.
The in-memory LRU of the shipped adapter still serves the two bundles of one song (`ml._emission_cache_size`).

CORPUS LAYOUT (under `$ENCORE_BENCH_ROOT`):
  * `jamendolyrics/` — the dataset checkout: `mp3/<slug>.mp3`, `annotations/lines/<slug>.csv`,
    `annotations/words/<slug>.csv`, `lyrics/<slug>.words.txt`, `JamendoLyrics.csv` (the Language column).
  * `_lang/stems/<slug>/vocals.wav` — htdemucs vocals, as `jamendo/` has for the English twenty. Built by
    `_lang/separate.sh` (demucs-mlx htdemucs, ~15 s a song on this box).
"""

from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
import time
import unicodedata
import warnings
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
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

from encore_worker.adapters import ml  # noqa: E402
from encore_worker.domain.lyrics import language as langmod  # noqa: E402
from encore_worker.domain.lyrics.clean import clean_segments  # noqa: E402
from encore_worker.domain.lyrics.generate import Decoder, generate  # noqa: E402

#: JamendoLyrics' `Language` column -> the ISO code this worker speaks.
CODES: Mapping[str, str] = {"French": "fr", "German": "de", "Spanish": "es", "English": "en"}

#: The three non-English thirds of JamendoLyrics, i.e. the 59 songs `jamendo.py` skipped.
SWEEP_LANGUAGES = ("fr", "de", "es")

#: A real whisperx HF bundle whose `[PAD]` is NOT at 0 — the `--blank` default. `nn` is the worst shape of
#: the 23: id 0 is the WORD SEPARATOR `|`, so a decoder told `blank=0` charges every inter-word boundary as
#: blank and never uses the model's real blank column at all. (`da` is `u`=0 / pad 32 and `ko` is pad 1204;
#: `nn`'s weights are the ones already on this box, which is why it is the default and not `da`.)
BLANK_LANGUAGE = "nn"

#: Line start error above which a line counts GROSS, as every other harness here defines it.
GROSS_SEC = 2.0
#: Line-start tolerances reported, in seconds.
LINE_BANDS = (0.5, 1.0)
#: Word-onset tolerances reported, in seconds (e2e's `pm100` / `pm250` / `pm300`).
WORD_BANDS = (0.1, 0.25, 0.3)

RESULTS = HERE.parent / "results"


@dataclass(frozen=True, slots=True)
class LangSong:
    """One JamendoLyrics song with MEASURED line and word onsets, plus the stem this corpus has."""

    slug: str
    language: str
    mix: Path
    vocals: Path
    #: `(text, start, end)` per annotated line.
    lines: tuple[tuple[str, float, float], ...]
    #: One measured onset per whitespace token of `lines`, in reading order. Empty when the dataset's token
    #: count disagrees with its line texts (`jamendo.py` skips those songs too).
    onsets: tuple[float, ...]

    def target(self, which: str) -> Path:
        return self.vocals if which == "stem" else self.mix


def discover(root: Path, languages: Sequence[str] = SWEEP_LANGUAGES) -> list[LangSong]:
    """Every JamendoLyrics song in `languages` that has both annotations and a separated stem.

    A song with no stem is SKIPPED and counted, never silently dropped: a sweep that quietly shrank its
    corpus would read as a model difference.
    """
    dataset = root / "jamendolyrics"
    stems = root / "_lang" / "stems"
    wanted = set(languages)
    out: list[LangSong] = []
    with open(dataset / "JamendoLyrics.csv", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        code = CODES.get(row["Language"], "")
        if code not in wanted:
            continue
        slug = row["Filepath"][: -len(".mp3")]
        with open(dataset / "annotations" / "lines" / f"{slug}.csv", encoding="utf-8") as handle:
            lines = tuple(
                (str(r["lyrics_line"]), float(r["start_time"]), float(r["end_time"]))
                for r in csv.DictReader(handle)
            )
        with open(dataset / "annotations" / "words" / f"{slug}.csv", encoding="utf-8") as handle:
            onsets = tuple(float(r["word_start"]) for r in csv.DictReader(handle))
        if sum(len(text.split()) for text, _s, _e in lines) != len(onsets):
            onsets = ()
        out.append(
            LangSong(
                slug=slug,
                language=code,
                mix=dataset / "mp3" / row["Filepath"],
                vocals=stems / slug / "vocals.wav",
                lines=lines,
                onsets=onsets,
            )
        )
    return out


# ── the fold census (`--folds`) ───────────────────────────────────────────────────────────────────────


#: The English bundles' alphabet, which is what "a character the model lacks" means for every row under
#: `results/`: 26 letters plus the apostrophe (`WAV2VEC2_ASR_BASE_960H` and both HuBERT bundles share it).
ENGLISH_LETTERS = frozenset("abcdefghijklmnopqrstuvwxyz'")


def fold_census(texts: Sequence[str]) -> dict[str, Any]:
    """How the W7 target filter changes `texts`: what now aligns, and what NFKD still cannot decompose.

    THE GATE ON THE WHOLE CHANGE. `generate.char_ids` folds before it drops, so a text whose every letter is
    already in the vocabulary produces byte-identical targets to the three inlined copies it replaced — and
    the English corpus must be exactly that, or every published number is owed a re-run.
    """
    gained: Counter[str] = Counter()
    still: Counter[str] = Counter()
    scripts: Counter[str] = Counter()
    total = 0
    for text in texts:
        for raw in text:
            total += 1
            script = langmod.script_of(raw)
            if script is not None:
                scripts[script] += 1
            ch = raw.lower()
            if ch in ENGLISH_LETTERS or not ch.isalpha():
                continue
            folded = langmod.fold_to_base(ch).lower()
            if folded != ch and all(c in ENGLISH_LETTERS for c in folded):
                gained[ch] += 1
            else:
                still[ch] += 1
    return {
        "characters": total,
        "scripts": dict(scripts.most_common()),
        "now_aligned": dict(gained.most_common()),
        "now_aligned_total": sum(gained.values()),
        "still_dropped": dict(still.most_common()),
        "still_dropped_total": sum(still.values()),
    }


def report_folds(root: Path) -> None:
    english = [
        str(segment.get("text") or "")
        for song in lib.discover(root)
        for segment in clean_segments([{"text": line.text} for line in song.truth])
    ]
    jamendo = [
        str(segment.get("text") or "")
        for song in discover(root)
        for segment in clean_segments([{"text": text} for text, _s, _e in song.lines])
    ]
    for label, texts in (("the 32-song English corpus", english), ("the 59 fr/de/es songs", jamendo)):
        got = fold_census(texts)
        print(f"\n{label}: {len(texts)} cleaned lines, {got['characters']} characters")
        print(f"  scripts            {got['scripts']}")
        print(f"  NOW ALIGNED        {got['now_aligned_total']}  {got['now_aligned']}")
        print(f"  still dropped      {got['still_dropped_total']}  {got['still_dropped']}")
    print(
        "\nREAD IT THIS WAY: a zero on the first block is what makes the fold a no-op on every row under "
        "results/; the second block is the population the fix exists for."
    )


# ── scoring one decode ────────────────────────────────────────────────────────────────────────────────


def score(
    song: LangSong, decoded: Mapping[int, tuple[float, Sequence[tuple[float, bool]]]]
) -> dict[str, Any]:
    """Line and word errors of one decode of `song`, against its measured onsets.

    `decoded` is `{line index: (line start, [(word start, was aligned), ...])}` — what `generate` produced,
    reduced to the two things scored. A line `generate` emitted nothing for is ABSENT and counted as
    `lines_dropped`, never skipped: dropping unplaced lines from the denominator is the scorer artefact
    review §3 item 10 recorded, and it flatters exactly the configuration that places fewer lines.
    """
    line_errors: list[float] = []
    word_errors: list[float] = []
    interpolated = 0
    cursor = 0
    for index, (text, truth_start, _truth_end) in enumerate(song.lines):
        count = len(text.split())
        got = decoded.get(index)
        if got is not None:
            line_errors.append(abs(got[0] - truth_start))
            if song.onsets:
                for position, (start, aligned) in enumerate(got[1][:count]):
                    word_errors.append(abs(start - song.onsets[cursor + position]))
                    interpolated += not aligned
        cursor += count
    scored_lines = len(song.lines)
    return {
        "song": song.slug,
        "language": song.language,
        "lines": scored_lines,
        "lines_placed": len(line_errors),
        "lines_dropped": scored_lines - len(line_errors),
        "gross": sum(1 for e in line_errors if e > GROSS_SEC),
        **{f"line_pm{int(b * 1000)}": sum(1 for e in line_errors if e <= b) for b in LINE_BANDS},
        "words": len(word_errors),
        "words_interpolated": interpolated,
        **{f"word_pm{int(b * 1000)}": sum(1 for e in word_errors if e <= b) for b in WORD_BANDS},
        "word_aae_ms": 1000 * statistics.fmean(word_errors) if word_errors else None,
        "word_medae_ms": 1000 * statistics.median(word_errors) if word_errors else None,
        "words_over_2s": sum(1 for e in word_errors if e > GROSS_SEC),
    }


@dataclass(frozen=True, slots=True)
class Unaware:
    """The same matrix through a reader that does NOT say where its blank is — i.e. EVERY emission object this
    worker built before W4 threaded `Emissions.blank_id` (review M9).

    THE FAITHFUL PRE-W4 ARM, and the distinction matters because `blank = 0` was hard-coded in FIVE places
    that have to agree: the kernel call, the target filter, `_char_spans`' run grouping, its flushing sentinel
    and `regenerate`'s alignable count. Forcing only the KERNEL's integer moves one of the five and leaves
    the grouper reading the model's real blank, which raises instead of mis-timing (the `kernel` arm records
    exactly that, because it is what a PARTIAL fix would do). Dropping the two FIELDS instead moves all five
    at once, through the `getattr` defaults the shipped readers still carry — so this object is pre-W4 code
    running on a post-W7 tree, which is the only honest A/B.
    """

    log_probs: Any
    frame_sec: float
    dictionary: Mapping[str, int]

    @property
    def frames(self) -> int:
        return int(self.log_probs.shape[0])


#: `--blank`'s three arms. `matrix` is what ships; `unaware` is the pre-W4 chain (see `Unaware`); `kernel` is
#: the partial fix — the matrix says where its blank is and only the kernel is told otherwise.
BLANK_ARMS = ("matrix", "unaware", "kernel")


def decode(
    texts: Sequence[str], emissions: Any, *, language: str, arm: str = "matrix"
) -> dict[int, tuple[float, list[tuple[float, bool]]]]:
    """`generate` over `emissions`, reduced to what `score` reads. `arm` is one of `BLANK_ARMS`."""

    def told_zero(log_probs: Any, targets: Sequence[int], _blank: int = 0) -> tuple[list[int], list[float]]:
        return ml.forced_align_decoder(log_probs, targets, 0)

    matrix: Any = emissions
    decoder: Decoder = ml.forced_align_decoder
    if arm == "unaware":
        matrix = Unaware(emissions.log_probs, emissions.frame_sec, emissions.dictionary)
    elif arm == "kernel":
        decoder = told_zero

    # The syllabifier is bypassed: it reads the language and is measured by its own suite, and a decode's word
    # onsets do not depend on how its letters were grouped into syllables.
    got = generate(texts, matrix, decoder=decoder, language=language, syllabifier=lambda word, _lang: [word])
    return {
        line.index: (line.start, [(word.start, word.provenance == "aligned") for word in line.words])
        for line in got.lines
    }


def pooled(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Sum the counts and recompute the rates, so one long song cannot outvote twenty short ones by accident
    (the per-song means are reported beside these as `songs` / `song_aae_ms`)."""
    if not rows:
        return {}
    total = {
        key: sum(int(row[key]) for row in rows)
        for key in (
            "lines", "lines_placed", "lines_dropped", "gross", "words", "words_interpolated",
            "words_over_2s", *(f"line_pm{int(b * 1000)}" for b in LINE_BANDS),
            *(f"word_pm{int(b * 1000)}" for b in WORD_BANDS),
        )
    }  # fmt: skip
    aae = [float(row["word_aae_ms"]) for row in rows if row["word_aae_ms"] is not None]
    out: dict[str, Any] = {"songs": len(rows), **total}
    for band in LINE_BANDS:
        key = f"line_pm{int(band * 1000)}"
        out[f"{key}_pct"] = 100 * total[key] / total["lines"] if total["lines"] else None
    for band in WORD_BANDS:
        key = f"word_pm{int(band * 1000)}"
        out[f"{key}_pct"] = 100 * total[key] / total["words"] if total["words"] else None
    out["song_aae_ms"] = statistics.fmean(aae) if aae else None
    return out


# ── the sweep (`--target stem|mix`) ───────────────────────────────────────────────────────────────────


def sweep(songs: Sequence[LangSong], *, target: str, device: str, model: str | None) -> list[dict[str, Any]]:
    """Every song decoded on BOTH bundles over the same matrix target: the default (English) and the routed
    per-language one. One row per (song, condition).

    THE TEXTS ARE THE CLEANED ANNOTATION LINES, which is what the shipped path serves (`clean_segments`, the
    text hygiene W5 landed), so the targets are the targets production would decode. BLIND: no claims, no
    repair ladder, no gate — the question is which bundle hears these words where, and a ladder between the
    decode and the score would answer a different one.

    AND THAT IS SAFE FOR THE POSITIONAL TRUTH PAIRING, which is the precondition `score` silently depends on
    and so is CHECKED rather than assumed: over all 59 songs `clean_segments` is the IDENTITY on both counts —
    2 515 raw lines in and 2 515 out, and **0 lines whose word count changed**. A dropped line would make
    `score` read `song.lines[index]` for a different line, and a rewritten one would shift every word onset
    after it inside that line. (It is the identity because these are DATASET annotations: no section headers,
    no `♪`, no caption tags — the four anchored rules in `nonlyric.py` have nothing to anchor on.)
    """
    aligner = ml.build_aligner(device=device, model=model)
    if aligner is None:  # pragma: no cover - the ml extra is a precondition of running this at all
        raise SystemExit("no aligner on this box: install the `ml` extra")
    rows: list[dict[str, Any]] = []
    for position, song in enumerate(songs, start=1):
        path = song.target(target)
        if not path.is_file():
            print(f"  {song.slug[:40]:40s} SKIP — no {target} at {path}", flush=True)
            continue
        texts = [
            str(segment.get("text") or "")
            for segment in clean_segments([{"text": text} for text, _s, _e in song.lines])
        ]
        for condition, bundle_language in (("default", langmod.ENGLISH), ("routed", song.language)):
            started = time.time()
            try:
                emissions = aligner.emissions(str(path), bundle_language)
                got = decode(texts, emissions, language=song.language)
            except Exception as failed:  # noqa: BLE001 - a row that could not be measured says so
                print(f"  {song.slug[:40]:40s} {condition:7s} FAILED {type(failed).__name__}: {failed}")
                continue
            row = {
                **score(song, got),
                "target": target,
                "condition": condition,
                "bundle_language": bundle_language,
                "bundle": ml.align_model_name(bundle_language, aligner._model),  # noqa: SLF001
                "seconds": round(time.time() - started, 2),
            }
            rows.append(row)
            print(
                f"[{position:2d}/{len(songs)}] {song.slug[:38]:38s} {song.language} {condition:7s} "
                f"{row['bundle'][:34]:34s} gross {row['gross']:3d} "
                f"w±300 {100 * row['word_pm300'] / max(1, row['words']):5.1f}% "
                f"AAE {row['word_aae_ms'] or 0:6.1f}ms  {row['seconds']:5.1f}s",
                flush=True,
            )
    return rows


def report_sweep(rows: Sequence[Mapping[str, Any]]) -> None:
    """Per language per condition, then pooled, then the per-song head-to-head that decides the arm."""
    targets = sorted({str(row["target"]) for row in rows})
    for target in targets:
        here = [row for row in rows if row["target"] == target]
        print(f"\n═══ {target.upper()} ═══")
        for code in (*SWEEP_LANGUAGES, None):
            for condition in ("default", "routed"):
                chosen = [
                    row
                    for row in here
                    if row["condition"] == condition and (code is None or row["language"] == code)
                ]
                got = pooled(chosen)
                if not got:
                    continue
                print(
                    f"{code or 'POOLED':7s} {condition:7s} songs={got['songs']:2d} "
                    f"lines={got['lines']:4d} dropped={got['lines_dropped']:3d} "
                    f"gross={got['gross']:3d} ±500={got['line_pm500_pct'] or 0:5.2f}% "
                    f"| words={got['words']:5d} ±100={got['word_pm100_pct'] or 0:5.2f}% "
                    f"±250={got['word_pm250_pct'] or 0:5.2f}% ±300={got['word_pm300_pct'] or 0:5.2f}% "
                    f"AAE={got['song_aae_ms'] or 0:6.1f}ms interp={got['words_interpolated']:3d} "
                    f">2s={got['words_over_2s']:4d}"
                )
        print("\nPER SONG (routed - default), the bound a per-song reject-if reads:")
        by_song: dict[str, dict[str, Mapping[str, Any]]] = {}
        for row in here:
            by_song.setdefault(str(row["song"]), {})[str(row["condition"])] = row
        wins = losses = ties = 0
        for slug, pair in sorted(by_song.items()):
            if len(pair) != 2:
                continue
            base, routed = pair["default"], pair["routed"]
            d_gross = int(routed["gross"]) - int(base["gross"])
            base_pct = 100 * int(base["word_pm300"]) / max(1, int(base["words"]))
            routed_pct = 100 * int(routed["word_pm300"]) / max(1, int(routed["words"]))
            delta = routed_pct - base_pct
            wins += delta > 0.5
            losses += delta < -0.5
            ties += abs(delta) <= 0.5
            print(
                f"  {slug[:44]:44s} {base['language']} gross {int(base['gross']):3d} -> "
                f"{int(routed['gross']):3d} ({d_gross:+3d})  ±300 {base_pct:5.1f} -> {routed_pct:5.1f} "
                f"({delta:+5.1f})"
            )
        print(
            f"  routed WINS {wins}, LOSES {losses}, ties {ties} (of {len(by_song)} songs, ±300, "
            "0.5 pt dead band)"
        )


# ── the blank proof (`--blank`) ───────────────────────────────────────────────────────────────────────


def blank_proof(
    songs: Sequence[LangSong], *, bundle_language: str, device: str, target: str
) -> list[dict[str, Any]]:
    """The same text and the same matrix from a REAL non-zero-pad bundle, decoded under each of `BLANK_ARMS`.

    The weights, the audio, the text and the forward pass are IDENTICAL across the arms — only what the
    decode chain believes about which column is blank changes — which is what makes the delta the blank's and
    not a model's. `unaware` is the faithful pre-W4 chain and `kernel` is the partial fix; see `Unaware` for
    why both are reported rather than one.
    """
    aligner = ml.build_aligner(device=device)
    if aligner is None:  # pragma: no cover
        raise SystemExit("no aligner on this box: install the `ml` extra")
    rows: list[dict[str, Any]] = []
    for song in songs:
        path = song.target(target)
        if not path.is_file():
            print(f"  {song.slug} SKIP — no {target}")
            continue
        texts = [
            str(segment.get("text") or "")
            for segment in clean_segments([{"text": text} for text, _s, _e in song.lines])
        ]
        emissions = aligner.emissions(str(path), bundle_language)
        inverse = {code: name for name, code in emissions.dictionary.items()}
        print(
            f"\n{song.slug} on {emissions.model}: vocabulary {len(emissions.dictionary)}, "
            f"blank_id {emissions.blank_id} ({inverse.get(emissions.blank_id)!r}), "
            f"id 0 is {inverse.get(0)!r}, specials {dict(emissions.specials)}"
        )
        if emissions.blank_id == 0:
            raise SystemExit(
                f"{emissions.model} puts its blank at 0, so it cannot prove anything about review M9. "
                "Name a bundle whose [PAD] is elsewhere (--blank-language nn / da / ko)."
            )
        labels = {
            "matrix": "blank_id (shipped)",
            "unaware": "unaware (pre-W4)",
            "kernel": "kernel told 0",
        }
        for arm in BLANK_ARMS:
            label = labels[arm]
            started = time.time()
            try:
                got = decode(texts, emissions, language=song.language, arm=arm)
            except Exception as failed:  # noqa: BLE001 - a decode the wrong blank made impossible IS a result
                print(f"  {label:20s} RAISED {type(failed).__name__}: {failed}")
                rows.append(
                    {
                        "song": song.slug,
                        "language": song.language,
                        "bundle": emissions.model,
                        "bundle_language": bundle_language,
                        "blank": arm,
                        "blank_id": int(emissions.blank_id),
                        "raised": f"{type(failed).__name__}: {failed}",
                    }
                )
                continue
            row = {
                **score(song, got),
                "target": target,
                "bundle": emissions.model,
                "bundle_language": bundle_language,
                "blank": arm,
                "blank_id": int(emissions.blank_id),
                "seconds": round(time.time() - started, 2),
            }
            rows.append(row)
            print(
                f"  {label:20s} gross {row['gross']:3d}/{row['lines']:3d} dropped {row['lines_dropped']:3d} "
                f"±500 {100 * row['line_pm500'] / max(1, row['lines']):5.1f}% | words {row['words']:4d} "
                f"±250 {100 * row['word_pm250'] / max(1, row['words']):5.1f}% "
                f"±300 {100 * row['word_pm300'] / max(1, row['words']):5.1f}% "
                f"AAE {row['word_aae_ms'] or 0:7.1f}ms >2s {row['words_over_2s']:4d}  {row['seconds']:4.1f}s",
                flush=True,
            )
    return rows


def report_blank(rows: Sequence[Mapping[str, Any]]) -> None:
    print("\n═══ REVIEW M9, LIVE ═══")
    for blank in BLANK_ARMS:
        chosen = [row for row in rows if row.get("blank") == blank and "raised" not in row]
        got = pooled(chosen)
        raised = [row for row in rows if row.get("blank") == blank and "raised" in row]
        if not got:
            print(f"{blank:7s} every decode raised: {[row['raised'] for row in raised][:2]}")
            continue
        print(
            f"blank={blank:7s} songs={got['songs']:2d} lines={got['lines']:4d} "
            f"dropped={got['lines_dropped']:3d} gross={got['gross']:3d} "
            f"±500={got['line_pm500_pct'] or 0:5.2f}% | words={got['words']:5d} "
            f"±250={got['word_pm250_pct'] or 0:5.2f}% ±300={got['word_pm300_pct'] or 0:5.2f}% "
            f"AAE={got['song_aae_ms'] or 0:7.1f}ms >2s={got['words_over_2s']:4d}"
            + (f"  ({len(raised)} decodes RAISED)" if raised else "")
        )
    print(
        "\nREAD IT THIS WAY. `matrix` is what ships. `unaware` is the pre-W4 chain — the same readers "
        "with the two fields absent, so all five hard-coded zeros come back at once — on a REAL bundle "
        "whose [PAD] is at 31 rather than on the review's permuted English columns, and the gap between "
        "those two rows IS review M9's cost, measured live. `kernel` is the partial fix (the matrix says "
        "31 and only the kernel is told 0): it does not mis-time, it RAISES, which is what a half-threaded "
        "blank looks like and why the five places had to move together."
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--target", choices=("stem", "mix"), default="stem")
    parser.add_argument("--languages", default=",".join(SWEEP_LANGUAGES))
    parser.add_argument("--songs", type=int, default=0, help="first N songs per language (0 = all)")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--model", default=None, help="the ENGLISH bundle; unset = this device's default")
    parser.add_argument("--folds", action="store_true", help="the fold census, no model")
    parser.add_argument("--blank", action="store_true", help="review M9 live, on a non-zero-pad bundle")
    parser.add_argument("--blank-language", default=BLANK_LANGUAGE)
    parser.add_argument("--out", default=None)
    parser.add_argument("--from", dest="from_rows", default=None)
    args = parser.parse_args()
    warnings.filterwarnings("ignore")
    root = lib.bench_root()

    if args.folds:
        report_folds(root)
        return

    if args.from_rows:
        stored = json.loads(Path(args.from_rows).read_text(encoding="utf-8"))
        rows = list(stored["rows"])
        (report_blank if stored.get("mode") == "blank" else report_sweep)(rows)
        return

    chosen = [code.strip() for code in args.languages.split(",") if code.strip()]
    songs = discover(root, chosen)
    if args.songs:
        per: Counter[str] = Counter()
        kept = []
        for song in songs:
            if per[song.language] < args.songs:
                per[song.language] += 1
                kept.append(song)
        songs = kept
    print(f"{len(songs)} songs: {Counter(song.language for song in songs)}")

    started = time.time()
    if args.blank:
        rows = blank_proof(songs, bundle_language=args.blank_language, device=args.device, target=args.target)
        report_blank(rows)
    else:
        rows = sweep(songs, target=args.target, device=args.device, model=args.model)
        report_sweep(rows)
    print(f"\n{len(rows)} rows in {time.time() - started:.0f}s")
    if args.out:
        path = Path(args.out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "mode": "blank" if args.blank else "sweep",
                    "target": args.target,
                    "device": args.device,
                    "model": args.model or ml.default_align_model(args.device),
                    "unicodedata": unicodedata.unidata_version,
                    "rows": rows,
                },
                indent=1,
            ),
            encoding="utf-8",
        )
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
