#!/bin/bash
# End-to-end realtime-factor bench across audio-separator ARCHITECTURE families.
#
# Deliberately CLI-based rather than a direct model forward: these candidates span MDXC (.ckpt+yaml),
# MDX (.onnx) and VR-arch (.pth), which do NOT share a `model_run` module attribute, so a direct
# forward would only work for one family. The CLI is the one path common to all three.
#
# rt = "Separation duration" / clip seconds. Model LOAD time is excluded via that field, because load
# is a fixed per-process cost a long-lived worker pays once, not a per-song cost.
#
# Reference on this box (32-core Graviton 3, CPU): htdemucs rt 0.29, htdemucs_ft 0.55,
# bs_roformer-1297 rt 13.29, mel instrumental_becruily rt 1.28.
set -u
CLIP=/tmp/bench24.wav
CLIP_SECONDS=24
R=/artifacts/family-results.txt
: > "$R"

[ -f "$CLIP" ] || ffmpeg -y -v error -i /artifacts/stage1-source-44k-stereo.wav -t "$CLIP_SECONDS" -c:a pcm_s16le "$CLIP"

run() {
  local label=$1 model=$2 stage=$3
  rm -rf /tmp/out; mkdir -p /tmp/out
  local start end log
  log=/tmp/fam-$label.log
  start=$(date +%s)
  OMP_NUM_THREADS=32 audio-separator "$CLIP" \
    --model_filename "$model" --model_file_dir /models \
    --output_dir /tmp/out --output_format FLAC >"$log" 2>&1 </dev/null
  local rc=$?
  end=$(date +%s)
  if [ $rc -ne 0 ]; then
    echo "$label|$stage|$model|FAILED rc=$rc|$(grep -oiE 'error[^\"]{0,110}' "$log" | tail -1)" >> "$R"
    return
  fi
  # "Separation duration: 00:00:43" → seconds
  local sep
  sep=$(grep -oE "Separation duration: [0-9:]+" "$log" | tail -1 | grep -oE "[0-9:]+$" \
        | awk -F: '{print ($1*3600)+($2*60)+$3}')
  [ -z "${sep:-}" ] && sep=$((end-start))
  local rt
  rt=$(awk -v s="$sep" -v c="$CLIP_SECONDS" 'BEGIN{printf "%.2f", s/c}')
  echo "$label|$stage|$model|sep=${sep}s|rt=${rt}|wall=$((end-start))s" >> "$R"
}

# MDXC instrumental — the zero-integration candidate (already a first-class path in audio-separator)
run mdx23c_instvoc_hq   "MDX23C-8KFFT-InstVoc_HQ.ckpt"                  instrumental
# MDX / ONNX karaoke — cheap lead-vs-backing split
run mdx_kara2           "UVR_MDXNET_KARA_2.onnx"                        karaoke
# VR-arch karaoke — the other cheap family our whitelist ignores entirely
run vr_hp_karaoke       "5_HP-Karaoke-UVR.pth"                          karaoke
# RoFormer karaoke — highest reported lead SDR, expected expensive
run roformer_kara_becruily "mel_band_roformer_karaoke_becruily.ckpt"    karaoke

echo DONE >> "$R"
