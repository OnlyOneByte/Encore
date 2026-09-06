"""The lyrics artifact: the JSON shape the TV reads, and the key it is stored under.

One doc per (media, text source, timing tier):

    {"language": str|None,
     "lines":    [{"start": float, "end": float, "text": str, "words": [...]}],
     "words":    [{"word": str, "start": float, "end": float}]}

`lines` is what the reel renders; `words` is the flat sequence the bouncing ball walks. Both are
present so a consumer never has to flatten or group, and both are millisecond-rounded so two runs of
the same aligner produce byte-identical files.

Extracted from whisperx.py, where it sat beside the align ORCHESTRATION and the wav2vec2 model
wrapper. Shaping an artifact is neither of those: the core, the TV and every text source depend on
this format, while only one of them depends on how the timings were obtained.

PURE: dict in, dict out. No numpy, no torch, no I/O.
"""

from __future__ import annotations

from typing import Any

from .source import entries_to_segments, parse_lrc, plain_lyrics_to_segments


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
    return any(isinstance(ln, dict) and ln.get("words") for ln in lines)


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
