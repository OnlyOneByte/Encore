# Forced-alignment benchmarks

How accurately the worker places lyrics on a recording, measured against timings a **human** wrote or
measured for that exact recording.

The worker's own `TimingReport` (`domain/lyrics/measure.py`) only checks self-consistency: coverage,
overshoot, words out of order. That catches a broken alignment. It cannot tell a correct alignment from one
that is uniformly 800 ms late, because nothing in it knows where the words really are. Ground truth closes
that gap.

The full measurement history, wave by wave, is in [`LOG.md`](LOG.md). The worker's code cites its sections
by title for the number behind each constant.

## Method

**Ground truth, three kinds.** Every truth file is `truth-lines.json` (plus `truth-words.json` where words
exist) per song.

| source | songs | what it gives | script |
| --- | --- | --- | --- |
| Authored YouTube captions (`--write-subs`, never auto-generated) | 9 + the 3 `tfr-*` songs in `../benchmark-songs/` | line onsets | `scripts/truth.py` |
| [JamendoLyrics](https://github.com/f90/jamendolyrics) | 20 English | MEASURED line **and word** onsets | `scripts/jamendo.py` |
| [AMLL TTML DB](https://github.com/amll-dev/amll-ttml-db) | 7 zh / ja / ko | line and syllable onsets | `scripts/amll.py` |

Captions are authored, not ASR, on purpose: scoring an aligner against another model's output measures
agreement between two models, not correctness. `truth.py` refuses a song that has no authored track.

**The corpus's own truth is measured too.** `scripts/truth_displacement.py` measures how far each truth sheet
sits from its own audio and writes `corpus-truth.json`. Four English songs whose sheet cannot score an
aligner (`believer`, `bad-guy`, `tfr-chosen`, which lead their audio by more than 250 ms, and `numb`, whose
vocals never go quiet enough to measure) stay in the corpus but leave accuracy scoring, so the pooled numbers
are read over **28 songs**. Each results file names them and why in `meta.accuracy_excluded`.

**The harness drives the shipped code.** `scripts/e2e.py` runs the worker's own alignment over the corpus:

- `--level generate`: the raw global decode alone, to tell a decoder change from a repair-ladder change.
- `--level time_text`: the shipped `AlignStepsImpl.time_text`, with every repair, gate and grade.
- `--level run_align`: the whole job, including the LINE_SYNC fallback rung a room actually sees.

It runs on a vocals stem separated from each song's mix, with real durations and the worker `Config` read
from the environment, so an `ENCORE_ALIGN_*` setting reaches the shipped code and is recorded in the run.

**Claim noise.** A song is aligned under many claim modes (`--modes`): the true timings, jittered (σ 0.3 s),
offset (±0.5-5 s), tempo-scaled, partial (`drop20`/`drop50`), with an extra verse, section headers or a
credit line, with no timings (`blind`), and with another song's text (`wrongtext`, which must be refused).

**Metrics.** Lines pair by identity, never by text. Per line: published start minus truth start; `gross` is
more than 2 s off; `pm500` / `pm1000` are within ±500 ms / ±1 s; `high_bad` is a line graded `high` that is
more than 0.5 s off. Per word (Jamendo): within ±100/±250/±300 ms, AAE and PCO@0.3. For `wrongtext`, the pass
rate: how many wrong texts published.

## Current numbers

The last corpus sweep (HuBERT-Large, the shipped default; Apple-silicon `mps`; 2026-10-19). Rows:
`results/w10-{time_text,run_align}.json`, `results/w10-lines-run_align.json`.

| reading (28 scored songs) | `time_text` | `run_align` |
| --- | --- | --- |
| lines within ±500 ms, true timings | **97.31%** | **97.27%** |
| gross lines, every right-text mode (12) | 0 | 0 |
| `high` lines more than 0.5 s off | 0 | 0 |
| songs with zero gross lines | 28/28 | 28/28 |
| wrong texts published | 0/320 | 0/320 |

Jamendo words: **85.54%** within ±100 ms, **97.23%** within ±300 ms, AAE **70.6 ms**. The LINE_SYNC rung
places **100%** of lines at band 0 over the 28 songs.

Non-Latin lane, `run_align`, 7 songs (`results/w10-lane-{zh,ja,ko}-run_align.json`):

| language | published | within ±500 ms | gross | syllables within ±300 ms | wrong texts published |
| --- | --- | --- | --- | --- | --- |
| zh (4 songs) | word documents | 98.98% | 0 | 95.90% | 0 of 12 |
| ja (2 songs) | word documents | 89.66% | 0 | 82.03% | 0 of 6 |
| ko (1 song) | line-synced | 100.00% | 0 | n/a | 0 of 3 |

Known limits: 2 of ja's 65 `high` lines are more than 0.5 s off; ko has no calibration row
for its model yet, so it publishes lines, not words. Both are in `LOG.md`, "W10: the close-out sweep, and the
lane at the rung a room sees".

## Reproducing

`truth.py` runs from the repo root; everything else runs from `worker/` on its virtualenv, as each line
shows. The corpus lives outside the repo in the bench root, `$ENCORE_BENCH_ROOT` (default `~/encore-bench`),
one directory per song; run directories go to `<bench root>/_runs/<tag>`. A committed results file's `meta`
writes that root as `<bench-root>` (for example `"rows_full": "<bench-root>/_runs/w10-ra/rows.jsonl"`), so it
names a path on whichever machine re-runs it, not on the one that measured it. A `README, "..."` citation
inside a committed results file's `meta` predates the split and means [`LOG.md`](LOG.md).

```bash
# ground truth
uv run python docs/benchmarks/forced-alignment/scripts/truth.py tfr-flyaway        # authored captions, repo root
git clone https://github.com/f90/jamendolyrics "${ENCORE_BENCH_ROOT:-$HOME/encore-bench}/jamendolyrics"
cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/jamendo.py  # -> <bench root>/jamendo
cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/amll.py     # AMLL TTML DB

# the tfr songs' vocals stems, once, through production's stems path
cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/e2e.py --prepare-tfr

# a sweep (tens of minutes; one bench at a time, parallel runs thrash)
cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/e2e.py \
    --level run_align --modes all,wrongtext+ownclock --tag my-change

# compare against the last sweep and check a gate file; exit 3 if any gate rejects
cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/e2e.py \
    --level run_align --modes all,wrongtext+ownclock \
    --compare ../docs/benchmarks/forced-alignment/results/w10-run_align.json \
    --gates ../docs/benchmarks/forced-alignment/gates/w8.yaml
```

Matrices are cached under `$ENCORE_BENCH_ROOT/_emissions`, keyed on the model's loaded weights, the emitting
code and the library versions, so a cached run is byte-identical to a fresh one.

## What is here

| path | what |
| --- | --- |
| `scripts/` | the harness (`e2e.py`, `e2e_lib.py`, `e2e_gates.py`), the truth builders, calibration scripts (`*_gate.py`) and helpers (`bench.py`, `tv_parity.py`, `word_provenance.py`) |
| `results/` | committed sweeps: `<name>.json` is the summary `--compare` reads, `<name>.cases.jsonl` one line per case |
| `gates/` | reject-if gate files, one per wave of work, named for it (`w8.yaml` is the English gate the last sweep passed) |
| `corpus-truth.json` | each song's measured truth displacement, and which songs leave scoring |
| `LOG.md` | the archived measurement log |

The harness's pure half is unit-tested hermetically in `worker/tests/test_bench_e2e.py`.
