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
from encore_worker.domain.lyrics import attribute, lexical, measure, place, presplit
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

        THE WORDS: `lexical.lift` at `_LINE_SYNC_MIN_LIFT` (review W1 r2) — the text's forced path against
        the best of three shuffles of its own words, per letter. A caption track of THIS video fits the
        singing whatever its words: an uploader's English translation of a K-pop song, or YouTube's
        machine-translated `en` track (the one `--sub-langs en.*,en` fetches for a non-English upload).
        Measured with the shipped helper and decoder over the bench's stems (`scripts/lift_gate.py`, base
        model): right texts (truth — which every timing-only mode serves — headers, credit, extra verse,
        drop20, drop50; 192) read +0.26 to +4.34, truth +0.47 at the lowest; the 320 wrong texts -0.21 to
        +0.19, and the 320 same-video wrong-words texts (`wrongtext+ownclock`: another song's words on this
        song's own caption clock) -0.23 to +0.14. At 0.2: 0/192 right refused, 0/640 wrong passed. NOT
        measured: a real translation (the corpus has none), and one into a language whose words share the
        sung ones' letters in order (cognates) may lift above a wrong text's (the CTC fixture: German +1.98,
        French -0.12; `test_lexical` pins that limit).

        THE TIMINGS (W3): the text is decoded BLIND on the same matrix (`generate`: the lift's own forced
        path, kept as lines) and at least `_LINE_SYNC_MIN_AGREEMENT` of its lines must start within
        `_LINE_SYNC_NEAR_SEC` of their PLACED claims — nothing removed, because the claims are what publishes
        (`reconcile.as_claimed`). This REPLACED the sheet-span envelope gate (`_sheet_passes`: the text's
        claimed spans correlated against the stem's activity), which reads only the SHAPE of where a text
        claims singing, blind to the lines themselves. Measured rule by rule with the shipped functions over
        every timed bench case on the stems (`scripts/line_gate.py`, base model; 13 timed modes, 416 right
        texts; a line document "good" with >= 80% of its lines within 1 s of truth, "bad" under 50%):

          rule                           good refused   bad published   right refused   gross shown
          sheet gate + lift (W1)            116/346         6/48            175/416           75
          lift alone (timings unchecked)      0/346        48/48              0/416         1782
          lift + decode agreement 0.5        28/346         0/48             88/416           47
          lift + (sheet OR decode 0.5)       15/346         6/48             68/416          106

        On W1 review r2's `syncMode=lines` probe set (10 modes, 320 right texts) the sheet gate refused 107
        (truth 4/32: hello r 0.36, rap-god 0.21, bohemian-rhapsody 0.36, bad-guy 0.51, whose documents
        read 84% within ±500 ms), the decode 32 (truth 1: never-be-alone, whose blind decode is poor, 0.47),
        both at 0 gross lines shown, text ±500 52.9% -> 82.8%. The decode's refusals are mostly RIGHT to
        make: a sheet off by 1.5-3 s where the envelope cannot place it (hello, rap-god, bohemian off15 /
        off3: 0% within ±500 ms, 365 gross), a 2% tempo error (53 texts, 676 gross), half a sheet missing
        (drop50, 17: its decode strays into the gaps). Its good refusals are never-be-alone (9 texts, 0.37-
        0.49) and drop50. Agreement shares: good documents p10 0.47, median 0.84; bad ones max 0.49; wrong
        texts max 0.26 (wrongtext) and 0.49 (same-video): the decode alone would refuse all 640 too. OR-ing
        the sheet gate back in keeps never-be-alone but publishes its 6 tempo-drifted documents (numb
        tempo102: 21 of 35 lines gross), so it is not taken. The sheet fit still PLACES the lines, and its
        reading stays on the trail. Cost: one `generate` decode beside the lift's four, and the emission pass
        is now paid by every text that reaches the rung, where the sheet gate used to refuse ~a third first.

        FALLBACK: the sheet gate, exactly as W1 shipped it, where the decode cannot be read — an aligner with
        no emission matrix (the windowed capability path), an emission pass or decode that raised (not an
        `InfraFault`: the bench scores that an ERROR row), fewer than `reconcile.MIN_PAIRS` lines decoded.
        Measured then (`scripts/sheet_gate.py`, the bench's claims on the stems as captions and in
        parse_lrc's shape): wrong texts pass 0/320 and 2/320; right texts 241/416 and 163/416, which is why
        it is no longer the gate where the decode can be read. A text the LIFT cannot measure (under
        `lexical.MIN_LETTERS` alignable letters, no word order to contrast) still has its timings checked by
        the decode; its words go unchecked, as the trail says.

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
        placed = self._placed_by(req, fit)
        evidence = await self._line_sync_evidence(req, placed)
        verdict = (
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
        if heard is not None and heard.value < _LINE_SYNC_MIN_LIFT:
            return await refuse(
                f"{verdict}; {heard.why()}, below the lexical gate ({_LINE_SYNC_MIN_LIFT}): these are not "
                "the words the stem sings, whatever their timings (a translated or machine-translated "
                "caption track of this very video reads exactly so)"
            )
        lexical_note = heard.why() if heard is not None else f"no lexical check: {evidence.unlifted}"
        agreed = evidence.agreement
        if agreed is not None:
            if agreed.near < _LINE_SYNC_MIN_AGREEMENT:
                return await refuse(
                    f"{verdict} (not gating: the decode is); {lexical_note}; {agreed.why()}, below "
                    f"{_LINE_SYNC_MIN_AGREEMENT:.0%}: these line timings are not where the stem sings the "
                    "lines (another master's clock, a tempo error, a partial sheet)"
                )
            gate_note = f"{verdict} (not gating: the decode is); {lexical_note}; {agreed.why()}"
        elif fit is None:
            await self._out.state(
                req.job.job_id,
                "align-line-sync",
                0,
                "declined",
                "audio unreadable for the sheet-span envelope gate, and no decode check: "
                + evidence.undecoded,
                None,
            )
            return None
        elif not _sheet_passes(fit):
            return await refuse(
                f"{verdict}, below the sheet gate (r >= 0.40 within ±0.5 s, or r >= 0.60); {lexical_note}; "
                f"no decode check: {evidence.undecoded}"
            )
        else:
            gate_note = f"{verdict}; {lexical_note}; no decode check: {evidence.undecoded}"
        doc = _line_doc(placed, req.language)
        report = measure.measure(doc, duration_sec=req.audio.duration_sec, engine=Engine.LINE_SYNC)
        timed = self._write(req, doc, TIMING_LINE, "low", report=report)
        await self._out.state(
            req.job.job_id, "align-line-sync", 0, "line-sync", f"{gate_note}; {report.summary()}", None
        )
        return timed

    async def _line_sync_evidence(self, req: TimeRequest, placed: Sequence[Segment]) -> _LineEvidence:
        """What the STEM's emission matrix says about a line-sync text: its `lexical.lift`, and how its
        `placed` claims sit against its own blind decode (`reconcile.as_claimed`) — each None with why it
        could not be read.

        The stem, as every reading of this rung: `_time_line_sync` declines a stemless song before this. A
        machinery fault in the emission pass or the kernel raises (`InfraFault`, review M7); anything else (a
        language with no alignment model, a kernel refusing these targets) is an unanswered question, and
        the caller falls back to the sheet gate.

        COST: one emission pass over the stem, plus four CTC decodes for the lift and one for the decode
        (`generate`, which also groups the lift's own path into lines). In forced mode the global attempt
        computed that same matrix a step earlier, but a step cannot hand a tensor to the next one (a
        checkpointed record holds refs, never tensors), so it is computed again; `syncMode=lines`, which
        decodes nothing else, pays it once per text.
        """
        emitter = getattr(self._a.aligner, "emissions", None)
        if not callable(emitter):
            none = "this aligner produces no emission matrix"
            return _LineEvidence(None, none, None, none)
        texts = [str(segment.get("text") or "") for segment in req.text.segments]
        try:
            emissions = await asyncio.to_thread(emitter, req.audio.align_target(on_mix=False), req.language)
        except InfraFault:
            raise  # the machinery, not this text: fails the job (review M7)
        except Exception as exc:  # noqa: BLE001 - an unanswered question, not a verdict on the text
            raised = f"it raised {type(exc).__name__}: {exc}"
            return _LineEvidence(None, raised, None, raised)
        lifted, unlifted = await _measured_lift(texts, emissions)
        agreement, undecoded = await _decoded_agreement(texts, emissions, placed, req.language)
        return _LineEvidence(lifted, unlifted, agreement, undecoded)

    async def _word_lift(
        self, req: TimeRequest, line_texts: Sequence[str], emissions: Any
    ) -> tuple[lexical.Lift | None, str]:
        """The global engine's lexical check: `line_texts`' lift on the matrix this attempt decoded, or None
        and why it did not run.

        EXEMPT: the ASR tier, whose words were heard on this very audio, so they can be misheard but not
        another song's (review §3.4); and a text under `lexical.MIN_LETTERS` alignable letters, or one no
        shuffle changes, where the contrast is noise — none in the bench's 832 texts (every right, wrong
        and same-video wrong-words text of the 32 songs holds 201 letters or more). Each keeps the envelope
        gate. Machine captions are NOT exempt: YouTube's machine-translated `en` track is one.

        COST: four CTC decodes on the matrix in hand (the text and three shuffles; no model pass), off the
        event loop like every decode: 0.1-0.3 s each on the bench's stems.
        """
        if req.text.tier is Tier.ASR:
            return None, "a transcript of this recording (its words were heard on this audio)"
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

        THE WRONG-TEXT GATE is the text's lexical lift on this matrix (W3, review H3; `lexical.BANDS` holds
        the bands and their calibration): below the floor the text is `Refused` before anything is repaired;
        in the doubt band it publishes with every line `low` and the document `medium`; above it grading is
        as described. On a stem the lift replaces the envelope gate wherever it measured the text (the
        envelope gate scored our own decode, which the audio pulls onto the voiced frames whatever the
        words: 152/320 bench wrong texts passed it); on the mix it gates beside it. The ASR tier and a text
        the lift cannot measure keep the envelope gate alone.
        """
        from encore_worker.adapters.ml import forced_align_decoder, load_audio_mono_16k  # noqa: PLC0415
        from encore_worker.domain.audio import activity  # noqa: PLC0415
        from encore_worker.domain.lyrics import reconcile as rc  # noqa: PLC0415
        from encore_worker.domain.lyrics.generate import adopted_line, generate, regenerate  # noqa: PLC0415

        aligner = self._a.aligner
        assert aligner is not None  # guarded by time_text; restated for the type checker

        async def decline(why: str) -> None:
            # EVERY refusal is a trail note, because a silent one is indistinguishable from the step never
            # running — which is exactly how the first live run was mis-read. Found, not foreseen.
            await self._out.state(req.job.job_id, "align-global", 0, "declined", why, None)

        target = req.audio.align_target(on_mix=req.on_mix)
        line_texts = [str(segment.get("text") or "") for segment in req.text.segments]
        try:
            emissions = await asyncio.to_thread(aligner.emissions, target, req.language)  # type: ignore[attr-defined]
            generated = await asyncio.to_thread(
                generate, line_texts, emissions, decoder=forced_align_decoder, language=req.language
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

        # The MIX, the second witness: R4 decodes on it, and under `m6-mix-spare` the never-sung rule
        # listens to it before it bins a claimed line. When the target IS the mix (no stem), the lexical gate
        # below reads the mix's matrix and keeps the envelope gate beside it.
        stem_target = target
        mix_target = req.audio.align_target(on_mix=True)
        target_name = "mix" if stem_target == mix_target else "stem"

        # ── the lexical gate (review §3 item 4, H3; W3): are THESE WORDS what the target sings? ──
        # Read once, on the matrix just decoded, before anything is repaired: no repair makes unsung words
        # sung, so a refused text costs no repair ladder. The bands, their calibration and why the lift
        # REPLACES the envelope gate on a stem are at `lexical.BANDS`; `_word_lift` says what is exempt.
        lifted, unmeasured = await self._word_lift(req, line_texts, emissions)
        on_stem = target_name == "stem"
        bands = lexical.BANDS
        floor, ok_from = (
            (bands.refuse_below, bands.ok_from) if on_stem else (bands.mix_floor, bands.mix_ok_from)
        )
        lift_band = lexical.band(lifted.value, on_stem=on_stem, bands=bands) if lifted is not None else None
        # Why nothing vouches for this pin's words: a wrong-text gate would have refused them, and a person
        # chose them (see the envelope gate's NOT FOR A PIN below).
        unvouched: str | None = None
        if lifted is not None and lift_band is lexical.Band.REFUSE:
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
        # The DOUBT band: published, but no line of it is `high` and the document is `medium`.
        doubted = lift_band is lexical.Band.DOUBT
        if lifted is None:
            lexical_note = f"no lexical check: {unmeasured}"
        elif doubted:
            lexical_note = (
                f"{lifted.why()}, in the doubt band [{floor}, {ok_from}) on the {target_name}: every line low"
            )
        else:
            lexical_note = lifted.why()
        # On a stem the lift, where it measured the text, IS the wrong-text gate; the envelope gate still
        # decides on the mix (unless the default-off `h3-mix-lift-alone` arm drops it there too: unmeasured
        # end to end, see `lexical`), and wherever the lift could not measure the text.
        envelope_gates = lifted is None or (
            not on_stem and "h3-mix-lift-alone" not in self._cfg.align_experiments
        )

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
        # smear at far below singing tempo. A re-decode after dropping is a millisecond Viterbi.
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

        #: `_speech_mass` over the blind decode's own lines, per emission matrix: what singing reads as there.
        sung_mass: dict[int, float | None] = {}

        def heard(matrix: Any, line: Line, window: tuple[float, float]) -> bool:
            """Did THIS witness hear a spared line: its decode not stuck at the padded window's left edge (a
            forced path through emissions with nothing to find), and the matrix's acoustic model hearing
            speech over the claim window at `_SPOKEN_RATIO` of what it hears over the blind decode's lines."""
            if abs(line.start - (window[0] - _REPAIR_PAD_SEC)) < _ADOPT_EDGE_SEC:
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

            def decoder(log_probs: object, targets: Sequence[int]) -> tuple[list[int], list[float]]:
                try:
                    return forced_align_decoder(log_probs, targets)
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

        def claim_run(line: Line) -> tuple[tuple[Line, ...], tuple[float, float]]:
            window = claim_windows[line.index]
            return ((line,), (window[0] - _REPAIR_PAD_SEC, window[1] + _REPAIR_PAD_SEC))

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
                edge_stuck = abs(fixed.start - (window[0] - _REPAIR_PAD_SEC)) < _ADOPT_EDGE_SEC
                flat = fixed.score < reference - _ADOPT_SCORE_GAP
                if edge_stuck or flat:
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
        if verdict.verdict == rc.UNRELATED and len(claim_windows) >= rc.MIN_PAIRS:
            claim_fit = activity.fit_shift(
                env, activity.expected_envelope(list(claim_windows.values()), len(env))
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

        # ── R2: structural disputes. The disagreeing minority under a STRUCTURAL verdict is exactly where
        # a repeat may be bound to the wrong occurrence (F2); the claim is the only occurrence-anchor
        # available, so the disputed lines are re-decoded inside their claim windows. Whether the witnesses
        # then meet is NOT asked of the re-reconcile (it would count the claim agreeing with itself): the
        # re-reconcile only steers what is left, and grading asks the blind verdict (review H4).
        # STRUCTURAL repairs every disputed line (fine disagreement); COARSE repairs only the GROSSLY
        # displaced ones. The distinction is the Numb-vs-Avercage lesson: sub-second jitter against
        # loosely-timed captions must NOT be "repaired" (a re-decode there regresses — Numb), but a line
        # sitting seconds from its claim in an otherwise-coarse sheet is unambiguously misbound and the
        # claim is the only anchor for it (Avercage: 6 gross lines COARSE left unfixed until this branch).
        # A line R4 heard on the mix sits within jitter of a jittered claim and reads as disputed; R2's stem
        # decode, where the stem is silent, then adopts the claim over the mix's measurement (repro s6:
        # 27.00 s heard, 27.40 s published) — unless `l1-mix-kept` keeps it (`mix_kept`).
        if verdict.verdict in (rc.STRUCTURAL, rc.COARSE):
            if verdict.verdict == rc.STRUCTURAL:
                disputed_indexes = {j.index for j in verdict.lines if not j.corroborated}
            else:
                disputed_indexes = {
                    j.index
                    for j in verdict.lines
                    if abs(j.residual_sec - verdict.offset_sec) > rc.COARSE_TOLERANCE_SEC
                }
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
        claims_disagree = bool(claimed) and blind_verdict.verdict == rc.UNRELATED

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
            return "low" if index in repeats else "high"

        doc = generated.as_doc()
        lines_json = doc.get("lines")
        if isinstance(lines_json, list):
            for line, rendered in zip(generated.lines, lines_json, strict=True):
                rendered["confidence"] = line_confidence(line.index)

        # NO residual is fed to `measure` here, deliberately: reconcile's fitted offset describes THE
        # CLAIM (our timings never moved to match it), and a residual on the report would let `decide`
        # offer RESHIFT — a knob that re-places input timings this engine never used. The offset still
        # reaches the trail through `blind_verdict.why` below.
        report = measure.measure(doc, duration_sec=req.audio.duration_sec, engine=Engine.GLOBAL)
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
        timed = self._write(req, doc, TIMING_WORD, confidence, report=report)
        # The evidence on the trail, not just the verdict: this line is what makes a wrong-lyrics report
        # debuggable from the audit page. Fire-and-forget would drop it on a closed socket; awaited.
        await self._out.state(
            req.job.job_id,
            "align-global",
            0,
            # The BLIND verdict: the one grading read. The ladder's last re-reconcile follows it, labelled
            # as what it is, so a verdict the repairs moved (tfr-chosen: UNRELATED -> COARSE) stays legible.
            blind_verdict.verdict,
            f"envelope r={blind_fit.correlation:.2f} (blind), r={fit.correlation:.2f} (repaired)"
            f"{'' if envelope_gates else ', not gating: the lift is'}; {lexical_note}; "
            f"{blind_verdict.why}; "
            + (
                f"after repairs {verdict.verdict}, {verdict.agreement:.0%} of {verdict.pairs} lines agree "
                "(steers the repairs, never the grade); "
                if verdict is not blind_verdict
                else ""
            )
            + (f"{'; '.join(repairs)}; " if repairs else "")
            + f"{_sources_why(provenance, [line.index for line in generated.lines])}; "
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

    def _placed_by(self, req: TimeRequest, fit: ShiftFit | None) -> tuple[Segment, ...]:
        """`_placed` with the vocal-activity fit already measured (the LINE_SYNC gate measures it anyway).

        The fit MOVES the sheet only when it is trustworthy (`ShiftFit.usable`) over at least
        `place.MIN_PAIRS` timed lines; anything less leaves the sheet exactly where it was, which is the
        behaviour that shipped before the fit existed.
        """
        segments = list(req.text.segments)
        pairs = len(_timed_spans(segments))
        if fit is not None and fit.usable and req.text.has_own_timings and pairs >= place.MIN_PAIRS:
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


#: The LINE_SYNC rung's lexical gate: a text at the rung must explain the stem's emissions by
#: at least this many nats per letter better than the best of three shuffles of its own words
#: (`lexical.lift`). Measured on the base model's stems (`scripts/lift_gate.py`; the reasoning and the
#: populations are at `_time_line_sync`): right texts +0.26 and up, wrong texts +0.19 and down (same-video
#: wrong words +0.14). Model-specific, like every emission-scale number here: recalibrate with the model.
_LINE_SYNC_MIN_LIFT = 0.2

#: The LINE_SYNC rung's timing gate (W3): a text's line document publishes its own claimed starts, so at
#: least `_LINE_SYNC_MIN_AGREEMENT` of the lines the text's blind decode places must start within
#: `_LINE_SYNC_NEAR_SEC` of their placed claim (`reconcile.as_claimed`, nothing removed). Measured over every
#: timed bench case on the base model's stems (`scripts/line_gate.py`; the table is at `_time_line_sync`):
#: line documents with < 50% of their lines within 1 s of truth read at most 0.49, those with >= 80% a median
#: of 0.84 (p10 0.47), wrong texts at most 0.26 and, on this song's own clock, 0.49. 1.0 s is `reconcile`'s
#: COARSE tolerance ("same performance, loosely timed") and 0.5 its STRUCTURAL floor; 0.45 publishes 2 bad
#: documents for 12 more good ones, 0.6 refuses 21 more good ones for none. Model-specific in the same way
#: as the lift: the decode's own spread is what the share reads, so recalibrate with the model.
_LINE_SYNC_NEAR_SEC = 1.0
_LINE_SYNC_MIN_AGREEMENT = 0.5


@dataclass(frozen=True, slots=True)
class _LineEvidence:
    """What the stem's emission matrix says about a line-sync text (`AlignStepsImpl._line_sync_evidence`)."""

    #: The text's lexical lift, or None — and why (`unlifted`).
    lift: lexical.Lift | None
    unlifted: str
    #: Its placed claims against its own blind decode, or None — and why (`undecoded`).
    agreement: AsClaimed | None
    undecoded: str


async def _decoded_agreement(
    texts: Sequence[str], emissions: Any, placed: Sequence[Segment], language: str
) -> tuple[AsClaimed | None, str]:
    """`reconcile.as_claimed` of `placed`'s starts against `texts`' blind decode on `emissions` (`generate`,
    the shipped decoder, off the event loop), or None and why it could not be read. A machinery fault in the
    kernel raises (`InfraFault`, review M7); anything else the decode raises is an unanswered question, and
    its reason starts `it raised`, which the bench scores as an ERROR row (`e2e.FAULT_DECODE`)."""
    from encore_worker.adapters.ml import forced_align_decoder  # noqa: PLC0415
    from encore_worker.domain.lyrics import reconcile as rc  # noqa: PLC0415
    from encore_worker.domain.lyrics.generate import generate  # noqa: PLC0415

    try:
        generated = await asyncio.to_thread(
            partial(generate, decoder=forced_align_decoder, language=language), texts, emissions
        )
    except InfraFault:
        raise  # the machinery, not this text: fails the job (review M7)
    except Exception as exc:  # noqa: BLE001 - an unanswered question, not a verdict on the text
        return None, f"it raised {type(exc).__name__}: {exc}"
    claims = {
        index: float(start)
        for index, segment in enumerate(placed)
        if isinstance(start := segment.get("start"), (int, float)) and not isinstance(start, bool)
    }
    got = rc.as_claimed(generated.lines, claims, tolerance_sec=_LINE_SYNC_NEAR_SEC)
    if got is None:
        return None, f"fewer than {rc.MIN_PAIRS} lines both decoded and claimed"
    return got, ""


async def _measured_lift(texts: Sequence[str], emissions: Any) -> tuple[lexical.Lift | None, str]:
    """`lexical.lift` of `texts` on `emissions` through the shipped decoder, off the event loop, or None and
    why it could not be measured. Shared by both lexical gates (the LINE_SYNC rung's and the global
    engine's), so they read the same number the same way. A machinery fault in the kernel raises
    (`InfraFault`, review M7); anything else the decode raises is an unanswered question, not a verdict on the
    text, and the caller's other gate decides — its reason starts `it raised`, which the bench scores as an
    ERROR row (`e2e.FAULT_LEXICAL`), never as a check that passed."""
    from encore_worker.adapters.ml import forced_align_decoder  # noqa: PLC0415

    try:
        got = await asyncio.to_thread(partial(lexical.lift, decoder=forced_align_decoder), texts, emissions)
    except InfraFault:
        raise  # the machinery, not this text: fails the job (review M7)
    except Exception as exc:  # noqa: BLE001 - an unanswered question, not a verdict on the text
        return None, f"it raised {type(exc).__name__}: {exc}"
    if got is None:
        return None, f"under {lexical.MIN_LETTERS} alignable letters, or no word order to contrast"
    return got, ""


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
    drift into producing different shapes for the same claim.
    """
    return {
        "language": language,
        "lines": [
            {"text": str(s.get("text") or ""), "start": s.get("start"), "end": s.get("end")} for s in segments
        ],
    }


#: The never-sung rule's three thresholds, ALL required (see the drop block in `_time_text_global`).
#: Calibrated on tfr-chosen's credit caption (gap -4.2, env 0.04, 1.0 chars/s) against tfr-mayday's REAL
#: quiet echo line (gap -2.5, env 0.06 — but sung at normal tempo, which is what the rate check protects).
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

    Blank is id 0, as the decoder assumes it everywhere today (review M9, W4's to generalise).
    """
    import numpy as np  # noqa: PLC0415 - the steps layer's lazy numpy, as `_time_text_global` reads it

    log_probs = np.asarray(matrix.log_probs)
    frame_sec = float(matrix.frame_sec)
    if frame_sec <= 0 or log_probs.ndim != 2:
        return None
    first = max(0, int(start / frame_sec))
    last = min(len(log_probs), max(int(end / frame_sec), first + 1))
    if last <= first:
        return None
    return float(1.0 - np.exp(log_probs[first:last, 0]).mean())


#: A repaired line whose decode landed within this of the window's LEFT EDGE "heard nothing": a forced
#: path through flat emissions collapses leftward. Measured on tfr-chosen's chopped-vocal outro, where
#: the errors clustered at exactly the pad width.
_ADOPT_EDGE_SEC = 0.08

#: How far below the song's own median line score a repaired line must sit to be called unheard. Scores
#: compare WITHIN a song only (F3); the measured good/gross medians were -0.95 vs -1.76.
_ADOPT_SCORE_GAP = 0.5

#: Slack added around a claim window before re-decoding inside it: a claim's own onset carries the two
#: measurements' combined jitter (~250 ms tolerance in reconcile), and a window cut exactly to the claim
#: would clip a note the claim started late on. One second is generous without reaching the neighbouring
#: line at singing tempo.
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

    Only REPAIRED lines move: a trusted decode line's overlap (real backing-vocal overlap exists) is a
    measurement and stays. A repaired line measured inside a padded window, or an adopted claim span that
    overlaps the next caption, is re-fitted affinely into the free gap — found live, where two spilled
    words made `decide` degrade an otherwise-corroborated document to line sync.

    DEFAULT (`ordered` False): v2's clamp, unchanged (`_clamped_v2`), which can publish backwards word
    starts (review M2). `ordered` is the `m2-order-clamp` arm (`Config.align_experiments`), built and
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
    W2's). At `time_text`, which has no rung, it still
    helps in aggregate (the 125: gross 946 -> 705, ±500 6464 -> 6575 lines), but it regresses the
    individual songs the gates above name.

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
        return _clamped_v2(generated, repaired), frozenset()
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


def _clamped_v2(generated: Generated, repaired: set[int]) -> Generated:
    """The shipped default: v2's clamp, verbatim (`_clamped` without `ordered`; W1 measured the arm).

    Each repaired line is clipped to start no earlier than the line before it ends and, when the next
    line is trusted, to end by its start, then floored at `_REPAIRED_MIN_SEC` wide. It never refuses, so
    review M2's three shapes still publish backwards word starts (`test_repair_order` seeds 2, 6, 12 and
    30, strict xfail on this path): `decide` answers them with the LINE_SYNC rung, whose sheet gate
    published 16 of the 47 right texts W0's `run_align` lost that way and 0 of the 63 wrong ones (W1; since
    W3 the rung's timing gate is the text's own blind decode, `_time_line_sync`).
    """
    from encore_worker.domain.lyrics.generate import Generated, remapped  # noqa: PLC0415

    lines = list(generated.lines)
    out: list[Line] = []
    for position, line in enumerate(lines):
        if line.index in repaired:
            previous_end = out[position - 1].end if position else 0.0
            low = max(line.start, previous_end)
            high = line.end
            if position + 1 < len(lines) and lines[position + 1].index not in repaired:
                high = min(high, lines[position + 1].start)
            high = max(high, low + _REPAIRED_MIN_SEC)
            if abs(low - line.start) > 1e-9 or abs(high - line.end) > 1e-9:
                line = remapped(line, low, high)
        out.append(line)
    return Generated(lines=tuple(out), language=generated.language)


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
