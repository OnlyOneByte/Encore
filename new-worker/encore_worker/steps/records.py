"""The records that cross a step boundary.

EVERY TYPE HERE IS CHECKPOINTED. DBOS serializes a step's arguments and its return value into SQLite, so
these are the shapes that must survive a round trip and a process restart. Three consequences, and each
one is a real constraint rather than style:

  * frozen and slotted, so a step cannot mutate its caller's record — a mutation would be invisible
    after a replay, where the caller's copy is rebuilt from the checkpoint instead.
  * tuples, never lists. A list is mutable, and `Mapping` for params for the same reason.
  * paths and refs, never bytes, tensors or handles. Audio stays on disk under the media directory; a
    record says WHERE it is.

`TimingReport` travels inside `TimedDoc` because the verdict that decides whether to retry is computed
from it in the workflow, not in the step — which is what keeps the decision pure and the step dumb.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field

from encore_worker.domain.document import TIMING_LINE, TIMING_WORD, Segment
from encore_worker.domain.lyrics.policy import Knob, Tier
from encore_worker.domain.lyrics.report import TimingReport

__all__ = [
    "TIMING_LINE",
    "TIMING_WORD",
    "AlignOutcome",
    "AudioRef",
    "JobRef",
    "Segment",
    "TextRef",
    "TimeRequest",
    "TimedDoc",
]


@dataclass(frozen=True, slots=True)
class JobRef:
    """What every step needs to know about the job it is serving.

    A narrowed view of `protocol.frames.Assign`, deliberately: a step should not be able to read the
    whole inbound frame, and `params` stays a `Mapping` so no step can write into another's view of it.
    """

    job_id: str
    media_id: str
    media_dir: str
    source_uri: str | None = None
    params: Mapping[str, object] = field(default_factory=dict)

    def param_str(self, key: str) -> str | None:
        """A string param, or None when absent or empty. Trimmed, since the core forwards user input."""
        raw = self.params.get(key)
        if not isinstance(raw, str):
            return None
        return raw.strip() or None


@dataclass(frozen=True, slots=True)
class AudioRef:
    """The audio in hand, and what is known about it."""

    path: str
    duration_sec: float
    #: The isolated vocals stem, when separation produced one. `None` means alignment runs on the mix
    #: from the start, which is why `Knob.ALIGN_ON_MIX` is then unavailable rather than merely untried.
    vocals_path: str | None = None

    def align_target(self, *, on_mix: bool) -> str:
        """Which file to align against. The mix is materially less accurate — the band smears word
        boundaries — so it is a deliberate retry, never a silent default."""
        if on_mix or self.vocals_path is None:
            return self.path
        return self.vocals_path


@dataclass(frozen=True, slots=True)
class PublishedStems:
    """The REFS separation put in the store — what core records, not where the files were built.

    Three refs rather than one string because core's `JobArtifacts.stems` has three fields, and a worker
    that reports only the instrumental leaves the other two unrecorded: core then has no ref to serve, no
    ref to evict under retention, and no ref to delete with the media. They are published together, so they
    are reported together.

    `guide_mix` is OPTIONAL because it is built FROM the other two — a box whose ffmpeg cannot produce the
    4-channel join still has two usable stems, and the TV falls back to the two-element guide. The
    instrumental is not optional: without it there is nothing to play.
    """

    instrumental: str
    vocals: str | None = None
    guide_mix: str | None = None


@dataclass(frozen=True, slots=True)
class TextRef:
    """One acquired text, with the facts that decide which knobs apply to it.

    `tier` is what makes ASR the mandatory fallback rather than a last resort, and it is assigned by
    whoever acquired the text — never inferred later from its shape, because a transcription and a
    provider's plain lyrics can look identical once both are untimed.
    """

    tier: Tier
    #: "lrclib", "captions:authored", "asr:vocals". Reaches the decision trail and `job:state`.
    label: str
    segments: tuple[Segment, ...]
    language: str | None = None
    #: What the text's own timings are, if any: word, line, or neither.
    timing: str | None = None
    #: Narrower per-row search spans, when presplit produced them.
    windows: tuple[Segment, ...] = ()

    @property
    def has_line_timings(self) -> bool:
        return self.timing == TIMING_LINE

    @property
    def has_own_timings(self) -> bool:
        """Did this text arrive with timings from ELSEWHERE, so that placement applies?

        False for an ASR text even though it is word-timed: it was measured on this audio, so there is
        nothing to place. That distinction is what makes `Knob.RESHIFT` meaningful or meaningless.
        """
        return self.tier is not Tier.ASR and self.timing in (TIMING_WORD, TIMING_LINE)


@dataclass(frozen=True, slots=True)
class TimeRequest:
    """One alignment attempt: this text, this audio, these knobs.

    The knob set is the whole reason this is a record rather than three arguments — it is what a retry
    varies, and what a checkpoint must remember so a replayed attempt uses the same parameters.
    """

    job: JobRef
    text: TextRef
    audio: AudioRef
    language: str
    knobs: frozenset[Knob] = frozenset()
    #: Line starts from the PREVIOUS attempt on this text, when there was one. The reference a RESHIFT
    #: re-places against; empty means the estimator abstains, which is the identity.
    reference_starts: tuple[float, ...] = ()

    @property
    def on_mix(self) -> bool:
        return Knob.ALIGN_ON_MIX in self.knobs

    @property
    def drop_windows(self) -> bool:
        return Knob.DROP_WINDOWS in self.knobs

    @property
    def force_line_sync(self) -> bool:
        return Knob.LINE_SYNC in self.knobs

    @property
    def reshift(self) -> bool:
        return Knob.RESHIFT in self.knobs

    def search_spans(self) -> tuple[Segment, ...]:
        """What the aligner may look within: presplit's windows, unless this attempt dropped them."""
        if self.drop_windows or not self.text.windows:
            return self.text.segments
        return self.text.windows


@dataclass(frozen=True, slots=True)
class TimedDoc:
    """The result of one alignment attempt: where the document went, and how good it is.

    `ref` is a media-dir-relative path, not absolute: the core merges on it, and an absolute path would
    embed this worker's filesystem layout in a record the core stores.
    """

    ref: str
    timing: str
    #: "high" / "medium" / "low". Read by the phone to decide whether to caveat the lyrics it shows.
    confidence: str
    report: TimingReport
    language: str | None = None
    label: str = ""
    #: The start time of each line, taken from its first timed word. Carried on the record rather than
    #: re-read from disk because it is what `Knob.RESHIFT` needs as its reference — the previous
    #: alignment is a better ruler than any pre-alignment series, having been measured on this recording.
    #: A handful of floats, so a checkpoint pays almost nothing for it.
    line_starts: tuple[float, ...] = ()


@dataclass(frozen=True, slots=True)
class AlignOutcome:
    """How an align job ended. NOT a success/failure flag — both values below are successes.

    `published` carries the ref when lyrics were published; `no_lyrics` is the honest terminal for a
    song with no intelligible words, reached only after ASR has had its turn. An align job FAILS only
    on an infrastructure fault, which raises instead of returning this.
    """

    published: TimedDoc | None
    why: str
    trail: tuple[Mapping[str, object], ...] = ()
    #: EVERY document this job wrote, winner included, in the order they were produced.
    #:
    #: Reported to the core as `artifacts.lyrics.candidates`, and that is not cosmetic: core's retention
    #: sweep builds its cleanup set from `lyricsCandidates` (`retention.ts:182`), so a document the worker
    #: wrote and did NOT report is never enumerated and therefore never evicted — it leaks for the life of
    #: the library. It is also what makes re-selection possible without re-fetching the audio, which is what
    #: `/api/lyrics-reselect` exists to do.
    candidates: tuple[TimedDoc, ...] = ()

    @property
    def no_lyrics(self) -> bool:
        return self.published is None
