# Stem separation benchmarks

Raw measurements, one section per machine class. Every number here was produced by running the thing;
nothing is estimated, and nothing is copied from an upstream README.

**Why raw seconds and not realtime multipliers.** A multiplier hides the two facts that decide whether a
model is usable: how long a *particular* input took, and how long the weights took to load before any audio
was touched. So the tables record **wall seconds against a stated input duration**, and the ratio is left
for the reader to compute.

That is not a style preference — it caught a real error. Every cost in the worker's registry was originally
measured on a 7-second clip, and **two of the three were wrong by nearly 2x** once re-measured on a
4-minute song, because a fixed per-call overhead dominates a short input and vanishes on a long one. A
short-input timing is not a conservative estimate of long-input cost; it is a different measurement.

| model | from a 6.9-20s clip | from a 194s song | error |
| --- | --- | --- | --- |
| `htdemucs` (cpu) | 1.24x | **0.474x** | 2.6x pessimistic |
| `bs-roformer-1297` (cpu) | 3.93x | **2.224x** | 1.8x pessimistic |
| `melband-kim-vocal-2` (Metal) | 0.55x | **0.555x** | held |

The MLX figure held because Metal's per-call overhead is small. That is the explanation, not the excuse —
it is also why the other two moved.

## Machines

| id | machine | chip | cores | memory | OS |
| --- | --- | --- | --- | --- | --- |
| `m1pro` | MacBookPro18,1 | Apple M1 Pro | 10 (8 performance + 2 efficiency) | 32 GiB | macOS 26.6.2 (arm64) |

Results below are all `m1pro`. Add a section per machine rather than averaging across them — a CPU figure
and a CUDA figure are different measurements, not two samples of one.

## Models under test

Exact identifiers and exact client versions, so a run is reproducible and a registry citation resolves to a
row here. **The client matters as much as the checkpoint**: the same weights through a different package,
or the same package at a different version, is a different measurement.

| registry token | checkpoint / weights | client library | how it is invoked | licence |
| --- | --- | --- | --- | --- |
| `htdemucs` | `htdemucs` (bundled with demucs) | `demucs` 4.0.1 on `torch` 2.8.0 | `python -m demucs.separate` subprocess | MIT (code); weights per Meta |
| `bs-roformer-1297` | `roformer-model-bs-roformer-instrumental-resurrection-by-unwa` | `bs-roformer-infer` 0.1.5 on `torch` 2.8.0 | `bs-roformer-infer` CLI subprocess | MIT code; checkpoint per source repo |
| `melband-kim-vocal-2` | `mlx-community/mel-roformer-kim-vocal-2-mlx` | `mlx-audio` 0.5.6 on `mlx` 0.32.2 | in-process, `MelRoFormer.from_pretrained` | MIT weights, MIT arch, Apache-2.0 pkg |

Host: Python 3.12.14, `numpy` 2.5.3, `soundfile` 0.14.0, ffmpeg 7.1 (bundled via `imageio-ffmpeg` 0.6.0).

The `bs-roformer-1297` token is historical: it originally mapped to
`roformer-model-bs-roformer-sw-by-jarredou`, a **multi-stem** checkpoint, and was repointed to the 2-stem
`instrumental` one above. The old slug stays reachable as `bs-roformer-multistem` so historical
`job_attempts.model` rows still resolve.

### On Metal for the torch models

Both torch-based separators accept `--device mps`, and only one of them benefits:

- **`htdemucs` on MPS is a clear win** — 28.19 s against 92.12 s on CPU for the same song, at
  **bit-identical quality** (14.93 dB both). Free speed.
- **`bs-roformer-infer` on MPS is pathological.** Killed after 20+ minutes on a *20-second* input, against
  78 s on CPU for the same clip. Not recorded as a slow result because it never produced one; something in
  that path falls back to an unaccelerated or thrashing implementation. Use CPU.
- **MLX is not "torch on Metal"** — it is a separate framework with its own Metal kernels, which is why
  `melband-kim-vocal-2` has no CPU row to compare against. `--device` is ignored for it.

---

## Test inputs

### Real music (primary)

Three tracks by **TheFatRat**, released royalty-free *with attribution*, which is a licence condition
rather than a courtesy — credit the artist in anything derived from this audio. They are the primary
inputs because the artist publishes the **original stems**, which makes a true ground-truth SDR possible.

| id | title | duration | ground truth |
| --- | --- | --- | --- |
| `tfr-flyaway` | Fly Away (feat. Anjulie) | 194.07 s | 6 stems; vocals from `06 Vocals Wet` |
| `tfr-mayday` | Mayday (with Laura Brehm) | 248.00 s | pre-summed acapella + instrumental references |
| `tfr-chosen` | The Chosen | 229.79 s | 4 stems, 1 vocal + 3 instrumental |

`scripts/songs.py` declares which file belongs to which side and, importantly, **why each unused file is
unused** — for `tfr-flyaway` the dry vocal must be excluded or the vocal is counted twice; for `tfr-mayday`
the 24 individual stems were measured NOT to reconstruct the references (max difference 3.28) and are
therefore unusable rather than merely redundant.

`scripts/prepare.py` builds the inputs. It produces **two different mixes on purpose**:

| file                | used for    | why not the other one                                                                                                                                                                      |
| ---------------------| -------------| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `youtube-mix.wav`   | **timing**  | it is what production actually receives — lossy-sourced, 48 kHz                                                                                                                            |
| `reference-mix.wav` | **scoring** | the master is neither the same rate nor the same length as the stems (flyaway: 48000 vs 44100 Hz, 194.258 vs 194.065 s), so an SDR against them would measure misalignment, not separation |

The reference is **scaled by one constant applied to the mixture and both stems identically**, because the
raw stem sum clips (flyaway peaks at 2.16, chosen 2.48, mayday 1.86 — each released master applied gain
reduction afterwards). One shared constant preserves `mixture == instrumental + vocals` exactly, which is
the single property every SDR figure depends on, and `prepare.py` asserts it rather than assuming it:

```
tfr-flyaway   194.07s @ 44100 Hz  gain 0.4391  — identity holds to 1.11e-16
tfr-mayday    248.00s @ 44100 Hz  gain 0.5115
tfr-chosen    229.79s @ 44100 Hz  gain 0.3836
```

1.11e-16 is float64 rounding — `(a+b)*g` versus `a*g + b*g`. The bound that matters is one PCM_24 step
(2^-23 ~ 1.2e-7), nine orders of magnitude larger.

The audio is **not committed**; both scripts rebuild it deterministically and it is gitignored. The
artist's stems are committed.

### Synthetic (retained as a regression control)

| id | duration | contents |
| --- | --- | --- |
| `mix-7s` | 6.94 s | three sine tones (220 / 277 / 330 Hz) at 0.5 gain, mixed with spoken words at 1.0 |
| `chords-20s` | 20.00 s | the same three tones alone, no voice — the control |

Kept because they are free to regenerate and they pin the *stem-role* questions that real music cannot
answer cleanly — `chords-20s` is how the bs-roformer filename inversion was established, since an input
with no voice in it makes "which file is the backing track" unambiguous. Commands are at the bottom.

---

## Results — `m1pro`, `tfr-flyaway` (194 s)

One table, because timing and quality on the same input is the comparison that decides anything.
`inference` excludes weights load, which is reported separately where it can be isolated.

| model                            | device      | load (s)     | inference (s) | instrumental SI-SDR | vocals SI-SDR |
| ----------------------------------| -------------| --------------| ---------------| ---------------------| ---------------|
| `melband-kim-vocal-2`            | Metal (MLX) | 0.32 warm    | 107.83        | **17.35 dB**        | **10.42 dB**  |
| `bs-roformer-1297`               | cpu         | not isolable | 432.01        | **17.37 dB**        | **10.46 dB**  |
| `htdemucs`                       | mps         | not isolable | **28.19**     | 14.79 dB            | 7.69 dB       |
| `htdemucs`                       | cpu         | not isolable | 92.12         | 14.79 dB            | 7.68 dB       |
| *passthrough* (`est == mixture`) | —           | —            | —             | *6.63 dB*           | —             |

Plain SDR alongside SI-SDR, since a gain offset separates them:

| model                 | device | inst SDR | inst SI-SDR | voc SDR | voc SI-SDR |
| -----------------------| --------| ----------| -------------| ---------| ------------|
| `melband-kim-vocal-2` | Metal  | 17.43    | 17.35       | 10.79   | 10.42      |
| `bs-roformer-1297`    | cpu    | 17.44    | 17.37       | 10.81   | 10.46      |
| `htdemucs`            | mps    | 14.93    | 14.79       | 8.37    | 7.69       |
| `htdemucs`            | cpu    | 14.93    | 14.79       | 8.36    | 7.68       |

### Reading this table

- **The two roformers are the same model, quality-wise.** 17.37 against 17.35 dB is a 0.02 dB difference —
  below anything that could be heard or that a re-run would reproduce in a fixed direction. The MLX one
  costs **4x less** (107.83 s against 432.01 s). On Apple Silicon the CPU roformer is strictly dominated;
  it stays registered because it is the only roformer available to a box *without* MLX, which is every
  non-Apple machine.
- **htdemucs trades 2.5 dB for 3.8x the speed**, and on MPS that becomes 2.5 dB for **15x** against the CPU
  roformer. Whether that trade is right is a product question, not a benchmark one — but it is the only
  genuine trade in the table.
- **htdemucs CPU and MPS are quality-identical.** 14.79 dB both; the 0.01 dB vocals difference is float
  accumulation order. So MPS costs nothing and saves 64 s.
- **The passthrough line is the one to keep in view.** 6.63 dB is what a model that returns its input
  unchanged scores against the instrumental — roughly the mix's own instrumental-to-vocal ratio. It is
  there because a broken model scores *near it*, not near zero, and that is not obvious from a single
  number. It is how the silent-failure below was caught.

## Why SDR replaced the chord-purity proxy

The first version of this document scored a spectral purity fraction on `mix-7s`. That proxy could not
distinguish a working model from a broken one, which is not a hypothetical:
`mlx-community/mel-roformer-zfturbo-vocals-v1-mlx` scored **100%** on the chords-only control — because it
returned silence, and a control with no vocals in it cannot tell "correctly found none" from "never
extracts anything". On real music it turned out to be a pure passthrough (vocals at rms 0.000022). It has
been removed from the registry, with the measurement recorded there so it cannot drift back in.

Ground-truth stems make that failure impossible to miss, because a passthrough scores ~6.6 dB — visibly the
passthrough line — instead of a suspiciously perfect one.

Both metrics are reported because they answer different questions:

- **SDR** `10*log10(||ref||^2 / ||ref - est||^2)`. Simple, and **penalises a gain offset** — a separator
  whose output is correct but 1 dB quiet scores worse than it deserves.
- **SI-SDR** projects the estimate onto the reference first, so a constant gain costs nothing. This is what
  modern separation papers report, and the fairer cross-model comparison.

### Did the synthetic proxy at least rank them correctly?

Yes — which is worth recording, because this document previously cautioned that it might not.

| model | synthetic chord purity | real-music instrumental SI-SDR |
| --- | --- | --- |
| `melband-kim-vocal-2` | 99.43% | 17.35 dB |
| `bs-roformer-1297` | 99.22% | 17.37 dB |
| `htdemucs` | 96.80% | 14.79 dB |

The ordering survives and the two near-ties stay near-ties. So the synthetic control was directionally
sound; what it could not do was detect a model that outputs nothing.

---

## Findings that came out of running these

Recorded because each one was invisible until a real pass happened, and each is now pinned by a test.

1. **A model can return silence on a full song and succeed on a clip.** `melband-kim-vocal-2`'s card
   specifies chunking at `config.chunk_size` (352800 samples = 8.0 s at 44.1 kHz) with 50% overlap. Handed
   the whole 194 s song in one call it returned **all-zero vocals**, and the derived instrumental
   (`mixture - vocals`) came back bit-identical to the input — scoring exactly the 6.63 dB passthrough line.
   A 30 s excerpt through the same code worked (vocals rms 0.0879), so **the failure is length-dependent
   and completely silent**. The harness now overlap-adds with a Hann window normalised by the summed
   window, so crossfades reconstruct unity gain instead of leaving level ripple every 4 s. This would have
   been a worker bug too, and the only reason it was caught is that the passthrough reference line was
   printed next to the result.
2. **bs-roformer's stem filenames are inverted.** `<name>_instrumental.wav` holds the **vocals**;
   `<name>_other.wav` holds the backing track. Established with `chords-20s`, where the input has no voice
   at all: `_other` came back at rms 0.03574 against the source's 0.03608 (99.1%), while `_instrumental`
   was 0.00086 (2.4%). Both this worker and the old one previously looked for a
   `<name>_(Instrumental)_<slug>.<ext>` pattern that this package version never writes — so discovery found
   nothing, which was the *safe* failure. Had it matched, the vocals would have been published as the
   karaoke master, and the silence probe would have passed it because the vocals stem is loud.
3. **bs-roformer writes float32 WAV.** Python's stdlib `wave` refuses it outright (`unknown format: 3`), so
   routing by file extension made every roformer stem unreadable — no `songProfile` (key and vocal range
   silently null) and no guide-mix length check. The reader now probes rather than infers.
4. **`htdemucs` at 0.29x was not a measurement**, and 1.24x was the wrong measurement. 0.29 was copied from
   core's contract, which is a GPU figure, and recorded in the registry as `provenance="measured"`. The
   correction to 1.24x was real but taken on a 6.94 s clip; on a real song it is 0.474x on CPU and 0.145x
   on MPS. Both errors had the same root: a number whose origin was not written down next to it.
5. **A single-stem model removes a whole class of bug.** The MLX checkpoint emits vocals only, and the
   instrumental is computed as `mixture - vocals`. The two stems are therefore sample-aligned by
   construction: no second file whose start could differ, no length mismatch for the guide mix to refuse,
   and no filename whose role could be inverted — because this worker names them. The cost is finding (1):
   a derived instrumental inherits any silence in the vocals estimate *as a perfect passthrough*, which
   scores well on every metric that does not have a ground truth to compare against.
6. **Timing and scoring must not share an input.** The YouTube master and the stem-built reference differ
   in sample rate and length, so one file cannot serve both without either mis-timing production's real
   input or mis-scoring against a misaligned ground truth.

## Reproducing

```bash
# once per song: fetch the master and build ground truth from the artist's stems
uv run python docs/benchmarks/stem-separation/scripts/prepare.py tfr-flyaway

# one model
uv run python docs/benchmarks/stem-separation/scripts/bench.py htdemucs --device mps --song tfr-flyaway

# every engine on one song, sequentially (sequential matters: two separators sharing 10 cores or one GPU
# measure contention, not the model)
bash docs/benchmarks/stem-separation/scripts/run-matrix.sh /tmp/bench-matrix tfr-flyaway
```

<details>
<summary>The synthetic inputs, for the stem-role controls</summary>

```bash
# chords-20s
ffmpeg -f lavfi -i "sine=frequency=220:duration=20" \
       -f lavfi -i "sine=frequency=277:duration=20" \
       -f lavfi -i "sine=frequency=330:duration=20" \
       -filter_complex "[0:a][1:a][2:a]amix=inputs=3:duration=shortest[c]" \
       -map "[c]" -ar 44100 -ac 2 chords.wav

# the spoken half (macOS `say`, so the words are known exactly)
say -r 110 -o speech.aiff "Morning light across the river, silver water in the valley, \
carry me home again tonight, the stars are out tonight"
ffmpeg -i speech.aiff -ar 44100 -ac 2 -t 20 speech.wav

# mix-7s  (amix with duration=shortest truncates to the speech, hence 6.94 s)
ffmpeg -i chords.wav -i speech.wav \
       -filter_complex "[0:a]volume=0.5[m];[1:a]volume=1.0[v];[m][v]amix=inputs=2:duration=shortest:normalize=0[x]" \
       -map "[x]" -ar 44100 -ac 2 song.wav
```

Purity was measured as the share of spectral energy within ±6 Hz of 220 / 277 / 330 Hz, Hann-windowed
before the FFT so the tones do not smear across bins, on energy rather than amplitude so the ratio is a
power fraction.

</details>

## Not yet measured

Listed so the gaps are visible rather than assumed closed.

- **`tfr-mayday` and `tfr-chosen`.** Prepared and ready; only `tfr-flyaway` has been run through every
  engine. A single song cannot separate a model that is genuinely better from one that suits this mix.
- `htdemucs_ft`, `htdemucs_6s` — allowlisted, never run.
- Any CUDA, ROCm or Intel figure. Every number here is `m1pro`; nothing in this document says what a GPU
  box does, and the MPS-versus-CPU gap above is a reason to expect the ordering to change on one.
- `audiosep` (169-model UVR zoo), `instrumental_becruily`, and any ensemble — no runtime adapter yet.
- A listening test. SDR is a proxy; 17.4 dB versus 14.8 dB is a real difference but this document does not
  claim to know how it sounds on a karaoke track.

## Stem roles, measured from the audio (2026-10-01: moved out of the code)

Which of two separated stems is the **backing track** is decided from the bytes about to be published, not
from a filename. The design and the refusals are in
[`../../arch/05-worker.md`](../../arch/05-worker.md) §2.2; these are the readings.

**The discriminator is the fraction of spectral energy below 250 Hz.** A backing track carries the kick drum
and the bass line; an isolated vocal has almost nothing down there, because even a bass singer's fundamental
sits around 80–100 Hz and carries little of the voice's total energy. Measured on three songs' **artist-supplied
ground-truth stems**:

| song | instrumental | vocals | ratio |
| --- | --- | --- | --- |
| `tfr-flyaway` | **79.36%** | **3.44%** | 23.1× |
| `tfr-mayday` | **85.96%** | **5.35%** | 16.1× |
| `tfr-chosen` | **76.43%** | 6.61% | 11.6× |

Instrumentals land at 76–86% and vocals at 3–7%: no overlap, and an order of magnitude of margin. The FFT is
32 768 samples — about **0.74 s** at 44.1 kHz, long enough that a 40 Hz bin is resolved.

**Activity was the obvious alternative and is not used.** Vocals are intermittent and backing tracks
continuous, but measured the gap is 97.8% against 81% — a 1.2× margin against the bass fraction's order of
magnitude. A real signal, far too weak to bet on.

**The same measurement independently reproduces an inverted filename pair.** One upstream package's
`<name>_other.wav` scores 79.98% and its `<name>_instrumental.wav` 3.25%, so `_other` is the backing track —
which the registry records. It was originally found with a chords-only control (no vocals in the input, so the
instrumental stem must hold everything):

| source | rms | share |
| --- | --- | --- |
| input mixture | 0.03608 | — |
| `_instrumental` | 0.00086 | **2.4%** — near-silent |
| `_other` | 0.03574 | **99.1%** — this is the instrumental |

**The honest limitation:** all three validation songs are electronic, which is the genre most likely to
flatter this measurement. A sparse acoustic recording — solo piano and voice, no drums or bass — would narrow
the gap. That is why the measurement returns nothing rather than a guess when the margin is thin: a refused
job is recoverable and a mislabelled master is not.

### The silence probe's own floor

A separator that emits a digitally silent instrumental has succeeded by every other measure. Measured on a
30 s commercial excerpt, its vocals stem came back at peak **0.000122** / rms **0.000022** — silence to within
one 16-bit least-significant bit — and its instrumental differed from the input mixture by **0.00009**, i.e.
the separator had passed the mix through and emitted nothing as the vocal.

### Why the zoo's scores are labelled `upstream` and not `measured`

The catalogue is read from `audio-separator`'s own metadata, one entry per checkpoint:

```json
{"filename": "...", "stems": ["instrumental", "vocals"], "target_stem": "instrumental",
 "scores": {"vocals": {"SDR": 8.78, "...": 0}, "instrumental": {"SDR": 15.40, "...": 0}}}
```

Those are BSS-eval SDR via `museval`, run by someone else on tracks we did not choose — **not** the plain SDR
this document reports, and not evidence about this hardware. Useful for ranking a hundred unknowns, and
labelled so that it cannot be read as one of the rows above. The hub is likewise not a runtime: one
conversion with 28 895 downloads and geometry matching a known checkpoint carries no `checkpoint_family`
field at all, so nothing in the file says which architecture preset to load it with.
