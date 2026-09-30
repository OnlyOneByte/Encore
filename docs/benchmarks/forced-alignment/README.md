# Forced-alignment benchmarks

How accurately the worker places lyric lines on a recording, measured against line timings a **human**
wrote for that exact recording.

Companion to `docs/benchmarks/stem-separation/`, and built for the same reason: the worker already has a
`TimingReport` (`domain/lyrics/measure.py`), but every figure in it is **self-consistency** — coverage,
overshoot, out-of-order words, smeared and flashed words. Those catch a structurally broken alignment. None
of them can tell a correct alignment from a plausible one that is uniformly 800 ms late, because nothing in
that report knows where the words actually are. Ground truth is what closes that gap.

## Ground truth: authored captions, line level

`scripts/truth.py` fetches the song's own caption track with yt-dlp's `--write-subs`.

**Authored, never auto-generated, and that is the validity of the whole benchmark.** `--write-subs` returns
the track a human typed; `--write-auto-subs` returns YouTube's ASR. Scoring a forced aligner against another
model's output measures agreement between two models, not correctness — so the script passes `--write-subs`
only and refuses a song with none rather than falling back.

**Line level, because that is what exists.** A `json3` caption event carries one start and one duration for
a whole line. Verified: 0 of 75 events on `tfr-flyaway` carry more than one timed segment, so there are no
per-word human offsets to score against. Every figure here is a LINE ONSET figure and no claim is made about
word placement.

That is still the number that matters for karaoke: a singer reads the line before singing it. A line that
highlights late is the complaint; a word 80 ms out inside a correctly-placed line is not.

| song          | authored lines | span                |
| ---------------| ----------------| ---------------------|
| `tfr-flyaway` | 75             | 13.20 s .. 189.54 s |
| `tfr-mayday`  | 52             | 13.14 s .. 239.34 s |
| `tfr-chosen`  | 37             | 10.00 s .. 229.00 s |

## Machine

| id | machine | chip | cores | memory | OS |
| --- | --- | --- | --- | --- | --- |
| `m1pro` | MacBookPro18,1 | Apple M1 Pro | 10 (8P + 2E) | 32 GiB | macOS 26.6.2 (arm64) |

Aligner: `whisperx` 3.8.7rc1 wav2vec2 forced alignment on `torch` 2.8.0, device `cpu`.

## The mechanism that makes this a sweep and not one number

**whisperx does not search the recording.** It crops the audio to each segment's provisional span and aligns
the text *inside* it. So accuracy is not a property of the aligner — it is a property of the aligner **and
the windows it was handed**. Two regimes on the same song and the same audio:

| provisional spans            | bias    | MAD     | within ±250 ms | >2 s off  |
| ------------------------------| ---------| ---------| ----------------| -----------|
| the truth's own timings      | +122 ms | 102 ms  | 74.7%          | 0/75      |
| spread evenly (untimed text) | +846 ms | 3714 ms | 1.3%           | **57/75** |

A single accuracy number would average those into something describing neither.

**Bias and spread are reported separately throughout**, because they are differently fixable. A constant lag
is correctable downstream — core has `lyricsLeadMs` — whereas jitter around that lag is not correctable by
any single number.

---

## Results — `m1pro`, `tfr-flyaway`, input = the YouTube mix

`shifted +Xs` is the truth's own timings moved by a known amount: an LRC written for another master.
`exact` is the truth unchanged — a **stability control**, not an accuracy result (it feeds truth and scores
against truth, so a do-nothing aligner would score perfectly; its value is that a non-zero error there is
*damage*). `blind` is no timings at all.

| condition | bias | MAD | ±100 ms | ±250 ms | ±500 ms | ±1 s | >2 s off |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `exact` | +122 ms | 102 ms | 41.3% | 74.7% | 92.0% | 97.3% | 0/75 |
| `shifted +0.15s` | +291 ms | 121 ms | 0.0% | 42.7% | 84.0% | 96.0% | 0/75 |
| `shifted +0.25s` | +391 ms | 101 ms | 0.0% | 20.0% | 78.7% | 94.7% | 0/75 |
| `shifted +0.35s` | +471 ms | 101 ms | 0.0% | 0.0% | 57.3% | 89.3% | 0/75 |
| `shifted +0.50s` | +601 ms | 101 ms | 0.0% | 0.0% | 17.3% | 85.3% | 0/75 |
| `shifted +1.00s` | +1142 ms | 142 ms | 0.0% | 0.0% | 0.0% | 16.0% | 2/75 |
| `shifted +2.00s` | +2182 ms | 162 ms | 0.0% | 0.0% | 0.0% | 0.0% | 62/75 |
| `shifted +5.00s` | +5141 ms | 141 ms | 0.0% | 0.0% | 0.0% | 0.0% | 75/75 |
| `blind` | +844 ms | 3808 ms | 1.3% | 1.3% | 4.0% | 12.0% | 57/75 |

## Results — same song, input = the isolated vocals stem

Separated with `htdemucs` on MPS from the identical `youtube-mix.wav`, so the timeline is shared and the two
tables are directly comparable.

| condition | bias | MAD | ±100 ms | ±250 ms | ±500 ms | ±1 s | >2 s off |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `exact` | +101 ms | **81 ms** | 48.0% | 74.7% | 97.3% | 100.0% | 0/75 |
| `shifted +0.15s` | +191 ms | **41 ms** | 0.0% | 61.3% | 96.0% | 98.7% | 0/75 |
| `shifted +0.25s` | +291 ms | **41 ms** | 0.0% | 25.3% | 90.7% | 98.7% | 0/75 |
| `shifted +0.35s` | +391 ms | **41 ms** | 0.0% | 0.0% | 81.3% | 97.3% | 0/75 |
| `shifted +0.50s` | +561 ms | 61 ms | 0.0% | 0.0% | 29.3% | 90.7% | 0/75 |
| `shifted +1.00s` | +1101 ms | 101 ms | 0.0% | 0.0% | 0.0% | 24.0% | 1/75 |
| `shifted +2.00s` | +2061 ms | 61 ms | 0.0% | 0.0% | 0.0% | 0.0% | 54/75 |
| `shifted +5.00s` | +5101 ms | 101 ms | 0.0% | 0.0% | 0.0% | 0.0% | 75/75 |
| `blind` | +510 ms | 4139 ms | 1.3% | 1.3% | 6.7% | 12.0% | 57/75 |

---

## Findings

### 1. Forced alignment does not correct an offset. It transmits it with unity gain.

The headline, and it is a straight-line fit rather than an impression:

```
mix     bias = 1.005 x offset + 131 ms     (max residual 41 ms over a 0..5 s sweep)
vocals  bias = 1.008 x offset +  59 ms     (max residual 42 ms)
```

A slope of 1.00 means **none of the offset is recovered** — not at 5 s, and not at 150 ms. The aligner is
internally precise while it does this: MAD stays at 41-162 ms across the whole sweep, so the output is a
confidently, uniformly misplaced document. That is the worst shape of wrong, because every
self-consistency check in `TimingReport` passes.

The intercept is the aligner's own lag on a correct sheet: **+131 ms on the mix, +59 ms on vocals.**

### 2. A SMALL offset is the dangerous case, because it falls below the worker's own correction floor

`place.MIN_SHIFT_SEC = 0.35` — a shift under 350 ms is refused as noise, on the reasoning that applying one
would jitter a text that was already right. But the damage well below that floor is already severe:

| sheet offset | lines within ±250 ms | vs a correct sheet |
| --- | --- | --- |
| 0 ms | 74.7% | — |
| 150 ms | 42.7% | **-32 points** |
| 250 ms | 20.0% | **-55 points** |
| 350 ms | 0.0% | -75 points |

So the band the worker deliberately ignores, 0-350 ms, is the band that costs three quarters of the
accuracy. The floor is not wrong in isolation — a wrong correction IS worse than none — but it means the
common case of a slightly-offset LRC gets no correction at all.

### 3. `RESHIFT` cannot help on the first attempt, by construction

`align_steps._placed` returns the text unchanged unless `req.reshift` AND `req.reference_starts` are both
present, and its own docstring says why: the reference "has to be measured on this recording to be worth
anything, and the only such series available is the previous attempt's output".

So the correction reference is **the output of an alignment that was itself misled by the wrong windows**.
Given finding 1, that output carries the full original offset — so the first retry is fitting against a
series with the same error it is trying to remove. Nothing here measures how often that converges; that is
the next experiment.

What is missing is an **independent** estimate of the sheet's offset, measured on the audio before the first
alignment. A cheap candidate that needs no model: vocal-activity onsets from the separated vocals stem,
cross-correlated against the sheet's line starts. This benchmark is the harness that would score it.

### 4. Aligning on the vocals stem roughly halves the jitter

MAD 41-101 ms against 101-162 ms on the mix, and 100% of lines within ±1 s on a correct sheet against
97.3%. It also reduces the inherent lag (+59 ms against +131 ms) and the gross-failure count at a 2 s
offset (54/75 against 62/75).

This **validates existing behaviour rather than asking for a change**: `align_steps._align_audio` already
prefers `vocals_key` and treats the mix as a `Knob.ALIGN_ON_MIX` fallback. The number to take from it is
that the fallback is a real quality step down, not an equivalent path.

### 5. An untimed sheet is not usable as word timing on this song

`blind` puts 57 of 75 lines more than 2 s from truth, with MAD near 4 s. `place.spread_over` distributes 75
lines evenly across 194 s, so line 0's window is 0.00-2.39 s for a line actually sung at 13.20 s — and
whisperx can only search inside the window it is given. The mechanism is finding 1 again, at its limit.

This is why an unsynced provider hit or an operator paste should not be expected to produce word timing
directly, and why `spread_over` exists only to stop whisperx raising `KeyError` on a segment with no
`start` rather than to produce a usable placement.

### 6. Core's `lyricsLeadMs` default of 0 does not compensate the aligner's own lag

`DEFAULT_LYRICS_LEAD_MS = 0` (`lyrics-engines.ts`, max 1500). The aligner is +131 ms late on the mix and
+59 ms on vocals even with a perfect sheet, and only 41-48% of lines land within ±100 ms. A non-zero
default in that region is defensible on this evidence — but it is ONE song on ONE aligner, so this is a
measurement to widen before it becomes a settings change.

---

## The fix, and what it measured

`domain/audio/activity.py`, applied in `align_steps._placed` before the first alignment.

**The idea:** the sheet's line spans say where singing is *expected*; the audio says where it *is*.
Cross-correlate the two envelopes and the peak lag is the offset. No model, no ASR pass — one
`np.correlate` over a ~10k-frame envelope, which is why it can run before every alignment rather than only
as a retry.

This is the independent reference `place.estimate_shift` always wanted. Its docstring asked for "a REFERENCE
series measured on this audio"; the only one available was the previous alignment's output, which carries the
error it is removing (finding 1), so a first attempt could not be corrected at all.

**Recovery, against the injected offset:**

| source | residual | envelope r |
| --- | --- | --- |
| vocals stem | **10–20 ms** (the 20 ms frame quantum) | 0.590–0.593 |
| full mix | 140–150 ms | 0.476–0.479 |
| a *different* song's sheet | — (refused) | −0.100, 0.178, 0.306 |

**End to end through the real aligner**, driving the worker's own `_placed()` — lines within ±250 ms:

| sheet offset | before | after |
| --- | --- | --- |
| 0 ms | 74.7% | 73.3% |
| 150 ms | 42.7% | **68.0%** |
| 250 ms | 20.0% | **68.0%** |
| 500 ms | 0.0% | **73.3%** |
| 1 s | 0.0% | **73.3%** |
| 2 s | 0.0% | **73.3%** |

Every offset is restored to the uncorrected-sheet ceiling of 74.7%. Applying a correction when none was
needed cost **one line out of 75**, which is the evidence that there is no need for a minimum-shift floor
here — `place.MIN_SHIFT_SEC = 0.35` was excluding the 0–350 ms band that does the most damage while
protecting against an estimator this accurate did not need protecting against.

### Two candidate confidence gates were measured and rejected

Both looked reasonable and neither discriminates, which is why the correlation at the chosen lag is the gate:

| gate | right song | wrong song | verdict |
| --- | --- | --- | --- |
| peak prominence | 1.04–1.07 | 1.03–1.08 (**shuffled sheet: 1.22**) | useless — populations overlap, and the worst input scored highest |
| onset agreement | 38.7–74.7% | 40.4–43.2% | useless — overlapping |
| **Pearson r at the lag** | **0.476–0.593** | **−0.100–0.306** | separates cleanly |

Prominence fails because a 75-line envelope is mostly "on", so the correlation is broad rather than peaked.
`MIN_CORRELATION = 0.40` sits between the two populations with the narrowest margin being 0.306 → 0.476 —
thin enough to state rather than bury, and calibrated on one correct song against two wrong sheets. Widen
that calibration before trusting it on material unlike this.

The asymmetry that makes a conservative threshold right: refusing a good fit costs the offset we already
live with, while accepting a bad one **moves a sheet that was correct**.

### What this does not fix

- **Per-line drift.** This fits one global offset (and no scale). A sheet whose tempo differs from the
  recording is improved but not corrected; `place.estimate_shift` fits a gentle scale for that reason and
  still runs afterwards as the reshift fallback.
- **The `blind` case.** An untimed sheet has no spans to correlate, so it gets nothing from this — it still
  goes through `spread_over` and still lands 57/75 lines more than 2 s out.
- **The sweep only injects a constant offset.** That is what an LRC for another master mostly is, but a real
  foreign sheet can also differ in line splits, and nothing here measures robustness to that.

## Reproducing

```bash
# ground truth (authored captions only; refuses a song without them)
uv run python docs/benchmarks/forced-alignment/scripts/truth.py tfr-flyaway

# the audio comes from the stem benchmark's fetcher — the same youtube-mix.wav
uv run python docs/benchmarks/stem-separation/scripts/prepare.py tfr-flyaway

# the sweep, on the mix
uv run python docs/benchmarks/forced-alignment/scripts/bench.py --song tfr-flyaway

# and on an isolated vocals stem, for the comparison in the second table
uv run python docs/benchmarks/forced-alignment/scripts/bench.py --song tfr-flyaway \
  --audio /path/to/vocals.wav
```

## Not yet measured

- **`tfr-mayday` and `tfr-chosen`.** Ground truth is built for both; only `tfr-flyaway` has been swept. One
  song cannot separate a property of the aligner from a property of this mix.
- **Whether the retry ladder converges.** Finding 3 says the first `RESHIFT` fits against a series carrying
  the error it is removing. Whether repeated attempts walk toward truth or sit still is unmeasured, and it is
  the most useful next run.
- **Word-level accuracy.** No human word timings exist in these caption tracks, so nothing here scores the
  karaoke ball's actual unit.
- **Any non-English song, and any aligner but wav2vec2 via whisperx.**
- **The proposed onset cross-correlation.** Suggested by finding 3, not implemented and not measured.


## The repair pipeline, measured (2026-09-26; vocals stem, authored-caption truth)

The shipped path is now: global decode → reconcile against claims → windowed re-decode of disputed lines
inside claim spans → ADOPT the claim's own timing where the re-decode heard nothing (edge-stuck at the
window or scoring ≥0.5 below the song's median line score). These rows came from `bench.py --global
--claims` when it re-ran R2 and adoption by hand. It now runs the shipped `time_text` (see "The test seams
under the bench" below).

| song | condition | ±250ms raw | ±250ms bias-corr | ±500ms raw | >2s |
| --- | --- | --- | --- | --- | --- |
| tfr-flyaway | blind global | 77.3% | 86.7% | 94.7% | 0 |
| tfr-flyaway | + claims repair + adopt | 82.7% | **96.0%** | **98.7%** | 0 |
| tfr-mayday  | blind global | 63.5% | 80.8% | 86.5% | 1 |
| tfr-mayday  | + claims repair + adopt | 76.9% | **94.2%** | **98.1%** | 0 |
| tfr-chosen  | blind global | 40.0% | 40.0% | 51.4% | 14 |
| tfr-chosen  | + claims repair + adopt | 62.9% | 62.9% | 80.0% | 0 |

Caveat stated plainly: in this benchmark the claims ARE the truth captions, so adopted lines score
perfectly by construction — the claims rows measure the repair machinery and upper-bound the
claims-present case, not blind accuracy. The blind rows are honest.

### What the misses are made of

- **Per-song bias, sign-flipping**: −147 ms (flyaway), +149 ms (mayday), +33 ms (chosen). The caption
  authors disagree with acoustic onsets by a per-song constant in DIFFERENT directions, so no global lead
  fixes it and part of every raw ±250 number is truth noise, not aligner error. (The old windowed-with-
  truth ceiling of 74.7% said the same thing.)
- **tfr-chosen's outro is not sung speech**: chopped, pitched vocal samples. wav2vec2's emissions are flat
  there; any forced path is arbitrary. Adoption is the correct behaviour — a human timing beats a decode
  that heard nothing. Its last caption line is an uploader credit that is never sung at all.
- **R3 (anchored re-decode of blind repeats) measured a NO-OP on all three songs**: re-decoding between
  anchors reproduces the global decode, because CTC monotonicity already confined the repeats to those
  gaps — the misbinding happens WITHIN the gap. Kept as a cheap guard; a real blind-repeat fix needs
  occurrence assignment (envelope-segmented phrases matched to lines), not another monotonic decode.
- **Onset-snap prototype (energy-rise within ±0.35 s) measured a net LOSS** (flyaway ±250 raw
  77.3→70.7) — snapping jumps to neighbouring onsets. Rejected.


## Wider truth: four real-world songs (2026-09-26; htdemucs vocals, authored captions, temp corpus)

Songs fetched fresh (not committed; `/tmp/encore-align-bench`): TheFatRat — Never Be Alone (the repeat-heavy
live F10 song), Imagine Dragons — Believer (SDH captions, all-caps, early-timed), Ed Sheeran — Shape of You
(SDH with `[RINGING SOUND]`-style effect annotations), Adele — Hello (6-minute video, spoken phone-call
intro, `(somber music)` annotations).

| song | blind ±250 raw/corr | blind >2s | claims+repair+adopt ±250 raw/corr | ±1000 raw | >2s |
| --- | --- | --- | --- | --- | --- |
| shape-of-you | 89.0% / 92.3% | 1 | 94.5% / 97.8% | 100% | 0 |
| believer | 13.9% / 69.4% | 4 | 33.3% / 68.1% | 100% | 0 |
| never-be-alone | 31.9% / 4.3% | 23 | 72.3% / 72.3% | 100% | 0 |
| hello | 40.5% / 45.9% | 28 | 77.0% / 77.0% | 98.6% | 0 |

- **0 gross errors with claims present, on all seven songs measured so far.** The R1 humility repair now
  fixes the F10 song (previously 23 gross blind) instead of deferring to the windowed engine.
- **Never-sung detection works on real SDH**: on shape-of-you it dropped exactly the three sound-effect
  captions (`[RINGING SOUND]`, `[HE GROANS]`) and the re-decode then cleared the one gross error
  (±250 raw 89.0 → 90.9, 0 gross). No false drops on believer or hello.
- shape-of-you blind at 89% ±250 shows the global decode's ceiling on clean material; the hard blind cases
  remain repeat-heavy songs (never-be-alone) and sparse-singing long videos (hello) — both fully repaired
  once any claim source exists, which in production is the common case (captions or LRCLIB).
- believer's raw-vs-corrected split (13.9 vs 69.4) is one +430 ms per-song caption bias: SDH captions lead
  the singing by convention. Not an aligner defect; not correctable blind.


## Hard material (2026-09-26; 5 more temp songs — 12 total)

Rap God (217 lines, extreme density), Bohemian Rhapsody (multi-section, choir), Can You Feel My Heart
(screamed), Numb (rock), bad guy (whispered vocals, skit intro).

| song | blind ±250 corr / >2s | claims+adopt ±250 / ±500 corr | >2s |
| --- | --- | --- | --- |
| rap-god | 70.5% / 2 | 87.6% / 93.5% | 0 |
| bohemian-rhapsody | 58.1% / 6 | 83.8% / 95.9% | 0 |
| feel-my-heart | 64.9% / 1 | 75.7% / 94.6% | 0 |
| bad-guy | 73.9% / 3 | 73.9% / 79.7% | 0 |
| numb | 31.4% / 0 | = blind (COARSE: graded, not repaired) | 0 |

Two guard designs measured and REJECTED before the fix landed:
- Wholesale envelope-fit revert: failed both directions (missed Numb's regression — envelope correlation
  is too smooth to see 0.5 s scatter — and wrongly reverted Bohemian Rhapsody's genuinely better repair).
- Per-line activity audit: rejected 18 GOOD repairs on never-be-alone — a misbound repeat sits on loud
  singing while its correct occurrence is quieter, so loudness cannot arbitrate occurrence.

The fix is upstream, in the DIAGNOSIS: a new `COARSE` reconcile verdict (≥70% of lines agree within 1.0 s
after offset/scale removal, though <50% agree finely) marks "same performance, sloppy timing on one side"
— it corroborates for grading but triggers NO repair. Numb lands there; truly-unrelated sheets still read
UNRELATED and repair as before.

**Bottom line across all 12 songs: 0 gross (>2 s) errors whenever any claim source exists.** wav2vec2
handled Eminem-density rap (blind MAD 132 ms) and screams fine; whispered vocals decode consistently but
~0.9 s late against captions (bias-corrected fine); the truly hard blind cases remain repeat-heavy songs
and stem-invisible outros.


## Research-grade truth: JamendoLyrics (2026-09-26; 20 English songs, MEASURED word + line onsets)

The caption-noise ceiling is now escapable. JamendoLyrics (MultiLang, CC-licensed) ships hand-MEASURED
line AND word onsets — the first word-level ground truth this benchmark has ever had, and the karaoke
ball's actual unit. Scored BLIND (global decode, no claims) on htdemucs vocals via
`bench.py --global --words truth-words.json`.

**Aggregate over 20 English songs (3990 aligned words, 643 lines):**

| unit | metric | value |
| --- | --- | --- |
| WORD | within ±100 ms | 69.5% |
| WORD | within ±250 ms | 89.8% |
| WORD | within ±300 ms (MIREX) | 91.1% |
| WORD | within ±500 ms | 93.7% |
| WORD | per-song median abs error | 53 ms (worst song 228 ms) |
| LINE | within ±250 ms (bias-corr) | 79.2% mean (min 45%, max 100%) |
| LINE | gross (>2 s) | 36 / 643 blind |

**This is the headline the caption benchmarks could not show:** against MEASURED truth the blind decode is
~50 ms median at the word level and clears the MIREX ±300 ms bar on 91% of words — the earlier "±250 ms
raw = 63–89%" numbers on YouTube captions were dominated by caption authoring jitter, not aligner error.
Cleanly-produced songs (JASON MILLER, Wordsmith, Slingshot Miracle) hit 99–100% within ±250 ms word;
the drag is a handful of sparse/gross-prone songs (Pure Mids, Kinematic, Avercage) whose blind >2 s lines
pull their AAE up (Pure Mids AAE 1950 ms from 6 gross lines out of 20) — exactly the class claims+repair
fixes, still to be run here.

Reproduce: `git clone https://github.com/f90/jamendolyrics`, then
`scripts/jamendo.py` builds `truth-lines.json` + `truth-words.json` per English song.


### With claims (line onsets as the LRC), same 20 songs

Feeding the measured LINE onsets back as claims (the production case: an LRC or captions exist) and running
the full repair+adopt pipeline:

- **0 gross (>2 s) lines across all 20 songs.** Line-onset MAD: median 31 ms, worst song 90 ms.
- Blind gross lines (36 total) all repaired: Avercage 6→0, Pure Mids 6→0, LUNABLIND 5→0, Kinematic
  MAD 396→12 ms.

This is where the `COARSE` verdict was refined: it must **grade** sub-second jitter (repairing it regresses
— Numb) yet still **repair** the grossly-displaced lines inside an otherwise-loose sheet (Avercage's 6 lines
sat seconds off). The rule is now: STRUCTURAL repairs every disputed line; COARSE repairs only lines whose
residual exceeds the 1.0 s coarse tolerance. Numb (all disagreements sub-second) still repairs nothing and
keeps its blind decode; Avercage's gross lines get anchored.


## The full corpus, shipped path (2026-09-27; 32 songs, end-to-end through `time_text`)

The final E2E measurement running the real `AlignStepsImpl.time_text` against every truth file we have:
20 jamendo (measured word+line onsets) plus 12 YouTube (authored captions).

- **1736 total lines, 25 gross (>2 s), 29/32 songs at zero gross.**
- **Weighted ±250 ms: 80.6%, ±500 ms: 88.7%, ±1 s: 96.9%.**
- Every gross line publishes at `low` confidence — verified no `high`-but-wrong lines survive on hello,
  the worst offender (previously had 3 gross-and-high, now 0).

Three songs that still have gross lines and why:
- **hello** (22 gross): 6-minute Adele video with a spoken phone-call intro then an outro of one-word
  ad-libs ("highs, highs" / "hello from the other side") — the LRC/captions disagree line-for-line with
  our decode (verdict `unrelated`, r=0.41), R1 humility doesn't fire (claim r ≈ our r), so the wrong
  positions publish with honest `low` confidence. A published-but-humble outcome, which is what a phone
  UI can display differently.
- **The_Rinn_-_Voices** (2 gross), **tfr-chosen** (1 gross): individual repeat-heavy hooks that
  R3/R4 could not fully anchor.

### Two ordering fixes discovered this pass

- **Repair order: evidence-first, then reconcile-driven.** R3 (blind repeats) and R4 (mix-witness) now
  run BEFORE R1/R2 so reconcile grades the cleaned decode. On tfr-chosen this promoted the verdict from
  `unrelated` to `structural`, unlocking R2's dispute repair — the same pipeline that previously left
  9 repeats at 2–12 s off now placed them correctly. **11 gross → 1** on tfr-chosen.
- **Gate the OR of blind and repaired fits.** The gate refuses only when both blind and repaired
  envelope fits fail, and passes on a high-correlation fit at any lag (the shape agrees; the lag is an
  offset, not wrong text). Both live-found regressions came from re-gating the repaired series:
  never-be-alone (R1 adopted claims 1.76 s off from real singing) and bohemian-rhapsody (adoption
  dropped the r below threshold). Both now publish correctly.


## Onset lead (2026-09-27; boundary refinement, measured on 5693 hand-timed words)

The decode starts **+41 ms late on every one of the 20 jamendo songs** — wav2vec2 emits a character a
frame or two after the sound begins — while word ENDS run 46 ms EARLY. So `generate` now pulls every char
span's start back by `ONSET_LEAD_SEC = 40 ms`, clamped at the previous span's end (starts only; a
translation would break the ends it fixed the starts with; the clamp preserves non-overlap and makes the
lead act exactly where the delay physically lives — onsets after gaps).

| metric (words vs measured truth) | before | after |
| --- | --- | --- |
| onset bias | +41 ms | **+4 ms** |
| within ±100 ms | 72.0% | **78.7%** |
| within ±150 ms | 82.7% | **85.7%** |
| within ±300 ms (MIREX) | 91.1% | 91.3% |

Energy-rise snapping was re-measured at word level against real word truth and REJECTED a second time
(73.7% at ±100 ms — worse than the constant lead; it jumps to neighbouring onsets). Line-level E2E across
the 32-song corpus: neutral-to-positive (±500 ms 88.7→89.3%, ±1 s 96.9→97.5%, still 29/32 songs at zero
gross).

> **Superseded in W4.** 16 of those 41 ms were the emission clock, not the model: `frame_sec` was derived
> as `duration / frames` and came out 0.020014 on every corpus song. On the exact 20 ms grid the raw decode
> is +25.3 ms late, not +41.2, and `ONSET_LEAD_SEC` is **30 ms**. See *The exact frame clock* at the end of
> this file.


## The E2E harness: `scripts/e2e.py`, the gate for alignment changes (2026-09-27)

The 32-song number above came from an uncommitted scratch script that fed truth in as the claims,
synthesised durations and ran the tfr songs on oracle stems (review M14). `scripts/e2e.py` replaces it
with a committed, production-shaped harness. Every alignment change from here on is accepted or rejected
on its output. It drives the **shipped** `AlignStepsImpl.time_text` (`--level time_text`): the real
never-sung drop, R3/R4/R1/R2 repairs, `_clamped`, envelope gate and grading, run on a vocals stem
separated from each song's mix, with that mix as R4's witness, real durations, and the worker `Config`
read from the environment (`Config.from_env`, so an `ENCORE_ALIGN_*` knob reaches the shipped code and
is recorded in `run.json` and the summary). `--level generate` is the raw global decode alone
(`bench.py --global --words`' path), so a decoder change can be told apart from a ladder change. The pure
half (corpus, claim modes, pairing, metrics, emissions cache) is `scripts/e2e_lib.py`, unit-tested
hermetically in `worker/tests/test_bench_e2e.py`.

    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/e2e.py            # truth,jit,blind
    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/e2e.py --modes all \
        --model HUBERT_ASR_LARGE --tag hubert-all          # tens of minutes: run with nohup, poll the log
    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/e2e.py --summarize <run>/rows.jsonl

- **Corpus**: `$ENCORE_BENCH_ROOT` (default `/Volumes/workplace/personal/encore-align-bench`): 20 English
  Jamendo songs (MEASURED word + line onsets), 9 YouTube songs (authored captions), plus the 3 tfr songs from
  `benchmark-songs/`. `--songs` takes slugs, slug prefixes or `jamendo` / `youtube`. Run one bench at a
  time: parallel runs thrash (~75 s against 3.4 s per song-mode).
- **tfr audio** (`--tfr-audio`). The default, `youtube`, is production-shaped: the worker's own input
  (`youtube-mix.wav`) as the mix and an htdemucs stem separated from it as the target, on the timeline the
  authored-caption truth was written against. `e2e.py --prepare-tfr` makes those stems once, through
  production's stems path (`separate.decode_argv`, then the shipped `MlxDemucs`, the engine and model of
  the corpus's other 29 stems), into `$ENCORE_BENCH_ROOT/<slug>/mix/vocals.wav`; about 14 s per song.
  `reference` is the producer's multitrack: the ORACLE vocals, with the stems' sum as the mix. The
  review's baseline ran on it, so it is kept only to reproduce the review. Measured over the 3 songs at
  `time_text`, `reference` → `youtube`: truth 1 → 4 gross, ±500 93.2 → 90.7%; blind 12 → 15, 85.1 →
  78.9%; drop20 10 → 20, 83.1 → 63.6%. The other 29 songs do not move: the two sweeps agree on them case
  for case.
- **Stemless** (`--no-stem`, W4). Every case runs as a song no stems job could separate: `vocals_path` is
  None, so the MIX is the align target, R4 has no second witness, `ALIGN_ON_MIX` is never offered and the
  LINE_SYNC rung declines — and a refusal is therefore terminal for the text. No corpus song lacks a stem, so
  this flag is the only way the mix's own decisions are measurable; it composes with every claim mode and with
  `--sync-mode`. A run records `target: mix` and that is SETUP (`e2e_gates.SETUP_META`), not an arm: these rows
  are not comparable with a stem baseline's metric for metric. See "The stemless mode" below for what it
  measured and what it recommends.
- **Claim modes** (combine with `+`, e.g. `jit+off15` or `blind+headers`; they apply in a fixed order):
  - `truth`, and `jit` (σ 0.3 s per line).
  - Offsets `off05 off1 off15 off3 off5 offm05 offm1 offm15 offm3`, and `tempo098` / `tempo102` (claims = truth × f).
  - `drop20` / `drop50`: a partial sheet, with lines removed from the text and its timings.
  - `extraverse`: 6 lines from another corpus song, placed in the largest claim-free gap.
  - `headers`: `[Chorus]`, `Verse 2:` and `CHORUS: …` per section. A whole-line header is claimed from at most
    1 s before its section to the section's start, never before the previous line's claimed end — and never
    inverted: where that end runs past the section start (12 of 233 headers, 8 songs), it is claimed AT the
    start. `credit`: a credit line claimed from 0 s to the first line.
  - `blind`: no timings. `wrongtext`: `--wrong-k` (10) seeded cross-pairs of another song's text and timings.
  - `wrongtext+ownclock` (W1 review r2): the same donors' WORDS on this song's own truth spans, line for line
    (a shorter donor repeats): a caption track of this very video in other words, as a translated or
    machine-translated `en` track is. Its timings describe the audio, so only a gate that reads the words
    can refuse it (`scripts/lift_gate.py`). `ownclock` alone is the identity. Not in `--modes all`;
    `--modes all,wrongtext+ownclock` runs both in one sweep (`all` expands beside other modes, W3).
    Measured on W1 after review round 2 (`results/w1-ownclock-{time_text,run_align}.json`, base model): forced
    mode publishes 280/320 at `time_text` and 279/320 at `run_align`, every one a word document at attempt 1
    past the envelope gate (verdict UNRELATED, no `high` line), none reaching the lexically gated LINE_SYNC
    rung: review H3's false pass, which only a lexical gate on the word document can close (W3).
    Measured on W3 (`results/w3-{time_text,run_align}.json`, the same sweep as `--modes all`): 0/320 at both
    levels, every one refused by the lexical gate at attempt 1 (lift max +0.148 time_text, +0.137 run_align).
  - NO `translated` mode (W3, checked): no honest one can be built offline. Every caption track in the bench
    root is English (`captions.en*.json3`, `tfr-*.authored.en.json3`), and JamendoLyrics MultiLang's 79 songs
    (20 English, 20 German, 20 Spanish, 19 French) are each sung and transcribed in one language, none with
    its lyrics in a second. A translation written for the bench would be the bench's own text, not an
    uploader's or YouTube's. `wrongtext+ownclock` stands in for a translation's arbitrary word order; what it
    cannot stand in for, a translation whose words keep the sung letters in order (cognates), is pinned on the
    CTC fixture as a known limit: German lifts +1.98 nats/letter where French reads -0.12
    (`test_lexical.test_a_cognate_heavy_translation_can_lift_where_another_language_does_not`), and through
    the LINE_SYNC rung it line-syncs (`test_align_steps.test_a_cognate_heavy_translation_on_this_videos_clock_line_syncs`).

  Every draw is seeded from crc32 of `--seed`, the song and the op, so it is stable across processes.
- **Metrics**, per mode, for Jamendo, YouTube(+tfr) and all:
  - The review harness's line definitions: published start minus truth start; gross is >2 s; ±500 ms and
    ±1 s (`pm500` / `pm1000`) are measured over scored lines of published docs; zero-gross songs; `high`
    lines >0.5 s and >2 s. Lines pair by IDENTITY (a hook records each published line's input index),
    never by text; a WORD-timed document the hook did not see is an ERROR row, not a silent fallback to
    text pairing. Lines with no truth counterpart are not scored.
  - The same counts over the TEXT (`text_pm500` / `text_pm1000`, printed `txt500`): over every truth line
    the claimed text contains, in every case, so a refused case's lines are misses. `missing` counts
    both a line the aligner dropped and a refused case's lines. The published-only figures reproduce the
    review; the text ones are what a reject-if uses wherever a refusal must not read as progress
    (marking hello and bad-guy refused under truth in the reference rows moves `pm500` 89.34 -> 94.04
    and gross 25 -> 3, while `text_pm500` falls 88.12 -> 85.11 and `missing` rises 24 -> 167).
  - `unsung` (W1 review r1): PUBLISHED lines that are no truth line — an injected header or credit, an
    extra verse, a sound caption the truth lacks, every line of a wrong text. No ±N metric scores them, so
    publishing them used to be free: W1's M6 first put back all 33 unsung lines its mix envelope spared,
    and the bench read no change. Baseline (`baseline-v2.json`): headers 219, extraverse 185, credit 28,
    0 in every other claim mode.
  - `bench.py --words` word definitions (Jamendo only): ±100/±250/±300, AAE, MedAE and bias over aligned
    words; PCO@0.3 over every truth word every case's text contains, a refused or ERROR case's included;
    words >2 s off. An inline header label pairs whether it published or a hygiene rule stripped it.
  - For `wrongtext`, the pass rate: the fraction of wrong-text pairs that publish, ERROR rows left out of
    the denominator (an ERROR is not a refusal).
  - A fault `time_text` catches itself is an ERROR row, not a refusal: a decline whose reason is a caught
    exception (`decode failed:`, `audio unreadable for the envelope:`, `re-decode after drop failed:`) at
    any attempt, a LINE_SYNC note (published OR refused) after a lexical check or, since W3, a timing
    decode that raised (`no lexical check: it raised`, W1 review r2; `no decode check: it raised`), a global
    verdict or envelope refusal after a lexical check that raised (W3), and any exception
    `BenchAligner.emissions` raised during the case — including one R4's
    mix witness swallows and publishes past. An MPS out-of-memory or a full disk under the cache used to
    score as a correctly refused wrong text. Since W1 (review M7) the shipped adapters type the
    machinery's faults (`adapters.ports.InfraFault`: a model that will not load, a gone kernel, a device
    fault, audio ffmpeg will not decode) and `time_text` raises them, so those are ERROR rows through the
    exception path; what still declines is a decoder refusing a text, a language with no model, and a
    fault nothing typed (this harness's own cache).
- **Output**: `<run>/rows.jsonl` holds raw per-line and per-word errors, so a summary can be recomputed.
  `<run>/summary.json` holds the metrics plus meta: git HEAD, harness digest, the worker-code fingerprint,
  the tfr audio, the `align_*` settings, the loaded model's identity, and how emissions were served.
  Every written document goes under `<run>/media/`. Each row carries the published document's digest
  (`doc_sha256`, the file the TV reads — less the worker's `sourceLines`, the whole text it records for a
  re-pick when a decode dropped lines, which the TV never reads), a digest of its line and word STARTS
  (`onsets_sha256`) and attempt 1's coverage, all kept per song for the `doc_changed` / `onsets_changed`
  gates. Since W1 review r1 a job's attempts are staged in job scratch (`work/{job}/lyrics/`) and placed in
  `derived/lyrics/` by `publish`: a `time_text` row's `ref` is the scratch file.
  Since W3 each row, and each `run_align` attempt, carries `lift`: the lexical lift the shipped gate read,
  at full precision (`capture_lifts`, a wrap that returns what `lexical.lift` returns; the trail prints three
  decimals since W3 review r2, so a refused +0.195 no longer reads `+0.20 ... below the lexical gate (0.2)`),
  None where the text was exempt, unmeasurable or the check raised. A LINE_SYNC attempt writes no
  `align-global` note, so its `verdict` reads `?`; its
  own note is `line_sync_verdict` / `line_sync_why` (the sheet fit, the lift, the decode's agreement), which
  W1 review r2 could read only through a scratch wrapper.
  `e2e.py --compact ROWS OUT` writes the committed per-case digest (`e2e_lib.compact_row`): what the scratch
  compactor kept, plus `lift` and the LINE_SYNC note, per case and per attempt.
- **Resume**: `--resume` continues an interrupted run only under the same settings AND the same code.
  Every row carries `code`, a digest of the imported `encore_worker` package plus the harness; this plan
  lands every wave uncommitted on one HEAD, so HEAD alone cannot tell two versions of `time_text` apart.
- **Emissions cache**: `$ENCORE_BENCH_ROOT/_emissions`, one `.npz` per (resolved path, size, mtime_ns,
  model, language, emitter fingerprint). The model part is `<label>@<identity>`, a digest of the class,
  dictionary and every weight the aligner LOADED (one model load per language per run), not the name the
  harness guessed. The fingerprint covers the emitting module (`adapters/ml.py`) and every worker module
  it imports, transitively and lazy imports included (10 files today), so a frame-grid helper ml.py calls
  moves the key too; the torch / torchaudio / whisperx / transformers versions and the PATH ffmpeg's build
  (it decodes and resamples every input); and the worker's `align_*` settings, so a default-off arm inside
  `emissions()` is never served its knob-off twin's matrices. A frame-clock change, a decoder upgrade or
  an arm cannot be scored on stale matrices. It is device-independent:
  MPS and CPU emissions measured identical. `--verify-cache` checks one song x mode with fresh and cached
  matrices. The documents were **byte-identical** on hello x truth (stem + mix witness) and on tfr-chosen
  x truth, including against an entry written by an earlier process, and again after the key change
  (fresh matrices, hello and tfr-chosen x truth, against the baseline run's documents).

**The results** (`results/`, base model, all 32 songs; code `98eb72d0` (the worker package plus the
harness after its review round 2), fresh matrices under the cache key above, 2026-09-27). Each result has
two files:
- `<name>.json`, the summary document `--compare` takes: pooled and per-song metrics, per-song document
  digests; `meta` records the run and, where it applies, `reproduction` or `gates`;
- `<name>.cases.jsonl`, one compact line per case: outcome, verdict, counts, digests, run_align's
  attempts. Do not pass it to `--compare`; a `.jsonl` there is re-summarized as raw rows.

| file | level, modes, tfr audio | role |
| --- | --- | --- |
| `baseline-v2.json` | `time_text`, `--modes all`, `youtube` | **the `--compare` base from W1 on** (production-shaped) |
| `baseline-v2-reference.json` | `time_text`, `--modes all`, `reference` | the review reproduction (below) |
| `baseline-v2-run_align.json` | `run_align`, `--modes all`, `youtube` | the job baseline, and the only level `clean.py` changes can move (W5 compares its headers, credit and extraverse rows here) |
| `baseline-v2-generate.json` | `generate`, blind, Jamendo | the raw-decode baseline |

The raw rows stay in the bench root (`meta.rows_full`).

**Reproduction of the review baseline** (`baseline-v2-reference.json`: `time_text`, `--tfr-audio
reference`, the review's oracle stems for the 3 tfr songs). `gates/w0-reproduce-time_text.yaml` and
`gates/w0-reproduce-generate.yaml` pass 11/11 each, with 0 ERROR rows. The re-run after the harness's review
round 1 matches the first measurement case for case on every field (768 cases) and byte for byte on every
published document (593); wrong-text outcomes are identical on all 320 pairs. The re-run after round 2
(worker code unchanged; `headers` claims never inverted) matches round 1 on 766/768 cases and 591/593
documents, on both audios. The other 2 are `headers` on 2 of the 8 songs whose claims moved: Ridgway (one
line's start moves 3e-14 s) and The_Rinn (the `Chorus:` word's score and syllables; one fewer
stem-invisible re-decode). No scored field moves. Every mode the review logged matches it
**song by song on every field** (verdict, scored, gross, ±500, ±1 s, high, high >0.5 s, high >2 s):

| mode | gross | ±500 | ±1 s | zero-gross songs | high >2 s |
| --- | --- | --- | --- | --- | --- |
| truth | 25 | 89.3% | 97.5% | 29 | 0 |
| jit, the review's draw (replayed, below) | 34 | 84.1% | 95.4% | 28 | 0 |
| off15 | 35 | 69.8% | 75.9% | 24 | 0 |
| offm1 | 33 | 77.7% | 96.5% | 29 | 0 |
| off3 | 440 | 69.0% | 73.5% | 1 | 5 |
| blind | 122 | 78.6% | 88.3% | 8 | 45 |

- **jit caveat.** The review seeded jit with the process-salted `hash(slug) & 0xffff`, so its jit row was one
  draw. The harness seeds from crc32 instead, so its own jit row is a different, repeatable draw: seed 0
  gives 48 / 82.9 / 94.5. Seeds 0–4 give gross 27–55, ±500 82.9–85.0 and ±1 s 94.3–95.9, and the review's
  34 / 84.1 / 95.4 sits inside that spread. On `youtube` audio, seeds 0–4 give gross 36–55, ±500
  82.8–84.2 and ±1 s 94.3–95.3 (seed 0: 50 / 83.1 / 94.5). The review's draw itself was RECOVERED for
  29/32 songs:
  - An adopted line carries its claim span verbatim, so each song's 16-bit seed is the one whose
    `random.Random(seed).gauss` sequence reproduces those spans. It is unique on every song that has one.
  - Replayed through this harness, those 29 songs give documents **byte-identical** to the review's
    (again on the review-round-1 code: 29/29).
  - With the review's rows for the other 3 (hello, The.madpix.project, tfr-chosen: no adopted line, and 2
    of the 3 grade every line `low`), the total is 34 / 84.1 / 95.4 exactly.
  - Scratch: `_runs/w0-bench/{recover_jit,replay_jit,replay_jit_r1}.py` in the bench root.
- **Blind Jamendo words.** Through `time_text` they read ±100 78.8 / ±250 90.5 / ±300 91.3, bias +4 ms,
  139/5693 words >2 s. The review's 78.7 / … / 141 is the `generate` level, which reads 78.73 / 90.46 /
  91.29, +3.7 ms and 141 here (`results/baseline-v2-generate.json`). The never-sung rule drops two
  Jamendo lines (Quentin_Hannappe "how many gonna stand", Ridgway "whoa oh oh oh oh", 9 words; raw decode
  puts the Ridgway line −40.25 s off) and re-decodes.
- **Ends and highlight** (`generate`, blind Jamendo): word end ±100 73.2, phrase-final end ±100 40.6 /
  ±250 73.6 / bias −106 ms, highlight 67.3%. These are `exp_ends.py`'s own numbers when it runs on the
  SHIPPED emissions. The review's 40.0 / 73.5 / −107 / 67.7 came from its own matrices (`/tmp/lr/em`: the
  raw torchaudio bundle over 30 s chunks with no context, up to ~10 nats per frame away from
  `WhisperXAligner.emissions`). On those matrices this scorer reads the review's figures exactly. Its §6b
  "end ±100 68.2" drops the onset-within-250-ms filter; ungated it reads 68.4 on the shipped emissions.
  The provenance is also in `gates/w0-reproduce-generate.yaml`.
- **Wrong text** (`time_text`, 10 donors per song): 153/320 publish (47.8%), 149/320 when the text arrives
  untimed (`wrongtext+blind`); on `youtube` audio 152/320 and 148/320. The review's 220/320 (H3) is a
  different measurement:
  - It gated the RAW decode with its `lsep` prototype (`|` between lines, numba Viterbi, its own matrices)
    on pairs i → i+1..i+10.
  - On those exact pairs, the same gate test over the shipped decode passes 140/320, and the shipped
    `time_text` passes 143/320 (agreeing on 317). All 32 right texts pass.
  - So on the shipped path "about half of wrong texts publish" holds, at 44–48%, not 69%. W3's gate
    calibrates against this.
- **Determinism and time.** A second full `--modes all` run (768 cases) in a fresh process gave identical
  rows in every field but wall time. The sweep reads 64 matrices, the 32 stems plus their 32 mixes (R4's
  witness). Cold it took 649 s: 56 computed, and 8 were already on disk from the smoke runs. Warm it takes
  432 s: all 64 from disk and 1249 calls from memory, about 0.56 s per case. After the cache-key change
  every matrix was recomputed once: `generate` computed the 20 Jamendo stems in 69 s, then the `youtube`
  sweep took 602 s (40 computed, 24 on disk), the `reference` sweep 455 s (4 computed: the oracle stems
  and their sums) and `run_align` 376 s (all 64 from disk). After round 2's key change (ml.py's import
  closure plus `align_config`), again: `generate` 69 s (20 computed), `youtube` 605 s (44 computed), `reference`
  456 s (6 computed) and `run_align --modes all` 571 s for 768 cases (all 64 from disk; wrongtext 261 s).

**The production-shaped baseline** (`baseline-v2.json`, `--tfr-audio youtube`), the base every wave from
W1 on compares against. The text columns count refusals as misses (`±500/text`, `missing`). Refused
right texts: drop20 1 (rap-god), drop50 6, credit 1 (never-be-alone), the same cases on both audios.

| mode | gross | ±500 | ±1 s | ±500/text | missing | zero-gross songs | high >2 s | `reference`: gross, ±500 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| truth | 28 | 89.1% | 97.3% | 87.9% | 24 | 29 | 0 | 25, 89.3% |
| jit | 50 | 83.1% | 94.5% | 81.9% | 24 | 26 | 0 | 48, 82.9% |
| off05 | 28 | 90.3% | 96.7% | 89.1% | 24 | 29 | 0 | 24, 90.7% |
| off15 | 38 | 69.5% | 75.9% | 68.6% | 24 | 23 | 0 | 35, 69.8% |
| off3 | 449 | 68.4% | 73.0% | 67.4% | 24 | 1 | 4 | 440, 69.0% |
| offm1 | 32 | 77.2% | 96.5% | 76.2% | 24 | 29 | 0 | 33, 77.7% |
| tempo098 | 251 | 71.1% | 79.1% | 70.1% | 24 | 4 | 6 | 249, 71.7% |
| tempo102 | 372 | 61.5% | 70.8% | 60.6% | 24 | 1 | 6 | 354, 63.7% |
| drop20 | 51 | 83.1% | 93.8% | 72.0% | 190 | 21 | 3 | 41, 85.2% |
| drop50 | 218 | 54.4% | 58.8% | 37.3% | 274 | 6 | 1 | 219, 54.9% |
| extraverse | 34 | 87.2% | 96.8% | 86.3% | 18 | 29 | 0 | 24, 88.3% |
| blind | 125 | 78.0% | 87.9% | 76.9% | 24 | 8 | 46 | 122, 78.6% |
| headers | 34 | 87.5% | 96.8% | 86.6% | 19 | 29 | 0 | 36, 87.5% |
| credit | 35 | 88.5% | 96.8% | 85.2% | 66 | 28 | 0 | 25, 89.0% |

Jamendo is the same on both audios. Truth words: ±300 95.3, PCO@0.3 85.1, bias +6 ms, 20 > 2 s, highlight
67.1%. Blind words: ±300 91.3, PCO@0.3 91.2, highlight 67.2%. The `headers` row is re-measured on the
never-inverted claims (12 of 233 headers moved, 8 songs). It reads the same on every column, on both audios,
because the moved headers are unscored lines and only 2 documents changed (above).

### The whole job: `--level run_align`

`--sync-mode lines` (W3) sends every job core's `syncMode: lines`, so each text's only attempt is the gated
LINE_SYNC rung (`Search.line_only`): the level that measures that rung's gate on every timed text rather
than on the few forced mode degrades to it. `run.json` and the meta record `sync_mode`; a lines run against a
forced baseline is a setup mismatch (an ERROR per gate that reads the baseline), and a baseline that records
none is `forced`, which every run before the option was. `forced` (the default) sends no `syncMode` at all.

`time_text` is one attempt. Production runs a JOB: `workflows.align.run_align` acquires the texts, walks
them with `Search` and `policy.decide`, retries with knobs, falls back to ASR and publishes. A retry can
replace a good document with a worse one, and one attempt cannot show that (review H2). `--level run_align`
runs the real workflow over `RecordingSteps`, an `AlignSteps` that delegates every call to the real
`AlignStepsImpl`. The harness owns only the PORTS below it:

- timed claims arrive as the upload's authored caption track (`captions:authored`), untimed ones as an
  LRCLIB plain sheet (`lrclib`), so production's own `fetch_*` builds the TextRefs (tier, label, timing).
  Both ports return `clean_segments(...)`, as every production text adapter does, so text hygiene in
  `clean.py` reaches the scores. This is the ONLY level where it does: `--level time_text` hands the claims
  over raw, as the review's harness did, and the shipped `time_text` cleans nothing itself, so a `clean.py`
  change (W5's header and credit stripping) reads the same there. Measure one here, against
  `baseline-v2-run_align.json`, which is recorded with `--modes all` so its headers, credit and extraverse
  rows exist. On the corpus's truth, `clean_line` changes 660 of 1760 lines (636
  YouTube lines lose `♪`; no Jamendo line changes its word count) and drops 14 (believer 1, shape-of-you
  1, bad-guy 10, tfr-chosen 2). A dropped line stays in `in_text`, so it counts as missing; each kept
  segment maps back to its claim for identity pairing, and a request whose segments are not the served
  claims is an ERROR row;
- the stem sits at the conventional `derived/stems/<id>-vocals.wav` key a stems job leaves;
- the probe returns the stem's duration, the same number the `time_text` level uses;
- there is no transcriber unless `--asr whisper` (the shipped `WhisperTranscriber` behind a disk cache in
  `$ENCORE_BENCH_ROOT/_transcripts`). ASR cannot move the claim-text metrics, because every candidate text is
  tried before ASR. It only decides how a refused case ends.

Each row records every attempt: knobs, the `align-global` verdict, coverage, per-attempt gross and ±500
lines, and the policy's decision. It also records which attempt published, the decision trail, and the
terminal (`published` / `no-lyrics`). `outcome` stays about the claim text. What is scored is the file at
the published ref AFTER the job returned, the one the TV reads. A stem attempt and its mix retry write
the same ref, so a job that publishes one attempt's record over another attempt's bytes is an ERROR row
(`published_file_attempt` names whose bytes the file holds). An ASR document published
after the claim text was refused counts as `refused`, because it has no identity to score, and it shows
under `published_label`. Every attempt's document is kept under `media/<song>/<mode>/attempts/`, because a
mix retry overwrites the stem document's ref in place. The summary adds a `policy:` line: retimes by knob,
`mix_published`, `changed_vs_first`, ASR asked/published, no-lyrics. Attempt 1 IS the `time_text` call.
It runs on the text the ports serve, so the document is the `time_text` level's only where cleaning left
the text alone. Over the 14 claim-text modes, 270 of the 277 Jamendo attempt-1 documents published under
claims are byte-identical. The other 7 are `extraverse` cases whose injected verse comes from a YouTube
donor, which cleaning changes. 123 of 163 YouTube documents differ, because cleaning removes `♪` tokens,
but only 1 of them scores differently.
Before cleaning, Kinematic truth and hello truth/blind were byte-identical.

First measurement (2 songs, base model, cached emissions): **Kinematic_-_Peyote under `truth` publishes NO
LYRICS**, although the `time_text` level publishes it with 0 gross (12/14 ±500):
1. The stem document's coverage is 71% (no words in the last 29% of the recording), so `decide` retries
   ALIGN_ON_MIX.
2. The envelope gate declines the mix attempt (blind r=0.03).
3. `NOTHING_TIMED` makes it LINE_SYNC.
4. The line document measures 0 words, so it cannot commit (M1), and the text is NextText'd.
5. With no ASR, the job gives up.

This is H2 and M1 compounding. It is what W1's "re-commit the previous pending doc" fix is for.

**The baseline: all 32 songs** (`results/baseline-v2-run_align.json`; base model, no ASR, `youtube`
audio, served text cleaned as production does; `--modes all`, 768 cases, 0 ERROR rows). Attempt 1
reproduces the `time_text` level (verdict, scored, gross, ±500, refused) on 764 of 768 cases. The other 4
are texts that lose lines to `clean_segments` (bad-guy 79 → 69, tfr-chosen 37 → 35). On 3 wrong texts with
those donors only the verdict moves. On tfr-chosen `off3` the 35-line text decodes `agree` and adopts the
+3 s claims (34 gross, 0/34 ±500), where the 37-line one decodes `unrelated` (10 gross, 16/34). The 6 modes
the first run_align baseline measured read the same on round 2's code, case for case (attempt wall time
aside) and byte for byte on all 914 documents; the other 9 modes are new. What the job adds is loss
(deltas against `baseline-v2.json`; where a song is lost its lines leave `gross` for `missing`, so the text
column is the one that shows it):

| mode | gross | ±500 | ±1 s | ±500/text | right text published | vs `time_text` |
| --- | --- | --- | --- | --- | --- | --- |
| truth | 41 | 88.6% | 96.8% | 86.7% | 31/32 | +13 gross, −0.5 pt (text −1.2), 1 song lost |
| jit | 62 | 81.4% | 93.4% | 66.2% | 29/32 | +12 gross, −1.7 pt (text −15.7), 3 songs lost |
| off05 | 41 | 91.0% | 96.2% | 85.3% | 30/32 | +13 gross, +0.7 pt (text −3.8), 2 songs lost |
| off15 | 47 | 65.4% | 74.7% | 41.7% | 23/32 | +9 gross, −4.2 pt (text −26.9), **9 songs lost** |
| off3 | 141 | 68.4% | 68.6% | 17.6% | 11/32 | −308 gross, ±0.0 pt (text −49.9), **21 songs lost** |
| offm1 | 45 | 77.0% | 95.9% | 75.3% | 31/32 | +13 gross, −0.3 pt (text −0.9), 1 song lost |
| tempo098 | 251 | 71.1% | 79.2% | 70.2% | 32/32 | ±0 gross, +0.1 pt (text +0.1) |
| tempo102 | 320 | 63.0% | 69.9% | 49.8% | 26/32 | −52 gross, +1.6 pt (text −10.8), 6 songs lost |
| drop20 | 51 | 83.3% | 93.8% | 70.5% | 29/32 | ±0 gross, +0.2 pt (text −1.4), 2 more songs lost |
| drop50 | 208 | 54.5% | 58.9% | 35.5% | 24/32 | −10 gross, +0.1 pt (text −1.8), 2 more songs lost |
| extraverse | 34 | 87.2% | 96.8% | 86.3% | 32/32 | ±0 (no retries) |
| blind | 132 | 77.5% | 87.4% | 76.4% | 32/32 | +7 gross, −0.5 pt (text −0.5) |
| headers | 25 | 85.1% | 96.6% | 51.4% | 23/32 | −9 gross, −2.4 pt (text −35.2), **9 songs lost** |
| credit | 47 | 87.0% | 95.7% | 73.0% | 30/32 | +12 gross, −1.5 pt (text −12.2), 1 more song lost |

Wrong text: 84/320 publish (26.2%) against 152/320 at `time_text`, but only because the job LOSES 68
published wrong texts through the same bugs. Every case that differs from `time_text` has one of three
shapes, each a W1 item (the one exception is tfr-chosen `off3` above):
1. **H2 swap, Pure_Mids in 12 modes.** Pure_Mids_-_The_Leader: the stem document has 70–78% coverage,
   so ALIGN_ON_MIX runs and publishes the mix document. Where the stem document had 0 gross (truth, jit,
   off05, off15, offm1, headers, credit), the mix one has 12–13 gross (±500 14–16/20 → 5–6/20; truth
   75→25%, the review's figure exactly). Under off3 and blind it goes from 6 gross to 13, and under drop50
   from 0 to 8 (8/10 → 1/10). Under tempo098/102 the stem document is already 13–14 gross and the mix one no worse. Kinematic's
   mix retry publishes only under headers (same scores) and credit (±500 8 → 13/14): the injected label
   lines move the envelope gate.
2. **H2 + M1, song dropped.** The mix retry is declined, the LINE_SYNC fallback measures 0 words and
   cannot commit, NextText, no lyrics. Cases: Kinematic in 9 modes (truth, jit, off05, off15, off3, offm1,
   tempo102, drop20, drop50), Pure_Mids drop20, and 5 wrong texts. ALIGN_ON_MIX fires on exactly the
   review's 2/32 songs, Pure_Mids and Kinematic, in every timed mode but two. Under tempo098 it fires on
   Pure_Mids only (Kinematic's document covers 100%). Under extraverse it fires on neither, because the
   injected verse fills the silent tail (coverage 84% / 80%).
3. **M2 + M1, song dropped.** An `_clamped` order inversion (1–28 out-of-order word starts) makes the
   report unusable, so LINE_SYNC runs, cannot commit, and NextText gives no lyrics. Cases: 20 songs
   under off3, 8 under off15 (Explosive_Ear_Candy, HILA, Ridgway, Rxbyn, The.madpix.project, rap-god,
   tfr-flyaway, tfr-mayday), 5 under tempo102, Tom_Orlando and rap-god under jit, believer under off05,
   never-be-alone under drop50, rap-god under credit, 63 wrong texts and **9 songs under headers**. The
   headers ones are all the same inversion. A whole-line label (`[Verse 1]`, `Chorus:`, `Verse 6:`) keeps
   its claim, which ends AT its section's start, while the section's first sung word decodes 0.1–0.8 s
   earlier: 1–4 inversions per song (Avercage, Ridgway, Rxbyn, Songwriterz, Wordsmith, hello, rap-god,
   bohemian-rhapsody, tfr-flyaway). `time_text` publishes those documents (0 gross on 8 of the 9). This
   is where W5's header stripping must show, next to W1's M2 fix.

   Against the first run_align baseline (`reference` audio, uncleaned text: truth 38 / 88.8 / 96.9, blind
   114 / 79.5 / 88.2, 30/32, wrong text 85/320), only the tfr audio and the text cleaning moved anything.
   The two blind songs that run lost now publish:
   - tfr-chosen blind (audio): the oracle stem's document had 77% coverage, so it went ALIGN_ON_MIX,
     declined, NextText (shape 2). The htdemucs stem's has 95%, and it publishes at attempt 1 with 10 gross.
   - believer blind (cleaning): it publishes with 4 gross, as at `time_text`. The cleaned text (72 lines,
     415 words) decodes with 0 out-of-order starts; the uncleaned one (559 words) had 1 (shape 3).
   - Wrong text: 3 pairs flip to published (2 with bad-guy's cleaned text as the donor, 1 on tfr-flyaway)
     and 4 to refused (3 on tfr-mayday, 1 on tfr-chosen).

   Consequence for W1/W3: `force_line_sync` writes the text's own line timings with NO gate, and the
   168 timed wrong texts the envelope gate refuses also retry as LINE_SYNC (`NOTHING_TIMED` is not
   `usable`). Once M1 lets a LINE_SYNC document commit, all 236 lost wrong texts would publish line-synced,
   i.e. 320/320. A gate refusal must therefore stay terminal for that text (NextText, not LINE_SYNC), and
   W1 measures `run_align` wrongtext against this row.

### Word ends, the TV highlight, intervals

- **Word ends** (Jamendo) use the review's `exp_ends.py` definitions: the end error of an aligned word
  whose onset is within 250 ms, reported as ±100 / ±250 / median bias over all such words and over
  phrase-final words (each truth line's last word, the only ends Jamendo really measures).
- **Highlight**: the fraction of sung time during which the lit word is the correct one. Sung time is the
  truth word spans of every line the text contains, in every case: a line the aligner dropped and a
  refused case light nothing. "Lit"
  comes from a Python port of the TV's own logic in `core/src/lib/tv/lyrics.ts` (parse, pause
  re-segmentation, `activeLineIndex`, `activeWordIndex`: start ≤ pos < end inside the active line). It is
  computed exactly on the breakpoints, with no time grid.
  - The port agrees with the TypeScript on 60,000 random positions over 300 random documents (0
    disagreements). The documents included misbound lines and long lines that re-segment. That one-off
    check is now COMMITTED: `scripts/tv_parity.py` writes a fixture from the port (24 documents — one per
    rule, then seeded random ones — their displayed rows and the lit word at 1,242 positions) into
    `core/tests/unit/lib/tv/`. `lyrics-bench-parity.test.ts` holds `lyrics.ts` and the overlay's
    word-level branch to it, and `test_bench_e2e` holds the port and the generator to it, so a TV change
    (W6) fails core's suite until the port follows. Mutations measured: always folding an orphan back
    (8 documents' rows move), dropping the coverage refusal (8 rows, 2 lit words), a closed word interval
    (281 lit words).
  - On the raw decode of Kinematic / Quentin_Hannappe / Ridgway it reads 65.1 / 79.3 / 60.7%, against the
    review's painted-span highlight at 65.1 / 79.2 / 60.8%.
  - The two definitions part only where the TV does something painting cannot see. A line misbound late
    stops `activeLineIndex`'s in-order scan, so nothing after it lights until playback reaches it.
  - A line-synced document lights no word and scores 0.
- **95% intervals**: a percentile song bootstrap (1000 resamples) for ±500, ±500 over the text, gross, word
  ±300, PCO@0.3 and highlight.
  The unit is the song: all of a wrong-text song's pairs move together. Each mode × group is seeded from
  crc32 of its name, so an interval does not move when other modes join a run.

### Compare and gates

    e2e.py --modes all --compare <base>/summary.json --gates my-wave.yaml     # after a run
    e2e.py --summarize <new>/rows.jsonl --compare <base> --gates my-wave.yaml # offline

`summary.json` carries per-song metrics (`e2e_lib.SONG_METRICS`) and document digests beside the pooled
ones. `--compare` prints every headline metric per mode × group as `run (Δ)`, plus the songs whose gross,
refusals or ERROR rows moved and the worst and best per-song ±500 / word ±300 / highlight change. The two
sides must share a measurement SETUP — level, seed, wrong-k, language, tfr audio and (at `run_align`) ASR:
where they differ, or either side does not record one, `--compare` warns and every gate that reads the
baseline is an ERROR. Measured on the committed files: the oracle-stem reference sweep against
`baseline-v2.json` passed `drop20.gross <= base.drop20.gross` as 41 <= 51, a gap the tfr audio alone
made, with the same 32 song names on both sides. The model, its loaded identity and the `align_*`
settings are what an arm varies, so they only warn, as does a side whose rows came from more than one
worker tree; the header names each side's code. `--summarize` and a `rows.jsonl` baseline take their
setup from the `run.json` beside the rows; a compact `.cases.jsonl` is refused.
`--gates` evaluates a wave's reject-if list. It exits 3 on any FAIL or ERROR, and 2 when the baseline or
the gate file cannot be read. The language is a restricted Python expression, walked with `ast` and never
`eval`'d. `scripts/e2e_gates.py` documents it in full. Each gate states the condition that must HOLD:

    truth-holds:    truth.pm500 >= base.truth.pm500 - 1.0           # pooled: [base.]MODE[.GROUP].METRIC
    jamendo-words:  min_song_delta(jamendo.word_pm300) >= -1.0      # worst per-song change, every mode
    no-new-gross:   count(song.gross_up + song.missing_up) == 0    # per-song: [MODE.][GROUP.]song.METRIC
    offsets:        mode("jit+off15").pm500 >= truth.pm500 - 2.0    # a `+` mode by name
    no-refusal-win: truth.text_pm500 >= base.truth.text_pm500 - 1.0 # a refusal is a miss here
    w1-stable:      count(song.doc_changed * (base.song.coverage >= 0.8)) == 0

`gross` counts published lines only, so `count(song.gross_up) == 0` alone passes on a song that flips to
refused or drops the line it got wrong; `missing` (text lines not scored) rises with either, hence the
sum. Every `retime_<knob>` exists at `run_align` (0 when unused), so W1's `truth.retime_align_on_mix == 0`
reads a number exactly when the fix works.

A gate that cannot be evaluated is an ERROR and rejects, never passes. That covers a missing mode, a metric
with no data, a `base.` reference without `--compare`, and no song in common; a run-vs-baseline comparison
over songs the run did not measure (per song, a pooled number over a different song set, or a reduction
of the baseline's per-song values such as `sum(base.song.gross)`); a baseline gate across another setup
(above); `delta()` of a per-song path; a song that LOST its value, in `min_song_delta`, `_up` / `_down` and
explicit arithmetic alike; and a reduction over per-song values some song has none for
(`min(truth.song.pm500)` with a refused song). Any ERROR row fails
the run through a built-in `no-error-rows` gate. `gates/` holds the W0 reproduction gates: the review
baseline at `time_text` and at `generate`.

**Time.** Per case, with warm emissions: 0.3–1.0 s at `time_text` (4 cases on 2 songs). At `run_align` it
is the same per attempt, and a case costs 1–3 attempts (Kinematic truth: 3 attempts, 1.7 s). The printout
ends with wall time per mode, which `summary.json` keeps as `meta.mode_seconds`. The first `run_align`
sweep also computes MIX emissions for every song the policy retries on the mix (once, then cached).

### The test seams under the bench (W0: review L7, L8)

- **`bench.py --global --claims` runs the shipped `time_text`.** It used to re-run R2 and adoption by hand
  (the two claims tables above came from that). The hand version had no never-sung drop, no R3/R4/R1, no
  clamping, gate or grading, and it crashed before its adoption row on a name it never defined
  (`merged_pre`). `--vocals` aligns on a stem with `--audio` as R4's mix witness. Measured on tfr-flyaway
  (base model, mix, truth claims): published, `structural`, 0 gross, ±500 89.3%. For the corpus sweep use
  `e2e.py`.
- **R3 is a no-op on the real kernel, measured again.** `bench.py --global --repair` on tfr-flyaway
  re-decoded 64 lines in 5 runs, and every row was identical to the global decode's. An exact Viterbi
  reproduces its own path between its own anchors. `worker/tests/test_align_v2.py` pins this as a
  property. A second test pins R3's effect when the global pass placed a repeat wrong inside its gap.
  Deleting R3 fails both tests; it left the old suite green.
- **The suite's fake decoder is the kernel.** `worker/tests/ctc_fixture.py` is a numpy CTC Viterbi with
  torchaudio's tie-breaking. It matched `forced_align` frame for frame on 300 randomized cases: sung
  windows, flat evidence and random log-softmax. `test_ml_contract.py` keeps 80 of them.
- **Repair faults are visible.** A window re-decode that raises still keeps its originals, but it is now a
  `repair-faults` trail note, and its count goes into the verdict note. e2e rows carry `repair_faults`.
  Measured: 0 on hello and tfr-chosen × truth/jit/blind.
- **Post-repair order is a property test** (`worker/tests/test_repair_order.py`: 32 seeded scenarios
  through `time_text`, one test per seed). Before W1, 4 of them (seeds 2, 6, 12, 30) publish backwards
  word starts, and each is one of M2's shapes. Only those 4 are `xfail(strict=True)`, until W1's
  `_clamped` fix flips them; the other 28 must hold now. Measured by mutation: with `_clamped` deleted,
  the first version (one strict xfail over all 32) stayed green, and this one fails 7 seeds.
- **R4 decodes the mix, pinned.** `test_align_v2`'s R4 test serves path-dependent emissions (the stem's
  matrix lacks the lost line, the mix's has it), decoded by `ctc_fixture`. Its first version served one
  flat matrix for both, so making R4 decode the STEM left the suite green (review r1: 994 passed); now
  that mutation publishes the line at 25.38-28.46 s against its sung 25.50-27.50 s and the test fails.
  `redecode`'s matrix is a required keyword at every stage.


## The lexical-lift wrong-text gate (W3, 2026-09-28; review §3 item 4, H3)

The global engine's envelope gate scores OUR OWN forced decode, and the audio pulls any text's decode onto
the voiced frames, so at W1 it passed 152/320 wrong texts and 280/320 same-video wrong words
(`wrongtext+ownclock`). The word document's text is now judged by `domain/lyrics/lexical.lift`: the text's
forced-path log-probability against the best of 3 crc32-seeded shuffles of its own words, per letter, on the
matrix the attempt decoded (4 CTC decodes, no model pass). `lexical.BANDS` holds the thresholds and their
full provenance; `scripts/lift_gate.py` is the calibration (`--target stem|mix`, `--model` for a re-run on
another model, `--from` to re-print), rows in `results/w3-lift-{stem,mix}.json`. Base model, shipped decoder,
832 texts per target (32 songs × 6 right texts + 10 wrong + 10 same-video wrong words), none under the
40-letter minimum (the shortest has 201):

**RE-READ ON W4's EXACT 20 ms CLOCK** (W4 review r1). Every lift is measured on an emission matrix and 6a
changed every matrix, so the recipe was re-run on the shipped tree: rows in `results/w4-lift-{stem,mix}.json`
(W3's are kept beside them as `w3-lift-*`, and `lift_gate.py --from <file>` re-prints either). No band had to
move — each stayed the same multiple of 0.05 — but every margin did, and the stem floor's head-room below the
wrong population is now **0.0082**, not the 0.011 W3 recorded.

| target | right texts (protected / drop50) min | wrong max (Jamendo / YouTube+tfr) | shipped |
| --- | --- | --- | --- |
| stem | +0.350 / +0.264 (Jamendo), +0.348 / +0.368 (YouTube+tfr) | +0.192 / +0.124 | refuse < 0.2, doubt < 0.3, ok |
| mix | -0.045 (truth median +0.66; 24/192 below 0) | +0.102 / +0.115 | refuse < 0.15, doubt < 0.6, ok |

- **Margins**, stem: the lowest right text (a drop50) keeps +0.064 over the 0.2 floor and the highest wrong
  text (Lower_Loveday × tfr-mayday, +0.1918, with Cortez × The.madpix.project +0.1874 behind it) sits 0.0082
  under it. Mix: the 0.15 floor clears both splits' wrong maxima by 0.035 and refuses 7 of the 32 truth texts.
- **Held out**, stem: τ fitted on Jamendo (+0.271) scores 0 errors on YouTube+tfr, τ fitted there (+0.236)
  0 on Jamendo. On the mix the populations overlap; the floor sits above both splits' wrong maxima.
- **Recalibrate PER MODEL AND PER TEXT NORMALISATION** (`lexical`'s own recipe; W3 review r2 added the second
  half). The bands are read off the texts `clean_segments` serves, and normalisation moves lifts by the same
  order a model change does: case by case between the bench's two levels — raw provider claims at `time_text`
  against cleaned ones at `run_align`, 1088 keys both sides — 302 cases move, median 0.022, p90 0.072, max
  0.147 (Kinematic `wrongtext+ownclock` #1), against the 0.0082 by which the stem floor clears the wrong
  population; one case crosses it (LUNABLIND #2, +0.232 raw / +0.172 cleaned). W3's rows read the same shape
  on the old clock (302 cases, median 0.026, max 0.153), which is the point: the clock moves every lift and
  moves this diff not at all. So W5's text hygiene owes this
  the reject-if a model change owes: re-run `lift_gate.py` for BOTH targets and re-read every threshold, or
  show case by case that no served text moved.
- **How it combines with the envelope gate on a stem**, case by case over the W1 time_text bench at τ 0.2:
  envelope alone 8/448 right cases refused (rap-god drop20, never-be-alone credit, 6 drop50), 152 + 280 wrong
  passed; **lift alone 0/448, 0 + 0**; both required 8/448, 0 + 0; either enough 0/448, 152 + 280. Only the
  lift alone meets the reject-if, so on a stem it REPLACES the envelope gate wherever it measured the text.
- **On the mix the lift reads how well the words are heard**: truth texts under 0.15 decode blind with a
  median 24% of lines within 1 s (numb 0/35; 172/237 lines over 2 s off), 0.15-0.6 a median 55% (140/343),
  above it 81% (149/1166), so the doubt band there is wide.
- **The mix floor REFUSES since W4 review r1** (W3 shipped it grading only). Its cost is real and is why W3
  hesitated: it refuses 48 of the 192 right mix texts (37 of the 160 protected, **7 of the 32 truth texts**:
  numb -0.045, Avercage -0.012, The_Rinn -0.010, Pure_Mids +0.027, feel-my-heart +0.038, Color_Out +0.117,
  Moon_I_Mean +0.127), a song with no stem has nothing after a refusal (NextText, and the rung declines the
  mix), and the "unheard decode" reading does not hold case by case (Moon_I_Mean's truth lifts +0.127 with
  69.8% of its blind lines within 1 s). What flipped it is that the gate it replaces loses MORE of the same
  and admits wrong texts as well: the envelope gate refuses 51 of the stemless mode's 128 right-text cases
  and 10 of its 32 truth texts, 9 of them above the floor, while passing 26 of 64 wrong texts (40.6%, against
  §3.4's 1%) — see "The stemless mode" below, which is the end-to-end measurement this decision rests on. Its
  measurable half sorts the mix badly case by case too (it passes numb's unheard decode, refuses Rxbyn's
  92%-within-1 s one; with the floor it refuses 114/192 right texts, the floor alone 48/192, both 0/640
  wrong). The controls are `h3-mix-envelope` (W3's default: the envelope gate alone, the floor grading) and
  `h3-mix-floor` (both gates, W3's first shipping).
- **Exempt**: the ASR tier, a text the lift cannot measure, and (W3 review r2) a matrix whose
  `Emissions.model` is not `lexical.BANDS.model` — the alignment bundle is chosen per LANGUAGE, so the
  English bands must not judge a German sheet on a German model's log-probabilities. All three keep the
  envelope gate; all but the ASR tier publish UNVOUCHED, since "no gate doubted these words" and "no gate
  read them" are different claims. A pin is never judged a wrong text (refused words publish graded low,
  `pin-unvouched`). A lift whose decode raised leaves the envelope gate and is an ERROR row
  (`e2e.FAULT_LEXICAL`).
- **What the doubt band withholds** (W3 review r1, narrowed by r2): the document publishes with every line
  `low` and the grade `medium` on either target, and ON A STEM its words are reported unvouched
  (`TimedDoc.vouched` -> core's `vouched: false`), so `isAuthoritativeText` is false and `lyricsRank` puts it
  under a document a gate passed instead of tying with one at the top rank. `timingConfidence` could not
  carry that (core's ranking never reads it) and `textConfidence` could not either: core reads `captions` +
  `low` as "Auto captions", so the doubt would have relabelled an uploader's hand-authored track as
  machine-generated. ON THE MIX the band only GRADES — `mix_ok_from` was fitted to how audible the words are
  and holds 104 of the 192 right mix texts (15 of the 32 truth texts), so stripping their standing would
  demote most correct sheets of every stemless song; there only a sub-floor lift publishes unvouched. An
  unvouched PIN is sent the same way, beside a pin's usual `textConfidence: high`. AND IT ENDS THE LADDER: a
  doubted document is `usable`, so the search commits and no remaining candidate is timed — the demotion
  works across JOBS (an earlier align's candidate, a person's re-run), not against a rival of its own run.
- **NOT COVERED, and unmeasurable on this corpus**: a translation whose words share the sung ones' letters in
  order. On the CTC fixture a German cognate text lifts +1.98 where a French one reads -0.12 (sung words
  +15.2), and no band separates that on either target; on the global path such a text would publish as a
  WORD document with `high` lines. Every caption track under the bench root is `en` and JamendoLyrics
  MultiLang gives each song one language, so `wrongtext+ownclock` stands in for a translation's word ORDER
  only. Pinned in `test_lexical.py` / `test_lexical_gate.py` (both engines).
- **Redraw noise** (`_runs/w3-rejudge/seed_probe.py`): the reference is ONE seeded draw of 3 shuffles, and a
  redraw moves a text by an SD of 0.03-0.07 nats/letter — the scale of the 0.011 the stem floor clears the
  wrong population by. Per redraw ~0.6 of the 640 wrong texts would pass (LUNABLIND #2 44%, Cortez #1 7%,
  its ownclock #4 9%, the rest <= 2%) = ~0.1%, inside the reject-if's 1% but not the 0 one draw reads; a
  drop50 right text would be refused with P 5-31%, a protected one never (p05 >= +0.268). Narrowing it
  (more shuffles, or the mean of the shuffles instead of the best) moves every number here, so it belongs to
  a recalibration and its reject-if, not to a live tree (`lexical`'s PER MODEL).
- **Targeted probe** (`time_text`, rap-god + never-be-alone × truth / drop20 / credit / blind + 20 wrong + 20
  same-video wrong): the 2 protected right texts the envelope refused now publish (rap-god drop20 0 gross,
  158/174 within ±500 ms; never-be-alone credit 0 gross, 38/46), the other 6 right documents are
  byte-identical to W1's, and 40/40 wrong texts are refused (W1: 11 published).
- **The corpus bench** (base model, warm emissions, `--modes all,wrongtext+ownclock` at both levels, against
  W1 as shipped; `results/w3-{time_text,run_align}.json`, `gates/w3.yaml`): every document W1 published is
  BYTE-IDENTICAL at both levels (time_text 440/440 right-text cases, run_align 409/409: not even a
  confidence moved), and no right text W1 published is refused. Wrong texts pass **1/320** at time_text
  (LUNABLIND #2, lift +0.217 on its raw claims, in the doubt band: 0 `high` lines, document `medium`) and
  **0/320** at run_align (+0.189 on the cleaned text; W1 152 and 89) — the level difference is the raw claims
  `time_text` serves, which `letters_of` counts too (`♪`, the lines `clean_segments` drops: 230 of the 832
  texts move by up to ±0.15; case by case against the bench's own two levels, 302 of 1088 move, median 0.026,
  p90 0.069, max 0.153) — same-video wrong words **0/320** at
  both (W1 280 and 279), each refused at attempt 1, none reaching the LINE_SYNC rung (W1: 63 did). PER LEVEL,
  each count is capped at the level it was measured on (W3 review r2): `gates/w3.yaml` serves both levels, so
  its `wrongtext-pass-at-most-measured` literal is `time_text`'s 1/320 and at `run_align` a regression from 0
  to 1/320 would have cleared it (`-no-song-newly-publishing` could not see that either: 28 of 32 songs
  already published a wrong text there at W1). `gates/w3-run_align.yaml` holds that level's zero absolutely —
  W1's rows fail every one of these gates (47.5%, 29 songs; 27.81% and 89 published at run_align). Right-text
  lifts, lowest per mode: truth and every timing mode +0.47, headers +0.359, extraverse +0.320, credit
  +0.377, drop20 +0.438, drop50 +0.209 (numb) and +0.255 (Avercage), the only right texts in the doubt band.
  Recovered, because the lift replaced the envelope gate on the stem: rap-god drop20 (0 gross, 158/174 within
  ±500 ms), never-be-alone credit (0 gross, 38/45) and 6 drop50 texts at time_text (80 gross lines among
  them, all graded `low`: 0 `high` line over 0.5 s off). `gates/w1.yaml` against baseline-v2 now passes
  74/74 at time_text and 71/74 at run_align: W1's waived MUST `wrongtext-pass-not-up` passes (0/320 vs 84),
  and the three SHOULD `m2m1-recovered` left are off15 31, off3 29 and tempo102 27 of 32 (below).


## The LINE_SYNC rung's gate: the text's own decode reads its timings (W3, 2026-09-28)

The rung publishes a text's OWN line timings (placed by the stem's activity fit), so it answers two questions:
are these the words the stem sings (the lexical lift ≥ 0.2, W1 review r2), and are its lines claimed where
they are sung? At W1 the second was the sheet-span envelope gate (`_sheet_passes`: the claimed spans
correlated against the stem's activity), and under `syncMode=lines` it refused 107 of 320 right texts (truth
4/32: hello r 0.36, rap-god 0.21, bohemian-rhapsody 0.36, bad-guy 0.51). The lift decodes the text on the
stem's matrix anyway, so the rung now keeps that decode as lines (`generate`) and asks whether at least 50% of
them start within 1.0 s of their PLACED claim (`reconcile.as_claimed`: nothing removed, because the claims are
what publishes). `scripts/line_gate.py` measured every rule over every timed bench case on the base model's
stems (13 timed modes, 416 right texts, 640 wrong; `results/w3-line-gate.json`; a line document is good with
≥ 80% of its lines within 1 s of truth, bad under 50%):

| rule | good refused | bad published | right refused | gross lines shown | text ±500 |
| --- | --- | --- | --- | --- | --- |
| sheet gate + lift (W1) | 116/346 | 6/48 | 175/416 | 75 | 43.3% |
| lift alone | 0/346 | 48/48 | 0/416 | 1782 | 73.3% |
| **lift + decode agreement ≥ 0.5 (shipped)** | **28/346** | **0/48** | **88/416** | **47** | **69.0%** |
| lift + (sheet OR decode ≥ 0.5) | 15/346 | 6/48 | 68/416 | 106 | 70.0% |
| lift + decode ≥ 0.4 / ≥ 0.6 | 10 / 49 | 7 / 0 | 56 / 115 | 139 / 9 | 71.3 / 64.6% |

On W1's 10-mode lines set: right refused 107 → 32/320, 0 gross shown either way, text ±500 52.9 → 82.8%. Wrong
texts: 0/640 pass (the lift alone refuses all; the decode agreement alone would too: wrongtext max 0.26,
same-video wrong words 0.49). The refusals left are mostly right to make: sheets off 1.5–3 s that the envelope
cannot place (hello, rap-god, bohemian-rhapsody off15 / off3: every line off), 2% tempo errors (53 texts, 676
gross lines had they published), half a sheet missing (drop50: its decode strays into the gaps). The false
ones: never-be-alone (9 modes, 0.37–0.49; its blind decode is poor) and drop50. Where the decode cannot be read
(no emission matrix, a decode that raised, fewer than 3 lines paired, or — W3 review r2 —
`align_steps._LINE_SYNC_MIN_DECODED_SHARE` of the sheet's claimed lines not decoded, since the share's
denominator is the decoded lines alone and a mixed-script sheet decodes only its Latin ones) the sheet gate
decides as W1 shipped it, and the document goes out UNVOUCHED because nothing read its words. The envelope fit
still places the lines. Cost: one `generate` decode beside the lift's four — and only AFTER the lexical
verdict since r2, so a text the words' gate refuses pays for neither — plus the emission pass for every text
that reaches the rung (the sheet gate used to refuse about a third before it). Every decode reading in the
committed runs paired every claimed line, so the share changes no recorded row; `line_gate.py` now records
`pairs` and `claims` so a later run can re-read the threshold.

**Measured end to end on the corpus (the W3 bench).** Forced `run_align` (`results/w3-run_align.json`):
27 right texts W1 lost now publish (21 as line sync with 0 gross lines; off15 26 → 31, off3 20 → 29,
headers 28 → 32, jit 30 → 31, drop20 31 → 32, credit 30 → 32 of 32) and none W1 published is lost. One
recovery is a line document placed wrong: bad-guy off3, every line 0.72 s late (0/69 within ±500 ms, 69/69
within 1 s; the decode agreed 93% within the gate's 1 s). The 12 right texts still refused never fail on
the lift (+0.46..+3.60): 11 are word documents out of order at attempt 1 whose claims the decode disagrees
with (rap-god off15 / off3, hello and bohemian-rhapsody off3 at 0%; 5 tempo102 texts at 15-46%; HILA and
never-be-alone drop50 at 28% / 0%), and Tom_Orlando jit's line document runs backwards, as at W1.
`--sync-mode lines` (`results/w3-lines-run_align.json`; against W1's scratch probe `_runs/w1r2p-lines`, the
same 10 right modes): right texts published 211 → 287 of 320, 0 gross lines either way, text ±500 truth
69.9 → 90.6%, off15 34.3 → 69.9%, drop20 42.9 → 88.6%; wrong texts 0/640 both. It LOSES 11 documents W1's
rung published: never-be-alone in 7 modes (decode agreement 0.37-0.48; W1's documents had every line
0.76-0.82 s early, 0/47 within ±500 ms, except headers, 47/47) and 4 drop50 texts (Avercage, Color_Out,
Lower_Loveday, Quentin: agreement 0.28-0.48, W1's documents 100% within ±500 ms of the half they kept). The
new lines-mode modes: offm1 29/32 (0 gross), tempo098 5/32 and tempo102 6/32 (28 and 19 gross lines).

Those readings are the gate `gates/w3-lines.yaml` holds a later wave to (`--sync-mode lines --modes
all,wrongtext+ownclock`, 38/38 on this run). Its literals are absolute, because there is no earlier committed
lines run to `--compare` against — W1 measured the mode through a scratch probe, and a summary with no
`sync_mode` in its meta reads as `forced`, which `e2e_gates` refuses as a baseline for a lines run. What it
holds: wrong words never commit; a line document is never graded `high` (its timings are the sheet's, so
`_line_doc` writes every line `low`); no gross line in the eleven timed modes whose claims are on this
master's clock, with the two tempo modes capped at the 28 and 19 above, since a bounded scale in the claim
clock is W2's; the per-mode commit floors of the 211 → 287 recovery; and the text-denominator ±500 readings.
Run against W1's own probe rows it fails 13 of the 36, so the floors are not self-fulfilling.

Two gates were added by W3 review r2, for the blind spot the decode gate cannot see: a document uniformly
0.5–1.0 s late agrees with its OWN decode and passes, so 23 of the published song-modes have NO line within
±500 ms of truth and every line within 1 s (truth 2 — numb and bad-guy, whose claims ARE the truth — drop20 4,
headers 4, offm1 3, off05 / off15 / off3 / extraverse / credit 2 each). The cause is upstream of the gate:
`_placed_by` shifts the sheet by the activity fit (+0.72 s bad-guy, +0.62 numb) and the decode reads the
shifted claims as near, so both witnesses agree on the same misplacement — and the quality split above, which
reads ±1 s, counts all 23 as good. A lag term on the decode's own offset does not recover them and costs
accurate documents (`line_gate.py`'s `decode(0.5)+lag(L)` rule, measured there), so the fix belongs to W2's
claim clock, which applies a shift only where it beats no shift. `zero-pm500-documents-not-up` (≤ 23) and
`zero-pm500-truth-not-up` (≤ 2) hold the count meanwhile; the truth one fails at ≤ 1, so neither is vacuous.
(W2 took the count down to 13 and 1 by putting the rung's claims on our clock — the section after next.)

## The claim clock: the claims on OUR clock before anything reads them (W2, 2026-09-28; review §3 item 2, H1)

Every claim-window repair and every adoption in `_time_text_global` used to run in the CLAIM's raw clock:
`reconcile` fitted an offset and spent it only on choosing which COARSE lines to repair, fitted a scale and
never applied it, and R1 measured the claims' own envelope lag and kept only its correlation. So claims
1.5 s late published every line 1.5 s late and still passed the envelope gate at lag −1.50 s, and +3 s claims
produced 440 gross lines corpus-wide. `domain/lyrics/claimmap.py` now maps the claims once, before the first
`reconcile`, by a RANSAC-style vote over candidates the step already computes — no-shift, the claims' own
envelope lag (`activity.fit_shift` on `expected_envelope(claim spans)`), median(ours − claimed), and a
bounded Theil–Sen tempo (|scale − 1| ≤ 5%) — applying the winner only if it explains `max(2 lines, 5% of
pairs)` more paired lines than no-shift. One rebinding of `claimed` / `claim_windows`; the raw claims stay
for the trail, and the map's own offset is the fact about the SHEET that the verdict used to carry.

TARGETED PROBES, NOT A SWEEP (the corpus row is the wave's bench run). `--level time_text`, base model,
against `results/w3-time_text.json` per song — pooled deltas in those logs compare 4 or 2 songs against a
32-song base and mean nothing; the per-song ones are the measurement.

`_runs/w2-clock-jamendo` — 4 Jamendo songs with MEASURED word onsets (The_Rinn, Avercage, Pure_Mids,
Kinematic), per-song delta ranges over the 4:

| mode | line gross | lines ±500 ms | words ±300 ms |
| --- | --- | --- | --- |
| truth | 2 → 2 (no song up) | +0.00 on all four | +0.00 on all four |
| jit | unchanged | +0.00 .. +2.18 (The_Rinn) | −1.58 (Avercage) .. +0.00 |
| off15 | −1 (Avercage), none up | +5.00 .. +42.86 (Kinematic) | −0.28 .. +1.89 |
| off3 | −4, −4, −6, −15 | +5.00 .. +50.00 | −0.28 .. +14.37 |
| tempo102 | −4, −14, −24, −31 | +75.00 .. +95.65 | +61.73 .. +95.19 |

Truth mode is BYTE-IDENTICAL on three of the four (Avercage's document moves and scores identically), no
Jamendo song gains a gross line in any mode, and the tempo row is what the bounded scale buys: the sheet
that used to leave 4–31 lines over 2 s out now leaves none (Kinematic tempo102 words 93.8% within ±300 ms,
computed from its row — the summary has no `word_pm300` for it on either side).

`_runs/w2-clock-probe` — the two songs the review names as the cost, where truth is the CAPTION track:

| mode | believer ±500 | bad-guy ±500 | gross |
| --- | --- | --- | --- |
| truth | −4.16 (50 → 47 lines) | −10.14 (13 → 6 lines) | 0, unchanged |
| jit | +1.39 | −4.35 | 1 → 1 |
| off05 | +2.78 | −10.14 | 0 |
| off15 | +23.61 | +8.70 | believer −2 |
| off3 | +20.84 | +8.70 | believer −21, bad-guy −27 |
| offm1 | +16.67 | −4.34 | 0 |
| tempo098 | +18.06 | −10.14 | believer −9, bad-guy −9 |
| tempo102 | +20.84 | +1.45 | believer −15, bad-guy −16 |

Both regressions are the map siding with a MEASUREMENT against the metric's ruler, and on these songs the
ruler is the sheet: believer's SDH captions lead the singing by about 0.5 s (the map reads `tempo +0.50 s
scale 0.9987`, 52 of 72 lines explained against no-shift's 12) and bad-guy's decode sits 0.86 s later than
its captions (`decode-median +0.86 s`, 52 of 69 against 1). Where the map moves the claims the repairs then
adopt, and caption truth scores that as a loss by construction — which is why the Jamendo split above, with
measured onsets, is the honest read. bad-guy's 13 → 6 reproduces the review's own number for it exactly.
The lever not pulled: preferring the envelope candidate unless the median beats it by the margin would
protect bad-guy only if its claim-span envelope fit were the better estimate there, and it is not (its
blind envelope reads r = 0.33), so it would trade a measured cost for an unmeasured one.

`claimmap-piecewise` (change-point legs instead of one affine map) STAYS OFF, which is the critics'
measurement reproduced: over the 6 songs above × their modes (`_runs/w2-piecewise-jamendo`,
`_runs/w2-piecewise-yt`, each against the default run on the same tree), every mode is identical except
`jit`, where it moves two documents and both get worse — believer −1.39 pt within ±500 ms, Avercage −2.42 pt
±500 and −1.19 pt words ±300. A jitter-disputed run looks exactly like a step to a change-point fit, which
is the failure mode the review predicted (F2, a misbound repeat, has the same shape).

THE VOTE ALSO NEEDS A FLOOR, and it did not have one until review r1 (W2, 2026-09-29). The margin
(`max(2 lines, 5% of pairs)`) grades the GAIN over no-shift and never the winner's own quality, so on a sheet
our decode barely agrees with anywhere — a CORRECT sheet against a poor, systematically late decode, which is
never-be-alone's measured shape — four candidates all explaining almost nothing still leave one of them two
lines ahead, and that one moves every claim window. `claimmap.MIN_INLIER_SHARE` = 0.2 is the absolute gate, and
the number is read off the rows taken BEFORE it existed (`_runs/w2r-time_text/rows.jsonl`; the committed
`results/w2-time_text.*` is the row WITH the floor, so those four maps are no longer in it): of the 245 maps
applied over its 1088 `time_text` cases, exactly FOUR explain under a fifth of their pairs, and all four are
this failure — hello tempo102 `envelope-lag` 4/74 = 0.054 with 25 gross lines, hello tempo098 `decode-median`
6/74 = 0.081 with 31, numb drop50 `envelope-lag` 2/17 = 0.118 with 1 line of 17 within ±500 ms, and one
wrong-text sheet 2/35 = 0.057. The lowest map worth keeping sits clear of the floor at 11/45 = 0.244
(never-be-alone tempo098/102, 0 gross, 40 of 45 lines within ±500 ms). **0.2 therefore sits in an empty band,
0.118 to 0.244** — and the re-bench confirms it from the other side: with the floor on, 241 maps are applied
and the lowest share among them is 0.244. At the rung, where the band is wider and shares run higher, the floor
is inert on every right text (the lowest applied right-text share over the 1056 gate cases is 0.2432, 188 maps
applied either way, and re-measuring with the floor on changed no right-text row) and refuses 293 of the 402
maps applied to WRONG texts, which only makes that gate stricter. `reconcile` could not have caught any of it:
it re-fits its own median, so the verdict reads the same either way.

AND THE VOTE NEEDED A MODE, which is W4's one shipped regression and its fix (W4 review r1, 2026-09-29;
`claimmap` WHY THE MODE). A median is robust to a FEW wild lines and breaks down at 50% contamination, and a
song whose lines repeat is exactly where our blind decode misplaces half of them: on `never-be-alone` off3 the
44 differences are BIMODAL — 20 smeared 4–9 s away, 17 sitting on the sheet's real +3 s displacement, 3
absurd — so the median landed in the GAP at −3.73 s, explained 4 of 44, fell under the floor above, and every
window repair and adoption afterwards worked in a clock 3 s out (44 gross lines where w4-start had 0). The
exact grid did not cause it: it moved every decoded start by at most one frame, and a median sitting on the
boundary between a 20-line tail and a 17-line cluster moves by a cluster width when one line crosses. Two
candidates now join the vote, `decode-mode` and `tempo-mode` — the median of the densest `2 × tolerance`
window of the same differences, at scale 1 and at the fitted slope — which is RANSAC over the data instead of
over three summary statistics. The densest window reads −3.07 s and explains 17 of 44. MEASURED over the same
1088 `time_text` cases (`_runs/w4r1b-time_text` against `results/w4-time_text.*`): six song-modes change a
metric, all six `never-be-alone`, all six better (off3 gross 44 → 0 with 35 line starts within ±500 ms,
tempo098 44 → 0, tempo102 43 → 0, off15 7 → 0, offm1 and off05 gaining starts), pooled off3 47 → 3,
tempo098 48 → 4, tempo102 47 → 4, off15 10 → 3, and the other 1082 cases identical to the digit. Because this
candidate is CHOSEN by maximising the vote's own score it carries two floors of its own, and both are measured:
the window must be ISOLATED (widening it by a tolerance each side must gather fewer than the margin more
lines — a correctly timed 47-line sheet against a uniformly 0.4–3.0 s late decode hands the luckiest 0.5 s
slice 16 of 47, over the share floor, and would have moved every claim +2.62 s) and it must hold
`MIN_PAIRS` lines (a six-cue sheet's luckiest window holds 2, which is a third of its pairs).

**`MIN_PAIRS` is measured inert on the corpus** (rebench r2, `_runs/w4r2b-time_text` against
`_runs/w4r1b-time_text`, the same 1088 cases one fix apart): **1088 of 1088 documents are byte-identical in
`doc_sha256`** and every summary metric is equal to the digit. The floor is REACHED on five cases, where it
shortens the candidate list (6 → 4, 6 → 5, 4 → 3 twice, 3 → 2) — including the two where it removes the
WINNER, `never-be-alone` drop50 (`decode-mode −13.29 s` on 3 of 23 paired lines) and `LUNABLIND` wrongtext #2
(`decode-mode +21.30 s` on 4 of 35) — and in all five the vote was already declining to map, under the
inlier share or under the gain margin, so no claim time moves. On the corpus it is belt and braces; the
defect it fixes is a short sheet, and that is held hermetically
(`test_a_two_line_cluster_on_a_short_sheet_is_not_a_mode`).

THE LINE_SYNC RUNG TAKES THE SAME VOTE, in its own band — built after this section, measured in the next one.
Until then the rung placed its sheet with `_placed_by`'s unconditional activity shift (r ≥ 0.40 moved it,
whatever a vote would say), which is where the previous section's 23 zero-±500 documents come from and why 12
right texts were refused for a clock error their own decode could see.

## Reconcile robustness: the fit, the classes, and which lines a repair may touch (W2, 2026-09-28; review §3 item 11, M4 + M5)

`reconcile` graded a claim series with an UNBOUNDED endpoint span ratio (its `MAX_SCALE_DRIFT` was defined
and never applied) through as few as three pairs, and then asked `agreement == 1.0`: any sheet with one
stray stamp came out STRUCTURAL, so OFFSET was effectively unreachable and the caller re-decoded every line
the sheet's own jitter pushed past 250 ms. The review's statistics, reproduced as tests over seeded noise
(`tests/test_reconcile.py`, last section) and now the numbers this tree reads:

| the M4 statistic | before | now |
| --- | --- | --- |
| random 3-pair series (2000 seeded draws) | 1993 STRUCTURAL | 2000 UNRELATED, 0 lines disputed |
| ±1.5 s sheet, 150 ms jitter, 40 lines (2000 draws) | ~98% STRUCTURAL | 0 STRUCTURAL (1463 OFFSET, 535 COARSE, 2 DRIFT), 0 of 80 000 lines disputed |
| 2% tempo sheet, 50 lines, ±0.55 s jitter (repro s9) | 38/50 lines flagged gross | 0/50 (the pre-W2 formula on this tree: 37/50 at 1.02, 46/50 at 1.0417) |

What carries them: a bounded Theil–Sen fit shared with `claimmap` (`reconcile.theil_sen`, ONE
implementation, |scale − 1| ≤ 5%), `MIN_FITTED_PAIRS` = 5 before STRUCTURAL or COARSE, the AGREE / OFFSET /
DRIFT classes read off the residual DISTRIBUTION (≥ 90% inliers and a small MAD) instead of exact agreement,
STRUCTURAL narrowed to sheets whose minority disagrees by more than a PHRASE, and `LineJudgement`
carrying a MODEL residual beside the raw one. Which lines a caller may re-decode moved into
`Reconciliation.disputed`, one rule per class: STRUCTURAL disputes every uncorroborated line (the sheet is
tight, so 300 ms is real, and on repeated text the claim is the only occurrence-anchor), every other
corroborating class disputes only the lines more than a phrase from the FITTED model. The caller's old
COARSE rule thresholded the RAW residual against the fitted offset, which is where s9's 38 false flags came
from, and no class but STRUCTURAL and COARSE disputed anything, so a stray line in an otherwise perfect
sheet would have lost its repair the moment that sheet stopped being mislabelled STRUCTURAL.

M5, the truncating window: a claim carries an END only where the sheet gave one, and the reader defaults the
rest to `start + 1.0 s` — an LRC's last stamp, a stacked timestamp, a short caption cue. Cut to that, a
repair window cannot hold its line: the forced path compresses it or collapses onto the window's left edge,
`adopt_where_unheard` reads that as "heard nothing", and the claim's one-second span replaces a correct
measurement with its words spread evenly inside it. `claim_run` now holds the window open to the END of the
blind decode's own span for that line (only where the blind decode STARTS inside the padded cue — elsewhere
the two are competing hypotheses, not one span measured twice, and R1 fires exactly when the claims have
outvoted our decode), and a claim span too short to hold the line at `regenerate`'s own floor (2 emission
frames per alignable character) is not adopted at all: the repair is dropped, the measurement stands, and
the trail says which line and why. Both halves are pinned hermetically in
`tests/test_align_provenance.py` (M5 section), where removing the first publishes the closing line 2 s short
and removing the second publishes it 5.06 s from where it is sung.

AND THE HOLD-OPEN IS CAPPED AT THE NEXT CUE (review r1, W2 2026-09-29). Taking the blind end WHOLESALE trusts
it exactly where the blind decode is least trustworthy: R1 fires on an UNRELATED blind verdict, which is the
state in which a blind line is known to smear across its neighbours' frames — 7-10 s on tfr-chosen's credit
line, about 6 s a line on the bench harness's own rig — so a defaulted cue could buy a window tens of seconds
long, covering the following lines entirely, and a single-line forced decode in such a window lands wherever the
audio liked. The widening now stops where the PADDED window reaches the next claim's onset. Measured on a
fixture whose line is sung once at 12-15 s while a SUPERSTRING of its text is sung at 32-36 s and the blind
decode smears the line 12 → 34 s: uncapped it published 11.96-34.88 s (its end 19.88 s late) with 3 of 8 lines
gross, capped 11.96-14.96 s with none — and M5's own case (a 7 s smear whose neighbour is only a near
duplicate) is 11.96-14.96 s either way. THE CAP IS NOT A TEMPO CEILING, and that was measured too: over the
corpus's 1645 truth lines real singing runs down to 0.7-1.7 alignable characters a second (tfr-chosen holds
"You're the one" for 10 s, Pure_Mids "aw ah aw ah" for 6 s), so any characters-per-second ceiling tight enough
to refuse the smear above also truncates a held note. The next claim is EVIDENCE — the sheet's own statement
about where this line's slot ends — and the last cue has no next claim and therefore no cap: nothing follows it
to swallow. The window itself is now asserted as a window (a `regenerate` spy in `test_align_provenance`), which
is what the three refusals in `claim_run`'s docstring lacked: every one of them could be mutated green.

TARGETED PROBES, against THE CLAIM CLOCK'S OWN ROWS (the base that isolates this item; the corpus row is the
wave's bench run). `--level time_text`, base model:

`_runs/w2-recon-probe2` vs `_runs/w2-clock-jamendo` — Avercage (the song the COARSE gross-line branch was
measured on) and Kinematic (the tempo one) × truth / jit / off15 / off3 / tempo102: **all 10 documents
byte-identical**. The taxonomy change is action-neutral there, which is what §3.11's reject-if asks of the
unperturbed row.

`_runs/w2-recon-yt` vs `_runs/w2-clock-probe` — believer and bad-guy × truth / jit / off15 / tempo102:
believer identical in all four; bad-guy's three timed modes move, and only because the ladder's LAST
re-reconcile now reads COARSE where it read STRUCTURAL, so one fewer line is re-decoded inside its claim
window. truth and off15 publish the same onsets (one line keeps the blind decode that the window decode had
reproduced); tempo102 moves 4 lines — two better (0.90 → 0.64 s, 0.86 → 0.64 s), one worse (0.78 → 1.07 s),
one `high` at 0.54 s regraded `low` at 0.77 s — for ±500 unchanged, gross 0 → 0 and ±1 s −0.7 pt.

TWO THINGS THE TAXONOMY GOT WRONG, fixed in review r1 (W2, 2026-09-29), both about what a verdict makes the
CALLER do rather than what it is called:

* `MIN_FITTED_PAIRS` (5) kept STRUCTURAL and COARSE away from 3-4-pair sheets and dropped them through to
  UNRELATED — which is not the neutral fallthrough it looks like. UNRELATED is the ONE verdict that arms R1,
  the widest repair in the step: every claimed line re-decoded inside its claim window, some adopted outright.
  So the floor that exists to distrust four points was routing them to the most sweeping branch. `TOO_FEW_PAIRS`
  is now its own verdict — it confers nothing, disputes nothing and arms nothing, while grading still reads it
  as a disagreement, which only ever lowers a line's confidence. Measured as a property: 2000 random 3-pair and
  2000 random 4-pair series now reach no repair at all.
* the AGREE / OFFSET / DRIFT test was written as review M4 asked it — "≥ 90% inliers AND a small residual MAD"
  — and the second half could never fire. The residuals are taken against `median(ours − scale × claimed)`, so
  their median is 0 by construction and the MAD is exactly `median(|residual|)`; once 90% of them are inside
  `AGREE_TOLERANCE_SEC` (0.25 s) that median cannot exceed 0.25, let alone the 0.4 s band. 200 000 seeded series
  produced none in which the band could have refused a branch the share admitted, and mutating the 0.4 to 4.0
  left the whole suite green. The conjunct and its constant are gone, the docstrings no longer advertise a
  two-part test, and the implication is pinned as a property test so a future tolerance that broke it would have
  to say so.

An earlier draft of the dispute rule read the band off the sheet's own residual MAD (4 robust sigmas), which
is wrong for a reason worth recording: the residual spread is the JOINT precision of the two measurements,
and when OUR decode is the loose one a wide spread is not a reason to stop repairing against the sheet.
Measured before it was taken out (`_runs/w2-recon-probe`, the same two songs and modes as probe2): Kinematic
lost 3 of 14 lines within ±500 ms in truth mode and 4 in off15 / off3 (−21.4 and −28.6 pt on that song),
because 4 of its 7 disputed lines stopped being repaired. Avercage was unchanged there too, so the probe
pair is what caught it — a corpus run would have, four hours later.

## The rung's own claim clock: 12 refused right texts and 10 misplaced documents (W2, 2026-09-28; review H1)

The LINE_SYNC rung publishes the SHEET's timings, and until this pass it placed them by the activity fit
whenever `ShiftFit.usable` held (r ≥ 0.40) and by nothing else. That single rule paid twice: W3 measured 12
right texts REFUSED at `run_align` whose lift was +0.46…+3.60 — the words were right and only the clock was
wrong — and 23 published documents with NO line within ±500 ms of truth because the fit moved a sheet that was
already right. Both are now one call: `align_steps._line_sync_clock` runs the same `claimmap.consensus` vote
the global engine runs, over no-shift / the envelope lag the gate already measured / the rung's own blind
decode median / a bounded Theil–Sen tempo, and `_placed_by` applies the winner. Two deliberate differences
from the global call: candidates are scored in `_LINE_SYNC_NEAR_SEC` (1.0 s) rather than
`reconcile.AGREE_TOLERANCE_SEC`, because on this rung the reader of the map is that gate — "explained" has to
mean what the reader means by it, and a wide band is also the STRICTER map, since no-shift is harder to beat;
and the `claimmap-piecewise` arm stays the global engine's, a leg boundary here being a move in published
timings.

**Re-derived on the mapped claims** (`scripts/line_gate.py`, base model, 1056 cases, rows in
`results/w2-line-gate.json`; 13 timed modes, 416 right texts, 640 wrong). Both thresholds keep their values
and the share's reason gets stronger: the two populations, which OVERLAPPED under W3's placement (documents
under 50% within 1 s of truth read up to 0.49, good ones' p10 was 0.47), now SEPARATE — the 2 documents more
than 20% gross read 0.24 and 0.32, the other 414 read p10 0.54, median 0.86, p90 0.98 — so 0.5 sits inside the
gap instead of straddling it.

| share | right refused /416 | good refused /411 | bad shown /3 | gross shown | text ±500 |
| --- | --- | --- | --- | --- | --- |
| 0.3 | 5 | 4 | 2 | 44 | 92.0% |
| 0.4 | 11 | 9 | 1 | 6 | 91.4% |
| **0.5 (shipped)** | **33** | **29** | **0** | **0** | **89.5%** |
| 0.6 | 56 | 52 | 0 | 0 | 84.1% |
| 0.7 | 78 | 74 | 0 | 0 | 80.8% |

`--near 0.5` (the band moves BOTH readers, so the sweep is a second run: `_runs/w2-lines/near05.*`) refuses 49
of 416 instead of 33, 2 truth sheets instead of 1, text ±500 86.5%, gross 0 — all it buys is a wider margin on
the half of the gate that is not the verdict, so 1.0 s stays.

**What the clock bought, same rule and same decode** (that script's `placement` block, W3's placement → W2's):

| mode | refused /32 | text ±500 | gross | zero-±500 documents |
| --- | --- | --- | --- | --- |
| truth | 1 → 1 | 91.4 → 93.4% | 0 → 0 | 2 → 1 |
| off05 | 1 → 1 | 91.4 → 97.3% | 0 → 0 | 2 → 0 |
| off15 / off3 | 4 → 1 | 70.4 → 91.4% | 0 → 0 | 2 → 2 |
| offm1 | 3 → 1 | 70.4 → 91.4% | 0 → 0 | 3 → 2 |
| tempo098 | 27 → 3 | 4.4 → 87.1% | 28 → 0 | 0 → 1 |
| tempo102 | 26 → 3 | 4.7 → 87.1% | 19 → 0 | 0 → 1 |
| drop20 | 0 → 0 | 89.2 → 95.9% | 0 → 0 | 4 → 1 |
| drop50 | 17 → 17 | 54.7 → 54.7% | 0 → 0 | 0 → 0 |
| headers | 1 → 1 | 87.2 → 93.4% | 0 → 0 | 4 → 1 |
| **all 13 timed** | **88 → 33 of 416** | **69.0 → 89.5%** | **47 → 0** | **23 → 13** |

The refusal set is a strict SUBSET: 0 newly refused, 55 recovered, 53 of the 55 publishing a document at least
80% within ±500 ms. 188 of the 416 sheets are mapped (envelope-lag 110, tempo 65, decode-median 13); the other
228 keep their own timings, which is what the margin is for.

The `gross` column above read `0 → 0` on every row until **W2 review r2**: `placements`' gross was the one
column not keyed to the placement it was printing, so the W3 side summed the MAPPED placement's gross over the
documents W3's rule publishes. The corrected column is the two tempo modes' 28 and 19 — the same counts
`gates/w3-lines.yaml`'s `tempo098-gross-not-up` / `tempo102-gross-not-up` carry from the corpus run's own
rows, which is the independent reading that says the fix is right rather than merely different.

**What stays refused, with numbers rather than a looser gate.** never-be-alone in 12 of the 13 modes at
agreement 0.38–0.49 (0.04 under drop50): the repeat-heavy 47-line song whose blind decode misbinds its
choruses (review F2/F10). `line_gate`'s `near_fit` — the share a PERFECT offset would reach — is 0.15–0.45 on
every one of them, so no map in the band can lift it past 0.5; this is a decode problem, not a clock problem.
Dropping the share to 0.4 would publish 10 of its 12, SEVEN of them with 0 of 47 lines within ±500 ms, plus 6
gross lines elsewhere. Also refused: the 17 drop50 half-sheets (decode strays into the removed lines' gaps;
ALL 17 would have published an accurate document, the standing cost of this gate — corrected from 16 in review
r2, where re-deriving the breakdown from `results/w2-line-gate.json` gave 20 = 17 drop50 + never-be-alone under
`jit` and `extraverse` + hello `extraverse`), and hello / tfr-chosen
under the two tempo modes (0.24–0.40) — the only two documents left that would be more than 20% gross.

**The 13 misplaced documents that remain are one pair of songs**: bad-guy in 10 modes and numb in 3, where the
vote does not fail to help — it APPLIES the lag. On bad-guy's TRUTH sheet the envelope's +0.72 s explains 64 of
69 paired lines against no-shift's 53 and the decode agrees (0.93 near): both witnesses say the vocals are
~0.7 s later than the caption track claims, and that caption track is also this song's truth file. numb's
truth sheet is recovered (the truth count is 2 → 1). A lag term on `AsClaimed.offset_sec` still does not
recover them and still costs more than it buys (`decode(0.5)+lag(0.5)` on these rows: 46 refused instead of 33,
text ±500 87.1%, 13 more accurate documents refused, 0 gross lines gained).

**The wrong-text result rests on the LIFT, not on the agreement** — which has to be said out loud now, because
mapping a sheet onto our decode works for a WRONG sheet too: the same-video population's agreement rose from
max 0.49 to max 0.51, and one of the 320 (feel-my-heart #9, lift −0.05) now clears the timing half. The lexical
gate refuses all 640 at every share from 0.3 to 0.8, so the rung still publishes 0/640; the sheet gate alone
passed 278 of those 320.

**One more thing the rung refused, and no clock could fix it**: Tom_Orlando under `jit` came back with 1 of 72
claimed starts before the line ahead of it (sheet noise σ 0.3 s), so the line document read `out_of_order` 1
and `policy.decide` sent the whole text away — NO LYRICS for a song whose lift was +2.92 and whose document
had 63 of 72 lines within ±500 ms. `_in_claim_order` now holds such a start at its predecessor's (held, not
sorted: a claim is evidence about ITS line) and `_line_doc` carries the guarantee, so no line document can
publish a backwards highlight. It fires on 2 of the corpus's 1056 cases, both under `jit`.

**A STRAY STAMP ONLY** (review r1, W2 2026-09-29). The first version held every backwards start at the last kept
one and never advanced it, which turns one spuriously LATE stamp into a drag: a 12-line sheet whose second line
reads `[01:00.00]` for `[00:10.00]` came out with NINE lines sharing the instant 60.0 s, `out_of_order` 0 and
`usable` True — so `decide` committed a document that shows one line's text for 30 s while the rest are sung,
where W3 had DROPPED the sheet. An inversion is held only where the next claimed start recovers above the last
kept one (the stray is the single line, not everything after it) and only while the held share stays under
`_MAX_HELD_SHARE`; otherwise nothing is held, the inversions stay, and `measure.out_of_order` reaches `decide`
exactly as it did in W3 — with the trail saying which happened, since "found clean" and "could not be
normalised" are different facts. The held line's END is held too, at or after its predecessor's: a line that
shared its predecessor's start and ended BEFORE it was nested inside it, and core's `activeLineIndex` (the first
line whose bounds contain the playhead) can never light such a line while it is sung.

The stray rule and the cap are inert on everything measured, and that is PROVED from the rows rather than
assumed: the largest `held` over the 1056 committed gate cases is ONE (Tom_Orlando and never-be-alone, both
under `jit`), and a sheet the old rule held exactly once is one whose next claim recovered above the last kept
start — otherwise that line would have been held too and `held` would read 2. So both cases are strays under
the new rule and neither can reach the cap, and `unheld` is 0 in all 1056 of them. The re-bench then settled the
one thing left open here: the END rule does not move either document either. Tom_Orlando jit publishes a line
document at `run_align` in both sync modes and it is **byte-identical** to the pre-r1 row; never-be-alone jit is
refused under `--sync-mode lines` and takes the word path under `forced`, so `_line_doc` never runs on it. The
END hold is a hermetic pin with no corpus effect — which is the right outcome for a guard, and it is a
measurement now rather than a hope.

**End to end, targeted** (`--level run_align`, 5 songs × 4 modes, `_runs/w2-lines-probe`; the full corpus run
at both levels and `--sync-mode lines` is the bench runner's, against `gates/w2.yaml` and
`gates/w3-lines.yaml`). All five cases W3 refused now publish with 0 gross lines: rap-god off3 refused →
line-sync, 217 lines, 100.0% ±500; bohemian-rhapsody off3 → published at attempt 1, 95.8%; Tom_Orlando jit →
line-sync, 93.1%; believer tempo102 → line-sync, 100.0%; bohemian-rhapsody tempo102 → published, 95.8%. The
same probe shows something that is NOT this item's: believer and rap-god publish a WORD document under truth
claims in the W3 run and a LINE document here, because their attempt-1 word documents gained out-of-order
lines under the GLOBAL claim clock (0 → 1 and 0 → 4). The line documents are more accurate (47/72 → 72/72 and
192/217 → 217/217 within ±500 ms) but carry no word timings, so the corpus run has to price it.

## The W2 corpus row: what the sweep accepted, what it rejected, and the arm it forced (W2 bench 2026-09-28, re-measured after review r1 on 2026-09-29)

The three items above — the claim clock, reconcile's fit and verdicts, the rung's own clock — were built on
targeted probes. This is the corpus run that prices them, and the only thing that accepts or rejects them.

> **RE-MEASURED 2026-09-29 after review round 1.** The rows below are the post-r1 tree's; the pre-r1 rows they
> replace are in `_runs/w2r-{time_text,run_align}/` and the pre-r1 arm rows in `results/w2-m5arm-*`. What r1
> moved is priced in "What review r1's fixes bought" below: 6 documents at `time_text`, 5 at `run_align`, 0 at
> `--sync-mode lines`, every one neutral or better, and one MUST failure retired.

Base model, youtube tfr audio, seed 0, `wrong_k` 10, emissions all disk hits, 1088 cases per sweep, 0 ERROR
rows. Three sweeps, 13–15 min each, plus two probes and `line_gate.py`'s 1056 rows — 51 min end to end
(`_runs/w2-rebench/{bench.sh,status}`, logs `_runs/logs/w2r1-*`):

```
cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/e2e.py --level time_text \
    --modes all,wrongtext+ownclock --compare ../docs/benchmarks/forced-alignment/results/w3-time_text.json \
    --gates ../docs/benchmarks/forced-alignment/gates/w2.yaml            # 83/85
… --level run_align  --modes all,wrongtext+ownclock --compare …/w3-run_align.json --gates …/w2.yaml  # 82/85
… --level run_align --sync-mode lines --modes all,wrongtext+ownclock --gates …/w3-lines.yaml         # 38/38
PYTHONPATH=…/w2-rebench/noclock … --level time_text --modes truth,drop50,off3   # §3.11 isolated: -0.52 pt
ENCORE_ALIGN_EXPERIMENTS=claimmap-piecewise … --songs <the 6 probe songs>       # arm: 0 documents differ
```

Rows: `results/w2-{time_text,run_align,lines-run_align}.{json,cases.jsonl}`, the isolating probe
`results/w2-noclock-time_text.*`, the arm probe `results/w2-pwarm-time_text.*`, and the pre-r1 arm rows this
section explains, `results/w2-m5arm-{time_text,run_align}.*`. Per mode, W3 → **W2**, text-denominator ±500 ms
(a refused case's lines counted as misses) and line gross (> 2 s):

| mode | time_text ±500/text | time_text gross | run_align ±500/text | run_align gross | run_align committed/32 |
| --- | --- | --- | --- | --- | --- |
| truth | 87.9 → **86.7** | 28 → **28** | 87.9 → **88.1** | 28 → **28** | 32 → **32** |
| jit | 81.9 → **82.2** | 50 → **51** | 78.4 → **82.4** | 49 → **50** | 31 → **32** |
| off05 | 89.1 → **87.3** | 28 → **28** | 90.6 → **88.7** | 28 → **28** | 32 → **32** |
| off15 | 68.6 → **87.2** | 38 → **28** | 64.4 → **88.6** | 34 → **28** | 31 → **32** |
| off3 | 67.4 → **87.2** | 449 → **28** | 64.3 → **88.6** | 138 → **28** | 29 → **32** |
| offm1 | 76.2 → **87.2** | 32 → **28** | 76.2 → **88.6** | 32 → **28** | 32 → **32** |
| tempo098 | 70.1 → **87.2** | 251 → **27** | 70.1 → **88.6** | 251 → **27** | 32 → **32** |
| tempo102 | 60.6 → **87.0** | 372 → **28** | 49.6 → **88.4** | 325 → **28** | 27 → **32** |
| drop20 | 83.1 → **82.2** | 51 → **52** | 84.3 → **85.1** | 51 → **47** | 32 → **32** |
| drop50 | 51.0 → **50.7** | 298 → **300** | 52.7 → **49.5** | 254 → **254** | 30 → **30** |
| extraverse | 86.3 → **84.8** | 34 → **35** | 86.3 → **85.3** | 34 → **35** | 32 → **32** |
| headers | 86.6 → **85.6** | 34 → **35** | 90.6 → **91.8** | 12 → **2** | 32 → **32** |
| credit | 87.3 → **85.6** | 35 → **36** | 87.8 → **85.6** | 35 → **36** | 32 → **32** |
| blind | 76.9 → **76.9** | 125 → **125** | 76.9 → **76.9** | 125 → **125** | 32 → **32** |
| wrongtext | 1/320 pass | 0 | 0/320 pass | 0 | — |
| wrongtext+ownclock | 0/320 pass | 0 | 0/320 pass | 0 | — |

So the map does what the review measured it for, on the corpus and at both levels: a sheet 1.5–3 s off or 2%
fast is now worth as much as a correct one (off3 87.2 against truth's 86.7 at time_text; 88.6 against 88.1 at
run_align), the 440-gross era is over (off3 449 → 28), `high` lines more than 2 s out stay 0 in every claim
mode, blind is byte-identical, and the wrong-text numbers are exactly W3's (1/320, 0/320, 0/320, 0/640) —
mapping a DONOR's claims onto our decode buys a wrong text nothing. At `run_align` **10 of the 12** right texts
W3 refused come back, and after review r1 with **no new refusal at all**: rap-god off15, rap-god / hello /
bohemian-rhapsody off3, Explosive_Ear_Candy / Rxbyn / bad-guy / bohemian-rhapsody published and believer
line-synced under tempo102, and Tom_Orlando jit's backwards document. The other two are drop50 half-sheets
(HILA, never-be-alone), refused in W3 and refused now — the item predicted exactly those. W1's four carried
`m2m1-recovered` SHOULDs read 32/32 (`gates/w2.yaml` section 10).

**The two songs the scratch claim-clock patch moved**, since the wave was asked to report them by name
(`time_text`, W3 → W2, line starts within ±500 ms):

| mode | believer | bad-guy |
| --- | --- | --- |
| truth | 69.5 → **65.3** (−4.2) | 18.8 → **8.7** (−10.1) |
| off05 | 62.5 → **65.3** (+2.8) | 18.8 → **8.7** (−10.1) |
| off15 | 41.7 → **65.3** (+23.6), gross 2 → 0 | 0.0 → **8.7** (+8.7) |
| off3 | 44.5 → **65.3** (+20.8), gross 21 → 0 | 0.0 → **8.7** (+8.7), gross 27 → 0 |
| offm1 | 48.6 → **65.3** (+16.7) | 13.0 → **8.7** (−4.3) |
| tempo098 | 47.2 → **65.3** (+18.1), gross 9 → 0 | 17.3 → **7.2** (−10.1), gross 9 → 0 |
| tempo102 | 44.5 → **65.3** (+20.8), gross 15 → 0 | 5.7 → **7.2** (+1.5), gross 16 → 0 |
| jit | 62.5 → **63.9** (+1.4) | 17.4 → **13.0** (−4.4) |
| blind | 55.6 → **55.6** (=) | 10.1 → **10.1** (=) |

Read the column, not the row. After the map each song answers with ONE number whatever offset the mode
injected — believer 65.28 in seven of the eight claim modes, bad-guy 8.70 in five and 7.25 in the two tempo
rows; `jit`, which perturbs every line independently and so has no single clock to find, is the exception in
both. That is precisely what "the claims on OUR clock" means: the published document stops depending on the
sheet's clock error. Every gross line the two songs used to publish under a perturbed sheet is gone (believer
off3 21 → 0, tempo102 15 → 0, tempo098 9 → 0, off15 2 → 0; bad-guy off3 27 → 0, tempo102 16 → 0,
tempo098 9 → 0). The `truth` cell is the one mode where the sheet's error was zero and the caption file the
score is taken against IS that sheet, so moving the document off it can only read as a loss. That is the whole
shape of the failing MUST below.

**`--sync-mode lines`**, the rung's own row (`results/w2-lines-run_align.json`, 38/38 of `gates/w3-lines.yaml`,
whose floors were W3's): committed over the 13 timed modes 327 → 383 of 416, right texts refused 89 → 33 — a
strict subset, 0 newly refused — gross lines 0 either way, tempo098 5 → 29 and tempo102 6 → 29 committed with
their 28 and 19 gross lines gone, zero-±500 documents 23 → 13, truth ±500/text 90.6 → 92.6, off15 69.9 → 90.6,
drop20 88.6 → 95.3, wrong texts 0/640. What stays refused is what the item predicted: never-be-alone in 12 of
13 modes (its blind decode misbinds its own choruses, so no offset reaches the agreement floor), hello in 3,
tfr-chosen in 2, and the 17 drop50 half-sheets. Re-measured after review r1: **0 documents changed** — the
stray-only `_in_claim_order` rule, the held ENDS and the rung's clock under `MIN_INLIER_SHARE` are all inert on
this corpus, and every number in this paragraph is the same to the digit.

**What review r1's fixes bought**, since the four movers its staleness note predicted had never been priced.
Six documents change at `time_text` and five at `run_align`; every one is neutral or better, and the truth row
does not move by a thousandth.

| what moved | where | effect |
| --- | --- | --- |
| `claimmap.MIN_INLIER_SHARE` refuses a 6/74 map | hello tempo098 | +9.5 pt ±500, gross 31 → 22; at `run_align` REFUSED → published, which retires the pre-r1 row's fourth MUST failure |
| …refuses a 4/74 map | hello tempo102 | +2.7 pt ±500, gross 25 → 23 |
| …refuses a 2/17 map | numb drop50 | document byte-identical — a guard with no corpus effect |
| …refuses 293 of 402 wrong-text maps | `line_gate.py`'s 1056 cases | 0 right-text rows changed; 188 applied right-text maps either way, lowest share 0.2432 |
| `claim_run`'s cap + `reconcile.TOO_FEW_PAIRS` | extraverse HILA, offm1 rap-god, headers shape-of-you, one wrong text | +1.7 pt, +0.5 pt, bytes only (every metric flat), — |
| `_in_claim_order`'s stray rule + held ends | the whole corpus | inert: `unheld` 0 in all 1056 gate cases, largest `held` 1 (Tom_Orlando jit, never-be-alone jit), and Tom_Orlando's published line document is byte-identical |
| `_monotonic` on leg boundaries | the `claimmap-piecewise` arm | the arm is now byte-identical to the default over 48 probe cases with no `legs` sentence on any trail — it used to move 2 documents, both worse, so there is no longer anything to switch on |

**What review r2's fixes moved: nothing measurable, probed rather than assumed.** Its three behavioural fixes
all touch published timings in principle — `claim_run`'s last-cue ceiling (the sheet's own median onset gap in
place of the missing next onset), `_in_claim_order`'s held END stretching `_REPAIRED_MIN_SEC` past its
predecessor's instead of equalling it, and `_enough_decoded`'s floor rising from 3 to `claimmap.MIN_PAIRS` so
the rung's gate and its clock abstain together. Measured against the committed rows by document digest
(`doc_sha256` + `onsets_sha256`):

| probe | scope | result |
| --- | --- | --- |
| `_runs/w2r2-probe-wide` | 32 songs × truth/off3/tempo102/drop50/jit, `time_text` | **160/160 byte-identical** |
| `_runs/w2r2-probe-wide-ra` | the same 160 cases at `run_align` | **160/160 byte-identical** |
| `_runs/w2r2-probe-lines` | Tom_Orlando + never-be-alone × truth/jit, `--sync-mode lines` | **4/4 byte-identical**, including both `held` cases — so the held-END stretch stays a hermetic pin with no corpus effect, exactly as r1's own row said of the held end |

Not probed: off05, off15, offm1, tempo098, drop20, extraverse, headers, credit and the two wrong-text modes.
`blind` cannot be reached by any of the three (no claims, so no `claim_run`, no `_in_claim_order`, no
`_enough_decoded`). A re-bench is still owed to read `gates/w2.yaml` — section 12 included — on the fixed tree.

### What failed, and the arm it forced

`truth-pm500` / `truth-text-pm500`: 89.11 → 87.90 and 87.90 → 86.70 at `time_text`, −1.21 pt against §3.2's
1.0 — a MUST, failed, and unchanged to the thousandth by review r1's fixes. It is now **explicitly waived**,
which is the third of the three answers PLAN-alignment-v3's 'Owner decisions' admits, with the numbers beside
the gate names in `gates/w2.yaml` section 1 and the reasoning at the end of this section.

The isolating probe now exists on the SHIPPED configuration (`results/w2-noclock-time_text.json`: this tree
with the map's one rebinding removed and `m5-adopt-floor` default-off, `--modes truth,drop50,off3`), so each
item's share of the row is a measurement rather than arithmetic across two trees:

| unperturbed row, time_text | `m5-adopt-floor` | ±500 | ±500/text | gross | Jamendo ±500 | YouTube ±500 |
| --- | --- | --- | --- | --- | --- | --- |
| W3 | — | 89.11 | 87.90 | 28 | 97.58 | 80.69 |
| + reconcile M4/M5 only (`results/w2-noclock-time_text.json`) | OFF | 88.59 | 87.39 | 28 | 97.34 | 79.89 |
| + the claim clock (shipped) | OFF | 87.90 | 86.70 | 28 | 97.34 | 78.51 |
| + reconcile M4/M5 only, PRE-r1 probe (`_runs/w2p-noclock-tt`) | ON | 87.67 | 86.48 | 29 | — | — |

So **§3.11's 0.3 pt bound, read at last on the shipped tree, fails by 0.22: reconcile's own cost is −0.52 pt**
(±500/text −0.51, and it gains no gross line; `drop50` is byte-identical at 51.50 / 298 and `off3` is +0.40 pt
with gross 449 → 436). The claim clock's own share is the remainder, **−0.69 pt**, inside §3.2's 1.0 on its
own. The −0.52 / −0.69 split this section used to report as an estimate is what the measurement says, to
0.01 pt — the two costs are additive.

Per song, the 1.21 pt is **nine songs of the 32**, and the probe assigns every one of them to exactly one item
(`truth` mode, line starts within ±500 ms; no song in the table gains a gross line, and the 23 not listed do
not move at all):

| song | split | W3 | reconcile only | shipped | Δ reconcile | Δ clock |
| --- | --- | --- | --- | --- | --- | --- |
| never-be-alone | youtube | 77.78 | 66.67 | 66.67 | **−11.11** | +0.00 |
| bad-guy | youtube | 18.84 | 18.84 | 8.70 | +0.00 | **−10.14** |
| believer | youtube | 69.44 | 69.44 | 65.28 | +0.00 | **−4.16** |
| shape-of-you | youtube | 98.86 | 95.45 | 95.45 | **−3.41** | +0.00 |
| tfr-chosen | youtube | 64.71 | 64.71 | 61.76 | +0.00 | **−2.95** |
| numb | youtube | 54.29 | 54.29 | 51.43 | +0.00 | **−2.86** |
| Explosive_Ear_Candy | jamendo | 100.00 | 97.83 | 97.83 | **−2.17** | +0.00 |
| Songwriterz | jamendo | 100.00 | 97.83 | 97.83 | **−2.17** | +0.00 |
| tfr-flyaway | youtube | 98.67 | 100.00 | 100.00 | **+1.33** | +0.00 |

No song is moved by both, which is why the two costs add. The clock's four are all caption-truth songs. The only
two Jamendo songs that move at all are reconcile's, one line of 46 each, off a starting 100.00 — the AGREE
sheet's stray line that the phrase-wide dispute band no longer re-decodes and adopts.

And the fourth and fifth columns of the row table are the finding that decides how to read both failures:
reconcile spends
−0.24 pt on the 20 Jamendo songs and −0.80 on the 12 YouTube ones, and **the claim clock costs the Jamendo
split nothing at all** (97.34 with it off and with it on) while taking YouTube a further −1.38. Jamendo is the
only split on this corpus with MEASURED word onsets, produced independently of any lyric sheet. The YouTube
truth file is a caption track — and in `truth` mode it is the very sheet the engine is handed as its claims, so
a line re-decoded inside its claim window lands on the claim and therefore on the "truth" by construction. The
whole 1.21 pt is paid on songs that score a correction against the thing being corrected.

Read against §3.11's 0.3 pt, the PRE-r1 probe's −1.44 pt was the larger failure, and 0.92 of it was ONE rule:
M5's floor refusing to adopt a claim span too short to hold its line. It fired 15 times on rap-god, whose
caption cues are short and whose starts are RIGHT, and once on JASON_MILLER drop50 — the only Jamendo song in
the sweep to gain a gross line. That floor is now the default-off arm **`m5-adopt-floor`** (`config.py`'s arm
list; both branches pinned in `test_align_provenance`, since with the arm ON the fixture it was built for
publishes 5.06 s out and with it OFF the corpus keeps its 16 lines). Default-off: truth −2.13 → −1.21 pt,
gross 29 → 28, drop50's Jamendo gross line gone, off3 87.6 → 88.4% ±500; gates 63/66 → 64/66 and 60/66 → 62/66
under the gate file as it then stood (the same tree reads 83/85 and 82/85 under today's 85, and the arm's own
rows were never re-taken after review r1 — they are pre-r1 on both sides, which is the comparison that judged
it).

What the taxonomy's share buys and costs: it disputes a line more than a PHRASE from the fit where the old
`agreement == 1.0` path disputed anything at all, so an AGREE sheet's stray line is no longer re-decoded and
adopted (shape-of-you −3 lines, two Jamendo songs −1 each). On the Jamendo split it is −0.24 pt within ±500 ms,
words ±100 −0.17, word gross 20 → 20, line gross 2 → 2. bad-guy (−10.1 pt) and believer (−4.2) reproduce the
review's own cost for the two songs it named, to a tenth.

**The decision, taken on the re-measured row (2026-09-29).** `truth-pm500`, `truth-text-pm500` and §3.11's
0.3 pt are WAIVED explicitly, beside their gate names and numbers, because the other two answers the PLAN
admits are worse on the evidence. *Under the bound* is unreachable: the 0.21 pt of excess is part of a cost
paid entirely on songs whose score is taken against the sheet being corrected, so the only route under is to
stop correcting the sheets that need it. *Behind `Config.align_experiments`* was priced on the probe row and
refused: with the clock off, off3 pays 449 gross lines instead of 28 and −19.7 pt at ±500/text, off15 −18.6,
tempo102 −26.4, and the 12 right texts W3 refused at `run_align` go back to being refused. Trading roughly
20 pt across three modes and some 1300 gross lines for 0.21 pt of a caption-truth metric is not a trade a
DEFAULT should make. What the waiver rests on is a measurement, not a preference: `gates/w2.yaml` section 11
reads the SAME bound at §3.11's tighter 0.3 pt on the 20 songs with measured onsets and it PASSES (−0.24 /
−0.17), no claim mode keeps a `high` line more than 2 s out, and `blind` is byte-identical. The waiver is the
bench runner's, it is reversible (a `claim_clock = claimmap.IDENTITY` default plus a knob, already priced by
`results/w2-noclock-time_text.json`), and the whole wave is uncommitted for the owner to overrule it.

At `run_align` three gates fail — it was four before review r1, and the one that went is `no-song-lost-tempo098`
(hello tempo098, refused because the vote moved its claims on 6 explained lines of 74; `MIN_INLIER_SHARE`
refuses that map now and the song publishes again). All three remaining are documents that changed KIND — and
the effect the gate names
is REAL even so, which is how W2 review r1 corrected this paragraph: a gate that says "no Jamendo song gains a
gross line" is about the document the room sees, and the document the room sees is the one that gained them.
**The_Rinn off3** went from a LINE_SYNC document with 46/46 lines within ±500 ms and 0 gross to a published
WORD document with 44/46 and **2 gross** — the whole of W2's `+2` at this level, and a MUST failure, not a
metric artefact. Ridgway off15/off3 lose 2 line starts each the same way. tfr-chosen headers goes the other way
(+51 pt within ±500 ms, and a line document times 3 more injected headers, so `unsung` rises); hello off3 is a
recovery (refused → published, 22 gross lines arriving with a document that did not exist).

THE WHOLE POPULATION, since one song's rows are not an argument, re-counted on the re-measured rows and
unchanged by review r1: 24 song-modes changed from a LINE_SYNC document to a word document between W3 and W2 at
`run_align`. Their net is **−24 line starts within ±500 ms, +2 gross lines (all of them The_Rinn off3), and
8 109 word timings that did not exist before** — 18 cases lose 1-10 line starts (rap-god credit −10,
shape-of-you off3 −7, Avercage off3 −6), 4 are unchanged, and 2 GAIN heavily because their line document had no
line within ±500 ms at all (numb off3 +18, bad-guy off3 +6). Beside them 10 song-modes go from REFUSED to
committed and 11 the other way, from a word document to a line-synced one. A word
document is what karaoke needs and a line document cannot give, so this is a trade and not a regression — but
it is a trade with a cost, and the two MUST gates it fails are recorded as failures above, not as gates that
cannot see their subject. The alternative W1 already built the machinery for (`policy.improves` / best-so-far:
keep the LINE_SYNC document where the word document is not an improvement) needed a rule for comparing
documents of different kinds. **W4 built that rule, and it does not rescue these three gates** — which is
worth stating plainly, because "the real fix is the cross-kind comparison" was this paragraph's answer for two
waves. The rule asks the one question production can answer without truth: did `reconcile` relate this
document to the text's OWN claims (`TimingReport.claims_related`)? Where nothing related them the sheet gets
its turn and must beat the words; where a map fitted, the words stay. On W2's own rows The_Rinn off3 and
Ridgway off15/off3 read `structural` blind and **AGREE after the repairs** — the clock related that sheet to
our decode, which is why the word document became publishable at all — so the rung is never spent there and
those two gates read exactly as they do now. tfr-chosen `headers` is not a kind change in W2 at all: it
ALREADY publishes a LINE_SYNC document (35/35 within ±500 ms, 0 gross), and its `unsung` rise is that line
document timing 3 more of the injected headers, a text-hygiene defect (W5's M11). What the rule does move is a
larger, disjoint population: 36 of the 420 published word documents reach the rung, 18 change kind, and those
18 hold **ALL 299 of their gross lines** — 84% of every published word document's 356 — with 523 of 990 line
starts within ±500 ms where their line documents hold 0 gross and 987 of 991, for 5 677 word timings given up
(PLAN-alignment-v3 W4's carried item (b)).

**The rule's own corpus run at `run_align` is now recorded** (rebench r2, `_runs/w4r2-run_align`, the shipped
tree and the exact clock). Over the 448 right-text cases the LINE_SYNC rung is reached on **45** — `drop50` 23,
`headers` 12, `jit` 4, `drop20` 3, `tempo098` 1, `tempo102` 1, `credit` 1, and 0 in `truth` / `off*` /
`offm1` / `extraverse` / `blind` — and the rung's document REPLACES the first attempt's on **26** of them
(`headers` 12, `drop50` 6, `jit` 3, `drop20` 3, `tempo098` 1, `tempo102` 1; `credit`'s one retry keeps the word
document). So the population moved with the clock — W2's rows read 36 reached and 18 replaced — and it moved the
same way: the sheets that still need the rung are the partial and header-injected ones, not the displaced ones,
which the claim clock's mode candidates now map on the first attempt. At `--sync-mode lines` the counter is 0
everywhere by construction: there the rung is the only attempt, so there is no first document to replace.

**AND THE WAVE'S LARGEST SINGLE REGRESSION IS NOT IN THAT POPULATION AT ALL** (found by W2 review r2, which
also found that no gate in `gates/w2.yaml` could see it). **bad-guy drop50** at `run_align` publishes the SAME
text (`captions:authored`) on the same single attempt with the same `unrelated` verdict, the same 143 words, the
same 34 scored lines and **gross 0 on both sides** — and goes from **28 of 34** line starts within ±500 ms of
truth to **ONE**. ±1 s moves only 31 → 30, so every line left the ±500 ms band for the 0.5–1.0 s band without
any of them crossing 2 s. It changed no KIND, lost no line and gained no gross line; it simply moved, together,
by about 0.6 s.

Why no gate saw it: `gross` and `high_gross` are 2 s metrics, `unsung` / `missing` count lines rather than place
them, `doc_changed` is scoped to the blind mode, and every pooled ±500 number it enters is dominated by the
+2 069 line starts the wave gains elsewhere at this level (17 897 → 19 966 over the right-text modes). A uniform
sub-2 s displacement of one whole document was, by construction, invisible. `gates/w2.yaml` **section 12** is
the answer — a per-mode bound on the worst single document's ±500 share, ratcheted to this wave's own worst.

Whose cost it is, isolated rather than inferred (`_runs/r2spec8-{clock,noclock}-ra`, one song × 2 modes on the
shipped tree against the same tree with the map's one rebinding removed): clock ON reads **1/34** on drop50 and
**6/69** on truth; clock OFF reads **28/34** and **13/69**. So this is the claim clock's, not reconcile's, and
it is the named mechanism of the §3.2 waiver at its worst single document — bad-guy's decode-median is +0.86 s
and its envelope lag +0.72 s, both witnesses agree the vocal is later than the caption track, the vote moves
every claim WINDOW by ~0.6 s, R1 (armed by `unrelated`) re-decodes inside the moved windows, and the truth this
is scored against IS that caption track. The drop50 half-sheet keeps truth-derived stamps, so its 34 kept lines
are all scored against the sheet the clock just corrected. **This document is part of the waiver's price**, and
the waiver's "the cost is entirely on the YouTube songs whose truth file is the claim track" should be read with
it in view: at `time_text` the same mode's worst document is −2.57 pt, so the displacement is specific to the
repair the fuller pipeline runs.

W3's own `onsets-unchanged-*` gates fail here by construction — W3 was a gate-only wave that moved no timing,
and moving them is what W2 is.


## The exact frame clock, the blank the model names, and the matrix cache (W4, 2026-09-29; review §3 item 6a, M9, M10, L6)

### The clock was wrong twice over (review decode-5 / evidence-8)

`WhisperXAligner.emissions` chunked the audio at 30 s and stamped frames with `duration / frames`. Both
halves of that were arithmetic mistakes, and they compounded:

- A 30 s chunk of 16 kHz audio yields **1499** frames, not 1500: wav2vec2's feature extractor advances 320
  samples per frame and needs 400 to emit one at all, so `(480000 − 400) // 320 + 1 = 1499`. The derived
  ratio therefore stretched every frame by 1/1499 — measured `frame_sec` 0.020014 on all 20 jamendo songs —
  which stamps a word up to 20 ms late by the end of each chunk and resets at the next boundary: a sawtooth.
- The loop `break`s on a final chunk shorter than 0.1 s, so up to five frames of the song were never
  computed, while `duration` still counted their seconds. That drifts odd-length songs 50–60 ms late.

Both are now replaced by one **exact grid** (`adapters/ml.py`): frame `k` covers samples
`[k·320, k·320+400)` and is stamped at `k · FRAME_SEC` with `FRAME_SEC = 320/16000 = 0.02` exactly; the grid
has `ceil(samples/320)` frames, so the final sliver is **padded** to its 400-sample field rather than
dropped. Each forward pass additionally computes **2 s of context on either side and throws those frames
away**, so a frame at a chunk boundary gets the same receptive field an interior frame has
(ctc-forced-aligner's `generate_emissions`). The context costs 1.09× the audio at 90 s, 1.12× at the 194 s
song the pass is timed on and 1.13× at an hour — not the flat (30+2+2)/30 the review quoted, because the
first and last pass have context on one side only.

`_frame_passes` is a pure function, so the stitching is tested without weights: a stand-in model whose every
frame is a local function of the 400 samples it saw must give the chunked pass and a **single whole-file
pass** byte-identical matrices. That is the chunk-boundary continuity test W0 recorded as missing
(`tests/test_ml_grid.py`; the old pass fails it on every straddling frame and on every sliver).

### Re-fitting `ONSET_LEAD_SEC`: 40 → 30 ms

The lead had been fitted ON the stretched clock, so it was absorbing a stretch as if it were a delay. Sweep
over the same 5693 hand-timed words, blind decode, vocals stems (`_runs/w4-clock/lead_sweep.py`, rows in
`lead_sweep.json`; the old grid at 40 ms reproduces this file's own baseline exactly — bias +4 ms, ±100
78.7%):

| lead | bias | ±100 | medAE | line gross |
| --- | --- | --- | --- | --- |
| 0 ms | +25.3 ms | 76.53 | 44.0 | 41 |
| 20 ms | +6.0 | 79.52 | 39.8 | 41 |
| 25 ms | +1.5 | 79.71 | 40.0 | 41 |
| **30 ms** | **−3.1** | **79.98** | **40.6** | **41** |
| 35 ms | −7.8 | 80.19 | 41.8 | 41 |
| 40 ms | −12.2 | 80.05 | 43.1 | 41 |
| 50 ms | −20.2 | 79.78 | 45.8 | 42 |

±100 does not choose: it is flat over 25–40 ms (35 beats 30 by 0.21 pt, song-bootstrap CI +0.02..+0.39; 30
against 40 is 0.07 pt with the CI straddling zero). What chooses is the **bias**, which is what the constant
exists to remove and which crosses zero at about 26 ms, and **medAE**, minimised over 20–30 ms. Of the two
5 ms steps around the crossing, 30 is the one on the early side — a highlight a hair early reads as correct
where one late reads as broken (ITU-R BT.1359; W6's separate *display* lead is fitted on that, this constant
stays acoustic truth).

### What the wave's clock change actually moves

`e2e.py --level generate --modes blind --songs jamendo`, old grid at 40 ms
(`results/baseline-v2-generate.json`) against the exact grid at 30 ms (`_runs/w4-clock-generate/`):

| metric | before | after |
| --- | --- | --- |
| word onset ±100 | 78.73 | **79.98** (CI +0.46..+2.22) |
| word onset ±250 / ±300 | 90.46 / 91.29 | 90.46 / **91.45** |
| onset bias / medAE | +3.7 / 40.9 ms | **−3.1** / **40.6** ms |
| words > 2 s out | 141 | **129** |
| line gross (> 2 s) | 47 | **41** (zero-gross songs 5 → 6) |
| line ±500 / ±1 s | 87.67 / 91.82 | 87.56 / **91.94** |
| AAE | 309 ms | 337 ms |
| word end ±100 | 73.2 | 68.7 |
| phrase-final end ±100 / bias | 40.6 / −106 ms | 36.3 / −121 ms |
| highlight (TV semantics) | 67.3% | 66.0% |

Two rows go the wrong way and neither is an onset regression:

- **AAE 309 → 337 ms** is one shape, not a spread. All +160 s of it is four songs whose blind decode
  misbinds repeats — Pure_Mids +68 s, Tom_Orlando +40, Ridgway +40, Explosive_Ear_Candy +16 — so what moved
  is how far an already-wrong word swings. On the same songs the *count* of words over 2 s out falls
  (Tom_Orlando 48 → 32, its line gross 8 → 2). Every robust statistic holds or improves.
- **The ends** were always this early; the old clock's 0.07% stretch was pushing every end later and so
  masking CTC's peakiness (90.9% of 21,921 char spans are exactly one frame). Review §3.5's envelope
  post-pass is what fixes them, and it lands in this same wave — its reject-if gates are read against the
  *after* column here, not against `baseline-v2-generate.json`.

### M9: the blank is the matrix's

`blank = 0` was a literal in five places that have to agree (the kernel call, `generate`'s target filter,
`_char_spans`' run grouping AND its flushing sentinel, `regenerate`'s alignable count, `lexical.letters_of`,
and the mix witness's non-blank mass). It is right for torchaudio's bundles, which put `-` at label 0, and
wrong for 23 of whisperx's 36 HF align models (Danish `<pad>` = 32 with `u` at 0, Norwegian Bokmål
`[PAD]` = 38 with `|` at 0, Korean `[PAD]` = 1204). The review measured the cost on Danish: word onsets
within ±250 ms 90.5% → 73.2%, words over 2 s out 141 → 584.

`Emissions` now carries `blank_id` (whisperx's own detection rule, so the global decode and whisperx's
windowed one cannot disagree on a loaded model) and `specials` (the vocabulary's non-characters, named for
review 6c's `|` reader rather than acted on here). Readers use `generate.blank_of`, a `getattr` with default
0, so every fake and every pre-W4 bench cache entry decodes exactly as it did. Tested by permuting the
fixture's matrix so the blank leaves column 0: a blank-aware chain must publish a byte-identical document,
and the old chain must not (`tests/test_blank_id.py`; all nine blank-literal mutants die).

### M10: the matrix cache was stale and unbounded

It lived in the module-level **model** dict — which must never evict, since reloading multi-GB weights is
why this worker is a resident process — keyed by `(device, language, path)`. Two consequences: every song a
box ever aligned stayed resident, and a stems upgrade republishing the same vocals key (`artifacts/local.py`,
`os.replace`) left a matrix computed from audio that no longer existed, so a later re-pick aligned the new
stem's text against the old stem's frames. Now a separate bounded LRU (4 entries — one job reads at most the
stem and the mix witness) keyed on `(resolved path, size, mtime_ns, model, language, device)`. A path that
cannot be `stat`ed is computed uncached, so a missing target still fails inside `load_audio_mono_16k` as the
typed `InfraFault` every caller is written around.

### L6: bounded-lag correlation, off the event loop

`activity.fit_shift` computed the whole `N + M − 1` cross-correlation and then read 801 lags of it. The
±`reach` window is now computed directly, by zero-padding and taking the *valid* correlation — the same
routine over the same overlaps. Measured here: a 6-minute envelope 0.071 s → 0.003 s, a 60-minute one
**7.65 s → 0.042 s** (the review measured 9.1 s). It is a work reduction, not an approximation, and that was
checked rather than assumed: the values differ in the last bits a longer dot product's blocking can move
(worst 1.4e-14), and over all 32 corpus songs × 8 span perturbations (256 fits,
`_runs/w4-clock/corr_identity.py`) the chosen lag moved **0 times** and `correlation` came back identical,
because `r` is recomputed at the integer lag. The one remaining inline call site — R1's claim fit, when the
claims out-fit the decode — moved into `asyncio.to_thread`, pinned by thread identity rather than by reading
the source.

## Word ends, held through the singing (W4, 2026-09-29; review §3 item 5)

CTC is peaky — 90.9% of 21,921 char spans are exactly one frame — so a decode carries onsets, and its ends
are just the model's last confident frame. The TV acts on the ends anyway: a word is lit while
`start ≤ pos < end` (`core/src/lib/tv/lyrics.ts`, `activeWordIndex`) and struck through at `end`
(`tv/LyricsOverlay.svelte`). The room therefore sees the ball leave words that are still sounding.

The fix is a DISPLAY post-pass, `domain/lyrics/ends.py`, applied in `_time_text_global` after the
wrong-text gate, the never-sung drop, R1–R4 and `_clamped`, immediately before `as_doc()`: each word's end
is walked forward while the target's activity envelope is at or above θ = 0.1, and stopped at the next
word's own start, at +3 s, or at the last envelope frame. **Starts never move.**

### Why this is not the energy-snap this repo rejected

The onset-snap prototype above moved ONSETS to the nearest energy rise within ±0.35 s and measured a net
loss (tfr-flyaway ±250 ms 77.3% → 70.7%), because a snap jumps to a *neighbouring* onset. This is
one-sided (ends only, forward only), bounded by the decode's own next onset (so an over-extension can only
fill a gap the decode left empty — the worst case is a word lit over a silence, never a wrong word lit),
bounded at +3 s, and bounded by the audio the envelope was measured on (so it cannot manufacture an
overshoot). "No onset moves" is review §3.5's own reject-if and is asserted as a test rather than a metric:
`worker/tests/test_ends.py` (500 random documents × both arms) and `worker/tests/test_align_ends.py` (the
same song published with the post-pass on and off, word for word).

### Measured — 3 songs, not the corpus

`e2e.py --level time_text --modes blind --songs HILA,Color_Out,Wordsmith` (1127 words, 1046 ends, 116
phrase-final ends, 407 s sung; `_runs/w4-ends-raw`, `_runs/w4-ends-held`, `_runs/w4-ends-tile`). The arm
`ends-raw` is the control — the post-pass does not run — so all three columns are the same decode:

| metric | `ends-raw` | default | `ends-tile` |
| --- | --- | --- | --- |
| word end ±100 | 75.9 | **79.0** | 75.0 |
| word end ±250 | 94.2 | **94.7** | 93.1 |
| word end bias | −34 ms | **+10 ms** | +25 ms |
| phrase-final end ±100 | 34.5 | **50.9** | 50.9 |
| phrase-final end ±250 | 66.4 | **72.4** | 72.4 |
| phrase-final end bias | −115 ms | **−16 ms** | −16 ms |
| highlight (TV semantics) | 66.2% | **79.1%** | **80.6%** |
| word onset ±100 / ±250 / ±300 | 80.1 / 92.8 / 94.1 | = | = |
| onset bias, words > 2 s out, gross lines | +9 ms, 12, 5 | = | = |

`onsets_sha256` — the harness's digest of every published onset — is byte-identical in all three runs.
Per-song highlight is up on all three songs (worst +9.5, best +17.9). The direction and the size both
reproduce the review's prediction (+17.3 pts phrase-final ±100, bias −107 → −10 ms, +10.5 highlight).

Per song, and worth carrying to the corpus run: phrase-final ±100 is up on all three (19.4 → 38.7, 31.5 →
44.4, 54.8 → 74.2 on their own ends), while word-end ±100 goes DOWN on one of them (Color_Out 56.8 → 54.1).
Interior and phrase-final ends can move in opposite directions on one song, and only the phrase-final ones
are independently measured — which is exactly why §3.5's gate allows 3 of 20 songs to get worse at word-end
±100 and none at all on the highlight. `gates/w4-ends.yaml` encodes all four conditions and passes 6/6 here.

**The `ends-tile` arm trades.** Tiling each line gaplessly (interior words run to the next word's start
whatever the envelope says) buys +1.5 pts of highlight for −4.0 on word-end ±100 and −1.6 at ±250, with
phrase-final ends untouched, since it only moves interior words. That is evidence against the review's "80%
of Jamendo's interior truth ends are just the next word's start" being the whole story: where it held,
tiling could only have helped. Its second cost is not in a number here: the TV splits a line over 42
characters at word gaps of `LINE_GAP_SEC` = 0.45 s, and a tiled line has none, so a long line that showed as
two rows at its pause now shows as one. (The highlight port models `resegmentLine`, so the part of that
which moves the ball is already inside the 80.6; how the unsplit row reads in a room is not.) It ships
default-off.

### Measured — the corpus, 20 Jamendo songs × truth + blind (rebench r2)

`results/w4-time_text.json` against `results/w4-endsoff-time_text.json`, the `ENCORE_ALIGN_EXPERIMENTS=ends-raw`
ARM rather than a code shim (`_runs/w4r2-endsoff-time_text`, 4870 scored ends, 702 phrase-final).
**`gates/w4-ends.yaml` 6/6 PASS**, read on `blind`, which is the cheapest honest population — no claims, so
no repair-ladder differences between the columns:

| metric, `blind` Jamendo | `ends-raw` (control) | default | gate |
| --- | --- | --- | --- |
| highlight (TV semantics) | 65.92% | **77.51%** | +11.59 ≥ +5 ✓ |
| phrase-final end ±100 | 36.30 | **56.75** | +20.45 ≥ +10 ✓ |
| word end ±100 | 68.74 | **79.48** | not down ✓ |
| word end bias | −55.3 ms | **−3.8 ms** | — |
| word onset ±100 / ±300 | 80.11 / 91.58 | = / = | ±300 not down ✓ |
| songs worse at word-end ±100 | — | **2 of 20** | ≤ 3 ✓ |
| `onsets_sha256` changed | — | **0 of 20** | == 0 ✓ |

**No onset moves, proved from the rows rather than from the unit test.** Over the 40 paired song-modes
(both modes, 20 songs) of `results/w4-{,endsoff-}time_text.cases.jsonl`: `onsets_sha256` is unchanged on
**40 of 40** while `doc_sha256` changes on **40 of 40** — the post-pass moves every document and no onset.

The two songs that lose interior-end accuracy are Avercage (−8.33 `blind`, −6.19 `truth`) and Color_Out
(−2.71, −1.28), and **both gain on the independently measured half** — phrase-final ±100 +10.52 / +16.67 and
+19.36 / +21.74, highlight +6.2 / +9.6 and +10.0 / +8.5. **0 of 20 songs are worse at phrase-final ±100 or at
highlight in either mode.** That is the shape §3.5's own objection predicts: interior and phrase-final ends
can move in opposite directions on one song, and only the second is really measured (80% of Jamendo's
interior truth ends are recorded as the next word's start). The largest gains are Songwriterz (word-end
+30.45, phrase-final +44.74) and Slingshot_Miracle (+26.79, +30.77).

**Why `--level time_text` and not `--level generate`.** The post-pass is a step, not a decoder change:
`generate` is the raw global decode alone (that is what the level means, and the driver's docstring says so),
so the ends there are the raw ones whatever this ships. The clock section's 68.7 / 36.3 / 66.0 column is a
`generate` row and is the right thing to compare the *clock* against. Because `align_config` is part of the
emission cache key (deliberately — see `emitter_fingerprint`), the control pass recomputes matrices: about one
extra model pass per song, not per case, which is 2 of the control run's 2.5 minutes.

## The stemless mode: what the mix path really does (W4, 2026-09-29; the carried W3 item, review §3.4 / H3)

Every corpus song has a vocals stem, so until now **no measurement of the shipped mix path existed** — and
the mix path is a whole other set of decisions in the same step: the lexical gate reads the MIX bands
(`lexical.BANDS`), R4 has no second witness (the mix IS the target), `Knob.ALIGN_ON_MIX` is never offered,
and the LINE_SYNC rung declines, so **a refusal there is terminal for the text**. W3 chose the mix's default
on the lift population alone (`results/w3-lift-mix.json`) and shipped the two alternatives as default-off
arms with an explicit note that they were unmeasured end to end.

`e2e.py --no-stem` is that missing dimension, composable with every claim mode and with `--sync-mode`: the
case is handed `vocals_path=None` and nothing else changes, so the stem is not read at all, the mix is the
align target, and `AlignStepsImpl._vocals_of` returns None exactly as it does for a song whose stems job
refused a silent instrumental. A run records `target: mix` and that is part of the SETUP a `base.` gate must
share (`e2e_gates.SETUP_META`): a stemless case decodes a different audio file against the same truth, so no
metric of it is a delta on a stem baseline's.

### The three mix gates, measured (32 songs, `--level time_text --no-stem --wrong-k 2`, base model)

`_runs/w4r2-stemless-{,envelope-,floor-}time_text`, rows committed as
`results/w4-stemless{,-envelope,-floor}-time_text.{json,cases.jsonl}`, 192 cases per arm, ~3-5 min per arm
(each arm recomputes its 32 mix matrices: `align_config` keys the emission cache). Right texts are this
song's own words —
`truth` (the sheet verbatim), `blind` (no claims at all), `drop20` / `drop50` (partial sheets); wrong texts
are another song's sheet, 2 donors per song. Accuracy is on the TEXT denominator (`in_text`, 5805 lines), so
a refused document scores zero. Tally: `_runs/w4-stemless/tally.py`.

These are the POST-FLIP recordings (rebench r2): the column called the default is the shipped path, and W3's
behaviour is the control arm `h3-mix-envelope`. The pre-flip rows of the same three configurations are kept at
`results/w4-stemless-liftalone-time_text.*` — the shipped path one round earlier, which is the only A/B for
review r1's ends mix-skip (see "What the re-record moved" below).

| | **the DEFAULT: the lift's floor alone** | `h3-mix-envelope` (W3's): envelope gate only | `h3-mix-floor`: envelope AND lift |
| --- | --- | --- | --- |
| right texts published | **91 / 128** | 77 / 128 | 54 / 128 |
| line starts ±500 ms, of the text | **53.5%** | 42.3% | 38.4% |
| gross lines published | 859 | 853 | **467** |
| `truth` published | **25 / 32** | 22 / 32 | 16 / 32 |
| `truth` ±500 ms, of the text | **66.7%** | 53.7% | 47.9% |
| `truth` gross lines | 108 | 147 | **48** |
| **wrong texts passed** | **0 / 64** | **27 / 64 = 42.2%** | **0 / 64** |
| `gates/w4-stemless.yaml` | 10 / 14 | 3 / 14 | 3 / 14 |

Against the default, case for case: `h3-mix-floor` refuses 37 right-text documents and recovers none (−873
line starts within ±500 ms); `h3-mix-envelope` refuses 37 and recovers 23 (−873, **+227**).

#### What the re-record moved

Published counts, refusals, ±500 and the wrong-text rate reproduce the pre-flip rows EXACTLY on
`truth` / `blind` / `drop20` / `wrongtext` — starts never move, so the flip really is a rename — and two
things did move:

* **the END columns, which isolates review r1's ends mix-skip.** Phrase-final end ±100 +3.4 `blind` /
  +4.6 `truth` / +11.0 `drop20` / +6.4 `drop50`; highlight −9.5 / −9.7 / −6.3 / −4.0. On the mix the walk had
  been reaching its cap on 92–98% of frames — tiling plus a 3 s tail — which BUYS highlight (a held end is on
  screen while the singing is) and LOSES the phrase-final end it is judged by. The skip is the right default
  until a mix theta is fitted, and the trade is now a measurement rather than a prediction.
* **one right-text document, and it is not the ends:** `bad-guy` drop50 on the mix, gross 0 → 8 and ±500/text
  11.76 → 8.82 (pooled `drop50` gross 281 → 289). The trails name it: r1's new `tempo-mode` candidate
  outscores `envelope-lag` by ONE line (10 of 34 against 9), the repaired document then reads `unrelated`
  instead of `coarse` (9% of lines agree, not 68%), and r1's `off_clock` refusal withholds the 14 claim
  adoptions that had carried it. MIX-ONLY: the same case is byte-stable on the stem at both levels.
* the CONTROL got worse, which strengthens the flip: `h3-mix-envelope` now admits 27 of 64 wrong texts
  (42.2%) against the pre-r1 recording's 26 (40.6%). The extra one is `Kinematic_-_Peyote` under
  The.madpix.project's sheet at lift −0.0056 — sub-floor, and its envelope fit now clears the gate.

**W3's mix path failed review §3.4's reject-if by forty times over** — "more than 1% of wrong texts pass" is
42.2% on these rows — and it was not a close call which way to fix it, because the envelope gate on the mix
is anti-correlated with the document it admits:

* it REFUSES 10 of the 32 `truth` texts, and 9 of those lift at or above the 0.15 floor, so
  `h3-mix-lift-alone` publishes them: Tom_Orlando (lift +1.465) 72 of 72 line starts within ±500 ms with 0
  gross, Rxbyn (+1.081) 69/72 with 0, HILA (+0.872) 53/58 with 0, Ridgway (+1.061) 48/50 with 0, tfr-mayday
  (+0.943) 44/52 with 0, The.madpix (+0.637) 26/30 with 1 — then two poor ones and one bad one: tfr-chosen
  (+0.425) 13/37 with 16 gross, bad-guy (+1.667) 2/79 with 1, never-be-alone (+0.158) 4/47 with 42. (The
  tenth, Color_Out at +0.117, is sub-floor: every arm refuses it.);
* it PUBLISHES the four worst `truth` documents in the run, all four sub-floor: The_Rinn (lift −0.010) 2 of 46
  line starts within ±500 ms with **44 gross lines**, feel-my-heart (+0.012) 7/37 with 25, Moon_I_Mean
  (+0.127) 15/43 with 19, Pure_Mids (+0.026) 8/20 with 11. The floor's `truth` cost is the other two it
  admits: numb (−0.039) 29/35 and Avercage (−0.012) 41/42, both with no gross line.

The lift population on the mix is the same one `results/w3-lift-mix.json` recorded, now read through the
shipped step: right texts −0.043..+2.852 (median +0.511), wrong texts −0.086..+0.098 — so **the 0.15 floor
separates the two populations completely on this run**, and the reviewers' "it would refuse about a quarter
of the right texts" is confirmed at 37 of 128 (28.9%), 7 of the 32 `truth` texts.

### What a refusal costs, as a whole job (`--level run_align --no-stem --asr off`, 4 songs, truth)

`_runs/w4-stemless-ra-{default,floor,liftalone}`. A stemless refusal is terminal, the pool holds one provider
text, and `--asr off` stands for a box with no transcriber — so the job ends in `GiveUp`: **no lyrics**.

| song (mix lift) | default | `h3-mix-floor` | `h3-mix-lift-alone` |
| --- | --- | --- | --- |
| Avercage (−0.012) | published 41/42, 0 gross | no lyrics | no lyrics |
| numb (−0.039) | published 29/35, 0 gross | no lyrics | no lyrics |
| HILA (+0.872) | **no lyrics** | no lyrics | published 53/58, 0 gross |
| Rxbyn (+1.081) | **no lyrics** | no lyrics | published 69/72, 0 gross |

And "terminal" understates it, which the bench cannot show because it runs one job per song: a refused text
rides out on `AlignOutcome.refused`, and the completion frame WITHDRAWS an earlier job's stored candidate for
those same words (`align_steps.superseded_candidates`, review W1 r2). So a mix refusal does not merely fail to
publish — it takes down whatever an earlier run of the same media had published for that text.

### The decision, and it is not the one W3 shipped — TAKEN in W4 review r1

**On the mix the lexical lift REPLACES the envelope gate, exactly as it is the verdict on a stem** — with
`mix_floor` staying at 0.15 (the review's ~0.1 would pass shape-of-you's donor; see `lexical`). W4 recorded
this as a recommendation and review r1 flipped the default to it (`align_steps._time_text_global`,
`lexical.BANDS.mix_floor`, `Config.ALIGN_EXPERIMENTS`), keeping W3's behaviour as the control arm
`h3-mix-envelope` and the both-gates configuration as `h3-mix-floor`. It dominates the behaviour it replaces
on every axis that matters: 14 more
right texts published, +11.2 points of line starts within ±500 ms on the text denominator, +13.0 on `truth`
alone, the same gross count (851 vs 853) over 14 more documents, and the wrong-text pass rate 40.6% → 0.0%.
`h3-mix-floor` — what W3 first shipped, both gates required — is strictly worse than that: it pays the
floor's cost AND keeps the envelope gate's, publishing 54 right texts where the lift alone publishes 91.

Two things this does NOT say. (1) The floor's cost is real and terminal: 37 right-text cases (7 of 32 truth
texts) are refused, and the two best of them are good documents — numb 29/35 and Avercage 41/42 line starts
with no gross line — so a stemless song whose sheet the mix's matrix barely hears publishes nothing and falls
to the transcript, or to no lyrics on a box without one. The redraw noise on a near-floor lift is an SD of
0.03–0.07 (`lexical`, REDRAW NOISE), which is the scale of that decision for the 4 texts inside ±0.05 of the
floor. (2) The envelope fit is not worthless — it reads whether OUR DECODE sits on the audio's activity,
which the lift cannot see: `blind`-mode recoveries include never-be-alone at 4 of 47 line starts with 42
gross and bad-guy at 0 of 79 with 10, both lifting over +0.15. That is an argument for keeping the fit as a
GRADING input on the mix (demote a document its own decode does not fit), not for keeping it as the refusal;
measuring that pairing is the next stemless run, and it is not in this wave.

"Either gate is enough" was measured too, by derivation from the same rows: it publishes 114 of 128 right
texts and 26 of 64 wrong ones — it cannot pass §3.4 at all, because the envelope half is what passes them.

### What this owes

THE FLIP'S RE-RECORD IS DONE (rebench r2): all three configurations are recorded under their shipped names,
`align_config` reads what each run actually was, and `results/w4-stemless-time_text.json` is the shipped path
a later stemless run should `--compare` against. `h3-mix-lift-alone` is retired from
`Config.ALIGN_EXPERIMENTS`, so the pre-flip rows can be READ but not reproduced under that name — the control
`h3-mix-envelope` reproduces the other column, and the retired arm's own column is now the default's.

`gates/w4-stemless.yaml` holds review §3.4's two halves as absolute gates on a stemless run, with each arm's
reading in its header. The corpus sweep this probe does not replace: `--modes all` stemless at both levels
(and `--sync-mode lines --no-stem`, where the rung declines every text by design — worth pinning as a row
rather than assumed). Nothing about the stem path is measured here: `--no-stem` is a different setup, so
these runs are not comparable with `results/w2-*` or `w3-*` metric for metric.
