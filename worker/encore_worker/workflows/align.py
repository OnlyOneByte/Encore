"""The align flow: acquire words, put them on this recording's clock, publish.

`run_align` is a PLAIN async function taking the step surface as an argument, so the whole state machine is
drivable by fakes with no DBOS, no SQLite, no models and no network. Everything non-deterministic is behind
`steps`, DBOS replaying this body on recovery. No ASR runs unless the ladder needs one.
See docs/arch/04-alignment.md §2 for the pipeline and §3 for the ladder.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, replace
from typing import assert_never

from encore_worker.domain.lyrics.babble import babble
from encore_worker.domain.lyrics.policy import corroboration
from encore_worker.domain.lyrics.report import TimingReport
from encore_worker.domain.lyrics.search import (
    Candidate,
    Commit,
    GiveUp,
    RunAsr,
    Search,
    Try,
)
from encore_worker.protocol.vocabulary import SyncMode
from encore_worker.steps.api import (
    AlignSteps,
    NotOurJob,
    Pin,
    language_of,
    pin_of,
    store_ref,
    sync_mode_of,
)
from encore_worker.steps.records import (
    TIMING_WORD,
    AlignOutcome,
    AudioRef,
    JobRef,
    Refused,
    TextRef,
    TimedDoc,
    TimeRequest,
)

STATE_ACQUIRE = "acquire"
STATE_TEXTS = "texts"
STATE_TIME = "time"
STATE_ASR = "asr-fallback"
STATE_PUBLISH = "publish"

#: "This attempt produced nothing at all", as a REPORT rather than a branch: zero words fails `usable`, so
#: one decision function covers it. Neither a gate refusal nor a machinery fault comes through here
#: (invariant XA-17).
NOTHING_TIMED = TimingReport(words=0, coverage=0.0)

#: The completion's `lyricsNote` when the song has no lyrics because whisper's words were babble (core's
#: `LYRICS_NOTES`).
LYRICS_NOTE_BABBLE = "asr-babble"


async def run_align(job: JobRef, steps: AlignSteps) -> AlignOutcome:
    """Run one align job to a terminal outcome.

    Returns rather than raises for every lyric outcome, including "this song has no words", because
    readiness waits on align and a raised job strands the song in "processing". Raises only on an
    infrastructure fault, which nothing here catches so it reaches `transport.Client` with its own
    `retryable` — a fault that fails every attempt alike used to walk the ladder down to a published
    "no lyrics" for a song nothing had measured. Invariant XA-17.
    """
    audio = await steps.acquire_audio(job)
    await steps.note(
        job,
        STATE_ACQUIRE,
        0,
        "acquired",
        f"{audio.duration_sec:.0f}s audio"
        + (" with a vocals stem" if audio.vocals_path else " with NO vocals stem — aligning on the mix"),
        None,
    )
    # A PIN re-times the one text a person chose, and nothing else is acquired.
    pin = pin_of(job)
    texts = await (_acquire_pinned(job, pin, steps) if pin is not None else _acquire_texts(job, audio, steps))
    # `lines` is honoured only where its gate can work: a vocals stem (`_sync_mode_note` has the numbers).
    line_only = sync_mode_of(job) is SyncMode.LINES and audio.vocals_path is not None
    mode_note = _sync_mode_note(job, pin, stemless=audio.vocals_path is None)
    if mode_note is not None:
        await steps.note(job, STATE_TEXTS, 0, "sync-mode", mode_note, None)

    search = Search(
        pool=_pool_of(texts, line_only=line_only),
        aligned_on_stem=audio.vocals_path is not None,
        pinned=pin is not None,
        line_only=line_only,
    )
    attempt_no = 0
    #: Each Try's document by its serial, so a `Commit` can publish an EARLIER attempt than the latest and
    #: a RESHIFT re-places against the one it extends (`Try.base`; docs/arch/04-alignment.md §3).
    by_serial: dict[int, TimedDoc] = {}
    #: Every document written — staged in job scratch — which `publish` places in the store, so none is left
    #: unreported (`AlignOutcome.candidates`). A PINNED job stages only its committed one.
    written: list[TimedDoc] = []
    #: The texts a gate refused, by label: the frame withdraws what earlier jobs stored for their words
    #: (`AlignOutcome.refused`). A pin is never judged a wrong text, so a pinned job refuses none.
    refused: dict[str, TextRef] = {}
    lyrics_note: str | None = None
    step = search.begin()

    while True:
        match step:
            case Try(index, attempt, why, serial, base):
                attempt_no += 1
                text = texts[index]
                knob = _newest_knob(search)
                await steps.note(job, STATE_TIME, attempt_no, "try", why, knob)
                result = await steps.time_text(
                    TimeRequest(
                        job=job,
                        text=text,
                        audio=audio,
                        language=language_of(job, text),
                        knobs=attempt.tried,
                        # The attempt on THIS text whose knobs this one extends, as the reference a RESHIFT
                        # re-places against. Empty for a text's first attempt, since another source's line
                        # count and ordering are not a ruler for this one.
                        reference_starts=(
                            reference.line_starts
                            if (reference := by_serial.get(base)) is not None
                            and reference.label == text.label
                            else ()
                        ),
                    )
                )
                # A step that produced nothing is judged by the same policy as a bad alignment; one a gate
                # refused carries the refusal in its report, which ends this text.
                doc = result if isinstance(result, TimedDoc) else None
                if doc is not None:
                    if pin is None:
                        written.append(doc)
                    by_serial[serial] = doc
                if isinstance(result, Refused) and pin is None:
                    refused.setdefault(text.label, text)
                step = search.record(
                    result.report if isinstance(result, TimedDoc | Refused) else NOTHING_TIMED
                )

            case RunAsr(why):
                attempt_no += 1
                await steps.note(job, STATE_ASR, attempt_no, "asr-fallback", why, None)
                # The stem first when there is one: it transcribes materially better than the mix.
                heard = await _words_heard(job, audio, steps, on_vocals=audio.vocals_path is not None)
                if not isinstance(heard, TextRef) and audio.vocals_path is not None:
                    # A stem that yields nothing (or babble) is often over-suppressed rather than silent, so
                    # the mix gets its own turn before the song is called instrumental.
                    heard = await _words_heard(job, audio, steps, on_vocals=False) or heard
                if isinstance(heard, Babble):
                    step = search.asr_babbled(heard.why)
                    lyrics_note = LYRICS_NOTE_BABBLE
                    continue
                if heard is None:
                    step = search.asr_produced_nothing()
                    continue
                texts.append(heard)
                step = search.extend(_candidate_of(heard, line_only=line_only))

            case Commit(_index, why, serial):
                chosen = by_serial.get(serial)
                if chosen is None:  # pragma: no cover - a Commit always names a Try that wrote a document
                    raise RuntimeError(f"Commit of attempt {serial}, which wrote no document")
                # A TEXT THIS JOB PUBLISHES IS NOT A TEXT IT REFUSED, even where one of its rungs was: under
                # best-so-far a retry can be refused while the attempt it retried publishes. `refused` makes
                # the frame WITHDRAW earlier jobs' documents for those words, which is the opposite of what
                # it is for here; the rung's refusal stays on the trail, where a rung's verdict belongs.
                refused.pop(chosen.label, None)
                await steps.note(job, STATE_PUBLISH, attempt_no, "accept", why, None)
                settled = await steps.diarize(job, audio, chosen)
                outcome = await _publish(job, steps, settled, why, search, written, pin, refused.values())
                return replace(outcome, sync_mode=_ran_as(line_only).value)

            case GiveUp(why):
                # A pin that could not be timed concludes nothing about the song: the lyrics core already
                # holds stay published, so the trail must not read "no lyrics".
                verdict = "no-lyrics" if pin is None else "pin-declined"
                await steps.note(job, STATE_PUBLISH, attempt_no, verdict, why, None)
                outcome = await _publish(job, steps, None, why, search, written, pin, refused.values())
                return replace(outcome, sync_mode=_ran_as(line_only).value, lyrics_note=lyrics_note)

            case _ as unreachable:
                assert_never(unreachable)


async def _publish(
    job: JobRef,
    steps: AlignSteps,
    doc: TimedDoc | None,
    why: str,
    search: Search,
    written: Sequence[TimedDoc] = (),
    pin: Pin | None = None,
    refused: Iterable[TextRef] = (),
) -> AlignOutcome:
    """Publish, treating a lost lease as a normal outcome rather than a failure.

    Every attempt was staged in job scratch and is placed only after re-asserting ownership; a PINNED job
    places only its accepted document, at the pinned ref. Invariant XA-13; docs/arch/04-alignment.md §11.
    """
    try:
        await steps.publish(job, doc, placing=written)
    except NotOurJob as lost:
        # Nothing was placed: `publish` places only after the ownership check. The attempts are in job
        # scratch, which is reclaimed with the job, so there is nothing in the store to report.
        return AlignOutcome(
            published=None,
            why=f"abandoned before publishing: {lost}",
            trail=search.trail,
            candidates=(),
            abandoned=True,
        )
    placed = [doc] if pin is not None and doc is not None else list(written)
    return AlignOutcome(
        published=replace(doc, ref=store_ref(job, doc.ref)) if doc is not None else None,
        why=why,
        trail=search.trail,
        candidates=tuple(replace(d, ref=store_ref(job, d.ref)) for d in placed),
        refused=tuple(refused),
    )


@dataclass(frozen=True, slots=True)
class Babble:
    """A transcript withheld because it is not words (`domain.lyrics.babble`)."""

    label: str
    why: str


async def _words_heard(
    job: JobRef, audio: AudioRef, steps: AlignSteps, *, on_vocals: bool
) -> TextRef | Babble | None:
    """One transcription, withheld from the pool when it is babble (#1288)."""
    heard = await steps.transcribe(job, audio, on_vocals=on_vocals)
    if heard is None:
        return None
    why = babble(str(segment.get("text") or "") for segment in heard.segments)
    if why is None:
        return heard
    await steps.note(job, STATE_ASR, 0, "asr-babble", f"{heard.label} withheld: {why}", None)
    return Babble(heard.label, why)


async def _acquire_pinned(job: JobRef, pin: Pin, steps: AlignSteps) -> list[TextRef]:
    """A pinned job's pool: the ONE text a person chose. No provider, caption track or model runs.

    Empty when the pin cannot be honoured, which the pinned search answers by publishing nothing: a ref
    outside the lyrics store is refused here before anything reads it, and a stored candidate that is gone
    or has no readable line is the step's `None`, with the step naming why.
    """
    if pin.refused is not None:
        await steps.note(
            job,
            STATE_TEXTS,
            0,
            "pin-refused",
            f"{pin.refused}; publishing nothing rather than reading or writing outside the lyrics store",
            None,
        )
        return []
    text = await steps.fetch_pinned_text(job)
    if text is None:
        return []
    await steps.note(
        job,
        STATE_TEXTS,
        0,
        "pinned",
        f"re-timing {pin.ref} as {text.label} ({len(text.segments)} line(s), "
        f"{'the paste' if pin.pasted is not None else 'the stored words'}, untimed: a blind decode); "
        "providers, captions and ASR skipped",
        None,
    )
    return [text]


async def _acquire_texts(job: JobRef, audio: AudioRef, steps: AlignSteps) -> list[TextRef]:
    """Every CHEAP source of words, in one pass. No models run here.

    Sequential rather than gathered, which is a DBOS constraint: a gathered interleaving is timing-dependent
    and a replay cannot reproduce it. A source that RAISES may fail the job; one returning None simply has
    nothing, which is a distinction the worker this replaced could not make.
    """
    found: list[TextRef] = []
    # EVERY PROVIDER'S SHEET, not the first one's: LRCLIB is a candidate even on a song lrcmux answered.
    # Which is tried first is decided by corroboration (`_pool_of`), so this order is only about COST.
    for text in (
        await steps.fetch_captions(job, automatic=False),
        *await steps.fetch_provider_lyrics(job, audio),
        await steps.fetch_captions(job, automatic=True),
    ):
        if text is not None:
            found.append(text)
    await steps.note(
        job,
        STATE_TEXTS,
        0,
        "acquired",
        f"{len(found)} text(s): {', '.join(t.label for t in found) or 'none'}",
        None,
    )
    return found


def _ran_as(line_only: bool) -> SyncMode:
    """The sync mode the job actually ran — what its completion facts report (`__main__._align_facts`)."""
    return SyncMode.LINES if line_only else SyncMode.FORCED


def _sync_mode_note(job: JobRef, pin: Pin | None, *, stemless: bool = False) -> str | None:
    """The trail's word on the job's `syncMode`, when it changes what runs (or is not honoured as sent).

    `lines` on a song with NO VOCALS STEM is aligned as `forced`, because the LINE_SYNC rung's gates are
    calibrated on the stem and on the mix the sheet gate cannot separate a right sheet from a wrong one.
    The populations: docs/benchmarks/forced-alignment/LOG.md, "Why `syncMode=lines` needs a vocals stem".
    """
    asked = job.param_str("syncMode")
    if asked == SyncMode.LINES and pin is not None:
        return (
            "syncMode=lines does not apply to a pin: its text has no line timings of its own to keep "
            "(a stored candidate's are the ones being replaced), so it is aligned"
        )
    if asked == SyncMode.LINES and stemless:
        return (
            "syncMode=lines needs a vocals stem: the line-sync rung's sheet gate cannot tell a right text "
            "from a wrong one on the mix (39/416 right, 3/320 wrong, measured), so this song is aligned as "
            "forced, under the forced path's wrong-text gate"
        )
    if asked == SyncMode.LINES:
        return (
            "syncMode=lines: every text publishes its own line timings through the gated line-sync rung "
            "(the stem's emissions read only to check its words are sung where it claims them), and no word "
            "timing is published"
        )
    if asked is not None and asked not in {mode.value for mode in SyncMode}:
        return (
            f"syncMode {asked!r} is not a mode this worker knows "
            f"({', '.join(mode.value for mode in SyncMode)}); aligning as '{SyncMode.FORCED.value}'"
        )
    return None


def _candidate_of(text: TextRef, *, line_only: bool = False, corroborated: bool = False) -> Candidate:
    """Describe a text to the search in terms of which knobs could apply to it.

    `has_line_timings` asks "did this text bring timings from elsewhere", which is `has_own_timings` and NOT
    the `TIMING_LINE` label: every word-level sheet is labelled `TIMING_WORD`, so reading the label cost an
    lrcmux word answer and every word-level LRC sheet the rung in the DEFAULT sync mode — their one remaining
    fallback once their word timing failed to ship. The `line_only` clause beside it covers the one text
    `has_own_timings` excludes, the ASR transcript, whose lines publish only when line timing was asked for.
    """
    return Candidate(
        tier=text.tier,
        label=text.label,
        has_windows=bool(text.windows),
        has_line_timings=text.has_own_timings or (line_only and text.timing == TIMING_WORD),
        has_own_line_timings=text.has_own_timings,
        corroborated=corroborated,
    )


def _pool_of(texts: Sequence[TextRef], *, line_only: bool) -> list[Candidate]:
    """The search's pool, with each text told whether ANOTHER text in it agrees on the words.

    Computed over the WHOLE pool at once rather than per text, which is why it is not inside
    `_candidate_of`: corroboration is a property of the set. Pure, so it adds no step and no DBOS
    checkpoint. The ASR fallback, appended later by `search.extend`, is deliberately not re-scored: it
    arrives after every candidate has been tried.
    """
    # WITH THE LABELS, because agreement counts only across INDEPENDENT witnesses (`policy.witness_of`):
    # two provider sheets are one metadata query answered twice.
    agrees = corroboration(
        [[str(segment.get("text") or "") for segment in text.segments] for text in texts],
        [text.label for text in texts],
    )
    return [
        _candidate_of(text, line_only=line_only, corroborated=backed)
        for text, backed in zip(texts, agrees, strict=True)
    ]


def _newest_knob(search: Search) -> str | None:
    """The knob this attempt just added, for the `job:state` frame.

    Read off the TRAIL rather than diffed against a remembered set, so "what changed" has one source.
    """
    for entry in reversed(search.trail):
        if entry.get("verdict") == "retime":
            knob = entry.get("knob")
            return knob if isinstance(knob, str) else None
        if entry.get("verdict") in ("accept", "next", "asr-added"):
            return None
    return None
