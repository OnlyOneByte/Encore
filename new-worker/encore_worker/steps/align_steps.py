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
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

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
        """One alignment attempt: place, align, measure, write. `None` if nothing publishable resulted."""
        if self._a.aligner is None:
            return None

        segments = self._placed(req)
        if req.force_line_sync:
            # Terminal knob: publish the text's own line timings rather than word timings.
            return self._write(req, _line_doc(segments, req.language), TIMING_LINE, "low")

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
        """The text's segments, re-placed against the PREVIOUS ALIGNMENT when this attempt asked for it.

        An earlier version of this fitted the text against its own windows — two views of one series —
        which is a near-identity and made `Knob.RESHIFT` a no-op that burned an alignment pass. The
        reference has to be measured on this recording to be worth anything, and the only such series
        available is the previous attempt's output, which `TimeRequest.reference_starts` carries.

        With no reference the estimator abstains, which is the identity — correct for a first attempt.
        """
        segments = list(req.text.segments)
        if not req.reshift or not req.reference_starts:
            return tuple(segments)
        shift = place.estimate_shift_from_starts(
            [start for start, _end in measure.line_spans(segments)], list(req.reference_starts)
        )
        return place.apply_shift(segments, shift)

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


def now_ms() -> int:
    """Wall clock, isolated in a step layer. A workflow body must never call this — DBOS replays it."""
    return int(time.time() * 1000)
