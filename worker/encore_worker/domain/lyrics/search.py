"""The search for publishable lyrics, as a pure driver the workflow turns.

`policy.decide` judges ONE alignment. This walks the pool: which text to try next, with which knob, when
to run ASR on demand, and when — finally — to conclude the song has no words.

WHY IT IS NOT IN `workflows/`. A DBOS workflow body must be deterministic and is awkward to unit-test,
so the interesting part lives here as a plain object driven by step results. The workflow becomes a loop
with no decisions in it, and every branch below is testable with no audio, no model and no DBOS.

TERMINATION IS STRUCTURAL, not capped. Each `Try` either spends a knob for the current text (there are
four, each spendable once) or advances the pool index (the pool is finite), and `RunAsr` fires at most
once. So the search cannot loop, and there is deliberately no attempt ceiling to tune — a cap that can
never be reached is dead configuration, and one that CAN be reached silently truncates the fallback
ladder the user cares about.

BEST-SO-FAR (review H2). A retry must BEAT the attempt it retried (`policy.improves`) to replace it. When
it comes back with nothing, refused, or worse, the search goes BACK to the earlier usable attempt: its
knob is spent (`Attempt.lost`: never re-offered, never applied), and `decide` is asked again about the KEPT
report, so a knob still untried for it gets its turn, from it (`Try.base`). Only when none is left is the
kept attempt committed — `Commit.serial` names it — instead of being lost to the text's line timings, to
the next text, or silently overwritten. (It used to commit at the first retry that did not improve, which
ended the ladder there: a misplaced, thin windowed document whose RESHIFT did not help never tried the
mix, and an overshoot whose DROP_WINDOWS did not help never re-placed — review W1 r1; the global engine,
whose only knob is LINE_SYNC for an unusable document, never keeps a best and is unaffected.) The workflow
keeps each Try's document by serial, and each knob set writes its own file, so the earlier one is still on
disk to publish.

BEST-SO-FAR SPANS DOCUMENT KINDS (W4). A LINE_SYNC retry is judged by the same rule as any other, so the
line document of a text whose word document nothing related to its claims (`policy.decide` rule 6) must beat
that word document to replace it, and a line document its own gate refuses sends the search BACK to the words
rather than on to the next text. Nothing here changed to allow it — `_best` has always been "the best USABLE
result for the current text", and the only reason the two kinds never met on it is that LINE_SYNC used to be
offered to unusable word documents alone (which are never kept: there is nothing to keep). That is still the
other route to the knob, and there the line document publishes unopposed, because an incoherent highlight is
not a document.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import assert_never

from encore_worker.domain.lyrics.policy import (
    Accept,
    Attempt,
    Knob,
    NextText,
    Retime,
    Tier,
    Verdict,
    asr_is_mandatory,
    decide,
    improves,
    order_pool,
)
from encore_worker.domain.lyrics.report import TimingReport


@dataclass(frozen=True, slots=True)
class Candidate:
    """One text in the pool, plus the facts that decide which knobs apply to it.

    Deliberately NOT the text itself. The driver reasons about which text to try and how, never about
    what the words are, so it holds an index and a description and the workflow holds the content.
    That is also what keeps this serializable-free: nothing here needs to survive a DBOS checkpoint.
    """

    tier: Tier
    #: For `job:state` and the decision trail. "lrclib", "asr:vocals", "captions:authored".
    label: str
    has_windows: bool = False
    has_line_timings: bool = False
    has_own_line_timings: bool = False
    #: ANOTHER TEXT IN THIS POOL AGREES WITH IT ON THE WORDS (review M13, `policy.corroboration`). Breaks
    #: the tie WITHIN a tier, which used to be arrival order — and arrival order put the upload's SDH
    #: caption track ahead of every provider sheet, measured publishing over a clean sheet on Hello. Not a
    #: knob and not a gate: the lexical lift is still what refuses a wrong text, per attempt.
    #: WHAT IT IS WORTH, measured through whole jobs over a real multi-text pool (W7, `scripts/pool_gate.py`):
    #: the CHOSEN text moves on 0 of 12 songs — an SDH track of this song agrees with a sheet of it, so the
    #: tie-break cannot demote it — and the saving is ATTEMPTS, 12 against 36 with 24 refusals avoided over
    #: those songs. `policy.order_pool` carries the rest of the reading.
    corroborated: bool = False

    def first_attempt(self, *, aligned_on_stem: bool) -> Attempt:
        """The starting search state for this text: nothing tried, its own properties declared."""
        return Attempt(
            tried=frozenset(),
            aligned_on_stem=aligned_on_stem,
            has_windows=self.has_windows,
            has_line_timings=self.has_line_timings,
            has_own_line_timings=self.has_own_line_timings,
        )


@dataclass(frozen=True, slots=True)
class Try:
    """Align pool entry `index` with these parameters, then feed the report back to `record`."""

    index: int
    attempt: Attempt
    why: str
    #: This Try's number in the whole search, from 1: the handle a later `Commit` names its document by.
    serial: int = 0
    #: The serial of the attempt whose knobs this one extends — its RESHIFT reference (0: a text's first
    #: attempt). Usually the Try just before it; the KEPT attempt when that retry lost (best-so-far), since
    #: the search goes back to it and tries the next knob from there.
    base: int = 0


@dataclass(frozen=True, slots=True)
class Commit:
    """Pool entry `index` is good. Publish the document Try `serial` produced.

    Usually the latest Try's; an EARLIER one when the retry after it came back with nothing, refused, or
    worse (best-so-far). Naming it by serial rather than "the last one" is the whole fix: the workflow's
    `pending` document used to be what published, whatever the retry did to it.
    """

    index: int
    why: str
    serial: int = 0


@dataclass(frozen=True, slots=True)
class RunAsr:
    """Transcribe the audio and add the result to the pool via `extend`.

    Issued at most once, and only when the pool holds no ASR tier. This is the mandatory fallback: ASR
    needs only the audio, which every job past acquisition has, so an absent ASR text means the
    transcriber failed or was never built — a defect to recover from, not evidence about the song.
    """

    why: str


@dataclass(frozen=True, slots=True)
class GiveUp:
    """No publishable lyrics. The ONLY route to `NoLyrics`, and only ever after ASR was attempted —
    except on a PINNED search (`Search.pinned`), which gives up once its one text is spent and concludes
    nothing about the song: the workflow then publishes nothing over the candidate core already holds."""

    why: str


Next = Try | Commit | RunAsr | GiveUp


@dataclass
class Search:
    """Mutable position in the search. Driven entirely by reports, so a DBOS replay reproduces it.

    Usage is a loop with no decisions in it:

        step = search.begin()
        while True:
            match step:
                case Try(index, attempt, _):
                    report = await time_text(pool[index], attempt)
                    step = search.record(report)
                case RunAsr(_):
                    text = await transcribe(...)
                    step = search.extend(text) if text else search.asr_produced_nothing()
                case Commit(index, _) | GiveUp(_):
                    break
    """

    pool: list[Candidate]
    #: False when there is no vocals stem, so `Knob.ALIGN_ON_MIX` is unavailable from the start —
    #: alignment is already on the mix.
    aligned_on_stem: bool = True
    #: A HUMAN RE-PICK (review H5): the pool is the one text a person chose, and NOTHING may replace it —
    #: not the next text, not ASR. Once it is spent (nothing publishable, or refused — which the step no
    #: longer answers a pin with: it publishes one the envelope gate would refuse graded `low`) the search
    #: GIVES UP without transcribing, and the workflow publishes nothing, which leaves the candidate core
    #: already holds exactly as it is. The one exception to "GiveUp only after ASR", and a deliberate one:
    #: that rule is about concluding a song has NO WORDS, and a pinned job concludes nothing about the song
    #: — it answers "could THIS text be timed", and an automatic answer in its place is the H5 bug.
    pinned: bool = False
    #: `syncMode=lines` (review H5): no word timing is published. Every text's first and only attempt is the
    #: gated LINE_SYNC rung, a text with no line timings of its own is skipped, and the ASR fallback still has
    #: its turn (a transcript's segments are measured on this audio). Before H5 the mode was never read.
    line_only: bool = False

    _order: list[int] = field(default_factory=list, init=False)
    _cursor: int = field(default=0, init=False)
    _attempt: Attempt | None = field(default=None, init=False)
    _asr_requested: bool = field(default=False, init=False)
    _trail: list[dict[str, object]] = field(default_factory=list, init=False)
    #: Serial of the outstanding Try (0 before the first).
    _serial: int = field(default=0, init=False)
    #: The best USABLE result for the current text so far, as (serial, report, the attempt state that
    #: produced it), and the knob its retry is spending. Set when a usable report is retimed; cleared when
    #: the search moves to another text.
    _best: tuple[int, TimingReport, Attempt] | None = field(default=None, init=False)
    _retrying: Knob | None = field(default=None, init=False)

    def __post_init__(self) -> None:
        self._order = order_pool([c.tier for c in self.pool], [c.corroborated for c in self.pool])

    # ── the decision trail ───────────────────────────────────────────────────────────────────────

    @property
    def trail(self) -> tuple[dict[str, object], ...]:
        """Every decision, in order, for the `job:complete` frame.

        The old worker's equivalent went to stdout via `ctx.note()`, and its own comment records that
        the process log rotates — so "why did this job publish these lyrics" was unanswerable a week
        later. Here it is part of the completion payload and lands on the job row.
        """
        return tuple(self._trail)

    def _note(
        self,
        verdict: str,
        why: str,
        *,
        label: str | None = None,
        knob: str | None = None,
        kept: int | None = None,
    ) -> None:
        entry: dict[str, object] = {"verdict": verdict, "why": why}
        if label is not None:
            entry["text"] = label
        if knob is not None:
            entry["knob"] = knob
        if kept is not None:
            entry["kept"] = kept
        self._trail.append(entry)

    # ── driving ──────────────────────────────────────────────────────────────────────────────────

    def begin(self) -> Next:
        """The first thing to try."""
        if self.pinned:
            return self._at_cursor("re-timing the text a person pinned: nothing else is searched")
        return self._at_cursor("starting the pool")

    def record(self, report: TimingReport) -> Next:
        """Feed back the result of the outstanding `Try`."""
        if self._attempt is None:
            raise RuntimeError("Search.record called with no outstanding Try — call begin() first")
        current = self._current()
        index = self._order[self._cursor]
        if self._best is not None and self._retrying is not None:
            kept, before, base = self._best
            if not improves(before, report, self._retrying):
                # Every knob lost so far stays lost: the retry's attempt carries them, the kept one may not.
                back = base.with_lost(*self._attempt.lost, self._retrying)
                return self._back_to(kept, before, back, report)
        verdict: Verdict = decide(report, self._attempt)
        match verdict:
            case Accept(why):
                self._note("accept", why, label=current.label)
                return Commit(index, why, self._serial)
            case Retime(knob, why):
                self._note("retime", why, label=current.label, knob=knob.value)
                if report.usable:
                    self._best = (self._serial, report, self._attempt)
                self._retrying = knob
                self._attempt = self._attempt.with_tried(knob)
                return self._try(index, self._attempt, why, base=self._serial)
            case NextText(why):
                self._note("next", why, label=current.label)
                self._cursor += 1
                return self._at_cursor(why)
            case _ as unreachable:
                assert_never(unreachable)

    def extend(self, candidate: Candidate) -> Next:
        """Add a text produced on demand — the ASR fallback — and try it next.

        Appended to the END of the walk, NOT re-sorted into it. `RunAsr` fires only once every entry has
        been tried, so the on-demand text can only follow them. Re-sorting by tier put it BEFORE the
        MACHINE captions it ran after, and the cursor, parked at the new text, walked onto those captions
        a second time once it declined (review s11, repro'd with every attempt producing nothing: authored,
        authored + line-sync, machine, machine + line-sync, ASR, then both machine attempts again).
        """
        self.pool.append(candidate)
        self._order.append(len(self.pool) - 1)
        self._cursor = len(self._order) - 1
        self._note("asr-added", f"transcribed on demand: {candidate.label}", label=candidate.label)
        return self._at_cursor("trying the ASR fallback")

    def asr_produced_nothing(self) -> Next:
        """ASR ran and heard nothing. NOW the song may be called instrumental."""
        why = (
            "no publishable lyrics: every candidate was exhausted and transcribing the audio itself "
            "produced no text — the song has no intelligible words"
        )
        self._note("give-up", why)
        return GiveUp(why)

    # ── internals ────────────────────────────────────────────────────────────────────────────────

    def _current(self) -> Candidate:
        return self.pool[self._order[self._cursor]]

    def _try(self, index: int, attempt: Attempt, why: str, *, base: int = 0) -> Try:
        self._serial += 1
        return Try(index, attempt, why, self._serial, base)

    def _back_to(self, kept: int, before: TimingReport, attempt: Attempt, lost: TimingReport) -> Next:
        """The retry of attempt `kept` lost to it: go back to it, its knob spent (`attempt.lost`), and ask
        `decide` about the KEPT report again. A knob still untried for it is the next Try, from it; only
        when none is left is it committed. `_best` stays: the next retry must beat the same attempt."""
        current = self._current()
        index = self._order[self._cursor]
        spent = self._retrying.value if self._retrying is not None else "previous"
        worse = f"the {spent} retry {_worse_because(lost)}"
        self._attempt = attempt
        verdict = decide(before, attempt)
        if isinstance(verdict, Retime):
            why = f"back to attempt {kept} ({worse}): {verdict.why}"
            self._note("retime", why, label=current.label, knob=verdict.knob.value, kept=kept)
            self._retrying = verdict.knob
            self._attempt = attempt.with_tried(verdict.knob)
            return self._try(index, self._attempt, why, base=kept)
        # Accept — or NextText, which `decide` never answers a usable report with (only a usable report
        # is kept), and which would throw away a publishable document if it did.
        why = f"keeping attempt {kept}: {worse} — {before.summary()}"
        self._note("accept", why, label=current.label, kept=kept)
        return Commit(index, why, kept)

    def _at_cursor(self, why: str) -> Next:
        """The next `Try`, or the fallback/terminal when the pool is spent."""
        # A new text: another text's attempt is not a "best so far" for this one.
        self._best, self._retrying = None, None
        while self.line_only and self._cursor < len(self._order) and not self._current().has_line_timings:
            skipped = self._current()
            self._note(
                "next",
                "line-sync mode (syncMode=lines) decodes no word timing, and this text carries no line "
                "timings of its own to publish",
                label=skipped.label,
            )
            self._cursor += 1
        if self._cursor < len(self._order):
            current = self._current()
            self._attempt = current.first_attempt(aligned_on_stem=self.aligned_on_stem)
            if self.line_only:
                # LINE_SYNC is the attempt itself, so it is spent from the start: nothing follows it.
                self._attempt = self._attempt.with_tried(Knob.LINE_SYNC)
                why = f"line-sync mode (syncMode=lines): the text's own line timings, placed and gated; {why}"
            return self._try(self._order[self._cursor], self._attempt, why)

        self._attempt = None
        if self.pinned:
            why = (
                "no publishable lyrics from the pinned text: it was refused or could not be timed, and a "
                "person's pick is never replaced by another text or a transcription — publishing nothing, "
                "so the candidate the core already holds stays exactly as it is"
            )
            self._note("give-up", why)
            return GiveUp(why)
        # The pool is spent. Before concluding anything about the song, ASR must have had its turn.
        if not asr_is_mandatory([c.tier for c in self.pool]) and not self._asr_requested:
            self._asr_requested = True
            reason = (
                "every candidate is exhausted and the pool holds no ASR text — transcribing the audio "
                "before concluding the song has no words"
            )
            self._note("asr-fallback", reason)
            return RunAsr(reason)

        why = (
            "no publishable lyrics: every text in the pool was exhausted, including the ASR "
            "transcription of this audio"
        )
        self._note("give-up", why)
        return GiveUp(why)


def _worse_because(after: TimingReport) -> str:
    """Why a retry lost to the attempt it retried, for the trail."""
    if after.refused is not None:
        return f"was refused ({after.refused})"
    if not after.usable:
        return "produced nothing publishable" if not after.words and not after.lines else "is incoherent"
    return f"did not improve on it ({after.summary()})"
