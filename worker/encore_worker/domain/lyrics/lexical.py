"""Are THESE WORDS what is sung here — not merely something sung in the right places?

WHY THIS EXISTS. Every other gate on this worker reads WHERE the singing is: the envelope gates fit a
text's spans, claimed or decoded, to the audio's vocal activity. None reads WHAT is sung, and two holes
followed. A same-video caption track (an uploader's translation, YouTube's machine-translated `en` track) fits
the singing by construction whatever its words, so the LINE_SYNC rung's sheet-span gate passed it (W1 review
r2). And the global engine's envelope gate scores OUR OWN forced decode, which the audio pulls onto the voiced
frames whatever the text is (review H3): at W1 it passed 152/320 bench wrong texts and 280/320 same-video
wrong words (`wrongtext+ownclock`), every one published with word timings.

THE TEST (review §3 item 4's self-normalised GOP, Witt & Young 2000): the text's forced-path log-probability
on the emission matrix against the same text with its WORDS SHUFFLED, per letter. A shuffle has the same
letters, the same length and the same alphabet, so the model's scale, the song's difficulty and the language
cancel out, and so does the text-free best path the review's Δ subtracts (an identical term on both sides,
since the letter count and the frames are the same): what is left is how much better THIS ORDER of these
words explains the audio than an arbitrary order of them. Sung words in their sung order explain it far
better; words that are not sung explain it no better in any order — EXCEPT words whose LETTERS are the sung
ones in the sung order, the hole this test does not close (NOT COVERED below: a cognate translation). The
best of `SHUFFLES` draws is the reference, so one lucky shuffle cannot flatter a wrong text.

ONE TABLE, KEYED BY THE MODEL (`CALIBRATED`, read by `calibration`; W4b). Every number below is an EMISSION
SCALE's, so each belongs to the bundle it was measured on and to no other: `CALIBRATED` maps a model identity
(`adapters.ml.Emissions.model`) to its own row — THREE of them, the shipped default's (the base model,
`adapters.ml.DEFAULT_ALIGN_MODEL`, which `BANDS` names) and the two HuBERT bundles an operator can reach by
name (W4b 6b, their own section below) — and a model with NO
ROW is not gated on anybody else's numbers — `calibration` returns None, `align_steps._measured_lift` reads
that as an unmeasurable lift, the envelope gate keeps the verdict and the text is not vouched for (EXEMPT
below). That is the runtime half of "fail loudly or refuse to gate"; the loud half is the operator
knob that NAMES a model (W4b 6b's `ENCORE_ALIGN_MODEL`): `__main__.align_model_for` refuses a name
`is_calibrated` says no to before the worker accepts a job, rather than starting one whose gates silently stop
gating. THE ROW HOLDS EVERY
EMISSION-SCALE THRESHOLD OF ONE MODEL, not just the lift's: the LINE_SYNC rung's decode-agreement share reads
that model's own decode spread (`line_sync_min_agreement`), so it moves with the bands or not at all. It does
NOT hold a second copy of the rung's lexical floor — the rung calls `band(..., on_stem=True)`, so
`refuse_below` IS `_LINE_SYNC_MIN_LIFT`, and the duplicate W3 review r1 removed must not come back (W2's rule:
one literal per idea). THE ONE THING A MISSING ROW DOES NOT SWITCH OFF is that same share: it is a fraction of
lines within a tolerance in SECONDS rather than a log-probability, so it survives a model swap where nothing
else here does (`LINE_SYNC_SHARE_UNCALIBRATED`, read through `line_sync_share`).

THE BASE MODEL'S BANDS (`BANDS`, read by `band` when nothing names a model; W3 — and, after W4b's corpus
sweep rejected the HuBERT-Large flip as a default, this is the SHIPPED default's row again as well:
`adapters.ml.DEFAULT_ALIGN_MODEL`. HuBERT-Large's section still follows this one, because
`ENCORE_ALIGN_MODEL=HUBERT_ASR_LARGE` still resolves and must still gate on its own scale).
CALIBRATED ON THE SHIPPED DECODE
(`adapters.ml.forced_align_decoder`,
no `|`, torchaudio's kernel — the review's prototype numbers were on its `|` + numba "lsep" decode) with
whisperx's `en` default, WAV2VEC2_ASR_BASE_960H, by `docs/benchmarks/forced-alignment/scripts/lift_gate.py`
(`--target stem`, `--target mix`; rows in `results/w3-lift-{stem,mix}.json`, each naming the bundle it was
measured on — `BANDS.model`, held to it by a test — so a later model's rows cannot be read as these):
32 songs x (6 right texts —
truth, which every timing-only mode also serves, headers, credit, extraverse, drop20, drop50 — + 10 wrong
texts + 10 same-video wrong words) = 832 texts per target, served as the text adapters serve them
(`clean_segments`). None is under `MIN_LETTERS` (the shortest holds 201 letters).

RE-READ ON W4's EXACT 20 ms CLOCK (W4 review r1). Every lift is measured on an emission matrix, and 6a
changed every matrix, so the whole recipe was re-run on the shipped tree and these are ITS rows
(`results/w4-lift-{stem,mix}.json`, replayable with `lift_gate.py --from`; W3's are kept beside them as
`w3-lift-*`). The bands did not have to move — each stayed the same multiple of 0.05 — but the MARGINS did,
and the stem floor's head-room below the wrong population is now 0.0082 rather than 0.011, so the sentence
that calls it "a hair" is if anything more true. Both facts are named at each threshold below.

  STEM (a vocals stem is the target; the lift is THE wrong-text gate):
    right texts   Jamendo min +0.350 (Avercage headers; drop50 +0.264), YouTube + tfr min +0.348
                  (never-be-alone extraverse; drop50 +0.368); truth +0.45..+4.33, median +2.27
    wrong texts   Jamendo max +0.192 (Lower_Loveday x tfr-mayday; Cortez x The.madpix.project +0.187 behind
                  it), YouTube + tfr max +0.124 (wrongtext -0.18..+0.19, median -0.02; same-video wrong
                  words -0.24..+0.18, median -0.02)
    held out      tau fitted on Jamendo (the midpoint of its gap, +0.271) refuses 0/60 protected right texts
                  and 0/12 drop50 on YouTube + tfr and passes 0/240 wrong; fitted on YouTube + tfr (+0.236),
                  0/100, 0/20 and 0/400 on Jamendo.
    `refuse_below` 0.2: the pooled gap's midpoint (+0.228) rounded down to the 0.05 grid, so the margin is
                  the right texts' (the lowest, a drop50, keeps +0.064) while the highest wrong text sits
                  0.0082 BELOW the floor — a hair, and on the scale REDRAW NOISE (below) moves a text by.
                  The doubt band above the floor is NOT that margin: a doubt-band text publishes. What the
                  band withholds is the text's STANDING — every line `low`, the document `medium` and
                  `vouched: false` on the wire, so core's `isAuthoritativeText` is false and a document
                  a gate passed outranks it (W3 review r1) — which is what a wrong text landing just over
                  the floor costs. WHOSE document that rival is, exactly (W3 review r2): a doubted word
                  document is
                  `usable`, so `policy.decide` ACCEPTS it, the search commits and `workflows.align`
                  publishes and returns — the candidate texts still unturned are never timed, so this
                  wave's ladder produces no rival row to lose to. The demotion bites ACROSS JOBS, which is
                  where the threat lives: an earlier align's stored candidate, or the re-run a person
                  triggers after seeing wrong words, outranks it, and core's never-regress keeps the
                  doubted text from displacing what is already shown. On a song's FIRST align it is the
                  only candidate, so it is shown — `low` everywhere, with the trail's reason.
                  The LINE_SYNC rung reads THIS number over the same populations (W1 review r2):
                  `align_steps._time_line_sync` calls `band`, so one recalibration moves both gates.
    `ok_from`     0.3: at or above it neither split's own fit would refuse the text. The band [0.2, 0.3)
                  holds 2 right texts (Avercage and numb drop50, 0 `high` lines at W1) and no wrong one.
                  Wider costs right documents their grades and buys nothing: at 0.6 (the review's) it held
                  29 W1 right cases whose 192 `high` lines were 96% within 0.5 s — better than the 7.1% bad
                  rate of every `high` line — because low-lift stems (Avercage +0.47, never-be-alone +0.53)
                  are graded down by the claims already.
    WHY THE LIFT REPLACES THE ENVELOPE GATE ON A STEM, measured case by case over the W1 time_text bench
    (1088 cases; their outcome IS the envelope gate's), at tau 0.2, on `lift_gate.py`'s lifts — i.e. on the
    CLEANED texts production serves (`clean_segments`), which is also what the bench's `run_align` level
    serves:
      envelope alone   right refused 8/448 (2 protected: rap-god drop20, never-be-alone credit; 6 drop50),
                       wrong passed 152/320 + 280/320
      lift alone       right refused 0/448, wrong passed 0/320 + 0/320
      both required    right refused 8/448 (the envelope's), wrong passed 0 + 0
      either enough    right refused 0/448, wrong passed 152 + 280
    Only "lift alone" meets review §3.4's reject-if (no right text on a stem refused, including <= 20%
    missing lines; <= 1% of wrong texts passed), so on a stem the envelope fit is reported, not gated,
    wherever the lift measured the text.
    THE TABLE'S POPULATION IS THE CLEANED ONE, and `letters_of` counts every letter it is handed: on the
    bench's `time_text` level, which serves a provider's RAW claims (`♪`, credit lines, the lines
    `clean_segments` drops), 230 of the 832 texts move by up to +-0.15 (`_runs/w3-rejudge/raw_lifts.py`), and
    ONE wrong text crosses the floor — LUNABLIND #2 at +0.217 raw against +0.189 cleaned. So the shipped
    `time_text` level publishes 1/320 `wrongtext` (a doubt-band document: every line `low`, ranked under a
    vouched document) where `run_align` publishes 0/320. EACH LEVEL'S COUNT IS CAPPED AT THE LEVEL IT WAS
    MEASURED ON (W3 review r2): `gates/w3.yaml` holds the shared 1/320 (its literal is `time_text`'s, so at
    `run_align` a regression from 0 to 1 would have cleared it), and `gates/w3-run_align.yaml` holds
    `run_align`'s own 0 absolutely. So a second wrong text cannot start publishing unnamed at either level.

  MIX (no stem): the lift's FLOOR is the wrong-text gate here too, as it is on a stem (W4 review r1 flipped
  it; W3 shipped the envelope gate in this role and the stemless bench mode measured both).
    the populations OVERLAP: right texts -0.045..+2.85 (truth median +0.66; 24/192 below 0), wrong texts
    max +0.102 (Jamendo: Tom_Orlando x Lower_Loveday) / +0.115 (YouTube + tfr: shape-of-you x numb). A right
    text lifting little on the mix is USUALLY one the mix's matrix barely hears: truth texts under 0.15 —
    numb, Pure_Mids, Avercage, The_Rinn, feel-my-heart, Kinematic, Moon_I_Mean — decode blind with 0-70% of
    lines within 1 s (median 24%; 172/237 lines over 2 s off), and 0 wrong text lifts that far, so no midpoint
    exists and the floor sits above both splits' wrong maxima.
    `mix_floor`   0.15 (review: ~0.1): the smallest 0.05 step above +0.102 and +0.115, with 0.035 of
                  head-room over the higher of them. Jamendo's own maximum passes 1/120 wrong texts held out
                  on YouTube + tfr; YouTube's (+0.115) would pass 0/400 on Jamendo. At 0.10 the floor alone
                  passes 2/320 wrongtext and 0/320 same-video wrong words.
                  AND IT IS A VERDICT (W4 review r1). W3 left it grading only, because its cost lands on the
                  only songs it can reach — no vocals stem, so every text of that song faces this matrix, and
                  a refusal there is terminal (`policy.decide` rule 0 answers `Refused` with NextText, and
                  the LINE_SYNC rung declines a stemless song). That cost is real and is confirmed on the
                  corpus: 54 of the 192 right texts lift below the floor — 41 of the 160 protected ones and
                  7 of the 32 TRUTH texts (numb -0.045, Avercage -0.012, The_Rinn -0.010, Pure_Mids +0.027,
                  feel-my-heart +0.038, Color_Out +0.117, Moon_I_Mean +0.127) — and "the matrix barely hears
                  it" does not hold case by case (Moon_I_Mean's truth text lifts +0.127 with 69.8% of its
                  blind lines within 1 s).
                  WHAT DECIDED IT is that the alternative costs MORE of the same thing, measured end to end
                  by W4's stemless bench mode (`e2e.py --no-stem`, 32 songs x truth/blind/drop20/drop50 + 2
                  wrong donors per song, 192 cases per arm; `gates/w4-stemless.yaml`, README's "The stemless
                  mode"). The envelope gate refuses 51 of the 128 right-text cases against the floor's 37,
                  10 of the 32 truth texts against 7, and 9 of its refusals lift at or above the floor
                  (Tom_Orlando +1.465, Rxbyn +1.081, Ridgway +1.061, tfr-mayday +0.943, HILA +0.872 ...) —
                  and IT ADMITS 27 OF 64 WRONG TEXTS, 42.2% where review §3.4 allows 1% — THIS MODULE OWNS
                  THAT FIGURE and every other site defers to it, because it was re-measured in place: the
                  pre-r1 recording of the same configuration admitted 26 (40.6%), and the re-record under the
                  post-flip name added `Kinematic_-_Peyote` under The.madpix.project's sheet (lift -0.0056,
                  a text the floor refuses and whose envelope fit clears the gate). Meanwhile it publishes
                  the four worst right-text documents it has (The_Rinn at lift -0.010: 2 of 46 lines within
                  ±500 ms with 44 gross). The floor publishes 91 of the 128 to its 77, 53.5% of their line
                  starts within ±500 ms to 42.3%, the same gross count (851 vs 853) and 0 of 64 wrong texts.
                  So it is not a choice between a strict gate and a lenient one — the envelope gate is both
                  stricter on right texts and looser on wrong ones — and the mix now follows the stem's rule.
                  THE OLD BEHAVIOUR IS THE CONTROL ARM `h3-mix-envelope` (`Config.align_experiments`): the
                  envelope gate is the mix's only verdict and this floor merely grades, and THE ROW IT WAS
                  RECORDED ON IS `results/w4-stemless-envelope-time_text.json` (the shipped default's own row
                  is `results/w4-stemless-time_text.json`; both on code `8c576cc6200b02a0`, W4 rebench r2).
                  `h3-mix-floor` still means BOTH gates — W3's first shipping, and what setting both arm
                  names means — and it publishes 54 of the 128, the two costs paid together.
    `mix_ok_from` 0.6 (the review's band top): on the mix the lift reads how well the words are HEARD. The
                  8 truth texts in [0.15, 0.6) decode blind with a median 55% of lines within 1 s and
                  140/343 lines over 2 s off (never-be-alone 11% within 1 s, Lower_Loveday 27%), the 17 at
                  or above it 81% and 149/1166 (`lift_gate.py`'s per-band table), so their lines are
                  `low`. (On a stem the same reading does not hold: the doubt band's right texts are
                  graded down by their claims already, see `ok_from`.)
                  A GRADING THRESHOLD ONLY: this band does NOT withhold the text's standing (W3 review r2).
                  It was fitted to how audible the words are, not to whether they are the right ones, and
                  on the mix it holds most of the RIGHT texts — 108 of the 192 lift under 0.6 (54 under
                  `mix_floor`, 54 in [0.15, 0.6)), and 15 of the 32 TRUTH texts (7 and 8). Sending
                  `vouched=False`
                  with it would withhold the standing of over half the correct provider sheets of every
                  stemless song, so `isAuthoritativeText` would be false and `lyricsRank` 3 — and
                  any authoritative LINE document of an earlier job (rank 4) would displace a correct
                  word-timed sheet. What the WORDS' axis reads on the mix is the floor decision only
                  (`mix_floor`: above every wrong text's lift on both splits), so a sub-floor mix text
                  publishes UNVOUCHED and a doubt-band one publishes vouched with its lines `low`
                  (`align_steps._time_text_global`).
    WHY THE ENVELOPE GATE IS NO LONGER THE MIX'S VERDICT, on the same rows (the W4 ones, re-read in W4b
    review r1 — the counts here were still W3's): its blind half passes 125/320
    wrongtext and 126/320 same-video wrong words, and on truth texts it passes decodes the matrix never heard
    (The_Rinn: lift -0.010, 2/46 lines within 1 s, r 0.44 at -0.04 s; Lower_Loveday 35%) and refuses ones it
    did (Rxbyn +1.081, 93% within 1 s; Tom_Orlando 86%; HILA 79%) — it is ANTI-CORRELATED with the document,
    not merely weak. With
    the floor, blind envelope AND lift refuses 122/192 right texts, the floor alone 54/192, both passing
    0/640 wrong texts. W3 kept it anyway because that was the blind half only (the shipped gate also passes a
    REPAIRED fit, which only claims can move) and the bench had no stemless mode to measure either gate whole.
    It has one now and the whole gate sorts no better (51 of 128 right texts refused, 27 of 64 wrong passed,
    with truth claims to repair the fit), so it is reported and not gated here — exactly as on a stem —
    wherever the lift measured the text. It is still the ONLY gate where the lift could not measure one at
    all (`align_steps._word_lift`: the ASR tier, a text under `MIN_LETTERS`, a decode that raised, a matrix
    from another model), because "none doubted it" must not read as "one passed it".

HuBERT-LARGE IS THE SECOND ROW, REACHABLE BY NAME AND NOT THE DEFAULT (W4b 6b, review §3 item 6b,
2026-09-30; the corpus sweep rejected the flip — `gates/w4b.yaml` 19/30, `gates/w4b-hubert.yaml` 20/22 — so
`ml.DEFAULT_ALIGN_MODEL` is the base bundle and `ml.ALIGN_MODELS_BY_DEVICE` is empty, and this row is what
gates a job an operator set `ENCORE_ALIGN_MODEL=HUBERT_ASR_LARGE` on).
The English bundle is a setting now (`ENCORE_ALIGN_MODEL`, per-device mechanism in
`adapters.ml.ALIGN_MODELS_BY_DEVICE`), and a
model swap moves every number above, so the WHOLE recipe was re-run on it: the same 832 texts per target, the
same shipped decoder, the same 32 songs, `lift_gate.py --model HUBERT_ASR_LARGE --target stem|mix` (rows in
`results/w4b-lift-{stem,mix}-hubert-large.json`) and `line_gate.py --model HUBERT_ASR_LARGE --tau 0.45` (1056
cases, `results/w4b-line-gate-hubert-large.json`). THE POPULATIONS SEPARATE FAR BETTER THAN THE BASE MODEL'S,
which is the one thing this wave could not assume — W4 left the base row's stem head-room at +0.0082, thin
enough that a scale shift could have closed it:

  STEM   right texts (protected + drop50) min **+0.766** (Avercage drop50; truth +1.132..+5.649, median
         +3.832), wrong texts max **+0.219** (tfr-chosen `wrongtext+ownclock` #1; wrongtext max +0.199) — a
         GAP OF +0.547 where the base model's is +0.072, so `refuse_below` **0.45** (the midpoint +0.4927
         rounded down) clears the wrong population by **+0.2306** against the base row's +0.0082, i.e. by
         3-8 redraw SDs (REDRAW NOISE) instead of by one. Held out: tau fitted on Jamendo (+0.514) refuses
         0/60 protected and 0/12 drop50 on YouTube + tfr and passes 0/240 wrong; fitted on YouTube (+1.152,
         a split whose weakest right song is +2.085) it would refuse 5/100 — which is where `ok_from`'s rule
         had to be re-stated, below. At tau 0.45 the pooled sweep refuses 0/192 right texts and passes 0/640
         wrong; `lift alone` refuses 0/448 of the W1 `time_text` cases and passes 0/320 + 1/320 (tfr-chosen
         again, at +0.219, in the DOUBT band rather than over `ok_from`).
  MIX    the populations still overlap (right min -0.033, wrong max +0.116), so the floor is still fitted from
         above: `mix_floor` **0.15**, the same step as the base row, the smallest above both splits' wrong
         maxima (+0.1157 Jamendo, +0.1098 YouTube) with **+0.0343** of head-room, the base row's +0.0349 to
         four places. WHAT CHANGES IS ITS COST: the
         floor refuses **10 of the 192 right texts and 1 of the 32 TRUTH texts** where the base row refuses
         54 and 7 (`results/w4-lift-mix.json`, the base bundle's row of record on this tree — W3's 48 is on
         `w3-lift-mix.json` and the exact clock moved it), and the one truth text it refuses is the one the
         mix's matrix genuinely cannot hear
         (Avercage -0.005: 2% of its blind lines within 1 s, 40 of 42 more than 2 s out). On the same rows
         the blind envelope gate — what W3 shipped here and `h3-mix-envelope` restores — refuses 78 of 192
         right texts and passes 290 of 640 wrong ones, so W4 review r1's flip is not a close call on this
         model either.
         `mix_ok_from` **0.4** BY THE SAME RULE THE BASE ROW'S 0.6 FOLLOWS — where the truth texts' blind
         decodes stop being poor — WITH ITS OWN EXHIBITS, which review r2 found missing from this record
         (correctness-7a: the number was defensible and undocumented, and 0.30 or 0.35 would have fitted the
         rule as written). Sorted by lift (`results/w4b-lift-mix-hubert-large.json`, the 32 truth texts), the
         poor decodes END at never-be-alone **+0.2507** (13% of its lines within 1 s, 41 of 47 more than 2 s
         out) and the next text up is The_Rinn **+0.4231** at 76% within 1 s, 7 of 46 gross — so the split
         lies in (0.2507, 0.4231] and **0.40 is the largest 0.05 step in it**, i.e. the widest `low` band the
         measurement admits. It leaves the mix doubt band holding exactly ONE truth text, never-be-alone, the
         one this model's mix matrix really does not hear, with Avercage below the floor.
  SHARE  `line_sync_min_agreement` **0.5**, the same number as the base row and for the same reason (the
         lowest swept share showing no gross line), at a quarter of the cost: 13 of 416 right texts refused
         against the base row's 32, 0 gross lines shown, 94.8% of shown line starts within ±500 ms. 0.4 shows
         6 gross lines and 0.6 refuses 32 for nothing.

HuBERT-XLARGE HAS A ROW TOO, REACHABLE ONLY BY NAME (`ENCORE_ALIGN_MODEL=HUBERT_ASR_XLARGE`) AND NOBODY'S
DEFAULT: `ml.ALIGN_MODELS_BY_DEVICE` IS EMPTY — see its own "WHY IT IS EMPTY" block — because no CUDA box on
this tree ever ran this bundle end to end, and an unmeasured bundle is not a device class's default. The row
exists so that the operator who DOES name it gates on this model's own emission scale instead of borrowing
another's (which is this table's whole purpose), and so that a CUDA sweep has something to re-read: review 6b
measured XL best on word onsets (±100 +6.4 pts against L's +4.1, blind Jamendo gross 14 against 16) and CUDA is
the only place its 11.8-24 s/song and 3.8 GB are affordable, so that sweep is the one worth paying for.
(Until W4b review r2 this paragraph opened by calling XL the bundle a CUDA box defaults to — a decision the
wave's own bench verdict had already reverted, and it cited the now-empty table as its evidence, so a CUDA
operator reading the module the wave designates the ONE source of truth concluded their box shipped XL:
correctness-3 / spec-12. `tests/test_ml_devices.py` now holds the record to the table.)
Calibrated on the same 832 texts per target and the same 1056
rung cases (`results/w4b-lift-{stem,mix}-hubert-xlarge.json`, `results/w4b-line-gate-hubert-xlarge.json`):
`refuse_below` **0.35** (right min +0.4719, wrong max +0.2778, midpoint +0.3749 rounded down), `ok_from`
**0.5** (the step above the weakest drop50 +0.4719, under the weakest protected +0.7339), `mix_floor` **0.15**
(wrong maxima +0.1070 / +0.1479), `mix_ok_from` **0.3** (where the poor blind decodes end: never-be-alone
+0.2640 at 11% of lines within 1 s and The_Rinn +0.2237 at 52%, against Moon_I_Mean +0.3061 at 84% — AND, the
exhibit review r2 added because a rule's counterexample belongs beside it, ONE poor decode this step admits:
`Pure_Mids_-_The_Leader` +0.3109 at **30%** within 1 s, 13 of 20 lines more than 2 s out, graded OK on this row
where L's 0.40 would grade it `low`. There is no step that separates it: Slingshot_Miracle +0.3033 decodes 61%
of its lines within 1 s just below it, so 0.35 would cost a fair text to catch this one. On the mix that is a
GRADE, not a standing — the floor is the verdict, see the base row's MIX — which is why the exhibit is recorded
rather than the threshold moved), share
**0.5** (16 of 416 right texts refused, 0 gross). ITS THREE CAVEATS, measured here and NOT in the review: the
stem floor's head-room is **+0.0722**, a third of L's +0.2306 — still 9x the base row's +0.0082 and with 0 of
640 wrong texts within one redraw SD of it, but 2 within two SDs (Cortez `wrongtext` +0.278, tfr-chosen
`wrongtext+ownclock` +0.267) — and on the MIX it is materially worse than L: the same 0.15 floor refuses 25 of
192 right texts and 2 of 32 truth texts (L: 10 and 1), and its truth blind decodes are poorer on the mix
(feel-my-heart 51% of lines within 1 s against L's 68%, numb 66% against 80%, The_Rinn 52% against 76%).
AND THE MIX FLOOR'S OWN HEAD-ROOM IS **+0.0021** (W4b review r1), which is the third caveat and the one a
reader of the two above would not guess: this row's wrong-text maximum is +0.1479 (tfr-mayday `wrongtext` #6)
against the shipped 0.15, with THREE wrong texts at or above +0.1275 (+0.1479, +0.1425, +0.1275), where the
base row keeps +0.0349 and L +0.0343 with NONE above +0.12. The floor is still what the recipe fits — 0.15 is
the smallest 0.05 step above every split's wrong maximum, and 0.20 would refuse more right texts for margin
the grid cannot spend in between — but on a stemless song this floor IS the wrong-text verdict and a refusal
there is terminal (`align_steps._time_text_global`, `mix_floor_gates`), so a margin of two thousandths is the
figure to read before `ENCORE_ALIGN_MODEL=HUBERT_ASR_XLARGE` is pointed at stemless audio: it is a twentieth
of the 0.03-0.07 nats/letter one redraw of the shuffles moves a near-floor text by (REDRAW NOISE, measured on
stem texts and not re-measured here), so on this row a single redraw is enough to carry a wrong text over the
floor. A CUDA sweep that re-fits this row should re-read the mix half first. So a
CUDA box that NAMES this bundle gets the model the review measured best on ONSETS while paying a thinner
wrong-text margin and a weaker stemless path; a CUDA box that names nothing gets the base bundle, like every
other box (`ml.ALIGN_MODELS_BY_DEVICE`, `ml.DEFAULT_ALIGN_MODEL`). NOTHING IN THIS WAVE RAN IT ON CUDA (no such
box), and its accuracy claim is the review's, not this corpus's — the bench runner's sweep is what confirms or
refuses it (`gates/w4b-hubert.yaml` is written for L against the base model).

`ok_from` **0.8** IS THE ONE NUMBER WHOSE RULE THIS RECALIBRATION HAD TO RESTATE, and the restated rule
reproduces the base row exactly (`lift_gate.fitted`). It used to be "the higher of the two splits' own fits,
rounded up", which on the base model happens to be 0.30; on HuBERT-L the YouTube split fits +1.152 because
that split holds no weak right song, and rounding it up would put FIVE protected right texts of one song
(Avercage: truth +1.132, headers +1.028, credit +1.045, extraverse +0.828, drop20 +1.084) in the doubt band —
`low` lines, `medium` document and, on a stem, UNVOUCHED — for a song the base row grades OK, while buying
nothing, since no wrong text on either split reaches +0.22. The rule is now what the band is FOR: the smallest
grid step ABOVE the weakest drop50 and never above the weakest PROTECTED right text, so the band holds the
right texts review §3.4 does not protect (here Avercage's drop50 at +0.766; the base row's holds Avercage's
and numb's) and covers the region above the floor a wrong text could actually reach.

NOT COVERED (measured, and the reason this gate is a floor and not a proof): A TRANSLATION WHOSE WORDS SHARE
THE SUNG ONES' LETTERS IN ORDER. The test contrasts an order of THESE letters with other orders of the same
letters, so a cognate-heavy translation of the sung line keeps much of the sung letter sequence and lifts
like a right text: on the CTC fixture a German cognate text lifts +1.98 where a French text of the same
lines reads -0.12 and the sung words read +15.2 (`tests/test_lexical.py`, `tests/test_lexical_gate.py`). No
band separates that, on either target. It matters MOST on the global path, which this module's `BANDS` gate:
a cognate translation landing in `OK` publishes a WORD document with `high` lines, where the same text
through the LINE_SYNC rung publishes lines graded `low` (`align_steps._time_line_sync`). The corpus holds no
real translation to measure it on (every caption track is `en`, and JamendoLyrics MultiLang gives each song
ONE language), so `wrongtext+ownclock` — another song's words on this song's own clock — stands in for a
translation's arbitrary word order only, never for its letters. A defence is unbuilt; the fixture texts are
the tests to turn around when one lands.

REDRAW NOISE (measured, `_runs/w3-rejudge/seed_probe.py`: the 16 near-floor stem texts x 60 random shuffles,
best-of-3 resampled). `lift` reads ONE crc32-seeded draw, and a redraw moves a text by an SD of 0.03-0.07
nats/letter — the scale of the 0.0082 the floor clears the wrong population by, against a pooled right/wrong
gap of 0.072. Per redraw ~0.6 of the 640 wrong texts would pass (P: LUNABLIND #2 44%, Cortez #1 7%, Cortez
ownclock #4 9%, every other <= 2%), i.e. ~0.1% — inside review §3.4's 1%, but not the 0 this one draw reads;
a drop50 right text would be refused with P 31% (Color_Out), 15% (numb), 5% (Avercage), and a PROTECTED
right text never (p05 >= +0.268). So the floor's guarantee is the reject-if's 1%, not zero, and what a wrong
text just over the floor costs is the doubt band's demotion (see `refuse_below`). Narrowing the estimator is
cheap and unbuilt: more `SHUFFLES`, or the MEAN of the shuffles' path scores instead of the best of three
(the best is what stops one lucky shuffle flattering a wrong text, so a mean needs its own floor). Either
moves every number in this docstring, so it belongs to a recalibration (PER MODEL) and its reject-if, not to
a live tree.

EXEMPT (the step decides, `AlignStepsImpl._word_lift` / `_measured_lift`): the ASR tier, whose words were
heard on this audio, a text the lift cannot measure (`lift` returns None), a lift whose decode raised (the
trail says so; the bench scores it an ERROR row), and A MATRIX FROM ANOTHER MODEL (below). Each keeps the
envelope gate, and NONE of them is a pass: `TimedDoc.vouched` is False for an unmeasured non-ASR text, since
"no gate doubted these words" and "no gate read them" are not the same claim (W3 review r2). A pin is
measured but never refused: refused words publish with every line `low` and `vouched: false` (a person
chose them, so the words are not judged a wrong text — but nothing vouches for them either, and core must
not read them as a claim).

ONLY ON THE MODEL THEY WERE MEASURED ON (W3 review r2; a TABLE since W4b). The emission model is chosen PER
LANGUAGE, not per wave — `adapters.ml.WhisperXAligner._aligner` calls
`whisperx.load_align_model(language_code=...)`, and this worker deliberately supports every language whisperx
tables (de/es/fr are wav2vec2-XLSR fine-tunes: another scale, another vocabulary, so another lift
distribution). Nothing in the lift reads the language, so the bands would be applied to whatever bundle the
song's language loaded. `Emissions.model` names the bundle it came from, and `calibration` answers with THAT
model's row or with None; `_measured_lift` treats None exactly as an unmeasurable lift: it stays on the trail
as a READING, the envelope gate decides, and the text is not vouched for. The rung does the same with its
share (`align_steps._time_line_sync`: no calibrated share, no decode gate, the sheet-span envelope decides) —
refusing to gate, never gating on a number fitted to another model's decode.
A matrix that names no model at all (a test's fake, a bench cache written before the field existed) is read
as `BANDS`' — the base model's, which is what those matrices were; the shipped adapter always names one, so
this is the fakes' case and not a model's.
SINCE W4b THE BUNDLE IS ALSO A SETTING (`ENCORE_ALIGN_MODEL`, a per-device default in
`adapters.ml.ALIGN_MODELS_BY_DEVICE`), which changes nothing here and one thing outside: an operator can now
name a model, so the name is checked against this table before the worker starts (`__main__.align_model_for`),
where a language's bundle can only be refused to gate.

PER MODEL AND PER TEXT NORMALISATION. Every number in the base row is that model's, measured on the texts
`clean_segments` produces. A CHANGE TO EITHER invalidates a row, and normalisation moves lifts by the same
order a model does: diffing the wave's own rows case by case — `results/w4-time_text.cases.jsonl` (a
provider's RAW claims) against `results/w4-run_align.cases.jsonl` (the same texts through `clean_segments`),
1088 keys on both sides — 302 cases move, by a median 0.022, a p90 of 0.072 and a maximum of 0.147
(Kinematic `wrongtext+ownclock` #1, -0.040 raw against +0.108 cleaned), against the 0.0082 by which
`refuse_below` clears the wrong population and the 0.064 margin the lowest right text keeps. One case
crosses the floor: LUNABLIND #2 `wrongtext`, +0.232 raw and +0.172 cleaned, which is exactly the 1/320 the
`time_text` level publishes and `run_align` does not. (W3's rows read the same shape on the old clock — 302
cases, median 0.026, max 0.153 — which is the point: the clock moves every lift and moves this diff not at
all.) So W5's text-hygiene wave (`clean.py`: anchored
section headers, rolling captions, ad-libs) owes this record the same reject-if a model change does: re-run
`lift_gate.py` for BOTH targets and re-read every threshold, or state case by case that no served text
moved. W4b's model change (HuBERT, review §3 item 6b) ADDED A ROW rather than editing this one, by exactly
this procedure, on the 0.05 grid (`lift_gate.py --model <bundle> --target stem`, then `--target mix`, which
prints the fitted row ready to paste):
`refuse_below` at the pooled gap's midpoint (protected right texts and drop50 against both wrong
populations), rounded down, with each split's own fit scored on the other; `ok_from` the smallest step above
the weakest drop50, never above the weakest protected right text (RE-STATED IN W4b, which is where the old
"higher split fit, rounded up" broke — see the HuBERT section); `mix_floor` the smallest step above both
splits' wrong maxima; `mix_ok_from` where the truth
texts' blind decodes stop being poor in the per-band table; `line_sync_min_agreement` from
`line_gate.py --model <bundle>` (the share where the gross lines start, see its field). If the stem
populations overlap on a model, no threshold meets the reject-if, and the wave says so — and ships that model
with NO ROW rather than a guessed one, which refuses to gate instead of gating wrongly. `CALIBRATED` is the
ONE place each number lives — the LINE_SYNC rung and the bench's `lift_gate.py` / `line_gate.py` read it,
none of them carries a copy — so adding a row is the whole change. A recalibration is also where a wider
`SHUFFLES` or a mean reference belongs (REDRAW NOISE): re-run `lift_gate.py` both ways and keep whichever
population separates further, since either changes the numbers the bands are read off.

DETERMINISTIC: the shuffles are drawn from a generator seeded by the text itself (crc32, never the salted
`hash()`), so a replayed step and a bench re-run measure the same thing.

PURE. The decoder is injected (production: `adapters.ml.forced_align_decoder`), and whatever it raises
propagates: this module cannot tell a kernel that refused these targets from one that is gone, and the step
that calls it can (`adapters.ports.InfraFault`).
"""

from __future__ import annotations

import random
import zlib
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from encore_worker.domain.lyrics.generate import Decoder as _Decoder
from encore_worker.domain.lyrics.generate import blank_of, excluded_of

#: THE decoder contract, imported rather than restated: `generate.Decoder` gained its `blank` argument in
#: review M9's fix, and a second copy of the shape here would have kept the lift measuring on blank 0 while
#: the decode that publishes moved (one literal per idea — W2 review r1's rule). `blank_of`, beside it, is
#: the other half of that contract and is imported for the same reason (W4 review r1), as is `excluded_of`,
#: the target filter itself (W4b).
Decoder = _Decoder

#: How many shuffles the text is contrasted with; the BEST of them is the reference. Three is a NOISY
#: estimator at the bands' scale (SD 0.03-0.07 nats/letter per redraw, module docstring REDRAW NOISE); raising
#: it narrows the spread and moves every calibrated number, so it moves with `BANDS`, never alone.
SHUFFLES = 3

#: Fewer alignable letters than this and the contrast is noise: a handful of words has few distinct
#: orders, and one of them sits wherever the decode puts it. The review's bands skip texts under ~40.
MIN_LETTERS = 40


@dataclass(frozen=True, slots=True)
class Lift:
    """How much better the text explains the audio than shuffles of its own words, in nats per letter."""

    value: float
    letters: int
    #: The text's own forced-path log-probability per letter, for the trail (not what the gate reads).
    per_letter: float

    def why(self) -> str:
        # THREE DECIMALS on the lift, not two (W3 review r2): both gates print this string beside the
        # threshold they compared it to (`align_steps`), and at two decimals a text at +0.195 read
        # "lexical lift +0.20 ..., below the lexical gate (0.2)" — the one note that makes a wrong-lyrics
        # report debuggable, contradicting itself at the boundary it is read at most. The bands are set on
        # a 0.05 grid with margins of 0.008, and the bench's `lift` field stores full precision, so the note
        # matches the precision the decision is taken on. The per-letter reading stays at two: it is
        # context (a scale), not a number anything is compared to.
        return (
            f"lexical lift {self.value:+.3f} nats/letter over {self.letters} letters "
            f"(the text {self.per_letter:.2f}/letter against the best of {SHUFFLES} shuffles of its words)"
        )


def letters_of(
    line_texts: Sequence[str], dictionary: Mapping[str, int], exclude: Collection[int] = (0,)
) -> list[int]:
    """The targets `generate` decodes `line_texts` as: every character the dictionary maps to an id that is
    not one of the matrix's non-character columns, lowercased, word by word. The SAME rule, so a lift is
    measured on the decode that publishes — which is why `exclude` is an argument and not a literal 0 (review
    M9, widened to every special in W4b): on a vocabulary whose pad is elsewhere a filter that drops id 0
    drops a LETTER, and on one where a lyric can reach the word separator a filter that keeps it scores a
    target sequence the decode does not publish. Either way the lift would be a different text's.
    `generate.excluded_of` produces the set; the default is CTC's usual blank, for a caller holding a bare
    dictionary."""
    return [
        token
        for text in line_texts
        for word in text.split()
        for ch in word.lower()
        if (token := dictionary.get(ch)) is not None and token not in exclude
    ]


def shuffles_of(line_texts: Sequence[str], count: int = SHUFFLES) -> list[list[str]]:
    """`count` copies of `line_texts` with the WORDS shuffled across the whole text, each line keeping its
    own word count — so every copy holds exactly the text's letters, on the text's own lines."""
    words = [word for text in line_texts for word in text.split()]
    rng = random.Random(zlib.crc32("\n".join(line_texts).encode("utf-8")))
    out: list[list[str]] = []
    for _ in range(count):
        drawn = list(words)
        rng.shuffle(drawn)
        lines: list[str] = []
        taken = 0
        for text in line_texts:
            n = len(text.split())
            lines.append(" ".join(drawn[taken : taken + n]))
            taken += n
        out.append(lines)
    return out


def lift(line_texts: Sequence[str], emissions: Any, *, decoder: Decoder) -> Lift | None:
    """The text's lexical lift on `emissions` (duck-typed: `log_probs`, `frames`, `dictionary`), or None when
    it cannot say: under `MIN_LETTERS` alignable letters, an empty matrix, or a text every shuffle of which
    decodes as the text itself (one word repeated; a `na na na` chant, whose word order carries no
    information to test). Whatever the decoder raises propagates (see the module docstring)."""
    # `blank_of` / `excluded_of`, NOT a second `getattr` with its own default (W4 review r1, W4b): the rule
    # that made this module import `generate.Decoder` rather than restate it — one literal per idea — applies
    # to the other halves of the same contract. A copy here would keep the GATE measuring on blank 0, or on
    # the blank alone, if the decode that publishes ever moved (as it did in W4b, when the filter widened to
    # every special the matrix names), and the lift would then be the score of a different text than the one
    # about to publish.
    blank = blank_of(emissions)
    excluded = excluded_of(emissions)
    targets = letters_of(line_texts, emissions.dictionary, excluded)
    if len(targets) < MIN_LETTERS or emissions.frames == 0:
        return None
    # A CONTRAST IS A DIFFERENT TARGET SEQUENCE, not a different line string (W3 review r2). The lines are
    # what a reader sees; `path` scores `letters_of`, which lowercases and drops every character the
    # dictionary has no id for. A shuffle whose LINES differ while its letters do not is the text itself
    # under another name — its forced path is the text's, so `best == own` and the lift is exactly 0.0,
    # which `band` reads as REFUSE. Real and reachable: `["na na na na na", "na na nana na", ...]` (40
    # alignable letters, past `MIN_LETTERS`) permutes to the same letters, and a chant, a `la la la` outro
    # or a hook-only caption track is the shape. Filtered on the targets, such a text has no contrast left
    # and `lift` says so (None: the envelope gate keeps it) instead of convicting it.
    shuffled = [
        lines
        for lines in shuffles_of(line_texts)
        if letters_of(lines, emissions.dictionary, excluded) != targets
    ]
    if not shuffled:
        return None

    def path(lines: Sequence[str]) -> float:
        targets_of = letters_of(lines, emissions.dictionary, excluded)
        _labels, scores = decoder(emissions.log_probs, targets_of, blank)
        return float(sum(scores))

    own = path(line_texts)
    best = max(path(lines) for lines in shuffled)
    return Lift(value=(own - best) / len(targets), letters=len(targets), per_letter=own / len(targets))


class Band(StrEnum):
    """What a GLOBAL word document's lift says about its text (`band`). The MEASUREMENT, not the outcome:
    what the step does with each band is its own (`align_steps._time_text_global`) — a pin is never refused,
    and on the mix `REFUSE` is published as `DOUBT` unless an arm makes it a verdict (see `mix_floor`)."""

    #: The words are not what is sung. On a stem, the text is refused (`steps.records.Refused` ends it); on
    #: the mix it publishes, and it is the one band there whose words go out unvouched (see `mix_floor`).
    REFUSE = "refuse"
    #: Every line `low` and the document `medium`, on both targets. ON A STEM its words are also UNVOUCHED
    #: (`vouched: false`, so core ranks it under a document a gate passed); on the MIX they are not — there
    #: this band reads audibility, not wrongness, and holds most of the corpus's right texts (`mix_ok_from`).
    DOUBT = "doubt"
    #: The words are sung: normal grading.
    OK = "ok"


@dataclass(frozen=True, slots=True)
class Bands:
    """ONE emission model's calibrated thresholds — the lift's bands in nats per letter, plus the LINE_SYNC
    rung's decode-agreement share, which reads the same matrix's spread (the calibration is the module
    docstring's; the table is `CALIBRATED`)."""

    #: The model they were calibrated on (`adapters.ml.Emissions.model`, the bundle name), which is also this
    #: row's key in `CALIBRATED`.
    model: str
    #: On a stem: under it, REFUSE. ALSO the LINE_SYNC rung's lexical floor, because the rung calls
    #: `band(..., on_stem=True)` — there is deliberately no second field for it (W3 review r1 removed the
    #: duplicate `_LINE_SYNC_MIN_LIFT`, and W4b did not bring it back).
    refuse_below: float
    #: On a stem: from `refuse_below` up to it, DOUBT; from it, OK.
    ok_from: float
    #: On the mix: under it, REFUSE — a verdict since W4 review r1, published as DOUBT only under the control
    #: arm `h3-mix-envelope` (it refuses 7 of the corpus's 32 truth texts, and the envelope gate it replaced
    #: refused 10 of them plus 27 of 64 wrong texts; see the docstring's MIX section).
    mix_floor: float
    #: On the mix: from `mix_floor` up to it, DOUBT; from it, OK. A GRADING threshold (how audible the words
    #: are), never the words' standing: 108 of the corpus's 192 right mix texts lift under it (docstring MIX).
    mix_ok_from: float
    #: The LINE_SYNC rung's timing gate: the share of a text's DECODED lines that must start within
    #: `align_steps._LINE_SYNC_NEAR_SEC` of their mapped claim before the rung may publish the sheet.
    #:
    #: IN THIS ROW BECAUSE IT IS AN EMISSION-SCALE NUMBER (W4b): the share is read off the model's own blind
    #: decode, so a model that places lines more tightly moves it exactly as it moves the lift's floor — the
    #: review's high-severity W3 finding (English bands applied to whatever bundle whisperx loads) is the same
    #: defect on either. Fitted by `scripts/line_gate.py --model <bundle>`; the measurement, the sweep and
    #: what it costs are at `align_steps._LINE_SYNC_NEAR_SEC`'s block, where its readers are. For the base
    #: model, 0.5 refuses 32 of the corpus's 416 right texts with 0 gross lines shown, 0.4 refuses 15 and
    #: shows 6 gross, 0.6 refuses 47 for no gross-line gain (W4 rebench r2, `results/w4-line-gate.json`).
    #:
    #: AND IT IS THE ONE NUMBER HERE A MATRIX WITH NO ROW IS STILL GATED ON — `LINE_SYNC_SHARE_UNCALIBRATED`,
    #: read through `line_sync_share`, which prefers this field wherever a row exists (W4b review r1).
    line_sync_min_agreement: float


#: EVERY CALIBRATED MODEL, keyed by `Emissions.model` — the ONE source of truth for every emission-scale
#: threshold in this worker (module docstring, ONE TABLE). A model absent from it is not gated: `calibration`
#: answers None and its readers fall back to the witnesses that read no emission scale.
#:
#: Populated by the procedure in the module docstring, one row per bundle, each row's numbers measured on
#: THAT bundle's matrices over the whole bench corpus. THREE rows since W4b 6b: the SHIPPED DEFAULT
#: (`adapters.ml.DEFAULT_ALIGN_MODEL` — the base model, which W4b's corpus sweep kept after rejecting the
#: HuBERT-Large flip) and the two HuBERT bundles that flip calibrated, which stay reachable by name
#: (`ENCORE_ALIGN_MODEL=HUBERT_ASR_LARGE|HUBERT_ASR_XLARGE`) and are what a later wave re-reads when it
#: retries the flip. Nothing was replaced; the flip's control IS the shipped row. W7's non-English
#: bundles go here too, and nowhere else. A bundle a box can DEFAULT to must have a row or that worker would
#: gate nothing (`tests/test_lexical.py` holds `ml.default_align_model` to this table).
CALIBRATED: dict[str, Bands] = {
    "WAV2VEC2_ASR_BASE_960H": Bands(
        model="WAV2VEC2_ASR_BASE_960H",
        refuse_below=0.2,
        ok_from=0.3,
        mix_floor=0.15,
        mix_ok_from=0.6,
        line_sync_min_agreement=0.5,
    ),
    "HUBERT_ASR_LARGE": Bands(
        model="HUBERT_ASR_LARGE",
        refuse_below=0.45,
        ok_from=0.8,
        mix_floor=0.15,
        mix_ok_from=0.4,
        line_sync_min_agreement=0.5,
    ),
    "HUBERT_ASR_XLARGE": Bands(
        model="HUBERT_ASR_XLARGE",
        refuse_below=0.35,
        ok_from=0.5,
        mix_floor=0.15,
        mix_ok_from=0.3,
        line_sync_min_agreement=0.5,
    ),
}

#: WHISPERX'S `en` TABLE DEFAULT, and this worker's default again after W4b's bench verdict (see the module
#: docstring for every number). Two things read it by NAME: a matrix that names NO model at all — a test's
#: fake, a bench emission cache written before `Emissions.model` existed, both of which really were this
#: model's — and the tests that pin one row's shape. DO NOT READ IT AS "the shipped row" EVEN THOUGH IT IS ONE
#: TODAY: the shipped bundle is resolved per device and per operator (`adapters.ml.default_align_model`,
#: `ENCORE_ALIGN_MODEL`) and its row is `CALIBRATED[that name]`, so a reader that means "the model these
#: frames came from" must go through `calibration(emissions)`, never through this. The two coincide now and
#: did not between W4b 6b's build and its bench.
BANDS = CALIBRATED["WAV2VEC2_ASR_BASE_960H"]

#: THE LINE_SYNC RUNG'S SHARE FOR A MATRIX WITH NO ROW (W4b review r1), and the ONE threshold a missing
#: calibration does not switch off. Everything else in `Bands` is a log-probability per letter, which is why a
#: model without a row is gated on none of it; the rung's agreement share is a FRACTION OF LINES within a
#: tolerance in SECONDS (`align_steps._LINE_SYNC_NEAR_SEC`, kept out of the table for exactly that reason), so
#: "half this text's decoded lines sit more than a second from where the sheet puts them" means the same
#: sentence on any bundle. Reading it as model-specific ANYWAY, as W4b first did, left an uncalibrated bundle
#: — W7's per-language ones — with the sheet-span envelope gate ALONE, which is the gate W3 replaced here
#: BECAUSE it passes a same-video translation at r ~ 1 (`align_steps._time_line_sync`): the wave turned the
#: rung's one wrong-sync witness off for every non-English song rather than leaving it at the value all three
#: calibrated rows independently fit.
#: WHY THIS VALUE: it is what `line_gate.py`'s sweep fits on each of the three (the lowest swept share showing
#: no gross line — base 32/416 right texts refused, HuBERT-L 13/416, HuBERT-XL 16/416, 0 gross on all three),
#: which is the measured case for reading it as model-independent. A row that fits its own share still wins,
#: since `line_sync_share` prefers the row; this is the floor under a model nobody has measured, and a
#: recalibration that ever fits something OTHER than 0.5 is the signal to re-read this one.
LINE_SYNC_SHARE_UNCALIBRATED = 0.5


def line_sync_share(bands: Bands | None) -> float:
    """The LINE_SYNC rung's decode-agreement share for a matrix whose calibration is `bands`: that model's own
    (`Bands.line_sync_min_agreement`) where it has a row, and `LINE_SYNC_SHARE_UNCALIBRATED` where it has
    none.

    The asymmetry with `calibration` returning None is deliberate and is the point of the constant: a missing
    row means "do not judge this matrix's LOG-PROBABILITIES by another model's", not "publish a sheet no
    witness read" (see `LINE_SYNC_SHARE_UNCALIBRATED`).
    """
    return bands.line_sync_min_agreement if bands is not None else LINE_SYNC_SHARE_UNCALIBRATED


def is_calibrated(model: str) -> bool:
    """Whether `model` has a calibration row — what an operator knob that NAMES a model must check before a
    worker starts on it (module docstring: the loud half of "fail loudly or refuse to gate")."""
    return model in CALIBRATED


def calibration(emissions: Any) -> Bands | None:
    """The calibrated row for the matrix `emissions` came from, or None when that model has none.

    None is never "use the default": it is what makes a model with no row REFUSE TO GATE rather than borrow
    another model's emission scale (the review's high-severity W3 finding). A matrix that names no model is
    the shipped row's by construction — a test's fake or a bench cache written before `Emissions.model`
    existed, never production — and `BANDS` is read through the module attribute there so one test can move
    the shipped numbers without rewriting the table.
    """
    named = str(getattr(emissions, "model", "") or "")
    if not named or named == BANDS.model:
        return BANDS
    return CALIBRATED.get(named)


def uncalibrated(model: str) -> str:
    """Why a matrix from `model` cannot be judged here — the one sentence every reader prints, so the trail
    says the same thing wherever the refusal to gate happened."""
    return (
        f"no lexical calibration for {model} (the alignment model is chosen per language, and these "
        f"thresholds are {', '.join(sorted(CALIBRATED))}'s): recalibrate with scripts/lift_gate.py --model "
        f"{model} before reading it as a verdict"
    )


def band(value: float, *, on_stem: bool, bands: Bands) -> Band:
    """The band a lift of `value` falls in, on a stem or on the mix, READ OFF `bands` — the calibration row of
    the model whose matrix produced `value` (`calibration(emissions)`), and never a default.

    `bands` IS REQUIRED, and that is the whole point of the argument (W4b review r2). It carried a
    `None -> BANDS` fallback until a reader noticed what one forgotten keyword then costs: on a worker running
    `ENCORE_ALIGN_MODEL=HUBERT_ASR_LARGE`, `band(0.25, on_stem=True)` answers DOUBT (publish, lines `low`)
    where that bundle's own row answers REFUSE — a wrong text judged against a floor 0.25 nats/letter too low,
    with no exception and no note in the trail, which is the review's high-severity W3 finding
    (one model's thresholds on another model's matrix) re-entering through a default argument. Required, "no
    row" is a type error at the call site instead; a caller holding `Bands | None` must decide what None means
    (`align_steps._line_sync_gate` and `_time_text_global`: nothing in nats per letter is read at all, see
    `line_sync_share` for the one threshold that survives it).
    """
    floor, ok = (bands.refuse_below, bands.ok_from) if on_stem else (bands.mix_floor, bands.mix_ok_from)
    if value < floor:
        return Band.REFUSE
    return Band.DOUBT if value < ok else Band.OK
