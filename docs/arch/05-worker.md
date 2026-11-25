# The worker, outside alignment

> **Purpose.** The design of everything the Python worker does that is not lyrics timing: separation and
> the stem roles, the audio profile, artifact publication, provider access, the transport and its
> ownership ledger, durability, and configuration. Lyrics timing is
> [`04-alignment.md`](04-alignment.md). The separator measurements — throughput, SDR, purity — are in
> [`../benchmarks/stem-separation/README.md`](../benchmarks/stem-separation/README.md); nothing here
> repeats a number that lives there.
>
> Code: `worker/encore_worker/`. The operator-facing tour is
> [`../../worker/README.md`](../../worker/README.md).

## 1. Layers, and what each may import

```
protocol/    frames on the wire, as frozen dataclasses
transport/   the socket, the ownership ledger          ─┐
host/        config, hardware probe, ffmpeg resolution  │ the shell: env, sockets, subprocesses
adapters/    every heavy seam behind a Protocol        ─┘
steps/       the step surface, one Protocol + records
workflows/   the DBOS layer — decisions only, no I/O
domain/      pure functions: audio analysis, lyrics logic
artifacts/   store keys and the local filesystem store
```

Two rules a guard test enforces (`tests/test_layers.py`): **`domain/` is pure** — no torch, scipy, numba
or adapter imports, and numpy only under `domain/audio/` — and **`steps/` depends on `adapters/ports.py`
and never on a concrete adapter**. A step that imported a workflow would invert the dependency direction;
the layer test caught exactly that, which is why `domain/identity.py` is in `domain/` rather than beside
the fetch flow.

**Every heavy seam is a Protocol, not a base class.** A step takes the port it needs as an argument, so a
test hands in a fake and the whole align path runs with no torch, no WhisperX, no network and no yt-dlp —
which is why the dev install is twelve packages instead of several gigabytes. Structural typing
specifically: a fake in a test file imports nothing from the ports module, it just has the right methods.

**Every port returns plain data.** A DBOS step checkpoints its return value, so a port that handed back a
tensor, an open file or a model handle would make the step unserializable. Ports return paths, refs and
records; bytes stay on disk.

### 1.1 The align step is seven modules, not one

`steps/align_steps.py` reached **3 696 lines**, the longest module in the repo. Splitting it was an API
break, because ~14 module-level privates were imported BY NAME from 4 test modules and 6 bench scripts, so it
was split as a **pure move** with those imports re-pointed: `align_steps.py` keeps `Adapters`,
`Reporter`, `AlignStepsImpl` and `now_ms` (**2 530** lines, the engines and the repair ladder still inside
`_time_text_global`), and the module-level helpers went to six siblings by what they are —

| module | what it owns |
| ------ | ------------ |
| `align_text.py` | what a provider's payload is timed TO, and the pinned re-time (`superseded_candidates`) |
| `align_lines.py` | the LINE_SYNC lane: the two document shapes, the envelope gates, the agreement read, the claim clock's near-band, the claim-ordered sheet, the lexical lift |
| `align_unsung.py` | the never-sung rule's three thresholds, the spare arm's speech-mass read, and the skip-arc arm's trellis read |
| `align_claims.py` | the claim window's constants, claims as served, and the placement-ambiguity read |
| `align_notes.py` | every sentence the audit trail prints |
| `align_geometry.py` | the repair clamp's interval arithmetic |

**The proof it was a pure move.** All **80** top-level definitions are AST-identical modulo docstrings
(two docstrings lost a narrative paragraph each, both now in [`04-alignment.md`](04-alignment.md) §5.3 and
§7); 78 of the 80 are identical including their docstrings. End to end, a `run_align` smoke on two songs
(`--songs hello,Avercage --modes truth`) republished both documents and both onset series digest-identical
to the run before the split — `hello` `4851b178858ce19f` / `75391ffb463bfe9d`, `Avercage_-_Embers`
`005ddbf71545685a` / `1171b22563741216`; the run is in
[`../benchmarks/forced-alignment/LOG.md`](../benchmarks/forced-alignment/LOG.md), "W10: the step split, and
the byte-identity smoke that proves it".

**Three names stay patched on `align_steps`, not on their owner.** `_NEVER_SUNG_RATE`, `_clamped` and
`_skipped_lines` are read by `AlignStepsImpl` out of its OWN module globals, so
`monkeypatch.setattr(align_steps, …)` is the only patch the step can see. `tests/test_align_modules.py`
holds that: it scans the test tree for patch targets and fails if one of them is ALSO read inside a
sibling, where the spy would never be called. It also holds the module set, that no sibling imports the
step back, and that `align_steps.py` stays under 2 600 lines.

## 2. Separation

### 2.1 A registry, not an "any Hugging Face model" adapter

Hugging Face is a file **host**, not a runtime, so "load any HF model" has nothing to dispatch on. Three
real examples from one search of the hub make the point: a `*-mlx` conversion with the same
`audio-to-audio` tag but no `config.json` and a differently named safetensors (a completely different
loader); a Mel-Band RoFormer conversion with matching geometry but **no** `checkpoint_family` field, so
nothing in the file says which architecture preset to load it with; and promptable-segmentation and
speech/music/SFX models under the same tag that are not vocal separation at all.

Four things actually vary, and a registry row names each:

| field | what it answers |
| ----- | --------------- |
| architecture | what network (`mdx`, `vr`, `demucs`, `mdxc`, `melband`) |
| runtime | what executes it (`torch`, `onnx`, `mlx`) — and in which process |
| weights | where the bytes live (a package's own zoo, an HF repo, a URL) |
| stems | which output is which — **measured, never inferred** |

The same architecture appears in several runtimes and the same weights get converted between them, so HF
is one value of one field and not a special case. **Adding a model is a row; adding a runtime is an
adapter** — that is the whole point of the split.

Two refusals that look like gaps and are not:

* **No minimum-memory gate.** A memory ceiling is a continuum, not a yes/no: it moves with segment size,
  overlap and precision, so a gate would refuse configurations that in fact work. Anyone may pick
  anything; what makes that safe is that an out-of-memory failure is classified **non-retryable** with a
  message naming the remedy, so a bad choice costs one legible failure instead of three silent ones.
* **Capability is the gate, not hardware vendor.** Either the runtime is installed on this box or it is
  not — binary and provable. An Apple Silicon box without `mlx-audio` cannot run an MLX model, so
  "select Apple" would offer work the box must reject.

**Every throughput and purity figure in a registry row has a matching row in the stem-separation
README**, with the machine, the input and the command. A number in the registry without one is a number
nobody measured — which happened once: a model carried a cost labelled "measured" that had been copied
from core's GPU contract, and on CPU it is four times worse. A row whose realtime factor is unknown says
`unmeasured` in its provenance rather than carrying a number that reads as authoritative: an **estimated**
cost presented like a measured one is worse than no number at all. Two of the three rows' figures were then
corrected a second time, because a figure measured on a short **clip** is not a conservative estimate of
long-input cost but a different measurement — per-call overhead dominates it (README, "Results — `m1pro`,
`tfr-flyaway`"). The one clip figure that survived re-measurement is the Metal one, whose per-call overhead is
small enough that a 7 s clip and a 194 s song give the same rate.

**A process boundary is a dependency fact, not a style choice, and it is a cost.** `audio-separator`'s torch
floor is above this worker's pin, so it gets its own environment and is shelled out to — but an extra venv, a
serialisation boundary and a capability probe that must run an interpreter rather than ask an import all have
to be paid, so in-process is preferred and this is reached for only where a version bound genuinely forbids it.
The MLX runtime is the case where in-process was **earned**: on whisperx 3.8.6 it was impossible (that release
requires `huggingface-hub<1.0.0` while `mlx-audio` requires `>=1.0`, so the two were unsatisfiable and it ran
in a sidecar virtualenv behind a subprocess), and pinning whisperx 3.8.7rc1 dropped the ceiling and the sidecar
with it.

**A single-stem model removes a whole class of bug.** Where the engine emits only vocals and the instrumental
is `mixture − vocals`, the two are sample-aligned **by construction**: there is no second file whose start
could differ, no length mismatch for the guide mix to refuse, and no filename whose role could be inverted,
because this worker names them. The one hard refusal in the registry is the other side of the same coin — a row
whose stem semantics are **unmeasured** may not be dispatched. Memory, speed and quality are the operator's
call; which file is the backing track is not a matter of preference. Unmeasured rows are still listed, so they
are visible and refused rather than absent and forgotten, and a row's **token** is a stable id rather than a
checkpoint filename, which changes when a model is re-released.

### 2.2 The stem roles are measured from the audio, never from a filename

Publishing the vocals as the karaoke master is the worst failure this worker has, and it is **silent**:
the silence probe passes it (the vocals stem is loud), the guide mix builds (both files are the right
length), and the first person to find out is someone standing in a room singing along to their own voice.

The old defence was a hand-filled table, which works for three models and cannot work for a hundred and
sixty-nine. So the role is measured at job time, from the **fraction of spectral energy below 250 Hz**: a
backing track carries the kick drum and the bass line, while an isolated vocal has almost nothing down
there, because even a bass singer's fundamental sits around 80–100 Hz and carries little of the voice's
total energy. (The table, the margins and the honest limitation are in
[`../benchmarks/stem-separation/README.md`](../benchmarks/stem-separation/README.md), "Stem roles,
measured from the audio".)

**Activity was measured as the alternative and rejected** — vocals are intermittent and backing tracks
continuous, but the measured gap is a 1.2× margin against the bass fraction's order of magnitude. A real
signal, far too weak to bet on, and not used.

The measurement independently reproduced an inverted filename pair in one upstream package that had
originally taken a synthetic control to find. A declaration, where one exists, is a **hint** used only to
cross-check; an unmeasured registry entry declares nothing and discovery refuses rather than guessing.
That is the safe failure: the dangerous one is a filename pattern that matches and publishes the vocals.

### 2.3 The zoo, and whose numbers are whose

The catalogue is read from `audio-separator`'s own metadata rather than described here, so an entry costs
nothing to add and cannot drift from what the library can actually run. Two disciplines:

* **The scores are upstream's, never ours.** Every figure crossing out of that module is labelled
  `upstream`: it is a real benchmark run by someone else, on tracks we did not choose, with a metric
  (BSS-eval SDR via `museval`) that is not the plain SDR this repo reports. Useful for ranking a hundred
  unknowns; not comparable to our own numbers, and not evidence about this hardware.
* **What is filtered out is not tidiness.** The zoo is not a list of vocal separators — it also holds
  de-reverb, de-noise, de-echo, drum separation, crowd removal and lead-versus-backing karaoke models.
  Asking a de-reverb model for a karaoke master gets you a slightly drier copy of the whole song,
  published as an instrumental, with nothing downstream able to notice. So an entry is offered only if its
  declared stems hold a vocals side and a non-vocals side that the role measurement can then verify.

The zoo adapter does three things the hand-registered adapters do not, each because a zoo model is an
unknown quantity: **it names the stems itself** from the measurement above (62 of the 169 catalogue entries
declare no stem names at all, and the ones that do cannot simply be believed — the inverted filename pair
in §2.2 is one of them, so a declaration is a cross-check and the backing track is whichever file carries
the low-frequency energy); **it refuses rather than guesses** (a model that emits one file, or five, or two the measurement cannot separate, fails the job
non-retryably with a legible reason — retrying would re-run a multi-minute inference to reach the same
verdict); and **it heartbeats from a thread**, because the library's separate call is a blocking
in-process call with no progress callback, and a quiet step of several minutes is exactly what the core's
reaper treats as a dead worker. That ticker is a liveness signal, not a completion estimate, and says so.

**Building the catalogue is off the handshake's critical path.** It is synchronous, CPU- and network-bound,
and measured at **4.80 s** on this project's Mac — so blocking the hello frame on it would delay registration
by five seconds, and a box whose network is slow would look dead before it had registered at all. It runs in
a thread and the catalogue is announced when it is ready. Each runnable model is advertised as **its own
capability token**, which makes model-aware routing free: core's dispatch matches one capability string
against a worker's list, so a job naming a checkpoint only one box has is routed to that box by machinery that
already exists.

**The suite's own probe of that listing is cached for the same reason the catalogue is.**
`tests/zoo_fixture.upstream_listing_is_readable` constructs a `Separator` to tell "upstream's listing cannot
be read on this box" apart from "the filter rejected every entry", and `catalogue_or_skip` asks it at each of
the suite's eight call-through sites where the catalogue comes back empty. Measured on this project's Mac
with the socket open and `/tmp` cold, the first probe took **901.7 s** — it fetches upstream's model metadata
— against **0.0 s** for the second, so the answer is a `functools.cache`d per-process environment fact rather
than a question asked eight times (`tests/test_zoo.py` pins the one construction).

A catalogue entry therefore falls into one of **three** role cases, and the middle one is why the role
measurement exists at all. **Declared** — the metadata names a vocals side and a backing side, still verified
from the audio before publication, a declaration being a hint. **Unknown** — the metadata declares no stems,
true of 62 of the 169 entries and including real vocal separators; these used to be dropped and are now
offered, because runtime role detection does not need the declaration, and if the measurement cannot decide the
job is refused. **Not a separator** — the metadata declares stems that are not a vocals/backing pair, so no
amount of running it yields a karaoke master. The four-source demucs decomposition is excluded from this path
deliberately even though its instrumental could be summed: `htdemucs_ft` and `htdemucs_6s` are reachable
through the native demucs adapter, and two routes to one set of weights is a way for two answers to disagree,
not a feature.

### 2.4 The one real decision in the stems flow

The stems flow is deliberately linear — decode, separate, check, publish. Separation has no fallback
ladder and no parameter worth retrying: an engine either produces stems or it does not, and a second pass
with a different setting produces a different-sounding backing track rather than a better-timed one. The
flow runs as a DBOS workflow whose acquire, decode, separate and publish are recorded steps, so a requeue
after a finished separation resumes at publish rather than separating again (§8.1).

The one real decision is the **silence probe**. A separator that emits a digitally silent instrumental has
"succeeded" by every other measure — the files exist, the exit code was zero — and the room hears nothing.
Refusing is the only way that failure becomes visible.

Its two refusals are **separate exceptions with opposite retry answers**, because "this is silent" and
"nobody knows whether this is silent" are different diagnoses leading to different fixes — the first is a
separation problem, the second a broken ffmpeg or an unreadable output file. Silence is **not** retryable: the
same input through the same engine produces the same silence, so three attempts only delay the operator
finding out, and a different engine is a different job. An unverifiable instrumental **is** retryable: a
measurement failure can be transient (a truncated write, a full disk, an ffmpeg killed by the OOM reaper) and
the work is already done, so a retry that only re-measures is cheap.

**The separator is built per job, from the job's own `engine` AND `model`.** A `stems-upgrade` job names the
engine it wants; honouring the startup backend instead would separate with demucs and publish that as the
upgrade, with nothing downstream able to contradict it. `model` is half of that pair and its absence was a
real port regression: core has always sent it (`settings.upgradeModel` on the assign frame) and the previous
worker honoured it in every engine, while this one read `engine` only — so the resolvers always saw `None` and
returned their defaults, and an operator changing the upgrade model got no effect and no error. That is
exactly the failure those resolvers raise `UnknownModel` to prevent, reached from the one direction they could
not see.

### 2.5 Encoding: every constant was paid for

| choice | why |
| ------ | --- |
| **FLAC, not AAC** | the reason is **sync**, not fidelity: an AAC-in-m4a encoder adds priming samples, so the instrumental and the vocals would decode to starts a few milliseconds apart. Two stems that must stay sample-aligned cannot go through a codec that shifts one of them |
| `s16` sample format | transparent here, because the signal originated as a lossy 48 kHz stream, and it halves the bytes of `s32` |
| compression level 8 | the size/CPU knee, and cheap to **decode**, which is what matters for a browser starting playback in a room |
| `-f` always declared | ffmpeg infers its muxer from the output filename's extension, and these write to a temp sibling whose suffix maps to no container. Without it ffmpeg aborts before encoding a frame — and the failure was every room silently falling back to a two-element guide |
| channel order is the contract | the TV's splitter splits by channel **index**, so instrumental-front / vocals-back is what it relies on. Spelled out rather than left to a default, because the failure is inaudible in review and unmistakable in a room: vocals arriving at the instrumental's gain |

The argv builders are **pure** and separately tested — a recipe this load-bearing should be assertable
without spawning anything, and a flag whose absence only shows up on a real 45-minute separation should be
assertable in a millisecond.

## 3. The audio profile

Three pure-numpy analyses, each on the stem that can actually answer its question:

| analysis | stem | why that one |
| -------- | ---- | ------------ |
| **musical key** (Krumhansl–Schmuckler) | **instrumental** | a lead vocal is monophonic — at any instant it names one pitch class, so its chromagram is dominated by whatever note is being sung and the tonal-hierarchy correlation collapses to "which note appears most". The backing track carries the chords the key lives in |
| **integrated loudness** (EBU R128 / ITU-R BS.1770-4) | **instrumental** | it is what plays in the room and what a room-wide normalisation must equalise. Core's own reading is a crude peak/mean dBFS number over the **vocals** stem |
| **vocal range** | **vocals** | it describes where the original singer sang, which is what a later "shift the key into my range" feature needs |

Two shapes that matter more than the algorithms:

* **Tri-state, never a fabricated default.** A value that cannot be trusted is `None` — a stem too short
  for the gating block, digital silence, any reader error. `None` is a real answer ("we could not measure
  this song's level") and the caller stores it as null, never as 0 LUFS, which would read as a deafeningly
  loud track and attenuate it into inaudibility.
* **The profile is always published.** Core's process gate treats a present profile as "the analysis step
  ran" and an absent one as "still processing", so a stems job must publish a profile on every success
  even with all inner fields null — otherwise a song whose vocals stem is digital silence is permanently
  unsingable **and** never re-processed, because core waits forever for a step it thinks already ran. Both
  analyses are wrapped best-effort and fail independently to nulls; a profile failure must never fail the
  job.

The vocal range answers two questions the phone UI keeps separate: the **absolute** extremes
(`lowMidi`/`highMidi`, the single lowest and highest voiced notes — useful for "can I even reach this song",
and by definition driven by one held note or one grace note, so a poor summary of the tessitura on its own)
and where the song **lives** (`p05Midi`/`p95Midi`, the 5th and 95th percentiles of voiced pitch — trimming
the extreme 5% at each end is what turns "one screamed high note" into "the range you sing for four
minutes", which is the number a singer actually decides on).

Its pitch tracker lives in that module rather than in a shared one, and is deliberately simple: a per-frame
normalised autocorrelation with a clarity gate, plus hz→MIDI. The vocals stem is already isolated
(monophonic-ish) and all that is needed is per-frame pitch to bucket into semitones, not a
transcription-grade tracker. All three modules are **numpy and stdlib only** — no torch, no soundfile, no
librosa: the key chromagram is a plain rfft with a log-frequency→pitch-class bin map, and the stem is a plain
PCM WAV in scratch at this point, before it is encoded.

These three modules are **ported verbatim** from the worker this replaced — algorithm, constants and
comments unchanged on purpose — because they are measured numeric behaviours, so a rewrite would risk
changing what the library records while looking like a refactor. The raw-stem reader accepts WAV or FLAC,
whichever the separator declared; WAV stays on the stdlib so the module is importable on a box carrying
nothing but numpy, which is exactly what the unit suite runs on.

### 3.1 The constants that are data, not tunables

**Key.** Krumhansl & Kessler's (1982) probe-tone profiles are the perceived tonal hierarchy of each scale
degree — **experimental data**, not a tunable, and the one table in this package nobody may "clean up". The
24 templates are those two profiles rotated by tonic, precomputed once so scoring is a single matrix
correlation rather than 24 Python-loop ones. The chromagram folds every rfft bin whose centre frequency lies
between **MIDI 24 (C1, ≈32.7 Hz) and MIDI 108 (C8)** into the pitch class it rounds to; the low bound is
deliberately _below_ the rfft's resolution limit at this frame size, because bass fundamentals (≈31–65 Hz)
carry real chordal energy and are kept in on purpose rather than filtered out as rumble. Magnitudes are
summed across frames and the 12-vector L1-normalised at the end, so a long steady chord and a short one
contribute in proportion to how long they sound; a clip shorter than one frame is zero-padded to one, so a
synthesised test tone still produces a chromagram.

Scoring is **Pearson against each template** rather than a dot product, which is what makes `confidence`
comparable across songs: a dot product rewards a template merely for carrying large numbers, while a
mean-centred, magnitude-normalised correlation scores a flat or atonal chroma near **zero against all 24
keys** — and that near-zero maximum is exactly what gets published. A negative correlation means "less like
this key than average", so the published confidence is floored at 0 rather than stored as a small negative
number. ~0.8+ is a confident tonal read.

**Loudness.** Two guards stand in front of `pyloudnorm`, because BS.1770 has no answer for either case and
`None` is the honest one. A signal shorter than one **400 ms gating block** cannot be gated at all (the meter
raises). And digital silence on this box sits at the **16-bit floor**, so a stem whose peak sample is at or
below one LSB (`1/32768`) carries no measurable programme level — the meter would either gate every block out
or report an absurd −70-something LUFS. A gated measurement over near-silence can also return `-inf` or
`nan`, which is unmeasurable rather than a level, so only a finite number is accepted. Typical mastered music
lands between −8 and −20 LUFS.

The meter takes **samples a caller has already decoded**, which exists so the profile builder can decode the
instrumental once and hand the same array to both key detection and the meter. It used to call the path form,
which re-opened and re-decoded the very file the key path had just read: two full decodes of a multi-minute
stem inside one function, for two measurements over identical samples. The decode and the two measurements
stay in **separate** best-effort blocks for the same reason the halves do — a decode failure costs both
numbers, but an unreadable chromagram must not throw away a good level.

**Vocal range.** The f0 search is clamped to **65–1100 Hz**: below that is almost always separation artefact,
above it the stem is breath and consonant noise, and the clamp doubles as the bound on the autocorrelation lag
search, which is what keeps this cheap. A frame counts as voiced only when its **clarity ≥ 0.5** and its f0
lands in that band — clarity being the autocorrelation peak divided by the zero-lag value, so it measures
periodicity and **not loudness** (a quiet vowel and a loud vowel of the same pitch score the same), which is
what lets the voiced/unvoiced knife be a fixed constant at all. Sung vowels score ≈0.9+ where breath,
sibilants and separation bleed do not. The peak lag is parabolically interpolated for sub-sample resolution,
or a 220 Hz tone would quantise into a neighbouring semitone.

That autocorrelation is computed by **rfft and not `np.correlate(mode="full")`, which is 17× slower for
bit-identical output**, zero-padded to a power of two ≥ 2n−1 so the FFT's circular correlation cannot wrap
lag _k_ onto the frame's far end. The histogram is **seconds per semitone** with index 0 at
`round(lowMidi)`, and its seconds axis is `(voiced frames) × hop / sample_rate` — so the frame hop is a
single named constant shared by the tracker's default and the summary's seconds-per-frame, a disagreement
between them scaling every published duration wrong with no other field moving.

**Reading the raw stem.** Whether stdlib `wave` can open a file is **probed, never inferred from the
extension**: bs-roformer writes float32 WAV (`WAVE_FORMAT_IEEE_FLOAT`, tag 3), which stdlib `wave` refuses
outright with `unknown format: 3`, and before the probe every roformer stem failed both the reader and the
frame-length check — so a roformer job published with **no songProfile at all** (key and vocal range silently
null) and no guide-mix length check. `soundfile` handles everything else and is asked for float64 directly,
so per-width integer normalisation is the library's problem rather than a table here; 8-bit WAV's unsigned
centre-128 encoding is the one PCM width the stdlib path has to special-case.

The frame-length probe exists for **one** caller: the guide mix must know whether its two source stems are
the same length before folding them together, because ffmpeg's `join` **truncates to the shorter input and
exits 0** — measured, a 3 s instrumental against a 1 s vocals stem yields a 1 s output — and since the mix is
what the TV plays as master it owns `duration`, so a short one cuts the song off with nothing in any log. It
also silently resamples a rate mismatch, hence the rate. It reads the header only, so it is cheap enough to
run unconditionally, and answers `None` rather than raising: an unreadable header is a reason to skip the mix,
not to fail a job whose instrumental is fine.

## 4. Artifacts: keys, the store, and scratch

**Store keys are a byte-for-byte mirror of core's path module**, not a derivation, because the key is the
contract between two processes in two languages and a disagreement is **silent**: the worker writes a real
file, core records a real row, and the player 404s. Nothing at runtime can catch that, so a test parses
core's TypeScript and asserts the Python agrees. The module is pure — every function is a string template
— and extensions are **parameters** even where defaults exist, because core announces the format it wants
at handshake and a row processed under an earlier setting keeps its own extension forever.

**The worker must not invent keys.** A ref is derived from the media's identity and then bytes are placed
at it. The reverse — publish wherever the separator wrote, then describe it — is what put refs into job
scratch, which core evicts.

Four shapes in that module are decisions rather than templates:

* **Enumeration, for the one class that cannot be recomputed.** Nothing records a retained original's real
  name, so a consumer of `audio/` must try every known extension: a superset costs nothing and one too few
  permanently orphans the asset. The same is true of a stem, whose on-disk extension is whichever publish
  format was live **when it was processed** — so a cleanup or an existence check that assumes one extension
  silently misses older files. `wav` is in the audio list as a legacy mislabelled name still holding real
  m4a/webm bytes.
* **A candidate ref is opaque to core**, so its shape is the worker's to choose — and it is centralised
  anyway, because the retention sweep must be able to enumerate what a media owns and a key invented at its
  call site cannot be. The colon of an `asr:vocals`-shaped label is replaced, not being safe in every
  object-store key or on every filesystem.
* **The pasted-lyrics key is a literal both sides pin.** Core mints it when a person pastes lyrics, makes it
  the media's override and sends it as the align job's pinned ref; the worker writes the re-timed paste under
  exactly that key, so core's merge **overwrites** the pinned candidate instead of adding a rival. It is the
  (manual, word) candidate key by construction.
* **The caption kind is a directory segment because yt-dlp names both tracks identically**, so only the
  segment distinguishes an uploader's track from a machine baseline. Neither is stored on the media row —
  they are evidence for diagnosing the parser, not candidates — so retention enumerates the matrix.

The guide mix is **both stems in one 4-channel file** (0/1 instrumental, 2/3 vocals) rather than two files,
which makes drift unrepresentable rather than merely governed: there is no second file that could start at a
different sample. It is named `-guidemix` and not `-mix` because nothing in it is summed. The default publish
format is lossless for a reason that is about **sync** rather than quality — a lossy container with encoder
pre-roll (AAC-in-m4a priming samples) shifts the vocals relative to the instrumental, and the two must stay
sample-aligned.

The local store does three things more than a move, each of which was a real bug somewhere:

1. **Per-class roots**, each independently overridable (`ENCORE_AUDIO_DIR`, `ENCORE_DERIVED_DIR`,
   `ENCORE_META_DIR`), so classes can sit on different disks — back up `audio/`, put the recomputable
   `derived/` on cheap storage. A class directory may point **outside** the media root, so a key cannot
   simply be joined onto that root — core resolves the base the same way, and a worker that skips it writes
   where core will never look. The class is the key's first segment and the root already encodes it, so that
   segment is stripped rather than joined twice, and `work` is deliberately **not** overridable: scratch sits
   next to the work.
2. **Atomic publication.** Core serves byte ranges off these keys while we write, and `os.replace` is
   atomic only within a filesystem — so the temp file is created in the **destination** directory, because
   a cross-device rename silently degrades to copy-then-unlink. Bytes get there by `move` and not `copy`
   (the source is scratch we are done with, and tens of megabytes), and a failed move leaves a
   `.publishing-*` file that is unlinked rather than left to accumulate in a real media directory.
3. **Refusing to escape the root.** A key is data that arrived over a socket; a store that writes
   `derived/../../etc/passwd` is an arbitrary-write primitive. The containment test is `commonpath` and not
   `startswith`, which `/media/derived-evil` satisfies against `/media/derived`.

The seam is a **Protocol with two methods**, because core runs one of two media-store backends and announces
which at handshake: both are keyed by the same ref, so the only thing that differs is how bytes get there, and
an object backend is then an added file rather than a change to every publish site. `put` must be atomic **as
observed by a reader** — a half-written FLAC is a corrupt stream rather than a missing one, which the player
reports as a decode failure with nothing pointing back here — and it takes a path rather than bytes, which it
consumes. `exists` is for idempotency and never for correctness: a `False` is not proof that publishing is
safe, since ownership answers that. Reading bytes back is core's job; the worker never serves media. A store
error is **retryable by default**, which is the honest default for storage — a full disk, a permission problem
or an S3 5xx are all worth another attempt, and a malformed key is a programming error a retry surfaces
identically rather than hides.

**Scratch has two reclaim mechanisms, because neither alone is sufficient.** Every job decodes its source
to WAV and every separation writes raw stems beside it — hundreds of megabytes a song — and nothing used
to delete any of it, so a library import filled the media volume and the failure arrived as "no space left
on device" in an unrelated job.

Deleting at the end of every run is the obvious design and it silently breaks resumption: every
checkpointed step returns **paths into scratch**, never bytes, so a requeued job resumes from a checkpoint
and is handed a path whose file is gone — and it is the expensive case, a 45-minute separation whose
output no longer exists. Durability made this stricter rather than looser: the old worker preserved
scratch in case a retry re-ran from the top; this one needs it because a retry deliberately does **not**
re-run.

| outcome | scratch |
| ------- | ------- |
| published | release — the artifacts are in the store, nothing will resume |
| non-retryable failure | release — no retry is coming, by definition |
| retryable failure | **keep** — a requeue resumes from a checkpoint holding these paths |
| lost lease | **keep** — the job may come back to this worker under the same workflow id |
| crash mid-job | nothing runs to decide; the periodic sweep is the only thing that ever reclaims it |

The sweep is still needed for two leaks the run-end hook cannot reach: a crash leaves no code to run the
hook, and retries **exhausting** is terminal but the worker cannot see that it was the last attempt —
there is no attempt count on the wire. It is safe on a shared volume because it only removes a directory
whose **newest** file is older than a threshold: a live job writes continuously, so its scratch is always
fresher, even under a different worker sharing the volume — which is what makes an age check the right
test rather than a registry of "my" job ids.

## 5. ffmpeg: which one, and why that is a decision

The worker shells ffmpeg on every path — the fetcher postprocesses with it, the input is normalised with
it, the FLAC and guide-mix encoders are it, and the silence probe reads levels with it. So "is ffmpeg
present" gates the `stems` capability outright, and an absent or ancient one is a class of failure that
only shows up per codec, at job time.

Resolution order, and each step earns its place:

1. **`ENCORE_FFMPEG_BIN`** — an explicit operator choice. Always wins: someone who built ffmpeg with NVENC,
   VideoToolbox or a patched libopus has a reason, and no heuristic should second-guess it.
2. **the bundled binary** — `imageio-ffmpeg`'s static FFmpeg, shipped per platform in the wheel (7.0.2 on
   Linux, both x86_64 and aarch64; 7.1 on macOS arm64; Windows and macOS x86_64 unverified).
   Pinned, so the FLAC this worker publishes is reproducible on a machine that has no ffmpeg at all and on
   one whose distro ships 4.4.
3. **`ffmpeg` on PATH** — the last resort, for platforms with no wheel (musl/Alpine, BSD, ppc64le).

**Bundled beats PATH deliberately**, and it is the one choice here that could go either way. The argument
for PATH-first is that an operator's own build is probably better; the argument that wins is
reproducibility — two workers in a pool must not encode stems with different ffmpeg majors, and the
attempt ledger records no ffmpeg version to explain it if they do. An operator who wants their own build
says so with one variable, which is explicit and logged.

**This does not cost hardware acceleration.** The question is fair — a static build has no NVENC, no
VideoToolbox, no QSV — but this worker decodes and encodes **audio only**: PCM, FLAC, AAC, Opus, Vorbis,
every one of them CPU-only in every ffmpeg build there is. The acceleration that matters here is torch's,
in a different dependency chain entirely.

**What it does not fix: `torchcodec`.** pyannote 4.0 pulls it, and it `dlopen`s ffmpeg **shared libraries**
(`libavutil.<major>.dylib` and friends) rather than running a binary — verified against torchcodec 0.7.0
through 0.16.0, none of which bundle them. A static binary cannot satisfy that, so the answer is to not need
it: `ml.PyannoteDiarizer` hands pyannote a preloaded waveform, which bypasses its decoder.

## 6. Providers

| provider | role |
| -------- | ---- |
| **LRCmux** | the primary: a multiplexer that fans one lookup across many sources, and the only one that can return **word-level** timings |
| **LRCLIB** | the second opinion, and self-hostable |
| the upload's **authored** caption track | a human typed it, for this exact recording |
| the upload's **automatic** caption track | ASR wearing a caption's clothes |
| **MusicBrainz** | annotation only, never lyrics |

**Every provider is a candidate.** The chain used to return the first hit, and the multiplexer is first,
so the second provider was consulted only when the first was **unreachable** — never when it merely
answered badly. A multiplexer's answer is one upstream's sheet picked by somebody else's ranking; the
other provider's is a different sheet, and the two disagreeing is the most useful signal the text side
has. The cost of asking both is one HTTP request on a song already answered, against a wrong sheet
published for good. The **same** sheet twice is one candidate, deduplicated on the normalised words so a
punctuation difference does not read as a second opinion. A provider that raises does not stop the chain —
one being unreachable is exactly when the next matters most.

**Empty and raising mean different things,** and that distinction is why none of these is a bare
`try/except: return ()`. Empty is "this provider does not have this song" — an ordinary miss for an
obscure track. Raising is "this provider could not be reached", which must be visible: a provider once
failed for a month and it was indistinguishable from a library of instrumentals, because both produced no
text.

**Units convert at the boundary, once.** The multiplexer's native response is integer milliseconds
throughout and everything downstream is seconds. Getting it wrong would not fail — it would publish lyrics
running a thousand times fast, which looks like a bug in the player.

**Status codes are measured against the live API, not read off the spec**, which declares only `200` and a
default: a miss, our own malformed request (never retried — retrying sends the same malformed request
twice), and provider trouble (retryable) are three different answers.

**A duration is sent when known and the lookup is retried without it on a miss.** A provider uses the
duration to disambiguate a single edit from an album version, which is exactly the "right song, wrong
master" case that produces confidently misplaced lyrics. But the duration this worker measures is the
**upload's**, not the recording's: a music video with an intro, an outro or a spoken skit is minutes
longer than the track, so the qualified lookup misses and the song falls through to ASR with a perfectly
good human sheet one request away. The trade is deliberate and asymmetric — an unqualified lookup may
answer with another cut's sheet, whose line timings are then wrong, and wrong line timings are a hazard
three shipped gates already read, where a miss is no text at all, which no gate can recover. One retry,
and only on a miss.

**No third-party HTTP client.** `urllib` is in the stdlib and these are single GETs with query
parameters; adding another dependency to a worker whose other dependencies are multi-gigabyte ML wheels
buys nothing. **But each client builds its own opener**, and that is not ceremony: the module-level opener
is cached on first use and **omits the proxy handler entirely** when no proxy variable is set at that
moment — measured, not assumed. In a resident worker that means a proxy configured after the first request
is silently ignored for the life of the process.

**One outbound rate gate, per service.** Jobs arrive in bursts — a library import queues dozens at once —
and with concurrency above one, two reach a provider in the same instant. The budget is per **source IP**,
a property of the process rather than of a client object, and on a small free service a burst reads as
abuse. It is **serialised, not a best-effort interval check**: an unlocked "has enough time passed?" lets
two callers read the same timestamp, both decide yes, and both fire. The lock is held across the request
as well as the wait, because releasing before the call would put two requests in flight at once; retries
happen inside it too, so a throttled box does not pile every queued caller onto the request already being
refused. One instance per service, because the budgets are independent and sharing one would halve both.
`threading`, not `asyncio`, because every provider call runs in a thread and an async lock would exclude
nothing.

**MusicBrainz declines, never fails.** An annotation is an improvement on a title parse, so every ordinary
failure leaves the parse standing — but the **reason** travels with the decline, because "nothing agreed
on the names" and "this IP is being refused" are otherwise the same observable event, and an operator needs
to tell a throttled box from a healthy per-song miss. And name agreement is **required rather than
scored**: the service's own score is lexical and will happily return a different song by the same artist
with a high score. Length is the corroborating evidence a lexical score cannot provide.

Why identification matters disproportionately: the artist and track a fetch job produces are what a later
align job hands to the lyrics provider, so a wrong identification produces a confident lookup of the
**wrong song**, whose text then aligns badly and costs several retries to reject. The bias is therefore
toward admitting ignorance — `confident` requires both fields, and the title parser refuses to guess —
and the fetch flow is deliberately linear, because a failure there is a failure to identify and the honest
answer is "unidentified", not a second guess.

### 6.1 The caption parser, and YouTube's rolling tracks

**One parser for WebVTT and SRT**, because they differ only in the timestamp separator and a numeric index
line, and two parsers for two nearly identical formats are two things to drift. A cue's body lines are joined
with **spaces**, not newlines: a caption line-wrapped for a video player is one lyric line, and keeping the
wrap would publish a lyric broken at whatever width YouTube chose.

An automatic YouTube track is a **roll-up**: the words appear one at a time, so every line of lyric is emitted
three times — as the growing line with per-word timestamps, as a ~10 ms "the line is now complete" cue, and
again as the carried-over first line of the next cue. Four rules, each a defect the old parser had (the counts
are in [`../benchmarks/forced-alignment/LOG.md`](../benchmarks/forced-alignment/LOG.md), "Caption cues"):

1. **The cue separator is an empty line, not a blank-looking one.** YouTube writes a lone SPACE as the
   roll-up's empty half, and a splitter that cuts blocks on `line.strip() == ""` cut every such cue in two —
   the half with the timestamp had no body and the half with the body had no timestamp, so both were dropped.
   That is why the first cue of a track used to vanish. This parser is **timestamp-driven**: a `-->` line
   opens a cue and the next `-->` or the next truly empty line closes it, which is spec-correct for both
   formats and robust to either convention.
2. **A cue under the duration floor is dropped.** It carries no new word, and a 10 ms span is a claim no clock
   could use anyway.
3. **Only the new line of a rolling cue is kept** — leading body lines that repeat what the previous kept cue
   published are the carry. A merely line-wrapped authored cue repeats nothing, so it is still joined whole.
4. **Inline `<hh:mm:ss.mmm>` tags become word claims**, read here before `clean_line` strips them. They are
   the only per-word timing such a track carries — and **the track is still declared line-timed**,
   deliberately: `fetch_captions` builds its `TextRef` with `TIMING_LINE` and nothing on the caption path
   reads a cue's `words`. Declaring them would make these the job's **claims** instead of the cue's line
   spans, on a track whose per-word timing is a machine's guess at a sung word — a measured change, not a
   label change. They stay attached so that the wave which prices it has them.

**Rule 3 fires per TRACK, not per cue, and needs real evidence**, because line identity alone also matches a
line repeated across a cue boundary — ordinary in song captions — and on a plain authored track that deleted
the repeat from the served text. The evidence is an inline onset tag (proof on its own: a growing cue tags
every word but its first) or **enough** cues overlapping their predecessor. Overlap is counted rather than
latched on the first pair, since real authored and SDH tracks overlap here and there (two speakers, a
backing-vocal overlay, stacked subtitles) while a true roll-up overlaps on every cue it grows through — so it
reaches the bar inside its first few cues and nothing measured is lost by asking. **Adjacency is not overlap:**
`--> 00:00:04.000` then `00:00:04.000 -->` is exactly how authored cues abut. And the marker cues cannot vote —
a 10 ms cue is gone before rule 3 runs, and a cue with no words is not a caption.

The verdict is therefore read over the **whole track before any cue is built**, because that is what it is a
fact about: a one-pass latch judged every cue before the evidence appeared, as if the track were authored, and
with overlap now needing to repeat it would have cost a tagless roll-up its first carry removal. Two passes
over a parsed caption file cost nothing. The carry itself is identified by **text identity** against what the
previous **kept** cue published (comparing against the raw previous block would compare against a marker rule 2
has already dropped), with the inline timestamps taken off — the growing cue writes
`love.<00:00:22.800><c> You</c>` and the next carries it as plain text. Identity rather than a heuristic about
line counts is the point: a line-wrapped authored cue matches nothing.

**Rule 4 apportions a tag's run, and does not refuse a partially tagged cue.** A tag times a _run_, not always
one word. The code once claimed such a cue was refused; it was not, and every untagged token was given the
previous word's onset, so `zzz yyy<00:00:11.500><c> xxx</c> www vvv` published three **zero-width** words — and
the TV lights a word while `start ≤ pos < end`, which a zero-width span never satisfies. So a run of tokens
sharing one onset is spread across the room to the next onset **by character count**, the same rule `presplit`
and the ad-lib restorer use and for the same reason: an even split gives a one-letter token the same span as a
six-letter one. The first word takes the cue's own start, each word ends where the next begins, and the last at
the cue's end; a cue is refused whole, keeping line timing, only when it carries **no** tag at all, since a
word list that disagreed with the line would be read in preference to it. Refusing a partially tagged cue
instead would cost the real track word timing wherever it tagged a phrase — a loss measured in whole cues
against a defect measured in single words. On a wrapped cue the run that no tag opens continues the run the
line before it left open, which is where a wrapped rolling cue puts the rest of a tagged phrase.

Two smaller rules of the same parser. **No `.strip()` on a body line itself**: a line of one space is cue
payload (rule 1), so only a CRLF's `\r` and a leading BOM are removed, and the timestamp pattern searches, so
a line's own indentation never hides it. And **caption format is not lyric** — a cue body carries italic tags,
ASR per-word timestamp spans, music notes and speaker dashes, and published unfiltered they were drawn on the
television as words to sing (measured: `- ♪♪ Gotta get that ♪♪ <i>- ♪♪ Boom boom boom ♪♪</i>`). What is removed
and, more importantly, what deliberately is not, is [`04-alignment.md`](04-alignment.md) §8.

### 6.2 The LRC parser

An LRC carries **starts only**, so an end is interpolated from the next event and the final line gets no end
at all rather than a guessed one — `measure` treats a missing end as equal to the start, which reads as a
flash rather than as a fabricated duration. A line with **no** timestamp is dropped rather than kept untimed:
an LRC's untimed lines are metadata tags (`[ar:]`, `[by:]`) and section markers, not lyrics, and mixing them
in would put a credit line on screen mid-song.

Four things this parser used to get wrong, each corrupting the claims a whole wave of machinery then trusted:

1. **A timestamp-only line is the "vocals stop here" marker** and was skipped. That is how a sheet writes the
   end of a verse before an instrumental break, so the previous line's interpolated end ran to the next
   **sung** line, and one measured claim window ran tens of seconds across a break — the repair ladder's own
   evidence, poisoned by a parser. A boundary now closes the line before it.
2. **Stacked stamps** were half-read: `[00:12.00][01:05.00] same words` is one line claimed at two times, and
   the second stamp was published as the line's first word. Each stamp now yields its own claim.
3. **A2 word tags** were published as text, angle brackets and all; they are now **word** claims, which makes
   an enhanced sheet a word-timed candidate. A tag times a _run_ of tokens and the tags belong to the first of
   a stacked line's stamps alone.
4. **`[offset:]` was ignored**, which keeps a known stated error. The sign is the spec's: a **positive**
   offset makes the lyrics appear sooner, so it is subtracted, and the result is clamped at 0, since a
   negative claim start is a claim no clock can map.

The output is **sorted**, because an LRC is a text file a human edited and its lines are not reliably in
order — and stacked stamps guarantee it: `[00:12.00][01:05.00]` emits a 65 s claim before the 13 s one that
follows it in the file. An out-of-order series would be measured as `out_of_order` and refused as incoherent
word timing ([`04-alignment.md`](04-alignment.md) §5.3).

Four consequences of fix 3 that each closed a defect of their own:

* **The A2 tags belong to the first stamp only.** `<mm:ss.xx>` is an **absolute** time, written beside the
  stamp the author timed, so reading them once per stamp of a stacked line gave the 65 s occurrence the 13 s
  occurrence's word claims verbatim — word times 55 s before their own line's start, a non-monotone claim
  stream, and exactly the `out_of_order` reading the sort exists to prevent. The later stamps stay
  **line**-timed, which is honest (nobody timed those words); shifting the claims by the stamp delta instead
  would be the parser inventing a tempo for a repeat it never measured.
* **A run is apportioned by character count, not stacked on its onset.** Every token after a run's first used
  to take the previous token's start, so every token of a multi-token run but the last read `start == end` —
  and the television lights a word while `start ≤ pos < end`, which a zero-width span never satisfies, so
  those words were claims no consumer could use. Characters rather than an even split, because an even split
  gives a one-letter token the same room as a six-letter one. The caption parser had the identical defect and
  the identical fix.
* **A line's trailing tag closes its last word.** The standard enhanced-LRC shape ends a line with a final
  stamp marking the last word's end, and dropping it for holding no token left the last word of **every** A2
  line with a start and no end — a zero-width window again. It is carried as a run with no tokens, which is
  also what makes it the next run's bound rather than a special case; a tag with no word after it and none
  before it to close times nothing and is dropped. Where a line has no trailing tag the last run closes at
  the **line's** end, so its last word lasts until the next line, and on the sheet's final line the end stays
  absent exactly as the line's does.
* **The offset moves every edge**, start and end alike. Shifting only starts left a word ending before the
  next one began — an `out_of_order` reading manufactured by the fix for fix 4 — so the runs are resolved into
  claims in the sheet's pre-offset coordinate and shifted whole.

A stamp's **fraction scales by its digit count**: `[00:01.5]`, `[00:01.50]` and `[00:01.500]` are all one and
a half seconds, and treating the digits as hundredths regardless would make a thousandths sheet run 10× fast.

**Provider manners, and what each one cost when it was absent** (both clients): a descriptive User-Agent,
because LRCLIB asks for one and rate-limits anonymous traffic harder; a short timeout, because the align flow
has a fallback ladder behind it and waiting is strictly worse than moving on to ASR; **one rate gate per
service, shared by every client in the process**, since the budget is per source IP and a per-client gate would
let two clients each pace themselves and still burst together, which is what gets an IP blocked; and each
client builds its **own** opener, constructing the proxy handler explicitly — the default opener drops it when
no proxy is configured at build time, so a process that outlives a configuration change would never see the new
one. An HTTP error is **returned** to the gate rather than raised, so the gate can decide whether 429/503
deserves another attempt, while a transport failure still raises: that is not a status, and no amount of
backoff turns it into one. **404 is the only status treated as a miss.**

**A duration miss is retried without the duration.** The duration is sent when known, because LRCLIB uses it to
tell a single edit from an album version — the "right song, wrong master" case that produces confidently
misplaced lyrics. But the duration this worker measures is the **upload's** rather than the recording's, so a
music video with an intro, an outro or a spoken skit is minutes longer than the track, the qualified lookup
404s, and the song falls through to ASR with a good human sheet one request away. The trade is deliberate and
asymmetric: an unqualified lookup may answer with another cut's sheet, whose **line timings** are then wrong —
a hazard the claim clock maps, the LINE_SYNC gate judges and the lexical lift refuses, three shipped gates that
already read it — where a 404 is no text at all, which no gate can recover. One retry, and only on a 404
(LOG.md, "W7: the provider pool is real now"). A payload's `instrumental: true` is the provider stating
positively that the track has no words, which is better evidence than an empty field but still "no text" to the
caller; a synced sheet is preferred over a plain one and **falls back** rather than failing, a plain sheet
still being a real set of words that forced alignment can time from scratch.

## 7. Transport and ownership

The client owns the socket and the ledger and knows nothing about audio: every inbound frame becomes
either a ledger update or a request to start a workflow, and every outbound frame comes from a frozen
dataclass. Three responsibilities:

1. **Reconnect with backoff**, because a LAN core restarts and a worker that exits on a dropped socket
   needs a supervisor to do what a loop does for free.
2. **Emit progress on a timer** while a step runs, so the core's lease does not expire. Under durable
   resumption an expired lease is no longer fatal, but a keepalive that never fires still makes every long
   separation look dead. `job:progress` doubles as the lease refresh (core's `progressLeaseMs` is **30 s**)
   and this worker once emitted no progress frame of any kind: `keepalive()` existed, fully written, with no
   caller. **Measured when it was found**: a **195 s** song fetched in **2.1 s** and separated in **22.3 s**,
   then its align job revoked at **32.9 s** with `progress-lease-expired` and requeued, with nothing wrong
   with the job. Under 30 s of work per step the bug is invisible, which is why end-to-end runs on short
   clips passed — the failure arrives only with real songs, on slower boxes. The keepalive therefore wraps
   **every** dispatch branch including the unknown-action refusal, since a job that fails to dispatch still
   holds a lease until its frame lands; and it repeats the coarse stage rather than inventing a percentage.
3. **Reconcile ownership on every reconnect**, and refuse to publish anything unconfirmed.

**Why ownership needs a ledger at all.** The core's reaper requeues a job whose lease expired, handing it
to another worker. If this worker is mid-alignment when that happens, both finish and both publish —
different lyrics for one song, last writer wins, no error anywhere.

The guard is **two-sided**, and both halves are needed. A **pushed** revocation closes the window
continuously, which a poll cannot, because the reassignment happens at a moment nobody chose. A **pulled**
claim covers what a push loses: a disconnect drops pushed frames, and a disconnect is precisely what
causes a lease to expire and a job to be reassigned — so the one event that revokes a job is the same
event that hides the revocation. Either alone leaves a case where two workers publish.

The ledger is pure (no sockets, no clock) and **fails closed**: an unknown job is not ours. A worker that
publishes for a job it cannot account for is exactly the failure being prevented, and the cost of being
wrong the other way is one redundant re-claim.

**Every frame is a type.** The worker this replaced built dictionaries in builder functions, so a typo in
a key was a runtime mystery on a deploy box and the core's contract was knowable only by reading eleven
builders. Here mypy checks construction, one method is the only place a camelCase key is spelled, and one
function is the only place an inbound payload is trusted. Two conventions, deliberately not one:
snake_case in Python and camelCase on the wire (translating at a single boundary beats either half writing
the other's style), and an optional field is **omitted** when absent rather than sent as `null` — which is
how a newer worker stays compatible with an older core, since an unknown key is ignored where an explicit
null may not be. Parsing **raises** rather than returning nothing: an unparseable frame is a contract
violation, and the one thing worse than crashing on it is continuing with a frame whose fields silently
defaulted.

### 7.1 The ledger's finer rules, each closing a window

**Publication is guarded at two points**, and both are load-bearing: the transport re-claims every recovered
workflow on reconnect, **and** `publish` re-asserts ownership as its first act. A lease can expire _during_ a
long alignment, so a workflow that was legitimately ours at reconnect can be reassigned before it reaches
publication; checking only at reconnect leaves exactly the window where two workers publish different lyrics
for one song.

**A disconnect marks jobs unconfirmed, never lost.** Resetting standing to `LOST` would abandon healthy
in-flight work on every blip, and a reconnect usually confirms the same jobs — but every one of them must be
re-claimed before it may publish. **A job the core has never heard of is recorded with its own reason**
rather than folded into an ordinary reassignment: it is a real desync (this worker is running something the
core has no row for), and it must not publish either way.

**A recorded loss outlives the job**, which is the subtle one. A revoked job's driver runs its cleanup the
moment it is cancelled, so clearing the loss when the job ends would erase the reason it produced nothing —
exactly when an operator asks why. A job that completed normally has no entry to keep, so this costs nothing
in the ordinary case. The map of losses is **bounded** because the process is long-lived and a revoked job id
would otherwise never leave; oldest out, FIFO off dict insertion order.

**The pull half can be switched off, and it defaults on.** Requiring a confirmation nothing sends deadlocks
every publish after the full cook — a total outage rather than a safe default — so the flag was false for
exactly as long as core could not answer, and the flip belongs in the same change as the core handlers and
nowhere else. Core now answers every claim with a three-way ack and the reaper pushes a revocation to whoever
held a job **before** the requeue clears the row. Set it false only to run a new worker against an **old**
core, which drops the claim silently: nothing would ever clear the unconfirmed set. With the flag off,
`disconnected()` is a no-op and the residual exposure is the honest one — a revocation pushed while the socket
was down is never seen, the same window the worker this replaced lives with.

**A stale standing is waited on, not refused.** A workflow that finished during a reconnect is almost always
still ours and abandoning it throws away a completed alignment; but if the core has reassigned it, another
worker is already publishing. So `publish` re-claims and waits, and **a timeout is a refusal** — an unanswered
claim means ownership cannot be established, which is the whole thing the guard is about.

**The model catalogue is announced off the event loop.** Enumerating the zoo is synchronous, CPU- and
network-bound, and measured at **4.80 s** on a cold process, so on the loop it would stall every heartbeat for
that long — which is precisely what the reaper reads as a dead worker — or indefinitely if its first-run
download hangs. Its failure is **silent by design**: a box that cannot enumerate its zoo offers the models it
already advertised at handshake, and raising would take down a connection over a picker's contents.

## 8. Durability

**The piece production was missing entirely.** Wrapping every step with a DBOS step decorator was mistaken
for durability. It is not: a step only checkpoints inside a workflow context, so steps invoked from a
plain coroutine run as ordinary functions and record nothing. The live process proved it — after a
complete align job, the system database held **zero** workflow rows. The DBOS tests did not catch it
because each one declares its own workflow inside the test, so they proved DBOS *can* run the flow durably
while production never asked it to. That is the sharpest form of a test proving the design instead of the
system.

**Only the job reference crosses the workflow boundary,** and that is a hard constraint rather than taste:
workflow arguments are serialised into the system database so a recovering process can replay the call.
The steps object holds loaded models, a websocket and subprocess handles — passing it raises a pickling
error, which is how this was found. So the steps are resolved **inside** the workflow from a provider
registered at startup.

**A requeue forks.** A workflow that raised is `ERROR` in the system database, and DBOS answers a start
under an `ERROR` id with the **recorded** exception: no step runs again. So the core's requeue of a
retryable failure replayed the same error in an instant, attempt after attempt, until the attempt ceiling
failed the job terminally — with the cause long gone. `retryable` meant nothing under DBOS. A fork is
DBOS's own restart: a new workflow id whose steps before the failure are copied from the failed run, so
every completed step replays from its checkpoint and the step that failed runs again. The ids are
deterministic (`J~requeue-n`) so a requeue is still idempotent, and the chain is walked from the job id.
The core decides whether a failure is worth requeueing; this only makes a requeue re-run. Measured on dbos
**3.1.0** before the fork existed: **one** `time_text` call across **three** requeues of the same job. It
forks from the first step that recorded an error, else the step after the last recorded one — a workflow body
that raised *between* steps replays deterministically and raises again, which is correct.

**A job fails on the fault its step raised, not on DBOS's wrapper around its retries.** A step allowed
retries that fails every one ends in `DBOSMaxStepRetriesExceeded`, which holds the attempts' own exceptions
but carries neither their `retryable` flag nor their message — so the transport reported every exhausted
acquisition as retryable, with "Step acquire_audio has exceeded its maximum of 3 retries" as the reason. The
**last** attempt's exception is what the job failed on, so that is what reaches the transport.

**Checkpointed records have three constraints**, each real rather than stylistic: frozen and slotted (a
mutation would be invisible after a replay, where the caller's copy is rebuilt from the checkpoint);
tuples and mappings, never lists and dicts; and paths and refs, never bytes, tensors or handles. And a new
field is **appended, never inserted**, restored through a helper that fills what an older checkpoint
lacks — because pickle restores a slotted record positionally and left a newly added field unset, so a job
in flight at an upgrade failed on the first read of it, fork after fork, until the ceiling.

### 8.1 Runs a requeue must not replay, and stopping a run

Both workflows are declared before DBOS starts, so the runs a crashed worker left in flight are recovered
rather than hung (below).

**A requeue forks, rather than replays, four kinds of run (the fourth is below)**
(`durable._ended_without_result`). An ERROR
run, as above. A CANCELLED one: the worker cancels the workflow of a job the core took back, and DBOS
answers a start under a cancelled id with the cancellation. And a stems or align run that **abandoned** its
publication: it finished SUCCESS, but what it recorded is a lost race for ownership, and on a one-worker
box the requeue lands on the same box and replayed that refusal until `maxAttempts`, in milliseconds.
Both publishes are recorded steps that raised `NotOurJob`, so either fork resumes AT PUBLISH. For stems
(`workflows/dbos_stems.py`) that skips the separation, the minute or more a reconnect used to cost: acquire,
decode and separate replay from their checkpoints into the same scratch WAVs, which `settled` keeps for a
resumable job and the sweep keeps for an hour (XW-08). The silence probe and the song profile are not steps:
they only read those WAVs, so they run again. Fetch is not durable and replays nothing.

**The workflows are declared before DBOS launches** (`durable.declare`, called from `_launch_dbos`), with
their steps providers supplied later by `durable.register`. Launch recovers the runs a crashed or restarted
worker left in flight, and hashes the declared workflows into the application version. Declared after it,
recovery failed with "encore-stems is not a registered workflow function", the run stayed PENDING, and the
core's requeue waited on it, with nothing executing, until the 6 h job ceiling; the version also never
changed across builds. A recovered run waits in its body until the providers exist. Launch recovers only
its own build's runs, so a fourth kind of run is forked too: one **another build left PENDING**, which
nobody would ever finish (`tests/test_overlap.py`, the crash test).

**The cancel token is bound inside each workflow body**, not only where the job starts. DBOS runs a fork
or a recovered run on its own loop, in a context that never saw the transport set the token, so without
each body binding it first (`steps.cancel.bind_cancel_token`) a cancel stopped the DBOS row and left the child running.

## 9. Configuration and capability

**One place, and it raises.** Everything the worker reads from its environment is parsed once at the
boundary, and an unknown token is refused there with a message naming the variable and the accepted
values, rather than reaching a subprocess several stages later as an opaque failure. The worker this
replaced learned it the other way: a rejected engine name failed deep inside a step, where the traceback
named ffmpeg rather than the setting. Nothing below reads the environment directly, so a test builds a
config literal instead of mutating process state — which is also why every field has a default.

**What this box can do is probed, not assumed**, and two separate questions live in that module: a
best-effort **description** for the dashboard (a diagnostic must never fail a handshake, so every field is
optional and a failed probe omits rather than guesses) and a load-bearing **resolution** of which
separator implementation will actually run — a box announcing one backend must not run another, and a box
that advertises `stems` with no engine behind it accepts separation work and then fails every job of it.
The probe is import-free where possible, because importing torch costs seconds and several hundred
megabytes of resident set, paid on a box that may only ever serve align jobs.

**One validation deliberately does not live in config:** whether a named alignment bundle has a
calibration row. `host/` may not import `domain/`, so the composition root makes that check — with config's
own "fail fast and name the setting" manners — before a single job is accepted
([`04-alignment.md`](04-alignment.md) §5.4).

### 9.1 What each capability gate is proving

A capability is a claim the box can **finish** work of that kind, so every gate here is chosen to prove the
last thing that could still be missing. The pattern each one follows, and the failure it is the fix for:

| capability | gated on | because |
| ---------- | -------- | ------- |
| `stems` | ffmpeg **and** the engine the **resolved backend** names | presence of `demucs` proves the models are installed, but the resolved backend decides which engine runs — an Apple-Silicon box with both `demucs` and `demucs_mlx` resolves to `mlx`, and advertising `stems` with only a torch engine present accepts separation work and fails every job of it at plan selection, non-retryably. ffmpeg is the same defect one dependency further out: the input is normalised by shelling it and the output verified by shelling it, so a box with demucs and no ffmpeg fails every job at decode |
| `stems:roformer` | the **CLI binary**, never the importable module | the module proves the checkpoint code is installed; only the binary proves this box can run it, the engine shelling out rather than importing. Advertising on the module alone meant a box could claim the capability, be handed a `stems-upgrade` job (roformer being the default upgrade engine) and separate it with **demucs** instead — publishing demucs output labelled as the upgrade, which no log would contradict |
| `stems:melband-mlx` | the `mlx_audio` module | an import rather than a subprocess probe, which only became true with the whisperx 3.8.7rc1 pin: on 3.8.6 the huggingface-hub bound made `mlx-audio` uninstallable alongside whisperx, so this had to run a sidecar interpreter. Gated on the runtime being **installed** and never on the accelerator being Apple Silicon — a Mac without the `mlx` extra cannot run these models, so a hardware-shaped gate would advertise work the box must reject. The platform check is implied, `mlx-audio` only installing on darwin/arm64 |
| `stems:audiosep` | the `audio_separator` module | sufficient here in a way it was not for roformer: the zoo runs **in-process**, so an importable module really is the whole requirement, there being no separate binary whose absence could make it unrunnable. Checkpoints download on demand. It was deliberately withheld until the adapter existed, advertising ahead of the implementation being the roformer failure again |
| `diarize` | the `pyannote.audio` module | **advertised but not routed on**, which is core's behaviour rather than an oversight: `requiredCapability` maps only fetch / stems / stems-upgrade / align and core's source never mentions `diarize`. So it changes no dispatch — it restores what the worker this replaced reported, which is what an operator reads off the dashboard to tell a box that can attribute lines to singers from one that publishes single-colour lyrics. Gated on the module because diarization is an import here, and pyannote is HF-gated and heavy |

**Backend resolution: an explicit setting always wins**, even when the box cannot honour it, because the
failure then names the setting — which is what an operator who typed it needs. Auto-selection prefers `mlx` on
Apple Silicon (Metal, and materially faster there) and otherwise torch, and it carries its own **reason**:
"auto-selected mlx (Apple Silicon)" and "explicitly configured mlx" behave identically but mean different
things when a box turns out to be separating on the wrong engine.

**The ML runtime takes one process-wide lock**, not one per model. The point is not mutual exclusion between
checkpoints: a box with concurrency above 1 must not load two multi-GB models at once, nor run two inferences
that each expect the accelerator to themselves. Two jobs loading whisperx and demucs simultaneously on a 10 GB
card is an OOM that reads as a model bug, and the second job's failure looks unrelated to the first job's
existence. It lives in `host/` because three users across two concerns share it — forced alignment, ASR and
diarization — and a lock shared by two concerns is a property of the **process**, not one concern lending it to
the other: the worker this replaced kept it in the aligner, which forced the diarizer to import from the lyrics
module and created the only cross-domain import in that codebase. It is an **RLock**, because a loader may call
into another guarded helper on the same thread (building an aligner resolves a device, which may itself take
the lock) and a plain `Lock` self-deadlocks there; and it is a threading lock and not an `asyncio` one, because
every guarded call runs inside `asyncio.to_thread`, so the contention is between OS threads.

**On a GPU or MPS device the subprocess separators take it too** (`mlrt.accelerator_lock`, held around
`SeparateStepsImpl.separate`). demucs, roformer and demucs-mlx run in a child process, out of reach of a
lock inside the models, so without this two jobs on one card could put two separations, or a separation
and HuBERT, on it at once. With it, a second job on a card overlaps only CPU-side work: a download, the
decode, the probe, the profile, the encodes and publish. **On CPU the separators take no lock**: each
separator child gets `cores ÷ concurrency` threads instead (`separator_threads`, `resolve_profile`), and a
separation running beside another song's alignment is the overlap concurrency 2 exists for. The in-process
models keep the lock on every device, so they take turns and keep every core.

**Concurrency 2 is an opt-in, not the auto pick.** On a loaded 32-core CPU box, 3 songs queued at once were
ready 18–70% sooner at 2. But a song picked on its own was 10–30% slower in every measured pair, its align
step (whisper's VAD and HuBERT) taking up to 2–3× as long. That held even after the models were given every
core again, and the cause is not pinned down (#1177). A lone pick is what most nights look like, so the
worker boots at 1, and `ENCORE_WORKER_CONCURRENCY=2` is for queue-heavy ones.

## 10. Invariants

| # | Invariant | Why | Held by |
| - | --------- | --- | ------- |
| **XW-01** | A stem's ROLE is measured from the audio before publication; an unmeasured model's output is refused, never guessed. | Publishing the vocals as the karaoke master is silent and only audible in the room. | `domain/audio/roles.py`; `tests/test_roles.py`, `tests/test_registry.py` |
| **XW-02** | A number in a registry row has a matching measured row in the stem-separation README. | An unsourced figure was already copied from a GPU contract once. | review, and the README's own table |
| **XW-03** | A store key is a mirror of core's path module, asserted against it. | A mismatch is silent: real file, real row, 404 at the player. | `tests/test_artifact_keys.py` parses `paths.ts` |
| **XW-04** | A key is never joined onto the media root, and never allowed to resolve outside its class root. | Class roots may point elsewhere; a key arrives over a socket. | `artifacts/local.py` |
| **XW-05** | Publication is atomic within the destination filesystem. | Core serves byte ranges off these keys while we write. | `artifacts/local.py` |
| **XW-06** | A stems job publishes a `songProfile` on every success, even all-null, and a profile failure never fails the job. | Core reads a present profile as "the analysis ran" and an absent one as "still processing" — the song becomes permanently unsingable and never re-processed. | `domain/audio/profile.py` |
| **XW-07** | An unmeasurable analysis value is `None`, never a default. | 0 LUFS reads as a deafeningly loud track. | `domain/audio/{key,loudness,vocal_range}.py` |
| **XW-08** | Scratch is kept for a retryable failure and a lost lease, released for a terminal outcome, and swept by age. | Checkpointed steps return paths into scratch; a crash leaves no code to run the hook. | `artifacts/scratch.py` |
| **XW-09** | The ownership ledger fails closed, and is fed by both a pushed revocation and a pulled claim. | The event that revokes a job is the event that hides the revocation. | `transport/ownership.py` |
| **XW-10** | An optional wire field is omitted, never `null`; an unparseable frame raises. | Forward compatibility, and a silently defaulted frame is worse than a crash. | `protocol/frames.py` |
| **XW-11** | Only the job reference crosses a workflow boundary, and the steps are resolved inside. | Workflow arguments are serialised; the steps object holds handles. | `workflows/durable.py` |
| **XW-12** | A checkpointed record only gains APPENDED fields, restored through the helper. | Pickle restores slotted records positionally. | `steps/records.py` |
| **XW-13** | An unknown configuration token is refused at the boundary, naming the variable. | Otherwise it surfaces as an opaque subprocess failure stages later. | `host/config.py` |
| **XW-14** | A capability is advertised only where the runtime is installed. | A box that advertises work it cannot do accepts it and fails every job. | `host/hardware.py`; `tests/test_registry.py` |

## 11. Where to look

| question | file |
| -------- | ---- |
| separator throughput, SDR, purity, stem-role margins | [`../benchmarks/stem-separation/README.md`](../benchmarks/stem-separation/README.md) |
| lyrics timing | [`04-alignment.md`](04-alignment.md) |
| the operator's tour: engines, settings, the three suites | [`../../worker/README.md`](../../worker/README.md) |
| media layout as checkable requirements | [`01-media.md`](01-media.md) |
| job retry, restart and crash recovery as requirements | [`03-jobs.md`](03-jobs.md) |

## 12. Prose shape: the 2026-10-01 directive, as bounds a test can check

**The directive.** Code is self-documenting and prose lives in `docs/`: a docstring says WHAT a thing is and
WHY it exists, in a few lines; measurement narratives, threshold provenance, rejected alternatives, failure
accounts, per-song numbers and the history of the wave that produced them belong in a document, with the code
pointing at it by path. A measured NUMBER may be moved but never deleted — if it leaves a docstring it lands
in a document. During the cleanup that was checked by a lossless scan over a frozen manifest of every numeric
token the prose carried (`_tools/verify_numbers.py`, `_tools/prose_scan.py`); those were working-tree tools
and are not committed, so nothing in this repository runs that check today.

**Why bounds per KIND of prose.** The first sweep measured the package at 48% prose (3 685 comment lines and
7 577 docstring lines against 12 252 of code) and moved ~3 800 lines out, under one bound: "no prose block over
40 lines". That bound was satisfied by **144** blocks of 12 lines or more — counted by kind over the snapshot
of `worker/encore_worker` the per-kind rules were set on, with the ratchet's own helpers: 130 docstrings, 8
own-line `#` runs and 6 `#:` runs, or **145** under rule 5's bridged definition, the largest a **40-line**
module docstring in `domain/lyrics/parts.py`. A single block bound cannot see the difference between an essay
and three legitimate paragraphs, so it was replaced with one number per kind, in
`worker/tests/test_prose_shape.py`:

| rule | bound | what sat on it when it was set |
| ---- | ----- | ----------------------------- |
| 1. MODULE docstring | 12 lines | `domain/lyrics/parts.py` held 40 — a mechanism, two anchored rules, a measured refusal, an interpolation policy and an order invariant, all of which is [`04-alignment.md`](04-alignment.md) §8 and §12 now. |
| 2. def / method / class docstring | 8 lines | `steps/align_steps.py` held a 125-line one (`_time_line_sync`) before the first sweep and a 22-line one after. |
| 3. own-line `#` comment run | 6 lines | `host/config.py` held 261 lines of `ALIGN_EXPERIMENTS` commentary. `#` continuation was the cheapest way to keep an essay, so it has a bound of its own. |
| 4. `#:` attribute comment | 3 lines | A calibrated constant carries its value, its unit and a pointer — never its derivation, which is a measurement. |
| 5. bridged prose BLOCK | 18 lines | Exactly what rules 1 and 3 allow back to back, i.e. the worst legal combination: a BACKSTOP that catches a THIRD paragraph, not a bound anything sits on (the worst block measured 13). |
| 6. per-module prose/code | 0.55 at >= 100 code lines | The package's worst module is `domain/lyrics/policy.py`. Below 100 lines of code the ratio measures a module's INTERFACE — a Protocol or a table of constants is one line of code per declaration — so rules 1-5 and 7 carry those. |
| 7. per-layer prose/code | 0.55 | Read over all 11 package directories RECURSIVELY: a top-level-only list left `domain/audio` above the bound and invisible behind `domain/`'s average. The worst layer is `artifacts/`. |
| 8. package prose/code | 0.52 | Below the layer bound on purpose: every layer sitting at its own bound would be a different package from this one. 1.21 before the first sweep, **0.82** at the snapshot the per-kind rules were set on, **0.49** after. |
| 9. root aggregates | tests 0.33, forced-alignment harness 0.28, stem-separation harness 0.30 | Measured on the shipped tree: `worker/tests` **0.32** (0.3114 at the snapshot the rules were set on; later tests moved it to 0.3158, inside the 0.33 bound), `docs/benchmarks/forced-alignment/scripts` **0.26**, `docs/benchmarks/stem-separation/scripts` **0.22** (and the package **0.49**). Each quote is held by `test_the_quoted_root_ratios_still_measure_what_they_say`, because the two figures this row first carried (0.3124 and 0.2580) were already stale when they shipped. |
| 10. consecutive comment overlap | 0.6 Jaccard on content words | `pool_gate.py`'s `ARMS` carried `SOUND_CUES`' `#:` block verbatim: three index claims that were false of its own tuple, and the arms' real semantics deleted. Set in the gap the tree measures — the one real pair **0.889**, the next **0.436** over **773** adjacent disjoint pairs — so a pasted block fails and two comments about related constants do not. |

**Where the package's own ratio was read.** Rule 8's row quotes **0.82** for the snapshot the per-kind rules
were set on, measured with the ratchet's `_counts` over that snapshot's tree (7 840 prose / 9 593 code =
0.8173). The figure the row first carried, **0.745**, is the same measure taken mid-cleanup — after the first
pass over the largest blocks had already landed — so it was never the baseline it was quoted as. The 1.21 is
the tree before the first sweep, which this measure reproduces exactly, which is how the method was checked.

**Blocks are BRIDGED across blank lines.** A block ends only at a line of code, so neither two touching
docstrings nor `#` continuation nor a bare blank line splits an essay into passing halves — which an
adjacency-only rule allowed, and a blank line every 30 lines defeated.

**Which roots the rules bind on.** All five shape rules, the block rule and
the comment-overlap rule read **four** roots: the package
`worker/encore_worker`, the worker's own tests, and BOTH committed bench harnesses —
`docs/benchmarks/forced-alignment/scripts` and `docs/benchmarks/stem-separation/scripts`. The first sweep
covered the package only; extending the per-kind rules outwards cost 239 edits across 68 test modules and 12
forced-alignment scripts, plus 4 in the three stem-separation scripts. The ratio rules stay the
package's, with each other root held to an aggregate instead: a test file is many small functions each
honestly carrying two lines of WHAT, and a gate script is a measurement argument with a `main()` attached, so
a per-module 0.55 there would delete short docstrings that are exactly the right length. The roots are a claim
about coverage, so `test_the_shape_rules_say_where` and `test_every_root_has_modules_to_measure` assert the
tuple, the per-root module floors and that no two roots share a label (both harness directories are called
`scripts`, and one label for two roots would merge their worst prose), and `test_the_shape_rules_say_where`
also holds the root COUNT this module's own prose spells, because rule 2's docstring once went on saying three
after the fourth arrived.

**A fixture's own numbers are terminal.** The lossless scan (not committed, see above) treated prose in
`worker/tests` as a durable home of its own: a number in a test's prose describes the setup under it and has
no document it could move to without making the fixture unreadable, while package prose was not a home and
had to move to `docs/`. That was not a blanket pass, which was checked on a throwaway tree: deleting the number
from the test's prose turned the row `LOST` again, and a number in package prose stayed `LOST`.

**What a test docstring keeps.** The claim it pins, and the WHY that makes the claim worth pinning — commonly
the mutation that used to survive, named in one clause. What it does not keep is a re-derivation of a
measurement, a re-argued review finding, or a narrative of the wave that produced it; those go to the
measurement README or to a design document. A harness script's docstring keeps the COMMAND LINES that run it,
which is why its module bound holds two or three of them plus one paragraph and a pointer.

**EXCEPTIONS is empty, and that is the finished state.** The per-kind pass cleared 271 package violations and
243 in the other three roots without granting one. An exception is a judgement about a particular docstring; raising a
bound is a judgement about every docstring in the tree, which is how the 40-line bound came to allow the 144
blocks above. `TIGHTEST` names the module or layer sitting closest to each bound and a test fails when that
claim goes stale, so the next edit moves a paragraph instead of raising a number. The MEASURE itself is held
too: `test_the_measure_still_sees_prose` floors what `_prose_lines` and `_longest_block` return and pins the
bridging rule on a synthetic module, because zeroing the measure used to leave all 24 tests green — rules 5 to
9 all read it, and `TIGHTEST`'s own check passes on a tie at zero.

**What a grant can reach.** Rules 1-4 are keyed `"<label>::<qualname>"` and rule 5 by `"<label>::<block>"`, a
block spanning whatever docstrings and comment runs touch it and so having no qualname of its own. Rule 5 once
read `EXCEPTIONS` not at all: the hatch could sanction a 9-line def docstring and not a 19-line
one, i.e. not the length it exists for, and nobody could learn that except by mutating the tree.
Rules 3 and 4 still have no route — a comment run has no stable name, so shorten it or make it a
docstring and argue there — and `test_every_named_exception_is_still_needed` deletes any grant, block or
docstring, whose target has come back inside its bound.

**A quoted ratio is a CEILING, not a pin.** `MEASURED_ROOT_RATIO` shipped as an equality at ±0.005, and the
stem-separation root had **0.9 lines** of headroom: deleting three docstring lines from it failed the suite,
which is the 2026-10-01 directive's own remedy breaking the ratchet that enforces it. The
rule is now one-sided — a reading that rounds ABOVE the quote fails at once, since that direction claims less
prose than the root carries, and a reading below it costs a re-quote only past `QUOTE_STALE_ABOVE` = **0.05**.
A retracted figure is held too: `RETRACTED_RATIOS` names each one and
`test_a_retracted_ratio_is_never_republished_as_a_reading` fails a paragraph of this document or of the
measurement README that quotes one outside a retraction, which is how **0.745** came to be published here as
withdrawn and in the README as a reading at the same time.

**What the layers measured, before and after.** At the directive the orchestration layer `steps/` read **1.80**
prose lines per line of code and **0.78** after the first sweep; `domain/` and `adapters/` read **1.02** and
**0.89** before its third task and **0.92** and **0.84** after it. On the shipped tree they read **0.48**, **0.51** and **0.49** (`_layer_ratio`,
recursive), and the worst layer of all is `artifacts/` at **0.545** — the only one anywhere near rule 7's 0.55,
which is why `TIGHTEST["layer"]` names it. The first-sweep figures are history, kept labelled: a number quoted
as today's reading has to be re-measured (0.78 is above the bound a layer at 0.78 would fail).

**The pointers are checked too, over the same roots.** `worker/tests/test_docs_pointers.py` resolves every
`docs/` path the code cites, every `path §N`, every cited README section title and every `XA-`/`XW-` invariant
id, and fails a citation that leads to a gitignored working document — because a pointer to nothing loses
exactly what the cleanup moved. Its roots are the package, both bench harnesses and `worker/tests`: at first
only the invariant-id rule read the tests, so the pointers the sweep left in test prose went unchecked.
That population, read off the shipped tree as the rules read it and as OCCURRENCES
— the denominator the first figure never stated — is **72** `docs/` paths over **19** distinct, **26**
`path §N` and **8** README titles; it is a FLOOR in `MIN_TEST_POINTERS`, so widening the roots cannot be undone
quietly. The 57 and 11 this paragraph first carried reproduce on no tree and under no reading.
The invariant-id rule runs both ways now: every cited id must be a row (so a deleted row
breaks the suite) and every DECLARED row must be cited from code, which 9 of the 14 `XW` rows were not —
`XW-12`'s only citation was `test_docs_pointers.py`'s own `#:` example, so the module that holds it never named
it. Each id now sits at the site its "Where held" column names, `UNCITED_INVARIANTS` is EMPTY, and a citation
from the declaring module does not count. The floor moved with the population too:
**143** citations over all **31** ids, so `MIN_INVARIANT_CITATIONS` is **110** rather than the 50 it was left at
while the count tripled. **One open item, named rather than
silent.** The ANCHOR rule — every `§N` in prose must sit near a committed document path, or it means the
gitignored review — still skips `worker/tests`, which carries **29** bare `review §N` marks across 14 modules
(7 of the original 36 were re-pointed at the committed section they meant). `UNANCHORED_IN_TESTS` ratchets that count
downwards, a new one fails the suite, and reaching zero fails it too, with the instruction to delete the
exclusion.

## 13. What the worker's fixtures measure

The same rule as [`04-alignment.md`](04-alignment.md) §17, for the parts of the worker outside alignment: the
numbers that explain why a fixture has its shape live here, and the test keeps one line saying what it pins.

**Stem roles, verified by hand once** (`tests/test_audiosep.py`). A real zoo separation is a 200 MB download
and a minute of inference, so what the suite exercises is everything around the model call — which is where
the safety lives. The happy path was verified by hand on a 20 s excerpt of `tfr-flyaway` with
`bs-roformer-instrumental-resurrection-by-unwa`: it wrote two files, and role detection named `(other)` the
instrumental at **86.73% low-frequency energy against the vocals stem's 2.64%** — a **32.9x** margin, on the
very model whose filenames `bs-roformer-infer` reports inverted. That margin is the evidence for §2.2's rule
that roles are measured from the audio and never read off a filename.

**A model that declares nothing is undescribed, not unsafe** (`tests/test_zoo.py`). 62 of the catalogue's 169
entries declare no stems, and dropping them was a real mistake: it hid `bs-roformer-vocals-by-gabox`, which
carries the highest published instrumental SDR in the whole catalogue (**17.21 dB**), and
`bs-roformer-instrumental-resurrection-by-unwa`, the one roformer this project has measured itself. They are
offered as `unknown` because runtime role detection does not need the declaration — which is the entire point
of measuring (§2.3).

**Why there is a suite against REAL models** (`tests/test_ml_real.py`). Everything else fakes `Transcriber`
and `Aligner` behind their Protocols, which proves the state machine and says nothing about whether the
adapters work. It found two bugs that **375 passing tests** could not: `device_for()` returns `mps` on Apple
Silicon and whisperx's transcriber is CTranslate2, which raises `ValueError: unsupported device mps`, so ASR
would have hard-failed on every Mac in the mandatory fallback; and torch 2.6 flipped `torch.load`'s
`weights_only` default to True, breaking the pyannote VAD checkpoint whisperx loads on the way to a
transcriber, so `load_model` failed on EVERY device. The audio is synthesised with macOS `say`, so the expected
words are known exactly and an assertion can be about accuracy rather than about whatever a committed fixture
happened to contain. Marked `ml` and slow: models download on first use (~150 MB for whisper tiny, ~360 MB for
the wav2vec2 aligner), so `-m 'not ml'` gives the fast suite.

**Why the bench harness has unit tests of its own** (`tests/test_lang_gate.py`, `tests/test_pool_gate.py`,
`tests/test_bench_e2e.py`). `lang_gate.py` was **651 lines with no test at all**, referenced only from
docstrings and loaded by nothing, while carrying the decisive numbers of the language work: the 59-song fr/de/es
reading that ships `lang-route-mix` default-off, the `--folds` census that licenses the NFKD fold as a
byte-level no-op on every row under `results/`, and the live blank proof. A defect in `score`'s truth pairing, in
`pooled`'s arithmetic or in `fold_census`' alphabet would move those verdicts silently — and one of them
(`pooled`'s AAE) was in fact live. A harness that grades the project needs the same gates as the project.
