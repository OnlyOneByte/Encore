#!/usr/bin/env bash
# Run every (model, device, song) combination SEQUENTIALLY and log each to its own file.
#
# SEQUENTIAL IS THE POINT. These are timing measurements, and two separators sharing 10 cores or one GPU
# produce numbers that describe the contention rather than the model. `set -e` is deliberately NOT used:
# one combination failing (an unsupported device, a missing checkpoint) should not abandon the rest.
#
#   bash docs/benchmarks/stem-separation/scripts/run-matrix.sh <outdir> [song ...]
#
# With no song named, every song in the catalogue runs — which is hours. Name one to get every engine on
# that single song, which is the comparison that actually decides anything:
#
#   bash docs/benchmarks/stem-separation/scripts/run-matrix.sh /tmp/bench-matrix tfr-mayday
#
# Read the results with: grep -hE "^(model|  (load|inference|instrumental|vocals|\(passthrough))" <outdir>/*.log
set -u
cd "$(dirname "$0")"
OUT="${1:-/tmp/bench-matrix}"
shift || true
SONGS=("${@:-}")
[ -z "${SONGS[0]}" ] && SONGS=(tfr-flyaway tfr-mayday tfr-chosen)
mkdir -p "$OUT"

run() {  # model device song
  local log="$OUT/$3-$1-$2.log"
  if grep -q "passthrough" "$log" 2>/dev/null; then
    echo "SKIP  $3 $1 $2  (already complete)"
    return
  fi
  echo "RUN   $3 $1 $2  -> $log"
  local started=$SECONDS
  uv run --project ../../../../new-worker python bench.py "$1" --device "$2" --song "$3" >"$log" 2>&1 \
    || echo "FAIL  $3 $1 $2  (see $log)"
  echo "      $((SECONDS - started))s"
}

for song in "${SONGS[@]}"; do
  run melband-kim-vocal-2 cpu "$song"   # MLX: always Metal, the flag is ignored
  run htdemucs            mps "$song"
  run htdemucs            cpu "$song"
  # LAST within each song: 3.9x realtime means ~30 min for one song's two passes.
  run bs-roformer         cpu "$song"
done

echo "DONE"
