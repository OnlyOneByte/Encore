# SPEC — worker action pipeline

Restructure the Python worker around a declared, one-level **plan of steps** per action, executed by a
generic runner over a typed per-job **context**.

Status: **proposed**, nothing built. Decision record — what was chosen, what was rejected, and why.

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
    def run(self, ctx: Ctx) -> AsyncIterator[ProgressEvent]: ...
```

Steps are **classes, not functions**, so one class can fill two plan slots with different
construction (`FetchCaptions(AUTHORED)` and `FetchCaptions(MACHINE)`).

`applies(ctx)` absorbs the guards currently scattered inline as `if job.source_uri and not is_local:`.
The local-source skip becomes a declared property of the step, testable without a processor.

### 4.3 Runner

```python
class PlanRunner:
    """The ONLY thing that executes a plan. One implementation, four actions."""
    async def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        ctx = Ctx(job=job, work=scratch_for(job), engines=resolve_engines(job.params))
        for step in PLANS[Action(job.job_type)]:
            if not step.applies(ctx):
                ctx.out.notes.append(f"{step.name}: skipped")
                continue
            with timed(ctx, step.name):
                async for ev in step.run(ctx):
                    yield ev
        yield CompleteResult(media_uri=..., artifacts=ctx.out.artifacts, facts=ctx.out.facts)
```

The runner owns everything each processor currently reimplements: the scratch dir, one `_run_stage`,
the `_run_blocking` keepalive, per-step timing, `CompleteResult` assembly.

`RoutingProcessor` and `EngineRouter` survive unchanged — `EngineRouter` becomes a strategy pick
*before* the plan runs, resolving into `ctx.engines`, rather than a second dispatch layer.

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
        KeyAndRange(),                # song profile — currently buried in demucs stage 3
        PublishStems(),
    ],
    Action.STEMS_UPGRADE: [           # same shape; refuses unless it outranks what is published
        AcquireAudio(),
        DecodeToWav(),
        Separate(),
        ProbeSilence(),
        KeyAndRange(),
        PublishStemsIfBetter(),
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

### 5.2 Why a plan and not a state machine

A state machine buys branching and cycles. Neither is present:

- "skip download when the source is local" → a per-step guard, not a branch
- "which separator engine" → a strategy pick before the plan runs
- "word timing failed, degrade to line" → a return value inside one step
- retries → the core's job ledger

**Upgrade trigger, recorded so the decision stays deliberate:** the first time a step's *successor*
depends on its outcome — e.g. "if LRCLIB was unreachable, branch to a deferred-retry path instead of
continuing" — a plan becomes a graph and this decision should be revisited. Until then a state machine
is machinery to maintain and never use, and it makes the plan unreadable as a list.

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

**E5 — the doc is generated.** `python -m src.runtime.plans --doc` emits the step table and a Mermaid
diagram per action; `docs/worker-pipeline.md` is the committed output and a test asserts the file
matches regeneration. Given the `resolve_source_audio` docstring is currently false, hand-maintained
architecture prose is a demonstrated liability here.

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

**S2 — runtime, align only.** Add `Ctx`, `Step`, `PlanRunner`, `PLANS[ALIGN]`, and E1/E2. Port the
257-line method into eight steps. `RoutingProcessor` already tolerates mixed processor styles, so
demucs/roformer/fetch keep working untouched. **This stage also fixes the concurrency bug** by moving
engine resolution onto `Ctx`.

**S3 — port stems, stems-upgrade, fetch.** Delete the duplicated `_run_stage`; `roformer.py` stops
importing `demucs`; acquisition gets one path. Add E3 and E6.

**S4 — derive and generate.** E4 and E5: `STAGE_PLANS` from `PLANS`, `docs/worker-pipeline.md`
generated, per-step timing into `facts` so `/metrics` gains real resolution.

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
| Control flow | linear list + per-step guard | state machine | no cycles and no real branch points; §5.2 records the upgrade trigger |
| Execution | sequential | DAG with parallel steps | concurrency is per-job; steps are genuinely sequential |
| Context | typed dataclass, namespaced | `dict[str, Any]` | the typing is what makes reads/writes checkable; a dict makes the idea decoration |
| Step unit | class with `__init__` params | plain function | one class fills two plan slots (`FetchCaptions(kind)`) |
| Step reuse | helpers + composition | a `BaseFetchStep` hierarchy | shallow-ABC-only; an inheritance tree among steps is how this becomes unreadable |
| Seams | `Protocol` (structural) | ABCs everywhere | matches the existing style (`Transcriber`, `Aligner`, `LyricsSource`) |
| Docs | generated + freshness test | hand-written prose | the `resolve_source_audio` docstring is currently false |

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

1. **Does `stems-upgrade` deserve its own plan, or is it `STEMS` plus a different publish step?** As
   drafted it is the latter with one step swapped. If a real difference emerges, splitting is cheap.
2. **Should `ProbeSilence` be a step or stay inside `Separate`?** As a step it is independently
   testable and its skip is visible in the log; inside `Separate` it is closer to the encoder that
   produced the file. Leaning step.
3. **Does `vocal_range.py` belong under `separation/` or its own `analysis/` domain?** It carries key
   detection, chroma and the pure-numpy pitch tracker, and it runs inside the stems job's third stage
   rather than as a step of its own. Leaning `analysis/` with `KeyAndRange()` as an explicit step in
   `PLANS[STEMS]`, which would make its cost visible in `/metrics` for the first time.
4. **Does the generated doc live at `docs/worker-pipeline.md` or under `docs/specs/`?** Convention
   says `docs/` root holds three files, so it wants a subfolder — but it is reference, not a spec.
   Suggest `docs/reference/worker-pipeline.md` and a new `docs/reference/` folder.

---

## 12. Housekeeping done while writing this

Both were one-line fixes and are included in this branch rather than deferred:

- `docs/SPEC-queue-order-room-setting.md` sat at the `docs/` root. Its feature merged (PR #23) and
  `docs/specs/README.md` says the root holds exactly three files and a merged spec moves to
  `docs/archive/specs/`. Moved, and the inbound `ROADMAP.md` reference repointed.
- `fetch.py`'s module docstring asserted that separation and alignment call `resolve_source_audio`.
  They do not. Corrected to state what is actually true and to name the three bypassing call sites —
  the previous wording was the expensive kind of wrong, because a reader had no reason to check.
