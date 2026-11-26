"""The records that cross a step boundary.

EVERY TYPE HERE IS CHECKPOINTED, so each must survive a pickle round trip and a process restart; the four
constraints that imposes, and what each cost, are XA-16, XW-12 and docs/arch/05-worker.md §8.
`TimingReport` travels inside `TimedDoc` so the retry verdict is computed in the workflow, not in the step.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from encore_worker.domain.document import TIMING_LINE, TIMING_WORD, Segment
from encore_worker.domain.lyrics.policy import Knob, Tier
from encore_worker.domain.lyrics.report import TimingReport, restore_appended

__all__ = [
    "TIMING_LINE",
    "TIMING_WORD",
    "AlignOutcome",
    "AudioRef",
    "JobRef",
    "Refused",
    "Segment",
    "TextRef",
    "TimeRequest",
    "TimedDoc",
    "tier_of_label",
]


@dataclass(frozen=True, slots=True)
class JobRef:
    """What every step needs to know about the job it is serving: a narrowed view of `frames.Assign`, with
    `params` a `Mapping` so no step can write into another's view of it."""

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
    #: The torch-demucs `-j` that separated it, None for another engine or unseparated audio. Checkpointed
    #: with the separation, so the silence gate names what made THESE stems, even on a resumed run (#1131).
    demucs_jobs: int | None = None

    def __setstate__(self, state: Sequence[object]) -> None:
        restore_appended(self, state)

    def align_target(self, *, on_mix: bool) -> str:
        """Which file to align against. The mix is materially less accurate — the band smears word
        boundaries — so it is a deliberate retry, never a silent default."""
        if on_mix or self.vocals_path is None:
            return self.path
        return self.vocals_path

    def targets_mix(self, *, on_mix: bool) -> bool:
        """Whether `align_target(on_mix=...)` RESOLVES to the mix, which is not the same question as the knob:
        on a STEMLESS song the two disagree, the mix being the target with the knob never set."""
        return self.align_target(on_mix=on_mix) == self.path


@dataclass(frozen=True, slots=True)
class PublishedStems:
    """The REFS separation put in the store — three, because core serves, evicts and deletes per stem.
    `guide_mix` is OPTIONAL, being built FROM the other two; the instrumental is not."""

    instrumental: str
    vocals: str | None = None
    guide_mix: str | None = None
    #: The separator that MADE these stems, for the completion facts: a `stems-upgrade` builds its own per
    #: job, so the box's startup separator is not the one to report.
    engine: str | None = None
    model: str | None = None
    #: Its `-j` and threads, this job's share rather than the boot profile; None for an engine without them.
    demucs_jobs: int | None = None
    threads: int | None = None


@dataclass(frozen=True, slots=True)
class TextRef:
    """One acquired text, with the facts that decide which knobs apply to it. `tier` is assigned by whoever
    acquired it: a transcription and a provider's plain lyrics look identical once both are untimed."""

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
    def has_own_timings(self) -> bool:
        """Did this text arrive with timings from ELSEWHERE, so that placement applies? False for an ASR
        text even though it is word-timed, it having been measured on this audio."""
        return self.tier is not Tier.ASR and self.timing in (TIMING_WORD, TIMING_LINE)


@dataclass(frozen=True, slots=True)
class TimeRequest:
    """One alignment attempt: this text, this audio, these knobs — which is what a retry varies, and what a
    checkpoint must remember so a replay uses the same parameters."""

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
    """The result of one alignment attempt: where the document went, and how good it is. `ref` is
    media-dir-relative, an absolute path embedding this worker's layout in a record core stores."""

    ref: str
    timing: str
    #: The TIMING grade, "high" / "medium" / "low" — core's `timingConfidence`, and nothing about whether the
    #: words are right (docs/arch/04-alignment.md §11).
    confidence: str
    report: TimingReport
    language: str | None = None
    label: str = ""
    #: The start time of each line, from its first timed word: `Knob.RESHIFT`'s reference, and a better ruler
    #: than any pre-alignment series. A handful of floats, so a checkpoint pays almost nothing for it.
    line_starts: tuple[float, ...] = ()
    #: The TEXT's tier, carried from the request so core's `textConfidence` is the text's provenance.
    #: REQUIRED, and keyword-only so it can sit LAST (XA-16; docs/arch/05-worker.md §8).
    tier: Tier = field(kw_only=True)
    #: Whether a WRONG-TEXT gate READ these words and did not doubt them — a POSITIVE claim, never merely
    #: "none complained", and a field of its own rather than the timing grade (XA-14).
    vouched: bool = field(default=True, kw_only=True)
    #: What the diarizer found, for the completion facts: voices heard, and parts written (0 is one colour).
    #: None when no diarizer ran.
    voices: int | None = field(default=None, kw_only=True)
    parts: int | None = field(default=None, kw_only=True)

    def __setstate__(self, state: Sequence[object]) -> None:
        # An older checkpoint has no tier (the one its label was acquired at) and no `vouched` (True, its
        # default: the gate it passed is the only one the worker that wrote it had).
        restore_appended(self, state, tier=lambda got: tier_of_label(str(got.get("label") or "")))


@dataclass(frozen=True, slots=True)
class Refused:
    """An attempt a GATE refused: the text was measured and judged not to describe this audio. Nothing was
    written, and unlike `time_text` returning None this is a VERDICT ON THE TEXT (XA-05)."""

    report: TimingReport


@dataclass(frozen=True, slots=True)
class AlignOutcome:
    """How an align job ended. NOT a success/failure flag — both values below are successes, and an align job
    FAILS only on an infrastructure fault, which raises instead of returning this."""

    published: TimedDoc | None
    why: str
    trail: tuple[Mapping[str, object], ...] = ()
    #: EVERY document this job PLACED, winner included, in order: core's retention sweep builds its cleanup
    #: set from these, so an unreported document leaks for the life of the library (XA-13).
    candidates: tuple[TimedDoc, ...] = ()
    #: The `SyncMode` value the job RAN, for its completion facts: `lines` falls back to `forced` on a song
    #: with no vocals stem, and a pin is always `forced` (`workflows.align`). None from a caller that did
    #: not resolve it (the facts then read the job's own param).
    sync_mode: str | None = None
    #: The texts a GATE refused in this job, one per label: the frame WITHDRAWS what earlier jobs stored for
    #: their words, a refused attempt writing nothing. Empty for a pinned job, and never the text this job
    #: PUBLISHED (docs/arch/04-alignment.md §11).
    refused: tuple[TextRef, ...] = ()
    #: True when publication was REFUSED for ownership (`NotOurJob`), so `published is None` means "never
    #: placed", not "found no lyrics". The transport sends it as a retryable failure, not a completion.
    abandoned: bool = False
    #: Why there are no lyrics, when this job knows (core's `LYRICS_NOTES`): `asr-babble`. None otherwise.
    lyrics_note: str | None = None

    def __setstate__(self, state: Sequence[object]) -> None:
        restore_appended(self, state)

    @property
    def no_lyrics(self) -> bool:
        return self.published is None


#: Every label a MACHINE caption track has been written under, this worker's and the previous one's, whose
#: refs an older library still holds. Read as a CANDIDATE such a document would lose the TV's "not verified"
#: standing; a PIN of one is sent `high` on purpose.
MACHINE_LABELS = frozenset({"captions:machine", "captions:auto"})


def tier_of_label(label: str) -> Tier:
    """The tier a label was acquired at, so a re-picked text keeps its standing: a machine caption track and
    a transcript are measurements, not claims. Also how a `TimedDoc` checkpointed before the field existed is
    restored."""
    if label in MACHINE_LABELS:
        return Tier.MACHINE
    if label.split(":", 1)[0] == "asr":
        return Tier.ASR
    return Tier.CANDIDATE
