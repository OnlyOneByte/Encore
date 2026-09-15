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

from ..vocabulary import Timing
from .model import LyricsDoc
from .source import entries_to_segments, fold_romanization_entries, parse_lrc, plain_lyrics_to_segments


def candidate_key(
    media_id: str, text_source: str, timing: str = Timing.WORD.value, tag: str | None = None
) -> str:
    """Artifact key per (text source, TAG, TIMING TIER), so texts coexist instead of overwriting.

    The single `derived/lyrics/<id>.json` key could hold exactly one answer, which is what forced the
    old "pick one winner" design. One file per source is what makes the upgrade path possible: a
    baseline lands first, LRCLIB is re-tried later, neither clobbers the other.

    The TIMING tier is in the key too, because source alone still allowed a regression WITHIN a source:
    a re-run whose aligner failed would write line-level output over the same key and replace perfectly
    good word timings — the never-regress guarantee held across sources but not within one. Separate
    keys mean the word-level artifact survives on disk and in the candidate set, and `pickBestLyrics`
    keeps choosing it.

    The TAG exists because a source is no longer one text. Two baselines are both `asr` (one reads the
    vocals stem, one the mix) and two caption tiers are both `captions` (one authored, one automatic), so
    without it the second write of a pair would silently destroy the first — and destroy exactly the
    independence that makes averaging baselines worth doing.

    Moved here from lyrics/chain.py: the artifact key belongs beside the artifact shape this
    module owns, not in the acquisition/grading module. It was the second artifact-key builder — the
    first, a dead single-file `lyrics_key`, was removed in the same change.
    """
    parts = [media_id, text_source] + ([tag] if tag else []) + [timing]
    return f"derived/lyrics/{'-'.join(parts)}.json"


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
        line: dict[str, Any] = {"start": l_start, "end": l_end, "text": line_text, "words": words}
        # A romanization is a per-line SECOND SCRIPT the source shipped. This pass-through
        # copies it onto a line ONLY when the input segment already carries it, and it is defensive
        # depth today, NOT a live carrier: the one site that writes ``romanization`` INTO A SEGMENT is
        # ``entries_to_segments`` (``source.py``: ``seg["romanization"] = e.romanization``), fed the
        # folded ``LrcEntry`` rows by ``fold_romanization_entries`` on the LRCLIB synced (``TIMING_LINE``)
        # path — ``fold_romanization_entries`` itself only sets ``romanization`` on an ``LrcEntry``, never
        # on a segment dict. No producer hands those segments to ``normalize_lyrics``. The two paths that
        # DO surface the second script
        # each carry it OUTSIDE this function:
        #   - the aligned path (the default ``forced`` sync mode) — the aligner rebuilds every segment
        #     and drops the field, so ``_time_one`` re-attaches it by source-line position via
        #     ``_attach_romanizations`` in ``steps/lyrics.py`` AFTER ``normalize_lyrics`` has run;
        #   - the line-sync path (``lines`` mode / aligner-failure fallback) — ``line_synced_lyrics`` in
        #     ``source.py`` has its own copy and never calls this normalizer.
        # The ASR (``TIMING_WORD``) path cannot carry it: whisper emits no romanization and the ASR
        # source rebuilds segments with only ``start``/``end``/``text``/``words`` (pinned by
        # ``test_asr_source_segment_keys_are_exactly_start_end_text_words`` — a fifth ``romanization`` key
        # would make this branch live) and this pass-through's copy is itself pinned by
        # ``test_normalize_lyrics_copies_a_segment_romanization_through``. Never fabricated:
        # absent key → single-script line, unchanged behaviour.
        romanization = seg.get("romanization")
        if isinstance(romanization, str) and romanization.strip():
            line["romanization"] = romanization.strip()
        lines.append(line)

    return {"language": language, "lines": lines, "words": flat_words}


def is_valid_lyrics(doc: dict[str, Any]) -> bool:
    """A WORD-timed artifact: at least one line carrying at least one word — the forced-alignment
    success bar. Kept as a named function because that name is what the step and the tests read; the
    shape question behind it belongs to `model.LyricsDoc`."""
    return LyricsDoc(doc).has_timed_words()


def lrclib_to_segments(res: Any, total_duration: float | None) -> list[dict[str, Any]]:
    """Turn an LrclibResult into the [{start,end,text}] transcript the aligner consumes: prefer the
    line-timed syncedLyrics (LRC), else evenly distribute plainLyrics across the track. Empty if the
    track is instrumental / has no usable lyrics."""
    if res is None or getattr(res, "instrumental", False):
        return []
    if getattr(res, "has_synced", False):
        # Fold any interleaved second script (pinyin under the characters) into each line before
        # segmenting, so a Chinese record carries BOTH scripts through to the doc.
        return entries_to_segments(fold_romanization_entries(parse_lrc(res.synced_lyrics)), total_duration)
    if getattr(res, "has_plain", False):
        return plain_lyrics_to_segments(res.plain_lyrics, total_duration)
    return []
