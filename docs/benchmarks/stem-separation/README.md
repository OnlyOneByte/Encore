# Stem separation benchmarks

Raw measurements, one file per machine class. Every number here was produced by running the thing; nothing
is estimated, and nothing is copied from an upstream README.

**Why raw seconds and not realtime multipliers.** A multiplier hides the two facts that decide whether a
model is usable: how long a *particular* clip took, and how long the weights took to load before any audio
was touched. `0.55x` reads as fast until you learn the first call spent 23 seconds downloading and
initialising 456 MB. Multipliers are also not comparable across clip lengths — a fixed per-call overhead
dominates a 7-second clip and disappears on a 4-minute song. So the tables record **wall seconds against a
stated input duration**, and the ratio is left for the reader to compute if they want it.

**Why purity is measured spectrally rather than by ear.** The test input is a chord of three sine tones plus
spoken words, so "did the instrumental keep the chords and drop the voice" has an arithmetic answer: the
fraction of the instrumental's spectral energy sitting in narrow bands around 220 / 277 / 330 Hz. A listening
test is better evidence about music; this is better evidence about *regressions*, because it returns a number
that can be compared next month.

## Machines

| id | machine | chip | cores | memory | OS |
| --- | --- | --- | --- | --- | --- |
| `m1pro` | MacBookPro18,1 | Apple M1 Pro | 10 (8 performance + 2 efficiency) | 32 GiB | macOS 26.6.2 (arm64) |

Results below are all `m1pro`. Add a section per machine rather than averaging across them — a CPU figure and
a CUDA figure are different measurements, not two samples of one.

## Models under test

Exact identifiers, so a run is reproducible and a registry citation resolves to a row here.

| registry token | checkpoint / weights | runtime | licence |
| --- | --- | --- | --- |
| `htdemucs` | `htdemucs` (demucs 4.0.1 bundled) | `python -m demucs.separate` | MIT (code); weights per Meta |
| `bs-roformer-1297` | `roformer-model-bs-roformer-instrumental-resurrection-by-unwa` | `bs-roformer-infer` 0.1.5 CLI | MIT code; checkpoint per source repo |
| `melband-kim-vocal-2` | `mlx-community/mel-roformer-kim-vocal-2-mlx` | `mlx-audio` 0.5.6, in-process | MIT weights, MIT arch, Apache-2.0 pkg |
| `melband-zfturbo-vocals-v1` | `mlx-community/mel-roformer-zfturbo-vocals-v1-mlx` | `mlx-audio` 0.5.6, in-process | MIT weights |

The `bs-roformer-1297` token is historical: it originally mapped to
`roformer-model-bs-roformer-sw-by-jarredou`, a **multi-stem** checkpoint, and was repointed to the 2-stem
`instrumental` one above. The old slug stays reachable as `bs-roformer-multistem` so historical
`job_attempts.model` rows still resolve.

## Test inputs

Synthesised, so they are reproducible from these commands and carry no licensing question.

| id           | duration | contents                                                                          |
| --------------| ----------| -----------------------------------------------------------------------------------|
| `mix-7s`     | 6.94 s   | three sine tones (220 / 277 / 330 Hz) at 0.5 gain, mixed with spoken words at 1.0 |
| `chords-20s` | 20.00 s  | the same three tones alone, no voice — the control                                |

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

**A caveat that limits every purity number below.** Pure sine tones and synthesised speech are *out of
distribution* for models trained on recorded music. The ORDERING of these results is the finding; the
absolute percentages are not a quality score. A model that scores poorly here may do better on real music,
and vice versa. Treat the table as a regression baseline, not a leaderboard.

---

## Timing — `m1pro`

`load` is weights load and initialisation, measured separately because it is paid once per process and is
often larger than the inference itself. `inference` excludes it. Both are warm-cache: the checkpoint was
already on disk, so neither includes download.

| model                                   | runtime               | device | input        | load (s)                     | inference (s)       |
| -----------------------------------------| -----------------------| --------| --------------| ------------------------------| ---------------------|
| `htdemucs`                              | demucs CLI            | cpu    | `mix-7s`     | — (in-process, not isolated) | **8.59** wall total |
| `bs-roformer` instrumental-resurrection | bs-roformer-infer CLI | cpu    | `mix-7s`     | —                            | **18.83**           |
| `bs-roformer` instrumental-resurrection | bs-roformer-infer CLI | cpu    | `chords-20s` | —                            | **78.59**           |
| `mel-roformer` kim_vocal_2              | mlx-audio             | Metal  | `mix-7s`     | 23.3                         | **3.8**             |
| `mel-roformer` zfturbo_vocals_v1        | mlx-audio             | Metal  | `mix-7s`     | 5.7                          | **2.3**             |

Notes on individual rows:

- **`htdemucs`** is a subprocess, so load and inference cannot be separated from outside; 8.59 s is total
  wall for the whole `python -m demucs.separate` invocation. The first run additionally downloads weights.
- **`bs-roformer`** first run on `mix-7s` reported 17.50 s of its own elapsed time against 25.46 s total
  wall — the difference is checkpoint download plus interpreter start. The 18.83 s above is a warm run.
- **`chords-20s` on bs-roformer** is the cleanest rate here: 78.59 s for 20.00 s of audio, with no
  short-clip overhead distorting it.
- **The two MLX loads differ by 4x** (23.3 s vs 5.7 s) because kim_vocal_2's first load included the 456 MB
  download. The 5.7 s figure is what a warm load costs.

## Separation quality — `m1pro`, input `mix-7s`

`chord %` is the share of that file's spectral energy within ±6 Hz of 220 / 277 / 330 Hz. For an
**instrumental** stem, higher is better — it means the chords were kept and the voice removed. For a
**vocals** stem, lower is better. `rms` is included because purity alone can be satisfied by a stem that is
simply very quiet.

| model                            | stem                       | chord %   | rms     |
| ----------------------------------| ----------------------------| -----------| ---------|
| —                                | *source mix*               | 6.74      | 0.11859 |
| `mel-roformer` kim_vocal_2       | instrumental               | **99.43** | 0.01798 |
|                                  | vocals                     | 5.02      | 0.11741 |
| `bs-roformer` instr-resurrection | instrumental (`_other`)    | **99.22** | 0.01770 |
|                                  | vocals (`_instrumental`)   | 4.92      | 0.11776 |
| `htdemucs`                       | instrumental (`no_vocals`) | **96.80** | 0.01712 |
|                                  | vocals                     | 4.54      | 0.11708 |
| `mel-roformer` zfturbo_vocals_v1 | instrumental               | **19.36** | 0.04209 |
|                                  | vocals                     | 4.52      | 0.09842 |

### Reading this table

- **kim_vocal_2, bs-roformer and htdemucs are close** — 99.4 / 99.2 / 96.8. On this input they are
  effectively equivalent, and the choice between them is cost, not quality.
- **zfturbo_vocals_v1 is the outlier** at 19.36, with an instrumental rms 2.3x the others (0.042 vs ~0.018).
  Both facts say the same thing: it left a large amount of non-chord energy in the backing track. Its vocals
  stem is also the quietest (0.098 against the source's 0.119), so the residual voice went into the
  instrumental. For karaoke that is the failure that matters — audible vocal bleed in the track that plays.
- **It is also the fastest** (2.3 s against 3.8 s). That is a real trade and the reason it stays registered
  rather than removed.

### The measurement script

```python
import numpy as np, soundfile as sf
CHORD = (220.0, 277.0, 330.0)

def measure(path, width=6.0):
    d, sr = sf.read(path, dtype="float64")
    if d.ndim > 1:
        d = d.mean(axis=1)                      # mono: purity is not a stereo property
    spec = np.abs(np.fft.rfft(d * np.hanning(len(d))))
    freqs = np.fft.rfftfreq(len(d), 1 / sr)
    total = float((spec ** 2).sum())
    band = sum(float((spec[(freqs > t - width) & (freqs < t + width)] ** 2).sum()) for t in CHORD)
    return band / total * 100, float(np.sqrt((d ** 2).mean()))
```

Hann window before the FFT, so the tones do not smear across bins; energy (amplitude squared) rather than
amplitude, so the ratio is a power fraction.

---

## Findings that came out of running these

Recorded because each one was invisible until a real pass happened, and each is now pinned by a test.

1. **bs-roformer's stem filenames are inverted.** `<name>_instrumental.wav` holds the **vocals**;
   `<name>_other.wav` holds the backing track. Established with `chords-20s`, where the input has no voice
   at all: `_other` came back at rms 0.03574 against the source's 0.03608 (99.1%), while `_instrumental` was
   0.00086 (2.4%). Both this worker and the old one previously looked for a
   `<name>_(Instrumental)_<slug>.<ext>` pattern that this package version never writes — so discovery found
   nothing, which was the *safe* failure. Had it matched, the vocals would have been published as the
   karaoke master, and the silence probe would have passed it because the vocals stem is loud.
2. **bs-roformer writes float32 WAV.** Python's stdlib `wave` refuses it outright (`unknown format: 3`), so
   routing by file extension made every roformer stem unreadable — no `songProfile` (key and vocal range
   silently null) and no guide-mix length check. The reader now probes rather than infers.
3. **`htdemucs` at 0.29x was not a measurement.** That figure came from core's contract, which is a GPU
   number, and had been recorded in this worker's registry as `provenance="measured"`. On CPU here the same
   clip takes 8.59 s for 6.94 s of audio. Corrected to 1.24x with the machine stated.
4. **A single-stem model removes a whole class of bug.** The MLX checkpoints emit vocals only, and the
   instrumental is computed as `mixture - vocals`. The two stems are therefore sample-aligned by
   construction: no second file whose start could differ, no length mismatch for the guide mix to refuse,
   and no filename whose role could be inverted — because this worker names them.

## Not yet measured

Listed so the gaps are visible rather than assumed closed.

- `htdemucs_ft`, `htdemucs_6s` — allowlisted, never run.
- Any CUDA, ROCm or Intel figure. Every number here is `m1pro`; nothing in this document says what a GPU box
  does.
- `audiosep` (169-model UVR zoo) and any ensemble — no runtime adapter yet.
- Real recorded music. Every input here is synthesised, which is the caveat stated above and the single
  biggest limitation of this document.
