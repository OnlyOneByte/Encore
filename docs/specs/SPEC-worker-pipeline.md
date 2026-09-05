# SPEC — worker action pipeline

Restructure the Python worker around a declared, one-level **plan of steps** per action, executed by a
generic runner over a typed per-job **context**.

Status: **built**, S0–S6. Decision record — what was chosen, what was rejected, and why.

Shipped: the domain packages, the runtime (`Ctx` / `Step` / `LinearPlan` / `PlanRunner`), all four actions
on declared plans, the lyrics source registry, and enforcement E1–E8.

Four things the build changed from what is written below, each recorded where it matters.
`PublishStemsIfBetter` does not exist (§5) — the outranking refusal is core-side, so the two separation
plans coincide today and inventing a step would have been worker behaviour the code does not have.
`resolve_source_audio` was deleted rather than fixed (§7 E6) — keeping a second implementation of "where
are the bytes" would have recreated the duplication the guard exists to stop, and the surviving one was
the WRONG one (it assumed a `.wav` extension yt-dlp never wrote). The generated doc landed in
`ARCHITECTURE.md` §7.1 rather than a new file (§7 E5). And `lyrics/sources/` stayed flat — `registry.py`
beside `chain.py` — because a subpackage holding one module while its siblings live elsewhere is the
half-built shape §1.2 is about.

Two bugs were fixed by construction rather than by intent: only demucs probed the vocals stem for digital
silence, and `songProfile` had two writers hand-assembling the same dict. Both stopped being possible when
the work became a step.

---

## 1. The problem, measured

`apps/worker/src` is 6,720 lines across 23 modules. Two files carry the weight:

| file | lines | what is in it |
|---|---|---|
| `whisperx.py` | 690 | lyrics artifact normalization · LRC→segments adapter · `Transcriber` protocol + real whisper impl · `Aligner` protocol + real wav2vec2 impl · source-chain wiring · the whole align orchestration |
| `lyrics_chain.py` | 644 | roles · request/text model · four sources · agreement + composite grading · selection |

Six of the 23 are lyrics (`lyrics_chain`, `lyrics_source`, `lyrics_presplit`, `lyrics_validate`,
`captions`, plus the lyrics half of `whisperx`) totalling ~2,480 lines with no package boundary
between them and everything else.

`WhisperXProcessor.process()` is **257 lines** (347–603) — one async generator with six inline
numbered stages (1, 1b, 2, 2b, 3, 4).

### 1.1 The shared context already exists; it is spelled as local variables

Inside that one method: `work`, `params`, `artist`, `track`, `language`, `duration`, `is_local`,
`audio`, `caption_dir`, `caption_segments`, `auto_caption_segments`, `req`, `texts`, `sel`,
`align_audio`, `candidates`. Sixteen locals threaded through six stages by position in the file.

That is why adding one baseline (YouTube auto-captions) required edits in four separate places inside
the method. The context object is not missing — it is implicit and untyped.

### 1.2 The real root cause: abstractions that exist and are not enforced

This is the finding that shapes the whole design. Three verified instances of one pattern:

**`resolve_source_audio`.** `fetch.py`'s module docstring states it is *"the one place that answers
'where are this job's bytes, and do I have to go and get them', and both separation and alignment call
it instead of re-deriving the answer."* They do not. Only `FetchProcessor` calls it. `demucs.py:414`,
`roformer.py:201` and `whisperx.py:361` each import the lower-level `job_fetcher` +
`local_source_path` and re-implement the branch — three copies, and a docstring asserting there is one.

**`STAGE_PLANS`.** `vocabulary.py` declares the stage sequence per action as data. `StubProcessor`
walks it. Every real processor ignores it and hardcodes its own stages inline. Two descriptions of the
pipeline, one of which executes.

**`isLikelyWrongSong`.** Written and unit-tested in `packages/shared/src/lyrics.ts`, with no caller
outside tests until the version-selection work wired it. The post-merge review of main found ~10
instances of this same habit (`client.drain`, `JobRepository.cancel`, the S3 upload path, the loudness
probe, the unservable TTL, `cook-phrasing.ts`, …).

**The stems publish shape, twice.** `demucs.py:491` and `roformer.py:257` each invoke
`build_song_profile` through their own injectable `profiler` parameter and each hand-assemble
`artifacts={"stems": …, "songProfile": …}`. This is the one instance that already cost a bug: the
worker published `songProfile` as a sibling of `stems` while the core read it nested, which would have
stalled every cook at "Separating vocals" forever. It was caught by a parity guard added afterwards —
i.e. by an enforcement test, which is the whole argument of §7.

**So the deficit is not abstraction. It is enforcement.** Adding a cleaner structure without a
mechanism that fails when someone bypasses it reproduces the same outcome one layer up. §7 is
therefore the load-bearing section of this spec, not §4.

### 1.3 Consequences being paid today

- **Per-job state lives on a shared object.** `_adopt_job_engines` mutates `self._sync_mode`,
  `self._model`, `self._transcriber` and `self._sources` on the single `WhisperXProcessor` instance
  held by `RoutingProcessor`. With `ENCORE_WORKER_CONCURRENCY > 1`, two align jobs carrying different
  `asrModel` race: job B's adopt can null `self._sources` while job A is mid-acquire, or A transcribes
  with B's weights. Latent — default concurrency is 1.
- **`/metrics` cannot see inside a stage.** `StageTimer` ends a stage when a different stage begins,
  so an align job's three `DOWNLOADING` emissions (audio, authored captions, machine captions) collapse
  into one span, and `ALIGNING` covers acquisition + grading + wav2vec2 as a single blob. The internal
  metrics page was built to show time per pipeline step and physically cannot distinguish "waiting on
  LRCLIB" from "running the aligner".
- **The smallest testable unit is a whole processor.** There is no seam between "acquire text" and
  "grade it", so verifying either means driving `process()` with a fake yt-dlp runner, a fake aligner, a
  fake transcriber and a `CompleteResult` drain. That is why the e2e fixtures are large.
- **Duplicated plumbing.** `demucs.py` and `whisperx.py` each carry their own `_run_stage`;
  `roformer.py` does `from . import demucs as d` to borrow `download_argv` and `subprocess_runner`.

---

## 2. Scope fence — what is NOT changing

Stated first, because the fence is what keeps this a refactor.

- **The wire protocol.** `job:assign` / `job:progress` / `job:complete`, and the coarse `Stage` enum
  that drives the phone's progress bar. Steps map onto existing stage names; per-step timing is an
  addition to `facts`, not a change to the progress contract.
- **Core-side cook sequencing.** `followUps` in `dispatch.ts` chains `fetch → stems → align` as three
  separate jobs. The worker executes exactly one action per assignment and does not learn about the
  cook. This is load-bearing: it is why a download-only box is a valid deployment (capability routing),
  why align re-runs from retained audio without re-downloading, and why one failed step retries in
  isolation. Rebuilding it worker-side would duplicate the core's job ledger and lose all three.
- **Capability advertisement and probing.** `capabilities.py`, `backends.py`, `hardware.py` are
  untouched.
- **Artifact keys and storage classes.** Every `derived/…` / `audio/…` path stays byte-identical; the
  core resolves them.
- **Behaviour.** No output changes. The migration is complete when the suites pass unmodified except
  where a test was asserting a structure that moved.

---

## 3. Layers

```
L0  transport    dial_home, protocol              speaks the wire; knows no domain
L1  runtime      Runner, Ctx, Step                executes a plan; knows nothing about audio
L2  plans        PLANS: dict[Action, list[Step]]  declares what each action does
L3  steps        one thin class per step          orchestrates L4, yields progress
L4  domain       lyrics/ separation/ acquisition/ metadata/    the actual knowledge
L5  platform     subprocess, ffmpeg, mediastore, hardware, backends
```

**One hard rule: dependencies point down only.** A step may import domain and platform. Domain must
never import steps, runtime or transport.

That rule is the whole testability argument. L4 becomes unit-testable with no async, no fake
subprocess, no `CompleteResult` drain — which is where most current test bulk goes. Measured against
it, `whisperx.py` today is L2+L3+L4+L5 in one file.

### 3.1 Target file layout

```
apps/worker/src/
  dial_home.py  protocol.py  vocabulary.py  config.py        (L0, unchanged)

  runtime/
    ctx.py            Ctx and its namespaced sub-contexts
    step.py           Step ABC, StepMeta
    runner.py         PlanRunner: guards, progress, per-step timing, keepalive
    plans.py          PLANS + validate_plan() + doc generation

  steps/
    acquire.py        AcquireAudio, DecodeToWav
    separate.py       Separate, ProbeSilence, PublishStems
    captions.py       FetchCaptions(kind)
    lyrics.py         AcquireTexts, PresplitTexts, GradeAndSelect, TimeTexts, PublishLyrics
    analysis.py       KeyAndRange
    metadata.py       Annotate

  lyrics/                                                    (L4 — see §6)
  separation/          engines/ (demucs, roformer), silence probe, encode policy
  analysis/            key_detect, vocal_range, song_profile
  acquisition/         fetcher vocabulary, resolve_source_audio, stream ranking
  metadata/            musicbrainz annotator + rate gate
  platform/            subprocess runner, ffmpeg argv, mediastore
```

`whisperx.py`, `demucs.py`, `roformer.py`, `fetch.py`, `lyrics_*.py`, `captions.py`, `annotate.py`,
`key_detect.py`, `vocal_range.py`, `song_profile.py`, `stream_quality.py` and `mediastore.py` all
dissolve into that tree. No file above ~250 lines.

---

## 4. Runtime

### 4.1 Context

```python
@dataclass
class AudioCtx:
    path: str | None = None          # the retained original
    vocals_path: str | None = None   # isolated stem, when a stems job made one
    is_local: bool = False           # DECLARED by the core, never inferred from the URI
    duration_sec: float | None = None

@dataclass
class LyricsCtx:
    authored_cues: list[dict] = field(default_factory=list)
    machine_cues: list[dict] = field(default_factory=list)
    texts: list[LyricsText] = field(default_factory=list)
    selection: Selection | None = None

@dataclass
class Outputs:
    artifacts: dict = field(default_factory=dict)
    facts: dict = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)   # log lines, not print()

@dataclass
class Ctx:
    job: JobSpec
    work: str                        # scratch dir, dies with the job
    engines: ResolvedEngines         # PER JOB — not on the processor instance
    audio: AudioCtx = field(default_factory=AudioCtx)
    lyrics: LyricsCtx = field(default_factory=LyricsCtx)
    out: Outputs = field(default_factory=Outputs)
```

Namespaced rather than flat because a flat 20-field bag stops being readable around field 12.

`engines` on `Ctx` is what fixes §1.3's concurrency bug structurally: per-job state cannot live on a
per-worker object if the per-worker object has nowhere to put it.

`out.notes` replaces the ~15 `print(...)` calls currently inside `process()`. A step appends; the
runner emits. That makes the log assertable in a unit test instead of requiring `capsys`.

### 4.2 Step

```python
class Step(ABC):
    name: str                   # 'acquire-audio', 'fetch-captions:machine'
    stage: Stage                # coarse stage for the phone progress bar
    reads: frozenset[str]       # {'audio.path', 'lyrics.texts'}
    writes: frozenset[str]      # {'lyrics.selection'}

    def applies(self, ctx: Ctx) -> bool:
        return True

    @abstractmethod
    def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent | StepResult]: ...
```

Steps are **classes, not functions**, so one class can fill two plan slots with different construction
(`FetchCaptions(AUTHORED)` and `FetchCaptions(MACHINE)`).

`applies(ctx)` absorbs the guards currently scattered inline as `if job.source_uri and not is_local:`.
The local-source skip becomes a declared property of the step, testable without a processor.

A step yields progress events and may finally yield one `StepResult` (§5.2b). Yielding none means
`CONTINUE` — so only the one step that can terminate a job early has to think about it.

### 4.3 Runner

```python
class PlanRunner:
    """The ONLY thing that executes a plan. One implementation, four actions."""
    async def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        ctx = Ctx(job=job, work=scratch_for(job), engines=resolve_engines(job.params))
        plan = plan_for(job, ctx.engines)          # divergence resolves HERE — see §5.2c
        step = plan.first()
        while step is not None:
            if not step.applies(ctx):
                ctx.out.notes.append(f"{step.name}: skipped")
                step = plan.after(step, StepResult(), ctx)
                continue
            result = StepResult()
            with timed(ctx, step.name):
                async for ev in step.run(ctx):
                    if isinstance(ev, StepResult):
                        result = ev
                    else:
                        yield ev
            step = plan.after(step, result, ctx)   # the one seam a state machine would replace
        yield CompleteResult(media_uri=..., artifacts=ctx.out.artifacts, facts=ctx.out.facts)
```

The runner owns everything each processor currently reimplements: the scratch dir, one `_run_stage`, the
`_run_blocking` keepalive, per-step timing, `CompleteResult` assembly.

`plan.after()` is deliberately the only place iteration order is decided (§5.2). `RoutingProcessor`
survives unchanged; `EngineRouter` collapses into `resolve_engines` + `plan_for`, becoming a strategy
resolution before the plan runs rather than a second dispatch layer.

---

## 5. Plans

One level. Flat lists. No nesting.

```python
PLANS: dict[Action, list[Step]] = {
    Action.FETCH: [
        AcquireAudio(),
        Annotate(),
        PublishOriginal(),
    ],
    Action.STEMS: [
        AcquireAudio(),
        DecodeToWav(),
        Separate(),
        ProbeSilence(),
        KeyAndRange(),
        PublishStems(),
    ],
    Action.STEMS_UPGRADE: [
        AcquireAudio(),
        DecodeToWav(),
        Separate(),
        ProbeSilence(),
        KeyAndRange(),
        PublishStemsIfBetter(),      # refuses unless it outranks what is already published
    ],
    Action.ALIGN: [
        AcquireAudio(),
        FetchCaptions(AUTHORED),
        FetchCaptions(MACHINE),
        AcquireTexts(),
        PresplitTexts(),
        GradeAndSelect(),
        TimeTexts(),
        PublishLyrics(),
    ],
}
```

`STEMS_UPGRADE` gets its own plan rather than sharing `STEMS` with a swapped publish step. The two
differ in the step that matters most — one publishes unconditionally, one refuses unless it outranks —
and sharing would push that difference into a conditional inside `PublishStems`, which is exactly the
kind of hidden branch this design exists to make visible. Five duplicated entries is a cheaper price
than one step that behaves differently depending on which plan invoked it. The duplication is also
inert: `validate_plan` (§7 E1) checks both, and the generated doc shows both.

`ProbeSilence` is a step even though its only effect is to *withhold* one artifact. Separation can
succeed and write digital silence — it has happened twice in this library, both stems pinned at the
16-bit floor — and a silent guiding track is worse than a missing one because it looks like it works.
As a step, the probe's cost is visible in `/metrics`, its skip is visible in the log, and it is
testable against a `Ctx` with no ffmpeg. Note what it is *not*: a branch. A conditional **write** inside
a step is not divergence, and §5.2 turns on that distinction.

`KeyAndRange` becomes an explicit step in both separation plans. Today `build_song_profile` is called
inline from `demucs.py:491` and `roformer.py:257` — two call sites, two injectable `profiler`
parameters, and no visibility into what it costs. As a step it is measured for the first time.

### 5.1 Why one level and not two

The two-level model is real, but **level 1 is core-side and already built** (§2). Inside one action
there is no second sequence to model.

What *looks* like a second level in the lyrics chain is a different shape entirely:

| shape | example | structure |
|---|---|---|
| **sequence** — B needs what A produced | acquire → grade → time → publish | a plan |
| **alternatives / fan-out** — N things, all run then folded | five lyrics sources; three separator engines | a **registry + fold**, not a plan |

Expressing fan-out as a nested pipeline is the trap: the "sub-steps" have no ordering relationship,
so a nested plan invites someone to add ordering semantics that do not exist. `acquire()` already
fans out over a source list and `select_by_baselines()` folds — that stays exactly as it is. The
five sequential lyrics operations become five **siblings** in the align plan.

### 5.2 Control flow: three kinds of "branching", and where each belongs

The instinct that this wants a state machine is worth taking seriously, so this section separates three
things that all get called branching and shows which mechanism each needs. The conclusion is not "a plan
is enough because the worker is simple" — it is that **every divergence found in this codebase resolves
before the first step runs**, which is a different and stronger claim.

#### (a) Conditional skip — a step does not apply

"Skip the download when the source is declared local." "Skip the caption fetch when there is no upload
to ask." Handled by `Step.applies(ctx)`. Not a branch: the sequence is unchanged, one entry is inert.
Today these are `if` statements buried mid-method; as declared guards they appear in the generated doc
and in the log.

A **conditional write** is the same category. `ProbeSilence` withholding the vocals artifact, and
`GradeAndSelect` publishing a baseline only when the winner is suspect, both change *what is in the
context* — not *what runs next*.

#### (b) Early termination — nothing left to do

This exists today, and §4 under-specified it. `whisperx.py:451` yields
`CompleteResult(media_uri="", artifacts={})` when no source produced any text: a genuine instrumental
has no words, and the remaining four steps have nothing to operate on. It is the only early return in
the worker.

A linear plan needs exactly one extra concept for it, not a state machine:

```python
class Outcome(Enum):
    CONTINUE = auto()   # proceed to the next step
    STOP = auto()       # the job is done; complete with what the context holds

@dataclass
class StepResult:
    outcome: Outcome = Outcome.CONTINUE
    reason: str = ""    # appended to out.notes, so a STOP is never silent
```

`AcquireTexts` returns `STOP` with `reason="no text from any source (instrumental?)"`. The runner
records it and completes. A short-circuit, not a transition table: there is one exit and it is always
"finish".

#### (c) Genuine divergence — a different sequence of work

This is what a state machine is for, so the question is whether it occurs. Every candidate, including
the ones on the roadmap:

| candidate | resolves where | why not mid-plan |
|---|---|---|
| separator engine (demucs / roformer / ensemble) | job params, before step 1 | `EngineRouter` already resolves it; ensemble is fan-out inside one step |
| `stems` vs `stems-upgrade` | core `followUps`, separate job | different action, own plan (§5) |
| lead-vs-backing split (4 stems vs 2) | resolved engine, before step 1 | selects a different publish step, known up front |
| scoring Tier 1 vs Tier 2 (if revived) | room setting, before step 1 | selects a different analysis step |
| silent stem → retry with another engine | **core**, as a new job | see below |
| `Requested format is not available` → relax the selector | **core**, as a retry | see below |
| LRCLIB became reachable → re-align | **core**, `followUps` / backfill | already a separate job |

The first four are **plan selection**, not branching: the answer is known from job params, settings or
the resolved engine before any step executes. So the amendment to §4.3 is that the runner asks for a
plan rather than indexing a table:

```python
def plan_for(job: JobSpec, engines: ResolvedEngines) -> Plan:
    """Divergence lives HERE — computed once, before execution, from inputs already known."""
```

**Static plan execution, dynamic plan selection.** That covers every divergence found without a single
mid-plan branch, and it keeps a plan scannable top-to-bottom — which is most of why a list beats a
transition table for reading.

The last three are retry loops, and they belong to the core for a specific reason: **the core owns the
job ledger and the per-attempt audit.** B-10 added an append-only `job_attempts` table, and
`/metrics/<mediaId>` shows every cook, every retry, which model ran it and why it failed. A
worker-internal retry loop would make one job row hide three attempts, so the audit page would report
one failed cook where three engines were actually tried. The retry is not merely easier core-side, it is
*only correct* core-side.

#### Why not a state machine, stated as a cost

A transition table buys arbitrary branching and cycles. Against that: a plan stops being readable as a
list, `validate_plan` must walk every path instead of one sequence, and the generated doc becomes a
graph rather than a table. Those costs are worth paying when divergence is real. On the evidence above
it is not — and paying them speculatively is how a mechanism gets built, goes unused, and is eventually
bypassed, which §1.2 shows is this codebase's characteristic failure mode.

#### Making the decision genuinely deferrable

Rather than argue it closed, the runner's iteration goes through one seam:

```python
class Plan(Protocol):
    def first(self) -> Step | None: ...
    def after(self, step: Step, result: StepResult, ctx: Ctx) -> Step | None: ...
```

`LinearPlan.after` is "the next entry, or None when the result said STOP". A future `GraphPlan`
implements it as a transition table. **Steps, `Ctx`, the reads/writes declarations, all eight
enforcement tests and the doc generator are identical either way** — only `after()` changes. The
state-machine decision therefore costs one class to revisit, and can be made when there is a real branch
to point at rather than an anticipated one.

**Revisit trigger, written down so this stays deliberate:** the first divergence that *cannot* be
resolved by `plan_for` before the first step runs — one where a step's outcome selects genuinely
different downstream work within the same job, and moving it to the core would be wrong rather than
merely inconvenient. `validate_plan` growing a special case is the smell that this has happened.

### 5.3 Rejected: a generic DAG engine with parallel steps

Concurrency is per-job (`ENCORE_WORKER_CONCURRENCY`), not per-step, and the steps within an action are
genuinely sequential. A DAG would add a scheduler, a dependency resolver and a failure-partial-order
question in exchange for nothing.

---

## 6. The lyrics domain

```
lyrics/
  model.py       LyricsText, LyricsRequest, roles, timing + source vocabulary
  artifact.py    normalize_lyrics, is_valid_lyrics, candidate_key    ← out of whisperx.py
  grade.py       tokens, agreement_score, composite_score, Selection, select_by_baselines
  presplit.py    (moved unchanged)
  validate.py    (moved unchanged)
  sources/
    registry.py  SourceSpec + build_sources(ctx)
    lrclib.py    client, ranking, LrclibSource
    captions.py  VTT parse, argv, CaptionsSource, AutoCaptionsSource
    asr.py       Transcriber protocol, WhisperxTranscriber, AsrSource
  timing/
    aligner.py   Aligner protocol, WhisperxForcedAligner, time_one
```

The two-tier baseline/candidate split shipped in PR #27 is unchanged — this only gives it a shape.

### 6.1 The source registry

Today `_get_sources()` hardcodes five sources and each open-codes its own precondition
(`if not req.vocals_path: return None`). Declare it instead:

```python
@dataclass(frozen=True)
class SourceSpec:
    id: str                     # 'lrclib' | 'captions:authored' | 'asr:vocals' | 'asr:mix' | 'captions:machine'
    role: str                   # baseline | candidate
    baseline_rank: int | None   # only meaningful for baselines
    requires: frozenset[str]    # {'vocals_stem'}, {'network', 'metadata'}, {'machine_cues'}
    build: Callable[[Ctx], LyricsSource]
```

Three things this buys that the current list cannot:

1. **One place decides what can run**, instead of five scattered early returns.
2. **The log can say WHY a source sat out.** This is the precise gap behind the LRCLIB sinkhole
   lesson, where "this song has no lyrics" and "this provider has been dead for a month" were the same
   silent observation. A declared unmet requirement is reportable; a bare `return None` is not.
3. **A setting can filter the registry** — "do not grade with machine captions" becomes data.

### 6.2 Naming

`lyrics_chain.py` loses its name. "Chain" was accurate when the design was first-hit fallback; it is
now a registry plus a graded fold, and the file is the union of five concerns. Nothing should be
called a chain after this.

---

## 7. Enforcement — the part that makes it stick

§1.2 established that this codebase's failure mode is abstractions that exist and are bypassed. Every
mechanism below therefore gets a test that fails when someone routes around it. Without this section
the refactor is decoration.

**E1 — plans are well-formed.** Walk every plan; assert no step `reads` a key that no earlier step
`writes` (given the seed keys the runner provides). Catches a reordered or misplaced step at test
time rather than as a confusing `None` on the deploy box.

**E2 — no undeclared writes.** In test mode the runner snapshots the declared keys around each step
and asserts nothing else changed. Keeps `Ctx` from decaying into a god-object where any step writes
anything. Test-mode only, so production pays nothing.

**E3 — one runner.** Assert `Processor` implementations are exactly `PlanRunner`, `StubProcessor` and
the routers. A new processor that hand-rolls its own `process()` fails the suite. This is the test
that would have caught all three instances in §1.2.

**E4 — `STAGE_PLANS` is derived, not written.** `stages_for(action)` becomes
`dedupe(s.stage for s in PLANS[action])`. The parallel table stops existing, so it cannot drift.

**E5 — the doc is generated, and it lives where people already look.**
`python -m src.runtime.plans --doc` emits the step table and a Mermaid diagram per action. The output is
written **into `docs/ARCHITECTURE.md`** between markers:

```markdown
<!-- BEGIN generated:worker-pipeline -->
...tables and diagrams...
<!-- END generated:worker-pipeline -->
```

A test asserts the region matches regeneration, so the doc cannot drift. Writing into `ARCHITECTURE.md`
rather than a new file keeps `docs/` root at exactly three files (the convention in
`docs/specs/README.md`) and puts the pipeline where a reader is already looking, instead of in a
reference file they have to be told about. Everything outside the markers stays hand-written.

Given `fetch.py`'s docstring is currently false (§1.2), hand-maintained architecture prose about this
worker is a demonstrated liability.

**E6 — acquisition has one caller path.** Assert no module outside `acquisition/` imports
`job_fetcher` or `local_source_path`. Directly closes §1.2's first instance.

**E7 — layering.** Assert no module under `lyrics/`, `separation/`, `acquisition/` or `metadata/`
imports from `steps/`, `runtime/` or `dial_home`. One import-graph test enforces §3's only rule.

**E8 — one publish shape per artifact kind.** `PublishStems` is the only writer of the `stems` /
`songProfile` artifact dict, so the two engines cannot disagree about its shape. This is the mechanism
that would have prevented §1.2's fourth instance rather than catching it afterwards.

E1, E3, E6 and E7 are each roughly a dozen lines. They are the cheapest part of this spec and the
reason to do it at all.

---

## 8. Migration

Every stage ends green, shippable, and independently reviewable.

**S0 — move-only, and it proves itself.** Create the target directories; `git mv` the existing files
with no edits beyond import paths; re-export from `__init__.py` so no call site changes. **All 460
worker tests must pass untouched.** If a test needs editing, it was not a move. One commit per moved
domain so review is mechanical.

**S1 — dissolve `whisperx.py`.** Extract `lyrics/artifact.py`, `lyrics/sources/asr.py`,
`lyrics/timing/aligner.py`. What remains is the orchestration, temporarily still a processor.

**S2 — runtime, align only.** Add `Ctx`, `Step`, `StepResult`, `LinearPlan`, `plan_for`, `PlanRunner`,
`PLANS[ALIGN]`, and E1/E2. Port the 257-line method into eight steps, including the `STOP` path that is
currently the early return at `whisperx.py:451`. `RoutingProcessor` already tolerates mixed processor
styles, so demucs/roformer/fetch keep working untouched. **This stage also fixes the concurrency bug** by
moving engine resolution onto `Ctx`.

**S3 — port stems, stems-upgrade, fetch.** Both separation plans, `ProbeSilence` and `KeyAndRange` as
steps, `analysis/` split out of `separation/`. Delete the duplicated `_run_stage`; `roformer.py` stops
importing `demucs`; acquisition gets one path. Add E3, E6 and E8.

**S4 — derive and generate.** E4 and E5: `STAGE_PLANS` derived from `PLANS`, the generated region
written into `docs/ARCHITECTURE.md` with a freshness test, per-step timing into `facts` so `/metrics`
gains real resolution.

**S5 — layering guard.** Add E7, fix whatever it catches.

**S6 — source registry.** `SourceSpec`, unmet-requirement logging, settings-driven filtering.

S0–S2 deliver most of the readability win; S4 delivers the `/metrics` improvement; S6 is the only
stage that changes behaviour and could ship separately or not at all.

---

## 9. Decisions

| Decision | Chosen | Rejected | Why |
|---|---|---|---|
| Levels of pipeline | one, flat, per action | nested cook→step→substep | the cook level is core-side and already built; nesting would duplicate the job ledger |
| Fan-out (sources, engines) | registry + fold | sub-pipeline | the members have no ordering relationship; a nested plan invites invented semantics |
| Divergence | **plan selection** via `plan_for`, before step 1 | mid-plan branching | every candidate found resolves from params/settings/engine up front (§5.2c) |
| Early termination | `StepResult(STOP, reason)` | an exception, or `applies` on four later steps | one real case exists (`whisperx.py:451`); a reason string keeps it out of the silent-failure class |
| Retry loops | the **core's** job ledger | a loop inside the worker | `job_attempts` + `/metrics/<mediaId>` audit every attempt; an internal loop would report 1 attempt where 3 ran |
| Control flow | linear, behind a `Plan.after()` seam | a transition table now | no divergence to point at; the seam makes it one class to revisit (§5.2) |
| Execution | sequential | DAG with parallel steps | concurrency is per-job; steps are genuinely sequential |
| `stems-upgrade` | its own plan | `STEMS` with a swapped publish step | the difference is the publish rule itself; sharing hides it in a conditional |
| `ProbeSilence` | its own step | inside `Separate` | measurable in `/metrics`, visible skip, testable with no ffmpeg |
| Song profile | own `analysis/` domain + `KeyAndRange` step | inside `separation/` | key detection and vocal range are analysis, not separation; today called from two engines inline |
| Context | typed dataclass, namespaced | `dict[str, Any]` | the typing is what makes reads/writes checkable; a dict makes the idea decoration |
| Step unit | class with `__init__` params | plain function | one class fills two plan slots (`FetchCaptions(kind)`) |
| Step reuse | helpers + composition | a `BaseFetchStep` hierarchy | shallow-ABC-only; an inheritance tree among steps is how this becomes unreadable |
| Seams | `Protocol` (structural) | ABCs everywhere | matches the existing style (`Transcriber`, `Aligner`, `LyricsSource`) |
| Generated doc | a marked region inside `ARCHITECTURE.md` | a new `docs/` root file, or `docs/reference/` | keeps the root at three files and puts it where readers already are |

---

## 10. Risks

**`_run_blocking` must move intact, not be rewritten.** It exists because synchronous torch calls
froze the event loop and the worker missed its websocket keepalive — an observed failure on a live
cook, not a theoretical one. Copy it; do not reimplement it from its docstring.

**S0 is the only stage that can silently break everything.** A mis-merged `git mv` plus an
`__init__.py` re-export can leave two copies of a module importable under different names. Mitigation:
after S0, assert the module count and that no file under the new tree is importable by its old path.

**Test churn will hide behaviour change.** Stages S2–S3 legitimately move tests between files. Rule:
a commit may move a test or change a test's assertions, **never both**.

**The `Stage` enum is on the wire.** Steps must map onto existing stage names. Per-step timing is
additive in `facts`; if a step needs a new stage the core must learn it first.

**Scope creep into the core.** `followUps`, the readiness gates and the job ledger are out of scope.
If a step wants to change what the cook does, that is a different spec.

---

## 11. Open questions

The four questions this spec opened were answered by the owner and are folded into §5, §7 and §9:
`stems-upgrade` gets its own plan, `ProbeSilence` is a step, song-profile analysis gets its own
`analysis/` domain, and the generated doc goes into `ARCHITECTURE.md` rather than a new root file.

What remains genuinely open:

1. **Should a silent stem fail the job so the core can retry on another engine?** Today it silently
   omits the vocals artifact and the song stays playable with no guide — an honest outcome, but 2 of 9
   stems in this library hit it, so 22% of songs have no guiding track and nothing says so. §5.2c argues
   the retry belongs core-side; whether to *ask* for one is a product decision, not an architectural one.
2. **Does `Annotate` want to be a step in `ALIGN` too?** It is `FETCH`-only today. A song whose metadata
   improved after its fetch never re-annotates, which is one reason a lookup can miss on artist+track.
3. **Does `plan_for` need settings, or only job params?** Params carry the engine and lyrics settings
   the core already sends. If a future plan choice depends on something the core does not send, that is a
   protocol change and should be treated as one.

---

## 12. Housekeeping done while writing this

Both were one-line fixes and are included in this branch rather than deferred:

- `docs/SPEC-queue-order-room-setting.md` sat at the `docs/` root. Its feature merged (PR #23) and
  `docs/specs/README.md` says the root holds exactly three files and a merged spec moves to
  `docs/archive/specs/`. Moved, and the inbound `ROADMAP.md` reference repointed.
- `fetch.py`'s module docstring asserted that separation and alignment call `resolve_source_audio`.
  They do not. Corrected to state what is actually true and to name the three bypassing call sites —
  the previous wording was the expensive kind of wrong, because a reader had no reason to check.
