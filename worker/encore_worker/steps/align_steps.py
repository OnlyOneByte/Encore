"""The real `AlignSteps`: the layer that touches the world and returns checkpointable records.

Each method resolves an adapter, calls a pure domain function, and returns data; the judgement stays in
`domain/`. A class rather than module functions because the adapters, the transport and the config are not
serialisable and so cannot be step ARGUMENTS (docs/arch/05-worker.md §8).

THE ENGINES AND THE REPAIR LADDER LIVE IN `_time_text_global`, the helpers they read in six siblings,
`align_{text,lines,unsung,claims,notes,geometry}` (docs/arch/05-worker.md §1.1). The design and the
thresholds' provenance are docs/arch/04-alignment.md — §3 the engines, §4 repair, §5 the gates, §6 grading,
§7 the claim clock, §12 the invariants — with every number's reading in
docs/benchmarks/forced-alignment/README.md.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import Callable, Collection, Mapping, Sequence
from dataclasses import dataclass
from functools import partial
from statistics import median
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    import numpy as np

    from encore_worker.domain.audio.activity import ShiftFit
    from encore_worker.domain.lyrics.generate import Generated, Line

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
    romanize,
    units,
)
from encore_worker.domain.lyrics.clean import clean_segments
from encore_worker.domain.lyrics.policy import Knob, Tier, normalised_words
from encore_worker.domain.lyrics.report import Engine, TimingReport
from encore_worker.host.config import ASR_MODELS, Config
from encore_worker.protocol.vocabulary import Stage
from encore_worker.steps.align_claims import (
    _ADOPT_EDGE_SEC,
    _ADOPT_SCORE_GAP,
    _REOPEN_MAX_SEC,
    _REPAIR_PAD_SEC,
    _claims_as_served,
    _Placement,
    _placement_margins,
)
from encore_worker.steps.align_geometry import (
    _anchored_runs,
    _clamped,
    _with_lines,
)
from encore_worker.steps.align_lines import (
    _agreement_of,
    _claimed_starts,
    _envelope_passes,
    _grade_every_line_low,
    _in_claim_order,
    _line_doc,
    _line_sync_clock,
    _line_sync_decode,
    _LineEvidence,
    _mapped,
    _measured_lift,
    _nonlatin_script,
    _sheet_passes,
    _sheet_spans,
    _timed_spans,
    _word_doc,
)
from encore_worker.steps.align_notes import (
    _backwards_why,
    _built_why,
    _bundle_why,
    _ends_why,
    _graph_why,
    _linesep_why,
    _margin_why,
    _pulls_why,
    _repeats_why,
    _sheet_why,
    _Source,
    _sources_why,
    _star_why,
    _units_why,
)
from encore_worker.steps.align_text import (
    _MANUAL_LABEL,
    _Permanent,
    _pinned_label,
    _place,
    _provider_label,
    _stored_lines,
    _timing_of,
    _with_source_lines,
)
from encore_worker.steps.align_unsung import (
    _NEVER_SUNG_ENV,
    _NEVER_SUNG_RATE,
    _NEVER_SUNG_SCORE_GAP,
    _SPOKEN_FLOOR,
    _SPOKEN_RATIO,
    _skipped_lines,
    _speech_mass,
    _star_positions,
)
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
    #: A (language, dominant non-Latin script) -> its DISPLAY-ONLY romaniser, or None where this box has no
    #: backend for it. None here romanises nothing, which is every document this worker published before W8
    #: (XA-19).
    romanizer: Callable[[str, str], romanize.Romanizer | None] | None = None


class Reporter(Protocol):
    """What a step uses to talk to the core, narrowed so a step cannot send arbitrary frames. A Protocol, so
    `transport.Client` satisfies it structurally without inverting the layer order."""

    async def progress(self, job_id: str, stage: Stage, pct: int) -> None: ...

    async def state(
        self, job_id: str, state: str, attempt: int, verdict: str, why: str, knob: str | None
    ) -> None: ...

    async def confirm_ownership(self, job_id: str, *, timeout_sec: float = 10.0) -> bool: ...

    def explain_ownership(self, job_id: str) -> str: ...


def progress_sink(reporter: Reporter, job_id: str, stage: Stage) -> ports.ProgressSink:
    """A port's synchronous 0..100, forwarded to the core from the loop that built it (WK-07).

    Called from the port's thread, so each report is handed back to that loop. Only a RISE is sent: a tool
    that prints the same figure many times a second would otherwise flood the room's `media:status`.
    """
    loop = asyncio.get_running_loop()
    sent = -1

    def sink(pct: int) -> None:
        nonlocal sent
        if pct <= sent:
            return
        sent = pct
        asyncio.run_coroutine_threadsafe(reporter.progress(job_id, stage, pct), loop)

    return sink


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

    async def _unit_rules(self, language_code: str) -> units.Rules:
        """How THIS text becomes words, syllables and vocabulary lookups, under the three W8 arms.

        One object per attempt, read by the decode, the repair, the lift and the margin alike, so no two of
        them can group one text differently (docs/arch/04-alignment.md §9.1, §14). OFF THE EVENT LOOP for
        `_romanizer`'s reason: under `mms-roman` this builds uroman or cutlet, which costs seconds on first
        use (LOG.md, "W8 stages 1-2").
        """
        return await asyncio.to_thread(units.rules_for, language_code, self._cfg.align_experiments)

    async def _romanizer(self, language_code: str, script: str) -> romanize.Romanizer | None:
        """This box's DISPLAY-ONLY romaniser for `language_code`, where it has a backend for it.

        Asked per published document rather than held, the factory caching the built backend; a box with no
        backend answers None and the document is the one it always was (XA-19). `script` routes the scripts
        no language can be named for (docs/arch/04-alignment.md §11.2). OFF THE EVENT LOOP because the first
        build costs seconds (LOG.md, "W8 stage 0"), which would stall every other job on this worker.
        """
        if self._a.romanizer is None:
            return None
        return await asyncio.to_thread(self._a.romanizer, language_code, script)

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

    async def acquire_audio(self, job: JobRef, *, report_download: bool = False) -> AudioRef:
        """The bytes and their duration. Raises when the source is unreachable — nothing substitutes.

        A LOCAL source is already on disk, decided from the DECLARED fetcher rather than by sniffing the URI.
        `report_download` is the FETCH job's alone: inside a stems or align job a download percentage would
        drag that job's bar back to the download's.
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
            sink = progress_sink(self._out, job.job_id, Stage.DOWNLOADING) if report_download else None
            path = await asyncio.to_thread(self._a.fetcher.fetch, path, self._work(job), on_progress=sink)

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
        # A ROUTED BUNDLE MAY NOT TIME WORDS HERE EITHER, and this engine has no witness to offer: it reads
        # no emission matrix, so NO lift can be measured on any bundle, calibrated or not — which is why
        # `may_time_words` is asked with no row rather than with this language's. English keeps the behaviour
        # this engine was measured with; a routed language publishes LINES at most (XA-06;
        # docs/arch/04-alignment.md §5.4).
        routed = bundle_language != language.ENGLISH
        # AND SO MAY A NON-LATIN SCRIPT ON THE ENGLISH BUNDLE, which is not a routed bundle at all: a script
        # `language.SCRIPT_LANGUAGES` can name no language for falls back to `ENGLISH`, so the lane's rule
        # has to read the TEXT's script and not the language the fallback picked.
        script = _nonlatin_script(req.text)
        gateless = not lexical.may_time_words(
            None, heard_on_this_audio=req.text.tier is Tier.ASR, nonlatin_script=script
        )
        unvouched = False
        if (routed or script) and gateless and "h3-ungated-words" not in self._cfg.align_experiments:
            ungated = lexical.words_ungated(
                f"this aligner reads no emission matrix, so no lexical lift can be measured on the "
                f"{bundle_language!r} bundle it aligns on, whatever "
                f"({', '.join(lexical.calibrated_pairs())}) are calibrated for the global engine"
                if routed
                else lexical.unnamed_script(script, f"the {bundle_language!r} bundle")
            )
            if pin_of(req.job) is None:
                await self._out.state(req.job.job_id, "align-windowed", 0, "declined", ungated, None)
                return None
            # THE SECOND EXEMPTION, as in `_time_text_global`: a person chose this text, so it publishes
            # anyway — all-`low` and unvouched, nothing here having read the words.
            unvouched = True
            await self._out.state(
                req.job.job_id,
                "align-windowed",
                0,
                "pin-unvouched",
                f"{ungated} — a person chose this text, so it publishes anyway: every line graded low",
                None,
            )
        try:
            aligned = await asyncio.to_thread(self._a.aligner.align, spans, target, bundle_language)
        except InfraFault:
            raise  # the machinery, not this text: fails the job (XA-17)
        except Exception:  # noqa: BLE001 - an aligner that could not place this text is one attempt failing
            return None
        doc = _word_doc(aligned, req.language)
        if unvouched:
            # THE GRADE GOES ON THE LINES AND NOT ONLY ON THE RECORD: core's `wipesWords` keeps the
            # bouncing-ball wipe for a line with no grade, so an unvouched pin would sweep word by word over
            # timings nothing vouched for (review r2-correctness-4; XA-14).
            _grade_every_line_low(doc)

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
        return self._write(
            req,
            doc,
            TIMING_WORD,
            "low" if unvouched else "high",
            report=report,
            vouched=not unvouched,
        )

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
            doc = _line_doc(
                self._placed_by(req, None),
                req.language,
                await self._romanizer(req.language, _nonlatin_script(req.text)),
            )
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
            decoded, undecoded = await _line_sync_decode(
                texts, evidence.emissions, req.language, evidence.units
            )
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
        doc = _line_doc(placed, req.language, await self._romanizer(req.language, _nonlatin_script(req.text)))
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
            return _LineEvidence(None, "this aligner produces no emission matrix", None, None, None)
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
            return _LineEvidence(None, f"it raised {type(exc).__name__}: {exc}", None, None, None)
        rules = await self._unit_rules(req.language)
        lifted, bands, unlifted = await _measured_lift(texts, emissions, rules, bundle_language)
        return _LineEvidence(lifted, unlifted, bands, emissions, rules)

    async def _word_lift(
        self, req: TimeRequest, line_texts: Sequence[str], emissions: Any, bundle_language: str
    ) -> tuple[lexical.Lift | None, lexical.Bands | None, str]:
        """The global engine's lexical check: `line_texts`' lift on the matrix this attempt decoded, the
        calibration row it is judged against, or None for both and why it did not run.

        EXEMPT: the ASR tier, and a text too short or too repetitive for the contrast to mean anything, each
        keeping the envelope gate instead. Machine captions are NOT exempt. COST: four CTC decodes on the
        matrix already in hand (docs/arch/04-alignment.md §5.1).
        """
        if req.text.tier is Tier.ASR:
            return None, None, "a transcript of this recording (its words were heard on this audio)"
        rules = await self._unit_rules(req.language)
        return await _measured_lift(line_texts, emissions, rules, bundle_language)

    async def _time_text_global(self, req: TimeRequest) -> TimedDoc | Refused | None:
        """Generate our own timings from TEXT ALONE, then reconcile every other measurement INTO them.

        `None` is one ATTEMPT failing and never a switch of engine; `Refused` ends the text (XA-05).
        Disagreements are repaired IN PLACE by four rungs whose provenance GATES grading (XA-02, XA-03;
        docs/arch/04-alignment.md §4, §5, §6).
        """
        from encore_worker.adapters.ml import (  # noqa: PLC0415
            STAR_PENALTY_NATS,
            Emissions,
            forced_align_decoder,
            load_audio_mono_16k,
            log_probs_like,
            starred,
        )
        from encore_worker.domain.audio import activity  # noqa: PLC0415
        from encore_worker.domain.lyrics import (  # noqa: PLC0415
            parts,  # noqa: PLC0415
            prior,
            viterbi,
        )
        from encore_worker.domain.lyrics import reconcile as rc  # noqa: PLC0415
        from encore_worker.domain.lyrics.generate import (  # noqa: PLC0415
            Decoder,
            adopted_line,
            alignable_chars,
            blank_of,
            char_targets,
            generate,
            regenerate,
            reopened_line,
            separator_named,
            separator_of,
            star_of,
        )

        aligner = self._a.aligner
        assert aligner is not None  # guarded by time_text; restated for the type checker
        # THE DECODE ARMS, all default-off, read ONCE here: each belongs to every decode that produces THIS
        # document and to none of the GATE decodes (XA-12; docs/arch/04-alignment.md §14, §14.1).
        separate_lines = "linesep" in self._cfg.align_experiments
        # W8's non-Latin lane: `plain` unless an arm is on, and then the SAME object for every decode of
        # this attempt (docs/arch/04-alignment.md §9.1).
        unit_rules = await self._unit_rules(req.language)
        star_arm = "star" in self._cfg.align_experiments
        # W9's research track (docs/arch/04-alignment.md §3.2). `priors-decide` IS the other three: the
        # review's deciding arm is priors plus fusion plus optional lines with the ladder bypassed, and
        # measuring it under three separate names would be measuring three different arms.
        deciding_arm = "priors-decide" in self._cfg.align_experiments
        star_b_arm = "star-b" in self._cfg.align_experiments
        skip_arcs_arm = deciding_arm or "skip-arcs" in self._cfg.align_experiments
        priors_arm = deciding_arm or "claim-priors" in self._cfg.align_experiments
        fusion_arm = deciding_arm or "claim-fusion" in self._cfg.align_experiments
        # The vendored decoder is what the three arms above are expressed in, so any of them implies it; on
        # its own the name is the CONTROL, and a control that moved a byte would not be one (XA-18).
        vendored_arm = star_b_arm or skip_arcs_arm or priors_arm or "vendored" in self._cfg.align_experiments
        stars_wanted = star_arm or star_b_arm
        #: What the vendored graph DID on this attempt, in the order it happened — the trail's only account
        #: of a decode that is not the kernel's. Empty under the bare `vendored` control, which is the point.
        decode_note: list[str] = []

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
            parts.split(line_texts, emissions=emissions, units=unit_rules)
            if "adlibs" in self._cfg.align_experiments
            else parts.untouched(line_texts)
        )

        stem_target = target  # this attempt's own file, under the name the two witness reads below use

        # ── the lexical gate: are THESE WORDS what the target sings? (docs/arch/04-alignment.md §5.1) ──
        # FIRST, before this text's decode and before any audio is read: no repair makes unsung words sung.
        # The bands are the RESOLVED bundle's row, never `lexical.BANDS` by name (XA-06); `_word_lift` says
        # what is exempt.
        lifted, bands, unmeasured = await self._word_lift(req, line_texts, emissions, bundle_language)
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
        # there losing MORE right texts AND admitting wrong ones (LOG.md, "The stemless mode").
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
        heard_on_this_audio = req.text.tier is Tier.ASR
        # AND A SCRIPT NO BUNDLE IS FOR REACHES A ROW THAT IS NOT ITS OWN: `language.SCRIPT_LANGUAGES` names
        # no language for it, so `detect` falls back to English and finds a CALIBRATED row fitted on text the
        # English vocabulary spells. The lane's rule is the TEXT's script (review r2-spec-8).
        script = _nonlatin_script(req.text)
        if (
            not lexical.may_time_words(bands, heard_on_this_audio=heard_on_this_audio, nonlatin_script=script)
            and not ungated_words_arm
        ):
            ungated = lexical.words_ungated(
                lexical.unnamed_script(script, _bundle_why(emissions))
                if script and bands is not None
                else unmeasured
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
        # UNMEASURED text is not vouched for either (XA-14; docs/arch/04-alignment.md §5.1; LOG.md, "The
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

        # ── THE STAR COLUMN: the `star` and `star-b` arms, both default-off ──
        # ONE MATRIX, WIDENED ONCE, AFTER THE GATE, so each reader sees the matrix it was calibrated on
        # (XA-12; docs/arch/04-alignment.md §14.1).
        decode_matrix = await asyncio.to_thread(starred, emissions) if stars_wanted else emissions

        def global_decoder(
            texts: Sequence[str], matrix: Any, bonus: Mapping[int, Any] | None = None
        ) -> Decoder:
            """The decoder a GLOBAL decode of `texts` runs on: torchaudio's kernel, or the vendored graph.

            Rebuilt per text list because a graph's states are target POSITIONS and the never-sung rule
            changes the texts under it. A repair window is never given one: its targets are a different
            sequence over a slice (docs/arch/04-alignment.md §3.2).
            """
            if not vendored_arm:
                return forced_align_decoder
            stars: tuple[int, ...] = ()
            if star_b_arm:
                flat = char_targets(
                    texts, matrix, separate_lines=separate_lines, stars=True, units=unit_rules
                )
                stars = _star_positions(flat, matrix)
            if not stars and not bonus:
                return viterbi.decoder()
            graph = viterbi.Graph(stars=stars, star_penalty=STAR_PENALTY_NATS, bonus=dict(bonus or {}))
            # THE TRAIL'S ONLY ACCOUNT OF A NON-EMPTY GRAPH, and `_graph_why` reports the empty one as
            # torchaudio's own path, so without this an armed decode reads exactly like the control.
            # Said once per shape: two decodes of the same graph are one fact about this attempt.
            built = _built_why(graph)
            if built not in decode_note:
                decode_note.append(built)
            return viterbi.decoder(graph)

        try:
            generated = await asyncio.to_thread(
                generate,
                adlibs.lead_texts,
                decode_matrix,
                decoder=global_decoder(adlibs.lead_texts, decode_matrix),
                language=req.language,
                separate_lines=separate_lines,
                stars=stars_wanted,
                units=unit_rules,
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
        # claim's own span, and an unclaimed line keeps the three-signal rule either way (LOG.md, "What
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

        async def decode_active() -> Generated | None:
            """The global decode of `line_texts_active` as it now stands, or None having DECLINED."""
            try:
                out = await asyncio.to_thread(
                    generate,
                    line_texts_active,
                    decode_matrix,
                    decoder=global_decoder(line_texts_active, decode_matrix),
                    language=req.language,
                    separate_lines=separate_lines,
                    stars=stars_wanted,
                    units=unit_rules,
                )
            except InfraFault:
                raise  # the machinery, not this text (XA-17)
            except Exception as exc:  # noqa: BLE001 - the decode refused THIS text: one attempt failing
                await decline(f"re-decode after drop failed: {type(exc).__name__}: {exc}")
                return None
            out = parts.restored(out, adlibs, until=req.audio.duration_sec)
            if not out.lines:
                await decline("every line graded never-sung; nothing left to publish")
                return None
            return out

        #: What roadmap item 15's skip arcs left unsung, as the trail names them. A COMPLEMENT and never a
        #: replacement: the arcs run FIRST, on the blind decode, and the three-signal never-sung rule below
        #: then runs on what is left (docs/arch/04-alignment.md §3.2).
        dropped_skip_arcs: list[str] = []
        if skip_arcs_arm:
            said = [" ".join(text.lower().split()) for text in line_texts_active]
            # A REPEAT IS EXEMPT (the review's roadmap item 15): the arc cannot tell which occurrence
            # is which, so bypassing one is as likely to drop the sung chorus as the unsung one.
            exempt = frozenset(at for at, text in enumerate(said) if text and said.count(text) > 1)
            unsung = await asyncio.to_thread(
                _skipped_lines,
                decode_matrix,
                line_texts_active,
                separate_lines=separate_lines,
                stars=stars_wanted,
                # THE PUBLISHER'S OWN GRAPH: under `star-b` the star states the publishing decode may
                # bypass for free are mandatory targets in any graph that does not price them, and a
                # detector on that trellis names lines about a decode nobody ran (review W9 r2-correctness-4).
                star_penalty=STAR_PENALTY_NATS if star_b_arm else None,
                exempt=exempt,
                units=unit_rules,
            )
            for index in sorted(unsung or ()):
                dropped_skip_arcs.append(f"[{index}] {line_texts_active[index][:40]!r}")
                line_texts_active[index] = ""
            # A SEPARATE GRAPH FROM THE ONE THAT PUBLISHES, so the trail has to say the detector read one at
            # all — a run that found nothing is otherwise silent about having looked — and which topology it
            # read it on, the stars being the publisher's.
            decode_note.append(
                f"a detector graph offered a skip arc at "
                f"{viterbi.SKIP_LINE_NATS:g} + {viterbi.SKIP_CHAR_NATS:g} nats/char"
                f"{' over the stars the publisher bypasses' if star_b_arm else ''}, "
                f"{len(exempt)} repeat(s) exempt: {len(dropped_skip_arcs)} line(s) bypassed"
            )
            if dropped_skip_arcs:
                after_arcs = await decode_active()
                if after_arcs is None:
                    return None
                generated = after_arcs

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
            after_drop = await decode_active()
            if after_drop is None:
                return None
            generated = after_drop

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
        margin_nats = lexical.margin_floor(lexical.calibration(emissions, bundle_language))
        #: NO MARGINS = NOT MEASURED, and grading then reads what it did before the rule existed.
        #: `_Placement.silence` says WHICH reason; an empty dict is not that answer.
        placement: _Placement
        if "conf-legacy" in experiments:
            placement = _Placement(silence="arm")
        elif margin_nats is None:
            placement = _Placement(silence="uncalibrated")
        elif star_b_arm:
            # `margin.placement_margins` KNOWS ONLY THE PLAIN TOPOLOGY, and under `star-b` the decode that
            # published ran with every star bypassable — so a margin read here would describe a trellis no
            # decode of this document used (XA-12). Abstaining says the rule was not read; it does not lie.
            placement = _Placement(silence="graph")
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
                stars=stars_wanted,
                units=unit_rules,
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
        # than the series as repaired so far (LOG.md, "The L1 arms").
        blind_median = median(line.score for line in blind_decode.lines)
        #: Seconds a DECODED end sits from its cue's own end, over the lines whose OPENINGS the blind decode
        #: agrees with (XA-03); None under `rc.MIN_FITTED_PAIRS` of them, which is what a displaced sheet has.
        #: The scale `skipped_opening` reads an end against: LOG.md, "W8a: the late half of the band".
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
        if dropped_skip_arcs:
            repairs.append(f"skip arcs left unsung: {', '.join(dropped_skip_arcs)}")
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
            Both caps and their exhibits: LOG.md, "The repair window's two caps, priced".
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
            return 2 * alignable_chars(text, emissions, unit_rules) * float(emissions.frame_sec)

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
            witnesses and the per-song reach: LOG.md, "W8a: the late half of the band, and the end that
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
                # different token stream from the lines around it. The unit rules are the same object for the
                # same reason, one text having one tokenisation per attempt.
                separate_lines=separate_lines,
                units=unit_rules,
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
                # DEFAULT ON since W9 (owner decision, PLAN 2026-10-09): it buys coverage, and the four
                # Jamendo words it costs are a recorded waiver, not a loosened bound
                # (docs/arch/04-alignment.md §14; `gates/w8b-arms.yaml` §2). `band-late-kept` is the control.
                late = (
                    not unheard
                    and "band-late-kept" not in experiments
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
            docs/benchmarks/forced-alignment/LOG.md, "The adoption guard's exhibit"."""
            return "l1-mix-kept" in experiments and provenance.get(index) == _Source.MIX

        # REPAIR ORDER: evidence-first, then reconcile-driven (docs/arch/04-alignment.md §4). R3 and R4 need
        # no reconcile verdict, so running them first lets the verdict PROMOTE when they succeed.

        async def fuse_in_the_mix() -> Any:
            """`emissions` with the mix's frames where the TARGET's envelope hears nothing inside a claim
            window (the review's roadmap item 14), or `emissions` itself when no second witness is owed or
            none can be had."""
            if mix_target == stem_target:
                decode_note.append("no fusion: the target IS the mix")
                return emissions
            mask = prior.mute_in_window(
                env,
                list(claim_windows.values()),
                frames=int(emissions.frames),
                frame_sec=float(emissions.frame_sec),
                hop_sec=activity.HOP_SEC,
                floor=_NEVER_SUNG_ENV,
            )
            owed = int(mask.sum())
            if not owed:
                decode_note.append("no fusion: no claim window is silent on the target")
                return emissions
            try:
                heard = await asyncio.to_thread(
                    aligner.emissions,  # type: ignore[attr-defined]
                    mix_target,
                    await self._bundle_language(req, on_mix=True),
                )
                # ONE BUNDLE OR NO FUSION. `prior.fused` swaps whole ROWS, so a row of one has to be a row of
                # the other — and it can only compare WIDTHS. The mix is emitted under its own language
                # routing (`_bundle_language(on_mix=True)`), which `lang-route-mix` can resolve elsewhere, so
                # the dictionary and the blank are checked HERE, where both bundles are in hand.
                if dict(heard.dictionary) != dict(emissions.dictionary) or blank_of(heard) != blank_of(
                    emissions
                ):
                    decode_note.append("no fusion: the mix was emitted by another bundle's vocabulary")
                    return emissions
                merged = await asyncio.to_thread(prior.fused, emissions.log_probs, heard.log_probs, mask)
                # BACK AS THE KIND THE EMITTER PRODUCED. This arm changes the evidence and not the decoder,
                # so the fused matrix is decoded by torchaudio's kernel — which `prior.fused`' numpy answer
                # cannot be handed to (review W9 r2-spec-6).
                merged = log_probs_like(emissions.log_probs, merged)
            except InfraFault:
                raise  # the model, the kernel or the device: the JOB's fault, not this text's (XA-17)
            except Exception as exc:  # noqa: BLE001 - no second witness is a REASON, not a failed attempt
                decode_note.append(f"no fusion: the mix raised {type(exc).__name__}")
                return emissions
            decode_note.append(f"fused the mix into {owed} of {emissions.frames} frames")
            return Emissions(
                log_probs=merged,
                frame_sec=float(emissions.frame_sec),
                dictionary=dict(emissions.dictionary),
                model=str(getattr(emissions, "model", "") or ""),
                blank_id=blank_of(emissions),
                specials=dict(getattr(emissions, "specials", None) or {}),
            )

        async def decode_primed(matrix: Any, bonus: Mapping[int, Any]) -> Generated | None:
            """The primed global decode, or None having KEPT what the ladder's input already was: a prior
            that cannot be decoded is a reason to drop the arm, never to decline a measured document."""
            try:
                out = await asyncio.to_thread(
                    generate,
                    line_texts_active,
                    matrix,
                    decoder=global_decoder(line_texts_active, matrix, bonus),
                    language=req.language,
                    separate_lines=separate_lines,
                    stars=stars_wanted,
                    units=unit_rules,
                )
            except InfraFault:
                raise  # the machinery, not this text (XA-17)
            except Exception as exc:  # noqa: BLE001 - see the docstring
                decode_note.append(f"the primed re-decode raised {type(exc).__name__} and was dropped")
                return None
            out = parts.restored(out, adlibs, until=req.audio.duration_sec)
            if not out.lines:
                decode_note.append("the primed re-decode placed no line and was dropped")
                return None
            return out

        # ── ROADMAP ITEM 14: THE PRIMED RE-DECODE (`claim-priors`, `claim-fusion`, `priors-decide`) ──
        # AFTER the clock, since a prior centred on a RAW claim is centred on the sheet's own offset (XA-04),
        # and after the BLIND verdict, which grading reads and which must stay claim-free (XA-03). This is the
        # only decode in the step a claim reaches, and under `priors-decide` it stands in for the ladder
        # (docs/arch/04-alignment.md §3.2).
        if (priors_arm or fusion_arm) and claimed:
            evidence: Any = emissions
            if fusion_arm:
                evidence = await fuse_in_the_mix()
            primed_matrix = await asyncio.to_thread(starred, evidence) if stars_wanted else evidence
            primed_flat = char_targets(
                line_texts_active,
                primed_matrix,
                separate_lines=separate_lines,
                stars=stars_wanted,
                units=unit_rules,
            )
            bonus = (
                prior.onset_bonus(
                    primed_flat.first_char_target,
                    claimed,
                    frames=int(primed_matrix.frames),
                    frame_sec=float(primed_matrix.frame_sec),
                )
                if priors_arm
                else {}
            )
            primed = await decode_primed(primed_matrix, bonus)
            if primed is not None:
                record(_Source.PRIMED, {line.index: line for line in primed.lines})
                generated = primed
                verdict = steer(generated)
                fit = await asyncio.to_thread(fit_of, generated)
                decode_note.append(
                    f"re-decoded all {len(primed.lines)} lines with {len(bonus)} claim onset prior(s)"
                )
                repairs.append(f"primed re-decode replaced all {len(primed.lines)} lines")

        # ── R3: blind repeats, anchored between unique neighbours. With no claim to say WHICH chorus an
        # occurrence is, the unique lines around a repeated block are the best anchors available, so the block
        # is re-decoded jointly in the gap between them, constraining the misbinding to that gap.
        # THE BLIND VERDICT AND NOT `verdict` (XA-03), which the primed arms have re-read on a claim-primed
        # document: `line_confidence`'s ANCHORED branch grades R3's output on BLIND corroboration, so a
        # claim-contaminated input set would grade those lines against a precondition that no longer held.
        corroborated_now = {j.index for j in blind_verdict.lines if j.corroborated}
        normalized = [" ".join(text.lower().split()) for text in line_texts]
        repeats = {i for i, text in enumerate(normalized) if text and normalized.count(text) > 1}
        blind = {
            ln.index for ln in generated.lines if ln.index in repeats and ln.index not in corroborated_now
        }
        if blind and not deciding_arm:
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
        if claim_windows and mix_target != stem_target and not deciding_arm:
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
        if verdict.verdict == rc.UNRELATED and len(claim_windows) >= rc.MIN_PAIRS and not deciding_arm:
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
        if disputed_indexes and not deciding_arm:
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
        # LOG.md, "The envelope gate's three tiers").
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
        # grade does not move. Which song, which mode and the price of flipping it on: LOG.md, "W8a: what the
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
        # ABOUT TO PUBLISH tells the sheet's story. UNRELATED alone (LOG.md, "`claims_related`").
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
            # ONLY UNDER A W8 ARM, and then ALWAYS: a run whose words are per-hanzi and one whose words are
            # whole lines publish different documents off the same text (docs/arch/04-alignment.md §9.1).
            + (
                f"{_units_why(unit_rules, req.language, experiments)}; "
                if unit_rules.name != "plain" or units.unhonoured(req.language, experiments)
                else ""
            )
            # ONLY UNDER THE ARM — and under it ALWAYS, so an arm that acted and an arm that went inert on a
            # matrix with no star column cannot read alike.
            + (f"{_star_why(star_of(decode_matrix))}; " if stars_wanted else "")
            # `claim-fusion` changes the EVIDENCE and not the decoder, so it owns no graph — and still has
            # to report, or a run that fused the mix into a third of the song reads like one that did not.
            + (f"{_graph_why(decode_note, vendored=vendored_arm)}; " if vendored_arm or fusion_arm else "")
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
        drift one global offset cannot (LOG.md, "The fix, and what it measured").
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


def now_ms() -> int:
    """Wall clock, isolated in a step layer. A workflow body must never call this — DBOS replays it."""
    return int(time.time() * 1000)
