"""The per-job context: what every step reads and writes.

NAMESPACED, not flat: grouping by domain keeps the `reads`/`writes` declarations on each step legible
— `'audio.path'` names which domain a step touches, not just which variable.

PER JOB, not per worker: `engines` must be resolved into per-job state rather than mutating a shared
processor instance, or with ENCORE_WORKER_CONCURRENCY > 1 two align jobs carrying different
`asrModel` would race (one nulling the other's cached sources, or transcribing with its weights).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..processor import JobSpec
from ..vocabulary import AsrModel, Engine, SyncMode


@dataclass
class ResolvedEngines:
    """What this job will actually run, resolved ONCE before the first step.

    Distinct from `job.params` (what the core ASKED for): a worker may resolve a model alias to a
    different checkpoint, or fall back to CPU when a requested backend will not load. `plan_for` also
    reads this, since which engine won can select a different plan, so it must be known before any
    step executes.
    """

    asr_model: str = AsrModel.BASE.value
    sync_mode: SyncMode = SyncMode.FORCED
    separator: str = Engine.DEMUCS.value
    device: str | None = None

    # NO `separator_model` here: `Separate` resolves the checkpoint PER ENGINE against that engine's own
    # allowlist, so a shared field would be a second, unvalidated owner of the same decision.


@dataclass
class AudioCtx:
    """Where this job's audio is."""

    #: The retained original. Written by AcquireAudio.
    path: str | None = None
    #: ASR wants this; a full mix transcribes badly. Absent until a stems job has produced one.
    vocals_path: str | None = None
    #: DECLARED by the core, never inferred from the URI's shape. A local source performs no fetch,
    #: which is why several steps declare `applies()` against it rather than testing inline.
    is_local: bool = False
    #: Duration on record, for bounding line-sync fallbacks and narrowing a lyrics lookup.
    duration_sec: float | None = None
    #: Scratch WAV a separator needs, when the engine cannot read the retained original directly.
    decoded_wav: str | None = None
    #: YouTube's OWN declared credit, from the download's `.info.json`. A CITATION, not a parse, so
    #: Annotate prefers it and uses it as the MusicBrainz query key — a wrong title parse cannot then
    #: defeat the lookup.
    youtube_credit: dict[str, Any] | None = None


@dataclass
class LyricsCtx:
    """The lyrics domain's working state for one align job."""

    #: Cues from the upload's own AUTHORED caption track. A candidate for the song's words.
    authored_cues: list[dict[str, Any]] = field(default_factory=list)
    #: A BASELINE: evidence of what is audible, never the answer while a candidate is trustworthy. A
    #: separate field, because the two kinds arrive from separate fetches and must not be confused.
    machine_cues: list[dict[str, Any]] = field(default_factory=list)
    #: Everything every source yielded, before grading.
    texts: list[Any] = field(default_factory=list)
    #: Its OWN slot rather than read back out of `texts`, which GradeAndSelect narrows to what
    #: publishes: TimeTexts derives its LRC-placement series from baselines, so without this slot that
    #: series would be empty on every ordinary job.
    baselines: list[Any] = field(default_factory=list)
    #: What grading chose, and why. None until GradeAndSelect runs.
    selection: Any | None = None


@dataclass
class StemsCtx:
    """The separation domain's working state for one stems job."""

    #: Still in scratch, so analysis costs no extra separation and no extra decode.
    raw: dict[str, str] = field(default_factory=dict)
    #: A stem measured as digital silence is deliberately ABSENT, not present-and-empty.
    published: dict[str, str] = field(default_factory=dict)
    #: Separation can SUCCEED and write silence, and a silent guiding track is worse than a missing one
    #: because it looks like it works. RECORDED rather than acted on at once, so the profile analysis
    #: still reads the raw WAV and the song reads as processed rather than stuck.
    vocals_silent: bool = False
    #: ALWAYS written, so the process gate can require presence.
    song_profile: dict[str, Any] | None = None


@dataclass
class Outputs:
    """What the runner turns into a CompleteResult."""

    artifacts: dict[str, Any] = field(default_factory=dict)
    #: OUTCOMES, where the core dispatched intentions. The audit page shows them per attempt.
    facts: dict[str, Any] = field(default_factory=dict)
    #: A list rather than direct printing, so a step's output can be asserted without capsys.
    notes: list[str] = field(default_factory=list)
    #: Wall time per step name, for the internal metrics page. Filled by the runner, not by steps.
    timings_sec: dict[str, float] = field(default_factory=dict)
    #: FIRST published wins; ranking is the core's job.
    media_uri: str = ""
    #: The VariantChoice provenance as durable data. Crosses the wire to the job_attempts audit trail,
    #: deliberately NOT the sidecar, which carries library identity rather than a run log.
    selection: dict[str, Any] | None = None


@dataclass
class Ctx:
    """Everything one job carries. Mutable, typed, and never shared between jobs."""

    job: JobSpec
    work: str
    engines: ResolvedEngines = field(default_factory=ResolvedEngines)
    audio: AudioCtx = field(default_factory=AudioCtx)
    lyrics: LyricsCtx = field(default_factory=LyricsCtx)
    stems: StemsCtx = field(default_factory=StemsCtx)
    out: Outputs = field(default_factory=Outputs)
    #: (argv) -> async iterator of output lines, injected so every step tests against a fake subprocess.
    #: A declared FIELD, because an attribute the runner attaches is invisible to a type checker.
    runner: Any = None

    @property
    def params(self) -> dict[str, Any]:
        # Guaranteed a dict by dial_home._on_assign's boundary check; no re-guard.
        return self.job.params

    def note(self, line: str) -> None:
        """Record something an operator would want in the log. The runner prints it."""
        self.out.notes.append(line)
