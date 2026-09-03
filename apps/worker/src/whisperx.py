"""Word-aligned lyrics pipeline (HYBRID): yt-dlp (fetch) → LRCLIB (known lyrics text) →
WhisperX FORCED-ALIGNMENT (word timings on the correct text) → normalized lyrics JSON written to
the MediaStore (consumed by the bouncing-ball TV overlay).

Why hybrid: WhisperX transcribing sung vocals from scratch is the unreliable ASR path. Instead we
pull HUMAN-authored lyrics from LRCLIB (Stage 2) and use WhisperX's wav2vec2 `align()` to place
WORD timestamps on that KNOWN text — far more robust. If the aligner is unavailable (no model /
aarch64 torchcodec gap / a raised error) we FALL BACK to LRCLIB's line-level sync, so the feature
still ships lyrics.

The PURE half (segment build, align-output→normalized transform, validity) has no torch and is
fully unit-tested via an INJECTABLE Aligner seam + a fake fetcher; the real WhisperX + LRCLIB fetch
run only on a worker box. Mirrors demucs.py / lyrics_source.py.
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from typing import Any, AsyncIterator, Callable, Protocol

from .demucs import Runner, download_argv, is_local_source, parse_ytdlp_progress, subprocess_runner
from .lyrics_source import (
    LRCLIB_BASE,
    LrclibClient,
    entries_to_segments,
    is_line_synced,
    line_synced_lyrics,
    parse_lrc,
    plain_lyrics_to_segments,
)
from .lyrics_chain import (
    SOURCE_ASR,
    SUSPECT_AGREEMENT,
    TIMING_LINE,
    TIMING_WORD,
    AsrSource,
    LrclibSource,
    LyricsRequest,
    LyricsSource,
    LyricsText,
    acquire,
    candidate_key,
    score_against_asr,
)
from .lyrics_presplit import presplit_texts
from .processor import CompleteResult, JobSpec, ProgressEvent, source_audio_path, vocals_path

DEFAULT_MODEL = "base"  # kept for back-compat / the ASR-fallback path; alignment uses wav2vec2

# How often to emit a keepalive ProgressEvent while a blocking ML call runs. MUST stay comfortably
# under the core's progressLeaseMs (30 s, leases.ts) or the reaper requeues a healthy job.
LEASE_KEEPALIVE_SEC = 10.0

# ONE in-process lock guarding every real ML call (transcribe + align).
#
# Necessary because of the thread offload above: a single WhisperXProcessor serves every align job, and
# it caches ONE whisper model and ONE align model. With ENCORE_WORKER_CONCURRENCY>1 two align jobs run
# at once, so before the offload the blocked event loop serialized them by accident — now they are real
# threads sharing one model. faster-whisper / whisperx models are not thread-safe, and the lazy loaders
# also had a check-then-set race that could load the model twice and double the memory.
#
# Shared between transcribe and align rather than one lock each, deliberately: both are CPU-bound on the
# same cores, so serialising them costs no throughput and avoids two ML passes oversubscribing the box.
# RLock because the public methods call the lazy loader while already holding it.
_ML_LOCK = threading.RLock()


def lyrics_key(media_id: str) -> str:
    """Deterministic MediaStore key (Media-relative) for a media's aligned-lyrics artifact."""
    return f"derived/lyrics/{media_id}.json"


def _round_ms(x: Any) -> float | None:
    """Coerce a timestamp to a number rounded to ms, or None if it isn't a finite number."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if v != v or v in (float("inf"), float("-inf")):  # NaN / inf
        return None
    return round(v, 3)


# ── pure: WhisperX align output → normalized artifact ────────────────────────────────
def normalize_lyrics(raw: dict[str, Any]) -> dict[str, Any]:
    """Transform WhisperX (transcribe OR align) output into the artifact the TV overlay consumes.

    Input shape:  { language?, segments: [{ start, end, text, words: [{word,start,end,score}] }] }.
    Output shape: { language, lines: [{ start, end, text, words: [{word,start,end}] }],
                    words: [flattened {word,start,end}] }.
    Defensive: drops words missing usable start/end (whisperx align leaves some tokens un-timed),
    derives a line's [start,end] from its words when segment bounds are absent, and drops a segment
    that has neither timed words nor line bounds — model output is UNTRUSTED.
    """
    language = raw.get("language") if isinstance(raw.get("language"), str) else None
    lines: list[dict[str, Any]] = []
    flat_words: list[dict[str, Any]] = []

    for seg in raw.get("segments") or []:
        if not isinstance(seg, dict):
            continue
        words: list[dict[str, Any]] = []
        for w in seg.get("words") or []:
            if not isinstance(w, dict):
                continue
            text = w.get("word")
            start, end = _round_ms(w.get("start")), _round_ms(w.get("end"))
            if not isinstance(text, str) or not text.strip() or start is None or end is None:
                continue  # un-timed / empty token → drop (can't drive a bouncing ball)
            word = {"word": text.strip(), "start": start, "end": end}
            words.append(word)
            flat_words.append(word)

        text = seg.get("text")
        line_text = text.strip() if isinstance(text, str) else " ".join(w["word"] for w in words)
        if not line_text:
            continue
        l_start = _round_ms(seg.get("start"))
        l_end = _round_ms(seg.get("end"))
        if l_start is None and words:
            l_start = words[0]["start"]
        if l_end is None and words:
            l_end = words[-1]["end"]
        if not words and (l_start is None or l_end is None):
            continue
        lines.append({"start": l_start, "end": l_end, "text": line_text, "words": words})

    return {"language": language, "lines": lines, "words": flat_words}


def is_valid_lyrics(doc: dict[str, Any]) -> bool:
    """A WORD-timed artifact: ≥1 line with ≥1 timed word (the forced-alignment success bar)."""
    lines = doc.get("lines")
    if not isinstance(lines, list) or not lines:
        return False
    return any(isinstance(l, dict) and l.get("words") for l in lines)


def lrclib_to_segments(res: Any, total_duration: float | None) -> list[dict[str, Any]]:
    """Turn an LrclibResult into the [{start,end,text}] transcript the aligner consumes: prefer the
    line-timed syncedLyrics (LRC), else evenly distribute plainLyrics across the track. Empty if the
    track is instrumental / has no usable lyrics."""
    if res is None or getattr(res, "instrumental", False):
        return []
    if getattr(res, "has_synced", False):
        return entries_to_segments(parse_lrc(res.synced_lyrics), total_duration)
    if getattr(res, "has_plain", False):
        return plain_lyrics_to_segments(res.plain_lyrics, total_duration)
    return []


# ── the transcriber seam ─────────────────────────────────────────────────────
class Transcriber(Protocol):
    """ASR: invent the text from audio. Mirrors `Aligner` — same shape out, injectable, raising means
    "this tier missed" rather than "the job failed".

    Distinct from the aligner on purpose. Alignment places timings on text we already trust; ASR
    GUESSES the words, so its output is never authoritative no matter how confident the model sounds.
    It earns its place anyway because it is the only tier that needs nothing external, it yields
    WORD timings directly, and comparing its transcript against an authoritative lookup is the only
    signal that catches a confidently wrong LRCLIB match (see agreementScore in shared/lyrics.ts).
    """

    def transcribe(self, audio_path: str, language: str | None = None) -> dict[str, Any]: ...


class WhisperxTranscriber:
    """Real ASR via faster-whisper through whisperx.load_model().transcribe().

    Runs on the VOCALS STEM, not the mix — see AsrSource. `language=None` lets whisper DETECT the
    language, which is worth more than the caller's guess: nothing populates the sidecar's language
    field today, so the alternative is a hardcoded 'en'.
    """

    def __init__(self, device: str = "cpu", model: str = DEFAULT_MODEL, compute_type: str | None = None) -> None:
        self._device = device
        self._model_name = model
        # int8 on CPU: float16 is a GPU format and faster-whisper refuses it on CPU.
        self._compute_type = compute_type or ("float16" if device.startswith("cuda") else "int8")
        self._model: Any = None

    def _load(self) -> Any:
        with _ML_LOCK:
            if self._model is None:
                import whisperx  # lazy: multi-GB torch stays off the import path until this tier runs

                self._model = whisperx.load_model(
                    self._model_name, self._device, compute_type=self._compute_type
                )
            return self._model

    def transcribe(self, audio_path: str, language: str | None = None) -> dict[str, Any]:
        import whisperx

        audio = whisperx.load_audio(audio_path)
        with _ML_LOCK:  # one model, possibly two concurrent align jobs — see _ML_LOCK
            out = self._load().transcribe(audio, language=language)
        if language and not out.get("language"):
            out["language"] = language
        return out


# ── the aligner seam (injectable so the flow tests with NO torch) ─────────────────────
class Aligner(Protocol):
    """Force-align KNOWN text to audio. Given [{start,end,text}] segments + an audio path, return a
    WhisperX-shaped {language?, segments:[{start,end,text,words:[{word,start,end}]}]} with word
    timings. The real impl (WhisperxForcedAligner) wraps whisperx.load_align_model + whisperx.align;
    tests pass a fake. Raising signals the caller to fall back to line-sync."""

    def align(self, segments: list[dict[str, Any]], audio_path: str, language: str) -> dict[str, Any]: ...


class WhisperxForcedAligner:
    """Real forced aligner: loads the wav2vec2 align model for `language` and runs whisperx.align on
    the provided (known-text) segments. Lazy-imports whisperx so torch never loads unless used."""

    def __init__(self, device: str = "cpu") -> None:
        self._device = device
        self._cache: dict[str, tuple[Any, Any]] = {}

    def _model(self, language: str) -> tuple[Any, Any]:
        with _ML_LOCK:
            if language not in self._cache:
                import whisperx  # lazy: multi-GB torch

                self._cache[language] = whisperx.load_align_model(language_code=language, device=self._device)
            return self._cache[language]

    def align(self, segments: list[dict[str, Any]], audio_path: str, language: str) -> dict[str, Any]:
        import whisperx

        audio = whisperx.load_audio(audio_path)
        with _ML_LOCK:  # shared model across concurrent align jobs — see _ML_LOCK
            model, meta = self._model(language)
            # return_char_alignments=False → word-level only (what the overlay needs)
            out = whisperx.align(segments, model, meta, audio, self._device, return_char_alignments=False)
        out.setdefault("language", language)
        return out


# ── the processor ──────────────────────────────────────────────────────────────────
LyricsClientFactory = Callable[[], LrclibClient]


class WhisperXProcessor:
    """Production processor for `align` jobs. Fetch source → LRCLIB known lyrics →
    WhisperX forced-alignment (word timings) → publish; falls back to LRCLIB line-sync if the
    aligner is unavailable. Same async-generator interface as the other processors — dial_home.py
    is unchanged. All external deps (yt-dlp runner, LRCLIB client, aligner) are injectable for tests."""

    def __init__(
        self,
        *,
        runner: Runner = subprocess_runner,
        ytdlp_bin: str = "yt-dlp",
        device: str = "cpu",
        lyrics_client: LrclibClient | None = None,
        aligner: Aligner | None = None,
        transcriber: Transcriber | None = None,
        model: str = DEFAULT_MODEL,
        lrclib_base: str = LRCLIB_BASE,
        sources: list[LyricsSource] | None = None,
    ) -> None:
        self._runner = runner
        self._ytdlp_bin = ytdlp_bin
        self._device = device
        self._model = model
        self._lrclib_base = lrclib_base
        self._lyrics_client = lyrics_client  # None → constructed lazily (real LRCLIB)
        self._aligner = aligner  # None → constructed lazily (real WhisperX)
        self._transcriber = transcriber  # None → constructed lazily (real faster-whisper)
        # None → the default chain, built lazily. Injecting FAKE sources is how the whole
        # acquisition+timing flow tests with no network and no ML.
        self._sources = sources

    def _client(self) -> LrclibClient:
        if self._lyrics_client is None:
            self._lyrics_client = LrclibClient(base_url=self._lrclib_base)
        return self._lyrics_client

    def _get_sources(self) -> list[LyricsSource]:
        """The acquisition chain. LRCLIB first (authoritative + often line-timed); the ASR tier joins
        plus ASR and captions. Order is informational only — `acquire` runs them ALL and
        `pickBestLyrics` (TS) decides what the TV shows."""
        if self._sources is None:
            self._sources = [
                LrclibSource(self._client(), lrclib_to_segments),
                AsrSource(self._get_transcriber(), normalize_lyrics),
            ]
        return self._sources

    def _get_transcriber(self) -> Transcriber:
        if self._transcriber is None:
            self._transcriber = WhisperxTranscriber(device=self._device, model=self._model)
        return self._transcriber

    def _get_aligner(self) -> Aligner:
        if self._aligner is None:
            self._aligner = WhisperxForcedAligner(device=self._device)
        return self._aligner

    async def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        work = os.path.join(job.media_dir, "work", job.job_id)
        os.makedirs(work, exist_ok=True)
        params = job.params if isinstance(job.params, dict) else {}
        artist = str(params.get("artist") or "").strip()
        track = str(params.get("track") or "").strip()
        language = str(params.get("language") or "en").strip() or "en"
        duration = params.get("durationSec")
        duration = float(duration) if isinstance(duration, (int, float)) else None

        # ── stage 1: obtain the source audio ──────────────────────────────────────
        # Reuse the retained raw original if a stems job already fetched it. An align job for a
        # cooked song therefore costs no network at all, instead of re-downloading bytes we kept.
        if is_local_source(job.source_uri):
            audio = job.source_uri if os.path.isabs(job.source_uri) else os.path.join(job.media_dir, job.source_uri)
        else:
            audio = source_audio_path(job.media_dir, job.media_id)
            os.makedirs(os.path.dirname(audio), exist_ok=True)
            if not os.path.exists(audio):
                async for ev in self._run_stage("downloading", download_argv(job.source_uri, audio, self._ytdlp_bin), parse_ytdlp_progress):
                    yield ev
            else:
                yield ProgressEvent(stage="downloading", pct=100)

        # ── stage 2: ACQUIRE text from every source ──────────────────────
        # Independently, not first-hit: authoritative text and ASR are complements (the ideal artifact
        # is authoritative text force-aligned), and a dead LRCLIB must degrade the RESULT, not fail the
        # job. Missing params are no longer fatal — the LRCLIB source simply declines.
        req = LyricsRequest(
            media_id=job.media_id,
            artist=artist or None,
            track=track or None,
            duration=duration,
            audio_path=audio,
            vocals_path=self._vocals_path(job),
        )
        # Run acquisition in a THREAD and keep emitting progress while it works (see _run_blocking).
        texts: list[LyricsText] = []
        async for kind, val in self._run_blocking(lambda: acquire(self._get_sources(), req), "aligning", 0):
            if kind == "progress":
                yield val
            else:
                texts = val
        if not texts:
            raise RuntimeError(
                f"no lyrics text from any source for {artist or '?'} — {track or '?'} "
                "(instrumental, or every tier missed)"
            )

        # Re-lineate the AUTO-TRANSCRIBED texts only. A whisper segment is a VAD chunk of up
        # to ~30s — several lyric lines as one blob — whereas every authoritative tier already arrives
        # line-broken by a human, so the gate is `is_authoritative_text` and not a blanket pass. Done
        # HERE, before timing, so the aligner gets a per-LINE search window instead of one 30s window
        # spanning four lines; see lyrics_presplit for the division of labour with upstream.
        #
        # Before agreement scoring on purpose: scoring compares token SETS (splitting cannot change
        # them) but the demotion below sets text_confidence='low' on a suspect lookup, which would
        # flip it to non-authoritative and hand human-authored lines to a splitter that can only
        # damage them. A wrong-song lookup is still wrong in tidy human lines.
        texts = presplit_texts(texts)

        # ── stage 3: TIMING — force-align each text; degrade to its own line sync ─
        yield ProgressEvent(stage="aligning", pct=0)
        # Score every authoritative text against the ASR transcript BEFORE timing anything: a lookup that
        # disagrees with what is actually sung is probably a different song, and it must not be presented
        # as the authoritative words. Demoting its confidence to `low` makes isAuthoritativeText() false
        # in shared/lyrics.ts, which drops it below ASR in the ranking AND makes the TV label it — no
        # separate "suspect" concept needed anywhere downstream.
        agreements = score_against_asr(texts)
        for text in texts:
            score = agreements.get(text.text_source)
            if score is not None and score < SUSPECT_AGREEMENT:
                print(
                    f"[worker] lyrics from {text.text_source} disagree with the vocals "
                    f"(agreement {score:.2f} < {SUSPECT_AGREEMENT}) — probably the WRONG SONG; "
                    "demoting it to unverified",
                    flush=True,
                )
                text.text_confidence = "low"
        candidates: list[dict[str, Any]] = []
        for text in texts:
            built = None
            async for kind, val in self._run_blocking(
                lambda t=text: self._time_one(t, audio, language), "aligning", 50
            ):
                if kind == "progress":
                    yield val
                else:
                    built = val
            if built is None:
                continue
            doc, timing, timing_confidence = built
            ref = candidate_key(job.media_id, text.text_source, timing)
            final = os.path.join(job.media_dir, ref)
            os.makedirs(os.path.dirname(final), exist_ok=True)
            with open(final, "w", encoding="utf-8") as f:
                json.dump(doc, f, ensure_ascii=False)
            candidates.append(
                {
                    "ref": ref,
                    "textSource": text.text_source,
                    "timing": timing,
                    "textConfidence": text.text_confidence,
                    "timingConfidence": timing_confidence,
                    "language": doc.get("language") or text.language or language,
                    "createdAt": int(time.time() * 1000),
                    **({"agreement": agreements[text.text_source]} if text.text_source in agreements else {}),
                }
            )
        if not candidates:
            raise RuntimeError("text was acquired but nothing could be timed (no word or line sync)")
        yield ProgressEvent(stage="aligning", pct=100)

        # ── stage 4: publish ──────────────────────────────────────────────────────
        # `uri` is the FIRST candidate, not the best one. Ranking lives in exactly one place —
        # pickBestLyrics in packages/shared/src/lyrics.ts — and the core re-picks from `candidates` on
        # every write and every restore. A second ranking here was a copy of that tier logic
        # with nothing pinning the two together, so it could drift silently; `uri` only still exists so
        # a CompleteResult has a media_uri and a pre-C5 core would get something valid.
        best = candidates[0]
        yield CompleteResult(
            media_uri=os.path.join(job.media_dir, best["ref"]),
            artifacts={
                "lyrics": {
                    "uri": os.path.join(job.media_dir, best["ref"]),
                    "candidates": candidates,
                }
            },
        )

    async def _run_blocking(self, fn: Any, stage: str, pct: int) -> AsyncIterator[tuple[str, Any]]:
        """Run a BLOCKING call in a thread, yielding ("progress", ev) keepalives until it finishes,
        then ("result", value) exactly once.

        Both halves matter, and both were real failures observed on a live cook:

          1. torch/whisper calls are synchronous. Awaiting them inline froze the asyncio event loop for
             the whole ML pass, so the worker could not answer the websocket keepalive ping and the
             server closed the connection mid-job ("keepalive ping timeout").
          2. With the loop frozen, no job:progress could be sent either, so the core's 30 s PROGRESS
             LEASE expired and the reaper requeued a job that was running fine — observed as
             attempts=1 on a job that never actually failed. Each retry costs a full ASR + align pass,
             so with maxAttempts=3 a slightly slower song fails permanently after minutes of CPU.

        Demucs never hit this because it is a subprocess awaited through asyncio; in-process ML is not.
        """
        task = asyncio.ensure_future(asyncio.to_thread(fn))
        while True:
            done, _ = await asyncio.wait({task}, timeout=LEASE_KEEPALIVE_SEC)
            if task in done:
                yield ("result", task.result())  # raises here if fn raised — same as a direct call
                return
            yield ("progress", ProgressEvent(stage=stage, pct=pct))

    def _vocals_path(self, job: JobSpec) -> str | None:
        """The isolated vocals stem for this media, if a stems job already wrote one (ASR wants it)."""
        p = vocals_path(job.media_dir, job.media_id)
        return p if os.path.exists(p) else None

    def _time_one(
        self, text: LyricsText, audio: str, language: str
    ) -> tuple[dict[str, Any], str, str] | None:
        """Turn one acquired text into (doc, timing, timingConfidence), or None if unusable.

        Order: a source that ALREADY has word timings (ASR) keeps them; otherwise force-align, and on
        any aligner failure fall back to the source's own line timings. A source with neither is
        dropped rather than shipped as an unsynced wall of text — the floor is line-level sync.
        """
        lang = text.language or language
        if text.timing == TIMING_WORD:
            doc = normalize_lyrics({"language": lang, "segments": text.segments})
            if is_valid_lyrics(doc):
                return doc, TIMING_WORD, "medium"
        try:
            aligned = self._get_aligner().align(text.segments, audio, lang)
            doc = normalize_lyrics(aligned)
            if not is_valid_lyrics(doc):
                raise RuntimeError("aligner returned no word-timed lyrics")
            return doc, TIMING_WORD, "high"
        except Exception:  # noqa: BLE001 — degrade, never fail the whole job
            if text.timing != TIMING_LINE:
                return None  # nothing real to sync against
            doc = line_synced_lyrics(text.segments, language=lang)
            return (doc, TIMING_LINE, "high") if is_line_synced(doc) else None

    async def _run_stage(self, stage: str, argv: list[str], parse) -> AsyncIterator[ProgressEvent]:
        yield ProgressEvent(stage=stage, pct=0)
        last = -1
        async for line in self._runner(argv):
            pct = parse(line)
            if pct is not None and pct != last:
                last = pct
                yield ProgressEvent(stage=stage, pct=pct)
        if last < 100:
            yield ProgressEvent(stage=stage, pct=100)
