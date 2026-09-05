# Scoring — research and current thinking

**Status: research only. Nothing here is committed to, staged, or scheduled.** This is not a spec: no
acceptance criteria, no commit plan, no migration. It exists so that whoever rebuilds scoring starts
from what was measured rather than from the assumptions that produced the first attempt.

Live scoring was **removed entirely** (`Remove live scoring entirely`). It was fully built and
unit-tested but deliberately unplugged: `followUps()` never enqueued the `score` job because that job
re-ran the whole separation to obtain a vocals stem it could have read off disk. The removal commit
message carries the defect list; this file carries the research.

---

## 1. The north star, in one paragraph

**Score against a note grid we derive ourselves, per word, on axes where pitch is only about half —
and decide the microphone question before writing any of the scoring math.** The reference side is
nearly free for us and is where we are *ahead* of the incumbents. The capture side is the entire
remaining difficulty, and it is the part every credible system solved with hardware rather than
software.

That splits the product in two, and the eventual room setting should pick **which tier**, not merely
on/off:

| | Tier 1 — the honest default | Tier 2 — opt-in, gated on clean capture |
|---|---|---|
| Claim | none; descriptive and additive | pitch accuracy, multi-axis |
| Measures | participation, sung duration, range covered, highest note reached | per-word pitch vs a derived note grid, plus stability / dynamics / timing |
| Deductions | none | yes, curved so a 90 stays rare |
| Works with | a phone mic in a loud room | a headset mic, or working cancellation against the instrumental |
| Precedent | Smule's own documented analytic; DAM ships this alongside its real scorer | DAM/JOYSOUND precision modes, UltraStar, SingStar |

Tier 1 is cheap, robust and defensible today. Tier 2 is only honest once capture is solved.

**A hard constraint either way: scoring must never gate readiness.** The cook is
fetch → stems → align and it ends there. A song is singable without a score, and anything that makes
readiness wait on analysis strands the library — this project has already been bitten by exactly that
class of gate.

---

## 2. What every credible system actually does

Surveyed: JOYSOUND and DAM (Japanese precision machines, official pages), SingStar / Karaoke
Revolution / Rock Band vocals, UltraStar Deluxe and Performous, Smule / StarMaker / Yokee, and the
MIR literature on automatic singing assessment. Five findings held across all of them.

**1. The reference is an authored note grid, never a raw f0 curve.** DAM and JOYSOUND ship a
hand-authored guide melody (ガイドメロディー) per song and draw the singer's trajectory over it.
UltraStar's `.txt` charts are integer semitones per syllable, authored by the community. Nobody
compares a singer against a pitch curve extracted from a studio vocal, because such a curve contains
every slide, vibrato, ad-lib, harmony bleed and separator artifact — none of which is the target the
singer is being asked to hit. **This was the first implementation's root error.**

**2. Octave-agnostic matching is universal.** DAM's check is explicitly *relative* — singing an
octave below still registers on the bar. UltraStar folds mod 12. The old `octaveAgnosticCents`
primitive was the one part of the removed code that was right.

**3. Tolerance is a window with partial credit, not a continuous closeness weight.** The
widely-repeated DAM figure is ±50 cents (half a semitone); UltraStar credits tightly within about
±0.5 semitone and gives partial credit further out. A continuous rolling closeness weight — what the
removed scorer used — produces a number nobody can interpret.

**4. Pitch is only ~40–50% of the score.** JOYSOUND's five items, with community-reported weights:
pitch 40, stability 30, long-tone 15, dynamics (抑揚) 10, technique 5. DAM shows five axes on a radar
chart plus named-technique bonuses — shakuri (scooping up into a note), fall (sliding down out of
one), kobushi (an ornamental warble) — and its newest generations detect roughly a dozen further
techniques without displaying them, feeding a trained "sounds good" bonus.

This is substance, not presentation. The PESnQ line of work measured that a **linear combination of
per-parameter human scores predicts the overall human judgement**, and reports high per-parameter
correlations even where its aggregate sits at r≈0.59. That is the argument for a multi-axis readout
over a single number — and it is convenient here, because the axes that survive a noisy microphone
best (dynamics, timing, long-tone sustain) carry real weight.

**5. Nobody solves microphone bleed in software; they engineer it away.** DAM assumes a close-mic'd
cardioid dynamic held 10–15 cm away, a controlled monitor mix (recommended backing:mic:echo ≈ 4:4:3),
echo kept deliberately low so reflections don't blur vibrato detection, and low-cut/de-esser filters
switched on. It *penalises* moving the mic and treats howling as noise that destroys scoring, with no
suppression. SingStar and Rock Band shipped USB microphones. Neither Japanese vendor documents any
de-bleed algorithm, because with that audio path they never had the problem.

Latency is the same story: fixed hardware gives it to them for free and they never document it, while
UltraStar instead exposes a **user-configured mic-delay offset in milliseconds** subtracted from
detection timestamps. Guessing the offset — what the removed implementation did, by interpolating
`positionSec` on the phone — appears nowhere.

Two more worth stealing. Scores are **deliberately recalibrated stricter** each machine generation so
a 90 stays rare; the score is a curve, not a raw percentage. And there are blunt anti-abuse rules —
skipping ahead is a flat −2 and forfeits 100, and singing a shortened version caps below 100.

---

## 3. The capture problem, and why it is the gate

The entire phone-mic tier of this industry has already given up on credible accuracy:

- **Smule**'s only *documented* per-song analytic is Recording Recap — pitch range, highest note,
  duration. Descriptive statistics, explicitly not a comparison against a melody. The numeric score
  has no published formula and the largest community forum's verdict is that it is "pretty
  meaningless" and inflates with song length.
- **Yokee** documents no pitch scoring at all, and auto-applies echo and reverb so you "always sound
  great" — the design goal is flattery.
- **StarMaker** is the closest to real and is reported timing-dominant and gameable: hit the line in
  the right window and the grade arrives largely regardless of pitch.

The one documented software technique worth taking is Smule's **crosstalk reduction**, which lets the
backing track bleed into the mic and cleans it up afterwards rather than requiring headphones or
gating the score. **Encore is better positioned than Smule to do this**: Smule is cancelling a track
it streams, whereas we hold the exact instrumental file on disk and know the playback position. That
makes it the single highest-value experiment before any scoring math is written.

Alignment, when latency is unknown, has a standard answer in the literature and it is not a constant
offset: **DTW over the pitch track and separately over the log-energy envelope**, with HMM/Viterbi for
note-level rhythm (Tsai & Lee, TASLP 2011). A single cross-correlation offset only corrects constant
latency; a real singer drifts in tempo. Online DTW variants exist for live following, and a
transposition-aware variant handles accumulated pitch drift — relevant here because key shift means
the sung key and the reference key need not match.

---

## 4. Where Encore stands today

What already exists, and did not when the first attempt was built:

- **Vocals stem, published and retained.** Both separator engines isolate, encode and publish it; the
  guiding-track feature persists `vocalsRef`, and retention preserves it. The reference audio is on
  disk.
- **Word-level timings.** `align` is the last step of the cook and readiness waits for it, so a
  cooked song has word boundaries — the exact input a note grid needs.
- **A working precedent for deriving analysis from stems.** `KeyAndRange` (`apps/worker/src/steps/analysis.py`)
  computes musical key from the instrumental and sung range from the vocals by reading the **raw
  separated WAVs still sitting in scratch** — no extra separation, no extra decode, no new job type.
  It runs through the keepalive wrapper precisely because it is in-process numpy over minutes of
  audio. A note-grid step would be the same shape, in the same `analysis/` domain, added to the same
  stems plan. Compare this with the removed `score` job, whose disqualification was re-running the
  entire separation for vocals it could have read off disk.
- **A step/plan worker.** Adding an analysis step is now a declared step in a plan rather than a new
  processor class (`docs/specs/SPEC-worker-pipeline.md`).

What does **not** exist:

- **Any microphone path on the TV.** All Web Audio lived on the phone, and that code was deleted with
  the rest of scoring.
- **Any end-of-song server event or per-play persistence for the *finishing* song.** `plays` rows are
  written at song **start**, keyed to the *incoming* entry, so there is no hook today for "song N just
  finished".
- **Any post-song UI moment.** The only transition surface is the song-intro / "Next up" hold.

The implication is the one that matters: **the reference side is close to solved and we are ahead of
the incumbents on it** — they hand-author or crowdsource their note grids, while we can derive ours.
`ultrastar-pitch` exists to do exactly this shape of job: it does not generate timing, it fills a
pitch into notes that are *already timed*, which is our situation precisely. Spotify's `basic-pitch`
does note segmentation with MIDI export if onsets are wanted too. Take the median f0 inside each word
window, quantise to the nearest semitone, done — offline, cheap, on audio already in scratch.

So the remaining difficulty is entirely capture, which is the one thing every system above avoided by
controlling the hardware.

---

## 5. Honest ceilings, and what it must never claim

- Classic feature-engineered karaoke scoring tops out around **Pearson r ≈ 0.82** against human
  ratings, using pitch + volume + rhythm with DTW/HMM alignment — **on clean input** (Tsai & Lee,
  TASLP 2011). Ranking-based systems land near ρ ≈ 0.72. Anything built from a phone in a loud room
  sits below that ceiling, and the number should never be presented as if it doesn't.
- **Separation artifacts degrade the reference.** A 2022 study found loudness-curve transcription
  accuracy limited by exactly that. Our reference comes from a separated stem, so the dynamics axis
  inherits the noise; pitch is more robust to it than loudness.
- DAM's perceptual "sounds good" bonus is a model trained on large proprietary human-rated datasets.
  It is inspiration, not a spec — do not pretend to replicate it with heuristics.
- Population-relative calibration (DAM's national average) needs a user base per song that a
  self-hosted party server will not have. Lead with an absolute curve.

If the answer to the capture question stays "phone mic in a loud room, as-is", then the honest product
is Tier 1 and everything in section 2 about pitch tolerance is over-engineering.

---

## 6. Open questions for whoever picks this up

1. **The audio path.** Recommend a headset/earbuds mic? Capture at the TV via USB? Attempt
   cancellation against the on-disk instrumental? Or accept contamination and ship Tier 1 only? This
   decides everything downstream.
2. **Does crosstalk reduction actually work here** at party volume, in a real room, with a real phone?
   That is a measurable experiment and it should come before any scoring code.
3. **Live or post-hoc?** Buffering the singer's frames and aligning once at song end removes the
   position-guessing problem entirely and makes the score explainable, at the cost of no live meter.
   The removed implementation was live-first, which is what forced it to guess.
4. **Where a post-song moment lives** on the TV, given the song-intro / "Next up" hold already owns
   that window — stack, or replace?
5. **Whether any score is persisted.** A leaderboard needs a per-play write at song *end*, which has
   no hook today.

---

## 7. Sources

Japanese precision scoring (official): clubDAM 精密採点DX-G, JOYSOUND 分析採点マスター, JOYSOUND
全国採点グランプリ, and the Japanese Wikipedia article on 精密採点 for generation history and the
detected-but-hidden technique list. Mic/audio-path guidance from LIVE DAM Ai setup write-ups.

Open source: UltraStar Deluxe (`.txt` note format, octave folding, point budget, mic-delay setting),
Performous / Vocaluxe. Auto note-grid tooling: `ultrastar-pitch` (fills pitch into pre-timed notes),
Spotify `basic-pitch` (note segmentation + MIDI), CREPE / pYIN / SPICE (frame-level f0, no
segmentation).

Apps: Smule support + blog (headphone recommendation, crosstalk reduction, Recording Recap),
StarMaker marketing plus third-party latency-calibration guides, Yokee App Store listing.

Literature: Tsai & Lee, "Automatic Evaluation of Karaoke Singing Based on Pitch, Volume, and Rhythm
Features", IEEE TASLP 20(4) 2011 (r≈0.82; DTW on pitch and log-energy, HMM rhythm). Gupta, Li, Wang,
PESnQ (APSIPA 2017 and APSIPA Transactions 2018) for the perceptual-parameter decomposition. Gupta et
al., "Automatic Leaderboard: Evaluation of Singing Quality Without a Standard Reference", TASLP 2019.
dos Santos & Masiero, "A Survey on 30+ Years of Automatic Singing Assessment", 2026, as the entry
point. SingMOS-Pro (ICASSP 2026) as the current MOS benchmark.

> Two reliability notes. The Japanese material was read from the vendors' own pages and is the
> best-sourced section. The UltraStar internals and some auto-tooling details were reported without a
> successful fetch of the repository, so treat specific constants there — a 10,000-point budget, exact
> tolerances, which language `ultrastar-pitch` is written in — as **unverified** until someone reads
> the source. The findings that matter (note grid, octave folding, a tolerance window, a user-set mic
> delay) are corroborated across independent sources.
