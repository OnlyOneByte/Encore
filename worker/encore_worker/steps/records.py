"""The records that cross a step boundary.

EVERY TYPE HERE IS CHECKPOINTED. DBOS serializes a step's arguments and its return value into SQLite, so
these are the shapes that must survive a round trip and a process restart. Three consequences, and each
one is a real constraint rather than style:

  * frozen and slotted, so a step cannot mutate its caller's record — a mutation would be invisible
    after a replay, where the caller's copy is rebuilt from the checkpoint instead.
  * tuples, never lists. A list is mutable, and `Mapping` for params for the same reason.
  * paths and refs, never bytes, tensors or handles. Audio stays on disk under the media directory; a
    record says WHERE it is.
  * a new field is APPENDED, never inserted, and a record that gains one restores its older checkpoints
    through `restore_appended` (review W1 r2): pickle restores a slotted record positionally, and left
    the new field unset, so a job resumed or forked across an upgrade failed on the first read of it.

`TimingReport` travels inside `TimedDoc` because the verdict that decides whether to retry is computed
from it in the workflow, not in the step — which is what keeps the decision pure and the step dumb.
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
    def has_own_timings(self) -> bool:
        """Did this text arrive with timings from ELSEWHERE, so that placement applies?

        False for an ASR text even though it is word-timed: it was measured on this audio, so there is
        nothing to place. That distinction is what makes `Knob.RESHIFT` meaningful or meaningless.

        IT IS ALSO THE LINE_SYNC RUNG'S QUESTION, and a separate `has_line_timings` reading
        `timing == TIMING_LINE` used to answer it WRONGLY (W5 review r2-correctness-2). A WORD-timed sheet
        carries its LINES' spans as well — `measure.line_spans` reads one span per segment, whatever the
        words hold — and since `clean_segments` rewrites every provider's word list as a TUPLE,
        `align_steps._has_word_spans` labels an lrcmux word-level answer and every A2 LRC sheet
        `TIMING_WORD`. Reading the LABEL therefore took the rung away from exactly the texts that brought
        the most timing. `workflows.align._candidate_of` reads THIS property for both knobs now, and the
        ASR exclusion is what keeps it honest: a transcript's own line timings are this audio's decode, so
        there is no sheet to fall back to (under `syncMode=lines` a transcript's lines do publish, and that
        clause lives at the call site where the mode is known).
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
    #: The TIMING grade, "high" / "medium" / "low": how far the placement of these words is vouched for.
    #: Core's `timingConfidence`, and NOTHING about whether the words are right — sent as `textConfidence`
    #: (review M3) it made a machine-caption word doc authoritative and every line-sync doc `low`.
    confidence: str
    report: TimingReport
    language: str | None = None
    label: str = ""
    #: The start time of each line, taken from its first timed word. Carried on the record rather than
    #: re-read from disk because it is what `Knob.RESHIFT` needs as its reference — the previous
    #: alignment is a better ruler than any pre-alignment series, having been measured on this recording.
    #: A handful of floats, so a checkpoint pays almost nothing for it.
    line_starts: tuple[float, ...] = ()
    #: The TEXT's tier (`TextRef.tier`), carried from the request so core's `textConfidence` is the text's
    #: provenance — assigned where the text was acquired, never re-inferred from the label afterwards.
    #: REQUIRED, and keyword-only so it can sit LAST: a slotted record pickles its fields positionally, and
    #: inserting one mid-record would shift every later field of a checkpoint written before it.
    tier: Tier = field(kw_only=True)
    #: Whether a WRONG-TEXT gate READ these words and did not doubt them (W3 review r1, narrowed by r2).
    #: True is the positive claim "one measured them and they are what is sung" — never merely "none
    #: complained": an unmeasured text is False (a sheet under `lexical.MIN_LETTERS`, a lift whose decode
    #: raised, a matrix from a model the bands were not calibrated on, a LINE_SYNC document whose words no
    #: gate could read), because core reads True as a claim and ranks it as one. False therefore covers three
    #: cases: doubted (the lexical doubt band on a stem, a sub-floor lift on the mix), a pin whose lift the
    #: gate would have refused, and unmeasured. The ASR tier is the one exemption that stays True — its words
    #: were heard on this very audio — and its tier already sends `textConfidence` `low`.
    #: Core is sent `vouched: false` for such a document whatever its tier or its pin, and reads it in
    #: `isAuthoritativeText`, so a document a gate passed outranks it. The TIMING grade above cannot carry it
    #: (since W6 core's `lyricsRank` reads `timingConfidence`, but only a `low` one, and the doubt band's
    #: grade is `medium` — it read the field nowhere at all when this was written), and `textConfidence`
    #: cannot either: that field is
    #: the text's PROVENANCE, and core reads `captions` + `low` as "Auto captions" (W3 review r2).
    vouched: bool = field(default=True, kw_only=True)

    def __setstate__(self, state: Sequence[object]) -> None:
        # A v2 checkpoint has no tier: the one its label was acquired at (`tier_of_label`). A pre-W3-r1 one
        # has no `vouched`: True, its default — the gate it passed is the only one those workers had.
        restore_appended(self, state, tier=lambda got: tier_of_label(str(got.get("label") or "")))


@dataclass(frozen=True, slots=True)
class Refused:
    """An attempt a GATE refused: the text was measured against this audio and judged not to describe it.

    Nothing was written. Distinct from `time_text` returning None — "this attempt produced nothing" (a
    decode that raised, a text with no alignable character), which may still line-sync — because a
    refusal is a VERDICT ON THE TEXT: `report.refused` says why, and `policy.decide` answers it with
    NextText. Collapsing the two is how every wrong text the envelope gate refused came to retry
    LINE_SYNC with no gate at all (W0: 168 of the bench's 320).
    """

    report: TimingReport


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
    #:
    #: Every attempt is written to job scratch and PLACED in the store only by `publish`, after its
    #: ownership check (review W1 r1), so these are the documents placed, under their store refs; a job
    #: that failed or lost its lease placed and reports none. A PINNED job (review H5) places and reports
    #: only the document at the pinned ref.
    candidates: tuple[TimedDoc, ...] = ()
    #: The `SyncMode` value the job RAN, for its completion facts: `lines` falls back to `forced` on a song
    #: with no vocals stem, and a pin is always `forced` (`workflows.align`). None from a caller that did
    #: not resolve it (the facts then read the job's own param).
    sync_mode: str | None = None
    #: The texts a GATE refused in this job (`Refused`: measured not to describe this audio), one per label.
    #: Core ranks every job's candidates together, and a refused attempt writes nothing, so a candidate an
    #: EARLIER job stored for the same words would stay selectable beside this job's verdict on them: the
    #: frame withdraws those (`align_steps.superseded_candidates`, review W1 r2). Empty for a pinned job,
    #: and never the text this job PUBLISHED: best-so-far can keep an attempt whose retry was refused, and
    #: "these words do not describe this audio" is not what the job concluded about words it published
    #: (`workflows.align`, the Commit branch).
    refused: tuple[TextRef, ...] = ()

    def __setstate__(self, state: Sequence[object]) -> None:
        restore_appended(self, state)

    @property
    def no_lyrics(self) -> bool:
        return self.published is None


#: The labels a MACHINE caption track has been written under: this worker's `captions:machine`
#: (`AlignStepsImpl.fetch_captions`), and the old worker's `captions:auto` — its `AutoCaptionsSource` keyed
#: them `{media}-captions-auto-{timing}.json` with textConfidence `low` (f04a2d0e^ `lyrics/sources.py`), and
#: a library aligned before 2026-09-25 still holds those refs. Read as a CANDIDATE, one an earlier job stored
#: would be withdrawn as textConfidence `high` (`__main__._lyrics_artifacts`) and lose the TV's "not
#: verified" standing. (A PIN of one is sent `high` on purpose since W3, whatever its tier.)
MACHINE_LABELS = frozenset({"captions:machine", "captions:auto"})


def tier_of_label(label: str) -> Tier:
    """The tier a label was acquired at, so a re-picked text keeps its standing (`fetch_captions`,
    `transcribe`): a machine caption track and a transcript are measurements, not claims. Also what a
    checkpointed `TimedDoc` written before it carried a tier is restored with."""
    if label in MACHINE_LABELS:
        return Tier.MACHINE
    if label.split(":", 1)[0] == "asr":
        return Tier.ASR
    return Tier.CANDIDATE
