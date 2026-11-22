"""The search for publishable lyrics, as a pure driver the workflow turns.

`policy.decide` judges ONE alignment. This walks the pool: which text to try next, with which knob, when to
run ASR on demand, and when to conclude the song has no words. It lives in `domain/` rather than in
`workflows/` so every branch is testable with no audio, no model and no DBOS, which leaves the workflow a
loop with no decisions in it.

Termination is structural rather than capped, a retry is judged best-so-far, and best-so-far spans document
kinds: `docs/arch/04-alignment.md` §3 has all three with the regression each one closed, and §12 (XA-05) has
the refusal-versus-decline rule the walk turns on.
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
    #: ANOTHER TEXT IN THIS POOL AGREES WITH IT ON THE WORDS (`policy.corroboration`), which breaks the tie
    #: WITHIN a tier where arrival order used to. Not a knob and not a gate; what it is worth, measured
    #: whole jobs, is LOG.md, "W7: the provider pool is real now".
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

    The caller is a loop with no decisions in it: `begin()`, then `record` a `Try`'s report, `extend` on a
    `RunAsr`, and break on `Commit` or `GiveUp` (`workflows/align.py` is the one such loop).
    """

    pool: list[Candidate]
    #: False when there is no vocals stem, so `Knob.ALIGN_ON_MIX` is unavailable from the start —
    #: alignment is already on the mix.
    aligned_on_stem: bool = True
    #: A HUMAN RE-PICK: the pool is the one text a person chose and NOTHING may replace it, so once it is
    #: spent the search GIVES UP without transcribing. The one deliberate exception to "GiveUp only after
    #: ASR", that rule being about concluding a song has NO WORDS (docs/arch/04-alignment.md §3).
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
