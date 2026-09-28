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

| song | authored lines | span |
| --- | --- | --- |
| `tfr-flyaway` | 75 | 13.20 s .. 189.54 s |
| `tfr-mayday` | 52 | 13.14 s .. 239.34 s |
| `tfr-chosen` | 37 | 10.00 s .. 229.00 s |

## Machine

| id | machine | chip | cores | memory | OS |
| --- | --- | --- | --- | --- | --- |
| `m1pro` | MacBookPro18,1 | Apple M1 Pro | 10 (8P + 2E) | 32 GiB | macOS 26.6.2 (arm64) |

Aligner: `whisperx` 3.8.7rc1 wav2vec2 forced alignment on `torch` 2.8.0, device `cpu`.

## The mechanism that makes this a sweep and not one number

**whisperx does not search the recording.** It crops the audio to each segment's provisional span and aligns
the text *inside* it. So accuracy is not a property of the aligner — it is a property of the aligner **and
the windows it was handed**. Two regimes on the same song and the same audio:

| provisional spans | bias | MAD | within ±250 ms | >2 s off |
| --- | --- | --- | --- | --- |
| the truth's own timings | +122 ms | 102 ms | 74.7% | 0/75 |
| spread evenly (untimed text) | +846 ms | 3714 ms | 1.3% | **57/75** |

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
  at full precision (`capture_lifts`, a wrap that returns what `lexical.lift` returns; the trail prints two
  decimals, and +0.195 prints `+0.20` and is refused at 0.2), None where the text was exempt, unmeasurable
  or the check raised. A LINE_SYNC attempt writes no `align-global` note, so its `verdict` reads `?`; its
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

| target | right texts (protected / drop50) min | wrong max (Jamendo / YouTube+tfr) | shipped |
| --- | --- | --- | --- |
| stem | +0.359 / +0.255 (Jamendo), +0.378 / +0.281 (YouTube+tfr) | +0.189 / +0.113 | refuse < 0.2, doubt < 0.3, ok |
| mix | -0.063 (truth median +0.75; 24/192 below 0) | +0.132 / +0.106 | refuse < 0.15, doubt < 0.6, ok; beside the envelope gate |

- **Held out**, stem: τ fitted on Jamendo (+0.274) scores 0 errors on YouTube+tfr, τ fitted there (+0.245)
  0 on Jamendo. On the mix the populations overlap; the floor sits above both splits' wrong maxima.
- **How it combines with the envelope gate on a stem**, case by case over the W1 time_text bench at τ 0.2:
  envelope alone 8/448 right cases refused (rap-god drop20, never-be-alone credit, 6 drop50), 152 + 280 wrong
  passed; **lift alone 0/448, 0 + 0**; both required 8/448, 0 + 0; either enough 0/448, 152 + 280. Only the
  lift alone meets the reject-if, so on a stem it REPLACES the envelope gate wherever it measured the text.
- **On the mix the lift reads how well the words are heard**: truth texts under 0.15 decode blind with a
  median 24% of lines within 1 s (numb 0/35; 172/237 lines over 2 s off), 0.15-0.6 a median 55% (140/343),
  above it 81% (149/1166), so the doubt band there is wide. The envelope gate stays beside the floor (the review's rule) although its measurable half sorts the
  mix badly (it passes numb's unheard decode, refuses Rxbyn's 92%-within-1 s one; with the floor it refuses
  114/192 right texts, the floor alone 48/192, both 0/640 wrong): the default-off arm `h3-mix-lift-alone`
  drops it, pending a stemless bench mode.
- **Exempt**: the ASR tier and a text the lift cannot measure; both keep the envelope gate. A pin is never
  judged a wrong text (refused words publish graded low, `pin-unvouched`). A lift whose decode raised leaves
  the envelope gate and is an ERROR row (`e2e.FAULT_LEXICAL`).
- **Targeted probe** (`time_text`, rap-god + never-be-alone × truth / drop20 / credit / blind + 20 wrong + 20
  same-video wrong): the 2 protected right texts the envelope refused now publish (rap-god drop20 0 gross,
  158/174 within ±500 ms; never-be-alone credit 0 gross, 38/46), the other 6 right documents are
  byte-identical to W1's, and 40/40 wrong texts are refused (W1: 11 published). The corpus bench is the
  wave's bench runner's.


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
(no emission matrix, a decode that raised, fewer than 3 lines paired) the sheet gate decides as W1 shipped it.
The envelope fit still places the lines. Cost: one `generate` decode beside the lift's four, and the emission
pass for every text that reaches the rung (the sheet gate used to refuse about a third before it).
