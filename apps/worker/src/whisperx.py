"""Word-aligned lyrics pipeline (M7-C8): yt-dlp (fetch) → WhisperX (transcribe + word-align) →
normalized lyrics JSON written to the MediaStore (consumed by the M8 bouncing-ball TV overlay).

The PURE half (argv, raw-WhisperX→normalized-lyrics transform, validation, lyrics path) has no
subprocess / torch and is fully shape-tested. The I/O half (WhisperXProcessor) reuses demucs.py's
injectable Runner / ProcessError, so the download→align→write flow tests with a fake runner — the
real WhisperX (multi-GB torch) only runs on a worker box / GPU. Mirrors demucs.py / ytdlp.ts.
"""
from __future__ import annotations

import json
import os
from typing import Any, AsyncIterator

from .demucs import Runner, download_argv, is_local_source, parse_ytdlp_progress, subprocess_runner
from .processor import CompleteResult, JobSpec, ProgressEvent

DEFAULT_MODEL = "base"  # WhisperX ASR model; bump to small/medium on a GPU box


# ── pure helpers (no IO) ─────────────────────────────────────────────────────────
def align_argv(audio_path: str, out_dir: str, model: str = DEFAULT_MODEL, lang: str | None = None,
               whisperx_bin: str = "whisperx", device: str = "cpu", compute_type: str = "int8") -> list[str]:
    """whisperx argv: transcribe + word-align to JSON. `--output_format json` emits one .json next
    to the audio under out_dir; --language pins it (skips autodetect) when the caller knows it.

    CRITICAL: whisperx/faster-whisper DEFAULT to compute_type=float16, which CPU backends CANNOT run
    (ValueError: Requested float16 compute type ... not supported). A CPU worker MUST pass int8 (the
    standard CPU choice); a GPU worker overrides device=cuda + compute_type=float16."""
    argv = [
        whisperx_bin,
        audio_path,
        "--model", model,
        "--output_format", "json",
        "--output_dir", out_dir,
        "--device", device,
        "--compute_type", compute_type,
        "--print_progress", "True",
    ]
    if lang:
        argv += ["--language", lang]
    return argv


def whisperx_json_path(out_dir: str, audio_path: str) -> str:
    """WhisperX writes <out_dir>/<audio-basename-without-ext>.json."""
    base = os.path.splitext(os.path.basename(audio_path))[0]
    return os.path.join(out_dir, f"{base}.json")


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


def normalize_lyrics(raw: dict[str, Any]) -> dict[str, Any]:
    """Transform raw WhisperX output into the normalized lyrics artifact the TV overlay consumes.

    Raw WhisperX shape: { language, segments: [{ start, end, text, words: [{word,start,end,score}] }] }.
    Normalized shape:   { language, lines: [{ start, end, text, words: [{word,start,end}] }],
                          words: [flattened {word,start,end}] }.
    Defensive: drops words missing usable start/end (WhisperX leaves timings null for some tokens),
    derives a line's [start,end] from its words when the segment-level ones are absent, and skips
    empty lines — the model's output is UNTRUSTED, so we never assume a field is present/valid.
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
            continue  # nothing to show
        l_start = _round_ms(seg.get("start"))
        l_end = _round_ms(seg.get("end"))
        if l_start is None and words:
            l_start = words[0]["start"]
        if l_end is None and words:
            l_end = words[-1]["end"]
        # A line needs SOME timing to be useful to the overlay: timed words (bouncing ball) or
        # line-level bounds (whole-line highlight). No words + no bounds = untimed garbage → drop.
        if not words and (l_start is None or l_end is None):
            continue
        lines.append({"start": l_start, "end": l_end, "text": line_text, "words": words})

    return {"language": language, "lines": lines, "words": flat_words}


def is_valid_lyrics(doc: dict[str, Any]) -> bool:
    """A usable lyrics artifact has at least one line with at least one timed word."""
    lines = doc.get("lines")
    if not isinstance(lines, list) or not lines:
        return False
    return any(isinstance(l, dict) and l.get("words") for l in lines)


# ── the processor ──────────────────────────────────────────────────────────────────
class WhisperXProcessor:
    """Production processor for `align` jobs (M7-C8). Fetch the source (yt-dlp, unless local), run
    WhisperX transcribe+align, normalize the raw JSON into the lyrics artifact, and write it to the
    MediaStore. Same async-generator interface as the other processors — dial_home.py is unchanged."""

    def __init__(self, *, model: str = DEFAULT_MODEL, runner: Runner = subprocess_runner,
                 ytdlp_bin: str = "yt-dlp", whisperx_bin: str = "whisperx",
                 device: str = "cpu", compute_type: str = "int8") -> None:
        self._model = model
        self._runner = runner
        self._ytdlp_bin = ytdlp_bin
        self._whisperx_bin = whisperx_bin
        # CPU default (int8); a GPU worker passes device='cuda', compute_type='float16'.
        self._device = device
        self._compute_type = compute_type

    async def process(self, job: JobSpec) -> AsyncIterator[ProgressEvent | CompleteResult]:
        work = os.path.join(job.media_dir, "lyrics", "_work", job.media_id)
        os.makedirs(work, exist_ok=True)

        # ── stage 1: obtain the source audio ──────────────────────────────────────
        if is_local_source(job.source_uri):
            audio = job.source_uri if os.path.isabs(job.source_uri) else os.path.join(job.media_dir, job.source_uri)
        else:
            audio = os.path.join(work, "source.wav")
            async for ev in self._run_stage("downloading", download_argv(job.source_uri, audio, self._ytdlp_bin), parse_ytdlp_progress):
                yield ev

        # ── stage 2: transcribe + word-align (WhisperX) ───────────────────────────
        lang = job.params.get("language") if isinstance(job.params, dict) else None
        argv = align_argv(audio, work, self._model, lang, self._whisperx_bin, self._device, self._compute_type)
        async for ev in self._run_stage("aligning", argv, _parse_whisperx_progress):
            yield ev

        # ── stage 3: normalize + publish the lyrics JSON ──────────────────────────
        produced = whisperx_json_path(work, audio)
        if not os.path.exists(produced):
            raise RuntimeError(f"whisperx produced no transcript at {produced}")
        with open(produced, encoding="utf-8") as f:
            raw = json.load(f)
        doc = normalize_lyrics(raw)
        if not is_valid_lyrics(doc):
            raise RuntimeError("whisperx produced no word-timed lyrics (empty/instrumental track?)")

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


def _parse_whisperx_progress(line: str) -> int | None:
    """WhisperX with --print_progress emits 'Progress: 42.0%...' lines; reuse the tqdm-ish parse."""
    import re

    m = re.search(r"([\d.]+)%", line)
    return int(float(m.group(1))) if m else None
