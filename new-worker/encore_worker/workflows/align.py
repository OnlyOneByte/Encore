"""The align flow: acquire words, put them on this recording's clock, publish.

`run_align` is a PLAIN async function taking the step surface as an argument, so the whole state machine
is drivable by fakes with no DBOS, no SQLite, no models and no network. The `@DBOS.workflow` wrapper is
`dbos_align` at the bottom and contains no decisions — that separation is what makes the interesting
behaviour testable as behaviour rather than only as a deployment.

DETERMINISM. Everything non-deterministic is behind `steps`: no wall clock, no random, no filesystem, no
sockets here. DBOS replays this body on recovery, so a stray `time.time()` would make a resumed job
diverge from the one that started.

ONE DELIBERATE DEPARTURE FROM THE OLD WORKER, worth stating because it removes a whole stage. The old
flow ran ASR on EVERY align job, eagerly, to build a "baseline" that comparative grading scored
candidates against — that is how it detected a wrong-song LRCLIB match. This flow does not, because
FORCED ALIGNMENT IS ITSELF THE WRONG-SONG DETECTOR: text that does not belong to this recording cannot
be aligned to it well, so coverage collapses and the placement residual blows up, which `policy.decide`
already reads. So ASR is paid for only when it is actually needed as a fallback, and a job whose first
candidate is good never runs a model at all.
"""

from __future__ import annotations

from typing import assert_never

from encore_worker.domain.lyrics.report import TimingReport
from encore_worker.domain.lyrics.search import (
    Candidate,
    Commit,
    GiveUp,
    RunAsr,
    Search,
    Try,
)
from encore_worker.steps.api import AlignSteps, NotOurJob, language_of
from encore_worker.steps.records import (
    AlignOutcome,
    AudioRef,
    JobRef,
    TextRef,
    TimedDoc,
    TimeRequest,
)

STATE_ACQUIRE = "acquire"
STATE_TEXTS = "texts"
STATE_TIME = "time"
STATE_ASR = "asr-fallback"
STATE_PUBLISH = "publish"

#: A report standing in for "this attempt produced nothing at all". Zero words fails `usable`, so the
#: policy treats it exactly as it treats incoherent word order: try a knob, or move on. Encoding the
#: failure as a REPORT rather than a separate branch keeps one decision function instead of two.
NOTHING_TIMED = TimingReport(words=0, coverage=0.0)


async def run_align(job: JobRef, steps: AlignSteps) -> AlignOutcome:
    """Run one align job to a terminal outcome.

    Returns rather than raises for every lyric outcome, including "this song has no words". Raises only
    on an infrastructure fault — no audio, no model — and on nothing else, because readiness waits on
    align and a raised job strands the song in "processing".
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
    texts = await _acquire_texts(job, audio, steps)

    search = Search(
        pool=[_candidate_of(t) for t in texts],
        aligned_on_stem=audio.vocals_path is not None,
    )
    attempt_no = 0
    #: The document produced by the outstanding `Try`. `record()` returns the NEXT step, so at `Commit`
    #: this still holds the attempt that earned it.
    pending: TimedDoc | None = None
    step = search.begin()

    while True:
        match step:
            case Try(index, attempt, why):
                attempt_no += 1
                text = texts[index]
                knob = _newest_knob(search)
                await steps.note(job, STATE_TIME, attempt_no, "try", why, knob)
                doc = await steps.time_text(
                    TimeRequest(
                        job=job,
                        text=text,
                        audio=audio,
                        language=language_of(job, text),
                        knobs=attempt.tried,
                        # The previous attempt on THIS text, as the reference a RESHIFT re-places
                        # against. Cleared when the search moves to a different text, since another
                        # source's line count and ordering are not a ruler for this one.
                        reference_starts=(
                            pending.line_starts if pending is not None and pending.label == text.label else ()
                        ),
                    )
                )
                # A step that produced nothing is judged by the same policy as a bad alignment.
                pending = doc
                step = search.record(doc.report if doc is not None else NOTHING_TIMED)

            case RunAsr(why):
                attempt_no += 1
                await steps.note(job, STATE_ASR, attempt_no, "asr-fallback", why, None)
                # The stem first when there is one: it transcribes materially better than the mix.
                heard = await steps.transcribe(job, audio, on_vocals=audio.vocals_path is not None)
                if heard is None and audio.vocals_path is not None:
                    # A stem that yields nothing is often over-suppressed rather than silent, so the
                    # mix gets its own turn before the song is called instrumental.
                    heard = await steps.transcribe(job, audio, on_vocals=False)
                if heard is None:
                    step = search.asr_produced_nothing()
                    continue
                texts.append(heard)
                step = search.extend(_candidate_of(heard))

            case Commit(_index, why):
                if pending is None:  # pragma: no cover - a Commit always follows a timed attempt
                    raise RuntimeError("Commit with no timed document — the search was driven wrongly")
                await steps.note(job, STATE_PUBLISH, attempt_no, "accept", why, None)
                settled = await steps.diarize(job, audio, pending)
                return await _publish(job, steps, settled, why, search)

            case GiveUp(why):
                await steps.note(job, STATE_PUBLISH, attempt_no, "no-lyrics", why, None)
                return await _publish(job, steps, None, why, search)

            case _ as unreachable:
                assert_never(unreachable)


async def _publish(
    job: JobRef, steps: AlignSteps, doc: TimedDoc | None, why: str, search: Search
) -> AlignOutcome:
    """Publish, treating a lost lease as a normal outcome rather than a failure.

    `NotOurJob` means the core reassigned this job while we worked — under load that is ordinary, and
    another worker is already doing or has done it. Escalating would turn a race into an alert.
    """
    try:
        await steps.publish(job, doc)
    except NotOurJob as lost:
        return AlignOutcome(
            published=None,
            why=f"abandoned before publishing: {lost}",
            trail=search.trail,
        )
    return AlignOutcome(published=doc, why=why, trail=search.trail)


async def _acquire_texts(job: JobRef, audio: AudioRef, steps: AlignSteps) -> list[TextRef]:
    """Every CHEAP source of words, in one pass. No models run here.

    Sequential rather than gathered, and that is a DBOS constraint rather than a preference: starting
    independent async sequences and gathering them makes the later interleaving timing-dependent, which
    a replay cannot reproduce. Fan-out needs child workflows, and three network calls do not earn one.

    A source that RAISES is allowed to fail the job; one that returns None simply has nothing. That
    asymmetry is the whole point — the old worker could not tell a provider that had been dead for a
    month from a library of instrumentals, because both produced no text.
    """
    found: list[TextRef] = []
    for text in (
        await steps.fetch_captions(job, automatic=False),
        await steps.fetch_provider_lyrics(job, audio),
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


def _candidate_of(text: TextRef) -> Candidate:
    """Describe a text to the search in terms of which knobs could apply to it."""
    return Candidate(
        tier=text.tier,
        label=text.label,
        has_windows=bool(text.windows),
        has_line_timings=text.has_line_timings,
        has_own_line_timings=text.has_own_timings,
    )


def _newest_knob(search: Search) -> str | None:
    """The knob this attempt just added, for the `job:state` frame.

    Read off the TRAIL rather than diffed against a remembered set: the trail already records each
    retime's knob in order, so there is one source for "what changed" instead of two that could disagree.
    """
    for entry in reversed(search.trail):
        if entry.get("verdict") == "retime":
            knob = entry.get("knob")
            return knob if isinstance(knob, str) else None
        if entry.get("verdict") in ("accept", "next", "asr-added"):
            return None
    return None
