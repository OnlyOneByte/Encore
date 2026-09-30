"""The real `AlignSteps`: thin shells that touch the world and return checkpointable records.

Each method resolves an adapter, calls a pure domain function, and returns data. The judgement stays in
`domain/`, so this layer has almost no branches — which is the point. A step with a decision in it is a
decision that cannot be unit-tested without I/O.

WHY A CLASS AND NOT MODULE FUNCTIONS. A step needs the adapters, the transport (to emit `job:state`) and
the config, and none of those are serializable — so they cannot be step ARGUMENTS. Holding them on an
instance built once at startup keeps every step signature made of plain data, which is what DBOS
requires to checkpoint it.

THE DBOS DECORATORS ARE APPLIED IN `dbos_steps.py`, not here. This class is the behaviour; that module
wraps it. The split means the whole thing is testable by calling the methods directly, with no DBOS
launched and no SQLite file.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import time
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from functools import partial
from statistics import median
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    import numpy as np

    from encore_worker.domain.audio.activity import ShiftFit
    from encore_worker.domain.lyrics.generate import Generated, Line
    from encore_worker.domain.lyrics.reconcile import AsClaimed

from encore_worker.adapters import ports
from encore_worker.adapters.ports import InfraFault
from encore_worker.artifacts import keys
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics import (
    attribute,
    claimmap,
    ends,
    lexical,
    margin,
    measure,
    place,
    presplit,
)
from encore_worker.domain.lyrics.policy import Knob, Tier
from encore_worker.domain.lyrics.report import Engine, TimingReport
from encore_worker.host.config import ASR_MODELS, Config
from encore_worker.protocol.vocabulary import Stage
from encore_worker.steps.api import NotOurJob, as_segments, asr_model_of, attempt_ref, pin_of, store_ref
from encore_worker.steps.records import (
    TIMING_LINE,
    TIMING_WORD,
    AudioRef,
    JobRef,
    Refused,
    TextRef,
    TimedDoc,
    TimeRequest,
    tier_of_label,
)


@dataclass
class Adapters:
    """Every heavy seam this worker resolved at startup. Any may be absent on a given box."""

    fetcher: ports.AudioFetcher | None = None
    probe: ports.AudioProbe | None = None
    captions: ports.CaptionSource | None = None
    #: Lyrics providers IN PRIORITY ORDER. A chain rather than one, because a multiplexer covers most
    #: songs and a direct provider covers the ones it does not — and a network that blocks one may reach
    #: the other. First hit wins; see `fetch_provider_lyrics` for why a failure does not stop the chain.
    providers: tuple[ports.LyricsProvider, ...] = ()
    transcriber: ports.Transcriber | None = None
    #: Builds the transcriber for a job's `asrModel` when that is not the checkpoint `transcriber` was
    #: built with (review H5: the setting was never read, so a room's choice changed nothing). Cheap: the
    #: adapter caches loaded weights per checkpoint. None on a box that builds only the one.
    transcriber_for: Callable[[str], ports.Transcriber | None] | None = None
    aligner: ports.Aligner | None = None
    diarizer: ports.Diarizer | None = None


class Reporter(Protocol):
    """What a step uses to talk to the core. Narrowed so a step cannot send arbitrary frames.

    A Protocol, so `transport.Client` satisfies it structurally without this layer importing it — which
    would invert the dependency direction (`transport` sits above `steps`).
    """

    async def progress(self, job_id: str, stage: Stage, pct: int) -> None: ...

    async def state(
        self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None: ...

    async def confirm_ownership(self, job_id: str, *, timeout_sec: float = 10.0) -> bool: ...

    def explain_ownership(self, job_id: str) -> str: ...


class AlignStepsImpl:
    """`AlignSteps`, for real."""

    def __init__(self, *, config: Config, adapters: Adapters, reporter: Reporter) -> None:
        self._cfg = config
        self._a = adapters
        self._out = reporter

    # ── acquisition ──────────────────────────────────────────────────────────────────────────────

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        """The bytes and their duration. Raises when the source is unreachable — nothing substitutes.

        A LOCAL source is already on disk and must not be downloaded: `source_uri` is then a path to
        read, not a thing to fetch. Deciding that from the DECLARED fetcher rather than by sniffing the
        URI's shape matters — an unrecognised scheme would otherwise reach ffmpeg stages later as an
        opaque failure.
        """
        local = job.param_str("fetcher") == "local"
        path = job.source_uri or ""
        if local:
            # A LOCAL source_uri is a STORE REF, not a path: core's local fetcher is
            # `uri: (sourceRef) => sourceRef`, so it arrives relative to the media volume — and only this
            # worker knows where that volume is mounted. Handing the bare ref to ffmpeg resolves it against
            # the process CWD instead, which fails as `Error opening input: No such file or directory` with
            # nothing naming the media dir. Found by running against a live core.
            if path and not os.path.isabs(path):
                path = os.path.join(job.media_dir, path)
            if not os.path.isfile(path):
                # Named explicitly, because "the volume is mounted somewhere else" and "the file is gone"
                # look identical several stages later inside ffmpeg.
                raise _Permanent(
                    f"local source {job.source_uri!r} resolves to {path!r}, which is not a file — "
                    f"check this worker's media volume (currently {job.media_dir!r}) matches the core's"
                )
        else:
            if self._a.fetcher is None:
                raise _Permanent("this worker has no audio fetcher, so it cannot acquire a remote source")
            path = await asyncio.to_thread(self._a.fetcher.fetch, path, self._work(job), on_progress=None)

        duration = 0.0
        if self._a.probe is not None:
            duration = await asyncio.to_thread(self._a.probe.duration_sec, path)
        return AudioRef(path=path, duration_sec=duration, vocals_path=self._vocals_of(job))

    def _vocals_of(self, job: JobRef) -> str | None:
        """The stem a previous stems job published, if it is actually on disk.

        Checked rather than assumed: align is chained after stems, but a stems job that refused to publish
        a silent instrumental leaves the ref recorded and the file absent. Aligning against a path that
        does not exist fails deep inside the model instead of degrading to the mix.

        FALLS BACK TO THE CONVENTIONAL KEY, because the core does NOT send `vocalsRef` on an align
        assignment — it sends `fetcher`, `asrModel`, `syncMode` and the lookup keys, and nothing more
        (`dispatch.ts assignParams`). Reading only the param meant every align ran on the MIX even when a
        clean vocals stem was sitting right there: materially worse timings, because the band smears word
        boundaries, AND it silently removed `Knob.ALIGN_ON_MIX` from the retry ladder by making the mix the
        starting point rather than the fallback.

        Every known extension is tried, for the same reason core's `legacyVocalsRefs` does: the publish
        format is configurable, so a row separated under an earlier setting has its own ext forever.
        """
        named = job.param_str("vocalsRef")
        candidates = (
            [named]
            if named is not None
            else [keys.vocals_key(job.media_id, ext) for ext in keys.KNOWN_STEM_EXTS]
        )
        for ref in candidates:
            path = os.path.join(job.media_dir, ref)
            if os.path.isfile(path):
                return path
        return None

    async def fetch_captions(self, job: JobRef, *, automatic: bool) -> TextRef | None:
        """The upload's caption track. A miss is the common case and must not raise."""
        if self._a.captions is None or not job.source_uri:
            return None
        kind = "auto-captions" if automatic else "captions"
        try:
            cues = await asyncio.to_thread(
                self._a.captions.fetch, job.source_uri, self._work(job, kind), automatic=automatic
            )
        except Exception:  # noqa: BLE001 - no track / no yt-dlp / no network are all the same miss
            return None
        if not cues:
            return None
        return TextRef(
            # A machine track is evidence of what is audible, never a claim about the words — so it
            # wears the MACHINE tier and can only publish once every candidate and ASR is spent.
            tier=Tier.MACHINE if automatic else Tier.CANDIDATE,
            label=f"captions:{'machine' if automatic else 'authored'}",
            segments=as_segments(cues),
            timing=TIMING_LINE,
        )

    async def fetch_provider_lyrics(self, job: JobRef, audio: AudioRef) -> TextRef | None:
        """A lyrics sheet by metadata, from the first provider that has one.

        Requires BOTH artist and track. A lookup on a guessed title returns another song's words, which
        is worse than a miss — and the wrong-song text then aligns badly and costs a retry to discover.

        A PROVIDER THAT RAISES DOES NOT STOP THE CHAIN. One being unreachable is exactly when the next
        matters most: a network that blocks one host may reach another. The failure is still surfaced as
        a note rather than swallowed, because "every provider is down" and "this song is obscure" must
        stay distinguishable — that conflation is what once hid a month-long provider outage.
        """
        artist, track = job.param_str("artist"), job.param_str("track")
        if artist is None or track is None:
            return None

        failures: list[str] = []
        for provider in self._a.providers:
            try:
                cues = await asyncio.to_thread(
                    provider.fetch, artist=artist, track=track, duration_sec=audio.duration_sec
                )
            except Exception as failed:  # noqa: BLE001 - try the next provider, but say what happened
                failures.append(f"{provider.name}: {failed}")
                continue
            if not cues:
                continue
            return TextRef(
                tier=Tier.CANDIDATE,
                label=_provider_label(provider),
                segments=as_segments(cues),
                timing=_timing_of(provider, cues),
            )

        if failures and len(failures) == len(self._a.providers):
            # EVERY provider failed, which is a provider-side event rather than a fact about this song.
            # Raising would fail the job; the ASR tier can still serve it, so this is reported and the
            # ladder continues.
            await self.note(job, "texts", 0, "providers-down", "; ".join(failures), None)
        return None

    async def fetch_pinned_text(self, job: JobRef) -> TextRef | None:
        """The ONE text a pinned job re-times: the paste, verbatim, or the stored candidate's own words.

        UNTIMED EITHER WAY, which makes the attempt a blind decode (no claims) through the normal global
        path — whose envelope gate does not refuse a pin (`_time_text_global`: a person chose the text; it
        publishes graded `low`). That is the old worker's `TIMING_NONE`, kept for its reason: the
        stored candidate's line timings are what the person just rejected, and as claims they would pull
        the repairs back onto them (or, as a line-sync fallback, republish them). A PASTE is split only on
        its own newlines: a person line-broke it, and presplit's re-lineation is for transcripts.

        The stored candidate keeps its PROVENANCE: its label is read back off the ref it was written under
        (`_pinned_label`), so a re-picked authored-caption candidate is still `captions:authored` to core's
        `textSource` and to the trail. A paste is `manual` (core's `LyricsTextSource`). And its WHOLE TEXT:
        the lines its decode dropped are in the document's `sourceLines` (`_with_source_lines`).

        `None`, with the reason on the trail, when the stored candidate is gone or carries no readable line;
        the workflow then publishes nothing and the candidate core holds is left exactly as it is.
        """
        pin = pin_of(job)
        if pin is None or pin.refused is not None:
            return None  # the workflow never asks then; restated so no call reads outside the store
        if pin.pasted is not None:
            lines = [line.strip() for line in pin.pasted.splitlines() if line.strip()]
            label, language = _MANUAL_LABEL, None
            why = "the paste carries no line with words"
        else:
            lines, language, why = _stored_lines(os.path.join(job.media_dir, pin.ref))
            label = _pinned_label(pin.ref, job.media_id)
        if not lines:
            await self.note(
                job,
                "texts",
                0,
                "pin-unreadable",
                f"pinned lyrics {pin.ref}: {why} — publishing nothing, so the candidate the core holds is "
                "left exactly as it is rather than re-picked behind the person who chose it",
                None,
            )
            return None
        return TextRef(
            tier=tier_of_label(label),
            label=label,
            segments=tuple({"text": line} for line in lines),
            language=language,
        )

    async def transcribe(self, job: JobRef, audio: AudioRef, *, on_vocals: bool) -> TextRef | None:
        """The mandatory fallback tier. `None` means nothing intelligible was heard.

        `to_thread` is load-bearing rather than tidy: whisper is synchronous, and awaiting it inline
        freezes the event loop for the whole pass — so the socket keepalive stops, the core's lease
        expires, and the reaper requeues a job that is running fine.

        WITH THE JOB'S `asrModel` (review H5), which core sends from the room's settings on every align
        job and nothing read: the worker transcribed with its startup `ENCORE_ASR_MODEL` whatever the room
        chose. A checkpoint this worker may not load falls back to that default, on the trail.
        """
        checkpoint = asr_model_of(job, self._cfg.asr_model)
        transcriber = self._transcriber(checkpoint)
        if transcriber is None:
            return None
        asked = job.param_str("asrModel")
        if asked is not None and asked != checkpoint:
            await self.note(
                job,
                "asr-fallback",
                0,
                "asr-model",
                f"asrModel {asked!r} is not a checkpoint this worker may load ({', '.join(ASR_MODELS)}); "
                f"transcribing with {checkpoint!r}",
                None,
            )
        target = audio.vocals_path if (on_vocals and audio.vocals_path) else audio.path
        segments = await asyncio.to_thread(transcriber.transcribe, target, language=job.param_str("language"))
        if not segments:
            return None
        return TextRef(
            tier=Tier.ASR,
            label=f"asr:{'vocals' if on_vocals and audio.vocals_path else 'mix'}",
            # RE-LINEATED here, and only here. Whisper emits ~30-second VAD blobs, so one segment is
            # several lyric lines run together; published unsplit the TV shows a paragraph that scrolls
            # past before anyone can sing it. Split BEFORE alignment, so the aligner measures the lines
            # that will actually be shown — splitting after would leave the second half of every line
            # highlighting early.
            segments=presplit.presplit_text(as_segments(segments)),
            # Word-timed AND measured on this audio, which is why it can be neither the wrong song nor
            # misplaced — and why `Knob.RESHIFT` is meaningless for it (`TextRef.has_own_timings`).
            timing=TIMING_WORD,
            language=job.param_str("language"),
        )

    def _transcriber(self, checkpoint: str) -> ports.Transcriber | None:
        """The transcriber for `checkpoint`: the startup one when it IS that checkpoint (or when this box
        builds no other), else the one `transcriber_for` builds."""
        if checkpoint == self._cfg.asr_model or self._a.transcriber_for is None:
            return self._a.transcriber
        return self._a.transcriber_for(checkpoint)

    # ── alignment ────────────────────────────────────────────────────────────────────────────────

    async def time_text(self, req: TimeRequest) -> TimedDoc | Refused | None:
        """One alignment attempt: generate, reconcile, repair, grade.

        `None` if nothing publishable resulted; `Refused` if a gate measured that the text does not
        describe this audio (which ends the text — see `Refused`).

        RAISES `InfraFault`, and nothing else on purpose, when the MACHINERY failed rather than the text
        (review M7): no aligner on this box, a model that would not download or load, a CTC kernel the
        installed torchaudio no longer ships, an accelerator fault, the job's own audio that ffmpeg would
        not decode. Each fails every attempt of every text the same way, so declining them walked the whole
        ladder into a published "no lyrics" (or a silent line sync) for a song whose words were never
        measured. The adapter types the fault (it alone knows its failure modes); this step only lets it
        through, and still declines whatever else an attempt raises: a kernel refusing THIS text, a
        language with no alignment model. Optional witnesses keep their no-evidence answers, fault or not:
        R4's mix decode, the never-sung rule's mix envelope, placement's activity fit, the diarizer — but
        not the LINE_SYNC rung's gate, which under `syncMode=lines` is the only reader of the audio.

        THE GLOBAL DECODE IS THE PATH, and disagreements are RECONCILED INSIDE IT rather than escalated to
        a different engine: a disputed or scattered line is re-decoded within a window some other evidence
        vouches for (a claim span, the gap between two anchored unique lines) on the same emission matrix.
        The windowed whisperx aligner survives only for an aligner that cannot produce emissions at all —
        a capability gap, not a quality fallback — and for the LINE_SYNC terminal knob.
        """
        if self._a.aligner is None:
            # A box with no aligner never advertises `align` (`host.capabilities`), so reaching here is a
            # composition fault. It used to be None on every attempt: a "no lyrics" nothing had measured.
            raise _Permanent("this worker has no aligner, so it cannot time lyrics")

        if req.force_line_sync:
            # Terminal knob: publish the text's own line timings rather than word timings — gated.
            return await self._time_line_sync(req)

        emitter = getattr(self._a.aligner, "emissions", None)
        if callable(emitter):
            return await self._time_text_global(req)
        return await self._time_text_windowed(req)

    async def _time_text_windowed(self, req: TimeRequest) -> TimedDoc | None:
        """The windowed engine, for aligners with no emission matrix to decode over."""
        assert self._a.aligner is not None  # guarded by time_text; restated for the type checker
        segments = self._placed(req)
        target = req.audio.align_target(on_mix=req.on_mix)
        spans = self._placed_spans(req, segments)
        try:
            aligned = await asyncio.to_thread(self._a.aligner.align, spans, target, req.language)
        except InfraFault:
            raise  # the machinery, not this text: fails the job (review M7)
        except Exception:  # noqa: BLE001 - an aligner that could not place this text is one attempt failing
            return None
        doc = _word_doc(aligned, req.language)

        residual = place.residual_against(doc, segments) if req.text.has_own_timings else None
        report = measure.measure(
            doc, duration_sec=req.audio.duration_sec, residual_sec=residual, engine=Engine.WINDOWED
        )
        if report.words == 0:
            return None
        if report.out_of_order:
            # whisperx aligns each segment inside its own crop, so nothing orders one segment's words against
            # the next's. Which lines is what makes the line-sync fallback `decide` answers this with
            # debuggable from the trail.
            await self._out.state(
                req.job.job_id, "align-windowed", 0, "out-of-order", _backwards_why(doc), None
            )
        return self._write(req, doc, TIMING_WORD, "high", report=report)

    async def _time_line_sync(self, req: TimeRequest) -> TimedDoc | Refused | None:
        """The LINE_SYNC rung: the text's own line timings, placed on this clock — IF they describe it.

        UNGATED, THIS RUNG PUBLISHES ANY TIMED TEXT. It was only harmless because a line document could
        never commit (review M1); fixing that alone would have published every timed wrong text that
        reaches it. It publishes the text's OWN claimed starts (placed by the stem's activity fit,
        `_placed_by`), so two questions gate it: are THESE WORDS what the stem sings, and do these TIMINGS
        sit where they are sung? Both are read off the stem's emission matrix (one model pass), which is
        also the matrix the global engine decodes.

        THE WORDS: `lexical.lift`, refused below the matrix's own `refuse_below` (review W1 r2) — the text's
        forced path against the best of three shuffles of its own words, per letter. The rung reads the SAME
        band the global engine does (`lexical.band(..., on_stem=True)`, this rung's readings being always the
        stem's), off the SAME per-model row (`lexical.CALIBRATED`, keyed by the matrix's model — W4b), so the
        one recalibration a new model needs moves both gates; it used to hold its own copy of
        the number, which W4's recipe would have left behind (W3 review r1). A caption track of THIS video
        fits the singing whatever its words: an uploader's English translation of a K-pop song, or YouTube's
        machine-translated `en` track (the one `--sub-langs en.*,en` fetches for a non-English upload).
        Measured with the shipped helper and decoder over the bench's stems (`scripts/lift_gate.py`, base
        model): right texts (truth — which every timing-only mode serves — headers, credit, extra verse,
        drop20, drop50; 192) read +0.26 to +4.34, truth +0.47 at the lowest; the 320 wrong texts -0.21 to
        +0.19, and the 320 same-video wrong-words texts (`wrongtext+ownclock`: another song's words on this
        song's own caption clock) -0.23 to +0.14. At 0.2: 0/192 right refused, 0/640 wrong passed. A text in
        the DOUBT band just over the floor ([`refuse_below`, `ok_from`); no text measured at this rung has
        landed there) publishes as an UNVOUCHED document (`TimedDoc.vouched`), exactly as the global engine's
        doubt band does on a stem — and so does a text whose words NOTHING here could read, which is not the
        same as a text a gate passed (W3 review r2). NOT measured: a real translation (the corpus has none),
        and one into a language whose
        words share the sung ones' letters in order (cognates) may lift above a wrong text's (the CTC
        fixture: German +1.98, French -0.12; `test_lexical`, `lexical`'s NOT COVERED paragraph).

        THE CLOCK, BEFORE EITHER QUESTION (W2, review H1). A sheet 1.5 s off is a sheet to MOVE, not a sheet
        to refuse, so `_line_sync_clock` votes on which clock these claims are on — no-shift against the
        envelope lag the gate already measured, the decode's own median and a bounded tempo — and `_placed_by`
        applies the winner. Until W2 the sheet was moved by the activity fit whenever `ShiftFit.usable` held
        and by nothing else, which cost both ways: 12 right texts refused for a clock error their own decode
        could see, and 23 published documents with NO line within ±500 ms of truth because the fit moved a
        sheet that was already right.

        THE TIMINGS: the text is decoded BLIND on the same matrix (`generate`: the lift's own forced path,
        kept as lines) and at least `lexical.line_sync_share` of its lines must start within
        `_LINE_SYNC_NEAR_SEC` of their MAPPED claims — nothing removed, because the claims are what publishes
        (`reconcile.as_claimed`). That share is the MATRIX'S OWN MODEL's row, and
        `lexical.LINE_SYNC_SHARE_UNCALIBRATED` where the model has none (W4b review r1): unlike the lift's
        bands the share is a count of lines, not a log-probability, so a bundle nobody calibrated is still
        gated on it rather than dropped onto the envelope gate this one replaced.
        This REPLACED the sheet-span envelope gate (`_sheet_passes`: the text's
        claimed spans correlated against the stem's activity), which reads only the SHAPE of where a text
        claims singing, blind to the lines themselves. Measured rule by rule with the shipped functions over
        every timed bench case on the stems (`scripts/line_gate.py`, base model, 1056 cases, rows in
        `results/w2-line-gate.json`; 13 timed modes, 416 right texts; a line document "good" with >= 80% of
        its lines within 1 s of truth, "bad" under 50% — on the MAPPED claims that is 411 good, 2 middling,
        3 bad):

          rule                           good refused   bad published   right refused   gross shown
          sheet gate + lift (W1)            170/411         0/3              175/416           0
          lift alone (timings unchecked)      0/411         3/3                0/416          76
          lift + decode agreement 0.5        29/411         0/3               33/416           0
          lift + (sheet OR decode 0.5)       14/411         0/3               18/416           0

        WHAT THE CLOCK BOUGHT, same rule, same decode, W3's placement -> W2's (that script's `placement`
        block): right texts refused 88 -> 33 of 416 — a strict SUBSET, 0 newly refused and 55 recovered, 53 of
        the 55 publishing a document at least 80% within ±500 ms — shown lines within ±500 ms 88.9% -> 94.8%,
        text-denominator ±500 (a refused song counts as misses) 69.0% -> 89.5%, gross lines 47 -> 0, documents
        with no line within ±500 ms 23 -> 13. (That 47 was printed as 0 until W2 review r2: the block's gross
        column was the only one not keyed to the placement being shown, so the W3 row summed the MAPPED
        placement's gross over the documents W3's rule publishes. Over W1's 10 lines-modes both placements
        really are 0; the 47 is tempo098's 28 and tempo102's 19 — the same two counts `gates/w3-lines.yaml`
        already carries from the corpus run's own rows, which is what says the corrected column is right.)
        Per mode: tempo098 27 -> 3 refused (text ±500 4.4% -> 87.1%),
        tempo102 26 -> 3 (4.7% -> 87.1%), off15 and off3 4 -> 1 (70.4% -> 91.4%), offm1 3 -> 1 (79.3% ->
        93.9%), drop20 0 -> 0 (89.2% -> 95.9%), truth 1 -> 1 (91.4% -> 93.4%). 188 of the 416 sheets are
        mapped (envelope-lag 110, tempo 65, decode-median 13); the other 228 keep their own timings.

        WHAT STAYS REFUSED, and it is the DECODE that refuses it (`gates/w3-lines.yaml`): never-be-alone in 12
        of the 13 modes at agreement 0.38-0.49 (0.04 under drop50) — the repeat-heavy 47-line song whose blind
        decode misbinds its choruses (review F2/F10), where `line_gate`'s `near_fit` says the best ANY offset
        could reach is 0.15-0.45, so no map in the band lifts it past 0.5; the drop50 half-sheets (17, whose
        decode strays into the gaps); and hello / tfr-chosen under the two tempo modes (0.24-0.40), the only
        two documents left that would be more than 20% gross. Loosening the share to 0.4 would publish 22 more
        right texts and 6 gross lines, and 10 of never-be-alone's 12 — 7 of them with 0 of 47 lines within
        ±500 ms — so it is not taken (see `_LINE_SYNC_NEAR_SEC`'s block, which carries the share's sweep).

        THE WRONG-TEXT RESULT RESTS ON THE LIFT, NOT ON THE AGREEMENT, and the map is why that has to be said
        (W2): mapping a sheet onto our decode works for a WRONG sheet too, so the same-video population's
        agreement rose from max 0.49 to max 0.51 and one of the 320 (feel-my-heart #9, lift -0.05) now clears
        the timing half. The lexical gate refuses all 640 either way — `wrongtext` 0/320 and
        `wrongtext+ownclock` 0/320 at every share from 0.3 to 0.8 — which is the whole reason this rung may
        map claims at all. The sheet gate alone passed 278 of those 320.

        The sheet fit still measures the envelope (it is a candidate in the vote and the fallback gate), and
        its reading stays on the trail. Cost: one `generate` decode beside the lift's four, and the emission
        pass is now paid by every text that reaches the rung, where the sheet gate used to refuse ~a third
        first. OR-ing the sheet gate back in (`either(0.5)`: 18 refused) publishes the two >20%-gross tempo
        documents and never-be-alone's, so it is still not taken.

        WHAT NEITHER GATE SEES, and what the decode gate costs when the DECODE is the bad witness, are
        recorded with their measured populations at `_LINE_SYNC_MIN_DECODED_SHARE` (W3 review r2) — a uniform
        sub-second lag, a tempo error, and 5 accurate documents refused.

        FALLBACK: the sheet gate, exactly as W1 shipped it, where the decode cannot be read — an aligner with
        no emission matrix (the windowed capability path), an emission pass or decode that raised (not an
        `InfraFault`: the bench scores that an ERROR row), fewer than `reconcile.MIN_PAIRS` lines decoded, or
        fewer than `_LINE_SYNC_MIN_DECODED_SHARE` of the sheet's claimed lines decoded (a mixed-script
        caption track: the share's denominator is the decoded lines alone, so a Latin fragment must not decide
        for 40 Korean ones). Measured then (`scripts/sheet_gate.py`, the bench's claims on the stems as
        captions and in parse_lrc's shape): wrong texts pass 0/320 and 2/320; right texts 241/416 and
        163/416, which is why it is no longer the gate where the decode can be read. A text the LIFT cannot
        measure (under `lexical.MIN_LETTERS` alignable letters, no word order to contrast, a matrix from a
        model the bands were not fitted on) still has its timings checked by the decode; its WORDS go
        unchecked, so it publishes UNVOUCHED and the trail says why.

        ON A STEM ONLY. Against the MIX (a song with no vocals stem) the sheet gate passes 39/416 right texts
        and 3/320 wrong as captions, 37/416 and 3/320 as LRC (`sheet_gate.py --target mix`), and the lift's
        populations overlap there (`lexical`). So `syncMode=lines` on a stemless song is aligned as forced
        instead (`workflows.align._sync_mode_note`, review W1 r1), and forced mode's own fallback to this
        rung is DECLINED there (review W1 r2). Every reading is of the stem whatever the attempt aligned on:
        a windowed `ALIGN_ON_MIX` retry's knobs are this rung's.

        `None`, not `Refused`, when no gate could be MEASURED (no timed line; no stem; neither the decode nor
        the envelope fit readable): an unanswered question is not a verdict on the text. A failed envelope
        fit alone only leaves the lines where the text put them (placement abstains, as `_placed` does).
        Audio the MACHINERY cannot read (ffmpeg would not decode it: `InfraFault`), or an emission pass it
        cannot run, is neither, and raises (review M7): under `syncMode=lines` this rung is the only reader
        of the audio, so declining it here declined every text alike.
        """
        claimed = _sheet_spans(req.text.segments)
        if not claimed:
            await self._out.state(
                req.job.job_id, "align-line-sync", 0, "declined", "no line carries a timing to sync", None
            )
            return None
        if req.text.tier is Tier.ASR:
            # A TRANSCRIPT is not a sheet: its spans were measured on THIS recording, so it can be neither
            # the wrong song nor on another master's clock, which are the two things this gate detects.
            # Reached only under `syncMode=lines` (review H5): forced mode never offers a word-timed text
            # this rung. Measured on the real stem: hello's whisper `base` transcript read r=0.33 @ +0.22 s
            # against its own recording (61 lines, the presplit spans share a segment's span by character
            # count, so they blur), was refused as if it were another song's sheet, and lines mode ended
            # in NO LYRICS for a song with audible words; Ridgway's passed at r=0.69 @ +0.00 s. The old
            # worker published a transcript's own timings ungated in both modes.
            doc = _line_doc(self._placed_by(req, None), req.language)
            report = measure.measure(doc, duration_sec=req.audio.duration_sec, engine=Engine.LINE_SYNC)
            timed = self._write(req, doc, TIMING_LINE, "low", report=report)
            why = f"a transcript of this recording, on its own spans (no sheet gate); {report.summary()}"
            await self._out.state(req.job.job_id, "align-line-sync", 0, "line-sync", why, None)
            return timed
        if req.audio.vocals_path is None:
            await self._out.state(
                req.job.job_id,
                "align-line-sync",
                0,
                "declined",
                "no vocals stem: the sheet-span gate cannot tell a right text from a wrong one on the mix "
                "(39/416 right, 3/320 wrong, measured), so this text's own line timings are not published",
                None,
            )
            return None
        fit = await asyncio.to_thread(partial(self._activity_fit, gate=True), req, claimed)
        evidence = await self._line_sync_evidence(req)
        # THE BUNDLE FIRST, on every branch that reports one (W4b review r1, `_bundle_why`): this rung's two
        # thresholds are read off the matrix's own calibration row, and no other clause names the model. Only
        # where there IS a matrix — an aligner with none read nothing off a bundle.
        verdict = ("" if evidence.emissions is None else f"{_bundle_why(evidence.emissions)}; ") + (
            f"sheet-span envelope r={fit.correlation:.2f} @ {fit.seconds:+.2f}s, {len(claimed)} lines"
            if fit is not None
            else f"sheet-span envelope unreadable, {len(claimed)} lines left where the text put them"
        )

        async def refuse(why: str) -> Refused:
            await self._out.state(req.job.job_id, "align-line-sync", 0, "refused", why, None)
            return Refused(
                TimingReport(
                    duration_sec=max(0.0, req.audio.duration_sec),
                    engine=Engine.LINE_SYNC,
                    lines=len(claimed),
                    refused=why,
                )
            )

        heard = evidence.lift
        # THE LEXICAL FLOOR OFF THE MATRIX'S OWN ROW (W4b): `evidence.bands` is the calibration for the model
        # that produced this matrix, and it is None exactly when that model has no row — in which case the
        # lift is unreadable here (`_measured_lift`) and nothing in nats per letter may be read off it. The
        # decode-agreement share below is the exception, and the only one (`lexical.line_sync_share`).
        heard_band = (
            lexical.band(heard.value, on_stem=True, bands=evidence.bands)
            if heard is not None and evidence.bands is not None
            else None
        )
        if heard is not None and evidence.bands is not None and heard_band is lexical.Band.REFUSE:
            return await refuse(
                f"{verdict}; {heard.why()}, below the lexical gate ({evidence.bands.refuse_below}): these "
                "are not the words the stem sings, whatever their timings (a translated or machine-"
                "translated caption track of this very video reads exactly so)"
            )
        lexical_note = heard.why() if heard is not None else f"no lexical check: {evidence.unlifted}"
        if heard_band is lexical.Band.DOUBT:
            lexical_note += ", in the doubt band: nothing vouches for these words"
        # The TIMING check, only now (W3 review r2): its `generate` decode is another CTC pass over the whole
        # text, and a text the words' gate just refused must not pay for it.
        decoded: Generated | None = None
        undecoded = evidence.unlifted  # no matrix: the same reason nothing lifted
        if evidence.emissions is not None:
            texts = [str(segment.get("text") or "") for segment in req.text.segments]
            decoded, undecoded = await _line_sync_decode(texts, evidence.emissions, req.language)
        # THE CLAIM CLOCK, ON THE RUNG THAT PUBLISHES THE CLAIMS (W2, review H1). The vote decides where the
        # sheet goes and the gate then reads the decode against THE MAPPED CLAIMS — the whole point of a
        # clock: a sheet 1.5 s off is a sheet to move, not a sheet to refuse. Where there is no decode to
        # vote with, `clock` is None and both the placement and the gate are exactly what W3 shipped (the
        # unconditional activity shift and the sheet-span envelope).
        clock = _line_sync_clock(fit, _claimed_starts(req.text.segments), decoded)
        placed, reordered, unheld = _in_claim_order(self._placed_by(req, fit, clock=clock))
        clock_note = "" if clock is None else f"; {clock.why}"
        if reordered:
            # A jittered or hand-typed sheet can stamp one line before the one ahead of it, and a line
            # document IS its claims: `_in_claim_order` holds such a start at its predecessor's rather than
            # publish a highlight that jumps backwards (see `_in_claim_order` for the measured case).
            clock_note += f"; {reordered} claimed start(s) held at the line before them"
        if unheld:
            # ...but only a STRAY stamp. More than the cap, or a run of them, and the sheet's order cannot be
            # reconstructed: it goes on as it came, so the order gate below sees it and `decide` drops it
            # rather than the room being shown one line's text over several lines' singing.
            clock_note += (
                f"; {unheld} claimed start(s) sit before a start already kept and were left alone: this "
                "sheet's order is not one stray stamp"
            )
        if decoded is None:
            agreed, unchecked = None, undecoded
        else:
            agreed, unchecked = _agreement_of(decoded, placed)
        # THE SHARE IS THIS MODEL'S, OR THE ONE EVERY CALIBRATED MODEL FITS (W4b, corrected in its review r1).
        # It is read off the model's own decode spread, so a bundle with a row is gated at ITS
        # `line_sync_min_agreement` — but unlike every other number in that row the share is a fraction of
        # lines within a tolerance in SECONDS, not a log-probability, so a matrix with NO row is still gated,
        # at `lexical.LINE_SYNC_SHARE_UNCALIBRATED` (the value all three rows fit independently). Standing it
        # down instead left W7's per-language bundles on the sheet-span envelope ALONE — the gate this decode
        # check was introduced to replace, because a same-video translation fits the singing at r ~ 1.
        share = lexical.line_sync_share(evidence.bands)
        if agreed is not None:
            if agreed.near < share:
                return await refuse(
                    f"{verdict} (not gating: the decode is){clock_note}; {lexical_note}; {agreed.why()}, "
                    f"below {share:.0%}: these line timings are not where the stem sings "
                    "the lines (another master's clock no map could reach, or a decode too scattered to map "
                    "onto)"
                )
            gate_note = f"{verdict} (not gating: the decode is){clock_note}; {lexical_note}; {agreed.why()}"
        elif fit is None:
            await self._out.state(
                req.job.job_id,
                "align-line-sync",
                0,
                "declined",
                "audio unreadable for the sheet-span envelope gate, and no decode check: " + unchecked,
                None,
            )
            return None
        elif not _sheet_passes(fit):
            return await refuse(
                f"{verdict}, below the sheet gate (r >= 0.40 within ±0.5 s, or r >= 0.60); {lexical_note}; "
                f"no decode check: {unchecked}"
            )
        else:
            gate_note = f"{verdict}{clock_note}; {lexical_note}; no decode check: {unchecked}"
        doc = _line_doc(placed, req.language)
        report = measure.measure(doc, duration_sec=req.audio.duration_sec, engine=Engine.LINE_SYNC)
        # VOUCHED ONLY WHERE THE WORDS WERE READ (W3 review r2). `heard is None` is not a pass: an aligner
        # with no emission matrix, a language whose model would not load, a kernel refusing these targets, a
        # text under `lexical.MIN_LETTERS` or a matrix from another model all reach here having checked the
        # TIMINGS alone (the decode agreement, or the sheet gate), and this rung's own hazard is a text whose
        # timings are perfect and whose words are someone else's — the same-video translation (W1 review r2).
        # Sent vouched, core reads a CANDIDATE tier as `textConfidence` `high` and ranks it as a claim, which
        # is precisely the standing this gate exists to withhold when nothing measured the words.
        timed = self._write(
            req,
            doc,
            TIMING_LINE,
            "low",
            report=report,
            vouched=heard is not None and heard_band is not lexical.Band.DOUBT,
        )
        await self._out.state(
            req.job.job_id, "align-line-sync", 0, "line-sync", f"{gate_note}; {report.summary()}", None
        )
        return timed

    async def _line_sync_evidence(self, req: TimeRequest) -> _LineEvidence:
        """What the STEM's emission matrix says about a line-sync text's WORDS: its `lexical.lift`, or None
        with why it could not be read — plus the matrix itself, for the timing check the caller runs after.

        The stem, as every reading of this rung: `_time_line_sync` declines a stemless song before this. A
        machinery fault in the emission pass or the kernel raises (`InfraFault`, review M7); anything else (a
        language with no alignment model, a kernel refusing these targets) is an unanswered question, and
        the caller falls back to the sheet gate.

        COST: one emission pass over the stem plus four CTC decodes for the lift. The decode check's own
        `generate` is the caller's, AFTER this verdict (W3 review r2), so a text these words fail pays for
        neither it nor the grouping. In forced mode the global attempt computed that same matrix a step
        earlier, but a step cannot hand a tensor to the next one (a checkpointed record holds refs, never
        tensors), so it is computed again; `syncMode=lines`, which decodes nothing else, pays it once per
        text.
        """
        emitter = getattr(self._a.aligner, "emissions", None)
        if not callable(emitter):
            return _LineEvidence(None, "this aligner produces no emission matrix", None, None)
        texts = [str(segment.get("text") or "") for segment in req.text.segments]
        try:
            emissions = await asyncio.to_thread(emitter, req.audio.align_target(on_mix=False), req.language)
        except InfraFault:
            raise  # the machinery, not this text: fails the job (review M7)
        except Exception as exc:  # noqa: BLE001 - an unanswered question, not a verdict on the text
            return _LineEvidence(None, f"it raised {type(exc).__name__}: {exc}", None, None)
        lifted, bands, unlifted = await _measured_lift(texts, emissions)
        return _LineEvidence(lifted, unlifted, bands, emissions)

    async def _word_lift(
        self, req: TimeRequest, line_texts: Sequence[str], emissions: Any
    ) -> tuple[lexical.Lift | None, lexical.Bands | None, str]:
        """The global engine's lexical check: `line_texts`' lift on the matrix this attempt decoded, the
        calibration row it is judged against, or None for both and why it did not run.

        EXEMPT: the ASR tier, whose words were heard on this very audio, so they can be misheard but not
        another song's (review §3.4); and a text under `lexical.MIN_LETTERS` alignable letters, or one no
        shuffle changes, where the contrast is noise — none in the bench's 832 texts (every right, wrong
        and same-video wrong-words text of the 32 songs holds 201 letters or more). Each keeps the envelope
        gate. Machine captions are NOT exempt: YouTube's machine-translated `en` track is one.

        COST: four CTC decodes on the matrix in hand (the text and three shuffles; no model pass), off the
        event loop like every decode: 0.1-0.3 s each on the bench's stems.
        """
        if req.text.tier is Tier.ASR:
            return None, None, "a transcript of this recording (its words were heard on this audio)"
        return await _measured_lift(line_texts, emissions)

    async def _time_text_global(self, req: TimeRequest) -> TimedDoc | Refused | None:
        """Generate our own timings from TEXT ALONE, then reconcile every other measurement INTO them.

        `None` is one ATTEMPT failing — the verify ladder moves to its next knob or text — never a switch
        to a different engine. `Refused` is the envelope gate's verdict that the text does not describe
        this audio, which ends the text. Disagreements are repaired in place, on the same emission matrix:

          R1  claims fit the audio better than a scattered decode (found live: authored captions came back
              UNRELATED because OUR decode had misbound repeat-heavy text) — every claimed line is
              re-decoded inside its padded claim window, where the claim vouches for occupancy and the
              decode supplies the precision.
          R2  a STRUCTURAL verdict's disputed lines — the exact lines a monotonic decode can bind to the
              wrong chorus occurrence (F2) — are re-decoded inside their claim windows.
          R3  blind repeats (no claim to anchor them) are re-decoded jointly between their nearest UNIQUE
              neighbours — the anchor-and-redecode tactic Gentle's multipass realigner and nomadkaraoke's
              anchor sequences both converge on. They stay `low`: an anchor vouches for the region, not
              for which occurrence is which.
          R4  a claimed line whose window the stem is silent in is re-decoded there on the MIX.

        Each stage records which lines it re-timed (`_Source`: blind / anchored / window / mix / adopted);
        the per-line provenance steers the default-off `l1-*` arms, reaches the trail, and gates grading.

        GRADING (measured, docs/benchmarks/forced-alignment), on the BLIND verdict only (review H4):
        corroborated -> `high` (two independent measurements agreeing beats the decode's own score, F3),
        disputed -> `low`, blind repeats -> `low`, blind unique -> `high`; a line a stage re-timed inside a
        claim window (window / mix) is `high` only where the blind decode corroborated its claim and the
        repair kept that position; an R3 line (anchored: decoded without the claims) is `high` where it
        lands on its claim on the blind verdict's clock; an adopted claim span is always `low`. Neither the
        path score (F3) nor char-rate (F4) graded better.

        THE WRONG-TEXT GATE is the text's lexical lift on this matrix, read FIRST — before this text's own
        decode and before any audio is read, so a refused text costs neither (W3, review H3 + r2;
        `lexical.BANDS` holds the bands and their calibration): on a STEM, below the floor the text is
        `Refused` before anything is repaired, and the lift REPLACES the envelope gate wherever it measured
        the text (the envelope gate scored our own decode, which the audio pulls onto the voiced frames
        whatever the words: 152/320 bench wrong texts passed it). In the doubt band the text publishes with
        every line `low`, the document `medium` and its words UNVOUCHED (`TimedDoc.vouched` -> core's
        `vouched: false`, so a document a gate passed outranks it); above the band, grading is as
        described. ON THE MIX (no stem) the same rule holds since W4 review r1 — the floor refuses and the
        envelope fit is reported — because the stemless bench mode measured the envelope gate losing MORE
        right texts than the floor (51 of 128 against 37) while admitting 27 of 64 wrong ones (the control
        row is `results/w4-stemless-envelope-time_text.json`; `lexical.BANDS`, MIX, owns the figure and
        every other site defers to it). The controls
        are `h3-mix-envelope` (W3's default: the envelope gate alone, the floor grading) and `h3-mix-floor`
        (both gates, which is what BOTH names set means). TWO AXES, NOT ONE (W3 review r2): the
        grading band and the words' standing part company on the mix, where `mix_ok_from` reads how audible
        the words are and holds 104 of the corpus's 192 right texts — so there only a SUB-FLOOR lift is
        unvouched, while its doubt band publishes vouched with `low` lines. The ASR tier keeps the envelope
        gate alone and stays vouched (its words were heard on this audio); any other text the lift could not
        measure keeps the envelope gate and is NOT vouched for, since no wrong-text gate read it. A PIN is
        measured but never refused: its words publish all-`low` and unvouched. NOT COVERED, and worst on THIS
        path: a translation whose words keep the sung ones' letters in order lands in `Band.OK` and publishes
        as a word document with `high` lines (`lexical`'s NOT COVERED paragraph; `test_lexical_gate` pins it).
        """
        from encore_worker.adapters.ml import forced_align_decoder, load_audio_mono_16k  # noqa: PLC0415
        from encore_worker.domain.audio import activity  # noqa: PLC0415
        from encore_worker.domain.lyrics import reconcile as rc  # noqa: PLC0415
        from encore_worker.domain.lyrics.generate import (  # noqa: PLC0415
            adopted_line,
            alignable_chars,
            generate,
            regenerate,
            separator_named,
            separator_of,
        )

        aligner = self._a.aligner
        assert aligner is not None  # guarded by time_text; restated for the type checker
        # 6c's LINE SEPARATOR, DEFAULT-OFF (review D1, the `linesep` arm; `Config.ALIGN_EXPERIMENTS` carries
        # the split evidence). Read once here because it belongs to EVERY decode that produces this document —
        # the blind one, the re-decode after the never-sung drop, and every repair window — and to none of the
        # GATE decodes, whose thresholds are calibrated on separator-free targets (`lexical.CALIBRATED`).
        separate_lines = "linesep" in self._cfg.align_experiments

        async def decline(why: str) -> None:
            # EVERY refusal is a trail note, because a silent one is indistinguishable from the step never
            # running — which is exactly how the first live run was mis-read. Found, not foreseen.
            await self._out.state(req.job.job_id, "align-global", 0, "declined", why, None)

        target = req.audio.align_target(on_mix=req.on_mix)
        line_texts = [str(segment.get("text") or "") for segment in req.text.segments]
        # THE EMISSION PASS AND THE DECODE ARE GUARDED SEPARATELY (W3 review r2) so the lexical gate can sit
        # between them: the gate needs the matrix and the text and nothing else, and everything after it —
        # this decode, an ffmpeg read of the whole target, an envelope over the whole signal — is work a
        # refused text used to pay for before being refused. Same handling on both, since either way it is
        # this TEXT's decode failing rather than the machinery (review M7).
        try:
            emissions = await asyncio.to_thread(aligner.emissions, target, req.language)  # type: ignore[attr-defined]
        except InfraFault:
            raise  # a model / kernel / device / audio fault fails the JOB, not this attempt (review M7)
        except Exception as exc:  # noqa: BLE001 - the emission pass refused THIS file: one attempt failing
            await decline(f"decode failed: {type(exc).__name__}: {exc}")
            return None

        # The MIX, the second witness: R4 decodes on it, and under `m6-mix-spare` the never-sung rule
        # listens to it before it bins a claimed line. When the target IS the mix (no stem), the lexical gate
        # below reads the mix's bands, where since W4 review r1 the LIFT'S FLOOR REFUSES and the envelope fit
        # is only reported — except under `h3-mix-envelope` (the control: the envelope gate alone) or
        # `h3-mix-floor` (both gates). The flip's numbers are at `lexical.BANDS`, MIX.
        stem_target = target
        mix_target = req.audio.align_target(on_mix=True)
        target_name = "mix" if stem_target == mix_target else "stem"

        # ── the lexical gate (review §3 item 4, H3; W3): are THESE WORDS what the target sings? ──
        # FIRST, on the matrix just computed, before this text's decode and before any audio is read: no
        # repair makes unsung words sung, and a wrong text is now the normal case to refuse (640/640 in the
        # sweep), so it costs one emission pass and four CTC decodes instead of an ffmpeg decode of the whole
        # stem plus an envelope pass plus a decode it will never publish (W3 review r2). The bands, their
        # calibration and why the lift REPLACES the envelope gate on a stem are at `lexical.BANDS`;
        # `_word_lift` says what is exempt.
        lifted, bands, unmeasured = await self._word_lift(req, line_texts, emissions)
        on_stem = target_name == "stem"
        # THE ROW THE LIFT WAS READ AGAINST, not a second lookup of the table (W4b, `_measured_lift`): a
        # matrix from a model with no calibration row comes back with neither, so a `lifted` that is not None
        # always brings its row, and every threshold below is read off THAT row.
        floor, ok_from = (
            ((bands.refuse_below, bands.ok_from) if on_stem else (bands.mix_floor, bands.mix_ok_from))
            if bands is not None
            else (None, None)
        )
        lift_band = (
            lexical.band(lifted.value, on_stem=on_stem, bands=bands)
            if lifted is not None and bands is not None
            else None
        )
        # A SUB-FLOOR LIFT IS A VERDICT ON EITHER TARGET (W4 review r1 flipped the mix; W3 shipped the
        # envelope gate in this role). The mix floor's cost is why W3 hesitated — it refuses 54 of the
        # corpus's 192 right mix texts, 7 of 32 truth texts, and there is nothing after a refusal on a
        # stemless song (NextText, and the LINE_SYNC rung declines the mix), so those sheets fall to the
        # whisper transcript. W4's stemless bench mode (`e2e.py --no-stem`) then measured all three
        # configurations end to end and the gate it replaces loses MORE of the same: the envelope gate
        # refuses 51 of 128 right-text cases against the floor's 37 and admits 27 of 64 wrong ones (42.2%,
        # against review §3.4's 1%), where the floor publishes 91 and admits 0. The numbers, the 9 right
        # texts the envelope gate refuses above the floor and the control arm are at `lexical.BANDS`, MIX.
        #
        # `h3-mix-floor` WINS WHEN BOTH ARM NAMES ARE SET (W4 review r2): it means BOTH gates, so it is the
        # superset of `h3-mix-envelope`'s one gate, and the pair must MEASURE what the stricter name promises
        # rather than a third configuration. Otherwise `align_config: {align_experiments:
        # [h3-mix-envelope, h3-mix-floor]}` would record both names over envelope-gate-only rows — the exact
        # mislabelling `Config.ALIGN_EXPERIMENTS` refuses unknown names to prevent.
        mix_both_gates = not on_stem and "h3-mix-floor" in self._cfg.align_experiments
        mix_envelope_only = (
            not on_stem and not mix_both_gates and "h3-mix-envelope" in self._cfg.align_experiments
        )
        mix_floor_gates = not on_stem and not mix_envelope_only
        refuses = lift_band is lexical.Band.REFUSE and (on_stem or mix_floor_gates)
        # Why nothing vouches for this pin's words: a wrong-text gate would have refused them, and a person
        # chose them (see the envelope gate's NOT FOR A PIN below).
        unvouched: str | None = None
        if refuses:
            assert lifted is not None  # `refuses` reads a band, which only a measured lift has
            why = (
                f"lexical gate refused: {lifted.why()}, below {floor} on the {target_name}: the audio does "
                "not sing these words, in this order or any other"
            )
            if pin_of(req.job) is None:
                await decline(why)
                # A VERDICT on the text (`Refused` ends it), exactly as the envelope gate's below.
                return Refused(
                    TimingReport(
                        duration_sec=max(0.0, req.audio.duration_sec), engine=Engine.GLOBAL, refused=why
                    )
                )
            unvouched = why
            await self._out.state(
                req.job.job_id,
                "align-global",
                0,
                "pin-unvouched",
                f"{why} — a person chose this text, so it is not judged a wrong text: publishing it with "
                "every line graded low",
                None,
            )
        # The DOUBT band GRADES: no line of it is `high` and the document is `medium`, on either target.
        # A sub-floor lift on the mix lands here too (see `refuses` above).
        doubted = lift_band is lexical.Band.DOUBT or (lift_band is lexical.Band.REFUSE and not refuses)
        # THE WORDS' AXIS IS NARROWER THAN THE GRADING ONE ON THE MIX (W3 review r2). Withholding the words
        # sends core `vouched: false`, which drops `isAuthoritativeText` and with it `lyricsRank` (5 -> 3),
        # so an authoritative LINE document of an earlier job outranks this word document. On a STEM the
        # doubt band is the right place for that: it holds 2 right texts and no wrong one. On the MIX
        # `mix_ok_from` was fitted to how AUDIBLE the words are and holds 104 of the corpus's 192 right
        # texts (15 of its 32 truth texts), so reading it as doubt about the WORDS would strip authority
        # from most correct sheets of every stemless song. There the floor is the words' verdict — it sits
        # above every wrong text's lift on both splits — and since W4 review r1 it is ENFORCED there as it is
        # on a stem, so the only sub-floor mix text that publishes at all is a PIN's or one under the control
        # arm `h3-mix-envelope`, and that one publishes unvouched. An UNMEASURED text is not vouched for
        # (W3 review r2): the ASR tier is exempt because its words were heard on this audio, but a provider
        # sheet the lift could not read (under `MIN_LETTERS`, a decode that raised, a matrix from another
        # model) had no wrong-text gate at all, and "none doubted it" must not read as "one passed it".
        words_doubted = lift_band is lexical.Band.REFUSE or (on_stem and lift_band is lexical.Band.DOUBT)
        words_measured = lifted is not None or req.text.tier is Tier.ASR
        if lifted is None:
            lexical_note = f"no lexical check: {unmeasured}"
        elif doubted:
            band_note = (
                f"in the doubt band [{floor}, {ok_from}) on the {target_name}"
                if lift_band is lexical.Band.DOUBT
                else f"below {floor} on the {target_name}, which the control arm does not refuse on"
            )
            lexical_note = f"{lifted.why()}, {band_note}: every line low"
            if not words_doubted:
                lexical_note += " (the band grades here; the words' verdict is the floor)"
        else:
            lexical_note = lifted.why()
        # ON EITHER TARGET the lift, where it measured the text, IS the wrong-text gate, so the envelope fit
        # is reported and not gated (W4 review r1 made the mix the stem's equal here). It still decides
        # wherever the lift could not measure the text at all — "none doubted it" must not read as "one
        # passed it" — and on the mix under either arm: `h3-mix-envelope` (the control, the envelope gate
        # alone) or `h3-mix-floor` (both gates, W3's first shipping).
        envelope_gates = lifted is None or mix_envelope_only or mix_both_gates

        try:
            generated = await asyncio.to_thread(
                generate,
                line_texts,
                emissions,
                decoder=forced_align_decoder,
                language=req.language,
                separate_lines=separate_lines,
            )
        except InfraFault:
            raise  # a model / kernel / device / audio fault fails the JOB, not this attempt (review M7)
        except Exception as exc:  # noqa: BLE001 - the decode refused THIS text: one attempt failing
            await decline(f"decode failed: {type(exc).__name__}: {exc}")
            return None
        if not generated.lines:
            await decline("no line in this text carries an alignable character")
            return None

        # NOT caught (review M7). The emission pass has just decoded this same file, and no text changes it,
        # so a read that fails here fails every attempt the same way; `load_audio_mono_16k` raises it as the
        # `InfraFault` it is. It used to decline this attempt, and the next, and every text's after it.
        signal = await asyncio.to_thread(load_audio_mono_16k, target)
        rate = 16000

        def fit_of(gen: Generated) -> activity.ShiftFit:
            return activity.fit_sheet_to_audio(signal, rate, [(ln.start, ln.end) for ln in gen.lines])

        env = activity.envelope(signal, rate)

        def overlap(envelope: np.ndarray | None, start: float, end: float) -> float:
            if envelope is None:
                return 0.0
            first = int(start / activity.HOP_SEC)
            last = max(int(end / activity.HOP_SEC), first + 1)
            window = envelope[max(0, first) : min(last, len(envelope))]
            return float(window.mean()) if len(window) else 0.0

        def env_overlap(start: float, end: float) -> float:
            return overlap(env, start, end)

        # ── claims as evidence ── (read before the never-sung rule, which tests a claimed line on them)
        claimed: dict[int, float] = {}
        claim_windows: dict[int, tuple[float, float]] = {}
        if req.text.has_own_timings:
            for index, segment in enumerate(req.text.segments):
                start, end = segment.get("start"), segment.get("end")
                if isinstance(start, (int, float)) and not isinstance(start, bool):
                    claimed[index] = float(start)
                    stop = (
                        float(end)
                        if isinstance(end, (int, float)) and not isinstance(end, bool)
                        else float(start) + 1.0
                    )
                    claim_windows[index] = (float(start), max(stop, float(start)))

        # The mix's envelope is read only when a claimed line's window is silent on the target (under
        # `m6-mix-spare`), and at most once: an ffmpeg decode of the whole mix is not free.
        mix_env: list[np.ndarray | None] = []

        async def audible_on_mix(window: tuple[float, float]) -> bool:
            if mix_target == stem_target:
                return False  # no second witness: the target IS the mix, and it was already silent
            if not mix_env:
                try:
                    heard = await asyncio.to_thread(load_audio_mono_16k, mix_target)
                    mix_env.append(activity.envelope(heard, rate))
                except Exception:  # noqa: BLE001 - an unreadable mix cannot testify; the stem's verdict stands
                    mix_env.append(None)
            return overlap(mix_env[0], *window) >= _NEVER_SUNG_ENV

        # ── never-sung drop + re-decode ──
        # A caption line that is NOT in the audio (an uploader credit; a lyric only present in a stem this
        # box did not get) does worse than fail: forced monotonically through emissions that do not contain
        # it, it consumes its neighbours' frames and drags them off (measured: dropping one such line moved
        # tfr-chosen from 51.4% to 58.8% within ±500 ms and gross 14 -> 11). Three signals, ALL required —
        # each alone misfires on a real quiet line (tfr-mayday's sung background echo matches the first
        # two): the decode scored it far below the song's norm, its span sits on silence, and its chars
        # smear at far below singing tempo. A re-decode after dropping is another Viterbi over the matrix
        # already in hand — 0.1-0.8 s on the corpus's songs (review evidence-6; this comment used to call it
        # "a millisecond", which is the order of magnitude the review corrected).
        #
        # The `m6-mix-spare` arm (review M6; default OFF): a CLAIMED line silent on the target but not on the
        # MIX is not binned here. The three signals judge where the DECODE put the line, and a line the stem
        # LOST (a vocal the separator left in the instrumental) is exactly one a stem decode smears over
        # silence. By default the rule runs on the target's evidence alone, as v2 ran it, and deletes lines
        # the mix witness would have recovered — never-be-alone's two closing lines under truth claims,
        # stem / mix envelope over their claim windows 0.008 / 0.79 and 0.003 / 0.78. With the arm on, such
        # a candidate still leaves this decode (forced through a matrix that does not place it, it drags its
        # neighbours as a never-sung line does; measured: kept in, tfr-chosen's credit dragged lines 29-33
        # by 7-10 s under offm1 claims) and is SPARED for R4, the mix witness, which puts it back only where
        # the mix's acoustic model HEARS speech in its claim window and its decode is not stuck at the
        # window's edge (R4 below). Never as the claim's own span: a spared line no decode heard is not sung,
        # so it goes where the rule sent it. An unclaimed line keeps the three-signal rule in either case:
        # nothing else says where it is sung.
        #
        # A claimed line whose window the TARGET itself sounds in is binned, as v2 binned it, unless the
        # default-off `m6-window-spare` arm is on (W1's extension of the review's rule: re-decode it inside
        # its claim window on the target). W1 first shipped it on, and put such lines back as their claims'
        # spans when the decode heard nothing; that is where M6's regressions came from (review W1 r1).
        #
        # WHY `m6-mix-spare` SHIPS OFF (W1 rebench after review round 1: harness `--level time_text` and
        # `--level run_align`, all 32 songs x 15 modes, against the v2 baselines): it FAILS W1's MUST gates
        # `unsung-not-up-headers` and `unsung-not-up-extraverse` at both levels (and review §3.1 by effect),
        # because the speech the mix's model hears in a claim window can be the NEXT line's. The same 12
        # documents move at each level, all at the baseline's stem coverage >= 0.80: 10 get lost lines back
        # (never-be-alone in 8 modes, jit 21 -> 0 gross and 19 -> 34 lines within ±500 ms; tfr-mayday
        # drop20; bohemian-rhapsody off15), and 2 publish a line the truth does not have (LUNABLIND's
        # `[Verse 3]` header, which also clips one sung line out of ±500 ms; one of Ridgway's injected
        # extra-verse lines). Over those 12: gross 32 -> 11, within ±500 ms 361 -> 380, unsung 21 -> 23,
        # lines missing 19 -> 4. No other document moved a line. On the 16 songs it touches x all modes
        # (the fix round's probe): 916 -> 895 gross at time_text, where W1 as first shipped (spared lines
        # adopted at their claims' spans, steering the ladder) read 918, with off3 +7, tempo098 +9 and
        # tempo102 +4 gross. With `m6-window-spare` on too (measured before `_SPOKEN_FLOOR`): 5 more
        # documents move (Quentin's closing line back in 4 modes, never within ±500 ms; Ridgway off15 +1
        # gross), gross +1, ±500 ms unchanged — so it stays off as well.
        #
        # RE-JUDGED UNDER W3 (2026-09-28). The lexical gate acts before this rule and refuses no right
        # text, so it cannot change either arm's verdict, and neither did. Measured on the 75 cases where a
        # never-sung line is dropped or W1's arm moved a document, arm and default on the same tree, both
        # levels. `m6-mix-spare` moves 13 documents: W1's 12, plus never-be-alone credit, which the envelope
        # gate refused and the lift now publishes (38 -> 39 lines within ±500 ms). It still FAILS
        # `unsung-not-up-headers` / `-extraverse` at both levels. `m6-window-spare` moves Quentin's 4 at
        # both levels, and at `time_text` Ridgway off15 (+1 gross, §3.1 by effect). Both stay off.
        #
        # `m6-window-spare` RE-PRICED ON THIS TREE AND IT IS NOW FREE (W6, 2026-09-30). Every cost above
        # predates BOTH the claim clock (W2) and the exact frame clock (W4), and W4b had already corrected
        # the other half (it puts `Pure_Mids_-_The_Leader`'s dropped line[0] back at -0.048 s, not the
        # "more than 2 s out" `gates/w4.yaml` used to say). Measured arm against default over the COMPLETE
        # set of songs it can act on — the 15 whose never-sung rule ever drops a line in any TEXT mode
        # (`results/w4b-unsung-gate.json`; the candidate set reads no claim, so those 15 are exhaustive) x
        # all 13 timed claim modes at `time_text`, base model, `_runs/w6-wspare-{default,arm}`: it changes
        # exactly FOUR documents, all `Pure_Mids` (truth, jit, headers, extraverse), each recovering line[0]
        # INSIDE the +-500 ms band. Pooled: gross 234 = 234, `unsung` 186 = 186, scored and within-500 ms
        # both +4, `high_gross` 0. QUENTIN AND RIDGWAY DO NOT REACT TO IT AT ALL NOW, so both recorded costs
        # were artefacts of the old clocks. RECOMMENDED as a default and deliberately still OFF: W6 already
        # changes the repair clamp on every repaired line (`_clamped_v2`), and sweeping two default changes
        # together makes neither attributable (PLAN rule 3). It also owes a `run_align` read, which this
        # pricing did not cover.
        experiments = self._cfg.align_experiments
        line_texts_active = list(line_texts)
        dropped_never_sung: list[str] = []
        # index -> (the line as the target's decode placed it, the witness whose envelope hears its claim:
        # MIX for the mix's under `m6-mix-spare`, WINDOW for the target's own matrix under `m6-window-spare`).
        # Empty by default: every never-sung candidate is binned, as v2 binned it.
        spared: dict[int, tuple[Line, _Source]] = {}
        for _round in range(2):
            if len(generated.lines) < 4:
                break  # medians over a couple of lines grade nothing
            song_median_score = median(line.score for line in generated.lines)
            never_sung = [
                line
                for line in generated.lines
                if line.score < song_median_score - _NEVER_SUNG_SCORE_GAP
                and env_overlap(line.start, line.end) < _NEVER_SUNG_ENV
                and len(line.text) / max(line.end - line.start, 1e-6) < _NEVER_SUNG_RATE
            ]
            if not never_sung:
                break
            for line in never_sung:
                line_texts_active[line.index] = ""
                window = claim_windows.get(line.index)
                if window is not None and env_overlap(*window) >= _NEVER_SUNG_ENV:
                    if "m6-window-spare" in experiments:
                        spared[line.index] = (line, _Source.WINDOW)
                    else:
                        dropped_never_sung.append(f"[{line.index}] {line.text[:40]!r}")
                elif "m6-mix-spare" in experiments and window is not None and await audible_on_mix(window):
                    spared[line.index] = (line, _Source.MIX)
                else:
                    dropped_never_sung.append(f"[{line.index}] {line.text[:40]!r}")
            try:
                generated = await asyncio.to_thread(
                    generate,
                    line_texts_active,
                    emissions,
                    decoder=forced_align_decoder,
                    language=req.language,
                    separate_lines=separate_lines,
                )
            except InfraFault:
                raise  # the machinery, not this text (review M7)
            except Exception as exc:  # noqa: BLE001 - the decode refused THIS text: one attempt failing
                await decline(f"re-decode after drop failed: {type(exc).__name__}: {exc}")
                return None
            if not generated.lines:
                await decline("every line graded never-sung; nothing left to publish")
                return None

        # Gate the BLIND series, once, before any repair. The gate detects wrong-text/wrong-song: an
        # unrelated sheet cannot be forced into the right shape by the audio, so its blind envelope fit
        # is what refuses. Re-gating the REPAIRED series regressed two songs to declines in a live
        # sweep: on never-be-alone, R1's wholesale claim adoption moved timings 1.76 s off (the claims
        # were for another master); on bohemian-rhapsody, wholesale adoption dropped the fit below the
        # threshold. Both blind decodes had passed and their timings were correct — the gate was
        # punishing a repair that used more evidence, not less.
        blind_fit = fit = await asyncio.to_thread(fit_of, generated)
        # The blind decode itself, kept for `_clamped`: one monotonic Viterbi over the whole song, so its
        # lines are in order between any two of their own neighbours — what a refused repair falls back to.
        blind_decode = generated
        #: Where the CLAIM-FREE decode put each line, and how long it took: the only span measured with no
        #: window around it, which is why the repair windows below are widened to hold it and why a claim
        #: span too short to hold it is not adopted (review M5). A never-sung candidate the ladder spared
        #: keeps the span the decode gave it before the drop — the same measurement, one round earlier.
        blind_spans: dict[int, tuple[float, float]] = {
            line.index: (line.start, line.end) for line in blind_decode.lines
        }
        blind_spans.update({index: (line.start, line.end) for index, (line, _witness) in spared.items()})

        # ── HOW AMBIGUOUS EACH PLACEMENT WAS (review §3.7; W6, `domain/lyrics/margin.py`) ──
        # Read on the BLIND decode's trellis and nowhere else, for grading's own reason (review H4): the
        # question is "could this line have gone somewhere else in this song", and a repair window has
        # already answered it by fiat. Taken here, right after the drop, because the margins must describe
        # the decode whose texts `line_texts_active` are — a line the never-sung rule blanked contributes no
        # targets, and every later line's position in the sequence moves with it.
        # OFF THE EVENT LOOP: two Viterbi passes over the whole matrix is 0.35 s median and 1.2 s max on the
        # corpus, and the reaper reads the socket keepalive (the `55 ms of synchronous numpy` note above).
        placement = (
            {}
            if "conf-legacy" in experiments
            else await asyncio.to_thread(
                _placement_margins, emissions, line_texts_active, separate_lines=separate_lines
            )
        )

        # ── THE CLAIM CLOCK (review H1, §3.2; W2). ONE rebinding of `claimed` / `claim_windows`, here,
        # before the first `reconcile` — so every consumer after it (the verdict, R1 / R2 / R4, the
        # adoption spans, COARSE's per-line residual, the corroboration test grading reads) asks about the
        # instant the AUDIO has, not the instant the sheet claims. Before this, a claim's raw clock reached
        # all of them: reconcile fitted an offset and used it only to choose which COARSE lines to repair,
        # fitted a scale and never applied it, and R1 measured the claims' envelope lag and kept only its
        # correlation — so claims 1.5 s late published every line 1.5 s late (repro s8) and +3 s claims
        # produced 440 gross lines (review §3.2). `claimmap` holds the estimator, its margin and the
        # numbers; the candidates are all already computed, so this costs one `np.correlate` and no decode.
        #
        # WHY HERE and not before the never-sung rule, whose window reads are the only ones left on the raw
        # clock (and only under the default-off `m6-*` arms — by default that rule bins a candidate whatever
        # its window says): the decode-median candidate is measured on the BLIND DECODE, and a never-sung
        # line forced through emissions that do not contain it drags its neighbours by seconds (measured:
        # 7-10 s on tfr-chosen), which is exactly the decode the drop above exists to remove.
        claim_clock = claimmap.IDENTITY
        #: The claims' lag as the AUDIO measures it, kept past the vote: `adopt_where_unheard` reads it to
        #: decide whether a raw claim time is a measurement at all (W4 review r1). None on a sheet too short
        #: to map, where it was never taken.
        claim_lag: ShiftFit | None = None
        if claimed:
            # The claims' own lag, measured on the AUDIO: the one candidate independent of our decode, and
            # the same fit R1 takes below (PLAN fact 7: 10-20 ms residual on a stem). The correlation floor
            # is weaker than `activity.MIN_CORRELATION` on purpose — it only buys a place in the vote. Not
            # measured at all on a sheet too short to map: `consensus` abstains there whatever it says, and
            # the envelope pass is not free. ANY claimed sheet still goes through `consensus`, so the trail
            # gets its reason rather than a silence.
            claim_lag = lag = (
                await asyncio.to_thread(
                    activity.fit_shift,
                    env,
                    activity.expected_envelope(list(claim_windows.values()), len(env)),
                )
                if len(claimed) >= claimmap.MIN_PAIRS
                else None
            )
            claim_clock = claimmap.consensus(
                {line.index: line.start for line in generated.lines},
                claimed,
                envelope_lag=(
                    lag.seconds
                    if lag is not None and lag.correlation >= claimmap.MIN_ENVELOPE_CORRELATION
                    else None
                ),
                piecewise="claimmap-piecewise" in experiments,
            )
        # THE RAW CLAIMS STAY, for the trail and for anything that must describe the SHEET rather than the
        # audio (review's note on `TimingReport.residual_sec`): the map's own offset is a fact about the
        # claim, and it reaches the trail through `claim_clock.why` in the verdict note below.
        claimed_as_given, windows_as_given = claimed, claim_windows
        if claim_clock.applied:
            claimed = claim_clock.starts(claimed_as_given)
            claim_windows = claim_clock.windows(windows_as_given)

        # THE BLIND VERDICT: our claim-free decode against the claims, taken once, before any repair — and
        # the only verdict grading reads (review H4). The ladder below re-reconciles after each stage to
        # decide what to repair NEXT (R4 turning tfr-chosen's UNRELATED into COARSE is what lets R2 fix its
        # misbound repeats), but a line re-decoded inside its claim window lands on the claim by
        # construction, so a re-reconcile counts the claim agreeing with itself. The review's exhibit: a
        # uniform +2.5 s offset over sparse vocals, where R4's edge-collapsed re-decodes all sat at the pad's
        # -1.0 s residual, read as one coherent offset, and published `high` and gross.
        blind_verdict = verdict = (
            rc.reconcile(generated.lines, claimed)
            if claimed
            else rc.Reconciliation(verdict=rc.NO_CLAIMS, why="text arrived untimed")
        )
        # REVIEW L1's two fixes are built and measured, and ship OFF (`Config.align_experiments`): each
        # failed W1's reject-if on never-be-alone (stem coverage 0.99). Measured with the harness at `--level
        # time_text` on never-be-alone, tfr-chosen, Quentin and Ridgway under truth / jit / off05 / off15 /
        # offm1 (20 cases, M6 on, and M2's order-preserving `_clamped` on, as W1 then shipped it; it is the
        # `m2-order-clamp` arm now): gross lines / lines within ±500 ms read 25 / 569 with both off, 33 / 549
        # with `l1-blind-median`, 49 / 538 with `l1-mix-kept`, 36 / 541 with both; all but 2 lines of the
        # difference are never-be-alone's: 3-29 fewer lines within ±500 ms under truth / jit / off05, 3-11
        # more gross under off15, and the one gain, offm1, +7-9 lines.
        #
        # WHY THEY LOSE. never-be-alone is the song the review read L1 from. Its blind decode is UNRELATED
        # (13-31% of lines agree), so R1 re-decodes every claimed line inside its claim window, and those
        # stem decodes are poor (0.5-1.5 s off truth). The per-stage median counted R1's adopted lines at
        # their 0.0 sentinel, rose (-2.98 -> -0.88), and R2 then ADOPTED the claim over 13-23 of them — by
        # accident, but claims beat those decodes whenever the claims are decent. With it fixed, the decodes
        # stand; and where no stage replaces them with claim spans in order, `_clamped` refuses the whole
        # song-long run (never-be-alone off05 with `l1-mix-kept`: all 47 lines back on the blind decode, 21
        # gross). Repro s5/s6's harm (heard lines adopted over, the mix's line undone) is real on the fixture
        # (tests/test_align_provenance.py pins it with the arms on) and absent from every measured song.
        # RE-JUDGED UNDER W3 (2026-09-28). The lexical gate acts before R1-R4 and refuses no right text.
        # Measured on the same 4 songs x 14 modes, arm and default on the same tree, both levels: both arms
        # still fail §3.1 by effect in 6-8 modes, and never-be-alone off05 goes 45 -> 26 lines within
        # ±500 ms with `l1-mix-kept` (45 -> 27 with `l1-blind-median`). At `run_align`, `l1-mix-kept` also
        # sends Quentin headers to line sync, which publishes 2 more injected headers: MUST
        # `unsung-not-up-headers`. Pooled over the 4 songs, truth ±500 also falls under the MUST's -0.3 pt,
        # -0.95 / -2.8 pt; that is -2 / -5 lines, which the full corpus dilutes. Both stay off.
        # `l1-blind-median`: the adoption test's reference, the blind decode's median taken ONCE (the blind
        # decode holds no adopted line by construction). Default: the median over the series as repaired
        # so far, re-read at each adoption — what v2 shipped.
        blind_median = median(line.score for line in blind_decode.lines)
        adoption_medians: list[str] = []
        #: Lines whose repair `adopt_where_unheard` dropped because the claim span could not hold them
        #: (review M5): the trail says so, since "no repair" and "no repair needed" read alike otherwise.
        #: Empty unless the arm `m5-adopt-floor` is on — the floor failed §3.11's reject-if (see there).
        truncated: list[int] = []
        #: Lines `adopt_where_unheard` would have adopted, on a sheet the claim clock DECLINED to map onto
        #: our clock and the blind decode relates nothing to (W4 review r1, `off_clock` there). They keep the
        #: window re-decode's own timing, and the trail says which and why.
        unmapped: list[int] = []
        # Where each line's CURRENT timing came from; every stage below that replaces a line says so here.
        # Grading reads it (a repaired line is `high` only with the blind decode's corroboration), the arm
        # `l1-mix-kept` reads it, and so does the trail.
        provenance: dict[int, _Source] = {line.index: _Source.BLIND for line in generated.lines}

        repairs: list[str] = []
        if dropped_never_sung:
            repairs.append(f"dropped never-sung: {', '.join(dropped_never_sung)}")
        if spared:
            repairs.append(
                f"spared {len(spared)} never-sung candidates for the witness their claim windows sound on: "
                + ", ".join(
                    f"[{i}] {line.text[:40]!r} on the {'mix' if witness == _Source.MIX else target_name}"
                    for i, (line, witness) in sorted(spared.items())
                )
            )
        #: The spared lines a witness HEARD and put back. They never steer the ladder: a line decoded inside
        #: its own claim window agrees with the claim by construction (the H4 circularity), so the
        #: re-reconciles, the adoption median and R1 / R2 are all taken without them, and M6 moves only the
        #: lines it returns (review W1 r1: joining the re-reconciles, one spared line flipped Quentin
        #: tempo098's post-R4 verdict STRUCTURAL -> UNRELATED and cost 4 other lines their R2 repair, and a
        #: spared credit turned tfr-chosen offm1's R1 into 31 claims adopted at -1.0 s). Measured with the
        #: heard-only rule (the 384 cases above, before `_SPOKEN_FLOOR`): letting them steer reads 895 gross /
        #: 7186 within ±500 ms against 895 / 7184 — no gain worth a second path through the fragile
        #: re-reconcile (W2's).
        returned: set[int] = set()

        def steer(gen: Generated) -> rc.Reconciliation:
            return rc.reconcile([line for line in gen.lines if line.index not in returned], claimed)

        #: The window each claim-anchored re-decode ACTUALLY ran in, by line index (`claim_run` records it).
        #: The edge tests below read it instead of rebuilding it from the claim span, because since M5 the two
        #: differ: a window may be widened to hold the blind decode's span, and it is clamped at zero as
        #: `regenerate` clamps. A stale left edge reads a decode that landed on its claim as "stuck", or a
        #: truly stuck one — at the start of a song, where the pad ran past zero — as fine.
        repair_windows: dict[int, tuple[float, float]] = {}

        #: Every MAPPED claim onset, in time order: the ceiling `claim_run`'s hold-open may not widen past
        #: (the next one after the cue's own start). In TIME order rather than by line index, because a sheet
        #: may stamp its lines out of order and the question here is which cue comes next in the audio.
        claim_onsets = sorted(start for start, _end in claim_windows.values())

        #: The slot this sheet gives a typical cue: the MEDIAN gap between consecutive onsets. It stands in
        #: for the missing next onset at the LAST cue (W2 review r2), and it is a median rather than the
        #: previous gap because one instrumental break must not hand the final line a minute — nor must one
        #: rapid-fire couplet cut it to nothing.
        typical_slot = (
            median(later - earlier for earlier, later in zip(claim_onsets, claim_onsets[1:], strict=False))
            if len(claim_onsets) > 1
            else 0.0
        )

        def claim_run(line: Line) -> tuple[tuple[Line, ...], tuple[float, float]]:
            """The run a claim-anchored stage (R1 / R2 / R4, the never-sung spare) re-decodes: this line
            alone, inside its MAPPED claim span held open to the END of the blind decode's own span for it,
            then padded.

            REVIEW M5, AND THE DEFECT WAS ARITHMETIC. A claim carries an END only where the sheet gave one;
            the reader above defaults it to start + 1.0 s, which is what the last cue of an LRC and every
            short caption cue get. Cut to that, the window cannot hold the line: the forced path compresses
            it or collapses to the left edge, `adopt_where_unheard` reads that as "heard nothing", and a
            CORRECT blind decode is replaced by the claim's span with its words spread evenly (reproduced on
            short caption cues). The blind decode is the only measurement of how long the line takes with no
            window around it, so the window is held open to where it ended.

            THE END ONLY, only where the claim span cannot HOLD the line, and only where the blind decode
            STARTS inside the padded claim span. Each of the three is a refusal to widen a window that is
            already doing its job, because a window is an anchor and a wider one anchors less:

              * a cue's START is what a sheet actually asserts and what every stage here anchors on; its END
                is the number the reader defaults. Pulling the start back to a blind onset instead undoes the
                anchoring — measured on the bench harness's own rig, where the blind decode smears each line
                over 6 s: a two-sided union moved R1's window 5.4 s left and cost 2 lines their repair.
              * a claim span that holds the line needs no help, and widening it moves timings the corpus
                already measured. `holds` is the same floor the adoption test uses, so the two halves of M5
                agree about which cue is truncated.
              * where the blind decode puts the line somewhere else entirely, the claim and the decode are two
                HYPOTHESES rather than one span measured twice. R1 fires exactly when the claims fit the audio
                BETTER than our decode does, so reaching out to a decode it has already outvoted would
                re-decode the line wherever the audio liked.

            AND NEVER PAST THE NEXT CLAIM'S ONSET (W2 review r1). The union used to take the blind end
            wholesale, which trusts it exactly where the blind decode is least trustworthy: R1 fires on an
            UNRELATED blind verdict, the state in which a blind line is known to smear across its neighbours'
            frames — 7-10 s on tfr-chosen's credit line, and about 6 s a line on the bench harness's own rig.
            A cue whose end was defaulted to `start + 1.0 s` (every LRC last stamp, every short caption cue)
            then bought a repair window tens of seconds long, covering the following lines entirely, and a
            single-line forced decode in such a window lands wherever the audio liked — the opposite of the
            anchoring the bullets above argue for. MEASURED on a fixture whose line is sung once at 12-15 s
            while a SUPERSTRING of its text is sung at 32-36 s, with the blind decode smearing the line
            12 -> 34 s: the uncapped window published it 11.96-34.88 s (its end 19.88 s late) and left 3 of 8
            lines gross; capped, 11.96-14.96 s and 0 gross. M5's own case is unchanged by the cap (a 7 s smear
            with only a near-duplicate neighbour: 11.96-14.96 s either way).

            WHY THE NEXT CUE AND NOT A TEMPO CEILING. The obvious cap — the line cannot take longer than N
            characters a second — has no safe N: measured over the corpus's 1645 truth lines, real sung lines
            run down to 0.7-1.7 alignable characters a second (tfr-chosen holds "You're the one" for 10 s,
            Pure_Mids "aw ah aw ah" for 6 s), so any ceiling tight enough to refuse the smear above also
            truncates a held note. `needs`' floor is a floor, not a duration: at 4x it fixes the fixture and
            at 5% of the corpus's lines it would cut a real one. The NEXT CLAIM is evidence, not a guess —
            the sheet's own statement about where this line's slot ends — and the cap is set so the PADDED
            window stops there, since the pad is what would otherwise reach into the next line's cue.

            AND THE LAST CUE IS CAPPED TOO, ON THE SHEET'S OWN PACING (W2 review r2). This used to read "the
            last cue has no next claim and so no cap: it is bounded by the audio, there is no following line
            for it to swallow" — and that was the wrong question. The final cue is not some rare shape: it is
            the one cue whose end is ALWAYS missing (`parse_lrc` gives the last line no `end`, so the reader
            defaults it to `start + 1.0 s`, under `needs` for any line past 25 alignable characters), so the
            hold-open fires on it on every LRC there is. What it can swallow is not a following LINE but a
            following REPEAT of its own words: an outro ad-lib the sheet never stamped. Nothing follows it to
            bound the window, so "bounded by the audio" means bounded by the end of the file. MEASURED on this
            rig (the pinned fixture below): a final line sung 50-53 s with its cue truncated at 50.6 s and the
            blind decode smearing it to 77.7 s bought a window of (49.6, 78.7) — 29 s against the 4 s every
            capped cue gets — and the forced re-decode inside it landed on an unstamped repeat of the same
            words at 70-73 s, publishing the line 20 s late.

            So the missing onset is replaced by the sheet's own `typical_slot`, floored at what the line
            needs: `start + max(typical_slot, needs(text))`. The slot is EVIDENCE of the kind the other
            cues use — the sheet's statement of how long it gives a line — estimated over the whole sheet
            rather than read off the one cue that is absent, and the `needs` floor keeps a rapid-fire
            sheet from capping the window below the line's own duration.

            THE PRICE, MEASURED, because a ceiling on the last cue can only be a trade. A cue truncated at
            50.6 s whose note the audio genuinely HOLDS to 65 s, re-decoded in each candidate window (one
            `regenerate` call apiece on the same matrix): uncapped 49.96-64.82 s (0.18 s short), the slot
            ceiling 49.96-61.60 s (3.40 s short), a `needs`-ONLY ceiling — this review's other suggestion —
            49.96-52.64 s (12.36 s short). All three put the line's START on the note; what a ceiling costs is
            the END, and `needs` alone costs nearly all of it, for the reason the paragraph above rejects a
            characters-per-second ceiling. Against that 3.40 s the cap buys back the 20 s displacement of the
            fixture above, and a late START is what core highlights, so the trade is taken in this direction.

            `holds` is False whenever this fires, so `max` keeps the cue's own end: the cap only ever reduces
            the WIDENING, never cuts what the sheet actually asserted.
            """
            start, end = claim_windows[line.index]
            blind = blind_spans.get(line.index)
            near_claim = blind is not None and start - _REPAIR_PAD_SEC <= blind[0] <= end + _REPAIR_PAD_SEC
            if blind is not None and near_claim and not holds(line.text, (start, end)):
                after = next((onset for onset in claim_onsets if onset > start), None)
                ceiling = (
                    start + max(typical_slot, needs(line.text)) if after is None else after - _REPAIR_PAD_SEC
                )
                end = max(end, min(blind[1], ceiling))
            window = (max(0.0, start - _REPAIR_PAD_SEC), end + _REPAIR_PAD_SEC)
            repair_windows[line.index] = window
            return ((line,), window)

        def needs(text: str) -> float:
            """The seconds `text` takes at `regenerate`'s floor: two emission frames per alignable character,
            the point below which a forced path is a smear rather than a fit. At 20 ms frames that is 25
            characters a second, past the fastest measured rap — a FLOOR, not an expected duration (the corpus
            sings its slowest lines at 0.7-1.7 characters a second), which is why `claim_run` bounds its
            hold-open with the next cue rather than with a multiple of this.

            THE COUNT IS `generate.alignable_chars`, imported rather than restated (W4 review r1): it is the
            input to `regenerate`'s own floor, and a second copy here had already drifted to the extent that
            both copies survived being reverted to a literal 0 under mutation. The blank is the MATRIX's, not
            0 (review M9) — on a vocabulary whose pad is elsewhere a literal 0 both counts the blank's own
            character and misses the real one, so the two floors would be read off different texts."""
            return 2 * alignable_chars(text, emissions) * float(emissions.frame_sec)

        def holds(text: str, span: tuple[float, float]) -> bool:
            """Could `span` hold `text` at all? `needs`' floor asked of a span about to be PUBLISHED rather
            than decoded in (review M5): a span tighter than it is a truncated cue — the reader's defaulted
            end, an LRC's last line, a caption cue covering only the first phrase of a long line."""
            return bool(span[1] - span[0] >= needs(text))

        def edge_stuck(line: Line) -> bool:
            """Did this repaired line's decode collapse onto its window's LEFT EDGE — a forced path through
            emissions with nothing in them to find? Measured on tfr-chosen's chopped-vocal outro, where the
            errors clustered at exactly the pad width (`_ADOPT_EDGE_SEC`)."""
            window = repair_windows.get(line.index)
            return window is not None and abs(line.start - window[0]) < _ADOPT_EDGE_SEC

        #: `_speech_mass` over the blind decode's own lines, per emission matrix: what singing reads as there.
        sung_mass: dict[int, float | None] = {}

        def heard(matrix: Any, line: Line, window: tuple[float, float]) -> bool:
            """Did THIS witness hear a spared line: its decode not stuck at its window's left edge (a forced
            path through emissions with nothing to find), and the matrix's acoustic model hearing speech over
            the claim window at `_SPOKEN_RATIO` of what it hears over the blind decode's lines."""
            if edge_stuck(line):
                return False
            if id(matrix) not in sung_mass:
                masses = [_speech_mass(matrix, ln.start, ln.end) for ln in blind_decode.lines]
                known = [m for m in masses if m is not None]
                sung_mass[id(matrix)] = median(known) if known else None
            reference, got = sung_mass[id(matrix)], _speech_mass(matrix, *window)
            if reference is None or reference < _SPOKEN_FLOOR:
                return False  # a matrix that barely hears the voice over the song's own lines cannot testify
            return got is not None and got >= _SPOKEN_RATIO * reference

        async def redecode(
            stage: str, runs: list[tuple[tuple[Line, ...], tuple[float, float]]], *, matrix: object
        ) -> dict[int, Line]:
            # A window decode that RAISES keeps its originals (regenerate's contract), and that is a note
            # on the trail, not a silence. Silence was measured: every R3 decode in the suite raised for as
            # long as the suite existed, and nothing could see it (review L8). The count also goes into the
            # verdict note's repairs, so a gate decline carries it too.
            # `matrix` is KEYWORD-ONLY and has no default, so every stage names the evidence it decodes: R4
            # alone decodes the MIX, and a defaulted argument once made "R4 decoded the stem" a one-token
            # slip no test could see (test_align_v2 now pins it with path-dependent emissions).
            # An `InfraFault` in a window decode is the kernel, not the window: `regenerate` (pure, so it
            # cannot know the type) would keep the originals and count a repair fault. So the decoder notes
            # one on its way through, and it is raised here (review M7). The blind decode ran the same
            # kernel first, so this is belt and braces: no repair stage turns a machinery fault into a
            # quietly unrepaired document. R4 still catches it, as it catches everything, because the mix is
            # optional evidence.
            faults: list[str] = []
            machinery: list[InfraFault] = []

            def decoder(
                log_probs: object, targets: Sequence[int], blank: int = 0
            ) -> tuple[list[int], list[float]]:
                # `blank` is FORWARDED, not defaulted away (review M9): `regenerate` reads it off the
                # matrix it slices and passes it here, so a repair decode uses the same blank column the
                # global decode did — on an HF bundle whose pad is not 0 the two used to disagree.
                try:
                    return forced_align_decoder(log_probs, targets, blank)
                except InfraFault as fault:
                    machinery.append(fault)
                    raise

            repaired = await asyncio.to_thread(
                regenerate,
                runs,
                matrix,
                decoder=decoder,
                language=req.language,
                faults=faults,
                # The arm belongs to every decode that produces a PUBLISHED timing, repairs included: a
                # window re-decoded without the separator the global decode used would put a repaired line
                # on a different token stream from the lines around it.
                separate_lines=separate_lines,
            )
            if machinery:
                raise machinery[0]
            if faults:
                await self._out.state(
                    req.job.job_id,
                    "align-global",
                    0,
                    "repair-faults",
                    f"{stage}: {len(faults)} of {len(runs)} window decodes raised, originals kept; "
                    f"first: {faults[0]}",
                    None,
                )
                repairs.append(f"{stage}: {len(faults)} window decodes raised")
            return repaired

        repaired_all: set[int] = set()

        def record(stage: _Source, repaired: Mapping[int, Line], adopted: Collection[int] = ()) -> None:
            repaired_all.update(repaired)
            for index in repaired:
                provenance[index] = _Source.ADOPTED if index in adopted else stage

        def adopt_where_unheard(stage: str, repaired: dict[int, Line]) -> tuple[dict[int, Line], set[int]]:
            # A window decode that cannot HEAR the line betrays itself two ways, both measured on
            # tfr-chosen's chopped-vocal outro: the forced path through flat emissions sticks to the
            # window's left edge, or its score sits far below the song's own median (which median: see
            # `blind_median`). Either way a human's claim timing beats a decode that heard nothing — the
            # line adopts the claim's span outright, words interpolated and flagged, graded `low` below.
            # Measured effect (claims present): gross errors 14 -> 0 on tfr-chosen; flyaway 82.7% and
            # mayday 76.9% raw within ±250 ms.
            #
            # `m5-adopt-floor` (DEFAULT OFF): UNLESS THE CLAIM SPAN CANNOT HOLD THE LINE (`holds`; review
            # M5's second half). What is adopted is the claim's span with the line's words spread evenly
            # inside it, so a span too short for the text publishes every word at a tempo nothing could sing,
            # ending the line seconds early — a guess replacing a measurement. The arm drops the repair
            # instead, which leaves the timing the line already had, and says so on the trail.
            #
            # IT FAILED §3.11's reject-if on the corpus and so ships off (W2 bench, `results/w2-m5arm-*`
            # against the default row of the SAME pre-review-r1 tree, `_runs/w2r-time_text` — both sides are
            # pre-r1, and `results/w2-*` is the post-r1 row now): the unperturbed row loses 16 of 1736 lines
            # within ±500 ms and gains a
            # gross line, ALL of it where a short caption cue's START is right and only its end is missing —
            # rap-god keeps 15 measured timings instead of adopting (-16 lines, -7.4 pt, +1 gross) and
            # JASON_MILLER drop50 one (+1 gross, the only Jamendo song in the sweep to gain one). That is
            # 0.92 pt of the 1.44 pt §3.11 allows 0.3 of, and the re-bench put the floor-off cost at -0.52 pt
            # on its own (`results/w2-noclock-time_text.json`), which does not change the arm's verdict. The
            # shape it exists for is real and still pinned
            # hermetically (`test_align_provenance`: a cue 7 s early with no end publishes 5.06 s out with
            # the arm off), but it is rarer in the corpus than the truncated-cue-with-a-right-start it costs.
            # With `claim_run`'s union the window is wide enough to decode in whenever the two spans touch,
            # so this was the backstop for the span itself, not the fix.
            # NOT ON A SHEET THE AUDIO SAYS IS SECONDS OFF AND THE CLOCK DECLINED TO MOVE (W4 review r1).
            # Adoption publishes a CLAIM's span as a measured timing, which beats a decode that heard
            # nothing only if the claim is on OUR clock. `claimmap.consensus` is the one place that is
            # asked, and when it abstains the claims keep their own clock — so W4's exact grid produced
            # exactly this hole: on never-be-alone's displaced sheets the winning candidate flipped from
            # `decode-median -3.18s (14/45)` to `envelope-lag -3.76s (4/44)`, which is under
            # `claimmap.MIN_INLIER_SHARE`, so nothing was mapped, R1 then adopted 38 of 44 RAW claim times
            # and the document published 3 s late (`gates/w4-clock.yaml`: off3 gross 0 -> 44, tempo098
            # 0 -> 44, tempo102 0 -> 43 — the wave's one shipped regression).
            #
            # THE DISPLACEMENT IS READ OFF THE AUDIO (`claim_lag`), never off the vote's own winner, and
            # that distinction is the whole of this guard. A refused candidate's own offset can be large
            # because OUR DECODE is scattered — `decode-median` is fitted against it — and a sheet whose
            # claims are right and whose decode is wrong is precisely the case adoption exists for (the
            # `WINDOWED` fixture, tfr-chosen's 14 -> 0 gross). The envelope fit asks the other question:
            # where does the SINGING sit relative to these claims. Over the phrase band `reconcile` calls a
            # line misbound at whatever the sheet's label, with a correlation good enough to have been
            # offered to the vote, that is positive evidence the claim times are not instants in this take.
            #
            # AND ONLY WHEN THE BLIND DECODE RELATES NOTHING to the claims (review H4's witness): a sheet
            # that reads AGREE or COARSE blind does describe this song on its own clock, so a large fitted
            # lag there is the spurious thing, not the claims.
            off_clock = (
                not claim_clock.applied
                and claim_lag is not None
                and claim_lag.correlation >= claimmap.MIN_ENVELOPE_CORRELATION
                and abs(claim_lag.seconds) > rc.COARSE_TOLERANCE_SEC
                and blind_verdict.verdict == rc.UNRELATED
            )
            reference = (
                blind_median
                if "l1-blind-median" in experiments
                else median(line.score for line in generated.lines if line.index not in returned)
            )
            adoption_medians.append(f"{reference:.2f} ({stage})")
            out = dict(repaired)
            adopted: set[int] = set()
            for index, fixed in repaired.items():
                window = claim_windows.get(index)
                if window is None:
                    continue
                flat = fixed.score < reference - _ADOPT_SCORE_GAP
                if not (edge_stuck(fixed) or flat):
                    continue
                if off_clock:
                    # The re-decode's timing stays, whatever it heard: it is at least measured on THIS
                    # audio, where the claim is a stamp from a clock we have evidence does not fit it.
                    unmapped.append(index)
                    continue
                if "m5-adopt-floor" in experiments and not holds(fixed.text, window):
                    out.pop(index)
                    truncated.append(index)
                    continue
                claim_span = adopted_line(fixed.text, index, window[0], window[1])
                if claim_span is not None:
                    out[index] = claim_span
                    adopted.add(index)
            return out, adopted

        def mix_kept(index: int) -> bool:
            """`l1-mix-kept`: is this a line R4 timed on the MIX, which R1 / R2 then leave alone? Their
            decode is the stem's, where R4 found nothing to hear, and R2's undid R4's in repro s6 (the
            mix's 27.00 s replaced by the jittered claim's 27.40 s). Default: they may re-decode it."""
            return "l1-mix-kept" in experiments and provenance.get(index) == _Source.MIX

        # REPAIR ORDER: evidence-first, then reconcile-driven.
        #
        # R3 (blind repeats between unique anchors) and R4 (stem-invisible lines against the mix) fire on
        # structural signals in the DECODE and the AUDIO — repeated text, missing stem evidence — that do
        # not need the reconcile verdict to know they might fire wrong. Running them before R1/R2 gives
        # reconcile a cleaner decode to grade, and lets the verdict promote when they succeed (measured on
        # tfr-chosen: R4 recovers the outro's -45 s errors, which flips the verdict from UNRELATED to
        # COARSE, which then lets R2's gross-line branch repair the misbound repeats R3 could not).
        #
        # R1 (UNRELATED humility) and R2 (STRUCTURAL / COARSE-gross) fire AFTER, on the fresh verdict.

        # ── R3: blind repeats, anchored between unique neighbours. With no claim to say WHICH chorus an
        # occurrence is, the unique lines around a repeated block are the best anchors available: the block
        # is re-decoded jointly in the gap between them, which constrains the misbinding to that gap.
        corroborated_now = {j.index for j in verdict.lines if j.corroborated}
        normalized = [" ".join(text.lower().split()) for text in line_texts]
        repeats = {i for i, text in enumerate(normalized) if text and normalized.count(text) > 1}
        blind = {
            ln.index for ln in generated.lines if ln.index in repeats and ln.index not in corroborated_now
        }
        if blind:
            runs = _anchored_runs(generated.lines, blind, req.audio.duration_sec)
            repaired = await redecode("R3", runs, matrix=emissions)
            if repaired:
                record(_Source.ANCHORED, repaired)
                generated = _with_lines(generated, repaired)
                if claimed:
                    verdict = steer(generated)
                fit = await asyncio.to_thread(fit_of, generated)
                repairs.append(f"re-decoded {len(repaired)} repeated lines between unique anchors")

        # ── `m6-window-spare` (default OFF): the never-sung candidates whose claim windows the TARGET sounds
        # in — misbound, maybe, not missing: the decode parked them on silence while the claim sits where the
        # target sings. Each is decoded inside its claim window on the target and comes back only if that
        # decode HEARD it (`heard`); never as the claim's span, which is how the arm used to put back text
        # nothing sings (review W1 r1).
        heard_here = [spared[i][0] for i in sorted(spared) if spared[i][1] == _Source.WINDOW]
        if heard_here:
            decoded = await redecode("never-sung", [claim_run(line) for line in heard_here], matrix=emissions)
            placed = {i: line for i, line in decoded.items() if heard(emissions, line, claim_windows[i])}
            if placed:
                record(_Source.WINDOW, placed)
                returned.update(placed)
                generated = _with_lines(generated, placed)
                fit = await asyncio.to_thread(fit_of, generated)
                repairs.append(
                    f"re-decoded {len(placed)} of {len(heard_here)} spared never-sung lines inside their "
                    f"claim windows on the {target_name}, where it heard them"
                )

        # ── R4: MIX AS A SECOND WITNESS. Also, under `m6-mix-spare`, where the never-sung rule hands a
        # claimed line whose window the stem is silent in and the mix is not (review M6): it is this
        # stage's line, so it is decoded with the stem-invisible ones — and put back only if the mix HEARD
        # it (`heard`): the mix's ENVELOPE, which spared it, is the band as much as a voice (review W1 r1:
        # 33 unsung lines — credits over intros, section headers — spared on it came back in W1, every one).
        if claim_windows and mix_target != stem_target:
            stem_invisible = [
                line
                for line in generated.lines
                if line.index in claim_windows
                and env_overlap(claim_windows[line.index][0], claim_windows[line.index][1]) < _NEVER_SUNG_ENV
            ]
            stem_invisible += [line for line, witness in spared.values() if witness == _Source.MIX]
            stem_invisible.sort(key=lambda line: line.index)
            if stem_invisible:
                try:
                    mix_emissions = await asyncio.to_thread(
                        aligner.emissions,  # type: ignore[attr-defined]
                        mix_target,
                        req.language,
                    )
                    mix_repaired = await redecode(
                        "R4", [claim_run(line) for line in stem_invisible], matrix=mix_emissions
                    )
                except Exception as exc:  # noqa: BLE001 - opportunistic; one attempt fails alone
                    await self._out.state(
                        req.job.job_id,
                        "align-global",
                        0,
                        "mix-witness-declined",
                        f"{type(exc).__name__}: {exc}",
                        None,
                    )
                else:
                    back = {
                        i: line
                        for i, line in mix_repaired.items()
                        if i in spared and heard(mix_emissions, line, claim_windows[i])
                    }
                    mix_repaired = {
                        i: line for i, line in mix_repaired.items() if i not in spared or i in back
                    }
                    if mix_repaired:
                        record(_Source.MIX, mix_repaired)
                        returned.update(back)
                        generated = _with_lines(generated, mix_repaired)
                        if claimed:
                            verdict = steer(generated)
                        fit = await asyncio.to_thread(fit_of, generated)
                        repairs.append(
                            f"re-decoded {len(mix_repaired)} stem-invisible lines against the mix"
                            + (f" ({len(back)} of them spared never-sung lines it heard)" if back else "")
                        )

        # ── R1: the humility repair. UNRELATED only says the two series disagree; WHICH is wrong is
        # answered by the audio — whichever series' envelope matches actual singing. When the claims win,
        # they become the anchors: every claimed line is re-decoded inside its claim window, which keeps
        # word/syllable precision (and the emission matrix already in hand) while adopting the claims'
        # occupancy. This used to hand the job to the windowed engine; repairing in place is strictly
        # more informative — the re-reconcile below reports whether the adopted windows actually agree.
        #
        # ON UNRELATED ALONE, never on `rc.TOO_FEW_PAIRS` (review r1). This is the widest repair in the step —
        # every claimed line re-decoded, some adopted outright — and `reconcile.MIN_FITTED_PAIRS` exists
        # because three or four disagreeing pairs are not evidence of anything. Before W2 those sheets read
        # UNRELATED and armed this; the floor that was meant to make the taxonomy careful was routing them to
        # its most sweeping branch instead.
        if verdict.verdict == rc.UNRELATED and len(claim_windows) >= rc.MIN_PAIRS:
            # OFF THE EVENT LOOP like every other fit in this step (review L6). It was the one inline
            # `fit_shift` left: bounded-lag correlation makes it 55 ms on a 60-minute recording rather than
            # 7.9 s, but 55 ms of synchronous numpy still stalls the socket keepalive the reaper reads.
            claim_fit = await asyncio.to_thread(
                activity.fit_shift,
                env,
                activity.expected_envelope(list(claim_windows.values()), len(env)),
            )
            if claim_fit.correlation > fit.correlation + 0.05:
                runs = [
                    claim_run(line)
                    for line in generated.lines
                    if line.index in claim_windows and not mix_kept(line.index) and line.index not in returned
                ]
                repaired, adopted_here = adopt_where_unheard(
                    "R1", await redecode("R1", runs, matrix=emissions)
                )
                if repaired:
                    record(_Source.WINDOW, repaired, adopted_here)
                    generated = _with_lines(generated, repaired)
                    verdict = steer(generated)
                    fit = await asyncio.to_thread(fit_of, generated)
                    repairs.append(
                        f"claims fit the audio better (r={claim_fit.correlation:.2f}); "
                        f"re-decoded {len(repaired)} of {len(runs)} lines inside their claim windows"
                    )

        # ── R2: the lines the claims genuinely contradict. A disputed line is exactly where a repeat may be
        # bound to the wrong occurrence (F2); the claim is the only occurrence-anchor available, so it is
        # re-decoded inside its claim window. Whether the witnesses then meet is NOT asked of the
        # re-reconcile (it would count the claim agreeing with itself): the re-reconcile only steers what is
        # left, and grading asks the blind verdict (review H4).
        #
        # WHICH LINES is `Reconciliation.disputed`'s to say since W2 (review M4), one rule per verdict class,
        # documented there. This asked the verdict's LABEL and spelled the two rules out here, and got the
        # COARSE one wrong: it thresholded the RAW residual against the fitted offset, so a 2% tempo sheet's
        # linear ramp read as 38 of 50 lines grossly misbound (the review's s9) and R2 re-decoded them all.
        # The Numb-vs-Avercage lesson the two rules carry is unchanged — sub-second jitter against
        # loosely-timed captions must not be repaired, a line seconds out must be — and it now also covers
        # the sheet that used to be mislabelled STRUCTURAL for one stray stamp: such a sheet is OFFSET now,
        # and an OFFSET sheet still disputes the line that sits seconds out.
        # A line R4 heard on the mix sits within jitter of a jittered claim and reads as disputed; R2's stem
        # decode, where the stem is silent, then adopts the claim over the mix's measurement (repro s6:
        # 27.00 s heard, 27.40 s published) — unless `l1-mix-kept` keeps it (`mix_kept`).
        disputed_indexes = set(verdict.disputed)
        if disputed_indexes:
            disputed_lines = [
                line
                for line in generated.lines
                if line.index in disputed_indexes
                and line.index in claim_windows
                and not mix_kept(line.index)
                and line.index not in returned
            ]
            if disputed_lines:
                repaired, adopted_here = adopt_where_unheard(
                    "R2", await redecode("R2", [claim_run(line) for line in disputed_lines], matrix=emissions)
                )
                if repaired:
                    record(_Source.WINDOW, repaired, adopted_here)
                    generated = _with_lines(generated, repaired)
                    verdict = steer(generated)
                    fit = await asyncio.to_thread(fit_of, generated)
                    repairs.append(
                        f"re-decoded {len(repaired)} of {len(disputed_lines)} disputed lines "
                        "inside their claim windows"
                    )

        # A repair may not introduce what verify punishes: spans clipped to neighbours (found live). Under
        # the `m2-order-clamp` arm, a repair that cannot be fitted between its trusted neighbours IN ORDER is
        # refused, its run back on the blind decode (review M2; default OFF, see `_clamped`). The gate below
        # then measures the series that will be published.
        reverted: frozenset[int] = frozenset()
        if repaired_all:
            generated, reverted = _clamped(
                generated,
                repaired_all,
                blind=blind_decode,
                frame_sec=emissions.frame_sec,
                ordered="m2-order-clamp" in experiments,
            )
        published_now = {line.index for line in generated.lines}
        if reverted:
            for index in reverted:
                if index in published_now:
                    provenance[index] = _Source.BLIND  # the blind decode's timing is back
                else:
                    provenance.pop(index, None)  # a spared never-sung line: no blind timing to go back to
            fit = await asyncio.to_thread(fit_of, generated)
            repairs.append(
                f"kept the blind decode for {len(reverted)} repaired lines that would not fit in order "
                f"between their trusted neighbours: {', '.join(f'[{i}]' for i in sorted(reverted))}"
            )

        unplaced = [index for index in sorted(spared) if index not in published_now]
        if unplaced:
            # Spared, but no witness HEARD it (its decode stuck at the window's edge, or the witness's
            # acoustic model hears no speech there: a credit over an intro, a header before a section), or
            # none could run (its window could not hold the text, its decode raised, the mix was unreadable,
            # `_clamped` refused its run): it goes where the never-sung rule sent it.
            repairs.append(
                "dropped never-sung after all, no witness heard them: "
                + ", ".join(f"[{i}] {spared[i][0].text[:40]!r}" for i in unplaced)
            )

        adopted = {index for index, source in provenance.items() if source == _Source.ADOPTED}
        if adopted:
            repairs.append(
                f"adopted {len(adopted)} claim timings where the decode heard nothing (stuck at the "
                f"window's edge, or scored {_ADOPT_SCORE_GAP} below the median line score: "
                f"{', '.join(adoption_medians)})"
            )
        if truncated:
            # By INDEX, not by refusal: two stages may both offer the same line the same too-short span.
            repairs.append(
                f"kept the measured timing of {len(set(truncated))} line(s) whose claim span is too short to "
                f"hold them, so a window decode reading 'heard nothing' is the window's doing: "
                + ", ".join(f"[{i}]" for i in sorted(set(truncated)))
            )
        if unmapped and claim_lag is not None:  # `off_clock` cannot be true without the fit
            # The counterpart note, and the one an operator reading "why is this document 3 s late" needs:
            # the claims were NOT adopted because the audio puts the singing seconds from them, the clock
            # declined to map them (`claim_clock.why` is in the verdict note beside this) and the blind
            # decode related nothing to them.
            #
            # THE DISPLACEMENT IS PRINTED IN `ShiftFit`'s OWN SIGN (W4 review r2), which is the sign every
            # other reader of this fit uses: seconds to ADD to the claims to reach the singing
            # (`activity.ShiftFit.seconds`, `claimmap.consensus`'s `envelope_lag`). So a sheet stamped 3 s
            # LATE prints -3.00s — the singing sits 3 s before these claims. Negating it here read the
            # displacement backwards on the wave's own exhibit (never-be-alone `off3`, envelope-lag -3.76s),
            # which is the one question this note exists to answer.
            repairs.append(
                f"did not adopt {len(set(unmapped))} claim timing(s): the audio puts the singing "
                f"{claim_lag.seconds:+.2f}s from these claims (r={claim_lag.correlation:.2f}) on a sheet "
                "the claim clock left on its own clock and the blind decode read as unrelated, so the "
                "window decode's own timing stands: " + ", ".join(f"[{i}]" for i in sorted(set(unmapped)))
            )

        # ── the wrong-text gate, on the REPAIRED series: do these timings describe the actual singing? ──
        # TWO-TIER, because this caller's null hypothesis differs from the LRC-shift one. Timings measured
        # ON this audio must fit at zero lag, and the measured wrong-song fits land at LARGE lags (+1.64 s,
        # -7.66 s) with r up to 0.31 — so near-zero lag is discriminating evidence in its own right. A live
        # song (Rise Up) with sparse singing scored r=0.31 at fit -0.02 s: right timings that a flat 0.40
        # floor alone refused.
        #
        #   tier 1: r >= 0.40 within ±0.5 s        (the calibrated MIN_CORRELATION, unchanged)
        #   tier 2: r >= 0.25 AND |lag| <= 0.1 s   (weaker correlation, but sitting exactly where a decode
        #                                           measured on this audio must sit; both measured
        #                                           wrong-song cases fail the lag half)
        #
        # Calibrated on FEW points (3 right songs, 2 wrong sheets + 1 live refusal) — stated, not buried.
        # EITHER FIT PASSES. Blind guards the humility case (our decode is scattered but claims might
        # rescue it — a gate on blind alone would refuse); repaired guards a bad repair. Refuse only when
        # both fail. Also: a high-correlation-but-large-lag repaired fit is a shifted-but-shaped series —
        # the claims are for another master, an OFFSET issue rather than a wrong-text one — and passes
        # too, because the claim's offset does not make the audio contain different words.
        # (The tiers are `_envelope_passes`, shared with the LINE_SYNC rung's sheet-span gate.)
        #
        # ON A STEM THE LEXICAL LIFT REPLACES THIS GATE wherever it measured the text (review H3; W3,
        # `lexical.BANDS`): scoring our own forced decode, which the audio pulls onto the voiced frames
        # whatever the words, it passed 152/320 bench wrong texts and 280/320 same-video wrong words, and
        # refused 8 right texts the lift passes (rap-god drop20, never-be-alone credit, 6 drop50 sheets),
        # while the lift alone refuses 0/448 right cases and passes 0/640 wrong ones. It still gates the mix
        # (with the lift's floor), a text the lift could not measure (under `lexical.MIN_LETTERS`, a decode
        # that raised) and the ASR tier (exempt from the lift: its words were heard on this audio).
        #
        # NOT FOR A PIN. The gate answers "is this the right text for this audio?", and for a person's re-pick
        # or paste a person already answered it: the old worker never graded a pin ("the operator has already
        # decided WHICH text publishes", f04a2d0e^ `steps/lyrics/grade.py`). Refused, a pin published nothing
        # and core went on showing the candidate the person had just rejected, with the reason only on the
        # trail (review W1 r1), and a right text a gate falsely refuses (rare here today: blind right texts
        # pass 32/32; W3's stricter wrong-text gate will refuse more) could never be shown at all. So a pin
        # the gate would refuse PUBLISHES, every line `low` and the document `low`, which is what the TV's
        # confidence can say about it; only a pin that cannot be timed at all (nothing alignable, words out
        # of order) still publishes nothing.
        if (
            envelope_gates
            and unvouched is None
            and not (_envelope_passes(blind_fit) or _envelope_passes(fit))
        ):
            why = (
                f"envelope gate refused: blind r={blind_fit.correlation:.2f} @ "
                f"{blind_fit.seconds:+.2f}s, repaired r={fit.correlation:.2f} @ {fit.seconds:+.2f}s"
                + (f"; repairs tried: {'; '.join(repairs)}" if repairs else "")
                # Why the envelope decided: the lift did not measure the text, or this is the mix.
                + f"; {lexical_note}"
            )
            if pin_of(req.job) is None:
                await decline(why)
                # A VERDICT on the text, not a failed attempt: `Refused` ends it, where None would have sent
                # it on to LINE_SYNC — the wrong-text hole W0 measured (168/320 bench wrong texts took it).
                return Refused(
                    TimingReport(
                        duration_sec=max(0.0, req.audio.duration_sec), engine=Engine.GLOBAL, refused=why
                    )
                )
            unvouched = why
            await self._out.state(
                req.job.job_id,
                "align-global",
                0,
                "pin-unvouched",
                f"{why} — a person chose this text, so it is not judged a wrong text: publishing it with "
                "every line graded low",
                None,
            )

        # ── grading, on the BLIND verdict (review H4). Corroboration means two INDEPENDENT measurements
        # agreeing, and only the blind decode is independent of the claims: every later stage re-decoded
        # inside a claim window (or adopted the claim), so its agreement with the claim is partly the
        # window's doing. A line whose timing a stage replaced is therefore `high` only where the blind
        # decode corroborated its claim AND the repair kept the position the two agreed on
        # (`Reconciliation.agrees` on the blind verdict's own fitted clock) — the exhibit's R4 lines, all
        # parked at the pad's edge a second before a +2.5 s claim, fail the second half.
        corroborated = {j.index for j in blind_verdict.lines if j.corroborated}
        disputed = {j.index for j in blind_verdict.lines if not j.corroborated}
        published = {line.index: line for line in generated.lines}

        # UNRELATED means claims exist but disagree with our decode line-for-line — WHICH side is right
        # is unresolved, so no line here can honestly claim `high`. Same for NO_CLAIMS on repeat-heavy
        # text (F2). Found on hello: 3 unique lines were labelled `high` while sitting 3–51 s off,
        # because with an UNRELATED verdict `corroborated` was empty and the fallback used blind-uniqueness.
        # `rc.DISAGREE`, not UNRELATED alone: W2's TOO_FEW_PAIRS verdict is the same disagreement measured on
        # three or four pairs, and GRADING is where an unresolved disagreement belongs — it only ever takes a
        # line's confidence DOWN. What that verdict must not do is arm R1 below (review r1), which moves
        # timings; that gate stays on UNRELATED, the verdict with the pairs behind it.
        claims_disagree = bool(claimed) and blind_verdict.verdict in rc.DISAGREE

        # THE PLACEMENT-AMBIGUITY DEMOTION (review §3.7; `margin.low_lines`, read below on the one branch
        # where nothing but our own decode places the line). It is a DEMOTION only — no line it touches was
        # graded `high` before this wave — which is what makes it safe to add to a rule whose reject-if is
        # "no claim mode publishes a `high` line more than 2 s off, today 0".
        # `conf-fuzzy-repeats` widens it to NEAR-repeats (`host.config.ALIGN_EXPERIMENTS`; default off).
        # THE CONTROL IS THE WHOLE RULE, not merely the margin half. `placement` is already empty under the
        # arm, and `low_lines` would then apply its SCORE half alone — a demotion the rule this replaces did
        # not have, so an A/B against it would compare two versions of W6 and read the margin as worth less
        # than it is (measured while building this: 385 `high` blind Jamendo lines under the half-control
        # against 407 under the real one).
        ambiguous = (
            frozenset()
            if "conf-legacy" in experiments
            else margin.low_lines(placement, {line.index: line.score for line in blind_decode.lines})
            | (
                margin.fuzzy_repeats(dict(enumerate(line_texts_active)))
                if "conf-fuzzy-repeats" in experiments
                else frozenset()
            )
        )

        def line_confidence(index: int) -> str:
            if unvouched is not None:
                return "low"  # a pin a wrong-text gate would have refused: nothing vouches for any line
            if doubted:
                return "low"  # the lexical doubt band: its words may not be the sung ones (`lexical.BANDS`)
            source = provenance.get(index, _Source.BLIND)
            if source == _Source.ADOPTED:
                # An adopted line ECHOES the claim; a reconcile would count it corroborated, but agreement
                # with evidence you copied is not agreement.
                return "low"
            if index in reverted:
                # A line some stage judged needed repair (a repeat, stem-invisible, disputed), whose repair
                # `_clamped` refused: the blind timing is back with that doubt unresolved.
                return "low"
            if source == _Source.ANCHORED:
                # R3 re-decoded it between unique anchors WITHOUT the claims, so where it landed is a second
                # measurement independent of them, and one that sits on its claim on the blind verdict's
                # own clock is two witnesses agreeing (review W1 r1). The blind corroboration the other
                # sources need is absent here by construction: R3 takes exactly the repeats the blind
                # verdict did NOT corroborate, so requiring it graded every R3 repair `low`.
                return (
                    "high"
                    if index in claimed and blind_verdict.agrees(published[index].start, claimed[index])
                    else "low"
                )
            if source != _Source.BLIND:
                kept = index in corroborated and blind_verdict.agrees(published[index].start, claimed[index])
                return "high" if kept else "low"
            if index in corroborated:
                return "high"
            if index in disputed:
                return "low"
            if claims_disagree:
                return "low"
            # ── HERE AND NOWHERE ELSE: the only grade that rests on OUR DECODE ALONE (review §3.7). Every
            # branch above that says `high` says it because a CLAIM independently agreed with the blind
            # decode on the blind verdict's own clock, and review H4's whole argument is that two
            # independent measurements agreeing beats the decode's own opinion of itself (F3). The margin IS
            # the decode's opinion of itself, so charging a corroborated line for it double-counts the
            # uncertainty the second witness just settled — and the measurement says exactly that: on 4
            # songs x truth/off15/drop50 (516 lines) the demotion applied to every branch cost 84 of 278
            # word wipes and found NOTHING, because claim-mode bad-among-high was already 0.00%; restricted
            # to here it changed not one grade on those 516 lines. Here it is worth TWENTY-THREE gross `high`
            # lines and 9 pts of bad-among-high (blind, 20 Jamendo songs, 866 lines: 51.5% of lines `high` at
            # 11.88% more than 0.5 s off and 23 more than 2 s off, against 33.0% / 2.80% / ZERO).
            # `conf-legacy` is the control that restores the first column.
            if index in ambiguous:
                return "low"
            # THE AT-CHANCE RULE, KEPT AS A CONJUNCT (review §3.7). On its own "is this line's text repeated
            # in the sheet?" separates nothing — over 866 blind Jamendo lines it grades 51.5% `high` with
            # 11.9% of those more than 0.5 s out against 12.9% of the `low` ones, which is the review's
            # measured 12.3 / 12.6 — but it is a DEMOTION, and dropping it can only PROMOTE lines, the one
            # direction §3.7's second reject-if ("no claim mode publishes a `high` line more than 2 s off,
            # today 0") forbids taking on faith. It is also nearly unreachable: R3 takes every uncorroborated
            # repeat and the `ANCHORED` branch above grades it, so on the same 866 lines removing this test
            # changed not one grade. Kept for the lines R3's anchoring cannot cover.
            return "low" if index in repeats else "high"

        # ── word ENDS, held through the singing (review §3 item 5; W4, `domain/lyrics/ends.py`) ──
        # CTC is peaky: a phrase-final end is a median 121 ms EARLY on the exact clock, 36.3% of them land
        # within ±100 ms, and the TV lights a word while `start <= pos < end`, so the correct word is lit
        # for 66.0% of sung time. Each end is walked forward while the target's envelope still calls it
        # singing, capped at the next word's own start and at 3 s. STARTS NEVER MOVE — that is what makes
        # this different from the energy-snap this repo rejected (README: onsets snapped to the nearest
        # rise cost ±250 ms 77.3% -> 70.7%). Measured on this path over the 20-song Jamendo corpus, truth
        # claims (`ends.py`'s table): phrase-final end ±100 37.5 -> 59.8, bias -114 -> -5.6 ms, highlight
        # 65.8 -> 77.1%, with every onset metric equal to the digit and all 20 `onsets_sha256` identical.
        #
        # ON A STEM ONLY (W4 review r1). `ends.ACTIVE_LEVEL` is a fraction of the TARGET's own loud level,
        # which is a silence test on a vocals stem and no test at all on a mix — 92-98% of a corpus mix's
        # frames clear it, with continuous active runs of 38-184 s, against 59-77% and 10-19 s on the same
        # songs' stems (`ends.py`, ON A VOCALS STEM ONLY). So on a stemless song, and on the `ALIGN_ON_MIX`
        # retry, the walk would never stop: every end would run to the next onset and every line's last word
        # into the next line (or +3 s), which is the `ends-tile` arm plus a tail, default-ON and unmeasured —
        # the corpus this feature's numbers come from has a stem for all 20 songs. `on_stem` is the same fact
        # the lexical bands switch on, computed once above. A mix-calibrated theta is fittable and unfitted.
        #
        # HERE, AND NOT INSIDE `generate` (review §3.5's own point, and the reason it is a post-pass): the
        # gate above, the never-sung rule, the blind envelope fit and R4 all read `Line.end` — the rule's
        # `env_overlap(line.start, line.end)` and its chars-per-second test, and `fit_of`'s expected
        # envelope over the line spans. Extending ends earlier would raise every line's envelope overlap
        # and lower its char rate, which LOOSENS the wrong-text and never-sung gates by construction while
        # looking like an accuracy win.
        #
        # WHAT STILL READS AN END AFTER THIS POINT, all of it either starts-only or telemetry:
        #   * grading, below — reads STARTS (`blind_verdict.agrees(published[i].start, ...)`).
        #   * `measure` — `usable` and `out_of_order` are judged on starts; the end-derived rows (coverage,
        #     smears, flashes, long gaps) are telemetry for this engine, which `policy._READS` offers
        #     neither ALIGN_ON_MIX nor DROP_WINDOWS. A held note can now read as SMEARED (the cap is on the
        #     MOVE, not on a word's length) and `overshoot` cannot appear, since the walk stops at the last
        #     envelope frame.
        #   * `attribute`, later and on the written file: a line's span is its words' span, and a longer
        #     line needs more overlap to be claimed by a diarized turn (`MIN_OVERLAP_FRACTION` of its OWN
        #     duration), so an end held into silence can leave a line's `part` unset. Conservative
        #     direction — unknown rather than wrongly coloured — and unmeasured either way: the gated
        #     pyannote weights are on no box this project has benched.
        #
        # `ends-raw` is the CONTROL, not a failed arm: with it on, ends are the raw decode's, which is the
        # column §3.5's reject-if gates are the gain over. It exists because the arm switch is the only
        # thing the bench can move without editing code, and a display post-pass has to be measurable A/B
        # (the harness records `align_config`, so an arm's run cannot be mistaken for the default's).
        held = (
            generated
            if "ends-raw" in experiments or not on_stem
            else ends.extend_ends(
                generated,
                # numpy stays on this side of the seam (`domain/` is pure): frame levels cross as a list.
                env.tolist(),
                activity.HOP_SEC,
                tile="ends-tile" in experiments,
            )
        )
        ends_note = _ends_why(generated, held, experiments, on_stem=on_stem)
        generated = held

        doc = generated.as_doc()
        lines_json = doc.get("lines")
        if isinstance(lines_json, list):
            for line, rendered in zip(generated.lines, lines_json, strict=True):
                rendered["confidence"] = line_confidence(line.index)

        # NO residual is fed to `measure` here, deliberately: reconcile's fitted offset describes THE
        # CLAIM (our timings never moved to match it), and a residual on the report would let `decide`
        # offer RESHIFT — a knob that re-places input timings this engine never used. The offset still
        # reaches the trail through `blind_verdict.why` below.
        #
        # `claims_related` IS fed, and it is the one thing on the report that compares this document with
        # the text's own timings rather than with the audio: `policy.decide` spends the LINE_SYNC rung on a
        # document nothing related to its claims, and `policy.improves` lets that rung's document replace
        # this one (W4's cross-kind comparison; the measured trade is in `decide`'s rule 6).
        #
        # THE LAST RECONCILE, NOT THE BLIND ONE — the opposite choice from grading's (review H4), and for the
        # same reason read the other way round. Grading asks whether a line's timing is CORROBORATED, and a
        # line re-decoded inside its claim window agrees with the claim partly by construction, so only the
        # blind decode can answer it. This asks whether the document ABOUT TO PUBLISH tells the same story as
        # the sheet — and there an agreement the repairs produced is the answer, not a contaminant: if R1/R2
        # moved our lines onto the claims, the two documents now say the same thing and the WORDS are the
        # extra information. Measured at `run_align` over the W2 sweep (`_runs/w2r2-run_align`, whose trail
        # note carries both readings): of the 54 song-modes whose blind verdict is UNRELATED, 18 read AGREE,
        # COARSE or STRUCTURAL after the repairs, and those 18 word documents hold 6 gross lines between them
        # where the 36 still UNRELATED hold 556. On the 357 with a line document beside them the last verdict
        # isolates every one of the 299 gross lines in 18 cases; the blind one spreads them over 23.
        # UNRELATED alone, not `rc.DISAGREE`: TOO_FEW_PAIRS is the same disagreement on three or four pairs,
        # and where it may lower a line's confidence (grading, above) it must not decide which DOCUMENT
        # publishes — this is the gate R1's is, "the verdict with the pairs behind it".
        # READ BEFORE `_clamped`'s reverts, like the trail note it is printed beside: a reverted line is back
        # on the blind decode with its doubt unresolved, and it is graded `low` for exactly that reason.
        report = measure.measure(
            doc,
            duration_sec=req.audio.duration_sec,
            engine=Engine.GLOBAL,
            claims_related=(
                None
                if verdict.verdict in (rc.NO_CLAIMS, rc.TOO_FEW_PAIRS)
                else verdict.verdict != rc.UNRELATED
            ),
        )
        if report.words == 0:
            await decline("generated document measured zero timed words")
            return None
        if report.out_of_order:
            # EXPECTED on the default clamp (`_clamped_v2`, the pre-W1 clamp): it still publishes backwards
            # word starts on review M2's shapes (`test_repair_order` seeds 2/6/12/30), and those are what
            # the gated LINE_SYNC rung recovers (16 of the 47 right texts M2 sent there at W1). Under the
            # `m2-order-clamp` arm it should not arise: that `_clamped` refuses any repair it cannot order,
            # and the blind decode is monotonic. Either way it goes on the trail WITH its lines, before the
            # verdict note: `decide` will drop the whole text to line sync over it, and a count alone does
            # not say which line.
            await self._out.state(
                req.job.job_id,
                "align-global",
                0,
                "out-of-order",
                _backwards_why(
                    doc, index_of=[line.index for line in generated.lines], repaired=repaired_all - reverted
                ),
                None,
            )

        graded_high = sum(1 for line in generated.lines if line_confidence(line.index) == "high")
        confidence = (
            "low"
            if unvouched is not None
            else "medium"
            if doubted
            else "high"
            if graded_high >= 0.7 * len(generated.lines)
            else "medium"
        )
        # `vouched` is the WORDS' axis, `confidence` the timings' (review W3 r1): a doubt-band document and an
        # unvouched pin are published, and core must rank them under a text a wrong-text gate passed.
        # `confidence` alone could not say it — it is sent as `timingConfidence`, which core's `lyricsRank`
        # never reads, so a doubted word document tied with a fully vouched one at the top rank. It is TRUE
        # only where a gate actually read these words and did not doubt them (`words_measured`,
        # `words_doubted`; W3 review r2), which on the mix is a narrower question than the grading band's.
        timed = self._write(
            req,
            doc,
            TIMING_WORD,
            confidence,
            report=report,
            vouched=words_measured and not (words_doubted or unvouched is not None),
        )
        # The evidence on the trail, not just the verdict: this line is what makes a wrong-lyrics report
        # debuggable from the audit page. Fire-and-forget would drop it on a closed socket; awaited.
        await self._out.state(
            req.job.job_id,
            "align-global",
            0,
            # The BLIND verdict: the one grading read. The ladder's last re-reconcile follows it, labelled
            # as what it is, so a verdict the repairs moved (tfr-chosen: UNRELATED -> COARSE) stays legible.
            blind_verdict.verdict,
            # FIRST, because every threshold in this note is read off THIS bundle's calibration row and a
            # reader comparing two jobs needs to know they are the same bundle before comparing anything else
            # (W4b review r1; `_bundle_why`).
            f"{_bundle_why(emissions)}; "
            f"envelope r={blind_fit.correlation:.2f} (blind), r={fit.correlation:.2f} (repaired)"
            f"{'' if envelope_gates else ', not gating: the lift is'}; {lexical_note}; "
            f"{blind_verdict.why}; "
            # THE CLAIM CLOCK BESIDE THE VERDICT IT DECIDED, because the verdict's own offset is now the
            # RESIDUAL left after the map: a note reading "agree" over claims the sheet put 1.5 s late is
            # only legible beside the 1.5 s this moved (review H1). Printed whether or not it applied —
            # "the map lost the vote" is the answer a wrong-sync report needs just as much — and only
            # where claims exist, since the verdict already says an untimed text arrived untimed.
            + (f"{claim_clock.why}; " if claimed else "")
            + (
                f"after repairs {verdict.verdict}, {verdict.agreement:.0%} of {verdict.pairs} lines agree "
                "(steers the repairs, never the grade); "
                if verdict is not blind_verdict
                else ""
            )
            + (f"{'; '.join(repairs)}; " if repairs else "")
            + f"{_sources_why(provenance, [line.index for line in generated.lines])}; "
            # WHY THE LINES ARE GRADED AS THEY ARE, beside the provenance that used to decide it alone: a
            # "these lyrics are out of sync" report on a document whose lines are all `low` is answered by
            # the margins, and a document that publishes `high` lines is only defensible with them printed.
            + f"{_margin_why(placement, ambiguous, len(generated.lines))}; "
            # ONLY UNDER THE ARM: the default's token stream is what every other clause already describes,
            # and a clause on every note saying "no separator" would be noise on 100% of production runs.
            + (
                f"{_linesep_why(separator_of(emissions), named=separator_named(emissions))}; "
                if separate_lines
                else ""
            )
            # LAST of the evidence clauses because it is the last thing that touched a timing, and it is
            # about ENDS where every clause before it is about a line's placement.
            + f"{ends_note}; "
            + f"{graded_high}/{len(generated.lines)} lines high",
            None,
        )
        return timed

    @staticmethod
    def _aligned_line_starts(doc: dict[str, object]) -> tuple[float, ...]:
        """Each line's start, from its FIRST TIMED WORD — never the line's own `start` field.

        Some aligners copy the input's line start through unchanged while moving the words inside it, so
        reading that field would hand the next RESHIFT the series it was trying to correct.
        """
        starts: list[float] = []
        lines = doc.get("lines")
        if not isinstance(lines, list):
            return ()
        for line in lines:
            words = measure.timed_words({"lines": [line]})
            if words:
                starts.append(min(start for _w, start, _e in words))
        return tuple(starts)

    def _placed(self, req: TimeRequest) -> tuple[Segment, ...]:
        """The text's segments, re-placed onto THIS recording's clock before the aligner ever sees them.

        TWO REFERENCES, tried in order, and the first one is why this is no longer a retry-only concern.

        1. VOCAL ACTIVITY measured on the audio (`domain/audio/activity`). Independent of any alignment, so
           it works on a FIRST attempt — which is the case that could not be corrected at all before.
        2. The PREVIOUS ALIGNMENT's line starts, when this attempt asked for a reshift. Kept as a fallback
           because it can catch a per-line drift that one global offset cannot.

        WHY 1 HAD TO EXIST. whisperx crops the audio to each segment's provisional span and aligns inside
        it, so an offset sheet is not refined back — the offset passes through with unity gain (measured:
        `bias = 1.005 x offset + 131 ms` over a 0..5 s sweep). Reference 2 alone could never fix that on a
        first attempt, and on a retry it fits against an alignment carrying the very error it is removing.

        An earlier version fitted the text against its own windows — two views of one series — which is a
        near-identity and made `Knob.RESHIFT` a no-op that burned an alignment pass.
        """
        fit = None
        if req.text.has_own_timings:
            spans = _timed_spans(req.text.segments)
            if len(spans) >= place.MIN_PAIRS:
                fit = self._activity_fit(req, spans)
        return self._placed_by(req, fit)

    def _placed_by(
        self, req: TimeRequest, fit: ShiftFit | None, *, clock: claimmap.ClaimMap | None = None
    ) -> tuple[Segment, ...]:
        """`_placed` with the vocal-activity fit already measured (the LINE_SYNC gate measures it anyway).

        The fit MOVES the sheet only when it is trustworthy (`ShiftFit.usable`) over at least
        `place.MIN_PAIRS` timed lines; anything less leaves the sheet exactly where it was, which is the
        behaviour that shipped before the fit existed.

        A `clock` REPLACES the fit (W2: the LINE_SYNC rung, `_line_sync_clock`). Where a caller has VOTED on
        the claims' clock, the vote is the whole decision: the fit's r >= 0.40 is one candidate's credential
        rather than a licence to shift, and a map the vote did not apply deliberately leaves the sheet where
        the text put it — which is how bad-guy's and numb's truth sheets stop being published +0.72 s and
        +0.62 s late (`gates/w3-lines.yaml`'s `zero-pm500-documents-not-up`). `clock=None` keeps the old
        behaviour exactly, and is what a caller with nothing to vote with passes.
        """
        segments = list(req.text.segments)
        pairs = len(_timed_spans(segments))
        if clock is not None:
            segments = list(_mapped(segments, clock))
        elif fit is not None and fit.usable and req.text.has_own_timings and pairs >= place.MIN_PAIRS:
            shift = place.Shift(
                offset_sec=fit.seconds,
                scale=1.0,
                pairs=pairs,
                applied=True,
                why=f"vocal-activity fit r={fit.correlation:.2f}",
            )
            segments = list(place.apply_shift(segments, shift))
        if not req.reshift or not req.reference_starts:
            return tuple(segments)
        shift = place.estimate_shift_from_starts(
            [start for start, _end in measure.line_spans(segments)], list(req.reference_starts)
        )
        return place.apply_shift(segments, shift)

    def _activity_fit(
        self, req: TimeRequest, spans: Sequence[tuple[float, float]], *, gate: bool = False
    ) -> ShiftFit | None:
        """The claimed `spans` fitted onto the audio's own vocal activity, or None when unmeasurable.

        PREFERS THE VOCALS STEM. Measured residuals are 10-20 ms against it and 140-150 ms against the full
        mix, because an instrumental bed fills the silences the fit reads. Both are worth doing; `on_mix` is
        honoured so a retry that deliberately moved to the mix is fitted against what it will align on.

        NEVER RAISES for PLACEMENT: an unreadable file or a numpy that is not installed is None, which
        placement reads as "leave the sheet where it was" — the aligner that follows reads the same audio
        and raises there if the machinery is at fault.

        EXCEPT AS A GATE (`gate=True`, the LINE_SYNC rung), which lets an `InfraFault` through (review M7,
        r1): under `syncMode=lines` the gate is the ONLY reader of the audio, so its "not measured" None
        turned a file ffmpeg would not decode into a declined attempt for every text, and the ladder walked
        on into an ASR transcript or a published "no lyrics" for a song nothing had measured. Anything
        else it raises is still the unanswered question.
        """
        try:
            from encore_worker.adapters.ml import load_audio_mono_16k  # noqa: PLC0415
            from encore_worker.domain.audio import activity  # noqa: PLC0415

            # ffmpeg-backed, so a MIX target (`original.webm`) fits too — the same live-found gap as v2's
            # envelope gate; read_wav_mono reads only WAV/FLAC. As a GATE, the stem whatever the attempt
            # aligned on: the sheet gate is calibrated there, and on the mix it cannot discriminate.
            signal = load_audio_mono_16k(req.audio.align_target(on_mix=req.on_mix and not gate))
            return activity.fit_sheet_to_audio(signal, 16000, list(spans))
        except InfraFault:
            if gate:
                raise  # the machinery, not this text: fails the job (review M7)
            return None
        except Exception:  # noqa: BLE001 - see the docstring: a failed fit is an unanswered question
            return None

    def _placed_spans(self, req: TimeRequest, placed: Sequence[Segment]) -> tuple[Segment, ...]:
        """What the aligner may search within. `DROP_WINDOWS` widens this to the whole segment.

        An UNTIMED text gets provisional spans first. whisperx crops the audio per segment, so a segment
        with no `start` raises `KeyError` inside the aligner — which the caller's broad `except` turns
        into a silently discarded candidate. A plain lyrics sheet has no timings by definition, so without
        this every one of them was thrown away and the song fell through to ASR.
        """
        spans = tuple(req.text.windows) if (req.text.windows and not req.drop_windows) else tuple(placed)
        if place.needs_spans(spans):
            return place.spread_over(spans, req.audio.duration_sec)
        return spans

    def _write(
        self,
        req: TimeRequest,
        doc: dict[str, object],
        timing: str,
        confidence: str,
        report: object | None = None,
        vouched: bool = True,
    ) -> TimedDoc:
        """Write the document under a ref the core can merge on, and build the record.

        THE KNOBS ARE IN THE REF, so a retry never overwrites the attempt it retried (review H2: the mix
        retry rewrote the stem document's file in place, so even a workflow that wanted the stem document
        back could only publish the mix one's bytes). A first attempt spends no knob and keeps the plain
        `{media}-{label}-{timing}.json` it always had; a retry appends its knob set in `Knob` order.

        EVERY ATTEMPT IS STAGED IN JOB SCRATCH (`api.attempt_ref`), and `publish` places them in the store
        after its ownership check (review W1 r1: a job an `InfraFault` failed mid-ladder left its earlier
        attempts in the store, reported to nothing, for good). A PINNED job's go to `work/{job}/pinned/`
        (review H5): the pinned ref is the file the TV shows right now, so an attempt the policy may still
        reject — refused, incoherent, beaten by best-so-far — must not reach it, and must not become a rival
        candidate beside it either. `publish` places the committed one at the pinned ref; the rest go with
        the scratch.

        A document that lost lines of its text carries the whole text (`_with_source_lines`), so a later
        re-pick of it re-times every line the person saw in the source, not just the ones this decode kept.

        `vouched=False` is a wrong-text gate's doubt about the WORDS, which core reads on its own wire field
        (`TimedDoc.vouched` -> `vouched: false`): the lexical doubt band, an unvouched pin, and a text no such
        gate could read. Default True — every other
        caller either passed its gate (the global engine above the doubt band, the LINE_SYNC rung) or is
        exempt from one (a transcript, whose tier already says `low`).
        """
        measured = (
            report
            if isinstance(report, TimingReport)
            else measure.measure(doc, duration_sec=req.audio.duration_sec)
        )
        knobs = "".join(f"-{knob.value}" for knob in Knob if knob in req.knobs)
        ref = attempt_ref(req.job, f"{req.text.label.replace(':', '-')}{knobs}-{timing}.json")
        absolute = os.path.join(req.job.media_dir, ref)
        os.makedirs(os.path.dirname(absolute), exist_ok=True)
        with open(absolute, "w", encoding="utf-8") as handle:
            json.dump(_with_source_lines(doc, req.text.segments), handle, ensure_ascii=False)
        return TimedDoc(
            ref=ref,
            timing=timing,
            confidence=confidence,
            report=measured,
            tier=req.text.tier,
            vouched=vouched,
            language=req.language,
            label=req.text.label,
            line_starts=self._aligned_line_starts(doc),
        )

    async def diarize(self, job: JobRef, audio: AudioRef, doc: TimedDoc) -> TimedDoc:
        """Attach a duet `part` to each line (`attribute`, review M15), REWRITING the published document.

        An earlier version ran the diarizer and discarded its answer, which cost a model pass and changed
        nothing. The turns are now applied to the document on disk, because that file is what the TV
        reads — returning an annotated record while leaving the artifact unannotated would be worse than
        not diarizing at all.

        Optional throughout: any failure returns `doc` untouched. A song shown in one colour is a
        cosmetic loss; a failed job is not.
        """
        if self._a.diarizer is None:
            return doc
        # The stem when there is one: diarization on a full mix attributes the band as a speaker.
        target = audio.vocals_path or audio.path
        try:
            turns = await asyncio.to_thread(self._a.diarizer.diarize, target)
        except Exception:  # noqa: BLE001 - a diarizer that cannot answer must not fail a job
            return doc
        if not turns:
            return doc

        absolute = os.path.join(job.media_dir, doc.ref)
        try:
            with open(absolute, encoding="utf-8") as handle:
                loaded = json.load(handle)
            annotated = attribute.attribute(loaded, list(turns))
            if annotated is loaded:
                return doc  # nothing trustworthy to add: one voice, or not a confident duet (`attribute`)
            with open(absolute, "w", encoding="utf-8") as handle:
                json.dump(annotated, handle, ensure_ascii=False)
        except (OSError, ValueError):
            # The document is already published-shaped and correct without parts; a rewrite that
            # failed halfway is the one outcome worth guarding, and json.dump to a fresh handle either
            # replaces the file or leaves the previous bytes.
            return doc
        return doc

    # ── publication ──────────────────────────────────────────────────────────────────────────────

    async def publish(self, job: JobRef, doc: TimedDoc | None, *, placing: Sequence[TimedDoc] = ()) -> str:
        """THE GUARDED STEP. Re-asserts ownership before making anything visible.

        The check is HERE and not only at reconnect, because a lease can expire during a 45-minute
        alignment: a workflow that legitimately owned its job when the socket came back can be
        reassigned before it reaches this line. Checking only at reconnect leaves exactly the window
        where two workers publish different lyrics for one song.

        The attempts are PLACED here, after the check, copied from job scratch to their store refs
        (`api.store_ref`) through a replace, so a reader of a ref sees the old document or the new one,
        never half of either, and a lost lease leaves the store untouched. An ordinary job places every
        document it wrote (`placing`: the published one and the rest, which core keeps for retention and
        for a person's re-pick); a PINNED job only its accepted attempt, at the pinned ref (review H5).
        The returned uri is the published document's store ref.
        """
        if not await self._out.confirm_ownership(job.job_id):
            raise NotOurJob(self._out.explain_ownership(job.job_id))
        # Nothing before this point was externally visible, so there is nothing to undo.
        pin = pin_of(job)
        if pin is not None and pin.refused is not None:
            return ""  # a refused pin times nothing and places nothing (`_acquire_pinned`)
        staged = [doc] if pin is not None and doc is not None else list(placing)
        if doc is not None and pin is None and all(d.ref != doc.ref for d in staged):
            staged.append(doc)  # the published document is placed whether or not the caller listed it
        for attempt in staged:
            # A PINNED re-time becomes visible HERE, and only here (review H5): the accepted attempt moves
            # from job scratch to the ref core pinned, which its merge then overwrites in place.
            await asyncio.to_thread(_place, job.media_dir, attempt.ref, store_ref(job, attempt.ref))
        return store_ref(job, doc.ref) if doc is not None else ""

    async def note(
        self, job: JobRef, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None:
        """Emit `job:state`. Fire-and-forget: a lost note must never fail a job."""
        try:
            await self._out.state(job.job_id, state, attempt, verdict, why, knob)
        except Exception:  # noqa: BLE001 - diagnostics must not be able to fail work
            pass

    # ── internals ────────────────────────────────────────────────────────────────────────────────

    def _work(self, job: JobRef, *parts: str) -> str:
        """Per-job scratch, under the media volume so a remote worker's temp lives with its outputs.

        Keyed by job id, which the core keeps STABLE across requeues — so a resumed job finds the work
        its previous attempt already did instead of starting from an empty directory.
        """
        path = os.path.join(job.media_dir, "work", job.job_id, *parts)
        os.makedirs(path, exist_ok=True)
        return path


class _Permanent(InfraFault):
    """A fault no retry can fix: a capability this box does not have. An `InfraFault`: no step declines it."""

    retryable = False


def _has_timings(cues: Sequence[Segment]) -> bool:
    """Did the provider return SYNCED lyrics, or a plain wall of text?

    `bool` excluded: `True` is an `int`, and a start of `True` is not a timestamp.
    """
    return any(
        isinstance(c.get("start"), (int, float)) and not isinstance(c.get("start"), bool) for c in cues
    )


def _has_word_spans(cues: Sequence[Segment]) -> bool:
    """Did the provider return WORD-level timings? LRCmux can; LRCLIB cannot."""
    return any(isinstance(c.get("words"), list) and c["words"] for c in cues)


def _timing_of(provider: ports.LyricsProvider, cues: Sequence[Segment]) -> str | None:
    """What the returned text is timed to, read from the PAYLOAD rather than a provider's claim.

    Derived rather than declared because a response tagged word-level whose lines carry no word spans is
    not word-level, and believing the tag would offer retry knobs with nothing to act on.
    """
    if _has_word_spans(cues):
        return TIMING_WORD
    if _has_timings(cues):
        return TIMING_LINE
    return None


def _provider_label(provider: ports.LyricsProvider) -> str:
    """The label reaching the decision trail.

    A multiplexer names its UPSTREAM when it has one, so the trail says `lrcmux:KuGou` rather than
    `lrcmux` — which is what makes a systematically bad source identifiable instead of anonymous.
    """
    upstream = getattr(provider, "last_source", None)
    return f"{provider.name}:{upstream}" if isinstance(upstream, str) and upstream else provider.name


# ── a pinned re-time (review H5) ─────────────────────────────────────────────────────────────────

#: A paste's label, and the one core's `LyricsTextSource` spells `manual` (`__main__._text_source_of`).
_MANUAL_LABEL = "manual"


#: A written document's top-level key for its TEXT, in full, when its `lines` do not carry all of it
#: (`_with_source_lines`). Not rendered: the TV's parser (`parseLyricsDoc`) reads `lines` alone.
_SOURCE_LINES = "sourceLines"


def _with_source_lines(doc: dict[str, object], segments: Sequence[Segment]) -> dict[str, object]:
    """`doc`, plus the text it was timed from (`_SOURCE_LINES`) when its lines lost some of it.

    WHY (review W1 r1). A re-pick re-times the stored document's WORDS (`_stored_lines`), and the global
    engine's document holds only the lines it timed: `Generated.as_doc` leaves out every line the
    never-sung rule dropped and every line with no alignable character. So re-picking such a candidate
    re-timed a shorter text, and the lost lines were gone from it for good — never-be-alone's closing
    "No you never be alone" / "be alone", which its stem lost, among them. The old worker's windowed
    documents kept every segment, which is why its "re-time the stored words" was lossless. Written only
    when something is missing, so every document that kept its whole text is byte-for-byte as before.
    """
    source = _source_texts(segments)
    lines = doc.get("lines")
    shown = [
        text
        for text in (
            str(line.get("text") or "").strip()
            for line in (lines if isinstance(lines, list) else [])
            if isinstance(line, dict)
        )
        if text
    ]
    return doc if shown == source else {**doc, _SOURCE_LINES: source}


def _source_texts(segments: Sequence[Segment]) -> list[str]:
    """A text's words, line by line, as a written document records them (`_SOURCE_LINES`): every segment's
    text, stripped, the empty ones left out. What `_stored_lines` reads back, so the two compare."""
    return [text for text in (str(segment.get("text") or "").strip() for segment in segments) if text]


@dataclass(frozen=True, slots=True)
class Superseded:
    """An EARLIER job's stored candidate for words this job's ladder refused (`superseded_candidates`)."""

    ref: str
    label: str
    timing: str
    language: str | None


def superseded_candidates(
    job: JobRef, refused: Sequence[TextRef], *, placed: Collection[str]
) -> list[Superseded]:
    """Every document in the lyrics store that an earlier job wrote for the WORDS of a text this job refused.

    WHY (review W1 r2, completing M3). Core merges every job's report into one candidate set by ref and
    ranks the whole set, and `selectable` was set only on the documents a job WROTE. A refused attempt
    writes nothing, so the refused text never appeared in the report, and a candidate an earlier job had
    stored for it kept its rank: a word document v2 published on the mix (authoritative + word, rank 5)
    went on showing after a re-align on the new stem refused the very same words — core showed what the
    worker had just judged wrong, over the transcript or line sync it published instead. So the report
    names these too, `selectable: false` (`__main__._lyrics_artifacts`); core's merge replaces its entry
    by ref, so the document is never auto-selected again (a person may still pick it).

    MATCHED ON THE WORDS, not the label alone: a document written under this text's label (`_pinned_label`
    reads it off the ref, any knob suffix and either timing) whose words (`_stored_lines`: its
    `sourceLines`, else its lines) are exactly this text's. A provider that now serves DIFFERENT words under
    the same label refused nothing about the document an earlier job stored, so that one stands. The refs
    this job placed are already in its report, and a store that cannot be listed withdraws nothing.
    """
    if not refused:
        return []
    wanted = {text.label: _source_texts(text.segments) for text in refused}
    try:
        names = sorted(os.listdir(os.path.join(job.media_dir, _LYRICS_STORE)))
    except OSError:
        return []
    found: list[Superseded] = []
    for name in names:
        ref = f"{_LYRICS_STORE}/{name}"
        if not name.startswith(f"{job.media_id}-") or not name.endswith(".json") or ref in placed:
            continue
        label = _pinned_label(ref, job.media_id)
        words = wanted.get(label)
        if words is None:
            continue
        stored, language, _why = _stored_lines(os.path.join(job.media_dir, ref))
        if stored == words:
            timing = TIMING_WORD if name.removesuffix(".json").endswith(f"-{TIMING_WORD}") else TIMING_LINE
            found.append(Superseded(ref=ref, label=label, timing=timing, language=language))
    return found


#: Where every lyrics document is stored, relative to the media volume (`steps.api.store_ref`).
_LYRICS_STORE = "derived/lyrics"


def _stored_lines(path: str) -> tuple[list[str], str | None, str]:
    """The line texts of a stored lyrics document, its language, and why it yielded none (for the trail).

    Reads the shape `_write` writes and keeps only the WORDS: a re-time exists because the stored timings
    are not wanted, so they are not read at all. The text the document was timed from (`_SOURCE_LINES`)
    when it carries one — its lines lost some of it — else `lines[].text`.
    """
    try:
        with open(path, encoding="utf-8") as handle:
            loaded = json.load(handle)
    except FileNotFoundError:
        return [], None, "the document is not on disk (evicted, or never written)"
    except (OSError, ValueError) as unreadable:
        return [], None, f"the document is unreadable ({type(unreadable).__name__})"
    if not isinstance(loaded, dict):
        return [], None, "the document is not a lyrics document"
    source = loaded.get(_SOURCE_LINES)
    lines = loaded.get("lines")
    texts = (
        [text.strip() for text in source if isinstance(text, str) and text.strip()]
        if isinstance(source, list)
        else [
            line["text"].strip()
            for line in (lines if isinstance(lines, list) else [])
            if isinstance(line, dict) and isinstance(line.get("text"), str) and line["text"].strip()
        ]
    )
    language = loaded.get("language")
    known = language if isinstance(language, str) and language else None
    return texts, known, "it carries no line with words"


def _pinned_label(ref: str, media_id: str) -> str:
    """The label a stored candidate was written under, read back off its ref — `_write`'s shape inverted.

    A stored document carries its words and its timings, NOT its provenance, and `textSource` (core's
    ranking and display axis) is derived from the label, so a re-time that forgot it would republish an
    authored-caption candidate as `manual`. `{media}-{label with ':' as '-'}{-knob…}-{timing}.json`: the
    timing and any knob suffixes come off the end, and the FIRST dash is the label's colon (a provider's
    upstream may itself contain dashes; the source never does). A ref of any other shape — a candidate
    named before this scheme — is `manual`, as the old worker read it.
    """
    name = ref.rsplit("/", 1)[-1].removesuffix(".json")
    if not name.startswith(f"{media_id}-"):
        return _MANUAL_LABEL
    rest = name.removeprefix(f"{media_id}-")
    timing = next((t for t in (TIMING_WORD, TIMING_LINE) if rest.endswith(f"-{t}")), None)
    if timing is None:
        return _MANUAL_LABEL
    timed = rest.removesuffix(f"-{timing}")
    for knob in reversed(list(Knob)):  # appended in `Knob` order, so peeled in reverse
        timed = timed.removesuffix(f"-{knob.value}")
    source, colon, variant = timed.partition("-")
    if not source:
        return _MANUAL_LABEL
    return f"{source}:{variant}" if colon and variant else source


def _place(media_dir: str, source_ref: str, target_ref: str) -> None:
    """Copy `source_ref` over `target_ref` atomically: a sibling temp file, then `os.replace`.

    A COPY, so the scratch original survives: were the process to die after the replace but before the
    step's checkpoint, a resumed `publish` re-runs and must still find its source. The replace is what
    makes the swap atomic for a reader of the target (the TV fetching the pinned ref mid-publish). A
    source that already IS its target (a record checkpointed before attempts were staged) stays put.
    """
    if source_ref == target_ref:
        return
    source = os.path.join(media_dir, source_ref)
    target = os.path.join(media_dir, target_ref)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    staging = f"{target}.{os.getpid()}.part"
    with open(source, "rb") as src, open(staging, "wb") as dst:
        dst.write(src.read())
    os.replace(staging, target)


def _word_doc(aligned: Sequence[Segment], language: str) -> dict[str, object]:
    """The aligner's output in the core's document shape."""
    return {"language": language, "lines": [dict(line) for line in aligned]}


def _envelope_passes(fit: ShiftFit) -> bool:
    """The envelope gate's three tiers (the reasoning is at the global engine's gate): r >= 0.40 within
    ±0.5 s, r >= 0.25 within ±0.1 s, or r >= 0.60 at any lag — shape agrees, the lag is an offset."""
    return (
        (fit.usable and abs(fit.seconds) <= 0.5)
        or (fit.correlation >= 0.25 and abs(fit.seconds) <= 0.1)
        or (fit.correlation >= 0.60)
    )


def _sheet_passes(fit: ShiftFit) -> bool:
    """The envelope gate for a SHEET's own claimed spans: tiers 1 and 3 of `_envelope_passes`.

    NOT tier 2 (r >= 0.25 within ±0.1 s). Zero lag is evidence only for timings MEASURED ON this audio —
    a decode must sit there — and a sheet was not: any sheet whose envelope is broad best-fits near zero
    lag, so tier 2 is where the sheet-span null leaked (see `_time_line_sync` for the numbers).
    """
    return (fit.usable and abs(fit.seconds) <= 0.5) or fit.correlation >= 0.60


def _timed_spans(segments: Sequence[Segment]) -> list[tuple[float, float]]:
    """The (start, end) of every segment with a positive-length claimed span — what an envelope fits."""
    return [(start, end) for start, end in measure.line_spans(list(segments)) if end > start]


#: The LINE_SYNC rung's timing gate (W3, RE-DERIVED ON MAPPED CLAIMS in W2): a text's line document publishes
#: its own claimed starts — put on our clock once by `_line_sync_clock` — so at least
#: `lexical.Bands.line_sync_min_agreement` of the lines the text's blind decode places must start within
#: `_LINE_SYNC_NEAR_SEC` of their MAPPED claim (`reconcile.as_claimed`, nothing removed).
#:
#: THE SHARE MOVED INTO THE PER-MODEL TABLE IN W4b (`lexical.CALIBRATED`), and the value is unchanged: it is
#: read off THIS MODEL's decode spread, which is the same reason the lift's bands are per model, so a wave
#: that changes the emission model moves both in one row or neither. A MODEL WITH NO ROW IS STILL GATED on it
#: (`lexical.LINE_SYNC_SHARE_UNCALIBRATED`, the value all three rows fit) — W4b review r1's correction, and
#: the one asymmetry with the lift: dropping the share for an uncalibrated bundle left W7's per-language ones
#: on the sheet-span envelope gate alone, which is the gate this one replaced. The band below stays here
#: because it is a
#: TOLERANCE IN SECONDS (`reconcile`'s COARSE) rather than an emission scale: no model makes 1.0 s mean
#: something else. Everything this block measures is the share, and `line_gate.py --model <bundle>` re-derives
#: it; the numbers stay here, where its readers are.
#:
#: BOTH VALUES SURVIVE THE RE-DERIVATION, and the share's reason gets stronger (`scripts/line_gate.py`, base
#: model, 1056 cases, `results/w2-line-gate.json`; the tables are at `_time_line_sync`). The two populations,
#: which under W3's placement OVERLAPPED — documents with < 50% of their lines within 1 s of truth read up to
#: 0.49 while the good ones' p10 was 0.47 — now SEPARATE, because a mapped claim is one the decode can agree
#: with: right documents more than 20% gross read 0.24 and 0.32 (n=2), the other 414 read p10 0.54, median
#: 0.86, p90 0.98. 0.5 lies inside that gap instead of straddling it. Over the 13 timed modes' 416 right
#: texts: 0.5 refuses 33 with 0 gross lines shown, 0 bad documents published and 94.8% of shown lines within
#: ±500 ms; 0.4 refuses 11 but shows 6 gross lines and 1 bad document, and publishes 10 of never-be-alone's
#: 12 refusals, 7 of them with NO line within ±500 ms; 0.3 refuses 5 and shows 44 gross; 0.6 refuses 56 and
#: 0.7 refuses 78 for no gross-line gain at all (0 either way). So the share stays where the gross lines
#: start.
#:
#: RE-READ ON THE EXACT CLOCK, AND BOTH VALUES STAND (W4 review r2, `results/w4-line-gate.json` — the same
#: 1056 cases, same band, same base model, re-run because 6a moved every emission matrix and both literals
#: were fitted on the old one; `test_bench_e2e` pins the numbers below against that file). The gate's OWN
#: verdict is unchanged in shape: 0.5 refuses 32 of the 416 right texts (W2: 33) with 0 gross lines shown
#: and 90.3% of the text's lines within ±500 ms, 0.4 refuses 15 but still shows 6 gross, 0.3 refuses 4 and
#: shows 13, 0.6 refuses 47 and 0.7 refuses 90 for no gross-line gain. So the share still sits exactly where
#: the gross lines start.
#: WHAT CHANGED IS THE POPULATION W2 ARGUED FROM, not the threshold: the two documents more than 20% gross
#: (`hello` tempo098/tempo102 at shares 0.24 and 0.32) NO LONGER EXIST — the exact clock and the claim
#: clock's mode candidates fixed them, and 0 of 416 right texts are now more than 20% gross. The separation
#: is therefore re-read against the quality population the rows carry: the 2 documents with under half their
#: lines within 1 s of truth (`never-be-alone` tempo098/tempo102) both read 0.34, the 410 with 80%+ read p10
#: 0.583 / median 0.865 / p90 0.987, and 0.5 sits between with 0.16 of headroom over the worse population.
#: THE TIMING HALF DOES NOT CLEAR EVERY WRONG TEXT ON ITS OWN, at either reading, and that is the standing
#: caveat rather than a new one: 1 of the 640 wrong-text cases reads above 0.5 (W4 `Kinematic_-_Peyote` under
#: `wrongtext+ownclock` at 0.5714, W2 `feel-my-heart` at 0.5135), and what refuses it is the LEXICAL LIFT
#: (-0.125 there), which refuses all 640 in both readings. This gate is the timing witness; the lift is the
#: wrong-text one, and neither is sufficient alone.
#:
#: `_LINE_SYNC_NEAR_SEC` IS NOW TWO BANDS IN ONE (W2): the gate counts a line near within it AND
#: `_line_sync_clock` scores its candidate maps in it, so it cannot be re-derived for one reader alone —
#: `line_gate.py --near` moves both. 1.0 s is `reconcile`'s COARSE tolerance ("same performance, loosely
#: timed") and 0.5 its STRUCTURAL floor. Measured at 0.5 s on the same cases (`_runs/w2-lines/near05.*`):
#: tightening it tightens BOTH readers, so every share falls (right documents ok p10 0.54 -> 0.47, the >20%
#: gross ones max 0.32 -> 0.26) and the shipped rule refuses 49 of 416 instead of 33 — 16 more right texts, 2
#: truth sheets instead of 1, text-denominator ±500 89.5% -> 86.5% — for 0 gross lines shown either way and
#: one fewer zero-±500 document (13 -> 12). All it buys is a wider margin on the half of the gate that is not
#: the verdict (same-video wrong texts max 0.51 -> 0.32, and the lift refuses all 640 at both bands), so 1.0 s
#: stays. THE BAND SWEEP IS THE ONE READING W4 DID NOT REDO (review r2): `near` is computed during the run,
#: so `results/w4-line-gate.json` holds the 1.0 s band only and the 0.5 s column above is still W2's clock.
#: What the W4 rows do say is that the shipped band's own populations moved in the direction that makes a
#: tightening WORSE, not better (the good population's p10 rose 0.538 -> 0.583). Model-specific in the same
#: way as the lift: the decode's own spread is what the share reads, so recalibrate both with the model.
_LINE_SYNC_NEAR_SEC = 1.0

#: WHAT THIS GATE STILL CANNOT SEE, recorded where it is set (W3 review r2, re-measured in W2 with the claim
#: clock in place), because it is measured and not fixed here:
#:
#:   A UNIFORM LAG BOTH WITNESSES SHARE. The share is read against the text's OWN blind decode, so a document
#:   every line of which is 0.5-1.0 s late agrees with itself and passes. W3 measured 23 such documents (no
#:   line within ±500 ms of truth, every line within 1 s) and named the cause upstream of the gate:
#:   `_placed_by` shifted the sheet by the activity fit whatever the claims said. W2's vote fixes 10 of them
#:   (23 -> 13 over the 13 timed modes, and the TRUTH sheets 2 -> 1: numb recovered),
#:   and the 13 that remain are ONE PAIR OF SONGS — bad-guy in 10 modes and numb in 3 — where the vote does
#:   not merely fail to help, it APPLIES the lag: on bad-guy's truth sheet the envelope's +0.72 s explains 64
#:   of 69 paired lines against no-shift's 53, and the decode agrees (0.93 near). Both of this rung's
#:   witnesses say the vocals are ~0.7 s later than the caption track claims, and the caption track is also
#:   this song's TRUTH file — so the metric's ruler is the thing being corrected (`claimmap`'s MEASURED note
#:   says the same of believer and bad-guy on the global path). A lag term on `AsClaimed.offset_sec` still
#:   does not recover them and is still not taken: on the W2 rows `decode(0.5)+lag(0.5)` refuses 46 right
#:   texts where the shipped rule refuses 33 of 416, dropping text ±500 from 89.5% to 87.1% and refusing 13
#:   more accurate documents for 0 gross lines gained (the tempo gross lines it used to buy are the vote's
#:   now). Under `syncMode=lines` a refusal is terminal, so that trade is "no lyrics at all" against "a scroll
#:   under a second late". What WOULD read it is a witness independent of both — a lead-vocal onset detector,
#:   or the mix's envelope where the stem's is broad — and that is unbuilt.
#:
#: THE TEMPO ERROR IS NO LONGER ON THIS LIST (W2): the bounded Theil-Sen candidate maps the 2% modes, so
#: tempo098 goes from 5 of 32 texts admitted with 28 gross lines to 29 with 0, and tempo102 from 6 with 19 to
#: 29 with 0 (`gates/w3-lines.yaml` caps both).
#:
#: AND WHAT IT COSTS, measured: the decode is the witness, so where the DECODE is poor a correct sheet is
#: refused. 20 of the 33 right texts it refuses would have published an ACCURATE document (>= 80% of lines
#: within ±500 ms): 17 of them drop50 half-sheets, whose kept half is exactly right while their decode strays
#: into the removed lines' gaps (agreement 0.04-0.48), plus never-be-alone under `jit` (42 of 47 lines within
#: ±500 ms) and `extraverse` (47/47) and hello `extraverse` (74/74). The clock made none of them worse: the
#: W2 refusal set is a strict SUBSET of W3's 88 (0 newly refused, 55 recovered, 53 of the 55 accurate).
#: Reading the decode's own reliability before trusting it (per-line scores, self-consistency) is unbuilt and
#: would need its own calibration; `line_gate.py` is the harness for it.
#:
#: The share's DENOMINATOR is only the lines that decoded, so it has to cover most of the sheet before it may
#: speak for it — for its VERDICT (`_agreement_of`) and, since W2, for its CLOCK (`_line_sync_clock`): one
#: bar, `_enough_decoded`.
_LINE_SYNC_MIN_DECODED_SHARE = 0.5


@dataclass(frozen=True, slots=True)
class _LineEvidence:
    """What the stem's emission matrix says about a line-sync text (`AlignStepsImpl._line_sync_evidence`)."""

    #: The text's lexical lift, or None — and why (`unlifted`).
    lift: lexical.Lift | None
    unlifted: str
    #: The calibration row the matrix's model has, or None when it has none (W4b). The rung's two thresholds
    #: come off it, and NONE MEANS DIFFERENT THINGS TO THE TWO (corrected in review r1, and this comment with
    #: it in r2): nothing in nats per letter may be read off an unjudgeable matrix, so the lexical floor and
    #: the doubt band stand down (`lexical.band` is not called at all) — while the decode-agreement share is a
    #: fraction of lines within a tolerance in SECONDS, means the same sentence on any bundle, and is STILL
    #: gated, at `lexical.LINE_SYNC_SHARE_UNCALIBRATED` (read through `lexical.line_sync_share`, as the block
    #: at the `share =` line says). So an uncalibrated bundle is not "the sheet-span envelope decides": a
    #: refusal reading "below 50%" is reachable with no row at all, which is the whole point of the constant.
    bands: lexical.Bands | None
    #: The matrix the lift was read on, for the DECODE check the caller runs only once the lexical verdict
    #: passed (`_decoded_agreement`; W3 review r2: a text about to be refused must not pay for a decode).
    #: None when there was no matrix to read — then `unlifted` says why nothing decoded either.
    emissions: Any


async def _line_sync_decode(
    texts: Sequence[str], emissions: Any, language: str
) -> tuple[Generated | None, str]:
    """`texts`' BLIND decode on `emissions` (`generate`, the shipped decoder, off the event loop), or None and
    why it could not be read. A machinery fault in the kernel raises (`InfraFault`, review M7); anything else
    the decode raises is an unanswered question, and its reason starts `it raised`, which the bench scores as
    an ERROR row (`e2e.FAULT_DECODE`).

    The rung's SECOND witness, and since W2 it answers two questions off one decode: which clock the claims
    are on (`_line_sync_clock`) and whether the mapped claims sit where the lines are sung (`_agreement_of`).
    """
    from encore_worker.adapters.ml import forced_align_decoder  # noqa: PLC0415
    from encore_worker.domain.lyrics.generate import generate  # noqa: PLC0415

    try:
        return (
            await asyncio.to_thread(
                partial(generate, decoder=forced_align_decoder, language=language), texts, emissions
            ),
            "",
        )
    except InfraFault:
        raise  # the machinery, not this text: fails the job (review M7)
    except Exception as exc:  # noqa: BLE001 - an unanswered question, not a verdict on the text
        return None, f"it raised {type(exc).__name__}: {exc}"


def _agreement_of(decoded: Generated, placed: Sequence[Segment]) -> tuple[AsClaimed | None, str]:
    """`reconcile.as_claimed` of `placed`'s starts against `decoded`, or None and why it could not be read.

    `placed` is the sheet AS IT WILL PUBLISH — mapped onto our clock by `_line_sync_clock` and in claim order
    (W2) — so the gate reads the timings the room would see, not the sheet's raw ones.
    """
    from encore_worker.domain.lyrics import reconcile as rc  # noqa: PLC0415

    claims = _claimed_starts(placed)
    got = rc.as_claimed(decoded.lines, claims, tolerance_sec=_LINE_SYNC_NEAR_SEC)
    if got is None:
        return None, f"fewer than {rc.MIN_PAIRS} lines both decoded and claimed"
    # THE SHARE IS ONLY OF THE LINES THAT DECODED, so the denominator has to be most of the sheet before it
    # may speak for it (W3 review r2). `generate` drops any line with no alignable character, and a whole
    # SHEET publishes on this verdict: a mixed-script caption track — this module's own motivating threat,
    # an uploader's translation of a K-pop song, Korean verses with an English chorus — decodes only its
    # Latin lines, so 4 of 40 lines could decide, 2 of them near, and the other 36 publish on their own
    # claimed timings unexamined (`lexical.letters_of` measured the lift on that fragment too). Below the
    # share the sheet gate decides instead, which reads the WHOLE sheet's spans against the envelope.
    # Inert on every case the bench has measured: all 465 decode readings in the committed W3 runs paired
    # every claimed line (`results/w3-{lines-,}run_align.cases.jsonl`, `pairs` = claimed lines in each).
    if got.pairs < (bar := _enough_decoded(len(claims))):
        # WHICH OF `_enough_decoded`'s TWO BOUNDS BIT, because they refuse different sheets and a bare
        # "under 50%" on a decode that read 100% of its sheet reads as a broken counter (W2 review r2):
        # every sheet of 10 claims or fewer is held by the FLOOR, longer ones by the share.
        rule = (
            f"{_LINE_SYNC_MIN_DECODED_SHARE:.0%} of it"
            if bar > claimmap.MIN_PAIRS
            else "the floor a placement may be read on"
        )
        return None, (
            f"only {got.pairs} of {len(claims)} claimed lines decoded, under the {bar} this check needs "
            f"to speak for the sheet ({rule})"
        )
    return got, ""


def _enough_decoded(claims: int) -> int:
    """How many of a sheet's `claims` lines must DECODE before the decode may speak for the sheet: at least
    `claimmap.MIN_PAIRS` lines, and at least `_LINE_SYNC_MIN_DECODED_SHARE` of it.

    ONE rule for both readers of that decode (W2) — the gate's verdict (`_agreement_of`) and the clock the
    claims are mapped onto (`_line_sync_clock`) — because the mixed-script caption track this bar exists for
    (Korean verses, an English chorus: 4 of 40 lines decode) must not have its Latin fragment decide the
    TIMING of 36 lines it never read, which is as true of a map as of a verdict.

    THE FLOOR IS `claimmap`'s 5, NOT `reconcile`'s 3 (W2 review r2, and this is what made the paragraph above
    true). It used to be `rc.MIN_PAIRS`, while `_line_sync_clock` took `max(claimmap.MIN_PAIRS, this)` — so
    the two readers the docstring calls one rule had DIFFERENT bars, and the gap was not idle: on a 7-line
    caption sheet with 4 lines decoding the clock abstained (4 < 5) while the gate was fully armed (4 >= 4),
    `_placed_by` fell back to `ShiftFit.usable`'s unconditional shift, and `_agreement_of` then read the
    decode against those SHIFTED claims, found them near and published the sheet displaced with both witnesses
    agreeing on one misplacement — the exact W3 failure the clock was built to stop, on the sheets too thin to
    vote. Five is the right floor for both because it is the floor for a reader that ACTS: 3 is
    `reconcile.MIN_PAIRS`, enough to grade a line, and `claimmap.MIN_PAIRS` is 5 because a map MOVES the
    sheet — and this rung's verdict does not grade a line either, it publishes or refuses a whole document.

    Inert on everything measured: the two bars differ only for sheets of 9 or fewer claimed lines (above that
    the share term already exceeds 5), and the shortest paired series at this rung in the 1056 committed gate
    cases is 13 lines.
    """
    return max(claimmap.MIN_PAIRS, math.ceil(_LINE_SYNC_MIN_DECODED_SHARE * claims))


def _claimed_starts(segments: Sequence[Segment]) -> dict[int, float]:
    """Every segment's claimed start, keyed by its POSITION in the text — which is the key `generate` gives a
    line (`Line.index`) and `reconcile` pairs on, so the decode, the vote and the gate all pair the same way
    and one dropped decorative line cannot shear the comparison after it."""
    return {
        index: float(start)
        for index, segment in enumerate(segments)
        if isinstance(start := segment.get("start"), (int, float)) and not isinstance(start, bool)
    }


def _line_sync_clock(
    fit: ShiftFit | None, claimed: Mapping[int, float], decoded: Generated | None
) -> claimmap.ClaimMap | None:
    """THE LINE_SYNC RUNG'S CLAIM CLOCK (W2, review H1 / §3.2): which clock this sheet is on, by the same vote
    the global engine takes — or None when there is no decode to vote with.

    WHY THE RUNG NEEDS ITS OWN CALL. The global engine's map (`_time_text_global`) moves the claims that steer
    its repairs; this rung PUBLISHES the claims, so until W2 it placed them with `_placed_by`'s
    UNCONDITIONAL activity shift: `ShiftFit.usable` (r >= 0.40) moved the sheet whatever a vote would say,
    and nothing else was ever considered. That is both halves of what W3 measured on it — 23 published
    song-modes with no line within ±500 ms of truth and every line within 1 s (bad-guy shifted +0.72 s, numb
    +0.62 s, their TRUTH sheets included), and 12 right texts refused whose claims were merely 1.5-3 s off or
    2% fast, where the decode itself knew the answer (median lag -1.62 to -3.12 s, and 0.54-0.94 of the lines
    within 1 s once it is removed: `results/w3-line-gate.json`'s `near_fit`).

    THE CANDIDATES are the rung's own three witnesses, `claimmap.consensus`'s, with the rung's own decode in
    place of the global engine's: no-shift, the ENVELOPE lag the gate already measured (offered from
    `claimmap.MIN_ENVELOPE_CORRELATION`, weaker than `ShiftFit.usable` on purpose — a correlation buys a
    place in the vote, the vote decides), the DECODE median, and the bounded Theil-Sen TEMPO that the 2%
    modes need. Nothing new is computed: both witnesses are already in hand.

    THE TOLERANCE IS THIS RUNG'S, NOT `reconcile`'s (the one deliberate difference from the global engine's
    call). `consensus` scores a candidate by the paired lines it explains, and "explains" must mean what the
    reader of the map means by it: the global engine's reader is `reconcile`, so there the band is
    `AGREE_TOLERANCE_SEC`; here the reader is this rung's gate, so it is `_LINE_SYNC_NEAR_SEC`. It is also
    the conservative choice, which matters because these claims publish: a wide band makes no-shift hard to
    beat, so the vote only moves a sheet that is grossly misplaced — a sheet already near our clock keeps its
    own timings, which is how the truth sheets stop being shifted at all.

    NOT PIECEWISE. The `claimmap-piecewise` arm was measured on the global engine only and ships off there;
    on the rung a leg boundary moves published timings, so it would owe its own `--sync-mode lines` corpus
    run before it could even be an arm.

    None, not `IDENTITY`, where there was no vote to take: no decode to vote with, or a decode that may not
    speak for this sheet — `_enough_decoded`, which since review r2 is LITERALLY the one call both readers
    make (its floor is now `claimmap.MIN_PAIRS`, so the sheet-too-short test is the same test), because a
    Latin fragment of a mixed-script caption track must not decide the clock of 40 lines it never read any
    more than it may decide their verdict, and because the two bars disagreeing let a 3-4-pair sheet publish
    on the unconditional shift with the gate calling it near. `_placed_by`
    then falls back to the unconditional activity shift and the gate to the sheet-span envelope, exactly as W3
    shipped them — "we could not vote" must not read as "the vote said no". Inert on everything measured: all
    1056 bench cases decode EVERY claimed line (`results/w2-line-gate.json`, `pairs` == `claims` in each), and
    the shortest paired series at this rung is 13 lines.
    """
    if decoded is None:
        return None
    pairs = sum(1 for line in decoded.lines if line.index in claimed)
    if pairs < _enough_decoded(len(claimed)):
        return None
    return claimmap.consensus(
        {line.index: line.start for line in decoded.lines},
        claimed,
        envelope_lag=(
            fit.seconds if fit is not None and fit.correlation >= claimmap.MIN_ENVELOPE_CORRELATION else None
        ),
        tolerance_sec=_LINE_SYNC_NEAR_SEC,
    )


def _mapped(segments: Sequence[Segment], clock: claimmap.ClaimMap) -> tuple[Segment, ...]:
    """`segments` with every claimed timestamp on our clock (`ClaimMap.at`, the map's own reader, so a claim
    that PUBLISHES and a repair window built from the same map move identically).

    Copies, never in place, for `place.apply_shift`'s reason: a `TextRef` is checkpointed and a replayed
    attempt must not read timings that were already mapped once. The end is held at or after the start, the
    rule `ClaimMap.windows` applies to a window, and for the same reason: a backwards span is not
    representable.

    AND THE MAP IS NOT WHAT THE HOLD DEFENDS AGAINST (W2 review r2 — the `max` survived deletion).
    `ClaimMap.at` is non-decreasing by construction (a positive per-leg scale, `_monotonic` on any split,
    and the zero clamp only creates ties), so no map can invert a span it was given in order: the hold can
    only fire on a cue that arrived REVERSED. That is a caption track, not an LRC — `parse_vtt` reads both
    edges off one timestamp line and neither it nor `clean_segments` checks their order, while `parse_lrc`
    derives each end from the next sorted stamp. Such a cue would otherwise publish a span running
    backwards, which `measure.timed_words` and `core`'s `lineBounds` both read as unusable.
    """
    if not clock.applied:
        return tuple(segments)
    moved: list[Segment] = []
    for segment in segments:
        copy = dict(segment)
        start = segment.get("start")
        at: float | None = None
        if isinstance(start, (int, float)) and not isinstance(start, bool):
            at = clock.at(float(start))
            copy["start"] = at
        end = segment.get("end")
        if isinstance(end, (int, float)) and not isinstance(end, bool):
            mapped_end = clock.at(float(end))
            copy["end"] = mapped_end if at is None else max(mapped_end, at)
        moved.append(copy)
    return tuple(moved)


#: The most claimed starts `_in_claim_order` will hold before it leaves the sheet alone, as a share of the
#: sheet's timed lines and never fewer than one. A SINGLE stray stamp is the shape the rule was built for;
#: many of them is a sheet whose order nobody can reconstruct, and normalising that quietly would hide the one
#: defect `policy.decide` drops a text for. Inert on everything measured, provably: over the 1056 committed
#: gate cases (`results/w2-line-gate.json`) the largest `held` is ONE — Tom_Orlando and never-be-alone under
#: `jit` — and a sheet the pre-fix rule held exactly once is one whose next claim recovered above the last
#: kept start, or the second line would have been held too and `held` would read 2. Both are strays under it.
_MAX_HELD_SHARE = 0.05


def _in_claim_order(segments: Sequence[Segment]) -> tuple[tuple[Segment, ...], int, int]:
    """`segments` with a stray backwards claimed start held at the one before it: the segments, how many were
    held, and how many inversions were left alone because holding them would have made things worse.

    A LINE DOCUMENT IS ITS CLAIMS, so a sheet that stamps one line before the line ahead of it publishes a
    highlight that jumps backwards — the one timing defect that cannot be shown to a room (`measure`'s note
    on ORDER), and the defect `policy.decide` answers by dropping the whole text. Measured: Tom_Orlando under
    `jit` (sheet noise σ 0.3 s) came back from this rung with 1 of 72 lines backwards, so `decide` sent the
    text away and the song ended in NO LYRICS — with a lift of +2.92, 85% of its lines decoding within 1 s of
    their claims and 63 of 72 within ±500 ms of truth.

    WHICH REAL SHEETS REACH THIS RULE (W2 review r2 corrected the citation). It used to read "real sheets do
    it too (`parse_lrc`'s stacked and out-of-order stamps, review L4)", and an LRCLIB sheet cannot in fact
    present an inversion here: `parse_lrc` SORTS its stamps before building segments (adapters/lrclib.py, with
    its own "an LRC is a text file a human edited" comment), and stacked stamps are EQUAL, which this rule
    reads as in order. Everything between the sheet and here preserves order — `ClaimMap.at` is monotonic by
    construction. So the claim source that can deliver one is a CAPTION TRACK: `parse_vtt` reads cues in file
    order and `clean_segments` neither sorts nor touches starts, which is review M12's rolling captions (a
    caption re-stated mid-line, the later cue carrying the earlier words), plus the bench's `jit` mode. That
    matters to the trade this rule makes — publish a held sheet rather than let `decide` drop the text —
    because it names the population that pays for it: the YouTube caption tier, not LRCLIB.

    HELD, NOT SORTED: a claim is evidence about ITS line, so the line keeps its text and its position and
    loses only the part of its timing that cannot be true. The cap is the previous start, so the move is at
    most the size of the inversion (Tom_Orlando's: one line, 0.19 s).

    ONE STRAY STAMP ONLY, AND ONLY WHERE THE SHEET RECOVERS (W2 review r1). The first version held every
    backwards start at the last kept one and never advanced it, so a single spuriously LATE stamp swallowed
    every correctly-timed line after it: a 12-line sheet whose second line reads `[01:00.00]` for
    `[00:10.00]` — a typo, review L4's stacked stamps, M12's rolling captions — came out with NINE lines
    sharing the instant 60.0, `out_of_order` 0 and `usable` True, so the room saw one line's text for 30 s
    while the rest were sung. Before W2 that sheet was DROPPED. So an inversion is held only when the next
    claimed start recovers above the previous one (the stray is the single line, not everything after it),
    and only while the held lines stay under `_MAX_HELD_SHARE`; otherwise nothing is held, the sheet keeps its
    inversions, and `measure.out_of_order` reaches `decide` exactly as it did in W3. The refusal is counted so
    the trail can say the sheet was left alone rather than found clean.

    THE END IS HELD TOO, PAST the predecessor's (W2 review r1, corrected in r2): a held line used to take its
    predecessor's START and keep its own END, which could end BEFORE the predecessor did — a line nested
    inside the one before it, which `core`'s `activeLineIndex` (first line whose bounds contain the playhead)
    can never light during its own span. Holding the end AT the predecessor's, which is what r1 shipped, does
    not fix that: `activeLineIndex` returns the FIRST line containing the playhead, so a byte-identical span
    loses every instant of itself to the predecessor too and the held line first lights at the predecessor's
    end — the same defect at the same line, one `max` short of a fix. Traced on this rule's own r1 fixture
    (a = 12.0-14.5, b = 11.8-13.8): `_in_claim_order` returned b as 12.0-14.5 and, sweeping the playhead
    through a transcription of `activeLineIndex`, b first lit at 14.5 s. So the end is stretched to
    `_REPAIRED_MIN_SEC` PAST the floor, bounded by the next kept start so that lighting the held line cannot
    delay the line after it. Where the next start leaves no room the span stays identical and the line is
    still never lit: that is a published sheet with one dark line against `decide` dropping the whole text,
    which is the trade this whole rule exists to make.

    IDEMPOTENT either way: a held start equals its predecessor's, so a second pass finds no inversion, and an
    abstention returns the segments it was given.
    """
    starts: dict[int, float] = {}
    for position, segment in enumerate(segments):
        start = segment.get("start")
        if isinstance(start, (int, float)) and not isinstance(start, bool):
            starts[position] = float(start)

    order = list(starts)
    #: The claimed start of the line after each claimed line, by position: the ceiling a held line's stretch
    #: may not cross. A stray's successor is always a KEPT line (a stray at `i` needs `starts[i + 1]` back
    #: above the last kept start, which makes `i + 1` non-inverting), so this is the next line's own stamp.
    next_claimed = {position: starts[later] for position, later in zip(order, order[1:], strict=False)}
    inversions: list[int] = []
    strays: set[int] = set()
    previous: float | None = None
    for rank, position in enumerate(order):
        if previous is None or starts[position] >= previous:
            previous = starts[position]
            continue
        inversions.append(position)
        # The next claimed start decides WHICH stamp is the outlier: if the sheet comes back above the last
        # kept start, this one line is; if it stays below, the EARLIER stamp was, and nothing here can tell
        # where the lines after it belong. A trailing inversion has nothing left to drag.
        recovers = starts[order[rank + 1]] if rank + 1 < len(order) else previous
        if recovers >= previous:
            strays.add(position)
    if len(strays) != len(inversions) or len(inversions) > max(1, int(_MAX_HELD_SHARE * len(order))):
        return tuple(segments), 0, len(inversions)

    out: list[Segment] = []
    held = 0
    previous = None
    previous_end: float | None = None
    for position, segment in enumerate(segments):
        if position not in starts:
            out.append(segment)
            continue
        end = segment.get("end")
        numeric_end = float(end) if isinstance(end, (int, float)) and not isinstance(end, bool) else None
        if position in strays and previous is not None:
            copy = dict(segment)
            copy["start"] = previous
            floor = previous if previous_end is None else max(previous, previous_end)
            if numeric_end is not None and numeric_end <= floor:
                #: A STRETCH, not the floor itself (W2 review r2): equalling it publishes a span
                #: byte-identical to the predecessor's, which `activeLineIndex` never returns. Bounded by
                #: the next kept start, so lighting this line cannot delay the next one; where that leaves
                #: no room the span stays identical, because an un-lit line is still a published sheet and
                #: the alternative is `decide` dropping the whole text.
                room = next_claimed.get(position)
                stretched = floor + _REPAIRED_MIN_SEC
                numeric_end = stretched if room is None else min(stretched, max(floor, room))
                copy["end"] = numeric_end
            out.append(copy)
            held += 1
        else:
            previous = starts[position]
            out.append(segment)
        previous_end = numeric_end if numeric_end is not None else previous
    return tuple(out), held, 0


async def _measured_lift(
    texts: Sequence[str], emissions: Any
) -> tuple[lexical.Lift | None, lexical.Bands | None, str]:
    """`lexical.lift` of `texts` on `emissions` through the shipped decoder, off the event loop, THE ROW it
    must be judged against, and why it could not be measured. Shared by both lexical gates (the rung's and
    the global
    engine's), so they read the same number the same way. A machinery fault in the kernel raises
    (`InfraFault`, review M7); anything else the decode raises is an unanswered question, not a verdict on the
    text, and the caller's other gate decides — its reason starts `it raised`, which the bench scores as an
    ERROR row (`e2e.FAULT_LEXICAL`), never as a check that passed.

    THE THRESHOLDS ARE PER MODEL, so a matrix from a model with NO CALIBRATION ROW is not measurable here
    (W3 review r2; a TABLE since W4b, `lexical.CALIBRATED`). The
    emission model is chosen per LANGUAGE (`ml.WhisperXAligner._aligner`; de/es/fr load wav2vec2-XLSR
    fine-tunes, another scale and vocabulary), and nothing in the lift reads the language, so without this
    the English bands would judge a German sheet on a German model's log-probabilities — a number
    `lift_gate.py` never measured, deciding a text terminally. Unmeasurable is the shape the wave already
    built for that: the envelope gate keeps the verdict, the lift stays a reading on the trail, and
    `TimedDoc.vouched` is False.

    THE ROW TRAVELS WITH THE LIFT rather than being looked up again by each caller (W4b): both gates read
    several of its numbers — the floor, the doubt band, and at the rung the decode-agreement share — and a
    second lookup could answer differently from the one that decided the lift was measurable at all.

    A row and a lift are TWO questions, and only one of them is about the model. `bands is None` means this
    MATRIX's model has no calibration, so nothing emission-scaled may be read off it — not the lift, and not
    the rung's share. A `None` lift with a row present is about the TEXT (too few letters, no order to
    contrast, a decode that refused it): the row still holds, so the rung's timing gate still applies, and
    only the words go unjudged. A matrix that NAMES NO MODEL is the shipped row's by construction — a test's
    fake or a bench emission cache written before `Emissions.model` existed, never production.
    """
    from encore_worker.adapters.ml import forced_align_decoder  # noqa: PLC0415

    bands = lexical.calibration(emissions)
    if bands is None:
        return None, None, lexical.uncalibrated(str(getattr(emissions, "model", "") or ""))
    try:
        got = await asyncio.to_thread(partial(lexical.lift, decoder=forced_align_decoder), texts, emissions)
    except InfraFault:
        raise  # the machinery, not this text: fails the job (review M7)
    except Exception as exc:  # noqa: BLE001 - an unanswered question, not a verdict on the text
        return None, bands, f"it raised {type(exc).__name__}: {exc}"
    if got is None:
        return None, bands, f"under {lexical.MIN_LETTERS} alignable letters, or no word order to contrast"
    return got, bands, ""


#: How long a sheet line may claim to be sung when its END is only the next line's START. An LRC carries
#: onsets, not ends (`parse_lrc` ends each line at the next stamp), so uncapped its spans tile the whole
#: song, instrumental breaks included, and the expected envelope degenerates to one block that any text's
#: onsets can match. 5 s is past nearly every sung line and short of most breaks.
_SHEET_SPAN_CAP_SEC = 5.0


def _sheet_spans(segments: Sequence[Segment]) -> list[tuple[float, float]]:
    """A sheet's claimed singing, in time order, for the LINE_SYNC gate's envelope fit.

    A span whose end coincides with the next line's start (within 1 ms) is capped at
    `_SHEET_SPAN_CAP_SEC`: that end is an onset of the NEXT line, not a measurement of this one. A span
    with an end of its own (an authored caption, a lrcmux line) keeps it.
    """
    every = sorted(measure.line_spans(list(segments)))
    out: list[tuple[float, float]] = []
    for position, (start, end) in enumerate(every):
        if end <= start:
            continue
        following = every[position + 1][0] if position + 1 < len(every) else None
        if following is not None and abs(end - following) <= 1e-3:
            end = min(end, start + _SHEET_SPAN_CAP_SEC)
        out.append((start, end))
    return out


def _line_doc(segments: Sequence[Segment], language: str) -> dict[str, object]:
    """A line-synced document: each segment becomes a line with no per-word spans.

    One implementation for both the `LINE_SYNC` knob and any other line fallback, so the two cannot
    drift into producing different shapes for the same claim — including the ORDER of the starts, which
    `_in_claim_order` normalises here (W2) so that no caller can publish a stray backwards claim by forgetting
    to. Idempotent, so a caller that ordered the segments itself to report what it held is not a second rule.
    A sheet whose order that function REFUSES to normalise passes through with its inversions intact, on
    purpose: `measure.out_of_order` is what `policy.decide` drops such a text on.
    """
    ordered, _held, _unheld = _in_claim_order(segments)
    return {
        "language": language,
        "lines": [
            {"text": str(s.get("text") or ""), "start": s.get("start"), "end": s.get("end")} for s in ordered
        ],
    }


#: The never-sung rule's three thresholds, ALL required (see the drop block in `_time_text_global`).
#: Calibrated on tfr-chosen's credit caption (gap -4.2, env 0.04, 1.0 chars/s) against tfr-mayday's REAL
#: quiet echo line (gap -2.5, env 0.06 — but sung at normal tempo, which is what the rate check protects).
#:
#: RE-MEASURED ON THE EXACT CLOCK AND THE FLOOR HELD — ON A STEM (W4b, `scripts/unsung_gate.py`, rows
#: committed as `results/w4b-unsung-gate.json`; 32 songs x 6 text modes = 192 song-modes, blind, base model,
#: `--target stem`). W4's grid
#: moved every score, span and envelope read the two exhibits above were fitted on, and W4b's brief asked
#: whether `_NEVER_SUNG_ENV` should become a PER-SONG RELATIVE floor — review L2's point being that 0.10 is an
#: ABSOLUTE level on a P95-normalised envelope, which only means something on a clean stem. It should not, and
#: the reason is the direction of the corpus's own numbers.
#:
#: WHAT THIS SWEEP DID NOT MEASURE, and it is the half of L2 that is still open (W4b review r1): every one of
#: those 192 song-modes is a STEM target, and on the MIX the rule is not MIS-fitted but INERT. `_time_text_
#: global` reads `env` off the ALIGN TARGET, which on a stemless song is the mix (W4 review r1 made the lift
#: floor the mix's verdict and the mix its own target), and L2's own figures are that the level between lines
#: averages 0.51 on a mix against 0.27-0.31 on a bleed stem — both far above 0.10, so no line's span reads
#: below the floor and an unsung caption or credit line is timed and PUBLISHED there. That is a real published
#: outcome on a song with no stem, not a calibration question: the floor below is not what would fix it (a
#: level that separates lines on a mix is a different measurement, and the corpus's stemless bench mode is
#: where it would be priced). `unsung_gate.py --target mix` runs the same sweep against `song.mix` for the
#: wave that takes it; nothing in W4b ran it, so every number below is a stem number.
#:
#:   THE RULE PAYS FOR ITSELF. Against the same loop with the floor at 0 (the rule off): +8 line starts within
#:   ±500 ms of truth (6576 of 9214 shown lines against 6568 of 9251) and -19 gross lines (1138 against 1157),
#:   for 37 real and 21 injected lines not published. 20 of those 37 are CAPTION NON-LYRICS the truth file
#:   carries because the truth IS a caption track — `(energetic rock music)`, `(somber music)`,
#:   `[COSTUME RUSTLES]`, `(Adele inhaling)`, an uploader credit — which W5's text hygiene owns (M11/L4/L5).
#:
#:   A RELATIVE FLOOR IS STRICTER HERE, NOT KINDER. The level BETWEEN decoded lines on these stems is at or
#:   above 0.10 on 29 of 32 songs (per-song medians 0.019-0.578, median of medians 0.248; the q25 is >= 0.10
#:   on 17 of 32, the q10 on 5 of 32) — bleed, reverb tails and instrument leakage, exactly L2's 0.27-0.31
#:   on a bleed stem. So a floor read at the song's own MEDIAN gap exceeds 0.10 nearly everywhere, and
#:   capped at 0.10 it is a NO-OP: 0 of 192 song-modes move, every count identical. Read at the q25 it moves
#:   11 and already costs -4 ±500 lines and +1 gross; at the q10 it moves 22, -9 ±500 and +17 gross, AND
#:   spares 5 of the 21 injected lines — a rise in `unsung`, which `gates/w2.yaml`'s and `gates/w4.yaml`'s
#:   `unsung-not-up-*` forbid. Uncapped at the median it drops 62 real lines instead of 37. No variant is
#:   Pareto-better than the constant on any of the three readings.
#:
#:   THE TWO POPULATIONS OVERLAP, which is the general form of it: the 28 REAL candidate lines read
#:   0.0014-0.0965 and the 19 INJECTED ones 0.0007-0.0758, so a threshold on the level cannot sort them at
#:   all. `(energetic rock music)` — bohemian-rhapsody's caption cue, in the truth file and not sung — reads
#:   0.0957, ABOVE the real sung line the wave wants to keep.
#:
#:   AND THE TWO LINES THE WAVE WANTED SEPARATED CANNOT BE, AT ANY FLOOR. `Pure_Mids_-_The_Leader` line [0]
#:   ("now that i have found you i'm okay", a REAL sung line, the single systematic W4 regressor) reads env
#:   0.0890, score gap -2.27, 0.92 chars/s. `tfr-chosen` line [34] (the spoken "TheFatRat is the chosen
#:   one..." credit, a truth line whose DROP is worth +2 ±500 lines and -3 gross on its own song) reads
#:   0.0892, -2.15, 1.22 — the same numbers to three decimals. Their songs' gap quantiles order the wrong way
#:   for a relative floor to help (Pure_Mids q10 0.075, tfr-chosen 0.024), so every floor that spares the one
#:   spares the other. WHAT THEY ACTUALLY SHARE is not silence but SMEAR: the decode spread them over 37 s and
#:   47.6 s and placed them 32.5 s and 54.3 s from the truth, so all three signals are reading one fact — a
#:   line the decode could not place — rather than three independent witnesses, and the envelope MEAN over a
#:   span the decode chose says more about the decode than about the audio. That is the cause, and it is not a
#:   threshold: the fix for a line like Pure_Mids' is to re-measure it where its CLAIM says rather than to bin
#:   it (review M6's `m6-window-spare`, which recovers it at -0.048 s — see `gates/w4.yaml`), and that arm's
#:   own default is a measured corpus decision, not this constant's.
_NEVER_SUNG_SCORE_GAP = 2.0
_NEVER_SUNG_ENV = 0.10
_NEVER_SUNG_RATE = 2.0

#: A SPARED never-sung line (review M6's `m6-mix-spare`, W1's `m6-window-spare`; both default OFF) comes back
#: only where its witness's acoustic model hears speech over its claim window at this fraction of what it
#: hears over the blind decode's own lines (`_speech_mass`: the CTC emissions' non-blank probability) — and
#: its decode is not stuck at the window's edge. The mix's ENVELOPE, which spares a line, cannot tell a voice
#: from the band: in W1 every one of 33 unsung lines it spared (credits over an intro, section headers) came
#: back (review W1 r1). Nor can the decode's SCORE: a spared line is by definition one that decodes poorly,
#: and the sung ones scored 0.6-2.0 below the song's median on the mix — as far below as the headers
#: (-3.4..+1.2) and credits (-2.7..0). Measured over every spared line of W1's time_text bench (16 songs x 15
#: modes, 88 spared on the mix), speech mass on the mix relative to the blind lines': never-be-alone's lost
#: closing lines 0.72-1.25 under truth / jit / offm1 / drop20 / extraverse / headers / credit claims
#: (0.02-0.50 only where offset or tempo claims put the window off the singing), tfr-mayday's sung "(I'm
#: running out of air)" 0.97; section headers 0.00-0.31 but for LUNABLIND's `[Verse 3]` 0.70 and
#: Lower_Loveday's `[Verse 1]` 2.13 (its mix matrix barely hears the voice: 0.03 over its own lines), credits
#: 0.10-0.38, other songs' lines 0.02-0.29 (Ridgway's extra verse 0.59 and 0.82). 0.6 keeps the first group
#: and bins all but 3 of the unsung ones (W5's text hygiene owns headers). Two of those 3 published on the
#: full corpus (LUNABLIND's `[Verse 3]`, Ridgway's extra verse), which is why `m6-mix-spare` ships off.
_SPOKEN_RATIO = 0.6

#: ...and only where the witness hears the voice at all: a matrix whose median speech mass over the blind
#: decode's own lines is under this cannot vouch for one. Measured on the same spared lines: the mixes of
#: Avercage, The_Rinn, Lower_Loveday and Pure_Mids read 0.02-0.05 there (every line they spared is a credit,
#: a header or another song's verse — Lower_Loveday's `[Verse 1]` passed the ratio at 2.13 on 0.03), every
#: song a sung line was spared on 0.08 or more (never-be-alone 0.10-0.13, tfr-mayday 0.12).
_SPOKEN_FLOOR = 0.06


def _speech_mass(matrix: Any, start: float, end: float) -> float | None:
    """Mean non-blank probability over `[start, end)` on an emission matrix: how much the acoustic model hears
    SPEECH there (vocables included), where an energy envelope hears anything loud. None for an empty span.

    THE BLANK COLUMN COMES FROM THE MATRIX (`generate.blank_of`, review M9, done in W4). It used to be the
    literal 0, which on a vocabulary whose pad sits elsewhere reads the probability of a LETTER: the witness
    would then have scored a sung span as silence and a silent one as speech, inverting every never-sung
    spare and every adoption this number gates.
    """
    import numpy as np  # noqa: PLC0415 - the steps layer's lazy numpy, as `_time_text_global` reads it

    from encore_worker.domain.lyrics.generate import blank_of  # noqa: PLC0415

    log_probs = np.asarray(matrix.log_probs)
    frame_sec = float(matrix.frame_sec)
    if frame_sec <= 0 or log_probs.ndim != 2:
        return None
    blank = blank_of(matrix)
    if not 0 <= blank < log_probs.shape[1]:
        return None  # a matrix that names a column it does not have cannot testify
    first = max(0, int(start / frame_sec))
    last = min(len(log_probs), max(int(end / frame_sec), first + 1))
    if last <= first:
        return None
    return float(1.0 - np.exp(log_probs[first:last, blank]).mean())


def _placement_margins(
    matrix: Any, line_texts: Sequence[str], *, separate_lines: bool = False
) -> dict[int, float]:
    """How ambiguous each line's placement was on `matrix`, in nats (`domain.lyrics.margin`, review §3.7).

    THE SAME TARGETS THE DECODE RAN ON, built by `generate.char_targets` — the one flatten both readers
    share — so the margin describes the path that produced these timings and not a second encoding of the
    same text. `line_texts` must therefore be the texts the BLIND decode was given (post never-sung drop),
    and `separate_lines` its own setting.

    `{}` ON ANY FAULT, deliberately: an empty answer means "not measured", and grading then reads exactly
    what it read before this existed. A confidence signal that goes DOWN when its own computation fails
    would demote every line of every song on a matrix it could not read — caution that looks like evidence.
    The steps layer owns the numpy conversion because `domain/` may not import torch (`test_layers`).
    """
    import numpy as np  # noqa: PLC0415 - the steps layer's lazy numpy, as `_time_text_global` reads it

    from encore_worker.domain.lyrics import margin  # noqa: PLC0415
    from encore_worker.domain.lyrics.generate import blank_of, char_targets  # noqa: PLC0415

    flat = char_targets(line_texts, matrix, separate_lines=separate_lines)
    if not flat.targets:
        return {}
    try:
        return margin.placement_margins(
            np.asarray(matrix.log_probs, dtype=np.float64),
            flat.targets,
            flat.first_char_target,
            blank=blank_of(matrix),
            frame_sec=float(matrix.frame_sec),
        )
    except (ValueError, MemoryError) as failed:
        # MEMORY IS THE REAL ONE: the two kept curve arrays are frames x lines, small, but the caller has
        # the whole matrix and a Viterbi alive beside it. A fault here must not lose a document that is
        # already timed, so it degrades to the grading this wave replaced.
        del failed
        return {}


def _margin_why(margins: Mapping[int, float], doubted: Collection[int], lines: int) -> str:
    """The placement-margin clause of the trail note: the signal, its threshold, and what it doubts.

    `doubted` is what the RULE flags (`margin.low_lines`), not what published `low`: a flagged line a claim
    corroborates keeps its grade (see `line_confidence`), and a line may be `low` for four other reasons. The
    wording says "doubts" for exactly that reason — a note that claimed a count of demotions would be wrong
    on both sides.
    """
    from encore_worker.domain.lyrics import margin  # noqa: PLC0415

    if not margins:
        return "placement margins: not measured, so grading is as it was before review §3.7"
    ordered = sorted(margins.values())
    tight = sum(1 for gap in ordered if gap < margin.MIN_MARGIN_NATS)
    return (
        f"placement margins over {len(ordered)} of {lines} lines: median "
        f"{median(ordered):.0f} nats, min {ordered[0]:.0f}, {tight} under "
        f"{margin.MIN_MARGIN_NATS:.0f} — {len(doubted)} doubted on ambiguity or a low score"
    )


#: A repaired line whose decode landed within this of the window's LEFT EDGE "heard nothing": a forced
#: path through flat emissions collapses leftward. Measured on tfr-chosen's chopped-vocal outro, where
#: the errors clustered at exactly the pad width.
_ADOPT_EDGE_SEC = 0.08

#: How far below the song's own median line score a repaired line must sit to be called unheard. Scores
#: compare WITHIN a song only (F3); the measured good/gross medians were -0.95 vs -1.76.
_ADOPT_SCORE_GAP = 0.5

#: Slack added around a repair window before re-decoding inside it: a claim's own onset carries the two
#: measurements' combined jitter (~250 ms tolerance in reconcile), and a window cut exactly to the claim
#: would clip a note the claim started late on. One second is generous without reaching the neighbouring
#: line at singing tempo. It is also the reach of `claim_run`'s hold-open: a blind decode starting this close
#: to the claim span is the same line measured twice, further away is a second hypothesis (review M5).
_REPAIR_PAD_SEC = 1.0


class _Source(StrEnum):
    """Where a line's published timing came from: the repair ladder's per-line provenance (review H4).

    Carried because the ladder's stages are NOT equally independent of the claims, and grading cannot
    tell them apart from the timings alone: a line re-decoded inside its claim window lands on the claim
    by construction, so its agreement with the claim is not a second measurement.
    """

    #: The global decode's own line: no claim chose where it was decoded (the never-sung rule only picks
    #: which lines are decoded at all).
    BLIND = "blind"
    #: R3: re-decoded jointly between the unique lines around a repeated block. No claim is used, so where
    #: it lands is independent of the claims: `high` where that is on its claim (on the blind verdict's
    #: clock), which the blind decode — misbinding it — never corroborated.
    ANCHORED = "anchored"
    #: R1 / R2: re-decoded inside its padded claim window, on the target.
    WINDOW = "window"
    #: R4: re-decoded inside its padded claim window, on the MIX.
    MIX = "mix"
    #: The claim's own span, adopted because no window decode heard the line.
    ADOPTED = "adopted"


#: How many lines of one source the trail names by index before it only counts the rest: R1 re-decodes
#: every claimed line, and a 90-line index list would bury the rest of the verdict note.
_SOURCES_NAMED = 12


def _ends_why(
    before: Generated, after: Generated, experiments: frozenset[str], *, on_stem: bool = True
) -> str:
    """The trail's line for the word-end post-pass: how many ends moved, and by how much.

    A display change no metric on the report can show (`measure` judges order on STARTS) would otherwise
    be invisible on the audit page, and "the ball leaves the word early" is a report this note answers
    directly. It states the ARM when one is on, so a run whose ends look raw says why — and it says the
    same about the target, because "this song has no vocals stem" is the other reason ends look raw
    (`ends.ACTIVE_LEVEL` is a stem's calibration; W4 review r1).
    """
    if "ends-raw" in experiments:
        return "word ends: the raw decode's (ends-raw)"
    if not on_stem:
        return "word ends: the raw decode's (no vocals stem: the envelope's silence level is a stem's)"
    moved = sorted(
        after_word.end - before_word.end
        for before_line, after_line in zip(before.lines, after.lines, strict=True)
        for before_word, after_word in zip(before_line.words, after_line.words, strict=True)
        if after_word.end > before_word.end
    )
    words = sum(len(line.words) for line in before.lines)
    # The arm is named in BOTH branches: "nothing moved" under `ends-tile` is a different claim about the
    # decode (every line already tiled) than the same sentence on the default.
    arm = " tiling within each line (ends-tile)" if "ends-tile" in experiments else ""
    if not moved:
        return f"word ends: none of {words} extended{arm} (the envelope stops where the decode does)"
    return (
        f"word ends: held {len(moved)} of {words} through the singing{arm}, median "
        f"+{moved[len(moved) // 2] * 1000:.0f} ms, worst +{moved[-1]:.2f}s"
    )


def _bundle_why(emissions: object) -> str:
    """The trail's clause naming the ALIGNMENT BUNDLE a document's word timings came off (W4b review r1).

    NOTHING ELSE ON THE PRODUCTION RECORD NAMED IT. The bundle is an operator setting with three calibrated
    rows since W4b 6b (`host.config.align_model`, `adapters.ml.ALIGN_MODELS_BY_DEVICE`,
    `domain.lyrics.lexical.CALIBRATED`), and every emission-scale threshold that judged this text — the lift's
    bands, the mix floor, the rung's agreement share — is read off the resolved one's row. Until this clause
    the only reader of `Emissions.model` in `steps/` was `_measured_lift`'s calibration lookup, which prints
    the name only when there is NO row, so two failures had no evidence: an operator flipping
    `ENCORE_ALIGN_MODEL` between a job's attempts (or a retry landing on a differently configured worker),
    which makes one document's timings two bundles' work with nothing on the trail to show it; and a
    "the timings got worse" report on a box whose bundle nobody recorded. `__main__` prints the resolved
    bundle once at startup for the same reason it prints which ffmpeg.

    "unnamed" is not production: a matrix names no model only for an aligner older than the field or a test's
    fake, which `lexical.calibration` treats as the shipped row for exactly that reason.
    """
    named = str(getattr(emissions, "model", "") or "")
    return f"bundle {named or 'unnamed'}"


def _linesep_why(separator: int | None, *, named: int | None) -> str:
    """The trail's clause for 6c's line separator, printed only under the `linesep` arm (review D1).

    IT SAYS WHETHER THE ARM ACTUALLY DID ANYTHING, which is the whole reason it is a sentence and not a
    boolean: `generate.separator_of` returns None on a vocabulary that names no `|` or maps it to the blank
    column, and the arm is then INERT — a run recorded under its name that silently measured the default path
    is exactly what `Config.ALIGN_EXPERIMENTS` refuses unknown names to prevent, and an arm going quietly
    inert is the same mistake arriving from the other side.

    AND WHICH OF THE TWO INERT CASES IT WAS (W4b review r1; `host.config.ALIGN_EXPERIMENTS` states this as the
    arm's contract). `named` is `generate.separator_named`, the unfiltered reading, so the blank collision —
    the case the arm is inert FOR, rather than merely absent, and the one a reader would otherwise chase in a
    vocabulary dump — names the column it collided with. The two lead to opposite next steps: "names none"
    means this bundle cannot run the experiment at all, while "`|` IS the blank" means the kernel would have
    refused every decode and the arm stood down to protect the document.
    """
    if separator is None and named is not None:
        return (
            "line separator: requested (linesep) but this vocabulary's `|` IS its blank column "
            f"(id {named}), so the arm is inert and the targets are the default's"
        )
    if separator is None:
        return (
            "line separator: requested (linesep) but this vocabulary names none, so the targets are the "
            "default's"
        )
    return f"line separator: `|` (id {separator}) between lines, its frames blank (linesep)"


def _sources_why(provenance: Mapping[int, _Source], indexes: Sequence[int]) -> str:
    """The trail's per-line provenance for the published lines: how many each source timed, and which.

    Blind lines are only counted; every other source names its lines `[i]` by input index, like the
    never-sung and out-of-order notes, because "which line did the mix time" is the first question a
    wrong highlight raises.
    """
    by_source: dict[_Source, list[int]] = {}
    for index in indexes:
        by_source.setdefault(provenance.get(index, _Source.BLIND), []).append(index)
    parts: list[str] = []
    for source in _Source:
        named = by_source.get(source, [])
        if not named:
            continue
        if source == _Source.BLIND:
            parts.append(f"{len(named)} blind")
            continue
        shown = " ".join(f"[{i}]" for i in named[:_SOURCES_NAMED])
        more = f" +{len(named) - _SOURCES_NAMED} more" if len(named) > _SOURCES_NAMED else ""
        parts.append(f"{len(named)} {source.value} {shown}{more}")
    return f"timing sources: {', '.join(parts)}"


#: The width a repaired line is widened to: v2's clamp (`_clamped_v2`, the default) floors every repaired
#: line at it. The `m2-order-clamp` arm widens only where the gap has room, so a document v2 already
#: published in order does not change, and never across the next trusted start, which is how v2 pushes
#: words past it (review M2); the arm's hard floor is one decoder frame per letter.
_REPAIRED_MIN_SEC = 0.2


def _with_lines(generated: Generated, repaired: Mapping[int, Line]) -> Generated:
    """`generated` with repaired lines swapped in by index, and any it lacks INSERTED in index order.

    Insertion is the never-sung rule's spared lines coming back (review M6): they left the decode, and
    their claim-window re-decode is what returns them. Every other repair replaces a line it was given.
    """
    from encore_worker.domain.lyrics.generate import Generated  # noqa: PLC0415

    present = {line.index for line in generated.lines}
    added = [line for index, line in repaired.items() if index not in present]
    lines = [repaired.get(line.index, line) for line in generated.lines]
    return Generated(
        lines=tuple(sorted([*lines, *added], key=lambda line: line.index)) if added else tuple(lines),
        language=generated.language,
    )


def _clamped(
    generated: Generated, repaired: set[int], *, blind: Generated, frame_sec: float, ordered: bool
) -> tuple[Generated, frozenset[int]]:
    """Repaired lines clipped to their neighbours; with `ordered`, fitted IN ORDER or refused to `blind`.

    A repaired line measured inside a padded window, or an adopted claim span that overlaps the next
    caption, is re-fitted affinely into the free gap — found live, where two spilled words made `decide`
    degrade an otherwise-corroborated document to line sync.

    THE OVERLAP IS RESOLVED AT WHICHEVER SIDE IS THE WEAKER MEASUREMENT, which since W6 is not always the
    repaired line: where the line BEFORE a repair runs past its start, the default clamp pulls that
    neighbour's END back onto the repair instead of pushing the repair forward onto the end
    (`_clamped_v2`, which carries the failure account and the numbers). That reverses this docstring's
    old "only REPAIRED lines move: a trusted decode line's overlap is a measurement and stays" for the
    one case it was measured wrong in — a trusted END, never a start, never a line's existence or order.
    The ARM still only moves repaired lines: it refuses instead (`_fitted_run`), and W1/W3 measured it
    that way.

    DEFAULT (`ordered` False): v2's clamp with W6's bounded left floor (`_clamped_v2`), which can still
    publish backwards word starts (review M2) where a repair lands past its successor. `ordered` is the
    `m2-order-clamp` arm (`Config.align_experiments`), built and
    tested and shipped OFF because it failed two of W1's reject-if gates on the full corpus (base model,
    32 songs x 15 claim modes, `e2e.py --modes all`, against `results/baseline-v2*.json`):
      * WRONG TEXTS. At `--level run_align` the job published 152/320 wrong texts with the arm, against
        the baseline's 84 and 89 without it (84 + H2's 5). The 63 extra are the out-of-order wrong texts:
        the old clamp inverted them, `decide` sent them to the LINE_SYNC rung and its sheet gate refused
        every one; in order, they publish as word documents at attempt 1, past the envelope gate (review
        H3's false pass). The gate is "must not exceed 84". CLOSED BY W3: the lexical gate refuses a text
        before any repair runs, so this clamp never sees one it refuses. Re-judged under it, the arm
        publishes 0/320 at `run_align` and 1/320 at `time_text`: LUNABLIND #2, whose RAW text lifts +0.217
        into the doubt band (+0.189 cleaned, as `run_align` serves it), and which the default publishes
        too, every line `low`.
      * A JAMENDO SONG GAINED A GROSS LINE in jit (Tom_Orlando 1 -> 2 at `time_text`): a refused run
        went back to a blind line 21 s from where it is sung. The fallback is the arm's weak point: the
        blind decode is the decode the repairs were there to fix. Where it is unrelated the refusal
        does the damage: never-be-alone headers 0 -> 20 gross (all 52 lines one refused run, back on
        it; `[Chorus]` moved 52 s), extraverse 34 -> 55 gross over 7 songs, drop20 51 -> 56. Those runs
        were IN ORDER in the baseline job, which published them at attempt 1; the frame-per-letter floor
        and the next-start ceiling refused them. Without the arm, W1's `time_text` passes all 41 gates.
    What the arm bought at W1: at `run_align` it publishes all 47 texts the baseline lost to M2 + M1
    (off15 8, off3 20, headers 9, tempo102 5, jit 2, off05 / drop50 / credit 1; without it the gated
    LINE_SYNC rung recovered 16 as line sync), and moves the text-denominator ±500 from 41.7 / 17.6 /
    51.4 / 66.3 / 49.8 (off15 / off3 / headers / jit / tempo102) to 69.9 / 70.1 / 84.9 / 82.3 / 64.9,
    against 48.5 / 36.9 / 68.3 / 68.3 / 49.6 without it; at `time_text` off3 gross 456 -> 297 and
    tempo098 260 -> 186, tempo102 376 -> 299.

    RE-JUDGED UNDER W3 (2026-09-28; the arm and the default on the same tree and matrices, over the cases
    where the arm acts: every document it moved at W1 and every text W1 refused, 125 right cases at
    `time_text` and 123 at `run_align`, + the 320 wrong texts). It STAYS OFF. It still fails two MUST
    gates, `jamendo-no-new-gross-jit` at both levels (Tom_Orlando, above) and `s31-blind-unchanged` at
    `time_text` (believer's blind document moves), plus §3.1 by effect in 11 modes at `time_text` and 10
    at `run_align`. And W3's LINE_SYNC gate, which takes the text's own blind decode as its timing witness,
    now recovers most of what the arm got back, and recovers it better. Of the 123 `run_align` cases:
      * 37 the default line-syncs are published by the arm as word documents instead: gross 0 -> 152,
        lines within ±500 ms 2528 -> 2154, `high` lines over 0.5 s off 0 -> 87;
      * 12 the default refuses are published by the arm: 125 gross and 704 of 1103 lines within ±500 ms.
        rap-god off15 / off3 (2-3 gross, 172-176 within) are the real gains; hello and bohemian off3
        (26-28 gross) and HILA and never-be-alone drop50 (18-19 gross, 2-6 within) are not;
      * 74 both publish as words, and there it helps: gross 485 -> 409, ±500 +38 lines.
    Every text the default refused at W1 in the four recovery modes is among these cases, so on them it
    now shows off15 31, off3 29, headers 32 and tempo102 27 of 32, against W1's 26 / 20 / 28 / 27 (tempo is
    W2's). At `time_text`, which has no rung, it still helps in aggregate (the 125: gross 946 -> 705, ±500
    6464 -> 6575 lines), but it regresses the individual songs the gates above name.

    CONFIRMED ON THE FULL CORPUS (2026-09-28; the bench runner's `--modes all,wrongtext+ownclock` arm runs
    at both levels on this code, judged offline against `results/baseline-v2*.json`: 61/74 at `time_text`,
    63/74 at `run_align`). The same two MUST gates fail, and §3.1 by effect names exactly the songs the
    targeted re-judge named, per mode and count for count, so those case sets hold every document the arm
    moves. Its wrong-text half is closed on the corpus too: of the 640 wrong texts it publishes 1 at
    `time_text` (LUNABLIND #2, the doubt-band document the default publishes as well), 0 at `run_align`,
    and 0 in either level's `wrongtext+ownclock`; it refuses none of the 448 right texts, where the default
    refuses 12 at `run_align` — the LINE_SYNC documents its decode gate declines, which the arm publishes
    as word documents instead.

    THE ARM'S UNIT IS A RUN of consecutive repaired lines, bounded by the trusted lines around it:
    nothing in it starts before the previous trusted line ENDS, and no word in it starts after the next
    trusted line STARTS. Each line is clipped into what its predecessors left of that gap (and widened to
    `_REPAIRED_MIN_SEC` where the gap has room). The run is ACCEPTED only if every word start then still
    follows the one before it and every line keeps at least one decoder frame (`frame_sec`) per letter;
    otherwise the WHOLE RUN goes back to its `blind` lines. Those are one monotonic Viterbi's, between
    those same trusted neighbours, so a refusal can never invert either. Returns the document and the
    indexes it reverted, which the caller grades `low` (a reverted line with no blind original, a spared
    never-sung line, is left out of the run instead). A run the old clamp already published in order,
    inside its gap and at a frame per letter comes out byte-identical.

    WHY THE ARM (review M2). The clamp it replaces (`_clamped_v2`, still the default) bounds a repaired
    line by the next one only when that one is trusted, then floors its width at 0.2 s. A repair landing
    past the next trusted start is squeezed, not refused; the 0.2 s floor pushes a squeezed line's words
    past that start; and in a run of two repaired lines the first is bounded by nothing. Each shape
    publishes backwards word starts, which `decide` reads as incoherent timing and answers with line sync
    (and, before M1, the text was lost). W0 at `--level run_align`: 8 songs lost that way under off15, 20
    under off3, 9 under headers, 5 under tempo102, Tom_Orlando and rap-god under jit, and 63 wrong texts;
    `test_repair_order` reproduces the three shapes on 4 of its 32 seeds.

    NOT RE-DECODED between the anchors instead. That window is where the blind decode already put the
    run, and a Viterbi restricted to part of its own optimal path returns that path: R3 is exactly that
    re-decode, and W0 measured it re-decoding 64 lines in 5 runs identical to the global decode, row for
    row, on the real kernel.

    NOT REFUSED LINE BY LINE, which was measured (W1, `--level time_text`, 8 songs x off15 / headers /
    jit / off3 / tempo102, base model): this rule reads 165 gross and 1887 lines within ±500 ms over the
    40 cases, against the old clamp's 195 / 1871, and changes exactly the 22 documents where it refused a
    run. Refusing the fewest lines of a run (dynamic programming) read 164 / 1887: it recovers the headers
    shape, an adopted `[Chorus]` label sharing a run with a lyric line (Rxbyn 3 gross -> 0), and loses
    about as much elsewhere (HILA and Ridgway off3, +1 gross each). Letting a repair overlap a smeared
    trusted tail while its starts stay in order read 163 / 1888 (Tom_Orlando jit 2 -> 0), both together
    162 / 1888. Within noise of each other, so the arm keeps the simplest rule. Dropping the 0.2 s
    widening read 163 / 1892 but changed 3 documents where nothing was refused. (Those 40 cases are where
    the arm wins; the full corpus, above, is where it failed.)
    """
    from encore_worker.domain.lyrics.generate import Generated  # noqa: PLC0415

    if not ordered:
        return _clamped_v2(generated, repaired, frame_sec=frame_sec), frozenset()
    lines = list(generated.lines)
    # A repaired index is a blind line, except a never-sung line spared back in (review M6), which has no
    # blind original: a refused run simply goes without it, which is what the never-sung rule did to it.
    original = {line.index: line for line in blind.lines}
    out: list[Line] = []
    reverted: set[int] = set()
    position = 0
    while position < len(lines):
        if lines[position].index not in repaired:
            out.append(lines[position])
            position += 1
            continue
        stop = position
        while stop < len(lines) and lines[stop].index in repaired:
            stop += 1
        run = lines[position:stop]
        ceiling = lines[stop].start if stop < len(lines) else math.inf
        fitted = _fitted_run(run, out[-1] if out else None, ceiling, frame_sec)
        if fitted is None:
            fitted = [original[line.index] for line in run if line.index in original]
            reverted.update(line.index for line in run)
        out.extend(fitted)
        position = stop
    return Generated(lines=tuple(out), language=generated.language), frozenset(reverted)


def _clamped_v2(generated: Generated, repaired: set[int], *, frame_sec: float) -> Generated:
    """The shipped default: v2's clamp with W6's BOUNDED left floor (`_clamped` without `ordered`).

    Each repaired line is clipped to start no earlier than the line before it ends and, when the next
    line is trusted, to end by its start, then floored at `_REPAIRED_MIN_SEC` wide. It never refuses, so
    review M2's three shapes still publish backwards word starts (`test_repair_order` seeds 2, 6, 12 and
    30, strict xfail on this path): `decide` answers them with the LINE_SYNC rung, whose sheet gate
    published 16 of the 47 right texts W0's `run_align` lost that way and 0 of the 63 wrong ones (W1; since
    W3 the rung's timing gate is the text's own blind decode, `_time_line_sync`).

    WHAT W6 CHANGED, AND THE FAILURE THAT MADE IT (W6 ladder-bound, 2026-09-30). The left floor used to be
    `low = max(line.start, previous_published_end)` unconditionally, and THAT FLOOR IS NOT INDEPENDENT
    EVIDENCE — it is the blind decode's own boundary, i.e. the very reading the repair was there to
    correct. Where the blind decode smears a line over the next line's audio, it also puts the next line's
    start at the smear's end, so pushing the repaired start onto `previous_end` puts the line back exactly
    where the decode had it. Measured on the corpus (32 songs, `truth` claims, `time_text`, one instrumented
    pass per bundle, `_review-scratch/w6-ladder/{clampsim,clampfit}.py`), the floor MANUFACTURED every one
    of HuBERT-Large's new gross line starts — 7 of them, against the base bundle's 3 — after the ladder had
    already got them right (pre-clamp |error| <= 0.75 s, post-clamp +2.06 to +7.63 s), and cost 27 more
    lines their 500 ms band. Three exhibits, all `previous_end == the blind start of this line`:
    `hello` [46] "Outside" adopted at 260.66 against a truth of 260.52 and published at 262.58, which is
    where the blind decode had it; `Tom_Orlando` [70] adopted at the truth to the centisecond and published
    3.15 s late; `The_Rinn` [44] published 7.63 s late behind a 9.57 s adopted span.

    SO THE OVERLAP IS RESOLVED AT THE OTHER SIDE: when the line before a repair ends past its start, that
    neighbour's END is pulled back onto the repair (`_pulled_end`, through `generate.trimmed`) and the floor
    then binds nothing. A LINE END IS THE WEAKER OF THE TWO MEASUREMENTS — W4 item 5 exists because ends run
    late, the repaired start carries the claim clock and the corroboration test behind it, and only the end
    moves: the neighbour keeps its start, its order, its existence, its own grade and every word onset it
    measured before the boundary (`trimmed` re-fits the tail alone; its docstring prices that against an
    affine re-fit of the whole line, which cost 0.1-0.2 pt on four Jamendo word gates).

    MEASURED, EVERY VARIANT THAT WAS TRIED (pooled line starts against truth over 32 songs; gross > 2 s,
    w500 within 0.5 s of 1548 HuBERT / 1591 base scored lines, `ooo` = word starts that precede the word
    before them, which `policy.decide` answers by dropping the whole text to line sync):

        variant                                 HuBERT-L truth   base truth    HuBERT-L off15   base off15
        v2's floor (before this wave)             7 / 1376 / 1   3 / 1408 / 0    7 / 1374 / 0   3 / 1408 / 0
        floor at the neighbour's LAST WORD start  7 / 1381 / 0   3 / 1417 / 0    7 / 1378 / 0   3 / 1415 / 0
        pull the end back, unguarded              0 / 1387 / 0   1 / 1427 / 0    0 / 1382 / 0   1 / 1422 / 0
        pull the end back, GUARDED  <- SHIPPED    0 / 1390 / 0   1 / 1428 / 0    0 / 1386 / 0   1 / 1425 / 0
        ... only where `margin.low_lines` doubts  3 / 1388 / 1   3 / 1418 / 0    3 / 1386 / 0   3 / 1418 / 0
        ... only where it doubts the NEIGHBOUR    5 / 1380 / 1   3 / 1418 / 0    5 / 1378 / 0   3 / 1418 / 0
        ... where it doubts EITHER                3 / 1387 / 1   3 / 1421 / 0    3 / 1385 / 0   3 / 1421 / 0
        no left floor at all                      0 / 1388 / 53  1 / 1428 / 64   0 / 1383 / 62  1 / 1423 / 66

    Read it three ways. (1) THE SHIPPED ROW TAKES CLAMP-MANUFACTURED GROSS LINES TO ZERO ON BOTH BUNDLES
    (base's remaining 1 is `Pure_Mids`, gross before the clamp ever runs — the "no left floor" row proves
    it) and buys 14 / 20 / 12 / 17 lines back into the 500 ms band, while taking `ooo` DOWN, from the one
    inversion v2 published to none. (2) DROPPING THE FLOOR ENTIRELY reaches the same accuracy and publishes
    53-66 inversions, i.e. the floor really is load-bearing and this is a bound on it, not its removal.
    (3) W6's CONFIDENCE WAS MEASURED HERE AND IS NOT WHAT BOUNDS IT: gating the pull on `margin.low_lines`
    — the wave's own hypothesis, that a repair must not overwrite a placement the decode is sure of — is
    STRICTLY WORSE on gross in every column, because the margin grades where a line's own first character
    sits and the conflict here is between a repaired START and a neighbour's END, which no per-line
    placement statistic reads. The bound that works needs no constant at all (see `_pulled_end`).

    NOT THE WAVE'S FIRST HYPOTHESIS EITHER, and the record matters because the first one was disproved
    before anything was built: the ladder breaks ZERO correct blind lines, corpus-wide, on either bundle.
    The `m2-order-clamp` arm's own docstring already records the neighbouring idea — "letting a repair
    overlap a smeared trusted tail while its starts stay in order read 163 / 1888" — which is this fix's
    mirror image, priced on 40 cases inside the arm and read as within noise there.
    """
    from encore_worker.domain.lyrics.generate import Generated, remapped  # noqa: PLC0415

    lines = list(generated.lines)
    out: list[Line] = []
    for position, line in enumerate(lines):
        if line.index in repaired:
            previous = out[position - 1] if position else None
            previous_end = previous.end if previous is not None else 0.0
            if previous is not None and previous_end > line.start:
                pulled = _pulled_end(previous, line.start, frame_sec=frame_sec)
                if pulled is not None:
                    out[position - 1] = pulled
                    previous_end = pulled.end
            low = max(line.start, previous_end)
            high = line.end
            if position + 1 < len(lines) and lines[position + 1].index not in repaired:
                high = min(high, lines[position + 1].start)
            high = max(high, low + _REPAIRED_MIN_SEC)
            if abs(low - line.start) > 1e-9 or abs(high - line.end) > 1e-9:
                line = remapped(line, low, high)
        out.append(line)
    return Generated(lines=tuple(out), language=generated.language)


def _pulled_end(line: Line, boundary: float, *, frame_sec: float) -> Line | None:
    """`line` ending at `boundary` instead of past it, or None where that would not be a decoded timing.

    The one end `_clamped_v2` moves: the line before a repair whose span runs past the repair's start (see
    its FAILURE account). The START never moves, so nothing this line is scored on changes — line starts are
    the metric and its grade is already fixed — and `generate.trimmed` keeps every word onset it measured
    before `boundary`, re-fitting only the tail the decode smeared past it. Measured over the corpus: 70
    pulls on HuBERT-Large and 101 on the base bundle out of 333 / 431 repaired lines, 39 / 43 of them on a
    line the ladder had NOT repaired, median overrun pulled back 0.47 / 0.41 s.

    ONE REFUSAL OF ITS OWN, AND IT IS BORROWED FROM `_fitted_run` RATHER THAN INVENTED, so nothing here is a
    new threshold: ONE DECODER FRAME PER LETTER. Squeezed below it the line is ordered but is no longer a
    timing anyone decoded — CTC gives every target at least a frame, and the targets are letters (a digit is
    out of vocabulary and interpolated, so counting it would refuse a tight but real decode). It EARNS its
    place: 4 refusals on HuBERT-Large and 3 on the base bundle, worth +3 / +1 lines in the 500 ms band
    against pulling unconditionally.

    `trimmed`'s own None — no word of the line starts before `boundary` — is the second, and it never fired
    on the corpus: with it the pull is a no-op on 20 Jamendo songs' word metrics against letting `remapped`
    compress such a line, to every digit. It is kept because it is what makes "no word start ever decreases"
    true of this clamp, which is the property that retired the order guard this function used to carry
    (measured at 0 firings in 64 song-modes, and now unreachable by construction).
    """
    from encore_worker.domain.lyrics.generate import trimmed  # noqa: PLC0415

    if boundary - line.start < max(1, sum(ch.isalpha() for ch in line.text)) * frame_sec:
        return None
    return trimmed(line, boundary)


def _fitted_run(
    run: Sequence[Line], previous: Line | None, ceiling: float, frame_sec: float
) -> list[Line] | None:
    """`run` clipped into the gap after `previous` and before `ceiling`, or None when it cannot keep order.

    The acceptance test is `measure`'s own: word STARTS never decrease, from `previous`'s last word through
    the run to `ceiling`. A line clipped below one frame per LETTER is refused as well — ordered, but no
    longer a timing anyone decoded: CTC gives every target at least a frame, and the targets are letters
    (a digit is out of vocabulary and interpolated, so counting it would refuse a tight but real decode).
    """
    from encore_worker.domain.lyrics.generate import remapped  # noqa: PLC0415

    floor = previous.end if previous is not None else 0.0
    last_start = (
        max((word.start for word in previous.words), default=previous.start)
        if previous is not None
        else -math.inf
    )
    fitted: list[Line] = []
    for line in run:
        low = max(line.start, floor)
        high = min(max(line.end, low + _REPAIRED_MIN_SEC), ceiling)
        if high - low < max(1, sum(ch.isalpha() for ch in line.text)) * frame_sec:
            return None
        if abs(low - line.start) > 1e-9 or abs(high - line.end) > 1e-9:
            line = remapped(line, low, high)
        for word in line.words:
            if word.start < last_start:
                return None
            last_start = word.start
        fitted.append(line)
        floor = line.end
    return fitted if last_start <= ceiling else None


def _backwards_why(
    doc: dict[str, object], *, index_of: Sequence[int] | None = None, repaired: Collection[int] = ()
) -> str:
    """The trail's account of an out-of-order word document: how many starts run backwards, and where.

    Lines are named `[i]` like the never-sung note, by INPUT index when `index_of` maps document positions
    to it (the global decode drops unalignable lines, so position and input row differ), and marked when
    a repair produced them — the first question an inversion raises (review M2).
    """
    positions = measure.backwards_lines(doc)
    named = sorted({index_of[p] if index_of is not None else p for p in positions})
    where = ", ".join(f"[{i}]{' (repaired)' if i in repaired else ''}" for i in named)
    return f"{len(positions)} word starts run backwards, in lines {where}"


def _anchored_runs(
    lines: Sequence[Line], needs_fix: set[int], duration_sec: float
) -> list[tuple[tuple[Line, ...], tuple[float, float]]]:
    """Contiguous runs of to-be-repaired lines, each windowed between its nearest KEPT neighbours.

    The kept lines are the anchors: a run's window opens where the previous trusted line ends and closes
    where the next one starts (track edges at the ends), so a re-decode cannot wander outside the region
    its anchors vouch for. Runs are decoded jointly to keep order within the run monotonic.
    """
    ordered = list(lines)
    runs: list[tuple[tuple[Line, ...], tuple[float, float]]] = []
    position = 0
    while position < len(ordered):
        if ordered[position].index not in needs_fix:
            position += 1
            continue
        stop = position
        while stop < len(ordered) and ordered[stop].index in needs_fix:
            stop += 1
        window_start = ordered[position - 1].end if position > 0 else 0.0
        window_end = ordered[stop].start if stop < len(ordered) else duration_sec
        runs.append((tuple(ordered[position:stop]), (window_start, window_end)))
        position = stop
    return runs


def now_ms() -> int:
    """Wall clock, isolated in a step layer. A workflow body must never call this — DBOS replays it."""
    return int(time.time() * 1000)
