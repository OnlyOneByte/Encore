# Separation benchmarks

Every separation measurement taken on Encore, in one place. **Append here; do not overwrite.** A
number without a date and a box is worthless six months from now, so every row carries both.

Supporting scripts live in [`scripts/`](scripts/). Raw logs and produced audio are deliberately NOT
committed (they are hundreds of MB); they live under `.kiro/autopilot/encore-b8-b9-b3c7/artifacts/`
on the box that ran them and are reproducible from the scripts.

## The one number: realtime factor (rt)

**rt = wall-clock seconds per second of song.** Everything below normalises to it, because raw
seconds-per-window is not comparable across checkpoints — they disagree on window size (8s vs 11s)
*and* on how many overlapping passes they make (2, 4, or 8). Cost is linear in that overlap count:

```
rt = (seconds per window / window seconds) x num_overlap
```

Bands used in `apps/core/src/lib/contract/lyrics/separators.ts`: `fast` < 1, `medium` < 4, `slow` beyond.
**rt < 1 is a live cook** (finishes while the singer waits). **rt > ~2 is an upgrade tier** — cook it
in the background and swap the instrumental in later.

## Boxes

| id | hardware | notes |
|---|---|---|
| **G3** | 32-core Graviton 3 (Neoverse V1, aarch64), CPU only | dev box. SVE256, bf16 + i8mm present. torch 2.8.0+cpu links oneDNN 3.7.1 **without** Arm Compute Library (`BLAS_INFO=open`). ~2.2 TFLOPS fp32 peak, ~300 GB/s |
| **M1** | M1 Pro MacBook | ~5.3 TFLOPS fp32 / ~10.6 fp16, ~200 GB/s. **Nothing measured yet** |
| **A380** | AMD x86 + Intel Arc A380 (deploy box) | 4.19 TFLOPS fp32, 8.40 fp16 via XMX, 6 GB, 186 GB/s. **Nothing measured yet** |

Note A380 and M1 are only ~2–5x G3 on paper, not the 10–40x a CUDA card would be — and A380's
186 GB/s is *below* G3's memory bandwidth. Combined with the thread-scaling result below, **no engine
here becomes live-tier by moving hardware.**

---

## 1. Engine A/B — the original comparison (2026-09-03, G3)

Identical decoded source: 2:51 (171.5s) "Zombie Song", 44.1kHz stereo 16-bit, all output FLAC.

| engine | wall | rt | vocals SDR (published) |
|---|---|---|---|
| htdemucs | 50s | **0.29** | 10.0 |
| htdemucs_ft (bag of 4, `-j4`) | 95s | **0.55** | 10.8 |
| BS-RoFormer 1297 | 2629s (43m49s) | **13.29** | 12.9 |

Owner verdict: RoFormer sounds better, htdemucs is far faster → **keep both, make it selectable.**
That is why selectability is the feature rather than a single winner.

## 2. Where BS-RoFormer's 43 minutes goes (2026-09-03, G3)

The 52.6x gap versus htdemucs decomposes into two very different halves:

- **4x is configuration.** The checkpoint's own YAML sets `inference.num_overlap: 4` on an 8s
  window, so every second of audio is separated four times. 171.5s → 83 windows, and the log shows
  exactly 83.
- **~13x is the model.** One window costs 27.7s = 3.5x realtime for a *single* pass.

Only the first half is recoverable by tuning. Confirmed by the sweep below (24s clip except where
noted, `MDX23C`-style integer overlap):

| config | windows | wall | s/window |
|---|---|---|---|
| overlap 4, batch 1, 32 threads | 9 | 253s | 27.61 |
| overlap 2, batch 1, 32 threads | 5 | 138s | 26.71 |
| overlap 4, batch 4, 32 threads | 9 | 247s | 26.93 |
| overlap 4, batch 1, 16 threads *(12s clip)* | 3 | 121s | 38.73 |
| overlap 4, batch 1, 8 threads *(12s clip)* | 3 | 116s | 37.21 |
| overlap 4, batch 1, 32 threads *(12s clip, control)* | 3 | 88s | 27.85 |

**Conclusions.** Overlap is a pure linear multiplier (4→2 gave 1.83x wall, per-window cost
unchanged). **Batching is worthless** (1.02x — 32 cores already saturate at batch 1). **Thread
scaling is poor**: 8→32 threads is 4x the cores for 1.34x, and 8→16 gains nothing at all. That last
result is the important one — it says the workload is memory-bound or has a large serial fraction, so
a bigger CPU is not the answer and FLOP-heavy accelerators will underdeliver against peak TFLOPS.

## 3. Precision and compilation (2026-09-03, G3)

Single-window forward pass on BS-RoFormer 1297, min of 3 reps after a warm-up. This direct-forward
method matched the full pipeline's per-window cost to within 0.3% (27.68s vs 27.61s), so it is a
faithful and much cheaper proxy.

| path | s/window | vs fp32 |
|---|---|---|
| fp32 | 27.68 | — |
| **bf16 autocast** | **16.55** | **1.67x faster** |
| fp16 autocast | 179.22 | **6.5x slower** |
| `torch.compile` | — | FAILED: C++ compile error, no usable g++ in the worker image |

**fp16 is dead on CPU** (no fp16 CPU kernels — it emulates). bf16 is the CPU dtype and is
near-lossless numerically, since bf16 keeps fp32's exponent range and truncates only the mantissa.
But see §4: **the sign of the bf16 win reverses per checkpoint**, so it cannot be a global switch.
Attention already runs on `torch.scaled_dot_product_attention`, so there is no win left there.

## 4. Checkpoint cost sweep — the big one (2026-09-03, G3)

Direct single-window forward, min of 2 reps. Script: [`scripts/checkpoint_cost.py`](scripts/checkpoint_cost.py).

| checkpoint | target | params | dim/depth | window | own overlap | fp32 s/win | bf16 s/win | **rt @ own defaults** |
|---|---|---|---|---|---|---|---|---|
| **mel instrumental_becruily** | Instrumental | 228M | 384/6 | 8.0s | 2 | **5.14** | 7.09 | **1.28** |
| mel kim_ft_unwa | vocals | 228M | 384/6 | 11.0s | 8 | 15.49 | 7.23 | 11.27 → **1.31** at ov2+bf16 |
| mel instrumental_gabox | Instrumental | 228M | 384/6 | 11.0s | 2 | 15.26 | 8.48 | 2.77 → 1.54 bf16 |
| mel instrumental_bleedless_v3 | Instrumental | 228M | 384/6 | 11.0s | 2 | 15.99 | 10.16 | 2.91 → 1.85 bf16 |
| mel ep_3005 (classic) | Vocals | 252M | 384/12 | 8.0s | 4 | 7.92 | 14.52 | 3.96 → 1.98 fp32 ov2 |
| **bs_roformer 1297** (current roformer default) | Vocals | 160M | 512/12 | 8.0s | 4 | 26.59 | 16.55 | **13.29** |

**A RoFormer-family instrumental cook goes 43.8 min → 3.7 min on existing hardware: 10.4x, no GPU.**
This single lever beats every config knob and every hardware option combined.

Three results that must survive into any implementation:

1. **Parameter count is anti-correlated with cost.** 228M `instrumental_becruily` is 5.2x faster per
   window than 160M `bs_roformer-1297`. `depth` (6 vs 12) and `dim` (384 vs 512) dominate, and
   band-split attention is intrinsically heavier than mel-band. **Never infer cost from file size.**
2. **bf16 flips sign per checkpoint.** 1.6x faster on bs_roformer-1297 and on the 11s-window models,
   but 1.4–1.8x *slower* on both 8s-window models. Precision is a per-checkpoint measurement.
3. **Overlap defaults are booby-trapped.** `kim_ft_unwa` ships `num_overlap: 8`, so judged at its own
   defaults it looks like an 11x dog; at overlap 2 with bf16 it ties the fastest model.

⚠️ **Speed only — quality is unmeasured.** `bs_roformer-1297` is the only candidate with a published
SDR (12.9755) and the only one the owner has heard. The becruily/gabox models are community
fine-tunes. Several carry **non-commercial / research licence terms** on their Hugging Face cards —
check before whitelisting. A listening test to rank the candidate models is open work (the separator
swap, see `docs/DECISIONS.md`).

## 5. Cross-architecture sweep — MDX23C and the karaoke families

Script: [`scripts/family_bench.sh`](scripts/family_bench.sh). CLI-based rather than direct-forward,
because these candidates span three architecture families (MDXC `.ckpt`, MDX `.onnx`, VR-arch
`.pth`) that do not share a `model_run` attribute. rt is computed from the log's
`Separation duration`, which excludes one-off model load.

Motivation: our whitelist only offers `demucs`, `roformer` and `ensemble`, but `audio-separator`
serves **four** architecture families. MDX and VR-arch are entirely unrepresented and are cheap.
Separately, a **karaoke** (lead-vs-backing) split is a pipeline stage Encore does not have at all —
commercial karaoke keeps the backing vocals and removes only the lead.

24s clip, 32 threads, fp32, each model's own defaults. Reference: htdemucs 0.29, htdemucs_ft 0.55,
`mel instrumental_becruily` 1.28, `bs_roformer 1297` 13.29.

| model | family | stage | sep time | **rt** | verdict |
|---|---|---|---|---|---|
| `UVR_MDXNET_KARA_2.onnx` | MDX / ONNX | karaoke (lead vs backing) | 13s | **0.54** | **live tier** — matches htdemucs_ft |
| `5_HP-Karaoke-UVR.pth` | VR-arch | karaoke (lead vs backing) | 19s | **0.79** | **live tier** |
| `mel_band_roformer_karaoke_becruily.ckpt` | MDXC | karaoke (lead vs backing) | 182s | 7.58 | upgrade tier |
| `MDX23C-8KFFT-InstVoc_HQ.ckpt` | MDXC | instrumental | 413s | **17.21** | **disqualified** |

**Two findings, both surprising.**

**MDX23C is the most expensive thing measured here — worse than BS-RoFormer.** It was the leading
"zero-integration drop-in" candidate (already a first-class MDXC path in `audio-separator`, ~10.17 dB
published vocals SDR) and desk research estimated it in the 1–4 rt range. It measured **17.21**, off by
roughly 5x, and 1.3x more expensive than the BS-RoFormer we already consider too slow for live use. It
is not a live option and it is not even a good upgrade option, since `mel instrumental_becruily` is
13x cheaper at comparable published quality. Dropped from consideration — and a reminder that a
published SDR plus a param count predicts cost badly enough to be useless.

**The lead-vs-backing karaoke split is LIVE-TIER, at 0.54.** This is the most valuable result in this
file. The feature Encore lacks — keeping backing vocals while removing only the lead, which is what
commercial karaoke tracks do and what gives a singer a melodic anchor — is available *below realtime*
on the existing CPU box, on par with `htdemucs_ft` (0.55). It does not need a GPU, does not need to be
an upgrade-tier background job, and comes from two architecture families the whitelist currently
ignores entirely. The RoFormer karaoke variant (7.58) exists as a later quality ceiling if the cheap
models disappoint.

⚠️ Quality unmeasured for all four. rt says only what a cook costs, not whether the lead is cleanly
removed or the backing survives intact — that needs a listening test.

## 6. Weight provenance (checked 2026-09-03)

Cost is not the only gate. **Code licences are uniformly clean; weight licences are not.**

| artifact | licence |
|---|---|
| `nomadkaraoke/python-audio-separator` (code) | MIT |
| `Anjok07/ultimatevocalremovergui` (code) | MIT |
| `ZFTurbo/Music-Source-Separation-Training` (code) | MIT |
| htdemucs / htdemucs_ft weights | MIT (Meta, `dl.fbaipublicfiles.com`) |
| `TRvlvr/model_repo` — the mirror `audio-separator` actually downloads community weights from | **NO LICENSE FILE** |
| `becruily/mel-band-roformer-instrumental` (HF) | **no licence declared** — no tag, no `cardData.license` |
| `GaboxR67/MelBandRoformers` (HF) | **no licence declared** |
| `pcunwa/Mel-Band-Roformer-Inst` (HF) | **no licence declared** |

So the fast mel-band checkpoints — the whole 10.4x win in §4 — are **not** non-commercially licensed
as first assumed; they carry **no licence grant at all**, distributed via a mirror that also has none.
Default copyright applies, which is a weaker position than an explicit non-commercial licence: there
is no stated permission to rely on. Practically the entire UVR ecosystem operates this way, and for a
self-hosted personal instance the risk posture is one the owner can simply accept. But it cannot be
described as licensed, and baking these in as whitelisted defaults in a public repo would assert a
right nobody granted. **Recommended posture:** keep clean-provenance models (htdemucs, MIT) as the
shipped defaults, and treat unlicensed community checkpoints as opt-in the operator enables
knowingly — the whitelist already has the shape for this.

---

## Method notes, so numbers stay comparable

- **Always report rt**, and state the box and date. Raw wall-clock for one song is not portable.
- **Minimum of N reps, not the mean.** We want the machine's capability; an outlier is contention.
- **A single-window forward is a valid proxy** for per-window pipeline cost (verified to 0.3%) and is
  far cheaper than a full cook. Use it for checkpoint comparisons; use the CLI when comparing across
  architecture families or when overlap/IO behaviour is itself under test.
- **Quiesce the box first.** One 30-loadavg stray process invalidates a whole sweep.
- **Say what is unmeasured.** Every estimate in this file is labelled as one.
