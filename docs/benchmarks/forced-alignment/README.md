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

This **validates existing behaviour rather than asking for a change**: `records.AudioRef.align_target`
already prefers the vocals stem and `policy.decide` treats the mix as a `Knob.ALIGN_ON_MIX` fallback. The
number to take from it is that the fallback is a real quality step down, not an equivalent path.

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
  offset, not wrong text). Its **three calibration points**, which are the three tiers of
  `align_lines._envelope_passes` (design in `docs/arch/04-alignment.md` §5.2): **r ≥ 0.40**
  (`activity.MIN_CORRELATION`, the `usable` threshold) within **±0.5 s**; **r ≥ 0.25** with
  **|lag| ≤ 0.1 s**, the zero-lag null that only timings measured on this audio may be held to; and
  **r ≥ 0.60** at **any** lag, this bullet's offset case. `_sheet_passes` — the gate on a sheet's own
  claimed spans — is the first and third of those only, never the ±0.1 s one. Both live-found regressions
  came from re-gating the repaired series:
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
        --model WAV2VEC2_ASR_BASE_960H --tag base-all      # tens of minutes: run with nohup, poll the log
        # (no --model and no ENCORE_ALIGN_MODEL = THIS BOX'S SHIPPED BUNDLE, which since W5's flip is
        #  `HUBERT_ASR_LARGE` on every device — so naming the base bundle above is now naming the CONTROL,
        #  which is what every row committed before W5 was measured on. `--model` (or ENCORE_ALIGN_MODEL,
        #  which `main` honours the way the worker does) is how either is spelled: see "The English bundle
        #  is a setting — and HuBERT-Large IS the default since W5")
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
matrix the attempt decoded (4 CTC decodes, no model pass). `lexical.CALIBRATED` holds the thresholds and their
full provenance, one row PER MODEL since W4b — three of them, and `BANDS` is the base model's row, which since
W5's flip is NO LONGER the shipped default's (that is `HUBERT_ASR_LARGE`'s row, `refuse_below` 0.45 against the
base row's 0.2; a reader who means "the model these frames came from" must go through
`lexical.calibration(emissions)`, never through `BANDS`, which is now only the row of a matrix naming no model
at all);
`scripts/lift_gate.py` is the calibration (`--target stem|mix`, `--model`
for a re-run on another model, `--from` to re-print), rows in `results/w3-lift-{stem,mix}.json`. Base model, shipped decoder,
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
  hesitated: it refuses 54 of the 192 right mix texts (41 of the 160 protected, **7 of the 32 truth texts**:
  numb -0.045, Avercage -0.012, The_Rinn -0.010, Pure_Mids +0.027, feel-my-heart +0.038, Color_Out +0.117,
  Moon_I_Mean +0.127), a song with no stem has nothing after a refusal (NextText, and the rung declines the
  mix), and the "unheard decode" reading does not hold case by case (Moon_I_Mean's truth lifts +0.127 with
  69.8% of its blind lines within 1 s). What flipped it is that the gate it replaces loses MORE of the same
  and admits wrong texts as well: the envelope gate refuses 51 of the stemless mode's 128 right-text cases
  and 10 of its 32 truth texts, 9 of them above the floor, while passing 27 of 64 wrong texts (42.2%, against
  §3.4's 1%) — see "The stemless mode" below, which is the end-to-end measurement this decision rests on. Its
  measurable half sorts the mix badly case by case too (it passes numb's unheard decode, refuses Rxbyn's
  92%-within-1 s one; with the floor it refuses 122/192 right texts, the floor alone 54/192, both 0/640
  wrong). The controls are `h3-mix-envelope` (W3's default: the envelope gate alone, the floor grading) and
  `h3-mix-floor` (both gates, W3's first shipping).
- **Exempt**: the ASR tier, a text the lift cannot measure, and (W3 review r2) a matrix whose
  `Emissions.model` has NO `lexical.CALIBRATED` row — the alignment bundle is chosen per LANGUAGE (and since
  W4b per DEVICE and per setting), so the English bands must not judge a German sheet on a German model's
  log-probabilities. All three keep the
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
  and holds 108 of the 192 right mix texts (15 of the 32 truth texts), so stripping their standing would
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
`align_lines._LINE_SYNC_MIN_DECODED_SHARE` of the sheet's claimed lines not decoded, since the share's
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
already right. Both are now one call: `align_lines._line_sync_clock` runs the same `claimmap.consensus` vote
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

**Re-read on the EXACT CLOCK, and both values stand** (W4 6a moved every emission matrix, so both literals were
being read on a scale they were not fitted on: same script, same band, same base model, same 1056 cases, rows
in `results/w4-line-gate.json`; `worker/tests/test_bench_e2e.py` pins this table against that file so the
constants and the rows cannot drift apart again).

| share | right refused /416 | good refused /410 | bad shown /2 | gross shown | text ±500 |
| --- | --- | --- | --- | --- | --- |
| 0.3 | 4 | 4 | 2 | 13 | 92.5% |
| 0.4 | 15 | 13 | 0 | 6 | 91.4% |
| **0.5 (shipped)** | **32** | **28** | **0** | **0** | **90.3%** |
| 0.6 | 47 | 43 | 0 | 0 | 87.8% |
| 0.7 | 90 | 86 | 0 | 0 | 79.5% |

The verdict is the same shape — 0.5 is still the first share that shows NO gross line, and every tighter share
buys nothing for the right texts it refuses — but **the population W2's separation argument rested on no longer
exists**: 0 of 416 right texts are more than 20% gross now (the two `hello` tempo documents at 0.24 and 0.32
were fixed by the exact clock and the claim clock's mode candidates). Re-read against the quality population
the rows carry instead: the 2 documents with under half their lines within 1 s of truth (`never-be-alone`
tempo098/tempo102) both read 0.34, the 410 with 80% or more read p10 0.583 / median 0.865 / p90 0.987, and 0.5
sits between them with 0.16 of headroom over the worse population. What the timing half does NOT do, at either
reading, is clear every wrong text on its own: 1 of the 640 wrong-text cases reads above 0.5 (W4
`Kinematic_-_Peyote` under `wrongtext+ownclock` at 0.5714; W2 `feel-my-heart` at 0.5135), and the LEXICAL LIFT
is what refuses it (−0.125 there) — it refuses all 640 in both readings. The `--near 0.5` column above was NOT
re-run: `near` is computed during the run, so the W4 rows hold the 1.0 s band only. What they do say is that a
tightening would now cost MORE, since the good population's p10 rose 0.538 → 0.583.

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
caption cues are short and whose starts are RIGHT, keeping 15 measured timings instead of adopting for
**−16 of 1 736 lines within ±500 ms, −7.4 pt on that song and +1 gross**, and once on JASON_MILLER drop50 — the
only Jamendo song in the sweep to gain a gross line. That floor is now the default-off arm **`m5-adopt-floor`** (`config.py`'s arm
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

### What a cached emission matrix costs

The readings behind `adapters/ml._emission_cache_size`, which bounds the LRU at
`_MATRICES_PER_JOB × (jobs + 1)` — 4 entries at the default concurrency of 1, 8 on a 3-job box. A matrix is
`frames × vocabulary` float32 on an exact 20 ms grid (`FRAME_SEC`), so the arithmetic is reproducible rather
than quoted:

| bundle | vocabulary | a 3-minute song | the LRU full, 1 job | the LRU full, 3 jobs |
| --- | --- | --- | --- | --- |
| an English wav2vec2 / HuBERT bundle | 29 | **~1 MB** (9.7k × 29 float32) | ~4 MB | ~9 MB |
| the widest whisperx HF table (Korean) | 1 204 | **~47 MB** | ~188 MB | **~376 MB** |

That spread is why the bound is derived from `Config.concurrency` rather than flat, and why it is not
`jobs * 10`: a flat 4 let a 3-job box's six LIVE matrices evict each other and every attempt after the first
re-paid the forward pass, while a generous flat bound would let one Korean job's history hold a third of a
gigabyte. The ~1.4 GB figure quoted around the calibration table is the bench's on-DISK emission store, a
different population from this resident LRU.

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
the source. Read at that call site the same reduction is **7.9 s → 55 ms** on a 60-minute recording, and 55 ms
of synchronous numpy still stalls the socket keepalive the reaper reads, which is why the win does not remove
the need for the thread.

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

* it REFUSES 10 of the 32 `truth` texts, and 9 of those lift at or above the 0.15 floor, so the shipped floor
  publishes them (measured here as the pre-flip arm `h3-mix-lift-alone`, which IS today's default): Tom_Orlando (lift +1.465) 72 of 72 line starts within ±500 ms with 0
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

These probes were run PRE-FLIP, so their column names are the pre-flip ones and are relabelled here to the
shipped configurations (the run dirs keep the old names; a re-run under the shipped names is still owed,
`gates/w4-stemless.yaml`): the old `default` is today's control arm `h3-mix-envelope`, and the old
`h3-mix-lift-alone` is today's default.

| song (mix lift) | `h3-mix-envelope` (was `default`) | `h3-mix-floor` | THE DEFAULT (was `h3-mix-lift-alone`) |
| --- | --- | --- | --- |
| Avercage (−0.012) | published 41/42, 0 gross | no lyrics | no lyrics |
| numb (−0.039) | published 29/35, 0 gross | no lyrics | no lyrics |
| HILA (+0.872) | **no lyrics** | no lyrics | published 53/58, 0 gross |
| Rxbyn (+1.081) | **no lyrics** | no lyrics | published 69/72, 0 gross |

And "terminal" understates it, which the bench cannot show because it runs one job per song: a refused text
rides out on `AlignOutcome.refused`, and the completion frame WITHDRAWS an earlier job's stored candidate for
those same words (`align_text.superseded_candidates`, review W1 r2). So a mix refusal does not merely fail to
publish — it takes down whatever an earlier run of the same media had published for that text.

### The decision, and it is not the one W3 shipped — TAKEN in W4 review r1

**On the mix the lexical lift REPLACES the envelope gate, exactly as it is the verdict on a stem** — with
`mix_floor` staying at 0.15 (the review's ~0.1 would pass shape-of-you's donor; see `lexical`). W4 recorded
this as a recommendation and review r1 flipped the default to it (`align_steps._time_text_global`,
`lexical.BANDS.mix_floor`, `Config.ALIGN_EXPERIMENTS`), keeping W3's behaviour as the control arm
`h3-mix-envelope` and the both-gates configuration as `h3-mix-floor`. It dominates the behaviour it replaces
on every axis that matters: 14 more
right texts published, +11.2 points of line starts within ±500 ms on the text denominator, +13.0 on `truth`
alone, the same gross count (851 vs 853) over 14 more documents, and the wrong-text pass rate 42.2% → 0.0%.
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
texts and 27 of 64 wrong ones — it cannot pass §3.4 at all, because the envelope half is what passes them.

### Where the rows are

`$ENCORE_BENCH_ROOT/_runs/w6-conf/` (its `README.txt` names each file), written by
`_review-scratch/w6-conf/collect.py` — the harness's own `TimeTextDriver` with cached emissions and ONE
monkeypatch, which records what `margin.low_lines` was handed per case — and read by
`_review-scratch/w6-conf/window.py`. Not a harness run directory: no `run.json`, no `rows.jsonl`, so
`e2e.py --summarize` does not read them. The LOSO fit needs per-line margins, which a harness row does not
carry, which is why it lives there rather than in a gate.

### What this owes

THE FLIP'S RE-RECORD IS DONE (rebench r2): all three configurations are recorded under their shipped names,
`align_config` reads what each run actually was, and `results/w4-stemless-time_text.json` is the shipped path
a later stemless run should `--compare` against. `h3-mix-lift-alone` is retired from
`Config.ALIGN_EXPERIMENTS`, so the pre-flip rows can be READ but not reproduced under that name — the control
`h3-mix-envelope` reproduces the other column, and the retired arm's own column is now the default's.

THE `--modes all` PAIR IS THE EXCEPTION, AND IT IS RENAMED RATHER THAN RE-RECORDED (W4 review r2). Both rows
were taken on the pre-flip tree (`meta.code f2e38b0414778141`), where a bare `align_config: {}` meant the
ENVELOPE gate; on the shipped tree the same `{}` means the lift's floor, and no recorded metadata separates
the two — `target`, every `SETUP_META` key and `align_config` all match, and `code` is deliberately not
compared. So the pre-flip default row is now `results/w4-stemless-all-envelope-time_text.*` (its own numbers
prove the gate: **128 of 320 wrong texts published**, 170 right texts refused, against 0 of 320 for its
same-code sibling `w4-stemless-all-liftalone-*`, which is today's default under the retired name).
`meta.align_config` is left as recorded — it faithfully says the environment had no experiments set, which is
exactly what stops being a statement about BEHAVIOUR when a default flips. Neither `--modes all` row may be a
`--compare` base for a shipped-path run; a 16-mode stemless baseline on the shipped names is still owed, and
until it exists the 5-mode `results/w4-stemless-time_text.json` is the stemless baseline.

`gates/w4-stemless.yaml` holds review §3.4's two halves as absolute gates on a stemless run, with each arm's
reading in its header. The corpus sweep this probe does not replace: `--modes all` stemless at both levels
(and `--sync-mode lines --no-stem`, where the rung declines every text by design — worth pinning as a row
rather than assumed). Nothing about the stem path is measured here: `--no-stem` is a different setup, so
these runs are not comparable with `results/w2-*` or `w3-*` metric for metric.

## Per-model calibration, the never-sung floor, and the gate rebase (W4b, 2026-09-30)

W4b's first item is machinery rather than accuracy: **every emission-scale threshold in this worker is now
DATA keyed by the model that produced the matrix**, so the HuBERT change (review §3 item 6b) and the
line-boundary separator (6c / D1) can be judged on thresholds fitted to their own decode instead of the base
model's.

### One table, keyed by the model (`domain.lyrics.lexical.CALIBRATED`)

`lexical.Bands` used to be one shipped record, `BANDS`, and the LINE_SYNC rung's decode-agreement share was a
separate literal in `align_steps`. Both are now rows of one table:

| field | what it gates | fitted by |
| --- | --- | --- |
| `refuse_below` | a stem's wrong-text gate, AND the LINE_SYNC rung's (it calls `lexical.band`) | `scripts/lift_gate.py --target stem` |
| `ok_from` | the stem doubt band (every line `low`, the words unvouched) | the same |
| `mix_floor` | a stemless song's wrong-text gate | `scripts/lift_gate.py --target mix` |
| `mix_ok_from` | the mix doubt band (audibility, a grading threshold only) | the same |
| `line_sync_min_agreement` | the rung's timing gate: the share of decoded lines near their mapped claim | `scripts/line_gate.py` |

There is deliberately **no second copy of the rung's lexical floor** — W3 review r1 removed that duplicate and
W4b did not bring it back. `Emissions.model` names the bundle, `lexical.calibration(emissions)` answers with
that model's row or with `None`, and `None` is never a substitute:

* the lift is unmeasurable (`align_lines._measured_lift`), so the envelope gate keeps the verdict and
  `TimedDoc.vouched` is false — the shape W3 review r2 already built for a foreign matrix;
* the rung's SHARE, by contrast, is still read — and this is the one asymmetry (W4b review r1 fixed the
  original, which stood both down). The share is a fraction of lines within a tolerance in SECONDS, not a
  log-probability, so it means the same on any bundle: `lexical.line_sync_share` falls back to
  `LINE_SYNC_SHARE_UNCALIBRATED` (0.5 — the value all three rows fit independently). Standing it down left
  W7's per-language bundles on the sheet-span envelope ALONE, which is the gate this decode check was
  introduced to replace, because a same-video translation fits the singing at r ≈ 1.

That is the runtime half of "fail loudly or refuse to gate". The loud half belongs to 6b's `ENCORE_ALIGN_MODEL`
knob, which must refuse a bundle `lexical.is_calibrated` says no to at config time rather than starting a
worker whose gates have quietly stopped gating. Adding a model is adding a row — the procedure is in
`lexical`'s docstring, both scripts take `--model`, and `line_gate.py` now prints the fitted share ready to
paste (and says so loudly when the bundle it was pointed at has no row yet).

### The never-sung floor: measured, and the absolute one wins (`scripts/unsung_gate.py`)

`Pure_Mids_-_The_Leader`'s line [0] is W4's single systematic regressor — dropped as never-sung, which is ten
of `gates/w4.yaml`'s fourteen `jamendo-no-new-gross-*` failures and its `truth-jamendo-pm500` failure. W4b's
brief asked whether `_NEVER_SUNG_ENV` should become a per-song RELATIVE floor, review L2 having pointed out
that 0.10 is an absolute level on a P95-normalised envelope. It should not, and the reason is measurable:
`scripts/unsung_gate.py` runs the shipped two-round drop loop under each candidate floor over 32 songs × 6
text modes and scores what survives (rows: `results/w4b-unsung-gate.json`, `--from` re-prints them).

| floor rule | real lines dropped | injected dropped | scored | ±500 | gross |
| --- | --- | --- | --- | --- | --- |
| abs-0.10 (shipped) | 37 | 21 | 9214 | 6576 | 1138 |
| abs-0.00 (rule OFF) | 0 | 0 | 9251 | 6568 | 1157 |
| abs-0.06 | 23 | 19 | 9228 | 6567 | 1149 |
| abs-0.03 | 11 | 14 | 9240 | 6563 | 1155 |
| gap q10, capped at 0.10 | 15 | 16 | 9236 | 6567 | 1155 |
| gap q25, capped | 28 | 18 | 9223 | 6572 | 1139 |
| gap median, capped | 37 | 21 | 9214 | 6576 | 1138 |
| gap median, uncapped | 62 | 25 | 9189 | 6574 | 1126 |

**No rule in the table is Pareto-better than the shipped constant** — which is the claim this table supports,
and NOT "they all point the same way", which its own last row refutes (W4b review r2, correctness-4): the
uncapped median gap reads **12 fewer gross lines** (1126 against 1138) and pays for them with **25 more real
sung lines withheld** (62 dropped against 37), 4 more injected ones and 2 line starts within ±500 ms. Every
other rule is worse on ±500 lines or on gross lines or on both. Read that way the three readings agree — **on a
STEM**, which is what every one of the 192 song-modes
is (`--target stem`, `song.vocals`). Review L2's own case is the MIX, and there the rule is not mis-fitted but
INERT: the band fills the gaps between lines (L2's figures: ~0.51 on a mix against 0.27–0.31 on a bleed stem),
so nothing reads below 0.10 and an unsung caption or credit line is timed and published — on a stemless song,
which is a shipped path (the align target is the mix there). `unsung_gate.py --target mix` runs the same sweep
against `song.mix` for the wave that prices it; W4b did not (W4b review r1). **The rule pays for itself**: +8 line starts within ±500 ms
and −19 gross lines against the rule off, for 37 real lines not published — 20 of which are caption
non-lyrics the truth file only carries because the truth IS a caption track (`(energetic rock music)`,
`(somber music)`, `[COSTUME RUSTLES]`, an uploader credit; W5's text hygiene owns those). **A relative floor is
stricter here, not kinder**: the level BETWEEN decoded lines is at or above 0.10 on 29 of 32 stems (per-song
medians 0.019–0.578) — bleed and reverb tails, L2's own 0.27–0.31 — so a floor at the song's own median is a
no-op under the cap (0 of 192 song-modes move) and the lower quantiles cost ±500 lines, add gross lines AND
spare 5 of the 21 injected lines, which is the `unsung-not-up-*` rise the brief forbids. **And the two
populations overlap**: the 28 real candidate lines read 0.0014–0.0965 against the 19 injected ones
0.0007–0.0758, so no threshold on the level sorts them at all.

The two lines the wave wanted separated are the exhibit: Pure_Mids' real sung line reads env **0.0890** and
tfr-chosen's spoken credit line **0.0892**, while their songs' gap quantiles order the wrong way (0.075 against
0.024). What both actually share is not silence but SMEAR — the decode spread them over 37 s and 47.6 s and
placed them 32.5 s and 54.3 s from the truth — so the rule's three signals are reading one fact (a line the
decode could not place) rather than three independent witnesses, and the envelope mean over a span the decode
chose says more about the decode than about the audio. The floor stays 0.10, the whole record is at
`align_unsung._NEVER_SUNG_ENV`, and one correction goes with it: `gates/w4.yaml` said the `m6-window-spare` arm
puts this line back "more than 2 s out", and its own recorded row (`_runs/w4r2-puremids-wspare`) puts it back
at **−0.048 s** with 20/20 scored and gross unchanged. The arm's cost was measured before both the claim clock
and this clock, so its default is an open corpus question and not a settled one.

### Three stale gate files rebased

Each file now carries a header saying what it was rebased from, onto what, when and why.

* `gates/w0-reproduce-{generate,time_text}.yaml` pinned the review's v2 baseline and failed BY CONSTRUCTION
  after W4's clock (3/11 and 5/11). NOT every failure was a gain, and each header now splits them (W4b review
  r1): at `generate` 3 of the 8 are gains (word ±100, |bias|, words > 2 s) and **5 are the exact clock making
  the RAW decode's ends worse** (word end ±100 −4.46 pt, phrase-final ±100 −4.30, ±250 −0.86, its bias 14.8 ms
  later, painted highlight −1.30) — all five pre-`extend_ends`, whose own row (`gates/w4-ends.yaml`) turns
  those same numbers into +20.5 and +11.6 at the shipped level; at `time_text` 5 of the 6 are gains and the
  sixth is pooled blind ±500 −0.56 pt. Rebased onto
  `results/w4-{generate,time_text}.json`: **11/11 each**. They are determinism gates now — the same corpus,
  model and emissions key must reproduce W4's recorded numbers — and the review's own figures live on in the
  headers and in "The E2E harness". `--tfr-audio reference` is gone with the baseline it existed for.
* `gates/w2.yaml` compared against `results/w3-*.json`, so on the W4 rows it scored 60/88 and 58/88 with every
  failure being W4 rather than a later wave. Rebased onto `results/w4-*.json`: **88/88 at both levels**, with
  section 12's thirteen displacement bounds LEFT AT W2's LITERALS — review r1 re-priced eleven of them at W4's
  own measured worst, and review r2 restored them, because a literal re-priced off the previous wave while
  `--compare` also moves to that wave is an allowance that compounds (`credit` would have been −44.68 pt below a
  row already −44.68 below W3: ~89 pt read as green). The base moves; the allowance does not, and W4's own
  excess is recorded in that section as a price paid rather than a new budget — and section 4's
  byte-identity gate KEPT and re-scoped (a wave that deliberately moves the decode reports the count and is
  held to three new metric companions instead). The families W4b's brief protects — `jamendo-no-new-gross-*`,
  `unsung-not-up-*`, the wrong-text three, section 11's two — were not touched and are absolute on the new
  base. The rebase also retired a waiver: W2's two waived `truth-pm500` MUSTs now PASS on the W4 rows against
  the same W3 base (89.45 vs 88.11), because W4's clock repaid W2's cost.

### `Emissions.specials` has a reader now

The field named the vocabulary's non-character columns since W4 and nothing read it, which left the target
filter one id wide. `domain.lyrics.generate.excluded_of` is that reader — the blank plus every special the
matrix names — and `generate`, `regenerate`'s slice, `alignable_chars` and `lexical.letters_of` all filter
through it. The defect it closes is reachable from a lyric: every HF vocabulary maps `|` to the word separator
(the shipped `en` dictionary is `{'-': 0, '|': 1, 'e': 2, ...}`), so a sheet writing `oh | oh` fed id 1 in as a
character target and the decode forced a separator into the middle of a line. Inert on this corpus — 0 pipes in
its 832 texts, so no recorded row moves — and it is the plumbing 6c needs.


## The English bundle is a setting — and HuBERT-Large IS the default since W5 (2026-10-01; review §3 item 6b)

> **W4b's heading said "DID NOT earn the default", and this section is kept in that order on purpose: W4b built
> and calibrated the candidate and its sweep REJECTED it, W6 found that the rejection measured the repair
> clamp's left floor rather than the decode, and W5 flipped it on the re-read. Read the W4b subsections below as
> the record of the rejection they were, and "the shipped default" in them as the BASE bundle; what ships now is
> `HUBERT_ASR_LARGE`, with its own section at the end of this one and its gate in `gates/w5-flip.yaml`.**

The alignment bundle used to be whatever `whisperx.load_align_model` picks for the text's language — always
`WAV2VEC2_ASR_BASE_960H` for English, since the language is always `en` (review M8). It is a SETTING now,
`ENCORE_ALIGN_MODEL` (`Config.align_model`, resolved at the composition root by `__main__.align_model_for`,
per device through `adapters.ml.ALIGN_MODELS_BY_DEVICE`), and three bundles carry a full calibration row:
`WAV2VEC2_ASR_BASE_960H`, `HUBERT_ASR_LARGE`, `HUBERT_ASR_XLARGE`. They share the base model's 29-token
vocabulary and its exact 320/400 frame grid, so the swap is one name — what it is NOT is a free swap of
thresholds, and that is what this section records.

**W4b's VERDICT, AND WHY IT WAS REVERSED.** Review 6b asked for HuBERT-Large on MPS/CPU and XLarge on CUDA;
W4b built and fully recalibrated both, then ran the flip end to end on the whole corpus at both levels and **it
failed three of the wave's six MUST gates** — see "The corpus sweep, and why the flip is an operator's choice"
below and `gates/w4b.yaml`. W6 instrumented that failure line by line and the cause was not the decode: every
new gross line start under `truth` claims was manufactured AFTER the repair ladder finished, by `_clamped_v2`'s
left floor. With the floor bounded, the same gates read **28/30** and W5 took the flip, so
`DEFAULT_ALIGN_MODEL` is `HUBERT_ASR_LARGE` and `ALIGN_MODELS_BY_DEVICE` is still EMPTY (the flip is a BUNDLE
result, not a device one — nothing in it is a fact about MPS). The bundle is named explicitly either way, so
`Emissions.model` always says which `lexical.CALIBRATED` row a matrix belongs to.

    cd worker && .venv/bin/python -m encore_worker                                   # HuBERT-Large, the default
    cd worker && ENCORE_ALIGN_MODEL=WAV2VEC2_ASR_BASE_960H .venv/bin/python -m encore_worker  # the base bundle
    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/e2e.py --modes all  # the default
    cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/e2e.py --modes all \
        --model WAV2VEC2_ASR_BASE_960H --tag base-all      # the control, and every pre-W5 row's bundle

**The bench's default follows the shipped default** (`e2e.default_model(language, device)` calls
`ml.default_align_model` for English), so a run with no `--model` measures what production loads — a harness
whose default lagged production's would measure a configuration nobody ships. **WHICH IS THE ONE THING TO GET
RIGHT WHEN READING AN OLD RECIPE: a `--model`-less command in any pre-W5 gate file or section below ran the BASE
bundle and runs HuBERT-Large now.** Either bundle may be named explicitly, which is also how a model flip's A/B
is expressed: not an `ENCORE_ALIGN_EXPERIMENTS` arm (a model
is not an arm; the summary's `model` and `model_identity` already record it, and `e2e_gates.COMPARED_META`
warns rather than refusing when a comparison crosses models). Every committed row set names the bundle it was
measured on, so `w4-lift-stem.json` and `w4b-lift-stem-hubert-large.json` cannot be read as each other.

**WHAT IT COSTS A BOX**: 4.3-8.6 s per song on MPS against the base model's 2.7-5.2 (XL 11.8-24), and a
one-time weights download of 1.2 GB (XL 3.8 GB) against 360 MB. torchaudio caches those under
`$XDG_CACHE_HOME/torch/hub/checkpoints`, which the container image already points at the persisted
`worker-cache` volume (`docker/worker.Dockerfile`, `docker/compose.yaml`), so it is once per box and not once
per container — no image change was needed for the flip.

**THE TWO SPELLINGS ARE ONE RUN** (W4b review r2): `--model X` and `ENCORE_ALIGN_MODEL=X` resolve to one
bundle (`e2e.resolve_bundle`) and now also to one emitter fingerprint, because `align_model` is kept out of
`align_config` (`e2e_lib.SPELLING_ONLY`). Before that, the env spelling recorded the name inside the
fingerprint, so the recipe above computed 64 matrices cold and `--compare` warned between two runs of the same
bundle; the committed W4b rows all used the flag, and their `align_config {}` is what both spellings now write.

An operator name that no `lexical.CALIBRATED` row covers is REFUSED at startup, with the variable named and
the recalibration command in the message. That is the loud half of "fail loudly or refuse to gate": a matrix
from an uncalibrated model makes every emission-scale gate stand down, which is right for a per-language
bundle nobody chose and wrong for one a person typed. **The bench is the one place that RUNS such a bundle** —
measure-then-paste-the-row needs it to — so it prints a banner instead (`e2e.uncalibrated_banner`), records
`uncalibrated: true` in `run.json` and in the summary's meta, and `e2e_gates` ERRORs any gate that reads
`wrongtext_pass` on such a run: with the lift unreadable the wrong-text verdict falls back to the sheet-span
envelope gate, whose blind half passes **125/320** wrong texts here and **126/320** same-video wrong words, so
a 0.00 in that column would be the envelope gate's number wearing the new bundle's name. `adapters/ml.py` deliberately does not import `lexical`
to make the check itself — that would put every threshold inside the emission cache's code fingerprint, so
moving a band would invalidate all ~1.4 GB of cached matrices — so the refusal lives in `__main__` and a
hermetic test holds `default_align_model` to the table (`tests/test_lexical.py`).

### The corpus sweep, and why the flip is an operator's choice rather than the default

**FIVE SWEEPS, 1088 cases each, same code with the bundle named both ways** (`results/w4b-base-{time_text,
run_align}.json` as the control, `results/w4b-hubert-{time_text,run_align}.json` and
`results/w4b-hubert-lines-run_align.json` as the candidate; gate file `gates/w4b.yaml`, per-case digests beside
each row). **The control is exact**: `w4b-base-*` reproduces `results/w4-{time_text,run_align}.json` with every
pooled and per-song delta reading 0.00, so the wave's recalibration machinery, `Emissions.specials` reader,
separator plumbing and model wiring move NOTHING on the bundle W4 measured — every number below is the bundle.

| truth mode, 32 songs | base bundle (= W4) | HuBERT-Large | |
| --- | --- | --- | --- |
| Jamendo line ±500 | 96.42 | **97.69** | |
| Jamendo word ±100 / ±300 | 83.25 / 94.98 | **85.38 / 97.12** | |
| Jamendo AAE / MedAE | 87.8 / 38.2 ms | **72.3 / 37.5 ms** | |
| TV highlight (Jamendo) | 77.10 | **81.03** | |
| word end ±100 / phrase-final ±100 | 80.02 / 59.83 | **80.37 / 60.79** | |
| pooled gross lines | 3 | **7** | ← MUST FAILS |
| `hello` ±500 | 97.26 | **90.28** | ← MUST FAILS |
| `tfr-chosen` ±500 | 73.53 | **63.64** | ← MUST FAILS |
| worst Jamendo song at word ±300 | — | **−1.74** (Tom_Orlando) | ← MUST FAILS (bound −1.0) |
| `Pure_Mids_-_The_Leader` ±500, scored | 68.42, 19/20 | **100.00, 20/20** | W4's open item, closed |
| blind pooled / Jamendo / YouTube gross | 106 / 40 / 66 | **68 / 27 / 41** | |
| jit / credit / drop50 / drop20 pooled gross | 37 / 28 / 305 / 42 | **5 / 7 / 170 / 20** | |
| wrong texts passed (time_text / ownclock) | 1/320 / 0/320 | **0/320 / 0/320** | |

`gates/w4b.yaml` reads **19/30 at `time_text` AND 19/30 at `run_align`**, failing the same eleven names (the
bench read 16/21 before W4b review r2 split MUST 2's nine summed claim modes into one gate each — same rows,
same verdict, arithmetic that cannot cancel a regression); review
§3 item 6's own list (`gates/w4b-hubert.yaml`) reads **20/22 at both levels** (18/20 as the bench read it;
review r1 added the two AAE gates, both PASS), failing
`no-jamendo-song-worse-at-word-pm300-truth` and `e2e-gross-down-truth`. Under `--sync-mode lines` the candidate
is strictly better than W4: `gates/w3-lines.yaml` **37/38 against W4's 34/38** (drop20 and drop50 commit one
more song each, `drop20-text-pm500` 92.56 → 95.25, wrong texts 0/640 either way), with the one shared failure
`zero-pm500-documents-not-up` at 15 against W4's 14 and a bound of 13.

**THE COST LOCALISES AWAY FROM THE DECODE, which is why it is worth someone's time rather than a dead end.**
Both big losers get BETTER blind and worse with claims: `hello` blind ±500 61.64 → 75.00 with gross 16 → 6,
while its truth row loses ~5 lines and its confidence rises `medium` → `high`; `tfr-chosen`'s reconcile verdict
degrades `structural` → `coarse` on a lift that ROSE (2.21 → 5.28). A better decode moves the claim fit into a
coarser map and the coarser map displaces lines — the same shape as W4's own two >1 pt `truth` ±300 songs, and
the bounded investigation a wave that wants this flip owes first.

**THE RE-READ W4 ASKED FOR** (truth ±500, both levels agree to 0.02 pt): `numb` 42.86 → **54.29** and blind
42.86 → 51.43, so the better model does fix numb; `bad-guy` 4.35 → **1.45** with blind 5.80 → 7.25 and gross
5 → 4, so it does NOT fix bad-guy — under 8% of its 69 scored truth lines land within ±500 ms under BOTH
bundles, and whatever bad-guy is it survives a 3.6× model.

### The recalibration, which is what the flip waited for

Every threshold the wrong-text gates read is an emission scale's, and W4 left the base row's stem head-room at
**+0.0082** — thin enough that a model that shifts the scale could close it. So the whole recipe was re-run on
HuBERT-L before any flip was considered: the same 832 texts per target, the same shipped decoder, the same 32
songs. Rows: `results/w4b-lift-{stem,mix}-hubert-large.json` and `results/w4b-line-gate-hubert-large.json`
(`lift_gate.py --from` / `line_gate.py --from` re-print them without decoding anything).

| | base model | HuBERT-Large |
| --- | --- | --- |
| stem right min (protected + drop50) | +0.2638 | **+0.7660** |
| stem wrong max (Jamendo / YouTube+tfr) | +0.1918 / +0.1244 | **+0.1990 / +0.2194** |
| stem gap, and the floor's head-room | +0.0720, floor 0.2 clears by +0.0082 | **+0.5466, floor 0.45 clears by +0.2306** |
| stem bands | refuse < 0.2, doubt < 0.3 | **refuse < 0.45, doubt < 0.8** |
| mix wrong max (Jamendo / YouTube+tfr) | +0.102 / +0.115 | **+0.1157 / +0.1098** |
| mix floor, and what it costs | 0.15: 48/192 right texts, 7/32 truth | **0.15: 10/192 right texts, 1/32 truth** |
| mix doubt band top | 0.6 (104/192 right texts inside) | **0.4 (9/192 inside)** |
| rung's decode-agreement share | 0.5: 32/416 right texts refused, 0 gross | **0.5: 13/416 refused, 0 gross** |

- **The populations separate by 7.6× more on a stem.** Every one of the 192 right texts lifts at least +0.766
  (truth +1.132..+5.649, median +3.832) and no wrong text of the 640 reaches +0.22, so the floor's head-room
  is 3-8 redraw SDs (0.03-0.07, `lexical`'s REDRAW NOISE) instead of the base row's one. Held out: τ fitted on
  Jamendo (+0.514) refuses 0/60 protected right texts and 0/12 drop50 on YouTube+tfr and passes 0/240 wrong;
  at the shipped 0.45 the pooled sweep refuses **0/192** right and passes **0/640** wrong.
- **`ok_from` is the one rule this recalibration had to restate.** It was "the higher of the two splits' own
  fits, rounded up", which reproduces the base row's 0.30 by coincidence: a split fit is (weakest protected
  right + highest wrong) / 2, and the YouTube split has no weak right song under HuBERT (+2.085), so it fits
  +1.152. Rounding that up would put five protected right texts of ONE song in the doubt band — Avercage,
  truth +1.132, `low` lines and unvouched on a stem, a song the base row grades OK — and buy nothing, since no
  wrong text reaches +0.22. The rule now states what the band is for: the smallest 0.05 step above the weakest
  drop50, never above the weakest PROTECTED right text. It reproduces the base row exactly (+0.2638 → 0.30,
  under +0.3483) and fits HuBERT-L at **0.80**, holding one drop50 and no wrong text.
- **On the mix the floor does not move, but its cost collapses.** 0.15 is still the smallest step above both
  splits' wrong maxima, and it now refuses 10 of 192 right texts and ONE of the 32 truth texts — Avercage at
  -0.005, whose blind decode really is unheard (2% of lines within 1 s, 40 of 42 more than 2 s out) — against
  the base row's 54 and 7 (`results/w4-lift-mix.json`; W3's 48 was on the old clock), where "the matrix barely
  hears it" did not hold case by case. The gate it replaced
  (`h3-mix-envelope`) refuses **78 of 192** right texts on these rows while passing **290 of 640** wrong ones,
  so W4 review r1's flip reads the same on the better model, only more so.
- **`mix_ok_from` 0.4** is read off the per-band timing table, as the base row's 0.6 was: the poorest published
  blind decode is never-be-alone at +0.251 (13% of lines within 1 s), the next text up is The_Rinn at +0.423
  (76%), so the doubt band holds exactly the one song the mix's matrix barely hears and the refusal below it
  the one it cannot hear at all. 9 of 192 right texts are inside it, against 108 under the base row's 0.6.
- **The rung's share stays 0.5** — the lowest swept share with no gross line, the same rule and the same
  number — at a quarter of the cost: 13 of 416 right texts refused against 32, 94.8% of shown line starts
  within ±500 ms. 0.4 shows 6 gross lines; 0.6 refuses 32 for no gross-line gain. With the lift at its own
  floor, `wrongtext+ownclock` passes 0/320 (the sheet-span gate alone passes 278).

### What was NOT recalibrated, and why

- `domain/lyrics/ends.py`'s **θ = 0.1** reads the AUDIO's vocal envelope, not the emission scale, so a model
  swap does not move it. (Its known calibration axis is stem-vs-mix, which is why the post-pass is skipped on a
  mix target — see "Word ends, held through the singing".)
- `align_unsung._NEVER_SUNG_ENV` = 0.10 is the same kind of number (an envelope level), and W4b measured it
  corpus-wide: no relative floor helps. What the model change does to it is not a threshold question at all —
  HuBERT-L simply stops the rule firing on Pure_Mids' real line, because that rule's other two signals are
  the DECODE's (see the probe below).
- `domain/lyrics/generate.ONSET_LEAD_SEC` = **30 ms is the one constant that may still owe a per-model fit**, and it is
  deliberately NOT in `lexical.CALIBRATED`: it is a decode-timing offset, not a log-probability threshold. W4
  re-fitted it on the base model's exact clock (bias crossing zero at 26-27 ms); the review measured HuBERT's
  onset bias at 0 ms on the OLD clock at the old 40 ms lead, which hints that HuBERT wants slightly more lead
  than the base model does. **THE SWEEP ANSWERED IT, and the hint was wrong in the direction that matters**:
  pooled Jamendo `word_bias_ms` under HuBERT-L is **−6.0 ms under truth claims** and **−7.0 ms blind**, against
  the base bundle's −1.3 / −3.1 — the lead is already slightly LONG for HuBERT, not short, so the constant does
  not owe this bundle more lead, and `gates/w4b-hubert.yaml`'s |bias| gate passes with room (7 ≤ 13.1). If the
  flip is ever taken, a re-fit at ~25 ms is the cheap follow-up, not a prerequisite.

### XLarge is nobody's default, and carries three caveats this corpus measured

HuBERT-XL was calibrated the same way (`results/w4b-{lift-stem,lift-mix,line-gate}-hubert-xlarge.json`) and has
its own row: `refuse_below` **0.35** (right min +0.4719, wrong max +0.2778), `ok_from` 0.5, `mix_floor` 0.15,
`mix_ok_from` 0.3, share 0.5 (16 of 416 right texts refused, 0 gross). It separates — 0 of 192 right texts
refused and 0 of 640 wrong texts passed — but by less than L, and on the mix it is worse:

| | HuBERT-Large | HuBERT-XLarge |
| --- | --- | --- |
| stem head-room over the wrong population | +0.2306 | **+0.0722** |
| wrong texts within 2 redraw SDs of the stem floor | 0 of 640 | **2 of 640** (Cortez +0.278, tfr-chosen +0.267) |
| MIX head-room over the wrong population | +0.0343 | **+0.0021** |
| wrong texts in the half-step under the mix floor | 0 of 640 | **3 of 640** (+0.1479, +0.1425, +0.1275) |
| mix floor 0.15 refuses | 10/192 right, 1/32 truth | **25/192 right, 2/32 truth** |
| mix truth blind decode (lines within 1 s) | feel-my-heart 68%, numb 80%, The_Rinn 76% | **51%, 66%, 52%** |

**The MIX head-room is the third caveat and the one the first two hide** (W4b review r1; the base row keeps
+0.0349, L +0.0343, both with nothing in the half-step below the floor). 0.15 is still what the recipe fits —
the smallest 0.05 step above every split's wrong maximum, +0.1479 here — but on a STEMLESS song that floor IS
the wrong-text verdict and a refusal there is terminal, so two thousandths of margin is the number to read
before pointing XL at stemless audio: it is a twentieth of the 0.03-0.07 nats/letter one redraw of the shuffles
moves a near-floor text by. `lift_gate.py` prints this margin for every row since the same review.

The case FOR XL is the review's and is about onsets, not gates (±100 +6.4 pts against L's +4.1; blind Jamendo
gross 14 against 16), and W4b first made it CUDA's default on that basis — the device where 11.8-24 s/song and
3.8 GB of weights are affordable. **THE BENCH TOOK THAT ENTRY BACK OUT, and the reason is one sentence: nothing
in this wave ran XL on CUDA.** No such box exists here, so the accuracy claim is not re-measured on this
corpus, `gates/w4b-hubert.yaml` is written for L against the base model, and shipping an unmeasured bundle as a
device class's default is exactly the "documented projection, not a claim" line W4b's brief drew. XL is
therefore reachable only by name (`ENCORE_ALIGN_MODEL=HUBERT_ASR_XLARGE`); the row that would earn it a default
is one corpus sweep on CUDA hardware, and until then a CUDA deployment gets the same bundle a laptop does —
which since W5's flip is HuBERT-**L**, measured on 32 songs × 16 modes at both levels, rather than the base
bundle. Nothing about XL changed in W5: its ±100 claim is still the review's projection, its stem head-room is
still a third of L's, its mix head-room is still +0.0021, and its `lexical.CALIBRATED` row still carries
`margin_floor_nats=None` — so a box that defaulted to it would run W6's placement-ambiguity rule abstaining,
which is why `tests/test_lexical.py` now holds every DEFAULT's row to being COMPLETE and not merely present.

### The four songs W4 named, re-read under HuBERT-L (probe first, then confirmed on the corpus)

4 songs × truth/blind at `--level time_text`, both models on ONE code, warm matrices
(`_runs/w4b-hubert-probe` against `_runs/w4b-base-probe`, 20 s per arm). The base arm reproduces W4's committed
rows to the digit (Pure_Mids 68.42 with 1 gross, hello 97.26, numb 42.86, bad-guy 4.35), which is also the
determinism check this tree owed after the emitter fingerprint moved.

**THE CORPUS SWEEP CONFIRMED ALL FOUR NUMBERS EXACTLY** (`results/w4b-{base,hubert}-time_text.json`, and again
at `run_align` to within 0.02 pt), so the probe below is no longer the evidence — it is the diagnosis of
evidence the full sweep now carries. Two of these four are also why the flip is not the default: `hello`'s
−6.98 pt and `tfr-chosen`'s −9.89 (a fifth song the probe did not cover) are the wave's MUST 4.

| song, truth claims | base ±500 | HuBERT-L ±500 | gross | lines timed |
| --- | --- | --- | --- | --- |
| `Pure_Mids_-_The_Leader` | 68.42 | **100.0** | 1 → **0** | 19/20 → **20/20** |
| `numb` | 42.86 | **54.29** | 0 → 0 | 35/35 |
| `hello` | 97.26 | **90.28** | 0 → **1** | 73/74 → 72/74 |
| `bad-guy` | 4.35 | **1.45** | 0 → 0 | 69/79 |

- **Pure_Mids: W4's single systematic regressor is GONE.** The base model drops line [0] — *"now that i have
  found you i'm okay"*, a really sung line — as never-sung (`dropped never-sung: [0]` on the trail); HuBERT-L
  drops nothing, and with that line timed SIX more lines snap into place (indices 8-11, 18, 19: errors 0.88,
  1.82, 1.68, 1.75, 3.03 and 0.91 s → 0.00), the gross line goes, and the document reads 20/20 within ±500 ms.
  That is the defect behind ten of `gates/w4.yaml`'s fourteen `jamendo-no-new-gross-*` failures and its
  `truth-jamendo-pm500` failure, and it is the better evidence closing it rather than a looser floor — which is
  what W4b's floor measurement (`unsung_gate.py`) concluded no threshold could do.
- **numb: partly recovered, and the shape says why.** Its line errors are a near-CONSTANT lag — median +0.610 s
  under the base model, **+0.470** under HuBERT-L, p10 −0.01, p90 +0.77, no line over 2 s — so ±500 is a
  threshold sitting inside the distribution and 4 more of its 35 lines cross it (15 → 19). ±1 s is 34/35 either
  way. The recovery is real and it is a 140 ms improvement in a systematic lag, not a fixed decode.
- **bad-guy: INHERENT, and not the decode.** Its errors are a constant +0.864 s median under BOTH models
  (p10 +0.674, p90 +1.057, 0 lines over 2 s, 69 of 79 lines timed) — the whole document is uniformly ~0.9 s
  late against its caption truth — so ±500 counts only the one to three lines whose residual happens to fall
  under the threshold, and the 18.84 → 4.35 → 1.45 sequence is tail noise on a metric that cannot see the
  song's real problem. ±1 s is 54/69 → **57/69** under HuBERT-L, i.e. the model does improve it. Nothing a
  model can do will move ±500 here; the lag is the claim clock's or the caption timeline's, and that is where
  a fix belongs.
- **hello: the one regression, and it is NOT the never-sung rule.** HuBERT-L drops two lines the base model
  timed — `[8] '(fabric rustling)'` and `[9] '(Adele inhaling) (soft piano music)'`, both correctly, since
  neither is sung — and times `[73] '(somber music)'` which the base model dropped, so what it drops is if
  anything better. The ±500 fall is five lines late in the song drifting from 0.14 s to 1.4-1.8 s under the
  REPAIR ladder (index 46 reaching +2.06 s, the one gross line): the same document read BLIND improves sharply,
  gross 16 → **6** and ±500 61.64 → **75.0**. So hello's truth-mode loss is a claims-repair interaction on a
  song of repeated choruses, not a worse decode. **AND IT DID GENERALISE, which is the sweep's answer**:
  `gates/w4b-hubert.yaml`'s `e2e-gross-down-truth` FAILS at 7 against 3 with hello +1, tfr-chosen +3 and
  Tom_Orlando +1, and `tfr-chosen`'s reconcile verdict degrades `structural` → `coarse` on a lift that ROSE.
  `truth-pm500-not-down-1pt` PASSES (90.09, up) because the pooled row absorbs it — which is exactly why the
  wave's own `gates/w4b.yaml` gates the YouTube pool PER SONG and not pooled.

### The shipped refusal on the new row, end to end — and the question the sweep answered

`--songs Lower_Loveday_-_Is_It_Right_,tfr-chosen --modes truth,wrongtext` on the default
(`_runs/w4b-hubert-wrong`, 22 cases, 20 s): the two songs that hold HuBERT-L's highest wrong-text lifts
(+0.174 and +0.219) publish **0 of 20** wrong texts, so the recalibrated floor is a working verdict through the
real step and not just a number in a table, while both truth texts still publish (Lower_Loveday ±500 96.15%
byte-for-byte with W4's base-model row, words ±100 85.4, ±300 97.2, AAE 69 ms).

**THE QUESTION, AND THE SWEEP'S ANSWER — the probe read it right and the corpus agreed: the remaining head-room
under truth claims is gone, and that is what cost the flip its default.** Pooled truth-mode gross 3 → 7 and two
named songs beyond their bound; `gates/w4b.yaml` 19/30 at both levels. The reasoning the probe laid out:
under TRUTH CLAIMS the six songs probed here do not move one way
— Pure_Mids +31.6, numb +11.4, Lower_Loveday ±0, bad-guy −2.9 (tail noise on a constant lag), hello −7.0 and
tfr-chosen 73.53 → 63.64 with 3 gross lines appearing. BLIND they improve clearly (hello gross 16 → 6, bad-guy
5 → 4, numb ±500 +8.6). That is consistent with where the review's gain came from and where W4 spent it: the
review measured "E2E gross with truth claims 25 → ~5" on the OLD 30 s-chunk clock, and W4's exact clock already
took truth-mode gross from 25 to **3** on the base model — so the remaining head-room under truth claims is
gone, and what a better decode now meets is the repair ladder, which was tuned against a worse one. That is now
a measurement rather than a hypothesis, and it names the next wave's job: understand the ladder's and
reconcile's reaction to a better decode (hello's five late-drifting lines; tfr-chosen's `structural` → `coarse`
map on a RISING lift) and the flip is re-read, not rebuilt.


## The line separator: `|` between lines, measured factorially and NOT shipped (W4b, 2026-09-30; review §3 item 6c / D1)

Review D1 is the one DISPUTED item of the deep review — three reviewers split, with a FOR column (line-level
`|` cuts blind Jamendo gross lines 47 → 23, word ±300 91.3 → 93.0) and an AGAINST column (net-negative on 11
songs, never-be-alone 23 → 28, E2E with claims flat at 25 → 26, bias +21 ms). Item 6c's answer was a factorial
of **model × separator**, and four reject-ifs: no Jamendo song more than 1 pt worse at ±300, the Jamendo gross
total not up, E2E gross under truth AND jittered claims lower, TV highlight accuracy not down.

It is BUILT and ships **DEFAULT-OFF behind `ENCORE_ALIGN_EXPERIMENTS=linesep`**, because the decode axis of that
factorial is measured and **fails two of the four on both models** — and one of the two failures is an artefact
of the level it was read at, which is exactly what the remaining half of the factorial has to settle.

### What it does

`domain.lyrics.generate.generate(separate_lines=True)` emits the vocabulary's word separator (`|`, which every
LibriSpeech-lexicon checkpoint maps at id 1 and was TRAINED to emit between words) as a CTC target between
lines — lazily, just before the next line that has a character, so a decorative row is one boundary rather than
two and the target list never starts or ends with one. Its frames are relabelled to blank before `_char_spans`,
which is what lets the grouping stay untouched: a relabelled separator plays exactly the part the blank between
two repeated characters already plays, so `...me` / `each...` still yields two spans. The span check becomes
`spans == targets − separators`, and `regenerate`'s window floor — two emission frames per TARGET — grows with
them. `separator_of` reads the id off `Emissions.specials` (the same mapping the target filter uses, so the
filter that keeps a lyric's literal `|` out of a word and the arm that puts one between lines cannot disagree),
and returns None where the vocabulary names none or maps it to the blank column, which makes the arm INERT
rather than fatal there — the trail note says which.

The GATE decodes are deliberately left alone: `lexical.lift` and the LINE_SYNC rung's decode keep separator-free
targets, because their thresholds are calibrated per model on those (`lexical.CALIBRATED`) and an arm that moved
the population a floor was fitted on would be measuring a recalibration.

### The decode axis, measured (`--level generate --modes blind --songs jamendo`, 20 songs, 868 lines, 5693 words)

Four cells, one at a time, same code, `results/w4b-linesep-{base,hubert}-{off,line}-generate.json`
(+ `.cases.jsonl`). The `off` cells reproduce the recorded rows exactly — base/off is gross 41, ±300 91.45,
bias −3.1 ms, byte-for-byte `_runs/w4-clock-generate` — so W4b's code changes moved no decode by themselves.

| model | separator | gross | line ±500 | word ±100 | ±250 | ±300 | bias | words >2 s | raw end ±100 | highlight |
|---|---|---|---|---|---|---|---|---|---|---|
| base     | off  | 41 | 87.6 | 80.0 | 90.5 | 91.45 | −3.1 ms | 129 | 68.7 | 66.0 |
| base     | line | **29** | **92.6** | 81.0 | 91.9 | **92.85** | −1.9 ms | 115 | 67.7 | 65.1 |
| HuBERT-L | off  | 28 | 90.8 | 82.8 | 93.7 | 94.31 | −7.0 ms | 76 | 64.5 | 64.7 |
| HuBERT-L | line | **15** | **95.4** | 83.8 | 94.9 | **95.49** | −6.4 ms | 53 | 63.9 | 63.8 |

**The FOR column reproduces, and the two axes are nearly additive on gross lines**: the separator is worth −12
gross lines on the base model and −13 on HuBERT-L, where the model swap is worth −13 and −14; 41 → 15 is the
corner. Line ±500 +5.1 / +4.6 pts, word ±300 +1.4 / +1.2, zero-gross songs 6 → 9 and 9 → 11. The bias moves
TOWARD zero on both models (−3.1 → −1.9, −7.0 → −6.4), so D1's "+21 ms" objection does not reproduce on the
exact clock — it was the old 30 s-chunk grid's.

### The per-song spread, which is where the reject-ifs bite

`gross off→line` and the per-song word ±300 delta, both models, never averaged:

| song | base | Δ±300 | HuBERT-L | Δ±300 |
|---|---|---|---|---|
| Avercage_-_Embers | 6→5 | +8.99 | 2→**3** | +2.65 |
| Color_Out_-_Falling_Star | 4→2 | +3.13 | 4→1 | +6.25 |
| Cortez_-_Feel__Stripped_ | 3→0 | +3.38 | 3→0 | +1.12 |
| Explosive_Ear_Candy_-_Like_The_Sun | 1→**2** | +1.13 | 0→0 | +0.75 |
| HILA_-_Give_Me_the_Same | 1→**3** | **−2.48** | 1→0 | −0.31 |
| JASON_MILLER_-_CROWD_PLEASER | 0→0 | ±0 | 0→0 | +0.19 |
| Kinematic_-_Peyote | 0→0 | +1.36 | 0→0 | +2.04 |
| LUNABLIND_-_Vision__Radio_Edit_ | 5→1 | +2.78 | 1→1 | +2.09 |
| Lower_Loveday_-_Is_It_Right_ | 1→0 | +1.89 | 0→0 | +0.94 |
| Moon_I_Mean_-_Wrong_Concept | 0→0 | ±0 | 0→0 | ±0 |
| Pure_Mids_-_The_Leader | 7→5 | +0.88 | 6→3 | +0.88 |
| Quentin_Hannappe_-_Keep_On | 4→1 | +1.72 | 3→1 | +3.43 |
| Ridgway_-_Fire_Inside | 3→3 | +1.65 | 3→3 | +2.63 |
| Rxbyn_-_Bad_Side | 1→**3** | +1.59 | 2→1 | +0.68 |
| Slingshot_Miracle_-_Whistler | 0→0 | ±0 | 0→0 | −0.62 |
| Songwriterz_-_Back_In_Time | 0→0 | +3.36 | 0→0 | +1.68 |
| The.madpix.project_-_One_Way_Street | 1→1 | +3.28 | 1→1 | +1.10 |
| The_Rinn_-_Voices__2017_Version_ | 2→0 | +0.98 | 0→0 | +4.93 |
| Tom_Orlando_-_The_One__feat._Tina_G_ | 2→**3** | +0.60 | 2→1 | −0.40 |
| Wordsmith_-_The_Statement | 0→0 | ±0 | 0→0 | ±0 |

On the base model 12 songs lose gross lines and **4 gain** them, and one song (HILA) is **2.48 pts worse at
±300** — review 6c's 1 pt bound, failed. On HuBERT-L the picture is much cleaner: 7 songs down, **1 up**
(Avercage 2→3), and the worst song at ±300 is −0.62, INSIDE the bound. So the better model does not merely
gain more from the separator, it also localises what the separator costs — which is the one thing the
factorial could not be assumed to show and is the reason it was demanded per model.

### The highlight failure is the LEVEL, not the arm (and this is what the E2E half must settle)

Highlight falls 0.9 pt on both models at `--level generate`, and raw phrase-final end ±100 falls 6.9 / 2.7 pts
with it. That is the mechanism working as designed: the separator takes the boundary frames the previous line's
last character used to absorb, so its END moves earlier — and `--level generate` scores the RAW decode's ends,
which production does not ship. W4's word-end post-pass (`ends.extend_ends`, `domain/lyrics/ends.py`) re-fits
every end from the activity envelope afterwards, and it is what took highlight 66.0 → 77.5 on this very corpus.

A 4-song `--level time_text --modes blind` probe on the default bundle (`_runs/w4b-linesep-ends-{off,line}`,
Cortez / Kinematic / Slingshot_Miracle / Avercage — chosen as the best and worst highlight movers plus the one
song whose gross rose) says the post-pass absorbs nearly all of it:

```
                     gross   line ±500   word ±300   phrase-final end ±100   highlight
  off                    5       83.7        90.7             46.2              79.5
  linesep                3       89.2        92.0             52.8              79.4
```

Highlight −0.1 against −0.9 raw, phrase-final ends **+6.6** rather than −2.7, and the line gains survive
(gross −2, ±500 +5.4, ±300 +1.3). Per song the worst highlight delta is −0.8 (Kinematic) against −4.6 raw.
FOUR SONGS OF THIRTY-TWO AND ONE MODE OF SIXTEEN, so it is a diagnosis and not a verdict.

### The verdict: DEFAULT-OFF, and the E2E axis made it firmer rather than looser

DEFAULT-OFF, arm `linesep`, per PLAN-alignment-v3's rule for an arm that fails a reject-if — and for a DISPUTED
item that is a legitimate outcome, not a failure. `gates/w4b-linesep-generate.yaml` is the decode half and reads
**7/10 on the base model, 8/10 on HuBERT-L**, both REJECT on `highlight-not-down` and `no-song-loses-lines`.

**THE E2E AXIS IS NOW RUN, and it reads 14/22 — REJECT** (13/20 as the bench read it, before review r1 added
the two AAE gates; W4b bench, 2026-09-30; cells A/B, the bundle
production loads, `results/w4b-linesep-base-line-time_text.{json,cases.jsonl}` against
`results/w4b-base-time_text.json`; `gates/w4b-linesep.yaml`'s header carries the full reading). The 4-song
probe was right about the one thing it was run for and wrong about the conclusion drawn from it:

- **The highlight objection IS the level.** `highlight-not-down-truth` 78.63 ≥ 77.10 and
  `highlight-not-down-blind` 78.35 ≥ 77.51 both PASS, against the decode axis's −0.9. With the shipped word-end
  post-pass on, the separator does not cost highlight accuracy at all.
- **But `e2e-gross-down-truth` — review 6c's own reject-if that nobody had read — FAILS, 4 against 3.** So does
  `youtube-blind-gross-not-up` (72 against 66, D1's named counter-example population), so do BOTH per-song ±300
  bounds (truth **−4.27**, blind −2.79, worse than the decode axis's −2.48), so does
  `no-youtube-song-loses-lines-blind` (4 songs) and so does `unsung-not-up-headers` (226 against 221). Seven
  failures, four of them invisible to the decode level.
- **`headers` pooled gross 3 → 12.** An injected section header is a whole line, so the arm gives it its own
  boundary; this is the mode where the separator hurts most and the one a reader should open first
  (`results/w4b-linesep-base-line-time_text.cases.jsonl`).
- **It trades songs, exactly as D1 said.** Truth mode, ±500, movers ≥ 3 pt: Kinematic_-_Peyote **−21.43** and
  numb **−22.86** and tfr-chosen −5.88 (+1 gross), against Avercage +9.53, The.madpix.project +6.67,
  shape-of-you +5.68, Pure_Mids +5.26, bohemian-rhapsody +4.11, Lower_Loveday +3.85. The two worst losses are
  bigger than any gain.
- **The gains are real and are why the arm is kept rather than deleted**: blind Jamendo line ±500 87.64 →
  **91.80**, word ±300 91.58 → 92.75, ±100 80.11 → 81.02, bias −3.1 → −2.0; pooled gross jit 37 → 31,
  drop20 42 → 38, drop50 305 → 236, credit 28 → **5**, blind 106 → 102; truth Jamendo ±500 96.42 → 96.77 and
  word ±300 94.98 → 95.65. A future wave that fixes the `headers` interaction has a real arm to turn on.

Cells C/D (the same pair on HuBERT-Large) were NOT run and are not owed: HuBERT-Large was not the default when
this was measured, so the bundle this arm would have shipped under was the base one, and the arm is off under
both. 6c is CLOSED against the review's own reject-if list on both axes. **W5 FLIPPED THAT BUNDLE** (2026-10-01,
and `gates/w4b.yaml`'s own gates read 28/30 on it after W6's clamp fix), so the sentence above is W4b's record:
the bundle this arm would ship under is HuBERT-Large now, cells C/D are the ones a future wave should measure
first, and an absent `--model` in those recipes resolves to HuBERT-L rather than to the base bundle (the two
`gates/w4b-linesep*.yaml` headers carry the same note; W5 review r1-correctness-9). The arm stays off either way,
so no published number moves with this — only which cell is worth paying for.

## The confidence rule: a per-line grade that separates, and two consumers (W6, 2026-09-30; review §3 item 7)

Review §3.7's opening measurement is the problem: the per-line grade was AT CHANCE. On a line no claim
corroborates, grading fell back to "is this line's text repeated in the sheet?", and over 29 songs the review
measured 12.3% of the lines that rule graded `high` more than 0.5 s off against 12.6% of the ones it graded
`low`. Nothing read the grade either — no reader of per-line `confidence` existed under `core/src/lib` — so
the signal cost a field and bought nothing.

**Reproduced through the shipped path before changing anything.** 20 Jamendo songs, `blind` claims (untimed
text, which is where the fallback decides every line), base model, `--level time_text`, 866 published lines:
**51.5% graded `high`, 11.88% of those more than 0.5 s off, against 12.86% of the `low` ones.** 23 `high`
lines were more than 2 s off. That is the review's number, on this tree, at the grading site.

### The statistic: a max-marginal margin, in `domain/lyrics/margin.py`

For each line, the score gap between the path the decode chose and the best path that puts the line's FIRST
CHARACTER at least `WINDOW_SEC` away from where the chosen one put it. Pure numpy over the CTC trellis the
decode already built — one forward pass, one backward pass, only the queried columns kept, so memory is
O(states + frames × lines) instead of the O(frames × states) a stored trellis needs. **0.43 s median and
0.81 s max per song** over the 20 Jamendo songs (8.5–12k frames each, measured inside `time_text`), and
**1.16 s** on `hello` at 18.3k frames — the longest song measured, and the shape of the cost: it is linear in
frames × characters. The review's numba prototype read 0.09–0.13 s / ~1 s, so the pure-numpy version costs
~4× its median and the same order at the tail, against a model pass of ~4 s. No numba: the critics rejected the decoder swap.

It is a PLACEMENT statistic and not a path score, which is what distinguishes it from the rejected F3/F4:
a path score asks how well these frames match these letters (loud singing of the wrong chorus scores well),
the margin asks whether these letters could have gone somewhere else. Measured here on gross lines, margin
AUROC **0.941** at the review's 3 s reach against the path score's **0.719** — and the review's independent
numba prototype read 0.934, which is the check that this kernel decodes CTC's own trellis.

### `WINDOW_SEC` = 1.0 s, and it is a measured choice rather than the review's 3 s

| W | AUROC gross (>2 s) | AUROC bad (>0.5 s) | median margin | LOSO bad at 51.5% coverage |
|---|---|---|---|---|
| **1.0 s** | 0.904 | **0.821** | 27 nats | **3.59%**, 0 gross |
| 1.5 s | 0.935 | 0.787 | 56 | 4.48%, 0 |
| 3.0 s | **0.941** | 0.771 | 126 | 5.38%, 0 |
| 6.0 s | 0.851 | 0.711 | 257 | 6.73%, 6 |

At 3 s a competing placement is necessarily a different OCCURRENCE — review §3.7's reading, and the best
predictor of gross lines. But the rule is judged on `bad` (>0.5 s), and there the wide window is blind to the
line whose onset is merely a second adrift. At 1 s the statistic is "how far could this start move at all
before the trellis objected", occurrence ambiguity included since a wrong occurrence is an enormous move, and
it is a third better on the reject-if's own number for four points of gross AUROC.

### The rule, and the leave-one-song-out fit

`margin < M` **OR** the raw line score more than 1.0 below the song's median → `low`. One
threshold per signal; no fitted logistic (the critics measured its normalisation failing its own gates).
M lives in the alignment bundle's own calibration row (`lexical.Bands.margin_floor_nats`, review r1-spec-9),
because a margin is a sum of that bundle's log-probabilities and "the row holds every emission-scale threshold
of one model" is the rule that table exists for. A bundle with no fitted floor — `HUBERT_ASR_XLARGE`, whose
trellises nobody here has read — makes the whole rule abstain rather than borrow 10 nats.
M was fitted LOSO with review §3.7's own reject-if as the objective rather than the number the gate reports:
the smallest M whose training `high` set holds no line more than 2 s off. **All 20 folds chose 10** — the
figure §3.7 arrived at independently. The in-sample sweep, on top of the grading the rule joins:

| M (nats) | `high` | coverage | bad among `high` | gross among `high` |
|---|---|---|---|---|
| control (rule replaced) | 446 | 51.5% | 11.88% | 23 |
| 0 (score half alone) | 385 | 44.5% | 7.79% | 11 |
| 2 | 372 | 43.0% | 5.91% | 4 |
| 5 | 344 | 39.7% | 4.36% | 2 |
| **10 (shipped)** | **286** | **33.0%** | **2.80%** | **0** |
| 20 | 230 | 26.6% | 2.61% | 0 |
| 40 | 174 | 20.1% | 2.87% | 0 |
| 80 | 129 | 14.9% | 0.00% | 0 |

Flat from 10 to 40 (bad 2.6–3.1%, gross 0 throughout), so the constant is not on a cliff, and below 10 the
gross lines come back. **The two halves earn different parts of it**: the score half alone takes 23 gross
`high` lines to 11, and the margin takes the remaining 11 to zero. Held out, the rule reads exactly its
in-sample row (33.0% / 2.80% / 0) because every fold chose the same M.

**§3.7's reject-if: PASS.** LOSO bad-among-high at the replaced rule's own coverage (51.5%) is **3.59%**
against the bound of 5.94% — half of 11.88% — and zero gross lines at that coverage. At its own operating
point the rule is better still (2.80%).

*What "at equal coverage" measures, stated because it is not the shipped rule* (review r1-correctness-8). The
shipped rule is a conjunction with ONE operating point and it grades 33.0% of blind lines `high`, so it cannot
be read at another coverage at all; the 3.59% is the two signals used as a **ranking** — each fold's held-out
blind lines ordered by (score-pass, margin) and cut at the baseline's line count — which measures the SIGNALS
at the baseline's coverage. The conjunction's own held-out numbers are the row above (33.0% / 2.80% / 0 gross;
38.8% / 5.65% / 1 at a 3 s window). Two consequences worth naming: the `high` set the ranking cuts out can
include lines the shipped grading calls `low` for a different reason (adopted, disputed, reverted), and the
two baseline coverages the cut is taken at — the replaced rule's 51.5% and the repeat test's — are pooled over
all 20 songs rather than re-measured per fold. The gate the bench actually runs
(`gates/w6-conf.yaml` `bad-among-high-halved-blind`) is the pooled form of the same comparison on the shipped
conjunction, and it is what makes the claim non-circular.

### It transfers to HuBERT-Large with no refit — the bundle this wave is flipping on

The one untested assumption in a threshold on a sum of log-probabilities is whether it survives a change of
bundle. Same 20 songs, same `blind` mode, `ENCORE_ALIGN_MODEL=HUBERT_ASR_LARGE`, nothing re-fitted:

| | `high` | coverage | bad among `high` | bad among `low` | gross among `high` |
|---|---|---|---|---|---|
| base, control | 446 | 51.5% | 11.88% | 12.86% | 23 |
| base, W6 | 286 | 33.0% | **2.80%** | 17.07% | **0** |
| HuBERT-L, control | 446 | 51.4% | 8.97% | 9.26% | 20 |
| HuBERT-L, W6 | 301 | 34.7% | **2.66%** | 12.54% | **0** |

The margin distribution barely moves (median 27 → 33 nats, p10 4 → 5), so M = 10 sits in the same place on
both. Note the control's own two columns on HuBERT-L: 8.97% bad among `high` against 9.26% among `low` — the
replaced rule is at chance on that bundle too, which is the finding reproducing rather than a base-model
artefact. And **HuBERT-L + W6 publishes no `high` line more than 2 s off on any of the 20 songs**, which is
the row the model flip wanted.

### It is read on ONE branch: where the grade rests on our decode alone

Every `high` in `line_confidence` except the last one is a CLAIM independently agreeing with the blind decode
on the blind verdict's own clock, and review H4's argument is that two independent measurements agreeing beats
the decode's own opinion of itself (which is what F3 measured). The margin IS the decode's opinion of itself,
so charging a corroborated line for it double-counts an uncertainty the second witness already settled — and
the measurement says so. On 4 songs × truth/off15/drop50 (516 lines, `Avercage`, `Pure_Mids`, `Tom_Orlando`,
`hello`):

- demoting on **every** branch: 278 → 194 `high` (53.9% → 37.6%), and it found **nothing** — claim-mode
  bad-among-high was already 0.00% and gross-among-high 0.
- demoting **only** where nothing else vouches: **278 → 278.** Not one grade moved on those 516 lines, and
  §3.7's second reject-if ("no claim mode publishes a `high` line more than 2 s off", today 0) holds by
  construction: the rule can only take a line DOWN.

So the signal's whole value is in the uncorroborated population, which is exactly the population the review
measured it on. Whether it fires anywhere in claim mode across the corpus is the bench runner's row.

### The optional half: near-repeat detection, measured and OFF (`conf-fuzzy-repeats`)

`difflib` ratio ≥ 0.8 over normalised line texts, as §3.7 proposes. It finds **49** near-but-not-exact repeats
over the 20 songs, and among the lines the shipped rule already grades `high` it would demote **3** that are
more than 0.5 s off — **none** more than 2 s — and **30** that are correct. End to end: 29.7% coverage /
1.95% bad / 0 gross against the default's 33.0% / 2.80% / 0. A 10:1 loss of correct word wipes for 0.85 pt.
The review's 8 gross lines were `high` under the rule W6 replaced; the margin takes them first, which is what
leaves the arm nothing to buy.

**It is a TEXT statistic and no longer gated on the margin's abstention** (W6 review r2-correctness-5). The
ratio reads line texts, not emissions: no scale, no bundle, nothing to calibrate. It nevertheless sat behind
the whole rule's silence, so on `HUBERT_ASR_XLARGE` — reachable by name, `margin_floor_nats` deliberately
unfitted — `ENCORE_ALIGN_EXPERIMENTS=conf-fuzzy-repeats` produced the DEFAULT grading with nothing on the
trail saying so: a bench row under an arm's name measuring the default path, the mistake `ALIGN_EXPERIMENTS`
refuses unknown names to prevent, arriving from the other side. The arm now fires wherever it is set, except
under `conf-legacy` (the pre-§3.7 grading has no demotion to widen) and on a document already graded `low`
throughout (quadratic work on a fixed grade) — and in both of those the trail says the arm was requested and
what stood it down. The numbers above are unaffected: they were measured on the base bundle, where the margin
floor is fitted and the arm always fired.

### The consumers, because a signal nothing reads is worthless

1. **The TV renders a `low` line LINE-LEVEL.** `wipesWords` in `core/src/lib/tv/lyrics.ts`, read by
   `LyricsOverlay.svelte`'s word branch: no ball, no per-word colours, no accent — the row is lit as one text
   node, which claims only "this line is being sung". A missing grade and `medium` keep the wipe (v1 artifacts
   carry no grade, and `medium` is a DOCUMENT grade).
2. **Candidate ranking reads the aggregate.** `lyricsRank` now scores a word document whose `timingConfidence`
   is `low` as LINE timing (5→4, 3→2). The grade is the per-line verdicts aggregated by the worker, and
   ranking a document as word-timed while rendering it line-level was a contradiction. Before this,
   `lyricsRank` read `timingConfidence` nowhere.
   **The transition anything this worker writes can reach is 3→2** (review r1-spec-17): it sends a
   document-level `low` only for a pin its wrong-text gate would have refused, and sends `vouched: false` with
   it, so both legs move together onto the unauthoritative rungs. 5→4 is reachable only for a row STORED BEFORE
   `vouched` existed — a real population, since core ranks stored documents across jobs, and the reason the
   rule reads `timingConfidence` on its own rather than hiding inside `isAuthoritativeText`.

**The bench port follows the TV** (`e2e_lib.tv_wipes_words`, `TvLine.wipes`, `tv_lit(wipe_low=True)`), and the
parity fixture now carries graded documents so both trees are held to the rule
(`core/tests/unit/lib/tv/bench-highlight-parity.json`, three new shaped documents plus grades on the random
ones). **The pooled `highlight` metric deliberately does NOT read it**: §3.5's word-end post-pass and 6c's
decode axis are both gated on `highlight`, every recorded row since W0 measured it the same way, and folding a
display policy into it would re-baseline those gates and make a future alignment change's highlight number
depend on how many lines the grader happened to doubt. What measures the policy is already on every row:
`high` is how many lines the TV wipes, `high_bad` and `high_gross` are how wrong those wipes are.

**The shipped TV therefore has a metric of its own in the harness, beside that one and gated by nothing** —
`highlight_wiped`, the same computation with `tv_lit(wipe_low=True)` (review r1-tests-20). The split above is
the argument for TWO metrics, not for one: `high` / `high_bad` / `high_gross` are computed from LINE-START
errors on `high`-graded lines, which is not the wipe's question ("when the TV lights a word, is it the right
one"), so the product change that took blind coverage 51.5% → 33.0% had no lit-word number at all. It costs one
more pass over the same breakpoints, re-baselines nothing, and prints beside `highlight` on a group row.

**IT IS NOW MEASURED, on the A/B it exists for** (W6 round-2 re-bench, 2026-09-30, code `622288017e9d268a`:
`results/w6-{base,hubert,legacy}-time_text.json`, the two default-config sweeps plus the `conf-legacy`
control, all three of one tree). Round 1 could not state it — `row_of` gained the field at 19:44 and those
sweeps were written at 16:13, so all 5,636 of their rows lacked it and `highlight_metrics` answered None
(review r2-correctness-2 / r2-spec-8) — and the re-run is what filled it: `grep -c highlight_wiped
results/w6-*.cases.jsonl` is now 680 on each 1088-case run, which is every case that published a document.

| mode (base bundle, Jamendo) | `highlight` (every line wiped) | `highlight_wiped` W6 rule | `highlight_wiped` `conf-legacy` | lines the TV word-wipes |
| --- | --- | --- | --- | --- |
| truth | 77.58 | **66.64** | 66.64 | 718 of 866 |
| jit | 75.52 | **41.31** | 41.31 | 442 |
| extraverse | 76.35 | **60.28** | 60.28 | 674 |
| drop20 | 74.15 | **55.16** | 55.16 | 490 of 695 |
| drop50 | 57.42 | **16.16** | 16.16 | 99 of 431 |
| blind | 77.51 | **25.53** | 40.99 | 286, against the control's 446 |

**Two things to read off it.** (1) The CLAIM modes are unchanged to the digit under the arm, which is the
"grade for grade identical" claim of `gates/w6-conf.yaml` seen through the consumer instead of through the
grades — the rule only ever demotes the branch that rests on our decode alone, and a corroborated line never
reaches it. (2) **The whole price of the rule is on `blind`, and it is 15.46 pt of lit-word seconds**
(40.99 → 25.53) for 11.88% → 2.80% bad-among-high and 23 → 0 gross wipes. `highlight` is 77.51 on both sides
of that, so the lines the rule demotes were lines the TV used to word-wipe and now renders line-level: the
metric is measuring the POLICY, exactly as intended, and the policy's cost is paid on text we hold no claim
for. HuBERT-L reads 72.79 (truth) and 28.75 (blind) on the same runs. No gate reads the column, by design —
§3.5's word-end post-pass and 6c's decode axis are gated on `highlight`, and folding a display policy into
those would re-baseline them.

### What a FAULT in the margin means, and what it used to mean

`_placement_margins` returns `None` — not `{}` — on any fault, and the caller then does not read the rule at
all (review r1-correctness-2 / r1-spec-10). The distinction is the whole of the `conf-legacy` argument applied
to an accident: `margin.low_lines({}, scores)` still applies its SCORE half, so a MemoryError on a long song
used to switch grading silently to the **half-control** arm, which this corpus measures at 385 `high` / 7.79%
bad / **11 gross `high` lines** against the real control's 446 / 11.88% / 23 and the shipped rule's 286 / 2.80%
/ **0** — three different rules, one of them chosen by an exception. The except clause is now every exception
rather than a guess at two (`InfraFault` still propagates: a machinery failure must not be swallowed into a
grade), and the trail says which of the **five** silences it is, in five different sentences: the `conf-legacy`
arm, a bundle with no fitted margin floor, a document already graded `low` throughout (where no margin could
change a grade, so the passes are not bought — review r2-spec-11), a FAULT, which names the exception type, and
a matrix that carried no path to compare. The arm and the fault printed the SAME sentence until W6 review
r2-spec-7 read them against each other, which meant a default-on grading rule silently falling back to the
rule it replaced was indistinguishable from an A/B an operator asked for — and `_placement_margins` catches
every exception by design, so there was no crash to find either.

### What this owed — PAID, see "The W6 corpus sweep" below

The corpus sweep. Every number above is 20 Jamendo songs on `blind` (the population the rule decides) plus a
4-song claim-mode probe, on the base model. The bench runner owes the pooled claim-mode rows on both models —
`high`, `high_bad`, `high_gross` per mode, which are the wipe's coverage and precision — and the YouTube half,
where the review measured the margin weaker (AUROC 0.898 against 0.934, and its two-signal rule flagging
71% of gross lines against 94%).

**Read 2026-09-30 over the whole corpus against a `conf-legacy` run of the same tree** (the pair the arm
exists for): all 13 timed claim modes are grade for grade IDENTICAL — `high`, `high_bad` and `high_gross`
equal to the line on every one, `high_gross` 0 — so the 4-song probe generalised exactly. `blind` is the only
mode the rule moves, and the YouTube half IS weaker, as the review predicted: Jamendo `high` 446 → 286,
bad-among-high 11.88% → **2.80%**, gross `high` 23 → **0**; YouTube 466 → 353, 30.04% → **24.36%**, gross
22 → **3**. The three surviving YouTube gross `high` lines are the one reject-if this wave does not close.

## The clamp's left floor was the bug, not the ladder (W6, 2026-09-30; W4b's carried question)

W4b rejected the HuBERT-Large flip on three MUSTs, and its own verdict localised the cause away from the
decode: both big losers get BETTER blind and worse with claims (`hello` blind ±500 61.64 → 75.00 with gross
16 → 6, against truth 97.26 → 90.28), so "the cost is the repair ladder's reaction to a better decode". This
wave was told to bound the ladder with W6's confidence signal and re-try the flip. **The hypothesis was
wrong, in a way the corpus is unambiguous about, and the real site is one line of arithmetic.**

### What the ladder actually does, instrumented line by line

A monkeypatch-only probe (`_review-scratch/w6-ladder/probe.py`, driven through the harness's own
`TimeTextDriver`, so the repo is untouched and the trace is of the shipped code) recorded, for every line of
3 songs × truth/jit/off15 and of the whole corpus at `truth`, on BOTH bundles: the blind start, the claim's
raw and mapped start, reconcile's verdict and per-line judgement, which repair stage fired in which window,
the adoption test's inputs, W1's provenance, `_clamped`'s before/after and the published error. It reproduces
`results/w4b-{base,hubert}-time_text.json` case for case on gross and w500.

  * **THE LADDER BREAKS ZERO CORRECT BLIND LINES**, corpus-wide, on either bundle. The rule this wave was
    asked to build — a repair may not overwrite a placement the decode is confident about — would have been
    inert.
  * **EVERY ONE of HuBERT's new gross line starts under `truth` claims is manufactured AFTER the ladder
    finishes**, by `_clamped_v2`'s left floor `low = max(line.start, previous_published_end)`: 5 new gross
    lines whose pre-clamp error is ≤ 0.75 s and whose published error is +2.06 to +7.63 s, plus 2 the base
    bundle also loses. The floor also costs 27 lines their 500 ms band on HuBERT-L and 37 on the base bundle.

**And the floor is not independent evidence — it is the blind decode's own boundary.** Where the decode
smears a line across the next line's audio, it also puts the next line's start at the smear's end, so the two
numbers coincide and pushing the repaired start onto `previous_end` reinstates exactly the error the repair
removed. Three exhibits, all at `truth`, HuBERT-L:

| song | line | truth | the ladder's start | `previous_end` | published | the blind decode had it at |
|---|---|---|---|---|---|---|
| `hello` | [46] `♪ Outside ♪` | 260.52 | 260.66 (adopted) | 262.58 | 262.58 | **262.58** |
| `Tom_Orlando` | [70] | 197.81 | 197.81 (adopted) | 200.96 | 200.96 | **200.96** |
| `The_Rinn` | [44] | 218.88 | 218.88 (adopted) | 226.51 | 226.51 | 226.51 (a 9.57 s adopted span) |

### The fix: resolve the overlap at the neighbour's END

`_clamped_v2` now pulls the preceding line's END back onto the repair (`_pulled_end`) instead of pushing the
repair forward onto that end. A line END is the weaker of the two measurements — W4 item 5 exists because
ends run late, and the repaired start carries the claim clock and the corroboration test behind it — and only
the end moves: the neighbour keeps its start, its order, its existence and its grade. Its one refusal is
borrowed from the `m2-order-clamp` arm's `_fitted_run` rather than invented, so the fix introduces **no new
constant**: one decoder frame per letter, below which the line is ordered but is no longer a timing anyone
decoded.

**The pull is `generate.trimmed`, not `remapped`, and that is measured.** An affine re-fit of the whole
neighbour moves onsets that were already right; `trimmed` keeps every onset the decode measured before the new
end and re-fits only the tail it smeared past it. Priced on 20 Jamendo songs at `truth`, base model, through
the shipped `time_text` (`_runs/w6-{clamp,tail}-jamendo`), against W4's row that these must not regress:

| Jamendo truth | W4 / W4b base row | affine `remapped` | tail-only `trimmed` |
|---|---|---|---|
| word ±100 | 83.25 | 83.12 | **83.52** |
| word ±250 | 93.96 | 93.92 | **94.08** |
| word ±300 | 94.98 | 94.98 | **95.04** |
| PCO@0.3 | 86.47 | 86.47 | **86.53** |
| word AAE | 87.8 ms | **86.5 ms** | 86.7 ms |
| word MedAE | 38.2 ms | 38.5 ms | **38.2 ms** |
| word end ±100 | 80.02 | 79.87 | **80.02** |
| phrase-final end ±100 | 59.83 | 59.66 | 59.23 |
| line ±500 | 96.42 | **97.00** | **97.00** |
| line gross | 3 | **1** | **1** |
| highlight | 77.10 | 77.45 | **77.58** |

So the tail-only pull is back at or above the W4 row on every ONSET metric where the affine one sat 0.1–0.2 pt
under four of them, at the cost of phrase-final end ±100 (59.23 against 59.83 on two more scored ends: the
trimmed line's last word now ends at the boundary, and that word is a phrase-final one). It also makes the
clamp's order property structural rather than guarded — `trimmed` never moves a line's FIRST onset, so a pull
cannot invert against the line before it, and the explicit order guard `_pulled_end` carried while it used
`remapped` (measured at 0 firings in 64 song-modes) is now unreachable and gone.

Priced OFFLINE over the instrumented dumps (`_review-scratch/w6-ladder/{clampsim,clampfit}.py`: the clamp's
word-level inputs for 32 songs × {truth, off15} × both bundles, every variant re-run on the same pre-clamp
series, with the shipped floor reproducing the recorded `after` series in 128/128 cases). `gross` is line
starts more than 2 s from truth, `w500` within 500 ms of 1548 HuBERT / 1591 base scored lines, `ooo` the word
starts that precede the word before them — one of which makes `policy.decide` drop the whole text to line sync.

| left floor | HuBERT-L truth | base truth | HuBERT-L off15 | base off15 |
|---|---|---|---|---|
| `previous_end` (before this wave) | 7 / 1376 / 1 | 3 / 1408 / 0 | 7 / 1374 / 0 | 3 / 1408 / 0 |
| the neighbour's LAST WORD start | 7 / 1381 / 0 | 3 / 1417 / 0 | 7 / 1378 / 0 | 3 / 1415 / 0 |
| pull the end back, unguarded | 0 / 1387 / 0 | 1 / 1427 / 0 | 0 / 1382 / 0 | 1 / 1422 / 0 |
| **pull the end back, guarded — SHIPPED** | **0 / 1390 / 0** | **1 / 1428 / 0** | **0 / 1386 / 0** | **1 / 1425 / 0** |
| … only where `margin.low_lines` doubts the line | 3 / 1388 / 1 | 3 / 1418 / 0 | 3 / 1386 / 0 | 3 / 1418 / 0 |
| … only where it doubts the NEIGHBOUR | 5 / 1380 / 1 | 3 / 1418 / 0 | 5 / 1378 / 0 | 3 / 1418 / 0 |
| … where it doubts EITHER | 3 / 1387 / 1 | 3 / 1421 / 0 | 3 / 1385 / 0 | 3 / 1421 / 0 |
| no left floor at all | 0 / 1388 / 53 | 1 / 1428 / 64 | 0 / 1383 / 62 | 1 / 1423 / 66 |

Read it three ways. (1) **Clamp-manufactured gross line starts go to ZERO on both bundles** — base's remaining
1 is `Pure_Mids`, gross before the clamp ever runs, which the "no floor" row proves — and 12–20 lines come back
into the 500 ms band, while `ooo` goes DOWN, from the one inversion the old floor published to none. (2)
**Dropping the floor entirely** reaches the same accuracy and publishes 53–66 inversions, so the floor really
is load-bearing and this is a bound on it rather than its removal. (3) **W6's confidence was measured here and
is NOT what bounds it**: gating the pull on `margin.low_lines` — this wave's brief — is strictly worse on gross
in every column, because the margin grades where a line's own first character sits and the conflict is between
a repaired START and a neighbour's END, which no per-line placement statistic reads.

Volume, so the exposure is not a pooled abstraction: 70 pulls on HuBERT-L and 101 on the base bundle out of
333 / 431 repaired lines, 39 / 43 of them on a line the ladder had NOT repaired; median overrun pulled back
0.47 / 0.41 s. The frame-per-letter refusal fires 4 / 3 times and is worth +3 / +1 lines in the band.

**And every pull is now on the audit trail** (review r1-spec-15 / r1-tests-19). It is the one published timing
this worker changes on a line NO stage repaired, and nothing recorded it: `provenance` is deliberately untouched
— grading reads starts, and the pulled line keeps its start, order, existence, grade and every onset it measured
before the boundary — so `_sources_why` reports such a line as wholly the blind decode's, which it is, and a
"the ball hangs on the last word of line [45]" report had no answer short of re-running the ladder. `_clamped`
now returns `{index: seconds of overrun removed}` and `_pulls_why` prints the count, the median overrun and the
indexes beside the other repair notes, capped at the same twelve the provenance clause caps at (101 a pass is
why that cap matters).

### Measured END TO END on the shipped code, 15 songs × 13 claim modes

The 195 cases the `m6-window-spare` pricing below already had to run (base model, `time_text`, the 15 songs
whose never-sung rule ever drops a line, every timed claim mode; `_runs/w6-wspare-default`), against W4b's own
recorded rows for the same cases (`results/w4b-base-time_text.cases.jsonl`) — **and the offline simulator above
predicted all 15 of the `truth` column's per-song `pm500` and `gross` digits exactly**, which is what makes it
a fair instrument for the 17 songs and 2 modes it was read on:

| over 195 base-model song-modes, 8803 scored lines | W4b | this tree |
|---|---|---|
| gross line starts | 275 | **234** (−41) |
| lines within ±500 ms | 7849 | **8035** (+186) |
| `high` lines (what the TV wipes) | 5380 | 5378 |
| `high_bad` (wiped and more than 0.5 s off) | 15 | 15 |
| `high_gross` | 0 | **0** |
| documents whose bytes changed | — | 129 / 195 |
| song-modes whose SCORE changed | — | 102 |
| outcome or reconcile verdict changed | — | **0** |

No song-mode GAINED a gross line. The biggest individual gains are `The_Rinn` (2 → 0 gross in 12 of 13 modes),
`tfr-mayday` drop20 (3 → 0), `tfr-chosen` (5 modes), `LUNABLIND` drop20 and `Songwriterz` drop50 (2 → 0 each),
`never-be-alone` (+3 to +9 band lines in 8 modes) and `bohemian-rhapsody` (+2 to +5 in 8). The losses are
`never-be-alone` tempo098/tempo102 (−5 each), `hello` jit (−3) and drop20 (−2), and ten single lines spread
over `LUNABLIND`, `Cortez`, `Ridgway`, `Songwriterz`, `shape-of-you` and `bohemian` jit.

### It does NOT make HuBERT-Large the default — and the reason is now specific

With the floor bounded, `pooled-gross-not-up-truth` and `no-youtube-song-gains-gross-truth` (the two
`gates/w4b.yaml` MUSTs the clamp was manufacturing) **flip to PASS at `truth`**: pooled gross base 1 / HuBERT
0, where it was 3 / 7, and no YouTube song gains a gross line. What does NOT pass is `MUST 4`'s per-song
±500 floor, and it gets *worse*, because the fix helps the control more than the candidate:

| song (truth ±500) | old floor: base → HuBERT | bounded floor: base → HuBERT |
|---|---|---|
| `tfr-chosen` | 73.53 → 63.64 (−9.89), gross 0 → 3 | 85.29 → 69.70 (−15.60), gross 0 → 0 |
| `hello` | 97.26 → 90.28 (−6.98), gross 0 → 1 | 97.26 → **100.00** (+2.74), gross 0 → 0 |
| `tfr-flyaway` | 100.00 → 94.67 (−5.33) | 97.33 → 94.67 (−2.67) |
| `never-be-alone` | 79.55 → 95.65 (+16.11) | 97.73 → 93.48 (−4.25) |
| `bohemian-rhapsody` | 93.15 → 95.83 (+2.68) | 98.63 → 95.83 (−2.80) |
| `bad-guy` | 4.35 → 1.45 (−2.90) | 4.35 → 2.90 (−1.45) |
| `numb` | 42.86 → 54.29 (+11.43) | 42.86 → 54.29 (+11.43) |

`hello` — W4b's named loss — is repaid outright and then some. What is left on `tfr-chosen`, `never-be-alone`
and `bohemian-rhapsody` is **not a decision site**: line by line it is a scatter of sub-second band-boundary
misses (tfr-chosen's base lines sit at a constant +0.32 and HuBERT's at +0.59 to +0.97; never-be-alone's and
bohemian's HuBERT lines at −0.53 to −0.81 where the base bundle's are at 0.00), i.e. the two decodes disagree
by half a band on a handful of lines each. No ladder change reaches that. So **HuBERT-L stays reachable by
name** (`ENCORE_ALIGN_MODEL=HUBERT_ASR_LARGE`, its own `lexical.CALIBRATED` row), `ml.DEFAULT_ALIGN_MODEL` is
still the base bundle and `ml.ALIGN_MODELS_BY_DEVICE` is still empty. An honest "not yet".

### `m6-window-spare` re-priced: its recorded costs are GONE, and it is now free — RECOMMENDED, not flipped

W4b left this default-off arm as an open question, because its only recorded costs (W1: Quentin's closing line
back in 4 modes, never within ±500 ms; Ridgway off15 +1 gross) were measured before both the claim clock (W2)
and the exact frame clock (W4), and because W4b had already corrected the other half of the record — the arm
puts `Pure_Mids_-_The_Leader`'s dropped line[0] back at **−0.048 s**, not "more than 2 s out".

Re-measured on THIS tree, arm against default, over the COMPLETE set of songs the arm can act on — the 15 whose
never-sung rule drops a line in any text mode (`results/w4b-unsung-gate.json`; the candidate set is
claim-independent, so those 15 are exhaustive) × all 13 timed claim modes, `time_text`, base model,
`_runs/w6-wspare-{default,arm}`:

| 15 songs × 13 modes | default | `m6-window-spare` |
|---|---|---|
| gross line starts | 234 | 234 |
| lines within ±500 ms | 8035 | **8039** (+4) |
| scored lines | 8803 | **8807** (+4) |
| `unsung` (published lines no truth line pairs with) | 186 | 186 |
| `high_gross` | 0 | 0 |
| documents that differ at all | — | **4** |

The four are `Pure_Mids_-_The_Leader` at `truth`, `jit`, `headers` and `extraverse`, and every one of them is
the dropped line[0] coming back INSIDE the 500 ms band. Nothing else in the corpus moves a byte: **Quentin and
Ridgway do not react to the arm on this tree at all**, so both of W1's recorded costs really were artefacts of
the old clocks, and `unsung-not-up-*` — the MUST family this arm has always been judged on — is flat.

**Recommendation: turn it on, in a wave of its own.** It is not flipped here, deliberately: this wave already
changes the clamp on every repaired line, the bench runner's sweep is the read on that, and sweeping two
default changes together would make neither attributable (PLAN rule 3). The arm closes W4's own open item —
`Pure_Mids` line[0] is the reason `gates/w4.yaml`'s fourteen `jamendo-no-new-gross-*` and `w2.yaml`'s
`truth-jamendo-pm500` sit under a waiver — so it is worth its own 2-sweep read at `run_align` too, the level
this pricing did not cover.

### What this owed — PAID, see "The W6 corpus sweep" below

The corpus sweep, and it is the wave's one open decision. The line-start tables above are `truth` and `off15`
re-scored from the clamp's own inputs, so they cannot see what a changed series does to `decide`'s verdict or to
the remaining 14 modes; the 195-case end-to-end read covers 15 of 32 songs on ONE bundle; and the word-metric
table is 20 Jamendo songs at `truth` only. Nothing at `--level run_align` has been read at all, which is where
the ladder can retry, and nothing on HuBERT-L end to end. The control is
`results/w4b-{base,hubert}-{time_text,run_align}.json`: `align_steps.py` is NOT in the emission cache's code
fingerprint (`e2e_lib.module_closure` reads `adapters/ml.py`'s closure) and W6 changed no onset before this,
which is why the old floor's rows reproduce W4b's per-song ±500 digits exactly here.

## The W6 corpus sweep: what the seven runs accept, and the one thing they still reject (W6 bench, 2026-09-30)

Seven full runs and one 20-case decode check, all on ONE worker tree (code `cad1ca7d2eaf2cf5`; 32 songs, seed
0, `--wrong-k 10`, `--tfr-audio youtube`, MPS, **0 ERROR rows in every one**). They are the read on both W6
items at once, which is only sound because the two change disjoint things and that is CHECKED rather than
assumed (`onsets-unchanged-*` below). 1088 cases per full run, 14–19 min each.

**WHICH tree, exactly** (W6 review r2-spec-8 / r2-correctness-2, which found this paragraph naming the wrong
one): `cad1ca7d2eaf2cf5` is **commit `1c81d89f`'s** tree — `e2e.tree_digest([encore_worker])` `3fcf82c4e299ce21`
plus `harness_digest()` `c447d597a2dabf42`, recomputed off a read-only `git archive` of that commit — and not
the working tree the wave ended on. That review asked for the re-run rather than an assertion, and

**ALL EIGHT RUNS WERE RE-RUN ON THE POST-REVIEW TREE** (round 2, same day, code **`622288017e9d268a`** =
`79b561800ecb8e0c | 659fd1f6059f44df`; the `5b6d359e7198ef1c | 874770e76afb9d2f → 7a637386dec75176` this
paragraph predicted was computed before the last two fixes landed and never named a tree that ran). **Every
gate reading in the table below, and every literal in this section, is the round-2 reading and is identical to
round 1's** — so the W6 record now describes the tree the wave ends on, and `results/w6-*.json` all carry
`622288017e9d268a` in `meta.code` with their gate verdicts in `meta.gates`. (The tree then moved ONCE more,
to `9d6233c39ac80716 | 659fd1f6059f44df` → **`73b3ddad4309aaa2`**, and the delta is the `generate.trimmed`
docstring that records this re-read plus the E501 fix it needed — comment bytes only, outside `adapters/ml.py`'s
emission closure, so a re-run reproduces these rows exactly. Said here rather than left for the next reviewer
to find, which is how round 1's gap was read.) What moved between the rounds is
21 of 1088 `time_text` cases on the base bundle and 13 on HuBERT-L, all of them the clamp's tail floor
(review r2-spec-9): one word out of ±100 on `Rxbyn_-_Bad_Side` jit, three gross WORDS gone on
`Wordsmith_-_The_Statement` drop20 under HuBERT-L, and — the one thing the re-run found that round 1 could
not — three `run_align` cases that lose a `line-sync` fallback, below.

| run | `results/` | level / arm | gate files read on it |
| --- | --- | --- | --- |
| the SHIPPED default | `w6-base-time_text` | `time_text`, `--modes all,wrongtext+ownclock` | `w6-ladder` **31/31**, `w6` **29/33**, `w6-conf` **29/29**, `w2` **85/88**, `w0-reproduce-time_text` **8/11** |
| the flip re-tried | `w6-hubert-time_text` | `time_text`, `--model HUBERT_ASR_LARGE` | `w4b` **28/30**, `w6` **32/33** |
| the shipped default, the job | `w6-base-run_align` | `run_align` | `w6-ladder` **31/31**, `w6` **29/33**, `w2` **85/88** |
| the flip, the job | `w6-hubert-run_align` | `run_align`, HuBERT-L | `w4b` **28/30**, `w6` **32/33** |
| the LINE_SYNC rung | `w6-lines-run_align` | `run_align --sync-mode lines` | `w3-lines` **34/38** |
| the confidence CONTROL | `w6-legacy-time_text` | `time_text`, `ENCORE_ALIGN_EXPERIMENTS=conf-legacy` | (it is the `--compare` cell for `w6-conf`) |
| the `m6-window-spare` arm | `w6-wspare-time_text` | `time_text`, `ENCORE_ALIGN_EXPERIMENTS=m6-window-spare` | `w6` **27/33**, `w6-conf` **28/29** |
| (the raw decode, 20 songs) | `w6-generate` | `generate`, blind, Jamendo | `w0-reproduce-generate` **11/11** |

`align_steps.py` is not in the emission cache's code fingerprint and `adapters/ml.py` was not touched, so the
five default-config runs read warm matrices (`computed` 0, 0, 0, 10 and 19 over 1088 cases each); the two ARM
runs pay one model pass per song — 40 and 33 matrices — because `align_config` is part of the key on purpose,
which is the cost the `conf-legacy` control is worth paying (`gates/w6-conf.yaml`'s header argues it). The
round-2 re-run paid NO model pass at all (every arm's matrices were already on disk under the same emitter
fingerprint, the round-2 fixes touching none of the closure's five files): 8 runs, 14–18 min each, ~2 h.

### What the round-2 re-run moved, and the one cost it uncovered (W6 bench round 2, 2026-10-01)

The tail floor (review r2-spec-9) was expected to move word onsets inside a pulled line's collapsed tail "and
nothing else — no line start, no outcome, no verdict, no grade". **At `time_text` that is exactly what it did**
(21 cases of 1088 base / 13 HuBERT-L, 7 songs: `rap-god` ×12, `tfr-chosen` ×3, `hello` ×2 and one each of
`Kinematic_-_Peyote`, `Rxbyn_-_Bad_Side`, `believer`, `feel-my-heart`; no `gross`, `w500`, outcome, verdict or
grade changed at that level, and
the only scored movements are `Rxbyn` jit losing one word from ±100 and HuBERT-L's `Wordsmith` drop20 losing
three gross WORDS). **At `run_align` it also changed three outcomes**, which the scope did not predict, and the
trail names the mechanism in one line: round 1's rows carry
`{"verdict": "retime", "why": "word timing is incoherent (1 out of order) — degrading to the text's own line
timings", "knob": "line-sync"}`, and round 2's do not. The collapsed tail WAS the out-of-order word, so the
coherence check was buying a line-level fallback with it:

| case (base bundle, `run_align`) | W4b (pre-W6) | W6 round 1 | W6 round 2 | reading |
| --- | --- | --- | --- | --- |
| `believer` extraverse | published, 65.75 ±500/text | line-sync, 98.63 | published, **73.97** | round 1's fallback was the degenerate tail's accident; round 2 beats W4b by 8.2 pt |
| `feel-my-heart` credit | published, 94.59 | line-sync, 100.00 | published, **94.59** | exactly back to W4b |
| `rap-god` drop20 | line-sync, 100.00 | line-sync, 100.00 | published, **87.93** | **the one loss no earlier tree had** |

Pooled, that is `run_align` drop20 ±500 90.48 → 88.98, extraverse 90.69 → 89.66, credit 88.72 → 88.61 (and
HuBERT-L drop20 91.97 → 90.82, its own `rap-god` drop20 flipping the same way); `gross` 0 → 0 and
`high_gross` 0 → 0 everywhere, `truth` and `blind` untouched at both levels, and `gates/w2.yaml`'s drop20
displacement allowance (−13.0) holds the `rap-god` loss by 0.93 pt. **No gate in any wave's file reads it**,
which is why it is written out here: one out-of-order word was acting as a canary for a word document the
ladder was right not to trust, and removing the word removed the canary. The open question for the owner is
whether `_pulled_end`'s walk should keep that protection some other way — a coherence check that fires on the
tail's WIDTH rather than on its order — and it is in the PLAN's status log, not resolved here.

### The shipped default: every headline number up, one known cost, and the same at both levels

Read against `results/w4b-base-{time_text,run_align}.json`, the rows this wave replaces. **The Jamendo truth
column is identical to the digit at `time_text` and at `run_align`**, which is itself the finding that the
clamp change lives below the job's policy.

| truth, 20 Jamendo songs | baseline-v2 | W4 | W4b base | **W6 base** |
| --- | --- | --- | --- | --- |
| word ±100 % | 82.54 | 83.25 | 83.25 | **83.52** |
| word ±300 % | 95.33 | 94.98 | 94.98 | **95.04** |
| word AAE ms | 104.0 | 87.8 | 87.8 | **86.7** |
| word MedAE ms | 38.4 | 38.2 | 38.2 | 38.2 |
| word end ±100 % | 73.53 | 80.02 | 80.02 | 80.02 |
| phrase-final end ±100 % | 40.99 | 59.83 | 59.83 | **59.23** (the one cost) |
| highlight % | 67.12 | 77.10 | 77.10 | **77.58** |
| line ±500 % | 97.58 | 96.42 | 96.42 | **97.00** |
| gross lines | 2 | 3 | 3 | **1** |
| songs with 0 gross | 19 | 18 | 18 | **19** |

Pooled over all 32 songs, `truth`: gross 3 → **1**, ±500 89.45 → **90.61**, ±500-of-text 88.18 → **89.32**.
**Pooled gross falls or holds in every one of the sixteen modes** at `time_text` — truth 3 → 1, jit 37 → 31,
off05/off15/off3/offm1 3 → 1, tempo098/102 4 → 1, drop20 42 → 29, drop50 305 → 303, extraverse 5 → 1,
headers 3 → 1, credit 28 → 23, blind 106 = 106, wrongtext 0 = 0, ownclock 0 = 0 — and at `run_align` the same,
with drop20 13 → **0** and drop50 180 → 178. **No song gains a gross line in any mode** (`count(song.gross_up)`
= 0 over the whole 32 × 16 grid, both levels). `high_gross` — a line the TV WIPES that is more than 2 s off —
is 0 in all thirteen timed claim modes on both bundles and both levels.

THE ONE COST, and it is the one `gates/w6-ladder.yaml` predicted: phrase-final word ends, 59.83 → 59.23, on 2
more scored ends (704 against 702), because the trimmed line's last word now ends at the neighbour's boundary.

### Wrong-text protection, at all three rungs

| | `time_text` base | `time_text` HuBERT-L | `run_align` base | `run_align` HuBERT-L | `--sync-mode lines` |
| --- | --- | --- | --- | --- | --- |
| `wrongtext` pass | **1/320** | 0/320 | 0/320 | 0/320 | 0/320 |
| `wrongtext+ownclock` pass | 0/320 | 0/320 | 0/320 | 0/320 | 0/320 |

The one `time_text` pass is the same `LUNABLIND_-_Vision__Radio_Edit_` cross-pair W4b records, and it is the
only document any wrong text committed anywhere (`published + line_sync` = 1 over the 640 wrong-text cases of
the `time_text` run, 0 in the other three). `lines` is 0/640, so the LINE_SYNC rung is still closed to a wrong
text. **`gates/w3-lines.yaml` reads 34/38 with the same four failures and the same digits as W4's own row**
(14 ≤ 13, 31 ≥ 32, 14 ≥ 15, 92.56 ≥ 95.0) — that is, W6 moved nothing at all in `lines` mode, which is what a
change to the repair clamp and to a per-line GRADE should do to documents that have neither.

### The confidence rule, against its own control arm

`results/w6-base-time_text.json` against `results/w6-legacy-time_text.json` — the same code with the rule off,
which is the only pair that isolates it. `gates/w6-conf.yaml` **29/29** (28/29 as the wave first wrote it: the
blind `high_gross` MUST was an absolute pooled zero reading 3, restated under review r1-spec-13 as the two
claims actually held — see the YouTube bullet), and the whole corpus says what the 866-line fit said.

| mode | control `high`/bad/gross | W6 `high`/bad/gross | bad-among-high | coverage kept |
| --- | --- | --- | --- | --- |
| all 13 timed claim modes | *unchanged, line for line* | *unchanged, line for line* | *unchanged* | 100% |
| `blind`, 20 Jamendo | 446 / 53 / **23** | 286 / 8 / **0** | 11.88% → **2.80%** | 64.1% |
| `blind`, 12 YouTube | 466 / 140 / **22** | 353 / 86 / **3** | 30.04% → **24.36%** | 75.8% |
| `blind`, pooled | 912 / 193 / **45** | 639 / 94 / **3** | 21.16% → **14.71%** | 70.1% |

* **The claim modes are grade for grade identical** — `high`, `high_bad` and `high_gross` equal on every one of
  the thirteen, `high_gross` 0 on all of them. The 4-song probe generalised exactly, for the reason the code
  gives: the demotion is read on the ONE branch whose grade rests on our decode alone, and a corroborated line
  never reaches it.
* **No timing moved.** `count(blind.song.onsets_changed)` = 0 and `count(truth.song.onsets_changed)` = 0
  against the control, while 30 of 32 blind DOCUMENTS change bytes — that difference is the `confidence` field
  and nothing else. It is also why `gates/w6-ladder.yaml` and `w2.yaml`'s `blind-unchanged` read a FAIL at 30
  on this tree: both asked for `doc_changed == 0` against a PRE-W6 control, which this wave's grading change
  makes unsatisfiable by construction, and the metric that answers their actual question is `onsets_changed`
  (0). `gates/w6-ladder.yaml`'s gate now reads that one and the file is 31/31 (review r1-spec-11); `w2.yaml`
  is an earlier wave's ratchet and is left alone, with the explanation here. Pooled blind ±500, word ±300 and
  highlight are identical to 2 decimals against both the control and W4b.
* **The YouTube half is weaker, exactly as the review warned** (it measured AUROC 0.898 there against 0.934):
  bad-among-high falls by a fifth rather than a half, and **3 gross `high` lines survive** — the one reject-if
  of this wave that does not close. All three are blind-mode (`hello` 1, `rap-god` 2); every claim mode is 0,
  and the Jamendo half is 0. `gates/w6-conf.yaml` carried this as one absolute pooled `blind.high_gross == 0`
  and therefore as a permanently-FAILING MUST, which is a reading nobody can act on — a fourth such line would
  have changed FAIL to FAIL. Review r1-spec-13 split it into the two claims the tree actually holds:
  `high-gross-zero-blind-jamendo` (absolute zero, the population §3.7's reject-if is written against) and
  `high-gross-blind-at-most-three` (the named bound, so a fourth reads as the regression it would be). The
  residue stays OPEN, not closed: on `hello` and `rap-god` the TV still word-wipes a line more than 2 s from
  where it is sung, and the candidates for closing it are the next-wave list below.
* **The LOSO fit reproduces**, re-run here off the confidence item's own per-line rows
  (`_review-scratch/w6-conf/loso.py`): all 20 folds choose M = 10; held-out bad-among-high **2.82%** at 32.8%
  coverage and **3.59%** at the replaced rule's own 51.5% coverage, against the 5.94% bound (half of 11.88%),
  with 0 gross lines at that coverage. On HuBERT-L the same script reads **2.01%** against a 4.48% bound, M = 10
  in all 20 folds — no per-bundle refit.

### The flip: W4b's rejection was the clamp's doing, and the residue is now ONE gate

`results/w6-hubert-time_text.json` against `results/w6-base-time_text.json` (and the same pair at
`run_align`). `gates/w4b.yaml` **28/30 at both levels**, `gates/w6.yaml` 32/33 and 32/33.

Pooled gross, `time_text` / `run_align`, every cell read off the four `results/` rows:

| pooled gross | W4b base | W4b HuBERT | **W6 base** | **W6 HuBERT** |
| --- | --- | --- | --- | --- |
| truth | 3 / 3 | 7 / 7 | **1 / 1** | **0 / 0** |
| jit | 37 / 27 | 5 / 5 | 31 / 21 | **0 / 0** |
| off05 = off15 = off3 = offm1 | 3 / 3 | 7 / 7 | 1 / 1 | **0 / 0** |
| tempo098 = tempo102 | 4 / 4 | 7 / 7 | 1 / 1 | **0 / 0** |
| drop20 | 42 / 13 | 20 / 8 | 29 / 0 | 12 / 0 |
| drop50 | 305 / 180 | 170 / 94 | 303 / 178 | 167 / 91 |
| extraverse | 5 / 5 | 6 / 6 | 1 / 1 | **0 / 0** |
| headers | 3 / 3 | 2 / 2 | 1 / 1 | **0 / 0** |
| credit | 28 / 28 | 7 / 7 | 23 / 23 | **0 / 0** |
| blind | 106 / 106 | 68 / 67 | 106 / 106 | 68 / 67 |

**W4b's headline rejection is gone.** Its pooled `truth` gross 3 → 7 was the clamp manufacturing line starts
out of the blind decode's own boundary; on the fixed floor the same pair reads 1 → **0**, at BOTH levels, and
HuBERT-L is at or below the base bundle's gross in **every one of the sixteen modes**. It keeps every win the
flip gate required: Jamendo truth word ±100 **85.46** (≥ 85.0), AAE **71.1 ms** (≤ 75), highlight **81.40**
(≥ 80.5), ±500 **98.15**, and `Pure_Mids_-_The_Leader` truth ±500 **100.00** with Jamendo truth gross **0**
(20 of 20 songs clean). The three songs W4b named:

| truth, ±500 (gross) | W4b base | W4b HuBERT | **W6 base** | **W6 HuBERT** |
| --- | --- | --- | --- | --- |
| `hello` | 97.26 (0) | 90.28 (1) | 97.26 (0) | **100.00 (0)** |
| `Tom_Orlando_-_The_One` | 98.61 (0) | 98.61 (1) | 100.00 (0) | **100.00 (0)** |
| `tfr-chosen` | 73.53 (0) | 63.64 (3) | **85.29 (0)** | 69.70 (0) |
| `Pure_Mids_-_The_Leader` | 68.42 (1) | 100.00 (0) | 73.68 (1) | **100.00 (0)** |

**AND IT IS STILL NOT THE DEFAULT.** What fails is now a single gate family, at both levels and for a reason
the ladder cannot reach:

* `no-youtube-song-worse-at-truth-pm500` −15.59 pt: `tfr-chosen` 85.29 → 69.70. The fix helps the CONTROL more
  than the candidate on that song, and line by line the residue is a scatter of sub-second band-boundary misses
  (the base's lines at a constant +0.32 against HuBERT's +0.59…+0.97), not a decision site.
* `no-jamendo-song-worse-at-word-pm300` −1.52 pt: `Tom_Orlando`, whose ±500 is 100.00 on both.
* `w6-no-song-gains-gross` = **8** song-modes at `time_text` and **6** at `run_align`, and every one is in the
  two SEVERE-drop modes or blind, never in a timed claim mode: `tfr-chosen` +3 at drop20 and +1 at drop50,
  `hello` +3, `shape-of-you` +2, `Moon_I_Mean` +1 and `Wordsmith` +1 at drop50, `tfr-mayday` +2 and `Rxbyn` +1
  at blind.

So W6 left `ml.DEFAULT_ALIGN_MODEL` on the base bundle, with the recorded verdict no longer "the ladder breaks
under a better decode" but "three songs' sub-second band arithmetic and two 20–50% drop modes" — a question
about the decode and about `drop`-mode repair, not about the clamp. **W5 TOOK THE FLIP ON EXACTLY THAT READING**
(the orchestrator overruled the per-song clause of its own flip gate on 2026-10-01): see "W5: the flip, landed"
at the end of this file.

### `m6-window-spare` over the whole corpus: 4 documents, +1 line each, and the cost is DILUTION

The arm's own sweep (32 songs × 16 modes) against the shipped default of the same tree. It changes **exactly 4
documents** — `Pure_Mids_-_The_Leader` at truth, jit, extraverse and headers, the complete set its never-sung
rule ever dropped a line from — and in each it recovers line[0] INSIDE the ±500 band (that song's truth ±500
73.68 → 75.00, ±500-of-text 70.0 → 75.0, highlight +2.1 pt; scored lines 19 → 20). Corpus-wide: **0 songs gain
a gross line, 0 songs lose ±500, `unsung` not up anywhere, wrong-text unchanged**, and pooled Jamendo truth
±500 and gross unchanged (97.00, 1).

Its cost is 8 more ALIGNED WORDS, of which 6 miss ±100 and 4 miss ±300 — so the pooled word ratios dilute
without a single existing word moving: word ±100 83.52 → 83.45, word ±300 95.04 → **94.97**, AAE 86.7 → 87.1 ms,
end ±100 80.02 → **80.00**, while highlight goes 77.58 → 77.66 and PCO@.3 +0.1.

**RECOMMENDATION: flip it, in its own wave, together with a re-pricing of the two ratchet literals it trips.**
Those two are `w6-jamendo-word-pm300` (94.97 against a 94.98 bound — one word) and `w6-jamendo-word-end-pm100`
(80.00 against 80.02 — one end), and they fail because a W4 literal set on 5183 words is being read on 5191. A
line the room can see is worth more than 4 badly-timed words in a ratio, but it is NOT worth silently moving a
ratchet, which is why this is a recommendation and not a flip. It still owes a `run_align` read: this sweep is
`time_text` only, and `Pure_Mids` is the song whose `truth` refusal path W4b (b) left open.

### What the rebased gate files read on this tree, and where a rebase IS now owed

`gates/w2.yaml` **85/88 at both levels** against `results/w4-{time_text,run_align}.json`, where the W4b rows it
was rebased onto read **88/88** — so all three failures are W6's, and they are:

* `blind-unchanged` (30 documents): the `confidence` field. `count(blind.song.onsets_changed)` = 0 on the same
  rows. The gate needs the same `onsets_changed` rescoping its W6 siblings need.
* `no-worse-displacement-tempo098` and `-tempo102`, −10.64 pt: **`never-be-alone`**, whose `text_pm500` goes
  68.09 → 57.45 under a ±2% tempo warp while its `truth` goes 74.47 → **91.49** (±500 79.55 → 97.73). Same
  song, same clamp pull, opposite signs: 5 of its 44 lines leave the 500 ms band when the claims are warped.
  No gross line either way, and pooled tempo098/102 gross falls 4 → 1 and ±500 rises. It is a real one-song
  cost in two modes and it is named here rather than folded into the pooled gain.

`gates/w0-reproduce-time_text.yaml` **8/11**. The 7 BLIND literals are exact to 0.00 — pooled gross 106,
±500 78.04, ±1 s 88.76, Jamendo blind words ±100 80.11 / ±250 90.62 / ±300 91.58 / >2 s 122 — which is the
cheapest possible proof that W6 changed no blind timing on 32 songs. The 3 failures are all `truth` and all in
the GOOD direction, by construction: gross 3 → 1, ±500 89.45 → 90.61, ±1 s 98.16 → 98.73.
`gates/w0-reproduce-generate.yaml` **11/11**: the raw decode is untouched, which is the check `generate.py`'s
`char_targets` extraction and the new `trimmed` needed.

**So one rebase IS owed and it is the owner's call**, on the same grounds W4b rebased these files: a determinism
ratchet that fails because the wave did what it was built to do teaches the next wave to ignore it. The three
`w0-reproduce-time_text` truth literals want 1 / 90.61 / 98.73, and `w2.yaml`'s `blind-unchanged` wants
`onsets_changed`. Nothing else in either file moved.

### What this sweep still owes

* **The 3 YouTube blind gross `high` lines** — the wave's one unclosed reject-if, and the only gate failure that
  is a real defect rather than a ratchet or a named per-song cost. The margin's own AUROC is lower on that half;
  whether the fix is a per-group threshold, a second signal or the review's repeat detector is a wave's work.
* **HuBERT-L's drop20/drop50 gross**, 8 song-modes at `time_text`: the flip's last blocker is now in the
  severe-drop modes, which no W6 item touched.
* **`m6-window-spare` at `run_align`**, and the 2 ratchet literals a flip would re-price.
* **`--no-stem`**, `--asr whisper` and the `off1/off5/offm05/offm15/offm3/ownclock` modes outside `all`: not
  measured here on either bundle.

## W5: the flip, landed — HuBERT-Large is the default (2026-10-01)

`ml.DEFAULT_ALIGN_MODEL` is `HUBERT_ASR_LARGE`; `ALIGN_MODELS_BY_DEVICE` is still empty, because the flip is a
BUNDLE result and nothing in it is a fact about MPS; the base bundle stays reachable by name with its
calibration row intact, and `HUBERT_ASR_XLARGE` on CUDA stays a **projection**. No threshold moved: W4b had
already fitted all five of HuBERT-L's numbers (`lexical.CALIBRATED`), which is why landing it was a one-word
change in `adapters/ml.py` plus the gates and docs that called the base bundle "the default".

**NO NEW SWEEP WAS PAID FOR THE DECISION.** Every number below is read off `results/w6-hubert-{time_text,
run_align}.json` against `results/w6-base-*` — the same tree, code `622288017e9d268a`, 32 songs, seed 0,
wrong_k 10, `--tfr-audio youtube`, device mps, with only the bundle's name changed — and every gate reading was
taken offline with `e2e_gates.run_gates` on the two committed summaries.

| truth mode, 32 songs | base bundle (W6, what shipped) | HuBERT-Large (what ships now) |
| --- | --- | --- |
| Jamendo line ±500 | 97.00 | **98.15** |
| Jamendo word ±100 / ±300 | 83.52 / 95.04 | **85.46 / 97.16** |
| Jamendo word AAE / MedAE | 86.7 / 38.2 ms | **71.1 / 37.5 ms** |
| Jamendo word end ±100 / phrase-final ±100 | 80.02 / 59.23 | **80.34 / 60.93** |
| TV highlight | 77.58 | **81.40** |
| pooled gross lines | 1 | **0** |
| zero-gross songs | 31 / 32 | **32 / 32** |
| wrong texts published (`time_text`) | 1 / 320 | **0 / 320** |

**POOLED GROSS IS DOWN OR EQUAL IN ALL SIXTEEN MODES, AT BOTH LEVELS** — `time_text` jit 31→0, credit 23→0,
drop20 29→12, drop50 303→167, blind 106→68; `run_align` jit 21→0, drop50 178→91, blind 106→67 — and
text-denominator ±500 is UP in every claim mode at `time_text`, so no gain is a refusal in disguise. Per song
over the whole 32 × 16 grid the flip REMOVES 268 gross lines and adds 14 at `time_text` (206 and 27 at
`run_align`): `never-be-alone` −74, `hello` −40, `rap-god` −23, `Avercage` −15, `Pure_Mids` −11, `The_Rinn` −11
lead the removals. All three of W4b's named losers are repaid (`hello` truth 97.26→**100.00** and drop20
49.15→**100.00**, `Tom_Orlando` 100.00, `Pure_Mids` 68.42→**100.00**).

**GATE READINGS, both levels, offline:** `gates/w5-flip.yaml` **40/40** (this wave's file: every bar set where
only the new default can reach it, so the base bundle reads 27/40 at `time_text` and reverting cannot read
green); `gates/w6.yaml` **32/33**, the one FAIL being the per-song clause the orchestrator overruled;
`gates/w4b.yaml` **28/30**, the two FAILs being the accepted residuals; `gates/w2.yaml` **88/88** after this
wave rebased it onto `results/w6-hubert-*` (66/88 at `time_text` and 64/88 at `run_align` against the old
base-bundle base, all 22 / 24 failures the flip's own measured effects).

### What the flip costs, named rather than pooled away

* `tfr-chosen` truth line ±500 85.29 → **69.70** at gross **0 → 0** — precision inside the band, not placement
  (its base lines sit at a constant +0.32 against this bundle's +0.59…+0.97). Its scored count moves 34 → 33, so
  part of this is the **caption-cue denominator artefact** W5's text-hygiene item owns: until that lands, no
  per-song ±500 row is comparable across models.
* `Tom_Orlando_-_The_One__feat._Tina_G_` word ±300 **−1.52** pt, against W4b's −1.0 per-song bound.
* **8 song-modes at `time_text` / 6 at `run_align` gain a gross line**, every one in drop20 / drop50 / blind and
  NONE in a timed claim mode. `gates/w5-flip.yaml` holds the claim-mode half at an absolute zero and the
  degraded half at a bound of 8, so a fourth residual reads as a regression instead of as the same old news.
* **At `run_align` only, `shape-of-you` drop50**: the base bundle's LINE_SYNC rung rescued that case (±500-of-
  text 97.83, 0 gross) and this bundle's refuses it, so attempt 1's word document stands (34.78, 21 gross). The
  reason is the rung's own calibrated gate doing its job — this bundle's blind decode starts **42%** of that
  text's 45 lines within 1 s against the base bundle's 51%, under the 0.5 `line_sync_min_agreement` its own
  `line_gate.py` sweep fitted. The share is NOT re-fitted for it: 0.4 shows 6 gross lines on this bundle's
  right-text sweep. The two tempo modes at `run_align` are the same shape, text ±500 89.72 → 88.69 / 88.75.
* **A box pays 4.3–8.6 s a song on MPS against 2.7–5.2, and downloads 1.2 GB of weights once instead of 360 MB**
  — once per BOX, since the image already points `$XDG_CACHE_HOME/torch/hub` at the persisted `worker-cache`
  volume, so no image change was needed.
* **One cold model pass for the bench.** `adapters/ml.py` is in the emission cache's code fingerprint and this
  wave edited it, so the next sweep recomputes its 64 matrices once (~+3.5 min at the base bundle's seconds per
  song, ~+6–9 min at HuBERT-L's) and every later arm at this tree is warm again.

### What W5's flip still owes the bench

* **`--level run_align --sync-mode lines` ON THE NEW DEFAULT.** No lines run exists for HuBERT-Large on this
  tree. The two reads in hand are the base bundle on the W6 tree (`results/w6-lines-run_align.json`,
  `gates/w3-lines.yaml` **34/38**) and HuBERT-Large on W4b's PRE-clamp-fix tree
  (`results/w4b-hubert-lines-run_align.json`, **37/38**, failing only `zero-pm500-documents-not-up` at 15) —
  neither is the tree that ships. **AND A ONE-SONG PROBE ON THE SHIPPED TREE SAYS THIS IS WHERE TO LOOK**
  (`_runs/w5-flip-probe-lines`, `shape-of-you`, truth + drop50): in `lines` mode the rung is the ONLY attempt,
  so the 42%-agreement refusal above is the whole case — that song's drop50 goes from the base bundle's 45
  lines line-synced at 45/45 within ±500 to **refused**, text ±500 100.00 → **0.00** — while its truth text
  line-syncs on both bundles at 91/91 with this bundle's agreement HIGHER (99% against 98%). Expect
  `committed-not-down-drop50` (base 14 against a bound of 15) to read 13.
* **`gates/w6-conf.yaml` cannot be re-read on the new default yet**: its control is a `conf-legacy` run of the
  SAME bundle, and only the base bundle has one (`results/w6-legacy-time_text.json`). The confidence rule's own
  numbers on HuBERT-L are in hand from W6 (LOSO 2.01% against the 4.48% bound; `highlight_wiped` 72.79 truth /
  28.75 blind), and the YouTube blind gross-`high` residue IMPROVES on this bundle — **2** rather than 3, at
  more coverage (353 → 360 `high` lines), with Jamendo still 0 — which `gates/w5-flip.yaml` now bounds at 2.
* **The `m6-window-spare` and `conf-legacy` arms were priced on the base bundle only.** Both are default-off;
  re-pricing them belongs to the wave that flips them, and it is now a HuBERT-L pricing.

### `_pulled_end`'s tail: should coherence be protected by WIDTH instead of by order? (owner question, answered)

W6's round-2 tail floor let the trimmed tail keep one decoder frame per word, which removed the out-of-order
word that `policy.decide`'s coherence check had been using as a canary: three base-bundle and one HuBERT-L
`run_align` cases stopped degrading to `line-sync` and published their word documents instead, and `rap-god`
drop20 went 100.00 → 87.93 (90.80 on the new default). The question was whether `_pulled_end` should keep that
protection by the tail's WIDTH rather than by order. **MEASURED, AND THE RECOMMENDATION IS NO.**

* **What the canary bought was a document with NO word timing at all.** Every `line-sync` case in the corpus
  scores `highlight` **hit 0.0** of the song's whole sung time — all 9 of the Jamendo ones across
  `results/w6-{base,hubert}-run_align.cases.jsonl` (6 and 3; the YouTube ones have no word truth to score) — so
  on `rap-god` drop20 the trade is 16 of 174 line starts moving out of the 500 ms band — at **gross 0 and
  `high_gross` 0**, i.e. no line more than 2 s off — against all **1213** word onsets of a 174-line song. This
  codebase has already decided that direction twice, in `report.usable` ("a handful of smeared or flashed words
  beats losing per-word timing everywhere") and in the policy ladder that prefers a word document to a sheet.
* **A document-level width rule is far too blunt for the defect.** On the bundle that now ships, **31 of 448**
  published word documents at `run_align` carry at least one line whose tail words sit closer than one decoder
  frame apart (38 lines in all, tail widths 0.008–0.18 s; 27 of 448 and 45 lines on the base bundle,
  `rap-god` dominating both, which matches `_pulled_end`'s own count). A rule that degraded all of them to line
  timing would throw away 31 documents' word timing to move one document's lines into the band.
* **The right shape is per LINE, not per document, and the consumer for it already exists.** `_clamped_v2`
  returns `{index: seconds of overrun removed}` and `_pulls_why` already reports it, so the trimmed line can be
  graded `low` — which W6's TV consumer renders line-level, without a word wipe (`wipesWords`) — leaving the
  other 173 lines their word timing. Like W6's margin demotion it can only take a line DOWN, so `high_gross`
  cannot rise. It is not built here: it would move `highlight_wiped` and the confidence rule's coverage, which
  are §3.7's numbers and belong to a wave that re-reads them against `conf-legacy`.

## W5: text hygiene — the caption cue is NOT a lyric, and that is a DENOMINATOR fix (2026-10-01; review §3.8)

Review §3.8's items (M11 anchored section headers, L3 syllabify, M12 rolling auto-captions, L4 `parse_lrc`,
M13 every-provider-a-candidate, L5 duration retry), plus the one thing W6's diagnose task found and no
review item had a name for: **a caption track's non-lyric cues were deciding how many lines a song scored.**

### The artefact, and why it is a correctness bug rather than an accuracy one

A caption track carries `(fabric rustling)`, `(Adele inhaling) (soft piano music)`, `(somber music)`,
`[RINGING SOUND]`, `("Rap God" by Eminem)`, an uploader credit. Nothing on the TEXT side dropped them, so they
became CTC targets, were published as words to sing, and were then removed — **or not** — by the ACOUSTIC
never-sung rule, which measures that nothing was sung in a line's span. That rule drops a DIFFERENT subset
under each bundle: HuBERT-Large drops hello's `(fabric rustling)` and `(Adele inhaling)…` and times
`(somber music)`; the base bundle does the opposite. So a song's **scored line count moved with the acoustic
model** (hello 73 → 72, tfr-chosen 34 → 33), and no per-song ±500 ms row was comparable across bundles — 2 of
hello's 6 "lost" lines at the flip were this and not timing at all. A text-side judgement is
model-independent by construction, which is the entire point.

### Four ANCHORED rules, in `domain/lyrics/nonlyric.py`, and one deliberate non-rule

`clean.py` had already measured and REJECTED three unanchored rules, each because it destroyed real sung
words — most relevantly "drop whole-line parentheticals by a sound-effect vocabulary", which also eats
`(Beat it, beat it)`, `(Play that funky music)`, `(Drop the beat)`, `(the beat goes on)` and `(bells
ringing)`. `(bells ringing)` against `(fabric rustling)` is the same two words in the same shape, so the
discriminator cannot be the words.

| rule | what it reads | counter-example it must not eat |
| --- | --- | --- |
| R1 whole-line section header | an ALLOWLIST, and a bracket or a colon | `Chorus` / `Hook` / `Break` bare; `[GO!]`; `[Люблю тебя]` |
| R2 a `CHORUS:` / `Verse 2:` PREFIX | the same allowlist; the rest of the line is kept | `Baby: I love you`, `Mama: don't cry` |
| R3 the author's own MUSIC NOTE | in a track that notes its sung lines, an UNNOTED line is not sung | `♪ (Oh-I-oh-I-oh-I-oh-I) ♪`, `♪ … (Ha!) ♪` |
| R4 a YouTube ASR marker | the CLOSED machine set `[Music]` / `[Applause]` / `[Laughter]` | `[somber music]`, `(soft piano music)`, `Music` |

**R3 IS THE RULE THAT ANSWERS THE CUES, and the populations do not overlap.** Of the 32 bench songs, **24
note exactly 0.000 of their lines** (every Jamendo sheet, numb, never-be-alone, tfr-flyaway, tfr-mayday) and
**8 note 0.851–1.000** (hello 63/74, feel-my-heart 32/37, bohemian-rhapsody 65/74, bad-guy 75/79,
shape-of-you 89/92, tfr-chosen 36/37, rap-god 216/217, believer 73/73). `NOTED_SHARE` sits at the **BOTTOM of
that population (0.8)** and not in the middle of the empty band: at 0.5, where it started, the rule also fired
on two real authoring shapes nobody had measured — a track that notes only its hook lines (11 noted of 20
worded = 0.550) and the SDH convention of one note OPENING a sung passage and one closing it (8 of 12 = 0.667)
— and in both it deleted the unmarked lines, which are sung (W5 review r2-correctness-1 + r2-spec-7,
reproduced on the shipped tree and now pinned by `tests/test_nonlyric.py`). At 0.8 every one of the 8 tracks
above still fires (hello sets the floor at 0.8514, head-room 0.0514) and R3's drop share is capped at 0.200 of
a track's worded lines by construction — the corpus maximum is hello's 11/74 = 0.1486.
**AND THE POPULATION NOW EXCLUDES THE LINES R1/R4 ALREADY ANSWERED**, which the raise is what exposed: a
`[Chorus]` label carries no note and is not a sung line, so counting it made a LABELLED sheet read as less
marked than the same sheet unlabelled. On the bench's own `headers` mode (one Genius-style label per section)
hello's share fell **0.8514 → 0.7500**, bohemian-rhapsody's 0.8784 → 0.7927, feel-my-heart's 0.8649 → 0.7111
and rap-god's 0.9954 → 0.9153, with the author's marking untouched; excluding the anchored lines returns every
one of them to its unlabelled value to the digit. **One served text in the whole corpus moves because of the
raise** (measured over 32 songs × 16 modes = 512 served texts, `clean_segments` before against after):
`hello` `extraverse`, whose injected donor verse puts its share at 63/80 = **0.7875** — inside the band the
rule now abstains in — so that case serves 80 lines instead of 63. The 17 it stops dropping there are the 11
cues plus the 6 INJECTED lines, i.e. the mode's own stimulus, which R3 had been deleting on that song (the
`unsung` reading for that one case therefore moves from the text side to the acoustic one). The **34 lines** it
drops across those 8 tracks are 34 for
34 NOT SUNG: all 7 of hello's cues and its 4 spoken phone-call lines, bohemian-rhapsody's 9 solo
annotations, feel-my-heart's 5 music cues, shape-of-you's `[RINGING SOUND]` / `[COSTUME RUSTLES]` /
`[HE GROANS]`, bad-guy's 3 spoken intro lines and `(LAUGHTER)`, rap-god's title card, tfr-chosen's uploader
credit. **The non-rule**, stated out loud: a track that is neither noted nor machine-generated keeps its
parentheticals and the AUDIO remains their only filter. That is a known gap, not an oversight.

Through `clean_segments`, over the corpus's truth texts: **1760 → 1712 lines**, i.e. 14 dropped for carrying
no word at all (as before: believer 1, shape-of-you 1, bad-guy 10, tfr-chosen 2) and **34 judged non-lyric**
(hello 11, bohemian-rhapsody 9, feel-my-heart 5, bad-guy 4, shape-of-you 3, rap-god 1, tfr-chosen 1). Numb
keeps all 35 of its lines and loses the `CHORUS:` label off **17** of them — review M11's own count, reproduced.

### The reject-if is PAID: both lift targets re-read, and the shipped row still fits EXACTLY

W3 review r2's rule is that no change to `clean.py`'s output lands without re-running `lift_gate.py` for
both targets and re-reading the shipped row — which since W5's flip is `lexical.CALIBRATED["HUBERT_ASR_LARGE"]`.
Both run on this tree (`_runs/w5-hygiene/lift-{stem,mix}.log`, 832 texts each, 832 measured, 0 under
`MIN_LETTERS`), and **the fitted row reproduces the shipped one on both**:

| | shipped | this run fits | wrong max | head-room | right texts refused |
| --- | --- | --- | --- | --- | --- |
| stem | `refuse_below` 0.45, `ok_from` 0.80 | **0.45 / 0.80** | +0.2240 (W4b +0.219) | **+0.2260** (W4b +0.2306) | **0 of 192** at every τ ≤ 0.60 |
| mix | `mix_floor` 0.15 | **0.15** | +0.1157 (W4b +0.116) | +0.0343, 0 wrong at ≥ 0.125 | 10 of 192, W4b's own figure |

Both wrong populations are **refused 320/320 + 320/320** in the band table. **And the `headers` population is
now IDENTICAL to `truth`** — stem min/max +1.028/+5.334 → **+1.132/+5.649**, mix +0.015/+4.489 →
**−0.005/+4.715**, in both cases `truth`'s exact numbers — because M11 strips the injected labels at clean
time, so the `headers` text IS the truth text. That is the cheapest possible end-to-end proof that M11 works
through the bench's own ports.

### What it costs, measured A/B on ONE tree (2 songs × truth/blind, `--level run_align`, HuBERT-L)

`_runs/w5-hygiene-probe` against `_runs/w5-hygiene-probe-off`, the second with `nonlyric_indexes` and
`without_section_label` stubbed out, so the only difference is the hygiene.

| case | served | scored | ±500 | pm500 | gross | doc confidence |
| --- | --- | --- | --- | --- | --- | --- |
| hello truth | 74 → **63** | 72 → 63 | 72 → 63 | 100.00 = **100.00** | 0 = 0 | medium → **high** |
| hello blind | 74 → **63** | 72 → 63 | 54 → 50 | 75.00 → **79.37** | 6 → **3** | medium = medium |
| feel-my-heart truth | 37 → **32** | 37 → 32 | 35 → 30 | 94.59 → 93.75 | 0 = 0 | high = high |
| feel-my-heart blind | 37 → **32** | 37 → 32 | 31 → 27 | 83.78 → **84.38** | 3 → **4** | medium = medium |

* **In a CLAIM mode it is free or better.** No gross line moves, `pm500` is identical on hello and within one
  line of 32 on feel-my-heart, and hello's published document goes **medium → high**: the cues were dragging
  its grade down.
* **In BLIND mode it is a wash on the count and introduces ONE new failure shape, which is review §3.8's own
  strongest objection, reproduced.** hello loses four gross lines that were cue/spoken lines (indices 4–7 at
  −2.42…−11.08 s) and **gains one**: index 10, the first SUNG line, at **−60.73 s**. feel-my-heart's index 1
  goes **−17.09 → −28.91 s** — the review said "removing feel-my-heart's annotation line put its first word
  28.4 s early. The header had been soaking up a vocal-chop intro, so pair this with #10". It did, to within
  half a second, on the bundle that ships. Net over the two songs: gross **9 → 7**.
* **W6's consumer already bounds the user-visible harm**: `high_gross` and `high_bad` are **0 → 0** on all
  four cases, so the margin rule grades both new lines `low` and the TV renders them line-level with no word
  wipe. `high` falls 19 → 16 and 50 → 47, which is the right direction.
* **THE MITIGATION IS W7's STAR/FILLER TOKEN** (§3.10), exactly as §3.8 said. Until it lands, a blind decode
  of a song with a long spoken or instrumental intro has nothing to absorb it.

### What `in_text` still counts, and the one question this leaves the bench

`text_pm500` is `w500 / in_text`, and `in_text` is **the truth lines the CLAIMS reference** — which still
includes the 34 non-lyric ones, because they are in the truth FILE. So the text-denominator metric falls by a
known, countable amount on the 7 affected songs with no timing having changed: hello truth **97.30 → 85.14**,
hello blind 72.97 → 67.57, feel-my-heart truth 94.59 → 81.08, blind 83.78 → 72.97. **The artefact the wave
owns is fixed** — `served_lines` and therefore `scored` are now model-independent, which is what "hello
73 → 72, tfr-chosen 34 → 33" was — but whether `in_text` should count a line no model can ever time is an
OWNER CALL, because re-basing it moves every `*-text-pm500` literal at `run_align` and nothing else.

### L3 syllabify: two bugs in how a token reached the ladder, and a shipped Moby tier

Both bugs were in the HAND-OFF, not in any tier. `core = word.strip()` strips whitespace and nothing else, so
`everything,` was looked up WITH its comma: CMUdict missed it, pyphen declined to split it, and the word came
out as **ONE** syllable (`baby,` the same, `everybody,` 2 instead of 4). And an internal hyphen was never
split, so the vocable `la-la-la` came out `la-l|a-l|a`, fragments straddling the separator. Measured over the
32 bench songs' CLEANED texts, 10 590 tokens: **4.3% carry edge punctuation**, 0.3% an internal hyphen, and
**0.9% of all tokens got a different syllable COUNT because of it** — the audible half, since the karaoke ball
bounces once per syllable.

The new tier is the **Moby Hyphenator** (Grady Ward's Moby Project, public domain, Gutenberg ebook 3204,
`files/3204/files/mhyph.txt`), ahead of pyphen. Measured over the 20 JamendoLyrics songs, counting
OCCURRENCES of tokens CMUdict calls multi-syllable (901 of them): **pyphen abstains on 44.8%** — the review's
figure, reproduced exactly — Moby knows **82.9%** of them and **83.9% of the ones pyphen abstains on**, and the
ladder WITHOUT this tier differed from Moby on **39.0%** (re-read at 39.8% through an emulation of the old
lookup). `about`, `maybe`, `baby` and `everything` all come out
of pyphen unsplit, and `_force_count` then BISECTS them against CMUdict's count, putting the boundary at the
middle of the string (`everything` → `ever|yth|ing`) instead of where a dictionary says (`eve|ry|thing`).
With the tier in front, the SHIPPED ladder differs from Moby on **1.3%** — every one of those
`_force_count` honouring CMUdict's count over the dictionary's break, i.e. the tier order working. The review's
three figures for these quantities were **44.8% / 86.6% / 31.0%** against the 44.8% / 82.9% / 39.0% above: the
abstention rate reproduces exactly and the other two move with the counting rule.
Shipped as `encore_worker/domain/lyrics/data/mhyph.xz`, **456 KB** for 152 085 entries: the 2.6 MB latin-1
source reduced to the entries that are purely lowercase letters with at least one break (multi-word entries,
apostrophes and hyphenated compounds dropped, because `syllables` splits on those itself and looks each piece
up separately), one `word-with-hyphens` per line, LZMA'd, loaded lazily and once.

### M12: YouTube's rolling auto-captions, re-measured on the review's own video

Re-fetched `dQw4w9WgXcQ` with `--write-auto-subs` (103 raw cues) and reproduced the review's reading through
the SHIPPED parser to the digit: **86 cues, 769 words for 284 sung, the first cue lost, 239 inline word onsets
stripped**. Four defects, four rules, and the parser is now TIMESTAMP-driven rather than block-driven:

1. **The cue separator is an EMPTY line, not a blank-looking one.** YouTube writes a lone SPACE as the
   roll-up's empty half, and splitting blocks on `line.strip() == ""` cut every such cue in two — the half
   with the timestamp had no body and was dropped, the half with the body had no timestamp and was dropped
   too. That is the lost first cue. (Timestamp-driven parsing is also what stops a file that separates cues
   with a whitespace-only line from welding two together and publishing a timestamp as a lyric.)
2. **Under `MIN_CUE_SEC` = 50 ms is a roll-up MARKER, not a cue.** 51 of the 103 are exactly 10 ms. 50 ms is
   also two decoder frames at the 20 ms hop, so nothing under it carries a usable claim.
3. **Only the NEW line of a rolling cue survives**, the carry identified by TEXT IDENTITY against what the
   previous KEPT cue published (not by a guess about line counts, which is what keeps a line-WRAPPED authored
   cue whole) — **and only on a track that is a ROLL-UP**, which is evidence and not an assumption
   (W5 review r1-correctness-2: an inline onset tag, or a cue span OVERLAPPING the previous cue's, accumulated
   per track because a rolling track's last cue often has no new word and so no tag of its own). Identity alone
   also matches a line REPEATED across a cue boundary — a chorus line ending one cue and opening the next,
   which is ordinary in song captions — and on a plain authored track that deleted it from the served text.
   **The two signals are not equal, since r2-correctness-3**: a tag is proof on its own, an OVERLAP has to
   repeat (`cli._ROLLING_OVERLAPS` = 2), because one overlapping pair is something real authored and SDH tracks
   write (two simultaneous speakers, a backing-vocal overlay, stacked karaoke subtitles) and latching rule 3 on
   it deleted a line repeated LATER in the same track. A real roll-up overlaps on every cue it grows through.
   Measured on the corpus's own 16 real caption tracks (the 6 `.vtt` in the review scratch + 10 committed
   `json3`): **0 overlapping pairs and 0 inline tags on every one of them**, so neither the signal nor its
   false positive has a corpus instance, and the one with evidence behind it is the tag (dQw4w9WgXcQ: 239 tags
   over 41 cues). The verdict is now read over the WHOLE track before the first cue is built, so it applies to
   the cues that came before the evidence did.
4. **Inline `<hh:mm:ss.mmm>` tags become WORD claims** — the only per-word timing a rolling track has, and
   `clean_line` strips them. A cue with NO tag keeps line timing; a cue where one tag opens a RUN of words
   apportions that run across the room to the next onset by character count (W5 review r1-tests-19: the run's
   extra words used to take the previous onset and publish ZERO-WIDTH spans, which the TV's
   `start <= pos < end` rule can never light).
   **They are CARRIED, not DECLARED** (W5 review r2-correctness-6): `steps/align_steps.fetch_captions` builds
   the caption `TextRef` with `timing=TIMING_LINE` whatever the cues hold, and nothing on that path reads a
   cue's `words` — the claim clock is built from `measure.line_spans`, one span per segment. Declaring
   `TIMING_WORD` would turn a machine's per-word guesses into the job's CLAIMS, which is a measured change no
   bench row covers; the payload waits for the wave that measures it. The provider path DOES derive its label
   from the payload (`_timing_of`), because there the word spans are an author's.

**After: 48 cues and 287 words against 284 sung, with 280 word claims.** `[Music]` goes by R4 above (an auto
track has no music note, so R3 cannot reach it). All six authored `.vtt` tracks in the review scratch parse
**byte-identically** through the new parser.

### L4 `parse_lrc` and L5, M13: the parsers and the providers

* **L4, four fixes.** A timestamp-only line is the "vocals stop here" marker and was SKIPPED, so the previous
  line's interpolated end ran to the next SUNG line — the measured case is a claim window running 14–40 s
  across an instrumental break with R1's claim-envelope correlation falling 0.87 → 0.27. Stacked stamps
  (`[00:45.00][01:20.00] words`) were half-read, publishing `[01:20.00]` as the line's first word; they now
  emit one claim each, which is also why the sort is not optional — a single line can emit an 80 s claim
  before the 50 s one that follows it in the file. A2 word tags become word claims, **apportioned across the
  room to the next onset by character count and attached to the FIRST stamp of a stacked line only** (W5
  review r2-correctness-5 / r2-spec-8 and r2-tests-18: every token after the first in a tagged run used to
  take the previous token's start, so a run of three published two ZERO-WIDTH claims the TV can never light —
  the same defect r1-tests-19 fixed in the caption parser — and a stacked line's later stamps used to carry
  the first occurrence's ABSOLUTE word times, 55 s before their own line's start in the measured case. The
  repeat stays line-timed: nobody timed those words.) `[offset:]` is honoured,
  SUBTRACTED (a positive offset makes the lyrics appear sooner), clamped at 0, and applied to word edges too.
* **L5.** An LRCLIB 404 on a duration-qualified lookup is retried once WITHOUT the duration. LRCLIB matches
  within ±2 s and the duration this worker measures is the UPLOAD's, so a video with an intro, an outro or a
  spoken skit 404s with a good human sheet one request away. The trade is asymmetric on purpose: another cut's
  sheet has wrong LINE TIMINGS, which the claim clock, the LINE_SYNC gate and the lexical lift all read,
  while a 404 is no text at all.
* **M13, the half that costs nothing.** `fetch_provider_lyrics` returns EVERY provider's sheet instead of the
  first, deduplicated on the normalised words — lrcmux is first in the chain, so LRCLIB used to be consulted
  only when lrcmux was UNREACHABLE and never when it merely answered badly. Inside a tier the pool is then
  ordered by **corroboration** (`policy.corroboration`: a text from a DIFFERENT WITNESS agrees on ≥ 0.75 of
  the smaller vocabulary) rather than by arrival order, which is what put the upload's SDH caption track ahead
  of every provider sheet unconditionally — measured publishing over a clean sheet on Hello.
  **"DIFFERENT WITNESS" IS LOAD-BEARING AND IS ENFORCED** (`policy.witness_of`, W5 review r1-correctness-4 /
  r1-spec-12): every provider sheet is ONE witness, because `fetch_provider_lyrics` asks each provider the same
  `artist`/`track` and LRCLIB is one of the upstreams lrcmux itself queries, so two sheets that agree can be one
  answer reached twice — the realistic failure is a metadata mismatch returning two copies of the WRONG song's
  sheet, which then corroborated each other and ranked ahead of the upload's own caption track, the one text in
  the pool that can only be about this recording. A caption track, a machine track and an ASR transcript keep
  their own identity, since a human subtitler of this video and a machine listening to this audio are genuinely
  two witnesses.
  **THAT ORDERING DOES NOT REACH THE HELLO CASE ITSELF, and the limit is pinned by a test**
  (`test_an_agreeing_sdh_track_is_therefore_still_tried_first`): corroboration demotes a text NOTHING in the
  pool agrees with, and Hello's SDH track agrees with a sheet of the same song — measured on the corpus,
  `corroboration` is True for BOTH (the hygiene-cleaned 63-line caption text against a 32-line re-wrap of its
  own sung lines) — so the tie falls back to arrival order and the SDH text is still tried first there. What
  separates two texts that BOTH look right is the audio, i.e. the ranking in the next paragraph.
  **NOT built: ranking by LEXICAL LIFT.** A lift needs an emission matrix, and emissions are computed inside
  `time_text` per attempt, so ranking on it costs either an extra model pass per song before the first attempt
  or an emissions cache in the step layer — a wave with its own measurement. The lift still runs exactly where
  it did, as the per-attempt gate that refuses a wrong text outright.
  **THE BENCH CANNOT SEE ANY OF M13**: `run_align` serves EITHER a caption track or a provider sheet per case
  (`ClaimCaptions` / `ClaimProvider`), never both, so no case has two candidates to order. It is held by
  hermetic tests only.

## W5: ad-libs (§3.13) — BUILT, MEASURED ON THE CORPUS, AND IT DOES NOT GENERALISE (2026-10-01)

Review §3.13 asks for `parts.split`: mid-line or trailing LEXICAL parentheticals and ECHO-TAIL lines held out
of the LEAD decode and timed afterwards inside their host line. The mechanism is real and worth stating,
because it is the reason the item exists: the global decode is ONE monotone CTC path, every character in the
target sequence must be consumed in order, and a backing vocal is not in order with the lead. `♪ So hello from
the other side ♪` followed by `♪ Other side ♪` makes the path spend frames on an echo while the lead has moved
on, and the only frames it can spend are the ones the NEXT lead lines were sung in. So the damage lands on
everything after the ad-lib, which is why the review measured it on the lead lines (Hello blind: 21 → 11 gross
lead lines, 14 → 3 in the backing region).

It is built — `worker/encore_worker/domain/lyrics/parts.py`, two anchored rules, pure, 28 hermetic tests — and
it ships **DEFAULT-OFF behind `ENCORE_ALIGN_EXPERIMENTS=adlibs`**, because the measurement the critics asked
for ("one song") says the review's gain is not there any more.

### The reach, on the text side, corpus-wide and free

`clean_segments`' output for all 32 songs (`_runs/w5-adlibs/scan.py`, no audio, no decode): **12 parenthetical
hosts in 4 songs** (tfr-flyaway 4 `with me (e-e-ee)`, numb 4 `(Caught in the undertow…)`, shape-of-you 3 `(I'm
in love with your body)`, rap-god 1 `(Ha!)`) and **15 echo tails in 6 songs** (hello 8, never-be-alone 2,
Ridgway 2, LUNABLIND 1, bad-guy 1, bohemian-rhapsody 1), out of 1712 served lines. Ten of 32 songs are touched
at all; on the other 22 the module is identity by construction (`parts.untouched`), so those songs are
byte-identical under the arm without needing to be measured. **8 of the 15 echo tails are Hello's**, which is
the critics' objection restated as arithmetic.

Two refusals in the rules were measured, not guessed:

* **never-be-alone refuses the ALONE clause's whole population.** Its text writes the hook as `You'll never be
  alone` / `be alone...` / `be alone` — eleven such triples, 21 of its 22 candidate echoes — and the truth
  timings say those are SEQUENTIAL lead phrases: 155.30–157.92, then 157.92–158.80, then 158.80–159.78, three
  consecutive spans with no gap. A tail sung twice over is a repetition the singer performed. Without the
  clause the arm would interpolate 21 of that song's 47 lines; with it, two candidates survive.
* **A decorated whole-line parenthetical is not a mid-line one.** `♪ (Oh-I-oh-I-oh-I-oh-I) ♪` has a `♪` in
  front of its bracket, so a "not leading" test anchored on TOKENS read it as a trailing aside, left `♪ ♪` as
  the lead text, and **dropped six published lines of shape-of-you**. The rule now requires the remaining lead
  to contain a LETTER. Found by the A/B below, not by review.

### The A/B: pooled gross 14 against 14, and the one echo tail that moved got worse

`_runs/w5-adlibs2-{off,on}`, the 5 songs the two rules reach most × truth/blind at `--level time_text`,
HuBERT-L, one code `f8ac0b65440fe508`, arm set through `ENCORE_ALIGN_EXPERIMENTS`. **This A/B is PRE-ROUND-1
and it is not re-run: the corpus row in "8. The ad-lib arm's corpus row" below supersedes it** (same arm, 32
songs, 16 modes, re-run on the post-round-1 tree), and the one bullet it changes is named in place:

| mode  | metric           | default | `adlibs`  |
| ----- | ---------------- | ------- | --------- |
| truth | gross            | 0       | 0         |
| truth | ±500             | 91.14   | 91.11     |
| truth | ±1 s             | 99.68   | 99.37     |
| truth | ±500 of text     | 89.16   | 88.85     |
| truth | zero-gross songs | 5       | 5         |
| blind | gross            | 14      | 14        |
| blind | ±500             | 79.43   | 80.00     |
| blind | ±1 s             | 91.46   | 92.06     |
| blind | ±500 of text     | 77.71   | 78.02     |
| blind | zero-gross songs | 3       | 2         |

Pooled, it is a wash. Per line, which is what decides it:

* **The only echo tail whose timing moved got WORSE.** hello `♪ Other side ♪` +1.84 → **+2.08 s**, i.e. it
  became the gross line it had not been. That is §3.13's own target population, and the arm made it worse.
  **Re-verified on the post-round-1 corpus row** (`hello`/`blind`, source index 40, the one echo tail of eight
  whose timing moves at all): +1.84 → +2.08 to the digit, on a different code and a 32-song run.
* **Hello's apparent win is on text the shipped path never serves.** Its four improved lines are one spoken
  line and three CUE lines (`(wind buffeting) (phone clacking)`, `(lock clicking) (door creaking)`,
  `(footsteps echoing)`): −2.42/−3.64/−7.30/−11.08 → +0.58/−0.31/−2.19/+3.63 s. `--level time_text` serves the
  caption lines RAW, and in production `nonlyric.py` drops every one of those cues at clean time (see the text
  hygiene section above), so the arm never sees them. **Also re-verified on the corpus row to the digit**
  (source indexes 4–7).
* **numb gains a gross line AFTER two aside hosts**: `CHORUS: I've become so numb, I can't feel you there`
  −0.56 → **−2.25 s**.
* **never-be-alone LOSES a published line, in both modes** (46 → 45): taking an echo's targets out of the
  decode moves the never-sung rule's own median, and one more host crosses it. **THIS IS THE ONE NUMBER ROUND
  1 MOVED**: with the orphan echo dropped (`r1-correctness-5`) the post-round-1 corpus row reads 46 → **44**,
  and that song's blind gross goes 8 → **13**. See section 8.

### Why the review saw 21 → 11 and this sees nothing: the population is gone

Hello's blind decode had 21 gross LEAD lines when §3.13 was written, on the base bundle and before W6's clamp
fix. On the tree that ships it has **six gross lines in total** — the flip alone repays that song ±500
61.64 → 75.00 and ~40 gross lines (see "W5: the flip" above). The drag §3.13 was built to remove had already
been removed by other means, and what is left is a trade between an interpolated ad-lib and a decoded one.
That is not a refutation of the mechanism; it is a measurement that the mechanism's budget was spent.

**What would change the verdict, and neither is this wave's.** (1) Time each aside with a WINDOW DECODE in the
gap instead of interpolating it: the gap between a host's end and the next lead line's start is evidence the
lead decode itself produced, which is exactly what `generate.regenerate` takes, and it would make an ad-lib's
timing measured rather than apportioned. (2) A `run_align` read: every number above is `time_text`, where the
text is raw, and the shipped cleaning changes which lines the rules even see.

**M15 needed nothing.** `domain/lyrics/attribute.py` writes `part` (letters by first appearance), never the
diarizer's `speaker`, and the cross-language contract test the review asked for exists in both directions —
`worker/tests/test_core_contract.py::test_a_duet_reaches_the_tv_as_parts_and_a_solo_does_not` writes the
fixture, `core/tests/unit/contract/lyrics/worker-align-contract.test.ts` reads it back through
`parseLyricsDoc` and asserts the colours. Verified, not re-done.

## W5: the display lead, and the two gate rebases the W6 close-out carried (2026-10-01)

### `lyricsLeadMs` = 40 ms — a DISPLAY lead, fitted on an ASYMMETRIC tolerance

ITU-R BT.1359's lip-sync detectability band is not centred on zero: video LATE of audio is noticed at about
−45 ms, video EARLY at about +125 ms, nearly three times the slack on the early side. A karaoke highlight has
the same asymmetry — a word that lights after it is sung reads as broken, one that lights a hair early reads as
correct — so a timing distribution centred on zero spends half its mass on the expensive side. Over the 5693
hand-timed word onsets of the 20 JamendoLyrics songs, shifting the display by **+40 ms** moves the share inside
that asymmetric band **66.0% → 75.0%** — the review's own figure, and the one this section was written on.

**RE-MEASURED ON THE TREE THAT SHIPS (W5 verification pass, `_runs/w5-leadcheck/`), because that figure is a
DIFFERENT TREE's and the correction matters more than the digits: 40 ms is the ARGMAX here.** Swept at 5 ms
steps over the same 5693 onsets, the share peaks at exactly **40 ms** in every population a room can be in —
a claim-anchored document **73.2% → 78.6%**, the same songs decoded blind **73.2% → 78.6%** (a fresh raw
`generate` decode agrees at 73.1 → 78.5), a jittered claim **67.8% → 72.6%** — and the curve is a PLATEAU, 30 /
40 / 50 ms reading 78.5 / 78.6 / 78.2. The review's 66.0 → 75.0 **reproduces exactly on its own matrices**
(`_review-scratch/encore-review/cache`, the pre-W4 clock, the base bundle, its own 40 ms `ONSET_LEAD_SEC`:
66.01 → 74.95, bias +3.7 ms, argmax 55 ms); what moved is the distribution — W4's clock and W5's flip took the
onset bias +3.7 ms → −3.4 ms and ±100 ms 78.7% → 82.8% — so the band starts fuller and the lead now buys **5.4
points, not 9**. The decision survives the move; only the percentages belong to the tree they were taken on.

It is implemented as core's room-setting default `DEFAULT_LYRICS_LEAD_MS` (0 → **40**), which is what a real TV
runs with, and **NOT** by moving the worker's `generate.ONSET_LEAD_SEC` (30 ms, re-fitted in W4 on the exact
frame grid), which is ACOUSTIC TRUTH: moving it would make the published artifact lie about where the words are
to every consumer, this harness included. Two leads, two layers, and they compose.

**WHAT THE BENCH STILL READS IS ZERO, deliberately.** `core/src/lib/tv/lyrics.ts` `LYRICS_LEAD_SEC` — the
overlay's default when no room settings reach it — stays 0, the TV port in `e2e_lib` reads that constant and
`tests/unit/lib/tv/lyrics-bench-parity.test.ts` pins the pair, so every recorded `highlight` number measures
the ARTIFACT's own accuracy. **AND THE REASON IS THE OPPOSITE OF THE ONE FIRST WRITTEN HERE, which said the
lead would "flatter the metric by about 9 points": MEASURED on the W5 sweep's own published documents
(`_runs/w5-leadcheck/highlight_shift.py`, correct-word overlap, which reads 80.91% against the harness's own
81.4% at `truth` and so tracks it), a 40 ms display lead would COST `highlight` ~2.7 pt — truth 80.91 → 78.23,
blind 79.80 → 76.93.** `highlight` rewards OVERLAP with the sung span and our onsets are already 3.4 ms early,
so earliness can only subtract; the perceptual band rewards earliness up to 125 ms. The two metrics therefore
disagree about a display lead BY CONSTRUCTION, which is the real argument for keeping the policy out of the
port: an alignment reject-if must not move because a room compensates its panel. **Still owed before the exact
value is trusted**: the TV's own video latency (compositor + HDMI + panel processing, commonly 20–100 ms
outside game mode) eats the same budget and is unmeasured here.

### `gates/w0-reproduce-time_text.yaml`: all ten literals, onto the bundle that ships

The W6 sweep left this file at 8/11 with the three `truth` literals wanting 1 / 90.61 / 98.73 and asked the
owner for the rebase. The flip then superseded that answer: a bundle swap replaces every emission matrix, so
all TEN literals move, and on the new default the W4-based file reads **1/11** while the W6-base-corrected one
would read **3/11** — both "fails by construction", the noise W4b's rebases exist to remove.

Rebased onto `results/w6-hubert-time_text.json` and verified offline with `e2e_gates.run_gates` on the committed
rows: **11/11 on the shipped default, 3/11 on the base bundle** — so reverting the flip fails loudly here rather
than passing silently, the same property `gates/w5-flip.yaml` was built with. No tolerance was loosened (still
0.5 pt / 0.5 of a count) and no gate was added or deleted. What the flip bought, which these literals are now
the record of at this level: truth gross 1 → **0**, ±500 90.61 → 90.89, ±1 s 98.73 → 99.14; blind gross
106 → **68**, ±500 78.04 → **81.50**, ±1 s 88.76 → 91.93; blind Jamendo words ±100 80.11 → **82.81**, ±250
90.62 → 93.74, ±300 91.58 → 94.38, words over 2 s out 122 → **75**.

`--level time_text` cleans nothing (the harness says so at `TimeTextDriver`), so W5's text hygiene cannot move
one number in this file and the committed HuBERT-L row is still the shipped tree's row for it; the bench runner
re-confirms that on the final tree.

### `gates/w2.yaml` section 4: the byte gate became an ONSET gate, and gained a word-END companion

`blind-unchanged: count(blind.song.doc_changed) == 0` → `blind-onsets-unchanged:
count(blind.song.onsets_changed) == 0`. The reason, measured here on the two committed rows that differ by
exactly the per-line `confidence` field (`results/w6-base-time_text.json` against its own `conf-legacy` control
`results/w6-legacy-time_text.json`): blind `doc_changed` **30**, blind `onsets_changed` **0**. A MUST that fails
because a grading label was written into every document is a MUST the next wave learns to ignore.

It is not a loosening, and the file now says where each thing the byte comparison covered has gone: onsets and a
line appearing or vanishing are still absolute (the digest is over the published line LIST); word ENDS, which
`onset_digest` leaves out on purpose so W4's post-pass cannot trip an onset gate, get the NEW companion
`blind-no-worse-word-ends` at the same −0.3 pt allowance as its siblings; the `confidence` field is deliberately
not gated here, because `gates/w6-conf.yaml` measures it against a control; and a line's TEXT with its onsets
unchanged is covered by neither digest in a blind mode (`onset_digest` carries `line.source`, the claim index,
which is None when there are no claims) — so that one is named out loud and left to the worker's own suite,
where `tests/test_parts.py` asserts the published text of every served line. The file is **88 gates, 89/89 with
the builtin, at both levels** against `results/w6-hubert-*`, and section 4 reads 5/5 on the very pair where the
byte gate failed.

## The W5 corpus sweep: six runs, the flip verified at `run_align` and in `lines`, and the hygiene's price named (W5 bench, 2026-10-01)

Six full runs plus one 20-case decode check, all on ONE worker tree (code **`db84383732037c63`**; 32 songs,
seed 0, `--wrong-k 10`, `--tfr-audio youtube`, MPS, **0 ERROR rows in every one**), 1088 cases per full run,
16–29 min each. Two rows were re-measured later on the SAME setup and are labelled with their own code in the
table below: run 7 (the lines-mode control, `52304846f1dc751f`) and run 6 (the `adlibs` arm, re-run after
review round 1 on `8393daaf5b1b43bc` because two confirmed findings land inside that arm and nowhere else). This is the read on the whole wave at once — the flip, the text hygiene, the ad-lib arm, the
display lead — and it is only sound because each is measured against a base that isolates it, which is why
there are six runs and not three.

**THE FLIP'S EMISSIONS WERE FREE, which the flip gate predicted would cost a cold pass.** `gates/w5-flip.yaml`
warned that `adapters/ml.py` is in the emission cache's code fingerprint (`e2e_lib.module_closure`) and that
the first sweep after the wave pays one cold model pass, ~6–9 min at HuBERT-L's 4.3–8.6 s a song. It did not:
the hygiene item's own `lift_gate.py --target stem` and `--target mix` runs (832 texts each, on the tree that
ships) had already recomputed all 63 matrices under the new fingerprint, so the `time_text` sweep opened with
`emissions {'disk': 63, 'memory': 1222}` and **zero cold computes**. The base-bundle control DID pay its own
cold pass (4.9 s a case through the first mode, ~4 min), and the `adlibs` arm pays one too, because the
`align_*` settings are in the same fingerprint.

| run | `results/` | level / arm | what it isolates |
|---|---|---|---|
| 1 | `w5-time_text.json` | `time_text`, HuBERT-L (the default) | **the DECLARED NEW BASELINE** |
| 2 | `w5-run_align.json` | `run_align`, HuBERT-L | the shipped path, where the hygiene lives |
| 3 | `w5-lines-run_align.json` | `run_align --sync-mode lines` | the gated LINE_SYNC rung — the run nobody had |
| 4 | `w5-generate.json` | `generate --modes blind --songs jamendo` | the raw decode, for L3 syllabify |
| 5 | `w5-base-run_align.json` | `run_align`, `--model WAV2VEC2_ASR_BASE_960H` | the CONTROL: both bundles, one tree |
| 6 | `w5-adlibs-time_text.json` | `time_text`, `ENCORE_ALIGN_EXPERIMENTS=adlibs` | the §3.13 arm's corpus row (RE-RUN after review round 1; code `8393daaf5b1b43bc`, 63 cold matrices, 1537 s) |
| 7 | `w5-base-lines-run_align.json` | `run_align --sync-mode lines`, `--model WAV2VEC2_ASR_BASE_960H` | the CONTROL for the lines A/B (added by the verification pass below; code `52304846f1dc751f`) |

### 1. `--level time_text` IS IDENTICAL TO THE DIGIT, and that is the wave's cheapest piece of evidence

`results/w5-time_text.json` against `results/w6-hubert-time_text.json`: every metric of all 16 modes is
unchanged — pooled gross, ±500, ±500-of-text, zero-gross songs, every per-song row at `+0.0`, and every
Jamendo word column including `aligned` 5378 and `interpolated` 311. **That is not a weak result, it is the
proof that W5's text work did not leak into the decode, the repair ladder or the word interpolator**, and it
is why `gates/w5-flip.yaml` reads **40/40** here against the base bundle while `w0-reproduce-time_text`
reads 11/11, `w2.yaml` 89/89, `w4b.yaml` 28/30 and `w6.yaml` 32/33 — the same verdicts W6 recorded, on a
tree the wave added 5158 lines to across 47 files. The reason is structural and the harness says so at
`e2e.TimeTextDriver`: the claims go in RAW and the shipped `time_text` cleans nothing; only the text adapters
call `clean_segments`. **Which also means the caption-cue denominator artefact cannot close at this level**,
and it does not: 91 song-modes still differ between the bundles there, the same 91 as on the W6 tree.

### 2. The flip, verified where it had never been read: `gates/w5-flip.yaml` 40/40 at `run_align`, with BOTH bundles on the tree that ships

The honest A/B for a model is two bundles on ONE tree, and run 5 is what makes it possible.
`results/w5-run_align.json` against `results/w5-base-run_align.json`: **40/40**, and **9/40 with the
comparison reversed** — the ratchet bites in one direction only, which is what the file claims to do. At
`truth`, pooled on Jamendo: ±500 97.00 → **98.15**, words ±100 83.52 → **85.46**, ±300 95.04 → **97.16**,
AAE 86.7 → **71.1 ms**, PCO@0.3 86.53 → **91.78**, highlight 77.58 → **81.40**, word end ±100 80.02 →
**80.34**, phrase-final end ±100 59.23 → **60.93**, gross 1 → **0**, zero-gross songs 31 → **32**.
`w4b.yaml` reads 28/30 and `w6.yaml` 32/33 on that same pair — the identical verdicts and the identical two
accepted residuals W6 recorded, except that **`tfr-chosen`'s truth ±500 residual shrinks from −15.59 to
−10.29 pt**, which is the hygiene repaying the part of it the orchestrator predicted was the denominator.

**Read against the COMMITTED W6 rows instead, the same run reads 38/40** — and the two failures are both
`text_pm500`, both the denominator, and neither is a timing move: see §4.

### 3. `--sync-mode lines` on the new default: 23 song-modes recovered, 1 lost, and the one lost is the flip's

The run the orchestrator's scope row owed and nobody had. `gates/w3-lines.yaml` on
`results/w5-lines-run_align.json` reads **34/38**, the same count the base bundle read — but not the same
four, and the swap is the whole result:

* **FIXED by the flip**: `committed-not-down-drop20` (31 → **32**) and `committed-not-down-drop50`
  (14 → **22**). Twenty-three song-modes go from REFUSED to `line-sync` against the W6 row: `never-be-alone`
  in twelve modes (truth, jit, all four offsets, both tempos, drop20, extraverse, headers, credit), eight
  songs at drop50 (`LUNABLIND`, `Lower_Loveday`, `Quentin_Hannappe`, `Ridgway`, `The_Rinn`, `believer`,
  `bohemian-rhapsody`, `feel-my-heart`), `tfr-chosen` at both tempos and drop50. `never-be-alone` carries no
  caption cue and no injected header in `truth`, so those twelve are the FLIP and not the hygiene.
  → **SPLIT EXACTLY, once the base bundle was measured in `lines` mode on THIS tree too
  (`results/w5-base-lines-run_align.json`, the verification pass below): the FLIP recovers 21 of the 23, and
  the other 3 are the HYGIENE.** The three are `tfr-chosen` at `tempo098`, `tempo102` and `drop50` — with the
  base bundle on this tree that song already commits there, so removing its caption cues is what recovered it,
  not the bundle. `never-be-alone`'s twelve are confirmed the flip's, as are nine songs at drop50 (the eight
  above plus `bad-guy`, which the W6 row already committed). The loss is the same one on either reading
  (`shape-of-you` drop50, the only song-mode in 1088 that loses a document), so the flip's own lines-mode
  ledger is **21 documents gained, 1 lost**.
* **THE FLIP'S ONE LINES-MODE REGRESSION, exactly where the flip item's 1-song probe said it would be**:
  `shape-of-you` drop50 goes `line-sync` → **REFUSED** (45/45 within ±500 → 0), because the rung's agreement
  share lands at 42% against the base bundle's 51% and `lexical.CALIBRATED["HUBERT_ASR_LARGE"]`'s
  `line_sync_min_agreement` is 0.5. Nothing else in 1088 cases loses a document.
* **NEW FAILURES — AND NEITHER IS THE DENOMINATOR** (W5 review r1-spec-10 corrected an earlier reading here
  that called both of them that): `truth-text-pm500` 92.61 → 91.59 against a 92.0 bar, and
  `zero-pm500-truth-not-up` 1 → 2 songs (`bad-guy`, now `numb`). **In `lines` mode the denominator does not
  move at all**: pooled truth `in_text` is **1760 on all three runs** (W6 base, this tree's base, this tree's
  default) and `numb`'s own case reads `served_lines` 35, `in_text` 35, `scored` 35 on every one of them. The
  1.02 pt is a NUMERATOR loss of 65 scored lines against the flip's **+47** (`never-be-alone`, REFUSED on the
  W6 row). Of the 65, **30 are the dropped caption cues** — hello −11, bohemian-rhapsody −9, feel-my-heart −5,
  shape-of-you −3, rap-god −1, tfr-chosen −1, which IS the `in_text` artefact, read in the numerator here
  because those lines keep their caption timings in `truth-lines.json` while the text no longer serves them —
  and **35 are `numb` alone, whose whole line-synced document moved +0.62 s UNIFORMLY**: diffing the two
  published documents on the SAME bundle
  (`_runs/w6-lines-run_align/.../numb-captions-authored-line-sync-line.json` against `_runs/w5-base-lines/…`)
  gives ONE distinct delta, exactly +0.62 s on all 35 starts, with ±1 s still 35/35. That is the claim clock
  re-fitting after the label strip — the document moved 0.62 s toward the audio and off the sheet it was
  line-synced to, which is §4's ~0.6 s caption lead seen in `lines` mode — not a lost line and not a
  denominator. `drop20-text-pm500` improves 92.56 → 93.70 and still misses its 95.0 bar.
* Wrong text: **0 of 640** in both spellings, as before.

### 4. The hygiene's price is REAL, it is 0.50 pt of pooled ±500 at `run_align`, and all of it has a name

`results/w5-run_align.json` against `results/w6-hubert-run_align.json` — the same bundle, one tree earlier,
so the delta is the hygiene and nothing else. `gates/w5.yaml` reads **39/40** — everything but
`w5-hygiene-truth-pm500-plan-bar`, which is the PLAN's own reject-if (truth ±500 not down more than 0.3 pt)
against the measured −0.50 below. It read 39/39 until W5 review r1-spec-13 found the single clause written at
−0.6, i.e. the stated bar and the literal disagreeing; the clause is two now (`-plan-bar` fails, and
`-itemised-cost` keeps −0.6 as the ceiling of the two named effects), and the cost is owed either an owner
waiver naming both causes or the `in_text` rebase. What moved:

* **Every Jamendo word and highlight column is IDENTICAL to the digit** (85.46 / 97.16 / 71.1 ms / 80.34 /
  60.93 / 81.40), because no Jamendo song carries a caption cue or a `CHORUS:` label.
* **Pooled gross is equal in all twelve timed claim modes at 0 and DOWN in the two degraded ones**: drop50
  91 → **82**, blind 67 → **61** (`bohemian-rhapsody` blind 5 → 1, `hello` 6 → 3; `bad-guy` and
  `feel-my-heart` each gain one on their shorter text). `high_gross` 0 in all thirteen claim modes.
* **The win the wave exists for, and the only place it can be seen as a number**: `headers` mode `unsung`
  — published lines that are no truth line — goes **224 → 0**. Every injected `[Chorus]` / `CHORUS:` /
  `[Verse 1: Eminem]` on 32 songs is gone, and nothing is scored differently for it, because an unsung line
  never was. `extraverse` 184 → 148, `credit` 28 → 21. W4 assigned `unsung-not-up-{headers,extraverse,credit}`
  to this wave; they read 0 at both levels and these three absolutes are the stronger form of the same thing.
* **Pooled truth ±500 90.95 → 90.45 (−0.50 pt), and line by line it is two effects**:
  1. **`numb`, and it is a finding about the corpus's truth, not about the aligner.** M11 strips `CHORUS:`
     off 17 of numb's 35 lines, and NO OTHER line of that document moves at all — but **16 of those 17 move,
     not 17, and one of them moves EARLIER: −0.24..+1.23 s, median +0.60, with line[18] not moving**
     (W5 review r1-spec-14, re-read off the same two committed documents the gate compares, `_runs/w5-ra`
     against `_runs/w6r2-hubert-ra`; "all later" was the part that argued this is a bias, so it is worth
     having right) — onto the **+0.59 s bias its other 18 lines already had**. numb's YouTube caption truth leads the
     sung audio by about 0.6 s and the label's characters were absorbing the lead-in; with the label gone the
     document is internally CONSISTENT and reads worse against that truth. ±1 s is unchanged at 35/35 and
     gross stays 0, which is what makes it a bias and not a placement error. That song's truth ±500 goes
     54.3% → 20.0% at `run_align` and 100% → 0% in `lines` mode, where `bad-guy` already sat for the same
     reason (0/69 within ±500, 69/69 within ±1 s, before this wave). **AND IT REACHES W6's CONFIDENCE RULE,
     which the sweep's own gate set did not read** (verification pass, 2026-10-01): at `run_align`
     `bad-among-high` goes 5.87% → **6.75%** at truth and 5.53% → **7.02%** at jit, and the whole move is numb
     (`high_bad` 7 → 24 at truth, 5 → 17 at jit, against `bad-guy` 54 → 49 the other way) — the same ~0.6 s
     caption lead, now seen through the grade. `gross`-`high` stays **0**, so the rule's hard promise holds;
     what moved is its soft precision on one song whose truth leads the audio. `--level time_text` is
     unaffected, there as everywhere, and `gates/w6-ladder.yaml` reads **31/31** at `time_text` / 28/31 at
     `run_align` (the three being the 7 hygiene songs' onsets and blind gross going DOWN 67 → 61).
  2. **Seven songs serve fewer lines, so `scored` falls with the PRECISION unchanged.** `hello` 72/72 →
     63/63 = 100.00 on both sides; `bohemian-rhapsody` 95.8 → 95.4; `tfr-chosen` 69.7 → **75.0**.
* **Nine `headers`-mode cases stop falling back to LINE_SYNC and publish a WORD document instead** (believer,
  rap-god, bohemian-rhapsody, never-be-alone, tfr-flyaway, Avercage, bad-guy, JASON_MILLER, hello drop50),
  because with the injected headers gone the structural check passes. In a claim mode a line-synced document
  scores ±500 trivially — its line times ARE the claim's — so this reads as `headers` pooled ±500 93.52 →
  90.51 while the product gains word-level wipe on nine songs. Named rather than pooled away.
* **THE ONE COST NO GATE FILE SHOULD BE READ ON WITHOUT THIS PARAGRAPH**: the harness's `in_text` still
  counts the 34 truth lines the served text no longer contains, so they become `missing` (truth 26 → 53) and
  every `*-text-pm500` literal at `run_align` falls with no timing having moved. That is why
  `gates/w2.yaml` reads **69/89** at `run_align` against `results/w6-hubert-run_align.json` — all 20 failures
  are `text_pm500` (`truth-text-pm500`, `blind-no-worse-pm500`, three `offset-gain-*`, two `tempo-gain-*`,
  `blind-onsets-unchanged` at exactly the **7** songs that serve fewer lines, and the thirteen per-song
  `no-worse-displacement-*`) — and why `gates/w5-flip.yaml` reads 38/40 on the same comparison. **The rebase
  of `in_text` onto the SERVED text is the owner's call and is not taken here**: it moves literals in five
  gate files and, more importantly, it is a question about the corpus (those 34 lines have caption TIMINGS in
  `truth-lines.json`, so the harness is not wrong to know about them — it is wrong only if a line nobody
  sings should count against an aligner that declines to time it).

### 5. The caption-cue denominator artefact: NARROWED from 100 song-modes to 86, and the remainder is acoustic

`gates/w5-denominator.yaml` is the file for this and it has its own base for a reason — the question is
whether two BUNDLES are comparable per song, so the base must be the base bundle on the SAME tree
(`results/w5-base-run_align.json`). **15/15 on the shipped tree; 7/15 on the W6 tree**, so the file tells the
two apart.

| | W6 tree | W5 tree |
|---|---|---|
| songs whose `scored` differs between bundles | 9 | **7** |
| song-modes | 100 | **86** |
| `served_lines` differing between bundles | 0 | **0** |

Closed outright: **`hello` (12 song-modes), `bohemian-rhapsody` (12), `shape-of-you` (4), `rap-god` (1)** —
the caption-cue half, fixed on the TEXT side where it belongs, and exactly what the orchestrator's row named
("hello 73 → 72", "tfr-chosen 34 → 33 … part of it is the caption-cue DENOMINATOR artefact").

**The remaining 86 are not a text problem, and the rows prove it**: `served_lines` is identical between the
two bundles in all 1088 cases, so nothing text-side can still differ per model. What is left is ACOUSTIC by
construction — the never-sung envelope rule and `_fitted_run`'s frame-per-letter refusal — and it goes both
ways, which is what a sharper decode does at a floor: `Pure_Mids_-_The_Leader` 19 → 20,
`Ridgway_-_Fire_Inside` 49 → 50, `never-be-alone` 44 → 46, `feel-my-heart` 31 → 32 (HuBERT-L hears a line the
base bins); `Color_Out_-_Falling_Star` 37 → 36, `bad-guy` 65 → 64, `tfr-chosen` 34 → 32 (it bins one the base
keeps). **Four of the seven carry no caption cue at all.** `tfr-chosen`'s gap WIDENS 1 → 2 for a specific
reason worth keeping: the base bundle's single drop there WAS the cue, so removing it from the text leaves
HuBERT-L's two ordinary-lyric drops standing alone. **So a cross-model per-song ±500 row is honest for the 25
songs this file holds at 0, and for the other seven the never-sung rule must still be named.** What would
close it completely is not a text change: bin on the MIX envelope, which does not move with the alignment
bundle, or require both bundles to agree — `m6-mix-spare` and `m6-window-spare` are the arms already built
for that question, and `m6-window-spare` is still owed a `run_align` read.

### 6. M13's candidate ranking: 0 of 1088 texts had their CHOICE changed, and the bench cannot see it

Wrong-text protection, measured on all three runs: **0 of 320 at `time_text`** (the bound was ≤ 1; the base
bundle publishes 1, this one 0), **0 of 320 at `run_align`**, **0 of 320 in both `+ownclock` spellings**,
**0 of 640 in `lines`**. Nothing commits, in any spelling, at any level. And the number the gate asked for:
**the new ranking changed the choice of 0 texts** — `published_label` is identical in all 1088 cases and
**every case has exactly ONE distinct candidate text**, old and new, because `run_align` serves either a
caption track or a provider sheet per case and never both. The 10 cases whose ATTEMPT COUNT changed are the
LINE_SYNC-to-word conversions of §4, not a different text. **So M13 is held to doing no harm and is NOT
credited with doing good: this corpus cannot measure it.** Measuring it needs a case that offers two
genuinely different texts for one song — a harness change, not a bigger sweep.

### 7. `gates/w0-reproduce-generate.yaml` REBASED onto the shipped default (the rebase W5's carried-items task missed)

That task rebased `w0-reproduce-time_text.yaml` onto HuBERT-L and left this one on `results/w4-generate.json`,
the base bundle's raw decode, where the flip makes it read **1/11**. Rebased here onto
`results/w5-generate.json` on exactly its own grounds — `--level generate` IS the decode, and a bundle swap
replaces every matrix. **11/11 on the shipped default, 1/11 on the base bundle**, no tolerance widened. The
split is 6 gains / 5 regressions and both halves are in the file's header: onsets ±100 79.98 → **82.75**,
±250 90.46 → **93.68**, ±300 91.45 → **94.31**, words > 2 s out 129 → **76**, AAE 337.1 → **255.0 ms**,
MedAE 40.6 → **38.9 ms**; ends word ±100 68.74 → **64.54**, phrase-final ±100 36.3 → **30.58**, ±250 72.74 →
**65.36**, bias −120.8 → **−159.0 ms**, painted highlight 66.0 → **64.69**. The five are PRE-`extend_ends`:
on the shipped path the same bundle reads word end ±100 **80.34** and phrase-final **60.93**, against the
base bundle's 80.02 / 59.23. **AND HERE IS WHERE L3 SYLLABIFY ACTUALLY SHOWS UP AT CORPUS SCALE — in the published document, and in
nothing the bench can score.** The `--level time_text` summary is identical to the digit (§1), but the written
`*-word.json` is NOT: all 32 truth-mode documents differ, and **every differing leaf is inside `syllables`** —
1336 syllable TEXTS, 703 syllable ends, 681 syllable starts, 22 words whose syllable COUNT changed, 85
syllable-list entries added or removed, and **not one word start, word end or line onset anywhere**
(`onsets_sha256` is equal in all 1088 cases; `doc_sha256` differs in exactly the 448 right-text ones = 32
songs x 14 modes). The Moby tier's splits are the linguistically correct ones where they differ — `near-ly`
against pyphen's `nea-rly`, `con-tin-u-ing` against `con-ti-nu-ing`, `e-ver` against `ev-e-r` — so the change
is real, it reaches the TV's per-syllable wipe, and the corpus has no syllable truth to score it with. That is
the honest form of "L3 costs nothing": the bench proves it moved no TIMING, and cannot be asked whether the
hyphenation is better.

### 8. The ad-lib arm's corpus row, and it costs gross lines where a claim was published

The run §3.13's critics asked for and the wave's ad-lib task could not afford: `--level time_text --modes
all,wrongtext+ownclock` with `ENCORE_ALIGN_EXPERIMENTS=adlibs` against the default
(`results/w5-adlibs-time_text.json`; **63 matrices computed cold, 0 disk hits, 1537 s**, because
`Config.align_experiments` is inside the emitter fingerprint — an arm sweep is never a warm run).
`gates/w5-adlibs.yaml` reads **7/11** and the arm STAYS DEFAULT-OFF.

**RE-RUN AFTER W5 REVIEW ROUND 1** (code `8393daaf5b1b43bc`), because two of the round's confirmed findings
land inside this arm and nowhere else: `parts.split` now reads the MATRIX's dictionary (r1-tests-20) and
`parts.restored` drops an ORPHAN ECHO whose host the document never published (r1-correctness-5). The numbers
below are the re-run's; two measurements make the cross-tree A/B honest rather than assumed:

* **the base is still the base.** A same-tree DEFAULT control (`_runs/w5r1-default-control`: the 10 songs the
  arm reaches × `truth`/`blind`/`jit`/`tempo102`, knob off, 40 cases, 247 s) reproduces
  `results/w5-time_text.cases.jsonl` in EVERY field of all 40 rows — `doc_sha256` and `onsets_sha256`
  included. So every delta here is the knob's, not round 1's.
* **the metric code is the same metric code.** Both pre-fix rows re-summarise byte-identically on this
  harness and the pre-fix arm digest re-compacts byte-identically, so `harness` moving `d37aa94c` →
  `a87b17a1` moved no number.

**What round 1 changed, exactly: `never-be-alone`, and nothing else** — 10 of 1088 documents; every other case
is byte-identical to the pre-fix arm row, which is also the measured half of "the dictionary-aware R1 reaches
no corpus case" (`shape-of-you`, the song `_mark`'s docstring is written on, is identical under both readings).
Dropping that song's orphan echo **fixed the arm's worst claim-mode number** (`tempo102` gross 3 → **0**, ±500
89.22 → 90.02 against the default's 90.03: with the 0.0-score line gone the clock reconciler picks
decode-median instead of a tempo fit) and **cost it blind** (8 → 13 gross, because the room the orphan held is
re-apportioned and `[31] 'Will you ever be alone?'` lands −32.79 s instead of −8.17 s).

**The metric §3.13 is written in — blind gross LEAD lines per song — pooled 68 → 75 (+7):**

| song | default | `adlibs` | |
|---|---|---|---|
| `hello` | 6 | **5** | §3.13's own song. Its 21 → 11 is gone because the POPULATION is: this tree's hello has 6, not 21 |
| `Ridgway_-_Fire_Inside` | 3 | **2** | the one song outside the review's set that the arm helps |
| `bad-guy` | 4 | 5 | |
| `numb` | 0 | 1 | a song with ZERO gross lines gains one |
| `bohemian-rhapsody` | 5 | **7** | and its ±500 falls 83.3 → 80.6 |
| `never-be-alone` | 8 | **13** | round 1's orphan-echo fix, second order: 14 lines re-apportioned, six of them over 2 s that were not |
| **pooled** | **68** | **75** | |

Reach: **37 of 1088 song-modes across 9 songs** and the published document changes in **130** across 10
(`onsets_sha256` in 128) — the same sets as before round 1 — identity on the other **22** BY CONSTRUCTION (no
mid-line parenthetical, no echo tail). `never-be-alone` loses two published lines (46 → 44), one of them the
orphan echo and one because excluding an echo tail from the lead decode moves the never-sung rule's median;
that shrinking denominator is also why `truth` ±500 reads 90.89 → **90.94** — two fewer lines scored, not two
better ones.

**AND THE WORSE HALF, which the blind table alone hides**: the shipped default carries **0** gross lines
across all thirteen TIMED CLAIM modes, and the arm carries **1** (0 → 4 before round 1 fixed `tempo102`) —
`bad-guy` `jit`, **and the gross line is the arm's own ad-lib**: line 64, the echo tail it held out of the
lead decode and interpolated back, +2.16 s. A technique sold as a blind-decode repair is not allowed to cost a
gross line where a claim was published, and `gates/w5-flip.yaml` agrees independently: the arm reads **38/40**
there against the base bundle (37/40 before round 1), still failing both of section 3's per-song counts, where
the default reads 40/40. `truth` gross is untouched (0 = 0), as are `headers` / `credit` / `extraverse` (±0.1
pt), `drop20` (12 = 12) and every wrong-text reading (0 of 320, both spellings, 320/320 refused); `drop50`
goes 167 → 169.
**So the answer to "does §3.13 generalise?" is NO, with a number per song, and the arm is correctly off** —
and round 1 made that answer stronger, not weaker: the fix that repaired the arm's claim-mode cost deepened
its blind cost, which is what a technique whose budget has been spent elsewhere looks like.

### The gate table for the wave

| gate file | read on | base | verdict |
|---|---|---|---|
| `w5-flip.yaml` | `w5-time_text` | `w6-base-time_text` | **40/40** |
| `w5-flip.yaml` | `w5-run_align` | `w5-base-run_align` | **40/40** (reversed: 9/40) |
| `w5-flip.yaml` | `w5-run_align` | `w6-hubert-run_align` | 38/40 — both `text_pm500`, §4 |
| `w5.yaml` | `w5-run_align` | `w6-hubert-run_align` | **39/40** (the one FAIL is the PLAN's 0.3 pt truth-±500 bar, §4) |
| `w5.yaml` | `w5-time_text` | `w6-hubert-time_text` | 36/39 — section 2 is `run_align`-only |
| `w5-denominator.yaml` | `w5-run_align` | `w5-base-run_align` | **15/15** (W6 tree: 7/15) |
| `w5-adlibs.yaml` | `w5-adlibs-time_text` | `w5-time_text` | 7/11 — the arm fails its own bar |
| `w0-reproduce-time_text.yaml` | `w5-time_text` | — | **11/11** |
| `w0-reproduce-generate.yaml` (rebased here) | `w5-generate` | — | **11/11** (base bundle: 1/11) |
| `w2.yaml` | `w5-time_text` | `w6-hubert-time_text` | **89/89** |
| `w2.yaml` | `w5-run_align` | `w6-hubert-run_align` | 69/89 — all 20 are `text_pm500`, §4 |
| `w3-lines.yaml` | `w5-lines-run_align` | `w6-lines-run_align` | 34/38 — §3 |
| `w3-lines.yaml` | `w5-lines-run_align` | `w5-base-lines-run_align` | 34/38 — the SAME four, now on one tree |
| `w3-lines.yaml` | `w5-base-lines-run_align` | `w5-lines-run_align` | 31/38 — reverting the bundle fails 3 more |
| `w4b.yaml` | `w5-time_text` / `w5-run_align` | the base bundle | 28/30, the two accepted residuals |
| `w4b-hubert.yaml` | `w5-time_text` / `w5-run_align` | the base bundle | 21/22, `Tom_Orlando` −1.52 |
| `w6.yaml` | `w5-time_text` / `w5-run_align` | the base bundle | 32/33, the overruled per-song clause |
| `w6-ladder.yaml` | `w5-run_align` | `w6-hubert-run_align` | 28/31 — the hygiene's blind footprint |

### The verification pass on the W5 sweep: the committed rows HOLD on the tree that ships, and the one run nobody had is in (W5 bench re-dispatch, 2026-10-01)

The sweep above was measured on code **`db84383732037c63`**. Three verification passes edited the tree
afterwards (four worker docstrings, one test, `scripts/e2e.py`'s own docstring), so the shipped tree digests
as **`52304846f1dc751f`** and the emission cache's emitter fingerprint as **`9ad235d50d1125e6`** against the
sweep's. Two consequences, and neither is "re-bench": a `--resume` into any of those six run directories is
REFUSED by design (the resume check compares `code`), and the disk cache is cold corpus-wide. **That the rows
still hold is MEASURED, twice, not argued from a diff:**

* **136 cases replayed on the shipped tree are byte-identical to the committed digests.** Two songs
  (`shape-of-you`, `numb` — the wave's two per-song findings) × 16 modes at `--level run_align`, and the same
  at `--sync-mode lines`: every field of the compact digest equal, including `doc_sha256`, `onsets_sha256`,
  `served_lines`, `scored`, `gross`, `published_label` and `confidence`. The forced run recomputed **4
  emission matrices COLD** under the new fingerprint and still produced the same documents, so the matrices
  are reproducible as well as the decode (`_runs/w5v-forced`, `_runs/w5v-lines`).
* **All six committed rows re-summarise identically with the current harness** (`a87b17a15228c321` against the
  sweep's `d37aa94c717c3322`, the difference being `e2e.py`'s docstring): `e2e_lib.rows_document` over each
  run's full `rows.jsonl` reproduces `summary` AND the per-song block to the digit, 6528 cases in total. And
  every gate verdict the sweep recorded re-reads the same offline — `w5-flip` 40/40 twice, `w5` 39/39 as the file then read (39/40 since r1-spec-13 split its truth-±500 clause) and
  36/39, `w5-denominator` 15/15 (W6 tree 7/15), `w5-adlibs` 7/11, `w3-lines` 34/38, `w0-reproduce-*` 11/11
  (1/11 and 3/11 on the base bundle), `w2` 89/89 and 69/89, `w4b` 28/30, `w4b-hubert` 21/22, `w6` 32/33,
  `w6-ladder` 28/31 — with the failing gate NAMES identical too.

**THE RUN NOBODY HAD, now paid: the base bundle in `lines` mode on this tree** (`w5-base-lines-run_align`,
966 s, 32 cold matrices, 0 ERROR rows). The sweep read the lines A/B against the W6 tree because no
same-tree control existed, and said so. With the control in hand the attribution SPLITS: **21 of the 23
recovered song-modes are the FLIP's and 3 are the HYGIENE's** (§3 above carries the table). Two more things
only this control can say:

* **`gates/w3-lines.yaml` reads 34/38 for HuBERT-L against it — the same four failures as against the W6 row,
  so that verdict was not an artefact of the cross-tree base** — and 31/38 in the REVERSE direction: putting
  the base bundle back fails `committed-not-down-drop20`, `committed-not-down-drop50` and `off15-text-pm500`
  on top of the four. The lines-mode ratchet holds in both directions.
* **IN `lines` MODE THE DENOMINATOR ARTEFACT IS ABSENT, which is the cleanest form of the §5 result.** Across
  1088 cases the two bundles differ in `scored` in 22 song-modes / 11 songs, and EVERY one of them is a
  document that exists on one side only (0 ↔ N; 21 gained, `shape-of-you` drop50 lost). Not one song-mode has
  both bundles committing a document and scoring a different NUMBER of lines — the never-sung envelope rule
  and `_fitted_run`'s refusal, which are what §5's remaining 86 are, do not run on the LINE_SYNC rung.
  `gates/w5-denominator.yaml` read on this pair is 13/15, and both failures are the refusal count (its
  literals are the forced rung's: `drop50` 10 songs against a bound of 6, pooled `scored` 1712 against
  1669 + 4) — it is not a gate for this level and is recorded here so nobody reads it as one.

## W7: the language is an INPUT, and review M9's blank is LIVE (2026-10-01; review M8 + §3 item 9)

Until this wave the alignment language was the literal `"en"` on every job. The decision function existed —
`steps.api.language_of` has always read `TextRef.language`, then the job's `language` param, then `"en"` — and
**nothing ever gave it a value**: core sends no `language` (deliberately; its `JobParams` says "a guessed one
is worse than letting ASR detect it"), no adapter set `TextRef.language`, and whisper's own
`result['language']` was read off its result dict and thrown away. Two measured consequences, both review M8:
a Japanese sheet has **zero** characters the English vocabulary maps, so every attempt declined and the job
published `no lyrics` (repro s12); and an accented Latin letter was silently skipped out of the target
sequence, so `cafés` decoded as `cafs`.

The second half of the same finding is review M9, the hard-coded CTC blank, **dormant only while the language
is always `en`** — torchaudio's English bundles put their blank at 0 and 23 of whisperx's 36 HF align models
do not. W4 built `Emissions.blank_id`; W4b and W6 confirmed it was still unreachable. **W7 is the wave that
arms it, so W7 is also the wave that can detonate it**, which is why the two landed together and why the
measurement below leads with a non-zero-pad model.

### What carries the language now

* **A Unicode SCRIPT histogram of the text — the primary signal** (`domain/lyrics/language.py`, stdlib
  `unicodedata` only, no data file and no dependency). Read off each character's own UCD name
  (`LATIN SMALL LETTER E WITH ACUTE` → Latin, `HANGUL SYLLABLE HAN` → Hangul) plus a 12-entry alias table, so
  one `str.split` covers every writing system Python's Unicode database knows — including ones added after it
  was written. **Not vocabulary coverage**, which is the critics' point the review recorded: every Latin
  wav2vec2 vocabulary covers English text, and the fr/de/es fine-tunes cover it MORE fully than the English
  bundle covers French, so coverage would take Latin songs away from the bundle that times them best.
* **whisper's `result['language']`** where ASR ran — the one language signal on this worker measured from the
  recording rather than inferred from glyphs or declared by a room. `ports.Transcriber.transcribe` returns
  `Transcribed(segments, language)` now instead of a bare segment list, which is the line review M8 names.
* **lingua-py for Latin-script disambiguation**, restricted to the languages whisperx tables a Latin bundle
  for. OPTIONAL (`text` extra): with no detector installed Latin script stays English, which is exactly the
  configuration every row in `results/` was measured on. Costs 0.05 s to build, 0.11 s for the first
  detection, 3 ms after that, 34 MB resident.
* **NFKD folding instead of dropping** (`generate.char_ids`, now the ONE copy of the target filter — W7 found
  three: `char_targets`, `alignable_chars` and `lexical.letters_of`).

Detection happens in the ACQUIRING step, once, and is checkpointed on `TextRef.language`: the workflow must be
deterministic under a DBOS replay and may not hold a 100 MB detector, and a resumed job must align in the
language it started in. `TimeRequest.language` is the TEXT's (the published document's, the syllabifier's);
the BUNDLE's is derived per attempt by `language.model_language` through `align_steps._bundle_language`, the
one reader, so no call site can forget `on_mix` or the arm.

### The fold is provably free on every recorded row (`lang_gate.py --folds`)

| corpus | cleaned lines | characters | scripts | fold to a letter the English vocabulary has | NFKD cannot decompose |
|---|---|---|---|---|---|
| the 32-song English corpus | 1 712 | 50 516 | Latin 40 409, **nothing else** | **0** | **0** |
| the 59 fr/de/es JamendoLyrics songs | 2 515 | 81 925 | Latin 67 928 | **1 035** | 43 |

So `char_ids` returns byte-identically what the three inlined copies returned on every text the bench serves
at `--level time_text` — the claim modes are built from those truth lines, the `wrongtext` donors are other
corpus songs' truth lines, and `headers` injects ASCII. **The English corpus cannot show the fix working**;
the fr/de/es songs can, where 1.3% of every character in the sheets used to be dropped (`é` 322, `ü` 184,
`ä` 110, `à` 92, `ê` 74, `ö` 67, `è` 64, `ñ` 56, `ç` 28, and 38 more over seven letters), concentrated in
exactly the words an accent distinguishes. The 43 that stay dropped are `ß` (41) and `œ` (2): atomic in
Unicode, so NFKD has no decomposition, and a hand table (`ß` → `ss` changes the character COUNT too) is a
measured change of its own.

### The language reading, widened from n=7 to n=59 under the bundle that ships

The review measured fr/de/es STEMS at 91.8% of words within ±300 ms under the English model — the same as
English Jamendo's 91.1% — and routing winning only on the MIX (de 50.1→85.9, es 47.9→62.6, fr 66.0→72.2).
Both halves were **n=7 songs** (2 fr, 3 de, 2 es) on the BASE bundle, which has not been the default since
W5's flip, and the critics' objection was exactly that. This wave separated the other 52 fr/de/es
JamendoLyrics songs (`_lang/separate.sh`, htdemucs, ~15 s a song) and read all 59 on both targets under
`ml.DEFAULT_ALIGN_MODEL` (`scripts/lang_gate.py`, `results/w7-lang-{stem,mix}.json`, 2 515 measured lines /
15 887 measured word onsets per arm, BLIND — no claims, no repair ladder, no gate, so the question is only
which bundle hears these words where). The positional truth pairing the scorer depends on is CHECKED, not
assumed: over all 59 songs `clean_segments` is the identity on both counts — 2 515 lines in, 2 515 out, and
**0 lines whose word count changed** — because dataset annotations carry no header, no `♪` and no caption tag
for the anchored rules to anchor on.

**STEM — the review's conclusion CONFIRMED and wider than it found it. The default (English) bundle wins.**

| | lines | gross | ±500 | words ±100 | ±250 | ±300 | AAE per word (per song) | words >2 s off |
|---|---|---|---|---|---|---|---|---|
| default, pooled | 2 515 | 80 | 90.78% | 83.48% | 94.06% | **94.78%** | **186 ms** (236) | **188** |
| routed, pooled | 2 515 | 99 | 92.29% | 83.69% | 92.13% | 92.97% | 389 ms (540) | 485 |
| fr default / routed | 763 | 32 / 36 | 86.50 / 90.56 | 77.15 / 82.53 | 90.62 / 90.37 | 91.45 / 91.45 | 235 / 268 (322 / 324) | 85 / 153 |
| de default / routed | 871 | 30 / 19 | 93.57 / 96.44 | 87.82 / 83.52 | 95.99 / 95.50 | 96.68 / 96.39 | 173 / 308 (203 / 609) | 68 / 95 |
| es default / routed | 881 | 18 / 44 | 91.71 / 89.67 | 85.80 / 85.06 | 95.75 / 90.64 | 96.36 / **91.19** | 149 / 593 (187 / 677) | 35 / 237 |

**TWO AAEs, AND THE PAIR IS THE POINT** (W7 review r2-tests-14). `lang_gate.pooled` recomputes every band
from the summed counts, but its only absolute error used to be the UNWEIGHTED mean of the per-song means,
printed as a bare `AAE=` and quoted here and in `language.model_language` as a pooled number. The true pooled
error over the 15 887 words is **186 ms against 389**, not 236 against 540; both are now emitted
(`word_aae_ms` per word, `song_aae_ms` per song) and both are printed with their denominator named. The
VERDICT is unmoved — the gap is wider per word than per song — but the number that was published was the
wrong one.

Routing **more than doubles the catastrophic tail** (188 → 485 words more than 2 s off) and costs 1.81 pt of
±300. Per song, routed **WINS 20, LOSES 32, ties 7** (±300, 0.5 pt dead band), and the losses are far deeper
than the wins: es `Intentando_Destacar` −23.7 pt, de `Intro_[Pulsschlag]` −28.0, es `Baila` −12.8, es
`Te_Recuerdo` −14.2 against fr `CHRISTMAS_AVEC_TOI` +16.0, de `Die_Revolution` +15.4, fr `Culture_&_Co.`
+13.6. **The one column routing wins on the stem is LINE starts** — ±500 92.29% against 90.78%, and German
gross lines 19 against 30 — which is real and is not the column the karaoke ball is scored on. The default
bundle also reads **94.78% here against the review's 91.8%**, so W5's flip repaid non-English Latin songs too:
it is now better on fr/de/es stems than the base bundle was on them.

**MIX — the review's mix win DOES NOT REPRODUCE. It is German's, and nothing else measurable here.**

| | gross | ±500 | words ±100 | ±250 | ±300 | AAE per word (per song) | words >2 s off |
|---|---|---|---|---|---|---|---|
| default, pooled | 415 | 71.89% | 66.51% | 76.46% | 77.47% | 2 011 ms (2 812) | 2 111 |
| routed, pooled | 372 | 76.26% | 70.35% | 79.01% | **80.08%** | 1 946 ms (2 711) | 1 940 |
| fr default / routed | 118 / **150** | 71.17 / 72.87 | 64.16 / 65.65 | 76.14 / 74.13 | 77.44 / **75.28** | 1 922 / 2 500 (2 821 / 2 988) | 581 / **861** |
| de default / routed | 155 / **87** | 71.53 / 82.09 | 67.87 / 74.38 | 75.70 / 85.15 | 76.73 / **86.52** | 1 992 / 1 213 (2 941 / 2 073) | 788 / **361** |
| es default / routed | 142 / 135 | 72.87 / 73.44 | 67.60 / 71.27 | 77.53 / 78.08 | 78.23 / 78.74 | 2 121 / 2 091 (2 675 / 3 086) | 742 / 718 |

German reproduces the review's direction exactly (+9.79 pt ±300, gross 155→87, tail 788→361); **Spanish is a
wash** (+0.51 pt) where the review read 47.9→62.6; **French REVERSES** (−2.16 pt, gross 118→150, tail
581→861) where the review read 66.0→72.2. Per song, routed **WINS 26, LOSES 32, ties 1**. So the pooled +2.6
pt is one language's, and a default that routed every Latin song's mix would pay French for German.

**Hence `lang-route-mix`, default-OFF** (`host.config.ALIGN_EXPERIMENTS`), and a second reason that holds
whatever the numbers say: **a routed bundle has no `lexical.CALIBRATED` row**, so every emission-scale
threshold stands down on it — the wrong-text lift cannot refuse, the doubt band cannot grade, the placement
margin abstains (`lexical.calibration` → None, by design; that is the review's high-severity W3 finding
working as intended). Routing Latin script by default would trade measured
accuracy for an ungated wrong-text path on every non-English Latin song. **A NON-LATIN script always routes**,
arm or no arm, because there the alternative is not a trade: it is `no lyrics`.

**AND SINCE W7's REVIEW (r1-correctness-1) AN UNGATED BUNDLE PUBLISHES NO WORDS.** "Every emission-scale
threshold stands down" used to leave the v2 ENVELOPE gate as the lane's only wrong-text gate — the gate review
H3 measured passing **189 of 380** and **220 of 320** wrong texts, because it scores our own forced decode,
which the audio pulls onto the voiced frames whatever the words say. Non-Latin routing is DEFAULT-ON, so that
was the shipped state of every Korean, Japanese, Cyrillic and Arabic sheet. `_time_text_global` now DECLINES
such an attempt (`policy.decide` rule 1, not rule 0), so a sheet with its own line timings degrades to the
**LINE_SYNC rung** — whose gate is a share of lines in SECONDS (`lexical.LINE_SYNC_SHARE_UNCALIBRATED`), the
one threshold an uncalibrated matrix keeps — and an untimed one moves to the next text. The ASR tier (its words
were heard on this audio) and a PIN (a person chose it, published all-`low` and unvouched) are the two
exemptions, and **`h3-ungated-words`** (`host.config.ALIGN_EXPERIMENTS`, default-off) is the control: it
restores the pre-fix behaviour, which is also the only way left to read an uncalibrated bundle END TO END —
without it every non-ASR text of such a bundle refuses at `--level time_text`, so a wave fitting a new
per-language row (`scripts/lift_gate.py --model …`) measures its before/after under that name. **No row in
`results/` moves**: every bench run is English on a calibrated bundle, and the `lang_gate.py` rows decode
through `aligner.emissions` directly rather than through the gated step.

### What these rows' configuration is NOT: no LATIN detector ran (W7 review r1-spec-9)

Stated plainly, because a reader could previously only learn it from a missing keyword argument in the
harness's `Adapters(...)` call: at `--level run_align` the real `fetch_captions` / `fetch_provider_lyrics` run
and `language.detect` therefore runs on every acquired text — but with **`detector=None`**, where the shipped
composition root builds `language.lingua_detector()` (`__main__.build_adapters`). With no detector Latin script
can only answer `en`, so what every recorded row measures of `detect` is the SCRIPT histogram and the `en`
fallback, not lingua's accuracy; **the Latin detector, and `detect`'s own trust order, ship on unit tests**
(`tests/test_language.py`, including the real lingua over this corpus's four languages). Three things changed
so the gap cannot be silent again:

* `e2e.py --detector {off,lingua}` wires the SHIPPED factory into the bench's Adapters (`off` is the default —
  it is what every row under `results/` holds, and the rows must keep reproducing);
* **`meta["detector"]` is stamped on every `run_align` summary**, default included, and `detector` joins
  `e2e_gates.COMPARED_META`, so a run measured with one against a baseline measured without it WARNS. Every
  document committed under `results/` — W7's own rows included — was written BEFORE that stamp landed and
  therefore carries no `detector` key at all, which is why the comparison reads a missing key as the DEFAULT
  (`e2e_lib.RUN_DEFAULTS`, W7 review r2-spec-10) instead of skipping it: with the key compared only where both
  sides record it, the warning could never have fired against any existing baseline. `run.json` now records the
  value unconditionally, so an offline `--summarize` of a run's rows stamps what the run actually used, and a
  directory started before the key existed still `--resume`s (its absence IS `off`);
* a `_transcripts` entry written before `language` existed is now a cache **MISS** rather than a silent
  `heard=None` (all six entries in this box's store predate the field), and the key is written always — `null`
  included — so "the harness could not say" and "whisper said nothing" stay different facts.

What the detector can move on THIS corpus is the TEXT's language — the syllabifier's and the published
document's — and not the bundle, since `model_language` keeps Latin script on the measured default unless
`lang-route-mix` is set. A wave that wants that measured turns the flag on and re-reads the affected rows.

### Review M9, LIVE: the blank on a real non-zero-pad model (`lang_gate.py --blank`)

The review measured the hard-coded blank costing Danish word onsets within ±250 ms 90.5% → 73.2% and words
more than 2 s off 141 → 584 — **by permuting an English model's emission columns**
(`_review-scratch/encore-review/exp_blank.py`), because no non-English song with measured truth was in the
corpus and no non-zero-pad model had ever been loaded. This runs a REAL one:
**NbAiLab/nb-wav2vec2-1b-nynorsk**, `[PAD]` at 31 with **id 0 the WORD SEPARATOR `|`** — the worst of the 23
cases, because a decoder told `blank=0` spends its silences on a token the model emits BETWEEN WORDS and never
visits the real blank at all. Three German JamendoLyrics songs, real stems, real forward pass, measured word
truth (`results/w7-blank-nynorsk.json`; the LANGUAGE PAIRING is artificial and said so — no Norwegian song
with measured word truth exists on this corpus — but the model, the pad's position, the pass, the audio and
the truth are all real, which is strictly more than a column permutation).

| arm | lines | gross | ±500 | words ±250 | ±300 | AAE per word (per song) | words >2 s off |
|---|---|---|---|---|---|---|---|
| `matrix` — what ships | 143 | **7** | **92.31%** | **95.81%** | **96.10%** | **234 ms** (232) | **15** |
| `unaware` — the pre-W4 chain | 143 | 27 | 67.83% | 74.48% | 76.19% | 1 546 ms (1 541) | 133 |
| `kernel` — told 0, matrix says 31 | — | — | — | — | — | — | every decode **RAISES** |

The `unaware` arm is the honest reproduction: `blank = 0` was hard-coded in **five** places that have to agree
(the kernel call, the target filter, `_char_spans`' run grouping, its flushing sentinel, `regenerate`'s
alignable count), so the arm drops the two FIELDS rather than forcing one integer, and all five zeros come
back at once through the `getattr` defaults the shipped readers still carry. **±250 95.81% → 74.48% and words
over 2 s off 15 → 133** — the review's Danish shape (−17.3 pt, 4.1×) reproduced at −21.3 pt and 8.9× on a real
model. The `kernel` arm is what a HALF-threaded blank looks like: the grouper and the kernel disagree about
which column is blank, the span count stops matching the target count and `generate` raises
(`decode produced 2313 token spans for 1597 character targets`), which on the shipped path is
`decode failed: ValueError` on every attempt of every text and ends in `no lyrics`. Both failures are absent
from the shipped row, 0 lines dropped, on a bundle no English job will ever load.

### M13's provider ranking: still unit tests alone, and the blocker is now MEASURED

W5 carried this to W7: "either add a harness dimension that serves a REAL multi-provider pool (cached lrcmux +
LRCLIB + captions per song) or state plainly that M13 ships on unit tests alone". **It ships on unit tests
alone**, and here is why, probed rather than assumed:

* The pool is REAL where the songs are commercial: `Ed Sheeran / Shape of You` returns **lrcmux 88 cues and
  LRCLIB 90 cues**, genuinely different sheets with different timings — exactly the two-candidate case
  `policy.corroboration` was built to rank.
* But the corpus's **20 Jamendo songs are the only ones carrying artist/title** (from `JamendoLyrics.csv`),
  and on 6 probed in turn the pool is **0 or 1 member, never 2**: `HILA / Give Me The Same` 0+0,
  `Quentin Hannappe / Keep On` 0+0, `Avercage / Embers` 0+0, `Songwriterz / Back In Time` 0+48 (LRCLIB only),
  `KINEMATIC / Peyote` 14+0 (lrcmux only), `Colour Out / Falling Star` 38+0. A single-member pool cannot
  exercise "every provider is a candidate", and a sheet that comes back for an obscure CC track is very
  likely **another song's words** — LRCLIB returns its closest record, which is the trap core's
  `dispatch.ts lookupKeys` refuses to risk.
* The **9 YouTube songs and 3 tfr songs**, where a two-member pool demonstrably exists, carry **no
  artist/track metadata in the corpus at all** (their directories hold `mix.wav`, a stem and
  `truth-lines.json`), and the slugs are not reliable lookup keys.

**So the dimension is one committed file away and not a sweep away**: a `slug → (artist, track)` table for the
twelve non-Jamendo songs, after which `RecordingSteps.fetch_provider_lyrics` can serve a cached real pool and
the ranking becomes measurable. L5's MusicBrainz-length retry is in the same position for the same reason.

### Nothing on the English corpus moved, checked rather than argued

The fold is 0 characters on the English corpus and Latin script stays on the same bundle, so the wave asks for
no re-sweep — but "cannot move" is a claim, so it was spot-checked end to end: `e2e.py --level run_align
--modes truth,blind --songs hello,Pure_Mids --device cpu` (`_runs/w7-spot`, 79 s, 3 cold matrices).

| case | this tree | `results/w5-run_align.json` |
|---|---|---|
| truth hello | gross 0, ±500 100.00 | gross 0, ±500 100.00 |
| truth Pure_Mids | gross 0, ±500 100.00 | gross 0, ±500 100.00 |
| blind hello | gross 3, ±500 79.37 | gross 3, ±500 79.37 |
| blind Pure_Mids | gross 6, ±500 65.00 | gross 6, ±500 65.00 |

Identical to the digit on all four, and **0 of the 4 cases carries an `align-language` note** — which is the
whole claim: an English job resolves the same bundle through the same target filter and publishes the same
document. The EMITTER FINGERPRINT did move, to **`68ce719b4b90b57e`** (from `a51283424a0195e1`;
`adapters/ml.py`, `adapters/ports.py` and `domain/lyrics/generate.py` are all in the key), so the corpus cache
is cold and the next sweep pays one full model pass — `--resume` into an earlier run will be refused.

## W7: the star/filler token, phase A — measured at the decode, NOT yet at the claims path (2026-10-01; review §3 item 10 / D3)

The decode cannot say *"this text is not in the audio"*. `torchaudio.functional.forced_align` finds a MONOTONE
path that labels **every** frame, so audio the text does not cover — an intro, an instrumental break, a backing
vocal, the verse a partial sheet dropped — has to be charged to whichever of the text's own characters are
least implausible there, and the lines around it are dragged with it. Review D3 measured the damage: with half
the lines missing **107/387** and **165/356** line starts land more than 2 s off, a 6-line unsung verse gives
**142** gross lines, and `feel-my-heart`'s first word binds about **28 s early**.

**Phase A** is the version that needs no new kernel: append ONE column to the emission matrix, scored
`frame max − P` on every frame, and put one target of it before every line. A path may then park on the star
over uncovered audio instead of smearing a letter across it. (Phase B — *skip arcs*, a path that may leave text
out altogether — needs a vendored Viterbi and is a later wave's; §3.10 says build it only if this holds.)

### What landed

* `adapters.ml.starred(emissions, penalty=STAR_PENALTY_NATS)` — the column, named `<star>` on
  `Emissions.specials`, which is where review §3.10 says the id belongs and is already the ONE filter every
  reader of a target list shares (`generate.excluded_of`, W4b). `frame max − P` and not a constant, because a
  log-probability only means something against the rest of its own frame. The name is `<star>` and not `*`
  because `specials` is keyed by vocabulary ENTRY while `char_ids` looks up single CHARACTERS: a bundle whose
  vocabulary held `*` would have the star's name collide with a letter's, and that letter would then be dropped
  from every word containing it — review M9's defect wearing another hat.
* `domain.lyrics.generate.star_of` + `char_targets(..., stars=True)` — one star before every line that has a
  character (so a decorative `♪` row or a line the never-sung rule blanked does not buy a second absorbing
  token), including before the FIRST line, which is the star an intro is spent on. The every-word variant is
  **not built in either direction**, exactly as the `linesep` arm does not build it: a token the model never
  emits inside a phrase makes CTC leave the letters for a boundary it did not hear.
* **The star's frames are relabelled to blank before `_char_spans` AND before `_lead_starts`** — the second
  half is the one §3.10 asks for by name. Left in the label stream the star owns a span, and the onset lead
  then clamps the next line's first character against THE STAR's end instead of the previous character's; the
  review names that clamp as the likely cause of one song's ±250 drop. The span-count invariant becomes
  `spans == targets − separators − stars`, which is the check that raises on every song when any of this is
  wrong.
* **A decode arm and nothing else** (`align_steps._time_text_global`, behind `ENCORE_ALIGN_EXPERIMENTS=star`).
  The blind decode and the re-decode after a never-sung drop read the starred matrix; the lexical gate, the
  never-sung rule's `_speech_mass` witness and **every repair window** read the unstarred one. The first two
  because their floors are calibrated per bundle on star-free target sequences (`lexical.CALIBRATED`) — an arm
  that moved the population a floor was fitted on would be measuring a recalibration. The windows because
  §3.10's defect is the GLOBAL path's: a repair window is already bounded on both sides by evidence that says
  which text belongs in it, and leaving them alone keeps the arm attributable. The placement margin (review
  §3.7) DOES read the starred trellis with the same targets, because a margin measured on a decode that did not
  run is not evidence about the one that did.

### P was tuned IN-SAMPLE by the review. Here it is fitted out of sample, and the sweep is the result

`_runs/w7-star/star_sweep.py` + `star_report.py`, which deliberately do **not** touch the corpus harness: the
question is a DECODER question, and the bench's emission store already held HuBERT-Large matrices for all 32
vocals stems, so a whole 15-value sweep is **98 s of Viterbi** and no model pass. 32 songs × 4 text modes ×
15 values of P, blind global decode, line starts paired to truth **by input index** (never by text, which
mispairs a repeated chorus as soon as a line is dropped), scored over the **full served text**: `±500/t` counts
every truth line the text contains, so a line the decode never placed is a miss. `missing` is 46 of 5805 on
**every row of the grid, the control's included** — no row here buys anything by dropping lines. That is the
exact artefact the critics caught in the review's scratch scorer, whose published-lines-only denominator made
its YouTube "68 → 64" look like a gain.

| P | gross | ±250/t | ±500/t | AAE ms | MedAE | | full sheet | drop20 | drop50 | extraverse |
|---|---|---|---|---|---|---|---|---|---|---|
| **off** | 713 | 65.10 | 72.40 | 1210 | 101 | | 77 | 197 | 323 | 116 |
| 0 (MMS) | 501 | 64.91 | 74.68 | 1409 | 118 | | **102** | 124 | 145 | 130 |
| 0.1 | 440 | 71.49 | 79.26 | 992 | 88 | | 74 | 101 | 145 | 120 |
| 0.25 | 450 | 70.84 | 78.71 | 1004 | 90 | | 73 | 100 | 155 | 122 |
| 0.5 | 480 | 70.63 | 78.36 | 957 | 90 | | 72 | 111 | 186 | 111 |
| **1.0** | **551** | **69.46** | **77.11** | **1016** | **90** | | **67** | **140** | **232** | **112** |
| 2.0 | 614 | 67.67 | 75.28 | 1106 | 93 | | 67 | 167 | 269 | 111 |
| 3.0 | 643 | 66.98 | 74.56 | 1129 | 95 | | 63 | 174 | 300 | 106 |
| 4.0 | 658 | 66.74 | 74.25 | 1146 | 96 | | 67 | 176 | 307 | 108 |

(the four right-hand columns are gross line starts per mode; `0.2`, `0.3`, `0.4`, `0.75`, `1.5` and `2.5` are in
`sweep.json` / `fine.json` and change nothing about the shape. Every number in this section is recomputable
from the committed digest `results/w7-star-sweep.json` — pooled, per mode, per group, per song and per
song×mode gross for all 15 values of P — and `results/w7-star-sweep-base.json` for the base bundle; the raw
per-line errors stay in `_runs/w7-star/`.)

**The MMS constant 0 is the only row that makes the unperturbed control worse** — full-sheet gross 77 → 102,
±250 72.44 → 67.16, AAE 594 → 1251 ms — which is the review's "over-eager" objection reproduced and localised:
a star that ties with the best character absorbs SUNG frames as happily as silent ones. Every other value of P
improves every mode.

**The sweep is not one curve, and that is the finding.** Leave-one-song-out — fit P on 31 songs by pooled
gross, read the held-out song at that P — is perfectly stable (one value wins all 32 folds) and gives a
different answer per objective, because the optimum moves with how much of the sheet is missing:

| fitted on | picks | held-out gross | control |
|---|---|---|---|
| the full sheet alone | 3.0 ×31, 2.5 ×1 | 64 | 77 |
| drop20 + drop50 | 0.1 ×32 | 246 | 520 |
| all four modes | 0.1 ×32 | 440 | 713 |

So the LOSO does not choose for us: the OBJECTIVE does, and an honest fit has to name it. **P = 1.0 ships**,
for three reasons in the order they count. (1) The CONTROL is what production sees — a complete sheet is the
normal case, the curve is FLAT there from 0.75 to 4 (gross 63–68, ±500/t 82.3–82.9, AAE 585–609 ms), every one
of those rows beats the control, and 1.0 is the best of them at ±500/t and ±250/t while tying the best AAE.
(2) Among those it is the one that still helps a partial sheet (drop20 140 against 174 at P = 3, drop50 232
against 300). Going lower buys ~90 more gross lines on the partial modes and costs the control's AAE (+87 ms
at P = 0.25), and `run_align`'s truth-row AAE of 71.1 ms is a number this wave may not spend. (3) It is inside
review §3.10's range [1, 4], so the arm the bench reads is the arm the review specified. **The 0.1–0.3 region
is recorded, not discarded**: it is the partial-sheet optimum, and if §3.10's reject-if passes at 1.0 that is
where the next sweep should look.

**It transfers across bundles**, so P is not a per-model calibration like `lexical.BANDS`: the same script on
the BASE bundle (`--model WAV2VEC2_ASR_BASE_960H`, `base.json`) reads pooled gross 908 → 744 at P = 1.0, full
sheet 113 → 98 and ±500/t 76.76 → 80.11 — same direction, much the same size.

### What it costs, named rather than averaged away

Per song, pooled over the four modes, at P = 1.0: **2 of 32 songs get worse** — `never-be-alone` +2, which is
the review's OWN objection reproducing ("never-be-alone blind gets worse: 23 → 27 or 29"; here its full-sheet
decode goes 8 → 11), and `tfr-mayday` +2 — against 25 songs better and 5 unchanged. **13 of the 128 cells
regress**, 67 improve and 48 are identical. `bad-guy` ±500/t falls 6.54 → 2.69 and `numb` 41.74 → 34.78, both on songs whose
blind decode is already mostly wrong. The biggest gains are `rap-god` 28 → 10, `shape-of-you` 37 → 23,
`Tom_Orlando` 23 → 10, `Cortez` 21 → 8 and `Quentin_Hannappe` 21 → 9.

### One real song through the whole ladder (a spot check, n=1, NOT the gate)

The sweep above is the raw decode. One `--level time_text` pair on `hello` — the shipped ladder, the lexical
gate, the claim clock, the repairs, the grading, HuBERT-L on MPS, both cells on code `5d49572b6d853804`
(`_runs/w7-star-spot-{off,on}`) — says the arm survives the ladder on at least one song:

| mode | | gross | ±500 | ±500/text | lines scored | `high` |
|---|---|---|---|---|---|---|
| truth | off | 0 | 100.0 | 97.30 | 72 of 74 | 50 |
| truth | **star** | 0 | 100.0 | **100.0** | **74 of 74** | 50 |
| drop50 | off | 12 | 57.14 | 54.05 | 35 | 18 |
| drop50 | **star** | **0** | **97.14** | **91.89** | 35 | **21** |

The truth row **gains two lines it used to lose** (`missing` 2 → 0) and moves nothing it already had — which is
the shape §3.10's reject-if is written to protect — and drop50 loses every one of its 12 gross lines. Two
things worth naming beside those numbers. The trail clause is live on both cases (`star: one per line, id 29 =
frame max − 1 nats, its frames blank (star)`), so this is the arm and not the default. And the **placement
margin did not collapse** on the starred trellis, which was the predictable risk of handing it the arm's own
decode: truth median 18 nats against 15, lines under the floor 19 against 23, `high` lines 50 = 50, and drop50
`high` 21 against 18. One song is not a distribution; it is the existence proof that the ladder does not undo
the decode gain and that grading survives.

### What this is NOT: a verdict

§3.10's reject-if is about the **claims path** — "E2E with claims must not gain a gross line on any YouTube
song, and must not lose more than 0.5 pt at ±500" — and the ladder already repairs most of what the star fixes
above: W5 reads drop50 at **82** gross through `run_align` on HuBERT-L where this blind decode's control is
**323**. The honest prior for the E2E effect is therefore still the review's own (0 to −3 gross lines), with
the risk running the other way: a star absorbing frames a claim-repaired line needed. `gates/w7-star.yaml`
carries the runs and the gates, including the ones the decode sweep says to watch (`high_gross` must not rise
now that the margin reads a cheaper trellis; `missing` and `refused` must not rise at all).

The arm ships **DEFAULT-OFF** until that run exists. `tests/test_star.py` pins the behaviour either way: the
column's arithmetic, the target positions, both relabels, the span check, the drag itself (a three-line fixture
whose text omits the intro: the default publishes line 2 at 0.37 s against a 2.6 s onset, the arm at 2.57 s),
and the widths the step hands each decoder — four gate decodes on 29 columns, the global one on 30.

**The emission cache is cold again.** `adapters/ml.py` is in the emitter fingerprint, so this wave's second
edit to it moves the key a second time (W7's language half already took it from `a51283424a0195e1` to
`68ce719b4b90b57e`). The sweep above deliberately reads the **`a51283424a0195e1`** matrices — the arm and its
control on the same stored set, which is all a decoder comparison needs — and the corpus runs in
`gates/w7-star.yaml` must re-run BOTH cells on one tree.

## W7: the provider pool is real now — M13 and L5, measured end to end (2026-10-01; review M13 + L5)

W5 landed review **M13** (every provider is a candidate; the candidate tier ordered by CORROBORATION instead of
arrival order) and **L5** (an LRCLIB duration miss is retried without the duration) — and **the bench could not
see either**. `e2e.py --level run_align` serves ONE text per case: the case's timed claims as the upload's
authored track, or its untimed claims as an LRCLIB sheet, never both. So `Search`'s pool had one entry,
`order_pool` had nothing to order, `corroboration` was computed over a pool of one (False by definition) and the
L5 retry never fired, because the harness provider answered every lookup. Both shipped on unit tests alone.

`scripts/pool_gate.py` closes that. It runs the REAL `workflows.align.run_align` over corpus audio with a pool
of three to four texts, acquired by production's own `_acquire_texts` / `fetch_captions` /
`fetch_provider_lyrics` — including **the real `LrclibClient`**, driven over an injected HTTP opener that 404s
the duration-qualified lookup and answers the unqualified retry, so L5's own code path is what puts the clean
sheet in the pool. The published document is scored against truth by the same scorers every other row here uses
(`e2e_lib.row_of`), and so is **every attempt**, so one row says what the chosen text scored AND what the text
beside it would have scored.

### The pool is SYNTHETIC, derived from this corpus's truth, and the reason is not "no network"

The first choice was to cache what the providers actually return per song. Not done, for three reasons:

1. **The corpus has no metadata to look up.** `fetch_provider_lyrics` needs an artist AND a track and refuses a
   guess; the corpus is keyed by SLUG (`hello`, `Pure_Mids_-_The_Leader`) and the harness passes the slug as
   both. Real lookups would need a hand-written slug → (artist, title) table, i.e. the bench asserting song
   identity it does not have.
2. **A fetched sheet has no truth identity.** Every metric pairs a published line to a truth line through the
   CLAIM it came from (`score_lines`: `DocLine.source` → `ClaimLine.truth`). A real sheet is a different
   lineation of the same song, so most of its lines would pair with nothing and "is the chosen text better" would
   be answered on a shifting denominator — the artefact this harness exists to avoid.
3. **Caching commercial catalogue lyrics as a durable fixture is not ours to do.** lrcmux multiplexes
   KuGou / QQ / NetEase; the corpus's songs are Adele, Eminem, Queen.

So each text is built from THIS song's truth, as every other text in this benchmark is: a CLEAN sheet (served as
a real `syncedLyrics` LRC body, through the real `parse_lrc`), an **SDH** caption track of the same song, a
WRONG-SONG sheet, and the sheet that exists only because the duration-qualified lookup 404'd. What is NOT
synthetic is everything the gap was about: the acquisition steps, the labels and tiers they build, the witness
split (`policy.witness_of`), the corroboration reading, the order, the ladder, both gates, the audio and the
truth.

**The SDH variant notates nothing, and that is a measured decision.** Its damage is the 0.5 s cue LEAD
(`claimmap.py` records believer's authored track leading by ~0.5 s; the YouTube group's per-song truth bias runs
−147 to +430 ms), one misheard word every 7 lines, and the sound cues. It does NOT ♪-wrap or upper-case,
because the YouTube group's truth text IS a caption track already — bohemian-rhapsody's lines are `♪ Is this the
real life ♪`, hello's carry `(wind buffeting)` and spoken phone-call lines — and re-notating it ARMS
`nonlyric` R3, the rule that drops an unnoted line once `NOTED_SHARE` of a track's worded lines carry a note
(hello's 63/74 = 0.8514 sets that floor). The first version of the builder did wrap, pushed the share to 1.0,
and so SAVED hello's 11 unnoted lines from R3: the "polluted" text scored **72** lines against the clean sheet's
**63** and read BETTER, for a reason no real track has.

**The machine track is served on the `jit` clock (σ 0.3 s), not truth's**, for the same class of reason: a
machine track is a MEASUREMENT with error, and a control holding the truth clock is an ORACLE. Measured: with
truth timing it beat the clean sheet by 7 ±500 lines of 840 and failed this gate's own `keeps-pm500` clause —
the "worse evidence" tier outscoring a human sheet purely because the harness handed it timings nothing
produces.

### The four pools and the four arms

| pool | the texts it serves, in ARRIVAL order |
|---|---|
| `clean` | `lrclib` (the clean sheet) alone — the counterfactual every other row is read against |
| `sdh` | `captions:authored` (SDH of this song), `lrcmux:KuGou` (wrong song), `lrclib` (clean, via L5), `captions:machine` |
| `wrong-track` | `captions:authored` (ANOTHER song's words on this video's clock), `lrcmux:KuGou` (wrong), `lrclib` (clean), `captions:machine` |
| `allwrong` | three different songs' texts, no machine track (an ASR track of this audio cannot be the wrong song) |

`ranked` is the shipped tree. `arrival` is **pre-M13**: `fetch_provider_lyrics` truncated to the first provider
that answered AND `corroboration` neutralised. `pre-tie` turns off **only** the tie-break, so `arrival → pre-tie`
prices "LRCLIB is a candidate even when lrcmux answered" and `pre-tie → ranked` prices "a corroborated text goes
first". `no-l5` is the shipped ranking with the unqualified retry 404'd too.

### Measured — 12 YouTube songs, HuBERT-Large, 132 jobs forced + 96 in `lines`, 341 s + 170 s

`results/w7-pool.json`, `results/w7-pool-lines.json` (code `a50daffa196e5133`, emitter `1a2fd6852bd30243`).
`±500/pool` is over the pool's own 892 truth lines, never the published text's: pooling over the PUBLISHED text's
denominator would read a wrong-text publication as a song with nothing to find.

| pool/arm | attempts | refused | published | scored | ±500/pool |
|---|---|---|---|---|---|
| `clean/ranked` | 12 | 0 | `lrclib` ×12 | 840 | **77.91** |
| `sdh/ranked` | 12 | 0 | `captions:authored` ×12 | 839 | 77.02 |
| `sdh/arrival` | 12 | 0 | `captions:authored` ×12 | 839 | 77.02 |
| `sdh/pre-tie` | 12 | 0 | `captions:authored` ×12 | 839 | 77.02 |
| `sdh/no-l5` | 12 | 0 | `captions:authored` ×12 | 839 | 77.02 |
| `wrong-track/ranked` | **12** | **0** | `lrclib` ×12 | 840 | **77.91** |
| `wrong-track/pre-tie` | 36 | 24 | `lrclib` ×12 | 840 | 77.91 |
| `wrong-track/arrival` | 38 | 24 | `captions:machine` ×12 | 840 | 76.57 |
| `wrong-track/no-l5` | 38 | 24 | `captions:machine` ×12 | 840 | 76.57 |
| `allwrong/ranked` | 36 | **36** | **no-lyrics ×12** | 0 | — |
| `allwrong/arrival` | 24 | 24 | **no-lyrics ×12** | 0 | — |

**1. The corroboration tie-break changes the CHOSEN TEXT on 0 of 12 songs, in every pool.** Which is what
`order_pool`'s docstring already said and nobody had measured: it demotes a text NOTHING in the pool agrees with,
and an SDH track of this song agrees with a clean sheet of it, so on review M13's own motivating case the SDH
text is still tried first — `sdh/ranked`, `sdh/arrival` and `sdh/pre-tie` publish the same document on all 12
songs.

**2. What the tie-break does buy is ATTEMPTS.** In `wrong-track` the clean sheet is corroborated (by the machine
track, the third witness) and the authored track agrees with nothing, so `ranked` spends **12 attempts, 0
refused** where `pre-tie` spends **36, 24 refused** — the same published document, two fewer whole attempts per
song, each an emission pass, the repair ladder and both gates.

**3. The half that moves accuracy is "every provider is a candidate".** `arrival` keeps only lrcmux's wrong
sheet, so after both candidates are refused the job publishes YouTube's **machine track** on 12 of 12 songs:
**76.57 against 77.91** (+12 ±500 lines of the 840 both arms scored), and `textConfidence` `low` instead of
`high` — the TV's "not verified" mark — on a song a human sheet existed for.

**4. L5 is why that sheet is in the pool at all.** `no-l5` reads **identical to `arrival`**: the same 12
machine-track publications, the same −12. The retry is one HTTP request and it is worth the whole of finding 3
on this corpus (`l5-is-why-the-clean-sheet-is-in-the-pool`: the sheet is absent from 24 of 24 pools without it).

**5. The MUST holds: 0 of 228 jobs published a text with no truth line**, in any pool, any arm, either sync
mode, and `allwrong` ends in `no-lyrics` on 12 of 12 songs both ways. The reason is not the ranking — it is the
per-attempt lexical lift, and the populations are not close: the 132 attempts on a wrong text read lift
**−0.09 … +0.12** nats/letter (median −0.00) against the 112 right-text attempts' **2.42 … 5.50** (median
**3.49**). The ranking cannot admit a wrong text because by the time the order matters the gate has already
refused it.

### …and in `syncMode=lines` the SDH text costs 176 lines, because the rung publishes its claims verbatim

| pool/arm (`--sync-mode lines`) | attempts | refused | published | scored | ±500/pool |
|---|---|---|---|---|---|
| `clean/ranked` | 12 | 0 | `lrclib` ×12 | 844 | **83.41** |
| `sdh/ranked` = `sdh/arrival` | 12 | 0 | `captions:authored` ×12 | 844 | **63.68** |
| `wrong-track/ranked` | 12 | 0 | `lrclib` ×12 | 844 | **83.41** |
| `wrong-track/arrival` | 36 | 24 | `captions:machine` ×12 | 844 | 77.47 |
| `allwrong/ranked` / `arrival` | 36 / 24 | 36 / 24 | **no-lyrics ×12** | 0 | — |

The forced path's claim clock absorbs an SDH lead — `sdh/ranked` against `clean/ranked` is **−7 of 839 shared
lines** (rap-god −7, ±1 noise elsewhere, 0 gross either way). The LINE_SYNC rung does not absorb it, because the
document it publishes IS the text's own claimed starts: the same comparison in `lines` is **−176 of 844**
(hello 40/63, rap-god 112/216, shape-of-you 50/88, feel-my-heart 21/32; 0 gross, since a 0.5 s lead is not 2 s).
`wrong-track` reads the same way from the other side: ranked's sheet beats arrival's machine track by **+53**.

So the value of ranking the pool by TEXT QUALITY is an order of magnitude larger in `lines` than in `forced`,
and that is where M13's deferred half — the LEXICAL LIFT ranking, which needs an emission matrix before the
first attempt — would be read. Stated as a number rather than an intuition for the first time: on this corpus,
with a 0.5 s lead, choosing the sheet over the agreeing SDH track is worth **20.8 pt of ±500** in `lines` and
**0.8 pt** in `forced`.

**And in `lines` there is already an audio-grounded score that costs no model pass.** The rung's own gate
computes `activity.fit_sheet_to_audio` over each text's claimed spans (`align_lines._sheet_spans`) — an
ENVELOPE correlation and lag, no emissions — and `sheet_gate.py` has its populations: caption-shaped truth
spans pass 241/416 right texts at 0/320 wrong, median r 0.33 on the mix against the wrong texts' 0.17. Ranking
the `lines` pool by that `r` (or simply by |lag|, which is exactly what an SDH lead IS) would be "prefer the
text the audio agrees with" at zero model cost, in the one mode where the measurement above says it pays. Not
built, not measured — the number above is the budget it would be judged against.

### Where the rows are, and what it costs to re-read them

```
cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/pool_gate.py \
    --songs youtube --out ../docs/benchmarks/forced-alignment/results/w7-pool.json
cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/pool_gate.py \
    --songs youtube --sync-mode lines --pools sdh,wrong-track,allwrong,clean --arms ranked,arrival \
    --out ../docs/benchmarks/forced-alignment/results/w7-pool-lines.json
cd worker && .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/pool_gate.py \
    --from ../docs/benchmarks/forced-alignment/results/w7-pool.json     # re-summarise, no model pass
```

The emission cache is keyed on the AUDIO, not the text, so a song pays one model pass for all its pools and arms
— 8.5 minutes for all 228 jobs on a warm store. Hermetic coverage is `worker/tests/test_pool_gate.py` (24
tests): the pool's shape and witness split, the two states the ranking can be in, the L5 opener against the real
client, and the arms driven through the real workflow over the E2E harness's synthetic song.

**THE `lines` ROW'S OWN GATES WERE SKIPPED WHEN IT WAS FIRST RECORDED** (W7 review r2-spec-9, fixed and
re-summarised with no model pass): `tally` keyed a `lines` cell `pool/arm/lines` while `verdicts` looked up
`pool/arm`, so under `--sync-mode lines` every per-pool MUST found nothing and was silently skipped — the
committed document carried **2 verdicts against the forced run's 13**, both passing, and the script exited 0.
`key_of` is now the one spelling, the gate name carries the non-default sync mode, and a new built-in
`every-planned-comparison-was-read` FAILS where rows exist that no comparison read. Re-read from the same rows:
the `lines` run is **11/11** (8 per-pool MUSTs, the two built-ins, the new one) and the forced run **14/14**,
every verdict PASS — so the reading the wave was accepted on survives, but it had not been taken.

The YouTube twelve are the group with genuine multi-source texts, which is why the row above is theirs; the
JAMENDO half was spot-checked on 2 songs (22 jobs, all 13 verdicts green) and reads the same way — `ranked`
publishes the sheet, `arrival` and `no-l5` publish the machine track three ±500 lines worse on each song — with
the WORD metrics live there (159 paired onsets, `mismatched` **0**, so the SDH variant's one-slip-per-7-lines
keeps `score_words`' positional pairing exactly as its builder claims).

## The W7 corpus sweep: the wave is a measured NO-OP on the default, and §3.10's star REJECTS at the claims path (W7 bench, 2026-10-01)

Six corpus runs plus two off-bench harnesses, all on one tree — worker code `fd9a5a6ddb641cd3`, emitter
`1a2fd6852bd30243`, HuBERT-Large, seed 0, `wrong_k` 10, `--tfr-audio youtube`, mps, `--asr off`. W7 landed three
things DEFAULT-ON (language as an input, M9's `blank_id`, M13's ranking + L5's retry) and two DEFAULT-OFF
(`star`, `lang-route-mix`), and this is what the corpus says about each.

### The headline: the default-on half does not move one byte

| run | level | vs | result |
| --- | --- | --- | --- |
| `results/w7-time_text.json` | `time_text`, 16 modes, 1088 cases | `w5-time_text.json` | EVERY metric `(=)`; `count(song.doc_changed) == 0` |
| `results/w7-run_align.json` | `run_align`, 16 modes, 1088 cases | `w5r2-run_align.json` | EVERY metric `(=)`; `count(song.doc_changed) == 0` |
| `results/w7-lines-run_align.json` | `run_align --sync-mode lines`, 1088 cases | `w5r2-lines-run_align.json` | EVERY metric `(=)`; `count(song.doc_changed) == 0` |
| `results/w7-generate.json` | `generate`, blind, 20 Jamendo | `w5-generate.json` | EVERY metric `(=)` |

`gates/w7.yaml` 45/45 on all three control runs, `gates/w7-words.yaml` 25/25 on the two that have word onsets,
`gates/w7-truth.yaml` 18/18 on the forced `run_align` run, `gates/w7-wrongtext.yaml` 10/10 on all five runs that
carry both wrong-text modes (the three controls, the star arm, and the star arm in `lines`) — **253 gate
readings, every one green**, 0 ERROR rows in all 5268 cases of the eight runs below, and **3200
wrong-text cases across five runs with not one published**. The `run_align` truth row, with its denominators, is unchanged from W5: **gross 0**, ±500 **90.45**
(1544 of 1707 scored lines), ±500/text **87.73** (1544 of the 1760 the texts asked for, 53 missing), **32 of 32**
zero-gross songs, Jamendo words ±100 **85.46** / ±250 96.58 / ±300 **97.16** / AAE **71.1 ms** over 5378 aligned
of 5693 in text, word end ±100 80.34, highlight **81.40 %** of 2432.77 sung seconds, wrongtext **0/320** and
wrongtext+ownclock **0/320** — and 0 of 640 in `lines`, which is the rung's own floor with the routing and the
ranking live.

That is the right answer and it is worth saying why it is not a tautology. The three default-on changes all sit
ON the align path of an English song: `generate.char_ids` is now the ONE target filter and folds NFKD before it
looks a character up, `ports.Transcribed` carries a language the four acquiring steps write onto `TextRef`, and
`policy.decide` orders a candidate pool it did not order before. Each is meant to be the identity here — the
routing policy must return the English bundle for a Latin-script sheet, the fold must be the identity on ASCII,
and a corpus pool of one has nothing to re-order. `count(song.doc_changed) == 0` over the 3264 cases of the
three gated control runs is the statement that all three are, at the level of bytes. A single mis-folded character would have shown up in
`word_pm100` long before a line start moved, which is why `gates/w7-words.yaml` exists as its own file.

### §3.10's star: the decode gain is real, reproduces to the digit, and does NOT survive the ladder

Two pairs, both arm-against-control on this one tree (`align_experiments` is in the emission cache key, so the
arm recomputes every matrix; the 32 cold HuBERT-L passes cost 248 s).

**The decode axis** (`results/w7-star-{off,on}-generate.json`, `--level generate`, 32 songs × 4 text modes)
reproduces the off-bench P sweep (`results/w7-star-sweep.json`) **exactly** through the shipped harness, which
retires the question of whether `star_sweep.py` measured the same thing production runs:

| mode (served lines) | gross off → on | ±500/text off → on |
| --- | --- | --- |
| full sheet (1746, 14 unscored) | 77 → **67** | 80.51 → **82.90** |
| drop20 (1402, 10 unscored) | 197 → **140** | 69.83 → **76.13** |
| drop50 (865, 8 unscored) | 323 → **232** | 48.34 → **60.60** |
| extraverse (1746, 14 unscored) | 116 → **112** | 78.30 → **80.28** |
| pooled (5759 of 5805) | 713 → **551** | 72.40 → **77.11** |

It also shows a cost the off-bench sweep never printed: **word ENDS get worse where line starts get better**.
Phrase-final end ±100 30.5 → 28.3 on the full sheet and 30.5 → 28.2 on extraverse, highlight 64.7 → 63.7 and
61.0 → 60.0. The star is somewhere cheap for the path to wait, and the frames it absorbs are the ones the last
word of the previous line used to be charged — so that line starts right and ends early.

**The E2E axis** is the one §3.10 writes its reject-if over, and it REJECTS. `results/w7-star-run_align.json`
against `results/w7-run_align.json`, same tree, 1088 cases: `gates/w7-star.yaml` **32/36 — REJECT**.

* `no-youtube-song-gains-a-gross-line` → **14** (mode × song cells). Eleven of them are **`never-be-alone`
  losing one line to `missing`** (1 → 2 of its 47 truth lines) in 11 of the 16 modes — truth, jit, off05, off15,
  off3, offm1, tempo098, tempo102, drop20, blind, headers. The other three: `tfr-mayday` drop20 (+1 missing),
  `shape-of-you` blind (+1 gross), and `tfr-chosen` blind (gross 8 → 10 with missing 5 → 3, i.e. it published two
  lines it used to skip and both are wrong). `never-be-alone` is the review's OWN objection to the star, and it
  reproduces on the path that publishes. The `missing_up` rider is what caught it: `gross` counts published
  lines, so a line that stops being published reads as an improvement without it.
* `truth-no-song-loses-lines` → **1**: that is `never-be-alone` under TRUTH claims, which PLAN-alignment-v3
  forbids outright.
* `no-jamendo-song-worse-at-word-pm300` → **−4.26 pt** (`HILA_-_Give_Me_the_Same` 98.98 → 94.72).
* `high-gross-not-up` → **3 ≤ 2** fails: `hello` gains a `high`-confidence gross line in `blind` (0 → 1,
  alongside `rap-god`'s unchanged 2), which is the one thing §3.7's rule says may never rise.

`gates/w7.yaml` reads 42/45 on the arm for the same reason, plus the one extra cell the YouTube-only clause does
not see: `Kinematic_-_Peyote` drop50 (+2 missing) and `Avercage_-_Embers` blind (+1 gross), both Jamendo — 16
cells in all.

And on the wave's own bars it costs the shipped row directly: `gates/w7-truth.yaml` 15/18 and
`gates/w7-words.yaml` 15/25 — Jamendo ±100 85.46 → **84.94**, ±250 96.58 → 96.20, ±300 97.16 → **96.81**, AAE
**71.1 → 74.1 ms**, MedAE 37.5 → 37.9, word end ±100 80.34 → 80.21 — and 442 of 1088 published documents change.

What it buys is not nothing, which is why the arm is kept rather than deleted: pooled gross across all modes
143 → **98**, drop50 gross 82 → **44** with ±500/text 75.72 → **81.90** and missing 55 → **28**, blind gross
61 → 54 and ±500/text 79.20 → 80.17, drop20 ±500 90.31 → 90.82, jit ±500 87.17 → 88.36, drop50 Jamendo AAE
711.6 → 456.7 ms. And ONE nuance that has to be read with the word row above or it looks like a contradiction:
under truth claims the arm publishes MORE words — 5583 aligned of 5693 against 5378 — so the COVERAGE metrics
rise (`word_pco300`, every truth word the text asked for, 91.78 → **94.94**; highlight 81.40 → **82.18**) while
the PRECISION metrics over the words that did publish fall (±100 85.46 → 84.94, AAE 71.1 → 74.1 ms). The star
recovers 205 words the ladder used to leave interpolated, and times them a little worse than the ones that were
already there. That is a defensible trade for a reader who wants coverage; it is not the trade PLAN-alignment-v3
pinned, and it does not buy off the 14 line-level cells above. The wrong-text verdict is byte-identical on both
sides (0/320, 320 refused), as designed —
the gates read the UNSTARRED matrix, and read again in `lines` where the LINE_SYNC rung is a text's only attempt
(`results/w7-star-lines-wrongtext.json`, 640 cases, 470 s: **0 of 640**, all refused, `gates/w7-wrongtext.yaml`
10/10). So the trade is real and it is the wrong way round for a default: **it buys
partial-sheet line starts with full-sheet word onsets.** `star` stays DEFAULT-OFF
(`ENCORE_ALIGN_EXPERIMENTS=star`); phase B's frame-relative star and §3.15's skip arcs (W9) are where the same
audio-not-in-the-text problem gets its next attempt, now with a measured bar to beat: it must deliver drop50's
−38 gross lines without `never-be-alone`'s one.

### The language evidence, widened to n=59 and re-read under the new default bundle

`scripts/lang_gate.py`, 59 unused fr/de/es JamendoLyrics songs (de 20, es 20, fr 19 — the review argued from
n=7), both targets, HuBERT-Large as the English default, 2515 truth lines and 15887 truth words per condition.

| target | condition | word ±300 | words > 2 s out | line ±500 | gross |
| --- | --- | --- | --- | --- | --- |
| stem | default (English on all 59) | **94.78** | **188** | 90.78 | 80 |
| stem | routed (per-language bundle) | 92.97 | 485 | 92.29 | 99 |
| mix | default (English on all 59) | 77.47 | 2111 | 71.89 | 415 |
| mix | routed (per-language bundle) | **80.08** | **1940** | **76.26** | **372** |

The stem half CONFIRMS §3.9: keep English on Latin-script stems. The default is 1.81 pt better at ±300 and its
tail is **2.6× smaller** (188 words more than 2 s out against 485); per language the routed bundle is worse at
±300 on de (96.68 → 96.39) and much worse on es (96.36 → **91.19**, tail 35 → 237) and level on fr (91.45 =
91.45, tail 85 → 153). It wins on line ±500, which is the metric a wrong-but-confident word onset does not spoil
— the reason to read both.

The mix half REFUTES the same idea as a general rule, and the pooled +2.61 pt is **German's alone**: de
76.73 → **86.52** (+9.79), es 78.23 → 78.74 (+0.51), fr 77.44 → **75.28** (−2.16). A knob that helps one of three
languages and hurts another is not a default, so per-language mix routing ships DEFAULT-OFF as
`lang-route-mix` with these numbers attached.

### M9's `blank_id`, proved on a model whose `[PAD]` is not 0

`results/w7-blank-nynorsk.json`: `NbAiLab/nb-wav2vec2-1b-nynorsk` (blank at **31**, id 0 is `|`) over three
German stems, 143 truth lines and 1050 truth words, three conditions on one matrix.

| condition | gross | line ±500 | word ±250 | words > 2 s out |
| --- | --- | --- | --- | --- |
| `matrix` — blank read off the model (shipped) | 7 | 132/143 | **1006/1050 = 95.81 %** | **15** |
| `unaware` — blank assumed 0 (pre-W4) | 27 | 97/143 | 782/1050 = 74.48 % | 133 |
| `kernel` — torchaudio's hard-coded `blank=0` | — | — | — | raises |

The `kernel` row is the loud half: `ValueError: decode produced 2313 token spans for 1597 character targets …
the emission matrix and the target encoding disagree`. And an UNCALIBRATED bundle still fails before any job
runs, at the composition root (`__main__.align_model_for`, verified live on this tree):
`ConfigError: ENCORE_ALIGN_MODEL='WAV2VEC2_LARGE_XLSR_53_DE': no lexical calibration for … recalibrate with
scripts/lift_gate.py --model … before reading it as a verdict`, while the three names in `lexical.CALIBRATED`
(`HUBERT_ASR_LARGE`, `HUBERT_ASR_XLARGE`, `WAV2VEC2_ASR_BASE_960H`) resolve.

### M13 and L5, and how often the ranking actually changes the answer

`results/w7-pool{,-lines}.json`, 228 jobs over the 12 YouTube songs. **0 wrong texts published**, 0 error rows.
Separating M13's two halves:

* **"every provider is a candidate"** (ranked vs `arrival`, the `wrong-track` pool): the chosen text moves on
  **12 of 12 songs** — the clean LRCLIB sheet instead of the machine caption track — worth **+12 ±500 lines of
  840** forced and **+53 of 844** in `lines`, and it costs 12 attempts against 38.
* **the corroboration tie-break** (ranked vs `pre-tie`): the chosen text moves on **0 of 12 songs**.
* **L5's duration retry** (ranked vs `no-l5`): same +12 of 840 — the clean sheet is absent from **24 of 24**
  pools without it, so the retry is why it is a candidate at all.

### What was run, and what it cost

| tag | command | cases | wall | emissions |
| --- | --- | --- | --- | --- |
| `w7-tt` | `--level time_text --modes all,wrongtext+ownclock` | 1088 | 1282 s | 39 computed, 24 disk, 1222 memory |
| `w7-ra` | `--level run_align --modes all,wrongtext+ownclock` | 1088 | 997 s | 60 disk, 1201 memory |
| `w7-lines` | `--level run_align --sync-mode lines --modes all,wrongtext+ownclock` | 1088 | 867 s | 32 disk, 1024 memory |
| `w7-generate` | `--level generate --modes blind --songs jamendo` | 20 | 14 s | 20 disk |
| `w7-star-off-generate` | `--level generate --modes truth,drop20,drop50,extraverse` | 128 | 25 s | 32 disk, 96 memory |
| `w7-star-on-generate` | the same, `ENCORE_ALIGN_EXPERIMENTS=star` | 128 | 260 s | **32 computed**, 96 memory |
| `w7-star-run_align` | `--level run_align --modes all,wrongtext+ownclock`, star | 1088 | 1217 s | 29 computed, 32 disk, 1193 memory |
| `w7-star-lines-wt` | `--level run_align --sync-mode lines --modes wrongtext,wrongtext+ownclock`, star | 640 | 470 s | 32 disk, 608 memory |

Two notes for whoever runs the next wave. (a) The emitter fingerprint for this tree is `1a2fd6852bd30243`, **not**
the `a51283424a0195e1` the W7 briefs carry: W7's own `adapters/ml.py` work moved it again after W5's round-2
re-bench, so the CONTROL cells were cold too (39 recomputes in run 1, which is the 218 s the `truth` mode took).
Everything after run 1 read the store. (b) `results/w5r2-time_text.json` **does not exist** and a brief that
names it means `results/w5-time_text.json`: W5 r2's own `meta.baseline` declares that level's baseline unchanged
from r1 (`time_text` serves the claims raw, so no text-hygiene change can reach it) and `_runs/w5r2-tt-control`
reproduced it byte-identically.

## W7b: the readings that lived inside the code (2026-10-01)

The owner's directive of 2026-10-01 — code is self-documenting, prose lives in `docs/` — found
`worker/encore_worker` carrying **3 876 comment lines and 7 764 docstring lines against 9 778 lines of code**
(54% prose; counted over 74 files, blank lines excluded, by `_tools/prose_scan.py` in the bench root). Most of
those measurement narratives already have a section above, written when the wave measured them. This section
is for the remainder: the tables, exhibits and per-song readings that were only ever written down at the
constant they justify, so that **no measured number is deleted when the code loses its essay**. Design and
mechanism moved instead to [`docs/arch/04-alignment.md`](../../arch/04-alignment.md).

The directive's own count of the same tree reads **3 685 comment and 7 577 docstring lines against 12 252 of
code — 48%**. Both are right: the directive's code column includes the package's **3 390 blank** lines and
`prose_scan.py`'s does not, and the scan charges a trailing comment on a code line to both columns. The tree is
the same one; only the denominator moved.

**The move is checkable, and the check is the point.** `_tools/prose_scan.py` recorded every numeric token in
every worker comment and docstring before the cleanup — **8 411 tokens, 6 461 of them substantive; 4 782
substantive in the two roots being cleaned, over 1 227 distinct magnitudes** — into `_prose/numbers.json`.
`_tools/verify_numbers.py` then re-reads the tree and sorts each token into **code** (a literal in Python, or
in a committed gate file), **doc** (a committed Markdown file), **fixture** (prose in a
`TERMINAL_PROSE_ROOTS` root, W9 below), **prose** (still in a comment or docstring the cleanup is relocating)
or **LOST**. Under `--strict --durable`, which counts only code, **committed** docs and fixture prose as a
home — the `PLAN-*` / `REVIEW-*` / `UI-REVIEW` working documents are gitignored, so a number that lives only
there is not kept at all — the split taken **before the subsections below were written** was:

| home | rows of 4 782 |
| --- | --- |
| a literal in code or a gate file | **3 951** |
| a committed document already | **791** |
| **nowhere but the prose about to be deleted** | **40** |

Those **40** are what the subsections below exist for, and after them the same command reads **0**. Run it —
with the interpreter PINNED, because the answer depends on it:

```
worker/.venv/bin/python _tools/verify_numbers.py --strict --durable             # 0 LOST, or the lost rows
worker/.venv/bin/python _tools/verify_numbers.py --strict --durable --control 4000   # its false-pass rate
```

**Why the interpreter is pinned** (review r2-spec-8, r2-tests-12). A bare `python3` at either repo root is
pyenv's **3.10.13**, while `worker/pyproject.toml` requires ≥ 3.12; `lift_gate.py` and `pool_gate.py` use PEP
701 f-strings and do not parse under 3.10. `prose_scan.py` therefore could not re-freeze the manifest with the
documented command at all, and `verify_numbers.split_prose_and_code` swallowed the same `SyntaxError` and
scored those two files as 100% code, crediting every magnitude in their prose to a code literal: 3.10 reported
**code 4 022 / doc 871** where 3.12 reports **code 3 984 / doc 909**, 38 rows with the wrong home. Both tools
are now LOUD — `prose_scan.scan_file` exits naming the file and the interpreter, and `verify_numbers` falls
back to a comments-only split, prints an `UNPARSED` line per file, stamps the interpreter into its JSON and
exits non-zero (the fallback narrows the 38 rows to 17, and the verdict is still **0 LOST** under both).

**And "0 LOST" is a weak test, measured rather than assumed** (review r2-spec-6). `present()` asks only whether
a magnitude's digit string occurs anywhere in ONE token set built from the entire code corpus or the entire
committed-doc corpus, and `tokens_of` also registers each token's integer head, so `1.5` satisfies a query for
`1`. `--control N` prices that directly: drawing **4 000** magnitudes that were never in the repository, with
the shape distribution of the W7b manifest's 1 245 distinct magnitudes, **715 (17.9%)** were reported
"present" — **92.2%** for an `N.N`, **44.6%** for `NN.N`, **26.5%** for a 3-digit integer, falling to **4.2%**
at `NN.NN` and **1.1%** at four integer digits. So a genuinely deleted number has roughly a one-in-six chance
of being scored `code` or `doc` anyway, and the gate's real guarantee is only that a loss cannot happen
SILENTLY in the well-shaped (3+ significant digit) class. Read `LOST 0` as "no row failed this test", never as
proof. **Re-measured on the W7c manifest** (655 distinct magnitudes, below) the same command reads **29.7%**
of 4 000 draws present — the draw is random, so an earlier run of the same command on the same tree read
**28.6%** — with the shapes, worst first: `2int+0dec` **100.0%** (105 draws), `1int+1dec` **85.1%**,
`2int+1dec` **52.7%**, `3int+0dec` **38.5%**, `1int+2dec` **31.2%**, `2int+2dec` **6.1%**. Higher than W7b's
17.9% because the smaller manifest's shape mix is shorter, which is the direction that makes the check weaker:
read the verdict with more care, not less. It did
hide two real deletions, both found by review and both now restored: `lexical.py`'s **126/320** same-video
wrong words (beside the 125/320 above) and `ml.py`'s emission-cache sizing (**~376 MB** on a 3-job box, the
**9.7k × 29 float32** English matrix shape), now in "What a cached emission matrix costs".

Without `--durable` the check also accepts prose as a home, which is how the count is watched migrating rather
than disappearing. `_tools/prose_survey.py` is the other half: it sorts all **4 772** prose blocks into keep /
measurement / design / dead and writes the per-file work list to `_prose/survey.md`, so the deletions are made
from a list rather than from an impression.

Two limits, stated rather than discovered later. **The gate is the strict set.** The manifest also records
`worker/tests` (**8 411** rows in all), which W7b's sweep does not touch; **44** of those test rows hold a
magnitude that appears nowhere but the test's own prose, and that is correct — a fixture's numbers belong
beside the fixture. (W7c swept those tests, and the re-freeze below puts them INSIDE the strict set, which is
where its 33 LOST rows came from.) And **the check is a magnitude check**: it proves the number still appears
in code or in a committed document, not that the sentence around it survived. The sentence is what the subsections below are
for; the tool only makes it impossible to lose one silently.

**A third limit, found by this wave's own review, and now closed.** `prose_scan.NUMBER` ended in `(?![\w])`, so
a magnitude written with its UNIT ATTACHED never entered the manifest at all — `40ms`, `194s`, `16kHz`, `12x` —
and a decimal with a unit silently degraded to its integer head, because `.` is not `\w` and the body
alternation backtracked (`-3.76s` → `3`). Over the pre-wave prose of the two cleaned roots that hid **112
occurrences across 18 distinct magnitudes**, so "0 LOST" could not speak for that class at all. The guard is now
`(?!\d)` — the leading `(?<![\w.])` is what keeps a digit inside an identifier like `w500` out, so no second one
is needed — and the verifier's own `TOKEN` pattern always allowed a unit suffix, which is why only the manifest
side was blind. Re-scanned from the `w7b-start` shadow snapshot the manifest reads **4 894** strict substantive
rows over **1 245** distinct magnitudes (was 4 782 / 1 227) and reproduces the pre-wave tree's file, code,
comment, docstring and block counts exactly; re-verified against the swept tree it reads **code 3 984, doc 909,
LOST 0**, with **one sanctioned row** named in `verify_numbers.SANCTIONED` and printed on every run: `.1`, the
`.1` of a `:.1f` format spec quoted in prose, which the verifier's own token pattern cannot match in code
either, so it has no reachable home by construction. A sanction that stops being needed FAILS the run, so the
set can only shrink — and two of the three it first held went stale immediately, because naming `32.7` (C1 in Hz,
in a surviving note on a MIDI note number) and `212` (the hex of `U+212A KELVIN SIGN`) in this paragraph gave
each of them a committed doc home. That is the gate doing exactly what it is for. **`SANCTIONED` is now EMPTY**
— W7c fixed `verify_numbers.TOKEN`'s inability to match a LEADING-DOT magnitude instead of excusing it, which
retired `.1` as stale, so the sentence above is W7b's state and no run prints a sanctioned row any more.

**W7c re-froze the manifest, and that is the state the two commands above read.** The W7b manifest had been
rebuilt mid-wave — four hours after the `w7c-start` tag, i.e. from a tree the sweep had already edited, with
`STRICT_ROOTS` excluding `worker/tests` entirely — so 129 rows (90 of them strict) existed that no run could
fail on. Re-frozen from the `w7c-start` TREE (extracted from the shadow repo) over all three roots with
`STRICT_ROOTS = ROOTS`, the manifest reads **2 889 strict substantive rows over 655 distinct magnitudes** —
**1 772** of them from `worker/tests`, 716 from `worker/encore_worker`, 401 from the forced-alignment harness —
and `--strict --durable` verifies **code 2 586, doc 303, LOST 0**. The first run of the wider set found **33
LOST**, all in `worker/tests`: 29 numbers still standing in test prose with no durable home, 2 real deletions
(`2.3000000000000003`, the `115 * 0.02` frame artefact, and `651`, `lang_gate.py`'s untested line count) and 2
leading-dot artefacts of the pattern above. All 31 genuine rows were given homes in
[`../../arch/04-alignment.md`](../../arch/04-alignment.md) §17 and
[`../../arch/05-worker.md`](../../arch/05-worker.md) §12-§13. The deeper chain, which is the answer to W7b's
4 894: the manifest rebuilt from `w7b-start` over all three roots — every number either wave's prose ever
carried — is **6 637 strict substantive rows, 0 LOST** (5 564 code / 1 073 doc).

**W9 reversed that direction for test prose, and the gate says which it is taking.** Giving those 29 rows doc
homes treated a FIXTURE's numbers as relocatable, which is the opposite of the ruling W7b made when it left
`worker/tests` out of the strict scope — and it did not hold: by W9 eleven more rows read `LOST`, every one of
them a number still standing in test prose (nine in `test_align_provenance.py`, one each in
`test_coherent_offset.py` and `test_prose_shape.py`). A fixture's own numbers are TERMINAL, so
`verify_numbers.TERMINAL_PROSE_ROOTS` makes prose in `worker/tests` a durable home reported as **fixture**,
and `--strict --durable` reads **2 894 strict substantive rows, 0 LOST** — 2 695 code, 188 doc, 11 fixture,
under Python 3.12. The 29 keep their doc homes; nothing was deleted to get here. The reasoning and the
mutation that shows this is not a blanket pass are in
[`../../arch/05-worker.md`](../../arch/05-worker.md) §12.

**The class did hide one real deletion**, which is why the limit was worth closing: `never-be-alone` off3's
winning claim-clock candidate flipping from `decode-median −3.18 s (14/45)` to `envelope-lag −3.76 s (4/44)`.
`gates/w4.yaml` had kept the `−3.18 s (14/45)` half and the 4-of-44 share, but **3.76** appeared in no committed
file; it is now in "The claim clock's own exhibits" below.

### What the sweep moved, and the proof it moved nothing else

**32 modules, 3 800 prose lines out.** Measured over the modules the wave edited, by the definition
`worker/tests/test_prose_shape.py` uses — a prose line is one a docstring or a comment occupies, a code line is
any other non-blank line, and blank lines count as neither. That is a THIRD convention beside the two above,
and it is the one the ratchet enforces, so it is the one to quote: against the directive's own 11 262 / 12 252
it charges the blank lines to nobody rather than to code, and against `prose_scan.py`'s 11 640 / 9 778 it
charges a trailing comment on a code line to prose alone.

Every figure below is read off the shipped tree against the `w7b-start` shadow snapshot with the test's own
`_counts`. The table first published here said 29 modules and 9 124 / 6 363, which was the round-1 snapshot:
it excluded `domain/audio/{activity,loudness,roles}.py`, the three modules round 1 swept to close the
nested-layer hole described two paragraphs down (review r2-spec-7).

| | prose | code | ratio |
| --- | --- | --- | --- |
| the 32 edited modules, before | 9 366 | 6 518 | 1.44 |
| the 32 edited modules, after | **5 566** | **6 524** | **0.85** |
| `worker/encore_worker` whole, before | 11 640 | 9 587 | 1.21 |
| `worker/encore_worker` whole, after | **7 840** | **9 593** | **0.82** |

**The code column is identical in 31 of the 32, and the 32nd moved by six lines of re-wrapping** —
`steps/align_steps.py` 1 851 → 1 857, where review r2-correctness-3 made three statements re-point six dead
`review §3.7` / `review H3` citations out of the operator's audit trail, which re-wrapped their string
literals. `_tools/ast_identity.py w7b-start` is the exact statement and a later wave can repeat it in seconds:
**31 of 32 modules AST-identical to the snapshot with every docstring dropped**, and the 32nd differing in
exactly those three statements and nothing else.

The five worst ratios went `domain/lyrics/lexical.py` 4.96 → 1.04, `artifacts/ports.py` 4.00 → 3.30 (a
Protocol file, which rule 2 does not reach), `domain/lyrics/ends.py` 3.68 → 1.22, `host/config.py` 2.67 →
0.58, `domain/lyrics/nonlyric.py` 2.49 → 1.18; the longest single prose block in the package went **439 lines
→ 40** (`lexical.py`'s module docstring was the 439, `host/config.py`'s `ALIGN_EXPERIMENTS` comment the next at
261). Per layer, after: `domain/` 0.92, `adapters/` 0.84, `steps/` 0.78, `workflows/` 0.58, `artifacts/` 1.05,
`protocol/` 0.49, `transport/` 0.73, `host/` 0.90.

**None of the three bounds has practical headroom, and the ratchet's own comments now say so** (review
r2-correctness-2, which found them claiming the opposite). `domain/lyrics/parts.py`'s module docstring is
EXACTLY 40 lines, so rule 1 passes only because the predicate is `>`; five modules sit between 1.05 and 1.10
against rule 2's 1.1, `domain/lyrics/language.py` closest at 184 / 168 = **1.0952**; and `artifacts/` is at
**1.0547** of the layer bound's 1.1. That is the intended state — a bound with slack is not a ratchet — but it
means the next wave to add a WHY paragraph in any of those places must move one out to `docs/` in exchange, not
raise the number. `test_prose_shape.TIGHTEST` pins which module sits on each bound so the claim cannot go
stale silently.

**Three ratchets keep it there** (`test_prose_shape.py`): no prose block over 40 lines, in any module; no
module with at least 100 lines of code over 1.1 prose lines per line of code; and no LAYER over 1.1 with the
package under 0.95. The ratio rule skips a module under 100 lines of code on purpose — there it measures the
module's interface rather than its prose, since a Protocol or a table of constants is one line of code per
declaration — and the layer rule is what stops the small modules bloating collectively.

**The review of this wave found three holes in those ratchets and the second root unswept, and all four are
closed.** (1) A prose BLOCK was a run of ADJACENT prose lines, and a blank line is neither prose nor code, so
one bare blank line every 40 lines split any essay into passing halves — measured in a scratch copy, a 120-line
comment essay broken that way reported a longest run of 30 against the bound of 40. A block is now bridged
across blank lines and ended only by code, which costs the package nothing: no module was relying on it.
(2) The layer list held top-level directories only and the listing test walked with `iterdir()`, so a NESTED
directory could never be required — `domain/audio` measured **1.18**, over the bound, while its parent
`domain/` averaged it away at 0.93. The list is now recursive and `domain/audio` is at **1.05** after
`activity.py` (1.56 → 1.25), `loudness.py` (2.00 → 1.60) and `roles.py` (1.35 → 0.78) gave up narratives
already written out above and in [`../stem-separation/README.md`](../stem-separation/README.md).
(3) The `DECLARATION_ONLY` ratio exemption and its own anti-staleness test were both INERT — its one entry,
`steps/api.py`, has 97 lines of code and the ratio rule skips anything under 100 either way, so emptying the
set left every test green. Both are deleted.
(4) **The PLAN's second cleanup root, `scripts/`, really had not been swept**: seven harness modules still
carried a module docstring of 54 to 120 prose lines. They are now "The harness scripts: what each one is for,
and the limit it states" below, and the root went **2 726 prose / 6 572 code (0.41) → 2 323 / 6 656 (0.35)**
with the longest block **120 → 36** lines. Its code column moved because the same sweep ran `ruff format` over
`bench.py`, `jamendo.py` and `truth.py`, which were unformatted at HEAD before this wave — carried out of W7 as
item (e) and closed here. Rule 1 now reads three roots — the package, that harness and
`worker/tests` (where `test_repair_order.py`'s 45-line docstring was the only block over the bound, now "The
repair-order property test, seed by seed" below) — and the harness carries an aggregate bound of its own,
0.4, because a gate script is a measurement argument with a `main()` attached and the per-module ratio is the
wrong instrument for it.

**Pointer ratchets, same review.** `test_docs_pointers.py`'s `path §N` rule required a literal single space, so
a citation that WRAPPED between the path and the `§` escaped it entirely; the separator now allows a line break
and a comment marker, which takes the checked count from **75 to 85**, and a floor on that count keeps a
pattern that stops matching from hiding behind "no failures". Two rules are new: every `§N` in package or
harness prose must have a committed anchor (a `docs/*.md` path or a `README`) within 200 characters before it,
which found **17** pointers into the gitignored review document — `review §3.4`, `§3.10's star`, `review §3.7's
consumer` — all now re-pointed or reworded; and a cited "`module`'s NAME section" must be text that module
still carries, which is the pointer form that broke here when the sweep deleted `lexical.py`'s MIX section
after two comments had just been written to cite it.

**The review of those pointer ratchets found three of them weaker than they read, and all three are closed.**
(1) The `§N` anchor rule scanned DOCSTRINGS AND COMMENTS only, so six `§` in runtime STRING literals — five
silence sentences of `align_notes._margin_why` and one decline note — shipped `review §3.7` on the audit trail
with the rule green; it now scans the whole module text, with a self-test on a synthetic `{"why": "... §3.7"}`
proving a code string is read (r2-correctness-3). (2) The `module`'s-NAME-section rule matched **zero**
citations, so it asserted over an empty loop with no non-vacuity floor, and its resolver returned the FIRST
file whose bare stem matched — `ports` is both `artifacts/ports.py` and `adapters/ports.py`. It now resolves a
dotted citation as a path SUFFIX, FAILS on an ambiguous bare stem, and carries an explicit "this form is
extinct" assertion plus a direct exercise of the pattern and the resolver (r2-correctness-4). (3) The **64**
`XA-NN` / `XW-NN` citations this wave made the primary code→doc pointer were unchecked: deleting a whole
`| **XA-07** |` row left every pointer dangling and the suite green, since the only rule over those documents
asked that the WORD "Invariant" appear. Two new rules now read the table's rows — every cited id must be one of
them, above a floor of 50 matched citations, and the ids must be contiguous from 01 so a renumbering fails
rather than silently re-pointing everything (r2-tests-11).

**And XA-15 was rewritten to the rule the guard enforces** (r2-tests-9). It read "no torch, scipy, numba or
adapter imports; no wall clock, no random, no filesystem. Numpy lives in `domain/audio/`", with §15 adding "the
step layer owns numpy and torch" — and four shipped, default-on domain modules contradicted it:
`domain/lyrics/margin.py` is numpy over the trellis, `lexical.py` imports `random` (seeded by `crc32`, by
design), `syllabify.py` reads its packaged `mhyph` table, and `domain/audio/wav.py` opens a wav by path. The
guard (`tests/test_layers.BANNED_IN_DOMAIN`) had only ever checked `dbos`, `asyncio` and the five model
libraries. The row now states that rule, says numpy and the stdlib are allowed, and the randomness and
filesystem clauses became named allowlists with anti-staleness tests — so the two real exceptions are enforced
rather than described, and the numpy-free seam (`claimmap`'s audio candidate, `ends`' envelope) is written as
the testability win it is instead of as a layer-wide ban.

**The published documents are byte-identical, measured rather than argued.** 3 songs × 3 claim modes
(`truth`, `blind`, `drop50`) at **both** `--level time_text` and `--level run_align`, against the per-case rows
`results/w7-{time_text,run_align}.cases.jsonl` recorded on the pre-cleanup tree:

| | cases | `doc_sha256` | `onsets_sha256` | every other compacted field |
| --- | --- | --- | --- | --- |
| `--level time_text` | 9 | **9/9 identical** | **9/9 identical** | identical |
| `--level run_align` | 9 | **9/9 identical** | **9/9 identical** | identical |

The worker tree's fingerprint moved (`fd9a5a6ddb641cd3` → **`5df9ae8c58fd37b6`**) and the emission store's
emitter key moved with it, since `module_closure` hashes whole files and a docstring edit therefore costs one
recompute — so the five `time_text` matrices were **recomputed from the audio** on this tree and still produce
the same documents to the byte (the `run_align` pass then read them from disk). `_runs/w7b2-verify-{tt,ra}`
hold the rows; compare with `e2e.py --compact`, since `*.cases.jsonl` is the ROUNDED per-case digest and a raw
`rows.jsonl` differs from it in float precision alone.

**These 18 cases were RE-TAKEN on the shipped tree, and the first 18 were not** (review r2-tests-10): the
original runs finished at 12:13 and 12:15 and `align_steps.py`, `generate.py`, `ml.py`, `claimmap.py` and
`reconcile.py` all kept moving afterwards, so the fingerprint they published (`f372f6c3f9e70a07`) no longer
named any tree that had ever existed. `_runs/w7b-verify-{tt,ra}` are kept as the round-1 reading. The lesson is
cheap to apply: **the hash run is corroboration over the paths three songs walk, and `_tools/ast_identity.py`
is the claim that covers the whole diff** — total, hermetic and repeatable in seconds, so it can be re-run
after the last edit rather than before it.

**One thing did change, and it is not in the documents.** Six sentences of the job's operator-visible AUDIT
TRAIL lost a dead `review §3.7` / `review H3` citation. The trail is job state, not the published document, so
the 18 doc and onset hashes above cannot see it. `tests/test_align_v2.py` and `tests/test_language_steps.py`
assert each of those clauses on the real `attempt` rig, and `189 of 380` — the one measurement the removed
`(review H3)` was the provenance for — is still in the decline note and still asserted.

### Word ends: the full corpus table, with its confidence intervals

`results/w4-time_text.json` against `results/w4-endsoff-time_text.json` (the post-pass off, recorded as
`ENCORE_ALIGN_EXPERIMENTS=ends-raw` on the **same** code `8c576cc6200b02a0`, so the pair is one population),
over the whole 20-song Jamendo corpus: **5 183 aligned words, 4 870 scored ends, 702 phrase-final ends,
2 433 s sung under `truth`**. This supersedes the 3-song slice (`_runs/w4-ends-{raw,held,tile}`), which read
the same direction at a smaller size.

| metric | truth, off | truth, on | blind, off | blind, on |
| --- | --- | --- | --- | --- |
| word end ±100 | 69.06 | **80.02** | 68.74 | **79.48** |
| word end ±250 | 93.06 | **94.97** | **92.79** | **94.64** |
| word end bias | −54.5 ms | −2.9 ms | −55.3 ms | −3.8 ms |
| phrase-final end ±100 | 37.46 | **59.83** | 36.30 | **56.75** |
| phrase-final end ±250 | **73.79** | **83.05** | 72.74 | **81.78** |
| phrase-final end bias | −114 ms | −5.6 ms | −121 ms | −15.5 ms |
| TV highlight | 65.83% | **77.10%** (CI **72.9–81.5**) | 65.92% | **77.51%** (CI **72.8–81.8**) |

Onsets are **equal to the digit** in both columns — ±100 / ±300 / AAE 83.25 / 94.98 / 87.8 ms under truth and
80.11 / 91.58 / 297.9 ms blind — with all 20 songs' `onsets_sha256` byte-identical, while `doc_sha256` changes
on 40 of 40 paired song-modes. That pair of facts is review §3.5's "any onset moves" as an exact statement
(`gates/w4-ends.yaml`, 6/6), which clears every reject-if with **+22.4 pts** of phrase-final ±100 and
**+11.3** of highlight under truth claims.

**What the review predicted, and the two signals it priced.** On the review's own clock, base model,
`theta` 0.1: phrase-final end ±100 40.0 → **57.3**, ±250 **73.5 → 82.5**, phrase-final bias −107 → **−10 ms**,
highlight 67.7 → **78.2**. A **SwiftF0 voicing** signal in place of the RMS envelope read 67.3 → **76.6** — no
better than the envelope already in hand, which is why no second model is loaded for this. Within-line gapless
tiling reached **78.8** (**82.7** with HuBERT-XL), and that is the `ends-tile` arm rather than the default,
for the trade priced three paragraphs down.

The pre-pass baseline these are measured against, on the 20 JamendoLyrics songs that carry hand-measured word
**offsets** as well as onsets: phrase-final word ends land a median **107 ms early**, only **40.0%** within
±100 ms and **73.5%** within ±250 ms, and the correct word is lit **67.7%** of sung time. Those are the
review's clock; on W4's exact 20 ms grid they read **worse, and honestly so**, because the old grid's
`duration / frames` came out **0.020014 s** — a **0.07%** stretch that pushed every end later and masked CTC's
peakiness. Re-read on the exact clock (`--level generate --modes blind --songs jamendo`): word end ±100
73.2 → **68.7**, phrase-final ±100 40.6 → **36.3**, phrase-final bias −106 → **−121 ms**, highlight
67.3% → **66.0%**. Every reject-if for this feature is read against that column.

Per song: **every** song's highlight rises, worst **+6.6** (`Tom_Orlando`), best **+15.8** (`Cortez`); 2 of 20
are worse at word-end ±100 against the 3 the reject-if allows — `Avercage` −6.19 and `Color_Out` −1.28 — and
both gain on the independently measured half (phrase-final ±100 **+12.5** and **+16.1**). That is the shape
§3.5's own objection predicts: interior and phrase-final ends can move in opposite directions on one song, and
only the second is really measured.

The two W4-review fixes (a grid tolerance so the walk starts on the frame the end actually sits in, and a
skip over a trailing out-of-vocabulary placeholder so it does not cap the word before it) moved this table by
**0.2 ms**: truth end bias −3.0 → −2.9 ms, phrase-final bias −5.8 → −5.6, and end ±100 / ±250 /
phrase-final ±100 / ±250 / highlight equal to the digit at 80.02 / 94.97 / 59.83 / 83.05 / 77.10
(`_runs/w4r1b-time_text`). Both defects are real and rare, not a recalibration. **497** of the corpus's words
are trailing placeholders of the kind the second fix skips.

The tile arm's trade, on the 3-song slice it was measured on (`_runs/w4-ends-tile`): **+1.5** pts of highlight
(79.1 → 80.6) for **−4.0** on word-end ±100 (79.0 → 75.0) and −1.6 at ±250, phrase-final ends untouched —
which is evidence against "80% of interior truth ends are just the next word's start" being the whole story,
since where that held, tiling could only have helped.

**What the truth set cannot say.** That 80% is **4 825** of Jamendo's non-final word ends recorded as exactly
the next word's start, so a gain on interior ends is partly the truth set's construction. Only phrase-final
ends are independently measured, and the TV highlight — which reads the whole document through the TV's own
rule — is the metric that cannot be gamed that way.

### Why the end walk is a vocals-stem rule: the envelope reads nothing on a mix

The active level is a fraction of the target's own 95th-percentile level. Measured with this repo's own
`activity.envelope` over four corpus songs, frames at or above 0.1 are **95.5 / 98.4 / 95.5 / 92.4%** of the
**mix** against **64.8 / 58.9 / 76.7 / 72.2%** of the same songs' **stems**, and the longest *continuous*
active run is **152.8 / 183.8 / 70.1 / 37.6 s** against **12.0 / 13.5 / 19.3 / 10.1 s**. A walk with a stem's
threshold over a mix's envelope therefore never stops: the post-pass would silently become the `ends-tile`
arm inside each line **and** run every line's last word to the next line's onset (or +3 s at the document
end) on every stemless song and every `ALIGN_ON_MIX` retry — unmeasured, since all 20 corpus songs the table
above is read on have stems. A mix-calibrated threshold is fittable (`e2e.py --no-stem`, twice) and
deliberately not fitted; the reject-if such a fit owes is written in `gates/w4-stemless.yaml`'s header before
anyone fits one.

Two float facts, recorded because each produced a real defect. Since the exact 20 ms clock every decoded end
is an integer multiple of the hop, which is the worst case for a binary division: for **9 721** of the first
**200 001** multiples, `int((k * 0.02) / 0.02)` is `k − 1`, so the walk used to start one frame early and a
word whose own end frame is active but whose preceding frame is not was left unextended. And a walk that
consumed no frame returns the end **itself** rather than its frame's boundary, because `int(end / hop) * hop`
differs from `end` in the last bits (70 × 0.02 is **1.4000000000000001**), so snapping to the grid would move
every end in the document by a femtosecond and make "nothing was extended" impossible to state. The grid
tolerance is larger than that error at any song length — a 5-hour grid's worst case is ~**1e-10** frames —
and nine orders of magnitude under one frame.

### The lexical calibration rows, exhibit by exhibit

The recipe, the held-out splits and the shipped thresholds are above ("The lexical-lift wrong-text gate",
"Per-model calibration"). These are the fit's own exhibits, which lived at the constants.

**What re-reading the fit costs**, so a later wave can budget it: `scripts/lift_gate.py` over the YouTube + tfr
stems on the base bundle took **367 s** when the rows were first fitted and **359 s** on the shipped decoder
reading all 64 matrices from disk — it reproduces every number of the first run — while the MIX run, envelope
fits included, took **508 s**.

**Base bundle, stem.** Right texts: Jamendo min **+0.350** (`Avercage` headers; drop50 **+0.264**),
YouTube + tfr min **+0.348** (`never-be-alone` extraverse; drop50 **+0.368**); truth **+0.45 … +4.33**, median
**+2.27**. Wrong texts: Jamendo max **+0.192** (`Lower_Loveday` × `tfr-mayday`), with
`Cortez` × `The.madpix.project` **+0.187** behind it; YouTube + tfr max **+0.124**. `refuse_below` 0.2 is the
pooled gap's midpoint **+0.228** rounded down onto the 0.05 grid, so the lowest right text keeps **+0.064**
and the highest wrong text sits **0.0082** below the floor.

**Base bundle, mix.** The populations overlap: right texts **−0.045 … +2.85** (truth median **+0.66**; 24 of
192 below 0), wrong max **+0.102** (Jamendo) / **+0.115** (YouTube + tfr). `mix_floor` 0.15 is the smallest
0.05 step above both, with **0.035** of head-room over the higher.

**HuBERT-Large, stem.** Right texts (protected + drop50) min **+0.766**; truth **+1.132 … +5.649**, median
**+3.832**. Wrong max **+0.219** (`tfr-chosen` `wrongtext+ownclock` #1; `wrongtext` max **+0.199**) — a gap of
**+0.547** where the base model's is **+0.072**, so `refuse_below` 0.45 (midpoint **+0.4927** rounded down)
clears the wrong population by **+0.2306**, i.e. by 3–8 redraw SDs instead of by one. Held out, the YouTube
split fits **+1.152**, and rounding that up would put five protected right texts of one song in the doubt
band (`Avercage`: truth +1.132, headers +1.028, credit **+1.045**, extraverse +0.828, drop20 **+1.084**) for a
song the base row grades OK, while buying nothing.

**HuBERT-Large, mix.** Right min **−0.033**, wrong max **+0.116**; floor 0.15 with **+0.0343** of head-room
(the base row's +0.0349 to four places). `mix_ok_from` 0.4 is where the truth texts' blind decodes stop being
poor: sorted by lift, the poor decodes end at `never-be-alone` **+0.2507** (13% of its lines within 1 s, 41 of
47 more than 2 s out) and the next text up is `The_Rinn` **+0.4231** at 76% within 1 s, 7 of 46 gross — so the
split lies in (0.2507, 0.4231] and **0.40 is the largest 0.05 step in it**.

**HuBERT-XLarge** (nobody's default, reachable only by name). `refuse_below` 0.35 from right min **+0.4719**,
wrong max **+0.2778**, midpoint **+0.3749** rounded down; `ok_from` 0.5, the step above the weakest drop50
+0.4719 and under the weakest protected **+0.7339**; `mix_floor` 0.15 against wrong maxima **+0.1070** /
**+0.1479**; `mix_ok_from` 0.3, where the poor blind decodes end (`never-be-alone` **+0.2640** at 11% within
1 s, `The_Rinn` **+0.2237** at 52%, against `Moon_I_Mean` **+0.3061** at 84%) — with one poor decode that step
admits, `Pure_Mids_-_The_Leader` +0.3109 at **30%** within 1 s and 13 of 20 lines more than 2 s out, which
0.35 would catch at the cost of `Slingshot_Miracle` +0.3033 at 61%. Its stem head-room is **+0.0722**, its mix
head-room **+0.0021**, with three wrong texts at or above +0.1275.

**Redraw noise.** `_runs/w3-rejudge/seed_probe.py`: the 16 near-floor stem texts × 60 random shuffles,
best-of-3 resampled. One redraw moves a text by an SD of **0.03–0.07** nats/letter — the scale of the 0.0082
the base floor clears the wrong population by, against a pooled right/wrong gap of 0.072. Per redraw ~**0.6**
of the 640 wrong texts would pass (`LUNABLIND` #2 at 44%, `Cortez` #1 at 7%, `Cortez` ownclock #4 at 9%, every
other ≤2%), i.e. ~0.1% — inside §3.4's 1%, but not the 0 this one draw reads; a drop50 right text would be
refused with probability 31% (`Color_Out`), 15% (`numb`), 5% (`Avercage`), and a **protected** right text
never (p05 ≥ +0.268).

**Normalisation moves lifts by the same order a model does.** Diffing the wave's own rows case by case —
`results/w4-time_text.cases.jsonl` (a provider's raw claims) against `results/w4-run_align.cases.jsonl` (the
same texts through `clean_segments`), 1 088 keys on both sides — **302 cases move, by a median 0.022, a p90 of
0.072 and a maximum of 0.147** (`Kinematic` `wrongtext+ownclock` #1, **−0.040** raw against **+0.108**
cleaned). One case crosses the floor: `LUNABLIND` #2 `wrongtext`, +0.232 raw and +0.172 cleaned, which is
exactly the 1/320 the `time_text` level publishes and `run_align` does not. W3's rows read the same shape on
the old clock (302 cases, median 0.026, max 0.153), which is the point: the clock moves every lift and moves
this diff not at all.

When `lift_gate.py` rounds a fitted value onto the 0.05 grid it allows slack, because these are binary
floats: `0.60 / 0.05` is **11.999999999999998**.

### The claim clock's own exhibits

**What the map is worth, in one line.** Gross lines over the claim modes fall **440 → 25** on the base bundle
and **370 → 6** on HuBERT-L, with no `high`-graded gross line left in any claim mode. It costs truth mode
89.3 → **88.5** within ±500 ms, carried by two songs, on both of which the map sides with a measurement against
the metric's own ruler — and on the 12 YouTube songs that ruler **is** the caption track the map is correcting,
so part of that 0.8 pt is the metric's.

**The quality floor is inert where it matters, and only there.** At the LINE_SYNC rung, whose band is wider so
its shares run higher, the lowest applied **right-text** share over the 1 056 gate cases is **0.243** — above
the 0.2 floor — and re-measuring those cases with the floor on leaves all **188** applied right-text maps in
place and changes no right-text row, while refusing **293 of the 402** maps it had applied to **wrong** texts.
A floor that only bites on wrong texts is the right shape for this gate.

**The bimodal song the mode candidate exists for.** `never-be-alone` off3, 44 paired lines, tolerance 0.25 s:
the differences are bimodal — 20 spread over −8.87 … −4.31 s where the global decode smeared the repeated
"be alone" lines, a tight cluster of 17 in −3.23 … −2.83 s which **is** the sheet's +3 s displacement, and
three outliers at +8.23 / +10.69 / +20.07. The median lands at −3.73 s, the gap between the two modes, and
explains 4 of 44 (9%, under the quality floor), so the vote abstained and every window repair after it worked
in a clock 3 s out: **44 gross lines where W4-start's tree had 0**. Nothing about the grid caused it — on
W4-start's clock the same median read −3.17 s (14 of 45, 31%) and was applied; a median sitting on the
boundary between a 20-line tail and a 17-line cluster moves by a whole cluster width when one line crosses it.
**Which CANDIDATE won flipped with it**, and that is the fact the exhibit turns on: on W4-start's clock the vote
was carried by `decode-median` at **−3.18 s (14/45)**, and on the exact grid by `envelope-lag` at
**−3.76 s (4/44)** — under the quality floor, so the winner was refused and nothing mapped. An offset read
0.58 s further back than the sheet's own +3 s displacement is also why this exhibit is the one the
margin's backwards-displacement guard is read against. The densest window reads −3.07 s and explains 17 of 44
(39%). At the fitted tempo scale **1.0268** the median
offset explains **0** of 44 paired lines and the densest window **12**, which is why the tempo-mode candidate
exists at all.

**The two hermetic exhibits behind the mode candidate's own floors** (`tests/test_align_provenance.py`): a
6-line sheet whose truncated last cue the decode smears over an outro repeat, and an 8-line sheet whose claims
are rotated onto each other's lines. Both hand the window exactly **2** of their differences — 0.33 and 0.25
of the pairs, clear of the share floor, and 2 ahead of no-shift's 0 — so both were applied, moving 6 correct
cues by **+2.77 s** and 8 claims by **−13.28 s**. The floor is inert on the corpus: over the 1 088 cases of
`_runs/w4r1b-time_text` the 15 applied `decode-mode` maps hold 10 to 41 lines and the 3 applied `tempo-mode`
maps 7 to 12, and the only two cases the floor can reach at all named a 3-line and a 4-line window as their
**refused** best candidate (`never-be-alone` drop50, `LUNABLIND` wrongtext #2), whose documents re-run
byte-identically (`doc_sha256` df872d26cfab8101 and e83ba54619003171).

**The isolation guard's exhibit** (`tests/test_claimmap.py`): a correctly timed 47-line sheet against a decode
uniformly 0.4–3.0 s late. The densest 0.5 s window holds 16 of 47 differences — 0.34, clear of the floor — and
would have moved 47 right claims by **+2.62 s**. Widening by one tolerance on each side gathers **9** more
lines, so it is refused; the bimodal shapes the candidate exists for gather **none** (`never-be-alone` off3
17 → 17, its tempo098 at the fitted scale 13 → 13) and a merely jittered sheet gathers **4** and is refused,
which is right — its differences are one hump, so the median is already its estimator.

**Reconcile's scale bound, measured on seeded series:** of 2 000 seeded +1.5 s series, **420** came back with
`|scale − 1|` at most **0.0018**, which moves the extra line by less than a frame — which is why the bounded
fit is adopted only where it explains strictly more lines than scale 1. And the COARSE repair band that was
replaced: re-decoding jitter inside a jittered claim window measured **worse** on `Numb`, MAD **312 → 563 ms**.

### The repair window's two caps, priced

Both caps are refusals to widen a window that is already doing its job, and both were measured on a rig whose
line is sung once early while a superstring of its text is sung later (§4 of
[`04-alignment.md`](../../arch/04-alignment.md)).

**The next-claim cap.** A fixture whose line is sung at 12–15 s while a superstring is sung at 32–36 s, with
the blind decode smearing the line 12 → 34 s: the uncapped window published it **11.96–34.88 s** (its end
19.88 s late) and left 3 of 8 lines gross; capped, **11.96–14.96 s** and 0 gross. Review M5's own case is
unchanged by the cap (a 7 s smear with only a near-duplicate neighbour: 11.96–14.96 s either way). A two-sided
union — pulling the start back to a blind onset as well — moved R1's window **5.4 s** left and cost 2 lines
their repair.

**The last-cue cap**, on the sheet's own pacing. The final cue is the one cue whose end is always missing, so
the hold-open fires on it on every LRC there is, and what it swallows is not a following line but an unstamped
outro repeat of its own words. Measured on the pinned rig: a final line sung 50–53 s with its cue truncated at
50.6 s and the blind decode smearing it to 77.7 s bought a window of (49.6, 78.7) — **29 s** against the 4 s
every capped cue gets — and the forced re-decode inside it landed on an unstamped repeat at 70–73 s,
publishing the line **20 s** late.

**The price of the ceiling, measured**, because a ceiling on the last cue can only be a trade. A cue truncated
at 50.6 s whose note the audio genuinely holds to 65 s, re-decoded in each candidate window (one `regenerate`
call apiece on the same matrix):

| window | published span | short by |
| --- | --- | --- |
| uncapped | **49.96–64.82 s** | 0.18 s |
| the slot ceiling (shipped) | **49.96–61.60 s** | **3.40 s** |
| a `needs`-only ceiling | **49.96–52.64 s** | 12.36 s |

All three put the line's **start** on the note; what a ceiling costs is the end, and `needs` alone costs
nearly all of it. Against that 3.40 s the shipped cap buys back the 20 s displacement above, and a late start
is what core highlights, so the trade is taken in this direction. A characters-per-second ceiling has no safe
value: over the corpus's **1 645** truth lines, real sung lines run down to **0.7–1.7** alignable characters a
second.

**The adoption guard's exhibit**, on the mix-witness arm: a line the mix heard at **27.00 s** was published at
the jittered claim's **27.40 s** — which is why R1/R2 may re-decode such a line by default and the
`l1-mix-kept` arm's refusal to is an arm.

### The never-sung rule: the two lines no floor can separate

`scripts/unsung_gate.py`, rows in `results/w4b-unsung-gate.json`; 32 songs × 6 text modes = 192 song-modes,
blind, base model, `--target stem`. The sweep's verdict and the relative-floor variants are above ("The
never-sung floor"); these are its exhibits.

The level **between** decoded lines on these stems is at or above the absolute floor of 0.10 on 29 of 32 songs
— per-song medians **0.019–0.578**, **median of medians 0.248**, the q25 ≥ 0.10 on 17 of 32 and the q10 on 5
of 32 — which is bleed, reverb tails and instrument leakage. So a floor read at the song's own median exceeds
0.10 nearly everywhere and, capped at 0.10, is a no-op.

The two populations overlap: the 28 **real** candidate lines read 0.0014–0.0965 and the 19 **injected** ones
0.0007–0.0758, so a threshold on the level cannot sort them at all. `(energetic rock music)` —
`bohemian-rhapsody`'s caption cue, in the truth file and not sung — reads **0.0957**, above the real sung line
the wave wanted to keep.

And the two lines the wave wanted separated cannot be, at any floor:

| line | envelope | score gap | chars/s | what it is |
| --- | --- | --- | --- | --- |
| `Pure_Mids_-_The_Leader` [0] | 0.0890 | **−2.27** | 0.92 | a real sung line, the single systematic W4 regressor |
| `tfr-chosen` [34] | 0.0892 | **−2.15** | 1.22 | the spoken uploader credit, whose drop is worth +2 ±500 lines and −3 gross on its own song |

The same numbers to three decimals, and their songs' gap quantiles order the wrong way for a relative floor to
help (`Pure_Mids` q10 0.075, `tfr-chosen` 0.024), so every floor that spares the one spares the other. What
they actually share is not silence but **smear**: the decode spread them over 37 s and 47.6 s and placed them
32.5 s and 54.3 s from the truth, so all three signals are reading one fact — a line the decode could not
place — rather than three independent witnesses, and the envelope mean over a span the decode chose says more
about the decode than about the audio.

#### What brings a SPARED line back: the speech-mass readings behind `_SPOKEN_RATIO` and `_SPOKEN_FLOOR`

A spared never-sung line (`m6-mix-spare`, `m6-window-spare`, both default-off) comes back only where its
witness's **acoustic** model hears speech over its claim window at `_SPOKEN_RATIO` of what it hears over the
blind decode's own lines — `_speech_mass`, the CTC emissions' non-blank probability — and only where its decode
is not stuck at the window's edge.

**Why a mix witness exists at all**, which is the arm's premise and a different quantity from the speech mass
below. The default runs the never-sung rule on the target's evidence alone and so deletes lines a mix witness
would have recovered: `never-be-alone`'s two closing lines under truth claims read a **stem / mix envelope over
their claim windows of 0.008 / 0.79 and 0.003 / 0.78** — against `_NEVER_SUNG_ENV` = **0.10**, so the stem
witness is blind there by an order of magnitude while the mix hears the voice plainly. That is the separator
having left those vocals in the instrumental, and it is the whole case for asking a second witness. What the
pair does NOT establish is that the line should come back: the mix envelope cannot tell a voice from the band,
which is the next paragraph, and the speech-mass table below is what actually decides it.

Neither of the two cheaper witnesses can do it. The mix's **envelope**, which is what spares a line, cannot
tell a voice from the band: every one of the **33** unsung lines it spared in W1 — credits over an intro,
section headers — came back. Nor can the decode's **score**: a spared line is by definition one that decodes
poorly, and the sung ones scored **0.6–2.0** below their song's median on the mix, as far below as the headers
(**−3.4 … +1.2**) and the credits (**−2.7 … 0**).

Measured over every spared line of W1's `time_text` bench (16 songs × 15 modes, **88** spared on the mix),
speech mass on the mix relative to the blind lines':

| spared line | relative speech mass |
| --- | --- |
| `never-be-alone`'s lost closing lines, under truth / jit / offm1 / drop20 / extraverse / headers / credit | **0.72–1.25** (0.02–0.50 only where offset or tempo claims put the window off the singing) |
| `tfr-mayday`'s sung `(I'm running out of air)` | **0.97** |
| section headers | **0.00–0.31**, but `LUNABLIND`'s `[Verse 3]` **0.70** and `Lower_Loveday`'s `[Verse 1]` **2.13** |
| credits | 0.10–0.38 |
| other songs' lines | 0.02–0.29 (`Ridgway`'s extra verse 0.59 and 0.82) |

**0.6** keeps the first group and bins all but **3** of the unsung ones; two of those three published on the
full corpus (`LUNABLIND`'s `[Verse 3]`, `Ridgway`'s extra verse), which is why `m6-mix-spare` ships off.

`Lower_Loveday`'s **2.13** is the reason for the second constant: its mix matrix barely hears the voice at all,
reading **0.03** over its own lines, so the ratio is a fraction of nothing. A witness whose median speech mass
over the blind decode's lines is under `_SPOKEN_FLOOR` cannot vouch for a line. On the same spared set the
mixes of `Avercage`, `The_Rinn`, `Lower_Loveday` and `Pure_Mids` read **0.02–0.05** there — and every line they
spared is a credit, a header or another song's verse — while every song a **sung** line was spared on reads
**0.08 or more** (`never-be-alone` 0.10–0.13, `tfr-mayday` 0.12).

### The non-lyric floor, as arithmetic

**First, what a section header costs when it becomes a CTC target.** Measured on `Numb`, whose authored
captions label **17 of 35** lines: 17 fake words, onsets pulled up to **~2.5 s** early, bias-corrected ±250 ms
**34.3% against 65.7%** once the labels are cleaned, and the reconcile verdict moves `COARSE → STRUCTURAL`.
Prevalence is low — labels appear in **1 of the 12** authored caption tracks — which is why R1 is an allowlist
rather than anything elaborate.

R3's floor is the share of a track's **worded** lines that must carry a music note before an unnoted line
reads as not sung. Measured on the 32-song corpus: 24 songs at **0.000** and 8 at **0.8514–1.0000**
(`hello` 63/74, `feel-my-heart` 32/37, `bohemian-rhapsody` 65/74, `bad-guy` 75/79, `shape-of-you` 89/92,
`tfr-chosen` 36/37, `rap-god` 216/217, `believer` 73/73).

It sits at **0.8**, the bottom of the measured population, and not at 0.5, the middle of the empty band,
because the cost either side is not symmetric. Two real authoring shapes were reproduced inside 0.5–0.85 and
the rule deleted real sung lines out of both: an author who wraps only the hook lines and writes the verses
plain (11 noted of 20 worded = **0.550**, and all 9 verse lines left the text), and the SDH convention of one
note opening a sung passage and one closing it with the middles bare (8 of 12 = **0.667**, and the 4 middle
lines left). At 0.8 both are refused — they would drop **0.450** and **0.333** of their worded lines — every
one of the 8 noted corpus tracks still fires, and `hello` sets the floor at 63/74 = 0.8514, so the head-room
is **0.0514**.

A separate "refuse if R3 would drop too much" cap would be this same knob: R3 drops exactly the worded lines
that carry no note, so its drop share is `1 − the noted share` by construction, and a floor of 0.8 **is** a
cap of 0.200. The corpus's worst case is `hello` at 11/74 = **0.1486**, so the implied cap clears the measured
maximum by 0.0514.

Reading the share off **worded** lines rather than every non-empty raw line does not move the corpus: dropping
a wordless noted line takes it out of the numerator and denominator together, so the 8 noted tracks stay at
**0.851–1.000** (the four wordless noted lines in the whole corpus are `tfr-chosen`'s two, `believer`'s one
and `shape-of-you`'s one: 36/37 → 34/35, 73/73 → 72/72, 89/92 → 88/91) and the 24 unnoted ones stay at 0.000.
`clean_segments` takes the corpus's 32 truth texts **1 760 → 1 712** exactly as before.

Excluding the lines R1/R4 already answered is what keeps the floor readable on a labelled sheet. Measured on
the bench's own `headers` mode, which injects one Genius-style label per section: `hello`'s share falls
0.8514 → **0.7500**, `bohemian-rhapsody`'s 0.8784 → **0.7927**, `feel-my-heart`'s 0.8649 → **0.7111** and
`rap-god`'s 0.9954 → **0.9153** — three of the four would stop firing at a floor set to the measured
population, on a text whose sung lines are marked exactly as before. Excluding them returns every share to its
unlabelled value to the digit and changes nothing on the 32 truth texts (the one anchored-and-unnoted line in
the corpus is `bad-guy`'s `(LAUGHTER)`, R4's: 65/69 → 65/68).

### Caption cues: the two populations a duration floor separates

On the review's own rolling-caption video, cue durations fall into two populations — **10 ms** and
**1.15–18.47 s** — so the floor that drops the roll-up's "the line is now complete" markers has an order of
magnitude of clear air on both sides, and a 10 ms claim is also a claim no clock can use.

**What the old parser did to that track**, re-fetched (`dQw4w9WgXcQ`, **103** raw cues, **51** of them 10 ms
long): it published **86 cues and 769 words for 284 sung words**, threw away **239** inline word onsets, and
lost the **first cue entirely**, because YouTube writes the roll-up's empty half as a lone SPACE on its own
line and a block-splitter that cuts on `line.strip() == ""` halved every such cue. The rewritten parser is
timestamp-driven: the same track comes back as **41** word-timed cues with its first cue present —
`We're no strangers to` at **18.80 s**.

The bench's `headers` claim builder had the mirror-image defect: 12 of 233 injected headers on 8 songs were
**inverted** (start after end) before it was fixed — `The_Rinn`'s `Chorus:` read 226.51 → 218.88 s and
`Rxbyn`'s `[Verse 6]` **169.13 → 168.79 s**.

### The LINE_SYNC rung: what the clock bought, per mode

`scripts/line_gate.py`, base model, 1 056 cases, rows in `results/w2-line-gate.json`. The rule table and the
share sweep are above ("The LINE_SYNC rung's gate", "The rung's own claim clock"); these are the per-mode
columns that lived at the constant.

Right texts refused 88 → **33** of 416 — a strict subset, 0 newly refused and 55 recovered, 53 of the 55
publishing a document at least 80% within ±500 ms — shown lines within ±500 ms **88.9% → 94.8%**,
text-denominator ±500 69.0% → 89.5%, gross lines 47 → 0, documents with no line within ±500 ms 23 → 13.

| mode | refused, W3 → W2 | text ±500 |
| --- | --- | --- |
| tempo098 | 27 → 3 | 4.4% → 87.1% |
| tempo102 | 26 → 3 | 4.7% → 87.1% |
| off15, off3 | 4 → 1 | 70.4% → 91.4% |
| offm1 | 3 → 1 | 79.3% → **93.9%** |
| drop20 | 0 → 0 | 89.2% → 95.9% |
| truth | 1 → 1 | 91.4% → 93.4% |

**188** of the 416 sheets are mapped (envelope-lag 110, tempo 65, decode-median 13); the other 228 keep their
own timings. The 12 right texts the unconditional activity shift used to refuse had a median lag of
**−1.62 to −3.12 s**, with **0.54–0.94** of their lines within 1 s once it is removed
(`results/w3-line-gate.json`'s `near_fit`) — i.e. the decode itself knew the answer.

The uniform-lag blind spot, counted on the gate's own population: **23 of the 328** right-text documents agree
with themselves while every line is 0.5–1.0 s late. Those 23 are also why the rejected **lag term** on the
rung's agreement is priced from these same rows rather than argued about: the harness shifted their sheets by
the activity fit (`bad-guy` **+0.72 s**, `numb` **+0.62 s**) and the decode then reads the claims as near
(offset **+0.14**, **−0.23 s**), so both witnesses agree on one misplacement and the ±1 s quality split counts
all 23 as GOOD.

| a lag-magnitude term at | right texts refused, of 320 | text ±500 | good documents refused, of 346 | middling published |
| --- | --- | --- | --- | --- |
| none (shipped) | 32 | **82.8%** | 28 | 10 |
| 0.5 s | 39 | 80.6% | 37 | 6 |
| 0.3 s | **50** | **78.3%** | 48 | — |

Bad documents: **0** either way, at either threshold — the term refuses accurate documents and nothing else.
What it buys is the tempo modes' gross lines (13-mode set: **47 → 9** at 0.5 s, **0** at 0.3 s), which W2's
bounded scale already buys without refusing anybody, and under `syncMode=lines` a refusal is terminal — "no
lyrics at all" against "a scroll under a second late". `gates/w3-lines.yaml` holds the zero-±500 count so the
claim clock is measured on it.

### `claims_related`, and what the cross-kind swap really costs

Measured at `run_align` over the W2 corpus rows (`_runs/w2r2-run_align` against `w2r2-lines-run_align`, the
same 32 songs' own line documents). Of the **357** published word documents that have a line document of the
same text beside them, the **18** whose last reconcile verdict is `UNRELATED` hold **all 299** of their gross
lines — 84% of the population's 356, in 5.0% of the cases — and 523 of 990 line starts within ±500 ms, where
their line documents hold 0 gross and 987 of 991, against 5 677 word timings given up.

The other 339, which reconcile **did** relate, keep their words: 15 296 of 16 951 line starts within ±500 ms
(90.2%) with 57 gross lines — and taking the line document there would spend **107 743** word timings to move
**784** line starts. The rung fires on 36 of the sweep's 420 published word documents and half of those go
back to the words, the line gate having refused the sheet; the 18 that change kind are `hello` in 8 modes,
`tfr-chosen` in 3, `tfr-mayday` in 2 and five songs' drop50 half-sheets. Over those 18 the line documents score
**991** lines against the word documents' 990, which is why the "at least as many lines" guard is inert on the
measured population.

Reading the **last** reconcile rather than the blind one is what isolates them: of the 54 song-modes whose
blind verdict is `UNRELATED`, 18 read AGREE, COARSE or STRUCTURAL after the repairs, and those 18 word
documents hold 6 gross lines between them where the 36 still `UNRELATED` hold 556.

### The order-clamp arm's own table

`m2-order-clamp` ships off (above, "What failed, and the arm it forced"); this is what it bought before W3's
gate closed its wrong-text half, at `run_align`. It publishes all 47 texts the baseline lost (off15 8, off3
20, headers 9, tempo102 5, jit 2, off05 / drop50 / credit 1 each; without it the gated rung recovered 16 as
line sync), and moves the text-denominator ±500 from 41.7 / 17.6 / 51.4 / 66.3 / 49.8 (off15 / off3 / headers
/ jit / tempo102) to 69.9 / 70.1 / **84.9** / 82.3 / 64.9, against 48.5 / 36.9 / 68.3 / 68.3 / 49.6 without
it; at `time_text`, off3 gross 456 → 297, tempo098 260 → 186, tempo102 376 → 299.

Where the arm's `run_align` cases actually go, over the **123** of them: **37** that the default line-syncs it
publishes as word documents instead, and that is the loss — gross **0 → 152**, lines within ±500 ms
**2 528 → 2 154**, `high` lines more than 0.5 s off **0 → 87**; **12** that the default refuses it publishes,
for 125 gross and **704 of 1 103** lines within ±500 ms (`rap-god` off15 / off3 at 2–3 gross and 172–176 within
are the real gains; `hello` and `bohemian` off3 at 26–28 gross, and `HILA` and `never-be-alone` drop50 at 18–19
gross for 2–6 within, are not); and **74** where both publish as words, where it helps — gross **485 → 409**,
±500 **+38** lines. At `time_text`, which has no rung, the same 125 aggregate in its favour — gross
**946 → 705**, ±500 **6 464 → 6 575** lines — while regressing exactly the songs the reject-if names. That
split is the whole argument for the gated rung over the arm: the rung recovers most of what the arm got back,
and recovers it as line sync rather than as 152 gross word timings.

**Clamping rather than refusing, priced.** Over the 40 cases where the clamp acts (W1, `--level time_text`,
8 songs × off15 / headers / jit / off3 / tempo102, base model) the shipped whole-run refusal reads **165 gross
/ 1 887** within ±500 ms, against the clamp it replaced at **195 / 1 871**. Four variants are then all inside
noise of the shipped rule: refusing the fewest lines of a run by dynamic programming **164 / 1 887** (it
recovers the `headers` shape — an adopted `[Chorus]` label sharing a run with a lyric line, `Rxbyn` 3 gross
→ 0 — and loses about as much on `HILA` and `Ridgway` off3, +1 gross each); letting a repair overlap a smeared
trusted tail while its starts stay in order **163 / 1 888** (`Tom_Orlando` jit 2 → 0); both together
**162 / 1 888**; and dropping the 0.2 s minimum-width widening **163 / 1 892**, which changes 3 documents where
nothing was refused. So the simplest rule stands. A neighbouring variant on the same cases read 895 / **7 184**
against 7 186 — no gain worth a second path through the fragile part.

### The L1 arms, priced on the song the review read them from

Both `l1-*` arms ship off, and each failed on the SAME song: **`never-be-alone`, stem coverage 0.99**. That
number is why the failure counts — W1's reject-if is scoped to a song whose stem coverage is at least 0.80
(`count(song.doc_changed * (base.song.coverage >= 0.8)) == 0`), so a regression there is inside the gate rather
than on material the harness does not vouch for. Measured at `--level time_text` on `never-be-alone`,
`tfr-chosen`, `Quentin` and `Ridgway` under truth / jit / off05 / off15 / offm1 — 20 cases, on the tree as W1
then shipped it — as gross lines / lines within ±500 ms:

| arm | gross | within ±500 ms |
| --- | --- | --- |
| both off (shipped) | **25** | **569** |
| `l1-blind-median` | 33 | 549 |
| `l1-mix-kept` | **49** | **538** |
| both | 36 | 541 |

All but 2 lines of that difference are `never-be-alone`'s: 3–29 fewer lines within ±500 ms under truth / jit /
off05, 3–11 more gross under off15, and one gain — offm1, +7–9 lines. **Why they lose** is the song: its blind
decode is `UNRELATED` (13–31% of lines agree), so R1 re-decodes every claimed line inside its claim window and
those stem decodes are poor (0.5–1.5 s off truth). The per-stage adoption median counted R1's adopted lines at
their 0.0 sentinel and so rose from **−2.98 to −0.88**, after which R2 adopted the claim over 13–23 of them —
by accident, but a decent claim beats a poor decode. With that fixed the decodes stand, and where no stage
replaces them in order the clamp refuses the whole song-long run (`never-be-alone` off05 with `l1-mix-kept`:
all 47 lines back on the blind decode, 21 gross). Re-judged under W3 on the same 4 songs × 14 modes, both arms
still fail §3.1 by effect in 6–8 modes and `never-be-alone` off05 goes **45 → 26** lines within ±500 ms with
`l1-mix-kept` (45 → 27 with `l1-blind-median`).

And the never-sung sparing arms, on the 16 songs they touch × all modes: `m6-mix-spare` reads **916 → 895**
gross at `time_text`, where W1 as first shipped (spared lines adopted at their claims' spans, steering the
ladder) read **918** — with off3 +7, tempo098 +9 and tempo102 +4 gross. Over the 12 documents it moves: gross
**32 → 11**, within ±500 ms **361 → 380**, unsung 21 → 23, lines missing 19 → 4. Letting a spared line **steer**
the re-reconciles was measured on the **384** heard-only cases and reads 895 gross / **7 186** within ±500 ms
against 895 / **7 184** — which is the "no gain worth a second path" reading above, from the other side.

### Language: the detector's cost, and three censuses

**What the detector costs a job**, measured on this box rather than assumed from the wheel's 170 MB: building
it is 0.05 s (the models load lazily), the **first** detection 0.11 s, every one after it 3 ms, and the
resident set 34 MB. Against ~5–9 s of model time per emission pass that is free, which is why it is built once
at the composition root and read per **text** rather than per job.

Taking the counts rather than the texts matters for the same reason: a second pass cost one Unicode-name
lookup per character of the sheet all over again — ~**12 000** of them on a 3 000-character four-text pool,
paid once per acquired text.

**Three censuses** over Unicode 15.0 and the two corpora (`scripts/lang_gate.py --folds`; the per-letter
counts are above, "The fold is provably free on every recorded row"):

| census | count |
| --- | --- |
| alpha codepoints whose UCD-reported script is not their base letter's | **983** (the Mathematical Alphanumeric Symbols block alone is 936; then the double-struck / script / black-letter letterlikes, `ª` → `Feminine`, `µ` → `Micro`, `U+2126 OHM SIGN` → `Ohm`, `U+2135 ALEF SYMBOL` → `Alef`) |
| **non-letter** codepoints that fold onto at least one letter | **953** |
| **letters** that fold onto at least one non-letter | **35** |
| non-letter characters in either corpus whose fold lands in the English vocabulary | **0** |

Script names are the canonical ISO-**15924**-ish spellings rather than the UCD's own words. An ambiguous
script's exclusive letters break its tie — Ukrainian's additions do not exist in Russian, which has no
`і ї є ґ` (dropped in the **1918** reform), and Persian's and Urdu's additions do not exist in Arabic — and
the marker share is proportional, so a quoted title stops moving the bundle while a bilingual sheet still can.
On the measured shape — a 475-letter Russian sheet carrying one three-word quoted Ukrainian fragment — **2** of
475 (**0.42%**) no longer decides and **3** of 475 (**0.63%**) does. The count floor stays beside the share
because a share alone is noise on a tiny sheet: one marker in a 40-letter fragment is **2.5%**.

### Syllables: the tokens the hyphen rule reaches

Over the bench corpus's 32 truth texts, **10 711** hyphen-free tokens: 59 occurrences across 38 distinct
tokens reach the internal-hyphen path the ladder used to mangle.

### The envelope gate's three tiers, and the points behind them

The gate is `r ≥ 0.40` within ±0.5 s **or** `r ≥ 0.25` with a lag inside ±0.1 s **or** `r ≥ 0.60` at any lag
(`align_lines._envelope_passes`; the design is §5.2 of
[`../../arch/04-alignment.md`](../../arch/04-alignment.md), which keeps this tier numbering).

The SECOND tier exists because this caller's null hypothesis is not the LRC-shift one: timings measured **on
this audio** must fit at zero lag, and the two measured wrong-song fits land at **large** lags — **+1.64 s** and
**−7.66 s** — with `r` up to **0.31**. So a near-zero lag is discriminating evidence in its own right. The
counter-example is a live song (`Rise Up`) with sparse singing that scored `r` **0.31** at a fit of
**−0.02 s**: right timings that a flat 0.40 floor alone refused. The calibration is **few points**, stated
rather than buried: 3 right songs, 2 wrong sheets and 1 live refusal.

The THIRD tier, **`r ≥ 0.60`**, is the OFFSET case: a correlation that high says the shape agrees, and what is
left is a lag — a sheet to move (the claim clock) rather than a text to refuse. It is why either the blind or
the repaired fit passing is enough: a high-`r`-but-large-lag repaired fit is a shifted-but-shaped series, not a
wrong-text one. The SHEET-span gate (`_sheet_passes`, on a sheet's own claimed spans) is tiers **1 and 3 only**
— never the ±0.1 s one, because a sheet's timings were not measured on this audio and any broad sheet envelope
best-fits near zero lag, so that tier is where the sheet-span null leaked.

### Trimming a line at another line's measured start

The clamp's bounded left floor re-fits only the tail past the boundary, and the question it had to answer is
whether that re-fit moves a measured onset. Over the 20 Jamendo songs at `truth` through the shipped
`time_text` (base model, `_runs/w6-{clamp,tail}-jamendo`), against an affine remap doing the same job: word
±100 **83.52** against 83.12, ±250 **94.08** against 93.92, ±300 **95.04** against 94.98, word end ±100
**80.02** against 79.87, MedAE **38.2 ms** against 38.5, highlight **77.58** against 77.45 — every one at or
above the W4 row this must not regress (83.25 / 93.96 / 94.98 / 80.02 / 38.2 / 77.10), where the affine version
sat 0.1–0.2 pt under four of them. It costs phrase-final end ±100: **59.23** against the remap's 59.66 and W4's
59.83, on 2 more scored ends, because a trimmed line's last word now ends at the boundary and that word is a
phrase-final one.

**The anchor walk** (an anchor whose tail cannot hold one frame per word still to be placed is dropped, and the
word before it tried) is swept and the figures above hold to the digit: the collapsed tail it exists for reaches
**21 of 1 088** `time_text` cases on the base bundle and **13** on HuBERT-L, none of them `truth` on a song with
word truth. Without it, words at 10.0 / 19.999 / 20.4 / 20.9 / 21.6 s trimmed to 20.0 published the last three
inside **0.8 ms** of 19.999 — four words the TV can never light, since it lights `start <= pos < end` and that
interval is empty to the float. The walk **buys** 3 gross words on `Wordsmith_-_The_Statement` drop20 under
HuBERT-L (**43 → 40** pooled, AAE **146 → 143.7 ms**). What it **costs** is not the tail: the out-of-order word
the collapse used to produce was tripping `run_align`'s line-sync retime on three base-bundle cases, which now
publish their word document instead — `believer` extraverse 65.75 (W4b) → 98.63 (the accident) → **73.97**,
`feel-my-heart` credit back to W4b's **94.59**, `rap-god` drop20 100.00 → **87.93** (pooled `run_align` drop20
±500 90.48 → **88.98**, extraverse 90.69 → 89.66, gross and `high_gross` 0 throughout). So the walk is not free
at `run_align`, and that trade is the owner's open question in the PLAN's status log.

### The pool gate's rejected control

`results/w7-pool.json`'s `wrong-track` arm reads ±500 **78.70** over the pool against the ranked arm's 77.91
and fails the gate's own `keeps-pm500` clause — the control is better on that column because it publishes a
different, shorter population, which is what the clause exists to catch.

### Why a held line's end is STRETCHED past its predecessor's, not held at it

Holding the end **at** the predecessor's end does not fix the nesting defect, and the trace says why. Core's
`activeLineIndex` returns the FIRST line whose bounds contain the playhead, so a byte-identical span loses
every instant of itself to the predecessor and the held line first lights at the predecessor's END — the same
defect at the same line, one `max` short of a fix. Traced on the rule's own fixture (`a` = 12.0–14.5 s,
`b` = 11.8–13.8 s): `_in_claim_order` returned `b` as **12.0–14.5 s** and, sweeping the playhead through a
transcription of `activeLineIndex`, `b` first lit at **14.5 s**. So the end is stretched `_REPAIRED_MIN_SEC`
**past** the floor, bounded by the next kept start so that lighting the held line cannot delay the one after
it. Where the next start leaves no room the span stays identical and the line is still never lit: a published
sheet with one dark line, against `policy.decide` dropping the whole text.

### The LINE_SYNC rung's four candidate rules, on the MAPPED claims

The rule-by-rule table above is W3's placement; this is the same four rules re-read after the claim clock
places the sheet (`scripts/line_gate.py`, base model, 1056 cases, 13 timed modes, 416 right texts, 640 wrong;
the quality population is 411 good / 2 middling / 3 bad on the mapped claims):

| rule | good refused /411 | bad published /3 | right refused /416 | gross shown |
| --- | --- | --- | --- | --- |
| sheet gate + lift (W1) | **170** | 0 | 175 | 0 |
| lift alone, timings unchecked | 0 | 3 | 0 | **76** |
| **lift + decode agreement ≥ 0.5 (shipped)** | **29** | **0** | **33** | **0** |
| lift + (sheet OR decode ≥ 0.5) | 14 | 0 | 18 | 0 |

OR-ing the sheet gate back in is the one row that looks cheaper and is not: its 18 refusals publish the two
documents more than 20% gross and `never-be-alone`'s, which is why it is still not taken.

**A TRANSCRIPT is exempt from the gate entirely**, and the measurement is why. Its spans were measured on
*this* recording, so it can be neither the wrong song nor on another master's clock — the two things the gate
detects — yet read as a sheet it fails: `hello`'s whisper `base` transcript scores **r = 0.33 @ +0.22 s**
against its own recording over **61** lines (the presplit spans share a segment's span by character count, so
they blur), and was refused as if it were another song's sheet, ending `lines` mode in NO LYRICS for a song
with audible words. `Ridgway`'s passed at **r = 0.69 @ +0.00 s**. The worker this replaced published a
transcript's own timings ungated in both modes.

### Why `syncMode=lines` needs a vocals stem, as the populations

The LINE_SYNC rung's sheet-span gate reads a text's claimed spans against the singing it can hear. On the MIX
the activity band fills every silence it reads, so the gate has nothing left to separate a right sheet from a
wrong one. Measured over every timed bench case with each song's **mix** in place of its stem
(`scripts/sheet_gate.py --target mix`):

| span population | right texts passed | wrong texts passed | truth claims |
| --- | --- | --- | --- |
| authored-caption spans | **39** of 416 | **3** of 320 | 8 of 32 |
| LRC spans | **37** of 416 | **3** of 320 | 3 of 32 |
| best threshold found | **60** of 416 | 3 of 320 | — |

Truth-claim median `r` on the mix is **0.33** against the wrong texts' **0.17**, whose top decile already
reaches **0.32** — so no threshold separates them. Line-only on the mix therefore refused nearly every correct
sheet in favour of an ASR transcript or no lyrics at all, which is why such a song is aligned as `forced`
instead and gets the forced path's own wrong-text gate. (Before the sync mode was honoured at all these songs
were word-aligned, so this is what they get again.) The same gate on the STEM is §5.3 of
[`../../arch/04-alignment.md`](../../arch/04-alignment.md), where it passes 241 of 416 at 0 of 320.

### Miscellany, each with the defect it records

* **A revoked job must be observed, not polled.** Measured live: a 195 s song fetched in 2.1 s and separated
  in **22.3 s**, then its align job was revoked at **32.9 s** — inside the window a poll would have missed.
* **WhisperX lowercases its dictionaries** at `whisperx/alignment.py:98,110`, which is why the target filter
  lowercases before looking a character up.
* **A tensor slice keeps its parent alive.** Holding a view of a **1 699**-frame parent matrix kept the whole
  parent resident until the concatenation — 12% of the resident set — which is why the emission pass copies
  rather than slices.
* The key detector's weights are Krumhansl & Kessler (**1982**) probe-tone key profiles.
* **A harness bug reads like a model bug.** `bench.py` matched aligned lines to truth rows by **position**
  instead of by the line's own index; a dropped decorative line (`♪`, no alignable characters) then scored every
  later line against the wrong truth row and showed as a bias of **+5 140 ms** on `tfr-chosen`. Entirely the
  harness. Matching by index is why every score in this document can be compared across waves.
* **The estimators' citations**, since the code now names the shape rather than the paper: the claim clock's
  vote is RANSAC's inlier count (Fischler & Bolles **1981**), its tempo candidate a bounded Theil–Sen slope
  (Sen **1968**), the lexical lift a self-normalised goodness-of-pronunciation (Witt & Young **2000**), and the
  karaoke-timing-onto-other-recordings prior art is DALI
  (<https://transactions.ismir.net/articles/10.5334/tismir.30>).

### The harness scripts: what each one is for, and the limit it states

Seven of the scripts under `scripts/` carried their own manual in a module docstring 54 to 120 lines long.
W7b moved it here, on the directive's rule, leaving each script a few lines of WHAT plus its usage block.
`e2e.py`'s own manual is "The E2E harness" above and `e2e_lib.py` is its pure half; what follows is the rest.

**`e2e_gates.py` — the reject-if language.** Every wave of the plan is accepted or rejected on conditions like
"truth-mode ±500 drops more than 1.0 pt" or "any Jamendo song gains a gross line". Checked by hand from two
printed tables, the arithmetic is where a gate quietly passes; written as expressions, they are checked the
same way on every run and a failing gate exits non-zero. The grammar is a RESTRICTED Python expression, parsed
with `ast` and walked node by node (never `eval`):

- **References** are dotted paths into a summary. `[base.]MODE[.GROUP].METRIC` is one pooled number
  (`truth.pm500`, `base.blind.jamendo.gross`); `[base.][MODE.][GROUP.]song.METRIC` is one number PER SONG
  (`truth.jamendo.song.word_pm300`, `song.gross`). MODE is a claim mode, or `mode("jit+off15")` for a
  `+`-combined one; GROUP is `jamendo` / `youtube` / `scored` / `nonlatin` / `all` (the default); `base.`
  reads the `--compare`
  baseline. A per-song path with no MODE ranges over EVERY mode, keyed `(mode, song)`. METRIC is a name from
  `e2e_lib.flat_metrics` — `pm500 pm1000 text_pm500 text_pm1000 gross zero_gross_songs high high_gross refused
  error published scored in_text missing unsung text_paired`; `word_pm100/250/300 word_pco300 word_bias_ms
  word_gross`; `end_pm100 end_pm250 end_bias_ms final_end_pm100 final_end_pm250 final_end_bias_ms`;
  `highlight`; `wrongtext_pass`; the `run_align` policy counts (`attempts retried mix_published
  changed_vs_first asr_requested asr_published no_lyrics`, and `retime_<knob>` for EVERY policy knob, 0 when
  unused); and the 95% bounds `pm500_lo/_hi`, `text_pm500_lo/_hi`, `gross_lo/_hi`, `word_pm300_lo/_hi`,
  `word_pco300_lo/_hi`, `highlight_lo/_hi`. A per-song path also knows `e2e_lib.SONG_METRICS` plus
  `doc_changed` / `onsets_changed` — 1 where the published document (its bytes, or only its line and word
  START times) differs from the baseline's, a refusal on either side counting as a document of its own — and
  `METRIC_up` / `METRIC_down`, 1 where the run is above / below the baseline.
- **Which ±500.** `pm500` / `pm1000` are over the lines PUBLISHED documents scored, which is how the review
  baseline is stated, and a refused song adds nothing. `text_pm500` / `text_pm1000` are over every truth line
  the text asked for with a refused case's lines counted as misses — the one to gate on wherever a refusal must
  not read as an improvement. `word_pco300`, `highlight` and `missing` already count refused and ERROR cases in
  their denominators.
- **Operators**: numbers, `+ - * /`, comparisons (chainable), `and` / `or` / `not` — with EVERY operand
  evaluated, no short-circuit, so `ok or typo.pm500 > 0` errors instead of passing. Per-song values combine
  elementwise and a plain number broadcasts.
- **Functions**: `count(v)` (how many per-song values are non-zero); `min` / `max` / `mean` / `sum` over
  per-song values (`min` and `max` also take two or more numbers); `abs(x)`; `delta(ref)` = run − baseline of
  one POOLED number (a `song.` path is an ERROR — it used to read the pooled number silently);
  `min_song_delta(ref)` / `max_song_delta(ref)` = the smallest / largest per-song (run − baseline) of `ref`.

A GATE IS THE CONDITION THAT MUST HOLD — the negation of the reject-if. "Reject if truth ±500 drops more than
1 pt" is `truth.pm500 >= base.truth.pm500 - 1.0`; "reject if any Jamendo song is more than 1 pt worse at ±300"
is `min_song_delta(jamendo.word_pm300) >= -1.0` (MIN, the worst song, for a metric where higher is better —
`max_song_delta` would read the best song); "reject if any song gains a gross line" is
`count(song.gross_up + song.missing_up) == 0`, because `gross` counts only lines that PUBLISHED, so a song
with 2 gross lines that flips to refused reads FEWER and `count(song.gross_up) == 0` would hold on its own
(pinned in `test_bench_e2e.py`) while `missing` rises with either. W1's "reject if a published doc changes on a
song whose stem coverage is ≥ 0.80" is `count(song.doc_changed * (base.song.coverage >= 0.8)) == 0`.

**A gate that CANNOT BE EVALUATED is an ERROR, and an error fails the run exactly like a FAIL**, because a gate
that silently passes on missing data is how a regression ships. Every one of these is an ERROR: a mode the run
did not measure, a metric with no data (YouTube has no word truth), a `base.` path with no `--compare`, no song
in common; a run-vs-baseline comparison over songs the run did not measure (per song, any `(mode, song)` the
baseline has and the run lacks; pooled, any difference between the two sides' song sets for that mode and
group, since a `--songs` run against the full baseline compares two different pools — and the same for a
REDUCTION of a baseline per-song value); any gate that reads the baseline when the two summaries measured
another SETUP — level, seed, wrong_k, language, tfr audio, ASR or sync mode (`SETUP_META`; an unrecorded sync
mode is `forced`, what every run before `--sync-mode` sent) — or another key either side does not record,
while a model or `align_*` difference only WARNS because that is what an arm varies; a song that LOST its value
(scored in the baseline, refused now: a refused song has no ±500 / word / highlight value but a gross COUNT of
0), in `min_song_delta` / `_up` / `_down` and in explicit arithmetic alike, where a song that GAINED a value
has no delta and is skipped (`refused_down` counts it); any gate that reads a metric THE RUN'S BUNDLE COULD NOT
MEASURE, since on a run marked `uncalibrated` every emission-scale gate stood down and `wrongtext_pass` is then
the sheet-span envelope gate's reading rather than that bundle's (`UNCALIBRATED_METRICS`); and a reduction over
per-song values some song has NO value for — `min(truth.song.pm500) >= 85` must not pass because the worst song
was refused, so gate a metric every song has (`text_pm500`, `gross`, `refused`) or scope the path to where the
metric exists. ERROR ROWS FAIL THE RUN on their own: `run_gates` adds a built-in `no-error-rows` gate, because
a case the harness could not complete otherwise reads as a refusal — a wrong text "correctly" refused — or
drops out of every pooled number.

GATE FILES are JSON (`{"name": "expression", ...}` or `[{"name": ..., "expr": ...}, ...]`) or the YAML subset
every example uses: one `name: expression` per line, `#` comments, optional quotes. That subset is plain YAML,
so a real YAML parser reads the same gates (quote an expression starting with `[`, `{` or `- `). The CLI exits
3 when any gate FAILs or ERRORs and 2 when the gate file or baseline cannot be read.

**`lift_gate.py` — the lexical bands.** It calibrates `lexical.lift`'s thresholds for both of the gate's
consumers: the LINE_SYNC rung, where a text must lift or a same-video translation could line-sync, and the
global engine's word documents, where the lift REPLACES the envelope gate on a stem (that gate scores our own
decode, which the audio pulls onto the voiced frames whatever the text — 152 of 320 wrong texts passed it at
W1) and sits beside it on the mix. It runs the SHIPPED helper and decoder over every text a right-text case
serves (`truth`, which every offset / tempo / jitter / blind mode also serves since the lift reads no timing,
plus `headers`, `credit`, `extraverse`, `drop20`, `drop50`) and every wrong text (`wrongtext`,
`wrongtext+ownclock`), served exactly as the text adapters serve them (`clean_segments`), off the bench's
emission cache — so a warm stem run is decodes only, while `--target mix` pays one model pass per song the
first time. `--target mix` also records each text's BLIND envelope fit, which is the half of the shipped mix
gate that reads no claims; since the shipped gate passes if the blind OR the repaired fit does, that
UNDER-counts the passes a repair could add (and `blind`-mode texts have no repairs at all). Scoring is against
the row of the bundle it measured (`lexical.CALIBRATED` is keyed by bundle), and a bundle with NO row is scored
against the shipped one as a stated REFERENCE while the run prints the row it FITS — which is what a
recalibration is for. It prints nine blocks: each population's range per split; the texts too short to measure
(`lexical.MIN_LETTERS`); the HELD-OUT check (τ fitted on one split's gap midpoint and scored on the other, both
ways); pass counts per threshold; how the lift combines with the shipped envelope gate case by case over the
W1 `time_text` bench, whose outcomes ARE that gate's (or, on the mix, the blind envelope with the lift floor
per floor); each population per SHIPPED band; the truth texts' blind decode timing per band, which is what the
mix doubt band is drawn on; the W1 `run_align` line-synced right texts and their lift; and THE ROW THIS RUN
FITS, on the 0.05 grid, ready to paste into `lexical.CALIBRATED` — or a refusal to pick one where the
populations overlap. The fifth field of that row, `line_sync_min_agreement`, comes from `line_gate.py` instead.
The numbers are in "The lexical-lift wrong-text gate", "Per-model calibration" and "The lexical calibration
rows, exhibit by exhibit".

**`line_gate.py` — the LINE_SYNC rung's gate, rule by rule, with no model pass.** Under `syncMode=lines` the
rung is each text's only attempt, and in forced mode it is the terminal knob for a word document that came back
unusable; it publishes the text's OWN line timings, so its gate owes two answers — are these words sung (a
same-video translation's timings describe the audio whatever its words), and do these TIMINGS describe the
audio (a sheet for another master, off by seconds, publishes off by seconds). At W1 the gate was the sheet-span
envelope gate AND the lift ≥ 0.2, and measured over `syncMode=lines` at `run_align` across 10 timed modes it
published **0 of 640** wrong texts but refused **107 of 320 right texts** by the sheet gate (truth 4 of 32:
hello, rap-god, bohemian-rhapsody, bad-guy) — **every one of them a text whose lift was ≥ +0.26**. That is why
the rung now also holds the text's own DECODE: a second witness to where each line is sung, which the envelope
cannot give. The six rules it prices, each over the same cases, are `sheet alone` (the pre-W1-r2 gate),
`sheet+lift` (W1's), `lift alone` (the timings unchecked), `decode(θ)` (the lift AND at least θ of the decoded
lines starting within `--near` of their placed claim, falling back to the sheet gate under 3 paired lines —
SHIPPED at W3 with θ = the bundle's `line_sync_min_agreement` and `--near` = `_LINE_SYNC_NEAR_SEC`),
`either(θ)` (the lift AND (the sheet gate OR `decode(θ)`)), and `decode(0.5)+lag` (measured, not shipped).
Since W2 "placed" means MAPPED — the rung votes on the claims' clock first — so every row's primary columns
(`near`, `gross`, `w500`, `w1000`) are read off the sheet as the CLAIM CLOCK places it, with `w3_*` carrying
the same readings under W3's unconditional activity shift and the `placement` block printing the two side by
side; `--near` moves the vote's band as well as the gate's, since the rung scores its candidate maps in the
band it counts a line near in. Per rule it prints right texts refused, the published right documents' lines
(scored, gross, ±500 ms, ±1 s), the text-denominator ±500 where a refused text's lines count as misses, and
wrong texts passed — because a rule that refuses a right text whose line document would have been accurate
costs the room lyrics, and one that publishes a right text on timings seconds off shows it lines that are
wrong. The documents are built with the shipped functions and the decode comes from the bench's emission cache.
The tables are in "The LINE_SYNC rung's gate" and "The LINE_SYNC rung's four candidate rules, on the MAPPED
claims".

**`unsung_gate.py` — the never-sung rule's three signals, and every candidate floor priced end to end.** A
caption line that is NOT sung does worse than fail: forced monotonically through emissions that do not contain
it, it consumes its neighbours' frames and drags them off. The shipped rule drops a line on three signals, all
required, then re-decodes what is left, twice round; until W4b its three literals had been fitted on two
exhibits on an older clock, and W4's exact 20 ms grid moved every score, span and envelope read behind them.
The question it answers is whether a PER-SONG RELATIVE floor (a quantile of that song's own inter-line gaps)
beats the shipped absolute level on a P95-normalised envelope, which review L2 says only means something on a
clean stem. It answers it by running the shipped two-round loop under each candidate floor and scoring what
survives against truth, which is the only way to see the rule's real cost: a line the rule drops is a line the
metrics no longer see (`missing`), and a line it spares is one the decode may have put seconds away (`gross`).
It prints the per-song inter-line GAP levels the relative floors are read off (q10 / q25 / median) and their
whole-corpus spread; the CANDIDATE lines with each one's envelope level, score gap, char rate, span and — where
truth has the line — the error of its blind start, split REAL against INJECTED (a `headers` / `credit` /
`extraverse` line the mode added, which the rule SHOULD drop); and one row per floor rule, where `abs-0.00` is
the rule OFF so the first two rows price the rule itself. It runs BLIND deliberately: no claims reach the
rule's three signals, since only the SPARE arms read a claim window and both ship off, so this is the
population the shipped rule judges. What it cannot see is the repair ladder's reaction to a SPARED line — in a
claim mode a kept line is re-decoded inside its claim window — so a floor this script likes still owes the
corpus bench. The committed rows are all `--target stem`, and `--target mix` is the case L2 is actually about:
on a mix the band fills the gaps between lines, so 0.10 is nowhere near them and the rule can never fire. That
target is a SHIPPED path rather than a hypothetical, since the align target of a stemless song is the mix, so
there an unsung caption or credit line is timed and published. Nothing in W4b ran it, and the conclusion in
"The never-sung rule: the two lines no floor can separate" is a STEM conclusion.

**`lang_gate.py` — which bundle should time a non-English song, and M9's blank proved live.** It is a separate
script rather than a mode of `e2e.py` because the language question needs a different CORPUS (the 59 fr/de/es
JamendoLyrics songs `jamendo.py` deliberately skipped) and a different COMPARISON (bundle A against bundle B on
the same audio and text, blind, with no ladder in between), so folding it in would have meant a second corpus
loader and a second scorer inside the harness that owns the shipped path. It reads the same shipped functions —
`ml.WhisperXAligner.emissions`, `generate`, `forced_align_decoder` — so what it measures is the decode that
publishes. `--folds` is the first thing to run and it gates everything else: the target filter now folds a
character the vocabulary lacks to its base letters, and a fold that moved ONE English target sequence would
move every number under `results/`, so it counts, over both corpora, the characters that newly align and the
ones NFKD still cannot decompose. `--blank` loads a REAL bundle whose `[PAD]` is not at 0 and decodes one text
twice, once with the matrix's own `blank_id` and once with the literal 0 the code used before W4; the LANGUAGE
PAIRING IS ARTIFICIAL and said so, since no Norwegian song with measured word truth is in the corpus, but the
model, the pad's position, the forward pass, the audio and the truth are all real — strictly more than the
review's column permutation had. **Matrices are not cached on disk here, deliberately**: 59 songs × 2 targets
× 2 bundles is ~**4 GB** of float32 no other run would read, and at ~**5–9 s** a song the model pass makes a
full sweep **~20–35 minutes** either way; the shipped adapter's in-memory LRU still serves the two bundles of
one song. Its corpus layout under `$ENCORE_BENCH_ROOT` is `jamendolyrics/` (the dataset checkout:
`mp3/<slug>.mp3`, `annotations/lines/<slug>.csv`, `annotations/words/<slug>.csv`, `lyrics/<slug>.words.txt`,
`JamendoLyrics.csv` for the Language column) and `_lang/stems/<slug>/vocals.wav` (htdemucs vocals, built by
`_lang/separate.sh` at ~15 s a song). The readings are in "W7: the language is an INPUT" and "Language: the
detector's cost, and three censuses".

**`amll.py` — the non-Latin truth set's ingest, and the only script here that writes truth.** It reads each
`<bench>/amll/<slug>/lyrics.ttml` (AMLL TTML DB, CC0) and writes that song's `truth-lines.json` +
`truth-words.json`, grouping the TTML's per-SYLLABLE spans into words on the TTML's own whitespace so the
truth words and `line.text.split()` are one tokenisation. It drops background vocals, translations and
romanisations, reports what it dropped, and refuses a file whose line starts run backwards. `jamendo.py` is
its English counterpart. The set it feeds, the admission rule and the per-song numbers: "W8: the non-Latin
truth set".

**`pool_gate.py` — what the ranking actually CHOOSES.** W5 landed "every provider is a candidate" with a
corroboration-ordered candidate tier (review M13) and an LRCLIB retry without the duration (L5), and
`e2e.py --level run_align` CANNOT SEE EITHER, because its ports serve ONE text per case: `Search`'s pool has
one entry, `order_pool` has nothing to order, `policy.corroboration` is computed over a pool of one (False by
definition) and the L5 retry never fires because the harness provider answers every lookup. Both shipped on
unit tests alone, and this script closes that gap with the SAME production code — `_acquire_texts`,
`fetch_captions`, `fetch_provider_lyrics`, the REAL `LrclibClient`, `_pool_of`, `order_pool`, `Search`,
`policy.decide`, `time_text`, the gates — over the real corpus audio with a pool of three to four texts the
ranking has to choose between, scored by the same scorers every other row here uses. It is a separate script
because `e2e.py`'s bytes are in `code_fingerprint`, which every recorded row and every `--resume` is keyed on,
and its one-text-per-case ports are what makes a `run_align` row byte-comparable with its `time_text` row; a
pool dimension there would move that fingerprint for rows that have nothing to do with M13 and put a second
text in front of attempt 1 of every case. So it reads the same shipped path through `e2e.py`'s own seams and
writes its own rows, and nothing under `results/` moves.

**THE POOL IS SYNTHETIC, DERIVED FROM THE CORPUS TRUTH, AND THAT IS A STATED LIMITATION.** The first choice was
to CACHE what the providers actually return per corpus song. Not done, for three reasons, none of which is "no
network" — the box has one. (1) **The corpus has no metadata to look up**: `fetch_provider_lyrics` needs an
artist AND a track and refuses a guess, while the corpus is keyed by SLUG and the driver passes the slug as
both, so real lookups would need a hand-written slug → (artist, title) table, i.e. the bench asserting song
identity it does not have. (2) **A real sheet has no truth identity**: every metric here pairs a published line
to a truth line THROUGH the claim it came from, and a fetched sheet is a different lineation of the same song —
merged couplets, an extra chorus repeat, an ad-lib written down — so most of its lines would pair with nothing
and "is the chosen text better against truth" would be answered on a shifting denominator, which is the exact
artefact this harness exists to avoid. (3) **Caching commercial lyrics as a durable fixture is not ours to
do**: lrcmux multiplexes KuGou / QQ / NetEase, whose sheets are licensed catalogue text, and the corpus's songs
are Adele, Eminem, Queen. So each pool text is built from THIS song's truth lines, as every other text in this
benchmark is, in the four shapes the review's cases need; what is NOT synthetic is everything the gap was about
— the acquisition steps, the labels and tiers they build, the witness split, the corroboration reading, the
order, the ladder, the gates, the audio and the truth.

The four `--pools`: `sdh` is the review's motivating case (an SDH caption track of this song's words on the
subtitler's clock, every cue opening early, one word misheard every `MISHEARD_EVERY` lines; another corpus
song's sheet as the provider; the clean sheet served only through the L5 retry; plus YouTube's auto track);
`wrong-track` makes the upload's authored track another song's words on THIS video's clock, so it agrees with
nothing while the clean sheet agrees with the machine track, which is where the tie-break can actually move the
chosen text; `allwrong` makes EVERY candidate a different song's words — the MUST — with no machine track,
since an ASR track of this audio can never be the wrong song and including one would make a RIGHT text
available; `clean` is the clean sheet ALONE, the counterfactual every other row is read against and the control
that this script's plumbing reproduces `e2e.py`'s reading of a single provider sheet. The three `--arms` are
`ranked` (the shipped tree), `arrival` (PRE-M13: corroboration neutralised so `order_pool` falls back to
arrival order, AND `fetch_provider_lyrics` truncated to the first provider that answered — both harness patches
of exactly what M13 added, so the delta between the arms IS M13), and `no-l5` (the shipped ranking with the
unqualified retry 404'd as well, so the clean sheet is simply absent: the song falling through to ASR with a
good human sheet one request away).

**Why the machine track is in two of the pools.** `policy.witness_of` counts every provider sheet as ONE
witness, so within the candidate tier the only cross-witness pair is (authored captions, some provider sheet).
A pool of an authored track plus sheets therefore has exactly two states — the track agrees with a sheet, and
then BOTH read corroborated and the track keeps its arrival-order lead; or it agrees with none, and then no
sheet is corroborated either, because nothing else could corroborate one. YouTube's AUTO track is a third
witness and production fetches it in the same step, so it is served here: it is what lets a clean sheet outrank
an authored track that agrees with nothing. Its own tier is MACHINE, so it is never tried before a candidate.

Per row it records the pool as production built it, each text's corroboration reading, the order the ladder
tried them in, which text PUBLISHED, that document's score against truth with the text-side denominators kept
for a refusal, and the per-attempt score of EVERY text the ladder tried — so one row says what the chosen text
scored and what the text beside it would have scored. `wrong_published` is the MUST. **Cost**: the emissions
cache is keyed on the AUDIO rather than the text, so a song pays one model pass for all its pools and arms and
the rest is decode and repairs; the default plan is **11 jobs a song**, measured at **132 jobs / 341 s** forced
and **96 / 170 s** in `lines` over 12 YouTube songs on a warm store. The results are in "W7: the provider pool
is real now" and "The pool gate's rejected control".

### The repair-order property test, seed by seed

`worker/tests/test_repair_order.py` holds invariant XA-08 — a published document never runs backwards — over
32 seeded scenarios driven through the REAL `time_text`. Its exhibits lived in its own docstring and are here
because they are measurements.

**The property is achievable by construction**, which is what makes it fair to hold every wave to it: the
blind decode is an exact CTC Viterbi (`tests/ctc_fixture.py`, frame-for-frame torchaudio's) and therefore
monotonic, so keeping every original line would already satisfy the property. A repair may only ever be
accepted in a way that keeps it. The scenarios, one per seed, are **6–10 lines** of random words with repeats,
sung as tones at their true spans with gaps down to **50 ms**, in three kinds: `claims` (a timed sheet where
one line, or a run of two, claims the wrong time by **0.8–3 s** either way — R2's padded claim windows plus
adoption), `stem-gap` (a line the stem lost and the mix still has — R4) and `untimed` (a plain sheet whose
repeats are blind — R3).

**Measured before W1** (HEAD `23c44114` + W0): **4 of 32** scenarios published backwards word starts, all of
kind `claims`, and each was one of review M2's shapes — seed 6, a repaired line starting after the next
trusted line's start squeezed rather than rejected; seed 12, the **0.2 s** floor pushing a repaired line's
words past the next start; seeds 2 and 30, the last of a run of two repaired lines bounded but not rejected.

W1 built the order-preserving `_clamped` that turns each green, and it ships as the DEFAULT-OFF arm
`m2-order-clamp`: on the 32-song corpus it failed two of W1's reject-if gates (**63** more wrong texts
published by the job, and a Jamendo song gaining a gross line under `jit`); re-judged under W3's lexical gate
the first is closed and the second still fails, so it stays off. Every test there therefore runs on BOTH arms —
the default, whose 4 seeds keep `xfail(strict=True)` so that a default which stops inverting them turns them
red, and the arm, which must pass all 32. **Measured on the 32 seeds with the arm**: those 4 plus seeds 8, 10
and 16 refuse a repair — 3 of them cases whose old clamp had squeezed an adopted WRONG claim into the gap in
order, **0.4–1.4 s** off — and every refused line is back on the blind decode, **within 60 ms** of where it is
sung; on the other **25** seeds the two documents differ only where the DEFAULT's bounded left floor pulls a
neighbour's END onto a repair, which the arm does not do (seed 9 is one). Seeds 0, 4, 14, 20, 22, 24 and 28
still publish a misclaimed line **0.6–2.0 s** off: an adopted claim that FITS in order, which is adoption's
business and not this property's.

**Why it runs per seed**, and the mutation that proves it: a single test over all 32 (the first version) could
not name which seed newly violated the property, nor tell this test's own `out_of_order` cross-check failing,
which is why that check is a test of its own. With `_clamped` deleted, the single-test version stayed GREEN and
the per-seed version failed **7** seeds; with the arm on, a no-op `_clamped` fails **11** seeds and all 4 of
the fallback tests.

## W7c: the readings that lived in the TESTS (2026-10-02)

W7b emptied the package and the harness of documentation essays and left `worker/tests/**` out of scope; W7c
extended the same bounds to the tests and the harness scripts (239 blocks, 68 test modules and 12 scripts —
`docs/arch/05-worker.md` §12 has the rules). A fixture's numbers belong beside the fixture, so most of those
numbers stayed in the test that asserts them. What follows is the handful that a shortened docstring could no
longer carry, with the exhibit each one belongs to.

### The emission frame grid, as `test_ml_grid.py`'s fixtures state it

The grid is `ceil(samples / 320)` frames with a 400-sample receptive field, and the arithmetic below is the
whole reason the tests exist — the old `duration / frames` ratio stretched every frame.

| reading | why the fixture uses it |
| ------- | ---------------------- |
| **1 920 001** samples → **6001** frames over FIVE passes | pass 3 keeps frames 4500..5999 and its last field ends **79** samples past the file, so an INTERIOR pass pads while pass 4 still exists to stamp frame 6000 — which is why the padding property is the implication "padded ⇒ `stop == total`" and not "only the final pass pads". |
| **24000 / 473600 / 480000 / 544000 / 980800** samples | each an exact multiple of 320, where the OLD `duration / frames` equals 0.02 to the last bit: the lengths on which reverting `frame_sec` to a derived ratio was invisible and the mutation survived the whole suite. |
| **1.51 s = 24160** samples = **75.5** hops → **76** frames, derived `frame_sec` **0.019868** | one of the two lengths that holds `frame_sec` as a constant. |
| **29.999 s = 479984** samples, derived `frame_sec` **0.0199993** | the other. |

### The OOV placeholder's own exhibit (`test_ends.py`)

A word with no alignable character gets `start = end = the previous word's end` from `generate`'s OOV branch:
verified against the real `generate`, `["hold on 2", "next"]` publishes `'2'` at **0.5600-0.5600**, exactly
`'on'`'s end. That is why the word-end hold belongs to the word with acoustic evidence and the placeholder
stays a point — the TV lights `start <= pos < end`, so a zero-width span is never the active word.

### The prose ratios this wave moved

The ratchet's own measure — `test_prose_shape._counts`, prose lines over code lines — per root, each figure
labelled with the tree it was read on. `docs/arch/05-worker.md` §12 is the measurement of record: it carries
the bound each reading is held to, and `test_the_quoted_root_ratios_still_measure_what_they_say` holds the
quotes there to the tree.

* the package **1.21** at `w7b-start`, **0.82** at `w7c-start`, **0.4898** on the shipped tree;
* the committed forced-alignment harness **0.35** after W7b's sweep, **0.322** after W7c's first pass over its
  blocks, **0.2578** once the per-kind rules reached it;
* `worker/tests` **0.3139** and the stem-separation harness **0.2222**, both on the shipped tree.

Two figures this section first carried are RETRACTED, and §12 explains both. **0.745** was that same measure
taken MID-WAVE, after the first pass over the largest blocks had already landed, so it was never the
pre-W7c baseline it was quoted as (review r1-tests-11, r2-correctness-2). **0.3124** was `worker/tests`'
reading before the wave's last edits, where `w7c-start` reads 0.3114. A figure is comparable only against one
taken with the same measure: `_tools/prose_scan.py` counts to its own convention and reads **0.801** for the
package at `w7c-start` where the ratchet reads **0.8173**.

## W8a: the 0.5-2 s band, diagnosed before anything was changed (2026-10-03)

The PLAN's 2026-10-03 row read the remaining ±500 shortfall off `results/w7-run_align.json` as a systematic
per-song offset "nothing in this build can see", concentrated in five songs, and asked which stage introduces
it. Measured, the answer is that no stage does. Everything here was taken through the shipped `time_text` and
`run_align` by monkeypatch instrumentation only — nothing in the worker was edited to measure it — with the W7
run's emission matrices served from disk under its own emitter key `1a2fd6852bd30243`: **43 cache reads, 0
recomputes**, and the five songs' published ±500 reproduce `results/w7-run_align.json` case for case
(bad-guy 2/64, numb 7/35, believer 51/72, `Kinematic_-_Peyote` 10/14, tfr-chosen 24/32). The probes are
`encore-align-bench/_review-scratch/w8a-band/`.

### The 0.5-2 s band: four songs' truth precedes their own audio

`truth` mode, `time_text`, 32 songs, **1735 scored lines**. Median and MAD are of (published − truth) seconds;
`blind` is the same statistic over the first global decode's own line starts, before the claim clock, before
any reconcile and before any repair.

| song | truth is | median | MAD | ±500 | blind median | blind MAD |
| ---- | -------- | -----: | --: | ---: | -----------: | --------: |
| bad-guy | authored captions | **+0.864** | 0.107 | 2/69 | **+0.864** | 0.126 |
| numb | authored captions | **+0.470** | 0.240 | 19/35 | +0.450 | 0.280 |
| tfr-chosen | authored captions | **+0.390** | 0.200 | 23/33 | +0.210 | 0.360 |
| believer | authored captions | **+0.370** | 0.087 | 51/72 | +0.361 | 0.167 |
| hello | authored captions | +0.135 | 0.067 | 72/72 | +0.087 | 0.123 |
| `Kinematic_-_Peyote` | measured onsets | −0.033 | 0.030 | 10/14 | −0.054 | 0.032 |

All **20** Jamendo songs, whose truth is hand-measured, read |median| ≤ **0.078** with MAD ≤ 0.060; the other
eight YouTube/tfr songs read |median| ≤ **0.135**. So four songs carry a coherent shift of 0.37-0.86 s, the
fifth (`Kinematic_-_Peyote`) carries no shift at all and four outlier lines, and the shift is already in the
blind decode: `+0.864` published against `+0.864` blind on bad-guy, and the same within 0.02 s on numb and
believer. In `blind` mode — no claims in the request at all — the medians are unchanged (bad-guy +0.864,
numb +0.450, believer +0.361, tfr-chosen +0.210), which no claim-path stage can explain.

### Three independent arbiters say the sheet is early, not the decode late

**1. Vocal onsets off the stem's own RMS envelope.** For every truth line preceded by 0.5 s of verified stem
silence (mean level under 0.08 of the track's 95th-percentile loudness), the first frame crossing 0.30 and
holding 0.1 s, minus the caption's start. Calibrated on the 20 hand-measured Jamendo songs, where it reads
−0.027 … +0.210 with **18 of 20 inside ±0.07** (the two outside are `Avercage_-_Embers` +0.199 and
`Tom_Orlando_-_The_One__feat._Tina_G_` +0.210):

| song | n | median | MAD |
| ---- | -: | -----: | --: |
| bad-guy | 14 of 79 | **+1.007** | 0.367 |
| tfr-chosen | 10 of 37 | **+0.520** | 0.180 |
| believer | 10 of 73 | **+0.450** | 0.056 |
| numb | 0 of 35 | — | — |
| `Kinematic_-_Peyote` | 7 of 14 | −0.027 | 0.029 |

Controls on the same scale: never-be-alone +0.010, shape-of-you −0.012, bohemian-rhapsody +0.120,
tfr-flyaway +0.120, tfr-mayday +0.120, rap-god +0.173, hello +0.186, feel-my-heart +0.193. numb has no line
with half a second of stem silence in front of it, so this arbiter abstains there.

**2. The step's own `claim_lag`** — `activity.fit_shift` of the SERVED claim windows against the stem, taken
before the clock maps anything: numb **+0.62 s at r 0.69**, tfr-chosen +0.46 at r 0.60, believer +0.36 at
r 0.46, `Kinematic_-_Peyote` −0.08 at r 0.82, and bad-guy +0.78 at r **0.19** — under
`claimmap.MIN_ENVELOPE_CORRELATION` 0.25, so on that song the candidate is not even offered to the vote.
This estimator also carries one large FALSE POSITIVE: never-be-alone reads −0.80 at r 0.77 on a song whose
published median error is 0.000 and whose ±500 is 43 of 46. The vote refused it because that candidate
explained 4 of 46 paired lines against no-shift's 23 — which is why a sub-2 s band rule may not be built on
the envelope lag alone.

**3. Stem energy at the instant each line claims.** Mean envelope over [t, t + 0.25 s], at the truth start and
at the published start, and how many of those windows are silent (under 0.10):

| song | mean at truth | mean at published | silent at truth | silent at published |
| ---- | ------------: | ----------------: | --------------: | ------------------: |
| bad-guy | 0.285 | **0.454** | **23 of 69** | 2 |
| believer | 0.435 | 0.560 | **15 of 72** | 2 |
| tfr-chosen | 0.415 | 0.577 | **10 of 33** | 0 |
| numb | 0.540 | 0.589 | 1 of 35 | 0 |
| shape-of-you (control) | 0.575 | 0.500 | 2 of 88 | 3 |
| `Kinematic_-_Peyote` (control) | 0.783 | 0.732 | 0 of 14 | 0 |

A third of bad-guy's truth line starts fall in vocal silence; two of its 69 published starts do. The stems are
not displaced relative to their mixes either — identical frame counts on all six songs checked, and a
stem↔mix envelope lag of exactly 0.000 s on the five whose correlation is readable (bad-guy's cross-correlation
is degenerate at r 0.09, its vocal being far quieter than its mix's beat).

**And tfr-chosen's truth is QUANTISED**: **86 % of its 37 line starts land exactly on a 0.5 s grid and 68 % on
a whole second**. No other corpus song exceeds 7 % on the half-second grid. A ±500 ms metric cannot be read
on that song at all.

### Which stage set each published start

`truth` mode, 32 songs, 1735 published lines, attributed by the stage that last moved the start:

| stage | lines | blind median | published median | >500 before | >500 after | improved | worsened |
| ----- | ----: | -----------: | ---------------: | ----------: | ---------: | -------: | -------: |
| the blind decode | **1472** | −0.009 | −0.009 | 125 | 124 | 3 | 0 |
| R2 | 250 | −0.661 | +0.000 | 187 | **32** | 220 | 29 |
| R4 | 12 | −0.550 | −0.091 | 7 | 2 | 8 | 4 |
| R3 | 1 | +0.504 | +0.094 | 1 | 0 | 1 | 0 |
| R1 | **0** | — | — | — | — | — | — |

* **R1 never fired** on any of the 32 songs: it needs `rc.UNRELATED`, and a sheet whose common offset is
  fitted out is never unrelated.
* **The claim clock** applied on 8 of 32 songs and placed only **7** published starts itself — the
  claim-ADOPTED lines that carry its own shift: bad-guy [20] [27] [30] [56] [74] [76] at +0.864 and numb [24]
  at +0.620. Of **190 adoptions offered, 190 were taken**, and those 7 are the only ones over 500 ms.
* **R2's 250 lines are 190 adopted plus 60 re-decoded.** Of the 60 re-decoded, **25 are still over 500 ms**
  (10 late, 15 early): a single line re-decoded alone inside a window of claim ± `_REPAIR_PAD_SEC` 1.0 s has
  no neighbour to constrain it. This is the one repair-side defect in the band.
* **The never-sung drop** removed 14 lines over 6 songs (shape-of-you 6, bohemian-rhapsody 2, hello 2,
  tfr-chosen 2, `Color_Out_-_Falling_Star` 1, never-be-alone 1). A dropped line is absent, never mis-timed.
* **`_clamped_v2`** moved **4** starts over the whole corpus (it pulls ENDS: 70 pulls, 0 reverts), and
  **`extend_ends` moved 0 starts** against 1262 ends — invariant XA-01, measured.
* **`ONSET_LEAD_SEC` 0.03** is a uniform −30 ms on all 32 songs and cannot make a 0.5-2 s band. It is also the
  right sign: on each of the five songs the published start sits 0.08-0.15 s BEFORE the measured vocal onset.

**The band itself**: **158 of 1735** lines are over 500 ms and inside 2 s — 124 of them the blind decode's,
32 R2's, 2 R4's — and **114 of the 158 are on the four songs whose truth precedes their audio**, 44 on the
other 28 songs.

### What the four songs cost the corpus metric

At `run_align`, `truth` mode, 163 of 1707 lines miss ±500. **119 of those 163 (73 %)** are on the four songs
— bad-guy 62, numb 28, believer 21, tfr-chosen 8 — and 123 with `Kinematic_-_Peyote`'s 4. Across all 16 claim
modes, **1572 of 2497 misses (63 %)** are on the same four. The largest single lever on this metric is a
corpus correction, not a code change.

### W2's reading of bad-guy, re-taken on today's tree

Both halves verified. The clock's **decode-median candidate is +0.864 s, explaining 54 of 69 paired lines
against no-shift's 1** (margin 3), which is W2's 0.86 s to the millisecond; the tempo candidate offers
+0.888 s at scale 0.99969 and explains 52. And the envelope candidate **was not offered at all** (r 0.1907,
under the 0.25 floor); had it been, its offset is **+0.78 s** — the same direction as the decode, so preferring
it would have moved the claims 0.78 s later instead of 0.864 and recovered nothing. W2's blind envelope
reading reproduces: **r 0.3384 at +0.02 s**, i.e. our decode's spans fit that audio at zero lag.

### COARSE against STRUCTURAL: the class decides which lines may be repaired, not whether the shift applies

The claim clock runs BEFORE the first `reconcile`, so no verdict exists when the shift is chosen, and both
classes applied one: numb COARSE with `envelope-lag` +0.620, bad-guy STRUCTURAL with `decode-median` +0.864.
What the class decides is `Reconciliation.disputed` — under STRUCTURAL every non-corroborated line, under
AGREE / OFFSET / DRIFT / COARSE only lines beyond `COARSE_TOLERANCE_SEC` 1.0 s of the fit — so the repairable
set was numb 2 of 35, tfr-chosen 9 of 33, bad-guy 15 of 69, believer 22 of 72, `Kinematic_-_Peyote` 6 of 14.
Both classes are blind to a coherent sub-second shift for the same reason: `reconcile` fits the common offset
out before judging any line, so every residual is near zero. **82 of the 1396 lines graded `high` are over
500 ms from their truth — bad-guy 54, believer 18, numb 7, tfr-chosen 3, and NOT ONE on the other 28 songs.**
A `high` line that is out by more than half a second only happens where the sheet is early.

### `Kinematic_-_Peyote` is a different defect: R2's window re-decode overshoots

The one song of the five whose truth is sound. Nine of its 14 published lines are the blind decode's, median
−0.042 s. Its four band lines are [5] +0.784, [11] +0.909, [12] +0.763, [13] +0.960, and three are R2's: the
blind decode had put them **1.22-1.53 s EARLY** — a gross error — and R2's single-line re-decode inside the
padded claim window landed them 0.76-0.96 s LATE. [11] is the blind decode's own, re-decoded by R2 in its
window and returned unchanged. Two further lines, [3] and [9], were claim-ADOPTED and publish exactly on
truth, graded `low`. So on this song the ladder converted gross errors into band errors, which is the shape
W6's gross-line work would have left.

### What the harness could not see, and now reports: `band`, `bias_ms`, `mad_ms`

Every line metric this harness has carried since W0 is **symmetric in the sign of the error**. `±500`, `±1 s`
and `gross` all read `abs(error)`, so a document whose every line is 0.86 s LATE scores exactly like one whose
lines are scattered ±0.86 s. That is the whole reason five songs could sit in the 0.5-2 s band through eight
waves of gates: the band was never a population anything counted, and the DIRECTION of the error was never a
number at all. Three per-song, per-mode metrics close it (`e2e_lib._line_counts`, `coherence_metrics`):

* **`band`** — lines strictly past ±500 ms and no further than `GROSS_SEC`. The population itself.
* **`bias_ms`** — median(published − truth), signed. A coherent per-song offset is **one number** in
  `results/`.
* **`mad_ms`** — the median absolute deviation of those residuals about `bias_ms`. This is what separates a
  shift from a spread: a large `bias_ms` with a small `mad_ms` is one displacement, a large `bias_ms` with a
  large `mad_ms` is scatter that happens to be lopsided, and only the first is a finding.

Read off `results/w8a-band-run_align.json` — **W7's own 1088 cases re-summarised, not re-run**, every
pre-existing metric identical case for case — the 14 right-text modes read:

| mode | Jamendo `bias_ms` | Jamendo `mad_ms` | YouTube `bias_ms` | YouTube `mad_ms` | `band` (Jamendo / YouTube / all) | songs over 250 ms |
| ---- | ----------------: | ---------------: | ----------------: | ---------------: | -------------------------------: | ----------------: |
| truth | **−9.3** | 35.3 | +10.0 | 135.0 | 16 / 147 / **163** | **4** |
| jit | −15.4 | 44.6 | +40.9 | 172.0 | 50 / 169 / 219 | 3 |
| off05 | −14.8 | 35.3 | +30.0 | 160.0 | 15 / 152 / 167 | 4 |
| off15 | −14.8 | 35.3 | +30.0 | 160.0 | 15 / 152 / 167 | 4 |
| off3 | −14.8 | 35.3 | +30.0 | 160.0 | 15 / 152 / 167 | 4 |
| offm1 | −15.1 | 35.0 | +30.0 | 160.0 | 15 / 152 / 167 | 4 |
| tempo098 | −13.9 | 35.8 | +12.0 | 146.6 | 15 / 165 / 180 | 4 |
| tempo102 | −13.9 | 35.8 | +12.0 | 146.6 | 15 / 164 / 179 | 4 |
| drop20 | −6.3 | 33.9 | +0.0 | 110.0 | 17 / 116 / 133 | 3 |
| drop50 | +0.0 | 35.4 | +0.0 | 321.0 | 16 / 59 / 75 | 6 |
| extraverse | −8.4 | 36.1 | +10.0 | 130.0 | 17 / 141 / 158 | 4 |
| blind | −18.6 | 40.2 | +9.0 | 185.0 | 52 / 200 / **252** | 4 |
| headers | −9.3 | 35.3 | +10.0 | 134.5 | 16 / 146 / 162 | 4 |
| credit | −8.1 | 36.1 | +10.0 | 134.5 | 18 / 147 / 165 | 4 |

**THE POOLED NUMBER IS THE ONE THAT HID IT.** `truth`'s pooled `bias_ms` over all 32 songs is **+0.0 ms** —
four songs shifted by 0.37-0.87 s against 28 that are not, and the median of the pool sits at zero. A gate
written on the pooled figure would have passed every wave. **The per-song reading is the whole instrument**,
and that is why `bias_ms` and `mad_ms` are in `SONG_METRICS` and the gates below are `count(abs(song.…))`.

The per-song separation is wide enough to put a threshold through without tuning. In `truth`:

| song | `bias_ms` | `mad_ms` | `band` | ±500 | class |
| ---- | --------: | -------: | -----: | ---: | ----- |
| bad-guy | **+868.5** | 111.5 | 62 of 64 | 3.12 | coherent |
| numb | **+690.0** | 140.0 | 28 of 35 | 20.00 | coherent |
| tfr-chosen | **+390.0** | 160.0 | 8 of 32 | 75.00 | coherent (truth quantised to 0.5 s) |
| believer | **+370.0** | 87.0 | 21 of 72 | 70.83 | coherent |
| hello | +122.0 | 82.0 | **0** | 100.00 | — |
| `Kinematic_-_Peyote` | −33.2 | 30.2 | 4 of 14 | 71.43 | local |

Nothing sits between **122 ms** and **370 ms**, so the 250 ms the gates use is a threshold in an empty gap,
not a tuned constant. Above it: 4 songs, all coherent (`mad_ms` ≤ 160), holding **119 of the mode's 163 band
lines (73%)**. Below it with `band` over zero: **13 songs holding 44 band lines**, most of them 3 or 4 on a
song (rap-god 11, shape-of-you 5, tfr-flyaway / `Rxbyn_-_Bad_Side` / `Kinematic_-_Peyote` 4 each) — local
outliers, not a displacement, exactly as the diagnosis found. **And the 15 songs already at 100% ±500 read
max |`bias_ms`| 122 ms, max `mad_ms` 82 ms and `band` 0 between them**, which is the measurement behind the
reject-if that no band rule may touch them: there is nothing on those songs for one to touch.

**`drop50` is excluded from every per-song gate** and the table says why: with half the claims removed the
PAIRING itself breaks, and its per-song medians read −2 428 ms at MAD 2 424 (`Moon_I_Mean_-_Wrong_Concept`),
−2 268 at 2 170 (`The.madpix.project_-_One_Way_Street`) and −11 870 at **12 500** (numb). Those are not
displacements — `mad_ms` ≈ |`bias_ms`| says so — and one of its songs refuses, which leaves `bias_ms` absent
and makes `count()` an ERROR rather than a reading. The two wrong-text modes are out for the same reason: all
320 cases refuse, so no mode-level line metric exists at all.

### What the coherence grade reads

The worker's own version of the measurement above, with **no truth in it**: `reconcile.off_sheet`, graded into
every claimed job, designed in `docs/arch/04-alignment.md` §6.1. Two witnesses must agree before a document is
demoted — the claims AS SERVED say every line moved coherently, and the activity envelope says the singing is
where those claims put it, so the sheet is not what moved.

**No corpus song trips it, and that is the measurement, not an accident.** Only four songs can reach the first
witness in `truth` (the table above), and the step's own `claim_lag` — the second witness, `activity.fit_shift`
of the SERVED claim windows, already computed before the claim clock votes — absolves every one of them:

| song | `as_claimed` lag | `claim_lag` | why it is not demoted |
| ---- | ---------------: | ----------: | --------------------- |
| bad-guy | +0.87 s coherent | +0.78 s at **r 0.19** | under `claimmap.MIN_ENVELOPE_CORRELATION` 0.25 — the fit abstains, and abstention never demotes |
| numb | +0.69 s | +0.62 s at r 0.69 | the envelope reads the SHEET as displaced too: it moved, we did not |
| tfr-chosen | +0.39 s | +0.46 s at r 0.60 | same |
| believer | +0.37 s | +0.36 s at r 0.46 | same |

So the conjunction demotes **0 of 32 songs** on every right-text mode, and the `count(song.doc_changed) == 0`
gates below are that prediction written down. The check earns its place by what it makes impossible rather
than by what it changes today: a document coherently off a sheet the audio CONFIRMS can no longer publish
`high`, and every claimed job's trail now names its distance from the sheet whether or not it demoted.

**`never-be-alone` is why this is a conjunction and not a threshold on the envelope lag.** Its `claim_lag`
reads **−0.80 s at r 0.77** — a confident, large, and completely wrong reading on a song whose published median
error is 0.000 s and whose ±500 is 43 of 46. An envelope-driven rule would have demoted it. Under the
conjunction the FIRST witness stands it down: its published document agrees with its claims, so there is no
coherent displacement to confirm. Each witness covers the other's false positives, which is the only reason
either is usable at 250 ms.

The hermetic exhibit is `worker/tests/test_coherent_offset.py`, and it holds **both** documents: a sheet 0.86 s
early over the sparse fixture still publishes `high` on every line (the envelope absolves us) while the trail
now names the 0.86 s, and the mirror case — the same distance, the stem singing where the sheet says and only
the emission matrix late — publishes `low` on every line and `low` as a document.

**THE WORKER'S TRUTH-FREE READING EQUALS THE HARNESS'S TRUTH-BASED ONE**, which is the check that says the
grade can actually see what the metric measures. A three-song `run_align`/`truth` spot run
(`_runs/w8a-seeband-spot`, the shipped default, 50 s) against `results/w8a-band-run_align.json`:

| song | trail's `as_claimed` lag / spread (no truth) | harness `bias_ms` / `mad_ms` (against truth) | demoted? |
| ---- | ------------------------------------------: | -------------------------------------------: | -------- |
| bad-guy | **+0.87 s / 0.11 s** | **+868.5 ms / 111.5 ms** | no — envelope abstains at r 0.19 |
| numb | **+0.69 s / 0.14 s** | **+690.0 ms / 140.0 ms** | no — envelope reads the sheet as displaced |
| never-be-alone | **+0.00 s / 0.03 s** | **+0.0 ms / 30.0 ms** | no — nothing to confirm |

The two columns are the same numbers reached by independent routes: in `truth` mode the served claims ARE the
truth, so the worker reading the published document against its own served sheet must agree with the harness
reading it against the reference — and it does, to the millisecond, on a song whose ±500 is 3.12%. **All nine
per-song figures, the `doc` sha256 and the `onsets` sha256 of all three songs are IDENTICAL to the baseline**,
so not one byte of a published document moved and not one grade changed: the conjunction stood down on real
audio exactly where it was predicted to, including on `never-be-alone`, whose envelope lag is the −0.80 s at
r 0.77 false positive.

## W8a: the late half of the band, and the end that witnesses it (2026-10-03)

Task 1 found two mechanisms behind the 0.5-2 s band and only one of them ours: on four songs the bench's own
truth precedes the singing, and on `Kinematic_-_Peyote` a window re-decode opens 0.76-0.96 s LATE. This is the
fix for the second, and the measurement that keeps it off the first. `time_text`, `truth` mode, the warm
emission store (`band_probe.py --emitter 1a2fd6852bd30243`, **22 disk reads, 0 recomputes**), 14 songs chosen
as 4 targets + 4 displaced sheets + 6 controls: traces under `_runs/w8a-fix3-truth/`.

### The shape of the band, once the four displaced songs are set aside

28 songs, 1526 scored lines, **44 band lines**. By sign: **35 are EARLY** (0.53-0.96 s) and 9 are late. By
stage: 25 the blind decode's own, 18 R2's, 1 R4's. 31 of the 44 published starts sit inside the PREVIOUS
truth line's span, against 24.5 % of the 1455 lines that are not band lines — so the early population is a
line opening during its predecessor's singing, and most of it (rap-god 11, shape-of-you 5) is on sheets whose
cues are contiguous, where nothing but the audio can say which of two adjacent lines a frame belongs to.

**THE LATE HALF IS THE ONE WITH A WITNESS, and the ear agrees it is the urgent one** (ITU-R BT.1359: a late
highlight is noticed at ~45 ms, an early one at ~125 ms). A line's opening placed EARLY cannot be told from
its predecessor's audio by any reading we have; a line's opening placed LATE leaves the cue's own front
unaccounted for, and the cue's END says whether that front is missing or whether the whole cue is displaced.

### Two witnesses that were measured and REJECTED

Both were implemented and read on the real matrices before the third was tried (`lead_mass.py`).

| witness, over [claim onset, decoded onset) | `Kinematic` (claim = truth) | bad-guy (sheet 0.86 s early) |
| ------------------------------------------ | --------------------------: | ---------------------------: |
| `_speech_mass`, the acoustic model's non-blank mass | 0.014-0.061, floor 0.175 — **all 4 fail** | 0.15-0.39 — **25 of 45 pass** |
| the stem's own RMS envelope, mean level | 0.77-0.92 | 0.08-0.62, 20 of 45 over 0.10 |

Both read EXACTLY BACKWARDS. CTC is peaky, so a held vowel is one spike and blanks: the model hears almost
nothing over the 0.8 s of "oh oh" that `Kinematic`'s captions open on. And bad-guy's stem carries breath,
bleed and backing before every entry, so the model hears "speech" 0.86 s before the singing starts. A rule
built on either would have refused the four lines it exists for and pulled 25 correct bad-guy lines back onto
a sheet the audio says is early — scoring +25 at ±500 for publishing the error. This is why the lead is not
read at all.

### The witness that works: the END, scaled by the document's own agreeing lines

A decoded end is the model's **last confident frame**, which is why `extend_ends` exists; on `Kinematic` the
ten lines whose openings are right end **0.156-0.714 s inside** their cue ends (median −0.303). So the raw
difference "decoded end − cue end" is not a reading. The reference is the document's own: the median of that
difference over the lines whose OPENINGS the blind decode already agrees with (within `AGREE_TOLERANCE_SEC`,
raw, no fit), requiring `rc.MIN_FITTED_PAIRS` of them. Then a re-decode is re-opened at its claim's onset when

1. the cue carries an **end of its own** (`claim_windows` defaults a missing end to `start + 1.0 s`, and that
   default is arithmetic, not evidence),
2. the decode opened **more than `AGREE_TOLERANCE_SEC` past** the claim's onset,
3. its end sits **within `AGREE_TOLERANCE_SEC` of `end_bias`** — the two series disagree about the opening and
   nothing else, and
4. the envelope does not say the whole sheet is displaced (`reconcile.off_sheet`'s second witness, read in the
   step: `|claim_lag| <= AGREE_TOLERANCE_SEC` or a correlation under `claimmap.MIN_ENVELOPE_CORRELATION`).

**No new constant.** The displaced sheet is refused three times over: it has no agreeing openings to build the
reference from, its ends disagree by the same lag as its openings, and its envelope lag names it outright.

| song | agreeing openings | `end_bias` | candidates | re-opened |
| ---- | ----------------: | ---------: | ---------: | --------: |
| `Kinematic_-_Peyote` | 10 of 14 | −0.303 s | 4 | **3** ([12]'s end is 0.93 s short too, so it stands) |
| bad-guy | **0** of 69 | — (no reference) | 69 | 0 |
| numb / believer / tfr-chosen | few, and the envelope reads +0.62 / +0.36 / +0.46 at r 0.69 / 0.46 / 0.60 | — | 24 / 65 / 22 | 0 |

### What it moved, and what it did not

`truth`, 14 songs, 907 scored lines. **±500 752 → 755**, gross **0 → 0**, not one confidence changed, and
every one of the six already-perfect songs in the set stayed perfect.

| song | ±500 | lines re-opened | error before → after |
| ---- | ---- | --------------: | -------------------- |
| `Kinematic_-_Peyote` | 10/14 → **13/14** | 3 | [5] +0.784 → 0.000, [11] +0.909 → 0.000, [13] +0.960 → 0.000 |
| bohemian-rhapsody | 69/72 (held) | 3 | [25] +0.330 → +0.004, [67] +0.370 → −0.072, [68] +0.290 → −0.074 (MAD 0.070 → 0.061) |
| `Avercage_-_Embers` | 39/42 (held) | 1 | [13] +0.356 → 0.000 (MAD 0.0347 → 0.0337) |
| `Lower_Loveday_-_Is_It_Right_` | 25/26 (held) | 1 | MAD 0.0501 → 0.0464 |
| bad-guy, numb, believer, tfr-chosen | 2/69, 19/35, 51/72, 23/33 — ALL UNCHANGED | 0 | not a start moved on any of the four |
| HILA, hello, tfr-mayday, never-be-alone, rap-god, shape-of-you | unchanged | 0 | — |

Eight lines moved in all, seven of them from 0.29-0.96 s late to within 75 ms. **THE FOUR DISPLACED SHEETS
MOVED NOTHING**, which is the rule's reject-if: an earlier draft of this witness, reading the decoded end
against the cue end with no `end_bias`, recovered 1 line on `Kinematic` and leaked +1 on believer; the draft
with `end_bias` but no envelope guard recovered 3 and leaked +1 on tfr-chosen. The shipped conjunction
recovers 3 and leaks 0.

### Why the remedy re-opens the line instead of adopting the claim

`adopted_line` was the obvious reuse — the ladder already surrenders to a claim where the decode heard
nothing. It is the wrong remedy here, and the corpus says so: an adopted span carries **no word scores** and
every word is flagged interpolated, so the bench counts those words as `interpolated` rather than `aligned`
and the committed gate `w7-jamendo-word-aligned-not-down` would have read the fix as a loss of ~60 Jamendo
words. `generate.reopened_line` moves the line's start, its first word's start and that word's first
syllable, and nothing else: every other word keeps the onset, the score and the provenance the decode
measured for it, and the first word covers the sustained vowel it is actually singing.

### The published level agrees, and numb says something new

The numbers above are `time_text`. At `run_align` — the level the gate files score, three songs, warm store —
`Kinematic_-_Peyote` reads **13 of 14 against the baseline's 10**, bad-guy 2 of 64 and numb 7 of 35, both
unchanged. So the fix carries to the published document and the two displaced sheets are untouched there too.

numb is worth a sentence, because the same song reads **19 of 35 at `time_text` and 7 of 35 at `run_align`**
on the same 35 scored lines, and nothing in this wave explains the other 12. At `time_text` its claim clock
votes `envelope-lag` and the document comes out at median **+0.47 s** / MAD 0.24 graded `medium`; at
`run_align` the clock votes `decode-median`, the document comes out at **+0.69** / MAD 0.14 and grades `high`.
A different clock candidate wins, so the step is being handed a different sheet by the workflow than the bench
hands it directly. That gap is 12 of the 163 lines `truth` misses and is where numb's 20.00% comes from.

## W8a: what the corpus said about the two band components (2026-10-03)

> **THE ARMS' OWN ROWS BELOW WERE RE-PRICED AFTER THE ROUND-2 REVIEW** — "W8a round 2: the two arms re-priced
> on the full corpus", which holds the current readings (`results/w8a-r2-arms-*.json`). The three runs of the
> DEFAULT tree recorded here stand: a default-knob spot run on the round-2 tree reproduces
> `results/w8a-run_align.cases.jsonl` on every column.

The wave built two things that move a published document and measured each on a SUBSET — task 2's grade on a
re-summary of W7's own rows plus a 3-song spot run, task 3's repair on 14 songs at `truth` and 5 at `jit`.
This is the full sweep: **three runs, 32 songs x 16 modes, 1088 cases each, at `--level time_text`,
`--level run_align` and `--level run_align --sync-mode lines`**, against W7's own rows re-summarised on this
harness (`results/w8a-base-time_text.json`, `results/w8a-band-run_align.json`,
`results/w8a-base-lines-run_align.json`, each verified identical to its `w7-*.json` on every pre-existing
metric, pooled and per song).

**COST, paid once.** The emission store was COLD for this tree (emitter `68a5c0c5596d54db`; `align_config` is
`{}` and neither band component is in the emitter's import closure, so the key is W7c's, not this wave's). The
`time_text` sweep **computed 58 matrices** and read 5 from disk, 1419 s total with 341 s of it in `truth`; the
`run_align` sweep then read **60 from disk and computed 0** (1004 s) and the `lines` sweep **32 from disk, 0
computed** (865 s). Total 3288 s of wall time for 3264 cases, with every matrix paid for exactly once.

**BOTH COMPONENTS FAILED `gates/w8a.yaml`, at BOTH levels, on the same three rules** (151/154; readings in
`results/w8a-arms-time_text.json` and `results/w8a-arms-run_align.json`), so each now ships behind its own
`ENCORE_ALIGN_EXPERIMENTS` name, default off. The default tree was then re-swept, all three runs, and is
**byte-identical to W7**: 3264 cases match `results/w7-{time_text,run_align,lines-run_align}.json` row for row
on `doc_sha256`, `onsets_sha256`, `confidence`, `w500`, `gross`, `high` and `high_bad` — **0 differ**.
`gates/w8a-default.yaml` 103/103 at both forced levels, `gates/w8a-lines.yaml` 99/99, and task 2's own
`gates/w8a-band.yaml` 83/83 (`results/w8a-{time_text,run_align,lines-run_align}.json`). Against the arms-on
tree the authors' own files read `gates/w8a-fix.yaml` **86/88** — `band-down-truth` PASSES, so the repair does
what task 3 said, and the two rules it fails are task 3's own `no-song-loses-jit` and
`word-pm300-not-down-jit`.

**Every count in the paragraph above is re-read on the files as the REVIEW left them, which is why it differs
from the `baseline` string inside each `results/*.json`.** Those strings are the bench runner's own record of
what it read on the day (`w8a.yaml` **136/139**, `w8a-band.yaml` **69/69**, `w8a-lines.yaml` **86/86**,
`w8a-fix.yaml` **57/59**, `w8a-default.yaml` 103/103) and they stay as written. The review then added, against
the same recorded rows: a `band-missing-not-up-MODE` denominator rule beside every `band` rule in all four band
files (review r1-correctness-8 / r1-spec-13 / r1-tests-20), and a `no-song-loses-MODE` in `w8a-fix.yaml` for
every right-text mode but `drop50` (r1-correctness-7). After round 1 the files carried **153, 82, 98, 87 and 102** rules,
and **every rule the review added PASSES on these same rows** at both levels and at the `lines` rung — not one
verdict above changed sign, only the denominator did. (Round 2 added 28 rules to `w8a-band.yaml` and 6 to
`w8a-fix.yaml`, for **153, 110, 98, 93 and 102**; all of them read green against the same recorded rows except
`w8a-fix.yaml`'s own `band-down-truth`, which asks the band to fall. See "W8a round 2: the two readings the
coherence grade was missing".) `w8a-default.yaml` was not touched: its band rules are
equalities, which catch a falling denominator already.

| gate | reading | which component |
| ---- | ------- | --------------- |
| `no-song-loses-jit` | `min_song_delta` **−2.17** | `band-reopen` |
| `word-pm300-not-down-jit` | Jamendo word ±300 **95.86 → 95.79** | `band-reopen` |
| `demotion-removes-only-bad-high-offm1` | **23 `high` lines lost, 0 of them wrong** | `band-off-sheet` |

### `band-reopen`: +8 lines over six modes, and one leak a jittered sheet buys

> **THIS TABLE IS THE ARM WITHOUT THE REVIEW'S `opening_is_free` GUARD. IT HAS SINCE BEEN RE-MEASURED** —
> "W8a round 1: the `band-reopen` arm, re-read with the free-time guard", which holds the guarded reading and
> the correction to this section's own "+8 lines". The guard refuses a re-opening onto the previous published
> line's own span (review r1-correctness-1), and on the corpus it refuses 20 of the arm's 56 line moves at
> `run_align` and 51 of 75 at `time_text` — including the leak named below, which is why the arm's two
> rejecting gate rules now pass, and including `tfr-chosen`'s one win, which it loses. Every row below still
> reads as measured on the unguarded tree. The DEFAULT path is unaffected — the arm is off, and the re-read
> MEASURED it so — and `results/w8a-{time_text,run_align,lines-run_align}.json` stand.

What it won, per song, identical at both levels except where noted:

| mode | song | ±500 before → after |
| ---- | ---- | ------------------- |
| truth | `Kinematic_-_Peyote` | 71.43 → **92.86** (10 → 13 of 14) |
| jit | `Kinematic_-_Peyote` | 64.29 → **78.57** |
| drop20 | `Kinematic_-_Peyote` | 72.73 → **90.91** |
| extraverse | `Kinematic_-_Peyote` | 57.14 → **78.57** |
| headers | `Kinematic_-_Peyote` | 71.43 → **92.86** (85.71 at `time_text`) |
| credit | `Kinematic_-_Peyote` | 57.14 → **71.43** |
| off05 | tfr-chosen | 75.00 → **78.12** (69.70 → 72.73 at `time_text`) |

Pooled, at `run_align`: `truth` ±500 **90.45 → 90.63**, `extraverse` 90.80 → 90.98, `headers` 90.51 → 90.69,
`drop20` 90.31 → 90.46, `jit` 87.17 → 87.23; `band` falls in **seven** modes (truth −3, extraverse −3,
headers −3, credit −2, drop20 −2, jit −1, off05 −1) and rises in NONE; `gross` is unchanged in every mode and
0 in eleven of the fourteen; the four displaced sheets move **not one start** (bad-guy 2/64, numb 7/35,
believer 51/72, tfr-chosen 24/32 at `truth`). Wrong-text protection is untouched: 0/320 `wrongtext`, 0/320
`wrongtext+ownclock`, nothing published, nothing scored.

**THE LEAK, named.** `Explosive_Ear_Candy_-_Like_The_Sun` at `jit` goes **91.30 → 89.13** (46 scored lines, one
lost). Three of its lines are pulled onto their claims and all three move EARLIER: line 12 from −0.015 s to
−0.332, line 45 from −0.073 to −0.395, and line 15 from −0.064 to **−0.812** — out of ±500 and into the band.
Every one of them was already graded `low`, so nothing was promoted on the way out.

The mechanism is the one thing the rule's guards cannot see. `skipped_opening` requires the document's
STRUCTURE to corroborate: at least `rc.MIN_FITTED_PAIRS` agreeing openings to build `end_bias` from, the cue's
own written end within `rc.AGREE_TOLERANCE_SEC` of it, and `off_sheet`'s envelope witness not calling the whole
sheet displaced. **All three survive per-line jitter**, because a jittered line's start and end move TOGETHER
and the median over agreeing lines is robust to a few noisy ones. So a sheet that is noisy rather than
displaced passes every guard, and the claim the rule re-opens onto is itself 0.8 s wrong. `jit` is that sheet;
so is any provider whose per-line timings are hand-typed.

What a fix would need: a reading of the single line's claim, not the document's. `Reconciliation.disputed` is
the nearest existing one and does not reach — `COARSE_TOLERANCE_SEC` is 1.0 s and this claim sits 0.75 s out.

### `band-off-sheet`: one true positive, one false one, and no way to tell them apart

The demotion fires **twice** on the corpus, in two modes neither its own gate file nor task 2's 3-song spot run
covered (`gates/w8a-band.yaml` §4 gates `truth`, `blind`, `jit`, `off3`, `drop20`, `extraverse` — not `off05`
and not `offm1`).

| mode | song | `high` lines removed | how many were more than 500 ms from truth | verdict |
| ---- | ---- | -------------------- | ---------------------------------------- | ------- |
| off05 | bad-guy | **49** (`run_align`) | **49** | the rule doing its job |
| offm1 | never-be-alone | **23** (both levels) | **0** | a correct document demoted |

`bad-guy` at `off05` is the case the wave was chartered to catch: the served sheet is 0.5 s late, which puts it
near where that song actually sings (its captions precede its own singing by +1.007 s), so the envelope
confirms the sheet, the claims convict the document, and 49 `high` lines that really are wrong stop claiming to
be right. `high_bad` falls 49 and `high` falls 49 — every line it took was a bad one.

`never-be-alone` at `offm1` is the same conjunction closing on a right answer and still being wrong. Its trail
says it exactly: *"OFF ITS SHEET by +1.03 s coherently (spread 0.02 s over 46 paired lines) while the audio
puts the singing +0.18 s from those same claims"*. Both clauses are true. The first is true because the sheet
was deliberately shifted −1 s and the claim clock correctly mapped it back. The second is true only because
**that song's envelope lag is 0.80 s out** — W8a task 1 measured it at **−0.80 s at r 0.77** against its own
unperturbed sheet and recorded it as the arbiter's large false positive. Shift the sheet by −1 s and the false
reading lands at +0.18 s, inside `AGREE_TOLERANCE_SEC`, so the envelope "absolves" a sheet that is genuinely
displaced. ±500 does not move (43 of 46 both before and after); the document simply loses its word wipe.

**So the design claim the corpus refutes is "each witness covers the other's false positives".** It holds only
where the perturbation does not land on a witness's own error. `offm1` is a 1.0 s perturbation and the
envelope's error on that song is 0.8 s, so it lands. Any arm flipping this on needs a third reading, or an
envelope whose per-song error is bounded — 20 Jamendo songs read |lag| ≤ 0.078 s, which is why the floor looked
safe, and one YouTube song reads 0.80.

### A defect in the harness the sweep found on its way

`e2e_gates._cell` formatted a delta as `"+" + spec`, and W8a task 2 had added the first column whose spec
already carries a sign (`bias_ms`, `+.0f`). `format(x, "++.0f")` raises, so the FIRST real comparison after the
metric landed died with `Invalid format specifier` and printed **no gate verdicts at all** — after 1419 s of
sweep. Run against itself every delta is `=` and the branch never executes, which is exactly why task 2's
69/69 could not see it. Fixed, with `test_a_signed_column_prints_its_delta_instead_of_taking_the_comparison_down`
as the regression.

## W8a: what the LINE_SYNC rung says about the claim clock (2026-10-03)

`--level run_align --sync-mode lines` turns out to be the sharpest instrument in the wave, and the signed band
metrics are what made it readable. At that rung the published document **is** the served sheet: no decode, no
repair, no window. So (published − truth) is **the claim clock's shift and nothing else**, and `mad_ms` says
whether the shift was rigid. Both arms are unreachable there (`gates/w8a-lines.yaml` 99/99, not one document
byte moved in any mode, 865 s), so the readings below are W7's behaviour, newly visible.

**In `truth`, where the served sheet IS the truth, the clock moves exactly two songs — rigidly.**

| song | `bias_ms` | `mad_ms` | ±500 |
| ---- | --------- | -------- | ---- |
| bad-guy | **+720.0** | **0.0** | 0.00 % (0 of 65) |
| numb | **+620.0** | **0.0** | 0.00 % (0 of 35) |
| the other 30 | 0.0 | 0.0 | 100 % |

Every one of bad-guy's 65 lines and numb's 35 moves by ONE constant with zero spread. `headers` reads the same
two, `extraverse` and `drop20` only bad-guy (+720, +780). numb's +620 is exactly the `envelope-lag` candidate
task 1 measured for that song (+0.620 at r 0.69), so the clock's vote is legible in the metric. This is the
"systematic per-song offset" the wave was opened on, isolated to one stage: and by task 1's three arbiters it is
a move TOWARD the singing, so the clock is acoustically right and metrically wrong on exactly those two songs.

**And the mirror, which is why ±500 can never be the gate alone again.** In `off05` the served sheet is 0.5 s
late, the rung publishes it verbatim, and ±500 scores **99.88 %** — the best pooled ±500 of any mode in this
build — on a corpus uniformly half a second late (`bias_ms` +500.0 at MAD 0.0 across 29 songs; ±500 counts an
error of exactly 0.500 s as inside). ITU-R BT.1359 puts a noticed late highlight at ~45 ms.
`gates/w8a-lines.yaml` keeps BOTH readings as rules on purpose — `off05-displacement-is-seen` and
`off05-pm500-is-blind-to-it` — because deleting the second deletes the argument for the first.

At larger perturbations the clock does correct, and what is left is its own per-song shift: at `off15` and
`off3`, 26 songs read nonzero with bad-guy +760, numb +640, tfr-chosen +380, believer +360.5, hello +180,
feel-my-heart −200, all at MAD 0.0.

## W8a review: the three bench priorities, re-read on rows already on disk (2026-10-03)

Three items were handed to the review ahead of the findings, as the wave's biggest problems. All three are
answered by rows already in `results/` — **0 model seconds, no sweep** — and two of the three are answered the
other way round from how they were posed.

### (1) The frame clock did not put gross lines up in the offset and tempo modes

Pooled `gross` at `time_text`, read straight off the recorded rows:

| mode | W2 (pre-clock) | W4 (the clock) | W7 | W8a default |
| ---- | -------------- | -------------- | -- | ----------- |
| off3 | 28 | 3 | **0** | **0** |
| tempo098 | 27 | 4 | **0** | **0** |
| tempo102 | 28 | 4 | **0** | **0** |
| drop50 | 300 | 305 | 167 | 167 |

The clock took those three modes down by an order of magnitude and they are at zero now. `drop50` is the one
mode that rose at all (+5) and it has since more than halved. The "28 → 47" shape is `line_gate.placements`'
gross column, which W2's own review found was not keyed to the placement it printed and restated as **47 → 0**.

**And `gates/w2.yaml` is green at `time_text`.** Its 88 rules, read with `results/w8a-base-time_text.json` as
the run and its own documented rebase target `results/w6-hubert-time_text.json` as the base: **89/89 PASS**
(`results/w7-time_text.json` reads the same, and the file against itself reads 89/89 as a ratchet must). The
"83/85 → 50/85" fall was a ratchet read against a STALE BASE — a default-on clock swap replaces every emission
matrix, so every `base.` delta in that file stopped measuring the wave it was pointed at and started measuring
the clock. The remedy is the one the file already records twice, applied by W4b and again by W5: move the
`--compare` base, never re-price the allowance.

**At `run_align` it is NOT green, and the cause is ONE SONG rather than the clock.** The same file on
`results/w7-run_align.json` against `results/w6-hubert-run_align.json` reads **69/89**, and 12 of the 20 red
rules are `no-worse-displacement-MODE` — every one of them selected by `numb` alone (`text_pm500` delta −34.29
at `truth`, −40.00 at `jit`, −42.86 at `credit`; the next worst song is −13.51). `numb`'s `text_pm500` at
`truth` reads **54.29 at W6 `run_align`**, **54.29 at W7 `time_text`** and **20.00 at W7 `run_align`** — the
same 35 lines, so a W7 change moved that song on the WORKFLOW path only. That is precisely the lead W8a task 3
left ("a different candidate wins because the workflow hands the step a different sheet than the bench hands it
directly"). It is worth 12 lines at `truth` and 20 of 89 W2 gates, it is not the frame clock, and it needs its
own wave with a re-bench.

### (2) The clock's Jamendo cost was paid back, and then some

`truth`, pooled over the 20 hand-measured Jamendo songs:

| row | lines ±500 | words ±300 | words ±100 | word AAE |
| --- | ---------- | ---------- | ---------- | -------- |
| W2 (pre-clock) | 97.34 | 95.16 | 82.37 | 104.8 ms |
| W4 (the clock) | 96.42 | 94.98 | 83.25 | 87.8 ms |
| W4b HuBERT-L | 97.69 | 97.12 | 85.38 | 72.3 ms |
| W7 / W8a default | **98.15** | **97.16** | **85.46** | **71.1 ms** |

The two figures the priority names are **+0.81 pt and +2.00 pt ABOVE their pre-clock values** on the shipped
tree. Of the two songs the clock took more than a point off at word ±300, one is fully recovered —
`The.madpix.project_-_One_Way_Street` 94.87 → 92.07 → **96.72**, its line ±500 96.67 → 90.00 → **100.00** — and
one is not: `Tom_Orlando_-_The_One__feat._Tina_G_` 99.46 → 96.81 → **95.29**, still −4.17 pt of word ±300 below
pre-clock while its line ±500 is back at 100.00. That single per-song WORD residue, on a song whose lines are
perfect, is all that is left of this item.

### (3) The stemless recommendation is already the default

On a mix target the lexical lift's floor (0.15) is the verdict, not the envelope gate: `align_steps`'
`mix_floor_gates` is true unless an arm says otherwise. W3's envelope-only behaviour is the control arm
`h3-mix-envelope`, `h3-mix-floor` means both gates, and `h3-mix-lift-alone` was retired because its behaviour
BECAME the default — the flip happened in W4's review r1 and was re-recorded under the shipped names in r2. The
40 % wrong-text pass rate the priority quotes is therefore the measurement of the ARM, not of the shipped path:
27 of 64 wrong texts passed under `h3-mix-envelope` against **0** under the floor that ships. See "The stemless
mode: what the mix path really does" above, including the floor's own confirmed cost (37 of 128 right texts).

## W8a round 1: the `band-reopen` arm, re-read with the free-time guard (2026-10-03)

> **READ WITH "W8a round 2: the two arms re-priced on the full corpus"**, which re-measures this guard on 1088
> cases after round 2 made it read free time off the batch being built. Two readings below change there: the
> `tfr-chosen` `off05` win this section records as refused is RE-ADMITTED, and the -4/-3 word budgets measured
> here on 182 cases are one word short on the full corpus.

The review added a conjunct to `align_steps.skipped_opening` — `opening_is_free`, which refuses a re-opening
onto the previous published line's own span, because `_clamped_v2` resolves such a start by RESCALING every
measured word onset in the line (r1-correctness-1) — and a second change inside `generate.reopened_line`: the
re-opened first word's onset is the SHEET'S, so it is now marked `CUE_OPENED` and scores 0.0. Neither can reach
the default path (`late = not unheard and "band-reopen" in experiments and skipped_opening(...)` short-circuits
on the knob), so what was owed was a re-read of the ARM. This is it, at both forced levels.

**THE DEFAULT PATH IS MEASURED, NOT ARGUED.** A control run of the review's tree with no knob set is identical
to the recorded sweep on all 182 shared cases over 20 identity columns — `doc_sha256`, `onsets_sha256`,
`confidence`, `w500`, `band`, `gross`, `high`, `high_bad`, the per-line errors and nine more — at `run_align`
against `results/w8a-run_align.json` and at `time_text` against `results/w8a-time_text.json`. **0 differ.**
So `results/w8a-{time_text,run_align,lines-run_align}.json` and every gate reading against them stand.
(`_review-scratch/w8a-r1-reopen/strict_identity.py`; rows `results/w8a-r1-ctl-{run_align,time_text}.json`.)

**WHY 14 SONGS x 13 MODES IS A COMPLETE READING OF THE ARM, not a sample.** `opening_is_free` is a conjunct, so
the guarded rule re-opens a SUBSET of what the unguarded one did and no case can start differing from the
default because of it. Over the recorded full corpus — 1088 cases, `_runs/w8a-ra` against `_runs/w8a-def-ra` —
the unguarded arm changed a document in exactly **35** cases at `run_align` and **41** at `time_text`, and every
one of them falls inside those 14 songs and 13 modes. The two further cases the full-corpus diff shows
(`bad-guy` `off05`, `never-be-alone` `offm1`, grade-only, onsets byte-identical) are the OTHER arm's,
`band-off-sheet`, and both songs are in the selection anyway. `blind`, `wrongtext` and `wrongtext+ownclock` hold
no move at either level, which is the reason they are not in the 13.

**COST.** The knob is in the emitter fingerprint by design (`e2e.emitter_fingerprint`), so the arm's first run
recomputed **26 matrices** (643 s for 182 cases at `run_align`); the `time_text` arm run then read 26 from disk
and computed 2 (341 s), and the two controls computed 0 (507 s and 330 s). **1821 s of wall time, 26 matrices,
no corpus sweep.**

### What the guard refuses, and what it costs

| | `run_align` | `time_text` |
| - | ----------- | ----------- |
| line moves the unguarded arm made | 56 | 75 |
| of those, KEPT | **36** | **24** |
| of those, REFUSED (back to the default, byte for byte) | **20** | **51** |
| cases whose document differs from the default | 35 → **22** | 41 → **15** |
| ±500 lines gained / lost | +16 / −1 → **+15 / −0** | +15 / −1 → **+14 / −0** |
| `band` lines | −15 → **−15** | −14 → **−14** |
| `gross`, every mode | 0 → **0** | 0 → **0** |

Refusals and keeps by song (`run_align`, with `time_text` where it differs):

| song | kept | refused | what the refused move was |
| ---- | ---- | ------- | ------------------------- |
| `Kinematic_-_Peyote` | 15 (14) | 0 | — the arm's whole headline survives |
| `bohemian-rhapsody` | 9 (0) | 0 (29) | at `time_text` every one of its 29 moves is refused |
| `Lower_Loveday_-_Is_It_Right_` | 6 (5) | 0 | — |
| `Explosive_Ear_Candy_-_Like_The_Sun` | 2 | 1 | **[15] at `jit`, THE LEAK** |
| `Avercage_-_Embers` | 1 | 4 | [13] +0.356 → 0.000, kept only at `drop20` |
| `HILA_-_Give_Me_the_Same`, `Quentin_Hannappe_-_Keep_On`, `feel-my-heart` | 1 each | 0 | — |
| `rap-god` | 0 | 12 (13) | [184] and [214] in six modes, 0.26–0.28 s pulls |
| `tfr-chosen` | 0 | 1 | **[26] at `off05`, A WIN LOST** |
| `Ridgway_-_Fire_Inside`, `tfr-flyaway` | 0 | 1 each | [5] at `jit`, [67] at `drop20` |

**THE ARM'S TWO REJECTING RULES NOW PASS.** `no-song-loses-jit` reads `min_song_delta` **0** where it read
−2.17, because `Explosive_Ear_Candy_-_Like_The_Sun` [15] — the one line the unguarded arm pushed out of ±500,
−0.064 s to −0.812 — is exactly a re-opening onto its predecessor's span, and the guard refuses it. That song
returns to 42 of 46 at `jit` and its `band` stops rising. `word-pm300-not-down-jit` reads **93.85 ≥ 93.74** on
this selection, up where it fell. The price is `tfr-chosen` [26] at `off05`, a 0.36 s pull the guard also
refuses: that song's single gain is gone, which is the right direction anyway on a sheet whose truth precedes
its own singing. `bohemian-rhapsody`'s level split is the same mechanism read twice — at `run_align` its
published document is R4's mix repair, whose predecessors end earlier, so the same openings are free there and
occupied at `time_text`.

`gates/w8a-r1-reopen.yaml` (125 rules, written for this re-read) reads **125/125 PASS at BOTH levels**, with the
control as its base. The two older files read on the same rows:

| file | reading on the subset | what the non-passing rules are |
| ---- | --------------------- | ------------------------------ |
| `gates/w8a-fix.yaml` | 71/88, 12 ERROR, 5 FAIL | ERRORs are `blind`, absent from the subset; 3 FAILs are `perfect-songs-held-*`, absolute counts over 32 songs; 2 are `word-aligned-not-down-*` |
| `gates/w8a.yaml` | 116/154, 20 ERROR, 18 FAIL | same shape: 12 `perfect-songs-held-*`, 4 absolute Jamendo word/highlight thresholds **the CONTROL fails identically** (±100 80.89, ±300 95.87, AAE 83.1 ms, highlight 79.8 on 7 Jamendo songs), 2 `word-aligned-not-down-*` |

### The second review change has a price, and it is in the word accounting

A `CUE_OPENED` word is paired but NOT aligned, so it leaves `word_aligned` and enters `word_interpolated`.
Measured: `word_aligned` falls **4** at `truth`, **6** at `jit`, **4** at `drop20` / `extraverse` / `headers`,
**3** at `credit` and is unchanged in the other seven modes — exactly one word per re-opened Jamendo line, never
two. That makes `gates/w8a-fix.yaml` §5's `word-aligned-not-down-*` red BY CONSTRUCTION: it was written on the
claim that `reopened_line` "leaves every word's onset, score and provenance alone", which the review deliberately
stopped being true. The rules that matter are green and better than green — against the control, word ±100 rises
80.89 → **81.11**, ±300 95.87 → **96.06**, AAE 83.1 → **81.3 ms**, highlight 79.80 → **80.09** — so the arm pays
4 declared onsets and buys word accuracy with them. `gates/w8a-r1-reopen.yaml` §5 states it as the accounting
invariant instead: `word_aligned + word_interpolated` is unchanged in every mode, and the fall is bounded by the
re-opening count. `e2e_lib` gained the one flat name that rule needs (`word_interpolated`).

### The recorded reach figure, corrected

`gates/w8a-default.yaml`'s header and `docs/arch/04-alignment.md` §14 priced the arm at "+8 lines, −1". The 8 is
task 3's own pre-sweep reading — **8 lines MOVED** on 14 songs at `truth` — and it was carried into the corpus
row as if it were the ±500 gain. The corpus numbers are above: the unguarded arm moved **56** lines at
`run_align` (75 at `time_text`) for **+16 / −1** at ±500; the guarded arm moves **36** for **+15 / −0**.

**THE ARM STAYS DEFAULT-OFF.** Its rejection reason is gone on the 182 cases that contain every move it makes,
which is a strong reading and not a licence: the absolute gates cannot be read on a 14-song selection, and
`blind` and the wrong-text modes were not run. Flipping it needs a full 32-song x 16-mode sweep at both levels
against `results/w8a-{time_text,run_align}.json` with `gates/w8a.yaml`, plus the `lines` rung for form (the arm
cannot fire there — nothing is re-decoded).

## W8a round 2: the two readings the coherence grade was missing (2026-10-03)

Both sections below are measured on rows already on disk — `_runs/w8a-def-ra/rows.jsonl` (the shipped default,
1088 cases) and `results/w8a-band-run_align.json` — at **0 model seconds**. Neither moves a published timing:
`off_sheet`'s demotion is behind `band-off-sheet` and off by default, so what changes is which readings the
default path REPORTS and what the arm would convict if it were flipped on.

### W8a: the share a coherent lag has to carry

`off_sheet`'s coherence conjunct was a median and a MAD, and a MAD is robust — which is exactly why it cannot
carry this alone. Eleven lines 0.9 s late against nine EXACTLY on their claims reads `offset_sec` +0.90 with
`spread_sec` **0.00**, maximally coherent, on a population that is 45 % correct; convicting it demotes every line
of the document to `low` and turns the room's word wipe off. `AsClaimed.together` — the share of residuals within
`AGREE_TOLERANCE_SEC` of the median lag — is the conjunct that refuses it, at `MIN_COHERENT_SHARE`.

THE FLOOR IS MEASURED, not chosen. `together` is invariant under a constant displacement of the claims, so it can
be computed exactly for `truth` and the four pure-offset modes from each row's own signed line errors (160 cases,
every one of them coherent by the MAD test):

| reading | `together` |
| ------- | ---------- |
| smallest in the whole population (`numb`, 25 of 35 lines) | **0.714** |
| next smallest (`tfr-chosen`, 23 of 32) | 0.719 |
| 10th percentile | 0.831 |
| median | 0.942 |
| `bad-guy` (+868.5 ms, MAD 111.5) | 0.906 |
| `believer` (+370.0, MAD 87.0) | 0.931 |

`MIN_COHERENT_SHARE` is **0.70**: under every true reading the corpus has, above the half-and-half population the
conjunct exists to refuse, and the same number as `rc.COARSE_FLOOR`. The two songs at 0.714 and 0.719 are 1.4 and
1.9 points of slack, which is the measurement and not a comfort — a wave that re-anchors those four songs' truth
should re-read this table.

WHAT IT DOES NOT BUY: the corpus's one false positive is untouched. `never-be-alone` at `offm1` reads `together`
**0.935** — its lines really did all move by one lag relative to the sheet it was served — so the share conjunct
does not separate it from `bad-guy` at `off05`. Only the envelope witness can, and it is the witness that failed
there. `band-off-sheet` therefore still ships OFF.

### W8a: when the claims restate the clock

`as_claimed` reads the published document against the claims AS SERVED, before the claim clock. When the clock has
already mapped that sheet, a document that published on the MAPPED sheet sits exactly the map's own displacement
from the sheet as served — so the first witness is restating a decision this pipeline made, and the "two-witness
conjunction" is a ONE-witness rule whose witness is the envelope.

Measured over the shipped default's 1088 cases, by parsing the `against the sheet as served:` and `claims mapped
onto our clock by` clauses of each trail (magnitudes compared, the clock clause printing the sheet's displacement
in `ShiftFit`'s own sign):

| mode | readings | witness 1 convicts | of which the lag IS the clock's own map |
| ---- | -------- | ------------------ | -------------------------------------- |
| truth | 32 | 4 | **4** |
| off05 | 32 | 29 | **29** |
| off15 / off3 / offm1 | 32 each | 32 each | **32 each** |
| jit | 30 | 1 | **1** |
| tempo098 / tempo102 | 32 each | 0 | — |
| headers / credit / extraverse | 32 each | 4 each | **4 each** |
| drop20 | 31 | 3 | **3** |
| drop50 | 26 | 2 | 1 |

So in **156 of the 157** convictions this corpus contains, the claims add no independent witness — including all
four at `truth`, the four displaced songs being exactly the ones the clock moves. `OffSheet.claims_independent`
records it per job and `_sheet_why` prints which of the two sentences applies.

BOTH CANDIDATE FIXES WERE REFUSED BY THIS TABLE. Requiring `not claim_clock.applied`, or requiring the lag to
differ from the map, deletes every conviction the rule has ever made — including `off05`/`bad-guy`'s 49 correctly
removed `high` lines, the only true positive on record. Reading `as_claimed` against the MAPPED claims deletes
them too, the document having published on those. What is left is to say it: the rule keeps its conjunction, and
the record stops claiming two independent witnesses where there is one (review r2-spec-7).

## W8a round 2: the two arms re-priced on the full corpus (2026-10-04)

The round-2 review changed all three rules the arms are made of — `skipped_opening` gained an absolute
`_REOPEN_MAX_SEC` cap and reads free time off the batch being built rather than the document being replaced,
`reopened_line` refuses a line with no other aligned word, and `off_sheet` gained the `MIN_COHERENT_SHARE`
conjunct — so `results/w8a-arms-{time_text,run_align}.json` no longer priced the tree. This is the re-price:
**both arms on (`ENCORE_ALIGN_EXPERIMENTS=band-reopen,band-off-sheet`), 32 songs x 16 modes, 1088 cases, at
`--level run_align`, `--level time_text` and `--level run_align --sync-mode lines`**
(`results/w8a-r2-arms-{run_align,time_text,lines-run_align}.json`), against the same bases round 1 used.

**COST, paid once.** The two arms together are their own emitter key (`align_config` is in the fingerprint by
design), so the `run_align` sweep **computed 60 matrices** (1453.6 s); `time_text` then read all 60 from disk
(1022.1 s, 3 computed) and the `lines` rung read 32 (959.9 s, 0 computed). **3435.6 s of wall time for 3264
cases** — the three runs' own `meta.seconds`, which an earlier draft of this paragraph quoted as 1078 / 3492.
The rows are `_runs/w8ar2-arms-{ra,tt,lines}`, and the default-knob spot run below is `_runs/w8ar2-def-spot`.

**THE ARMS STAY DEFAULT-OFF, on a different rejection than round 1's.** `gates/w8a.yaml` reads **151/154 at
both forced levels** — REJECT:

| rule | reading | which component | round 1 |
| ---- | ------- | --------------- | ------- |
| `demotion-removes-only-bad-high-offm1` | **23 `high` lines lost, 0 of them wrong** | `band-off-sheet` | same |
| `word-aligned-not-down-truth` | 5378 -> **5373** | `band-reopen` | passed |
| `word-aligned-not-down-jit` | 5102 -> **5096** | `band-reopen` | passed |
| `no-song-loses-jit` | **0.00** (was -2.17) | `band-reopen` | FAILED |
| `word-pm300-not-down-jit` | 95.86 -> **95.90** | `band-reopen` | FAILED |

So the free-time guard did what round 1 said it would: the two rules that rejected `band-reopen` now pass. What
rejects it instead is the *provenance* counter — the review's own change, which stops a re-opened line claiming
its rescaled words as measured. `aligned + interpolated` is **identical in every mode** and every accuracy
reading goes the right way:

| mode | `aligned` | `interpolated` | words +-100 | words +-300 | AAE ms | highlight |
| ---- | --------- | -------------- | ----------- | ----------- | ------ | --------- |
| truth | 5378 -> 5373 | 311 -> 316 | 85.46 -> **85.54** | 97.16 -> **97.23** | 71.1 -> **70.6** | 81.40 -> **81.50** |
| jit | 5102 -> 5096 | 587 -> 593 | 83.46 -> 83.48 | 95.86 -> 95.90 | 80.3 -> 80.1 | 77.80 -> 77.85 |
| headers | 5378 -> 5373 | 311 -> 316 | 85.46 -> 85.54 | 97.16 -> 97.23 | 71.1 -> 70.6 | 81.40 -> 81.50 |
| extraverse | 5303 -> 5298 | 380 -> 385 | 85.14 -> 85.22 | 96.76 -> 96.83 | 70.9 -> 70.3 | 80.34 -> 80.45 |
| credit | 5332 -> 5328 | 357 -> 361 | 85.22 -> 85.29 | 96.89 -> 96.94 | 72.9 -> 72.5 | 81.07 -> 81.15 |
| drop20 | 4037 -> 4033 | 518 -> 522 | 83.11 -> 83.19 | 94.70 -> 94.77 | 143.7 -> 143.3 | 77.24 -> 77.34 |
| drop50 | 2172 -> 2171 | 400 -> 401 | 73.02 -> 73.05 | 82.55 -> 82.54 | 711.6 -> 711.8 | 61.87 -> 61.89 |
| off05 / off15 / off3 / offm1 / tempo098 / tempo102 / blind | unchanged | unchanged | unchanged | unchanged | unchanged | unchanged |

### The round-2 arm is a strict subset of the recorded one, case by case

Over all 1088 cases, against the shipped default's own rows: the round-2 arm changes a document in **28 cases
at `run_align` against round 1's 37, and 20 at `time_text` against 42 — with ZERO cases changed that round 1
did not change.** The guards refuse 9 of round 1's moves at `run_align` (`Ridgway_-_Fire_Inside` jit,
`feel-my-heart` jit, `rap-god` at off05/off15/off3/offm1/tempo098/tempo102, `tfr-flyaway` drop20) and 22 at
`time_text` (`bohemian-rhapsody` in eight modes among them).

The 28 split cleanly by mechanism, which is how each failure above is attributed:

| what changed | cases | which arm |
| ------------ | ----- | --------- |
| onsets moved | **26** | `band-reopen` |
| grade only, onsets byte-identical | **2** | `band-off-sheet` |

and the two grade-only cases are the whole of the demotion's corpus effect: `bad-guy` at `off05`, `high`
49 -> 0 with **all 49 of them wrong** (the one true positive), and `never-be-alone` at `offm1`, `high` 23 -> 0
with **none of them wrong** (the false positive `MIN_COHERENT_SHARE` cannot see, `together` 0.935). **At
`time_text` the demotion makes ONLY its false positive** — `bad-guy` `off05` is not demoted there — which is
why `high-held-off05` fails at `run_align` and passes at `time_text`.

### What it buys, and the four songs it still cannot touch

At `truth`, **one song moves**: `Kinematic_-_Peyote` 71.43 -> **92.86** (+21.43, `band` 4 -> 1). All **15
songs at 100% +-500 hold at 100**, pooled `gross` is unchanged in every mode (0 in all 11 right-text modes),
`high` lines past 2 s stay 0, and `missing` is identical mode for mode, so no band reading moved on its
denominator. `band` falls where the re-openings are: 163 -> 160 `truth`, 162 -> 159 `headers`, 158 -> 155
`extraverse`, 165 -> 163 `credit`, 219 -> 217 `jit`, 133 -> 131 `drop20`, 167 -> 166 `off05`.

The four displaced songs read **exactly as they did** — `bad-guy` 3.12 (bias +868.5 ms, MAD 111.5),
`numb` 20.00 (+690.0, 140.0), `tfr-chosen` 75.00 (+390.0, 160.0), `believer` 70.83 (+370.0, 87.0) — and they
are still the only four songs at `truth` whose documents sit coherently off the bench truth, as the diagnosis
said they must be. Pooled `bias_ms` is **0.0 at `truth` and never past -14.9 ms** in any mode, against the
250 ms gate.

### Two round-1 readings this re-price corrects

**`tfr-chosen`'s one win is back.** Round 1 recorded the guard's price as "`tfr-chosen` [26] at `off05`, a
0.36 s pull the guard also refuses, so that song's one gain is gone". The batch-fresh free-time read
**re-admits it** (±500 24 -> 25), together with four `Avercage_-_Embers` re-openings (`truth`, `headers`,
`credit`, `extraverse`, ±500 unchanged), while refusing one the round-1 guard allowed (`feel-my-heart` `jit`,
±500 unchanged): measured on the 182 cases of `_runs/w8a-r1-ctl-ra`, the round-1 guarded arm moved onsets in
22 and the round-2 arm moves them in 26. Against the *unguarded* recorded arm both are subsets; against each
other the batch-fresh read is two-sided. That is also the one substantive failure left in
`gates/w8a-r1-reopen.yaml` (118/125 at `run_align`, 121/125 at `time_text`):
`displaced-songs-not-pulled-off05` reads **1**, and the 1 is `tfr-chosen`.

**The word budgets in `gates/w8a-fix.yaml` and `gates/w8a-r1-reopen.yaml` were measured on 182 cases and are
one word short on 1088.** `word-aligned-down-at-most-reopenings-truth` allows -4 and the full corpus reads
**-5**; `headers` -5 and `extraverse` -5 against -4, `credit` -4 against -3, `jit` -6 against -6 (unchanged).
The extra word is `Avercage_-_Embers`' re-admitted line. Four of the seven `w8a-r1-reopen.yaml` failures and
the single `w8a-fix.yaml` failure (93/94 at both levels) are this one off-by-one; the remaining two,
`high-held-off05` and `high-held-offm1`, are the OTHER arm's demotion, which a reopen-only gate file was never
written against.

### The LINE_SYNC rung, and the default path

At `--sync-mode lines` the arms change **nothing**: 0 of 1088 cases differ from the shipped default on
`doc_sha256`, `onsets_sha256`, `confidence`, `high`, `high_bad`, `w500` or `gross`, in round 1 and round 2
alike — neither re-opening nor demotion is reached on the path that publishes a line-sync document.
`gates/w8a-lines.yaml` therefore reads **99/99** on the arms-on rows, which is the default's own reading.

**The default path is measured unmoved, not just argued unmoved.** A default-knob spot run on this tree
(8 songs x `truth`/`jit`/`off05`/`offm1`, 32 cases, including all four displaced songs and both songs the
demotion touches) is **identical to `results/w8a-run_align.cases.jsonl` on every column** — both digests,
confidence, `high`, `high_bad`, `w500`, `gross`, coverage and all nine word counters — although the worker
code fingerprint moved from `8706b41851c0b851` to `35d1360e6d5b3a5c`. The round-2 trail text therefore lives
where the review said it does: outside the bytes the TV fetches.

## W8b: the corpus's own truth, measured, and the 28 songs that score (2026-10-05)

The owner's call, executed here: the four songs whose `truth-lines.json` precedes its own recording **stay in
the corpus and leave accuracy scoring**. Nothing is re-anchored — not one truth file is edited — and nothing is
dropped: their refusals, their `gross` lines, their document bytes and their policy decisions are measured
exactly as before. What changes is that the pooled accuracy numbers a later wave ratchets on are read over the
**28 songs whose truth can score an aligner**, and the four that cannot say so, in the results file, with the
measurement behind the claim.

**Where it lives.** `corpus-truth.json` (beside `results/` and `gates/`) carries one entry per corpus song: the
measured displacement, how it was measured, and the confidence. `e2e_lib.load_corpus_truth` reads it,
`e2e_lib.accuracy_exclusions` derives the exclusion from it, `discover()` hangs the reason on the `Song`, every
row carries it, and three places in a results file show it:

* `meta.accuracy_excluded` — `{slug: reason}`, so the first screen of a results file names what did not score.
  The reason is NUMBERS — the median, the lines it was read over, the lag and its r, generated by
  `TruthQuality.exclusion`. It used to be the operator's prose `note` for numb, copied into 17 places of each
  results file and 34 lines of each `cases.jsonl`, where it then drifted from the file it was copied from (W8b
  review r2-tests-15). The prose stays in `corpus-truth.json`'s `note` and here, where it can be read once.
  A committed file's reason is a RECORD of what the harness said on the day and is never rewritten to match
  today's wording — that would stop it being its run's own output; what the suite holds across the two is the
  POOL and the GROUND, which is what any later reading depends on.
  It is also the POOL the file's own `scored` numbers were read over: `e2e_gates.view_of` filters a document by
  the exclusions the document records, never by today's `corpus-truth.json`, so a later edit to the live table
  cannot silently re-pool a committed baseline (a document written before the exclusion existed has no such
  record, and only that case falls back to the live file). An offline re-summarise
  (`e2e_lib.rows_document`) stamps the key from its own rows, which is why the three `w8b-base-*` files carry
  it although the W8a rows they re-read predate it.
* `summary.<mode>.scored` — a fourth report group beside `jamendo`, `youtube` and `all`. `all` still pools all
  32, so the exclusion hides nothing; `scored` is the 28. EVERY pooled gate read cross-checks the frozen pooled
  `cases` against the per-song entries it was pooled over, so a document that describes two different song sets
  is an ERROR rather than a comparison — on the run side as well as the baseline's, which is where an absolute
  floor (most of a wave file, and all a run with no `--compare` has) reads (W8b review r2-correctness-3).
* `songs.<mode>.<slug>.accuracy_excluded` — the reason again, per song, beside that song's own numbers.
* `results/*.cases.jsonl` — on each of that song's compact cases, so the per-case file reads the same way.

Verified end to end rather than in tests alone: a two-song run (`_runs/w8b-smoke`, `--level time_text --songs
bad-guy,Kinematic --modes truth`, **3 emission cache reads, 0 computed, 18 s**) prints the `scored` row with
bad-guy out of it (±500 71.4 against the 32-song 14.5) and writes all four places above.

`truth_displacement.py` is the measurement, and it rewrites `corpus-truth.json` (`--songs`, `--out`) — the
songs it measured MERGED OVER the ones already recorded, so re-measuring one song keeps the other 31 entries
(and the operator's `unusable` grounds) rather than deleting them and putting those songs back into scoring.
The file is hashed into `meta.harness`, because a file that decides which songs score is part of the harness.
An ABSENT file raises rather than scoring all 32 under a 28-song label; `ENCORE_BENCH_SCORE_ALL=1` is the
explicit way to run without one, and the fingerprint records that too (`e2e_lib.corpus_truth_bytes`). It records
the rule's own verdict per song (`confidence`, `displaced`) so a human reads it without applying the rule by
hand, and `load_corpus_truth` **re-derives both and refuses the file if either disagrees** — a recorded verdict
is a convenience, never the authority. An unreadable entry, an `unusable` ground outside `UNUSABLE_REASONS`, or
one its own numbers no longer support, raises rather than defaulting to "this song scores". So does a file whose
`songs` block is present but EMPTY, and a song `discover()` finds that the file never measured — the two
per-song halves of the same default, which the loader's docstring always claimed it never takes (W8b review
r2-spec-11). Corpus growth is therefore measured before it is scored: a 33rd song stops the sweep, naming the
`--songs <slug> --out` command that fixes it.

### The measurement

Three readings per song, over the **vocals stem** the aligner itself reads, all off `domain/audio/activity`'s
20 ms RMS envelope normalised to the track's own 95th-percentile frame:

1. **The silent-start delay.** A truth line start whose next 0.25 s averages under 0.10 of that loud level
   lands in SILENCE. From there, the delay to the first frame reaching 0.30 and holding above 0.10 for 0.1 s
   is how long the sheet claims singing before any begins. Median, MAD and max over those lines. The levels
   are the first and third arbiters of "W8a: the 0.5-2 s band, diagnosed before anything was changed",
   unchanged, so this table and that one are the same instrument.
2. **The envelope lag.** `activity.fit_sheet_to_audio` of the whole sheet's line spans against the same stem —
   positive means the sheet is EARLY — with its Pearson `r`.
3. **The level at a truth start** (`starts_level_median`, W8b review r2-correctness-1). The same 0.25 s window
   as reading 1, over EVERY truth start rather than the silent ones, and the median of those. It is what says
   whether reading 1 could see anything on this song at all: numb reads **0.546** against a 0.10 silence bar,
   so 1 of its 35 starts can qualify however displaced the sheet is. The corpus spans **0.202** (bad-guy) to
   **0.824**, and it is a precondition on numb's exclusion ground below, never evidence of displacement itself.

Reading 1 is **one-sided by construction**: a start sitting in silence can only be followed by singing, never
preceded by it, so every song with any such line reads a positive median. The number alone therefore proves
nothing; **how many lines qualify** is the other half of the evidence, and the rule below reads both.

**Four readings of the same claim now exist, and they differ — here is why.** The selector differs, not the
signal; no number is withdrawn:

| reading | selects | bad-guy | believer | tfr-chosen | numb |
| ------- | ------- | ------: | -------: | ---------: | ---: |
| **this section, all lines** (the claim of record) | the start sits in silence; onset searched forward from it | **+834** (27 of 79) | **+460** (15 of 73) | **+540** (11 of 37) | +380 (**1** of 35) |
| the same selector, first 40 lines only | as above | +547 (13 of 14 silent) | +467 (7 of 8) | n/a, 37 lines | +380 (1) |
| the PLAN's independent 2026-10-04 check, first 40 lines | a tighter silence test | +710, max 1020 (8 of 40) | +400 (9 of 40) | — | — (**1** of 40) |
| "Three independent arbiters say the sheet is early, not the decode late", arbiter 1 | 0.5 s of VERIFIED silence BEFORE the line; onset searched from start − 0.5 s | +1007 (14 of 79) | +450 (10 of 73) | +520 (10 of 37) | — (**0** of 35) |

All four agree on the sign, on the rank (bad-guy worst), and — the part the decision rests on — on **which
songs have the evidence at all**: every reading finds 0 or 1 qualifying line on numb and 8-27 on bad-guy. They
disagree on magnitude by up to 0.25 s, because a selector that admits more lines admits less displaced ones:
this section's 0.25 s-window silence test is the most permissive of the four, which is why it reads bad-guy's
first 40 lines at +547 where the PLAN's tighter test read +710 over 8 of them. The exclusion is not sensitive
to the difference — every reading puts bad-guy, believer and tfr-chosen over 250 ms and leaves numb unmeasured.

### What the 32 songs measure

`silent` is starts landing in silence, `n` those of them that a held onset follows within 4 s, `share` is
n / truth lines. All times in ms.

| song | lines | silent | n | share | median | MAD | max | lag | r | confidence | level |
| ---- | ----: | -----: | -: | ----: | -----: | --: | --: | --: | -: | ---------- | ----: |
| bad-guy | 79 | 29 | 27 | **0.34** | **+834** | 300 | 2627 | **+780** | 0.19 | measured | 0.202 |
| tfr-chosen | 37 | 13 | 11 | **0.30** | **+540** | 140 | 1040 | **+460** | 0.61 | measured | 0.351 |
| believer | 73 | 16 | 15 | **0.21** | **+460** | 74 | 660 | **+360** | 0.47 | measured | 0.534 |
| bohemian-rhapsody | 74 | 15 | 10 | 0.14 | +390 | 120 | 3140 | +0 | 0.23 | thin | 0.366 |
| hello | 74 | 19 | 9 | 0.12 | +358 | 66 | 2304 | +120 | 0.36 | thin | 0.325 |
| tfr-mayday | 52 | 8 | 6 | 0.12 | +400 | 70 | 3040 | +60 | 0.64 | thin | 0.416 |
| `Pure_Mids_-_The_Leader` | 20 | 2 | 2 | 0.10 | +420 | 139 | 559 | −60 | 0.64 | thin | 0.824 |
| `Avercage_-_Embers` | 42 | 4 | 4 | 0.10 | +929 | 708 | 1945 | −40 | 0.76 | thin | 0.455 |
| never-be-alone | 47 | 4 | 0 | 0.00 | — | — | — | **−800** | 0.77 | none | 0.544 |
| shape-of-you | 92 | 6 | 2 | 0.02 | +290 | 24 | 314 | −100 | 0.56 | thin | 0.568 |
| rap-god | 217 | 6 | 6 | 0.03 | +382 | 158 | 941 | +0 | 0.21 | thin | 0.501 |
| numb | 35 | 1 | 1 | 0.03 | +380 | 0 | 380 | **+620** | 0.70 | thin | 0.546 |
| tfr-flyaway | 75 | 5 | 5 | 0.07 | +240 | 20 | 360 | −20 | 0.59 | thin | 0.481 |
| feel-my-heart | 37 | 2 | 1 | 0.03 | +272 | 0 | 272 | −200 | 0.56 | thin | 0.617 |
| `Moon_I_Mean_-_Wrong_Concept` | 43 | 1 | 1 | 0.02 | +400 | 0 | 400 | +0 | 0.68 | thin | 0.671 |
| `Quentin_Hannappe_-_Keep_On` | 27 | 1 | 1 | 0.04 | +305 | 0 | 305 | +0 | 0.78 | thin | 0.594 |
| `Tom_Orlando_-_The_One__feat._Tina_G_` | 72 | 1 | 1 | 0.01 | +213 | 0 | 213 | +0 | 0.53 | thin | 0.423 |
| the other 15, every one Jamendo (`Kinematic_-_Peyote` among them) | | 0-2 | 0 | 0.00 | — | — | — | −80…+0 | 0.43-0.85 | none | 0.490-0.824 |

### The rule, and what each conjunct refuses

A song is **accuracy-excluded as displaced** when the silence arbiter clears its bars AND a second witness
agrees — `DISPLACEMENT_LIMIT_MS` 250, `MIN_DISPLACEMENT_ONSETS` 5, `MIN_DISPLACEMENT_SHARE` 0.15,
`MIN_LAG_CORRELATION` 0.25 in `e2e_lib`:

* confidence `measured`: at least 5 timed onsets AND a share of at least 0.15, and
* median ≥ 250 ms, and ONE of
  * **the lag corroborates**: envelope lag ≥ 250 ms *at r ≥ 0.25*, or
  * **the silence arbiter stands alone**: ≥ 10 timed onsets, share ≥ 0.30 and median ≥ 500 ms — twice each of
    its own bars.

250 ms is not a new threshold: it is W8a's own coherence cut (`gates/w8a.yaml`'s
`coherent-songs-not-pulled-truth` selects on `abs(bias_ms) > 250`), reused rather than re-derived. Nor is 0.25:
it is `claimmap.MIN_ENVELOPE_CORRELATION`, the bar under which `align_steps` refuses to even OFFER an envelope
lag as a clock candidate. **Why the second branch exists** (W8b review r2-spec-8): the lag was sold as "the
independent second witness" with no quality term at all, and the song it decided reads **r 0.19** — a fit
nobody would act on, so on bad-guy the conjunct was being carried by a number that says nothing. Rather than
widen the rule or un-exclude the most displaced song in the corpus, a sheet with no usable second witness must
clear the FIRST arbiter at twice every one of its bars. One stated doubling, not a threshold read off the song
it has to admit. The branches, measured: bad-guy takes the second (27 onsets, share 0.34, median 834); believer
and tfr-chosen take the first (r 0.47 and 0.61); and no song in the corpus changes verdict either way.

**Three songs pass it: bad-guy, tfr-chosen, believer.** The margins, and which conjunct does the work:

* The **share floor** is what separates believer (0.205) from bohemian-rhapsody (0.135) and hello (0.122),
  whose medians are large but whose few early lines are breaths and long instrumental gaps rather than a
  displaced sheet — their maxima, 3140 and 2304 ms, are gaps, not displacement. On today's corpus the share
  floor alone selects the same three. Its margins are NOT symmetric: 0.15 sits 0.055 under believer's 0.205 and
  only 0.015 over bohemian-rhapsody's 0.135 — comfortable on the exclusion side, thin on the keep side, which
  is exactly why the lag is a second conjunct and not decoration.
* The **lag conjunct** changes no verdict today and is kept as the independent second witness: it reads +360 to
  +780 on the three and +0 to +120 on bohemian-rhapsody, hello, rap-god and tfr-mayday. At a share floor of
  0.13 rather than 0.15 it is the only thing that would still keep bohemian-rhapsody in.
* `r` now **gates the lag** rather than being recorded beside it. The three songs below 0.25 are bad-guy (0.19),
  bohemian-rhapsody (0.232) and rap-god (0.214); the latter two are `thin` and refused on the first arbiter
  anyway, so the bar costs nothing today and the lag can no longer be satisfied by noise. `activity`'s own
  stricter 0.40 is the gate on MOVING a sheet, which is a different decision from measuring one — but 0.19 is
  under BOTH, which is why bad-guy is excluded by the silence branch and not by its lag.
* The lag's known false positive is never-be-alone's **−800 ms at r 0.77**, on a song whose published median
  error is 0.000: two conjuncts refuse it — the lag is negative, so it is not even the right sign, and the song
  has no timed silent start at all (0 onsets from 4 silent starts).

### numb is excluded on a displacement the silence arbiter cannot see

numb has **one** line start in stem silence out of 35, so by the rule above its displacement is not
established, and the rule's own verdict in `corpus-truth.json` stays `displaced: false`. The reason the arbiter
reads one line is measured, and it is not that the sheet is on time: **numb's stem is never quiet at a line
start.** Over its 35 truth starts the mean stem level in the next 0.25 s runs **min 0.088, median 0.546, max
0.907** of the track's loud level, against the 0.10 silence bar — exactly one line (0.088) can qualify. The
arbiter's precondition is unmeetable here, which is a property of the recording, not evidence of a good sheet.
That median is the `starts_level_median` field every song now records, so the ground is checked against the
measurement and not only asserted in prose — see "The ground is re-derived, like the verdict" below.

Three readings that do NOT need silence all say the sheet is early, and they span 140 ms end to end:

* **the envelope lag, +620 ms at r 0.702** — the highest r of the four EXCLUDED songs and well clear of
  `activity.MIN_CORRELATION` 0.40, though not the corpus's highest: `Kinematic_-_Peyote` reads **0.824** and
  never-be-alone 0.769, on sheets nothing says are displaced (W8b review r2-spec-10 — the superlative that
  stood here, "the highest of the five band songs", was false under the README's own definition of that set).
  At the `lines` rung this lag is the shift the shipped claim clock actually applies to numb's whole sheet
  (bad-guy's is **+720 ms**, and no other song moves at all);
* **the forced rung's own blind decode, +690 ms with MAD 140 ms over all 35 lines** — and the cue ENDS are
  displaced by the same **+720 ms** median, so the whole cue is early, not merely long at the front;
* **the two lines whose lead-in is quiet enough to read by eye**, frame by frame off the same envelope. Line 0:
  the stem's first SUSTAINED rise is at **22.84 s** (0.317 → 0.784, and it stays up) against a truth start of
  22.18 — **+660 ms** — and the aligner publishes **22.83**, inside one 20 ms frame of it. Line 2: the sustained
  rise is at **31.60 s** (0.542 → 1.000) against a truth start of 31.02 — **+580 ms** — and the aligner
  publishes **31.57**. On both lines the sheet is early by about the same amount and the aligner is right.

Line 2 is also where numb's recorded `median_ms` **+380** comes from — it is the song's one silent start, and
the 0.10/0.30 detector stops at a **0.16 s burst at 31.40** (peak 0.508) that falls back to 0.043 before the
singing begins at 31.60. On line 0 the same detector fires at 22.28 on a 0.331 blip, **0.56 s** before the
rise. The detector is not wrong; it is reading a stem in which breath and bleed clear its bar.

So numb leaves accuracy scoring on a ground that names the recording: `corpus-truth.json` records
`"unusable": "continuous-vocal"`, with those numbers in its `note`. `UNUSABLE_REASONS` is a closed set, so an
exclusion nobody can name is a hidden song list and fails the suite. **The rule is NOT widened to admit numb**
— a lag-alone conjunct, or a silence bar raised to this stem, re-derives all 32 songs to move one, which is
tuning the instrument at the song.

#### The ground is re-derived, like the verdict

`unusable` used to be a one-way door: read verbatim with no numeric precondition, and copied forward by
`truth_displacement.py --out` onto every fresh reading of the song, so no measurement could ever clear it (W8b
review r2-correctness-1). It is now checked against the entry's own numbers exactly as `displaced` is, on the
four conditions that ARE this ground — `TruthQuality.unsupported_ground`:

* confidence is NOT `measured` (if the arbiter can read the song, the displacement rule decides, not a word),
* `starts_level_median` ≥ 0.30 — `truth_displacement.SINGING_LEVEL`, i.e. the stem is already singing where the
  sheet says a line starts, which is WHY there is no silence to time. 31 of the 32 songs clear this bar, so it
  is a precondition and not evidence: it fails only on bad-guy (0.202),
* the envelope lag is still ≥ 250 ms, and
* at r ≥ 0.25, so the ground cannot rest on a lag nobody would use either.

A failure prints and DROPS the ground on a re-measure (`--songs numb --out`, the operator action the
carry-forward exists for) and RAISES on load, naming which condition went. So the re-anchor the next wave
contemplates — moving numb's `truth-lines.json` by the measured +690 ms — returns numb to accuracy scoring by
measurement, with the drop on the terminal, instead of leaving a stale exclusion standing.

The ground this replaces was `"level-relative"`: that the same 35 lines read 54.29 % / 20.00 % / 0.00 % ±500 at
`time_text` / `run_align` / `lines` and that no truth quality could explain it. **That claim is refuted below,
and both halves of it were wrong** — the levels are not handed the same TEXT, and the metric comparing them is
dominated by the displacement measured here.

### Both ways: 32 songs and the 28 that score

Re-summarised from W7's own rows (`_runs/w7-{ra,tt,lines}/rows.jsonl`) through this harness — the same rows the
committed bases `results/w8a-band-run_align.json`, `w8a-base-time_text.json` and `w8a-base-lines-run_align.json`
hold, whose `all` column these numbers reproduce exactly (`truth` ±500 90.45 / band 163 / gross 0 / missing 53
at `run_align`). **0 model seconds.**

Every committed baseline predates the `scored` group, and nothing in `results/` is rewritten here: the
pre-W8b files keep their bytes, so every recorded gate reading stays reproducible. Reading one with the new
harness still pools 28 songs correctly — `e2e_gates._entry_in_group` falls back to `corpus-truth.json` by slug
for a per-song entry with no reason on it, so `_same_pool` sees the same 28 on both sides — and `--compare`
prints `groups only in run: scored` rather than dropping the column without a word.

`run_align`, scored lines then ±500 then `band` then `missing`:

| mode | 32: lines | ±500 | band | miss | 28: lines | ±500 | band | miss |
| ---- | --------: | ---: | ---: | ---: | --------: | ---: | ---: | ---: |
| truth | 1707 | 90.45 | 163 | 53 | 1504 | **97.07** | **44** | 32 |
| jit | 1707 | 87.17 | 219 | 53 | 1504 | 92.69 | 110 | 32 |
| off05 / off15 / off3 / offm1 | 1707 | 90.22 | 167 | 53 | 1504 | 96.81 | 48 | 32 |
| tempo098 | 1707 | 89.46 | 180 | 53 | 1504 | 96.14 | 58 | 32 |
| tempo102 | 1707 | 89.51 | 179 | 53 | 1504 | 96.21 | 57 | 32 |
| drop20 | 1373 | 90.31 | 133 | 39 | 1209 | 96.28 | 45 | 24 |
| drop50 | 818 | 80.81 | 75 | 55 | 718 | 84.40 | 43 | 45 |
| extraverse | 1718 | 90.80 | 158 | 42 | 1515 | 97.43 | 39 | 21 |
| blind | 1707 | 81.66 | 252 | 53 | 1504 | 87.97 | 132 | 32 |
| headers | 1707 | 90.51 | 162 | 53 | 1504 | 97.07 | 44 | 32 |
| credit | 1707 | 90.33 | 165 | 53 | 1504 | 97.14 | 43 | 32 |

`time_text`: truth **90.89 → 97.12** (band 158 → 44, missing 25 → 10), jit 86.74 → 92.73, off05 90.72 → 96.85,
off15/off3/offm1 90.66 → 96.85, tempo098 89.97 → 96.07, tempo102 90.03 → 96.13, drop20 89.61 → 96.33,
drop50 66.74 → 73.16, extraverse 91.04 → 97.45, blind 81.50 → 87.29, headers 90.11 → 96.08, credit
90.95 → 97.25. The `lines` rung: truth **94.16 → 100.00** with `band` 100 → **0**, off15/off3/tempo102/drop20/
drop50/extraverse/headers all **100.00**, off05 99.88 → 99.87 (the uniform half-second the rung publishes
verbatim), offm1 93.34 → 99.07, tempo098 93.52 → 99.40, credit 93.81 → 99.60, jit 85.22 → 89.77.

**THE 28-SONG BASELINE, which is the comparison base from here**: at `truth`, `run_align`
**±500 97.07 %** (CI 95.97-98.35 against the 32-song 81.13-96.47), **1504 scored lines**, **gross 0**,
**band 44**, **missing 32**, `high` 1253, **`high_bad` 0**; at `time_text` **±500 97.12 %**, 1526 lines,
gross 0, band 44, missing 10, `high` 1260, `high_bad` 0; at the `lines` rung **±500 100.00 %**, band 0.

### What the four carried, and what the exclusion does NOT move

Of the 32-song `truth` reading at `run_align` the four songs carried **119 of the 163 band lines (73 %)**,
**21 of the 53 missing lines**, and **94 of the 94 `high`-but-wrong lines** — every single one. Their own
±500 was bad-guy 3.12 (bias +868.5, MAD 111.5), numb 20.00 (+690.0, 140.0), believer 70.83 (+370.0, 87.0),
tfr-chosen 75.00 (+390.0, 160.0), on 203 of the corpus's 1707 scored lines. So the honest statement of the
build's remaining line error at `truth` is **44 band lines over 28 songs, not 163 over 32**, and the
confidence grade over-claims on **nothing** that scores — `high_bad` 0 at `truth`, `off05`, `off15`, `off3`,
`offm1`, `tempo098`, `tempo102`, `drop20`, `drop50`, `extraverse`, `headers` and `credit` alike. It is not 0
everywhere: `blind` keeps **43** and `jit` **7**, which are pipeline readings and not truth quality.

**The word, end and highlight metrics do not move at all.** They are Jamendo's, all 20 Jamendo songs score,
and the four excluded songs have no word truth: `words 5378/5693`, ±100 85.46, ±300 97.16, AAE 71.1 ms, PCO@.3
91.76 and highlight 81.40 % of 2432.77 s read IDENTICALLY in `jamendo`, `scored` and `all`. The exclusion is a
statement about four line-timing references and nothing else.

**What is still gated over all 32.** Robustness is not accuracy: the four songs stay in every run, and `all`
keeps `gross`, the wrong-text pass rate, refusals, `no_lyrics`, document identity (`doc` / `onsets` digests),
coverage and the policy counters. A wave that crashed on bad-guy, refused it, or moved its published bytes
would still be caught — which is the whole reason the owner chose exclusion from SCORING over removal from the
corpus.

## W8b: numb's three levels, closed — the gap is 17 words of the bench's own truth file (2026-10-05)

The lead was that numb reads **54.29 % ±500 at `time_text`, 20.00 % at `run_align` and 0.00 % at the `lines`
rung on the same 35 lines**, and that a level-relative gap cancels truth quality, so a 34-point loss over the
timing step the search and policy layer wraps had to be ours. **It is not ours, and the gap is not
level-relative.** Hand `time_text` the text production's ports serve and it writes a **byte-identical
document** to `run_align`'s — `doc` `488d7e1b37b41ea4`, `onsets` `20067c36a680c949`, confidence `high`, 291
words, and all 35 line errors equal to the millisecond. The search and policy layer contributes **nothing**: at
every one of the three levels numb publishes **attempt 1**, its only one (`lrc` at `time_text`,
`captions:authored` at the other two), with 0 retries, no `NextText`, no `ALIGN_ON_MIX`, no ASR and no
`GiveUp` — the only knob on any of the three is the `lines` rung's own `line-sync`, which is that rung's
definition.

Reproduce any of it with `_review-scratch/w8b-numb/levels.py` (monkeypatch-only through the shipped drivers;
the repo is not edited to measure), one song and one mode per run, **12-19 s each off the emissions cache**:

    cd worker && .venv/bin/python ../../encore-align-bench/_review-scratch/w8b-numb/levels.py tt-clean

| run | level | text served | ±500 | band | bias | MAD | conf | words | `doc` |
| --- | ----- | ----------- | ---: | ---: | ---: | --: | ---- | ----: | ----- |
| `_runs/w8b-numb-tt` | `time_text` | RAW claims | **54.29** | 16 | +470 | 240 | medium | 308 | `0b455b352bb3ec06` |
| `_runs/w8b-numb-tt-clean` | `time_text` | `clean_segments`'d | **20.00** | 28 | +690 | 140 | high | 291 | `488d7e1b37b41ea4` |
| `_runs/w8b-numb-ra` | `run_align` | its ports' (cleaned) | **20.00** | 28 | +690 | 140 | high | 291 | `488d7e1b37b41ea4` |
| `_runs/w8b-numb-lines` | `run_align --sync-mode lines` | its ports' (cleaned) | **0.00** | 35 | +620 | **0** | low | 0 | `41d59e045c75bca2` |

### The first divergence is a text port, before `time_text` is entered

`RunAlignDriver` serves the claims through `ClaimCaptions`, whose `__init__` calls `clean_segments` as
`adapters.captions` does; `TimeTextDriver` builds its `TextRef` from `claims.segments()` with no cleaning, which
its own docstring states and the review reproduction depends on. On numb that is not cosmetic: **17 of its 35
truth lines begin with the literal token `CHORUS:`**, and the token carries LETTERS, so the aligner must place
it. The gate's own lexical reading counts the difference — **1227 letters at `time_text` against 1125 at
`run_align`, exactly 17 × `len("CHORUS")`**, and 308 published words against 291.

**What the phantom token does to the published start.** It is placed in the gap before the singing and the line
starts at IT:

| line | truth | `time_text` start | first word there | `run_align` start | first word there |
| ---: | ----: | ----------------: | ---------------- | ----------------: | ---------------- |
| 5 | 52.22 | **52.23** | `CHORUS:` (0.93 s, score **−5.68**) | **53.17** | `I've` |
| 15 | 104.64 | **104.32** | `CHORUS:` (1.22 s) | **105.55** | `I've` |
| 28 | 155.32 | **155.31** | `CHORUS:` (0.61 s) | **155.93** | `Is` |

**On 5 of the 17 the token is pinned at the CLAIMED start**, within 50 ms of it (lines 5, 8, 18, 19, 28 at
+0.01, +0.05, +0.03, +0.01, −0.01) and on 7 within 100 ms — the `time_text` repair ladder re-decodes a disputed
line inside its claim window and the unsung token comes to rest at that window's own edge (its `why` names the
state: "stuck at the window's edge"). In `truth` mode the claim IS the scoring truth, so those lines read as
exact hits at instants where **nothing is sung**.

**Line for line, the account is exact.** All **18 lines without the prefix publish the identical start at both
levels, to the centisecond** — zero divergence. All **17 with it** publish the phantom token's start at
`time_text` and the first sung word at `run_align`; on 12 of the 17 the first sung word is itself identical, so
the only change is which token the line starts at, and on the other 5 the extra 6 letters also push the sung
word **+0.12 to +0.72 s later**, because a forced path must spend frames on a token that is not sung. **12 of
the 17 are inside ±500 ms at `time_text` and outside it at `run_align` — 19 − 7 = 12 of 35 = the whole 34.29
points.**

**The repair ladder follows the text, it does not cause the gap.** At `time_text` the worse text draws more
work: 12 repeated lines re-decoded between unique anchors, 2 of 2 disputed lines re-decoded inside their claim
windows, 1 claim timing adopted, and timing sources **22 blind / 11 anchored** (lines 6, 7, 8, 13, 15, 16, 18,
19, 27, 28, 34) **/ 1 window** (line 5) **/ 1 adopted** (line 24). At `run_align` the cleaned text needs 7
repeated-line re-decodes and reads **28 blind / 7 anchored** (18, 19, 27, 29, 31, 32, 34), with no window
re-decode and no adoption at all. Both grade **`coarse`**; the confidence differs — `medium` at `time_text`
against `high` at `run_align`, the latter on an internal agreement of 71 % within 0.25 s and 100 % within 1 s at
spread 0.14 s. Every one of those differences disappears when the text is equalised, which is what
`doc` `488d7e1b37b41ea4` on both sides means.

### Why `lines` reads 0.00 %, and it is not publishing claims verbatim

The `lines` rung publishes the sheet mapped onto our clock by the measured envelope lag, **+620 ms on every one
of the 35 lines**: MAD exactly **0**, ±1 s **100 %**, ±500 **0 %**. In `truth` mode the claims ARE the scoring
truth, so a uniform shift puts every line at 620 ms — one number, 70 ms from the forced rung's own decode-median
of +690, and it reads as a total failure. A uniform offset with zero spread scoring 0.00 % is the clearest
single demonstration in this corpus that ±500 on numb measures the truth's displacement and not the pipeline.

### Re-anchor numb's truth by the measured +690 ms and the ranking INVERTS

Computed off the recorded per-line errors of `_runs/w8a-def-{tt,ra,lines}` — no model seconds:

| level | as shipped | truth +620 ms | truth **+690 ms** | truth +720 ms |
| ----- | ---------: | ------------: | ----------------: | ------------: |
| `time_text` | 54.29 | 68.57 | **71.43** | 71.43 |
| `run_align` | 20.00 | 91.43 | **94.29** | 94.29 |
| `lines` | **0.00** | 100.00 | **100.00** | 100.00 |

`gross` is 0 in every cell. The rung that looked worst is **perfect** against the audio and the rung that
looked best is the **worst** of the three: against the re-anchored truth `time_text` holds 25 of 35 lines where
`run_align` holds 33, so the raw-claims level **loses 8 lines** — the price of starting a line at a token nobody
sings, the 17 of them running **0.16 to 1.22 s** wide. There was no 34-point loss to find.

### Why only numb, over the whole corpus

Text hygiene changes a truth line in **9 of the 32 songs**, and removes **1 295 tokens and 48 whole
decoration-only lines** across them — but it removes a token carrying LETTERS in **exactly one song**:

| song | truth lines | lines dropped | tokens removed | with letters |
| ---- | ----------: | ------------: | -------------: | -----------: |
| rap-god | 217 | 1 | 432 | 0 |
| shape-of-you | 92 | 4 | 176 | 0 |
| believer | 73 | 1 | 144 | 0 |
| hello | 74 | 11 | 134 | 0 |
| bohemian-rhapsody | 74 | 9 | 130 | 0 |
| bad-guy | 79 | 14 | 130 | 0 |
| tfr-chosen | 37 | 3 | 68 | 0 |
| feel-my-heart | 37 | 5 | 64 | 0 |
| **numb** | 35 | **0** | **17** | **17** (all `CHORUS:`) |

The other eight carry `♪ … ♪`, which has no letters, so it romanises to nothing and the forced path spends no
frames on it: it publishes at **ZERO WIDTH**, `start == end ==` the first sung word's start. believer's line 1
is `♪` 7.65 → 7.65 then `FIRST` 7.65 → 8.04 at `time_text`, and `FIRST` 7.65 → 8.04 at `run_align` — the line
start is the same number and so is every word. A letter-bearing label cannot do that; `CHORUS:` eats 0.16 to
1.22 s. Measured on the recorded rows: in `truth` mode only **4 of 32 songs** have ANY line whose
published start differs between the two levels (numb 16 lines at a median +0.60 s, bohemian-rhapsody 8 at
+0.03, feel-my-heart 5 at −0.11, tfr-chosen 3 at +0.36), and over all 16 modes **110 of 1088 cases**. numb is
the only song where the divergence is worth a point of ±500, let alone 34.

### What this does and does not change

Nothing published moves: no shipped worker code is touched, no scoring code, no threshold, and numb was already
out of accuracy scoring — so the 28-song `scored` set, every pooled right-text `gross` of 0, the wrong-text
protection (0/320 + 0/320 + 0/640) and every recorded number in `results/` are unchanged **by construction**.
What changes is the record: numb's exclusion now rests on its recording and its truth instead of on an
unexplained level spread, and the `time_text` level's known seam — raw claims — has a measured consequence
attached to it for the one corpus song that has one.

**The asymmetry that produces the gap is deliberate and stays.** `ClaimLine.lead_words` already models a label
at the head of a line, and `_truth_offset` uses it so the WORD and highlight metrics pair the truth words with
the line's LAST words — a label-stripping rule and a label-keeping one score the same there (review r1
correctness-3: 6/6 aligned and 1.8/1.8 s lit either way). `score_lines` does NOT compensate, because a
published line starts where its first word is lit: a document that holds `CHORUS:` across the 0.93 s before the
singing really does start the line there, and a TV really does light it. The metric is right and the document
is wrong. numb's native labels carry `lead_words` 0 in any case — only the `headers` mode's injected labels set
it — so compensating would not have reached this song.

**Two more things deliberately NOT done.** The `time_text` level is not made to clean its claims: that seam is
what reproduces the review baseline, cleaning cannot move the level by design (`TimeTextDriver`'s docstring), and on
this corpus it costs one song's comparability — recorded here — rather than any production behaviour, since
every text-acquiring path cleans, a pinned PASTE included (`align_steps.fetch_pinned_text`, R3 off). And the
displacement rule is not widened to admit numb, for the reason given in "numb is excluded on a displacement the
silence arbiter cannot see".

## W8b: re-judging `word-aligned-not-down` (2026-10-05)

`gates/w8a.yaml`'s `word-aligned-not-down-truth` [5373 ≥ 5378] and `-jit` [5096 ≥ 5102] are the only two rules
standing between `band-reopen` and default-on, and every accuracy column they sit beside moves the right way
while `aligned + interpolated` is identical in every mode. The owner's call was to treat a small
aligned/interpolated reclassification as PROVENANCE BOOKKEEPING rather than an accuracy regression **when the
totals match and accuracy improves**, and to flip the arms on if that is what the data says. It is not what the
data says. **The arms stay DEFAULT-OFF**, and this section is why, word by word.

Re-derive any of it with `scripts/word_provenance.py`, which prices two recorded runs against truth without
re-running a model. It exits 2 rather than 0 on a pair it cannot read in full: a `--modes` name missing from
EITHER run, or any (song, mode, variant) row one run has and the other does not — a sweep killed partway
through used to be read as "no word moved", which is the one answer this tool must never give by omission.

    .venv/bin/python ../docs/benchmarks/forced-alignment/scripts/word_provenance.py \
        $ENCORE_BENCH_ROOT/_runs/w8a-def-ra $ENCORE_BENCH_ROOT/_runs/w8ar2-arms-ra

### The thirty words, and the four that decide it

`_runs/w8a-def-ra` (the shipped default) against `_runs/w8ar2-arms-ra` (both arms on) — the two sweeps the
round-2 re-price read — differ on **30 Jamendo words over 7 of the 16 modes, and on nothing else**: every one of
them is a line's FIRST word, every one is re-labelled from aligned to interpolated, and **no word changed its
published start without also changing its label**. Priced against truth, **26 are better and 4 are worse**.

| mode | song | word | \|published − truth\| |
| --- | --- | --- | --- |
| truth, headers, extraverse, credit, drop20 | `Avercage_-_Embers` | `one` | 356.1 → **0.0** ms |
| truth, headers, extraverse, credit (×2), drop20 (×2) | `Kinematic_-_Peyote` | `oh` ×3 | 783.9 / 908.8 / 959.6 → **0.0** ms |
| truth, headers, extraverse, credit, drop20, drop50 | `Lower_Loveday_-_Is_It_Right_` | `i` | 258.2 → **0.0** ms |
| jit | `Kinematic_-_Peyote` | `oh` | 783.9 → **85.8** ms |
| jit | `Kinematic_-_Peyote` | `oh` | 908.8 → **186.5** ms |
| jit | `Explosive_Ear_Candy_-_Like_The_Sun` | `you're` | 14.8 → **331.7** ms |
| jit | `Explosive_Ear_Candy_-_Like_The_Sun` | `you're` | 72.9 → **394.9** ms |
| jit | `HILA_-_Give_Me_the_Same` | `but` | 7.2 → **348.8** ms |
| jit | `Quentin_Hannappe_-_Keep_On` | `keep` | 28.2 → **300.9** ms |

**24 of the 26 "better" words land on exactly 0.0 ms, and that is the tell, not the vindication.** `band-reopen`
re-opens a line AT ITS CLAIM, and the six modes those 24 words live in — `truth`, `headers`, `extraverse`,
`credit`, `drop20`, `drop50` — perturb the TEXT and leave the claimed times as the truth times. Adopting the
claim there cannot score worse than the decode by construction, whatever the audio says. The other **two
better words are real `jit` gains** (783.9 → 85.8 and 908.8 → 186.5 ms), and they are the two the four `jit`
losses below are weighed against. Better by mode: truth 5, headers 5, extraverse 5, credit 4, drop20 4, drop50
1, jit 2 = 26, against 4 worse, all at `jit` — 30 words. The seven modes whose
claims are displaced from truth on purpose (`off05`, `off15`, `off3`, `offm1`, `tempo098`, `tempo102`, `blind`)
show **no reclassified word at all** — the arm does not fire where the claim and the decode disagree that much.

**`jit` is the one affected mode whose claim is neither the truth nor far from it** (σ = `JITTER_SEC` per line),
and it is the only mode that can tell adoption from alignment. There the arm trades two of Kinematic's badly
late `oh`s (−698 and −723 ms of error) for **four words that were inside ±100 ms and are now outside ±300**:
+317, +322, +342 and +273 ms. Those four are the answer to the owner's question. The reclassification is not
bookkeeping — three of the six words it re-labels at `jit` paid for their new label with a worse published
start, and the fourth, `Quentin_Hannappe`'s `keep`, crossed ±300 by 0.9 ms.

### The recorded accuracy gain IS the denominator

An interpolated word leaves `word_pm100` / `word_pm300` / `word_aae_ms` entirely — numerator and denominator
both. Scoring the six `jit` words AS PUBLISHED (the same aligned-word metrics, with the six kept in) reverses
every column the re-price reported as an improvement:

| `jit`, Jamendo | aligned | ±100 | ±300 | AAE |
| --- | --- | --- | --- | --- |
| default | 5102 | 83.46 | 95.86 | 80.3 ms |
| arms, as the gate scored them | 5096 | 83.48 | 95.90 | 80.1 ms |
| arms, with the six words kept in | 5102 | **83.40** | **95.83** | 80.3 ms |

`(0.9586 × 5102 − 4) / 5096 = 95.90` to the digit: the whole of the reported `jit` ±300 gain is four correct
words and two wrong ones leaving a denominator of 5102.

### The replacement ratchet: `word_published_*`

`word_aligned >= base` caught this, but only by luck — it counts labels, so it would equally refuse a harmless
re-labelling and equally miss a 300 ms move that kept its label. What the owner's decision actually asks for is
"`aligned + interpolated` unchanged AND no word's published start further from truth", so `e2e_lib` now scores
**every paired word's published onset with the provenance flag ignored**: `word_published_pm100`,
`word_published_pm250`, `word_published_pm300`, `word_published_aae_ms`, from the new `words.unaligned_errors`
row list beside `words.errors`. The denominator is `aligned + interpolated`, which is why a reclassification
cannot move it: it reads **5689 in every mode and in both runs**. Rows written before the list existed read the
family as None unless they have no interpolated word, so an old baseline ERRORs rather than passing.

Measured over the whole corpus at BOTH levels (Jamendo; `_runs/w8a-def-{ra,tt}` against
`_runs/w8ar2-arms-{ra,tt}`, re-derived from the recorded documents, the aligned half of each cell reproducing
its run's committed `word_aligned` / ±100 / ±300 / AAE exactly):

| mode | n | default ±100 | arms ±100 | default ±300 | arms ±300 | default AAE | arms AAE | |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `truth` | 5689 | 82.79 | 82.88 | 95.36 | 95.43 | 86.6 | 86.1 | up |
| `headers` | — | 82.79 | 82.88 | 95.36 | 95.43 | 86.6 | 86.1 | up (`run_align`) |
| `extraverse` | 5683 | 82.00 | 82.09 | 94.55 | 94.62 | 88.8 | 88.3 | up |
| `credit` | 5689 | 82.25 | 82.32 | 94.96 | 95.01 | 89.5 | 89.1 | up |
| `drop20` | 4555 | 77.63 | 77.72 | 91.26 | 91.33 | 162.9 | 162.3 | up |
| `drop50` | 2572 | 66.80 | 66.84 | 79.47 | 79.47 | 657.5 | 657.4 | up (`run_align`) |
| `jit` | 5689 | **76.64** | **76.59** | **90.54** | **90.51** | 116.0 | 116.0 | **DOWN** |
| `off05` / `off15` / `off3` | 5689 | 82.91 | 82.91 | 95.36 | 95.36 | 86.8 | 86.8 | same |
| `offm1` | 5689 | 82.91 | 82.91 | 95.36 | 95.36 | 86.7 | 86.7 | same |
| `tempo098` | 5689 | 82.88 | 82.88 | 95.39 | 95.39 | 86.2 | 86.2 | same |
| `tempo102` | 5689 | 82.88 | 82.88 | 95.39 | 95.39 | 86.2 | 86.2 | same |
| `blind` | 5689 | 82.81 | 82.81 | 94.38 | 94.38 | 253.6 | 253.6 | same |

`jit` ±250 falls with the rest: 89.40 → 89.37. Twelve of the fourteen modes read IDENTICALLY at `run_align` and
`time_text`, which is why `gates/w8b-arms.yaml` can floor them in one file at both levels; `headers` and
`drop50` do not (`headers` 5689 words at `run_align` against 5683 at `time_text`, `drop50` 2572 against 2859,
and the `time_text` `headers` cell is the one whose re-derived aligned count disagrees with its run's own).

**Those two modes are held against the BASELINE instead** (section 4 of the file, W8b review r2-correctness-4).
Leaving them to the accounting rules was the blindness the file was written to close: an arm that moves
published starts only under label injection or a half-dropped sheet never violates `aligned + interpolated`, and
these are two of the seven modes the table above shows the arm firing in (`headers` ×5 words, `drop50` ×1 — all
of them BETTER). An absolute floor cannot serve both levels here and the LOWER of the two is no ratchet either:
at `headers` ±100 that is 2.58 points of slack, **147** Jamendo words, where the arm moves five. A base-relative
rule needs no per-level constant and bites at one word. The per-level readings it holds, off the W8b default:

| mode | ±100 | ±250 | ±300 | AAE |
| --- | --- | --- | --- | --- |
| `headers`, `run_align` | 82.79 | 94.43 | 95.36 | 86.6 ms |
| `headers`, `time_text` | 80.21 | 92.09 | 92.99 | 103.7 ms |
| `drop50`, `run_align` | 66.80 | 77.99 | 79.47 | 657.5 ms |
| `drop50`, `time_text` | 64.85 | 75.31 | 76.67 | 931.9 ms |

The cost is that section 4 can only be read where BOTH sides carry the family, so from W8b on the file's
`--compare` base is the matching level's own W8b default row and not W7's: against `w8a-band-run_align` /
`w8a-base-time_text` it reads **69 PASS, 8 ERROR, 0 FAIL**, the ERRORs being eight rules asking a baseline for
published onsets it never recorded. Against the matching W8b row it reads **77/77** at both levels.

**So the better gate rejects the arm too, and on substance.** `gates/w8b-arms.yaml` floors
`word_published_pm100` at the default's reading in 12 modes; the arms-on sweep reads `jit` 76.59 against a floor
of 76.64 and FAILS, with the four words named. `gates/w8a.yaml`'s `word-aligned-not-down-*` therefore stays as
it is — its verdict was right — but its header no longer claims that `word_aligned` cannot fall.

**And the price of that rejection, on the metric this wave scores.** W8a's arms rows re-summarised on the W8b
harness (`results/w8b-arms-run_align.json`, 0 model seconds, `_tools/resummarise.py`) read the 28-song pool at
`truth` **97.27 % ±500 with band 41**, against the default's **97.07 % / 44** — and at `jit` 92.82 against 92.69.
So the arm is worth +0.20 pt of line accuracy over the songs whose truth can score it, and is refused for four
Jamendo words at `jit`. That is the whole owner call, with both sides of it measured. The same file is what lets
`gates/w8b.yaml` be read WHOLE on a tree whose documents moved: **147 PASS / 7 FAIL / 0 ERROR**, the seven being
the identity half (`docs-unchanged-{truth,jit,drop50}`, `onsets-unchanged-{truth,jit}`, `no-song-gains-{truth,
jit}`) while all 86 accuracy rules pass — the committed `w8a-r2-arms-run_align.json` predates the `scored` group
and ERRORs on exactly those 86 (W8b review r2-tests-13).

**Reproduced on today's tree, not only in the recordings.** `_runs/w8b-prov-{def,arms}` are a 2-song x 2-mode
pair (`Kinematic_-_Peyote`, `Quentin_Hannappe_-_Keep_On`, `truth` and `jit`, code `9a56defe03e59d1e`, 25 s and
23 s) and they reproduce all six words to the millisecond: Kinematic 783.9 -> 85.8 and 908.8 -> 186.5 at `jit`,
three times 0.0 at `truth`, and `Quentin_Hannappe`'s `keep` 28.2 -> 300.9. The arm has not drifted since the
round-2 sweep; the verdict is about what it does.

**`band-off-sheet` is untouched by any of this.** Its rejection was never bookkeeping:
`demotion-removes-only-bad-high-offm1` reads 23 good `high` lines lost on never-be-alone at `offm1`, against a
`MIN_COHERENT_SHARE` of 0.70 that `together`'s 0.935 cannot refuse. That stands.

## W8b: the sweep, read both ways (2026-10-05)

The wave's three tasks were a corpus measurement, a re-judgement and a diagnosis. **None of them changed a file
under `worker/encore_worker`**, so this sweep's job was to produce the 28-song accuracy baseline on LIVE rows
rather than on a re-summarise, and to prove that the only thing that moved in `results/` is the honesty
metadata. Bench runner 2026-10-05, code **`4804fae43eb43d7c`**, harness `3258a1abe14a4f4e`, HuBERT-Large,
32 songs × 16 modes = **1088 cases at each of three levels** (`--level time_text`, `--level run_align`,
`--level run_align --sync-mode lines`), seed 0, wrong_k 10, `--tfr-audio youtube`, mps, 0 ERROR rows.
Rows: `results/w8b-{time_text,run_align,lines-run_align}.json`, runs `_runs/w8b-{tt,ra,lines}`.

**COST: NOTHING. The emitter key did not move.** W8b touched no file in `WhisperXAligner.emissions`' module
closure and no `align_*` setting, so the fingerprint is the one W8a's default swept on: `time_text` 1067.6 s
(63 disk reads, 1222 memory hits, **0 computed**), `run_align` 1044.7 s (60 / 1201 / **0**), the `lines` rung
903.9 s (32 / 1024 / **0**) — **3016.2 s for 3264 cases and not one HuBERT matrix recomputed.** The budgeted
full HuBERT-L pass was not spent.

### Byte-identical to W8a's recorded default, cell by cell

Not "the pooled numbers agree": every case compared field by field against the committed
`results/w8a-{time_text,run_align,lines-run_align}.cases.jsonl`, nested dicts sub-key by sub-key, skipping only
the harness's own `code` fingerprint.

| level | cases | shared cells compared | differ | fields only in the new run |
| ----- | ----: | --------------------: | -----: | -------------------------- |
| `time_text` | 1088 | 31 920 | **0** | `accuracy_excluded`, `words.published`, `words.published_pm100` |
| `run_align` | 1088 | 39 160 | **0** | same three |
| `lines` | 1088 | 40 780 | **0** | same three |

**111 860 cells, 0 differences.** The three gained fields are exactly the wave's two deliverables: the
per-case exclusion reason, and the provenance-blind word counters `gates/w8b-arms.yaml` reads. So the 28-song
baseline below is a re-reading of the shipped default and not a new behaviour, which is the only basis on which
a re-based gate file can be trusted.

### THE 28-SONG BASELINE, live

`corpus-truth.json` excludes **bad-guy** (truth leads its audio by 834 ms), **believer** (460 ms),
**tfr-chosen** (540 ms) and **numb** (+620 ms envelope lag at r 0.702 — the one reading here that does not come
from the aligner — corroborated by +690 ms from the forced rung's own blind decode, which IS the aligner's
median residual against that sheet; `unusable: continuous-vocal`, its stem never quiet at a truth start). All
four stay in the corpus.

| at `truth` | 32 songs (`all`) | 28 that score (`scored`) |
| ---------- | ---------------: | -----------------------: |
| `run_align` ±500 | 90.45 (CI 81.13–96.47) | **97.07** (CI 95.97–98.35) |
| `run_align` scored lines | 1707 | 1504 |
| `run_align` band / missing | 163 / 53 | **44** / 32 |
| `run_align` gross | 0 | 0 |
| `run_align` `high` / `high_bad` | 1393 / 94 | 1253 / **0** |
| `time_text` ±500 | 90.89 | **97.12** (CI 96.03–98.38) |
| `time_text` band / missing | 158 / 25 | **44** / 10 |
| `time_text` `high_bad` | 82 | **0** |
| `lines` rung ±500 | 94.16 | **100.00** |
| `lines` rung band | 100 | **0** |

The `high_bad` column is the reading W8a could not state: over the 28 the confidence grade over-claims on
**nothing** at `truth`, `off05`, `off15`, `off3`, `offm1`, `tempo098`, `tempo102`, `drop20`, `drop50`,
`extraverse`, `headers` and `credit`. It is not 0 everywhere — `jit` keeps 7 (`run_align`) / 13 (`time_text`)
and `blind` 43 — and those are pipeline readings, not truth quality.

**Jamendo is untouched**, as it must be: all 20 of its songs score and the four excluded have no word truth.
`words 5378/5693`, ±100 **85.46**, ±300 **97.16**, AAE **71.1 ms**, PCO@.3 91.76, highlight **81.40 %** read
IDENTICALLY in `jamendo`, `scored` and `all` on this sweep, at both levels. ±500 on Jamendo is 98.15
(CI 96.62–99.43).

### The remaining accuracy lead, after the exclusion, is ONE song

Worst eight of the 28 at `truth` / `time_text`: `Kinematic_-_Peyote` **71.43** (band 4, bias −33.2, MAD 30.2,
14 lines), `Avercage_-_Embers` 92.86, `never-be-alone` 93.48, `shape-of-you` 94.32, `Rxbyn_-_Bad_Side` 94.44,
`feel-my-heart` 94.59, `tfr-flyaway` 94.67, `rap-god` 94.93. **15 of the 28 are at 100 %, 20 of 28 at or above
95 %, and exactly one sits under 80 %** — which is why `gates/w8a.yaml`'s `sound-truth-songs-above-80-truth`
reads `[1 == 0]` on the shipped default at both levels. That one song is the song `band-reopen` fixes
(71.43 → 92.86), and that arm is default-OFF because W8b re-judged its rejection and the rejection stood.

### The gate readings, all of them

| gate file | base | `time_text` | `run_align` | `lines` |
| --------- | ---- | ----------- | ----------- | ------- |
| `w8b.yaml` (new) | `w8b-base-{tt,ra}` | **154/154** | **154/154** | n/a |
| `w8b-lines.yaml` (new) | `w8b-base-lines` | n/a | n/a | **94/94** |
| `w8b-arms.yaml` | `w8b-{time_text,run_align}` | **77/77** | **77/77** | n/a |
| `w8b-arms.yaml` | `w8a-{base-tt,band-ra}` | 69 + 8 ERROR | 69 + 8 ERROR | n/a |
| `w8a.yaml` | `w8a-{base-tt,band-ra}` | 150/154 | 150/154 | n/a |
| `w8a-default.yaml` | same | 103/103 | 103/103 | n/a |
| `w8a-band.yaml` | same | 111/111 | 111/111 | n/a |
| `w8a-fix.yaml` | `w8a-band-ra` | — | 93/94 | n/a |
| `w8a-lines.yaml` | `w8a-base-lines` | n/a | n/a | **99/99** |

`w8a.yaml`'s four red rules are the same four at both levels and they are the ones
`test_the_wave_gates_read_both_levels_they_are_written_for` already declares owed:
`sound-truth-songs-above-80-truth` [1 == 0], `best-song-gain-truth` [0 ≥ 21], `best-song-gain-jit` [0 ≥ 14],
`band-down-truth` [163 ≤ 162 / 158 ≤ 157]. All four ask W8a's default-OFF arm to have happened; none is a
regression. `w8a-fix.yaml`'s single red is `band-down-truth`, the same rule.

**`gates/w8b-arms.yaml` reads 77/77 on the DEFAULT at both levels**, which is the live reading its own header
predicted and the open issue W8a's re-judgement left behind: its `word_published_*` floors ARE the default's
numbers, so the file now sits exactly on them with rows that carry `words.unaligned_errors` for the first time.
Read against the pre-W8b bases the eight `published-held-*` rules of section 4 ERROR instead, because those rows
recorded no published onsets at all — the same fail-loud direction the absolute floors have on a pre-W8b RUN, and
the reason the file's `--compare` base from here is the matching level's own W8b row.

### What `w8b.yaml` refuses, measured rather than asserted

Read on the arms-on rows (`_runs/w8ar2-arms-ra` re-summarised) against the default, the file's identity half
goes red on exactly seven rules — `docs-unchanged-{truth,jit,drop50}`, `onsets-unchanged-{truth,jit}`,
`no-song-gains-{truth,jit}` — while every accuracy floor PASSES, because the arm is a line-timing gain. That is
the shape of change this file exists to see, and it is pinned in
`test_the_twenty_eight_song_gates_reject_a_tree_whose_documents_moved`.

The band rule is an equality in both directions on purpose: `count(|bias| > 250 and MAD ≤ 250)` is **0** over
the 28 at `truth` and **4** over the 32 (believer, numb, bad-guy, tfr-chosen — the excluded set exactly), so a
counter that stopped counting fails the second rule instead of passing the first. `drop50` is deliberately not
gated this way: a song can finish that mode with no scored line and so no `bias_ms`, and
`HILA_-_Give_Me_the_Same` at `run_align` is that song — a reduction over a missing value is an ERROR by design.
Over the 28 `drop50` keeps 4 songs past 250 ms at `run_align` and 5 at `time_text`, so the counting demonstrably
fires on the scored pool too.

### W8b review round 2: what it changed, and what it did not

Twelve confirmed findings, all in the harness and its gate files; **no file under `worker/encore_worker` was
touched, so not one published timing moved.** Every committed row still reads what the tables above say
(`w8a.yaml` 150/154, `w8a-fix.yaml` 93/94, `w8a-lines.yaml` 99/99, `w8b.yaml` 154/154, `w8b-lines.yaml` 94/94),
and `corpus-truth.json` still excludes the same four songs — re-measured fresh over all 32 stems (4.2 s, no
model) with every previously recorded number reproduced to the digit.

What a later reader needs to know:

* **`meta.harness` moved**, as it must: the review edited `e2e_lib.py`, `e2e_gates.py`, `e2e.py` and
  `corpus-truth.json`, and all four are in the fingerprint. The W8b sweep's rows were taken at harness
  `3258a1abe14a4f4e` and this tree reads **`447216b0e51be71c`**. No summary NUMBER differs between the two —
  the exclusion set, the group membership and every metric are unchanged — so a re-sweep buys nothing but a
  new fingerprint, and the recorded rows stay the measurement of record.
* **The reason strings in `results/` are frozen at run time** and were not rewritten: see
  `meta.accuracy_excluded` above. A committed file's pool and its grounds are held to the live corpus file by
  `test_a_committed_results_file_records_the_reason_its_own_sweep_read`; its wording is history.
* **One new results row, 0 model seconds**: `results/w8b-arms-run_align.json`, W8a's arms rows re-summarised so
  `gates/w8b.yaml` can be read WHOLE on a tree whose documents moved (`_tools/resummarise.py`).
* **`corpus-truth.json` gained a required field** (`starts_level_median`) and two published limits
  (`min_lag_correlation`, `continuous_vocal_level`). A pre-review copy of the file no longer loads, which is the
  intended direction: the rule reads fields that must be measured, not assumed.

## W9: the star re-fitted out of sample, at an optimum outside the review's range (2026-10-09; review §3 item 10 / D3)

W7 built §3.10's star, fitted `P = 1.0`, and the corpus read **rejected** it (`gates/w7-star.yaml` 32/36, the
section above). But that fit named its own correction: the sweep's optimum for a sheet with lines missing sat
at **0.1–0.3**, *below* review §3.10's proposed `[1, 4]`, and 1.0 was chosen partly because it was *inside* the
range the review specified. A verdict taken at a value the data does not pick is a verdict about the value, not
about the mechanism — and the mechanism is the only one in the build that lets the decode say *these words are
not in this audio*. So P is re-fitted here, on the region the correction points at, and **the sweep is the
result; the single value is a consequence of naming an objective.**

Same harness, same stored matrices, no model pass: `_runs/w9-star/star_sweep9.py` (W7's with the emitter
PINNED, the accuracy pool carried per row, and the fine grid) + `star_report9.py` + `star_record9.py`. The grid
is now **19 arms — 18 values of P plus the `off` control** — W7's 15 arms merged with 0.05, 0.15, 0.35 and
0.45 — over 32 songs × 4 text modes, 2 432
decode rows, 90 s of Viterbi for the new ones. Every number below is recomputable from the committed digest
`results/w9-star-sweep.json` (both pools, per mode, per group, per song, per song×mode gross, and all four
fits); the raw per-line errors stay in `_runs/w9-star/` and `_runs/w7-star/`.

**Two provenance checks first, because this re-reads W7's own file.** (1) The 0.75 arm and the `off` control
were re-decoded on W7's emitter key (`a51283424a0195e1`): **256 overlapping cells — 2 arms × 32 songs × 4
modes — 0 differ** in gross, ±500, scored, `in_text`, `missing` and both error summaries, so W7's sweep
reproduces on this tree. (2) The whole fine region was then decoded a second time on the emitter key W8a used
(`1a2fd6852bd30243`, today's warm store): **640 shared cells — the 5 arms the two passes have in common ×
128 — 0 differ**. The two stored HuBERT-Large sets are value-identical, so the fit does not depend on which
one a later wave happens to read, and the emitter fingerprint moved with code that does not move a matrix.
Both counts are recomputable from `_runs/w9-star/{fine9,replicate9}.json` against `_runs/w7-star/{sweep,fine}.json`.

### The denominator, named before the numbers

`±500/t` is `w500 / in_text` over **every truth line the served text holds**, so a line the decode never placed
is a MISS, not an absent row. `missing` is **4 of 5 068 on every row of the grid, the control's included** — no
arm here buys anything by dropping lines. That is the artefact the critics caught in the review's scratch
scorer (published-lines-only, which turned a loss into "68 → 64"), and the one W8b found under the band arms.
The headline basis is the **28 songs that score** (`corpus-truth.json`; `bad-guy`, `believer`, `numb` and
`tfr-chosen` are measured for robustness and excluded from accuracy, W8b above) — so these numbers are NOT
comparable to the 32-song table in the W7 section, whose control reads gross 713 / ±500/t 72.40. On this pool
the same control reads **609 / 78.31**.

### The sweep, 28-song accuracy pool, all four modes (5 068 lines served, 5 064 scored)

| P | gross | ±250/t | ±500/t | AAE ms | MedAE ms |
| --- | --- | --- | --- | --- | --- |
| **off** | 609 | 72.67 | 78.31 | 1 078 | 83 |
| 0 (MMS) | 434 | 72.73 | 81.08 | 1 414 | 94 |
| 0.05 | 387 | 79.62 | 85.54 | 1 024 | 70 |
| **0.1** | **378** | **80.05** | **85.95** | 914 | 70 |
| 0.15 | 383 | 79.76 | 85.79 | 956 | 70 |
| 0.2 | 384 | 79.58 | 85.91 | 936 | 70 |
| 0.25 | 379 | 79.38 | 85.56 | 913 | 70 |
| **0.3 (ships)** | **384** | **79.81** | **85.67** | **906** | **70** |
| 0.35 | 395 | 79.72 | 85.62 | 930 | 70 |
| 0.4 | 400 | 79.56 | 85.56 | 930 | 70 |
| 0.45 | 397 | 79.58 | 85.64 | 848 | 70 |
| 0.5 | 397 | 79.22 | 85.24 | 831 | 70 |
| 0.75 | 429 | 78.73 | 84.63 | 834 | 71 |
| 1 (W7's) | 464 | 77.86 | 83.84 | 891 | 73 |
| 2 | 522 | 75.83 | 81.71 | 977 | 77 |
| 4 | 560 | 74.82 | 80.72 | 1 007 | 79 |

**The region is FLAT and it is the whole finding.** Every value from 0.05 to 0.5 reads gross 378–400 and ±500/t
85.2–86.0; the differences inside it are 1–20 lines of 5 068 and are not a ranking anyone should trust. What is
not flat is the distance to the ends. Against the **shipped P = 0.3** — naming the reference, because the
region's rows differ by less than the gap being described — review §3.10's own band costs **80 gross lines and
1.8 pt** at `P = 1` and **176 lines / 5.0 pt** at `P = 4`; against the region's best row, `P = 0.1`, the same
two gaps are 86 / 2.1 pt and 182 / 5.2 pt. The MMS constant 0 is still the one value that makes the full sheet
worse (below), reproducing the review's "over-eager" objection.

### Per mode: the trade the single number is making (gross / ±500/t)

| P | full sheet (1 536) | drop20 (1 233) | drop50 (763) | extraverse (1 536) |
| --- | --- | --- | --- | --- |
| **off** | 60 / 86.98 | 171 / 75.51 | 280 / 52.69 | 98 / 84.64 |
| 0 (MMS) | **88** / 83.98 | 104 / 81.27 | 129 / 73.26 | 113 / 81.90 |
| 0.05 | 70 / 88.67 | 93 / 85.97 | **120** / **77.72** | 104 / 85.94 |
| 0.1 | 65 / 89.13 | **89** / **86.54** | 123 / 77.72 | 101 / 86.39 |
| 0.2 | 65 / 89.13 | 93 / 86.13 | 124 / 77.59 | 102 / 86.65 |
| **0.3** | **60** / 89.26 | 90 / 86.05 | 134 / 75.88 | 100 / 86.65 |
| 0.5 | 56 / 89.71 | 92 / 85.40 | 159 / 72.21 | 90 / 87.11 |
| 1 (W7's) | 54 / 90.04 | 123 / 82.89 | 197 / 65.66 | 90 / 87.43 |
| 4 | 53 / 89.32 | 155 / 78.02 | 265 / 55.70 | 87 / 86.72 |

The two ends of the grid are two different jobs. A dear star (P ≥ 0.75) is cheap insurance on a sheet the audio
covers — full-sheet gross 54 against the control's 60 — and buys almost nothing where half the lines are gone
(drop50 197 against 280). A cheap star (P ≤ 0.2) nearly halves drop50 (123 against 280, ±500/t 52.69 → 77.72)
and costs the full sheet 5 gross lines. **P = 0.3 is the value that takes the partial-sheet win without
costing the full sheet a single gross line** (60 = 60, ±500/t 86.98 → 89.26), which is the column §3.10's
reject-if is written over and the column W7's arm died in. Per group at 0.3: Jamendo gross 327 → **199**
(±500/t 81.88 → **89.53**, 2 864 lines), YouTube 282 → **185** (73.68 → **80.67**, 2 204).

### Out of sample, twice, under four objectives

W7 was explicit that the review's P was tuned in-sample. Each objective below is fitted on songs the read is
then taken on NONE of: leave-one-song-out over the 28 (fit on 27, read the held-out song at that P) and a
2-fold interleaved split (fit on 14, read the other 14). `guarded` is §3.10's reject-if expressed as an
objective rather than a verdict — the best pooled ±500/t among the arms that cost the full sheet no gross line
and no more than 0.5 pt.

| objective | in-sample P | in-sample | LOSO held-out | LOSO picks | 2-fold held-out |
| --- | --- | --- | --- | --- | --- |
| `w7` (gross, then ±500/t) | 0.1 | 378 / 85.95 | **398 / 85.42** | 0.1 ×24, 0.25 ×3, 0.3 ×1 | 382 / 85.46 |
| `pm500` (±500/t alone) | 0.1 | 378 / 85.95 | **392 / 85.54** | 0.1 ×23, 0.2 ×5 | 382 / 85.46 |
| `partial` (drop50 ±500/t) | 0.05 | 387 / 85.54 | **410 / 85.12** | 0.05 ×20, 0.1 ×5, 0.2 ×2, 0.15 ×1 | 383 / 85.77 |
| `guarded` (§3.10's clause) | **0.3** | 384 / 85.67 | **406 / 85.06** | 0.3 ×14, 0.45 ×9, 0.15 ×2, 0.35 ×2, 0.25 ×1 | 389 / 85.20 |

Three things worth reading off it. (1) **The optimism is small and the win survives it**: the worst held-out
read on the table is gross 410 / ±500/t 85.12 against a control of 609 / 78.31, so the out-of-sample gain is
**−199 gross lines and +6.8 pt**, not an artefact of fitting. (2) **The fine region is where every objective
lands** — the largest P any objective picks in any fold is **0.5** (`guarded`, one of the two 2-fold halves),
and the review's `[1, 4]` is picked by none of them in any fold. (3) **The vote is only stable for the
unconstrained objectives.** `w7` and `pm500` pick 0.1 in 23–24 of 28 LOSO folds; `guarded` splits 0.3/0.45
(and 0.5/0.1 across the two halves) because a constraint on a discrete gross COUNT is a step function one
song can move. So the honest statement is a region and a rule, not a digit: **P ∈ [0.1, 0.3]
out of sample, and 0.3 is its conservative end** — the least eager star in the region, the one that holds the
full sheet, and the closest to the band the review proposed. `ml.STAR_PENALTY_NATS = 0.3`.

### One song through the whole ladder: the line that killed W7's arm (n = 1, NOT the verdict)

The arm was rejected on 14 YouTube cells of which **11 were `never-be-alone` losing one line of its 47 to
`missing`**, in 11 of 16 modes *including* `truth`. That song, that level, both arms, code `28e8cccbc63012d1`,
HuBERT-L on MPS, `--asr off`, emissions warm (`_runs/w9-star-spot-{off,on}`, 30 s + 54 s):

| mode | arm | in_text | missing | scored | gross | band | ±500/text | `high` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| truth | off | 47 | **1** | 46 | 0 | 3 | 91.49 | 23 |
| truth | **star @ 0.3** | 47 | **0** | **47** | 0 | **2** | **95.74** | **27** |
| drop50 | off | 23 | **0** | 23 | 0 | 15 | 34.78 | 0 |
| drop50 | **star @ 0.3** | 23 | **2** | 21 | 0 | 14 | **30.43** | 0 |

**At `truth` the clause inverts**: the arm publishes the line the default loses (`missing` 1 → 0) and improves
±500/text by 4.25 pt with gross still 0, where at P = 1.0 it *lost* a second line. The trail says the arm is
live and says the new P — `star: one per line, id 29 = frame max − 0.3 nats, its frames blank (star)`. **At
`drop50` the same song loses two lines to `missing`**, so the arm has not stopped being able to trip
`missing_up`; it has stopped tripping it on the path that publishes. One song is one song: this is an existence
proof that the honest P changes the sign of the deciding cell, not a re-verdict.

### The claims path at P = 1.0, re-read on the 28 — W7's REJECTION IS NOT A DENOMINATOR ARTEFACT

Everything above is the blind decode. §3.10's reject-if is about the path that **publishes**, and W7 took that
verdict on the 32-song `all` pool — so before writing a gate file for the re-fit, the old verdict was re-read
on the honest basis. This costs no corpus run: `_runs/w7-star-run_align/rows.jsonl` and `_runs/w7-ra/rows.jsonl`
re-summarized by today's harness gain the `scored` group their committed summaries predate.

**The arm at P = 1.0 fails every clause it failed before, and the per-song one gets WORSE.** The 32-song clause
is YouTube-only; `scored` holds Jamendo too, so it reads **15** cells where the review's wording reads 14.

| clause | 32-song `all` | 28-song `scored` |
| --- | --- | --- |
| song gains a gross or missing line | 14 cells (YouTube) | **15** cells |
| `truth`: no song loses lines | 1 | 1 |
| `sum(song.high_gross)` | 3 ≤ 2 | 3 ≤ 2 (`hello` blind 0 → 1) |
| `min_song_delta(truth.jamendo.word_pm300)` | −4.26 pt | −4.26 pt (`jamendo` ⊂ `scored`, 20 of 28) |

So the two artefacts this build already caught — the review's published-lines-only scratch scorer and W8b's
band arms — do **not** explain W7's verdict. It stands on the pool that matters.

**And the number this wave was told to re-read on today's basis.** "drop50 gross 82 → 44 with ±500/text
75.72 → 81.90" is a 32-song reading. On the 28 the same two runs read **gross 69 → 33, ±500/text
79.42 → 87.42, `missing` 45 → 18 of 763 served, `scored` 718 → 745** — the arm publishes **27 more lines** and
places them **8 pt better**, which is the one shape a denominator artefact cannot have. Across the other modes
at P = 1.0: `truth` ±500 97.07 → 97.41 with gross 0 and `high_bad` 0 both held, `jit` 92.69 → 94.22, `blind`
gross 49 → 41 and ±500 87.97 → 89.23, `extraverse` 97.43 → 97.96. What it costs is the PLAN's pinned **word**
row — ±100 85.46 → 84.94, ±300 97.16 → 96.81, AAE 71.1 → 74.1 ms — and two scored lines at `drop20`
(1209 → 1207). Partial-sheet line starts bought with full-sheet word onsets: the trade W7 named, confirmed on
the pool it should have been named on.

**Which way the re-fit moves those clauses, stated against our own interest.** 11 of the 15 regressing cells
are ONE song: `never-be-alone` losing one line of its 47 to `missing`, in 11 of 16 modes including `truth`. The
other four are `Avercage_-_Embers` blind +1 gross, `shape-of-you` blind +1 gross, `Kinematic_-_Peyote` drop50
+2 `missing`, `tfr-mayday` drop20 +1 `missing`. The spot check above decoded that song at P = 0.3 and `truth`
**inverts** (`missing` 1 → 0, ±500/text 91.49 → 95.74, gross still 0), which is why a corpus read is owed —
but P = 0.3 is a **cheaper, therefore more eager** star than 1.0, and the decode sweep reads the full sheet 54
gross at P = 1 against 60 at P = 0.3. The clauses W7 died on are full-sheet-path clauses, and lowering P moves
them the **wrong** way. One song inverting is an existence proof, not a prediction.

### What the hermetic fixture can and cannot say about P (review W9 r1-tests-12)

`tests/test_star.py`'s `tempting()` fixture is an EAGERNESS test, not a fit. Its ladder, frames the forced
path spends on a star over `LINES[1:]`:

| P (nats) | 0.0 | 0.05 | 0.1 | 0.3 | 0.5 | 1.0 | 2.0 | 4.0 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| star frames | 156 | 89 | 89 | 89 | 89 | 89 | 2 | 2 |

The intro the star has to absorb is 90 frames, so the fixture's own cliff falls between **1 and 2 nats** and
every value from 0.05 to 1.0 reads identically on it. Two consequences, both of them properties of the
fixture rather than of the arm: the review's proposed [1, 4] band STRADDLES this cliff rather than sitting
above it, and no symbolic test here can tell the shipped 0.3 from W7's 1.0 — mutating the constant to 1.0
left the whole suite green. The discrimination is the corpus's (the tables above), so the shipped value is
pinned as a LITERAL in `test_the_shipped_penalty_is_the_one_the_corpus_fitted`, the way
`tests/test_viterbi.py` pins the arcs' 30.0 / 6.0.

### What is settled here, and what is not

Settled: P was fitted out of sample on the 28 songs that score, under four named objectives and two
hold-out schemes, over a grid that extends past the optimum on both sides; the fit is invariant to which
stored matrix set is read; at the decode the shipped value costs the full sheet nothing; and W7's claims-path
rejection survives the move to the accuracy pool rather than dissolving into it.

NOT settled, and not settleable without a corpus run: whether the re-fitted P clears §3.10 on the path that
publishes. The arm therefore stays **default-off behind `ENCORE_ALIGN_EXPERIMENTS=star`** until that read says
otherwise. The file to read it with is the new **[`gates/w9-star.yaml`](gates/w9-star.yaml)**, not
`w7-star.yaml`, whose pooled rules are on the 32-song pool and whose header is about a different arm; the new
file puts §3.10's clause on both bases, floors `in_text` / `scored` so no percentage can be bought by
refusing, and carries the pinned truth row (±500 97.07, gross 0, `high_bad` 0, `line_sync` 0, Jamendo words
±100 85.46 / AAE 71.1 ms) as absolute literals. Its three scored readings — the default against itself at
**69/70** (69 parsed rules plus the built-in; the one FAIL is the `pooled-gross-down` SHOULD), the P = 1.0 arm
rejected on **8** clauses readable from the committed pair, and **39** ERRORs against a pre-W8b baseline — are
pinned in `tests/test_bench_e2e.py`. Default-off with the new sweep recorded is a legitimate
outcome of this task; so is default-on if the corpus says so.

## W9: a vendored decoder, and the three arms it unblocks (2026-10-14; review §3 items 14 + 15, star phase B)

The research track. One new decoder — `domain/lyrics/viterbi.py`, a pure-numpy CTC Viterbi with int8
backpointers in the style of NeMo's `aligner_utils` (Apache-2.0) — and the three things a *fixed* kernel
cannot be asked to do, each expressed as arcs in its graph: **skip arcs over an optional line** (review
§3.15), **a star that may be bypassed** (phase B of §3.10), and **a claim prior inside the decode** (§3.14).
Six knob names for the three arms, because §3.14 has two halves that are worth measuring apart and the
review named a fourth combination as the one that decides it:

| `ENCORE_ALIGN_EXPERIMENTS` | what it is |
| --- | --- |
| `vendored` | the **control**: an empty graph, so the decoder swap and nothing else |
| `skip-arcs` | §3.15, as a **complement** to the never-sung rule (repeats exempt, 30 + 6/char) |
| `star-b` | phase B: §3.10's token, in a graph that may bypass it |
| `claim-priors` | §3.14's capped-Gaussian onset bonus at each line's first-character state |
| `claim-fusion` | §3.14's other half: the mix fused in where the stem is mute inside a claim window |
| `priors-decide` | the review's **deciding arm** — priors + fusion + optional lines, the ladder bypassed |

Every one of them ships **default-off**. The design is `docs/arch/04-alignment.md` §3.2 and invariant XA-18;
the corpus verdict is **owed, not recorded** (the last section below), and the file to take it with is
[`gates/w9-research.yaml`](gates/w9-research.yaml).

**`F5` was stale and this is not urgent-by-removal.** The review's F5 said `torchaudio.functional.forced_align`
was being deleted in 2.9; W4b found 2.10 and 2.11 both keep it. The vendored decoder's value is not insurance
against a removal — it is that the three arms above cannot be written without it.

### The swap is free, and that is held two ways

An alternative decoder is only worth having if swapping it in is **provably** free; otherwise every arm
measured through it is measuring the swap as well. So on an empty `Graph` the vendored decoder is the kernel
**frame for frame**: the same three-way tie-break (a step or a blank-skip only when *strictly* best), the same
choice of final state (the trailing blank only when *strictly* better), float32 accumulation, and `ValueError`
wherever the kernel refuses.

Two legs, because each one alone has a hole:

* `tests/test_viterbi.py::test_an_empty_graph_is_the_fixture_kernel_frame_for_frame` — against
  `tests/ctc_fixture.py`'s `ctc_viterbi`, **without torch**, so it runs everywhere.
* `tests/test_ml_contract.py::test_the_vendored_decoder_is_the_real_kernel_frame_for_frame` — against
  `torchaudio.functional.forced_align` **itself**. This is the leg that makes the claim true; the fixture is
  only *held* to the kernel by a sibling test, and a chain of two approximations is not a proof.

Both run the same 80 cases and assert `compared >= 60` so neither can pass vacuously: 40 real windows sliced
out of a sung matrix, 20 **flat** matrices (`-3.3` everywhere — the exactly-ambiguous case, where tie-breaking
is the *only* thing that decides the path) and 20 random log-softmax matrices, with 1–65 targets over 10–199
frames. Cases the kernel refuses must raise `ValueError` from the vendored one too, and do.

The third leg is at the step: `tests/test_research_arms.py` runs `time_text` twice over one fixture and
compares the **published documents**, so a drift anywhere between the matrix and the file — spans, leads,
ends, grades — would show. `gates/w9-research.yaml`'s `vendored-control-changes-no-document` is the same claim
on the corpus, and it is the clause the rest of the file rests on.

### What the graph adds

**Skip arcs (§3.15).** One penalised arc per line, from the blank *before* its first character to the blank
*after* its last, priced `SKIP_LINE_NATS + SKIP_CHAR_NATS × characters` = **30 + 6/char**, the review's refined
α/β pair. Blank-to-blank on purpose: the bypassed line's neighbours stay separated by a blank frame, so no two
character runs can merge and XA-11's span count still holds. A **repeated line is exempt** — the arc has no way
to tell which occurrence is which, so bypassing one is as likely to drop the sung chorus as the unsung one; the
step computes that set and `viterbi.line_skips` honours it.

It ships as a **detector, not as the publishing decode**: the lines it names are blanked and the shipped decode
runs again without them, which is exactly what the never-sung rule does to a line it grades unsung. That is
what makes it a *complement* and not a replacement — the arcs run first, on the blind decode, and the
three-signal rule then grades what is left. The review measured the replacement at **+21 gross and +17 false
drops per 1 760 clean blind lines**, and the complement at **+1 gross and 0 false drops** against the shipped
rule's 4; the complement is the only one of the two that was ever worth building.

**The star, phase B.** The star state emits `frame max − P` computed *in the graph*. The new power over phase A
is that it may be **bypassed for free**, through two arcs — from the blank before it, and from the character
before that — which together make the starred graph a strict **superset** of the plain one: every plain path
exists in it at the same score, so a large `P` reproduces the plain decode exactly (pinned as
`test_a_huge_star_penalty_reproduces_the_plain_decode`, and `test_the_star_only_ever_helps_the_path…` checks
the other direction at P = 0.1, 0.3, 1.0 and 4.0). A fixed kernel cannot express that: a target in the sequence
must be visited. At one `P` the star state's value is exactly what `ml.starred`'s appended column holds, which
is why the two phases share one fitted penalty — so phase B inherits W9's re-fitted **P = 0.3** (the section
above) rather than fitting its own.

**The onset prior (§3.14).** `prior.onset_bonus` builds, per line, nats added at that line's first-character
state: a Gaussian centred on the **clock-mapped** claim (XA-04 — a raw claim would centre the bonus on the
sheet's own offset), peak `ONSET_BONUS_NATS` = 4.0, width `ONSET_SIGMA_SEC` = 0.6 s, truncated to zero beyond
`ONSET_REACH_SEC` = 2.0 s so a mis-bound repeat cannot pull a line across the song. **The 4.0 is UNFITTED** —
the review never ran the arm that would fit it, and a sweep is owed before the number means anything. The 0.6 s
is deliberately wider than the ±300 ms the claims are scored at, because what the prior is *for* is a line the
decode put seconds away.

Two properties of it are worth more than the constants. It is paid **once, on the transition into the state**,
never per frame of dwelling — measured on the *emission* instead, a 20-nat peak parked a line's first character
on the prior's own peak and paid **600 nats of evidence** for the privilege, which is a boundary bonus turned
into a magnet. And a prior is **never added to a reported score**: the score is the word's confidence and a
bonus is not evidence (`test_a_prior_is_never_added_to_a_reported_score` checks every published frame against
the matrix itself).

`prior.fused` is the other half: inside a claim window where the target's envelope hears nothing, the mix's
frames replace the stem's, because there they are the only evidence there is. Note it changes the **evidence**,
not the decoder, so `claim-fusion` alone does not imply the vendored graph.

**Where the arms reach, and where they do not.** The prior and the fusion reach **one** decode — the primed
re-decode, after the claim clock and after the blind verdict grading reads (XA-03, XA-04) — and under
`priors-decide` that decode stands in for the whole repair ladder. A repair window is never handed a graph: its
targets are a different sequence over a slice, so a graph built on global target positions would describe a
decode that never ran. A primed line's provenance is `_Source.PRIMED`, which is not `BLIND`, so grading asks it
for blind corroboration **and** agreement — strictly more than a blind line is asked for, which is the right
direction for a line a claim helped place.

### A fixture that cannot price an arc, and the one that can

Pricing an arc on synthetic evidence is its own trap, and it is worth recording because the next person to
write a step-level test for a penalised arc will hit it. On `ctc_fixture.sung_matrix` the shipped 30 + 6/char
arc **can never pay, at any line length**: in silence the blank sits at `log 0.9` = −0.105 nats and a character
there at `log(0.1/27)` = −5.59, so an unsung character costs about **5.49 nats** against an arc that charges
**6** — the price per character exceeds the evidence per character, so a longer line only widens the gap.

Worse, sharpening the silence does not fix it. Measured on an eight-line fixture with a 34-character credit
line appended (arc price 30 + 6 × 34 = **234 nats**), the saving from bypassing it is **214.2 nats, invariant**
at blank confidences of 0.999, 0.99999 and 0.9999999 — because the monotone path does not put the unsung line
in the sharpened silence at all. It smears it across the **last sung line's spare frames** (frames 1943–1997 of
2500), where `sung_matrix` spreads each character over about four frames and a fifth character costs almost
nothing. 214.2 / 34 = 6.30 nats per character, just under the price, and no amount of silence sharpening moves
a number that was never read off the silence.

What works is taking the spare frames away: one frame per sung character, one blank between. Then an extra
character has to be bought from the silence, and the shipped price pays — at blank confidence 0.99 the arc
bypasses **exactly** the unsung line, saving 268.3 nats against its 234, and at 0.999, 346.9. At the fixture's
own `HIT` = 0.9 it still saves 0.0, so the fixture's confidence is itself the variable. `packed()` in
`tests/test_research_arms.py` is that matrix, and it is why the step-level skip-arc test asserts a real drop at
the **shipped** constants instead of at a fixture price. The unit tests in `tests/test_viterbi.py` keep their
own cheap pair (2.0 + 1.0/char) and say so, which is the honest way to test a mechanism rather than a price.

### One defect, found by the tests and fixed

`claim-fusion` **fused the mix into the decode and said nothing about it on the audit trail.** The step collects
what the decode arms did into one `decode_note` list, and the trail clause that prints it was gated on
`vendored_arm` — but `claim-fusion` changes the evidence and not the decoder, so it does not set that flag.
Under `ENCORE_ALIGN_EXPERIMENTS=claim-fusion` the step would replace frames of the stem's matrix with the
mix's and publish a document whose trail read exactly like a run that had fused nothing. That is the failure
mode the surrounding code is explicit about ("an arm that acted and an arm that went inert must not read
alike"), and it was invisible until a step-level test asked the trail what had happened. `_graph_why` now takes
the decoder it is describing and labels itself `vendored decoder:` or `claim fusion:` accordingly, and the
clause prints under either arm.

### What is settled here, and what is not

**Settled.** The decoder exists, it is bit-compatible with the real kernel on the plain topology over 80 cases
including the flat ones where tie-breaking is the whole decision, and the swap is a byte-level no-op on a
published document at the step. All three arms are built, wired to the one knob, and reachable: the arcs detect
and drop, the star is optional in the graph, the prior tips a placement the evidence is indifferent about
(`test_the_onset_prior_decides_a_placement_the_evidence_is_indifferent_about` — on a flat matrix the line lands
on the claim, ±20 ms, for claims at 2.0 s and 5.0 s), the fusion reads the mix only inside mute claim windows,
and `priors-decide` really does stand the ladder down (on a scattered-claims fixture the `vendored` control
publishes 3 window + 4 mix + 1 blind timings and the deciding arm publishes 8 primed and no repair at all).
**45 hermetic tests** carry it: **23** in `tests/test_viterbi.py`, **20** in `tests/test_research_arms.py` and
**2** in `tests/test_ml_contract.py` (the vendored decoder and the star column, against the real kernel). The
first two counts are derived from the files in
`test_the_readme_counts_the_hermetic_tests_this_track_actually_has`, because this sentence had already drifted
once (review W9 r2-spec-9).

**Not settled, and not settleable without a corpus run:** whether any of them is worth defaulting on. Nothing
in this section is a corpus number — **no bench sweep was run for it** — and the review's own measurements say
what to expect: §3.15's complement is worth about **+1 gross and 0 false drops** against the shipped rule's 4,
which is a small win that the per-song clause can easily eat; and §3.14's prior arm measured **3.1 pt worse at
±500 with truth claims** (85.4 against 88.5) and **4.2 worse on HuBERT**. So the honest prediction is that
`claim-priors` fails, `skip-arcs` is marginal, and the one genuinely open question is `priors-decide`, the
combination the review never ran. **Run the control arm first** (`vendored`), because if it moves a document
nothing else in the file means anything.

`gates/w9-research.yaml` is the file to read them with: 83 rules, one run per arm against the knob-unset cell
of the same tree. It carries the PLAN's 2026-10-09 row as **absolute literals** (truth ±500 97.07, gross 0,
`high_bad` 0, `line_sync` 0, Jamendo words ±100 85.46 / ±300 97.16 / AAE 71.1 ms, highlight 81.40, wrong text
0/320 + 0/320 and 0/640 at the LINE_SYNC rung), holds **gross at 0 in all twelve right-text modes** that read
0 today, floors `in_text` and `scored` so no percentage can be bought by refusing a song, and puts §3.15's own
false-drop risk on the per-song clause. Its three readings — the default against itself failing only the four
SHOULD clauses, the control clause failing at 28 and 37 changed documents on two committed arm runs, and the
pooled 28-song reads ERRORing against a pre-W8b baseline — are pinned in
`tests/test_bench_e2e.py::test_w9s_research_gate_holds_the_standing_bar_and_its_control_clause_bites`.
**Default-off with the arms built and the numbers recorded is the expected outcome of this wave**, and it is
not a failure: the review asked for them to be built and measured, and three of the four are expected to lose.

## W9: the research track, priced on the corpus (2026-10-14)

Five corpus runs, 5440 cases, **0 ERROR rows**, 6035 s of wall clock, one tree per cell, HuBERT-Large, 32
songs, seed 0, `wrong_k` 10, `--tfr-audio youtube`, mps, `--asr off`, `--detector off`. Code
`ee807b0096e456dc` for the four pre-flip cells, `6db0b601a018e8d1` for the post-flip one. The emitter moved
to **`14c8c0a4bfba8627`** — W7's `1a2fd6852bd30243` is dead because `adapters/ml.py`'s bytes are in the
emission key and `STAR_PENALTY_NATS` is in that file — so the store was **cold: 0 of 32 matrices**, and the
first run paid one full HuBERT-Large pass (about 370 s of the `time_text` cell's 1473). Every later cell on
the same `align_config` read the store; `ENCORE_ALIGN_EXPERIMENTS=star` is in the key, so the star cell paid
its own cold pass (about 500 s of 1569).

### The default did not move one byte, and that is the measurement, not the argument

The research track and the star re-fit are reachable only through default-off knobs, so the prediction was
byte identity and the honest way to state it is a digest. Over the **2176 shared cases** of
`_runs/w9-{ra,tt}` against `_runs/w8b-{ra,tt}`, and the **1088** of `_runs/w9-lines` against
`_runs/w8b-lines`:

| compared | cases | `doc_sha256` differs | `onsets_sha256` differs | `outcome` differs | `confidence` differs |
| --- | --- | --- | --- | --- | --- |
| `run_align` | 1088 | **0** | **0** | **0** | **0** |
| `time_text` | 1088 | **0** | **0** | **0** | **0** |
| `run_align --sync-mode lines` | 1088 | **0** | **0** | **0** | — |

Every printed cell of `--compare` reads `(=)` at both forced levels, and the only deltas the table prints at
all are the 28 `(+0.0)` of the per-song best/worst lines. The 28-song `scored` row is therefore the PLAN's
2026-10-09 row exactly: `truth` ±500 **97.07**, ±500/text 95.05, **gross 0**, `high_bad` **0**, 28 of 28
zero-gross songs, Jamendo words ±100 **85.46** / ±250 96.58 / ±300 **97.16** / AAE **71.1 ms**, highlight
**81.40 %**, wrong text **0/320** and own-clock **0/320** at both forced levels and **0/640** at the
LINE_SYNC rung (320 + 320 cases, 0 published). The lines rung reads `truth` ±500 **100.00**.

Gate files re-read on this tree: the new [`gates/w9.yaml`](gates/w9.yaml) **88/88 at both forced levels**,
`w8b.yaml` 154/154, `w8b-arms.yaml` 77/77, `w8b-lines.yaml` 94/94 on the lines cell, `w7.yaml` 45/45,
`w7-{truth,words,wrongtext}.yaml` 18/18 + 25/25 + 10/10, `w4b.yaml` 30/30. `w8a.yaml` reads 150/154 and
`w5.yaml` 38/40, and **both sets of failures are identical on W8b's own committed rows** — they are those
waves' arm clauses (`best-song-gain-*`, `band-down-truth`, `w5-*-unsung-down`) read against a default pair,
where they can never hold. Not regressions; checked by re-reading both files on `_runs/w8b-{ra,tt}`.

### The star at the re-fitted P = 0.3: a very large win on the partial sheet, rejected on the full one

`ENCORE_ALIGN_EXPERIMENTS=star` against the same tree with the knob unset (`_runs/w9-star-on-ra` against
`_runs/w9-ra`), read with [`gates/w9-star.yaml`](gates/w9-star.yaml): **62 PASS, 10 FAIL, 0 ERROR** (56/9/0
as the file was first written; review W9 r1-spec-11 added §3.7's five `high_bad` clauses, one of which the arm
trips, and r2-spec-7 the two `word_aligned` count pins the arm passes). The arm **stays default-off**. What it buys, on the 28-song `scored` basis:

| 28-song `scored` | `star` off | `star` on, P = 0.3 |
| --- | --- | --- |
| `drop50` gross | 69 | **0** |
| `drop50` ±500/text | 79.42 | **93.32** |
| `drop50` ±500 | 84.40 | **95.83** |
| `drop50` missing / scored | 45 / 718 | **20 / 743** |
| `blind` gross | 49 | **42** |
| pooled `scored` gross, 14 modes | 118 | **42** |
| `truth` ±500 | 97.07 | **97.34** |
| `truth` ±500/text | 95.05 | **95.44** |
| `truth` missing / scored | 32 / 1504 | **30 / 1506** |
| Jamendo `truth` highlight | 81.40 | **81.94** |

**W5's number to beat, re-read on today's basis.** The figure this wave was sent to improve was `drop50`
gross **82 → 44** with ±500/text 75.72 → 81.90, a 32-song `all` reading of the star at P = 1.0. On the same
32-song pool the re-fitted P reads **82 → 11** with ±500/text 75.72 → **86.03** — another 33 gross lines and
4.1 points past what the review's P bought. `never-be-alone`'s `truth` cell inverts exactly as the spot check
predicted (47 of 47 lines, ±500 91.49 → **95.74**), so the one existence proof held at corpus scale.

**And why it is still refused.** Ten clauses fail, and they split in two:

| clause | reading | verdict |
| --- | --- | --- |
| `truth-jamendo-word-pm100-at-least-85-46` | 85.46 → **85.02** | denominator artefact — see below |
| `truth-jamendo-word-pm300-at-least-97-16` | 97.16 → **96.98** | denominator artefact |
| `truth-jamendo-word-aae-at-most-71-1` | 71.1 → **72.7 ms** | denominator artefact |
| `truth-scored-word-pm100` / `-aae` | the same two numbers on the 28 | denominator artefact |
| `no-scored-song-gains-a-gross-line` | **6 cells** | real |
| `no-youtube-song-gains-a-gross-line` | 4 cells | real |
| `no-jamendo-song-worse-at-word-pm300` | `min_song_delta` **−5.19 pt** (bound −1.0) | real |
| `scored-lines-not-down-drop20` | 1209 → **1208** | real |
| `jit-high-bad-not-up` | `jit` `high_bad` 7 → **8** | real — §3.7's own rule |

**The grading clause is the tenth, and it was missing.** §3.7 says a `high` line that is WRONG may not rise;
`high_gross` and `high_bad` are two different readings of it and this file carried only the first (review W9
r1-spec-11). With `high_bad` read per mode the arm posts one more confidently-wrong published line at `jit`
(**7 → 8**, a `high` line more than 0.5 s out) against an improvement at `blind` (**43 → 39**) and 0 in every
other mode — the same "more eager where the clock is noisy" shape the gross cells show.

**The first five are bookkeeping, and the provenance-held family proves it.** The star publishes **157 more
measured Jamendo words** at `truth` — `word_aligned` 5378 → **5535**, `word_interpolated` 311 → **158** — so
±100 and ±300 are percentages over a denominator that grew. In COUNTS the arm puts **110 more words inside
±100 ms** (4596 → 4706) and **143 more inside ±300** (5225 → 5368). `word_published_*`, which W8b built to
score the same onsets with provenance held constant, moves the other way at every tolerance: ±100 82.79 →
**83.58**, ±250 94.43 → **95.13**, ±300 95.36 → **95.87**, published AAE 86.6 → **82.5 ms**. `word_pco300`,
which counts an unaligned word as not-correct, rises 91.78 → **94.29**.

**The real objections are `jit` and six songs.** On the provenance-held family `jit` genuinely loses:
published ±100 76.64 → **74.90**, ±300 90.54 → **89.11**, published AAE 116.0 → **124.9 ms**, and
`word_aligned` 5102 → 5096 — fewer words measured, placed worse. `blind`'s tail gets much worse too
(published AAE 253.6 → **367.0 ms**) even as its ±100 is flat. And six scored cells regress: `blind` +1
gross on `Avercage_-_Embers`, +1 on `Explosive_Ear_Candy_-_Like_The_Sun`, +2 on `The_Rinn_-_Voices__2017_
Version_`; `drop20` +2 missing on `tfr-mayday`; `drop50` +2 missing on `Kinematic_-_Peyote` and +2 on
`never-be-alone` — which is the same song whose `truth` cell inverted, paying for it on the half sheet. Two
more cells are on `tfr-chosen`, excluded from accuracy.

So the shape is exactly the trade W7 named and the re-fit sharpened rather than dissolved: **a cheaper star
is a more eager star**. It is worth an enormous amount where the sheet is INCOMPLETE and it costs where the
sheet is complete but its clock is noisy. §3.10 is not cleared, and the arm keeps its knob.

### The research arms: a decode-level read, and why only one of them would earn a corpus cell

The cheapest honest read of the arms is at the decode — `generate()` over the stored matrices, no model pass
and no ladder, so the only variable is the graph. 28 songs × 5 claim modes × 5 arms, 672 rows, 385 s
(`$ENCORE_BENCH_ROOT/_runs/w9-graph/{graph_sweep.py,arms28.json}`; `text_pm500 = w500 / in_text`, so a line
the decode never placed is charged as a miss). `prior` is skipped where a mode carries no claim times. The
cell was re-run after the review's round-1 fixes and is identical in all 672 rows (`arms28-r1.json`; below,
"W9 review round 1"), so every number in this table is on the shipped code.

| mode | arm | gross | ±500/text | AAE ms | extra dropped | TRUE lines dropped |
| --- | --- | --- | --- | --- | --- | --- |
| `truth` | `off` | 60 | 86.98 | 464 | 0 | 0 |
| `truth` | `skip` | 59 | 86.91 | 463 | 0 | **5** |
| `truth` | `star-a` | 60 | 89.26 | 572 | 0 | 0 |
| `truth` | `star-b` | **57** | **89.58** | 534 | 0 | 0 |
| `truth` | `prior` | **39** | **90.43** | **366** | 0 | 0 |
| `drop50` | `off` | 280 | 52.69 | 3319 | — | 0 |
| `drop50` | `skip` | 280 | 52.69 | 3319 | — | 0 |
| `drop50` | `star-a` | **134** | **75.88** | 1755 | — | 0 |
| `drop50` | `star-b` | 135 | 75.88 | 1758 | — | 0 |
| `drop50` | `prior` | 220 | 62.65 | 2738 | — | 0 |
| `extraverse` | `off` | 98 | 84.64 | 622 | 0 | 0 |
| `extraverse` | `skip` | 78 | 85.87 | **488** | **58 of 168** | **7** |
| `extraverse` | `prior` | 78 | **87.43** | 564 | 0 | 0 |

**`skip-arcs` is refused here and does not reach a corpus cell.** In `truth` the served text is exactly the
song's own, so there is nothing to decline — and the arm drops **5 true lines** anyway, taking `missing` from
1 to 6 and ±500/text DOWN 86.98 → 86.91. It does detect: 58 of `extraverse`'s 168 injected lines. But it buys
them with 7 true drops in the same mode, against the shipped never-sung rule's 4 on the full corpus. The
review's own prediction for the complement was "+1 gross and 0 false drops"; the measurement is +1 gross and
**5–7 false drops**. Default-off with evidence.

**`star-b` is within noise of `star-a` and inherits its rejection.** It is better by 3 gross and 0.32 pt at
`truth`/`blind`, identical at `drop50`, and WORSE at `extraverse` (102 against `star-a`'s 100 and `off`'s 98).
Since `star-a` — the same token through the real kernel — is the arm the corpus just refused on the full-sheet
word clock, a variant that moves those clauses by a third of a point cannot clear them. Default-off.

**`claim-priors` is the one arm whose decode cell earns a corpus run, and it did not get one.** It is the
biggest decode-level win of any arm on every mode it can run in — `truth` gross 60 → **39** and ±500/text
86.98 → **90.43**, `credit` 64 → 43 and 86.00 → 89.52, `extraverse` 98 → 78 and 84.64 → 87.43, `drop50` 280 →
220 and 52.69 → 62.65 — and the review's prediction (3.1 pt WORSE at ±500) is contradicted at the decode. But
**every mode in that sweep is fed the evaluation reference**, not only `truth`: `credit`, `extraverse` and
`drop50` ADD, INJECT or DROP lines and never retime a surviving one, so every scored line's claimed start is
still its truth start to the microsecond (`e2e_lib.build_claims`; `blind` serves no times, which is why
`prior` is skipped there). The sweep's five modes contain no claim-PERTURBING mode, so not one of its `prior`
cells was an honest onset reading (review W9 r2-correctness-2).

**So the arm was re-read on the three modes that do move a claim** — `graph_sweep.py --songs 28 --modes
jit,off3,tempo102,truth --arms off,prior`, the same stored matrices and emitter `1a2fd6852bd30243`, 224 rows,
**96 s** (`$ENCORE_BENCH_ROOT/_runs/w9-graph/honest28.json`):

| 28 songs, decode level | gross | ±500/text | AAE ms |
| --- | --- | --- | --- |
| any mode, `off` (the control reads no claim) | 60 | 86.98 | 464 |
| `truth` + `prior` — the oracle cell | **39** | **90.43** | 366 |
| `jit` + `prior` — σ **0.3 s** per line | **39** | **90.17** | **356** |
| `tempo102` + `prior` — a **+2 %** clock | 56 | 87.57 | 447 |
| `off3` + `prior` — a **+3 s** sheet | **67** | **86.91** | 468 |

**The win is real but conditional on the claim clock.** At a per-line jitter the prior keeps the whole oracle
gain (39 gross, 0.26 pt off the oracle's ±500/text); at a 2 % tempo error about a third of it; at a 3 s offset
it goes NEGATIVE — **7 gross lines worse than reading no claim at all**, and the only cell in the honest four
where the arm costs anything. That is the shape production's control already assumes, because the clock-fixed
ladder maps an `off3`-sized offset away before any repair sees a claim — which is another reason the owed read
is a `run_align` cell and not a third decode cell. More importantly the `off` control at this level has **no
ladder**, and
production's control for §3.14 is the clock-fixed ladder plus the adoption guard — which is what the review
asked for and what `priors-decide` exists to bypass. So the decode cell says the mechanism works and says
nothing about whether it beats the ladder. **That read is owed**, it is one `run_align` cell per arm against
`_runs/w9-ra` with [`gates/w9-research.yaml`](gates/w9-research.yaml), and the `vendored` control must go
first. All six knobs stay off.

**The `vendored` control's corpus cell was not run either**, and what stands in its place is narrower but not
nothing: `tests/test_ml_contract.py` holds the vendored decoder to `torchaudio.functional.forced_align`
**frame for frame** over 80 cases including the flat ones where tie-breaking is the whole decision, and
`tests/test_research_arms.py` holds the swap to a byte-identical published document at the step. The corpus
clause `vendored-control-changes-no-document` is the same claim over 1088 cases and is unread.

## W9: `band-reopen` flipped default-on, and the four words the owner waived (2026-10-14)

The owner's mid-wave decision (PLAN 2026-10-09): §4's re-opening — a repaired line that opened past its own
claim while ENDING with it has its opening boundary moved back to the claim — becomes the shipped default.
W8a measured the arm and left it off because its absolute gates could not be read on the 14-song selection
that holds every move it makes; this is that reading, on the full corpus, taken AFTER the wave's own arms so
the attribution stays readable. The name is retired and **`band-late-kept` is its control**, which is the
idiom `docs/arch/04-alignment.md` §14 states for an arm that becomes the default.

`_runs/w9f-ra` (code `6db0b601a018e8d1`, 998 s, warm store — the knob is not in the emitter key once it is
the default) against `_runs/w9-ra` on the same tree. [`gates/w9-reopen.yaml`](gates/w9-reopen.yaml) is the new
baseline's gate file and reads **91/91** (89/89 as first written; review W9 r1-spec-9 re-based its section 3
and added the two `aligned-at-least-*` denominator pins).

### What it bought

| 28-song `scored` | pre-flip | post-flip |
| --- | --- | --- |
| `truth` ±500 | 97.07 | **97.27** |
| `truth` ±500/text | 95.05 | **95.25** |
| `truth` `band` (0.5–2 s) | 163 | **160** |
| `jit` ±500 | 92.69 | **92.82** |
| `drop20` ±500 | 96.28 | **96.44** |
| `extraverse` ±500 | 97.43 | **97.62** |
| `headers` / `credit` ±500 | 97.07 / 97.14 | **97.27 / 97.27** |
| Jamendo `truth` words ±100 / ±300 / AAE | 85.46 / 97.16 / 71.1 ms | 85.54 / 97.23 / 70.6 ms |
| Jamendo `truth` highlight | 81.40 | **81.50** |
| `gross`, `missing`, `scored`, `high_bad`, every mode | — | **unchanged** |

**THE WORD ROW IS NOT A GAIN, and the bolding above is deliberately withheld from it** (review W9
r1-spec-9). Every percentage in the aligned family is over `word_aligned`, which the re-opening SHRINKS by
re-labelling words interpolated: 5378 → 5373 at `truth`, 5102 → 5096 at `jit`. In counts the flip gained no
word anywhere — `truth` inside ±100 **4596 → 4596** (+0), ±250 **5194 → 5194** (+0), ±300 **5225 → 5224**
(−1); `jit` ±100 **4258 → 4254** (−4), ±300 **4891 → 4887** (−4). 4596/5378 = 85.46 and 4596/5373 = 85.54,
which is the whole of the ±100 "rise". The AAE move is the same five words leaving the mean rather than being
repaired: 71.1 × 5378 − 70.6 × 5373 = 3042 ms over 5 removed words, i.e. five words averaging 608 ms of error
that are no longer counted. The flip's real gains are the line clock, the `band` count and `highlight`, all
over denominators the re-labelling cannot move.

**The whole gain is one song, and saying so is the point.** `Kinematic_-_Peyote` moves **+21.43 pt** at
`truth` and `headers` (71.43 → **92.86**, the owner's own figure), +21.43 at `extraverse`, +18.18 at
`drop20`, +14.29 at `credit`, +14.28 at `jit`. `tfr-chosen` moves +3.12 at `off05` and is excluded from
accuracy. **No song loses anything at ±500 in any mode** — which is the clause W8a rejected the arm on
(`gates/w8a.yaml`'s `no-song-loses-jit`, then `min_song_delta` −2.17) and which the free-time guard fixed.

**It fires only where it can.** 26 of 1088 documents changed, in 8 modes (`truth` 4, `jit` 4, `off05` 1,
`drop20` 4, `drop50` 1, `extraverse` 4, `headers` 4, `credit` 4) on 8 songs (`Kinematic_-_Peyote` 6,
`Lower_Loveday_-_Is_It_Right_` 6, `Avercage_-_Embers` 5, `bohemian-rhapsody` 5, and one each on
`Explosive_Ear_Candy_-_Like_The_Sun`, `HILA_-_Give_Me_the_Same`, `Quentin_Hannappe_-_Keep_On`,
`tfr-chosen`) — every one inside W8a's 14 songs, which is what that wave's completeness argument predicted.
`blind`, the uniform offsets, the tempo scalings and both wrong-text modes are **byte-identical**: no claim to
re-open onto, no line opening past its claim while ending with it, and a refused text never reaches a repair.
Wrong-text protection is therefore unchanged by measurement as well as by argument — **0/320** and **0/320**.

### The four words, as a recorded exception

W8a priced the waiver on its 14-song selection: of the 30 words the two sweeps disagree about, 24 land on
exactly 0.0 ms in the six modes whose claimed times ARE the truth times, 2 are real `jit` gains (783.9 → 85.8
and 908.8 → 186.5 ms), and **4 at `jit` move from inside ±100 ms to outside ±300** — `Explosive_Ear_Candy_-_
Like_The_Sun` twice (**+317**, **+322 ms**), `HILA_-_Give_Me_the_Same` (**+342**) and
`Quentin_Hannappe_-_Keep_On` (**+273**).

On the full 32 songs the POOLED aligned-word PERCENTAGES rise at `jit` as well (±100 83.46 → 83.48, ±300
95.86 → 95.90, AAE 80.3 → 80.1) where the 14-song selection read ±300 95.86 → 95.79 — but that rise is the
denominator, not the other 18 songs paying for the four: in counts `jit` loses 4 words inside ±100 and 4
inside ±300 over a `word_aligned` that fell 5102 → 5096 (review W9 r1-spec-9, and the count table above). So
the only place the four are visible is the **provenance-held** family, and that is
where the exception lives: `gates/w8b-arms.yaml` section 2's `jit` triple, which now reads ±100 **76.59**,
±250 **89.37**, ±300 **90.51** against W8b's 76.64 / 89.40 / 90.54. The measured net, in the integer counts
the rows carry rather than in rounded percentages, is **4360 → 4357 inside ±100, 5086 → 5084 inside ±250 and
5151 → 5149 inside ±300**: the four named words leave every window, against the two gains above arriving —
783.9 → 85.8 ms inside ±100 (`Kinematic_-_Peyote`, the song the waiver was bought for) and 908.8 → 186.5 ms
inside ±250 and ±300 only. The denominator is the **5689** PUBLISHED onsets, `word_aligned +
word_interpolated` (5102 + 587 pre-flip, 5096 + 593 post), and NOT the 5693 words `in_text`:
`Color_Out_-_Falling_Star` pairs 224 and publishes 220, four paired words whose missing onsets
`word_unpublished` (0) does not count. Fixed either way, so a percentage there is a word count at
**0.01758** pt per word (review W9 r2-correctness-1).

**It is an exception with no slack, not a loosened bound.** As measured the three clauses pass exactly
(76.59 ≥ 76.59). One more broken word takes them to 76.57 / 89.35 / 90.49 and **all three go red** — verified
by subtracting 0.0176 pt from each reading and re-running the rules. The file reads **77/77** on the post-flip
default and 77/77 on the pre-flip cell, so the exception did not cost the file its teeth anywhere else.

### Every gate file re-read on the new default, and what moved

| file | post-flip | moved by the flip? |
| --- | --- | --- |
| `w9-reopen.yaml` (new) | **91/91** | — the file written for it |
| `w8b-arms.yaml` | **77/77** | yes — the `jit` triple, now the named exception |
| `w8b-lines.yaml` | 94/94 on `_runs/w9-lines` | no — the rung cannot fire the rule |
| `w7-truth.yaml`, `w7-wrongtext.yaml`, `w4b.yaml` | 18/18, 10/10, 30/30 | no |
| `w8a.yaml` | 152/154 | yes — W8a's two `word-aligned-not-down` rules, 5378 → 5373 and 5102 → 5096 |
| `w7-words.yaml` | 22/25 | yes — `word_pco300` 91.78 → 91.76, `word_aligned` 5378 → 5373, `drop50` Jamendo ±300 82.55 → 82.54 |
| `w8b.yaml` | 147/154 | yes — 5 identity rules, and `no-song-gains-{truth,jit}` on **+21.43** and +14.28 |
| `w9.yaml` | 75/88 | yes — its §1 is the pre-flip identity claim, by construction |
| `w5.yaml` | 38/40 | **no** — identical on W8b's own rows; W5 arm clauses on a default pair |

The failures divide cleanly. `w8b.yaml`'s `no-song-gains-*` and `w9.yaml`'s §1 are **"nothing moves" clauses
read on a wave that deliberately moved something**, and a clause that fails on a +21.43 pt GAIN is doing its
job. `w8a.yaml`'s and `w7-words.yaml`'s failures are the aligned/interpolated **re-labelling** — 5 words at
`truth`, 6 at `jit`, 0.1 % of the 5689 Jamendo pairs — which is precisely the verdict W8b re-judged and
replaced with a bounded rule: `relabelled-at-most-{truth,jit}` allows 28 and reads 5 and 6, and
`word-accounting-whole-*` confirms no word left the accounting. `word_pco300` falls 0.02 pt at `truth` and
0.07 at `jit` for the same reason and nothing else. None of those nine readings is a timing regression, and
`w9-reopen.yaml` section 3 floors them so the next wave inherits a ratchet rather than an argument — with the
aligned family floored at the PRE-flip reading, because in counts it gained nothing, plus
`aligned-at-least-{truth,jit}` pinning the denominator at this flip's own spend so no percentage there can be
cleared by refusing another word (review W9 r1-spec-9).

## W9 review round 1: the fix pass re-benched, and the no-op is now measured (2026-10-14)

Round 1 of the W9 review fixed 14 findings, six of them in code: the vendored graph's frame-0 seeding and its
bypass-aware frames precheck (`domain/lyrics/viterbi.py`), the arms' graph trail, `star-b`'s margin
abstention, R3's claim-free blind-repeat input, and `fuse_in_the_mix`'s vocabulary guard. The fix pass argued
no re-bench was owed because every one of those paths is reached only through a default-off knob. **That
argument is now a measurement**, on the two levels where a published byte can move and on the decode cell the
arms were judged by.

**What it cost: nothing.** The emitter fingerprint is `14c8c0a4bfba8627`, UNCHANGED — nothing round 1 touched
is in the emission key (`adapters/ml.py` is, and round 1 did not edit it) — so the store was warm for all 32
songs in both cells and no HuBERT pass was paid. The code fingerprint moved `6db0b601a018e8d1` →
**`d1f88c1c10ab72d9`**, which is the point: a different tree, the same bytes out. Two corpus cells, 2176
cases, **0 ERROR rows**, 997 s + 905 s, plus the 672-row decode cell at 330 s.

### The default publishes the baseline's bytes, in every mode, at both rungs

`_runs/w9r1-ra` against `_runs/w9f-ra` and `_runs/w9r1-lines` against `_runs/w9-lines`, row for row on
`(song, mode, variant)` over every field either row carries (`_tools/row_identity.py`):

| compared | cases | `doc_sha256` | `onsets_sha256` | `outcome` | `confidence` | `verdict` | `gross` | `scored` | `high_bad` | `band` | `trail` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `run_align` (post-flip default) | 1088 | **0** | **0** | **0** | **0** | **0** | **0** | **0** | **0** | **0** | **0** |
| `run_align --sync-mode lines` | 1088 | **0** | **0** | **0** | **0** | **0** | **0** | **0** | **0** | **0** | **0** |

The ONLY field that differs anywhere in 2176 rows is `attempts[].seconds`, the per-attempt wall clock (799
and 957 rows of it). The `trail` column is worth naming on its own: round 1 rewrote the graph notes so a
non-plain graph says itself where it is BUILT, and the default decode's trail is byte-identical anyway —
because the default never builds one.

So the shipped row is the flip's row, exactly: 28-song `scored` `truth` ±500 **97.27**, ±500/text **95.25**,
**gross 0** in all twelve right-text modes, `high_bad` **0**, 28 of 28 zero-gross songs, Jamendo words ±100
**85.54** / ±300 **97.23** / AAE **70.6 ms** over 5373 aligned, `word_pco300` 91.76, highlight **81.50 %**,
wrong text **0/320** + own-clock **0/320**, and at the LINE_SYNC rung `truth` ±500 **100.00** with
**0 of 640** wrong-text documents published. Rows: [`results/w9-r1-run_align.json`](results/w9-r1-run_align.json)
and [`results/w9-r1-lines-run_align.json`](results/w9-r1-lines-run_align.json), with their per-case digests.

### Every gate file reads what it read on the baseline, rule for rule

[`gates/w9-r1.yaml`](gates/w9-r1.yaml) is this re-run's own file — identity against the post-flip baseline
first, then the shipped accuracy row as absolute literals — and it reads **86/86**. Read against W8b's
pre-flip row instead, its section 1 fails on exactly the flip's **26** documents (4 + 4 + 1 + 4 + 1 + 4 + 4 +
4 across the eight modes that can fire), which is what keeps the identity clause from being vacuous.

| file | on the post-fix row | on the post-flip baseline | same? |
| --- | --- | --- | --- |
| `w9-r1.yaml` (new) | **86/86** | — the file written for it | — |
| `w9-reopen.yaml` | **91/91** | 91/91 | yes |
| `w8b-arms.yaml` | **77/77** | 77/77 | yes — the four waived `jit` words, still with no slack |
| `w8b-lines.yaml` | **94/94** | 94/94 | yes |
| `w8a.yaml` | 152/154 | 152/154 | yes |
| `w8b.yaml` | 147/154 | 147/154 | yes |
| `w9.yaml` | 75/88 | 75/88 | yes |
| `w7-words.yaml` | 22/25 | 22/25 | yes |
| `w7.yaml` | 44/45 | 44/45 | yes — `w7-no-published-document-changes` reads **26** on both |
| `w7-truth.yaml`, `w7-wrongtext.yaml`, `w4b.yaml` | 18/18, 10/10, 30/30 | same | yes |
| `w5.yaml` | 38/40 | 38/40 | yes |
| `w9-star.yaml` on `results/w9-star-on-run_align.json` | **62/10** | 62/10 | yes — the arm's own reading, re-read offline |

Every failure in that table belongs to the flip or to an earlier wave's arm clauses read on a default pair;
none of them moved, and each reads the same number on the baseline's committed row.

### The arms' decode cell is no longer stale

The fix pass recorded `_runs/w9-graph/arms28.json` as stale and owed the re-read to W10, since four arms'
code changed (`star-b` and `skip-arcs` through the graph, `star-b`'s grading, `claim-priors` and
`claim-fusion` through R3's input) and the expectation that they were no-ops on this corpus — a song's frame 0
is intro silence, and 9000 frames never fail a precheck against a few thousand targets — was an expectation.
It is now measured: `graph_sweep.py --songs 28` re-run on the fixed tree (`_runs/w9-graph/arms28-r1.json`, 672
rows, 330 s, the same emitter `1a2fd6852bd30243` and the same stored matrices) is **identical to
`arms28.json` in every field of all 672 rows** (`_runs/w9-graph/arms_diff.py`). The arm table above therefore
stands as measured on the shipped code, including the two verdicts that depend on it: `skip-arcs` still drops
**5 true lines** at `truth` and still buys `extraverse`'s 58 injected drops with **7**, and `star-b` is still
within noise of `star-a`. `star-a` — the corpus `star` arm's decode — is in that identity too, so
`gates/w9-star.yaml`'s 62/10 needed no re-run either.

### What is settled here, and what is not

Settled: round 1 changed no published byte at either rung, no gate reading, and no arm verdict. The worker
suite reads **2362 passed, 2 skipped, 4 xfailed, 0 FAILED** on this tree — one more test than the fix pass
left, `test_w9s_round_one_gate_reads_identity_on_the_fix_pass_and_sees_the_flip`, which pins all three of
this file's readings — with both skips environmental and
named (`test_builders_return_none_rather_than_raising_when_ml_is_absent`, skipped because whisperx IS
installed here; `test_every_capability_used_is_one_the_host_probe_can_prove`, skipped because this box cannot
PROVE `stems:roformer` while still asserting every token is emittable) and the four `xfail(strict=True)` the
review's M2 left on `test_repair_order.py`'s inverting seeds. Three mutations were planted to show the fixes
are genuinely pinned: P back to W7's 1.0 reddens `test_the_shipped_penalty_is_the_one_the_corpus_fitted`
alone, dropping the frame-0 entry seeding reddens
`test_the_starred_graph_holds_the_plain_path_that_sings_from_frame_zero` alone, counting every target as
mandatory in the precheck reddens `test_a_sheet_too_long_for_the_recording_is_not_refused_on_frames_an_arc_can_bypass`
alone, and flipping one tie-break in the vendored decoder (`one > stay` → `one >= stay`) reddens the
real-kernel contract test — which is also the non-vacuity proof for that 80-case comparison.

Not settled, and unchanged by this re-run: the `vendored` control's corpus cell and the `claim-priors` /
`priors-decide` `run_align` cells are still owed to W10. They are the one open question in §3.14, and nothing
here was allowed to substitute for them.

## W8: the non-Latin truth set (2026-10-15)

This lane had no ground truth at all, so nothing about it could be judged — and with no truth, nothing about
it should ship. The set below is the stage-0 prerequisite: **7 songs** of AMLL TTML DB truth (4 zh, 2 ja,
1 ko), wired through `discover()` exactly as JamendoLyrics is, measured by the same
`truth_displacement.py` the English corpus is measured by, and kept deliberately small because what decided
each song's place was a measurement rather than a wish. **22 candidates were pursued; 15 were dropped.**

**Where it lives.** `<bench>/amll/<slug>/{lyrics.ttml, mix.wav, mix/vocals.wav, source.json}`, outside the
repo like every other corpus audio, and `amll.py` turns each `lyrics.ttml` into that song's
`truth-lines.json` + `truth-words.json`. The TTML is CC0 (github.com/amll-dev/amll-ttml-db) and stays in the
song directory, so its per-SYLLABLE spans — which no metric reads yet, and which stage 1's script-aware units
will — are never lost to the collapse described below. The audio is a local research copy, held only in the
bench root, never committed and never redistributed: the same posture as the 9 YouTube songs of the English
corpus, and the reason `source.json` records the video id, channel, title and duration each truth file was
checked against. Each recording stays its rights-holder's; the CC0 is the TTML truth, not the audio. A
dropped candidate keeps everything it was judged on under `<bench>/amll/_rejected/<slug>/`, one directory
deeper than `discover()`'s glob looks, so a later wave can re-source its audio without re-deciding anything.

**A corpus of its own, so no English number can move.** The non-Latin songs are NOT 7 more rows in
`scored`/`all`: `e2e.py --corpus nonlatin` is a setup variable (`e2e_lib.CORPORA`, `e2e_gates.SETUP_META`,
default `english` via `SETUP_DEFAULTS`), so a run measures one song set or the other and a `base.` gate across
the two is an ERROR rather than a comparison. They report in their own group, `nonlatin`, which has members
only on such a run. `corpus-truth.json` grew from 32 to **39** rows and not one English row's bytes changed.
`--corpus nonlatin` also REFUSES `--language en`: left at the default, these songs' text would be timed by
the English bundle, which has a calibration row — so the lane's own gate would not be the thing measured.

### Why no fixture holds a lyric

The audio of this corpus is a local research copy, the truth is CC0 and the romanisation backends were
chosen by licence — and then **the unit tests of the lane this all protects were written with verbatim lines
of six commercially released songs in them** (review r1-tests-17 / r1-correctness-7): two Mandarin sheets in
`worker/tests/test_nonlatin_lane.py`, one line each of a zh, a ja and a ko song in `test_units.py` and
`test_romanize.py`, a line of an English one, two docstring examples in `domain/lyrics/romanize.py`, a
comment in `core/src/lib/tv/lyrics.ts`, five characters of a TTML fixture in `test_bench_amll.py`, and the
CJK cases of `scripts/tv_parity.py` with the `bench-highlight-parity.json` they generate. Every pre-existing
English fixture in those same files was already synthetic (`the quick fox`, random letter runs), so the
asymmetry was an accident of how the lane was written and not a decision anyone took.

They are all SYNTHETIC now, in the same scripts and the same shapes, because every assertion in them is
structural and none depends on the words: enumerations of hanzi, a kana line whose tokens read mora by mora
beside one whose kanji does not, a spaced Hangul pair, a mixed Han+Latin line, and a 12-character kana run
repeated four times for the 48-character re-segmentation case. The replacements keep the character counts
the length guard reads, so `bench-highlight-parity.json` regenerated **+0 lines, 2 changed** — the two CJK
cases' text and nothing else. The real lines stay where this wave already put corpus text: beside the TTML
in the bench root, outside the repo.

### What the TTML gives, and the one thing it does not

| slug | song | lines | syllables | words | agents |
| --- | --- | --- | --- | --- | --- |
| `amll-zh-gaobai-qiqiu` | 告白氣球 — 周杰倫 | 40 | 308 | 91 | v1 |
| `amll-zh-guangnian-zhiwai` | 光年之外 — G.E.M. | 57 | 397 | 59 | v1 (+4 `x-bg` dropped) |
| `amll-zh-qingtian` | 晴天 — 周杰倫 | 62 | 494 | 77 | v1 |
| `amll-zh-zaijian` | 再見 — G.E.M. | 39 | 217 | 61 | v1 |
| `amll-ja-ragutorein` | ラグトレイン — 稲葉曇 | 31 | 520 | 39 | v1 |
| `amll-ja-yoru-ni-kakeru` | 夜に駆ける — YOASOBI | 56 | 693 | 56 | v1, v2 |
| `amll-ko-gangnam-style` | Gangnam Style — PSY | 55 | 535 | 233 | v1 (+1 `x-bg`, 48 `x-roman`, 56 `x-translation` dropped) |

A **word** here is a run of syllables the TTML writes with no space inside it, so the truth words and
`line.text.split()` are one tokenisation by construction and `load_truth_words` accepts the file. That is also
the lane's first real finding: **a CJK TTML often writes a whole line with no space at all**, so the word
truth collapses onto the line (56 lines / 56 words on 夜に駆ける, 693 syllables inside them). The ko sheet, whose
script is space-separated, keeps 233 words for 535 syllables. Nothing sub-line can therefore be SCORED on most
of this set until the units are script-aware (stage 1), and the syllable spans the TTML holds are the data
that measurement will read. Background vocals (`x-bg`), translations (`x-translation`) and romanisations
(`x-roman`) are dropped: the bench's truth is one voice's line sequence.

### The admission rule, and the 15 songs it dropped

A truth file that does not describe the audio beside it would mislead this lane exactly as four caption files
misled W8a, so every candidate was measured before it was kept, with the same two numbers the W8b rule uses:

* **the envelope lag** must read |lag| ≤ **250 ms** (`DISPLACEMENT_LIMIT_MS`) at r ≥ **0.25**
  (`MIN_LAG_CORRELATION`) — the sheet-against-stem cross-correlation over the whole song;
* **the silence arbiter** must not read a median delay at or above **500 ms** (twice the limit, the bar
  `TruthQuality.silence_stands_alone` already uses) over the starts that land in stem silence.

Both are READ, not corrected: no truth file is shifted to fit its audio, and a song whose two arbiters
disagree is dropped rather than averaged. Kept, measured on the separated stem:

| slug | lag (r) | silent starts / onsets | median | verdict |
| --- | --- | --- | --- | --- |
| `amll-zh-gaobai-qiqiu` | −100 ms (0.75) | 0 / 0 | — | kept |
| `amll-zh-guangnian-zhiwai` | −80 ms (0.70) | 0 / 0 | — | kept |
| `amll-zh-qingtian` | −20 ms (0.63) | 0 / 0 | — | kept |
| `amll-zh-zaijian` | +80 ms (0.63) | 2 / 2 | +232 ms | kept |
| `amll-ja-ragutorein` | +100 ms (0.55) | 2 / 2 | +420 ms | kept, thin |
| `amll-ja-yoru-ni-kakeru` | −80 ms (0.67) | 3 / 3 | +428 ms | kept, thin |
| `amll-ko-gangnam-style` | −40 ms (0.42) | 0 / 0 | — | kept |

Dropped, and on which measurement or fact:

| slug | reading | why it is not in the set |
| --- | --- | --- |
| `amll-zh-tianhou` 天后 | lag **−2440 ms** (0.85) | the upload is not the master the TTML times |
| `amll-zh-chiling` 赤伶 | lag **−2280 ms** (0.56), median +820 ms | same, and the two readings disagree |
| `amll-zh-duoyuan` 多遠都要在一起 | median **+2147 ms** (7 onsets), lag **+2160 ms** (0.69) | both arbiters agree the truth leads by 2.1 s |
| `amll-ja-kaibutsu` 怪物 | median **+853 ms** (6 onsets), lag **+900 ms** (0.68) | both agree the truth leads by ~0.9 s |
| `amll-zh-yehangxing` 夜航星 | median +944 ms, lag **−1800 ms** (0.70) | the arbiters disagree by 2.7 s: unreadable |
| `amll-zh-zhuiguangzhe` 追光者 | median +330 ms, lag **−1340 ms** (0.69) | same |
| `amll-zh-jiaoao-shaonian` 驕傲的少年 | lag **−360 ms** (0.64) | over the 250 ms limit |
| `amll-zh-guyongzhe` 孤勇者 | — | only live performances on offer: another performance, not another master |
| `amll-zh-shanhetu` 山河圖 | — | same (a 2020 televised performance) |
| `amll-zh-qinglian` 輕漣 | — | the only candidate was a different artist's cover |
| `amll-zh-fuqin` 父親, `amll-zh-guangliang` 光亮, `amll-zh-renshi` 人是_ | — | audio could not be fetched (HTTP 403); TTML kept |
| `amll-zh-su-reverse` 溯, `amll-zh-mangzhong` 芒種 | — | no candidate within +25/+30 s of the TTML's own end |

Five dropped on a lag or lead past the limit (`tianhou`, `chiling`, `jiaoao-shaonian`, `duoyuan`,
`kaibutsu`), two because their arbiters disagree by 1.3–2.7 s, three because no master was on offer (two live
performances, one cover), three because the audio would not fetch, two because no upload came within half a
minute of the TTML's own end.

`amll-ja-kaibutsu` is the row that matters most, because **the W8b `displaced` rule would have kept it**: its
6 timed onsets are 10.7% of 56 lines, under `MIN_DISPLACEMENT_SHARE` (0.15), so its confidence reads `thin`
and `displaced` answers False on a sheet whose own two arbiters agree it leads by 0.9 s. The English rule is
one-sided and share-gated for reasons measured on the English corpus (README, W8b); on a dense CJK sheet with
few silent starts it does not bind. That is why admission here is a RULE OF THIS SET applied before a song
enters the corpus, rather than an edit to `TruthQuality` — which would have re-judged the English 28
(`never-be-alone` reads lag −800 ms at r 0.77 and scores today; see "Not settled" below).

### The gate: an uncalibrated bundle may publish LINES, never WORDS

Stage 0's real job was not accuracy, it was that this lane had **no wrong-text gate at all**. W7 closed the
global engine's word document on an uncalibrated matrix; W8 makes that one named rule
(`lexical.may_time_words` — words need a witness, which is a calibration row or a transcript of this very
recording) and closes the other word-timing exit, the WINDOWED engine, which reads no matrix and so can
measure no lift on any bundle. Both engines print one sentence (`lexical.words_ungated`). The exemptions are
unchanged and are two: the ASR tier, and a human PIN (published all-`low`, unvouched) — in BOTH engines,
which the windowed one owes to review r1-tests-21: it shipped with the pin branch missing, so a pinned
non-Latin sheet on an aligner with no `emissions` was declined where the global engine publishes.
`h3-ungated-words`
remains the control that restores the old behaviour, and is still the only way to read this lane's words end
to end. English is untouched, and measured rather than argued: `_runs/w8-english-smoke` (`--level run_align --songs hello,Avercage --modes truth,wrongtext --wrong-k 2`) republishes both documents and both onset series DIGEST-IDENTICAL to `results/w9-r1-run_align.json`, with every per-song delta at +0.0 and wrong text 0/4. The windowed engine on the English bundle publishes exactly what it did.

### The measurement, 4 zh songs through the real bundle

`results/w8-nonlatin-zh-run_align.json` (+ `.cases.jsonl`; rows in `_runs/w8-nonlatin-zh`) — `--level
run_align --corpus nonlatin --language zh --songs amll-zh --modes truth,wrongtext --wrong-k 3 --asr off`, on
`jonatasgrosman/wav2vec2-large-xlsr-53-chinese-zh-cn` (the bundle whisperx tables for zh, and the run is
marked `uncalibrated`), 16 cases, 257 s, 11 matrices computed. `gates/w8-nonlatin.yaml` reads **17/17**.

| mode | cases | published | line-synced | refused | lines | gross | ±500 | pass rate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `truth` | 4 | 0 as words | **4** | 0 | 198 | **0** | 100.0 | — |
| `wrongtext` | 12 | 0 | 0 | **12** | 0 | — | — | **0/12 = 0.0%** |

**The wrong-text pass rate for the non-Latin lane is 0 of 12** (3 cross-pairs on each of 4 songs; a pass is
`published` OR `line-synced`, so a line-synced wrong text would count). Every one of the 12 declined its word
document for want of a gate and was then REFUSED at the LINE_SYNC rung, by the one threshold a missing
calibration row does not switch off: the share of decoded lines starting near their mapped claim.

That threshold is `LINE_SYNC_SHARE_UNCALIBRATED` = 0.5, fitted on English, and this run is the first
out-of-sample reading of it — a wide one:

| | right text (`truth`, 4 songs) | wrong text (12 pairs) |
| --- | --- | --- |
| decode agreement | **97–100%** | **0–23%** |
| sheet-span envelope r | 0.55–0.75 | 0.09–0.28 |
| median claim lag | −0.13 … +0.10 s | −66.4 … +58.7 s |

The populations do not overlap: the lowest right text reads 97%, the highest wrong text 23%, and the share
sits at 50% between them. The right texts' median lag is also a THIRD arbiter on the truth set itself, from a
mechanism neither admission reading uses — the zh bundle's own blind decode places 97–100% of lines within
1.0 s of where the TTML says, with a median lag of −130…+100 ms and a spread of 30–50 ms.

The `truth` row's ±500 of 100.0 is a PUBLISH-RATE and clock-no-op reading, not an aligner accuracy reading: a
line-synced document carries the sheet's own times, which in `truth` mode are the truth, so what it measures
is that all 198 lines published, that the rung's claim clock left them where they were (bias +0 ms, MAD 0 ms)
and that both its gates passed. **Nothing on this lane measures alignment accuracy yet**, and nothing can
until the words are timed — which is stage 1's and stage 2's job, with this truth set as its denominator.

### Not settled, and owed

* **ja and ko are unmeasured.** Their bundles are not on this box (~1.2 GB each) and `--language` takes one
  language a run, so the 3 ja/ko songs have truth and audio but no row here. The run above is zh only.
* **`never-be-alone` reads lag −800 ms at r 0.77 and scores today.** The W8b displacement rule only convicts
  a sheet that runs EARLY, so an audio that leads its truth is invisible to it. Left alone deliberately:
  two-siding the lag arbiter would take a song out of the English 28 and move every recorded accuracy number.
  It wants its own wave, with the re-bench that implies.
* **The windowed engine's ENGLISH words are still ungated** — it measures no lift at all, so nothing reads
  its words on any bundle. Only the routed half is closed here, because English is the measured default and
  the shipped aligner has `emissions` (so the engine is unreachable in production today).
* **Stage 1 and stage 2 are not started**: script-aware units, OpenCC t2s, MMS_FA, and the per-language
  calibration rows (`lift_gate.py --model` + `line_gate.py --model`) that option (i) needs. Until a row
  exists, this lane publishes LINES only — by rule, not by accident. (Romanisation for display landed in the
  same wave; the section below.)

## W8 stage 0: romanisation and the CJK line (2026-10-15)

The gate above is what made this lane safe. This is what makes it USABLE: a guest who cannot read Han, kana,
Hangul, Cyrillic or Arabic could sing nothing off a line published in it, and a word-timed CJK line reached
the reel spelled out character by character, because the TV put one space between every word. Both are fixed
without an accuracy claim of any kind — nothing here moves a timing.

### What romanises what, and under which licence

Licences decided the backends before accuracy did, this tree shipping no GPL code
(`worker/pyproject.toml`, the `romanize` extra, states each one):

| language | backend | licence | example |
| --- | --- | --- | --- |
| `zh` | pypinyin 0.55.0 | MIT, pure Python | 我来到你的城市 → `wǒ lái dào nǐ de chéng shì` |
| `ja` | cutlet 0.5.2 (+ fugashi MIT, mojimoji Apache-2.0, unidic-lite) | MIT | 夜に駆ける → `Yoru ni kakeru` |
| everything else non-Latin | uroman 1.3.1.1 | Apache-2.0 | 오빤 강남스타일 → `obban gangnamseutail` |

**NOT pykakasi**, which is GPL-3.0 — the review named it as the thing to avoid and it is avoided. The one
licence that needed reading rather than quoting is **unidic-lite**: its packaging is MIT, and the UniDic
2.1.2 dictionary inside it is triple-licensed GPL-2.0 / LGPL-2.1 / BSD-3-Clause, taken here under
**BSD-3-Clause**. It is also 47 MB of the extra's 49 MB. cutlet reads UniDic's own `pron`/`kana` features, so
the BSD-only IPAdic cannot stand in for it.

uroman is the fallback rather than a per-script library for one reason: `language.SCRIPT_LANGUAGES` routes
**14** non-Latin languages to a bundle, and a script this project never measured must still print something
readable rather than nothing. `tests/test_romanize.py` pins `romanize.BACKENDS` equal to that table, so a new
routable language cannot be added without a backend. **Nothing here measures how GOOD a transliteration is**
— this is a reading aid, not a claim, and the uroman rows in particular are the generic tables rather than a
Revised-Romanization or ALA-LC reading.

### Coverage on the truth set: 331 of 331, and the 9 lines that correctly get none

Measured over all **7** songs' `truth-lines.json` — ja and ko included, which the zh-only alignment run
cannot reach, romanisation needing no audio and no bundle:

| song | backend | lines | need a second script | romanised | cost |
| --- | --- | --- | --- | --- | --- |
| `amll-zh-gaobai-qiqiu` | pypinyin | 40 | 40 | **40** | 1.6 ms |
| `amll-zh-guangnian-zhiwai` | pypinyin | 57 | 57 | **57** | 1.8 ms |
| `amll-zh-qingtian` | pypinyin | 62 | 60 | **60** | 2.0 ms |
| `amll-zh-zaijian` | pypinyin | 39 | 39 | **39** | 1.8 ms |
| `amll-ja-ragutorein` | cutlet | 31 | 31 | **31** | 104.4 ms |
| `amll-ja-yoru-ni-kakeru` | cutlet | 56 | 56 | **56** | 78.7 ms |
| `amll-ko-gangnam-style` | uroman | 55 | 48 | **48** | 11.1 ms |
| **total** | | **340** | **331** | **331 (100%)** | |

The **9** lines that get no romanisation are the measurement that matters more than the 331, because a
coverage number alone would be satisfied by romanising everything: they are `amll-ko-gangnam-style`'s seven
ALREADY-LATIN rows (an interjection and two chanted-syllable rows, repeated) and `amll-zh-qingtian`'s two
solfège rows. Those carry no non-Latin letter, and a second script under them would be a
copy of themselves. The rule is `romanize.needs_romanization` — at least one letter in a non-Latin script,
counted the same way `language.script_histogram` counts — so `♪♪♪`, `[ ... ]` and a row of digits get none
either.

Build cost is once per process and per language (`build_romanizer` is cached): pypinyin 0.10 s, cutlet
0.013 s, **uroman 2.21 s** — which is why it is cached, and why it is nothing against the ~5–9 s emission
pass of the same job. It is nothing to THIS job and was something to every other one: `_romanizer` asks the
factory with `asyncio.to_thread`, because that build ran on the worker's event loop and a worker at
`concurrency > 1` would have stalled every other job's progress frames and its `worker:heartbeat` for those
2.21 s (review r1-correctness-3). A display extra may not cost that.

### End to end: the published document carries it, and the onsets do not move

`_runs/w8s0-romanize` — `--level run_align --corpus nonlatin --language zh --songs
amll-zh-zaijian,amll-zh-qingtian --modes truth --asr off --romanize shipped`, through the real whisperx zh
bundle and the real publishing step. The harness gained `--romanize {off,shipped}` with the same shape and
the same reason `--detector` has: **the default is OFF**, so every row under `results/` goes on reproducing,
and `meta["romanize"]` states which ran either way (it joins `e2e_gates.COMPARED_META`).

| | recorded (`results/w8-nonlatin-zh`, romanize off) | `--romanize shipped` |
| --- | --- | --- |
| published | 2 line-synced | 2 line-synced |
| lines / gross / ±500 | 101 / 0 / 100.0 | 101 / 0 / 100.0 |
| lines carrying `romanization` | 0 | **99 of 101** |
| `onsets_sha256` | `9d0fc4ba42f145d5`, `3315046fe49353c6` | **identical, both songs** |
| `doc_sha256` | `f18ae73ed9146577`, `df4bd2f8e26f5427` | moved (the new field) |

That pair is the whole claim: the document gains a field, **not one onset moves**, and the two lines that
skip it are 晴天's solfège rows again — the same refusal, now on the publishing path. `_runs/w8s0-romanize-off`
is the control, and it reproduces both recorded `doc_sha256` values EXACTLY, so the default configuration is
byte-identical to what is on disk.

**ENGLISH IS BYTE-UNMOVED EVEN WITH THE ARM ON**, measured rather than argued, because there is no backend
for a Latin language and `needs_romanization` would refuse a Latin line if there were:
`_runs/w8s0-english-smoke` (`--level run_align --songs hello,Avercage --modes truth --asr off --romanize
shipped`) republishes both documents and both onset series **DIGEST-IDENTICAL** to
`results/w9-r1-run_align` — `doc_sha256` and `onsets_sha256` match on both songs, and `hello`'s word and
highlight figures match to the digit. (`Avercage`'s `words` reads differently only because the recorded
`cases.jsonl` carries the summariser's shape where a live row carries raw error arrays; the digests are the
comparable fields and they are equal.)

### Core: one gap rule, and it is pinned in both languages

The reel joined every pair of words with one space, which is correct for Latin and wrong for the scripts this
lane publishes. `wordGap` in `core/src/lib/tv/lyrics.ts` is now the one rule, read by the reel's inter-word
gap AND by the text re-segmentation rebuilds (`lineFromWords`, the textless-line fallback in
`parseLyricsDoc`, the `COVERAGE_MIN` refusal and the `LINE_MAX_CHARS` cap), so the two cannot disagree:

* nothing between two characters of **Han, kana, or the CJK and fullwidth punctuation** the UCD files under
  "Common" and Script_Extensions shares with them;
* one space everywhere else — **Hangul included**, Korean spacing its words and being "CJK" only
  typographically, and a **CJK/Latin boundary** included, since 光年之外oh is unreadable either way.

The coverage refusal is the one place this changes a Latin-script reading too: it used to measure the words
against the line's text with a space after every word, which on a CJK line counts characters the text does
not have and let a partially-timed sheet split. It now measures `joinWords`.

The bench's TV port carries the same rule rather than a "not modelled" note, because the `highlight` metric
reads which word is lit through it. Python's `re` has no Script_Extensions, so the TypeScript class was
ENUMERATED over all 0x110000 codepoints and compressed into the 55 ranges of `e2e_lib.TV_CJK_JOINS` — the two
sets are **104 411 codepoints, equal**, checked by enumeration rather than by eye. Two new cases of the
parity fixture (`cjk-rebuilt-without-spaces`, `cjk-splits-at-a-pause`) pin them together in both trees, and
no English row of that fixture moved: the rule is arithmetically identical to `join(" ")` for Latin text, and
the regenerated file is **+2 lines, 0 changed**.

**THAT ENUMERATION IS NOW A GATE RATHER THAN A PAST ACTION** (review r1-tests-19, which found neither the
script nor its output in the tree and no test comparing the two classes — the two parity cases exercise Han,
hiragana, katakana, one ideographic comma, Hangul and Latin, so the sets could drift silently on anything
else, and a Unicode release that adds a Han codepoint moves `\p{scx=...}` and not the frozen copy).
`tv_parity.py` writes `core/tests/unit/lib/tv/cjk-join-ranges.json` — the 55 ranges as integer pairs, so a
lone surrogate is a number both languages can hold — from `e2e_lib.cjk_join_ranges()`; the core test
enumerates **`wordGap` itself** over all 0x110000 codepoints against that file (384 ms), and the worker test
holds the frozen copy and the generator to it. Either class moving turns one tree red.

### What stage 0 does and does not buy

* **`no lyrics` → published** is W7's routing plus task 1's gate, not this half: the 4 zh songs publish
  4/4 line-synced (above), and what this adds is that the room can READ them. The honest counterfactual is
  the review's own §3 line — "language is always `en`, so non-Latin text ends as no lyrics" — which §9 closed
  in W7; `--corpus nonlatin` deliberately REFUSES `--language en`, so it cannot be re-measured here.
* **Line-level accuracy of what publishes is still a publish-rate reading**, exactly as above: a line-synced
  document carries the sheet's own times, so ±500 100.0 on 101 lines says the gates passed and the claim
  clock was a no-op, not that an aligner placed anything.
* **`romanization` is written on LINE documents only.** This lane publishes lines by rule (§5.4), and the TV
  drops a romanisation when it re-segments a row — which is precisely what a word document of a dense CJK
  line would be subject to. A word-level romanisation wants per-row spans, which is stage 1's unit work.
* **ja and ko still have no alignment reading** (their bundles are ~1.2 GB each and `--language` takes one a
  run), so their romanisation is measured on the truth text above and not through a published document.

## W8 stages 1-2: script-aware units, and MMS_FA over romanised text (2026-10-15)

Stage 0 made this lane SAFE (its wrong-text path closed by rule) and READABLE (a romanisation beside the
line). It made nothing about it ACCURATE: a Chinese line has no spaces, so `text.split()` made the whole
line one word with one syllable, and the lane published a single span per line. These two stages answer the
units instead. Both are default-off arms (`nonlatin-units`, `zh-simplify`, `mms-roman`;
`docs/arch/04-alignment.md` §9.1), and both carry a number rather than an argument.

**The headline, and it is not the negative result the review expected.** `--level generate`, `--corpus
nonlatin`, `--modes truth`, one song a language, scored against the AMLL TTML's own **syllable** spans:

| song | arm | n | ±100 | ±250 | **±300** | gross | AAE |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `amll-zh-qingtian` | — (whitespace) | 494/494 | 9.11 | 15.18 | **16.80** | 151 | 1527.6 ms |
| `amll-zh-qingtian` | `nonlatin-units` | 490/494 | 67.14 | 96.94 | **97.55** | 1 | 98.5 ms |
| `amll-zh-qingtian` | `mms-roman` | 494/494 | 55.06 | 98.18 | **98.58** | 2 | 149.4 ms |
| `amll-ja-yoru-ni-kakeru` | — (whitespace) | 693/693 | 2.89 | 9.52 | **11.54** | 220 | 1545.7 ms |
| `amll-ja-yoru-ni-kakeru` | `nonlatin-units` | 687/693 | 72.49 | 94.61 | **95.78** | 2 | 99.7 ms |
| `amll-ko-gangnam-style` | `nonlatin-units` | 481/535 | 71.10 | 79.42 | **80.67** | 18 | 341.6 ms |
| `amll-ko-gangnam-style` | `mms-roman` | 535/535 | 70.09 | 91.96 | **92.52** | 20 | 197.4 ms |

`results/w8s12-*` (ten published rows, `_runs/w8s12-*`), each read by `gates/w8-units.yaml`, which passes
**8/8 on every armed run and 5/8 — REJECT — on the whitespace baseline**, so the gate is not vacuous. Those
are the 8 readings the file held on the day; r1-spec-8 grew it to 10, and the corpus cell below re-runs every
arm rather than re-gating these rows.
**§3.12's reject-if is cleared with room to spare**: it fails
the stages if AMLL zh/ja syllable ±300 is below 70%, and the measured pair is **97.55 / 95.78** against a
whitespace baseline of 16.80 / 11.54. THE SAMPLE IS ONE SONG A LANGUAGE — a signal, not a verdict; the
corpus cell is the bench runner's, and the second zh song reads with it below.

**Why the baseline is so low, and why that is not a strawman.** The whitespace rule publishes one word for
the whole line, so every syllable of that line is scored against the line's single onset: syllable 1 is
right and syllable 12 is wrong by the length of the line. That IS what the lane published before this wave
— the measurement simply had no way to say so until the truth had syllables. The denominator is the
TRUTH's in every row above (494, 693, 535 spans), which is what makes the arms comparable at all.

**The word metric moves the other way, and the syllable metric is the one to read.** On
`amll-zh-qingtian`, `word_aligned` falls 77 → 17 with `word_mismatched` 0 → 60: the AMLL truth's WORDS are
the TTML's whitespace grouping (77 over 62 lines), `score_words` pairs a line only when the published word
count equals the truth's, and a per-hanzi document has 6 words where the truth line has 1. Nothing got
worse; the two tokenisations stopped matching. `score_syllables` pairs on a CHARACTER OFFSET for exactly
this reason, and `amll.py` now writes `truth-syllables.json` (1 722 spans over the three songs read here;
every offset checked against its own line's text, **0 misaligned**).

### Two songs, and the OOV characters that are left

| run | songs | n | ±100 | ±250 | ±300 | gross | AAE | lines ±500 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `w8s12-zh-units2` | qingtian + guangnian-zhiwai | 878/891 | 73.12 | 95.56 | 96.01 | 8 | 115.0 ms | 96.64 |

The 13 unaligned spans are the vocabulary's, not the units': the `zh-cn` bundle holds no `刮`, `荡`, `啸`,
`倔`, `磅`, `礴`, `烁`, `簸` or `粹`, so those characters have no target and their word is interpolated
between its neighbours. Measured over the whole truth set, in-vocabulary share of the letters each sheet
holds: **zh 97.7-99.5%** (4 songs), **ja 99.7-100%** (2 songs), **ko 71.8%** (1 song). Korean is the
outlier and the reason is countable: `kresnik/wav2vec2-large-xlsr-korean` tables **1 202 of the 11 172**
precomposed Hangul blocks and **not one Latin letter**, so `gangnam-style`'s seven already-Latin
rows and its one untabled Hangul block are unalignable by construction.

### `zh-simplify` is correct and, on this corpus, a byte-level no-op

OpenCC `t2s` folds a Traditional character onto the Simplified form the `zh-cn` vocabulary holds, tried
after a direct hit and before NFKD. On the two zh songs above, `nonlatin-units,zh-simplify` and
`nonlatin-units` alone publish **identical onsets** — `onsets_sha256` `72d0838b28e4b5c6` and
`80bd92afe22fcf04` on both runs (`_runs/w8s12-zh-t2s` vs `_runs/w8s12-zh-units2`) — and the same 4 and 9
interpolated spans. **All four of this corpus's Chinese songs are written in Simplified**, so there is
nothing for the fold to do; the review's 69%-covered Traditional sheet is not in this set. The arm is kept
because a Traditional sheet is a provider away, and it is recorded here as unmeasured ON TRADITIONAL TEXT
rather than as a win. Hermetically, it is measured: `tests/test_units.py` builds a Simplified-only toy
vocabulary and a seven-character Traditional line, where **1 of 7** characters is a target without the arm
(`情`, which both scripts spell alike) and **7 of 7** with it.

### MMS_FA: it works on singing, and its weights are CC-BY-NC

The review set the expectation plainly — English MMS_FA scores 69.0% ±100 against the base model's 78.7%,
and no source shows MMS_FA working on singing — so a negative result was the expected one. It is not what
the three rows above read. MMS_FA ties or beats the per-language bundle at ±300 on both languages tried
(zh 98.58 vs 97.55, ko 92.52 vs 80.67) and loses at ±100 (55.06 vs 67.14, 70.09 vs 71.10): it places a
syllable in the right second more reliably and in the right tenth of a second less reliably. Its advantage
is coverage rather than acoustics — **494/494 and 535/535** spans aligned against 490/494 and 481/535,
because a romanised target is 26 Latin letters and a rare hanzi or an unlisted Hangul block cannot be
out-of-vocabulary.

Mechanically: `torchaudio.pipelines.MMS_FA`, 315 466 396 parameters, a 29-entry vocabulary (`-` as the
blank at 0, 26 letters, `'`, and its own `*` star column, which `specials_of` names `OWN_STAR_NAME` so a
lyric's literal `*` can never target it — and not `STAR_NAME`, so the `star` arm still appends and prices
its own column rather than handing the decode a free absorbing token at the model's own probabilities while
the trail quotes `STAR_PENALTY_NATS`, which is review r1-tests-16), on the same 320/400 frame grid every
other bundle here uses — the equality check
in `emissions()` passes unchanged. The target sequence is romanised **per syllable fragment** (pypinyin
untoned for zh, cutlet per fugashi token for ja, uroman per Hangul block for ko), so each Latin target
carries the index of the grapheme it came from and the published text is never romanised (XA-20).

**THE LICENCE IS THE DECISION, AND IT IS THE OWNER'S.** MMS weights are **CC-BY-NC**: non-commercial use
only. That is compatible with a local or personal room and incompatible with shipping it as anybody's
default, so the arm exists, is measured, and is off. Nothing in this tree selects it without
`ENCORE_ALIGN_EXPERIMENTS=mms-roman`. Every other dependency these stages add is permissive:
**fugashi 1.5.2** MIT and **opencc-python-reimplemented 0.1.7** Apache-2.0, in a new `nonlatin` extra that
is absent by default (`units.rules` then answers the whitespace rule and `units.simplified` is the identity,
which is the configuration every row under `results/` was measured on).

> **SUPERSEDED on both counts by W10, 2026-10-19, and kept because the measurement above is unchanged.** The
> owner cleared the CC-BY-NC weights on 2026-10-16 (Encore is non-commercial), so `mms-roman` DOES ship as a
> default — for the languages the per-language table routes it to and no others, MMS still losing ja by 11
> points: "W10: the per-language stage-2 table". The function that answers the bundle is now
> `__main__.nonlatin_routes_for` (a table, not one name), and `romanize` + `nonlatin` are in the default
> install.

### The unit rules, and their cost

| song | lines | whitespace words | units | syllable fragments | truth syllables |
| --- | --- | --- | --- | --- | --- |
| `amll-zh-qingtian` | 62 | 77 | 494 | 494 | 494 |
| `amll-ja-yoru-ni-kakeru` | 56 | 56 | 431 | 710 | 693 |
| `amll-ko-gangnam-style` | 55 | 233 | 279 | 551 | 535 |

Tokenising a whole sheet costs **0.4-1.9 ms**, and building a backend 0.008 s (fugashi, over unidic-lite)
and 0.007 s (OpenCC's tables) once per process — against a 13-22 s emission pass. The Chinese units equal
the truth's syllables exactly (494 = 494); the Japanese fragments exceed the truth's spans by 17 of 710
because the TTML sometimes writes a two-kanji compound as one span (`二人`) where the mora rule splits it,
and the Korean by 16 of 551 for the same kind of reason. Those are PAIRED, not lost: the character-offset
rule scores each published fragment against the truth span that contains it. One truth syllable of
`amll-ja-yoru-ni-kakeru` paired with no published unit at all and is counted as `syllable_unpaired`, which
exists so an unpairable span cannot quietly leave the denominator.

### What these stages do NOT buy

* **No word document publishes for this lane.** §5.4 still declines words off a bundle with no
  `lexical.CALIBRATED` row, and neither the per-language whisperx bundles nor MMS_FA has one — so every row
  above is a `generate`-level reading of the raw decode, not of a published document. Calibrating a row
  (`lift_gate.py --model`, `line_gate.py --model`) is what would turn this capability into something a room
  sees, and it is a later wave's.
* **English is untouched, and it is measured as well as argued.** `units.rules` answers the whitespace rule
  for every language outside `{zh, ja, ko}`, so no arm can reach a Latin text, and the unit half does not
  even change the target sequence (`tests/test_units.py` asserts the two target tuples equal). Through the
  whole job: `_runs/w8s12-english-smoke` (`--level run_align --songs hello --modes truth`) publishes
  `doc_sha256` **4851b178858ce19f** and `onsets_sha256` **75391ffb463bfe9d**, DIGEST-IDENTICAL to the
  recorded `results/w9-r1-run_align` row, 63 lines, 0 gross. The new `syllables` block is None on an English
  row for want of a syllable truth, so no English metric gains or loses a reading.
* **Nothing here is a corpus reading.** One song a language, one mode, `truth` text only. The zh/ja/ko
  cells over all 7 songs, the wrong-text modes, and MMS_FA on ja are the bench runner's.

## W8: the non-Latin lane, priced on the corpus (2026-10-15)

The three stages above were built and measured a song at a time. This is the wave's bench cell: the whole
7-song truth set at the rung a room would actually see, every default-off arm over every song of its
language, and — first, because a capability wave that costs accuracy has failed — the English regression.
`results/w8-*.json` (23 rows, each with its per-case digest), `gates/w8.yaml`, `gates/w8-lane.yaml`. The
review's round-1 fixes then re-measured the 10 non-Latin `generate` cells and nothing else:
`results/w8r1-*-generate.json`, read on `gates/w8-units.yaml`.

**What the wave paid.** `adapters/ml.py`'s bytes are in the emission key, so the store was COLD: emitter
`14c8c0a4bfba8627` → **`cca402ad70419f05`**. ONE HuBERT-Large pass covers the English half — 61 matrices
computed in `_runs/w8-tt` (1727 s), after which `_runs/w8-ra` (1258 s) and `_runs/w8-lines` (1202 s) read
the store warm at 60 and 32 disk hits and **0 computed**. The non-Latin cells carry their own matrices per
bundle and per arm, 15 to 25 s a song. One tree throughout: code `0125c5457b5c8bf8`.

**What round 1 paid, and what it did NOT have to.** Code `0125c5457b5c8bf8` → **`30df17ce9f70433f`** and the
default emitter `cca402ad70419f05` → **`937ff602c752457e`** (`domain/lyrics/generate.py` entered the key
with `adapters/ml.py`), so the store is cold for the next runner and `--resume` into a W8 run is refused.
The bill was paid only where a reading could move or was unanswerable: **10 cells, 25 cases, 25 matrices,
276 s** — the 9 `generate` cells that carry no `syllable_unpublished` (23 cases, 245.5 s) plus the one
`mms-roman` cell r1 actually moved (2 cases, 30.0 s). **No English or Jamendo row was re-run and none is owed**: Latin languages take
`units.plain()`, so `generate`'s new attribution test is always true and the fragments are `split(...)` as
before; `align_model_name`'s new clause fires only for `language == ""`; `OWN_STAR_NAME` touches only a
vocabulary that ships a `*` column, which among the bundles in play is MMS_FA alone and no recorded row
pairs `mms-roman` with `star`; and the windowed PIN branch needs a pinned job on an aligner with no
`emissions`, which no bench row is.

**What review round 2 changed, and why NO recorded row moves.** Nineteen findings, and the one that
changed a shipped behaviour is the lane's own rule: a script `language.SCRIPT_LANGUAGES` can name no
language for (Thai, Bengali, Tamil, Armenian, Khmer — thirteen of them) reaches `detect` as `en`, which IS a
`lexical.CALIBRATED` bundle, so `may_time_words` found a row and the lane's rule never fired — a 6-line
Thai sheet with one English phrase per line published WORD timings, `high` and VOUCHED, off a lift measured
over 93 Latin letters against 244 Thai ones. Both engines now read `language.nonlatin_script(texts)` beside
the row (docs/arch/04-alignment.md §5.4). **No row under `results/` is in that shape**: every English row is
Latin-dominant, the ten non-Latin `generate` cells carry their own per-language bundle (uncalibrated, so
they already declined) and the three `w8-lane-*-ungated-run_align` rows set `h3-ungated-words`, which
bypasses this gate by construction. The other threading fixes are inert on the default path by
construction — `units.plain()` IS `str.split` with no spelling and no fold, so `parts.split` and the
LINE_SYNC rung's decode check compute what they computed before, and all 13 recorded arm rows are
`--level generate`, which runs neither. The windowed engine's pin now grades every published LINE `low`
(it graded only the record), and no bench row pins a job on an aligner without `emissions`.
**What it DOES cost the next runner: the emission store is COLD.** `domain/lyrics/language.py` is inside
`WhisperXAligner.emissions`' import closure, so the default emitter moves
`937ff602c752457e` → **`870238b803f071ae`** and code `30df17ce9f70433f` → **`113c7ab079fc8c73`**; the
matrices themselves are unchanged in content (nothing in the emission pass moved), and a `--resume` into a
round-1 directory is refused as the code change it is. Summaries also gain `meta["units"]` — the resolved
`units.Rules.name`, since `align_config` records the arm NAMES and `mms-roman` switches the bundle whether
or not its romanised targets had a backend.

### English does not move, and the proof is byte identity rather than a tolerance

| cell | 28-song `scored` truth ±500 | gross | `high_bad` | 0-gross songs | Jamendo ±100 / ±300 / AAE | highlight | wrong text |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `results/baseline-v2-run_align` (v2, no `scored` pool) | 88.56 (all 32) | 41 | — | 27/32 | 81.73 / 94.29 / 516.2 ms | 64.56 | — |
| `results/w9-r1-run_align` (the W9 close) | **97.27** | 0 | 0 | 28/28 | 85.54 / 97.23 / 70.6 ms | 81.50 | 0/320 + 0/320 |
| `results/w8-run_align` | **97.27** | 0 | 0 | 28/28 | 85.54 / 97.23 / 70.6 ms | 81.50 | 0/320 + 0/320 |
| `results/w8-time_text` | **97.31** | 0 | 0 | 28/28 | 85.54 / 97.23 / 70.6 ms | 81.50 | 0/320 + 0/320 |
| `results/w8-lines-run_align` | **100.00** (band 0) | 0 | 0 | 28/28 | — (no word is scored at that rung) | — | 0/320 + 0/320 |

Over the **1088 shared cases** of `_runs/w8-ra` against `results/w9-r1-run_align`, and the 1088 of
`_runs/w8-lines` against `results/w9-r1-lines-run_align`, **no field differs anywhere** — `doc_sha256`,
`onsets_sha256`, `outcome`, `confidence`, `verdict`, `gross`, `w500`, `scored`, `high_bad`, `band`,
`coverage`, `lift` and `words` all 0. `gates/w8.yaml` **92/92**, `gates/w9-r1.yaml` **86/86**,
`gates/w8b-arms.yaml` **77/77**, `gates/w8b-lines.yaml` **94/94**.

**The one apparent exception is the W9 FLIP, and it is measured as such.** At `time_text` 19 cases over 6
songs differ from `results/w9-time_text`, which is the only recorded `time_text` row and predates the owner
flipping `band-reopen` default-on. `_runs/w8-tt-preflip`
(`ENCORE_ALIGN_EXPERIMENTS=band-late-kept`, those 6 songs, the 7 right-text modes, 42 cases) reproduces that
row with **every field identical, `doc_sha256` and `onsets_sha256` included** — so all 19 are the flip's and
none is W8's. `results/w8-time_text.json` is therefore DECLARED the post-flip `time_text` baseline;
`results/w8-preflip-control-time_text.json` is the control that earns the declaration. Read against the
pre-flip row, `gates/w8.yaml` is 81/92 and all 11 failures are its byte-identity section.

### The lane, at the rung a room sees: 7 songs, 340 lines, 0 word documents, 0 of 21 wrong texts

| language | songs | published | line-synced | lines | gross | ±500 | band | `high` | words timed | wrong text |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| zh | 4 | 0 | **4** | 198 | 0 | 100.0 | 0 | 0 | **0** | **0/12** |
| ja | 2 | 0 | **2** | 87 | 0 | 100.0 | 0 | 0 | **0** | **0/6** |
| ko | 1 | 0 | **1** | 55 | 0 | 100.0 | 0 | 0 | **0** | **0/3** |

`gates/w8-lane.yaml` **20/20 on each language**. ±500 100.0 is a PUBLISH-RATE reading and not an accuracy
one — a line-synced document carries the sheet's own times — and the clock is a no-op on all 7 songs
(bias 0 ms at MAD 0), which is a third arbiter on the truth set from a mechanism neither admission reading
used.

### What stage 0 bought, measured against the lane as it stood

The counterfactual is runnable, so it was run rather than argued: `ENCORE_ALIGN_EXPERIMENTS=h3-ungated-words`
is the control that restores the ungated word document a routed bundle published before
`lexical.may_time_words` (`results/w8-lane-*-ungated-run_align.json`).

| | pre-stage-0 (`h3-ungated-words`) | shipped |
| --- | --- | --- |
| zh right text | 4 word documents, **284 words timed**, 187 lines graded `high`, ±500 97.98 | 4 line-synced, 0 words |
| ja right text | 2 word documents, **95 words timed**, 65 `high`, ±500 89.66 | 2 line-synced, 0 words |
| ko right text | **REFUSED — `no lyrics`, 1 of 1** | **1 line-synced, 55 lines, ±500 100.0, gross 0** |
| wrong text | **5 of 21 PUBLISH** (zh 2/12, ja 3/6, ko 0/3) | **0 of 21** |
| `gates/w8-lane.yaml` | 11/20, 11/20, 14/20 — REJECT | 20/20, 20/20, 20/20 |

So the gain is two countable things. **One song of seven moves from `no lyrics` to published** —
`amll-ko-gangnam-style`, whose word document the ungated lane refuses outright (the `kresnik` bundle tables
1 202 of 11 172 Hangul blocks, so its coverage collapses) and which now publishes **55 line-synced lines at
±500 100.0, gross 0**. And **five wrong texts of twenty-one stop publishing**, which is the ungated path the
wave was opened to close. The other six songs move from an UNGATED word document to a gated line document:
strictly less is published, by rule, and that is the trade stage 0 is.

**Romanisation, over all 7 songs rather than 2.** `--romanize shipped` (`results/w8-lane-*-romanized-*`):
all 7 songs publish, 340 lines, ±500 100.0 and gross 0 unchanged, and **`onsets_sha256` is IDENTICAL on
every one of the 7** while `doc_sha256` moves on every one — the document gains a field and not one onset
moves.

### Stages 1-2 on the corpus: `nonlatin-units` clears §3.12, MMS_FA clears it on zh and FAILS on ja

`--level generate --corpus nonlatin --modes truth`, all songs of each language (`--songs amll-<language>`,
one language a run), scored against the AMLL TTML's own syllable spans.

**THE ±100/±250/±300 COLUMNS DIVIDE BY THE UNITS THAT ALIGNED, NOT BY THE TRUTH** — review r1-spec-8, which
found this section claiming the opposite. `aligned/truth` is the coverage those columns are conditioned on,
and the reading on the TRUTH's denominator is `syllable_pco300`, which is what `gates/w8-units.yaml` now
evaluates §3.12's reject-if on: zh 25.35 / **95.55** / 95.55 / **97.03** (whitespace / `nonlatin-units` /
`+zh-simplify` / `mms-roman`), ja 10.72 / **81.95** / **70.98**, ko 51.78 / **72.52** / **92.52**. Only the
rows that lose spans move — ko `nonlatin-units` by 8.15 pt (80.67 → 72.52 over 481 aligned of 535) and ja
`nonlatin-units` by 0.40 — and **no verdict in this section turns on the difference**: `nonlatin-units`
still clears the 70 % floor on both named languages and `mms-roman` still reads below it on ja
(70.98 against 81.95, −10.97 pt).

| language | songs | arm | aligned/truth | unpub | ±100 | ±250 | **±300** | pco300 | gross | AAE | `gates/w8-units.yaml` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| zh | 4 | — (whitespace) | 1416/1416 | 0 | 10.59 | 22.18 | **25.35** | 25.35 | 253 | 1112.5 ms | 7/10 REJECT |
| zh | 4 | `nonlatin-units` | 1400/1416 | 0 | 58.50 | 94.21 | **96.64** | 95.55 | 9 | 124.4 ms | **10/10** |
| zh | 4 | `nonlatin-units,zh-simplify` | 1400/1416 | 0 | 58.50 | 94.21 | **96.64** | 95.55 | 9 | 124.4 ms | **10/10** |
| zh | 4 | `mms-roman` | 1416/1416 | 0 | 55.16 | 94.70 | **97.03** | 97.03 | 14 | 145.2 ms | **10/10** |
| ja | 2 | — (whitespace) | 1213/1213 | 0 | 2.64 | 8.66 | **10.72** | 10.72 | 503 | 1980.0 ms | 7/10 REJECT |
| ja | 2 | `nonlatin-units` | 1207/1213 | 0 | 49.88 | 79.20 | **82.35** | 81.95 | 9 | 192.0 ms | **10/10** |
| ja | 2 | `mms-roman` | 1208/1213 | 0 | 40.56 | 66.23 | **71.27** | 70.98 | 49 | 766.0 ms | **9/10** REJECT |
| ko | 1 | — (whitespace) | 481/535 | **24** | 36.38 | 44.70 | **57.59** | 51.78 | 14 | 431.9 ms | 8/10 REJECT |
| ko | 1 | `nonlatin-units` | 481/535 | **24** | 71.10 | 79.42 | **80.67** | 72.52 | 18 | 341.6 ms | **10/10** |
| ko | 1 | `mms-roman` | 535/535 | 0 | 70.09 | 91.96 | **92.52** | 92.52 | 20 | 197.4 ms | **10/10** |

**EVERY ROW OF THIS TABLE IS RE-RUN, and the gate column is the 10-reading file read on the run itself**
(`results/w8r1-{zh,ja,ko}-{base,units,t2s,mms}-generate.json`, `_runs/w8r1-*`, each with its per-case
digest). r1-spec-8 renamed the reject-if to `syllable_pco300` and added two accounting rules, so the file
now reads 10 (9 rules and the built-in `no-error-rows`) — and the one rule no OLDER row could answer is
`syllables-account-for-every-truth-span`, because `syllable_unpublished` did not exist when the 2026-10-15
rows were written and reads 0 on them by absence. Re-gating would have FAILED it by construction, so the
nine remaining cells were re-run rather than re-gated (the tenth, ja `mms-roman`, was already re-measured
for r1-tests-15 below). The identity now holds on all ten, and **the `unpub` column is the reading it
bought**: zh and ja publish every truth span's line, ko leaves **24 of 535 (4.49 %) on lines its document
never carried** — 7 of its 55 lines — which is a COVERAGE cost of the ko document and not an accuracy one,
bounded on its own by `syllables-mostly-on-published-lines` at 24 ≤ 32.1.

**THE RE-RUN MOVED NOTHING, and that is measured rather than argued.** Over the **23 cases** of the nine
cells, every field of the per-case digest is IDENTICAL to the recorded `results/w8-arm-*-generate` row —
`doc_sha256`, `onsets_sha256`, `scored`, `gross`, `w500`, `high_bad`, `words` and `repair_faults`, 0
differences — and in the summaries the ONLY key that differs anywhere is the new `syllables.unpublished`
itself. The r1 fixes could not reach these cells and now do not have to be trusted not to: `_READ_PER_WORD`
is `{ja}` and only `mms-roman` consults it, so for zh/ko `Rules.chars` computes the same fragments at the
same indexes, and the ja whisperx arms take no reading at all. Cost of the proof: **245.5 s and 23 freshly
computed matrices** — the emission key carries the arm, so each of the ten cells pays for its own, and the
store was cold anyway at code `0125c5457b5c8bf8` → **`30df17ce9f70433f`**.

**THE ja `mms-roman` ROW IS RE-MEASURED** (`results/w8r1-ja-mms-generate.json`, `_runs/w8r1-ja-mms`, both
ja songs, same bundle and same mode): review r1-tests-15 found that the arm romanised per fugashi TOKEN and
tagged every Latin target with grapheme 0, so the first mora of a multi-mora token absorbed the token's whole
span and **every later mora was published ZERO-WIDTH at the token's END** — 511 of these 1 229 ja truth
morae. With the attribution fixed (a token whose morae do not rebuild its own reading publishes no syllables,
`units.WHOLE_WORD`) the row reads ±100 **42.80 → 40.56**, ±250 68.38 → 66.23, ±300 **74.09 → 71.27**,
pco300 73.78 → 70.98, AAE **786.6 → 766.0 ms**, gross 50 → 49, and `bias_ms` **+83 → −47** — which is the
mechanism itself: those morae used to be scored against their token's end and are now scored against its
start. Every LINE field is identical to the digit (±500 87.36, gross 3), and zh and ko are untouched, their
fragments reading as their words do — which the nine-cell re-run above then proved case by case rather than
by construction. **So 74.09 was the confound's number and 71.27 is the arm's.** The row is 9/10 on
`gates/w8-units.yaml` and the one FAIL is `syllable-pm250-not-below-seventy` at 66.23, so the verdict is
unchanged in kind as well as in direction.

**§3.12's reject-if has two clauses and the corpus separates the arms on the second.** `nonlatin-units`
clears both: zh **96.64** and ja **82.35** against the 70 % floor, and it IS the per-language whisperx
bundle, so there is nothing for it to be below. `mms-roman` clears the floor (zh 97.03, ja 71.27) but the
clause "or below the blank-fixed whisperx models" is where it fails: on ja it reads **71.27 against
82.35**, −11.08 pt, with gross 49 against 9 and AAE 766.0 ms against 192.0. It wins on zh by +0.39 and on ko
by +11.85, both on COVERAGE rather than acoustics (535/535 and 1416/1416 spans, a romanised target being
unable to be out-of-vocabulary). **So MMS_FA is REJECTED on §3.12's own second clause and stays
default-off**, which is also where its CC-BY-NC weights leave it: the owner's call, not a measurement's.

**The one-song readings were optimistic and the corpus says by how much.** ja `nonlatin-units` ±300 was
**95.78** on `amll-ja-yoru-ni-kakeru` alone and is **82.35** over both ja songs; `amll-ja-ragutorein` is the
harder sheet (±500 70.97 at the line level, against 87.36 pooled). zh moves the other way only slightly,
97.55 on `qingtian` against 96.64 over four. Both still clear the floor, and the reject-if verdict does not
turn on the difference — but the gate file's floors were set from the one-song rounding and a later wave
should read them against this table rather than against those.

**`zh-simplify` is a no-op on this corpus, now over four songs rather than two.** Every figure in its row is
identical to `nonlatin-units` to the last decimal, all four zh sheets being written in Simplified. The arm's
correctness is proved hermetically instead (1 of 7 Traditional characters is a target without it, 7 of 7
with it); nothing here is evidence for it or against it.

**What this cell does NOT settle.** No word document publishes for this lane either way — §5.4 declines
words off a bundle with no `lexical.CALIBRATED` row — so every syllable number above is the RAW DECODE's,
and fitting such a row for a non-Latin bundle is a later wave's. ko is one song and is not in §3.12's
reject-if, which names zh and ja. No transliteration QUALITY is measured anywhere.

## W10: the per-language stage-2 table (2026-10-16)

The owner cleared MMS_FA's CC-BY-NC weights on 2026-10-16 (*"this is a non-commercial project so we are
clear"*), which removed the one non-measurement blocking stage 2. It did **not** make MMS the default,
because W8 measured it **losing** on Japanese. Re-read off the committed `results/w8r1-*-generate` rows,
on the AMLL truth's own syllable spans (`syllable_pco300`, the denominator that cannot be flattered):

| language | whitespace | `nonlatin-units` | `mms-roman` | shipped route | margin over the runner-up |
| -------- | ---------- | ---------------- | ----------- | ------------- | ------------------------- |
| zh (4 songs) | 25.35 | 95.55 | **97.03** | `mms-roman` on MMS_FA | **+1.48** |
| ja (2 songs) | 10.72 | **81.95** | 70.98 | `nonlatin-units` on whisperx's `ja` | **+10.97** |
| ko (1 song) | 51.78 | 72.52 | **92.52** | `mms-roman` on MMS_FA | **+20.00** |

Gross syllables (more than 2 s from truth) read the same way: zh 253 → **9** / 14, ja 503 → **9** / 49,
ko 14 → 18 / **20** — ja's is the clearest of the three, 49 against 9, and AAE says it louder still
(ja 192.0 ms under `nonlatin-units` against **766.0 ms** under MMS). **A blanket `mms-roman` default would
cost Japanese 10.97 points of PCO@300 and five times its gross population**, so the shipping form is a
TABLE and not a switch: `units.ROUTED`, one frozen row per language, in the shape `lexical.CALIBRATED` has
had since W4b. The design rules — unrouted means unrouted, an operator's named arm still reaches any
language, the bundle and the target sequence cannot disagree — are `docs/arch/04-alignment.md` §9.2 and
invariant **XA-21**.

Three consequences worth stating, because each is a thing the table does rather than says:

* **ko's route is the only arm that reaches its coverage gap.** `kresnik/wav2vec2-large-xlsr-korean` tables
  1 202 of 11 172 Hangul blocks, and 24 of ko's 535 truth syllables (4.49%, on 7 of its 55 lines) sat on
  lines its document never carried. A romanised target cannot be out of vocabulary, which is why ko gains
  20 points on coverage rather than on acoustics.
* **ja keeps MMS REJECTED, and the rejection is now a shipped rule** rather than a default-off knob: the
  `ja` row names `nonlatin-units`, and `ENCORE_ALIGN_EXPERIMENTS=mms-roman` is what reproduces the 70.98
  cell.
* **The 49 MB this needs is in the default install now.** `romanize` + `nonlatin` are synced by `dev.sh`
  and `docker/worker.Dockerfile`, because without a transliterator `units.stage2_bundle` cannot route zh or
  ko to MMS_FA at all — it keeps whisperx's own bundle and the script-unit rule, which is the 95.55 / 72.52
  column rather than a failure. They stay EXTRAS, so `uv sync --only-group dev` installs neither and the
  hermetic tests keep asserting the absent behaviour. MMS_FA's own attribution (CC-BY-**NC** 4.0, nothing
  redistributed, weights fetched at runtime) is `docs/arch/04-alignment.md` §14.2.

## W10: the ko floor, restated as the one-song reading it is (2026-10-16)

`gates/w8-units.yaml`'s `lines-not-lost` read `truth.pm500 >= 75.0` and ko passed it by **exact equality**:
`amll-ko-gangnam-style` is **36 of 48** scored lines within ±500 ms = **75.00**, on a ONE-SONG pool, with
7 further lines its document never carried. Zero margin, on a gate ko is not even in §3.12's reject-if for
(it names zh and ja). The owner was offered two ways out — a second Korean song, or an honest restatement.

**The evidence picks the restatement.** The AMLL set holds exactly ONE Korean candidate; `amll/_rejected/`
holds **13** candidates dropped on measurement and **not one of them is Korean**. So there is no second ko
song on this box to admit, and acquiring one needs audio this tree does not and cannot hold. The floor is
now **72.0** — one lost line of stated head-room (35/48 = 72.92 passes, 34/48 = 70.83 fails) instead of
zero implied. Every other cell clears it by 15 points or more, re-read off the committed rows rather than
quoted: zh **97.47** (`nonlatin-units`, 193 of 198) and **96.46** (`mms-roman`), ja **87.36** (76 of 87, the
same on all three arms, its lines being the whitespace rule's either way), ko **85.45** under `mms-roman`,
whose romanised target carries the 7 lines the Hangul vocabulary lost. The 75.00 reading is kept here and in
the gate file's comment: the number does not leave the repo, it stops being a floor.

## W10: the first non-Latin calibration rows (2026-10-16)

W8 named a `lexical.CALIBRATED` row for a non-Latin bundle as the ONE thing between stages 1-2 and a room:
without one §5.4 declines every word document and the lane publishes LINES by rule. Two rows now exist, one
does not, and the one that does not is the honest outcome rather than a gap.

Every number below was re-read from the scripts on 2026-10-19 and the runs are kept:
`encore-align-bench/_runs/w10-nonlatin-cal/` holds the six `lift_gate.py` fits (zh / ja / ko x stem / mix)
and the three `line_gate.py` sweeps, each as its printed report plus the per-text `--out` JSON. The six
commands are `lift_gate.py --corpus nonlatin --language <zh|ja|ko> --target <stem|mix>` and
`line_gate.py --corpus nonlatin --language <zh|ja|ko>`, run from `worker/` with `ENCORE_BENCH_ROOT` set;
the emission cache makes each one 20-45 s, so these are re-runnable without a sweep.

**The shuffle had to become script-aware first.** `lexical.lift` contrasts a text with `shuffles_of` it, and
`shuffles_of` permutes the UNIT RULE's tokens. The module has taken `units` since W8 — but neither
`lift_gate.py` nor `line_gate.py` passed it, so a CJK sheet with one whitespace token a line was contrasted
with *reordered lines*, not reordered words. Both scripts now build `units.rules_for(language, …)` once and
thread it through the lift, `letters_of` and `generate`, which is why W8 declined to fit a row off them.
Three further things the scripts needed, each a measured decision:

* **`--corpus nonlatin --language zh|ja|ko`**, one language a run, refusing `en` on that corpus for the same
  reason `e2e.py` does — the English bundle has a row and it is not this lane's.
* **A SAME-LANGUAGE donor pool.** A zh song paired with a ja sheet is refused by the script rule
  (`lexical.may_time_words` + `language.nonlatin_script`) long before a lift reads it, so scoring it as a
  wrong text this gate separated counts another gate's work. Donors repeat once the pool is under `WRONG_K`,
  so a repeated donor is skipped — on the non-Latin corpus only, the English rows being recorded with both
  wrong modes serving the same texts.
* **A pairing bug the non-Latin `headers` cases exposed.** `line_gate.measure` built its truth pairing from
  `clean_line` while `served` came from `clean_segments`, which also drops a NON-LYRIC row — so the injected
  `[Chorus]` / `Verse 1:` headers stayed in the index map and every later line paired to the wrong truth
  line. Measured on `amll-zh-gaobai-qiqiu` headers: served 40, kept 45, **176 of 176 scored lines gross and
  ±500 exactly 0.0%**, which is what made the first zh share read "no share shows 0 gross". Both scripts now
  read `clean_indexed`. The fix reaches the ENGLISH `headers` cases too, so the English share should be
  re-read from a fresh `line_gate.py` run; no shipped number moves, the share being 0.5 either way.

### The rows, and what each was fitted on

The stem columns are the three numbers the fit is made of, in the script's own words: the weakest right text
of all (`protected + drop50`, which is what the floor has to sit under), the strongest wrong text, and the
gap between those two. The weakest PROTECTED right text — the cap on `ok_from` — is its own column, because
on every row here it is a nat clear of the weakest `drop50`.

| pair | route | stem: weakest right / wrong max / **gap** | weakest protected | fitted | head-room |
| ---- | ----- | ---------------------------------------- | ----------------- | ------ | --------- |
| **MMS_FA / zh** (4 songs, 24 right texts, 12 wrong) | `mms-roman` | +0.6925 / +0.0402 / **+0.6523** | +1.4112 | `refuse_below` **0.35**, `ok_from` **0.70** | **+0.3098** |
| **…xlsr-53-japanese / ja** (2 songs, 12 right, 2 wrong) | `nonlatin-units` | +0.6864 / +0.0457 / **+0.6407** | +1.1771 | `refuse_below` **0.35**, `ok_from` **0.70** | **+0.3043** |
| **ko** (1 song, 5 right, **0 wrong**) | `mms-roman` | — | +1.8909 | **NO ROW** | — |

Both populations separate by two thirds of a nat per letter, which is a wider gap than any English bundle's
(base +0.072, HuBERT-Large +0.547): every one of the **20 zh and 10 ja PROTECTED** right texts reads above
+1.17 and the 4 + 2 `drop50` cases above +0.68, while every wrong text reads **below +0.046** — so the whole
wrong population is REFUSE at the 0.2 the base row uses, let alone at 0.35. `drop50` is the band the
`ok_from` cap comes from, as on every English row: the weakest reads +0.6925 (zh) and +0.6864 (ja), so 0.70
is the step above it and sits far under the weakest protected right text (+1.4112 / +1.1771).

**The mix halves are much thinner, and that is the lane's weakest number.** `--target mix`: zh `mix_floor`
**0.05** with **+0.0092** of head-room and **one** wrong text (+0.0408) inside the half-step under the
floor; ja `mix_floor` **0.05** with **+0.0278** and none. For comparison the shipped English rows read
+0.0349 (base), +0.0343 (HuBERT-L) and **+0.0021** with 3 in the half-step (HuBERT-XL, which shipped). zh's
is therefore inside precedent and ja's is comfortable, but zh's is the margin a later wave should widen
first. `mix_ok_from` is the per-band read a person makes, by the stem rule's own shape — the step above the
weakest drop50, capped at the weakest protected right text: zh +0.229 → **0.25** (cap +0.767); ja +0.217 →
0.25, capped at +0.187 → **0.15**. The blind envelope gate alone on the same mix matrices, for contrast,
refuses 6 of zh's 24 right texts and passes **6 of its 12** wrong texts (ja: 5 of 12 refused, 0 of 2
passed), which is why the lift is the gate on the mix too and not the envelope.

**`margin_floor_nats` is None on both rows, deliberately.** Nobody has read a trellis of MMS_FA or of the ja
bundle for placement margins, so the rule ABSTAINS rather than reading 10 nats off an English scale — the
same answer `HUBERT_ASR_XLARGE`'s row gives for the same reason.

### `line_sync_min_agreement` is 0.5, and the sweep says why

`line_gate.py --corpus nonlatin` reads **0 gross lines at every swept share from 0.3 to 0.8** on all three
languages, so the sweep has no discriminating power here and the script's own tie-break ("the lowest share
with no gross line") printed **0.3** for zh, ja and ko alike. The rows ship **0.5** instead, and the reason
is stated rather than assumed: the shares differ only in right texts refused — zh 0 / 1 / 2 / 4 / 4 / 6 of
52 across 0.3…0.8, ja 0 / 0 / 0 / 1 / 2 / 2 of 26, ko 0 / 1 / 1 / 1 / 2 / 2 of 12, the zh and ko costs both
being `drop50` cases — and wrong texts pass **0 of 12 (zh) and 0 of 2 (ja) at every share**, the lift
refusing them all. Taking 0.3 would read signal this corpus does not carry; 0.5 is what all three English
rows independently fit and what `lexical.LINE_SYNC_SHARE_UNCALIBRATED` already applied to this lane, **so
the rung's behaviour is byte-unchanged and the row's only effect is the word gate.** The cost is exact: 2 of
zh's 52 right texts and 0 of ja's 26, all `drop50`.

With the rows in, the rung's own table reads (every timed mode, `decode(0.5)`): zh right refused 2/52,
**2 387 lines shown, 0 gross, ±500 95.1%**, wrong texts 0/12; ja 0/26, **1 070 lines, 0 gross, ±500
99.2%**, wrong 0/2. `sheet+lift` — the rule W1 shipped — refuses 14/52 and 11/26 by comparison, which is
the envelope's cost on a lane whose sheets are authored TTML.

### ko has no row, and that is a measurement

ko is **one song**. A lift row is fitted from the gap between a right-text population and a wrong-text one,
and a one-song pool has **no same-language donor**, so there is no wrong-text population to separate: the
script prints *"no population to fit"* and `lexical.CALIBRATED` gets no ko entry. `extraverse` cannot be
built either, for the same reason. ko's right texts read a lift of **+1.912** on truth, so nothing suggests
the row would be hard to fit — only that it has not been fitted. **ko therefore keeps the W8
line-sync-only rule**, which was the outcome the wave required to stay reachable: its route still says
`mms-roman` on MMS_FA (the only arm that closes its 4.49% coverage gap), its lines still publish at ±500
100.0, and its words do not. And because the calibration key is a PAIR, zh's `MMS_FA` row cannot answer for
it — `calibration(emissions, "ko")` reads None on the very bundle zh is gated on, which is invariant XA-21
doing the one thing it exists for.

### What this moves, and what it does not

* **zh and ja may now publish WORD documents** off their own calibrated pairs: `may_time_words` declines a
  non-Latin text whose bundle language is `en` (the fallback case review r2-spec-8 found) and no longer
  declines one on its own row. This is the first behaviour change the non-Latin lane has made to what a room
  sees, and the bench agent's `run_align` cells are what price it.
* **ENGLISH DOES NOT MOVE.** The routing table fires only for a non-Latin language; `units.plain()` is still
  `str.split` for every Latin one; the English rows are byte-identical under the paired key, `(model, "en")`
  holding exactly the three values they held before. The one English-facing change is the `line_gate.py`
  pairing fix, which is a harness correction and feeds no committed `results/` row.
* **ko, and every other non-Latin language, keeps lines only** — 13 scripts `SCRIPT_LANGUAGES` names no
  language for included, which answer `en` and are declined by the script rule.

**ONE SONG THROUGH `run_align`, AND THE TWO W8 GATE FILES IT RETIRES (n = 1, NOT the verdict; W10 final
review, `_runs/w10-rev-zh-words`, code `35ebe339f1420309`, MMS_FA matrix served warm, 15 s).**
`amll-zh-qingtian` at `truth` now publishes a **WORD** document where W8 line-synced it: **61 of 62 lines,
gross 0, ±500 100.0, ±500/text 98.4, band 0**, and **60 of the 61 lines graded `high`** with none more than
0.5 s out. Words **17 of 77** paired at ±100 **64.7** / ±250 **100.0** / AAE **84 ms**; syllables **480 of
494** at ±300 **99.2** / PCO@0.3 **96.4** / AAE **99 ms**; TV highlight **2.7 %** of 224 s sung. Per-line
`margin_floor_nats` is None on this row, so the placement-ambiguity demotion ABSTAINED for all 61.
**`gates/w8-lane.yaml` reads 9/20 — REJECT — and that is the gate file being out of date, not a
regression**: the five it fails are `truth-no-word-document` [1 == 0], `truth-every-song-line-synced`
[0 == 1], `truth-never-high` [60 == 0], `truth-no-word-timed` [17 == 0] and `truth-clock-moved-nothing`
(bias **−94 ms** at MAD **35 ms**, where the LINE_SYNC rung's clock was a literal no-op). All five encode
the pre-calibration rule as a MUST; `ENCORE_ALIGN_EXPERIMENTS=nonlatin-unrouted` reproduces what they were
written for. Restating them needs the corpus cell, which is the bench agent's. The same note is in the two
gate headers.

## W10: the step split, and the byte-identity smoke that proves it (2026-10-19)

`steps/align_steps.py` went **3 696 → 2 530** lines, its module-level helpers moved to six siblings. The
split's design is [`../../arch/05-worker.md`](../../arch/05-worker.md) §1.1; this is its measurement.

* **AST identity, total over the move.** All **80** top-level definitions of the pre-split module are
  AST-identical to their post-split selves modulo docstrings; **78** of the 80 are identical including the
  docstring. The two that are not are `align_lines._enough_decoded` and `align_lines._mapped`, each of which
  lost a narrative paragraph to [`../../arch/04-alignment.md`](../../arch/04-alignment.md) §5.3 and §7 — the
  hard-rule-1 move the per-module prose ratchet demanded once the prose-dense helpers were concentrated in
  one module (`align_lines.py` reads **0.528** prose/code against the 0.55 bound; the package's worst module
  is still `domain/lyrics/policy.py` at 0.544).
* **End to end on two songs.** `_runs/w10-split-smoke` (`--level run_align --songs hello,Avercage --modes
  truth --asr off --romanize off --model HUBERT_ASR_LARGE`) republishes both documents and both onset series
  **digest-identical** to `_runs/w8s0-english-smoke`: `hello` `doc_sha256 4851b178858ce19f` /
  `onsets_sha256 75391ffb463bfe9d` at ±500 **63/63** gross 0, `Avercage_-_Embers` `005ddbf71545685a` /
  `1171b22563741216` at ±500 **39** of 42 lines, gross 0.
* **`tests/test_align_modules.py`** (9 tests) holds the three properties a later wave could break silently:
  the module set, that no sibling imports the step back, and that every name a test patches on `align_steps`
  is read by the step ALONE — a patch cannot reach a sibling's own globals.

## W10: the three owed `run_align` cells, probed on two songs (2026-10-19)

W9 left `vendored`, `claim-priors` and `priors-decide` without a `run_align` cell, and
`gates/w9-research.yaml` unread. The corpus cells are 2-3 hours each and belong to the bench agent; these are
the cheap probes that say what the gate will be reading, on `hello,Avercage` at `truth`, same config as the
smoke above.

| arm | `hello` | `Avercage_-_Embers` | reading |
| --- | ------- | ------------------- | ------- |
| base (knob unset) | 63/63 ±500, gross 0 | 39 ±500, gross 0 | the reference |
| `vendored` | **digest-identical** | **digest-identical** | the CONTROL holds: `doc_sha256` and `onsets_sha256` both unchanged, which is section 1's `doc_changed == 0` on a 2-song pool |
| `claim-priors` | 63/63, gross 0, digest moved | **40** ±500, gross 0 | one line better, nothing worse |
| `priors-decide` | **54**/63, **gross 2** | **37** ±500, **gross 1** | the deciding arm LOSES, and it is the one that bypasses the ladder |

**`gates/w9-research.yaml` has now been READ** — offline, against `results/w9-r1-run_align.json` as both
candidate and base (`_tools/offline_gates.py`): its **83** rules read as **84 verdicts — 80 PASS, 4 FAIL, 0 ERROR** (one rule
expands over two modes). Zero ERROR rows is
the point: every rule's keys resolve against a real `run_align` summary, so the bench agent's corpus run
cannot be wasted on a malformed gate file. The 4 FAIL are exactly the clauses that cannot pass a self-compare
because they require the arm to WIN — `drop50-gross-down`, `drop50-text-pm500-up`, `blind-gross-down`,
`pooled-gross-down`. On the two-song probe `priors-decide` moves all four the wrong way.

## W10: fitting the claim prior's peak (2026-10-19)

W9 shipped `prior.ONSET_BONUS_NATS = 4.0` CHOSEN, not fitted, and named the missing experiment: a
decode-only sweep over the peak. It cost **101.6 s** — `_runs/w10-prior/peak_sweep.py`, published as
`results/w10-prior-peak-sweep.json`: **8 songs × 4 claim modes × 7 cells = 224 rows**, 374 in-text lines a
mode (1 496 pooled), HuBERT-Large matrices at emitter `1a2fd6852bd30243`, global decode through the vendored
graph, `scored_row`'s denominators (`text_pm500 = w500 / in_text`).

| peak (nats) | pooled gross | pooled ±500/text | pooled AAE | `truth` gross | `jit` | `tempo102` | `off3` |
| ----------- | ------------ | ---------------- | ---------- | ------------- | ----- | ---------- | ------ |
| `off` (torchaudio) | 44 | 88.77 | 413.2 ms | 11 | 11 | 11 | 11 |
| 0 | **44** | **88.77** | **413.2 ms** | 11 | 11 | 11 | 11 |
| 1 | 37 | 89.44 | 361.7 ms | 7 | 9 | 10 | 11 |
| 2 | 28 | 90.17 | 341.7 ms | 4 | 4 | 9 | 11 |
| **4.0 (ships)** | 26 | 91.31 | 314.4 ms | 4 | 3 | 8 | 11 |
| **8** | **23** | 92.05 | 269.2 ms | 2 | 2 | 8 | 11 |
| 20 | 30 | 92.58 | 215.0 ms | **0** | **0** | 11 | **19** |

* **The graph with no bonus IS torchaudio's path.** `peak 0` reproduces the `off` control to the last digit
  in all four modes — a free second reading of the `vendored` control, at the decode level.
* **8.0 is the pool's optimum and it DOMINATES the shipped 4.0**: in none of the 32 song-modes is 8 worse
  than 4 on either gross or ±500. Pooled gross 26 → 23, AAE 314.4 → 269.2 ms.
* **20 is where a claim stops being evidence.** `truth` and `jit` keep improving (gross 0), but a 2 % tempo
  error goes back to the control (8 → 11) and a 3 s offset gets much worse than reading no claim at all
  (gross 11 → **19**, ±500 88.77 → 86.36). That is the failure the reach cap exists for, and it says the
  peak's ceiling is set by the WRONG-clock modes, not by the right ones.
* **The shipped value is unchanged, deliberately.** The arm is default-off, the pool is 8 songs on one
  emitter, the sweep is decode-only (no claim clock, so `off3` here is the clock-failed worst case rather
  than the shipped path), and W9's recorded `claim-priors` readings are at 4.0 — moving the constant now
  would make the owed corpus cell incomparable with them. The honest statement is no longer "unfitted": it
  is "4.0 is inside the safe region, 8.0 is this pool's optimum, and σ / reach are still unfitted".

## W10: the close-out sweep, and the lane at the rung a room sees (2026-10-19)

The build's last corpus sweep, on the W10 tree (code `35ebe339f1420309`, emitter `10bb06b8c2533a5b`, HuBERT-Large
on `mps`). It answers four questions nobody had measured on a corpus: did the `align_steps` split and the two
calibration rows cost English anything; what the non-Latin lane publishes now that the per-language stage-2
table is the shipped default; whether the table really picks each language's winner; and what the three
`run_align` cells W9 owed read on the 28-song accuracy basis.

### English did not move, and the proof is 3 264 byte-identical documents

The emission store was cold (W8's r2 moved the emitter, and W10 moved it again to `10bb06b8c2533a5b`), so the
`time_text` level paid the full pass — **59 matrices computed, 1 419 s** — and the other two levels read it off
disk. Every level was then compared to its W8 row CASE BY CASE on `doc_sha256` and `onsets_sha256`, which is a
stronger claim than any tolerance: a summary can hold its headline steady while individual documents move.

| level | row | cases | documents moved | gate file | reading |
| ----- | --- | ----- | --------------- | --------- | ------- |
| `time_text --modes all,wrongtext+ownclock` | `results/w10-time_text.json` | 1 088 | **0 of 1 088** | `gates/w8.yaml` | **92/92** |
| `run_align --modes all,wrongtext+ownclock` | `results/w10-run_align.json` | 1 088 | **0 of 1 088** | `gates/w8.yaml`, `w8b.yaml` | **92/92**, **154/154** |
| `run_align --sync-mode lines` | `results/w10-lines-run_align.json` | 1 088 | **0 of 1 088** | `gates/w8b-lines.yaml` | **94/94** |

So every headline number is W8's, re-read rather than quoted: 28-song `scored` truth ±500 **97.27** at
`run_align` and **97.31** at `time_text`, gross **0** in all 12 right-text modes, `high_bad` **0**,
zero-gross songs **28/28**, Jamendo words ±100 **85.54** / ±300 **97.23** / AAE **70.6 ms**, highlight
**81.50**, wrong text **0/320 + 0/320 + 0/640**, and the LINE_SYNC rung **100.00** at band 0 over 28 songs.
**This is also the `align_steps` split's proof as a pure move at corpus scale** — `_runs/w10-split-smoke`
proved it on two songs, and this proves it on 3 264 documents across 16 claim modes and three rungs.

One pre-existing gate reading, recorded so it is not mistaken for a regression: `gates/w9.yaml` reads
**87/88** with `word-pco300-truth` (`truth.jamendo.word_pco300 >= 91.78`) FAILING at **91.76**. It fails
identically on `results/w8-run_align.json` and `results/w9-r1-run_align.json`, and that gate file's own header
already says section 1 fails on the post-flip tree by construction. It is a stale literal, not a move.

### The lane with the table active: zh and ja publish words, ko still publishes lines

`results/w10-lane-{zh,ja,ko}-run_align.json` (7 songs, 340 lines, 3 wrong-text cross-pairs a song), beside the
control `ENCORE_ALIGN_EXPERIMENTS=nonlatin-unrouted` in `results/w10-lane-*-unrouted-run_align.json`. The gate
file is the new `gates/w10.yaml`, which replaces `w8-lane.yaml` §1 on the shipped default.

| language | bundle the table picked | calibrated pair? | rung | ±500 | gross | `high` | `high_bad` | syllable PCO@300 | wrong text | `gates/w10.yaml` |
| -------- | ----------------------- | ---------------- | ---- | ---- | ----- | ------ | ---------- | ---------------- | ---------- | ---------------- |
| zh (4 songs) | **MMS_FA** | yes | 4 word docs | 98.98 | **0** | 189 | **0** | **95.90** | **0 of 12** | **24/24** |
| ja (2 songs) | whisperx's own `ja` | yes | 2 word docs | 89.66 | **0** | 65 | **2** | **82.03** | **0 of 6** | 23/24 |
| ko (1 song) | **MMS_FA** | **no row for the PAIR** | 1 line-sync | 100.00 | **0** | 0 | **0** | n/a | **0 of 3** | **24/24** |
| zh unrouted | `xlsr-53-chinese-zh-cn` | no | 4 line-sync | 100.00 | 0 | 0 | 0 | n/a | 0 of 12 | 24/24 |
| ja unrouted | whisperx's own `ja` | yes | 2 word docs | 89.66 | 0 | 65 | **2** | **10.88** | 0 of 6 | 23/24 |
| ko unrouted | `xlsr-53-korean` | no | 1 line-sync | 100.00 | 0 | 0 | 0 | n/a | 0 of 3 | 24/24 |

* **THE WRONG-TEXT PATH IS STILL CLOSED, and this is the reading that mattered most.** 0 of 21 cross-pairs
  published, per language and in total, with the table active and the global engine therefore reachable for the
  first time on this corpus. Every case REFUSED; `scored` 0, so not one wrong line was ever measured against a
  song's truth. W8 bought this with no calibration row in existence; it survives two of them.
* **THE PAIRED KEY WORKS, and MMS_FA is its own proof.** The same bundle publishes 4 word documents for zh and
  declines one for ko, because `("MMS_FA", "zh")` has a row and `("MMS_FA", "ko")` does not. A bundle-only key
  could not express that — which is exactly why W10 made the key a pair (**XA-21**).
* **ko's ROUTE IS INERT AT THIS RUNG.** The table moves ko onto MMS_FA, the arm worth +20.00 points of
  syllable PCO@300 at `generate`, and ko then publishes precisely what it published before the table existed:
  one line-synced document at ±500 100.00, `high` 0, 0 word timings. The gain is real and unreachable until
  the `("MMS_FA", "ko")` pair has a calibration row. Nothing is wrong; the route is simply not yet connected.
* **THE ROWS COST LINE ACCURACY, and the cost is now priced.** Gaining word documents moved zh and ja off the
  gated LINE_SYNC rung: zh ±500 100.00 → **98.98** (one of 198 lines now missing), ja 100.00 → **89.66** with
  band 0 → **9**. ko is unmoved. Gross stays **0** on all six readings, so no line went more than 2 s wrong —
  the lane traded a little line precision for word documents, and lost no line outright.
* **ja's ROW VOUCHES TWO BAD LINES.** `high_bad` reads **2** of 65 `high` lines, both on
  `amll-ja-ragutorein` (15 `high` of its 31 lines), and it reads 2 under `nonlatin-unrouted` too — so it is
  the `("jonatasgrosman/wav2vec2-large-xlsr-53-japanese", "ja")` row's thresholds and not the routing.
  English reads `high_bad` **0** over 1 536 scored lines, so 0 is the standard and not a tightening.
  `gates/w10.yaml`'s `never-vouch-a-bad-line` is left FAILING on ja rather than relaxed: moving `refuse_below`
  / `ok_from` on that row changes what the lane publishes.
* **`nonlatin-unrouted` DOES NOT reproduce the pre-W10 configuration for ja**, and the notes added to
  `gates/w8-lane.yaml` and `gates/w8-nonlatin.yaml` on 2026-10-19 say it does. ja's route keeps whisperx's own
  bundle and the ja calibration row is unconditional, so the unrouted ja control publishes the SAME 2 word
  documents, the SAME 65 `high` lines, the SAME `high_bad` 2 and the SAME ±500 89.66. All unrouting changes
  for ja is the UNIT rule, and it moves syllable PCO@300 **82.03 → 10.88** — which is the strongest single
  reading of the `nonlatin-units` arm anywhere in this build, because it is measured at the publishing rung
  rather than on the raw decode. For zh and ko the note IS correct: the bundle falls back to one with no row,
  so §5.4 declines a word document and the lane returns to lines.

### The lane's word timings are not gradeable at WORD granularity, and syllables are why that is survivable

`words.mismatched` reads **265 of zh's 288** truth words and **95 of ja's 95** under the routed arm: the
published tokens are script units (ja) or romanised syllables (zh) and the AMLL truth's are original-script
words, so no word-level pairing exists for them. zh's word ±100 of **64.71** is 11 of **17** paired words, not
of 288, and its word PCO@300 of **5.90** is the honest statement of that coverage. The SYLLABLE spans do pair —
zh 1 385 of 1 416 aligned (23 interpolated, 8 on lines the document never carried), ja 1 207 of 1 213 (5
interpolated, 1 unpaired) — and `gates/w10.yaml` §6 gates the identity rather than a floor so that a language
publishing no words at all (ko: 535 of 535 `unpaired`) still balances. **Syllables are this lane's only
gradeable sub-line unit, and every accuracy number quoted for it above is a syllable number.**

### The per-language table picks each language's winner, measured arm by arm

`results/w10-s2-{zh,ja,ko}-{white,units,mms,table}-generate.json` — 12 cells, `gates/w8-units.yaml` on every
one. `nonlatin-unrouted` stands the routed row down, so naming it with ONE arm isolates that arm, naming it
alone is the whitespace control, and naming nothing is the table's own pick. Every number reproduces the
committed W8 cell exactly, and the `table` column is the measurement that was owed: it is the shipped default's
own reading, not an inference from the arm cells.

| language | whitespace | `nonlatin-units` | `mms-roman` | **`table` (shipped)** | bundle the table used | margin |
| -------- | ---------- | ---------------- | ----------- | --------------------- | --------------------- | ------ |
| zh | 25.35 (7/10) | 95.55 (10/10) | **97.03** (10/10) | **97.03** (10/10) | MMS_FA | +1.48 |
| ja | 10.72 (7/10) | **81.95** (10/10) | 70.98 (**9/10**) | **81.95** (10/10) | `xlsr-53-japanese` | +10.97 |
| ko | 51.78 (8/10) | 72.52 (10/10) | **92.52** (10/10) | **92.52** (10/10) | MMS_FA | +20.00 |

**The table picks the winner in all three languages, and ja does NOT get MMS** — its `table` cell is byte-equal
to its `nonlatin-units` cell (PCO@300 81.95, ±250 79.20, gross 9, AAE 192.0 ms) and nowhere near MMS's 70.98 /
66.23 / 49 / 766.0 ms. The three whitespace controls REJECT at 7/10, 7/10 and 8/10, which is what makes the
other nine cells a measurement rather than a tautology; ja's `mms-roman` cell REJECTS at 9/10 on
`syllable-pm250-not-below-seventy` (66.23), the single clause that encodes §3.12's reject-if for it. Line ±500
clears the restated ko floor of 72.0 everywhere: zh 97.47 / 96.46, ja 87.36 on all three arms, ko 75.00 (both
whisperx arms) and **85.45** under the route.
