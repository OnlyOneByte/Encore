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
be aligned to it well: the step's envelope gates refuse it (`Refused`), and `policy.decide` ends that text
there rather than line-syncing it. So ASR is paid for only when it is actually needed as a fallback, and a
job whose first candidate is good never runs a model at all.

WHAT THE JOB ASKS FOR IS HONOURED (review H5, regressed in f04a2d0e when the old worker went; its
`steps/lyrics/pinned.py` semantics are kept). Each param is read by one pure function in `steps/api.py`, so
this body and the steps cannot read it two ways, and a replay reads it the same:

  * `pinnedText` / `pinnedRef` — a PERSON'S re-pick (`pin_of`). The pool is that one text, untimed (a
    blind decode through the normal global path): the paste, or the words of the stored candidate the ref
    names (its whole text, `sourceLines`, where its decode had dropped lines). It is never judged a wrong
    text — a person chose it, and the old worker never graded a pin — so one the envelope gate would
    refuse publishes with every line `low`. Nothing else is acquired, no ASR runs, and a text that cannot
    be timed at all publishes NOTHING rather than whatever an automatic search would find — core keeps
    showing the candidate it holds. The accepted attempt is published under the pinned ref (the manual key
    `derived/lyrics/{id}-manual-word.json` for a paste), so core's merge overwrites the candidate the
    person chose instead of adding a rival. Before H5 a paste was silently replaced by the search.
  * `syncMode` — `lines` publishes no word timing: every text's only attempt is its own line timings through
    the gated LINE_SYNC rung (`Search.line_only`), whose checks read one emission matrix of the stem to ask
    whether its words are the ones sung (the lexical lift, review W1 r2) and whether its lines are claimed
    where they are sung (the text's own blind decode, W3). A pin is always aligned (`sync_mode_of`), and so
    is a song with no vocals stem, where that rung's gate cannot work (`_sync_mode_note`).
  * `asrModel` — the checkpoint the ASR fallback loads (`AlignStepsImpl.transcribe`, `asr_model_of`).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import replace
from typing import assert_never

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

#: A report standing in for "this attempt produced nothing at all". Zero words fails `usable`, so the
#: policy treats it exactly as it treats incoherent word order: try a knob, or move on. Encoding the
#: failure as a REPORT rather than a separate branch keeps one decision function instead of two. A GATE
#: refusal is not this: the step returns `Refused`, whose report says so, and the policy ends the text.
#: Nor is a MACHINERY fault: the step raises `InfraFault` and the job fails (review M7), because a model
#: that will not load fails every attempt alike, and walking the ladder over it ended in "no lyrics".
NOTHING_TIMED = TimingReport(words=0, coverage=0.0)


async def run_align(job: JobRef, steps: AlignSteps) -> AlignOutcome:
    """Run one align job to a terminal outcome.

    Returns rather than raises for every lyric outcome, including "this song has no words". Raises only
    on an infrastructure fault — no audio, no model — and on nothing else, because readiness waits on
    align and a raised job strands the song in "processing".

    The steps hold that line: `time_text` raises only `adapters.ports.InfraFault` (a model that would not
    download, a kernel the installed torchaudio no longer ships, a device fault, audio ffmpeg would not
    decode), and nothing here catches it, so it reaches `transport.Client` with its own `retryable`.
    Before review M7 each was a declined attempt, and one that fails every attempt alike ran the ladder
    down to a published "no lyrics" for a song nothing had measured.
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
    # A PIN re-times the one text a person chose, and nothing else is acquired (review H5).
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
    #: Each Try's document by its serial, so a `Commit` can publish an EARLIER attempt than the latest
    #: (best-so-far: a retry that came back worse, refused or empty must not lose the one it retried), and
    #: a RESHIFT re-places against the attempt it extends (`Try.base`).
    by_serial: dict[int, TimedDoc] = {}
    #: Every document written — staged in job scratch — which `publish` places in the store, so none is
    #: left unreported: see `AlignOutcome.candidates` for why an unreported document is a permanent leak
    #: rather than a missing nicety. A PINNED job's attempts are not among them: only the committed one is
    #: placed, at the pinned ref (`_publish`); the rest go with the scratch.
    written: list[TimedDoc] = []
    #: The texts a gate refused, by label: the frame withdraws what earlier jobs stored for their words
    #: (`AlignOutcome.refused`). A pin is never judged a wrong text, so a pinned job refuses none.
    refused: dict[str, TextRef] = {}
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
                        # The attempt on THIS text whose knobs this one extends (`Try.base`: the
                        # previous one, or the one best-so-far went back to), as the reference a RESHIFT
                        # re-places against. None for a text's first attempt, since another source's line
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
                heard = await steps.transcribe(job, audio, on_vocals=audio.vocals_path is not None)
                if heard is None and audio.vocals_path is not None:
                    # A stem that yields nothing is often over-suppressed rather than silent, so the
                    # mix gets its own turn before the song is called instrumental.
                    heard = await steps.transcribe(job, audio, on_vocals=False)
                if heard is None:
                    step = search.asr_produced_nothing()
                    continue
                texts.append(heard)
                step = search.extend(_candidate_of(heard, line_only=line_only))

            case Commit(_index, why, serial):
                chosen = by_serial.get(serial)
                if chosen is None:  # pragma: no cover - a Commit always names a Try that wrote a document
                    raise RuntimeError(f"Commit of attempt {serial}, which wrote no document")
                # A TEXT THIS JOB PUBLISHES IS NOT A TEXT IT REFUSED, even where one of its rungs was: with
                # best-so-far a retry can be refused while the attempt it retried publishes — an
                # ALIGN_ON_MIX retry the envelope gate turned down (W1), and since W4 a LINE_SYNC retry the
                # line gate turned down for a word document nothing related to its claims. `refused` makes
                # the frame WITHDRAW earlier jobs' documents for those words (`superseded_candidates`), and
                # withdrawing them for words this job just published is the opposite of what that is for.
                # The refusal stays on the trail, which is where a rung's verdict belongs.
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
                return replace(outcome, sync_mode=_ran_as(line_only).value)

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

    `NotOurJob` means the core reassigned this job while we worked — under load that is ordinary, and
    another worker is already doing or has done it. Escalating would turn a race into an alert.

    EVERY ATTEMPT WAS STAGED in job scratch (`steps.api.attempt_ref`), and `publish` places them in the
    store only after re-asserting ownership: every document this job wrote, at its store ref
    (`steps.api.store_ref`), which is what the outcome reports. So a job that never gets here — failed by
    an `InfraFault` mid-ladder, or reassigned — has put nothing in the store and leaves nothing unreported
    there (review W1 r1: its earlier attempts used to leak), and a re-align cannot overwrite the document
    the TV is showing with an attempt the ladder may still reject.

    A PINNED job places only its accepted document, at the pinned ref: that ref is the file the TV is
    showing right now (core's override already points at it), and a rejected attempt must not become a
    rival candidate beside it. Nothing placed, nothing reported: a pin that timed nothing leaves core's
    candidate as it was.

    The texts a gate `refused` ride on the outcome only when the job is still ours: the frame withdraws what
    earlier jobs stored for their words (`AlignOutcome.refused`), and a lost lease reports nothing.
    """
    try:
        await steps.publish(job, doc, placing=written)
    except NotOurJob as lost:
        # Nothing was placed: `publish` places only after the ownership check. The attempts are in job
        # scratch, which is reclaimed with the job, so there is nothing in the store to report.
        return AlignOutcome(
            published=None, why=f"abandoned before publishing: {lost}", trail=search.trail, candidates=()
        )
    placed = [doc] if pin is not None and doc is not None else list(written)
    return AlignOutcome(
        published=replace(doc, ref=store_ref(job, doc.ref)) if doc is not None else None,
        why=why,
        trail=search.trail,
        candidates=tuple(replace(d, ref=store_ref(job, d.ref)) for d in placed),
        refused=tuple(refused),
    )


async def _acquire_pinned(job: JobRef, pin: Pin, steps: AlignSteps) -> list[TextRef]:
    """A pinned job's pool: the ONE text a person chose. No provider, caption track or model runs.

    Empty when the pin cannot be honoured, which the pinned search answers by publishing nothing (the old
    worker's STOP): a ref outside the lyrics store is refused here, before anything reads it; a stored
    candidate that is gone or has no readable line is the step's `None`, and the step names why.
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

    Sequential rather than gathered, and that is a DBOS constraint rather than a preference: starting
    independent async sequences and gathering them makes the later interleaving timing-dependent, which
    a replay cannot reproduce. Fan-out needs child workflows, and three network calls do not earn one.

    A source that RAISES is allowed to fail the job; one that returns None simply has nothing. That
    asymmetry is the whole point — the old worker could not tell a provider that had been dead for a
    month from a library of instrumentals, because both produced no text.
    """
    found: list[TextRef] = []
    # EVERY PROVIDER'S SHEET, not the first one's (review M13): `fetch_provider_lyrics` returns a LIST, so
    # LRCLIB is a candidate even on a song lrcmux answered. Which of them is tried first is then decided by
    # corroboration rather than by this order (`_pool_of`), so the sequence here is only about COST — the
    # two caption fetches shell out to yt-dlp and the providers are one HTTP request each.
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

    `lines` ON A SONG WITH NO VOCALS STEM is aligned as `forced` (review W1 r1). The LINE_SYNC rung publishes
    a text's own line timings only past gates calibrated on the stem (since W3 the lexical lift and the
    text's own blind decode, the sheet-span envelope gate where the decode cannot be read; on the mix the
    lift's populations overlap, `domain/lyrics/lexical`). The sheet gate reads the text's claimed spans
    against the singing, and on the MIX the band fills every silence it reads: measured over every timed bench
    case with each song's mix in place of its stem (`scripts/sheet_gate.py --target mix`), authored-caption
    spans pass 39 of 416 right texts and 3 of 320 wrong ones (truth claims 8/32), LRC spans 37/416 and 3/320
    (truth 3/32), and no threshold does better than 60/416 at the same 3/320 (truth medians r 0.33 against
    the wrong texts' 0.17, whose top decile reaches 0.32). Line-only there refused nearly every correct
    sheet for an ASR transcript or no lyrics; before H5 the mode was ignored and those songs were
    word-aligned, under the forced path's own wrong-text gate — which is what they get again.
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

    Under `syncMode=lines` a WORD-timed text (a transcript, a word-level sheet) line-syncs too: its
    segments carry their lines' spans, and the rung publishes those lines without the words.

    THE LINE_SYNC RUNG READS `has_own_timings`, NOT THE `TIMING_LINE` LABEL (W5 review r2-correctness-2).
    Both facts here are "this text brought timings from elsewhere": a word-level sheet carries its lines'
    spans too, and since `clean_segments` rewrites word lists as tuples EVERY word-level sheet is labelled
    `TIMING_WORD` (`align_steps._has_word_spans`), so reading the label cost an lrcmux word answer and every
    A2 LRC sheet the rung in the DEFAULT sync mode — the one fallback that could still publish their own
    line timings after their word timing failed to ship. The `line_only` clause stays beside it because it
    covers the one text `has_own_timings` deliberately excludes, the ASR transcript, whose lines publish
    only when the caller asked for line timing in the first place.
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
    """The search's pool, with each text told whether ANOTHER text in it agrees on the words (M13).

    Computed over the WHOLE pool at once rather than per text, which is why it is not inside
    `_candidate_of`: corroboration is a property of the set. Pure (`policy.corroboration` reads only the
    words), so this adds no step and no DBOS checkpoint — and the ASR fallback, appended later by
    `search.extend`, is deliberately not re-scored: it arrives after every candidate has been tried, so
    nothing about the order it joins at is still a decision.
    """
    # WITH THE LABELS, because agreement only counts across INDEPENDENT witnesses (`policy.witness_of`,
    # W5 review r1-correctness-4): two provider sheets are one metadata query answered twice.
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
