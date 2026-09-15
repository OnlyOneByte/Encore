#!/bin/bash
# Does demucs-mlx's `-b/--batch-size` buy anything on Apple Silicon?
#
# WHY THIS EXISTS. `MlxDemucsEngine` accepts a `batch_size` and `mlx_argv` emits `-b`, but nothing ever
# supplied one, so the flag was unreachable in production. Before picking any DEFAULT for it, the number
# has to exist — and this repo has never measured anything on Apple Silicon (SUMMARY.md's box table still
# says "M1 Pro — Nothing measured yet").
#
# THE PRIOR, and why it does not settle the question. SUMMARY.md §2 measured batch 1 vs batch 4 on
# BS-RoFormer on the 32-core Graviton box: 253s -> 247s, and concluded "batching is worthless (1.02x —
# 32 cores already saturate at batch 1)". That mechanism is the whole reason it does not transfer:
# batching helps precisely when the device is UNDER-utilised at batch 1, and a saturated 32-core CPU is
# the opposite of a Metal GPU waiting on per-call launch overhead. Expect a different answer here, or
# confirm there is none.
#
# WHAT IS MEASURED. Wall time for a fixed clip, min of REPS, as a realtime factor (rt = wall / clip
# seconds) so it is comparable to every other number in SUMMARY.md. Model LOAD time is INCLUDED here,
# unlike family_bench.sh which subtracts it via audio-separator's own "Separation duration" line —
# demucs-mlx prints no equivalent. Load is a fixed per-process cost that biases every row EQUALLY, so
# the comparison between batch sizes stays valid while the absolute rt reads pessimistic. A long-lived
# worker pays load once, so treat the DELTAS here as the real result, not the absolute figures.
#
# Peak memory matters as much as speed: batching trades memory for throughput, and the reason a default
# is risky is that a value that helps a 32 GB M-series box can OOM a 16 GB one mid-song, which the room
# sees as a failed song. `/usr/bin/time -l` gives maximum resident set size on macOS.
#
# USAGE
#   ./mlx_batch_bench.sh /path/to/song.(wav|flac|m4a)   [clip_seconds] [reps]
#
# Requires: demucs-mlx and ffmpeg on PATH, and an Apple-Silicon machine (MLX is Metal-only; this script
# will refuse to run anywhere else rather than produce numbers that mean nothing).
set -u

SRC=${1:?usage: mlx_batch_bench.sh <audio file> [clip_seconds] [reps]}
CLIP_SECONDS=${2:-30}
REPS=${3:-3}
MODEL=${MODEL:-htdemucs}
BATCHES=${BATCHES:-"control 1 2 4 8"}

OUT=${OUT:-./mlx-batch-results.txt}
WORK=$(mktemp -d)
CLIP="$WORK/clip.wav"
trap 'rm -rf "$WORK"' EXIT

# ── refuse to produce meaningless numbers ────────────────────────────────────────────────────────
if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "REFUSING: MLX is Apple-Silicon-only (found $(uname -s)/$(uname -m))." >&2
  echo "demucs-mlx cannot run here, so any number this produced would be fiction." >&2
  exit 2
fi
command -v demucs-mlx >/dev/null || { echo "demucs-mlx not on PATH" >&2; exit 2; }
command -v ffmpeg     >/dev/null || { echo "ffmpeg not on PATH" >&2; exit 2; }

ffmpeg -y -v error -i "$SRC" -t "$CLIP_SECONDS" -ac 2 -c:a pcm_s16le "$CLIP" || exit 2

{
  echo "# demucs-mlx batch-size sweep"
  echo "# date=$(date -u +%Y-%m-%dT%H:%M:%SZ) host=$(uname -m) model=$MODEL"
  echo "# clip=${CLIP_SECONDS}s reps=$REPS source=$(basename "$SRC")"
  echo "# rt = wall / clip_seconds, min of $REPS. Load time INCLUDED (see header) — compare DELTAS."
  echo "# columns: batch | best_wall_s | rt | max_rss_mb | reps"
} > "$OUT"

# One untimed warm-up so first-run weight download / disk cache never lands inside a measured rep.
echo "warming up (untimed)…" >&2
demucs-mlx -n "$MODEL" -o "$WORK/warm" "$CLIP" >"$WORK/warm.log" 2>&1 </dev/null || {
  echo "warm-up FAILED — see $WORK/warm.log; copying it out" >&2
  cp "$WORK/warm.log" ./mlx-batch-warmup-failed.log
  exit 2
}

for b in $BATCHES; do
  best=""; best_rss=""
  for rep in $(seq 1 "$REPS"); do
    rm -rf "$WORK/out"; mkdir -p "$WORK/out"
    log="$WORK/b$b-$rep.log"
    argv=(demucs-mlx -n "$MODEL" -o "$WORK/out")
    # `control` omits -b entirely: that is what the worker does when batch_size is unset, and it is the
    # baseline any wired default has to beat to be worth existing.
    [ "$b" != "control" ] && argv+=(-b "$b")
    argv+=("$CLIP")

    start=$(date +%s)
    /usr/bin/time -l "${argv[@]}" >"$log" 2>&1 </dev/null
    rc=$?
    end=$(date +%s)
    wall=$((end - start))

    if [ $rc -ne 0 ]; then
      # An OOM or an unsupported flag is a RESULT, not a script failure — record and move on.
      echo "$b|FAILED rc=$rc|$(grep -oiE '(error|killed|out of memory)[^\"]{0,90}' "$log" | tail -1)" >> "$OUT"
      best=""; break
    fi
    rss=$(grep -oE '[0-9]+  maximum resident set size' "$log" | tail -1 | grep -oE '^[0-9]+')
    rss_mb=$(( ${rss:-0} / 1048576 ))
    if [ -z "$best" ] || [ "$wall" -lt "$best" ]; then best=$wall; best_rss=$rss_mb; fi
    echo "  batch=$b rep=$rep wall=${wall}s rss=${rss_mb}MB" >&2
  done
  [ -z "$best" ] && continue
  rt=$(awk -v w="$best" -v c="$CLIP_SECONDS" 'BEGIN{printf "%.2f", w/c}')
  echo "$b|${best}|${rt}|${best_rss}|$REPS" >> "$OUT"
done

echo DONE >> "$OUT"
echo >&2
echo "results -> $OUT" >&2
cat "$OUT" >&2
echo >&2
echo "NEXT: paste these into docs/benchmarks/SUMMARY.md §7 and decide the default there." >&2
echo "A row that does not beat 'control' by a margin worth a memory risk means the answer is" >&2
echo "'leave ENCORE_MLX_BATCH_SIZE unset', which is a real result and should be recorded as one." >&2
