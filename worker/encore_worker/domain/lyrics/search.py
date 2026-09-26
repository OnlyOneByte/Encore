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
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import assert_never

from encore_worker.domain.lyrics.policy import (
    Accept,
    Attempt,
    NextText,
    Retime,
    Tier,
    Verdict,
    asr_is_mandatory,
    decide,
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


@dataclass(frozen=True, slots=True)
class Commit:
    """Pool entry `index` is good. Publish it."""

    index: int
    why: str


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
    """No publishable lyrics. The ONLY route to `NoLyrics`, and only ever after ASR was attempted."""

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

    _order: list[int] = field(default_factory=list, init=False)
    _cursor: int = field(default=0, init=False)
    _attempt: Attempt | None = field(default=None, init=False)
    _asr_requested: bool = field(default=False, init=False)
    _trail: list[dict[str, object]] = field(default_factory=list, init=False)

    def __post_init__(self) -> None:
        self._order = order_pool([c.tier for c in self.pool])

    # ── the decision trail ───────────────────────────────────────────────────────────────────────

    @property
    def trail(self) -> tuple[dict[str, object], ...]:
        """Every decision, in order, for the `job:complete` frame.

        The old worker's equivalent went to stdout via `ctx.note()`, and its own comment records that
        the process log rotates — so "why did this job publish these lyrics" was unanswerable a week
        later. Here it is part of the completion payload and lands on the job row.
        """
        return tuple(self._trail)

    def _note(self, verdict: str, why: str, *, label: str | None = None, knob: str | None = None) -> None:
        entry: dict[str, object] = {"verdict": verdict, "why": why}
        if label is not None:
            entry["text"] = label
        if knob is not None:
            entry["knob"] = knob
        self._trail.append(entry)

    # ── driving ──────────────────────────────────────────────────────────────────────────────────

    def begin(self) -> Next:
        """The first thing to try."""
        return self._at_cursor("starting the pool")

    def record(self, report: TimingReport) -> Next:
        """Feed back the result of the outstanding `Try`."""
        if self._attempt is None:
            raise RuntimeError("Search.record called with no outstanding Try — call begin() first")
        current = self._current()
        verdict: Verdict = decide(report, self._attempt)
        match verdict:
            case Accept(why):
                self._note("accept", why, label=current.label)
                return Commit(self._order[self._cursor], why)
            case Retime(knob, why):
                self._note("retime", why, label=current.label, knob=knob.value)
                self._attempt = self._attempt.with_tried(knob)
                return Try(self._order[self._cursor], self._attempt, why)
            case NextText(why):
                self._note("next", why, label=current.label)
                self._cursor += 1
                return self._at_cursor(why)
            case _ as unreachable:
                assert_never(unreachable)

    def extend(self, candidate: Candidate) -> Next:
        """Add a text produced on demand — the ASR fallback — and try it next.

        Appended rather than inserted: `order_pool` re-sorts by tier, and an ASR entry sorts after every
        candidate anyway, so append-then-reorder puts it exactly where it belongs without the caller
        needing to know the ordering rule.
        """
        self.pool.append(candidate)
        self._order = order_pool([c.tier for c in self.pool])
        self._cursor = self._order.index(len(self.pool) - 1)
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

    def _at_cursor(self, why: str) -> Next:
        """The next `Try`, or the fallback/terminal when the pool is spent."""
        if self._cursor < len(self._order):
            current = self._current()
            self._attempt = current.first_attempt(aligned_on_stem=self.aligned_on_stem)
            return Try(self._order[self._cursor], self._attempt, why)

        self._attempt = None
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
