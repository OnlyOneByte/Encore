# Alignment — how a lyric gets its timings

> **Purpose.** The design of the worker's lyrics-timing subsystem: what the pipeline does, what each
> gate is for, what may not be broken, and what was tried and rejected. It is the companion to
> [`../benchmarks/forced-alignment/README.md`](../benchmarks/forced-alignment/README.md), which holds
> **every measurement** — the sweeps, the per-song readings, the threshold fits and the benchmark
> history. This document explains the machine; that one proves it. Neither belongs in a docstring: the
> code says WHAT and WHY in a few lines and points here (owner directive, 2026-10-01).
>
> Code: `worker/encore_worker/domain/lyrics/`, `domain/audio/`, `steps/align_steps.py`,
> `workflows/align.py`, `adapters/ml.py`. The state machine as an operator meets it is
> [`../../worker/README.md`](../../worker/README.md); the non-alignment half of the worker is
> [`05-worker.md`](05-worker.md).

## 1. The problem, and the inversion that defines this design

A forced aligner does not search a recording. WhisperX crops the audio to each segment's provisional
span and aligns the text inside it. So a lyrics sheet whose timings are offset from the recording is
not refined back into place — the offset passes straight through, with unity gain:

    bias = 1.005 × offset + 131 ms      (max residual 41 ms, aligning on the mix)
    bias = 1.008 × offset +  59 ms      (max residual 42 ms, aligning on the vocals stem)

and the aligner stays internally precise while doing it, so the result is a confidently, uniformly
misplaced document that passes every self-consistency check a `TimingReport` can make. The cost starts
early: lines within ±250 ms of truth fall from 74.7% to 42.7% at a 150 ms sheet offset, and to 20.0% at
250 ms. (`domain/audio/activity.py`; README, "The mechanism that makes this a sweep and not one number".)

**So the timings are ours, and everything a text claims is evidence.** One CTC decode runs over the
whole recording's emission matrix from the candidate text alone; no incoming timing ever enters as a
search space. What the sheet claimed is then compared against what we measured, and either corroborates
it or diagnoses which of several known failure shapes the sheet has.

The price was measured before the inversion was built, on an authored-caption truth:

| provisional spans                              | lines within ±250 ms | gross |
| ---------------------------------------------- | -------------------- | ----- |
| the truth's own timings (the old ceiling)       | 74.7%                | 0/75  |
| **this, text only, no windows**                | 70.7%                | 0/75  |
| spread evenly (the old untimed path)            | 1.3%                 | 57/75 |

An untimed sheet — the case that used to be hopeless — now aligns nearly as well as one with perfect
timings, for four points of the best case.

## 2. The pipeline, in order

1. **Acquire** candidate texts: provider sheets (LRCLIB, LRCmux — _every_ provider that answers, not
   the first), the upload's authored caption track, YouTube's automatic track, and on demand a local
   ASR transcript. `steps/align_steps.py`, `adapters/{lrclib,lrcmux,cli}.py`.
2. **Clean and judge the text.** `domain/lyrics/clean.py` strips what a caption _format_ inserted;
   `nonlyric.py` drops the rows that are not lyrics at all; `presplit.py` re-lineates ASR paragraphs.
   §8.
3. **Detect the language** and resolve which model bundle will produce the frames. `language.py`, §9.
4. **One emission pass** over the whole recording — `adapters/ml.py`, cached per
   (path, size, mtime, model, language, device) — then one Viterbi decode per candidate text over that
   same matrix. The model pass is the cost (≈4–9 s a song); a decode is 0.1–0.8 s.
5. **Put the sheet's claims on our clock, once**, before anything reads them. `claimmap.py`, §7.
6. **Decode blind** and group the character spans into syllables, words and lines. `generate.py`.
7. **Gate the text**: are these the words that are sung here? §5.
8. **Reconcile** the mapped claims against our timings and classify the disagreement.
   `reconcile.py`, §4.
9. **Repair** inside evidence-derived windows — R1–R4, the never-sung drop, the clamp. §4.
10. **Hold the word ends** through the singing, as a display post-pass. `ends.py`, §10.
11. **Grade** every line, measure the document, decide. `margin.py`, `measure.py`, `policy.py`, §6.
12. **Publish** under a ref the core can merge on, with provenance. §11.

Steps 4–11 are one _attempt_. The ladder (§3) runs attempts until something publishes or the pool is
exhausted.

## 3. The engines, the knobs, and the fallback ladder

Three things can produce timings, and the report says which did (`report.Engine`):

| engine     | what it is                                                              | knobs it reads                |
| ---------- | ----------------------------------------------------------------------- | ----------------------------- |
| `global`   | the whole-song CTC decode above — the path                              | `LINE_SYNC` only              |
| `windowed` | WhisperX's per-segment aligner, kept for an aligner with no matrix      | every knob                    |
| `lineSync` | the text's own claimed line starts, placed on our clock — terminal rung  | none                          |

**A knob is offered only to an engine that reads it,** and the reason is a measured regression: under
the global decode, `thin coverage → ALIGN_ON_MIX` became the only live re-decode retry, fired on nothing
more than a long instrumental outro, and the mix document overwrote the stem one unseen. One song's
0-gross stem document was replaced by a 13-gross mix one in 12 of 15 claim modes; another lost to NO
LYRICS in 9 modes, truth claims included. Coverage stayed on the report as telemetry and stopped being
a defect the global engine could act on. (`domain/lyrics/report.py`, `policy._READS`.)

### 3.1 The emission pass: the frame clock, the chunking, and the cache

**The frame clock is the model's, and it is exact before a frame is computed.** wav2vec2's feature extractor
(kernels 10,3,3,3,3,2,2 with strides 5,2,2,2,2,2,2) advances **320 samples** per output frame and needs
**400** of them to produce one at all, so a forward pass over `L` samples returns exactly
`(L − 400) // 320 + 1` frames — measured on `WAV2VEC2_ASR_BASE_960H` over lengths 400 to 544 000 and pinned in
`tests/test_ml_contract.py`. One frame is therefore the hop over the rate (**16 kHz**, which is what these
bundles are trained at; every other rate is resampled), which is arithmetic rather than evidence. It used to
be `duration / frames` — a different number on every song, wrong twice over (README, "The clock was wrong
twice over").

**One pass stamps 30 s and computes 2 s on each side of it, then throws those frames away.** The chunk bounds
memory, a whole-song pass being quadratic in self-attention, and at 30 s the activations of the widest bundle
fit on a laptop accelerator. The context exists because the transformer attends across the whole slice it is
given, so a frame at a chunk edge used to see context on one side only; computing past each edge costs
**≈1.1× of forward passes** and 4 s of peak memory rather than a multiple, and it is a whole number of frames,
which keeps the trim arithmetic integral.

**The cache is content-keyed and its size is derived from the configured concurrency.** Keyed by (resolved
path, size, mtime, model, language, device) rather than by path, because a stems re-run **puts a new vocals
stem over the same path** and a path-keyed matrix outlived the audio it was computed from. One align job can
be reading **two** matrices at once — the target it aligns on and the mix witness R4 decodes — and the bound
is the live set plus one job's worth of history, so it is `2 × (jobs + 1)`: flat, a multi-job box's live
matrices evicted each other and every attempt after the first re-paid the forward pass. What stops it being
`jobs × 10` is the resident set: the widest vocabulary whisperx tables is ≈47 MB a song against English's
≈1 MB (README, "What a cached emission matrix costs"). The model cache beside it is keyed by (device,
checkpoint) and **must never evict** — reloading multi-GB weights is the whole reason the worker is a resident
process — so the two are separate dictionaries.

**Which bundle, and the two tables behind it.** The English bundle is named explicitly rather than left to
whisperx's per-language table, so a matrix always says which model — and so which calibration row (XA-06) — it
belongs to. The per-device exception table is **empty**, and that is the finished state: the flip that chose
the default was a bundle decision and nothing in its measurement is a fact about a device. It stays a table
because that is the only shape a measured per-device row can land in, and an unknown device must fall back
rather than raise. **It must not grow a CUDA row for XLarge without a CUDA sweep** — XLarge is calibrated on
this corpus but was never run end to end, so its accuracy claim is a projection, and a box defaulting to it
would pay a thinner wrong-text margin with the placement rule abstaining (README, "XLarge is nobody's default,
and carries three caveats"). Every name in either table must have a calibration row or a worker that resolved
it would start with its wrong-text gate standing down; the adapter deliberately does **not** import the
calibration module to check, which would put the thresholds inside the emission cache's code fingerprint, so a
test pins the invariant instead.

Five details of the pass itself, each of which was a defect at some point:

* **Padded, never dropped.** wav2vec2 emits nothing from fewer than 400 samples, so the pass this replaced
  broke out of its loop on the final sliver and lost up to 0.1 s of the song. The grid has
  `ceil(samples / hop)` frames and the last one's field is zero-padded up to what the model needs.
* **The frame-count check is an EQUALITY, not a minimum.** A bundle whose stride is not 320/400 is a silent
  clock error either way round, and a one-sided test caught only the coarse half: a finer-hop model emits
  _more_ frames than the slice implies, so the slice would pass while taking frames that do not sit where
  they are about to be stamped.
* **On the model's own device**, discovered from its parameters rather than assumed from config — on an
  accelerator box a CPU input tensor fails inside the first conv. Found live and not in the benchmark, which
  always ran `--device cpu`, where the mismatch cannot exist. The matrix goes **back to CPU immediately**: it
  outlives the pass in a cache, holding ≈1 MB a song on the accelerator buys nothing, and the CTC kernel runs
  fine on CPU.
* **Both output shapes exist in the wild** — whisperx's torchaudio-backed models return a tuple and its
  HF-backed ones an object with `.logits` — so both are handled.
* **The kept slice is cloned, not sliced.** A slice is a view that holds its whole parent alive until the
  concatenation, which would keep every discarded context frame of every pass resident.

**The star column, when the `star` arm is on** (§14.1), is one more vocabulary entry scored `frame max − P`.
Its rows no longer sum to one in probability space, deliberately and harmlessly: every reader sums only the
columns its targets name, and the lexical gate is handed the **unstarred** matrix. `P` is the one number the
arm chooses and what keeps the star a _fallback_ — a frame whose best character scores within `P` nats of that
frame's maximum is still cheaper to label with the character, and the MMS constant is the `P = 0` limit, the
only value measured to make the unperturbed control worse. It was fitted **out of sample**, where the review
tuned it in-sample, and the sweep is not one curve: the optimum moves with how much of the sheet is missing,
so an honest fit has to name its objective. It transfers across bundles, so it is not a per-model calibration
(README, "W7: the star/filler token, phase A").

**The transcriber and the aligner ask for different devices.** The aligner is plain torch wav2vec2 and runs on
`mps`; the transcriber is CTranslate2, which raises on it — and torch reports MPS as available on every Apple
Silicon box, so one global device string would fail ASR on every Mac. Each component asks for what it can
take. Unrelatedly but in the same lazy-import region: torch 2.6 changed `torch.load`'s `weights_only` default
to `True`, and pyannote's VAD checkpoint (which whisperx loads on the way to a transcriber) stores omegaconf
objects and its own task enums, so an allow-list of unpickling globals is registered once per process. It is
**narrow by design** — `weights_only=False` would disable the integrity check for every checkpoint the process
ever reads — and the list was discovered by loading and reading each refusal in turn, a missing entry being
the same hard failure rather than a warning.

`policy.decide` judges one attempt, in severity order:

| rule | state | answer |
| ---- | ----- | ------ |
| 0 | **Refused** — a gate measured that this text does not describe this audio | NextText. **Terminal for the text**, never LINE_SYNC: line sync would publish the same wrong words on the text's own clock |
| 1 | **Not usable** — word order incoherent, or nothing timed | degrade to line sync if the text has its own, else next text |
| 2 | **Line-synced** | accept; the rung is terminal, nothing is left to vary |
| 3 | **Misplaced** — residual past the suspect band | re-place against the aligned output (`RESHIFT`) |
| 4 | **Overshoots** the audio | widen the search (`DROP_WINDOWS`), then re-place |
| 5 | **Thin coverage** | try the mix (windowed only) |
| 6 | **Claims unrelated** — the text brought line timings and `reconcile` could fit no map | the text's own timings get their turn, **last**, and only if they pass their own gate and beat what they retried |
| 7 | otherwise | accept |

Two rules that are easy to get backwards, both learned from the worker this replaced:

* **Accept if nothing better is available.** A defect justifies another attempt only when a knob exists
  that could plausibly fix it. Thin coverage with no untried knob is accepted — if a transcript covered
  only the first third, that third's timing is correct, and refusing publishes nothing. Every usable
  branch falls through to `Accept`, never to `NextText`; inverting that is how a correct-but-imperfect
  alignment becomes no lyrics.
* **ASR is a tier, not a last resort.** The pool order is candidates, then ASR, then the machine caption
  track: a transcript cannot be the wrong song and cannot be misplaced in time, which makes it the
  _reliable_ fallback rather than the desperate one. Within the candidate tier a **corroborated** text
  goes first — two independent sources agreeing on the words is the strongest evidence available without
  the audio, and it is free. Independence is enforced: two provider sheets are one metadata query
  answered twice and do not corroborate each other.

**Best-so-far.** A retry is a hypothesis, not a promise. It must beat the attempt it retried, judged on
the defect its knob was spent on, and a tie keeps the earlier attempt — which ran on the better evidence
(the stem, the text's own placement, the narrower windows). When a retry comes back with nothing, refused
or worse, the search goes back to the kept attempt, that knob is spent, and `decide` is asked again about
the kept report so another knob still gets its turn. Only when none is left is the kept attempt
committed. Without this the last attempt always won. (`domain/lyrics/search.py`, `policy.improves`.)

**Termination is structural, not capped.** Each `Try` either spends one of four per-text knobs or
advances a finite pool, and ASR fires at most once. There is deliberately no attempt ceiling to tune: a
cap that can never be reached is dead configuration, and one that can silently truncates the ladder the
user cares about.

**The ladder is a pure driver, not a workflow body** (`domain/lyrics/search.py`). A DBOS workflow body must
be deterministic and is awkward to unit-test, so the walk — which text next, with which knob, when to run
ASR on demand, when to conclude the song has no words — lives in `domain/` as a plain object driven by step
results. The workflow becomes a loop with no decisions in it, and every branch above is testable with no
audio, no model and no DBOS.

**Best-so-far spans document kinds.** A LINE_SYNC retry is judged by the same rule as any other, so the line
document of a text whose word document related to nothing (rule 6) must beat that word document to replace
it, and a line document its own gate refuses sends the search **back** to the words rather than on to the
next text. Nothing was added to allow that: `_best` has always been "the best usable result for the current
text", and the only reason the two kinds never met on it is that LINE_SYNC used to be offered to unusable
word documents alone — which are never kept, there being nothing to keep. That is still the other route to
the knob, and there the line document publishes unopposed, because an incoherent highlight is not a
document. The workflow keeps each `Try`'s document by serial and each knob set writes its own file, so the
earlier one is still on disk to publish (`Commit.serial`, `Attempt.lost`, `Try.base`).

**Cross-kind comparison.** A word document and the LINE_SYNC document of the same text are two answers
to one question. Which publishes used to be decided by arrival order. Now rule 6 asks for the text's own
timings exactly where `reconcile` could relate _nothing_ between them and our decode — which is where the
word documents carrying 84% of the corpus's gross lines live — and one guard that is a real comparison
rather than a tie-break: a line document must time at least as many lines as the word document did, so a
sheet stamped on 3 lines of 50 cannot replace 50 measured ones.

## 4. Repair: the four rungs, the drop, and the clamp

The global decode is one monotone path. Where it misbinds — a repeated chorus bound to the wrong
occurrence, a whole decode scattered on repeat-heavy text — the fix is not a different engine but the
**same decode constrained to a window some other evidence vouches for**. `generate.regenerate` is the
primitive; a run of consecutive lines is decoded jointly so order within it stays monotone, and a run
whose window cannot hold its text, or whose decode fails, keeps its originals. (Gentle's multipass
realigner and nomadkaraoke's anchor-sequence gap handlers converge on the same shape.)

Two details of the primitive that are only obvious once they have failed. **A run whose decode raised
reports the fault**, one `"<Type>: <message>"` per run, because a swallowed exception looks exactly like a
repair that was never needed — measured, not foreseen: every R3 window decode in the alignment suite raised
for as long as that suite existed and nothing showed it. And the **window guard counts targets, not
characters**, so a decode arm's extra targets are counted in it (XA-11): under `linesep` a run of N
decoding lines is N−1 targets longer than its characters, and a guard that missed them would hand a window
sized for 17 characters 18 targets to force through.

| stage | fires when | window |
| ----- | ---------- | ------ |
| **R1** | the claims fit the audio better than a scattered decode (`UNRELATED`) | every claimed line, inside its padded claim span |
| **R2** | a `STRUCTURAL` verdict's disputed lines — the exact lines a monotone decode binds to the wrong occurrence | their claim windows |
| **R3** | blind repeats with no claim to anchor them | jointly, between the nearest unique neighbours |
| **R4** | a claimed line whose window the stem is silent in | the same window, decoded on the **mix** |

Each stage records which measurement placed each line (`_Source`: blind / anchored / window / mix /
adopted). That provenance reaches the trail, steers two default-off arms, and **gates grading** (§6).

**The repair window is held open, and capped.** A claim carries an end only where the sheet gave one, so
the reader defaults it to `start + 1.0 s` — which is every LRC's last stamp and every short caption cue.
Cut to that, the window cannot hold the line: the forced path compresses it or collapses to the left
edge, the adoption test reads that as "heard nothing", and a correct blind decode is replaced by the
claim's span with its words spread evenly. So the window is held open to where the blind decode ended —
**the end only**, only where the claim span cannot hold the line, and only where the blind decode starts
inside the padded claim span. A cue's _start_ is what a sheet actually asserts; pulling the start back to
a blind onset undoes the anchoring a window exists for.

And never past the next claim's onset. The union used to take the blind end wholesale, which trusts it
exactly where it is least trustworthy — R1 fires on an `UNRELATED` blind verdict, the state in which a
blind line is known to smear across its neighbours. A defaulted 1 s cue then bought a repair window tens
of seconds long and a single-line decode inside it landed wherever the audio liked. The last cue is
capped too, on the sheet's own pacing (`start + max(typical_slot, needs(text))`), because it is the one
cue whose end is _always_ missing: nothing follows it to bound the window, and what it swallows is not a
following line but an unstamped outro repeat of its own words. A characters-per-second ceiling was
measured and rejected — real sung lines run down to 0.7–1.7 alignable characters a second, so any ceiling
tight enough to refuse a smear also truncates a held note. The next claim is _evidence_, not a guess.
(README, "The repair window's two caps".)

**The never-sung drop.** A caption line that is not in the audio — an uploader credit, a lyric only
present in a stem this box did not get — does worse than fail: forced monotonically through emissions
that do not contain it, it consumes its neighbours' frames and drags them off. Three signals, **all
required**, because each alone misfires on a real quiet line: the decode scored the line far below the
song's norm, its span sits on silence, and its characters smear at far below singing tempo. A re-decode
after dropping is another Viterbi over the matrix already in hand.

**The clamp, and the end that moves.** A repaired line measured inside a padded window, or an adopted
claim span, can overlap its neighbours, and two spilled words are enough for `decide` to degrade an
otherwise-corroborated document to line sync. So repaired lines are clipped into the free gap. The
subtle part is **which side gives way**: the left floor used to be `max(line.start, previous_end)`
unconditionally, and that floor is not independent evidence — it is the blind decode's own boundary,
i.e. the very reading the repair existed to correct. Where the blind decode smears a line over the next
line's audio it also puts the next line's start at the smear's end, so pushing the repaired start onto
`previous_end` put the line back exactly where the decode had it. The overlap is now resolved at the
**neighbour's END** instead, because the end is the weaker of the two measurements — and for two reasons
that are about evidence, not about which way an end errs. First, **nothing scores a line end**: grading,
`measure.usable` and `out_of_order` all read STARTS, so an end carries no verdict that moving it could
contradict (§10's post-pass is its one consumer, and it runs after this). Second, in the case that reaches
the clamp the neighbour's end is precisely the smear the repair exists to correct, while the repaired START
carries the claim clock and the corroboration test behind it. The neighbour keeps its start, its order, its
existence, its grade and every word onset it measured
before the boundary; only the tail past the boundary is re-fitted. Dropping the floor **entirely** reaches
the same accuracy and publishes dozens of inversions, so what ships is a bound on it rather than its
removal.

**Re-fitting only the tail is why `generate.trimmed` is not a call to `remapped`.** `remapped` compresses
the whole line, which moves onsets that were already right — and moves the _first_ word earlier whenever
the line has leading silence, the one shape that can invert against the line before it. `trimmed` re-fits
only the sub-series from an **anchor**, the last word starting before the new end, into
`[that word's start, new end]`: no onset before the anchor moves, and the onsets before the end are
measurements that survive. It costs phrase-final end accuracy, because the trimmed line's last word now
ends exactly at the boundary.

The anchor **walks back** when its tail cannot hold one decoder frame per word still to be placed. Where
the last word starting before the end starts a hair before it, the scale goes to ~0 and several words
publish inside a millisecond of each other — intervals the TV can never light, since it lights
`start ≤ pos < end`. So such an anchor is dropped and the word before it tried, trading one measured onset
for a tail that is a timing again; both properties survive the walk exactly, because the map is still
`t ≤ anchor → t` and still monotone. `trimmed` returns nothing for a line whose every word starts after the
new end — a line that was not sung before it. (`align_steps._clamped_v2`, `_pulled_end`,
`generate.trimmed`; README, "The clamp's left floor was the bug, not the ladder", prices the clamp, this
tail and the walk.)

## 5. The gates — what each one asks, and what it cannot answer

Four questions, asked by four different mechanisms. They are not interchangeable, and the history of
this subsystem is largely the history of one of them being asked to answer another's question.

### 5.1 The lexical lift — _are these the words?_

Every other gate here reads **where** the singing is. None read **what** is sung, and two holes followed:
a same-video caption track (an uploader's translation, YouTube's machine-translated `en` track) fits the
singing by construction whatever its words, and the global engine's envelope gate scores _our own forced
decode_, which the audio pulls onto the voiced frames whatever the text is.

The test is a self-normalised goodness-of-pronunciation (Witt & Young 2000): the text's forced-path
log-probability on the emission matrix, against **the same text with its words shuffled**, per letter.
A shuffle has the same letters, the same length and the same alphabet, so the model's scale, the song's
difficulty and the language all cancel; what is left is how much better _this order_ of these words
explains the audio than an arbitrary order of them. The best of three draws is the reference, so one
lucky shuffle cannot flatter a wrong text, and the draws are seeded from the text itself (crc32, never
the salted `hash()`) so a replay and a bench re-run measure the same thing.

Four thresholds per bundle, all in nats per letter: `refuse_below` (the verdict on a stem),
`ok_from` (above it, no fit would refuse the text), `mix_floor` (the verdict on a mix) and
`mix_ok_from`. Between the floor and `ok_from` is the **doubt band**: the text publishes, but every line
grades `low`, the document `medium`, and the words go out **unvouched**, so a document some gate passed
outranks it. (`domain/lyrics/lexical.py`; the fits, the held-out splits, the redraw noise and the
per-song costs are in README, "The lexical-lift wrong-text gate" and "Per-model calibration".)

**What it does not cover, measured:** a translation whose words share the sung ones' letters in order.
The test contrasts an order of _these_ letters with other orders of the same letters, so a cognate-heavy
translation keeps much of the sung letter sequence and lifts like a right text — on the CTC fixture a
German cognate text lifts +1.98 where a French text of the same lines reads −0.12 and the sung words
read +15.2. No band separates that on either target. The corpus holds no real translation to measure it
on, so `wrongtext+ownclock` (another song's words on this song's clock) stands in for an arbitrary word
_order_ only, never for its letters. A defence is unbuilt; the fixture texts are the tests to turn
around when one lands.

**Exempt** (the step decides, not this module): the ASR tier, whose words were heard on this audio; a
text the lift cannot measure (too few letters, no word order to contrast, a decode that refused it); and
a pin, which is measured but never refused — a person chose these words. None of those is a _pass_:
`vouched` is False for an unmeasured non-ASR text, because "no gate doubted these words" and "no gate
read them" are not the same claim.

### 5.2 The activity-envelope gate — _is there singing where this text says?_

The sheet's line spans say where singing is expected; the audio's RMS envelope says where it is; Pearson
correlation at the best lag is the gate. Two more obvious candidates were measured and rejected: peak
_prominence_ does not discriminate (a 75-line envelope is mostly "on", so the correlation is broad rather
than peaked, and a shuffled sheet scored highest), and onset _agreement_ does not either. Only the
correlation at the chosen lag separates the populations.

**Three tiers**, because the null hypothesis differs by what is being asked, and any one of them passing
is a pass (`align_steps._envelope_passes`):

1. `r ≥ 0.40` — `activity.MIN_CORRELATION`, the fit's own `usable` threshold — with `|lag| ≤ 0.5 s`. The
   shape agrees and the lag is small enough to be measurement noise.
2. `r ≥ 0.25` with `|lag| ≤ 0.1 s`. Timings measured _on this audio_ must fit at **zero** lag, so a weaker
   correlation is admissible when the lag is that tight, and the measured wrong-song fits land at large
   lags.
3. `r ≥ 0.60` at **any** lag. The shape agrees that well and what is left is an _offset_ — a sheet to
   move (§7), not a text to refuse.

**The sheet-span gate is tiers 1 and 3, never tier 2.** `_sheet_passes` scores a sheet's own claimed spans
rather than a decode, and tier 2's whole warrant is that a decode must sit at zero lag. A sheet was not
measured on this audio, and any sheet whose envelope is broad best-fits near zero lag anyway, so tier 2 is
where the sheet-span null leaked. The two predicates keep this numbering.

Either of the blind or the repaired fit passing is enough: blind guards the case where our decode is
scattered but the claims might rescue it, repaired guards a bad repair.

**It is not a wrong-text gate and must never be used as one.** It scores our own forced decode: measured,
it passed 152 of 320 bench wrong texts and 280 of 320 same-video wrong-word texts, and on the mix it is
_anti-correlated_ with document quality — passing decodes the matrix never heard and refusing ones it
did. Since W3 the lift replaces it wherever the lift measured the text; it remains the gate for the
exemptions in §5.1, and its reading stays on the trail everywhere.

### 5.3 The LINE_SYNC rung — _and these timings, where they are?_

The rung publishes the text's own claimed starts, so it asks both questions and must pass both.

* **The words:** `lexical.lift` against the same per-bundle `refuse_below` the global engine reads, off
  the same row. It used to hold its own copy of the number; one recalibration must move both gates.
* **The clock, before either question:** a sheet 1.5 s off is a sheet to _move_, not a sheet to refuse,
  so the rung takes its own claim-clock vote (§7) and places the winner. Until it did, the sheet was
  moved by the activity fit whenever that fit was usable and by nothing else, which cost both ways: 12
  right texts refused for a clock error their own decode could see, and 23 published documents with **no**
  line within ±500 ms of truth because the fit moved a sheet that was already right.
* **The timings:** the text is decoded blind on the same matrix and at least
  `line_sync_min_agreement` of its lines must start within 1.0 s of their **mapped** claims. That share
  is the matrix's own model's; unlike the lift's bands it is a count of lines rather than a
  log-probability, so an uncalibrated bundle is still gated on it (`LINE_SYNC_SHARE_UNCALIBRATED`) rather
  than dropped onto the gate this one replaced.

**Fallback,** where the decode cannot be read: the sheet-span envelope gate — an aligner with no emission
matrix, a decode that raised, too few lines decoded, or too small a share of the sheet decoded. That last
bar exists for the mixed-script caption track (Korean verses, an English chorus): a Latin fragment must
not decide the timing or the verdict of 36 lines it never read. Its floor is the claim clock's five
pairs, not reconcile's three, because a reader that **acts** needs more than one that grades — and the two
readers of that decode (the gate's verdict and the clock) make literally the same call, because when
their bars differed a thin sheet published displaced with both witnesses agreeing on one misplacement.

**On a stem only.** Against the mix the sheet gate passes almost nothing and the lift's populations
overlap, so `syncMode=lines` on a stemless song is aligned as forced instead, and forced mode's own
fallback to this rung is declined there.

**A stray backwards stamp is held, not sorted.** A line document _is_ its claims, so a sheet that stamps
one line before the line ahead of it publishes a highlight that jumps backwards — the one timing defect
that cannot be shown to a room, and the one `decide` answers by dropping the whole text. A single
inversion is capped at the previous start (the line keeps its text and its position and loses only the
part of its timing that cannot be true), only where the next claimed start recovers, and only while the
held share stays small; otherwise nothing is held and the sheet keeps its inversions. The end is held
_past_ the predecessor's, because core lights the **first** line whose bounds contain the playhead, so a
byte-identical span would lose every instant of itself to the predecessor. LRCLIB sheets cannot reach
this rule (`parse_lrc` sorts, and stacked stamps are equal); the population that pays for it is the
YouTube caption tier.

### 5.4 Calibration by model — _may this threshold be read at all?_

Every lift band, the rung's agreement share and the placement-margin floor are **emission-scale**
numbers: they belong to the bundle they were measured on and to no other. One table keyed by model
identity (`lexical.CALIBRATED`) holds one row per bundle, and a bundle with no row is not gated on
anybody else's numbers.

This matters because the emission model is chosen **per language**, not per wave, and this worker
deliberately supports every language WhisperX tables. The rule is therefore:

* a **named** bundle an operator cannot gate is refused before the worker accepts a job — loudly, at the
  composition root, naming the setting (`__main__.align_model_for`);
* a **routed** bundle (a non-Latin script, §9) with no row **declines the word document**, and the ladder
  falls to the LINE_SYNC rung, whose share is the one threshold that survives a model swap. It does not
  fall back to the envelope gate: that gate was measured letting 189 of 380 and 220 of 320 wrong texts
  through. A declined attempt is not a refusal — nothing measured the text — so a sheet that brought its
  own line timings degrades, and an untimed one moves to the next text;
* the placement-margin floor **abstains** on a bundle nobody fitted one for, rather than reading 10 nats
  off somebody else's scale.

"Refuse to gate rather than gate wrongly" is the rule, in three shapes. `adapters/ml.py` deliberately
does **not** import `lexical` to check its own default, because that would put the thresholds inside the
emission cache's code fingerprint and moving a band would invalidate every cached matrix; the invariant
is pinned by a test instead.

### 5.5 Where each gate sits

```
text acquired ──▶ clean / nonlyric ──▶ language ──▶ emissions
                                                      │
                            ┌─────────────────────────┴──────────────┐
                            │ lexical lift, FIRST — before this      │
                            │ text's own decode and before any       │
                            │ audio is read, so a refused text       │
                            │ costs neither                          │
                            └─────────────────────────┬──────────────┘
      Refused ◀── below the floor (stem, or mix) ─────┤
                                                      ▼
                      blind decode ─▶ claim clock ─▶ reconcile ─▶ R1–R4 ─▶ never-sung ─▶ clamp
                                                      │
                            ┌─────────────────────────┴──────────────┐
                            │ envelope gate, on the REPAIRED series  │
                            │ (the exemptions only), then grading    │
                            └─────────────────────────┬──────────────┘
                                                      ▼
                                              ends post-pass ─▶ measure ─▶ decide
```

## 6. Grading, and the confidence that means something

Grading runs on the **blind** verdict only. A line re-decoded inside its claim window agrees with the
claim partly by construction, so only the blind decode can answer "was this corroborated".

| line | grade |
| ---- | ----- |
| corroborated by the claims | `high` — two independent measurements agreeing beats the decode's own score |
| disputed | `low` |
| ANY blind line, where the verdict is in `reconcile.DISAGREE` (`UNRELATED` or `TOO_FEW_PAIRS`) | `low` — `align_steps`' `claims_disagree`: the claims do not describe this document at all, so no line of it may rest on them, including a line sitting on a claim of its own (§7) |
| a blind repeat | `low` — an anchor vouches for the region, not for which occurrence is which |
| blind and unique | `high` |
| re-timed in a window (window / mix) | `high` only where the blind decode corroborated its claim and the repair kept that position |
| R3 (anchored, decoded without the claims) | `high` where it lands on its claim on the blind verdict's clock |
| an adopted claim span | always `low` |

Where the grade rests on our decode alone there is one further signal, and it replaced a rule that was
**at chance**: "is this line's text repeated in the sheet?" graded 11.88% of its `high` lines more than
0.5 s off against 12.86% of its `low` ones. It flagged half a repeat-heavy sheet and told you nothing
about either half.

**The placement margin** asks the forced alignment's own trellis a second question: how much _worse_ is
the best path that puts this line's first character at least `WINDOW_SEC` away from where the chosen path
put it? That number, in nats, is the score the decode would have had to give up to place the line
somewhere else. It is near zero exactly when the audio contains another place the line fits as well —
which is the misbound-repeat failure's signature — and large when the decode had no choice.

Two earlier candidates were measured and rejected. The per-line **path score** asks "how well do these
frames match these letters", and loud, clear singing of the wrong occurrence scores well; the margin asks
"could these letters have gone somewhere else", which is a property of the whole song's competing
placements. **Characters per second** is likewise a property of where the line landed. The score survives
as a weak second signal and never as the rule.

The rule is one threshold per signal, deliberately — the critics rejected a fitted logistic, whose
normalisation, fitted on training songs only, failed its own reject gates. A line is demoted when its
margin is below the bundle's floor **or** its raw score sits far below the song's median. Both halves
earn their place, and a line with no margin is not doubted by the margin half: treating "not measured" as
"ambiguous" would demote every line of every song on a matrix the margin could not read, which is a
silent failure dressed as caution. **No margins on any fault** — and that is a different answer from an
empty mapping, which would still apply the score half and so switch grading silently to a half-control.

The floor is **not a constant in `margin.py`**: a margin is a sum of log-probabilities, so it is an
emission-scale threshold and lives in `lexical.Bands.margin_floor_nats` beside the lift's bands — which is
also what makes a bundle with no measured floor abstain (§5.4) rather than read 10 nats off somebody else's
scale. Both signals are **within one song only**, like every other score in this package.

**The cost is a second read of a matrix the model pass already paid for**: two Viterbi passes over the
trellis the decode already built, one forward and one backward, with only the queried columns kept, so the
memory is `O(states + frames × lines)` rather than the `O(frames × states)` a full trellis would need. Pure
numpy, vectorised over states with a Python loop over frames — no numba, since the critics rejected the
decoder swap. `conf-legacy` (§14) is the off switch for a box that cannot pay it.
(`domain/lyrics/margin.py`; the window sweep, the leave-one-song-out fit, the per-song timings, the transfer
to the second bundle and the two halves' separate contributions are in README, "The confidence rule".)

## 7. The claim clock

Stage 3 grades the claims and never moves them, and that is right for _grading_. But stage 4 does not
only grade: it repairs inside claim windows, it adopts a claim span outright where the window decode
heard nothing, and it reads a claim's position back when deciding whether a repaired line may grade
`high`. Every one of those ran in the claim's **raw** clock, while the one number that could have fixed
it was computed and discarded three times over. Measured: claims 1.5 s late published every line 1.5 s
late _and_ passed the envelope gate; a +1.3 s LRC got a line adopted 1.3 s late; +3 s claims produced 440
gross lines.

So the claims are mapped once, before the first reconcile, and **only the claims move**. An offset sheet
is still a fact about the sheet; what the map buys is that every repair window, every adopted span and
every corroboration test afterwards asks about the same instant the audio does.

**The estimator is a vote, not a fit** (RANSAC's inlier count; Fischler & Bolles 1981). Six candidates,
all already computed elsewhere in the step, so consensus costs no model time and no second decode:

| candidate | what it is |
| --------- | ---------- |
| no-shift | identity — the null hypothesis the margin below protects |
| envelope-lag | the claims' lag measured **on the audio** (`activity.fit_shift` of the audio's vocal activity against the claim spans' expected envelope) — the only candidate independent of our decode |
| decode-median | median(ours − claimed) over the paired lines |
| decode-mode | the offset the **most** paired lines agree on: the median of the densest `2 × tolerance` window of the same differences |
| tempo | a bounded Theil–Sen slope (Sen 1968) with its own median offset — the drift case, a master cut at another tempo. Fitting karaoke timings onto another recording is DALI's problem too |
| tempo-mode | that slope with the densest-window offset |

Each is scored by how many paired lines it explains within the reader's own tolerance — imported, not
copied, because "explained" must mean exactly what the reader of the map means by it. **Ties go to the
earlier candidate**, so no-shift wins a tie and the lag measured on the audio outranks the **four** fitted
against our own decode (the two offset fits and their densest-window variants — the table's rows 3 to 6, in
that order). That ordering is the strongest objection to this design made harmless.

Three floors, because a map moves claims that may already be right:

* a **margin** — the winner must explain at least `max(2 lines, 5% of pairs)` more than no-shift, and
  must actually move a paired claim;
* a **quality floor** — a margin only grades the _gain_, so "the best of four noisy candidates" could
  move a sheet on two explained lines out of fifty as long as no-shift explained none. Below a fifth of
  the paired lines explained, the winner is not a clock and the vote abstains;
* **two floors on the mode candidate alone**, because unlike every other candidate it is _chosen_ by
  maximising the vote's own score: the window must hold at least five differences, and it must be
  **isolated** — widening it must not gather more lines. Without the isolation guard a correctly timed
  47-line sheet against a uniformly late decode would have moved all 47 claims.

**Why the mode exists at all.** A median is robust to a few wild lines and to nothing else: it breaks
down at 50% contamination, and a song whose lines repeat is exactly where a blind decode misplaces half
of them. On one such song the differences are bimodal and the median lands in the _gap_ between the two
modes, explains 9% of the lines, falls under the quality floor, and the vote abstains — after which every
window repair and adoption works in a clock 3 s out. The densest window reads the sheet's real
displacement and explains 39%. (`domain/lyrics/claimmap.py`; the corpus readings and the per-song
deltas are in README, "The claim clock".)

**Both consumers take the same vote with the reader's own band.** The global engine scores candidates in
reconcile's corroboration band, because reconcile reads the map. The LINE_SYNC rung scores them in its
own near-band, because there the reader is that rung's gate — and there the claims do not steer a repair,
they _are_ the published document. A wider band is also a stricter map: no-shift is harder to beat at
1.0 s than at 0.25 s, which is what a map that moves what publishes should want.

**What stays raw.** The claims as the sheet gave them are kept for the trail and the report: the offset
we publish describes the _claim_, and the global engine deliberately reports no residual at all, so that
`decide` cannot offer `RESHIFT` for a series this engine never searched.

### Reconcile's classes

Seven verdicts below, plus `NO_CLAIMS` for a sheet with nothing to pair; each has a distinct residual
pattern and a distinct action:

| verdict | residuals | action |
| ------- | --------- | ------ |
| `AGREE` | ~0 line by line | corroborated lines publish at word confidence even where the decode's own score is middling |
| `OFFSET` | constant, non-zero | our timings are already correct; the offset is a fact about the claim |
| `DRIFT` | grow linearly | same action |
| `STRUCTURAL` | most agree, a contiguous minority do not | the agreeing lines gain confidence, the disagreeing ones lose it — and on repeated text those are exactly the lines a monotone decode may have misassigned |
| `COARSE` | loose but every line within a phrase | **grade it, never repair it** — a re-decode against jitter is regression fuel |
| `UNRELATED` | no structure, on enough pairs to be sure | either the claim is for a different song or our decode is garbage; this module cannot tell which, so it says so and the caller arbitrates |
| `TOO_FEW_PAIRS` | three or four pairs that disagree | corroborates nothing, disputes no individual line, and arms no repair — `UNRELATED` arms the most sweeping repair there is, and arming it on three points is the opposite of what the fitted-pair floor exists for. **It does lower confidence**, below |

`TOO_FEW_PAIRS` is in `reconcile.DISAGREE` with `UNRELATED`, and that is a grading verdict as well as a
repair one: `align_steps`' `claims_disagree` reads the pair and **grades every line still on the blind decode
`low`** (§6) — which, since a verdict that confers nothing corroborates nothing, is every line of the document
the ladder did not re-time, including lines sitting on claims of their own. Only `UNRELATED` arms R1. The demotion
runs one direction only — `DISAGREE` never promotes — and it has a **cliff at `MIN_PAIRS`**: a sheet with
two pairs is `NO_CLAIMS`, which confers nothing _and_ costs nothing, so the same lines grade `high`. That is
deliberate (three disagreeing pairs are evidence of disagreement; two are not evidence of anything) and it
is the one place where acquiring one more claim can lower a document's confidence.

The verdict is read off the residual **distribution**, not off exact agreement. Asking
`agreement == 1.0` made one stray line out of fifty read `STRUCTURAL` and rendered `OFFSET`
effectively unreachable; the caller's R2 then re-decoded every jitter-disputed line, which is the exact
repair measured as harmful. The fit was fragile the same way: an unbounded endpoint span ratio through as
few as three pairs, where both endpoints fit by construction.

**Which lines a repair may touch** is one rule per class, in `reconcile`, not at the call site: for
`STRUCTURAL`, every line the fit does not explain; for the one-affine-map classes and `COARSE`, only the
lines beyond a phrase band **on the fitted model**, so a tempo sheet's linear ramp is not mistaken for 38
misbound lines; for the three no-standing verdicts, nothing.

**What the spread is not.** `spread_sec` is the _joint_ precision of two measurements and nothing here
can say which side is loose, so it gates nothing — it is a reading on the trail. Both attempts to give it
teeth failed: as a repair band it cost a song three of fourteen lines in the ±500 ms band, because a
sheet whose residuals wander because _our_ decode wandered still wants its lines re-decoded; as a label
band beside the inlier share it could never fire at all.

**Paired by line index**, and only where both sides have one. `generate` drops unalignable lines but
carries each line's index; a claim series may be shorter or longer than the text. Pairing by index — not
by order of survivors, not by content — is what keeps one dropped decorative line from shearing every
comparison after it.

## 8. Text hygiene — four modules, and the line between them

**`clean.py` removes FORMAT and judges nothing.** A WebVTT cue carries italic tags, per-word ASR
timestamp spans, music-note decorations and speaker dashes, and until this module existed every one of
them was published and drawn on a television as words to sing. Order is load-bearing: entities are
decoded first (one authored track is 89% escaped markup, so a tag strip that runs first leaves `<i>` on
screen), and the speaker dash is matched with a leading-whitespace anchor after the notes became spaces.
Idempotence is a test, not a hope — it is what failed first when the dash anchor was wrong.

Three rules were measured and **rejected**, each because it destroys real lyrics: dropping whole-line
parentheticals by a sound-effect vocabulary (any list that catches `(slow quiet electric guitar)` also
catches `(Beat it, beat it)`, `(Play that funky music)`, `(Drop the beat)`, `(the beat goes on)` and
`(bells ringing)` — all sung); dropping bracketed lines that "have no lowercase" (`[a-z]` is ASCII, so
every caseless script satisfies it and `[Люблю тебя]`, `[私の心は燃えている]`, `[사랑해요]` are all
deleted, along with bracketed ad-libs); and stripping a capitalised token before a colon as a speaker
label (`Baby: I love you` → `I love you`).

**`nonlyric.py` judges, and every rule is ANCHORED.** It is a separate module precisely because
`clean.py`'s rejected list is a list of _unanchored_ rules. Four rules:

| rule | what it answers |
| ---- | --------------- |
| R1 | a whole-line section header, from a closed **allowlist**, and only bracketed or with a colon |
| R2 | a leading `CHORUS:` / `Verse 2:` prefix is stripped and **the rest of the line kept** |
| R3 | **the author's own marking** — in a track that notes its sung lines with music notes, a line with no note is not sung |
| R4 | a YouTube ASR non-speech marker (`[Music]`, `[Applause]`, `[Laughter]`), whole-line and bracketed — a closed set of _machine_ output |

R3 is the rule that answers the caption cues, and it reads the track's own evidence rather than a
vocabulary: an author who writes `♪ Hello from the other side ♪` is marking that line as sung, and the
same author writes `(fabric rustling)` with no note. Its precondition share is read off the lines that
have **words** — a bare `♪` filler line marks no sung line, so it is evidence about nothing — and off the
lines R1/R4 have not already answered, since a label nobody would mark dilutes the author's marking. The
floor sits at the **bottom of the measured population**, not in the middle of the empty band, because the
cost either side is asymmetric: above the population the rule stops firing on tracks it was measured to
be right about; below it, the rule fires on shapes nobody measured and deletes real sung lines.

Why this is a correctness fix before it is an accuracy one: before it existed, non-lyric cues became CTC
targets and were then removed (or not) by the **acoustic** never-sung rule, which drops different cues
under different models — so a song's scored line count moved with the acoustic bundle and no per-song
accuracy row was comparable across models. A text-side judgement is model-independent by construction.

**The deliberate non-rules**, kept out on purpose: a sound-effect vocabulary (above); credit lines (the
one real credit in the corpus is unnoted in a noted track, so R3 already has it, and `Lyrics by …` on a
plain sheet has no anchor a lyric could not also satisfy); and expanding `[Chorus x2]` — the label is
dropped but the repeat it asks for is not materialised, because the measurement plan for that was
circular, and dropping the label is still strictly better than publishing `Chorus x2` as words.

**A PASTE goes through the same hygiene, with R3 switched off.** A person pasting from a lyrics site pastes
its `[Verse 1]` / `[Chorus]` headers with the words, and the pin path was the one that never cleaned: a
stored candidate was cleaned by the adapter that fetched it, and the bench's injected-header mode arrives
through a port that cleans. R3 is excluded because its precondition is read off the **whole** text, and a
transcript copied off a video — sung lines wrapped in `♪`, spoken ones not — trips it, so every unmarked line
of the person's own paste was deleted with no per-line anchor. The anchored rules still apply: a pasted
`[Chorus]` is a header wherever it was copied from.

What the hygiene removed from a paste is recorded as a **trail note**, not on the document. `sourceLines` is
what a later re-pick re-times, so seeding it with the pasted `[Chorus]` would republish the header on every
re-pick — the defect the hygiene exists to remove. A sheet's raw form is a re-fetch away; a paste exists only
in that one job, so the note naming the count is its only record.

**`parts.py` — ad-libs and echo tails** (default-off; see §14). A backing vocal is not in order with the
lead, and the monotone path must spend frames on its characters somewhere — and the only frames it can
spend are the ones the _next_ lead lines were sung in, so the damage is not on the ad-lib, it is on
everything after it. Two **anchored** rules take those words out of the decode's target sequence and time
them inside their host line afterwards, so the lead's path is the lead's alone:

| rule | what it takes out | the anchor |
| ---- | ----------------- | ---------- |
| **R1** | a mid-line or trailing **parenthetical** with letters in it | the group must begin and end at word boundaries and the line must keep at least one lead word. **Not a leading** one — a leading aside is where the host line _starts_, and every metric here scores a line by its start. Not a whole-line one either: that is `nonlyric.py`'s question |
| **R2** | an **echo-tail line** — a whole line whose normalised words are a strict suffix of the one before it, at most `MAX_ECHO_SHARE` of its length, **and alone** | still published as its own line, timed in the gap the lead decode leaves between its host and the next lead line |

The **"alone" clause** on R2 is a measured refusal rather than tidiness: one song writes its hook as three
consecutive lead phrases with no gap anywhere, and taking 21 of its 47 lines out of the lead decode would
leave them no room to be timed in. A tail sung _twice over_ is a repetition the singer performed.

**A restored timing is an interpolation and is labelled as one.** An aside's words are apportioned across
the room its host leaves **by character count** (`presplit`'s rule and reason), every restored word
carries `generate.OOV_CONFIDENCE`, and a line with no measured word of its own is what
`parts.unmeasured_lines` reports and `align_steps.line_confidence` grades `low` — a demotion that can only
take a line **down**. The published sequence stays monotone by construction (XA-08): `restored` carries a
floor at the last word it emitted, and where there is no room at all the words are zero-width at that
floor.

**`presplit.py`** re-lineates ASR paragraphs only (Whisper emits ~30 s VAD segments). A provider's sheet
and an authored caption track already arrive line-broken by a human and a splitter can only damage them,
so the tier decides, once. And it splits **before** grading, because word timings are interpolated across
a split: a line broken after alignment inherits spans measured against the unsplit text, and the second
half of every split line then highlights early.

**`syllabify.py`** is text-side only — the alignment already times every character, so a syllable is a
third grouping of spans and the only question is where to split, which makes it a pure function testable
from a truth table. A ladder, best evidence first, because no single source covers everything:

| tier | what it is | why there |
| ---- | ---------- | --------- |
| 1. **CMUdict** | phoneme-based | right about English where orthography is wrong ("come" is one syllable). English-only, and it gives a **count** rather than split points |
| 2. **Moby Hyphenator** | the shipped 152 085-word hyphenation dictionary (Grady Ward's Moby Project, public domain) | English, and **ahead of pyphen** because pyphen abstains on nearly half the tokens CMUdict calls multi-syllable, after which `_force_count` **bisects** them — putting the boundary wherever the middle of the string happens to be |
| 3. **pyphen** | hyphenation dictionaries for ~70 languages | not exactly syllabification, but close enough to group characters |
| 4. **vowel groups** | the naive fallback that always answers | wrong in measured ways, recorded in the tests as _expected_ failures of this tier so nobody mistakes them for bugs in the ladder |

Every tier returns contiguous, non-empty fragments whose concatenation is exactly the input word — the
invariant that lets character spans be regrouped without re-alignment. The count is the musically audible
property — a karaoke ball bounces once per sung syllable, so one split too many puts a bounce on silence —
which is why CMUdict's count overrides the dictionary's break points. The split _point_ still matters,
because `_force_count` can only move a boundary it was given.

**The Moby data ships compactly** as `data/mhyph.xz`, loaded lazily, once: Moby's own file is megabytes of
latin-1 with U+00A5 between syllables, and what is kept is every entry that is purely lowercase letters
once joined and that has at least one break. Multi-word entries, apostrophes and hyphenated compounds are
dropped, because `syllables` splits on edge punctuation and internal hyphens itself and looks each piece up
separately.

**Both bugs this module has had were in how a token reached the ladder, not in any tier**: edge punctuation
bypassed CMUdict, so `everything,` was looked up with the comma attached and came out as _one_ syllable;
and internal hyphens were never split, so `la-la-la` came out as fragments straddling the hyphen. (README,
"Syllables: the tokens the hyphen rule reaches" and "L3 syllabify: two bugs in how a token reached the
ladder, and a shipped Moby tier".)

## 9. Language, and which bundle produces the frames

Until W7 the alignment language was the literal `"en"` on every job. Two measured consequences: a
Japanese sheet has **zero** characters the English vocabulary maps, so every attempt declined and the job
published `no lyrics`; and an accented Latin letter was silently skipped out of the target sequence, so
`cafés` decoded as `cafs`. The same finding has a second half — the hard-coded CTC blank, dormant only
while the language is always `en`, because torchaudio's English bundles put their blank at 0 and 23 of
WhisperX's 36 HF align models do not. Carrying the language is what arms that, which is why the two
landed together.

**The primary signal is the SCRIPT, not vocabulary coverage.** "Route to the model whose vocabulary
covers the most characters" sounds safer and is worse: every wav2vec2 Latin vocabulary covers English
text, and the fr/de/es XLSR fine-tunes cover it _more_ fully than the English bundle covers French — so
coverage would take Latin songs away from the bundle that times them best. A Unicode script histogram
answers the question that actually decides the bundle — can this model's alphabet express this text at
all — from the text alone, with no model loaded and no audio read.

Three signals, in the order they are trusted:

1. the **script histogram** of the text, from the stdlib Unicode database (no data files, no dependency);
2. for a script that is effectively one language among the models WhisperX tables, that language;
3. for **Latin** script — 24 of WhisperX's 42 languages, and every song in this corpus — what Whisper
   **heard** where ASR produced the text, else lingua-py, else what the job declared.

`heard` outranks the detector on Latin script because the one caller that supplies `heard` is the
transcriber, so the glyphs the detector reads there are Whisper's own output: a detector ranked above it
lets a guess overrule the acoustic model's own transcript. A non-Latin script wins outright over both,
because the script is a fact about characters that must be in the model's vocabulary where `heard` is an
acoustic guess and `declared` is a room-wide default nobody set per song.

Script detection reads the character's **UCD name** rather than a range table, which is why it needs no
data file and covers writing systems added after it was written; a decomposable character is read through
its base letter first, because the UCD names a compatibility or letterlike character after its _styling_
(a sheet pasted in Unicode mathematical bold was otherwise 100% "Mathematical" script). Only letters are
counted: punctuation, digits and `♪` belong to no language, and a histogram that counted them would call
a sheet of `[Chorus]` headers Latin at 100%.

**The routing policy lives in one function.** Latin script stays on the measured English default, on a
stem _and_ on the mix. A non-Latin script **always** routes, whatever any arm says, because the
alternative is no lyrics. Two independent reasons keep per-language mix routing off by default: on the
stem the English default wins (widened from 7 songs to all 59 fr/de/es JamendoLyrics songs), and a routed
bundle has no calibration row, so every emission-scale threshold stands down on it — which §5.4 now
answers by declining rather than by publishing ungated words.

**A letter the vocabulary lacks is folded to its base letters before it is dropped** (NFKD), so `cafés`
and `Grüße` align. The fold is a no-op for every character the vocabulary already has (checked first) and
for every atomic letter NFKD cannot decompose. **Only a letter is folded, and only its letters are
kept** — NFKD decomposes plenty of non-letters onto letters, so an unguarded fold turns a typographic
symbol into character targets a singer never sings. One folded character may yield several targets, and
both carry the **original** character's index, which is what keeps syllable regrouping exact.

(README, "The language is an INPUT", "The language reading", "Review M9, LIVE".)

## 10. Word ends — a display post-pass, and starts never move

CTC is peaky: 90.9% of 21,921 measured character spans are exactly one frame. So what the decode carries
is an ordered set of **onsets** on the frame grid, and every end is merely the model's last confident
frame. The TV acts on those ends — a word is lit while `start ≤ pos < end` and struck through at `end` —
so a phrase-final word goes dark while it is still being held and the room sees the ball leave a word
that is still sounding.

Each word's end is walked forward while the target's activity envelope is still active, and stopped at
the next **sung** word's start or a bounded maximum, whichever comes first. Never shrunk. Four bounds,
and together they are why this is not the energy-snap this repo rejected (that prototype moved _onsets_
to the nearest energy rise and measured a net loss, because a snap jumps to a neighbouring onset and the
word it jumped over is then wrong by a whole word):

* **one-sided** — only ends move, and only forward. Every onset is bit-for-bit the decode's, asserted end
  to end by a test and not only by the bench;
* **bounded by the decode itself** — the cap is the next word's own start, so an over-extension can at
  worst fill a gap the decode left empty;
* **bounded in size** — a decode that dropped a whole phrase cannot light one word across an
  instrumental break;
* **bounded by the audio** — the walk stops at the last envelope frame, so it cannot manufacture an
  overshoot.

"The next word" means **document order**, not time order: a misbound decode can publish a line whose
words sit before the previous line's, and the cap then lands behind the end, which leaves that end alone.
Sorting by time would let a word be extended over a word the document shows later, which is the only way
this could move a highlight onto the wrong word.

**On a vocals stem only**, and that is the threshold's doing rather than a preference. The active level is
a fraction of the target's own 95th-percentile level, which separates singing from silence on a stem and
separates almost nothing on a full mix — so on a stemless song and on a mix retry the walk would never
stop, and the post-pass would silently become a different, unmeasured feature. A mix-calibrated threshold
is fittable and deliberately not fitted; the reject-if such a fit owes is written down before anyone fits
one.

**Why it is a post-pass and not part of `generate`.** The wrong-text gate, the never-sung rule, the blind
envelope fit and R4 all read `Line.end`. Extending ends earlier would raise every line's envelope overlap
and lower its character rate, which **loosens** two gates by construction while looking like an accuracy
win.

**What the review's end numbers cannot say:** 80% of Jamendo's non-final word ends are recorded as
exactly the next word's start, so a gain on interior ends is partly the truth set's construction. Only
phrase-final ends are independently measured, and the TV highlight — which reads the whole document
through the TV's own rule — is the metric that cannot be gamed that way.

## 11. What publishes

Every attempt is written to **job scratch** and placed in the store only by `publish`, after
re-asserting ownership. A job an infrastructure fault failed mid-ladder therefore puts nothing in the
store and leaves nothing unreported there, and an ordinary re-align cannot overwrite the document the TV
is showing with an attempt the ladder may still reject. The knob set is **in the ref**, so a retry never
overwrites the attempt it retried.

Four fields core ranks on, and each says what its name says:

| field | what it carries |
| ----- | --------------- |
| `textConfidence` | the TEXT's standing (its tier). A **pin**'s is `high` whatever its tier: a person chose these words, and that outranks any scored guess |
| `timingConfidence` | the timing grade |
| `vouched` | the WORDS' own axis — `false` where a wrong-text gate measured these words and did not vouch for them, **or** where no such gate could read them. Sent only when false, since absent is core's "vouched" |
| `selectable` | the ladder's verdict — `false` on every attempt this job did not publish |

`createdAt` is **one** stamp per report, the moment this job's judgement was made: recency is a tie-break
between jobs, and within one report `selectable` decides, so no attempt is stamped as if it were newer
than the job's choice.

**What `selectable` is worth, replayed rather than argued.** Over the W0 `run_align` baseline's ladders
(`docs/benchmarks/forced-alignment/results/baseline-v2-run_align.cases.jsonl`, **768** song-modes, one
candidate per attempt as knob-bearing refs make it), core's ranking overrode the worker's own choice in
**319**: **236** of the **320** wrong texts the worker declined would have been shown anyway — its rejected
word document, or the line document of an ungated line-sync — **65** right texts it published nothing for
showed a reject instead, and **18** published retries lost to the very attempt they retried. The ranking
rule itself, and the reason the doubt had to become a field of its own rather than ride on
`textConfidence` or the timing grade, are in [`../SERVER.md`](../SERVER.md) "Lyrics".

An earlier job's document for words **this** job's gate refused is **withdrawn**: a refused attempt writes
nothing, so the worker names each stored document of those words `selectable: false` and the merge by ref
replaces the stored entry. Without it, a re-align that refused a text left the earlier job's document of
that text ranked — and shown — above what the re-align published. Their timing grade is not known here, so
it is not sent.

**Candidates are not optional decoration.** Core's retention sweep builds its cleanup set from the
reported candidate list (`core/src/lib/server/media/retention.ts:182`), so any document this worker wrote and did not declare is never enumerated and
therefore never evicted — it leaks for the life of the library. They are also what lets a re-pick switch
to another reading without re-fetching the audio. They are reported even when nothing was published: the
files exist regardless, so they must be nameable.

A document that lost lines of its text carries the **whole** text, so a later re-pick of it re-times
every line the person saw in the source.

### 11.1 Singer attribution

A duet shown in one colour is a duet nobody can follow, so a line may carry which voice sang it and the TV
colours by it. The wire field is **`part`**, an abstract label (`"A"`, `"B"`), because that is what the TV
reads (`core/src/lib/tv/lyrics.ts` `LyricLine.part`, coloured by `duetPartColors`); letters are assigned by
**first appearance**, as the worker this replaced assigned them, so the label is the same on a re-run
whatever strings the diarizer produced and carries no identity. `domain/lyrics/attribute.py` writing the
diarizer's own `"SPEAKER_00"` into a field nothing in core reads is why no attribution ever reached a
screen.

**It is best-effort, says so, and is all-or-nothing per song.** `None` for a line means "unknown", never
"the first speaker": guessing colours a line confidently wrong, which is worse than leaving it neutral. And
a song is attributed only when four song-level checks call it a **confident duet** — the TV's contract is
that `part` is written only where the worker's diarization is confident, and the fallback is one colour for
the whole song. Those checks are what stands between a solo and a rainbow: the worker this replaced recorded
that pyannote on sung vocals routinely over-segments into 3–5 phantom speakers. **Not re-measured here** —
the gated pyannote weights are not on this box, so no song in the bench corpus was diarized.

The module is pure, so deciding a line's singer from overlapping speaker turns is testable with no pyannote,
no model and no audio; the step's only job is to run the diarizer and hand the turns in.

## 12. Invariants later waves must not break

Written as requirement rows, in this tree's house style ([`README.md`](README.md)): each is a rule a
change has to respect, with the mechanism that holds it.

| # | Invariant | Why it exists | Held by |
| - | --------- | ------------- | ------- |
| **XA-01** | **A measured onset is never moved by a display pass.** The word-end post-pass moves ends only, only forward, and only on a stem. | Onsets are what the ball follows and what every accuracy metric scores; the rejected energy-snap prototype moved onsets and lost. | `tests/test_ends.py`, `tests/test_align_ends.py`; the bench asserts every song's onset digest is unchanged across the arm. |
| **XA-02** | **Per-line provenance is recorded for every line, and grading reads the BLIND verdict.** A line re-timed inside a claim window may grade `high` only where the blind decode corroborated that claim. | A window repair agrees with its own claim by construction, so corroboration measured after it is circular. | `_Source` on every repair stage; `tests/test_align_provenance.py`. |
| **XA-03** | **Corroboration is computed from the blind decode only, and the adoption reference median with it.** | Mixing repaired lines into the reference lets a stage corroborate itself. | `Reconciliation.agrees`; the `l1-*` control arms exist to A/B exactly this. |
| **XA-04** | **A claim is mapped onto our clock exactly once, before the first reconcile, and only the claims move.** Our own timings are never shifted to match a sheet. | Repair windows, adoptions and corroboration must all ask about the same instant the audio does; an offset sheet is still a fact about the sheet. | `claimmap.consensus`, called once in `_time_text_global` and once in `_line_sync_clock`. |
| **XA-05** | **A refusal is terminal for the text; a decline is not.** `Refused` means a gate measured that this text does not describe this audio → next text, never LINE_SYNC. A decline means nothing measured it → the ladder may degrade. | Line-syncing a refused text publishes the same wrong words on the text's own clock. Conflating the two either publishes wrong words or throws away a readable sheet. | `policy.decide` rules 0 and 1; `records.Refused`. |
| **XA-06** | **An emission-scale threshold is read only off the row of the bundle that produced the matrix.** No row ⇒ the gate stands down and the attempt declines (word timings), or the rule abstains (the margin floor). Never a borrowed number. | The bands are nats per letter on one model's scale; the envelope gate that used to catch the fallback passes 189/380 wrong texts. | `lexical.CALIBRATED` / `calibration` / `margin_floor`; `__main__.align_model_for` refuses an uncalibrated **named** bundle before the worker accepts a job; `tests/test_lexical.py`, `tests/test_ml_devices.py`. |
| **XA-07** | **The repair clamp is bounded and never invents order.** It may pull a trusted neighbour's END back onto a repair; it may not move a start, an existence, an order or a grade, and it leaves a line that would be squeezed below one decoder frame per letter alone. | The left floor it replaced was the blind decode's own boundary — the reading the repair existed to correct — and manufactured gross lines after the ladder had got them right. | `_clamped_v2`, `_pulled_end`, `generate.trimmed`; `tests/test_repair_order.py`. |
| **XA-08** | **A published word sequence is monotone.** Nothing interpolated starts before the last emitted word's end; where there is no room the words are zero-width at that floor. | Two words out of order read as incoherent word timing and `decide` degrades the whole document to line sync. | `parts.restored`'s floor; `measure.out_of_order`; `tests/test_repair_order.py`. |
| **XA-09** | **The nesting invariant holds: syllable ⊆ word ⊆ line, all ordered.** | Every level groups the same character spans, so it holds by construction — and the property test is what catches a refactor that breaks construction. | `tests/test_generate.py`. |
| **XA-10** | **A non-character column is never a CTC target** — the blank, the word separator, the unknown and sentence markers — and WHICH id is the blank comes from the matrix, never from a literal. | The kernel refuses a target list containing the blank outright; a lyric's literal `\|` forced a word separator into the middle of a word; 23 of WhisperX's 36 HF models put their pad somewhere other than 0. | `generate.excluded_of` / `blank_of`; `tests/test_generate.py`, `tests/test_ml_contract.py`. |
| **XA-11** | **A decode arm's extra targets are counted in every span check and relabelled to blank before grouping.** `spans == targets − separators − stars`. | Getting it wrong does not mis-time anything subtly; it raises on every song — which is the point. | `generate.char_targets`; `adapters/ml.starred`. |
| **XA-12** | **The gate decodes read the UNSTARRED, separator-free matrix.** The placement margin reads the starred trellis. | The gates' floors are calibrated on star-free target sequences, so an arm reaching them would measure a recalibration. A margin measured on a decode that did not run is not evidence about the one that did. | `align_steps` passes the matrices explicitly; `host.config.ALIGN_EXPERIMENTS` documents it per arm. |
| **XA-13** | **Every attempt is staged in job scratch and placed only after the ownership check; a pin places one document, at the pinned ref.** | Unreported documents leak for the life of the library; a rejected attempt must not become a rival candidate beside the file the TV is showing. | `steps.api.attempt_ref` / `store_ref`; `workflows.align._publish`. |
| **XA-14** | **`vouched` is a positive claim.** True means a gate read these words and did not doubt them; unmeasured is False. | Core reads True as a claim and ranks it as one. | `records.TimedDoc.vouched`; `test_core_contract.py` ↔ `worker-align-contract.test.ts`. |
| **XA-15** | **`domain/` is pure: no `dbos`, `asyncio`, `torch`, `torchaudio`, `whisperx`, `pyannote` or `demucs` anywhere under it, and no import of a layer above it.** Numpy and the standard library are allowed. Randomness is seeded from the DATA and never from a clock, and the only filesystem reads are packaged read-only data; both are named allowlists that can only shrink. | The suite runs with no ML installed, so a decision in `domain/` is testable with no model and no event loop; and a `domain` call reached from a DBOS workflow body must give the same answer on a replay, or one attempt would load two bundles and key two emission matrices. | `tests/test_layers.py` — `BANNED_IN_DOMAIN`, `ALLOWED`, `SEEDED_FROM_DATA`, `PACKAGED_DATA_READERS`. |
| **XA-16** | **A checkpointed record only ever gains APPENDED fields, restored through `restore_appended`.** | Pickle restores a slotted dataclass positionally, so a field added after a checkpoint was written is left unset and reading it raises — fork after fork, until the core's attempt ceiling. | `steps/records.py`; `tests/test_checkpoints.py`. |
| **XA-17** | **A machinery fault is typed and propagates; anything else an attempt raises is one attempt declining.** | A fault that fails every attempt identically used to walk the whole ladder and publish `no lyrics` for a song whose words were never measured. | `adapters/ports.InfraFault`; `transport.Client` sends `retryable` from the class. |

## 13. Measured and rejected

Kept here because each is a real idea whose cost is known, and a reader who does not find it recorded
will propose it again. The numbers are in the README section named.

| idea | why not | README |
| ---- | ------- | ------ |
| Snap onsets to the nearest energy rise | a snap jumps to a _neighbouring_ onset and the word it jumped over is then wrong by a whole word; net loss measured | "Onset-snap prototype" |
| The whole-path CTC score as a wrong-text test | a different song's lyrics scored **better** on the mix (−0.367 against −0.472) | "The lexical-lift wrong-text gate" |
| The per-line path score as the confidence rule | a path score asks how well these frames match these letters; loud, clear singing of the wrong occurrence scores well | "The confidence rule" |
| Characters per second as a confidence rule | also a property of where the line landed, not of what else it could have matched | "The confidence rule" |
| A fitted logistic over both confidence signals | its normalisation, fitted on training songs only, failed its own reject gates | "The confidence rule" |
| A wider placement-margin window (the 3 s reading) | best for gross lines and **blind** to the line whose onset is merely a second adrift, which is what the rule is judged on | "`WINDOW_SEC` = 1.0 s" |
| Gating the clamp's pull on the placement margin | strictly worse on gross in every column: the margin grades where a line's first character sits, and the conflict is between a repaired START and a neighbour's END | "The clamp's left floor" |
| Peak prominence / onset agreement as the envelope gate | neither discriminates; a shuffled sheet scored highest on prominence | `domain/audio/activity.py`, README "The fix, and what it measured" |
| The envelope gate as the wrong-text gate | it scores our own decode; on the mix it is anti-correlated with document quality | "The stemless mode" |
| Vocabulary coverage as the language router | every Latin vocabulary covers English, and the fine-tunes cover it more fully than the English bundle covers French | "The language reading" |
| A sound-effect vocabulary for non-lyric lines | any list that catches `(slow quiet electric guitar)` also catches five sung lines named in §8 | "W5: text hygiene" |
| "No lowercase" as a bracket rule | `[a-z]` is ASCII, so every caseless script satisfies it | §8 |
| A capitalised token before a colon as a speaker label | eats real first words | §8 |
| A relative (per-song) never-sung envelope floor | stricter, not kinder: between-line level on a bleed stem is already at or above the absolute floor on 29 of 32 songs, and the two populations overlap, so no floor sorts them | "The never-sung floor" |
| A characters-per-second ceiling on a repair window | no safe value: real sung lines run to 0.7–1.7 alignable characters a second | §4 |
| A lag term on the rung's agreement | refuses 13 more accurate documents for 0 gross lines gained; under `syncMode=lines` a refusal is terminal | "The rung's own claim clock" |
| `spread_sec` as a repair band or a label band | as a band it cost a song 3 of 14 lines; as a label it could never fire | §7 |
| Re-decoding between the clamp's anchors instead of clamping | a Viterbi restricted to part of its own optimal path returns that path — measured, 64 lines in 5 runs identical row for row | `_clamped` |
| Refusing the clamp's run line by line (or by DP) | within noise of refusing the whole run, so the simplest rule stands | `_clamped` |
| The every-word separator / the every-word star | a token the model never emits **inside** a phrase makes CTC leave the letters for a boundary it did not hear | §14 |
| A star only at the song's edges | measured to do nothing | §14 |
| A second decode of an ad-lib inside its gap | a repair site with its own window guard and failure mode for 50 lines of the corpus — and in a claim mode the ladder already re-decodes a repaired line from its full text | "W5: ad-libs" |
| A `MAD` half beside the inlier share in reconcile | cannot ever bind, so it is not written as though it did | "Reconcile robustness" |
| Eager ASR on every job as a wrong-song detector | forced alignment **is** the wrong-song detector; ASR is paid for only when it is needed as a fallback | `workflows/align.py` |

## 14. The experiments knob

`ENCORE_ALIGN_EXPERIMENTS` (comma-separated → `Config.align_experiments`) is the **one** place
default-off arms live. Every arm is built, tested and measured; an arm ships off because it failed its
reject-if gate, and **a name that becomes the default is retired and its control takes its place**.
Setting a retired name is refused like a typo: measuring the default path under an arm's name is the
thing this tuple exists to prevent.

| name | what it switches | kind |
| ---- | ---------------- | ---- |
| `l1-mix-kept` | R1/R2 never re-decode on the stem a line R4 timed on the mix | failed arm |
| `l1-blind-median` | the adoption test's reference median is the blind decode's, taken once | failed arm |
| `m2-order-clamp` | the clamp fits a run of repaired lines in order or refuses the whole run back to blind | failed arm |
| `m5-adopt-floor` | a claim span too short to hold its line is not adopted over a window decode that heard nothing | failed arm |
| `m6-mix-spare` | a claimed never-sung candidate the mix sounds in is spared for R4 | failed arm |
| `m6-window-spare` | a never-sung candidate the target sounds in is re-decoded inside its claim window | failed arm — **re-priced as free; recommended, deliberately not flipped** |
| `claimmap-piecewise` | the claim clock may split into change-point legs | failed arm (and inert since the leg-boundary guard) |
| `ends-tile` | the end post-pass tiles each line gaplessly | failed arm |
| `linesep` | the targets carry the vocabulary's word separator between lines | failed arm at the decode level; the E2E axis is unread |
| `star` | the targets carry a star before every line, over a matrix one column wider | failed arm at the claims path; the decode gain is real |
| `adlibs` | ad-libs and echo tails are held out of the lead decode | failed arm |
| `conf-fuzzy-repeats` | the confidence demotion also fires on near-repeats | failed arm |
| `lang-route-mix` | a Latin-script song's **mix** is timed by a per-language bundle | failed arm — and **inert alone** since §5.4; pair it with `h3-ungated-words` to measure anything |
| `ends-raw` | the end post-pass does not run | **control** for a default-on feature |
| `h3-mix-envelope` | the mix's wrong-text verdict is the envelope gate alone | **control** |
| `h3-mix-floor` | both gates on the mix (what W3 first shipped) | failed arm |
| `h3-ungated-words` | an uncalibrated bundle may publish word timings behind the envelope gate | **control**, and the only way to measure an uncalibrated bundle end to end |
| `conf-legacy` | per-line grading ignores the placement margin | **control** |

A control exists because a default-on change must be A/B-able and the arm switch is the only thing the
bench can move without editing code. Each arm's numbers live where it is read — the constant, the module,
or the README section named in §13 — and `host/config.py` is the index.

### 14.1 What the two target-adding arms share

`linesep` and `star` both put a non-letter target into the sequence, which is why they are three lines in
`generate` rather than a caller's post-pass: they share three mechanical facts.

* **Between or before, never inside a line and never at an edge.** A separator is emitted **lazily**, just
  before the first character of the next line that has one, so a row with no letters is one boundary and not
  two. A star goes before **every** line, the first included — which is the star that absorbs an intro the
  text does not mention.
* **Their frames are relabelled to blank before grouping** (XA-11), which keeps the grouping half
  untouched: such a run reads exactly as the run of blanks that already separates two repeated characters.
  Left in the label stream a star got a span of its own, and `_lead_starts` clamped the next line's first
  character against **the star's** end.
* **The span check counts them.** `forced_align` emits one span per target, so the invariant is
  `spans == targets − separators − stars`; getting it wrong raises on every song rather than mis-timing
  anything subtly.

**Why the separator and not a letter.** `|` is what wav2vec2 and HuBERT were _trained_ to emit between
words: every LibriSpeech-lexicon checkpoint's vocabulary is `{'-': 0, '|': 1, 'e': 2, …}` and its
transcripts are `THE|CAT|SAT`, so the column already carries "a word boundary happened here" and forcing a
path through it asks the model something it knows. **What the star buys** is somewhere cheap for the path to
wait: a forced path must label every frame, so audio the text does not cover — an intro, a break, a verse
the sheet omits — is charged to whichever characters are nearest and drags them, and a star scored
`frame max − P` absorbs it instead. (README, "the star": `107/387` line starts more than 2 s off with half
the lines dropped, `142` gross on one 6-line unsung verse, `feel-my-heart`'s first word about 28 s early.)

**Both arms stand down rather than fail where the matrix cannot carry them**, and the two silences are
different facts a caller must tell apart (`generate.separator_named`): a matrix that names no specials at
all — every fake in the suite, every bench cache entry written before the field — and one whose separator
or star id **is the blank**, which the kernel refuses as a target outright, so an arm that could only
decline must not be armed. The second is reachable: WhisperX tables Norwegian Bokmål with `|` at id 0 and a
torchaudio bundle's blank _is_ 0; it is only that vocabulary's `[PAD]` = 38 that keeps the two apart today.

## 15. Determinism, purity, and cost

* **`domain/` is pure** (XA-15). The step layer owns **torch**; numpy is allowed in `domain/` and is used
  there — `domain/audio/` is numpy throughout and `domain/lyrics/margin.py` is numpy over the trellis. What
  the layer rule buys is a NUMPY-FREE SEAM where one is cheap: `claimmap` takes its audio-side candidate as a
  plain sequence of floats and `ends` takes its envelope the same way, so both are testable from a literal.
  Two deliberate, named exceptions to "pure" in the stricter sense: `domain/lyrics/lexical.py` imports
  `random` (seeded by `crc32` of the text, so a replay repeats it) and `domain/lyrics/syllabify.py` reads its
  packaged `mhyph` table through `importlib.resources`, as `domain/audio/wav.py` reads a wav by path.
* **`workflows/` is deterministic.** DBOS replays a workflow body on recovery, so no wall clock, no
  random, no filesystem and no sockets live there. Ties break on names, not on dict order: a language
  that moved between two replays of one attempt would load two bundles.
* **One model pass per song**, cached per (resolved path, size, mtime, model, language, device) in a
  bounded LRU, because DBOS may re-enter a workflow and a retry that recomputed the matrix would pay for
  durability twice. A file that cannot be stat'ed is computed uncached, so its failure still comes from
  the audio read.
* **The frame grid is exact.** Frame `k` is stamped at `k × FRAME_SEC`; one pass lays the whole song on
  that single grid and each pass computes context on either side and throws those frames away, so a frame
  at a chunk boundary sees the same context an interior frame does. A derived `duration / frames` ratio
  used to produce a per-chunk sawtooth and a dropped final sliver.
* **Cost shape:** the model pass dominates (≈4–9 s a song on this box); a decode is 0.1–0.8 s and
  23–230 MB; the two margin passes are a second read of a matrix already paid for. Three docstrings used
  to call the decode "a millisecond", which was wrong by an order of magnitude.

**Two upstream facts with a date on them**, because both are a dependency's decision rather than ours:

* **The CTC kernel is deprecated.** `torchaudio.functional.forced_align` is marked for removal in
  torchaudio **2.9** (`pytorch/audio#3902`). This project pins 2.8.0, so nothing breaks today, but the
  torch-family pins move together and whoever bumps them must find the kernel's new home or vendor it.
  A kernel that is **gone** raises `ModelUnavailable` — an `InfraFault` that fails the job — rather than
  declining text after text into a published `no lyrics`; the bench suite would catch a silent change of
  behaviour.
* **The blank id comes from the bundle, by whisperx's own rule** (`whisperx/alignment.py:267-270`), and
  whisperx lowercases its dictionaries (`alignment.py:98,110`), which is why the target filter lowercases
  a character before looking it up. Both are read rather than reimplemented, so a whisperx upgrade that
  changes either is a test failure and not a silent mis-timing (XA-10).

## 16. Where to look

| question | file |
| -------- | ---- |
| every number, every sweep, every per-song reading | [`../benchmarks/forced-alignment/README.md`](../benchmarks/forced-alignment/README.md) |
| the gates as executable acceptance tests | `docs/benchmarks/forced-alignment/gates/*.yaml` |
| the harness that produces the rows | `docs/benchmarks/forced-alignment/scripts/e2e.py` |
| the state machine, the knobs, and the trail an operator reads | [`../../worker/README.md`](../../worker/README.md) |
| the rest of the worker | [`05-worker.md`](05-worker.md) |
| what core does with a published document | [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §8, `core/src/lib/tv/lyrics.ts` |
