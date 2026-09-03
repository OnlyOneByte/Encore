"""Per-checkpoint RoFormer cost comparison, normalised to a realtime factor.

Each roformer carries its OWN chunk_size and num_overlap (measured: bs_roformer 8s/overlap-4,
kim_ft_unwa 11s/overlap-8), so raw seconds-per-window is NOT comparable across models. The
comparable number is the realtime factor:

    rt = (window_time / window_seconds) * num_overlap

i.e. seconds of wall-clock per second of song at that model's own defaults. Reference points on
this box: htdemucs = 50s for a 171.5s song = rt 0.29; bs_roformer 1297 = rt 13.3.

Config comes from `separator.model_instance.model_data` (the parsed dict) rather than from a
guessed YAML path -- the on-disk config filename does not match the checkpoint stem for every
model (some are `config_<stem>.yaml`, and at least one ships no YAML of its own).

Timing is a direct single-window forward, which the pipeline sweep showed matches the real
per-window cost to within 0.3% (27.68s direct vs 27.61s pipeline) at a fraction of the wall-clock.
"""
import json
import time
import traceback

import torch
from audio_separator.separator import Separator

torch.set_num_threads(32)

MODELS = [
    "model_bs_roformer_ep_317_sdr_12.9755.ckpt",           # current Encore roformer default
    "model_mel_band_roformer_ep_3005_sdr_11.4360.ckpt",    # classic MelBand baseline
    "mel_band_roformer_kim_ft_unwa.ckpt",
    "mel_band_roformer_instrumental_becruily.ckpt",
    "mel_band_roformer_instrumental_gabox.ckpt",
    "mel_band_roformer_instrumental_bleedless_v3_gabox.ckpt",
]


def time_forward(model, x, autocast_dtype=None, reps=2):
    """Minimum of `reps` timed forwards after one warm-up. Minimum, not mean: we want the
    machine's capability, and an outlier here is contention, never the model being faster."""
    def once():
        if autocast_dtype is None:
            model(x)
        else:
            with torch.autocast("cpu", dtype=autocast_dtype):
                model(x)

    with torch.inference_mode():
        once()
        times = []
        for _ in range(reps):
            start = time.perf_counter()
            once()
            times.append(time.perf_counter() - start)
    return round(min(times), 2)


results = []
for name in MODELS:
    rec = {"model": name}
    try:
        t0 = time.perf_counter()
        sep = Separator(output_dir="/tmp/out", model_file_dir="/models", log_level=40)
        sep.load_model(model_filename=name)
        rec["load_s"] = round(time.perf_counter() - t0, 1)

        inst = sep.model_instance
        model = inst.model_run.eval()
        rec["params_M"] = round(sum(p.numel() for p in model.parameters()) / 1e6, 1)

        data = inst.model_data
        audio = data.get("audio", {})
        mdl = data.get("model", {})
        chunk = audio.get("chunk_size")
        sr = audio.get("sample_rate", 44100)
        overlap = inst.overlap
        rec.update(
            chunk=chunk,
            overlap=overlap,
            dim=mdl.get("dim"),
            depth=mdl.get("depth"),
            num_bands=mdl.get("num_bands"),
            target=(data.get("training") or {}).get("target_instrument"),
        )

        x = torch.randn(1, 2, chunk)
        rec["fp32_s_per_window"] = time_forward(model, x)
        rec["bf16_s_per_window"] = time_forward(model, x, autocast_dtype=torch.bfloat16)

        window_seconds = chunk / sr
        rec["window_seconds"] = round(window_seconds, 2)
        rec["rt_fp32_default_overlap"] = round(
            rec["fp32_s_per_window"] / window_seconds * overlap, 2
        )
        rec["rt_fp32_overlap2"] = round(rec["fp32_s_per_window"] / window_seconds * 2, 2)
        rec["rt_bf16_overlap2"] = round(rec["bf16_s_per_window"] / window_seconds * 2, 2)
    except Exception as exc:  # noqa: BLE001 - one bad checkpoint must not sink the sweep
        rec["error"] = type(exc).__name__ + ": " + str(exc)[:200]
        traceback.print_exc()

    results.append(rec)
    print(json.dumps(rec), flush=True)

with open("/artifacts/models-results-2.json", "w") as fh:
    json.dump(results, fh, indent=2)
print("DONE", flush=True)
