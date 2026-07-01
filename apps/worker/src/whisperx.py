"""Word-aligned lyrics pipeline (M7-C8, HYBRID): yt-dlp (fetch) → LRCLIB (known lyrics text) →
WhisperX FORCED-ALIGNMENT (word timings on the correct text) → normalized lyrics JSON written to
the MediaStore (consumed by the M8 bouncing-ball TV overlay).

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

import json
import os
from typing import Any, AsyncIterator, Callable, Protocol

from .demucs import Runner, download_argv, is_local_source, parse_ytdlp_progress, subprocess_runner
from .lyrics_source import (
    LrclibClient,
    entries_to_segments,
    is_line_synced,
    line_synced_lyrics,
    parse_lrc,
    plain_lyrics_to_segments,
)
from .processor import CompleteResult, JobSpec, ProgressEvent

DEFAULT_MODEL = "base"  # kept for back-compat / the ASR-fallback path; alignment uses wav2vec2


def lyrics_key(media_id: str) -> str:
    """Deterministic MediaStore key (Media-relative) for a media's aligned-lyrics artifact."""
    return f"lyrics/{media_id}.json"


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
        if language not in self._cache:
            import whisperx  # lazy: multi-GB torch

            self._cache[language] = whisperx.load_align_model(language_code=language, device=self._device)
        return self._cache[language]

    def align(self, segments: list[dict[str, Any]], audio_path: str, language: str) -> dict[str, Any]:
        import whisperx

        model, meta = self._model(language)
        audio = whisperx.load_audio(audio_path)
        # return_char_alignments=False → word-level only (what the overlay needs)
        out = whisperx.align(segments, model, meta, audio, self._device, return_char_alignments=False)
        out.setdefault("language", language)
        return out


# ── the processor ──────────────────────────────────────────────────────────────────
LyricsClientFactory = Callable[[], LrclibClient]


class WhisperXProcessor:
    """Production processor for `align` jobs (M7-C8 hybrid). Fetch source → LRCLIB known lyrics →
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
        model: str = DEFAULT_MODEL,
    ) -> None:
        self._runner = runner
        self._ytdlp_bin = ytdlp_bin
        self._device = device
        self._model = model
        self._lyrics_client = lyrics_client  # None → constructed lazily (real LRCLIB)
        self._aligner = aligner  # None → constructed lazily (real WhisperX)

    def _client(self) -> LrclibClient:
        if self._lyrics_client is None:
            self._lyrics_client = LrclibClient()
        return self._lyrics_client

    def _get_aligner(self) -> Aligner:
        if self._aligner is None:
            self._aligner = WhisperxForcedAligner(device=self._device)
        return self._aligner

    async def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        work = os.path.join(job.media_dir, "lyrics", "_work", job.media_id)
        os.makedirs(work, exist_ok=True)
        params = job.params if isinstance(job.params, dict) else {}
        artist = str(params.get("artist") or "").strip()
        track = str(params.get("track") or "").strip()
        language = str(params.get("language") or "en").strip() or "en"
        duration = params.get("durationSec")
        duration = float(duration) if isinstance(duration, (int, float)) else None

        # ── stage 1: obtain the source audio ──────────────────────────────────────
        if is_local_source(job.source_uri):
            audio = job.source_uri if os.path.isabs(job.source_uri) else os.path.join(job.media_dir, job.source_uri)
        else:
            audio = os.path.join(work, "source.wav")
            async for ev in self._run_stage("downloading", download_argv(job.source_uri, audio, self._ytdlp_bin), parse_ytdlp_progress):
                yield ev

        # ── stage 2: fetch KNOWN lyrics from LRCLIB ───────────────────────────────
        if not artist or not track:
            raise RuntimeError("align job needs params.artist + params.track to look up lyrics")
        res = self._client().get(artist, track, duration=duration)
        segments = lrclib_to_segments(res, duration)
        if not segments:
            raise RuntimeError(f"no lyrics found for {artist} — {track} (instrumental or not in LRCLIB)")

        # ── stage 3: force-align the known text (word timings), else line-sync ────
        yield ProgressEvent(stage="aligning", pct=0)
        doc: dict[str, Any]
        try:
            aligned = self._get_aligner().align(segments, audio, language)
            doc = normalize_lyrics(aligned)
            if not is_valid_lyrics(doc):
                raise RuntimeError("aligner returned no word-timed lyrics")
        except Exception as exc:  # noqa: BLE001 — any aligner failure degrades to line-sync, never a 500
            # FALLBACK: ship LRCLIB's line-level sync (whole-line highlight) so lyrics still work.
            doc = line_synced_lyrics(segments, language=language)
            if not is_line_synced(doc):
                raise RuntimeError(f"alignment failed and no line-sync fallback available: {exc}") from exc
        yield ProgressEvent(stage="aligning", pct=100)

        # ── stage 4: publish the lyrics JSON ──────────────────────────────────────
        final = os.path.join(job.media_dir, lyrics_key(job.media_id))
        os.makedirs(os.path.dirname(final), exist_ok=True)
        with open(final, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False)
        yield CompleteResult(media_uri=final, artifacts={"lyrics": {"uri": final}})

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
