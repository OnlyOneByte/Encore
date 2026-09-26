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
import os
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from statistics import median
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from encore_worker.domain.lyrics.generate import Generated, Line

from encore_worker.adapters import ports
from encore_worker.artifacts import keys
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics import attribute, measure, place, presplit
from encore_worker.domain.lyrics.policy import Tier
from encore_worker.host.config import Config
from encore_worker.protocol.vocabulary import Stage
from encore_worker.steps.api import NotOurJob, as_segments
from encore_worker.steps.records import (
    TIMING_LINE,
    TIMING_WORD,
    AudioRef,
    JobRef,
    TextRef,
    TimedDoc,
    TimeRequest,
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

    async def transcribe(self, job: JobRef, audio: AudioRef, *, on_vocals: bool) -> TextRef | None:
        """The mandatory fallback tier. `None` means nothing intelligible was heard.

        `to_thread` is load-bearing rather than tidy: whisper is synchronous, and awaiting it inline
        freezes the event loop for the whole pass — so the socket keepalive stops, the core's lease
        expires, and the reaper requeues a job that is running fine.
        """
        if self._a.transcriber is None:
            return None
        target = audio.vocals_path if (on_vocals and audio.vocals_path) else audio.path
        segments = await asyncio.to_thread(
            self._a.transcriber.transcribe, target, language=job.param_str("language")
        )
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

    # ── alignment ────────────────────────────────────────────────────────────────────────────────

    async def time_text(self, req: TimeRequest) -> TimedDoc | None:
        """One alignment attempt: generate, reconcile, repair, grade. `None` if nothing publishable resulted.

        THE GLOBAL DECODE IS THE PATH, and disagreements are RECONCILED INSIDE IT rather than escalated to
        a different engine: a disputed or scattered line is re-decoded within a window some other evidence
        vouches for (a claim span, the gap between two anchored unique lines) on the same emission matrix.
        The windowed whisperx aligner survives only for an aligner that cannot produce emissions at all —
        a capability gap, not a quality fallback — and for the LINE_SYNC terminal knob.
        """
        if self._a.aligner is None:
            return None

        if req.force_line_sync:
            # Terminal knob: publish the text's own line timings rather than word timings.
            return self._write(req, _line_doc(self._placed(req), req.language), TIMING_LINE, "low")

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
        except Exception:  # noqa: BLE001 - an aligner fault is one attempt failing, not the job
            return None
        doc = _word_doc(aligned, req.language)

        residual = place.residual_against(doc, segments) if req.text.has_own_timings else None
        report = measure.measure(doc, duration_sec=req.audio.duration_sec, residual_sec=residual)
        if report.words == 0:
            return None
        return self._write(req, doc, TIMING_WORD, "high", report=report)

    async def _time_text_global(self, req: TimeRequest) -> TimedDoc | None:
        """Generate our own timings from TEXT ALONE, then reconcile every other measurement INTO them.

        `None` is one ATTEMPT failing — the verify ladder moves to its next knob or text — never a switch
        to a different engine. Disagreements are repaired in place, on the same emission matrix:

          R1  claims fit the audio better than a scattered decode (found live: authored captions came back
              UNRELATED because OUR decode had misbound repeat-heavy text) — every claimed line is
              re-decoded inside its padded claim window, where the claim vouches for occupancy and the
              decode supplies the precision.
          R2  a STRUCTURAL verdict's disputed lines — the exact lines a monotonic decode can bind to the
              wrong chorus occurrence (F2) — are re-decoded inside their claim windows; the re-reconcile
              then upgrades them to corroborated when the two witnesses meet.
          R3  blind repeats (no claim to anchor them) are re-decoded jointly between their nearest UNIQUE
              neighbours — the anchor-and-redecode tactic Gentle's multipass realigner and nomadkaraoke's
              anchor sequences both converge on. They stay `low`: an anchor vouches for the region, not
              for which occurrence is which.

        GRADING (measured, docs/benchmarks/forced-alignment): corroborated -> `high` (two independent
        measurements agreeing beats the decode's own score, F3), disputed -> `low`, blind repeats -> `low`,
        blind unique -> `high`. Neither the path score (F3) nor char-rate (F4) graded better.
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
        except Exception as exc:  # noqa: BLE001 - one attempt failing, not the job
            await decline(f"decode failed: {type(exc).__name__}: {exc}")
            return None
        if not generated.lines:
            await decline("no line in this text carries an alignable character")
            return None

        try:
            signal = await asyncio.to_thread(load_audio_mono_16k, target)
        except Exception as exc:  # noqa: BLE001 - an unreadable file fails this attempt
            await decline(f"audio unreadable for the envelope: {type(exc).__name__}: {exc}")
            return None
        rate = 16000

        def fit_of(gen: Generated) -> activity.ShiftFit:
            return activity.fit_sheet_to_audio(signal, rate, [(ln.start, ln.end) for ln in gen.lines])

        env = activity.envelope(signal, rate)

        def env_overlap(start: float, end: float) -> float:
            first = int(start / activity.HOP_SEC)
            last = max(int(end / activity.HOP_SEC), first + 1)
            window = env[max(0, first):min(last, len(env))]
            return float(window.mean()) if len(window) else 0.0

        # ── never-sung drop + re-decode ──
        # A caption line that is NOT in the audio (an uploader credit; a lyric only present in a stem this
        # box did not get) does worse than fail: forced monotonically through emissions that do not contain
        # it, it consumes its neighbours' frames and drags them off (measured: dropping one such line moved
        # tfr-chosen from 51.4% to 58.8% within ±500 ms and gross 14 -> 11). Three signals, ALL required —
        # each alone misfires on a real quiet line (tfr-mayday's sung background echo matches the first
        # two): the decode scored it far below the song's norm, its span sits on silence, and its chars
        # smear at far below singing tempo. A re-decode after dropping is a millisecond Viterbi.
        line_texts_active = list(line_texts)
        dropped_never_sung: list[str] = []
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
                dropped_never_sung.append(f"[{line.index}] {line.text[:40]!r}")
            try:
                generated = await asyncio.to_thread(
                    generate,
                    line_texts_active,
                    emissions,
                    decoder=forced_align_decoder,
                    language=req.language,
                )
            except Exception as exc:  # noqa: BLE001 - one attempt failing, not the job
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

        # ── claims as evidence ──
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
        verdict = (
            rc.reconcile(generated.lines, claimed)
            if claimed
            else rc.Reconciliation(verdict=rc.NO_CLAIMS, why="text arrived untimed")
        )

        repairs: list[str] = []
        if dropped_never_sung:
            repairs.append(f"dropped never-sung: {', '.join(dropped_never_sung)}")

        def rerun(runs: list[tuple[tuple[Line, ...], tuple[float, float]]]) -> dict[int, Line]:
            return regenerate(runs, emissions, decoder=forced_align_decoder, language=req.language)

        def claim_run(line: Line) -> tuple[tuple[Line, ...], tuple[float, float]]:
            window = claim_windows[line.index]
            return ((line,), (window[0] - _REPAIR_PAD_SEC, window[1] + _REPAIR_PAD_SEC))

        adopted: set[int] = set()
        repaired_all: set[int] = set()

        def adopt_where_unheard(repaired: dict[int, Line]) -> dict[int, Line]:
            # A window decode that cannot HEAR the line betrays itself two ways, both measured on
            # tfr-chosen's chopped-vocal outro: the forced path through flat emissions sticks to the
            # window's left edge, or its score sits far below the song's own median. Either way a human's
            # claim timing beats a decode that heard nothing — the line adopts the claim's span outright,
            # words interpolated and flagged, graded `low` below. Measured effect (claims present):
            # gross errors 14 -> 0 on tfr-chosen; flyaway 82.7% and mayday 76.9% raw within ±250 ms.
            song_median = median(line.score for line in generated.lines)
            out = dict(repaired)
            for index, fixed in repaired.items():
                window = claim_windows.get(index)
                if window is None:
                    continue
                edge_stuck = abs(fixed.start - (window[0] - _REPAIR_PAD_SEC)) < _ADOPT_EDGE_SEC
                flat = fixed.score < song_median - _ADOPT_SCORE_GAP
                if edge_stuck or flat:
                    claim_timed = adopted_line(fixed.text, index, window[0], window[1])
                    if claim_timed is not None:
                        out[index] = claim_timed
                        adopted.add(index)
            return out

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
            repaired = await asyncio.to_thread(rerun, runs)
            if repaired:
                repaired_all |= set(repaired)
                generated = _with_lines(generated, repaired)
                if claimed:
                    verdict = rc.reconcile(generated.lines, claimed)
                fit = await asyncio.to_thread(fit_of, generated)
                repairs.append(f"re-decoded {len(repaired)} repeated lines between unique anchors")

        # ── R4: MIX AS A SECOND WITNESS.
        stem_target = target
        mix_target = req.audio.align_target(on_mix=True)
        if claim_windows and mix_target != stem_target:
            stem_invisible = [
                line
                for line in generated.lines
                if line.index in claim_windows
                and line.index not in adopted
                and env_overlap(claim_windows[line.index][0], claim_windows[line.index][1])
                < _NEVER_SUNG_ENV
            ]
            if stem_invisible:
                try:
                    mix_emissions = await asyncio.to_thread(
                        aligner.emissions, mix_target, req.language  # type: ignore[attr-defined]
                    )
                    mix_repaired = await asyncio.to_thread(
                        regenerate,
                        [claim_run(line) for line in stem_invisible],
                        mix_emissions,
                        decoder=forced_align_decoder,
                        language=req.language,
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
                    if mix_repaired:
                        repaired_all |= set(mix_repaired)
                        generated = _with_lines(generated, mix_repaired)
                        if claimed:
                            verdict = rc.reconcile(generated.lines, claimed)
                        fit = await asyncio.to_thread(fit_of, generated)
                        repairs.append(
                            f"re-decoded {len(mix_repaired)} stem-invisible lines against the mix"
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
                runs = [claim_run(line) for line in generated.lines if line.index in claim_windows]
                repaired = adopt_where_unheard(await asyncio.to_thread(rerun, runs))
                if repaired:
                    repaired_all |= set(repaired)
                    generated = _with_lines(generated, repaired)
                    verdict = rc.reconcile(generated.lines, claimed)
                    fit = await asyncio.to_thread(fit_of, generated)
                    repairs.append(
                        f"claims fit the audio better (r={claim_fit.correlation:.2f}); "
                        f"re-decoded {len(repaired)} of {len(runs)} lines inside their claim windows"
                    )

        # ── R2: structural disputes. The disagreeing minority under a STRUCTURAL verdict is exactly where
        # a repeat may be bound to the wrong occurrence (F2); the claim is the only occurrence-anchor
        # available, so the disputed lines are re-decoded inside their claim windows and the re-reconcile
        # decides whether the witnesses now meet.
        # STRUCTURAL repairs every disputed line (fine disagreement); COARSE repairs only the GROSSLY
        # displaced ones. The distinction is the Numb-vs-Avercage lesson: sub-second jitter against
        # loosely-timed captions must NOT be "repaired" (a re-decode there regresses — Numb), but a line
        # sitting seconds from its claim in an otherwise-coarse sheet is unambiguously misbound and the
        # claim is the only anchor for it (Avercage: 6 gross lines COARSE left unfixed until this branch).
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
                if line.index in disputed_indexes and line.index in claim_windows
            ]
            if disputed_lines:
                repaired = adopt_where_unheard(
                    await asyncio.to_thread(rerun, [claim_run(line) for line in disputed_lines])
                )
                if repaired:
                    repaired_all |= set(repaired)
                    generated = _with_lines(generated, repaired)
                    verdict = rc.reconcile(generated.lines, claimed)
                    fit = await asyncio.to_thread(fit_of, generated)
                    repairs.append(
                        f"re-decoded {len(repaired)} of {len(disputed_lines)} disputed lines "
                        "inside their claim windows"
                    )

        if repaired_all:
            # A repair may not introduce what verify punishes: spans clipped to neighbours (found live).
            generated = _clamped(generated, repaired_all)

        if adopted:
            repairs.append(f"adopted {len(adopted)} claim timings where the decode heard nothing")

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
        def _passes(f: activity.ShiftFit) -> bool:
            return (
                (f.usable and abs(f.seconds) <= 0.5)
                or (f.correlation >= 0.25 and abs(f.seconds) <= 0.1)
                or (f.correlation >= 0.60)  # shape agrees; lag is an offset, not wrong text
            )

        if not (_passes(blind_fit) or _passes(fit)):
            await decline(
                f"envelope gate refused: blind r={blind_fit.correlation:.2f} @ "
                f"{blind_fit.seconds:+.2f}s, repaired r={fit.correlation:.2f} @ {fit.seconds:+.2f}s"
                + (f"; repairs tried: {'; '.join(repairs)}" if repairs else "")
            )
            return None

        corroborated = {j.index for j in verdict.lines if j.corroborated}
        disputed = {j.index for j in verdict.lines if not j.corroborated}

        # UNRELATED means claims exist but disagree with our decode line-for-line — WHICH side is right
        # is unresolved, so no line here can honestly claim `high`. Same for NO_CLAIMS on repeat-heavy
        # text (F2). Found on hello: 3 unique lines were labelled `high` while sitting 3–51 s off,
        # because with an UNRELATED verdict `corroborated` was empty and the fallback used blind-uniqueness.
        claims_disagree = bool(claimed) and verdict.verdict == rc.UNRELATED

        def line_confidence(index: int) -> str:
            if index in adopted:
                # An adopted line ECHOES the claim; the re-reconcile above would count it corroborated,
                # but agreement with evidence you copied is not agreement.
                return "low"
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
        # reaches the trail through `verdict.why` below.
        report = measure.measure(doc, duration_sec=req.audio.duration_sec)
        if report.words == 0:
            await decline("generated document measured zero timed words")
            return None

        graded_high = sum(1 for line in generated.lines if line_confidence(line.index) == "high")
        confidence = "high" if graded_high >= 0.7 * len(generated.lines) else "medium"
        timed = self._write(req, doc, TIMING_WORD, confidence, report=report)
        # The evidence on the trail, not just the verdict: this line is what makes a wrong-lyrics report
        # debuggable from the audit page. Fire-and-forget would drop it on a closed socket; awaited.
        await self._out.state(
            req.job.job_id,
            "align-global",
            0,
            verdict.verdict,
            f"envelope r={blind_fit.correlation:.2f} (blind), r={fit.correlation:.2f} (repaired); "
            f"{verdict.why}; "
            + (f"{'; '.join(repairs)}; " if repairs else "")
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
        segments = list(req.text.segments)
        if req.text.has_own_timings:
            fitted = self._fit_to_activity(req, segments)
            if fitted is not None:
                segments = list(fitted)
        if not req.reshift or not req.reference_starts:
            return tuple(segments)
        shift = place.estimate_shift_from_starts(
            [start for start, _end in measure.line_spans(segments)], list(req.reference_starts)
        )
        return place.apply_shift(segments, shift)

    def _fit_to_activity(self, req: TimeRequest, segments: Sequence[Segment]) -> tuple[Segment, ...] | None:
        """Shift a timed sheet onto the audio's own vocal activity, or None when the fit is not trustworthy.

        PREFERS THE VOCALS STEM. Measured residuals are 10-20 ms against it and 140-150 ms against the full
        mix, because an instrumental bed fills the silences the fit reads. Both are worth doing; `on_mix` is
        honoured so a retry that deliberately moved to the mix is fitted against what it will align on.

        NEVER RAISES. This is an improvement on the status quo, not a requirement of it: an unreadable file,
        a sheet the estimator refuses, or a numpy that is not installed all leave the sheet exactly where it
        was, which is the behaviour that shipped before this existed.
        """
        spans = [(start, end) for start, end in measure.line_spans(list(segments)) if end > start]
        if len(spans) < place.MIN_PAIRS:
            return None
        try:
            from encore_worker.adapters.ml import load_audio_mono_16k  # noqa: PLC0415
            from encore_worker.domain.audio import activity  # noqa: PLC0415

            # ffmpeg-backed, so a MIX target (`original.webm`) fits too — the same live-found gap as v2's
            # envelope gate; read_wav_mono reads only WAV/FLAC.
            signal = load_audio_mono_16k(req.audio.align_target(on_mix=req.on_mix))
            fit = activity.fit_sheet_to_audio(signal, 16000, spans)
        except Exception:  # noqa: BLE001 - see the docstring: a failed fit must leave the sheet alone
            return None
        if not fit.usable:
            return None
        return place.apply_shift(
            list(segments),
            place.Shift(
                offset_sec=fit.seconds,
                scale=1.0,
                pairs=len(spans),
                applied=True,
                why=f"vocal-activity fit r={fit.correlation:.2f}",
            ),
        )

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
        """Write the document under a ref the core can merge on, and build the record."""
        from encore_worker.domain.lyrics.report import TimingReport

        measured = (
            report
            if isinstance(report, TimingReport)
            else measure.measure(doc, duration_sec=req.audio.duration_sec)
        )
        ref = f"derived/lyrics/{req.job.media_id}-{req.text.label.replace(':', '-')}-{timing}.json"
        absolute = os.path.join(req.job.media_dir, ref)
        os.makedirs(os.path.dirname(absolute), exist_ok=True)
        with open(absolute, "w", encoding="utf-8") as handle:
            json.dump(doc, handle, ensure_ascii=False)
        return TimedDoc(
            ref=ref,
            timing=timing,
            confidence=confidence,
            report=measured,
            language=req.language,
            label=req.text.label,
            line_starts=self._aligned_line_starts(doc),
        )

    async def diarize(self, job: JobRef, audio: AudioRef, doc: TimedDoc) -> TimedDoc:
        """Attach a singer to each line, REWRITING the published document.

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
                return doc  # nothing useful to add: one voice, or no line the turns could account for
            with open(absolute, "w", encoding="utf-8") as handle:
                json.dump(annotated, handle, ensure_ascii=False)
        except (OSError, ValueError):
            # The document is already published-shaped and correct without speakers; a rewrite that
            # failed halfway is the one outcome worth guarding, and json.dump to a fresh handle either
            # replaces the file or leaves the previous bytes.
            return doc
        return doc

    # ── publication ──────────────────────────────────────────────────────────────────────────────

    async def publish(self, job: JobRef, doc: TimedDoc | None) -> str:
        """THE GUARDED STEP. Re-asserts ownership before making anything visible.

        The check is HERE and not only at reconnect, because a lease can expire during a 45-minute
        alignment: a workflow that legitimately owned its job when the socket came back can be
        reassigned before it reaches this line. Checking only at reconnect leaves exactly the window
        where two workers publish different lyrics for one song.
        """
        if not await self._out.confirm_ownership(job.job_id):
            raise NotOurJob(self._out.explain_ownership(job.job_id))
        # Nothing before this point was externally visible, so there is nothing to undo.
        return doc.ref if doc is not None else ""

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


class _Permanent(RuntimeError):
    """A fault no retry can fix: a capability this box does not have."""

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


def _word_doc(aligned: Sequence[Segment], language: str) -> dict[str, object]:
    """The aligner's output in the core's document shape."""
    return {"language": language, "lines": [dict(line) for line in aligned]}


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


def _with_lines(generated: Generated, repaired: Mapping[int, Line]) -> Generated:
    """`generated` with repaired lines swapped in by index — order and identity preserved."""
    from encore_worker.domain.lyrics.generate import Generated  # noqa: PLC0415

    return Generated(
        lines=tuple(repaired.get(line.index, line) for line in generated.lines),
        language=generated.language,
    )


def _clamped(generated: Generated, repaired: set[int]) -> Generated:
    """Repaired lines clipped to their neighbours, so a repair can never introduce an overlap.

    Only REPAIRED lines move: a trusted decode line's overlap (real backing-vocal overlap exists) is a
    measurement and stays. A repaired line measured inside a padded window, or an adopted claim span that
    overlaps the next caption, is re-fitted affinely into the free gap — found live, where two spilled
    words made `decide` degrade an otherwise-corroborated document to line sync.
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
            high = max(high, low + 0.2)
            if abs(low - line.start) > 1e-9 or abs(high - line.end) > 1e-9:
                line = remapped(line, low, high)
        out.append(line)
    return Generated(lines=tuple(out), language=generated.language)


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
