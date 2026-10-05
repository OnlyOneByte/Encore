#!/usr/bin/env python
"""Time one separator on the baseline song and score it against the artist's own stems.

    uv run python docs/benchmarks/stem-separation/scripts/bench.py htdemucs --device mps

Reports SDR and SI-SDR, the second being the one to compare across models. What each metric answers, why SDR
replaced the chord-purity proxy that scored a silent model 100%, and where the passthrough reference point
sits: docs/benchmarks/stem-separation/README.md, "Why SDR replaced the chord-purity proxy".

Timing is on the YouTube mix and scoring on the reference mix, deliberately not one file for both ("Test
inputs").
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time

import numpy as np
import soundfile as sf

import songs as catalogue


def load(path: str) -> tuple[np.ndarray, int]:
    audio, rate = sf.read(path, dtype="float64", always_2d=True)
    return audio, int(rate)


def sdr(reference: np.ndarray, estimate: np.ndarray) -> float:
    """Plain signal-to-distortion, in dB. Sensitive to a gain offset — see the module docstring."""
    n = min(len(reference), len(estimate))
    ref, est = reference[:n], estimate[:n]
    noise = float(((ref - est) ** 2).sum())
    if noise == 0:
        return float("inf")
    return 10.0 * float(np.log10(float((ref**2).sum()) / noise))


def si_sdr(reference: np.ndarray, estimate: np.ndarray) -> float:
    """Scale-invariant SDR: the estimate is projected onto the reference, so a constant gain costs nothing."""
    n = min(len(reference), len(estimate))
    ref, est = reference[:n].reshape(-1), estimate[:n].reshape(-1)
    energy = float((ref**2).sum())
    if energy == 0:
        return float("nan")
    target = (float((est * ref).sum()) / energy) * ref
    noise = float(((est - target) ** 2).sum())
    if noise == 0:
        return float("inf")
    return 10.0 * float(np.log10(float((target**2).sum()) / noise))


def run_demucs(src: str, out_dir: str, device: str) -> tuple[str, str, float]:
    """Returns (instrumental, vocals, wall seconds). Subprocess, so load and inference cannot be split."""
    started = time.time()
    subprocess.run(
        [sys.executable, "-m", "demucs.separate", "-n", "htdemucs", "--two-stems=vocals",
         "-d", device, "-j", "1", "-o", out_dir, src],
        check=True, capture_output=True,
    )
    elapsed = time.time() - started
    stem = os.path.join(out_dir, "htdemucs", os.path.splitext(os.path.basename(src))[0])
    return os.path.join(stem, "no_vocals.wav"), os.path.join(stem, "vocals.wav"), elapsed


def run_roformer(src: str, out_dir: str, device: str) -> tuple[str, str, float]:
    """bs-roformer-infer separates a FOLDER, so the input is staged alone — otherwise a sibling file in the
    same directory would be separated too, silently doubling the runtime."""
    staged = os.path.join(out_dir, "in")
    store = os.path.join(out_dir, "out")
    os.makedirs(staged, exist_ok=True)
    os.makedirs(store, exist_ok=True)
    shutil.copy2(src, os.path.join(staged, os.path.basename(src)))

    argv = ["bs-roformer-infer", "--model",
            "roformer-model-bs-roformer-instrumental-resurrection-by-unwa",
            "--input_folder", staged, "--store_dir", store]
    if device:
        argv += ["--device", device]
    started = time.time()
    subprocess.run(argv, check=True, capture_output=True)
    elapsed = time.time() - started

    # `_other` IS THE INSTRUMENTAL and `_instrumental` is the vocals. Measured, and inverted relative to the
    # filenames — see docs/benchmarks/stem-separation/README.md.
    def find(suffix: str) -> str:
        for name in sorted(os.listdir(store)):
            root, ext = os.path.splitext(name)
            if ext.lower() in (".wav", ".flac") and root.endswith(suffix):
                return os.path.join(store, name)
        raise SystemExit(f"bs-roformer wrote no file ending {suffix!r}; found {sorted(os.listdir(store))}")

    return find("_other"), find("_instrumental"), elapsed


def run_melband(src: str, out_dir: str, repo: str, preset: str) -> tuple[str, str, float, float]:
    """Single-stem: the model returns vocals and the instrumental is `mixture - vocals`, so the two are
    sample-aligned by construction. Returns (instrumental, vocals, load, inference).

    CHUNKED WITH OVERLAP-ADD, required rather than an optimisation — a whole song in one call comes back
    SILENT, length-dependently and without an error — and each chunk is Hann-windowed and normalised by the
    summed window, so the crossfades reconstruct unity gain instead of rippling at every boundary
    (docs/benchmarks/stem-separation/README.md, "Findings that came out of running these").
    """
    import mlx.core as mx
    from mlx_audio.sts.models.mel_roformer import MelRoFormer, MelRoFormerConfig

    config = getattr(MelRoFormerConfig, preset)()
    started = time.time()
    model = MelRoFormer.from_pretrained(repo, config=config)
    model.eval()
    load_sec = time.time() - started

    mix, rate = sf.read(src, dtype="float32", always_2d=True)
    chunk = int(config.chunk_size)
    hop = chunk // 2  # 50% overlap, per the model card

    started = time.time()
    if len(mix) <= chunk:
        vocals = np.array(model(mx.array(mix.T)[None])[0]).T
    else:
        acc = np.zeros_like(mix, dtype=np.float64)
        weight = np.zeros((len(mix), 1), dtype=np.float64)
        window = np.hanning(chunk).astype(np.float64)[:, None]
        for start in range(0, len(mix), hop):
            piece = mix[start : start + chunk]
            if len(piece) < 256:  # a sliver at the tail carries no usable context
                break
            padded = piece
            if len(padded) < chunk:  # zero-pad the final chunk so the model sees its expected length
                padded = np.pad(piece, ((0, chunk - len(piece)), (0, 0)))
            out = np.array(model(mx.array(padded.T)[None])[0]).T[: len(piece)]
            w = window[: len(piece)]
            acc[start : start + len(piece)] += out * w
            weight[start : start + len(piece)] += w
        # Where the window sums to ~0 (the very first and last samples) fall back to unity rather than divide.
        vocals = (acc / np.where(weight > 1e-6, weight, 1.0)).astype(np.float32)
    mx.eval(mx.array(0))  # nothing lazy is outstanding; kept so the timing boundary is explicit
    infer_sec = time.time() - started

    voc = vocals
    inst = mix[: len(voc)] - voc
    os.makedirs(out_dir, exist_ok=True)
    vp, ip = os.path.join(out_dir, "vocals.wav"), os.path.join(out_dir, "instrumental.wav")
    sf.write(vp, voc, rate)
    sf.write(ip, inst, rate)
    return ip, vp, load_sec, infer_sec


MELBAND = {
    "melband-kim-vocal-2": ("mlx-community/mel-roformer-kim-vocal-2-mlx", "kim_vocal_2"),
}


def main() -> None:
    # UNBUFFERED, because a full song is minutes per pass and Python buffers stdout when it is piped — so
    # progress lines would all land at exit and a live run looks identical to a hang. Found exactly that way.
    sys.stdout.reconfigure(line_buffering=True)

    ap = argparse.ArgumentParser()
    ap.add_argument("model", choices=["htdemucs", "bs-roformer", *MELBAND])
    ap.add_argument("--device", default="cpu", help="cpu | mps | cuda (ignored by the MLX models)")
    ap.add_argument("--song", default="tfr-flyaway",
                    help="song id from songs.py: " + ", ".join(sorted(catalogue.BY_ID)))
    ap.add_argument("--timing-input", default=None, help="overrides the song's youtube-mix.wav")
    ap.add_argument("--scoring-input", default=None, help="overrides the song's reference-mix.wav")
    ap.add_argument("--out", default="/tmp/bench")
    args = ap.parse_args()

    song = catalogue.get(args.song)
    args.timing_input = args.timing_input or song.youtube_mix
    args.scoring_input = args.scoring_input or song.reference_mix

    for path in (args.timing_input, args.scoring_input):
        if not os.path.isfile(path):
            raise SystemExit(f"missing {path} — run prepare.py {song.song_id} first")

    dur = len(load(args.timing_input)[0]) / load(args.timing_input)[1]
    print(f"model={args.model} device={args.device} song={song.song_id}")
    print(f"  timing input : {os.path.basename(args.timing_input)}  {dur:.2f}s")

    work = os.path.join(args.out, f"{song.song_id}-{args.model}-{args.device}")
    shutil.rmtree(work, ignore_errors=True)

    # ── timing, on the worker's own input ──
    load_sec: float | None = None
    if args.model in MELBAND:
        repo, preset = MELBAND[args.model]
        _i, _v, load_sec, infer = run_melband(args.timing_input, f"{work}/timing", repo, preset)
    elif args.model == "htdemucs":
        _i, _v, infer = run_demucs(args.timing_input, f"{work}/timing", args.device)
    else:
        _i, _v, infer = run_roformer(args.timing_input, f"{work}/timing", args.device)
    if load_sec is not None:
        print(f"  load         : {load_sec:7.2f}s")
    print(f"  inference    : {infer:7.2f}s   for {dur:.2f}s of audio")

    # ── quality, on the stem-aligned reference ──
    ref_mix, rate = load(args.scoring_input)
    gt_inst, _ = load(song.reference_instrumental)
    gt_voc, _ = load(song.reference_vocals)

    if args.model in MELBAND:
        repo, preset = MELBAND[args.model]
        ip, vp, _l, _i2 = run_melband(args.scoring_input, f"{work}/score", repo, preset)
    elif args.model == "htdemucs":
        ip, vp, _i2 = run_demucs(args.scoring_input, f"{work}/score", args.device)
    else:
        ip, vp, _i2 = run_roformer(args.scoring_input, f"{work}/score", args.device)

    est_inst, _ = load(ip)
    est_voc, _ = load(vp)
    print(f"  scoring input: {os.path.basename(args.scoring_input)}  "
          f"{len(ref_mix)/rate:.2f}s (stem-aligned)")
    print(f"  instrumental : SDR {sdr(gt_inst, est_inst):6.2f} dB   SI-SDR {si_sdr(gt_inst, est_inst):6.2f} dB")
    print(f"  vocals       : SDR {sdr(gt_voc, est_voc):6.2f} dB   SI-SDR {si_sdr(gt_voc, est_voc):6.2f} dB")
    # The reference point: what a passthrough would score, so a broken model is obvious rather than merely low.
    print(f"  (passthrough : SDR {sdr(gt_inst, ref_mix):6.2f} dB   "
          f"SI-SDR {si_sdr(gt_inst, ref_mix):6.2f} dB  <- est == mixture)")


if __name__ == "__main__":
    main()
