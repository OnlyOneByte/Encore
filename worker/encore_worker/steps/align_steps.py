"""The real `AlignSteps`: the layer that touches the world and returns checkpointable records.

Each method resolves an adapter, calls a pure domain function, and returns data; the judgement stays in
`domain/`. A class rather than module functions because the adapters, the transport and the config are not
serialisable and so cannot be step ARGUMENTS (docs/arch/05-worker.md §8).

THE ENGINES AND THE REPAIR LADDER LIVE IN `_time_text_global`; the design and the thresholds' provenance are
docs/arch/04-alignment.md — §3 the engines, §4 repair, §5 the gates, §6 grading, §7 the claim clock, §12 the
invariants — with every number's reading in docs/benchmarks/forced-alignment/README.md.
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
from typing import TYPE_CHECKING, Any, Literal, Protocol

if TYPE_CHECKING:
    import numpy as np

    from encore_worker.domain.audio.activity import ShiftFit
    from encore_worker.domain.lyrics.generate import Generated, Line
    from encore_worker.domain.lyrics.reconcile import AsClaimed, OffSheet

from encore_worker.adapters import ports
from encore_worker.adapters.ports import InfraFault
from encore_worker.artifacts import keys
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics import (
    attribute,
    claimmap,
    ends,
    language,
    lexical,
    margin,
    measure,
    place,
    presplit,
)
from encore_worker.domain.lyrics.clean import clean_segments
from encore_worker.domain.lyrics.policy import Knob, Tier, normalised_words
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
    #: Lyrics providers IN PRIORITY ORDER: a multiplexer covers most songs, a direct provider covers the
    #: ones it does not, and a network that blocks one may reach the other. Every hit is a candidate — see
    #: `fetch_provider_lyrics`, which also says why a failure does not stop the chain.
    providers: tuple[ports.LyricsProvider, ...] = ()
    transcriber: ports.Transcriber | None = None
    #: Builds the transcriber for a job's `asrModel` when that is not the checkpoint `transcriber` was built
    #: with. Cheap: the adapter caches loaded weights per checkpoint. None on a box that builds only the one.
    transcriber_for: Callable[[str], ports.Transcriber | None] | None = None
    aligner: ports.Aligner | None = None
    diarizer: ports.Diarizer | None = None
    #: LATIN-SCRIPT language detection (lingua-py), built once at the composition root. None without the
    #: `text` extra, and the SCRIPT half needs no adapter at all (docs/arch/04-alignment.md §9).
    detector: language.Detector | None = None


class Reporter(Protocol):
    """What a step uses to talk to the core, narrowed so a step cannot send arbitrary frames. A Protocol, so
    `transport.Client` satisfies it structurally without inverting the layer order."""

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

    # ── the language (docs/arch/04-alignment.md §9) ──────────────────────────────────────────────

    def _detect(
        self, segments: Sequence[Segment], *, job: JobRef, heard: str | None = None
    ) -> language.Detected:
        """What language this acquired text is in — the value that goes on `TextRef.language`.

        In the ACQUIRING step rather than in the workflow or at alignment time, and checkpointed, so a resumed
        job aligns in the language it started in. `heard` is whisper's measurement and is passed only by
        `transcribe`, a sheet having no acoustic signal of its own (docs/arch/04-alignment.md §9).
        """
        texts = [str(segment.get("text") or "") for segment in segments]
        return language.detect(
            texts, declared=job.param_str("language"), heard=heard, detector=self._a.detector
        )

    async def _bundle_language(self, req: TimeRequest, *, on_mix: bool) -> str:
        """The language whose BUNDLE must produce these frames, noted when it is not the text's own.

        THE ONE READER OF THE ROUTING POLICY here, so no call site can forget `on_mix` — which must be a fact
        about the RESOLVED target, not about the knob. Everything else taking a language keeps the TEXT's.
        Async only because it NOTES (docs/arch/04-alignment.md §9).
        """
        route_latin = "lang-route-mix" in self._cfg.align_experiments
        bundle = language.model_language(req.language, on_mix=on_mix, route_latin=route_latin)
        note = language.routing_note(req.language, bundle, on_mix=on_mix)
        if note is not None:
            await self._out.state(req.job.job_id, "align-language", 0, "bundle", note, None)
        return bundle

    # ── acquisition ──────────────────────────────────────────────────────────────────────────────

    async def acquire_audio(self, job: JobRef) -> AudioRef:
        """The bytes and their duration. Raises when the source is unreachable — nothing substitutes.

        A LOCAL source is already on disk, decided from the DECLARED fetcher rather than by sniffing the URI.
        """
        local = job.param_str("fetcher") == "local"
        path = job.source_uri or ""
        if local:
            # A LOCAL source_uri is a STORE REF, not a path: it arrives relative to the media volume, and
            # only this worker knows where that volume is mounted. Handing the bare ref to ffmpeg resolves it
            # against the process CWD instead, and fails with nothing naming the media dir.
            if path and not os.path.isabs(path):
                path = os.path.join(job.media_dir, path)
            if not os.path.isfile(path):
                # Named explicitly: "the volume is mounted elsewhere" and "the file is gone" look identical
                # several stages later inside ffmpeg.
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

        CHECKED rather than assumed — a refused publish leaves the ref recorded and the file absent — and it
        FALLS BACK TO THE CONVENTIONAL KEY, core not sending `vocalsRef` on an align assignment. Every known
        extension is tried (docs/arch/05-worker.md §4).
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
            # A machine track is evidence of what is audible, never a claim about the words, so it wears the
            # MACHINE tier and can only publish once every candidate and ASR is spent.
            tier=Tier.MACHINE if automatic else Tier.CANDIDATE,
            label=f"captions:{'machine' if automatic else 'authored'}",
            segments=as_segments(cues),
            # LINE-TIMED EVEN WHEN THE CUES CARRY WORD CLAIMS, which is a decision rather than an oversight
            # (docs/arch/05-worker.md §6.1, rule 4). The provider path derives its label from the payload.
            timing=TIMING_LINE,
            # DETECTED FROM THE CUES. A track's own `lang` attribute names the TRACK, and YouTube's
            # machine-translated tracks are published under the TARGET language while carrying the source's
            # words — so the label would say `en` of a track whose text is Japanese.
            language=self._detect(cues, job=job).language,
        )

    async def fetch_provider_lyrics(self, job: JobRef, audio: AudioRef) -> list[TextRef]:
        """A lyrics sheet by metadata from EVERY provider that has one.

        Requires BOTH artist and track, a lookup on a guessed title returning another song's words. EVERY
        PROVIDER IS A CANDIDATE because two independent sheets agreeing is the strongest text-side signal
        there is, THE SAME SHEET TWICE IS ONE candidate (deduplicated on the NORMALISED words), and A PROVIDER
        THAT RAISES DOES NOT STOP THE CHAIN. What the pool is worth: README, the pool gate.
        """
        artist, track = job.param_str("artist"), job.param_str("track")
        if artist is None or track is None:
            return []

        failures: list[str] = []
        found: list[TextRef] = []
        seen: set[str] = set()
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
            words = normalised_words([str(cue.get("text") or "") for cue in cues])
            if words in seen:
                continue
            seen.add(words)
            found.append(
                TextRef(
                    tier=Tier.CANDIDATE,
                    label=_provider_label(provider),
                    segments=as_segments(cues),
                    timing=_timing_of(provider, cues),
                    # PER SHEET, not per job: two providers can answer one song with sheets in different
                    # languages (a translation is a common lrcmux upstream answer), and each must be timed by
                    # the bundle its OWN characters need.
                    language=self._detect(cues, job=job).language,
                )
            )

        if failures and len(failures) == len(self._a.providers):
            # A provider-side event rather than a fact about this song. Raising would fail the job and the
            # ASR tier can still serve it, so this is reported and the ladder continues.
            await self.note(job, "texts", 0, "providers-down", "; ".join(failures), None)
        return found

    async def fetch_pinned_text(self, job: JobRef) -> TextRef | None:
        """The ONE text a pinned job re-times: the paste, verbatim, or the stored candidate's own words.

        UNTIMED EITHER WAY, so the attempt is a blind decode through the normal global path — the stored
        candidate's line timings are what the person just rejected. It keeps its PROVENANCE, read back off the
        ref, and its WHOLE text; a paste is `manual`. `None` with a reason on the trail when it is gone.
        """
        pin = pin_of(job)
        if pin is None or pin.refused is not None:
            return None  # the workflow never asks then; restated so no call reads outside the store
        if pin.pasted is not None:
            lines = [line.strip() for line in pin.pasted.splitlines() if line.strip()]
            # `stored_language`, not `language`, which would shadow the imported module for this method.
            label, stored_language = _MANUAL_LABEL, None
            why = "the paste carries no line with words"
        else:
            lines, stored_language, why = _stored_lines(os.path.join(job.media_dir, pin.ref))
            label = _pinned_label(pin.ref, job.media_id)
        # TEXT HYGIENE APPLIES TO A PASTE TOO, with R3 off because a transcript copied off a video trips its
        # whole-text precondition (docs/arch/04-alignment.md §8).
        segments = clean_segments([{"text": line} for line in lines], author_marking=False)
        if not segments:
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
        if len(segments) < len(lines):
            # THE ONE PATH WHERE THE HYGIENE'S LOSS IS OTHERWISE INVISIBLE: a sheet's raw form is a re-fetch
            # away, but a PASTE exists only in this job. One note, count and rules named.
            await self.note(
                job,
                "texts",
                0,
                "pin-cleaned",
                f"pinned lyrics: {len(lines) - len(segments)} of {len(lines)} pasted lines are not words to "
                "sing (a section header, an ASR marker, a line whose only content was caption format) and "
                "are not published; the words a person typed are never dropped by this",
                None,
            )
        return TextRef(
            tier=tier_of_label(label),
            label=label,
            segments=segments,
            # THE STORED DOCUMENT'S OWN `language` WINS over detection: an earlier job detected it, possibly
            # with a detector this box does not have, and a pin must re-time exactly what the person chose,
            # the language it was read in included. A PASTE has none stored, so it is detected.
            language=stored_language or self._detect(segments, job=job).language,
        )

    async def transcribe(self, job: JobRef, audio: AudioRef, *, on_vocals: bool) -> TextRef | None:
        """The mandatory fallback tier. `None` means nothing intelligible was heard.

        `to_thread` is load-bearing: whisper is synchronous (docs/arch/05-worker.md §7). Transcribes with the
        JOB's `asrModel`, falling back to the default on the trail for a checkpoint this box may not load.
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
        heard = await asyncio.to_thread(transcriber.transcribe, target, language=job.param_str("language"))
        segments = heard.segments
        if not segments:
            # NOTHING INTELLIGIBLE ENDS THE TIER, but whisper detects the language BEFORE it decodes a word
            # and that is this worker's only measurement of it — so with no text to carry it, it goes on the
            # TRAIL (docs/arch/04-alignment.md §9).
            if heard.language is not None:
                await self.note(
                    job,
                    "asr-language",
                    0,
                    "heard-nothing",
                    f"whisper transcribed no words but heard the audio as {heard.language!r} — no text to "
                    f"carry it, so the ASR tier ends here; declare that language on the job to route it",
                    None,
                )
            return None
        # WHISPER'S OWN DETECTION, handed to `detect` as ONE signal rather than as the answer. Before
        # `presplit`, which changes no character (docs/arch/04-alignment.md §9).
        detected = self._detect(segments, job=job, heard=heard.language)
        if heard.language is not None and heard.language != detected.language:
            await self.note(
                job,
                "asr-language",
                0,
                "language",
                f"whisper heard {heard.language!r}; aligning as {detected.language!r} — {detected.why()}",
                None,
            )
        return TextRef(
            tier=Tier.ASR,
            label=f"asr:{'vocals' if on_vocals and audio.vocals_path else 'mix'}",
            # RE-LINEATED here, and only here: whisper emits ~30 s VAD blobs, so one segment is several
            # lyric lines run together. Split BEFORE alignment, so the aligner measures the lines that will
            # be shown — splitting after leaves the second half of every line highlighting early.
            segments=presplit.presplit_text(as_segments(segments)),
            # Word-timed AND measured on this audio, so it can be neither the wrong song nor misplaced,
            # which is why `Knob.RESHIFT` is meaningless for it (`TextRef.has_own_timings`).
            timing=TIMING_WORD,
            language=detected.language,
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

        `None` if nothing publishable resulted; `Refused` if a gate measured that the text does not describe
        this audio, which ends the text (XA-05). RAISES `InfraFault` and nothing else, the ADAPTER typing the
        fault and this step only letting it through (XA-17); an optional witness keeps its no-evidence answer,
        but not the LINE_SYNC gate, which under `syncMode=lines` is the only reader of the audio.
        THE GLOBAL DECODE IS THE PATH (docs/arch/04-alignment.md §3).
        """
        if self._a.aligner is None:
            # A box with no aligner never advertises `align`, so reaching here is a composition fault.
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
        bundle_language = await self._bundle_language(req, on_mix=req.audio.targets_mix(on_mix=req.on_mix))
        try:
            aligned = await asyncio.to_thread(self._a.aligner.align, spans, target, bundle_language)
        except InfraFault:
            raise  # the machinery, not this text: fails the job (XA-17)
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
            # the next's. Naming the lines is what makes the line-sync fallback debuggable from the trail.
            await self._out.state(
                req.job.job_id, "align-windowed", 0, "out-of-order", _backwards_why(doc), None
            )
        return self._write(req, doc, TIMING_WORD, "high", report=report)

    async def _time_line_sync(self, req: TimeRequest) -> TimedDoc | Refused | None:
        """The LINE_SYNC rung: the text's own line timings, placed on this clock — IF they describe it.

        A SHEET on a stem passes two gates: the WORDS, then — after the claim-clock vote — the TIMINGS, so a
        sheet refused for its words pays for neither decode nor vote. Two exits publish on less: the ASR tier
        on its own spans with no gate at all, and a sheet whose decode cannot be read on the sheet-span
        envelope alone, unvouched where the words went unlifted (XA-14). `None` rather than `Refused` when no
        gate could be MEASURED (XA-05; docs/arch/04-alignment.md §5.3, §5.1, §7, §5.4).
        """
        claimed = _sheet_spans(req.text.segments)
        if not claimed:
            await self._out.state(
                req.job.job_id, "align-line-sync", 0, "declined", "no line carries a timing to sync", None
            )
            return None
        if req.text.tier is Tier.ASR:
            # A TRANSCRIPT is not a sheet: its spans were measured on THIS recording, so neither thing this
            # gate detects can be true of it — and read as a sheet it FAILS (README, the rung's four
            # candidate rules).
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
        # THE BUNDLE FIRST on every branch that reports one (`_bundle_why`): this rung's two thresholds are
        # read off the matrix's own calibration row and no other clause names the model. Only where there IS a
        # matrix: an aligner with none read nothing off a bundle.
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
        # THE LEXICAL FLOOR OFF THE MATRIX'S OWN ROW: `evidence.bands` is None exactly when that model has no
        # row, in which case nothing in nats per letter may be read off it. The decode-agreement share below
        # is the one exception, being a count of lines (`lexical.line_sync_share`). Invariant XA-06.
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
        # The TIMING check, only now: its `generate` decode is another CTC pass over the whole text, and a
        # text the words' gate just refused must not pay for it.
        decoded: Generated | None = None
        undecoded = evidence.unlifted  # no matrix: the same reason nothing lifted
        if evidence.emissions is not None:
            texts = [str(segment.get("text") or "") for segment in req.text.segments]
            decoded, undecoded = await _line_sync_decode(texts, evidence.emissions, req.language)
        # THE CLAIM CLOCK, ON THE RUNG THAT PUBLISHES THE CLAIMS: the gate reads the decode against THE
        # MAPPED CLAIMS, a sheet 1.5 s off being one to move rather than to refuse. With no decode to vote
        # with, both fall back to the activity shift and the sheet-span envelope.
        clock = _line_sync_clock(fit, _claimed_starts(req.text.segments), decoded)
        placed, reordered, unheld = _in_claim_order(self._placed_by(req, fit, clock=clock))
        clock_note = "" if clock is None else f"; {clock.why}"
        if reordered:
            # A jittered or hand-typed sheet can stamp one line before the one ahead of it, and a line
            # document IS its claims, so `_in_claim_order` holds such a start at its predecessor's rather
            # than publish a highlight that jumps backwards.
            clock_note += f"; {reordered} claimed start(s) held at the line before them"
        if unheld:
            # ...but only a STRAY stamp. More than the cap, or a run of them, and the sheet's order cannot be
            # reconstructed: it goes on as it came, so `decide` drops it rather than the room being shown one
            # line's text over several lines' singing.
            clock_note += (
                f"; {unheld} claimed start(s) sit before a start already kept and were left alone: this "
                "sheet's order is not one stray stamp"
            )
        if decoded is None:
            agreed, unchecked = None, undecoded
        else:
            agreed, unchecked = _agreement_of(decoded, placed)
        # THE SHARE IS THIS MODEL'S, OR THE ONE EVERY CALIBRATED MODEL FITS: alone among calibration numbers
        # it is a fraction of lines within a tolerance in SECONDS, so a matrix with NO row is still gated on
        # it (docs/arch/04-alignment.md §5.3).
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
        # VOUCHED ONLY WHERE THE WORDS WERE READ. `heard is None` is not a pass: several reasons reach here
        # having checked the TIMINGS alone, and this rung's own hazard is a text whose timings are perfect and
        # whose words are someone else's. Invariant XA-14.
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
        with why it could not be read — plus the matrix itself, for the caller's timing check.

        A machinery fault raises; anything else is an unanswered question and the caller falls back to the
        sheet gate. COST: one emission pass plus four CTC decodes, and in forced mode the same matrix was
        computed a step earlier — a step cannot hand a tensor to the next one (docs/arch/04-alignment.md §15).
        """
        emitter = getattr(self._a.aligner, "emissions", None)
        if not callable(emitter):
            return _LineEvidence(None, "this aligner produces no emission matrix", None, None)
        texts = [str(segment.get("text") or "") for segment in req.text.segments]
        # ALWAYS THE DEFAULT BUNDLE (`on_mix=False`), every reading of this rung being the stem's, so the
        # calibrated share is the one its sweep fitted. THE LITERAL IS DELIBERATE and is NOT the
        # `targets_mix` question `_time_text_global` asks: this rung refuses to route at all.
        bundle_language = await self._bundle_language(req, on_mix=False)
        try:
            emissions = await asyncio.to_thread(
                emitter, req.audio.align_target(on_mix=False), bundle_language
            )
        except InfraFault:
            raise  # the machinery, not this text: fails the job (XA-17)
        except Exception as exc:  # noqa: BLE001 - an unanswered question, not a verdict on the text
            return _LineEvidence(None, f"it raised {type(exc).__name__}: {exc}", None, None)
        lifted, bands, unlifted = await _measured_lift(texts, emissions)
        return _LineEvidence(lifted, unlifted, bands, emissions)

    async def _word_lift(
        self, req: TimeRequest, line_texts: Sequence[str], emissions: Any
    ) -> tuple[lexical.Lift | None, lexical.Bands | None, str]:
        """The global engine's lexical check: `line_texts`' lift on the matrix this attempt decoded, the
        calibration row it is judged against, or None for both and why it did not run.

        EXEMPT: the ASR tier, and a text too short or too repetitive for the contrast to mean anything, each
        keeping the envelope gate instead. Machine captions are NOT exempt. COST: four CTC decodes on the
        matrix already in hand (docs/arch/04-alignment.md §5.1).
        """
        if req.text.tier is Tier.ASR:
            return None, None, "a transcript of this recording (its words were heard on this audio)"
        return await _measured_lift(line_texts, emissions)

    async def _time_text_global(self, req: TimeRequest) -> TimedDoc | Refused | None:
        """Generate our own timings from TEXT ALONE, then reconcile every other measurement INTO them.

        `None` is one ATTEMPT failing and never a switch of engine; `Refused` ends the text (XA-05).
        Disagreements are repaired IN PLACE by four rungs whose provenance GATES grading (XA-02, XA-03;
        docs/arch/04-alignment.md §4, §5, §6).
        """
        from encore_worker.adapters.ml import (  # noqa: PLC0415
            forced_align_decoder,
            load_audio_mono_16k,
            starred,
        )
        from encore_worker.domain.audio import activity  # noqa: PLC0415
        from encore_worker.domain.lyrics import parts  # noqa: PLC0415
        from encore_worker.domain.lyrics import reconcile as rc  # noqa: PLC0415
        from encore_worker.domain.lyrics.generate import (  # noqa: PLC0415
            adopted_line,
            alignable_chars,
            generate,
            regenerate,
            reopened_line,
            separator_named,
            separator_of,
            star_of,
        )

        aligner = self._a.aligner
        assert aligner is not None  # guarded by time_text; restated for the type checker
        # The two DECODE ARMS, both default-off, read ONCE here: each belongs to every decode that produces
        # THIS document and to none of the GATE decodes (XA-12; docs/arch/04-alignment.md §14, §14.1).
        separate_lines = "linesep" in self._cfg.align_experiments
        star_arm = "star" in self._cfg.align_experiments

        async def decline(why: str) -> None:
            # EVERY refusal is a trail note: a silent one is indistinguishable from the step never running.
            await self._out.state(req.job.job_id, "align-global", 0, "declined", why, None)

        target = req.audio.align_target(on_mix=req.on_mix)
        # WHICH FILE THIS IS, read BEFORE the emission pass because the BUNDLE depends on it: `req.on_mix` is
        # the retry KNOB, so the bundle, its trail note and the lexical bands all key off the RESOLVED file.
        # The mix is also the second witness, which R4 decodes.
        mix_target = req.audio.align_target(on_mix=True)
        on_target_mix = req.audio.targets_mix(on_mix=req.on_mix)
        target_name = "mix" if on_target_mix else "stem"
        line_texts = [str(segment.get("text") or "") for segment in req.text.segments]
        # THE EMISSION PASS AND THE DECODE ARE GUARDED SEPARATELY so the lexical gate can sit between them:
        # everything after it is work a refused text used to pay for first.
        bundle_language = await self._bundle_language(req, on_mix=on_target_mix)
        try:
            emissions = await asyncio.to_thread(aligner.emissions, target, bundle_language)  # type: ignore[attr-defined]
        except InfraFault:
            raise  # a model / kernel / device / audio fault fails the JOB, not this attempt (XA-17)
        except Exception as exc:  # noqa: BLE001 - the emission pass refused THIS file: one attempt failing
            await decline(f"decode failed: {type(exc).__name__}: {exc}")
            return None

        # ── AD-LIBS AND ECHO TAILS: the `adlibs` arm, default-off (docs/arch/04-alignment.md §8) ──
        # Taken ONCE on the served text, so every GLOBAL decode and the margin read get the same lead texts.
        # NOT the lexical gate's text and NOT a repair window's, and after the emission pass because R1's "a
        # lead is left to align" test has to be the DECODE's.
        adlibs = (
            parts.split(line_texts, emissions=emissions)
            if "adlibs" in self._cfg.align_experiments
            else parts.untouched(line_texts)
        )

        stem_target = target  # this attempt's own file, under the name the two witness reads below use

        # ── the lexical gate: are THESE WORDS what the target sings? (docs/arch/04-alignment.md §5.1) ──
        # FIRST, before this text's decode and before any audio is read: no repair makes unsung words sung.
        # The bands are the RESOLVED bundle's row, never `lexical.BANDS` by name (XA-06); `_word_lift` says
        # what is exempt.
        lifted, bands, unmeasured = await self._word_lift(req, line_texts, emissions)
        on_stem = target_name == "stem"
        # THE ROW THE LIFT WAS READ AGAINST, not a second lookup of the table: a matrix from a model with no
        # calibration row comes back with neither, so a `lifted` that is not None always brings its row and
        # every threshold below is read off THAT row. Invariant XA-06.
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
        # A SUB-FLOOR LIFT IS A VERDICT ON EITHER TARGET, the mix included, the envelope gate it replaced
        # there losing MORE right texts AND admitting wrong ones (README, "The stemless mode").
        # `h3-mix-floor` WINS WHEN BOTH ARM NAMES ARE SET, being the superset of `h3-mix-envelope`'s one
        # gate, so the pair measures what the stricter name promises.
        mix_both_gates = not on_stem and "h3-mix-floor" in self._cfg.align_experiments
        mix_envelope_only = (
            not on_stem and not mix_both_gates and "h3-mix-envelope" in self._cfg.align_experiments
        )
        mix_floor_gates = not on_stem and not mix_envelope_only
        refuses = lift_band is lexical.Band.REFUSE and (on_stem or mix_floor_gates)
        # Why nothing vouches for this pin's words: a wrong-text gate would have refused them, and a person
        # chose them.
        unvouched: str | None = None
        # ── AN UNCALIBRATED BUNDLE HAS NO WRONG-TEXT GATE, SO IT MAY NOT TIME WORDS ──────────────────
        # `bands is None` on a non-ASR text means THIS MATRIX's model has no calibration row, which a
        # non-Latin script reaches BY DEFAULT. DECLINED rather than `Refused`, which is the whole fix: nothing
        # here measured the text. A PIN publishes anyway, all-`low`; `h3-ungated-words` is the CONTROL.
        # Invariants XA-05, XA-06; docs/arch/04-alignment.md §5.4.
        ungated_words_arm = "h3-ungated-words" in self._cfg.align_experiments
        if bands is None and req.text.tier is not Tier.ASR and not ungated_words_arm:
            ungated = (
                f"no wrong-text gate can read this text: {unmeasured} — and the envelope gate it would fall "
                f"back to passed 189 of 380 of the bench's wrong texts, so this bundle may time LINES but "
                f"not WORDS"
            )
            if pin_of(req.job) is None:
                await decline(ungated)
                return None
            unvouched = ungated
            await self._out.state(
                req.job.job_id,
                "align-global",
                0,
                "pin-unvouched",
                f"{ungated} — a person chose this text, so it publishes anyway: every line graded low",
                None,
            )
        if refuses:
            assert lifted is not None  # `refuses` reads a band, which only a measured lift has
            why = (
                f"lexical gate refused: {lifted.why()}, below {floor} on the {target_name}: the audio does "
                "not sing these words, in this order or any other"
            )
            if pin_of(req.job) is None:
                await decline(why)
                # A VERDICT on the text: `Refused` ends it (invariant XA-05).
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
        # THE WORDS' AXIS IS NARROWER THAN THE GRADING ONE ON THE MIX, where `mix_ok_from` was fitted to how
        # AUDIBLE the words are and holds most correct sheets, so the FLOOR is the words' verdict there. An
        # UNMEASURED text is not vouched for either (XA-14; docs/arch/04-alignment.md §5.1; README, "The
        # stemless mode").
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
        # is reported and not gated — but it still DECIDES wherever the lift could not measure the text, and
        # on the mix under either `h3-mix-*` arm.
        envelope_gates = lifted is None or mix_envelope_only or mix_both_gates

        # ── THE STAR COLUMN: the `star` arm, default-off ──
        # ONE MATRIX, WIDENED ONCE, AFTER THE GATE, so each reader sees the matrix it was calibrated on
        # (XA-12; docs/arch/04-alignment.md §14.1).
        decode_matrix = await asyncio.to_thread(starred, emissions) if star_arm else emissions

        try:
            generated = await asyncio.to_thread(
                generate,
                adlibs.lead_texts,
                decode_matrix,
                decoder=forced_align_decoder,
                language=req.language,
                separate_lines=separate_lines,
                stars=star_arm,
            )
        except InfraFault:
            raise  # a model / kernel / device / audio fault fails the JOB, not this attempt (XA-17)
        except Exception as exc:  # noqa: BLE001 - the decode refused THIS text: one attempt failing
            await decline(f"decode failed: {type(exc).__name__}: {exc}")
            return None
        # Identity unless the `adlibs` arm took something out, and then every published word goes back in its
        # own line. Here and not later, so everything after this point reads the FULL document.
        generated = parts.restored(generated, adlibs, until=req.audio.duration_sec)
        if not generated.lines:
            await decline("no line in this text carries an alignable character")
            return None

        # NOT caught: the emission pass has just decoded this same file and no text changes it, so a read that
        # fails here fails every attempt alike (invariant XA-17).
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
        served = _claims_as_served(req.text.segments if req.text.has_own_timings else ())
        claimed, claim_windows, claim_ends_given = served.starts, served.windows, served.ends_given

        # Read at most once, and only when a claimed line's window is silent on the target (under
        # `m6-mix-spare`): an ffmpeg decode of the whole mix is not free.
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

        # ── never-sung drop + re-decode (docs/arch/04-alignment.md §4) ──
        # A line that is NOT in the audio does worse than fail: it consumes its neighbours' frames. Three
        # signals, ALL required. Two default-off arms SPARE a candidate instead of binning it, never at its
        # claim's own span, and an unclaimed line keeps the three-signal rule either way (README, "What
        # brings a SPARED line back").
        experiments = self._cfg.align_experiments
        # THE LEAD TEXTS, not the served ones (identity without the `adlibs` arm): the re-decode after a drop
        # and `_placement_margins` must both see the texts the decode above actually saw.
        line_texts_active = list(adlibs.lead_texts)
        dropped_never_sung: list[str] = []
        # index -> (the line as the target's decode placed it, the witness whose envelope hears its claim:
        # MIX for the mix's under `m6-mix-spare`, WINDOW for the target's own matrix under `m6-window-spare`).
        # Empty by default: every never-sung candidate is binned, as v2 binned it.
        spared: dict[int, tuple[Line, _Source]] = {}
        for _round in range(2):
            if len(generated.lines) < 4:
                break  # medians over a couple of lines grade nothing
            song_median_score = median(line.score for line in generated.lines)
            # A LINE THE DECODE NEVER PLACED IS NOT A CANDIDATE (empty without the `adlibs` arm): an ad-lib
            # restored into its host's gap has no placement of its own to ask about, and dropping it would not
            # stick, since `parts.restored` puts it back after the re-decode.
            interpolated = parts.unmeasured_lines(generated)
            never_sung = [
                line
                for line in generated.lines
                if line.index not in interpolated
                and line.score < song_median_score - _NEVER_SUNG_SCORE_GAP
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
                    decode_matrix,
                    decoder=forced_align_decoder,
                    language=req.language,
                    separate_lines=separate_lines,
                    stars=star_arm,
                )
            except InfraFault:
                raise  # the machinery, not this text (XA-17)
            except Exception as exc:  # noqa: BLE001 - the decode refused THIS text: one attempt failing
                await decline(f"re-decode after drop failed: {type(exc).__name__}: {exc}")
                return None
            generated = parts.restored(generated, adlibs, until=req.audio.duration_sec)
            if not generated.lines:
                await decline("every line graded never-sung; nothing left to publish")
                return None

        # Gate the BLIND series, once, before any repair: an unrelated sheet cannot be forced into the right
        # shape by the audio, so its blind envelope fit is what refuses. Re-gating the REPAIRED series
        # punished repairs that used MORE evidence, declining two songs whose timings were correct.
        blind_fit = fit = await asyncio.to_thread(fit_of, generated)
        # The blind decode itself, kept for `_clamped`: one monotone Viterbi over the whole song, so its lines
        # are in order between any two of their own neighbours — what a refused repair falls back to.
        blind_decode = generated
        #: Where the CLAIM-FREE decode put each line, and how long it took: the only span measured with no
        #: window around it, which is why the repair windows below are widened to hold it.
        blind_spans: dict[int, tuple[float, float]] = {
            line.index: (line.start, line.end) for line in blind_decode.lines
        }
        blind_spans.update({index: (line.start, line.end) for index, (line, _witness) in spared.items()})

        # ── HOW AMBIGUOUS EACH PLACEMENT WAS (`domain/lyrics/margin.py`; docs/arch/04-alignment.md §6) ──
        # Read on the BLIND decode's trellis and nowhere else (XA-02), here because the margins must describe
        # the decode whose texts `line_texts_active` are. OFF THE EVENT LOOP, being two Viterbi passes over
        # the whole matrix. THE FLOOR COMES OFF THIS BUNDLE'S CALIBRATION ROW (XA-06), so None ABSTAINS.
        margin_nats = lexical.margin_floor(lexical.calibration(emissions))
        #: NO MARGINS = NOT MEASURED, and grading then reads what it did before the rule existed.
        #: `_Placement.silence` says WHICH reason; an empty dict is not that answer.
        placement: _Placement
        if "conf-legacy" in experiments:
            placement = _Placement(silence="arm")
        elif margin_nats is None:
            placement = _Placement(silence="uncalibrated")
        elif unvouched is not None or doubted:
            # NOT PAID FOR A GRADE THAT IS ALREADY FIXED: `line_confidence` is unconditionally `low` for an
            # unvouched pin and for the lexical doubt band. The trail still says the rule was not read.
            placement = _Placement(silence="already-low")
        else:
            placement = await asyncio.to_thread(
                _placement_margins,
                decode_matrix,
                line_texts_active,
                separate_lines=separate_lines,
                stars=star_arm,
            )

        # ── THE CLAIM CLOCK (docs/arch/04-alignment.md §7) ──
        # ONE rebinding of `claimed` / `claim_windows`, before the first `reconcile`, so every consumer after
        # it asks about the instant the AUDIO has (XA-04). AFTER the never-sung rule, because the
        # decode-median candidate is measured on the BLIND DECODE and a never-sung line drags its
        # neighbours by seconds.
        claim_clock = claimmap.IDENTITY
        #: The claims' lag as the AUDIO measures it, kept past the vote: `adopt_where_unheard` reads it to
        #: decide whether a raw claim time is a measurement at all. None on a sheet too short to map.
        claim_lag: ShiftFit | None = None
        if claimed:
            # The claims' own lag, measured on the AUDIO: the one candidate independent of our decode. Its
            # correlation floor is weaker than `activity.MIN_CORRELATION` on purpose, buying only a place in
            # the vote; ANY claimed sheet still goes through `consensus`, so the trail gets a reason.
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
        # audio: the map's own offset is a fact about the claim, and it reaches the trail through
        # `claim_clock.why` in the verdict note below.
        claimed_as_given, windows_as_given = claimed, claim_windows
        if claim_clock.applied:
            claimed = claim_clock.starts(claimed_as_given)
            claim_windows = claim_clock.windows(windows_as_given)

        # THE BLIND VERDICT: our claim-free decode against the claims, before any repair, and the only one
        # GRADING reads (XA-03) — a line re-decoded inside its claim window lands on the claim by
        # construction, so a re-reconcile counts the claim agreeing with itself.
        blind_verdict = verdict = (
            rc.reconcile(generated.lines, claimed)
            if claimed
            else rc.Reconciliation(verdict=rc.NO_CLAIMS, why="text arrived untimed")
        )
        # `l1-blind-median` (default-off): the adoption test's reference is the BLIND decode's median rather
        # than the series as repaired so far (README, "The L1 arms").
        blind_median = median(line.score for line in blind_decode.lines)
        #: Seconds a DECODED end sits from its cue's own end, over the lines whose OPENINGS the blind decode
        #: agrees with (XA-03); None under `rc.MIN_FITTED_PAIRS` of them, which is what a displaced sheet has.
        #: The scale `skipped_opening` reads an end against: README, "W8a: the late half of the band".
        agreeing_end_gaps = [
            line.end - claim_windows[line.index][1]
            for line in blind_decode.lines
            if line.index in claim_ends_given
            and line.index in claim_windows
            and abs(line.start - claim_windows[line.index][0]) <= rc.AGREE_TOLERANCE_SEC
        ]
        end_bias = median(agreeing_end_gaps) if len(agreeing_end_gaps) >= rc.MIN_FITTED_PAIRS else None
        #: The envelope's lag for this sheet, or None when it could not READ the sheet at all (under
        #: `claimmap.MIN_ENVELOPE_CORRELATION`). `reconcile.off_sheet`'s second witness, read in the step.
        sheet_lag = (
            claim_lag.seconds
            if claim_lag is not None and claim_lag.correlation >= claimmap.MIN_ENVELOPE_CORRELATION
            else None
        )
        #: Does the AUDIO say this whole sheet is displaced, so none of its onsets is a measurement a repair
        #: may take? A CONVICTION, so abstention is not displacement and this is False under the floor.
        sheet_displaced = sheet_lag is not None and abs(sheet_lag) > rc.AGREE_TOLERANCE_SEC
        #: Does the audio ABSOLVE the sheet — the singing is where these cues put it? The two are not each
        #: other's negation, an unreadable envelope being neither, and that third state is why a GRADE and a
        #: REPAIR must read different ones of them: docs/arch/04-alignment.md §4 carries the truth table.
        sheet_settled = sheet_lag is not None and not sheet_displaced
        adoption_medians: list[str] = []
        #: Lines whose repair `adopt_where_unheard` dropped because the claim span could not hold them: the
        #: trail says so, since "no repair" and "no repair needed" read alike otherwise. Empty unless the
        #: default-off arm `m5-adopt-floor` is on.
        truncated: list[int] = []
        #: Lines `adopt_where_unheard` would have adopted, on a sheet the claim clock DECLINED to map and
        #: the blind decode relates nothing to. They keep the window re-decode's timing; the trail says so.
        unmapped: list[int] = []
        # Where each line's CURRENT timing came from; every stage below that replaces a line says so here.
        # Grading reads it (invariant XA-02), the `l1-mix-kept` arm reads it, and so does the trail.
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
        #: The spared lines a witness HEARD and put back. They never STEER the ladder (XA-02), so a spare
        #: moves only the lines it returns; letting them steer was measured and bought nothing.
        returned: set[int] = set()

        def steer(gen: Generated) -> rc.Reconciliation:
            return rc.reconcile([line for line in gen.lines if line.index not in returned], claimed)

        #: The window each claim-anchored re-decode ACTUALLY ran in, by line index. The edge tests read it
        #: rather than rebuilding it from the claim span, the two differing once a window is widened.
        repair_windows: dict[int, tuple[float, float]] = {}

        #: Every MAPPED claim onset, in time order: the ceiling `claim_run`'s hold-open may not widen past
        #: (the next one after the cue's own start). In TIME order rather than by line index, because a sheet
        #: may stamp its lines out of order and the question here is which cue comes next in the audio.
        claim_onsets = sorted(start for start, _end in claim_windows.values())

        #: The slot this sheet gives a typical cue: the MEDIAN gap between consecutive onsets, standing in for
        #: the missing next onset at the LAST cue. A median rather than the previous gap, so one instrumental
        #: break cannot hand the final line a minute nor one rapid-fire couplet cut it to nothing.
        typical_slot = (
            median(later - earlier for earlier, later in zip(claim_onsets, claim_onsets[1:], strict=False))
            if len(claim_onsets) > 1
            else 0.0
        )

        def claim_run(line: Line) -> tuple[tuple[Line, ...], tuple[float, float]]:
            """The run a claim-anchored stage (R1 / R2 / R4, the never-sung spare) re-decodes: this line
            alone, inside its MAPPED claim span held open to the END of the blind decode's span, then padded.

            THE END ONLY, only where the claim span cannot HOLD the line, and only where the blind decode
            STARTS inside the padded claim span — a window being an anchor, and a wider one anchoring less.
            And NEVER PAST THE NEXT CLAIM'S ONSET, nor past the sheet's own `typical_slot` for the last cue.
            Both caps and their exhibits: README, "The repair window's two caps, priced".
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
            """The seconds `text` takes at `regenerate`'s floor: two emission frames per alignable character.

            A FLOOR and not an expected duration, which is why `claim_run` bounds its hold-open with the next
            cue instead. `generate.alignable_chars` is imported rather than restated, and read with the
            MATRIX's blank (XA-10), so the two floors cannot be read off different texts.
            """
            return 2 * alignable_chars(text, emissions) * float(emissions.frame_sec)

        def holds(text: str, span: tuple[float, float]) -> bool:
            """Could `span` hold `text` at all? `needs`' floor asked of a span about to be PUBLISHED rather
            than decoded in: a span tighter than it is a truncated cue — the reader's defaulted end, an LRC's
            last line, a caption cue covering only the first phrase of a long line."""
            return bool(span[1] - span[0] >= needs(text))

        def edge_stuck(line: Line) -> bool:
            """Did this repaired line's decode collapse onto its window's LEFT EDGE — a forced path through
            emissions with nothing in them to find? The tolerance is `_ADOPT_EDGE_SEC`."""
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
                return False
            return got is not None and got >= _SPOKEN_RATIO * reference

        def opening_is_free(index: int, onset: float, pending: Mapping[int, Line]) -> bool:
            """Is `onset` clear of the line published before this one, as THIS BATCH will publish it?

            `_clamped_v2` resolves a repaired start against its predecessor's end by RESCALING the whole line,
            so re-opening onto occupied time pays with every measured word onset in it (XA-07,
            docs/arch/04-alignment.md §4). The end is read off `pending`, the batch being built: `generated`
            still carries the end this batch is about to replace (review r2-correctness-1). An index not in
            the document is NOT free — nothing can be checked against a line that is not there.
            """
            lines = generated.lines
            position = next((i for i, line in enumerate(lines) if line.index == index), None)
            if position is None:
                return False
            if position == 0:
                return True
            previous = lines[position - 1]
            return pending.get(previous.index, previous).end <= onset

        #: Re-openings refused for the SIZE of the move: a merged or mistimed cue whose onset is further back
        #: than the band this rule exists for. On the trail, "refused" and "never considered" reading alike.
        oversized: list[int] = []

        def skipped_opening(
            index: int, line: Line, claim: tuple[float, float], pending: Mapping[int, Line]
        ) -> bool:
            """Did this re-decode open past its claim while ENDING where this document's agreeing lines end?
            Then the two disagree about the line's OPENING alone, which is what a forced path does to a
            sustained leading vowel: it absorbs it into blank and keeps the rest.

            ONE-SIDED; it needs the envelope's ABSOLUTION, not the absence of its conviction; the move is
            capped at `_REOPEN_MAX_SEC`; and it may only re-open into free time. Each guard, the rejected
            witnesses and the per-song reach: README, "W8a: the late half of the band, and the end that
            witnesses it"; docs/arch/04-alignment.md §4 has the truth table."""
            if end_bias is None or not sheet_settled or index not in claim_ends_given:
                return False
            move = line.start - claim[0]
            if move > _REOPEN_MAX_SEC:
                oversized.append(index)
                return False
            return (
                rc.AGREE_TOLERANCE_SEC < move <= line.end - line.start
                and abs((line.end - claim[1]) - end_bias) <= rc.AGREE_TOLERANCE_SEC
                and opening_is_free(index, claim[0], pending)
            )

        async def redecode(
            stage: str, runs: list[tuple[tuple[Line, ...], tuple[float, float]]], *, matrix: object
        ) -> dict[int, Line]:
            # A window decode that RAISES keeps its originals and SAYS SO on the trail
            # (docs/arch/04-alignment.md §4). `matrix` is KEYWORD-ONLY and undefaulted, so every stage names
            # the evidence it decodes — R4 alone decodes the MIX. An `InfraFault` there is the KERNEL's, and
            # `regenerate` is pure, so the decoder notes one and it is raised here (XA-17).
            faults: list[str] = []
            machinery: list[InfraFault] = []

            def decoder(
                log_probs: object, targets: Sequence[int], blank: int = 0
            ) -> tuple[list[int], list[float]]:
                # `blank` is FORWARDED, not defaulted away: `regenerate` reads it off the matrix it slices, so
                # a repair decode uses the same blank column the global decode did (invariant XA-10).
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
                # The arm belongs to every decode that produces a PUBLISHED timing, repairs included: a window
                # re-decoded without the separator the global decode used would put a repaired line on a
                # different token stream from the lines around it.
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
        #: Lines whose re-decode opened past its claim over singing, so only the opening moved back.
        reopened_all: set[int] = set()

        def record(stage: _Source, repaired: Mapping[int, Line], adopted: Collection[int] = ()) -> None:
            repaired_all.update(repaired)
            for index in repaired:
                provenance[index] = _Source.ADOPTED if index in adopted else stage

        def adopt_where_unheard(
            stage: str, repaired: dict[int, Line]
        ) -> tuple[dict[int, Line], set[int], set[int]]:
            """What a claim-anchored re-decode may publish: its own span, the claim's wholesale, or its own
            span RE-OPENED at the claim (docs/arch/04-alignment.md §4).
            """
            # A window decode that cannot HEAR the line sticks to the window's LEFT EDGE or scores far below
            # the song's median, and either way a human's claim beats it; `m5-adopt-floor` (default OFF)
            # refuses that unless the claim span can HOLD the line. NOT ON A SHEET THE AUDIO SAYS IS SECONDS
            # OFF AND THE CLOCK DECLINED TO MOVE, the displacement being read off the AUDIO and only where the
            # BLIND decode relates nothing (docs/arch/04-alignment.md §4, §7).
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
            reopened: set[int] = set()
            for index, fixed in repaired.items():
                window = claim_windows.get(index)
                if window is None:
                    continue
                flat = fixed.score < reference - _ADOPT_SCORE_GAP
                unheard = edge_stuck(fixed) or flat
                # A decode that DID hear the line but opened past its claim over singing keeps every word it
                # measured and only its opening boundary moves — the cheaper half of the same surrender, and
                # the one an adoption cannot make (`generate.reopened_line`).
                # BEHIND `band-reopen`, default off: on a sheet whose timings are noisy rather than displaced
                # the claim it re-opens onto can itself be 0.8 s wrong (docs/arch/04-alignment.md §14).
                late = (
                    not unheard
                    and "band-reopen" in experiments
                    and skipped_opening(index, fixed, window, out)
                )
                if not (unheard or late):
                    continue
                if off_clock:
                    # The re-decode's timing stays, whatever it heard: it is at least measured on THIS
                    # audio, where the claim is a stamp from a clock we have evidence does not fit it.
                    unmapped.append(index)
                    continue
                if late:
                    opened = reopened_line(fixed, window[0])
                    if opened is not None:
                        out[index] = opened
                        reopened.add(index)
                    continue
                if "m5-adopt-floor" in experiments and not holds(fixed.text, window):
                    out.pop(index)
                    truncated.append(index)
                    continue
                claim_span = adopted_line(fixed.text, index, window[0], window[1])
                if claim_span is not None:
                    out[index] = claim_span
                    adopted.add(index)
            return out, adopted, reopened

        def mix_kept(index: int) -> bool:
            """`l1-mix-kept`: is this a line R4 timed on the MIX, which R1 / R2 then leave alone? Their decode
            is the stem's, where R4 found nothing to hear. Default: they may re-decode it. The exhibit is in
            docs/benchmarks/forced-alignment/README.md, "The adoption guard's exhibit"."""
            return "l1-mix-kept" in experiments and provenance.get(index) == _Source.MIX

        # REPAIR ORDER: evidence-first, then reconcile-driven (docs/arch/04-alignment.md §4). R3 and R4 need
        # no reconcile verdict, so running them first lets the verdict PROMOTE when they succeed.

        # ── R3: blind repeats, anchored between unique neighbours. With no claim to say WHICH chorus an
        # occurrence is, the unique lines around a repeated block are the best anchors available, so the block
        # is re-decoded jointly in the gap between them, constraining the misbinding to that gap.
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

        # ── `m6-window-spare` (default OFF): a never-sung candidate whose claim window the TARGET sounds in
        # is re-decoded there and comes back only if that decode HEARD it, never as the claim's own span.
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

        # ── R4: MIX AS A SECOND WITNESS, and under `m6-mix-spare` the home of a claimed line the stem is
        # silent in. Put back only if the mix HEARD it, its envelope being the band as much as a voice.
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
                        # THE MIX's bundle, the one place `lang-route-mix` can differ from the target's: R4's
                        # witness is the mix by definition, and routing was measured winning only there. Under
                        # the default this resolves to the target's bundle and the matrix is shared.
                        await self._bundle_language(req, on_mix=True),
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

        # ── R1: the humility repair. UNRELATED only says the two series disagree, and WHICH is wrong is
        # answered by the AUDIO; when the claims win they become the anchors. ON UNRELATED ALONE, never on
        # `rc.TOO_FEW_PAIRS`: this is the widest repair in the step and three disagreeing pairs are not
        # evidence of anything.
        if verdict.verdict == rc.UNRELATED and len(claim_windows) >= rc.MIN_PAIRS:
            # OFF THE EVENT LOOP like every other fit in this step: bounded-lag correlation makes it tens of
            # milliseconds on an hour-long recording, and that still stalls the keepalive the reaper reads.
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
                repaired, adopted_here, reopened_here = adopt_where_unheard(
                    "R1", await redecode("R1", runs, matrix=emissions)
                )
                reopened_all |= reopened_here
                if repaired:
                    record(_Source.WINDOW, repaired, adopted_here)
                    generated = _with_lines(generated, repaired)
                    verdict = steer(generated)
                    fit = await asyncio.to_thread(fit_of, generated)
                    repairs.append(
                        f"claims fit the audio better (r={claim_fit.correlation:.2f}); "
                        f"re-decoded {len(repaired)} of {len(runs)} lines inside their claim windows"
                    )

        # ── R2: the lines the claims genuinely contradict, which is where a repeat may be bound to the wrong
        # occurrence, so each is re-decoded inside its claim window. Grading still asks the BLIND verdict
        # (XA-03). WHICH LINES is `Reconciliation.disputed`'s to say; a line R4 heard on the mix reads as
        # disputed, so R2's stem decode would adopt the claim over it unless `l1-mix-kept` keeps it.
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
                repaired, adopted_here, reopened_here = adopt_where_unheard(
                    "R2", await redecode("R2", [claim_run(line) for line in disputed_lines], matrix=emissions)
                )
                reopened_all |= reopened_here
                if repaired:
                    record(_Source.WINDOW, repaired, adopted_here)
                    generated = _with_lines(generated, repaired)
                    verdict = steer(generated)
                    fit = await asyncio.to_thread(fit_of, generated)
                    repairs.append(
                        f"re-decoded {len(repaired)} of {len(disputed_lines)} disputed lines "
                        "inside their claim windows"
                    )

        # A repair may not introduce what the policy punishes: spans clipped to neighbours. Under the
        # `m2-order-clamp` arm a repair that cannot be fitted between its trusted neighbours IN ORDER is
        # refused instead, its run back on the blind decode. Invariant XA-07.
        reverted: frozenset[int] = frozenset()
        #: Which TRUSTED lines' ends the clamp pulled back onto a repair, and by how much: the one published
        #: timing this worker changes on a line no stage repaired, so it goes on the trail (`_pulls_why`).
        pulled_ends: dict[int, float] = {}
        if repaired_all:
            generated, reverted, pulled_ends = _clamped(
                generated,
                repaired_all,
                blind=blind_decode,
                frame_sec=emissions.frame_sec,
                ordered="m2-order-clamp" in experiments,
            )
        if pulled_ends:
            repairs.append(_pulls_why(pulled_ends))
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
            # Spared, but no witness HEARD it — its decode stuck at the window's edge, the witness hears no
            # speech there, or no witness could run at all — so it goes where the never-sung rule sent it.
            repairs.append(
                "dropped never-sung after all, no witness heard them: "
                + ", ".join(f"[{i}] {spared[i][0].text[:40]!r}" for i in unplaced)
            )

        #: Of each re-opened line, did the CLAMP leave its published start on the claim's onset? The clamp
        #: resolves a re-opened start against the previous line's end by rescaling the line, so "re-opened"
        #: and "published where it was re-opened to" are two different claims (XA-07).
        claim_onsets_published = {
            line.index: line.index in claim_windows and abs(line.start - claim_windows[line.index][0]) <= 1e-9
            for line in generated.lines
            if line.index in reopened_all
        }
        if reopened_all:
            # NAMES THE READING THAT ACTUALLY FIRED: the cue's own written END against `end_bias`, never the
            # lead, both lead witnesses having been measured and refused (docs/arch/04-alignment.md §4).
            #
            # THREE OUTCOMES, NAMED APART (review r2-correctness-6): published at the claim, re-fitted by the
            # clamp, or never published at all — a run `m2-order-clamp` reverted has its BLIND timing back, so
            # calling it re-fitted says words were rescaled when the re-opening did not happen.
            kept = sorted(index for index in reopened_all if claim_onsets_published.get(index))
            withdrawn = sorted(
                index for index in reopened_all if index in reverted or index not in published_now
            )
            refitted = sorted(set(reopened_all) - set(kept) - set(withdrawn))
            repairs.append(
                f"re-opened {len(reopened_all)} repaired line(s) at their claim's onset, the decode having "
                f"started more than {rc.AGREE_TOLERANCE_SEC}s past it while ENDING within that of where this "
                f"document's agreeing lines end: " + ", ".join(f"[{i}]" for i in sorted(reopened_all))
            )
            if kept:
                # EVERY WORD AFTER THE FIRST: the first word's onset is the cue's, marked `CUE_OPENED` and
                # scored 0.0, so claiming every word's measurement was kept overstated it by one word.
                repairs.append(
                    "re-opened lines publishing their claim's onset, every word after the first keeping its "
                    "own measurement: " + ", ".join(f"[{i}]" for i in kept)
                )
            if refitted:
                # The clamp resolves a re-opened start against the previous line's end by rescaling the whole
                # line (`remapped`), so on these the words' onsets are NOT the ones the decode measured.
                repairs.append(
                    "re-opened lines the clamp then re-fitted, so their words were rescaled off their own "
                    "measurements: " + ", ".join(f"[{i}]" for i in refitted)
                )
            if withdrawn:
                repairs.append(
                    "re-opened lines that did not publish their repair at all, so the re-opening is not in "
                    "the document: " + ", ".join(f"[{i}]" for i in withdrawn)
                )
        if oversized:
            repairs.append(
                f"refused to re-open {len(set(oversized))} line(s) whose claim onset is further back than "
                f"{_REOPEN_MAX_SEC}s, the band this rule exists for: "
                + ", ".join(f"[{i}]" for i in sorted(set(oversized)))
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
            # The note an operator reading "why is this document seconds late" needs. THE DISPLACEMENT IS
            # PRINTED IN `ShiftFit`'s OWN SIGN, which every other reader of this fit uses, so a sheet stamped
            # 3 s LATE prints -3.00s; negating it here read the displacement backwards.
            repairs.append(
                f"did not adopt {len(set(unmapped))} claim timing(s): the audio puts the singing "
                f"{claim_lag.seconds:+.2f}s from these claims (r={claim_lag.correlation:.2f}) on a sheet "
                "the claim clock left on its own clock and the blind decode read as unrelated, so the "
                "window decode's own timing stands: " + ", ".join(f"[{i}]" for i in sorted(set(unmapped)))
            )

        # ── the ENVELOPE gate, on the REPAIRED series: do these timings describe the actual singing? ──
        # THREE TIERS, timings measured ON this audio having to fit at zero lag, and EITHER FIT PASSES. ON A
        # STEM THE LEXICAL LIFT REPLACES IT wherever it measured the text; NOT FOR A PIN, which a person
        # already answered for — such a pin PUBLISHES, every line `low` (docs/arch/04-alignment.md §5.2;
        # README, "The envelope gate's three tiers").
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
                # A VERDICT on the text, not a failed attempt: `Refused` ends it, where None would send it on
                # to LINE_SYNC — the wrong-text hole invariant XA-05 exists for.
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

        # ── grading, on the BLIND verdict (XA-02, XA-03; docs/arch/04-alignment.md §6).
        # Only the blind decode is independent of the claims, so a line whose timing a stage replaced is
        # `high` only where the blind decode corroborated its claim AND the repair kept that position.
        corroborated = {j.index for j in blind_verdict.lines if j.corroborated}
        disputed = {j.index for j in blind_verdict.lines if not j.corroborated}
        published = {line.index: line for line in generated.lines}

        # UNRELATED means the claims disagree with our decode line-for-line and WHICH side is right is
        # unresolved, so no line here can honestly claim `high`. `rc.DISAGREE` rather than UNRELATED alone,
        # grading being where an unresolved disagreement belongs; what it must not arm is R1, which MOVES
        # timings.
        claims_disagree = bool(claimed) and blind_verdict.verdict in rc.DISAGREE

        # THE COHERENCE CHECK, on the document ABOUT TO PUBLISH against the claims AS SERVED and the activity
        # envelope — its own two witnesses, no truth (docs/arch/04-alignment.md §6.1). `reconcile` fits the
        # claims' common offset out before judging a line, so a uniformly shifted document corroborates line
        # for line and grades `high`; this is the one reading that removes nothing. A DEMOTION only.
        sheet_reading = rc.as_claimed(generated.lines, claimed_as_given, tolerance_sec=rc.AGREE_TOLERANCE_SEC)
        sheet_coherent = rc.off_sheet(
            sheet_reading,
            # THE MAP'S OWN DISPLACEMENT, so the rule can say whether the claims witness anything or merely
            # restate it: a document that published on the MAPPED sheet sits exactly this far from the sheet
            # as served, whatever the audio says (review r2-spec-7, docs/arch/04-alignment.md §6.1).
            clock_lag_sec=(
                median(claim_clock.at(start) - start for start in claimed_as_given.values())
                if claim_clock.applied and claimed_as_given
                else 0.0
            ),
            # The envelope's own floor, spelled as `claimmap.consensus` spells it: under it the fit buys no
            # vote anywhere, and here it abstains rather than demoting on a reading nobody trusts.
            envelope_lag_sec=(
                claim_lag.seconds
                if claim_lag is not None and claim_lag.correlation >= claimmap.MIN_ENVELOPE_CORRELATION
                else None
            ),
        )
        # READ ALWAYS, DEMOTES ONLY BEHIND `band-off-sheet` (default off): the corpus sweep measured one FALSE
        # POSITIVE this conjunction cannot tell from its true one, so the reading goes on the trail and the
        # grade does not move. Which song, which mode and the price of flipping it on: README, "W8a: what the
        # corpus said about the two band components"; docs/arch/04-alignment.md §14.
        off_sheet = sheet_coherent if "band-off-sheet" in experiments else None

        # THE PLACEMENT-AMBIGUITY DEMOTION (`margin.low_lines`), a DEMOTION only, with THE WHOLE RULE as its
        # control — which is why "no margins" is the one spelling of "do not read the rule". THE NEAR-REPEAT
        # HALF IS NOT GATED ON THE MARGIN'S ABSTENTION, having no emission scale; what stands it down is the
        # control and an already-`low` document, both on the trail.
        repeats_arm = "conf-fuzzy-repeats" in experiments and placement.silence not in (
            "arm",
            "already-low",
        )
        #: NOT `repeats` — that name is R3's EXACT-repeat set above, which `line_confidence` reads for a
        #: different grade entirely. These are the near-but-not-exact ones the arm adds.
        near_repeats = (
            margin.fuzzy_repeats(dict(enumerate(line_texts_active))) if repeats_arm else frozenset()
        )
        ambiguous = (
            frozenset()
            if placement.margins is None or margin_nats is None
            else margin.low_lines(
                placement.margins,
                {line.index: line.score for line in blind_decode.lines},
                min_margin_nats=margin_nats,
            )
        ) | near_repeats

        #: Lines NO word of which any decode placed: an `adlibs` echo tail no repair re-decoded, and every
        #: claim-ADOPTED line. Read off the FINAL document, so a line the ladder re-timed is not in it.
        interpolated_lines = parts.unmeasured_lines(generated)

        def line_confidence(index: int) -> str:
            if unvouched is not None:
                return "low"  # a pin a wrong-text gate would have refused: nothing vouches for any line
            if doubted:
                # The lexical doubt band of this bundle's own calibration row: the words may not be the sung
                # ones.
                return "low"
            if off_sheet is not None:
                # The whole document is coherently off the sheet it was given and the audio sides with the
                # sheet, so no line of it can be trusted to the word — whatever any per-line witness says.
                return "low"
            if index in interpolated_lines:
                # This line's words were held OUT of the lead decode and apportioned across the gap its host
                # left: derived from a measurement rather than being one, so the TV renders it line-level with
                # no word wipe. A DEMOTION only, so `high_gross` cannot rise.
                return "low"
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
                # R3 re-decoded it between unique anchors WITHOUT the claims, so landing on its claim is two
                # witnesses agreeing. Blind corroboration is absent here by construction, R3 taking exactly
                # the repeats the blind verdict did NOT corroborate.
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
            # ── HERE AND NOWHERE ELSE: the only grade that rests on OUR DECODE ALONE. The margin is the
            # decode's own opinion of itself, so charging a CORROBORATED line for it double-counts the
            # uncertainty a second witness just settled — measured, it cost word wipes and found nothing.
            # `conf-legacy` is the control.
            if index in ambiguous:
                return "low"
            # THE AT-CHANCE RULE, KEPT AS A CONJUNCT: on its own it separates nothing, but it is a DEMOTION
            # and dropping it can only PROMOTE lines, the one direction the reject-if forbids taking on faith.
            # Nearly unreachable, and kept for the lines R3's anchoring cannot cover.
            return "low" if index in repeats else "high"

        # ── word ENDS, held through the singing (`domain/lyrics/ends.py`; docs/arch/04-alignment.md §10) ──
        # Walked forward while the target's envelope still calls it singing, and STARTS NEVER MOVE (XA-01).
        # ON A STEM ONLY, `ends.ACTIVE_LEVEL` being no test at all on a mix. HERE AND NOT INSIDE `generate`,
        # which is why it is a post-pass: the gate above, the never-sung rule, the blind envelope fit and R4
        # all read `Line.end`. `ends-raw` is the CONTROL.
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

        # NO residual is fed to `measure`: reconcile's fitted offset describes THE CLAIM, so a residual would
        # let `decide` offer RESHIFT, a knob this engine never used. `claims_related` IS fed, and off THE LAST
        # RECONCILE, NOT THE BLIND ONE — the opposite choice from grading's, this asking whether the document
        # ABOUT TO PUBLISH tells the sheet's story. UNRELATED alone (README, "`claims_related`").
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
            # EXPECTED on the default clamp, which still publishes backwards word starts on the shapes
            # `test_repair_order` pins; the `m2-order-clamp` arm refuses any repair it cannot order. It goes
            # on the trail WITH its lines, a count alone not saying which (XA-07, XA-08).
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
            # A document whose every line is off its sheet by one coherent lag is a TIMING failure, which is
            # this axis (XA-14) — not a doubt about the words, which is `vouched`'s.
            if unvouched is not None or off_sheet is not None
            else "medium"
            if doubted
            else "high"
            if graded_high >= 0.7 * len(generated.lines)
            else "medium"
        )
        # `vouched` is the WORDS' axis and `confidence` the TIMINGS' (XA-14), so core can rank a doubt-band
        # document under a text a wrong-text gate passed — which `confidence` alone cannot say.
        timed = self._write(
            req,
            doc,
            TIMING_WORD,
            confidence,
            report=report,
            vouched=words_measured and not (words_doubted or unvouched is not None),
        )
        # The EVIDENCE on the trail, not just the verdict: this is what makes a wrong-lyrics report debuggable
        # from the audit page. Awaited, since fire-and-forget would drop it on a closed socket.
        await self._out.state(
            req.job.job_id,
            "align-global",
            0,
            # The BLIND verdict: the one grading read. The ladder's last re-reconcile follows it, labelled as
            # what it is, so a verdict the repairs MOVED stays legible.
            blind_verdict.verdict,
            # FIRST, because every threshold in this note is read off THIS bundle's calibration row and a
            # reader comparing two jobs needs to know they are the same bundle before comparing anything else.
            f"{_bundle_why(emissions)}; "
            f"envelope r={blind_fit.correlation:.2f} (blind), r={fit.correlation:.2f} (repaired)"
            f"{'' if envelope_gates else ', not gating: the lift is'}; {lexical_note}; "
            f"{blind_verdict.why}; "
            # THE CLAIM CLOCK BESIDE THE VERDICT IT DECIDED, the verdict's own offset now being the RESIDUAL
            # left after the map. Printed whether or not it applied, "the map lost the vote" being an answer
            # a wrong-sync report needs just as much.
            + (f"{claim_clock.why}; " if claimed else "")
            # THE DISTANCE FROM THE SHEET THE VIEWER HOLDS, printed whether or not it demoted: every other
            # clause reads a residual with the claims' common offset already fitted out, so without this one
            # nothing on the trail of a coherently shifted document names how far it moved.
            + (
                f"{_sheet_why(sheet_reading, sheet_coherent, demoted=off_sheet is not None)}; "
                if claimed
                else ""
            )
            + (
                f"after repairs {verdict.verdict}, {verdict.agreement:.0%} of {verdict.pairs} lines agree "
                "(steers the repairs, never the grade); "
                if verdict is not blind_verdict
                else ""
            )
            + (f"{'; '.join(repairs)}; " if repairs else "")
            + f"{_sources_why(provenance, [line.index for line in generated.lines])}; "
            # WHY THE LINES ARE GRADED AS THEY ARE, beside the provenance: an "out of sync" report on a
            # document whose lines are all `low` is answered by the margins, and a document that publishes
            # `high` lines is only defensible with them printed.
            + f"{_margin_why(placement, ambiguous, len(generated.lines), floor=margin_nats)}; "
            # ONLY UNDER THE ARM, like the three clauses below: a clause saying "no near-repeat demotion" on
            # every production note would be noise. Under the arm it is MANDATORY — an arm that acted and an
            # arm that was stood down must not read alike.
            + (
                f"{_repeats_why(near_repeats, applied=repeats_arm, silence=placement.silence)}; "
                if "conf-fuzzy-repeats" in experiments
                else ""
            )
            # ONLY UNDER THE ARM: the default's token stream is what every other clause already describes.
            + (
                f"{_linesep_why(separator_of(emissions), named=separator_named(emissions))}; "
                if separate_lines
                else ""
            )
            # ONLY UNDER THE ARM — and under it ALWAYS, so an arm that acted and an arm that went inert on a
            # matrix with no star column cannot read alike.
            + (f"{_star_why(star_of(decode_matrix))}; " if star_arm else "")
            # ONLY UNDER THE ARM — and under it ALWAYS, including when neither rule fired: an arm that found
            # no ad-lib and an arm that was never set must not read alike.
            + (f"{adlibs.why()}; " if "adlibs" in experiments else "")
            # LAST of the evidence clauses because it is the last thing that touched a timing, and it is about
            # ENDS where every clause before it is about a line's placement.
            + f"{ends_note}; "
            + f"{graded_high}/{len(generated.lines)} lines high",
            None,
        )
        return timed

    @staticmethod
    def _aligned_line_starts(doc: dict[str, object]) -> tuple[float, ...]:
        """Each line's start, from its FIRST TIMED WORD — never the line's own `start` field, which some
        aligners copy through unchanged while moving the words inside it."""
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

        TWO REFERENCES, in order: the audio's own VOCAL ACTIVITY, independent of any alignment and so usable
        on a FIRST attempt, and the PREVIOUS ALIGNMENT's line starts on a reshift, which catches a per-line
        drift one global offset cannot (README, "The fix, and what it measured").
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

        The fit MOVES the sheet only when trustworthy over at least `place.MIN_PAIRS` timed lines. A `clock`
        REPLACES it: where a caller has VOTED on the claims' clock the vote is the whole decision, so a map
        the vote did not apply leaves the sheet where the text put it (docs/arch/04-alignment.md §7).
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

        PREFERS THE VOCALS STEM, where the measured residual is an order of magnitude smaller; `on_mix` is
        honoured. NEVER RAISES for PLACEMENT, where None reads as "leave the sheet where it was" — except as a
        GATE, the only reader of the audio under `syncMode=lines`, which lets an `InfraFault` through (XA-17).
        """
        try:
            from encore_worker.adapters.ml import load_audio_mono_16k  # noqa: PLC0415
            from encore_worker.domain.audio import activity  # noqa: PLC0415

            # ffmpeg-backed, so a MIX target fits too, where `read_wav_mono` reads only WAV/FLAC. As a GATE,
            # the stem whatever the attempt aligned on: the sheet gate is calibrated there.
            signal = load_audio_mono_16k(req.audio.align_target(on_mix=req.on_mix and not gate))
            return activity.fit_sheet_to_audio(signal, 16000, list(spans))
        except InfraFault:
            if gate:
                raise  # the machinery, not this text: fails the job (XA-17)
            return None
        except Exception:  # noqa: BLE001 - see the docstring: a failed fit is an unanswered question
            return None

    def _placed_spans(self, req: TimeRequest, placed: Sequence[Segment]) -> tuple[Segment, ...]:
        """What the aligner may search within; `DROP_WINDOWS` widens this to the whole segment.

        An UNTIMED text gets provisional spans first, whisperx cropping the audio per segment.
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

        THE KNOBS ARE IN THE REF, so a retry never overwrites the attempt it retried, and every attempt is
        staged in JOB SCRATCH for `publish` to place after its ownership check (XA-13). A document that lost
        lines carries the whole text, so a re-pick re-times them. `vouched=False` is a wrong-text gate's doubt
        about the WORDS (XA-14; docs/arch/04-alignment.md §11).
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
        """Attach a duet `part` to each line (`attribute`), REWRITING the published document on disk, which
        is the file the TV reads. Optional throughout (docs/arch/04-alignment.md §11.1)."""
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
            # The document is already published-shaped and correct without parts, and `json.dump` to a fresh
            # handle either replaces the file or leaves the previous bytes.
            return doc
        return doc

    # ── publication ──────────────────────────────────────────────────────────────────────────────

    async def publish(self, job: JobRef, doc: TimedDoc | None, *, placing: Sequence[TimedDoc] = ()) -> str:
        """THE GUARDED STEP. Re-asserts ownership before making anything visible — here and not only at
        reconnect (docs/arch/05-worker.md §7.1).

        The attempts are PLACED after the check, through a replace. An ordinary job places every document it
        wrote; a PINNED job only its accepted attempt, at the pinned ref (XA-13).
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
            # A PINNED re-time becomes visible HERE and only here: the accepted attempt moves from job
            # scratch to the ref core pinned, which its merge then overwrites in place.
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
        """Per-job scratch, under the media volume so a remote worker's temp lives with its outputs, keyed by
        the job id core keeps STABLE across requeues (docs/arch/05-worker.md §4)."""
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
    """Did the provider return WORD-level timings? LRCmux can, and so does an A2 LRC sheet.

    THE SEQUENCE TEST IS `measure._words`' ONE: `clean_segments` rewrites a word list as a TUPLE, so a
    `list`-only test could never be True. `str` and `bytes` are excluded.
    """
    return any(
        isinstance(c.get("words"), Sequence) and not isinstance(c.get("words"), (str, bytes)) and c["words"]
        for c in cues
    )


def _timing_of(provider: ports.LyricsProvider, cues: Sequence[Segment]) -> str | None:
    """What the returned text is timed to, read from the PAYLOAD rather than a provider's claim: a response
    tagged word-level whose lines carry no word spans is not word-level."""
    if _has_word_spans(cues):
        return TIMING_WORD
    if _has_timings(cues):
        return TIMING_LINE
    return None


def _provider_label(provider: ports.LyricsProvider) -> str:
    """The label reaching the decision trail: a multiplexer names its UPSTREAM when it has one, which is what
    makes a systematically bad source identifiable instead of anonymous."""
    upstream = getattr(provider, "last_source", None)
    return f"{provider.name}:{upstream}" if isinstance(upstream, str) and upstream else provider.name


# ── a pinned re-time ─────────────────────────────────────────────────────────────────────────────

#: A paste's label, and the one core's `LyricsTextSource` spells `manual` (`__main__._text_source_of`).
_MANUAL_LABEL = "manual"


#: A written document's top-level key for its TEXT, in full, when its `lines` do not carry all of it
#: (`_with_source_lines`). Not rendered: the TV's parser (`parseLyricsDoc`) reads `lines` alone.
_SOURCE_LINES = "sourceLines"


def _with_source_lines(doc: dict[str, object], segments: Sequence[Segment]) -> dict[str, object]:
    """`doc`, plus the text it was timed from (`_SOURCE_LINES`) when its lines lost some of it.

    The global engine's document holds only the lines it timed, so re-picking such a candidate re-timed a
    shorter text. Written only when something IS missing (docs/arch/04-alignment.md §11).
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

    Core ranks every job's candidates together and a REFUSED attempt writes nothing, so such a document kept
    its rank and went on showing. MATCHED ON THE WORDS, not the label alone, and a store that cannot be listed
    withdraws nothing. See docs/arch/04-alignment.md §11.
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

    Keeps only the WORDS, a re-time existing because the stored timings are not wanted: `_SOURCE_LINES` when
    the document carries one, else `lines[].text`.
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
    """The label a stored candidate was written under, read back off its ref — `_write`'s shape inverted,
    because a stored document carries no provenance of its own.

    `{media}-{label with ':' as '-'}{-knob…}-{timing}.json`: the timing and knob suffixes come off the end and
    the FIRST dash is the label's colon, a provider's upstream being able to contain dashes where the source
    cannot. Any other shape is `manual`.
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

    A COPY, so the scratch original survives a `publish` re-run on resume. A source that IS its target stays.
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
    """The envelope gate's three tiers: r >= 0.40 within ±0.5 s, r >= 0.25 within ±0.1 s, or r >= 0.60 at any
    lag, where the shape agrees and the lag is an offset. The reasoning is at the global engine's gate."""
    return (
        (fit.usable and abs(fit.seconds) <= 0.5)
        or (fit.correlation >= 0.25 and abs(fit.seconds) <= 0.1)
        or (fit.correlation >= 0.60)
    )


def _sheet_passes(fit: ShiftFit) -> bool:
    """The envelope gate for a SHEET's own claimed spans: tiers 1 and 3 of `_envelope_passes`, NOT tier 2 —
    zero lag is evidence only for timings MEASURED ON this audio (docs/arch/04-alignment.md §5.2)."""
    return (fit.usable and abs(fit.seconds) <= 0.5) or fit.correlation >= 0.60


def _timed_spans(segments: Sequence[Segment]) -> list[tuple[float, float]]:
    """The (start, end) of every segment with a positive-length claimed span — what an envelope fits."""
    return [(start, end) for start, end in measure.line_spans(list(segments)) if end > start]


#: Seconds within which a line of the text's own blind decode counts as agreeing with its MAPPED claim. TWO
#: BANDS IN ONE — the gate's and `_line_sync_clock`'s — so `line_gate.py --near` moves both. In SECONDS, which
#: no model makes mean something else, so it is not a per-model row (README, "The LINE_SYNC rung").
_LINE_SYNC_NEAR_SEC = 1.0

#: Share of a sheet's claimed lines that must DECODE before the decode may speak for it — one bar for both
#: readers of that decode, so a mixed-script track's Latin fragment cannot decide for forty Korean lines.
#: What this gate cannot see, and why the lag term that would was rejected: README, "The LINE_SYNC rung".
_LINE_SYNC_MIN_DECODED_SHARE = 0.5


@dataclass(frozen=True, slots=True)
class _LineEvidence:
    """What the stem's emission matrix says about a line-sync text (`AlignStepsImpl._line_sync_evidence`)."""

    #: The text's lexical lift, or None — and why (`unlifted`).
    lift: lexical.Lift | None
    unlifted: str
    #: The calibration row the matrix's model has, or None. NONE MEANS DIFFERENT THINGS to the rung's two
    #: thresholds: the nats-per-letter ones stand down while the SECONDS-based share is still gated, at
    #: `lexical.LINE_SYNC_SHARE_UNCALIBRATED` (XA-06).
    bands: lexical.Bands | None
    #: The matrix the lift was read on, for the DECODE check the caller runs only once the lexical verdict has
    #: passed: a text about to be refused must not pay for a decode. None when there was no matrix to read,
    #: and then `unlifted` says why nothing decoded either.
    emissions: Any


async def _line_sync_decode(
    texts: Sequence[str], emissions: Any, language: str
) -> tuple[Generated | None, str]:
    """`texts`' BLIND decode on `emissions`, off the event loop, or None and why it could not be read.

    A machinery fault raises (XA-17); anything else is an unanswered question whose reason starts `it raised`,
    which the bench scores as an ERROR row. The rung's SECOND witness, answering two questions off one decode.
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
        raise  # the machinery, not this text: fails the job (XA-17)
    except Exception as exc:  # noqa: BLE001 - an unanswered question, not a verdict on the text
        return None, f"it raised {type(exc).__name__}: {exc}"


def _agreement_of(decoded: Generated, placed: Sequence[Segment]) -> tuple[AsClaimed | None, str]:
    """`reconcile.as_claimed` of `placed`'s starts against `decoded`, or None and why it could not be read.

    `placed` is the sheet AS IT WILL PUBLISH, so the gate reads the timings the room would see.
    """
    from encore_worker.domain.lyrics import reconcile as rc  # noqa: PLC0415

    claims = _claimed_starts(placed)
    got = rc.as_claimed(decoded.lines, claims, tolerance_sec=_LINE_SYNC_NEAR_SEC)
    if got is None:
        return None, f"fewer than {rc.MIN_PAIRS} lines both decoded and claimed"
    # THE SHARE IS ONLY OF THE LINES THAT DECODED, so the denominator has to be most of the sheet before it
    # may speak for it. Below the share the sheet gate decides instead, reading the WHOLE sheet's spans
    # against the envelope. Inert on every case the bench has measured.
    if got.pairs < (bar := _enough_decoded(len(claims))):
        # WHICH OF `_enough_decoded`'s TWO BOUNDS BIT, because they refuse different sheets and a bare
        # "under 50%" on a decode that read every line of its sheet reads as a broken counter.
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

    ONE rule for both readers of that decode, because two bars let a thin sheet have the clock abstain while
    the gate was armed — and the gate then read the decode against SHIFTED claims, found them near, and
    published the sheet displaced with both witnesses agreeing on one misplacement. `claimmap`'s floor rather
    than `reconcile`'s, this being a reader that ACTS. Inert on everything measured.
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
    """THE LINE_SYNC RUNG'S CLAIM CLOCK: which clock this sheet is on, by the same vote the global engine
    takes — or None when there is no decode to vote with.

    Its own call because the rung PUBLISHES the claims, so THE TOLERANCE IS THIS RUNG'S and NOT PIECEWISE.
    None rather than `IDENTITY` with no vote to take, and the bar is LITERALLY the gate's own
    `_enough_decoded` call (docs/arch/04-alignment.md §7).
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
    """`segments` with every claimed timestamp on our clock (`ClaimMap.at`), so a claim that PUBLISHES and a
    repair window built from the same map move identically.

    Copies, never in place: a `TextRef` is checkpointed and a replay must not re-map mapped timings. The end
    is held at or after the start, as `ClaimMap.windows` does. THE MAP IS NOT WHAT THE HOLD DEFENDS AGAINST,
    `ClaimMap.at` being non-decreasing: only a cue that arrived REVERSED can fire it, which is a CAPTION
    track and not an LRC.
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


#: The most claimed starts `_in_claim_order` will hold before it leaves the sheet alone, as a share of its
#: timed lines and never fewer than one. Many of them is a sheet whose order nobody can reconstruct
#: (README, "A STRAY STAMP ONLY").
_MAX_HELD_SHARE = 0.05


def _in_claim_order(segments: Sequence[Segment]) -> tuple[tuple[Segment, ...], int, int]:
    """`segments` with a stray backwards claimed start held at the one before it: the segments, how many were
    held, and how many were left alone because holding them would have made things worse.

    HELD, NOT SORTED — a claim is evidence about ITS line. ONE STRAY STAMP ONLY, AND ONLY WHERE THE SHEET
    RECOVERS; otherwise `measure.out_of_order` reaches `decide` as before. IDEMPOTENT either way, and
    docs/arch/04-alignment.md §5.3 has why the end is held PAST the predecessor's.
    """
    starts: dict[int, float] = {}
    for position, segment in enumerate(segments):
        start = segment.get("start")
        if isinstance(start, (int, float)) and not isinstance(start, bool):
            starts[position] = float(start)

    order = list(starts)
    #: The claimed start of the line after each claimed line, by position: the ceiling a held line's stretch
    #: may not cross. A stray's successor is always a KEPT line, so this is the next line's own stamp.
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
                #: A STRETCH, not the floor itself: equalling it publishes a span byte-identical to the
                #: predecessor's, which core's `activeLineIndex` never returns.
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
    """`lexical.lift` of `texts` on `emissions`, off the event loop, THE ROW it must be judged against, and
    why it could not be measured.

    Shared by both lexical gates so they read the same number the same way. THE ROW TRAVELS WITH THE LIFT, a
    second lookup being able to answer differently; a row and a lift are TWO questions and only one is about
    the MODEL (XA-06, XA-17; docs/arch/04-alignment.md §5.1, §5.4).
    """
    from encore_worker.adapters.ml import forced_align_decoder  # noqa: PLC0415

    bands = lexical.calibration(emissions)
    if bands is None:
        return None, None, lexical.uncalibrated(str(getattr(emissions, "model", "") or ""))
    try:
        got = await asyncio.to_thread(partial(lexical.lift, decoder=forced_align_decoder), texts, emissions)
    except InfraFault:
        raise  # the machinery, not this text: fails the job (XA-17)
    except Exception as exc:  # noqa: BLE001 - an unanswered question, not a verdict on the text
        return None, bands, f"it raised {type(exc).__name__}: {exc}"
    if got is None:
        return None, bands, f"under {lexical.MIN_LETTERS} alignable letters, or no word order to contrast"
    return got, bands, ""


#: Seconds a sheet line may claim to be sung when its END is only the next line's START. Uncapped, an LRC's
#: spans tile the whole song and the expected envelope degenerates to one block any text can match.
_SHEET_SPAN_CAP_SEC = 5.0


def _sheet_spans(segments: Sequence[Segment]) -> list[tuple[float, float]]:
    """A sheet's claimed singing, in time order, for the LINE_SYNC gate's envelope fit.

    An end that coincides with the next line's start is capped at `_SHEET_SPAN_CAP_SEC`, being an onset of
    the NEXT line rather than a measurement of this one; a span with an end of its own keeps it.
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

    One implementation for both the `LINE_SYNC` knob and any other line fallback, the ORDER of the starts
    included, so no caller can publish a stray backwards claim by forgetting to normalise. Idempotent, and a
    sheet `_in_claim_order` REFUSES to normalise keeps its inversions on purpose.
    """
    ordered, _held, _unheld = _in_claim_order(segments)
    return {
        "language": language,
        "lines": [
            {"text": str(s.get("text") or ""), "start": s.get("start"), "end": s.get("end")} for s in ordered
        ],
    }


#: The never-sung rule's three thresholds, ALL required (the drop block in `_time_text_global`). ABSOLUTE on
#: a P95-normalised envelope, and INERT on the MIX — README, "The never-sung floor", has every reading.
_NEVER_SUNG_SCORE_GAP = 2.0
_NEVER_SUNG_ENV = 0.10
_NEVER_SUNG_RATE = 2.0

#: Fraction of the blind decode's own speech mass a SPARED never-sung line's claim window must carry before
#: the `m6-*` arms put it back, its decode not being stuck at the window's edge either. Neither the mix's
#: envelope nor the decode's score can answer this (README, "What brings a SPARED line back").
_SPOKEN_RATIO = 0.6

#: ...and only where the witness hears the voice AT ALL: a matrix whose median speech mass over the blind
#: decode's own lines is under this cannot vouch for one, the ratio above being a fraction of nothing there.
#: The two populations: docs/benchmarks/forced-alignment/README.md, "What brings a SPARED line back".
_SPOKEN_FLOOR = 0.06


def _speech_mass(matrix: Any, start: float, end: float) -> float | None:
    """Mean non-blank probability over `[start, end)`: how much the acoustic model hears SPEECH there, where
    an energy envelope hears anything loud. None for an empty span.

    THE BLANK COLUMN COMES FROM THE MATRIX (XA-10): a literal 0 would invert every spare this gates.
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


#: WHY the placement-ambiguity rule said nothing, one name per reason, because the reasons lead to DIFFERENT
#: next steps and all of them used to print one sentence: `arm`, `uncalibrated`, `already-low`, `fault` and
#: `unreadable`, each spelled out in `_margin_why`.
_MarginSilence = Literal["arm", "uncalibrated", "already-low", "fault", "unreadable"]


@dataclass(frozen=True, slots=True)
class _Placement:
    """What the placement-ambiguity rule read on this document — and when it read NOTHING, WHICH silence.

    `margins is None` IFF `silence is not None`: one answer in two halves, travelling together because a
    swallowed fault and the `conf-legacy` arm used to be byte-identical on the trail. `fault` names the
    exception TYPE for that reason.
    """

    #: Per-line max-marginal margins in nats, keyed by line index; None is NOT MEASURED (never "ambiguous").
    margins: dict[int, float] | None = None
    #: Which silence, when `margins` is None.
    silence: _MarginSilence | None = None
    #: The exception type's name when `silence` is `fault`, so the trail can name it without holding the
    #: exception alive beside a matrix and a Viterbi (the memory note in `_placement_margins`).
    fault: str | None = None


def _placement_margins(
    matrix: Any, line_texts: Sequence[str], *, separate_lines: bool = False, stars: bool = False
) -> _Placement:
    """How ambiguous each line's placement was on `matrix`, in nats (`domain.lyrics.margin`).

    THE SAME TARGETS THE DECODE RAN ON, so the margin describes the path that produced these timings: the
    texts must be the BLIND decode's and `matrix` the STARRED one under that arm (XA-12). NO MARGINS ON ANY
    FAULT, which is a DIFFERENT ANSWER FROM `{}` — that would still apply the rule's SCORE half — and EVERY
    fault, a wrong guess at numpy's exception reinstating the bug. `InfraFault` is re-raised, and the numpy
    conversion is here because `domain/` may not import torch (XA-15; docs/arch/04-alignment.md §6).
    """
    import numpy as np  # noqa: PLC0415 - the steps layer's lazy numpy, as `_time_text_global` reads it

    from encore_worker.domain.lyrics import margin  # noqa: PLC0415
    from encore_worker.domain.lyrics.generate import blank_of, char_targets  # noqa: PLC0415

    flat = char_targets(line_texts, matrix, separate_lines=separate_lines, stars=stars)
    if not flat.targets:
        return _Placement(silence="unreadable")
    try:
        got = margin.placement_margins(
            np.asarray(matrix.log_probs, dtype=np.float64),
            flat.targets,
            flat.first_char_target,
            blank=blank_of(matrix),
            frame_sec=float(matrix.frame_sec),
        )
    except InfraFault:
        raise
    except Exception as failed:  # noqa: BLE001 - every fault means "not measured"; see the docstring
        # MEMORY IS THE REAL ONE, the caller holding the whole matrix and a Viterbi beside these arrays. The
        # TYPE's name is kept and the exception is not, so no traceback holds that matrix alive.
        return _Placement(silence="fault", fault=type(failed).__name__)
    # `placement_margins` answers `{}` for a matrix it could not read at all, which is the same GRADE as a
    # fault — nothing measured, nothing to grade on — and a different REPORT: this matrix cannot be read,
    # rather than this run could not read it.
    return _Placement(margins=got) if got else _Placement(silence="unreadable")


def _margin_why(placement: _Placement, doubted: Collection[int], lines: int, *, floor: float | None) -> str:
    """The placement-margin clause of the trail note: the signal, its threshold, and what it doubts.

    `doubted` is what the RULE flags and not what published `low`, which is why the wording says "doubts".
    ONE SENTENCE PER SILENCE, FIVE OF THEM, because the reasons lead to different next steps and two used to
    be byte-identical; the `fault` one is a BUG REPORT, so it names the exception type. `floor` comes off this
    bundle's own calibration row. The trail names the RULE rather than a section number, an operator having no
    document to resolve a citation against (docs/arch/04-alignment.md §6).
    """
    silent = {
        "arm": (
            "placement margins: not read, `conf-legacy` asked for the grading that preceded the "
            "placement-margin rule"
        ),
        "uncalibrated": (
            "placement margins: not read, this alignment bundle has no calibrated margin floor "
            "(`lexical.Bands.margin_floor_nats`), so grading is as it was before the placement-margin rule"
        ),
        "already-low": (
            "placement margins: not read, every line of this document is graded low before the rule is "
            "reached, so no margin could change a grade"
        ),
        "fault": (
            f"placement margins: not measured, `{placement.fault}` inside the two Viterbi passes, so "
            "grading is as it was before the placement-margin rule"
        ),
        "unreadable": (
            "placement margins: not measured, these frames and targets carry no path to compare, so "
            "grading is as it was before the placement-margin rule"
        ),
    }
    margins = placement.margins
    if floor is None:
        # Narrowed for the numbers below, and the one silence that can be read off the floor alone.
        return silent["uncalibrated"]
    if not margins:
        return silent[placement.silence or "unreadable"]
    ordered = sorted(margins.values())
    tight = sum(1 for gap in ordered if gap < floor)
    return (
        f"placement margins over {len(ordered)} of {lines} lines: median "
        f"{median(ordered):.0f} nats, min {ordered[0]:.0f}, {tight} under "
        f"{floor:.0f} — {len(doubted)} doubted on ambiguity or a low score"
    )


def _repeats_why(repeats: Collection[int], *, applied: bool, silence: _MarginSilence | None) -> str:
    """The `conf-fuzzy-repeats` clause: whether the arm acted, and when it did not, why not — a run recorded
    under an arm's name having measured the DEFAULT path being worse than one that refused to start."""
    if applied:
        return f"near-repeat demotion (conf-fuzzy-repeats): {len(repeats)} line(s) flagged"
    because = {
        "arm": (
            "`conf-legacy` asked for the grading that preceded the placement-margin rule, which has no "
            "demotion to widen"
        ),
        "already-low": "every line of this document is graded low already",
    }.get(silence or "", "the placement-margin rule stood down")
    return f"near-repeat demotion (conf-fuzzy-repeats): requested, not applied — {because}"


#: A repaired line whose decode landed within this of the window's LEFT EDGE "heard nothing": a forced path
#: through flat emissions collapses leftward. Fitted where the errors clustered at exactly the pad width.
_ADOPT_EDGE_SEC = 0.08

#: How far below the song's own median line score a repaired line must sit to be called unheard. Scores
#: compare WITHIN a song only; the measured good/gross medians were -0.95 against -1.76.
_ADOPT_SCORE_GAP = 0.5

#: Seconds of slack added around a repair window before re-decoding inside it, a window cut exactly to the
#: claim clipping a note it started late on. Also the reach of `claim_run`'s hold-open: this close to the
#: claim span is the same line measured twice, further away is a second hypothesis.
_REPAIR_PAD_SEC = 1.0

#: The widest BACKWARD move a re-opening may make, seconds. The rule exists for the 0.5-2 s band, and 2 s is
#: where a gross line begins (the bench's own `GROSS_SEC`); `skipped_opening`'s other bound is the re-decode's
#: own duration, which a merged cue outruns without ever biting (review r2-correctness-3).
_REOPEN_MAX_SEC = 2.0

#: Window a cue with no end of its own is given, seconds: enough to ANCHOR a re-decode, never a reading.
_CLAIM_DEFAULT_END_SEC = 1.0


@dataclass(frozen=True, slots=True)
class _Claims:
    """The sheet AS SERVED, read off the segments by position: before any clock maps it onto ours."""

    starts: dict[int, float]
    #: One window per claimed line. A cue whose end is missing gets `_CLAIM_DEFAULT_END_SEC`; one whose end is
    #: at or before its start keeps its own zero length, which is what `ClaimMap.windows` preserves too.
    windows: dict[int, tuple[float, float]]
    #: Lines whose cue wrote a USABLE end of its own — after its start, so neither a defaulted end nor a
    #: zero-length or reversed one. Only such an end may be READ (`skipped_opening`, `end_bias`): README,
    #: "Caption cues: the two populations a duration floor separates"; review r2-correctness-4.
    ends_given: set[int]


def _claims_as_served(segments: Sequence[Segment]) -> _Claims:
    """The claimed onsets, windows and written ends of `segments`. Untimed or malformed rows are skipped."""
    starts: dict[int, float] = {}
    windows: dict[int, tuple[float, float]] = {}
    ends_given: set[int] = set()
    for index, segment in enumerate(segments):
        start, end = segment.get("start"), segment.get("end")
        if not isinstance(start, (int, float)) or isinstance(start, bool):
            continue
        first = float(start)
        written = float(end) if isinstance(end, (int, float)) and not isinstance(end, bool) else None
        starts[index] = first
        windows[index] = (first, max(first + _CLAIM_DEFAULT_END_SEC if written is None else written, first))
        if written is not None and written > first:
            ends_given.add(index)
    return _Claims(starts=starts, windows=windows, ends_given=ends_given)


class _Source(StrEnum):
    """Where a line's published timing came from: the repair ladder's per-line provenance (XA-02), carried
    because the stages are NOT equally independent of the claims and the timings alone cannot say."""

    #: The global decode's own line: no claim chose where it was decoded (the never-sung rule only picks
    #: which lines are decoded at all).
    BLIND = "blind"
    #: R3: re-decoded jointly between the unique lines around a repeated block. No claim is used, so where it
    #: lands is independent of them: `high` where that is on its claim, on the blind verdict's clock.
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


def _sheet_why(reading: AsClaimed | None, off: OffSheet | None, *, demoted: bool) -> str:
    """The trail's line for the coherence check: how far the published document sits from the sheet a viewer
    holds, whether both witnesses convicted it, and whether that was allowed to demote it.

    Printed on every claimed job, because "we checked and it is close" and "nobody checked" must not read
    alike — that silence is what let a document 0.86 s off its captions publish `high` for eight waves. The
    reading is AS CLAIMED: no offset removed, so this is the error a room would see. `demoted` is false
    whenever `band-off-sheet` is off, which is the default: the conviction is still reported."""
    from encore_worker.domain.lyrics import reconcile as rc  # noqa: PLC0415

    if reading is None:
        return f"against the sheet as served: fewer than {rc.MIN_PAIRS} paired lines, not read"
    if off is not None:
        verdict = "every line graded low" if demoted else "not demoted (band-off-sheet is off)"
        return f"against the sheet as served: {off.why()} — {verdict}"
    return (
        f"against the sheet as served: {reading.near:.0%} of {reading.pairs} lines within "
        f"{reading.tolerance_sec:.2f} s of their own claim (median lag {reading.offset_sec:+.2f} s, spread "
        f"{reading.spread_sec:.2f} s, {reading.together:.0%} of them carrying that lag), no coherent "
        "displacement both witnesses confirm"
    )


def _ends_why(
    before: Generated, after: Generated, experiments: frozenset[str], *, on_stem: bool = True
) -> str:
    """The trail's line for the word-end post-pass: how many ends moved, and by how much — a display change
    no metric on the report can show. It states the ARM and the TARGET, the two reasons ends look raw."""
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
    # decode than the same sentence on the default.
    arm = " tiling within each line (ends-tile)" if "ends-tile" in experiments else ""
    if not moved:
        return f"word ends: none of {words} extended{arm} (the envelope stops where the decode does)"
    return (
        f"word ends: held {len(moved)} of {words} through the singing{arm}, median "
        f"+{moved[len(moved) // 2] * 1000:.0f} ms, worst +{moved[-1]:.2f}s"
    )


def _pulls_why(pulls: Mapping[int, float]) -> str:
    """The trail's clause for the ends `_clamped_v2` pulled back onto a repair: how many, which, how far.

    THE ONE PUBLISHED TIMING THIS WORKER CHANGES ON A LINE NO STAGE REPAIRED, and nothing else says so —
    `provenance` is right not to move, so such a line still reports as the blind decode's. BY INDEX and capped
    at `_SOURCES_NAMED`, the measured pull count per pass being around a hundred.
    """
    if not pulls:
        return ""
    ordered = sorted(pulls)
    shown = " ".join(f"[{i}]" for i in ordered[:_SOURCES_NAMED])
    more = f" +{len(ordered) - _SOURCES_NAMED} more" if len(ordered) > _SOURCES_NAMED else ""
    return (
        f"pulled {len(ordered)} line end(s) back onto the repair that followed them, median "
        f"{median(pulls.values()):.2f}s of overrun removed (starts, order and grades unmoved): {shown}{more}"
    )


def _bundle_why(emissions: object) -> str:
    """The trail's clause naming the ALIGNMENT BUNDLE a document's word timings came off.

    NOTHING ELSE ON THE PRODUCTION RECORD NAMED IT, and two failures had no evidence without it: a bundle
    flipped between a job's attempts, and a "the timings got worse" report from a box nobody recorded one for.
    "unnamed" is not production — only an aligner older than the field, or a test's fake.
    """
    named = str(getattr(emissions, "model", "") or "")
    return f"bundle {named or 'unnamed'}"


def _linesep_why(separator: int | None, *, named: int | None) -> str:
    """The trail's clause for the line separator, printed only under the `linesep` arm.

    IT SAYS WHETHER THE ARM ACTUALLY DID ANYTHING, and WHICH OF THE TWO INERT CASES it was — they lead to
    opposite next steps (docs/arch/04-alignment.md §14.1). `named` is the unfiltered reading, so a collision
    names the column it collided with.
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


def _star_why(star: int | None) -> str:
    """The trail's clause for the star column, printed only under the `star` arm: whether it did anything,
    for `_linesep_why`'s reason. One inert case rather than two, no blank collision being possible."""
    if star is None:
        return "star: requested (star) but this matrix carries no star column, so the targets are default"
    from encore_worker.adapters.ml import STAR_PENALTY_NATS  # noqa: PLC0415 - the arm's own constant

    return f"star: one per line, id {star} = frame max − {STAR_PENALTY_NATS:g} nats, its frames blank (star)"


def _sources_why(provenance: Mapping[int, _Source], indexes: Sequence[int]) -> str:
    """The trail's per-line provenance for the published lines: how many each source timed, and which.

    Blind lines are only counted; every other source names its lines by input index.
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


#: Seconds a repaired line is widened to WHEN IT IS RE-FITTED, and not a floor on the PUBLISHED width: a
#: later `_pulled_end` can pull this line's end back, and the pull wins. What DOES bound the published width
#: is `_pulled_end`'s own rule, one decoder frame per letter (docs/arch/04-alignment.md §4).
_REPAIRED_MIN_SEC = 0.2


def _with_lines(generated: Generated, repaired: Mapping[int, Line]) -> Generated:
    """`generated` with repaired lines swapped in by index, and any it lacks INSERTED in index order —
    which is the never-sung rule's spared lines coming back."""
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
) -> tuple[Generated, frozenset[int], dict[int, float]]:
    """Repaired lines clipped to their neighbours; with `ordered`, fitted IN ORDER or refused to `blind`.

    Returns `(clamped, reverted, pulled)` — the refusals (the arm only) and `{index: seconds of overrun
    removed}` for each preceding line whose END the default pulled back, both being decisions no metric on
    the report can show. DEFAULT is `_clamped_v2`, which never refuses; `ordered` IS THE `m2-order-clamp` ARM
    (XA-07). README, "The order-clamp arm's own table", has what the arm bought and the gates it failed.
    """
    from encore_worker.domain.lyrics.generate import Generated  # noqa: PLC0415

    if not ordered:
        clamped, pulled = _clamped_v2(generated, repaired, frame_sec=frame_sec)
        return clamped, frozenset(), pulled
    lines = list(generated.lines)
    # A repaired index is a blind line, except a never-sung line spared back in, which has no
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
    # The arm moves no trusted end at all (it refuses the run instead), so it reports no pulls.
    return Generated(lines=tuple(out), language=generated.language), frozenset(reverted), {}


def _clamped_v2(
    generated: Generated, repaired: set[int], *, frame_sec: float
) -> tuple[Generated, dict[int, float]]:
    """The shipped default: the v2 clamp with a BOUNDED left floor (`_clamped` without `ordered`).

    `(clamped, {index: seconds of overrun removed})`, the second half naming every PRECEDING line whose end
    this pulled back — a published timing changed on a line the ladder did not repair. It never refuses, so a
    repair landing past its successor still publishes backwards word starts (XA-07;
    docs/arch/04-alignment.md §4; README, "The fix: resolve the overlap at the neighbour's END").
    """
    from encore_worker.domain.lyrics.generate import Generated, remapped  # noqa: PLC0415

    lines = list(generated.lines)
    out: list[Line] = []
    pulls: dict[int, float] = {}
    for position, line in enumerate(lines):
        if line.index in repaired:
            previous = out[position - 1] if position else None
            previous_end = previous.end if previous is not None else 0.0
            if previous is not None and previous_end > line.start:
                pulled = _pulled_end(previous, line.start, frame_sec=frame_sec)
                if pulled is not None:
                    out[position - 1] = pulled
                    pulls[previous.index] = previous_end - pulled.end
                    previous_end = pulled.end
            low = max(line.start, previous_end)
            high = line.end
            if position + 1 < len(lines) and lines[position + 1].index not in repaired:
                high = min(high, lines[position + 1].start)
            high = max(high, low + _REPAIRED_MIN_SEC)
            if abs(low - line.start) > 1e-9 or abs(high - line.end) > 1e-9:
                line = remapped(line, low, high)
        out.append(line)
    return Generated(lines=tuple(out), language=generated.language), pulls


def _pulled_end(line: Line, boundary: float, *, frame_sec: float) -> Line | None:
    """`line` ending at `boundary` instead of past it, or None where that would not be a decoded timing.

    The one end `_clamped_v2` moves, and the START never moves with it, so a PULLED LINE'S PROVENANCE AND
    GRADE DO NOT MOVE either — the trail owes the pull itself instead (`_pulls_why`). TWO REFUSALS, NEITHER A
    NEW THRESHOLD: one decoder frame per letter, and `trimmed`'s own None. `frame_sec` goes through to
    `trimmed` because the letter rule measures the WHOLE line (docs/arch/04-alignment.md §4; README, "The
    anchor walk").
    """
    from encore_worker.domain.lyrics.generate import trimmed  # noqa: PLC0415

    if boundary - line.start < max(1, sum(ch.isalpha() for ch in line.text)) * frame_sec:
        return None
    return trimmed(line, boundary, frame_sec=frame_sec)


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

    Lines are named `[i]` like the never-sung note, by INPUT index when `index_of` maps document positions to
    it (the global decode drops unalignable lines, so position and input row differ), and marked when a repair
    produced them — the first question an inversion raises.
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
