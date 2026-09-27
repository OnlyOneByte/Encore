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
window or scoring ≥0.5 below the song's median line score). `bench.py --global --claims` drives the real
modules.

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
