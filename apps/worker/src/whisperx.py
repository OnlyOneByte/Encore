"""Word-aligned lyrics pipeline (HYBRID): yt-dlp (fetch) → LRCLIB (known lyrics text) →
WhisperX FORCED-ALIGNMENT (word timings on the correct text) → normalized lyrics JSON.

Why hybrid: transcribing sung vocals from scratch is the unreliable ASR path. Instead we pull
HUMAN-authored lyrics from LRCLIB and use wav2vec2 `align()` to place WORD timestamps on that KNOWN
text. If the aligner is unavailable (no model / aarch64 torchcodec gap / a raised error) we FALL
BACK to LRCLIB's line-level sync, so lyrics still ship.

The PURE half is unit-tested via an INJECTABLE Aligner seam + a fake fetcher; the real WhisperX +
LRCLIB fetch run only on a worker box.
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from typing import Any, AsyncIterator, Callable, Protocol

from .demucs import Runner, download_argv, parse_ytdlp_progress, subprocess_runner
from .fetch import job_fetcher, local_source_path
from .vocabulary import AsrModel, Fetcher, SyncMode, parse_asr_model, parse_sync_mode
from .lyrics import (
    LRCLIB_BASE,
    LrclibClient,
    entries_to_segments,
    is_line_synced,
    line_synced_lyrics,
    parse_lrc,
    plain_lyrics_to_segments,
)
from .lyrics import (
    SOURCE_ASR,
    SUSPECT_AGREEMENT,
    TIMING_LINE,
    TIMING_WORD,
    AsrSource,
    AutoCaptionsSource,
    CaptionsSource,
    LrclibSource,
    LyricsRequest,
    LyricsSource,
    LyricsText,
    acquire,
    candidate_key,
    select_by_baselines,
)
from .lyrics import caption_argv, read_captions
from .lyrics import presplit_texts
from .lyrics import validate_timing
from .processor import CompleteResult, JobSpec, ProgressEvent, source_audio_path, vocals_path

DEFAULT_MODEL = "base"  # kept for back-compat / the ASR-fallback path; alignment uses wav2vec2

# How often to emit a keepalive ProgressEvent while a blocking ML call runs. MUST stay comfortably
# under the core's progressLeaseMs (30 s, leases.ts) or the reaper requeues a healthy job.
LEASE_KEEPALIVE_SEC = 10.0

# ONE in-process RLock guarding every real ML call (transcribe + align). A single WhisperXProcessor
# serves every align job and caches ONE whisper model and ONE align model; with
# ENCORE_WORKER_CONCURRENCY>1 two align jobs run at once on threads sharing that model, and
# faster-whisper / whisperx models are not thread-safe. The lazy loaders also had a check-then-set
# race that could load the model twice and double the memory.
#
# Shared between transcribe and align rather than one lock each, deliberately: both are CPU-bound on
# the same cores, so serialising them costs no throughput and avoids two ML passes oversubscribing
# the box. RLock because the public methods call the lazy loader while already holding it.
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


def normalize_lyrics(raw: dict[str, Any]) -> dict[str, Any]:
    """Transform WhisperX (transcribe OR align) output into the artifact the TV overlay consumes.

    Input:  { language?, segments: [{ start, end, text, words: [{word,start,end,score}] }] }.
    Output: { language, lines: [{ start, end, text, words: [{word,start,end}] }], words: [flat] }.
    Defensive because model output is UNTRUSTED: drops words missing usable start/end (whisperx align
    leaves some tokens un-timed), derives a line's [start,end] from its words when segment bounds are
    absent, and drops a segment with neither timed words nor line bounds.
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


class Transcriber(Protocol):
    """ASR: invent the text from audio. Injectable; raising means "this tier missed", not "the job
    failed".

    Distinct from the aligner on purpose. Alignment places timings on text we already trust; ASR
    GUESSES the words, so its output is never authoritative however confident the model sounds. It
    earns its place because it needs nothing external and comparing its transcript against an
    authoritative lookup is the only signal that catches a confidently wrong LRCLIB match (see
    agreementScore in shared/lyrics.ts).
    """

    def transcribe(self, audio_path: str, language: str | None = None) -> dict[str, Any]: ...


class WhisperxTranscriber:
    """Real ASR via faster-whisper through whisperx.load_model().transcribe().

    Runs on the VOCALS STEM, not the mix (see AsrSource). `language=None` lets whisper DETECT the
    language: nothing populates the sidecar's language field today, so the alternative is a
    hardcoded 'en'.
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
        sync_mode: str = SyncMode.FORCED.value,
        lrclib_base: str = LRCLIB_BASE,
        sources: list[LyricsSource] | None = None,
    ) -> None:
        self._runner = runner
        self._ytdlp_bin = ytdlp_bin
        self._device = device
        self._model = parse_asr_model(model).value
        self._sync_mode = parse_sync_mode(sync_mode)
        self._lrclib_base = lrclib_base
        self._lyrics_client = lyrics_client  # None → constructed lazily (real LRCLIB)
        self._aligner = aligner  # None → constructed lazily (real WhisperX)
        self._transcriber = transcriber  # None → constructed lazily (real faster-whisper)
        # Whether the caller OWNS these. An injected transcriber or source list is a test's fake, and a
        # job's `asrModel` must never silently replace it — see `_adopt_job_engines`.
        self._transcriber_injected = transcriber is not None
        self._sources_injected = sources is not None
        # None → the default chain, built lazily. Injecting FAKE sources is how the whole
        # acquisition+timing flow tests with no network and no ML.
        self._sources = sources

    def _client(self) -> LrclibClient:
        if self._lyrics_client is None:
            self._lyrics_client = LrclibClient(base_url=self._lrclib_base)
        return self._lyrics_client

    def _get_sources(self) -> list[LyricsSource]:
        """The acquisition chain, in two tiers.

        CANDIDATES claim to be the song's words and get graded. BASELINES are evidence of what is audible
        and do the grading — see the role constants in lyrics_chain. `acquire` runs them ALL, then
        `select_by_baselines` grades every candidate against the mean of the baselines.

        Three baselines by design, with independent failure modes: the vocals stem gives the cleanest
        words, the mix is the only one that still speaks when separation produced silence (measured: 2 of
        9 stems on this library), and YouTube's automatic captions are a weak third opinion that abstains
        when too thin to judge with.
        """
        if self._sources is None:
            self._sources = [
                # candidates
                LrclibSource(self._client(), lrclib_to_segments),
                CaptionsSource(),
                # baselines
                AsrSource(self._get_transcriber(), normalize_lyrics, audio=AsrSource.AUDIO_VOCALS),
                AsrSource(self._get_transcriber(), normalize_lyrics, audio=AsrSource.AUDIO_MIX),
                AutoCaptionsSource(),
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

    def _adopt_job_engines(self, params: dict[str, Any]) -> None:
        """Adopt the deployment's lyrics engines from this job's params.

        The core sends its GLOBAL settings on every align job, exactly as it sends a separator's
        engine+model on a stems job, so an operator changing the model on the settings page takes
        effect on the next cook with no worker restart. Absent values keep whatever this worker was
        constructed with (its env fallback), so an older core changes nothing.

        Changing the model DROPS the cached transcriber, and with it the cached source list that holds
        it — otherwise AsrSource would keep transcribing with the previous weights while the log
        claimed otherwise. That reload is why the value is compared first: every job normally carries
        the same setting, so the common case rebuilds nothing.

        An INJECTED transcriber or source list is never replaced. Those are a test's fakes, and letting
        a wire value swap them would mean a test could accidentally load multi-GB real weights.
        """
        self._sync_mode = parse_sync_mode(params.get("syncMode"), self._sync_mode)
        model = parse_asr_model(params.get("asrModel"), AsrModel(self._model)).value
        if model == self._model:
            return
        print(f"[worker] align: ASR model {self._model} → {model} (reloading weights)", flush=True)
        self._model = model
        if not self._transcriber_injected:
            self._transcriber = None
            if not self._sources_injected:
                self._sources = None  # rebuilt around the new transcriber on next use

    async def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        work = os.path.join(job.media_dir, "work", job.job_id)
        os.makedirs(work, exist_ok=True)
        params = job.params if isinstance(job.params, dict) else {}
        self._adopt_job_engines(params)
        artist = str(params.get("artist") or "").strip()
        track = str(params.get("track") or "").strip()
        language = str(params.get("language") or "en").strip() or "en"
        duration = params.get("durationSec")
        duration = float(duration) if isinstance(duration, (int, float)) else None

        # ── stage 1: obtain the source audio ──────────────────────────────────────
        # Reuse the retained raw original if a stems job already fetched it — an align job for a
        # cooked song then costs no network.
        is_local = job_fetcher(job) is Fetcher.LOCAL
        if is_local:
            audio = local_source_path(job)
        else:
            audio = source_audio_path(job.media_dir, job.media_id)
            os.makedirs(os.path.dirname(audio), exist_ok=True)
            if not os.path.exists(audio):
                async for ev in self._run_stage("downloading", download_argv(job.source_uri, audio, self._ytdlp_bin), parse_ytdlp_progress):
                    yield ev
            else:
                yield ProgressEvent(stage="downloading", pct=100)

        # ── stage 1b: the upload's caption tracks, authored and automatic ────────
        # TWO fetches into TWO directories, never one. yt-dlp names both kinds identically, so a single
        # directory would leave "authored or machine-made" to a filename guess — and the two have
        # opposite roles: authored text is a CANDIDATE for the words, a machine track is only a BASELINE
        # for grading. See captions.py.
        #
        # Runs through the SAME injected runner as the audio download, so both are faked wherever that is.
        # Never fatal: yt-dlp exits non-zero when a video simply has no track of the kind asked for, which
        # is the common case and not a failure.
        #
        # Skipped for a DECLARED-LOCAL source, on the same rule as the audio above: a library file has no
        # upload to ask, so there is nothing to fetch and no reason to touch the network.
        caption_segments: list[dict[str, Any]] = []
        auto_caption_segments: list[dict[str, Any]] = []
        if job.source_uri and not is_local:
            for kind, auto in (("captions", False), ("auto-captions", True)):
                out_dir = os.path.join(work, kind)
                os.makedirs(out_dir, exist_ok=True)
                try:
                    async for ev in self._run_stage(
                        "downloading",
                        caption_argv(
                            job.source_uri, os.path.join(out_dir, "captions.%(ext)s"), self._ytdlp_bin, auto=auto
                        ),
                        parse_ytdlp_progress,
                    ):
                        yield ev
                except Exception as exc:  # noqa: BLE001 — no track / no yt-dlp / no network: all a miss
                    print(f"[worker] align: no {kind} for {job.media_id} ({exc})", flush=True)
                got = read_captions(out_dir)
                if auto:
                    auto_caption_segments = got
                else:
                    caption_segments = got
                if got:
                    role = "a BASELINE for grading" if auto else "an authoritative CANDIDATE"
                    print(
                        f"[worker] align: {job.media_id} has {len(got)} lines of {kind} — using as {role}",
                        flush=True,
                    )

        # ── stage 2: ACQUIRE text from every source ──────────────────────
        # Independently, not first-hit: authoritative text and ASR are complements (the ideal
        # artifact is authoritative text force-aligned), and a dead LRCLIB must degrade the RESULT,
        # not fail the job. Missing params are not fatal — the LRCLIB source simply declines.
        req = LyricsRequest(
            media_id=job.media_id,
            artist=artist or None,
            track=track or None,
            artist_credit=str(params.get("artistCredit") or "").strip() or None,
            duration=duration,
            audio_path=audio,
            vocals_path=self._vocals_path(job),
            caption_segments=caption_segments,
            auto_caption_segments=auto_caption_segments,
        )
        texts: list[LyricsText] = []
        async for kind, val in self._run_blocking(lambda: acquire(self._get_sources(), req), "aligning", 0):
            if kind == "progress":
                yield val
            else:
                texts = val
        if not texts:
            # "This song has no words" is a RESULT, not an error.
            #
            # This used to raise, which was defensible while lyrics were a garnish: a failed align left
            # a red job on a song that played fine. It stops being defensible the moment readiness
            # waits for align — a raise would mean a genuine instrumental (no lyrics by nature) could
            # NEVER become playable, stuck cooking forever on a step that is working correctly.
            #
            # Completing with no lyrics artifact says exactly what happened: alignment ran, found no
            # text in any tier, and there is nothing to time. Core marks the lyrics step settled and the
            # song finishes cooking with no words on screen.
            print(
                f"[worker] align: no lyrics text from any source for {artist or '?'} — {track or '?'} "
                "(instrumental, or every tier missed) — completing with no lyrics",
                flush=True,
            )
            yield CompleteResult(media_uri="", artifacts={})
            return

        # Re-lineate the AUTO-TRANSCRIBED texts only (a whisper segment is a ~30s VAD blob of several
        # lyric lines; authored tiers already arrive line-broken). See lyrics_presplit.
        #
        # Done BEFORE grading on purpose: the demotion later sets text_confidence='low' on a suspect
        # winner, which would flip it non-authoritative and hand human-authored lines to a splitter that
        # can only damage them. (Grading itself compares token SETS, which splitting cannot change.)
        texts = presplit_texts(texts)

        # ── stage 2b: GRADE the candidates against the baselines ──────────────────
        # The two-tier decision, made BEFORE anything is aligned — so grading five candidates against
        # three baselines costs fifteen token-set intersections and no alignment at all.
        #
        # Only what `select_by_baselines` returns gets published and therefore aligned: the winning
        # candidate, plus the best baseline when the winner cannot be trusted (no candidate existed, or the
        # winner scored below SUSPECT_AGREEMENT and is probably a different song). A baseline published for
        # its own sake would cost a whole alignment pass to produce words nobody shows.
        sel = select_by_baselines(texts)
        for note in sel.baseline_notes:
            print(f"[worker] align: {job.media_id} baseline — {note}", flush=True)
        for choice in sel.choices:
            print(f"[worker] align: {job.media_id} lyrics version — {choice.summary()}", flush=True)
        if sel.baseline_fallback:
            print(
                f"[worker] align: {job.media_id} has NO authored lyrics candidate — falling back to the "
                f"best baseline ({sel.publish[0].variant if sel.publish else 'none'})",
                flush=True,
            )

        # THE ABSOLUTE JUDGEMENT, distinct from the comparative selection above. Argmax found the best
        # candidate; this asks whether even that one is about this song. Demoting to `low` makes
        # isAuthoritativeText() false in shared/lyrics.ts, so the TV labels it — and the baseline published
        # alongside gives the room real alternative words rather than only a warning on the wrong ones.
        if sel.winner_suspect:
            print(
                f"[worker] align: {job.media_id} best lyrics disagree with every baseline "
                f"(composite {sel.winner_score:.2f} < {SUSPECT_AGREEMENT}) — probably the WRONG SONG; "
                "demoting it and publishing what was actually heard alongside",
                flush=True,
            )
            sel.publish[0].text_confidence = "low"
        texts = sel.publish

        # ── stage 3: TIMING — force-align each text; degrade to its own line sync ─
        yield ProgressEvent(stage="aligning", pct=0)
        # THE AUDIO THE ALIGNER GETS. Prefer the isolated vocals stem; fall back to the mix only when
        # no stem exists (a song cooked before stems were retained).
        #
        # This was the bug: the aligner ran on the raw mix while the ASR tier — the SAME family of
        # wav2vec2 speech model — was correctly routed to the stem. Measured across six real artifacts
        # on the reference box, aligning on the mix produced one word smeared to 5.7s, 3-15 words per
        # song collapsed under 30ms, and gaps up to 63s where the aligner lost the vocal under the
        # band. The stem is already separated, already retained (~6MB/song) and already in this
        # request; nothing new is downloaded or computed to use it.
        align_audio = req.vocals_path or audio
        if req.vocals_path is None:
            print(
                f"[worker] align: no vocals stem for {job.media_id} — aligning against the MIX, "
                "which is materially less accurate. Re-cook to get a stem.",
                flush=True,
            )
        candidates: list[dict[str, Any]] = []
        for text in texts:
            built = None
            async for kind, val in self._run_blocking(
                lambda t=text: self._time_one(t, align_audio, language), "aligning", 50
            ):
                if kind == "progress":
                    yield val
                else:
                    built = val
            if built is None:
                continue
            doc, timing, timing_confidence = built
            # VALIDATE before publishing. `is_valid_lyrics` only asks whether SOME word has a
            # timestamp, which six real artifacts satisfied while containing a 63-second hole, a word
            # smeared across 5.7s, and function words at 20ms. Report every run so a bad cook leaves a
            # record, and refuse to publish WORD timing that would visibly misbehave — degrading to the
            # source's own line sync is worse per-word but never jumps backwards or freezes.
            if timing == TIMING_WORD:
                rep = validate_timing(doc, params.get("durationSec"))
                print(f"[worker] align: timing for {job.media_id} — {rep.summary()}", flush=True)
                if rep.thin_coverage:
                    # Deliberately does NOT blame ASR. Measured on real songs: a shortfall is usually
                    # CORRECT — an instrumental break or outro genuinely has no words. On Take On Me the
                    # vocals stem sits 18-28 dB below the instrumental through its synth break, and two
                    # independent Whisper models given only that clip both transcribe nothing, which is
                    # the right answer. Coverage is a prompt to look, not a diagnosis.
                    print(
                        f"[worker] align: {job.media_id} timing covers {rep.coverage:.0%} of the song. "
                        "Usually an instrumental break or outro; occasionally a media/duration mismatch "
                        "(timings aligned against a different upload than the duration on record).",
                        flush=True,
                    )
                if not rep.usable:
                    print(
                        f"[worker] align: REFUSING word timing for {job.media_id} "
                        f"({rep.out_of_order} out-of-order word(s)) — degrading to line sync",
                        flush=True,
                    )
                    if text.timing != TIMING_LINE:
                        continue  # nothing honest left to publish for this source
                    doc = line_synced_lyrics(text.segments, language=text.language or language)
                    timing, timing_confidence = TIMING_LINE, "low"
            ref = candidate_key(job.media_id, text.text_source, timing, text.tag)
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
                    # The COMPOSITE score, and only on the graded candidate. A baseline carries none by
                    # construction: it is the ruler, so scoring it would mean measuring it against itself.
                    **(
                        {"agreement": sel.winner_score}
                        if (text is sel.publish[0] and sel.winner_score is not None)
                        else {}
                    ),
                }
            )
        if not candidates:
            raise RuntimeError("text was acquired but nothing could be timed (no word or line sync)")
        yield ProgressEvent(stage="aligning", pct=100)

        # ── stage 4: publish ──────────────────────────────────────────────────────
        # `uri` is the FIRST candidate, not the best. Ranking lives in exactly one place —
        # pickBestLyrics in packages/shared/src/lyrics.ts — and the core re-picks from `candidates`
        # on every write and restore. A second ranking here would drift silently; `uri` exists only
        # so a CompleteResult has a media_uri and a pre-C5 core gets something valid.
        best = candidates[0]
        yield CompleteResult(
            media_uri=os.path.join(job.media_dir, best["ref"]),
            artifacts={
                "lyrics": {
                    "uri": os.path.join(job.media_dir, best["ref"]),
                    "candidates": candidates,
                }
            },
            # The lyrics axis, as RESOLVED on this processor: _adopt_job_engines has already folded the
            # job's params into these instance fields, applying its own default when the core sent
            # nothing or sent a value that has since been de-whitelisted. Device is deliberately absent
            # — it belongs to the transcriber/aligner, not here, and a guess would be worse than a null.
            facts={"asrModel": self._model, "syncMode": self._sync_mode.value},
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
        """The isolated vocals stem, if a stems job already wrote one.

        Wanted by BOTH consumers of this audio, for the same reason: they are both wav2vec2-family
        speech models, and a dense musical mix is not speech. ASR transcribes it; forced alignment
        times it.
        """
        p = vocals_path(job.media_dir, job.media_id)
        return p if os.path.exists(p) else None

    def _time_one(
        self, text: LyricsText, audio: str, language: str
    ) -> tuple[dict[str, Any], str, str] | None:
        """Turn one acquired text into (doc, timing, timingConfidence), or None if unusable.

        `audio` MUST be the isolated vocals stem when one exists — see the caller. Forced alignment is
        a wav2vec2 speech model, so aligning against a full mix smears word boundaries wherever the
        band is loud, which is measurable in the output as long words stretched across passages the
        aligner lost and short function words collapsed to ~20ms.

        Order: a source that ALREADY has word timings (ASR) keeps them; otherwise force-align, and on
        any aligner failure fall back to the source's own line timings. A source with neither is
        dropped rather than shipped as an unsynced wall of text — the floor is line-level sync.
        """
        lang = text.language or language
        if text.timing == TIMING_WORD:
            doc = normalize_lyrics({"language": lang, "segments": text.segments})
            if is_valid_lyrics(doc):
                return doc, TIMING_WORD, "medium"
        # SYNC MODE. `lines` skips forced alignment entirely rather than failing it — one fewer ML pass
        # per cook, at the cost of the bouncing ball. It takes the SAME path the aligner's failure
        # fallback takes, so there is one line-sync implementation rather than two that can drift.
        if self._sync_mode is SyncMode.LINES:
            if text.timing != TIMING_LINE:
                return None  # nothing to sync against, and this mode will not go and find timings
            doc = line_synced_lyrics(text.segments, language=lang)
            # `high` confidence: these are the source's own timings, unmodified. Whether they are RIGHT
            # for this recording is a different question — an LRC written for another upload of the song
            # is confidently wrong, which is why `forced` remains the default.
            return (doc, TIMING_LINE, "high") if is_line_synced(doc) else None
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
