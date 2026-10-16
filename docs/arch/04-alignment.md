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
(README, "W7: the star/filler token, phase A"). The shipped value is the RE-FIT's, taken on the 28 songs that
score over a grid that extends past the optimum on both sides, and it is a flat REGION rather than a digit —
the review's proposed `[1, 4]` is picked by no objective in no fold (README, "W9: the star re-fitted out of
sample, at an optimum outside the review's range").

**The transcriber and the aligner ask for different devices.** The aligner is plain torch wav2vec2 and runs on
`mps`; the transcriber is CTranslate2, which raises on it — and torch reports MPS as available on every Apple
Silicon box, so one global device string would fail ASR on every Mac. Each component asks for what it can
take. Unrelatedly but in the same lazy-import region: torch 2.6 changed `torch.load`'s `weights_only` default
to `True`, and pyannote's VAD checkpoint (which whisperx loads on the way to a transcriber) stores omegaconf
objects and its own task enums, so an allow-list of unpickling globals is registered once per process. It is
**narrow by design** — `weights_only=False` would disable the integrity check for every checkpoint the process
ever reads — and the list was discovered by loading and reading each refusal in turn, a missing entry being
the same hard failure rather than a warning.

### 3.2 The decoders: torchaudio's kernel, and the vendored graph

Two implementations sit behind `generate.Decoder`, and the second exists so the graph can say things the
first cannot.

**`adapters.ml.forced_align_decoder`** is `torchaudio.functional.forced_align`: a C++ CTC Viterbi over the
plain `[blank, c₁, blank, c₂, …]` topology, and the default. The deep review's F5 claimed it was being
removed in torchaudio 2.9; that was **stale** — 2.10 and 2.11 both keep it — so nothing here is urgent by
removal.

**`domain.lyrics.viterbi`** is a vendored pure-numpy Viterbi with int8 backpointers, in the style of NeMo's
`aligner_utils` (Apache-2.0). On an empty `Graph` it is the kernel **frame for frame** (XA-18) — the same
three-way tie-break, the same choice of final state, the same float32 accumulation, the same refusals as
`ValueError` — which is what makes it swappable at all. It lives in `domain/` because it is numpy over data
(XA-15), and the `vendored` arm is the control that proves the swap costs nothing.

What the graph adds, and why none of it fits through a fixed kernel:

* **Skip arcs over an optional line** (the review's roadmap item 15). One penalised arc per line, from the
  blank before its first character to the blank after its last, priced `SKIP_LINE_NATS + SKIP_CHAR_NATS ×
  characters` (30 + 6, the review's refined pair). Blank to blank on purpose: the bypassed line's
  neighbours stay separated by a blank frame, so no two character runs can merge and XA-11's span count
  still holds. A **repeated line is exempt**, the arc having no way to tell which occurrence is which.
  It ships as a **detector**, not as the publishing decode: the lines it names are blanked and the shipped
  decode runs again without them, which is exactly what the never-sung rule does — so it is a COMPLEMENT
  (it runs first, and the three-signal rule then runs on what is left) and can never be a replacement.
  A detector decodes the PUBLISHER's topology and not merely its matrix: under `skip-arcs,star-b` the star
  targets are bypassable in its graph too, at the same `P`, because mandatory stars would make it name lines
  about a decode nobody ran (`align_steps._star_positions`, read by both; review W9 r2-correctness-4).
* **An optional frame-relative star** (star phase B). The star state emits `frame max − P` computed in the
  graph, so phase B needs no matrix surgery of its own; at one `P` that is the same number phase A's
  appended column holds, which is why the two phases share one fitted penalty. The new power is that it may
  be **bypassed for free**, through two arcs — from the blank before it, and from the character before that,
  the second withheld where the characters either side of the star are the SAME label, that being a CTC
  transition no path may take (`viterbi._compile`; review W9 r2-tests-13 pins it on a line boundary that
  repeats a letter) — which together make the starred graph a strict **superset** of the plain one: every
  plain path exists in
  it at the same score, so a large `P` reproduces the plain decode exactly. A fixed kernel cannot express
  that: a target in the sequence must be visited. The superset holds at **frame 0** only because the arcs
  leaving the leading blank — the one state a path may occupy without spending a frame — seed the trellis
  there too (`viterbi._Arcs.entry`): `char_targets` puts a star before every line's first character, so
  state 1 IS the first star and a recording that sings on frame 0 had no plain counterpart without it
  (review W9 r1-correctness-3). The frame precheck is bypass-aware for the same reason
  (`viterbi._frames_needed`): counting every target as mandatory refused the skip-arc detector on frame
  counts its own arcs could fit, which is precisely the input class it exists for (r1-correctness-8).
* **A capped-Gaussian onset bonus** (the review's roadmap item 14). `domain.lyrics.prior.onset_bonus` builds,
  per line, nats added at that line's first-character state: a Gaussian centred on the **clock-mapped**
  claim (XA-04 — a raw claim would centre it on the sheet's own offset), truncated to zero beyond
  `ONSET_REACH_SEC` so a mis-bound repeat cannot pull a line across the song. It is paid **once, on the
  transition into the state**, never per frame of dwelling: on the emission a 20-nat peak parked a line's
  first character on the prior's own peak and paid 600 nats of evidence for the privilege. A prior is
  **never** added to a reported score — the score is the word's confidence, and a bonus is not evidence.
  `prior.fused` is the other half: inside a claim window where the target's envelope hears nothing, the
  mix's frames replace the stem's, because there they are the only evidence there is.

The prior and the fusion reach one decode only — the **primed re-decode**, after the claim clock and after
the blind verdict grading reads (XA-03, XA-04) — and under `priors-decide` that decode stands in for the
repair ladder. A repair window is never given a graph: its targets are a different sequence over a slice,
so a graph built on global target positions would describe a decode that never ran. The repair LADDER's own
input stays claim-free for the same reason: R3's blind-repeat set is read off the **blind** verdict, never
off the verdict the primed decode re-read, or a line the prior pulled onto its claim would read corroborated
and be withheld from the rung whose output is graded on blind corroboration (review W9 r1-correctness-4).

**One bundle or no fusion.** `prior.fused` swaps whole ROWS, so a row of one matrix has to BE a row of the
other, and all a pure-array function can compare is the WIDTH. The mix is emitted under its own language
routing (`_bundle_language(on_mix=True)`, which `lang-route-mix` can resolve elsewhere), so the DICTIONARY
and the blank are checked in `fuse_in_the_mix`, where both bundles are in hand; a mismatch declines the arm
on the trail rather than fusing two alphabets (review W9 r1-spec-10).

**And the fused matrix goes back as the KIND the emitter produced.** `claim-fusion` changes the evidence and
not the decoder, so on its own it keeps torchaudio's kernel — which calls tensor methods on what it is
handed, while `prior.fused` lives in `domain/` and therefore answers in numpy (XA-15). `ml.log_probs_like`
re-wraps it, because without that the primed decode raised `AttributeError` on every real box and the trail
read "dropped" while every test, which injects a numpy decoder, read a successful re-decode
(review W9 r2-spec-6; `tests/test_research_arms.py` now decodes a real tensor through a tensor-only decoder).

**The trail says which graph published.** `_graph_why` reports an unreported graph as "an empty graph, so
this is torchaudio's own path", which is the bare `vendored` CONTROL's whole claim — so every non-plain
graph notes itself where it is BUILT, and the skip-arc detector notes its own price and scope separately,
the detector being a different graph from the one that publishes (review W9 r1-correctness-2).

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

**The opening a forced path absorbed.** CTC is peaky, and a line whose caption opens on a sustained vowel
("oh oh…") gives the path nothing to gain by stepping into it: the vowel goes to blank and the line opens
0.3-1.0 s late, with its END measured correctly. A late opening is the error the ear reaches first (ITU-R
BT.1359: ~45 ms late against ~125 ms early), so a re-decode that opened more than `AGREE_TOLERANCE_SEC` past
its claim is **re-opened at the claim's onset** — the line's start, its first word's start and that word's
first syllable, and nothing else, so every other word keeps the onset and score the decode measured
(`generate.reopened_line`, against `adopted_line`, which throws the whole measurement away).

The question it turns on is whether the cue's front is missing or the whole cue is displaced, and **the END is
what answers it**, scaled by the document's own lines: the median of "decoded end − cue end" over the lines
whose openings the blind decode already agrees with (XA-03), which is a reading and the raw difference is not
— a decoded end is the model's last confident frame and runs a third of a second inside a real cue's end. A
displaced sheet is refused three times: it has no agreeing openings to build that reference from, its ends
disagree by the same lag as its openings, and `reconcile.off_sheet`'s envelope witness names it outright. Also
required: a cue END THE SHEET ACTUALLY WROTE, the defaulted `start + 1.0 s` being arithmetic. Two witnesses
built on the LEAD instead were measured and rejected — the acoustic model and the envelope both read it
backwards, hearing nothing over a held vowel and plenty over the breath before a displaced cue (README, "W8a:
the late half of the band, and the end that witnesses it").

**The envelope has THREE states, not two, and a grade and a repair read different ones of them.** The
asymmetry is a decision, taken because an unreadable envelope is the state the corpus's most displaced sheet is
actually in (bad-guy's lag is +0.78 s at r 0.19, under `claimmap.MIN_ENVELOPE_CORRELATION` 0.25):

| `claim_lag` | the grade (`reconcile.off_sheet`, §6.1) | the repair (`skipped_opening`) |
| ----------- | --------------------------------------- | ------------------------------ |
| absent, or r under the floor — UNREADABLE | `sheet_displaced` False: abstention never demotes | `sheet_settled` False: **stood down**, no licence to move a start |
| readable, \|seconds\| > `AGREE_TOLERANCE_SEC` — CONVICTS | may demote, the claims' own witness concurring | stood down |
| readable, \|seconds\| ≤ `AGREE_TOLERANCE_SEC` — ABSOLVES | no demotion | armed |

A demotion fails OPEN because an unmeasurable witness must not convict; a timing move fails CLOSED because an
unmeasurable witness must not license. Both guards read one `sheet_lag`, and neither is the other's negation
(review r1-correctness-2).

**And the move has to land in FREE TIME** (`opening_is_free`): the clamp resolves a repaired start against its
predecessor's published end by rescaling the whole line, so a re-opening into occupied time buys one opening
boundary and pays with every measured word onset in the line — the opposite of why this remedy was chosen over
adoption. **The decode's own span is no bound at all here**, which is the thing worth knowing: the repair window
widens with the cue, so a forced path over it measures a line that grows as fast as the backward distance does.
On the hermetic fixture a cue 7.9 s before its decode yields a window decode of 23.94-30.00 s, and
`line.end - line.start` of 6.06 s never bites on a 3.94 s move; the predecessor's end does (review
r1-correctness-1, XA-07).

**The free time is the time THIS BATCH will leave**, not the time it started with: `adopt_where_unheard` runs
over a whole batch before the document is rebound, R1's batch is every claimed line and R2's routinely holds
adjacent disputed lines, so the predecessor's end has to be read off the batch being built. Read off the
pre-batch document it was one repair stage out of date, and the guard passed on an end the same batch was about
to replace (review r2-correctness-1 / r2-spec-8 / r2-tests-15).

**And the move is capped absolutely**, at `_REOPEN_MAX_SEC` — the band this rule exists for ends where a gross
line begins. The decode's own span does not bound a merged cue, so without the cap a 10 s cue could pull a
published start back by seconds onto a correct decode of a different phrase; a refusal for size is named on the
trail, "refused" and "never considered" reading alike otherwise (review r2-correctness-3).

**A line with no OTHER aligned word is not re-opened at all.** The first word's onset becomes the cue's, so on a
one-word cue — or one whose only companion is interpolated — the re-opening removes the line's last measured
word, `parts.unmeasured_lines` reports it and `line_confidence` grades it `low` with no word wipe: the opposite
of the property the remedy was chosen for. That case is an adoption with a kept end (review r2-spec-12).

**IT IS DEFAULT-ON since W9** (owner decision, PLAN 2026-10-09; its control is `band-late-kept`, §14). W8a's
sweep priced it and it failed that wave's `no-song-loses-jit`; the owner then priced the waiver and took it —
`Kinematic_-_Peyote` 71.43 → 92.86 at ±500 and +0.20 pt pooled, against four Jamendo `jit` words moving from
inside ±100 ms to outside ±300. Those four are a RECORDED EXCEPTION in `gates/w8b-arms.yaml` §2, not a
loosened bound: a fifth broken word still goes red. README, "W9: `band-reopen` flipped default-on, and the
four words the owner waived". ITS REACH IS §14's FIGURE, NOT THE PRE-SWEEP ONE: the rule moves
**36 of 56** lines at `run_align` for **+15 at ±500 and none lost**, and the leak the unguarded arm had —
`Explosive_Ear_Candy_-_Like_The_Sun` at `jit`, three lines pulled onto jittered claims, one landing 0.81 s from
truth — is refused by the free-time guard. (The "+8 lines, `tfr-chosen` at `off05`" this paragraph used to carry
was task 3's pre-sweep count of lines MOVED on 14 songs at `truth`, read as a ±500 gain: review r2-spec-11,
README, "The recorded reach figure, corrected".) The guards read the document's STRUCTURE (agreeing openings,
the cue's end, the envelope), all three of which survive per-line jitter, so a sheet that is noisy rather than
displaced passes every one of them. README, "W8a: what the corpus said about the two band components".

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
* **The clock, between the two questions:** a sheet 1.5 s off is a sheet to _move_, not a sheet to refuse,
  so the rung takes its own claim-clock vote (§7) and places the winner. It is voted AFTER the words gate
  and BEFORE the timings gate, so a sheet refused for its words — the rung's commonest refusal — pays for
  neither the blind decode nor the vote, and its trail carries no clock clause at all. Until the vote
  existed, the sheet was moved by the activity fit whenever that fit was usable and by nothing else, which
  cost both ways: 12 right texts refused for a clock error their own decode could see, and 23 published
  documents with **no** line within ±500 ms of truth because the fit moved a sheet that was already right.
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

**Two exits publish on less than both gates, and the rung's docstring names them rather than claiming the
invariant it cannot hold.** (1) **The ASR tier**, which leaves before either gate and before the stemless
decline above: a transcript's spans were measured on this very recording, so neither defect this rung
detects can be true of them, and read as a sheet the text would FAIL — the lift judging the acoustic model's
own words, the envelope gate judging spans that already are the audio's. It publishes its own spans at `low`
confidence with the trail saying there was no sheet gate, and it is the one text that reaches this rung on
the mix (`req.text.tier is Tier.ASR`; §5.1 holds the same exemption for the lift). (2) **A sheet whose
decode cannot be read**, which is the fallback paragraph above: the sheet-span envelope decides alone, and
because `vouched` is a positive claim about the WORDS (XA-14) such a document goes out unvouched wherever
the lift could not measure them — which is every case where there was no matrix to decode or to lift on.

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
  own line timings degrades, and an untimed one moves to the next text. **Both engines**, since W8: the
  windowed one reads no matrix at all, so it can measure no lift on any bundle, and it declines a routed
  bundle's words at the same seam. The one rule is `lexical.may_time_words` — words need a witness, which
  is a calibration row or a transcript of this very recording — and what the lane does publish is the
  sheet's own line timings, `low` and **unvouched**, with the missing row named on the trail. The
  measurement, the per-song truth set and what is still owed: `docs/benchmarks/forced-alignment/
  README.md`, "W8: the non-Latin truth set";
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

**And no margins on a TOPOLOGY the decode did not run** (`_Placement(silence="graph")`, review W9
r1-correctness-5). `margin.placement_margins` knows only the plain CTC topology and takes no
`viterbi.Graph`, so under `star-b` — whose published decode may bypass every star for free — a margin here
would answer about a trellis nothing used, and `ambiguous` would demote lines on it. Phase A (`star`) keeps
the rule, its star being mandatory in both decodes: the abstention belongs to the GRAPH, not to the column.

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

### 6.1 The coherence check — _is this document where its own sheet says?_

Everything above grades a line against a residual **with the claims' common offset already fitted out**.
That is right for a line: where our timings publish, a sheet stamped 3 s early is a fact about the sheet.
But it means a document every line of which is the same 0.9 s from its claim corroborates line for line and
publishes `high`, because after the fit every residual is near zero. W8a measured that: `bad-guy` published
`confidence=high` with **2 of 64** lines within 500 ms of its own captions, and no number anywhere in the job
named the 0.86 s. Gross misplacement — the thing the placement margin and the score-vs-median rule were built
for — was zero on that song. The two rules are blind to a uniform shift **by construction**, not by accident.

`reconcile.as_claimed` is the one reading that removes nothing, so it reads the error a room would see.
`reconcile.off_sheet` turns it into a grade, and the whole rule is a conjunction of **two witnesses the worker
already has, neither of them truth**:

| witness | reading | what it says |
| ------- | ------- | ------------ |
| the claims it was **given** (`claimed_as_given`, before the claim clock) | `as_claimed` of the PUBLISHED starts: `offset_sec` past `AGREE_TOLERANCE_SEC`, with `spread_sec` inside it **and** `together` at or above `MIN_COHERENT_SHARE` | every line moved, and they moved **together** — one lag, not scatter |
| the **activity envelope** (`claim_lag`, `activity.fit_shift` of the SERVED claim windows) | `\|seconds\|` inside `AGREE_TOLERANCE_SEC` at a correlation of at least `claimmap.MIN_ENVELOPE_CORRELATION` | the singing is where the sheet says, so **the sheet is not what moved** |

The second witness is the whole design, and it is what makes this safe to ship. Two documents are
indistinguishable from the claims alone: one whose SHEET is early, and one whose DECODE is late. The envelope
is the arbiter that already settles exactly that question everywhere else in this engine (§5.2, §7), and here
it decides which side to believe. Four of the five songs W8a investigated turned out to be the first kind —
their captions precede their own singing and our documents are right about the audio — so a rule built on the
claim reading alone would have demoted four correct documents and turned the word wipe off for the whole room.
Under the conjunction it demotes none of them.

**"Coherent" is two tests, not one.** A MAD is robust, which is exactly why it cannot carry this alone: a
document half of whose lines are 0.9 s late and half EXACTLY on their claims reads `spread_sec` 0.00 and would
have been convicted on a population that is nearly half correct. `together` — the share of residuals within
`AGREE_TOLERANCE_SEC` of the median lag — is the conjunct that refuses it, at `MIN_COHERENT_SHARE`. The floor is
measured, not chosen: README, "W8a: the share a coherent lag has to carry" (review r2-correctness-2).

**And the first witness is only independent while the claim clock has not already moved the sheet.** Where the
clock applied a map, a document that published on the MAPPED sheet sits exactly the map's own displacement from
the sheet as served, so the claims are restating a decision this pipeline made and the conjunction is a
ONE-witness rule — the envelope's. `OffSheet.claims_independent` says which, per job, on the trail. The per-mode
conviction counts, and why neither candidate fix survived measurement: README, "W8a: when the claims restate the
clock" (review r2-spec-7).

Three further properties worth stating, because each one closes a way this could have gone wrong:

* **Abstention never demotes.** A correlation under the floor passes `None` and the check stands down — the
  same spelling `claimmap.consensus` uses, and the reason `bad-guy` (r 0.19) is untouched even though its
  envelope lag happens to be large. A reading nobody trusts may not cost a room its word wipe.
* **It is sign-symmetric in both witnesses**, so a sheet that is late cannot be read as a sheet that is early.
* **It is a self-consistency test, not corroboration.** W1's H4 stands: only the blind decode corroborates.
  This check can take a grade DOWN and never up, so `high_gross` cannot rise through it.

A demotion grades every line `low` and the document `low` — the TIMINGS' axis (XA-14), not `vouched`'s, the
words being fine. The TV then renders those lines line-level with no word wipe (`wipesWords` in
`core/src/lib/tv/lyrics.ts`), which is a real user-visible cost and the reason the rule is a conjunction
rather than a threshold. The reading is on the trail of **every** claimed job whether or not it demoted
(`align_steps._sheet_why`): "we checked and it is close" and "nobody checked" must not read alike, that
silence being what the 0.86 s hid behind.

**THE DEMOTION IS BEHIND `band-off-sheet` AND OFF BY DEFAULT** (§14); the READING always runs and always
reaches the trail. The full corpus sweep found the conjunction firing in two places and showed that it cannot
tell them apart: on `bad-guy` at `off05` it removes **49 `high` lines, every one of them more than 500 ms from
truth** — the rule doing exactly what it was built for — and on `never-be-alone` at `offm1` it removes **23
`high` lines, every one of them correct**, demoting a document whose ±500 does not move. The mechanism is the
second witness: that song's envelope lag reads **−0.80 s at r 0.77** against its own true sheet, so a sheet
perturbation near +0.8 s puts the false reading inside `AGREE_TOLERANCE_SEC` and the envelope "absolves" a
sheet that really is displaced. The claim reading then convicts us correctly (we did re-time by +1.03 s) and
the conjunction closes on a right answer. So the two witnesses do NOT cover each other's false positives where
a perturbation lands on one witness's own error, which is the design claim the corpus refuted. What it would
take to flip the arm on: a third reading, or an envelope whose per-song error is bounded.

Measured on all 32 corpus songs, including what the metric now says per song: README, "What the coherence grade
reads", "The 0.5-2 s band" and "W8a: what the corpus said about the two band components".

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

### 9.1 Units: what a word and a syllable ARE in a script with no spaces

Everything in §9 gets the right **bundle** for a non-Latin text. It does not make the text's own units
right, and `text.split()` is not a tokeniser — it is a tokeniser **for languages that write spaces**. A
Chinese line carries none, so the whole line was one word with one syllable: a karaoke ball with a single
bounce per line, and a lexical "shuffle" that only permuted whole lines. `domain/lyrics/units.py` answers
the units instead, **routed by script** for §9's reason, and `units.Rules` is one object every reader of a
trellis takes — the decode, the repair, the margin, the lift — so no two of them can group one text
differently.

| language | a WORD is | a SYLLABLE is |
| -------- | --------- | ------------- |
| `zh` | one hanzi; a Latin RUN inside the line stays one word | one hanzi |
| `ja` | one fugashi token, or one mora where fugashi is absent | one mora (a small kana, `ー` and the voicing marks attach to the mora before them, having no onset of their own) |
| `ko` | one SPACED token | one Hangul block |

Korean is a deliberate departure from the review's "one word per Hangul block". Korean spaces its words
and §11.2's `wordGap` therefore puts a space between two published Korean words, so per-block words would
publish `오 빤` where the sheet wrote `오빤` — the defect §11.2 exists to fix, reintroduced from the other
end. The AMLL truth agrees: its Korean lines carry 233 whitespace words over 55 lines, where its Chinese
and Japanese lines carry roughly one word per line.

Three arms, **all default-off** and all inert on a Latin language by construction (`units.rules` hands back
the whitespace rule for every language outside the table above, so no English row can move):

- **`nonlatin-units`** — the table. A GROUPING change only: the target sequence is the same characters in
  the same order, so no onset can move, only which word and which syllable a span belongs to.
- **`zh-simplify`** — OpenCC `t2s` as a vocabulary fold in `generate.char_ids`, tried **after** a direct hit
  and **before** NFKD, so a Simplified sheet never pays for it and a one-to-many conversion cannot overrule
  a character the model already knows. The review measured Traditional text at 69% covered by the
  simplified-only `zh-cn` vocabulary; on this corpus's four Chinese songs it is a no-op, which is itself a
  measurement (README, "W8 stages 1-2").
- **`mms-roman`** — `torchaudio`'s **MMS_FA** bundle for a non-Latin language, whose vocabulary is 26 Latin
  letters and an apostrophe, over a target sequence romanised **per syllable fragment** so every target
  carries the index of the grapheme it came from and a span maps straight back (**XA-20**). It implies
  `nonlatin-units`, the fragments of an unsplit line being one fragment. **Its weights are CC-BY-NC**: it is
  an arm an operator switches on for a local or personal room, and it may not become anybody's default —
  the owner's call, and the one licence in this tree that is not permissive. MMS_FA also ships its own
  star column, which `adapters.ml.specials_of` names `OWN_STAR_NAME` so a lyric's literal `*` can never
  target it (XA-10) — deliberately not the `star` arm's name, since that arm's column is one the arm priced
  and the model's carries a price nobody here fitted, so `starred` appends and prices its own as always
  (review r1-tests-16). **It needs the `romanize` extra to be useful**: with no backend
  installed the arm loads MMS_FA and hands it the original characters, of which its 26-letter vocabulary
  maps none — the trail says so (`units` without `roman` in the arm's clause, beside an `MMS_FA` bundle
  clause) rather than publishing something that looks like a reading.

None of this publishes words for this lane on its own: §5.4 still declines a word document off a bundle
with no `lexical.CALIBRATED` row, and neither the per-language whisperx bundles nor MMS_FA has one. The
arms are measurable at the bench's `generate` level against the AMLL TTML's own syllable spans, and
calibrating a row is a later wave's (README, "W8 stages 1-2").

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

### 11.2 Romanisation, and the CJK line the TV has to render

A Chinese, Japanese, Korean, Cyrillic or Arabic line is published in its own script, as it must be — it is
the text the room asked for. A guest who cannot read that script sees nothing they can sing, so a line may
also carry **`romanization`**, a second script printed UNDER the original at a smaller size
(`core/src/lib/tv/LyricsOverlay.svelte`, `.romanization`). Three rules make it safe to add:

1. **It never replaces the text and is never a target.** `domain/lyrics/romanize.py` is called by
   `_line_doc` at publish time, from the line text that is already decided; nothing upstream of the
   decode can see it. Invariant **XA-19**.
2. **It is absent rather than empty when there is nothing to show**, which is what keeps every older
   document and every recorded bench row parsing unchanged. A Latin-only line gets none even inside a
   Chinese sheet (it would print a copy of itself), and a backend that hands the text straight back, blank,
   or raises, costs that line its romanisation and nothing else.
3. **It is routed by the TEXT's language, not per line**, because the script already decided that language
   (§9) and a kanji has to be read as Japanese rather than as Chinese.

The backends are an **optional extra** (`romanize` in `worker/pyproject.toml`, which states each licence)
and the choice between them was a licence question before it was an accuracy one: **pypinyin** (MIT) for
`zh`, **cutlet** (MIT, over fugashi and unidic-lite) for `ja` — never pykakasi, which is GPL-3.0 — and
**uroman** (Apache-2.0) for every other non-Latin language `language.SCRIPT_LANGUAGES` can route, so a
script this project never measured still prints something readable. A test pins the two tables equal, so a
new routable language cannot be added without a backend. Nothing measures how GOOD a transliteration is;
this is a reading aid, not a claim.

**Core joins CJK without spaces.** The reel put one space between every word, which spelled a Japanese line
out character by character — a published CJK word document is timed per character or per token. `wordGap`
in `core/src/lib/tv/lyrics.ts` is the one rule both the reel's inter-word gap and the text re-segmentation
rebuilds read, so the two cannot disagree: nothing between two characters of Han, kana or CJK punctuation,
one space everywhere else. **Hangul keeps its spaces** — Korean spaces its words, and is only "CJK"
typographically — and so does a CJK/Latin boundary, those running together being unreadable either way.
The bench's TV port carries the same rule, enumerated from the TypeScript's Unicode `scx` classes into
ranges and pinned by two cases of the parity fixture
(`docs/benchmarks/forced-alignment/scripts/e2e_lib.py` `tv_word_gap`).

Stage 0 writes `romanization` on **line** documents only: this lane publishes lines by rule (§5.4), and the
TV drops a romanisation when it re-segments a row, which is exactly what a word document of this script
would be subject to. Measurements: `docs/benchmarks/forced-alignment/README.md`, "W8 stage 0: romanisation
and the CJK line".

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
| **XA-18** | **The vendored decoder on an EMPTY graph is `torchaudio.functional.forced_align` frame for frame.** Same tie-break, same final state, same float32 accumulation, same refusals; the extra arcs are the only thing that may move a published byte. | A second decoder is only worth having if swapping it in is provably free — otherwise every arm measured through it is measuring the swap as well. | `domain/lyrics/viterbi.py`; `tests/test_ml_contract.py` against the real kernel, `tests/test_viterbi.py` without torch; the `vendored` control arm. |
| **XA-19** | **A romanisation is DISPLAY ONLY: written at publish time, additive, and absent when there is nothing to show.** It never replaces a line's text, never reaches a target sequence or a gate, and a document without it parses exactly as it did before. | A second script in the alignment targets would be words nobody sings, and a mandatory field would break every stored document and every recorded bench row. The backends are also an optional extra, so "absent" is the common case. | `domain/lyrics/romanize.py`, called only by `_line_doc`; `tests/test_romanize.py`, `tests/test_nonlatin_lane.py`; `core/src/lib/tv/lyrics.ts` `parseLyricsDoc`. |
| **XA-20** | **A unit rule changes what is LOOKED UP, never what is published.** A vocabulary fold (`zh-simplify`) and a romanised target sequence (`mms-roman`) decide which dictionary entries a word becomes; `Line.text`, `Word.word` and every syllable fragment stay the characters the sheet wrote, and every target carries the index of the grapheme it came from. | A romanised published text would be words nobody asked for, in a script the room did not choose — and a span that lost its grapheme would time the wrong character of the line. The unit half is stronger still: it may not change the target sequence at all. | `domain/lyrics/units.py`, `generate.char_ids` / `char_targets`; `tests/test_units.py`. |
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
| `band-off-sheet` | a document both witnesses place off the sheet it was served is demoted to `low` (§6.1) | failed arm — the READING still runs and still reaches the trail; only the demotion is off |
| `band-late-kept` | a window re-decode that opened past its claim keeps its own opening — §4's re-opening does NOT run | **control** for a default-on feature (W9 flipped `band-reopen` on and retired the name) |
| `lang-route-mix` | a Latin-script song's **mix** is timed by a per-language bundle | failed arm — and **inert alone** since §5.4; pair it with `h3-ungated-words` to measure anything |
| `ends-raw` | the end post-pass does not run | **control** for a default-on feature |
| `h3-mix-envelope` | the mix's wrong-text verdict is the envelope gate alone | **control** |
| `h3-mix-floor` | both gates on the mix (what W3 first shipped) | failed arm |
| `h3-ungated-words` | an uncalibrated bundle may publish word timings behind the envelope gate | **control**, and the only way to measure an uncalibrated bundle end to end |
| `conf-legacy` | per-line grading ignores the placement margin | **control** |
| `vendored` | every global decode runs on `domain.lyrics.viterbi` instead of torchaudio's kernel | **control** for XA-18: it must move no byte |
| `skip-arcs` | a line the skip-arc detector leaves unsung is dropped before the never-sung rule (§3.2) | research arm |
| `star-b` | the star is a graph state that may be bypassed for free, not a target that must be visited | research arm |
| `claim-priors` | the primed re-decode adds a capped-Gaussian onset bonus at each line's first state | research arm |
| `claim-fusion` | the primed re-decode reads the mix where the target is silent inside a claim window | research arm |
| `priors-decide` | **all three of the above, with the repair ladder bypassed** — the review's deciding arm | research arm |
| `nonlatin-units` | a word and a syllable are the script's own, not whitespace's (§9.1) | capability arm |
| `zh-simplify` | OpenCC `t2s` folds a Traditional character onto the simplified-only `zh-cn` vocabulary | capability arm |
| `mms-roman` | a non-Latin language times on **MMS_FA** over a romanised target sequence; implies `nonlatin-units` | capability arm — **CC-BY-NC weights** |

The W8 names are **capability** arms: they add a reading for text the default path can only publish as whole
lines, so there is no default behaviour for them to be a control over. All three are inert on a Latin
language by construction. `mms-roman` is the one arm in this table whose weights are not permissively
licensed, which is a decision for the owner and not a measurement (§9.1).

The W9 names are **research-track** arms rather than failed ones: each is built, tested and measurable, and
none has a corpus reading yet. `priors-decide` deliberately implies `claim-priors`, `claim-fusion` and
`skip-arcs`, because the review's deciding arm is the three of them together with the ladder out of the way;
measuring it under three separate names would be measuring three different arms. Any of them implies
`vendored`, which is the arms' own implementation — so `vendored` alone is the control that isolates the
swap from everything the graph does. Where two star arms are set, `star-b` wins, both needing the same
column.

A control exists because a default-on change must be A/B-able and the arm switch is the only thing the
bench can move without editing code. Each arm's numbers live where it is read — the constant, the module,
or the README section named in §13 — and `host/config.py` is the index.

§4's re-opening was measured WITH its free-time guard over the 182 cases that hold every move it makes: it
keeps 36 of the 56 line moves it made unguarded, gains 15 lines at ±500 and loses none, and its two rejecting
gate rules pass there (README, "W8a round 1: the `band-reopen` arm, re-read with the free-time guard"). W8a
left it off because the absolute gates cannot be read on a 14-song selection; W9 read them on the full corpus
and the owner took the trade, so the rule is the default and `band-late-kept` is what stands it down. The four
waived Jamendo `jit` words are named in `gates/w8b-arms.yaml` §2 and in README, "W9: `band-reopen` flipped
default-on, and the four words the owner waived".

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

## 17. What the regression fixtures measure

The suite's fixtures are not arbitrary shapes. Nearly every one was cut from a failure that was measured, and
the numbers it encodes are the reason it has the shape it has — which is why a fixture that looks
over-specified usually is not. Those measurements used to sit in the test docstrings; they live here now, and
each test keeps one line saying what it pins. `worker/tests/` is the index: the subsection names the file.

### 17.1 Repair windows (`tests/test_align_provenance.py`)

- **A sub-second dispute must not send R2 to re-decode on a stem that lost the line** (review M4). On repro
  s6's own sheet the blind verdict is STRUCTURAL, and rightly so — the stem lost line 5, so the blind decode
  put it more than a phrase from its claim. R4 then finds it on the mix where it is sung, 0.4 s from the
  claim, and the re-reconcile R2 reads is COARSE, so R2 never runs and the mix's measurement stands. Before
  W2 the re-reconcile read STRUCTURAL as well — any agreement under 1.0 did — and R2 re-decoded line 5 on the
  silent stem and adopted the jittered claim: **25.90 s for a line sung at 25.50 s**.
- **A truncated cue is re-decoded in a window wide enough to hold the line** (review M5). When our own decode
  has scattered, the claims become R1's anchors and every claimed line is re-decoded inside its claim window,
  including the ones the blind decode already had right — the closing line among them, and its cue has no
  end. Cut to `start + 1.0 s` the window is 3 s including both pads, against a line that takes 3 s to sing:
  the forced path compresses it, `adopt_where_unheard` reads the poor score as "heard nothing", and the
  claim's one-second span replaces a correct measurement with six words spread over a third of the line —
  measured on that fixture with the hold-open removed, **40.00-41.00 s against 40.00-43.00 sung**. Held open
  to the end of the blind decode's own span for the line, the window holds it.
- **The last cue is capped on the sheet's own pacing, not left open to the audio's end** (W2 review r2).
  `parse_lrc` gives an LRC's last line no `end` and the reader defaults it to `start + 1.0 s`, so the
  hold-open fires on the final cue of every sheet there is. What that cue can swallow is not a following LINE
  but an unstamped outro repeat of its own words. Uncapped, a fixture singing its last line at 50-53 s and
  again at 70-73 s bought a window of (49.6, 78.7) — **29 s against the 4 s every capped cue gets** — and the
  forced re-decode inside it landed on the repeat, publishing the line at **69.96 s, 20 s late**. The sheet's
  own `typical_slot` (the median gap between its onsets, 10.0 s there) stands in for the missing onset, so
  the window is (49.6, 61.6) and the repeat is outside it. The true occurrence is sung weakly (0.45 against
  the fixture's 0.9) because that is what makes the uncapped window's failure visible: with both occurrences
  at full strength an exact Viterbi prefers the earlier one and the 29 s window looks harmless.

### 17.2 The v2 remap, the width floor and the repeat rungs (`tests/test_align_v2.py`)

- **A pull can never move a word start earlier**, which is why `_pulled_end` needs no order guard where an
  affine re-fit carried one (measured at 0 firings). The shape: the line two back is a trusted line whose
  overlap is a measurement and already reaches past its neighbour's start, and the neighbour has leading
  silence. `remapped` would slide the neighbour's first word from 4.0 back to **3.05**, BEFORE `swallowing`'s
  last word at 3.5 — a new inversion, and `policy.decide` drops the whole text to line sync over one.
  `trimmed` keeps it at 4.0.
- **A repaired line's width floor is a re-fit floor, and the pull outranks it** (W6 review r2-correctness-4).
  Two repairs 0.1 s apart cannot both be `_REPAIRED_MIN_SEC` wide without overlapping, so the floor is
  unsatisfiable and the pull wins. That is the right way round: the start is what grading and every line
  metric read, and the alternative pushes line [1] to **10.2** — the smeared-end failure the bounded floor
  exists to end. What bounds the published width instead is `_pulled_end`'s frame per letter.
- **R3 re-decodes a misplaced blind repeat inside its anchor gap.** No claim says which chorus is which, so
  the unique neighbours around it bound the window. Delete R3 (mutation, measured) and the line publishes at
  **18.34 s instead of 21.96 s**. An exact Viterbi reproduces its own global path between its own anchors, so
  the misplacement is made the only honest way: the global pass hears the second chorus at 18.4 s.
- **The near-repeat arm** turns the rig's last line into a near repeat of line [0] — `difflib` **0.89**, so
  `margin.fuzzy_repeats` flags it while `normalized.count(text) > 1` (R3's exact rule, which already grades
  both copies `low`) does not. One CHARACTER, not one word, so the line's own score stays inside `low_lines`'
  score half: a sheet whose near-repeat was also its worst-scoring line could not tell the arm from that half.

### 17.3 The claim clock's two floors (`tests/test_claimmap.py`)

- **The offset estimator is a MEDIAN, and that is load-bearing** (W2 review r1). A 40-line sheet 1.5 s late
  with two stamps 60 s wrong is the ordinary LRC defect (stacked timestamps, a trailing credit cue, review
  L4): the median offset is +1.50 and explains 38 of the 40 lines, while the MEAN of the same residuals is
  **+4.50** and explains none of them — so a mean would lose the vote and leave the sheet 1.5 s late, which
  is repro s8. Without this case the swap passes the suite.
- **`MIN_INLIER_SHARE` is the absolute-quality floor the margin cannot supply.** Against a correctly timed
  sheet and a blind decode that is poor and systematically late (never-be-alone's measured shape), every
  candidate explains almost nothing, so no-shift explains nothing either and the margin — a DIFFERENCE — is
  cleared by any candidate that finds two lines. The winner would have moved a correct sheet by +1.96 s on
  the strength of 9 of 47 paired lines (**0.191**, under the floor), and `reconcile` would not have noticed:
  it re-fits its own median, so the verdict stays UNRELATED either way. It is also what bounds the mode
  candidates (W4 review r1) — `_densest_offset` maximises an inlier count over every window, so on
  differences with no mode the luckiest 0.5 s slice holds 16 of the 47 and would clear this floor outright.
  The isolation test in `_densest_offset` is what refuses it.

### 17.4 Reconcile's classes, as a distribution (`tests/test_reconcile.py`)

A +/-1.5 s LRC with 150 ms jitter read STRUCTURAL about 98% of the time before M4, so the caller's R2
re-decoded every line the jitter pushed past 250 ms — the repair Numb measured as harmful (MAD 312 -> 563 ms).
Measured on this tree over 2 000 seeded 40-line draws: **1 463 OFFSET, 535 COARSE, 2 DRIFT, no STRUCTURAL**,
and 0 disputed lines out of 80 000 against roughly one line in ten before. Mean residual MAD **0.099 s**, the
jitter drawn. Every draw still CORROBORATES — the sheet is good evidence, it is just late — so nothing is lost
but the repairs.

### 17.5 The margin's backward pass (`tests/test_margin.py`)

`window.fill(-np.inf)` between the forward and backward passes is the guard that stops the backward pass
reading the forward pass's last two alpha values as "there is no state s+1 / s+2". Deleting it left
`test_margin`, `test_align_v2`, `test_generate`, `test_repair_order`, `test_bench_e2e`, `test_align_steps`,
`test_lexical` and `test_lexical_gate` all green — **450 passed, byte-identical to baseline**. The
contamination enters at `window[states]` / `window[states + 1]`, so it reaches `beta[states - 2]` first and
the queried column has to BE `states - 2` to see it, which happens only when the last line's first character
is also the sequence's last target. Hence the case `(["deal", "a"], 18)`: with the guard removed it reads
**12.10 nats against the reference's 13.01** at reach 7, i.e. a line that crosses the 10-nat floor the wrong
way. One `default_rng` per case for the same reason — a case appended to a shared stream gets whatever matrix
the cases before it left, so re-ordering the list would silently re-draw this one.

### 17.6 The star column (`tests/test_star.py`)

`frame max - P` per frame, and nothing else about the matrix changes. Per frame is the whole point: a
log-probability only means something against the rest of its own frame, so a flat frame's star comes down with
it while a confidently sung frame's star sits P nats under a character the path wants anyway. A CONSTANT star
(MMS's `log p = 0`) was measured over-eager — **all-corpus +/-250 67.9 -> 64.0** — which is the comparison
this arithmetic exists to avoid.

Two of that file's tests are about **P itself**, and the ladder they walk is the fixture's own cliff. Over the
three-line fixture whose text holds the last two lines, the frames the forced path spends on a star read
**156** at `P = 0`, **89** (the uncovered intro is 90 frames) at every value from 0.05 to 1.0, and **2** at
2 nats and above — where the star is too dear to enter and the text is dragged **2.21 s** back onto the intro.
So the assertion is monotonicity plus "the shipped P is on the absorbing side", which holds across the whole
fitted region and fails at the band review item 10 proposed. On a fixture the text fully COVERS, the shipped P
leaves each star the single frame the topology forces (**3** for 3 lines) while `P = 0` takes **71** — the
over-eager constant, in one song, at the granularity a unit test can see.

### 17.7 The TV boundary a hair past a word start (`tests/test_generate.py`)

With 19.999 as the anchor, the three words after it were published at **19.99920 / 19.99945 / 19.99980** —
four words inside 0.8 ms, none of them liftable by the TV (`start <= pos < end`) and none within a decoder
frame of a measurement. `trimmed` walks the anchor back to the last word whose tail can hold one frame per
word still to be placed rather than collapsing the tail into a millisecond (W6 review r2-spec-9).

### 17.8 Noted-line shares (`tests/test_nonlyric.py`, `tests/test_align_steps.py`)

`nonlyric.R3` fires on a text whose sung lines were wrapped in music notes by whoever typed it, and its
precondition is the noted SHARE of the worded population read off the whole paste. The eight noted bench songs
read **0.8514** (hello, 63/74), **0.8649**, **0.8784**, **0.9420**, **0.9670**, **0.9714**, **0.9954** and
**1.0000** on `clean_line`'s worded population, and every one of them is still a noted track at the 0.8 floor.
The paste fixture is nine noted lines of eleven worded ones (**0.818**), so it is over `NOTED_SHARE` and R3
really is the rule being switched off when a test asks for `author_marking=False`; a second fixture sits at
**0.750**, just under the floor — the shape a track one unnoted line away from firing has.

### 17.9 Line separation, and the one float that may not be rounded

- `dragged()` asks how much a boundary also SOUNDS LIKE the next line's first letter — a held vowel or a
  breath across the gap. The fixture reads log 0.5 there, against the sung letter's 0.9 and silence's
  **0.0037** (`tests/test_linesep.py`).
- The word-end post-pass compares times with `approx` wherever an end was EXTENDED and exactly wherever it was
  not: an extended end is a multiple of the 20 ms frame, and `115 * 0.02` is **2.3000000000000003**. The
  identity cases are the ones that must hold bit for bit, because "nothing moved" is what the trail note and
  the bench's onset digest both claim, and it is the reject-if this whole post-pass was built under
  (`tests/test_ends.py`, §10).

### 17.10 The vendored graph (`tests/test_viterbi.py`, `tests/test_ml_contract.py`)

- **Bit-compatibility is asserted twice, on the same 80 cases**: real windows of a sung matrix, flat
  evidence, and random log-softmax rows. `tests/test_viterbi.py` runs them against the suite's numpy
  fixture with no torch installed; `tests/test_ml_contract.py` runs them against
  `torchaudio.functional.forced_align` itself (XA-18). The flat and random cases are what pin the
  TIE-BREAKING, which is where an equally scored but different path would publish different timings.
- **The star's superset property is a test, not a comment**: at `P = 1e6` the starred graph's label stream is
  the plain decode's, and at every `P` its path score is at or above the plain decode's. Read on TWO
  fixtures, because the one whose intro is silence cannot see the frame-0 case: `FROM_FRAME_ZERO` sings on
  frame 0, which is where the property used to fail.
- **The prior is tested on a FLAT matrix**, which is the exactly-ambiguous case: every path scores the same,
  so the prior is the only thing in the graph that can choose, and what it chooses is the claim to within one
  frame. The non-ambiguous half is the other test — a claim outside `ONSET_REACH_SEC`, and a 100-nat peak at
  the right place, both leave a decided placement alone.
- **The arc price is read at the fixture's scale, and the shipped pair's arithmetic separately.** A wrong
  frame on a synthetic matrix costs 5.6 nats against a real one's tens, so the skip tests price the arc for
  the evidence they hand it; `SKIP_LINE_NATS` and `SKIP_CHAR_NATS` are pinned in their own test.
