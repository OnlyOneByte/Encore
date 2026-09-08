"""The per-job context: what every step reads and writes.

WHY THIS EXISTS. The align action used to be a 257-line async generator, and the state it threaded
between its six inline stages was sixteen local variables — `work`, `audio`, `is_local`,
`caption_segments`, `auto_caption_segments`, `texts`, `sel`, `align_audio`, `candidates` and the rest.
That context was not missing; it was implicit and untyped, which is why adding one baseline meant
editing the method in four separate places.

NAMESPACED, not flat. A flat twenty-field bag stops being readable around field twelve, and grouping by
domain also makes the `reads`/`writes` declarations on each step legible: `'audio.path'` says which
domain a step touches, not just which variable.

PER JOB, not per worker. `engines` is the field that matters here. Engine resolution used to mutate the
shared processor instance (`self._model`, `self._sources`), so with ENCORE_WORKER_CONCURRENCY > 1 two
align jobs carrying different `asrModel` raced: one could null the other's cached sources mid-acquire,
or transcribe with the other's weights. Per-job state cannot live on a per-worker object if the
per-worker object has nowhere to put it.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..processor import JobSpec
from ..vocabulary import AsrModel, Engine, SyncMode


@dataclass
class ResolvedEngines:
    """What this job will actually run, resolved ONCE before the first step.

    Distinct from `job.params`, which is what the core ASKED for: a worker may resolve a model alias to
    a different checkpoint, or fall back to CPU when a requested backend will not load. `plan_for` also
    reads this, because which engine won can select a different plan (see the spec §5.2c) — so it has to
    be known before any step executes.
    """

    asr_model: str = AsrModel.BASE.value
    sync_mode: SyncMode = SyncMode.FORCED
    separator: str = Engine.DEMUCS.value
    separator_model: str | None = None
    device: str | None = None


@dataclass
class AudioCtx:
    """Where this job's audio is."""

    #: The retained original. Written by AcquireAudio.
    path: str | None = None
    #: The isolated vocals stem, when a stems job already produced one. ASR wants this; a full mix
    #: transcribes badly. Absent for a song whose stems have not been cooked.
    vocals_path: str | None = None
    #: DECLARED by the core, never inferred from the URI's shape. A local source performs no fetch at
    #: all, which is why several steps declare `applies()` against it rather than testing it inline.
    is_local: bool = False
    #: Duration on record, for bounding line-sync fallbacks and narrowing a lyrics lookup.
    duration_sec: float | None = None
    #: Scratch WAV a separator needs, when the engine cannot read the retained original directly.
    decoded_wav: str | None = None


@dataclass
class LyricsCtx:
    """The lyrics domain's working state for one align job."""

    #: Cues from the upload's own AUTHORED caption track. A candidate for the song's words.
    authored_cues: list[dict[str, Any]] = field(default_factory=list)
    #: Cues from YouTube's MACHINE track. A baseline — evidence of what is audible, never the answer
    #: while a candidate is trustworthy. Separate field because they arrive from separate fetches into
    #: separate directories, so the two kinds cannot be confused for one another.
    machine_cues: list[dict[str, Any]] = field(default_factory=list)
    #: Everything every source yielded, before grading.
    texts: list[Any] = field(default_factory=list)
    #: What grading chose, and why. None until GradeAndSelect runs.
    selection: Any | None = None


@dataclass
class StemsCtx:
    """The separation domain's working state for one stems job."""

    #: Raw separated WAVs still in scratch, keyed by stem name. Analysis reads these, so it costs no
    #: extra separation and no extra decode.
    raw: dict[str, str] = field(default_factory=dict)
    #: Encoded, publishable stems keyed by name. A stem measured as digital silence is deliberately
    #: absent rather than present-and-empty.
    published: dict[str, str] = field(default_factory=dict)
    #: Did the vocals stem measure as digital silence? Separation can SUCCEED and write silence, and a
    #: silent guiding track is worse than a missing one because it looks like it works. Recorded rather
    #: than acted on immediately: the profile analysis still reads the raw vocals WAV, so a silent-vocals
    #: song gets a present-but-empty profile and reads as cooked rather than stuck.
    vocals_silent: bool = False
    #: Key + vocal range, or the null profile. Always written, so the cook gate can require presence.
    song_profile: dict[str, Any] | None = None


@dataclass
class Outputs:
    """What the runner turns into a CompleteResult."""

    artifacts: dict[str, Any] = field(default_factory=dict)
    #: What this worker RESOLVED and ran — engine, model, device. The core dispatched intentions; these
    #: are outcomes, and the audit page shows them per attempt.
    facts: dict[str, Any] = field(default_factory=dict)
    #: Log lines, appended by steps and emitted by the runner. A step that printed directly could not be
    #: asserted without capsys; a list can.
    notes: list[str] = field(default_factory=list)
    #: Wall time per step name, for the internal metrics page. Filled by the runner, not by steps.
    timings_sec: dict[str, float] = field(default_factory=dict)
    #: The artifact the CompleteResult points at. First published wins; ranking is the core's job.
    media_uri: str = ""
    #: Why the published lyric was chosen over the rejected candidates — the VariantChoice provenance
    #: as durable data (#669). None on any job that made no lyrics pick. Crosses the wire to the
    #: job_attempts audit trail; deliberately NOT the sidecar, which is library identity not run log.
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
    #: How a step runs a CLI: (argv) -> async iterator of output lines. Injected by the runner so every
    #: step tests against a fake subprocess. A field rather than something the runner attaches, because a
    #: step reading an attribute that is not on the dataclass is invisible to a type checker.
    runner: Any = None

    @property
    def params(self) -> dict[str, Any]:
        # Guaranteed a dict by the inbound boundary check (dial_home._on_assign, #459); no re-guard.
        return self.job.params

    def note(self, line: str) -> None:
        """Record something an operator would want in the log. The runner prints it."""
        self.out.notes.append(line)
